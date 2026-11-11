// Patternex panel in Nexspiro's right dock: import or pick a pattern, click the model to place it,
// set what happens inside each colour region, and read the pre-export report after slicing.
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import * as THREE from 'three';
import { useStore, objectMatrix, plateOrigin } from '../../../state/store';
import { plateObjects } from '../../../state/slicing';
import { printerById } from '../../../profiles/printers';
import { parseSvg } from '../svg';
import { BUILTIN_KINDS } from '../builtin';
import { colorGroups, type PurgeMode, type RegionAction } from '../model';
import { DEFAULT_TRANSITION_VOLUME, type PatternexConfig, type PatternexReport, type SingleColourPolicy } from '../engine';
import { addPattern, collectPlacements, createPatternexState, patternInkKey, splitByObject, ensureBuiltin, savePatternexState, toPatternexConfig, type ObjPlacement, type PatternexState } from './state';
import type { MotionApplication } from '../../motionex/model';
import { mx } from '../../motionex/ui/MotionexPanel';
import { LibraryWindow } from '../library/LibraryWindow';
import { GROUP_KEYS, GROUP_NAMES, libraryCounts } from '../library/catalog';
import { CreatePanel } from './CreatePanel';
import { Calibration } from './Calibration';
import { autoChanges } from '../../../profiles/changer';

const storage = typeof localStorage !== 'undefined' ? localStorage : null;
export const px: PatternexState = createPatternexState(storage);

let version = 0;
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => { listeners.add(l); return () => listeners.delete(l); };
const notify = () => {
  version++;
  listeners.forEach((l) => l());
  if (typeof window !== 'undefined') { window.dispatchEvent(new Event('nx-patternex')); window.dispatchEvent(new Event('nx-plugin-preview')); }
};

/**
 * Placements and region actions live on the scene objects (`SceneObject.patternex`): undo/redo,
 * project files, delete, clone, mirror and split all carry them. `px.placements` / `px.actions` are a
 * working copy the panel edits; `changed()` writes it back, and any change to the objects re-reads it.
 */
let writing = false;
function pull(): void {
  const objs = useStore.getState().objects;
  const { placements, actions, patterns, renamed } = collectPlacements(objs);
  for (const pat of patterns) if (!px.patterns.some((x) => x.id === pat.id)) addPattern(px, pat);
  px.placements = placements;
  px.actions = actions;
  if (px.selected && !placements.some((p) => p.id === px.selected)) px.selected = null;
  // copies got unique ids: store them so later edits address the right placement (not an undo step)
  if (renamed) push(false);
}
function push(record: boolean): void {
  const s = useStore.getState();
  const by = splitByObject(px.placements, px.actions, px.patterns);
  const ids = s.objects.filter((o) => by.has(o.id) || o.patternex).map((o) => o.id);
  if (!ids.length) return;
  writing = true;
  try { s.updateObjects((o) => ({ ...o, patternex: by.get(o.id) }), ids, record); }
  finally { writing = false; }
}
useStore.subscribe((s, prev) => {
  if (s.objects === prev.objects || writing) return;
  pull();
  notify();
});

/** Call after editing `px`. `dirty` = the change affects slicing (and is recorded for undo). */
export function changed(dirty = true, record = dirty): void {
  if (dirty) push(record);
  savePatternexState(px, storage);
  notify();
}
export const usePatternex = () => useSyncExternalStore(subscribe, () => version);

/** Objects of the slicing plate with object → plate matrices, in the order the slicer receives them. */
export function sliceObjects() {
  const s = useStore.getState();
  const [ox, oy] = plateOrigin(s.activePlate, s.printerId);
  const toPlate = new THREE.Matrix4().makeTranslation(-ox, -oy, 0);
  // same objects, same order as the slicer receives them (non-printable objects are not sliced)
  return plateObjects(s.activePlate).filter((o) => o.printable !== false).map((o) => ({ id: o.id, matrix: toPlate.clone().multiply(objectMatrix(o)).elements }));
}

export function patternexConfig(): PatternexConfig | undefined {
  const c = toPatternexConfig(px, sliceObjects());
  if (!c) return c;
  // regions a Motionex motion is aimed at are shared even when not inked
  const targets = useStore.getState().plugins.includes('motionex')
    ? mx.applications.filter((a) => a.enabled && a.target.type === 'faces').flatMap((a) => (a.target.faces ?? []).filter((f) => f.includes(':')))
    : [];
  return targets.length ? { ...c, motionTargets: [...new Set(targets)] } : c;
}

/** Motionex applications for regions that carry a motion (spec §8: Patternex passes the region id as the target). */
export function patternexMotionApps(): MotionApplication[] {
  const visible = new Set(px.placements.filter((p) => p.visible).map((p) => p.id));
  return px.actions.filter((a) => a.motion && visible.has(a.region_ref.placement_id)).map((a, k) => ({
    brush_id: a.motion!.motionex_brush_id,
    target: { type: 'faces', walls: 'outer', faces: [`${a.region_ref.placement_id}:${a.region_ref.color_group ?? ''}`] },
    mask: { z_start: 0, z_end: 1e4, fade_in_mm: 0, fade_out_mm: 0 },
    order: 1000 + k, blend: 'add', enabled: true,
  }));
}

/** Open the dock on Patternex and the pattern library (from the right-click menu). */
export function openPatternLibrary(): void {
  const s = useStore.getState();
  s.set({ dock: { ...s.dock, open: true, tab: 'patternex' } });
  // the panel may mount on this tab switch; let it subscribe first
  setTimeout(() => window.dispatchEvent(new Event('nx-patternex-library')), 60);
}

/** Show an object's artwork in the panel: select its first placement. */
export function editObjectArtwork(objectId: string): void {
  const s = useStore.getState();
  s.set({ dock: { ...s.dock, open: true, tab: 'patternex' }, selected: [objectId] });
  const p = px.placements.find((x) => x.object_id === objectId);
  if (p) { px.selected = p.id; changed(false); }
}

const PURGE: [PurgeMode, string][] = [['full', 'Full purge'], ['reduced', 'Reduced'], ['none', 'No purge (bleed)']];
const POLICY: [SingleColourPolicy, string][] = [['skip', 'Leave in base colour (warn)'], ['band', 'Colour whole layers (bands)'], ['allow', 'Allow mid-layer swaps']];

export function PatternexPanel() {
  usePatternex();
  const { printerId, filaments, tool, set } = useStore();
  const ams = autoChanges(printerById(printerId).machine);
  const sel = px.placements.find((p) => p.id === px.selected) ?? null;
  return (
    <div className="mx-panel">
      <div className="mx-head">
        <span className="mx-badge">P</span>
        <div><div className="mx-title">Patternex</div><div className="mx-sub">Artwork on the surface, a material change inside it</div></div>
      </div>
      <Patterns />
      <CreatePanel />
      <section className="mx-card">
        <div className="mx-card-title">Placements<span className="spacer" />
          {tool === 'place_pattern' && <button className="btn-secondary btn-small" onClick={() => { px.armed = null; px.brush.active = false; set({ tool: 'select' }); changed(false); }}>Done</button>}
        </div>
        {px.armed && <p className="mx-muted">Click (or drag across) the model to place <b>{px.patterns.find((p) => p.id === px.armed)?.name}</b>. It snaps to the face under the cursor.</p>}
        {!px.placements.length && !px.armed && <p className="mx-muted">Pick a pattern above, then click the model.</p>}
        {px.placements.map((p) => <PlacementRow key={p.id} p={p} />)}
      </section>
      {sel && <PlacementEditor p={sel} slots={filaments.map((f) => f.color)} ams={ams} />}
      <section className="mx-card">
        <div className="mx-card-title">Printer · {ams ? 'AMS (automatic changes)' : 'single colour (stop and swap)'}</div>
        {!ams && (
          <label className="mx-field">Regions that need a swap mid-layer
            <select className="select" value={px.singleColour} onChange={(e) => { px.singleColour = e.target.value as SingleColourPolicy; changed(); }}>
              {POLICY.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
        )}
        <div className="mx-label">Transition volume for no-purge bleed (mm³)</div>
        {filaments.map((f, k) => (
          <label key={k} className="mx-field px-row">
            <span className="px-swatch" style={{ background: f.color }} />Slot {k + 1}
            <input className="input" type="number" min={1} step={1} placeholder={`${DEFAULT_TRANSITION_VOLUME} (estimate)`} value={px.transitionVolume[k] ?? ''}
              onChange={(e) => { const v = e.target.value === '' ? null : Math.max(1, Number(e.target.value)); px.transitionVolume[k] = v; changed(); }} />
            {px.transitionVolume[k] == null && <span className="px-tag">uncalibrated</span>}
          </label>
        ))}
        <Calibration />
        {ams && (
          <>
            <label className="mx-field">Purge of full / reduced changes
              <select className="select" value={px.purgeTarget} onChange={(e) => { px.purgeTarget = e.target.value as typeof px.purgeTarget; changed(); }}>
                <option value="tower">Prime tower</option>
                <option value="infill">Into the new filament's infill first</option>
                <option value="object">Into a sacrificial object first</option>
              </select>
            </label>
            {px.purgeTarget === 'object' && (
              <label className="mx-field">Purge object
                <select className="select" value={px.purgeObjectId ?? ''} onChange={(e) => { px.purgeObjectId = e.target.value || null; changed(); }}>
                  <option value="">Pick an object…</option>
                  {useStore.getState().objects.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                </select>
              </label>
            )}
            {px.purgeTarget !== 'tower' && <p className="mx-muted">The tower purge shrinks by what the new filament can print there; those moves are printed first, so the mixed colour lands inside, not on the surface.</p>}
          </>
        )}
        {!ams && px.singleColour === 'band' && (
          <label className="mx-field">Merge bands: fill base gaps shorter than (layers)
            <input className="input" type="number" min={0} step={1} value={px.swapMergeLayers} onChange={(e) => { px.swapMergeLayers = Math.max(0, Math.round(Number(e.target.value) || 0)); changed(); }} />
          </label>
        )}
      </section>
      <Report />
    </div>
  );
}

function Patterns() {
  const file = useRef<HTMLInputElement>(null);
  const [tol, setTol] = useState(0.05);
  const [autoClose, setAutoClose] = useState(false);
  const [msg, setMsg] = useState<string[]>([]);
  const [lib, setLib] = useState(false);
  useEffect(() => { const on = () => setLib(true); window.addEventListener('nx-patternex-library', on); return () => window.removeEventListener('nx-patternex-library', on); }, []);
  const arm = (id: string) => { px.armed = id; useStore.getState().set({ tool: 'place_pattern', workspace: 'prepare' }); changed(false); };
  const onFile = async (f: File) => {
    const text = await f.text();
    const { pattern, warnings } = parseSvg(text, { name: f.name.replace(/\.svg$/i, ''), tolerance_mm: tol, autoClose });
    setMsg(warnings);
    if (!pattern.shapes.length) return;
    addPattern(px, pattern);
    arm(pattern.id);
  };
  return (
    <section className="mx-card">
      <div className="mx-card-title">Patterns<span className="spacer" />
        <button className="btn-secondary btn-small" onClick={() => file.current?.click()}>Import SVG…</button>
        <input ref={file} type="file" accept=".svg,image/svg+xml" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFile(f); e.target.value = ''; }} />
      </div>
      <button className="btn-primary pxl-open" onClick={() => setLib(true)}>Open pattern library · {libraryCounts().All.toLocaleString()} patterns</button>
      {lib && <LibraryWindow onClose={() => setLib(false)} />}
      <div className="mx-two">
        <label className="mx-field">Curve tolerance (mm)<input className="input" type="number" min={0.005} step={0.01} value={tol} onChange={(e) => setTol(Math.max(0.005, Number(e.target.value) || 0.05))} /></label>
        <label className="mx-field px-check"><input type="checkbox" checked={autoClose} onChange={(e) => setAutoClose(e.target.checked)} />Auto-close open paths</label>
      </div>
      {msg.map((m, i) => <p key={i} className="mx-muted px-warn">{m}</p>)}
      <div className="mx-label">Built in</div>
      <div className="mx-chips">
        {BUILTIN_KINDS.map((k) => <button key={k} className="btn-secondary btn-small" onClick={() => arm(ensureBuiltin(px, k).id)}>{k}</button>)}
      </div>
      {px.patterns.filter((p) => p.source === 'svg').length > 0 && <div className="mx-label">Imported</div>}
      <div className="mx-chips">
        {px.patterns.filter((p) => p.source === 'svg').map((p) => (
          <button key={p.id} className={`btn-secondary btn-small ${px.armed === p.id ? 'on' : ''}`} title={`${p.shapes.length} shapes · ${(p.bounds[2] - p.bounds[0]).toFixed(1)} × ${(p.bounds[3] - p.bounds[1]).toFixed(1)} mm`} onClick={() => arm(p.id)}>{p.name}</button>
        ))}
      </div>
    </section>
  );
}

function PlacementRow({ p }: { p: ObjPlacement }) {
  const pat = px.patterns.find((x) => x.id === p.pattern_id);
  const obj = useStore.getState().objects.find((o) => o.id === p.object_id);
  const upd = (fn: () => void, dirty = true) => { fn(); changed(dirty); };
  return (
    <div className={`px-place ${px.selected === p.id ? 'on' : ''}`} onClick={() => upd(() => { px.selected = p.id; }, false)}>
      <span className="px-name">{pat?.name ?? p.pattern_id}<span className="mx-muted"> on {obj?.name ?? 'missing object'}</span></span>
      <button className="btn-secondary btn-small" onClick={(e) => { e.stopPropagation(); upd(() => { p.visible = !p.visible; }); }}>{p.visible ? 'Hide' : 'Show'}</button>
      <button className="btn-secondary btn-small" onClick={(e) => { e.stopPropagation(); upd(() => { p.locked = !p.locked; }, false); }}>{p.locked ? 'Unlock' : 'Lock'}</button>
      <button className="btn-secondary btn-small" onClick={(e) => { e.stopPropagation(); upd(() => {
        px.placements = px.placements.filter((x) => x !== p);
        px.actions = px.actions.filter((a) => a.region_ref.placement_id !== p.id);
        if (px.selected === p.id) px.selected = null;
      }); }}>Remove</button>
    </div>
  );
}

function PlacementEditor({ p, slots, ams }: { p: ObjPlacement; slots: string[]; ams: boolean }) {
  const pat = px.patterns.find((x) => x.id === p.pattern_id);
  const [lockScale, setLockScale] = useState(true);
  const upd = (fn: () => void) => { if (p.locked) return; fn(); changed(); };
  const num = (v: string, d: number) => (Number.isFinite(Number(v)) && v !== '' ? Number(v) : d);
  const groups = pat ? [...colorGroups(pat).keys()] : [];
  const motionOn = useStore.getState().plugins.includes('motionex');
  const brushes = mx.library.all();
  const actionFor = (color: string): RegionAction | undefined => px.actions.find((a) => a.region_ref.placement_id === p.id && a.region_ref.color_group === color);
  const setAction = (color: string, fn: (a: RegionAction) => void) => {
    let a = actionFor(color);
    if (!a) { a = { region_ref: { placement_id: p.id, color_group: color }, material: { mode: ams ? 'slot' : 'manual', slot_index: Math.min(1, slots.length - 1) }, purge: { mode: 'full', change_point_shift_mm: 0 }, motion: null }; px.actions.push(a); }
    fn(a);
    changed();
  };
  const w = pat ? (pat.bounds[2] - pat.bounds[0]) * p.scale_xy[0] : 0, h = pat ? (pat.bounds[3] - pat.bounds[1]) * p.scale_xy[1] : 0;
  return (
    <section className="mx-card">
      <div className="mx-card-title">{pat?.name ?? 'Placement'} · {w.toFixed(1)} × {h.toFixed(1)} mm{p.locked && <span className="px-tag">locked</span>}</div>
      <div className="mx-label">Projection</div>
      <div className="seg mx-seg">
        {(['planar', 'cylindrical'] as const).map((k) => (
          <button key={k} className={p.projection === k ? 'on' : ''} onClick={() => upd(() => {
            if (p.projection === k) return;
            p.projection = k;
            // cylinders wrap around the object's vertical centre line (object-local)
            if (k === 'cylindrical') { p.projection_axis = [0, 0, 1]; p.axis_origin = [0, 0, 0]; }
            else p.projection_axis = p.anchor_normal ?? [0, 0, 1];
          })}>{k === 'planar' ? 'Planar' : 'Wrap (cylindrical)'}</button>
        ))}
      </div>
      <div className="mx-two">
        <label className="mx-field">Rotation (°)<input className="input" type="number" step={5} value={p.rotation} onChange={(e) => upd(() => { p.rotation = num(e.target.value, 0); })} /></label>
        <label className="mx-field px-check"><input type="checkbox" checked={p.flip} onChange={(e) => upd(() => { p.flip = e.target.checked; })} />Flip</label>
      </div>
      <div className="mx-two">
        <label className="mx-field">Scale X<input className="input" type="number" step={0.05} min={0.01} value={p.scale_xy[0]} onChange={(e) => upd(() => { const v = Math.max(0.01, num(e.target.value, 1)); p.scale_xy = lockScale ? [v, v] : [v, p.scale_xy[1]]; })} /></label>
        <label className="mx-field">Scale Y<input className="input" type="number" step={0.05} min={0.01} value={p.scale_xy[1]} disabled={lockScale} onChange={(e) => upd(() => { p.scale_xy = [p.scale_xy[0], Math.max(0.01, num(e.target.value, 1))]; })} /></label>
      </div>
      <label className="mx-field px-check"><input type="checkbox" checked={lockScale} onChange={(e) => setLockScale(e.target.checked)} />Uniform scale</label>
      <div className="mx-label">Depth</div>
      <select className="select mx-select" aria-label="Depth" value={p.through ? 'through' : p.depth_mode} onChange={(e) => upd(() => {
        const v = e.target.value;
        if (v === 'through') p.through = true; else { p.depth_mode = v as typeof p.depth_mode; p.through = false; }
      })}>
        {([['outer_wall', 'Outer wall'], ['paint_depth', 'Paint depth'], ['fixed', 'Fixed'], ['through', 'Through']] as const).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
      </select>
      {p.depth_mode === 'fixed' && !p.through && <label className="mx-field">Depth (mm)<input className="input" type="number" min={0.05} step={0.1} value={p.depth_mm} onChange={(e) => upd(() => { p.depth_mm = Math.max(0.05, num(e.target.value, 1.5)); })} /></label>}
      <label className="mx-field">Surface angle filter: up to {p.max_angle ?? 78}° from the projection
        <input type="range" min={5} max={89} step={1} value={p.max_angle ?? 78} onChange={(e) => upd(() => { p.max_angle = Number(e.target.value); })} />
      </label>
      <p className="mx-muted">Place tool: drag to move (snaps to faces) · Shift + drag to rotate · Alt + drag to scale.</p>

      <div className="mx-label">Regions<span className="spacer" />
        <button className="btn-secondary btn-small" title="Keep this artwork with its inks for later" onClick={() => {
          if (!pat) return;
          const inks: Record<string, number> = {};
          for (const a of px.actions) if (a.region_ref.placement_id === p.id && a.region_ref.color_group && a.material.mode !== 'keep') inks[a.region_ref.color_group] = a.material.slot_index;
          const relief = px.actions.find((a) => a.region_ref.placement_id === p.id && a.relief)?.relief ?? null;
          px.brandKit.push({ id: `brand-${Date.now().toString(36)}`, name: pat.name, pattern: structuredClone(pat), inks, relief });
          changed(false);
        }}>Save to brand kit</button>
        <button className="btn-secondary btn-small" title="Every new placement of this pattern starts with these inks" onClick={() => {
          const m: Record<string, number> = {};
          for (const a of px.actions) if (a.region_ref.placement_id === p.id && a.region_ref.color_group) m[a.region_ref.color_group] = a.material.slot_index;
          if (Object.keys(m).length) px.savedInks[patternInkKey(p.pattern_id)] = m; else delete px.savedInks[patternInkKey(p.pattern_id)];
          changed(false);
        }}>{px.savedInks[patternInkKey(p.pattern_id)] ? 'Update saved inks' : 'Save inks for this pattern'}</button>
      </div>
      {slots.length < 2 && <p className="mx-muted px-warn">Only one filament slot is set up. Add slots in the Filament panel to give regions their own material.</p>}
      {groups.map((color) => {
        const a = actionFor(color);
        return (
          <div key={color} className="px-region">
            <div className="px-row"><span className="px-swatch" style={{ background: a ? slots[a.material.slot_index] ?? color : color }} /><b>{GROUP_NAMES[GROUP_KEYS.indexOf(color)] ?? color}</b>
              <span className="spacer" />
              <select className="select" value={a ? (a.material.mode === 'keep' ? -2 : a.material.slot_index) : -1} aria-label="Material" onChange={(e) => {
                const v = Number(e.target.value);
                if (v === -1) { px.actions = px.actions.filter((x) => x !== a); changed(); return; }
                if (v === -2) { setAction(color, (x) => { x.material.mode = 'keep'; x.material.slot_index = 0; if (!x.relief && !x.effects) x.relief = { mode: 'raise', height_mm: 0.6 }; }); return; }
                setAction(color, (x) => { x.material.slot_index = v; x.material.mode = ams ? 'slot' : 'manual'; });
              }}>
                <option value={-1}>Not inked (base)</option>
                <option value={-2}>Base · relief / effects only</option>
                {slots.map((c, k) => <option key={k} value={k}>Ink: slot {k + 1}</option>)}
              </select>
            </div>
            {a && <RegionExtras a={a} slots={slots} ams={ams} set={(fn) => setAction(color, fn)} />}
            {a && a.material.mode !== 'keep' && (
              <>
                {!ams && <label className="mx-field">Swap label<input className="input" placeholder={`Filament ${a.material.slot_index + 1}`} value={a.material.swap_label ?? ''} onChange={(e) => setAction(color, (x) => { x.material.swap_label = e.target.value; })} /></label>}
                <label className="mx-field">Purge
                  <select className="select" value={a.purge.mode} onChange={(e) => setAction(color, (x) => { x.purge.mode = e.target.value as PurgeMode; })}>
                    {PURGE.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                </label>
                {a.purge.mode === 'reduced' && <label className="mx-field">Purge volume (mm³)<input className="input" type="number" min={0} step={5} value={a.purge.volume_mm3 ?? ''} placeholder="half of the matrix" onChange={(e) => setAction(color, (x) => { x.purge.volume_mm3 = e.target.value === '' ? undefined : Math.max(0, Number(e.target.value)); })} /></label>}
                {a.purge.mode === 'none' && <label className="mx-field">Change point shift (mm, + earlier · − later)<input className="input" type="number" step={0.5} value={a.purge.change_point_shift_mm} onChange={(e) => setAction(color, (x) => { x.purge.change_point_shift_mm = num(e.target.value, 0); })} /></label>}
                <label className="mx-field">Motion (Motionex)
                  <select className="select" value={a.motion?.motionex_brush_id ?? ''} disabled={!motionOn} onChange={(e) => setAction(color, (x) => { x.motion = e.target.value ? { motionex_brush_id: e.target.value } : null; })}>
                    <option value="">{motionOn ? 'None' : 'Install Motionex to add motion'}</option>
                    {motionOn && brushes.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                  </select>
                </label>
              </>
            )}
          </div>
        );
      })}
    </section>
  );
}

function Report() {
  usePatternex();
  const { slice, set } = useStore();
  const rep = slice.result?.pluginReports?.patternex as PatternexReport | undefined;
  if (!rep) return null;
  const ov = px.overlays;
  const toggle = (k: keyof typeof ov) => { ov[k] = !ov[k]; changed(false); };
  const jump = (layer: number) => set({ workspace: 'preview', layerRange: [0, layer] });
  return (
    <section className="mx-card">
      <div className="mx-card-title">Pre-export report{slice.dirty ? ' (out of date)' : ''}</div>
      <p className="mx-muted">
        {rep.manual ? `${rep.swaps.length} manual swap(s)` : `${rep.toolChanges} tool change(s)`} · purge {rep.purgeGrams.toFixed(2)} g ({Math.round(rep.purgeMm3)} mm³) · +{Math.round(rep.addedTimeS / 60)} min
        · full {rep.transitions.full} / reduced {rep.transitions.reduced} / none {rep.transitions.none}{rep.shifted ? ` · ${rep.shifted} shifted` : ''}
        {rep.reliefs ? ` · ${rep.reliefs} raised/recessed region(s)` : ''}{rep.purgeAbsorbedMm3 ? ` · ${Math.round(rep.purgeAbsorbedMm3)} mm³ purged into ${px.purgeTarget === 'object' ? 'the purge object' : 'infill'}` : ''}{rep.swapsSaved ? ` · ${rep.swapsSaved} swap(s) saved by merging bands` : ''}
      </p>
      {rep.warnings.map((w, i) => <p key={i} className="mx-muted px-warn">⚠ {w}</p>)}
      {rep.regions.map((r) => <p key={r.id} className="mx-muted"><span className="px-swatch" style={{ background: useStore.getState().filaments[r.fil]?.color ?? r.color }} /> {px.patterns.find((x) => x.id === px.placements.find((q) => q.id === r.placementId)?.pattern_id)?.name ?? r.placementId} · {GROUP_NAMES[GROUP_KEYS.indexOf(r.color)] ?? r.color} → slot {r.fil + 1}, {r.layerCount} layer(s){r.motion ? `, motion ${r.motion}` : ''}</p>)}
      {rep.swaps.length > 0 && (
        <table className="px-table">
          <thead><tr><th>Layer</th><th>Z (mm)</th><th>Load</th></tr></thead>
          <tbody>{rep.swaps.map((sw, i) => <tr key={i} onClick={() => jump(sw.layer)}><td>{sw.layer + 1}</td><td>{sw.z.toFixed(2)}</td><td>{sw.label}</td></tr>)}</tbody>
        </table>
      )}
      <div className="mx-label">Preview overlays</div>
      <div className="mx-chips">
        {(['outlines', 'transitions', 'swaps', 'bleed'] as const).map((k) => <button key={k} className={`btn-secondary btn-small ${ov[k] ? 'on' : ''}`} onClick={() => toggle(k)}>{k}</button>)}
        <button className="btn-secondary btn-small" onClick={() => set({ workspace: 'preview', colorScheme: 'filament' })}>Colour preview</button>
      </div>
    </section>
  );
}

/** Relief, print effects and two-filament mixing for one region. */
function RegionExtras({ a, slots, ams, set }: { a: RegionAction; slots: string[]; ams: boolean; set: (fn: (a: RegionAction) => void) => void }) {
  const ef = a.effects ?? {};
  const fx = (p: Partial<NonNullable<RegionAction['effects']>>) => set((x) => { const e = { ...(x.effects ?? {}), ...p }; x.effects = Object.values(e).some((v) => v !== undefined && v !== false && v !== 1) ? e : null; });
  return (
    <div className="px-extras">
      <div className="mx-two">
        <label className="mx-field">Relief
          <select className="select" value={a.relief?.mode ?? ''} onChange={(e) => set((x) => { x.relief = e.target.value ? { mode: e.target.value as 'raise' | 'recess', height_mm: x.relief?.height_mm ?? 0.6 } : null; })}>
            <option value="">Flat</option><option value="raise">Raised</option><option value="recess">Recessed</option>
          </select>
        </label>
        {a.relief && <label className="mx-field">Height (mm)<input className="input" type="number" min={0.1} max={5} step={0.1} value={a.relief.height_mm} onChange={(e) => set((x) => { x.relief = { ...x.relief!, height_mm: Math.max(0.1, Number(e.target.value) || 0.6) }; })} /></label>}
      </div>
      <details className="px-more">
        <summary>Print effects{a.effects ? ' · on' : ''}{a.dither ? ' · mixed' : ''}</summary>
        <label className="mx-field">Speed × {(ef.speed ?? 1).toFixed(2)}<input type="range" min={0.2} max={1.5} step={0.05} value={ef.speed ?? 1} onChange={(e) => fx({ speed: Number(e.target.value) })} /></label>
        <div className="mx-two">
          <label className="mx-field px-check"><input type="checkbox" checked={!!ef.fuzzy} onChange={(e) => fx({ fuzzy: e.target.checked || undefined })} />Fuzzy skin</label>
          <label className="mx-field px-check" title="Translucent filament: solid infill behind the region, slower, so light passes evenly"><input type="checkbox" checked={!!ef.transparency} onChange={(e) => fx({ transparency: e.target.checked || undefined })} />Transparency</label>
        </div>
        {!ef.transparency && (
          <div className="mx-two">
            <label className="mx-field">Infill behind (%)<input className="input" type="number" min={0} max={100} step={5} placeholder="object" value={ef.infill_density ?? ''} onChange={(e) => fx({ infill_density: e.target.value === '' ? undefined : Math.max(0, Math.min(100, Number(e.target.value))) })} /></label>
            <label className="mx-field">Infill pattern
              <select className="select" value={ef.infill_pattern ?? ''} onChange={(e) => fx({ infill_pattern: e.target.value || undefined })}>
                <option value="">object</option>{['grid', 'gyroid', 'rectilinear', 'aligned_rectilinear', 'triangles', 'concentric'].map((k) => <option key={k} value={k}>{k}</option>)}
              </select>
            </label>
          </div>
        )}
        {a.material.mode !== 'keep' && slots.length > 2 && (
          <>
            <div className="mx-two">
              <label className="mx-field">Mix with
                <select className="select" value={a.dither ? a.dither.slot_index : -1} onChange={(e) => set((x) => { const v = Number(e.target.value); x.dither = v < 0 ? null : { slot_index: v, ratio: x.dither?.ratio ?? 0.5, mode: x.dither?.mode ?? (ams ? 'line' : 'layer') }; })}>
                  <option value={-1}>No</option>{slots.map((c, k) => (k !== a.material.slot_index ? <option key={k} value={k}>slot {k + 1}</option> : null))}
                </select>
              </label>
              {a.dither && <label className="mx-field">Share {Math.round(a.dither.ratio * 100)}%<input type="range" min={0.05} max={0.95} step={0.05} value={a.dither.ratio} onChange={(e) => set((x) => { x.dither = { ...x.dither!, ratio: Number(e.target.value) }; })} /></label>}
            </div>
            {a.dither && (
              <div className="seg mx-seg">
                <button className={a.dither.mode === 'layer' ? 'on' : ''} onClick={() => set((x) => { x.dither = { ...x.dither!, mode: 'layer' }; })}>Alternate layers</button>
                <button className={a.dither.mode === 'line' ? 'on' : ''} disabled={!ams} onClick={() => set((x) => { x.dither = { ...x.dither!, mode: 'line' }; })}>Alternate lines (AMS)</button>
              </div>
            )}
          </>
        )}
      </details>
    </div>
  );
}
