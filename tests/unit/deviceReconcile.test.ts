import { describe, it, expect } from 'vitest';
import { reconcileDevices } from '@main/audio/deviceReconcile';
import type { DeviceInventory } from '@shared/types';

const dev = (deviceId: string, label: string, kind: 'audioinput' | 'audiooutput') => ({
  deviceId,
  label,
  kind,
});

const inventory = (ids: { mic: string; head: string; a: string; b: string }): DeviceInventory => ({
  inputs: [dev(ids.mic, 'Microphone (Realtek)', 'audioinput')],
  outputs: [dev(ids.head, 'Headphones (Jabra)', 'audiooutput')],
  cableA: { playback: dev(ids.a, 'CABLE-A Input (VB-Audio Cable A)', 'audiooutput') },
  cableB: { recording: dev(ids.b, 'CABLE-B Output (VB-Audio Cable B)', 'audioinput') },
});

const saved = { mic: 'm1', toMeet: 'a1', fromMeet: 'b1', headset: 'h1' };

describe('reconcileDevices', () => {
  it('records the labels of the saved devices when they are present', () => {
    const r = reconcileDevices(saved, undefined, inventory({ mic: 'm1', head: 'h1', a: 'a1', b: 'b1' }));
    expect(r.devices).toEqual(saved);
    expect(r.remapped).toEqual([]);
    expect(r.changed).toBe(true);
    expect(r.labels).toEqual({
      m1: 'Microphone (Realtek)',
      a1: 'CABLE-A Input (VB-Audio Cable A)',
      b1: 'CABLE-B Output (VB-Audio Cable B)',
      h1: 'Headphones (Jabra)',
    });
    // Second pass: nothing to do.
    const again = reconcileDevices(r.devices, r.labels, inventory({ mic: 'm1', head: 'h1', a: 'a1', b: 'b1' }));
    expect(again.changed).toBe(false);
  });

  it('moves every choice to the new ids when Windows changed them', () => {
    const first = reconcileDevices(saved, undefined, inventory({ mic: 'm1', head: 'h1', a: 'a1', b: 'b1' }));
    const r = reconcileDevices(saved, first.labels, inventory({ mic: 'm2', head: 'h2', a: 'a2', b: 'b2' }));
    expect(r.devices).toEqual({ mic: 'm2', toMeet: 'a2', fromMeet: 'b2', headset: 'h2' });
    expect(r.remapped.sort()).toEqual(['fromMeet', 'headset', 'mic', 'toMeet']);
    expect(r.labels.m2).toBe('Microphone (Realtek)');
    expect(r.changed).toBe(true);
  });

  it('keeps an unplugged device (no match) and its label, so it can come back', () => {
    const labels = { m1: 'USB Mic', a1: 'CABLE-A Input (VB-Audio Cable A)', b1: 'CABLE-B Output (VB-Audio Cable B)', h1: 'Headphones (Jabra)' };
    const r = reconcileDevices(saved, labels, inventory({ mic: 'x', head: 'h1', a: 'a1', b: 'b1' }));
    expect(r.devices.mic).toBe('m1');
    expect(r.labels.m1).toBe('USB Mic');
    expect(r.remapped).toEqual([]);
  });

  it('does not guess when two devices share the label', () => {
    const inv = inventory({ mic: 'm2', head: 'h1', a: 'a1', b: 'b1' });
    inv.inputs.push(dev('m3', 'Microphone (Realtek)', 'audioinput'));
    const r = reconcileDevices(saved, { m1: 'Microphone (Realtek)' }, inv);
    expect(r.devices.mic).toBe('m1');
    expect(r.remapped).toEqual([]);
  });

  it('never matches an input label against outputs', () => {
    const inv = inventory({ mic: 'm2', head: 'h1', a: 'a1', b: 'b1' });
    inv.outputs.push(dev('o9', 'Microphone (Realtek) out', 'audiooutput'));
    const r = reconcileDevices({ headset: 'gone' }, { gone: 'Microphone (Realtek)' }, inv);
    expect(r.devices.headset).toBe('gone');
  });
});
