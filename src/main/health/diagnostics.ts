import type { DevicePrefs } from '../config/userPrefsStore';
import type { Logger } from '../util/logger';
import type { InputMeasurement } from '../../shared/offscreenContract';
import { GATE_MAX_THRESHOLD_DB, GATE_MIN_THRESHOLD_DB } from '../../shared/util/audioAnalysis';
import type {
  DeviceInventory,
  DeviceRole,
  DiagnosticCheck,
  DiagnosticCheckId,
  DiagnosticsResult,
} from '../../shared/types';
import { isConcreteDeviceId, presentDeviceIds, ROLE_IS_INPUT } from './healthMonitor';

export interface DiagnosticsDeps {
  hasApiKey: boolean;
  /** SAVED device prefs — never ids supplied by a renderer. */
  devices: DevicePrefs | undefined;
  inventory: DeviceInventory;
  measureInput(deviceId: string, ms: number): Promise<InputMeasurement>;
  playTone(deviceId: string, ms: number, frequencyHz: number, gainDb?: number): Promise<void>;
  logger?: Logger;
  now?: () => number;
}

/**
 * Thresholds (dBFS) and durations (ms). Exported for tests and the UI copy.
 *
 * The signal checks are tied to the silence gate in front of the translation model: the
 * gate's adaptive threshold can rise up to GATE_MAX_THRESHOLD_DB on a noisy line, so a
 * source whose loudest 100 ms stays below that may not be translated ('warn'), and one
 * below GATE_MIN_THRESHOLD_DB never is ('warn: very-quiet').
 */
export const DIAG = {
  micMs: 3000,
  /** Below this the source is never translated. */
  veryQuietDb: GATE_MIN_THRESHOLD_DB,
  /** Below this the source may be dropped by the gate. */
  translateMinDb: GATE_MAX_THRESHOLD_DB,
  loopbackMs: 1500,
  loopbackHz: 440,
  /**
   * CABLE-A Input is the call app's microphone: anyone in a live meeting hears this tone.
   * Keep it quiet — the detection threshold below only needs it to arrive.
   */
  loopbackGainDb: -30,
  loopbackMinDb: -45,
  callMs: 4000,
  headsetMs: 800,
  headsetHz: 660,
  headsetGainDb: -18,
} as const;

/** Grades a measured input against the translation gate (see DIAG). */
function gradeSignal(m: InputMeasurement): Omit<DiagnosticCheck, 'id'> | undefined {
  if (m.maxRmsDb < DIAG.veryQuietDb) return { status: 'warn', measuredDb: m.maxRmsDb, detail: 'very-quiet' };
  if (m.maxRmsDb < DIAG.translateMinDb) {
    return { status: 'warn', measuredDb: m.maxRmsDb, detail: 'below-translation-threshold' };
  }
  return undefined;
}

const MAX_DETAIL = 200;

/**
 * Self-test of the whole audio path, in DiagnosticCheckId order. Each device step is
 * isolated: an exception becomes that check's 'fail' and the run continues. A check whose
 * prerequisite did not pass is 'skipped'. The caller must stop passthrough/translation
 * first — the measurements open the same devices.
 */
export async function runDiagnostics(deps: DiagnosticsDeps): Promise<DiagnosticsResult> {
  const checks: DiagnosticCheck[] = [];
  const add = (c: DiagnosticCheck): DiagnosticCheck => {
    checks.push(c);
    deps.logger?.info('diagnostic_check', {
      id: c.id,
      status: c.status,
      ...(c.measuredDb !== undefined ? { measuredDb: c.measuredDb } : {}),
    });
    return c;
  };
  const skip = (id: DiagnosticCheckId, detail: string): DiagnosticCheck =>
    add({ id, status: 'skipped', detail });
  /** Runs a device step; any exception becomes a 'fail' for that check only. */
  const guarded = async (
    id: DiagnosticCheckId,
    fn: () => Promise<Omit<DiagnosticCheck, 'id'>>,
  ): Promise<DiagnosticCheck> => {
    try {
      return add({ id, ...(await fn()) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return add({ id, status: 'fail', detail: message.slice(0, MAX_DETAIL) });
    }
  };

  add(
    deps.hasApiKey
      ? { id: 'api-key', status: 'pass' }
      : { id: 'api-key', status: 'fail', detail: 'no-api-key' },
  );

  const ids: Record<DeviceRole, string | undefined> = {
    mic: deps.devices?.mic,
    toCall: deps.devices?.toMeet,
    fromCall: deps.devices?.fromMeet,
    headset: deps.devices?.headset,
  };
  const unsaved = (Object.keys(ids) as DeviceRole[]).filter((r) => !isConcreteDeviceId(ids[r]));
  add(
    unsaved.length === 0
      ? { id: 'devices-saved', status: 'pass' }
      : { id: 'devices-saved', status: 'fail', detail: `not-saved:${unsaved.join(',')}` },
  );

  const present = presentDeviceIds(deps.inventory);
  const presence = (id: DiagnosticCheckId, role: DeviceRole): DiagnosticCheck => {
    const deviceId = ids[role];
    if (!isConcreteDeviceId(deviceId)) return skip(id, 'not-saved');
    const set = ROLE_IS_INPUT[role] ? present.inputs : present.outputs;
    return add(set.has(deviceId) ? { id, status: 'pass' } : { id, status: 'fail', detail: 'not-found' });
  };

  // Mic: present + delivers signal.
  const micPresent = presence('mic-present', 'mic');
  if (micPresent.status !== 'pass') {
    skip('mic-signal', 'mic-present');
  } else {
    await guarded('mic-signal', async () => {
      const m = await deps.measureInput(ids.mic!, DIAG.micMs);
      if (m.digitalSilence) return { status: 'fail', measuredDb: m.maxRmsDb, detail: 'digital-silence' };
      return gradeSignal(m) ?? { status: 'pass', measuredDb: m.maxRmsDb };
    });
  }

  // To call: present + a tone played into it comes out of CABLE-A's recording side.
  const toCallPresent = presence('to-call-present', 'toCall');
  const cableARecording = deps.inventory.cableA?.recording?.deviceId;
  if (toCallPresent.status !== 'pass') {
    skip('cable-a-loopback', 'to-call-present');
  } else if (!cableARecording) {
    // CABLE-A Output is what the call app must use as its microphone: without it (usually
    // disabled in Windows → Sound → Recording) nobody in the call hears the user.
    add({ id: 'cable-a-loopback', status: 'fail', detail: 'no-cable-a-recording' });
  } else {
    await guarded('cable-a-loopback', async () => {
      const [, m] = await Promise.all([
        deps.playTone(ids.toCall!, DIAG.loopbackMs, DIAG.loopbackHz, DIAG.loopbackGainDb),
        deps.measureInput(cableARecording, DIAG.loopbackMs),
      ]);
      return m.maxRmsDb > DIAG.loopbackMinDb
        ? { status: 'pass', measuredDb: m.maxRmsDb }
        : { status: 'fail', measuredDb: m.maxRmsDb, detail: 'no-signal-on-cable-a' };
    });
  }

  // From call: present + the call app actually plays into CABLE-B. Only a warning when
  // silent — it depends on the user playing audio in the call during the test.
  const fromCallPresent = presence('from-call-present', 'fromCall');
  if (fromCallPresent.status !== 'pass') {
    skip('call-signal', 'from-call-present');
  } else {
    await guarded('call-signal', async () => {
      const m = await deps.measureInput(ids.fromCall!, DIAG.callMs);
      if (m.digitalSilence) return { status: 'warn', measuredDb: m.maxRmsDb, detail: 'no-audio-from-call' };
      return gradeSignal(m) ?? { status: 'pass', measuredDb: m.maxRmsDb };
    });
  }

  // Headset: present + can play.
  const headsetPresent = presence('headset-present', 'headset');
  if (headsetPresent.status !== 'pass') {
    skip('headset-tone', 'headset-present');
  } else {
    await guarded('headset-tone', async () => {
      await deps.playTone(ids.headset!, DIAG.headsetMs, DIAG.headsetHz, DIAG.headsetGainDb);
      return { status: 'pass' };
    });
  }

  return { checks, finishedMs: (deps.now ?? Date.now)() };
}
