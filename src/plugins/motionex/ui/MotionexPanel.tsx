// Motionex panel in Nexspiro's right dock. The front shows only what you need to place a motion:
// pick it from the library, choose where it goes (click, paint, lasso, box, height band, whole object or
// the whole plate), and watch the real toolpath on the model. Everything else sits under "More options".
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { useStore, type Tool } from '../../../state/store';
import * as THREE from 'three';
import { currentConfig, plateObjects } from '../../../state/slicing';
import { transformVertices } from '../../../engine/mesh';
import { objectMatrix, partWorldMatrix, type SceneObject } from '../../../state/store';
import { buildPreview, type PreviewApp, type PreviewLines } from '../preview';
import { allTris, assignMotion, clearMotionSet, motionCounts, SURFACE_COLORS } from '../../../state/motionPaint';
import { createMotionexState, defaultApplication, saveMotionexState, toConfig, type MotionexState } from '../index';
import { profilesFromConfig, type MotionexConfig, type MotionexReport } from '../engine';
import { brushAt, placedBrush } from '../modifier';
import { DEFAULT_TIP, type MotionApplication, type MotionBrush, type WallChoice } from '../model';
import type { CollisionMode } from '../core/toolhead';
import { patternexMotionApps, px } from '../../patternex/ui/PatternexPanel';
import { regionColor, regionList, regionTriangles } from '../../patternex/ui/preview';
import { openMotionexEditor } from './motionexEditor';
import { WeaveCard, weaveColours } from './WeavePanel';
import { PaintCard } from './PaintPanel';
import { LaceCard } from './LacePanel';
import { buildWeavePreview, buildWeaveThreads } from '../weave/preview';
import { isWaveZone, type ZoneSource } from '../weave/zones';
import { emptyDrool, linesToThreads, mergeThreads, type DroolReport, type ThreadData } from '../../threads';
import { buildPaintPreview } from '../paint/preview';
import { buildLacePreview } from '../lace/preview';
import { loadLace, loadPaint, loadSculpt, loadWeave, motionexActive } from '../index';
import { loadRules } from '../select/model';
import { parseHex } from '../weave/image';
import { DroolCheck } from './DroolCheck';
import { SculptCard } from './PathTool';
import { makeWarp, warpArray } from '../sculpt/preview';
import { sculptActive } from '../sculpt/model';
import { openMotionStudio } from './studioWindow';
import { openSelectWindow } from './SelectWindow';
import { ruleActive } from '../select/model';
import './editor.css';

const storage = typeof localStorage !== 'undefined' ? localStorage : null;
export const mx: MotionexState = createMotionexState(storage);

// tiny external store so React re-renders after edits to the plain Motionex state
let version = 0;
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => { listeners.add(l); return () => listeners.delete(l); };
/** Re-render a component whenever the Motionex state changes. */
export const useMx = () => useSyncExternalStore(subscribe, () => version);
export function changed(): void {
  saveMotionexState(mx, storage);
  version++;
  listeners.forEach((l) => l());
  useStore.getState().markDirty();
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('nx-plugin-preview'));
}

/** Motion preview lines for the active plate (see ../preview.ts), or null when nothing is switched on. */
export function motionexPreview(): PreviewLines | null {
  const s = useStore.getState();
  const apps: PreviewApp[] = [];
  // Patternex regions with a motion, plus Motionex motions aimed at a Patternex region
  const pxOn = s.plugins.includes('patternex');
  const all = [...mx.applications, ...(pxOn ? patternexMotionApps() : [])];
  for (const a of all) {
    if (!a.enabled) continue;
    const found = brushOf(a);
    if (!found) continue;
    const brush = placedBrush(a, found);
    const region = pxOn && a.target.type === 'faces' ? a.target.faces?.find((f) => f.includes(':')) : undefined;
    if (region) {
      const ink = regionColor(px, region) ?? [0.6, 0.6, 0.6];
      apps.push({ app: a, brush, surface: 0, color: ink, trisByObject: regionTriangles(px, region) });
      continue;
    }
    const c = new THREE.Color(SURFACE_COLORS[surfaceOf(a) - 1]);
    apps.push({ app: a, brush, surface: surfaceOf(a), color: [c.r, c.g, c.b] });
  }
  const weaveOn = mx.weave.enabled, paintOn = mx.paint.enabled, laceOn = mx.lace.enabled;
  const sculptOn = sculptActive(mx.sculpt);
  if (!apps.length && !weaveOn && !paintOn && !laceOn && !sculptOn) return null;
  const objs = plateObjects(s.activePlate).filter((o) => o.printable !== false)
    .map((o) => ({ id: o.id, mesh: { vertices: transformVertices(o.mesh.vertices, objectMatrix(o).elements), indices: o.mesh.indices }, motion: o.paint?.motion, zones: weaveZonesOf(o) }));
  const profiles = profilesFromConfig(currentConfig(), s.printerId);
  const warp = makeWarp(mx.sculpt, objs);
  // sculpt alone: show the plain wall (a motion of size 0) so the moves have something to move
  const flat = mx.library.get('preset-sine');
  if (sculptOn && !apps.length && !weaveOn && !paintOn && !laceOn && flat) apps.push({ app: { ...defaultApplication('preset-sine'), scale: 0 }, brush: { ...structuredClone(flat), amplitude: 0, z_amplitude: 0 }, surface: 0, color: [0.62, 0.62, 0.62] });
  lastPreview = apps.length ? buildPreview(objs, apps, profiles, 0.25, mx.previewView, warp) : null;
  if (warp && lastPreview) { warpArray(lastPreview.positions, warp); if (lastPreview.markers) warpArray(lastPreview.markers.positions, warp); }
  const lh = Number(currentConfig().layer_height) || 0.2, lw = profiles.process.lineWidth || 0.42;
  // wall art drawn on the model: the woven picture in filament colours, the painted picture as sheen
  // (light to dark = slow to fast), the lace with its holes left out
  const view = s.colorScheme === 'wave' ? 'wave' : 'real';
  const palette = weaveOn ? weaveColours().map((c): [number, number, number] => [c[0] / 255, c[1] / 255, c[2] / 255]) : [];
  const extra = [
    weaveOn ? buildWeavePreview(objs, mx.weave, lh, palette, view) : null,
    paintOn && !weaveOn ? buildPaintPreview(objs, mx.paint, lh) : null,
    laceOn && !weaveOn && !paintOn ? buildLacePreview(objs, mx.lace, lh, filamentRgb(0), currentConfig()) : null,
  ].filter((x): x is NonNullable<typeof x> => !!x);
  if (warp) for (const e of extra) warpArray(e.positions, warp);
  if (!extra.length) return lastPreview;
  const cat = (a: Float32Array, b: Float32Array) => { const o = new Float32Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; };
  let res: PreviewLines = lastPreview ?? { positions: new Float32Array(0), colors: new Float32Array(0), layers: 0, view: mx.previewView, range: [0, 0], events: 0 };
  for (const e of extra) res = { ...res, positions: cat(res.positions, e.positions), colors: cat(res.colors, e.colors) };
  // the thick-thread twin: motion threads, the woven threads layer by layer, and plain beads for the other wall art
  const parts: { threads: ThreadData; report: DroolReport }[] = [];
  if (lastPreview?.threads) parts.push({ threads: lastPreview.threads, report: lastPreview.drool ?? emptyDrool(lw) });
  if (weaveOn) {
    const mono = filamentRgb(mx.weave.slots[0] ?? 0);
    const t = buildWeaveThreads(objs, mx.weave, lh, lw, (P) => (mx.weave.mode === 'colour' ? palette[Math.min(P?.colour ?? 0, palette.length - 1)] ?? mono : mono), warp, view);
    if (t) parts.push(t);
  } else for (const e of extra) parts.push({ threads: linesToThreads(e.positions, e.colors, lw, lh), report: emptyDrool(lw) });
  const merged = mergeThreads(parts);
  return merged ? { ...res, threads: merged.threads, drool: merged.report } : res;
}
/** An object's wave zones for the preview: its modifier parts with a wave (in world space) and its height bands. */
function weaveZonesOf(o: SceneObject): ZoneSource | undefined {
  const parts = (o.parts ?? []).filter((p) => p.type === 'modifier' && isWaveZone(p.overrides));
  const heightRanges = (o.heightRanges ?? []).filter((r) => isWaveZone(r.overrides));
  if (!parts.length && !heightRanges.length) return undefined;
  return {
    parts: parts.map((p) => ({ type: p.type, overrides: p.overrides, indices: p.mesh.indices, vertices: transformVertices(p.mesh.vertices, partWorldMatrix(o, p).elements) })),
    heightRanges,
  };
}
const filamentRgb = (slot: number): [number, number, number] => { const c = parseHex(useStore.getState().filaments[slot]?.color ?? '#d8d4cc'); return [c[0] / 255, c[1] / 255, c[2] / 255]; };
/** The last preview built, for the legend in the Motion tab. */
export let lastPreview: PreviewLines | null = null;

/** Slicer config, or undefined when no motion is switched on. */
export function motionexConfig(printerId: string): MotionexConfig | undefined {
  return motionexActive(mx) ? toConfig(mx, printerId) : undefined;
}

const MAX_SURFACES = SURFACE_COLORS.length;

/** Patterns and settings stored in the project file. Pattern designs travel with them. */
export function motionexProject() {
  const used = new Set(mx.applications.map((a) => a.brush_id));
  return {
    applications: structuredClone(mx.applications), options: { ...mx.options }, collisionMode: mx.collisionMode, weave: structuredClone(mx.weave),
    paint: structuredClone(mx.paint), lace: structuredClone(mx.lace), sculpt: structuredClone(mx.sculpt), rules: structuredClone(mx.rules),
    brushes: [...used, ...mx.rules.flatMap((r) => (r.apply.motion ? [r.apply.motion.brush_id] : []))].map((id) => mx.library.get(id)).filter((b) => !!b).map((b) => structuredClone(b)),
  };
}

export function loadMotionexProject(data: unknown) {
  const d = data as Partial<ReturnType<typeof motionexProject>> | null;
  if (!d) return;
  for (const b of d.brushes ?? []) if (b && !mx.library.get(b.id)) mx.library.save(b);
  mx.applications = d.applications ?? [];
  if (d.options) mx.options = { ...mx.options, ...d.options };
  if (d.collisionMode) mx.collisionMode = d.collisionMode;
  mx.weave = loadWeave(d.weave);
  mx.paint = loadPaint(d.paint);
  mx.lace = loadLace(d.lace);
  mx.sculpt = loadSculpt(d.sculpt);
  mx.rules = loadRules(d.rules);
  changed();
}
const WALLS: [WallChoice, string][] = [['outer', 'Outer wall'], ['inner', 'Inner walls'], ['all', 'All walls']];
const COLLIDE: [CollisionMode, string][] = [['clamp', 'Lower the movement there'], ['skip', 'Skip the movement there'], ['fail', 'Stop and show me']];

/** The motion a placement uses: its own edited copy, or the library motion. */
export const brushOf = (a: MotionApplication): MotionBrush | undefined => a.brush ?? mx.library.get(a.brush_id);

/** The surface set (1..n) a motion paints into. Older saves stored it only in target.faces. */
export function surfaceOf(a: MotionApplication): number {
  if (!a.surface) {
    const n = Number(a.target.faces?.[0]);
    a.surface = n >= 1 && n <= MAX_SURFACES ? n : freeSurface(a);
  }
  return a.surface;
}
function freeSurface(except?: MotionApplication): number {
  const used = new Set(mx.applications.filter((a) => a !== except && a.surface).map((a) => a.surface));
  for (let k = 1; k <= MAX_SURFACES; k++) if (!used.has(k)) return k;
  return 1;
}

let activeIndex = 0;
export const activeApp = (): MotionApplication | undefined => mx.applications[Math.min(activeIndex, mx.applications.length - 1)];

export function activate(i: number) {
  activeIndex = i;
  const a = mx.applications[i];
  if (a) useStore.getState().set({ motionSet: surfaceOf(a) });
  version++;
  listeners.forEach((l) => l());
}

export function addApplication(brushId: string): MotionApplication {
  const a = defaultApplication(brushId);
  a.order = mx.applications.length;
  a.surface = freeSurface();
  a.target = { type: 'faces', walls: 'outer', faces: [String(a.surface)] };
  a.mask.blend_mm = 2;
  mx.applications.push(a);
  activate(mx.applications.length - 1);
  return a;
}

/** Make the motion go on picked surfaces (its own surface set). */
export function toFaces(a: MotionApplication) {
  const n = surfaceOf(a);
  if (a.target.type !== 'faces' || a.target.faces?.[0] !== String(n)) a.target = { ...a.target, type: 'faces', faces: [String(n)] };
}

/** Right-click "Motionex motion on whole object": the active motion (or a new one) covers these objects. */
export function applyMotionToObjects(ids: string[]) {
  const s = useStore.getState();
  const a = activeApp() ?? addApplication('preset-sine');
  toFaces(a);
  const objs = s.objects.filter((o) => ids.includes(o.id));
  assignMotion(new Map(objs.map((o) => [o.id, allTris(o)])), surfaceOf(a), surfaceOf(a));
  s.set({ motionSet: surfaceOf(a), dock: { ...s.dock, open: true, tab: 'motionex' } });
  changed();
}

/** Height band dragged on the model: the active motion runs between those heights (all the way round). */
function setBand(a: MotionApplication, from: number, to: number) {
  a.mask.z_start = +Math.max(0, Math.min(from, to)).toFixed(2);
  a.mask.z_end = +Math.max(from, to).toFixed(2);
  // ease in and out over a few layers so the band has no ledge at either end
  const room = (a.mask.z_end - a.mask.z_start) / 3;
  a.mask.fade_in_mm = +Math.min(Math.max(a.mask.fade_in_mm, 1), room).toFixed(2);
  a.mask.fade_out_mm = a.mask.z_end >= 1e4 ? 0 : +Math.min(Math.max(a.mask.fade_out_mm, 1), room).toFixed(2);
}
if (typeof window !== 'undefined') window.addEventListener('nx-motion-band', (e) => {
  const { id, from, to, erase } = (e as CustomEvent<{ id: string; from: number; to: number; erase: boolean }>).detail;
  const a = activeApp();
  if (!a) return;
  if (erase) { a.mask.z_start = 0; a.mask.z_end = 1e4; changed(); return; }
  setBand(a, from, to);
  // nothing picked yet: the band goes round the whole object it was drawn on (but not over other motions)
  if (a.target.type === 'faces' && !motionCounts(useStore.getState().objects, surfaceOf(a)).tris) {
    const o = useStore.getState().objects.find((x) => x.id === id);
    if (o) assignMotion(new Map([[o.id, allTris(o)]]), surfaceOf(a), surfaceOf(a), true, true);
  }
  changed();
});

export function MotionexPanel() {
  useMx();
  const [editing, setEditing] = useState<string | null | undefined>(undefined);
  const [picking, setPicking] = useState<'add' | 'change' | null>(null);
  const apps = mx.applications;
  const act = activeApp();
  useEffect(() => { if (act) useStore.getState().set({ motionSet: surfaceOf(act) }); }, [act]);
  const choose = (b: MotionBrush) => {
    if (picking === 'change' && act) { act.brush_id = b.id; act.brush = undefined; }
    else {
      const a = addApplication(b.id);
      // with an object selected, a new motion starts on that whole object
      const s = useStore.getState();
      const sel = s.objects.filter((o) => s.selected.includes(o.id));
      if (sel.length) assignMotion(new Map(sel.map((o) => [o.id, allTris(o)])), surfaceOf(a), surfaceOf(a));
      else s.set({ tool: 'pick_motion' });
    }
    setPicking(null);
    changed();
  };
  return (
    <div className="mx-panel">
      <div className="mx-head">
        <span className="mx-badge">M</span>
        <div style={{ flex: 1 }}><div className="mx-title">Motionex</div><div className="mx-sub">Waves, loops and textures on your walls</div></div>
        <button className="btn-secondary btn-small" onClick={() => openMotionStudio(true)} title="The motion editor (was the Motion tab): shape, depth, spacing and layer stacking, live on the model">Motion editor ↗</button>
      </div>
      {/* toolpath view toggle lives in the top bar (shared by all plugins) */}
      <section className="mx-card mx-flow">
        <div className="mx-card-title">Layer motion<span className="spacer" />
          <button className="btn-secondary btn-small" onClick={() => setEditing(act?.brush_id ?? null)} title="Make or edit your own motions">Edit library…</button>
        </div>
        <div className="mx-step"><span className="mx-step-n">1</span>Choose a motion</div>
        {!apps.length && !picking && <p className="mx-muted" style={{ margin: 0 }}>Pick a motion from the library, then place it on the model in step 2.</p>}
        <div className="mx-layers">
          {apps.map((a, i) => <LayerRow key={i} a={a} i={i} active={a === act} onChange={() => setPicking('change')} />)}
        </div>
        {picking ? <Library current={picking === 'change' ? act?.brush_id : undefined} onPick={choose} onCancel={() => setPicking(null)} />
          : <div className="row" style={{ gap: 6, margin: 0 }}>
              <button className="btn-primary btn-small" style={{ flex: 1 }} disabled={apps.length >= MAX_SURFACES} onClick={() => setPicking('add')}>+ Add motion</button>
              {act && <button className="btn-secondary btn-small" onClick={() => openMotionStudio(true)} title="Shape, depth, spacing, stops and layer stacking, live on the model">Edit in Studio ↗</button>}
            </div>}
        {!picking && <>
          <div className="mx-step"><span className="mx-step-n">2</span>Place it on the model</div>
          <Placement a={act} />
          <div className="mx-step"><span className="mx-step-n">3</span>Or change it by layer <span className="mx-muted" style={{ margin: '0 0 0 auto', fontWeight: 400 }}>{mx.rules.length ? `${mx.rules.filter(ruleActive).length} of ${mx.rules.length} rules on` : 'no rules yet'}</span></div>
          <button className="btn-secondary btn-small" onClick={() => openSelectWindow(true)} title="Pick layers, single lines or a brushed area on the sliced print and change filament, motion, speed, flow or temperature there">Open layer rules…</button>
        </>}
      </section>
      {!picking && <SurfaceEffect />}
      {act && !picking && <MoreOptions a={act} first={apps.indexOf(act) === 0} />}
      <DroolCheck />
      <Report />
      {editing !== undefined && <EditorHost startId={editing} onClose={() => setEditing(undefined)} />}
    </div>
  );
}


function coverage(a: MotionApplication, objects: ReturnType<typeof useStore.getState>['objects']): string {
  if (a.target.type === 'body') return 'Whole plate';
  const c = motionCounts(objects, surfaceOf(a));
  if (!c.tris) return 'Nowhere yet — choose where below';
  const whole = objects.filter((o) => o.paint?.motion?.length && o.paint.motion.every((v) => v === surfaceOf(a))).length;
  return whole === c.objects ? `${whole} whole object${whole > 1 ? 's' : ''}` : `${c.tris} faces on ${c.objects} object${c.objects > 1 ? 's' : ''}`;
}

/** Aim the motion at a Patternex artwork region (Patternex owns the region; Motionex moves only the walls inside it). */
function ArtworkTarget({ a }: { a: MotionApplication }) {
  const { plugins, objects } = useStore();
  void objects; // re-render when placements change
  if (!plugins.includes('patternex')) return null;
  const regions = regionList(px);
  if (!regions.length) return null;
  const cur = a.target.type === 'faces' ? a.target.faces?.find((f) => f.includes(':')) ?? '' : '';
  return (
    <label className="mx-field">Or on Patternex artwork
      <select className="select" value={cur} onChange={(e) => {
        if (e.target.value) { a.target = { ...a.target, type: 'faces', faces: [e.target.value] }; useStore.getState().set({ tool: 'select' }); }
        else toFaces(a);
        changed();
      }}>
        <option value="">— picked faces —</option>
        {regions.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
      </select>
    </label>
  );
}

function LayerRow({ a, i, active, onChange }: { a: MotionApplication; i: number; active: boolean; onChange: () => void }) {
  const objects = useStore((s) => s.objects);
  const b = brushOf(a);
  const upd = (f: () => void) => { f(); changed(); };
  const remove = () => upd(() => {
    const n = surfaceOf(a);
    mx.applications.splice(i, 1);
    if (!mx.applications.some((x) => surfaceOf(x) === n)) clearMotionSet(n);
    activeIndex = Math.max(0, Math.min(activeIndex, mx.applications.length - 1));
    const s = useStore.getState();
    if (!mx.applications.length && s.tool.endsWith('_motion')) s.set({ tool: 'select' });
  });
  return (
    <div className={`mx-layer ${active ? 'on' : ''} ${a.enabled ? '' : 'off'}`} onClick={() => activate(i)}>
      <i className="mx-dot" style={{ background: SURFACE_COLORS[surfaceOf(a) - 1] }} />
      <input type="checkbox" checked={a.enabled} aria-label="On" title="On / off" onClick={(e) => e.stopPropagation()} onChange={(e) => upd(() => { a.enabled = e.target.checked; })} />
      <div className="mx-layer-text">
        <button className="mx-layer-name" title="Change motion" onClick={(e) => { e.stopPropagation(); activate(i); onChange(); }}>{b?.name ?? a.brush_id}{a.brush ? ' (edited)' : ''} ▾</button>
        <div className="mx-muted" style={{ margin: 0 }}>{coverage(a, objects)}</div>
      </div>
      {b && <Wave b={b} small />}
      <button className="btn-secondary btn-small" onClick={(e) => { e.stopPropagation(); remove(); }}>Remove</button>
    </div>
  );
}

/** Motion library as a grid of cards with a little drawing of each wave. */
export function Library({ current, onPick, onCancel }: { current?: string; onPick: (b: MotionBrush) => void; onCancel: () => void }) {
  const [q, setQ] = useState('');
  const groups = useMemo(() => {
    const g = new Map<string, MotionBrush[]>();
    for (const b of mx.library.all()) {
      if (q && !`${b.name} ${b.description ?? ''} ${b.category ?? ''}`.toLowerCase().includes(q.toLowerCase())) continue;
      const k = mx.library.isPreset(b.id) ? b.category ?? 'Other' : 'My motions';
      g.set(k, [...(g.get(k) ?? []), b]);
    }
    return [...g];
  }, [q]);
  return (
    <div className="mx-lib">
      <div className="row" style={{ gap: 6, margin: 0 }}>
        <input className="input" autoFocus placeholder="Search motions" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1 }} />
        <button className="btn-secondary btn-small" onClick={onCancel}>Cancel</button>
      </div>
      {groups.map(([g, bs]) => (
        <div key={g}>
          <div className="mx-label">{g}</div>
          <div className="mx-lib-grid">
            {bs.map((b) => (
              <button key={b.id} className={`mx-lib-card ${b.id === current ? 'on' : ''}`} title={b.description ?? b.name} onClick={() => onPick(b)}>
                <Wave b={b} />
                <span>{b.name}</span>
              </button>
            ))}
          </div>
        </div>
      ))}
      {!groups.length && <p className="mx-muted">No motion matches “{q}”.</p>}
    </div>
  );
}

export function Wave({ b, small }: { b: MotionBrush; small?: boolean }) {
  const d = useMemo(() => {
    const W = 100, H = 30, periods = 2, L = b.period_mm * periods;
    let lat = '', z = '';
    let max = 1e-6;
    const pts: [number, number, number][] = [];
    for (let k = 0; k <= 80; k++) {
      const s = (k / 80) * L;
      const m = b.repeat_mode === 'once' ? brushAt({ ...b, repeat_mode: 'tile' }, s, L) : brushAt(b, s, L);
      pts.push([s, m?.lat ?? 0, m?.z ?? 0]);
      max = Math.max(max, Math.abs(m?.lat ?? 0), Math.abs(m?.z ?? 0));
    }
    pts.forEach(([s, l, zz], k) => {
      const x = (s / L) * W;
      lat += `${k ? 'L' : 'M'}${x.toFixed(1)},${(H / 2 - (l / max) * (H / 2 - 2)).toFixed(1)}`;
      z += `${k ? 'L' : 'M'}${x.toFixed(1)},${(H / 2 - (zz / max) * (H / 2 - 2)).toFixed(1)}`;
    });
    return { lat, z: (b.z_amplitude ?? 0) > 0 ? z : '' };
  }, [b]);
  return (
    <svg className={`mx-wave ${small ? 'sm' : ''}`} viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden>
      <path d={d.lat} pathLength={100} />
      {d.z && <path d={d.z} className="z" pathLength={100} />}
    </svg>
  );
}

const PLACE_TOOLS: { tool: Tool | 'box' | 'plate'; label: string; icon: string; hint: string }[] = [
  { tool: 'pick_motion', label: 'Click', icon: '◉', hint: 'Click a surface: a flat side, or a whole curved wall.' },
  { tool: 'paint_motion', label: 'Paint', icon: '✎', hint: 'Drag to paint the motion on.' },
  { tool: 'lasso_motion', label: 'Lasso', icon: '◌', hint: 'Draw round an area of the model. Only faces turned towards you are taken.' },
  { tool: 'box', label: 'Box', icon: '▭', hint: 'Drag a box over an area of the model. Only faces turned towards you are taken.' },
  { tool: 'band_motion', label: 'Height', icon: '☰', hint: 'Drag up or down on the model to set the heights the motion runs between, all the way round.' },
  { tool: 'object_motion', label: 'Object', icon: '⬢', hint: 'Click an object to cover all of it. Click it again to take it off.' },
  { tool: 'plate', label: 'All', icon: '▦', hint: 'The motion goes on every object on the plate.' },
];

/** Where the active motion goes. With no motion yet the tools still show; picking one starts a Wave. */
function Placement({ a: active }: { a?: MotionApplication }) {
  const set = useStore((s) => s.set);
  if (!active) {
    return (
      <section className="mx-card">
        <div className="mx-card-title">Where it goes</div>
        <div className="mx-tools">
          {PLACE_TOOLS.map((p) => (
            <button key={p.label} className="mx-tool" title={`${p.label}: ${p.hint}`} aria-label={p.label} onClick={() => {
              const a = addApplication('preset-sine');
              if (p.tool === 'plate') a.target = { ...a.target, type: 'body' };
              else if (p.tool === 'box' || p.tool === 'lasso_motion') set({ tool: 'lasso_motion', motionDraw: p.tool === 'box' ? 'box' : 'lasso' });
              else set({ tool: p.tool });
              changed();
            }}>
              <span className="ic">{p.icon}</span><span className="lbl">{p.label}</span>
            </button>
          ))}
        </div>
        <p className="mx-muted" style={{ margin: 0 }}>Choose how to pick faces on the model: click a surface, paint, lasso or box an area, drag a height band, or take a whole object or the whole plate.</p>
      </section>
    );
  }
  return <PlacementFor a={active} />;
}

function PlacementFor({ a }: { a: MotionApplication }) {
  const { tool, set, motionGrowAngle, brushSize, motionDraw, objects } = useStore();
  const current = a.target.type === 'body' ? 'plate' : tool === 'lasso_motion' && motionDraw === 'box' ? 'box' : tool;
  const pick = (t: (typeof PLACE_TOOLS)[number]['tool']) => {
    if (t === 'plate') { a.target = { ...a.target, type: 'body' }; set({ tool: 'select' }); changed(); return; }
    toFaces(a);
    if (t === 'box') set({ tool: current === 'box' ? 'select' : 'lasso_motion', motionDraw: 'box' });
    else if (t === 'lasso_motion') set({ tool: current === 'lasso_motion' ? 'select' : 'lasso_motion', motionDraw: 'lasso' });
    else set({ tool: tool === t ? 'select' : t });
    changed();
  };
  const info = PLACE_TOOLS.find((p) => p.tool === current);
  const n = surfaceOf(a);
  const count = motionCounts(objects, n).tris;
  return (
    <section className="mx-card">
      <div className="mx-card-title">Where it goes</div>
      <div className="mx-tools">
        {PLACE_TOOLS.map((p) => (
          <button key={p.label} className={`mx-tool ${current === p.tool ? 'on' : ''}`} title={`${p.label}: ${p.hint}`} aria-label={p.label} onClick={() => pick(p.tool)}>
            <span className="ic">{p.icon}</span><span className="lbl">{p.label}</span>
          </button>
        ))}
      </div>
      <ArtworkTarget a={a} />
      {info && <p className="mx-muted" style={{ margin: 0 }}>{info.hint}{current === 'band_motion' ? ' Shift + drag goes back to full height.' : current === 'lasso_motion' ? ' Shift + drag takes it off.' : current !== 'plate' && current !== 'object_motion' ? ' Shift + drag or a right click takes it off.' : ''}{current === 'lasso_motion' ? ' Right or middle drag pans; wheel zooms; press Done to rotate again.' : current !== 'plate' ? ' Drag off the model to rotate; right or middle drag pans; wheel zooms.' : ''}</p>}
      {current === 'pick_motion' && (
        <label className="mx-field">Spread over edges up to {motionGrowAngle}°
          <input type="range" min={1} max={60} value={motionGrowAngle} onChange={(e) => set({ motionGrowAngle: +e.target.value })} />
        </label>
      )}
      {current === 'paint_motion' && (
        <label className="mx-field">Brush size {brushSize} mm
          <input type="range" min={0.4} max={20} step={0.2} value={brushSize} onChange={(e) => set({ brushSize: +e.target.value })} />
        </label>
      )}
      {current === 'band_motion' && (
        <>
          <div className="mx-two">
            <label className="mx-field">From (mm)<input className="input" type="number" min={0} step={0.2} value={a.mask.z_start} onChange={(e) => { setBand(a, +e.target.value, a.mask.z_end); changed(); }} /></label>
            <label className="mx-field">To (mm)<input className="input" type="number" min={0} step={0.2} value={a.mask.z_end >= 1e4 ? '' : a.mask.z_end} placeholder="top" onChange={(e) => { setBand(a, a.mask.z_start, e.target.value === '' ? 1e4 : +e.target.value); changed(); }} /></label>
          </div>
          <button className="btn-secondary btn-small" style={{ alignSelf: 'flex-start' }} disabled={a.mask.z_start <= 0.6 && a.mask.z_end >= 1e4} onClick={() => { a.mask.z_start = 0.6; a.mask.z_end = 1e4; changed(); }}>Full height</button>
        </>
      )}
      {current !== 'plate' && (
        <div className="row" style={{ gap: 6, margin: 0 }}>
          <span className="mx-muted" style={{ flex: 1, margin: 0 }}>{count ? `${count} faces covered` : 'Nothing covered yet'}</span>
          {count > 0 && <button className="btn-secondary btn-small" onClick={() => { clearMotionSet(n); changed(); }}>Clear</button>}
          {tool.endsWith('_motion') && <button className="btn-secondary btn-small" onClick={() => set({ tool: 'select' })}>Done</button>}
        </div>
      )}
      <label className="mx-field">Size ×{(a.scale ?? 1).toFixed(2)}
        <input type="range" min={0.25} max={3} step={0.05} value={a.scale ?? 1} onChange={(e) => { a.scale = +e.target.value; changed(); }} />
      </label>
      <label className="mx-field">Round sharp corners: {(a.round_mm ?? 0) > 0 ? `${(a.round_mm ?? 0).toFixed(2)} mm` : 'off (crisp)'}
        <input type="range" min={0} max={1} step={0.05} value={a.round_mm ?? 0} onChange={(e) => { a.round_mm = +e.target.value; changed(); }} />
      </label>
    </section>
  );
}

const TIP_MODES: ['fade' | 'off' | 'full', string][] = [['fade', 'Shrink to fit'], ['off', 'Switch off'], ['full', 'Keep full size']];

function MoreOptions({ a, first }: { a: MotionApplication; first: boolean }) {
  const upd = (f: () => void) => { f(); changed(); };
  const printerId = useStore((s) => s.printerId);
  return (
    <details className="mx-card mx-more">
      <summary className="mx-card-title">Advanced settings</summary>
      <div className="mx-label">Walls</div>
      <select className="select mx-select" aria-label="Walls" value={a.target.walls ?? 'outer'} onChange={(e) => upd(() => { a.target = { ...a.target, walls: e.target.value as WallChoice }; })}>
        {WALLS.map(([w, l]) => <option key={w} value={w}>{l}</option>)}
      </select>
      <div className="mx-two">
        <label className="mx-field">Start at (mm)<input className="input" type="number" min={0} step={0.2} value={a.mask.z_start} onChange={(e) => upd(() => { a.mask.z_start = +e.target.value; })} /></label>
        <label className="mx-field">Stop at (mm)<input className="input" type="number" min={0} step={0.2} value={a.mask.z_end >= 1e4 ? '' : a.mask.z_end} placeholder="top" onChange={(e) => upd(() => { a.mask.z_end = e.target.value === '' ? 1e4 : +e.target.value; })} /></label>
      </div>
      <div className="mx-two">
        <label className="mx-field">Fade in over (mm)<input className="input" type="number" min={0} step={0.2} value={a.mask.fade_in_mm} onChange={(e) => upd(() => { a.mask.fade_in_mm = Math.max(0, +e.target.value); })} /></label>
        <label className="mx-field">Fade out over (mm)<input className="input" type="number" min={0} step={0.2} value={a.mask.fade_out_mm} onChange={(e) => upd(() => { a.mask.fade_out_mm = Math.max(0, +e.target.value); })} /></label>
      </div>
      <label className="mx-field">Soft edge where the motion stops: {(a.mask.blend_mm ?? 1.5).toFixed(1)} mm
        <input type="range" min={0} max={10} step={0.5} value={a.mask.blend_mm ?? 1.5} onChange={(e) => upd(() => { a.mask.blend_mm = +e.target.value; })} />
      </label>
      <div className="mx-label">Near the tip (loops too small for the motion)</div>
      <select className="select mx-select" aria-label="Near the tip" value={a.tip?.mode ?? DEFAULT_TIP.mode} onChange={(e) => upd(() => { a.tip = { ...(a.tip ?? DEFAULT_TIP), mode: e.target.value as (typeof TIP_MODES)[number][0] }; })}>
        {TIP_MODES.map(([m, l]) => <option key={m} value={m}>{l}</option>)}
      </select>
      {(a.tip?.mode ?? DEFAULT_TIP.mode) !== 'full' && (
        <label className="mx-field">{(a.tip?.mode ?? DEFAULT_TIP.mode) === 'off' ? 'Switch off' : 'Start shrinking'} when the motion needs more than {Math.round((a.tip?.share ?? DEFAULT_TIP.share) * 100)}% of the loop's inner radius
          <input type="range" min={0.05} max={1} step={0.05} value={a.tip?.share ?? DEFAULT_TIP.share} onChange={(e) => upd(() => { a.tip = { ...(a.tip ?? DEFAULT_TIP), share: +e.target.value }; })} />
        </label>
      )}
      {(a.tip?.mode ?? DEFAULT_TIP.mode) === 'full' && <div className="mx-muted" style={{ margin: 0 }}>Full size on every loop: near a tip the line can fold over itself.</div>}
      {!first && (
        <>
          <div className="mx-label">Where it overlaps the motions above</div>
          <div className="seg mx-seg">
            <button className={a.blend === 'add' ? 'on' : ''} onClick={() => upd(() => { a.blend = 'add'; })}>Add on top</button>
            <button className={a.blend === 'override' ? 'on' : ''} onClick={() => upd(() => { a.blend = 'override'; })}>Replace</button>
          </div>
        </>
      )}
      <div className="mx-label">All motions</div>
      <label className="row" style={{ gap: 8, margin: 0 }}>
        <span style={{ flex: 1, fontSize: 12 }}>Inner walls follow the motion<div className="mx-muted" style={{ margin: 0 }}>Keeps the motion skin fused to the part, with no gaps or double plastic behind it.</div></span>
        <button className={`toggle ${mx.options.bondInnerWalls !== false ? 'on' : ''}`} aria-label="Inner walls follow the motion" onClick={() => upd(() => { mx.options.bondInnerWalls = mx.options.bondInnerWalls === false; })} />
      </label>
      <label className="mx-field">If the print head would hit the print
        <select className="select" value={mx.collisionMode} onChange={(e) => upd(() => { mx.collisionMode = e.target.value as CollisionMode; })}>
          {COLLIDE.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </label>
      <label className="mx-field">Loops print at {Math.round(mx.options.loopSpeedShare * 100)}% speed
        <input type="range" min={0.2} max={1} step={0.05} value={mx.options.loopSpeedShare} onChange={(e) => upd(() => { mx.options.loopSpeedShare = +e.target.value; })} />
      </label>
      <p className="mx-muted">Print-head shape: {mx.toolheads.get(printerId).name}. Used to check up-and-down motions for collisions.</p>
    </details>
  );
}

function Report() {
  const result = useStore((s) => s.slice.result);
  const dirty = useStore((s) => s.slice.dirty);
  const rep = result?.pluginReports?.motionex as MotionexReport | undefined;
  if (!rep) return null;
  const c = rep.check;
  const rows: [boolean, string][] = [
    [c.collisionCount === 0, c.collisionCount ? `Print head would hit the print in ${c.collisionCount} spots${c.blocking ? ' — export stopped' : ' (fixed)'}` : 'Print head stays clear of the print'],
    [c.flowCapHits === 0, c.flowCapHits ? `Slowed in ${c.flowCapHits} spots to stay within the hotend's melt limit` : 'Plastic flow within the hotend limit'],
    [c.speedHits + c.zSpeedHits + c.accelHits === 0, c.speedHits + c.zSpeedHits + c.accelHits ? `Kept within printer speed limits in ${c.speedHits + c.zSpeedHits + c.accelHits} spots` : 'Within printer speed limits'],
    [c.loopSlowed === 0, c.loopSlowed ? `Loops printed slower in ${c.loopSlowed} spots` : 'No loops slowed'],
  ];
  const bad = rows.filter(([ok]) => !ok).length;
  return (
    <details className="mx-card mx-more" open={bad > 0}>
      <summary className="mx-card-title">Print check{dirty ? ' (out of date)' : ''}<span className="spacer" /><span className={bad ? 'bad' : 'ok'} style={{ fontSize: 12 }}>{bad ? `${bad} to look at` : 'All good'}</span></summary>
      <p className="mx-muted">{rep.movedPaths} wall paths changed · pauses {c.events.dwell} · lift-offs {c.events.retract} · plastic changes {c.events.flow}</p>
      {rows.map(([ok, t], k) => <div key={k} className="mx-check"><span className={ok ? 'ok' : 'bad'}>{ok ? '✓' : '!'}</span>{t}</div>)}
    </details>
  );
}

function EditorHost({ startId, onClose }: { startId: string | null; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const printerId = useStore.getState().printerId;
    openMotionexEditor(ref.current, mx, () => profilesFromConfig(currentConfig(), printerId), startId, (didChange) => { if (didChange) changed(); onClose(); });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return createPortal(<div className="mx-modal" ref={ref} />, document.body);
}

const EFFECT_KEY = 'nexspiro.motionex.surface';
const EFFECTS = [
  ['weave', 'Weave & texture', () => mx.weave.enabled],
  ['paint', 'Velocity paint', () => mx.paint.enabled],
  ['lace', 'Lace', () => mx.lace.enabled],
  ['sculpt', 'Path sculpt', () => mx.sculpt.enabled],
] as const;
type EffectId = (typeof EFFECTS)[number][0];

/** One switch for the effects that change the wall surface; only the chosen one's settings show. */
function SurfaceEffect() {
  useMx();
  const [id, setId] = useState<EffectId>(() => {
    try { const v = localStorage.getItem(EFFECT_KEY); if (EFFECTS.some(([k]) => k === v)) return v as EffectId; } catch { /* storage off */ }
    return (EFFECTS.find(([, , on]) => on())?.[0] ?? 'weave') as EffectId;
  });
  const pick = (v: EffectId) => { setId(v); try { localStorage.setItem(EFFECT_KEY, v); } catch { /* storage off */ } };
  const onCount = EFFECTS.filter(([, , on]) => on()).length;
  return (
    <div className="mx-surface">
      <div className="mx-surface-h">
        <span className="mx-card-title" style={{ margin: 0 }}>Surface effect</span>
        <select className="select" value={id} aria-label="Surface effect" onChange={(e) => pick(e.target.value as EffectId)}>
          {EFFECTS.map(([k, l, on]) => <option key={k} value={k}>{l}{on() ? ' · on' : ''}</option>)}
        </select>
      </div>
      {onCount > 1 && <p className="mx-muted" style={{ margin: 0 }}>{onCount} surface effects are on; they stack on the same wall.</p>}
      {id === 'weave' && <WeaveCard />}
      {id === 'paint' && <PaintCard />}
      {id === 'lace' && <LaceCard />}
      {id === 'sculpt' && <SculptCard />}
    </div>
  );
}
