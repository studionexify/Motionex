// Scene operations: arrange, auto-orient, lay-on-face, centre.
import * as THREE from 'three';
import { printerById } from '../profiles/printers';
import { dropToBed, newId, setShapeRefresher, objectMatrix, objectPlate, plateOrigin, useStore, worldBounds, type Plate, type SceneObject, type ScenePart, type Vec3 } from './store';
import { weld, type IndexedMesh } from '../engine/mesh';
import { adaptiveProfile, applyHeightRange, smoothProfile, uniformProfile } from '../engine/layers';
import type { PartType } from '../engine/types';
import type { Config } from '../profiles/settings';
import { arrangeItems, convexHull, type Pt } from '../engine/arrange';
import { currentConfig } from './slicing';

const DEG = 180 / Math.PI;

/** Shelf bin-packing of bounding boxes centred on the bed (spacing in mm). */
/** Silhouette of an object on the bed: convex hull of its world vertices (sampled on big meshes). */
export function silhouette(o: SceneObject): Pt[] {
  const m = objectMatrix(o).elements, v = o.mesh.vertices, n = v.length / 3;
  const stride = Math.max(1, Math.floor(n / 6000));
  const pts: Pt[] = [];
  for (let i = 0; i < n; i += stride) {
    const x = v[i * 3], y = v[i * 3 + 1], z = v[i * 3 + 2];
    pts.push([m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13]]);
  }
  return convexHull(pts);
}

/**
 * Arrange the objects on a plate: pack their silhouettes with the arrange settings' spacing,
 * trying rotations when auto-rotate is on, then centre the group (or align it to an axis).
 * Objects that do not fit are placed past the plate's right edge and reported.
 */
export function arrange(spacing?: number, plate = useStore.getState().activePlate, only?: string[]) {
  const s = useStore.getState();
  if (s.plates[plate]?.locked) return;
  const objs = s.objects.filter((o) => objectPlate(o, s.printerId, s.plates.length) === plate && (!only || only.includes(o.id)));
  if (!objs.length) return;
  const p = printerById(s.printerId);
  const [ox, oy] = plateOrigin(plate, s.printerId);
  const st = s.arrangeSettings;
  const gap = spacing ?? st.spacing;
  const hulls = new Map(objs.map((o) => [o.id, silhouette(o)]));
  // objects not being arranged stay where they are: arrange the rest around nothing (the whole plate is re-packed)
  const res = arrangeItems(objs.map((o) => ({ id: o.id, hull: hulls.get(o.id)!.map(([x, y]) => [x - ox, y - oy] as Pt) })), { x: p.bed.x, y: p.bed.y },
    { spacing: gap, rotations: st.rotate ? [0, 45, 90, 135, 180, 225, 270, 315] : [0], align: st.align, edge: 2 });
  let over = 0;
  s.updateObjects((o) => {
    const r = res.get(o.id);
    if (!r) {
      // no room: park it to the right of the plate
      const b = worldBounds(o);
      const nx = ox + p.bed.x + 10 + (b.max[0] - b.min[0]) / 2 + over * 5;
      over++;
      return dropToBed({ ...o, position: [o.position[0] + nx - (b.min[0] + b.max[0]) / 2, o.position[1] + oy + p.bed.y / 2 - (b.min[1] + b.max[1]) / 2, o.position[2]] });
    }
    // rotate about world Z, then move so the silhouette's centroid lands where the arranger put it
    let rot = o.rotation;
    if (r.rotation) {
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), r.rotation / DEG);
      const cur = new THREE.Quaternion().setFromEuler(new THREE.Euler(o.rotation[0] / DEG, o.rotation[1] / DEG, o.rotation[2] / DEG, 'XYZ'));
      const e = new THREE.Euler().setFromQuaternion(q.multiply(cur), 'XYZ');
      rot = [e.x * DEG, e.y * DEG, e.z * DEG].map((v) => +v.toFixed(4)) as [number, number, number];
    }
    const turned = { ...o, rotation: rot };
    const hc = hullCentroid(silhouette(turned));
    return dropToBed({ ...turned, position: [o.position[0] + ox + r.x - hc[0], o.position[1] + oy + r.y - hc[1], o.position[2]] });
  }, objs.map((o) => o.id));
  if (over) s.set({ toast: { kind: 'warn', text: `${over} object${over > 1 ? 's do' : ' does'} not fit on the plate and ${over > 1 ? 'were' : 'was'} placed beside it.` } });
}

function hullCentroid(h: Pt[]): Pt {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < h.length; i++) {
    const [x0, y0] = h[i], [x1, y1] = h[(i + 1) % h.length];
    const c = x0 * y1 - x1 * y0;
    a += c; cx += (x0 + x1) * c; cy += (y0 + y1) * c;
  }
  return Math.abs(a) < 1e-9 ? h[0] ?? [0, 0] : [cx / (3 * a), cy / (3 * a)];
}

/** Rotation (euler degrees) that turns `normal` (world) to face straight down, composed with current rotation. */
function rotationFacingDown(o: SceneObject, worldNormal: THREE.Vector3): [number, number, number] {
  const q = new THREE.Quaternion().setFromUnitVectors(worldNormal.clone().normalize(), new THREE.Vector3(0, 0, -1));
  const cur = new THREE.Quaternion().setFromEuler(new THREE.Euler(o.rotation[0] / DEG, o.rotation[1] / DEG, o.rotation[2] / DEG, 'XYZ'));
  const e = new THREE.Euler().setFromQuaternion(q.multiply(cur), 'XYZ');
  return [e.x * DEG, e.y * DEG, e.z * DEG].map((v) => +v.toFixed(4)) as [number, number, number];
}

export function layOnFace(id: string, worldNormal: THREE.Vector3) {
  const s = useStore.getState();
  s.updateObjects((o) => dropToBed({ ...o, rotation: rotationFacingDown(o, worldNormal) }), [id]);
}

/** Evaluate candidate "down" directions; minimise overhang area, maximise bed contact. */
export function autoOrient(ids?: string[]) {
  const s = useStore.getState();
  const targets = s.objects.filter((o) => (ids ?? s.selected).includes(o.id));
  if (!targets.length) return;
  const updates = new Map<string, [number, number, number]>();
  for (const o of targets) {
    const m = objectMatrix(o);
    const nm = new THREE.Matrix3().getNormalMatrix(m);
    const v = o.mesh.vertices, ix = o.mesh.indices;
    // world-space face normals & areas
    const faces: { n: THREE.Vector3; a: number; c: THREE.Vector3 }[] = [];
    const A = new THREE.Vector3(), B = new THREE.Vector3(), Cc = new THREE.Vector3();
    for (let t = 0; t < ix.length; t += 3) {
      A.fromArray(v, ix[t] * 3).applyMatrix4(m); B.fromArray(v, ix[t + 1] * 3).applyMatrix4(m); Cc.fromArray(v, ix[t + 2] * 3).applyMatrix4(m);
      const n = new THREE.Vector3().subVectors(B, A).cross(new THREE.Vector3().subVectors(Cc, A));
      const a = n.length() / 2;
      if (a < 1e-9) continue;
      faces.push({ n: n.normalize(), a, c: A.clone().add(B).add(Cc).divideScalar(3) });
    }
    void nm;
    // candidate directions: 6 axes + 24 largest normal clusters
    const clusters: { n: THREE.Vector3; a: number }[] = [];
    for (const f of faces) {
      const c = clusters.find((k) => k.n.dot(f.n) > 0.996);
      if (c) c.a += f.a; else clusters.push({ n: f.n.clone(), a: f.a });
    }
    clusters.sort((a, b) => b.a - a.a);
    const cands = [
      new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0),
      new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, -1, 0),
      ...clusters.slice(0, 24).map((c) => c.n),
    ];
    let best = cands[0], bestCost = Infinity;
    const cos45 = Math.cos(Math.PI / 4);
    for (const d of cands) {
      // in rotated frame "down" = d. height along -d of each point: h = -(p·d)
      let minH = Infinity, maxH = -Infinity;
      for (const f of faces) { const h = -f.c.dot(d); if (h < minH) minH = h; if (h > maxH) maxH = h; }
      let bottom = 0, overhang = 0;
      for (const f of faces) {
        const nd = f.n.dot(d); // 1 = facing straight down
        const h = -f.c.dot(d) - minH;
        if (nd > 0.999 && h < 0.1) bottom += f.a;
        else if (nd > cos45) overhang += f.a * nd;
      }
      const cost = overhang - 3 * bottom + 0.05 * (maxH - minH) * Math.sqrt(bottom + 1);
      if (cost < bestCost) { bestCost = cost; best = d; }
    }
    updates.set(o.id, rotationFacingDown(o, best));
  }
  s.updateObjects((o) => dropToBed({ ...o, rotation: updates.get(o.id)! }), [...updates.keys()]);
}

export function centreOnBed(o: SceneObject, printerId: string, plate = useStore.getState().activePlate): SceneObject {
  const p = printerById(printerId);
  const [ox, oy] = plateOrigin(plate, printerId);
  const b = worldBounds(o);
  return dropToBed({ ...o, position: [o.position[0] + ox + p.bed.x / 2 - (b.min[0] + b.max[0]) / 2, o.position[1] + oy + p.bed.y / 2 - (b.min[1] + b.max[1]) / 2, o.position[2]] });
}

// ---------------------------------------------------------------- plates
/** Arrange every unlocked plate, like the toolbar Arrange. */
export function arrangeAll(spacing?: number) {
  const s = useStore.getState();
  oneUndoStep(() => s.plates.forEach((p, i) => { if (!p.locked) arrange(spacing, i); }));
}

/** Run several object edits as one user action: a single Undo brings back the scene as it was before `fn`. */
export function oneUndoStep(fn: () => void) {
  const before = useStore.getState().objects;
  fn();
  const s = useStore.getState();
  const k = s.undoStack.lastIndexOf(before);
  if (k >= 0 && k < s.undoStack.length - 1) s.set({ undoStack: s.undoStack.slice(0, k + 1) });
}

/** Arrange only the selected objects, each group on its own plate. */
export function arrangeSelected(spacing?: number) {
  const s = useStore.getState();
  const plates = new Set(s.objects.filter((o) => s.selected.includes(o.id)).map((o) => objectPlate(o, s.printerId, s.plates.length)));
  oneUndoStep(() => { for (const p of plates) arrange(spacing, p, s.selected); });
}

/** Auto orient every object on a plate (skipped while the plate is locked). */
export function orientPlate(plate = useStore.getState().activePlate) {
  const s = useStore.getState();
  if (s.plates[plate]?.locked) return;
  const ids = s.objects.filter((o) => objectPlate(o, s.printerId, s.plates.length) === plate).map((o) => o.id);
  if (ids.length) autoOrient(ids);
}

export function updatePlate(index: number, patch: Partial<Plate>) {
  const s = useStore.getState();
  s.set({ plates: s.plates.map((p, i) => (i === index ? { ...p, ...patch } : p)) });
  s.markDirty();
}

export function addPlate() {
  const s = useStore.getState();
  const n = s.plates.length;
  s.set({ plates: [...s.plates, { id: newId('plate'), name: `Plate ${n + 1}`, layerActions: [] }], activePlate: n });
}

export function deletePlate(index = useStore.getState().activePlate) {
  const s = useStore.getState();
  if (s.plates.length <= 1) return;
  const count = s.plates.length;
  const onPlate = s.objects.filter((o) => objectPlate(o, s.printerId, count) === index);
  if (onPlate.length && !confirm(`Delete ${s.plates[index].name} and its ${onPlate.length} object(s)?`)) return;
  s.checkpoint();
  // shift objects on later plates one cell back so they stay on their plate
  const dropIds = new Set(onPlate.map((o) => o.id));
  const objects = s.objects.filter((o) => !dropIds.has(o.id)).map((o) => {
    const pi = objectPlate(o, s.printerId, count);
    if (pi <= index) return o;
    const [ax, ay] = plateOrigin(pi, s.printerId), [bx, by] = plateOrigin(pi - 1, s.printerId);
    return { ...o, position: [o.position[0] + bx - ax, o.position[1] + by - ay, o.position[2]] as SceneObject['position'] };
  });
  const plates = s.plates.filter((_, i) => i !== index).map((p, i) => ({ ...p, name: `Plate ${i + 1}` }));
  s.set({ objects, plates, activePlate: Math.min(index, plates.length - 1), selected: [] });
  s.markDirty();
}

/** Move selected objects to another plate, keeping their position relative to the plate. */
export function moveToPlate(target: number) {
  const s = useStore.getState();
  s.updateObjects((o) => {
    const from = objectPlate(o, s.printerId, s.plates.length);
    const [ax, ay] = plateOrigin(from, s.printerId), [bx, by] = plateOrigin(target, s.printerId);
    return { ...o, position: [o.position[0] + bx - ax, o.position[1] + by - ay, o.position[2]] };
  });
}

// ---------------------------------------------------------------- primitive shapes
export type ShapeKind = 'box' | 'cylinder' | 'sphere' | 'cone' | 'disc' | 'torus' | 'tube' | 'hemisphere' | 'pyramid' | 'prism' | 'capsule';

/** Shapes offered by "Add primitive", in menu order. */
export const SHAPES: [ShapeKind, string][] = [
  ['box', 'Cube'], ['cylinder', 'Cylinder'], ['sphere', 'Sphere'], ['cone', 'Cone'], ['disc', 'Disc'], ['torus', 'Torus'],
  ['tube', 'Tube'], ['hemisphere', 'Hemisphere'], ['pyramid', 'Pyramid'], ['prism', 'Triangular prism'], ['capsule', 'Capsule'],
];

/** Closed surface of revolution around Z. profile: [radius, z] points; open profiles start and end on the axis, closed ones repeat their first point. */
function revolve(profile: [number, number][], seg: number, a0 = 0): number[] {
  const out: number[] = [];
  const P = (k: number, j: number) => { const a = a0 + (j / seg) * Math.PI * 2, [r, z] = profile[k]; return [r * Math.cos(a), r * Math.sin(a), z]; };
  for (let k = 0; k < profile.length - 1; k++) for (let j = 0; j < seg; j++) {
    const a = P(k, j), b = P(k, j + 1), c = P(k + 1, j + 1), d = P(k + 1, j);
    out.push(...a, ...b, ...c, ...a, ...c, ...d);
  }
  return out;
}

export function signedVolume(m: IndexedMesh) {
  const v = m.vertices, ix = m.indices;
  let vol = 0;
  for (let t = 0; t < ix.length; t += 3) {
    const a = ix[t] * 3, b = ix[t + 1] * 3, c = ix[t + 2] * 3;
    vol += v[a] * (v[b + 1] * v[c + 2] - v[b + 2] * v[c + 1]) - v[a + 1] * (v[b] * v[c + 2] - v[b + 2] * v[c]) + v[a + 2] * (v[b] * v[c + 1] - v[b + 1] * v[c]);
  }
  return vol / 6;
}

/** Chord tolerance for primitive tessellation (mm): curved surfaces deviate from the true shape by at most this. */
export const PRIMITIVE_CHORD_TOL = 0.001;

/** Segments needed around a full circle of radius `rad` for a chord error under `tol`. */
export function circleSegments(rad: number, tol = PRIMITIVE_CHORD_TOL): number {
  if (rad <= tol) return 8;
  const n = Math.ceil(Math.PI / Math.acos(1 - tol / rad));
  return Math.max(48, Math.min(1024, n + (n & 1)));
}

const flipWinding = (m: IndexedMesh) => { for (let t = 0; t < m.indices.length; t += 3) { const k = m.indices[t + 1]; m.indices[t + 1] = m.indices[t + 2]; m.indices[t + 2] = k; } };
const outward = (soup: number[]): IndexedMesh => { const m = weld(new Float32Array(soup)); if (signedVolume(m) < 0) flipWinding(m); return m; };

/**
 * Triangle soup of a primitive about `size` mm across (half-size r), optionally inset by a uniform wall `w`:
 * the inset surface is the exact offset of the shape by w inwards (planes and circles move by w).
 */
function primitiveSoup(shape: ShapeKind, r: number, tol: number, w = 0): number[] {
  const arc = (cx: number, cz: number, rad: number, from: number, to: number, n: number) =>
    Array.from({ length: n + 1 }, (_, i) => { const a = from + ((to - from) * i) / n; return [cx + rad * Math.cos(a), cz + rad * Math.sin(a)] as [number, number]; });
  const S = circleSegments(r, tol);
  // segments along an arc of `sweep` radians on a circle of radius rad
  const along = (rad: number, sweep: number) => Math.max(2, Math.ceil((circleSegments(rad, tol) * sweep) / (Math.PI * 2)));
  // shapes with an inscribed sphere (box, cylinder, sphere, cone, pyramid) inset exactly by a homothety about its centre
  const homothety = (inR: number, cz: number) => {
    if (inR - w <= 0) throw new Error(`the wall (${w} mm) is thicker than the shape allows (${(inR).toFixed(2)} mm)`);
    const k = (inR - w) / inR, out = primitiveSoup(shape, r, tol);
    for (let i = 0; i < out.length; i += 3) { out[i] *= k; out[i + 1] *= k; out[i + 2] = cz + (out[i + 2] - cz) * k; }
    return out;
  };
  const need = (ok: boolean, max: number) => { if (!ok) throw new Error(`the wall (${w} mm) is thicker than this shape allows (under ${max.toFixed(2)} mm)`); };
  const rho = (2 * r) / (1 + Math.sqrt(5)); // in-radius of the cone and pyramid (apex at +r, base at -r)
  if (w !== 0) {
    if (shape === 'torus' && 0.32 * r - w >= 0.68 * r) throw new Error(`the outside wall (${-w} mm) would close the torus hole (under ${(0.36 * r).toFixed(2)} mm)`);
    if (shape === 'box' || shape === 'cylinder' || shape === 'sphere') return homothety(r, 0);
    if (shape === 'cone' || shape === 'pyramid') return homothety(rho, -r + rho);
    if (shape === 'prism') { need(r - 2 * w > 0, r / 2); const h = r - w, c = r - 2 * w; return revolve([[0, -h], [c, -h], [c, h], [0, h]], 3, Math.PI / 2); }
    if (shape === 'disc') { need(0.15 * r - w > 0, 0.15 * r); const h = 0.15 * r - w; return revolve([[0, -h], [r - w, -h], [r - w, h], [0, h]], S); }
    if (shape === 'tube') { need(0.4 * r - 2 * w > 0, 0.2 * r); const a = 0.6 * r + w, b = r - w, h = r - w; return revolve([[a, -h], [b, -h], [b, h], [a, h], [a, -h]], S); }
    if (shape === 'torus') { need(0.32 * r - w > 0, 0.32 * r); const m = 0.32 * r - w; return revolve(arc(r * 0.68, 0, m, 0, Math.PI * 2, along(m, Math.PI * 2)), S); }
    if (shape === 'capsule') { need(0.5 * r - w > 0, 0.5 * r); const q = 0.5 * r - w; return revolve([...arc(0, -r * 0.5, q, -Math.PI / 2, 0, along(q, Math.PI / 2)), ...arc(0, r * 0.5, q, 0, Math.PI / 2, along(q, Math.PI / 2))], S); }
    if (shape === 'hemisphere') {
      const q = r - w; need(q > w, r / 2);
      const a0 = Math.asin(w / q);
      return revolve([[0, w], ...arc(0, 0, q, a0, Math.PI / 2, along(q, Math.PI / 2 - a0))], S);
    }
  }
  if (shape === 'box') {
    const v = [[-r, -r, -r], [r, -r, -r], [r, r, -r], [-r, r, -r], [-r, -r, r], [r, -r, r], [r, r, r], [-r, r, r]];
    const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
    const out: number[] = [];
    for (const t of f) for (const i of t) out.push(...v[i]);
    return out;
  }
  if (shape === 'cylinder') return revolve([[0, -r], [r, -r], [r, r], [0, r]], S);
  if (shape === 'prism') return revolve([[0, -r], [r, -r], [r, r], [0, r]], 3, Math.PI / 2);
  if (shape === 'disc') return revolve([[0, -r * 0.15], [r, -r * 0.15], [r, r * 0.15], [0, r * 0.15]], S);
  if (shape === 'cone') return revolve([[0, -r], [r, -r], [0, r]], S);
  if (shape === 'pyramid') return revolve([[0, -r], [r * Math.SQRT2, -r], [0, r]], 4, Math.PI / 4);
  if (shape === 'sphere') return revolve(arc(0, 0, r, -Math.PI / 2, Math.PI / 2, along(r, Math.PI)), S);
  if (shape === 'hemisphere') return revolve([[0, 0], ...arc(0, 0, r, 0, Math.PI / 2, along(r, Math.PI / 2))], S);
  if (shape === 'capsule') return revolve([...arc(0, -r * 0.5, r * 0.5, -Math.PI / 2, 0, along(r * 0.5, Math.PI / 2)), ...arc(0, r * 0.5, r * 0.5, 0, Math.PI / 2, along(r * 0.5, Math.PI / 2))], S);
  if (shape === 'tube') return revolve([[r * 0.6, -r], [r, -r], [r, r], [r * 0.6, r], [r * 0.6, -r]], S);
  if (shape === 'torus') return revolve(arc(r * 0.68, 0, r * 0.32, 0, Math.PI * 2, along(r * 0.32, Math.PI * 2)), S);
  return [];
}

/** A closed, outward-facing primitive about `size` mm across, centred on the origin.
 *  Round surfaces are tessellated to `tol` (default PRIMITIVE_CHORD_TOL), so the mesh is within a micron of the exact shape. */
export function primitive(shape: ShapeKind, size: number, tol = PRIMITIVE_CHORD_TOL): IndexedMesh {
  return outward(primitiveSoup(shape, size / 2, tol));
}

/**
 * Hollow primitive: the shape's surface plus its exact inset by `wall` mm, facing inwards. Subtracted from a body it
 * cuts a wall-thick slot along the shape's surface (splitting the body into inside and outside pieces); added, it is a
 * thin-walled shell of the shape. `innerFrom` is the first triangle of the inner surface (the slicer cuts outer minus inner).
 */
export function shellPrimitive(shape: ShapeKind, size: number, wall: number, tol = PRIMITIVE_CHORD_TOL, wallOut = 0): IndexedMesh & { innerFrom: number } {
  const out = Math.min(Math.max(0, wallOut), wall);
  // the skin runs from `out` outside the shape's surface to `wall - out` inside it
  const a = outward(primitiveSoup(shape, size / 2, tol, -out)), b = outward(primitiveSoup(shape, size / 2, tol, wall - out));
  flipWinding(b);
  const nv = a.vertices.length / 3, v = new Float32Array(a.vertices.length + b.vertices.length), ix = new Uint32Array(a.indices.length + b.indices.length);
  v.set(a.vertices); v.set(b.vertices, a.vertices.length);
  ix.set(a.indices); for (let i = 0; i < b.indices.length; i++) ix[a.indices.length + i] = b.indices[i] + nv;
  return { vertices: v, indices: ix, innerFrom: a.indices.length / 3 };
}

/**
 * Exact definition of a primitive object or part. The mesh is re-tessellated from it when the effective scale grows
 * (so a scaled-up cylinder stays within PRIMITIVE_CHORD_TOL of the true surface) and, for shells, when the wall or the
 * scale changes (so the wall stays `wall` mm thick in the world). `tess` is the scale the mesh was made for and `tris`
 * its triangle count: a mesh edited by another tool no longer matches and is left alone.
 */
export interface PrimSpec { shape: ShapeKind; size: number; wall?: number; /** Part of the wall outside the shape's surface (mm, 0 = all inside). */ wallOut?: number; tess: number; tris: number; /** Shells: first triangle of the inner surface. */ innerFrom?: number }

/** The mesh for a spec at an effective world scale (largest axis). */
export function primMesh(p: Pick<PrimSpec, 'shape' | 'size' | 'wall' | 'wallOut'>, scale = 1): IndexedMesh & { innerFrom?: number } {
  const tol = PRIMITIVE_CHORD_TOL / Math.max(1e-6, scale);
  return p.wall ? shellPrimitive(p.shape, p.size, p.wall / Math.max(1e-6, scale), tol, (p.wallOut ?? 0) / Math.max(1e-6, scale)) : primitive(p.shape, p.size, tol);
}

const maxAbs = (v: number[]) => Math.max(...v.map(Math.abs));
/** Geometric mean of the scale magnitudes: the factor a wall thickness is divided by to stay true in the world. */
const meanScale = (v: number[]) => Math.cbrt(Math.abs(v[0] * v[1] * v[2])) || 1;

/** Whether a mesh made at scale `tess` needs re-making at scale `now`: finer when growing, coarser when much smaller. */
const needsRetess = (tess: number, now: number) => now > tess * 1.15 || now < tess / 3;

/**
 * Re-tessellate an object's primitive mesh and its primitive parts for their current scale. Returns the object unchanged
 * when nothing needs it. Objects with paint keep their mesh (paint is per triangle).
 */
export function refreshPrimitives(o: SceneObject): SceneObject {
  let next = o;
  const op = o.prim;
  if (op && !o.paint && o.mesh.indices.length / 3 === op.tris && needsRetess(op.tess, maxAbs(o.scale))) {
    const s = maxAbs(o.scale), { innerFrom: _, ...m } = primMesh(op, s);
    centreMeshLocal(m);
    next = { ...next, mesh: m, prim: { ...op, tess: s, tris: m.indices.length / 3 } };
  }
  if (o.parts?.some((p) => p.prim)) {
    let changed = false;
    const parts = o.parts.map((p) => {
      const pp = p.prim;
      if (!pp || p.mesh.indices.length / 3 !== pp.tris) return p;
      const eff = [0, 1, 2].map((k) => o.scale[k] * p.scale[k]);
      const s = pp.wall ? meanScale(eff) : maxAbs(eff);
      const wallOff = pp.wall && Math.abs(s - pp.tess) > 1e-6 * s; // a shell's wall must follow every scale change
      if (!wallOff && !needsRetess(pp.tess, s)) return p;
      changed = true;
      const { innerFrom, ...m } = primMesh(pp, s);
      return { ...p, mesh: m, prim: { ...pp, tess: s, tris: m.indices.length / 3, innerFrom } };
    });
    if (changed) next = { ...next, parts };
  }
  return next;
}

/** Centre a mesh the way objects are stored (XY centred, min z = 0). */
function centreMeshLocal(m: IndexedMesh) {
  const v = m.vertices;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity;
  for (let i = 0; i < v.length; i += 3) { x0 = Math.min(x0, v[i]); x1 = Math.max(x1, v[i]); y0 = Math.min(y0, v[i + 1]); y1 = Math.max(y1, v[i + 1]); z0 = Math.min(z0, v[i + 2]); }
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  for (let i = 0; i < v.length; i += 3) { v[i] -= cx; v[i + 1] -= cy; v[i + 2] -= z0; }
}

export const PART_LABELS: Record<PartType, string> = {
  part: 'Part',
  negative: 'Negative part', modifier: 'Modifier', support_enforcer: 'Support enforcer', support_blocker: 'Support blocker',
};

/** Where a new part goes and how big it is: the object's centre in its own frame, half its smallest side. */
function partPlacement(o: SceneObject) {
  const b = worldBounds(o);
  const size = Math.max(4, Math.min(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) * 0.5);
  // place at the object's centre, expressed in the object frame (undo object scale)
  const centre = new THREE.Vector3((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2)
    .applyMatrix4(objectMatrix(o).invert());
  return { size, position: [centre.x, centre.y, centre.z] as Vec3, scale: [1 / o.scale[0], 1 / o.scale[1], 1 / o.scale[2]] as Vec3 };
}

export function addPart(objectId: string, type: PartType, shape: ShapeKind) {
  const s = useStore.getState();
  const o = s.objects.find((x) => x.id === objectId);
  if (!o) return;
  const { size, position, scale } = partPlacement(o);
  const mesh = primitive(shape, size);
  const part: ScenePart = {
    id: newId('part'), name: `${PART_LABELS[type]} (${shape})`, type, mesh, position, rotation: [0, 0, 0], scale,
    overrides: type === 'modifier' ? { sparse_infill_density: 50 } : {},
    prim: { shape, size, tess: 1, tris: mesh.indices.length / 3 },
  };
  s.updateObjects((x) => ({ ...x, parts: [...(x.parts ?? []), part] }), [objectId]);
  s.set({ selectedPart: part.id, selected: [objectId], processMode: 'objects' });
}

/**
 * Add a wall cutter (cut: a negative part that removes only a `wall`-thick skin along the shape's surface, so the
 * body is split along it) or a wall shell (add: a part that adds only that skin). Returns false when the wall does not fit.
 */
export function addWallPart(objectId: string, mode: 'cut' | 'add', shape: ShapeKind, wall: number, wallOut = 0): boolean {
  const s = useStore.getState();
  const o = s.objects.find((x) => x.id === objectId);
  if (!o || !(wall > 0)) return false;
  const { size, position, scale } = partPlacement(o);
  let mesh: ReturnType<typeof shellPrimitive>;
  try { mesh = shellPrimitive(shape, size, wall, PRIMITIVE_CHORD_TOL, wallOut); }
  catch (e: any) { s.set({ toast: { kind: 'warn', text: `Wall ${mode === 'cut' ? 'cutter' : 'shell'}: ${e?.message ?? e}.` } }); return false; }
  const { innerFrom, ...m } = mesh;
  const label = mode === 'cut' ? 'Wall cutter' : 'Wall shell';
  const part: ScenePart = {
    id: newId('part'), name: `${label} (${shape}, ${wall} mm)`, type: mode === 'cut' ? 'negative' : 'part', mesh: m, position, rotation: [0, 0, 0], scale, overrides: {},
    prim: { shape, size, wall, wallOut, tess: 1, tris: m.indices.length / 3, innerFrom },
  };
  s.updateObjects((x) => ({ ...x, parts: [...(x.parts ?? []), part] }), [objectId]);
  s.set({ selectedPart: part.id, selected: [objectId], processMode: 'objects' });
  return true;
}

/**
 * Change a wall cutter's or wall shell's thickness (mm, true in the world at any scale) and how much of it lies
 * outside the shape's surface (`wallOut`: 0 inside, wall/2 centred, wall outside, anything between = uneven).
 */
export function setPartWall(objectId: string, partId: string, wall: number, wallOut?: number) {
  const s = useStore.getState();
  const o = s.objects.find((x) => x.id === objectId), p = o?.parts?.find((x) => x.id === partId);
  if (!o || !p?.prim?.wall || !(wall > 0)) return;
  const eff = [0, 1, 2].map((k) => o.scale[k] * p.scale[k]);
  let mesh: ReturnType<typeof primMesh>;
  const wo = Math.min(wall, Math.max(0, wallOut ?? (p.prim.wallOut ?? 0) * (wall / p.prim.wall)));
  try { mesh = primMesh({ ...p.prim, wall, wallOut: wo }, meanScale(eff)); }
  catch (e: any) { s.set({ toast: { kind: 'warn', text: `Wall: ${e?.message ?? e}.` } }); return; }
  const { innerFrom, ...m } = mesh;
  updatePart(objectId, partId, (q) => ({ ...q, mesh: m, name: q.name.replace(/, [\d.]+ mm\)$/, `, ${wall} mm)`), prim: { ...q.prim!, wall, wallOut: wo, tess: meanScale(eff), tris: m.indices.length / 3, innerFrom } }));
}

/**
 * Add a weave wave zone: a modifier shape that carries only the wave keys (Motionex Weave), so infill and
 * walls stay as they are. It starts straddling the +X side of the wall at mid height, where it meets the
 * woven skin, and is selected so the move / scale / rotate handles appear.
 */
export function addWaveZone(objectId: string, shape: ShapeKind, overrides: Config = { wave_mode: 'wave' }) {
  const s = useStore.getState();
  const o = s.objects.find((x) => x.id === objectId);
  if (!o) return;
  const b = worldBounds(o);
  const size = Math.max(6, Math.min(b.max[2] - b.min[2], b.max[0] - b.min[0], b.max[1] - b.min[1]) * 0.4);
  const at = new THREE.Vector3(b.max[0], (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2).applyMatrix4(objectMatrix(o).invert());
  const mesh = primitive(shape, size);
  const n = (o.parts ?? []).filter((p) => p.type === 'modifier' && (p.overrides.wave_mode === 'wave' || p.overrides.wave_mode === 'plain')).length + 1;
  const part: ScenePart = {
    id: newId('part'), name: `Wave zone ${n} (${shape})`, type: 'modifier', mesh, position: [at.x, at.y, at.z], rotation: [0, 0, 0],
    scale: [1 / o.scale[0], 1 / o.scale[1], 1 / o.scale[2]], overrides, prim: { shape, size, tess: 1, tris: mesh.indices.length / 3 },
  };
  s.updateObjects((x) => ({ ...x, parts: [...(x.parts ?? []), part] }), [objectId]);
  s.set({ selectedPart: part.id, selected: [objectId], selectedRange: null, processMode: 'objects' });
  s.markDirty();
}

/** Add a weave wave band: a height range (start and end height) that carries only the wave keys. */
export function addWaveBand(objectId: string, overrides: Config = { wave_mode: 'wave' }) {
  const s = useStore.getState();
  const o = s.objects.find((x) => x.id === objectId);
  if (!o) return;
  const h = objectHeight(o);
  const r = { id: newId('range'), z0: +(h / 3).toFixed(2), z1: +((2 * h) / 3).toFixed(2), overrides };
  s.updateObjects((x) => ({ ...x, heightRanges: [...(x.heightRanges ?? []), r] }), [objectId]);
  s.set({ selected: [objectId], selectedPart: null, selectedRange: r.id, processMode: 'objects' });
  s.markDirty();
}

export function updatePart(objectId: string, partId: string, fn: (p: ScenePart) => ScenePart, record = true) {
  useStore.getState().updateObjects((o) => ({ ...o, parts: (o.parts ?? []).map((p) => (p.id === partId ? fn(p) : p)) }), [objectId], record);
}

// ---------------------------------------------------------------- variable layer height
function worldMesh(o: SceneObject): IndexedMesh {
  const m = objectMatrix(o).elements;
  const v = o.mesh.vertices, out = new Float32Array(v.length);
  let minZ = Infinity;
  for (let i = 0; i < v.length; i += 3) {
    out[i] = m[0] * v[i] + m[4] * v[i + 1] + m[8] * v[i + 2] + m[12];
    out[i + 1] = m[1] * v[i] + m[5] * v[i + 1] + m[9] * v[i + 2] + m[13];
    out[i + 2] = m[2] * v[i] + m[6] * v[i + 1] + m[10] * v[i + 2] + m[14];
    minZ = Math.min(minZ, out[i + 2]);
  }
  for (let i = 2; i < out.length; i += 3) out[i] -= minZ;
  return { vertices: out, indices: o.mesh.indices };
}

export function profileBounds() {
  const c = currentConfig();
  const nz = Number(c.nozzle_diameter);
  return { minHeight: +(nz * 0.2).toFixed(2), maxHeight: +(nz * 0.7).toFixed(2), firstLayer: Number(c.initial_layer_print_height), nominal: Number(c.layer_height) };
}

export function objectHeight(o: SceneObject) { const b = worldBounds(o); return b.max[2] - b.min[2]; }

export function currentProfile(o: SceneObject): number[] {
  const pb = profileBounds();
  return o.layerHeights?.length ? o.layerHeights : uniformProfile(objectHeight(o), pb.firstLayer, pb.nominal);
}

export function vlhAdaptive(id: string, quality: number) {
  const o = useStore.getState().objects.find((x) => x.id === id);
  if (!o) return;
  const pb = profileBounds();
  const prof = adaptiveProfile(worldMesh(o), { ...pb, quality });
  useStore.getState().updateObjects((x) => ({ ...x, layerHeights: prof }), [id]);
}
export function vlhSmooth(id: string, radius: number, keepMin: boolean) {
  const o = useStore.getState().objects.find((x) => x.id === id);
  if (!o) return;
  useStore.getState().updateObjects((x) => ({ ...x, layerHeights: smoothProfile(currentProfile(x), radius, keepMin) }), [id]);
}
export function vlhRange(id: string, z0: number, z1: number, h: number) {
  const o = useStore.getState().objects.find((x) => x.id === id);
  if (!o) return;
  useStore.getState().updateObjects((x) => ({ ...x, layerHeights: applyHeightRange(currentProfile(x), z0, z1, h, objectHeight(x)) }), [id]);
}
export function vlhReset(id: string) {
  useStore.getState().updateObjects((x) => ({ ...x, layerHeights: undefined }), [id]);
}

/** "Height range modifier": a Z band of the object with its own settings (starts as the middle third). */
export function addHeightRange(id: string) {
  const s = useStore.getState();
  const o = s.objects.find((x) => x.id === id);
  if (!o) return;
  const h = objectHeight(o);
  const r = { id: newId('range'), z0: +(h / 3).toFixed(2), z1: +((2 * h) / 3).toFixed(2), overrides: {} };
  s.updateObjects((x) => ({ ...x, heightRanges: [...(x.heightRanges ?? []), r] }), [id]);
  s.set({ selected: [id], selectedPart: null, selectedRange: r.id, processMode: 'objects' });
  s.markDirty();
}

export function updateHeightRange(id: string, rangeId: string, patch: Partial<{ z0: number; z1: number; overrides: Config }> | null) {
  const s = useStore.getState();
  s.updateObjects((x) => {
    const rs = (x.heightRanges ?? []).flatMap((r) => (r.id !== rangeId ? [r] : patch ? [{ ...r, ...patch }] : []));
    return { ...x, heightRanges: rs.length ? rs : undefined };
  }, [id]);
  if (!patch && s.selectedRange === rangeId) s.set({ selectedRange: null });
  s.markDirty();
}

setShapeRefresher(refreshPrimitives);
