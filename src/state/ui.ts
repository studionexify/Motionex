// Workspace-shell UI state for the redesigned layout (pins, inspector context, command palette) and
// the read-only view models the shell and inspector render (intent presets, effects, clearance, summary).
// CONTRACT: the shell and inspector import only from here; the bindings below are filled in against the
// real store, advanced state and plugins. Signatures are fixed; implementations may change.
import { create } from 'zustand';
import { useStore, type Tool } from './store';
import { setTech, useAdvanced } from './advanced';
import { PROCESS_PARAMS, type ProcessTab } from '../profiles/settings';
import { TECHS } from '../engine/advanced/techs';
import type { IntentId } from '../engine/advanced/types';
import { PLUGINS } from '../plugins/registry';
import { WAVE_PRESETS, presetOf } from '../plugins/motionex/weave/model';
import { brushOf, changed as mxChanged, mx, surfaceOf, useMx } from '../plugins/motionex/ui/MotionexPanel';
import { changed as pxChanged, px, usePatternex } from '../plugins/patternex/ui/PatternexPanel';
import type { MotionApplication } from '../plugins/motionex/model';
import type { PrintCheck } from '../plugins/motionex/core/types';

export type InspectorContext = 'plate' | 'object';
/** Interface zoom: 'auto' fits the window, or a fixed factor. */
export type UiScale = 'auto' | 0.8 | 0.9 | 1 | 1.1;

export interface UiState {
  /** Inspector shows the selection's object view, or the plate view. Derived default: 'object' when something is selected. */
  inspectorCtx: InspectorContext;
  /** Process setting keys pinned to the top of the inspector (PROCESS_PARAMS keys). */
  pinnedParams: string[];
  /** Plugin ids pinned to the left rail. */
  pinnedPlugins: string[];
  /** Print settings column folded away while a plugin's settings bar is open. */
  inspectorCollapsed: boolean;
  paletteOpen: boolean;
  uiScale: UiScale;
  set: (p: Partial<UiState>) => void;
  togglePinParam: (key: string) => void;
  togglePinPlugin: (id: string) => void;
}

const LS = 'nexspiro.ui.v1';
const prefs: Partial<UiState> = (() => { try { return JSON.parse(localStorage.getItem(LS) ?? '{}'); } catch { return {}; } })();

export const useUi = create<UiState>((set, get) => ({
  inspectorCtx: 'plate',
  pinnedParams: Array.isArray(prefs.pinnedParams) ? prefs.pinnedParams : ['wall_loops', 'sparse_infill_density', 'outer_wall_speed'],
  pinnedPlugins: Array.isArray(prefs.pinnedPlugins) ? prefs.pinnedPlugins : [],
  inspectorCollapsed: !!prefs.inspectorCollapsed,
  paletteOpen: false,
  uiScale: prefs.uiScale ?? 'auto',
  set: (p) => set(p),
  togglePinParam: (key) => { const l = get().pinnedParams; set({ pinnedParams: l.includes(key) ? l.filter((k) => k !== key) : [...l, key] }); },
  togglePinPlugin: (id) => { const l = get().pinnedPlugins; set({ pinnedPlugins: l.includes(id) ? l.filter((k) => k !== id) : [...l, id] }); },
}));
useUi.subscribe((s) => { try { localStorage.setItem(LS, JSON.stringify({ pinnedParams: s.pinnedParams, pinnedPlugins: s.pinnedPlugins, inspectorCollapsed: s.inspectorCollapsed, uiScale: s.uiScale })); } catch { /* storage off */ } });

/* ---------- view models (bindings) ---------- */

export interface IntentPreset {
  id: string;
  label: string;
  engine: 'basic' | 'advanced';
  description: string;
}

/** What each preset sets: engine mode, the Advanced intent (advanced only) and the base process preset (PROCESS_PRESETS id). */
interface PresetTarget { intent?: IntentId; processPreset: string; weave?: boolean }
const PRESET_TARGETS: Record<string, PresetTarget> = {
  woven: { intent: 'aesthetic', processPreset: '0.20', weave: true },
  smooth: { intent: 'aesthetic', processPreset: '0.16', weave: false },
  structural: { intent: 'structural', processPreset: '0.20' },
  standard: { processPreset: '0.20' },
  draft: { processPreset: '0.28' },
};

/** One-click presets; each one sets the engine (and process / advanced intent) — see applyIntentPreset. */
export const INTENT_PRESETS: IntentPreset[] = [
  { id: 'woven', label: 'Woven picture', engine: 'advanced', description: 'Seamless aesthetic walls with a picture woven in by Motionex Weave (0.20 mm layers).' },
  { id: 'smooth', label: 'Smooth non-planar', engine: 'advanced', description: 'Curved top skins and smooth sloped walls that follow the surface (0.16 mm layers).' },
  { id: 'structural', label: 'Structural', engine: 'advanced', description: 'Load-aware infill, interlocking layers and warp compensation for strong parts (0.20 mm layers).' },
  { id: 'standard', label: 'Standard 0.20', engine: 'basic', description: 'The everyday Basic profile: 0.20 mm layers.' },
  { id: 'draft', label: 'Draft 0.28', engine: 'basic', description: 'Fast Basic draft: 0.28 mm layers, fewer top and bottom layers.' },
];

/** Pure match used by the hook (exported for tests). */
export function activeIntentPreset(): string | null {
  const a = useAdvanced.getState(), s = useStore.getState();
  for (const p of INTENT_PRESETS) {
    const t = PRESET_TARGETS[p.id];
    if (s.presetId !== t.processPreset || a.engineMode !== p.engine) continue;
    if (p.engine === 'advanced') {
      if (a.intent !== t.intent) continue;
      if (t.weave !== undefined && !!mx.weave.enabled !== t.weave) continue;
    }
    return p.id;
  }
  return null;
}
/** Id of the preset the current settings match, or null when edited away from all of them. */
export function useActiveIntentPreset(): string | null {
  useStore((s) => s.presetId);
  useAdvanced((a) => a.engineMode + a.intent);
  useMx();
  return activeIntentPreset();
}
export function applyIntentPreset(id: string): void {
  const p = INTENT_PRESETS.find((x) => x.id === id), t = PRESET_TARGETS[id];
  if (!p || !t) return;
  const a = useAdvanced.getState(), s = useStore.getState();
  // same actions as the mode toggle and the process preset select; the advanced store marks the slice dirty itself
  // a woven print is judged by its colours: no analysis heat-map painted over the model
  a.set(p.engine === 'advanced' ? { engineMode: 'advanced', intent: t.intent!, ...(t.weave ? { heatmap: false } : {}) } : { engineMode: 'basic' });
  if (s.presetId !== t.processPreset) { s.set({ presetId: t.processPreset }); s.markDirty(); }
  if (t.weave) {
    // the weave needs a picture, so it is not switched on blindly: open Motionex where Weave lives
    if (!s.plugins.includes('motionex')) s.set({ plugins: [...s.plugins, 'motionex'] });
    const st = useStore.getState();
    st.set({ dock: { ...st.dock, open: true, tab: 'motionex' } });
    if (!mx.weave.enabled) st.set({ toast: { kind: 'info', text: 'Woven picture: turn on Weave in the Motionex panel and choose a picture.' } });
  }
}

export interface ObjectEffect {
  id: string;
  pluginId: string;
  /** Short badge text, e.g. "Mx". */
  badge: string;
  label: string;
  /** One-line mono summary, e.g. "koi-pond · 3 col · 1.2 mm". */
  detail: string;
  enabled: boolean;
  status: 'ok' | 'warn' | 'error';
}

const mxReport = (): { check?: PrintCheck } | undefined => useStore.getState().slice.result?.pluginReports?.motionex as { check?: PrintCheck } | undefined;
const fmtMm = (n: number) => `${+n.toFixed(2)} mm`;
/** Weave was switched off from the effects stack this session: keep listing it so it can be switched back on. */
let weaveMuted = false;

/** Does a Motionex placement reach this object? Body = every object; faces = its surface set painted on it, or one of its Patternex regions. */
function appOnObject(a: MotionApplication, o: { id: string; paint?: { motion?: Uint8Array }; patternex?: { placements: { id: string }[] } }): boolean {
  if (a.target.type === 'body') return true;
  const faces = a.target.faces ?? [];
  const region = faces.filter((f) => f.includes(':'));
  if (region.length) return region.some((f) => f.startsWith(`${o.id}:`) || (o.patternex?.placements ?? []).some((p) => f.startsWith(`${p.id}:`)));
  const n = surfaceOf(a);
  return !!o.paint?.motion?.includes(n);
}

/** Plain (non-hook) enumeration, exported for tests. */
export function objectEffects(objectId: string | null): ObjectEffect[] {
  if (!objectId) return [];
  const s = useStore.getState();
  const o = s.objects.find((x) => x.id === objectId);
  if (!o) return [];
  const out: ObjectEffect[] = [];
  const cl = clearanceStatus();
  const mxStatus: ObjectEffect['status'] = cl.state === 'collision' ? 'error' : cl.state === 'warn' ? 'warn' : 'ok';
  if (s.plugins.includes('motionex')) {
    mx.applications.forEach((a, k) => {
      if (!appOnObject(a, o)) return;
      const b = brushOf(a);
      out.push({
        id: `mx:app:${k}`, pluginId: 'motionex', badge: 'Mx', label: a.label || b?.name || a.brush_id,
        detail: [a.target.type === 'body' ? 'whole body' : `surface ${a.target.faces?.some((f) => f.includes(':')) ? 'region' : surfaceOf(a)}`, `${a.target.walls} wall`, `×${+(a.scale ?? 1).toFixed(2)}`, ...(b ? [fmtMm(b.amplitude * (a.scale ?? 1))] : [])].join(' · '),
        enabled: a.enabled, status: a.enabled ? mxStatus : 'ok',
      });
    });
    if (mx.weave.enabled || weaveMuted) {
      const w = mx.weave, pic = w.picture?.kind === 'none' ? 'no picture' : w.image.name ?? 'picture';
      const tex = w.wave?.enabled ? WAVE_PRESETS.find((p) => p.id === presetOf(w.wave))?.name ?? 'custom texture' : '';
      out.push({
        id: 'mx:weave', pluginId: 'motionex', badge: 'Mx', label: `Weave · ${tex && w.picture?.kind === 'none' ? tex : pic}`,
        detail: [w.mode, `${w.slots.length} col`, ...(w.picture?.kind === 'none' ? [] : [fmtMm(w.depth_mm)]), ...(tex ? [`${tex} ${fmtMm(w.wave!.height_mm)}`] : [])].join(' · '), enabled: w.enabled, status: w.enabled ? mxStatus : 'ok',
      });
    }
  }
  if (s.plugins.includes('patternex')) {
    for (const p of px.placements.filter((x) => x.object_id === o.id)) {
      const pat = px.patterns.find((x) => x.id === p.pattern_id);
      out.push({
        id: `px:${p.id}`, pluginId: 'patternex', badge: 'Px', label: pat?.name ?? 'Artwork',
        detail: `${p.projection} · ${p.through ? 'through' : p.depth_mode === 'fixed' ? fmtMm(p.depth_mm) : p.depth_mode.replace(/_/g, ' ')}`,
        enabled: p.visible, status: 'ok',
      });
    }
  }
  // Plantex / Lumonex / Clickex / Flenex build ordinary objects on the plate: nothing object-scoped to list.
  return out;
}
/** Plugin effects placed on an object (Motionex placements/weave, Patternex regions, …). */
export function useObjectEffects(objectId: string | null): ObjectEffect[] {
  useStore((s) => s.objects); useStore((s) => s.plugins); useStore((s) => s.slice.result);
  useMx(); usePatternex();
  return objectEffects(objectId);
}
export function setEffectEnabled(_objectId: string, effectId: string, on: boolean): void {
  // Motionex placements and Weave carry `enabled`; Patternex placements carry `visible` (engine, resolve and
  // motion apps all skip invisible placements). Motionex placements are shared across objects (body / surface set),
  // so switching one affects every object it reaches.
  if (effectId === 'mx:weave') { mx.weave.enabled = on; weaveMuted = !on; mxChanged(); return; }
  if (effectId.startsWith('mx:app:')) { const a = mx.applications[Number(effectId.slice(7))]; if (a) { a.enabled = on; mxChanged(); } return; }
  if (effectId.startsWith('px:')) { const p = px.placements.find((x) => x.id === effectId.slice(3)); if (p) { p.visible = on; pxChanged(); } }
}
/** Opens the owning plugin's panel in the plugin dock, focused on this effect. */
export function openEffect(objectId: string, effectId: string): void {
  const s = useStore.getState();
  const tab = effectId.startsWith('px:') ? 'patternex' : 'motionex';
  s.set({ dock: { ...s.dock, open: true, tab }, selected: [objectId] });
  // Patternex has a selected placement; the Motionex panel has no external selection, so only the tab opens
  if (tab === 'patternex') { px.selected = effectId.slice(3); pxChanged(false); }
}

export interface ClearanceStatus {
  state: 'none' | 'ok' | 'warn' | 'collision';
  message: string;
  /** First / last affected layer, when known. */
  layers?: [number, number];
  canAutoFix: boolean;
  /** The scene changed since the slice the check came from (slice again to re-check). */
  stale?: boolean;
}
/** Read from the Motionex print check of the last slice (engine.ts checkCollisions; same source as the panel's Report and exportGcode). */
export function clearanceStatus(): ClearanceStatus {
  const s = useStore.getState();
  const c = mxReport()?.check;
  if (!c) return { state: 'none', message: '', canAutoFix: false };
  const isStale = s.slice.dirty || s.slice.plate !== s.activePlate;
  const stale = isStale ? ' (out of date — slice again)' : '';
  const ls = c.collisions.map((p) => p.layer).filter((l) => Number.isFinite(l));
  const layers: [number, number] | undefined = ls.length ? [Math.min(...ls), Math.max(...ls)] : undefined;
  const fixable = mx.applications.some((a) => a.enabled) || mx.weave.enabled;
  if (!c.collisionCount) return { state: 'ok', message: `Print head stays clear of the print${stale}`, canAutoFix: false, stale: isStale };
  if (c.blocking) return { state: 'collision', message: `Print head would hit the print in ${c.collisionCount} spots — export stopped${stale}`, layers, canAutoFix: fixable, stale: isStale };
  return { state: 'warn', message: `Print head would hit the print in ${c.collisionCount} spots (lowered automatically)${stale}`, layers, canAutoFix: fixable, stale: isStale };
}
export function useClearanceStatus(): ClearanceStatus {
  useStore((s) => s.slice.result); useStore((s) => s.slice.dirty); useMx();
  return clearanceStatus();
}
/** Share each fix keeps of the wave size / weave depth. */
const FIX_FACTOR = 0.7;
/** Smallest motion size / weave depth (mm) Auto-fix lowers to. */
const FIX_MIN_SCALE = 0.05, FIX_MIN_DEPTH = 0.02;
/** Most lower-and-re-check rounds one Auto-fix click runs (0.7^8 ≈ 6 % of the original size). */
const FIX_MAX_STEPS = 8;
/**
 * One fix step: lowers every enabled motion / the weave by FIX_FACTOR (down to a floor) and reports what changed.
 * Returns null when there is nothing to fix or everything is already at the floor. Marks the slice dirty.
 */
export function autoFixClearance(): string | null {
  const st = clearanceStatus();
  if (!st.canAutoFix || st.state === 'none' || st.state === 'ok') return null;
  const parts: string[] = [];
  const apps = mx.applications.filter((a) => a.enabled && (a.scale ?? 1) > FIX_MIN_SCALE);
  for (const a of apps) a.scale = +Math.max(FIX_MIN_SCALE, (a.scale ?? 1) * FIX_FACTOR).toFixed(3);
  if (apps.length) {
    const sizes = [...new Set(apps.map((a) => `${Math.round((a.scale ?? 1) * 100)}%`))];
    parts.push(`${apps.length} motion${apps.length > 1 ? 's' : ''} to ${sizes.join('/')} size`);
  }
  if (mx.weave.enabled && mx.weave.depth_mm > FIX_MIN_DEPTH) {
    const before = mx.weave.depth_mm;
    mx.weave.depth_mm = +Math.max(FIX_MIN_DEPTH, before * FIX_FACTOR).toFixed(3);
    parts.push(`weave depth ${before} → ${mx.weave.depth_mm} mm`);
  }
  if (!parts.length) return null;
  mxChanged(); // marks the slice dirty: the check runs again on the next slice
  return `Lowered ${parts.join(' and ')}.`;
}
let fixing = false;
/**
 * Auto-fix: lowers the motions / weave one step, slices again (the slice runs the same Motionex print check as
 * export) and repeats until the print head stays clear, the floor is reached or FIX_MAX_STEPS rounds have run.
 * Returns the message it also shows as a toast.
 */
export async function autoFixUntilClear(slice?: () => Promise<unknown>): Promise<string | null> {
  if (fixing) return null;
  fixing = true;
  const run = slice ?? (async () => (await import('./actions')).sliceAndPreview());
  let last: string | null = null, steps = 0;
  try {
    for (; steps < FIX_MAX_STEPS; steps++) {
      if (clearanceStatus().state !== 'collision') break;
      let msg = autoFixClearance();
      if (!msg && mx.collisionMode === 'fail') {
        // Already at the smallest size and still hitting (e.g. a motion that dips into the layer below by design):
        // let Motionex lower the moves at the remaining spots itself instead of stopping export.
        mx.collisionMode = 'clamp'; mxChanged();
        msg = 'Already at the smallest size, so the remaining spots are now lowered automatically (collision mode "clamp").';
      }
      if (!msg) break;
      last = msg;
      useStore.getState().set({ toast: { kind: 'info', text: `Auto-fix: ${msg} Checking clearance…` } });
      await run();
      const s = useStore.getState().slice;
      if (s.status !== 'done' || s.dirty) break; // slice failed or was replaced
    }
  } finally { fixing = false; }
  if (!last) return null;
  const st = clearanceStatus();
  const text = st.state === 'collision'
    ? `Auto-fix: ${last} The print head still hits the print${steps >= FIX_MAX_STEPS ? ' — press Auto-fix again or' : ' —'} lower the motion by hand.`
    : `Auto-fix: ${last} Print head now clears the print.`;
  useStore.getState().set({ toast: { kind: st.state === 'collision' ? 'error' : 'info', text } });
  return text;
}

export interface SliceSummary {
  status: 'empty' | 'idle' | 'slicing' | 'done' | 'error';
  progress: number;
  time?: string;
  weight?: string;
  cost?: string;
  layers?: string;
  /** Filament / tool changes, only when the print uses more than one filament. */
  changes?: string;
  /** True when a valid slice for the active plate matches the scene (Export enabled). */
  ready: boolean;
}
/** Same format as fmtTime in ui/PreviewOverlays (kept here so state code does not import UI). */
export const fmtTime = (s: number) => {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.round(s % 60);
  return h ? `${h}h ${m}m` : m ? `${m}m ${sec}s` : `${sec}s`;
};
/** Plain (non-hook) summary, exported for tests. */
export function sliceSummary(): SliceSummary {
  const s = useStore.getState(), sl = s.slice;
  const hasProgram = !!s.plates[s.activePlate]?.program;
  if (!s.objects.length && !hasProgram && sl.status !== 'slicing') return { status: 'empty', progress: 0, ready: false };
  if (sl.status === 'slicing') return { status: 'slicing', progress: sl.progress, ready: false };
  if (sl.status === 'error') return { status: 'error', progress: 0, ready: false };
  const r = sl.result;
  if (sl.status === 'done' && r) {
    const st = r.stats;
    const fresh = !sl.dirty && sl.plate === s.activePlate;
    return {
      status: fresh ? 'done' : 'idle', progress: 1,
      time: fmtTime(st.repeat ? st.repeat.totalSeconds : st.timeSeconds),
      weight: `${(st.repeat ? st.repeat.totalGrams : st.filamentGrams).toFixed(1)} g`,
      layers: String(st.layerCount),
      changes: st.toolChanges > 0 || (st.perFilament ?? []).filter((f) => f.mm > 0.01).length > 1 ? String(st.toolChanges) : undefined,
      cost: (st.repeat ? st.repeat.totalCost : st.filamentCost).toFixed(2),
      // a blocking print-head collision stops export (same rule as exportGcode)
      ready: fresh && clearanceStatus().state !== 'collision',
    };
  }
  return { status: 'idle', progress: 0, ready: false };
}
export function useSliceSummary(): SliceSummary {
  useStore((s) => s.slice); useStore((s) => s.objects.length); useStore((s) => s.activePlate);
  return sliceSummary();
}

export interface PaletteItem {
  id: string;
  section: 'Settings' | 'Tools' | 'Plugins & effects' | 'Physics Core' | 'Actions';
  label: string;
  hint?: string;
  value?: string;
  run: () => void;
}

/** The Prepare edit tools (Fill bed opens its dialog on the selected object). */
const TOOLS: [Tool, string, string?][] = [
  ['cut', 'Cut', 'C'], ['boolean', 'Boolean', 'B'], ['text', 'Text / SVG', 'T'], ['measure', 'Measure', 'U'], ['edges', 'Edges', 'G'],
  ['paint_support', 'Support paint', 'L'], ['paint_seam', 'Seam paint', 'P'], ['paint_color', 'Colour paint', 'N'], ['paint_adv', 'Advanced paint'],
  ['vlh', 'Variable layer height', 'H'], ['brim_ears', 'Brim ears', 'E'],
  ['move', 'Move', 'M'], ['rotate', 'Rotate', 'R'], ['scale', 'Scale', 'S'], ['face', 'Lay on face', 'F'],
];

const fmtVal = (v: unknown) => (v === undefined ? undefined : typeof v === 'boolean' ? (v ? 'on' : 'off') : String(v));

/** Everything Ctrl+K can find: process params (jump + pin), tools, plugin actions, advanced techs, global actions. */
export function paletteItems(): PaletteItem[] {
  const s = useStore.getState(), a = useAdvanced.getState(), ui = useUi.getState();
  const close = () => useUi.getState().set({ paletteOpen: false });
  const items: PaletteItem[] = [];
  for (const p of PROCESS_PARAMS) {
    const pinned = ui.pinnedParams.includes(p.key);
    items.push({
      id: `param:${p.key}`, section: 'Settings', label: p.label === p.group ? p.label : `${p.group} · ${p.label}`, hint: p.tab,
      value: fmtVal(s.overrides[p.key] ?? p.def),
      run: () => {
        const st = useStore.getState();
        st.set({ workspace: st.workspace === 'prepare' ? st.workspace : 'prepare', processTab: p.tab as ProcessTab, search: p.label, ...(p.advanced ? { showAdvanced: true } : {}) });
        useUi.getState().set({ inspectorCtx: 'plate' });
        close();
      },
    });
    items.push({ id: `pin:${p.key}`, section: 'Settings', label: `${pinned ? 'Unpin' : 'Pin'} ${p.label}`, hint: p.tab, run: () => { useUi.getState().togglePinParam(p.key); close(); } });
  }
  for (const [tool, label, kbd] of TOOLS) items.push({ id: `tool:${tool}`, section: 'Tools', label, hint: kbd, run: () => { useStore.getState().set({ workspace: 'prepare', tool }); close(); } });
  items.push({ id: 'tool:fill_bed', section: 'Tools', label: 'Fill bed with copies', run: () => {
    const id = useStore.getState().selected[0];
    close();
    if (!id) { useStore.getState().set({ toast: { kind: 'info', text: 'Select an object first, then Fill bed.' } }); return; }
    void import('../ui/FillBedDialog').then((m) => m.openFillBed(id));
  } });
  for (const p of PLUGINS) {
    const installed = s.plugins.includes(p.id);
    items.push({ id: `plugin:${p.id}`, section: 'Plugins & effects', label: installed ? `Open ${p.name}` : `Install ${p.name}`, hint: p.description, run: () => {
      const st = useStore.getState();
      st.set({ plugins: st.plugins.includes(p.id) ? st.plugins : [...st.plugins, p.id], dock: { ...st.dock, open: true, tab: p.id } });
      close();
    } });
  }
  for (const t of TECHS) {
    const on = a.techs[t.id]?.enabled ?? t.intents.includes(a.intent);
    items.push({ id: `tech:${t.id}`, section: 'Physics Core', label: `${on ? 'Turn off' : 'Turn on'} ${t.name}`, hint: t.technique, value: on ? 'on' : 'off', run: () => {
      if (useAdvanced.getState().engineMode !== 'advanced') useAdvanced.getState().set({ engineMode: 'advanced' });
      setTech(t.id, { enabled: !on });
      close();
    } });
  }
  const act = (id: string, label: string, hint: string | undefined, run: () => void) => items.push({ id: `action:${id}`, section: 'Actions', label, hint, run: () => { close(); run(); } });
  act('repair', 'Fix model (close holes, repair mesh errors)', 'selection or all', () => void import('./meshTools').then((m) => m.repairObjects()));
  act('slice', 'Slice plate', 'Ctrl+R', () => void import('./actions').then((m) => m.sliceAndPreview()));
  act('slice-all', 'Slice all plates', '', () => void import('./actions').then((m) => m.sliceAllPlates()));
  act('export', 'Export G-code', 'Ctrl+G', () => {
    if (!sliceSummary().ready) { useStore.getState().set({ toast: { kind: 'info', text: clearanceStatus().state === 'collision' ? clearanceStatus().message : 'Slice the plate first (Ctrl+R), then export or print it.' } }); return; }
    void import('./actions').then((m) => m.exportGcode());
  });
  act('print', 'Print plate', 'Ctrl+P', () => {
    if (!sliceSummary().ready) { useStore.getState().set({ toast: { kind: 'info', text: 'Slice the plate first (Ctrl+R), then export or print it.' } }); return; }
    void import('../ui/PrintModal').then((m) => m.openPrintDialog());
  });
  act('import', 'Import model…', 'Ctrl+I', () => void import('./actions').then((m) => m.importDialog()));
  act('open', 'Open project…', 'Ctrl+O', () => void import('./project').then((m) => m.openProjectDialog()));
  act('save', 'Save project', 'Ctrl+S', () => void import('./project').then((m) => m.saveProject()));
  act('undo', 'Undo', 'Ctrl+Z', () => useStore.getState().undo());
  act('redo', 'Redo', 'Ctrl+Y', () => useStore.getState().redo());
  act('theme', `Switch to ${s.theme === 'dark' ? 'light' : 'dark'} theme`, undefined, () => { const st = useStore.getState(); st.set({ theme: st.theme === 'dark' ? 'light' : 'dark' }); });
  act('engine', `Switch to ${a.engineMode === 'advanced' ? 'Basic' : 'Advanced'} engine`, undefined, () => { const ad = useAdvanced.getState(); ad.set({ engineMode: ad.engineMode === 'advanced' ? 'basic' : 'advanced' }); });
  for (const p of INTENT_PRESETS) act(`preset:${p.id}`, `Preset: ${p.label}`, p.description, () => applyIntentPreset(p.id));
  return items;
}
