// Prepare tools that change geometry: Cut, Mesh Boolean and Text.
import * as THREE from 'three';
import { Brush, Evaluator, ADDITION, SUBTRACTION, INTERSECTION } from 'three-bvh-csg';
import { cutAtZ0 } from '../engine/meshops';
import { connectorMeshes, grooveMesh, type ConnectorSettings, type GrooveSettings } from './cutConnectors';
import { openEdgeCount, repairTJunctions, transformVertices, weld, type IndexedMesh } from '../engine/mesh';
import { centreMesh } from '../io/load';
import { dropToBed, newId, objectMatrix, partWorldMatrix, useStore, worldBounds, type SceneObject, type ScenePart, type Vec3 } from './store';
import type { Config } from '../profiles/settings';
import type { PartType } from '../engine/types';

// ---------------------------------------------------------------- helpers
const worldMesh = (o: SceneObject): IndexedMesh => ({ vertices: transformVertices(o.mesh.vertices, objectMatrix(o).elements), indices: o.mesh.indices });

/** Turn a world-space mesh into a scene object placed where the geometry is. */
export function objectFromWorld(name: string, m: IndexedMesh, base: Partial<SceneObject> = {}): SceneObject {
  const [cx, cy, cz] = centreMesh(m);
  return { id: newId(), name, mesh: m, position: [cx, cy, cz], rotation: [0, 0, 0], scale: [1, 1, 1], openEdges: openEdgeCount(m), ...base };
}

const toGeometry = (m: IndexedMesh) => {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(m.vertices, 3));
  g.setIndex(new THREE.BufferAttribute(m.indices, 1));
  return g;
};
const fromGeometry = (g: THREE.BufferGeometry): IndexedMesh => {
  const ng = g.index ? g.toNonIndexed() : g;
  return repairTJunctions(weld(new Float32Array(ng.getAttribute('position').array as ArrayLike<number>)));
};

// ---------------------------------------------------------------- cut
export interface CutOptions {
  height: number; tiltX: number; tiltY: number; keepAbove: boolean; keepBelow: boolean; flipAbove: boolean;
  /** Connector positions in cut-plane coordinates (relative to the plane centre). */
  connectors?: { x: number; y: number }[];
  connector?: ConnectorSettings;
  /** Tongue and groove (dovetail) cut instead of a flat cut. */
  groove?: GrooveSettings;
  /** Fragments moved to the other side (ids from cutPreview: 'a<k>' above, 'b<k>' below). */
  swap?: string[];
}

/** Plane frame of a cut: plane-local ↔ world matrices and the rotation. */
function cutFrame(obj: SceneObject, p: { height: number; tiltX: number; tiltY: number }) {
  const d = Math.PI / 180;
  const b = worldBounds(obj);
  const centre = new THREE.Vector3((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, p.height);
  const rot = new THREE.Quaternion().setFromEuler(new THREE.Euler(p.tiltX * d, p.tiltY * d, 0, 'XYZ'));
  const toPlane = new THREE.Matrix4().compose(centre, rot, new THREE.Vector3(1, 1, 1)).invert();
  return { b, rot, toPlane, fromPlane: toPlane.clone().invert() };
}

/** Centre of the largest cross-section (plane coordinates) of the pieces below the plane: where the dovetail goes. */
function sectionCentre(below: IndexedMesh): [number, number] {
  let best = 0, c: [number, number] = [0, 0];
  for (const m of shellsOf(below)) {
    const v = m.vertices, ix = m.indices;
    let a = 0, cx = 0, cy = 0;
    for (let t = 0; t < ix.length; t += 3) {
      const i = ix[t] * 3, j = ix[t + 1] * 3, k = ix[t + 2] * 3;
      if (Math.max(Math.abs(v[i + 2]), Math.abs(v[j + 2]), Math.abs(v[k + 2])) > 1e-4) continue; // cap triangles only
      const ar = Math.abs((v[j] - v[i]) * (v[k + 1] - v[i + 1]) - (v[k] - v[i]) * (v[j + 1] - v[i + 1])) / 2;
      a += ar; cx += ar * (v[i] + v[j] + v[k]) / 3; cy += ar * (v[i + 1] + v[j + 1] + v[k + 1]) / 3;
    }
    if (a > best) { best = a; c = [cx / a, cy / a]; }
  }
  return c;
}

/** Dovetail key centred on the cross-section (plane coordinates). */
function placedGroove(g: GrooveSettings, L: number, at: [number, number], grow = 0, growDepth = 0): IndexedMesh {
  const k = grooveMesh(g, L, grow, growDepth);
  const v = new Float32Array(k.vertices);
  for (let i = 0; i < v.length; i += 3) { v[i] += at[0]; v[i + 1] += at[1]; }
  return { ...k, vertices: v };
}

/** Dovetail key for the viewport overlay, centred like the cut will place it. */
export function cutGrooveOverlay(obj: SceneObject, p: { height: number; tiltX: number; tiltY: number }, g: GrooveSettings, L: number): IndexedMesh {
  const f = cutFrame(obj, p);
  const r = cutAtZ0({ vertices: transformVertices(obj.mesh.vertices, f.toPlane.clone().multiply(objectMatrix(obj)).elements), indices: obj.mesh.indices });
  return placedGroove(g, L, r.below ? sectionCentre(r.below) : [0, 0]);
}

export interface CutPreview { above: IndexedMesh[]; below: IndexedMesh[]; fromPlane: THREE.Matrix4 }

/** The pieces a planar cut makes (plane coordinates), for the live two-colour preview. */
export function cutPreview(obj: SceneObject, p: { height: number; tiltX: number; tiltY: number }): CutPreview | null {
  const f = cutFrame(obj, p);
  const r = cutAtZ0({ vertices: transformVertices(obj.mesh.vertices, f.toPlane.clone().multiply(objectMatrix(obj)).elements), indices: obj.mesh.indices });
  if (!r.below || !r.above) return null;
  return { above: shellsOf(r.above), below: shellsOf(r.below), fromPlane: f.fromPlane };
}

/** Concatenate meshes (no welding). */
function joinMeshes(ms: IndexedMesh[]): IndexedMesh {
  const nv = ms.reduce((a, m) => a + m.vertices.length, 0), ni = ms.reduce((a, m) => a + m.indices.length, 0);
  const vertices = new Float32Array(nv), indices = new Uint32Array(ni);
  let v = 0, i = 0;
  for (const m of ms) {
    vertices.set(m.vertices, v);
    for (let k = 0; k < m.indices.length; k++) indices[i + k] = m.indices[k] + v / 3;
    v += m.vertices.length; i += m.indices.length;
  }
  return { vertices, indices } as IndexedMesh;
}

/** One side of a cut with the swapped fragments of the other side fused on (they touch at the cut face). */
function sideWith(own: IndexedMesh[], moved: IndexedMesh[]): IndexedMesh | null {
  if (!own.length && !moved.length) return null;
  let m = joinMeshes(own);
  for (const x of moved) {
    try { m = m.indices.length ? booleanMeshes(m, x, 'union') : x; } catch { m = joinMeshes([m, x]); }
  }
  return m;
}

/** Cut the object with a plane through world height `height` (tilted by tiltX/tiltY degrees). */
export function cutObject(id: string, o: CutOptions) {
  const s = useStore.getState();
  const obj = s.objects.find((x) => x.id === id);
  if (!obj) return;
  const { b, rot, toPlane, fromPlane } = cutFrame(obj, o);
  const local = transformVertices(obj.mesh.vertices, toPlane.clone().multiply(objectMatrix(obj)).elements);
  const r = cutAtZ0({ vertices: local, indices: obj.mesh.indices });
  if (!r.below || !r.above) { s.set({ toast: { kind: 'warn', text: 'The cut plane does not cross the object.' } }); return; }
  const at = o.groove ? sectionCentre(r.below) : [0, 0] as [number, number];
  if (o.swap?.length) {
    // right-clicked fragments change sides: they stay whole with the other part instead of being cut off
    const sw = new Set(o.swap);
    const A = shellsOf(r.above), B = shellsOf(r.below);
    const above = sideWith(A.filter((_, k) => !sw.has(`a${k}`)), B.filter((_, k) => sw.has(`b${k}`)));
    const below = sideWith(B.filter((_, k) => !sw.has(`b${k}`)), A.filter((_, k) => sw.has(`a${k}`)));
    if (!above || !below) { s.set({ toast: { kind: 'warn', text: 'Every piece is on one side: nothing to cut.' } }); return; }
    r.above = above; r.below = below;
  }
  let loose: IndexedMesh[] = [];
  if (o.groove) {
    try {
      const L = Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) * 2 + 10;
      // the tongue is the part of the lower half inside the key; the lower half keeps a slightly larger groove
      const tongue = booleanMeshes(r.below, placedGroove(o.groove, L, at), 'intersection');
      if (!tongue.indices.length) throw new Error('the groove does not cross the object');
      r.above = booleanMeshes(r.above, tongue, 'union');
      r.below = booleanMeshes(r.below, placedGroove(o.groove, L, at, o.groove.widthTol, o.groove.depthTol), 'difference');
    } catch (e: any) { s.set({ toast: { kind: 'error', text: `Dovetail cut failed: ${e?.message ?? e}` } }); return; }
  }
  if (o.connectors?.length && o.connector) {
    try {
      const cm = connectorMeshes(o.connectors, o.connector);
      let above: IndexedMesh = r.above, below: IndexedMesh = r.below;
      for (let k = 0; k < cm.addUpper.length; k++) {
        let pin = cm.addUpper[k];
        for (const sl of cm.subPin) pin = booleanMeshes(pin, sl, 'difference');
        above = booleanMeshes(above, pin, 'union');
      }
      for (const m of cm.subUpper) above = booleanMeshes(above, m, 'difference');
      for (const m of cm.subLower) below = booleanMeshes(below, m, 'difference');
      r.above = above; r.below = below; loose = cm.loose;
    } catch (e: any) { s.set({ toast: { kind: 'error', text: `Connectors failed: ${e?.message ?? e}` } }); return; }
  }
  const out: SceneObject[] = [];
  const keep = { filament: obj.filament, overrides: obj.overrides };
  if (o.keepBelow) out.push(objectFromWorld(`${obj.name} (lower)`, { vertices: transformVertices(r.below.vertices, fromPlane.elements), indices: r.below.indices }, keep));
  if (o.keepAbove) {
    let up = { vertices: transformVertices(r.above.vertices, fromPlane.elements), indices: r.above.indices };
    // the upper part's cut face points down the plane normal: undo the tilt so it lies flat on the bed
    if (o.flipAbove) up = { vertices: transformVertices(up.vertices, new THREE.Matrix4().makeRotationFromQuaternion(rot.clone().invert()).elements), indices: up.indices };
    const upper = objectFromWorld(`${obj.name} (upper)`, up, keep);
    upper.position[0] = b.max[0] + (b.max[0] - b.min[0]) / 2 + 8; // beside the lower part
    upper.position[1] = (b.min[1] + b.max[1]) / 2;
    out.push(upper);
  }
  loose.forEach((m, k) => {
    const dw = objectFromWorld(`${obj.name} (dowel ${k + 1})`, { vertices: transformVertices(m.vertices, fromPlane.elements), indices: m.indices }, keep);
    dw.position[0] = b.min[0] - 8 - k * (o.connector!.size + 4);
    dw.position[1] = (b.min[1] + b.max[1]) / 2;
    out.push(dw);
  });
  s.checkpoint();
  s.set({ objects: [...s.objects.filter((x) => x.id !== id), ...out.map(dropToBed)], selected: out.map((x) => x.id), selectedPart: null, tool: 'select', cutConnectors: [], cutSwap: [] });
  s.markDirty();
  if (r.openLoops) s.set({ toast: { kind: 'warn', text: `The mesh is not watertight at the cut: ${r.openLoops} section(s) could not be capped.` } });
}

// ---------------------------------------------------------------- boolean
export type BoolOp = 'union' | 'difference' | 'intersection';

/** Connected shells of a mesh as separate meshes. */
function shellsOf(m: IndexedMesh): IndexedMesh[] {
  const nv = m.vertices.length / 3, T = m.indices.length / 3;
  const parent = new Int32Array(nv).map((_, i) => i);
  const find = (a: number): number => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  for (let t = 0; t < T; t++) for (let k = 1; k < 3; k++) { const a = find(m.indices[t * 3]), b = find(m.indices[t * 3 + k]); if (a !== b) parent[b] = a; }
  const groups = new Map<number, number[]>();
  for (let t = 0; t < T; t++) { const r = find(m.indices[t * 3]); const g = groups.get(r); if (g) g.push(t); else groups.set(r, [t]); }
  return [...groups.values()].map((tris) => {
    const soup = new Float32Array(tris.length * 9);
    tris.forEach((t, j) => { for (let c = 0; c < 3; c++) { const vi = m.indices[t * 3 + c] * 3; soup.set([m.vertices[vi], m.vertices[vi + 1], m.vertices[vi + 2]], j * 9 + c * 3); } });
    return weld(soup);
  });
}

/** Signed volume (negative = inside out). */
function volumeOf(m: IndexedMesh) {
  const v = m.vertices, ix = m.indices;
  let vol = 0;
  for (let t = 0; t < ix.length; t += 3) {
    const a = ix[t] * 3, b = ix[t + 1] * 3, c = ix[t + 2] * 3;
    vol += (v[a] * (v[b + 1] * v[c + 2] - v[b + 2] * v[c + 1]) - v[a + 1] * (v[b] * v[c + 2] - v[b + 2] * v[c]) + v[a + 2] * (v[b] * v[c + 1] - v[b + 1] * v[c])) / 6;
  }
  return vol;
}

/** Clean input for the CSG evaluator: welded, T-junctions closed, no degenerate triangles, outward winding. */
function cleanForCsg(m: IndexedMesh, tol = 1e-5): IndexedMesh {
  const soup: number[] = [];
  const v = m.vertices, ix = m.indices;
  for (let t = 0; t < ix.length; t += 3) {
    const a = ix[t] * 3, b = ix[t + 1] * 3, c = ix[t + 2] * 3;
    const ux = v[b] - v[a], uy = v[b + 1] - v[a + 1], uz = v[b + 2] - v[a + 2], wx = v[c] - v[a], wy = v[c + 1] - v[a + 1], wz = v[c + 2] - v[a + 2];
    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    if (nx * nx + ny * ny + nz * nz < 1e-14) continue; // zero-area sliver
    soup.push(v[a], v[a + 1], v[a + 2], v[b], v[b + 1], v[b + 2], v[c], v[c + 1], v[c + 2]);
  }
  let r = repairTJunctions(weld(new Float32Array(soup), tol));
  if (volumeOf(r) < 0) { const f = r.indices.slice(); for (let t = 0; t < f.length; t += 3) { const k = f[t + 1]; f[t + 1] = f[t + 2]; f[t + 2] = k; } r = { vertices: r.vertices, indices: f }; }
  return r;
}

const csgOnce = (a: IndexedMesh, b: IndexedMesh, op: BoolOp): IndexedMesh => {
  const ev = new Evaluator();
  ev.attributes = ['position'];
  ev.useGroups = false;
  const A = new Brush(toGeometry(a)), B = new Brush(toGeometry(b));
  A.updateMatrixWorld(); B.updateMatrixWorld();
  const res = ev.evaluate(A, B, op === 'union' ? ADDITION : op === 'difference' ? SUBTRACTION : INTERSECTION);
  return fromGeometry(res.geometry);
};

const nudged = (m: IndexedMesh, d: number): IndexedMesh => {
  // a few microns of shift breaks exactly coincident faces, the usual cause of CSG holes
  const v = m.vertices.slice();
  for (let i = 0; i < v.length; i += 3) { v[i] += d; v[i + 1] += d * 0.7; v[i + 2] += d * 0.4; }
  return { vertices: v, indices: m.indices };
};

/**
 * Boolean of two meshes, robust to overlapping and multi-shell input: each side is cleaned and its own overlapping
 * shells are merged first; if the result is not closed, the operand is retried slightly shifted and coarser-welded.
 */
export function booleanMeshes(a: IndexedMesh, b: IndexedMesh, op: BoolOp): IndexedMesh {
  const solid = (m: IndexedMesh) => {
    const c = cleanForCsg(m);
    const shells = shellsOf(c);
    if (shells.length < 2 || shells.length > 64) return c;
    // overlapping shells inside one operand confuse the evaluator: merge them first
    try { return shells.map((x) => cleanForCsg(x)).reduce((acc, x) => csgOnce(acc, x, 'union')); } catch { return c; }
  };
  const A = solid(a), B = solid(b);
  const attempts: [number, number][] = [[0, 1e-5], [2e-4, 1e-5], [-3e-4, 1e-4], [1e-3, 1e-3]];
  let best: IndexedMesh | null = null, lastErr: unknown = null;
  for (const [d, tol] of attempts) {
    try {
      const r = csgOnce(tol === 1e-5 ? A : cleanForCsg(A, tol), d ? nudged(tol === 1e-5 ? B : cleanForCsg(B, tol), d) : tol === 1e-5 ? B : cleanForCsg(B, tol), op);
      const open = openEdgeCount(r);
      if (!best || openEdgeCount(best) > open) best = r;
      if (open === 0) return r;
    } catch (e) { lastErr = e; }
  }
  if (best) return best;
  throw lastErr ?? new Error('the meshes could not be combined');
}

/** Boolean of a list: union folds; difference subtracts the union of the others from the first; intersection folds. */
export function booleanAll(ms: IndexedMesh[], op: BoolOp): IndexedMesh {
  if (ms.length < 2) return ms[0];
  if (op === 'difference') return booleanMeshes(ms[0], ms.slice(1).reduce((acc, x) => booleanMeshes(acc, x, 'union')), 'difference');
  return ms.slice(1).reduce((acc, x) => booleanMeshes(acc, x, op), ms[0]);
}

/** Combine the first selected object with the others. Difference subtracts the others from the first. */
export function booleanSelected(op: BoolOp) {
  const s = useStore.getState();
  const objs = s.selected.map((id) => s.objects.find((o) => o.id === id)!).filter(Boolean).map((o) => bakeObjectParts(o));
  if (objs.length < 2) { s.set({ toast: { kind: 'warn', text: 'Select two or more objects (Shift+click). The first one is the base.' } }); return; }
  let m: IndexedMesh;
  try { m = booleanAll(objs.map(worldMesh), op); }
  catch (e: any) { s.set({ toast: { kind: 'error', text: `Boolean failed: ${e?.message ?? e}. Check the models are closed (no open edges) and try again.` } }); return; }
  if (!m.indices.length) { s.set({ toast: { kind: 'warn', text: op === 'intersection' ? 'The result is empty (the objects do not overlap).' : 'The result is empty.' } }); return; }
  const res = objectFromWorld(`${objs[0].name} (${op})`, m, { filament: objs[0].filament, overrides: objs[0].overrides });
  s.checkpoint();
  const ids = new Set(s.selected);
  s.set({ objects: [...s.objects.filter((o) => !ids.has(o.id)), dropToBed(res)], selected: [res.id], selectedPart: null });
  s.markDirty();
}

// ---------------------------------------------------------------- parts → one mesh
/** True when an object carries positive or negative parts that change its shape. */
export const hasShapeParts = (o: SceneObject) => !!o.parts?.some((p) => p.type === 'part' || p.type === 'negative');

const partWorldMesh = (o: SceneObject, p: ScenePart): IndexedMesh => ({ vertices: transformVertices(p.mesh.vertices, partWorldMatrix(o, p).elements), indices: p.mesh.indices });

/** Outer surface and (outward-facing) inner surface of a hollow part (wall cutter / wall shell), world coordinates. */
function hollowSides(o: SceneObject, p: ScenePart): [IndexedMesh, IndexedMesh] | null {
  const k = p.prim?.wall && p.mesh.indices.length / 3 === p.prim.tris ? (p.prim.innerFrom ?? 0) * 3 : 0;
  if (!k) return null;
  const w = partWorldMesh(o, p);
  const inner = w.indices.slice(k);
  for (let t = 0; t < inner.length; t += 3) { const x = inner[t + 1]; inner[t + 1] = inner[t + 2]; inner[t + 2] = x; }
  return [compact(w.vertices, w.indices.slice(0, k)), compact(w.vertices, inner)];
}

/** Only the vertices a triangle list uses. */
function compact(v: Float32Array, ix: Uint32Array): IndexedMesh {
  const map = new Map<number, number>(), out: number[] = [], nix = new Uint32Array(ix.length);
  for (let i = 0; i < ix.length; i++) {
    let n = map.get(ix[i]);
    if (n === undefined) { n = map.size; map.set(ix[i], n); out.push(v[ix[i] * 3], v[ix[i] * 3 + 1], v[ix[i] * 3 + 2]); }
    nix[i] = n;
  }
  return { vertices: new Float32Array(out), indices: nix };
}

/** Two meshes as one (they must not overlap). */
function concatMeshes(a: IndexedMesh, b: IndexedMesh): IndexedMesh {
  const n = a.vertices.length / 3, v = new Float32Array(a.vertices.length + b.vertices.length), ix = new Uint32Array(a.indices.length + b.indices.length);
  v.set(a.vertices); v.set(b.vertices, a.vertices.length); ix.set(a.indices);
  for (let i = 0; i < b.indices.length; i++) ix[a.indices.length + i] = b.indices[i] + n;
  return { vertices: v, indices: ix };
}

/** Mesh of the object (world coordinates) with positive parts merged in and negative parts cut out. */
export function bakedWorldMesh(o: SceneObject): IndexedMesh {
  let m = worldMesh(o);
  const parts = o.parts ?? [];
  const solidOf = (type: PartType) => parts.filter((p) => p.type === type && !hollowSides(o, p)).map((p) => partWorldMesh(o, p));
  const pos = solidOf('part'), neg = solidOf('negative');
  if (pos.length) m = booleanAll([m, ...pos], 'union');
  // wall shell: add the skin between outer and inner = (body ∪ outer) − (inner − body)
  for (const p of parts.filter((q) => q.type === 'part')) {
    const h = hollowSides(o, p);
    if (!h) continue;
    const gap = booleanMeshes(h[1], m, 'difference');
    m = booleanMeshes(m, h[0], 'union');
    if (gap.indices.length) m = booleanMeshes(m, gap, 'difference');
  }
  if (neg.length) m = booleanMeshes(m, neg.length > 1 ? booleanAll(neg, 'union') : neg[0], 'difference');
  // wall cutter: remove the skin = (body − outer) + (body ∩ inner); the two never touch (the wall lies between)
  for (const p of parts.filter((q) => q.type === 'negative')) {
    const h = hollowSides(o, p);
    if (!h) continue;
    const outside = booleanMeshes(m, h[0], 'difference'), inside = booleanMeshes(m, h[1], 'intersection');
    m = concatMeshes(outside, inside);
  }
  return m;
}

/**
 * The object with its positive and negative parts applied to the body (one workable mesh). Modifiers, support
 * enforcers and blockers stay as parts. Returns the object unchanged when it has no shape parts; throws if the boolean fails.
 */
export function bakeObjectParts(o: SceneObject): SceneObject {
  if (!hasShapeParts(o)) return o;
  const m = bakedWorldMesh(o);
  const [cx, cy, cz] = centreMesh(m);
  const next: SceneObject = { ...o, mesh: m, position: [cx, cy, cz], rotation: [0, 0, 0], scale: [1, 1, 1], openEdges: openEdgeCount(m), layerHeights: undefined };
  const inv = objectMatrix(next).invert().elements;
  const rest = (o.parts ?? []).filter((p) => p.type !== 'part' && p.type !== 'negative');
  // remaining volumes are re-expressed in the new object frame
  next.parts = rest.map((p) => ({ ...p, mesh: { vertices: transformVertices(partWorldMesh(o, p).vertices, inv), indices: p.mesh.indices }, position: [0, 0, 0] as Vec3, rotation: [0, 0, 0] as Vec3, scale: [1, 1, 1] as Vec3 }));
  return next;
}

/** Bake the selected objects' positive / negative parts into their meshes (Boolean tool button). */
export function applyPartsBoolean(ids = useStore.getState().selected) {
  const s = useStore.getState();
  const targets = s.objects.filter((o) => ids.includes(o.id) && hasShapeParts(o));
  if (!targets.length) { s.set({ toast: { kind: 'info', text: 'The selected objects have no positive or negative parts to apply.' } }); return; }
  try {
    const baked = new Map(targets.map((o) => [o.id, bakeObjectParts(o)]));
    s.checkpoint();
    s.set({ objects: s.objects.map((o) => (baked.has(o.id) ? dropToBed({ ...baked.get(o.id)!, paint: undefined }) : o)), selectedPart: null });
    s.markDirty();
  } catch (e: any) { s.set({ toast: { kind: 'error', text: `Boolean failed: ${e?.message ?? e}` } }); }
}

// ---------------------------------------------------------------- text
export const FONTS: Record<string, { label: string; load: () => Promise<any> }> = {
  helvetiker: { label: 'Helvetiker', load: () => import('three/examples/fonts/helvetiker_regular.typeface.json') },
  helvetiker_bold: { label: 'Helvetiker Bold', load: () => import('three/examples/fonts/helvetiker_bold.typeface.json') },
  optimer: { label: 'Optimer', load: () => import('three/examples/fonts/optimer_regular.typeface.json') },
  optimer_bold: { label: 'Optimer Bold', load: () => import('three/examples/fonts/optimer_bold.typeface.json') },
  gentilis: { label: 'Gentilis', load: () => import('three/examples/fonts/gentilis_regular.typeface.json') },
  droid_sans: { label: 'Droid Sans', load: () => import('three/examples/fonts/droid/droid_sans_regular.typeface.json') },
  droid_mono: { label: 'Droid Sans Mono', load: () => import('three/examples/fonts/droid/droid_sans_mono_regular.typeface.json') },
};

export async function textMesh(text: string, font: string, size: number, depth: number): Promise<IndexedMesh> {
  const [{ FontLoader }, { TextGeometry }] = await Promise.all([import('three/examples/jsm/loaders/FontLoader.js'), import('three/examples/jsm/geometries/TextGeometry.js')]);
  const data = await FONTS[font].load();
  const f = new FontLoader().parse(data.default ?? data);
  const g = new TextGeometry(text, { font: f, size, depth, curveSegments: 6, bevelEnabled: false });
  g.computeBoundingBox();
  const bb = g.boundingBox!;
  g.translate(-(bb.min.x + bb.max.x) / 2, -(bb.min.y + bb.max.y) / 2, 0);
  return fromGeometry(g);
}

export interface TextOptions { text: string; font: string; size: number; depth: number; mode: 'object' | 'emboss' | 'engrave' }

/** Add text as its own object, or emboss / engrave it into the top of the selected object. */
export async function addText(o: TextOptions) {
  const s = useStore.getState();
  if (!o.text.trim()) return;
  let t: IndexedMesh;
  try {
    t = await textMesh(o.text, o.font, o.size, o.mode === 'engrave' ? o.depth + 0.01 : o.depth);
    if (!t.indices.length) throw new Error(`the font has no shapes for "${o.text}"`);
  } catch (e: any) {
    console.error('Text failed', e);
    s.set({ toast: { kind: 'error', text: `Text failed: ${e?.message ?? e}` } });
    return;
  }
  const target = s.objects.find((x) => x.id === s.selected[0]);
  if (o.mode === 'object' || !target) {
    try {
      const { centreOnBed } = await import('./ops');
      const obj = centreOnBed(objectFromWorld(`Text "${o.text}"`, t), useStore.getState().printerId);
      useStore.getState().addObjects([obj]);
    } catch (e: any) {
      console.error('Text failed', e);
      s.set({ toast: { kind: 'error', text: `Text failed: ${e?.message ?? e}` } });
    }
    return;
  }
  // place on the top face of the target, centred
  const b = worldBounds(target);
  const top = b.max[2];
  const place = new THREE.Matrix4().makeTranslation((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, o.mode === 'engrave' ? top - o.depth : top - 0.01);
  const tw = { vertices: transformVertices(t.vertices, place.elements), indices: t.indices };
  let m: IndexedMesh;
  try { m = booleanMeshes(worldMesh(target), tw, o.mode === 'engrave' ? 'difference' : 'union'); }
  catch (e: any) { s.set({ toast: { kind: 'error', text: `Text failed: ${e?.message ?? e}` } }); return; }
  const res = objectFromWorld(target.name, m, { id: target.id, filament: target.filament, overrides: target.overrides });
  s.checkpoint();
  s.set({ objects: s.objects.map((x) => (x.id === target.id ? dropToBed({ ...res, paint: undefined, layerHeights: undefined }) : x)) });
  s.markDirty();
}

// ---------------------------------------------------------------- emboss as a volume (Text / SVG tools)
export type EmbossKind = 'part' | 'negative' | 'modifier';
export interface SurfacePick { objId: string; point: Vec3; normal: Vec3 }

/** SVG drawing extruded to `depth`, scaled so its width is `width` mm, centred, lying on z = 0..depth. */
export async function svgMesh(svgText: string, width: number, depth: number): Promise<IndexedMesh> {
  const { SVGLoader } = await import('three/examples/jsm/loaders/SVGLoader.js');
  const data = new SVGLoader().parse(svgText);
  const geos: THREE.BufferGeometry[] = [];
  for (const path of data.paths) {
    const fill = path.userData?.style?.fill;
    if (fill === 'none') continue;
    for (const shape of SVGLoader.createShapes(path)) geos.push(new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 8 }));
  }
  if (!geos.length) throw new Error('the SVG has no filled shapes');
  const parts = geos.map((g) => g.toNonIndexed().getAttribute('position').array as Float32Array);
  const all = new Float32Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0; for (const p of parts) { all.set(p, o); o += p.length; }
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < all.length; i += 3) { x0 = Math.min(x0, all[i]); x1 = Math.max(x1, all[i]); y0 = Math.min(y0, all[i + 1]); y1 = Math.max(y1, all[i + 1]); }
  const k = width / Math.max(1e-6, x1 - x0);
  // SVG y points down: mirror it so the drawing reads correctly from above
  for (let i = 0; i < all.length; i += 3) {
    all[i] = (all[i] - (x0 + x1) / 2) * k;
    all[i + 1] = -(all[i + 1] - (y0 + y1) / 2) * k;
    // flipping Y reverses the winding: swap two corners of every triangle below
  }
  for (let t = 0; t < all.length; t += 9) for (let c = 0; c < 3; c++) { const tmp = all[t + 3 + c]; all[t + 3 + c] = all[t + 6 + c]; all[t + 6 + c] = tmp; }
  return repairTJunctions(weld(all));
}

/**
 * Add a flat, extruded shape (text or SVG, lying on z = 0..depth) to an object as a part, negative part or
 * modifier, standing on the picked surface point and facing along its normal. With `useSurface` the shape is
 * bent onto the surface: every vertex keeps its height above the surface instead of above the tangent plane.
 */
export function embossVolume(shape: IndexedMesh, kind: EmbossKind, pick: SurfacePick, depth: number, name: string, useSurface: boolean) {
  const s = useStore.getState();
  const o = s.objects.find((x) => x.id === pick.objId);
  if (!o) return;
  const n = new THREE.Vector3(...pick.normal).normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
  // keep the text upright: its +Y towards world +Z where possible (towards +Y on horizontal faces)
  const up = Math.abs(n.z) > 0.95 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
  const yNow = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
  const yWant = up.clone().addScaledVector(n, -up.dot(n)).normalize();
  const twist = Math.atan2(new THREE.Vector3().crossVectors(yNow, yWant).dot(n), yNow.dot(yWant));
  q.premultiply(new THREE.Quaternion().setFromAxisAngle(n, twist));
  // a part sinks a little into the surface so it fuses; a negative part reaches into the object; a modifier spans both sides
  const z0 = kind === 'negative' ? -depth : kind === 'modifier' ? -depth : -Math.min(0.2, depth / 4);
  const z1 = kind === 'negative' ? 0.05 : depth;
  const span = z1 - z0;
  const W = new THREE.Matrix4().compose(new THREE.Vector3(...pick.point), q, new THREE.Vector3(1, 1, 1));
  const v = shape.vertices, out = new Float32Array(v.length);
  let zMin = Infinity, zMax = -Infinity;
  for (let i = 2; i < v.length; i += 3) { zMin = Math.min(zMin, v[i]); zMax = Math.max(zMax, v[i]); }
  const zr = Math.max(1e-6, zMax - zMin);
  // surface heights under each vertex (world), measured along the normal from the tangent plane
  let height: ((x: number, y: number) => number) | null = null;
  if (useSurface) {
    const target = new THREE.Mesh(toGeometry(worldMesh(o)), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    target.updateMatrixWorld();
    const rc = new THREE.Raycaster();
    const cache = new Map<string, number>();
    height = (x, y) => {
      const key = `${x.toFixed(3)},${y.toFixed(3)}`;
      const c = cache.get(key);
      if (c !== undefined) return c;
      const from = new THREE.Vector3(x, y, depth * 4 + 20).applyMatrix4(W);
      rc.set(from, n.clone().negate());
      const hit = rc.intersectObject(target, false)[0];
      const h = hit ? new THREE.Vector3().subVectors(hit.point, new THREE.Vector3(...pick.point)).dot(n) : 0;
      cache.set(key, h);
      return h;
    };
  }
  const p = new THREE.Vector3();
  for (let i = 0; i < v.length; i += 3) {
    const z = z0 + ((v[i + 2] - zMin) / zr) * span;
    p.set(v[i], v[i + 1], z + (height ? height(v[i], v[i + 1]) : 0)).applyMatrix4(W);
    out[i] = p.x; out[i + 1] = p.y; out[i + 2] = p.z;
  }
  // into the object frame: parts compose with the object's matrix
  const local = transformVertices(out, objectMatrix(o).invert().elements);
  const part: ScenePart = {
    id: newId('part'), name, type: kind, mesh: { vertices: local, indices: shape.indices },
    position: [0, 0, 0] as Vec3, rotation: [0, 0, 0] as Vec3, scale: [1, 1, 1] as Vec3,
    overrides: (kind === 'modifier' ? { sparse_infill_density: 100 } : {}) as Config,
  };
  s.checkpoint();
  s.updateObjects((x) => ({ ...x, parts: [...(x.parts ?? []), part] }), [o.id]);
  s.set({ selected: [o.id], selectedPart: part.id });
  s.markDirty();
}
