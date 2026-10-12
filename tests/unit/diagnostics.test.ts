import { describe, it, expect, vi } from 'vitest';
import { DIAG, runDiagnostics, type DiagnosticsDeps } from '@main/health/diagnostics';
import type { InputMeasurement } from '@shared/offscreenContract';
import type { DeviceInventory, DiagnosticCheck, DiagnosticCheckId } from '@shared/types';

const INVENTORY: DeviceInventory = {
  inputs: [{ deviceId: 'mic', label: 'Headset Mic', kind: 'audioinput' }],
  outputs: [{ deviceId: 'hs', label: 'Headphones', kind: 'audiooutput' }],
  cableA: {
    playback: { deviceId: 'ca-in', label: 'CABLE-A Input', kind: 'audiooutput' },
    recording: { deviceId: 'ca-out', label: 'CABLE-A Output', kind: 'audioinput' },
  },
  cableB: {
    playback: { deviceId: 'cb-in', label: 'CABLE-B Input', kind: 'audiooutput' },
    recording: { deviceId: 'cb-out', label: 'CABLE-B Output', kind: 'audioinput' },
  },
};
const DEVICES = { mic: 'mic', toMeet: 'ca-in', fromMeet: 'cb-out', headset: 'hs' };

const ORDER: DiagnosticCheckId[] = [
  'api-key',
  'devices-saved',
  'mic-present',
  'mic-signal',
  'to-call-present',
  'cable-a-loopback',
  'from-call-present',
  'call-signal',
  'headset-present',
  'headset-tone',
];

const speech: InputMeasurement = { maxRmsDb: -25, digitalSilence: false };

function deps(over: Partial<DiagnosticsDeps> = {}): DiagnosticsDeps {
  return {
    hasApiKey: true,
    devices: DEVICES,
    inventory: INVENTORY,
    measureInput: vi.fn(async () => speech),
    playTone: vi.fn(async () => undefined),
    now: () => 42,
    ...over,
  };
}

const byId = (checks: DiagnosticCheck[]) =>
  Object.fromEntries(checks.map((c) => [c.id, c])) as Record<DiagnosticCheckId, DiagnosticCheck>;

describe('runDiagnostics', () => {
  it('all pass on a healthy setup, in the contract order', async () => {
    const d = deps();
    const r = await runDiagnostics(d);
    expect(r.checks.map((c) => c.id)).toEqual(ORDER);
    expect(r.checks.every((c) => c.status === 'pass')).toBe(true);
    expect(r.finishedMs).toBe(42);
    expect(byId(r.checks)['mic-signal'].measuredDb).toBe(-25);
    expect(d.measureInput).toHaveBeenCalledWith('mic', 3000);
    expect(d.measureInput).toHaveBeenCalledWith('ca-out', 1500);
    expect(d.measureInput).toHaveBeenCalledWith('cb-out', 4000);
    expect(d.playTone).toHaveBeenCalledWith('ca-in', 1500, 440, -30);
    expect(d.playTone).toHaveBeenCalledWith('hs', 800, 660, -18);
  });

  it('fails api-key and devices-saved, and skips checks of unsaved devices', async () => {
    const d = deps({ hasApiKey: false, devices: { mic: 'mic', headset: 'default' } });
    const c = byId((await runDiagnostics(d)).checks);
    expect(c['api-key']).toMatchObject({ status: 'fail', detail: 'no-api-key' });
    expect(c['devices-saved']).toMatchObject({
      status: 'fail',
      detail: 'not-saved:toCall,fromCall,headset',
    });
    expect(c['mic-present'].status).toBe('pass');
    expect(c['to-call-present'].status).toBe('skipped');
    expect(c['cable-a-loopback'].status).toBe('skipped');
    expect(c['call-signal'].status).toBe('skipped');
    expect(c['headset-tone'].status).toBe('skipped');
    expect(d.playTone).not.toHaveBeenCalled();
  });

  it('fails presence for a device not in the inventory and skips its dependent check', async () => {
    const d = deps({ devices: { ...DEVICES, mic: 'unplugged', headset: 'gone' } });
    const c = byId((await runDiagnostics(d)).checks);
    expect(c['mic-present']).toMatchObject({ status: 'fail', detail: 'not-found' });
    expect(c['mic-signal'].status).toBe('skipped');
    expect(c['headset-present'].status).toBe('fail');
    expect(c['headset-tone'].status).toBe('skipped');
    expect(d.measureInput).not.toHaveBeenCalledWith('unplugged', expect.anything());
  });

  it('checks the cable side in the right direction', async () => {
    // CABLE-A Output is an input — selecting it as the "to call" output must fail.
    const d = deps({ devices: { ...DEVICES, toMeet: 'ca-out' } });
    const c = byId((await runDiagnostics(d)).checks);
    expect(c['to-call-present'].status).toBe('fail');
    expect(c['cable-a-loopback'].status).toBe('skipped');
  });

  it('mic: digital silence fails, very quiet warns', async () => {
    const silent = deps({
      measureInput: vi.fn(async (id: string) =>
        id === 'mic' ? { maxRmsDb: -120, digitalSilence: true } : speech,
      ),
    });
    expect(byId((await runDiagnostics(silent)).checks)['mic-signal']).toEqual({
      id: 'mic-signal',
      status: 'fail',
      measuredDb: -120,
      detail: 'digital-silence',
    });
    const quiet = deps({
      measureInput: vi.fn(async (id: string) =>
        id === 'mic' ? { maxRmsDb: -65, digitalSilence: false } : speech,
      ),
    });
    expect(byId((await runDiagnostics(quiet)).checks)['mic-signal']).toMatchObject({
      status: 'warn',
      detail: 'very-quiet',
    });
  });

  it('warns when a source is audible but below what the translation gate may need', async () => {
    // -55 dBFS: above the old "very quiet" bar, but the gate can sit at up to -45.
    const d = deps({
      measureInput: vi.fn(async (id: string) =>
        id === 'mic' || id === 'cb-out' ? { maxRmsDb: -55, digitalSilence: false } : speech,
      ),
    });
    const c = byId((await runDiagnostics(d)).checks);
    expect(c['mic-signal']).toMatchObject({ status: 'warn', detail: 'below-translation-threshold' });
    expect(c['call-signal']).toMatchObject({ status: 'warn', detail: 'below-translation-threshold' });
    const loudEnough = deps({
      measureInput: vi.fn(async () => ({ maxRmsDb: -40, digitalSilence: false })),
    });
    expect(byId((await runDiagnostics(loudEnough)).checks)['mic-signal'].status).toBe('pass');
  });

  it('plays the CABLE-A loopback tone quietly: it goes into the live call', async () => {
    const d = deps();
    await runDiagnostics(d);
    expect(d.playTone).toHaveBeenCalledWith('ca-in', DIAG.loopbackMs, DIAG.loopbackHz, -30);
    expect(DIAG.loopbackGainDb).toBeGreaterThan(DIAG.loopbackMinDb);
  });

  it('cable-a-loopback: fails when the tone does not arrive, and without CABLE-A Output', async () => {
    const noLoop = deps({
      measureInput: vi.fn(async (id: string) =>
        id === 'ca-out' ? { maxRmsDb: -90, digitalSilence: false } : speech,
      ),
    });
    expect(byId((await runDiagnostics(noLoop)).checks)['cable-a-loopback']).toMatchObject({
      status: 'fail',
      measuredDb: -90,
    });

    const noRecording = deps({
      inventory: { ...INVENTORY, cableA: { playback: INVENTORY.cableA!.playback! } },
    });
    const c = byId((await runDiagnostics(noRecording)).checks);
    expect(c['to-call-present'].status).toBe('pass');
    expect(c['cable-a-loopback']).toMatchObject({ status: 'fail', detail: 'no-cable-a-recording' });
  });

  it('call-signal: silence is a warning telling the user to play call audio', async () => {
    const d = deps({
      measureInput: vi.fn(async (id: string) =>
        id === 'cb-out' ? { maxRmsDb: -120, digitalSilence: true } : speech,
      ),
    });
    expect(byId((await runDiagnostics(d)).checks)['call-signal']).toMatchObject({
      status: 'warn',
      detail: 'no-audio-from-call',
    });
  });

  it('isolates exceptions: one failing step becomes a fail and the run continues', async () => {
    const long = 'x'.repeat(500);
    const d = deps({
      measureInput: vi.fn(async (id: string) => {
        if (id === 'mic') throw new Error(long);
        return speech;
      }),
      playTone: vi.fn(async (id: string) => {
        if (id === 'hs') throw new Error('setSinkId: NotFoundError');
      }),
    });
    const r = await runDiagnostics(d);
    const c = byId(r.checks);
    expect(r.checks.map((x) => x.id)).toEqual(ORDER);
    expect(c['mic-signal'].status).toBe('fail');
    expect(c['mic-signal'].detail).toHaveLength(200);
    expect(c['cable-a-loopback'].status).toBe('pass');
    expect(c['call-signal'].status).toBe('pass');
    expect(c['headset-tone']).toMatchObject({ status: 'fail', detail: 'setSinkId: NotFoundError' });
  });

  it('a non-Error rejection is still captured', async () => {
    const d = deps({
      playTone: vi.fn(() => Promise.reject('boom')),
    });
    const c = byId((await runDiagnostics(d)).checks);
    expect(c['cable-a-loopback']).toMatchObject({ status: 'fail', detail: 'boom' });
    expect(c['headset-tone']).toMatchObject({ status: 'fail', detail: 'boom' });
  });
});
