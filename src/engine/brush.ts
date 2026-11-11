// Painting brushes of the support / seam / colour painting gizmos. Each returns the triangles a stroke
// at one point covers. Coordinates are the object's local (mesh) space.
import type { IndexedMesh } from './mesh';
import { growFaces, triAdjacency, triNormals } from './facesets';

export type BrushType = 'circle' | 'sphere' | 'triangle' | 'fill' | 'height_range' | 'gap_fill';

export const BRUSHES: Record<'support' | 'seam' | 'color', BrushType[]> = {
  support: ['circle', 'sphere', 'fill', 'gap_fill'],
  seam: ['circle', 'sphere'],
  color: ['circle', 'sphere', 'triangle', 'height_range', 'fill', 'gap_fill'],
};
export const BRUSH_LABELS: Record<BrushType, string> = {
  circle: 'Circle', sphere: 'Sphere', triangle: 'Triangle', fill: 'Fill', height_range: 'Height range', gap_fill: 'Gap fill',
};

export interface MeshCache { adj: Uint32Array[]; normals: Float32Array; areas: Float32Array }
const cache = new WeakMap<IndexedMesh, MeshCache>();
export function meshCache(m: IndexedMesh): MeshCache {
  let c = cache.get(m);
  if (!c) {
    const normals = triNormals(m), v = m.vertices, ix = m.indices, T = ix.length / 3;
    const areas = new Float32Array(T);
    for (let t = 0; t < T; t++) {
      const a = ix[t * 3] * 3, b = ix[t * 3 + 1] * 3, cc = ix[t * 3 + 2] * 3;
      const ux = v[b] - v[a], uy = v[b + 1] - v[a + 1], uz = v[b + 2] - v[a + 2];
      const wx = v[cc] - v[a], wy = v[cc + 1] - v[a + 1], wz = v[cc + 2] - v[a + 2];
      areas[t] = Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx) / 2;
    }
    c = { adj: triAdjacency(m), normals, areas };
    cache.set(m, c);
  }
  return c;
}

/** Smart fill: the clicked triangle and every neighbour reachable without crossing an edge sharper than `angle`. */
export function fillTriangles(m: IndexedMesh, seed: number, angle: number): Uint32Array {
  const c = meshCache(m);
  return growFaces(m, seed, angle, c.adj, c.normals);
}

/** Height range: every triangle touching the band [z0, z1] of the given height function (world Z per vertex). */
export function heightRangeTriangles(m: IndexedMesh, worldZ: (vi: number) => number, z0: number, z1: number): number[] {
  const ix = m.indices, out: number[] = [];
  for (let t = 0; t < ix.length / 3; t++) {
    const a = worldZ(ix[t * 3]), b = worldZ(ix[t * 3 + 1]), c = worldZ(ix[t * 3 + 2]);
    if (Math.max(a, b, c) >= z0 && Math.min(a, b, c) <= z1) out.push(t);
  }
  return out;
}

/**
 * Gap fill: islands of unpainted triangles whose total area is below `maxArea` (mm², mesh space), lying between
 * painted triangles, take the value of their neighbours (the most common one).
 */
export function gapFill(m: IndexedMesh, paint: Uint8Array, maxArea: number): { tris: number[]; value: number }[] {
  const c = meshCache(m), T = paint.length;
  const seen = new Uint8Array(T);
  const out: { tris: number[]; value: number }[] = [];
  for (let s = 0; s < T; s++) {
    if (seen[s] || paint[s]) continue;
    const comp = [s];
    seen[s] = 1;
    let area = 0;
    const border = new Map<number, number>();
    for (let k = 0; k < comp.length; k++) {
      const t = comp[k];
      area += c.areas[t];
      for (const u of c.adj[t]) {
        if (paint[u]) { border.set(paint[u], (border.get(paint[u]) ?? 0) + 1); continue; }
        if (!seen[u]) { seen[u] = 1; comp.push(u); }
      }
    }
    if (area > maxArea || !border.size) continue;
    let best = 0, n = -1;
    for (const [v, k] of border) if (k > n) { n = k; best = v; }
    out.push({ tris: comp, value: best });
  }
  return out;
}
