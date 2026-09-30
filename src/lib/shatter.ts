import { Delaunay } from 'd3-delaunay';
import { sheetOutline, type SheetShape } from './shapes';

export type Pt = [number, number];
// 'mixed-classic' is the original dovetail/arrow mix, kept so older links reproduce exactly.
export type TabStyle = 'dovetail' | 'arrow' | 'barb' | 'mixed' | 'mixed-classic';

export interface ShatterParams {
  width: number; // mm
  height: number; // mm
  pieces: number;
  impact: Pt; // mm, inside the sheet
  concentration: number; // 0..1 — how much pieces shrink towards the impact
  sliver: number; // 0..1 — how much pieces near the impact stretch into radial splinters
  core: number; // mm — approximate diameter of the central piece at the impact (0 = no minimum)
  coreSplit: number; // pieces the central zone ends up in (1 = a single piece; 8 = no merging)
  ringBreak: number; // 0..1 — how much of each concentric crack is missing
  contrast: number; // 0..1 — makes size growth with distance steeper than linear
  chaos: number; // 0..1 — irregular central piece, rays from several origins, disordered first rings
  tabSize: number; // mm, 0 disables tabs
  tabDensity: number; // 0..1 — share of interior edges that get a tab (every piece keeps at least one)
  tabWidth: number; // width of the tabs along the edge relative to the default (1 = default)
  tabWidthVariation: number; // 0..1 — random per-tab width spread (1 ≈ half to double)
  kerf?: number; // mm burnt away by the laser; tabs are widened so they still lock (0 = ignore)
  minWidth?: number; // mm — thinnest material the sheet can take; tabs respect it, thinner spots are reported
  waviness?: number; // 0..1 — how much the straight cracks bend into gentle waves (0 = straight)
  shape?: SheetShape; // outline of the sheet inside the width × height box (default: rectangle)
  /** Further impacts besides `impact` (whose strength is 1); strength 0..1 sets their reach. */
  extraImpacts?: { at: Pt; strength: number }[];
  cornerRadius?: number; // mm, for the rounded rectangle
  tabStyle: TabStyle;
  seed: number;
  /** Glyph outlines in mm (outer contours and counters; the ink is their even-odd fill). */
  textRings?: Pt[][];
}

export interface Fragile {
  piece: number;
  /** Middle of the narrowest crossing. */
  at: Pt;
  /** Material left there once the kerf is burnt, in mm. */
  width: number;
}

export interface ShatterResult {
  /** Interior cut lines (each shared edge once, with its tab). */
  cuts: Pt[][];
  /** Closed outline of every piece, tabs included (for preview only). */
  pieces: Pt[][];
  /** Holes of each piece (letter counters, or a letter sitting inside a piece). */
  holes: Pt[][][];
  /** Whether each piece is a letter of the text. */
  letters: boolean[];
  /** Outline of the sheet (the frame), in mm. */
  outline: Pt[];
  /** Spots thinner than `minWidth` (after the kerf) that could snap, at most one per piece. */
  fragile: Fragile[];
  tabCount: number;
  /** Total cut length in mm, including the outer frame. */
  cutLength: number;
}

// ---------------------------------------------------------------------------
// Random

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Geometry helpers

const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function pointSegDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

function cross(o: Pt, a: Pt, b: Pt) {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

function segmentsIntersect(p1: Pt, p2: Pt, q1: Pt, q2: Pt): boolean {
  const d1 = cross(q1, q2, p1);
  const d2 = cross(q1, q2, p2);
  const d3 = cross(p1, p2, q1);
  const d4 = cross(p1, p2, q2);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function segSegDist(p1: Pt, p2: Pt, q1: Pt, q2: Pt): number {
  if (segmentsIntersect(p1, p2, q1, q2)) return 0;
  return Math.min(
    pointSegDist(p1, q1, q2),
    pointSegDist(p2, q1, q2),
    pointSegDist(q1, p1, p2),
    pointSegDist(q2, p1, p2),
  );
}

function polylineLength(pl: Pt[]) {
  let l = 0;
  for (let i = 1; i < pl.length; i++) l += dist(pl[i - 1], pl[i]);
  return l;
}

// ---------------------------------------------------------------------------
// Seeds: a polar lattice around the impact whose spacing grows with distance.
// Rays drift slightly and split when they get too far apart, like real cracks.

/** Seeds of all impacts, their central seeds first: `groups` lists each impact's centre. */
interface Seeds {
  pts: Pt[];
  groups: number[][];
}

function generateSeeds(p: ShatterParams, lambda: number, limit = Infinity): Seeds {
  const extra = p.extraImpacts ?? [];
  if (!extra.length) {
    const { pts, inner } = latticeSeeds(p, lambda, limit);
    return { pts, groups: [Array.from({ length: inner + 1 }, (_, i) => i)] };
  }
  // Several impacts: each grows its own lattice, kept only inside its territory — where
  // it is the nearest impact once distances are divided by strength. A weaker impact
  // gets a roughly round patch inside the stronger one's, and the cracks of both meet
  // along the border between them.
  const impacts = [{ at: p.impact, strength: 1 }, ...extra.map((e) => ({ at: e.at, strength: Math.max(0.05, Math.min(1, e.strength)) }))];
  const owner = (q: Pt) => {
    let best = 0;
    let bestD = Infinity;
    impacts.forEach((imp, k) => {
      const d = dist(q, imp.at) / imp.strength;
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    });
    return best;
  };
  const centres: Pt[][] = [];
  const rest: Pt[] = [];
  impacts.forEach((imp, k) => {
    const pk: ShatterParams = {
      ...p,
      impact: imp.at,
      core: p.core * imp.strength,
      seed: k === 0 ? p.seed : (p.seed ^ Math.imul(0x85ebca6b, k)) >>> 0,
    };
    const { pts, inner } = latticeSeeds(pk, lambda, limit);
    centres.push(pts.slice(0, inner + 1));
    for (const q of pts.slice(inner + 1)) if (owner(q) === k) rest.push(q);
  });
  const groups: number[][] = [];
  const pts: Pt[] = [];
  for (const c of centres) {
    groups.push(c.map((_, i) => pts.length + i));
    pts.push(...c);
  }
  pts.push(...rest);
  return { pts, groups };
}

/** One impact's lattice; `inner` seeds (right after the impact seed) surround its centre. */
function latticeSeeds(p: ShatterParams, lambda: number, limit = Infinity): { pts: Pt[]; inner: number } {
  const rng = mulberry32(p.seed);
  const { width: W, height: H } = p;
  const [cx, cy] = p.impact;
  const diag = Math.hypot(W, H);
  const k = p.concentration * 9;
  const size = (r: number) => {
    const linear = 1 + (k * r) / diag;
    return lambda * (p.contrast > 0 ? Math.pow(linear, 1 + p.contrast) : linear);
  };
  // Ring spacing relative to ray spacing: ~1.25 gives squarish cells; larger values near
  // the impact turn them into long radial splinters, relaxing back with distance.
  const ringStep = (r: number) => 1.25 + p.sliver * 5 * Math.exp(-r / (0.18 * diag));

  const rMax = Math.max(
    Math.hypot(cx, cy),
    Math.hypot(W - cx, cy),
    Math.hypot(cx, H - cy),
    Math.hypot(W - cx, H - cy),
  );

  const pts: Pt[] = [[cx, cy]];
  // The impact cell reaches about halfway to the first ring, so starting that ring at
  // r = core leaves a central piece roughly `core` across.
  let r = Math.max(size(0) * 1.05, p.core);
  const r0 = r;
  let innerCount = 0;
  // Extra start distance of the splinter rings per direction (0 without a central piece).
  let coreProfile = (_a: number) => 0;
  if (p.core > 0) {
    // A few inner seeds at uneven angles and distances: the impact cell becomes a
    // polygon of 4–7 irregular sides instead of a many-sided near-circle, and their own
    // cells are the medium fragments around it. The ring of splinters starts outside
    // them, far enough not to clip the central piece.
    const m = 4 + Math.floor(rng() * 4);
    const gaps = Array.from({ length: m }, () => 0.5 + rng());
    const total = gaps.reduce((acc, g) => acc + g, 0);
    let a = rng() * Math.PI * 2;
    const inner: { a: number; d: number }[] = [];
    innerCount = 0;
    for (const g of gaps) {
      const d = p.core * (0.65 + 0.7 * rng());
      const x = cx + d * Math.cos(a);
      const y = cy + d * Math.sin(a);
      if (x > 0 && x < W && y > 0 && y < H) {
        pts.push([x, y]);
        innerCount++;
      }
      inner.push({ a: a % (Math.PI * 2), d });
      a += (g / total) * Math.PI * 2;
    }
    inner.sort((u, v) => u.a - v.a);
    // Splinters start just outside the inner fragments of their own sector, so the edge
    // of the central zone follows those fragments instead of drawing a circle.
    const reach = (t: number) => {
      const tt = ((t % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
      let j = inner.findIndex((q) => q.a > tt);
      if (j < 0) j = 0;
      const prev = inner[(j - 1 + inner.length) % inner.length];
      return 1.75 * Math.max(prev.d, inner[j].d);
    };
    const start = Math.min(...inner.map((q, j) => 1.75 * Math.max(q.d, inner[(j + 1) % inner.length].d)));
    r = Math.max(r, start);
    const base = r;
    coreProfile = (t: number) => Math.max(0, reach(t) - base);
  }
  const n0 = Math.max(5, Math.round((2 * Math.PI * r) / size(r)));
  const rot = rng() * Math.PI * 2;
  let angles: number[] = [];
  for (let i = 0; i < n0; i++) {
    angles.push(rot + ((i + (rng() - 0.5) * 0.5) * 2 * Math.PI) / n0);
  }

  // Central chaos (no draws at all when off, so older configurations reproduce exactly).
  const c = p.chaos;
  // Where each ray starts: real cracks leave from several corners of the crushed centre,
  // not from one point.
  let origins: Pt[] = angles.map(() => [0, 0]);
  // Radial deformation of the centre: an oval plus a lobe, fading over the first rings.
  let shape = (_a: number) => 0;
  if (c > 0) {
    // Uneven ray spacing: bunches of thin wedges next to wide fragments.
    const gaps = angles.map(() => Math.exp(c * 1.6 * (rng() - 0.5)));
    const total = gaps.reduce((acc, g) => acc + g, 0);
    let acc = 0;
    angles = gaps.map((g) => {
      const a = rot + (acc / total) * Math.PI * 2;
      acc += g;
      return a;
    });
    // A few focal points, each pushed towards its own side of the centre; every ray
    // leaves from the focus of its sector, so rays fan out from several corners
    // without crossing their neighbours.
    const foci = Array.from({ length: 3 + Math.floor(rng() * 3) }, () => {
      const a = rng() * Math.PI * 2;
      const d = c * 0.45 * r0 * (0.5 + 0.5 * rng());
      return { a, o: [d * Math.cos(a), d * Math.sin(a)] as Pt };
    });
    const angDiff = (x: number, y: number) => Math.abs(Math.atan2(Math.sin(x - y), Math.cos(x - y)));
    origins = angles.map((a) => foci.reduce((best, f) => (angDiff(a, f.a) < angDiff(a, best.a) ? f : best)).o);
    const phi = rng() * Math.PI * 2;
    const psi = rng() * Math.PI * 2;
    const oval = 0.25 + rng() * 0.25;
    shape = (a: number) => c * r0 * (oval * Math.cos(2 * (a - phi)) + 0.18 * Math.cos(3 * a + psi));
  }

  const rStart = r;
  let firstRing = true;
  while (r < rMax + size(r)) {
    const s = size(r);
    // Split rays whose gap has grown too wide (several times if rings are far apart).
    // New rays inherit the origin of the ray they branch from.
    const next: number[] = [];
    const nextOrigins: Pt[] = [];
    for (let i = 0; i < angles.length; i++) {
      const a = angles[i];
      const b = i + 1 < angles.length ? angles[i + 1] : angles[0] + Math.PI * 2;
      next.push(a);
      nextOrigins.push(origins[i]);
      const gap = (b - a) * r;
      if (gap <= 1.3 * s) continue;
      const parts = p.sliver > 0 ? Math.max(2, Math.round(gap / s)) : 2;
      for (let j = 1; j < parts; j++) {
        next.push(a + ((b - a) * (j + (rng() - 0.5) * 0.6)) / parts);
        nextOrigins.push(origins[i]);
      }
    }
    angles = next;
    origins = nextOrigins;
    // Chaos fades out over a few centre radii.
    const fade = c > 0 ? Math.exp(-(r - r0) / (1.5 * r0)) : 0;
    const coreFade = Math.exp(-(r - rStart) / (1.2 * rStart));

    // Break rings in runs: skipping consecutive seeds merges those cells with the next
    // ring, so the concentric crack stops and restarts like in real glass.
    let dropping = false;
    for (let i = 0; i < angles.length; i++) {
      angles[i] += (rng() - 0.5) * 0.14 * (s / r);
      // Radial jitter grows with the ring gap so stretched rings don't look like perfect circles.
      let rr = r + (rng() - 0.5) * 0.35 * s * Math.sqrt(ringStep(r) / 1.25);
      // Wobble the first ring around a large central piece so it isn't a regular polygon.
      if (firstRing && p.core > 0) rr += (rng() - 0.5) * 0.45 * p.core;
      if (p.core > 0) rr += coreProfile(angles[i]) * coreFade;
      let x = cx + rr * Math.cos(angles[i]);
      let y = cy + rr * Math.sin(angles[i]);
      if (c > 0) {
        // Deform the centre, shift the ray to its focus, and scatter nearby seeds mostly
        // along the ray, so the first rings break up and stagger while the rays survive.
        const along = shape(angles[i]) * fade + (rng() - 0.5) * c * 0.35 * s * ringStep(r) * fade;
        const across = (rng() - 0.5) * c * 0.3 * s * fade;
        const ux = Math.cos(angles[i]);
        const uy = Math.sin(angles[i]);
        x += along * ux - across * uy + origins[i][0];
        y += along * uy + across * ux + origins[i][1];
      }
      if (p.ringBreak > 0 && !firstRing) {
        dropping = rng() < (dropping ? 0.65 : p.ringBreak * 0.3);
        if (dropping) continue;
      }
      if (x > 0 && x < W && y > 0 && y < H) pts.push([x, y]);
    }
    if (pts.length > limit) break;
    firstRing = false;
    r += s * ringStep(r);
  }
  return { pts, inner: innerCount };
}

function seedsForCount(p: ShatterParams): { seeds: Pt[]; groups: number[][] } {
  // The central seeds don't depend on the base size, so their count is known up front;
  // ask for extra seeds to make up for the central cells that will be merged.
  const { groups } = generateSeeds(p, 1, 1);
  const keep = Math.max(1, Math.round(p.coreSplit));
  const merges = groups.reduce((acc, g) => acc + Math.max(0, g.length - keep), 0);
  const fixed = groups.reduce((acc, g) => acc + g.length, 0);
  const target = Math.max(2, Math.round(p.pieces)) + merges;
  const limit = target * 4;
  let lo = Math.sqrt((p.width * p.height) / target) / 8;
  let hi = Math.hypot(p.width, p.height);
  let best = generateSeeds(p, lo, limit).pts;
  // Steep size contrast can need a much smaller base size than the initial guess.
  while (best.length < target && lo > 0.05) {
    lo /= 2;
    best = generateSeeds(p, lo, limit).pts;
  }
  for (let i = 0; i < 30; i++) {
    const mid = Math.sqrt(lo * hi);
    const pts = generateSeeds(p, mid, limit).pts;
    if (pts.length >= target) {
      lo = mid;
      best = pts;
    } else {
      hi = mid;
    }
  }
  // Drop the surplus at random (never the central seeds, which come first) — the merged
  // cells add some welcome irregularity.
  const rng = mulberry32(p.seed ^ 0x9e3779b9);
  while (best.length > target) {
    best.splice(fixed + Math.floor(rng() * (best.length - fixed)), 1);
  }
  return { seeds: best, groups };
}

// ---------------------------------------------------------------------------
// Planar graph from the clipped Voronoi diagram

interface Edge {
  a: number;
  b: number;
  cells: number[];
  poly: Pt[];
  /** Part of a letter outline: never gets a tab, so the letters keep their exact shape. */
  letter?: boolean;
}

const MIN_EDGE = 1.2; // mm — shorter interior edges get collapsed

function buildGraph(
  seeds: Pt[],
  W: number,
  H: number,
  central: { groups: number[][]; keep: number; rng: () => number },
  rings: Pt[][] = [],
  boundary?: Pt[],
) {
  // With a shaped sheet the diagram overshoots the box a little, so the sheet outline
  // always crosses the cracks cleanly instead of running along the box edge.
  const pad = boundary ? 2 : 0;
  const voronoi = Delaunay.from(seeds).voronoi([-pad, -pad, W + pad, H + pad]);
  const verts: Pt[] = [];
  const index = new Map<string, number>();
  const vid = (pt: Pt) => {
    const key = `${Math.round(pt[0] * 1e5)},${Math.round(pt[1] * 1e5)}`;
    let id = index.get(key);
    if (id === undefined) {
      id = verts.length;
      verts.push([pt[0], pt[1]]);
      index.set(key, id);
    }
    return id;
  };

  let cells: number[][] = [];
  let cellSeed: number[] = [];
  for (let i = 0; i < seeds.length; i++) {
    const poly = voronoi.cellPolygon(i);
    if (!poly) continue;
    cells.push(poly.slice(0, -1).map((q) => vid(q as Pt)));
    cellSeed.push(i);
  }

  const eps = 1e-6;
  const onX = (v: Pt) => v[0] < eps || v[0] > W - eps;
  const onY = (v: Pt) => v[1] < eps || v[1] > H - eps;

  // Collapse very short interior edges (union-find), keeping border points on the border.
  const parent = verts.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const edgeCount = new Map<string, number>();
  for (const c of cells) {
    for (let i = 0; i < c.length; i++) {
      const u = c[i];
      const v = c[(i + 1) % c.length];
      const k = u < v ? `${u}-${v}` : `${v}-${u}`;
      edgeCount.set(k, (edgeCount.get(k) ?? 0) + 1);
    }
  }
  for (const [k, n] of edgeCount) {
    if (n !== 2) continue;
    const [u, v] = k.split('-').map(Number);
    if (dist(verts[u], verts[v]) < MIN_EDGE) parent[find(u)] = find(v);
  }
  const clusters = new Map<number, number[]>();
  verts.forEach((_, i) => {
    const r = find(i);
    if (!clusters.has(r)) clusters.set(r, []);
    clusters.get(r)!.push(i);
  });
  for (const members of clusters.values()) {
    if (members.length < 2) continue;
    const pick =
      members.find((m) => onX(verts[m]) && onY(verts[m])) ??
      members.find((m) => onX(verts[m]) || onY(verts[m]));
    let pos: Pt;
    if (pick !== undefined) pos = [...verts[pick]] as Pt;
    else {
      pos = [0, 0];
      for (const m of members) {
        pos[0] += verts[m][0] / members.length;
        pos[1] += verts[m][1] / members.length;
      }
    }
    for (const m of members) verts[m] = pos;
  }

  const collapsed = cells.map((c) => {
    const out: number[] = [];
    for (const v of c.map(find)) if (out[out.length - 1] !== v) out.push(v);
    while (out.length > 1 && out[0] === out[out.length - 1]) out.pop();
    return out;
  });
  cellSeed = cellSeed.filter((_, i) => collapsed[i].length >= 3);
  cells = collapsed.filter((c) => c.length >= 3);

  let merged = mergeCentralCells(cells, cellSeed, central);

  let V = verts;
  let holes: number[][][] = cells.map(() => []);
  let ink: boolean[] = cells.map(() => false);
  let letterKeys = new Set<string>();
  if (rings.length || boundary) {
    const carved = carveText(verts, cells, rings, boundary);
    ({ verts: V, cells, holes, ink, letterKeys } = carved);
    // Carved pieces can be concave: orient their tabs by winding, not by centroid.
    merged = new Set(cells.map((_, ci) => ci));
  }

  const edges = new Map<string, Edge>();
  const addLoop = (c: number[], ci: number) => {
    for (let i = 0; i < c.length; i++) {
      const u = c[i];
      const v = c[(i + 1) % c.length];
      const k = u < v ? `${u}-${v}` : `${v}-${u}`;
      let e = edges.get(k);
      if (!e) {
        e = { a: Math.min(u, v), b: Math.max(u, v), cells: [], poly: [] };
        if (letterKeys.has(k)) e.letter = true;
        edges.set(k, e);
      }
      e.cells.push(ci);
    }
  };
  cells.forEach((c, ci) => {
    addLoop(c, ci);
    for (const h of holes[ci]) addLoop(h, ci);
  });
  for (const e of edges.values()) e.poly = [V[e.a], V[e.b]];

  return { verts: V, cells, holes, ink, edges, merged };
}

// ---------------------------------------------------------------------------
// Text: carve glyph outlines into the crack graph

/** Even-odd point-in-ink test against every glyph ring. */
function inInk(p: Pt, rings: Pt[][]): boolean {
  let inside = false;
  for (const r of rings) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, yi] = r[i];
      const [xj, yj] = r[j];
      if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

function signedArea(pts: Pt[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const P = pts[i];
    const Q = pts[(i + 1) % pts.length];
    a += P[0] * Q[1] - Q[0] * P[1];
  }
  return a / 2;
}

function pointInPolygon(p: Pt, poly: Pt[]): boolean {
  return inInk(p, [poly]);
}

const FRAGMENT_AREA = 4; // mm² — anything this small against a letter is merged
const FRAGMENT_SHARE = 0.3; // …as is any part of a cell cut down by a letter to less than this share

/**
 * Cut the letters out of the crack graph, and trim it to the sheet outline: cracks stop at
 * letter outlines and at the sheet edge, letters (and their counters) become pieces,
 * whatever lies outside the sheet is dropped, and slivers left against a letter or the
 * edge merge into a neighbour. Returns a fresh planar graph whose faces may have holes.
 */
function carveText(verts: Pt[], cells: number[][], rings: Pt[][], boundary?: Pt[]) {
  // 1. Split cracks, letter outlines and the sheet outline at their crossings. Each
  //    crossing point is computed once and shared by both lines, so the pieces meet exactly.
  type Seg = { a: Pt; b: Pt; cuts: { t: number; p: Pt }[]; kind: 'crack' | 'letter' | 'edge' };
  const segs: Seg[] = [];
  const seen = new Set<string>();
  for (const c of cells) {
    for (let i = 0; i < c.length; i++) {
      const u = c[i];
      const v = c[(i + 1) % c.length];
      const k = u < v ? `${u}-${v}` : `${v}-${u}`;
      if (seen.has(k)) continue;
      seen.add(k);
      segs.push({ a: verts[u], b: verts[v], cuts: [], kind: 'crack' });
    }
  }
  const cracks = segs.slice();
  const letters: Seg[] = [];
  for (const r of rings) for (let i = 0; i < r.length; i++) letters.push({ a: r[i], b: r[(i + 1) % r.length], cuts: [], kind: 'letter' });
  const edge: Seg[] = [];
  if (boundary)
    for (let i = 0; i < boundary.length; i++)
      edge.push({ a: boundary[i], b: boundary[(i + 1) % boundary.length], cuts: [], kind: 'edge' });
  segs.push(...letters, ...edge);
  const inside = (q: Pt) => !boundary || pointInPolygon(q, boundary);

  const crossAll = (A: Seg[], B: Seg[]) => {
    for (const s of A) {
    const [ax, ay] = s.a;
    const rx = s.b[0] - ax;
    const ry = s.b[1] - ay;
    const x0 = Math.min(ax, s.b[0]), x1 = Math.max(ax, s.b[0]);
    const y0 = Math.min(ay, s.b[1]), y1 = Math.max(ay, s.b[1]);
    for (const o of B) {
      if (Math.max(o.a[0], o.b[0]) < x0 || Math.min(o.a[0], o.b[0]) > x1) continue;
      if (Math.max(o.a[1], o.b[1]) < y0 || Math.min(o.a[1], o.b[1]) > y1) continue;
      const qx = o.b[0] - o.a[0];
      const qy = o.b[1] - o.a[1];
      const den = rx * qy - ry * qx;
      if (Math.abs(den) < 1e-12) continue;
      const wx = o.a[0] - ax;
      const wy = o.a[1] - ay;
      const t = (wx * qy - wy * qx) / den;
      const u = (wx * ry - wy * rx) / den;
      if (t <= 1e-9 || t >= 1 - 1e-9 || u <= 1e-9 || u >= 1 - 1e-9) continue;
      const p: Pt = [ax + t * rx, ay + t * ry];
      s.cuts.push({ t, p });
      o.cuts.push({ t: u, p });
    }
    }
  };
  crossAll(cracks, letters);
  crossAll(cracks, edge);
  crossAll(letters, edge);

  // 2. Planar graph of the pieces that survive: crack parts outside the ink, all outlines.
  const V: Pt[] = [];
  const index = new Map<string, number>();
  const vid = (p: Pt) => {
    const key = `${Math.round(p[0] * 1e7)},${Math.round(p[1] * 1e7)}`;
    let id = index.get(key);
    if (id === undefined) {
      id = V.length;
      V.push(p);
      index.set(key, id);
    }
    return id;
  };
  const ek = (u: number, v: number) => (u < v ? `${u}-${v}` : `${v}-${u}`);
  const adj = new Map<number, Set<number>>();
  const letterKeys = new Set<string>();
  // Letter outlines and the sheet edge: slivers against either get merged.
  const wallKeys = new Set<string>();
  const link = (u: number, v: number) => {
    if (!adj.has(u)) adj.set(u, new Set());
    if (!adj.has(v)) adj.set(v, new Set());
    adj.get(u)!.add(v);
    adj.get(v)!.add(u);
  };
  for (const s of segs) {
    const pts = [{ t: 0, p: s.a }, ...s.cuts.sort((x, y) => x.t - y.t), { t: 1, p: s.b }];
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i].p;
      const b = pts[i + 1].p;
      if (dist(a, b) < 1e-9) continue;
      const mid: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      if (s.kind === 'crack' && (inInk(mid, rings) || !inside(mid))) continue;
      if (s.kind === 'letter' && !inside(mid)) continue;
      const u = vid(a);
      const v = vid(b);
      if (u === v) continue;
      link(u, v);
      if (s.kind === 'letter') letterKeys.add(ek(u, v));
      if (s.kind !== 'crack') wallKeys.add(ek(u, v));
    }
  }

  // 3. Faces by walking half-edges, turning to the next neighbour around each vertex.
  function faces() {
    const order = new Map<number, number[]>();
    for (const [v, ns] of adj) {
      const [vx, vy] = V[v];
      order.set(v, [...ns].sort((x, y) => Math.atan2(V[x][1] - vy, V[x][0] - vx) - Math.atan2(V[y][1] - vy, V[y][0] - vx)));
    }
    const used = new Set<string>();
    const cycles: number[][] = [];
    for (const [u, ns] of adj) {
      for (const v of ns) {
        if (used.has(`${u}>${v}`)) continue;
        const cyc: number[] = [];
        let a = u;
        let b = v;
        while (!used.has(`${a}>${b}`)) {
          used.add(`${a}>${b}`);
          cyc.push(a);
          const o = order.get(b)!;
          const w = o[(o.indexOf(a) - 1 + o.length) % o.length];
          a = b;
          b = w;
        }
        cycles.push(cyc);
      }
    }
    const areas = cycles.map((c) => signedArea(c.map((i) => V[i])));
    let outer = 0;
    areas.forEach((a, i) => {
      if (Math.abs(a) > Math.abs(areas[outer])) outer = i;
    });
    const sOut = Math.sign(areas[outer]);
    const bounded: number[] = [];
    const holeCycles: number[] = [];
    cycles.forEach((_, i) => {
      if (i === outer || Math.abs(areas[i]) < 1e-9) return;
      if (Math.sign(areas[i]) === sOut) holeCycles.push(i);
      else bounded.push(i);
    });
    // Ink or not, sampled just inside the longest side (interior is on the left of a
    // positively oriented loop).
    const samples: Pt[] = [];
    const inkOf = bounded.map((ci) => {
      const c = cycles[ci];
      let best = 0;
      let bestLen = -1;
      for (let i = 0; i < c.length; i++) {
        const l = dist(V[c[i]], V[c[(i + 1) % c.length]]);
        if (l > bestLen) {
          bestLen = l;
          best = i;
        }
      }
      const A = V[c[best]];
      const B = V[c[(best + 1) % c.length]];
      const side = Math.sign(areas[ci]) * Math.min(1e-3, bestLen * 0.01);
      const nx = (-(B[1] - A[1]) / bestLen) * side;
      const ny = ((B[0] - A[0]) / bestLen) * side;
      const sample: Pt = [(A[0] + B[0]) / 2 + nx, (A[1] + B[1]) / 2 + ny];
      samples.push(sample);
      return inInk(sample, rings);
    });
    // Each hole belongs to the smallest face around it that it doesn't touch.
    const holesOf: number[][] = bounded.map(() => []);
    for (const hi of holeCycles) {
      const h = cycles[hi];
      const hv = new Set(h);
      const P = V[h[0]];
      let host = -1;
      bounded.forEach((ci, k) => {
        if (cycles[ci].some((v) => hv.has(v))) return;
        if (!pointInPolygon(P, cycles[ci].map((i) => V[i]))) return;
        if (host < 0 || Math.abs(areas[ci]) < Math.abs(areas[bounded[host]])) host = k;
      });
      if (host >= 0) holesOf[host].push(hi);
    }
    return { cycles, areas, bounded, inkOf, holesOf, samples };
  }

  // 4. Merge slivers against letters into a glass neighbour. A sliver is judged against
  //    the crack cell it was cut from (not its neighbours), so merged pieces don't
  //    snowball into giants.
  const origPolys = cells.map((c) => c.map((i) => verts[i]));
  const origAreas = origPolys.map((poly) => Math.abs(signedArea(poly)));
  const origCellOf = (pt: Pt) => {
    for (let i = 0; i < origPolys.length; i++) if (pointInPolygon(pt, origPolys[i])) return i;
    return -1;
  };
  for (let round = 0; round < 60; round++) {
    const f = faces();
    const faceOf = new Map<string, number>();
    f.bounded.forEach((ci, k) => {
      const c = f.cycles[ci];
      for (let i = 0; i < c.length; i++) faceOf.set(`${c[i]}>${c[(i + 1) % c.length]}`, k);
    });
    const touched = new Set<number>();
    let changed = false;
    const order = f.bounded.map((_, k) => k).sort((x, y) => Math.abs(f.areas[f.bounded[x]]) - Math.abs(f.areas[f.bounded[y]]));
    for (const k of order) {
      if (f.inkOf[k] || touched.has(k)) continue;
      const c = f.cycles[f.bounded[k]];
      const area = Math.abs(f.areas[f.bounded[k]]);
      const shared = new Map<number, { len: number; keys: string[] }>();
      let againstLetter = false;
      for (let i = 0; i < c.length; i++) {
        const u = c[i];
        const v = c[(i + 1) % c.length];
        if (wallKeys.has(ek(u, v))) {
          againstLetter = true;
          continue;
        }
        const g = faceOf.get(`${v}>${u}`);
        if (g === undefined || g === k || f.inkOf[g]) continue;
        const entry = shared.get(g) ?? { len: 0, keys: [] };
        entry.len += dist(V[u], V[v]);
        entry.keys.push(ek(u, v));
        shared.set(g, entry);
      }
      if (!againstLetter || !shared.size) continue;
      if (area >= FRAGMENT_AREA) {
        const home = origCellOf(f.samples[k]);
        if (home < 0 || area >= FRAGMENT_SHARE * origAreas[home]) continue;
      }
      let pick = -1;
      for (const [g, e] of shared) if (!touched.has(g) && (pick < 0 || e.len > shared.get(pick)!.len)) pick = g;
      if (pick < 0) continue;
      for (const key of shared.get(pick)!.keys) {
        const [u, v] = key.split('-').map(Number);
        adj.get(u)?.delete(v);
        adj.get(v)?.delete(u);
      }
      touched.add(k);
      touched.add(pick);
      changed = true;
    }
    // Drop vertices left isolated or dangling by the merges.
    for (let again = true; again; ) {
      again = false;
      for (const [v, ns] of adj) {
        if (ns.size >= 2) continue;
        for (const w of ns) adj.get(w)?.delete(v);
        adj.delete(v);
        again = true;
      }
    }
    if (!changed) break;
  }

  const f = faces();
  // Anything outside the sheet outline is offcut, not a piece.
  const keep = f.bounded.map((_, k) => inside(f.samples[k]));
  return {
    verts: V,
    cells: f.bounded.map((ci) => f.cycles[ci]).filter((_, k) => keep[k]),
    holes: f.holesOf.map((hs) => hs.map((hi) => f.cycles[hi])).filter((_, k) => keep[k]),
    ink: f.inkOf.filter((_, k) => keep[k]),
    letterKeys,
  };
}

/**
 * For each impact, fuse its impact cell and the cells of its inner seeds, picking random
 * neighbouring pairs, until `keep` pieces remain. Returns the indices of the fused cells.
 */
function mergeCentralCells(
  cells: number[][],
  cellSeed: number[],
  { groups: seedGroups, keep, rng }: { groups: number[][]; keep: number; rng: () => number },
): Set<number> {
  const fused = new Set<number>();
  const drop = new Set<number>();
  for (const seedGroup of seedGroups) {
    const wanted = new Set(seedGroup);
    const group = cells.map((_, ci) => ci).filter((ci) => wanted.has(cellSeed[ci]));
    if (seedGroup.length <= 1 || group.length <= keep) continue;
    fuseGroup(cells, group, keep, rng, fused, drop);
  }
  if (!drop.size) return fused;
  // Remove the absorbed cells, remapping the fused indices.
  const remap: number[] = [];
  let n = 0;
  for (let ci = 0; ci < cells.length; ci++) remap.push(drop.has(ci) ? -1 : n++);
  const kept = cells.filter((_, ci) => !drop.has(ci));
  cells.length = 0;
  cells.push(...kept);
  return new Set([...fused].map((ci) => remap[ci]));
}

/** Fuse one centre's cells in place; absorbed cells are added to `drop`. */
function fuseGroup(
  cells: number[][],
  group: number[],
  keep: number,
  rng: () => number,
  fused: Set<number>,
  drop: Set<number>,
) {
  const parent = new Map(group.map((ci) => [ci, ci]));
  const find = (i: number): number => (parent.get(i) === i ? i : find(parent.get(i)!));
  const owner = new Map<string, number[]>();
  for (const ci of group) {
    const c = cells[ci];
    for (let i = 0; i < c.length; i++) {
      const u = c[i];
      const v = c[(i + 1) % c.length];
      const k = u < v ? `${u}-${v}` : `${v}-${u}`;
      if (!owner.has(k)) owner.set(k, []);
      owner.get(k)!.push(ci);
    }
  }
  const pairs = [...owner.values()].filter((o) => o.length === 2);
  let groups = group.length;
  while (groups > keep) {
    const open = pairs.filter(([x, y]) => find(x) !== find(y));
    if (!open.length) break;
    const [x, y] = open[Math.floor(rng() * open.length)];
    parent.set(find(x), find(y));
    groups--;
  }

  const sets = new Map<number, number[]>();
  for (const ci of group) {
    const r = find(ci);
    if (!sets.has(r)) sets.set(r, []);
    sets.get(r)!.push(ci);
  }
  for (const members of sets.values()) {
    if (members.length < 2) continue;
    // Outline of the union: directed edges whose reverse isn't in the set.
    const directed = new Set<string>();
    for (const ci of members) {
      const c = cells[ci];
      for (let i = 0; i < c.length; i++) directed.add(`${c[i]}>${c[(i + 1) % c.length]}`);
    }
    const next = new Map<number, number>();
    let pinched = false;
    for (const d of directed) {
      const [u, v] = d.split('>').map(Number);
      if (directed.has(`${v}>${u}`)) continue;
      if (next.has(u)) pinched = true;
      next.set(u, v);
    }
    const start = next.keys().next().value;
    if (pinched || start === undefined) continue; // not a simple outline: leave these cells apart
    const loop: number[] = [start];
    for (let v = next.get(start)!; v !== start && loop.length <= next.size; v = next.get(v)!) loop.push(v);
    if (loop.length !== next.size) continue;
    cells[members[0]] = loop;
    fused.add(members[0]);
    for (const ci of members.slice(1)) drop.add(ci);
  }
}

// ---------------------------------------------------------------------------
// Tabs

// Kerf safety. A shared cut always leaves a gap as wide as the kerf, so a tab only holds if
// its head overhangs the neck by more than that gap, and its neck must keep enough
// material once the laser has burnt half the kerf off each side.
const LOCK_MARGIN = 0.3; // mm of overhang beyond the kerf gap
const MIN_NECK = 1.0; // mm of neck material left after the cut
/** Overhang of the head beyond the neck, per side, as a fraction of t·w (see tabShape). */
const OVERHANG = { dovetail: (1.2 - 0.55) / 2, arrow: (1.2 - 0.55) / 2, barb: 0.6 + 0.1 - 0.275 };

/** Smallest width factor that keeps a tab of size t locking with the given kerf. */
function lockWidth(style: 'dovetail' | 'arrow' | 'barb', t: number, kerf: number, minNeck = MIN_NECK): number {
  return Math.max((kerf + LOCK_MARGIN) / (OVERHANG[style] * t), (kerf + minNeck) / (0.55 * t));
}

/**
 * Tab outline in local coords: u along the edge, v into the receiving piece.
 * `w` scales the width along the edge; the depth stays proportional to `t`.
 */
function tabShape(style: 'dovetail' | 'arrow' | 'barb', t: number, uc: number, skew: number, w = 1): Pt[] {
  const neck = 0.55 * t * w;
  const head = 1.2 * t * w;
  const h = 0.95 * t;
  if (style === 'barb') {
    // Lightning-bolt hook: straight back, slanted face down to a point that overhangs the
    // neck on one side only. The skew sign decides which way it points.
    const d = skew < 0 ? -1 : 1;
    const sh = 0.4 * h;
    const pts: Pt[] = [
      [uc - (d * neck) / 2, 0],
      [uc - (d * neck) / 2, h * 1.05],
      [uc + d * (head / 2 + 0.1 * t * w), sh],
      [uc + (d * neck) / 2, sh],
      [uc + (d * neck) / 2, 0],
    ];
    // The outline must run from low u to high u like the edge it sits on; a mirrored
    // hook listed the other way round would retrace its base and cut the tab loose.
    return d < 0 ? pts.reverse() : pts;
  }
  if (style === 'dovetail') {
    return [
      [uc - neck / 2, 0],
      [uc - head / 2 + skew, h],
      [uc + head / 2 + skew, h],
      [uc + neck / 2, 0],
    ];
  }
  const sh = 0.42 * h;
  return [
    [uc - neck / 2, 0],
    [uc - neck / 2, sh],
    [uc - head / 2, sh],
    [uc + skew * 1.5, h * 1.08],
    [uc + head / 2, sh],
    [uc + neck / 2, sh],
    [uc + neck / 2, 0],
  ];
}

function addTabs(
  p: ShatterParams,
  graph: ReturnType<typeof buildGraph>,
  rng: () => number,
): number {
  const { verts, cells, edges } = graph;
  if (p.tabSize <= 0) return 0;

  const cellSegs: [Pt, Pt, string][][] = cells.map((c, ci) =>
    [c, ...graph.holes[ci]].flatMap((loop) =>
      loop.map((u, i) => {
        const v = loop[(i + 1) % loop.length];
        return [verts[u], verts[v], u < v ? `${u}-${v}` : `${v}-${u}`] as [Pt, Pt, string];
      }),
    ),
  );
  const centroids: Pt[] = cells.map((c) => {
    let x = 0;
    let y = 0;
    for (const v of c) {
      x += verts[v][0];
      y += verts[v][1];
    }
    return [x / c.length, y / c.length];
  });
  const intrusions: [Pt, Pt][][] = cells.map(() => []);
  // Fused central cells can be concave, where the centroid may fall outside; for them the
  // interior side comes from the outline's winding instead.
  const winding = new Map<number, { area: number; dirs: Set<string> }>();
  for (const ci of graph.merged) {
    const c = cells[ci];
    let area = 0;
    const dirs = new Set<string>();
    for (let i = 0; i < c.length; i++) {
      const P = verts[c[i]];
      const Q = verts[c[(i + 1) % c.length]];
      area += P[0] * Q[1] - Q[0] * P[1];
      dirs.add(`${c[i]}>${c[(i + 1) % c.length]}`);
    }
    winding.set(ci, { area, dirs });
  }

  const interior = [...edges.entries()].filter(([, e]) => e.cells.length === 2 && !e.letter);
  for (let i = interior.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [interior[i], interior[j]] = [interior[j], interior[i]];
  }

  let count = 0;
  const tabsPerCell = cells.map(() => 0);

  function tryPlace(key: string, e: Edge, scales: number[]): boolean {
    const A = verts[e.a];
    const B = verts[e.b];
    const L = dist(A, B);
    const ux = (B[0] - A[0]) / L;
    const uy = (B[1] - A[1]) / L;
    const pick = p.tabStyle === 'mixed' || p.tabStyle === 'mixed-classic' ? rng() : 0;
    const style: 'dovetail' | 'arrow' | 'barb' =
      p.tabStyle === 'mixed-classic'
        ? pick < 0.5
          ? 'dovetail'
          : 'arrow'
        : p.tabStyle === 'mixed'
          ? (['dovetail', 'arrow', 'barb'] as const)[Math.floor(pick * 3)]
          : p.tabStyle;
    const ucJitter = 0.5 + (rng() - 0.5) * 0.25;
    const skewJitter = (rng() - 0.5) * 0.35;
    const firstSide = rng() < 0.5 ? 0 : 1;
    // Per-tab width: a log-uniform spread around the chosen width (no draw when off).
    const w =
      p.tabWidth * (p.tabWidthVariation > 0 ? Math.exp(p.tabWidthVariation * 1.4 * (rng() - 0.5)) : 1);

    for (const scale of scales) {
      const t = p.tabSize * scale;
      if (scale < 0.62 && t < 1.5) continue; // rescue sizes only; never below 1.5 mm
      const kerf = p.kerf ?? 0;
      const minWidth = p.minWidth ?? 0;
      // With a kerf or a minimum width, widen the tab just enough to keep locking and keep
      // its neck thick enough; it may then not fit.
      const ws = kerf > 0 || minWidth > 0 ? Math.max(w, lockWidth(style, t, kerf, Math.max(MIN_NECK, minWidth))) : w;
      // The wall between the tab and the rest of the piece must be as thick, too.
      const clearance = Math.max(0.8, 0.32 * t, kerf > 0 ? kerf + 0.6 : 0, minWidth > 0 ? minWidth + kerf : 0);
      if (L < 1.2 * t * Math.max(ws, 0.5) + 2 * clearance) continue;
      for (const side of [firstSide, 1 - firstSide]) {
        const tgt = e.cells[side];
        const src = e.cells[1 - side];
        // Normal pointing into the target cell.
        let nx = -uy;
        let ny = ux;
        const wind = winding.get(tgt);
        if (wind) {
          // (-uy, ux) is on the left of A→B; the interior is on the left of the outline
          // when its signed area is positive.
          const alongAB = wind.dirs.has(`${e.a}>${e.b}`);
          if (alongAB !== wind.area > 0) {
            nx = -nx;
            ny = -ny;
          }
        } else {
          const c = centroids[tgt];
          if ((c[0] - A[0]) * nx + (c[1] - A[1]) * ny < 0) {
            nx = -nx;
            ny = -ny;
          }
        }
        const local = tabShape(style, t, L * ucJitter, skewJitter * t, ws);
        const world: Pt[] = local.map(([u, v]) => [A[0] + ux * u + nx * v, A[1] + uy * u + ny * v]);

        const segs: [Pt, Pt][] = [];
        for (let s = 1; s < world.length; s++) segs.push([world[s - 1], world[s]]);

        const obstacles: [Pt, Pt][] = [
          ...cellSegs[tgt].filter((s) => s[2] !== key).map((s) => [s[0], s[1]] as [Pt, Pt]),
          ...intrusions[tgt],
          ...intrusions[src],
        ];
        const ok = segs.every(([s0, s1]) =>
          obstacles.every(([o0, o1]) => segSegDist(s0, s1, o0, o1) >= clearance),
        );
        if (!ok) continue;

        e.poly = [A, ...world, B];
        intrusions[tgt].push(...segs);
        tabsPerCell[tgt]++;
        tabsPerCell[src]++;
        count++;
        return true;
      }
    }
    return false;
  }

  // First pass: each edge gets a tab with probability tabDensity, longer edges favoured.
  // At full density no draw is made, so older configurations reproduce exactly.
  const tabbed = new Set<string>();
  for (const [key, e] of interior) {
    if (p.tabDensity < 1) {
      const L = dist(verts[e.a], verts[e.b]);
      const chance = p.tabDensity * Math.min(1.4, Math.max(0.5, L / (3 * p.tabSize)));
      if (rng() >= chance) continue;
    }
    if (tryPlace(key, e, [1, 0.8, 0.62])) tabbed.add(key);
  }

  // Second pass: no piece may be left without a tab — try its longest free edges, allowing
  // smaller tabs for the tiny splinters. Skipped at full density, where every edge was
  // already tried, so older configurations reproduce exactly.
  const cellEdges: [string, Edge][][] = cells.map(() => []);
  for (const entry of interior) for (const ci of entry[1].cells) cellEdges[ci].push(entry);
  cells.forEach((_, ci) => {
    if (p.tabDensity >= 1 || tabsPerCell[ci] > 0 || graph.ink[ci]) return;
    const free = cellEdges[ci]
      .filter(([key]) => !tabbed.has(key))
      .sort(([, x], [, y]) => dist(verts[y.a], verts[y.b]) - dist(verts[x.a], verts[x.b]));
    for (const [key, e] of free) {
      if (tryPlace(key, e, [1, 0.8, 0.62, 0.45, 0.33])) {
        tabbed.add(key);
        break;
      }
    }
  });
  return count;
}

// ---------------------------------------------------------------------------
// Chaining: join edge polylines end-to-end so the laser makes fewer jumps.

function chain(polys: Pt[][]): Pt[][] {
  const k = (p: Pt) => `${p[0].toFixed(4)},${p[1].toFixed(4)}`;
  const at = new Map<string, number[]>();
  polys.forEach((pl, i) => {
    for (const end of [pl[0], pl[pl.length - 1]]) {
      const key = k(end);
      if (!at.has(key)) at.set(key, []);
      at.get(key)!.push(i);
    }
  });
  const used = new Array(polys.length).fill(false);
  const out: Pt[][] = [];
  // Start from odd-degree endpoints first so chains run end to end.
  const order = polys
    .map((_, i) => i)
    .sort((a, b) => (at.get(k(polys[b][0]))!.length % 2) - (at.get(k(polys[a][0]))!.length % 2));
  for (const start of order) {
    if (used[start]) continue;
    used[start] = true;
    const line = [...polys[start]];
    for (;;) {
      const endKey = k(line[line.length - 1]);
      const nextId = at.get(endKey)!.find((j) => !used[j]);
      if (nextId === undefined) break;
      used[nextId] = true;
      const pl = polys[nextId];
      const seg = k(pl[0]) === endKey ? pl : [...pl].reverse();
      line.push(...seg.slice(1));
    }
    out.push(line);
  }
  return out;
}

// ---------------------------------------------------------------------------

export function shatter(p: ShatterParams): ShatterResult {
  if ((p.shape ?? 'rect') === 'rect') return shatterOnce(p, p.pieces);
  // A shaped sheet loses the corners of the box: sow seeds in proportion to its area, then
  // correct once if merges along the edge left the count noticeably off.
  const outline = sheetOutline(p.shape!, p.width, p.height, p.cornerRadius ?? 0);
  const sow = Math.round(p.pieces / (Math.abs(signedArea(outline)) / (p.width * p.height)));
  const first = shatterOnce(p, sow);
  const got = first.pieces.length;
  if (Math.abs(got - p.pieces) <= 0.02 * p.pieces || got === 0) return first;
  const second = shatterOnce(p, Math.round((sow * p.pieces) / got));
  return Math.abs(second.pieces.length - p.pieces) < Math.abs(got - p.pieces) ? second : first;
}

/** One pass of the generator; `sow` is how many cells to aim for in the whole box. */
function shatterOnce(p: ShatterParams, sow: number): ShatterResult {
  const shaped = (p.shape ?? 'rect') !== 'rect';
  const outline = sheetOutline(p.shape ?? 'rect', p.width, p.height, p.cornerRadius ?? 0);
  const { seeds: all, groups } = seedsForCount(shaped ? { ...p, pieces: sow } : p);
  const fixed = groups.reduce((acc, g) => acc + g.length, 0);
  const rings = p.textRings ?? [];
  // Seeds inside the letters (or off the sheet) would only make cells that get swallowed.
  const seeds =
    rings.length || shaped
      ? all.filter((q, i) => i < fixed || ((!rings.length || !inInk(q, rings)) && (!shaped || pointInPolygon(q, outline))))
      : all;
  const graph = buildGraph(
    seeds,
    p.width,
    p.height,
    { groups, keep: Math.max(1, Math.round(p.coreSplit)), rng: mulberry32(p.seed ^ 0x2c1b3c6d) },
    rings,
    shaped ? outline : undefined,
  );
  const tabCount = addTabs(p, graph, mulberry32(p.seed ^ 0x51ed270b));
  const straight = waveEdges(p, graph);

  const trace = (c: number[]) => {
    const outline: Pt[] = [];
    for (let i = 0; i < c.length; i++) {
      const u = c[i];
      const v = c[(i + 1) % c.length];
      const e = graph.edges.get(u < v ? `${u}-${v}` : `${v}-${u}`)!;
      const pl = u === e.a ? e.poly : [...e.poly].reverse();
      outline.push(...pl.slice(0, -1));
    }
    return outline;
  };
  let pieces = graph.cells.map(trace);
  let holes = graph.holes.map((hs) => hs.map(trace));

  const minWidth = p.minWidth ?? 0;
  const kerf = p.kerf ?? 0;
  let fragile = minWidth > 0 ? findFragile(pieces, holes, kerf, minWidth) : [];
  // Waves must never be what makes a piece fragile: straighten the bent cracks of any
  // fragile piece and look again (a piece fragile with straight cracks stays reported).
  for (let round = 0; round < 3 && fragile.length && straight.size; round++) {
    let reverted = false;
    for (const f of fragile) {
      for (const loop of [graph.cells[f.piece], ...graph.holes[f.piece]]) {
        for (let i = 0; i < loop.length; i++) {
          const u = loop[i];
          const v = loop[(i + 1) % loop.length];
          const e = graph.edges.get(u < v ? `${u}-${v}` : `${v}-${u}`)!;
          const orig = straight.get(e);
          if (!orig) continue;
          e.poly = orig;
          straight.delete(e);
          reverted = true;
        }
      }
    }
    if (!reverted) break;
    pieces = graph.cells.map(trace);
    holes = graph.holes.map((hs) => hs.map(trace));
    fragile = findFragile(pieces, holes, kerf, minWidth);
  }

  const interior = [...graph.edges.values()].filter((e) => e.cells.length === 2).map((e) => e.poly);
  const cuts = chain(interior);
  const cutLength =
    cuts.reduce((acc, pl) => acc + polylineLength(pl), 0) +
    (shaped ? polylineLength([...outline, outline[0]]) : 2 * (p.width + p.height));

  return { cuts, pieces, holes, letters: graph.ink, outline, fragile, tabCount, cutLength };
}

// ---------------------------------------------------------------------------
// Wavy cracks

const WAVE_STEP = 1.5; // mm between the points of a bent crack
const WAVE_AMPLITUDE = 0.04; // of the stretch length, at full waviness
const WAVE_MAX = 2; // mm, whatever the length

/**
 * Bend the straight stretches of every interior crack into a gentle wave. Each stretch is
 * pinned at both ends (crack junctions and tab bases), and a crack is a single shared
 * line, so neighbouring pieces keep meeting exactly. A bent crack that would cross a line,
 * or come closer to another than the allowed gap, stays straight.
 */
function waveEdges(p: ShatterParams, graph: ReturnType<typeof buildGraph>): Map<Edge, Pt[]> {
  const straight = new Map<Edge, Pt[]>();
  const w = p.waviness ?? 0;
  if (w <= 0) return straight;
  const rng = mulberry32(p.seed ^ 0x6a09e667);
  const gap = Math.max(0.8, (p.minWidth ?? 0) + (p.kerf ?? 0));
  const edges = [...graph.edges.values()];

  // Edges bucketed by their bounding box, padded by the largest bend plus the gap.
  const CELL = 8;
  const pad = 2 * WAVE_MAX + gap;
  const keysOf = (pl: Pt[]) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of pl) {
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
    const keys: string[] = [];
    for (let i = Math.floor((x0 - pad) / CELL); i <= Math.floor((x1 + pad) / CELL); i++)
      for (let j = Math.floor((y0 - pad) / CELL); j <= Math.floor((y1 + pad) / CELL); j++) keys.push(`${i},${j}`);
    return keys;
  };
  const grid = new Map<string, number[]>();
  edges.forEach((e, i) => {
    for (const k of keysOf(e.poly)) {
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k)!.push(i);
    }
  });

  const bend = (a: Pt, b: Pt): Pt[] => {
    const L = dist(a, b);
    // A smooth sum of a few half-waves, zero at both ends.
    const c1 = rng() - 0.5;
    const c2 = (rng() - 0.5) * 0.6;
    const c3 = (rng() - 0.5) * 0.3;
    const amp = Math.min(WAVE_MAX, w * WAVE_AMPLITUDE * L);
    if (amp < 0.05) return [a, b];
    const n = Math.min(30, Math.max(4, Math.ceil(L / WAVE_STEP)));
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const nx = -dy / L;
    const ny = dx / L;
    const pts: Pt[] = [a];
    for (let i = 1; i < n; i++) {
      const t = i / n;
      const d = 2 * amp * (c1 * Math.sin(Math.PI * t) + c2 * Math.sin(2 * Math.PI * t) + c3 * Math.sin(3 * Math.PI * t));
      pts.push([a[0] + t * dx + nx * d, a[1] + t * dy + ny * d]);
    }
    pts.push(b);
    return pts;
  };

  const segsOf = (pl: Pt[]) => pl.slice(1).map((q, i) => [pl[i], q] as [Pt, Pt]);
  const minDist = (x: [Pt, Pt][], y: [Pt, Pt][]) => {
    let m = Infinity;
    for (const [a0, a1] of x) for (const [b0, b1] of y) m = Math.min(m, segSegDist(a0, a1, b0, b1));
    return m;
  };

  edges.forEach((e, i) => {
    if (e.cells.length !== 2 || e.letter) return;
    const old = e.poly;
    // Straight stretches: the whole edge, or the parts either side of its tab.
    const next =
      old.length === 2
        ? bend(old[0], old[1])
        : [...bend(old[0], old[1]).slice(0, -1), ...old.slice(1, -1), ...bend(old[old.length - 2], old[old.length - 1]).slice(1)];
    if (next.length === old.length) return;

    const mine = segsOf(next);
    // Must not cross its own tab.
    for (let s = 0; s < mine.length; s++)
      for (let t = s + 2; t < mine.length; t++)
        if (segmentsIntersect(mine[s][0], mine[s][1], mine[t][0], mine[t][1])) return;

    const near = new Set<number>();
    for (const k of keysOf(next)) for (const j of grid.get(k) ?? []) if (j !== i) near.add(j);
    for (const j of near) {
      const o = edges[j];
      const theirs = segsOf(o.poly);
      const touching = o.a === e.a || o.a === e.b || o.b === e.a || o.b === e.b;
      if (touching) {
        // Edges meeting at a vertex only have to stay uncrossed.
        for (const [a0, a1] of mine) for (const [b0, b1] of theirs) if (segmentsIntersect(a0, a1, b0, b1)) return;
        continue;
      }
      const d = minDist(mine, theirs);
      if (d >= gap) continue;
      // Closer than the gap is only fine if the straight crack was already that close.
      if (d < Math.min(gap, minDist(segsOf(old), theirs)) - 1e-9) return;
    }
    straight.set(e, old);
    e.poly = next;
  });
  return straight;
}

// ---------------------------------------------------------------------------
// Fragile spots

/** Closest pair of points between two segments (the minimum is at an endpoint of one). */
function closestPoints(a0: Pt, a1: Pt, b0: Pt, b1: Pt): { p: Pt; q: Pt; d: number } {
  const onto = (pt: Pt, s0: Pt, s1: Pt): Pt => {
    const dx = s1[0] - s0[0];
    const dy = s1[1] - s0[1];
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((pt[0] - s0[0]) * dx + (pt[1] - s0[1]) * dy) / len2));
    return [s0[0] + t * dx, s0[1] + t * dy];
  };
  let best = { p: a0, q: onto(a0, b0, b1), d: Infinity };
  best.d = dist(best.p, best.q);
  for (const c of [
    { p: a1, q: onto(a1, b0, b1) },
    { p: onto(b0, a0, a1), q: b0 },
    { p: onto(b1, a0, a1), q: b1 },
  ]) {
    const d = dist(c.p, c.q);
    if (d < best.d) best = { ...c, d };
  }
  return best;
}

/**
 * A spot is fragile when a crossing narrower than `minWidth` (once the kerf is burnt)
 * runs through the piece and would split it into two parts that both matter — a tab
 * neck, a long thin sliver, a thin bridge left by the text. Sharp tips don't count:
 * snapping one only chips the point off.
 */
function findFragile(pieces: Pt[][], holes: Pt[][][], kerf: number, minWidth: number): Fragile[] {
  // A hair under the limit, so spots generated exactly at the minimum aren't reported.
  const limit = minWidth + kerf - 0.01;
  const minPart = 2 * minWidth * minWidth;
  const out: Fragile[] = [];
  pieces.forEach((pl, pi) => {
    const n = pl.length;
    let worst: Fragile | null = null;
    const consider = (at: Pt, d: number) => {
      if (!worst || d - kerf < worst.width) worst = { piece: pi, at, width: Math.max(0, d - kerf) };
    };
    const total = Math.abs(signedArea(pl));
    if (total >= 2 * minPart) {
      for (let i = 0; i < n; i++) {
        const a0 = pl[i];
        const a1 = pl[(i + 1) % n];
        const ax0 = Math.min(a0[0], a1[0]) - limit, ax1 = Math.max(a0[0], a1[0]) + limit;
        const ay0 = Math.min(a0[1], a1[1]) - limit, ay1 = Math.max(a0[1], a1[1]) + limit;
        for (let j = i + 2; j < n; j++) {
          if (i === 0 && j === n - 1) continue; // adjacent through the closing vertex
          const b0 = pl[j];
          const b1 = pl[(j + 1) % n];
          if (Math.max(b0[0], b1[0]) < ax0 || Math.min(b0[0], b1[0]) > ax1) continue;
          if (Math.max(b0[1], b1[1]) < ay0 || Math.min(b0[1], b1[1]) > ay1) continue;
          const { p, q, d } = closestPoints(a0, a1, b0, b1);
          if (d >= limit || d < 1e-9) continue;
          const mid: Pt = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
          if (!pointInPolygon(mid, pl)) continue; // a gap across the outside, not material
          // Area on one side of the crossing: p → vertices i+1..j → q.
          const part = Math.abs(signedArea([p, ...pl.slice(i + 1, j + 1), q]));
          if (Math.min(part, total - part) < minPart) continue;
          consider(mid, d);
        }
      }
    }
    // Thin walls between a piece and its holes (letter counters).
    for (const h of holes[pi]) {
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < h.length; j++) {
          const { p, q, d } = closestPoints(pl[i], pl[(i + 1) % n], h[j], h[(j + 1) % h.length]);
          if (d < limit) consider([(p[0] + q[0]) / 2, (p[1] + q[1]) / 2], d);
        }
      }
    }
    if (worst) out.push(worst);
  });
  return out;
}

// ---------------------------------------------------------------------------

const f = (n: number) => +n.toFixed(3);
const pathD = (pl: Pt[], close = false) =>
  'M' + pl.map(([x, y]) => `${f(x)} ${f(y)}`).join('L') + (close ? 'Z' : '');

export function toSvg(
  p: ShatterParams,
  r: ShatterResult,
  opts: { strokeWidth: number; frame: boolean },
): string {
  const { width: W, height: H } = p;
  const lines = r.cuts.map((pl) => `  <path d="${pathD(pl)}"/>`);
  // The frame goes last: laser software usually cuts in file order, and cutting the
  // outline first would free the sheet and let pieces shift while the rest is cut.
  if (opts.frame) {
    lines.push('  <!-- Marco exterior: se corta el último -->');
    lines.push(
      (p.shape ?? 'rect') === 'rect'
        ? `  <rect x="0" y="0" width="${f(W)}" height="${f(H)}"/>`
        : `  <path d="${pathD(r.outline, true)}"/>`,
    );
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- Broken glass puzzle · ${r.pieces.length} pieces · ${W}×${H} mm · seed ${p.seed} -->
<svg xmlns="http://www.w3.org/2000/svg" width="${f(W)}mm" height="${f(H)}mm" viewBox="0 0 ${f(W)} ${f(H)}">
<g fill="none" stroke="#000000" stroke-width="${opts.strokeWidth}" stroke-linejoin="round" stroke-linecap="round">
${lines.join('\n')}
</g>
</svg>
`;
}

export { pathD };
