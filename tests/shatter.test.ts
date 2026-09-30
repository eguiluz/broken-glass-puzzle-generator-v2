import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { shatter, toSvg, type ShatterParams, type TabStyle } from '../src/lib/shatter';
import { textRings } from '../src/lib/text';
import type { SheetShape } from '../src/lib/shapes';
import { DEFAULTS, LEGACY, distanceToRings, inInk, loadFont, overlappingCuts, selfIntersecting } from './helpers';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const svgOf = (p: ShatterParams, frame = false) => toSvg(p, shatter(p), { strokeWidth: 0.1, frame });

describe('reproducibility', () => {
  // Hashes recorded from the original generator (before the newer settings existed), so
  // shared links keep producing exactly the same puzzle.
  it.each([
    ['arrow', { concentration: 0.7, tabStyle: 'arrow' as TabStyle }, '8eeb08ff64af549c6a3bc6c11a6e1e78511272bddbf1971cbffc9aca2c566f64'],
    ['classic mix', { concentration: 1, tabStyle: 'mixed-classic' as TabStyle }, '184dab5f2435094d0a2bfc725715bc30287f052151319addab19b27a89dab28c'],
  ])('legacy %s links still give the original SVG', (_, extra, hash) => {
    expect(sha(svgOf({ ...LEGACY, ...extra }))).toBe(hash);
  });

  it('gives the same SVG for the same parameters', () => {
    expect(svgOf(DEFAULTS)).toBe(svgOf({ ...DEFAULTS }));
  });

  it('builds the requested number of pieces without text', () => {
    expect(shatter(DEFAULTS).pieces).toHaveLength(DEFAULTS.pieces);
  });
});

describe('geometry', () => {
  const styles: TabStyle[] = ['barb', 'dovetail', 'arrow', 'mixed'];
  const words = ['DAVID', 'MARÍA JOSÉ', 'Ñandú 8'];
  const cases = styles.flatMap((tabStyle, i) =>
    [1, 2, 3].map((seed) => ({
      name: `${tabStyle} · seed ${seed}${seed === 3 ? ' · text' : ''}`,
      p: {
        ...DEFAULTS,
        tabStyle,
        seed: seed + i * 10,
        coreSplit: seed,
        tabWidth: seed === 2 ? 1.4 : 1,
        tabWidthVariation: 1,
        kerf: 0.2,
        waviness: seed === 1 ? 1 : 0.5,
        textRings: seed === 3 ? textRings(loadFont(), { text: words[i % words.length], size: 40, x: 0.5, y: 0.3 }, 300, 300) : [],
      } satisfies ShatterParams,
    })),
  );

  it.each(cases)('$name: no line is cut twice', ({ p }) => {
    expect(overlappingCuts(shatter(p).cuts)).toBe(0);
  });

  it.each(cases)('$name: no piece outline crosses itself', ({ p }) => {
    expect(selfIntersecting(shatter(p).pieces)).toBe(0);
  });
});

describe('text', () => {
  const rings = textRings(loadFont(), { text: 'DAVID', size: 50, x: 0.5, y: 0.3 }, 300, 300);
  const r = shatter({ ...DEFAULTS, textRings: rings });

  it('turns every letter into a piece, counters included', () => {
    expect(r.letters.filter(Boolean)).toHaveLength(5);
    // D, A and D have a counter.
    expect(r.letters.filter((isLetter, i) => isLetter && r.holes[i].length > 0)).toHaveLength(3);
  });

  it('stops every crack at the letters', () => {
    for (const pl of r.cuts)
      for (let i = 1; i < pl.length; i++) {
        const mid: [number, number] = [(pl[i - 1][0] + pl[i][0]) / 2, (pl[i - 1][1] + pl[i][1]) / 2];
        if (distanceToRings(mid, rings) < 1e-6) continue; // the letter outline itself
        expect(inInk(mid, rings)).toBe(false);
      }
  });

  it('shrinks text that would not fit on the sheet', () => {
    const wide = textRings(loadFont(), { text: 'CONSTANTINOPLA', size: 80, x: 0.5, y: 0.5 }, 300, 300);
    const xs = wide.flat().map(([x]) => x);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xs)).toBeLessThanOrEqual(300);
  });
});

describe('fragile spots', () => {
  it('finds none in the default puzzle', () => {
    expect(shatter(DEFAULTS).fragile).toHaveLength(0);
  });

  it('flags the thin glass bridges between small letters', () => {
    const r = shatter({
      ...DEFAULTS,
      pieces: 500,
      contrast: 0.9,
      sliver: 1,
      concentration: 0.95,
      tabWidth: 0.5,
      tabStyle: 'mixed',
      textRings: textRings(loadFont(), { text: 'Lili', size: 14, x: 0.3, y: 0.2 }, 300, 300),
    });
    expect(r.fragile.length).toBeGreaterThan(0);
    expect(Math.min(...r.fragile.map((f) => f.width))).toBeLessThan(DEFAULTS.minWidth!);
  });

  it('reports nothing when the check is off', () => {
    expect(shatter({ ...DEFAULTS, minWidth: 0 }).fragile).toHaveLength(0);
  });
});

describe('sheet shapes', () => {
  const shapes: SheetShape[] = ['rounded', 'circle', 'heart'];
  const cases = shapes.map((shape) => ({
    shape,
    r: shatter({
      ...DEFAULTS,
      shape,
      cornerRadius: 40,
      tabStyle: 'mixed',
      textRings: shape === 'heart' ? textRings(loadFont(), { text: 'DAVID', size: 45, x: 0.5, y: 0.35 }, 300, 300) : [],
    }),
  }));

  it.each(cases)('$shape: no line is cut twice and no outline crosses itself', ({ r }) => {
    expect(overlappingCuts(r.cuts)).toBe(0);
    expect(selfIntersecting(r.pieces)).toBe(0);
  });

  it.each(cases)('$shape: every piece stays on the sheet', ({ r }) => {
    for (const pl of r.pieces)
      for (const q of pl) if (!inInk(q, [r.outline])) expect(distanceToRings(q, [r.outline])).toBeLessThan(1e-6);
  });

  it.each(cases)('$shape: about the requested number of pieces', ({ r }) => {
    expect(Math.abs(r.pieces.length - DEFAULTS.pieces)).toBeLessThanOrEqual(0.05 * DEFAULTS.pieces);
  });

  it('uses the outline as the frame, cut last', () => {
    const p = { ...DEFAULTS, shape: 'circle' as SheetShape };
    const drawn = svgOf(p, true).split('\n').map((l) => l.trim()).filter((l) => l.startsWith('<path') || l.startsWith('<rect'));
    expect(drawn.some((l) => l.startsWith('<rect'))).toBe(false);
    expect(drawn.at(-1)).toMatch(/Z"\/>$/);
  });
});

describe('several impacts', () => {
  const cases = [
    { name: 'a weak second impact', extraImpacts: [{ at: [235, 215] as [number, number], strength: 0.4 }] },
    { name: 'two equal impacts', extraImpacts: [{ at: [210, 150] as [number, number], strength: 1 }] },
    {
      name: 'three impacts on a heart',
      shape: 'heart' as SheetShape,
      extraImpacts: [
        { at: [80, 90] as [number, number], strength: 0.5 },
        { at: [230, 100] as [number, number], strength: 0.35 },
      ],
    },
  ].map(({ name, ...extra }) => ({ name, r: shatter({ ...DEFAULTS, tabStyle: 'mixed', ...extra }) }));

  it.each(cases)('$name: no line is cut twice and no outline crosses itself', ({ r }) => {
    expect(overlappingCuts(r.cuts)).toBe(0);
    expect(selfIntersecting(r.pieces)).toBe(0);
  });

  it.each(cases)('$name: about the requested number of pieces', ({ r }) => {
    expect(Math.abs(r.pieces.length - DEFAULTS.pieces)).toBeLessThanOrEqual(0.05 * DEFAULTS.pieces);
  });

  it('gives the single-impact puzzle when the list is empty', () => {
    expect(svgOf({ ...DEFAULTS, extraImpacts: [] })).toBe(svgOf(DEFAULTS));
  });
});

describe('wavy cracks', () => {
  it('bends the cracks but keeps every crack junction in place', () => {
    const straight = shatter({ ...DEFAULTS, waviness: 0 });
    const wavy = shatter({ ...DEFAULTS, waviness: 1 });
    const ends = (cuts: typeof straight.cuts) =>
      new Set(cuts.flatMap((pl) => [pl[0], pl.at(-1)!]).map(([x, y]) => `${x.toFixed(6)},${y.toFixed(6)}`));
    expect(wavy.cuts.reduce((n, pl) => n + pl.length, 0)).toBeGreaterThan(2 * straight.cuts.reduce((n, pl) => n + pl.length, 0));
    expect(ends(wavy.cuts)).toEqual(ends(straight.cuts));
  });

  it('never makes a piece fragile', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const straight = shatter({ ...DEFAULTS, seed, waviness: 0 }).fragile.length;
      expect(shatter({ ...DEFAULTS, seed, waviness: 1 }).fragile.length).toBeLessThanOrEqual(straight);
    }
  });
});

describe('SVG export', () => {
  it('cuts the outer frame last', () => {
    const drawn = svgOf(DEFAULTS, true)
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('<path') || l.startsWith('<rect'));
    expect(drawn.at(-1)).toMatch(/^<rect /);
    expect(drawn.filter((l) => l.startsWith('<rect'))).toHaveLength(1);
  });

  it('leaves the frame out when asked', () => {
    expect(svgOf(DEFAULTS, false)).not.toContain('<rect');
  });
});
