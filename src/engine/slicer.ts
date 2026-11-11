// The NexSpiro slicing pipeline (stages 2–10). Pure TypeScript, runs in a Web Worker or Node.
import { smoothPaths } from './outlineSmooth';
import { calibProgram } from './calibGcode';
import { slice as advancedSlice } from './advanced/classic/slicer';
import { floatOrPercent, HEIGHT_RANGE_KEYS, MODIFIER_KEYS, OBJECT_KEYS, WAVE_KEYS, type Config } from '../profiles/settings';
import {
  area, bounds, clipLines, difference, exToPaths, intersection, offset, opening, SCALE, toExPolygons, union,
} from './clipper';
import { ANCHORED_PATTERNS, concentricFill, gyroidFill, linesFill, sparseFill, surfaceFill, type SparsePattern } from './fill';
import { emit, expandMacro, type LayerOps, type Op } from './gcode';
import { flushSplit, inZone, renderVendor, usesVendorTemplates } from './templateVars';
import type { IndexedMesh } from './mesh';
import { orderLayerTools } from './toolmap';
import { orderPaths, pickSeam, rotateLoop, simplify, type SeamHints, type SeamMode } from './order';
import { mixProblems, mixSubSlots, resolveFilament, subPassCount } from '../profiles/mixing';
import { colorRegionsAtZ, footprintsInBand, paintedTris, pointsAtZ, type PaintedTri } from './paint';
import { sliceMesh, type SlicingMode } from './slice';
import { preparePlugins, programBodyPlugins, runPlugins } from '../plugins/engine';
import { TRANSITION_MARKER, type FaceRegion, type TransitionPlan } from '../plugins/api';
import { changerOf, flushesIntoTower, slotCount, toolheadCount } from '../profiles/changer';
import { computeOverhangs, filterOverhangs, generateSupport, generateTreeSupport, treeStyle } from './support';
import { decimateLoop, enforceFirstLayers, organicTipSpacing, sharpCorners, smallSupportSpeed } from './supportExtras';
import { anchorInfill, archimedeanFill, cubicFill, honeycombFill } from './patterns';
import { lightningInfill } from './lightning';
import {
  adaptiveGyroid, adaptiveShells, bridgeAngle, bridgeWidth, CENTRED_PATTERNS, centredSurface, DEFAULT_FLOW_MODEL, directionalShrink, expandTop, extraSparseFill,
  EXTRA_SPARSE, flowModel, gyroidZFactor, honeycombTops, inFrame, internalBridges, smoothCorners, SYMMETRIC_PATTERNS, templateAngle,
} from './infillOptions';
import { fuzzLoop, ripplePhase, type FuzzyMode, type NoiseType } from './noise';
import { isSmoothLoop, loopLength, scarfLoop, seamGapLoop } from './seam';
import { TravelPlanner } from './travel';
import { islandWalls, type IslandWalls, type WallItem } from './walls';
import { applyConicalOverhang, applyPolyholes, nearestObjectOrder, overhangsBy, PointGrid, reverseKeepStart, unsupportedFraction } from './wallParity';
import { interlockRegions } from './interlock';
import { smoothOverhangRuns } from './overhangRuns';
import type { ExPolygon, FeatureType, FilamentSlot, MeshInput, PartInput, Paths, Polyline2, SliceOptions, SliceOutput } from './types';
import { pushAll } from './util';
import { checkInputs } from './validate';
import { calibTopOrder, combinedTowerHeights, coneBody, farthestPoint, loadUnloadFlush, minimalPurge, mmuLoad, mmuUnload, multitoolRam, multitoolRamming, rotatePathsAbout, rotatorAbout, towerBandsPerLayer, towerTuning, type TowerCtx } from './wipeTower';
import type { BulnexReport } from '../plugins/bulnex/model';


export type ProgressFn = (stage: string, pct: number) => void;

/** One extrusion path on its way to G-code. Per-point arrays describe the segment that ends at that point. */
interface PathItem extends Polyline2 {
  feature: FeatureType; width: number; flow: number;
  spiral?: boolean; widths?: number[];
  /** Approach the start from this far beyond it, along the line (monotonic line travel extend, mm). */
  leadIn?: number;
  /** Depth below the layer top, as a fraction of the layer height (scarf seam ramp). */
  depth?: number[];
  /** Flow multipliers (scarf seam, fuzzy skin extrusion mode). */
  flows?: number[];
  /** Line type per segment (overhang walls inside a wall loop). */
  feats?: FeatureType[];
  /** Speed caps per segment (overhang speed curve). */
  speeds?: number[];
  /** Part fan at least this % per segment (overhang fan). */
  fans?: number[];
  /** Speed cap for the whole path (small perimeters, vertical shells, floating shells). */
  speed?: number;
  fanMin?: number;
  fanSet?: number;
  /** Extrusion height when it differs from the layer height (infill combination). */
  height?: number;
  /** Exact speed for the whole path (filament ironing speed). */
  speedSet?: number;
  /** Printed in the order generated, not re-sorted (top / bottom surface fill order). */
  keepOrder?: boolean;
  noSlow?: boolean;
  /** Filament slot the path is printed with (feature filaments); -1 = any (flush into this object). */
  fil?: number;
  hole?: boolean;
  wallDepth?: number;
  /** Prime (deretract) here, inside the part, before moving onto the start (wipe before external loop). */
  primeAt?: [number, number];
  /** Object a per-object skirt belongs to. */
  owner?: number;
  /** Step here, inside the part, right after the path ends (wipe on loops). */
  wipeIn?: [number, number];
  /** Wipe inward: the wipe trail is shifted this far to the left of the path (mm, signed). */
  wipeShift?: number;
}

const spacingOf = (w: number, h: number) => w - h * (1 - Math.PI / 4);
/** Infill printed in passes with "Apply subdivision to infill". */
const SUB_FILL = new Set<FeatureType>(['sparse_infill', 'internal_solid_infill']);
/** Overhang degrees (fraction of the line width hanging over the layer below) that start a new speed step. */
const OVERHANG_LEVELS = [0.1, 0.25, 0.5, 0.75, 1];

/** Per point flow of a closed loop (last point = back at the start): `f(fraction of the length)`. */
function spiralRamp(pts: number[], f: (t: number) => number): number[] {
  const n = pts.length / 2;
  let tot = 0;
  for (let k = 0; k < n; k++) tot += Math.hypot(pts[((k + 1) % n) * 2] - pts[k * 2], pts[((k + 1) % n) * 2 + 1] - pts[k * 2 + 1]);
  const out = [f(0)];
  let run = 0;
  for (let k = 1; k <= n; k++) { run += Math.hypot(pts[(k % n) * 2] - pts[(k - 1) * 2], pts[(k % n) * 2 + 1] - pts[(k - 1) * 2 + 1]); out.push(f(tot > 0 ? run / tot : 1)); }
  return out;
}

function pathToPoly(p: Paths[number]): number[] {
  const out: number[] = [];
  for (const q of p) out.push(q.X / SCALE, q.Y / SCALE);
  return out;
}


/** Even-odd point-in-polygons test with the edges bucketed by Y, for many queries against the same outline. */
function insideTester(paths: Paths): (x: number, y: number) => boolean {
  const ex: number[] = [];
  let y0 = Infinity, y1 = -Infinity;
  for (const p of paths) for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    ex.push(p[j].X, p[j].Y, p[i].X, p[i].Y);
    y0 = Math.min(y0, p[i].Y); y1 = Math.max(y1, p[i].Y);
  }
  const m = ex.length / 4;
  if (!m) return () => false;
  const B = Math.max(1, Math.min(512, m >> 2)), bh = Math.max(1, (y1 - y0) / B);
  const bins: number[][] = Array.from({ length: B }, () => []);
  for (let e = 0; e < m; e++) {
    const lo = Math.min(ex[e * 4 + 1], ex[e * 4 + 3]), hi = Math.max(ex[e * 4 + 1], ex[e * 4 + 3]);
    for (let b = Math.max(0, Math.floor((lo - y0) / bh)); b <= Math.min(B - 1, Math.floor((hi - y0) / bh)); b++) bins[b].push(e * 4);
  }
  return (x, y) => {
    const X = x * SCALE, Y = y * SCALE;
    if (Y < y0 || Y > y1) return false;
    let inside = false;
    for (const e of bins[Math.min(B - 1, Math.floor((Y - y0) / bh))]) {
      const ax = ex[e], ay = ex[e + 1], bx = ex[e + 2], by = ex[e + 3];
      if ((ay > Y) !== (by > Y) && X < ((bx - ax) * (Y - ay)) / (by - ay) + ax) inside = !inside;
    }
    return inside;
  };
}

const rectPath = (x0: number, y0: number, x1: number, y1: number) => [
  { X: Math.round(x0 * SCALE), Y: Math.round(y0 * SCALE) }, { X: Math.round(x1 * SCALE), Y: Math.round(y0 * SCALE) },
  { X: Math.round(x1 * SCALE), Y: Math.round(y1 * SCALE) }, { X: Math.round(x0 * SCALE), Y: Math.round(y1 * SCALE) },
];

const circlePath = (x: number, y: number, r: number, seg = 32) => {
  const p = [];
  for (let k = 0; k < seg; k++) { const a = (k / seg) * Math.PI * 2; p.push({ X: Math.round((x + r * Math.cos(a)) * SCALE), Y: Math.round((y + r * Math.sin(a)) * SCALE) }); }
  return p;
};

function mulberry(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (o: Record<string, unknown> | undefined, keys: string[]) =>
  Object.fromEntries(Object.entries(o ?? {}).filter(([k]) => keys.includes(k))) as Config;

const polyLen = (pts: number[], closed = false) => {
  let s = 0;
  for (let k = 2; k < pts.length; k += 2) s += Math.hypot(pts[k] - pts[k - 2], pts[k + 1] - pts[k - 1]);
  if (closed && pts.length >= 4) s += Math.hypot(pts[0] - pts[pts.length - 2], pts[1] - pts[pts.length - 1]);
  return s;
};

/** Twice the signed area of a closed polyline (positive = counter clockwise). */
const signedArea2 = (pts: number[]) => {
  let a = 0;
  for (let k = 0, n = pts.length; k < n; k += 2) { const j = (k + 2) % n; a += pts[k] * pts[j + 1] - pts[j] * pts[k + 1]; }
  return a;
};
/** Reverses a closed loop in place of its point order (x, y pairs), keeping the first point first. */
const reverseLoop = (pts: number[]) => {
  const out = [pts[0], pts[1]];
  for (let k = pts.length - 2; k >= 2; k -= 2) out.push(pts[k], pts[k + 1]);
  return out;
};
/** Moves the start of a closed loop `d` mm backwards along it (staggered inner seams). */
export function shiftLoopStart(pts: number[], d: number): number[] {
  const n = pts.length / 2;
  if (n < 3 || d <= 0) return pts;
  let left = d % Math.max(1e-9, polyLen(pts, true));
  for (let k = 0; k < n; k++) {
    const a = (n - k) % n, b = (n - k - 1 + n) % n;
    const ax = pts[a * 2], ay = pts[a * 2 + 1], bx = pts[b * 2], by = pts[b * 2 + 1];
    const seg = Math.hypot(bx - ax, by - ay);
    if (seg >= left - 1e-9) {
      const t = seg > 0 ? left / seg : 0;
      const sx = ax + (bx - ax) * t, sy = ay + (by - ay) * t;
      // new loop: the cut point, then a → … around to b
      const out = [sx, sy];
      for (let m = 0; m < n; m++) { const q = (a + m) % n; out.push(pts[q * 2], pts[q * 2 + 1]); if (q === b) break; }
      return t >= 1 - 1e-9 ? out.slice(2) : out;
    }
    left -= seg;
  }
  return pts;
}

/**
 * "Insert solid layers": whether 1-based layer n is printed solid. "N" = every Nth layer, "N#K" = K layers every N
 * ("5#" is "5#1"), or a comma list of layer numbers.
 */
export function solidLayerRule(rule: string): (n: number) => boolean {
  const r = rule.trim();
  if (!r) return () => false;
  const m = /^(\d+)\s*(?:#\s*(\d*))?$/.exec(r);
  if (m && !r.includes(',')) {
    const every = Number(m[1]), k = m[2] === undefined ? 1 : Math.max(1, Number(m[2]) || 1);
    if (every <= 0) return () => false;
    return (n) => n > 0 && ((n - 1) % every) >= every - k;
  }
  const set = new Set(r.split(',').map((x) => Number(x.trim())).filter((x) => Number.isFinite(x) && x > 0));
  return (n) => set.has(n);
}

/**
 * Filament shrinkage compensation: each object is scaled up by 100 / shrink in X and Y (about its own centre) and by
 * 100 / shrink (Z) in Z (from the bed), so it cools down to its modelled size. Objects that need no scaling are kept.
 */
export function shrinkCompensate(meshes: MeshInput[], filCfg: (m: MeshInput) => Config, cfg: Config): MeshInput[] {
  return meshes.map((m) => {
    const fc = filCfg(m);
    const pct = (k: string) => { const v = Number(fc[k] ?? cfg[k] ?? 100); return v >= 50 && v <= 150 ? v : 100; };
    const sxy = 100 / pct('filament_shrink'), sz = 100 / pct('filament_shrinkage_compensation_z');
    if (Math.abs(sxy - 1) < 1e-9 && Math.abs(sz - 1) < 1e-9) return m;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let k = 0; k < m.vertices.length; k += 3) { x0 = Math.min(x0, m.vertices[k]); x1 = Math.max(x1, m.vertices[k]); y0 = Math.min(y0, m.vertices[k + 1]); y1 = Math.max(y1, m.vertices[k + 1]); }
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const scale = (v: Float32Array) => {
      const out = new Float32Array(v.length);
      for (let k = 0; k < v.length; k += 3) { out[k] = cx + (v[k] - cx) * sxy; out[k + 1] = cy + (v[k + 1] - cy) * sxy; out[k + 2] = v[k + 2] * sz; }
      return out;
    };
    return { ...m, vertices: scale(m.vertices), parts: m.parts?.map((p) => ({ ...p, vertices: scale(p.vertices) })) };
  });
}

/** Filament slot derived from the flat config (single-material default). */
export function slotFromConfig(cfg: Config): FilamentSlot {
  return {
    name: String(cfg.filament_settings_id ?? 'Filament'), type: String(cfg.filament_type ?? 'PLA'), color: String(cfg.filament_colour ?? '#5DBE7A'),
    diameter: Number(cfg.filament_diameter ?? 1.75), density: Number(cfg.filament_density ?? 1.24), cost: Number(cfg.filament_cost ?? 20),
    nozzleTemp: Number(cfg.nozzle_temperature ?? 210), nozzleTempInitial: Number(cfg.nozzle_temperature_initial_layer ?? 210),
    flowRatio: Number(cfg.filament_flow_ratio ?? 1), maxVolumetricSpeed: Number(cfg.filament_max_volumetric_speed ?? 15),
  };
}

interface Island { obj: number; fil: number; ex: ExPolygon; walls: IslandWalls; /** Subdivided mix: slot of each pass, bottom → top (the last is `fil`). */ sub?: number[] }
interface Regions {
  top: Paths; bottom: Paths; bridge: Paths; solid: Paths; sparse: Paths;
  sparseMods: { paths: Paths; density: number; pattern: SparsePattern; speed?: number; angle?: number }[];
  /** Solid infill added by "Ensure vertical shell thickness" (vertical shell speed). */
  vshell: Paths;
  /** Solid infill resting on sparse infill (detect floating vertical shells: bridge speed). */
  floating: Paths;
  /** Solid layer right under a top surface (sub-top pattern). */
  subTop: Paths;
  /** Sparse infill printed for the layers of an infill-combination block, at the block's combined height. */
  combined?: { paths: Paths; height: number };
  /** Precomputed sparse infill lines (lightning, adaptive / support cubic). */
  lines?: Polyline2[];
  /** Internal bridges: solid infill over the sparse infill of the layer below. */
  ibridge?: Paths;
  /** Extra bridge layers: the layer over an external (or internal) bridge, printed as a second bridge. */
  bridge2?: { paths: Paths; internal: boolean }[];
}

/**
 * Settings of the Advanced engine's frozen classic core under the names it reads: keys the Basic settings renamed
 * are filled from their new equivalents (or the old defaults), so Advanced output does not depend on the rename.
 */
export function legacyConfig(cfg: Config): Config {
  const fuzzy = cfg.fuzzy_skin === 'allwalls' ? 'all' : cfg.fuzzy_skin;
  return {
    ...cfg,
    label_objects: cfg.label_objects ?? cfg.exclude_object ?? true,
    reduce_infill_retraction: cfg.reduce_infill_retraction ?? (cfg.reduce_infill_retraction_mode !== undefined ? cfg.reduce_infill_retraction_mode !== 'disabled' : true),
    overhang_speed: cfg.overhang_speed ?? (Number(cfg.overhang_3_4_speed) || 30),
    flow_ratio_scale: cfg.flow_ratio_scale ?? 1,
    ...(fuzzy !== undefined ? { fuzzy_skin: fuzzy } : {}),
  };
}

/** Pressure advance command for the firmware flavour. */
export const paLine = (flavor: string, k: number) => (flavor === 'klipper' ? `SET_PRESSURE_ADVANCE ADVANCE=${k}` : `M900 K${k}`);

export function slice(meshes: MeshInput[], cfg: Config, progress: ProgressFn = () => {}, opts: SliceOptions = {}): SliceOutput {
  if (opts.program) return calibProgram(cfg, opts.filaments?.length ? opts.filaments : [slotFromConfig(cfg)], opts.program);
  // inputs an edit can break (NaN from a 0 % scale, a model under the bed, a bad layer profile) are repaired or
  // explained first; valid input passes through untouched
  const checked = checkInputs(meshes);
  const out = sliceChecked(checked.meshes, cfg, progress, opts);
  const extra = checked.warnings.filter((w) => !out.warnings.includes(w));
  if (!out.stats.filamentMm && checked.meshes.some((m) => m.indices.length)) {
    extra.push('Nothing will be printed: no layer has a printable line. The model may be thinner than a line width, smaller than a layer, not a closed solid, or cut away by a negative part.');
  }
  return extra.length ? { ...out, warnings: [...out.warnings, ...extra] } : out;
}

function sliceChecked(meshes: MeshInput[], cfg: Config, progress: ProgressFn, opts: SliceOptions): SliceOutput {
  // drawn calibration programs need no slicing; otherwise Advanced mode is a separate engine (its own frozen
  // classic core plus the physics modules) and Basic mode is this one
  if (opts.advanced) return advancedSlice(meshes, legacyConfig(cfg), progress, opts);
  // values changed mid-print by 'config' layer actions (calibration towers etc.)
  const live: Record<string, number> = {};
  const num = (k: string) => (k in live ? live[k] : Number(cfg[k] ?? 0));
  const str = (k: string) => String(cfg[k] ?? '');
  const bool = (k: string) => cfg[k] === true;
  const warnings: string[] = [];
  const warn = (msg: string) => { if (!warnings.includes(msg)) warnings.push(msg); };
  const rnd = mulberry(42);
  const filaments = opts.filaments?.length ? opts.filaments : [slotFromConfig(cfg)];
  const clampFil = (f: number) => Math.max(0, Math.min(filaments.length - 1, f | 0));
  meshes = shrinkCompensate(meshes, (m) => filaments[clampFil(m.filament ?? 0)]?.settings ?? cfg, cfg);
  // mixed filaments (colour mixing): indices after the physical slots resolve to a physical slot per layer
  const mixes = opts.mixes ?? [];
  const usedMixes = new Set<number>();
  const objHeightT: (Float32Array | undefined)[] = [];
  /** Height fraction (0 bottom … 1 top) of each layer within object o; -1 off the object (gradient mixes). */
  const heightT = (o: number) => {
    let t = objHeightT[o];
    if (t) return t;
    const sl = objSlices[o] ?? [];
    let lo = -1, hi = -1;
    for (let i = 0; i < N; i++) if (sl[i]?.length) { if (lo < 0) lo = i; hi = i; }
    t = new Float32Array(N).fill(-1);
    for (let i = Math.max(0, lo); lo >= 0 && i <= hi; i++) t[i] = hi > lo ? (zs[i] - zs[lo]) / (zs[hi] - zs[lo]) : 0;
    return (objHeightT[o] = t);
  };
  const filAt = (f: number, i: number, o: number) => {
    const v = f | 0;
    if (v >= filaments.length && mixes[v - filaments.length]) usedMixes.add(v - filaments.length);
    return clampFil(resolveFilament(v, i, filaments.length, mixes, mixes[v - filaments.length]?.kind === 'gradient' ? heightT(o) : undefined));
  };
  // Subdivide Mix Layer (Snapmaker Orca's experimental colour mixing): mix areas print their outer wall (and with
  // "Apply subdivision to infill" their infill) in thinner passes, one filament per pass, inside each layer.
  // Without "Full domain" only objects whose own filament is a mix are subdivided; with it painted mixes and
  // colour changes to a mix are too.
  const subOn = bool('mix_subdivide') && !bool('spiral_mode'), subFull = bool('mix_subdivide_full_domain'), subInfill = bool('mix_subdivide_infill');
  type FilRegion = { fil: number; paths: Paths; sub?: number[] };
  const regionOf = (f: number, i: number, o: number, src: 'object' | 'paint' | 'change'): { fil: number; sub?: number[] } => {
    const v = f | 0, k = v - filaments.length, m = k >= 0 ? mixes[k] : undefined;
    if (m && subOn && i > objStart && (src === 'object' || subFull) && !mixProblems(m, filaments.length).length) {
      const n = subPassCount(m, hs[i]);
      if (n >= 2) {
        usedMixes.add(k);
        const sub = mixSubSlots(m, i, n, m.kind === 'gradient' ? heightT(o) : undefined).map(clampFil);
        if (new Set(sub).size > 1) return { fil: sub[n - 1], sub };
        return { fil: sub[0] };
      }
    }
    return { fil: filAt(v, i, o) };
  };
  const nozzle = num('nozzle_diameter');
  const vase = bool('spiral_mode');
  const flavor = str('gcode_flavor');
  const changer = changerOf(cfg);
  // automatic changes: a filament unit (AMS) or a tool changer; manual changes pause for a spool swap
  const hasAms = changer !== 'manual';
  const toolChanger = changer === 'toolchanger';
  // a filament unit without a purge chute (MMU3, ERCF, BoxTurtle…) flushes the old colour into the prime tower
  const towerFlush = flushesIntoTower(cfg);
  const byObject = str('print_sequence') === 'by_object' && meshes.length > 1;

  // ---------- per-object config, with height range modifiers
  const objBase: Config[] = meshes.map((m) => ({ ...cfg, ...pick(m.overrides, OBJECT_KEYS) }));
  const rangeCache = new Map<string, Config>();

  // ---------- layer plan (raft, variable layer height, precise Z)
  const lw0 = (k: string) => Number(cfg[k] ?? 0) || Number(cfg.line_width ?? 0) || nozzle * 1.05;
  const h0 = num('initial_layer_print_height');
  const hN = num('layer_height');
  let maxZ = 0;
  for (const m of meshes) for (let i = 2; i < m.vertices.length; i += 3) maxZ = Math.max(maxZ, m.vertices[i]);
  if (maxZ <= 0) throw new Error('Nothing to slice: the plate is empty.');
  const raftN = vase ? 0 : Math.max(0, Math.round(num('raft_layers')));
  const raftHs: number[] = Array.from({ length: raftN }, (_, k) => (k === 0 ? h0 : hN));
  const raftTop = raftHs.reduce((a, b) => a + b, 0);
  const shift = raftN ? raftTop + num('raft_contact_distance') : 0;
  const objZs: number[] = [], objHs: number[] = [];
  const profile = vase ? undefined : meshes.find((m) => m.layerHeights?.length)?.layerHeights;
  let z = 0;
  if (profile) {
    if (meshes.filter((m) => m.layerHeights?.length).length > 1) warn('Several objects have variable layer heights; the first profile is used for the whole plate.');
    for (const h of profile) {
      if (z + h * 0.5 >= maxZ) break;
      z = +(z + h).toFixed(4); objZs.push(z); objHs.push(h);
    }
  } else { const first = raftN ? hN : h0; z = first; objZs.push(z); objHs.push(first); }
  while (z + hN * 0.5 < maxZ) { z = +(z + hN).toFixed(4); objZs.push(z); objHs.push(hN); }
  if (bool('precise_z_height') && objZs.length > 1 && Math.abs(objZs[objZs.length - 1] - maxZ) > 1e-4) {
    // land the last layer exactly on the model top: spread the difference over the last two layers
    const minH = Math.max(0.04, num('min_layer_height') || hN * 0.5), maxH = Math.max(minH, num('max_layer_height') || hN * 1.5);
    const n = objZs.length;
    const top2 = maxZ - (n > 2 ? objZs[n - 3] : 0);
    const each = top2 / 2;
    if (each >= minH && each <= maxH) {
      objHs[n - 2] = each; objHs[n - 1] = top2 - each;
      objZs[n - 2] = +((n > 2 ? objZs[n - 3] : 0) + each).toFixed(4); objZs[n - 1] = +maxZ.toFixed(4);
    }
  }
  const zs: number[] = [], hs: number[] = [];
  let rz = 0;
  for (const h of raftHs) { rz = +(rz + h).toFixed(4); zs.push(rz); hs.push(h); }
  objZs.forEach((oz, k) => { zs.push(+(oz + shift).toFixed(4)); hs.push(objHs[k]); });
  const N = zs.length;
  const objStart = raftN;
  // slicing planes in object coordinates (raft layers slice nothing)
  const planes = zs.map((zz, i) => (i < raftN ? -1 : zz - shift - hs[i] / 2));

  /** Config of object o at layer i (object overrides + its height range modifier, if any). */
  const ocfg = (o: number, i: number): Config => {
    const ranges = meshes[o].heightRanges;
    if (!ranges?.length || i < objStart) return objBase[o];
    const zm = zs[i] - shift - hs[i] / 2;
    // ranges that only carry plugin keys (a Motionex wave band) never hide a range with settings under them
    const r = ranges.findIndex((g) => zm >= g.z0 - 1e-6 && zm < g.z1 - 1e-6 && (!Object.keys(g.overrides).some((k) => WAVE_KEYS.includes(k)) || Object.keys(pick(g.overrides, HEIGHT_RANGE_KEYS)).length > 0));
    if (r < 0) return objBase[o];
    const key = `${o}:${r}`;
    let c = rangeCache.get(key);
    if (!c) { c = { ...objBase[o], ...pick(ranges[r].overrides, HEIGHT_RANGE_KEYS) }; rangeCache.set(key, c); }
    return c;
  };
  const onum = (o: number, i: number, k: string) => (k in live ? live[k] : Number(ocfg(o, i)[k] ?? 0));
  const ostr = (o: number, i: number, k: string) => String(ocfg(o, i)[k] ?? '');
  const obool = (o: number, i: number, k: string) => ocfg(o, i)[k] === true;
  const olw = (o: number, i: number, k: string) => onum(o, i, k) || onum(o, i, 'line_width') || nozzle * 1.05;

  // ---------- stage 2/3: slice objects & parts
  progress('Slicing mesh', 0.04);
  const mode = (str('slicing_mode') || 'regular') as SlicingMode;
  // outline points that deviate less than the path resolution carry no information (and cost every later polygon operation)
  const sliceTol = Math.min(0.02, Math.max(0.005, num('resolution')));
  const objSlices: Paths[][] = [];
  const modSlices: { o: number; ov: Config; slices: Paths[] }[] = [];
  const encVol: Paths[] = Array.from({ length: N }, () => []);
  const blkVol: Paths[] = Array.from({ length: N }, () => []);
  meshes.forEach((m, oi) => {
    const s = sliceMesh(m as IndexedMesh, planes, mode, sliceTol);
    // a hollow part (wall cutter / wall shell) is its outer surface minus its inner one, layer by layer
    const sliceVolume = (p: PartInput, md: typeof mode): Paths[] => {
      if (!p.innerFrom) return sliceMesh(p as IndexedMesh, planes, md, sliceTol);
      const k = p.innerFrom * 3;
      const outer = sliceMesh({ vertices: p.vertices, indices: p.indices.subarray(0, k) }, planes, 'regular', sliceTol);
      const inner = sliceMesh({ vertices: p.vertices, indices: p.indices.subarray(k) }, planes, 'regular', sliceTol);
      return outer.map((o, i) => (o.length && inner[i].length ? difference(union(o), union(inner[i])) : o));
    };
    const positives = (m.parts ?? []).filter((p) => p.type === 'part').map((p) => sliceVolume(p, mode));
    if (positives.length) for (let i = 0; i < N; i++) {
      const add = positives.flatMap((n) => n[i]);
      if (add.length) s[i] = union(s[i], add);
    }
    // volumes that overlap each other (several negative parts, parts and negatives, shells inside one mesh) are
    // merged: 'regular' unions the shells of a mesh instead of cancelling their overlap, and the cut is one union
    const negatives = (m.parts ?? []).filter((p) => p.type === 'negative').map((p) => sliceVolume(p, 'regular'));
    if (negatives.length) for (let i = 0; i < N; i++) {
      if (!s[i].length) continue;
      const cut = union(negatives.flatMap((n) => n[i]));
      if (cut.length) s[i] = difference(s[i], cut);
    }
    for (const p of m.parts ?? []) {
      if (p.type === 'modifier') {
        const ov = pick(p.overrides, MODIFIER_KEYS);
        if (Object.keys(ov).length) modSlices.push({ o: oi, ov, slices: sliceMesh(p as IndexedMesh, planes, 'regular', sliceTol).map((l) => union(l)) });
      } else if (p.type === 'support_enforcer' || p.type === 'support_blocker') {
        const ps = sliceMesh(p as IndexedMesh, planes, 'regular', sliceTol);
        const target = p.type === 'support_enforcer' ? encVol : blkVol;
        for (let i = 0; i < N; i++) if (ps[i].length) target[i] = target[i].concat(ps[i]);
      }
    }
    objSlices.push(s);
    progress('Slicing mesh', 0.04 + 0.14 * ((oi + 1) / meshes.length));
  });
  const closeR = num('slice_closing_radius');
  const smoothR = num('outline_smoothing'), smoothCorner = num('outline_smoothing_corner') || 35;
  const xyc = num('xy_contour_compensation'), xyh = num('xy_hole_compensation'), efc = raftN ? 0 : num('elefant_foot_compensation');
  const rawFirstLayer = new Map<Paths[], Paths>();
  for (const sl of objSlices) {
    for (let i = objStart; i < N; i++) {
      if (!sl[i].length) continue;
      if (closeR > 0) sl[i] = offset(offset(sl[i], closeR, 'round'), -closeR, 'round');
      if (smoothR > 0) sl[i] = smoothPaths(sl[i], smoothR, smoothCorner);
      if (xyc || xyh) {
        const exs = toExPolygons(sl[i]);
        const outer = offset(exs.map((e) => e.contour), xyc);
        const holes = offset(exs.flatMap((e) => e.holes.map((h) => h.slice().reverse())), xyh);
        sl[i] = difference(outer, holes);
      }
      // elephant foot compensation, spread over the first layers: full on the first, less on each one after
      const efcN = Math.max(1, Math.round(num('elefant_foot_compensation_layers') || 1));
      if (efc > 0 && i === objStart) rawFirstLayer.set(sl, sl[i]); // brim_use_efc_outline off: the brim follows this outline
      if (efc > 0 && i >= objStart && i < objStart + efcN) sl[i] = offset(sl[i], -efc * (1 - (i - objStart) / efcN));
    }
  }
  // make overhang printable (conical overhangs) and polyholes, per object (OrcaSlicer PrintObject slice step)
  objSlices.forEach((sl, o) => {
    if (obool(o, objStart, 'make_overhang_printable')) applyConicalOverhang(sl, objStart, hs, onum(o, objStart, 'make_overhang_printable_angle'), onum(o, objStart, 'make_overhang_printable_hole_size'));
    if (obool(o, objStart, 'hole_to_polyhole')) applyPolyholes(sl, objStart, { threshold: ocfg(o, objStart).hole_to_polyhole_threshold, maxEdges: onum(o, objStart, 'hole_to_polyhole_max_edges') || 50, twisted: obool(o, objStart, 'hole_to_polyhole_twisted'), nozzle });
  });
  const layerSlices: Paths[] = Array.from({ length: N }, (_, i) => union(objSlices.flatMap((s) => s[i])));
  /** First and last layer of each object (by-object printing, top-only rules). */
  const objLast = objSlices.map((sl) => { for (let i = N - 1; i >= 0; i--) if (sl[i].length) return i; return -1; });

  // ---------- multi-material: base filament per layer (colour-change actions) + painted colour regions
  const colorActions = (opts.layerActions ?? []).filter((a) => a.type === 'color' && a.filament !== undefined).sort((a, b) => a.z - b.z);
  const baseFilAt = (o: number, i: number) => {
    let f = meshes[o].filament ?? 0;
    let src: 'object' | 'change' = 'object';
    for (const a of colorActions) if (zs[i] >= a.z - 1e-6) { f = a.filament!; src = 'change'; }
    return regionOf(f, i, o, src);
  };
  const colorTris: PaintedTri[][] = meshes.map((m) => paintedTris(m as IndexedMesh, m.paint?.color));
  // painted colour reach (Orca / Bambu "Maximum width of a segmented region"; 0 = nearest surface, no limit), deeper every
  // other layer by the interlocking depth
  const segWidth = Math.max(0, num('mmu_segmented_region_max_width')), segInterlock = Math.max(0, num('mmu_segmented_region_interlocking_depth'));
  // with no width limit a painted top / bottom face colours its shell, as deep as the top / bottom shells
  const paintFlatReach = Math.max(0.5, num('top_shell_thickness'), num('bottom_shell_thickness'), num('top_shell_layers') * num('layer_height'), num('bottom_shell_layers') * num('layer_height'));
  // top / bottom paint penetration layers: how deep the colour of a painted top / bottom face reaches (0 = the shells)
  const penTop = Math.max(0, Math.round(num('top_color_penetration_layers'))), penBot = Math.max(0, Math.round(num('bottom_color_penetration_layers')));
  const paintPenetration = penTop || penBot ? { top: penTop ? penTop * num('layer_height') - 1e-3 : paintFlatReach, bottom: penBot ? penBot * num('layer_height') - 1e-3 : paintFlatReach } : undefined;
  const paintDepthAt = (i: number) => (segWidth > 0 ? segWidth + (segInterlock > 0 && i % 2 === 1 ? segInterlock : 0) : 0);
  // plugins that add material regions (Patternex) are set up here, before perimeters
  const sessions = preparePlugins(opts.plugins, {
    cfg, meshes, layerZ: zs, layerH: hs, planes, sliceAt: (o, i) => objSlices[o]?.[i] ?? [],
    filamentCount: filaments.length, hasAms, changer, toolheads: toolheadCount(cfg), warn,
  });
  // raised / recessed artwork changes the cross-sections themselves, before walls, surfaces and support
  const reshapers = [...sessions.values()].filter((x) => x.reshape);
  if (reshapers.length) {
    const next = objSlices.map((sl, o) => sl.map((p, i) => reshapers.reduce((acc, x) => x.reshape!(o, i, acc), p)));
    next.forEach((sl, o) => sl.forEach((p, i) => { objSlices[o][i] = p; }));
    for (let i = 0; i < N; i++) layerSlices[i] = union(objSlices.flatMap((sl) => sl[i]));
  }
  const modifierPlugins = [...sessions.values()].filter((x) => x.modifiersAt);
  const regionPlugins = [...sessions.values()].filter((x) => x.regionsAt);
  const transitionPlugins = [...sessions.values()].filter((x) => x.transition);
  const supportBlockPlugins = [...sessions.values()].filter((x) => x.supportBlockersAt);
  const filRegionsCache = new Map<number, FilRegion[]>();
  const paintOverlapWarned = new Set<number>();
  const filRegions = (o: number, i: number): FilRegion[] => {
    const key = o * 1_000_000 + i;
    const hit = filRegionsCache.get(key);
    if (hit) return hit;
    const r = filRegionsUncached(o, i);
    filRegionsCache.set(key, r);
    return r;
  };
  const filRegionsUncached = (o: number, i: number): FilRegion[] => {
    const sl = objSlices[o][i];
    if (!sl.length) return [];
    const base = baseFilAt(o, i);
    const contribs = regionPlugins.flatMap((x) => x.regionsAt!(o, i));
    if (!colorTris[o].length && !contribs.length) return [{ ...base, paths: sl }];
    const map = colorTris[o].length ? colorRegionsAtZ(meshes[o] as IndexedMesh, colorTris[o], sl, planes[i], paintDepthAt(i), paintFlatReach, paintPenetration) : new Map<number, Paths>();
    let out: FilRegion[] = [];
    let taken: Paths = [];
    for (const [c, paths] of [...map.entries()].sort((a, b) => a[0] - b[0])) {
      const rf = regionOf(c - 1, i, o, 'paint');
      const r = taken.length ? difference(paths, taken) : paths;
      if (!r.length) continue;
      out.push({ ...rf, paths: r });
      taken = union(taken, r);
    }
    const rest = taken.length ? difference(sl, taken) : sl;
    if (rest.length) out.unshift({ ...base, paths: rest });
    // plugin regions win over paint and the base material; later contributions win over earlier ones
    for (const c of contribs) {
      const r = intersection(c.paths, sl);
      if (!r.length) continue;
      if (taken.length && !paintOverlapWarned.has(o) && intersection(r, taken).length) {
        paintOverlapWarned.add(o);
        warnings.push(`${meshes[o].name}: Patternex artwork covers colour paint; the artwork's ink is used there (artwork › paint › object filament).`);
      }
      out = out.map((e) => ({ ...e, paths: difference(e.paths, r) })).filter((e) => e.paths.length);
      out.push({ fil: filAt(c.fil, i, o), paths: r });
    }
    // merge regions sharing a filament
    // merge regions sharing a filament (a subdivided mix stays apart: its passes differ)
    const merged = new Map<string, FilRegion>();
    for (const r of out) {
      const key = r.sub ? `${r.fil}|${r.sub.join(',')}` : `${r.fil}`;
      const m = merged.get(key);
      merged.set(key, m ? { ...m, paths: union(m.paths, r.paths) } : r);
    }
    // beam interlocking where two filaments of the object touch (OrcaSlicer InterlockingGenerator)
    if (merged.size > 1 && obool(o, i, 'interlocking_beam')) {
      return interlockRegions([...merged.values()], sl, i - objStart, {
        beamWidth: onum(o, i, 'interlocking_beam_width'), layerCount: onum(o, i, 'interlocking_beam_layer_count'), orientation: onum(o, i, 'interlocking_orientation'),
        depth: onum(o, i, 'interlocking_depth'), avoid: onum(o, i, 'interlocking_boundary_avoidance'),
      });
    }
    return [...merged.values()];
  };

  // ---------- stage 4: perimeters, per object & filament region
  progress('Generating perimeters', 0.2);
  const layerIslands: Island[][] = [];
  const layerInner: Paths[][] = []; // [layer][obj]
  const filInner: Map<number, Paths>[][] = []; // [layer][obj] fil -> inner
  /** Total wall thickness of an object at a layer (for vertical shells). */
  const wallDepth: number[][] = [];
  for (let i = 0; i < N; i++) {
    const h = hs[i];
    const islands: Island[] = [];
    const inners: Paths[] = [];
    const finners: Map<number, Paths>[] = [];
    const depths: number[] = [];
    for (let oi = 0; oi < meshes.length; oi++) {
      const first = i === objStart;
      const wo = i === 0 ? lw0('initial_layer_line_width') : olw(oi, i, 'outer_wall_line_width');
      const wi = i === 0 ? lw0('initial_layer_line_width') : olw(oi, i, 'inner_wall_line_width');
      const so = spacingOf(wo, h), si = spacingOf(wi, h);
      let walls = vase ? 1 : Math.max(0, Math.round(onum(oi, i, 'wall_loops')));
      if (first && walls > 0 && obool(oi, i, 'only_one_wall_first_layer')) walls = 1;
      if (!vase && walls > 0 && i % 2 === 1 && obool(oi, i, 'alternate_extra_wall')) walls += 1;
      depths.push(walls ? wo / 2 + so / 2 + Math.max(0, walls - 1) * si : 0);
      const arachne = ostr(oi, i, 'wall_generator') === 'arachne' && !vase;
      const topType = ostr(oi, i, 'top_one_wall_type');
      const above = i + 1 < N ? objSlices[oi][i + 1] : [];
      const objMap = new Map<number, Paths>();
      const objInner: Paths = [];
      for (const reg of filRegions(oi, i)) {
        const regInner: Paths = [];
        for (const ex of toExPolygons(reg.paths)) {
          let topOne: Paths | null = null;
          if (!vase && walls > 1 && (topType === 'all_top' || topType === 'topmost')) {
            const ip = exToPaths(ex);
            const t = topType === 'topmost' ? (above.length ? [] : ip) : above.length ? difference(ip, offset(above, wo / 2)) : ip;
            // Bambu's top area threshold (% of the outer wall) and Orca's one wall threshold (mm or % of the inner wall)
            const minW = Math.max((wo * onum(oi, i, 'top_area_threshold')) / 100, floatOrPercent(ocfg(oi, i).min_width_top_surface, wi));
            topOne = t.length ? opening(t, Math.max(0.01, minW / 2)) : null;
            if (topOne && !topOne.length) topOne = null;
          }
          const w = islandWalls(ex, {
            walls, wo, wi, so, si, nozzle, arachne,
            minBead: (nozzle * onum(oi, i, first ? 'initial_layer_min_bead_width' : 'min_bead_width')) / 100 || nozzle * 0.85,
            minLengthFactor: arachne ? onum(oi, i, 'min_length_factor') : 0,
            maxResolution: arachne ? onum(oi, i, 'wall_maximum_resolution') : 0, maxDeviation: onum(oi, i, 'wall_maximum_deviation'),
            overhangBelow: !vase && i > objStart && obool(oi, i, 'extra_perimeters_on_overhangs') ? objSlices[oi][i - 1] : null,
            minFeature: (nozzle * onum(oi, i, 'min_feature_size')) / 100 || nozzle * 0.25,
            margin: (nozzle * onum(oi, i, 'wall_transition_filter_deviation')) / 100,
            transitionLength: (nozzle * onum(oi, i, 'wall_transition_length')) / 100,
            transitionAngle: onum(oi, i, 'wall_transition_angle') || 10,
            distributionCount: Math.max(1, Math.round(onum(oi, i, 'wall_distribution_count') || 1)),
            precise: obool(oi, i, 'precise_outer_wall'),
            thinWalls: !arachne && obool(oi, i, 'detect_thin_wall'),
            gapFill: !arachne && !vase,
            topOneWall: topOne,
          });
          pushAll(regInner, w.inner);
          islands.push({ obj: oi, fil: reg.fil, ex, walls: w, ...(reg.sub ? { sub: reg.sub } : {}) });
        }
        const u = union(regInner);
        objMap.set(reg.fil, objMap.has(reg.fil) ? union(objMap.get(reg.fil)!, u) : u);
        pushAll(objInner, u);
      }
      inners.push(union(objInner));
      finners.push(objMap);
    }
    layerIslands.push(islands);
    layerInner.push(inners);
    filInner.push(finners);
    wallDepth.push(depths);
    if (i % 10 === 0) progress('Generating perimeters', 0.2 + 0.15 * (i / N));
  }

  // ---------- stage 5: region classification (per object)
  progress('Classifying surfaces', 0.36);
  const regions: Regions[][] = [];
  // surfaces first (every layer), then the shells that depend on the layers around them
  const surf: { top: Paths; bottomAll: Paths }[][] = [];
  for (let i = 0; i < N; i++) {
    surf.push(meshes.map((_, o) => {
      const inner = layerInner[i][o];
      if (!inner.length) return { top: [], bottomAll: [] };
      const sw = olw(o, i, 'internal_solid_infill_line_width');
      const clean = (p: Paths) => opening(p, sw * 0.25);
      const above = i + 1 < N ? objSlices[o][i + 1] : [];
      const below = i > objStart ? objSlices[o][i - 1] : [];
      let top = clean(i + 1 < N ? difference(inner, above) : inner);
      // top surface expansion: joins top surfaces split by raised features (applied before anything else uses them)
      const tse = onum(o, i, 'top_surface_expansion');
      if (tse > 0 && top.length) top = expandTop(top, inner, tse, ostr(o, i, 'top_surface_expansion_direction') || 'inward_and_outward', onum(o, i, 'top_surface_expansion_margin'));
      return { top, bottomAll: clean(i > objStart ? difference(inner, below) : inner) };
    }));
  }
  for (let i = 0; i < N; i++) {
    const per: Regions[] = [];
    for (let o = 0; o < meshes.length; o++) {
      const empty: Regions = { top: [], bottom: [], bridge: [], solid: [], sparse: [], sparseMods: [], vshell: [], floating: [], subTop: [] };
      const inner = layerInner[i][o];
      if (!inner.length) { per.push(empty); continue; }
      const density = vase ? 0 : onum(o, i, 'sparse_infill_density') / 100;
      const extraSolid = solidLayerRule(ostr(o, i, 'extra_solid_infills'));
      const hRef = hs[i];
      const topLayers = vase ? 0 : Math.max(Math.round(onum(o, i, 'top_shell_layers')), onum(o, i, 'top_shell_thickness') > 0 ? Math.ceil(onum(o, i, 'top_shell_thickness') / hRef - 1e-6) : 0);
      const botLayers = Math.max(Math.round(onum(o, i, 'bottom_shell_layers')), onum(o, i, 'bottom_shell_thickness') > 0 ? Math.ceil(onum(o, i, 'bottom_shell_thickness') / hRef - 1e-6) : 0);
      const sw = olw(o, i, 'internal_solid_infill_line_width');
      const clean = (p: Paths) => opening(p, sw * 0.25);
      const objFirst = i === objStart;
      // no top shells at all (0 layers, 0 thickness) leaves the top open, as in Bambu Studio / Orca
      let top = (vase && i >= objStart + botLayers) || topLayers === 0 ? [] : surf[i][o].top;
      const bottomAll = surf[i][o].bottomAll;
      // over a raft the first object layer bridges the contact gap
      const bottom = objFirst && !raftN ? bottomAll : [];
      let bridge = objFirst && !raftN ? [] : bottomAll;
      if (vase && i >= objStart + botLayers) { top = []; bridge = []; }

      let solid: Paths = [];
      let vshell: Paths = [];
      if (vase) solid = i < objStart + botLayers ? inner : [];
      else {
        // shells straight under the top surfaces / over the bottom surfaces of the layers around
        const projTop: Paths = [], projBot: Paths = [];
        // (the surface layer itself counts as one of the shell layers)
        for (let k = 1; k < topLayers && i + k < N; k++) pushAll(projTop, surf[i + k][o].top);
        for (let k = 1; k < botLayers && i - k >= objStart; k++) pushAll(projBot, surf[i - k][o].bottomAll);
        if (i + topLayers >= N) pushAll(projTop, inner); // the last layers of the plan are top shells
        // "ensure vertical shell thickness": wherever the layers above / below do not fully cover this one
        // (sloping surfaces), the shell is made thick horizontally too
        const covered = (from: number, to: number) => {
          let cov: Paths | null = null;
          for (let j = from; j !== to; j += from < to ? 1 : -1) {
            if (j < objStart || j >= N) return [];
            cov = cov === null ? layerInner[j][o] : intersection(cov, layerInner[j][o]);
            if (!cov.length) return [];
          }
          return cov ?? inner;
        };
        const evt = ostr(o, i, 'ensure_vertical_shell_thickness');
        const slopeTop = topLayers > 0 && (evt === 'enabled' || evt === 'partial') ? difference(inner, covered(i + 1, i + 1 + topLayers)) : [];
        const slopeBot = botLayers > 0 && evt === 'enabled' ? difference(inner, covered(i - 1, i - 1 - botLayers)) : [];
        solid = projTop.length || projBot.length ? intersection(inner, union([...projTop, ...projBot])) : [];
        solid = clean(difference(union(solid), union([...top, ...bottom, ...bridge])));
        if (bool('interface_shells')) {
          // interface shells: solid where a different material lies directly above or below, both between
          // painted filament regions of this object and against other objects
          const touch: Paths[] = [];
          for (const j of [i - 1, i + 1]) {
            if (j < 0 || j >= N) continue;
            for (const [f, reg] of filInner[i][o]) for (const [g, regJ] of filInner[j][o]) if (g !== f && reg.length && regJ.length) touch.push(intersection(reg, regJ));
            for (let o2 = 0; o2 < meshes.length; o2++) if (o2 !== o && layerInner[j][o2].length) touch.push(intersection(inner, layerInner[j][o2]));
          }
          const iface = touch.length ? clean(difference(union(touch.flat()), union([...top, ...bottom, ...bridge]))) : [];
          if (iface.length) solid = union(solid, iface);
        }
        if (slopeTop.length || slopeBot.length) vshell = clean(difference(union([...slopeTop, ...slopeBot]), union([...top, ...bottom, ...bridge, ...solid])));
      }
      let sparse = vase ? [] : difference(inner, union([...top, ...bottom, ...bridge, ...solid, ...vshell]));
      if (!vase && obool(o, i, 'infill_instead_top_bottom_surfaces')) {
        // open-lattice parts: shells are printed as sparse infill (the first layer stays solid for adhesion)
        sparse = union([...sparse, ...top, ...solid, ...vshell, ...(objFirst ? [] : bottom)]);
        top = []; solid = []; vshell = [];
      }
      if (density >= 0.999 || (!vase && extraSolid(i - objStart + 1))) { solid = union([...solid, ...sparse]); sparse = []; }
      else if (onum(o, i, 'minimum_sparse_infill_area') > 0 && sparse.length) {
        const small = toExPolygons(sparse).filter((e) => area(e.contour) + e.holes.reduce((s2, hh) => s2 + area(hh), 0) < onum(o, i, 'minimum_sparse_infill_area'));
        if (small.length) {
          const sp = small.flatMap(exToPaths);
          solid = union([...solid, ...sp]);
          sparse = difference(sparse, sp);
        }
      }
      // modifier volumes re-parameterise sparse infill inside them
      const sparseMods: Regions['sparseMods'] = [];
      // where modifiers overlap, the one added last wins: it takes its area first
      for (const mod of [...modSlices].reverse()) {
        if (mod.o !== o || !mod.slices[i].length || !sparse.length) continue;
        const r = intersection(sparse, mod.slices[i]);
        if (!r.length) continue;
        sparse = difference(sparse, mod.slices[i]);
        const d = mod.ov.sparse_infill_density !== undefined ? Number(mod.ov.sparse_infill_density) / 100 : density;
        const pat = (mod.ov.sparse_infill_pattern ?? ostr(o, i, 'sparse_infill_pattern')) as SparsePattern;
        if (d >= 0.999) solid = union(solid, r);
        else if (d > 0) sparseMods.push({
          paths: r, density: d, pattern: pat,
          speed: mod.ov.sparse_infill_speed !== undefined ? Number(mod.ov.sparse_infill_speed) : undefined,
          angle: mod.ov.infill_direction !== undefined ? Number(mod.ov.infill_direction) : undefined,
        });
      }
      // plugin regions with their own infill (Patternex effects) work the same way
      for (const x of modifierPlugins) for (const mod of x.modifiersAt!(o, i)) {
        if (!sparse.length) break;
        const r = intersection(sparse, mod.paths);
        if (!r.length) continue;
        sparse = difference(sparse, mod.paths);
        const d = mod.overrides.sparse_infill_density !== undefined ? Number(mod.overrides.sparse_infill_density) / 100 : density;
        const pat = (mod.overrides.sparse_infill_pattern ?? ostr(o, i, 'sparse_infill_pattern')) as SparsePattern;
        if (d >= 0.999) solid = union(solid, r);
        else if (d > 0) sparseMods.push({ paths: r, density: d, pattern: pat });
      }
      // detect floating vertical shells: solid infill standing on sparse infill prints at bridge speed
      let floating: Paths = [];
      if (!vase && i > objStart && obool(o, i, 'detect_floating_vertical_shell') && solid.length) {
        const prev = regions[i - 1]?.[o];
        if (prev?.sparse.length) {
          floating = clean(intersection(solid, prev.sparse));
          if (floating.length) solid = difference(solid, floating);
        }
      }
      // internal bridges (OrcaSlicer): solid infill over sparse infill. With "Filter" they are left to the floating
      // vertical shell detection while that is on (Bambu Studio behaviour); otherwise they get their own line type.
      let ibridge: Paths = [];
      const ibFilter = ostr(o, i, 'dont_filter_internal_bridges') || 'disabled';
      if (!vase && i > objStart && (ibFilter !== 'disabled' || !obool(o, i, 'detect_floating_vertical_shell'))) {
        const prev = regions[i - 1]?.[o];
        if (prev?.sparse.length) {
          ibridge = clean(internalBridges(union([...solid, ...floating]), prev.sparse, ibFilter, sw));
          if (ibridge.length) { solid = difference(solid, ibridge); floating = floating.length ? difference(floating, ibridge) : floating; }
        }
      }
      per.push({ top, bottom, bridge, solid, sparse, sparseMods, vshell, floating, subTop: [], ...(ibridge.length ? { ibridge } : {}) });
    }
    regions.push(per);
    if (i % 10 === 0) progress('Classifying surfaces', 0.36 + 0.12 * (i / N));
  }
  // sub-top surfaces: the solid layer under a top surface gets its own pattern
  for (let i = 0; i + 1 < N; i++) for (let o = 0; o < meshes.length; o++) {
    const r = regions[i][o], up = regions[i + 1][o];
    if (!r.solid.length || !up.top.length) continue;
    const st = intersection(r.solid, up.top);
    if (st.length) { r.subTop = st; r.solid = difference(r.solid, st); }
  }
  // extra bridge layers: the solid layer over a bridge is a second bridge (parallel over external bridges,
  // crosswise over internal ones)
  for (let i = 0; i + 1 < N; i++) for (let o = 0; o < meshes.length; o++) {
    const mode = ostr(o, i + 1, 'enable_extra_bridge_layer') || 'disabled';
    if (mode === 'disabled' || vase) continue;
    const r = regions[i][o], up = regions[i + 1][o];
    const src: { paths: Paths; internal: boolean }[] = [];
    if ((mode === 'external_bridge_only' || mode === 'apply_to_all') && r.bridge.length) src.push({ paths: r.bridge, internal: false });
    if ((mode === 'internal_bridge_only' || mode === 'apply_to_all') && r.ibridge?.length) src.push({ paths: r.ibridge, internal: true });
    for (const sp of src) {
      const avail = union([...up.solid, ...up.subTop, ...up.floating]);
      const b2 = avail.length ? opening(intersection(avail, sp.paths), olw(o, i + 1, 'internal_solid_infill_line_width')) : [];
      if (!b2.length) continue;
      up.solid = difference(up.solid, b2); up.subTop = difference(up.subTop, b2); up.floating = difference(up.floating, b2);
      (up.bridge2 ??= []).push({ paths: b2, internal: sp.internal });
    }
  }
  // infill combination: sparse infill common to a block of layers is printed once, at the block's height
  for (let o = 0; o < meshes.length; o++) {
    if (vase || !obool(o, objStart, 'infill_combination')) continue;
    // Infill combination - Max layer height (0 or 100% = the nozzle diameter)
    const maxComb = Math.min(nozzle, floatOrPercent(ocfg(o, objStart).infill_combination_max_layer_height ?? '100%', nozzle) || nozzle);
    const k = Math.max(1, Math.min(4, Math.floor((maxComb + 1e-6) / hN)));
    if (k < 2) continue;
    for (let b0 = objStart; b0 + k - 1 < N; b0 += k) {
      if (profile && hs.slice(b0, b0 + k).some((h) => Math.abs(h - hN) > 1e-6)) continue;
      let common: Paths | null = null;
      for (let j = b0; j < b0 + k; j++) { common = common === null ? regions[j][o].sparse : intersection(common, regions[j][o].sparse); if (!common.length) break; }
      if (!common?.length) continue;
      common = opening(common, olw(o, b0, 'sparse_infill_line_width'));
      if (!common.length) continue;
      for (let j = b0; j < b0 + k; j++) regions[j][o].sparse = difference(regions[j][o].sparse, common);
      regions[b0 + k - 1][o].combined = { paths: common, height: hs.slice(b0, b0 + k).reduce((a, b) => a + b, 0) };
    }
  }
  // lightning / adaptive cubic / support cubic need neighbouring layers
  for (let o = 0; o < meshes.length; o++) {
    const pat = ostr(o, objStart, 'sparse_infill_pattern');
    if (vase || !['lightning', 'adaptivecubic', 'supportcubic'].includes(pat)) continue;
    const dens = onum(o, objStart, 'sparse_infill_density') / 100;
    if (dens <= 0) continue;
    const spw = olw(o, objStart, 'sparse_infill_line_width');
    const s = spw / Math.min(1, dens);
    const clip = (i: number) => {
      const fi = layerInner[i][o];
      const ov = onum(o, i, 'infill_wall_overlap') / 100;
      return regions[i][o].sparse.length && fi.length ? intersection(regions[i][o].sparse, offset(fi, -(spw / 2) + ov * spw)) : [];
    };
    if (pat === 'lightning') {
      const sp = Array.from({ length: N }, (_, i) => clip(i));
      const need = Array.from({ length: N }, (_, i) => {
        if (i + 1 >= N || !sp[i].length) return [];
        const up = regions[i + 1][o];
        const solidAbove = union([...up.top, ...up.solid, ...up.bridge, ...up.vshell, ...up.floating, ...up.subTop, ...up.bottom]);
        return solidAbove.length ? intersection(sp[i], solidAbove) : [];
      });
      const la = (k: string) => (ocfg(o, objStart)[k] === undefined ? undefined : onum(o, objStart, k));
      const lines = lightningInfill(sp, need, s, hs, 45, { overhang: la('lightning_overhang_angle'), prune: la('lightning_prune_angle'), straighten: la('lightning_straightening_angle') });
      lines.forEach((l, i) => { regions[i][o].lines = l; });
      continue;
    }
    // adaptive / support cubic: cube size doubles away from the surfaces (support cubic: only from the surfaces above)
    const deep = (i: number, d: number, onlyAbove: boolean): Paths => {
      const m = Math.max(1, Math.ceil(d / hN));
      const stride = Math.max(1, Math.ceil(m / 6));
      let acc: Paths | null = null;
      for (let j = onlyAbove ? i : i - m; j <= i + m; j += stride) {
        const jj = Math.min(Math.max(j, 0), N - 1);
        if (j < objStart || j >= N) return [];
        const src = onlyAbove ? union([...regions[jj][o].sparse, ...layerInner[jj][o].length ? [] : []]) : layerInner[jj][o];
        acc = acc === null ? src : intersection(acc, src);
        if (!acc.length) return [];
      }
      return acc?.length ? (onlyAbove ? acc : offset(acc, -d)) : [];
    };
    for (let i = objStart; i < N; i++) {
      const region = clip(i);
      if (!region.length) continue;
      const onlyAbove = pat === 'supportcubic';
      const far1 = intersection(region, deep(i, 3 * s, onlyAbove));
      const far2 = far1.length ? intersection(region, deep(i, 9 * s, onlyAbove)) : [];
      const near = far1.length ? difference(region, far1) : region;
      const mid = far1.length ? (far2.length ? difference(far1, far2) : far1) : [];
      const angle = onum(o, i, 'infill_direction');
      regions[i][o].lines = [
        ...cubicFill(near, s, zs[i], angle),
        ...(mid.length ? cubicFill(mid, s * 2, zs[i], angle) : []),
        ...(far2.length ? cubicFill(far2, s * 4, zs[i], angle) : []),
      ];
    }
  }

  // ---------- stage 6: support (auto overhangs + painted/volume enforcers & blockers) and raft
  let support: { base: Paths[]; iface: Paths[]; bottomIface?: Paths[] } | null = null;
  const supportStyle = str('support_style') || 'default';
  const supType = str('support_type') || 'normal_auto';
  const tree = supType.startsWith('tree');
  // enforce support for the first N layers: every overhang there, whatever its angle, even with support off
  const enforceSupportN = Math.max(0, Math.round(num('enforce_support_layers')));
  if (bool('enable_support') || enforceSupportN > 0) {
    progress('Generating support', 0.5);
    const manual = supType.endsWith('manual') || !bool('enable_support');
    const sw = lw0('support_line_width');
    let over: Paths[] = manual ? Array.from({ length: N }, () => []) : computeOverhangs(layerSlices, hs, num('support_threshold_angle'), bool('support_remove_small_overhang'), sw);
    if (!manual) over = filterOverhangs(over, layerSlices, sw, { criticalOnly: bool('support_critical_regions_only'), noBridges: bool('bridge_no_support'), maxBridge: num('max_bridge_length'), reach: Math.max(5, num('max_bridge_length') / 2) });
    over = enforceFirstLayers(over, layerSlices, objStart, enforceSupportN);
    const supTris = meshes.map((m) => paintedTris(m as IndexedMesh, m.paint?.support));
    const blocked: Paths[] = Array.from({ length: N }, () => []);
    for (let i = objStart + 1; i < N; i++) {
      const add: Paths = [];
      let sub: Paths = [];
      meshes.forEach((m, o) => {
        if (!supTris[o].length) return;
        const zt = zs[i] - shift;
        const enf = footprintsInBand(m as IndexedMesh, supTris[o], 1, zt - hs[i], zt);
        if (enf.length) pushAll(add, difference(intersection(enf, objSlices[o][i]), objSlices[o][i - 1]));
        const blk = footprintsInBand(m as IndexedMesh, supTris[o], 2, zt - hs[i], zt, 0.5);
        if (blk.length) sub = sub.concat(blk);
      });
      if (encVol[i].length) pushAll(add, intersection(difference(layerSlices[i], layerSlices[i - 1]), union(encVol[i])));
      if (add.length) over[i] = union(over[i], add);
      if (sub.length && over[i].length) over[i] = difference(over[i], union(sub));
      if (blkVol[i].length) blocked[i] = union(blkVol[i]);
      // plugins that print an overhang themselves (Hanex) keep support from starting under it
      for (const x of supportBlockPlugins) { const b = x.supportBlockersAt!(i); if (b.length && over[i].length) over[i] = difference(over[i], b); }
    }
    // a soluble / support-material interface touches the model: no Z gap
    const ifaceSlot = num('support_interface_filament') > 0 ? clampFil(num('support_interface_filament') - 1) : -1;
    const ifaceSettings = ifaceSlot >= 0 ? filaments[ifaceSlot].settings : undefined;
    const solubleIface = !!ifaceSettings && (ifaceSettings.filament_soluble === true || ifaceSettings.filament_is_support === true);
    const common = {
      topZDistance: solubleIface ? 0 : num('support_top_z_distance'), bottomZDistance: solubleIface ? 0 : num('support_bottom_z_distance'),
      xyDistance: num('support_object_xy_distance'), firstLayerGap: num('support_object_first_layer_gap'),
      interfaceLayers: Math.round(num('support_interface_top_layers')), bottomInterfaceLayers: Math.round(num('support_interface_bottom_layers')),
      buildPlateOnly: bool('support_on_build_plate_only'), lineWidth: sw, blocked, expansion: num('support_expansion'),
      style: supportStyle, topOverridesXY: bool('top_z_overrides_xy_distance'),
    };
    // Tree Organic reads its own branch settings (Orca: *_organic, preferred angle, branch density)
    const organic = supportStyle === 'tree_organic';
    support = tree
      ? generateTreeSupport(layerSlices, hs, over, {
        ...common, style: supportStyle === 'default' ? 'tree_hybrid' : supportStyle,
        branchAngle: organic ? num('tree_support_branch_angle_organic') : num('tree_support_branch_angle') || 40, tipDiameter: num('tree_support_tip_diameter') || 1.6,
        branchDiameter: (organic ? num('tree_support_branch_diameter_organic') : num('tree_support_branch_diameter')) || 6,
        branchDistance: (organic ? num('tree_support_branch_distance_organic') : num('tree_support_branch_distance')) || 4,
        diameterAngle: num('tree_support_branch_diameter_angle'),
        slowAngle: organic ? num('tree_support_angle_slow') : undefined,
        tipSpacingAlong: organic ? organicTipSpacing(sw, num('tree_support_top_rate'), num('tree_support_tip_diameter') || 1.6) : undefined,
        brim: !organic && !raftN && (bool('tree_support_auto_brim') || num('tree_support_brim_width') > 0) ? { auto: bool('tree_support_auto_brim'), width: num('tree_support_brim_width') } : undefined,
      })
      : generateSupport(layerSlices, hs, over, common);
  }
  if (raftN) {
    // raft: the first object layer's footprint (with any support standing on it), base layers then interface layers
    const sw = lw0('support_line_width');
    const foot = union([...layerSlices[objStart], ...(support ? [...support.base[objStart], ...support.iface[objStart]] : [])]);
    const exp = num('raft_first_layer_expansion');
    const body = offset(foot, Math.max(0, num('raft_expansion')), 'round');
    if (!support) support = { base: Array.from({ length: N }, () => []), iface: Array.from({ length: N }, () => []), bottomIface: Array.from({ length: N }, () => []) };
    const ifaceN = Math.min(raftN - 1, Math.max(1, Math.round(num('support_interface_top_layers'))));
    for (let r = 0; r < raftN; r++) {
      const reg = r === 0 ? offset(body, exp < 0 ? 2 : exp, 'round') : body;
      if (r >= raftN - ifaceN && raftN > 1) support.iface[r] = union(support.iface[r], reg);
      else support.base[r] = union(support.base[r], reg);
    }
    void sw;
  } else if (support && num('raft_first_layer_expansion') > 0 && support.base[0].length) {
    support.base[0] = difference(offset(support.base[0], num('raft_first_layer_expansion'), 'round'), offset(layerSlices[0], num('support_object_first_layer_gap')));
  }

  // ---------- filament plan & prime tower
  const supportFil = num('support_filament') > 0 ? clampFil(num('support_filament') - 1) : -1;
  const ifaceFil = num('support_interface_filament') > 0 ? clampFil(num('support_interface_filament') - 1) : supportFil;
  // the body of the support avoids the interface filament (if it would otherwise be the one loaded)
  const avoidIfaceForBody = bool('support_interface_not_for_body') && ifaceFil >= 0 && supportFil < 0;
  const featFil = (o: number, i: number, kind: 'wall' | 'sparse' | 'solid', fallback: number) => {
    const k = kind === 'wall' ? 'wall_filament' : kind === 'sparse' ? 'sparse_infill_filament' : 'solid_infill_filament';
    const v = Math.round(onum(o, i, k));
    return v > 0 ? filAt(v - 1, i, o) : fallback;
  };
  const flushObj = meshes.map((_, o) => obool(o, objStart, 'flush_into_objects'));
  const layerFils: number[][] = [];
  const usedFils = new Set<number>();
  for (let i = 0; i < N; i++) {
    const s = new Set<number>();
    for (const isl of layerIslands[i]) {
      if (flushObj[isl.obj]) continue;
      s.add(featFil(isl.obj, i, 'wall', isl.fil));
      if (isl.sub) for (const f of isl.sub) s.add(f);
      const rg = regions[i][isl.obj];
      if (rg.sparse.length || rg.sparseMods.length || rg.combined || rg.lines?.length) s.add(featFil(isl.obj, i, 'sparse', isl.fil));
      if (rg.solid.length || rg.top.length || rg.bottom.length || rg.bridge.length || rg.vshell.length || rg.floating.length || rg.subTop.length) s.add(featFil(isl.obj, i, 'solid', isl.fil));
    }
    if (support && supportFil >= 0 && (support.base[i].length)) s.add(supportFil);
    if (support && ifaceFil >= 0 && (support.iface[i].length || support.bottomIface?.[i]?.length)) s.add(ifaceFil);
    if (!s.size && layerIslands[i].length) s.add(filAt(meshes[layerIslands[i][0].obj].filament ?? 0, i, layerIslands[i][0].obj));
    layerFils.push([...s]);
    s.forEach((f) => usedFils.add(f));
  }
  // simulate tool order: current tool first, then ascending
  const changesPerLayer: number[] = [];
  {
    let cur = -1;
    for (let i = 0; i < N; i++) {
      const order = orderLayerTools(layerFils[i], cur, i, opts.filamentSequence);
      let c = 0;
      // without a chute the first load is flushed on the tower too
      for (const f of order) { if ((cur !== -1 || (towerFlush && usedFils.size > 1)) && f !== cur) c++; cur = f; }
      changesPerLayer.push(c);
    }
  }
  const towerWanted = bool('enable_prime_tower') || (towerFlush && usedFils.size > 1);
  const useTower = towerWanted && usedFils.size > 1 && !vase && !byObject;
  if (byObject && usedFils.size > 1 && towerWanted) warn('The prime tower is not used when printing by object.');
  if (towerFlush && usedFils.size > 1) {
    if (!bool('enable_prime_tower') && useTower) warn('This filament unit has no purge chute, so the flush goes onto the prime tower: the tower is printed even though it is off.');
    if (!useTower) warn('This filament unit has no purge chute and this print has no prime tower: each change flushes over the print ([flush_length] in the change G-code). Turn the prime tower on, or print by layer.');
  }
  const lastChangeLayer = changesPerLayer.reduce((a, c, i) => (c > 0 ? i : a), -1);
  const tw = num('prime_tower_width') || 35;
  // the largest flush into filament f from any other filament in use (tower-flushing units size their bands from it)
  // purge p → n: the flushing matrix, else the load / unload volumes (wiping_volumes_extruders), else the flush volume
  const flushOf = (p: number, n: number) => opts.flushMatrix?.[p]?.[n] ?? loadUnloadFlush(cfg.wiping_volumes_extruders, p, n) ?? num('flush_volume') ?? 0;
  const maxFlushInto = (f: number) => Math.max(0, ...[...usedFils].filter((p) => p !== f).map((p) => flushOf(p, f)));
  const primeVolOf = (f: number) => {
    const fv = Number(filaments[f]?.settings?.filament_prime_volume ?? NaN);
    const v = (isFinite(fv) && fv > 0 ? fv : num('prime_volume') || 45) + (towerFlush ? maxFlushInto(f) : hasAms ? 0 : num('flush_volume'));
    return Math.max(v, minimalPurge(filaments[f]?.settings, cfg));
  };
  const primeVol = Math.max(...[...usedFils].map(primeVolOf), num('prime_volume') || 45);
  const tune = towerTuning(cfg);
  // wipe_tower_extra_spacing spreads the purge lines: the same volume takes more depth (extra flow is spaced to match)
  const bandDepth = Math.max(1.5, primeVol / (tw * hN)) * tune.extraSpacing;
  const maxChanges = Math.max(1, ...changesPerLayer);
  const td = Math.max(4, bandDepth * maxChanges);
  let tx = num('prime_tower_x'), ty = num('prime_tower_y');
  // unset: the printer's default position (Bambu Studio's default_wipe_tower_pos, a fraction of the bed), kept on the bed
  const towerPos = /^\s*([\d.]+)\s*x\s*([\d.]+)\s*$/i.exec(str('default_wipe_tower_pos'));
  const brimM = Math.max(0, num('prime_tower_brim_width')) + 2;
  const autoTower = !!towerPos && tx < 0 && ty < 0;
  if (tx < 0) tx = towerPos ? Math.min(Math.max(brimM, Number(towerPos[1]) * num('bed_x')), num('bed_x') - tw - brimM) : Math.max(5, num('bed_x') - tw - 15);
  if (ty < 0) ty = towerPos ? Math.min(Math.max(brimM, Number(towerPos[2]) * num('bed_y')), num('bed_y') - td - brimM) : Math.max(5, num('bed_y') - td - 25);
  // tower body: a (filleted) rectangle with optional diagonal ribs
  let towerBody: Paths = [rectPath(tx, ty, tx + tw, ty + td)];
  let towerBody0 = towerBody; // in the tower frame, before the rotation
  if (useTower) {
    const ribW = num('prime_tower_rib_width');
    if (bool('prime_tower_rib_wall') && ribW > 0 && tune.wallType === 'rib') {
      const ext = num('prime_tower_extra_rib_length');
      const cx = tx + tw / 2, cy = ty + td / 2, half = Math.hypot(tw, td) / 2 + ext;
      const ribs = [Math.atan2(td, tw), Math.atan2(-td, tw)].map((a) => {
        const ux = Math.cos(a), uy = Math.sin(a), nx = -uy * ribW / 2, ny = ux * ribW / 2;
        return [[cx - ux * half + nx, cy - uy * half + ny], [cx + ux * half + nx, cy + uy * half + ny], [cx + ux * half - nx, cy + uy * half - ny], [cx - ux * half - nx, cy - uy * half - ny]]
          .map(([x, y]) => ({ X: Math.round(x * SCALE), Y: Math.round(y * SCALE) }));
      });
      towerBody = union([...towerBody, ...ribs]);
    }
    if (bool('prime_tower_fillet_wall')) towerBody = offset(offset(towerBody, -2, 'round'), 2, 'round');
    towerBody0 = towerBody;
    // wipe tower rotation angle: the whole tower turns about its centre
    towerBody = rotatePathsAbout(towerBody, tune.rotation, tx + tw / 2, ty + td / 2);
    // a default position (not set by the user) keeps the whole tower, ribs and brim included, on the plate
    if (autoTower) {
      const b0 = bounds(towerBody);
      const lo = (v: number) => v / SCALE;
      let dx = 0, dy = 0;
      if (lo(b0.minX) - brimM < 0) dx = brimM - lo(b0.minX); else if (lo(b0.maxX) + brimM > num('bed_x')) dx = num('bed_x') - brimM - lo(b0.maxX);
      if (lo(b0.minY) - brimM < 0) dy = brimM - lo(b0.minY); else if (lo(b0.maxY) + brimM > num('bed_y')) dy = num('bed_y') - brimM - lo(b0.maxY);
      if (dx || dy) {
        tx += dx; ty += dy;
        towerBody = towerBody.map((p) => p.map((q) => ({ X: q.X + Math.round(dx * SCALE), Y: q.Y + Math.round(dy * SCALE) })));
        towerBody0 = towerBody0.map((p) => p.map((q) => ({ X: q.X + Math.round(dx * SCALE), Y: q.Y + Math.round(dy * SCALE) })));
      }
    }
    const tb = offset(towerBody, 3);
    if (intersection(tb, layerSlices[objStart]).length) warn('The prime tower overlaps an object — move it in Others › Prime tower.');
    const b = bounds(towerBody);
    if (b.minX / SCALE < 0 || b.minY / SCALE < 0 || b.maxX / SCALE > num('bed_x') || b.maxY / SCALE > num('bed_y')) warn('The prime tower does not fit on the plate.');
  }
  // per layer: the bands a layer holds (Internal ribs off: only what it and the layers above need), the height of the
  // tower layer printed there (combined sparse layers), the top of the tower (stabilization cone)
  const towerBands = towerBandsPerLayer(changesPerLayer, maxChanges, tune.framework);
  const towerHs = tune.combineSparse && !(str('timelapse_type') === 'smooth' && str('time_lapse_gcode')) ? combinedTowerHeights(hs, changesPerLayer, lastChangeLayer, num('max_layer_height') || nozzle * 0.75) : null;
  const towerTop = lastChangeLayer >= 0 ? zs[lastChangeLayer] : 0;
  if (useTower && tune.noSparse) warn('No sparse layers: on a filament change the nozzle goes down to the top of the prime tower. Make sure nothing taller stands in the way.');
  let towerPrintedZ = 0;

  // ---------- bed adhesion (first layer)
  const brimLoops: PathItem[] = [];
  const skirtLoops: PathItem[] = [];
  const brimByObj = new Map<number, PathItem[]>();
  {
    const w = lw0('initial_layer_line_width');
    const s = spacingOf(w, h0);
    let brimType = raftN ? 'no_brim' : str('brim_type');
    const bw = num('brim_width'), gap = num('brim_object_gap');
    // the bed, less half a line: brim and skirt lines past it would be printed off the edge of the plate
    const bedIn = [rectPath(w / 2, w / 2, num('bed_x') - w / 2, num('bed_y') - w / 2)];
    const offBed = (loops: PathItem[]) => loops.some((l) => { for (let k = 0; k < l.pts.length; k += 2) if (l.pts[k] < w / 2 - 1e-3 || l.pts[k + 1] < w / 2 - 1e-3 || l.pts[k] > num('bed_x') - w / 2 + 1e-3 || l.pts[k + 1] > num('bed_y') - w / 2 + 1e-3) return true; return false; });
    /** Brim of one object; with `clip`, only the part of each kind of brim that lies in that region (the bed). */
    const earMax = num('brim_ears_max_angle'), earDetect = num('brim_ears_detection_length'), earsOuterOnly = bool('brim_ears_outer_only');
    /** Combine brims: the brim area of each object (filled once, merged, below) instead of its loops. */
    const brimAreas: Paths[] = [];
    const brimFor = (paths: Paths, o: number, clip?: Paths, area?: boolean) => {
      let type = brimType;
      if (type === 'auto_brim') {
        const b = bounds(paths);
        const minDim = Math.min(b.maxX - b.minX, b.maxY - b.minY) / SCALE;
        const height = objLast[o] >= 0 ? zs[objLast[o]] - shift : maxZ;
        type = isFinite(minDim) && (height / Math.max(minDim, 0.1) > 3 || minDim < 6) ? 'outer_only' : 'no_brim';
      }
      const out: PathItem[] = [];
      if (type === 'no_brim' || bw <= 0 || !paths.length) return out;
      const exs0 = toExPolygons(paths);
      const count = Math.max(1, Math.floor(bw / s));
      const outers = exs0.map((e) => e.contour);
      if (type === 'brim_ears') {
        // round ears on the painted points, or on the sharp convex corners of the first layer
        const painted = meshes[o].brimEars ?? [];
        const centers: [number, number][] = painted.length ? painted : [];
        // auto ears: convex corners sharper than the max angle, on the outline simplified by the detection radius;
        // hole corners too unless outer only
        const filled = union(outers);
        const holeLoops = earsOuterOnly ? [] : exs0.flatMap((e) => e.holes);
        if (!painted.length) for (const c of [...outers, ...holeLoops]) {
          // ears outer only: no corners of parts enclosed by a hole
          if (earsOuterOnly && exs0.some((e) => e.contour !== c && e.holes.length && intersection([c], e.holes.map((h) => h.slice().reverse())).length)) continue;
          pushAll(centers, sharpCorners(decimateLoop(c, earDetect), earMax));
        }
        if (!centers.length) return out;
        let ears = difference(union(centers.map(([x, y]) => circlePath(x, y, bw))), offset(paths, gap + w / 2));
        if (earsOuterOnly) ears = difference(ears, filled);
        if (clip) ears = intersection(ears, clip);
        if (area) { brimAreas.push(ears); return out; }
        for (const p of concentricFill(ears, s, w / 2)) out.push({ ...p, feature: 'brim', width: w, flow: 1 });
        return out;
      }
      if (area) {
        // the bands the loops below would cover
        if (type === 'outer_only' || type === 'outer_and_inner') brimAreas.push(difference(offset(outers, gap + count * s), offset(outers, gap)));
        if (type === 'inner_only' || type === 'outer_and_inner') {
          const holes = exs0.flatMap((e) => e.holes.map((h) => h.slice().reverse()));
          brimAreas.push(difference(offset(holes, -gap), offset(holes, -(gap + count * s))));
        }
        return out;
      }
      if (type === 'outer_only' || type === 'outer_and_inner') {
        if (clip) {
          // the outer band (contours only, never the holes) on the bed, filled with loops that follow the cut
          const band = intersection(difference(offset(outers, gap + bw + w / 2), offset(outers, gap)), clip);
          for (const p of concentricFill(band, s, w / 2)) out.push({ ...p, feature: 'brim', width: w, flow: 1 });
        } else for (let k = count - 1; k >= 0; k--) for (const p of offset(outers, gap + w / 2 + k * s)) out.push({ pts: pathToPoly(p), closed: true, feature: 'brim', width: w, flow: 1 });
      }
      if (type === 'inner_only' || type === 'outer_and_inner') {
        const holes = exs0.flatMap((e) => e.holes.map((h) => h.slice().reverse()));
        for (let k = 0; k < count; k++) for (const p of offset(holes, -(gap + w / 2 + k * s))) {
          const loop: PathItem = { pts: pathToPoly(p), closed: true, feature: 'brim', width: w, flow: 1 };
          if (!clip || !offBed([loop])) out.push(loop);
        }
      }
      return out;
    };
    let clipped = false;
    // brim follows compensated outline (on) or the first layer before elephant foot compensation (off)
    const brimBase = (o: number) => (!bool('brim_use_efc_outline') && rawFirstLayer.get(objSlices[o])) || (objSlices[o][objStart] ?? []);
    // combine brims (Orca): one brim for all objects, merged where they meet; not with per-object skirts or by-object printing
    const combine = bool('combine_brims') && meshes.length > 1 && !byObject && !(str('skirt_type') === 'perobject' && num('skirt_loops') > 0);
    if (combine) {
      for (let o = 0; o < meshes.length; o++) brimFor(brimBase(o), o, undefined, true);
      const keep = union(meshes.flatMap((_, o) => offset(brimBase(o), gap + w / 2)));
      let region = brimAreas.length ? difference(union(brimAreas.flat()), keep) : [];
      if (region.length && difference(region, bedIn).length) { region = intersection(region, bedIn); clipped = true; }
      for (const p of concentricFill(region, s, w / 2)) brimLoops.push({ ...p, feature: 'brim', width: w, flow: 1 });
    } else for (let o = 0; o < meshes.length; o++) {
      let b = brimFor(brimBase(o), o);
      // a brim wider than the room around the part: keep only what is on the bed, same brim type
      if (b.length && offBed(b)) { b = brimFor(brimBase(o), o, bedIn); clipped = true; }
      if (b.length) { brimByObj.set(o, b); pushAll(brimLoops, b); }
    }
    if (clipped) warn('The brim is cut at the edge of the plate: the part is too close to the edge for the full brim width.');
    if (brimType === 'auto_brim' && brimLoops.length) brimType = 'outer_only';
    const skirtN = Math.round(num('skirt_loops'));
    if (skirtN > 0) {
      // one skirt around everything (combined), or one around each object (per object)
      const extra = [...(support ? [...support.base[0], ...support.iface[0]] : []), ...(useTower ? towerBody : [])];
      const perObj = str('skirt_type') === 'perobject' && meshes.length > 1;
      const bases: { base: Paths; owner?: number }[] = perObj
        ? meshes.map((_, o) => ({ base: union([...(objSlices[o][objStart] ?? []), ...(o === 0 ? extra : [])]), owner: o })).filter((b) => b.base.length)
        : [{ base: union([...layerSlices[objStart], ...extra]) }];
      // skirt minimum extrusion length: more loops until the skirt pushes at least this much filament
      const minFil = Math.max(0, num('min_skirt_length'));
      const fd = filaments[0]?.diameter || 1.75, filPerMm = ((w > h0 ? (w - h0) * h0 + Math.PI * (h0 / 2) ** 2 : w * h0) * (filaments[0]?.flowRatio || 1)) / (Math.PI * (fd / 2) ** 2);
      const startAng = (num('skirt_start_angle') * Math.PI) / 180;
      let dropped = 0;
      for (const { base: b0, owner } of bases) {
        const base = brimLoops.length ? union(b0, offset(b0, gap + bw)) : b0;
        const bb = bounds(base), cx = (bb.minX + bb.maxX) / 2 / SCALE, cy = (bb.minY + bb.maxY) / 2 / SCALE;
        const loops: PathItem[] = [];
        let fil = 0;
        for (let k = 0; k < 200 && (k < skirtN || (minFil > 0 && fil < minFil)); k++) {
          for (const p of offset(base, num('skirt_distance') + w / 2 + k * s, 'round')) {
            let pts = pathToPoly(p);
            // skirt start point: the loop starts at the given angle around the objects' centre
            let best = 0, bestD = -Infinity;
            for (let q = 0; q < pts.length; q += 2) { const d = (pts[q] - cx) * Math.cos(startAng) + (pts[q + 1] - cy) * Math.sin(startAng) - Math.abs((pts[q] - cx) * Math.sin(startAng) - (pts[q + 1] - cy) * Math.cos(startAng)); if (d > bestD) { bestD = d; best = q / 2; } }
            pts = rotateLoop(pts, best);
            const loop: PathItem = { pts, closed: true, feature: 'skirt', width: w, flow: 1, wallDepth: k, owner };
            // a skirt loop only primes the nozzle: one that leaves the plate is left out
            if (offBed([loop])) dropped++; else { loops.push(loop); fil += polyLen(pts, true) * filPerMm; }
          }
        }
        // outermost first, ending next to the objects
        pushAll(skirtLoops, loops.reverse());
      }
      if (dropped) warn(`${dropped} skirt loop${dropped === 1 ? '' : 's'} would leave the plate and ${dropped === 1 ? 'was' : 'were'} left out.`);
    }
  }

  // ---------- stage 7/8: infill, ordering, ops
  progress('Generating infill & toolpaths', 0.58);
  const resolution = num('resolution');
  const solidDir = num('solid_infill_direction');
  // centre of each object's footprint on the plate (separated infills, symmetric infill, surface pattern centres)
  const objCentres = new Map<number, [number, number]>();
  const objCentre = (o: number): [number, number] => {
    let c = objCentres.get(o);
    if (!c) {
      const v = meshes[o].vertices;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let k = 0; k < v.length; k += 3) { x0 = Math.min(x0, v[k]); x1 = Math.max(x1, v[k]); y0 = Math.min(y0, v[k + 1]); y1 = Math.max(y1, v[k + 1]); }
      c = v.length ? [(x0 + x1) / 2, (y0 + y1) / 2] : [0, 0];
      objCentres.set(o, c);
    }
    return c;
  };
  const wallSeq = str('wall_sequence');

  let curObj = -1; // object being emitted: per-object speeds apply to its features
  let curLayer = 0;
  const cn = (k: string) => (k in live ? live[k] : curObj >= 0 ? onum(curObj, curLayer, k) : Number(cfg[k] ?? 0));
  const firstLayerSpeed = (feat: FeatureType) =>
    feat === 'outer_wall' || feat === 'inner_wall' || feat === 'overhang_wall' || feat === 'skirt' || feat === 'brim' || feat === 'prime_tower' || feat === 'gap_infill' ? cn('initial_layer_speed') : cn('initial_layer_infill_speed');
  // Number of slow layers: the layers after the first ramp linearly from the first layer speed to the normal one
  const slowLayers = Math.max(0, Math.round(num('slow_down_layers')));
  const speedFor = (feat: FeatureType, layer: number): number => {
    if (feat === 'skirt' && num('skirt_speed') > 0) return num('skirt_speed');
    if (layer === 0) return firstLayerSpeed(feat);
    const v = normalSpeed(feat);
    if (slowLayers > 1 && layer < slowLayers && feat !== 'travel') {
      const v0 = firstLayerSpeed(feat);
      return v0 < v ? v0 + ((v - v0) * layer) / slowLayers : v;
    }
    return v;
  };
  const normalSpeed = (feat: FeatureType): number => {
    switch (feat) {
      case 'outer_wall': return cn('outer_wall_speed');
      case 'inner_wall': return cn('inner_wall_speed');
      case 'overhang_wall': return cn('outer_wall_speed');
      case 'sparse_infill': return cn('sparse_infill_speed');
      case 'internal_solid_infill': case 'bottom_surface': return cn('internal_solid_infill_speed');
      case 'top_surface': return cn('top_surface_speed');
      case 'bridge': return cn('bridge_speed');
      case 'internal_bridge': return floatOrPercent((curObj >= 0 ? ocfg(curObj, curLayer) : cfg).internal_bridge_speed ?? '150%', cn('bridge_speed')) || cn('bridge_speed');
      case 'gap_infill': return cn('gap_infill_speed');
      case 'ironing': return cn('ironing_speed');
      case 'support': return cn('support_speed');
      case 'support_interface': return cn('support_interface_speed');
      case 'prime_tower': return Math.min(cn('sparse_infill_speed'), num('prime_tower_max_speed') || 90);
      default: return cn('initial_layer_speed');
    }
  };
  const accelFor = (feat: FeatureType, layer: number): number => {
    if (layer === 0) return cn('initial_layer_acceleration');
    if (feat === 'outer_wall' || feat === 'overhang_wall') return cn('outer_wall_acceleration');
    if (feat === 'inner_wall') return cn('inner_wall_acceleration') || cn('default_acceleration');
    if (feat === 'top_surface' || feat === 'ironing') return cn('top_surface_acceleration');
    if (feat === 'sparse_infill') return floatOrPercent(cfg.sparse_infill_acceleration, cn('default_acceleration')) || cn('default_acceleration');
    if (feat === 'internal_solid_infill') return floatOrPercent(cfg.internal_solid_infill_acceleration, cn('default_acceleration')) || cn('default_acceleration');
    if (feat === 'bridge') return floatOrPercent(cfg.bridge_acceleration, cn('outer_wall_acceleration')) || cn('default_acceleration');
    return cn('default_acceleration');
  };
  const jerkOn = num('default_jerk') > 0;
  const jerkFor = (feat: FeatureType, layer: number): number => {
    if (layer === 0) return num('initial_layer_jerk');
    if (feat === 'outer_wall' || feat === 'overhang_wall') return num('outer_wall_jerk');
    if (feat === 'inner_wall') return num('inner_wall_jerk');
    if (feat === 'top_surface' || feat === 'ironing') return num('top_surface_jerk');
    if (feat === 'sparse_infill' || feat === 'internal_solid_infill' || feat === 'bottom_surface' || feat === 'bridge' || feat === 'gap_infill') return num('infill_jerk');
    return num('default_jerk');
  };
  /** Speed / acceleration caps from "Slow down by height". */
  const heightCap = (zz: number): { v: number; a: number } => {
    if (!bool('enable_height_slowdown')) return { v: Infinity, a: Infinity };
    const z0 = num('slowdown_start_height'), z1 = num('slowdown_end_height');
    if (zz < z0) return { v: Infinity, a: Infinity };
    const t = z1 > z0 ? Math.min(1, (zz - z0) / (z1 - z0)) : 1;
    return { v: num('slowdown_start_speed') + t * (num('slowdown_end_speed') - num('slowdown_start_speed')), a: num('slowdown_start_acc') + t * (num('slowdown_end_acc') - num('slowdown_start_acc')) };
  };

  // per-tool settings: printer retraction with the filament's overrides
  let toolSet: Record<string, number | boolean | string> = {};
  const tnum = (k: string) => (k in live ? live[k] : Number(toolSet[k] ?? cfg[k] ?? 0));
  const tbool = (k: string) => (toolSet[k] ?? cfg[k]) === true;
  const tstr = (k: string) => String(toolSet[k] ?? cfg[k] ?? '');
  let retractLen = 0, retractSpeed = 0, deretractSpeed = 0, zHop = 0, minTravel = 0, restartExtra = 0;
  const loadRetraction = () => {
    retractLen = tnum('retraction_length'); retractSpeed = tnum('retraction_speed'); deretractSpeed = tnum('deretraction_speed') || retractSpeed;
    zHop = tnum('z_hop'); minTravel = tnum('retraction_minimum_travel'); restartExtra = tnum('retract_restart_extra');
  };
  loadRetraction();
  let objFlow = 1; // per-object flow multiplier (flow calibration)
  // "Set other flow ratios": a flow multiplier per line type, on top of the filament and object flow ratios
  const otherFlow = bool('set_other_flow_ratios');
  const ROLE_FLOW: Partial<Record<FeatureType, string>> = {
    outer_wall: 'outer_wall_flow_ratio', inner_wall: 'inner_wall_flow_ratio', overhang_wall: 'overhang_flow_ratio', sparse_infill: 'sparse_infill_flow_ratio',
    internal_solid_infill: 'internal_solid_infill_flow_ratio', gap_infill: 'gap_fill_flow_ratio', support: 'support_flow_ratio', support_interface: 'support_interface_flow_ratio',
  };
  // small area infill flow compensation: short solid infill lines get less flow (OrcaSlicer's model)
  const smallArea = bool('small_area_infill_flow_compensation') ? flowModel(str('small_area_infill_flow_compensation_model') || DEFAULT_FLOW_MODEL) : null;
  if (bool('small_area_infill_flow_compensation') && !smallArea) warn('Small area flow compensation: the flow compensation model is not valid and was ignored.');
  const SMALL_AREA_ROLES = new Set<FeatureType>(['internal_solid_infill', 'top_surface', 'bottom_surface']);
  const roleFlow = (f: FeatureType) => { const k = ROLE_FLOW[f]; return k ? (Number.isFinite(cn(k)) && cfg[k] !== undefined ? cn(k) : 1) : 1; };
  const travelSpeed = num('travel_speed');
  const reduceMode = str('reduce_infill_retraction_mode') || 'auto';
  const labels = cfg.exclude_object !== false && flavor !== 'bbl';
  const labelName = (o: number) => `obj${o}_${meshes[o].name.replace(/[^A-Za-z0-9_]/g, '_')}`;
  const seamTris = meshes.map((m) => paintedTris(m as IndexedMesh, m.paint?.seam));
  const actionsByLayer = new Map<number, typeof opts.layerActions>();
  for (const a of opts.layerActions ?? []) {
    if (a.type === 'color') continue;
    const li = zs.findIndex((zz) => zz >= a.z - 1e-6);
    if (li < 0) continue;
    actionsByLayer.set(li, [...(actionsByLayer.get(li) ?? []), a]);
  }
  const timelapse = str('time_lapse_gcode');
  const smoothLapse = str('timelapse_type') === 'smooth';
  if (smoothLapse && timelapse && !useTower) warn('Smooth timelapse needs a prime tower to wipe the nozzle; snapshots are taken in place.');
  const avoidWalls = bool('reduce_crossing_wall');
  type MotionApp = { enabled?: boolean; target?: { type?: string }; mask?: { z_start?: number; z_end?: number; fade_in_mm?: number; fade_out_mm?: number } };
  // whole-body motions move every wall in their height range; motions on picked faces only touch part of a layer
  const motionApps = ((opts.plugins as Record<string, { applications?: MotionApp[] }> | undefined)?.motionex?.applications ?? []).filter((a) => a.enabled !== false && (a.target?.type ?? 'body') === 'body');
  /** Whether a whole-body Motionex motion may move walls at this height (its mask range, fades included). */
  const motionAt = (zz: number) => motionApps.some((a) => zz >= (a.mask?.z_start ?? 0) - (a.mask?.fade_in_mm ?? 0) - 1e-6 && zz <= (a.mask?.z_end ?? Infinity) + (a.mask?.fade_out_mm ?? 0) + 1e-6);
  const scarfFromProcess = bool('override_filament_scarf_seam_setting');

  const layerOps: LayerOps[] = [];
  let px = 0, py = 0;
  // false until the first travel: after the start G-code the head is wherever the maker's macros left it
  // (Snapmaker U1: the end of the purge line at X185 Y1), not at 0,0, so a hop must not draw around px/py yet
  let posKnown = false;
  let retracted = false;
  // tool changers: each parked head keeps the filament it was retracted by (retract_length_toolchange, as in
  // Orca / Snapmaker Orca); it comes back when that head is picked up again. null = the normal retraction
  const parkedRetract = new Map<number, number>();
  const vendorTpl = usesVendorTemplates(cfg);
  let headWrap: boolean | null = null;
  let firstVars: Record<string, number[]> | null = null;
  /** First layer bounds of the objects (Bambu: first_layer_print_min/max/size, first_layer_center_no_wipe_tower). */
  const firstLayerVars = () => {
    if (firstVars) return firstVars;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of layerSlices[objStart] ?? []) for (const q of p) { minX = Math.min(minX, q.X / SCALE); minY = Math.min(minY, q.Y / SCALE); maxX = Math.max(maxX, q.X / SCALE); maxY = Math.max(maxY, q.Y / SCALE); }
    if (!isFinite(minX)) minX = minY = maxX = maxY = 0;
    firstVars = { first_layer_print_min: [minX, minY], first_layer_print_max: [maxX, maxY], first_layer_print_size: [maxX - minX, maxY - minY], first_layer_center_no_wipe_tower: [(minX + maxX) / 2, (minY + maxY) / 2] };
    return firstVars;
  };
  /** Bambu A1: some printed area lies in the machine's head wrap detect zone (the timelapse then skips its park move). */
  const inHeadWrapZone = () => {
    if (headWrap !== null) return headWrap;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const sl of layerSlices) for (const p of sl) for (const q of p) { minX = Math.min(minX, q.X); minY = Math.min(minY, q.Y); maxX = Math.max(maxX, q.X); maxY = Math.max(maxY, q.Y); }
    const zone = String(cfg.head_wrap_detect_zone ?? '');
    headWrap = isFinite(minX) && !!zone && inZone(zone.split(','), { minX: minX / SCALE, minY: minY / SCALE, maxX: maxX / SCALE, maxY: maxY / SCALE });
    return headWrap;
  };
  let toolchangeCount = 0;
  let pendingDeretract: number | null = null;
  /** deretract_speed_extruder_change: the speed of the first deretraction after a filament change. */
  let changeDeretract: number | null = null;
  let prevSeams: [number, number][] = [];
  let curZ = 0;
  let curTool = -1;
  let safeZ: number | null = null; // by-object: travel to the next object above everything printed
  /** The last extruded path, newest point last (for wipe moves). */
  let wipeTrail: number[] = [];
  /** The wipe trail ends shifted off the last path (wipe inward): the wipe starts by stepping onto it. */
  let wipeShifted = false;
  /** Line type of the last extrusion, across layers (role based wipe speed). */
  let lastPrinted: FeatureType | null = null;
  let maxPrinted = 0;

  // emission of one layer (all objects, or one object when printing by object)
  const curled = new Map<number, PointGrid>();
  const isWall = (f: FeatureType) => f === 'outer_wall' || f === 'inner_wall' || f === 'overhang_wall';
  const emitLayer = (i: number, only: number | null) => {
    const h = hs[i], zTop = zs[i];
    curLayer = i;
    const ops: Op[] = [];
    const seams: [number, number][] = [];
    let lastFeature: FeatureType | null = null;
    let accelSet = -1, jerkSet = -1;
    const objs = meshes.map((_, o) => o).filter((o) => only === null || o === only);
    const capH = heightCap(zTop);
    const layerTravel = i > 0 && avoidWalls ? new TravelPlanner(union(objs.map((o) => offset(objSlices[o][i], -lw0('outer_wall_line_width'))).flat()), (direct) => {
      const v = cfg.max_travel_detour_distance;
      return floatOrPercent(v, direct);
    }) : null;
    const infillArea = reduceMode === 'auto' ? union(objs.flatMap((o) => regions[i][o].sparse)) : [];
    const inInfill = infillArea.length ? insideTester(infillArea) : () => false;
    let firstTravel = true;
    const hopAllowed = (zz: number) => zz >= tnum('retract_lift_above') - 1e-9 && (tnum('retract_lift_below') <= 0 || zz <= tnum('retract_lift_below') + 1e-9);
    // Z hop "On surfaces": only for travel that ends over a top surface, a bottom surface (the first layer is all bottom), or either
    const enforce = tstr('retract_lift_enforce') || 'all';
    let topHit: ((x: number, y: number) => boolean) | null = null, botHit: ((x: number, y: number) => boolean) | null = null;
    const hopSurface = (x: number, y: number) => {
      if (enforce === 'all') return true;
      const wantTop = enforce === 'top' || enforce === 'top_bottom', wantBot = enforce === 'bottom' || enforce === 'top_bottom';
      if (wantBot && i === objStart) return true;
      if (wantTop && (topHit ??= insideTester(union(objs.flatMap((o) => regions[i][o].top))))(x, y)) return true;
      return wantBot && (botHit ??= insideTester(union(objs.flatMap((o) => regions[i][o].bottom))))(x, y);
    };
    const zTravel = num('travel_speed_z') || num('max_speed_z') || 10;
    const travelJerk = i === 0 ? floatOrPercent(cfg.initial_layer_travel_jerk ?? '100%', num('travel_jerk')) || num('travel_jerk') : num('travel_jerk');
    // first layer travel: an explicit speed, or a percentage of the travel speed (kept under 250 mm/s for adhesion)
    const firstTravel0 = String(cfg.initial_layer_travel_speed ?? '100%');
    const tf0 = (firstTravel0.trim().endsWith('%') ? Math.min(floatOrPercent(firstTravel0, travelSpeed), 250) : floatOrPercent(firstTravel0, travelSpeed)) || Math.min(travelSpeed, 250);

    const travel = (x: number, y: number, feat: FeatureType, zz = zTop) => {
      if (isNaN(px)) {
        // position unknown after a filament change macro
        ops.push({ k: 'move', x, y, z: zz, e: 0, f: travelSpeed, feature: 'travel', w: 0, h, travel: true });
        px = x; py = y; curZ = zz; firstTravel = false; posKnown = true;
        return;
      }
      if (safeZ !== null) {
        // by object: rise above every printed object, cross over, then come down on the next one
        ops.push({ k: 'move', x: px, y: py, z: safeZ, e: 0, f: zTravel, feature: 'travel', w: 0, h, travel: true, fixed: true });
        ops.push({ k: 'move', x, y, z: safeZ, e: 0, f: travelSpeed, feature: 'travel', w: 0, h, travel: true });
        ops.push({ k: 'move', x, y, z: zz, e: 0, f: zTravel, feature: 'travel', w: 0, h, travel: true, fixed: true });
        safeZ = null; px = x; py = y; curZ = zz; firstTravel = false; posKnown = true; posKnown = true;
        return;
      }
      const d = Math.hypot(x - px, y - py);
      if (d < 1e-4 && Math.abs(zz - curZ) < 1e-6) return;
      const sparseHop = lastFeature === 'sparse_infill' && feat === 'sparse_infill';
      let skipRetract = false;
      if (reduceMode === 'enabled') skipRetract = sparseHop;
      else if (reduceMode === 'auto' && sparseHop && infillArea.length) skipRetract = inInfill((px + x) / 2, (py + y) / 2) && inInfill(x, y);
      const layerChange = firstTravel && i > 0 && tbool('retract_when_changing_layer');
      const needRetract = retractLen > 0 && (d > minTravel || layerChange) && !skipRetract;
      if (needRetract && !retracted) retract();
      // short hops (shorter than the retraction minimum travel) use the gentler short-travel acceleration
      const ta = i === 0 ? num('initial_layer_travel_acceleration') : d < minTravel && num('travel_short_distance_acceleration') > 0 ? num('travel_short_distance_acceleration') : num('travel_acceleration');
      if (ta && Math.min(ta, capH.a) !== accelSet) { accelSet = Math.min(ta, capH.a); ops.push({ k: 'accel', a: accelSet }); }
      if (jerkOn && travelJerk !== jerkSet) { jerkSet = travelJerk; ops.push({ k: 'jerk', j: jerkSet }); }
      const via = layerTravel ? layerTravel.route(px, py, x, y) : [];
      const hop = needRetract && zHop > 0 && hopAllowed(zz) && hopSurface(x, y);
      const tf = i === 0 ? tf0 : travelSpeed;
      const zf = zTravel;
      if (hop) {
        let type = tstr('z_hop_types') || 'normal';
        if (type === 'auto') type = layerSlices[i].length && crossesSlice(px, py, x, y, layerSlices[i]) ? 'spiral' : 'slope';
        const hz = curZ + zHop;
        const slope = Math.max(1, Math.min(90, tnum('travel_slope') || 90));
        if (type === 'slope' && slope >= 89.999) type = 'normal';
        const here = posKnown && Number.isFinite(px) && Number.isFinite(py);
        if (!here) {
          // position unknown (first travel, after a tool change): a spiral or a straight lift around a guessed
          // 0,0 drives the head past the axis limit (Y-0.8 → Snapmaker U1 0003-0522 "Y-axis exceeded travel
          // limit"). Rise on the way to the target instead.
          type = 'unknown'; // no lift move here: the travel below runs at hop height, then comes down
        }
        if (type === 'unknown') { /* see above */ } else if (type === 'spiral') ops.push({ k: 'lift', x: px, y: py, z: hz, r: Math.max(0.5, zHop * 2), f: Math.min(tf, 200) });
        else if (type === 'slope' && d > zHop * 2) {
          // rise while already moving: reach the hop height after hop / tan(travel angle) along the travel (at most half of it)
          const t = Math.min(0.5, zHop / Math.tan((slope * Math.PI) / 180) / d);
          ops.push({ k: 'move', x: px + (x - px) * t, y: py + (y - py) * t, z: hz, e: 0, f: tf, feature: 'travel', w: 0, h, travel: true });
        } else ops.push({ k: 'move', x: px, y: py, z: hz, e: 0, f: zf, feature: 'travel', w: 0, h, travel: true, fixed: true });
        for (let k = 0; k < via.length; k += 2) ops.push({ k: 'move', x: via[k], y: via[k + 1], z: hz, e: 0, f: tf, feature: 'travel', w: 0, h, travel: true });
        ops.push({ k: 'move', x, y, z: hz, e: 0, f: tf, feature: 'travel', w: 0, h, travel: true });
        ops.push({ k: 'move', x, y, z: zz, e: 0, f: zf, feature: 'travel', w: 0, h, travel: true, fixed: true });
      } else {
        for (let k = 0; k < via.length; k += 2) ops.push({ k: 'move', x: via[k], y: via[k + 1], z: curZ, e: 0, f: tf, feature: 'travel', w: 0, h, travel: true });
        ops.push({ k: 'move', x, y, z: zz, e: 0, f: tf, feature: 'travel', w: 0, h, travel: true });
      }
      curZ = zz; px = x; py = y; firstTravel = false; posKnown = true;
    };
    /** Retract, wiping back along the last path while doing it if the printer / filament asks for it. */
    const retract = () => {
      if (retracted || retractLen <= 0) return;
      const wipeLen = tbool('wipe') ? tnum('wipe_distance') : 0;
      if (wipeLen > 0 && wipeTrail.length >= 4 && !isNaN(px)) {
        // firmware retraction (G10) cannot be split over the wipe: wipe dry, then retract once
        const fw = cfg.use_firmware_retraction === true;
        const before = fw ? 0 : Math.max(0, Math.min(1, tnum('retract_before_wipe') / 100));
        const after = fw ? 1 : Math.max(0, Math.min(1 - before, tnum('retract_after_wipe') / 100));
        if (before > 0) ops.push({ k: 'retract', len: retractLen * before, speed: retractSpeed });
        const rest = retractLen * (1 - before - after);
        // walk back along the trail
        const pts: number[] = [];
        let left = wipeLen, cx = px, cy = py;
        for (let k = wipeTrail.length - (wipeShifted ? 2 : 4); k >= 0 && left > 1e-6; k -= 2) {
          const nx = wipeTrail[k], ny = wipeTrail[k + 1];
          const seg = Math.hypot(nx - cx, ny - cy);
          if (seg < 1e-6) continue;
          const t = Math.min(1, left / seg);
          cx = cx + (nx - cx) * t; cy = cy + (ny - cy) * t;
          pts.push(cx, cy);
          left -= seg * t;
        }
        const total = wipeLen - left;
        // role based wipe speed: wipe at the speed of the line just printed
        const ws = bool('role_based_wipe_speed') && lastPrinted ? speedFor(lastPrinted, i) : travelSpeed * Math.max(0.01, num('wipe_speed') / 100);
        let done = 0;
        for (let k = 0; k < pts.length; k += 2) {
          const seg = Math.hypot(pts[k] - (k ? pts[k - 2] : px), pts[k + 1] - (k ? pts[k - 1] : py));
          const e = total > 0 ? -(rest * seg) / total : 0;
          done += seg;
          ops.push({ k: 'move', x: pts[k], y: pts[k + 1], z: curZ, e, f: ws, feature: 'travel', w: 0, h, travel: true });
        }
        if (pts.length) { px = pts[pts.length - 2]; py = pts[pts.length - 1]; }
        if (rest > 0 && total <= 0) ops.push({ k: 'retract', len: rest, speed: retractSpeed });
        if (after > 0) ops.push({ k: 'retract', len: retractLen * after, speed: retractSpeed });
        void done;
      } else ops.push({ k: 'retract', len: retractLen, speed: retractSpeed });
      retracted = true;
      wipeTrail = [];
    };

    /** Pass j (0 = bottom) of n of a subdivided mix layer: 1/n of the layer height, its top j+1 n-ths up. */
    const toPass = (it: PathItem, j: number, n: number): PathItem => {
      it.height = h / n;
      if (it.depth) { it.depth = undefined; it.flows = undefined; } // no scarf ramp on a thin pass
      if (j < n - 1) it.depth = new Array(it.pts.length / 2 + 2).fill((n - 1 - j) / n);
      return it;
    };
    const extrudePath = (it: PathItem) => {
      let pts = it.pts;
      if (pts.length < 4) return;
      const fl = filaments[Math.max(0, curTool)];
      const filArea = Math.PI * (fl.diameter / 2) ** 2;
      const hItem = it.height ?? h;
      const startZ = it.spiral ? zTop - h : zTop - (it.depth ? it.depth[0] * h : 0);
      if (it.leadIn && !it.closed && pts.length >= 4) {
        const dx = pts[0] - pts[2], dy = pts[1] - pts[3], L = Math.hypot(dx, dy) || 1;
        travel(pts[0] + (dx / L) * it.leadIn, pts[1] + (dy / L) * it.leadIn, it.feature, startZ);
      }
      if (it.primeAt && retractLen > 0 && (retracted || isNaN(px) || Math.hypot(pts[0] - px, pts[1] - py) > minTravel)) {
        // wipe before external loop: arrive (retracted) just inside the part, prime there, then move onto the seam
        travel(it.primeAt[0], it.primeAt[1], it.feature, startZ);
        if (retracted) {
        const back = pendingDeretract ?? retractLen + restartExtra; pendingDeretract = null; if (back > 0) ops.push({ k: 'retract', len: -back, speed: changeDeretract ?? deretractSpeed }); changeDeretract = null; retracted = false;
        }
      }
      travel(pts[0], pts[1], it.feature, startZ);
      if (retracted) { const back = pendingDeretract ?? retractLen + restartExtra; pendingDeretract = null; if (back > 0) ops.push({ k: 'retract', len: -back, speed: changeDeretract ?? deretractSpeed }); changeDeretract = null; retracted = false; } // a negative extra can cancel the prime, never pull filament back
      const a = Math.min(accelFor(it.feature, i), capH.a);
      if (a !== accelSet) { ops.push({ k: 'accel', a }); accelSet = a; }
      if (jerkOn) { const j = jerkFor(it.feature, i); if (j !== jerkSet) { ops.push({ k: 'jerk', j }); jerkSet = j; } }
      const thick = (it.feature === 'bridge' && bool('thick_bridges')) || (it.feature === 'internal_bridge' && cfg.thick_internal_bridges !== false);
      const hEff = thick ? Math.min(it.width, nozzle) : hItem;
      const xsOf = (w: number) => (w > hItem ? (w - hItem) * hItem + Math.PI * (hItem / 2) ** 2 : w * hItem);
      const xs = thick ? Math.PI * (nozzle / 2) ** 2 : xsOf(it.width);
      const layerFlow = i === 0 ? (num('initial_layer_flow_ratio') || 1) : 1;
      const surfFlow = it.feature === 'top_surface' ? (cn('top_solid_infill_flow_ratio') || 1) : it.feature === 'bottom_surface' ? (cn('bottom_solid_infill_flow_ratio') || 1) : it.feature === 'brim' ? (num('brim_flow_ratio') || 1) : 1;
      const flowMul = (fl.flowRatio || 1) * it.flow * objFlow * layerFlow * surfFlow;
      const ePerMm = (xs / filArea) * flowMul;
      const varW = it.widths && it.widths.length * 2 === pts.length ? it.widths : null;
      let v = it.speedSet !== undefined ? it.speedSet : it.speed !== undefined ? Math.min(speedFor(it.feature, i), it.speed) : speedFor(it.feature, i);
      v = Math.min(v, capH.v);
      const maxVol = 'filament_max_volumetric_speed' in live ? live.filament_max_volumetric_speed : fl.maxVolumetricSpeed;
      v = Math.min(v, (maxVol || 1e9) / Math.max(xs, 1e-6));
      const noSlow = it.noSlow;
      // support interface fan speed (filament): an exact fan for interfaces, so they bond less to the part
      const ifaceRaw = Number(toolSet.support_material_interface_fan_speed ?? cfg.support_material_interface_fan_speed ?? -1);
      const ifaceFan = it.feature === 'support_interface' && it.fanSet === undefined && ifaceRaw >= 0 ? ifaceRaw : undefined;
      const fanSetIt = ifaceFan ?? it.fanSet;
      if (it.closed) pts = [...pts, pts[0], pts[1]];
      let totalLen = 0;
      if (it.spiral) for (let k = 2; k < pts.length; k += 2) totalLen += Math.hypot(pts[k] - pts[k - 2], pts[k + 1] - pts[k - 1]);
      let run = 0;
      for (let k = 2; k < pts.length; k += 2) {
        const x = pts[k], y = pts[k + 1];
        const len = Math.hypot(x - px, y - py);
        if (len < 1e-5) continue;
        run += len;
        const idx = k / 2;
        const zz = it.spiral ? startZ + (h * run) / Math.max(totalLen, 1e-6) : it.depth ? zTop - (it.depth[idx] ?? 0) * h : zTop;
        // volumetric conservation: E follows the true 3-D segment length (spiral / non-planar paths change Z along the move)
        const len3 = Math.hypot(len, zz - curZ);
        const feat = it.feats?.[idx] ?? it.feature;
        const segFlow = it.flows?.[idx] ?? 1;
        const roleF = (otherFlow ? roleFlow(feat) : 1) * (smallArea && SMALL_AREA_ROLES.has(feat) ? smallArea(len) : 1);
        let sv = v;
        const cap = it.speeds?.[idx];
        if (cap !== undefined && cap > 0) sv = Math.min(sv, cap);
        const fanMin = it.fans?.[idx] ?? it.fanMin;
        if (varW) {
          const sw = (varW[idx - 1] + varW[idx]) / 2, sxs = xsOf(sw);
          const vv = Math.min(sv * Math.min(1, it.width / sw), (maxVol || 1e9) / Math.max(sxs, 1e-6));
          ops.push({ k: 'move', x, y, z: zz, e: len3 * (sxs / filArea) * flowMul * segFlow * roleF, f: vv, feature: feat, w: sw, h: hEff, travel: false, fanMin, fanSet: fanSetIt, noSlow });
        } else if (segFlow > 1e-6) {
          ops.push({ k: 'move', x, y, z: zz, e: len3 * ePerMm * segFlow * roleF, f: sv, feature: feat, w: it.width * Math.min(1.5, Math.max(0.3, segFlow)), h: hEff, travel: false, fanMin, fanSet: fanSetIt, noSlow, ...(it.depth ? { noArc: true } : {}) });
        } else {
          ops.push({ k: 'move', x, y, z: zz, e: 0, f: sv, feature: 'travel', w: 0, h, travel: true });
        }
        if (it.wipeShift) {
          // wipe inward: both ends of the segment move to its left, so the wipe runs parallel to the wall
          const sx = -((y - py) / len) * it.wipeShift, sy = ((x - px) / len) * it.wipeShift;
          if (wipeTrail.length >= 2) { wipeTrail[wipeTrail.length - 2] = px + sx; wipeTrail[wipeTrail.length - 1] = py + sy; }
          wipeTrail.push(x + sx, y + sy);
          wipeShifted = true;
        } else { wipeTrail.push(x, y); wipeShifted = false; }
        px = x; py = y; curZ = zz;
        if (wipeTrail.length > 400) wipeTrail = wipeTrail.slice(-200);
      }
      if (it.wipeIn) {
        // wipe on loops: a short dry step inward before leaving the loop, so its end does not blob on the surface
        ops.push({ k: 'move', x: it.wipeIn[0], y: it.wipeIn[1], z: curZ, e: 0, f: bool('role_based_wipe_speed') ? v : travelSpeed * Math.max(0.01, num('wipe_speed') / 100), feature: 'travel', w: 0, h, travel: true });
        px = it.wipeIn[0]; py = it.wipeIn[1];
      }
      if (zTop > maxPrinted) maxPrinted = zTop;
      lastFeature = it.feature; lastPrinted = it.feature;
    };
    /** Extrusion volume of a path (mm³), for flushing into infill / support / objects. */
    const volumeOf = (it: PathItem) => {
      const L = polyLen(it.pts, it.closed);
      const hh = it.height ?? h;
      const w = it.width;
      return L * (w > hh ? (w - hh) * hh + Math.PI * (hh / 2) ** 2 : w * hh) * it.flow;
    };

    // --- prime tower
    let towerOutlineDone = false;
    let bandsDone = 0;
    let towerUsed = false;
    let priming = false;
    let layerOrder: number[] = [];
    const towerW = () => (i === 0 ? lw0('initial_layer_line_width') : lw0('support_line_width'));
    const towerCx = tx + tw / 2, towerCy = ty + td / 2;
    const toBed = rotatorAbout(tune.rotation, towerCx, towerCy);
    // this layer's tower: as deep as its bands (Internal ribs off), widened by the stabilization cone, rotated
    const layerDepth = Math.min(td, Math.max(bandDepth, towerBands[i] * bandDepth));
    const layerBody = (() => {
      let b = layerDepth < td - 1e-6 ? intersection(towerBody0, [rectPath(tx - 1e4, ty - 1e4, tx + tw + 1e4, ty + layerDepth)]) : towerBody0;
      if (tune.wallType === 'cone' && tune.coneAngle > 0) b = coneBody(b, tune.coneAngle, towerTop, zTop, towerCx, ty + layerDepth / 2, layerDepth);
      return rotatePathsAbout(b, tune.rotation, towerCx, towerCy);
    })();
    // the tower layer printed here: its height (combined sparse layers) and Z (no sparse layers: the top of the tower + a layer)
    const towerH = towerHs ? towerHs[i] : h;
    const towerSkip = i > 0 && ((tune.noSparse && changesPerLayer[i] === 0) || (towerHs !== null && towerHs[i] === 0));
    const towerZ = tune.noSparse && i > 0 ? Math.min(zTop, towerPrintedZ + h) : zTop;
    const towerItem = (it: PathItem): PathItem => {
      towerUsed = true;
      const n = it.pts.length / 2;
      const out: PathItem = towerH !== h || towerZ < zTop - 1e-6 ? { ...it, height: towerHs ? towerH : h } : it;
      if (towerZ < zTop - 1e-6) out.depth = new Array(n + 1).fill((zTop - towerZ) / h);
      return out;
    };
    const towerOutline = (force = false) => {
      if (towerOutlineDone) return;
      // wipe tower filament: the walls wait for that filament when this layer prints it
      if (!force && tune.wallFilament >= 0 && curTool !== tune.wallFilament && layerOrder.includes(tune.wallFilament)) return;
      towerOutlineDone = true;
      const w = towerW();
      const loops: PathItem[] = [];
      if (i === 0) {
        const bw = num('prime_tower_brim_width');
        const n = Math.max(0, Math.round((bw < 0 ? 3 : bw) / w));
        for (let k = n; k >= 1; k--) for (const p of offset(layerBody, k * w)) loops.push({ pts: pathToPoly(p), closed: true, feature: 'brim', width: w, flow: 1 });
      }
      for (const p of offset(layerBody, -w / 2)) loops.push({ pts: pathToPoly(p), closed: true, feature: 'prime_tower', width: w, flow: 1 });
      for (const it of orderPaths(loops, px, py).paths) extrudePath(towerItem(it));
    };
    /** Band k of the tower: a purge (solid, after a change; `skip` mm already used by ramming) or a sparse layer. */
    const towerBand = (k: number, solid: boolean, skip = 0) => {
      const w = towerW();
      const y0 = ty + k * bandDepth + skip, y1 = Math.min(ty + layerDepth, ty + (k + 1) * bandDepth);
      if (y1 - y0 < w) return;
      const reg = rotatePathsAbout(offset([rectPath(tx, y0, tx + tw, y1)], -w), tune.rotation, towerCx, towerCy);
      const gapPct = Math.max(100, num('prime_tower_infill_gap') || 150) / 100;
      // purge lines: extra flow, spaced to match (and by the extra spacing); sparse lines no farther apart than the bridging distance
      const sparseGap = Math.max(w * gapPct, 4);
      const spacing = solid ? spacingOf(w, h) * tune.wipeSpacing : tune.bridging > 0 ? Math.min(sparseGap, tune.bridging) : sparseGap;
      const lines = linesFill(reg, spacing, (solid ? (i % 2 ? 45 : -45) : 90) + tune.rotation);
      const cap = solid && tune.maxPurgeSpeed > 0 ? { speed: tune.maxPurgeSpeed } : {};
      for (const it of orderPaths(lines.map((l) => ({ ...l, feature: 'prime_tower' as FeatureType, width: w, flow: solid ? tune.extraFlow : 1, ...cap })), px, py).paths) extrudePath(towerItem(it));
    };
    const towerActive = useTower && i <= lastChangeLayer;
    /** Box of band k in the tower frame, for the MMU / ramming sequences. */
    const bandCtx = (k: number, fs: Config | undefined): TowerCtx => ({
      xl: tx, xr: tx + tw, y0: ty + k * bandDepth, y1: Math.min(ty + layerDepth, ty + (k + 1) * bandDepth), w: towerW(), h: towerH, z: towerZ,
      filArea: Math.PI * ((filaments[Math.max(0, curTool)]?.diameter ?? 1.75) / 2) ** 2, toBed, cfg, fs, extraSpacing: tune.extraSpacing, verbose: bool('gcode_comments'),
    });
    /** Run a tower sequence: travel to its start, prime if retracted, then its moves. */
    const runTowerOps = (seq: Op[]) => {
      const first = seq.find((op) => op.k === 'move') as Extract<Op, { k: 'move' }> | undefined;
      if (!first) { pushAll(ops, seq); return; }
      travel(first.x, first.y, 'prime_tower', towerZ);
      if (retracted) { const back = pendingDeretract ?? retractLen + restartExtra; pendingDeretract = null; if (back > 0) ops.push({ k: 'retract', len: -back, speed: changeDeretract ?? deretractSpeed }); changeDeretract = null; retracted = false; }
      pushAll(ops, seq);
      towerUsed = true;
      for (let k = seq.length - 1; k >= 0; k--) { const op = seq[k]; if (op.k === 'move') { px = op.x; py = op.y; curZ = op.z; break; } }
    };

    // --- items of this layer, grouped by filament (walls / fills of each island; support; flush candidates)
    interface IslandJob { isl: Island; fills: PathItem[]; wallFil: number; gapFil: number; inside?: (x: number, y: number) => boolean }
    const jobsByObj = new Map<number, IslandJob[]>();
    const lowerSupport = i > objStart ? objSlices.map((sl) => sl[i - 1]) : null;
    const overhangRings = new Map<string, ((x: number, y: number) => boolean)[]>(); // per object & line width, this layer
    for (const o of objs) {
      const objIslands = layerIslands[i].filter((s) => s.obj === o);
      if (!objIslands.length) continue;
      curObj = o;
      const rg = regions[i][o];
      const sw = olw(o, i, 'internal_solid_infill_line_width'), twid = olw(o, i, 'top_surface_line_width'), spw = olw(o, i, 'sparse_infill_line_width');
      const w0 = lw0('initial_layer_line_width'), wb = (Number(cfg.initial_layer_infill_line_width) || w0);
      const overlap = onum(o, i, 'infill_wall_overlap') / 100;
      const solidAngle = solidDir + (i % 2 ? 90 : 0);
      // rotation templates, fixed top / bottom directions and "Align directions to model"
      const ocf = ocfg(o, i);
      const li = i - objStart;
      const modelRot = ocf.align_infill_direction_to_model === true ? (meshes[o].rotationZ ?? 0) : 0;
      const solidTpl = templateAngle(String(ocf.solid_infill_rotate_template ?? ''), li);
      const solidA = (solidTpl ?? solidAngle) + modelRot, solidD = (solidTpl ?? solidDir) + modelRot;
      const fixedDir = (k: string) => { const v = ocf[k]; return v === undefined || v === '' ? -1 : Number(v); };
      const topDir = fixedDir('top_layer_direction'), botDir = fixedDir('bottom_layer_direction');
      const topDirs: [number, number] | undefined = topDir >= 0 ? [topDir + modelRot, topDir + modelRot] : undefined;
      const botDirs: [number, number] | undefined = botDir >= 0 ? [botDir + modelRot, botDir + modelRot] : undefined;
      // top / bottom surfaces overlap the inner wall by their own amount (% of the inner wall width; -1 = infill/wall overlap)
      const tbRaw = ocf.top_bottom_infill_wall_overlap;
      const tbOv = tbRaw === undefined || tbRaw === '' || Number(tbRaw) < 0 ? undefined : (Number(tbRaw) / 100) * olw(o, i, 'inner_wall_line_width');
      // elephant foot layers density: internal solid infill of the compensated layers grows from this to 100%
      const efcLayers = Math.max(1, Math.round(onum(o, i, 'elefant_foot_compensation_layers') || 1));
      const efd = Math.max(0.05, Math.min(1, (Number(ocf.elefant_foot_layers_density ?? 100) || 100) / 100));
      const efcDensity = efd < 1 && !raftN && li >= 1 && li < efcLayers && onum(o, i, 'elefant_foot_compensation') > 0 ? efd + ((1 - efd) * (li - 1)) / Math.max(1, efcLayers - 1) : 1;
      const jobs: IslandJob[] = objIslands.map((isl) => ({ isl, fills: [], wallFil: featFil(o, i, 'wall', isl.fil), gapFil: featFil(o, i, 'wall', isl.fil) }));
      jobsByObj.set(o, jobs);
      for (const fil of new Set(objIslands.map((s) => s.fil))) {
        const fInner = filInner[i][o].get(fil) ?? [];
        const clipLimit = new Map<number, Paths>(); // the same fill limit is asked for by many regions of one layer
        const clipTo = (r: Paths, w: number, ovMm?: number) => {
          if (!r.length || !fInner.length) return [];
          const d = -(w / 2) + (ovMm ?? overlap * w);
          let lim = clipLimit.get(d);
          if (!lim) { lim = offset(fInner, d); clipLimit.set(d, lim); }
          return intersection(r, lim);
        };
        const fills: PathItem[] = [];
        const add = (polys: Polyline2[], feature: FeatureType, width: number, flow = 1, extra: Partial<PathItem> = {}) => {
          for (const p of polys) fills.push({ ...p, pts: simplify(p.pts, resolution, p.closed), feature, width, flow, ...extra });
        };
        const solidFil = featFil(o, i, 'solid', fil), sparseFil = featFil(o, i, 'sparse', fil);
        const surface = (r: Paths, pattern: string, w: number, feature: FeatureType, density = 1, extra: Partial<PathItem> = {}, dirs?: [number, number]) => {
          const topBot = feature === 'top_surface' || feature === 'bottom_surface';
          const reg = clipTo(r, w, topBot ? tbOv : undefined);
          if (!reg.length) return;
          const s = spacingOf(w, h) / Math.max(0.01, Math.min(1, density));
          // centre-based top / bottom patterns: centre (surface / model / assembly) and fill order (outward / inward)
          if (topBot && CENTRED_PATTERNS.has(pattern)) {
            const order = ostr(o, i, feature === 'top_surface' ? 'top_surface_fill_order' : 'bottom_surface_fill_order') || 'default';
            const cmode = ostr(o, i, 'center_of_surface_pattern') || 'each_surface';
            if (pattern !== 'concentric' || order !== 'default') {
              const groups: [Paths, [number, number] | null][] = pattern === 'concentric' || cmode === 'each_surface' ? [[reg, null]]
                : cmode === 'each_assembly' ? [[reg, objCentre(o)]]
                : objIslands.map((isl) => { const b = bounds([isl.ex.contour]); return [intersection(reg, exToPaths(isl.ex)), [(b.minX + b.maxX) / 2 / SCALE, (b.minY + b.maxY) / 2 / SCALE]]; });
              for (const [g, c] of groups) {
                if (!g.length) continue;
                const cs = centredSurface(g, pattern, s, c, order);
                add(cs.lines, feature, w, 1, { fil: solidFil, ...extra, ...(cs.keep ? { keepOrder: true } : {}) });
              }
              return;
            }
          }
          // monotonic line travel extend: each line is approached from inside the wall
          const ext = (pattern === 'monotonic' || pattern === 'monotonicline') ? (onum(o, i, 'monotonic_travel_into_wall') / 100) * w : 0;
          const [a1, a2] = dirs ?? [solidA, solidD];
          add(surfaceFill(reg, pattern, s, a1, a2), feature, w, 1, { fil: solidFil, ...(ext > 0 ? { leadIn: ext } : {}), ...extra });
        };
        /** Internal solid: narrow areas get concentric loops instead of short zig-zags. */
        const solidFill = (r: Paths, pattern: string, w: number, extra: Partial<PathItem> = {}, density = 1) => {
          const reg = clipTo(r, w);
          if (!reg.length) return;
          const s = spacingOf(w, h) / density;
          let wide = reg;
          if (obool(o, i, 'detect_narrow_internal_solid_infill')) {
            const keep = opening(reg, w * 1.5);
            const narrow = keep.length ? difference(reg, offset(keep, 0.01)) : reg;
            wide = keep;
            if (narrow.length) add(concentricFill(narrow, s, w / 2), 'internal_solid_infill', w, 1, { fil: solidFil, ...extra });
          }
          if (wide.length) add(surfaceFill(wide, pattern, s, solidA, solidD), 'internal_solid_infill', w, 1, { fil: solidFil, ...extra });
        };
        surface(rg.bottom, ostr(o, i, 'bottom_surface_pattern'), i === 0 ? wb : sw, 'bottom_surface', onum(o, i, 'bottom_surface_density') / 100 || 1, {}, botDirs);
        const autoBridge = (ex: ExPolygon) => { const b = bounds([ex.contour]); return (b.maxX - b.minX) > (b.maxY - b.minY) ? 90 : 0; };
        const relBridge = ocf.relative_bridge_angle === true;
        const bfs = filaments[solidFil]?.settings;
        const bridgeFan = (bfs?.enable_overhang_bridge_fan ?? cfg.enable_overhang_bridge_fan) !== false ? Number(bfs?.overhang_fan_speed ?? cfg.overhang_fan_speed ?? 100) : undefined;
        const extBridge = (paths: Paths) => {
          for (const ex of toExPolygons(clipTo(paths, nozzle))) {
            const ang = bridgeAngle(num('bridge_angle'), autoBridge(ex), relBridge, modelRot);
            const thick = bool('thick_bridges');
            const bw = bridgeWidth(ocf, nozzle, sw, thick);
            // external bridge density: line spacing over air (above 100% the lines overlap)
            const bd = Math.max(0.1, Math.min(1.25, (cfg.bridge_density === undefined ? 100 : num('bridge_density')) / 100));
            add(linesFill(exToPaths(ex), (thick ? bw : spacingOf(bw, h)) / bd, ang), 'bridge', bw, num('bridge_flow') || 1, { fil: solidFil, fanMin: bridgeFan });
          }
        };
        /** Internal bridges: own direction, density, flow, speed (line type), fan and thickness. */
        const intBridge = (paths: Paths, cross: boolean) => {
          const ibThick = ocf.thick_internal_bridges !== false;
          const ibFan = Number(bfs?.internal_bridge_fan_speed ?? cfg.internal_bridge_fan_speed ?? -1);
          const ibd = Math.max(0.1, Math.min(1.25, Number(ocf.internal_bridge_density ?? 100) / 100));
          for (const ex of toExPolygons(clipTo(paths, sw))) {
            const ang = bridgeAngle(onum(o, i, 'internal_bridge_angle'), autoBridge(ex), relBridge, modelRot) + (cross ? 90 : 0);
            const ibw = ibThick ? nozzle : sw;
            add(linesFill(exToPaths(ex), (ibThick ? nozzle : spacingOf(sw, h)) / ibd, ang), 'internal_bridge', ibw, Number(ocf.internal_bridge_flow ?? 1) || 1,
              { fil: solidFil, ...(ibFan >= 0 ? { fanSet: ibFan } : { fanMin: bridgeFan }) });
          }
        };
        if (rg.bridge.length) extBridge(rg.bridge);
        if (rg.ibridge?.length) intBridge(rg.ibridge, false);
        for (const b2 of rg.bridge2 ?? []) { if (b2.internal) intBridge(b2.paths, true); else extBridge(b2.paths); }
        if (rg.solid.length) solidFill(rg.solid, ostr(o, i, 'internal_solid_infill_pattern'), i === 0 ? w0 : sw, {}, efcDensity);
        if (rg.vshell.length) solidFill(rg.vshell, ostr(o, i, 'internal_solid_infill_pattern'), sw, { speed: floatOrPercent(ocfg(o, i).vertical_shell_speed, onum(o, i, 'internal_solid_infill_speed')) || undefined });
        if (rg.floating.length) solidFill(rg.floating, ostr(o, i, 'internal_solid_infill_pattern'), sw, { speed: onum(o, i, 'bridge_speed') || undefined });
        if (rg.subTop.length) surface(rg.subTop, ostr(o, i, 'sub_top_surface_pattern'), sw, 'internal_solid_infill');
        // sparse infill
        const dens = vase ? 0 : onum(o, i, 'sparse_infill_density') / 100;
        const pat = ostr(o, i, 'sparse_infill_pattern') as SparsePattern;
        // anchors hug the inner wall; where Motionex moves walls it trims infill near them, so anchors would only be cut up
        const motionHere = motionAt(zTop);
        const anchorLen = motionHere ? 0 : floatOrPercent(ocfg(o, i).sparse_infill_anchor, spw), anchorMax = motionHere ? 0 : floatOrPercent(ocfg(o, i).sparse_infill_anchor_max, spw);
        // sparse rotation template (replaces the infill direction), separated infills, symmetric infill Y axis
        const sparseTpl = templateAngle(String(ocf.sparse_infill_rotate_template ?? ''), li);
        const separated = ocf.separated_infills === true;
        const adaptiveMode = ostr(o, i, 'adaptive_infill_mode') || 'disabled';
        const smooth = onum(o, i, 'sparse_infill_smooth_factor') / 100;
        /** Distance from the object's surface, by adaptive density mode: in the layer (normal Z), or across one axis, plus Z. */
        const deepFrom = (mode: string) => (dd: number): Paths => {
          const inner = layerInner[i][o];
          const axis = mode === 'normal_x' ? 'y' : mode === 'normal_y' ? 'x' : 'xy';
          let acc = directionalShrink(inner, dd, axis);
          if (mode === 'normal_z' || !acc.length) return acc;
          const m = Math.ceil(dd / Math.max(h, 1e-3)), stride = Math.max(1, Math.ceil(m / 6));
          for (let j = i - m; j <= i + m && acc.length; j += stride) {
            const jj = Math.min(Math.max(j, i - m), i + m);
            if (jj < objStart || jj >= N || !layerInner[jj][o].length) return [];
            acc = intersection(acc, layerInner[jj][o]);
          }
          return acc;
        };
        const sparseLines = (reg: Paths, p: SparsePattern, d: number, angle: number) => {
          const a = (sparseTpl ?? angle) + modelRot;
          const L = sparseTpl !== null ? 0 : i; // a template sets the angle of every layer: no alternation
          const sp = spw / Math.min(1, d);
          let lines: Polyline2[];
          if (p === 'gyroid' && adaptiveMode !== 'disabled') {
            const core = (ocf.adaptive_infill_interior_density === undefined ? 5 : onum(o, i, 'adaptive_infill_interior_density')) / 100;
            const shells = adaptiveShells(reg, deepFrom(adaptiveMode), adaptiveMode, ostr(o, i, 'adaptive_infill_gradient') || 'linear', d, core, spw);
            lines = adaptiveGyroid(shells, spw, zTop, ocf.gyroid_optimized === true ? gyroidZFactor(d, spw, h) : 1);
          } else {
            const mirror = ocf.symmetric_infill_y_axis === true && SYMMETRIC_PATTERNS.has(p);
            const c = separated || mirror ? objCentre(o) : null;
            lines = inFrame(reg, c ? c[0] : 0, c && separated ? c[1] : 0, mirror, (r) => {
              if (EXTRA_SPARSE.has(p)) return extraSparseFill(r, p, sp, i, zTop, a, ocf, sparseTpl !== null);
              if (p === 'gyroid' && ocf.gyroid_optimized === true) return gyroidFill(r, sp, zTop, gyroidZFactor(d, spw, h));
              const out = sparseFill(r, p, spw, d, L, zTop, a);
              if (p === '3dhoneycomb' && ocf.infill_complete_top === true && i > objStart) pushAll(out, honeycombTops(r, sp, zTop, zs[i - 1], a));
              return out;
            });
          }
          if (ANCHORED_PATTERNS.has(p) && (anchorLen > 0 || anchorMax > 0)) lines = anchorInfill(lines, reg, spw, anchorLen, anchorMax);
          return smooth > 0 ? smoothCorners(lines, smooth) : lines;
        };
        if (rg.lines?.length) {
          const reg = clipTo(rg.sparse, spw);
          const clipped = reg.length ? clipLines(rg.lines.map((l) => { const p = []; for (let k = 0; k < l.pts.length; k += 2) p.push({ X: Math.round(l.pts[k] * SCALE), Y: Math.round(l.pts[k + 1] * SCALE) }); return p; }), reg) : [];
          add(clipped.map((p) => ({ pts: pathToPoly(p), closed: false })), 'sparse_infill', spw, 1, { fil: sparseFil });
        } else if (rg.sparse.length && dens > 0) {
          const reg = clipTo(rg.sparse, spw);
          if (reg.length) add(sparseLines(reg, pat, dens, onum(o, i, 'infill_direction')), 'sparse_infill', spw, 1, { fil: sparseFil });
        }
        if (rg.combined && dens > 0) {
          const reg = clipTo(rg.combined.paths, spw);
          if (reg.length) add(sparseLines(reg, pat, dens, onum(o, i, 'infill_direction')), 'sparse_infill', spw, 1, { fil: sparseFil, height: rg.combined.height });
        }
        for (const m of rg.sparseMods) {
          const reg = clipTo(m.paths, spw);
          if (reg.length) add(sparseLines(reg, m.pattern, m.density, m.angle ?? onum(o, i, 'infill_direction')), 'sparse_infill', spw, 1, { fil: sparseFil, speed: m.speed });
        }
        if (rg.top.length) surface(rg.top, ostr(o, i, 'top_surface_pattern'), twid, 'top_surface', onum(o, i, 'top_surface_density') / 100 || 1, {}, topDirs);
        const ironing = ostr(o, i, 'ironing_type');
        const ironRegion = ironing === 'solid' ? union([...rg.top, ...rg.solid, ...rg.subTop]) : rg.top;
        if (ironRegion.length && (ironing === 'top' || ironing === 'solid' || (ironing === 'topmost' && i === objLast[o]))) {
          // filament ironing overrides (-1 = the process value)
          const ifl = filaments[Math.max(0, fil)]?.settings;
          const ifo = (k: string, d: number) => { const v = ifl?.[`filament_${k}`] ?? cfg[`filament_${k}`]; return v !== undefined && v !== '' && Number(v) >= 0 ? Number(v) : d; };
          const reg = intersection(offset(ironRegion, -twid / 2 - ifo('ironing_inset', onum(o, i, 'ironing_inset')) + onum(o, i, 'ironing_expansion')), fInner);
          const sp = Math.max(0.01, ifo('ironing_spacing', onum(o, i, 'ironing_spacing')));
          const ip = ostr(o, i, 'ironing_pattern');
          // ironing angle: the ironing direction (or the fixed top layer direction) plus the offset, or the offset alone when fixed
          const ironA = (ocf.ironing_angle_fixed === true ? 0 : topDir >= 0 ? topDir : onum(o, i, 'ironing_direction')) + onum(o, i, 'ironing_angle') + modelRot;
          const lines = ip === 'concentric' ? concentricFill(reg, sp, sp / 2) : ip === 'archimedeanchords' ? archimedeanFill(reg, sp) : linesFill(reg, sp, ironA);
          const ifs = Number(ifl?.ironing_fan_speed ?? cfg.ironing_fan_speed ?? -1);
          const ispd = ifo('ironing_speed', -1);
          for (const p of lines) fills.push({ ...p, feature: 'ironing', width: sp, flow: (ifo('ironing_flow', onum(o, i, 'ironing_flow')) / 100) * (h / sp), fil: solidFil, ...(ifs >= 0 ? { fanSet: ifs } : {}), ...(ispd > 0 ? { speedSet: ispd } : {}) });
        }
        // assign fills to islands by first point
        const filIslands = jobs.filter((j) => j.isl.fil === fil);
        for (const it of fills) {
          let owner = filIslands[0];
          if (filIslands.length > 1) owner = filIslands.find((j) => (j.inside ??= insideTester(exToPaths(j.isl.ex)))(it.pts[0], it.pts[1])) ?? filIslands[0];
          if (owner) owner.fills.push(it);
        }
      }
    }
    curObj = -1;

    // --- filament change (with flush into infill / support / objects)
    let deferred: PathItem[] = []; // printed right after the next change, counted as flush
    let deferredJobs: { o: number; job: IslandJob }[] = [];
    let flushSupportDone = false;
    const changeTo = (next: number) => {
      if (next === curTool) return;
      // the first filament: loaded by the start G-code (the makers' own start G-code loads the initial filament itself)
      if (curTool === -1 && (!hasAms || vendorTpl || ((usedFils.size <= 1 || toolChanger) && next === 0))) {
        ops.push({ k: 'tool', tool: next }); curTool = next; toolSet = filaments[next]?.settings ?? {}; loadRetraction();
        const sg = String(toolSet.filament_start_gcode ?? '');
        if (sg) ops.push({ k: 'raw', text: expandMacro(sg, cfg, { filament_extruder_id: next }) });
        return;
      }
      const fl = filaments[next];
      const prev = curTool < 0 ? 0 : curTool;
      // a tool changer picks up a head that is already loaded: only the ooze of the parked head is primed
      let flushVol = toolChanger ? num('tool_prime_volume') : flushOf(prev, next);
      let plan: TransitionPlan | undefined;
      for (const x of transitionPlugins) plan = x.transition!({ layer: i, from: prev, to: next, flushVolume: flushVol }) ?? plan;
      if (plan?.flushVolume !== undefined) flushVol = toolChanger ? Math.min(flushVol, plan.flushVolume) : plan.flushVolume;
      // material printed right after the change absorbs part of the flush
      let absorbed = 0;
      for (const it of deferred) absorbed += volumeOf(it);
      for (const d of deferredJobs) {
        const wl = d.job.isl.walls;
        for (const it of [...wl.loops.flat(), ...wl.thin, ...wl.gaps]) absorbed += volumeOf({ ...it, flow: 1 });
        for (const it of d.job.fills) absorbed += volumeOf(it);
      }
      const supportNow = support && curTool >= 0 && !flushSupportDone && bool('flush_into_support') && supportFil < 0 && ifaceFil < 0 && (support.base[i].length || support.iface[i].length);
      if (supportNow) absorbed += supportVolume();
      if (absorbed > 0 && curTool >= 0) flushVol = Math.max(0, flushVol - absorbed);
      if (plan) ops.push({ k: 'raw', text: `${TRANSITION_MARKER} ${prev}->${next} mode=${plan.skipTower ? 'none' : plan.flushVolume !== undefined ? 'reduced' : 'full'} shift=${(plan.shiftMm ?? 0).toFixed(3)}${plan.regionId ? ` region=${plan.regionId}` : ''}` });
      if (plan?.label && !hasAms) ops.push({ k: 'raw', text: `M117 Load ${plan.label.replace(/[;\n]/g, ' ')}` });
      // no chute: the tower band printed right after the change takes the flush, the change G-code purges nothing
      const flushLen = towerFlush && towerActive ? 0 : (flushVol || 0) / (Math.PI * (fl.diameter / 2) ** 2);
      // the tower takes the old filament first: the MMU unload (ramming, cooling tube, parking) or a tool changer's ramming
      let ramDepth = 0, unloaded = false;
      const towerSeq = towerActive && curTool >= 0 && !plan?.skipTower && !priming;
      if (towerSeq && tune.wallFilament >= 0 && curTool === tune.wallFilament) towerOutline();
      if (towerSeq && hasAms && !toolChanger && towerFlush && bool('enable_filament_ramming')) {
        const c = bandCtx(bandsDone, filaments[curTool]?.settings);
        const u = mmuUnload(c, c.xl + c.w, c.y0);
        if (u.ops.length) { runTowerOps(u.ops); ramDepth = u.depth; unloaded = true; retracted = true; pendingDeretract = 0; }
      } else if (towerSeq && toolChanger) {
        const r = multitoolRamming(filaments[curTool]?.settings, cfg);
        if (r) { const c = bandCtx(bandsDone, filaments[curTool]?.settings); const m = multitoolRam(c, r, c.xl, c.y0); runTowerOps(m.ops); ramDepth = m.depth; }
      }
      // a head is parked retracted by its normal length, which comes back when it is next picked up
      if (toolChanger && curTool >= 0) {
        const want = num('retract_length_toolchange') || retractLen;
        const have = retracted ? (pendingDeretract ?? retractLen) : 0;
        if (want > have) ops.push({ k: 'retract', len: want - have, speed: retractSpeed });
        parkedRetract.set(curTool, Math.max(want, have));
      } else if (!retracted && curTool >= 0) ops.push({ k: 'retract', len: num('retract_length_toolchange') || retractLen, speed: retractSpeed });
      if (curTool >= 0) { const eg = String(filaments[curTool]?.settings?.filament_end_gcode ?? ''); if (eg) ops.push({ k: 'raw', text: expandMacro(eg, cfg, { filament_extruder_id: curTool }) }); }
      // tool change on wipe tower: the head is swapped over the tower, not over the part
      if (toolChanger && curTool >= 0 && useTower && bool('tool_change_on_wipe_tower')) travel(towerCx, towerCy, 'travel', curZ);
      ops.push({
        k: 'raw', resetPos: true, time: num('filament_change_time'),
        text: vendorTpl
          // the maker's own change G-code, with the variables Bambu Studio / Orca give it (GCode.cpp set_extruder)
          ? renderVendor(str('change_filament_gcode'), cfg, filaments, {
            previous_extruder: prev, next_extruder: next, layer_num: i, layer_z: zTop, max_layer_z: Math.max(maxPrinted, zTop - h),
            toolchange_count: ++toolchangeCount, current_extruder: prev,
            new_filament_temp: Math.round(i === 0 ? fl.nozzleTempInitial : fl.nozzleTemp), old_filament_temp: curTool >= 0 ? Math.round(filaments[prev].nozzleTemp) : 0,
            ...flushSplit(towerFlush && towerActive ? 0 : flushVol || 0, Math.PI * (fl.diameter / 2) ** 2),
            old_retract_length_toolchange: num('retract_length_toolchange'), new_retract_length_toolchange: num('retract_length_toolchange'),
            x_after_toolchange: isNaN(px) ? 0 : px, y_after_toolchange: isNaN(py) ? 0 : py, z_after_toolchange: zTop,
            travel_point_1_x: isNaN(px) ? 0 : px, travel_point_1_y: isNaN(py) ? 0 : py, travel_point_2_x: isNaN(px) ? 0 : px, travel_point_2_y: isNaN(py) ? 0 : py,
            travel_point_3_x: isNaN(px) ? 0 : px, travel_point_3_y: isNaN(py) ? 0 : py,
            position: [isNaN(px) ? 0 : px, isNaN(py) ? 0 : py, zTop],
            outer_wall_volumetric_speed: Math.min(num('outer_wall_speed') * (num('outer_wall_line_width') || nozzle) * h, fl.maxVolumetricSpeed || 1e9),
            wipe_tower_x: tx + tw / 2, wipe_tower_y: ty + td / 2, toolchange_z: zTop + 3,
          }, 'Filament change G-code')
          : expandMacro(str('change_filament_gcode'), cfg, {
            previous_extruder: prev, next_extruder: next, toolchange_z: (zTop + 3).toFixed(2), layer_z: zTop.toFixed(2), layer_num: i,
            new_filament_temp: i === 0 ? fl.nozzleTempInitial : fl.nozzleTemp, old_filament_temp: filaments[prev].nozzleTemp,
            flush_length: flushLen.toFixed(2), wipe_tower_x: (tx + tw / 2).toFixed(2), wipe_tower_y: (ty + td / 2).toFixed(2),
          }),
      });
      // the parked head waits below its print temperature (it is heated again before its next pick-up)
      if (toolChanger && curTool >= 0 && cfg.ooze_prevention !== false && num('standby_temperature_delta') < 0)
        ops.push({ k: 'raw', text: `M104 T${prev} S${Math.max(0, Math.round(filaments[prev].nozzleTemp + num('standby_temperature_delta')))} ; park T${prev} at standby` });
      if (fl.pressureAdvance !== undefined) ops.push({ k: 'raw', text: paLine(flavor, fl.pressureAdvance) });
      ops.push({ k: 'tool', tool: next });
      toolSet = fl.settings ?? {};
      loadRetraction();
      const sg = String(toolSet.filament_start_gcode ?? '');
      if (sg) ops.push({ k: 'raw', text: expandMacro(sg, cfg, { filament_extruder_id: next }) });
      changeDeretract = num('deretract_speed_extruder_change') > 0 ? num('deretract_speed_extruder_change') : null;
      if (num('retract_restart_extra_toolchange')) ops.push({ k: 'raw', text: `G1 E${num('retract_restart_extra_toolchange').toFixed(3)} F${Math.round((changeDeretract ?? deretractSpeed) * 60)}` });
      retracted = hasAms; // the AMS sequence ends with a retraction, a parked head was retracted; M600 leaves the nozzle primed
      // a head picked up for the first time was never retracted (the start G-code primed it)
      pendingDeretract = toolChanger ? (parkedRetract.get(next) ?? 0) : null;
      px = NaN; py = NaN;
      wipeTrail = [];
      const wasFirst = curTool === -1;
      curTool = next;
      // MMU: load the new filament back to the nozzle over the band
      if (unloaded) {
        const c = bandCtx(bandsDone, fl.settings);
        const ld = mmuLoad(c, c.xl + c.w, c.y0 + ramDepth + c.w);
        if (ld.length) { retracted = false; pendingDeretract = null; runTowerOps(ld); }
      }
      // wait for temperature on wipe tower: a filament with another temperature heats up over the tower
      const newT = Math.round(i === 0 ? fl.nozzleTempInitial : fl.nozzleTemp);
      if (bool('wait_for_temp_on_wipe_tower') && towerActive && !wasFirst && !priming && newT > 0 && newT !== Math.round(i === 0 ? filaments[prev].nozzleTempInitial : filaments[prev].nozzleTemp)) {
        travel(towerCx, towerCy, 'travel', curZ);
        ops.push({ k: 'raw', text: `M109 ${toolChanger ? `T${next} ` : ''}S${newT} ; wait for the temperature over the prime tower` });
      }
      if (towerActive && (!wasFirst || towerFlush) && !plan?.skipTower && !priming) { towerOutline(); towerBand(bandsDone++, true, ramDepth); }
      // flush targets, printed with the new filament
      if (deferred.length) { for (const it of orderPaths(deferred, isNaN(px) ? 0 : px, isNaN(py) ? 0 : py).paths) extrudePath(it); deferred = []; }
      if (deferredJobs.length) { const dj = deferredJobs; deferredJobs = []; for (const d of dj) emitJob(d.o, d.job, () => true); }
      if (supportNow) { flushSupportDone = true; emitSupport(); }
    };

    // --- layer actions (pause / custom G-code / setting change)
    for (const a of actionsByLayer.get(i) ?? []) {
      if (a.type === 'config' && a.key) {
        live[a.key] = Number(a.value);
        loadRetraction();
        if (a.gcode) ops.push({ k: 'raw', text: a.gcode });
        continue;
      }
      if (a.type === 'pause') ops.push({ k: 'raw', text: `; PAUSE at layer ${i + 1}\n${str('machine_pause_gcode') || 'M601'}`, resetPos: true });
      else if (a.type === 'custom' && a.gcode) ops.push({ k: 'raw', text: `; custom G-code at layer ${i + 1}\n${a.gcode}` });
    }
    // timelapse snapshot at the start of the layer (smooth: park over the prime tower first)
    if (timelapse && i > 0) {
      // farthest point timelapse (traditional): the snapshot at the point of the last layer farthest from the bed origin
      const far = !smoothLapse && bool('farthest_point_timelapse') ? farthestPoint(layerOps[layerOps.length - 1]?.ops ?? []) : null;
      if (smoothLapse && useTower) {
        retract();
        travel(tx + tw / 2, ty + td / 2, 'travel', curZ);
      } else if (far) {
        retract();
        travel(far[0], far[1], 'travel', curZ);
      }
      ops.push({ k: 'raw', text: vendorTpl ? renderVendor(timelapse, cfg, filaments, {
        ...(far ? { timelapse_pos_x: Math.round(far[0]), timelapse_pos_y: Math.round(far[1]), has_timelapse_safe_pos: true } : {}), farthest_point_timelapse_enabled: !!far,
        layer_num: i, layer_z: zTop, max_layer_z: Math.max(maxPrinted, zTop - h), timelapse_type: smoothLapse ? 1 : 0, spiral_mode: vase,
        in_head_wrap_detect_zone: inHeadWrapZone(), total_layer_count: N, ...firstLayerVars(),
      }, 'Time lapse G-code') : timelapse });
    }

    // order filaments: current first
    const fils = only === null ? layerFils[i] : [...new Set(jobsByObj.get(only)?.flatMap((j) => [j.wallFil, ...j.fills.map((f) => f.fil ?? j.isl.fil)]) ?? [])];
    const order = orderLayerTools(fils, curTool, i, opts.filamentSequence);
    layerOrder = order;
    if (!order.length && curTool === -1) changeTo(supportFil >= 0 ? supportFil : 0);

    // --- first-layer adhesion (printed with the first filament of the layer)
    // prime all printing extruders: a line of each filament along the front edge before the first layer
    if (i === 0 && useTower && bool('single_extruder_multi_material_priming') && order.length && usedFils.size > 1) {
      priming = true;
      const seq = [...[...usedFils].sort((a, b) => a - b).filter((f) => f !== order[0]), order[0]];
      const w = towerW();
      seq.forEach((f, k) => {
        changeTo(f);
        const len = Math.max(5, Math.min(num('bed_x') - 20, primeVolOf(f) / (w * h)));
        extrudePath({ pts: [10, 3 + k * 2 * w, 10 + len, 3 + k * 2 * w], closed: false, feature: 'prime_tower', width: w, flow: 1 });
      });
      priming = false;
    }
    if (order.length) changeTo(order[0]);
    // draft shield: the skirt rises with the tallest object; single loop: only the innermost loop above the first layer
    const skirtLayers = str('draft_shield') === 'enabled' ? N : Math.round(num('skirt_height'));
    const skirtNow = (it: PathItem) => (i === 0 || !bool('single_loop_draft_shield') || it.wallDepth === 0) && (it.owner === undefined || only === null || it.owner === only);
    if (i === 0) {
      for (const it of skirtLoops.filter((it) => skirtNow(it) && (only === null || it.owner !== undefined || only === byObjOrder[0]))) extrudePath({ ...it });
      for (const it of orderPaths(only === null ? brimLoops : brimByObj.get(only) ?? [], px, py).paths) extrudePath(it);
    } else if (i < skirtLayers && (only === null || skirtLoops.some((it) => it.owner === only))) {
      for (const it of skirtLoops.filter(skirtNow)) if (zs[i] <= (it.owner === undefined ? maxZ + shift : (objLast[it.owner] >= 0 ? zs[objLast[it.owner]] : 0)) + 1e-6 || str('draft_shield') !== 'enabled') extrudePath({ ...it });
    }

    // flush into infill: sparse infill of a filament that is followed by another one is printed after the change
    if (bool('flush_into_infill') && order.length > 1 && i > 0) {
      for (const f of order.slice(0, -1)) for (const jobs of jobsByObj.values()) for (const j of jobs) {
        const keep: PathItem[] = [];
        for (const it of j.fills) {
          if (it.feature === 'sparse_infill' && (it.fil ?? j.isl.fil) === f) deferred.push({ ...it, fil: -1 }); else keep.push(it);
        }
        j.fills = keep;
      }
    }
    // flush into objects: whole objects marked for it wait for the next change
    if (order.length > 1) for (const [o, jobs] of jobsByObj) if (flushObj[o]) { for (const job of jobs) deferredJobs.push({ o, job }); jobsByObj.set(o, []); }

    /** Emit the parts of one island printed with the current filament. */
    function emitJob(o: number, job: IslandJob, mine: (fil: number) => boolean) {
      const isl = job.isl;
      objFlow = (onum(o, i, 'flow_ratio_scale') || 1) * (onum(o, i, 'print_flow_ratio') || 1);
      curObj = o;
      const hints: SeamHints | undefined = seamTris[o].length
        ? { enforce: pointsAtZ(meshes[o] as IndexedMesh, seamTris[o], 1, planes[i]), block: pointsAtZ(meshes[o] as IndexedMesh, seamTris[o], 2, planes[i]) }
        : undefined;
      const seamMode = ostr(o, i, 'seam_position') as SeamMode;
      const fuzzy = ostr(o, i, 'fuzzy_skin');
      const fuzzyOn = fuzzy !== 'none' && fuzzy !== 'disabled_fuzzy' && (i > objStart || obool(o, i, 'fuzzy_skin_first_layer'));
      const wallItems: PathItem[] = [];
      if (mine(job.wallFil)) {
        const depthOrder = isl.walls.loops.map((_, k) => k);
        let seq: number[];
        if (wallSeq === 'outer_inner') seq = depthOrder;
        else if (wallSeq === 'inner_outer_inner' && depthOrder.length >= 3) seq = [...depthOrder.slice(2).reverse(), 0, 1];
        else seq = depthOrder.slice().reverse();
        const scarfType = scarfFromProcess ? ostr(o, i, 'seam_slope_type') : tstr('filament_scarf_seam_type');
        const scarfLen = scarfFromProcess ? onum(o, i, 'seam_slope_min_length') : tnum('filament_scarf_length');
        const scarfStart = scarfFromProcess ? ocfg(o, i).seam_slope_start_height : toolSet.filament_scarf_height ?? '10%';
        const scarfGap = scarfFromProcess ? ocfg(o, i).seam_slope_gap : toolSet.filament_scarf_gap ?? 0;
        const smallT = onum(o, i, 'small_perimeter_threshold');
        const wallCw = ostr(o, i, 'wall_direction') === 'cw', staggerSeams = obool(o, i, 'staggered_inner_seams');
        const wipeLoops = obool(o, i, 'wipe_on_loops');
        const wipeBeforeOuter = obool(o, i, 'wipe_before_external_loop') && (wallSeq === 'outer_inner' || wallSeq === 'inner_outer_inner');
        const lower = lowerSupport ? lowerSupport[o] : null;
        // reverse on even layers: loops hanging over the layer below by more than the threshold run the other way
        const revOn = obool(o, i, 'overhang_reverse') && !!lower && (i - objStart) % 2 === 1, revInternal = obool(o, i, 'overhang_reverse_internal_only');
        const revTesters = new Map<number, (x: number, y: number) => boolean>();
        const revTester = (w: number) => { const d = floatOrPercent(ocfg(o, i).overhang_reverse_threshold ?? '50%', w); let t = revTesters.get(d); if (!t) revTesters.set(d, (t = insideTester(offset(lower!, d)))); return t; };
        // (decided per island from its outer loops, as OrcaSlicer does per region)
        const revIsland = revOn && (isl.walls.loops[0] ?? []).some((l) => l.closed && overhangsBy(l.pts, revTester(l.width)));
        let lowerIn: ((x: number, y: number) => boolean) | null = null;
        const supported = () => (lowerIn ??= insideTester(lower!));
        const scarfFlowRatio = ocfg(o, i).scarf_joint_flow_ratio !== undefined ? onum(o, i, 'scarf_joint_flow_ratio') : 1;
        const wipeInward = obool(o, i, 'wipe_inward') && isl.walls.loops.length > 1;
        for (const k of seq) {
          const ordered = orderPaths(isl.walls.loops[k].map((l) => ({ ...l })), isNaN(px) ? 0 : px, isNaN(py) ? 0 : py).paths;
          for (const loop of ordered) {
            const feature = loop.feature;
            if (!loop.closed) { wallItems.push(classifyOverhang({ pts: simplify(loop.pts, resolution, false), closed: false, feature, width: loop.width, flow: 1, wallDepth: k }, lower, o)); continue; }
            let pts = simplify(loop.pts, resolution, true);
            // wall loop direction: contours run the chosen way seen from above, holes the other way
            if (pts.length >= 6 && (signedArea2(pts) > 0) !== ((wallCw ? !!loop.hole : !loop.hole))) pts = reverseLoop(pts);
            const prev = (seamMode === 'aligned' || seamMode === 'aligned_back') && prevSeams.length
              ? prevSeams.reduce((b, s) => ((s[0] - pts[0]) ** 2 + (s[1] - pts[1]) ** 2 < (b[0] - pts[0]) ** 2 + (b[1] - pts[1]) ** 2 ? s : b))
              : null;
            const avoid = obool(o, i, 'seam_placement_away_from_overhangs') && lower ? overhangPoints(pts, lower, loop.width) : null;
            const si = pickSeam(pts, seamMode, isNaN(px) ? 0 : px, isNaN(py) ? 0 : py, prev, rnd, avoid ? { enforce: hints?.enforce ?? [], block: [...(hints?.block ?? []), ...avoid] } : hints);
            pts = rotateLoop(pts, si);
            if (k > 0 && staggerSeams) pts = shiftLoopStart(pts, k * loop.width);
            if (k === 0) seams.push([pts[0], pts[1]]);
            const reversed = revIsland && (!revInternal || k > 0) && pts.length >= 6;
            if (reversed) pts = reverseKeepStart(pts);
            let flows: number[] | undefined;
            const fuzzThis = fuzzyOn && (fuzzy === 'allwalls' || (k === 0 && (fuzzy === 'all' || (fuzzy === 'external' && !loop.hole) || (fuzzy === 'hole' && !!loop.hole))));
            if (fuzzThis) {
              const fz = fuzzLoop(pts, {
                thickness: onum(o, i, 'fuzzy_skin_thickness'), pointDistance: onum(o, i, 'fuzzy_skin_point_distance'),
                mode: ostr(o, i, 'fuzzy_skin_mode') as FuzzyMode, noise: ostr(o, i, 'fuzzy_skin_noise_type') as NoiseType,
                scale: onum(o, i, 'fuzzy_skin_scale'), octaves: onum(o, i, 'fuzzy_skin_octaves'), persistence: onum(o, i, 'fuzzy_skin_persistence'),
                z: zTop, rnd, width: loop.width,
                ripples: onum(o, i, 'fuzzy_skin_ripples_per_layer') || 15,
                ripplePhase: ripplePhase(i - objStart, onum(o, i, 'fuzzy_skin_ripple_offset'), onum(o, i, 'fuzzy_skin_layers_between_ripple_offset') || 1),
              });
              pts = fz.pts; flows = fz.flows;
            }
            const len = loopLength(pts);
            const small = smallT > 0 && len <= smallT ? floatOrPercent(ocfg(o, i).small_perimeter_speed, speedFor(feature, i)) : undefined;
            const noSlow = k === 0 && tbool('no_slow_down_for_cooling_on_outwalls');
            let item: PathItem;
            let scarfMask: boolean[] | null = null;
            if (vase && i >= objStart + Math.round(onum(o, i, 'bottom_shell_layers'))) {
              item = { pts: smoothSpiral(pts, o, i, loop.width), closed: true, feature, width: loop.width, flow: 1, spiral: true, hole: loop.hole };
              // spiral transition: the first spiral loop ramps its flow up from the starting ratio
              const startRatio = ocfg(o, i).spiral_starting_flow_ratio !== undefined ? onum(o, i, 'spiral_starting_flow_ratio') : 1;
              if (k === 0 && i === objStart + Math.round(onum(o, i, 'bottom_shell_layers')) && startRatio < 1) item.flows = spiralRamp(item.pts, (f) => startRatio + f * (1 - startRatio));
              // spiral finish: one more loop at the top height, its flow falling to the finishing ratio
              const finRatio = ocfg(o, i).spiral_finishing_flow_ratio !== undefined ? onum(o, i, 'spiral_finishing_flow_ratio') : 1;
              if (k === 0 && i === objLast[o] && finRatio < 1) {
                wallItems.push(item);
                item = { pts: [...item.pts, item.pts[0], item.pts[1]], closed: false, feature, width: loop.width, flow: 1, hole: loop.hole, flows: spiralRamp(item.pts, (f) => finRatio + (1 - f) * (1 - finRatio)) };
              }
            } else {
              const scarfOn = !fuzzThis && scarfType !== 'none' && scarfLen > 0 && i > objStart
                && (k === 0 ? (scarfType === 'all' || !loop.hole) : (scarfFromProcess ? obool(o, i, 'seam_slope_inner_walls') : true) && (scarfType === 'all' || !loop.hole))
                && (!(scarfFromProcess ? obool(o, i, 'seam_slope_conditional') : true) || isSmoothLoop(pts, onum(o, i, 'scarf_angle_threshold') || 155))
                // scarf overhang threshold: no scarf on a loop that hangs over the layer below too much
                && !(lower && (() => { const u = unsupportedFraction(pts, supported()); return u > 0 && u * 100 >= onum(o, i, 'scarf_overhang_threshold'); })());
              if (scarfOn) {
                const sc = scarfLoop(pts, {
                  length: scarfFromProcess && obool(o, i, 'seam_slope_entire_loop') ? len : scarfLen,
                  startFrac: Math.min(1, floatOrPercent(scarfStart, h) / h), steps: onum(o, i, 'seam_slope_steps') || 10,
                  gap: floatOrPercent(scarfGap, nozzle),
                });
                // scarf joint flow ratio: on the ramp and its overlap (the segments with partial flow)
                const scarfFlows = scarfFlowRatio !== 1 ? sc.flows.map((f) => (f < 1 - 1e-9 ? f * scarfFlowRatio : f)) : sc.flows;
                item = { pts: sc.pts, closed: false, feature, width: loop.width, flow: 1, depth: sc.depth, flows: scarfFlows, hole: loop.hole };
                scarfMask = sc.flows.map((f) => f < 1 - 1e-9);
              } else {
                const gap = (onum(o, i, 'seam_gap') / 100) * nozzle;
                const open = flows ? [...pts, pts[0], pts[1]] : seamGapLoop(pts, gap);
                item = { pts: open, closed: false, feature, width: loop.width, flow: 1, hole: loop.hole, ...(flows ? { flows: [1, ...flows.slice(1), flows[0]] } : {}) };
              }
              item = classifyOverhang(item, lower, o);
              // scarf joint speed (mm/s or % of the wall speed) on the ramp and its overlap
              if (scarfMask) {
                const wallV = speedFor(feature, i), sv = floatOrPercent(ocfg(o, i).scarf_joint_speed ?? '100%', wallV);
                if (sv > 0 && sv < wallV) item.speeds = scarfMask.map((m, j) => (m ? Math.min(item.speeds?.[j] || Infinity, sv) : item.speeds?.[j] ?? 0));
              }
            }
            item.wallDepth = k;
            if (small !== undefined) item.speed = small;
            if (noSlow) item.noSlow = true;
            if (!item.spiral && item.pts.length >= 4) {
              // inward direction at the seam: left of the travel direction for a counter clockwise contour
              const sx = pts[0], sy = pts[1], tx = pts[2] - sx, ty = pts[3] - sy, tl = Math.hypot(tx, ty) || 1;
              const side = (wallCw ? -1 : 1) * (reversed ? -1 : 1), nx = (-ty / tl) * side, ny = (tx / tl) * side, w = loop.width;
              // wipe inward: the wipe after the outer wall runs shifted toward the inner walls
              if (k === 0 && wipeInward) item.wipeShift = side * Math.min(floatOrPercent(ocfg(o, i).wipe_inward_distance ?? '50%', w), w * (wallSeq === 'inner_outer' ? 1 : 0.5));
              if (k === 0 && wipeBeforeOuter) item.primeAt = [sx + nx * w, sy + ny * w];
              if (k === 0 && wipeLoops) item.wipeIn = [sx + (tx / tl + nx) * w * 0.7, sy + (ty / tl + ny) * w * 0.7];
            }
            wallItems.push(item);
          }
        }
        // print unsupported walls last: loops entirely in mid air go after the other walls, innermost first
        if (lower && obool(o, i, 'unsupported_wall_last')) {
          const air = (it: PathItem) => { for (let q = 0; q < it.pts.length; q += 2) if (supported()(it.pts[q], it.pts[q + 1])) return false; return true; };
          const flying = wallItems.filter(air);
          if (flying.length) {
            const rest = wallItems.filter((it) => !flying.includes(it));
            wallItems.splice(0, wallItems.length, ...rest, ...flying.sort((a, b) => (b.wallDepth ?? 0) - (a.wallDepth ?? 0)));
          }
        }
        if (isl.walls.thin.length) pushAll(wallItems, orderPaths(isl.walls.thin.map((t) => ({ ...t, pts: t.pts.slice(), widths: t.widths!.slice(), flow: 1 } as PathItem)), isNaN(px) ? 0 : px, isNaN(py) ? 0 : py).paths);
      }
      const gapItems: PathItem[] = [];
      if (mine(job.gapFil)) {
        const minLen = Math.max(onum(o, i, 'filter_out_gap_fill'), 0);
        // Apply gap fill: everywhere, only on layers of this object with a top / bottom surface, or nowhere
        const gapTarget = ostr(o, i, 'gap_fill_target') || 'everywhere';
        const gapHere = gapTarget === 'everywhere' || (gapTarget === 'topbottom' && (regions[i][o].top.length > 0 || regions[i][o].bottom.length > 0 || i === objStart));
        if (gapHere) for (const g of isl.walls.gaps) if (polyLen(g.pts) >= minLen) gapItems.push({ ...g, pts: g.pts.slice(), widths: g.widths!.slice(), flow: 1 } as PathItem);
      }
      const isFill = job.fills.filter((f) => mine(f.fil ?? isl.fil));
      // subdivided mix: what is printed here is the top pass (the lower passes went first, see subPassPhase)
      if (isl.sub && job.wallFil === isl.fil) {
        const n = isl.sub.length;
        for (const it of wallItems) if (it.wallDepth === 0) toPass(it, n - 1, n);
        if (subInfill) for (const it of isFill) if (SUB_FILL.has(it.feature) && (it.fil ?? isl.fil) === isl.fil && (it.height === undefined || it.height < h)) toPass(it, n - 1, n);
      }
      const fillOrdered = () => {
        const groups: FeatureType[] = ['bottom_surface', 'bridge', 'internal_bridge', 'internal_solid_infill', 'sparse_infill', 'top_surface', 'ironing'];
        const outp: PathItem[] = [];
        // flow rate calibration: top surface Archimedean chords in their own order, the centre spiral inside-out and last
        const calibTop = obool(o, i, 'calib_flowrate_topinfill_special_order') && ostr(o, i, 'top_surface_pattern') === 'archimedeanchords';
        for (const g of groups) {
          const sorted = (q: PathItem[]) => orderPaths(q, isNaN(px) ? 0 : px, isNaN(py) ? 0 : py).paths;
          const part = isFill.filter((f) => f.feature === g && !f.keepOrder);
          pushAll(outp, calibTop && g === 'top_surface' ? calibTopOrder(part, sorted) : sorted(part));
          pushAll(outp, isFill.filter((f) => f.feature === g && f.keepOrder)); // surface fill order: as generated
        }
        return outp;
      };
      if (!wallItems.length && !isFill.length && !gapItems.length) return;
      if (labels) ops.push({ k: 'raw', text: flavor === 'klipper' ? `EXCLUDE_OBJECT_START NAME=${labelName(o)}` : `M486 S${o}` });
      if (bool('is_infill_first')) { for (const it of fillOrdered()) extrudePath(it); for (const it of wallItems) extrudePath(it); }
      else { for (const it of wallItems) extrudePath(it); }
      for (const it of orderPaths(gapItems, isNaN(px) ? 0 : px, isNaN(py) ? 0 : py).paths) extrudePath(it);
      if (!bool('is_infill_first')) for (const it of fillOrdered()) extrudePath(it);
      if (labels) ops.push({ k: 'raw', text: flavor === 'klipper' ? `EXCLUDE_OBJECT_END NAME=${labelName(o)}` : 'M486 S-1' });
      objFlow = 1;
      curObj = -1;
    }

    /** Overhang degree of each wall segment → line type, speed cap and fan boost. */
    function classifyOverhang(item: PathItem, lower: Paths | null, o: number): PathItem {
      if (!lower || i <= objStart || vase || !obool(o, i, 'detect_overhang_wall')) return item;
      const w = item.width;
      const levels = OVERHANG_LEVELS;
      // a segment overhangs by fraction f when its centre lies beyond the lower layer edge by (f - 0.5)·w
      const rkey = `${o}:${w.toFixed(3)}`;
      // rings are nested (each contains the previous), so they are made only when a point is found outside the smaller ones
      let rings = overhangRings.get(rkey);
      if (!rings) { rings = []; overhangRings.set(rkey, rings); }
      const ringAt = (b: number) => (rings![b] ??= insideTester(offset(lower, (levels[b] - 0.5) * w)));
      const pts = item.pts, n = pts.length / 2;
      const feats: FeatureType[] = new Array(n).fill(item.feature);
      const speeds: number[] = new Array(n).fill(0);
      const fans: number[] = new Array(n).fill(0);
      let any = false;
      const slow = obool(o, i, 'enable_overhang_speed');
      const qs = [0, onum(o, i, 'overhang_1_4_speed'), onum(o, i, 'overhang_2_4_speed'), onum(o, i, 'overhang_3_4_speed'), onum(o, i, 'overhang_4_4_speed'), onum(o, i, 'overhang_totally_speed')];
      const fanOn = tbool('enable_overhang_bridge_fan');
      const fanThr = parseFloat(tstr('overhang_fan_threshold') || '25') / 100;
      const fanSpeed = tnum('overhang_fan_speed');
      // slow down for curled perimeters: walls over the overhanging walls of the layer below (which curl up)
      const curl = slow && obool(o, i, 'slowdown_for_curled_perimeters') && isWall(item.feature) ? curledAt(o, i, w) : null;
      const curlV = onum(o, i, 'overhang_3_4_speed');
      for (let k = 1; k < n; k++) {
        const mx = (pts[k * 2 - 2] + pts[k * 2]) / 2, my = (pts[k * 2 - 1] + pts[k * 2 + 1]) / 2;
        if (curl && curlV > 0 && curl.below?.near(mx, my)) { speeds[k] = curlV; any = true; }
        let bucket = 0;
        while (bucket < levels.length && !ringAt(bucket)(mx, my)) bucket++;
        if (curl && bucket >= 3) curl.here.add(mx, my);
        if (!bucket) { if (fanOn && fanThr <= 0 && item.feature === 'outer_wall') fans[k] = fanSpeed; continue; }
        any = true;
        if (bucket >= 3) feats[k] = 'overhang_wall'; // centre of the line is unsupported
        if (slow && qs[bucket] > 0) speeds[k] = speeds[k] > 0 ? Math.min(speeds[k], qs[bucket]) : qs[bucket];
        const degree = bucket >= 5 ? 1 : levels[bucket - 1];
        if (fanOn && degree >= fanThr) fans[k] = fanSpeed;
      }
      if (!any && !fans.some((f) => f > 0)) return item;
      smoothOverhangRuns(pts, item.closed, feats, speeds, fans, Math.max(4, 8 * w));
      return { ...item, feats, speeds, fans };
    }
    /** Curled perimeter grids: overhang wall points of the layer below (read) and of this layer (written). */
    function curledAt(o: number, i2: number, w: number) {
      const key = (l: number) => o * 1_000_000 + l;
      let here = curled.get(key(i2));
      if (!here) curled.set(key(i2), (here = new PointGrid(Math.max(0.2, w))));
      curled.delete(key(i2 - 2));
      return { here, below: curled.get(key(i2 - 1)) };
    }
    /** Wall points over an overhang (to keep seams off them). */
    function overhangPoints(pts: number[], lower: Paths, w: number): [number, number][] {
      const inside = insideTester(lower);
      const out: [number, number][] = [];
      for (let k = 0; k < pts.length; k += 2) if (!inside(pts[k], pts[k + 1])) out.push([pts[k], pts[k + 1]]);
      void w;
      return out;
    }
    /** Smooth spiral: blend each point toward the next layer's outline, limited to the max XY smoothing. */
    function smoothSpiral(pts: number[], o: number, i2: number, w: number): number[] {
      if (!bool('spiral_mode_smooth') || i2 + 1 >= N || !objSlices[o][i2 + 1].length) return pts;
      const next = offset(objSlices[o][i2 + 1], -w / 2);
      if (!next.length) return pts;
      const maxD = floatOrPercent(cfg.spiral_mode_max_xy_smoothing, nozzle);
      const n = pts.length / 2;
      const out: number[] = [];
      for (let k = 0; k < n; k++) {
        const x = pts[k * 2], y = pts[k * 2 + 1];
        const [qx, qy] = nearestOn(next, x, y);
        const t = k / n;
        let dx = (qx - x) * t, dy = (qy - y) * t;
        const d = Math.hypot(dx, dy);
        if (d > maxD) { dx *= maxD / d; dy *= maxD / d; }
        out.push(x + dx, y + dy);
      }
      return out;
    }

    // --- subdivided mixes: the lower passes of every mix area, bottom up, before anything else at full height
    //     (the nozzle never goes down next to a line already printed on this layer)
    {
      const subJobs: { o: number; job: IslandJob }[] = [];
      for (const o of (only === null ? objs : [only])) for (const job of jobsByObj.get(o) ?? []) if (job.isl.sub && job.wallFil === job.isl.fil) subJobs.push({ o, job });
      const maxN = subJobs.length ? Math.max(...subJobs.map((x) => x.job.isl.sub!.length)) : 0;
      for (let j = 0; j < maxN - 1; j++) {
        const slots = [...new Set(subJobs.filter((x) => j < x.job.isl.sub!.length - 1).map((x) => x.job.isl.sub![j]))].sort((a, b) => (a === curTool ? -1 : b === curTool ? 1 : a - b));
        for (const f of slots) {
          changeTo(f);
          for (const { o, job } of subJobs) {
            const sub = job.isl.sub!, n = sub.length;
            if (j >= n - 1 || sub[j] !== f) continue;
            const items: PathItem[] = [];
            for (const loop of job.isl.walls.loops[0] ?? []) {
              const it: PathItem = { pts: simplify(loop.pts, resolution, loop.closed), closed: loop.closed, feature: loop.feature, width: loop.width, flow: 1, hole: loop.hole, wallDepth: 0 };
              if (it.pts.length >= 4) items.push(toPass(it, j, n));
            }
            if (subInfill) for (const fl of job.fills) if (SUB_FILL.has(fl.feature) && (fl.fil ?? job.isl.fil) === job.isl.fil && (fl.height === undefined || fl.height < h)) items.push(toPass({ ...fl, pts: fl.pts.slice(), height: undefined }, j, n));
            if (!items.length) continue;
            objFlow = (onum(o, i, 'flow_ratio_scale') || 1) * (onum(o, i, 'print_flow_ratio') || 1);
            curObj = o;
            if (labels) ops.push({ k: 'raw', text: flavor === 'klipper' ? `EXCLUDE_OBJECT_START NAME=${labelName(o)}` : `M486 S${o}` });
            for (const it of orderPaths(items, isNaN(px) ? 0 : px, isNaN(py) ? 0 : py).paths) extrudePath(it);
            if (labels) ops.push({ k: 'raw', text: flavor === 'klipper' ? `EXCLUDE_OBJECT_END NAME=${labelName(o)}` : 'M486 S-1' });
            objFlow = 1; curObj = -1;
          }
        }
      }
      if (maxN) order.splice(0, order.length, ...orderLayerTools(order, curTool, i, opts.filamentSequence));
    }

    // --- per filament: islands (walls, gap fill, fills) of every object
    for (const fil of order) {
      changeTo(fil);
      // intra-layer order: the object list order, or nearest object next (print_order "default")
      const objOrder = only !== null ? [only] : str('print_order') === 'default' ? nearestObjectOrder(objs.filter((o) => jobsByObj.get(o)?.length), (o) => {
        const sl = objSlices[o][i];
        if (!sl.length) return null;
        const b = bounds(sl);
        return [(b.minX + b.maxX) / 2 / SCALE, (b.minY + b.maxY) / 2 / SCALE];
      }, isNaN(px) ? 0 : px, isNaN(py) ? 0 : py) : objs;
      for (const o of objOrder) for (const job of jobsByObj.get(o) ?? []) emitJob(o, job, (f) => f === fil);
    }
    // flush targets left over (no change happened after them): print them with the current filament
    if (deferred.length) { for (const it of orderPaths(deferred, isNaN(px) ? 0 : px, isNaN(py) ? 0 : py).paths) extrudePath(it); deferred = []; }
    if (deferredJobs.length) { const dj = deferredJobs; deferredJobs = []; for (const d of dj) emitJob(d.o, d.job, () => true); }
    objFlow = 1;
    curObj = -1;

    // --- support
    function supportVolume(): number {
      if (!support) return 0;
      const sw = i === 0 ? lw0('initial_layer_line_width') : lw0('support_line_width');
      return supportItems(sw).reduce((a, it) => a + volumeOf(it), 0);
    }
    function supportItems(sw: number): PathItem[] {
      if (!support) return [];
      const items: PathItem[] = [];
      const base = support.base[i], iface = union(support.iface[i], support.bottomIface?.[i] ?? []);
      const bodyFil = supportFil >= 0 ? supportFil : -1;
      // independent support layer height: the base is printed every second layer at double height where both
      // layers have it (interfaces keep the object layers so the Z gap stays exact)
      const indep = bool('independent_support_layer_height') && !tree;
      const pairs = (j: number) => indep && j > raftN && (j - raftN) % 2 === 1 && j < N && hs[j - 1] + hs[j] <= (num('max_layer_height') || nozzle * 0.75) + 1e-6
        && !support!.iface[j].length && !support!.iface[j - 1].length;
      const parts: { reg: Paths; height?: number }[] = [];
      if (pairs(i)) {
        const both = intersection(base, support!.base[i - 1]);
        parts.push({ reg: both, height: hs[i - 1] + hs[i] }, { reg: difference(base, support.base[i - 1]) });
      } else if (pairs(i + 1)) parts.push({ reg: difference(base, support!.base[i + 1]) });
      else parts.push({ reg: base });
      for (const part of parts) {
        const base = opening(part.reg, sw * 0.25);
        if (!base.length) continue;
        const n0 = items.length;
        const wc = Math.round(num('tree_support_wall_count'));
        const walls = wc >= 0 ? wc : tree ? (treeStyle(supportStyle).trunk > 1.2 ? 2 : 1) : 1;
        let inner = base;
        for (let k = 0; k < walls && inner.length; k++) {
          for (const p of offset(inner, -sw / 2)) items.push({ pts: pathToPoly(p), closed: true, feature: 'support', width: sw, flow: 1, fil: bodyFil });
          inner = offset(inner, -sw);
        }
        const bp = str('support_base_pattern') || 'default';
        const firstDense = i === 0 ? Math.max(0.1, num('raft_first_layer_density') / 100) : 0;
        const spacing = firstDense ? sw / firstDense : num('support_base_pattern_spacing') + sw;
        const ang = num('support_angle') + (i === 0 ? 90 : 0);
        let lines: Polyline2[] = [];
        if (inner.length && bp !== 'hollow') {
          if (bp === 'rectilinear-grid') lines = [...linesFill(inner, spacing * 2, ang), ...linesFill(inner, spacing * 2, ang + 90)];
          else if (bp === 'honeycomb') lines = honeycombFill(inner, sw, Math.min(1, sw / spacing), ang);
          else if (bp === 'lightning' && !firstDense) lines = linesFill(inner, spacing * 2, ang + (i % 2 ? 90 : 0));
          else lines = linesFill(inner, spacing, ang);
        }
        for (const p of lines) items.push({ ...p, feature: 'support', width: sw, flow: 1, fil: bodyFil });
        if (part.height) for (let k = n0; k < items.length; k++) items[k].height = part.height;
      }
      if (iface.length) {
        const ip = str('support_interface_pattern') || 'auto';
        const topSp = num('support_interface_spacing'), botSp = num('support_bottom_interface_spacing');
        const sp = (support.bottomIface?.[i]?.length && !support.iface[i].length ? botSp : topSp) + sw;
        const ang = num('support_angle') + 90 + (ip === 'rectilinear_interlaced' && i % 2 ? 90 : 0);
        // loop pattern interface: the top contact layer gets a loop around its edge, the pattern fills the rest
        const contactLoop = bool('support_interface_loop_pattern') && support.iface[i].length > 0 && (i + 1 >= N || !support.iface[i + 1].length);
        let fillReg = iface;
        if (contactLoop) {
          for (const p of offset(support.iface[i], -sw / 2)) items.push({ pts: pathToPoly(p), closed: true, feature: 'support_interface', width: sw, flow: 1, fil: ifaceFil >= 0 ? ifaceFil : bodyFil });
          fillReg = union(offset(support.iface[i], -sw), support.bottomIface?.[i] ?? []);
        }
        const lines = ip === 'concentric' ? concentricFill(fillReg, sp, sw / 2)
          : ip === 'grid' ? [...linesFill(fillReg, sp * 2, ang), ...linesFill(fillReg, sp * 2, ang + 90)]
          : linesFill(fillReg, sp, ang);
        for (const p of lines) items.push({ ...p, feature: 'support_interface', width: sw, flow: 1, fil: ifaceFil >= 0 ? ifaceFil : bodyFil });
        // support ironing on the topmost interface layer
        if (bool('enable_support_ironing') && support.iface[i].length && (i + 1 >= N || !support.iface[i + 1].length)) {
          const isp = num('support_ironing_spacing');
          const reg = offset(support.iface[i], -sw / 2 - num('support_ironing_inset'));
          const il = str('support_ironing_pattern') === 'concentric' ? concentricFill(reg, isp, isp / 2) : linesFill(reg, isp, num('support_ironing_direction'));
          for (const p of il) items.push({ ...p, feature: 'ironing', width: isp, flow: (num('support_ironing_flow') / 100) * (h / isp), speed: num('support_ironing_speed'), fil: ifaceFil >= 0 ? ifaceFil : bodyFil });
        }
      }
      // small support perimeters: short support paths slow down (a percentage is of the support / interface speed)
      const smallT = num('small_support_perimeter_threshold');
      if (smallT > 0) for (const it of items) {
        if (it.feature !== 'support' && it.feature !== 'support_interface') continue;
        const base = normalSpeed(it.feature);
        const v = smallSupportSpeed(it, smallT, floatOrPercent(cfg.small_support_perimeter_speed ?? '50%', base), base);
        if (v !== undefined) it.speed = it.speed !== undefined ? Math.min(it.speed, v) : v;
      }
      return items;
    }
    function emitSupport() {
      if (!support || (!support.base[i].length && !support.iface[i].length && !support.bottomIface?.[i]?.length)) return;
      const sw = i === 0 ? lw0('initial_layer_line_width') : lw0('support_line_width');
      const items = supportItems(sw);
      // body first (support filament, or the loaded one), then the interface
      const groups = new Map<number, PathItem[]>();
      for (const it of items) {
        let f = it.fil ?? -1;
        if (f < 0) f = avoidIfaceForBody && curTool === ifaceFil ? (order.find((x) => x !== ifaceFil) ?? curTool) : curTool;
        const l = groups.get(f); if (l) l.push(it); else groups.set(f, [it]);
      }
      const keys = [...groups.keys()].sort((a, b) => (a === curTool ? -1 : b === curTool ? 1 : a - b));
      for (const f of keys) {
        if (f >= 0) changeTo(f);
        for (const it of orderPaths(groups.get(f)!, isNaN(px) ? 0 : px, isNaN(py) ? 0 : py).paths) extrudePath(it);
      }
    }
    if (only === null) { if (!flushSupportDone) emitSupport(); }
    else if (objSupport) {
      // by object: each object prints the support under it
      const own = objSupport.get(only);
      if (own) { const all = support; support = own; emitSupport(); support = all; }
    }

    // --- tower remainder: keep it growing every layer until the last filament change
    // (no sparse layers / combined sparse layers: skipped where no change printed on it)
    if (towerActive && (!towerSkip || towerUsed)) {
      towerOutline(true);
      for (let k = bandsDone; k < maxChanges; k++) towerBand(k, i === 0);
    }
    if (towerUsed) towerPrintedZ = towerZ;

    if (seams.length) prevSeams = seams;
    const L: LayerOps = { z: zTop, h, ops, fan: 0, layer: i, tool: Math.max(0, curTool) };
    if (i === 1) {
      const fl = filaments[Math.max(0, curTool)];
      if (fl.nozzleTemp !== fl.nozzleTempInitial) L.temp = fl.nozzleTemp;
      if (num('bed_temperature') !== num('bed_temperature_initial_layer')) L.bedTemp = num('bed_temperature');
    }
    layerOps.push(L);
  };

  // print order of objects when printing by object: shortest first, the tallest last (gantry clearance)
  const byObjOrder = meshes.map((_, o) => o).sort((a, b) => (objLast[a] - objLast[b]) || a - b);
  let objSupport: Map<number, { base: Paths[]; iface: Paths[]; bottomIface?: Paths[] }> | null = null;
  if (byObject) {
    checkSequentialClearance();
    if (support) {
      // supports belong to their object
      objSupport = new Map();
      for (const o of byObjOrder) {
        const mask = Array.from({ length: N }, (_, i) => offset(objSlices[o].slice(i).find((s) => s.length) ?? [], 20));
        objSupport.set(o, { base: support.base.map((b, i) => (b.length ? intersection(b, mask[i]) : [])), iface: support.iface.map((b, i) => (b.length ? intersection(b, mask[i]) : [])), bottomIface: support.bottomIface?.map((b, i) => (b.length ? intersection(b, mask[i]) : [])) });
      }
    }
    if (opts.plugins && Object.keys(opts.plugins).length) warn('Plugins are not applied when printing by object.');
    const objGcode = str('printing_by_object_gcode');
    byObjOrder.forEach((o, k) => {
      if (k > 0) {
        if (objGcode) layerOps[layerOps.length - 1].ops.push({ k: 'raw', text: expandMacro(objGcode, cfg) });
        // lift over everything printed so far before travelling to the next object
        const L = layerOps[layerOps.length - 1];
        L.ops.push({ k: 'retract', len: retractLen, speed: retractSpeed });
        retracted = true;
        safeZ = maxPrinted + Math.max(1, zHop) + 1;
        prevSeams = [];
      }
      for (let i = 0; i <= objLast[o]; i++) {
        if (i >= objStart && !objSlices[o][i].length) continue;
        emitLayer(i, o);
      }
    });
  } else {
    for (let i = 0; i < N; i++) {
      emitLayer(i, null);
      if (i % 5 === 0) progress('Generating infill & toolpaths', 0.58 + 0.32 * (i / N));
    }
  }
  // the last filament's end G-code
  if (curTool >= 0 && layerOps.length) {
    const eg = String(filaments[curTool]?.settings?.filament_end_gcode ?? '');
    if (eg) layerOps[layerOps.length - 1].ops.push({ k: 'raw', text: expandMacro(eg, cfg, { filament_extruder_id: curTool }) });
  }

  function checkSequentialClearance() {
    const r = num('extruder_clearance_max_radius');
    const hulls = meshes.map((_, o) => offset(objSlices[o][objStart] ?? [], r / 2));
    for (let a = 0; a < meshes.length; a++) for (let b = a + 1; b < meshes.length; b++) {
      if (hulls[a].length && hulls[b].length && intersection(hulls[a], hulls[b]).length) {
        warn(`By object: ${meshes[a].name} and ${meshes[b].name} are closer than the extruder clearance radius (${r} mm); the print head would hit a finished object.`);
      }
    }
    const rod = num('extruder_clearance_height_to_rod'), lid = num('extruder_clearance_height_to_lid');
    byObjOrder.slice(0, -1).forEach((o) => {
      const top = objLast[o] >= 0 ? zs[objLast[o]] : 0;
      if (rod > 0 && top > rod) warn(`By object: ${meshes[o].name} (${top.toFixed(1)} mm) is taller than the gantry rod clearance (${rod} mm); only the last object may be taller.`);
    });
    for (let o = 0; o < meshes.length; o++) {
      const top = objLast[o] >= 0 ? zs[objLast[o]] : 0;
      if (lid > 0 && top > lid) warn(`By object: ${meshes[o].name} is taller than the lid clearance (${lid} mm).`);
    }
  }

  // ---------- stage 10: emit
  progress('Writing G-code', 0.92);
  const objectLabels = meshes.map((m, o) => {
    const b = bounds(objSlices[o].flat());
    const x0 = b.minX / SCALE, y0 = b.minY / SCALE, x1 = b.maxX / SCALE, y1 = b.maxY / SCALE;
    return { name: labelName(o), cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, polygon: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] as [number, number][] };
  }).filter((l) => isFinite(l.cx));
  // ---------- plugins: post-toolpath, pre-G-code
  let pluginRun: ReturnType<typeof runPlugins> = { header: [], reports: {} };
  if (opts.plugins && Object.keys(opts.plugins).length && !byObject) {
    progress('Running plugins', 0.9);
    const faceRegions: FaceRegion[] = [];
    meshes.forEach((m, o) => (m.faceSets ?? []).forEach((fs) => {
      if (!fs.tris.length) return;
      const tris: PaintedTri[] = [];
      const v = m.vertices, ix = m.indices;
      for (const t of fs.tris) {
        const za = v[ix[t * 3] * 3 + 2], zb = v[ix[t * 3 + 1] * 3 + 2], zc = v[ix[t * 3 + 2] * 3 + 2];
        tris.push({ t, zmin: Math.min(za, zb, zc), zmax: Math.max(za, zb, zc), value: 1 });
      }
      // The strip reaches in far enough to cover every wall line under the picked surface.
      const depth = Math.max(1, onum(o, objStart, 'wall_loops')) * olw(o, objStart, 'inner_wall_line_width') + olw(o, objStart, 'outer_wall_line_width');
      const cache = new Map<number, [number, number][][]>();
      faceRegions.push({
        id: `${m.id}:${fs.id}`, name: fs.name,
        polygonsAt(li) {
          const hit = cache.get(li);
          if (hit) return hit;
          const sl = objSlices[o][li];
          const map = sl?.length ? colorRegionsAtZ(m as IndexedMesh, tris, sl, planes[li], depth) : new Map();
          const r = (map.get(1) ?? []).map((p: Paths[number]) => p.map((q) => [q.X / SCALE, q.Y / SCALE] as [number, number]));
          cache.set(li, r);
          return r;
        },
      });
    }));
    pluginRun = runPlugins(layerOps, opts.plugins, { cfg, layerZ: zs, faceRegions, warn }, sessions);
  }
  const bodyTransform = programBodyPlugins(opts.plugins, { cfg, layerZ: zs, faceRegions: [], warn: (msg) => { if (!warnings.includes(msg)) warnings.push(msg); } }, sessions);
  const res = emit({ cfg, filaments, layers: layerOps, objectLabels: labels ? objectLabels : [], headerLines: pluginRun.header, bodyTransform, templateExtra: vendorTpl ? { in_head_wrap_detect_zone: inHeadWrapZone(), max_print_z: Math.ceil(zs[N - 1] ?? 0) } : undefined });

  const bx = num('bed_x'), by = num('bed_y');
  const all = bounds(layerSlices.flat());
  if (all.minX / SCALE < -0.01 || all.minY / SCALE < -0.01 || all.maxX / SCALE > bx + 0.01 || all.maxY / SCALE > by + 0.01) {
    warn('Some geometry lies outside the printable area.');
  }
  if (maxZ + shift > num('bed_z')) warn(`Model height ${(maxZ + shift).toFixed(1)} mm exceeds the printer's maximum height (${num('bed_z')} mm).`);
  if (usedFils.size > 1 && !hasAms) warn(`This print uses ${usedFils.size} filaments; the printer will pause for each manual filament change (${res.stats.toolChanges}).`);
  if (changer === 'ams' && slotCount(cfg) > 0 && Math.max(...usedFils) + 1 > slotCount(cfg)) warn(`This print uses filament slot ${Math.max(...usedFils) + 1} but the filament unit has ${slotCount(cfg)} slots. Move the filaments to slots 1–${slotCount(cfg)}, or swap spools by hand when the printer asks.`);
  if (usedMixes.size && !toolChanger) warn(`Colour mixing changes filament on every layer. This printer has ${hasAms ? 'one nozzle: each change purges' : 'no automatic changes: it pauses on each change'}; mixing works best on a tool changer (Snapmaker U1).`);
  for (const k of usedMixes) if (mixProblems(mixes[k], filaments.length).length) warn(`Mixed filament ${filaments.length + k + 1}: ${mixProblems(mixes[k], filaments.length).join(' ')}`);
  if (toolChanger && Math.max(...usedFils) + 1 > toolheadCount(cfg)) warn(`This print uses filament slot ${Math.max(...usedFils) + 1} but the tool changer has ${toolheadCount(cfg)} heads. Slot n prints with head n: move the filaments to slots 1–${toolheadCount(cfg)}.`);
  progress('Done', 1);
  // a program that repeats the print (Bulnex) is longer than the single print the preview and stats describe: say so
  const bx1 = pluginRun.reports.bulnex as BulnexReport | undefined;
  if (bx1 && !bx1.calibration && bx1.cycles >= 1 && bx1.row) {
    const st = res.stats, n = bx1.cycles;
    st.repeat = {
      cycles: n, partsPerCycle: bx1.row.parts, perCycleSeconds: st.timeSeconds,
      coolSeconds: bx1.coolS, pushSeconds: bx1.pushS, reheatSeconds: bx1.reheatS,
      totalSeconds: n * (st.timeSeconds + bx1.coolS + bx1.pushS) + (n - 1) * bx1.reheatS,
      totalGrams: st.filamentGrams * n, totalMm: st.filamentMm * n, totalCost: st.filamentCost * n,
    };
  }
  return { ...res, warnings, pluginReports: pluginRun.reports };
}

/** Whether the straight travel A→B crosses the outline of the layer (Auto Z hop picks the spiral lift then). */
function crossesSlice(ax: number, ay: number, bx: number, by: number, slice: Paths): boolean {
  const dx = bx - ax, dy = by - ay;
  for (const p of slice) for (let k = 0; k < p.length; k++) {
    const a = p[k], b = p[(k + 1) % p.length];
    const cx = a.X / SCALE, cy = a.Y / SCALE, ex = b.X / SCALE - cx, ey = b.Y / SCALE - cy;
    const den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-12) continue;
    const t = ((cx - ax) * ey - (cy - ay) * ex) / den, u = ((cx - ax) * dy - (cy - ay) * dx) / den;
    if (t > 1e-6 && t < 1 - 1e-6 && u >= 0 && u <= 1) return true;
  }
  return false;
}

/** Nearest point on polygon outlines. */
function nearestOn(paths: Paths, x: number, y: number): [number, number] {
  let bx = x, by = y, bd = Infinity;
  for (const p of paths) for (let k = 0; k < p.length; k++) {
    const a = p[k], b = p[(k + 1) % p.length];
    const ax = a.X / SCALE, ay = a.Y / SCALE, dx = b.X / SCALE - ax, dy = b.Y / SCALE - ay, L = dx * dx + dy * dy;
    const t = L ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L)) : 0;
    const qx = ax + t * dx, qy = ay + t * dy, d = (qx - x) ** 2 + (qy - y) ** 2;
    if (d < bd) { bd = d; bx = qx; by = qy; }
  }
  return [bx, by];
}

export type { WallItem };

