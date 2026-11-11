// OrcaSlicer / Bambu Studio / Snapmaker Orca option parity: options added for parity change the G-code the way
// those slicers describe them.
import { describe, expect, it } from 'vitest';
import { weld } from '../src/engine/mesh';
import { shiftLoopStart, shrinkCompensate, slice, solidLayerRule } from '../src/engine/slicer';
import { layerFanSpeed, preheatParkedHeads, type LayerOps } from '../src/engine/gcode';
import { filamentSlots, resolveConfig } from '../src/profiles/resolve';
import type { MeshInput } from '../src/engine/types';
import { box, cylinder, tee } from './fixtures';

const cfgFor = (printerId: string, overrides = {}, machine = {}, fil = {}) =>
  resolveConfig({ printerId, plate: 'textured_pei_plate', filamentId: 'generic-pla', presetId: '0.20', overrides, machineOverrides: machine, filamentOverrides: fil });
const mesh = (soup: Float32Array, name = 'part', extra: Partial<MeshInput> = {}): MeshInput => ({ id: name, name, ...weld(soup), ...extra });

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
const two = () => [mesh(box(60, 60, 0, 10, 10, 2), 'a'), mesh(box(150, 150, 0, 10, 10, 2), 'b')];

describe('speed, acceleration and jerk', () => {
  const b = () => mesh(box(100, 100, 0, 20, 20, 3));
  it('skirt speed overrides the first layer speed for the skirt', () => {
    const ms = parse(slice([b()], cfgFor('bbl-p1s', { skirt_loops: 1, skirt_speed: 17 })).gcode);
    expect(ext(ms, 'skirt').every((m) => Math.abs(m.f - 17) < 0.01)).toBe(true);
  });
  it('number of slow layers ramps the wall speed up after the first layer', () => {
    const tall = mesh(box(100, 100, 0, 20, 20, 6));
    const wallF = (n: number, L: number) => Math.max(...ext(parse(slice([tall], cfgFor('bbl-p1s', { slow_down_layers: n })).gcode), 'inner wall', L).map((m) => m.f));
    expect(wallF(4, 1)).toBeLessThan(wallF(0, 1));
    expect(wallF(4, 2)).toBeGreaterThan(wallF(4, 1));
    expect(wallF(4, 6)).toBeCloseTo(wallF(0, 6), 3);
  });
  it('bridge and internal solid infill accelerations are written before those lines', () => {
    const g = slice([mesh(tee(100, 100))], cfgFor('generic-marlin', { bridge_acceleration: 345, internal_solid_infill_acceleration: 456 })).gcode;
    expect(g).toMatch(/M204 S345\n;TYPE:bridge/);
    expect(g).toMatch(/M204 S456\n;TYPE:internal solid infill/);
    const pct = slice([mesh(tee(100, 100))], cfgFor('generic-marlin', { bridge_acceleration: '50%', outer_wall_acceleration: 700 })).gcode;
    expect(pct).toMatch(/M204 S350\n;TYPE:bridge/);
  });
  it('first layer travel speed and Z travel speed', () => {
    const ms = parse(slice(two(), cfgFor('generic-marlin', { initial_layer_travel_speed: 42, travel_speed_z: 3 }, { z_hop: 0.4, z_hop_types: 'normal' })).gcode);
    expect(ms.filter((m) => m.layer === 0 && m.type === 'travel' && m.z === m.z0).some((m) => Math.abs(m.f - 42) < 0.01)).toBe(true);
    expect(ms.filter((m) => m.line.startsWith('G0 Z') && m.z > m.z0).every((m) => Math.abs(m.f - 3) < 0.01)).toBe(true);
  });
  it('first layer travel jerk', () => {
    const g = slice(two(), cfgFor('generic-marlin', { default_jerk: 10, travel_jerk: 12, initial_layer_travel_jerk: '50%' })).gcode;
    expect(g).toContain('M205 X6 Y6');
  });
});

describe('flow ratios', () => {
  const b = () => mesh(box(100, 100, 0, 20, 20, 3));
  it('per line type flow ratios apply only with "Set other flow ratios" on', () => {
    const wallE = (o: object) => eSum(ext(parse(slice([b()], cfgFor('bbl-p1s', o)).gcode), 'outer wall', 5));
    const base = wallE({});
    expect(wallE({ outer_wall_flow_ratio: 0.5 })).toBeCloseTo(base, 5);
    expect(wallE({ set_other_flow_ratios: true, outer_wall_flow_ratio: 0.5 }) / base).toBeCloseTo(0.5, 2);
    const fillE = (o: object) => eSum(ext(parse(slice([b()], cfgFor('bbl-p1s', o)).gcode), 'sparse infill'));
    expect(fillE({ set_other_flow_ratios: true, sparse_infill_flow_ratio: 1.2 }) / fillE({})).toBeCloseTo(1.2, 2);
  });
  it('bottom surface and brim flow ratios', () => {
    const bot = (o: object) => eSum(ext(parse(slice([b()], cfgFor('bbl-p1s', o)).gcode), 'bottom surface'));
    expect(bot({ bottom_solid_infill_flow_ratio: 0.8 }) / bot({})).toBeCloseTo(0.8, 2);
    const brim = (o: object) => eSum(ext(parse(slice([b()], cfgFor('bbl-p1s', { brim_type: 'outer_only', brim_width: 3, ...o })).gcode), 'brim'));
    expect(brim({ brim_flow_ratio: 1.5 }) / brim({})).toBeCloseTo(1.5, 2);
  });
});

describe('retraction, wipe and Z hop', () => {
  it('Z hop on surfaces: top only skips hops that do not end over a top surface', () => {
    const hops = (enforce: string) => parse(slice(two(), cfgFor('generic-marlin', {}, { z_hop: 0.4, z_hop_types: 'normal', retract_lift_enforce: enforce })).gcode)
      .filter((m) => m.type === 'travel' && m.z > m.z0 + 0.3 && m.layer > 0 && m.layer < 9).length;
    expect(hops('all')).toBeGreaterThan(0);
    expect(hops('top')).toBeLessThan(hops('all'));
    expect(hops('bottom')).toBe(0);
  });
  it('traveling angle sets the climb of a slope hop', () => {
    const climb = (deg: number) => {
      const ms = parse(slice(two(), cfgFor('generic-marlin', {}, { z_hop: 0.4, z_hop_types: 'slope', travel_slope: deg })).gcode);
      const m = ms.find((q) => q.layer > 0 && q.type === 'travel' && q.z > q.z0 + 0.3 && (q.x !== q.x0 || q.y !== q.y0))!;
      return Math.hypot(m.x - m.x0, m.y - m.y0);
    };
    expect(climb(10)).toBeCloseTo(0.4 / Math.tan((10 * Math.PI) / 180), 1);
    expect(climb(45)).toBeLessThan(climb(10));
  });
  it('retract amount after wipe is retracted after the wipe move', () => {
    const g = slice(two(), cfgFor('generic-marlin', {}, { wipe: true, wipe_distance: 2, retract_before_wipe: 20, retract_after_wipe: 30, retraction_length: 1 })).gcode;
    expect(g).toMatch(/G1 E-0\.2 F[\d.]+\n(?:G1 X[\d.]+ Y[\d.]+ E-[^\n]*\n)+G1 E-0\.3 F/);
  });
  it('role based wipe speed wipes at the speed of the last line', () => {
    const wipeF = (on: boolean) => parse(slice(two(), cfgFor('generic-marlin', { role_based_wipe_speed: on, travel_speed: 300, wipe_speed: 80 }, { wipe: true, wipe_distance: 2, retract_before_wipe: 0 })).gcode)
      .filter((m) => m.layer > 0 && m.line.includes(' E-') && m.line.includes('X'))[0].f;
    expect(wipeF(false)).toBeCloseTo(240, 3);
    expect(wipeF(true)).toBeLessThan(240);
  });
  it('firmware retraction writes G10 / G11', () => {
    const g = slice(two(), cfgFor('generic-marlin', {}, { use_firmware_retraction: true, wipe: true })).gcode;
    expect(g).toMatch(/^G10$/m);
    expect(g).toMatch(/^G11$/m);
    expect(g.slice(g.indexOf(';LAYER_CHANGE'), g.lastIndexOf(';TYPE:'))).not.toMatch(/^G1 E-/m);
  });
});

describe('G-code output and machine settings', () => {
  const b = () => mesh(box(100, 100, 0, 10, 10, 2));
  it('Z offset shifts every Z', () => {
    const zs = (off: number) => parse(slice([b()], cfgFor('generic-marlin', {}, { z_offset: off })).gcode).filter((m) => m.type === 'outer wall').map((m) => m.z);
    expect(Math.min(...zs(-0.1))).toBeCloseTo(Math.min(...zs(0)) - 0.1, 5);
  });
  it('disable M73 and verbose G-code', () => {
    expect(slice([b()], cfgFor('generic-marlin')).gcode).toMatch(/^M73 P/m);
    expect(slice([b()], cfgFor('generic-marlin', {}, { disable_m73: true })).gcode).not.toMatch(/^M73 P\d+ R/m);
    expect(slice(two(), cfgFor('generic-marlin', { gcode_comments: true })).gcode).toMatch(/^G1 E-[\d.]+ F\d+ ; retract$/m);
  });
  it('machine limits are written for Marlin, not for Klipper', () => {
    const lim = { machine_max_acceleration_x: 3000, machine_max_acceleration_y: 3000, machine_max_speed_x: 250, machine_max_acceleration_extruding: 2500, machine_max_jerk_x: 8, machine_min_extruding_rate: 1 };
    const g = slice([b()], cfgFor('generic-marlin', {}, lim)).gcode;
    expect(g).toContain('M201 X3000 Y3000');
    expect(g).toContain('M203 X250');
    expect(g).toContain('M204 P2500');
    expect(g).toContain('M205 X8');
    expect(g).toContain('M205 S1');
    expect(slice([b()], cfgFor('generic-marlin', {}, { ...lim, emit_machine_limits_to_gcode: false })).gcode).not.toContain('M201 X3000');
    expect(slice([b()], cfgFor('generic-klipper', {}, lim)).gcode).not.toContain('M201 X3000');
  });
  it('change extrusion role G-code follows every line type change', () => {
    const g = slice([b()], cfgFor('generic-marlin', {}, { change_extrusion_role_gcode: '; ROLE [extrusion_role] after [last_extrusion_role]' })).gcode;
    expect(g).toMatch(/;TYPE:inner wall\n; ROLE inner wall after /);
    expect(g).toContain('; ROLE outer wall after inner wall');
  });
  it('fan kick-start runs the fan flat out before a lower speed', () => {
    const g = slice([mesh(box(100, 100, 0, 10, 10, 3))], cfgFor('generic-marlin', {}, { fan_kickstart: 0.5 }, { fan_max_speed: 60, fan_min_speed: 60, reduce_fan_stop_start_freq: true })).gcode;
    expect(g).toMatch(/M106 S255\nG4 P500\nM106 S153/);
  });
  it('chamber temperature needs "Activate temperature control"', () => {
    expect(slice([b()], cfgFor('generic-marlin', {}, {}, { chamber_temperatures: 45 })).gcode).toMatch(/^M141 S45/m);
    expect(slice([b()], cfgFor('generic-marlin', {}, {}, { chamber_temperatures: 45, activate_chamber_temp_control: false })).gcode).not.toMatch(/^M141/m);
  });
});

describe('cooling', () => {
  it('first layer fan speed overrides the other rules on layer 0 only', () => {
    const c = (k: string) => ({ close_fan_the_first_x_layers: 1, first_x_layer_part_fan_speed: 0, fan_min_speed: 50, fan_max_speed: 100, slow_down_layer_time: 4, fan_cooling_layer_time: 60 } as Record<string, number>)[k] ?? 0;
    expect(layerFanSpeed(c, () => false, 0, 10)).toBe(0);
    expect(layerFanSpeed(c, () => false, 0, 10, 20)).toBe(20);
    expect(layerFanSpeed(c, () => false, 3, 10, 20)).toBe(layerFanSpeed(c, () => false, 3, 10));
  });
  it('support interface fan speed is set for interfaces only', () => {
    const g = slice([mesh(tee(100, 100))], cfgFor('bbl-p1s', { enable_support: true, support_type: 'normal_auto' }, {}, { support_material_interface_fan_speed: 37 })).gcode;
    const i = g.indexOf(';TYPE:support interface');
    expect(i).toBeGreaterThan(0);
    expect(g.slice(i - 120, i + 400)).toContain(`M106 S${Math.round(0.37 * 255)}`);
  });
  it('idle temperature replaces the standby variation for a parked head', () => {
    const L: LayerOps[] = [{ z: 0.2, h: 0.2, fan: 0, ops: [{ k: 'tool', tool: 0 }, { k: 'move', x: 0, y: 0, z: 0.2, e: 0, f: 100, feature: 'travel', w: 0, h: 0.2, travel: true, t: 5 }, { k: 'tool', tool: 1 }] }];
    const fils = filamentSlots([{ presetId: 'generic-pla', color: '#fff' }, { presetId: 'generic-pla', color: '#f00', overrides: { idle_temperature: 155 } }]);
    preheatParkedHeads(L, 0, fils, { standbyDelta: -40, ooze: true });
    expect(L[0].ops.some((op) => op.k === 'raw' && /M104 T1 S155/.test(op.text))).toBe(true);
  });
});

describe('walls and seams', () => {
  const area2 = (ms: GMove[]) => { let a = 0; for (const m of ms) a += m.x0 * m.y - m.x * m.y0; return a; };
  it('wall loop direction', () => {
    const b = mesh(box(100, 100, 0, 20, 20, 3));
    const outer = (dir: string) => ext(parse(slice([b], cfgFor('bbl-p1s', { wall_direction: dir })).gcode), 'outer wall', 5);
    expect(area2(outer('ccw'))).toBeGreaterThan(0);
    expect(area2(outer('cw'))).toBeLessThan(0);
  });
  it('staggered inner seams move the inner seam back along the loop', () => {
    const sq = [0, 0, 10, 0, 10, 10, 0, 10];
    expect(shiftLoopStart(sq, 2).slice(0, 2)).toEqual([0, 2]);
    expect(shiftLoopStart(sq, 12).slice(0, 4)).toEqual([2, 10, 0, 0].slice(0, 2).concat([0, 10]));
    const c = mesh(cylinder(100, 100, 10, 3, 64));
    const starts = (on: boolean) => {
      const ms = parse(slice([c], cfgFor('bbl-p1s', { staggered_inner_seams: on, wall_loops: 3, seam_position: 'back' })).gcode).filter((m) => m.layer === 5);
      return ms.filter((m, k) => m.type === 'inner wall' && m.e > 0 && ms[k - 1]?.type !== 'inner wall').map((m) => [m.x0, m.y0]);
    };
    expect(starts(true)).not.toEqual(starts(false));
  });
  it('wipe on loops steps inward after the outer wall', () => {
    const b = mesh(box(100, 100, 0, 20, 20, 3));
    const ms = parse(slice([b], cfgFor('bbl-p1s', { wipe_on_loops: true, wall_sequence: 'inner_outer' })).gcode);
    const k = ms.findIndex((m, j) => m.layer === 5 && m.type === 'outer wall' && ms[j + 1]?.type !== 'outer wall');
    const w = ms[k + 1];
    expect(w.type).toBe('travel');
    expect(w.x).toBeGreaterThan(100.2); expect(w.x).toBeLessThan(119.8);
    expect(w.y).toBeGreaterThan(100.2); expect(w.y).toBeLessThan(119.8);
  });
  it('wipe before external loop primes inside the part', () => {
    const g = slice(two(), cfgFor('bbl-p1s', { wipe_before_external_loop: true, wall_sequence: 'outer_inner' })).gcode;
    const plain = slice(two(), cfgFor('bbl-p1s', { wall_sequence: 'outer_inner' })).gcode;
    const primeThenMove = (s: string) => (s.match(/\nG1 E[\d.]+ F\d+\n(?:M204 S\d+\n)?G0 [XY][^\n]*\n(?:M204 S\d+\n)?;TYPE:outer wall/g) ?? []).length;
    expect(primeThenMove(g)).toBeGreaterThan(primeThenMove(plain));
  });
  it('elephant foot compensation over several layers', () => {
    const b = mesh(box(100, 100, 0, 20, 20, 3));
    const xmax = (n: number, L: number) => Math.max(...ext(parse(slice([b], cfgFor('generic-marlin', { elefant_foot_compensation: 0.4, elefant_foot_compensation_layers: n, detect_overhang_wall: false })).gcode), 'outer wall', L).map((m) => m.x));
    expect(xmax(3, 0)).toBeCloseTo(xmax(1, 0), 3);
    expect(xmax(1, 1) - xmax(3, 1)).toBeCloseTo(0.4 * (2 / 3), 2);
    expect(xmax(1, 2) - xmax(3, 2)).toBeCloseTo(0.4 / 3, 2);
    expect(xmax(3, 3)).toBeCloseTo(xmax(1, 3), 3);
  });
});

describe('infill, gaps and bridges', () => {
  it('insert solid layers', () => {
    const r = solidLayerRule('5');
    expect([1, 4, 5, 9, 10].map(r)).toEqual([false, false, true, false, true]);
    const r2 = solidLayerRule('5#2');
    expect([3, 4, 5, 6, 9, 10].map(r2)).toEqual([false, true, true, false, true, true]);
    expect([1, 7, 8].map(solidLayerRule('1,7'))).toEqual([true, true, false]);
    const b = mesh(box(100, 100, 0, 20, 20, 6));
    const sparseOn = (rule: string, L: number) => ext(parse(slice([b], cfgFor('bbl-p1s', { extra_solid_infills: rule })).gcode), 'sparse infill', L).length;
    expect(sparseOn('', 12)).toBeGreaterThan(0);
    expect(sparseOn('13', 12)).toBe(0);
    expect(sparseOn('13', 11)).toBeGreaterThan(0);
  });
  it('apply gap fill: nowhere drops gap fill', () => {
    const thin = mesh(box(100, 100, 0, 1, 20, 2));
    const gaps = (t: string) => ext(parse(slice([thin], cfgFor('generic-marlin', { gap_fill_target: t, wall_loops: 2, wall_generator: 'classic' })).gcode), 'gap infill').length;
    expect(gaps('everywhere')).toBeGreaterThan(0);
    expect(gaps('nowhere')).toBe(0);
  });
  it('external bridge density spaces bridge lines', () => {
    const lines = (d: number) => ext(parse(slice([mesh(tee(100, 100))], cfgFor('bbl-p1s', { bridge_density: d })).gcode), 'bridge').length;
    expect(lines(50)).toBeLessThan(lines(100));
  });
});

describe('skirt and draft shield', () => {
  const b = () => mesh(box(100, 100, 0, 10, 10, 3));
  it('per object skirt draws one skirt around each object', () => {
    const near = [mesh(box(60, 60, 0, 10, 10, 2), 'a'), mesh(box(73, 60, 0, 10, 10, 2), 'b')];
    const loops = (type: string) => ext(parse(slice(near, cfgFor('bbl-p1s', { skirt_loops: 1, skirt_type: type })).gcode), 'skirt', 0);
    const span = (ms: GMove[]) => Math.max(...ms.map((m) => m.x)) - Math.min(...ms.map((m) => m.x));
    expect(span(loops('combined'))).toBeGreaterThan(20);
    // the combined skirt merges the two outlines into one loop; per object, each gets a full loop of its own
    expect(eSum(loops('perobject'))).toBeGreaterThan(eSum(loops('combined')) * 1.2);
  });
  it('skirt minimum extrusion length adds loops', () => {
    const e = (min: number) => eSum(ext(parse(slice([b()], cfgFor('bbl-p1s', { skirt_loops: 1, min_skirt_length: min })).gcode), 'skirt'));
    expect(e(0)).toBeLessThan(30);
    expect(e(30)).toBeGreaterThanOrEqual(30);
  });
  it('draft shield raises the skirt to the object height; single loop above the first layer', () => {
    const top = (o: object) => Math.max(...ext(parse(slice([b()], cfgFor('bbl-p1s', { skirt_loops: 2, ...o })).gcode), 'skirt').map((m) => m.layer));
    expect(top({})).toBe(0);
    expect(top({ draft_shield: 'enabled' })).toBeGreaterThan(10);
    const perLayer = (o: object, L: number) => eSum(ext(parse(slice([b()], cfgFor('bbl-p1s', { skirt_loops: 2, draft_shield: 'enabled', ...o })).gcode), 'skirt', L));
    expect(perLayer({ single_loop_draft_shield: true }, 5)).toBeLessThan(perLayer({}, 5) * 0.7);
  });
  it('skirt start point follows the start angle', () => {
    const first = (deg: number) => ext(parse(slice([b()], cfgFor('bbl-p1s', { skirt_loops: 1, skirt_start_angle: deg })).gcode), 'skirt', 0)[0];
    expect(first(0).x0).toBeGreaterThan(110);
    expect(first(180).x0).toBeLessThan(100);
  });
});

describe('filament shrinkage', () => {
  it('scales the model up in XY and Z', () => {
    const m = mesh(box(100, 100, 0, 20, 20, 10));
    const [s] = shrinkCompensate([m], () => ({ filament_shrink: 80, filament_shrinkage_compensation_z: 50 }), {});
    let x1 = -Infinity, z1 = -Infinity;
    for (let k = 0; k < s.vertices.length; k += 3) { x1 = Math.max(x1, s.vertices[k]); z1 = Math.max(z1, s.vertices[k + 2]); }
    expect(x1).toBeCloseTo(110 + 12.5, 3);
    expect(z1).toBeCloseTo(20, 3);
    expect(shrinkCompensate([m], () => ({}), {})[0]).toBe(m);
    const layers = (pct: number) => slice([m], cfgFor('bbl-p1s', {}, {}, { filament_shrinkage_compensation_z: pct })).stats.layerCount;
    expect(layers(50)).toBeGreaterThan(layers(100) * 1.8);
  });
});
