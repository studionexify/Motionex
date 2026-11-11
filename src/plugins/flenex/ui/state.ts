// Flenex UI state: the design, the cuts, the paint and the last build. A change schedules a rebuild
// (base model → cuts → colours); the Studio and the dock panel read the result.
import { useSyncExternalStore } from 'react';
import { newId, plateOrigin, useStore, type SceneObject } from '../../../state/store';
import { registerFilamentLink, slotForFilament } from '../../../state/holders';
import { effectiveNozzle } from '../../../profiles/resolve';
import { beginTransfer, endTransfer } from '../../../state/steps';
import { bedWarning, registerMachineLink } from '../../../state/machineSync';
import { fitFor } from '../fit';
import { centreOnBed } from '../../../state/ops';
import { centreMesh } from '../../../io/load';
import { openEdgeCount, type IndexedMesh } from '../../../engine/mesh';
import { printerById } from '../../../profiles/printers';
import { bounds, type V3 } from '../csg';
import type { Mark } from '../creature';
import type { Cut, CutReport } from '../flexi';
import { newCache, runBuild, type BuildRequest, type BuildResult } from '../build';
import type { FromWorker, ToWorker } from '../worker';
import { newGroup, type CutEdit, type CutGroup } from '../groups';
import { modelBvh } from '../flexi';
import type { MeshBVH } from 'three-mesh-bvh';
import { type CreatureDesign } from '../design';
import { designFromPreset, presetById } from '../presets';
import { applyPaint, PALETTE_DEFAULT, SCHEMES, type PaintOp } from '../paint';
import { machineFor, type MachineInfo } from '../fit';
import type { BedFit, CutOrientation } from '../place';
import type { JointKind } from '../joints';
import { build3mf } from '../export3mf';
import { saveFile } from '../../../platform';
import { createHistory } from '../../../ui/studio/history';

const KEY = 'nexspiro.flenex.v1';
const storage = typeof localStorage !== 'undefined' ? localStorage : null;

export type FxTab = 'design' | 'cuts' | 'paint' | 'print';
export type FxView = 'colour' | 'pieces' | 'plain';
export type FxTool = 'orbit' | 'place' | 'move' | 'trace' | 'brush' | 'bucket' | 'piece';
export type AxisMode = 'centreline' | 'local' | 'surface';

export interface FlenexUiState {
  source: 'creature' | 'import';
  design: CreatureDesign;
  presetId: string;
  cutsMode: 'auto' | 'manual';
  manualCuts: Cut[];
  /** Parts of an imported model, each with a centre line and a number of cuts. */
  groups: CutGroup[];
  selectedGroup: string | null;
  /** How a cut finds the direction square to the body while placing and dragging. */
  axisMode: AxisMode;
  importName: string;
  importRot: [number, number, number];
  importScale: number;
  palette: string[];
  paintOps: PaintOp[];
  tab: FxTab;
  view: FxView;
  tool: FxTool;
  selectedCut: string | null;
  orientation: CutOrientation;
  placeKind: JointKind;
  slot: number;
  brush: number;
  bucketAngle: number;
  /** Fit overrides (0 = from the machine). */
  clearance: number;
  gap: number;
  studioOpen: boolean;
  showCuts: boolean;
  showBed: boolean;
  /** Object ids this plugin placed on the plate (replaced on the next transfer). */
  placed: string[];
}

function load(): FlenexUiState {
  const design = designFromPreset(presetById('snake')!);
  const d: FlenexUiState = {
    source: 'creature', design, presetId: 'snake', cutsMode: 'auto', manualCuts: [], groups: [], selectedGroup: null, axisMode: 'centreline', importName: '', importRot: [0, 0, 0], importScale: 1,
    palette: PALETTE_DEFAULT.slice(), paintOps: SCHEMES[0].ops(1), tab: 'design', view: 'colour', tool: 'orbit', selectedCut: null, orientation: 'centreline', placeKind: 'ball',
    slot: 1, brush: 6, bucketAngle: 30, clearance: 0, gap: 0, studioOpen: false, showCuts: true, showBed: true, placed: [],
  };
  try {
    const s = JSON.parse(storage?.getItem(KEY) ?? 'null');
    if (s?.design?.version === 1) return { ...d, ...s, source: 'creature', importName: '', studioOpen: false, tool: 'orbit', manualCuts: s.cutsMode === 'manual' ? s.manualCuts ?? [] : [], groups: [], selectedGroup: null };
  } catch { /* fresh start */ }
  return d;
}

export const fx: FlenexUiState = load();
let version = 0;
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => { listeners.add(l); return () => listeners.delete(l); };
export const useFx = () => useSyncExternalStore(subscribe, () => version);

// ---------------------------------------------------------------- imported model (kept out of local storage)
let importedMesh: IndexedMesh | null = null;
let importId = 0;
export const hasImport = () => importedMesh !== null;

/** BVH of the base model for the pointer tools (cached per build). */
let bvhFor: IndexedMesh | null = null, bvhCache: MeshBVH | null = null;
export function baseBvh(): MeshBVH | null {
  if (!built) return null;
  if (bvhFor !== built.base) { bvhCache = modelBvh(built.base); bvhFor = built.base; }
  return bvhCache;
}
/** First click of "add a part": the start of the part's centre line. */
export let traceStart: { p: V3; sn: V3 } | null = null;
export const setTraceStart = (v: { p: V3; sn: V3 } | null): void => { traceStart = v; notify(); };

// ---------------------------------------------------------------- build result
export interface Built {
  /** Base solid (before cuts) and the finished flexi. */
  base: IndexedMesh;
  flexi: { mesh: IndexedMesh; triPiece: Int32Array; pieceCount: number; reports: CutReport[]; warnings: string[]; closed: boolean };
  paint: Uint8Array;
  spine?: V3[];
  marks: Mark[];
  cuts: Cut[];
  machine: MachineInfo;
  fit: BedFit;
  warnings: string[];
  ms: number;
}
export let built: Built | null = null;
export let building = false;
/** What the worker is doing right now, for the status line. */
export let statusText = '';
/** Bumped when the mesh changed (viewer rebuilds geometry); paint-only changes bump `paintVersion`. */
export let meshVersion = 0;
export let paintVersion = 0;
export let lastError = '';

const nozzleNow = () => { const s = useStore.getState(); return effectiveNozzle(s.printerId, s.machineOverrides); };
const machine = () => machineFor(useStore.getState().printerId, { clearance: fx.clearance || undefined, gap: fx.gap || undefined, nozzle: nozzleNow() });
export const currentMachine = machine;

export function notify(): void {
  try {
    const { manualCuts, groups, ...rest } = fx;
    void groups;
    storage?.setItem(KEY, JSON.stringify({ ...rest, manualCuts: fx.cutsMode === 'manual' && fx.source === 'creature' ? manualCuts : [], placed: [] }));
  } catch { /* storage full */ }
  version++;
  listeners.forEach((l) => l());
  undoHistory.touch();
}

/** The parts of the state undo / redo covers: the design, cuts, parts, paint and fit (not the view or tool). */
const undoable = () => ({ design: fx.design, presetId: fx.presetId, cutsMode: fx.cutsMode, manualCuts: fx.manualCuts, groups: fx.groups, palette: fx.palette, paintOps: fx.paintOps, clearance: fx.clearance, gap: fx.gap, importRot: fx.importRot, importScale: fx.importScale });
/** Undo / redo of the Flenex design (a drag or brush stroke is one step). */
export const undoHistory = createHistory(undoable, (s) => {
  const paintOnly = JSON.stringify({ ...undoable(), paintOps: null, palette: null }) === JSON.stringify({ ...s, paintOps: null, palette: null });
  Object.assign(fx, s);
  if (fx.selectedCut && !fx.manualCuts.some((c) => c.id === fx.selectedCut)) fx.selectedCut = null;
  if (fx.selectedGroup && !fx.groups.some((g) => g.id === fx.selectedGroup)) fx.selectedGroup = null;
  schedule(paintOnly);
});

// ---------------------------------------------------------------- worker
let worker: Worker | null = null;
let inflight = false;
let token = 0;
let pending: { token: number; resolve: (r: BuildResult) => void; reject: (e: Error) => void } | null = null;
const direct = newCache();

function spawn(): Worker {
  const w = new Worker(new URL('../worker.ts', import.meta.url), { type: 'module' });
  w.onmessage = (e: MessageEvent<FromWorker>) => {
    const m = e.data;
    if (m.type === 'progress') { if (m.token === token) { statusText = m.msg; listeners.forEach((l) => l()); } return; }
    if (!pending || pending.token !== m.token) return;
    const p = pending; pending = null; inflight = false;
    if (m.type === 'result') p.resolve(m.res); else p.reject(new Error(m.message));
  };
  w.onerror = (e) => { if (pending) { const p = pending; pending = null; inflight = false; p.reject(new Error(e.message || 'The build worker stopped.')); } };
  if (importedMesh) w.postMessage({ type: 'import', id: importId, vertices: importedMesh.vertices.slice(), indices: importedMesh.indices.slice() } satisfies ToWorker);
  return w;
}

function request(req: BuildRequest): Promise<BuildResult> {
  token++;
  if (typeof Worker === 'undefined') {
    if (importedMesh) direct.imports.set(importId, importedMesh);
    return runBuild(req, direct, (m) => { statusText = m; });
  }
  // a newer request supersedes the running one: restart the worker instead of waiting for it
  if (inflight && worker) { worker.terminate(); worker = null; pending?.reject(new Error('superseded')); pending = null; inflight = false; }
  worker ??= spawn();
  inflight = true;
  const t = token;
  return new Promise<BuildResult>((resolve, reject) => {
    pending = { token: t, resolve, reject };
    worker!.postMessage({ type: 'build', token: t, req } satisfies ToWorker);
  });
}

const requestNow = (): BuildRequest => ({
  source: fx.source, design: fx.design, importId, importRot: fx.importRot, importScale: fx.importScale, cutsMode: fx.cutsMode, manualCuts: fx.manualCuts, groups: fx.groups,
  printerId: useStore.getState().printerId, nozzle: nozzleNow(), clearance: fx.clearance, gap: fx.gap, paintOps: fx.paintOps,
});

let timer: ReturnType<typeof setTimeout> | undefined;
/** Rebuild after edits (debounced). `paintOnly` skips the geometry. */
export function schedule(paintOnly = false, delay = 200): void {
  notify();
  if (paintOnly && built) { repaint(); return; }
  clearTimeout(timer);
  building = true;
  listeners.forEach((l) => l());
  timer = setTimeout(() => { void rebuild(); }, delay);
}

function repaint(): void {
  if (!built) return;
  built.paint = applyPaint(fx.paintOps, { mesh: built.flexi.mesh, triPiece: built.flexi.triPiece, spine: built.spine, marks: built.marks });
  paintVersion++;
  notify();
}

export async function rebuild(): Promise<void> {
  building = true; statusText = 'Starting…';
  listeners.forEach((l) => l());
  try {
    const job = request(requestNow());
    const my = token;
    const r = await job;
    if (my !== token) return;
    built = {
      base: r.base, flexi: { mesh: r.mesh, triPiece: r.triPiece, pieceCount: r.pieceCount, reports: r.reports, warnings: r.warnings, closed: r.closed }, paint: r.paint, spine: r.spine, marks: r.marks,
      cuts: r.cuts, machine: machine(), fit: r.fit, warnings: r.warnings, ms: r.ms,
    };
    // creature: the automatic cuts become the editable list when the user starts editing by hand
    autoList = r.cuts;
    lastError = '';
    meshVersion++; paintVersion++;
    building = false; statusText = '';
    notify();
  } catch (e) {
    if ((e as Error).message === 'superseded') return;
    lastError = (e as Error).message; building = false; statusText = '';
    notify();
  }
}
/** The cuts of the last automatic build (what "Edit by hand" starts from). */
export let autoList: Cut[] = [];

// ---------------------------------------------------------------- edits
export const changed = () => schedule(false);

export function loadPreset(id: string): void {
  const def = presetById(id); if (!def) return;
  fx.source = 'creature'; importedMesh = null; fx.importName = '';
  fx.design = designFromPreset(def); fx.presetId = id; fx.cutsMode = 'auto'; fx.manualCuts = []; fx.selectedCut = null;
  schedule();
}

/** Switch to editing the cuts by hand: the automatic cuts become a list the user can change. */
export function freezeCuts(): void { if (built) fx.manualCuts = built.cuts.map((c) => structuredClone(c)); fx.cutsMode = 'manual'; schedule(); }
export function autoCutsAgain(): void { fx.cutsMode = 'auto'; fx.selectedCut = null; schedule(); }

export function addCut(c: Cut): void {
  if (fx.source === 'creature' && fx.cutsMode === 'auto') freezeCutsQuiet();
  fx.manualCuts = [...fx.manualCuts, c]; fx.selectedCut = c.id; schedule();
}
function freezeCutsQuiet() { if (built) fx.manualCuts = built.cuts.map((c) => structuredClone(c)); fx.cutsMode = 'manual'; }
export function removeCut(id: string): void { if (fx.cutsMode === 'auto' && fx.source === 'creature') freezeCutsQuiet(); fx.manualCuts = fx.manualCuts.filter((c) => c.id !== id); if (fx.selectedCut === id) fx.selectedCut = null; schedule(); }
export function editCut(id: string, f: (c: Cut) => void): void { if (fx.cutsMode === 'auto' && fx.source === 'creature') freezeCutsQuiet(); const c = fx.manualCuts.find((x) => x.id === id); if (c) f(c); schedule(); }
export const nextCutId = () => String(1 + Math.max(0, ...fx.manualCuts.map((c) => +c.id || 0)));

export async function importModel(name: string, mesh: IndexedMesh): Promise<void> {
  importedMesh = { vertices: mesh.vertices.slice(), indices: mesh.indices.slice() };
  importId++;
  worker?.postMessage({ type: 'import', id: importId, vertices: importedMesh.vertices.slice(), indices: importedMesh.indices.slice() } satisfies ToWorker);
  fx.source = 'import'; fx.importName = name; fx.importRot = [0, 0, 0]; fx.importScale = 1;
  fx.cutsMode = 'manual'; fx.manualCuts = []; fx.groups = []; fx.selectedGroup = null; fx.selectedCut = null; fx.tab = 'cuts'; fx.tool = 'place';
  schedule(false, 10);
  undoHistory.reset();
}

// ---------------------------------------------------------------- cut groups (parts of an imported model)
let groupSeq = 0;
export const newGroupId = () => `g${++groupSeq}${Math.random().toString(36).slice(2, 5)}`;
export function addPart(path: V3[], name?: string, count = 6): CutGroup {
  const g = newGroup(newGroupId(), name ?? `Part ${fx.groups.length + 1}`, path, { ...fx.design.segments.joint, kind: fx.placeKind }, count);
  fx.groups = [...fx.groups, g]; fx.selectedGroup = g.id; fx.cutsMode = 'manual'; schedule();
  return g;
}
export function editPart(id: string, f: (g: CutGroup) => void): void { const g = fx.groups.find((x) => x.id === id); if (g) { f(g); schedule(); } }
export function removePart(id: string): void { fx.groups = fx.groups.filter((g) => g.id !== id); if (fx.selectedGroup === id) fx.selectedGroup = null; schedule(); }
/** Re-space a part's cuts: edits to single cuts are forgotten. */
export function respacePart(id: string): void { editPart(id, (g) => { g.edits = {}; }); }

/** Edit any cut: a cut of a part is stored as an edit of that part (so it survives a new count), a free cut is changed in place. */
export function editAnyCut(c: Cut, patch: (e: CutEdit & { joint?: Cut['joint'] }) => void): void {
  if (c.group !== undefined) {
    const g = fx.groups.find((x) => x.id === c.group);
    if (g && c.index !== undefined) { const e = (g.edits[c.index] ??= {}); patch(e); schedule(); return; }
  }
  editCut(c.id, (x) => { const e: CutEdit & { joint?: Cut['joint'] } = { origin: x.origin, normal: x.normal, roll: x.roll, radius: x.radius, enabled: x.enabled, name: x.name, joint: x.joint }; patch(e); Object.assign(x, { origin: e.origin ?? x.origin, normal: e.normal ?? x.normal, roll: e.roll ?? x.roll, radius: e.radius ?? x.radius, enabled: e.enabled ?? x.enabled, name: e.name ?? x.name, joint: e.joint ?? x.joint }); });
}
export function removeAnyCut(c: Cut): void {
  if (c.group !== undefined) { editAnyCut(c, (e) => { e.deleted = true; }); if (fx.selectedCut === c.id) fx.selectedCut = null; return; }
  removeCut(c.id);
}

// ---------------------------------------------------------------- paint
export function setPaint(ops: PaintOp[]): void { fx.paintOps = ops; schedule(true); }
export function addPaint(op: PaintOp): void { fx.paintOps = [...fx.paintOps, op]; schedule(true); }
export function undoPaint(): void { if (fx.paintOps.length > 1) { fx.paintOps = fx.paintOps.slice(0, -1); schedule(true); } }
export function setPalette(i: number, hex: string): void { fx.palette = fx.palette.map((c, k) => (k === i ? hex : c)); notify(); }
export function addColour(hex = '#cccccc'): void { if (fx.palette.length < 16) { fx.palette = [...fx.palette, hex]; notify(); } }

export function coloursUsed(): number[] { return built ? Array.from(new Set(built.paint)).sort((a, b) => a - b) : [1]; }

// ---------------------------------------------------------------- output
function baseName() { return (fx.source === 'import' ? fx.importName.replace(/\.[^.]+$/, '') : fx.design.name) || 'flexi'; }

export async function export3mf(): Promise<string | null> {
  if (!built) return null;
  const mac = built.machine, b = bounds(built.flexi.mesh);
  const mesh = built.flexi.mesh, v = mesh.vertices.slice();
  for (let i = 0; i < v.length; i += 3) { v[i] -= (b.min[0] + b.max[0]) / 2; v[i + 1] -= (b.min[1] + b.max[1]) / 2; v[i + 2] -= b.min[2]; }
  const bytes = await build3mf({ name: baseName(), mesh: { vertices: v, indices: mesh.indices }, paint: built.paint, palette: fx.palette, place: [mac.bed.x / 2, mac.bed.y / 2], printerName: `${mac.printer.vendor} ${mac.printer.model}` });
  return saveFile(`${baseName().replace(/[^\w.-]+/g, '_')}.3mf`, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, '3mf');
}

/** Filament slot for a palette colour: the loaded one, else a planned slot ("load before printing"). */
const slotFor = (hex: string) => slotForFilament(hex);

/** Palette taken from the machine: the loaded filaments in slot order (a first-opened design). */
function paletteFromMachine() {
  const loaded = useStore.getState().filaments.filter((f) => !f.planned).map((f) => f.color);
  if (!loaded.length) return;
  const pal = loaded.slice(0, 16);
  for (const c of PALETTE_DEFAULT) { if (pal.length >= 2) break; if (!pal.some((x) => x.toLowerCase() === c.toLowerCase())) pal.push(c); }
  fx.palette = pal;
}
let opened = false;

registerFilamentLink({
  id: 'flenex',
  label: () => (opened ? `Flenex “${baseName()}”` : null),
  slotsUsed: (f) => { const u = new Set(coloursUsed().map((k) => (fx.palette[k - 1] ?? '').toLowerCase())); return f.map((x, i) => (u.has(x.color.toLowerCase()) ? i : -1)).filter((i) => i >= 0); },
  follow: (from, to) => {
    let hit = false;
    fx.palette = fx.palette.map((c) => { const i = from.findIndex((f) => f.color.toLowerCase() === c.toLowerCase()); if (i >= 0 && to[i] && to[i].color.toLowerCase() !== c.toLowerCase()) { hit = true; return to[i].color; } return c; });
    if (hit) notify();
  },
});

/** Put the flexi on the plate (centred, painted with filament slots) and open Prepare. */
export function sendToPlate(): { objects: number; colours: number } | null {
  if (!built) return null;
  const s = useStore.getState();
  s.checkpoint();
  const tx = beginTransfer('flenex', fx.placed);
  s.set({ objects: s.objects.filter((o) => !fx.placed.includes(o.id)), selected: [] });
  const mesh = { vertices: built.flexi.mesh.vertices.slice(), indices: built.flexi.mesh.indices.slice() };
  centreMesh(mesh);
  const used = coloursUsed();
  const slotOf = new Map<number, number>(used.map((u) => [u, slotFor(fx.palette[u - 1] ?? '#808080')]));
  const colour = new Uint8Array(built.paint.length);
  for (let t = 0; t < colour.length; t++) colour[t] = (slotOf.get(built.paint[t]) ?? 0) + 1;
  const o: SceneObject = {
    id: newId(), name: `Flenex · ${baseName()}`, mesh, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], openEdges: openEdgeCount(mesh),
    filament: slotOf.get(used[0]) ?? 0, paint: used.length > 1 ? { color: colour } : undefined, printable: true,
  };
  const placed = centreOnBed(o, s.printerId, s.activePlate);
  useStore.setState({ objects: [...useStore.getState().objects, placed], selected: [placed.id] });
  fx.placed = [placed.id];
  endTransfer(tx, fx.placed, projectData(), (old) => { fx.placed = old; notify(); });
  s.set({ workspace: 'prepare' } as never);
  s.markDirty();
  fx.studioOpen = false;
  notify();
  return { objects: 1, colours: used.length };
}

export function openStudio(open = true): void {
  fx.studioOpen = open;
  if (open && !opened) { opened = true; paletteFromMachine(); undoHistory.reset(); }
  if (open && !built) schedule(false, 10);
  notify();
}

export function setPrinter(id: string): void {
  const s = useStore.getState(), p = printerById(id);
  s.set({ printerId: p.id, plate: p.plates.some((x) => x.type === s.plate) ? s.plate : p.plates[0].type, machineOverrides: {} });
  s.markDirty();
  schedule();
}

export const projectData = () => ({ design: fx.design, presetId: fx.presetId, cutsMode: fx.cutsMode, manualCuts: fx.manualCuts, groups: fx.groups, palette: fx.palette, paintOps: fx.paintOps, source: fx.source === 'creature' ? 'creature' : 'creature', clearance: fx.clearance, gap: fx.gap });
export function loadProject(data: unknown): void {
  const d = data as Partial<FlenexUiState> | undefined;
  if (!d?.design || d.design.version !== 1) return;
  Object.assign(fx, { design: d.design, presetId: d.presetId ?? fx.presetId, cutsMode: d.cutsMode ?? 'auto', manualCuts: d.manualCuts ?? [], groups: d.groups ?? [], palette: d.palette ?? fx.palette, paintOps: d.paintOps ?? fx.paintOps, clearance: d.clearance ?? 0, gap: d.gap ?? 0, source: 'creature' });
  schedule();
  undoHistory.reset();
}

void plateOrigin;

/** Plate → design: the flexi's main filament changed on the plate becomes its first colour. */
export function applyPlateColours(objs: SceneObject[]) {
  const o = objs[0], c = o?.filament !== undefined ? useStore.getState().filaments[o.filament]?.color : undefined;
  const used = coloursUsed();
  if (c && used.length) fx.palette = fx.palette.map((x, i) => (i === used[0] - 1 ? c : x));
  opened = true;
  notify();
}
export function setPlaced(ids: string[]) { fx.placed = ids; }

registerMachineLink({
  id: 'flenex',
  label: () => (opened ? `Flenex “${baseName()}”` : null),
  adapt: (from, to) => {
    const changes: string[] = [], warnings: string[] = [];
    if (!fx.clearance) {
      const a = fitFor(from.nozzle).clearance, b = fitFor(to.nozzle).clearance;
      if (Math.abs(a - b) > 0.005) changes.push(`Joint clearance ${a.toFixed(2)} → ${b.toFixed(2)} mm (follows the nozzle)`);
    }
    if (built) { const v = built.flexi.mesh.vertices; const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]; for (let i = 0; i < v.length; i++) { lo[i % 3] = Math.min(lo[i % 3], v[i]); hi[i % 3] = Math.max(hi[i % 3], v[i]); } const w = bedWarning('The flexi', [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]], to); if (w) warnings.push(w); }
    return { changes, warnings };
  },
  refresh: () => schedule(),
});
