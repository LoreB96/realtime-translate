import { describe, it, expect } from 'vitest';
import { detectVirtualCables, type DeviceInfo } from '@main/audio/deviceDetector';

const dev = (kind: 'audioinput' | 'audiooutput', label: string, deviceId = label): DeviceInfo => ({
  kind,
  label,
  deviceId,
});

describe('detectVirtualCables', () => {
  it('finds VB-CABLE A input/output', () => {
    const devices: DeviceInfo[] = [
      dev('audiooutput', 'CABLE-A Input (VB-Audio Cable A)'),
      dev('audioinput', 'CABLE-A Output (VB-Audio Cable A)'),
      dev('audiooutput', 'Speakers (Realtek)'),
      dev('audioinput', 'Mic (USB)'),
    ];
    const result = detectVirtualCables(devices);
    expect(result.cableA?.playback?.label).toContain('CABLE-A Input');
    expect(result.cableA?.recording?.label).toContain('CABLE-A Output');
  });

  it('finds VB-CABLE B input/output', () => {
    const devices: DeviceInfo[] = [
      dev('audiooutput', 'CABLE-B Input (VB-Audio Cable B)'),
      dev('audioinput', 'CABLE-B Output (VB-Audio Cable B)'),
    ];
    const result = detectVirtualCables(devices);
    expect(result.cableB?.playback?.label).toContain('CABLE-B Input');
    expect(result.cableB?.recording?.label).toContain('CABLE-B Output');
  });

  it('handles alternate label formats', () => {
    const devices: DeviceInfo[] = [
      dev('audiooutput', 'VB-Audio Cable A Input'),
      dev('audioinput', 'VB-Audio Cable A Output'),
    ];
    const result = detectVirtualCables(devices);
    expect(result.cableA?.playback).toBeDefined();
    expect(result.cableA?.recording).toBeDefined();
  });

  it('returns undefined for missing cables', () => {
    const devices: DeviceInfo[] = [
      dev('audioinput', 'Mic'),
      dev('audiooutput', 'Speakers'),
    ];
    const result = detectVirtualCables(devices);
    expect(result.cableA).toBeUndefined();
    expect(result.cableB).toBeUndefined();
  });

  it('listRealDevices excludes virtual cables', () => {
    const devices: DeviceInfo[] = [
      dev('audioinput', 'Mic (USB)'),
      dev('audioinput', 'CABLE-A Output'),
      dev('audiooutput', 'Speakers'),
      dev('audiooutput', 'CABLE-B Input'),
    ];
    const real = detectVirtualCables(devices).realDevices;
    expect(real.inputs.map((d) => d.label)).toEqual(['Mic (USB)']);
    expect(real.outputs.map((d) => d.label)).toEqual(['Speakers']);
  });

  it('falls back to basic VB-CABLE (no A/B suffix) for cableA', () => {
    const devices: DeviceInfo[] = [
      dev('audiooutput', 'CABLE Input (VB-Audio Virtual Cable)'),
      dev('audioinput', 'CABLE Output (VB-Audio Virtual Cable)'),
      dev('audiooutput', 'Speakers (Realtek)'),
      dev('audioinput', 'Mic (USB)'),
    ];
    const result = detectVirtualCables(devices);
    expect(result.cableA?.playback?.label).toBe('CABLE Input (VB-Audio Virtual Cable)');
    expect(result.cableA?.recording?.label).toBe('CABLE Output (VB-Audio Virtual Cable)');
    expect(result.cableB).toBeUndefined();
    // Basic CABLE should also be filtered out of real devices.
    expect(result.realDevices.outputs.map((d) => d.label)).toEqual(['Speakers (Realtek)']);
    expect(result.realDevices.inputs.map((d) => d.label)).toEqual(['Mic (USB)']);
  });

  it('prefers explicit CABLE-A over basic CABLE when both present', () => {
    const devices: DeviceInfo[] = [
      dev('audiooutput', 'CABLE-A Input (VB-Audio Cable A)'),
      dev('audioinput', 'CABLE-A Output (VB-Audio Cable A)'),
      dev('audiooutput', 'CABLE Input (VB-Audio Virtual Cable)'),
      dev('audioinput', 'CABLE Output (VB-Audio Virtual Cable)'),
    ];
    const result = detectVirtualCables(devices);
    expect(result.cableA?.playback?.label).toBe('CABLE-A Input (VB-Audio Cable A)');
    expect(result.cableA?.recording?.label).toBe('CABLE-A Output (VB-Audio Cable A)');
  });

  it("ignores Chromium's 'default'/'communications' pseudo-devices (listed first on Windows)", () => {
    const devices: DeviceInfo[] = [
      { kind: 'audiooutput', deviceId: 'default', label: 'Default - CABLE-A Input (VB-Audio Cable A)' },
      { kind: 'audiooutput', deviceId: 'communications', label: 'Communications - Headset (USB)' },
      { kind: 'audioinput', deviceId: 'default', label: 'Default - Mic (USB)' },
      { kind: 'audioinput', deviceId: 'communications', label: 'Communications - CABLE-B Output (VB-Audio Cable B)' },
      { kind: 'audiooutput', deviceId: 'id-cable-a-in', label: 'CABLE-A Input (VB-Audio Cable A)' },
      { kind: 'audioinput', deviceId: 'id-cable-a-out', label: 'CABLE-A Output (VB-Audio Cable A)' },
      { kind: 'audiooutput', deviceId: 'id-cable-b-in', label: 'CABLE-B Input (VB-Audio Cable B)' },
      { kind: 'audioinput', deviceId: 'id-cable-b-out', label: 'CABLE-B Output (VB-Audio Cable B)' },
      { kind: 'audiooutput', deviceId: 'id-headset', label: 'Headset (USB)' },
      { kind: 'audioinput', deviceId: 'id-mic', label: 'Mic (USB)' },
    ];
    const result = detectVirtualCables(devices);
    expect(result.cableA?.playback?.deviceId).toBe('id-cable-a-in');
    expect(result.cableB?.recording?.deviceId).toBe('id-cable-b-out');
    expect(result.realDevices.inputs.map((d) => d.deviceId)).toEqual(['id-mic']);
    expect(result.realDevices.outputs.map((d) => d.deviceId)).toEqual(['id-headset']);
  });
});
