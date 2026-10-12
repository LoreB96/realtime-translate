import { describe, it, expect } from 'vitest';
import {
  TranscriptAssembler,
  FINALIZE_IDLE_MS,
  LATE_OUTPUT_MS,
  LONG_ENTRY_MS,
} from '@main/transcript/transcriptAssembler';
import type { LanguageCode } from '@shared/languages';

function setup(user: LanguageCode = 'it', them: LanguageCode = 'en') {
  const clock = { t: 1_000_000 };
  const langs = { user, them };
  const asm = new TranscriptAssembler({ now: () => clock.t, langs: () => langs });
  const at = (ms: number): void => {
    clock.t = 1_000_000 + ms;
  };
  return { asm, clock, at, langs };
}

describe('TranscriptAssembler', () => {
  it('merges input and output of the same direction into one entry', () => {
    const { asm, at } = setup();
    const a = asm.onTranslateDelta({ direction: 'A', kind: 'input', text: 'Ciao' });
    at(500);
    const b = asm.onTranslateDelta({ direction: 'A', kind: 'output', text: 'Hello' });
    expect(a?.id).toBe(b?.id);
    expect(b).toMatchObject({
      direction: 'A',
      speaker: 'me',
      source: 'translate',
      original: 'Ciao',
      translated: 'Hello',
      originalLang: 'it',
      translatedLang: 'en',
      final: false,
      startedAt: 1_000_000,
      updatedAt: 1_000_500,
    });
  });

  it('joins deltas with joinDelta rules', () => {
    const { asm } = setup();
    // Token pieces carry their own spacing; a whitespace-only piece inside an entry counts.
    asm.onTranslateDelta({ direction: 'A', kind: 'input', text: ' Hel' });
    asm.onTranslateDelta({ direction: 'A', kind: 'input', text: 'lo' });
    asm.onTranslateDelta({ direction: 'A', kind: 'input', text: ' ' });
    asm.onTranslateDelta({ direction: 'A', kind: 'input', text: 'world' });
    const e = asm.onTranslateDelta({ direction: 'A', kind: 'input', text: ', ok' });
    expect(e?.original).toBe('Hello world, ok');
    asm.onTranslateDelta({ direction: 'A', kind: 'output', text: '你好' });
    const z = asm.onTranslateDelta({ direction: 'A', kind: 'output', text: '世界' });
    expect(z?.translated).toBe('你好世界');
  });

  it('ignores empty and whitespace-only deltas', () => {
    const { asm } = setup();
    expect(asm.onTranslateDelta({ direction: 'A', kind: 'input', text: '' })).toBeUndefined();
    expect(asm.onTranslateDelta({ direction: 'A', kind: 'input', text: '   ' })).toBeUndefined();
    expect(asm.finalizeAll()).toEqual([]);
  });

  it('returns copies, not internal state', () => {
    const { asm } = setup();
    const e = asm.onTranslateDelta({ direction: 'A', kind: 'input', text: 'x' });
    if (!e) throw new Error('expected entry');
    e.original = 'mutated';
    const e2 = asm.onTranslateDelta({ direction: 'A', kind: 'input', text: ' y' });
    expect(e2?.original).toBe('x y');
  });

  it('finalizes on idle at exactly FINALIZE_IDLE_MS', () => {
    const { asm, at } = setup();
    asm.onTranslateDelta({ direction: 'B', kind: 'input', text: 'Hi' });
    at(200);
    asm.onTranslateDelta({ direction: 'B', kind: 'output', text: 'Ciao' });
    at(200 + FINALIZE_IDLE_MS - 1);
    expect(asm.tick()).toEqual([]);
    at(200 + FINALIZE_IDLE_MS);
    const changed = asm.tick();
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({ final: true, original: 'Hi', translated: 'Ciao' });
    expect(asm.tick()).toEqual([]);
  });

  it('waits for lagging output (2.5 s) and keeps it in the same entry', () => {
    const { asm, at } = setup();
    const first = asm.onTranslateDelta({ direction: 'A', kind: 'input', text: 'Buongiorno' });
    for (let t = 500; t <= 2500; t += 500) {
      at(t);
      expect(asm.tick()).toEqual([]); // idle ≥ 1800 at 2000 but still waiting for output
    }
    const out = asm.onTranslateDelta({ direction: 'A', kind: 'output', text: 'Good morning' });
    expect(out?.id).toBe(first?.id);
    at(2500 + FINALIZE_IDLE_MS);
    const done = asm.tick();
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({
      id: first?.id,
      original: 'Buongiorno',
      translated: 'Good morning',
    });
  });

  it('stops waiting for output after OUTPUT_LAG_MS', () => {
    const { asm, at } = setup();
    asm.onTranslateDelta({ direction: 'A', kind: 'input', text: 'Buongiorno' });
    at(3999);
    expect(asm.tick()).toEqual([]);
    at(4000);
    expect(asm.tick()).toHaveLength(1);
  });

  it('does not split on a 2.5 s output lag across the 30 s boundary', () => {
    const { asm, at } = setup();
    const ids = new Set<string>();
    const finals: string[] = [];
    // Input every 500 ms from 0 to 29.5 s; output lags 2.5 s (2.5 s .. 32 s). Tick every 500 ms.
    for (let t = 0; t <= 32_000; t += 500) {
      at(t);
      if (t <= 29_500) {
        const e = asm.onTranslateDelta({ direction: 'A', kind: 'input', text: `w${t}.` });
        if (e) ids.add(e.id);
      }
      if (t >= 2500) {
        const last = t === 32_000;
        const e = asm.onTranslateDelta({
          direction: 'A',
          kind: 'output',
          text: last ? 'end.' : `o${t}`,
        });
        if (e) {
          ids.add(e.id);
          if (e.final) finals.push(e.id);
        }
      }
      for (const e of asm.tick()) {
        ids.add(e.id);
        finals.push(e.id);
      }
    }
    expect(ids.size).toBe(1);
    expect(finals).toHaveLength(1); // finalized by the long-entry rule on the last output
  });

  it('finalizes a long entry on sentence-ending translation once input is idle', () => {
    const { asm, at } = setup();
    asm.onTranslateDelta({ direction: 'A', kind: 'input', text: 'a' });
    at(LONG_ENTRY_MS - 2000);
    asm.onTranslateDelta({ direction: 'A', kind: 'input', text: 'b' });
    at(LONG_ENTRY_MS - 1000);
    asm.onTranslateDelta({ direction: 'A', kind: 'output', text: 'Sentence one.' });
    at(LONG_ENTRY_MS - 500);
    expect(asm.tick()).toEqual([]); // not old enough, and output is recent
    at(LONG_ENTRY_MS);
    // Keep output flowing so the idle rule cannot fire; only the long rule can.
    const e = asm.onTranslateDelta({ direction: 'A', kind: 'output', text: 'Two!' });
    expect(e?.final).toBe(true);
    expect(e?.translated).toBe('Sentence one. Two!');
  });

  it('long entry rule ignores translations that do not end a sentence', () => {
    const { asm, at } = setup();
    asm.onTranslateDelta({ direction: 'A', kind: 'output', text: 'x' });
    for (let t = 500; t <= LONG_ENTRY_MS + 1000; t += 500) {
      at(t);
      const e = asm.onTranslateDelta({ direction: 'A', kind: 'output', text: 'and' });
      expect(e?.final).toBe(false);
      expect(asm.tick()).toEqual([]);
    }
  });

  it('long entry rule waits for input to be idle for 1800 ms', () => {
    const { asm, at } = setup();
    asm.onTranslateDelta({ direction: 'A', kind: 'output', text: 'Start.' });
    at(LONG_ENTRY_MS);
    asm.onTranslateDelta({ direction: 'A', kind: 'input', text: 'x' });
    const e = asm.onTranslateDelta({ direction: 'A', kind: 'output', text: 'Done.' });
    expect(e?.final).toBe(false);
    at(LONG_ENTRY_MS + 1000);
    asm.onTranslateDelta({ direction: 'A', kind: 'output', text: 'More.' });
    expect(asm.tick()).toEqual([]);
    at(LONG_ENTRY_MS + FINALIZE_IDLE_MS);
    expect(asm.tick()).toHaveLength(1);
  });

  it('attaches late output within LATE_OUTPUT_MS', () => {
    const { asm, at } = setup();
    const first = asm.onTranslateDelta({ direction: 'B', kind: 'input', text: 'How are you?' });
    at(5000); // past OUTPUT_LAG_MS, no output yet
    const [fin] = asm.tick();
    expect(fin).toMatchObject({ final: true, translated: '' });
    at(5000 + LATE_OUTPUT_MS - 1);
    const late = asm.onTranslateDelta({ direction: 'B', kind: 'output', text: 'Come stai' });
    expect(late).toMatchObject({ id: first?.id, final: true, translated: 'Come stai' });
    // A continuation of the same late translation keeps attaching.
    at(5000 + LATE_OUTPUT_MS + 500);
    const late2 = asm.onTranslateDelta({ direction: 'B', kind: 'output', text: '?' });
    expect(late2).toMatchObject({ id: first?.id, translated: 'Come stai?' });
    expect(asm.tick()).toEqual([]);
  });

  it('reset forgets the last final and the open entry (Clear transcript)', () => {
    const { asm, at } = setup();
    const first = asm.onTranslateDelta({ direction: 'B', kind: 'input', text: 'How are you?' });
    at(5000);
    asm.tick();
    const open = asm.onTranslateDelta({ direction: 'A', kind: 'input', text: 'Ciao' });
    asm.reset();
    at(5000 + 100);
    // A late output no longer re-attaches to the cleared entry: it opens a new one.
    const late = asm.onTranslateDelta({ direction: 'B', kind: 'output', text: 'Come stai' });
    expect(late).toMatchObject({ final: false, original: '', translated: 'Come stai' });
    expect(late?.id).not.toBe(first?.id);
    // The open A entry is gone too: the next delta starts fresh with a new id.
    const next = asm.onTranslateDelta({ direction: 'A', kind: 'input', text: 'di nuovo' });
    expect(next).toMatchObject({ original: 'di nuovo' });
    expect(next?.id).not.toBe(open?.id);
  });

  it('does not attach late output after LATE_OUTPUT_MS', () => {
    const { asm, at } = setup();
    const first = asm.onTranslateDelta({ direction: 'B', kind: 'input', text: 'How are you?' });
    at(5000);
    asm.tick();
    at(5000 + LATE_OUTPUT_MS);
    const e = asm.onTranslateDelta({ direction: 'B', kind: 'output', text: 'Come stai' });
    expect(e?.id).not.toBe(first?.id);
    expect(e).toMatchObject({ final: false, original: '', translated: 'Come stai' });
  });

  it('does not attach late output to an entry that already has a translation', () => {
    const { asm, at } = setup();
    const first = asm.onTranslateDelta({ direction: 'B', kind: 'input', text: 'Hi' });
    asm.onTranslateDelta({ direction: 'B', kind: 'output', text: 'Ciao' });
    at(FINALIZE_IDLE_MS);
    asm.tick();
    at(FINALIZE_IDLE_MS + 100);
    const e = asm.onTranslateDelta({ direction: 'B', kind: 'output', text: 'extra' });
    expect(e?.id).not.toBe(first?.id);
  });

  it('keeps A and B independent', () => {
    const { asm, at } = setup();
    const a = asm.onTranslateDelta({ direction: 'A', kind: 'input', text: 'Ciao' });
    at(1000);
    const b = asm.onTranslateDelta({ direction: 'B', kind: 'input', text: 'Hello' });
    expect(a?.id).not.toBe(b?.id);
    expect(b).toMatchObject({
      speaker: 'them',
      originalLang: 'en',
      translatedLang: 'it',
    });
    at(4000); // A input 4 s ago → not waiting; B 3 s ago → still waiting
    const changed = asm.tick();
    expect(changed.map((e) => e.direction)).toEqual(['A']);
  });

  it('finalizeAll finalizes every open entry', () => {
    const { asm } = setup();
    asm.onTranslateDelta({ direction: 'A', kind: 'input', text: 'a' });
    asm.onTranslateDelta({ direction: 'B', kind: 'output', text: 'b' });
    const all = asm.finalizeAll();
    expect(all).toHaveLength(2);
    expect(all.every((e) => e.final)).toBe(true);
    expect(asm.finalizeAll()).toEqual([]);
  });

  it('reads languages at entry creation', () => {
    const { asm, langs } = setup();
    asm.onTranslateDelta({ direction: 'A', kind: 'input', text: 'a' });
    asm.finalizeAll();
    langs.user = 'pt';
    const e = asm.onTranslateDelta({ direction: 'A', kind: 'input', text: 'b' });
    expect(e?.originalLang).toBe('pt');
  });

  it('never reuses ids after finalizeAll', () => {
    const { asm, at } = setup();
    const seen = new Set<string>();
    for (let i = 0; i < 5; i++) {
      at(i * 10_000);
      const a = asm.onTranslateDelta({ direction: 'A', kind: 'input', text: 'a' });
      const b = asm.onTranslateDelta({ direction: 'B', kind: 'input', text: 'b' });
      for (const e of [a, b]) {
        if (!e) throw new Error('expected entry');
        expect(seen.has(e.id)).toBe(false);
        expect(e.id).toMatch(/^tr-[AB]-\d+$/);
        seen.add(e.id);
      }
      asm.finalizeAll();
    }
    expect(seen.size).toBe(10);
  });
});
