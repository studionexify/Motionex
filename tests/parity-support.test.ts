// OrcaSlicer / Bambu Studio parity: support, raft, tree support and brim options.
import { describe, expect, it } from 'vitest';
import { weld } from '../src/engine/mesh';
import { slice } from '../src/engine/slicer';
import { resolveConfig } from '../src/profiles/resolve';
import type { MeshInput } from '../src/engine/types';
import { box, cone, tee } from './fixtures';
import { decimateLoop, organicTipSpacing, sharpCorners, smallSupportSpeed } from '../src/engine/supportExtras';
import { SCALE } from '../src/engine/clipper';

const cfgFor = (overrides = {}) =>
  resolveConfig({ printerId: 'bbl-p1s', plate: 'textured_pei_plate', filamentId: 'generic-pla', presetId: '0.20', overrides, machineOverrides: {}, filamentOverrides: {} });
const mesh = (soup: Float32Array, name = 'part', extra: Partial<MeshInput> = {}): MeshInput => ({ id: name, name, ...weld(soup), ...extra });
const merge = (...soups: Float32Array[]) => { const out = new Float32Array(soups.reduce((a, s) => a + s.length, 0)); let k = 0; for (const s of soups) { out.set(s, k); k += s.length; } return out; };

/** Convex prism from a CCW polygon (xy pairs), z0..z1. */
function prism(poly: [number, number][], z0: number, z1: number): Float32Array {
  const t: number[] = [];
  const n = poly.length;
  for (let k = 1; k < n - 1; k++) {
    t.push(poly[0][0], poly[0][1], z1, poly[k][0], poly[k][1], z1, poly[k + 1][0], poly[k + 1][1], z1);
    t.push(poly[0][0], poly[0][1], z0, poly[k + 1][0], poly[k + 1][1], z0, poly[k][0], poly[k][1], z0);
  }
  for (let k = 0; k < n; k++) {
    const a = poly[k], b = poly[(k + 1) % n];
    t.push(a[0], a[1], z0, b[0], b[1], z0, b[0], b[1], z1, a[0], a[1], z0, b[0], b[1], z1, a[0], a[1], z1);
  }
  return new Float32Array(t);
}

interface GMove { layer: number; type: string; x: number; y: number; e: number; f: number; xy: boolean }
function parse(gcode: string) {
  const moves: GMove[] = [];
  let layer = -1, type = '', x = 0, y = 0, f = 0;
  for (const line of gcode.split('\n')) {
    if (line.startsWith(';LAYER_CHANGE')) { layer++; continue; }
    if (line.startsWith(';TYPE:')) { type = line.slice(6); continue; }
    if (!/^G[0-3] /.test(line)) continue;
    const g = (k: string) => { const m = new RegExp(` ${k}(-?[\\d.]+)`).exec(line); return m ? Number(m[1]) : undefined; };
    x = g('X') ?? x; y = g('Y') ?? y;
    if (g('F') !== undefined) f = g('F')! / 60;
    moves.push({ layer, type, x, y, e: g('E') ?? 0, f, xy: g('X') !== undefined || g('Y') !== undefined });
  }
  return moves;
}
const ext = (ms: GMove[], type: string, layer?: number) => ms.filter((m) => m.type === type && m.e > 0 && m.xy && (layer === undefined || m.layer === layer));
const eSum = (ms: GMove[]) => ms.reduce((a, m) => a + m.e, 0);
/** The toolpath part of the G-code (no settings block). */
const moves = (g: string) => g.split('\n').filter((l) => /^G[0-3] /.test(l)).join('\n');
const run = (meshes: MeshInput[], o: Record<string, unknown>) => parse(slice(meshes, cfgFor(o)).gcode);

describe('support options', () => {
  const t = () => [mesh(tee(100, 100))];
  it('enforce support layers supports gentle overhangs of the first layers, even with support off', () => {
    const flare = [mesh(cone(100, 100, 8, 9.5, 3))];
    expect(ext(run(flare, { enable_support: true }), 'support').length).toBe(0);
    expect(ext(run(flare, { enable_support: false, enforce_support_layers: 10 }), 'support').length).toBeGreaterThan(0);
  });
  it('raft expansion grows every raft layer', () => {
    const minX = (ms: GMove[], L: number) => Math.min(...ms.filter((m) => m.layer === L && m.e > 0 && m.type.startsWith('support')).map((m) => m.x));
    const b = [mesh(box(100, 100, 0, 10, 10, 2))];
    const a = run(b, { raft_layers: 3, raft_expansion: 0 }), c = run(b, { raft_layers: 3, raft_expansion: 4 });
    expect(minX(a, 1) - minX(c, 1)).toBeGreaterThan(3);
    expect(minX(a, 2) - minX(c, 2)).toBeGreaterThan(3);
  });
  it('loop pattern interface puts a loop on the top contact layer', () => {
    const base = { enable_support: true, support_type: 'normal_auto', support_interface_top_layers: 2 };
    const off = slice(t(), cfgFor(base)).gcode, on = slice(t(), cfgFor({ ...base, support_interface_loop_pattern: true })).gcode;
    expect(on).not.toBe(off);
    expect(eSum(ext(parse(on), 'support interface'))).toBeGreaterThan(eSum(ext(parse(off), 'support interface')) * 0.9);
  });
  it('small support perimeters slow down short support paths', () => {
    const base = { enable_support: true, support_type: 'tree_auto', support_speed: 150, support_interface_speed: 80 };
    const fast = run(t(), base), slow = run(t(), { ...base, small_support_perimeter_threshold: 1000, small_support_perimeter_speed: 9 });
    expect(Math.max(...ext(fast, 'support').map((m) => m.f))).toBeGreaterThan(20);
    expect(ext(slow, 'support').filter((m) => m.layer > 0).every((m) => m.f <= 9 + 1e-6)).toBe(true);
    const pct = run(t(), { ...base, small_support_perimeter_threshold: 1000, small_support_perimeter_speed: '10%' });
    expect(ext(pct, 'support').filter((m) => m.layer > 0).every((m) => m.f <= 15 + 1e-6)).toBe(true);
    // helper: 0 = half of the base speed, longer paths unaffected
    expect(smallSupportSpeed({ pts: [0, 0, 1, 0], closed: false }, 1, 0, 80)).toBe(40);
    expect(smallSupportSpeed({ pts: [0, 0, 100, 0], closed: false }, 1, 20, 80)).toBeUndefined();
  });
  it('tree support brim widens the branch feet on the first layer (fixed or auto width)', () => {
    const base = { enable_support: true, support_type: 'tree_auto', support_style: 'tree_slim' };
    const l0 = (o: Record<string, unknown>) => eSum(ext(run(t(), { ...base, ...o }), 'support', 0));
    const none = l0({}), fixed = l0({ tree_support_brim_width: 3 }), auto = l0({ tree_support_auto_brim: true });
    expect(fixed).toBeGreaterThan(none * 1.2);
    expect(auto).toBeGreaterThan(none * 1.05);
    // organic trees have no brim (Orca)
    const org = { ...base, support_style: 'tree_organic' };
    expect(moves(slice(t(), cfgFor({ ...org, tree_support_brim_width: 3 })).gcode)).toBe(moves(slice(t(), cfgFor(org)).gcode));
  });
  it('tree organic reads its own branch settings', () => {
    const org = { enable_support: true, support_type: 'tree_auto', support_style: 'tree_organic' };
    const g = (o: Record<string, unknown>) => moves(slice(t(), cfgFor({ ...org, ...o })).gcode);
    const ref = g({});
    for (const o of [{ tree_support_branch_distance_organic: 3 }, { tree_support_top_rate: 10 }, { tree_support_branch_diameter_organic: 8 },
      { tree_support_branch_angle_organic: 15 }, { tree_support_angle_slow: 60 }]) expect(g(o)).not.toBe(ref);
    // the shared tree keys do not steer organic trees
    expect(g({ tree_support_branch_distance: 8 })).toBe(ref);
    expect(organicTipSpacing(0.42, 30, 1.6)).toBeCloseTo(0.42 * 100 / 30 + 1.18, 6);
  });
});

describe('brim options', () => {
  const ears = { brim_type: 'brim_ears', brim_width: 4 };
  it('brim ear max angle picks the corners that get ears', () => {
    const b = [mesh(box(100, 100, 0, 20, 20, 2))];
    expect(ext(run(b, ears), 'brim').length).toBeGreaterThan(0);
    expect(ext(run(b, { ...ears, brim_ears_max_angle: 60 }), 'brim').length).toBe(0);
  });
  it('brim ear detection radius simplifies chamfered corners before looking for sharp ones', () => {
    const c = 0.4; // tiny chamfers: two 135° corners each, a 90° corner once simplified
    const poly: [number, number][] = [[90 + c, 90], [110 - c, 90], [110, 90 + c], [110, 110 - c], [110 - c, 110], [90 + c, 110], [90, 110 - c], [90, 90 + c]];
    const p = [mesh(prism(poly, 0, 2))];
    expect(ext(run(p, ears), 'brim').length).toBe(0);
    expect(ext(run(p, { ...ears, brim_ears_detection_length: 1 }), 'brim').length).toBeGreaterThan(0);
    const sq = poly.map(([x, y]) => ({ X: Math.round(x * SCALE), Y: Math.round(y * SCALE) }));
    expect(decimateLoop(sq, 1).length).toBe(4);
    expect(sharpCorners(decimateLoop(sq, 1), 125).length).toBe(4);
  });
  it('brim ears outer only skips holes and parts enclosed by them', () => {
    // a frame with an island in its hole
    const frame = merge(box(80, 80, 0, 40, 5, 2), box(80, 115, 0, 40, 5, 2), box(80, 85, 0, 5, 30, 2), box(115, 85, 0, 5, 30, 2), box(95, 95, 0, 10, 10, 2));
    const m = [mesh(frame)];
    const all = eSum(ext(run(m, ears), 'brim')), outer = eSum(ext(run(m, { ...ears, brim_ears_outer_only: true }), 'brim'));
    expect(outer).toBeGreaterThan(0);
    expect(outer).toBeLessThan(all);
  });
  it('brim follows the compensated outline, or the outline before elephant foot compensation', () => {
    const b = [mesh(box(100, 100, 0, 20, 20, 2))];
    const o = { brim_type: 'outer_only', brim_width: 3, elefant_foot_compensation: 0.4 };
    const minX = (ms: GMove[]) => Math.min(...ext(ms, 'brim').map((m) => m.x));
    const on = minX(run(b, o)), off = minX(run(b, { ...o, brim_use_efc_outline: false }));
    expect(on - off).toBeGreaterThan(0.3);
    expect(on - off).toBeLessThan(0.5);
  });
  it('combine brims merges the brims of objects close to each other', () => {
    const two = [mesh(box(100, 100, 0, 10, 10, 2), 'a'), mesh(box(114, 100, 0, 10, 10, 2), 'b')];
    const o = { brim_type: 'outer_only', brim_width: 5 };
    const sep = eSum(ext(run(two, o), 'brim')), comb = eSum(ext(run(two, { ...o, combine_brims: true }), 'brim'));
    expect(comb).toBeGreaterThan(0);
    expect(comb).toBeLessThan(sep * 0.9);
    // the combined brim stays clear of both objects
    const ms = ext(run(two, { ...o, combine_brims: true }), 'brim');
    expect(ms.some((m) => m.x > 110.05 && m.x < 113.95 && m.y > 100.05 && m.y < 109.95)).toBe(false);
  });
});
