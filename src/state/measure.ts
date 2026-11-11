// Measure tool: pick points, edges or planes on the models, read the distance
// or angle between two features, and scale an object so a measured distance becomes a given value.
import * as THREE from 'three';
import type { Vec3 } from './store';

export type MeasureMode = 'auto' | 'point' | 'edge' | 'face' | 'circle';
export type MeasureFeature =
  | { kind: 'point'; objId: string; p: Vec3 }
  | { kind: 'edge'; objId: string; a: Vec3; b: Vec3 }
  | { kind: 'plane'; objId: string; p: Vec3; n: Vec3 }
  | { kind: 'circle'; objId: string; center: Vec3; normal: Vec3; r: number };

const V = (p: Vec3) => new THREE.Vector3(p[0], p[1], p[2]);
const arr = (v: THREE.Vector3): Vec3 => [v.x, v.y, v.z];

/**
 * Feature under a click on triangle `tri` (world-space corners, outward normal) at `hit`.
 * Auto mode prefers an edge when the click is within `edgeSnap` mm of a triangle edge on a sharp crease,
 * else the plane when the surface there is flat, else the point.
 */
export function pickFeature(objId: string, mode: MeasureMode, hit: THREE.Vector3, tri: [THREE.Vector3, THREE.Vector3, THREE.Vector3],
  normal: THREE.Vector3, sharpEdge: (i: number) => boolean, flat: boolean, edgeSnap = 1): MeasureFeature {
  let best = -1, bestD = Infinity;
  const line = new THREE.Line3(), q = new THREE.Vector3();
  for (let i = 0; i < 3; i++) {
    line.set(tri[i], tri[(i + 1) % 3]);
    const d = line.closestPointToPoint(hit, true, q).distanceTo(hit);
    if (d < bestD) { bestD = d; best = i; }
  }
  const edge = (): MeasureFeature => ({ kind: 'edge', objId, a: arr(tri[best]), b: arr(tri[(best + 1) % 3]) });
  if (mode === 'edge') return edge();
  if (mode === 'face') return { kind: 'plane', objId, p: arr(hit), n: arr(normal.clone().normalize()) };
  if (mode === 'point') return { kind: 'point', objId, p: arr(hit) };
  if (bestD <= edgeSnap && sharpEdge(best)) return edge();
  if (flat) return { kind: 'plane', objId, p: arr(hit), n: arr(normal.clone().normalize()) };
  return { kind: 'point', objId, p: arr(hit) };
}

export interface MeasureResult {
  /** Shortest distance between the features (null when it is not defined, e.g. intersecting planes). */
  distance: number | null;
  /** Angle between edges / planes, degrees. */
  angle: number | null;
  delta: Vec3 | null;
  /** The two points the distance is measured between (for drawing and for scaling). */
  from: Vec3 | null;
  to: Vec3 | null;
}

const closestOnFeature = (f: MeasureFeature, p: THREE.Vector3): THREE.Vector3 => {
  if (f.kind === 'point') return V(f.p);
  if (f.kind === 'edge') return new THREE.Line3(V(f.a), V(f.b)).closestPointToPoint(p, true, new THREE.Vector3());
  if (f.kind === 'circle') return V(f.center);
  return new THREE.Plane().setFromNormalAndCoplanarPoint(V(f.n), V(f.p)).projectPoint(p, new THREE.Vector3());
};

const dirOf = (f: MeasureFeature) => (f.kind === 'edge' ? V(f.b).sub(V(f.a)).normalize() : f.kind === 'plane' ? V(f.n) : null);

export function measure(a0: MeasureFeature, b0: MeasureFeature): MeasureResult {
  const asPoint = (f: MeasureFeature): MeasureFeature => (f.kind === 'circle' ? { kind: 'point', objId: f.objId, p: f.center } : f);
  const a = asPoint(a0), b = asPoint(b0);
  const res: MeasureResult = { distance: null, angle: null, delta: null, from: null, to: null };
  const da = dirOf(a), db = dirOf(b);
  if (da && db) {
    let ang = (Math.acos(Math.min(1, Math.abs(da.dot(db)))) * 180) / Math.PI;
    if (a.kind !== b.kind) ang = 90 - ang; // edge against plane: angle to the plane, not its normal
    res.angle = ang;
  }
  // planes that are not parallel meet: no distance between them
  if (a.kind === 'plane' && b.kind === 'plane' && res.angle! > 0.01) return res;
  if ((a.kind === 'plane' && b.kind === 'edge') || (a.kind === 'edge' && b.kind === 'plane')) {
    const pl = a.kind === 'plane' ? a : (b as typeof a), ed = a.kind === 'edge' ? a : (b as Extract<MeasureFeature, { kind: 'edge' }>);
    if (res.angle! > 0.01) return res;
    const p = V(ed.a);
    const q = closestOnFeature(pl, p);
    return fill(res, a === ed ? p : q, a === ed ? q : p);
  }
  let p: THREE.Vector3, q: THREE.Vector3;
  if (a.kind === 'edge' && b.kind === 'edge') {
    [p, q] = segmentClosest(V(a.a), V(a.b), V(b.a), V(b.b));
  } else if (a.kind === 'point') { p = V(a.p); q = closestOnFeature(b, p); }
  else if (b.kind === 'point') { q = V(b.p); p = closestOnFeature(a, q); }
  else { p = a.kind === 'plane' ? V(a.p) : V((a as any).a); q = closestOnFeature(b, p); }
  return fill(res, p, q);
}

function fill(res: MeasureResult, p: THREE.Vector3, q: THREE.Vector3): MeasureResult {
  res.from = arr(p); res.to = arr(q);
  res.distance = p.distanceTo(q);
  res.delta = [Math.abs(q.x - p.x), Math.abs(q.y - p.y), Math.abs(q.z - p.z)];
  return res;
}

/** Closest points between segments p1-q1 and p2-q2 (Ericson, Real-Time Collision Detection 5.1.9). */
function segmentClosest(p1: THREE.Vector3, q1: THREE.Vector3, p2: THREE.Vector3, q2: THREE.Vector3): [THREE.Vector3, THREE.Vector3] {
  const d1 = q1.clone().sub(p1), d2 = q2.clone().sub(p2), r = p1.clone().sub(p2);
  const a = d1.dot(d1), e = d2.dot(d2), f = d2.dot(r);
  let s = 0, t = 0;
  if (a <= 1e-12 && e <= 1e-12) return [p1.clone(), p2.clone()];
  if (a <= 1e-12) t = THREE.MathUtils.clamp(f / e, 0, 1);
  else {
    const c = d1.dot(r);
    if (e <= 1e-12) s = THREE.MathUtils.clamp(-c / a, 0, 1);
    else {
      const b = d1.dot(d2), den = a * e - b * b;
      s = den > 1e-12 ? THREE.MathUtils.clamp((b * f - c * e) / den, 0, 1) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = THREE.MathUtils.clamp(-c / a, 0, 1); } else if (t > 1) { t = 1; s = THREE.MathUtils.clamp((b - c) / a, 0, 1); }
    }
  }
  return [p1.clone().addScaledVector(d1, s), p2.clone().addScaledVector(d2, t)];
}

/** Length of a single picked edge. */
export const edgeLength = (f: MeasureFeature) => (f.kind === 'edge' ? V(f.a).distanceTo(V(f.b)) : f.kind === 'circle' ? f.r * 2 : null);

/**
 * Circle feature (hole and boss edges are picked as circles): the boundary loop of the flat face
 * `region` (triangle indices) nearest to `near`, fitted as a circle when its points lie within 3 % of a common
 * radius. Corners are world-space by `toWorld`.
 */
export function circleFeature(objId: string, mesh: { indices: ArrayLike<number> }, region: ArrayLike<number>, vert: (i: number) => THREE.Vector3,
  near: THREE.Vector3): Extract<MeasureFeature, { kind: 'circle' }> | null {
  const ix = mesh.indices;
  // rim edges: region edges whose triangle on the other side turns away by more than 30° (a real crease);
  // edges next to sliver triangles of boolean results (no usable normal) are not rims
  const inRegion = new Set(Array.from(region));
  const nrm = (t: number, minArea = 0) => {
    const a = vert(ix[t * 3]), b = vert(ix[t * 3 + 1]), c = vert(ix[t * 3 + 2]);
    const n = b.sub(a).cross(c.sub(a));
    return n.length() / 2 <= Math.max(1e-9, minArea) ? null : n.normalize();
  };
  const edgeTris = new Map<string, number[]>();
  for (let t = 0; t < ix.length / 3; t++) for (let e = 0; e < 3; e++) {
    const a = ix[t * 3 + e], b = ix[t * 3 + ((e + 1) % 3)];
    const k = a < b ? `${a}_${b}` : `${b}_${a}`;
    (edgeTris.get(k) ?? edgeTris.set(k, []).get(k)!).push(t);
  }
  const count = new Map<string, [number, number, number]>();
  const n0 = nrm(Array.from(region)[0]);
  for (const t of Array.from(region)) for (let e = 0; e < 3; e++) {
    const a = ix[t * 3 + e], b = ix[t * 3 + ((e + 1) % 3)];
    const k = a < b ? `${a}_${b}` : `${b}_${a}`;
    const others = (edgeTris.get(k) ?? []).filter((u) => !inRegion.has(u));
    // the wall across a rim is steep (more than 60° from the face) and more than a sliver
    const crease = others.some((u) => { const n = nrm(u, 1e-3); return !!n && !!n0 && Math.abs(n.dot(n0)) < 0.5; });
    if (crease) count.set(k, [a, b, 1]);
  }
  // connected groups of boundary edges (union-find); a hole or boss rim is one group
  const parent = new Map<number, number>();
  const find = (x: number): number => { let r = x; while (parent.get(r) !== r) r = parent.get(r)!; parent.set(x, r); return r; };
  for (const [a, b, c] of count.values()) if (c === 1) {
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    parent.set(find(a), find(b));
  }
  const groups = new Map<number, number[]>();
  for (const v of parent.keys()) { const r = find(v); (groups.get(r) ?? groups.set(r, []).get(r)!).push(v); }
  const loops = [...groups.values()].filter((g) => g.length >= 8);
  let best: Extract<MeasureFeature, { kind: 'circle' }> | null = null, bestD = Infinity;
  for (const loop of loops) {
    const pts = loop.map(vert);
    // least-squares circle in the face plane (Kåsa fit); rim vertices are rarely spread evenly, so no centroid
    const n = n0 ? n0.clone() : new THREE.Vector3(0, 0, 1);
    const u = new THREE.Vector3().crossVectors(n, Math.abs(n.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0)).normalize();
    const w = new THREE.Vector3().crossVectors(n, u);
    const o = pts[0];
    const xy = pts.map((p) => { const d = p.clone().sub(o); return [d.dot(u), d.dot(w)]; });
    let sxx = 0, sxy = 0, syy = 0, sx = 0, sy = 0, sz = 0, sxz = 0, syz = 0;
    for (const [x, y] of xy) { const z = x * x + y * y; sxx += x * x; sxy += x * y; syy += y * y; sx += x; sy += y; sz += z; sxz += x * z; syz += y * z; }
    const N = xy.length;
    // [sxx sxy sx; sxy syy sy; sx sy N] · [D E F] = −[sxz syz sz]
    const M = [[sxx, sxy, sx], [sxy, syy, sy], [sx, sy, N]], rhs = [-sxz, -syz, -sz];
    const det = (m: number[][]) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    const dt = det(M);
    if (Math.abs(dt) < 1e-12) continue;
    const col = (k: number) => M.map((row, i) => row.map((v, j) => (j === k ? rhs[i] : v)));
    const D = det(col(0)) / dt, E = det(col(1)) / dt, F = det(col(2)) / dt;
    const cx = -D / 2, cy = -E / 2, r = Math.sqrt(Math.max(0, cx * cx + cy * cy - F));
    const c = o.clone().addScaledVector(u, cx).addScaledVector(w, cy);
    const rs = pts.map((p) => p.distanceTo(c));
    if (r < 1e-3 || Math.max(...rs.map((x) => Math.abs(x - r))) > r * 0.03) continue;
    const d = Math.abs(near.distanceTo(c) - r);
    if (d < bestD) { bestD = d; best = { kind: 'circle', objId, center: arr(c), normal: arr(n), r }; }
  }
  return best;
}
