// Bridges the store and the slicer worker.
import { findOverhangs, overhangMessage } from '../engine/overhangCheck';
import * as THREE from 'three';
import { transformVertices } from '../engine/mesh';
import type { MeshInput, SliceOutput } from '../engine/types';
import { filamentSlots, resolveConfig, slotOverrides } from '../profiles/resolve';
import { effectiveFlush } from '../profiles/flush';
import { faceSetsOf, pluginConfigs } from '../plugins/registry';
import { objectMatrix, objectPlate, partWorldMatrix, plateOrigin, useStore, type SceneObject } from './store';
import { advancedSliceConfig } from './advanced';
import { printerById } from '../profiles/printers';
import { startWorker, workerFailure } from '../workers';

let worker: Worker | null = null;
let seq = 0;
let pending: ((r: SliceOutput | null) => void) | null = null;

/** Settings for slicing a plate: the global ones with the plate's own bed type and spiral vase on top. */
export function currentConfig(plateIndex = useStore.getState().activePlate) {
  const s = useStore.getState();
  const pl = s.plates[plateIndex];
  const overrides = pl?.spiralVase === undefined ? s.overrides : { ...s.overrides, spiral_mode: pl.spiralVase };
  const plateOv = { ...(pl?.printSequence ? { print_sequence: pl.printSequence } : {}) };
  return resolveConfig({ printerId: s.printerId, plate: pl?.bedType ?? s.plate, filamentId: s.filaments[0].presetId, presetId: s.presetId, overrides: { ...overrides, ...plateOv }, machineOverrides: s.machineOverrides, filamentOverrides: slotOverrides(s.filaments[0]) });
}

export const plateObjects = (plate = useStore.getState().activePlate) => {
  const s = useStore.getState();
  return s.objects.filter((o) => objectPlate(o, s.printerId, s.plates.length) === plate);
};

/** Stops the running slice: the worker is terminated, the waiting caller gets null and nothing is reported as an error. */
export function cancelSlice() {
  const was = useStore.getState().slice.status === 'slicing';
  worker?.terminate();
  worker = null;
  const p = pending;
  pending = null;
  p?.(null);
  if (!was && !p) return;
  const st = useStore.getState();
  st.set({ slice: { ...st.slice, status: 'idle', stage: '', progress: 0, error: null, dirty: true }, toast: { kind: 'info', text: 'Slicing cancelled' } });
}

/** The slicer's input for objects of a plate: world meshes moved into the plate's own coordinates, with parts and paint. */
export function plateMeshes(objs: SceneObject[], plate = useStore.getState().activePlate): MeshInput[] {
  const s = useStore.getState();
  const [ox, oy] = plateOrigin(plate, s.printerId);
  const toPlate = new THREE.Matrix4().makeTranslation(-ox, -oy, 0);
  return objs.map((o) => ({
    id: o.id, name: o.name,
    vertices: transformVertices(o.mesh.vertices, toPlate.clone().multiply(objectMatrix(o)).elements),
    indices: o.mesh.indices,
    filament: o.filament ?? 0,
    overrides: o.overrides,
    paint: o.paint,
    faceSets: faceSetsOf(o.paint?.motion),
    layerHeights: o.layerHeights,
    rotationZ: o.rotation?.[2] ?? 0,
    heightRanges: o.heightRanges,
    brimEars: o.brimEars?.map(([x, y, z]) => {
      const p = new THREE.Vector3(x, y, z ?? 0).applyMatrix4(toPlate.clone().multiply(objectMatrix(o)));
      return [p.x, p.y] as [number, number];
    }),
    parts: (o.parts ?? []).map((p) => ({
      type: p.type, overrides: p.overrides, indices: p.mesh.indices,
      innerFrom: p.prim?.wall && p.mesh.indices.length / 3 === p.prim.tris ? p.prim.innerFrom : undefined,
      vertices: transformVertices(p.mesh.vertices, toPlate.clone().multiply(partWorldMatrix(o, p)).elements),
    })),
  }));
}

/** Toast action: support on for the whole plate, then slice again. */
function enableSupportAndReslice() {
  useStore.getState().setOverride('enable_support', true);
  void sliceNow();
}

export function sliceNow(): Promise<SliceOutput | null> {
  const s = useStore.getState();
  const plate = s.activePlate;
  const program = s.plates[plate]?.program;
  const objs = program ? [] : plateObjects(plate).filter((o) => o.printable !== false);
  if (!objs.length && !program) {
    s.set({ toast: { kind: 'warn', text: `${s.plates[plate].name} is empty — add a model first.` } });
    return Promise.resolve(null);
  }
  let meshes: MeshInput[];
  try { meshes = plateMeshes(objs, plate); }
  catch (e: any) {
    s.set({ slice: { ...s.slice, status: 'error', error: e?.message ?? String(e), dirty: true }, toast: { kind: 'error', text: `Slicing failed: the plate could not be prepared (${e?.message ?? e})` } });
    return Promise.resolve(null);
  }
  const blocked = keepOutHit(meshes, printerById(s.printerId).excludedAreas ?? []);
  if (blocked) {
    s.set({ workspace: 'prepare', slice: { ...s.slice, status: 'idle', dirty: true }, toast: { kind: 'error', text: `${blocked} sits in the printer's keep-out zone (front-left corner, where the nozzle wipes and purges). Move it out of the grey pad, then slice.` } });
    return Promise.resolve(null);
  }
  // overhangs with support off: warn with the slice result (measured now, before the vertices go to the worker)
  const cfgNow = currentConfig(plate);
  const thr = Number(cfgNow.support_threshold_angle) || 30;
  const overhangs = program ? [] : findOverhangs(meshes.filter((m) => (m.overrides?.enable_support ?? cfgNow.enable_support) !== true), thr);
  worker?.terminate();
  pending?.(null); // a slice that is replaced never finishes
  const mine = startWorker('slicer');
  worker = mine;
  const id = ++seq;
  s.set({ slice: { ...s.slice, status: 'slicing', stage: 'Preparing', progress: 0, error: null, plate, dirty: false } }); // edits during the slice mark it dirty again
  return new Promise((done) => {
    const resolve = (r: SliceOutput | null) => { if (pending === resolve) pending = null; if (worker === mine) { mine.terminate(); worker = null; } done(r); };
    pending = resolve;
    // a worker that dies (out of memory, script error) is reported once, unless this slice was replaced or cancelled
    const fail = (message: string) => {
      if (worker !== mine) return;
      const st = useStore.getState();
      st.set({ slice: { ...st.slice, status: 'error', error: message, dirty: true }, toast: { kind: 'error', text: `Slicing failed: ${message}` } });
      resolve(null);
    };
    // a script error carries a message; a script that could not be loaded (or a crash) does not
    mine.onerror = (e) => { e.preventDefault?.(); if (e.message) fail(e.message); else void workerFailure('slicer', 'slicer').then(fail); };
    mine.onmessageerror = () => fail('the slicer sent back data that could not be read');
    mine.onmessage = (ev) => {
      const m = ev.data;
      if (m.id !== id || worker !== mine) return;
      const st = useStore.getState();
      if (m.type === 'progress') st.set({ slice: { ...st.slice, stage: m.stage, progress: m.pct } });
      else if (m.type === 'done') {
        const out = m.out as SliceOutput;
        st.set({
          slice: { status: 'done', stage: 'Done', progress: 1, result: out, error: null, dirty: st.slice.dirty, plate }, showGcode: false,
          layerRange: [0, out.layers.length - 1], moveCursor: -1,
          toast: overhangs.length
            ? { kind: 'warn', text: [overhangMessage(overhangs, thr), ...out.warnings].join(' '), action: { label: 'Turn on support', run: enableSupportAndReslice } }
            : out.warnings.length ? { kind: 'warn', text: out.warnings.join(' ') } : null,
        });
        resolve(out);
      } else fail(m.message);
    };
    try {
      mine.postMessage({
        id, meshes, cfg: cfgNow,
        opts: { program, filaments: filamentSlots(s.filaments), layerActions: s.plates[plate].layerActions, filamentSequence: s.plates[plate].filamentSequence, mixes: s.mixes.length ? s.mixes : undefined, plugins: pluginConfigs(), advanced: advancedSliceConfig(), flushMatrix: s.filaments.length > 1 ? effectiveFlush(s.filaments.map((f) => f.color), s.flushMatrix, s.flushMultiplier) : undefined },
      }, meshes.map((m) => m.vertices.buffer));
    } catch (e: any) {
      // settings or plugin data that cannot be sent to the worker: report it instead of staying at "Preparing"
      fail(`the plate could not be sent to the slicer (${e?.message ?? e})`);
    }
  });
}

/** Name of the first model whose footprint touches an excluded bed area (the grey pad), or null. Areas are axis-aligned rectangles. */
export function keepOutHit(meshes: MeshInput[], areas: [number, number][][]): string | null {
  if (!areas.length) return null;
  const rects = areas.map((a) => [Math.min(...a.map((p) => p[0])), Math.min(...a.map((p) => p[1])), Math.max(...a.map((p) => p[0])), Math.max(...a.map((p) => p[1]))]);
  for (const m of meshes) {
    const v = m.vertices, ix = m.indices;
    for (let t = 0; t < ix.length; t += 3) {
      const a = ix[t] * 3, b = ix[t + 1] * 3, c = ix[t + 2] * 3;
      const xs = [v[a], v[b], v[c]], ys = [v[a + 1], v[b + 1], v[c + 1]];
      for (const r of rects) if (triHitsRect(xs, ys, r)) return m.name || 'A model';
    }
  }
  return null;
}

/** 2-D separating-axis test: triangle vs axis-aligned rectangle [x0, y0, x1, y1] (touching counts). */
function triHitsRect(xs: number[], ys: number[], [x0, y0, x1, y1]: number[]) {
  if (Math.max(...xs) < x0 || Math.min(...xs) > x1 || Math.max(...ys) < y0 || Math.min(...ys) > y1) return false;
  const cx = [x0, x1, x1, x0], cy = [y0, y0, y1, y1];
  for (let i = 0; i < 3; i++) {
    const j = (i + 1) % 3, nx = ys[j] - ys[i], ny = xs[i] - xs[j];
    if (!nx && !ny) continue;
    const k = (i + 2) % 3, side = Math.sign(nx * (xs[k] - xs[i]) + ny * (ys[k] - ys[i]));
    if (!side) continue;
    if (cx.every((x, q) => side * (nx * (x - xs[i]) + ny * (cy[q] - ys[i])) < 0)) return false;
  }
  return true;
}

/** Pushes the given objects off the printer's keep-out pad (right or back, whichever is shorter), with a note. */
export function clearKeepOut(ids: string[]) {
  const s = useStore.getState();
  const areas = printerById(s.printerId).excludedAreas ?? [];
  if (!areas.length) return;
  const rects = areas.map((a) => [Math.min(...a.map((p) => p[0])), Math.min(...a.map((p) => p[1])), Math.max(...a.map((p) => p[0])), Math.max(...a.map((p) => p[1]))]);
  let moved = 0;
  for (const id of ids) {
    for (let tries = 0; tries < 4; tries++) {
      const o = useStore.getState().objects.find((x) => x.id === id);
      if (!o || o.printable === false) break;
      const plate = objectPlate(o, s.printerId, s.plates.length);
      const [m] = plateMeshes([o], plate);
      if (!keepOutHit([m], areas)) break;
      let minX = Infinity, minY = Infinity;
      const v = m.vertices;
      for (let i = 0; i < v.length; i += 3) { if (v[i] < minX) minX = v[i]; if (v[i + 1] < minY) minY = v[i + 1]; }
      const r = rects.find((q) => keepOutHit([m], [[[q[0], q[1]], [q[2], q[1]], [q[2], q[3]], [q[0], q[3]]]])) ?? rects[0];
      const dx = r[2] - minX + 1, dy = r[3] - minY + 1;
      const [mx, my] = dx <= dy ? [dx, 0] : [0, dy];
      useStore.getState().updateObjects((x) => ({ ...x, position: [x.position[0] + mx, x.position[1] + my, x.position[2]] }), [id]);
      moved++;
    }
  }
  if (moved) useStore.getState().set({ toast: { kind: 'info', text: 'Moved off the front-left keep-out pad — the printer wipes and purges its nozzle there.' } });
}
