// What a weave costs before you slice: filament changes, extra time and purged plastic.
import type { Config } from '../../../profiles/settings';
import { colourCount, cycleLayers, type WeaveSettings } from './model';
import { isBedSlinger } from '../wall/machine';

export interface WeaveEstimate {
  wovenLayers: number;
  changes: number;
  /** Extra print time for the changes (s). */
  changeSeconds: number;
  /** Plastic flushed out (g). */
  purgeGrams: number;
  /** Picture rows the band holds. */
  rows: number;
  /** Height of one picture row (mm). */
  rowMm: number;
}

export interface EstimateInput {
  /** Height of the woven band (mm). */
  bandMm: number;
  layerHeight: number;
  /** Seconds the printer spends on one change (cut, unload, load, heat), without the flush. */
  changeTime: number;
  /** Flush (mm³) for a normal change. */
  flushMm3: number;
  filamentDensity: number;
  /** Flush speed (mm³/s); the Bambu change G-code flushes at 4 mm/s of 1.75 mm filament (≈ 9.6 mm³/s). */
  flushRate?: number;
}

export function estimateWeave(w: WeaveSettings, inp: EstimateInput): WeaveEstimate {
  const lh = Math.max(0.04, inp.layerHeight);
  const layers = Math.max(0, Math.floor(inp.bandMm / lh));
  const cyc = cycleLayers(w);
  const per = Math.max(1, Math.round(w.layers_per_colour));
  const changes = w.mode === 'colour' && colourCount(w) > 1 ? Math.max(0, Math.ceil(layers / per) - 1) : 0;
  const vol = w.change.mode === 'bleed' ? 0 : w.change.mode === 'reduced' ? Math.max(0, w.change.volume_mm3) : Math.max(0, inp.flushMm3);
  const rate = inp.flushRate ?? 9.6;
  return {
    wovenLayers: layers, changes,
    changeSeconds: changes * (inp.changeTime + vol / rate),
    purgeGrams: (changes * vol * inp.filamentDensity) / 1000,
    rows: Math.floor(layers / cyc), rowMm: cyc * lh,
  };
}

/** "2 h 05 min" style duration. */
export function formatDuration(s: number): string {
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

/** Outer wall speed for weaving (mm/s): 80, 60 on bed slingers, never faster than the printer's own. */
export function weaveWallSpeed(cfg?: Config): number {
  const own = Number(cfg?.outer_wall_speed);
  // a bed slinger swings the whole part on every in-out step of the line: slower keeps the beads in place
  const v = cfg && isBedSlinger(cfg) ? 60 : 80;
  return own > 0 ? Math.min(v, own) : v;
}

/**
 * Print settings weave mode needs: one wall, no infill or top skin (a single woven skin over a solid
 * floor), spiral vase off, aligned seam, a slower outer wall, no prime tower when bleeding colours.
 * Pass the print's config to fit the wall speed to the printer.
 */
export function weavePrintSettings(w: WeaveSettings, cfg?: Config): Record<string, string | number | boolean> {
  return {
    spiral_mode: false, wall_loops: 1, sparse_infill_density: 0, top_shell_layers: 0, top_shell_thickness: 0, bottom_shell_layers: 4,
    seam_position: 'aligned', seam_slope_type: 'none',
    // pixel-sized moves: slower outer wall places each bead where the picture wants it
    outer_wall_speed: weaveWallSpeed(cfg), ...(w.mode === 'colour' && w.change.mode === 'bleed' ? { enable_prime_tower: false } : {}),
  };
}
