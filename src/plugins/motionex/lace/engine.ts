// Lace inside the slicer: after toolpaths are made, the wall loops of the openwork band are cut where
// the lace is open. The nozzle stops extruding there, retracts and travels across the hole, and starts
// again on the far side. Which parts are open comes from LaceTracker (pattern + printability rule).
import type { Config } from '../../../profiles/settings';
import type { LayerOps, Op } from '../../../engine/gcode';
import type { Paths } from '../../../engine/types';
import { pointIn } from '../../../engine/clipper';
import { LoopLocator, loopFractions, OUTER, outermostLoops, perimeter, round4, round5, wallHeights, wallRuns, WALLS, type Move, type Pt, type WallRun } from '../wall/loops';
import { LaceTracker, solidAt, type LaceLoop, type LaceMask } from './core';
import type { LaceSettings } from './model';
import { laceLimits } from './plan';
import { isBowden, printerIdOf } from '../wall/machine';

export interface LaceReport {
  laceLayers: number;
  /** Holes cut (open stretches of wall, summed over layers and loops). */
  holes: number;
  /** Share of the band's wall that is open (0..1). */
  openShare: number;
  /** Share of the band's wall opened beyond the pattern so hole tops close in points (0..1). */
  openedForSupport: number;
  retractions: number;
  /** Strand width, shortest strand and narrowest hole as printed (mm), from the line width. */
  strandMm: number;
  minStrandMm: number;
  minHoleMm: number;
  /** Bowden extruder (long tube): retractions across holes are kept short. */
  bowden: boolean;
  /** Band, plate mm. */
  zFrom: number;
  zTo: number;
}

const num = (cfg: Config, k: string, d: number) => { const v = parseFloat(String(cfg[k] ?? '')); return Number.isFinite(v) ? v : d; };

export function applyLace(layers: LayerOps[], lace: LaceSettings, cfg: Config, maskAt: ((layer: number) => Paths | null) | null, warn: (m: string) => void, printerId?: string): LaceReport {
  // strands and holes measured against the real line width of the nozzle in use
  const lim = laceLimits(lace, cfg);
  const l: LaceSettings = { ...lace, strand_mm: lim.strand_mm, min_strand_mm: lim.min_strand_mm, min_hole_mm: lim.min_hole_mm };
  const bowden = isBowden(cfg, printerIdOf(cfg) ?? printerId);
  const rep: LaceReport = { laceLayers: 0, holes: 0, openShare: 0, openedForSupport: 0, retractions: 0, strandMm: l.strand_mm, minStrandMm: l.min_strand_mm, minHoleMm: l.min_hole_mm, bowden, zFrom: l.z_start, zTo: l.z_end };
  if (cfg.spiral_mode === true || cfg.spiral_mode === 'true') { warn('Lace: spiral vase is on. Turn it off: lace needs a closed loop per layer to cut holes into.'); return rep; }
  if (num(cfg, 'sparse_infill_density', 0) > 0) warn('Lace: sparse infill fills the holes from inside. Set infill to 0% (use "Set up print settings").');
  if (l.walls === 'outer' && num(cfg, 'wall_loops', 1) > 1) warn('Lace: holes are cut in the outer wall only, so the inner walls show through them. Pick "Every wall" for open holes.');
  if (lace.strand_mm < 2 * lim.lineWidth - 1e-6) warn(`Lace: ${lace.strand_mm} mm strands are under two ${lim.lineWidth.toFixed(2)} mm lines and would tear; they print ${l.strand_mm.toFixed(2)} mm wide. Use wider strands or a smaller nozzle.`);
  const idx = (li: number) => layers[li].layer ?? li;
  const keep = (li: number, q: Pt) => { const m = maskAt?.(idx(li)); return !m || pointIn(q.x, q.y, m); };
  // closed outer loops of the chosen objects, per layer
  const outer = layers.map((L, li) => (li === 0 ? [] : outermostLoops(wallRuns(L, OUTER).filter((r) => r.closed && keep(li, r.pts[0])).map((r) => ({ ...r, pts: r.pts.slice(0, -1) })))));
  const per = outer.map((rs) => (rs.length ? Math.max(...rs.map((r) => perimeter(r.pts))) : NaN));
  let topZ = 0;
  outer.forEach((rs, li) => { if (rs.length) topZ = layers[li].z; });
  const zTo = Math.min(l.z_end, topZ - Math.max(0, l.rim_mm));
  rep.zTo = zTo;
  const band = wallHeights(layers.map((L) => L.z), per, l.z_start, zTo, l.follow_curve);
  if (band.first < 0) { warn('Lace: no wall inside the openwork band. Check the heights and the rim.'); return rep; }
  const tracker = new LaceTracker(l, band);
  const travelF = num(cfg, 'travel_speed', 200);
  const rLen = num(cfg, 'retraction_length', 0.8), rSpeed = num(cfg, 'retraction_speed', 30), dSpeed = num(cfg, 'deretraction_speed', 0) || rSpeed;
  const minTravel = num(cfg, 'retraction_minimum_travel', 1);
  // Bowden: a full retraction of the long tube at every hole grinds the filament; hops this short ooze
  // little, so they pull back half as far (at least 0.5 mm), the long ones the full length
  const shortHop = bowden ? 4 : 0, shortLen = Math.min(rLen, Math.max(0.5, rLen / 2));
  const features = l.walls === 'all' ? WALLS : OUTER;
  let prevZ = layers[0]?.z ?? 0;

  for (let li = 1; li < layers.length; li++) {
    const loops = outer[li];
    const z = layers[li].z;
    if (!loops.length) { prevZ = z; continue; }
    const s = band.s[li];
    const inBand = Number.isFinite(s);
    const fr = loops.map((r) => loopFractions(r.pts));
    const ll: LaceLoop[] = loops.map((r, k) => ({ pts: r.pts, u: fr[k].u, length: fr[k].length, cx: fr[k].cx, cy: fr[k].cy }));
    const masks = tracker.layer(ll, inBand ? s : 0, z - prevZ, inBand);
    prevZ = z;
    if (!masks.some((m) => m.solid.includes(0))) continue;
    rep.laceLayers++;
    const near = new LoopLocator(ll);
    const ops = layers[li].ops;
    const runs = wallRuns(layers[li], features).filter((r) => keep(li, r.pts[0]));
    for (let n = runs.length - 1; n >= 0; n--) {
      const out = cutRun(ops, runs[n], near, masks, { travelF, rLen, rSpeed, dSpeed, minTravel, retract: l.retract, shortHop, shortLen });
      if (!out) continue;
      ops.splice(runs[n].start, runs[n].end - runs[n].start, ...out.ops);
      rep.retractions += out.retractions;
    }
  }
  const st = tracker.stats;
  rep.holes = st.holes;
  rep.openShare = st.total ? st.open / st.total : 0;
  rep.openedForSupport = st.total ? st.openedForSupport / st.total : 0;
  const perLayer = rep.laceLayers ? rep.retractions / rep.laceLayers : 0;
  if (bowden && perLayer > 30) warn(`Lace: ${Math.round(perLayer)} retractions per layer on a Bowden extruder wear the filament down and string. Use bigger cells (${Math.ceil(l.cell_w * Math.min(3, perLayer / 30))} mm or more), fewer walls with holes, or turn retraction across holes off.`);
  else if (perLayer > 120) warn(`Lace: ${Math.round(perLayer)} retractions per layer can grind the filament. Use bigger cells, or turn retraction across holes off for small holes.`);
  return rep;
}

interface CutOpts { travelF: number; rLen: number; rSpeed: number; dSpeed: number; minTravel: number; retract: boolean; /** Hops shorter than this (mm) retract only shortLen. */ shortHop: number; shortLen: number }

/** A wall run with its open stretches turned into travels. null when the run stays whole. */
function cutRun(ops: Op[], r: WallRun, near: LoopLocator, masks: LaceMask[], o: CutOpts): { ops: Op[]; retractions: number } | null {
  // solid or open at a point: the mask of the outer loop next to it
  const state = (p: Pt) => { const q = near.at(p); return !q || solidAt(masks[q.loop], q.u); };
  // pieces of ~0.1 mm along the run, with their state
  type Piece = { x: number; y: number; solid: boolean; move: number; t: number };
  const pieces: Piece[] = [];
  let anyOpen = false;
  for (let k = 1; k < r.pts.length; k++) {
    const a = r.pts[k - 1], b = r.pts[k];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const m = Math.max(1, Math.ceil(len / 0.1));
    for (let q = 1; q <= m; q++) {
      const t = q / m, tm = (q - 0.5) / m;
      const solid = state({ x: a.x + (b.x - a.x) * tm, y: a.y + (b.y - a.y) * tm });
      if (!solid) anyOpen = true;
      pieces.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, solid, move: k - 1, t });
    }
  }
  if (!anyOpen) return null;
  const out: Op[] = [];
  let retractions = 0, retracted = 0;
  // join pieces into stretches of one state within one move (solid) or across moves (open)
  let i = 0, cur = r.pts[0];
  while (i < pieces.length) {
    const solid = pieces[i].solid;
    if (solid) {
      // extrude to the end of this solid stretch, one move per original move
      while (i < pieces.length && pieces[i].solid) {
        const mv = pieces[i].move, orig = ops[r.start + mv] as Move;
        let j = i;
        const t0 = i > 0 && pieces[i - 1].move === mv ? pieces[i - 1].t : 0;
        while (j + 1 < pieces.length && pieces[j + 1].solid && pieces[j + 1].move === mv) j++;
        const p = pieces[j];
        out.push({ ...orig, x: round4(p.x), y: round4(p.y), e: round5(orig.e * (p.t - t0)), noArc: true });
        cur = p; i = j + 1;
      }
      continue;
    }
    // open: travel to where the wall starts again
    let j = i;
    while (j + 1 < pieces.length && !pieces[j + 1].solid) j++;
    const end = pieces[j];
    let gap = 0, px = cur.x, py = cur.y;
    for (let k = i; k <= j; k++) { gap += Math.hypot(pieces[k].x - px, pieces[k].y - py); px = pieces[k].x; py = pieces[k].y; }
    const doRetract = o.retract && gap >= o.minTravel && o.rLen > 0;
    const len = gap < o.shortHop ? o.shortLen : o.rLen;
    if (doRetract) { out.push({ k: 'retract', len, speed: o.rSpeed }); retracted = len; retractions++; }
    // follow the wall's own line across the hole (no shortcut through the part)
    for (let k = i; k <= j; k++) {
      if (k < j && pieces[k + 1].move === pieces[k].move) continue;
      out.push({ k: 'move', x: round4(pieces[k].x), y: round4(pieces[k].y), z: (ops[r.start + pieces[k].move] as Move).z, e: 0, f: o.travelF, feature: 'travel', w: 0, h: r.h, travel: true, noArc: true });
    }
    if (retracted) { out.push({ k: 'retract', len: -retracted, speed: o.dSpeed }); retracted = 0; }
    cur = end; i = j + 1;
  }
  return { ops: out, retractions };
}
