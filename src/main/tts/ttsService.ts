/**
 * Text-to-speech into the call (spec §6.5). OpenAI `/v1/audio/speech` with
 * `response_format: 'pcm'`, streamed through PcmStreamChunker into the `tts` playback
 * stream (and `tts-mon` on the headset when monitoring). Strict FIFO, one item at a time.
 *
 * No Electron imports: fetch, the playback sink, clock, timers and logger are injected.
 * Never logs the spoken text.
 */
import type { AssistantErrorCode } from '@shared/assistant';
import { MAX_TTS_INPUT_CHARS } from '@shared/assistant';
import type { LanguageCode } from '@shared/languages';
import { languageByCode } from '@shared/languages';
import type { FetchLike, FetchResponseLike } from '../util/fetchLike';
import type { Logger } from '../util/logger';
import { PcmStreamChunker, TTS_SAMPLE_RATE } from './pcmStreamChunker';

export type TtsStreamId = 'tts' | 'tts-mon';

export interface TtsPlaybackSink {
  /** Idempotent, memoised per streamId+deviceId; re-opens when the device changed. */
  open(streamId: TtsStreamId, deviceId: string): Promise<void>;
  push(streamId: TtsStreamId, b64: string): void;
  close(streamId: TtsStreamId): void;
}

export interface TtsServiceDeps {
  fetch: FetchLike;
  apiKey: () => string | undefined;
  devices: () => { toMeet?: string; headset?: string };
  prefs: () => { voice: string; model: string; monitor: boolean };
  /** Setup wizard/review owns the devices. */
  busy: () => boolean;
  sink: TtsPlaybackSink;
  now: () => number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  logger?: Logger;
}

export interface TtsSpeakOptions {
  signal?: AbortSignal;
  onFirstAudio?: () => void;
}

export class TtsError extends Error {
  constructor(readonly code: AssistantErrorCode) {
    super(code);
    this.name = 'TtsError';
  }
}

export const IDLE_CLOSE_MS = 30000;
export const TTS_URL = 'https://api.openai.com/v1/audio/speech';
/** Margin after the computed playout end before an item counts as done. */
export const PLAYOUT_MARGIN_MS = 300;

const STREAMS: readonly TtsStreamId[] = ['tts', 'tts-mon'];

export function abortError(): Error {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}

export function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === 'AbortError';
}

/** `instructions` is only understood by the gpt-4o-mini-tts family. */
export function buildTtsBody(
  model: string,
  voice: string,
  text: string,
  lang: LanguageCode,
): Record<string, string> {
  const body: Record<string, string> = { model, voice, input: text, response_format: 'pcm' };
  if (model.startsWith('gpt-4o-mini-tts')) {
    const name = languageByCode(lang)?.label ?? lang;
    body.instructions = ttsInstructions(name);
  }
  return body;
}

/**
 * Steers gpt-4o-mini-tts towards native pronunciation: without it the voices read other
 * languages with a noticeable English accent.
 */
export function ttsInstructions(languageName: string): string {
  return (
    `Speak as a native ${languageName} speaker: natural ${languageName} pronunciation, ` +
    `intonation and rhythm, with no foreign accent. ` +
    `Friendly, confident and clear, at a natural conversational pace, like in a live call.`
  );
}

interface QueueItem {
  text: string;
  lang: LanguageCode;
  opts: TtsSpeakOptions;
  resolve: () => void;
  reject: (e: unknown) => void;
}

type TimerHandle = ReturnType<typeof setTimeout>;

export class TtsService {
  private readonly queue: QueueItem[] = [];
  private running = false;
  /** Bumped by stopAll(): late chunks of an aborted item are never pushed. */
  private gen = 0;
  private current: AbortController | undefined;
  private readonly opened = new Set<TtsStreamId>();
  private idleTimer: TimerHandle | undefined;

  constructor(private readonly deps: TtsServiceDeps) {}

  /** FIFO; resolves when the audio has been pushed and its playout time elapsed. */
  speak(text: string, lang: LanguageCode, opts: TtsSpeakOptions = {}): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ text, lang, opts, resolve, reject });
      void this.pump();
    });
  }

  /** Abort current fetch, reject queued items with AbortError, close both streams. */
  stopAll(): void {
    this.gen++;
    this.current?.abort();
    const pending = this.queue.splice(0);
    for (const item of pending) item.reject(abortError());
    this.clearIdle();
    this.opened.clear();
    for (const id of STREAMS) this.safeClose(id);
  }

  // -------------------------------------------------------------------------

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (let item = this.queue.shift(); item; item = this.queue.shift()) {
        await this.runItem(item);
      }
    } finally {
      this.running = false;
    }
  }

  /** Never throws: settles the item's promise. */
  private async runItem(item: QueueItem): Promise<void> {
    const gen = this.gen;
    const ac = new AbortController();
    const onExternalAbort = (): void => ac.abort();
    if (item.opts.signal?.aborted) {
      item.reject(abortError());
      return;
    }
    item.opts.signal?.addEventListener('abort', onExternalAbort, { once: true });
    this.current = ac;
    this.clearIdle();
    try {
      await this.synthesize(item, ac.signal, gen);
      item.resolve();
    } catch (e) {
      if (ac.signal.aborted || gen !== this.gen || isAbortError(e)) {
        item.reject(abortError());
      } else if (e instanceof TtsError) {
        item.reject(e);
      } else {
        this.logFailed('tts-failed');
        item.reject(new TtsError('tts-failed'));
      }
    } finally {
      item.opts.signal?.removeEventListener('abort', onExternalAbort);
      if (this.current === ac) this.current = undefined;
      if (this.queue.length === 0) this.startIdle();
    }
  }

  private async synthesize(item: QueueItem, signal: AbortSignal, gen: number): Promise<void> {
    const { deps } = this;
    const aborted = (): boolean => signal.aborted || gen !== this.gen;

    // Checks before any request, in this order (spec §6.5).
    if (deps.busy()) throw this.fail('tts-busy-setup');
    const key = deps.apiKey();
    if (!key) throw this.fail('no-openai-key');
    const devices = deps.devices();
    const toMeet = devices.toMeet;
    if (!toMeet) throw this.fail('tts-no-device');
    if (item.text.length > MAX_TTS_INPUT_CHARS) {
      deps.logger?.warn('tts_input_too_long', { chars: item.text.length });
      throw this.fail('tts-failed');
    }

    const prefs = deps.prefs();
    const monitor = prefs.monitor && !!devices.headset;
    try {
      await deps.sink.open('tts', toMeet);
      if (aborted()) throw abortError();
      this.opened.add('tts');
      if (monitor && devices.headset) {
        await deps.sink.open('tts-mon', devices.headset);
        if (aborted()) throw abortError();
        this.opened.add('tts-mon');
      } else if (this.opened.has('tts-mon')) {
        this.opened.delete('tts-mon');
        this.safeClose('tts-mon');
      }
    } catch (e) {
      if (aborted() || isAbortError(e)) throw abortError();
      throw this.fail('tts-failed', undefined, 'open');
    }

    const startedAt = deps.now();
    let res: FetchResponseLike;
    try {
      res = await deps.fetch(TTS_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(buildTtsBody(prefs.model, prefs.voice, item.text, item.lang)),
        signal,
      });
    } catch (e) {
      if (aborted() || isAbortError(e)) throw abortError();
      throw this.fail('tts-failed', undefined, 'network');
    }
    if (aborted()) throw abortError();
    if (!res.ok) throw this.fail(res.status === 429 ? 'rate-limited' : 'tts-failed', res.status);
    if (!res.body) throw this.fail('tts-failed', res.status, 'no-body');

    const chunker = new PcmStreamChunker();
    let firstPushAt: number | undefined;
    const push = (b64: string): void => {
      if (aborted()) return;
      deps.sink.push('tts', b64);
      if (monitor) deps.sink.push('tts-mon', b64);
      if (firstPushAt === undefined) {
        firstPushAt = deps.now();
        try {
          item.opts.onFirstAudio?.();
        } catch {
          // A listener error must not break playback.
        }
      }
    };

    const reader = res.body.getReader();
    // Unblocks a pending read() on stopAll() even if the body ignores the fetch signal.
    const cancelReader = (): void => {
      reader.cancel().catch(() => undefined);
    };
    signal.addEventListener('abort', cancelReader, { once: true });
    try {
      for (;;) {
        if (aborted()) throw abortError();
        const { done, value } = await reader.read();
        if (done) break;
        if (aborted()) throw abortError();
        if (value) for (const chunk of chunker.push(value)) push(chunk);
      }
    } catch (e) {
      reader.cancel().catch(() => undefined);
      if (aborted() || isAbortError(e)) throw abortError();
      throw this.fail('tts-failed', res.status, 'stream');
    } finally {
      signal.removeEventListener('abort', cancelReader);
    }
    const tail = chunker.flush();
    if (tail) push(tail);
    if (aborted()) throw abortError();
    if (firstPushAt === undefined) throw this.fail('tts-failed', res.status, 'empty');

    // Done = playout end, measured from the first push (not the last chunk, which would
    // add the download time).
    const samples = chunker.totalSamples;
    const endAt = firstPushAt + (samples * 1000) / TTS_SAMPLE_RATE + PLAYOUT_MARGIN_MS;
    await this.sleep(Math.max(0, endAt - deps.now()), signal);
    if (aborted()) throw abortError();
    deps.logger?.info('tts_done', {
      chars: item.text.length,
      ms: deps.now() - startedAt,
      samples,
    });
  }

  private fail(code: AssistantErrorCode, status?: number, reason?: string): TtsError {
    this.logFailed(code, status, reason);
    return new TtsError(code);
  }

  private logFailed(code: AssistantErrorCode, status?: number, reason?: string): void {
    this.deps.logger?.warn('tts_failed', {
      code,
      ...(status !== undefined ? { status } : {}),
      ...(reason ? { reason } : {}),
    });
  }

  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(abortError());
        return;
      }
      const onAbort = (): void => {
        this.clear(timer);
        reject(abortError());
      };
      const timer = this.schedule(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private startIdle(): void {
    this.clearIdle();
    if (this.opened.size === 0) return;
    this.idleTimer = this.schedule(() => {
      this.idleTimer = undefined;
      if (this.running) return;
      const ids = [...this.opened];
      this.opened.clear();
      for (const id of ids) this.safeClose(id);
      this.deps.logger?.info('tts_idle_close', { streams: ids.length });
    }, IDLE_CLOSE_MS);
  }

  private clearIdle(): void {
    if (this.idleTimer !== undefined) {
      this.clear(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  private safeClose(id: TtsStreamId): void {
    try {
      this.deps.sink.close(id);
    } catch {
      // Best effort: the offscreen page may already have dropped the stream.
    }
  }

  private schedule(fn: () => void, ms: number): TimerHandle {
    return (this.deps.setTimer ?? setTimeout)(fn, ms);
  }

  private clear(t: TimerHandle): void {
    (this.deps.clearTimer ?? clearTimeout)(t);
  }
}
