// Surface edit tools on indexed triangle meshes: chamfer / fillet of chosen edges, subdivision
// (Catmull-Clark on quad / polygon faces, Loop on plain triangles) and crease-preserving smoothing.
// Every tool returns the new mesh plus `triSource`: for each new triangle, the old triangle it came from,
// so per-triangle paint (support / seam / colour / ...) can be carried across the edit.
import type { IndexedMesh } from './mesh';
import { buildTopology, edgeLookup, EDGE_BORDER, EDGE_NONMANIFOLD, EDGE_SHARP, type Topology } from './topology';

export interface EditResult {
  mesh: IndexedMesh;
  /** Old triangle index for every new triangle. */
  triSource: Uint32Array;
}

/** A mesh edge by its two vertex ids (order does not matter). */
export type EdgePair = [number, number];

export interface BevelResult extends EditResult {
  /** Edges actually bevelled. */
  applied: number;
  /** Edges left out (open border, non-manifold, or at a vertex whose surrounding faces do not form one closed fan). */
  skipped: number;
  /** Size used: the request, limited so the bevel stays inside its neighbouring triangles. */
  size: number;
}

/** Carry a per-triangle array (paint layers) across an edit. */
export function remapTriArray<T extends Uint8Array | Uint32Array>(src: T | undefined, triSource: Uint32Array): T | undefined {
  if (!src) return undefined;
  const out = new (src.constructor as { new (n: number): T })(triSource.length);
  for (let i = 0; i < triSource.length; i++) out[i] = src[triSource[i]] ?? 0;
  return out;
}

const sub = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: number[]) => Math.hypot(a[0], a[1], a[2]);

// ------------------------------------------------------------------------------------------ chamfer / fillet

/**
 * Bevel the given edges. `segments` = 1 gives a chamfer; more gives a round (fillet) built from that many strips.
 * `size` is the distance along each adjoining face, measured from the edge.
 * Works on convex and concave edges alike (convex removes material, concave adds a fillet of material).
 */
export function bevelEdges(mesh: IndexedMesh, edges: EdgePair[], size: number, segments = 1): BevelResult | null {
  const topo = buildTopology(mesh);
  const look = edgeLookup(topo);
  const n = topo.vertexCount;
  const v = mesh.vertices, ix = mesh.indices;
  const triCount = topo.triCount;
  const pos = (i: number) => [v[i * 3], v[i * 3 + 1], v[i * 3 + 2]];

  // resolve and validate the requested edges
  let sel = new Set<number>();
  let skipped = 0;
  for (const [a, b] of edges) {
    const e = look.get(a < b ? a * n + b : b * n + a);
    if (e === undefined || topo.kind[e] === EDGE_BORDER || topo.kind[e] === EDGE_NONMANIFOLD) { skipped++; continue; }
    sel.add(e);
  }
  if (!sel.size || !(size > 0)) return null;
  segments = Math.max(1, Math.min(32, Math.round(segments)));

  // directed edge -> triangle, vertex -> triangles
  const dir = new Map<number, number>();
  const vertTris = new Map<number, number[]>();
  const touched = new Set<number>();
  for (const e of sel) { touched.add(topo.edgeV[e * 2]); touched.add(topo.edgeV[e * 2 + 1]); }
  for (let t = 0; t < triCount; t++) {
    for (let k = 0; k < 3; k++) {
      const a = ix[t * 3 + k], b = ix[t * 3 + ((k + 1) % 3)];
      dir.set(a * n + b, t);
      if (touched.has(a)) (vertTris.get(a) ?? vertTris.set(a, []).get(a)!).push(t);
    }
  }

  // the triangles around a vertex in order, as [tri, x] where the triangle is (v, x, next x); null if not one closed fan
  const fanOf = (vtx: number) => {
    const all = vertTris.get(vtx)!;
    const order: { t: number; x: number; y: number }[] = [];
    let cur: number | undefined = all[0];
    do {
      const k = [0, 1, 2].find((q) => ix[cur! * 3 + q] === vtx)!;
      const x = ix[cur * 3 + ((k + 1) % 3)], y = ix[cur * 3 + ((k + 2) % 3)];
      order.push({ t: cur, x, y });
      cur = dir.get(vtx * n + y);
    } while (cur !== undefined && cur !== all[0] && order.length <= all.length);
    return cur === all[0] && order.length === all.length ? order : null;
  };
  const fans = new Map<number, { t: number; x: number; y: number }[]>();
  for (const vtx of touched) { const f = fanOf(vtx); if (f) fans.set(vtx, f); }
  const bad = new Set<number>();
  for (const e of sel) if (!fans.has(topo.edgeV[e * 2]) || !fans.has(topo.edgeV[e * 2 + 1])) bad.add(e);
  for (const e of bad) { sel.delete(e); skipped++; }
  if (!sel.size) return null;

  // limit the size so offsets stay within the adjoining triangles
  const edgeLimit = new Map<number, number>();
  for (const e of sel) {
    const a = topo.edgeV[e * 2], b = topo.edgeV[e * 2 + 1];
    const el = len(sub(pos(a), pos(b)));
    let lim = Infinity;
    for (let k = 0; k < 2; k++) {
      const t = topo.edgeTris[e * 2 + k];
      const [p, q, r] = [pos(ix[t * 3]), pos(ix[t * 3 + 1]), pos(ix[t * 3 + 2])];
      const u = sub(q, p), w = sub(r, p);
      const area2 = len([u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]]);
      if (el > 1e-12) lim = Math.min(lim, 0.45 * (area2 / el));
    }
    edgeLimit.set(e, lim);
  }
  // an edge squeezed by a tiny sliver would drag the size of every other edge down: leave such edges out instead
  const tiny = [...sel].filter((e) => edgeLimit.get(e)! < size * 0.25);
  if (tiny.length && tiny.length < sel.size) { for (const e of tiny) sel.delete(e); skipped += tiny.length; }
  let limit = size;
  for (const e of sel) limit = Math.min(limit, edgeLimit.get(e)!);
  const d = limit;
  if (!(d > 1e-9)) return null;

  // start from the old vertices; sector vertices are appended
  const verts: number[] = Array.from(v);
  const addVert = (p: number[]) => { verts.push(p[0], p[1], p[2]); return verts.length / 3 - 1; };
  const corner = new Map<number, number>(); // tri*3+corner -> vertex id
  const sectorsAt = new Map<number, { idx: number[]; fanIndex: number[]; close?: { a1: number; a2: number; tri: number; x: number } }>(); // per touched vertex: sector vertex ids + fan index of each selected edge

  const inFace = (vtx: number, t: number, x: number, third: number) => {
    // unit vector from vtx, inside triangle t, perpendicular to edge (vtx, x)
    const o = pos(vtx);
    const e = sub(pos(x), o);
    const el = len(e) || 1;
    const ed = [e[0] / el, e[1] / el, e[2] / el];
    const w = sub(pos(third), o);
    const k = dot(w, ed);
    const u = [w[0] - ed[0] * k, w[1] - ed[1] * k, w[2] - ed[2] * k];
    const ul = len(u) || 1;
    void t;
    return [u[0] / ul, u[1] / ul, u[2] / ul];
  };

  for (const vtx of touched) {
    const fan = fans.get(vtx)!;
    const m = fan.length;
    const S: number[] = [];
    for (let i = 0; i < m; i++) {
      const e = look.get(vtx < fan[i].x ? vtx * n + fan[i].x : fan[i].x * n + vtx);
      if (e !== undefined && sel.has(e)) S.push(i);
    }
    if (!S.length) continue;
    const cornerOf = (t: number) => [0, 1, 2].find((q) => ix[t * 3 + q] === vtx)!;
    if (S.length === 1) {
      // free end of a bevel: the vertex splits in two (one per bevelled face); the other faces of the fan are shared
      // out between the halves at a far edge J, and a closing fan (below) seals the gap
      const i0 = S[0], J = (i0 + Math.max(1, Math.floor(m / 2))) % m;
      const o = pos(vtx);
      const mk = (u: number[]) => addVert([o[0] + u[0] * d, o[1] + u[1] * d, o[2] + u[2] * d]);
      const a1 = mk(inFace(vtx, fan[i0].t, fan[i0].x, fan[i0].y));
      const prev = fan[(i0 - 1 + m) % m];
      const a2 = mk(inFace(vtx, prev.t, fan[i0].x, prev.x));
      for (let i = i0; i !== J; i = (i + 1) % m) corner.set(fan[i].t * 3 + cornerOf(fan[i].t), a1);
      for (let i = J; i !== i0; i = (i + 1) % m) corner.set(fan[i].t * 3 + cornerOf(fan[i].t), a2);
      sectorsAt.set(vtx, { idx: [a1, a2], fanIndex: S, close: { a1, a2, tri: fan[J].t, x: fan[J].x } });
      continue;
    }
    const idx: number[] = [];
    for (let j = 0; j < S.length; j++) {
      const from = S[j], to = S[(j + 1) % S.length];
      const first = fan[from], last = fan[(to - 1 + m) % m];
      const u1 = inFace(vtx, first.t, first.x, first.y); // edge x_from, inside T_from
      const u2 = inFace(vtx, last.t, fan[to].x, last.x); // edge x_to, inside T_{to-1}
      const k = d / Math.max(1 + dot(u1, u2), 0.2);
      const o = pos(vtx);
      const id = addVert([o[0] + (u1[0] + u2[0]) * k, o[1] + (u1[1] + u2[1]) * k, o[2] + (u1[2] + u2[2]) * k]);
      idx.push(id);
      for (let i = from; ; i = (i + 1) % m) {
        corner.set(fan[i].t * 3 + cornerOf(fan[i].t), id);
        if ((i + 1) % m === to) break;
      }
    }
    sectorsAt.set(vtx, { idx, fanIndex: S });
  }

  const outTris: number[] = [];
  const src: number[] = [];
  for (let t = 0; t < triCount; t++) {
    outTris.push(corner.get(t * 3) ?? ix[t * 3], corner.get(t * 3 + 1) ?? ix[t * 3 + 1], corner.get(t * 3 + 2) ?? ix[t * 3 + 2]);
    src.push(t);
  }
  const push = (a: number, b: number, c: number, from: number) => {
    if (a === b || b === c || a === c) return;
    outTris.push(a, b, c); src.push(from);
  };

  // round profile between two sector vertices around original vertex `vtx` (quadratic Bezier pulled toward the vertex)
  const profiles = new Map<string, number[]>();
  const profile = (vtx: number, from: number, to: number): number[] => {
    if (from === to || segments === 1) return [from, to];
    const lo = Math.min(from, to), hi = Math.max(from, to);
    const key = `${lo}_${hi}`; // sector vertex ids are unique per original vertex
    let arr = profiles.get(key);
    if (!arr) {
      arr = [lo];
      const P0 = [verts[lo * 3], verts[lo * 3 + 1], verts[lo * 3 + 2]], P2 = [verts[hi * 3], verts[hi * 3 + 1], verts[hi * 3 + 2]], C = pos(vtx);
      for (let j = 1; j < segments; j++) {
        const s = j / segments, a = (1 - s) * (1 - s), b = 2 * s * (1 - s), c = s * s;
        arr.push(addVert([a * P0[0] + b * C[0] + c * P2[0], a * P0[1] + b * C[1] + c * P2[1], a * P0[2] + b * C[2] + c * P2[2]]));
      }
      arr.push(hi);
      profiles.set(key, arr);
    }
    return from < to ? arr : [...arr].reverse();
  };

  for (const e of sel) {
    const a = topo.edgeV[e * 2], b = topo.edgeV[e * 2 + 1];
    const t0 = topo.edgeTris[e * 2], t1 = topo.edgeTris[e * 2 + 1];
    const f1 = dir.get(a * n + b) === t0 ? t0 : t1; // contains a -> b
    const f2 = f1 === t0 ? t1 : t0;
    const cornerOf = (t: number, vtx: number) => [0, 1, 2].find((q) => ix[t * 3 + q] === vtx)!;
    const A1 = corner.get(f1 * 3 + cornerOf(f1, a)) ?? a, A2 = corner.get(f2 * 3 + cornerOf(f2, a)) ?? a;
    const B1 = corner.get(f1 * 3 + cornerOf(f1, b)) ?? b, B2 = corner.get(f2 * 3 + cornerOf(f2, b)) ?? b;
    const pa = profile(a, A1, A2), pb = profile(b, B1, B2);
    for (let j = 0; j + 1 < pa.length; j++) {
      push(pb[j], pa[j], pa[j + 1], f1);
      push(pb[j], pa[j + 1], pb[j + 1], f1);
    }
  }

  // seal the split vertex at the free end of a bevel with a fan from the neighbour on the far edge
  for (const [vtx, sc] of sectorsAt) {
    if (!sc.close) continue;
    const { a1, a2, tri, x } = sc.close;
    const q = [...profile(vtx, a1, a2)].reverse(); // a2 .. a1
    const xc = corner.get(tri * 3 + [0, 1, 2].find((c) => ix[tri * 3 + c] === x)!) ?? x;
    for (let i = 0; i + 1 < q.length; i++) push(xc, q[i], q[i + 1], tri);
  }

  // corner caps where three or more bevelled edges meet
  for (const [vtx, sc] of sectorsAt) {
    const k = sc.fanIndex.length;
    if (k < 3) continue;
    const loop: number[] = [];
    for (let j = 0; j < k; j++) {
      const p = profile(vtx, sc.idx[(j - 1 + k) % k], sc.idx[j]);
      for (let q = 0; q + 1 < p.length; q++) loop.push(p[q]);
    }
    const firstTri = fans.get(vtx)![sc.fanIndex[0]].t;
    if (loop.length === 3) { push(loop[0], loop[1], loop[2], firstTri); continue; }
    let cx = 0, cy = 0, cz = 0;
    for (const i of loop) { cx += verts[i * 3]; cy += verts[i * 3 + 1]; cz += verts[i * 3 + 2]; }
    const o = pos(vtx), w = segments > 1 ? 0.3 : 0;
    const c = addVert([(cx / loop.length) * (1 - w) + o[0] * w, (cy / loop.length) * (1 - w) + o[1] * w, (cz / loop.length) * (1 - w) + o[2] * w]);
    for (let i = 0; i < loop.length; i++) push(c, loop[i], loop[(i + 1) % loop.length], firstTri);
  }

  const out = compact(new Float32Array(verts), Uint32Array.from(outTris), mesh.faceGroups, src, mesh.groupKind);
  return { ...out, applied: sel.size, skipped, size: d };
}

/** Drop unused vertices; carry face groups along the triangle source map. */
function compact(vertices: Float32Array, indices: Uint32Array, groups: Uint32Array | undefined, src: number[] | Uint32Array, kind?: 'cad'): EditResult {
  const used = new Int32Array(vertices.length / 3).fill(-1);
  let count = 0;
  for (let i = 0; i < indices.length; i++) if (used[indices[i]] < 0) used[indices[i]] = count++;
  const nv = new Float32Array(count * 3);
  for (let i = 0; i < used.length; i++) if (used[i] >= 0) { nv[used[i] * 3] = vertices[i * 3]; nv[used[i] * 3 + 1] = vertices[i * 3 + 1]; nv[used[i] * 3 + 2] = vertices[i * 3 + 2]; }
  const ni = new Uint32Array(indices.length);
  for (let i = 0; i < indices.length; i++) ni[i] = used[indices[i]];
  const triSource = Uint32Array.from(src);
  const mesh: IndexedMesh = { vertices: nv, indices: ni };
  if (groups) { mesh.faceGroups = remapTriArray(groups, triSource); if (kind) mesh.groupKind = kind; }
  return { mesh, triSource };
}

// ------------------------------------------------------------------------------------------ subdivision

export type SubdivScheme = 'auto' | 'catmull-clark' | 'loop';
export interface SubdivOptions {
  levels?: number;
  /** Edges bending more than this stay sharp. */
  creaseDeg?: number;
  scheme?: SubdivScheme;
  /** Stop before the result would pass this many triangles. */
  maxTris?: number;
}

const ekey = (a: number, b: number, n: number) => (a < b ? a * n + b : b * n + a);

/** True when the mesh carries quad / polygon faces (several triangles sharing a face id). */
export function hasPolygonFaces(m: IndexedMesh): boolean {
  const g = m.faceGroups;
  if (!g || m.groupKind === 'cad') return false;
  for (let i = 1; i < g.length; i++) if (g[i] === g[i - 1]) return true;
  const seen = new Set<number>();
  for (let i = 0; i < g.length; i++) { if (seen.has(g[i])) return true; seen.add(g[i]); }
  return false;
}

/**
 * Smooth subdivision. Quad / polygon meshes (OBJ cages) use Catmull-Clark on the original polygons, plain
 * triangle meshes use Loop. Creases (dihedral above `creaseDeg`) and open borders keep their shape.
 */
export function subdivide(mesh: IndexedMesh, opts: SubdivOptions = {}): EditResult {
  const levels = Math.max(1, Math.min(4, Math.round(opts.levels ?? 1)));
  const crease = opts.creaseDeg ?? 40;
  const maxTris = opts.maxTris ?? 2_000_000;
  let cur = mesh;
  let source = new Uint32Array(mesh.indices.length / 3).map((_, i) => i);
  let sharp = sharpKeys(cur, crease);
  const scheme = opts.scheme ?? 'auto';
  for (let l = 0; l < levels; l++) {
    const useCC = scheme === 'catmull-clark' || (scheme === 'auto' && hasPolygonFaces(cur));
    if ((cur.indices.length / 3) * 4 > maxTris) break;
    const r = useCC ? catmullClark(cur, sharp) : loop(cur, sharp);
    source = Uint32Array.from(r.triSource, (s) => source[s]);
    cur = r.mesh;
    sharp = r.sharp;
  }
  const out: IndexedMesh = { vertices: cur.vertices, indices: cur.indices };
  if (cur.faceGroups) out.faceGroups = cur.faceGroups;
  if (cur.groupKind) out.groupKind = cur.groupKind;
  return { mesh: out, triSource: source };
}

function sharpKeys(m: IndexedMesh, creaseDeg: number): Set<number> {
  const t = buildTopology(m, creaseDeg);
  const out = new Set<number>();
  const n = t.vertexCount;
  for (let e = 0; e < t.edgeCount; e++) if (t.kind[e] === EDGE_SHARP) out.add(t.edgeV[e * 2] * n + t.edgeV[e * 2 + 1]);
  return out;
}

function loop(mesh: IndexedMesh, sharp: Set<number>): EditResult & { sharp: Set<number> } {
  const topo = buildTopology(mesh);
  const n = topo.vertexCount, v = mesh.vertices, ix = mesh.indices;
  const E = topo.edgeCount;
  const out = new Float32Array((n + E) * 3);
  const crease = new Uint8Array(E);
  for (let e = 0; e < E; e++) {
    const a = topo.edgeV[e * 2], b = topo.edgeV[e * 2 + 1];
    crease[e] = topo.kind[e] !== 0 || sharp.has(a * n + b) ? 1 : 0;
  }
  // edge points
  for (let e = 0; e < E; e++) {
    const a = topo.edgeV[e * 2], b = topo.edgeV[e * 2 + 1];
    const o = (n + e) * 3;
    if (crease[e]) { for (let c = 0; c < 3; c++) out[o + c] = (v[a * 3 + c] + v[b * 3 + c]) / 2; continue; }
    const opp = [0, 1].map((k) => {
      const t = topo.edgeTris[e * 2 + k];
      for (let q = 0; q < 3; q++) { const c = ix[t * 3 + q]; if (c !== a && c !== b) return c; }
      return a;
    });
    for (let c = 0; c < 3; c++) out[o + c] = 0.375 * (v[a * 3 + c] + v[b * 3 + c]) + 0.125 * (v[opp[0] * 3 + c] + v[opp[1] * 3 + c]);
  }
  // vertex points
  const nb: number[][] = Array.from({ length: n }, () => []);
  const cr: number[][] = Array.from({ length: n }, () => []);
  for (let e = 0; e < E; e++) {
    const a = topo.edgeV[e * 2], b = topo.edgeV[e * 2 + 1];
    nb[a].push(b); nb[b].push(a);
    if (crease[e]) { cr[a].push(b); cr[b].push(a); }
  }
  for (let i = 0; i < n; i++) {
    const val = nb[i].length;
    for (let c = 0; c < 3; c++) {
      const p = v[i * 3 + c];
      if (cr[i].length === 2) out[i * 3 + c] = 0.75 * p + 0.125 * (v[cr[i][0] * 3 + c] + v[cr[i][1] * 3 + c]);
      else if (cr[i].length > 0 || val < 3) out[i * 3 + c] = p;
      else {
        const beta = val === 3 ? 3 / 16 : 3 / (8 * val);
        let s = 0;
        for (const j of nb[i]) s += v[j * 3 + c];
        out[i * 3 + c] = (1 - val * beta) * p + beta * s;
      }
    }
  }
  const tris = new Uint32Array(topo.triCount * 12);
  const src = new Uint32Array(topo.triCount * 4);
  for (let t = 0; t < topo.triCount; t++) {
    const a = ix[t * 3], b = ix[t * 3 + 1], c = ix[t * 3 + 2];
    const mab = n + topo.triEdges[t * 3], mbc = n + topo.triEdges[t * 3 + 1], mca = n + topo.triEdges[t * 3 + 2];
    tris.set([a, mab, mca, b, mbc, mab, c, mca, mbc, mab, mbc, mca], t * 12);
    src.fill(t, t * 4, t * 4 + 4);
  }
  const n2 = n + E;
  const nextSharp = new Set<number>();
  for (let e = 0; e < E; e++) {
    const a = topo.edgeV[e * 2], b = topo.edgeV[e * 2 + 1];
    if (!sharp.has(a * n + b)) continue;
    nextSharp.add(ekey(a, n + e, n2)); nextSharp.add(ekey(b, n + e, n2));
  }
  const mesh2: IndexedMesh = { vertices: out, indices: tris };
  if (mesh.faceGroups) { mesh2.faceGroups = remapTriArray(mesh.faceGroups, src); if (mesh.groupKind) mesh2.groupKind = mesh.groupKind; }
  return { mesh: mesh2, triSource: src, sharp: nextSharp };
}

/** Polygons (vertex loops) from the face groups; groups that are not a clean simple loop fall back to single triangles. */
export function polygonsOf(mesh: IndexedMesh): { verts: number[]; tri: number }[] {
  const ix = mesh.indices, g = mesh.faceGroups;
  const polys: { verts: number[]; tri: number }[] = [];
  const triCount = ix.length / 3;
  if (!g) {
    for (let t = 0; t < triCount; t++) polys.push({ verts: [ix[t * 3], ix[t * 3 + 1], ix[t * 3 + 2]], tri: t });
    return polys;
  }
  const byGroup = new Map<number, number[]>();
  for (let t = 0; t < triCount; t++) (byGroup.get(g[t]) ?? byGroup.set(g[t], []).get(g[t])!).push(t);
  for (const tris of byGroup.values()) {
    const single = () => { for (const t of tris) polys.push({ verts: [ix[t * 3], ix[t * 3 + 1], ix[t * 3 + 2]], tri: t }); };
    if (tris.length === 1) { single(); continue; }
    const edges = new Map<string, [number, number]>();
    const vset = new Set<number>();
    for (const t of tris) for (let k = 0; k < 3; k++) {
      const a = ix[t * 3 + k], b = ix[t * 3 + ((k + 1) % 3)];
      vset.add(a);
      if (edges.has(`${b}_${a}`)) edges.delete(`${b}_${a}`); else edges.set(`${a}_${b}`, [a, b]);
    }
    const next = new Map<number, number>();
    let ok = true;
    for (const [a, b] of edges.values()) { if (next.has(a)) { ok = false; break; } next.set(a, b); }
    if (!ok || !next.size) { single(); continue; }
    const start = next.keys().next().value as number;
    const loopV = [start];
    for (let c = next.get(start)!; c !== start; c = next.get(c)!) {
      if (c === undefined || loopV.length > next.size) { ok = false; break; }
      loopV.push(c);
    }
    if (!ok || loopV.length !== next.size || loopV.length !== vset.size || loopV.length < 3) { single(); continue; }
    polys.push({ verts: loopV, tri: tris[0] });
  }
  return polys;
}

function catmullClark(mesh: IndexedMesh, sharp: Set<number>): EditResult & { sharp: Set<number> } {
  const n = mesh.vertices.length / 3, v = mesh.vertices;
  const polys = polygonsOf(mesh);
  const F = polys.length;
  const P = (i: number) => [v[i * 3], v[i * 3 + 1], v[i * 3 + 2]];
  // face points
  const fp = polys.map((p) => {
    const c = [0, 0, 0];
    for (const i of p.verts) for (let k = 0; k < 3; k++) c[k] += v[i * 3 + k] / p.verts.length;
    return c;
  });
  // edges
  const edgeId = new Map<number, number>();
  const edgeVerts: [number, number][] = [];
  const edgeFaces: number[][] = [];
  polys.forEach((p, f) => {
    for (let k = 0; k < p.verts.length; k++) {
      const a = p.verts[k], b = p.verts[(k + 1) % p.verts.length];
      const key = ekey(a, b, n);
      let e = edgeId.get(key);
      if (e === undefined) { e = edgeVerts.length; edgeId.set(key, e); edgeVerts.push([a, b]); edgeFaces.push([]); }
      edgeFaces[e].push(f);
    }
  });
  const E = edgeVerts.length;
  const isCrease = (e: number) => edgeFaces[e].length !== 2 || sharp.has(ekey(edgeVerts[e][0], edgeVerts[e][1], n));
  const edgePt: number[][] = edgeVerts.map(([a, b], e) => {
    const pa = P(a), pb = P(b);
    if (isCrease(e)) return [0, 1, 2].map((k) => (pa[k] + pb[k]) / 2);
    const f1 = fp[edgeFaces[e][0]], f2 = fp[edgeFaces[e][1]];
    return [0, 1, 2].map((k) => (pa[k] + pb[k] + f1[k] + f2[k]) / 4);
  });
  // vertex points
  const vFaces: number[][] = Array.from({ length: n }, () => []);
  const vEdges: number[][] = Array.from({ length: n }, () => []);
  polys.forEach((p, f) => { for (const i of p.verts) vFaces[i].push(f); });
  edgeVerts.forEach(([a, b], e) => { vEdges[a].push(e); vEdges[b].push(e); });
  const vp: number[][] = [];
  for (let i = 0; i < n; i++) {
    const p = P(i);
    const creases = vEdges[i].filter(isCrease);
    if (creases.length === 2) {
      const other = creases.map((e) => (edgeVerts[e][0] === i ? edgeVerts[e][1] : edgeVerts[e][0]));
      vp.push([0, 1, 2].map((k) => (6 * p[k] + v[other[0] * 3 + k] + v[other[1] * 3 + k]) / 8));
    } else if (creases.length > 2 || vEdges[i].length < 3 || !vFaces[i].length) vp.push(p);
    else {
      const val = vEdges[i].length;
      const favg = [0, 0, 0], ravg = [0, 0, 0];
      for (const f of vFaces[i]) for (let k = 0; k < 3; k++) favg[k] += fp[f][k] / vFaces[i].length;
      for (const e of vEdges[i]) {
        const [a, b] = edgeVerts[e];
        for (let k = 0; k < 3; k++) ravg[k] += (v[a * 3 + k] + v[b * 3 + k]) / 2 / val;
      }
      vp.push([0, 1, 2].map((k) => (favg[k] + 2 * ravg[k] + (val - 3) * p[k]) / val));
    }
  }
  const out = new Float32Array((n + F + E) * 3);
  for (let i = 0; i < n; i++) out.set(vp[i], i * 3);
  for (let f = 0; f < F; f++) out.set(fp[f], (n + f) * 3);
  for (let e = 0; e < E; e++) out.set(edgePt[e], (n + F + e) * 3);
  const tris: number[] = [], src: number[] = [], groups: number[] = [];
  let quad = 0;
  const D = (a: number, b: number) => Math.hypot(out[a * 3] - out[b * 3], out[a * 3 + 1] - out[b * 3 + 1], out[a * 3 + 2] - out[b * 3 + 2]);
  polys.forEach((p, f) => {
    const m = p.verts.length;
    for (let k = 0; k < m; k++) {
      const vi = p.verts[k];
      const eNext = n + F + edgeId.get(ekey(vi, p.verts[(k + 1) % m], n))!;
      const ePrev = n + F + edgeId.get(ekey(p.verts[(k - 1 + m) % m], vi, n))!;
      const c = n + f;
      // quad (vi, eNext, c, ePrev), split along the shorter diagonal
      if (D(vi, c) <= D(eNext, ePrev)) tris.push(vi, eNext, c, vi, c, ePrev);
      else tris.push(vi, eNext, ePrev, eNext, c, ePrev);
      src.push(p.tri, p.tri); groups.push(quad, quad); quad++;
    }
  });
  const nextSharp = new Set<number>();
  const n2 = n + F + E;
  edgeVerts.forEach(([a, b], e) => {
    if (!sharp.has(ekey(a, b, n))) return;
    nextSharp.add(ekey(a, n + F + e, n2)); nextSharp.add(ekey(b, n + F + e, n2));
  });
  return { mesh: { vertices: out, indices: Uint32Array.from(tris), faceGroups: Uint32Array.from(groups) }, triSource: Uint32Array.from(src), sharp: nextSharp };
}

// ------------------------------------------------------------------------------------------ smoothing

export interface SmoothOptions {
  iterations?: number;
  /** 0..1 strength of each pass. */
  strength?: number;
  creaseDeg?: number;
  /** Counter-shrink pass (Taubin) so the body keeps its volume. */
  keepVolume?: boolean;
  /** Only vertices of these triangles move (all when omitted). */
  region?: ArrayLike<number>;
}

/** Relax the surface (Taubin lambda|mu). Vertices on sharp edges and open borders stay put. */
export function smoothMesh(mesh: IndexedMesh, opts: SmoothOptions = {}): EditResult {
  const iterations = Math.max(1, Math.min(200, Math.round(opts.iterations ?? 10)));
  const lambda = Math.max(0.01, Math.min(1, opts.strength ?? 0.5));
  const mu = opts.keepVolume === false ? 0 : -lambda * 1.06;
  const topo: Topology = buildTopology(mesh, opts.creaseDeg ?? 40);
  const n = topo.vertexCount;
  const nb: number[][] = Array.from({ length: n }, () => []);
  const fixed = new Uint8Array(n);
  for (let e = 0; e < topo.edgeCount; e++) {
    const a = topo.edgeV[e * 2], b = topo.edgeV[e * 2 + 1];
    nb[a].push(b); nb[b].push(a);
    if (topo.kind[e] !== 0) { fixed[a] = 1; fixed[b] = 1; }
  }
  if (opts.region) {
    const free = new Uint8Array(n);
    for (let t = 0; t < topo.triCount; t++) if (opts.region[t]) for (let k = 0; k < 3; k++) free[mesh.indices[t * 3 + k]] = 1;
    for (let i = 0; i < n; i++) if (!free[i]) fixed[i] = 1;
  }
  let cur = new Float32Array(mesh.vertices);
  let nxt = new Float32Array(cur.length);
  const pass = (f: number) => {
    for (let i = 0; i < n; i++) {
      if (fixed[i] || !nb[i].length) { nxt[i * 3] = cur[i * 3]; nxt[i * 3 + 1] = cur[i * 3 + 1]; nxt[i * 3 + 2] = cur[i * 3 + 2]; continue; }
      for (let c = 0; c < 3; c++) {
        let s = 0;
        for (const j of nb[i]) s += cur[j * 3 + c];
        nxt[i * 3 + c] = cur[i * 3 + c] + f * (s / nb[i].length - cur[i * 3 + c]);
      }
    }
    [cur, nxt] = [nxt, cur];
  };
  for (let it = 0; it < iterations; it++) { pass(lambda); if (mu) pass(mu); }
  const mesh2: IndexedMesh = { vertices: cur, indices: mesh.indices };
  if (mesh.faceGroups) { mesh2.faceGroups = mesh.faceGroups; if (mesh.groupKind) mesh2.groupKind = mesh.groupKind; }
  return { mesh: mesh2, triSource: new Uint32Array(topo.triCount).map((_, i) => i) };
}

// ------------------------------------------------------------------------------------------ refinement

export interface RefineResult extends EditResult {
  /** Triangles split into smaller ones. */
  splits: number;
  /** The requested edges, rewritten where an edge was split into two (so a picked edge stays picked). */
  edges: EdgePair[];
}

/**
 * Split every edge longer than `maxLen` at its midpoint until none is left (or `maxTris` is reached), so the
 * triangles are of even size. Splits are shared by both neighbours so the mesh stays watertight. Shape does not change.
 * `region` limits splitting to edges of those triangles (a per-triangle flag array).
 */
export function refineMesh(mesh: IndexedMesh, maxLen: number, opts: { region?: ArrayLike<number>; maxTris?: number; edges?: EdgePair[] } = {}): RefineResult {
  const maxTris = opts.maxTris ?? 2_000_000;
  let cur = mesh;
  let source = new Uint32Array(mesh.indices.length / 3).map((_, i) => i);
  let region = opts.region ? Uint8Array.from({ length: source.length }, (_, i) => (opts.region![i] ? 1 : 0)) : undefined;
  let edges: EdgePair[] = (opts.edges ?? []).map(([a, b]) => [a, b]);
  let splits = 0;
  const max2 = maxLen * maxLen;
  for (let pass = 0; pass < 12; pass++) {
    const topo = buildTopology(cur);
    const v = cur.vertices, ix = cur.indices;
    const n = topo.vertexCount;
    const mid = new Int32Array(topo.edgeCount).fill(-1);
    const verts: number[] = Array.from(v);
    let count = 0;
    for (let e = 0; e < topo.edgeCount; e++) {
      const a = topo.edgeV[e * 2], b = topo.edgeV[e * 2 + 1];
      const dx = v[a * 3] - v[b * 3], dy = v[a * 3 + 1] - v[b * 3 + 1], dz = v[a * 3 + 2] - v[b * 3 + 2];
      if (dx * dx + dy * dy + dz * dz <= max2) continue;
      if (region && !(region[topo.edgeTris[e * 2]] || (topo.edgeTris[e * 2 + 1] >= 0 && region[topo.edgeTris[e * 2 + 1]]))) continue;
      mid[e] = verts.length / 3;
      verts.push((v[a * 3] + v[b * 3]) / 2, (v[a * 3 + 1] + v[b * 3 + 1]) / 2, (v[a * 3 + 2] + v[b * 3 + 2]) / 2);
      count++;
    }
    if (!count) break;
    if (topo.triCount + count * 2 > maxTris) break;
    const tris: number[] = [], src: number[] = [], reg: number[] = [];
    const D = (a: number, b: number) => Math.hypot(verts[a * 3] - verts[b * 3], verts[a * 3 + 1] - verts[b * 3 + 1], verts[a * 3 + 2] - verts[b * 3 + 2]);
    const out = (t: number, a: number, b: number, c: number) => { tris.push(a, b, c); src.push(t); reg.push(region ? region[t] : 0); };
    for (let t = 0; t < topo.triCount; t++) {
      const c = [ix[t * 3], ix[t * 3 + 1], ix[t * 3 + 2]];
      const m = [mid[topo.triEdges[t * 3]], mid[topo.triEdges[t * 3 + 1]], mid[topo.triEdges[t * 3 + 2]]]; // edge k: c[k] -> c[k+1]
      const marked = m.filter((x) => x >= 0).length;
      if (marked === 0) out(t, c[0], c[1], c[2]);
      else if (marked === 3) { out(t, c[0], m[0], m[2]); out(t, c[1], m[1], m[0]); out(t, c[2], m[2], m[1]); out(t, m[0], m[1], m[2]); }
      else if (marked === 1) {
        const k = m.findIndex((x) => x >= 0), p0 = c[k], p1 = c[(k + 1) % 3], p2 = c[(k + 2) % 3];
        out(t, p0, m[k], p2); out(t, m[k], p1, p2);
      } else {
        const u = m.findIndex((x) => x < 0); // the unsplit edge
        const p0 = c[(u + 1) % 3], p1 = c[(u + 2) % 3], p2 = c[u];
        const m0 = m[(u + 1) % 3], m1 = m[(u + 2) % 3];
        out(t, m0, p1, m1);
        if (D(m0, p2) <= D(p0, m1)) { out(t, p0, m0, p2); out(t, m0, m1, p2); } else { out(t, p0, m0, m1); out(t, p0, m1, p2); }
      }
    }
    // keep requested edges picked: an edge that was split becomes its two halves
    const look = edgeLookup(topo);
    const nextEdges: EdgePair[] = [];
    for (const [a, b] of edges) {
      const e = look.get(a < b ? a * n + b : b * n + a);
      if (e !== undefined && mid[e] >= 0) nextEdges.push([a, mid[e]], [mid[e], b]); else nextEdges.push([a, b]);
    }
    edges = nextEdges;
    splits += count;
    const next: IndexedMesh = { vertices: new Float32Array(verts), indices: Uint32Array.from(tris) };
    if (cur.faceGroups) { next.faceGroups = remapTriArray(cur.faceGroups, Uint32Array.from(src)); if (cur.groupKind) next.groupKind = cur.groupKind; }
    source = Uint32Array.from(src, (s) => source[s]);
    region = region ? Uint8Array.from(reg) : undefined;
    cur = next;
  }
  return { mesh: cur, triSource: source, splits, edges };
}

// ------------------------------------------------------------------------------------------ even remeshing

/** Collapse edges shorter than `minLen` (never creating one longer than `maxLen`). Vertices on creases / borders stay. */
function collapseShort(mesh: IndexedMesh, minLen: number, maxLen: number, creaseDeg: number): EditResult & { collapsed: number } {
  const topo = buildTopology(mesh, creaseDeg);
  const v = mesh.vertices;
  const n = topo.vertexCount;
  const tris = Uint32Array.from(mesh.indices);
  const alive = new Uint8Array(topo.triCount).fill(1);
  const locked = new Uint8Array(n);
  for (let e = 0; e < topo.edgeCount; e++) if (topo.kind[e] !== 0) { locked[topo.edgeV[e * 2]] = 1; locked[topo.edgeV[e * 2 + 1]] = 1; }
  const groups = mesh.faceGroups;
  if (groups) for (let e = 0; e < topo.edgeCount; e++) { // keep the boundary between source faces
    const a = topo.edgeTris[e * 2], b = topo.edgeTris[e * 2 + 1];
    if (a >= 0 && b >= 0 && groups[a] !== groups[b]) { locked[topo.edgeV[e * 2]] = 1; locked[topo.edgeV[e * 2 + 1]] = 1; }
  }
  const vt: Set<number>[] = Array.from({ length: n }, () => new Set());
  for (let t = 0; t < topo.triCount; t++) for (let k = 0; k < 3; k++) vt[tris[t * 3 + k]].add(t);
  const P = (i: number) => [v[i * 3], v[i * 3 + 1], v[i * 3 + 2]];
  const normal = (a: number[], b: number[], c: number[]) => {
    const u = sub(b, a), w = sub(c, a);
    return [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
  };
  const neighbours = (i: number) => { const s = new Set<number>(); for (const t of vt[i]) for (let k = 0; k < 3; k++) if (tris[t * 3 + k] !== i) s.add(tris[t * 3 + k]); return s; };
  const order: number[] = [];
  for (let e = 0; e < topo.edgeCount; e++) {
    const a = topo.edgeV[e * 2], b = topo.edgeV[e * 2 + 1];
    if (len(sub(P(a), P(b))) < minLen && topo.edgeTris[e * 2 + 1] >= 0 && topo.kind[e] === 0) order.push(e);
  }
  order.sort((x, y) => len(sub(P(topo.edgeV[x * 2]), P(topo.edgeV[x * 2 + 1]))) - len(sub(P(topo.edgeV[y * 2]), P(topo.edgeV[y * 2 + 1]))));
  const touched = new Uint8Array(n);
  let collapsed = 0;
  for (const e of order) {
    let r = topo.edgeV[e * 2], k = topo.edgeV[e * 2 + 1];
    if (locked[r]) { if (locked[k]) continue; [r, k] = [k, r]; }
    if (touched[r] || touched[k]) continue;
    const shared = [...vt[r]].filter((t) => vt[k].has(t));
    if (shared.length !== 2) continue;
    const opp = shared.map((t) => { for (let q = 0; q < 3; q++) { const c = tris[t * 3 + q]; if (c !== r && c !== k) return c; } return -1; });
    const nr = neighbours(r), nk = neighbours(k);
    const common = [...nr].filter((x) => nk.has(x));
    if (common.length !== 2 || !opp.every((o) => common.includes(o)) || nr.size <= 3) continue;
    // moving r onto k must not fold or stretch the surrounding triangles
    const pk = P(k);
    let ok = true;
    for (const t of vt[r]) {
      if (shared.includes(t)) continue;
      const c = [0, 1, 2].map((q) => tris[t * 3 + q]);
      const before = normal(P(c[0]), P(c[1]), P(c[2]));
      const after = normal(...(c.map((x) => (x === r ? pk : P(x))) as [number[], number[], number[]]));
      const lb = len(before), la = len(after);
      if (la < 1e-12 || dot(before, after) / (lb * la) < 0.4) { ok = false; break; }
      for (const x of c) if (x !== r && x !== k && len(sub(P(x), pk)) > maxLen) { ok = false; break; }
      if (!ok) break;
    }
    if (!ok) continue;
    for (const t of shared) { alive[t] = 0; for (let q = 0; q < 3; q++) vt[tris[t * 3 + q]].delete(t); }
    for (const t of [...vt[r]]) { for (let q = 0; q < 3; q++) if (tris[t * 3 + q] === r) tris[t * 3 + q] = k; vt[k].add(t); }
    vt[r].clear();
    for (const x of [...nr, ...nk, r, k]) touched[x] = 1;
    collapsed++;
  }
  const keep: number[] = [];
  for (let t = 0; t < topo.triCount; t++) if (alive[t]) keep.push(t);
  const idx = new Uint32Array(keep.length * 3);
  keep.forEach((t, i) => { idx[i * 3] = tris[t * 3]; idx[i * 3 + 1] = tris[t * 3 + 1]; idx[i * 3 + 2] = tris[t * 3 + 2]; });
  const r = compact(v, idx, mesh.faceGroups, keep, mesh.groupKind);
  return { ...r, collapsed };
}

/** Flip interior edges that improve vertex valence (towards 6), keeping creases and source-face boundaries. */
function flipForValence(mesh: IndexedMesh, creaseDeg: number): EditResult & { flips: number } {
  const topo = buildTopology(mesh, creaseDeg);
  const look = edgeLookup(topo);
  const v = mesh.vertices, n = topo.vertexCount;
  const tris = Uint32Array.from(mesh.indices);
  const val = new Int32Array(n);
  for (let e = 0; e < topo.edgeCount; e++) { val[topo.edgeV[e * 2]]++; val[topo.edgeV[e * 2 + 1]]++; }
  const onBorder = new Uint8Array(n);
  for (let e = 0; e < topo.edgeCount; e++) if (topo.kind[e] !== 0) { onBorder[topo.edgeV[e * 2]] = 1; onBorder[topo.edgeV[e * 2 + 1]] = 1; }
  const groups = mesh.faceGroups;
  const P = (i: number) => [v[i * 3], v[i * 3 + 1], v[i * 3 + 2]];
  const normal = (a: number[], b: number[], c: number[]) => { const u = sub(b, a), w = sub(c, a); return [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]]; };
  const dev = (i: number) => (onBorder[i] ? 0 : (val[i] - 6) ** 2);
  const done = new Uint8Array(topo.triCount);
  const created = new Set<number>(); // edges made by flips in this pass
  let flips = 0;
  for (let e = 0; e < topo.edgeCount; e++) {
    const t1 = topo.edgeTris[e * 2], t2 = topo.edgeTris[e * 2 + 1];
    if (topo.kind[e] !== 0 || t2 < 0 || done[t1] || done[t2]) continue;
    if (groups && groups[t1] !== groups[t2]) continue;
    const a = topo.edgeV[e * 2], b = topo.edgeV[e * 2 + 1];
    const third = (t: number) => { for (let q = 0; q < 3; q++) { const c = tris[t * 3 + q]; if (c !== a && c !== b) return c; } return -1; };
    const c = third(t1), d = third(t2);
    if (c < 0 || d < 0 || c === d) continue;
    const cdKey = c < d ? c * n + d : d * n + c;
    if (look.has(cdKey) || created.has(cdKey)) continue; // that edge exists already
    const before = dev(a) + dev(b) + dev(c) + dev(d);
    val[a]--; val[b]--; val[c]++; val[d]++;
    const after = dev(a) + dev(b) + dev(c) + dev(d);
    // orientation: t1 has a -> b; new triangles (c, a, d) and (d, b, c) when a -> b is in t1, else mirrored
    const ia = [0, 1, 2].find((q) => tris[t1 * 3 + q] === a)!;
    const forward = tris[t1 * 3 + ((ia + 1) % 3)] === b;
    const [x, y] = forward ? [a, b] : [b, a];
    const n1 = normal(P(c), P(x), P(d)), n2 = normal(P(d), P(y), P(c));
    const o1 = normal(P(tris[t1 * 3]), P(tris[t1 * 3 + 1]), P(tris[t1 * 3 + 2])), o2 = normal(P(tris[t2 * 3]), P(tris[t2 * 3 + 1]), P(tris[t2 * 3 + 2]));
    const okGeom = len(n1) > 1e-12 && len(n2) > 1e-12 && dot(n1, o1) > 0.5 * len(n1) * len(o1) && dot(n2, o2) > 0.5 * len(n2) * len(o2) && dot(n1, n2) > 0.5 * len(n1) * len(n2);
    if (after >= before || !okGeom) { val[a]++; val[b]++; val[c]--; val[d]--; continue; }
    tris.set([c, x, d], t1 * 3);
    tris.set([d, y, c], t2 * 3);
    done[t1] = done[t2] = 1;
    created.add(cdKey);
    flips++;
  }
  const src = Uint32Array.from({ length: topo.triCount }, (_, i) => i);
  const out: IndexedMesh = { vertices: v, indices: tris };
  if (mesh.faceGroups) { out.faceGroups = mesh.faceGroups; if (mesh.groupKind) out.groupKind = mesh.groupKind; }
  return { mesh: out, triSource: src, flips };
}

/** Move free vertices toward their neighbours' centre, along the surface only. */
function relaxTangential(mesh: IndexedMesh, creaseDeg: number, passes = 2): IndexedMesh {
  const topo = buildTopology(mesh, creaseDeg);
  const n = topo.vertexCount, ix = mesh.indices;
  const nb: number[][] = Array.from({ length: n }, () => []);
  const locked = new Uint8Array(n);
  for (let e = 0; e < topo.edgeCount; e++) {
    const a = topo.edgeV[e * 2], b = topo.edgeV[e * 2 + 1];
    nb[a].push(b); nb[b].push(a);
    if (topo.kind[e] !== 0) locked[a] = locked[b] = 1;
  }
  const groups = mesh.faceGroups;
  if (groups) for (let e = 0; e < topo.edgeCount; e++) {
    const a = topo.edgeTris[e * 2], b = topo.edgeTris[e * 2 + 1];
    if (a >= 0 && b >= 0 && groups[a] !== groups[b]) locked[topo.edgeV[e * 2]] = locked[topo.edgeV[e * 2 + 1]] = 1;
  }
  let cur = new Float32Array(mesh.vertices);
  for (let pass = 0; pass < passes; pass++) {
    const nrm = new Float32Array(n * 3);
    for (let t = 0; t < ix.length; t += 3) {
      const a = ix[t] * 3, b = ix[t + 1] * 3, c = ix[t + 2] * 3;
      const ux = cur[b] - cur[a], uy = cur[b + 1] - cur[a + 1], uz = cur[b + 2] - cur[a + 2], wx = cur[c] - cur[a], wy = cur[c + 1] - cur[a + 1], wz = cur[c + 2] - cur[a + 2];
      const fx = uy * wz - uz * wy, fy = uz * wx - ux * wz, fz = ux * wy - uy * wx;
      for (const i of [a, b, c]) { nrm[i] += fx; nrm[i + 1] += fy; nrm[i + 2] += fz; }
    }
    const next = new Float32Array(cur);
    for (let i = 0; i < n; i++) {
      if (locked[i] || nb[i].length < 3) continue;
      const m = [0, 0, 0];
      for (const j of nb[i]) for (let c = 0; c < 3; c++) m[c] += cur[j * 3 + c] / nb[i].length;
      const d = [m[0] - cur[i * 3], m[1] - cur[i * 3 + 1], m[2] - cur[i * 3 + 2]];
      const nl = Math.hypot(nrm[i * 3], nrm[i * 3 + 1], nrm[i * 3 + 2]) || 1;
      const k = (d[0] * nrm[i * 3] + d[1] * nrm[i * 3 + 1] + d[2] * nrm[i * 3 + 2]) / (nl * nl);
      for (let c = 0; c < 3; c++) next[i * 3 + c] = cur[i * 3 + c] + 0.5 * (d[c] - k * nrm[i * 3 + c]);
    }
    cur = next;
  }
  const out: IndexedMesh = { vertices: cur, indices: mesh.indices };
  if (mesh.faceGroups) { out.faceGroups = mesh.faceGroups; if (mesh.groupKind) out.groupKind = mesh.groupKind; }
  return out;
}

export interface RemeshResult extends EditResult { splits: number; collapses: number; flips: number }

/**
 * Even remeshing (split long edges, collapse short ones, flip toward valence 6, relax along the surface) so the
 * triangles come out about `target` mm. Creases, open borders and source-face boundaries are kept. This helps coarse,
 * uneven or sliver-filled meshes before bevelling or smoothing. The surface drifts slightly on curved areas.
 */
export function remeshEven(mesh: IndexedMesh, target: number, opts: { iterations?: number; creaseDeg?: number; maxTris?: number } = {}): RemeshResult {
  const iterations = Math.max(1, Math.min(10, Math.round(opts.iterations ?? 4)));
  const crease = opts.creaseDeg ?? 40;
  let cur = mesh;
  let source = new Uint32Array(mesh.indices.length / 3).map((_, i) => i);
  let splits = 0, collapses = 0, flips = 0;
  const step = (r: EditResult) => { source = Uint32Array.from(r.triSource, (s) => source[s]); cur = r.mesh; };
  for (let it = 0; it < iterations; it++) {
    const s = refineMesh(cur, (target * 4) / 3, { maxTris: opts.maxTris });
    splits += s.splits; step(s);
    const c = collapseShort(cur, target * 0.8, (target * 4) / 3, crease);
    collapses += c.collapsed; step(c);
    const f = flipForValence(cur, crease);
    flips += f.flips; step(f);
    cur = relaxTangential(cur, crease);
  }
  return { mesh: cur, triSource: source, splits, collapses, flips };
}
