// NexSpiro Advanced engine: shared types. Everything here is plain data so it can cross the worker boundary.

export type EngineMode = 'basic' | 'advanced';

/** What the user wants the part to be best at. Each intent turns on a set of technologies by default. */
export type IntentId = 'structural' | 'aesthetic' | 'optical' | 'acoustic' | 'morph4d';

/**
 * Zones the router finds on a part. Surface zones colour triangles in the Zone Inspector; volume zones
 * (core, boss hub, neck band, helical band) are voxel masks used while slicing.
 */
export type ZoneKind =
  | 'plain' | 'dome' | 'shallow' | 'curved_wall' | 'overhang' | 'neck' | 'boss'
  | 'helical' | 'core' | 'thin' | 'interface' | 'branch';

export const ZONE_KINDS: ZoneKind[] = ['plain', 'dome', 'shallow', 'curved_wall', 'overhang', 'neck', 'boss', 'helical', 'core', 'thin', 'interface', 'branch'];
export const zoneIndex = (k: ZoneKind) => ZONE_KINDS.indexOf(k);

/** The 35 technologies, in the order of the NexSpiro compendium. */
export type TechId =
  // Part I — core mathematical, field & kinematic slicing
  | 'fea_stress' | 'sdf_frep' | 'eulerian_spiral' | 'conformal_layers' | 'hot_on_hot' | 'kinematic_extrusion'
  // Part II — micro-mechanics, biomimetics & viscoelastic control
  | 'z_weave' | 'subvoxel_aa' | 'turing_infill' | 'corner_overshoot' | 'spatial_lattice' | 'metamaterial' | 'dovetail'
  // Part III — differentiable solvers, PDEs & topological compilers
  | 'sgd_slicing' | 'eikonal_offsets' | 'inverse_warp' | 'gloss_modulation' | 'foam_control' | 'knot_braiding' | 'co_molding'
  // Part IV — seam elimination & surface perfection
  | 'thick_vase' | 'tangent_entry' | 'scarf_splice' | 'harmonic_dome' | 'conformal_ironing' | 'perimeter_feathering' | 'iso_gloss'
  // Part V — higher-dimensional & advanced mathematical engines
  | 'quasicrystal' | 'metric_morph' | 'monge_ampere' | 'symplectic_shaper' | 'morse_router' | 'spinor_fields' | 'band_gap' | 'homogenization';

export type ParamValue = number | boolean | string;
export interface TechOverride { enabled?: boolean; params?: Record<string, ParamValue> }

/** The user-facing tools: each groups the technologies that do the same job behind one toggle. */
export type ToolId =
  | 'surface_smoothing' | 'curved_layers' | 'seam_hiding' | 'spiral_printing' | 'even_walls' | 'gloss_control'
  | 'strength_infill' | 'layer_bonding' | 'stiffness_target' | 'warp_compensation' | 'material_interlock'
  | 'damping_infill' | 'motion_compensation' | 'foaming' | 'special_print';
/** A tool switched by the user: on or off, and which of its technologies run (none listed: the intent's, else all). */
export interface ToolOverride { enabled: boolean; parts?: TechId[] }

/** Grayscale target image for the caustic lens (row-major, 0 = dark, 1 = bright). */
export interface CausticTarget { width: number; height: number; pixels: number[]; throwMm: number; mode: 'lens' | 'lampshade' }

/** Overrides of the machine capability model (anything the printer profile does not know). */
export interface MachineOverrides {
  axes?: number;
  kinematics?: Kinematics;
  inputShaper?: boolean;
  pressureAdvance?: boolean;
  resonanceX?: number;
  resonanceY?: number;
  maxAccelZ?: number;
  maxFlow?: number;
  heatedChamber?: boolean;
  chamberTemp?: number;
  tipLength?: number;
  heaterHalfWidth?: number;
  continuousFiber?: boolean;
  rotaryA?: [number, number];
  rotaryC?: boolean;
}

export type Kinematics = 'corexy' | 'cartesian' | 'bedslinger' | 'delta' | 'five_axis_ac' | 'five_axis_bc';

/** Config sent with each slice in Advanced mode. */
export interface AdvancedConfig {
  intent: IntentId;
  printerId: string;
  techs: Partial<Record<TechId, TechOverride>>;
  /** Tool switches; they decide which technologies run and win over `techs[id].enabled`. */
  tools?: Partial<Record<ToolId, ToolOverride>>;
  machine?: MachineOverrides;
  /** Inferred load case plus optional painted load faces: direction (unit) and total force (N). */
  load?: { dir: [number, number, number]; newtons: number };
  caustic?: CausticTarget;
  /** Field resolution: voxels along the longest side of each object. */
  resolution?: 'draft' | 'normal' | 'fine';
}

/** Per-triangle values for the Zone Inspector. */
export type FieldId = 'zones' | 'thickness' | 'curvature' | 'overhang' | 'stress' | 'harmonic' | 'branch';
export const FIELD_IDS: FieldId[] = ['zones', 'thickness', 'curvature', 'overhang', 'stress', 'harmonic', 'branch'];

export interface ZoneStat { kind: ZoneKind; areaMm2: number; volumeMm3: number; triangles: number }

export interface ObjectAnalysis {
  id: string;
  name: string;
  /** Zone per triangle (index into ZONE_KINDS). */
  triZone: Uint8Array;
  /** Field values per triangle. */
  fields: Partial<Record<FieldId, Float32Array>>;
  /** Range of each field, for the colour scale. */
  ranges: Partial<Record<FieldId, [number, number]>>;
  zones: ZoneStat[];
  /** Interior voxel centres coloured by volume zone (x, y, z, zone) for the inspector's cut-away. */
  voxels: Float32Array;
  /** Branches of the Reeb graph (Morse–Smale router). */
  branches: number;
  /** Betti numbers of the solid (components, tunnels) from persistent homology. */
  betti: [number, number];
  volumeMm3: number;
}

export type TechStatus = 'applied' | 'adapted' | 'idle' | 'disabled' | 'unavailable';

export interface TechReport {
  id: TechId;
  status: TechStatus;
  /** Why it is adapted, idle or unavailable on this machine/part. */
  reason?: string;
  stats?: Record<string, number | string>;
  ms?: number;
}

export interface AdvancedReport {
  intent: IntentId;
  machine: { name: string; kinematics: Kinematics; axes: number; maxSlopeDeg: number; firmware: string; notes: string[] };
  zones: ZoneStat[];
  techs: TechReport[];
  /** Head-clearance check of the non-planar moves (when there were any). */
  clearance?: { checked: number; collisions: number; raised: number; unresolved: number; worst: number; worstLeft: number };
  warnings: string[];
  ms: number;
}
