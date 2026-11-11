// Velocity painting data model. A picture is printed into the outer wall with one filament and no
// filament changes: each pixel sets the speed of the outer wall line there. Speed changes how glossy
// the line comes out (and on most filaments how it scatters light), so the picture shows as sheen.
// Silk and high-gloss filaments show it best; the calibration ring tells which way your filament goes.
import type { FitHeight, PictureSource, WeaveImage } from '../weave/model';

/** wrap: the picture goes round the part · front: projected from one side, like a slide projector. */
export type PaintProjection = 'wrap' | 'front';

export interface PaintSettings {
  enabled: boolean;
  /** Grey levels per pixel (0 = light … levels-1 = dark), row 0 = top. */
  image: WeaveImage;
  picture?: PictureSource;
  /** Outer wall speed (mm/s) for the lightest and the darkest pixels; levels in between are spread evenly. */
  speed_light: number;
  speed_dark: number;
  projection: PaintProjection;
  /** front: direction the picture is seen from (degrees from +X, counter-clockwise; -90 = from the front). */
  front_deg: number;
  /** How many times the picture goes round the part (wrap). */
  tiles_around: number;
  fit_height: FitHeight;
  follow_curve: boolean;
  /** Columns the picture drifts by per row: twists it into a spiral. */
  shift_px_per_row: number;
  z_start: number;
  z_end: number;
  /** Longest piece of line with one speed (mm); shorter pieces follow the picture more finely. */
  resolution_mm: number;
  /** Outer wall acceleration (mm/s²) on painted layers, 0 = keep the print's own. Higher = sharper pixels. */
  accel: number;
  /** Speed ladder test: vertical stripes of every level round the part, to see which speeds show. */
  calibration?: boolean;
  objects?: string[];
}

export const PAINT_LEVELS_MAX = 8;

export function defaultPaint(): PaintSettings {
  return {
    enabled: false,
    image: { w: 2, h: 2, px: [0, 1, 1, 0], name: 'Checker' },
    picture: { kind: 'motif', motif: 'checker', dither: 'none', levels: 2, pixel_mm: 3 },
    speed_light: 40, speed_dark: 140, projection: 'wrap', front_deg: -90,
    tiles_around: 1, fit_height: 'stretch', follow_curve: true, shift_px_per_row: 0,
    z_start: 1.2, z_end: 1e4, resolution_mm: 0.6, accel: 0,
  };
}

/** Grey levels: the count the picture was reduced to, or (no count saved) its highest index + 1, at least 2. */
export function paintLevels(p: PaintSettings): number {
  let n = Math.max(2, p.picture?.levels ?? 2);
  for (const v of p.image.px) if (v + 1 > n) n = v + 1;
  return Math.min(PAINT_LEVELS_MAX, n);
}

/** Speed (mm/s) for a grey level. */
export function speedOfLevel(p: PaintSettings, level: number, levels = paintLevels(p)): number {
  const t = levels > 1 ? Math.max(0, Math.min(1, level / (levels - 1))) : 0;
  return p.speed_light + (p.speed_dark - p.speed_light) * t;
}

/** Ladder picture: one vertical stripe per level, lightest first, repeated round the part. */
export function speedLadder(levels: number, repeats = 2): WeaveImage {
  const w = levels * repeats, px: number[] = [];
  for (let x = 0; x < w; x++) px.push(x % levels);
  return { w, h: 1, px, name: `Speed ladder (${levels})` };
}
