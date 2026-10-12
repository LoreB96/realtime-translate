import { describe, it, expect, vi } from 'vitest';
import { SpeakController, errorCodeOf, type TranscriptSink } from '@main/tts/speakController';
import { TtsError, type TtsSpeakOptions } from '@main/tts/ttsService';
import type { AssistantErrorCode, SpeakStatus, TranscriptEntry } from '@shared/assistant';
import type { LanguageCode } from '@shared/languages';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class FakeStore implements TranscriptSink {
  entries = new Map<string, TranscriptEntry>();
  statuses = new Map<string, SpeakStatus[]>();
  upsert(e: TranscriptEntry): void {
    this.entries.set(e.id, e);
    if (e.speak) this.statuses.set(e.id, [e.speak]);
  }
  patch(id: string, p: Partial<Omit<TranscriptEntry, 'id'>>): TranscriptEntry | undefined {
    const prev = this.entries.get(id);
    if (!prev) return undefined;
    const next = { ...prev, ...p };
    this.entries.set(id, next);
    if (p.speak) this.statuses.get(id)?.push(p.speak);
    return next;
  }
  status(id: string): SpeakStatus | undefined {
    return this.entries.get(id)?.speak;
  }
}

interface TtsCall {
  text: string;
  lang: LanguageCode;
  opts: TtsSpeakOptions | undefined;
  d: Deferred<void>;
}

class FakeTts {
  calls: TtsCall[] = [];
  stopAll = vi.fn(() => {
    for (const c of this.calls) c.d.reject(abortErr());
  });
  speak(text: string, lang: LanguageCode, opts?: TtsSpeakOptions): Promise<void> {
    const d = deferred<void>();
    this.calls.push({ text, lang, opts, d });
    return d.promise;
  }
}

function abortErr(): Error {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}

class CodedError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

interface TranslateCall {
  text: string;
  from: LanguageCode;
  to: LanguageCode;
  signal: AbortSignal;
  d: Deferred<string>;
}

function setup(langs: { user: LanguageCode; them: LanguageCode } = { user: 'it', them: 'en' }) {
  const store = new FakeStore();
  const tts = new FakeTts();
  const translations: TranslateCall[] = [];
  const errors: AssistantErrorCode[] = [];
  const state = { langs };
  let n = 0;
  const ctl = new SpeakController({
    store,
    translate: (text, from, to, signal) => {
      const d = deferred<string>();
      translations.push({ text, from, to, signal, d });
      return d.promise;
    },
    tts: { speak: (t, l, o) => tts.speak(t, l, o), stopAll: () => tts.stopAll() },
    langs: () => state.langs,
    onError: (c) => errors.push(c),
    now: () => 1000,
    newId: () => `id${++n}`,
  });
  return { ctl, store, tts, translations, errors, state };
}

/** Let the promise chain run. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

// ---------------------------------------------------------------------------

describe('SpeakController', () => {
  it('creates a typed me entry immediately with languages captured at speak() time', () => {
    const { ctl, store, state } = setup();
    const { entryId } = ctl.speak({ text: '  ciao  ', translate: true });
    state.langs = { user: 'pt', them: 'es' };
    expect(entryId).toBe('typed-id1');
    expect(store.entries.get(entryId)).toEqual({
      id: 'typed-id1',
      direction: 'A',
      speaker: 'me',
      source: 'typed',
      original: 'ciao',
      translated: '',
      originalLang: 'it',
      translatedLang: 'en',
      startedAt: 1000,
      updatedAt: 1000,
      final: true,
      speak: 'queued',
    });
  });

  it('rejects invalid args', () => {
    const { ctl } = setup();
    expect(() => ctl.speak({ text: '   ', translate: true })).toThrow('invalid-args');
  });

  it('goes queued → translating → synthesizing → speaking → done', async () => {
    const { ctl, store, tts, translations, errors } = setup();
    const { entryId } = ctl.speak({ text: 'ciao', translate: true });
    await settle();
    expect(store.status(entryId)).toBe('translating');
    expect(translations).toHaveLength(1);
    expect(translations[0]).toMatchObject({ text: 'ciao', from: 'it', to: 'en' });
    translations[0]?.d.resolve(' hello ');
    await settle();
    expect(store.entries.get(entryId)?.translated).toBe('hello');
    expect(store.status(entryId)).toBe('synthesizing');
    expect(tts.calls.map((c) => [c.text, c.lang])).toEqual([['hello', 'en']]);
    tts.calls[0]?.opts?.onFirstAudio?.();
    expect(store.status(entryId)).toBe('speaking');
    tts.calls[0]?.d.resolve();
    await settle();
    expect(store.statuses.get(entryId)).toEqual([
      'queued',
      'translating',
      'synthesizing',
      'speaking',
      'done',
    ]);
    expect(errors).toEqual([]);
  });

  it('skips translation when a translation is given, when translate is off, or when languages match', async () => {
    const { ctl, store, tts, translations, state } = setup();
    const a = ctl.speak({ text: 'Sì, certo', translate: true, translation: 'Yes, sure' });
    await settle();
    expect(tts.calls.map((c) => [c.text, c.lang])).toEqual([['Yes, sure', 'en']]);
    tts.calls[0]?.d.resolve();
    await settle();
    expect(store.statuses.get(a.entryId)).toEqual(['queued', 'synthesizing', 'done']);
    expect(store.entries.get(a.entryId)?.translated).toBe('Yes, sure');

    const b = ctl.speak({ text: 'ciao', translate: false });
    await settle();
    expect(tts.calls[1]).toMatchObject({ text: 'ciao', lang: 'it' });
    tts.calls[1]?.d.resolve();
    await settle();
    expect(store.status(b.entryId)).toBe('done');

    state.langs = { user: 'en', them: 'en' };
    const c = ctl.speak({ text: 'hi', translate: true });
    await settle();
    expect(tts.calls[2]).toMatchObject({ text: 'hi', lang: 'en' });
    tts.calls[2]?.d.resolve();
    await settle();
    expect(store.status(c.entryId)).toBe('done');
    expect(translations).toHaveLength(0);
  });

  it('speaks two items in submission order even when the second translation is faster', async () => {
    vi.useFakeTimers();
    try {
      const spoken: string[] = [];
      const store = new FakeStore();
      let n = 0;
      const ctl = new SpeakController({
        store,
        translate: (text) =>
          new Promise((r) => setTimeout(() => r(`T:${text}`), text === 'first' ? 300 : 10)),
        tts: {
          speak: (t) => {
            spoken.push(t);
            return new Promise((r) => setTimeout(r, 50));
          },
          stopAll: () => undefined,
        },
        langs: () => ({ user: 'it', them: 'en' }),
        onError: () => undefined,
        now: () => Date.now(),
        newId: () => `x${++n}`,
      });
      const a = ctl.speak({ text: 'first', translate: true });
      const b = ctl.speak({ text: 'second', translate: true });
      await vi.advanceTimersByTimeAsync(1000);
      expect(spoken).toEqual(['T:first', 'T:second']);
      expect(store.status(a.entryId)).toBe('done');
      expect(store.status(b.entryId)).toBe('done');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a translate error marks the entry error and reports the code; nothing is spoken', async () => {
    const { ctl, store, tts, translations, errors } = setup();
    const a = ctl.speak({ text: 'uno', translate: true });
    const b = ctl.speak({ text: 'due', translate: true });
    await settle();
    translations[0]?.d.reject(new CodedError('llm-unreachable'));
    await settle();
    expect(store.status(a.entryId)).toBe('error');
    expect(errors).toEqual(['llm-unreachable']);
    // The chain continues with the next item.
    translations[1]?.d.reject(new CodedError('llm-truncated'));
    await settle();
    expect(store.status(b.entryId)).toBe('error');
    expect(errors).toEqual(['llm-unreachable', 'llm-truncated']);
    expect(tts.calls).toHaveLength(0);
  });

  it('an empty translation is llm-bad-response and never spoken', async () => {
    const { ctl, store, tts, translations, errors } = setup();
    const a = ctl.speak({ text: 'uno', translate: true });
    await settle();
    translations[0]?.d.resolve('   ');
    await settle();
    expect(store.status(a.entryId)).toBe('error');
    expect(errors).toEqual(['llm-bad-response']);
    expect(tts.calls).toHaveLength(0);
  });

  it('a TTS error carries its code; an uncoded error is unknown', async () => {
    const { ctl, store, tts, errors } = setup();
    const a = ctl.speak({ text: 'a', translate: false });
    const b = ctl.speak({ text: 'b', translate: false });
    await settle();
    tts.calls[0]?.d.reject(new TtsError('tts-no-device'));
    await settle();
    tts.calls[1]?.d.reject(new Error('weird'));
    await settle();
    expect(store.status(a.entryId)).toBe('error');
    expect(store.status(b.entryId)).toBe('error');
    expect(errors).toEqual(['tts-no-device', 'unknown']);
  });

  it('stop() cancels the running and queued items, aborts and stops TTS, without errors', async () => {
    const { ctl, store, tts, translations, errors } = setup();
    const a = ctl.speak({ text: 'a', translate: false });
    const b = ctl.speak({ text: 'b', translate: true });
    await settle();
    expect(store.status(a.entryId)).toBe('synthesizing');
    const signal = tts.calls[0]?.opts?.signal;
    ctl.stop();
    expect(signal?.aborted).toBe(true);
    expect(tts.stopAll).toHaveBeenCalledTimes(1);
    await settle();
    expect(store.status(a.entryId)).toBe('cancelled');
    expect(store.status(b.entryId)).toBe('cancelled');
    expect(translations).toHaveLength(0);
    expect(tts.calls).toHaveLength(1);
    expect(errors).toEqual([]);

    // New requests run normally after a stop.
    const c = ctl.speak({ text: 'c', translate: false });
    await settle();
    tts.calls[1]?.d.resolve();
    await settle();
    expect(store.status(c.entryId)).toBe('done');
  });

  it('stop() during translation cancels; a late translation is not spoken', async () => {
    const { ctl, store, tts, translations, errors } = setup();
    const a = ctl.speak({ text: 'a', translate: true });
    await settle();
    ctl.stop();
    expect(translations[0]?.signal.aborted).toBe(true);
    translations[0]?.d.resolve('late');
    await settle();
    expect(store.status(a.entryId)).toBe('cancelled');
    expect(store.entries.get(a.entryId)?.translated).toBe('');
    expect(tts.calls).toHaveLength(0);
    expect(errors).toEqual([]);
  });

  it('an AbortError from TTS without stop() (e.g. device change) is cancelled, not an error', async () => {
    const { ctl, store, tts, errors } = setup();
    const a = ctl.speak({ text: 'a', translate: false });
    await settle();
    tts.calls[0]?.d.reject(abortErr());
    await settle();
    expect(store.status(a.entryId)).toBe('cancelled');
    expect(errors).toEqual([]);
  });
});

describe('errorCodeOf', () => {
  it('maps known codes and falls back to unknown', () => {
    expect(errorCodeOf(new CodedError('rate-limited'))).toBe('rate-limited');
    expect(errorCodeOf(new CodedError('ECONNREFUSED'))).toBe('unknown');
    expect(errorCodeOf('x')).toBe('unknown');
    expect(errorCodeOf(null)).toBe('unknown');
  });
});
