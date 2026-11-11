// Geometry an edit can produce (a 0 % scale, a gizmo dragged through zero, a model under the bed, a broken import):
// the slicer repairs what it can and explains the rest — never a crash, a hang or a silent empty print.
import { describe, expect, it } from 'vitest';
import { slice } from '../../src/engine/slicer';
import { checkInputs, cleanProfile, finiteMesh } from '../../src/engine/validate';
import type { MeshInput } from '../../src/engine/types';
import { box, cone, cylinder, tee } from '../fixtures';
import { brimFilament, cfgWith, mesh, tube } from './helpers';
import { describeIssues, validateSlice } from './gcodeValidator';

const cube = () => box(118, 118, 0, 20, 20, 20);
const xf = (s: Float32Array, f: (x: number, y: number, z: number) => [number, number, number]) => {
  const o = new Float32Array(s.length);
  for (let i = 0; i < s.length; i += 3) o.set(f(s[i], s[i + 1], s[i + 2]), i);
  return o;
};
/** Raw (not welded) input, the way the app sends an edited object: same triangles, transformed vertices. */
const rawOf = (m: MeshInput, f: (x: number, y: number, z: number) => [number, number, number]): MeshInput => ({ ...m, vertices: xf(m.vertices, f) });
const run = (meshes: MeshInput[], o = {}) => { const cfg = cfgWith({ overrides: o }); const out = slice(meshes, cfg); return { out, issues: validateSlice(out, cfg, { allowZReset: true }) }; };
const printed = (meshes: MeshInput[], o = {}) => {
  const { out, issues } = run(meshes, o);
  expect(issues, describeIssues(issues)).toEqual([]);
  expect(out.stats.filamentMm).toBeGreaterThan(0);
  return out;
};

describe('invalid coordinates', () => {
  it('a NaN vertex skips its triangles, keeps the rest and says so', () => {
    const m = mesh(cube()); m.vertices[5] = NaN;
    const out = printed([m]);
    expect(out.warnings.join(' ')).toMatch(/invalid coordinates/);
  });
  it('an Infinity vertex no longer hangs and crashes the slicer', () => {
    const m = mesh(cube()); m.vertices[2] = Infinity;
    const t0 = Date.now();
    const { out, issues } = run([m]);
    expect(Date.now() - t0).toBeLessThan(10_000); // was 30 s, then "RangeError: Invalid array length"
    expect(issues).toEqual([]);
    // the corner's triangles are gone, so the shell is open: the user is told why, nothing is silently empty
    expect(out.warnings.join(' ')).toMatch(/invalid coordinates/);
    if (!out.stats.filamentMm) expect(out.warnings.join(' ')).toMatch(/Nothing will be printed/);
  });
  it('an object with no valid coordinate at all is named in the error', () => {
    const m = mesh(cube()); m.vertices.fill(NaN); m.name = 'Bracket';
    expect(() => slice([m], cfgWith())).toThrow(/Bracket .*no valid coordinates/);
  });
  it('one broken object does not stop the others', () => {
    const bad = mesh(cube(), 'bad'); bad.vertices.fill(NaN);
    const out = printed([bad, mesh(box(60, 60, 0, 10, 10, 10), 'good')]);
    expect(out.warnings.join(' ')).toMatch(/bad has no valid coordinates/);
  });
  it('triangle order is kept so per-triangle paint stays aligned', () => {
    const m = mesh(cube()); m.vertices[0] = NaN;
    const r = finiteMesh(m);
    expect(r.changed).toBe(true);
    expect(r.mesh.indices.length).toBe(m.indices.length);
    expect([...r.mesh.vertices].every(Number.isFinite)).toBe(true);
  });
  it('valid input passes through untouched (Basic output stays byte for byte)', () => {
    const m = mesh(cube());
    const r = checkInputs([m]);
    expect(r.meshes[0]).toBe(m);
    expect(r.warnings).toEqual([]);
  });
});

describe('scale and position edits', () => {
  it('a model scaled to 0 % in Z explains itself instead of "the plate is empty"', () => {
    const m = rawOf({ ...mesh(cube()), name: 'Lid' }, (x, y) => [x, y, 0]);
    expect(() => slice([m], cfgWith())).toThrow(/Lid has no height above the build plate/);
  });
  it('a model entirely under the bed explains itself', () => {
    const m = rawOf({ ...mesh(cube()), name: 'Sunk' }, (x, y, z) => [x, y, -z - 1]);
    expect(() => slice([m], cfgWith())).toThrow(/Sunk has no height/);
  });
  it('a sunk object next to a good one is skipped with a warning', () => {
    const sunk = rawOf({ ...mesh(cube()), name: 'Sunk' }, (x, y, z) => [x, y, -z - 1]);
    const out = printed([sunk, mesh(box(60, 60, 0, 10, 10, 10), 'ok')]);
    expect(out.warnings.join(' ')).toMatch(/Sunk lies flat or below the build plate/);
  });
  it('a mirrored model (negative scale, reversed winding) slices like the original', () => {
    const plain = printed([mesh(cube())]);
    const mirrored = printed([rawOf(mesh(cube()), (x, y, z) => [256 - x, y, z])]);
    expect(mirrored.stats.filamentMm).toBeCloseTo(plain.stats.filamentMm, 0);
  });
  it('a floating model and one half under the bed still print', () => {
    printed([rawOf(mesh(cube()), (x, y, z) => [x, y, z + 5])]);
    printed([rawOf(mesh(cube()), (x, y, z) => [x, y, z - 10])]);
  });
  it('a model bigger than the bed slices with a warning', () => {
    const { out } = run([mesh(box(-200, -200, 0, 700, 700, 4))]);
    expect(out.warnings.join(' ')).toMatch(/outside the printable area/);
  });
});

describe('models that print nothing say so', () => {
  const nothing = (meshes: MeshInput[]) => {
    const { out } = run(meshes);
    expect(out.stats.filamentMm).toBe(0);
    expect(out.warnings.join(' ')).toMatch(/Nothing will be printed/);
  };
  it('thinner than a line', () => nothing([mesh(box(120, 120, 0, 0.2, 20, 10))]));
  it('smaller than a layer', () => nothing([mesh(box(128, 128, 0, 0.1, 0.1, 0.1))]));
  it('an open (not closed) mesh', () => { const c = cube(); nothing([mesh(c.slice(0, c.length - 18))]); });
  it('cut away entirely by a negative part', () => {
    const n = mesh(box(100, 100, -5, 60, 60, 60));
    nothing([{ ...mesh(cube()), parts: [{ type: 'negative', overrides: {}, vertices: n.vertices, indices: n.indices }] }]);
  });
});

describe('variable layer height profiles', () => {
  it('zero, negative and NaN heights are left out instead of truncating the print', () => {
    const out = printed([{ ...mesh(cube()), layerHeights: [0.2, 0, -1, NaN, 0.3] }]);
    expect(out.layers[out.layers.length - 1].z).toBeGreaterThan(19.5);
    expect(out.warnings.join(' ')).toMatch(/layer height profile/);
  });
  it('a profile of zeros falls back to the uniform layer height', () => {
    expect(cleanProfile([0, 0, 0])).toBeUndefined();
    const out = printed([{ ...mesh(cube()), layerHeights: [0, 0, 0] }]);
    expect(out.layers.every((L, i) => i === 0 || L.z > out.layers[i - 1].z)).toBe(true);
  });
});

describe('awkward but valid geometry prints cleanly', () => {
  it('degenerate and out-of-range triangles', () => {
    const m = mesh(cube());
    printed([{ ...m, indices: Uint32Array.from([...m.indices, 0, 0, 0, 1, 1, 2, 0, 1, 9999]) }]);
  });
  it('duplicate shells and overlapping objects', () => {
    printed([mesh(Float32Array.from([...cube(), ...cube()]))]);
    printed([mesh(cube(), 'a'), mesh(box(125, 125, 0, 20, 20, 25), 'b')]);
  });
  it('a needle-tipped cone and a tall thin pin', () => {
    printed([mesh(cone(128, 128, 5, 0.01, 40))]);
    printed([mesh(cylinder(128, 128, 0.3, 60, 24))]);
  });
  it('an empty object next to a real one', () => printed([{ id: 'e', name: 'e', vertices: new Float32Array(0), indices: new Uint32Array(0) }, mesh(cube())]));
  it('spiral vase: thin, overhanging and several objects', () => {
    printed([mesh(cylinder(128, 128, 0.3, 30, 24))], { spiral_mode: true });
    printed([mesh(tee(128, 128))], { spiral_mode: true });
    printed([mesh(cube(), 'a'), mesh(box(60, 60, 0, 10, 10, 10), 'b')], { spiral_mode: true });
  });
  it('out-of-range filament slots, layer actions and paint arrays', () => {
    printed([{ ...mesh(cube()), filament: 12 }]);
    printed([{ ...mesh(cube()), paint: { color: new Uint8Array(3).fill(2), support: new Uint8Array(1), seam: new Uint8Array(500).fill(1) } as any }]);
    const cfg = cfgWith();
    const out = slice([mesh(cube())], cfg, () => {}, { layerActions: [{ type: 'pause', z: 999 } as any, { type: 'color', z: -5, filament: 7 } as any, { type: 'custom', z: 5, gcode: '' } as any] });
    expect(validateSlice(out, cfg)).toEqual([]);
  });
  it('an inverted height range modifier', () => printed([{ ...mesh(cube()), heightRanges: [{ z0: 15, z1: 5, overrides: { sparse_infill_density: '0%' } }] }]));
});

describe('brim and skirt stay on the plate', () => {
  it('a 100 mm brim around a part near the edge is cut at the plate edge', () => {
    const cfg = cfgWith({ overrides: { brim_type: 'outer_only', brim_width: 100 } });
    const out = slice([mesh(box(5, 5, 0, 20, 20, 5))], cfg);
    expect(validateSlice(out, cfg)).toEqual([]);
    expect(out.warnings.join(' ')).toMatch(/brim is cut at the edge/);
  });
  it('a brim that fits is unchanged', () => {
    const cfg = cfgWith({ overrides: { brim_type: 'outer_only', brim_width: 5 } });
    const out = slice([mesh(cube())], cfg);
    expect(out.warnings.join(' ')).not.toMatch(/brim is cut/);
  });
  it('skirt loops that would leave the plate are left out', () => {
    const cfg = cfgWith({ overrides: { skirt_loops: 5, skirt_distance: 20 } });
    const out = slice([mesh(box(2, 2, 0, 20, 20, 5))], cfg);
    expect(validateSlice(out, cfg)).toEqual([]);
    expect(out.warnings.join(' ')).toMatch(/skirt loop/);
  });
  it('a cut outer brim never spills into the part\'s holes', () => {
    const cfg = cfgWith({ overrides: { brim_type: 'outer_only', brim_width: 100 } });
    const out = slice([mesh(tube(14, 14, 10, 6, 5))], cfg);
    expect(out.warnings.join(' ')).toMatch(/brim is cut/);
    expect(validateSlice(out, cfg)).toEqual([]);
    expect(brimFilament(out.gcode, (x, y) => Math.hypot(x - 14, y - 14) < 6)).toBe(0);
  });
  it('cut brim ears stay ears, not a full ring', () => {
    const cfg = cfgWith({ overrides: { brim_type: 'brim_ears', brim_width: 10 } });
    const out = slice([mesh(box(3, 3, 0, 20, 20, 5))], cfg);
    expect(out.warnings.join(' ')).toMatch(/brim is cut/);
    // just above the middle of the top side: more than 10 mm from every corner (outside every ear), but inside
    // the 10 mm band a ring brim would fill
    const midTop = (x: number, y: number) => x > 12 && x < 14 && y > 28.5 && y < 31;
    expect(brimFilament(out.gcode, midTop)).toBe(0);
    const ring = slice([mesh(box(3, 3, 0, 20, 20, 5))], cfgWith({ overrides: { brim_type: 'outer_only', brim_width: 10 } }));
    expect(brimFilament(ring.gcode, midTop)).toBeGreaterThan(0); // the probe does see a ring brim
    expect(brimFilament(out.gcode, () => true)).toBeGreaterThan(0);
  });
  it('an inner brim is the same whether or not the outer brim is cut', () => {
    const inHole = (cx: number, cy: number) => (x: number, y: number) => Math.hypot(x - cx, y - cy) < 5.5;
    const cfg = cfgWith({ overrides: { brim_type: 'outer_and_inner', brim_width: 100 } });
    const free = slice([mesh(tube(128, 128, 10, 6, 5))], cfg);
    const cut = slice([mesh(tube(14, 14, 10, 6, 5))], cfg);
    expect(cut.warnings.join(' ')).toMatch(/brim is cut/);
    const a = brimFilament(free.gcode, inHole(128, 128)), b = brimFilament(cut.gcode, inHole(14, 14));
    expect(a).toBeGreaterThan(0);
    expect(b).toBeCloseTo(a, 1);
  });
});
