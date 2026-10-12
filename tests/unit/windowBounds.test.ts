import { describe, expect, it } from 'vitest';
import { clampBoundsToDisplays, type Rect } from '@main/windows/windowBounds';

const primary: Rect = { x: 0, y: 0, width: 1920, height: 1040 };
const right: Rect = { x: 1920, y: 0, width: 1280, height: 984 };

function fullyInside(r: Rect, area: Rect): boolean {
  return (
    r.x >= area.x &&
    r.y >= area.y &&
    r.x + r.width <= area.x + area.width &&
    r.y + r.height <= area.y + area.height
  );
}

describe('clampBoundsToDisplays', () => {
  it('keeps bounds that are fully inside a work area', () => {
    const b = { x: 100, y: 200, width: 420, height: 640 };
    expect(clampBoundsToDisplays(b, [primary], primary)).toEqual(b);
  });

  it('moves a partly off-screen window back inside the display', () => {
    const r = clampBoundsToDisplays(
      { x: 1700, y: 900, width: 420, height: 640 },
      [primary],
      primary,
    );
    expect(r).toEqual({ x: 1500, y: 400, width: 420, height: 640 });
    expect(fullyInside(r, primary)).toBe(true);
  });

  it('pulls a window with negative coordinates back inside', () => {
    const r = clampBoundsToDisplays(
      { x: -300, y: -50, width: 420, height: 640 },
      [primary],
      primary,
    );
    expect(r).toEqual({ x: 0, y: 0, width: 420, height: 640 });
  });

  it('centers on the primary work area when the window overlaps no display', () => {
    const r = clampBoundsToDisplays(
      { x: 5000, y: 5000, width: 420, height: 640 },
      [primary],
      primary,
    );
    expect(r).toEqual({ x: 750, y: 200, width: 420, height: 640 });
  });

  it('centers on the primary work area when no position is stored', () => {
    expect(clampBoundsToDisplays({ width: 420, height: 640 }, [primary], primary)).toEqual({
      x: 750,
      y: 200,
      width: 420,
      height: 640,
    });
  });

  it('shrinks a window larger than the work area', () => {
    const r = clampBoundsToDisplays(
      { x: 10, y: 10, width: 4000, height: 3000 },
      [primary],
      primary,
    );
    expect(r).toEqual({ x: 0, y: 0, width: 1920, height: 1040 });
  });

  it('shrinks and centers an oversized window with no stored position', () => {
    const small: Rect = { x: 0, y: 0, width: 800, height: 600 };
    expect(clampBoundsToDisplays({ width: 1000, height: 900 }, [small], small)).toEqual(small);
  });

  it('keeps a window on a secondary display', () => {
    const b = { x: 2000, y: 100, width: 420, height: 640 };
    expect(clampBoundsToDisplays(b, [primary, right], primary)).toEqual(b);
  });

  it('moves a window straddling two displays onto the one it overlaps most', () => {
    // 120 px on primary, 300 px on the right display.
    const r = clampBoundsToDisplays(
      { x: 1800, y: 100, width: 420, height: 640 },
      [primary, right],
      primary,
    );
    expect(r).toEqual({ x: 1920, y: 100, width: 420, height: 640 });
    expect(fullyInside(r, right)).toBe(true);
  });

  it('clamps to the secondary display size when that display is smaller', () => {
    const r = clampBoundsToDisplays(
      { x: 2500, y: 500, width: 420, height: 900 },
      [primary, right],
      primary,
    );
    expect(r).toEqual({ x: 2500, y: 84, width: 420, height: 900 });
    expect(fullyInside(r, right)).toBe(true);
  });

  it('falls back to primary when a secondary monitor was unplugged', () => {
    const r = clampBoundsToDisplays(
      { x: 2000, y: 100, width: 420, height: 640 },
      [primary],
      primary,
    );
    expect(r).toEqual({ x: 750, y: 200, width: 420, height: 640 });
  });

  it('handles displays with a non-zero origin (left / above primary)', () => {
    const left: Rect = { x: -1280, y: -200, width: 1280, height: 1024 };
    const r = clampBoundsToDisplays(
      { x: -1500, y: -300, width: 420, height: 640 },
      [primary, left],
      primary,
    );
    expect(r).toEqual({ x: -1280, y: -200, width: 420, height: 640 });
  });

  it('ignores non-finite stored values', () => {
    const r = clampBoundsToDisplays(
      { x: Number.NaN, y: 10, width: 420, height: 640 },
      [primary],
      primary,
    );
    expect(r).toEqual({ x: 750, y: 200, width: 420, height: 640 });
    const r2 = clampBoundsToDisplays(
      { x: 10, y: 10, width: Number.POSITIVE_INFINITY, height: 640 },
      [primary],
      primary,
    );
    expect(fullyInside(r2, primary)).toBe(true);
  });

  it('ignores degenerate work areas', () => {
    const r = clampBoundsToDisplays(
      { x: 10, y: 10, width: 420, height: 640 },
      [{ x: 0, y: 0, width: 0, height: 0 }, primary],
      primary,
    );
    expect(r).toEqual({ x: 10, y: 10, width: 420, height: 640 });
  });
});
