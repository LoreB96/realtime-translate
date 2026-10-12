import { describe, it, expect, beforeEach } from 'vitest';
import { HealthMonitor, findMissingRoles, outputStreamKey } from '@main/health/healthMonitor';
import type { DeviceInventory, HealthReport } from '@shared/types';

const TRANSLATING = { A: 'mic', B: 'fromCall' } as const;
const PASSTHROUGH = { 'pass-A': 'mic', 'pass-B': 'fromCall' } as const;

interface Level {
  streamId: string;
  rmsDb: number;
  peakDb: number;
  digitalSilence: boolean;
  gateOpenMs?: number;
}

const silent = (streamId: string): Level => ({ streamId, rmsDb: -120, peakDb: -120, digitalSilence: true });
const loud = (streamId: string) => ({ streamId, rmsDb: -30, peakDb: -10, digitalSilence: false });

describe('HealthMonitor', () => {
  let t: number;
  let changes: HealthReport[];
  let hm: HealthMonitor;

  beforeEach(() => {
    t = 1_000_000;
    changes = [];
    hm = new HealthMonitor({ now: () => t, onChange: (r) => changes.push(r) });
  });

  /** Feeds level reports every 500 ms for `ms`. */
  const feed = (report: Level, ms: number): void => {
    for (let elapsed = 0; elapsed <= ms; elapsed += 500) {
      hm.onLevel(report);
      t += 500;
    }
    t -= 500;
  };

  const codes = (): string[] => hm.getReport().issues.map((i) => `${i.code}:${i.role}`);

  it('raises mic-silent only after 10 s of digital silence from the start', () => {
    hm.setMode('translating', { ...TRANSLATING });
    feed(silent('A'), 9500);
    expect(codes()).toEqual([]);
    feed(silent('A'), 500);
    expect(codes()).toEqual(['mic-silent:mic']);
    // First real audio clears it at once.
    hm.onLevel(loud('A'));
    expect(codes()).toEqual([]);
  });

  it('silence after the stream has delivered audio is a pause, not a problem', () => {
    hm.setMode('translating', { ...TRANSLATING });
    hm.onLevel(loud('A'));
    hm.onLevel(loud('B'));
    feed(silent('A'), 120_000);
    feed(silent('B'), 120_000);
    expect(codes()).toEqual([]);
  });

  it('raises call-silent after 15 s while translating when CABLE-B never had audio', () => {
    hm.setMode('translating', { ...TRANSLATING });
    feed(silent('B'), 14_500);
    expect(codes()).toEqual([]);
    feed(silent('B'), 500);
    expect(codes()).toEqual(['call-silent:fromCall']);
  });

  it('resetStream() re-arms silence detection after a device re-open', () => {
    hm.setMode('translating', { ...TRANSLATING });
    hm.onLevel(loud('B'));
    hm.resetStream('B');
    feed(silent('B'), 15_000);
    expect(codes()).toEqual(['call-silent:fromCall']);
  });

  it('raises no silence issues in passthrough (often no call yet)', () => {
    hm.setMode('passthrough', { ...PASSTHROUGH });
    feed(silent('pass-B'), 30_000);
    feed(silent('pass-A'), 30_000);
    expect(codes()).toEqual([]);
  });

  describe('signal below the translation gate', () => {
    const quietSpeech = (streamId: string, gateOpenMs = 0) => ({
      streamId,
      rmsDb: -62,
      peakDb: -42,
      digitalSilence: false,
      gateOpenMs,
    });

    it('raises call-quiet when there is sound but the gate stays closed', () => {
      hm.setMode('translating', { ...TRANSLATING });
      feed(quietSpeech('B'), 5000); // 11 windows
      expect(codes()).toEqual([]);
      feed(quietSpeech('B'), 500);
      expect(codes()).toEqual(['call-quiet:fromCall']);
      // The gate opens (louder speech): cleared.
      hm.onLevel(quietSpeech('B', 300));
      expect(codes()).toEqual([]);
    });

    it('raises mic-quiet for the mic stream', () => {
      hm.setMode('translating', { ...TRANSLATING });
      feed(quietSpeech('A'), 6000);
      expect(codes()).toEqual(['mic-quiet:mic']);
    });

    it('ignores idle lines, reports without gate info, and passthrough', () => {
      hm.setMode('translating', { ...TRANSLATING });
      feed({ streamId: 'B', rmsDb: -80, peakDb: -65, digitalSilence: false, gateOpenMs: 0 }, 30_000);
      feed({ streamId: 'A', rmsDb: -62, peakDb: -42, digitalSilence: false }, 30_000);
      expect(codes()).toEqual([]);
      hm.setMode('passthrough', { ...PASSTHROUGH });
      feed(quietSpeech('pass-B'), 30_000);
      expect(codes()).toEqual([]);
    });

    it('a run of quiet windows ends after a long gap', () => {
      hm.setMode('translating', { ...TRANSLATING });
      feed(quietSpeech('B'), 4000); // 9 windows
      t += 11_000; // > 10 s without sound
      feed(quietSpeech('B'), 4000);
      expect(codes()).toEqual([]);
    });
  });

  it('ignores unknown stream ids', () => {
    hm.setMode('translating', { ...TRANSLATING });
    feed(silent('pass-A'), 20_000);
    hm.onStreamEvent({ streamId: 'diag', kind: 'track-ended' });
    expect(codes()).toEqual([]);
    expect(changes).toHaveLength(1); // only the mode change
  });

  it('maps stream events to issues', () => {
    hm.setMode('translating', { ...TRANSLATING });
    hm.onStreamEvent({ streamId: 'B', kind: 'track-ended' });
    hm.onStreamEvent({ streamId: 'A', kind: 'context-suspended', detail: 'interrupted' });
    expect(codes()).toEqual(['device-failed:fromCall', 'audio-suspended:mic']);
    hm.onStreamEvent({ streamId: 'A', kind: 'context-resumed' });
    expect(codes()).toEqual(['device-failed:fromCall']);
  });

  it('maps output-side events to the output role', () => {
    hm.setMode('translating', {
      ...TRANSLATING,
      [outputStreamKey('A')]: 'toCall',
      [outputStreamKey('B')]: 'headset',
    });
    hm.onStreamEvent({ streamId: 'B', kind: 'context-suspended', side: 'output' });
    hm.onStreamEvent({ streamId: 'A', kind: 'track-ended', side: 'output', detail: 'audio-context-error' });
    hm.onStreamEvent({ streamId: 'B', kind: 'track-ended', side: 'input' });
    expect(codes()).toEqual(['device-failed:toCall', 'device-failed:fromCall', 'audio-suspended:headset']);
    // Output side without a mapping is ignored.
    hm.setMode('translating', { ...TRANSLATING });
    hm.onStreamEvent({ streamId: 'A', kind: 'context-suspended', side: 'output' });
    expect(codes()).toEqual(['device-failed:toCall', 'device-failed:fromCall']);
  });

  it('mode change clears stream-derived issues and silence tracking', () => {
    hm.setMode('translating', { ...TRANSLATING });
    feed(silent('A'), 10_000);
    hm.onStreamEvent({ streamId: 'A', kind: 'context-suspended' });
    hm.reportFailure('headset', 'setSinkId failed');
    hm.setMode('passthrough', { ...PASSTHROUGH });
    expect(codes()).toEqual(['device-failed:headset']);
    // Silence run restarts with the new streams.
    hm.setMode('translating', { ...TRANSLATING });
    feed(silent('A'), 9500);
    expect(codes()).toEqual(['device-failed:headset']);
  });

  it("'off' keeps device failures and device-missing (the troubleshooting screen shows them)", () => {
    hm.setMode('translating', { ...TRANSLATING });
    hm.reportFailure('mic', 'NotReadableError');
    hm.setMissing(['headset']);
    hm.setMode('off', {});
    expect(codes()).toEqual(['device-missing:headset', 'device-failed:mic']);
  });
  it('setMissing replaces the exact set', () => {
    hm.setMissing(['mic', 'toCall']);
    expect(codes()).toEqual(['device-missing:mic', 'device-missing:toCall']);
    hm.setMissing(['toCall']);
    expect(codes()).toEqual(['device-missing:toCall']);
    hm.setMissing([]);
    expect(codes()).toEqual([]);
  });

  it('reportFailure / clearFailure; clearFailure also clears audio-suspended', () => {
    hm.setMode('translating', { ...TRANSLATING });
    hm.reportFailure('mic', 'boom');
    hm.onStreamEvent({ streamId: 'A', kind: 'context-suspended' });
    expect(hm.needsRecovery()).toBe(true);
    hm.clearFailure('mic');
    expect(codes()).toEqual([]);
    expect(hm.needsRecovery()).toBe(false);
  });

  it('sorts issues by severity, then role', () => {
    hm.setMode('translating', { ...TRANSLATING });
    feed(silent('B'), 15_000);
    feed(silent('A'), 10_000);
    hm.onStreamEvent({ streamId: 'A', kind: 'context-suspended' });
    hm.reportFailure('headset', 'x');
    hm.setMissing(['toCall']);
    expect(codes()).toEqual([
      'device-missing:toCall',
      'device-failed:headset',
      'audio-suspended:mic',
      'mic-silent:mic',
      'call-silent:fromCall',
    ]);
  });

  it('fires onChange only when issues or mode change', () => {
    hm.setMode('translating', { ...TRANSLATING });
    hm.setMode('translating', { ...TRANSLATING });
    expect(changes).toHaveLength(1);
    feed(silent('A'), 10_000); // raised once, then repeated silent reports change nothing
    expect(changes).toHaveLength(2);
    hm.setMissing(['headset']);
    hm.setMissing(['headset']);
    hm.reportFailure('mic', 'a');
    hm.reportFailure('mic', 'a');
    expect(changes).toHaveLength(4);
    hm.reportFailure('mic', 'b'); // detail changed
    expect(changes).toHaveLength(5);
    hm.clearFailure('toCall'); // nothing to clear
    expect(changes).toHaveLength(5);
    expect(changes.at(-1)!.mode).toBe('translating');
  });

  it('keeps sinceMs from the first time an issue was raised', () => {
    hm.reportFailure('mic', 'a');
    const first = hm.getReport().issues[0]!.sinceMs;
    t += 10_000;
    hm.reportFailure('mic', 'b');
    expect(hm.getReport().issues[0]!.sinceMs).toBe(first);
  });

  it('getReport returns copies', () => {
    hm.reportFailure('mic', 'a');
    const r = hm.getReport();
    r.issues[0]!.detail = 'tampered';
    r.issues.pop();
    expect(hm.getReport().issues[0]!.detail).toBe('a');
  });
});

describe('findMissingRoles', () => {
  const inv: DeviceInventory = {
    inputs: [{ deviceId: 'mic-1', label: 'Mic', kind: 'audioinput' }],
    outputs: [{ deviceId: 'hs-1', label: 'Headset', kind: 'audiooutput' }],
    cableA: {
      playback: { deviceId: 'ca-in', label: 'CABLE-A Input', kind: 'audiooutput' },
      recording: { deviceId: 'ca-out', label: 'CABLE-A Output', kind: 'audioinput' },
    },
    cableB: { recording: { deviceId: 'cb-out', label: 'CABLE-B Output', kind: 'audioinput' } },
  };

  it('finds cable devices outside inputs/outputs', () => {
    expect(
      findMissingRoles({ mic: 'mic-1', toCall: 'ca-in', fromCall: 'cb-out', headset: 'hs-1' }, inv),
    ).toEqual([]);
  });

  it('reports absent devices and checks the right direction', () => {
    expect(
      findMissingRoles({ mic: 'gone', toCall: 'ca-out', fromCall: 'cb-out', headset: 'hs-1' }, inv),
    ).toEqual(['mic', 'toCall']);
  });

  it('skips unsaved and pseudo devices', () => {
    expect(
      findMissingRoles({ mic: 'default', toCall: undefined, fromCall: 'communications', headset: '' }, inv),
    ).toEqual([]);
  });
});
