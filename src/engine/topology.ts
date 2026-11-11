// Edge topology for an indexed triangle mesh: which triangles share an edge, how sharp it is, and
// which edges are feature edges (creases, open borders, boundaries between painted colours or source faces).
// Built on demand and cached per mesh object; edit tools and the viewport edge overlay read from it.
import type { IndexedMesh } from './mesh';

export const EDGE_SMOOTH = 0, EDGE_SHARP = 1, EDGE_BORDER = 2, EDGE_NONMANIFOLD = 3;

export interface Topology {
  vertexCount: number;
  triCount: number;
  edgeCount: number;
  /** 2 vertex ids per edge, a < b. */
  edgeV: Uint32Array;
  /** 2 triangle ids per edge (-1 where missing). With more than two faces on an edge only the first two are kept. */
  edgeTris: Int32Array;
  /** 3 edge ids per triangle (edge k joins corner k and k+1). */
  triEdges: Uint32Array;
  /** Angle between the two face normals in degrees: 0 flat, 180 folded back. Border / non-manifold edges read 180. */
  dihedral: Float32Array;
  /** EDGE_* class per edge. */
  kind: Uint8Array;
  /** Signed: >0 convex (outward bend), <0 concave. 0 for flat or unknown. */
  convex: Int8Array;
}

const cache = new WeakMap<IndexedMesh, Map<number, Topology>>();

/** Edge id for the vertex pair, or -1. */
export function edgeBetween(t: Topology, a: number, b: number, lookup?: Map<number, number>): number {
  const map = lookup ?? edgeLookup(t);
  return map.get(a < b ? a * t.vertexCount + b : b * t.vertexCount + a) ?? -1;
}

const lookups = new WeakMap<Topology, Map<number, number>>();
export function edgeLookup(t: Topology): Map<number, number> {
  let m = lookups.get(t);
  if (!m) {
    m = new Map();
    const n = t.vertexCount;
    for (let e = 0; e < t.edgeCount; e++) m.set(t.edgeV[e * 2] * n + t.edgeV[e * 2 + 1], e);
    lookups.set(t, m);
  }
  return m;
}

function faceNormal(v: Float32Array, ix: Uint32Array, t: number, out: number[]) {
  const a = ix[t * 3] * 3, b = ix[t * 3 + 1] * 3, c = ix[t * 3 + 2] * 3;
  const ux = v[b] - v[a], uy = v[b + 1] - v[a + 1], uz = v[b + 2] - v[a + 2];
  const wx = v[c] - v[a], wy = v[c + 1] - v[a + 1], wz = v[c + 2] - v[a + 2];
  let x = uy * wz - uz * wy, y = uz * wx - ux * wz, z = ux * wy - uy * wx;
  const l = Math.hypot(x, y, z) || 1;
  out[0] = x / l; out[1] = y / l; out[2] = z / l;
}

/** Build (or fetch from cache) the topology. `creaseDeg` is the dihedral angle from which an edge counts as sharp. */
export function buildTopology(m: IndexedMesh, creaseDeg = 30): Topology {
  const key = Math.round(creaseDeg * 10);
  let per = cache.get(m);
  const hit = per?.get(key);
  if (hit) return hit;
  const t = compute(m, creaseDeg);
  if (!per) cache.set(m, (per = new Map()));
  per.set(key, t);
  return t;
}

function compute(m: IndexedMesh, creaseDeg: number): Topology {
  const v = m.vertices, ix = m.indices;
  const n = v.length / 3;
  const triCount = ix.length / 3;
  const ids = new Map<number, number>();
  const ev: number[] = [];
  const et: number[] = [];
  const count: number[] = [];
  const triEdges = new Uint32Array(triCount * 3);
  for (let t = 0; t < triCount; t++) {
    for (let k = 0; k < 3; k++) {
      const a = ix[t * 3 + k], b = ix[t * 3 + ((k + 1) % 3)];
      const lo = a < b ? a : b, hi = a < b ? b : a;
      const key = lo * n + hi;
      let e = ids.get(key);
      if (e === undefined) {
        e = ev.length / 2;
        ids.set(key, e);
        ev.push(lo, hi); et.push(t, -1); count.push(1);
      } else {
        if (et[e * 2 + 1] < 0) et[e * 2 + 1] = t;
        count[e]++;
      }
      triEdges[t * 3 + k] = e;
    }
  }
  const edgeCount = ev.length / 2;
  const dihedral = new Float32Array(edgeCount);
  const kind = new Uint8Array(edgeCount);
  const convex = new Int8Array(edgeCount);
  const n1 = [0, 0, 0], n2 = [0, 0, 0];
  const cosCrease = Math.cos((creaseDeg * Math.PI) / 180);
  const cadGroups = m.groupKind === 'cad' ? m.faceGroups : undefined;
  const cosCad = Math.cos((2 * Math.PI) / 180);
  for (let e = 0; e < edgeCount; e++) {
    const t1 = et[e * 2], t2 = et[e * 2 + 1];
    if (count[e] > 2) { kind[e] = EDGE_NONMANIFOLD; dihedral[e] = 180; continue; }
    if (t2 < 0) { kind[e] = EDGE_BORDER; dihedral[e] = 180; continue; }
    faceNormal(v, ix, t1, n1); faceNormal(v, ix, t2, n2);
    const d = Math.max(-1, Math.min(1, n1[0] * n2[0] + n1[1] * n2[1] + n1[2] * n2[2]));
    dihedral[e] = (Math.acos(d) * 180) / Math.PI;
    if (d <= cosCrease || (cadGroups && cadGroups[t1] !== cadGroups[t2] && d <= cosCad)) {
      kind[e] = EDGE_SHARP;
      // convex when the far corner of face 2 lies behind face 1's plane
      const a = ev[e * 2], b = ev[e * 2 + 1];
      let far = -1;
      for (let k = 0; k < 3; k++) { const c = ix[t2 * 3 + k]; if (c !== a && c !== b) far = c; }
      const o = ix[t1 * 3] * 3;
      const s = (v[far * 3] - v[o]) * n1[0] + (v[far * 3 + 1] - v[o + 1]) * n1[1] + (v[far * 3 + 2] - v[o + 2]) * n1[2];
      convex[e] = s < -1e-9 ? 1 : s > 1e-9 ? -1 : 0;
    }
  }
  const topo: Topology = { vertexCount: n, triCount, edgeCount, edgeV: Uint32Array.from(ev), edgeTris: Int32Array.from(et), triEdges, dihedral, kind, convex };
  return topo;
}

/** Edge ids that are creases (>= creaseDeg of the topology), open borders or non-manifold. */
export function featureEdges(t: Topology, opts: { borders?: boolean } = {}): number[] {
  const out: number[] = [];
  for (let e = 0; e < t.edgeCount; e++) {
    const k = t.kind[e];
    if (k === EDGE_SHARP || k === EDGE_NONMANIFOLD || (k === EDGE_BORDER && opts.borders !== false)) out.push(e);
  }
  return out;
}

/** Edges between two triangles with different paint values (the outline of a coloured region). */
export function paintBoundaryEdges(t: Topology, paint: ArrayLike<number> | undefined): number[] {
  if (!paint) return [];
  const out: number[] = [];
  for (let e = 0; e < t.edgeCount; e++) {
    const a = t.edgeTris[e * 2], b = t.edgeTris[e * 2 + 1];
    if (a >= 0 && b >= 0 && (paint[a] ?? 0) !== (paint[b] ?? 0)) out.push(e);
  }
  return out;
}

/** Edges between two different source faces (OBJ polygons / CAD faces) that also bend by more than `minDeg`. */
export function faceGroupEdges(t: Topology, groups: ArrayLike<number> | undefined, minDeg = 1): number[] {
  if (!groups) return [];
  const out: number[] = [];
  for (let e = 0; e < t.edgeCount; e++) {
    const a = t.edgeTris[e * 2], b = t.edgeTris[e * 2 + 1];
    if (a >= 0 && b >= 0 && groups[a] !== groups[b] && t.dihedral[e] >= minDeg) out.push(e);
  }
  return out;
}

const adjCache = new WeakMap<Topology, { start: Uint32Array; list: Uint32Array }>();
/** Edges around each vertex, as a CSR table (edges of vertex i are list[start[i] .. start[i+1])). */
export function vertexEdges(t: Topology) {
  let a = adjCache.get(t);
  if (!a) {
    const start = new Uint32Array(t.vertexCount + 1);
    for (let e = 0; e < t.edgeCount; e++) { start[t.edgeV[e * 2] + 1]++; start[t.edgeV[e * 2 + 1] + 1]++; }
    for (let i = 0; i < t.vertexCount; i++) start[i + 1] += start[i];
    const fill = start.slice(0, t.vertexCount);
    const list = new Uint32Array(t.edgeCount * 2);
    for (let e = 0; e < t.edgeCount; e++) { list[fill[t.edgeV[e * 2]]++] = e; list[fill[t.edgeV[e * 2 + 1]]++] = e; }
    adjCache.set(t, (a = { start, list }));
  }
  return a;
}

/**
 * Grow one edge into the chain of edges that continues it: at each end follow the single other edge of the
 * same class that bends least from the current direction (within `maxTurnDeg`). Used so one click selects a whole
 * rim or a straight run instead of a single tessellation segment.
 */
export function edgeChain(m: IndexedMesh, t: Topology, start: number, allowed: (e: number) => boolean, maxTurnDeg = 40): number[] {
  const v = m.vertices;
  const adj = vertexEdges(t);
  const incident = (vtx: number) => { const out: number[] = []; for (let i = adj.start[vtx]; i < adj.start[vtx + 1]; i++) if (allowed(adj.list[i])) out.push(adj.list[i]); return out; };
  const cosMax = Math.cos((maxTurnDeg * Math.PI) / 180);
  const dir = (e: number, from: number) => {
    const a = t.edgeV[e * 2], b = t.edgeV[e * 2 + 1];
    const to = from === a ? b : a;
    const d = [v[to * 3] - v[from * 3], v[to * 3 + 1] - v[from * 3 + 1], v[to * 3 + 2] - v[from * 3 + 2]];
    const l = Math.hypot(d[0], d[1], d[2]) || 1;
    return [d[0] / l, d[1] / l, d[2] / l];
  };
  const chain = new Set<number>([start]);
  for (let end = 0; end < 2; end++) {
    let cur = start;
    let at = t.edgeV[start * 2 + end]; // vertex we leave through
    for (;;) {
      const incoming = dir(cur, at); // pointing back along cur, away from `at`
      const cands = incident(at).filter((e) => e !== cur && !chain.has(e));
      let best = -1, bestDot = -2;
      for (const e of cands) {
        const d = dir(e, at);
        const dot = -(d[0] * incoming[0] + d[1] * incoming[1] + d[2] * incoming[2]); // 1 = straight on
        if (dot > bestDot) { bestDot = dot; best = e; }
      }
      // a junction with several continuations is ambiguous: stop unless one is clearly the straightest
      if (best < 0 || bestDot < cosMax || cands.length > 2) break;
      chain.add(best);
      cur = best;
      at = t.edgeV[best * 2] === at ? t.edgeV[best * 2 + 1] : t.edgeV[best * 2];
    }
  }
  return [...chain];
}
