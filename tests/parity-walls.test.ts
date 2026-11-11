// OrcaSlicer / Snapmaker Orca wall, seam, fuzzy skin, geometry and G-code output options (parity pass 2).
import { describe, expect, it } from 'vitest';
import { weld } from '../src/engine/mesh';
import { slice } from '../src/engine/slicer';
import { resolveConfig } from '../src/profiles/resolve';
import { applyConicalOverhang, applyPolyholes, polyholeShapes, simplifyWall } from '../src/engine/wallParity';
import { interlockRegions } from '../src/engine/interlock';
import { fuzzLoop, ripplePhase } from '../src/engine/noise';
import { pickSeam } from '../src/engine/order';
import { fanSpeedup, splitForSmoothing } from '../src/engine/gcodeParity';
import { islandWalls } from '../src/engine/walls';
import { area, SCALE, toExPolygons, union } from '../src/engine/clipper';
import type { Op } from '../src/engine/gcode';
import type { MeshInput, Path, Paths } from '../src/engine/types';
import { box, cone, cylinder, tee } from './fixtures';

const cfgFor = (printerId: string, overrides = {}, machine = {}, fil = {}) =>
  resolveConfig({ printerId, plate: 'textured_pei_plate', filamentId: 'generic-pla', presetId: '0.20', overrides, machineOverrides: machine, filamentOverrides: fil });
const mesh = (soup: Float32Array, name = 'part', extra: Partial<MeshInput> = {}): MeshInput => ({ id: name, name, ...weld(soup), ...extra });
const merge = (...soups: Float32Array[]) => { const out = new Float32Array(soups.reduce((a, s) => a + s.length, 0)); let k = 0; for (const s of soups) { out.set(s, k); k += s.length; } return out; };

interface GMove { layer: number; type: string; x0: number; y0: number; z0: number; x: number; y: number; z: number; e: number; f: number; line: string }
function parse(gcode: string) {
  const moves: GMove[] = [];
  let layer = -1, type = '', x = 0, y = 0, z = 0, f = 0;
  for (const line of gcode.split('\n')) {
    if (line.startsWith(';LAYER_CHANGE')) { layer++; continue; }
    if (line.startsWith(';TYPE:')) { type = line.slice(6); continue; }
    if (!/^G[0-3] /.test(line)) continue;
    const g = (k: string) => { const m = new RegExp(`${k}(-?[\\d.]+)`).exec(line); return m ? Number(m[1]) : undefined; };
    const nx = g('X') ?? x, ny = g('Y') ?? y, nz = g('Z') ?? z, e = g('E') ?? 0;
    if (g('F') !== undefined) f = g('F')! / 60;
    const kind = g('X') === undefined && g('Y') === undefined && g('Z') === undefined ? 'retract' : line.startsWith('G0') || e === 0 ? 'travel' : type;
    moves.push({ layer, type: kind, x0: x, y0: y, z0: z, x: nx, y: ny, z: nz, e, f, line });
    x = nx; y = ny; z = nz;
  }
  return moves;
}
const ext = (ms: GMove[], type: string, layer?: number) => ms.filter((m) => m.type === type && m.e > 0 && (layer === undefined || m.layer === layer));
const eSum = (ms: GMove[]) => ms.reduce((a, m) => a + m.e, 0);
const lenSum = (ms: GMove[]) => ms.reduce((a, m) => a + Math.hypot(m.x - m.x0, m.y - m.y0), 0);
/** Turning direction of a run of moves (shoelace over the moves, > 0 = counter clockwise). */
const turn = (ms: GMove[]) => ms.reduce((a, m) => a + (m.x0 * m.y - m.x * m.y0), 0);
const P = (x: number, y: number) => ({ X: Math.round(x * SCALE), Y: Math.round(y * SCALE) });
const rect = (x0: number, y0: number, x1: number, y1: number): Path => [P(x0, y0), P(x1, y0), P(x1, y1), P(x0, y1)];
const circle = (cx: number, cy: number, r: number, n = 64, cw = false): Path => {
  const p: Path = [];
  for (let k = 0; k < n; k++) { const a = (k / n) * 2 * Math.PI; p.push(P(cx + r * Math.cos(a), cy + r * Math.sin(a))); }
  return cw ? p.reverse() : p;
};
/** A 30 mm block with a vertical round hole (r = 3 mm). */
const holed = () => mesh(box(85, 85, 0, 30, 30, 2), 'holed', { parts: [{ type: 'negative', ...weld(cylinder(100, 100, 3, 2, 64)) }] });
/** Upside-down cone: every layer overhangs the one below. */
const funnel = (steep = 1) => mesh(cone(100, 100, 5, 5 + 10 * steep, 6, 64));

describe('polyholes', () => {
  it('replaces round holes spanning layers by regular polygons; edge count, twist and margin', () => {
    const layers = (): Paths[] => [0, 1, 2].map(() => union([rect(0, 0, 20, 20), circle(10, 10, 3, 64, true)]));
    const holeOf = (sl: Paths) => toExPolygons(sl)[0].holes[0];
    const a = layers();
    applyPolyholes(a, 0, { threshold: 0.01, maxEdges: 50, twisted: false, nozzle: 0.4 });
    expect(holeOf(a[0]).length).toBe(12); // round(4 · r · 0.4 / nozzle)
    expect(holeOf(a[1])).toEqual(holeOf(a[0]));
    // the polygon circumscribes the hole: its inscribed radius is the hole radius
    expect(Math.abs(area(holeOf(a[0])))).toBeGreaterThan(Math.PI * 9);
    const b = layers();
    applyPolyholes(b, 0, { threshold: 0.01, maxEdges: 8, twisted: true, nozzle: 0.4 });
    expect(holeOf(b[0]).length).toBe(8);
    expect(holeOf(b[1])).not.toEqual(holeOf(b[0]));
    // a margin far below the faceting error leaves a polygonal (square) hole alone
    const sq = [0, 1].map(() => union([rect(0, 0, 20, 20), [P(8, 8), P(8, 12), P(12, 12), P(12, 8)]]));
    applyPolyholes(sq, 0, { threshold: 0.01, maxEdges: 50, twisted: false, nozzle: 0.4 });
    expect(holeOf(sq[0]).length).toBe(4);
    // percentage margin of the radius
    const c = layers();
    applyPolyholes(c, 0, { threshold: '1%', maxEdges: 50, twisted: false, nozzle: 0.4 });
    expect(holeOf(c[0]).length).toBe(12);
    expect(polyholeShapes(0, 0, 3, 0.4, true, 50)).toHaveLength(5);
  });
  it('changes the hole walls in the G-code', () => {
    const g = (o = {}) => slice([holed()], cfgFor('bbl-p1s', { enable_arc_fitting: false, ...o })).gcode;
    const off = g(), on = g({ hole_to_polyhole: true, hole_to_polyhole_max_edges: 6, hole_to_polyhole_twisted: false });
    expect(on).not.toBe(off);
    expect(g({ hole_to_polyhole: true, hole_to_polyhole_max_edges: 6, hole_to_polyhole_twisted: true, hole_to_polyhole_threshold: 0.05 })).not.toBe(on);
  });
});

describe('make overhang printable', () => {
  it('grows the layers under an overhang into a cone, limited by the angle', () => {
    const run = (o = {}) => parse(slice([mesh(tee(100, 100))], cfgFor('bbl-p1s', o)).gcode);
    // width of the layer 5 layers under the arm
    const below = (ms: GMove[]) => { const xs = ms.filter((m) => m.layer === 45 && m.e > 0).map((m) => m.x); return Math.max(...xs) - Math.min(...xs); };
    const off = run(), on = run({ make_overhang_printable: true }), steep = run({ make_overhang_printable: true, make_overhang_printable_angle: 80 });
    expect(below(on)).toBeGreaterThan(below(off) + 20);
    // the angle is the steepest overhang allowed, from vertical: a larger one lets the cone shrink faster
    expect(below(steep)).toBeLessThan(below(on));
    expect(below(run({ make_overhang_printable: true, make_overhang_printable_angle: 30 }))).toBeGreaterThan(below(on));
    expect(below(run({ make_overhang_printable: true, make_overhang_printable_angle: 90 }))).toBeCloseTo(below(off), 6);
  });
  it('keeps small holes in the base open when the layer above covers them', () => {
    const mk = () => [union([rect(0, 0, 20, 20), circle(10, 10, 2, 32, true)]), [rect(0, 0, 20, 20)]];
    const hs = [0.2, 0.2];
    const filled = mk(); applyConicalOverhang(filled, 0, hs, 55, 0);
    const kept = mk(); applyConicalOverhang(kept, 0, hs, 55, 50);
    expect(toExPolygons(filled[0])[0].holes.length).toBe(0);
    expect(toExPolygons(kept[0])[0].holes.length).toBe(1);
  });
});

describe('reverse on even layers', () => {
  const outerTurn = (o: object, layer: number) => turn(parse(slice([funnel()], cfgFor('bbl-p1s', { enable_arc_fitting: false, seam_gap: 0, ...o })).gcode)
    .filter((m) => m.layer === layer && m.e > 0 && (m.type === 'outer wall' || m.type === 'overhang wall')));
  const innerTurn = (o: object, layer: number) => turn(parse(slice([funnel()], cfgFor('bbl-p1s', { enable_arc_fitting: false, seam_gap: 0, ...o })).gcode)
    .filter((m) => m.layer === layer && m.e > 0 && m.type === 'inner wall'));
  it('overhanging walls run the other way on even layers only', () => {
    const on = { overhang_reverse: true, overhang_reverse_threshold: '10%' };
    expect(Math.sign(outerTurn(on, 5))).toBe(-Math.sign(outerTurn({}, 5)));
    expect(Math.sign(outerTurn(on, 6))).toBe(Math.sign(outerTurn({}, 6)));
    // a threshold the overhang never reaches changes nothing
    expect(Math.sign(outerTurn({ overhang_reverse: true, overhang_reverse_threshold: 5 }, 5))).toBe(Math.sign(outerTurn({}, 5)));
    // internal only: the outer wall keeps its direction, the inner walls turn
    const io = { ...on, overhang_reverse_internal_only: true };
    expect(Math.sign(outerTurn(io, 5))).toBe(Math.sign(outerTurn({}, 5)));
    expect(Math.sign(innerTurn(io, 5))).toBe(-Math.sign(innerTurn({}, 5)));
  });
});

describe('extra perimeters on overhangs', () => {
  it('fills the unsupported part with wall loops instead of bridge / infill', () => {
    const run = (o = {}) => parse(slice([mesh(tee(100, 100))], cfgFor('bbl-p1s', o)).gcode);
    const off = run(), on = run({ extra_perimeters_on_overhangs: true });
    expect(lenSum(ext(on, 'overhang wall', 50))).toBeGreaterThan(lenSum(ext(off, 'overhang wall', 50)) + 50);
    expect(lenSum(ext(on, 'bridge', 50))).toBeLessThan(lenSum(ext(off, 'bridge', 50)));
  });
});

describe('slow down for curled perimeters', () => {
  it('walls over the overhanging walls of the layer below are slowed', () => {
    const at = (o = {}) => { const fs = parse(slice([funnel()], cfgFor('bbl-p1s', { overhang_3_4_speed: 13, ...o })).gcode).filter((m) => m.layer === 6 && m.e > 0 && m.type === 'inner wall').map((m) => m.f); return Math.max(...fs); };
    expect(at({ slowdown_for_curled_perimeters: true })).toBeLessThan(at() * 0.7);
    expect(at({ slowdown_for_curled_perimeters: true, enable_overhang_speed: false })).toBeCloseTo(at({ enable_overhang_speed: false }), 6);
  });
});

describe('scarf joint flow, speed and overhang threshold', () => {
  const scarf = { seam_slope_type: 'external', override_filament_scarf_seam_setting: true, seam_slope_conditional: false, enable_arc_fitting: false };
  it('flow ratio and speed apply to the scarf ramp', () => {
    const run = (o = {}) => parse(slice([mesh(box(100, 100, 0, 20, 20, 2))], cfgFor('bbl-p1s', { ...scarf, ...o })).gcode);
    expect(eSum(ext(run({ scarf_joint_flow_ratio: 0.5 }), 'outer wall'))).toBeLessThan(eSum(ext(run(), 'outer wall')) - 0.05);
    const slow = ext(run({ scarf_joint_speed: 17 }), 'outer wall', 4);
    expect(slow.some((m) => Math.abs(m.f - 17) < 0.01)).toBe(true);
    expect(slow.some((m) => m.f > 17.5)).toBe(true);
    expect(ext(run({ scarf_joint_speed: '50%' }), 'outer wall', 4).some((m) => m.f < ext(run(), 'outer wall', 4)[0].f * 0.51)).toBe(true);
  });
  it('no scarf on loops that hang over the layer below beyond the threshold', () => {
    // the first layer of the tee's arm: about 80 % of its outer loop hangs in the air
    const low = (o = {}) => parse(slice([mesh(tee(100, 100))], cfgFor('bbl-p1s', { ...scarf, ...o })).gcode)
      .filter((m) => m.layer === 50 && m.e > 0 && (m.type === 'outer wall' || m.type === 'overhang wall') && m.z < 10.2 - 1e-6).length;
    expect(low({ scarf_overhang_threshold: 100 })).toBeGreaterThan(0);
    expect(low({ scarf_overhang_threshold: 50 })).toBe(0);
  });
});

describe('fuzzy skin: ripple noise and holes', () => {
  const sq = [0, 0, 20, 0, 20, 20, 0, 20];
  const rip = (phase: number) => fuzzLoop(sq, { thickness: 0.3, pointDistance: 0.5, mode: 'displacement', noise: 'ripple', scale: 1, octaves: 1, persistence: 0.5, z: 0, rnd: Math.random, width: 0.4, ripples: 8, ripplePhase: phase });
  it('ripple is a deterministic sine with N cycles per loop; the offset shifts it every few layers', () => {
    const a = rip(0), b = rip(0);
    expect(a.pts).toEqual(b.pts);
    // displacement off the bottom edge (y = 0) changes sign 2 · cycles-on-that-edge times
    const ys = a.pts.filter((_, k) => k % 2 === 1).slice(0, 160);
    const crossings = ys.slice(1).filter((y, k) => Math.sign(y) !== Math.sign(ys[k]) && y !== 0).length;
    expect(crossings).toBeGreaterThanOrEqual(3);
    expect(rip(Math.PI).pts).not.toEqual(a.pts);
    expect(ripplePhase(0, 50, 1)).toBe(0);
    expect(ripplePhase(1, 50, 1)).toBeCloseTo(Math.PI, 9);
    expect(ripplePhase(2, 50, 3)).toBe(0);
    expect(ripplePhase(3, 50, 3)).toBeCloseTo(Math.PI, 9);
  });
  it('ripple settings and the hole target change the G-code', () => {
    const g = (o = {}) => slice([holed()], cfgFor('bbl-p1s', { fuzzy_skin: 'external', fuzzy_skin_noise_type: 'ripple', ...o })).gcode;
    const base = g();
    expect(g({ fuzzy_skin_ripples_per_layer: 30 })).not.toBe(base);
    expect(g({ fuzzy_skin_ripple_offset: 0 })).not.toBe(base);
    expect(g({ fuzzy_skin_layers_between_ripple_offset: 4 })).not.toBe(base);
    // hole: only the hole's outer wall is roughened
    const wall = (o: object, hole: boolean) => parse(slice([holed()], cfgFor('bbl-p1s', { enable_arc_fitting: false, ...o })).gcode)
      .filter((m) => m.layer === 3 && m.e > 0 && m.type === 'outer wall' && (Math.hypot(m.x - 100, m.y - 100) < 5) === hole).map((m) => `${m.x},${m.y}`).join(' ');
    expect(wall({ fuzzy_skin: 'hole' }, false)).toBe(wall({}, false));
    expect(wall({ fuzzy_skin: 'hole' }, true)).not.toBe(wall({}, true));
    expect(wall({ fuzzy_skin: 'external' }, true)).toBe(wall({}, true));
  });
});

describe('Arachne wall resolution, minimum length and first layer bead width', () => {
  it('maximum resolution / deviation thin out wall points', () => {
    const pts: number[] = [];
    for (let k = 0; k < 400; k++) { const a = (k / 400) * 2 * Math.PI; pts.push(10 * Math.cos(a), 10 * Math.sin(a)); }
    expect(simplifyWall(pts, true, 0.5, 0.025).pts.length).toBeLessThan(pts.length / 2);
    expect(simplifyWall(pts, true, 0.5, 0.0001).pts.length).toBe(pts.length);
    expect(simplifyWall(pts, true, 0, 0.025).pts).toBe(pts);
    const lines = (o = {}) => slice([mesh(cylinder(100, 100, 10, 1, 400))], cfgFor('bbl-p1s', { wall_generator: 'arachne', enable_arc_fitting: false, resolution: 0, ...o })).gcode.split('\n').length;
    expect(lines({ wall_maximum_resolution: 0.5 })).toBeLessThan(lines());
    expect(lines({ wall_maximum_resolution: 0.5, wall_maximum_deviation: 0.05 })).toBeLessThanOrEqual(lines({ wall_maximum_resolution: 0.5 }));
  });
  it('short thin beads are dropped by the minimum length factor', () => {
    // a 0.5 mm wide, 3 mm long fin on a block
    const ex = toExPolygons(union([rect(0, 0, 10, 10), rect(10, 4.75, 13, 5.25)]))[0];
    const p = { walls: 2, wo: 0.42, wi: 0.45, so: 0.38, si: 0.41, nozzle: 0.4, arachne: true, minBead: 0.34, minFeature: 0.1, margin: 0.1, thinWalls: false, gapFill: false, topOneWall: null };
    const n = (f: number) => islandWalls(ex, { ...p, minLengthFactor: f }).thin.length;
    expect(n(0)).toBeGreaterThan(0);
    expect(n(25)).toBe(0);
  });
  it('first layer minimum bead width', () => {
    // a 0.3 mm thin wall
    const fin = () => mesh(merge(box(90, 90, 0, 10, 10, 1), box(100, 94.85, 0, 8, 0.3, 1)));
    const first = (o = {}) => eSum(parse(slice([fin()], cfgFor('bbl-p1s', { wall_generator: 'arachne', elefant_foot_compensation: 0, ...o })).gcode).filter((m) => m.layer === 0 && m.e > 0 && m.x > 100.5));
    // narrower than the minimum, the fin is printed at the minimum width
    expect(first({ initial_layer_min_bead_width: 150, min_feature_size: 10 })).toBeGreaterThan(first({ initial_layer_min_bead_width: 30, min_feature_size: 10 }));
  });
});

describe('unsupported walls last', () => {
  it('loops in mid air are printed innermost first, after the supported walls', () => {
    // a 30 mm plate on a 10 mm stem: the plate's first layer has nothing below its loops
    const mush = () => mesh(merge(box(95, 95, 0, 10, 10, 2), box(85, 85, 2, 30, 30, 1)));
    // distance of the first wall line of the plate's first layer from the plate's edge
    const firstWall = (o = {}) => { const m = parse(slice([mush()], cfgFor('bbl-p1s', { wall_sequence: 'outer_inner', ...o })).gcode)
      .find((q) => q.layer === 10 && q.e > 0 && /wall/.test(q.type))!; return Math.min(m.x - 85, 115 - m.x, m.y - 85, 115 - m.y); };
    expect(firstWall()).toBeLessThan(0.4);
    expect(firstWall({ unsupported_wall_last: true })).toBeGreaterThan(0.6);
  });
});

describe('wipe inward', () => {
  it('the wipe after the outer wall runs inside the part', () => {
    const wipes = (o = {}) => parse(slice([mesh(box(90, 90, 0, 20, 20, 3)), mesh(box(150, 150, 0, 10, 10, 3), 'b')], cfgFor('generic-marlin', { wall_sequence: 'inner_outer', sparse_infill_density: 0, top_shell_layers: 0, bottom_shell_layers: 0, top_shell_thickness: 0, bottom_shell_thickness: 0, ...o }, { wipe: true, wipe_distance: 3, retraction_length: 1, retract_before_wipe: 0 })).gcode)
      .filter((m) => m.layer === 6 && m.type !== 'retract' && m.e < 0 && m.x > 85 && m.x < 115);
    const edge = (ms: GMove[]) => { const d = ms.map((m) => Math.min(m.x - 90, 110 - m.x, m.y - 90, 110 - m.y)).sort((p, q) => p - q); return d[d.length >> 1]; };
    const off = wipes(), on = wipes({ wipe_inward: true }), half = wipes({ wipe_inward: true, wipe_inward_distance: '25%' });
    expect(off.length).toBeGreaterThan(0);
    expect(edge(on)).toBeGreaterThan(edge(off) + 0.15);
    expect(edge(half)).toBeLessThan(edge(on));
  });
});

describe('beam interlocking', () => {
  it('splits a band at the boundary of two filaments into alternating beams', () => {
    const a = { fil: 0, paths: [rect(0, 0, 10, 20)] }, b = { fil: 1, paths: [rect(10, 0, 20, 20)] };
    const outline = [rect(0, 0, 20, 20)];
    const p = { beamWidth: 0.8, layerCount: 2, orientation: 0, depth: 2, avoid: 1 };
    const r = interlockRegions([a, b], outline, 0, p);
    const ar = toExPolygons(r[0].paths), br = toExPolygons(r[1].paths);
    // beams of each material reach into the other side, the total area stays the same
    expect(r[0].paths.some((q) => q.some((pt) => pt.X > 10.5 * SCALE))).toBe(true);
    expect(r[1].paths.some((q) => q.some((pt) => pt.X < 9.5 * SCALE))).toBe(true);
    const tot = (ps: Paths) => ps.reduce((s, q) => s + area(q), 0);
    expect(tot(r[0].paths) + tot(r[1].paths)).toBeCloseTo(400, 0);
    expect(ar[0].contour.length + br[0].contour.length).toBeGreaterThan(20);
    // kept clear of the outside by the boundary avoidance; direction alternates after the beam layers
    expect(r[0].paths.flat().every((pt) => pt.X <= 10 * SCALE || (pt.Y >= 1.6 * SCALE - 2 && pt.Y <= 18.4 * SCALE + 2))).toBe(true);
    expect(interlockRegions([a, b], outline, 2, p)[0].paths).not.toEqual(r[0].paths);
    expect(interlockRegions([a, b], outline, 1, p)[0].paths).toEqual(r[0].paths);
    expect(interlockRegions([a, { ...b, fil: 0 }], outline, 0, p)[1].paths).toEqual(b.paths);
  });
});

describe('intra-layer object order', () => {
  it('default visits the nearest object next, as object list keeps the list order', () => {
    const objs = [mesh(box(50, 50, 0, 10, 10, 1), 'a'), mesh(box(170, 170, 0, 10, 10, 1), 'b'), mesh(box(70, 50, 0, 10, 10, 1), 'c')];
    const seq = (o: string) => [...slice(objs, cfgFor('generic-marlin', { print_order: o, exclude_object: true })).gcode.split(';LAYER_CHANGE')[3].matchAll(/M486 S(\d)/g)].map((m) => m[1]);
    expect(seq('as_obj_list')).toEqual(['0', '1', '2']);
    const d = seq('default');
    expect(d.indexOf('1')).toBe(2);
  });
});

describe('spiral vase transition flows', () => {
  const vase = (o = {}) => parse(slice([mesh(cylinder(100, 100, 10, 4, 64))], cfgFor('bbl-p1s', { spiral_mode: true, bottom_shell_layers: 2, enable_arc_fitting: false, ...o })).gcode);
  it('the first spiral loop ramps its flow up from the starting ratio', () => {
    const l2 = (ms: GMove[]) => eSum(ms.filter((m) => m.layer === 2 && m.e > 0 && m.type === 'outer wall'));
    expect(l2(vase({ spiral_starting_flow_ratio: 0 }))).toBeLessThan(l2(vase()) * 0.6);
    expect(l2(vase({ spiral_starting_flow_ratio: 0.5 }))).toBeGreaterThan(l2(vase({ spiral_starting_flow_ratio: 0 })));
  });
  it('a finishing ratio below 1 adds a flat loop at the top with falling flow', () => {
    const top = (ms: GMove[]) => { const L = Math.max(...ms.map((m) => m.layer)); return ms.filter((m) => m.layer === L && m.e > 0 && m.z === m.z0 && Math.abs(m.z - 4) < 1e-6); };
    expect(top(vase()).length).toBe(0);
    const fin = top(vase({ spiral_finishing_flow_ratio: 0 }));
    expect(fin.length).toBeGreaterThan(20);
    expect(fin[fin.length - 1].e / Math.hypot(fin[fin.length - 1].x - fin[fin.length - 1].x0, fin[fin.length - 1].y - fin[fin.length - 1].y0))
      .toBeLessThan(fin[0].e / Math.hypot(fin[0].x - fin[0].x0, fin[0].y - fin[0].y0));
  });
});

describe('G-code output', () => {
  it('high precision G-code writes 4 decimals for XYZ and 6 for E', () => {
    const g = (o = {}) => slice([mesh(cylinder(100.123456, 100, 10, 1, 64))], cfgFor('bbl-p1s', { enable_arc_fitting: false, ...o })).gcode;
    expect(g()).not.toMatch(/^G1 X\d+\.\d{4}/m);
    expect(g({ high_precision_gcode: true })).toMatch(/^G1 X\d+\.\d{4}/m);
    expect(g({ high_precision_gcode: true })).toMatch(/E\d*\.\d{6}/);
  });
  it('fan speed-up time starts the overhang fan early', () => {
    const g = (m = {}) => slice([mesh(tee(100, 100))], cfgFor('bbl-p1s', {}, m, { overhang_fan_speed: 100, fan_min_speed: 20, fan_max_speed: 20 })).gcode;
    const lead = (s: string) => {
      const L = s.split(';LAYER_CHANGE')[51].split('\n');
      return L.indexOf(';TYPE:overhang wall') - L.indexOf('M106 S255');
    };
    expect(lead(g({ fan_speedup_time: 3 }))).toBeGreaterThan(lead(g()));
    // on the op stream: only overhang fans move with "only overhangs"
    const mv = (fanMin?: number, fanSet?: number): Op => ({ k: 'move', x: 0, y: 0, z: 0, e: 1, f: 10, feature: 'inner_wall', w: 0.4, h: 0.2, travel: false, t: 1, fanMin, fanSet });
    const ops = [mv(), mv(), mv(), mv(undefined, 80), mv(), mv(), mv(100)];
    const a = ops.map((o) => ({ ...o })) as Op[];
    fanSpeedup(a, 2.5, true, 30);
    expect((a as any[]).map((o) => o.fanMin ?? 0)).toEqual([0, 0, 0, 0, 100, 100, 100]);
    const b = ops.map((o) => ({ ...o })) as Op[];
    fanSpeedup(b, 2.5, false, 30);
    expect((b[1] as any).fanMin).toBe(80);
  });
  it('smoothing segment length and external only', () => {
    const ops: Op[] = [{ k: 'move', x: 0, y: 0, z: 0, e: 0, f: 100, feature: 'travel', w: 0, h: 0.2, travel: true }, { k: 'move', x: 10, y: 0, z: 0, e: 1, f: 50, feature: 'inner_wall', w: 0.4, h: 0.2, travel: false }];
    expect(splitForSmoothing(ops, 3, false)).toHaveLength(5);
    expect(splitForSmoothing(ops, 3, true)).toHaveLength(2);
    const lines = (o = {}) => slice([mesh(box(100, 100, 0, 20, 20, 1))], cfgFor('bbl-p1s', { max_volumetric_extrusion_rate_slope_positive: 20, enable_arc_fitting: false, ...o })).gcode.split('\n').length;
    expect(lines({ max_volumetric_extrusion_rate_slope_segment_length: 1 })).toBeGreaterThan(lines({ max_volumetric_extrusion_rate_slope_segment_length: 5 }));
    expect(lines({ max_volumetric_extrusion_rate_slope_segment_length: 1, extrusion_rate_smoothing_external_perimeter_only: true })).toBeLessThan(lines({ max_volumetric_extrusion_rate_slope_segment_length: 1 }));
  });
});

describe('seam position aligned back', () => {
  it('starts at the back and then follows the seam of the layer below', () => {
    const sqr = [0, 0, 20, 0, 20, 20, 0, 20, 0, 10];
    expect(sqr[pickSeam(sqr, 'aligned_back', 0, 0, null, Math.random) * 2 + 1]).toBe(20);
    expect(pickSeam(sqr, 'aligned_back', 0, 0, [20, 0.5], Math.random)).toBe(1);
    const seams = (mode: string) => ext(parse(slice([mesh(cylinder(100, 100, 10, 2, 64))], cfgFor('bbl-p1s', { seam_position: mode, enable_arc_fitting: false })).gcode), 'outer wall')
      .filter((m, k, a) => k === 0 || a[k - 1].layer !== m.layer).map((m) => m.y0);
    const ab = seams('aligned_back');
    expect(ab[0]).toBeGreaterThan(108);
    expect(Math.max(...ab) - Math.min(...ab)).toBeLessThan(1.5);
  });
});
