/**
 * Contract between the main process and the hidden offscreen renderer (which owns all
 * Web Audio work). Main validates every payload with the guards below before use —
 * the offscreen window is ours, but IPC payloads are still untrusted input.
 */

/** Offscreen <-> main IPC channels. */
export const OFFSCREEN_IPC = {
  /** Offscreen → main (ipcRenderer.send / ipcMain.on). */
  Pcm: 'offscreen:pcm',
  Level: 'offscreen:level',
  StreamEvent: 'offscreen:streamEvent',
  DeviceChange: 'offscreen:deviceChange',
  /** Main → offscreen (webContents.send). */
  PushPlayback: 'offscreen:pushPlayback',
} as const;

/** Periodic input level of one capture stream (translation or passthrough), ~every 500 ms. */
export interface LevelReport {
  streamId: string;
  /** RMS over the window in dBFS (-Infinity clamped to -120). */
  rmsDb: number;
  /** Peak absolute sample over the window in dBFS (clamped to -120). */
  peakDb: number;
  /** True when every sample in the window was exactly 0 (nothing feeds the device). */
  digitalSilence: boolean;
  /**
   * Translation captures only: ms of this window the silence gate let through to the
   * model. 0 while the source has signal means it is too quiet to be translated.
   */
  gateOpenMs?: number;
}

export type StreamEventKind =
  /**
   * The input MediaStreamTrack ended (device unplugged / disabled) or, with side
   * 'output', the output device reported an error.
   */
  | 'track-ended'
  /** An AudioContext went to 'suspended'/'interrupted' and resume() failed. */
  | 'context-suspended'
  /** A previously suspended AudioContext is running again. */
  | 'context-resumed';

export interface StreamEvent {
  streamId: string;
  kind: StreamEventKind;
  /**
   * Which device of the stream the event concerns. Omitted = 'input' (capture side).
   * Playback contexts and the passthrough's output context report 'output'.
   */
  side?: 'input' | 'output';
  detail?: string;
}

/** Result of measuring an input device for a fixed window (diagnostics). */
export interface InputMeasurement {
  /** Highest 100 ms RMS seen, in dBFS (-120 floor). */
  maxRmsDb: number;
  /** True when every sample during the whole window was exactly 0. */
  digitalSilence: boolean;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isShortStr = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= 64;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function isLevelReport(v: unknown): v is LevelReport {
  return (
    isObj(v) &&
    isShortStr(v.streamId) &&
    isNum(v.rmsDb) &&
    isNum(v.peakDb) &&
    typeof v.digitalSilence === 'boolean' &&
    (v.gateOpenMs === undefined || (isNum(v.gateOpenMs) && v.gateOpenMs >= 0))
  );
}

export function isStreamEvent(v: unknown): v is StreamEvent {
  return (
    isObj(v) &&
    isShortStr(v.streamId) &&
    (v.kind === 'track-ended' || v.kind === 'context-suspended' || v.kind === 'context-resumed') &&
    (v.side === undefined || v.side === 'input' || v.side === 'output') &&
    (v.detail === undefined || (typeof v.detail === 'string' && v.detail.length <= 500))
  );
}

/** Window API the offscreen renderer exposes (called from main via executeJavaScript). */
export interface OffscreenWindowApi {
  listDevices(): Promise<{ deviceId: string; label: string; kind: string }[]>;
  /** Capture for translation: 24 kHz mono PCM16 chunks, silence-gated, + level reports. */
  startCapture(streamId: string, micDeviceId: string): Promise<void>;
  startPlayback(streamId: string, outDeviceId: string): Promise<void>;
  /** Untranslated input → output routing, + level reports for the input. */
  startPassthrough(streamId: string, inDeviceId: string, outDeviceId: string): Promise<void>;
  pushPlayback(streamId: string, base64: string): void;
  stopStream(streamId: string): void;
  stopAll(): void;
  runLoopback(
    deviceId: string,
    thresholdRms: number,
    timeoutMs: number,
  ): Promise<{ detected: boolean }>;
  /** Diagnostics: measure an input for `ms` milliseconds. Rejects if the device can't open. */
  measureInput(deviceId: string, ms: number): Promise<InputMeasurement>;
  /**
   * Diagnostics: play a sine tone on an output for `ms` ms at `gainDb` dBFS (default -12).
   * Rejects if setSinkId fails.
   */
  playTone(deviceId: string, ms: number, frequencyHz: number, gainDb?: number): Promise<void>;
}

// ---------------------------------------------------------------------------
// Call assistant (M6): passthrough PCM tap and playback options (spec §7.1 / §7.2).
// ---------------------------------------------------------------------------

/** Passthrough tap mode. M7 adds 'local16k'. */
export type TapMode = 'off' | 'main24k';

/** Reserved for engines that need it (M7 local); the main24k tap ignores it. */
export interface TapOptions {
  model?: string;
  lang?: string;
}

/** Defaults keep today's playback behaviour (6 s backlog, 1.06× catch-up). */
export interface PlaybackOptions {
  maxBacklogS?: number;
  catchup?: boolean;
}

/** Shape of window.offscreenBridge (offscreenPreload implements it, offscreen/index.ts declares it). */
export interface OffscreenPreloadBridge {
  onPushPlayback(handler: (streamId: string, base64: string) => void): void;
  sendPcm(streamId: string, base64: string): void;
  sendLevel(report: LevelReport): void;
  sendStreamEvent(e: StreamEvent): void;
  sendDeviceChange(): void;
}

/** Extra offscreen window API, implemented by U8b. */
export interface OffscreenAssistantApi {
  /** Stores the tap and applies it; MUST resolve immediately (never awaits anything slow). */
  setPassthroughTap(streamId: string, mode: TapMode, opts?: TapOptions): Promise<void>;
  startPlaybackWithOptions(
    streamId: string,
    outDeviceId: string,
    opts: PlaybackOptions,
  ): Promise<void>;
}
