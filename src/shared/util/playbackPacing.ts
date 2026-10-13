/**
 * Playback pacing for translated speech. Translations often run longer than the source and
 * arrive in bursts, so audio queues up. Translated audio is NEVER dropped: instead the next
 * chunks are played faster (pitch-preserving time-stretch, see TimeStretcher) until the
 * queue drains — mildly with a small queue, up to 1.6× when far behind.
 */
export const PACING_STEPS: readonly { aboveS: number; tempo: number }[] = [
  { aboveS: 8, tempo: 1.6 },
  { aboveS: 4, tempo: 1.4 },
  { aboveS: 2, tempo: 1.25 },
  { aboveS: 0.5, tempo: 1.1 },
];

/** Tempo for a chunk scheduled behind `backlogS` seconds of queued audio. */
export function catchupTempo(backlogS: number): number {
  for (const step of PACING_STEPS) if (backlogS > step.aboveS) return step.tempo;
  return 1;
}
