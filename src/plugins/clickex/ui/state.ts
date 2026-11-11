// Clickex UI state: the design being edited (kept in the browser and in project files), undo / redo, the
// artwork and model resources behind it, the live build, and the two ways out: Transfer to plate and
// Download 3MF.
import { useSyncExternalStore } from 'react';
import { centreMesh, loadModelFile } from '../../../io/load';
import { meshBounds, openEdgeCount, type IndexedMesh } from '../../../engine/mesh';
import { addPlate, arrange, centreOnBed } from '../../../state/ops';
import { newId, objectPlate, useStore, type SceneObject } from '../../../state/store';
import { printerById } from '../../../profiles/printers';
import { registerFilamentLink, slotForFilament } from '../../../state/holders';
import { createHistory } from '../../../ui/studio/history';
import { beginTransfer, endTransfer } from '../../../state/steps';
import { adaptWall, bedWarning, registerMachineLink } from '../../../state/machineSync';
import { artColors, artFromIcon, artFromImage, artFromSvg, artFromText, type Art } from '../art';
import { buildClicker, printParts, type BuiltClicker, type Part } from '../build';
import { build3mf } from '../export3mf';
import { defaultSpec, normalizeSpec, type ClickexSpec, type Source } from '../model';
import { buildFromModel, modelSize, rotateAsset, scaledModel, type ModelAsset } from '../modelmode';
import { sampleModel } from '../models';
import { planBlocks, planSingle, type Plan } from '../plan';
import { sampleArt } from '../samples';
import { fontById, loadFont } from '../../patternex/tools/text';
import type { RasterImage } from '../../patternex/tools/trace';

const KEY = 'nexspiro.clickex.v1';
const SAVED = 'nexspiro.clickex.designs.v1';
const storage = typeof localStorage !== 'undefined' ? localStorage : null;

export type View = 'assembled' | 'exploded' | 'print';

export interface CxState {
  spec: ClickexSpec;
  tab: string;
  view: View;
  showSwitch: boolean;
  cutOpen: boolean;
  /** Press test in the assembled view, 0 = at rest, 1 = pressed through the full travel. */
  press: number;
  studioOpen: boolean;
  /** Scene objects made by the last transfer. */
  placed: string[];
  toast: string;
  busy: boolean;
}

function load(): CxState {
  const d: CxState = { spec: defaultSpec(), tab: 'shape', view: 'exploded', showSwitch: true, cutOpen: false, press: 0, studioOpen: false, placed: [], toast: '', busy: false };
  try {
    const s = JSON.parse(storage?.getItem(KEY) ?? 'null');
    if (s?.spec) return { ...d, ...s, spec: normalizeSpec(s.spec), studioOpen: false, placed: s.placed ?? [], toast: '', busy: false };
  } catch { /* fresh start */ }
  return d;
}

export const cx: CxState = load();
let version = 0;
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export const useCx = () => useSyncExternalStore(subscribe, () => version);
/** Bumped when the geometry may have changed. */
export let geometryVersion = 0;

export function changed(geometry = true) {
  if (geometry) { geometryVersion++; undoHistory.touch(); }
  try { storage?.setItem(KEY, JSON.stringify({ spec: cx.spec, tab: cx.tab, view: cx.view, showSwitch: cx.showSwitch, placed: cx.placed })); } catch { /* storage full */ }
  version++;
  listeners.forEach((l) => l());
}

// ---------------------------------------------------------------- history
/** Undo / redo on the shared Studio history: a slider drag or a burst of edits is one step. */
export const undoHistory = createHistory(() => cx.spec, (spec) => { cx.spec = normalizeSpec(spec); changed(); });

/** Edit the design (recorded for undo once edits pause). */
export function edit(fn: (s: ClickexSpec) => void, _tag = '') {
  fn(cx.spec);
  changed();
}
export function resetDesign() {
  const keep = cx.spec;
  cx.spec = { ...defaultSpec(), source: keep.source, svg: keep.svg, image: keep.image, icon: keep.icon, model: { ...defaultSpec().model, name: keep.model.name }, name: keep.name };
  changed();
}

export function setTab(id: string) { cx.tab = id; changed(false); }
export function openStudio(open = true) { cx.studioOpen = open; if (open && !opened) { opened = true; snapToLoaded(); undoHistory.reset(); } changed(false); }
/** The design has been worked on this session (it then takes part in filament-change prompts). */
let opened = false;
export function say(text: string) { cx.toast = text; changed(false); setTimeout(() => { if (cx.toast === text) { cx.toast = ''; changed(false); } }, 4200); }

export function setSource(s: Source) {
  edit((sp) => {
    sp.source = s;
    // icons are line art: they need a solid base
    if (s === 'icon' && sp.shape.baseStyle === 'outline') { sp.shape.baseStyle = 'shape'; if (sp.shape.baseShape === 'squircle') sp.shape.baseShape = 'circle'; }
  });
  cx.tab = s === 'blocks' ? 'layout' : s === 'model' ? 'cut' : 'shape';
  if (s === 'icon') say('Icons need a solid base, so the base style switched to Shape.');
  changed(false);
}

// ---------------------------------------------------------------- resources
export const res = {
  model: null as ModelAsset | null,
  raster: new Map<string, RasterImage>(),
  art: new Map<string, Art>(),
  warnings: new Map<string, string[]>(),
  pending: new Set<string>(),
  icons: null as string[] | null,
};
let modelVersion = 0;

const hash = (s: string) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); };

function artKey(s: ClickexSpec): string {
  switch (s.source) {
    case 'svg': return `svg:${s.svg.text ? hash(s.svg.text) : s.svg.sample}`;
    case 'image': return s.image ? `img:${hash(s.image.dataUrl)}:${JSON.stringify(s.trace)}` : 'img:none';
    case 'icon': return `icon:${s.icon.name}:${s.icon.stroke}:${s.colors.ink}`;
    case 'text': return `text:${JSON.stringify(s.text)}:${s.colors.ink}`;
    default: return 'none';
  }
}

async function decode(dataUrl: string): Promise<RasterImage> {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const k = Math.min(1, 512 / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * k)), h = Math.max(1, Math.round(img.naturalHeight * k));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(img, 0, 0, w, h);
  return { width: w, height: h, data: g.getImageData(0, 0, w, h).data };
}

/** The artwork for the current source, or null while it is still being read. */
export function artFor(s: ClickexSpec): Art | null {
  const key = artKey(s);
  const hit = res.art.get(key);
  if (hit) return hit;
  const done = (art: Art, warnings: string[] = []) => { res.art.set(key, art); res.warnings.set(key, warnings); if (res.art.size > 40) res.art.delete(res.art.keys().next().value!); };
  const later = (run: () => Promise<void>) => { if (res.pending.has(key)) return; res.pending.add(key); run().catch((e) => say(`Could not read the design: ${(e as Error).message}`)).finally(() => { res.pending.delete(key); changed(); }); };
  switch (s.source) {
    case 'svg': {
      const r = s.svg.text ? artFromSvg(s.svg.text) : { art: sampleArt(s.svg.sample), warnings: [] };
      done(r.art, r.warnings);
      return r.art;
    }
    case 'image': {
      if (!s.image) return null;
      const raster = res.raster.get(hash(s.image.dataUrl));
      if (!raster) { later(() => decode(s.image!.dataUrl).then((r) => { res.raster.set(hash(s.image!.dataUrl), r); })); return null; }
      const r = artFromImage(raster, s.trace);
      done(r.art, r.warnings);
      return r.art;
    }
    case 'icon': later(() => artFromIcon(s.icon.name, s.icon.stroke, s.colors.ink).then((a) => { done(a); })); return null;
    case 'text': {
      const font = fontById(s.text.font);
      if (!font) { later(() => loadFont(s.text.font).then(() => undefined)); return null; }
      const a = artFromText(font, { text: s.text.text || ' ', font: s.text.font, size_mm: 10, tracking: s.text.tracking, kerning: true, line_height: s.text.lineHeight, align: 'center', arc_radius_mm: s.text.arc, weight_mm: s.text.weight, color: s.colors.ink }, s.colors.ink);
      done(a);
      return a;
    }
    default: return null;
  }
}

export const artWarnings = (s: ClickexSpec) => res.warnings.get(artKey(s)) ?? [];

// ---------------------------------------------------------------- live build
export interface Computed { built: BuiltClicker | null; plan: Plan | null; art: Art; ms: number; waiting: boolean; model: IndexedMesh | null }
let memo: { sig: string; value: Computed } | null = null;

export function compute(): Computed {
  const s = cx.spec;
  const art = s.source === 'blocks' || s.source === 'model' ? [] : artFor(s);
  const font = s.source === 'blocks' ? fontById(s.blocks.font) : undefined;
  if (s.source === 'blocks' && !font) loadFont(s.blocks.font).then(() => changed()).catch(() => undefined);
  const sig = JSON.stringify(s) + `|${modelVersion}|${art ? 'a' : 'w'}|${font ? 'f' : ''}|${res.art.size}`;
  if (memo?.sig === sig) return memo.value;
  const t0 = performance.now();
  let value: Computed;
  try {
    if (s.source === 'model') {
      const model = res.model ? scaledModel(res.model, s.model.scale) : null;
      value = { built: buildFromModel(s, model), plan: null, art: [], ms: 0, waiting: false, model };
    } else if (s.source === 'blocks') {
      const plan = planBlocks(s, font);
      value = { built: font ? buildClicker(s, plan) : null, plan, art: plan.art, ms: 0, waiting: !font, model: null };
    } else if (!art || !art.length) {
      value = { built: null, plan: null, art: art ?? [], ms: 0, waiting: !art, model: null };
    } else {
      const plan = planSingle(s, art);
      value = { built: buildClicker(s, plan), plan, art: plan.art, ms: 0, waiting: false, model: null };
    }
  } catch (e) {
    value = { built: null, plan: null, art: [], ms: 0, waiting: false, model: null };
    cx.toast = `Build failed: ${(e as Error).message}`;
  }
  value.ms = performance.now() - t0;
  memo = { sig, value };
  return value;
}

/** Colours of the current artwork (before the user's colour changes). */
export const designColors = (): string[] => { const s = cx.spec; const a = s.source === 'blocks' || s.source === 'model' ? [] : artFor(s) ?? []; return artColors(a); };

// ---------------------------------------------------------------- importing
export async function importImage(file: File) {
  const dataUrl: string = await new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.onerror = () => no(r.error); r.readAsDataURL(file); });
  const img = new Image(); img.src = dataUrl; await img.decode();
  // keep stored images small: 768 px on the long side, as PNG (keeps transparency)
  const k = Math.min(1, 768 / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas'); c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
  c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
  const small = c.toDataURL('image/png');
  edit((s) => { s.source = 'image'; s.image = { name: file.name, w: c.width, h: c.height, dataUrl: small }; s.name = file.name.replace(/\.[^.]+$/, '').slice(0, 40) || s.name; });
}

export async function importSvg(file: File) {
  const text = await file.text();
  edit((s) => { s.source = 'svg'; s.svg = { name: file.name, text, sample: s.svg.sample }; s.name = file.name.replace(/\.[^.]+$/, '').slice(0, 40) || s.name; });
}

export async function importModel(file: File) {
  const list = await loadModelFile(file.name, await file.arrayBuffer());
  const m = list.reduce((a, b) => (b.mesh.indices.length > a.mesh.indices.length ? b : a));
  setModel({ name: m.name, mesh: m.mesh });
  if (m.openEdges) say(`${m.name} has ${m.openEdges} open edges. Clickex needs a closed model for clean cuts.`);
}

export function setModel(a: ModelAsset) {
  const mesh = { vertices: new Float32Array(a.mesh.vertices), indices: a.mesh.indices };
  centreMesh(mesh);
  res.model = { name: a.name, mesh };
  modelVersion++;
  const [, , h] = modelSize(mesh);
  edit((s) => { s.source = 'model'; s.model.name = a.name; s.model.scale = 100; s.model.splitZ = Math.round(Math.max(14, Math.min(h - 10, h * 0.55))); s.name = a.name.slice(0, 40); });
}

export function useSampleModel(id: string) { setModel({ name: id[0].toUpperCase() + id.slice(1), mesh: sampleModel(id) }); }
export function turnModel(axis: 'x' | 'y' | 'z') { if (!res.model) return; res.model = rotateAsset(res.model, axis); modelVersion++; changed(); }

export const modelInfo = () => {
  if (!res.model) return null;
  const m = scaledModel(res.model, cx.spec.model.scale);
  return { name: res.model.name, tris: m.indices.length / 3, size: modelSize(m), open: openEdgeCount(res.model.mesh) };
};

// ---------------------------------------------------------------- colours
const hexRgb = (h: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
const dist = (a: string, b: string) => { const p = hexRgb(a), q = hexRgb(b); return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]); };

/** Colours that are not in the filament list move to the nearest loaded filament (a design opened for the first
 *  time picks up what is in the machine). */
export function snapToLoaded() {
  const fil = useStore.getState().filaments.filter((f) => !f.planned).map((f) => f.color);
  if (!fil.length) return;
  const all = useStore.getState().filaments.map((f) => f.color.toLowerCase());
  const near = (c: string) => (all.includes(c.toLowerCase()) ? c : fil.reduce((b, f) => (dist(f, c) < dist(b, c) ? f : b), fil[0]));
  const s = cx.spec;
  s.colors.base = near(s.colors.base); s.colors.button = near(s.colors.button); s.colors.ink = near(s.colors.ink);
  // base and button in different filaments when the machine has more than one
  if (fil.length > 1 && s.colors.button.toLowerCase() === s.colors.base.toLowerCase()) s.colors.button = fil.find((f) => f.toLowerCase() !== s.colors.base.toLowerCase())!;
  for (const c of designColors()) s.colors.map[c] = near(s.colors.map[c] ?? c);
}

/** Map every design colour to the nearest colour among the loaded filaments. */
export function matchFilaments() {
  const fil = useStore.getState().filaments.filter((f) => !f.planned).map((f) => f.color.toLowerCase());
  if (!fil.length) return;
  edit((s) => { for (const c of designColors()) s.colors.map[c] = fil.reduce((b, f) => (dist(f, c) < dist(b, c) ? f : b), fil[0]); });
}

/** Filament slot for a colour: the loaded one, else a planned slot ("load before printing"). */
const slotFor = (hex: string) => slotForFilament(hex);

/** Every filament colour the design uses. */
export function usedColours(s = cx.spec): string[] {
  const out = [s.colors.base, s.colors.button];
  if (s.source === 'icon' || s.source === 'text' || s.source === 'blocks') out.push(s.colors.ink);
  else for (const c of designColors()) out.push(s.colors.map[c] ?? c);
  return [...new Set(out.map((c) => c.toLowerCase()))];
}

registerFilamentLink({
  id: 'clickex',
  label: () => (opened ? `Clickex “${cx.spec.name || 'clicker'}”` : null),
  slotsUsed: (f) => { const u = new Set(usedColours()); return f.map((x, i) => (u.has(x.color.toLowerCase()) ? i : -1)).filter((i) => i >= 0); },
  follow: (from, to) => {
    const m = new Map<string, string>();
    from.forEach((f, i) => { if (to[i] && f.color.toLowerCase() !== to[i].color.toLowerCase()) m.set(f.color.toLowerCase(), to[i].color); });
    if (!m.size) return;
    const r = (c: string) => m.get(c.toLowerCase()) ?? c;
    const s = cx.spec;
    s.colors.base = r(s.colors.base); s.colors.button = r(s.colors.button); s.colors.ink = r(s.colors.ink);
    for (const k of Object.keys(s.colors.map)) s.colors.map[k] = r(s.colors.map[k]);
    for (const c of designColors()) if (!s.colors.map[c] && m.has(c.toLowerCase())) s.colors.map[c] = m.get(c.toLowerCase())!;
    changed();
  },
});

// ---------------------------------------------------------------- out: the plate
export const bedOf = () => printerById(useStore.getState().printerId).bed;

function objectOf(p: Part, name: string): SceneObject {
  const mesh = { vertices: new Float32Array(p.mesh.vertices), indices: p.mesh.indices };
  centreMesh(mesh);
  const slots = p.palette.map((c) => slotFor(c));
  const used = new Set<number>(p.slots);
  let paint: Uint8Array | undefined;
  if (used.size > 1 || (used.size === 1 && !used.has(0))) {
    paint = new Uint8Array(p.slots.length);
    // 0 keeps the object's own filament; other colours paint their slot (1-based)
    for (let t = 0; t < p.slots.length; t++) paint[t] = p.slots[t] === 0 ? 0 : slots[p.slots[t]] + 1;
  }
  return {
    id: newId(), name, mesh, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], openEdges: openEdgeCount(mesh),
    filament: slots[0], paint: paint ? { color: paint } : undefined,
    overrides: p.supports ? ({ enable_support: true } as SceneObject['overrides']) : undefined,
  };
}

/** Put the clicker's parts on the plate in print orientation: replaces what the last transfer placed. */
export function transferToPlate(label = 'Clickex'): { count: number; plate: string } | null {
  const c = compute();
  if (!c.built || !c.built.parts.length) { say('Nothing to place yet: pick a design first.'); return null; }
  const s = useStore.getState();
  s.checkpoint();
  const tx = beginTransfer('clickex', cx.placed);
  const gone = new Set(cx.placed);
  if (gone.size) s.set({ objects: s.objects.filter((o) => !gone.has(o.id)) });
  let st = useStore.getState();
  // an empty plate, or a new one
  let plate = st.plates.findIndex((_, i) => !st.plates[i].locked && !st.objects.some((o) => objectPlate(o, st.printerId, st.plates.length) === i));
  if (plate < 0) { addPlate(); plate = useStore.getState().plates.length - 1; }
  const objs = printParts(c.built).map((p) => centreOnBed(objectOf(p, `${label} · ${p.name}`), useStore.getState().printerId, plate));
  st = useStore.getState();
  st.set({ objects: [...st.objects, ...objs] });
  arrange(undefined, plate, objs.map((o) => o.id));
  st = useStore.getState();
  st.set({ activePlate: plate, selected: objs.map((o) => o.id), selectedPart: null, workspace: 'prepare' } as never);
  st.markDirty();
  cx.placed = objs.map((o) => o.id);
  endTransfer(tx, cx.placed, clickexProject(), (old) => { cx.placed = old; changed(false); });
  changed(false);
  return { count: objs.length, plate: useStore.getState().plates[plate].name };
}

export async function download3mf() {
  const c = compute();
  if (!c.built || !c.built.parts.length) { say('Nothing to download yet.'); return; }
  const bytes = await build3mf(cx.spec.name, printParts(c.built), bedOf());
  const blob = new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer], { type: 'model/3mf' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${(cx.spec.name || 'clicker').replace(/[^\w.-]+/g, '_')}.3mf`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

/** A small plain clicker (square base, no artwork) to test how the switch and boss fit before a long print. */
export function transferFitTest() {
  const keep = cx.spec;
  cx.spec = normalizeSpec({ ...JSON.parse(JSON.stringify(keep)), name: 'Clickex fit test', source: 'svg', svg: { name: '', text: '<svg viewBox="0 0 10 10"><rect width="10" height="10" fill="#2f2f33"/></svg>', sample: 'heart' } });
  cx.spec.shape = { ...cx.spec.shape, baseStyle: 'shape', baseShape: 'square', size: 26, designSize: 30, lockBase: false };
  cx.spec.keychain.enabled = false;
  cx.spec.colors.mode = 'color';
  memo = null;
  const r = transferToPlate('Fit test');
  cx.spec = keep;
  memo = null;
  changed();
  return r;
}

// ---------------------------------------------------------------- saved designs
export function savedDesigns(): ClickexSpec[] {
  try { return (JSON.parse(storage?.getItem(SAVED) ?? '[]') as ClickexSpec[]).map(normalizeSpec); } catch { return []; }
}
export function saveDesign() {
  const list = savedDesigns().filter((d) => d.name !== cx.spec.name);
  list.unshift(structuredClone(cx.spec));
  try { storage?.setItem(SAVED, JSON.stringify(list.slice(0, 40))); say(`Saved “${cx.spec.name}”.`); } catch { say('Could not save: browser storage is full.'); }
  changed(false);
}
export function openSaved(d: ClickexSpec) { cx.spec = normalizeSpec(structuredClone(d)); cx.tab = d.source === 'blocks' ? 'layout' : d.source === 'model' ? 'cut' : 'shape'; changed(); }
export function deleteSaved(name: string) { try { storage?.setItem(SAVED, JSON.stringify(savedDesigns().filter((d) => d.name !== name))); } catch { /* ignore */ } changed(false); }

// ---------------------------------------------------------------- project file
const b64 = (u: Uint8Array) => { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s: string) => { const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };

export function clickexProject() {
  const m = res.model;
  const model = m && m.mesh.vertices.length < 600000 ? { name: m.name, v: b64(new Uint8Array(m.mesh.vertices.buffer.slice(0))), i: b64(new Uint8Array(m.mesh.indices.buffer.slice(0))) } : undefined;
  return { spec: cx.spec, placed: cx.placed, model };
}

export function loadClickexProject(d: unknown) {
  const x = d as ReturnType<typeof clickexProject> | undefined;
  if (!x?.spec) return;
  cx.spec = normalizeSpec(x.spec);
  cx.placed = x.placed ?? [];
  if (x.model) {
    const v = unb64(x.model.v), i = unb64(x.model.i);
    res.model = { name: x.model.name, mesh: { vertices: new Float32Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength)), indices: new Uint32Array(i.buffer.slice(i.byteOffset, i.byteOffset + i.byteLength)) } };
    modelVersion++;
  }
  changed();
  undoHistory.reset();
}

export { meshBounds };

/** Plate → design: filaments changed on the plate objects this design placed come back into the design. */
export function applyPlateColours(objs: SceneObject[]) {
  const f = useStore.getState().filaments;
  for (const o of objs) {
    const c = o.filament !== undefined ? f[o.filament]?.color : undefined;
    if (!c) continue;
    if (/\bbase$/i.test(o.name)) cx.spec.colors.base = c;
    else if (/\bbutton( \d+)?$/i.test(o.name)) cx.spec.colors.button = c;
  }
  opened = true;
  changed();
}
/** The plate objects this design replaces on the next send. */
export function setPlaced(ids: string[]) { cx.placed = ids; }

registerMachineLink({
  id: 'clickex',
  label: () => (opened ? `Clickex “${cx.spec.name || 'clicker'}”` : null),
  adapt: (from, to) => {
    const changes: string[] = [], warnings: string[] = [];
    const wall = adaptWall('Button wall', cx.spec.body.wall, from, to, changes);
    const rim = adaptWall('Rim wall', cx.spec.body.rimWall, from, to, changes);
    const c = compute();
    if (c.built) { const w = bedWarning('The clicker', c.built.report.size, to); if (w) warnings.push(w); }
    return { changes, warnings, apply: () => edit((x) => { if (wall !== null) x.body.wall = wall; if (rim !== null) x.body.rimWall = rim; }) };
  },
  refresh: () => changed(),
});
