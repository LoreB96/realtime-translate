import type { DeviceInventory } from '../../../../shared/types';

/**
 * Returns true iff both VB-CABLE A and CABLE-B are detected with both their
 * playback (input) and recording (output) sides. The wizard's Step 3 gates
 * progression on this; the review screen uses it to show the cables section
 * as ok/warn. The full 4-clause check ensures we don't show a green status
 * when only one cable is partially detected.
 */
export function bothCablesPresent(inv: DeviceInventory): boolean {
  return Boolean(
    inv.cableA?.playback && inv.cableA?.recording &&
    inv.cableB?.playback && inv.cableB?.recording,
  );
}

/** Labels shown when the inventory hasn't loaded or the cables aren't installed yet. */
export const FALLBACK_CALL_MIC_LABEL = 'CABLE-A Output (VB-Audio Cable A)';
export const FALLBACK_CALL_SPEAKER_LABEL = 'CABLE-B Input (VB-Audio Cable B)';

/**
 * The exact device names the user must pick inside the call app (Meet/Teams/Zoom):
 * its microphone is CABLE-A's recording side, its speaker is CABLE-B's playback side.
 * Uses the real labels from the inventory (they vary slightly across VB-Cable versions
 * and Windows languages) with the stock names as fallback.
 */
export function callDeviceLabels(inv: DeviceInventory | undefined): { mic: string; speaker: string } {
  return {
    mic: inv?.cableA?.recording?.label?.trim() || FALLBACK_CALL_MIC_LABEL,
    speaker: inv?.cableB?.playback?.label?.trim() || FALLBACK_CALL_SPEAKER_LABEL,
  };
}
