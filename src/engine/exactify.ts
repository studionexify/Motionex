// Hybrid "make smooth": turns a faceted mesh (an STL, a coarse export) into a smooth, accurate surface.
//  1. The mesh is split into smooth regions bounded by crease edges.
//  2. Each region is tested against exact surfaces (plane, sphere, cylinder). A region that fits is recognised.
//  3. The mesh is subdivided (Loop, creases kept sharp), then every vertex of a recognised region is projected
//     onto its exact surface; vertices on the seam of two recognised regions go onto their intersection.
//     Regions that match no exact surface keep the smooth subdivision surface.
import type { IndexedMesh } from './mesh';
import { subdivide, type EditResult } from './meshedit';

export type ExactSurface =
  | { kind: 'plane'; n: [number, number, number]; d: number }
  | { kind: 'sphere'; c: [number, number, number]; r: number }
  | { kind: 'cylinder'; p: [number, number, number]; a: [number, number, number]; r: number };

export interface ExactifyOptions {
  /** Edges bending more than this bound regions and stay sharp. */
  creaseDeg?: number;
  /** Subdivision levels (each splits every triangle in four). Default picks 1-2 by mesh size. */
  levels?: number;
  /** Fit tolerance as a fraction of the region size (RMS deviation). */
  relTol?: number;
  maxTris?: number;
}

export interface ExactifyResult extends EditResult {
  regions: number;
  planes: number;
  spheres: number;
  cylinders: number;
  freeform: number;
}

type V3 = [number, number, number];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: V3): V3 => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Eigen-decomposition of a symmetric 3x3 (Jacobi). Returns eigenvalues ascending with their unit vectors. */
export function eigSym3(m: number[]): { vals: number[]; vecs: V3[] } {
  const a = [[m[0], m[1], m[2]], [m[1], m[4], m[5]], [m[2], m[5], m[8]]];
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let it = 0; it < 50; it++) {
    let p = 0, q = 1, big = Math.abs(a[0][1]);
    if (Math.abs(a[0][2]) > big) { p = 0; q = 2; big = Math.abs(a[0][2]); }
    if (Math.abs(a[1][2]) > big) { p = 1; q = 2; big = Math.abs(a[1][2]); }
    if (big < 1e-14) break;
    const th = (a[q][q] - a[p][p]) / (2 * a[p][q]);
    const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1));
    const c = 1 / Math.sqrt(t * t + 1), s = t * c;
    for (let k = 0; k < 3; k++) { const akp = a[k][p], akq = a[k][q]; a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq; }
    for (let k = 0; k < 3; k++) { const apk = a[p][k], aqk = a[q][k]; a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk; }
    for (let k = 0; k < 3; k++) { const vkp = v[k][p], vkq = v[k][q]; v[k][p] = c * vkp - s * vkq; v[k][q] = s * vkp + c * vkq; }
  }
  const idx = [0, 1, 2].sort((i, j) => a[i][i] - a[j][j]);
  return { vals: idx.map((i) => a[i][i]), vecs: idx.map((i) => [v[0][i], v[1][i], v[2][i]] as V3) };
}

/** Solve a small dense linear system (Gaussian elimination with pivoting); null when singular. */
function solve(A: number[][], b: number[]): number[] | null {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  return M.map((r, i) => r[n] / M[i][i]);
}

/** Signed distance of p from the surface (positive outside / along the plane normal). */
export function surfaceDistance(s: ExactSurface, p: V3): number {
  if (s.kind === 'plane') return dot(s.n, p) - s.d;
  if (s.kind === 'sphere') return len(sub(p, s.c)) - s.r;
  const d = sub(p, s.p), t = dot(d, s.a);
  return len([d[0] - s.a[0] * t, d[1] - s.a[1] * t, d[2] - s.a[2] * t]) - s.r;
}

/** Closest point on the surface. */
export function projectOnto(s: ExactSurface, p: V3): V3 {
  if (s.kind === 'plane') { const e = dot(s.n, p) - s.d; return [p[0] - s.n[0] * e, p[1] - s.n[1] * e, p[2] - s.n[2] * e]; }
  if (s.kind === 'sphere') { const u = norm(sub(p, s.c)); return [s.c[0] + u[0] * s.r, s.c[1] + u[1] * s.r, s.c[2] + u[2] * s.r]; }
  const d = sub(p, s.p), t = dot(d, s.a);
  const foot: V3 = [s.p[0] + s.a[0] * t, s.p[1] + s.a[1] * t, s.p[2] + s.a[2] * t];
  const u = norm(sub(p, foot));
  return [foot[0] + u[0] * s.r, foot[1] + u[1] * s.r, foot[2] + u[2] * s.r];
}

/** Surface normal at p (outward for sphere/cylinder; the plane's own normal). */
function normalAt(s: ExactSurface, p: V3): V3 {
  if (s.kind === 'plane') return s.n;
  if (s.kind === 'sphere') return norm(sub(p, s.c));
  const d = sub(p, s.p), t = dot(d, s.a);
  return norm([d[0] - s.a[0] * t, d[1] - s.a[1] * t, d[2] - s.a[2] * t]);
}

/** Mean angle (radians) between facet normals and the surface normal under each facet centroid. */
function normalError(s: ExactSurface, cents: V3[], normals: V3[]) {
  let e = 0;
  for (let i = 0; i < cents.length; i++) e += Math.acos(Math.min(1, Math.abs(dot(normalAt(s, cents[i]), normals[i]))));
  return e / Math.max(1, cents.length);
}

function rms(s: ExactSurface, pts: V3[]) {
  let e = 0, mx = 0;
  for (const p of pts) { const d = Math.abs(surfaceDistance(s, p)); e += d * d; if (d > mx) mx = d; }
  return { rms: Math.sqrt(e / Math.max(1, pts.length)), max: mx };
}

export function fitPlane(pts: V3[]): ExactSurface {
  const c: V3 = [0, 0, 0];
  for (const p of pts) { c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; }
  c[0] /= pts.length; c[1] /= pts.length; c[2] /= pts.length;
  const m = new Array(9).fill(0);
  for (const p of pts) { const d = sub(p, c); for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) m[i * 3 + j] += d[i] * d[j]; }
  const n = eigSym3(m).vecs[0];
  return { kind: 'plane', n, d: dot(n, c) };
}

export function fitSphere(pts: V3[]): ExactSurface | null {
  // |p|² = 2c·p + k  → linear least squares in (cx, cy, cz, k)
  const A = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], b = [0, 0, 0, 0];
  for (const p of pts) {
    const row = [2 * p[0], 2 * p[1], 2 * p[2], 1], y = dot(p, p);
    for (let i = 0; i < 4; i++) { b[i] += row[i] * y; for (let j = 0; j < 4; j++) A[i][j] += row[i] * row[j]; }
  }
  const x = solve(A, b);
  if (!x) return null;
  const c: V3 = [x[0], x[1], x[2]], r2 = x[3] + dot(c, c);
  return r2 > 0 ? { kind: 'sphere', c, r: Math.sqrt(r2) } : null;
}

/** Cylinder from points and their surface normals: the axis is the direction the normals are all perpendicular to. */
export function fitCylinder(pts: V3[], normals: V3[]): ExactSurface | null {
  const m = new Array(9).fill(0);
  for (const n of normals) for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) m[i * 3 + j] += n[i] * n[j];
  const { vals, vecs } = eigSym3(m);
  // normals must spread in a plane: one tiny eigenvalue, the other two clearly not
  if (vals[0] > 0.02 * normals.length || vals[1] < 0.02 * normals.length) return null;
  const a = norm(vecs[0]);
  const u = norm(cross(a, Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0])), w = cross(a, u);
  // 2D circle fit (Kåsa) in the plane across the axis
  const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], b = [0, 0, 0];
  for (const p of pts) {
    const x = dot(p, u), y = dot(p, w), row = [2 * x, 2 * y, 1], z = x * x + y * y;
    for (let i = 0; i < 3; i++) { b[i] += row[i] * z; for (let j = 0; j < 3; j++) A[i][j] += row[i] * row[j]; }
  }
  const s = solve(A, b);
  if (!s) return null;
  const r2 = s[2] + s[0] * s[0] + s[1] * s[1];
  if (r2 <= 0) return null;
  const p: V3 = [u[0] * s[0] + w[0] * s[1], u[1] * s[0] + w[1] * s[1], u[2] * s[0] + w[2] * s[1]];
  return { kind: 'cylinder', p, a, r: Math.sqrt(r2) };
}

/** Smooth regions: triangles joined across edges that bend less than `creaseDeg`. */
function regionsOf(mesh: IndexedMesh, creaseDeg: number) {
  const v = mesh.vertices, ix = mesh.indices, tris = ix.length / 3;
  const fn = new Float64Array(tris * 3);
  for (let t = 0; t < tris; t++) {
    const a = ix[t * 3] * 3, b = ix[t * 3 + 1] * 3, c = ix[t * 3 + 2] * 3;
    const n = norm(cross([v[b] - v[a], v[b + 1] - v[a + 1], v[b + 2] - v[a + 2]], [v[c] - v[a], v[c + 1] - v[a + 1], v[c + 2] - v[a + 2]]));
    fn[t * 3] = n[0]; fn[t * 3 + 1] = n[1]; fn[t * 3 + 2] = n[2];
  }
  const edges = new Map<string, number[]>();
  for (let t = 0; t < tris; t++) for (let k = 0; k < 3; k++) {
    const p = ix[t * 3 + k], q = ix[t * 3 + ((k + 1) % 3)];
    const key = p < q ? `${p}_${q}` : `${q}_${p}`;
    const l = edges.get(key); if (l) l.push(t); else edges.set(key, [t]);
  }
  const nbr: number[][] = Array.from({ length: tris }, () => []);
  const cosLim = Math.cos((creaseDeg * Math.PI) / 180);
  for (const l of edges.values()) if (l.length === 2) {
    const [s, t] = l;
    if (fn[s * 3] * fn[t * 3] + fn[s * 3 + 1] * fn[t * 3 + 1] + fn[s * 3 + 2] * fn[t * 3 + 2] >= cosLim) { nbr[s].push(t); nbr[t].push(s); }
  }
  const region = new Int32Array(tris).fill(-1);
  let count = 0;
  for (let t0 = 0; t0 < tris; t0++) {
    if (region[t0] >= 0) continue;
    const stack = [t0]; region[t0] = count;
    while (stack.length) { const t = stack.pop()!; for (const u of nbr[t]) if (region[u] < 0) { region[u] = count; stack.push(u); } }
    count++;
  }
  return { region, count, fn };
}

/** Recognise exact surfaces per smooth region, subdivide, and snap recognised regions onto their exact surface. */
export function exactify(mesh: IndexedMesh, opts: ExactifyOptions = {}): ExactifyResult {
  const crease = opts.creaseDeg ?? 30;
  const relTol = opts.relTol ?? 0.004;
  const v = mesh.vertices, ix = mesh.indices, tris = ix.length / 3;
  const { region, count, fn } = regionsOf(mesh, crease);

  // gather each region's vertices and (area-free) face normals
  const verts: Set<number>[] = Array.from({ length: count }, () => new Set());
  const normals: V3[][] = Array.from({ length: count }, () => []);
  const cents: V3[][] = Array.from({ length: count }, () => []);
  for (let t = 0; t < tris; t++) {
    const r = region[t];
    const c: V3 = [0, 0, 0];
    for (let k = 0; k < 3; k++) { const i = ix[t * 3 + k]; verts[r].add(i); c[0] += v[i * 3] / 3; c[1] += v[i * 3 + 1] / 3; c[2] += v[i * 3 + 2] / 3; }
    normals[r].push([fn[t * 3], fn[t * 3 + 1], fn[t * 3 + 2]]);
    cents[r].push(c);
  }
  // a facet of a true tessellation leans at most about half the crease angle away from the surface it approximates
  const maxLean = (crease * Math.PI) / 360;
  const surfaces: (ExactSurface | null)[] = new Array(count).fill(null);
  const res = { planes: 0, spheres: 0, cylinders: 0, freeform: 0 };
  for (let r = 0; r < count; r++) {
    const pts = [...verts[r]].map((i) => [v[i * 3], v[i * 3 + 1], v[i * 3 + 2]] as V3);
    if (pts.length < 3) continue;
    let lo: V3 = [Infinity, Infinity, Infinity], hi: V3 = [-Infinity, -Infinity, -Infinity];
    for (const p of pts) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[k]); hi[k] = Math.max(hi[k], p[k]); }
    const size = len(sub(hi, lo));
    const tol = Math.max(0.005, size * relTol);
    const ok = (s: ExactSurface | null) => { if (!s) return false; const e = rms(s, pts); return e.rms <= tol && e.max <= tol * 4 && normalError(s, cents[r], normals[r]) <= maxLean; };
    const plane = fitPlane(pts);
    if (ok(plane)) { surfaces[r] = plane; res.planes++; continue; }
    if (pts.length < 8) { res.freeform++; continue; }
    const cyl = fitCylinder(pts, normals[r]);
    const sph = fitSphere(pts);
    const cOk = ok(cyl) && cyl!.kind === 'cylinder' && cyl!.r < size * 50;
    const sOk = ok(sph) && sph!.kind === 'sphere' && sph!.r < size * 50;
    // both can pass on few points (two rings of a cylinder lie on a sphere too): the facet normals decide
    if (cOk && (!sOk || normalError(cyl!, cents[r], normals[r]) <= normalError(sph!, cents[r], normals[r]))) { surfaces[r] = cyl; res.cylinders++; }
    else if (sOk) { surfaces[r] = sph; res.spheres++; }
    else res.freeform++;
  }

  const levels = opts.levels ?? (tris < 60_000 ? 2 : 1);
  const sd = subdivide(mesh, { levels, creaseDeg: crease, maxTris: opts.maxTris ?? 3_000_000 });
  const out = sd.mesh, ov = out.vertices, oi = out.indices;

  // which exact surfaces touch each new vertex (via the region of the source triangle)
  const vSurf: (Set<number> | null)[] = new Array(ov.length / 3).fill(null);
  const vFree = new Uint8Array(ov.length / 3);
  for (let t = 0; t < oi.length / 3; t++) {
    const r = region[sd.triSource[t]];
    for (let k = 0; k < 3; k++) {
      const vi = oi[t * 3 + k];
      if (!surfaces[r]) { vFree[vi] = 1; continue; }
      (vSurf[vi] ??= new Set()).add(r);
    }
  }
  const pos = new Float32Array(ov);
  for (let i = 0; i < vSurf.length; i++) {
    const set = vSurf[i];
    if (!set || vFree[i]) continue;
    const list = [...set].map((r) => surfaces[r]!);
    let p: V3 = [ov[i * 3], ov[i * 3 + 1], ov[i * 3 + 2]];
    // alternating projection converges onto the intersection curve / corner of the touching surfaces
    for (let it = 0; it < (list.length > 1 ? 40 : 1); it++) for (const s of list) p = projectOnto(s, p);
    pos[i * 3] = p[0]; pos[i * 3 + 1] = p[1]; pos[i * 3 + 2] = p[2];
  }
  return { mesh: { ...out, vertices: pos }, triSource: sd.triSource, regions: count, ...res };
}
