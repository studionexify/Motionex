// One-click mesh repair ("Fix model"): weld, drop bad triangles, fix T-junctions, orient faces
// consistently and outward, then close holes. Never throws; always terminates.
// `triSource` maps every output triangle to an input triangle so per-triangle paint can be carried across.
import { openEdgeCount, repairTJunctions, type IndexedMesh } from './mesh';

export interface RepairReport {
  weldedVerts: number;
  removedDegenerate: number;
  removedDuplicate: number;
  flipped: number;
  holesFilled: number;
  openEdgesBefore: number;
  openEdgesAfter: number;
}

export interface RepairResult {
  mesh: IndexedMesh;
  triSource: Uint32Array;
  report: RepairReport;
}

/** Repair an indexed mesh. See the module comment for the steps. */
export function repairMesh(m: IndexedMesh): RepairResult {
  const report: RepairReport = { weldedVerts: 0, removedDegenerate: 0, removedDuplicate: 0, flipped: 0, holesFilled: 0, openEdgesBefore: 0, openEdgesAfter: 0 };
  try {
    return repairInner(m, report);
  } catch {
    // Last-resort safety net: hand back the input untouched.
    const n = Math.floor((m?.indices?.length ?? 0) / 3);
    const ts = new Uint32Array(n);
    for (let i = 0; i < n; i++) ts[i] = i;
    return { mesh: m, triSource: ts, report };
  }
}

function repairInner(m: IndexedMesh, report: RepairReport): RepairResult {
  const srcV = m.vertices, srcI = m.indices;
  const nv = Math.floor(srcV.length / 3), nt = Math.floor(srcI.length / 3);
  try { report.openEdgesBefore = openEdgeCount(m); } catch { report.openEdgesBefore = 0; }

  // ---- bounds and tolerance (finite vertices only)
  const finite = new Uint8Array(nv);
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < nv; i++) {
    const x = srcV[i * 3], y = srcV[i * 3 + 1], z = srcV[i * 3 + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    finite[i] = 1;
    if (x < minX) minX = x; if (y < minY) minY = y; if (z < minZ) minZ = z;
    if (x > maxX) maxX = x; if (y > maxY) maxY = y; if (z > maxZ) maxZ = z;
  }
  const diag = Number.isFinite(maxX) ? Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) : 0;
  const tol = Math.max(1e-5, diag * 1e-6);

  // ---- 1. weld vertices within tolerance (grid of cell = tol, 27-neighbour search)
  const remap = new Int32Array(nv).fill(-1);
  const verts: number[] = [];
  const grid = new Map<string, number[]>();
  const inv = 1 / tol;
  let usedSrc = 0;
  for (let i = 0; i < nv; i++) {
    if (!finite[i]) continue;
    usedSrc++;
    const x = srcV[i * 3], y = srcV[i * 3 + 1], z = srcV[i * 3 + 2];
    const gx = Math.floor(x * inv), gy = Math.floor(y * inv), gz = Math.floor(z * inv);
    let found = -1;
    for (let dx = -1; dx <= 1 && found < 0; dx++) for (let dy = -1; dy <= 1 && found < 0; dy++) for (let dz = -1; dz <= 1 && found < 0; dz++) {
      const cell = grid.get(`${gx + dx},${gy + dy},${gz + dz}`);
      if (!cell) continue;
      for (const j of cell) {
        const ex = verts[j * 3] - x, ey = verts[j * 3 + 1] - y, ez = verts[j * 3 + 2] - z;
        if (ex * ex + ey * ey + ez * ez <= tol * tol) { found = j; break; }
      }
    }
    if (found < 0) {
      found = verts.length / 3;
      verts.push(x, y, z);
      const k = `${gx},${gy},${gz}`;
      (grid.get(k) ?? grid.set(k, []).get(k)!).push(found);
    }
    remap[i] = found;
  }
  // count only vertices actually referenced, so unused stray vertices do not inflate the number
  {
    const refd = new Uint8Array(nv);
    for (let t = 0; t < nt * 3; t++) { const i = srcI[t]; if (i < nv) refd[i] = 1; }
    const outRef = new Set<number>();
    let srcRef = 0;
    for (let i = 0; i < nv; i++) if (refd[i] && remap[i] >= 0) { srcRef++; outRef.add(remap[i]); }
    report.weldedVerts = Math.max(0, srcRef - outRef.size);
  }
  void usedSrc;
  const V = new Float32Array(verts);
  const NV = V.length / 3;

  // ---- 2. drop degenerate and duplicate triangles
  let tris: number[] = [];
  let src: number[] = [];
  const seen = new Set<string>();
  const area2 = (a: number, b: number, c: number) => {
    const ux = V[b * 3] - V[a * 3], uy = V[b * 3 + 1] - V[a * 3 + 1], uz = V[b * 3 + 2] - V[a * 3 + 2];
    const vx = V[c * 3] - V[a * 3], vy = V[c * 3 + 1] - V[a * 3 + 1], vz = V[c * 3 + 2] - V[a * 3 + 2];
    return Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
  };
  for (let t = 0; t < nt; t++) {
    const i0 = srcI[t * 3], i1 = srcI[t * 3 + 1], i2 = srcI[t * 3 + 2];
    const a = i0 < nv ? remap[i0] : -1, b = i1 < nv ? remap[i1] : -1, c = i2 < nv ? remap[i2] : -1;
    if (a < 0 || b < 0 || c < 0 || a === b || b === c || a === c || area2(a, b, c) < tol * tol) { report.removedDegenerate++; continue; }
    const s = [a, b, c].sort((p, q) => p - q);
    const key = `${s[0]}_${s[1]}_${s[2]}`;
    if (seen.has(key)) { report.removedDuplicate++; continue; }
    seen.add(key);
    tris.push(a, b, c);
    src.push(t);
  }

  // ---- 3. T-junctions (only when there are open edges; repairTJunctions keeps vertex ids)
  if (tris.length && countOpen(tris, NV) > 0) {
    const before = { vertices: V, indices: new Uint32Array(tris) };
    const fixed = repairTJunctions(before, tol * 2);
    if (fixed.indices.length !== tris.length) {
      const nIx = Array.from(fixed.indices);
      src = mapSplitSources(V, tris, src, nIx);
      tris = nIx;
    }
  }

  // ---- 4. orient consistently, 5. fill holes (repeat while progress)
  let verts2 = Array.from(V);
  report.flipped += orient(verts2, tris, false);
  let lastOpen = countOpen(tris, verts2.length / 3);
  for (let pass = 0; pass < 6 && lastOpen > 0; pass++) {
    const filled = fillHoles(verts2, tris, src);
    report.holesFilled += filled;
    const open = countOpen(tris, verts2.length / 3);
    if (!filled || open >= lastOpen) { lastOpen = open; break; }
    lastOpen = open;
  }
  // outward per component (signed volume)
  report.flipped += orient(verts2, tris, true);

  const mesh: IndexedMesh = { vertices: new Float32Array(verts2), indices: new Uint32Array(tris) };
  if (m.faceGroups && m.faceGroups.length) {
    const g = new Uint32Array(src.length);
    for (let i = 0; i < src.length; i++) g[i] = m.faceGroups[src[i]] ?? 0;
    mesh.faceGroups = g;
    if (m.groupKind) mesh.groupKind = m.groupKind;
  }
  report.openEdgesAfter = openEdgeCount(mesh);
  return { mesh, triSource: new Uint32Array(src), report };
}

/** Undirected edges not used by exactly two triangles. */
function countOpen(tris: number[], n: number): number {
  const c = new Map<number, number>();
  for (let t = 0; t < tris.length; t += 3) for (let k = 0; k < 3; k++) {
    const a = tris[t + k], b = tris[t + (k + 1) % 3];
    const key = a < b ? a * n + b : b * n + a;
    c.set(key, (c.get(key) ?? 0) + 1);
  }
  let open = 0;
  c.forEach((x) => { if (x !== 2) open++; });
  return open;
}

/** After repairTJunctions split triangles, find each new triangle's old one: an old triangle sharing a corner whose plane/area contains the new centroid. */
function mapSplitSources(V: Float32Array, oldT: number[], oldSrc: number[], newT: number[]): number[] {
  const vt = new Map<number, number[]>();
  for (let t = 0; t < oldT.length / 3; t++) for (let k = 0; k < 3; k++) {
    const v = oldT[t * 3 + k];
    (vt.get(v) ?? vt.set(v, []).get(v)!).push(t);
  }
  const out: number[] = [];
  for (let t = 0; t < newT.length / 3; t++) {
    const cx = (V[newT[t * 3] * 3] + V[newT[t * 3 + 1] * 3] + V[newT[t * 3 + 2] * 3]) / 3;
    const cy = (V[newT[t * 3] * 3 + 1] + V[newT[t * 3 + 1] * 3 + 1] + V[newT[t * 3 + 2] * 3 + 1]) / 3;
    const cz = (V[newT[t * 3] * 3 + 2] + V[newT[t * 3 + 1] * 3 + 2] + V[newT[t * 3 + 2] * 3 + 2]) / 3;
    let best = 0, bestD = Infinity;
    for (let k = 0; k < 3; k++) for (const o of vt.get(newT[t * 3 + k]) ?? []) {
      const d = pointTriDist(V, oldT[o * 3], oldT[o * 3 + 1], oldT[o * 3 + 2], cx, cy, cz);
      if (d < bestD) { bestD = d; best = o; }
    }
    out.push(oldSrc[best] ?? 0);
  }
  return out;
}

/** Approximate distance of a point to a triangle: plane distance plus barycentric overshoot. */
function pointTriDist(V: ArrayLike<number>, a: number, b: number, c: number, px: number, py: number, pz: number): number {
  const ax = V[a * 3], ay = V[a * 3 + 1], az = V[a * 3 + 2];
  const ux = V[b * 3] - ax, uy = V[b * 3 + 1] - ay, uz = V[b * 3 + 2] - az;
  const vx = V[c * 3] - ax, vy = V[c * 3 + 1] - ay, vz = V[c * 3 + 2] - az;
  const wx = px - ax, wy = py - ay, wz = pz - az;
  const uu = ux * ux + uy * uy + uz * uz, vv = vx * vx + vy * vy + vz * vz, uv = ux * vx + uy * vy + uz * vz;
  const wu = wx * ux + wy * uy + wz * uz, wv = wx * vx + wy * vy + wz * vz;
  const den = uu * vv - uv * uv;
  if (!(Math.abs(den) > 0)) return Infinity;
  const s = (vv * wu - uv * wv) / den, r = (uu * wv - uv * wu) / den;
  const qx = ax + s * ux + r * vx, qy = ay + s * uy + r * vy, qz = az + s * uz + r * vz;
  const out = Math.max(0, -s) + Math.max(0, -r) + Math.max(0, s + r - 1);
  return Math.hypot(px - qx, py - qy, pz - qz) + out * Math.sqrt(Math.max(uu, vv));
}

/**
 * Make winding consistent across each connected component (through manifold edges), and with `outward`
 * flip whole components whose signed volume is negative. Returns the number of triangles flipped.
 */
function orient(V: number[], tris: number[], outward: boolean): number {
  const T = tris.length / 3, n = V.length / 3;
  const edgeTris = new Map<number, number[]>();
  for (let t = 0; t < T; t++) for (let k = 0; k < 3; k++) {
    const a = tris[t * 3 + k], b = tris[t * 3 + (k + 1) % 3];
    const key = a < b ? a * n + b : b * n + a;
    (edgeTris.get(key) ?? edgeTris.set(key, []).get(key)!).push(t);
  }
  const hasDir = (t: number, a: number, b: number) => {
    for (let k = 0; k < 3; k++) if (tris[t * 3 + k] === a && tris[t * 3 + (k + 1) % 3] === b) return true;
    return false;
  };
  const flip = (t: number) => { const x = tris[t * 3 + 1]; tris[t * 3 + 1] = tris[t * 3 + 2]; tris[t * 3 + 2] = x; };
  const comp = new Int32Array(T).fill(-1);
  let flipped = 0, nComp = 0;
  const comps: number[][] = [];
  for (let seed = 0; seed < T; seed++) {
    if (comp[seed] >= 0) continue;
    const id = nComp++;
    const members: number[] = [seed];
    comp[seed] = id;
    const stack = [seed];
    while (stack.length) {
      const t = stack.pop()!;
      for (let k = 0; k < 3; k++) {
        const a = tris[t * 3 + k], b = tris[t * 3 + (k + 1) % 3];
        const list = edgeTris.get(a < b ? a * n + b : b * n + a)!;
        if (list.length !== 2) continue; // only walk across manifold edges
        const u = list[0] === t ? list[1] : list[0];
        if (comp[u] >= 0) continue;
        comp[u] = id;
        // consistent neighbour traverses the shared edge b->a; if it also has a->b it is flipped
        if (!outward && hasDir(u, a, b)) { flip(u); flipped++; }
        members.push(u);
        stack.push(u);
      }
    }
    comps.push(members);
  }
  if (outward) {
    for (const members of comps) {
      let vol = 0;
      for (const t of members) {
        const a = tris[t * 3] * 3, b = tris[t * 3 + 1] * 3, c = tris[t * 3 + 2] * 3;
        vol += V[a] * (V[b + 1] * V[c + 2] - V[b + 2] * V[c + 1]) - V[a + 1] * (V[b] * V[c + 2] - V[b + 2] * V[c]) + V[a + 2] * (V[b] * V[c + 1] - V[b + 1] * V[c]);
      }
      if (vol < 0) for (const t of members) { flip(t); flipped++; }
    }
  }
  return flipped;
}

/** Trace boundary loops and triangulate them. Appends to V/tris/src in place. Returns loops filled. */
function fillHoles(V: number[], tris: number[], src: number[]): number {
  const n = V.length / 3, T = tris.length / 3;
  const undirected = new Map<number, number>();
  const dirTri = new Map<number, number>(); // directed edge a*n+b -> tri
  for (let t = 0; t < T; t++) for (let k = 0; k < 3; k++) {
    const a = tris[t * 3 + k], b = tris[t * 3 + (k + 1) % 3];
    const key = a < b ? a * n + b : b * n + a;
    undirected.set(key, (undirected.get(key) ?? 0) + 1);
    dirTri.set(a * n + b, t);
  }
  // hole half-edges run opposite to the boundary edge of the existing triangle
  const out = new Map<number, number[]>(); // vertex -> next vertices along the hole
  const owner = new Map<number, number>(); // hole half-edge -> source triangle
  for (let t = 0; t < T; t++) for (let k = 0; k < 3; k++) {
    const a = tris[t * 3 + k], b = tris[t * 3 + (k + 1) % 3];
    const key = a < b ? a * n + b : b * n + a;
    if (undirected.get(key) !== 1) continue;
    (out.get(b) ?? out.set(b, []).get(b)!).push(a);
    owner.set(b * n + a, t);
  }
  if (!out.size) return 0;

  const loops: number[][] = [];
  const take = (v: number): number | undefined => {
    const l = out.get(v);
    if (!l || !l.length) return undefined;
    const w = l.pop()!;
    if (!l.length) out.delete(v);
    return w;
  };
  let guard = 0;
  for (const start of Array.from(out.keys())) {
    while (out.has(start) && guard++ < 1e7) {
      // walk; when a vertex repeats, cut the sub-loop off (handles non-manifold boundary vertices)
      const path: number[] = [start];
      const pos = new Map<number, number>([[start, 0]]);
      let cur = start;
      for (;;) {
        const nx = take(cur);
        if (nx === undefined) break; // dead end: open chain, cannot close
        const p = pos.get(nx);
        if (p !== undefined) {
          const loop = path.slice(p);
          for (let k = p + 1; k < path.length; k++) pos.delete(path[k]);
          path.length = p + 1;
          if (loop.length >= 3) loops.push(loop);
        } else {
          path.push(nx); pos.set(nx, path.length - 1);
        }
        cur = nx;
      }
    }
  }

  let filled = 0;
  for (const loop of loops) {
    const srcTri = src[owner.get(loop[0] * n + loop[1]) ?? 0] ?? 0;
    const added = triangulateLoop(V, loop);
    if (!added.length) continue;
    for (let i = 0; i < added.length; i += 3) { tris.push(added[i], added[i + 1], added[i + 2]); src.push(srcTri); }
    filled++;
  }
  return filled;
}

/** Triangulate a closed loop (winding as given). Ear-clipping on the best-fit plane; centroid fan when non-planar or stuck. */
function triangulateLoop(V: number[], loop: number[]): number[] {
  const L = loop.length;
  if (L < 3) return [];
  if (L === 3) return [loop[0], loop[1], loop[2]];
  // Newell normal and centroid
  let nx = 0, ny = 0, nz = 0, cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < L; i++) {
    const a = loop[i] * 3, b = loop[(i + 1) % L] * 3;
    nx += (V[a + 1] - V[b + 1]) * (V[a + 2] + V[b + 2]);
    ny += (V[a + 2] - V[b + 2]) * (V[a] + V[b]);
    nz += (V[a] - V[b]) * (V[a + 1] + V[b + 1]);
    cx += V[a]; cy += V[a + 1]; cz += V[a + 2];
  }
  cx /= L; cy /= L; cz /= L;
  const nl = Math.hypot(nx, ny, nz);
  const fan = () => {
    const c = V.length / 3;
    V.push(cx, cy, cz);
    const r: number[] = [];
    for (let i = 0; i < L; i++) r.push(loop[i], loop[(i + 1) % L], c);
    return r;
  };
  if (!(nl > 0) || L > 5000) return fan();
  nx /= nl; ny /= nl; nz /= nl;
  // planarity check
  let maxOff = 0, radius = 0;
  for (const i of loop) {
    const dx = V[i * 3] - cx, dy = V[i * 3 + 1] - cy, dz = V[i * 3 + 2] - cz;
    maxOff = Math.max(maxOff, Math.abs(dx * nx + dy * ny + dz * nz));
    radius = Math.max(radius, Math.hypot(dx, dy, dz));
  }
  if (maxOff > 0.2 * radius) return fan();
  // 2D basis
  const ax = Math.abs(nx) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  let ux = ny * ax[2] - nz * ax[1], uy = nz * ax[0] - nx * ax[2], uz = nx * ax[1] - ny * ax[0];
  const ul = Math.hypot(ux, uy, uz); ux /= ul; uy /= ul; uz /= ul;
  const vx = ny * uz - nz * uy, vy = nz * ux - nx * uz, vz = nx * uy - ny * ux;
  const P = loop.map((i) => [V[i * 3] * ux + V[i * 3 + 1] * uy + V[i * 3 + 2] * uz, V[i * 3] * vx + V[i * 3 + 1] * vy + V[i * 3 + 2] * vz]);
  // Newell normal follows the loop winding, so in this basis the loop is counter-clockwise
  const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const idx = Array.from({ length: L }, (_, i) => i);
  const res: number[] = [];
  let i = 0, stall = 0;
  while (idx.length > 3) {
    if (stall > idx.length) return fan();
    const m = idx.length;
    const p = idx[(i + m - 1) % m], c = idx[i % m], q = idx[(i + 1) % m];
    let ear = cross(P[p], P[c], P[q]) > 1e-12 * radius * radius;
    if (ear) for (const k of idx) {
      if (k === p || k === c || k === q) continue;
      if (cross(P[p], P[c], P[k]) >= 0 && cross(P[c], P[q], P[k]) >= 0 && cross(P[q], P[p], P[k]) >= 0) { ear = false; break; }
    }
    if (ear) { res.push(loop[p], loop[c], loop[q]); idx.splice(i % m, 1); stall = 0; i = i % idx.length; }
    else { i = (i + 1) % m; stall++; }
  }
  res.push(loop[idx[0]], loop[idx[1]], loop[idx[2]]);
  return res;
}
