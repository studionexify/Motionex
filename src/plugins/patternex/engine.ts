// Patternex engine side (spec §6).
// prepare():      Stage A–B — placements → per-layer region masks, handed to Nexspiro before perimeters.
// transition():   Stage D — purge mode per change (full / reduced / none) and the change-point shift.
// postToolpath(): runs after Motionex (§8) — applies change-point shifts, finds bleed zones and swap layers,
//                 and builds the pre-export report.
import type { LayerOps, Op } from '../../engine/gcode';
import { areaTotal, difference, intersection, offset, SCALE } from '../../engine/clipper';
import type { Paths } from '../../engine/types';
import type { Config } from '../../profiles/settings';
import { TRANSITION_MARKER, type EnginePlugin, type ModifierContribution, type PatternexRegion, type PluginSession, type PrepareContext, type RegionContribution, type TransitionPlan } from '../api';
import { placementDepth, type Pattern, type PurgeMode, type RegionAction, type Ring } from './model';
import type { WorldPlacement } from './projection';
import { placementGroups, type GroupResolver } from './resolve';
import { ditherPick, ditherStripes, fuzzMove, inPaths, mergeBands, purgeFirst } from './effects';
import { rng as mulberry } from './library/geom';
import { autoChanges } from '../../profiles/changer';

export type SingleColourPolicy = 'skip' | 'band' | 'allow';

/** Everything the worker needs, as plain data. */
export interface PatternexConfig {
  patterns: Pattern[];
  /** Placements in plate coordinates, with the object index they belong to. */
  placements: WorldPlacement[];
  actions: RegionAction[];
  /** Single-colour printers: what to do with regions that need a swap in the middle of a layer. */
  singleColour: SingleColourPolicy;
  /** mm³ of mixed output when changing without purge, per slot. Missing/null = estimate (uncalibrated). */
  transitionVolume: (number | null | undefined)[];
  /** Regions another plugin (Motionex) targets: shared even when not inked, without a material change. */
  motionTargets?: string[];
  /** Where the purge of a full/reduced change goes besides the tower: the new filament's infill, or a sacrificial object. */
  purgeTarget?: 'tower' | 'infill' | 'object';
  /** Object index (slice order) used as the sacrificial purge object. */
  purgeObject?: number;
  /** Single-colour band mode: base-material gaps shorter than this many layers between same-ink bands are printed in the ink. */
  swapMergeLayers?: number;
}

/** Default transition volume (mm³) when uncalibrated: a typical 0.4 mm hotend melt zone. */
export const DEFAULT_TRANSITION_VOLUME = 45;

export interface SwapEntry { layer: number; z: number; from: number; to: number; label: string }
export interface BleedZone { layer: number; z: number; to: number; lengthMm: number; pts: number[] }
export interface RegionSummary { id: string; placementId: string; color: string; fil: number; layers: [number, number]; layerCount: number; motion: string | null }

export interface PatternexReport {
  regions: RegionSummary[];
  toolChanges: number;
  transitions: Record<PurgeMode, number>;
  purgeMm3: number;
  purgeGrams: number;
  addedTimeS: number;
  /** Single-colour printers: every manual swap in print order. */
  swaps: SwapEntry[];
  manual: boolean;
  bleedZones: BleedZone[];
  unsupported: { regionId: string; layers: number }[];
  uncalibrated: number[];
  shifted: number;
  /** Regions raised or recessed (geometry). */
  reliefs: number;
  /** Purge volume absorbed by infill / the purge object instead of the tower (mm³). */
  purgeAbsorbedMm3: number;
  /** Single-colour band merging: manual swaps removed. */
  swapsSaved: number;
  warnings: string[];
  /** Region outlines per layer (plate mm), capped, for the preview overlay. */
  outlines: { regionId: string; layer: number; rings: Ring[] }[];
}

export const MARKER = TRANSITION_MARKER;

const toRings = (ps: Paths): Ring[] => ps.map((p) => p.map((q) => [q.X / SCALE, q.Y / SCALE] as [number, number]));

interface Group { g: GroupResolver; action: RegionAction; fil: number }
interface ChangeRec { layer: number; from: number; to: number; mode: PurgeMode; volume: number; regionId?: string; credit?: number }
interface Relief { g: GroupResolver; mode: 'raise' | 'recess'; h: number }
interface Fx { g: GroupResolver; speed: number; fuzzy: boolean }

export class PatternexSession implements PluginSession {
  readonly groups: Group[] = [];
  /** Uninked regions that only carry a motion: shared, no material change. */
  readonly motionOnly: GroupResolver[] = [];
  private cache = new Map<string, RegionContribution[]>();
  readonly unsupported = new Map<string, Set<number>>();
  readonly used = new Map<string, Set<number>>();
  readonly changes: ChangeRec[] = [];
  readonly warnings: string[] = [];
  readonly reliefs: Relief[] = [];
  readonly mods: { g: GroupResolver; overrides: Record<string, unknown> }[] = [];
  readonly fx: Fx[] = [];
  /** "layer:tool" → filament volume (mm³) to absorb right after that change. */
  readonly purgeInto = new Map<string, number>();
  private bands = new Map<number, { fil: number[]; region: string[] }>();
  swapsSaved = 0;

  constructor(readonly config: PatternexConfig, readonly ctx: PrepareContext) {
    const patterns = new Map(config.patterns.map((p) => [p.id, p]));
    const clamp = (f: number) => Math.max(0, Math.min(ctx.filamentCount - 1, f | 0));
    for (const p of config.placements) {
      const pat = patterns.get(p.pattern_id);
      if (!pat || !p.visible || p.object < 0 || p.object >= ctx.meshes.length) continue;
      // raised artwork in an ink: the ink fills the whole bump plus the usual depth behind it
      const lift = Math.max(0, ...config.actions.filter((a) => a.region_ref.placement_id === p.id && a.relief?.mode === 'raise' && a.material.mode !== 'keep').map((a) => a.relief!.height_mm));
      const depth = placementDepth(p, ctx.cfg) + lift;
      for (const g of placementGroups(p, pat, depth, ctx)) {
        const action = config.actions.find((a) => a.region_ref.placement_id === p.id && a.region_ref.color_group === g.color)
          ?? config.actions.find((a) => a.region_ref.placement_id === p.id && !a.region_ref.color_group);
        if (!action) {
          // unassigned regions keep the base material; still share them when a motion is aimed at them
          if (config.motionTargets?.includes(g.regionId)) this.motionOnly.push(g);
          continue;
        }
        if (action.relief && action.relief.height_mm > 0) {
          this.reliefs.push({ g, mode: action.relief.mode, h: action.relief.height_mm });
          if (g.flat && action.relief.mode === 'raise') this.warn(`Patternex: ${g.regionId} is on a flat top/bottom face — raised artwork there needs layers above the model; use recess (or ink) instead.`);
        }
        const ef = action.effects;
        if (ef) {
          const ov: Record<string, unknown> = {};
          if (ef.transparency) { ov.sparse_infill_density = 100; }
          else {
            if (ef.infill_density !== undefined) ov.sparse_infill_density = ef.infill_density;
            if (ef.infill_pattern) ov.sparse_infill_pattern = ef.infill_pattern;
          }
          if (Object.keys(ov).length) this.mods.push({ g, overrides: ov });
          const speed = Math.max(0.2, Math.min(1.5, ef.transparency ? Math.min(ef.speed ?? 1, 0.6) : ef.speed ?? 1));
          if (speed !== 1 || ef.fuzzy) this.fx.push({ g, speed, fuzzy: !!ef.fuzzy });
        }
        if (action.material.mode === 'keep') {
          if (config.motionTargets?.includes(g.regionId)) this.motionOnly.push(g);
          continue;
        }
        if (action.dither && !ctx.hasAms && action.dither.mode === 'line')
          this.warn(`Patternex: ${g.regionId} — line dithering needs an AMS; a single-colour printer alternates whole layers instead (one swap per layer).`);
        const fil = clamp(action.material.slot_index);
        if (action.material.slot_index >= ctx.filamentCount)
          this.warn(`Patternex: region ${g.regionId} uses slot ${action.material.slot_index + 1}, but only ${ctx.filamentCount} filament slot(s) are set up.`);
        this.groups.push({ g, action, fil });
      }
    }
  }

  private warn(m: string) { if (!this.warnings.includes(m)) { this.warnings.push(m); this.ctx.warn(m); } }

  regionsAt(object: number, layer: number): RegionContribution[] {
    const key = `${object}:${layer}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const out: RegionContribution[] = [];
    for (const { g, fil } of this.groups) {
      if (g.object !== object) continue;
      let paths = g.at(layer);
      // slivers touching the layer (closing radius / compensated outlines) are not artwork on this layer
      if (!paths.length || Math.abs(areaTotal(paths)) < 0.01) continue;
      if (!this.ctx.hasAms && this.config.singleColour !== 'allow') {
        const slice = this.ctx.sliceAt(object, layer);
        const covers = areaTotal(difference(slice, paths)) < 0.05;
        if (!covers) {
          if (this.config.singleColour === 'skip') {
            let s = this.unsupported.get(g.regionId); if (!s) this.unsupported.set(g.regionId, (s = new Set()));
            s.add(layer);
            continue;
          }
          paths = slice; // layer band fallback
        }
      }
      let u = this.used.get(g.regionId); if (!u) this.used.set(g.regionId, (u = new Set()));
      u.add(layer);
      const d = this.groups.find((x) => x.g === g)!.action.dither;
      if (d && d.ratio > 0) {
        const fb = Math.max(0, Math.min(this.ctx.filamentCount - 1, d.slot_index | 0));
        if (d.mode === 'line' && this.ctx.hasAms) {
          const lw = Number(this.ctx.cfg.outer_wall_line_width) || Number(this.ctx.cfg.line_width) || 0.42;
          const sp = ditherStripes(paths, layer, lw, d.ratio);
          if (sp.a.length) out.push({ regionId: g.regionId, fil, paths: sp.a });
          if (sp.b.length) out.push({ regionId: g.regionId, fil: fb, paths: sp.b });
          continue;
        }
        if (ditherPick(layer, d.ratio)) { out.push({ regionId: g.regionId, fil: fb, paths }); continue; }
      }
      out.push({ regionId: g.regionId, fil, paths });
    }
    // single-colour band merging: short base gaps between bands of the same ink are printed in that ink
    if (!this.ctx.hasAms && this.config.singleColour === 'band' && (this.config.swapMergeLayers ?? 0) > 0 && !out.length) {
      const plan = this.bandPlan(object);
      if (plan.fil[layer] >= 0) out.push({ regionId: plan.region[layer], fil: plan.fil[layer], paths: this.ctx.sliceAt(object, layer) });
    }
    this.cache.set(key, out);
    return out;
  }

  /** Per-layer ink of an object in band mode, with short gaps merged (computed once). */
  private bandPlan(object: number): { fil: number[]; region: string[] } {
    const hit = this.bands.get(object);
    if (hit) return hit;
    const N = this.ctx.layerZ.length;
    const fil: number[] = new Array(N).fill(-1), region: string[] = new Array(N).fill('');
    this.bands.set(object, { fil, region }); // guards against re-entry while computing
    for (let li = 0; li < N; li++) for (const { g, fil: f } of this.groups) {
      if (g.object === object && g.at(li).length) { fil[li] = f; region[li] = g.regionId; }
    }
    const m = mergeBands(fil, this.config.swapMergeLayers ?? 0);
    for (let li = 0; li < N; li++) if (fil[li] < 0 && m.seq[li] >= 0) { region[li] = region[li - 1] || region[li + 1]; }
    this.swapsSaved += m.swapsBefore - m.swapsAfter;
    const plan = { fil: m.seq, region };
    this.bands.set(object, plan);
    return plan;
  }

  reshape(object: number, layer: number, slice: Paths): Paths {
    let acc = slice;
    for (const r of this.reliefs) {
      if (r.g.object !== object) continue;
      const next = r.g.relief(layer, acc, r.mode, r.h);
      if (next) acc = next;
    }
    return acc;
  }

  modifiersAt(object: number, layer: number): ModifierContribution[] {
    const out: ModifierContribution[] = [];
    for (const m of this.mods) {
      if (m.g.object !== object) continue;
      const paths = m.g.at(layer);
      if (paths.length) out.push({ overrides: m.overrides, paths });
    }
    return out;
  }

  /** Filament volume (mm³) the new filament can print into infill / the purge object on this layer. */
  private purgeCredit(layer: number, to: number): number {
    const target = this.config.purgeTarget ?? 'tower';
    if (target === 'tower' || !this.ctx.hasAms) return 0;
    const cfg = this.ctx.cfg;
    const h = this.ctx.layerH[layer] ?? 0.2;
    const lw = Number(cfg.inner_wall_line_width) || Number(cfg.line_width) || 0.42;
    const walls = Math.max(1, Number(cfg.wall_loops) || 2) * lw;
    const dens = (o: number) => Number(this.ctx.meshes[o]?.overrides?.sparse_infill_density ?? cfg.sparse_infill_density ?? 15) / 100;
    const N = this.ctx.layerZ.length;
    const shellT = Math.max(0, Number(cfg.top_shell_layers) || 0), shellB = Math.max(0, Number(cfg.bottom_shell_layers) || 0);
    if (target === 'object') {
      const o = this.config.purgeObject ?? -1;
      if (o < 0 || o >= this.ctx.meshes.length) return 0;
      const sl = this.ctx.sliceAt(o, layer);
      const all = areaTotal(sl), inner = areaTotal(offset(sl, -walls));
      return (Math.max(0, all - inner) + inner * dens(o)) * h;
    }
    let v = 0;
    for (let o = 0; o < this.ctx.meshes.length; o++) {
      // only objects whose base material is the new filament have its infill on this layer
      const regs = this.regionsAt(o, layer);
      if (regs.some((r) => r.fil === to) || (this.ctx.meshes[o].filament ?? 0) !== to) continue;
      if (layer - shellB < 0 || layer + shellT > N - 1) continue;
      let interior = offset(this.ctx.sliceAt(o, layer), -walls);
      interior = intersection(intersection(interior, this.ctx.sliceAt(o, layer + shellT)), this.ctx.sliceAt(o, layer - shellB));
      v += areaTotal(interior) * h * dens(o);
    }
    return v;
  }

  transition(t: { layer: number; from: number; to: number; flushVolume?: number }): TransitionPlan | undefined {
    if (!this.groups.length || t.from === t.to) return undefined; // first load, not a change
    const here: { r: RegionContribution; action: RegionAction }[] = [];
    for (let o = 0; o < this.ctx.meshes.length; o++) for (const r of this.regionsAt(o, t.layer)) {
      const g = this.groups.find((x) => x.g.regionId === r.regionId);
      if (g) here.push({ r, action: g.action });
    }
    const pick = here.find((h) => h.r.fil === t.to) ?? here.find((h) => h.r.fil === t.from);
    let base = t.flushVolume ?? 0;
    // purge into infill / a sacrificial object: what the new filament prints there first replaces tower purge
    const credit = Math.min(base, this.purgeCredit(t.layer, t.to) * 0.9);
    if (credit > 0) { this.purgeInto.set(`${t.layer}:${t.to}`, credit); base -= credit; }
    if (!pick) {
      this.changes.push({ layer: t.layer, from: t.from, to: t.to, mode: 'full', volume: base, credit });
      if (credit > 0) return { flushVolume: base };
      return this.ctx.hasAms ? undefined : { label: `filament ${t.to + 1}` };
    }
    const pu = pick.action.purge;
    const rec: ChangeRec = { layer: t.layer, from: t.from, to: t.to, mode: pu.mode, volume: base, regionId: pick.r.regionId, credit };
    let plan: TransitionPlan = { regionId: pick.r.regionId, ...(credit > 0 ? { flushVolume: base } : {}) };
    const target = this.groups.find((g) => g.fil === t.to)?.action.material;
    if (!this.ctx.hasAms) plan.label = target?.swap_label || `filament ${t.to + 1}`;
    if (pu.mode === 'reduced') { rec.volume = Math.max(0, pu.volume_mm3 ?? base / 2); plan = { ...plan, flushVolume: rec.volume }; }
    else if (pu.mode === 'none') {
      rec.volume = 0;
      rec.credit = 0;
      this.purgeInto.delete(`${t.layer}:${t.to}`);
      // the shift places the bleed; it is relative to entering the region, so leaving it mirrors it
      const shift = pu.change_point_shift_mm || 0;
      plan = { ...plan, flushVolume: 0, skipTower: true, shiftMm: pick.r.fil === t.to ? shift : -shift };
    }
    this.changes.push(rec);
    return plan;
  }

  sharedRegions(): PatternexRegion[] {
    return this.groups.map(({ g, action, fil }): PatternexRegion => ({
      region_id: g.regionId,
      name: g.regionId,
      layer_range: g.layerRange,
      polygon_mask_per_layer: (l: number) => toRings(this.regionsAt(g.object, l).filter((r) => r.regionId === g.regionId).flatMap((r) => r.paths)),
      attributes: { source: 'patternex', placement_id: g.placementId, color: g.color, material: fil, motion: action.motion?.motionex_brush_id ?? null },
    })).concat(this.motionOnly.map((g) => ({
      region_id: g.regionId,
      name: g.regionId,
      layer_range: g.layerRange,
      polygon_mask_per_layer: (l: number) => toRings(g.at(l)),
      attributes: { source: 'patternex', placement_id: g.placementId, color: g.color, material: null, motion: null },
    })));
  }
}

// ---------- change-point shift (post-pass on the final move list)
type Move = Extract<Op, { k: 'move' }>;
const isExtrude = (op: Op): op is Move => op.k === 'move' && !op.travel && op.e > 0;

/** Position before ops[i] (end of the last move before it), or null when unknown. */
function posBefore(ops: Op[], i: number): [number, number, number] | null {
  for (let k = i - 1; k >= 0; k--) {
    const op = ops[k];
    if (op.k === 'move') return [op.x, op.y, op.z];
    if (op.k === 'raw' && op.resetPos) return null;
  }
  return null;
}

/** Split move m (from start s) at length `at` from its start: returns [first, second]. */
function splitMove(m: Move, s: [number, number, number], at: number): [Move, Move] {
  const len = Math.hypot(m.x - s[0], m.y - s[1], m.z - s[2]) || 1;
  const f = Math.max(0, Math.min(1, at / len));
  const px = s[0] + (m.x - s[0]) * f, py = s[1] + (m.y - s[1]) * f, pz = s[2] + (m.z - s[2]) * f;
  return [{ ...m, x: px, y: py, z: pz, e: m.e * f, t: undefined, noArc: true }, { ...m, e: m.e * (1 - f), t: undefined, noArc: true }];
}

interface ShiftParams { retract: number; retractSpeed: number; deretractSpeed: number; travelF: number }

/** Returns true when the change point moved. `marker` is the index of the marker op. */
export function applyShift(ops: Op[], marker: number, shift: number, p: ShiftParams): boolean {
  if (Math.abs(shift) < 1e-3) return false;
  const toolIdx = ops.findIndex((op, k) => k > marker && op.k === 'tool');
  if (toolIdx < 0) return false;
  const travel = (x: number, y: number, z: number, h: number): Move => ({ k: 'move', x, y, z, e: 0, f: p.travelF, feature: 'travel', w: 0, h, travel: true });
  // is the nozzle expected to be retracted right after the change? (slicer deretracts before the next extrusion)
  const firstNew = ops.findIndex((op, k) => k > toolIdx && isExtrude(op));
  if (firstNew < 0) return false;
  const retractedAfter = ops.slice(toolIdx + 1, firstNew).some((op) => op.k === 'retract' && op.len < 0);

  if (shift > 0) {
    // the last `shift` mm before the change are printed with the new filament
    let k = marker - 1;
    while (k >= 0 && ops[k].k === 'accel') k--;
    if (k < 0 || !isExtrude(ops[k])) return false;
    const run: number[] = [];
    while (k >= 0 && (isExtrude(ops[k]) || ops[k].k === 'accel')) { if (isExtrude(ops[k])) run.unshift(k); k--; }
    let acc = 0, cut = -1, cutAt = 0;
    for (let r = run.length - 1; r >= 0; r--) {
      const s = posBefore(ops, run[r]);
      if (!s) return false;
      const m = ops[run[r]] as Move;
      const l = Math.hypot(m.x - s[0], m.y - s[1], m.z - s[2]);
      if (acc + l >= shift) { cut = r; cutAt = l - (shift - acc); break; }
      acc += l;
    }
    if (cut < 0) cut = 0, cutAt = 0; // shift longer than the run: move all of it
    const ci = run[cut];
    const s0 = posBefore(ops, ci)!;
    const [keep, rest] = splitMove(ops[ci] as Move, s0, cutAt);
    const tail: Move[] = [rest, ...run.slice(cut + 1).map((i) => ops[i] as Move)];
    const start: [number, number, number] = [keep.x, keep.y, keep.z];
    // remove the tail from before the change
    const removeFrom = ci + 1, removeTo = run[run.length - 1];
    const block: Op[] = [travel(start[0], start[1], start[2], rest.h)];
    if (retractedAfter) block.push({ k: 'retract', len: -p.retract, speed: p.deretractSpeed });
    block.push(...tail);
    if (retractedAfter) block.push({ k: 'retract', len: p.retract, speed: p.retractSpeed });
    ops.splice(toolIdx + 1, 0, ...block);
    ops.splice(removeFrom, removeTo - removeFrom + 1);
    if (cutAt > 1e-6) ops[ci] = keep; else ops.splice(ci, 1);
    return true;
  }

  // shift < 0: the first |shift| mm after the change are printed with the old filament
  const need = -shift;
  const run: number[] = [];
  for (let k = firstNew; k < ops.length && (isExtrude(ops[k]) || ops[k].k === 'accel'); k++) if (isExtrude(ops[k])) run.push(k);
  const s0 = posBefore(ops, firstNew);
  if (!s0) return false;
  let acc = 0, cut = run.length - 1, cutAt = Infinity;
  for (let r = 0; r < run.length; r++) {
    const s = posBefore(ops, run[r])!;
    const m = ops[run[r]] as Move;
    const l = Math.hypot(m.x - s[0], m.y - s[1], m.z - s[2]);
    if (acc + l >= need) { cut = r; cutAt = need - acc; break; }
    acc += l;
  }
  const ci = run[cut];
  const sc = posBefore(ops, ci)!;
  const whole = cutAt === Infinity;
  const [head, rest] = whole ? [ops[ci] as Move, null] : splitMove(ops[ci] as Move, sc, cutAt);
  const headMoves: Move[] = [...run.slice(0, cut).map((i) => ops[i] as Move), head];
  // the new filament now starts where the head ends: retarget the travel that led to the run
  const end = headMoves[headMoves.length - 1];
  if (rest) ops[ci] = rest; else ops.splice(ci, 1);
  for (let r = cut - 1; r >= 0; r--) ops.splice(run[r], 1);
  for (let k = firstNew - 1; k > toolIdx; k--) {
    const op = ops[k];
    if (op.k === 'move' && op.travel) { ops[k] = { ...op, x: end.x, y: end.y }; break; }
  }
  const before = marker > 0 ? ops[marker - 1] : undefined;
  const block: Op[] = [];
  const wasPrinting = !!before && isExtrude(before);
  if (wasPrinting) block.push({ k: 'retract', len: p.retract, speed: p.retractSpeed });
  block.push(travel(s0[0], s0[1], s0[2], head.h));
  block.push({ k: 'retract', len: -p.retract, speed: p.deretractSpeed });
  block.push(...headMoves.map((m) => ({ ...m, t: undefined, noArc: true })));
  if (!wasPrinting) block.push({ k: 'retract', len: p.retract, speed: p.retractSpeed });
  ops.splice(marker, 0, ...block);
  return true;
}

/** First `len` mm printed after ops[from] (a tool op), as a flat xy polyline. */
function zoneAfter(ops: Op[], from: number, len: number): { pts: number[]; got: number } {
  const pts: number[] = [];
  let got = 0;
  for (let k = from + 1; k < ops.length && got < len; k++) {
    const op = ops[k];
    if (op.k === 'tool') break;
    if (!isExtrude(op)) continue;
    const s = posBefore(ops, k);
    if (!s) continue;
    const l = Math.hypot(op.x - s[0], op.y - s[1]);
    if (!pts.length || pts[pts.length - 2] !== s[0] || pts[pts.length - 1] !== s[1]) pts.push(s[0], s[1]);
    if (got + l > len) { const f = (len - got) / l; pts.push(s[0] + (op.x - s[0]) * f, s[1] + (op.y - s[1]) * f); got = len; break; }
    pts.push(op.x, op.y);
    got += l;
  }
  return { pts, got };
}

const OUTLINE_POINT_CAP = 200_000;

export function buildReport(layers: LayerOps[], config: PatternexConfig, cfg: Config, s: PatternexSession | undefined, hasAms: boolean, filColors: string[] = []): PatternexReport {
  const num = (k: string, d = 0) => (cfg[k] === undefined || cfg[k] === '' ? d : Number(cfg[k]));
  const rep: PatternexReport = {
    regions: [], toolChanges: 0, transitions: { full: 0, reduced: 0, none: 0 }, purgeMm3: 0, purgeGrams: 0, addedTimeS: 0,
    swaps: [], manual: !hasAms, bleedZones: [], unsupported: [], uncalibrated: [], shifted: 0, reliefs: 0, purgeAbsorbedMm3: 0, swapsSaved: 0, warnings: [], outlines: [],
  };
  if (!s) return rep;
  const tv = (slot: number) => config.transitionVolume[slot] ?? DEFAULT_TRANSITION_VOLUME;
  const shift: ShiftParams = {
    retract: num('retraction_length', 0.8), retractSpeed: num('retraction_speed', 30), deretractSpeed: num('deretraction_speed') || num('retraction_speed', 30),
    travelF: num('travel_speed', 200),
  };
  // 1) change-point shifts, applied on the final move list (after Motionex changed path lengths)
  layers.forEach((L) => {
    for (let k = 0; k < L.ops.length; k++) {
      const op = L.ops[k];
      if (op.k !== 'raw' || !op.text.startsWith(MARKER)) continue;
      const m = / shift=(-?[\d.]+)/.exec(op.text);
      if (m && applyShift(L.ops, k, Number(m[1]), shift)) rep.shifted++;
    }
  });
  // 2) tool changes, swaps and bleed zones
  let tool = -1;
  layers.forEach((L, li) => {
    let pendingNone = false;
    for (let k = 0; k < L.ops.length; k++) {
      const op = L.ops[k];
      if (op.k === 'raw' && op.text.startsWith(MARKER)) pendingNone = / mode=none/.test(op.text);
      if (op.k !== 'tool') continue;
      if (tool >= 0 && op.tool !== tool) {
        rep.toolChanges++;
        if (!hasAms) {
          const action = s.groups.find((g) => g.fil === op.tool)?.action;
          const label = action?.material.swap_label || filColors[op.tool] || `Filament ${op.tool + 1}`;
          rep.swaps.push({ layer: li, z: L.z, from: tool, to: op.tool, label });
        }
        if (pendingNone) {
          const move = L.ops.slice(k + 1).find(isExtrude);
          const w = move?.w || num('line_width', 0.42), h = move?.h || L.h;
          const want = tv(op.tool) / Math.max(w * h, 1e-3);
          const z = zoneAfter(L.ops, k, want);
          if (z.pts.length >= 4 && rep.bleedZones.length < 5000) rep.bleedZones.push({ layer: li, z: L.z, to: op.tool, lengthMm: z.got, pts: z.pts });
        }
      }
      pendingNone = false;
      tool = op.tool;
    }
  });
  // 3) totals
  for (const c of s.changes) {
    rep.transitions[c.mode]++;
    rep.purgeMm3 += c.volume;
    if (c.mode === 'none' && config.transitionVolume[c.to] == null && !rep.uncalibrated.includes(c.to)) rep.uncalibrated.push(c.to);
  }
  rep.purgeGrams = (rep.purgeMm3 / 1000) * num('filament_density', 1.24);
  rep.addedTimeS = rep.toolChanges * num('filament_change_time', hasAms ? 60 : 0);
  for (const { g, action, fil } of s.groups) {
    const used = [...(s.used.get(g.regionId) ?? [])].sort((a, b) => a - b);
    rep.regions.push({ id: g.regionId, placementId: g.placementId, color: g.color, fil, layers: used.length ? [used[0], used[used.length - 1]] : [0, -1], layerCount: used.length, motion: action.motion?.motionex_brush_id ?? null });
  }
  for (const [regionId, ls] of s.unsupported) rep.unsupported.push({ regionId, layers: ls.size });
  rep.reliefs = s.reliefs.length;
  rep.swapsSaved = s.swapsSaved;
  // 4) messages
  if (rep.unsupported.length)
    rep.warnings.push(`Single-colour printer: ${rep.unsupported.length} region(s) need a colour swap in the middle of a layer and were left in the base colour. Switch to layer bands or allow mid-layer swaps to print them.`);
  if (!hasAms && config.singleColour === 'allow' && rep.swaps.length > 20)
    rep.warnings.push(`Single-colour printer: ${rep.swaps.length} manual swaps — consider layer bands.`);
  if (rep.uncalibrated.length)
    rep.warnings.push(`No-purge transitions use an estimated (uncalibrated) bleed volume for slot(s) ${rep.uncalibrated.map((k) => k + 1).join(', ')}.`);
  if (rep.regions.length && rep.regions.every((r) => !r.layerCount))
    rep.warnings.push('Patternex: no placement reaches the model — check the projection direction and depth.');
  rep.warnings.push(...s.warnings);
  // 5) outlines for the preview
  let budget = OUTLINE_POINT_CAP;
  outer: for (const { g } of s.groups) for (const li of [...(s.used.get(g.regionId) ?? [])].sort((a, b) => a - b)) {
    const rings = toRings(s.regionsAt(g.object, li).filter((r) => r.regionId === g.regionId).flatMap((r) => r.paths));
    budget -= rings.reduce((a, r) => a + r.length, 0);
    if (budget < 0) break outer;
    rep.outlines.push({ regionId: g.regionId, layer: li, rings });
  }
  return rep;
}

export const patternexEngine: EnginePlugin<PatternexConfig, PatternexReport> = {
  id: 'patternex',
  name: 'Patternex',
  version: '1.0.0',
  prepare(config, ctx) {
    if (!config.placements.length) return undefined;
    return new PatternexSession(config, ctx);
  },
  postToolpath(layers, config, ctx) {
    const s = ctx.session as PatternexSession | undefined;
    const absorbed = s ? applyPurgeTargets(layers, config, ctx.cfg, s) : 0;
    if (s) applyRegionEffects(layers, ctx.cfg, s);
    const rep = buildReport(layers, config, ctx.cfg, s, autoChanges(ctx.cfg));
    rep.purgeAbsorbedMm3 = absorbed;
    for (const w of rep.warnings) if (!s?.warnings.includes(w)) ctx.warn(w);
    return rep;
  },
  gcodeHeader(config) {
    return config.placements.filter((p) => p.visible).map((p) => {
      const n = config.actions.filter((a) => a.region_ref.placement_id === p.id).length;
      return `; patternex: ${p.pattern_id} ${p.projection} on object ${p.object}, ${n} region action(s)${p.through ? ', through' : ''}`;
    });
  },
};

/** Purge into infill / a sacrificial object: after each change that got credit, print those moves first. */
export function applyPurgeTargets(layers: LayerOps[], config: PatternexConfig, cfg: Config, s: PatternexSession): number {
  if (!s.purgeInto.size) return 0;
  const num = (k: string, d = 0) => (cfg[k] === undefined || cfg[k] === '' ? d : Number(cfg[k]));
  const fa = Math.PI * (num('filament_diameter', 1.75) / 2) ** 2;
  const retract = { len: num('retraction_length', 0.8), speed: num('retraction_speed', 30), deretractSpeed: num('deretraction_speed') || num('retraction_speed', 30), afterChange: autoChanges(cfg) };
  let total = 0;
  layers.forEach((L, li) => {
    for (let k = 0; k < L.ops.length; k++) {
      const op = L.ops[k];
      if (op.k !== 'tool') continue;
      const want = s.purgeInto.get(`${li}:${op.tool}`);
      if (!want) continue;
      const target = config.purgeTarget;
      const obj = target === 'object' ? s.ctx.sliceAt(config.purgeObject ?? -1, li) : [];
      const take = (ms: Move[]) => target === 'infill' ? ms.every((m) => m.feature === 'sparse_infill') : obj.length > 0 && inPaths(obj, ms[0].x, ms[0].y);
      const e = purgeFirst(L.ops, k, take, retract, want / fa);
      total += e * fa;
    }
  });
  return total;
}

/** Speed and fuzzy skin inside regions (multi- and single-colour alike). */
export function applyRegionEffects(layers: LayerOps[], cfg: Config, s: PatternexSession): void {
  if (!s.fx.length) return;
  const thick = Number(cfg.fuzzy_skin_thickness) || 0.3, dist = Number(cfg.fuzzy_skin_point_distance) || 0.8;
  const rnd = mulberry(7);
  layers.forEach((L, li) => {
    const masks = s.fx.map((f) => ({ f, paths: f.g.at(li) })).filter((m) => m.paths.length);
    if (!masks.length) return;
    let x = NaN, y = NaN;
    const out: Op[] = [];
    for (const op of L.ops) {
      if (op.k === 'raw' && op.resetPos) { x = NaN; y = NaN; }
      if (op.k !== 'move') { out.push(op); continue; }
      if (op.travel || op.e <= 0 || !isFinite(x)) { out.push(op); x = op.x; y = op.y; continue; }
      const mx = (x + op.x) / 2, my = (y + op.y) / 2;
      const hit = masks.find((m) => m.f.g.object >= 0 && inPaths(m.paths, mx, my));
      if (!hit) { out.push(op); x = op.x; y = op.y; continue; }
      let ms: Move[] = [{ ...op, f: op.f * hit.f.speed, t: hit.f.speed !== 1 ? undefined : op.t }];
      if (hit.f.fuzzy && op.feature === 'outer_wall') ms = fuzzMove(ms[0], [x, y], thick, dist, rnd);
      out.push(...ms);
      x = op.x; y = op.y;
    }
    L.ops = out;
  });
}
