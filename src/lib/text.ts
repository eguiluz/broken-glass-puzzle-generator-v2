import type { Font } from 'opentype.js';
import type { Pt } from './shatter';

export interface TextLayout {
  text: string;
  size: number; // mm — cap height
  x: number; // 0..1 — centre of the text across the sheet
  y: number; // 0..1 — centre of the text down the sheet
}

const MARGIN = 6; // mm kept clear between the text and the sheet edge
const CURVE_STEP = 0.6; // mm — chord length when flattening glyph curves

/**
 * Glyph outlines of `layout.text` as closed rings in sheet millimetres (outer contours and
 * counters alike; the ink is their even-odd fill). The text shrinks if it wouldn't fit.
 */
export function textRings(font: Font, layout: TextLayout, W: number, H: number): Pt[][] {
  const text = layout.text.trim();
  if (!text || layout.size <= 0) return [];
  const capRatio = (font.tables.os2?.sCapHeight || 0.7 * font.unitsPerEm) / font.unitsPerEm;
  let fontSize = layout.size / capRatio;

  let rings = flatten(font.getPath(text, 0, 0, fontSize).commands);
  let box = bounds(rings);
  if (!box) return [];
  // Shrink to fit inside the margins.
  const fit = Math.min(1, (W - 2 * MARGIN) / (box.x1 - box.x0), (H - 2 * MARGIN) / (box.y1 - box.y0));
  if (fit < 1) {
    fontSize *= fit;
    rings = flatten(font.getPath(text, 0, 0, fontSize).commands);
    box = bounds(rings)!;
  }

  const w = box.x1 - box.x0;
  const h = box.y1 - box.y0;
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  const cx = clamp(layout.x * W, MARGIN + w / 2, W - MARGIN - w / 2);
  const cy = clamp(layout.y * H, MARGIN + h / 2, H - MARGIN - h / 2);
  const dx = cx - (box.x0 + box.x1) / 2;
  const dy = cy - (box.y0 + box.y1) / 2;
  return rings.map((r) => r.map(([x, y]) => [x + dx, y + dy] as Pt));
}

type Cmd = { type: string; x?: number; y?: number; x1?: number; y1?: number; x2?: number; y2?: number };

function flatten(commands: Cmd[]): Pt[][] {
  const rings: Pt[][] = [];
  let ring: Pt[] = [];
  let cur: Pt = [0, 0];
  const close = () => {
    // Drop the duplicated closing point and zero-length steps.
    const out: Pt[] = [];
    for (const p of ring) {
      const q = out[out.length - 1];
      if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-4) out.push(p);
    }
    while (out.length > 1 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) <= 1e-4)
      out.pop();
    if (out.length >= 3) rings.push(out);
    ring = [];
  };
  for (const c of commands) {
    if (c.type === 'M') {
      if (ring.length) close();
      cur = [c.x!, c.y!];
      ring.push(cur);
    } else if (c.type === 'L') {
      cur = [c.x!, c.y!];
      ring.push(cur);
    } else if (c.type === 'Q' || c.type === 'C') {
      const p0 = cur;
      const p3: Pt = [c.x!, c.y!];
      const c1: Pt = [c.x1!, c.y1!];
      const c2: Pt = c.type === 'C' ? [c.x2!, c.y2!] : c1;
      const approx = Math.hypot(c1[0] - p0[0], c1[1] - p0[1]) + Math.hypot(c2[0] - c1[0], c2[1] - c1[1]) + Math.hypot(p3[0] - c2[0], p3[1] - c2[1]);
      const n = Math.max(2, Math.ceil(approx / CURVE_STEP));
      for (let i = 1; i <= n; i++) {
        const t = i / n;
        const s = 1 - t;
        ring.push(
          c.type === 'Q'
            ? [s * s * p0[0] + 2 * s * t * c1[0] + t * t * p3[0], s * s * p0[1] + 2 * s * t * c1[1] + t * t * p3[1]]
            : [
                s * s * s * p0[0] + 3 * s * s * t * c1[0] + 3 * s * t * t * c2[0] + t * t * t * p3[0],
                s * s * s * p0[1] + 3 * s * s * t * c1[1] + 3 * s * t * t * c2[1] + t * t * t * p3[1],
              ],
        );
      }
      cur = p3;
    } else if (c.type === 'Z') {
      close();
    }
  }
  if (ring.length) close();
  return rings;
}

function bounds(rings: Pt[][]) {
  if (!rings.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rings)
    for (const [x, y] of r) {
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
  return { x0, y0, x1, y1 };
}
