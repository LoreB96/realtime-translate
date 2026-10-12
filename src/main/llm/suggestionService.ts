/**
 * Reply suggestions (spec §6.4): debounced auto-trigger on final `them` entries, manual
 * `requestNow()`, one request in flight, stale results ignored by sequence number.
 * No Electron imports; never logs transcript or suggestion text.
 */
import { countWords, type SuggestionsState, type TranscriptEntry } from '../../shared/assistant';
import type { LanguageCode } from '../../shared/languages';
import type { Logger } from '../util/logger';
import type { LlmClient } from './llmClient';
import { LlmError, isAbortError } from './llmErrors';
import { SUGGESTION_SCHEMA, SUGGEST_MAX_TOKENS, buildSuggestionPrompt } from './prompts';
import { parseSuggestions } from './suggestionParser';

export const SUGGEST_DEBOUNCE_MS = 1200;
export const SUGGEST_QUESTION_DEBOUNCE_MS = 300;

export interface SuggestionServiceDeps {
  llm: Pick<LlmClient, 'complete'>;
  recent: () => TranscriptEntry[];
  langs: () => { user: LanguageCode; them: LanguageCode };
  enabled: () => { suggestions: boolean; auto: boolean };
  onState: (s: SuggestionsState) => void;
  now: () => number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  debounceMs?: number; // 1200
  questionDebounceMs?: number; // 300
  logger?: Logger;
}

const QUESTION_END_RE = /[?？]\s*$/u;

export class SuggestionService {
  private current: SuggestionsState;
  private seq = 0;
  private controller: AbortController | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly deps: SuggestionServiceDeps) {
    this.current = { status: 'idle', items: [], updatedAt: deps.now() };
  }

  state(): SuggestionsState {
    return this.current;
  }

  onFinalEntry(e: TranscriptEntry): void {
    const en = this.deps.enabled();
    if (!en.suggestions) return;
    if (e.speaker === 'them') {
      if (!en.auto) return;
      const text = e.translated || e.original;
      if (countWords(text) < 2) return;
      const delay = QUESTION_END_RE.test(text)
        ? (this.deps.questionDebounceMs ?? SUGGEST_QUESTION_DEBOUNCE_MS)
        : (this.deps.debounceMs ?? SUGGEST_DEBOUNCE_MS);
      this.clearTimer();
      const setTimer = this.deps.setTimer ?? setTimeout;
      this.timer = setTimer(() => {
        this.timer = undefined;
        const now = this.deps.enabled();
        if (!now.suggestions || !now.auto) return;
        void this.run(e.id);
      }, delay);
      return;
    }
    // 'me': the user answered by voice → drop the ready suggestions.
    if (e.source === 'typed') return;
    if (countWords(e.original || e.translated) < 2) return;
    if (this.current.status !== 'ready') return;
    this.setState({ status: 'idle', items: [], updatedAt: this.deps.now() });
  }

  async requestNow(): Promise<void> {
    this.clearTimer();
    if (!this.deps.enabled().suggestions) return;
    await this.run(undefined);
  }

  cancel(): void {
    this.seq += 1;
    this.controller?.abort();
    this.controller = undefined;
    this.clearTimer();
    this.setState({ status: 'idle', items: [], updatedAt: this.deps.now() });
  }

  // -------------------------------------------------------------------------

  private clearTimer(): void {
    if (this.timer === undefined) return;
    (this.deps.clearTimer ?? clearTimeout)(this.timer);
    this.timer = undefined;
  }

  private setState(s: SuggestionsState): void {
    this.current = s;
    this.deps.onState(s);
  }

  private async run(forEntryId: string | undefined): Promise<void> {
    this.seq += 1;
    const seq = this.seq;
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    const started = this.deps.now();
    const idPart = forEntryId !== undefined ? { forEntryId } : {};
    this.setState({ status: 'loading', items: [], updatedAt: started, ...idPart });
    try {
      const raw = await this.deps.llm.complete({
        messages: buildSuggestionPrompt(this.deps.recent(), this.deps.langs()),
        maxTokens: SUGGEST_MAX_TOKENS,
        jsonSchema: SUGGESTION_SCHEMA,
        signal: controller.signal,
      });
      if (seq !== this.seq) return;
      const items = parseSuggestions(raw);
      this.controller = undefined;
      this.deps.logger?.info('suggest_done', { n: items.length, ms: this.deps.now() - started });
      this.setState({ status: 'ready', items, updatedAt: this.deps.now(), ...idPart });
    } catch (err) {
      if (seq !== this.seq || isAbortError(err)) return;
      this.controller = undefined;
      const code = err instanceof LlmError ? err.code : 'unknown';
      this.deps.logger?.warn('suggest_failed', { code });
      this.setState({
        status: 'error',
        items: [],
        errorCode: code,
        updatedAt: this.deps.now(),
        ...idPart,
      });
    }
  }
}
