// Stage 9–10: kinematic estimate, cooling (slowdown + fan), G-code emission.
import { joinLines, lineCount, TypedBuilder } from './util';
import type { Config } from '../profiles/settings';
import type { FeatureType, FilamentSlot, LayerResult, SliceStats } from './types';
import { FEATURE_ORDER } from './types';
import { fitArc } from './arc';
import { fanSpeedup, smoothingView, splitForSmoothing } from './gcodeParity';
import { changerOf } from '../profiles/changer';
import { inZone, renderVendor, usesVendorTemplates } from './templateVars';
import { AdaptivePA } from './adaptivePA';

export type Op =
  | {
    k: 'move'; x: number; y: number; z: number; e: number; f: number; feature: FeatureType; w: number; h: number; travel: boolean; t?: number; fixed?: boolean; noArc?: boolean;
    /** Part fan at least this % while printing this move (overhang / bridge cooling). */
    fanMin?: number;
    /** Part fan exactly this % while printing this move (ironing fan). */
    fanSet?: number;
    /** Excluded from the cooling slowdown (outer walls when "Don't slow down outer walls" is on). */
    noSlow?: boolean;
    /** Strength (0..1) of a wall texture a plugin put here (Motionex weave wave), for the "Wave area" preview. */
    wave?: number;
    /** Lead-in or tail tucked inside the wall at a loop's seam (Motionex weave): not part of the loop itself. */
    tuck?: boolean;
  }
  | { k: 'retract'; len: number; speed: number }
  | { k: 'raw'; text: string; resetPos?: boolean; time?: number }
  | { k: 'tool'; tool: number }
  | { k: 'accel'; a: number }
  | { k: 'jerk'; j: number }
  /** Spiral Z hop: a full circle of radius r around (x + r, y) while rising to z. */
  | { k: 'lift'; x: number; y: number; z: number; r: number; f: number };

export interface LayerOps {
  z: number; h: number; ops: Op[];
  /** Kept for plugins; the part fan is worked out from the layer time when emitting. */
  fan: number;
  temp?: number; bedTemp?: number;
  /** Layer index in the layer plan (equals the position in the list except when printing by object). */
  layer?: number;
  /** Filament active when the layer starts (its cooling settings apply to the layer). */
  tool?: number;
}

/**
 * Pressure equalizer (max volumetric extrusion rate slopes): along each run of extrusions, the volumetric flow
 * (width × height × speed) may rise by at most `up` mm³/s per second and fall by at most `down` mm³/s per second.
 * Rises are limited going forwards, falls going backwards, by lowering speeds only. Retractions end a run
 * (the pressure is released there), travels in between do not.
 */
export function equalizePressure(ops: Op[], up: number, down: number) {
  type M = Extract<Op, { k: 'move' }>;
  const runs: M[][] = [[]];
  for (const op of ops) {
    if (op.k === 'move' && !op.travel && op.e > 0) runs[runs.length - 1].push(op);
    else if (op.k === 'retract' && op.len > 0) { if (runs[runs.length - 1].length) runs.push([]); }
  }
  const flow = (m: M) => m.w * m.h * m.f;
  const dur = (m: M) => Math.max(1e-3, m.t ?? 0.05);
  for (const r of runs) {
    if (up > 0) for (let k = 1; k < r.length; k++) {
      const cap = flow(r[k - 1]) + up * dur(r[k]);
      if (flow(r[k]) > cap) r[k].f = cap / (r[k].w * r[k].h);
    }
    if (down > 0) for (let k = r.length - 2; k >= 0; k--) {
      const cap = flow(r[k + 1]) + down * dur(r[k]);
      if (flow(r[k]) > cap) r[k].f = cap / (r[k].w * r[k].h);
    }
  }
}

/** Duration of a move with a symmetric trapezoidal profile (junction speeds approximated). */
export function moveTime(len: number, v: number, a: number): number {
  if (len <= 0 || v <= 0) return 0;
  const accelDist = (v * v) / a; // accel + decel distance from rest
  if (len >= accelDist) return len / v + 0.5 * (v / a);
  return 1.5 * Math.sqrt(len / a);
}

const n = (x: number, d = 3) => {
  const s = x.toFixed(d);
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
};

/** Expand [key] / {key} placeholders from config. */
export function expandMacro(tpl: string, cfg: Config, extra: Record<string, string | number> = {}): string {
  return tpl.replace(/[\[{]([a-z0-9_]+)(?:\[\d+\])?[\]}]/gi, (m, key) => {
    if (key in extra) return String(extra[key]);
    if (key in cfg) {
      const v = cfg[key];
      return typeof v === 'number' ? n(v, 3) : String(v);
    }
    return m;
  });
}

export interface EmitInput {
  cfg: Config;
  filaments: FilamentSlot[];
  layers: LayerOps[];
  objectLabels: { name: string; cx: number; cy: number; polygon: [number, number][] }[];
  /** Extra comment lines for the header (from plugins). */
  headerLines?: string[];
  /** Rewrites the lines between the start and end G-code (plugins that repeat the print). */
  bodyTransform?: (body: string[]) => string[];
  /** Extra variables for vendor templates that only the slicer knows (head wrap zone, …). */
  templateExtra?: Record<string, number | string | boolean>;
}

export interface EmitOutput {
  gcode: string;
  moves: Float32Array;
  moveFeatures: Uint8Array;
  moveAux: Float32Array;
  moveLines: Uint32Array;
  /** Per move: wall texture strength 0..255 (only when some move has one). */
  moveWave?: Uint8Array;
  /** Pauses on the part (dwells from motions such as Dots): x, y, z, seconds per pause. */
  pauses?: Float32Array;
  layers: LayerResult[];
  stats: SliceStats;
}

export const MOVE_STRIDE = 8; // x, y, z, width, height, speed, time, tool
export const AUX_STRIDE = 2; // part fan %, nozzle temperature

/** Part fan % for a layer, by the cooling rules (fan by layer time, first layers, ramp, keep fan on). */
export function layerFanSpeed(c: (k: string) => number, b: (k: string) => boolean, layer: number, layerTime: number, firstLayerFan = -1): number {
  // first layer fan speed (Orca): an exact speed for the first layer that overrides every other rule (-1 = off)
  if (layer === 0 && firstLayerFan >= 0) return Math.max(0, Math.min(100, Math.round(firstLayerFan)));
  const first = Math.max(0, Math.round(c('close_fan_the_first_x_layers')));
  if (layer < first) return Math.max(0, c('first_x_layer_part_fan_speed'));
  const fmin = c('fan_min_speed'), fmax = c('fan_max_speed');
  const slowT = c('slow_down_layer_time'), coolT = c('fan_cooling_layer_time');
  let f: number;
  if (layerTime < slowT || coolT <= 0) f = fmax;
  else if (layerTime < coolT) f = fmax - ((fmax - fmin) * (layerTime - slowT)) / Math.max(1e-6, coolT - slowT);
  else f = b('reduce_fan_stop_start_freq') ? fmin : 0;
  const full = Math.round(c('full_fan_speed_layer'));
  if (full > first && layer < full) f *= Math.min(1, (layer - first + 1) / (full - first + 1));
  return Math.max(0, Math.min(100, Math.round(f)));
}

/** Auxiliary fan % for a layer (printers with an aux fan). */
export function auxFanSpeed(c: (k: string) => number, layer: number): number {
  const first = Math.max(0, Math.round(c('close_additional_fan_first_x_layers')));
  if (layer < first) return Math.max(0, c('first_x_layer_fan_speed'));
  let f = c('additional_cooling_fan_speed');
  const full = Math.round(c('additional_fan_full_speed_layer'));
  if (full > first && layer < full) f *= Math.min(1, (layer - first + 1) / (full - first + 1));
  return Math.max(0, Math.min(100, Math.round(f)));
}

/**
 * Tool changers, head temperatures over the whole print (the change G-code itself only parks the head it leaves):
 *  - every head the print uses besides the first waits at standby from the start, so its first pick-up is not a cold heat-up
 *  - a parked head is heated back to print temperature `lead` seconds before it is picked up again, never before it was parked
 *  - a head that is never picked up again is switched off when it is parked (`offAfterLastUse`)
 * Needs the move times. Heads are filament slots (slot n prints with head n).
 */
export function preheatParkedHeads(layers: LayerOps[], lead: number, filaments: FilamentSlot[], o: { standbyDelta?: number; preheatDelta?: number; offAfterLastUse?: boolean; ooze?: boolean; steps?: number } = {}) {
  // time at the start of every op, and every pick-up (a tool op that changes the head)
  const at: { li: number; oi: number; t: number }[] = [];
  const picks: { tool: number; t: number; idx: number }[] = [];
  const parks: { tool: number; t: number; idx: number }[] = [];
  let t = 0, tool = -1, first = -1;
  layers.forEach((L, li) => L.ops.forEach((op, oi) => {
    at.push({ li, oi, t });
    if (op.k === 'move') t += op.t ?? 0;
    else if (op.k === 'raw' && op.time) t += op.time;
    else if (op.k === 'retract') t += Math.abs(op.len) / Math.max(1, op.speed);
    else if (op.k === 'tool') {
      if (first < 0) first = op.tool;
      if (tool >= 0 && op.tool !== tool) { picks.push({ tool: op.tool, t, idx: at.length - 1 }); parks.push({ tool, t, idx: at.length - 1 }); }
      tool = op.tool;
    }
  }));
  if (first < 0) return;
  const inserts: { li: number; oi: number; text: string }[] = [];
  const temp = (k: number) => filaments[k]?.nozzleTemp;
  // heads picked up later wait at standby from the start of the print (before the first head is selected)
  const later = [...new Set(picks.map((p) => p.tool))].filter((k) => k !== first).sort((a, b) => a - b);
  const delta = Math.min(0, o.standbyDelta ?? 0);
  const parkedAt = new Map<number, number>();
  for (const k of later) {
    const tk = temp(k);
    if (!tk) continue;
    // a filament's own idle temperature (Orca) replaces the printer's standby variation
    const idle = o.ooze ? Number(filaments[k]?.settings?.idle_temperature ?? 0) : 0;
    const wait = idle > 0 ? idle : Math.max(0, Math.round(tk + delta));
    inserts.push({ li: at[0].li, oi: at[0].oi, text: `M104 T${k} S${wait} ; T${k} waits ${idle > 0 || delta < 0 ? 'at standby' : 'hot'} for its first pick-up` });
    parkedAt.set(k, -1);
  }
  if (lead > 0) {
    let p = 0;
    for (const pk of picks) {
      // the last time this head was parked before this pick-up (-1: waiting since the start)
      while (p < parks.length && parks[p].idx < pk.idx) { parkedAt.set(parks[p].tool, parks[p].idx); p++; }
      const parked = parkedAt.get(pk.tool);
      if (parked === undefined) continue;
      // preheat steps (Prusa XL): the command is repeated at lead·s/steps before the pick-up, s = steps … 1
      const steps = Math.max(1, Math.min(10, Math.round(o.steps ?? 1)));
      const tk = temp(pk.tool);
      let lastK = -1;
      for (let s = steps; s >= 1; s--) {
        let k = pk.idx;
        while (k > parked + 1 && at[k - 1].t > pk.t - (lead * s) / steps) k--;
        if (tk && k > parked && k < pk.idx && k !== lastK) { lastK = k; inserts.push({ li: at[k].li, oi: at[k].oi, text: `M104 T${pk.tool} S${Math.round(tk + Math.max(-100, Math.min(20, o.preheatDelta ?? 0)))} ; preheat T${pk.tool} for its pick-up${steps > 1 ? ` (${steps - s + 1}/${steps})` : ''}` }); }
      }
    }
  }
  if (o.offAfterLastUse) {
    // the last park of a head with no pick-up after it: off right there (after the change G-code's standby line)
    const lastPick = new Map<number, number>();
    for (const pk of picks) lastPick.set(pk.tool, pk.idx);
    const lastPark = new Map<number, number>();
    for (const pk of parks) lastPark.set(pk.tool, pk.idx);
    for (const [k, idx] of lastPark) if ((lastPick.get(k) ?? -1) < idx) inserts.push({ li: at[idx].li, oi: at[idx].oi, text: `M104 T${k} S0 ; T${k} is not used again` });
  }
  // from the end, so earlier positions stay valid (same position: kept in the order they were added)
  inserts.forEach((x, n) => ((x as { n?: number }).n = n));
  for (const ins of inserts.sort((a, b) => b.li - a.li || b.oi - a.oi || ((b as { n?: number }).n ?? 0) - ((a as { n?: number }).n ?? 0))) layers[ins.li].ops.splice(ins.oi, 0, { k: 'raw', text: ins.text });
}

/** Applies cooling slowdown + timing, then writes G-code text and packed preview moves. */
export function emit({ cfg, filaments, layers, objectLabels, headerLines = [], bodyTransform, templateExtra }: EmitInput): EmitOutput {
  const num = (k: string) => Number(cfg[k] ?? 0);
  const flavor = String(cfg.gcode_flavor);
  const relE = cfg.use_relative_e_distances !== false;
  const maxAccel = num('max_acceleration');
  const maxXY = num('max_speed_xy');
  const byFeature: SliceStats['byFeature'] = {};
  const arcs = cfg.enable_arc_fitting === true && !cfg.spiral_mode;
  // filament-level settings (cooling) of the tool that starts each layer, falling back to the global config
  const toolCfg = (t: number | undefined) => {
    const s = filaments[Math.max(0, Math.min(filaments.length - 1, t ?? 0))]?.settings;
    return { c: (k: string) => Number(s?.[k] ?? cfg[k] ?? 0), b: (k: string) => (s?.[k] ?? cfg[k]) === true };
  };
  const extrudeLimit = cfg.emit_machine_limits_to_gcode !== false && flavor !== 'klipper' && flavor !== 'bbl' ? num('machine_max_acceleration_extruding') : 0;
  const clampA = (a: number) => { let v = maxAccel > 0 ? Math.min(a, maxAccel) : a; if (extrudeLimit > 0) v = Math.min(v, extrudeLimit); return v; };
  const zOff = num('z_offset');
  const fwRetract = cfg.use_firmware_retraction === true;
  const noM73 = cfg.disable_m73 === true;
  const verbose = cfg.gcode_comments === true;
  const kick = Math.max(0, num('fan_kickstart'));
  const roleGcode = String(cfg.change_extrusion_role_gcode ?? '');
  // OrcaSlicer: printer, then filament, then process change extrusion role G-code
  const processRoleGcode = String(cfg.process_change_extrusion_role_gcode ?? '');
  const filamentRoleGcode = (t: number) => String(filaments[t]?.settings?.filament_change_extrusion_role_gcode ?? cfg.filament_change_extrusion_role_gcode ?? '');
  const minPwm = Math.max(0, Math.min(100, num('part_cooling_fan_min_pwm')));
  const apa = new AdaptivePA(filaments, cfg, flavor);

  // 1) timing + cooling slowdown per layer
  const layerTimes: number[] = [];
  const preSlowTimes: number[] = [];
  for (const L of layers) {
    const { c } = toolCfg(L.tool);
    const minSpeed = c('slow_down_min_speed');
    const slowOn = (filaments[L.tool ?? 0]?.settings?.slow_down_for_layer_cooling ?? cfg.slow_down_for_layer_cooling) !== false;
    const minLayerTime = slowOn ? c('slow_down_layer_time') : 0;
    const timeOf = () => {
      let t = 0; let a = clampA(num('default_acceleration'));
      let px = NaN, py = NaN, pz = NaN;
      for (const op of L.ops) {
        if (op.k === 'accel') a = clampA(op.a);
        else if (op.k === 'raw' && op.time) t += op.time;
        else if (op.k === 'raw' && op.resetPos) { px = NaN; py = NaN; pz = NaN; }
        else if (op.k === 'retract') t += Math.abs(op.len) / op.speed;
        else if (op.k === 'lift') { t += (2 * Math.PI * op.r) / Math.max(1, op.f) + 0.05; pz = op.z; }
        else if (op.k === 'move') {
          const len = isNaN(px) ? 0 : Math.hypot(op.x - px, op.y - py, op.z - pz);
          const f = maxXY > 0 ? Math.min(op.f, maxXY) : op.f;
          op.t = moveTime(len, f, a);
          t += op.t;
          px = op.x; py = op.y; pz = op.z;
        }
      }
      return t;
    };
    let t = timeOf();
    preSlowTimes.push(t);
    if (minLayerTime > 0 && t > 0 && t < minLayerTime) {
      // slow printing moves proportionally (travel and protected moves unaffected)
      let fixedT = 0;
      for (const op of L.ops) if (op.k === 'move' && (op.travel || op.fixed || op.noSlow)) fixedT += op.t ?? 0;
      const printT = t - fixedT;
      const want = minLayerTime - fixedT;
      if (printT > 0 && want > printT) {
        const scale = printT / want;
        for (const op of L.ops) if (op.k === 'move' && !op.travel && !op.fixed && !op.noSlow) op.f = Math.max(Math.min(op.f, minSpeed), op.f * scale);
        t = timeOf();
      }
    }
    if (num('max_volumetric_extrusion_rate_slope_positive') > 0 || num('max_volumetric_extrusion_rate_slope_negative') > 0) {
      // smoothing segment length and "apply only on external features" (OrcaSlicer)
      const extOnly = cfg.extrusion_rate_smoothing_external_perimeter_only === true;
      L.ops = splitForSmoothing(L.ops, cfg.max_volumetric_extrusion_rate_slope_segment_length !== undefined ? num('max_volumetric_extrusion_rate_slope_segment_length') : 3, extOnly);
      equalizePressure(smoothingView(L.ops, extOnly), num('max_volumetric_extrusion_rate_slope_positive'), num('max_volumetric_extrusion_rate_slope_negative'));
      t = timeOf();
    }
    layerTimes.push(t);
  }
  if (changerOf(cfg) === 'toolchanger') {
    const ooze = cfg.ooze_prevention !== false;
    preheatParkedHeads(layers, ooze ? num('tool_preheat_time') : 0, filaments, { ooze, standbyDelta: ooze ? num('standby_temperature_delta') : 0, preheatDelta: num('preheat_delta_temperature'), offAfterLastUse: cfg.tool_off_after_last_use !== false, steps: num('preheat_steps') || 1 });
  }
  const total = layerTimes.reduce((a, b) => a + b, 0);

  // 2) write
  const out: string[] = [];
  let lineNo = 0;
  const push = (text: string) => { out.push(text); lineNo += lineCount(text); };
  const moves = new TypedBuilder(Float32Array);
  const aux = new TypedBuilder(Float32Array);
  const lines = new TypedBuilder(Uint32Array);
  const feats = new TypedBuilder(Uint8Array);
  const pauses: number[] = [];
  const waves = new TypedBuilder(Uint8Array);
  let anyWave = false;
  const layerRes: LayerResult[] = [];
  let filamentMm = 0;
  let tool = 0;
  let toolChanges = 0;
  let toolSeen = false;
  const perFil = filaments.map(() => 0);
  let towerMm = 0;

  push('; generated by NexSpiro 0.1.0');
  push(`; printer_model = ${cfg.printer_model}`);
  push(`; filament_type = ${cfg.filament_type}`);
  push(`; layer_height = ${cfg.layer_height}`);
  push(`; total layer number: ${layers.length}`);
  push('; estimated printing time (normal mode) = __TIME__');
  push('; filament used [mm] = __FILMM__');
  push('; filament used [g] = __FILG__');
  for (const h of headerLines) push(h);
  push('');

  if (cfg.exclude_object !== false && flavor === 'klipper') {
    for (const o of objectLabels) {
      const poly = o.polygon.map(([x, y]) => `[${n(x)},${n(y)}]`).join(',');
      push(`EXCLUDE_OBJECT_DEFINE NAME=${o.name} CENTER=${n(o.cx)},${n(o.cy)} POLYGON=[${poly}]`);
    }
  }
  // chamber temperature (filament): written only with "Activate temperature control" on
  const chamberOn = (filaments[0]?.settings?.activate_chamber_temp_control ?? cfg.activate_chamber_temp_control) === true;
  const chamber = chamberOn ? Math.max(...filaments.map((fl) => Number(fl.settings?.chamber_temperatures ?? fl.settings?.chamber_temperature ?? 0)), num('chamber_temperatures') || num('chamber_temperature')) : 0;
  if (chamber > 0) push(`M141 S${Math.round(chamber)} ; chamber temperature`);
  // machine limits (Marlin): the firmware runs with the printer's limits; 0 = not written
  if (cfg.emit_machine_limits_to_gcode !== false && flavor !== 'klipper' && flavor !== 'bbl') {
    const lim = (prefix: string, keys: [string, string][]) => {
      const parts = keys.filter(([, k]) => num(k) > 0).map(([a, k]) => `${a}${n(num(k), 2)}`);
      if (parts.length) push(`${prefix} ${parts.join(' ')}`);
    };
    lim('M201', [['X', 'machine_max_acceleration_x'], ['Y', 'machine_max_acceleration_y'], ['Z', 'machine_max_acceleration_z'], ['E', 'machine_max_acceleration_e']]);
    // M203 takes mm/s on Marlin 2
    lim('M203', [['X', 'machine_max_speed_x'], ['Y', 'machine_max_speed_y'], ['Z', 'machine_max_speed_z'], ['E', 'machine_max_speed_e']]);
    lim('M204', [['P', 'machine_max_acceleration_extruding'], ['R', 'machine_max_acceleration_retracting'], ['T', 'machine_max_acceleration_travel']]);
    lim('M205', [['X', 'machine_max_jerk_x'], ['Y', 'machine_max_jerk_y'], ['Z', 'machine_max_jerk_z'], ['E', 'machine_max_jerk_e']]);
    lim('M205', [['S', 'machine_min_extruding_rate'], ['T', 'machine_min_travel_rate']]);
    if (flavor === 'marlin') lim('M205', [['J', 'machine_max_junction_deviation']]);
  }
  // the printer maker's own templates (Bambu Studio, Snapmaker Orca, OrcaSlicer profiles) run with the variables those
  // slicers give them; every other printer uses NexSpiro's simple [key] expansion
  const vendor = usesVendorTemplates(cfg);
  const firstTool = layers.find((L) => L.ops.some((op) => op.k === 'move' && !op.travel))?.tool ?? 0;
  const firstBox = (() => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, oMinX = Infinity, oMinY = Infinity, oMaxX = -Infinity, oMaxY = -Infinity;
    const L0 = layers[0];
    for (const op of L0?.ops ?? []) {
      if (op.k !== 'move' || op.travel || !(op.e > 0)) continue;
      minX = Math.min(minX, op.x); minY = Math.min(minY, op.y); maxX = Math.max(maxX, op.x); maxY = Math.max(maxY, op.y);
      if (op.feature !== 'prime_tower') { oMinX = Math.min(oMinX, op.x); oMinY = Math.min(oMinY, op.y); oMaxX = Math.max(oMaxX, op.x); oMaxY = Math.max(oMaxY, op.y); }
    }
    if (!isFinite(minX)) { minX = minY = maxX = maxY = 0; }
    if (!isFinite(oMinX)) { oMinX = minX; oMinY = minY; oMaxX = maxX; oMaxY = maxY; }
    return { minX, minY, maxX, maxY, cx: (oMinX + oMaxX) / 2, cy: (oMinY + oMaxY) / 2, obj: { minX: oMinX, minY: oMinY, maxX: oMaxX, maxY: oMaxY } };
  })();
  const zoneOf = (v: unknown) => (typeof v === 'string' && v ? v.split(',') : v);
  const tplCommon = {
    total_layer_count: layers.length, initial_extruder: firstTool, initial_tool: firstTool, initial_no_support_extruder: firstTool, initial_no_support_tool: firstTool,
    current_extruder: firstTool,
    first_layer_print_min: [firstBox.minX, firstBox.minY], first_layer_print_max: [firstBox.maxX, firstBox.maxY],
    first_layer_print_size: [firstBox.maxX - firstBox.minX, firstBox.maxY - firstBox.minY], first_layer_center_no_wipe_tower: [firstBox.cx, firstBox.cy],
    in_head_wrap_detect_zone: inZone(zoneOf(cfg.head_wrap_detect_zone), firstBox.obj),
    initial_layer_print_height: Number(cfg.initial_layer_print_height ?? layers[0]?.h ?? 0.2),
    has_wipe_tower: layers.some((L) => L.ops.some((op) => op.k === 'move' && op.feature === 'prime_tower')),
    initial_no_support_filament_id: firstTool, first_non_support_filaments: [firstTool, -1], first_filaments: [firstTool, -1],
    max_print_z: Math.ceil(layers[layers.length - 1]?.z ?? 0),
    is_extruder_used: (() => {
      const used = new Set(layers.flatMap((L) => [L.tool ?? 0, ...L.ops.flatMap((op) => (op.k === 'tool' ? [(op as { tool?: number }).tool ?? 0] : []))]));
      const heads = Math.max(filaments.length, Math.round(Number(cfg.toolhead_count ?? 1)) || 1, Math.round(Number(cfg.filament_slots ?? 0)) || 0, ...[...used].map((k) => k + 1));
      return Array.from({ length: heads }, (_, k) => used.has(k));
    })(),
    // Orca: exposed to the templates only (no M141 / M191), per filament; [chamber_minimal_temperature] = the first one
    chamber_minimal_temperature: filaments.map((fl) => Number(fl.settings?.chamber_minimal_temperature ?? cfg.chamber_minimal_temperature ?? 0)),
    ...templateExtra,
  };
  const macro = (tpl: string, what: string, extra: Record<string, number | string | boolean | (number | string | boolean)[]> = {}) =>
    vendor ? renderVendor(tpl, cfg, filaments, { ...tplCommon, ...extra }, what) : expandMacro(tpl, cfg, extra as Record<string, string | number>);
  push(macro(String(cfg.machine_start_gcode ?? ''), 'Start G-code', vendor ? {} : { chamber_minimal_temperature: Math.max(0, ...tplCommon.chamber_minimal_temperature) }));
  if (vendor) push(';===== end of start G-code =====');
  const bodyStart = out.length;
  if (chamber > 0 && flavor !== 'klipper') push(`M191 S${Math.round(chamber)} ; wait for chamber`);
  // exhaust / air filtration fan (OrcaSlicer: the highest speed of the filaments that ask for it)
  const exhaust = (on: string, speed: string) => Math.max(-1, ...filaments.map((fl) => {
    const g = (k: string) => fl.settings?.[k] ?? cfg[k];
    return g('activate_air_filtration') === true && g(on) !== false ? Number(g(speed) ?? 0) : -1;
  }));
  const exhaustDuring = exhaust('activate_air_filtration_during_print', 'during_print_exhaust_fan_speed');
  if (exhaustDuring >= 0) push(`M106 P3 S${Math.round((exhaustDuring / 100) * 255)} ; exhaust fan`);
  // junction deviation (Marlin 2): the process value, capped at the printer's maximum
  const jdMax = num('machine_max_junction_deviation'), jd = num('default_junction_deviation');
  if (flavor === 'marlin' && jdMax > 0 && jd > 0) push(`M205 J${n(Math.min(jd, jdMax), 3)} ; junction deviation`);
  if (cfg.pressure_advance !== undefined && cfg.pressure_advance !== '' && cfg.enable_pressure_advance !== false) push(flavor === 'klipper' ? `SET_PRESSURE_ADVANCE ADVANCE=${cfg.pressure_advance}` : `M900 K${cfg.pressure_advance}`);
  push('G90 ; absolute XYZ');
  push(relE ? 'M83 ; relative E' : 'M82 ; absolute E');
  push('G92 E0');

  let x = 0, y = 0, z = 0, f = 0, fanOut = -1, auxOut = -1, accel = -1, jerk = -1;
  let eAbs = 0;
  let temp = filaments[0]?.nozzleTempInitial ?? num('nozzle_temperature_initial_layer');
  let elapsed = 0;
  const hasAux = cfg.auxiliary_fan === true;
  const a2d = cfg.accel_to_decel_enable === true ? num('accel_to_decel_factor') / 100 : 0;
  const fmtF = (v: number) => n(v * 60, 0);
  // high precision G-code: X Y Z I J with 4 decimals, E with 6
  const dXY = cfg.high_precision_gcode === true ? 4 : 3, dE = cfg.high_precision_gcode === true ? 6 : 5;
  const eTok = (e: number) => { if (relE) return `E${n(e, dE)}`; eAbs += e; return `E${n(eAbs, dE)}`; };
  const pushMove = (feature: FeatureType, w: number, h: number, speed: number, t: number, fan: number, wave = 0) => {
    moves.push(x, y, z, w, h, speed, t, tool);
    aux.push(fan, temp);
    lines.push(lineNo - 1);
    feats.push(FEATURE_ORDER.indexOf(feature));
    if (wave > 0) anyWave = true;
    waves.push(Math.round(Math.max(0, Math.min(1, wave)) * 255));
  };
  const setFan = (pct: number) => {
    // minimum non-zero part fan speed: any running fan at least that (off stays off)
    if (minPwm > 0 && pct > 0 && pct < minPwm) pct = minPwm;
    if (pct === fanOut) return;
    // fan kick-start: from off (or a lower speed) the fan first runs flat out for a moment, then drops to the target
    if (kick > 0 && pct > 0 && pct < 100 && fanOut <= 0) { push(`M106 S255${verbose ? ' ; fan kick-start' : ''}`); push(`G4 P${Math.round(kick * 1000)}`); elapsed += kick; }
    fanOut = pct;
    push(pct > 0 ? `M106 S${Math.round((pct / 100) * 255)}` : 'M107');
  };
  let lastRole = '';
  /** ;TYPE: line for a new line type, with the printer's change extrusion role G-code after it. */
  const typeLine = (feature: FeatureType, layerIndex: number, lz: number) => {
    const role = feature.replace(/_/g, ' ');
    push(`;TYPE:${role}`);
    const roleVars = { extrusion_role: role, last_extrusion_role: lastRole, layer_num: layerIndex, layer_z: n(lz) };
    if (roleGcode) push(expandMacro(roleGcode, cfg, roleVars));
    const fr = filamentRoleGcode(tool);
    if (fr) push(expandMacro(fr, cfg, roleVars));
    if (processRoleGcode) push(expandMacro(processRoleGcode, cfg, roleVars));
    lastRole = role;
  };
  let apaW = 0;
  /** Adaptive pressure advance for the stretch of `feature` starting at ops[oi]: its line cross section times its fastest speed. */
  const apaLine = (ops: Op[], oi: number) => {
    const op = ops[oi];
    if (!apa.on || op.k !== 'move') return;
    let fmax = 0;
    for (let k = oi; k < ops.length; k++) {
      const m = ops[k];
      if (m.k !== 'move' || m.travel) continue;
      if (m.feature !== op.feature) break;
      fmax = Math.max(fmax, m.f);
    }
    const xs = op.w > op.h ? (op.w - op.h) * op.h + Math.PI * (op.h / 2) ** 2 : op.w * op.h;
    const l = apa.line(tool, op.feature.includes('bridge'), xs * fmax, accel > 0 ? accel : clampA(num('default_acceleration')));
    if (l) push(l);
    apaW = op.w;
  };
  const tempIn = (text: string) => {
    for (const m of text.matchAll(/^M10[49](?![^;\n]*\bT\d)[^;\n]*\bS(\d+(?:\.\d+)?)/gm)) temp = Number(m[1]);
  };

  /** Filament extruded so far, per filament and in all (OrcaSlicer: extruded_volume / extruded_weight, mm³ and g). */
  const extruded = () => {
    const vol = perFil.map((mm, k) => mm * Math.PI * ((filaments[k] ?? filaments[0])?.diameter ?? 1.75) ** 2 / 4);
    const wt = vol.map((v, k) => (v / 1000) * ((filaments[k] ?? filaments[0])?.density ?? 1.24));
    return { extruded_volume: vol, extruded_weight: wt, extruded_volume_total: vol.reduce((a, b) => a + b, 0), extruded_weight_total: wt.reduce((a, b) => a + b, 0) };
  };
  layers.forEach((L, li) => {
    const moveStart = feats.length;
    const { c } = toolCfg(L.tool);
    const layerIndex = L.layer ?? li;
    const firstFan = Number(filaments[L.tool ?? 0]?.settings?.initial_layer_fan_speed ?? cfg.initial_layer_fan_speed ?? -1);
    const layerFan = layerFanSpeed(c, (k) => (filaments[L.tool ?? 0]?.settings?.[k] ?? cfg[k]) === true, layerIndex, preSlowTimes[li], Number.isFinite(firstFan) ? firstFan : -1);
    const bl = String(cfg.before_layer_change_gcode ?? '');
    if (bl) push(vendor ? macro(bl, 'Before layer change G-code', { layer_num: layerIndex, layer_z: L.z, max_layer_z: L.z, ...extruded() }) : expandMacro(bl, cfg, { layer_num: layerIndex, layer_z: n(L.z) }));
    push(';LAYER_CHANGE');
    push(`;Z:${n(L.z)}`);
    push(`;HEIGHT:${n(L.h)}`);
    if (!relE) { push('G92 E0'); eAbs = 0; }
    if (flavor !== 'klipper' && !noM73) push(`M73 P${Math.floor((elapsed / Math.max(total, 1e-6)) * 100)} R${Math.ceil((total - elapsed) / 60)}`);
    // (the makers' own layer change G-code reports the layer itself)
    if (vendor && /M73 L|SET_PRINT_STATS_INFO/.test(String(cfg.layer_change_gcode ?? ''))) { /* reported by the template */ }
    else if (flavor === 'bbl' && !noM73) push(`M73 L${li + 1}`);
    else if (flavor === 'klipper') push(`SET_PRINT_STATS_INFO CURRENT_LAYER=${li + 1}${li === 0 ? ` TOTAL_LAYER=${layers.length}` : ''}`);
    const lc = String(cfg.layer_change_gcode ?? '');
    if (lc) push(vendor ? macro(lc, 'Layer change G-code', { layer_num: layerIndex, layer_z: L.z, max_layer_z: L.z, ...extruded() }) : expandMacro(lc, cfg, { layer_num: layerIndex, layer_z: n(L.z) }));
    if (L.temp !== undefined) { push(`M104 S${L.temp}`); temp = L.temp; }
    if (L.bedTemp !== undefined) push(`M140 S${L.bedTemp}`);
    L.fan = layerFan;
    // fan speed-up time (printer): fan increases start that many seconds early
    fanSpeedup(L.ops, num('fan_speedup_time'), cfg.fan_speedup_overhangs !== false, layerFan);
    setFan(layerFan);
    if (hasAux) {
      const a = auxFanSpeed(c, layerIndex);
      if (a !== auxOut) { auxOut = a; push(`M106 P2 S${Math.round((a / 100) * 255)}`); }
    }
    let curFeature: FeatureType | null = null;
    for (let oi = 0; oi < L.ops.length; oi++) {
      const op = L.ops[oi];
      if (op.k === 'move' && !op.travel && op.e > 0) setFan(op.fanSet !== undefined ? op.fanSet : Math.max(layerFan, op.fanMin ?? 0));
      if (arcs && op.k === 'move' && !op.travel && !op.noArc && op.e > 0 && op.z === z && !isNaN(x)) {
        const fit = fitArc(L.ops, oi, x, y);
        if (fit) {
          if (curFeature !== op.feature) { curFeature = op.feature; typeLine(op.feature, layerIndex, L.z); apaLine(L.ops, oi); }
          const last = L.ops[fit.end] as Extract<Op, { k: 'move' }>;
          let e = 0;
          const i0 = fit.cx - x, j0 = fit.cy - y;
          const arcMoves: [Extract<Op, { k: 'move' }>, number, number][] = [];
          for (let k = oi; k <= fit.end; k++) {
            const m = L.ops[k] as Extract<Op, { k: 'move' }>;
            e += m.e;
            arcMoves.push([m, m.x, m.y]);
          }
          const parts = [fit.cw ? 'G2' : 'G3', `X${n(last.x, dXY)}`, `Y${n(last.y, dXY)}`, `I${n(i0, dXY)}`, `J${n(j0, dXY)}`, eTok(e)];
          if (op.f !== f) { parts.push(`F${fmtF(op.f)}`); f = op.f; }
          push(parts.join(' '));
          for (const [m, mx, my] of arcMoves) {
            x = mx; y = my;
            const t = m.t ?? 0;
            elapsed += t;
            pushMove(m.feature, m.w, m.h, m.f, t, fanOut, m.wave);
            const bf = byFeature[m.feature] ?? (byFeature[m.feature] = { time: 0, filamentMm: 0 });
            bf.time += t; bf.filamentMm += m.e;
          }
          filamentMm += e;
          perFil[tool] += e;
          if (op.feature === 'prime_tower') towerMm += e;
          oi = fit.end;
          continue;
        }
      }
      switch (op.k) {
        case 'raw':
          push(op.text);
          tempIn(op.text);
          // a macro that switched the extruder mode or reset E (the makers' change G-code ends in M83 / G92 E0):
          // put NexSpiro's mode back, so absolute E never meets a firmware left in relative mode
          if (/^\s*(?:N\d+\s+)?(?:M8[23]\b|G92\b[^;\n]*\bE)/m.test(op.text)) {
            push(relE ? 'M83 ; relative E (after the inserted G-code)' : 'M82 ; absolute E (after the inserted G-code)');
            if (!relE) { push('G92 E0'); eAbs = 0; }
          }
          if (op.time) elapsed += op.time;
          if (op.time && /^\s*G4\b/.test(op.text) && Number.isFinite(x) && Number.isFinite(y)) pauses.push(x, y, Number.isFinite(z) ? z : L.z, op.time);
          if (op.resetPos) { x = NaN; y = NaN; z = NaN; f = NaN; accel = -1; }
          // a macro that touched the part fan (filament change): put the layer's fan speed back right away
          if (op.resetPos && /^\s*M10[67](?!\s*P[2-9])/m.test(op.text)) { fanOut = -1; setFan(layerFan); }
          break;
        case 'tool':
          if (toolSeen && op.tool !== tool) toolChanges++;
          toolSeen = true;
          tool = op.tool;
          break;
        case 'accel': {
          const a = clampA(op.a);
          if (a !== accel) {
            accel = a;
            push(flavor === 'klipper' ? `SET_VELOCITY_LIMIT ACCEL=${n(a, 0)}${a2d ? ` ACCEL_TO_DECEL=${n(a * a2d, 0)}` : ''}` : `M204 S${n(a, 0)}`);
          }
          break;
        }
        case 'jerk':
          if (op.j !== jerk && op.j > 0) {
            jerk = op.j;
            push(flavor === 'klipper' ? `SET_VELOCITY_LIMIT SQUARE_CORNER_VELOCITY=${n(op.j, 1)}` : `M205 X${n(op.j, 1)} Y${n(op.j, 1)}`);
          }
          break;
        case 'lift': {
          // spiral Z hop: A1/P1/X1/H2 firmware takes a full-circle G3 (P1); others get a short helix of G1 moves
          const f2 = fmtF(op.f);
          if (flavor === 'bbl') { push('G17'); push(`G3 Z${n(op.z + zOff)} I${n(op.r)} J0 P1 F${f2}`); }
          else {
            const z0 = isNaN(z) ? op.z : z;
            for (let k = 1; k <= 8; k++) {
              const a = (k / 8) * 2 * Math.PI;
              push(`G1 X${n(op.x + op.r - op.r * Math.cos(a))} Y${n(op.y - op.r * Math.sin(a))} Z${n(z0 + ((op.z - z0) * k) / 8 + zOff)} F${f2}`);
            }
          }
          x = op.x; y = op.y; z = op.z; f = op.f;
          elapsed += (2 * Math.PI * op.r) / Math.max(1, op.f);
          break;
        }
        case 'retract':
          // firmware retraction: G10 / G11, length and speed set in the firmware
          if (fwRetract) push(op.len > 0 ? `G10${verbose ? ' ; retract' : ''}` : `G11${verbose ? ' ; unretract' : ''}`);
          else push(`G1 ${eTok(-op.len)} F${fmtF(op.speed)}${verbose ? (op.len > 0 ? ' ; retract' : ' ; unretract') : ''}`);
          filamentMm -= op.len;
          perFil[tool] -= op.len;
          break;
        case 'move': {
          if (!op.travel && curFeature !== op.feature) {
            curFeature = op.feature;
            typeLine(op.feature, layerIndex, L.z);
            apaLine(L.ops, oi);
          } else if (!op.travel && op.e > 0 && apaW > 0 && apa.overhangs(tool) && Math.abs(op.w - apaW) > 0.15 * apaW) apaLine(L.ops, oi);
          const parts = [op.travel && op.e === 0 ? 'G0' : 'G1'];
          if (op.x !== x) parts.push(`X${n(op.x, dXY)}`);
          if (op.y !== y) parts.push(`Y${n(op.y, dXY)}`);
          if (op.z !== z) parts.push(`Z${n(op.z + zOff, dXY)}`);
          if (op.e !== 0) parts.push(eTok(op.e));
          if (op.f !== f) { parts.push(`F${fmtF(op.f)}`); f = op.f; }
          if (parts.length === 1 || (parts.length === 2 && parts[1].startsWith('F'))) {
            if (parts.length === 2) push(parts.join(' '));
            break;
          }
          push(verbose && op.travel ? `${parts.join(' ')} ; ${op.z !== z && op.x === x && op.y === y ? (op.z > z ? 'lift Z' : 'lower Z') : op.e < 0 ? 'wipe' : 'move to next position'}` : parts.join(' '));
          const moved = op.x !== x || op.y !== y || op.z !== z;
          x = op.x; y = op.y; z = op.z;
          filamentMm += op.e;
          perFil[tool] += op.e;
          if (op.feature === 'prime_tower') towerMm += op.e;
          const t = op.t ?? 0;
          elapsed += t;
          if (moved) pushMove(op.travel ? 'travel' : op.feature, op.w, op.h, op.f, t, fanOut, op.travel ? 0 : op.wave);
          const fk = op.travel ? 'travel' : op.feature;
          const bf = byFeature[fk] ?? (byFeature[fk] = { time: 0, filamentMm: 0 });
          // travel (incl. wipe-retract) carries no extrusion in the feature table; retract/unretract pairs net out in the total
          bf.time += t; if (!op.travel) bf.filamentMm += op.e;
          break;
        }
      }
    }
    layerRes.push({ index: li, z: L.z, height: L.h, moveStart, moveEnd: feats.length, time: layerTimes[li] });
  });

  if (bodyTransform) {
    // large programs (repeated prints): no spread — it overflows the call stack
    const body = bodyTransform(out.splice(bodyStart));
    for (const l of body) out.push(l);
  }
  if (!noM73) push('M73 P100 R0');
  setFan(0);
  const lastL = layers[layers.length - 1];
  const exhaustAfter = exhaust('activate_air_filtration_on_completion', 'complete_print_exhaust_fan_speed');
  if (exhaustAfter >= 0) push(`M106 P3 S${Math.round((exhaustAfter / 100) * 255)} ; exhaust fan after the print`);
  if (vendor) push(';===== NexSpiro end G-code: the printer maker\'s own end G-code follows =====');
  push(macro(String(cfg.machine_end_gcode ?? ''), 'End G-code', { layer_num: Math.max(0, layers.length - 1), layer_z: lastL?.z ?? 0, max_layer_z: lastL?.z ?? 0, toolchange_count: toolChanges }));

  const gramsOf = (mm: number, k: number) => {
    const fl = filaments[k] ?? filaments[0];
    return (mm * Math.PI * (fl.diameter / 2) ** 2) / 1000 * fl.density;
  };
  const perFilament = perFil.map((mm, k) => {
    const g = gramsOf(mm, k);
    return { mm, grams: g, cost: (g / 1000) * (filaments[k] ?? filaments[0]).cost };
  });
  for (const v of Object.values(byFeature)) if (v) v.grams = gramsOf(v.filamentMm, 0);
  const grams = perFilament.reduce((a, b) => a + b.grams, 0);
  const cost = perFilament.reduce((a, b) => a + b.cost, 0);
  const filArea = Math.PI * (num('filament_diameter') / 2) ** 2;
  const fmtTime = (s: number) => {
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.round(s % 60);
    return `${h ? h + 'h ' : ''}${m}m ${sec}s`;
  };
  push('');
  push(`; filament used [cm3] = ${n(filamentMm * filArea / 1000, 2)}`);
  push(`; total filament cost = ${n(cost, 2)}`);
  push(`; total filament change = ${toolChanges}`);
  // settings block, as other slicers write it (read back by printer UIs and post-processors)
  push('; CONFIG_BLOCK_START');
  for (const k of Object.keys(cfg).sort()) {
    if (k.endsWith('_gcode') || k === 'post_process') continue; // G-code templates stay out of the block
    const v = cfg[k];
    if (typeof v === 'string' && v.includes('\n')) push(`; ${k} = ${v.replace(/\n/g, '\\n')}`);
    else push(`; ${k} = ${String(v)}`);
  }
  push('; CONFIG_BLOCK_END');
  // the placeholders sit in the header: fill them in before the big join so the large string is built only once
  const fill = (t: string) => t.replace('__TIME__', fmtTime(total)).replace('__FILMM__', n(filamentMm, 2)).replace('__FILG__', n(grams, 2));
  for (let k = 0; k < Math.min(out.length, 400); k++) out[k] = fill(out[k]);
  const gcode = joinLines(out, cfg.gcode_add_line_number === true);

  return {
    gcode,
    moves: moves.toTyped(),
    moveFeatures: feats.toTyped(),
    moveAux: aux.toTyped(),
    moveLines: lines.toTyped(),
    moveWave: anyWave ? waves.toTyped() : undefined,
    pauses: pauses.length ? new Float32Array(pauses) : undefined,
    layers: layerRes,
    stats: {
      timeSeconds: total,
      filamentMm,
      filamentGrams: grams,
      filamentCost: cost,
      layerCount: layers.length,
      toolChanges,
      perFilament,
      towerGrams: gramsOf(towerMm, 0),
      byFeature,
    },
  };
}
