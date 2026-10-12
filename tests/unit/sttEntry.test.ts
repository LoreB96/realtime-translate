import { describe, it, expect } from 'vitest';
import { sttSegmentToEntry } from '@main/stt/sttEntry';
import type { SttSegment } from '@main/stt/sttTypes';

const langs = { user: 'it', them: 'en' } as const;

const seg = (p: Partial<SttSegment>): SttSegment => ({
  id: 'pass-A-item_1',
  direction: 'A',
  text: '',
  final: false,
  mode: 'append',
  ...p,
});

describe('sttSegmentToEntry', () => {
  it('creates an entry from the first append segment (direction A → me, user language)', () => {
    const e = sttSegmentToEntry(undefined, seg({ text: 'Ciao' }), langs, 1000);
    expect(e).toEqual({
      id: 'stt-pass-A-item_1',
      direction: 'A',
      speaker: 'me',
      source: 'stt',
      original: 'Ciao',
      translated: '',
      originalLang: 'it',
      translatedLang: 'en',
      startedAt: 1000,
      updatedAt: 1000,
      final: false,
    });
  });

  it('maps direction B to them with their language', () => {
    const e = sttSegmentToEntry(
      undefined,
      seg({ id: 'pass-B-x', direction: 'B', text: 'Hi' }),
      langs,
      5,
    );
    expect(e).toMatchObject({
      id: 'stt-pass-B-x',
      speaker: 'them',
      originalLang: 'en',
      translatedLang: 'it',
    });
  });

  it('appends with joinDelta and keeps startedAt / translated', () => {
    const first = sttSegmentToEntry(undefined, seg({ text: 'Hello' }), langs, 1000)!;
    const withTr = { ...first, translated: 'Ciao' };
    const second = sttSegmentToEntry(withTr, seg({ text: ' world' }), langs, 2000)!;
    expect(second.original).toBe('Hello world');
    expect(second.translated).toBe('Ciao');
    expect(second.startedAt).toBe(1000);
    expect(second.updatedAt).toBe(2000);
    const third = sttSegmentToEntry(second, seg({ text: ', again' }), langs, 3000)!;
    expect(third.original).toBe('Hello world, again');
  });

  it('replace overwrites the original and sets final', () => {
    const first = sttSegmentToEntry(undefined, seg({ text: 'Helo wrld' }), langs, 1)!;
    const done = sttSegmentToEntry(
      first,
      seg({ text: 'Hello world.', final: true, mode: 'replace' }),
      langs,
      2,
    )!;
    expect(done.original).toBe('Hello world.');
    expect(done.final).toBe(true);
  });

  it('latches final once set', () => {
    const fin = sttSegmentToEntry(undefined, seg({ text: 'Done.', final: true }), langs, 1)!;
    const later = sttSegmentToEntry(fin, seg({ text: 'more', final: false }), langs, 2)!;
    expect(later.final).toBe(true);
  });

  it('a failed item (empty final append) finalizes an existing entry without changing text', () => {
    const first = sttSegmentToEntry(undefined, seg({ text: 'Partial' }), langs, 1)!;
    const failed = sttSegmentToEntry(first, seg({ text: '', final: true }), langs, 2)!;
    expect(failed.original).toBe('Partial');
    expect(failed.final).toBe(true);
  });

  it('returns undefined for an empty first segment', () => {
    expect(sttSegmentToEntry(undefined, seg({ text: '', final: true }), langs, 1)).toBeUndefined();
    expect(sttSegmentToEntry(undefined, seg({ text: '   ' }), langs, 1)).toBeUndefined();
  });
});
