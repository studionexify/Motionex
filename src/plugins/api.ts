// Nexspiro plugin API.
// A plugin can (1) add material regions before walls are generated, (2) shape each filament change,
// (3) change finished toolpaths (post-toolpath, pre-G-code), (4) rewrite the program body (e.g. repeat it)
// and (5) add a panel to the right dock.
// Nexspiro always writes the G-code: plugins only add regions and edit the move list that Nexspiro then emits.
import type { Config } from '../profiles/settings';
import type { ChangerKind } from '../profiles/changer';
import type { LayerOps } from '../engine/gcode';
import type { MeshInput, Paths } from '../engine/types';
import type { PatternexRegion } from './motionex/core/regions';

export type { PatternexRegion };

/** A set of picked surfaces on one object, sliced into per-layer outlines (plate mm). */
export interface FaceRegion {
  /** "objectId:setId" */
  id: string;
  name: string;
  /** Outline polygons of the picked surfaces at a layer, as [x, y] lists in plate mm. */
  polygonsAt(layer: number): [number, number][][];
}

export interface PluginContext {
  cfg: Config;
  /** Layer tops in mm, one per layer. */
  layerZ: number[];
  faceRegions: FaceRegion[];
  /** Regions published by plugins in prepare() (spec: Patternex owns geometry, Motionex consumes it). */
  sharedRegions: PatternexRegion[];
  /** What this plugin's prepare() returned, if anything. */
  session?: PluginSession;
  /** Messages shown to the user after slicing. */
  warn(message: string): void;
}

/** Inputs for the pre-perimeter stage. Paths are Clipper integer paths (mm × SCALE). */
export interface PrepareContext {
  cfg: Config;
  meshes: MeshInput[];
  layerZ: number[];
  layerH: number[];
  /** Slice plane per layer. */
  planes: number[];
  /** Cross-section of one object at a layer. */
  sliceAt(object: number, layer: number): Paths;
  /** Filament slots available for this print. */
  filamentCount: number;
  /** Filament changes are automatic (a filament unit or a tool changer). */
  hasAms: boolean;
  /** How the printer changes filament (missing = from hasAms). */
  changer?: ChangerKind;
  /** Heads on a tool changer (1 otherwise). */
  toolheads?: number;
  warn(message: string): void;
}

/** One material region added before perimeters: replaces whatever material was there. */
export interface RegionContribution { regionId: string; fil: number; paths: Paths }

/** Comment written before each change a plugin planned; post-passes find changes by it. */
export const TRANSITION_MARKER = '; PATTERNEX_CHANGE';

/** How a filament change is done. Omitted fields keep Nexspiro's defaults. */
export interface TransitionPlan {
  /** Purge volume (mm³) for this change, replacing the flushing matrix value. */
  flushVolume?: number;
  /** Skip the prime-tower band for this change (no purge). */
  skipTower?: boolean;
  /** Move the change point along the toolpath (mm): + earlier (new colour starts sooner), − later. */
  shiftMm?: number;
  /** Region the change belongs to, for reports. */
  regionId?: string;
  /** Single-colour printers: what to load, shown on the printer display before the pause. */
  label?: string;
}

/** Print settings for part of a layer (sparse infill keys, like a modifier volume). */
export interface ModifierContribution { overrides: Record<string, unknown>; paths: Paths }

export interface PluginSession {
  /**
   * Geometry: change an object's cross-section before anything else uses it (raised / recessed artwork).
   * `slice` is the unmodified cross-section; return it unchanged when nothing applies.
   */
  reshape?(object: number, layer: number, slice: Paths): Paths;
  regionsAt?(object: number, layer: number): RegionContribution[];
  /** Sparse-infill settings inside regions (applied like modifier volumes). */
  modifiersAt?(object: number, layer: number): ModifierContribution[];
  transition?(t: { layer: number; from: number; to: number; flushVolume?: number }): TransitionPlan | undefined;
  /** Overhang areas (Clipper paths, plate) on a layer that must not get support (e.g. printed mid-air by the plugin). */
  supportBlockersAt?(layer: number): Paths;
  /** Regions to share with other plugins (published before postToolpath runs). */
  sharedRegions?(): PatternexRegion[];
}

/** Engine side of a plugin. Runs inside the slicing worker, so its config must be plain data. */
export interface EnginePlugin<C = unknown, R = unknown> {
  id: string;
  name: string;
  version: string;
  /** Before perimeters: set up regions and transitions for this slice. */
  prepare?(config: C, ctx: PrepareContext): PluginSession | undefined;
  /** Edits the ordered move list in place. Returns a report for the UI (plain data). */
  postToolpath(layers: LayerOps[], config: C, ctx: PluginContext): R;
  /**
   * Whole-program pass: rewrite the G-code lines between the start and end macros (e.g. repeat the
   * print). Runs after every plugin's postToolpath, in plugin order.
   */
  programBody?(body: string[], config: C, ctx: PluginContext): string[];
  /** Comment lines for the G-code header. */
  gcodeHeader?(config: C): string[];
}
