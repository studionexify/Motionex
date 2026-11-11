// Lace (perforated wall) data model. Holes are cut into the walls by the toolpath itself: where the
// pattern is open the nozzle stops extruding and travels across, so a single-wall vase becomes openwork.
// Every hole is made printable without support: its top closes at most at the overhang angle (or is
// short enough to bridge), and every strand stands on the layer below. Works on any FDM printer.
import type { FitHeight, PictureSource, WeaveImage } from '../weave/model';

export type LaceSource = 'pattern' | 'image';

export interface LaceSettings {
  enabled: boolean;
  source: LaceSource;
  /** Pattern id (see patterns.ts). */
  pattern: string;
  /** Cell size of the pattern: width round the part and height up it (mm). */
  cell_w: number;
  cell_h: number;
  /** Solid lace between neighbouring holes (mm). */
  strand_mm: number;
  /** Hole size inside its cell (0..1). */
  open: number;
  /** Holes grow (+) or shrink (−) up the band, -1..1. */
  grade: number;
  /** Turns the pattern round the part over the band (degrees): spiral lattices. */
  twist_deg: number;
  /** Seed for random patterns (Voronoi). */
  seed: number;
  /** Picture source (image mode): dark = open. Row 0 = top. */
  image: WeaveImage;
  picture?: PictureSource;
  tiles_around: number;
  fit_height: FitHeight;
  follow_curve: boolean;
  /** Openwork band (plate mm). Below it the floor and wall stay solid; above it the rim. */
  z_start: number;
  z_end: number;
  /** Solid rim kept under the top of the part (mm). */
  rim_mm: number;
  /** Steepest a hole's top may close (degrees from vertical): steeper tops are drawn out into points. */
  overhang_deg: number;
  /** Widest gap the line may bridge flat (mm). */
  bridge_mm: number;
  /** Strands shorter than this are left out, holes narrower than this are filled (mm). */
  min_strand_mm: number;
  min_hole_mm: number;
  /** Which walls get the holes: the outer wall only (inner walls stay solid behind) or every wall. */
  walls: 'all' | 'outer';
  /** Retract across holes (off: just travel, for very small holes or filaments that string little). */
  retract: boolean;
  objects?: string[];
}

export function defaultLace(): LaceSettings {
  return {
    enabled: false, source: 'pattern', pattern: 'diamond',
    cell_w: 8, cell_h: 10, strand_mm: 1.6, open: 0.85, grade: 0, twist_deg: 0, seed: 7,
    image: { w: 2, h: 2, px: [0, 1, 1, 0], name: 'Checker' },
    picture: { kind: 'motif', motif: 'checker', dither: 'none', levels: 2, pixel_mm: 3 },
    tiles_around: 1, fit_height: 'stretch', follow_curve: true,
    z_start: 4, z_end: 1e4, rim_mm: 4,
    overhang_deg: 45, bridge_mm: 3, min_strand_mm: 1.2, min_hole_mm: 1.2,
    walls: 'all', retract: true,
  };
}
