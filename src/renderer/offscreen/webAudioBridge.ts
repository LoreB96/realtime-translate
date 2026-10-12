import { float32ToPcm16Base64, pcm16Base64ToFloat32 } from '@shared/util/pcmCodec';
import { FrameBatcher, LevelMeter, SilenceGate, type AudioLevel } from '@shared/util/audioAnalysis';
import { Resampler } from '@shared/util/resampler';
import type { InputMeasurement, PlaybackOptions, StreamEventKind } from '@shared/offscreenContract';

export interface CaptureHandle {
  stop(): void;
}

/**
 * PCM tap on a passthrough input (spec §7.1): mono Float32 frames at `rate`, 40 ms each,
 * silence-gated. M7 widens `rate` to `16000 | 24000`.
 */
export interface PcmTap {
  rate: 24000;
  onFrame(f: Float32Array): void;
}

/** Passthrough handle whose PCM tap can be switched at runtime without touching the route. */
export interface PassthroughHandle extends CaptureHandle {
  setTap(t: PcmTap | null): void;
}

export interface PlaybackHandle {
  push(base64Pcm16: string): void;
  stop(): void;
}

/** Level of one report window; gateOpenMs only for translation captures (see LevelReport). */
export type StreamLevel = AudioLevel & { gateOpenMs?: number };

/** Which device of a stream an event concerns (see StreamEvent.side). */
export type StreamSide = 'input' | 'output';

/** Health callbacks for one stream. Never carry audio content — levels and states only. */
export interface StreamHooks {
  onLevel?(level: StreamLevel): void;
  onEvent?(kind: StreamEventKind, detail?: string, side?: StreamSide): void;
}

const MODEL_SAMPLE_RATE = 24000;
/** How long a suspended context may stay non-running (after resume()) before we report it. */
const SUSPEND_GRACE_MS = 1000;
/**
 * Playback backlog control. Translated speech often runs longer than the source and
 * arrives in bursts, so a backlog of a few seconds is normal: above CATCHUP_BACKLOG_S new
 * chunks play slightly faster (barely audible) until it drains; only a backlog above
 * MAX_PLAYBACK_BACKLOG_S (stalled device, long suspension) drops the queue.
 */
const CATCHUP_BACKLOG_S = 1;
const CATCHUP_RATE = 1.06;
const MAX_PLAYBACK_BACKLOG_S = 6;
/** Zeros sent after the gate closes so the model flushes the end of an utterance. */
const GATE_TAIL_MS = 1500;
/** Default test-tone level: clearly audible on a meter, not painful on a headset. */
const DEFAULT_TONE_DB = -12;
const TONE_FADE_S = 0.02;
/** PCM tap gate (spec §7.1): short hangover, short zero tail to flush the STT turn. */
const TAP_HANGOVER_MS = 400;
const TAP_TAIL_MS = 500;
const TAP_FRAME_S = 0.04;

/**
 * Builds the tap chain `Resampler(fromRate → tap.rate) → FrameBatcher(40 ms) → SilenceGate →
 * tap.onFrame`. Returns the per-block push function. Pure (no DOM), so it is unit-testable.
 */
export function createPcmTapChain(fromRate: number, tap: PcmTap): (block: Float32Array) => void {
  const resampler = new Resampler(fromRate, tap.rate);
  const batcher = new FrameBatcher(Math.round(tap.rate * TAP_FRAME_S));
  const gate = new SilenceGate({
    sampleRate: tap.rate,
    hangoverMs: TAP_HANGOVER_MS,
    tailMs: TAP_TAIL_MS,
  });
  return (block) => {
    const resampled = resampler.process(block);
    if (resampled.length === 0) return;
    for (const frame of batcher.push(resampled)) {
      for (const out of gate.process(frame)) tap.onFrame(out);
    }
  };
}

type SinkAudioContext = AudioContext & { setSinkId?: (id: string) => Promise<void> };

async function setSink(ctx: AudioContext, deviceId: string): Promise<void> {
  const ctxAny = ctx as SinkAudioContext;
  if (typeof ctxAny.setSinkId !== 'function') {
    throw new Error('AudioContext.setSinkId is not supported in this Electron build');
  }
  await ctxAny.setSinkId(deviceId);
}

function openInput(deviceId: string, sampleRate?: number): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: { exact: deviceId },
      ...(sampleRate ? { sampleRate: { ideal: sampleRate } } : {}),
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  });
}

function stopTracks(stream: MediaStream): void {
  stream.getTracks().forEach((t) => t.stop());
}

/** Creates the pcm-encoder worklet node (128-sample Float32 blocks via port messages). */
async function createEncoderNode(ctx: AudioContext): Promise<AudioWorkletNode> {
  // Vite's ?url import produces a real asset URL pointing to a built JS file.
  // Without ?url, Vite would inline the source (TypeScript) as a data: URI.
  const workletUrl = (await import('./workers/pcmEncoder.worklet.js?url')).default;
  await ctx.audioWorklet.addModule(workletUrl);
  return new AudioWorkletNode(ctx, 'pcm-encoder');
}

/**
 * Watches an AudioContext for OS-driven suspension (device sleep, audio service restart,
 * Bluetooth profile switch). Tries resume() first; only reports 'context-suspended' if that
 * fails or the context is still not running after SUSPEND_GRACE_MS. Reports
 * 'context-resumed' once it runs again after a reported suspension. Returns a disposer.
 */
function watchContextState(
  ctx: AudioContext,
  hooks: StreamHooks | undefined,
  side: StreamSide,
): () => void {
  let disposed = false;
  let reported = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const report = (detail: string): void => {
    if (disposed || reported) return;
    reported = true;
    hooks?.onEvent?.('context-suspended', detail, side);
  };
  const clearTimer = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };

  const onStateChange = (): void => {
    if (disposed) return;
    // 'interrupted' is not in every lib.dom version — compare as a string.
    const state = ctx.state as string;
    if (state === 'running') {
      clearTimer();
      if (reported) {
        reported = false;
        hooks?.onEvent?.('context-resumed', undefined, side);
      }
      return;
    }
    if (state !== 'suspended' && state !== 'interrupted') return; // 'closed' = our own stop
    ctx.resume().catch((err: unknown) => {
      report(`resume failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    if (timer === undefined) {
      timer = setTimeout(() => {
        timer = undefined;
        if (!disposed && (ctx.state as string) !== 'running') report(`state=${ctx.state}`);
      }, SUSPEND_GRACE_MS);
    }
  };

  // Chromium fires 'error' on an AudioContext whose output device failed or vanished
  // (newer builds only — a no-op elsewhere). Playback sinks have no track whose 'ended'
  // could tell us, so this is the only direct signal for a lost output.
  const onError = (): void => {
    if (!disposed) hooks?.onEvent?.('track-ended', 'audio-context-error', side);
  };

  ctx.addEventListener('statechange', onStateChange);
  ctx.addEventListener('error', onError);
  return () => {
    disposed = true;
    clearTimer();
    ctx.removeEventListener('statechange', onStateChange);
    ctx.removeEventListener('error', onError);
  };
}

/** Reports 'track-ended' when any input track ends on its own (unplugged / disabled). */
function watchTracks(stream: MediaStream, hooks: StreamHooks | undefined): () => void {
  const tracks = stream.getAudioTracks();
  const onEnded = (): void => hooks?.onEvent?.('track-ended', undefined, 'input');
  tracks.forEach((t) => t.addEventListener('ended', onEnded));
  return () => tracks.forEach((t) => t.removeEventListener('ended', onEnded));
}

/**
 * Captures a device for translation. Audio goes worklet → 40 ms frames → silence gate →
 * PCM16 base64, so near-silence never reaches the model (no hallucinated phrases, no cost).
 * Level reports use the UNGATED audio so diagnostics see what the device really delivers.
 */
export async function startCapture(
  micDeviceId: string,
  onPcmChunk: (base64: string) => void,
  hooks?: StreamHooks,
): Promise<CaptureHandle> {
  const stream = await openInput(micDeviceId, MODEL_SAMPLE_RATE);
  let ctx: AudioContext | undefined;
  const disposers: (() => void)[] = [];
  try {
    ctx = new AudioContext({ sampleRate: MODEL_SAMPLE_RATE });
    if (ctx.sampleRate !== MODEL_SAMPLE_RATE) {
      throw new Error(`AudioContext sampleRate=${ctx.sampleRate}, expected ${MODEL_SAMPLE_RATE}`);
    }
    const node = await createEncoderNode(ctx);
    const source = ctx.createMediaStreamSource(stream);
    const gate = new SilenceGate({ sampleRate: MODEL_SAMPLE_RATE, tailMs: GATE_TAIL_MS });
    // Each report also says how much of its window the gate let through, so main can tell
    // "source too quiet to translate" from "nobody is talking".
    const meter = new LevelMeter({
      sampleRate: MODEL_SAMPLE_RATE,
      onReport: (l) => hooks?.onLevel?.({ ...l, gateOpenMs: Math.round(gate.takeOpenMs()) }),
    });
    const batcher = new FrameBatcher(960);
    let stopped = false;
    node.port.onmessage = (e: MessageEvent<Float32Array>) => {
      if (stopped) return;
      const block = e.data;
      meter.push(block);
      for (const frame of batcher.push(block)) {
        for (const out of gate.process(frame)) onPcmChunk(float32ToPcm16Base64(out));
      }
    };
    source.connect(node);
    disposers.push(watchTracks(stream, hooks), watchContextState(ctx, hooks, 'input'));
    // The offscreen window is never shown; don't rely on the autoplay policy.
    await ctx.resume();
    const c = ctx;
    return {
      stop() {
        stopped = true;
        disposers.forEach((d) => d());
        node.port.onmessage = null;
        stopTracks(stream);
        source.disconnect();
        node.disconnect();
        void c.close();
      },
    };
  } catch (err) {
    disposers.forEach((d) => d());
    stopTracks(stream);
    if (ctx) void ctx.close();
    throw err;
  }
}

/**
 * Opens a 24 kHz playback stream on an output device. `opts` (spec §7.2) overrides the
 * backlog cap and disables catch-up; the defaults keep the translation behaviour
 * (MAX_PLAYBACK_BACKLOG_S, CATCHUP_RATE). TTS uses a long backlog and no catch-up because
 * its audio arrives faster than real time.
 */
export async function startPlayback(
  outputDeviceId: string,
  hooks?: StreamHooks,
  opts?: PlaybackOptions,
): Promise<PlaybackHandle> {
  const maxBacklogS =
    opts?.maxBacklogS !== undefined && Number.isFinite(opts.maxBacklogS) && opts.maxBacklogS > 0
      ? opts.maxBacklogS
      : MAX_PLAYBACK_BACKLOG_S;
  const catchupRate = opts?.catchup === false ? 1 : CATCHUP_RATE;
  const ctx = new AudioContext({ sampleRate: MODEL_SAMPLE_RATE });
  let dispose: (() => void) | undefined;
  try {
    // Defense-in-depth: AudioContext sampleRate is requested but not always honored.
    if (ctx.sampleRate !== MODEL_SAMPLE_RATE) {
      throw new Error(`AudioContext sampleRate=${ctx.sampleRate}, expected ${MODEL_SAMPLE_RATE}`);
    }
    await setSink(ctx, outputDeviceId);
    dispose = watchContextState(ctx, hooks, 'output');
    await ctx.resume();
  } catch (err) {
    dispose?.();
    void ctx.close();
    throw err;
  }

  // Write head: tracks where the next chunk should start so consecutive chunks
  // play sequentially instead of overlapping. Reset when ctx.currentTime catches up
  // (e.g., after a silence gap).
  let writeHead = 0;
  // Scheduled sources, so an over-long backlog can be cancelled.
  const scheduled = new Set<AudioBufferSourceNode>();
  let drops = 0;

  return {
    push(base64Pcm16: string): void {
      if (ctx.state === 'closed') return;
      if (ctx.state !== 'running') void ctx.resume().catch(() => undefined);
      const samples = pcm16Base64ToFloat32(base64Pcm16);
      if (samples.length === 0) return;
      // Latency guard: if more than MAX_PLAYBACK_BACKLOG_S is queued (stalled device,
      // suspended context), drop the stale queue so the listener hears current speech
      // instead of drifting further behind. Smaller backlogs catch up smoothly below.
      if (writeHead - ctx.currentTime > maxBacklogS) {
        for (const s of scheduled) {
          try {
            s.stop();
          } catch {
            /* not started yet / already stopped */
          }
        }
        scheduled.clear();
        writeHead = ctx.currentTime;
        drops += 1;
        // Counts only — never audio content.
        // eslint-disable-next-line no-console
        console.warn(`[offscreen] playback backlog over ${maxBacklogS} s dropped (drops=${drops})`);
      }
      const rate = writeHead - ctx.currentTime > CATCHUP_BACKLOG_S ? catchupRate : 1;
      const buffer = ctx.createBuffer(1, samples.length, MODEL_SAMPLE_RATE);
      buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.playbackRate.value = rate;
      src.connect(ctx.destination);
      src.onended = () => {
        scheduled.delete(src);
        src.disconnect();
      };
      const startAt = Math.max(ctx.currentTime, writeHead);
      src.start(startAt);
      scheduled.add(src);
      writeHead = startAt + samples.length / MODEL_SAMPLE_RATE / rate;
    },
    stop(): void {
      dispose?.();
      scheduled.clear();
      void ctx.close();
    },
  };
}

/**
 * Routes an input device straight to an output device, untranslated. Runs at the
 * context's native rate (no 24 kHz resampling) with the lowest latency hint — this is
 * a live call, not a model feed. The input is also tapped into a level meter so a silent
 * cable (e.g. the call app not sending audio) can be detected. An optional PCM tap
 * (`setTap`) feeds the same worklet blocks to a transcription sink; it never touches the route.
 */
export async function startPassthrough(
  inputDeviceId: string,
  outputDeviceId: string,
  hooks?: StreamHooks,
): Promise<PassthroughHandle> {
  const stream = await openInput(inputDeviceId);
  const ctx = new AudioContext({ latencyHint: 'interactive' });
  const disposers: (() => void)[] = [];
  try {
    await setSink(ctx, outputDeviceId);
    const source = ctx.createMediaStreamSource(stream);
    source.connect(ctx.destination);

    // Level tap. The worklet output is pulled through a zero-gain node so it is processed
    // without adding anything audible to the routed signal.
    const node = await createEncoderNode(ctx);
    const mute = ctx.createGain();
    mute.gain.value = 0;
    const meter = new LevelMeter({
      sampleRate: ctx.sampleRate,
      onReport: (l) => hooks?.onLevel?.(l),
    });
    let stopped = false;
    let tapPush: ((block: Float32Array) => void) | null = null;
    let tapWarned = false;
    node.port.onmessage = (e: MessageEvent<Float32Array>) => {
      if (stopped) return;
      meter.push(e.data);
      if (!tapPush) return;
      // A failing sink must never break the meter or the route: warn once, keep going.
      try {
        tapPush(e.data);
      } catch (err) {
        if (!tapWarned) {
          tapWarned = true;
          // Error name/message only — never audio content.
          // eslint-disable-next-line no-console
          console.warn(
            `[offscreen] passthrough tap failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    };
    source.connect(node);
    node.connect(mute);
    mute.connect(ctx.destination);

    // The context renders into the output device: its suspension / errors concern the
    // output side; a dead input shows up as 'track-ended' on the track.
    disposers.push(watchTracks(stream, hooks), watchContextState(ctx, hooks, 'output'));
    // The offscreen window is never shown; don't rely on the autoplay policy.
    await ctx.resume();
    return {
      setTap(t: PcmTap | null): void {
        if (stopped) return;
        // A fresh chain per tap: resampler/gate state never leaks between engines.
        tapPush = t ? createPcmTapChain(ctx.sampleRate, t) : null;
        tapWarned = false;
      },
      stop() {
        stopped = true;
        tapPush = null;
        disposers.forEach((d) => d());
        node.port.onmessage = null;
        stopTracks(stream);
        source.disconnect();
        node.disconnect();
        mute.disconnect();
        void ctx.close();
      },
    };
  } catch (err) {
    disposers.forEach((d) => d());
    stopTracks(stream);
    void ctx.close();
    throw err;
  }
}

/**
 * Diagnostics: records an input for `ms` and returns the loudest 100 ms RMS window plus
 * whether the device delivered pure digital zeros (e.g. a virtual cable nobody plays into).
 * Rejects if the device cannot be opened. Always releases the device and the context.
 */
export async function measureInput(deviceId: string, ms: number): Promise<InputMeasurement> {
  const durationMs = Math.min(30000, Math.max(100, Number.isFinite(ms) ? ms : 0));
  const stream = await openInput(deviceId);
  const ctx = new AudioContext();
  let node: AudioWorkletNode | undefined;
  try {
    node = await createEncoderNode(ctx);
    const source = ctx.createMediaStreamSource(stream);
    const mute = ctx.createGain();
    mute.gain.value = 0;
    let maxRmsDb = -Infinity;
    let digitalSilence = true;
    const meter = new LevelMeter({
      sampleRate: ctx.sampleRate,
      windowMs: 100,
      onReport: (l) => {
        maxRmsDb = Math.max(maxRmsDb, l.rmsDb);
        if (!l.digitalSilence) digitalSilence = false;
      },
    });
    node.port.onmessage = (e: MessageEvent<Float32Array>) => meter.push(e.data);
    source.connect(node);
    node.connect(mute);
    mute.connect(ctx.destination);
    await ctx.resume();
    await new Promise((r) => setTimeout(r, durationMs));
    node.port.onmessage = null;
    meter.flush();
    // No samples at all (context never ran) reads as floor + silence.
    return { maxRmsDb: Number.isFinite(maxRmsDb) ? maxRmsDb : -120, digitalSilence };
  } finally {
    if (node) node.port.onmessage = null;
    stopTracks(stream);
    void ctx.close();
  }
}

/**
 * Diagnostics: plays a sine tone on an output device (gainDb dBFS, default -12; 20 ms fades
 * so there is no click). Rejects if the output cannot be selected. Always closes the context.
 */
export async function playTone(
  deviceId: string,
  ms: number,
  frequencyHz: number,
  gainDb = DEFAULT_TONE_DB,
): Promise<void> {
  const durationS = Math.min(10000, Math.max(100, Number.isFinite(ms) ? ms : 0)) / 1000;
  const freq = Math.min(20000, Math.max(20, Number.isFinite(frequencyHz) ? frequencyHz : 440));
  // Clamp: never louder than -6 dBFS, whatever the caller passes.
  const db = Math.min(-6, Math.max(-60, Number.isFinite(gainDb) ? gainDb : DEFAULT_TONE_DB));
  const toneGain = Math.pow(10, db / 20);
  const ctx = new AudioContext();
  try {
    await setSink(ctx, deviceId);
    await ctx.resume();
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freq;
    const gain = ctx.createGain();
    const t0 = ctx.currentTime + 0.01;
    const t1 = t0 + durationS;
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(toneGain, t0 + TONE_FADE_S);
    gain.gain.setValueAtTime(toneGain, t1 - TONE_FADE_S);
    gain.gain.linearRampToValueAtTime(0, t1);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t0);
    osc.stop(t1);
    await new Promise((r) => setTimeout(r, durationS * 1000 + 60));
    osc.disconnect();
    gain.disconnect();
  } finally {
    void ctx.close();
  }
}

export async function listDevices(): Promise<MediaDeviceInfo[]> {
  // Labels are only exposed once media permission is in effect. When they already are
  // (permission granted, or a capture is running), skip getUserMedia: opening the default
  // mic forces Bluetooth headsets into hands-free mode, and device recovery calls this
  // repeatedly.
  const first = await navigator.mediaDevices.enumerateDevices();
  if (first.some((d) => d.label !== '')) return first;
  // Otherwise open briefly, then release. Leaving the stream open keeps the default mic
  // captured (AGC on, Bluetooth headsets stuck in hands-free mode) for the whole session.
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => undefined);
  try {
    return await navigator.mediaDevices.enumerateDevices();
  } finally {
    if (stream) stopTracks(stream);
  }
}
