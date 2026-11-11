// Prime tower and single-nozzle filament change sequence, after OrcaSlicer's WipeTower2 (the Prusa wipe tower) and
// Bambu Studio's WipeTower:
//  - the MMU unload: ramming on the tower, the fast pull back into the cooling tube, cooling moves (with stamping),
//    the delay and the move to the parking position; then the load back to the nozzle after the change
//  - ramming for tool changers (filament_multitool_ramming) before a head is parked
//  - tower geometry: rotation, stabilization cone, wall type, purge flow / spacing, bridging of sparse layers
//  - purge volumes from load / unload volumes, minimal purge, "Internal ribs", sparse layer handling
// The slicer calls these with the tower box of the band being printed; the moves come back as engine ops.
import type { Config } from '../profiles/settings';
import { SCALE, union } from './clipper';
import type { Op } from './gcode';
import type { Paths, Polyline2 } from './types';

/** A filament's ramming: line width and row step (fractions), and the volumetric speed (mm³/s) of each time step. */
export interface Ramming { lineWidth: number; step: number; speeds: number[]; timeStep: number }

/** "120 100 6.6 6.8 …| …" (filament_ramming_parameters): width %, step %, then mm³/s every 0.25 s; the part after | is the dialog's. */
export function parseRamming(s: string): Ramming | null {
  const nums = String(s ?? '').split('|')[0].trim().split(/\s+/).map(Number).filter((v) => Number.isFinite(v));
  if (nums.length < 3) return null;
  return { lineWidth: nums[0] / 100, step: nums[1] / 100, speeds: nums.slice(2).filter((v) => v > 0), timeStep: 0.25 };
}

/** Value of a filament setting: the slot's own, else the config. */
const fv = (fs: Config | undefined, cfg: Config, k: string) => fs?.[k] ?? cfg[k];
const fnum = (fs: Config | undefined, cfg: Config, k: string) => Number(fv(fs, cfg, k) ?? 0) || 0;

/** Tool changers: ramming before a head is parked (filament_multitool_ramming, _volume, _flow), or null when off. */
export function multitoolRamming(fs: Config | undefined, cfg: Config): Ramming | null {
  const vol = fnum(fs, cfg, 'filament_multitool_ramming_volume'), flow = fnum(fs, cfg, 'filament_multitool_ramming_flow');
  if (fv(fs, cfg, 'filament_multitool_ramming') !== true || !(vol > 0) || !(flow > 0)) return null;
  return { lineWidth: 2, step: 1, speeds: [flow], timeStep: vol / flow };
}

/** Purge volume p→n from the per-filament unload / load volumes ("u0,l0,u1,l1,…", wiping_volumes_extruders); undefined when not set. */
export function loadUnloadFlush(v: unknown, p: number, n: number): number | undefined {
  const a = String(v ?? '').split(',').map((x) => Number(x.trim()));
  const u = a[2 * p], l = a[2 * n + 1];
  return Number.isFinite(u) && Number.isFinite(l) && String(v ?? '').trim() !== '' ? u + l : undefined;
}

/** Wipe tower purge tuning (WipeTower2: m_extra_flow, m_extra_spacing_wipe / _ramming, m_bridging, m_wipe_tower_max_purge_speed). */
export function towerTuning(cfg: Config) {
  const pct = (k: string) => Math.max(100, Number(cfg[k] ?? 100) || 100) / 100;
  const extraFlow = pct('wipe_tower_extra_flow'), extraSpacing = pct('wipe_tower_extra_spacing');
  return {
    extraFlow, extraSpacing,
    /** purge line spacing multiplier (spacing x flow: the same volume per area at a higher flow) */
    wipeSpacing: extraSpacing * extraFlow,
    bridging: Math.max(0, Number(cfg.wipe_tower_bridging ?? 10) || 0),
    maxPurgeSpeed: Math.max(0, Number(cfg.wipe_tower_max_purge_speed ?? 0) || 0),
    rotation: Number(cfg.wipe_tower_rotation_angle ?? 0) || 0,
    wallType: String(cfg.wipe_tower_wall_type ?? 'rib'),
    coneAngle: Number(cfg.wipe_tower_cone_angle ?? 30) || 0,
    framework: cfg.prime_tower_enable_framework !== false,
    noSparse: cfg.wipe_tower_no_sparse_layers === true,
    combineSparse: cfg.wipe_tower_sparse_layers_combination === true && cfg.wipe_tower_no_sparse_layers !== true,
    wallFilament: Math.round(Number(cfg.wipe_tower_filament ?? 0) || 0) - 1,
  };
}

/** Rotate integer paths by deg about (cx, cy) mm. */
export function rotatePathsAbout(paths: Paths, deg: number, cx: number, cy: number): Paths {
  if (!deg) return paths;
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  const X = cx * SCALE, Y = cy * SCALE;
  return paths.map((p) => p.map((q) => ({ X: Math.round(X + (q.X - X) * c - (q.Y - Y) * s), Y: Math.round(Y + (q.X - X) * s + (q.Y - Y) * c) })));
}

/** Point rotation about (cx, cy), for moves generated in the tower frame. */
export const rotatorAbout = (deg: number, cx: number, cy: number) => {
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return (x: number, y: number): [number, number] => (deg ? [cx + (x - cx) * c - (y - cy) * s, cy + (x - cx) * s + (y - cy) * c] : [x, y]);
};

/**
 * Stabilization cone (wall type "cone"): at height z of a tower `top` mm tall the footprint widens to a disc of radius
 * tan(angle / 2) · (top − z) around the tower centre (WipeTower2::generate_support_cone_wall); the tower body when narrower.
 */
export function coneBody(body: Paths, angleDeg: number, top: number, z: number, cx: number, cy: number, depth: number): Paths {
  const r = Math.tan(((angleDeg / 2) * Math.PI) / 180) * (top - z);
  if (!(r > depth / 2 + 0.01)) return body;
  const n = 64, disc = Array.from({ length: n }, (_, k) => ({ X: Math.round((cx + r * Math.cos((2 * Math.PI * k) / n)) * SCALE), Y: Math.round((cy + r * Math.sin((2 * Math.PI * k) / n)) * SCALE) }));
  return union([...body, disc]);
}

/** Tower bands needed on each layer: Internal ribs keep the deepest layer everywhere; off, a layer holds what it and the layers above still print. */
export function towerBandsPerLayer(changesPerLayer: number[], maxChanges: number, framework: boolean): number[] {
  if (framework) return changesPerLayer.map(() => maxChanges);
  const out = changesPerLayer.slice();
  let m = 0;
  for (let i = out.length - 1; i >= 0; i--) { m = Math.max(m, changesPerLayer[i]); out[i] = Math.max(1, m); }
  return out;
}

/**
 * Combine sparse layers: tower layers without a filament change are merged into one thicker layer printed at the top
 * of the run, never thicker than `maxH`. Returns, per layer, the height of the tower layer printed there (0 = skipped).
 */
export function combinedTowerHeights(hs: number[], changesPerLayer: number[], lastLayer: number, maxH: number): number[] {
  const out = hs.map(() => 0);
  let acc = 0;
  for (let i = 0; i <= lastLayer && i < hs.length; i++) {
    if (i === 0 || changesPerLayer[i] > 0) { out[i] = acc + hs[i]; acc = 0; continue; }
    acc += hs[i];
    const next = i + 1 <= lastLayer ? hs[i + 1] : Infinity;
    // print here when the next layer is a change layer, the end, or would not fit
    if (i + 1 > lastLayer || changesPerLayer[i + 1] > 0 || acc + next > maxH + 1e-9) { out[i] = acc; acc = 0; }
  }
  return out;
}

/** Filament minimal purge on the tower (mm³, filament_minimal_purge_on_wipe_tower). */
export const minimalPurge = (fs: Config | undefined, cfg: Config) => Math.max(0, fnum(fs, cfg, 'filament_minimal_purge_on_wipe_tower'));

/** Flow rate calibration: top surface Archimedean chords keep their order and the centre spiral prints inside-out, last. */
export function calibTopOrder<T extends Polyline2>(paths: T[], order: (p: T[]) => T[]): T[] {
  if (paths.length < 2) return paths;
  let bi = 0, bl = -1, cx = 0, cy = 0, n = 0;
  const len = (p: T) => { let L = 0; for (let k = 2; k < p.pts.length; k += 2) L += Math.hypot(p.pts[k] - p.pts[k - 2], p.pts[k + 1] - p.pts[k - 1]); return L; };
  paths.forEach((p, k) => { const L = len(p); if (L > bl) { bl = L; bi = k; } for (let j = 0; j < p.pts.length; j += 2) { cx += p.pts[j]; cy += p.pts[j + 1]; n++; } });
  cx /= n; cy /= n;
  const sp = { ...paths[bi], pts: paths[bi].pts.slice() };
  const m = sp.pts.length;
  if (Math.hypot(sp.pts[0] - cx, sp.pts[1] - cy) > Math.hypot(sp.pts[m - 2] - cx, sp.pts[m - 1] - cy)) {
    const r: number[] = [];
    for (let k = m - 2; k >= 0; k -= 2) r.push(sp.pts[k], sp.pts[k + 1]);
    sp.pts = r;
  }
  return [...order(paths.filter((_, k) => k !== bi)), sp];
}

/** What a tower sequence needs to know: the band box in the tower frame and the move state. */
export interface TowerCtx {
  /** band box, tower frame (unrotated) */
  xl: number; xr: number; y0: number; y1: number;
  /** tower line width, layer height, print Z, filament cross section (mm²) */
  w: number; h: number; z: number; filArea: number;
  /** tower frame → bed */
  toBed: (x: number, y: number) => [number, number];
  /** printer and the filament being unloaded / loaded */
  cfg: Config; fs?: Config;
  extraSpacing: number;
  verbose?: boolean;
}

interface Writer { ops: Op[]; x: number; y: number }

const mv = (W: Writer, c: TowerCtx, x: number, y: number, e: number, f: number, extrude: boolean, lw?: number) => {
  const [bx, by] = c.toBed(x, y);
  W.ops.push(extrude
    ? { k: 'move', x: bx, y: by, z: c.z, e, f, feature: 'prime_tower', w: lw ?? c.w, h: c.h, travel: false, noArc: true }
    : { k: 'move', x: bx, y: by, z: c.z, e, f, feature: 'travel', w: 0, h: c.h, travel: true, fixed: true });
  W.x = x; W.y = y;
};
/** E-only move (positive len retracts), mm/s */
const eMove = (W: Writer, len: number, speed: number) => { if (len && speed > 0) W.ops.push({ k: 'retract', len, speed }); };
/** WipeTowerWriter2::load_move_x_advanced: load `e` while moving toward x, the X speed capped at maxX. */
const loadMoveX = (W: Writer, c: TowerCtx, x: number, e: number, speed: number, maxX = 50) => {
  if (!e || !(speed > 0)) return;
  const time = Math.abs(e / speed);
  let dx = Math.abs(x - W.x);
  let vx = dx / time;
  if (vx > maxX) { dx = maxX * time; vx = maxX; }
  if (dx < 1e-4) { eMove(W, -e, speed); return; }
  mv(W, c, W.x + (x > W.x ? 1 : -1) * dx, W.y, e, vx, false);
};

/** Ramming rows on the band (WipeTower2::toolchange_Unload, the ramming part). Returns the depth used. */
function ram(W: Writer, c: TowerCtx, r: Ramming): number {
  const xl = c.xl + c.w, xr = c.xr - c.w;
  const lw = c.w * r.lineWidth, yStep = lw * r.step * c.extraSpacing;
  if (!(xr - xl > 1e-3) || !r.speeds.length) return 0;
  const y0 = c.y0 + yStep / 2;
  mv(W, c, xl, y0, 0, 120, false);
  let ltr = true, remaining = xr - xl, done = 0, i = 0;
  const xs = lw > c.h ? (lw - c.h) * c.h + Math.PI * (c.h / 2) ** 2 : lw * c.h;
  while (i < r.speeds.length) {
    const x = (r.speeds[i] * r.timeStep) / xs;
    const e = (r.speeds[i] * r.timeStep) / c.filArea;
    const dist = Math.min(x - done, remaining);
    const t = (dist / x) * r.timeStep;
    if (dist > 1e-6) mv(W, c, W.x + (ltr ? 1 : -1) * dist, W.y, e * (dist / x), dist / Math.max(t, 1e-6), true, lw);
    remaining -= dist;
    if (remaining < 1e-4) { if (W.y + yStep > c.y1) break; mv(W, c, W.x, W.y + yStep, 0, 120, false); ltr = !ltr; remaining = xr - xl; }
    done += dist;
    if (done > x - 1e-4) { i++; done = 0; }
  }
  return W.y - c.y0 + yStep / 2;
}

/**
 * Single-nozzle filament unit: what happens on the tower before the change G-code (WipeTower2::toolchange_Unload):
 * ramming, the pull into the cooling tube, cooling moves with stamping, the delay and the move to the parking position.
 */
export function mmuUnload(c: TowerCtx, sx: number, sy: number): { ops: Op[]; depth: number; x: number; y: number } {
  const W: Writer = { ops: [], x: sx, y: sy };
  const P = (k: string) => Number(c.cfg[k] ?? 0) || 0;
  const F = (k: string) => fnum(c.fs, c.cfg, k);
  const rammingOn = c.cfg.enable_filament_ramming === true;
  if (!rammingOn) return { ops: [], depth: 0, x: sx, y: sy };
  const note = (t: string) => { if (c.verbose) W.ops.push({ k: 'raw', text: `; ${t}` }); };
  if (c.cfg.high_current_on_filament_swap === true) W.ops.push({ k: 'raw', text: 'M907 E750 ; high extruder current for the filament swap' });
  note('CP TOOLCHANGE UNLOAD');
  const r = parseRamming(String(fv(c.fs, c.cfg, 'filament_ramming_parameters') ?? ''));
  let depth = 0;
  if (r) depth = ram(W, c, r);
  else mv(W, c, c.xl + c.w, c.y0 + c.w / 2, 0, 120, false);
  const xl = c.xl + c.w, xr = c.xr - c.w;
  const tubeL = P('cooling_tube_length'), tubeR = P('cooling_tube_retraction');
  // pull the filament out of the melt zone into the cooling tube
  if (tubeR !== 0 || tubeL !== 0) {
    const total = tubeR + tubeL / 2 - 15;
    const us = F('filament_unloading_speed'), us0 = F('filament_unloading_speed_start');
    eMove(W, 15, us0);
    eMove(W, 0.7 * total, us);
    eMove(W, 0.2 * total, 0.5 * us);
    eMove(W, 0.1 * total, 0.3 * us);
  }
  // cooling moves in the cooling tube, stamping between them
  const n = Math.round(F('filament_cooling_moves'));
  if (n > 0 && tubeL !== 0) {
    note('Cooling');
    const v0 = F('filament_cooling_initial_speed'), v1 = F('filament_cooling_final_speed');
    const inc = (v1 - v0) / (2 * n - 1);
    const oldX = W.x;
    const turn = xr - oldX > oldX - xl ? xr : xl;
    const stampD = F('filament_stamping_distance');
    const stampE = stampD + tubeL / 2;
    for (let k = 0; k < n; k++) {
      if (k > 0 && stampD !== 0) {
        const tp = Math.min(xr, Math.max(xl, oldX + 20 * (turn - oldX > 0 ? 1 : -1)));
        const sv = F('filament_stamping_loading_speed');
        if (stampE > 5) {
          const cent = W.x;
          loadMoveX(W, c, tp, stampE - 5, sv, 200);
          loadMoveX(W, c, cent, 5, sv, 120);
          mv(W, c, cent, W.y, 0, 120, false);
        } else {
          const cent = W.x;
          loadMoveX(W, c, tp, stampE / 2, sv, 120);
          loadMoveX(W, c, cent, stampE / 2, sv, 120);
        }
        // retract with the head standing, so a blob is not dragged along
        eMove(W, stampE, F('filament_unloading_speed'));
      }
      const s = v0 + inc * 2 * k;
      loadMoveX(W, c, turn, tubeL, s);
      loadMoveX(W, c, oldX, -tubeL, s + inc);
    }
  }
  note('Cooling park');
  const delay = F('filament_toolchange_delay');
  if (delay > 0) W.ops.push({ k: 'raw', text: `G4 S${+delay.toFixed(3)}`, time: delay });
  const park = -tubeL / 2 + P('parking_pos_retraction') - tubeR;
  if (park !== 0) eMove(W, park, 2000 / 60);
  return { ops: W.ops, depth, x: W.x, y: W.y };
}

/** Single-nozzle filament unit: loading the new filament back to the nozzle while moving over the band (WipeTower2::toolchange_Load). */
export function mmuLoad(c: TowerCtx, sx: number, sy: number): Op[] {
  const W: Writer = { ops: [], x: sx, y: sy };
  if (c.cfg.enable_filament_ramming !== true) return [];
  const P = (k: string) => Number(c.cfg[k] ?? 0) || 0;
  const edist = P('parking_pos_retraction') + P('extra_loading_move');
  if (P('parking_pos_retraction') === 0 && P('extra_loading_move') === 0) return [];
  const xl = c.xl + c.w * 0.75, xr = c.xr - c.w * 0.75;
  const oldX = Math.min(xr, Math.max(xl, sx));
  W.x = oldX;
  const turn = oldX - xl < xr - oldX ? xr : xl;
  const ls = fnum(c.fs, c.cfg, 'filament_loading_speed'), ls0 = fnum(c.fs, c.cfg, 'filament_loading_speed_start');
  if (c.verbose) W.ops.push({ k: 'raw', text: '; CP TOOLCHANGE LOAD' });
  mv(W, c, oldX, sy, 0, 120, false);
  eMove(W, -0.2 * edist, ls0);
  loadMoveX(W, c, turn, 0.7 * edist, ls);
  loadMoveX(W, c, oldX, 0.1 * edist, 0.1 * ls);
  mv(W, c, oldX, W.y, 0, 120, false);
  if (c.cfg.high_current_on_filament_swap === true) W.ops.push({ k: 'raw', text: 'M907 E550 ; normal extruder current' });
  return W.ops;
}

/** Tool changers: ramming on the tower before the head is parked. */
export function multitoolRam(c: TowerCtx, r: Ramming, sx: number, sy: number): { ops: Op[]; depth: number } {
  const W: Writer = { ops: [], x: sx, y: sy };
  const depth = ram(W, c, r);
  return { ops: W.ops, depth };
}

/**
 * Farthest point timelapse: the point of a layer farthest from the bed origin, on the outer walls, else on infill,
 * else on support (GCode::compute_farthest_point); null when the layer printed none of them.
 */
export function farthestPoint(ops: Op[]): [number, number] | null {
  const tiers: ((f: string) => boolean)[] = [
    (f) => f === 'outer_wall',
    (f) => f === 'sparse_infill' || f === 'internal_solid_infill' || f === 'top_surface',
    (f) => f.startsWith('support'),
  ];
  for (const tier of tiers) {
    let best: [number, number] | null = null, bd = -1;
    for (const op of ops) {
      if (op.k !== 'move' || op.travel || !(op.e > 0) || !tier(op.feature)) continue;
      const d = op.x * op.x + op.y * op.y;
      if (d > bd) { bd = d; best = [op.x, op.y]; }
    }
    if (best) return best;
  }
  return null;
}
