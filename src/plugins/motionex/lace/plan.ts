// Lace before slicing: the print settings an openwork wall needs, and the strand and hole sizes the
// nozzle in use can really print.
import type { Config } from '../../../profiles/settings';
import type { LaceSettings } from './model';
import { isBowden, outerLineWidth } from '../wall/machine';

/**
 * Two walls (strands of two lines are strong enough to handle), no infill or top skin inside the band,
 * a solid floor, spiral vase off. Inner walls get the same holes when lace goes on every wall. With the
 * print's config: Bowden printers don't retract over the smallest hops (every retraction of a long
 * tube grinds and strings more than a 2 mm travel oozes).
 */
export function lacePrintSettings(l: LaceSettings, cfg?: Config): Record<string, string | number | boolean> {
  return {
    spiral_mode: false, wall_loops: l.walls === 'all' ? 2 : 1, sparse_infill_density: 0, top_shell_layers: 0, top_shell_thickness: 0, bottom_shell_layers: 4,
    seam_position: 'aligned', seam_slope_type: 'none',
    // every hole is a travel: keep retraction short and quick, no Z hop over the wall
    z_hop: 0, wipe: false,
    ...(cfg && isBowden(cfg) ? { retraction_minimum_travel: 2 } : {}),
  };
}

export interface LaceLimits {
  /** Line width the sizes are measured against (mm). */
  lineWidth: number;
  /** Strand between holes as printed: at least two lines (mm). */
  strand_mm: number;
  /** Strands shorter than this are dropped, holes narrower than this filled (mm). */
  min_strand_mm: number;
  min_hole_mm: number;
}

/**
 * Strand and hole sizes for the nozzle in use: a strand is at least two lines wide (one line tears
 * off), a hole at least one line (narrower ones close with ooze). Works the same from 0.2 to 1.0 mm.
 */
export function laceLimits(l: LaceSettings, cfg: Config): LaceLimits {
  const lw = outerLineWidth(cfg);
  return { lineWidth: lw, strand_mm: Math.max(l.strand_mm, 2 * lw), min_strand_mm: Math.max(l.min_strand_mm, 2 * lw), min_hole_mm: Math.max(l.min_hole_mm, lw) };
}
