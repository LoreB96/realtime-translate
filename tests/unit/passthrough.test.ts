import { describe, it, expect, beforeEach } from 'vitest';
import {
  failedRole,
  Passthrough,
  PASSTHROUGH_A,
  PASSTHROUGH_B,
  type PassthroughOffscreen,
} from '@main/audio/passthrough';
import type { DeviceRole } from '@shared/types';

class FakeOffscreen implements PassthroughOffscreen {
  started: { streamId: string; input: string; output: string }[] = [];
  stopped: string[] = [];
  failFor = new Set<string>();

  async startPassthrough(streamId: string, input: string, output: string): Promise<void> {
    if (this.failFor.has(streamId)) throw new Error(`no device for ${streamId}`);
    this.started.push({ streamId, input, output });
  }
  stopStream(streamId: string): void {
    this.stopped.push(streamId);
  }
}

const DEVICES = { mic: 'mic', toMeet: 'cableA-in', fromMeet: 'cableB-out', headset: 'hs' };

describe('Passthrough', () => {
  let off: FakeOffscreen;
  let pt: Passthrough;

  beforeEach(() => {
    off = new FakeOffscreen();
    pt = new Passthrough(off);
  });

  it('routes mic to CABLE-A and CABLE-B to headset when enabled', async () => {
    await pt.sync(DEVICES, true);
    expect(off.started).toEqual([
      { streamId: PASSTHROUGH_A, input: 'mic', output: 'cableA-in' },
      { streamId: PASSTHROUGH_B, input: 'cableB-out', output: 'hs' },
    ]);
  });

  it('does nothing when disabled or devices are incomplete', async () => {
    await pt.sync(DEVICES, false);
    await pt.sync({ ...DEVICES, headset: undefined }, true);
    await pt.sync(undefined, true);
    expect(off.started).toEqual([]);
    expect(off.stopped).toEqual([]);
  });

  it('ignores Chromium default/communications pseudo-devices', async () => {
    await pt.sync({ ...DEVICES, mic: 'default' }, true);
    await pt.sync({ ...DEVICES, headset: 'communications' }, true);
    expect(off.started).toEqual([]);
  });

  it('is idempotent for the same devices', async () => {
    await pt.sync(DEVICES, true);
    await pt.sync({ ...DEVICES }, true);
    expect(off.started).toHaveLength(2);
    expect(off.stopped).toEqual([]);
  });

  it('stops both streams when disabled', async () => {
    await pt.sync(DEVICES, true);
    await pt.sync(DEVICES, false);
    expect(off.stopped).toEqual([PASSTHROUGH_A, PASSTHROUGH_B]);
  });

  it('restarts on device change', async () => {
    await pt.sync(DEVICES, true);
    await pt.sync({ ...DEVICES, headset: 'speakers' }, true);
    expect(off.stopped).toEqual([PASSTHROUGH_A, PASSTHROUGH_B]);
    expect(off.started.at(-1)).toEqual({
      streamId: PASSTHROUGH_B,
      input: 'cableB-out',
      output: 'speakers',
    });
  });

  it('keeps one direction when the other fails to start', async () => {
    off.failFor.add(PASSTHROUGH_B);
    await expect(pt.sync(DEVICES, true)).resolves.toBeUndefined();
    expect(off.started).toEqual([{ streamId: PASSTHROUGH_A, input: 'mic', output: 'cableA-in' }]);
  });

  it('stop() is a no-op when not running, and allows a later restart', async () => {
    pt.stop();
    expect(off.stopped).toEqual([]);
    await pt.sync(DEVICES, true);
    pt.stop();
    await pt.sync(DEVICES, true);
    expect(off.started).toHaveLength(4);
  });

  it('restart() re-opens both streams on the same devices', async () => {
    await pt.sync(DEVICES, true);
    await pt.restart();
    expect(off.stopped).toEqual([PASSTHROUGH_A, PASSTHROUGH_B]);
    expect(off.started).toHaveLength(4);
    expect(off.started.slice(2)).toEqual(off.started.slice(0, 2));
    expect(pt.isRunning).toBe(true);
  });

  it('restart() is a no-op when stopped', async () => {
    await pt.restart();
    expect(off.started).toEqual([]);
    expect(off.stopped).toEqual([]);
    expect(pt.isRunning).toBe(false);
  });

  it('reports failures and successes per role', async () => {
    const failures: [DeviceRole, string][] = [];
    const started: DeviceRole[] = [];
    pt = new Passthrough(off, undefined, {
      onFailure: (role, detail) => failures.push([role, detail]),
      onStarted: (role) => started.push(role),
    });
    off.failFor.add(PASSTHROUGH_B);
    await pt.sync(DEVICES, true);
    expect(started).toEqual(['mic', 'toCall']);
    expect(failures).toEqual([['fromCall', 'no device for pass-B']]);

    // The device comes back: restart() succeeds and reports the recovered roles.
    off.failFor.clear();
    started.length = 0;
    await pt.restart();
    expect(started.sort()).toEqual(['fromCall', 'headset', 'mic', 'toCall']);
  });
});

describe('Passthrough: per-stream control', () => {
  let off: FakeOffscreen;
  let pt: Passthrough;

  beforeEach(() => {
    off = new FakeOffscreen();
    pt = new Passthrough(off);
  });

  it('restartStream() re-opens only that direction', async () => {
    await pt.sync(DEVICES, true);
    expect(await pt.restartStream(PASSTHROUGH_B)).toBe(true);
    expect(off.stopped).toEqual([PASSTHROUGH_B]);
    expect(off.started.at(-1)).toEqual({ streamId: PASSTHROUGH_B, input: 'cableB-out', output: 'hs' });
    expect(off.started).toHaveLength(3);
  });

  it('restartStream() returns false when the device still fails', async () => {
    await pt.sync(DEVICES, true);
    off.failFor.add(PASSTHROUGH_B);
    expect(await pt.restartStream(PASSTHROUGH_B)).toBe(false);
  });

  it('a failed (e.g. timed-out) start stops the offscreen slot so a late handle is discarded', async () => {
    off.failFor.add(PASSTHROUGH_A);
    await pt.sync(DEVICES, true);
    expect(off.stopped).toEqual([PASSTHROUGH_A]);
  });

  it('runs a single direction (fallback) and adds the other without touching it', async () => {
    await pt.sync(DEVICES, true, [PASSTHROUGH_A]);
    expect(off.started.map((s) => s.streamId)).toEqual([PASSTHROUGH_A]);
    expect(pt.streams).toEqual([PASSTHROUGH_A]);
    await pt.sync(DEVICES, true, [PASSTHROUGH_A, PASSTHROUGH_B]);
    expect(off.started.map((s) => s.streamId)).toEqual([PASSTHROUGH_A, PASSTHROUGH_B]);
    expect(off.stopped).toEqual([]);
    await pt.sync(DEVICES, true, [PASSTHROUGH_B]);
    expect(off.stopped).toEqual([PASSTHROUGH_A]);
    await pt.sync(DEVICES, true, []);
    expect(pt.isRunning).toBe(false);
  });
});

describe('Passthrough: idle mic parking', () => {
  const MIN = 60_000;
  let off: FakeOffscreen;
  let pt: Passthrough;
  let t: number;

  const mic = (rmsDb: number) => ({ streamId: PASSTHROUGH_A, rmsDb, digitalSilence: false });
  const callZeros = { streamId: PASSTHROUGH_B, rmsDb: -120, digitalSilence: true };
  const callAudio = { streamId: PASSTHROUGH_B, rmsDb: -30, digitalSilence: false };

  beforeEach(async () => {
    t = 0;
    off = new FakeOffscreen();
    pt = new Passthrough(off, undefined, {}, { now: () => t, idleParkMs: 10 * MIN });
    await pt.sync(DEVICES, true);
  });

  it('asks to park after the idle time with no speech and no call audio', () => {
    t = 9 * MIN;
    expect(pt.onLevel(mic(-70))).toBeUndefined();
    expect(pt.onLevel(callZeros)).toBeUndefined();
    t = 10 * MIN;
    expect(pt.onLevel(callZeros)).toBe('park');
    pt.park();
    expect(pt.isMicParked).toBe(true);
    expect(off.stopped).toEqual([PASSTHROUGH_A]);
  });

  it('speech on the mic or audio from the call keeps the mic open', () => {
    t = 8 * MIN;
    pt.onLevel(mic(-35));
    t = 17 * MIN;
    expect(pt.onLevel(callZeros)).toBeUndefined();
    pt.onLevel(callAudio);
    t = 26 * MIN;
    expect(pt.onLevel(callZeros)).toBeUndefined();
  });

  it('call audio wakes a parked mic', async () => {
    t = 10 * MIN;
    pt.onLevel(callZeros);
    pt.park();
    expect(pt.onLevel(callAudio)).toBe('wake');
    await pt.wake();
    expect(pt.isMicParked).toBe(false);
    expect(off.started.at(-1)?.streamId).toBe(PASSTHROUGH_A);
  });

  it('a full sync (Stop / Settings closed) wakes a parked mic; restartStream leaves it parked', async () => {
    t = 10 * MIN;
    pt.park();
    expect(await pt.restartStream(PASSTHROUGH_A)).toBe(true);
    expect(off.started).toHaveLength(2);
    await pt.sync(DEVICES, true);
    expect(pt.isMicParked).toBe(false);
    expect(off.started.at(-1)?.streamId).toBe(PASSTHROUGH_A);
  });

  it('never parks a single-direction fallback', async () => {
    await pt.sync(DEVICES, true, [PASSTHROUGH_A]);
    t = 60 * MIN;
    expect(pt.onLevel(mic(-90))).toBeUndefined();
  });
});

describe('failedRole', () => {
  it('blames the input unless the message names the output path', () => {
    expect(failedRole(PASSTHROUGH_A, 'NotFoundError: Requested device not found')).toBe('mic');
    expect(failedRole(PASSTHROUGH_A, 'setSinkId failed: AbortError')).toBe('toCall');
    expect(failedRole(PASSTHROUGH_B, 'NotReadableError: Could not start audio source')).toBe(
      'fromCall',
    );
    expect(failedRole(PASSTHROUGH_B, 'output device unavailable')).toBe('headset');
  });
});
