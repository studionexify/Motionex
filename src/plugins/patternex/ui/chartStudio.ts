// Patternex Studio state: the chart being edited, which object it sits on, editor tool, undo history.
// Edits go to the model live: once the chart is placed, every change rewrites its pattern, placement and
// region actions (the main viewport and the slicer read the same data).
import * as THREE from 'three';
import { useSyncExternalStore } from 'react';
import { objectMatrix, useStore, worldBounds, type SceneObject } from '../../../state/store';
import { printerById } from '../../../profiles/printers';
import { autoChanges } from '../../../profiles/changer';
import { BASE, chartActions, chartPreset, chartToPattern, normalizeChart, type ChartSpec } from '../chart';
import { newPlacement, type Pattern } from '../model';
import type { V3 } from '../projection';
import { addPattern, type ObjPlacement } from './state';
import { changed, px } from './PatternexPanel';

export type ChartTool = 'pen' | 'fill' | 'pick';

export interface ChartStudioState {
  open: boolean;
  spec: ChartSpec;
  objectId: string | null;
  /** The chart's placement on the object, once placed. */
  placementId: string | null;
  tool: ChartTool;
  /** Paint value: 0-based slot, or BASE (eraser). */
  paint: number;
  /** Filament slot → colour shown instead (library hover preview). */
  hover: { slot: number; hex: string } | null;
  undo: ChartSpec[];
  redo: ChartSpec[];
  /** Chart pixels per cell in the editor; 0 = fit the editor. */
  zoom: number;
}

export const cs: ChartStudioState = {
  open: false, spec: chartPreset('nordic'), objectId: null, placementId: null, tool: 'pen', paint: 1, hover: null, undo: [], redo: [], zoom: 0,
};

let version = 0;
const subs = new Set<() => void>();
export const notifyChart = () => { version++; subs.forEach((f) => f()); };
export const useChartStudio = () => useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => version);

const SAVED_KEY = 'nexspiro.patternex.charts.v1';
export function savedCharts(): ChartSpec[] {
  try { const l = JSON.parse(localStorage.getItem(SAVED_KEY) ?? '[]'); return Array.isArray(l) ? l.map(normalizeChart) : []; } catch { return []; }
}
export function saveChart(s: ChartSpec): void {
  try { const l = savedCharts().filter((x) => x.name !== s.name); localStorage.setItem(SAVED_KEY, JSON.stringify([...l, s])); } catch { /* storage full or off */ }
}
export function deleteSavedChart(name: string): void {
  try { localStorage.setItem(SAVED_KEY, JSON.stringify(savedCharts().filter((x) => x.name !== name))); } catch { /* storage off */ }
}

/** The object the Studio works on: the remembered one, the selection, else the first object. */
export function targetObject(): SceneObject | undefined {
  const s = useStore.getState();
  return s.objects.find((o) => o.id === cs.objectId) ?? s.objects.find((o) => o.id === s.selected[0]) ?? s.objects[0];
}

const chartPlacementOf = (objectId: string) => px.placements.find((p) => p.object_id === objectId && px.patterns.find((x) => x.id === p.pattern_id)?.meta?.kind === 'chart');

/** Open the Studio on an object; loads its chart if it has one. */
export function openPatternexStudio(open = true): void {
  if (open) {
    const o = targetObject();
    cs.objectId = o?.id ?? null;
    loadFromObject();
    cs.undo = []; cs.redo = [];
  }
  cs.open = open;
  cs.hover = null;
  notifyChart();
}

function loadFromObject(): void {
  const pl = cs.objectId ? chartPlacementOf(cs.objectId) : undefined;
  const pat = pl && px.patterns.find((x) => x.id === pl.pattern_id);
  if (pl && pat?.meta?.kind === 'chart') { cs.spec = normalizeChart(pat.meta.spec); cs.placementId = pl.id; }
  else cs.placementId = null;
}

export function setTarget(objectId: string): void {
  cs.objectId = objectId;
  const had = cs.spec;
  loadFromObject();
  if (!cs.placementId) cs.spec = had; // keep the chart being drawn; it is placed on the new object on request
  notifyChart();
}

/** Wrap geometry of an object in plate/world mm: axis centre, radius, base height. */
export function wrapGeometry(o: SceneObject) {
  const b = worldBounds(o);
  const cx = (b.min[0] + b.max[0]) / 2, cy = (b.min[1] + b.max[1]) / 2;
  const R = Math.max(1, Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1]) / 2);
  return { cx, cy, R, zMin: b.min[2], zMax: b.max[2], yMin: b.min[1], circumference: 2 * Math.PI * R, width: b.max[0] - b.min[0] };
}

const patternId = (placementId: string) => `chart-${placementId}`;

/** Placement fields for the chart on `o` (object-local), wrap or front. */
function placementFor(o: SceneObject, s: ChartSpec): Pick<ObjPlacement, 'position_xyz' | 'projection' | 'projection_axis' | 'axis_origin' | 'anchor_normal'> {
  const g = wrapGeometry(o);
  const inv = objectMatrix(o).invert();
  const loc = (v: V3) => new THREE.Vector3(...v).applyMatrix4(inv).toArray() as V3;
  const dir = (v: V3) => new THREE.Vector3(...v).transformDirection(inv).normalize().toArray() as V3;
  const z = g.zMin + s.startZ;
  if (s.projection === 'wrap') {
    return { position_xyz: loc([g.cx, g.cy - g.R, z]), projection: 'cylindrical', projection_axis: dir([0, 0, 1]), axis_origin: loc([g.cx, g.cy, g.zMin]), anchor_normal: dir([0, -1, 0]) };
  }
  return { position_xyz: loc([g.cx, g.yMin, z]), projection: 'planar', projection_axis: dir([0, -1, 0]), axis_origin: undefined, anchor_normal: dir([0, -1, 0]) };
}

let pending: ReturnType<typeof setTimeout> | null = null;
/**
 * Write the chart to the model: rebuild its pattern, move the placement, replace its region actions.
 * Debounced so typing or a paint stroke records one undo step on the model.
 */
export function syncToModel(now = false): void {
  if (!cs.placementId) return;
  if (pending) clearTimeout(pending);
  const run = () => {
    pending = null;
    const o = useStore.getState().objects.find((x) => x.id === cs.objectId);
    const i = px.placements.findIndex((p) => p.id === cs.placementId);
    if (!o || i < 0) { cs.placementId = null; notifyChart(); return; }
    const g = wrapGeometry(o);
    const pat = addPattern(px, chartToPattern(cs.spec, g.circumference, patternId(cs.placementId!)));
    px.placements[i] = { ...px.placements[i], ...placementFor(o, cs.spec), pattern_id: pat.id, rotation: 0, scale_xy: [1, 1], flip: false };
    px.actions = [...px.actions.filter((a) => a.region_ref.placement_id !== cs.placementId), ...chartActions(cs.placementId!, cs.spec, ams())];
    changed(true, true);
  };
  if (now) run(); else pending = setTimeout(run, 160);
}

const ams = () => autoChanges(printerById(useStore.getState().printerId).machine);

/** Put the chart on the target object. */
export function placeChart(): boolean {
  const o = targetObject();
  if (!o) return false;
  cs.objectId = o.id;
  const old = chartPlacementOf(o.id);
  if (old) { cs.placementId = old.id; syncToModel(true); notifyChart(); return true; }
  const id = `pl${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const g = wrapGeometry(o);
  const pat: Pattern = addPattern(px, chartToPattern(cs.spec, g.circumference, patternId(id)));
  const base = newPlacement(id, pat, `${o.id}:chart`, [0, 0, 0], [0, -1, 0]);
  px.placements.push({ ...base, ...placementFor(o, cs.spec), object_id: o.id });
  px.actions.push(...chartActions(id, cs.spec, ams()));
  px.selected = id;
  cs.placementId = id;
  changed(true, true);
  notifyChart();
  return true;
}

export function removeChart(): void {
  if (!cs.placementId) return;
  const id = cs.placementId;
  px.placements = px.placements.filter((p) => p.id !== id);
  px.actions = px.actions.filter((a) => a.region_ref.placement_id !== id);
  if (px.selected === id) px.selected = null;
  cs.placementId = null;
  changed(true, true);
  notifyChart();
}

/** Replace the chart (records an editor undo step), then update the model. */
export function setSpec(next: ChartSpec, opts: { history?: boolean; sync?: boolean } = {}): void {
  if (next === cs.spec) return;
  if (opts.history !== false) { cs.undo.push(cs.spec); if (cs.undo.length > 200) cs.undo.shift(); cs.redo = []; }
  cs.spec = next;
  notifyChart();
  if (opts.sync !== false) syncToModel();
}
export const patchSpec = (patch: Partial<ChartSpec>) => setSpec(normalizeChart({ ...cs.spec, ...patch }));

export function undoChart(): void {
  const prev = cs.undo.pop();
  if (!prev) return;
  cs.redo.push(cs.spec); cs.spec = prev; notifyChart(); syncToModel();
}
export function redoChart(): void {
  const next = cs.redo.pop();
  if (!next) return;
  cs.undo.push(cs.spec); cs.spec = next; notifyChart(); syncToModel();
}

export const setTool = (t: ChartTool) => { cs.tool = t; notifyChart(); };
export const setPaint = (v: number) => { cs.paint = v; if (cs.tool === 'pick') cs.tool = 'pen'; notifyChart(); };
export const setHover = (h: ChartStudioState['hover']) => { cs.hover = h; notifyChart(); };
export const setZoom = (z: number) => { cs.zoom = z <= 0 ? 0 : Math.max(5, Math.min(40, Math.round(z))); notifyChart(); };

/** Colour of a cell value with the current filaments (and library hover). `base` = the object's own colour. */
export function valueColour(v: number, filaments: { color: string }[], base: string): string {
  if (v === BASE) return base;
  if (cs.hover && cs.hover.slot === v) return cs.hover.hex;
  return filaments[v]?.color ?? '#888888';
}
