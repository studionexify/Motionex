// OrcaSlicer / Bambu Studio parity: prime tower, single-nozzle filament change sequence (MMU ramming, cooling, parking,
// loading), tool changer ramming and the machine / filament options added with them change the G-code the way those
// slicers describe them.
import { describe, expect, it } from 'vitest';
import { weld } from '../src/engine/mesh';
import { slice, slotFromConfig } from '../src/engine/slicer';
import { bedTemps, resolveConfig } from '../src/profiles/resolve';
import { printerById } from '../src/profiles/printers';
import { filamentConfig } from '../src/profiles/filamentParams';
import { filamentById } from '../src/profiles/filaments';
import { combinedTowerHeights, loadUnloadFlush, parseRamming, towerBandsPerLayer } from '../src/engine/wipeTower';
import { paModel, pchip } from '../src/engine/adaptivePA';
import type { Config } from '../src/profiles/settings';
import type { FilamentSlot, MeshInput } from '../src/engine/types';
import { box, tee } from './fixtures';

const cfgFor = (printerId: string, o: Config = {}, machine: Config = {}, fil: Config = {}, plate = 'textured_pei_plate') =>
  resolveConfig({ printerId, plate: plate as never, filamentId: 'generic-pla', presetId: '0.20', overrides: o, machineOverrides: machine, filamentOverrides: fil });
const mesh = (soup: Float32Array, name: string, filament = 0): MeshInput => ({ id: name, name, ...weld(soup), filament });

interface GMove { layer: number; type: string; tool: number; x0: number; y0: number; x: number; y: number; z: number; e: number; f: number; line: string; idx: number }
function parse(gcode: string) {
  const moves: GMove[] = [];
  const layerZ: number[] = [];
  let layer = -1, type = '', tool = 0, x = 0, y = 0, z = 0, f = 0, idx = 0;
  for (const line of gcode.split('\n')) {
    idx++;
    if (line.startsWith(';LAYER_CHANGE')) { layer++; continue; }
    if (line.startsWith(';Z:')) { layerZ[layer] = Number(line.slice(3)); continue; }
    if (line.startsWith(';TYPE:')) { type = line.slice(6); continue; }
    const t = /^T(\d+)/.exec(line);
    if (t) { tool = Number(t[1]); continue; }
    if (!/^G[0-3] /.test(line)) continue;
    const g = (k: string) => { const m = new RegExp(`${k}(-?[\\d.]+)`).exec(line.split(';')[0]); return m ? Number(m[1]) : undefined; };
    const nx = g('X') ?? x, ny = g('Y') ?? y, nz = g('Z') ?? z, e = g('E') ?? 0;
    if (g('F') !== undefined) f = g('F')! / 60;
    const kind = g('X') === undefined && g('Y') === undefined && g('Z') === undefined ? 'retract' : line.startsWith('G0') || e <= 0 ? 'travel' : type;
    moves.push({ layer, type: kind, tool, x0: x, y0: y, x: nx, y: ny, z: nz, e, f, line, idx });
    x = nx; y = ny; z = nz;
  }
  return { moves, layerZ };
}
const tower = (ms: GMove[], layer?: number) => ms.filter((m) => m.type === 'prime tower' && m.e > 0 && (layer === undefined || m.layer === layer));
const bbox = (ms: GMove[]) => {
  const xs = ms.map((m) => m.x), ys = ms.map((m) => m.y);
  return { w: Math.max(...xs) - Math.min(...xs), d: Math.max(...ys) - Math.min(...ys), cx: (Math.max(...xs) + Math.min(...xs)) / 2, cy: (Math.max(...ys) + Math.min(...ys)) / 2 };
};
const eSum = (ms: GMove[]) => ms.reduce((a, m) => a + m.e, 0);

/** Filament slots from a config, with their own settings and colours. */
const slots = (c: Config, settings: Config[]): FilamentSlot[] => settings.map((s, k) => ({ ...slotFromConfig(c), name: `F${k + 1}`, color: ['#ffffff', '#cc2222', '#2244cc'][k], settings: { ...c, ...s } }));
/** Boxes side by side, one filament each, `heights` mm tall (from z0). */
function run(printerId: string, o: { proc?: Config; machine?: Config; fils?: Config[]; heights?: number[]; z0?: number[]; meshes?: MeshInput[] } = {}) {
  const c = cfgFor(printerId, { enable_prime_tower: true, ...o.proc }, o.machine ?? {});
  const fils = o.fils ?? [{}, {}];
  const heights = o.heights ?? fils.map(() => 3);
  const meshes = o.meshes ?? fils.map((_, k) => mesh(box(60 + k * 22, 60, o.z0?.[k] ?? 0, 12, 12, heights[k] - (o.z0?.[k] ?? 0)), `b${k}`, k));
  return slice(meshes, c, () => {}, { filaments: slots(c, fils) });
}
const MMU = 'generic-klipper-mmu';
const RAM = { enable_filament_ramming: true };

describe('prime tower geometry', () => {
  it('rotation angle turns the tower about its centre', () => {
    const plain = bbox(tower(parse(run(MMU, { proc: { prime_tower_rib_wall: false } }).gcode).moves, 2));
    const rot = bbox(tower(parse(run(MMU, { proc: { prime_tower_rib_wall: false, wipe_tower_rotation_angle: 90 } }).gcode).moves, 2));
    expect(rot.w).toBeCloseTo(plain.d, 0);
    expect(rot.d).toBeCloseTo(plain.w, 0);
    expect(rot.cx).toBeCloseTo(plain.cx, 0);
  });
  it('wall type: rectangle drops the ribs, cone widens the bottom by the apex angle', () => {
    const rib = bbox(tower(parse(run(MMU, { proc: { prime_tower_rib_wall: true, prime_tower_rib_width: 8, prime_tower_extra_rib_length: 5 } }).gcode).moves, 2));
    const rect = bbox(tower(parse(run(MMU, { proc: { prime_tower_rib_wall: true, prime_tower_rib_width: 8, prime_tower_extra_rib_length: 5, wipe_tower_wall_type: 'rectangle' } }).gcode).moves, 2));
    expect(Math.abs(rib.w - rect.w) + Math.abs(rib.d - rect.d)).toBeGreaterThan(0.5);
    const cone = (a: number) => parse(run(MMU, { proc: { wipe_tower_wall_type: 'cone', wipe_tower_cone_angle: a, flush_volume: 0, prime_volume: 10 }, fils: [{ filament_minimal_purge_on_wipe_tower: 0 }, { filament_minimal_purge_on_wipe_tower: 0 }], heights: [16, 16] }).gcode).moves;
    const c30 = cone(60), c60 = cone(90);
    expect(bbox(tower(c30, 1)).d).toBeGreaterThan(bbox(tower(c30, 75)).d + 0.5);
    expect(bbox(tower(c60, 1)).d).toBeGreaterThan(bbox(tower(c30, 1)).d + 0.5);
  });
  it('extra flow thickens the purge lines, extra spacing makes the tower deeper', () => {
    const lines = (o: Config) => {
      const ms = tower(parse(run(MMU, { proc: { wipe_tower_wall_type: 'rectangle', ...o } }).gcode).moves, 3);
      return Math.max(...ms.map((m) => m.e / Math.hypot(m.x - m.x0, m.y - m.y0)));
    };
    expect(lines({ wipe_tower_extra_flow: 200 }) / lines({})).toBeGreaterThan(1.7);
    const depth = (o: Config) => bbox(tower(parse(run(MMU, { proc: { wipe_tower_wall_type: 'rectangle', ...o } }).gcode).moves, 3)).d;
    expect(depth({ wipe_tower_extra_spacing: 200 })).toBeGreaterThan(depth({}) * 1.6);
  });
  it('bridging distance caps the spacing of sparse tower layers', () => {
    // filament 2 starts at 2 mm: the tower layers below have no change and are sparse
    const sparse = (o: Config) => eSum(tower(parse(run(MMU, { proc: { wipe_tower_wall_type: 'rectangle', ...o }, heights: [4, 4], z0: [0, 2] }).gcode).moves, 4));
    expect(sparse({ wipe_tower_bridging: 1.5 })).toBeGreaterThan(sparse({}) * 1.5);
  });
  it('maximum purge speed caps the purge lines only', () => {
    const ms = tower(parse(run(MMU, { proc: { wipe_tower_max_purge_speed: 20 } }).gcode).moves, 3);
    expect(Math.min(...ms.map((m) => m.f))).toBeCloseTo(20, 3);
    expect(Math.max(...ms.map((m) => m.f))).toBeGreaterThan(25);
    const plain = tower(parse(run(MMU).gcode).moves, 3);
    expect(Math.min(...plain.map((m) => m.f))).toBeGreaterThan(25);
  });
  it('no sparse layers: no tower on layers without a change, the nozzle goes down to the tower top', () => {
    const p = parse(run(MMU, { proc: { wipe_tower_no_sparse_layers: true }, heights: [6, 6], z0: [0, 3] }).gcode);
    expect(tower(p.moves, 5)).toHaveLength(0);
    const L = p.moves.find((m) => m.type === 'prime tower' && m.layer > 1)!.layer;
    expect(tower(p.moves, L).every((m) => m.z < p.layerZ[L] - 0.1)).toBe(true);
    const on = parse(run(MMU, { heights: [6, 6], z0: [0, 3] }).gcode);
    expect(tower(on.moves, 5).length).toBeGreaterThan(0);
  });
  it('combine sparse layers: one thicker tower layer per run of layers without a change', () => {
    const o = { layer_height: 0.1, initial_layer_print_height: 0.2 };
    const layersWithTower = (extra: Config) => {
      const p = parse(run(MMU, { proc: { ...o, ...extra }, machine: { max_layer_height: 0.3 }, heights: [4, 4], z0: [0, 2] }).gcode);
      return new Set(tower(p.moves).filter((m) => m.layer < 15).map((m) => m.layer)).size;
    };
    expect(layersWithTower({ wipe_tower_sparse_layers_combination: true })).toBeLessThan(layersWithTower({}) * 0.6);
    combinedTowerHeights([0.2, 0.1, 0.1, 0.1, 0.1, 0.1], [0, 0, 0, 0, 0, 1], 5, 0.3).forEach((v, k) => expect(v).toBeCloseTo([0.2, 0, 0, 0.3, 0.1, 0.1][k], 6));
  });
  it('internal ribs off: each layer only as deep as the bands above still need', () => {
    const three = (fw: boolean) => parse(run(MMU, { proc: { prime_tower_enable_framework: fw, wipe_tower_wall_type: 'rectangle' }, fils: [{}, {}, {}], heights: [4, 4, 2] }).gcode).moves;
    const off = three(false), on = three(true);
    expect(bbox(tower(off, 15)).d).toBeLessThan(bbox(tower(off, 3)).d - 2);
    expect(bbox(tower(on, 15)).d).toBeCloseTo(bbox(tower(on, 3)).d, 0);
    expect(towerBandsPerLayer([2, 2, 1, 0], 2, false)).toEqual([2, 2, 1, 1]);
  });
  it('wipe tower filament prints the tower walls', () => {
    const p = parse(run(MMU, { proc: { wipe_tower_filament: 2, wipe_tower_wall_type: 'rectangle' } }).gcode);
    // the wall loop of a change layer: the first tower moves of filament 2 there trace the outline (a closed loop)
    const L = 4;
    const t = tower(p.moves, L);
    const outline = t.filter((m) => Math.abs(m.x - m.x0) < 1e-3 || Math.abs(m.y - m.y0) < 1e-3).filter((m) => Math.hypot(m.x - m.x0, m.y - m.y0) > 10);
    expect(outline.length).toBeGreaterThan(0);
    expect(outline.every((m) => m.tool === 1)).toBe(true);
  });
});

describe('prime tower purge', () => {
  it('load / unload volumes size the purge without a flushing matrix; minimal purge is a floor', () => {
    expect(loadUnloadFlush('70,80,90,100', 0, 1)).toBe(170);
    expect(loadUnloadFlush('', 0, 1)).toBeUndefined();
    const depth = (o: Config, fils?: Config[]) => bbox(tower(parse(run(MMU, { proc: { wipe_tower_wall_type: 'rectangle', ...o }, fils }).gcode).moves, 3)).d;
    const base = depth({});
    expect(depth({ wiping_volumes_extruders: '400,400,400,400' })).toBeGreaterThan(base * 1.5);
    expect(depth({}, [{ filament_minimal_purge_on_wipe_tower: 2000 }, { filament_minimal_purge_on_wipe_tower: 2000 }])).toBeGreaterThan(base * 1.5);
  });
  it('prime all printing extruders: a line of each filament at the front edge', () => {
    const p = parse(run(MMU, { proc: { single_extruder_multi_material_priming: true } }).gcode);
    const lines = p.moves.filter((m) => m.layer === 0 && m.type === 'prime tower' && m.y < 8 && Math.abs(m.y - m.y0) < 1e-6);
    expect(new Set(lines.map((m) => m.tool)).size).toBe(2);
    expect(parse(run(MMU).gcode).moves.some((m) => m.layer === 0 && m.type === 'prime tower' && m.y < 8)).toBe(false);
  });
  it('wait for temperature on wipe tower', () => {
    expect(run(MMU, { machine: { wait_for_temp_on_wipe_tower: true } }).gcode).not.toMatch(/wait for the temperature over the prime tower/);
    const c = cfgFor(MMU, { enable_prime_tower: true }, { wait_for_temp_on_wipe_tower: true });
    const fils = slots(c, [{}, {}]).map((f, k) => ({ ...f, nozzleTemp: 210 + k * 20, nozzleTempInitial: 210 + k * 20 }));
    const out = slice([mesh(box(60, 60, 0, 12, 12, 3), 'a', 0), mesh(box(82, 60, 0, 12, 12, 3), 'b', 1)], c, () => {}, { filaments: fils });
    expect(out.gcode).toMatch(/^M109 S230 ; wait for the temperature over the prime tower/m);
  });
});

describe('single-nozzle filament change sequence (MMU)', () => {
  const unload = (machine: Config = {}, fils?: Config[]) => run(MMU, { machine: { ...RAM, ...machine }, fils, proc: { gcode_comments: true } }).gcode;
  const block = (g: string) => { const a = g.indexOf('; CP TOOLCHANGE UNLOAD'); return g.slice(a, g.indexOf('NexSpiro filament change', a)); };
  it('enable filament ramming: ramming, unload, cooling, park only when on', () => {
    expect(run(MMU).gcode).not.toMatch(/F6000 ; retract|^G1 E-15 F6000/m);
    const g = run(MMU, { machine: RAM, proc: { gcode_comments: true } }).gcode;
    expect(g).toContain('; CP TOOLCHANGE UNLOAD');
    expect(g).toContain('; CP TOOLCHANGE LOAD');
    expect(g).toMatch(/^G1 E-15 F6000/m);
  });
  it('ramming parameters set the rammed volume and its line width', () => {
    expect(parseRamming('120 100 6.6 6.8| 0.05 6.6')).toEqual({ lineWidth: 1.2, step: 1, speeds: [6.6, 6.8], timeStep: 0.25 });
    const rammed = (s: string) => {
      const g = run(MMU, { machine: RAM, proc: { gcode_comments: true }, fils: [{ filament_ramming_parameters: s }, { filament_ramming_parameters: s }] }).gcode;
      const b = block(g).split('; Cooling')[0];
      return [...b.matchAll(/^G1 X[\d.]+ (?:Y[\d.]+ )?E([\d.]+)/gm)].reduce((a, m) => a + Number(m[1]), 0);
    };
    const area = Math.PI * 0.875 ** 2;
    expect(rammed('100 100 20 20 20 20')).toBeCloseTo((80 * 0.25) / area, 1);
    expect(rammed('100 100 5 5')).toBeCloseTo((10 * 0.25) / area, 1);
  });
  it('unloading speeds, cooling tube position and length', () => {
    const b = block(unload({ cooling_tube_retraction: 60, cooling_tube_length: 10 }, [{ filament_unloading_speed: 50, filament_unloading_speed_start: 80 }, {}]));
    const total = 60 + 10 / 2 - 15;
    expect(b).toMatch(/^G1 E-15 F4800/m);
    expect(b).toContain(`G1 E-${+(0.7 * total).toFixed(5)} F3000`);
    expect(b).toContain(`G1 E-${+(0.2 * total).toFixed(5)} F1500`);
  });
  it('cooling moves: count, first and last speed', () => {
    const cool = (f: Config) => [...block(unload({ cooling_tube_length: 10 }, [f, {}])).matchAll(/^G1 X[\d.]+ E(-?[\d.]+) F([\d.]+)/gm)].map((m) => [Number(m[1]), Number(m[2])]).filter(([e]) => Math.abs(Math.abs(e) - 10) < 1e-6);
    expect(cool({ filament_cooling_moves: 3 })).toHaveLength(6);
    expect(cool({ filament_cooling_moves: 1 })).toHaveLength(2);
    // speeds run from initial to final (the E speed of each move)
    const c = cool({ filament_cooling_moves: 2, filament_cooling_initial_speed: 2, filament_cooling_final_speed: 8 });
    expect(c).toHaveLength(4);
    expect(c.filter(([e]) => e > 0)).toHaveLength(2);
  });
  it('stamping between cooling moves', () => {
    const b = (f: Config) => block(unload({ cooling_tube_length: 10 }, [{ filament_cooling_moves: 3, ...f }, {}]));
    const stamps = (s: string) => [...s.matchAll(/^G1 E-13 F5400/gm)].length;
    expect(stamps(b({ filament_stamping_distance: 8, filament_stamping_loading_speed: 20 }))).toBe(2);
    expect(stamps(b({}))).toBe(0);
  });
  it('delay after unloading and parking position', () => {
    const b = block(unload({ cooling_tube_retraction: 60, cooling_tube_length: 10, parking_pos_retraction: 90 }, [{ filament_toolchange_delay: 2.5 }, {}]));
    expect(b).toMatch(/^G4 S2.5/m);
    expect(b).toContain(`G1 E-${-10 / 2 + 90 - 60} F2000`);
  });
  it('loading: parking position plus extra loading distance, at the loading speeds', () => {
    const g = unload({ parking_pos_retraction: 80, extra_loading_move: -10 }, [{}, { filament_loading_speed: 30, filament_loading_speed_start: 4 }]);
    const a = g.indexOf('; CP TOOLCHANGE LOAD');
    const after = g.slice(a, a + 3000);
    expect(after).toMatch(/^G1 E14 F240/m);
    const fast = /^G1 X[\d.]+ E49 /m.exec(after);
    expect(fast).not.toBeNull();
    expect(after).toMatch(/^G1 X[\d.]+ E7 F/m);
  });
  it('high extruder current on filament swap', () => {
    const g = unload({ high_current_on_filament_swap: true });
    expect(g).toMatch(/^M907 E750/m);
    expect(g).toMatch(/^M907 E550/m);
    expect(unload()).not.toMatch(/^M907/m);
  });
  it('deretraction speed after an extruder change', () => {
    const g = run(MMU, { machine: { deretract_speed_extruder_change: 7 } }).gcode;
    const a = g.indexOf('end filament change');
    expect(g.slice(a, a + 2000)).toMatch(/^G1 E[\d.]+ F420/m);
    const plain = run(MMU).gcode;
    const b = plain.indexOf('end filament change');
    expect(plain.slice(b, b + 2000)).not.toMatch(/^G1 E[\d.]+ F420$/m);
  });
});

describe('tool changers', () => {
  const IDEX = 'generic-idex';
  it('multi-tool ramming before a head is parked', () => {
    const g = run(IDEX, { fils: [{ filament_multitool_ramming: true, filament_multitool_ramming_volume: 20, filament_multitool_ramming_flow: 10 }, {}] }).gcode;
    const p = parse(g).moves;
    const firstChange = p.find((m) => m.tool === 1)!.idx;
    const before = tower(p.filter((m) => m.idx < firstChange && m.tool === 0));
    expect(eSum(before)).toBeCloseTo(20 / (Math.PI * 0.875 ** 2), 1);
    const plain = parse(run(IDEX).gcode).moves;
    const fc = plain.find((m) => m.tool === 1)!.idx;
    expect(tower(plain.filter((m) => m.idx < fc && m.tool === 0))).toHaveLength(0);
  });
  it('tool change on wipe tower travels over the tower first', () => {
    const near = (g: string) => {
      const p = parse(g).moves;
      const c = bbox(tower(p, 2));
      const k = g.indexOf('NexSpiro tool change T0 -> T1');
      const last = p.filter((m) => m.idx < g.slice(0, k).split('\n').length).pop()!;
      return Math.hypot(last.x - c.cx, last.y - c.cy);
    };
    expect(near(run(IDEX, { machine: { tool_change_on_wipe_tower: true } }).gcode)).toBeLessThan(3);
    expect(near(run(IDEX).gcode)).toBeGreaterThan(3);
  });
  it('preheat steps repeat the preheat of a parked head', () => {
    const big = (k: number) => mesh(box(40 + k * 70, 60, 0, 60, 60, 1.2), `b${k}`, k);
    const count = (steps: number) => {
      const c = cfgFor(IDEX, { enable_prime_tower: false, preheat_steps: steps }, { tool_preheat_time: 60 });
      const g = slice([big(0), big(1)], c, () => {}, { filaments: slots(c, [{}, {}]) }).gcode;
      return (g.match(/preheat T\d for its pick-up/g) ?? []).length;
    };
    const one = count(1);
    expect(one).toBeGreaterThan(0);
    expect(count(3)).toBeGreaterThan(one);
  });
});

describe('machine, filament and process options', () => {
  const single = (o: Config = {}, machine: Config = {}, fil: Config = {}, printer = 'generic-marlin') => {
    const c = cfgFor(printer, o, machine, fil);
    return slice([mesh(tee(100, 100), 't')], c, () => {}, { filaments: slots(c, [fil]) }).gcode;
  };
  it('air filtration: exhaust fan during and after the print', () => {
    const g = single({}, {}, { activate_air_filtration: true, during_print_exhaust_fan_speed: 60, complete_print_exhaust_fan_speed: 80 });
    expect(g).toMatch(/^M106 P3 S153 ; exhaust fan$/m);
    expect(g).toMatch(/^M106 P3 S204 ; exhaust fan after the print/m);
    const off = single({}, {}, { activate_air_filtration: true, activate_air_filtration_during_print: false, activate_air_filtration_on_completion: false });
    expect(off).not.toMatch(/M106 P3/);
    expect(single()).not.toMatch(/M106 P3/);
  });
  it('chamber minimal temperature is a template variable only', () => {
    const g = single({}, { machine_start_gcode: 'START CHAMBER_MIN=[chamber_minimal_temperature]' }, { chamber_minimal_temperature: 45 });
    expect(g).toContain('START CHAMBER_MIN=45');
    expect(g).not.toMatch(/M141|M191/);
  });
  it('adaptive pressure advance from the measurements, static PA on bridges', () => {
    const f = pchip([1, 2, 3], [0.04, 0.03, 0.028]);
    expect(f(1)).toBeCloseTo(0.04, 6);
    expect(f(2.5)).toBeLessThan(0.03);
    expect(f(10)).toBeCloseTo(0.028, 6);
    const m = paModel('0.04,2,1000\n0.03,10,1000\n0.03,2,5000\n0.02,10,5000')!;
    expect(m(2, 1000)).toBeCloseTo(0.04, 3);
    expect(m(10, 5000)).toBeCloseTo(0.02, 3);
    const model = '0.05,1,500\n0.02,30,500';
    const g = single({}, {}, { enable_pressure_advance: true, pressure_advance: 0.04, adaptive_pressure_advance: true, adaptive_pressure_advance_model: model, adaptive_pressure_advance_bridges: 0.011 });
    const pas = [...g.matchAll(/^M900 K([\d.]+)$/gm)].map((x) => Number(x[1]));
    expect(new Set(pas).size).toBeGreaterThan(2);
    expect(g).toMatch(/;TYPE:bridge\nM900 K0.011/);
    expect(single({}, {}, { enable_pressure_advance: true, pressure_advance: 0.04 }).match(/^M900 K/gm)?.length ?? 0).toBeLessThan(3);
    const within = single({}, {}, { enable_pressure_advance: true, adaptive_pressure_advance: true, adaptive_pressure_advance_model: model, adaptive_pressure_advance_overhangs: true });
    expect(within.match(/^M900 K/gm)!.length).toBeGreaterThanOrEqual(g.match(/^M900 K/gm)!.length - 1);
  });
  it('junction deviation (Marlin 2), capped at the printer maximum', () => {
    const g = single({ default_junction_deviation: 0.05 }, { machine_max_junction_deviation: 0.02 });
    expect(g).toMatch(/^M205 J0.02$/m);
    expect(g).toMatch(/^M205 J0.02 ; junction deviation/m);
    expect(single({ default_junction_deviation: 0.05 })).not.toMatch(/M205 J/);
    expect(single({ default_junction_deviation: 0.01 }, { machine_max_junction_deviation: 0.02 })).toMatch(/^M205 J0.01 ; junction deviation/m);
  });
  it('minimum non-zero part cooling fan speed', () => {
    const fans = (g: string) => [...g.matchAll(/^M106 S(\d+)$/gm)].map((x) => Number(x[1])).filter((v) => v > 0);
    const low = { fan_min_speed: 10, fan_max_speed: 20 };
    expect(Math.min(...fans(single({}, {}, low)))).toBeLessThan(102);
    expect(Math.min(...fans(single({}, { part_cooling_fan_min_pwm: 40 }, low)))).toBeGreaterThanOrEqual(102);
    expect(single({}, { part_cooling_fan_min_pwm: 40 }, low)).toMatch(/^M107$/m);
  });
  it('farthest point timelapse: the snapshot at the farthest point of the last layer', () => {
    const g = single({}, { time_lapse_gcode: 'SNAPSHOT', farthest_point_timelapse: true });
    const p = parse(g).moves;
    const lines = g.split('\n');
    const at = lines.findIndex((l, k) => l === 'SNAPSHOT' && k > lines.findIndex((x) => x.startsWith(';LAYER_CHANGE')) + 10);
    const before = p.filter((m) => m.idx <= at).pop()!;
    const walls = p.filter((m) => m.layer === before.layer && m.type === 'outer wall');
    const far = Math.max(...walls.map((m) => Math.hypot(m.x, m.y)));
    expect(Math.abs(Math.hypot(before.x, before.y) - far)).toBeLessThan(0.5);
  });
  it('filament and process change extrusion role G-code after the printer one', () => {
    const g = single({ process_change_extrusion_role_gcode: '; P [extrusion_role]' }, { change_extrusion_role_gcode: '; M [extrusion_role]' }, { filament_change_extrusion_role_gcode: '; F [extrusion_role]' });
    expect(g).toMatch(/;TYPE:outer wall\n; M outer wall\n; F outer wall\n; P outer wall/);
  });
  it('flow rate calibration order: the top spiral prints inside-out, last', () => {
    const top = (on: boolean) => {
      const c = cfgFor('generic-marlin', { top_surface_pattern: 'archimedeanchords', calib_flowrate_topinfill_special_order: on, top_shell_layers: 1 });
      const p = parse(slice([mesh(box(80, 80, 0, 30, 30, 2), 'b')], c, () => {}, { filaments: slots(c, [{}]) }).gcode).moves;
      const L = Math.max(...p.filter((m) => m.type === 'top surface').map((m) => m.layer));
      return p.filter((m) => m.layer === L && m.type === 'top surface');
    };
    const t = top(true);
    // the last run of connected top surface moves starts at the centre and ends outside
    let k = t.length - 1;
    while (k > 0 && Math.hypot(t[k].x0 - t[k - 1].x, t[k].y0 - t[k - 1].y) < 1e-3) k--;
    expect(Math.hypot(t[k].x0 - 95, t[k].y0 - 95)).toBeLessThan(2);
    expect(Math.hypot(t[t.length - 1].x - 95, t[t.length - 1].y - 95)).toBeGreaterThan(8);
  });
  it('SuperTack and Textured Cool Plate: own bed temperatures and plate types', () => {
    const plates = printerById('bbl-x1c').plates.map((p) => p.type);
    expect(plates).toContain('supertack_plate');
    expect(plates).toContain('textured_cool_plate');
    const pla = filamentConfig(filamentById('generic-pla'));
    expect(bedTemps(pla, 'supertack_plate')).toEqual([Number(pla.supertack_plate_temp_initial_layer), Number(pla.supertack_plate_temp)]);
    const c = cfgFor('bbl-x1c', {}, {}, { supertack_plate_temp_initial_layer: 41, supertack_plate_temp: 38, textured_cool_plate_temp_initial_layer: 47, textured_cool_plate_temp: 44 }, 'supertack_plate');
    expect([c.bed_temperature_initial_layer, c.bed_temperature]).toEqual([41, 38]);
    const t = cfgFor('bbl-x1c', {}, {}, { textured_cool_plate_temp_initial_layer: 47, textured_cool_plate_temp: 44 }, 'textured_cool_plate');
    expect([t.bed_temperature_initial_layer, t.bed_temperature]).toEqual([47, 44]);
    expect(t.curr_bed_type).toBe('textured_cool_plate');
  });
});
