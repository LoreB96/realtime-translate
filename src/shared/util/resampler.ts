/**
 * Streaming sample-rate converter (pure, no DOM / Node APIs).
 *
 * Pipeline per input sample: Blackman-windowed sinc low-pass FIR (anti-alias, at the input
 * rate, cutoff `0.4 * min(from, to)`), then linear interpolation at a fractional read position
 * that advances by `from / to` per output sample. Filter history and read position are carried
 * across `process()` calls, so arbitrary block sizes produce a continuous stream whose long-run
 * length is `floor(totalIn * to / from) ± 1`.
 */
export class Resampler {
  private readonly identity: boolean;
  private readonly kernel: Float32Array;
  /** Ring of the last `taps` raw input samples; `head` is the next write slot. */
  private readonly history: Float32Array;
  private head = 0;
  /** Input samples consumed per output sample. */
  private readonly step: number;
  /** Last filtered sample of the previous block (virtual local index 0). */
  private prevFiltered = 0;
  /**
   * Read position for the next output sample, in the local coordinates of the next block,
   * where index 0 is `prevFiltered` and index `i + 1` is the block's i-th filtered sample.
   */
  private pos = 1;

  constructor(fromRate: number, toRate: number, taps = 64) {
    if (!Number.isFinite(fromRate) || fromRate <= 0) {
      throw new RangeError(`Resampler: invalid fromRate ${fromRate}`);
    }
    if (!Number.isFinite(toRate) || toRate <= 0) {
      throw new RangeError(`Resampler: invalid toRate ${toRate}`);
    }
    if (!Number.isInteger(taps) || taps < 1) {
      throw new RangeError(`Resampler: invalid taps ${taps}`);
    }
    this.identity = fromRate === toRate;
    this.step = fromRate / toRate;
    this.kernel = Resampler.designKernel(taps, (0.4 * Math.min(fromRate, toRate)) / fromRate);
    this.history = new Float32Array(taps);
  }

  /** Resampled samples for this block (length varies); state kept across calls. */
  process(input: Float32Array): Float32Array {
    if (this.identity) return new Float32Array(input);
    const n = input.length;
    if (n === 0) return new Float32Array(0);

    const filtered = this.filter(input);

    // Local index 0 = prevFiltered, local index i + 1 = filtered[i]; last valid index is n.
    const out: number[] = [];
    let pos = this.pos;
    while (Math.floor(pos) + 1 <= n) {
      const i = Math.floor(pos);
      const frac = pos - i;
      const a = i === 0 ? this.prevFiltered : (filtered[i - 1] ?? 0);
      const b = filtered[i] ?? 0;
      out.push(a + (b - a) * frac);
      pos += this.step;
    }
    this.pos = pos - n;
    this.prevFiltered = filtered[n - 1] ?? 0;
    return Float32Array.from(out);
  }

  private filter(input: Float32Array): Float32Array {
    const taps = this.kernel.length;
    const hist = this.history;
    const kernel = this.kernel;
    const out = new Float32Array(input.length);
    let head = this.head;
    for (let j = 0; j < input.length; j++) {
      hist[head] = input[j] ?? 0;
      head = (head + 1) % taps;
      // Newest sample sits at head - 1; kernel[k] multiplies x[n - k].
      let acc = 0;
      let idx = head;
      for (let k = taps - 1; k >= 0; k--) {
        // idx walks oldest → newest, kernel walks k = taps-1 → 0.
        acc += (kernel[k] ?? 0) * (hist[idx] ?? 0);
        idx = idx + 1 === taps ? 0 : idx + 1;
      }
      out[j] = acc;
    }
    this.head = head;
    return out;
  }

  /** Blackman-windowed sinc low-pass, unity DC gain. `fc` in cycles per input sample. */
  private static designKernel(taps: number, fc: number): Float32Array {
    const h = new Float32Array(taps);
    if (taps === 1) {
      h[0] = 1;
      return h;
    }
    const m = taps - 1;
    let sum = 0;
    for (let k = 0; k < taps; k++) {
      const x = k - m / 2;
      const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
      const w =
        0.42 - 0.5 * Math.cos((2 * Math.PI * k) / m) + 0.08 * Math.cos((4 * Math.PI * k) / m);
      const v = sinc * w;
      h[k] = v;
      sum += v;
    }
    for (let k = 0; k < taps; k++) h[k] = (h[k] ?? 0) / sum;
    return h;
  }
}
