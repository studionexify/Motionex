// Hanex engine plugin: runs inside the slicing worker.
//  prepare      — finds every layer of every object with an unsupported region wider than the toolhead
//                 can bridge by itself, and plans its wave toolpath (core/plan.ts)
//  postToolpath — on those layers removes Nexspiro's own extrusion inside the region (bridge infill,
//                 overhang walls) and appends the waves after the rest of the layer, with fan and retraction
import type { EnginePlugin, PluginSession, PrepareContext } from '../api';
import type { Paths } from '../../engine/types';
import { areaTotal, offset, union } from '../../engine/clipper';
import { toPaths } from './core/geom';
import type { LayerOps, Op } from '../../engine/gcode';
import { pointInRings, type Ring } from './core/geom';
import { planLayer } from './core/layer';
import { faceBand, maxWaveFaceAngle, triggerWidth, validateProfile, type HanexProfile } from './core/profile';
import type { RegionPlan } from './core/plan';
import { widthForArea } from '../../engine/advanced/runs';

export interface HanexConfig {
  profile: HanexProfile;
  /** Flat land diameter of the nozzle tip on this printer's toolhead, mm. */
  tipDiameter: number;
  /** Steepest rising underside to wave (wall-to-underside angle, °); undefined = what the toolhead allows. */
  maxFaceAngleDeg?: number;
  /** Ignore overhang components smaller than this, mm². */
  minArea: number;
}

export interface HanexLayerReport { layer: number; z: number; regions: number; arcs: number; area: number; timeS: number }
export interface HanexReport {
  layers: HanexLayerReport[];
  arcs: number;
  area: number;
  timeS: number;
  /** Face-angle limit used for the first layer height, °. */
  maxFaceAngleDeg: number;
  removedMm: number;
  /** Layers with overhang past the face-angle limit (printed normally), with the area in mm². */
  pastLimit: { layer: number; z: number; area: number }[];
  warnings: string[];
}

interface HanexSession extends PluginSession { byLayer: Map<number, RegionPlan[]>; profiles: Map<number, HanexProfile>; blockers: Map<number, Paths>; pastLimit: HanexReport['pastLimit']; warnings: string[]; faceLimit: number }

export const WAVE_FEATURE = 'wave_overhang' as const;

/** Profile for one print: machine values (nozzle, filament, retraction) come from the slicer config. */
export function printProfile(c: HanexConfig, cfg: Record<string, unknown>): HanexProfile {
  const num = (k: string, d: number) => (cfg[k] === undefined || cfg[k] === '' ? d : Number(cfg[k]));
  const nozzle = num('nozzle_diameter', c.profile.toolhead.nozzleDiameter);
  const p = c.profile;
  return {
    ...structuredClone(p),
    toolhead: { nozzleDiameter: nozzle, tipFlatDiameter: Math.max(nozzle, c.tipDiameter) },
    // the profile's line width is for a 0.4 nozzle: scale with the fitted nozzle
    lineWidth: (p.lineWidth / p.toolhead.nozzleDiameter) * nozzle,
    filamentDiameter: num('filament_diameter', p.filamentDiameter),
    retractLength: num('retraction_length', p.retractLength),
    retractSpeed: num('retraction_speed', p.retractSpeed),
    zHop: num('z_hop', p.zHop),
    travelSpeed: Math.min(num('travel_speed', p.travelSpeed), 300),
  };
}

/** Unsupported width that triggers waves at layer height h, honouring a user face-angle limit. */
export function layerTrigger(p: HanexProfile, h: number, maxFaceAngleDeg?: number): number {
  const t = triggerWidth(p);
  if (maxFaceAngleDeg === undefined || maxFaceAngleDeg <= 90) return t;
  return Math.max(t, Math.min(faceBand(maxFaceAngleDeg, h), 1e6) - 1e-9);
}

function prepare(c: HanexConfig, ctx: PrepareContext): HanexSession {
  const base = printProfile(c, ctx.cfg as Record<string, unknown>);
  const warnings: string[] = [];
  for (const e of validateProfile(base)) warnings.push(`Hanex profile: ${e}`);
  const byLayer = new Map<number, RegionPlan[]>();
  const profiles = new Map<number, HanexProfile>();
  const pastArea = new Map<number, number>();
  const N = ctx.layerZ.length;
  for (let o = 0; o < ctx.meshes.length; o++) {
    for (let i = 1; i < N; i++) {
      const cur = ctx.sliceAt(o, i);
      if (!cur.length) continue;
      const below = ctx.sliceAt(o, i - 1);
      const h = ctx.layerH[i];
      const p: HanexProfile = { ...base, sheetHeight: h, triggerWidth: layerTrigger(base, h, c.maxFaceAngleDeg) };
      const res = planLayer(cur, below, p);
      const plans = res.plans.filter((pl) => pl.stats.overhangArea >= c.minArea && pl.moves.length);
      for (const w of res.warnings) warnings.push(`Hanex, layer ${i + 1}: ${w}`);
      const past = areaTotal(res.pastLimit);
      if (past >= c.minArea) pastArea.set(i, (pastArea.get(i) ?? 0) + past);
      if (!plans.length) continue;
      byLayer.set(i, [...(byLayer.get(i) ?? []), ...plans]);
      profiles.set(i, p);
    }
  }
  const faceLimit = c.maxFaceAngleDeg ?? maxWaveFaceAngle(ctx.layerH[1] ?? ctx.layerH[0] ?? 0.2, base);
  const pastLimit = [...pastArea].sort((a, b) => a[0] - b[0]).map(([layer, area]) => ({ layer, z: ctx.layerZ[layer], area }));
  if (pastLimit.length) {
    const first = pastLimit[0], last = pastLimit[pastLimit.length - 1];
    warnings.push(`Hanex: ${pastLimit.length} layer(s) (z ${first.z.toFixed(2)}–${last.z.toFixed(2)} mm) have rising undersides past this print head's ${faceLimit.toFixed(1)}° limit. They print normally and may droop; you can continue.`);
  }
  // keep support from starting under every wave region (a bead's width of margin)
  const blockers = new Map<number, Paths>();
  for (const [i, plans] of byLayer) blockers.set(i, union(offset(union(plans.flatMap((pl) => toPaths(pl.overhangRings))), base.lineWidth)));
  for (const w of new Set(warnings)) ctx.warn(w);
  return {
    byLayer, profiles, blockers, pastLimit, warnings: [...new Set(warnings)], faceLimit,
    supportBlockersAt: (i: number) => blockers.get(i) ?? [],
  };
}

/** Split extrusion moves at the wave regions: inside parts become travel (the waves replace them). */
function stripInside(L: LayerOps, rings: Ring[]): number {
  const out: Op[] = [];
  let x = NaN, y = NaN, removed = 0;
  const inside = (a: number, b: number) => pointInRings(a, b, rings);
  for (const op of L.ops) {
    if (op.k !== 'move') { out.push(op); continue; }
    if (op.travel || op.e <= 0 || isNaN(x)) { out.push(op); x = op.x; y = op.y; continue; }
    const len = Math.hypot(op.x - x, op.y - y);
    const n = Math.max(1, Math.ceil(len / 0.5));
    const flags: boolean[] = [];
    for (let k = 0; k < n; k++) { const t = (k + 0.5) / n; flags.push(inside(x + t * (op.x - x), y + t * (op.y - y))); }
    if (!flags.some(Boolean)) { out.push(op); x = op.x; y = op.y; continue; }
    // emit runs of equal state
    let k = 0;
    while (k < n) {
      let j = k;
      while (j + 1 < n && flags[j + 1] === flags[k]) j++;
      const t = (j + 1) / n;
      const px = x + t * (op.x - x), py = y + t * (op.y - y);
      const share = (j - k + 1) / n;
      if (flags[k]) { out.push({ ...op, x: px, y: py, e: 0, travel: true, feature: 'travel', w: 0 }); removed += len * share; }
      else out.push({ ...op, x: px, y: py, e: op.e * share });
      k = j + 1;
    }
    x = op.x; y = op.y;
  }
  L.ops = out;
  return removed;
}

function postToolpath(layers: LayerOps[], c: HanexConfig, ctx: Parameters<EnginePlugin['postToolpath']>[2]): HanexReport {
  const s = ctx.session as HanexSession | undefined;
  const rep: HanexReport = { layers: [], arcs: 0, area: 0, timeS: 0, maxFaceAngleDeg: s?.faceLimit ?? 90, removedMm: 0, pastLimit: s?.pastLimit ?? [], warnings: s?.warnings ?? [] };
  if (!s) return rep;
  let retracted = false;
  for (let li = 0; li < layers.length; li++) {
    const L = layers[li];
    const plans = s.byLayer.get(li);
    if (plans) rep.removedMm += stripInside(L, plans.flatMap((pl) => pl.overhangRings));
    // retraction state at the end of this layer as Nexspiro left it
    for (const op of L.ops) if (op.k === 'retract') retracted = op.len > 0;
    if (!plans) continue;
    const p = s.profiles.get(li)!;
    const ops: Op[] = [];
    let r = retracted, t = 0;
    const z = L.z, h = L.h;
    const fanPwm = (pct: number) => (pct > 0 ? `M106 S${Math.round((pct / 100) * 255)}` : 'M107');
    ops.push({ k: 'raw', text: '; Hanex wave overhang' }, { k: 'raw', text: `M106 S${Math.round(p.fan)}` });
    let arcs = 0, area = 0;
    for (const pl of plans) {
      arcs += pl.stats.arcs; area += pl.stats.overhangArea;
      for (const m of pl.moves) {
        if (m.kind === 'travel') {
          if (!r && p.retractLength > 0) { ops.push({ k: 'retract', len: p.retractLength, speed: p.retractSpeed }); r = true; }
          const hz = z + p.zHop;
          ops.push({ k: 'move', x: NaN, y: NaN, z: hz, e: 0, f: 10, feature: 'travel', w: 0, h, travel: true, fixed: true });
          ops.push({ k: 'move', x: m.x, y: m.y, z: hz, e: 0, f: m.f, feature: 'travel', w: 0, h, travel: true });
          ops.push({ k: 'move', x: m.x, y: m.y, z, e: 0, f: 10, feature: 'travel', w: 0, h, travel: true, fixed: true });
          continue;
        }
        if (r && p.retractLength > 0) { ops.push({ k: 'retract', len: -p.retractLength, speed: p.retractSpeed }); r = false; }
        // declared bead = the sheet this move lays down (step x sheet height, at the move's flow relative to the print's
        // own flow ratio), so preview and E agree; the sheet is not a layer-height line
        const base = (Number(ctx.cfg.filament_flow_ratio) || 1) * (Number(ctx.cfg.print_flow_ratio) || 1);
        const sh = p.sheetHeight;
        const wDecl = m.area !== undefined ? widthForArea((m.area * m.flow) / base, sh) : p.lineWidth;
        ops.push({ k: 'move', x: m.x, y: m.y, z, e: m.e, f: m.f, feature: WAVE_FEATURE, w: wDecl, h: m.area !== undefined ? sh : h, travel: false, fixed: true });
      }
    }
    // the z-hop lift keeps x/y: fill them in from the previous move
    let px = NaN, py = NaN;
    for (const op of L.ops) if (op.k === 'move') { px = op.x; py = op.y; }
    for (const op of ops) if (op.k === 'move') { if (isNaN(op.x)) { op.x = px; op.y = py; } px = op.x; py = op.y; }
    // leave the extruder in the state Nexspiro expects for the next layer
    if (r !== retracted && p.retractLength > 0) ops.push({ k: 'retract', len: retracted ? p.retractLength : -p.retractLength, speed: p.retractSpeed });
    ops.push({ k: 'raw', text: fanPwm(L.fan) });
    // waves are slow: estimate their time for the report
    let qx = NaN, qy = NaN;
    for (const op of ops) if (op.k === 'move') { if (!isNaN(qx) && !op.travel) t += Math.hypot(op.x - qx, op.y - qy) / op.f; qx = op.x; qy = op.y; }
    L.ops.push(...ops);
    rep.layers.push({ layer: li, z, regions: plans.length, arcs, area, timeS: t });
    rep.arcs += arcs; rep.area += area; rep.timeS += t;
  }
  return rep;
}

export const hanexEngine: EnginePlugin<HanexConfig, HanexReport> = {
  id: 'hanex',
  name: 'Hanex',
  version: '0.1.0',
  prepare,
  postToolpath,
  gcodeHeader: (c) => [`; hanex_profile = ${c.profile.id}`, `; hanex_overlap = ${c.profile.overlap}`, `; hanex_wave_speed = ${c.profile.waveSpeed}`, `; hanex_tip_diameter = ${c.tipDiameter}`],
};
