// Infill, surface, bridge and ironing options added for OrcaSlicer / Bambu Studio parity change the toolpaths the way
// those slicers describe them.
import { describe, expect, it } from 'vitest';
import { weld } from '../src/engine/mesh';
import { slice, slotFromConfig } from '../src/engine/slicer';
import { resolveConfig } from '../src/profiles/resolve';
import { flowModel, templateAngle, smoothCorners } from '../src/engine/infillOptions';
import type { MeshInput } from '../src/engine/types';
import { box, cylinder, tee } from './fixtures';

const cfgFor = (printerId: string, overrides = {}, machine = {}, fil = {}) =>
  resolveConfig({ printerId, plate: 'textured_pei_plate', filamentId: 'generic-pla', presetId: '0.20', overrides, machineOverrides: machine, filamentOverrides: fil });
const mesh = (soup: Float32Array, name = 'part', extra: Partial<MeshInput> = {}): MeshInput => ({ id: name, name, ...weld(soup), ...extra });
const merge = (...soups: Float32Array[]) => { const out = new Float32Array(soups.reduce((a, s) => a + s.length, 0)); let k = 0; for (const s of soups) { out.set(s, k); k += s.length; } return out; };

interface GMove { layer: number; type: string; x0: number; y0: number; x: number; y: number; e: number; f: number }
function parse(gcode: string) {
  const moves: GMove[] = [];
  let layer = -1, type = '', x = 0, y = 0, f = 0;
  for (const line of gcode.split('\n')) {
    if (line.startsWith(';LAYER_CHANGE')) { layer++; continue; }
    if (line.startsWith(';TYPE:')) { type = line.slice(6); continue; }
    if (!/^G[0-3] /.test(line)) continue;
    const g = (k: string) => { const m = new RegExp(`${k}(-?[\\d.]+)`).exec(line); return m ? Number(m[1]) : undefined; };
    const nx = g('X') ?? x, ny = g('Y') ?? y, e = g('E') ?? 0;
    if (g('F') !== undefined) f = g('F')! / 60;
    const kind = g('X') === undefined && g('Y') === undefined ? 'retract' : line.startsWith('G0') || e === 0 ? 'travel' : type;
    moves.push({ layer, type: kind, x0: x, y0: y, x: nx, y: ny, e, f });
    x = nx; y = ny;
  }
  return moves;
}
const run = (o: object, m: MeshInput[] = [mesh(box(100, 100, 0, 20, 20, 4))], printer = 'bbl-p1s', fil = {}) => parse(slice(m, cfgFor(printer, o, {}, fil)).gcode);
const ext = (ms: GMove[], type: string, layer?: number) => ms.filter((m) => m.type === type && m.e > 0 && (layer === undefined || m.layer === layer));
const len = (ms: GMove[]) => ms.reduce((a, m) => a + Math.hypot(m.x - m.x0, m.y - m.y0), 0);
const eSum = (ms: GMove[]) => ms.reduce((a, m) => a + m.e, 0);
/** Length-weighted dominant line angle (0..180) of moves longer than 2 mm. */
const angleOf = (ms: GMove[]) => {
  const bins = new Map<number, number>();
  for (const m of ms) { const L = Math.hypot(m.x - m.x0, m.y - m.y0); if (L < 2) continue; const a = Math.round(((Math.atan2(m.y - m.y0, m.x - m.x0) * 180) / Math.PI + 360) % 180) % 180; bins.set(a, (bins.get(a) ?? 0) + L); }
  return [...bins.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
};
const near = (a: number | undefined, b: number) => a !== undefined && Math.min(Math.abs(a - b), 180 - Math.abs(a - b)) <= 2;
const sig = (ms: GMove[]) => ms.map((m) => `${m.x.toFixed(2)},${m.y.toFixed(2)}`).join(';');

describe('rotation templates and fixed directions', () => {
  it('template syntax: list, relative steps and holds', () => {
    expect(templateAngle('', 3)).toBeNull();
    expect([0, 1, 2].map((l) => templateAngle('0,90', l))).toEqual([0, 90, 0]);
    expect([0, 1, 2].map((l) => templateAngle('+15', l))).toEqual([15, 30, 45]);
    expect([0, 1, 2, 3].map((l) => templateAngle('+5#2', l))).toEqual([5, 5, 10, 10]);
  });
  it('sparse infill rotation template sets the sparse angle per layer', () => {
    const ms = run({ sparse_infill_pattern: 'zigzag', sparse_infill_rotate_template: '10,100' }, [mesh(box(100, 100, 0, 20, 20, 6))]);
    expect(near(angleOf(ext(ms, 'sparse infill', 10)), 10)).toBe(true);
    expect(near(angleOf(ext(ms, 'sparse infill', 11)), 100)).toBe(true);
  });
  it('solid infill rotation template, top and bottom layer directions', () => {
    const ms = run({ solid_infill_rotate_template: '30', top_surface_pattern: 'monotonic', internal_solid_infill_pattern: 'monotonic' });
    const top = ext(ms, 'top surface'), L = top.at(-1)!.layer;
    expect(near(angleOf(ext(ms, 'top surface', L)), 30)).toBe(true);
    const fixed = run({ top_layer_direction: 0, bottom_layer_direction: 90, top_surface_pattern: 'monotonic', bottom_surface_pattern: 'monotonic' });
    expect(near(angleOf(ext(fixed, 'top surface')), 0)).toBe(true);
    expect(near(angleOf(ext(fixed, 'bottom surface')), 90)).toBe(true);
  });
  it('align directions to model turns the directions with the object', () => {
    const m = [mesh(box(100, 100, 0, 20, 20, 6), 'p', { rotationZ: 30 })];
    const o = { sparse_infill_pattern: 'aligned_rectilinear', infill_direction: 0 };
    expect(near(angleOf(ext(run(o, m), 'sparse infill', 10)), 0)).toBe(true);
    expect(near(angleOf(ext(run({ ...o, align_infill_direction_to_model: true }, m), 'sparse infill', 10)), 30)).toBe(true);
  });
});

describe('centre-based surfaces', () => {
  const c = (ms: GMove[]) => Math.hypot(ms[0].x0 - 110, ms[0].y0 - 110);
  it('top / bottom surface fill order: outward starts at the centre, inward at the edge', () => {
    const first = (o: object, t: string) => { const ms = ext(run({ top_surface_pattern: 'concentric', bottom_surface_pattern: 'concentric', ...o }), t); return c(ms.filter((m) => m.layer === ms[0].layer)); };
    expect(first({ top_surface_fill_order: 'outward' }, 'top surface')).toBeLessThan(3);
    expect(first({ top_surface_fill_order: 'inward' }, 'top surface')).toBeGreaterThan(7);
    expect(first({ bottom_surface_fill_order: 'outward' }, 'bottom surface')).toBeLessThan(3);
    expect(first({ bottom_surface_fill_order: 'inward' }, 'bottom surface')).toBeGreaterThan(7);
  });
  it('centre of surface pattern: each surface vs the whole object', () => {
    const two = [mesh(merge(box(90, 100, 0, 15, 15, 3), box(115, 100, 0, 15, 15, 3)))];
    const minD = (o: object) => { const ms = ext(run({ top_surface_pattern: 'archimedeanchords', ...o }, two), 'top surface').filter((m) => m.x < 105); return Math.min(...ms.map((m) => Math.hypot(m.x - 97.5, m.y - 107.5))); };
    expect(minD({ center_of_surface_pattern: 'each_surface' })).toBeLessThan(1);
    expect(minD({ center_of_surface_pattern: 'each_assembly' })).toBeGreaterThan(minD({ center_of_surface_pattern: 'each_model' }) - 1e-6);
  });
});

describe('sparse patterns', () => {
  const big = () => [mesh(box(100, 100, 0, 30, 30, 8))];
  it('gyroid Z-buckling optimisation changes the wave, not the amount', () => {
    const a = ext(run({ sparse_infill_pattern: 'gyroid', sparse_infill_density: 10 }, big()), 'sparse infill');
    const b = ext(run({ sparse_infill_pattern: 'gyroid', sparse_infill_density: 10, gyroid_optimized: true }, big()), 'sparse infill');
    expect(sig(b)).not.toBe(sig(a));
    expect(len(b) / len(a)).toBeGreaterThan(0.8); expect(len(b) / len(a)).toBeLessThan(1.25);
  });
  it('adaptive density: interior density, gradient and mode', () => {
    const L = (o: object) => len(ext(run({ sparse_infill_pattern: 'gyroid', sparse_infill_density: 30, ...o }, [mesh(box(100, 100, 0, 40, 40, 12))]), 'sparse infill'));
    const off = L({}), on = L({ adaptive_infill_mode: 'normal_z', adaptive_infill_interior_density: 5 });
    expect(on).toBeLessThan(off * 0.9);
    expect(L({ adaptive_infill_mode: 'normal_z', adaptive_infill_interior_density: 20 })).toBeGreaterThan(on);
    expect(L({ adaptive_infill_mode: 'normal_z', adaptive_infill_interior_density: 5, adaptive_infill_gradient: 'quadratic' })).not.toBeCloseTo(on, 0);
    expect(L({ adaptive_infill_mode: 'stepped_shells', adaptive_infill_interior_density: 5 })).not.toBeCloseTo(on, 0);
  });
  it('infill combination max layer height sets the combined block', () => {
    const layers = (o: object) => new Set(ext(run({ infill_combination: true, layer_height: 0.1, ...o }, big()), 'sparse infill').map((m) => m.layer)).size;
    expect(layers({ infill_combination_max_layer_height: '0.2' })).toBeGreaterThan(layers({}));
  });
  it('3D honeycomb fill pattern tops adds the cell tops', () => {
    const L = (o: object) => len(ext(run({ sparse_infill_pattern: '3dhoneycomb', ...o }, big()), 'sparse infill'));
    expect(L({ infill_complete_top: true })).toBeGreaterThan(L({}));
  });
  it('Cross Zag shift step, Locked Zag lock depth', () => {
    const s = (o: object) => sig(ext(run({ sparse_infill_pattern: 'crosszag', ...o }, big()), 'sparse infill', 12));
    expect(s({ infill_shift_step: 0 })).toBe(sig(ext(run({ sparse_infill_pattern: 'zigzag' }, big()), 'sparse infill', 12)));
    expect(s({ infill_shift_step: 0.7 })).not.toBe(s({ infill_shift_step: 0 }));
    const lk = (d: number) => len(ext(run({ sparse_infill_pattern: 'lockedzag', infill_lock_depth: d }, big()), 'sparse infill'));
    expect(lk(2)).toBeGreaterThan(lk(0));
  });
  it('lateral honeycomb overhang angle and lattice angles', () => {
    const s = (o: object) => sig(ext(run(o, big()), 'sparse infill'));
    expect(s({ sparse_infill_pattern: 'lateral-honeycomb', infill_overhang_angle: 30 })).not.toBe(s({ sparse_infill_pattern: 'lateral-honeycomb' }));
    for (const [p, k1, k2] of [['lateral-lattice', 'lateral_lattice_angle_1', 'lateral_lattice_angle_2'], ['2dlattice', 'sparse_infill_lattice_angle_1', 'sparse_infill_lattice_angle_2']]) {
      const at = (o: object, l: number) => ext(run({ sparse_infill_pattern: p, ...o }, big()), 'sparse infill', l).map((m) => m.x.toFixed(1)).sort().join();
      expect(at({ [k1]: 0, [k2]: 0 }, 8)).toBe(at({ [k1]: 0, [k2]: 0 }, 13)); // vertical walls: the same every layer
      expect(at({}, 8)).not.toBe(at({}, 13)); // leaning walls move with Z
      expect(at({ [k1]: -20 }, 13)).not.toBe(at({}, 13));
    }
  });
  it('sparse infill smooth factor rounds corners', () => {
    expect(smoothCorners([{ pts: [0, 0, 10, 0, 10, 10], closed: false }], 1)[0].pts.length).toBeGreaterThan(6);
    const n = (o: object) => ext(run({ sparse_infill_pattern: 'zigzag', ...o }, big()), 'sparse infill').length;
    expect(n({ sparse_infill_smooth_factor: 100 })).toBeGreaterThan(n({}));
  });
  it('separated infills anchor the pattern on each object; symmetric infill mirrors it', () => {
    const objs = () => [mesh(box(60.37, 60.37, 0, 20, 20, 4), 'a'), mesh(box(130.81, 130.81, 0, 20, 20, 4), 'b')];
    const rel = (o: object) => { const ms = ext(run({ sparse_infill_pattern: 'aligned_rectilinear', infill_direction: 0, ...o }, objs()), 'sparse infill', 10);
      const ph = (c: number, lo: number) => ms.filter((m) => m.y > lo && m.y < lo + 20).map((m) => ((m.y - c) % 1 + 1) % 1).sort()[0].toFixed(2); return [ph(70.37, 60.37), ph(140.81, 130.81)]; };
    const [a, b] = rel({ separated_infills: true });
    expect(a).toBe(b);
    const ang = (o: object) => angleOf(ext(run({ sparse_infill_pattern: 'zigzag', infill_direction: 30, ...o }, [mesh(box(100, 100, 0, 20, 20, 6))]), 'sparse infill', 10));
    expect(near(ang({ symmetric_infill_y_axis: true }), 150)).toBe(true);
  });
});

describe('lightning', () => {
  const m = () => [mesh(box(100, 100, 0, 30, 30, 8))];
  const L = (o: object) => len(ext(run({ sparse_infill_pattern: 'lightning', sparse_infill_density: 20, ...o }, m()), 'sparse infill'));
  it('overhang, prune and straightening angles', () => {
    const base = L({});
    expect(L({ lightning_overhang_angle: 85 })).not.toBeCloseTo(base, 3);
    expect(L({ lightning_prune_angle: 85 })).toBeLessThan(L({ lightning_prune_angle: 5 }));
    expect(L({ lightning_straightening_angle: 85 })).not.toBeCloseTo(L({ lightning_straightening_angle: 5 }), 3);
  });
});

describe('top surfaces', () => {
  // a plate with a pillar in the middle: its top surface has a hole under the pillar
  const plate = () => [mesh(merge(box(100, 100, 0, 30, 30, 3), box(112, 112, 3, 6, 6, 3)))];
  const topLen = (o: object) => len(ext(run({ top_shell_layers: 1, ...o }, plate()), 'top surface').filter((m) => m.layer < 15));
  it('top surface expansion closes the hole under a raised feature (inward), outward keeps it', () => {
    const base = topLen({});
    expect(topLen({ top_surface_expansion: 4, top_surface_expansion_direction: 'inward' })).toBeGreaterThan(base + 30);
    expect(topLen({ top_surface_expansion: 4, top_surface_expansion_direction: 'outward' })).toBeLessThan(base + 30);
    expect(topLen({ top_surface_expansion: 4, top_surface_expansion_margin: 2 })).toBeGreaterThan(base);
  });
  it('one wall threshold keeps all walls on narrow tops', () => {
    const w = (o: object) => len(ext(run({ wall_loops: 3, top_one_wall_type: 'all_top', ...o }), 'inner wall', 19));
    expect(w({ min_width_top_surface: '30' })).toBeGreaterThan(w({}));
  });
  it('top/bottom infill/wall overlap', () => {
    const L = (o: object) => len(ext(run(o), 'top surface'));
    expect(L({ top_bottom_infill_wall_overlap: 100 })).toBeGreaterThan(L({}));
  });
});

describe('ironing', () => {
  const o = { ironing_type: 'top' };
  it('ironing angle offset, fixed angle and expansion', () => {
    expect(near(angleOf(ext(run(o), 'ironing')), 45)).toBe(true);
    expect(near(angleOf(ext(run({ ...o, ironing_angle: 45 }), 'ironing')), 90)).toBe(true);
    expect(near(angleOf(ext(run({ ...o, ironing_angle_fixed: true }), 'ironing')), 0)).toBe(true);
    expect(len(ext(run({ ...o, ironing_expansion: -3 }), 'ironing'))).toBeLessThan(len(ext(run(o), 'ironing')) * 0.8);
  });
  it('filament ironing overrides', () => {
    const base = ext(run(o), 'ironing');
    expect(ext(run(o, undefined, 'bbl-p1s', { filament_ironing_speed: 13 }), 'ironing').every((m) => Math.abs(m.f - 13) < 0.01)).toBe(true);
    expect(eSum(ext(run(o, undefined, 'bbl-p1s', { filament_ironing_flow: 30 }), 'ironing')) / eSum(base)).toBeCloseTo(3, 1);
    expect(len(ext(run(o, undefined, 'bbl-p1s', { filament_ironing_spacing: 0.3 }), 'ironing'))).toBeLessThan(len(base) * 0.7);
    expect(len(ext(run(o, undefined, 'bbl-p1s', { filament_ironing_inset: 3 }), 'ironing'))).toBeLessThan(len(base) * 0.8);
  });
});

describe('bridges', () => {
  const box8 = () => [mesh(box(100, 100, 0, 30, 30, 8))];
  const ib = { dont_filter_internal_bridges: 'nofilter' };
  it('internal bridges get their own line type, only when asked for (Filter keeps Bambu behaviour)', () => {
    expect(ext(run({}, box8()), 'internal bridge')).toHaveLength(0);
    expect(ext(run(ib, box8()), 'internal bridge').length).toBeGreaterThan(0);
    expect(ext(run({ detect_floating_vertical_shell: false }, box8()), 'internal bridge').length).toBeGreaterThan(0);
  });
  it('internal bridge speed, density, flow, angle, thickness and fan', () => {
    const ms = (o: object, fil = {}) => ext(run({ ...ib, ...o }, box8(), 'bbl-p1s', fil), 'internal bridge');
    expect(ms({ internal_bridge_speed: 33 }).every((m) => Math.abs(m.f - 33) < 0.01)).toBe(true);
    expect(len(ms({ internal_bridge_density: 50 }))).toBeLessThan(len(ms({})) * 0.7);
    const epm = (x: GMove[]) => eSum(x) / len(x);
    expect(epm(ms({ internal_bridge_flow: 1.5 })) / epm(ms({}))).toBeCloseTo(1.5, 1);
    expect(epm(ms({ thick_internal_bridges: false }))).toBeLessThan(epm(ms({})));
    expect(near(angleOf(ms({ internal_bridge_angle: 30 })), 30)).toBe(true);
    const g = slice(box8(), cfgFor('bbl-p1s', ib, {}, { internal_bridge_fan_speed: 17 })).gcode;
    expect(g).toMatch(/M106 S43\n(?:[^\n]*\n){0,3};TYPE:internal bridge|;TYPE:internal bridge\n(?:[^\n]*\n){0,3}M106 S43/);
  });
  it('extra bridge layers', () => {
    const lay = (o: object, t: string) => new Set(ext(run(o, [mesh(tee(100, 100))]), t).map((m) => m.layer)).size;
    expect(lay({ enable_extra_bridge_layer: 'external_bridge_only' }, 'bridge')).toBeGreaterThan(lay({}, 'bridge'));
    expect(new Set(ext(run({ ...ib, enable_extra_bridge_layer: 'internal_bridge_only' }, box8()), 'internal bridge').map((m) => m.layer)).size)
      .toBeGreaterThan(new Set(ext(run(ib, box8()), 'internal bridge').map((m) => m.layer)).size);
  });
  it('bridge line width and relative bridge angle', () => {
    const b = (o: object) => ext(run(o, [mesh(tee(100, 100))]), 'bridge');
    expect(eSum(b({ bridge_line_width: '0.3' })) / len(b({ bridge_line_width: '0.3' }))).toBeLessThan(eSum(b({})) / len(b({})));
    const auto = angleOf(b({}))!;
    expect(near(angleOf(b({ bridge_angle: 20, relative_bridge_angle: true })), (auto + 20) % 180)).toBe(true);
  });
});

describe('flow', () => {
  it('small area infill flow compensation lowers the flow of short solid lines', () => {
    const f = flowModel('0,0;\n0.2,0.4444;\n10,1')!;
    expect(f(0.2)).toBeCloseTo(0.4444, 3); expect(f(20)).toBe(1);
    expect(flowModel('1,0;2,1')).toBeNull();
    const m = [mesh(cylinder(100, 100, 3, 3))];
    const E = (o: object) => eSum(ext(run(o, m), 'internal solid infill')) + eSum(ext(run(o, m), 'top surface'));
    expect(E({ small_area_infill_flow_compensation: true })).toBeLessThan(E({}) * 0.98);
    const bad = slice(m, cfgFor('bbl-p1s', { small_area_infill_flow_compensation: true, small_area_infill_flow_compensation_model: '5,1' }));
    expect(bad.warnings.join()).toMatch(/flow compensation model/);
  });
  it('elephant foot layers density thins the internal solid infill of the compensated layers', () => {
    const E = (o: object) => eSum(ext(run({ elefant_foot_compensation_layers: 4, bottom_shell_layers: 4, ...o }), 'internal solid infill', 1));
    expect(E({ elefant_foot_layers_density: 50 }) / E({})).toBeLessThan(0.7);
  });
});

describe('paint penetration', () => {
  it('top / bottom paint penetration layers set how deep painted faces colour', () => {
    const m = mesh(box(100, 100, 0, 20, 20, 6));
    const v = m.vertices, ix = m.indices, color = new Uint8Array(ix.length / 3);
    for (let k = 0; k < color.length; k++) { const z = [0, 1, 2].map((j) => v[ix[k * 3 + j] * 3 + 2]); if (z.every((q) => q > 5.9) || z.every((q) => q < 0.1)) color[k] = 2; }
    const cfg = cfgFor('bbl-p1s');
    const a = slotFromConfig(cfg);
    const fils = [a, { ...a, name: 'B', color: '#FF0000' }];
    const grams = (o: object) => slice([{ ...m, paint: { color } }], cfgFor('bbl-p1s', o), undefined, { filaments: fils }).stats.perFilament[1]?.grams ?? 0;
    expect(grams({ top_color_penetration_layers: 10 })).toBeGreaterThan(grams({ top_color_penetration_layers: 1 }));
    expect(grams({ bottom_color_penetration_layers: 10 })).toBeGreaterThan(grams({ bottom_color_penetration_layers: 1 }));
  });
});
