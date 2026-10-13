import { describe, it, expect } from 'vitest';
import { catchupTempo } from '@shared/util/playbackPacing';

describe('catchupTempo', () => {
  it('plays at normal speed with a short queue', () => {
    expect(catchupTempo(0)).toBe(1);
    expect(catchupTempo(0.5)).toBe(1);
  });

  it('speeds up gradually as the queue grows, up to 1.6x and never more', () => {
    expect(catchupTempo(1)).toBe(1.1);
    expect(catchupTempo(3)).toBe(1.25);
    expect(catchupTempo(5)).toBe(1.4);
    expect(catchupTempo(9)).toBe(1.6);
    expect(catchupTempo(600)).toBe(1.6);
  });
});
