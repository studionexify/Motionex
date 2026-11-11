// Every Advanced engine intent with plain, vase, hollow, supported and over-wide-brim settings: each slice must finish
// and pass the strict G-code validator.
import { describe, expect, it } from 'vitest';
import { slice } from '../../src/engine/slicer';
import { type Config } from '../../src/profiles/settings';
import { cylinder, tee } from '../fixtures';
import { brimFilament, cfgWith, mesh, PRINTER, tube } from './helpers';
import { describeIssues, validateSlice } from './gcodeValidator';

describe('Advanced engine intents', () => {
  const shapes = () => [mesh(tee(128, 128), 'tee'), mesh(cylinder(128, 175, 12, 25, 64), 'cyl')];
  for (const intent of ['structural', 'aesthetic', 'optical', 'acoustic', 'morph4d'])
    for (const ov of [{}, { spiral_mode: true }, { wall_loops: 1, sparse_infill_density: '0%' }, { enable_support: true }, { brim_type: 'outer_only', brim_width: 100 }] as Config[])
      it(`${intent} ${JSON.stringify(ov)}`, () => {
        const cfg = cfgWith({ overrides: ov });
        const out = slice(shapes(), cfg, () => {}, { advanced: { intent, printerId: PRINTER, techs: {}, resolution: 'draft' } as any });
        // non-planar technologies (conformal layers, Z weave) may dip below the layer plane; never below the bed
        const issues = validateSlice(out, cfg, { allowZReset: true });
        expect(issues, describeIssues(issues)).toEqual([]);
        expect(out.stats.filamentMm).toBeGreaterThan(0);
      });
});

describe('Advanced engine brim at the plate edge', () => {
  const run = (cx: number, cy: number, type: string) => {
    const cfg = cfgWith({ overrides: { brim_type: type, brim_width: 100 } });
    const out = slice([mesh(tube(cx, cy, 10, 6, 5))], cfg, () => {}, { advanced: { intent: 'structural', printerId: PRINTER, techs: {}, resolution: 'draft' } as any });
    expect(validateSlice(out, cfg, { allowZReset: true })).toEqual([]);
    return out;
  };
  const inHole = (cx: number, cy: number) => (x: number, y: number) => Math.hypot(x - cx, y - cy) < 5.5;
  it('a cut outer brim never spills into the holes', () => {
    const out = run(14, 14, 'outer_only');
    expect(out.warnings.join(' ')).toMatch(/brim is cut/);
    expect(brimFilament(out.gcode, inHole(14, 14))).toBe(0);
  });
  it('outer and inner: the inner brim is printed once, as when nothing is cut', () => {
    const free = brimFilament(run(128, 128, 'outer_and_inner').gcode, inHole(128, 128));
    const cut = brimFilament(run(14, 14, 'outer_and_inner').gcode, inHole(14, 14));
    expect(free).toBeGreaterThan(0);
    expect(cut).toBeCloseTo(free, 1);
  });
});
