import type { Pt } from './shatter';

export type SheetShape = 'rect' | 'rounded' | 'circle' | 'heart';

const STEP = 1; // mm between outline points on curves

/**
 * Outline of the sheet in mm, filling the W×H box: a rectangle, a rectangle with rounded
 * corners (radius `corner`), an ellipse, or a heart.
 */
export function sheetOutline(shape: SheetShape, W: number, H: number, corner = 0): Pt[] {
  if (shape === 'circle') {
    const perimeter = Math.PI * (3 * (W + H) / 2 - Math.sqrt(((3 * W) / 2 + H / 2) * (W / 2 + (3 * H) / 2)));
    const n = Math.max(64, Math.ceil(perimeter / STEP));
    return Array.from({ length: n }, (_, i) => {
      const a = (i / n) * Math.PI * 2;
      return [W / 2 + (W / 2) * Math.cos(a), H / 2 + (H / 2) * Math.sin(a)] as Pt;
    });
  }
  if (shape === 'heart') {
    // The classic heart curve, tip down, stretched to fill the box.
    const n = 480;
    const raw = Array.from({ length: n }, (_, i) => {
      const t = (i / n) * Math.PI * 2;
      const x = 16 * Math.sin(t) ** 3;
      const y = -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t));
      return [x, y] as Pt;
    });
    const xs = raw.map((q) => q[0]);
    const ys = raw.map((q) => q[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    return dedupe(raw.map(([x, y]) => [((x - x0) / (x1 - x0)) * W, ((y - y0) / (y1 - y0)) * H] as Pt));
  }
  const r = shape === 'rounded' ? Math.max(0, Math.min(corner, W / 2, H / 2)) : 0;
  if (r <= 0) {
    return [
      [0, 0],
      [W, 0],
      [W, H],
      [0, H],
    ];
  }
  const arc = Math.max(4, Math.ceil((r * Math.PI) / 2 / STEP));
  const out: Pt[] = [];
  const corners: [number, number, number][] = [
    [W - r, r, -Math.PI / 2], // top right, from the top edge
    [W - r, H - r, 0], // bottom right
    [r, H - r, Math.PI / 2], // bottom left
    [r, r, Math.PI], // top left
  ];
  for (const [cx, cy, start] of corners)
    for (let i = 0; i <= arc; i++) {
      const a = start + (i / arc) * (Math.PI / 2);
      out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
  return dedupe(out);
}

/** Drop consecutive points closer than a micron (also across the closing seam). */
function dedupe(pts: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of pts) {
    const q = out[out.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-3) out.push(p);
  }
  while (out.length > 2 && Math.hypot(out[0][0] - out.at(-1)![0], out[0][1] - out.at(-1)![1]) <= 1e-3) out.pop();
  return out;
}
