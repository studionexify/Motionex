import { describe, expect, it } from 'vitest';
import { defaultDesign, makeInner, makeSurface } from '../../src/workbench/design';
import { DEFAULT_SLICE, newZone, slice } from '../../src/workbench/generator';
import { PRESETS } from '../../src/plugins/motionex/presets';

const brush = (id: string) => PRESETS.find((b) => b.id === id);
const base = () => ({ ...defaultDesign('vase'), height: 8, maxDiameter: 40, openBottom: true, wall: 1.5 });

describe('thick walls', () => {
  it('relief side picks the face', () => {
    const rel = { kind: 'ribbed', count: 12, depth: 1, start: 0, end: 1, transition: 0.001 };
    const spread = (f: (z: number, t: number) => number) => { let lo = 1e9, hi = -1e9; for (let j = 0; j < 360; j++) { const v = f(4, (j / 360) * Math.PI * 2); lo = Math.min(lo, v); hi = Math.max(hi, v); } return hi - lo; };
    const out = { ...base(), relief: { ...rel, side: 'outside' as const } }, ins = { ...base(), relief: { ...rel, side: 'inside' as const } };
    expect(spread(makeSurface(out))).toBeGreaterThan(0.9); expect(spread(makeInner(out))).toBeLessThan(0.01);
    expect(spread(makeSurface(ins))).toBeLessThan(0.01); expect(spread(makeInner(ins))).toBeGreaterThan(0.9);
  });
  it('prints wall / line width lines per layer, motion only on the chosen lines', () => {
    const z = newZone('preset-sine', 0, 1); z.fade = 0; z.lines = { outer: false, inner: true, innerFrom: 2, innerTo: 2 };
    const r = slice(base(), { ...DEFAULT_SLICE, baseLayers: 0 }, [z], brush);
    const layer5 = r.segs.filter((g) => g.layer === 5 && g.kind !== 'travel');
    expect(new Set(layer5.map((g) => g.kind))).toEqual(new Set(['inner', 'wall']));
    expect(r.stats.maxOffset).toBeGreaterThan(0.3);                 // motion happened on inner line 2
    const plain = slice(base(), { ...DEFAULT_SLICE, baseLayers: 0 }, [], brush);
    expect(r.segs.filter((g) => g.kind === 'wall').length).toBeGreaterThan(0);
    expect(r.stats.lengthMm).not.toBe(plain.stats.lengthMm);
  });
});

describe('wall line layout', () => {
  it('outer lines carry the full relief, inner lines stay on the smooth inner face', () => {
    const d = { ...base(), wall: 2.5, relief: { kind: 'ribbed', count: 12, depth: 1.2, start: 0, end: 1, transition: 0.001 } };
    const r = slice(d, { ...DEFAULT_SLICE, baseLayers: 0, spiral: false, lineWidth: 0.5 }, [], brush);
    const L = 10, segs = r.segs.slice(r.layerStart[L], r.layerStart[L + 1]).filter((g) => g.kind !== 'travel');
    const rad = (g: { x: number; y: number }) => Math.hypot(g.x - 128, g.y - 128);
    const outer = segs.filter((g) => g.kind === 'wall'), inner = segs.filter((g) => g.kind === 'inner');
    const spread = (a: number[]) => Math.max(...a) - Math.min(...a);
    expect(spread(outer.map(rad))).toBeGreaterThan(1.1);
    const innermost = inner.slice(0, Math.floor(inner.length / 4));   // first printed = innermost line
    expect(spread(innermost.map(rad))).toBeLessThan(0.05);
  });
});

describe('nozzle limits', () => {
  it('a 1 mm nozzle never gets a bead wider than 2 mm, and settings stay in range', async () => {
    const { nozzleLimits } = await import('../../src/workbench/generator');
    const L = nozzleLimits(1.0, 'elegoo-n4max');
    expect(L.beadMax).toBe(2); expect(L.layerMax).toBe(0.75);
    const z = newZone('preset-beads', 0, 1); z.fade = 0; z.size = 4;
    const s = { ...DEFAULT_SLICE, nozzle: 1.0, printer: 'elegoo-n4max', lineWidth: 5, layerHeight: 2, firstLayerHeight: 2 };
    const r = slice(base(), s, [z], brush);
    for (const g of r.segs) if (g.kind !== 'travel') { expect(g.w).toBeLessThanOrEqual(2.0001); expect(g.h).toBeLessThanOrEqual(0.75001); }
    expect(r.warnings.join(' ')).toMatch(/nozzle/);
  });
});
