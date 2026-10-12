/**
 * Typed speech (spec §6.6): creates a typed `me` transcript entry, then translates (LLM)
 * and speaks (TTS) it. Every request is appended to one promise chain, so translate → TTS
 * runs strictly in submission order even when translations finish out of order.
 *
 * No Electron imports. Never logs the typed or translated text.
 */
import type {
  AssistantErrorCode,
  SpeakArgs,
  SpeakStatus,
  TranscriptEntry,
} from '@shared/assistant';
import { isAssistantErrorCode, isSpeakArgs } from '@shared/assistant';
import type { LanguageCode } from '@shared/languages';
import type { Logger } from '../util/logger';
import type { TtsSpeakOptions } from './ttsService';
import { isAbortError } from './ttsService';

export interface TranscriptSink {
  upsert(e: TranscriptEntry): void;
  patch(id: string, p: Partial<Omit<TranscriptEntry, 'id'>>): TranscriptEntry | undefined;
}

export interface SpeakControllerDeps {
  store: TranscriptSink;
  translate: (
    text: string,
    from: LanguageCode,
    to: LanguageCode,
    signal: AbortSignal,
  ) => Promise<string>;
  tts: {
    speak(text: string, lang: LanguageCode, o?: TtsSpeakOptions): Promise<void>;
    stopAll(): void;
  };
  langs: () => { user: LanguageCode; them: LanguageCode };
  onError: (code: AssistantErrorCode) => void;
  now: () => number;
  newId: () => string;
  logger?: Logger;
}

interface SpeakItem {
  id: string;
  gen: number;
  text: string;
  translate: boolean;
  translation: string | undefined;
  user: LanguageCode;
  them: LanguageCode;
  ac: AbortController | undefined;
}

/** Thrown inside run() for an empty translation (never spoken). */
class SpeakFailure extends Error {
  constructor(readonly code: AssistantErrorCode) {
    super(code);
    this.name = 'SpeakFailure';
  }
}

export function errorCodeOf(e: unknown): AssistantErrorCode {
  if (typeof e === 'object' && e !== null && 'code' in e) {
    const code = (e as { code: unknown }).code;
    if (isAssistantErrorCode(code)) return code;
  }
  return 'unknown';
}

export class SpeakController {
  private chain: Promise<void> = Promise.resolve();
  /** Bumped by stop(): items of an older generation return as soon as their turn comes. */
  private gen = 0;
  /** Items not yet finished (queued or running), in submission order. */
  private readonly pending = new Set<SpeakItem>();
  private current: SpeakItem | undefined;

  constructor(private readonly deps: SpeakControllerDeps) {}

  speak(a: SpeakArgs): { entryId: string } {
    if (!isSpeakArgs(a)) throw new Error('invalid-args');
    const { user, them } = this.deps.langs();
    const now = this.deps.now();
    const id = `typed-${this.deps.newId()}`;
    const text = a.text.trim();
    const entry: TranscriptEntry = {
      id,
      direction: 'A',
      speaker: 'me',
      source: 'typed',
      original: text,
      translated: a.translation ?? '',
      originalLang: user,
      translatedLang: them,
      startedAt: now,
      updatedAt: now,
      final: true,
      speak: 'queued',
    };
    this.deps.store.upsert(entry);
    const item: SpeakItem = {
      id,
      gen: this.gen,
      text,
      translate: a.translate,
      translation: a.translation,
      user,
      them,
      ac: undefined,
    };
    this.pending.add(item);
    this.chain = this.chain.then(() => this.run(item));
    return { entryId: id };
  }

  stop(): void {
    this.gen++;
    this.current?.ac?.abort();
    this.current = undefined;
    this.deps.tts.stopAll();
    const items = [...this.pending];
    this.pending.clear();
    for (const item of items) this.setStatus(item, 'cancelled');
    // Empty the chain: new requests must not wait for an aborted item to unwind.
    this.chain = Promise.resolve();
    if (items.length > 0) this.deps.logger?.info('speak_stopped', { cancelled: items.length });
  }

  // -------------------------------------------------------------------------

  /** Never rejects. */
  private async run(item: SpeakItem): Promise<void> {
    if (item.gen !== this.gen) return;
    const ac = new AbortController();
    item.ac = ac;
    this.current = item;
    const stale = (): boolean => item.gen !== this.gen || ac.signal.aborted;
    try {
      let spoken: string;
      let lang: LanguageCode;
      const given = item.translation?.trim() ?? '';
      if (given) {
        // Spoken suggestion / retry: the translation is already known, no LLM call.
        spoken = given;
        lang = item.them;
      } else if (!item.translate || item.user === item.them) {
        spoken = item.text;
        lang = item.user;
      } else {
        this.setStatus(item, 'translating');
        const raw = await this.deps.translate(item.text, item.user, item.them, ac.signal);
        if (stale()) return;
        const translated = raw.trim();
        // Empty translations are errors and never spoken (truncation arrives as a coded error).
        if (!translated) throw new SpeakFailure('llm-bad-response');
        this.deps.store.patch(item.id, { translated, updatedAt: this.deps.now() });
        spoken = translated;
        lang = item.them;
      }

      this.setStatus(item, 'synthesizing');
      await this.deps.tts.speak(spoken, lang, {
        signal: ac.signal,
        onFirstAudio: () => {
          if (!stale()) this.setStatus(item, 'speaking');
        },
      });
      if (stale()) return;
      this.setStatus(item, 'done');
    } catch (e) {
      // stop() already marked the entry cancelled.
      if (item.gen !== this.gen) return;
      if (ac.signal.aborted || isAbortError(e)) {
        // Aborted from elsewhere (e.g. tts.stopAll() on a device change): not an error.
        this.setStatus(item, 'cancelled');
        return;
      }
      const code = errorCodeOf(e);
      this.setStatus(item, 'error');
      this.deps.logger?.warn('speak_failed', { code });
      this.deps.onError(code);
    } finally {
      this.pending.delete(item);
      if (this.current === item) this.current = undefined;
    }
  }

  private setStatus(item: SpeakItem, speak: SpeakStatus): void {
    this.deps.store.patch(item.id, { speak, updatedAt: this.deps.now() });
  }
}
