import { describe, expect, it } from 'vitest';
import { DEFAULT_SLICE, newZone, slice } from '../../src/workbench/generator';
import { defaultDesign, makeSurface, OUTLINES, SECTIONS, RELIEFS } from '../../src/workbench/design';
import { PRESETS } from '../../src/plugins/motionex/presets';
import { stlFromDesign } from '../../src/workbench/stl';

const brush = (id: string) => PRESETS.find((b) => b.id === id);
const small = () => ({ ...defaultDesign('vase'), height: 6, maxDiameter: 40 });

describe('Motionex Studio slicer', () => {
  it('slices a plain design with the expected layers and no bad numbers', () => {
    const r = slice(small(), DEFAULT_SLICE, [], brush);
    expect(r.layers).toBe(1 + Math.ceil((6 - 0.28) / 0.24 - 1e-6));
    expect(r.gcode).toContain(';LAYER_CHANGE');
    expect(r.gcode).not.toMatch(/[XYZEF]-?(NaN|Infinity)/);
    expect(r.stats.maxOffset).toBe(0);
  });
  it('applies motion only inside its zone (layer-wise)', () => {
    const d = small();
    const z = newZone('preset-sine', 0.5, 1); z.fade = 0;
    const r = slice(d, { ...DEFAULT_SLICE, spiral: false }, [z], brush);
    const motionZ = r.segs.filter((s) => s.kind === 'motion').map((s) => s.z);
    expect(motionZ.length).toBeGreaterThan(0);
    expect(Math.min(...motionZ)).toBeGreaterThanOrEqual(3 - 0.3);
    expect(r.stats.maxOffset).toBeGreaterThan(0.5);
  });
  it('every outline, section and relief gives a finite surface and an STL', () => {
    for (const o of OUTLINES) for (const s of SECTIONS) {
      const d = { ...defaultDesign('vase'), profile: o.pts, section: s.id, sides: 7 };
      const f = makeSurface(d);
      for (let i = 0; i < 20; i++) expect(Number.isFinite(f(i * 9, i))).toBe(true);
    }
    for (const rl of RELIEFS) {
      const d = { ...defaultDesign('vase'), relief: { ...defaultDesign('vase').relief, kind: rl.id, count: rl.count, depth: rl.depth } };
      expect(Number.isFinite(makeSurface(d)(50, 1))).toBe(true);
    }
    const stl = stlFromDesign(defaultDesign('vase'));
    expect(stl.byteLength).toBeGreaterThan(84);
  });
});
