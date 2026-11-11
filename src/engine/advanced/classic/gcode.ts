// Frozen classic engine of Advanced mode (as on main at 08b924a). Advanced mode slices with this engine
// only, so Basic-engine changes never alter Advanced output and vice versa.
// Stage 9–10: kinematic estimate, cooling slowdown and G-code emission.
import { joinLines } from '../../util';
import type { Config } from '../../../profiles/settings';
import type { FeatureType, FilamentSlot, LayerResult, SliceStats } from '../../types';
import { FEATURE_ORDER } from '../../types';
import { fitArc } from '../../arc';
import { firstLayerTemplateVars, inZone, renderVendor, usesVendorTemplates } from '../../templateVars';

export type Op =
  | { k: 'move'; x: number; y: number; z: number; e: number; f: number; feature: FeatureType; w: number; h: number; travel: boolean; t?: number; fixed?: boolean; noArc?: boolean;
      /** Advanced mode: how far (mm, signed) surface passes have already moved this bead off its layer surface. */
      dev?: number;
      /** Advanced mode: free-space draw whose head clearance is guaranteed by construction (skipped by the checker). */
      noClear?: boolean }
  | { k: 'retract'; len: number; speed: number }
  | { k: 'raw'; text: string; resetPos?: boolean; time?: number }
  | { k: 'tool'; tool: number }
  | { k: 'accel'; a: number };

export interface LayerOps { z: number; h: number; ops: Op[]; fan: number; temp?: number; bedTemp?: number }

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
}

export interface EmitOutput {
  gcode: string;
  moves: Float32Array;
  moveFeatures: Uint8Array;
  layers: LayerResult[];
  stats: SliceStats;
}

/** Applies cooling slowdown + timing, then writes G-code text and packed preview moves. */
export function emit({ cfg, filaments, layers, objectLabels, headerLines = [] }: EmitInput): EmitOutput {
  const num = (k: string) => Number(cfg[k] ?? 0);
  const flavor = String(cfg.gcode_flavor);
  const minLayerTime = num('slow_down_layer_time');
  const minSpeed = num('slow_down_min_speed');
  const filArea = Math.PI * (num('filament_diameter') / 2) ** 2;
  const byFeature: SliceStats['byFeature'] = {};
  const arcs = cfg.enable_arc_fitting === true && !cfg.spiral_mode;

  // 1) timing + cooling slowdown per layer
  const layerTimes: number[] = [];
  for (const L of layers) {
    const timeOf = (scale: number) => {
      let t = 0; let a = num('default_acceleration');
      let px = NaN, py = NaN, pz = NaN;
      for (const op of L.ops) {
        if (op.k === 'accel') a = op.a;
        else if (op.k === 'raw' && op.time) t += op.time;
        else if (op.k === 'raw' && op.resetPos) { px = NaN; py = NaN; pz = NaN; }
        else if (op.k === 'retract') t += Math.abs(op.len) / op.speed;
        else if (op.k === 'move') {
          const len = isNaN(px) ? 0 : Math.hypot(op.x - px, op.y - py, op.z - pz);
          const f = op.travel || op.fixed ? op.f : Math.max(Math.min(op.f, op.f * scale), Math.min(op.f, minSpeed));
          op.t = moveTime(len, f, a);
          t += op.t;
          px = op.x; py = op.y; pz = op.z;
        }
      }
      return t;
    };
    let t = timeOf(1);
    if (minLayerTime > 0 && t > 0 && t < minLayerTime) {
      // slow printing moves proportionally (travel unaffected)
      let travelT = 0;
      for (const op of L.ops) if (op.k === 'move' && op.travel) travelT += op.t ?? 0;
      const printT = t - travelT;
      const want = minLayerTime - travelT;
      if (printT > 0 && want > printT) {
        const scale = printT / want;
        for (const op of L.ops) if (op.k === 'move' && !op.travel && !op.fixed) op.f = Math.max(Math.min(op.f, minSpeed), op.f * scale);
        t = timeOf(1);
      }
    }
    layerTimes.push(t);
  }
  const total = layerTimes.reduce((a, b) => a + b, 0);

  // 2) write
  const out: string[] = [];
  const moves: number[] = [];
  const feats: number[] = [];
  const layerRes: LayerResult[] = [];
  let filamentMm = 0;
  let tool = 0;
  let toolChanges = 0;
  let toolSeen = false;
  const perFil = filaments.map(() => 0);
  let towerMm = 0;

  out.push('; generated by NexSpiro 0.1.0');
  out.push(`; printer_model = ${cfg.printer_model}`);
  out.push(`; filament_type = ${cfg.filament_type}`);
  out.push(`; layer_height = ${cfg.layer_height}`);
  out.push(`; total layer number: ${layers.length}`);
  out.push('; estimated printing time (normal mode) = __TIME__');
  out.push('; filament used [mm] = __FILMM__');
  out.push('; filament used [g] = __FILG__');
  out.push(...headerLines);
  out.push('');

  if (cfg.label_objects && flavor === 'klipper') {
    for (const o of objectLabels) {
      const poly = o.polygon.map(([x, y]) => `[${n(x)},${n(y)}]`).join(',');
      out.push(`EXCLUDE_OBJECT_DEFINE NAME=${o.name} CENTER=${n(o.cx)},${n(o.cy)} POLYGON=[${poly}]`);
    }
  }
  // the printer maker's own templates run with the variables their slicer gives them (see ../../templateVars.ts)
  const vendor = usesVendorTemplates(cfg);
  const firstToolOp = layers.flatMap((L) => L.ops).find((op) => op.k === 'tool') as { tool?: number } | undefined;
  const firstTool = firstToolOp?.tool ?? 0;
  const fl0 = firstLayerTemplateVars(layers[0]?.ops as never, Number(cfg.initial_layer_print_height ?? layers[0]?.h ?? 0.2));
  const zone = String(cfg.head_wrap_detect_zone ?? '');
  const tplCommon = { ...fl0.vars, in_head_wrap_detect_zone: !!zone && inZone(zone.split(','), fl0.objects), total_layer_count: layers.length, initial_extruder: firstTool, initial_tool: firstTool, initial_no_support_extruder: firstTool, initial_no_support_tool: firstTool, current_extruder: firstTool,
    initial_no_support_filament_id: firstTool, first_non_support_filaments: [firstTool, -1], first_filaments: [firstTool, -1],
    max_print_z: Math.ceil(layers[layers.length - 1]?.z ?? 0),
    is_extruder_used: (() => {
      const used = new Set([firstTool, ...layers.flatMap((L) => L.ops.flatMap((op) => (op.k === 'tool' ? [(op as { tool?: number }).tool ?? 0] : [])))]);
      const heads = Math.max(filaments.length, Math.round(Number(cfg.toolhead_count ?? 1)) || 1, Math.round(Number(cfg.filament_slots ?? 0)) || 0, ...[...used].map((k) => k + 1));
      return Array.from({ length: heads }, (_, k) => used.has(k));
    })() };
  const macro = (tpl: string, what: string, extra: Record<string, number | string | boolean | number[]> = {}) =>
    vendor ? renderVendor(tpl, cfg, filaments, { ...tplCommon, ...extra }, what) : expandMacro(tpl, cfg, extra as Record<string, string | number>);
  out.push(macro(String(cfg.machine_start_gcode ?? ''), 'Start G-code'));
  if (vendor) out.push(';===== end of start G-code =====');
  if (cfg.pressure_advance !== undefined && cfg.pressure_advance !== '') out.push(flavor === 'klipper' ? `SET_PRESSURE_ADVANCE ADVANCE=${cfg.pressure_advance}` : `M900 K${cfg.pressure_advance}`);
  out.push('G90 ; absolute XYZ');
  out.push('M83 ; relative E');
  out.push('G92 E0');

  let x = 0, y = 0, z = 0, f = 0, fan = -1, accel = -1;
  let elapsed = 0;
  const fmtF = (v: number) => n(v * 60, 0);
  const pushMove = (feature: FeatureType, w: number, h: number, speed: number, t: number) => {
    moves.push(x, y, z, w, h, speed, t, tool);
    feats.push(FEATURE_ORDER.indexOf(feature));
  };

  layers.forEach((L, li) => {
    const moveStart = feats.length;
    out.push(';LAYER_CHANGE');
    out.push(`;Z:${n(L.z)}`);
    out.push(`;HEIGHT:${n(L.h)}`);
    if (flavor !== 'klipper') out.push(`M73 P${Math.floor((elapsed / Math.max(total, 1e-6)) * 100)} R${Math.ceil((total - elapsed) / 60)}`);
    if (vendor && /M73 L|SET_PRINT_STATS_INFO/.test(String(cfg.layer_change_gcode ?? ''))) { /* reported by the maker's template */ }
    else if (flavor === 'bbl') out.push(`M73 L${li + 1}`);
    else if (flavor === 'klipper') out.push(`SET_PRINT_STATS_INFO CURRENT_LAYER=${li + 1}${li === 0 ? ` TOTAL_LAYER=${layers.length}` : ''}`);
    const lc = String(cfg.layer_change_gcode ?? '');
    if (lc) out.push(vendor ? macro(lc, 'Layer change G-code', { layer_num: li, layer_z: L.z, max_layer_z: L.z }) : expandMacro(lc, cfg, { layer_num: li, layer_z: n(L.z) }));
    if (L.temp !== undefined) out.push(`M104 S${L.temp}`);
    if (L.bedTemp !== undefined) out.push(`M140 S${L.bedTemp}`);
    if (L.fan !== fan) {
      fan = L.fan;
      out.push(fan > 0 ? `M106 S${Math.round((fan / 100) * 255)}` : 'M107');
    }
    let curFeature: FeatureType | null = null;
    for (let oi = 0; oi < L.ops.length; oi++) {
      const op = L.ops[oi];
      if (arcs && op.k === 'move' && !op.travel && !op.noArc && op.e > 0 && op.z === z && !isNaN(x)) {
        const fit = fitArc(L.ops, oi, x, y);
        if (fit) {
          if (curFeature !== op.feature) { curFeature = op.feature; out.push(`;TYPE:${op.feature.replace(/_/g, ' ')}`); }
          const last = L.ops[fit.end] as Extract<Op, { k: 'move' }>;
          let e = 0;
          const i0 = fit.cx - x, j0 = fit.cy - y;
          for (let k = oi; k <= fit.end; k++) {
            const m = L.ops[k] as Extract<Op, { k: 'move' }>;
            e += m.e;
            x = m.x; y = m.y;
            const t = m.t ?? 0;
            elapsed += t;
            pushMove(m.feature, m.w, m.h, m.f, t);
            const bf = byFeature[m.feature] ?? (byFeature[m.feature] = { time: 0, filamentMm: 0 });
            bf.time += t; bf.filamentMm += m.e;
          }
          const parts = [fit.cw ? 'G2' : 'G3', `X${n(last.x)}`, `Y${n(last.y)}`, `I${n(i0)}`, `J${n(j0)}`, `E${n(e, 5)}`];
          if (op.f !== f) { parts.push(`F${fmtF(op.f)}`); f = op.f; }
          out.push(parts.join(' '));
          filamentMm += e;
          perFil[tool] += e;
          if (op.feature === 'prime_tower') towerMm += e;
          oi = fit.end;
          continue;
        }
      }
      switch (op.k) {
        case 'raw':
          out.push(op.text);
          if (op.time) elapsed += op.time;
          if (op.resetPos) { x = NaN; y = NaN; z = NaN; f = NaN; accel = -1; }
          break;
        case 'tool':
          if (toolSeen && op.tool !== tool) toolChanges++;
          toolSeen = true;
          tool = op.tool;
          break;
        case 'accel':
          if (op.a !== accel) {
            accel = op.a;
            out.push(flavor === 'klipper' ? `SET_VELOCITY_LIMIT ACCEL=${n(op.a, 0)}` : `M204 S${n(op.a, 0)}`);
          }
          break;
        case 'retract':
          out.push(`G1 E${n(-op.len, 5)} F${fmtF(op.speed)}`);
          filamentMm -= op.len;
          perFil[tool] -= op.len;
          break;
        case 'move': {
          if (!op.travel && curFeature !== op.feature) {
            curFeature = op.feature;
            out.push(`;TYPE:${op.feature.replace(/_/g, ' ')}`);
          }
          const parts = [op.travel ? 'G0' : 'G1'];
          if (op.x !== x) parts.push(`X${n(op.x)}`);
          if (op.y !== y) parts.push(`Y${n(op.y)}`);
          if (op.z !== z) parts.push(`Z${n(op.z)}`);
          if (op.e !== 0) parts.push(`E${n(op.e, 5)}`);
          if (op.f !== f) { parts.push(`F${fmtF(op.f)}`); f = op.f; }
          if (parts.length === 1 || (parts.length === 2 && parts[1].startsWith('F'))) {
            if (parts.length === 2) out.push(parts.join(' '));
            break;
          }
          out.push(parts.join(' '));
          const moved = op.x !== x || op.y !== y || op.z !== z;
          x = op.x; y = op.y; z = op.z;
          filamentMm += op.e;
          perFil[tool] += op.e;
          if (op.feature === 'prime_tower') towerMm += op.e;
          const t = op.t ?? 0;
          elapsed += t;
          if (moved) pushMove(op.travel ? 'travel' : op.feature, op.w, op.h, op.f, t);
          const fk = op.travel ? 'travel' : op.feature;
          const bf = byFeature[fk] ?? (byFeature[fk] = { time: 0, filamentMm: 0 });
          bf.time += t; bf.filamentMm += op.e;
          break;
        }
      }
    }
    layerRes.push({ index: li, z: L.z, height: L.h, moveStart, moveEnd: feats.length, time: layerTimes[li] });
  });

  out.push('M73 P100 R0');
  if (vendor) out.push(';===== NexSpiro end G-code: the printer maker\'s own end G-code follows =====');
  const lastL = layers[layers.length - 1];
  out.push(macro(String(cfg.machine_end_gcode ?? ''), 'End G-code', { layer_num: Math.max(0, layers.length - 1), layer_z: lastL?.z ?? 0, max_layer_z: lastL?.z ?? 0 }));

  const gramsOf = (mm: number, k: number) => {
    const fl = filaments[k] ?? filaments[0];
    return (mm * Math.PI * (fl.diameter / 2) ** 2) / 1000 * fl.density;
  };
  const perFilament = perFil.map((mm, k) => {
    const g = gramsOf(mm, k);
    return { mm, grams: g, cost: (g / 1000) * (filaments[k] ?? filaments[0]).cost };
  });
  const grams = perFilament.reduce((a, b) => a + b.grams, 0);
  const cost = perFilament.reduce((a, b) => a + b.cost, 0);
  void filArea;
  const fmtTime = (s: number) => {
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.round(s % 60);
    return `${h ? h + 'h ' : ''}${m}m ${sec}s`;
  };
  out.push('');
  out.push(`; filament used [cm3] = ${n(filamentMm * filArea / 1000, 2)}`);
  out.push(`; total filament cost = ${n(cost, 2)}`);
  out.push(`; total filament change = ${toolChanges}`);
  const fill = (t: string) => t.replace('__TIME__', fmtTime(total)).replace('__FILMM__', n(filamentMm, 2)).replace('__FILG__', n(grams, 2));
  for (let k = 0; k < Math.min(out.length, 400); k++) out[k] = fill(out[k]);
  const gcode = joinLines(out);

  return {
    gcode,
    moves: new Float32Array(moves),
    moveFeatures: new Uint8Array(feats),
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
