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
