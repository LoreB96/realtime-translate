import { describe, expect, it } from 'vitest';
import { createPcmTapChain } from '@renderer/offscreen/webAudioBridge';

/** Sine at `amp` peak, `n` samples at `rate`, starting at sample `offset`. */
function sine(n: number, rate: number, amp: number, offset = 0): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * 440 * (i + offset)) / rate);
  return out;
}

/** Feeds `total` samples in 128-sample worklet blocks. */
function feed(push: (b: Float32Array) => void, total: number, rate: number, amp: number): void {
  for (let off = 0; off < total; off += 128) push(sine(Math.min(128, total - off), rate, amp, off));
}

describe('createPcmTapChain', () => {
  it('emits 40 ms frames at 24 kHz from a 48 kHz loud input', () => {
    const frames: Float32Array[] = [];
    const push = createPcmTapChain(48000, { rate: 24000, onFrame: (f) => frames.push(f) });
    feed(push, 48000, 48000, 0.5); // 1 s
    expect(frames.length).toBeGreaterThanOrEqual(23);
    expect(frames.length).toBeLessThanOrEqual(25);
    for (const f of frames) expect(f.length).toBe(960);
    const peak = Math.max(...frames.slice(2).map((f) => Math.max(...Array.from(f, Math.abs))));
    expect(peak).toBeGreaterThan(0.3);
  });

  it('handles 44.1 kHz input', () => {
    let count = 0;
    const push = createPcmTapChain(44100, { rate: 24000, onFrame: () => count++ });
    feed(push, 44100, 44100, 0.5);
    expect(count).toBeGreaterThanOrEqual(23);
    expect(count).toBeLessThanOrEqual(25);
  });

  it('drops silence entirely', () => {
    let count = 0;
    const push = createPcmTapChain(48000, { rate: 24000, onFrame: () => count++ });
    feed(push, 48000, 48000, 0);
    expect(count).toBe(0);
  });

  it('after speech, emits a hangover then a zero tail, then stops', () => {
    const frames: Float32Array[] = [];
    const push = createPcmTapChain(48000, { rate: 24000, onFrame: (f) => frames.push(f) });
    feed(push, 24000, 48000, 0.5); // 0.5 s speech
    const speech = frames.length;
    feed(push, 96000, 48000, 0); // 2 s silence
    const after = frames.slice(speech);
    // 400 ms hangover (~10 frames) + 500 ms tail (~13 frames), nothing more.
    expect(after.length).toBeGreaterThanOrEqual(20);
    expect(after.length).toBeLessThanOrEqual(26);
    const last = after[after.length - 1];
    expect(last && last.every((v) => v === 0)).toBe(true);
  });

  it('propagates sink errors to the caller (startPassthrough catches them)', () => {
    const push = createPcmTapChain(48000, {
      rate: 24000,
      onFrame: () => {
        throw new Error('sink');
      },
    });
    expect(() => feed(push, 48000, 48000, 0.5)).toThrow('sink');
  });
});
