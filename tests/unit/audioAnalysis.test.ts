import { describe, it, expect } from 'vitest';
import {
  DB_FLOOR,
  FrameBatcher,
  GATE_MAX_THRESHOLD_DB,
  GATE_MIN_THRESHOLD_DB,
  LevelMeter,
  SilenceGate,
  computeLevel,
  toDb,
  type AudioLevel,
} from '@shared/util/audioAnalysis';

const SR = 24000;
/** 40 ms frame at 24 kHz. */
const FRAME = 960;

const constant = (n: number, v: number): Float32Array => new Float32Array(n).fill(v);

describe('toDb / computeLevel', () => {
  it('maps full scale to 0 dB and half to ~-6 dB', () => {
    expect(toDb(1)).toBeCloseTo(0, 6);
    expect(toDb(0.5)).toBeCloseTo(-6.0206, 3);
  });

  it('floors zero, negatives and non-finite values', () => {
    expect(toDb(0)).toBe(DB_FLOOR);
    expect(toDb(-1)).toBe(DB_FLOOR);
    expect(toDb(NaN)).toBe(DB_FLOOR);
    expect(toDb(1e-9)).toBe(DB_FLOOR);
  });

  it('computes RMS and peak of a constant signal', () => {
    const l = computeLevel(constant(100, 0.1));
    expect(l.rmsDb).toBeCloseTo(-20, 6);
    expect(l.peakDb).toBeCloseTo(-20, 6);
    expect(l.digitalSilence).toBe(false);
  });

  it('uses the absolute value for the peak', () => {
    const l = computeLevel(new Float32Array([0, -0.5, 0.25]));
    expect(l.peakDb).toBeCloseTo(-6.0206, 3);
  });

  it('reports digital silence only for exact zeros', () => {
    expect(computeLevel(constant(64, 0))).toEqual({
      rmsDb: DB_FLOOR,
      peakDb: DB_FLOOR,
      digitalSilence: true,
    });
    const nearly = constant(64, 0);
    nearly[10] = 1e-7;
    expect(computeLevel(nearly).digitalSilence).toBe(false);
  });

  it('treats an empty buffer as silence and NaN samples as zero', () => {
    expect(computeLevel(new Float32Array(0)).digitalSilence).toBe(true);
    expect(computeLevel(new Float32Array([NaN, Infinity])).digitalSilence).toBe(true);
  });
});

describe('FrameBatcher', () => {
  it('accumulates 128-sample blocks into 960-sample frames', () => {
    const b = new FrameBatcher();
    const frames: Float32Array[] = [];
    for (let i = 0; i < 15; i++) frames.push(...b.push(constant(128, i)));
    // 15 * 128 = 1920 = exactly 2 frames.
    expect(frames).toHaveLength(2);
    expect(frames[0]!.length).toBe(960);
    // Sample continuity: frame 0 ends inside block 7 (7*128=896, 960-896=64 from block 7).
    expect(frames[0]![959]).toBe(7);
    expect(frames[1]![0]).toBe(7);
    expect(frames[1]![959]).toBe(14);
    expect(b.flush()).toBeNull();
  });

  it('does not alias emitted frames with later input', () => {
    const b = new FrameBatcher(4);
    const [f1] = b.push(constant(4, 1));
    b.push(constant(4, 2));
    expect(Array.from(f1!)).toEqual([1, 1, 1, 1]);
  });

  it('splits a large block into several frames and keeps the remainder', () => {
    const b = new FrameBatcher(4);
    const frames = b.push(new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
    expect(frames.map((f) => Array.from(f))).toEqual([
      [1, 2, 3, 4],
      [5, 6, 7, 8],
    ]);
    expect(Array.from(b.flush()!)).toEqual([9, 10]);
    expect(b.flush()).toBeNull();
  });

  it('rejects invalid frame sizes', () => {
    expect(() => new FrameBatcher(0)).toThrow();
    expect(() => new FrameBatcher(1.5)).toThrow();
  });
});

describe('SilenceGate', () => {
  const LOUD = 0.1; // -20 dBFS
  const QUIET = 0.001; // -60 dBFS
  const mk = (): SilenceGate =>
    new SilenceGate({ sampleRate: SR, thresholdDb: -50, hangoverMs: 120, preRollMs: 80 });

  it('drops silence while closed', () => {
    const g = mk();
    for (let i = 0; i < 20; i++) expect(g.process(constant(FRAME, QUIET))).toEqual([]);
    expect(g.isOpen).toBe(false);
  });

  it('opens on a loud frame and emits the pre-roll first, in order', () => {
    const g = mk();
    // 80 ms pre-roll = 2 frames of 40 ms: only the newest two quiet frames survive.
    const [q1, q2, q3, loud] = [QUIET, QUIET, QUIET, LOUD].map((v) => constant(FRAME, v));
    g.process(q1!);
    g.process(q2!);
    g.process(q3!);
    const out = g.process(loud!);
    expect(g.isOpen).toBe(true);
    expect(out).toHaveLength(3);
    expect(out[0]).toBe(q2);
    expect(out[1]).toBe(q3);
    expect(out[2]).toBe(loud);
  });

  it('stays open for the hangover then closes', () => {
    const g = mk();
    g.process(constant(FRAME, LOUD));
    // hangover 120 ms = 3 quiet frames forwarded, the 4th closes the gate.
    expect(g.process(constant(FRAME, QUIET))).toHaveLength(1);
    expect(g.process(constant(FRAME, QUIET))).toHaveLength(1);
    expect(g.process(constant(FRAME, QUIET))).toHaveLength(1);
    expect(g.process(constant(FRAME, QUIET))).toHaveLength(0);
    expect(g.isOpen).toBe(false);
  });

  it('restarts the hangover on every loud frame', () => {
    const g = mk();
    g.process(constant(FRAME, LOUD));
    g.process(constant(FRAME, QUIET));
    g.process(constant(FRAME, QUIET));
    g.process(constant(FRAME, LOUD));
    for (let i = 0; i < 3; i++) expect(g.process(constant(FRAME, QUIET))).toHaveLength(1);
    expect(g.process(constant(FRAME, QUIET))).toHaveLength(0);
  });

  it('does not re-emit hangover frames as pre-roll on the next opening', () => {
    const g = mk();
    g.process(constant(FRAME, LOUD));
    for (let i = 0; i < 3; i++) g.process(constant(FRAME, QUIET)); // forwarded hangover
    const closing = constant(FRAME, QUIET);
    g.process(closing); // closes the gate, buffered as pre-roll
    const loud = constant(FRAME, LOUD);
    const out = g.process(loud);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(closing);
    expect(out[1]).toBe(loud);
  });

  it('never opens on digital silence and works with a zero pre-roll', () => {
    const g = new SilenceGate({ sampleRate: SR, preRollMs: 0 });
    expect(g.process(constant(FRAME, 0))).toEqual([]);
    expect(g.process(constant(FRAME, LOUD))).toHaveLength(1);
  });

  it('reset() closes the gate and clears the pre-roll', () => {
    const g = mk();
    g.process(constant(FRAME, QUIET));
    g.process(constant(FRAME, LOUD));
    g.reset();
    expect(g.isOpen).toBe(false);
    const quiet = constant(FRAME, QUIET);
    g.process(quiet);
    const loud = constant(FRAME, LOUD);
    const out = g.process(loud);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(quiet);
    expect(out[1]).toBe(loud);
  });
});

describe('SilenceGate: adaptive threshold, tail, open time', () => {
  const amp = (db: number): number => Math.pow(10, db / 20);
  const frame = (db: number): Float32Array => constant(FRAME, amp(db));

  it('starts at the minimum threshold, so quiet but clean speech passes', () => {
    const g = new SilenceGate({ sampleRate: SR });
    expect(g.thresholdDb).toBe(GATE_MIN_THRESHOLD_DB);
    for (let i = 0; i < 50; i++) g.process(frame(-80)); // clean line, low floor
    expect(g.process(frame(-55)).length).toBeGreaterThan(0);
  });

  it('rises on a noisy line (up to the max) so hiss does not reach the model', () => {
    const g = new SilenceGate({ sampleRate: SR, preRollMs: 0, hangoverMs: 0 });
    // 30 s of -55 dBFS noise: the floor estimate climbs, the threshold clamps at the max.
    let lastOut = 1;
    for (let i = 0; i < 750; i++) lastOut = g.process(frame(-55)).length;
    expect(g.thresholdDb).toBe(GATE_MAX_THRESHOLD_DB);
    expect(lastOut).toBe(0);
    expect(g.process(frame(-30))).toHaveLength(1);
  });

  it('ignores exact zeros when estimating the floor', () => {
    const g = new SilenceGate({ sampleRate: SR });
    for (let i = 0; i < 200; i++) g.process(constant(FRAME, 0));
    expect(g.thresholdDb).toBe(GATE_MIN_THRESHOLD_DB);
  });

  it('emits a tail of zeros after closing, and a loud frame during the tail reopens', () => {
    const g = new SilenceGate({ sampleRate: SR, thresholdDb: -50, hangoverMs: 40, preRollMs: 0, tailMs: 80 });
    g.process(frame(-20));
    expect(g.process(frame(-70))).toHaveLength(1); // hangover (real audio)
    const t1 = g.process(frame(-70)); // closes -> tail
    expect(t1).toHaveLength(1);
    expect(t1[0]!.every((v) => v === 0)).toBe(true);
    expect(g.process(frame(-70))[0]!.every((v) => v === 0)).toBe(true);
    expect(g.process(frame(-70))).toEqual([]); // tail spent
    expect(g.process(frame(-20))).toHaveLength(1);
  });

  it('takeOpenMs() counts real audio forwarded (not the tail) and resets', () => {
    const g = new SilenceGate({ sampleRate: SR, thresholdDb: -50, hangoverMs: 40, preRollMs: 0, tailMs: 400 });
    expect(g.takeOpenMs()).toBe(0);
    g.process(frame(-20)); // 40 ms loud
    g.process(frame(-70)); // 40 ms hangover
    g.process(frame(-70)); // tail
    g.process(frame(-70)); // tail
    expect(g.takeOpenMs()).toBeCloseTo(80);
    expect(g.takeOpenMs()).toBe(0);
  });
});

describe('LevelMeter', () => {
  it('emits one report per window across block boundaries', () => {
    const reports: AudioLevel[] = [];
    // 500 ms at 1 kHz = 500 samples per window.
    const m = new LevelMeter({ sampleRate: 1000, onReport: (l) => reports.push(l) });
    for (let i = 0; i < 9; i++) m.push(constant(128, 0.1)); // 1152 samples
    expect(reports).toHaveLength(2);
    expect(reports[0]!.rmsDb).toBeCloseTo(-20, 5);
    m.flush(); // 152 leftover samples
    expect(reports).toHaveLength(3);
    m.flush();
    expect(reports).toHaveLength(3);
  });

  it('flags digital silence only when the whole window is zero', () => {
    const reports: AudioLevel[] = [];
    const m = new LevelMeter({ sampleRate: 1000, windowMs: 100, onReport: (l) => reports.push(l) });
    m.push(constant(100, 0));
    const mostlyZero = constant(100, 0);
    mostlyZero[99] = 0.5;
    m.push(mostlyZero);
    expect(reports.map((r) => r.digitalSilence)).toEqual([true, false]);
    expect(reports[1]!.peakDb).toBeCloseTo(-6.0206, 3);
  });

  it('keeps windows independent', () => {
    const reports: AudioLevel[] = [];
    const m = new LevelMeter({ sampleRate: 1000, windowMs: 10, onReport: (l) => reports.push(l) });
    m.push(new Float32Array([...constant(10, 1), ...constant(10, 0)]));
    expect(reports[0]!.rmsDb).toBeCloseTo(0, 6);
    expect(reports[1]).toEqual({ rmsDb: DB_FLOOR, peakDb: DB_FLOOR, digitalSilence: true });
  });
});
