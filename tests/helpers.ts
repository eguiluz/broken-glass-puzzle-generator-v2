import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import opentype from 'opentype.js';
import type { Pt, ShatterParams } from '../src/lib/shatter';

/** The current default configuration of the app (see src/pages/index.astro). */
export const DEFAULTS: ShatterParams = {
  width: 300,
  height: 300,
  impact: [165, 180],
  pieces: 280,
  concentration: 0.75,
  sliver: 0.7,
  core: 30,
  coreSplit: 2,
  chaos: 0.55,
  ringBreak: 0.4,
  contrast: 0.5,
  tabSize: 5,
  tabDensity: 0.4,
  tabWidth: 1,
  tabWidthVariation: 0.4,
  tabStyle: 'barb',
  seed: 2024,
  kerf: 0.15,
  minWidth: 2,
  waviness: 0.5,
};

/** Parameters a link gets when it was made before any of the newer settings existed. */
export const LEGACY: Omit<ShatterParams, 'concentration' | 'tabStyle'> = {
  width: 300,
  height: 300,
  impact: [153, 237],
  pieces: 300,
  sliver: 0,
  core: 0,
  coreSplit: 8,
  chaos: 0,
  ringBreak: 0,
  contrast: 0,
  tabSize: 6,
  tabDensity: 1,
  tabWidth: 1,
  tabWidthVariation: 0,
  seed: 4242,
};

let font: opentype.Font | null = null;
export function loadFont(): opentype.Font {
  if (!font) {
    const path = fileURLToPath(
      new URL('../node_modules/@fontsource/chakra-petch/files/chakra-petch-latin-700-normal.woff', import.meta.url),
    );
    const buf = readFileSync(path);
    font = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
  }
  return font;
}

const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

/** Proper crossing of two segments (touching at an endpoint doesn't count). */
function crosses(p1: Pt, p2: Pt, q1: Pt, q2: Pt): boolean {
  const e = 1e-9;
  const d1 = cross(q1, q2, p1), d2 = cross(q1, q2, p2), d3 = cross(p1, p2, q1), d4 = cross(p1, p2, q2);
  return ((d1 > e && d2 < -e) || (d1 < -e && d2 > e)) && ((d3 > e && d4 < -e) || (d3 < -e && d4 > e));
}

/** Pieces whose closed outline crosses itself. */
export function selfIntersecting(pieces: Pt[][]): number {
  let bad = 0;
  for (const pl of pieces) {
    const n = pl.length;
    outer: for (let i = 0; i < n; i++) {
      for (let j = i + 2; j < n; j++) {
        if (i === 0 && j === n - 1) continue;
        if (crosses(pl[i], pl[(i + 1) % n], pl[j], pl[(j + 1) % n])) {
          bad++;
          break outer;
        }
      }
    }
  }
  return bad;
}

/**
 * Pairs of collinear cut segments sharing more than 0.05 mm: a line the laser would cut
 * twice. Segments are bucketed on a grid so large puzzles stay fast.
 */
export function overlappingCuts(cuts: Pt[][]): number {
  const segs: [Pt, Pt][] = [];
  for (const pl of cuts) for (let i = 1; i < pl.length; i++) segs.push([pl[i - 1], pl[i]]);
  const CELL = 5;
  const grid = new Map<string, number[]>();
  segs.forEach(([a, b], i) => {
    const x0 = Math.floor(Math.min(a[0], b[0]) / CELL), x1 = Math.floor(Math.max(a[0], b[0]) / CELL);
    const y0 = Math.floor(Math.min(a[1], b[1]) / CELL), y1 = Math.floor(Math.max(a[1], b[1]) / CELL);
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++) {
        const k = `${x},${y}`;
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k)!.push(i);
      }
  });
  const found = new Set<string>();
  for (const bucket of grid.values()) {
    for (let x = 0; x < bucket.length; x++)
      for (let y = x + 1; y < bucket.length; y++) {
        const i = bucket[x], j = bucket[y];
        const key = i < j ? `${i}-${j}` : `${j}-${i}`;
        if (!found.has(key) && overlap(segs[i], segs[j])) found.add(key);
      }
  }
  return found.size;
}

function overlap([a0, a1]: [Pt, Pt], [b0, b1]: [Pt, Pt]): boolean {
  const dx = a1[0] - a0[0], dy = a1[1] - a0[1];
  const L = Math.hypot(dx, dy);
  if (L < 1e-9) return false;
  const off = (q: Pt) => Math.abs((q[0] - a0[0]) * dy - (q[1] - a0[1]) * dx) / L;
  if (off(b0) > 1e-6 || off(b1) > 1e-6) return false;
  const t = (q: Pt) => ((q[0] - a0[0]) * dx + (q[1] - a0[1]) * dy) / L;
  const lo = Math.max(0, Math.min(t(b0), t(b1)));
  const hi = Math.min(L, Math.max(t(b0), t(b1)));
  return hi - lo > 0.05;
}

/**
 * Cut lines that stop in mid-air: points touched by a single cut segment, away from the
 * sheet outline. A cut there would not separate anything.
 */
export function looseEnds(cuts: Pt[][], outline: Pt[]): number {
  const key = (q: Pt) => `${q[0].toFixed(4)},${q[1].toFixed(4)}`;
  const deg = new Map<string, { n: number; q: Pt }>();
  for (const pl of cuts)
    for (let i = 1; i < pl.length; i++)
      for (const q of [pl[i - 1], pl[i]]) {
        const d = deg.get(key(q)) ?? { n: 0, q };
        d.n++;
        deg.set(key(q), d);
      }
  let loose = 0;
  for (const { n, q } of deg.values()) if (n === 1 && distanceToRings(q, [outline]) > 1e-3) loose++;
  return loose;
}

/** Area of a closed outline. */
export function areaOf(pl: Pt[]): number {
  let a = 0;
  for (let i = 0; i < pl.length; i++) {
    const [x0, y0] = pl[i];
    const [x1, y1] = pl[(i + 1) % pl.length];
    a += x0 * y1 - x1 * y0;
  }
  return Math.abs(a / 2);
}

/** Even-odd point-in-ink test against glyph rings. */
export function inInk(p: Pt, rings: Pt[][]): boolean {
  let inside = false;
  for (const r of rings)
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, yi] = r[i];
      const [xj, yj] = r[j];
      if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
    }
  return inside;
}

/** Distance from a point to the nearest glyph outline. */
export function distanceToRings(p: Pt, rings: Pt[][]): number {
  let best = Infinity;
  for (const r of rings)
    for (let i = 0; i < r.length; i++) {
      const a = r[i];
      const b = r[(i + 1) % r.length];
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const len2 = dx * dx + dy * dy;
      const t = len2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
      best = Math.min(best, Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy));
    }
  return best;
}
