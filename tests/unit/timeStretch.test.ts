import { describe, it, expect } from 'vitest';
import { TimeStretcher } from '@shared/util/timeStretch';

const SR = 24000;

function sine(freq: number, seconds: number, amp = 0.5): Float32Array {
  const out = new Float32Array(Math.round(seconds * SR));
  for (let i = 0; i < out.length; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
  return out;
}

/** Feeds `input` in chunks of `chunk` samples at `tempo`, then flushes. */
function run(st: TimeStretcher, input: Float32Array, tempo: number, chunk = 1200): Float32Array {
  const parts: Float32Array[] = [];
  for (let i = 0; i < input.length; i += chunk) {
    parts.push(st.process(input.subarray(i, i + chunk), tempo));
  }
  parts.push(st.flush());
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Float32Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Dominant frequency from upward zero crossings. */
function freqOf(x: Float32Array): number {
  let crossings = 0;
  for (let i = 1; i < x.length; i++) if (x[i - 1]! < 0 && x[i]! >= 0) crossings += 1;
  return (crossings / x.length) * SR;
}

describe('TimeStretcher', () => {
  it('at tempo 1 returns the input unchanged (nothing lost, nothing added)', () => {
    const input = sine(220, 1);
    const out = run(new TimeStretcher({ sampleRate: SR }), input, 1);
    expect(out.length).toBe(input.length);
    let maxErr = 0;
    for (let i = 0; i < input.length; i++) maxErr = Math.max(maxErr, Math.abs(out[i]! - input[i]!));
    expect(maxErr).toBeLessThan(1e-4);
  });

  it('at tempo 1.5 shortens the audio by about a third and keeps the pitch', () => {
    const input = sine(200, 3);
    const out = run(new TimeStretcher({ sampleRate: SR }), input, 1.5);
    expect(out.length / input.length).toBeGreaterThan(1 / 1.5 - 0.03);
    expect(out.length / input.length).toBeLessThan(1 / 1.5 + 0.03);
    expect(Math.abs(freqOf(out) - 200)).toBeLessThan(6);
  });

  it('keeps a steady level (no gaps or dips) while speeding up', () => {
    const out = run(new TimeStretcher({ sampleRate: SR }), sine(180, 2, 0.5), 1.4);
    const block = 480;
    for (let b = 0; b + block <= out.length; b += block) {
      let e = 0;
      for (let i = b; i < b + block; i++) e += out[i]! * out[i]!;
      const rms = Math.sqrt(e / block);
      expect(rms).toBeGreaterThan(0.25);
    }
  });

  it('flush returns all buffered audio, even for a short chunk', () => {
    const st = new TimeStretcher({ sampleRate: SR });
    const short = sine(300, 0.03);
    expect(st.process(short, 1.5).length).toBe(0);
    expect(st.pending).toBe(true);
    expect(st.flush().length).toBe(short.length);
    expect(st.pending).toBe(false);
  });

  it('accepts a tempo change between chunks', () => {
    const st = new TimeStretcher({ sampleRate: SR });
    const input = sine(250, 2);
    const a = st.process(input.subarray(0, 24000), 1);
    const b = st.process(input.subarray(24000), 1.6);
    const c = st.flush();
    const total = a.length + b.length + c.length;
    expect(total).toBeLessThan(input.length);
    expect(total).toBeGreaterThan(24000 + 24000 / 1.6 - 1500);
  });
});
