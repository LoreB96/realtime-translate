import { describe, it, expect } from 'vitest';
import {
  callDeviceLabels,
  FALLBACK_CALL_MIC_LABEL,
  FALLBACK_CALL_SPEAKER_LABEL,
} from '@renderer/views/setup/shared/cables';
import type { DeviceInventory } from '@shared/types';

describe('callDeviceLabels', () => {
  it('falls back to the stock VB-Cable names without an inventory', () => {
    expect(callDeviceLabels(undefined)).toEqual({
      mic: FALLBACK_CALL_MIC_LABEL,
      speaker: FALLBACK_CALL_SPEAKER_LABEL,
    });
  });

  it('uses CABLE-A recording as the call mic and CABLE-B playback as the call speaker', () => {
    const inv: DeviceInventory = {
      inputs: [],
      outputs: [],
      cableA: {
        playback: { deviceId: 'a-in', label: 'CABLE-A Input (VB-Audio Cable A)', kind: 'audiooutput' },
        recording: { deviceId: 'a-out', label: 'CABLE-A Output (VB-Audio Cable A) ', kind: 'audioinput' },
      },
      cableB: {
        playback: { deviceId: 'b-in', label: 'CABLE-B Input (VB-Audio Cable B)', kind: 'audiooutput' },
      },
    };
    expect(callDeviceLabels(inv)).toEqual({
      mic: 'CABLE-A Output (VB-Audio Cable A)',
      speaker: 'CABLE-B Input (VB-Audio Cable B)',
    });
  });

  it('falls back per side when a cable or its label is missing', () => {
    const inv: DeviceInventory = {
      inputs: [],
      outputs: [],
      cableB: { playback: { deviceId: 'b-in', label: '  ', kind: 'audiooutput' } },
    };
    expect(callDeviceLabels(inv)).toEqual({
      mic: FALLBACK_CALL_MIC_LABEL,
      speaker: FALLBACK_CALL_SPEAKER_LABEL,
    });
  });
});
