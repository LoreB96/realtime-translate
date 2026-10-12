import { describe, it, expect } from 'vitest';
import { CHUNK_BYTES, PcmStreamChunker, TTS_SAMPLE_RATE } from '@main/tts/pcmStreamChunker';

function seq(n: number, start = 0): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (start + i) & 0xff;
  return out;
}

const decode = (b64: string): Uint8Array => new Uint8Array(Buffer.from(b64, 'base64'));

describe('PcmStreamChunker', () => {
  it('uses 100 ms chunks at 24 kHz PCM16', () => {
    expect(TTS_SAMPLE_RATE).toBe(24000);
    expect(CHUNK_BYTES).toBe(4800);
  });

  it('emits exact chunks and nothing for a partial push', () => {
    const c = new PcmStreamChunker();
    expect(c.push(seq(100))).toEqual([]);
    expect(c.totalSamples).toBe(0);
    const out = c.push(seq(CHUNK_BYTES * 2, 100));
    expect(out).toHaveLength(2);
    for (const b of out) expect(decode(b)).toHaveLength(CHUNK_BYTES);
    expect(c.totalSamples).toBe(CHUNK_BYTES);
    // The 100 carried bytes are still waiting.
    expect(decode(c.flush() ?? '')).toHaveLength(100);
    expect(c.totalSamples).toBe(CHUNK_BYTES + 50);
  });

  it('carries odd byte boundaries across pushes and keeps byte values in order', () => {
    const c = new PcmStreamChunker();
    const all = seq(CHUNK_BYTES * 2 + 7);
    const parts = [all.subarray(0, 4799), all.subarray(4799, 4801), all.subarray(4801)];
    const chunks: string[] = [];
    for (const p of parts) chunks.push(...c.push(p));
    expect(chunks).toHaveLength(2);
    const joined = Buffer.concat(chunks.map((b) => Buffer.from(b, 'base64')));
    expect(new Uint8Array(joined)).toEqual(all.subarray(0, CHUNK_BYTES * 2));
    // 7 left over: flush rounds down to 6 (whole samples).
    const tail = decode(c.flush() ?? '');
    expect(tail).toEqual(all.subarray(CHUNK_BYTES * 2, CHUNK_BYTES * 2 + 6));
    expect(c.totalSamples).toBe(CHUNK_BYTES + 3);
  });

  it('does not alias the caller buffer in the carry', () => {
    const c = new PcmStreamChunker();
    const buf = seq(10);
    c.push(buf);
    buf.fill(0);
    expect(decode(c.flush() ?? '')).toEqual(seq(10));
  });

  it('flush returns undefined when nothing (or a single byte) is left, and resets', () => {
    const c = new PcmStreamChunker();
    expect(c.flush()).toBeUndefined();
    c.push(seq(1));
    expect(c.flush()).toBeUndefined();
    expect(c.totalSamples).toBe(0);
    expect(c.flush()).toBeUndefined();
    expect(c.push(new Uint8Array(0))).toEqual([]);
  });
});
