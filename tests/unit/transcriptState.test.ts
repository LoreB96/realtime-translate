import { describe, it, expect } from 'vitest';
import {
  DEFAULT_ASSISTANT_PREFS,
  type AssistantContext,
  type TranscriptEntry,
} from '@shared/assistant';
import {
  MAX_VIEW_ENTRIES,
  displayLines,
  headerStatus,
  initialTranscriptState,
  showSttCta,
  transcriptReducer,
  type TranscriptViewState,
} from '@renderer/state/transcriptState';

function entry(id: string, over: Partial<TranscriptEntry> = {}): TranscriptEntry {
  return {
    id,
    direction: 'B',
    speaker: 'them',
    source: 'translate',
    original: `orig-${id}`,
    translated: `tr-${id}`,
    originalLang: 'pt',
    translatedLang: 'en',
    startedAt: 100,
    updatedAt: 100,
    final: false,
    ...over,
  };
}

const ctx = (over: Partial<AssistantContext> = {}): AssistantContext => ({
  langs: { user: 'en', them: 'pt' },
  translating: false,
  hasOpenAiKey: true,
  hasToMeetDevice: true,
  setupBusy: false,
  ...over,
});

const base = (): TranscriptViewState => initialTranscriptState(DEFAULT_ASSISTANT_PREFS);

describe('initialTranscriptState', () => {
  it('starts empty, idle, STT off with the prefs engine', () => {
    const s = base();
    expect(s.entries).toEqual([]);
    expect(s.suggestions.status).toBe('idle');
    expect(s.stt).toEqual({ engine: 'off', state: 'off', streams: [] });
    expect(s.prefs).toBe(DEFAULT_ASSISTANT_PREFS);
    expect(s.context.translating).toBe(false);
    expect(s.lastError).toBeUndefined();
  });
});

describe('transcriptReducer upsert', () => {
  it('appends new entries sorted by startedAt', () => {
    let s = base();
    s = transcriptReducer(s, { type: 'upsert', entry: entry('b', { startedAt: 200 }) });
    s = transcriptReducer(s, { type: 'upsert', entry: entry('a', { startedAt: 100 }) });
    s = transcriptReducer(s, { type: 'upsert', entry: entry('c', { startedAt: 300 }) });
    expect(s.entries.map((e) => e.id)).toEqual(['a', 'b', 'c']);
  });

  it('keeps arrival order for equal startedAt', () => {
    let s = base();
    s = transcriptReducer(s, { type: 'upsert', entry: entry('x', { startedAt: 5 }) });
    s = transcriptReducer(s, { type: 'upsert', entry: entry('y', { startedAt: 5 }) });
    expect(s.entries.map((e) => e.id)).toEqual(['x', 'y']);
  });

  it('replaces an existing entry when updatedAt is newer or equal', () => {
    let s = base();
    s = transcriptReducer(s, {
      type: 'upsert',
      entry: entry('a', { original: 'one', updatedAt: 10 }),
    });
    s = transcriptReducer(s, {
      type: 'upsert',
      entry: entry('a', { original: 'two', updatedAt: 20 }),
    });
    expect(s.entries).toHaveLength(1);
    expect(s.entries[0]?.original).toBe('two');
    s = transcriptReducer(s, {
      type: 'upsert',
      entry: entry('a', { original: 'three', updatedAt: 20 }),
    });
    expect(s.entries[0]?.original).toBe('three');
  });

  it('ignores a stale update (older updatedAt)', () => {
    let s = base();
    s = transcriptReducer(s, {
      type: 'upsert',
      entry: entry('a', { original: 'new', updatedAt: 50 }),
    });
    const before = s;
    s = transcriptReducer(s, {
      type: 'upsert',
      entry: entry('a', { original: 'old', updatedAt: 40 }),
    });
    expect(s.entries[0]?.original).toBe('new');
    expect(s.entries).toBe(before.entries);
  });

  it('caps the list at 500, dropping the oldest', () => {
    let s = base();
    for (let i = 0; i < MAX_VIEW_ENTRIES + 5; i++) {
      s = transcriptReducer(s, { type: 'upsert', entry: entry(`e${i}`, { startedAt: i }) });
    }
    expect(MAX_VIEW_ENTRIES).toBe(500);
    expect(s.entries).toHaveLength(500);
    expect(s.entries[0]?.id).toBe('e5');
    expect(s.entries[499]?.id).toBe(`e${MAX_VIEW_ENTRIES + 4}`);
  });
});

describe('transcriptReducer snapshot', () => {
  it('merges with pushed entries keeping the newer updatedAt', () => {
    let s = base();
    // A push arrived during the fetch: newer than the snapshot copy.
    s = transcriptReducer(s, {
      type: 'upsert',
      entry: entry('a', { original: 'pushed', startedAt: 20, updatedAt: 30 }),
    });
    s = transcriptReducer(s, {
      type: 'snapshot',
      entries: [
        entry('a', { original: 'fetched', startedAt: 20, updatedAt: 20 }),
        entry('b', { startedAt: 50, updatedAt: 50 }),
        entry('z', { startedAt: 10, original: 'old', updatedAt: 10 }),
      ],
    });
    expect(s.entries.map((e) => e.id)).toEqual(['z', 'a', 'b']);
    expect(s.entries.find((e) => e.id === 'a')?.original).toBe('pushed');
  });

  it('takes the snapshot copy when it is newer', () => {
    let s = base();
    s = transcriptReducer(s, {
      type: 'upsert',
      entry: entry('a', { original: 'push', updatedAt: 10 }),
    });
    s = transcriptReducer(s, {
      type: 'snapshot',
      entries: [entry('a', { original: 'snap', updatedAt: 11 })],
    });
    expect(s.entries[0]?.original).toBe('snap');
  });

  it('caps a large snapshot at 500', () => {
    const big = Array.from({ length: 600 }, (_, i) => entry(`s${i}`, { startedAt: i }));
    const s = transcriptReducer(base(), { type: 'snapshot', entries: big });
    expect(s.entries).toHaveLength(500);
    expect(s.entries[0]?.id).toBe('s100');
  });
});

describe('transcriptReducer other actions', () => {
  it('cleared empties entries', () => {
    let s = transcriptReducer(base(), { type: 'upsert', entry: entry('a') });
    s = transcriptReducer(s, { type: 'cleared' });
    expect(s.entries).toEqual([]);
  });

  it('context replaces the context', () => {
    const c = ctx({ translating: true });
    const s = transcriptReducer(base(), { type: 'context', c });
    expect(s.context).toBe(c);
  });

  it('suggestions, stt and prefs replace their slices', () => {
    let s = base();
    s = transcriptReducer(s, {
      type: 'suggestions',
      s: { status: 'ready', items: [{ text: 'hi', translation: 'oi' }], updatedAt: 5 },
    });
    expect(s.suggestions.items).toHaveLength(1);
    s = transcriptReducer(s, {
      type: 'stt',
      s: { engine: 'openai', state: 'listening', streams: ['B'] },
    });
    expect(s.stt.state).toBe('listening');
    const p = { ...DEFAULT_ASSISTANT_PREFS, suggestionsEnabled: false };
    s = transcriptReducer(s, { type: 'prefs', p });
    expect(s.prefs).toBe(p);
  });

  it('error records the last error', () => {
    const s = transcriptReducer(base(), {
      type: 'error',
      scope: 'speak',
      code: 'tts-failed',
      at: 42,
    });
    expect(s.lastError).toEqual({ scope: 'speak', code: 'tts-failed', at: 42 });
  });
});

describe('displayLines', () => {
  it('them: translation first, original second', () => {
    expect(
      displayLines(entry('a', { speaker: 'them', original: 'Olá', translated: 'Hello' })),
    ).toEqual({
      primary: 'Hello',
      secondary: 'Olá',
    });
  });
  it('them: only original', () => {
    expect(displayLines(entry('a', { speaker: 'them', original: 'Olá', translated: '' }))).toEqual({
      primary: 'Olá',
      secondary: '',
    });
  });
  it('them: only translation', () => {
    expect(
      displayLines(entry('a', { speaker: 'them', original: '', translated: 'Hello' })),
    ).toEqual({
      primary: 'Hello',
      secondary: '',
    });
  });
  it('me: original first, translation second', () => {
    expect(
      displayLines(entry('a', { speaker: 'me', original: 'Hello', translated: 'Olá' })),
    ).toEqual({
      primary: 'Hello',
      secondary: 'Olá',
    });
  });
  it('me: only original', () => {
    expect(displayLines(entry('a', { speaker: 'me', original: 'Hello', translated: '' }))).toEqual({
      primary: 'Hello',
      secondary: '',
    });
  });
  it('me: only translation', () => {
    expect(displayLines(entry('a', { speaker: 'me', original: '', translated: 'Olá' }))).toEqual({
      primary: 'Olá',
      secondary: '',
    });
  });
  it('both empty', () => {
    expect(displayLines(entry('a', { speaker: 'me', original: '', translated: '' }))).toEqual({
      primary: '',
      secondary: '',
    });
  });
});

describe('headerStatus', () => {
  const withState = (over: Partial<TranscriptViewState>): TranscriptViewState => ({
    ...base(),
    ...over,
  });
  const openai = { ...DEFAULT_ASSISTANT_PREFS, sttEngine: 'openai' as const };
  const sttError = { engine: 'openai' as const, state: 'error' as const, streams: [] };

  it('translating wins over everything', () => {
    expect(
      headerStatus(
        withState({ context: ctx({ translating: true }), stt: sttError, prefs: openai }),
      ),
    ).toBe('translating');
  });
  it('error wins over sttOpenai', () => {
    expect(headerStatus(withState({ context: ctx(), stt: sttError, prefs: openai }))).toBe('error');
  });
  it('sttOpenai when the engine is openai', () => {
    expect(
      headerStatus(
        withState({
          context: ctx(),
          stt: { engine: 'openai', state: 'listening', streams: ['A'] },
          prefs: openai,
        }),
      ),
    ).toBe('sttOpenai');
  });
  it('off otherwise', () => {
    expect(headerStatus(withState({ context: ctx() }))).toBe('off');
  });
});

describe('showSttCta', () => {
  it('shown when not translating and engine off', () => {
    expect(showSttCta({ ...base(), context: ctx() })).toBe(true);
  });
  it('hidden while translating', () => {
    expect(showSttCta({ ...base(), context: ctx({ translating: true }) })).toBe(false);
  });
  it('hidden when an engine is selected', () => {
    expect(
      showSttCta({
        ...base(),
        context: ctx(),
        prefs: { ...DEFAULT_ASSISTANT_PREFS, sttEngine: 'openai' },
      }),
    ).toBe(false);
  });
});
