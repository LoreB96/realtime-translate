import { describe, it, expect } from 'vitest';
import { TranscriptStore } from '@main/transcript/transcriptStore';
import type { TranscriptEntry } from '@shared/assistant';

function entry(id: string, over: Partial<TranscriptEntry> = {}): TranscriptEntry {
  return {
    id,
    direction: 'A',
    speaker: 'me',
    source: 'translate',
    original: `orig ${id}`,
    translated: `tr ${id}`,
    originalLang: 'it',
    translatedLang: 'en',
    startedAt: 1,
    updatedAt: 1,
    final: false,
    ...over,
  };
}

function setup(maxEntries?: number) {
  const clock = { t: 100 };
  const upserts: TranscriptEntry[] = [];
  const finals: TranscriptEntry[] = [];
  let cleared = 0;
  const store = new TranscriptStore({
    now: () => clock.t,
    onUpsert: (e) => upserts.push(e),
    onCleared: () => {
      cleared++;
    },
    onFinal: (e) => finals.push(e),
    ...(maxEntries !== undefined ? { maxEntries } : {}),
  });
  return { store, clock, upserts, finals, cleared: () => cleared };
}

describe('TranscriptStore', () => {
  it('appends and replaces by id', () => {
    const { store, upserts } = setup();
    store.upsert(entry('a'));
    store.upsert(entry('b'));
    store.upsert(entry('a', { original: 'new' }));
    expect(store.snapshot().map((e) => [e.id, e.original])).toEqual([
      ['a', 'new'],
      ['b', 'orig b'],
    ]);
    expect(upserts).toHaveLength(3);
  });

  it('stores copies (caller mutation does not leak in or out)', () => {
    const { store } = setup();
    const e = entry('a');
    store.upsert(e);
    e.original = 'mutated';
    const s = store.snapshot();
    expect(s[0]?.original).toBe('orig a');
    if (s[0]) s[0].original = 'mutated2';
    expect(store.get('a')?.original).toBe('orig a');
  });

  it('evicts the oldest entries beyond maxEntries (default 500)', () => {
    const { store } = setup();
    for (let i = 0; i < 502; i++) store.upsert(entry(`e${i}`));
    const s = store.snapshot();
    expect(s).toHaveLength(500);
    expect(s[0]?.id).toBe('e2');
    expect(s[499]?.id).toBe('e501');
  });

  it('fires onFinal exactly once per id', () => {
    const { store, finals } = setup();
    store.upsert(entry('a'));
    expect(finals).toHaveLength(0);
    store.upsert(entry('a', { final: true }));
    store.upsert(entry('a', { final: true, translated: 'late' }));
    expect(finals.map((e) => e.id)).toEqual(['a']);
  });

  it('fires onFinal via patch, once', () => {
    const { store, finals } = setup();
    store.upsert(entry('t', { source: 'typed', speak: 'queued' }));
    store.patch('t', { speak: 'speaking' });
    expect(finals).toHaveLength(0);
    store.patch('t', { final: true, speak: 'done' });
    store.patch('t', { translated: 'x' });
    expect(finals.map((e) => e.speak)).toEqual(['done']);
  });

  it('prunes onFinal ids on eviction and on clear', () => {
    const { store, finals } = setup(2);
    store.upsert(entry('a', { final: true }));
    store.upsert(entry('b'));
    store.upsert(entry('c')); // evicts a
    store.upsert(entry('a', { final: true })); // a is new again
    expect(finals.map((e) => e.id)).toEqual(['a', 'a']);
    store.clear();
    store.upsert(entry('a', { final: true }));
    expect(finals).toHaveLength(3);
  });

  it('get returns a copy or undefined', () => {
    const { store } = setup();
    store.upsert(entry('a'));
    expect(store.get('a')?.id).toBe('a');
    expect(store.get('zzz')).toBeUndefined();
  });

  it('patch merges, sets updatedAt, notifies, and keeps the id', () => {
    const { store, clock, upserts } = setup();
    store.upsert(entry('a'));
    clock.t = 500;
    const p = store.patch('a', { translated: 'patched' });
    expect(p).toMatchObject({ id: 'a', translated: 'patched', original: 'orig a', updatedAt: 500 });
    expect(upserts.at(-1)).toMatchObject({ translated: 'patched', updatedAt: 500 });
    expect(store.patch('missing', { translated: 'x' })).toBeUndefined();
    expect(upserts).toHaveLength(2);
  });

  it('recent: order, skip-empty, finalOnly, entry and char limits', () => {
    const { store } = setup();
    store.upsert(entry('a', { original: 'aaaa', translated: 'aaaa', final: true })); // 8
    store.upsert(entry('empty', { original: ' ', translated: '', final: true }));
    store.upsert(entry('b', { original: 'bb', translated: 'bb', final: true })); // 4
    store.upsert(entry('open', { original: 'cc', translated: '', final: false })); // 2
    store.upsert(entry('d', { original: 'd', translated: '', final: true })); // 1

    expect(store.recent({ maxEntries: 10, maxChars: 1000 }).map((e) => e.id)).toEqual([
      'a',
      'b',
      'open',
      'd',
    ]);
    expect(
      store.recent({ maxEntries: 10, maxChars: 1000, finalOnly: true }).map((e) => e.id),
    ).toEqual(['a', 'b', 'd']);
    expect(store.recent({ maxEntries: 2, maxChars: 1000 }).map((e) => e.id)).toEqual(['open', 'd']);
    // 1 + 2 + 4 = 7; adding a (8) would exceed 10.
    expect(store.recent({ maxEntries: 10, maxChars: 10 }).map((e) => e.id)).toEqual([
      'b',
      'open',
      'd',
    ]);
    // The newest entry is kept even when it alone exceeds the budget.
    expect(store.recent({ maxEntries: 10, maxChars: 0 }).map((e) => e.id)).toEqual(['d']);
    expect(store.recent({ maxEntries: 0, maxChars: 1000 })).toEqual([]);
  });

  it('clear empties the store and notifies', () => {
    const { store, cleared } = setup();
    store.upsert(entry('a'));
    store.clear();
    expect(store.snapshot()).toEqual([]);
    expect(store.get('a')).toBeUndefined();
    expect(cleared()).toBe(1);
  });
});
