/**
 * Splits a streamed PCM16 (24 kHz mono, little-endian) HTTP body into fixed-size base64
 * chunks for the offscreen playback stream. Network reads arrive at arbitrary byte
 * boundaries (even odd ones); bytes that do not complete a chunk are carried over to the
 * next push. Spec §6.5.
 */

export const TTS_SAMPLE_RATE = 24000;
/** 100 ms of PCM16 mono at 24 kHz. */
export const CHUNK_BYTES = 4800;

export class PcmStreamChunker {
  private carry: Buffer = Buffer.alloc(0);
  private emittedBytes = 0;

  /** Returns base64 chunks of exactly CHUNK_BYTES; the remainder is kept for later. */
  push(bytes: Uint8Array): string[] {
    if (bytes.length === 0) return [];
    const data =
      this.carry.length === 0
        ? Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        : Buffer.concat([this.carry, bytes]);
    const out: string[] = [];
    let offset = 0;
    while (data.length - offset >= CHUNK_BYTES) {
      out.push(data.subarray(offset, offset + CHUNK_BYTES).toString('base64'));
      offset += CHUNK_BYTES;
    }
    this.emittedBytes += offset;
    // Copy so the carry never aliases the caller's buffer.
    this.carry = Buffer.from(data.subarray(offset));
    return out;
  }

  /** Remaining bytes rounded down to an even length (whole samples), or undefined. */
  flush(): string | undefined {
    const even = this.carry.length - (this.carry.length % 2);
    const tail = this.carry.subarray(0, even);
    this.carry = Buffer.alloc(0);
    if (even === 0) return undefined;
    this.emittedBytes += even;
    return tail.toString('base64');
  }

  /** Samples handed out so far (chunks plus the flushed tail). */
  get totalSamples(): number {
    return this.emittedBytes / 2;
  }
}
