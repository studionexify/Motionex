// Settings wiring: every process, filament and printer setting changes the toolpaths or the G-code.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { weld } from '../src/engine/mesh';
import { slice } from '../src/engine/slicer';
import { filamentSlots, resolveConfig } from '../src/profiles/resolve';
import { PROCESS_PARAMS } from '../src/profiles/settings';
import { FILAMENT_PARAMS } from '../src/profiles/filamentParams';
import { MACHINE_PARAMS } from '../src/profiles/machineParams';
import type { MeshInput } from '../src/engine/types';
import { bambuFlushes, box, cone, cylinder, tee } from './fixtures';

const cfgFor = (printerId: string, overrides = {}, machine = {}, fil = {}) =>
  resolveConfig({ printerId, plate: 'textured_pei_plate', filamentId: 'generic-pla', presetId: '0.20', overrides, machineOverrides: machine, filamentOverrides: fil });
const mesh = (soup: Float32Array, name = 'part', extra: Partial<MeshInput> = {}): MeshInput => ({ id: name, name, ...weld(soup), ...extra });
const merge = (...soups: Float32Array[]) => { const out = new Float32Array(soups.reduce((a, s) => a + s.length, 0)); let k = 0; for (const s of soups) { out.set(s, k); k += s.length; } return out; };

interface GMove { layer: number; type: string; x0: number; y0: number; x: number; y: number; z: number; e: number; f: number; line: string }
/** Extrusion and travel moves from G-code text, with the line type and layer they belong to. */
function parse(gcode: string) {
  const moves: GMove[] = [];
  const layerZ: number[] = [];
  let layer = -1, type = '', x = 0, y = 0, z = 0, f = 0;
  for (const line of gcode.split('\n')) {
    if (line.startsWith(';LAYER_CHANGE')) { layer++; continue; }
    if (line.startsWith(';Z:')) { layerZ[layer] = Number(line.slice(3)); continue; }
    if (line.startsWith(';TYPE:')) { type = line.slice(6); continue; }
    if (!/^G[0-3] /.test(line)) continue;
    const g = (k: string) => { const m = new RegExp(`${k}(-?[\\d.]+)`).exec(line); return m ? Number(m[1]) : undefined; };
    const nx = g('X') ?? x, ny = g('Y') ?? y, nz = g('Z') ?? z, e = g('E') ?? 0;
    if (g('F') !== undefined) f = g('F')! / 60;
    // a bare G1 E… is a (de)retraction, a move without extrusion is travel
    const kind = g('X') === undefined && g('Y') === undefined && g('Z') === undefined ? 'retract' : line.startsWith('G0') || e === 0 ? 'travel' : type;
    moves.push({ layer, type: kind, x0: x, y0: y, x: nx, y: ny, z: nz, e, f, line });
    x = nx; y = ny; z = nz;
  }
  return { moves, layerZ, layers: layer + 1 };
}
const extrusionLen = (ms: GMove[], type: string) => ms.filter((m) => m.type === type && m.e > 0).reduce((a, m) => a + Math.hypot(m.x - m.x0, m.y - m.y0), 0);
const types = (gcode: string) => new Set(gcode.match(/;TYPE:[a-z ]+/g)?.map((t) => t.slice(6)));

describe('settings are wired, not dummies', () => {
  const engine = ['src/engine/slicer.ts', 'src/engine/gcode.ts', 'src/engine/wipeTower.ts', 'src/engine/adaptivePA.ts', 'src/engine/walls.ts', 'src/engine/support.ts', 'src/engine/infillOptions.ts', 'src/profiles/resolve.ts', 'src/profiles/changer.ts', 'src/plugins/patternex/model.ts']
    .map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  // keys that are stored and written into the G-code config block, rather than steering toolpaths
  const metadata = new Set(['process_notes', 'filament_notes', 'printer_notes', 'filament_vendor', 'filename_format', 'post_process']);
  const referenced = (k: string) => engine.includes(`'${k}'`) || engine.includes(`.${k}`) || engine.includes(`"${k}"`);
  it('every process setting is read by the engine', () => {
    const missing = PROCESS_PARAMS.map((p) => p.key).filter((k) => !metadata.has(k) && !referenced(k));
    expect(missing).toEqual([]);
  });
  it('every filament and printer setting is read by the engine (or is a filament override of one)', () => {
    const keys = [...FILAMENT_PARAMS, ...MACHINE_PARAMS].map((p) => p.key).filter((k) => !metadata.has(k));
    const missing = keys.filter((k) => !referenced(k) && !(k.startsWith('filament_') && referenced(k.slice('filament_'.length))) && !/_plate_temp/.test(k));
    expect(missing).toEqual([]);
  });
});

describe('quality', () => {
  it('scarf joint seam ramps the loop start below the layer top', () => {
    const c = mesh(cylinder(100, 100, 12, 6, 96));
    const out = slice([c], cfgFor('bbl-p1s', { seam_slope_type: 'all', override_filament_scarf_seam_setting: true, seam_slope_min_length: 8, seam_slope_steps: 4 }));
    const p = parse(out.gcode);
    const L = 15;
    const walls = p.moves.filter((m) => m.layer === L && m.type === 'outer wall' && m.e > 0);
    expect(walls.some((m) => m.z < p.layerZ[L] - 0.01)).toBe(true);
    const plain = parse(slice([c], cfgFor('bbl-p1s')).gcode);
    expect(plain.moves.filter((m) => m.layer === L && m.type === 'outer wall' && m.e > 0).every((m) => Math.abs(m.z - plain.layerZ[L]) < 1e-6)).toBe(true);
  });

  it('seam gap stops the loop short of its start', () => {
    const b = mesh(box(100, 100, 0, 20, 20, 3));
    const seamEnd = (gap: number) => {
      const p = parse(slice([b], cfgFor('bbl-p1s', { seam_gap: gap })).gcode);
      const w = p.moves.filter((m) => m.layer === 5 && m.type === 'outer wall' && m.e > 0);
      return Math.hypot(w[w.length - 1].x - w[0].x0, w[w.length - 1].y - w[0].y0);
    };
    expect(seamEnd(0)).toBeLessThan(1e-3);
    expect(seamEnd(50)).toBeCloseTo(0.2, 1);
  });

  it('precise Z height lands the last layer on the model top', () => {
    const b = mesh(box(100, 100, 0, 20, 20, 10.1));
    const plain = slice([b], cfgFor('bbl-p1s'));
    const precise = slice([b], cfgFor('bbl-p1s', { precise_z_height: true }));
    expect(plain.layers.at(-1)!.z).not.toBeCloseTo(10.1, 3);
    expect(precise.layers.at(-1)!.z).toBeCloseTo(10.1, 3);
  });

  it('slice gap closing radius closes hairline cracks', () => {
    // two boxes 0.05 mm apart: closed into one island with a radius of 0.049, two islands without
    const twin = mesh(merge(box(100, 100, 0, 10, 10, 2), box(110.05, 100, 0, 10, 10, 2)));
    const loops = (r: number) => (parse(slice([twin], cfgFor('bbl-p1s', { slice_closing_radius: r })).gcode).moves.filter((m) => m.layer === 3 && m.type === 'travel').length);
    expect(loops(0.049)).toBeLessThan(loops(0));
  });

  it('ironing pattern, inset and all-solid ironing change the ironing pass', () => {
    const b = mesh(box(100, 100, 0, 20, 20, 3));
    const iron = (o = {}) => extrusionLen(parse(slice([b], cfgFor('bbl-p1s', { ironing_type: 'top', ...o })).gcode).moves, 'ironing');
    const base = iron();
    expect(base).toBeGreaterThan(0);
    expect(slice([b], cfgFor('bbl-p1s', { ironing_type: 'top', ironing_pattern: 'concentric' })).gcode).not.toBe(slice([b], cfgFor('bbl-p1s', { ironing_type: 'top' })).gcode);
    expect(iron({ ironing_inset: 3 })).toBeLessThan(base * 0.8);
    expect(iron({ ironing_type: 'solid' })).toBeGreaterThan(base * 1.5);
  });

  it('flow ratios scale the extrusion', () => {
    const b = mesh(box(100, 100, 0, 20, 20, 3));
    const e = (o = {}) => slice([b], cfgFor('bbl-p1s', o)).stats.filamentMm;
    expect(e({ print_flow_ratio: 1.1 }) / e()).toBeGreaterThan(1.07);
    expect(e({ top_solid_infill_flow_ratio: 1.3 })).toBeGreaterThan(e());
    expect(e({ initial_layer_flow_ratio: 1.3 })).toBeGreaterThan(e());
  });

  it('one wall on top surfaces, one wall on the first layer', () => {
    const b = mesh(box(100, 100, 0, 20, 20, 3));
    const topInner = (t: string) => extrusionLen(parse(slice([b], cfgFor('bbl-p1s', { top_one_wall_type: t })).gcode).moves.filter((m) => m.layer === 14), 'inner wall');
    expect(topInner('not_apply')).toBeGreaterThan(50);
    expect(topInner('all_top')).toBeLessThan(5);
    const first = (v: boolean) => extrusionLen(parse(slice([b], cfgFor('bbl-p1s', { only_one_wall_first_layer: v })).gcode).moves.filter((m) => m.layer === 0), 'inner wall');
    expect(first(false)).toBeGreaterThan(50);
    expect(first(true)).toBe(0);
  });

  it('avoid crossing walls detours inside the part', () => {
    // a U shape: travel between the arms would cross the gap
    const u = mesh(merge(box(100, 100, 0, 30, 6, 4), box(100, 106, 0, 6, 20, 4), box(124, 106, 0, 6, 20, 4)));
    const travel = (v: boolean) => parse(slice([u], cfgFor('bbl-p1s', { reduce_crossing_wall: v, wall_loops: 2 })).gcode).moves.filter((m) => m.type === 'travel').length;
    expect(travel(true)).toBeGreaterThan(travel(false));
  });
});

describe('strength', () => {
  it('alternate extra wall adds a wall on every other layer', () => {
    const b = mesh(box(100, 100, 0, 20, 20, 6));
    const p = parse(slice([b], cfgFor('bbl-p1s', { alternate_extra_wall: true, top_one_wall_type: 'not_apply' })).gcode);
    expect(extrusionLen(p.moves.filter((m) => m.layer === 11), 'inner wall')).toBeGreaterThan(extrusionLen(p.moves.filter((m) => m.layer === 10), 'inner wall') * 1.3);
  });

  it('detect thin wall prints a too-thin wall as one bead', () => {
    const thin = mesh(box(100, 100, 0, 0.35, 20, 3)); // thinner than one line: classic walls skip it
    const outer = (v: boolean) => extrusionLen(parse(slice([thin], cfgFor('bbl-p1s', { detect_thin_wall: v })).gcode).moves, 'outer wall');
    expect(outer(true)).toBeGreaterThan(outer(false) + 20);
  });

  it('gap fill fills what walls and infill leave between them', () => {
    const narrow = mesh(box(100, 100, 0, 1.0, 20, 3)); // room for the outer walls, not for the inner ones
    expect(types(slice([narrow], cfgFor('bbl-p1s', { wall_loops: 2 })).gcode).has('gap infill')).toBe(true);
  });

  it('top / bottom surface density and internal solid pattern', () => {
    const b = mesh(box(100, 100, 0, 20, 20, 3));
    const top = (d: number) => extrusionLen(parse(slice([b], cfgFor('bbl-p1s', { top_surface_density: d })).gcode).moves, 'top surface');
    expect(top(50)).toBeLessThan(top(100) * 0.7);
    const g1 = slice([b], cfgFor('bbl-p1s', { internal_solid_infill_pattern: 'concentric' })).gcode;
    const g2 = slice([b], cfgFor('bbl-p1s')).gcode;
    expect(g1).not.toBe(g2);
  });

  it('every sparse infill pattern slices and differs from grid', () => {
    const b = mesh(box(100, 100, 0, 20, 20, 8));
    const grid = extrusionLen(parse(slice([b], cfgFor('bbl-p1s', { sparse_infill_pattern: 'grid', sparse_infill_density: 20 })).gcode).moves, 'sparse infill');
    for (const pat of ['line', 'cubic', 'tri-hexagon', 'honeycomb', '3dhoneycomb', 'adaptivecubic', 'supportcubic', 'lightning', 'hilbertcurve', 'archimedeanchords', 'octagramspiral', 'crosshatch']) {
      const len = extrusionLen(parse(slice([b], cfgFor('bbl-p1s', { sparse_infill_pattern: pat, sparse_infill_density: 20 })).gcode).moves, 'sparse infill');
      expect(len, pat).toBeGreaterThan(0);
      expect(Math.abs(len - grid), pat).toBeGreaterThan(1);
    }
  });

  it('lightning and adaptive cubic use less material than cubic', () => {
    const b = mesh(box(90, 90, 0, 40, 40, 20));
    const g = (pat: string) => slice([b], cfgFor('bbl-p1s', { sparse_infill_pattern: pat, sparse_infill_density: 20 })).stats.filamentGrams;
    const cubic = g('cubic');
    expect(g('lightning')).toBeLessThan(cubic * 0.9);
    expect(g('adaptivecubic')).toBeLessThan(cubic);
  });

  it('sparse infill anchors join lines along the wall (fewer separate lines)', () => {
    const b = mesh(box(100, 100, 0, 20, 20, 6));
    const runs = (a: string | number, m: string | number) => {
      const p = parse(slice([b], cfgFor('bbl-p1s', { sparse_infill_pattern: 'rectilinear', sparse_infill_anchor: a, sparse_infill_anchor_max: m })).gcode);
      let n = 0, prev = '';
      for (const mv of p.moves.filter((x) => x.layer === 12)) { if (mv.type === 'sparse infill' && prev !== 'sparse infill') n++; prev = mv.type; }
      return n;
    };
    expect(runs('400%', 20)).toBeLessThan(runs(0, 0));
  });

  it('infill combination prints sparse infill every other layer at double height', () => {
    const b = mesh(box(100, 100, 0, 20, 20, 8));
    const p = parse(slice([b], cfgFor('bbl-p1s', { infill_combination: true })).gcode);
    const sparseLayers = new Set(p.moves.filter((m) => m.type === 'sparse infill' && m.e > 0).map((m) => m.layer));
    const plain = new Set(parse(slice([b], cfgFor('bbl-p1s')).gcode).moves.filter((m) => m.type === 'sparse infill' && m.e > 0).map((m) => m.layer));
    expect(sparseLayers.size).toBeLessThan(plain.size * 0.7);
  });

  it('ensure vertical shell thickness adds solid infill on slopes', () => {
    const c = mesh(cone(100, 100, 18, 6, 15, 96));
    const solid = (v: string) => extrusionLen(parse(slice([c], cfgFor('bbl-p1s', { ensure_vertical_shell_thickness: v })).gcode).moves, 'internal solid infill');
    expect(solid('enabled')).toBeGreaterThan(solid('disabled') * 1.2);
  });

  it('bridge direction overrides the automatic angle', () => {
    const t = mesh(tee(100, 100));
    expect(slice([t], cfgFor('bbl-p1s', { bridge_angle: 30 })).gcode).not.toBe(slice([t], cfgFor('bbl-p1s')).gcode);
  });
});

describe('speed', () => {
  it('overhang walls slow down by overhang degree', () => {
    const t = mesh(tee(100, 100));
    const p = parse(slice([t], cfgFor('bbl-p1s', { overhang_totally_speed: 7, overhang_4_4_speed: 7, overhang_3_4_speed: 9 })).gcode);
    const over = p.moves.filter((m) => m.type === 'overhang wall' && m.e > 0);
    expect(over.length).toBeGreaterThan(0);
    expect(Math.max(...over.map((m) => m.f))).toBeLessThanOrEqual(9.001);
    const fast = parse(slice([t], cfgFor('bbl-p1s', { enable_overhang_speed: false })).gcode).moves.filter((m) => m.type === 'overhang wall' && m.e > 0);
    expect(Math.max(...fast.map((m) => m.f))).toBeGreaterThan(20);
  });

  it('small perimeters print slower', () => {
    const c = mesh(cylinder(100, 100, 3, 3, 48));
    const outerF = (o = {}) => Math.max(...parse(slice([c], cfgFor('bbl-p1s', { slow_down_layer_time: 0, ...o }), () => {}, {}).gcode).moves.filter((m) => m.layer === 8 && m.type === 'outer wall' && m.e > 0).map((m) => m.f));
    expect(outerF({ small_perimeter_threshold: 30, small_perimeter_speed: '20%' })).toBeLessThan(outerF() * 0.5);
  });

  it('slow down by height caps the speed above the start height', () => {
    const b = mesh(box(100, 100, 0, 20, 20, 6));
    const p = parse(slice([b], cfgFor('bbl-p1s', { enable_height_slowdown: true, slowdown_start_height: 2, slowdown_start_speed: 40, slowdown_end_height: 3, slowdown_end_speed: 40 })).gcode);
    expect(Math.max(...p.moves.filter((m) => m.layer > 20 && m.e > 0).map((m) => m.f))).toBeLessThanOrEqual(40.01);
    expect(Math.max(...p.moves.filter((m) => m.layer > 2 && m.layer < 8 && m.e > 0).map((m) => m.f))).toBeGreaterThan(40);
  });

  it('jerk and accel_to_decel commands per firmware', () => {
    const b = mesh(box(100, 100, 0, 10, 10, 2));
    expect(slice([b], cfgFor('generic-marlin', { default_jerk: 8, outer_wall_jerk: 5 })).gcode).toMatch(/^M205 X5 Y5/m);
    const k = slice([b], cfgFor('generic-klipper', { default_jerk: 8, accel_to_decel_enable: true, accel_to_decel_factor: 50 })).gcode;
    expect(k).toMatch(/^SET_VELOCITY_LIMIT SQUARE_CORNER_VELOCITY=/m);
    expect(k).toMatch(/^SET_VELOCITY_LIMIT ACCEL=\d+ ACCEL_TO_DECEL=\d+/m);
  });
});

describe('support', () => {
  const t = () => mesh(tee(100, 100));
  const sup = (o = {}) => parse(slice([t()], cfgFor('bbl-p1s', { enable_support: true, ...o })).gcode).moves;
  it('grid style makes more support than snug', () => {
    expect(extrusionLen(sup({ support_style: 'grid' }), 'support')).toBeGreaterThan(extrusionLen(sup({ support_style: 'snug' }), 'support'));
  });
  it('hollow base pattern prints only support walls', () => {
    expect(extrusionLen(sup({ support_base_pattern: 'hollow' }), 'support')).toBeLessThan(extrusionLen(sup(), 'support') * 0.7);
  });
  it('interface pattern and bottom interface layers', () => {
    expect(extrusionLen(sup({ support_interface_pattern: 'concentric' }), 'support interface')).not.toBeCloseTo(extrusionLen(sup(), 'support interface'), 0);
  });
  it('tree styles differ', () => {
    const slim = extrusionLen(sup({ support_type: 'tree_auto', support_style: 'tree_slim' }), 'support');
    const strong = extrusionLen(sup({ support_type: 'tree_auto', support_style: 'tree_strong' }), 'support');
    expect(strong).toBeGreaterThan(slim);
  });
  it('raft lifts the object onto raft layers', () => {
    const b = mesh(box(100, 100, 0, 20, 20, 3));
    const out = slice([b], cfgFor('bbl-p1s', { raft_layers: 3 }));
    const p = parse(out.gcode);
    expect(out.layers.length).toBe(15 + 3);
    expect(p.moves.filter((m) => m.layer >= 0 && m.layer < 3 && m.e > 0 && m.type !== 'retract').every((m) => m.type.startsWith('support'))).toBe(true);
    expect(p.moves.find((m) => m.type === 'outer wall' && m.e > 0)!.z).toBeGreaterThan(0.6);
  });
  it('support ironing irons the top interface', () => {
    expect(extrusionLen(sup({ enable_support_ironing: true }), 'ironing')).toBeGreaterThan(0);
  });
  it('critical regions only drops supports for overhangs attached to the part', () => {
    expect(extrusionLen(sup({ support_critical_regions_only: true }), 'support')).toBeLessThan(extrusionLen(sup(), 'support'));
  });
});

describe('others', () => {
  it('slicing mode: regular unions overlapping shells, even-odd cancels them', () => {
    const overlap = mesh(merge(box(100, 100, 0, 20, 20, 3), box(110, 100, 0, 20, 20, 3)));
    const area = (mode: string) => slice([overlap], cfgFor('bbl-p1s', { slicing_mode: mode })).stats.filamentMm;
    expect(area('regular')).toBeGreaterThan(area('even_odd') * 1.05);
  });

  it('print sequence by object prints each object to the top before the next', () => {
    const a = mesh(box(40, 40, 0, 10, 10, 3), 'a'), b = mesh(box(180, 180, 0, 10, 10, 2), 'b');
    const out = slice([a, b], cfgFor('bbl-p1s', { print_sequence: 'by_object' }));
    const z = out.layers.map((l) => l.z);
    expect(z.some((v, k) => k > 0 && v < z[k - 1] - 0.5)).toBe(true); // goes back down for the second object
    const close = slice([mesh(box(100, 100, 0, 10, 10, 3), 'a'), mesh(box(115, 100, 0, 10, 10, 3), 'b')], cfgFor('bbl-p1s', { print_sequence: 'by_object' }));
    expect(close.warnings.join(' ')).toMatch(/clearance radius/);
  });

  it('smooth spiral blends the loops', () => {
    const v = mesh(cone(100, 100, 15, 10, 20, 64));
    expect(slice([v], cfgFor('bbl-p1s', { spiral_mode: true, spiral_mode_smooth: true })).gcode).not.toBe(slice([v], cfgFor('bbl-p1s', { spiral_mode: true })).gcode);
  });

  it('fuzzy skin noise types and modes', () => {
    const c = mesh(cylinder(100, 100, 10, 3, 64));
    const g = (o = {}) => slice([c], cfgFor('bbl-p1s', { fuzzy_skin: 'external', ...o })).gcode;
    const classic = g();
    expect(g({ fuzzy_skin_noise_type: 'perlin' })).not.toBe(classic);
    expect(g({ fuzzy_skin_noise_type: 'voronoi' })).not.toBe(classic);
    const ext = parse(g({ fuzzy_skin_mode: 'extrusion' })).moves.filter((m) => m.layer === 6 && m.type === 'outer wall' && m.e > 0);
    const ePerMm = ext.map((m) => m.e / Math.max(1e-6, Math.hypot(m.x - m.x0, m.y - m.y0)));
    expect(Math.max(...ePerMm) / Math.min(...ePerMm)).toBeGreaterThan(1.2);
    expect(slice([c], cfgFor('bbl-p1s', { fuzzy_skin: 'external', fuzzy_skin_first_layer: true })).gcode).not.toBe(classic);
  });

  it('prime tower brim, ribs and fillet follow their settings', () => {
    const b = mesh(box(60, 60, 0, 20, 20, 3), 'a', { filament: 0 }), c = mesh(box(100, 60, 0, 20, 20, 3), 'b', { filament: 1 });
    const slots = filamentSlots([{ presetId: 'generic-pla', color: '#ffffff' }, { presetId: 'generic-pla', color: '#000000' }]);
    const tower = (o = {}) => slice([b, c], cfgFor('bbl-p1s', o), () => {}, { filaments: slots }).stats.towerGrams;
    expect(tower({ prime_tower_rib_wall: true })).not.toBeCloseTo(tower({ prime_tower_rib_wall: false }), 3);
  });

  it('flush into infill and objects reduces the purge', () => {
    const a = mesh(box(60, 60, 0, 20, 20, 4), 'a', { filament: 0 }), c = mesh(box(100, 60, 0, 20, 20, 4), 'b', { filament: 1 });
    const slots = filamentSlots([{ presetId: 'generic-pla', color: '#ffffff' }, { presetId: 'generic-pla', color: '#000000' }]);
    // Bambu Studio's X1 Carbon change G-code: the purge is in its FLUSH blocks
    const total = (g: string) => bambuFlushes(g).reduce((s, e) => s + e, 0);
    const flush = (o = {}) => total(slice([a, c], cfgFor('bbl-x1c', o), () => {}, { filaments: slots }).gcode);
    expect(flush({ flush_into_infill: true })).toBeLessThan(flush());
    const w = mesh(box(140, 60, 0, 15, 15, 4), 'waste', { overrides: { flush_into_objects: true } });
    const withWaste = total(slice([a, c, w], cfgFor('bbl-x1c'), () => {}, { filaments: slots }).gcode);
    expect(withWaste).toBeLessThan(flush());
  });

  it('feature filaments print walls with their own filament', () => {
    const b = mesh(box(100, 100, 0, 20, 20, 3));
    const slots = filamentSlots([{ presetId: 'generic-pla', color: '#ffffff' }, { presetId: 'generic-pla', color: '#000000' }]);
    const out = slice([b], cfgFor('bbl-p1s', { wall_filament: 2 }), () => {}, { filaments: slots });
    expect(out.stats.toolChanges).toBeGreaterThan(5);
  });

  it('brim ears only around sharp corners', () => {
    const b = mesh(box(100, 100, 0, 20, 20, 3));
    const brim = (t: string) => extrusionLen(parse(slice([b], cfgFor('bbl-p1s', { brim_type: t, brim_width: 5 })).gcode).moves, 'brim');
    expect(brim('brim_ears')).toBeGreaterThan(0);
    expect(brim('brim_ears')).toBeLessThan(brim('outer_only') * 0.8);
  });

  it('G-code output: line numbers, absolute E, exclude objects', () => {
    const b = mesh(box(100, 100, 0, 10, 10, 2));
    const n = slice([b], cfgFor('generic-marlin', { gcode_add_line_number: true })).gcode;
    expect(n.split('\n').filter((l) => l && !l.startsWith(';')).every((l) => /^N\d+ /.test(l))).toBe(true);
    const abs = slice([b], cfgFor('generic-marlin', {}, { use_relative_e_distances: false })).gcode;
    expect(abs).toMatch(/^M82/m);
    const es = [...abs.split(';LAYER_CHANGE')[3].matchAll(/^G1 X[\d.]+ Y[\d.]+ E([\d.]+)/gm)].map((m) => Number(m[1]));
    expect(es.every((e, k) => k === 0 || e >= es[k - 1])).toBe(true);
    expect(slice([b], cfgFor('generic-klipper', { exclude_object: false })).gcode).not.toContain('EXCLUDE_OBJECT_START');
  });

  it('height range modifiers change settings for their layers only', () => {
    const b = mesh(box(100, 100, 0, 20, 20, 8), 'b', { heightRanges: [{ z0: 3, z1: 5, overrides: { sparse_infill_density: 60 } }] });
    const p = parse(slice([b], cfgFor('bbl-p1s')).gcode);
    const at = (layer: number) => extrusionLen(p.moves.filter((m) => m.layer === layer), 'sparse infill');
    expect(at(19)).toBeGreaterThan(at(9) * 2);
    expect(at(30)).toBeCloseTo(at(9), -1);
  });

  it('positive parts are added to the object', () => {
    const extra = weld(box(115, 100, 0, 10, 10, 3));
    const b = mesh(box(100, 100, 0, 10, 10, 3), 'b', { parts: [{ type: 'part', vertices: extra.vertices, indices: extra.indices }] });
    expect(slice([b], cfgFor('bbl-p1s')).stats.filamentMm).toBeGreaterThan(slice([mesh(box(100, 100, 0, 10, 10, 3))], cfgFor('bbl-p1s')).stats.filamentMm * 1.6);
  });
});

describe('cooling, retraction and machine G-code', () => {
  it('fan speed follows layer time (cooling rules)', () => {
    const big = mesh(box(60, 60, 0, 80, 80, 1));
    const fil = { fan_min_speed: 30, fan_max_speed: 100, slow_down_layer_time: 4, fan_cooling_layer_time: 20, reduce_fan_stop_start_freq: false, close_fan_the_first_x_layers: 1 };
    const g = slice([big], cfgFor('bbl-p1s', {}, {}, fil)).gcode;
    // layers of a large flat part take longer than the threshold: the fan stays off without "keep fan always on"
    expect(g.split(';LAYER_CHANGE').slice(2).join('')).not.toMatch(/^M106 S2[0-9]{2}$/m);
    const small = slice([mesh(box(100, 100, 0, 5, 5, 3))], cfgFor('bbl-p1s', {}, {}, fil)).gcode;
    expect(small).toMatch(/^M106 S255/m);
    const kept = slice([big], cfgFor('bbl-p1s', {}, {}, { ...fil, reduce_fan_stop_start_freq: true })).gcode;
    expect(kept).toMatch(new RegExp(`^M106 S${Math.round(0.3 * 255)}$`, 'm'));
  });

  it('overhang fan boosts the fan on overhangs and bridges', () => {
    const t = mesh(tee(100, 100));
    const fil = { fan_min_speed: 20, fan_max_speed: 20, overhang_fan_speed: 90, enable_overhang_bridge_fan: true, overhang_fan_threshold: '25%' };
    expect(slice([t], cfgFor('bbl-p1s', {}, {}, fil)).gcode).toMatch(new RegExp(`^M106 S${Math.round(0.9 * 255)}`, 'm'));
  });

  it('Z hop types: spiral (G3), slope, normal; lift boundaries', () => {
    const two = [mesh(box(60, 60, 0, 10, 10, 2), 'a'), mesh(box(150, 150, 0, 10, 10, 2), 'b')];
    expect(slice(two, cfgFor('bbl-p1s', {}, { z_hop_types: 'spiral' })).gcode).toMatch(/^G3 Z[\d.]+ I[\d.]+ J0 P1/m);
    const slope = parse(slice(two, cfgFor('generic-marlin', {}, { z_hop_types: 'slope', z_hop: 0.4 })).gcode).moves;
    expect(slope.some((m) => m.type === 'travel' && m.z > m.layer * 0 && (m.x !== m.x0 || m.y !== m.y0) && m.line.includes('Z'))).toBe(true);
    const bounded = slice(two, cfgFor('generic-marlin', {}, { z_hop: 0.4, retract_lift_above: 50 })).gcode;
    expect(parse(bounded).moves.filter((m) => m.line.startsWith('G0')).every((m) => m.z <= 2.01)).toBe(true); // slicer travel, not the end G-code
  });

  it('wipe while retracting moves back along the last path', () => {
    const two = [mesh(box(60, 60, 0, 10, 10, 2), 'a'), mesh(box(150, 150, 0, 10, 10, 2), 'b')];
    const count = (w: boolean) => (slice(two, cfgFor('generic-marlin', {}, { wipe: w, wipe_distance: 2, retract_before_wipe: 50 })).gcode.match(/^G1 X[\d.]+ Y[\d.]+ E-/gm) ?? []).length;
    expect(count(true)).toBeGreaterThan(0);
    expect(count(false)).toBe(0);
  });

  it('timelapse, chamber, filament start / end and before-layer-change G-code', () => {
    const b = mesh(box(100, 100, 0, 10, 10, 2));
    expect(slice([b], cfgFor('bbl-x1c')).gcode.match(/^\s*M971 S11 C10 O0$/gm)!.length).toBeGreaterThan(5);
    const g = slice([b], cfgFor('generic-marlin', {}, { before_layer_change_gcode: '; BEFORE [layer_num]' }, { chamber_temperatures: 45, filament_start_gcode: '; FIL START', filament_end_gcode: '; FIL END' }), () => {}, {
      filaments: filamentSlots([{ presetId: 'generic-pla', color: '#fff', overrides: { filament_start_gcode: '; FIL START', filament_end_gcode: '; FIL END' } }]),
    }).gcode;
    expect(g).toMatch(/^M141 S45/m);
    expect(g).toContain('; FIL START');
    expect(g).toContain('; FIL END');
    expect(g).toContain('; BEFORE 3');
  });

  it('filament retraction overrides win over the printer', () => {
    const two = [mesh(box(60, 60, 0, 10, 10, 2), 'a'), mesh(box(150, 150, 0, 10, 10, 2), 'b')];
    const g = slice(two, cfgFor('generic-marlin', {}, {}, { filament_retraction_length: 3.3 })).gcode;
    expect(g).toMatch(/^G1 E-3.3 F/m);
  });
});

describe('preview data', () => {
  it('moveLines point at the G-code line of each move, moveAux carries fan and temperature', async () => {
    const { slice } = await import('../src/engine/slicer');
    const { weld } = await import('../src/engine/mesh');
    const { box } = await import('./fixtures');
    const { MOVE_STRIDE } = await import('../src/engine/gcode');
    const m = weld(box(100, 100, 0, 20, 20, 3));
    const cfg = cfgFor('bbl-p1s');
    const r = slice([{ name: 'box', vertices: m.vertices, indices: m.indices, filament: 0 } as any], cfg);
    const lines = r.gcode.split('\n');
    let checked = 0;
    for (let i = 1; i < r.moveFeatures.length; i += 97) {
      const t = lines[r.moveLines![i]];
      expect(t).toMatch(/^(N\d+ )?G[0123]/);
      const x = /X(-?[\d.]+)/.exec(t);
      if (x) { expect(+x[1]).toBeCloseTo(r.moves[i * MOVE_STRIDE], 1); checked++; }
    }
    expect(checked).toBeGreaterThan(5);
    const aux = r.moveAux!;
    let maxFan = 0, temp = 0;
    for (let i = 0; i < aux.length; i += 2) { maxFan = Math.max(maxFan, aux[i]); temp = Math.max(temp, aux[i + 1]); }
    expect(maxFan).toBeGreaterThan(0);
    expect(temp).toBeGreaterThan(180);
  });
});

describe('the last eleven settings', () => {
  const P = 'bbl-p1s';
  const sliceOne = (soup: Float32Array, ov = {}) => slice([mesh(soup)], cfgFor(P, ov));
  it('precise wall moves the first inner wall a full half-line further from the outer wall', async () => {
    const { islandWalls } = await import('../src/engine/walls');
    const { toExPolygons, SCALE } = await import('../src/engine/clipper');
    const sq = [[0, 0], [20, 0], [20, 20], [0, 20]].map(([x, y]) => ({ X: x * SCALE, Y: y * SCALE }));
    const ex = toExPolygons([sq])[0];
    const base = { walls: 2, wo: 0.42, wi: 0.45, so: 0.38, si: 0.41, nozzle: 0.4, arachne: false, minBead: 0.34, minFeature: 0.1, margin: 0.1, thinWalls: false, gapFill: false, topOneWall: null };
    const xmin = (w: ReturnType<typeof islandWalls>) => Math.min(...w.loops[1][0].pts.filter((_, k) => k % 2 === 0));
    expect(xmin(islandWalls(ex, { ...base, precise: true })) - xmin(islandWalls(ex, base))).toBeCloseTo((0.42 + 0.45) / 2 - (0.38 + 0.41) / 2, 3);
  });
  it('Arachne transition length blends centre-bead widths; a blunt wedge loses its centre-bead tip', async () => {
    const { islandWalls } = await import('../src/engine/walls');
    const { toExPolygons, SCALE } = await import('../src/engine/clipper');
    // a wedge from 0.2 to 1.4 mm wide over 30 mm
    const ex = toExPolygons([[[0, -0.1], [30, -0.7], [30, 0.7], [0, 0.1]].map(([x, y]) => ({ X: x * SCALE, Y: y * SCALE }))])[0];
    const p = { walls: 1, wo: 0.42, wi: 0.45, so: 0.38, si: 0.41, nozzle: 0.4, arachne: true, minBead: 0.34, minFeature: 0.1, margin: 0.1, thinWalls: false, gapFill: false, topOneWall: null };
    const sharp = islandWalls(ex, { ...p, transitionAngle: 59, transitionLength: 0 }).thin;
    const blunt = islandWalls(ex, { ...p, transitionAngle: 1, transitionLength: 0 }).thin;
    const len = (t: typeof sharp) => t.reduce((a, b) => a + b.pts.length, 0);
    expect(len(blunt)).toBeLessThan(len(sharp));
    const rough = islandWalls(ex, { ...p, transitionLength: 0 }).thin[0]?.widths ?? [];
    const smooth = islandWalls(ex, { ...p, transitionLength: 5 }).thin[0]?.widths ?? [];
    const jump = (w: number[]) => Math.max(0, ...w.slice(1).map((x, k) => Math.abs(x - w[k])));
    if (rough.length > 3) expect(jump(smooth)).toBeLessThanOrEqual(jump(rough) + 1e-9);
  });
  it('interface shells make the layer where two painted materials meet solid', () => {
    const m = mesh(box(100, 100, 0, 20, 20, 10), 'a');
    const color = new Uint8Array(12); color[2] = 2; color[3] = 2; // top face painted with filament 2
    m.paint = { color } as any;
    const slots = filamentSlots([{ presetId: 'generic-pla', color: '#ffffff' }, { presetId: 'generic-pla', color: '#000000' }]);
    const run = (on: boolean) => parse(slice([m], cfgFor(P, { interface_shells: on, mmu_segmented_region_max_width: 3, sparse_infill_density: 10 }), undefined, { filaments: slots }).gcode);
    const solid = (p: ReturnType<typeof parse>) => p.moves.filter((x) => x.z > 5.5 && x.z < 7.6 && x.type === 'internal solid infill').length;
    expect(solid(run(true))).toBeGreaterThan(solid(run(false)));
  });
  it('short travel acceleration applies to hops shorter than the retraction minimum travel', () => {
    const g = sliceOne(box(100, 100, 0, 20, 20, 2), { travel_short_distance_acceleration: 333 }).gcode;
    expect(g).toMatch(/M204 S333/);
  });
  it('max volumetric slopes ease speed changes between extrusions', () => {
    const fast = sliceOne(cylinder(120, 120, 10, 3), { max_volumetric_extrusion_rate_slope_positive: 5, max_volumetric_extrusion_rate_slope_negative: 5 });
    const free = sliceOne(cylinder(120, 120, 10, 3));
    expect(fast.stats.timeSeconds).toBeGreaterThan(free.stats.timeSeconds);
  });
  it('monotonic line travel extend approaches each line from inside the wall', () => {
    const a = sliceOne(box(100, 100, 0, 20, 20, 2), { monotonic_travel_into_wall: 100, top_surface_pattern: 'monotonic' });
    const b = sliceOne(box(100, 100, 0, 20, 20, 2), { top_surface_pattern: 'monotonic' });
    const travels = (o: typeof a) => parse(o.gcode).moves.filter((m) => m.type === 'travel').length;
    expect(travels(a)).toBeGreaterThan(travels(b));
  });
  it('independent support layer height prints the support base every second layer at double height', () => {
    const run = (on: boolean) => parse(slice([mesh(tee(120, 120))], cfgFor(P, { layer_height: 0.12, enable_support: true, support_type: 'normal_auto', independent_support_layer_height: on })).gcode);
    const layersWith = (p: ReturnType<typeof parse>) => new Set(p.moves.filter((m) => m.type === 'support' && m.e > 0 && m.z > 1 && m.z < 8).map((m) => m.layer)).size;
    expect(layersWith(run(true))).toBeLessThan(layersWith(run(false)) * 0.8);
  });
  it('filename format expands placeholders', async () => {
    const { formatFilename } = await import('../src/state/printjob');
    expect(formatFilename('[input_filename_base]_[layer_height]mm_[filament_type]_[print_time].gcode', { base: 'cube', plate: 'Plate 1', cfg: { layer_height: 0.2, filament_type: 'PLA' }, seconds: 3725, grams: 1 }, 'gcode')).toBe('cube_0.2mm_PLA_1h2m.gcode');
  }, 20_000); // the first dynamic import can take over 5 s while the whole suite runs
});
