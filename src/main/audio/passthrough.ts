import type { DevicePrefs } from '../config/userPrefsStore';
import type { Logger } from '../util/logger';
import type { DeviceRole } from '../../shared/types';
import type { LevelReport } from '../../shared/offscreenContract';

/** Narrow offscreen surface the passthrough needs. */
export interface PassthroughOffscreen {
  startPassthrough(streamId: string, inputDeviceId: string, outputDeviceId: string): Promise<void>;
  stopStream(streamId: string): void;
}

/** Optional health hooks (see HealthMonitor). */
export interface PassthroughCallbacks {
  /** A direction failed to open; `role` is the device most likely at fault. */
  onFailure?(role: DeviceRole, detail: string): void;
  /** A direction opened; called for both of its roles (input and output). */
  onStarted?(role: DeviceRole): void;
}

export interface PassthroughOptions {
  /** Injected clock (epoch ms). Defaults to Date.now. */
  now?: () => number;
  /**
   * Silence on both sides (no speech on the mic, only digital zeros from the call) before
   * the mic is released. 0 disables parking.
   */
  idleParkMs?: number;
}

export const PASSTHROUGH_A = 'pass-A';
export const PASSTHROUGH_B = 'pass-B';
export const PASSTHROUGH_STREAMS: readonly string[] = [PASSTHROUGH_A, PASSTHROUGH_B];

/** Mic window RMS at/above this counts as the user talking (keeps the mic open). */
const MIC_ACTIVITY_DB = -50;
const DEFAULT_IDLE_PARK_MS = 10 * 60_000;

const isReal = (id: string | undefined): id is string =>
  Boolean(id) && id !== 'default' && id !== 'communications';

/** Input/output roles of each passthrough stream. */
const ROLES: Record<string, { input: DeviceRole; output: DeviceRole }> = {
  [PASSTHROUGH_A]: { input: 'mic', output: 'toCall' },
  [PASSTHROUGH_B]: { input: 'fromCall', output: 'headset' },
};

/** The passthrough stream that carries a role's audio. */
export function streamForRole(role: DeviceRole): string {
  return role === 'mic' || role === 'toCall' ? PASSTHROUGH_A : PASSTHROUGH_B;
}

/**
 * Which side of a stream a start error points at. The offscreen error doesn't say which
 * device failed, so blame the input (getUserMedia is the usual culprit) unless the message
 * clearly names the output path (setSinkId / sink / output device).
 */
export function failedRole(streamId: string, message: string): DeviceRole {
  const roles = ROLES[streamId] ?? ROLES[PASSTHROUGH_A]!;
  return /setSinkId|\bsink\b|output/i.test(message) ? roles.output : roles.input;
}

/** What the caller should do after a level report (see Passthrough.onLevel). */
export type PassthroughAction = 'park' | 'wake' | undefined;

/**
 * Untranslated audio while translation is off: mic -> CABLE-A (the call hears you) and
 * CABLE-B -> headset (you hear the call). Without it, the call is silent in both
 * directions until Start, since the call app only sees the virtual cables. A single
 * direction can also run on its own (fallback while the other one translates).
 *
 * Idle parking: holding the mic open all day keeps Bluetooth headsets in low-quality
 * hands-free mode and the Windows mic indicator on. When neither side has had audio for
 * idleParkMs, pass-A is released ("parked"); it reopens as soon as the call sends audio
 * again (or on the next sync from Stop / closing Settings).
 *
 * Not reentrant — the caller serializes sync()/restart*()/wake()/stop() with Start/Stop.
 */
export class Passthrough {
  /** Devices of the running passthrough, or undefined when stopped. */
  private running: Required<DevicePrefs> | undefined;
  /** Streams that should be running on `running` (pass-A stays here while parked). */
  private wanted = new Set<string>();
  private parked = false;
  private lastActivityMs = 0;
  private readonly now: () => number;
  private readonly idleParkMs: number;

  constructor(
    private readonly offscreen: PassthroughOffscreen,
    private readonly logger?: Logger,
    private readonly callbacks: PassthroughCallbacks = {},
    opts: PassthroughOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.idleParkMs = Math.max(0, opts.idleParkMs ?? DEFAULT_IDLE_PARK_MS);
  }

  get isRunning(): boolean {
    return this.running !== undefined;
  }

  /** True while pass-A is released for inactivity. */
  get isMicParked(): boolean {
    return this.parked;
  }

  /** Streams currently wanted (sorted), e.g. for health stream mapping. */
  get streams(): string[] {
    return [...this.wanted].sort();
  }

  /**
   * Starts (or re-targets) the passthrough when enabled, stops it otherwise. `streams`
   * selects the directions (default both). Streams already running on the same devices
   * are left untouched.
   */
  async sync(
    devices: DevicePrefs | undefined,
    enabled: boolean,
    streams: readonly string[] = PASSTHROUGH_STREAMS,
  ): Promise<void> {
    const want = enabled && streams.length > 0 ? complete(devices) : undefined;
    if (!want) {
      this.stop();
      return;
    }
    const wantSet = new Set(streams.filter((s) => ROLES[s]));
    if (!sameDevices(want, this.running)) {
      this.stop();
      this.running = want;
      this.wanted = wantSet;
      this.lastActivityMs = this.now();
      await Promise.all([...wantSet].map((s) => this.startOne(s)));
      return;
    }
    // Same devices: stop what's no longer wanted, start what's new. A full sync (Stop,
    // Settings closed) also wakes a parked mic — the user just interacted with the app.
    const toStart: string[] = [];
    for (const s of this.wanted) {
      if (!wantSet.has(s)) this.offscreen.stopStream(s);
    }
    for (const s of wantSet) {
      if (!this.wanted.has(s) || (s === PASSTHROUGH_A && this.parked)) toStart.push(s);
    }
    this.wanted = wantSet;
    if (!wantSet.has(PASSTHROUGH_A) || toStart.includes(PASSTHROUGH_A)) this.parked = false;
    if (toStart.length > 0) this.lastActivityMs = this.now();
    // Independent directions: one missing device (e.g. headset unplugged) must not
    // silence the other.
    await Promise.all(toStart.map((s) => this.startOne(s)));
  }

  /**
   * Re-opens every running direction on the same devices (e.g. after the audio driver
   * restarted — the old streams are dead even though the ids are unchanged).
   */
  async restart(): Promise<void> {
    await Promise.all(this.streams.map((s) => this.restartStream(s)));
  }

  /**
   * Re-opens one direction only, so recovering a broken headset doesn't interrupt the
   * mic -> call direction. Returns false if it failed to open (reported via onFailure);
   * true if it opened or there was nothing to restart (stopped, not wanted, parked).
   */
  async restartStream(streamId: string): Promise<boolean> {
    if (!this.running || !this.wanted.has(streamId)) return true;
    if (streamId === PASSTHROUGH_A && this.parked) return true;
    this.offscreen.stopStream(streamId);
    return this.startOne(streamId);
  }

  stop(): void {
    if (!this.running) return;
    this.running = undefined;
    this.parked = false;
    for (const s of this.wanted) this.offscreen.stopStream(s);
    this.wanted.clear();
  }

  /**
   * Feeds a level report of a passthrough stream. Returns 'park' when both sides have
   * been idle for idleParkMs (caller then calls park()), 'wake' when the call sends audio
   * while the mic is parked (caller then calls wake()).
   */
  onLevel(r: Pick<LevelReport, 'streamId' | 'rmsDb' | 'digitalSilence'>): PassthroughAction {
    if (!this.running) return undefined;
    const now = this.now();
    if (r.streamId === PASSTHROUGH_B && !r.digitalSilence) {
      this.lastActivityMs = now;
      return this.parked ? 'wake' : undefined;
    }
    if (r.streamId === PASSTHROUGH_A && r.rmsDb >= MIC_ACTIVITY_DB) this.lastActivityMs = now;
    const canPark =
      this.idleParkMs > 0 &&
      !this.parked &&
      this.wanted.has(PASSTHROUGH_A) &&
      this.wanted.has(PASSTHROUGH_B);
    return canPark && now - this.lastActivityMs >= this.idleParkMs ? 'park' : undefined;
  }

  /** Releases the mic (pass-A) after inactivity. No-op unless running and not parked. */
  park(): void {
    if (!this.running || this.parked || !this.wanted.has(PASSTHROUGH_A)) return;
    this.parked = true;
    this.offscreen.stopStream(PASSTHROUGH_A);
    this.logger?.info('passthrough_mic_parked', {});
  }

  /** Reopens a parked mic. */
  async wake(): Promise<void> {
    if (!this.running || !this.parked) return;
    this.parked = false;
    this.lastActivityMs = this.now();
    this.logger?.info('passthrough_mic_woken', {});
    await this.startOne(PASSTHROUGH_A);
  }

  private async startOne(streamId: string): Promise<boolean> {
    const devices = this.running;
    const roles = ROLES[streamId];
    if (!devices || !roles) return false;
    const [input, output] =
      streamId === PASSTHROUGH_A
        ? [devices.mic, devices.toMeet]
        : [devices.fromMeet, devices.headset];
    try {
      await this.offscreen.startPassthrough(streamId, input, output);
    } catch (err) {
      // A start that timed out in main may still complete in the offscreen renderer; stop
      // the slot so a late handle is discarded instead of playing behind our back.
      this.offscreen.stopStream(streamId);
      const message = err instanceof Error ? err.message : String(err);
      this.logger?.warn('passthrough_start_failed', { streamId, message });
      this.callbacks.onFailure?.(failedRole(streamId, message), message);
      return false;
    }
    this.callbacks.onStarted?.(roles.input);
    this.callbacks.onStarted?.(roles.output);
    return true;
  }
}

function complete(d: DevicePrefs | undefined): Required<DevicePrefs> | undefined {
  if (!d || !isReal(d.mic) || !isReal(d.toMeet) || !isReal(d.fromMeet) || !isReal(d.headset)) {
    return undefined;
  }
  return { mic: d.mic, toMeet: d.toMeet, fromMeet: d.fromMeet, headset: d.headset };
}

function sameDevices(a: DevicePrefs | undefined, b: DevicePrefs | undefined): boolean {
  if (!a || !b) return a === b;
  return (
    a.mic === b.mic && a.toMeet === b.toMeet && a.fromMeet === b.fromMeet && a.headset === b.headset
  );
}
