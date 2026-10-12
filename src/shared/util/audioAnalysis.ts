/**
 * Pure (DOM-free) audio analysis helpers used by the offscreen renderer: level metering,
 * frame batching and a silence gate. Kept here so they can be unit-tested in Node.
 *
 * All levels are dBFS (full scale = 1.0), floored at DB_FLOOR so they stay finite and
 * serializable over IPC.
 */

export const DB_FLOOR = -120;

export interface AudioLevel {
  /** RMS in dBFS, floored at DB_FLOOR. */
  rmsDb: number;
  /** Peak absolute sample in dBFS, floored at DB_FLOOR. */
  peakDb: number;
  /** True when every sample was exactly 0 (nothing at all feeds the device). */
  digitalSilence: boolean;
}

/** Linear amplitude → dBFS, floored. Non-finite / non-positive input maps to the floor. */
export function toDb(amplitude: number): number {
  if (!(amplitude > 0) || !Number.isFinite(amplitude)) return DB_FLOOR;
  return Math.max(DB_FLOOR, 20 * Math.log10(amplitude));
}

/** Running sums for one measurement window. NaN/±Infinity samples count as 0. */
class LevelAccumulator {
  sumSq = 0;
  peak = 0;
  count = 0;
  allZero = true;

  add(samples: Float32Array, from = 0, to = samples.length): void {
    for (let i = from; i < to; i++) {
      let v = samples[i]!;
      if (!Number.isFinite(v)) v = 0;
      if (v !== 0) this.allZero = false;
      const a = Math.abs(v);
      if (a > this.peak) this.peak = a;
      this.sumSq += v * v;
    }
    this.count += to - from;
  }

  level(): AudioLevel {
    const rms = this.count > 0 ? Math.sqrt(this.sumSq / this.count) : 0;
    return { rmsDb: toDb(rms), peakDb: toDb(this.peak), digitalSilence: this.allZero };
  }

  reset(): void {
    this.sumSq = 0;
    this.peak = 0;
    this.count = 0;
    this.allZero = true;
  }
}

/** Level of one buffer. An empty buffer reads as digital silence at the floor. */
export function computeLevel(samples: Float32Array): AudioLevel {
  const acc = new LevelAccumulator();
  acc.add(samples);
  return acc.level();
}

/**
 * Accumulates small blocks (the AudioWorklet emits 128 samples per render quantum) into
 * fixed-size frames. At 24 kHz a 960-sample frame is 40 ms, which cuts the per-chunk IPC
 * + base64 overhead ~7x versus forwarding every render quantum.
 */
export class FrameBatcher {
  private buf: Float32Array;
  private fill = 0;

  constructor(readonly frameSize = 960) {
    if (!Number.isInteger(frameSize) || frameSize <= 0) {
      throw new Error(`FrameBatcher: invalid frameSize ${frameSize}`);
    }
    this.buf = new Float32Array(frameSize);
  }

  /** Adds a block; returns every frame completed by it (possibly none). */
  push(block: Float32Array): Float32Array[] {
    const out: Float32Array[] = [];
    let offset = 0;
    while (offset < block.length) {
      const n = Math.min(this.frameSize - this.fill, block.length - offset);
      this.buf.set(block.subarray(offset, offset + n), this.fill);
      this.fill += n;
      offset += n;
      if (this.fill === this.frameSize) {
        out.push(this.buf);
        // Hand the full frame out and start a fresh one (no copy, no aliasing).
        this.buf = new Float32Array(this.frameSize);
        this.fill = 0;
      }
    }
    return out;
  }

  /** Returns the partial frame accumulated so far (or null if empty) and clears it. */
  flush(): Float32Array | null {
    if (this.fill === 0) return null;
    const out = this.buf.slice(0, this.fill);
    this.fill = 0;
    return out;
  }
}

/**
 * Gate limits (dBFS, 40 ms frame RMS). The adaptive threshold sits GATE_MARGIN_DB above the
 * estimated noise floor, clamped to [GATE_MIN_THRESHOLD_DB, GATE_MAX_THRESHOLD_DB]. Speech
 * whose RMS stays below GATE_MAX_THRESHOLD_DB may therefore be dropped on a noisy line —
 * diagnostics warn below that level (see DIAG in src/main/health/diagnostics.ts).
 */
export const GATE_MIN_THRESHOLD_DB = -60;
export const GATE_MAX_THRESHOLD_DB = -45;
export const GATE_MARGIN_DB = 12;

export interface SilenceGateOptions {
  sampleRate: number;
  /**
   * Fixed threshold: frame RMS at/above this opens the gate. When omitted the threshold
   * adapts to the noise floor (see GATE_* constants).
   */
  thresholdDb?: number;
  /** How long the gate stays open after the last loud frame. */
  hangoverMs?: number;
  /** Quiet audio buffered while closed and released first when the gate opens. */
  preRollMs?: number;
  /**
   * Digital silence emitted after the gate closes. The streaming translation endpoint is
   * clocked by input audio: without a short tail it can hold the last words of an
   * utterance until the next speech onset. Exact zeros don't trigger hallucinations the
   * way line noise does. Default 0 (off).
   */
  tailMs?: number;
  /** Max rise speed of the noise-floor estimate (adaptive mode). Falls instantly. */
  floorRiseDbPerS?: number;
}

/**
 * Drops near-silent audio before it reaches the translation model. Feeding long silence
 * (or line noise) makes the model hallucinate filler phrases and is billed as audio time.
 *
 * - Opens when a frame's RMS >= threshold, emitting the buffered pre-roll first so word
 *   onsets (which start below the threshold) are not clipped.
 * - Stays open for hangoverMs after the last loud frame so word endings and a short
 *   trailing silence still reach the server-side VAD (which needs it to end the turn).
 * - On closing, emits tailMs of zeros so the server flushes the end of the utterance.
 * - Otherwise frames are held in the pre-roll ring and eventually dropped.
 *
 * Adaptive threshold: a slow-rising / instantly-falling noise-floor estimate + a margin,
 * so a quiet but clean source (low Windows/app volume, distant laptop mic) still opens the
 * gate while a noisy line does not leak hiss into the model.
 */
export class SilenceGate {
  private readonly sampleRate: number;
  private readonly fixedThresholdDb: number | undefined;
  private readonly hangoverMs: number;
  private readonly preRollMs: number;
  private readonly tailMs: number;
  private readonly floorRiseDbPerS: number;
  private open = false;
  private quietMs = 0;
  private tailLeftMs = 0;
  private preRoll: Float32Array[] = [];
  private preRollDurMs = 0;
  /** Noise floor estimate (dBFS); starts low so the threshold starts at its minimum. */
  private floorDb = GATE_MIN_THRESHOLD_DB - GATE_MARGIN_DB;
  /** Ms of real audio forwarded since the last takeOpenMs(). */
  private openMs = 0;

  constructor(opts: SilenceGateOptions) {
    if (!(opts.sampleRate > 0))
      throw new Error(`SilenceGate: invalid sampleRate ${opts.sampleRate}`);
    this.sampleRate = opts.sampleRate;
    this.fixedThresholdDb = opts.thresholdDb;
    this.hangoverMs = Math.max(0, opts.hangoverMs ?? 800);
    this.preRollMs = Math.max(0, opts.preRollMs ?? 300);
    this.tailMs = Math.max(0, opts.tailMs ?? 0);
    this.floorRiseDbPerS = Math.max(0, opts.floorRiseDbPerS ?? 1);
  }

  get isOpen(): boolean {
    return this.open;
  }

  /** Current opening threshold in dBFS. */
  get thresholdDb(): number {
    if (this.fixedThresholdDb !== undefined) return this.fixedThresholdDb;
    return Math.min(
      GATE_MAX_THRESHOLD_DB,
      Math.max(GATE_MIN_THRESHOLD_DB, this.floorDb + GATE_MARGIN_DB),
    );
  }

  /** Ms of real (non-tail) audio forwarded since the previous call; resets the counter. */
  takeOpenMs(): number {
    const ms = this.openMs;
    this.openMs = 0;
    return ms;
  }

  /** Returns the frames to forward, in order (may be empty). */
  process(frame: Float32Array): Float32Array[] {
    if (frame.length === 0) return [];
    const frameMs = (frame.length / this.sampleRate) * 1000;
    const level = computeLevel(frame);
    const loud = level.rmsDb >= this.thresholdDb;
    this.trackFloor(level, frameMs);

    if (loud) {
      this.quietMs = 0;
      this.tailLeftMs = 0;
      this.openMs += frameMs;
      if (this.open) return [frame];
      this.open = true;
      const out = this.preRoll;
      out.push(frame);
      this.preRoll = [];
      this.preRollDurMs = 0;
      return out;
    }

    if (this.open) {
      this.quietMs += frameMs;
      if (this.quietMs <= this.hangoverMs) {
        this.openMs += frameMs;
        return [frame];
      }
      this.open = false;
      this.quietMs = 0;
      this.tailLeftMs = this.tailMs;
    }
    this.bufferPreRoll(frame, frameMs);
    if (this.tailLeftMs > 0) {
      this.tailLeftMs -= frameMs;
      return [new Float32Array(frame.length)];
    }
    return [];
  }

  reset(): void {
    this.open = false;
    this.quietMs = 0;
    this.tailLeftMs = 0;
    this.preRoll = [];
    this.preRollDurMs = 0;
    this.openMs = 0;
  }

  private trackFloor(level: AudioLevel, frameMs: number): void {
    // Exact zeros say nothing about the line noise (the call app writes them between
    // talkers); keep the previous estimate.
    if (level.digitalSilence) return;
    if (level.rmsDb < this.floorDb) {
      this.floorDb = level.rmsDb;
    } else {
      this.floorDb = Math.min(level.rmsDb, this.floorDb + (this.floorRiseDbPerS * frameMs) / 1000);
    }
  }

  private bufferPreRoll(frame: Float32Array, frameMs: number): void {
    if (this.preRollMs <= 0) return;
    this.preRoll.push(frame);
    this.preRollDurMs += frameMs;
    // Keep the newest frames covering at most preRollMs.
    while (this.preRoll.length > 0 && this.preRollDurMs > this.preRollMs) {
      const dropped = this.preRoll.shift()!;
      this.preRollDurMs -= (dropped.length / this.sampleRate) * 1000;
    }
  }
}

export interface LevelMeterOptions {
  sampleRate: number;
  /** One report per this many ms of audio. */
  windowMs?: number;
  onReport: (level: AudioLevel) => void;
}

/**
 * Emits one AudioLevel per window of audio (by sample count, not wall clock, so it is
 * deterministic). digitalSilence is true only if ALL samples of the window were 0.
 */
export class LevelMeter {
  private readonly windowSamples: number;
  private readonly onReport: (level: AudioLevel) => void;
  private readonly acc = new LevelAccumulator();

  constructor(opts: LevelMeterOptions) {
    if (!(opts.sampleRate > 0))
      throw new Error(`LevelMeter: invalid sampleRate ${opts.sampleRate}`);
    const windowMs = opts.windowMs ?? 500;
    this.windowSamples = Math.max(1, Math.round((opts.sampleRate * windowMs) / 1000));
    this.onReport = opts.onReport;
  }

  push(samples: Float32Array): void {
    let offset = 0;
    while (offset < samples.length) {
      const n = Math.min(this.windowSamples - this.acc.count, samples.length - offset);
      this.acc.add(samples, offset, offset + n);
      offset += n;
      if (this.acc.count >= this.windowSamples) this.emit();
    }
  }

  /** Reports the partial window (if any samples were seen) and starts a new one. */
  flush(): void {
    if (this.acc.count > 0) this.emit();
  }

  private emit(): void {
    const level = this.acc.level();
    this.acc.reset();
    this.onReport(level);
  }
}
