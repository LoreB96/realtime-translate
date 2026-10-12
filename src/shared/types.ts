import type { LanguageCode } from './languages';

export type SessionState =
  | { kind: 'idle' }
  | { kind: 'connecting' }
  | { kind: 'active'; sinceMs: number }
  | { kind: 'reconnecting'; attempt: number }
  | { kind: 'error'; message: string };

export interface DeviceSummary {
  deviceId: string;
  label: string;
  kind: 'audioinput' | 'audiooutput';
}

// Renderer-facing twin of the main-process CablePair from src/main/audio/deviceDetector.ts.
// Uses DeviceSummary instead of DeviceInfo so this type can live in `shared` without pulling
// in main-only code. Main process maps DeviceInfo -> DeviceSummary at the IPC boundary.
export interface DeviceInventory {
  inputs: DeviceSummary[];
  outputs: DeviceSummary[];
  cableA?: { playback?: DeviceSummary; recording?: DeviceSummary };
  cableB?: { playback?: DeviceSummary; recording?: DeviceSummary };
}

export type Direction = 'A' | 'B';

/** Per-direction state for bidirectional translation. */
export interface DirectionalState {
  direction: Direction;
  state: SessionState;
}

/**
 * Bidirectional translation startup args. Direction A = user speaks → interlocutor;
 * Direction B = interlocutor speaks → user.
 *
 * Device names from the *device's* perspective (matches Web Audio's MediaDeviceInfo.kind):
 * - micDeviceId: real mic, Direction A audio source (audioinput)
 * - toMeetDeviceId: where Direction A's translated output is played; Meet records from
 *   this cable's recording side (audiooutput, e.g., 'CABLE-A Input')
 * - fromMeetDeviceId: where the app captures Meet's incoming audio; Meet plays into
 *   this cable's playback side, app reads from the recording side (audioinput, e.g., 'CABLE-B Output')
 * - headsetDeviceId: real speakers/headphones, Direction B output (audiooutput)
 */
export interface BidirectionalArgs {
  sourceLang: LanguageCode;
  targetLang: LanguageCode;
  micDeviceId: string;
  toMeetDeviceId: string;
  fromMeetDeviceId: string;
  headsetDeviceId: string;
}

/** The four user-selected audio endpoints, named by role (see BidirectionalArgs). */
export type DeviceRole = 'mic' | 'toCall' | 'fromCall' | 'headset';

/**
 * Audio-health problems the app can detect on its own. Each one maps to a concrete fix the
 * UI explains (widget chip + troubleshooting screen).
 * - device-missing: a selected device is no longer present (unplugged, VB-Cable removed).
 * - device-failed:  opening/using the device failed (getUserMedia, setSinkId, track ended).
 * - mic-silent:     the mic has delivered only exact digital silence since it was opened
 *                   (probably muted in Windows/hardware).
 * - call-silent:    nothing at all has arrived from the call app on CABLE-B since
 *                   translation started (its speaker is not set to CABLE-B Input).
 * - audio-suspended: an audio context was suspended by the OS and could not be resumed.
 * - mic-quiet / call-quiet: the source has sound, but too quiet for the silence gate in
 *                   front of the translation model, so nothing gets translated.
 */
export type HealthIssueCode =
  | 'device-missing'
  | 'device-failed'
  | 'mic-silent'
  | 'call-silent'
  | 'audio-suspended'
  | 'mic-quiet'
  | 'call-quiet';

export interface HealthIssue {
  code: HealthIssueCode;
  role: DeviceRole;
  /** Technical detail for logs/tooltips. Never contains audio or transcript data. */
  detail?: string;
  /** Epoch ms when the issue was first raised. */
  sinceMs: number;
}

/** What the app is currently doing with audio. */
export type AudioMode = 'off' | 'passthrough' | 'translating';

export interface HealthReport {
  mode: AudioMode;
  issues: HealthIssue[];
}

export type DiagnosticCheckId =
  | 'api-key'
  | 'devices-saved'
  | 'mic-present'
  | 'mic-signal'
  | 'to-call-present'
  | 'cable-a-loopback'
  | 'from-call-present'
  | 'call-signal'
  | 'headset-present'
  | 'headset-tone';

export type DiagnosticStatus = 'pass' | 'warn' | 'fail' | 'skipped';

export interface DiagnosticCheck {
  id: DiagnosticCheckId;
  status: DiagnosticStatus;
  /** Optional measured value, e.g. peak level in dBFS. */
  measuredDb?: number;
  detail?: string;
}

export interface DiagnosticsResult {
  checks: DiagnosticCheck[];
  /** Epoch ms when the run finished. */
  finishedMs: number;
}
