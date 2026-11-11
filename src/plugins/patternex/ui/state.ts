// Patternex UI-side state: patterns, placements (object-local), region actions and printer options.
// Plain data with a tiny change signal, like Motionex. Converted to plate coordinates only for slicing.
import { builtinPattern } from '../builtin';
import { restoreFont, userFontData } from '../tools/text';
import type { Pattern, Placement, RegionAction } from '../model';
import type { PatternexConfig, SingleColourPolicy } from '../engine';
import type { V3, WorldPlacement } from '../projection';

/** A placement stored in its object's local frame, so it follows the object when it moves. */
export interface ObjPlacement extends Placement {
  object_id: string;
  /** Cylindrical: a point on the wrap axis, object-local (the object's centre line by default). */
  axis_origin?: V3;
  /** Object-local normal of the face it was dropped on (restored when switching back to planar). */
  anchor_normal?: V3;
}

/** What one scene object carries: its placements and their region actions. */
export interface ObjectPatternex {
  placements: ObjPlacement[]; actions: RegionAction[];
  /** Definitions of the patterns used, so a project opens anywhere. */
  patterns?: Pattern[];
  /** User fonts used by text artwork (font id → base64), so text can be edited and batched anywhere. */
  fonts?: Record<string, string>;
}

/** Font id of generated text artwork, if it uses a user font. */
const userFontOf = (p: Pattern): string | undefined => {
  const f = p.meta?.kind === 'text' ? (p.meta.spec as { font?: string })?.font : undefined;
  return f?.startsWith('user:') ? f : undefined;
};

/**
 * Collect placements from scene objects (deep copies, so the panel can edit them freely).
 * Copies of an object (clone, paste, fill bed) carry the same placement ids; each duplicate gets a
 * stable id derived from its object so region ids stay unique. `renamed` says whether that happened.
 */
export function collectPlacements(objects: { id: string; patternex?: ObjectPatternex }[]): { placements: ObjPlacement[]; actions: RegionAction[]; patterns: Pattern[]; renamed: boolean } {
  const seen = new Set<string>();
  const placements: ObjPlacement[] = [], actions: RegionAction[] = [], patterns: Pattern[] = [];
  let renamed = false;
  for (const o of objects) {
    const pe = o.patternex;
    if (!pe) continue;
    for (const pat of pe.patterns ?? []) if (!patterns.some((x) => x.id === pat.id)) patterns.push(pat);
    for (const [id, data] of Object.entries(pe.fonts ?? {})) restoreFont(id, data);
    for (const p0 of pe.placements) {
      let id = p0.id;
      if (seen.has(id) || p0.object_id !== o.id) { id = `${p0.id.split('~')[0]}~${o.id}`; renamed = renamed || id !== p0.id; }
      seen.add(id);
      for (const a of pe.actions) if (a.region_ref.placement_id === p0.id) actions.push(structuredClone({ ...a, region_ref: { ...a.region_ref, placement_id: id } }));
      placements.push(structuredClone({ ...p0, id, object_id: o.id }));
    }
  }
  return { placements, actions, patterns, renamed };
}

/** Group placements and actions back by object. */
export function splitByObject(placements: ObjPlacement[], actions: RegionAction[], patterns: Pattern[] = []): Map<string, ObjectPatternex> {
  const out = new Map<string, ObjectPatternex>();
  for (const p of placements) {
    let e = out.get(p.object_id); if (!e) out.set(p.object_id, (e = { placements: [], actions: [], patterns: [] }));
    e.placements.push(structuredClone(p));
    const pat = patterns.find((x) => x.id === p.pattern_id);
    if (pat && !e.patterns!.some((x) => x.id === pat.id)) {
      e.patterns!.push(pat);
      const font = userFontOf(pat), data = font && userFontData(font);
      if (font && data) (e.fonts ??= {})[font] = data;
    }
    for (const a of actions) if (a.region_ref.placement_id === p.id) e.actions.push(structuredClone(a));
  }
  return out;
}

type M4 = ArrayLike<number>;
const apply4 = (m: M4, [x, y, z]: V3): V3 => [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
const dir4 = (m: M4, [x, y, z]: V3): V3 => { const v: V3 = [m[0] * x + m[4] * y + m[8] * z, m[1] * x + m[5] * y + m[9] * z, m[2] * x + m[6] * y + m[10] * z]; const l = Math.hypot(...v) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };

/**
 * Re-express placements after an object's local frame changed (mirror, split, …).
 * `toWorld`: old local → world, `fromWorld`: world → new local, `reflect`: optional mirror applied in world.
 * A reflection reverses handedness, so the artwork is flipped and its rotation negated: a true mirror image.
 * (Directions use the linear part only; the object matrices here are rigid or uniformly scaled.)
 */
export function reframePlacements(pe: ObjectPatternex, toWorld: M4, fromWorld: M4, reflect?: (v: V3, isDir: boolean) => V3): ObjectPatternex {
  const R = reflect ?? ((v: V3) => v);
  const wp = (v: V3) => apply4(fromWorld, R(apply4(toWorld, v), false));
  const wd = (v: V3) => dir4(fromWorld, R(dir4(toWorld, v), true));
  return {
    actions: structuredClone(pe.actions),
    placements: pe.placements.map((p) => ({
      ...structuredClone(p),
      position_xyz: wp(p.position_xyz),
      projection_axis: wd(p.projection_axis),
      anchor_normal: p.anchor_normal ? wd(p.anchor_normal) : undefined,
      axis_origin: p.axis_origin ? wp(p.axis_origin) : undefined,
      ...(reflect ? { flip: !p.flip, rotation: -p.rotation } : {}),
    })),
  };
}

export interface Overlays { outlines: boolean; transitions: boolean; swaps: boolean; bleed: boolean }

/** A saved logo with its inks (brand kit). */
export interface BrandItem { id: string; name: string; pattern: Pattern; inks: Record<string, number>; relief?: { mode: 'raise' | 'recess'; height_mm: number } | null }

/** Surface brush: paints strokes into a placement's own pattern. */
export interface BrushState { active: boolean; width: number; color: string }

export interface PatternexState {
  patterns: Pattern[];
  placements: ObjPlacement[];
  actions: RegionAction[];
  singleColour: SingleColourPolicy;
  /** Calibrated transition volume (mm³) per filament slot; null = estimated. */
  transitionVolume: (number | null)[];
  /** Pattern waiting to be placed with the next click on the model. */
  armed: string | null;
  /** Inks chosen in the library for the armed pattern (group key colour → slot). */
  armedInks?: Record<string, number>;
  /** Relief for the armed pattern (Create panel finish): applied to every group of the new placement. */
  armedRelief?: { mode: 'raise' | 'recess'; height_mm: number } | null;
  /** Inks the user saved per library design (entry key → group key colour → slot). */
  savedInks: Record<string, Record<string, number>>;
  selected: string | null;
  overlays: Overlays;
  /** Purge of full/reduced changes: tower only, or into infill / a sacrificial object first. */
  purgeTarget: 'tower' | 'infill' | 'object';
  /** Scene object id of the sacrificial purge object. */
  purgeObjectId: string | null;
  /** Single-colour bands: merge base gaps shorter than this many layers (0 = off). */
  swapMergeLayers: number;
  brandKit: BrandItem[];
  brush: BrushState;
}

const KEY = 'nexspiro.patternex.v1';

export function createPatternexState(store: Pick<Storage, 'getItem'> | null): PatternexState {
  const base: PatternexState = {
    patterns: [], placements: [], actions: [], singleColour: 'skip', transitionVolume: [], savedInks: {},
    armed: null, selected: null, overlays: { outlines: true, transitions: true, swaps: true, bleed: true },
    purgeTarget: 'tower', purgeObjectId: null, swapMergeLayers: 0, brandKit: [], brush: { active: false, width: 1.2, color: '#2f2f33' },
  };
  try {
    const saved = JSON.parse(store?.getItem(KEY) ?? 'null');
    if (saved && Array.isArray(saved.patterns)) return { ...base, ...saved, placements: [], actions: [], selected: null, armed: null, armedInks: undefined, brush: { ...base.brush, ...saved.brush, active: false } };
  } catch { /* ignore broken storage */ }
  return base;
}

export function savePatternexState(s: PatternexState, store: Pick<Storage, 'setItem'> | null): void {
  try {
    // placements live on the scene objects (project files); keep only the library, settings and saved inks here
    const patterns = s.patterns.filter((p) => p.source === 'svg');
    store?.setItem(KEY, JSON.stringify({
      patterns, singleColour: s.singleColour, transitionVolume: s.transitionVolume, savedInks: s.savedInks, overlays: s.overlays,
      purgeTarget: s.purgeTarget, purgeObjectId: s.purgeObjectId, swapMergeLayers: s.swapMergeLayers, brandKit: s.brandKit, brush: s.brush,
    }));
  } catch { /* quota or unavailable: keep in memory */ }
}

export function addPattern(s: PatternexState, p: Pattern): Pattern {
  const i = s.patterns.findIndex((x) => x.id === p.id);
  if (i >= 0) s.patterns[i] = p; else s.patterns.push(p);
  return p;
}

export const ensureBuiltin = (s: PatternexState, kind: Parameters<typeof builtinPattern>[0]) => addPattern(s, builtinPattern(kind));

/**
 * Default actions for a new placement, full purge. A one-colour pattern goes on slot 2; with several
 * colours the first stays the base material and the others take slots 2, 3, …
 */
export function defaultActions(placementId: string, pattern: Pattern, slots: number): RegionAction[] {
  const all = [...new Set(pattern.shapes.map((x) => x.fill_color))];
  const colors = all.length > 1 ? all.slice(1) : all;
  if (slots < 2) return [];
  return colors.map((color, k) => ({
    region_ref: { placement_id: placementId, color_group: color },
    material: { mode: 'slot', slot_index: Math.min(slots - 1, k + 1) },
    purge: { mode: 'full', change_point_shift_mm: 0 },
    motion: null,
  }));
}

type Mat = ArrayLike<number>; // column-major 4×4 (three.js Matrix4.elements)
const xform = (m: Mat, [x, y, z]: V3): V3 => [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];

/** Direction through the inverse-transpose (normals stay perpendicular under non-uniform scale). */
function xformNormal(m: Mat, [x, y, z]: V3): V3 {
  const a = m[0], b = m[4], c = m[8], d = m[1], e = m[5], f = m[9], g = m[2], h = m[6], i = m[10];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const D = -(b * i - c * h), E = a * i - c * g, F = -(a * h - b * g);
  const G = b * f - c * e, H = -(a * f - c * d), I = a * e - b * d;
  // cofactor matrix = det · inverse-transpose
  const n: V3 = [A * x + B * y + C * z, D * x + E * y + F * z, G * x + H * y + I * z];
  const det = a * A + b * B + c * C;
  const l = Math.hypot(...n) || 1;
  const sgn = det < 0 ? -1 : 1;
  return [(n[0] / l) * sgn, (n[1] / l) * sgn, (n[2] / l) * sgn];
}

/** Placements → plate coordinates for the worker. `objects` is the slice order with object→plate matrices. */
export function toWorldPlacements(placements: ObjPlacement[], objects: { id: string; matrix: Mat }[]): WorldPlacement[] {
  const out: WorldPlacement[] = [];
  for (const p of placements) {
    const k = objects.findIndex((o) => o.id === p.object_id);
    if (k < 0 || !p.visible) continue;
    const m = objects[k].matrix;
    const { object_id: _, axis_origin, anchor_normal: __, ...rest } = p;
    out.push({
      ...rest,
      object: k,
      position_xyz: xform(m, p.position_xyz),
      // the wrap axis is a direction like any other; normals need the inverse-transpose
      projection_axis: p.projection === 'cylindrical' ? dirOf(m, p.projection_axis) : xformNormal(m, p.projection_axis),
      axis_origin: axis_origin ? xform(m, axis_origin) : undefined,
    });
  }
  return out;
}

function dirOf(m: Mat, [x, y, z]: V3): V3 {
  const v: V3 = [m[0] * x + m[4] * y + m[8] * z, m[1] * x + m[5] * y + m[9] * z, m[2] * x + m[6] * y + m[10] * z];
  const l = Math.hypot(...v) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

export function toPatternexConfig(s: PatternexState, objects: { id: string; matrix: Mat }[]): PatternexConfig | undefined {
  const placements = toWorldPlacements(s.placements, objects);
  if (!placements.length) return undefined;
  const used = new Set(placements.map((p) => p.pattern_id));
  return {
    patterns: s.patterns.filter((p) => used.has(p.id)),
    placements,
    actions: s.actions.filter((a) => placements.some((p) => p.id === a.region_ref.placement_id)),
    singleColour: s.singleColour,
    transitionVolume: s.transitionVolume,
    purgeTarget: s.purgeTarget,
    purgeObject: s.purgeObjectId ? objects.findIndex((o) => o.id === s.purgeObjectId) : -1,
    swapMergeLayers: s.swapMergeLayers,
  };
}

/** What a project file keeps (spec: placements can be re-used for repeat orders). */
export interface PatternexProjectData {
  version: 1;
  patterns: Pattern[]; placements: ObjPlacement[]; actions: RegionAction[];
  singleColour: SingleColourPolicy; transitionVolume: (number | null)[];
}


/** Key under which inks saved for a whole pattern (from the panel) are stored in `savedInks`. */
export const patternInkKey = (patternId: string) => `pattern:${patternId}`;
