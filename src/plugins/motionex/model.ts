// Motionex data model (spec §5). Field names follow the spec so brush JSON is portable.

export type Interpolation = "bezier" | "linear" | "step";

/** Handles are offsets [dt, dv] relative to their point. */
export interface CurvePoint { t: number; v: number; in_handle: [number, number]; out_handle: [number, number] }
export interface Curve { points: CurvePoint[]; interpolation: Interpolation }

export type RepeatMode = "tile" | "once" | "stretch";
export type CurveKey = "lateral_offset" | "along_offset" | "z_offset" | "extrusion_mult" | "speed_mult";

export type EventType = "dwell" | "flow_change" | "retract";

/**
 * Something that happens at a spot in each repeat.
 * dwell: { ms, blob_mm3 } pause, optionally pushing out a blob · flow_change: { mult } plastic amount from here on ·
 * retract: { length, travel_mm } lift off (pull filament back), move without printing, then carry on.
 */
export interface MotionEvent {
  at: { mode: "percent" | "mm"; value: number };
  type: EventType;
  params: Record<string, number>;
  once?: boolean;
}

export interface NoiseSettings { enabled: boolean; type: "value"; seed: number; scale: number; octaves: number; persistence: number }

export type LayerMode = "steady" | "alternate" | "back_and_forth" | "shift_hold" | "wave";
/** Shape of the lead/lag swing in "wave" mode, over one full swing: lead, back through 0, lag, back. */
export type WaveShape = "sine" | "triangle" | "rounded" | "square" | "ramp";

/** How the motion changes from one layer to the next. Builds diamonds, bricks, twists and bands. */
export interface LayerEffect {
  /** Degrees of the repeat to shift by at each step. */
  shift_deg: number;
  /** steady: keep shifting (twist) · alternate: swap between 0 and shift · back_and_forth: shift up, then back down ·
   *  shift_hold: like back_and_forth but pauses at both ends (with cross: six-sided cells) ·
   *  wave: swings smoothly between leading by shift_deg and lagging by lag_deg, one full swing every `every` layers. */
  mode: LayerMode;
  /** Layers per step (wave: layers per full swing). */
  every: number;
  /** alternate / wave: how far the lagging layers fall behind (degrees, ≥ 0). alternate without it swaps between 0 and shift. */
  lag_deg?: number;
  /** wave: shape of the swing (default sine). */
  wave_shape?: WaveShape;
  /** Motion is on for band_on layers then off for band_off layers; 0 = always on. */
  band_on: number;
  band_off: number;
  /** Draw the motion slanting both ways at once (average of +shift and −shift): diamond and lattice grids. */
  cross?: boolean;
}

export interface MotionBrush {
  id: string;
  name: string;
  version: number;
  /** Peak lateral offset in mm for a curve value of 1. */
  amplitude: number;
  period_mm: number;
  /** Phase in degrees (0–360) of the period. */
  phase_deg: number;
  repeat_mode: RepeatMode;
  curves: Record<CurveKey, Curve>;
  events: MotionEvent[];
  /** Up-and-down movement in mm for a Z curve value of 1 (0 = flat). */
  z_amplitude?: number;
  noise: NoiseSettings | null;
  limits: { min_flow_mult: number; max_flow_mult: number };
  layers?: LayerEffect | null;
  tags?: string[];
  /** Rounds sharp corners of the shape (square teeth, steps) over this many mm along the wall; 0 = crisp. */
  round_mm?: number;
  /** Library group shown in the picker, e.g. "Waves". */
  category?: string;
  /** One plain-language line shown under the name. */
  description?: string;
}

/**
 * What a motion does on loops too small for it (the tip of a cone or pyramid).
 * fade: shrink it to fit · off: leave those loops plain · full: always full size (may fold over itself).
 * share: how much of the loop's inner radius the motion may use (0.05–1).
 */
export interface TipControl { mode: "fade" | "off" | "full"; share: number }
export const DEFAULT_TIP: TipControl = { mode: "fade", share: 0.3 };

/** "body": the whole model; "faces": only the surfaces picked in the 3D view (face sets). */
export type TargetType = "body" | "faces";
/** Which wall lines a motion moves: the outer wall line, the inner wall lines, or every wall. */
export type WallChoice = "outer" | "inner" | "all";

const WALL_FEATURES: Record<WallChoice, string[]> = {
  outer: ["outer_wall", "overhang_wall"],
  inner: ["inner_wall"],
  all: ["outer_wall", "overhang_wall", "inner_wall"],
};
export const wallMatches = (walls: WallChoice, feature: string) => WALL_FEATURES[walls].includes(feature);

export interface MotionApplication {
  brush_id: string;
  /** faces: face-set ids ("objectId:setId") the motion is limited to. */
  target: { type: TargetType; walls: WallChoice; faces?: string[] };
  mask: {
    z_start: number; z_end: number; fade_in_mm: number; fade_out_mm: number;
    /** Wall slope range in degrees (0 = straight up, + leans out). Omit for all slopes. */
    angle_min?: number; angle_max?: number;
    /** Soft edge in mm at region borders. */
    blend_mm?: number;
  };
  order: number;
  blend: "add" | "override";
  enabled: boolean;
  /** Size slider: scales wave height and wave length together (1 = as designed). */
  scale?: number;
  /** Behaviour on small loops; omitted = DEFAULT_TIP. */
  tip?: TipControl;
  /** Round the motion's sharp corners over this many mm (overrides the motion's own setting). */
  round_mm?: number;
  /** Optional name shown in the list. */
  label?: string;
  /** Surface set (1..n) this motion's picked faces are stored in; the panel keeps one per motion. */
  surface?: number;
  /** This placement's own edited copy of the motion (from the Motion tab); the library one is left as it is. */
  brush?: MotionBrush;
}

export const CURVE_KEYS: CurveKey[] = ["lateral_offset", "along_offset", "z_offset", "extrusion_mult", "speed_mult"];

export const CURVE_INFO: Record<CurveKey, { label: string; unit: string; neutral: number; min: number; max: number; enabled: boolean }> = {
  lateral_offset: { label: "Side to side", unit: "in and out from the wall", neutral: 0, min: -1, max: 1, enabled: true },
  along_offset: { label: "Forward and back", unit: "ahead of or behind the nozzle", neutral: 0, min: -1, max: 1, enabled: true },
  z_offset: { label: "Up and down", unit: "× up-and-down height", neutral: 0, min: -1, max: 1, enabled: true },
  extrusion_mult: { label: "Plastic amount", unit: "1 = normal", neutral: 1, min: 0, max: 3, enabled: true },
  speed_mult: { label: "Speed", unit: "1 = normal", neutral: 1, min: 0.1, max: 2, enabled: true },
};

export function flatCurve(v: number): Curve {
  return { interpolation: "linear", points: [pt(0, v), pt(1, v)] };
}

export function pt(t: number, v: number, inH: [number, number] = [0, 0], outH: [number, number] = [0, 0]): CurvePoint {
  return { t, v, in_handle: inH, out_handle: outH };
}
