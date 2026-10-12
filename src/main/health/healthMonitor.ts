import type {
  AudioMode,
  DeviceInventory,
  DeviceRole,
  HealthIssue,
  HealthIssueCode,
  HealthReport,
} from '../../shared/types';
import type { LevelReport, StreamEvent } from '../../shared/offscreenContract';

export interface HealthMonitorOptions {
  /** Injected clock (epoch ms). Defaults to Date.now. */
  now?: () => number;
  /** Digital silence on the mic, from the moment it opened, before 'mic-silent' is raised. */
  micSilentMs?: number;
  /** Digital silence on CABLE-B, from the moment it opened, before 'call-silent' is raised. */
  callSilentMs?: number;
  /** Level windows with sound but a closed gate before 'mic-quiet'/'call-quiet' is raised. */
  quietWindows?: number;
  /** Fired only when the mode or the set of issues (code + role + detail) changes. */
  onChange?: (report: HealthReport) => void;
}

const SEVERITY: Record<HealthIssueCode, number> = {
  'device-missing': 0,
  'device-failed': 1,
  'audio-suspended': 2,
  'mic-silent': 3,
  'call-silent': 4,
  'mic-quiet': 5,
  'call-quiet': 6,
};
const ROLE_ORDER: Record<DeviceRole, number> = { mic: 0, toCall: 1, fromCall: 2, headset: 3 };

/** Issues derived from a live stream (levels / stream events), reset whenever the mode changes. */
const STREAM_CODES: ReadonlySet<HealthIssueCode> = new Set<HealthIssueCode>([
  'mic-silent',
  'call-silent',
  'audio-suspended',
  'mic-quiet',
  'call-quiet',
]);

/**
 * A level window "has sound" when its peak reaches this. Speech too quiet for the gate
 * (frame RMS below its threshold) still peaks well above it; an idle line does not.
 */
export const QUIET_PEAK_DB = -50;
/** A run of sound-but-gate-closed windows ends after this long without another one. */
const QUIET_RUN_GAP_MS = 10_000;

const key = (code: HealthIssueCode, role: DeviceRole): string => `${code}|${role}`;

/**
 * Key of a stream's OUTPUT side in the `streamRoles` map passed to setMode. The plain
 * stream id maps the input side (and its level reports).
 */
export const outputStreamKey = (streamId: string): string => `${streamId}:out`;

/**
 * Turns raw audio signals (level reports, stream events, device inventory, start failures)
 * into a small set of user-facing issues. Pure: no timers, no IO — silence thresholds are
 * evaluated on each level report (~every 500 ms), so the clock only matters there.
 *
 * Silence / quiet issues are only raised while translating. In passthrough the user is
 * often not in a call, and an idle CABLE-B or a muted mic is normal there.
 *
 * Silence counts only while a stream has NEVER delivered a non-zero window since it was
 * opened: call apps write exact zeros while nobody talks, and some mic chains (NVIDIA
 * Broadcast, Krisp, driver noise gates) do the same during pauses. Once real audio was
 * seen, the route is proven to work and later silence is just a pause.
 */
export class HealthMonitor {
  private readonly now: () => number;
  private readonly micSilentMs: number;
  private readonly callSilentMs: number;
  private readonly quietWindows: number;
  private readonly onChange: ((report: HealthReport) => void) | undefined;

  private mode: AudioMode = 'off';
  private streamRoles: Record<string, DeviceRole> = {};
  /** streamId -> epoch ms when the current run of digital silence began. */
  private silentSince = new Map<string, number>();
  /** Streams that delivered at least one non-silent window since they were (re)opened. */
  private everSignal = new Set<string>();
  /** streamId -> run of windows with sound while the gate stayed closed. */
  private belowGate = new Map<string, { count: number; lastMs: number }>();
  private issues = new Map<string, HealthIssue>();
  private lastSignature = this.signature();

  constructor(opts: HealthMonitorOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.micSilentMs = opts.micSilentMs ?? 10_000;
    this.callSilentMs = opts.callSilentMs ?? 15_000;
    this.quietWindows = opts.quietWindows ?? 12;
    this.onChange = opts.onChange;
  }

  /**
   * Switches mode and the streams that feed it: streamId -> input role, and
   * outputStreamKey(streamId) -> output role. Stream-derived issues and silence tracking
   * are reset: the old streams are gone. 'device-failed' / 'device-missing' are kept —
   * the caller clears a failure once the device opens again (clearFailure). No-op when
   * neither the mode nor the streams change.
   */
  setMode(mode: AudioMode, streamRoles: Record<string, DeviceRole>): void {
    if (mode === this.mode && sameRoles(streamRoles, this.streamRoles)) return;
    this.mode = mode;
    this.streamRoles = { ...streamRoles };
    this.silentSince.clear();
    this.everSignal.clear();
    this.belowGate.clear();
    for (const [k, issue] of this.issues) {
      if (STREAM_CODES.has(issue.code)) this.issues.delete(k);
    }
    this.emitIfChanged();
  }

  /**
   * A stream was re-opened (device recovery): its silence history no longer applies.
   * Keeps issues; the next level reports re-evaluate them.
   */
  resetStream(streamId: string): void {
    this.silentSince.delete(streamId);
    this.everSignal.delete(streamId);
    this.belowGate.delete(streamId);
  }

  onLevel(r: LevelReport): void {
    const role = this.streamRoles[r.streamId];
    if (!role) return;
    this.checkSilence(r, role);
    this.checkBelowGate(r, role);
  }

  onStreamEvent(e: StreamEvent): void {
    const role =
      this.streamRoles[e.side === 'output' ? outputStreamKey(e.streamId) : e.streamId];
    if (!role) return;
    switch (e.kind) {
      case 'track-ended':
        this.raise('device-failed', role, e.detail ?? 'track-ended');
        break;
      case 'context-suspended':
        this.raise('audio-suspended', role, e.detail);
        break;
      case 'context-resumed':
        this.remove('audio-suspended', role);
        break;
    }
  }

  /** Replaces the full set of 'device-missing' issues. */
  setMissing(roles: DeviceRole[]): void {
    const want = new Set(roles);
    for (const [k, issue] of this.issues) {
      if (issue.code === 'device-missing' && !want.has(issue.role)) this.issues.delete(k);
    }
    for (const role of want) this.raise('device-missing', role, undefined, false);
    this.emitIfChanged();
  }

  reportFailure(role: DeviceRole, detail: string): void {
    this.raise('device-failed', role, detail);
  }

  /**
   * The role's audio was (re-)opened successfully: clears 'device-failed' and
   * 'audio-suspended' for it (a fresh AudioContext never sends 'context-resumed').
   */
  clearFailure(role: DeviceRole): void {
    this.issues.delete(key('device-failed', role));
    this.issues.delete(key('audio-suspended', role));
    this.emitIfChanged();
  }

  getReport(): HealthReport {
    const issues = [...this.issues.values()]
      .sort((a, b) => SEVERITY[a.code] - SEVERITY[b.code] || ROLE_ORDER[a.role] - ROLE_ORDER[b.role])
      .map((i) => ({ ...i }));
    return { mode: this.mode, issues };
  }

  /** True while an issue exists that automatic device recovery may fix. */
  needsRecovery(): boolean {
    for (const issue of this.issues.values()) {
      if (issue.code === 'device-missing' || issue.code === 'device-failed' || issue.code === 'audio-suspended') {
        return true;
      }
    }
    return false;
  }

  private checkSilence(r: LevelReport, role: DeviceRole): void {
    const code = silenceCode(role);
    if (!code) return;
    if (!r.digitalSilence) {
      this.everSignal.add(r.streamId);
      this.silentSince.delete(r.streamId);
      this.remove(code, role);
      return;
    }
    // The route has delivered audio before: this is a pause, not a broken route.
    if (this.everSignal.has(r.streamId)) return;
    const now = this.now();
    const since = this.silentSince.get(r.streamId) ?? now;
    this.silentSince.set(r.streamId, since);
    if (this.mode !== 'translating') return;
    const threshold = code === 'mic-silent' ? this.micSilentMs : this.callSilentMs;
    if (now - since >= threshold) this.raise(code, role);
  }

  /** Sound on the line, but the translation gate never opened: too quiet to translate. */
  private checkBelowGate(r: LevelReport, role: DeviceRole): void {
    const code = quietCode(role);
    if (!code || r.gateOpenMs === undefined) return;
    if (r.gateOpenMs > 0) {
      this.belowGate.delete(r.streamId);
      this.remove(code, role);
      return;
    }
    if (r.digitalSilence || r.peakDb < QUIET_PEAK_DB) return;
    const now = this.now();
    const prev = this.belowGate.get(r.streamId);
    const run =
      prev && now - prev.lastMs <= QUIET_RUN_GAP_MS
        ? { count: prev.count + 1, lastMs: now }
        : { count: 1, lastMs: now };
    this.belowGate.set(r.streamId, run);
    if (this.mode === 'translating' && run.count >= this.quietWindows) this.raise(code, role);
  }

  private raise(code: HealthIssueCode, role: DeviceRole, detail?: string, emit = true): void {
    const k = key(code, role);
    const prev = this.issues.get(k);
    if (!prev || prev.detail !== detail) {
      this.issues.set(k, {
        code,
        role,
        ...(detail !== undefined ? { detail } : {}),
        sinceMs: prev?.sinceMs ?? this.now(),
      });
    }
    if (emit) this.emitIfChanged();
  }

  private remove(code: HealthIssueCode, role: DeviceRole): void {
    if (this.issues.delete(key(code, role))) this.emitIfChanged();
  }

  private signature(): string {
    const parts = [...this.issues.values()].map((i) => `${i.code}|${i.role}|${i.detail ?? ''}`).sort();
    return `${this.mode}#${parts.join(',')}`;
  }

  private emitIfChanged(): void {
    const sig = this.signature();
    if (sig === this.lastSignature) return;
    this.lastSignature = sig;
    this.onChange?.(this.getReport());
  }
}

function sameRoles(a: Record<string, DeviceRole>, b: Record<string, DeviceRole>): boolean {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
}

function silenceCode(role: DeviceRole): HealthIssueCode | undefined {
  if (role === 'mic') return 'mic-silent';
  if (role === 'fromCall') return 'call-silent';
  return undefined;
}

function quietCode(role: DeviceRole): HealthIssueCode | undefined {
  if (role === 'mic') return 'mic-quiet';
  if (role === 'fromCall') return 'call-quiet';
  return undefined;
}

/** Chromium pseudo-devices and empty ids can't go missing — they follow the Windows default. */
export const isConcreteDeviceId = (id: string | undefined): id is string =>
  Boolean(id) && id !== 'default' && id !== 'communications';

/**
 * Input/output device ids present in an inventory. Virtual cables are NOT part of
 * inventory.inputs/outputs, so their sides are added explicitly.
 */
export function presentDeviceIds(inv: DeviceInventory): { inputs: Set<string>; outputs: Set<string> } {
  const inputs = new Set(inv.inputs.map((d) => d.deviceId));
  const outputs = new Set(inv.outputs.map((d) => d.deviceId));
  for (const cable of [inv.cableA, inv.cableB]) {
    if (cable?.recording) inputs.add(cable.recording.deviceId);
    if (cable?.playback) outputs.add(cable.playback.deviceId);
  }
  return { inputs, outputs };
}

/** Whether each role reads (input) or writes (output) its device. */
export const ROLE_IS_INPUT: Record<DeviceRole, boolean> = {
  mic: true,
  toCall: false,
  fromCall: true,
  headset: false,
};

/** Roles whose concrete selected device is absent from the inventory. */
export function findMissingRoles(
  ids: Partial<Record<DeviceRole, string | undefined>>,
  inv: DeviceInventory,
): DeviceRole[] {
  const present = presentDeviceIds(inv);
  const out: DeviceRole[] = [];
  for (const role of Object.keys(ROLE_ORDER) as DeviceRole[]) {
    const id = ids[role];
    if (!isConcreteDeviceId(id)) continue;
    const set = ROLE_IS_INPUT[role] ? present.inputs : present.outputs;
    if (!set.has(id)) out.push(role);
  }
  return out;
}
