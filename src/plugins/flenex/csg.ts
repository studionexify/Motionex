import * as THREE from 'three';
import Module from 'manifold-3d';
import wasmUrl from 'manifold-3d/manifold.wasm?url';
import { MeshBVH } from 'three-mesh-bvh';
import { weld, type IndexedMesh } from '../../engine/mesh';

export type V3 = [number, number, number];
export type BoolOp = 'union' | 'difference' | 'intersection';

// ---------------------------------------------------------------- kernel (manifold-3d, WebAssembly)
// Manifold booleans always return a watertight, manifold mesh, which is what print-in-place joints need.
// The WebAssembly module loads once; call `await initKernel()` before building.
let wasm: any = null;
let loading: Promise<void> | null = null;
export function initKernel(): Promise<void> {
  loading ??= (async () => {
    // a page or a worker needs the bundled file's address; Node finds it by itself
    const inBrowser = typeof process === 'undefined' || !process.versions?.node;
    wasm = await Module(inBrowser ? { locateFile: () => wasmUrl } : undefined);
    wasm.setup();
  })();
  return loading;
}
const need = () => { if (!wasm) throw new Error('Flenex kernel is not loaded yet (call initKernel first).'); return wasm; };

/** A solid in the kernel. Free it with free() when done. */
export type Solid = any;

export function solid(m: IndexedMesh): Solid {
  const w = need();
  const mesh = new w.Mesh({ numProp: 3, vertProperties: m.vertices, triVerts: m.indices });
  mesh.merge();
  const s = new w.Manifold(mesh);
  const status = s.status();
  if (status !== 'NoError') { s.delete(); throw new Error(`Mesh is not a closed solid (${status}).`); }
  return s;
}

export function meshOf(s: Solid): IndexedMesh {
  const r = s.getMesh();
  const stride = r.numProp;
  const vp = r.vertProperties as Float32Array;
  let vertices = vp;
  if (stride !== 3) { vertices = new Float32Array((vp.length / stride) * 3); for (let i = 0, j = 0; i < vp.length; i += stride, j += 3) { vertices[j] = vp[i]; vertices[j + 1] = vp[i + 1]; vertices[j + 2] = vp[i + 2]; } }
  return { vertices: new Float32Array(vertices), indices: new Uint32Array(r.triVerts) };
}

export const free = (...s: (Solid | null | undefined)[]) => { for (const x of s) x?.delete?.(); };

const apply = (a: Solid, b: Solid, op: BoolOp): Solid => (op === 'union' ? a.add(b) : op === 'difference' ? a.subtract(b) : a.intersect(b));

/** Union of many solids at once. */
export const unionAll = (list: Solid[]): Solid => need().Manifold.union(list);

export const isEmpty = (m: IndexedMesh) => m.indices.length === 0;

/** a ∘ b on plain meshes. */
export function boolean(a: IndexedMesh, b: IndexedMesh, op: BoolOp): IndexedMesh {
  if (isEmpty(a)) return op === 'union' ? b : a;
  if (isEmpty(b)) return op === 'intersection' ? b : a;
  const A = solid(a), B = solid(b);
  const R = apply(A, B, op);
  const out = meshOf(R);
  free(A, B, R);
  return out;
}

export const union = (a: IndexedMesh, ...rest: IndexedMesh[]) => rest.reduce((m, b) => boolean(m, b, 'union'), a);
export const subtract = (a: IndexedMesh, ...rest: IndexedMesh[]) => rest.reduce((m, b) => boolean(m, b, 'difference'), a);

/** Heal a mesh from an import so it can be a solid: weld, drop collapsed triangles. */
export function dropDegenerate(m: IndexedMesh): IndexedMesh {
  const keep: number[] = [];
  for (let t = 0; t < m.indices.length; t += 3) {
    const a = m.indices[t], b = m.indices[t + 1], c = m.indices[t + 2];
    if (a !== b && b !== c && a !== c) keep.push(a, b, c);
  }
  return keep.length === m.indices.length ? m : { vertices: m.vertices, indices: Uint32Array.from(keep) };
}

const toGeometry = (m: IndexedMesh) => {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(m.vertices, 3));
  g.setIndex(new THREE.BufferAttribute(m.indices, 1));
  return g;
};
export const fromGeometry = (g: THREE.BufferGeometry): IndexedMesh => {
  const ng = g.index ? g.toNonIndexed() : g;
  return dropDegenerate(weld(new Float32Array(ng.getAttribute('position').array as ArrayLike<number>), 1e-5));
};

/**
 * The region swept by a 2D profile turning about `pivot` through ±rom degrees, grown by `offset`, cut off below
 * `clipZ` and extruded along the second axis from a0 to a1. Plane coordinates are (u, z); the result is in (u, a, z).
 * This is the exact socket for a tongue on a pin: whatever the tongue reaches while it swings, plus the clearance.
 */
export function sweptSlot(profile: [number, number][], pivot: [number, number], rom: number, offset: number, clipZ: number, a0: number, a1: number, steps = 16): IndexedMesh {
  const w = need();
  const base = new w.CrossSection([profile], 'Positive');
  const copies = [];
  for (let i = 0; i <= steps; i++) {
    const ang = -rom + (2 * rom * i) / steps;
    copies.push(base.translate([-pivot[0], -pivot[1]]).rotate(ang).translate(pivot));
  }
  let u = w.CrossSection.union(copies).offset(offset, 'Round', 2, 28);
  const big = 400;
  const half = w.CrossSection.square([2 * big, 2 * big]).translate([-big, clipZ]);
  const clipped = u.intersect(half);
  const m = clipped.extrude(a1 - a0);
  const out = meshOf(m);
  free(m, base, u, half, clipped, ...copies);
  const v = out.vertices, o = new Float32Array(v.length);
  for (let i = 0; i < v.length; i += 3) { o[i] = v[i]; o[i + 1] = v[i + 2] + a0; o[i + 2] = v[i + 1]; }
  const ix = out.indices.slice();
  for (let i = 0; i < ix.length; i += 3) { const t = ix[i + 1]; ix[i + 1] = ix[i + 2]; ix[i + 2] = t; }
  return { vertices: o, indices: ix };
}

// ---------------------------------------------------------------- transforms
export function transform(m: IndexedMesh, mat: THREE.Matrix4): IndexedMesh {
  const v = new Float32Array(m.vertices.length), p = new THREE.Vector3();
  for (let i = 0; i < v.length; i += 3) { p.set(m.vertices[i], m.vertices[i + 1], m.vertices[i + 2]).applyMatrix4(mat); v[i] = p.x; v[i + 1] = p.y; v[i + 2] = p.z; }
  const flip = mat.determinant() < 0;
  const ix = flip ? flipWinding(m.indices) : m.indices;
  return { vertices: v, indices: ix };
}
const flipWinding = (ix: Uint32Array) => { const o = ix.slice(); for (let i = 0; i < o.length; i += 3) { const t = o[i + 1]; o[i + 1] = o[i + 2]; o[i + 2] = t; } return o; };

export function merge(parts: IndexedMesh[]): IndexedMesh {
  let nv = 0, ni = 0;
  for (const p of parts) { nv += p.vertices.length; ni += p.indices.length; }
  const vertices = new Float32Array(nv), indices = new Uint32Array(ni);
  let ov = 0, oi = 0;
  for (const p of parts) {
    vertices.set(p.vertices, ov);
    for (let i = 0; i < p.indices.length; i++) indices[oi + i] = p.indices[i] + ov / 3;
    ov += p.vertices.length; oi += p.indices.length;
  }
  return { vertices, indices };
}

export function bounds(m: IndexedMesh): { min: V3; max: V3 } {
  const min: V3 = [Infinity, Infinity, Infinity], max: V3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < m.vertices.length; i += 3) for (let k = 0; k < 3; k++) { const x = m.vertices[i + k]; if (x < min[k]) min[k] = x; if (x > max[k]) max[k] = x; }
  return { min, max };
}

export function volume(m: IndexedMesh): number {
  const V = m.vertices, I = m.indices;
  let v = 0;
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    v += V[a] * (V[b + 1] * V[c + 2] - V[b + 2] * V[c + 1]) - V[a + 1] * (V[b] * V[c + 2] - V[b + 2] * V[c]) + V[a + 2] * (V[b] * V[c + 1] - V[b + 1] * V[c]);
  }
  return v / 6;
}

// ---------------------------------------------------------------- primitives (solid, outward)
const idx = (g: THREE.BufferGeometry) => fromGeometry(g);

/** Axis-aligned box centred on the origin. */
export const box = (sx: number, sy: number, sz: number) => idx(new THREE.BoxGeometry(sx, sy, sz));

/** Cylinder along z from z0 to z1. r1 at z1 (cone when different). */
export function cylinder(r0: number, r1: number, z0: number, z1: number, seg = 24, rotZ = 0): IndexedMesh {
  const g = new THREE.CylinderGeometry(r1, r0, Math.abs(z1 - z0), seg, 1, false, rotZ);
  g.rotateX(Math.PI / 2);
  g.translate(0, 0, (z0 + z1) / 2);
  return idx(g);
}

export function sphere(r: number, seg = 20, at: V3 = [0, 0, 0], sx = 1, sy = 1, sz = 1): IndexedMesh {
  const g = new THREE.SphereGeometry(r, seg, Math.max(6, Math.round(seg * 0.6)));
  g.rotateX(Math.PI / 2);
  g.scale(sx, sy, sz);
  g.translate(...at);
  return idx(g);
}

/** Extrude a closed 2D polygon (counter-clockwise or not) along z from z0 to z1. */
export function prism(poly: [number, number][], z0: number, z1: number): IndexedMesh {
  const shape = new THREE.Shape(poly.map(([x, y]) => new THREE.Vector2(x, y)));
  const g = new THREE.ExtrudeGeometry(shape, { depth: z1 - z0, bevelEnabled: false, steps: 1 });
  g.translate(0, 0, z0);
  return idx(g);
}

/** Tube/solid of revolution lofted through rings (each ring a closed loop of the same point count). */
export function loft(rings: V3[][], capStart = true, capEnd = true): IndexedMesh {
  const n = rings[0].length, soup: number[] = [];
  const tri = (a: V3, b: V3, c: V3) => soup.push(...a, ...b, ...c);
  for (let k = 0; k < rings.length - 1; k++) {
    const A = rings[k], B = rings[k + 1];
    for (let j = 0; j < n; j++) { const j1 = (j + 1) % n; tri(A[j], A[j1], B[j1]); tri(A[j], B[j1], B[j]); }
  }
  const cap = (ring: V3[], up: boolean) => {
    const c: V3 = [0, 0, 0];
    for (const p of ring) { c[0] += p[0] / n; c[1] += p[1] / n; c[2] += p[2] / n; }
    for (let j = 0; j < n; j++) { const j1 = (j + 1) % n; if (up) tri(ring[j], ring[j1], c); else tri(ring[j1], ring[j], c); }
  };
  if (capStart) cap(rings[0], false);
  if (capEnd) cap(rings[rings.length - 1], true);
  const m = weld(new Float32Array(soup), 1e-4);
  if (volume(m) < 0) m.indices = flipWinding(m.indices);
  return m;
}

// ---------------------------------------------------------------- pieces
/** Connected components of a mesh (shared vertices), each as its own indexed mesh, plus the triangle → piece map. */
export function pieces(m: IndexedMesh): { meshes: IndexedMesh[]; triPiece: Int32Array } {
  const nv = m.vertices.length / 3, parent = new Int32Array(nv).map((_, i) => i);
  const find = (x: number) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (let t = 0; t < m.indices.length; t += 3) {
    const a = find(m.indices[t]), b = find(m.indices[t + 1]), c = find(m.indices[t + 2]);
    if (a !== b) parent[b] = a;
    const r = find(a);
    if (r !== c) parent[c] = r;
  }
  const triPiece = new Int32Array(m.indices.length / 3), ids = new Map<number, number>();
  for (let t = 0; t < triPiece.length; t++) {
    const r = find(m.indices[t * 3]);
    let id = ids.get(r);
    if (id === undefined) { id = ids.size; ids.set(r, id); }
    triPiece[t] = id;
  }
  const groups: number[][] = Array.from({ length: ids.size }, () => []);
  for (let t = 0; t < triPiece.length; t++) groups[triPiece[t]].push(t);
  const meshes = groups.map((tris) => {
    const map = new Map<number, number>(), verts: number[] = [], ix: number[] = [];
    for (const t of tris) for (let c = 0; c < 3; c++) {
      const v = m.indices[t * 3 + c];
      let n = map.get(v);
      if (n === undefined) { n = verts.length / 3; verts.push(m.vertices[v * 3], m.vertices[v * 3 + 1], m.vertices[v * 3 + 2]); map.set(v, n); }
      ix.push(n);
    }
    return { vertices: new Float32Array(verts), indices: Uint32Array.from(ix) };
  });
  return { meshes, triPiece };
}

/** Smallest distance between the surfaces of two meshes (sampled on a's vertices both ways). */
export function minDistance(a: IndexedMesh, b: IndexedMesh): number {
  const bvhB = new MeshBVH(toGeometry(b)), bvhA = new MeshBVH(toGeometry(a));
  const t = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 };
  let best = Infinity;
  const p = new THREE.Vector3();
  for (const [from, bvh] of [[a, bvhB], [b, bvhA]] as const) {
    for (let i = 0; i < from.vertices.length; i += 3) {
      p.set(from.vertices[i], from.vertices[i + 1], from.vertices[i + 2]);
      const r = bvh.closestPointToPoint(p, t as never);
      if (r && r.distance < best) best = r.distance;
    }
  }
  return best;
}

export { toGeometry };
