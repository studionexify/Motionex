// Patternex data model (spec §5). Plain data only: everything here crosses into the slicing worker.

/** A closed ring as [x, y] points in pattern mm. No repeated closing point. */
export type Ring = [number, number][];
export type FillRule = 'nonzero' | 'evenodd';

export interface PatternShape {
  /** Rings of one shape; holes are decided by fill_rule, not by winding order alone. */
  polygon_rings: Ring[];
  /** Normalised '#rrggbb'. Shapes sharing a colour form one region group. */
  fill_color: string;
  fill_rule: FillRule;
}

export interface Pattern {
  id: string;
  name: string;
  source: 'svg' | 'builtin';
  shapes: PatternShape[];
  /** Curve-to-polyline tolerance used when the pattern was built. */
  tolerance_mm: number;
  /** Bounding box of all shapes in pattern mm: [minX, minY, maxX, maxY]. */
  bounds: [number, number, number, number];
  /** Fixed placement origin in pattern mm (brush strokes grow without moving what is already painted). Default: bounds centre. */
  origin?: [number, number];
  /** How the pattern was made, so the tool that made it can edit it again. */
  meta?: PatternMeta;
}

/** Source settings of generated artwork (text, codes, braille, brush, trace, tiling). Plain data. */
export type PatternMeta =
  | { kind: 'text'; spec: unknown }
  | { kind: 'code'; spec: unknown }
  | { kind: 'braille'; spec: unknown }
  | { kind: 'brush'; strokes: { pts: [number, number][]; width: number; color: string }[] }
  | { kind: 'trace'; spec: unknown }
  | { kind: 'tile'; spec: unknown; base: string }
  | { kind: 'chart'; spec: import('./chart').ChartSpec };

export type Projection = 'planar' | 'cylindrical';
/** Region depth: follow the outer wall thickness, reuse mmu_paint_depth, or a fixed value. */
export type DepthMode = 'outer_wall' | 'paint_depth' | 'fixed';

export interface Placement {
  id: string;
  pattern_id: string;
  /** "objectId:triangleIndex" of the face the pattern was dropped on. */
  anchor_face_ref: string;
  position_xyz: [number, number, number];
  /** Rotation about the projection direction, degrees. */
  rotation: number;
  scale_xy: [number, number];
  flip: boolean;
  projection: Projection;
  projection_axis: [number, number, number];
  depth_mode: DepthMode;
  /** Used when depth_mode is 'fixed'. */
  depth_mm: number;
  through: boolean;
  locked: boolean;
  visible: boolean;
  /** Surface-angle filter: only surfaces within this angle (degrees) of the projection get the artwork. Default ~78°. */
  max_angle?: number;
}

export type PurgeMode = 'full' | 'reduced' | 'none';

export interface RegionAction {
  region_ref: { placement_id: string; color_group?: string; shape_ids?: number[] };
  /**
   * slot: 0-based filament slot (AMS loads it automatically).
   * manual: single-colour printers — the slot still names the colour; swap_label is shown at the pause.
   * keep: no material change (relief or print effects only).
   */
  material: { mode: 'slot' | 'manual' | 'keep'; slot_index: number; swap_label?: string };
  purge: { mode: PurgeMode; volume_mm3?: number; change_point_shift_mm: number };
  motion: { motionex_brush_id: string } | null;
  /** Geometry instead of (or as well as) colour: raised or recessed by height_mm. Single-colour printers use this for text and logos. */
  relief?: { mode: 'raise' | 'recess'; height_mm: number } | null;
  /** Print settings inside the region (multiplier/overrides; omitted = object settings). */
  effects?: RegionEffects | null;
  /** Mix two filaments: the region alternates between slot_index and this slot. */
  dither?: { slot_index: number; ratio: number; mode: 'layer' | 'line' } | null;
}

export interface RegionEffects {
  /** Speed factor for moves in the region (0.2–1.5). */
  speed?: number;
  /** Fuzzy skin on the outer wall inside the region. */
  fuzzy?: boolean;
  /** Sparse infill density in the region (%), and pattern. */
  infill_density?: number;
  infill_pattern?: string;
  /** Translucent filament: 100% aligned infill, slower, so light passes evenly. */
  transparency?: boolean;
}

export interface ResolvedRegion {
  region_id: string;
  layer_range: [number, number];
  /** Per-layer masks in plate mm (sparse: only layers inside layer_range that hit). */
  masks: Record<number, Ring[]>;
  action_ref: string | null;
}

export interface PatternexProject {
  patterns: Pattern[];
  placements: Placement[];
  actions: RegionAction[];
}

export function boundsOf(shapes: PatternShape[]): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of shapes) for (const r of s.polygon_rings) for (const [x, y] of r) {
    if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y;
  }
  return isFinite(x0) ? [x0, y0, x1, y1] : [0, 0, 0, 0];
}

/** Region groups by fill colour (spec §3.1): colour → shape indices, in first-seen order. */
export function colorGroups(p: Pattern): Map<string, number[]> {
  const out = new Map<string, number[]>();
  p.shapes.forEach((s, i) => { const l = out.get(s.fill_color); if (l) l.push(i); else out.set(s.fill_color, [i]); });
  return out;
}

/** Default placement for a pattern dropped on a face. */
export function newPlacement(id: string, pattern: Pattern, anchor: string, at: [number, number, number], normal: [number, number, number]): Placement {
  return {
    id, pattern_id: pattern.id, anchor_face_ref: anchor, position_xyz: at, rotation: 0, scale_xy: [1, 1], flip: false,
    projection: 'planar', projection_axis: normal, depth_mode: 'outer_wall', depth_mm: 1.5, through: false, locked: false, visible: true,
  };
}

/** Effective depth in mm for a placement, from the slicing config. */
export function placementDepth(p: Placement, cfg: Record<string, unknown>): number {
  if (p.depth_mode === 'fixed') return Math.max(0.05, p.depth_mm);
  if (p.depth_mode === 'paint_depth') return Number(cfg.mmu_paint_depth) || 1.5;
  const nozzle = Number(cfg.nozzle_diameter) || 0.4;
  return Number(cfg.outer_wall_line_width) || Number(cfg.line_width) || nozzle * 1.05;
}
