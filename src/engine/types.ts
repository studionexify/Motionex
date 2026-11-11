// Core engine types. All engine geometry is in millimetres unless noted.
import type { AdvancedConfig, AdvancedReport } from './advanced/types';

/** Clipper integer point (scaled by SCALE). */
export interface IntPoint { X: number; Y: number }
export type Path = IntPoint[];
export type Paths = Path[];

/** A polygon with holes; contour is CCW, holes CW (Clipper convention). */
export interface ExPolygon { contour: Path; holes: Paths }

export type FeatureType =
  | 'outer_wall'
  | 'inner_wall'
  | 'overhang_wall'
  | 'sparse_infill'
  | 'internal_solid_infill'
  | 'top_surface'
  | 'bottom_surface'
  | 'bridge'
  | 'internal_bridge'
  | 'gap_infill'
  | 'ironing'
  | 'skirt'
  | 'brim'
  | 'support'
  | 'support_interface'
  | 'prime_tower'
  | 'travel'
  | 'wave_overhang';

export const FEATURE_LABELS: Record<FeatureType, string> = {
  outer_wall: 'Outer wall',
  inner_wall: 'Inner wall',
  overhang_wall: 'Overhang wall',
  sparse_infill: 'Sparse infill',
  internal_solid_infill: 'Internal solid infill',
  top_surface: 'Top surface',
  bottom_surface: 'Bottom surface',
  bridge: 'Bridge',
  internal_bridge: 'Internal bridge',
  gap_infill: 'Gap infill',
  ironing: 'Ironing',
  skirt: 'Skirt',
  brim: 'Brim',
  support: 'Support',
  support_interface: 'Support interface',
  wave_overhang: 'Wave overhang',
  prime_tower: 'Prime tower',
  travel: 'Travel',
};

/** Polyline in mm, either closed loop or open path. */
export interface Polyline2 { pts: number[]; closed: boolean } // flat [x0,y0,x1,y1,...]

/** One extrusion path, before emission. */
export interface ExtrusionPath {
  feature: FeatureType;
  pts: number[]; // flat xy in mm
  closed: boolean;
  width: number; // mm
  flow?: number; // multiplier
}

/** A single emitted move — the unit of the preview & time estimate. */
export interface Move {
  x: number; y: number; z: number; // end position
  e: number; // extruded filament length for this move (mm, relative)
  f: number; // feedrate mm/s
  feature: FeatureType;
  width: number;
  height: number;
  t: number; // estimated duration (s)
}

export interface LayerResult {
  index: number;
  z: number; // top of layer
  height: number;
  moveStart: number; // index into moves array
  moveEnd: number; // exclusive
  time: number;
}

export type PartType = 'part' | 'negative' | 'modifier' | 'support_enforcer' | 'support_blocker';

export interface PartInput {
  type: PartType;
  /** World-space, indexed. */
  vertices: Float32Array;
  indices: Uint32Array;
  /** Modifier overrides (only MODIFIER_KEYS are honoured). */
  overrides?: Record<string, number | boolean | string>;
  /** Hollow volume (wall cutter / wall shell): triangles from here on are the inner surface; the volume is outer minus inner. */
  innerFrom?: number;
}

/** Per-triangle paint layers. support/seam: 0 none, 1 enforce, 2 block. color: 0 = object filament, n = slot n-1. */
/** adv (Advanced mode): 1 fixture, 2 load face, 3 matte, 4 gloss. */
export interface MeshPaint { support?: Uint8Array; seam?: Uint8Array; color?: Uint8Array; motion?: Uint8Array; adv?: Uint8Array }

export interface MeshInput {
  id: string;
  name: string;
  /** World-space vertex positions (already transformed), indexed. */
  vertices: Float32Array;
  indices: Uint32Array;
  /** 0-based filament slot for this object (default 0). */
  filament?: number;
  /** Per-object setting overrides (only OBJECT_KEYS are honoured). */
  overrides?: Record<string, number | boolean | string>;
  parts?: PartInput[];
  paint?: MeshPaint;
  /** Variable layer height profile: successive layer heights from the bed. */
  layerHeights?: number[];
  /** Named sets of picked triangles (used by plugins such as Motionex). */
  faceSets?: FaceSet[];
  /** Height range modifiers: settings for layers whose top lies in [z0, z1) (object-relative mm). */
  heightRanges?: { z0: number; z1: number; overrides: Record<string, number | boolean | string> }[];
  /** Rotation of the object about Z on the plate (degrees), for "Align directions to model". */
  rotationZ?: number;
  /** Brim ear points painted with the brim ears tool (world XY, mm). */
  brimEars?: [number, number][];
}

export interface FaceSet { id: string; name: string; tris: Uint32Array }

/** Filament slot settings used during emission. */
export interface FilamentSlot {
  name: string;
  type: string;
  color: string;
  diameter: number;
  density: number;
  cost: number;
  nozzleTemp: number;
  nozzleTempInitial: number;
  flowRatio: number;
  maxVolumetricSpeed: number;
  pressureAdvance?: number;
  /** The slot's full filament config (cooling, retraction overrides, scarf, G-code…), see filamentParams.ts. */
  settings?: Record<string, number | boolean | string>;
}

/** Actions inserted at a layer height (from the preview slider). */
export interface LayerAction {
  z: number; type: 'pause' | 'color' | 'custom' | 'config'; filament?: number; gcode?: string;
  /** 'config': a numeric setting changed from this layer on (e.g. nozzle temperature, retraction, speed). */
  key?: string; value?: number;
}

export interface SliceOptions {
  filaments?: FilamentSlot[];
  /** Flush volume (mm³) for each [from][to] filament pair; overrides flush_volume. */
  flushMatrix?: number[][];
  layerActions?: LayerAction[];
  /** Plate filament printing sequence per layer (undefined = Auto). */
  filamentSequence?: import('./toolmap').FilamentSequence;
  /** Mixed filaments (colour mixing); filament index filaments.length + k is mixes[k]. */
  mixes?: import('../profiles/mixing').MixedFilament[];
  /** Config for each enabled plugin, keyed by plugin id (plain data). */
  plugins?: Record<string, unknown>;
  /** A drawn calibration program (PA line / pattern) instead of sliced models. */
  program?: import('./calibGcode').CalibProgram;
  /** Advanced mode (NexSpiro physics core). Undefined: Basic mode, the classic engine only. */
  advanced?: AdvancedConfig;
}

export interface SliceStats {
  timeSeconds: number;
  filamentMm: number;
  filamentGrams: number;
  filamentCost: number;
  layerCount: number;
  toolChanges: number;
  perFilament: { grams: number; mm: number; cost: number }[];
  towerGrams: number;
  byFeature: Partial<Record<FeatureType, { time: number; filamentMm: number; grams?: number }>>;
  /** Filament purged during filament changes (flush), per slot in grams. */
  flushGrams?: number;
  /**
   * The file prints the plate several times (Bulnex: print, eject, repeat). Every other number above and the preview
   * describe ONE print; this is the whole job.
   */
  repeat?: {
    cycles: number;
    partsPerCycle: number;
    /** One print, from the figures above (seconds). */
    perCycleSeconds: number;
    /** Cool-down wait, push strokes and re-heat added around each print (seconds, per cycle). */
    coolSeconds: number; pushSeconds: number; reheatSeconds: number;
    /** Whole job: every print plus every cool-down/push, and every re-heat between prints (the last cycle does not re-heat). */
    totalSeconds: number;
    totalGrams: number; totalMm: number; totalCost: number;
  };
}

export interface SliceOutput {
  gcode: string;
  moves: Float32Array; // packed moves, see packMoves()
  moveFeatures: Uint8Array;
  /** Per move: part fan % and nozzle temperature (stride 2). */
  moveAux?: Float32Array;
  /** Per move: 0-based G-code line the move ends on. */
  moveLines?: Uint32Array;
  /** Per move: wall texture strength 0..255 (Motionex weave wave), for the "Wave area" preview. */
  moveWave?: Uint8Array;
  /** Pauses on the part (x, y, z, seconds), for the Select window's blob marks. */
  pauses?: Float32Array;
  layers: LayerResult[];
  stats: SliceStats;
  warnings: string[];
  /** What each plugin reported (e.g. Motionex print check). */
  pluginReports?: Record<string, unknown>;
  /** What the Advanced engine did (Advanced mode only). */
  advanced?: AdvancedReport;
}

export const FEATURE_ORDER: FeatureType[] = [
  'outer_wall', 'inner_wall', 'overhang_wall', 'sparse_infill', 'internal_solid_infill',
  'top_surface', 'bottom_surface', 'bridge', 'internal_bridge', 'ironing', 'skirt', 'brim', 'support',
  'support_interface', 'travel', 'prime_tower', 'gap_infill', 'wave_overhang',
];
