/**
 * Pure window-bounds math (no Electron). Used by the transcript window to restore saved bounds
 * without ever placing the window somewhere the user cannot reach (unplugged monitor, resolution
 * change, corrupted prefs).
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

function isUsableRect(r: Rect): boolean {
  return (
    Number.isFinite(r.x) &&
    Number.isFinite(r.y) &&
    Number.isFinite(r.width) &&
    Number.isFinite(r.height) &&
    r.width > 0 &&
    r.height > 0
  );
}

/** Size clamped to the area; non-finite or non-positive sizes fall back to the area's size. */
function fitSize(size: number, max: number): number {
  if (!Number.isFinite(size) || size <= 0) return Math.max(1, Math.round(max));
  return Math.max(1, Math.round(Math.min(size, max)));
}

function clampAxis(pos: number, size: number, start: number, length: number): number {
  const max = start + length - size;
  return Math.round(Math.min(Math.max(pos, start), Math.max(start, max)));
}

function centerIn(width: number, height: number, area: Rect): Rect {
  const w = fitSize(width, area.width);
  const h = fitSize(height, area.height);
  return {
    x: Math.round(area.x + (area.width - w) / 2),
    y: Math.round(area.y + (area.height - h) / 2),
    width: w,
    height: h,
  };
}

/**
 * Returns bounds fully reachable: keeps size (clamped to the work area), moves the window onto
 * the display it overlaps most, or centers it on the primary work area when it overlaps none
 * (or when no position is stored).
 */
export function clampBoundsToDisplays(
  b: { x?: number; y?: number; width: number; height: number },
  workAreas: Rect[],
  primary: Rect,
): Rect {
  const { x, y } = b;
  if (x === undefined || y === undefined || !Number.isFinite(x) || !Number.isFinite(y)) {
    return centerIn(b.width, b.height, primary);
  }
  const width = Number.isFinite(b.width) && b.width > 0 ? b.width : primary.width;
  const height = Number.isFinite(b.height) && b.height > 0 ? b.height : primary.height;
  const wanted: Rect = { x, y, width, height };

  let best: Rect | undefined;
  let bestArea = 0;
  for (const area of workAreas) {
    if (!isUsableRect(area)) continue;
    const o = overlapArea(wanted, area);
    if (o > bestArea) {
      bestArea = o;
      best = area;
    }
  }
  if (!best) return centerIn(b.width, b.height, primary);

  const w = fitSize(width, best.width);
  const h = fitSize(height, best.height);
  return {
    x: clampAxis(x, w, best.x, best.width),
    y: clampAxis(y, h, best.y, best.height),
    width: w,
    height: h,
  };
}
