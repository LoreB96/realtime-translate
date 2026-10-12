import { describe, it, expect } from 'vitest';
import { Resampler } from '@shared/util/resampler';

/** Deterministic PRNG (mulberry32) so block sizes are reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sine(n: number, freq: number, rate: number, amp = 0.5, offset = 0): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * (i + offset)) / rate);
  return out;
}

function rms(x: Float32Array, skip = 0): number {
  let s = 0;
  let c = 0;
  for (let i = skip; i < x.length; i++) {
    const v = x[i] ?? 0;
    s += v * v;
    c++;
  }
  return Math.sqrt(s / Math.max(1, c));
}

/** Feed `signal` through the resampler in the given block sizes and concatenate the output. */
function runBlocks(r: Resampler, signal: Float32Array, sizes: number[]): Float32Array {
  const parts: Float32Array[] = [];
  let off = 0;
  for (const size of sizes) {
    const end = Math.min(signal.length, off + size);
    parts.push(r.process(signal.subarray(off, end)));
    off = end;
  }
  if (off < signal.length) parts.push(r.process(signal.subarray(off)));
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Float32Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

describe('Resampler', () => {
  for (const from of [48000, 44100]) {
    it(`${from}→24000 over 100 random-sized blocks stays within ±1 of ideal length`, () => {
      const rand = rng(from);
      const r = new Resampler(from, 24000);
      let totalIn = 0;
      let totalOut = 0;
      for (let b = 0; b < 100; b++) {
        const size = 1 + Math.floor(rand() * 2048);
        totalIn += size;
        totalOut += r.process(new Float32Array(size).fill(0.1)).length;
        const ideal = Math.floor((totalIn * 24000) / from);
        expect(Math.abs(totalOut - ideal)).toBeLessThanOrEqual(1);
      }
    });
  }

  it('passes a 1 kHz sine within 1 dB at 48k→24k (after the first 64 output samples)', () => {
    const input = sine(48000, 1000, 48000);
    const out = runBlocks(new Resampler(48000, 24000), input, Array(50).fill(960));
    const inRms = rms(input);
    const outRms = rms(out, 64);
    const db = 20 * Math.log10(outRms / inRms);
    expect(Math.abs(db)).toBeLessThan(1);
  });

  it('passes a 1 kHz sine within 1 dB at 44.1k→24k', () => {
    const input = sine(44100, 1000, 44100);
    const rand = rng(7);
    const sizes = Array.from({ length: 100 }, () => 1 + Math.floor(rand() * 1000));
    const out = runBlocks(new Resampler(44100, 24000), input, sizes);
    const db = 20 * Math.log10(rms(out, 64) / rms(input));
    expect(Math.abs(db)).toBeLessThan(1);
  });

  it('attenuates a 14 kHz sine (above the 12 kHz output Nyquist) by at least 20 dB at 48k→24k', () => {
    const input = sine(48000, 14000, 48000);
    const out = runBlocks(new Resampler(48000, 24000), input, Array(50).fill(960));
    const db = 20 * Math.log10(rms(out, 64) / rms(input));
    expect(db).toBeLessThanOrEqual(-20);
  });

  it('is continuous across block boundaries (same output for one block vs. many)', () => {
    const input = sine(9600, 440, 48000);
    const whole = new Resampler(48000, 24000).process(input);
    const rand = rng(3);
    const sizes = Array.from({ length: 40 }, () => 1 + Math.floor(rand() * 400));
    const chunked = runBlocks(new Resampler(48000, 24000), input, sizes);
    expect(chunked.length).toBe(whole.length);
    for (let i = 0; i < whole.length; i++) {
      expect(chunked[i]).toBeCloseTo(whole[i] ?? NaN, 5);
    }
  });

  it('copies the input unchanged when rates match (24k→24k)', () => {
    const r = new Resampler(24000, 24000);
    const input = sine(480, 1000, 24000);
    const out = r.process(input);
    expect(out).not.toBe(input);
    expect(Array.from(out)).toEqual(Array.from(input));
  });

  it('returns an empty array for an empty block', () => {
    expect(new Resampler(48000, 24000).process(new Float32Array(0)).length).toBe(0);
  });

  it('rejects invalid rates and tap counts', () => {
    expect(() => new Resampler(0, 24000)).toThrow(RangeError);
    expect(() => new Resampler(48000, -1)).toThrow(RangeError);
    expect(() => new Resampler(48000, 24000, 0)).toThrow(RangeError);
  });
});
