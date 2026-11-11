// Plantex UI state: the design being edited (in the full-screen studio), the user's design library, and
// Transfer to plate: build every part at full quality, colour it, and lay the parts out on plates by
// filament.
import { useSyncExternalStore } from 'react';
import { centreMesh } from '../../../io/load';
import { openEdgeCount } from '../../../engine/mesh';
import { addPlate, arrange, centreOnBed } from '../../../state/ops';
import { isOutOfBounds, newId, objectPlate, useStore, type SceneObject } from '../../../state/store';
import { printerById } from '../../../profiles/printers';
import { filamentById } from '../../../profiles/filaments';
import { buildBody, buildInsert, buildSaucer, type BuildResult } from '../mesh';
import { defaultSpec, normalizeSpec, type PlantexSpec } from '../model';
import { paintBody } from '../paint';
import { patternMask } from '../patternLink';
import { autoChanges } from '../../../profiles/changer';
import { registerFilamentLink } from '../../../state/holders';
import { beginTransfer, endTransfer } from '../../../state/steps';
import { adaptWall, registerMachineLink } from '../../../state/machineSync';
import { createHistory } from '../../../ui/studio/history';

const KEY = 'nexspiro.plantex.v1';
const storage = typeof localStorage !== 'undefined' ? localStorage : null;

export interface SavedDesign { id: string; name: string; spec: PlantexSpec }

export interface PlantexState {
  spec: PlantexSpec;
  /** Scene objects made by the last transfer (replaced by the next one). */
  placed: string[];
  studioOpen: boolean;
  /** Studio preview at full quality instead of the fast draft. */
  fullPreview: boolean;
  designs: SavedDesign[];
  warnings: string[];
  /** Summary of the last transfer, one line per plate. */
  lastTransfer: string;
  /** Texture layer open in the editor. */
  openLayer: string | null;
}

function load(): PlantexState {
  const d: PlantexState = { spec: defaultSpec(), placed: [], studioOpen: false, fullPreview: false, designs: [], warnings: [], lastTransfer: '', openLayer: null };
  try {
    const s = JSON.parse(storage?.getItem(KEY) ?? 'null');
    if (s) return { ...d, ...s, studioOpen: false, spec: normalizeSpec(s.spec ?? {}), designs: (s.designs ?? []).map((x: SavedDesign) => ({ ...x, spec: normalizeSpec(x.spec) })) };
  } catch { /* fresh start */ }
  return d;
}

export const pt: PlantexState = load();
let version = 0;
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export const usePt = () => useSyncExternalStore(subscribe, () => version);
/** Bumped whenever the design geometry may have changed (the studio preview rebuilds on it). */
export let geometryVersion = 0;

function persist() {
  try { storage?.setItem(KEY, JSON.stringify({ spec: pt.spec, placed: pt.placed, fullPreview: pt.fullPreview, designs: pt.designs, lastTransfer: pt.lastTransfer })); } catch { /* storage unavailable */ }
}

/** After an edit: save and redraw (the studio rebuilds its preview when `geometry` is set). */
export function changed(geometry = true) {
  if (geometry) geometryVersion++;
  persist();
  version++;
  listeners.forEach((l) => l());
  undoHistory.touch();
}

/** Undo / redo of the pot design (a drag is one step). */
export const undoHistory = createHistory(() => pt.spec, (spec) => { pt.spec = spec; changed(); });

export const masks = (key: string) => patternMask(key);

export function openStudio(open = true) { pt.studioOpen = open; if (open) opened = true; changed(false); }
let opened = false;

/** Slots the design uses. */
export function designSlots(spec = pt.spec): number[] {
  const planter = spec.kind === 'planter' && !spec.vaseMode;
  return [...new Set([spec.filaments.body, ...(planter && spec.saucer.enabled ? [spec.filaments.saucer] : []), ...(planter && spec.selfWater.enabled ? [spec.filaments.insert] : []), ...spec.textures.filter((t) => t.enabled && t.filament >= 0).map((t) => t.filament)])];
}

registerFilamentLink({
  id: 'plantex',
  label: () => (opened ? `Plantex “${pt.spec.name || 'planter'}”` : null),
  slotsUsed: () => designSlots(),
  remap: (map) => {
    const f = pt.spec.filaments, m = (k: number) => map[k] ?? 0;
    f.body = m(f.body); f.saucer = m(f.saucer); f.insert = m(f.insert);
    for (const t of pt.spec.textures) if (t.filament >= 0) t.filament = m(t.filament);
    changed();
  },
});

const SLOT_COLORS = ['#5DBE7A', '#E85D4A', '#3D7DD8', '#F2C14E', '#2F2F33', '#F4F1EA', '#9B59B6', '#F28C28'];
/** Make sure filament slots 0..k exist (new ones copy slot 1's filament with a distinct colour). */
export function ensureSlot(k: number) {
  const s = useStore.getState();
  if (k < s.filaments.length) return;
  const base = s.filaments[0];
  // a design that refers to a slot the machine does not have: planned slots ("load before printing")
  const add = Array.from({ length: k + 1 - s.filaments.length }, (_, j) => ({ presetId: base?.presetId ?? 'generic-pla', color: SLOT_COLORS[(s.filaments.length + j) % SLOT_COLORS.length], planned: true }));
  s.set({ filaments: [...s.filaments, ...add] });
  s.markDirty();
}

/** One separate printable part of the design. */
export interface PartBuild { key: 'body' | 'saucer' | 'insert'; label: string; filament: number; result: BuildResult; paint?: Uint8Array }

export function buildParts(spec: PlantexSpec, draft: boolean): PartBuild[] {
  const out: PartBuild[] = [];
  const body = buildBody(spec, masks, draft);
  out.push({ key: 'body', label: spec.name, filament: spec.filaments.body, result: body, paint: paintBody(body.mesh, spec, masks) });
  const planter = spec.kind === 'planter' && !spec.vaseMode;
  if (planter && spec.saucer.enabled) out.push({ key: 'saucer', label: `${spec.name} saucer`, filament: spec.filaments.saucer, result: buildSaucer(spec, draft) });
  if (planter && spec.selfWater.enabled) out.push({ key: 'insert', label: `${spec.name} insert`, filament: spec.filaments.insert, result: buildInsert(spec, masks, draft) });
  return out;
}

/** Filament slots a part prints with (its own plus any painted ones). */
export const slotsOf = (p: Pick<PartBuild, 'filament' | 'paint'>) =>
  [...new Set([p.filament, ...(p.paint ? [...new Set(p.paint)].filter((c) => c > 0).map((c) => c - 1) : [])])].sort((a, b) => a - b);

/**
 * Build every part at full quality and put them on plates. Parts share a plate only when they print with
 * exactly the same filament slots, so different colours and different materials go to different plates.
 * Each plate is auto-arranged; parts that do not fit spill onto new plates. Replaces the previous transfer
 * unless `asNew`.
 */
export function transferToPlate(asNew = false): string[] {
  const spec = pt.spec;
  const parts = buildParts(spec, false);
  const warnings = parts.flatMap((p) => p.result.warnings);
  let s = useStore.getState();
  const ams = autoChanges(printerById(s.printerId).machine);
  if (!ams && parts.some((p) => slotsOf(p).length > 1)) warnings.push('This printer has no AMS: multi-colour parts pause for a manual filament swap at each colour change.');
  let nSlots = s.filaments.length;
  const need = Math.max(...parts.flatMap(slotsOf));
  if (need >= nSlots) { ensureSlot(need); s = useStore.getState(); nSlots = s.filaments.length; }
  const typeOf = (k: number) => filamentById(s.filaments[Math.min(k, nSlots - 1)]?.presetId ?? '')?.type ?? 'PLA';
  // one plate per filament set: different colours and different materials never share a plate
  const keyOf = (p: PartBuild) => slotsOf(p).map((k) => `filament ${k + 1} (${typeOf(k)} ${s.filaments[k]?.color ?? ''})`).join(' + ');

  s.checkpoint();
  const tx = beginTransfer('plantex', asNew ? [] : pt.placed);
  if (!asNew && pt.placed.length) {
    const gone = new Set(pt.placed);
    s.set({ objects: s.objects.filter((o) => !gone.has(o.id)) });
  }
  const groups = new Map<string, PartBuild[]>();
  for (const p of parts) { const k = keyOf(p); const l = groups.get(k); if (l) l.push(p); else groups.set(k, [p]); }

  const home = useStore.getState().activePlate;
  const used = new Set<number>();
  const freePlate = (): number => {
    const st = useStore.getState();
    for (let i = 0; i < st.plates.length; i++) {
      if (used.has(i) || st.plates[i].locked) continue;
      if (!st.objects.some((o) => objectPlate(o, st.printerId, st.plates.length) === i)) return i;
    }
    addPlate();
    return useStore.getState().plates.length - 1;
  };
  const placed: string[] = [];
  const lines: string[] = [];
  // the active plate takes the first group, unless something else is already on it
  let first = !useStore.getState().objects.some((o) => objectPlate(o, useStore.getState().printerId, useStore.getState().plates.length) === home);
  for (const [key, list] of groups) {
    let queue = list.map((p): SceneObject => {
      const mesh = p.result.mesh;
      centreMesh(mesh);
      return {
        id: newId(), name: p.label, mesh, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
        openEdges: openEdgeCount(mesh), filament: p.filament, paint: p.paint ? { color: p.paint } : undefined,
      };
    });
    while (queue.length) {
      const plate = first ? home : freePlate();
      first = false;
      used.add(plate);
      const objs = queue.map((o) => centreOnBed(o, useStore.getState().printerId, plate));
      s = useStore.getState();
      s.set({ objects: [...s.objects, ...objs] });
      arrange(undefined, plate, objs.map((o) => o.id));
      s = useStore.getState();
      // what did not fit moves on to the next plate (a lone part that is too big stays and is flagged)
      const off = (o: SceneObject) => isOutOfBounds(s.objects.find((x) => x.id === o.id)!, s.printerId, s.plates.length);
      const over = objs.length > 1 ? objs.slice(1).filter(off) : [];
      if (over.length) { const ids = new Set(over.map((o) => o.id)); s.set({ objects: s.objects.filter((o) => !ids.has(o.id)) }); }
      const keep = objs.filter((o) => !over.includes(o));
      placed.push(...keep.map((o) => o.id));
      lines.push(`${s.plates[plate].name}: ${keep.map((o) => o.name).join(', ')} — ${key}`);
      queue = over.map((o) => ({ ...o, position: [0, 0, 0] }));
    }
  }
  s = useStore.getState();
  for (const o of s.objects) if (placed.includes(o.id)) {
    if (isOutOfBounds(o, s.printerId, s.plates.length)) warnings.push(`${o.name} is larger than the build plate.`);
    if (o.openEdges) warnings.push(`${o.name} has ${o.openEdges} open edges.`);
  }
  // spiral vase mode follows the design
  if (!!s.overrides.spiral_mode !== spec.vaseMode) s.set({ overrides: { ...s.overrides, spiral_mode: spec.vaseMode } });
  s.set({ activePlate: home, selected: placed, selectedPart: null });
  s.markDirty();
  pt.placed = asNew ? [...pt.placed, ...placed] : placed;
  endTransfer(tx, placed, plantexProject(), (old) => { pt.placed = old; changed(false); });
  pt.warnings = warnings;
  pt.lastTransfer = lines.join('\n');
  changed(false);
  return placed;
}

export function loadSpec(spec: Partial<PlantexSpec>) {
  pt.spec = normalizeSpec(structuredClone(spec));
  pt.openLayer = null;
  pt.warnings = [];
  changed();
}

export function saveDesign(name: string) {
  pt.designs = [...pt.designs, { id: newId(), name, spec: structuredClone({ ...pt.spec, name }) }];
  changed(false);
}

export function deleteDesign(id: string) {
  pt.designs = pt.designs.filter((d) => d.id !== id);
  changed(false);
}

/** Project file data. */
export const plantexProject = () => ({ spec: pt.spec, placed: pt.placed });
export function loadPlantexProject(d: unknown) {
  const x = d as Partial<ReturnType<typeof plantexProject>> | undefined;
  if (!x) return;
  if (x.spec) pt.spec = normalizeSpec(x.spec);
  pt.placed = x.placed ?? [];
  changed();
  undoHistory.reset();
}

/** Plate → design: a part whose filament was changed on the plate takes that slot in the design. */
export function applyPlateColours(objs: SceneObject[]) {
  const f = pt.spec.filaments, name = pt.spec.name;
  for (const o of objs) {
    if (o.filament === undefined) continue;
    if (o.name === `${name} saucer`) f.saucer = o.filament;
    else if (o.name === `${name} insert`) f.insert = o.filament;
    else if (o.name === name) f.body = o.filament;
  }
  opened = true;
  changed();
}
export function setPlaced(ids: string[]) { pt.placed = ids; }

registerMachineLink({
  id: 'plantex',
  label: () => (opened ? `Plantex “${pt.spec.name || 'planter'}”` : null),
  adapt: (from, to) => {
    const changes: string[] = [], sp = pt.spec;
    // spiral vase mode prints one line: its wall follows the line width by itself
    const wall = sp.vaseMode ? null : adaptWall('Wall', sp.wall, from, to, changes);
    const saucer = sp.saucer.enabled ? adaptWall('Saucer wall', sp.saucer.wall, from, to, changes) : null;
    const insert = sp.selfWater.enabled ? adaptWall('Insert wall', sp.selfWater.wall, from, to, changes) : null;
    return { changes, warnings: [], apply: () => { if (wall !== null) sp.wall = wall; if (saucer !== null) sp.saucer.wall = saucer; if (insert !== null) sp.selfWater.wall = insert; changed(); } };
  },
  refresh: () => changed(),
});
