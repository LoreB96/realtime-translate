import {
  startCapture,
  startPlayback,
  startPassthrough,
  listDevices,
  measureInput,
  playTone,
  type CaptureHandle,
  type PassthroughHandle,
  type PlaybackHandle,
  type StreamHooks,
} from './webAudioBridge';
import { float32ToPcm16Base64 } from '@shared/util/pcmCodec';
import type {
  OffscreenAssistantApi,
  OffscreenPreloadBridge,
  OffscreenWindowApi,
  TapMode,
  TapOptions,
} from '@shared/offscreenContract';

type OffscreenApi = OffscreenWindowApi & OffscreenAssistantApi;

declare global {
  interface Window {
    offscreen: OffscreenApi;
    offscreenBridge?: OffscreenPreloadBridge;
  }
}

/** Debounce for navigator.mediaDevices 'devicechange' (Windows fires bursts per endpoint). */
const DEVICE_CHANGE_DEBOUNCE_MS = 500;

const captures = new Map<string, CaptureHandle>();
const playbacks = new Map<string, PlaybackHandle>();
/** Passthrough PCM taps by stream id (spec §7.1). Survive stop/restart of the stream. */
const passthroughs = new Map<string, PassthroughHandle>();
const taps = new Map<string, { mode: TapMode; opts: TapOptions }>();

/**
 * Start/stop race guard. Every start bumps the generation for its slot and every stop
 * bumps it too; a start that finishes awaiting getUserMedia/setSinkId after its generation
 * moved on (stopStream / stopAll / a newer start ran meanwhile) stops the handle it just
 * created instead of storing it, so no device stays open behind main's back.
 * Capture and playback use separate slots because translation stream 'A' has both.
 */
const generations = new Map<string, number>();
const capKey = (streamId: string): string => `cap:${streamId}`;
const playKey = (streamId: string): string => `play:${streamId}`;

function bump(key: string): number {
  const next = (generations.get(key) ?? 0) + 1;
  generations.set(key, next);
  return next;
}

/** Runs `create` for a slot; stores the result only if the slot was not superseded. */
async function startInSlot<H extends { stop(): void }>(
  map: Map<string, H>,
  key: string,
  streamId: string,
  create: () => Promise<H>,
): Promise<void> {
  const gen = bump(key);
  const prev = map.get(streamId);
  map.delete(streamId);
  prev?.stop();
  const handle = await create();
  if (generations.get(key) !== gen) {
    handle.stop();
    return;
  }
  map.set(streamId, handle);
}

function hooksFor(streamId: string, withLevel: boolean): StreamHooks {
  const bridge = window.offscreenBridge;
  return {
    ...(withLevel
      ? {
          onLevel: (l) =>
            bridge?.sendLevel({
              streamId,
              rmsDb: l.rmsDb,
              peakDb: l.peakDb,
              digitalSilence: l.digitalSilence,
              ...(l.gateOpenMs !== undefined ? { gateOpenMs: l.gateOpenMs } : {}),
            }),
        }
      : {}),
    // side tells main which device of the stream the event is about (a playback
    // context's suspension concerns the output device, not the capture's input).
    onEvent: (kind, detail, side) =>
      bridge?.sendStreamEvent({
        streamId,
        kind,
        ...(side !== undefined ? { side } : {}),
        ...(detail !== undefined ? { detail: detail.slice(0, 500) } : {}),
      }),
  };
}

function safeStop(h: { stop(): void } | undefined): void {
  try {
    h?.stop();
  } catch {
    /* swallow — teardown must not leak the remaining handles */
  }
}

/** Tap modes this build implements (M7 appends 'local16k'). */
const TAP_MODES: readonly TapMode[] = ['off', 'main24k'];

/** Applies the stored tap of `streamId` to its running passthrough, if any. Synchronous. */
function applyTap(streamId: string): void {
  const handle = passthroughs.get(streamId);
  if (!handle || captures.get(streamId) !== handle) return;
  const mode: TapMode = taps.get(streamId)?.mode ?? 'off';
  switch (mode) {
    case 'main24k':
      handle.setTap({
        rate: 24000,
        onFrame: (f) => window.offscreenBridge?.sendPcm(streamId, float32ToPcm16Base64(f)),
      });
      return;
    case 'off':
      handle.setTap(null);
      return;
    default: {
      // M7 adds 'local16k': the compiler flags this switch when TapMode widens.
      const unreachable: never = mode;
      throw new Error(`unknown tap mode ${String(unreachable)}`);
    }
  }
}

const api: OffscreenApi = {
  async listDevices() {
    const devs = await listDevices();
    return devs.map((d) => ({ deviceId: d.deviceId, label: d.label, kind: d.kind }));
  },
  async startCapture(streamId, micDeviceId) {
    passthroughs.delete(streamId); // a translation capture replaces any passthrough in the slot
    await startInSlot(captures, capKey(streamId), streamId, () =>
      startCapture(
        micDeviceId,
        (b64) => {
          window.offscreenBridge?.sendPcm(streamId, b64);
        },
        hooksFor(streamId, true),
      ),
    );
  },
  async startPlayback(streamId, outDeviceId) {
    await startInSlot(playbacks, playKey(streamId), streamId, () =>
      startPlayback(outDeviceId, hooksFor(streamId, false)),
    );
  },
  async startPlaybackWithOptions(streamId, outDeviceId, opts) {
    // Same slot logic as startPlayback: any id works ('tts', 'tts-mon' run alongside 'A'/'B').
    await startInSlot(playbacks, playKey(streamId), streamId, () =>
      startPlayback(outDeviceId, hooksFor(streamId, false), opts),
    );
  },
  async startPassthrough(streamId, inDeviceId, outDeviceId) {
    // Kept in `captures` so stopStream/stopAll release it like any capture; also indexed in
    // `passthroughs` so its PCM tap can be switched without restarting the route.
    passthroughs.delete(streamId);
    let created: PassthroughHandle | undefined;
    await startInSlot(captures, capKey(streamId), streamId, async () => {
      created = await startPassthrough(inDeviceId, outDeviceId, hooksFor(streamId, true));
      return created;
    });
    // Superseded by a stop or a newer start: startInSlot already stopped `created`.
    if (!created || captures.get(streamId) !== created) return;
    passthroughs.set(streamId, created);
    applyTap(streamId);
  },
  setPassthroughTap(streamId, mode, opts) {
    // Called via executeJavaScript: never store a mode this build can't apply, or every
    // later startPassthrough of this stream would fail in applyTap.
    if (!TAP_MODES.includes(mode)) return Promise.reject(new Error(`unknown tap mode ${mode}`));
    if (mode === 'off') taps.delete(streamId);
    else taps.set(streamId, { mode, opts: opts ?? {} });
    applyTap(streamId);
    return Promise.resolve();
  },
  pushPlayback(streamId, base64) {
    playbacks.get(streamId)?.push(base64);
  },
  stopStream(streamId) {
    bump(capKey(streamId));
    bump(playKey(streamId));
    safeStop(captures.get(streamId));
    safeStop(playbacks.get(streamId));
    captures.delete(streamId);
    playbacks.delete(streamId);
    // `taps` is kept on purpose: a restarted passthrough re-applies its tap.
    passthroughs.delete(streamId);
  },
  stopAll() {
    // Invalidate every slot, including starts still awaiting a device.
    for (const key of generations.keys()) bump(key);
    // Best-effort teardown — swallow per-handle errors so one stuck handle
    // doesn't leak the rest. App-shutdown path: defensive cleanup matters most here.
    for (const c of captures.values()) safeStop(c);
    for (const p of playbacks.values()) safeStop(p);
    captures.clear();
    playbacks.clear();
    passthroughs.clear();
  },
  async runLoopback(deviceId, thresholdRms, timeoutMs) {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: { exact: deviceId },
        sampleRate: 24000,
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    const ctx = new AudioContext({ sampleRate: 24000 });
    try {
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      const buf = new Float32Array(analyser.fftSize);
      const startedAt = Date.now();
      let detected = false;
      while (Date.now() - startedAt < timeoutMs) {
        analyser.getFloatTimeDomainData(buf);
        let sumSq = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = buf[i] ?? 0; // noUncheckedIndexedAccess guard
          sumSq += v * v;
        }
        const rms = Math.sqrt(sumSq / buf.length);
        if (rms > thresholdRms) {
          detected = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      return { detected };
    } finally {
      stream.getTracks().forEach((t) => t.stop());
      void ctx.close();
    }
  },
  measureInput(deviceId, ms) {
    return measureInput(deviceId, ms);
  },
  playTone(deviceId, ms, frequencyHz, gainDb) {
    return playTone(deviceId, ms, frequencyHz, gainDb);
  },
};

/**
 * Main calls this API through executeJavaScript, which can't serialize a DOMException
 * (getUserMedia/setSinkId failures) — main would only see "[object Object]". Re-throw
 * every rejection as a plain Error carrying "Name: message".
 */
function toTransferableError(err: unknown): Error {
  if (err instanceof Error || err instanceof DOMException) {
    return new Error(err.message ? `${err.name}: ${err.message}` : err.name);
  }
  return new Error(String(err));
}

window.offscreen = Object.fromEntries(
  Object.entries(api).map(([name, fn]) => [
    name,
    (...args: unknown[]): unknown => {
      try {
        const out = (fn as (...a: unknown[]) => unknown)(...args);
        return out instanceof Promise
          ? out.catch((err: unknown) => {
              throw toTransferableError(err);
            })
          : out;
      } catch (err) {
        throw toTransferableError(err);
      }
    },
  ]),
) as unknown as OffscreenApi;

if (!window.offscreenBridge) {
  // eslint-disable-next-line no-console
  console.error(
    'OffscreenBridge not installed. Did the preload script run? Captured audio will not reach main process.',
  );
} else {
  window.offscreenBridge.onPushPlayback((streamId, base64) => {
    window.offscreen.pushPlayback(streamId, base64);
  });

  // Hot-plug detection (headset unplugged, VB-Cable driver restarted). Main decides
  // whether to re-run detection / restart passthrough.
  let deviceChangeTimer: ReturnType<typeof setTimeout> | undefined;
  navigator.mediaDevices.addEventListener('devicechange', () => {
    if (deviceChangeTimer !== undefined) clearTimeout(deviceChangeTimer);
    deviceChangeTimer = setTimeout(() => {
      deviceChangeTimer = undefined;
      window.offscreenBridge?.sendDeviceChange();
    }, DEVICE_CHANGE_DEBOUNCE_MS);
  });
}
