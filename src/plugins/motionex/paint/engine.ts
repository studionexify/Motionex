// Velocity painting inside the slicer: after toolpaths are made, every outer wall move in the painted
// band is cut into short pieces and each piece gets the speed of the pixel it crosses. Extrusion per mm
// stays the same, so the line keeps its width; only the speed (and so the sheen) changes. Painted moves
// are kept out of arc fitting (one F per arc would flatten the picture) and out of the cooling slowdown
// (which would squeeze the speeds together).
import type { Config } from '../../../profiles/settings';
import type { LayerOps, Op } from '../../../engine/gcode';
import type { Paths } from '../../../engine/types';
import { pointIn } from '../../../engine/clipper';
import { pixelAt } from '../weave/image';
import type { WeaveImage } from '../weave/model';
import { bandRows, layerEnd, LoopLocator, loopFractions, OUTER, perimeter, round4, round5, signedArea, wallHeights, wallRuns, type Move, type Pt, type WallRun } from '../wall/loops';
import { paintLevels, speedLadder, type PaintSettings } from './model';
import { paintAccel, paintSpeeds, paintStepMm, rampMm, recommendedPaintAccel, recommendedPixelMm } from './plan';
import { flavourOf, maxAccelOf, outerLineWidth } from '../wall/machine';

export interface PaintReport {
  paintedLayers: number;
  /** Outer wall runs painted. */
  runs: number;
  /** Moves written (after cutting at pixel edges). */
  moves: number;
  /** Speed of each grey level as printed (mm/s), lightest first. */
  speeds: number[];
  /** Fastest the filament can be pushed through this line (mm/s), from the max volumetric speed. */
  flowLimit: number;
  /** Distance the head needs to change from the slowest to the fastest speed (mm), at the painting acceleration. */
  rampMm: number;
  /** Width of one picture column on the part (mm). */
  pixelMm: number;
  /** Shortest painted layer (s, whole layer): painted lines are not slowed down for cooling. */
  shortestLayer: number;
  /** Longest piece of line with one speed as printed (mm): resolution_mm, raised so the firmware keeps up. */
  stepMm: number;
  /** Acceleration painted walls print at (mm/s²), within the machine's limit. */
  accel: number;
}

const num = (cfg: Config, k: string, d: number) => { const v = parseFloat(String(cfg[k] ?? '')); return Number.isFinite(v) ? v : d; };

/** Grey level of the picture at column fraction u on a row counted from the bottom of the band. */
export function levelAt(p: PaintSettings, img: WeaveImage, u: number, rowFromBottom: number): number {
  const H = img.h;
  const tiles = p.projection === 'wrap' ? Math.max(1, p.tiles_around) : 1;
  const x = u * img.w * tiles + p.shift_px_per_row * rowFromBottom;
  const row = H - 1 - (((rowFromBottom % H) + H) % H);
  return pixelAt(img, x, row);
}

/**
 * u for every point of a run: arc fraction for closed loops; for open runs the u of the nearest closed
 * loop of the layer, or else the angle round the run's own centre.
 */
function runFractions(r: WallRun, near: LoopLocator | null): { u: number[]; ccw: boolean } {
  const pts = r.closed ? r.pts.slice(0, -1) : r.pts;
  if (r.closed) {
    const f = loopFractions(pts);
    return { u: [...f.u, f.u[0]], ccw: f.ccw };
  }
  const located = near ? r.pts.map((q) => near.at(q)) : [];
  if (near && located.every((q) => q)) return { u: located.map((q) => q!.u), ccw: signedArea(r.pts) >= 0 };
  let cx = 0, cy = 0;
  for (const q of r.pts) { cx += q.x; cy += q.y; }
  cx /= r.pts.length; cy /= r.pts.length;
  return { u: r.pts.map((q) => { const a = Math.atan2(q.y - cy, q.x - cx) / (2 * Math.PI); return a - Math.floor(a); }), ccw: signedArea(r.pts) >= 0 };
}

/** Shortest way from u0 to u1 round the loop (the seam is crossed without a jump back). */
const du = (u0: number, u1: number) => { let d = u1 - u0; if (d > 0.5) d -= 1; else if (d < -0.5) d += 1; return d; };

export function applyPaint(layers: LayerOps[], p: PaintSettings, cfg: Config, maskAt: ((layer: number) => Paths | null) | null, warn: (m: string) => void): PaintReport {
  const levels = paintLevels(p);
  const img = p.calibration ? speedLadder(levels) : p.image;
  const lw = outerLineWidth(cfg);
  const lh = num(cfg, 'layer_height', 0.2);
  const { raw, speeds, flowLimit, xyLimit } = paintSpeeds(p, cfg);
  const maxAccel = maxAccelOf(cfg);
  const accel = paintAccel(p, cfg);
  const res = paintStepMm(p, cfg);
  const rep: PaintReport = { paintedLayers: 0, runs: 0, moves: 0, speeds, flowLimit, rampMm: 0, pixelMm: 0, shortestLayer: Infinity, stepMm: res, accel };
  if (raw.some((v, k) => v > speeds[k] + 1e-6)) warn(`Velocity paint: ${Math.max(...raw).toFixed(0)} mm/s is more than this filament can melt in a ${lw.toFixed(2)} × ${lh.toFixed(2)} mm line (${flowLimit.toFixed(0)} mm/s at ${num(cfg, 'filament_max_volumetric_speed', 15)} mm³/s)${xyLimit < flowLimit ? ` or the printer can move (${xyLimit.toFixed(0)} mm/s)` : ''}; it prints at ${Math.min(flowLimit, xyLimit).toFixed(0)} mm/s, so the darkest levels merge.`);
  if (num(cfg, 'max_volumetric_extrusion_rate_slope_positive', 0) > 0 || num(cfg, 'max_volumetric_extrusion_rate_slope_negative', 0) > 0) warn('Velocity paint: the pressure equalizer (max volumetric slope) is on and smooths the speed steps, which blurs the picture. Turn it off for painting.');
  if (p.accel > maxAccel) warn(`Velocity paint: the painting acceleration ${p.accel} mm/s² is above this printer's ${maxAccel} mm/s² limit; painted walls print at ${maxAccel} mm/s².`);
  const spiral = cfg.spiral_mode === true || cfg.spiral_mode === 'true';
  if (spiral) warn('Velocity paint: works in spiral vase too, but the picture follows the spiral; for sharp rows turn spiral vase off.');

  const idx = (li: number) => layers[li].layer ?? li;
  const keep = (li: number, q: Pt) => { const m = maskAt?.(idx(li)); return !m || pointIn(q.x, q.y, m); };
  // spiral vase layers print on from where the layer below ended: their first move belongs to the run
  const runs = layers.map((L, li) => (li === 0 ? [] : wallRuns(L, OUTER, spiral ? layerEnd(layers[li - 1]) : null).filter((r) => keep(li, r.pts[0]))));
  const per = runs.map((rs) => { const c = rs.filter((r) => r.closed); return c.length ? Math.max(...c.map((r) => perimeter(r.pts.slice(0, -1)))) : NaN; });
  const band = wallHeights(layers.map((L) => L.z), per, p.z_start, p.z_end, p.follow_curve);
  if (band.first < 0) { warn('Velocity paint: no outer wall inside the painted band. Check the heights.'); return rep; }
  const pixelMm = p.picture?.pixel_mm ?? 3;
  const rows = bandRows(band.total, img.h, p.fit_height, pixelMm);

  // front projection: the picture spans the widest the part gets across the view
  const view = { x: Math.cos((p.front_deg * Math.PI) / 180), y: Math.sin((p.front_deg * Math.PI) / 180) };
  const across = { x: -view.y, y: view.x };
  let eMin = Infinity, eMax = -Infinity;
  if (p.projection === 'front') runs.forEach((rs, li) => { if (Number.isFinite(band.s[li])) for (const r of rs) for (const q of r.pts) { const e = q.x * across.x + q.y * across.y; eMin = Math.min(eMin, e); eMax = Math.max(eMax, e); } });
  // `across` points to the viewer's right, so the picture reads left to right
  const frontU = (q: Pt) => Math.max(0, Math.min(1 - 1e-9, (q.x * across.x + q.y * across.y - eMin) / Math.max(1e-6, eMax - eMin)));

  const vs = [Math.min(...speeds), Math.max(...speeds)];
  // the ramp at the acceleration the firmware will really use (it clamps to its own limit)
  rep.rampMm = rampMm(vs[0], vs[1], accel);
  const bandPer = per.filter((v, li) => Number.isFinite(v) && Number.isFinite(band.s[li])).sort((a, b) => a - b);
  const midPer = bandPer[Math.floor(bandPer.length / 2)] ?? 0;
  rep.pixelMm = p.projection === 'wrap' ? midPer / Math.max(1, img.w * Math.max(1, p.tiles_around)) : (eMax - eMin) / Math.max(1, img.w);
  // acceleration in force at the end of the previous layer (restored after each painted run)
  let carry = Math.min(num(cfg, 'default_acceleration', 5000), maxAccel);
  const accelBefore = (ops: Op[], at: number) => { let a = carry; for (let k = 0; k < at; k++) { const op = ops[k]; if (op.k === 'accel') a = op.a; } return Math.min(a, maxAccel); };
  // spiral vase: moves climb, so pieces of a move take their share of its rise
  const zBefore = (li: number, at: number, z: number) => {
    const ops = layers[li].ops;
    for (let k = at - 1; k >= 0; k--) { const op = ops[k]; if (op.k === 'raw' && op.resetPos) return z; if (op.k === 'move') return op.z; }
    return (li > 0 ? layerEnd(layers[li - 1])?.z : undefined) ?? z;
  };

  for (let li = 1; li < layers.length; li++) {
    const ops = layers[li].ops;
    const s = band.s[li];
    if (!Number.isFinite(s) || !runs[li].length) { carry = accelBefore(ops, ops.length); continue; }
    const rowB = rows.rowFromBottom(s);
    let painted = false, layerTime = 0;
    const closed = runs[li].filter((r) => r.closed);
    const near = closed.length && closed.length < runs[li].length ? new LoopLocator(closed.map((r) => { const pts = r.pts.slice(0, -1); return { pts, u: loopFractions(pts).u }; })) : null;
    for (let n = runs[li].length - 1; n >= 0; n--) {
      const r = runs[li][n];
      const { u, ccw } = p.projection === 'wrap' ? runFractions(r, near) : { u: r.pts.map(frontU), ccw: r.closed ? signedArea(r.pts) >= 0 : true };
      const out: Op[] = [];
      for (let k = 1; k < r.pts.length; k++) {
        const a = r.pts[k - 1], b = r.pts[k];
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        const orig = ops[r.start + k - 1] as Move;
        const za = spiral ? zBefore(li, r.start + k - 1, orig.z) : orig.z;
        if (len < 1e-6) { out.push(orig); continue; }
        // front: only the side that faces the viewer is painted
        if (p.projection === 'front') {
          const nx = ccw ? (b.y - a.y) / len : -(b.y - a.y) / len, ny = ccw ? -(b.x - a.x) / len : (b.x - a.x) / len;
          if (nx * view.x + ny * view.y < 0.17) { out.push({ ...orig, noArc: true }); layerTime += len / Math.max(1, orig.f); continue; }
        }
        const d = p.projection === 'wrap' ? du(u[k - 1], u[k]) : u[k] - u[k - 1];
        const m = Math.max(1, Math.ceil(len / res));
        // level of each piece, then pieces with the same level joined
        let t0 = 0, lvl = -1;
        const flush = (t1: number) => {
          if (t1 <= t0 || lvl < 0) return;
          const x = a.x + (b.x - a.x) * t1, y = a.y + (b.y - a.y) * t1;
          out.push({ ...orig, x: round4(x), y: round4(y), z: round4(za + (orig.z - za) * t1), e: round5(orig.e * (t1 - t0)), f: speeds[lvl], noArc: true, noSlow: true });
          layerTime += (len * (t1 - t0)) / speeds[lvl];
          t0 = t1;
        };
        for (let q = 0; q < m; q++) {
          const tm = (q + 0.5) / m;
          let uu = u[k - 1] + d * tm;
          if (p.projection === 'wrap') uu -= Math.floor(uu);
          const L = Math.max(0, Math.min(levels - 1, levelAt(p, img, uu, rowB)));
          if (L !== lvl) { flush(q / m); lvl = L; }
        }
        flush(1);
        // the last piece ends exactly on the original point
        const last = out[out.length - 1] as Move;
        last.x = orig.x; last.y = orig.y; last.z = orig.z;
      }
      if (p.accel > 0) { const before = accelBefore(ops, r.start); out.unshift({ k: 'accel', a: accel }); out.push({ k: 'accel', a: before }); }
      ops.splice(r.start, r.end - r.start, ...out);
      rep.moves += out.length;
      rep.runs++;
      painted = true;
    }
    if (painted) {
      // the whole layer's time counts for cooling: painted wall plus every other move at its own speed
      let x = NaN, y = NaN, other = 0;
      for (const op of ops) {
        if (op.k === 'raw' && op.resetPos) { x = NaN; y = NaN; continue; }
        if (op.k !== 'move') continue;
        if (!op.noSlow && !isNaN(x)) other += Math.hypot(op.x - x, op.y - y) / Math.max(1, op.f);
        x = op.x; y = op.y;
      }
      rep.paintedLayers++;
      rep.shortestLayer = Math.min(rep.shortestLayer, layerTime + other);
    }
    carry = accelBefore(ops, ops.length);
  }
  if (!Number.isFinite(rep.shortestLayer)) rep.shortestLayer = 0;
  if (rep.pixelMm > 0 && rep.rampMm > 0.6 * rep.pixelMm) {
    const best = recommendedPaintAccel(cfg), tip = best > accel * 1.2 ? `, or a painting acceleration of ${best} mm/s² (this printer's limit allows it)` : '';
    warn(`Velocity paint: the head needs ${rep.rampMm.toFixed(1)} mm to change between ${vs[0].toFixed(0)} and ${vs[1].toFixed(0)} mm/s at ${accel.toFixed(0)} mm/s², but a pixel is ${rep.pixelMm.toFixed(1)} mm wide, so the picture blurs. Use pixels of ${recommendedPixelMm(cfg, p).toFixed(1)} mm or more, closer speeds${tip}.`);
  }
  // pieces raised for the firmware: only worth a word when pixel edges move by a third of a pixel
  if (res > p.resolution_mm + 1e-6 && rep.pixelMm > 0 && res > rep.pixelMm / 3) warn(`Velocity paint: ${flavourOf(cfg) === 'marlin' ? 'Marlin' : 'the firmware'} needs pieces of line of ${res.toFixed(1)} mm or more to keep up, which is coarse for ${rep.pixelMm.toFixed(1)} mm pixels. Use pixels of ${recommendedPixelMm(cfg, p).toFixed(1)} mm or more.`);
  const minLayer = num(cfg, 'slow_down_layer_time', 0);
  if (rep.paintedLayers && minLayer > 0 && rep.shortestLayer < minLayer) warn(`Velocity paint: painted layers take ${rep.shortestLayer.toFixed(1)} s, under the ${minLayer} s minimum layer time, and are not slowed down (that would squeeze the speeds together). Print two parts at once or lower both speeds if the top softens.`);
  return rep;
}
