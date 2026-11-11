// Weave mode inside the slicer.
// prepare(): every woven layer gets its filament (the colours take turns layer by layer) through a
//            plugin region covering the whole cross-section, and each filament change gets the chosen
//            purge: full, reduced, or none at all (bleed: the new colour prints straight away).
// pass():    after toolpaths are made, each outer wall loop is pushed out where the picture shows that
//            layer's colour and pulled in where it doesn't, starts on the chosen seam line, and its start
//            and end are tucked inside the wall (lead-in from inside, tail and wipe going inside).
import type { Config } from '../../../profiles/settings';
import type { LayerOps, Op } from '../../../engine/gcode';
import type { Paths } from '../../../engine/types';
import { offset, pointIn } from '../../../engine/clipper';
import { objectMask } from '../wall/targets';
import type { PluginSession, PrepareContext, RegionContribution, TransitionPlan } from '../../api';
import { cycleLayers, type WeaveSettings } from './model';
import { maxAccelOf, minMoveMm, outerLineWidth } from '../wall/machine';
import { filamentAt, inBand, offsetAt, planLayers, signedArea, weaveLoop, type Pt, type WovenPoint } from './core';
import { collectZones, type WaveZone } from './zones';
import { WaveField } from './wave';
import { limitCornerSpeeds } from '../modifier';
import type { ToolpathPoint } from '../core/types';

type Move = Extract<Op, { k: 'move' }>;
const OUTER = new Set(['outer_wall', 'overhang_wall']);

export interface WeaveReport {
  wovenLayers: number;
  loops: number;
  /** Filament changes the weave asks for. */
  changes: number;
  /** Seams tucked inside the wall. */
  seamsTucked: number;
  columns: number;
  rows: number;
  /** Largest in-out step from one layer to the next (mm), against the line width. */
  swing: number;
  lineWidth: number;
  /** The wave texture, when one was used. */
  wave?: WaveReport;
}

export interface WaveReport {
  /** Layers with a wave. */
  layers: number;
  /** Zones (modifier shapes, height bands) found, and how many changed some loop. */
  zones: number;
  zonesUsed: number;
  /** Largest step between a layer's line and the one below where the wave is (mm, measured). */
  swing: number;
  /** Shortest stitch (mm). */
  stitch: number;
  /** Loops where ribs or sharp edges were kept smooth. */
  edgeLoops: number;
  /** Times the stitch count round a loop was re-picked as the part grew or shrank. */
  repicks: number;
}

export interface WeaveSession extends PluginSession {
  weave: {
    targets: (o: number) => boolean; maskAt(layer: number): Paths | null;
    /** Wave zones (modifier shapes and height bands with a wave), sliced at `planes`. */
    zones?: WaveZone[];
    planes?: number[];
    /** Is (x, y) on object o at layer i? */
    onObject?: (o: number, layer: number, x: number, y: number) => boolean;
  };
}

const num = (cfg: Config, k: string, d: number) => { const v = parseFloat(String(cfg[k] ?? '')); return Number.isFinite(v) ? v : d; };

/** Region and transition hooks for weave mode (colour mode needs them; mono only the target mask). */
export function weaveSession(w: WeaveSettings, ctx: PrepareContext): WeaveSession {
  const mask = objectMask(w.objects, ctx);
  const targets = mask.targets;
  const outlines = new Map<string, Paths>();
  const onObject = (o: number, layer: number, x: number, y: number) => {
    const k = `${o}|${layer}`;
    let m = outlines.get(k);
    if (!m) { m = offset(ctx.sliceAt(o, layer), 0.8); outlines.set(k, m); }
    return pointIn(x, y, m);
  };
  const session: WeaveSession = { weave: { ...mask, zones: collectZones(ctx.meshes, ctx.planes), planes: ctx.planes, onObject } };
  if (w.mode !== 'colour' || w.slots.length < 2) return session;
  const usable = w.slots.every((s) => s >= 0 && s < ctx.filamentCount);
  if (!usable) { ctx.warn(`Weave: the picture uses filament slots ${w.slots.map((s) => s + 1).join(', ')} but this print has ${ctx.filamentCount}. Add the missing filaments.`); return session; }
  if (!ctx.hasAms) ctx.warn('Weave: this printer changes filament by hand, so every layer is a manual change. Use a printer with a filament unit (AMS) or a tool changer for colour weave, or mono relief.');
  if (ctx.changer === 'toolchanger' && Math.max(...w.slots) + 1 > (ctx.toolheads ?? 1)) ctx.warn(`Weave: colour slots ${w.slots.map((s) => s + 1).join(', ')} need ${Math.max(...w.slots) + 1} heads, the tool changer has ${ctx.toolheads}. Pick colours from slots 1–${ctx.toolheads}.`);
  session.regionsAt = (o, layer): RegionContribution[] => {
    if (!targets(o)) return [];
    const paths = ctx.sliceAt(o, layer);
    return paths.length ? [{ regionId: 'motionex-weave', fil: filamentAt(w, ctx.layerZ, layer), paths }] : [];
  };
  session.transition = (t): TransitionPlan | undefined => {
    if (!inBand(w, ctx.layerZ[t.layer] ?? -1) || !w.slots.includes(t.to)) return undefined;
    if (w.change.mode === 'bleed') return { flushVolume: 0, skipTower: true, regionId: 'motionex-weave' };
    if (w.change.mode === 'reduced') return { flushVolume: Math.max(0, w.change.volume_mm3), regionId: 'motionex-weave' };
    return { regionId: 'motionex-weave' };
  };
  return session;
}

/** A closed outer wall loop found in a layer's moves. */
interface Loop {
  start: number; end: number;
  pts: Pt[];
  /** Feature of each segment pts[i] → pts[i + 1]. */
  feat: Move['feature'][];
  f: number[];
  z: number; w: number; h: number;
  ePerMm: number;
  area: number;
}

function findLoops(L: LayerOps): Loop[] {
  const out: Loop[] = [];
  let last: { x: number; y: number } | null = null;
  let i = 0;
  const ops = L.ops;
  while (i < ops.length) {
    const op = ops[i];
    if (op.k === 'raw' && op.resetPos) { last = null; i++; continue; }
    if (op.k !== 'move') { i++; continue; }
    if (op.travel || op.e <= 0 || !last || !OUTER.has(op.feature)) { last = { x: op.x, y: op.y }; i++; continue; }
    const pts: Pt[] = [{ ...last }], feat: Move['feature'][] = [], f: number[] = [];
    let j = i, e = 0, len = 0, z = op.z;
    while (j < ops.length) {
      const m = ops[j];
      if (m.k !== 'move' || m.travel || m.e <= 0 || !OUTER.has(m.feature)) break;
      const p = pts[pts.length - 1];
      len += Math.hypot(m.x - p.x, m.y - p.y);
      e += m.e;
      pts.push({ x: m.x, y: m.y }); feat.push(m.feature); f.push(m.f);
      z = Math.max(z, m.z);
      j++;
    }
    const a = pts[0], b = pts[pts.length - 1];
    if (pts.length > 3 && Math.hypot(a.x - b.x, a.y - b.y) < Math.max(0.1, 1.5 * op.w) && len > 1) {
      pts.pop();
      out.push({ start: i, end: j, pts, feat, f, z, w: op.w, h: op.h, ePerMm: e / len, area: signedArea(pts) });
    }
    last = { x: b.x, y: b.y };
    i = j;
  }
  return out;
}

/** Loops that sit inside a bigger loop of the same layer are holes (the inside of a tube): left alone. */
function outermost(loops: Loop[]): Loop[] {
  return loops.filter((l) => !loops.some((o) => o !== l && Math.abs(o.area) > Math.abs(l.area) && inside(l.pts[0], o.pts)));
}
function inside(p: Pt, poly: Pt[]): boolean {
  let r = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) r = !r;
  }
  return r;
}
const perimeter = (p: Pt[]) => p.reduce((s, q, i) => s + Math.hypot(p[(i + 1) % p.length].x - q.x, p[(i + 1) % p.length].y - q.y), 0);

/** The weave pass over the finished move list. Edits layers in place. */
export function applyWeave(layers: LayerOps[], w: WeaveSettings, cfg: Config, session: WeaveSession | undefined, warn: (m: string) => void): WeaveReport {
  const lw = outerLineWidth(cfg);
  const rep: WeaveReport = { wovenLayers: 0, loops: 0, changes: 0, seamsTucked: 0, columns: w.image.w * Math.max(1, w.tiles_around), rows: w.image.h, swing: 0, lineWidth: lw };
  if (cfg.spiral_mode === true || cfg.spiral_mode === 'true') { warn('Weave: spiral vase is on. Turn it off: weave needs one closed loop per layer (and a filament change between layers).'); return rep; }
  if (num(cfg, 'wall_loops', 2) > 1) warn('Weave: works best with 1 wall. More walls sit behind the woven line and squash it where it pulls in (use "Set up print settings").');
  const idx = (li: number) => layers[li].layer ?? li;
  const target = (li: number, p: Pt) => { const m = session?.weave.maskAt(idx(li)); return !m || pointIn(p.x, p.y, m); };
  const found = layers.map((L, li) => (li === 0 ? [] : outermost(findLoops(L)).filter((l) => target(li, l.pts[0]))));
  // plan: colours by layer, rows by distance up the wall
  const zs = layers.map((L) => L.z);
  const per = found.map((ls) => (ls.length ? Math.max(...ls.map((l) => perimeter(l.pts))) : NaN));
  const plan = planLayers(w, zs, per);
  // the wave texture: whole part plus zones, on the slicer's layer planes (by layer index)
  let planes = session?.weave.planes;
  if (!planes) { planes = []; layers.forEach((L, li) => { planes![idx(li)] = L.z - L.h / 2; }); }
  const field = new WaveField(w, session?.weave.zones ?? [], { planes, onObject: session?.weave.onObject, cap: w.max_deviation_mm > 0 ? w.max_deviation_mm : undefined });
  const stitch = field.shortestStitch;
  // woven points: ~6 per picture column and 8 per stitch, but no closer than the firmware streams at the wall speed
  const minMove = Math.min(0.5, minMoveMm(cfg, num(cfg, 'outer_wall_speed', 80)));
  const pixelStep = w.picture?.kind === 'none' ? 0.25 : Math.min(0.25, (Math.min(...per.filter((p) => p > 0), 1e9) / Math.max(1, rep.columns)) / 6);
  const step = Math.max(0.08, minMove, Math.min(pixelStep, stitch / 8));
  if (Number.isFinite(stitch) && stitch / 8 < minMove - 1e-9) warn(`Weave: stitches of ${stitch.toFixed(1)} mm are short for this printer at the outer wall speed (its moves need ${minMove.toFixed(2)} mm each). Make the stitches longer or slow the outer wall down.`);
  const accel = Math.min(num(cfg, 'outer_wall_acceleration', 0) || num(cfg, 'default_acceleration', 0) || 5000, maxAccelOf(cfg));
  const tuck = Math.max(0, w.seam.tuck_mm);
  let prevColour = -1;
  // the wave's layer-to-layer step, measured on a fixed grid round the biggest loop
  const GRID = 720;
  let prevGrid: Float64Array | null = null, waveSwing = 0;
  for (let li = 1; li < layers.length; li++) {
    const P = plan[li];
    if (P) { rep.wovenLayers++; if (w.mode === 'colour' && prevColour >= 0 && P.colour !== prevColour) rep.changes++; prevColour = P.colour; }
    const waved = field.activeAt(idx(li));
    if (!P && !w.seam.inward && !waved) { prevGrid = null; continue; }
    const loops = found[li];
    let grid: Float64Array | null = null, gridLen = 0;
    // from the last loop backwards so earlier op indices stay valid
    for (let n = loops.length - 1; n >= 0; n--) {
      const lp = loops[n];
      const woven = weaveLoop(lp.pts, P ? (u) => offsetAt(w, P, u) : null, step, w.smooth_mm, w.seam.angle_deg, waved ? field.term(idx(li)) : undefined);
      if (woven.length < 4) continue;
      const hasWave = woven.some((q) => (q.wave ?? 0) > 0);
      // pointed and square stitches: slow into their turns, as the firmware will
      const speeds = hasWave ? cornerSpeeds(woven, lp, accel) : undefined;
      writeLoop(layers[li].ops, lp, woven, w.seam.inward ? tuck : 0, cfg, speeds);
      if (P) rep.loops++;
      if (w.seam.inward && tuck > 0) rep.seamsTucked++;
      const L = perimeter(lp.pts);
      if (hasWave && L > gridLen) {
        gridLen = L;
        grid = new Float64Array(GRID).fill(NaN);
        for (const q of woven) grid[Math.min(GRID - 1, Math.floor(q.u * GRID))] = q.lat;
      }
    }
    if (grid && prevGrid) for (let g = 0; g < GRID; g++) if (Number.isFinite(grid[g]) && Number.isFinite(prevGrid[g])) waveSwing = Math.max(waveSwing, Math.abs(grid[g] - prevGrid[g]));
    prevGrid = grid;
  }
  // biggest out-to-in step between neighbouring layers: a showing line over a hidden one
  const maxMul = w.calibration ? 1.5 : 1;
  rep.swing = w.picture?.kind === 'none' ? 0 : w.depth_mm * maxMul * (1 + w.recess);
  if (rep.swing > 0.6 * lw) warn(`Weave: lines step ${rep.swing.toFixed(2)} mm in and out between layers, more than 60% of the ${lw.toFixed(2)} mm line, so layers may not bond. Lower the depth or the pull-in.`);
  const st = field.stats;
  if (field.zones.length || st.layers.size) {
    rep.wave = { layers: st.layers.size, zones: field.zones.length, zonesUsed: st.zones.size, swing: waveSwing, stitch: Number.isFinite(stitch) ? stitch : 0, edgeLoops: st.edgeLoops, repicks: st.repicks };
    if (waveSwing > lw) warn(`Weave: the wave puts neighbouring layers up to ${waveSwing.toFixed(2)} mm apart, more than the ${lw.toFixed(2)} mm line, so they only touch where the waves cross and the wall may be weak. Lower the wave height.`);
    if (field.zones.length && !st.zones.size) warn('Weave: no wave zone touches the woven wall. Move the zone shapes onto the part, or check their heights.');
  }
  if (w.mode === 'colour' && rep.wovenLayers && cycleLayers(w) > rep.wovenLayers) warn('Weave: the woven band is shorter than one row of the picture.');
  return rep;
}

/** Speed at each woven point (mm/s) with the turns of the wave slowed within the printer's acceleration. */
function cornerSpeeds(woven: WovenPoint[], lp: Loop, accel: number): number[] {
  const f0 = lp.f[0] ?? 60;
  const pts: ToolpathPoint[] = woven.map((q) => ({ x: q.x, y: q.y, z: lp.z, f: lp.f[q.src] ?? f0, flow: 1, e: 0 }));
  limitCornerSpeeds(pts, accel);
  return pts.map((q) => q.f);
}

/** Replace a loop's moves with the woven loop, a lead-in from inside, a tail and wipe going inside. */
function writeLoop(ops: Op[], lp: Loop, woven: WovenPoint[], tuck: number, cfg: Config, speeds?: number[]) {
  const first = ops[lp.start] as Move;
  const P0 = woven[0], n0x = P0.nx, n0y = P0.ny;
  // tangent at the seam (direction of travel)
  const t0x = woven[1].x - P0.x, t0y = woven[1].y - P0.y, tl = Math.hypot(t0x, t0y) || 1;
  const tx = t0x / tl, ty = t0y / tl;
  const S = tuck > 0 ? { x: P0.x - n0x * tuck - tx * tuck * 0.6, y: P0.y - n0y * tuck - ty * tuck * 0.6 } : { x: P0.x, y: P0.y };
  const T = tuck > 0 ? { x: P0.x - n0x * tuck + tx * tuck * 0.6, y: P0.y - n0y * tuck + ty * tuck * 0.6 } : null;
  const travelF = num(cfg, 'travel_speed', 200);
  const mv = (x: number, y: number, e: number, f: number, feature: Move['feature']): Move =>
    ({ k: 'move', x: round(x), y: round(y), z: lp.z, e: round5(e), f, feature, w: lp.w, h: lp.h, travel: false, noArc: true });
  const out: Op[] = [];
  // arrive at S, not at the old seam point on the outside of the wall
  const Q = lp.pts[0];
  let fixed = false;
  for (let k = lp.start - 1; k >= 0; k--) {
    const op = ops[k];
    if (op.k === 'raw' && op.resetPos) break;
    if (op.k !== 'move') continue;
    if (!op.travel) break;
    if (op.e < 0) break; // a wipe of the previous path: leave it
    if (Math.abs(op.x - Q.x) < 1e-3 && Math.abs(op.y - Q.y) < 1e-3) { op.x = round(S.x); op.y = round(S.y); fixed = true; } else break;
  }
  if (!fixed) out.push({ k: 'move', x: round(S.x), y: round(S.y), z: lp.z, e: 0, f: travelF, feature: 'travel', w: 0, h: lp.h, travel: true, noArc: true });
  const f0 = lp.f[0] ?? first.f;
  // lead-in and tail are marked, so later passes (motions) see the loop itself as one closed line
  if (T) out.push({ ...mv(P0.x, P0.y, Math.hypot(P0.x - S.x, P0.y - S.y) * lp.ePerMm, Math.min(f0, 30), lp.feat[0] ?? 'outer_wall'), tuck: true });
  for (let k = 1; k < woven.length; k++) {
    const a = woven[k - 1], b = woven[k];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 1e-6) continue;
    const m = mv(b.x, b.y, len * lp.ePerMm, speeds?.[k] ?? lp.f[b.src] ?? f0, lp.feat[b.src] ?? 'outer_wall');
    if (b.wave) m.wave = Math.round(b.wave * 100) / 100;
    out.push(m);
  }
  if (T) out.push({ ...mv(T.x, T.y, Math.hypot(T.x - P0.x, T.y - P0.y) * lp.ePerMm * 0.5, Math.min(f0, 30), lp.feat[0] ?? 'outer_wall'), tuck: true });
  ops.splice(lp.start, lp.end - lp.start, ...out);
  // the slicer's wipe after the loop ran back along the outside: send it further inside instead
  if (!T) return;
  let at = { ...T }, was = { x: Q.x, y: Q.y };
  for (let k = lp.start + out.length; k < ops.length; k++) {
    const op = ops[k];
    if (op.k === 'retract') continue;
    if (op.k !== 'move' || !op.travel || op.e >= 0) break;
    const len = Math.hypot(op.x - was.x, op.y - was.y);
    was = { x: op.x, y: op.y };
    at = { x: at.x - n0x * len, y: at.y - n0y * len };
    op.x = round(at.x); op.y = round(at.y);
  }
}

const round = (v: number) => Math.round(v * 1e4) / 1e4;
const round5 = (v: number) => Math.round(v * 1e5) / 1e5;
