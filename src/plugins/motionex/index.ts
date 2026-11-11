// Motionex UI-side state: motion library, applied motions and print-head shapes.
// The engine side (engine.ts) receives a plain-data snapshot of this through toConfig().
import { defaultToolhead, type CollisionMode, type ToolheadProfile } from './core/toolhead';
import { DEFAULT_OPTIONS, type ModifierOptions } from './modifier';
import { BrushLibrary, type KeyValueStore } from './library';
import type { MotionApplication } from './model';
import type { MotionexConfig } from './engine';
import type { PreviewView } from './preview';
import { defaultWeave, type WeaveSettings } from './weave/model';
import { defaultPaint, type PaintSettings } from './paint/model';
import { defaultLace, type LaceSettings } from './lace/model';
import { defaultSculpt, sculptActive, type SculptSettings } from './sculpt/model';
import { draftMode, loadRules, ruleActive, type SelectRule } from './select/model';

export interface MotionexState {
  library: BrushLibrary;
  applications: MotionApplication[];
  options: ModifierOptions;
  /** What to do when the print head would hit the print. */
  collisionMode: CollisionMode;
  toolheads: ToolheadLibrary;
  /** What the quick preview on the model is coloured by. */
  previewView: PreviewView;
  /** Weave mode: a picture woven into the wall. */
  weave: WeaveSettings;
  /** Velocity painting: a picture as outer wall speed (sheen), one filament. */
  paint: PaintSettings;
  /** Lace: openwork holes cut into the walls. */
  lace: LaceSettings;
  /** Path sculpt: hand-made moves on the unrolled wall, over any pattern. */
  sculpt: SculptSettings;
  /** Select & apply: selections on the sliced print and what to change there. */
  rules: SelectRule[];
}

const TOOLHEAD_KEY = 'nexspiro.toolheads.v1';
const APPS_KEY = 'nexspiro.motionex.state.v1';

/** Print-head shapes saved per printer. */
export class ToolheadLibrary {
  private saved: Record<string, ToolheadProfile> = {};
  private store: KeyValueStore | null;
  constructor(store: KeyValueStore | null) {
    this.store = store;
    try { this.saved = JSON.parse(store?.getItem(TOOLHEAD_KEY) ?? '{}'); } catch { this.saved = {}; }
  }
  get(deviceId: string): ToolheadProfile { return structuredClone(this.saved[deviceId] ?? defaultToolhead(deviceId)); }
  isCustom(deviceId: string): boolean { return deviceId in this.saved; }
  save(t: ToolheadProfile): void { this.saved[t.device_id] = structuredClone(t); this.persist(); }
  reset(deviceId: string): void { delete this.saved[deviceId]; this.persist(); }
  private persist(): void { try { this.store?.setItem(TOOLHEAD_KEY, JSON.stringify(this.saved)); } catch { /* storage unavailable */ } }
}

export function createMotionexState(store: KeyValueStore | null): MotionexState {
  const state: MotionexState = {
    library: new BrushLibrary(store), applications: [], options: { ...DEFAULT_OPTIONS },
    collisionMode: 'clamp', toolheads: new ToolheadLibrary(store), previewView: 'motion', weave: defaultWeave(),
    paint: defaultPaint(), lace: defaultLace(), sculpt: defaultSculpt(), rules: [],
  };
  try {
    const s = JSON.parse(store?.getItem(APPS_KEY) ?? 'null');
    if (s) { state.applications = s.applications ?? []; state.options = { ...DEFAULT_OPTIONS, ...s.options }; state.collisionMode = s.collisionMode ?? 'clamp'; state.previewView = s.previewView ?? 'motion'; state.weave = loadWeave(s.weave); state.paint = loadPaint(s.paint); state.lace = loadLace(s.lace); state.sculpt = loadSculpt(s.sculpt); state.rules = loadRules(s.rules); }
  } catch { /* fresh start */ }
  return state;
}

export function saveMotionexState(state: MotionexState, store: KeyValueStore | null): void {
  try { store?.setItem(APPS_KEY, JSON.stringify({ applications: state.applications, options: state.options, collisionMode: state.collisionMode, previewView: state.previewView, weave: state.weave, paint: state.paint, lace: state.lace, sculpt: state.sculpt, rules: state.rules })); } catch { /* storage unavailable */ }
}

/** Plain-data snapshot for the slicing worker. */
export function toConfig(state: MotionexState, printerId: string): MotionexConfig {
  const rules = (draftMode.on ? state.rules.map((r) => ({ ...r, apply: { ...r.apply, motion: undefined } })) : state.rules).filter(ruleActive);
  const used = new Set([...state.applications.filter((a) => a.enabled && !a.brush).map((a) => a.brush_id), ...rules.flatMap((r) => (r.apply.motion ? [r.apply.motion.brush_id] : []))]);
  return {
    applications: structuredClone(state.applications),
    brushes: [...used].map((id) => state.library.get(id)).filter((b): b is NonNullable<typeof b> => !!b).map((b) => structuredClone(b)),
    options: { ...state.options }, collisionMode: state.collisionMode,
    toolhead: state.toolheads.get(printerId), printerId,
    ...(state.weave.enabled ? { weave: structuredClone(state.weave) } : {}),
    ...(state.paint.enabled ? { paint: structuredClone(state.paint) } : {}),
    ...(state.lace.enabled ? { lace: structuredClone(state.lace) } : {}),
    ...(sculptActive(state.sculpt) ? { sculpt: structuredClone(state.sculpt) } : {}),
    ...(rules.length ? { rules: structuredClone(rules) } : {}),
  };
}

/** Saved weave settings over the defaults (older saves have none, newer fields fall back). */
export function loadWeave(d: unknown): WeaveSettings {
  const base = defaultWeave();
  const w = d as Partial<WeaveSettings> | null | undefined;
  if (!w || typeof w !== 'object') return base;
  return { ...base, ...w, seam: { ...base.seam, ...w.seam }, change: { ...base.change, ...w.change }, image: w.image?.px?.length ? w.image : base.image };
}

/** Saved velocity painting settings over the defaults. */
export function loadPaint(d: unknown): PaintSettings {
  const base = defaultPaint();
  const p = d as Partial<PaintSettings> | null | undefined;
  if (!p || typeof p !== 'object') return base;
  return { ...base, ...p, image: p.image?.px?.length ? p.image : base.image };
}

/** Saved path sculpt settings over the defaults. */
export function loadSculpt(d: unknown): SculptSettings {
  const base = defaultSculpt();
  const x = d as Partial<SculptSettings> | null | undefined;
  if (!x || typeof x !== 'object') return base;
  return { ...base, ...x, d: x.d && typeof x.d === 'object' ? x.d : {} };
}

/** Saved lace settings over the defaults. */
export function loadLace(d: unknown): LaceSettings {
  const base = defaultLace();
  const l = d as Partial<LaceSettings> | null | undefined;
  if (!l || typeof l !== 'object') return base;
  return { ...base, ...l, image: l.image?.px?.length ? l.image : base.image };
}

/** Any wall-art mode or motion switched on (the slicer then needs Motionex). */
export const motionexActive = (state: MotionexState) => state.applications.some((a) => a.enabled) || state.weave.enabled || state.paint.enabled || state.lace.enabled || sculptActive(state.sculpt) || (draftMode.on ? state.rules.some((r) => ruleActive({ ...r, apply: { ...r.apply, motion: undefined } })) : state.rules.some(ruleActive));

export function defaultApplication(brush_id: string): MotionApplication {
  return { brush_id, target: { type: 'body', walls: 'outer' }, mask: { z_start: 0.6, z_end: 1e4, fade_in_mm: 1, fade_out_mm: 0 }, order: 0, blend: 'add', enabled: true };
}
