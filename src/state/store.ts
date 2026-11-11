// Application state (zustand). Scene objects are immutable records; meshes are shared by reference.
import type { PluginStep } from './steps';
import type { CalibProgram } from '../engine/calibGcode';
import type { MeasureFeature, MeasureMode } from './measure';
import type { BrushType } from '../engine/brush';
import { DEFAULT_CONNECTOR, DEFAULT_GROOVE, type ConnectorSettings, type GrooveSettings } from './cutConnectors';
import { create } from 'zustand';
import * as THREE from 'three';
import type { IndexedMesh } from '../engine/mesh';
import type { LayerAction, PartType, SliceOutput } from '../engine/types';
import type { PrimSpec } from './ops';
import type { PlateType } from '../profiles/printers';
import { printerById } from '../profiles/printers';
import { CONFIG_VERSION, migrateConfig, type Config, type ProcessTab } from '../profiles/settings';
import type { ObjectPatternex } from '../plugins/patternex/ui/state';
import { filamentById } from '../profiles/filaments';
import { mixColor, type MixedFilament } from '../profiles/mixing';
import { sanitizeUserPresets, type UserPreset } from '../profiles/userPresets';

export type Workspace = 'workbench' | 'home' | 'prepare' | 'preview' | 'motion' | 'device' | 'project' | 'calibration';
/** Tools the core slicer owns. */
export type CoreTool = 'select' | 'move' | 'rotate' | 'scale' | 'face' | 'paint_support' | 'paint_seam' | 'paint_color' | 'vlh' | 'cut' | 'text' | 'measure' | 'boolean' | 'paint_adv' | 'brim_ears' | 'edges';
/** Tool ids reserved for optional plugins. Core code never depends on them; a plugin registers
 *  its own id here (or the generic `plugin:<name>` form) so a core build compiles without it. */
export type PluginTool = 'paint_motion' | 'pick_motion' | 'lasso_motion' | 'band_motion' | 'object_motion' | 'place_pattern' | 'sculpt_pick' | `plugin:${string}`;
export type Tool = CoreTool | PluginTool;
export type Theme = 'dark' | 'light';
export type ColorScheme = 'feature' | 'filament' | 'wave' | 'speed' | 'height' | 'width' | 'flow' | 'layer_time' | 'layer_time_log' | 'fan' | 'temperature';
const COLOR_SCHEMES: unknown[] = ['feature', 'filament', 'wave', 'speed', 'height', 'width', 'flow', 'layer_time', 'layer_time_log', 'fan', 'temperature'] satisfies ColorScheme[];

export type Vec3 = [number, number, number];
export interface SceneEdgeSel { objectId: string; edges: [number, number][] }

export interface ScenePart {
  id: string;
  name: string;
  type: PartType;
  mesh: IndexedMesh; // local, centred
  position: Vec3; // relative to the object origin (object frame)
  rotation: Vec3;
  scale: Vec3;
  overrides: Config; // modifier settings
  /** Exact shape the mesh was made from (primitives, wall cutters): re-tessellated on scale. */
  prim?: PrimSpec;
}

/** motion: surface sets for plugins such as Motionex (0 none, n = surface set n). adv: Advanced mode (1 fixture, 2 load, 3 matte, 4 gloss). */
export interface ObjectPaint { support?: Uint8Array; seam?: Uint8Array; color?: Uint8Array; motion?: Uint8Array; adv?: Uint8Array }

export interface SceneObject {
  id: string;
  name: string;
  mesh: IndexedMesh; // local coordinates, centred, min z = 0
  position: Vec3; // world (scene) coordinates — plate origin included
  rotation: Vec3; // degrees, XYZ euler
  scale: Vec3;
  openEdges: number;
  filament?: number; // 0-based slot
  overrides?: Config;
  parts?: ScenePart[];
  /** Exact shape the mesh was made from (added primitives): re-tessellated on scale so curves stay within a micron. */
  prim?: PrimSpec;
  paint?: ObjectPaint;
  layerHeights?: number[];
  /** false: kept on the plate but left out of slicing. */
  printable?: boolean;
  /** Patternex artwork on this object (object-local), so undo, project files and object operations carry it. */
  patternex?: ObjectPatternex;
  /** Height range modifiers: their own settings for a band of layers (object-relative mm). */
  heightRanges?: HeightRange[];
  /** Brim ear points painted with the brim ears tool (object-local XY, mm). */
  /** Painted brim ears, object-local points (z kept so tilted objects map correctly). */
  brimEars?: [number, number, number?][];
  /** Hidden in the 3D view (object list eye); still sliced unless not printable. */
  hidden?: boolean;
  /** Plugins that made this object and were applied to it, in order (each can be reopened in its Studio). */
  steps?: PluginStep[];
}

export interface HeightRange { id: string; z0: number; z1: number; overrides: Config }

/** Values found with the Calibration workspace, applied on top of the filament preset. */
export interface FilamentTuning { flowRatio?: number; pressureAdvance?: number; maxVolumetricSpeed?: number; nozzleTemp?: number; retractionLength?: number }
/** A filament slot: preset, colour, the user's own setting edits and calibration results. */
/** planned: a filament a design needs that is not in the machine's holders yet ("load before printing"). */
export interface FilamentSlotState { presetId: string; color: string; tuning?: FilamentTuning; overrides?: Config; planned?: boolean }
export interface ProjectInfo { title: string; author: string; description: string; license: string; notes: string; photos: { name: string; dataUrl: string }[] }
export const emptyProject = (): ProjectInfo => ({ title: '', author: '', description: '', license: '', notes: '', photos: [] });
/** A build plate. bedType / spiralVase override the global settings for this plate (undefined = same as global). */
export interface Plate {
  id: string; name: string; layerActions: LayerAction[];
  /** Locked plates are skipped by arrange and auto orient. */
  locked?: boolean;
  bedType?: PlateType;
  spiralVase?: boolean;
  /** Print sequence of this plate (undefined = same as global). */
  printSequence?: 'by_layer' | 'by_object';
  /** Drawn calibration program printed instead of the plate's objects (PA line / pattern). */
  program?: CalibProgram;
  /** Filament printing sequence for the first / other layers and layer ranges (undefined = Auto), like Bambu's plate setting. */
  filamentSequence?: import('../engine/toolmap').FilamentSequence;
}

/** Right-click menu: where it opened and what was under the cursor. */
export interface ContextMenuState { x: number; y: number; kind: 'plate' | 'object' | 'part'; plate: number; id?: string; partId?: string; world?: [number, number] }

export interface SliceState {
  status: 'idle' | 'slicing' | 'done' | 'error';
  stage: string;
  progress: number;
  result: SliceOutput | null;
  error: string | null;
  dirty: boolean; // scene/settings changed since last slice
  plate: number; // plate index the result belongs to
}

interface State {
  theme: Theme;
  workspace: Workspace;
  tool: Tool;
  objects: SceneObject[];
  selected: string[];
  selectedPart: string | null;
  /** Height range modifier being edited (object id is the single selection). */
  selectedRange: string | null;
  shortcutsOpen: boolean;
  /** Preview: show only the top layer (L), the bottom layer it replaced, the G-code beside the move slider. */
  oneLayer: boolean;
  savedLow?: number;
  showGcode: boolean;
  undoStack: SceneObject[][];
  redoStack: SceneObject[][];

  plates: Plate[];
  activePlate: number;

  printerId: string;
  plate: PlateType;
  filaments: FilamentSlotState[];
  /** Mixed filaments (colour mixing); numbered after the physical filaments. */
  mixes: MixedFilament[];
  presetId: string;
  overrides: Config;
  /** Saved user process presets and the one last applied / saved (null = a system preset). */
  userPresets: UserPreset[];
  userPresetId: string | null;
  machineOverrides: Config;
  processTab: ProcessTab;
  processMode: 'global' | 'objects';
  showAdvanced: boolean;
  search: string;
  showOverhangs: boolean;
  /** Draw feature edges (creases, open borders, colour and face boundaries) on the models. */
  showEdges: boolean;
  /** Smooth shading across faces that bend less than edgeAngle (looks like a rounded body; geometry is unchanged). */
  shadeSmooth: boolean;
  /** Dihedral angle (degrees) from which an edge counts as a crease. */
  edgeAngle: number;
  /** Edges picked with the Edges tool, by vertex pair of one object's mesh. */
  edgeSel: SceneEdgeSel | null;

  brushSize: number; // mm
  brushType: BrushType;
  /** Smart fill: largest angle between neighbouring triangles the fill crosses (°). */
  smartFillAngle: number;
  /** Gap fill: largest unpainted area filled (mm²). */
  gapArea: number;
  /** Overhang highlight angle in support painting (°). */
  paintOverhangAngle: number;
  paintColor: number; // 1-based slot for colour painting
  /** Surface set being picked/painted for plugins (1-based). */
  motionSet: number;
  /** Click-to-pick spreads across edges flatter than this (degrees). */
  motionGrowAngle: number;
  /** Draw tool shape for Motionex: freehand lasso or a box. */
  motionDraw: 'lasso' | 'box';
  /** Installed plugins (ids) and the right dock. */
  plugins: string[];
  dock: { open: boolean; width: number; tab: string };
  overhangOnly: boolean;

  slice: SliceState;
  colorScheme: ColorScheme;
  /** Printers the user owns: the only ones listed in the right-panel printer picker. Empty = not chosen yet. */
  myPrinters: string[];
  hiddenFeatures: string[];
  showTravel: boolean;
  layerRange: [number, number];
  moveCursor: number; // index within top layer, -1 = all
  toast: { kind: 'info' | 'error' | 'warn'; text: string; action?: { label: string; run: () => void } } | null;
  project: ProjectInfo;
  /** Flushing volumes [from][to] in mm³; null = calculated from the filament colours. */
  flushMatrix: number[][] | null;
  flushMultiplier: number;
  /** Cut tool plane: world height and tilt (degrees). */
  cutPlane: { height: number; tiltX: number; tiltY: number };
  /** Cut connectors placed on the cut plane (plane coordinates), the connector settings and the placing mode. */
  cutConnectors: { x: number; y: number }[];
  cutConnector: ConnectorSettings;
  cutConnectorMode: boolean;
  /** Cut preview fragments right-clicked over to the other side ('a<k>' / 'b<k>'). */
  cutSwap: string[];
  /** Scale tool: uniform scaling (panel fields and gizmo handles). */
  uniformScale: boolean;
  cutMode: 'planar' | 'dovetail';
  cutGroove: GrooveSettings;
  /** Measure tool: picked world points (up to 2). */
  measureFeatures: MeasureFeature[];
  measureMode: MeasureMode;
  /** Arrange settings: spacing between objects, try rotations, where the group goes. */
  arrangeSettings: { spacing: number; rotate: boolean; align: 'center' | 'x' | 'y' };
  /** Surface point picked for Text / SVG volumes. */
  surfacePick: { objId: string; point: Vec3; normal: Vec3 } | null;
  contextMenu: ContextMenuState | null;
  /** Draw the plugins' quick motion preview on the model in Prepare (no slicing). */
  liveToolpaths: boolean;
  /** Draw the quick toolpath view as real-size threads (true) or single lines (false). */
  threadView: boolean;

  set: (p: Partial<State>) => void;
  addObjects: (o: SceneObject[]) => void;
  updateObjects: (fn: (o: SceneObject) => SceneObject, ids?: string[], record?: boolean) => void;
  removeSelected: () => void;
  duplicateSelected: () => void;
  checkpoint: () => void;
  undo: () => void;
  redo: () => void;
  setOverride: (key: string, v: Config[string] | undefined) => void;
  setMachine: (key: string, v: Config[string] | undefined) => void;
  /** `stay`: keep the Preview open (layer pauses / colour changes are made there). */
  markDirty: (stay?: boolean) => void;
}

/** Edge selection that was active when an undo snapshot was taken (keyed by the snapshot), so Undo brings the picked edges back. */
export const edgeSelHistory = new WeakMap<object, SceneEdgeSel | null>();

/** Hook run on every changed object (ops.ts registers primitive re-tessellation; kept out of here to avoid an import cycle). */
let shapeRefresher: (o: SceneObject) => SceneObject = (o) => o;
export const setShapeRefresher = (fn: (o: SceneObject) => SceneObject) => { shapeRefresher = fn; };

let idSeq = 0;
export const newId = (p = 'obj') => `${p}${Date.now().toString(36)}${(idSeq++).toString(36)}`;

const clonePlain = <T,>(v: T): T => (v === undefined || v === null ? v : typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v)));
const cloneTyped = (a?: Uint8Array) => (a ? a.slice() : a);

/**
 * A full copy of an object with everything edited on it: parts (positive, negative, modifiers, enforcers, blockers),
 * settings, paint, artwork, layer heights, height ranges, brim ears. Parts and height ranges get fresh ids; meshes are
 * immutable and shared by reference. `over` is applied last (name, position ...).
 */
export function cloneObject(o: SceneObject, over: Partial<SceneObject> = {}): SceneObject {
  const id = over.id ?? newId();
  const c: SceneObject = {
    ...o,
    id,
    position: [...o.position] as Vec3, rotation: [...o.rotation] as Vec3, scale: [...o.scale] as Vec3,
    overrides: o.overrides ? { ...o.overrides } : undefined,
    parts: o.parts?.map((p) => ({ ...p, id: newId('part'), position: [...p.position] as Vec3, rotation: [...p.rotation] as Vec3, scale: [...p.scale] as Vec3, overrides: { ...p.overrides } })),
    paint: o.paint ? { support: cloneTyped(o.paint.support), seam: cloneTyped(o.paint.seam), color: cloneTyped(o.paint.color), motion: cloneTyped(o.paint.motion), adv: cloneTyped(o.paint.adv) } : undefined,
    layerHeights: o.layerHeights ? [...o.layerHeights] : undefined,
    heightRanges: o.heightRanges?.map((r) => ({ ...r, id: newId('hr'), overrides: { ...r.overrides } })),
    brimEars: o.brimEars?.map((e) => [...e] as [number, number, number?]),
    patternex: o.patternex ? clonePlain(o.patternex) : undefined,
  };
  if (c.patternex) c.patternex = { ...c.patternex, placements: c.patternex.placements.map((p: any) => ({ ...p, object_id: id })) };
  return { ...c, ...over, id };
}

const LS = 'nexspiro.prefs.v1';
const loadPrefs = (): any => {
  try { return JSON.parse(localStorage.getItem(LS) ?? '{}'); } catch { return {}; }
};
const LS_USER_PRESETS = 'nexspiro.userPresets.v1';
function loadUserPresets(): UserPreset[] {
  try {
    if (typeof localStorage === 'undefined') return [];
    const d = JSON.parse(localStorage.getItem(LS_USER_PRESETS) ?? '{}');
    return sanitizeUserPresets(d.presets).map((p) => ({ ...p, overrides: migrateConfig(p.overrides, d.configVersion ?? CONFIG_VERSION) }));
  } catch { return []; }
}
const prefs = typeof localStorage !== 'undefined' ? loadPrefs() : {};
const systemTheme: Theme = typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
const defaultFilaments = (): FilamentSlotState[] => {
  if (Array.isArray(prefs.filaments) && prefs.filaments.length) return prefs.filaments;
  const id = prefs.filamentId ?? 'generic-pla';
  return [{ presetId: id, color: prefs.filamentColor ?? filamentById(id).color }];
};

/** After undo / redo: keep only the selected objects (and part) that still exist. */
function liveSelection(selected: string[], part: string | null, objects: SceneObject[]) {
  const ids = new Set(objects.map((o) => o.id));
  return { selected: selected.filter((id) => ids.has(id)), selectedPart: part && objects.some((o) => o.parts?.some((p) => p.id === part)) ? part : null };
}

export const useStore = create<State>((set, get) => ({
  theme: (prefs.theme as Theme) ?? systemTheme,
  workspace: 'workbench',
  tool: 'select',
  objects: [],
  selected: [],
  selectedPart: null,
  selectedRange: null,
  shortcutsOpen: false,
  oneLayer: false,
  showGcode: false,
  undoStack: [],
  redoStack: [],

  plates: [{ id: 'plate1', name: 'Plate 1', layerActions: [] }],
  activePlate: 0,
  project: emptyProject(),
  flushMatrix: null,
  flushMultiplier: 1,
  cutPlane: { height: 10, tiltX: 0, tiltY: 0 },
  cutConnectors: [],
  cutConnector: DEFAULT_CONNECTOR,
  cutConnectorMode: false,
  cutSwap: [],
  uniformScale: true,
  cutMode: 'planar',
  cutGroove: DEFAULT_GROOVE,
  measureFeatures: [],
  measureMode: 'auto',
  arrangeSettings: { spacing: 6, rotate: false, align: 'center' },
  surfacePick: null,
  contextMenu: null,
  liveToolpaths: !!prefs.liveToolpaths,
  threadView: prefs.threadView !== false,

  printerId: prefs.printerId ?? 'bbl-p1s',
  plate: (prefs.plate as PlateType) ?? 'textured_pei_plate',
  filaments: defaultFilaments(),
  mixes: Array.isArray(prefs.mixes) ? prefs.mixes : [],
  presetId: prefs.presetId ?? '0.20',
  overrides: migrateConfig(prefs.overrides, prefs.configVersion ?? 1),
  userPresets: loadUserPresets(),
  userPresetId: typeof prefs.userPresetId === 'string' ? prefs.userPresetId : null,
  machineOverrides: prefs.machineOverrides ?? {},
  processTab: 'Quality',
  processMode: 'global',
  showAdvanced: false,
  search: '',
  showOverhangs: false,
  showEdges: false,
  shadeSmooth: true,
  edgeAngle: 30,
  edgeSel: null,

  brushSize: 4,
  brushType: 'circle',
  smartFillAngle: 30,
  gapArea: 2,
  paintOverhangAngle: 30,
  paintColor: 2,
  motionSet: 1,
  motionGrowAngle: 15,
  motionDraw: 'lasso',
  plugins: Array.isArray(prefs.plugins) ? prefs.plugins : [],
  dock: { open: true, width: 340, tab: 'motionex', ...(prefs.dock ?? {}) },
  overhangOnly: false,

  slice: { status: 'idle', stage: '', progress: 0, result: null, error: null, dirty: true, plate: 0 },
  // real filament colours by default: what the print will look like (line types are one click away)
  colorScheme: COLOR_SCHEMES.includes(prefs.colorScheme) ? prefs.colorScheme : 'filament',
  myPrinters: Array.isArray(prefs.myPrinters) ? prefs.myPrinters.filter((x: unknown) => typeof x === 'string') : [],
  hiddenFeatures: [],
  showTravel: false,
  layerRange: [0, 0],
  moveCursor: -1,
  toast: null,

  set: (p) => set(p),
  checkpoint: () => set((s) => ({ undoStack: [...s.undoStack.slice(-49), s.objects], redoStack: [] })),
  addObjects: (o) => {
    get().checkpoint();
    o = o.map(saneTransform);
    set((s) => ({ objects: [...s.objects, ...o], selected: o.map((x) => x.id), selectedPart: null }));
    get().markDirty();
  },
  updateObjects: (fn, ids, record = true) => {
    if (record) get().checkpoint();
    const sel = new Set(ids ?? get().selected);
    set((s) => ({ objects: s.objects.map((o) => (sel.has(o.id) ? shapeRefresher(saneTransform(fn(o))) : o)) }));
    get().markDirty();
  },
  removeSelected: () => {
    const s = get();
    if (s.selectedPart) {
      s.checkpoint();
      const pid = s.selectedPart;
      set((st) => ({ objects: st.objects.map((o) => (o.parts?.some((p) => p.id === pid) ? { ...o, parts: o.parts.filter((p) => p.id !== pid) } : o)), selectedPart: null }));
      s.markDirty();
      return;
    }
    const sel = new Set(s.selected);
    if (!sel.size) return;
    s.checkpoint();
    set((st) => ({ objects: st.objects.filter((o) => !sel.has(o.id)), selected: [] }));
    s.markDirty();
  },
  duplicateSelected: () => {
    const sel = get().objects.filter((o) => get().selected.includes(o.id));
    if (!sel.length) return;
    const copies = sel.map((o) => cloneObject(o, { name: `${o.name} (copy)`, position: [o.position[0] + 10, o.position[1] + 10, o.position[2]] as Vec3 }));
    get().addObjects(copies);
  },
  undo: () => {
    const s = get();
    if (!s.undoStack.length) return;
    const back = s.undoStack[s.undoStack.length - 1];
    set({ objects: back, undoStack: s.undoStack.slice(0, -1), redoStack: [...s.redoStack, s.objects], edgeSel: edgeSelHistory.get(back) ?? null, ...liveSelection(s.selected, s.selectedPart, back) });
    get().markDirty();
  },
  redo: () => {
    const s = get();
    if (!s.redoStack.length) return;
    const fwd = s.redoStack[s.redoStack.length - 1];
    set({ objects: fwd, redoStack: s.redoStack.slice(0, -1), undoStack: [...s.undoStack, s.objects], edgeSel: null, ...liveSelection(s.selected, s.selectedPart, fwd) });
    get().markDirty();
  },
  setOverride: (key, v) => {
    set((s) => {
      const o = { ...s.overrides };
      if (v === undefined) delete o[key]; else o[key] = v;
      return { overrides: o };
    });
    get().markDirty();
  },
  setMachine: (key, v) => {
    set((s) => {
      const o = { ...s.machineOverrides };
      if (v === undefined) delete o[key]; else o[key] = v;
      return { machineOverrides: o };
    });
    get().markDirty();
  },
  // a change after slicing makes the preview a lie: send the user back to Prepare so they must slice again
  markDirty: (stay) => set((s) => ({ ...(s.slice.dirty ? {} : { slice: { ...s.slice, dirty: true } }), ...(!stay && s.workspace === 'preview' && s.slice.status !== 'slicing' ? { workspace: 'prepare' as Workspace } : {}) })),
}));

// persist preferences
let lastUserPresets: UserPreset[] | null = null;
useStore.subscribe((s) => {
  try {
    localStorage.setItem(LS, JSON.stringify({
      theme: s.theme, printerId: s.printerId, plate: s.plate, filaments: s.filaments, mixes: s.mixes,
      presetId: s.presetId, overrides: s.overrides, machineOverrides: s.machineOverrides,
      plugins: s.plugins, dock: s.dock, liveToolpaths: s.liveToolpaths, threadView: s.threadView, colorScheme: s.colorScheme, myPrinters: s.myPrinters, configVersion: CONFIG_VERSION, userPresetId: s.userPresetId,
    }));
    if (s.userPresets !== lastUserPresets) {
      lastUserPresets = s.userPresets;
      localStorage.setItem(LS_USER_PRESETS, JSON.stringify({ configVersion: CONFIG_VERSION, presets: s.userPresets }));
    }
  } catch { /* storage unavailable */ }
});

// ----- plates
export const PLATE_GAP = 40;
export const PLATE_COLS = 4;
export function plateOrigin(index: number, printerId: string): [number, number] {
  const p = printerById(printerId);
  return [(index % PLATE_COLS) * (p.bed.x + PLATE_GAP), -Math.floor(index / PLATE_COLS) * (p.bed.y + PLATE_GAP)];
}
/** Plate index containing a world XY point (nearest plate cell). */
export function plateAt(x: number, y: number, printerId: string, plateCount: number): number {
  const p = printerById(printerId);
  let best = 0, bd = Infinity;
  for (let i = 0; i < plateCount; i++) {
    const [ox, oy] = plateOrigin(i, printerId);
    const cx = ox + p.bed.x / 2, cy = oy + p.bed.y / 2;
    const d = Math.max(Math.abs(x - cx) - p.bed.x / 2, 0) ** 2 + Math.max(Math.abs(y - cy) - p.bed.y / 2, 0) ** 2 + ((x - cx) ** 2 + (y - cy) ** 2) * 1e-6;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}
export function objectPlate(o: SceneObject, printerId: string, plateCount: number): number {
  const b = worldBounds(o);
  return plateAt((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, printerId, plateCount);
}

// ----- geometry helpers on scene objects
export function trsMatrix(o: { position: Vec3; rotation: Vec3; scale: Vec3 }): THREE.Matrix4 {
  const d = Math.PI / 180;
  return new THREE.Matrix4().compose(
    new THREE.Vector3(...o.position),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(o.rotation[0] * d, o.rotation[1] * d, o.rotation[2] * d, 'XYZ')),
    new THREE.Vector3(...o.scale),
  );
}
export const objectMatrix = (o: Pick<SceneObject, 'position' | 'rotation' | 'scale'>) => trsMatrix(o);
export const partWorldMatrix = (o: SceneObject, p: ScenePart) => trsMatrix(o).multiply(trsMatrix(p));

export function worldBounds(o: SceneObject) {
  const m = objectMatrix(o).elements;
  const v = o.mesh.vertices;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < v.length; i += 3) {
    const x = v[i], y = v[i + 1], z = v[i + 2];
    const w = [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
    for (let k = 0; k < 3; k++) { if (w[k] < min[k]) min[k] = w[k]; if (w[k] > max[k]) max[k] = w[k]; }
  }
  return { min, max };
}

/** Smallest scale an object or part keeps (0.1 %): a scale of 0 flattens the model, and the next uniform scale divides by it. */
export const MIN_SCALE = 1e-3;
const saneVec = (v: Vec3, fallback: number, scale: boolean): Vec3 | null => {
  let out: Vec3 | null = null;
  for (let k = 0; k < 3; k++) {
    let x = v[k];
    if (!Number.isFinite(x)) x = fallback;
    else if (scale && Math.abs(x) < MIN_SCALE) x = x < 0 ? -MIN_SCALE : MIN_SCALE;
    if (x !== v[k]) { out ??= [...v] as Vec3; out[k] = x; }
  }
  return out;
};
/**
 * The object with a usable transform: non-finite position / rotation become 0, non-finite scale 1, and no scale
 * reaches 0 (a gizmo dragged through its centre or a typed 0 % used to leave NaN geometry that could not be sliced).
 * Returns the same object when nothing needed fixing.
 */
export function saneTransform<T extends { position: Vec3; rotation: Vec3; scale: Vec3; parts?: ScenePart[] }>(o: T): T {
  const pos = saneVec(o.position, 0, false), rot = saneVec(o.rotation, 0, false), sc = saneVec(o.scale, 1, true);
  let parts = o.parts;
  if (parts?.length) {
    const fixed = parts.map((p) => saneTransform(p));
    if (fixed.some((p, k) => p !== parts![k])) parts = fixed;
  }
  if (!pos && !rot && !sc && parts === o.parts) return o;
  return { ...o, ...(pos ? { position: pos } : {}), ...(rot ? { rotation: rot } : {}), ...(sc ? { scale: sc } : {}), ...(parts !== o.parts ? { parts } : {}) };
}

/** Shift z so the object rests on the bed. */
export function dropToBed(o: SceneObject): SceneObject {
  const b = worldBounds(o);
  if (!Number.isFinite(b.min[2])) return o; // no finite vertex: nothing to rest on the bed
  return { ...o, position: [o.position[0], o.position[1], o.position[2] - b.min[2]] };
}

export function isOutOfBounds(o: SceneObject, printerId: string, plateCount = 1): boolean {
  const p = printerById(printerId);
  const b = worldBounds(o);
  const [ox, oy] = plateOrigin(objectPlate(o, printerId, plateCount), printerId);
  const e = 0.01;
  return b.min[0] - ox < -e || b.min[1] - oy < -e || b.max[0] - ox > p.bed.x + e || b.max[1] - oy > p.bed.y + e || b.max[2] > p.bed.z + e;
}

export const slotColor = (s: State | ReturnType<typeof useStore.getState>, k: number) => {
  const m = k >= s.filaments.length ? s.mixes?.[k - s.filaments.length] : undefined;
  if (m) return mixColor(m, s.filaments.map((f) => f.color));
  return s.filaments[Math.min(k, s.filaments.length - 1)]?.color ?? '#5DBE7A';
};
/** Colours of every filament an object or paint can use: physical slots, then mixed filaments. */
export const choiceColors = (s: State | ReturnType<typeof useStore.getState>) => [...s.filaments.map((f) => f.color), ...(s.mixes ?? []).map((m) => mixColor(m, s.filaments.map((f) => f.color)))];
