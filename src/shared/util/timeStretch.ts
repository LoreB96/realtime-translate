/**
 * Streaming WSOLA time-stretcher: plays speech faster without raising its pitch.
 *
 * Speeding up playback by resampling (AudioBufferSourceNode.playbackRate) also shifts the
 * voice up ("chipmunk"), which limits how fast translated speech can catch up. WSOLA cuts
 * the input into overlapping 40 ms windows, advances through the input `tempo` times faster
 * than through the output, and nudges each window (±10 ms) to where it lines up best with
 * the previous one, so pitch periods join smoothly. Nothing is dropped except the time
 * squeezed out by the tempo; flush() returns every remaining input sample.
 *
 * Mono Float32. The tempo may change between calls (per chunk). At tempo 1 the chosen
 * windows are the natural continuation, so the output equals the input.
 */
export interface TimeStretchOptions {
  sampleRate: number;
  /** Window length in ms (default 40). */
  windowMs?: number;
  /** Search range around the ideal position in ms (default 10). */
  searchMs?: number;
}

export class TimeStretcher {
  private readonly n: number; // window length (samples)
  private readonly hs: number; // synthesis hop = n / 2
  private readonly delta: number; // search radius
  private readonly win: Float32Array; // periodic Hann: w[i] + w[i + hs] === 1
  private buf = new Float32Array(0); // pending input
  private len = 0; // valid samples in buf
  /** Ideal start (in buf) of the next analysis window. */
  private pos = 0;
  /** Start (in buf) of the previously used window; undefined before the first one. */
  private prev: number | undefined;
  /** Second half of the previous window, already windowed (overlap-add tail). */
  private tail: Float32Array;

  constructor(opts: TimeStretchOptions) {
    const ms = (v: number): number => Math.max(2, Math.round((v / 1000) * opts.sampleRate));
    this.n = ms(opts.windowMs ?? 40) & ~1;
    this.hs = this.n / 2;
    this.delta = ms(opts.searchMs ?? 10);
    this.win = new Float32Array(this.n);
    for (let i = 0; i < this.n; i++) this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / this.n);
    this.tail = new Float32Array(this.hs);
  }

  /** True while input is buffered that only flush() (or more input) will release. */
  get pending(): boolean {
    return this.len > 0;
  }

  /** Adds input and returns the output it releases (may be empty). `tempo` ≥ 1 speeds up. */
  process(input: Float32Array, tempo: number): Float32Array {
    this.append(input);
    const t = Number.isFinite(tempo) && tempo > 0 ? tempo : 1;
    const out: Float32Array[] = [];
    for (;;) {
      const ideal = Math.round(this.pos);
      const lo = this.prev === undefined ? ideal : Math.max(0, ideal - this.delta);
      const hi = this.prev === undefined ? ideal : ideal + this.delta;
      const need = Math.max(hi + this.n, this.prev === undefined ? 0 : this.prev + this.hs + this.n);
      if (this.len < need) break;
      const start = this.prev === undefined ? ideal : this.bestStart(lo, hi, ideal);
      out.push(this.emit(start));
      this.prev = start;
      this.pos += this.hs * t;
      this.trim();
    }
    return concat(out);
  }

  /**
   * Returns everything still buffered and resets. The tail of the last window crossfades
   * exactly into the input that follows it, so the result continues seamlessly at tempo 1.
   */
  flush(): Float32Array {
    let out: Float32Array;
    if (this.prev === undefined) {
      out = this.buf.slice(Math.round(this.pos), this.len);
    } else {
      // tail = x[prev+hs .. prev+n) · w[hs..n); adding x[...]·w[0..hs) restores x exactly.
      out = this.buf.slice(this.prev + this.hs, this.len);
    }
    this.reset();
    return out;
  }

  reset(): void {
    this.buf = new Float32Array(0);
    this.len = 0;
    this.pos = 0;
    this.prev = undefined;
    this.tail = new Float32Array(this.hs);
  }

  /** Window start in [lo, hi] most similar to the natural continuation of the previous one. */
  private bestStart(lo: number, hi: number, ideal: number): number {
    const ref = (this.prev as number) + this.hs;
    const L = this.hs;
    const score = (s: number): number => {
      let dot = 0;
      let e = 1e-9;
      for (let i = 0; i < L; i += 2) {
        const a = this.buf[s + i]!;
        dot += a * this.buf[ref + i]!;
        e += a * a;
      }
      return dot / Math.sqrt(e);
    };
    // Coarse pass, then refine around the winner.
    let best = ideal;
    let bestScore = score(ideal);
    for (let s = lo; s <= hi; s += 4) {
      const v = score(s);
      if (v > bestScore) {
        bestScore = v;
        best = s;
      }
    }
    for (let s = Math.max(lo, best - 3); s <= Math.min(hi, best + 3); s++) {
      const v = score(s);
      if (v > bestScore) {
        bestScore = v;
        best = s;
      }
    }
    return best;
  }

  /** Overlap-adds the window at `start`; returns hs finished output samples. */
  private emit(start: number): Float32Array {
    const out = new Float32Array(this.hs);
    const nextTail = new Float32Array(this.hs);
    // The first window has nothing to overlap: its first half goes out unwindowed instead of
    // fading in (the start of an utterance must not be attenuated).
    const first = this.prev === undefined;
    for (let i = 0; i < this.hs; i++) {
      const x = this.buf[start + i]!;
      out[i] = first ? x : this.tail[i]! + x * this.win[i]!;
      nextTail[i] = this.buf[start + this.hs + i]! * this.win[this.hs + i]!;
    }
    this.tail = nextTail;
    return out;
  }

  private append(input: Float32Array): void {
    if (input.length === 0) return;
    if (this.len + input.length > this.buf.length) {
      const next = new Float32Array(Math.max(this.len + input.length, this.buf.length * 2, 4096));
      next.set(this.buf.subarray(0, this.len));
      this.buf = next;
    }
    this.buf.set(input, this.len);
    this.len += input.length;
  }

  /** Drops input that no future window can reach. */
  private trim(): void {
    const keepFrom = Math.min(
      this.prev ?? Infinity,
      Math.floor(this.pos) - this.delta,
    );
    if (keepFrom <= 0 || keepFrom < this.n * 4) return;
    this.buf.copyWithin(0, keepFrom, this.len);
    this.len -= keepFrom;
    this.pos -= keepFrom;
    if (this.prev !== undefined) this.prev -= keepFrom;
  }
}

function concat(parts: Float32Array[]): Float32Array {
  if (parts.length === 1) return parts[0]!;
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Float32Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
