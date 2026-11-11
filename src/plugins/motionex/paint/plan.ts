// Velocity painting before slicing: print settings it needs, what it costs in time, and what the
// printer can draw (speeds it can melt and reach, how fine a piece of line its firmware takes).
import type { Config } from '../../../profiles/settings';
import type { PaintSettings } from './model';
import { paintLevels, speedOfLevel } from './model';
import { flavourOf, maxAccelOf, minMoveMm, outerLineWidth } from '../wall/machine';

const num = (cfg: Config, k: string, d: number) => { const v = parseFloat(String(cfg[k] ?? '')); return Number.isFinite(v) ? v : d; };

/**
 * Print settings for velocity painting: an aligned seam (out of the picture, at the back), and no
 * pressure equalizer (it smooths speed steps into blurs). Everything else stays as the print has it;
 * painted lines are already kept out of arc fitting and the cooling slowdown.
 */
export function paintPrintSettings(_p: PaintSettings): Record<string, string | number | boolean> {
  return { seam_position: 'aligned', seam_slope_type: 'none', max_volumetric_extrusion_rate_slope_positive: 0, max_volumetric_extrusion_rate_slope_negative: 0 };
}

/** Mean outer wall speed of the picture (mm/s): the share of each level times its speed, by time. */
export function meanPaintSpeed(p: PaintSettings): number {
  const n = paintLevels(p);
  const count = new Array<number>(n).fill(0);
  const px = p.calibration ? Array.from({ length: n }, (_, k) => k) : p.image.px;
  for (const v of px) count[Math.min(n - 1, v)]++;
  const total = px.length || 1;
  // time per mm is 1/v: the mean speed over a length is the harmonic mean weighted by share
  let tPerMm = 0;
  count.forEach((c, k) => { tPerMm += c / total / Math.max(1, speedOfLevel(p, k, n)); });
  return 1 / Math.max(1e-9, tPerMm);
}

/** Head travel (mm) to change between two speeds at an acceleration: |v1² − v0²| / 2a. */
export const rampMm = (v0: number, v1: number, accel: number) => Math.abs(v1 * v1 - v0 * v0) / (2 * Math.max(1, accel));

/** Speeds the levels print at (mm/s): as asked, capped by what the filament can melt and the printer's top speed. */
export function paintSpeeds(p: PaintSettings, cfg: Config): { raw: number[]; speeds: number[]; flowLimit: number; xyLimit: number } {
  const levels = paintLevels(p);
  const lw = outerLineWidth(cfg), lh = num(cfg, 'layer_height', 0.2);
  const flowLimit = num(cfg, 'filament_max_volumetric_speed', 15) / Math.max(1e-3, lw * lh);
  const xyLimit = num(cfg, 'max_speed_xy', 500) || 500;
  const raw = Array.from({ length: levels }, (_, k) => speedOfLevel(p, k, levels));
  return { raw, speeds: raw.map((v) => Math.max(2, Math.min(v, flowLimit, xyLimit))), flowLimit, xyLimit };
}

/** Acceleration painted walls print at (mm/s²): the painting one, else the outer wall's, never above the machine's. */
export function paintAccel(p: PaintSettings, cfg: Config): number {
  const a = p.accel > 0 ? p.accel : num(cfg, 'outer_wall_acceleration', 0) || num(cfg, 'default_acceleration', 5000);
  return Math.max(1, Math.min(a, maxAccelOf(cfg)));
}

/** Painting acceleration worth asking for: the machine's limit, capped at 10 000 mm/s² (more only rings). */
export const recommendedPaintAccel = (cfg: Config) => Math.round(Math.min(maxAccelOf(cfg), 10000));

/**
 * Shortest piece of line with one speed (mm). Marlin gets pieces of at least 1 mm (and 4 ms) so its
 * planner keeps up and doesn't slow down on its own; Klipper and Bambu take finer pieces.
 */
export function paintStepMm(p: PaintSettings, cfg: Config): number {
  const vMax = Math.max(...paintSpeeds(p, cfg).speeds);
  const floor = flavourOf(cfg) === 'marlin' ? Math.max(1, minMoveMm(cfg, vMax)) : Math.max(0.1, minMoveMm(cfg, vMax));
  return Math.max(0.1, p.resolution_mm, floor);
}

/**
 * Smallest pixel (mm round the part) this printer draws sharply: the speed ramp between the slowest and
 * fastest level takes at most 60% of a pixel, and a pixel holds at least two pieces of line.
 */
export function recommendedPixelMm(cfg: Config, p: PaintSettings): number {
  const s = paintSpeeds(p, cfg).speeds;
  return Math.max(rampMm(Math.min(...s), Math.max(...s), paintAccel(p, cfg)) / 0.6, 2 * paintStepMm(p, cfg));
}
