// Weave mode data model. A picture is woven into the wall the way jacquard vases are: every layer is
// one colour (the colours take turns, layer by layer), and each layer's line is pushed out where the
// picture wants that layer's colour and pulled in where it doesn't. Seen from outside, each pixel
// shows the colour whose layers stand proud. On top of the picture, a wave texture can swing the line
// in and out along the wall, the next layer swinging the other way, which gives the knitted look.
// Plain data only: it travels to the slicing worker and into the project file.
import type { WaveShape } from '../model';

/** colour: one filament per layer, colours take turns · mono: one filament, the picture is relief only. */
export type WeaveMode = 'colour' | 'mono';
/** mono texture: dark pixels get a rough in/out weave, light pixels a smooth wall · emboss: light out, dark in. */
export type MonoStyle = 'texture' | 'emboss';
/** purge: normal flush · reduced: a small flush of `volume_mm3` · bleed: no flush, the new colour prints straight away. */
export type ChangeMode = 'purge' | 'reduced' | 'bleed';
/** stretch: the picture fills the woven band once · tile: rows keep their natural height and repeat. */
export type FitHeight = 'stretch' | 'tile';

/** A picture reduced to palette indices. Row 0 is the top row. */
export interface WeaveImage {
  w: number;
  h: number;
  /** Palette index per pixel, row by row from the top-left. */
  px: number[];
  name?: string;
}

export interface WeaveSeam {
  /** Start and end of every layer are tucked inside the wall, so the start blob and the end tail never show outside. */
  inward: boolean;
  /** Where the seam goes round the part (degrees from +X, counter-clockwise). All layers start on this line. */
  angle_deg: number;
  /** How far inside the wall the start and end are tucked (mm). */
  tuck_mm: number;
}

export interface WeaveSettings {
  enabled: boolean;
  mode: WeaveMode;
  image: WeaveImage;
  /**
   * Filament slot (0-based) for each palette index. In colour mode the layers take these in turn, so the
   * palette order is the layer order. In mono mode only slots[0] is used.
   */
  slots: number[];
  /** Layers in a row of each colour before the next one (1 = a filament change every layer). */
  layers_per_colour: number;
  /** Woven band, plate heights in mm. Below it (the floor) and above it the first colour prints plain. */
  z_start: number;
  z_end: number;
  /** How many times the picture goes round the part. */
  tiles_around: number;
  fit_height: FitHeight;
  /** Measure height along the curve of the wall (bellies and flares), so the picture isn't stretched there. */
  follow_curve: boolean;
  /** How far a showing line stands out (mm). Up to the deviation cap; a high value hangs the thread out in the air (see the drool check). */
  depth_mm: number;
  /** How far a hidden line pulls in, as a share of depth_mm (0..1). */
  recess: number;
  /** Dip between neighbouring pixels (0..1): 0 = one smooth band, higher = separate stitches. */
  stitch: number;
  /** Columns the picture drifts by per row: twists the weave into a spiral. */
  shift_px_per_row: number;
  /** Length (mm) over which the line eases from one pixel to the next. */
  smooth_mm: number;
  /** Cap on the total sideways deviation from the wall (mm): depth, pull-in and hand-made moves together never go past it. */
  max_deviation_mm: number;
  /** Hand-made moves: extra mm out (+) or in (−) for single picture pixels, by pixel number (row × width + column). Only valid for the grid size it was made on. */
  nudge?: { w: number; h: number; d: Record<number, number> };
  seam: WeaveSeam;
  change: { mode: ChangeMode; volume_mm3: number };
  mono_style: MonoStyle;
  /** Depth ladder for a test print: the band is split in 5 steps from 0.5× to 1.5× depth, bottom to top. */
  calibration?: boolean;
  /** Plate object ids the weave goes on; empty or missing = every object. */
  objects?: string[];
  /** Where the picture came from, so the panel can redraw it at a new size or with new colours. */
  picture?: PictureSource;
  /** Wave texture on the whole part (inside the From–To band). Zones (modifier shapes, height bands) add their own. */
  wave?: WeaveWave;
}

/**
 * A wave texture: the line swings in and out along the wall, and the next layer swings the other way,
 * so crest sits over trough and the wall looks knitted.
 */
export interface WaveStyle {
  /** sine: smooth · triangle: pointed · square: blocky · rounded: soft blocks. */
  shape: WaveShape;
  /** How far the line swings either side of the wall (mm). */
  height_mm: number;
  /** Length of one stitch along the wall: one swing out and back (mm). */
  length_mm: number;
  /** Layers between flips; 0 = never flip (the waves stack into vertical ribs). */
  flip_every: number;
  /** How far a flip moves the wave, in degrees of a stitch (180 = crest over trough). */
  flip_deg: number;
  /** alternate: flips back and forth (knit) · steady: keeps sliding the same way (diagonal twill). */
  flip_mode: 'alternate' | 'steady';
}

export interface WeaveWave extends WaveStyle {
  /** Wave on the whole part. Off: only zones that say "wave here" get it. */
  enabled: boolean;
  /** Fade the wave out on thin fins, sharp ribs and tight corners, so they stay smooth. */
  smooth_edges: boolean;
  /** Soft edge (mm) where the wave starts and stops; never shorter than one stitch. */
  blend_mm: number;
}

export interface PictureSource {
  /** none: no picture, the wall stays plain (the wave texture alone, or plain colour stripes). */
  kind: 'motif' | 'image' | 'none';
  /** Motif id (kind = motif). */
  motif?: string;
  dither?: 'none' | 'floyd' | 'ordered';
  /** Mono: grey levels (2..4) and dark/light swapped. */
  levels?: number;
  invert?: boolean;
  /** Pixel width on the part (mm), used by "Fit to part". */
  pixel_mm?: number;
}

export const CALIBRATION_STEPS = [0.5, 0.75, 1, 1.25, 1.5];

export function defaultWeave(): WeaveSettings {
  return {
    enabled: false, mode: 'colour',
    image: { w: 2, h: 2, px: [0, 1, 1, 0], name: 'Checker' },
    slots: [0, 1], layers_per_colour: 1, z_start: 1.2, z_end: 1e4, tiles_around: 1, fit_height: 'stretch', follow_curve: true,
    depth_mm: 0.12, recess: 0.4, stitch: 0.25, shift_px_per_row: 0, smooth_mm: 0.25, max_deviation_mm: 3,
    seam: { inward: true, angle_deg: 90, tuck_mm: 0.8 },
    change: { mode: 'purge', volume_mm3: 30 }, mono_style: 'texture',
    picture: { kind: 'motif', motif: 'checker', dither: 'floyd', levels: 2, pixel_mm: 1.2 },
    wave: defaultWave(),
  };
}

/** A ready-made wave texture, shown as a tile in the panel. */
export interface WavePreset { id: string; name: string; description: string; style: WaveStyle | null }

/** Ready-made textures. Smooth (null) switches the wave off. */
export const WAVE_PRESETS: WavePreset[] = [
  { id: 'smooth', name: 'Smooth', description: 'No texture: the wall stays straight', style: null },
  { id: 'knit', name: 'Knit', description: 'Fine knitted look: every layer waves the other way', style: { shape: 'sine', height_mm: 0.15, length_mm: 2, flip_every: 1, flip_deg: 180, flip_mode: 'alternate' } },
  { id: 'chunky', name: 'Chunky knit', description: 'Big soft stitches, like thick wool', style: { shape: 'sine', height_mm: 0.2, length_mm: 4, flip_every: 1, flip_deg: 180, flip_mode: 'alternate' } },
  { id: 'ribs', name: 'Ribs', description: 'Waves stack straight up into ribs', style: { shape: 'sine', height_mm: 0.25, length_mm: 3, flip_every: 0, flip_deg: 180, flip_mode: 'alternate' } },
  { id: 'twill', name: 'Twill', description: 'Diagonal lines, like denim', style: { shape: 'sine', height_mm: 0.15, length_mm: 2, flip_every: 1, flip_deg: 90, flip_mode: 'steady' } },
  { id: 'zigzag', name: 'Zigzag', description: 'Pointed stitches that cross every layer', style: { shape: 'triangle', height_mm: 0.2, length_mm: 3, flip_every: 1, flip_deg: 180, flip_mode: 'alternate' } },
  { id: 'basket', name: 'Basket', description: 'Square blocks that swap every two layers', style: { shape: 'square', height_mm: 0.2, length_mm: 4, flip_every: 2, flip_deg: 180, flip_mode: 'alternate' } },
];

export function defaultWave(): WeaveWave {
  return { ...WAVE_PRESETS[1].style!, enabled: false, smooth_edges: true, blend_mm: 2 };
}

/** The preset a style matches, if any. */
export function presetOf(s: WaveStyle | null | undefined): string {
  if (!s) return 'smooth';
  const same = (p: WaveStyle) => p.shape === s.shape && Math.abs(p.height_mm - s.height_mm) < 1e-6 && Math.abs(p.length_mm - s.length_mm) < 1e-6
    && p.flip_every === s.flip_every && (p.flip_every === 0 || (p.flip_deg === s.flip_deg && p.flip_mode === s.flip_mode));
  return WAVE_PRESETS.find((p) => p.style && same(p.style))?.id ?? 'custom';
}

/** Palette colours the layers cycle through (colour mode) or 1 (mono). */
export const colourCount = (w: WeaveSettings) => (w.mode === 'colour' ? Math.max(1, w.slots.length) : 1);
/** Layers in one full turn of the colours: one pixel row. Mono mode keeps two (one out, one in). */
export const cycleLayers = (w: WeaveSettings) => Math.max(1, Math.round(w.layers_per_colour)) * (w.mode === 'colour' ? colourCount(w) : 2);
