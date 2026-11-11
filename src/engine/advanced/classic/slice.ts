// Frozen classic engine of Advanced mode (as on main at 08b924a). Advanced mode slices with this engine
// only, so Basic-engine changes never alter Advanced output and vice versa.
// Stage 2: Z-plane mesh intersection + topological loop chaining.
import { cleanPaths, SCALE, unionEvenOdd } from '../../clipper';
import type { Paths } from '../../types';
import type { IndexedMesh } from '../../mesh';

/**
 * Slice an indexed mesh at each given plane height.
 * Intersection points are keyed by the mesh edge they lie on, so loops chain
 * by topology rather than float comparison. Regions use even-odd fill, which is
 * robust to inconsistent triangle winding.
 */
export function sliceMesh(mesh: IndexedMesh, planes: number[]): Paths[] {
  const v = mesh.vertices, ix = mesh.indices;
  const nV = v.length / 3;
  const triCount = ix.length / 3;

  // Sort triangles by min Z for a sweep.
  const tmin = new Float64Array(triCount), tmax = new Float64Array(triCount);
  for (let t = 0; t < triCount; t++) {
    const za = v[ix[t * 3] * 3 + 2], zb = v[ix[t * 3 + 1] * 3 + 2], zc = v[ix[t * 3 + 2] * 3 + 2];
    tmin[t] = Math.min(za, zb, zc); tmax[t] = Math.max(za, zb, zc);
  }
  const order = Array.from({ length: triCount }, (_, i) => i).sort((a, b) => tmin[a] - tmin[b]);

  const result: Paths[] = [];
  let active: number[] = [];
  let next = 0;

  for (const z of planes) {
    while (next < order.length && tmin[order[next]] <= z) active.push(order[next++]);
    active = active.filter((t) => tmax[t] >= z);

    // edgeKey -> intersection point
    const ptX = new Map<number, number>(), ptY = new Map<number, number>();
    const segA: number[] = [], segB: number[] = [];

    for (const t of active) {
      const i0 = ix[t * 3], i1 = ix[t * 3 + 1], i2 = ix[t * 3 + 2];
      const tri = [i0, i1, i2];
      const keys: number[] = [];
      for (let e = 0; e < 3; e++) {
        const a = tri[e], b = tri[(e + 1) % 3];
        const za = v[a * 3 + 2], zb = v[b * 3 + 2];
        const aAbove = za >= z, bAbove = zb >= z;
        if (aAbove === bAbove) continue;
        const lo = a < b ? a : b, hi = a < b ? b : a;
        const key = lo * nV + hi;
        if (!ptX.has(key)) {
          const zl = v[lo * 3 + 2], zh = v[hi * 3 + 2];
          const s = (z - zl) / (zh - zl);
          ptX.set(key, v[lo * 3] + s * (v[hi * 3] - v[lo * 3]));
          ptY.set(key, v[lo * 3 + 1] + s * (v[hi * 3 + 1] - v[lo * 3 + 1]));
        }
        keys.push(key);
      }
      if (keys.length === 2) { segA.push(keys[0]); segB.push(keys[1]); }
    }

    // adjacency: point key -> segment ids
    const adj = new Map<number, number[]>();
    for (let s = 0; s < segA.length; s++) {
      for (const k of [segA[s], segB[s]]) {
        const l = adj.get(k);
        if (l) l.push(s); else adj.set(k, [s]);
      }
    }
    const used = new Uint8Array(segA.length);
    const loops: Paths = [];
    for (let s0 = 0; s0 < segA.length; s0++) {
      if (used[s0]) continue;
      used[s0] = 1;
      const keys = [segA[s0], segB[s0]];
      let cur = segB[s0];
      for (;;) {
        const cand = adj.get(cur);
        let nextSeg = -1;
        if (cand) for (const s of cand) if (!used[s]) { nextSeg = s; break; }
        if (nextSeg < 0) break;
        used[nextSeg] = 1;
        cur = segA[nextSeg] === cur ? segB[nextSeg] : segA[nextSeg];
        if (cur === keys[0]) break;
        keys.push(cur);
      }
      if (keys.length >= 3) {
        loops.push(keys.map((k) => ({ X: Math.round(ptX.get(k)! * SCALE), Y: Math.round(ptY.get(k)! * SCALE) })));
      }
    }
    result.push(loops.length ? cleanPaths(unionEvenOdd(loops)) : []);
  }
  return result;
}
