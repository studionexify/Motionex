// Select & apply, slicer side.
//  - filament: a material region before walls are made (the slicer's own multi-material path, so swaps, purge
//    and the prime tower are handled exactly like painted colour)
//  - motion: a Motionex motion limited to the selection (a region with a soft edge)
//  - speed / flow: scaled on every printed move, fading over the blend distance around the selection
//  - temperature: per layer (a hotend needs 10–30 s to settle, so it cannot follow single lines)
// Overlapping rules combine: different kinds of change stack; where two rules set the same thing, the later one wins.
import type { LayerOps, Op } from '../../../engine/gcode';
import type { Paths } from '../../../engine/types';
import { difference, intersection, offset, pointIn, SCALE, union } from '../../../engine/clipper';
import type { PluginContext, PrepareContext, RegionContribution } from '../../api';
import type { PatternexRegion } from '../core/regions';
import type { MotionApplication, MotionBrush } from '../model';
import { featuresOf, ruleActive, targetOk, tunedBrush, type LineGroup, type SelectRule } from './model';
import { piecesAt, stripPolys, weightAt, type Poly } from './geometry';
import { brushAt } from '../modifier';
import { classifyLines, CLASS_IDS, segsOfOps } from './classes';

/** Per layer and op: does each rule's targets take that move? Only for rules with targets. */
export type TargetTest = (rule: SelectRule, layer: number, op: number) => boolean;

/** Measures the lines of the layers (wall numbers, skin numbers, curves) and answers target tests on them. */
export function targetTest(layers: LayerOps[], rules: SelectRule[]): TargetTest | undefined {
  if (!rules.some((r) => ruleActive(r) && r.targets)) return undefined;
  const { segs, opAt, width } = segsOfOps(layers);
  const lc = classifyLines(segs, layers.length, (k) => width[k]);
  return (r, layer, op) => {
    if (!r.targets) return true;
    const s = opAt[layer]?.[op] ?? -1;
    if (s < 0) return false;
    return targetOk(r.targets, CLASS_IDS[lc.cls[s]], lc.rank[s], lc.curved[s] === 1);
  };
}

type Move = Extract<Op, { k: 'move' }>;

/** What prepare() works out for the later passes: where each object is now, and its outline on a layer. */
export interface RuleSession {
  now: Record<string, [number, number]>;
  /** Outline of an object on a layer (plate mm), or null when unknown. */
  outline(layer: number, obj: string): Paths | null;
}

export interface RuleReport {
  /** Moves changed per rule id (speed / flow). */
  moves: Record<string, number>;
  /** Layers given a rule's temperature. */
  tempLayers: number;
}

const toPath = (p: Poly) => p.map(([x, y]) => ({ X: Math.round(x * SCALE), Y: Math.round(y * SCALE) }));
const toPoly = (p: Paths[number]): Poly => p.map((q) => [q.X / SCALE, q.Y / SCALE]);
const num = (cfg: Record<string, unknown>, k: string, d: number) => { const v = parseFloat(String(cfg[k] ?? '')); return Number.isFinite(v) ? v : d; };

/** Bounding box min (x, y) of every object, plate mm. */
export function objectAnchors(meshes: { id: string; vertices: Float32Array }[]): Record<string, [number, number]> {
  const out: Record<string, [number, number]> = {};
  for (const m of meshes) {
    let x = Infinity, y = Infinity;
    for (let k = 0; k < m.vertices.length; k += 3) { if (m.vertices[k] < x) x = m.vertices[k]; if (m.vertices[k + 1] < y) y = m.vertices[k + 1]; }
    if (Number.isFinite(x)) out[m.id] = [x, y];
  }
  return out;
}

/** The part of a cross-section the chosen line kinds are printed in (walls band, inside it, or all). */
function bandOf(slice: Paths, groups: LineGroup[], cfg: Record<string, unknown>): Paths {
  if (!groups.length) return slice;
  const olw = num(cfg, 'outer_wall_line_width', 0) || num(cfg, 'line_width', 0.42);
  const ilw = num(cfg, 'inner_wall_line_width', 0) || num(cfg, 'line_width', 0.42);
  const loops = Math.max(1, Math.round(num(cfg, 'wall_loops', 2)));
  const depth = olw + (loops - 1) * ilw;
  const has = (g: LineGroup) => groups.includes(g);
  const parts: Paths = [];
  if (has('outer')) parts.push(...difference(slice, offset(slice, -olw)));
  if (has('inner') && loops > 1) parts.push(...difference(offset(slice, -olw), offset(slice, -depth)));
  if (has('infill') || has('solid')) parts.push(...offset(slice, -depth));
  return parts.length ? union(parts) : [];
}

export function rulesPrepare(rules: SelectRule[], ctx: PrepareContext): { session: RuleSession; regionsAt?: (o: number, layer: number) => RegionContribution[] } {
  const now = objectAnchors(ctx.meshes);
  const index = new Map(ctx.meshes.map((m, o) => [m.id, o]));
  const cache = new Map<string, Paths>();
  const session: RuleSession = {
    now,
    outline(layer, obj) {
      const o = index.get(obj);
      if (o === undefined) return null;
      const key = `${o}:${layer}`;
      let p = cache.get(key);
      if (!p) { p = offset(ctx.sliceAt(o, layer), 0.5); cache.set(key, p); }
      return p;
    },
  };
  const fil = rules.filter((r) => ruleActive(r) && r.apply.filament !== undefined);
  if (!fil.length) return { session };
  if (fil.some((r) => (r.apply.filament ?? 0) >= ctx.filamentCount))
    ctx.warn(`Select & apply: a selection uses a filament slot this print does not have (${ctx.filamentCount} loaded). Add the filament or pick another.`);
  return {
    session,
    regionsAt(o, layer) {
      const id = ctx.meshes[o]?.id;
      const z = ctx.layerZ[layer], h = ctx.layerH[layer] ?? 0.2;
      const sl = ctx.sliceAt(o, layer);
      if (!sl.length) return [];
      const out: RegionContribution[] = [];
      for (const r of fil) {
        const pieces = piecesAt(r, z, h, now, true).filter((p) => p.zf >= 1 && (!p.obj || p.obj === id));
        if (!pieces.length) continue;
        const band = bandOf(sl, r.lines.filter((g) => g !== 'support'), ctx.cfg);
        if (!band.length) continue;
        let paths: Paths;
        if (pieces.some((p) => !p.polys)) paths = band;
        else {
          const sel = union(pieces.flatMap((p) => p.polys!.map(toPath)));
          paths = intersection(band, sel);
        }
        if (paths.length) out.push({ regionId: `select:${r.id}`, fil: r.apply.filament!, paths });
      }
      return out;
    },
  };
}

/** A rule whose motion was made smaller so it stays clear of the next wall; mm = the largest swing allowed. */
export interface Limited { id: string; name: string; mm: number }
/** Largest side-to-side swing, as a share of the line width, for a motion on some walls only. */
export const CROSS_SHARE = 0.5;

/**
 * Inner walls chosen with a neighbour left out (outer wall off, or from a number past 1 / up to a number). The
 * outer wall alone is not limited: the inner walls follow it (bonding), so it can't run into them.
 */
export function wallsPartial(t: NonNullable<SelectRule['targets']>): boolean {
  const inner = t.inner;
  if (!inner) return false;
  return !t.outer || inner[0] > 1 || inner[1] < 99;
}

function lineWidth(layers: LayerOps[]): number {
  for (const L of layers) for (const op of L.ops) if (op.k === 'move' && !op.travel && (op.feature === 'inner_wall' || op.feature === 'outer_wall') && op.w > 0) return op.w;
  return 0.42;
}

/** Peak side-to-side movement of a motion (mm, before the size slider), over one repeat. */
export function peakLateral(b: MotionBrush): number {
  let m = 0;
  for (let k = 0; k < 96; k++) m = Math.max(m, Math.abs(brushAt({ ...b, layers: null }, (k / 96) * b.period_mm, b.period_mm * 4, 0, b.period_mm)?.lat ?? 0));
  return m;
}

/** Motion rules as Motionex placements on their own regions. Later rules replace earlier motion where they overlap. */
export function ruleMotions(rules: SelectRule[], layers: LayerOps[], s: RuleSession | undefined, brushOf?: (id: string) => MotionBrush | undefined): { apps: MotionApplication[]; regions: PatternexRegion[]; limited: Limited[] } {
  const limited: Limited[] = [];
  const test = targetTest(layers, rules.filter((r) => r.apply.motion));
  const apps: MotionApplication[] = [];
  const regions: PatternexRegion[] = [];
  const big: Poly = [[-1e4, -1e4], [1e4, -1e4], [1e4, 1e4], [-1e4, 1e4]];
  rules.filter((r) => ruleActive(r) && r.apply.motion).forEach((r, k) => {
    const id = `select:${r.id}`;
    const cache = new Map<number, Poly[]>();
    regions.push({
      region_id: id, name: r.name, layer_range: [0, Math.max(0, layers.length - 1)], attributes: { source: 'select' },
      polygon_mask_per_layer(l) {
        let m = cache.get(l);
        if (m) return m;
        const L = layers[l];
        m = [];
        const ps = L ? piecesAt(r, L.z, L.h, s?.now) : [];
        if (L && test && r.targets && ps.length) {
          // only the chosen lines: a thin strip along each stretch of them inside the selection
          const outlines = new Map<string, Paths | null>();
          const inObj = (obj: string, x: number, y: number) => {
            if (!s) return true;
            if (!outlines.has(obj)) outlines.set(obj, s.outline(l, obj));
            const o = outlines.get(obj);
            return !o || pointIn(x, y, o);
          };
          let run: [number, number][] = [], w = 0.42, px = NaN, py = NaN;
          const flush = () => { if (run.length > 1) m!.push(...stripPolys(run, w * 0.45)); run = []; };
          L.ops.forEach((op, k) => {
            if (op.k === 'raw' && op.resetPos) { flush(); px = NaN; return; }
            if (op.k !== 'move') return;
            const ok = !op.travel && op.e > 0 && !Number.isNaN(px) && test(r, l, k)
              && weightAt(ps, r.blend_mm, (px + op.x) / 2, (py + op.y) / 2, op.feature, (obj) => inObj(obj, (px + op.x) / 2, (py + op.y) / 2)) > 0;
            if (ok) { if (!run.length) run.push([px, py]); run.push([op.x, op.y]); w = op.w || w; } else flush();
            px = op.x; py = op.y;
          });
          flush();
        } else if (L) for (const p of ps) {
          if (p.polys) m.push(...p.polys);
          else if (p.obj && s) { const o = s.outline(l, p.obj); if (o) m.push(...o.map(toPoly)); }
          else m.push(big);
        }
        cache.set(l, m);
        return m;
      },
    });
    const g = r.lines;
    const walls = !g.length || (g.includes('outer') && g.includes('inner')) ? 'all' : g.includes('inner') && !g.includes('outer') ? 'inner' : 'outer';
    const p = r.pick;
    const lo = p.kind === 'layers' ? Math.min(p.z0, p.z1) : -1e4, hi = p.kind === 'layers' ? Math.max(p.z0, p.z1) : 1e4;
    const b = Math.max(0, r.blend_mm);
    const base = brushOf?.(r.apply.motion!.brush_id);
    let tuned = base && tunedBrush(r.apply.motion!, base);
    // a motion on some walls but not their neighbours may not swing into the next wall
    if (tuned && r.targets && wallsPartial(r.targets)) {
      const w = lineWidth(layers), cap = w * CROSS_SHARE;
      const peak = peakLateral(tuned) * (r.apply.motion!.scale || 1);
      if (peak > cap) { tuned = { ...tuned, amplitude: tuned.amplitude * (cap / peak) }; limited.push({ id: r.id, name: r.name, mm: cap }); }
    }
    apps.push({
      ...(tuned && tuned !== base ? { brush: tuned } : {}),
      brush_id: r.apply.motion!.brush_id, scale: r.apply.motion!.scale || 1, label: r.name,
      target: { type: 'faces', walls, faces: [id] },
      // with targets the region is a strip along the chosen lines: a wide soft edge would reach the next wall
      mask: { z_start: lo - (p.kind === 'layers' ? b / 2 : 0), z_end: hi + (p.kind === 'layers' ? b / 2 : 0), fade_in_mm: p.kind === 'layers' ? b : 0, fade_out_mm: p.kind === 'layers' ? b : 0, blend_mm: r.targets ? Math.min(b, 0.12) : b },
      order: 1000 + k, blend: k > 0 ? 'override' : 'add', enabled: true,
    });
  });
  return { apps, regions, limited };
}

/** Speed, flow and temperature of the rules, on the finished moves. */
export function applyRulePass(layers: LayerOps[], rules: SelectRule[], ctx: PluginContext, s: RuleSession | undefined): RuleReport {
  const report: RuleReport = { moves: {}, tempLayers: 0 };
  const act = rules.filter((r) => ruleActive(r) && ((r.apply.speed !== undefined && r.apply.speed !== 100) || (r.apply.flow !== undefined && r.apply.flow !== 100) || r.apply.temp !== undefined));
  if (!act.length) return report;
  const feats = act.map((r) => featuresOf(r.lines));
  const test = targetTest(layers, act);
  const baseTemp = num(ctx.cfg, 'nozzle_temperature', 0);
  let tempWasSet = false;
  let px = NaN, py = NaN;
  layers.forEach((L, li) => {
    const layer = L.layer ?? li;
    const pieces = act.map((r) => piecesAt(r, L.z, L.h, s?.now));
    // temperature: the last rule that selects something on this layer, else back to normal after one
    let temp: number | undefined;
    for (const r of act) { if (r.apply.temp !== undefined && piecesAt(r, L.z, L.h, s?.now, true).some((p) => p.zf >= 1)) temp = r.apply.temp; }
    if (temp !== undefined) { L.temp = temp; tempWasSet = true; report.tempLayers++; }
    else if (tempWasSet && L.temp === undefined && baseTemp > 0) { L.temp = baseTemp; tempWasSet = false; }
    const live = act.map((r, k) => ((r.apply.speed ?? 100) !== 100 || (r.apply.flow ?? 100) !== 100) && pieces[k].length > 0);
    if (!live.some(Boolean)) { for (const op of L.ops) if (op.k === 'move') { px = op.x; py = op.y; } else if (op.k === 'raw' && op.resetPos) { px = NaN; py = NaN; } return; }
    const outlines = new Map<string, Paths | null>();
    const inObj = (obj: string, x: number, y: number) => {
      if (!s) return true;
      if (!outlines.has(obj)) outlines.set(obj, s.outline(layer, obj));
      const o = outlines.get(obj);
      return !o || pointIn(x, y, o);
    };
    const step = Math.max(0.4, Math.min(...act.map((r) => r.blend_mm || 2)) / 3);
    const out: Op[] = [];
    for (let oi = 0; oi < L.ops.length; oi++) {
      const op = L.ops[oi];
      if (op.k === 'raw' && op.resetPos) { px = NaN; py = NaN; out.push(op); continue; }
      if (op.k !== 'move') { out.push(op); continue; }
      if (op.travel || op.e <= 0 || Number.isNaN(px)) { px = op.x; py = op.y; out.push(op); continue; }
      const len = Math.hypot(op.x - px, op.y - py);
      // long lines that pass near a selection are cut so the change can fade along them
      const near = act.some((_, k) => live[k] && pieces[k].some((p) => p.box && !(Math.max(px, op.x) < p.box[0] || Math.min(px, op.x) > p.box[2] || Math.max(py, op.y) < p.box[1] || Math.min(py, op.y) > p.box[3])));
      const n = near && len > step ? Math.min(200, Math.ceil(len / step)) : 1;
      const sx = px, sy = py;
      for (let j = 1; j <= n; j++) {
        const t0 = (j - 1) / n, t1 = j / n;
        const mx = sx + (op.x - sx) * (t0 + t1) / 2, my = sy + (op.y - sy) * (t0 + t1) / 2;
        let sf = 1, ff = 1;
        act.forEach((r, k) => {
          if (!live[k] || !feats[k].has(op.feature)) return;
          if (test && r.targets && !test(r, li, oi)) return;
          const w = weightAt(pieces[k], r.blend_mm, mx, my, op.feature, (obj) => inObj(obj, mx, my));
          if (w <= 0) return;
          report.moves[r.id] = (report.moves[r.id] ?? 0) + 1;
          if (r.apply.speed !== undefined) sf = sf * (1 - w) + (r.apply.speed / 100) * w;
          if (r.apply.flow !== undefined) ff = ff * (1 - w) + (r.apply.flow / 100) * w;
        });
        const piece: Move = n === 1 ? op : { ...op, x: sx + (op.x - sx) * t1, y: sy + (op.y - sy) * t1, z: op.z, e: op.e / n, noArc: true };
        if (sf !== 1) { piece.f = Math.max(1, op.f * sf); piece.noArc = true; }
        if (ff !== 1) { piece.e = (n === 1 ? op.e : op.e / n) * ff; piece.noArc = true; }
        out.push(piece);
      }
      px = op.x; py = op.y;
    }
    L.ops = out;
  });
  return report;
}
