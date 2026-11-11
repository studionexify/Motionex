// Flenex placement helpers: where a cut goes on an imported model, and whether the result fits the printer.
import type { IndexedMesh } from '../../engine/mesh';
import { bounds, type V3 } from './csg';
import { defaultJoint, type JointKind } from './joints';
import * as THREE from 'three';
import type { MeshBVH } from 'three-mesh-bvh';
import { newCut, probeCut, type Cut } from './flexi';

/** Direction of the limb around a point: the main axis of the surface points within `radius` (power iteration on the covariance). */
export function localAxis(m: IndexedMesh, p: V3, radius: number): V3 {
  const v = m.vertices, pts: V3[] = [];
  for (let i = 0; i < v.length; i += 3) if ((v[i] - p[0]) ** 2 + (v[i + 1] - p[1]) ** 2 + (v[i + 2] - p[2]) ** 2 <= radius * radius) pts.push([v[i], v[i + 1], v[i + 2]]);
  if (pts.length < 8) return [1, 0, 0];
  const c: V3 = [0, 0, 0];
  for (const q of pts) for (let k = 0; k < 3; k++) c[k] += q[k] / pts.length;
  const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const q of pts) { const d = [q[0] - c[0], q[1] - c[1], q[2] - c[2]]; for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) C[a][b] += d[a] * d[b]; }
  let x: V3 = [0.577, 0.577, 0.577];
  for (let it = 0; it < 30; it++) {
    const y: V3 = [0, 0, 0];
    for (let a = 0; a < 3; a++) y[a] = C[a][0] * x[0] + C[a][1] * x[1] + C[a][2] * x[2];
    const l = Math.hypot(...y) || 1; x = [y[0] / l, y[1] / l, y[2] / l];
  }
  return x;
}

export type CutOrientation = 'centreline' | 'local' | 'surface' | 'x' | 'y' | 'z';
export const ORIENTATIONS: { id: CutOrientation; name: string }[] = [
  { id: 'centreline', name: 'Square to the body (follows the centre line)' }, { id: 'local', name: 'Square to the body (local direction)' },
  { id: 'surface', name: 'Straight into the surface' }, { id: 'x', name: 'Across X' }, { id: 'y', name: 'Across Y' }, { id: 'z', name: 'Across Z (horizontal slice)' },
];

const v3 = (a: V3) => new THREE.Vector3(a[0], a[1], a[2]);
const toV = (a: THREE.Vector3): V3 => [a.x, a.y, a.z];

/** The direction in which the body runs from a point inside it: the longest free ray (a tube's axis is where rays travel farthest). */
export function longestRay(bvh: MeshBVH, p: V3, count = 96): V3 {
  const ray = new THREE.Ray(v3(p), new THREE.Vector3());
  let best = 0, bd: V3 = [1, 0, 0];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const y = 1 - (2 * (i + 0.5)) / count, r = Math.sqrt(1 - y * y), a = i * golden;
    ray.direction.set(Math.cos(a) * r, y, Math.sin(a) * r);
    const h = bvh.raycastFirst(ray, THREE.DoubleSide);
    const d = h ? h.distance : 1e3;
    if (d > best) { best = d; bd = [ray.direction.x, ray.direction.y, ray.direction.z]; }
  }
  return bd;
}

/**
 * The body's centre line near a point: the centre of the section square to direction n, then a step each way along n,
 * re-centred, and the direction between those two centres (repeated). This is the direction a cut must face to be
 * perpendicular to the body, whatever the body's curve.
 */
export function centrelineAt(bvh: MeshBVH, p: V3, n0: V3, rounds = 3, robust = false): { origin: V3; normal: V3; inr: number } {
  let n = v3(n0).normalize(), c = v3(p), inr = 3;
  for (let i = 0; i < rounds; i++) {
    const here = probeCut(bvh, toV(c), toV(n), 0, [0, 0, 1], 24, robust);
    if (!here.probe.inside) break;
    c = v3(here.centre); inr = here.probe.inr;
    const s = Math.max(1.5, Math.min(8, inr * 0.8));
    const fwd = probeCut(bvh, toV(c.clone().addScaledVector(n, s)), toV(n), 0, [0, 0, 1], 24, robust), back = probeCut(bvh, toV(c.clone().addScaledVector(n, -s)), toV(n), 0, [0, 0, 1], 24, robust);
    if (!fwd.probe.inside || !back.probe.inside) break;
    const t = v3(fwd.centre).sub(v3(back.centre));
    if (t.lengthSq() < 1e-6) break;
    t.normalize();
    if (t.dot(n) < 0) t.negate();
    n = n.clone().lerp(t, 0.85).normalize();
  }
  // final centre for the final direction
  const fin = probeCut(bvh, toV(c), toV(n), 0, [0, 0, 1], 24, robust);
  return { origin: fin.probe.inside ? fin.centre : toV(c), normal: toV(n), inr: fin.probe.inr || inr };
}

/**
 * Where a cut goes when the cursor is over the model at `hit` (surface normal sn): the plane's centre and normal for the
 * chosen mode. `keep` is the previous normal while dragging, so the plane never flips.
 */
export function smartPlane(m: IndexedMesh, bvh: MeshBVH, hit: V3, sn: V3, mode: CutOrientation, keep?: V3): { origin: V3; normal: V3 } {
  const inside: V3 = [hit[0] - sn[0] * 1.5, hit[1] - sn[1] * 1.5, hit[2] - sn[2] * 1.5];
  let n: V3, origin: V3 = inside;
  switch (mode) {
    case 'x': n = [1, 0, 0]; break;
    case 'y': n = [0, 1, 0]; break;
    case 'z': n = [0, 0, 1]; break;
    case 'surface': n = [-sn[0], -sn[1], -sn[2]]; break;
    case 'local': {
      n = longestRay(bvh, inside);
      const r = probeCut(bvh, inside, n, 0); if (r.probe.inside) origin = r.centre;
      break;
    }
    default: {
      const r = centrelineAt(bvh, inside, longestRay(bvh, inside), 4);
      n = r.normal; origin = r.origin;
    }
  }
  // one consistent sense along a body: follow the previous plane while dragging, otherwise point towards +x (then +y)
  const ref = keep ?? [1, 0.001, 0.0001];
  if (n[0] * ref[0] + n[1] * ref[1] + n[2] * ref[2] < 0) n = [-n[0], -n[1], -n[2]];
  return { origin, normal: n };
}

/** The cut a click creates. */
export function cutAt(m: IndexedMesh, bvh: MeshBVH, id: string, hit: V3, surfaceNormal: V3, mode: CutOrientation, kind: JointKind): Cut {
  const { origin, normal } = smartPlane(m, bvh, hit, surfaceNormal, mode);
  const c = newCut(id, origin, normal, defaultJoint(kind));
  c.name = `Cut ${id}`;
  return c;
}

/** Centre line from a start point towards an end point, staying in the middle of the body (a limb, a tail, a whole body). */
export function traceCentreline(bvh: MeshBVH, m: IndexedMesh, start: V3, end: V3, sn: V3, maxSteps = 500): V3[] {
  const inside0: V3 = [start[0] - sn[0] * 1.5, start[1] - sn[1] * 1.5, start[2] - sn[2] * 1.5];
  const goal = v3(end);
  let dir = goal.clone().sub(v3(inside0)).normalize();
  const first = centrelineAt(bvh, inside0, toV(dir), 2, true);
  void longestRay;
  let p = v3(first.origin);
  const path: V3[] = [toV(p)];
  let n = v3(first.normal); if (n.dot(dir) < 0) n.negate();
  for (let i = 0; i < maxSteps; i++) {
    const probe = probeCut(bvh, toV(p), toV(n), 0, [0, 0, 1], 24, true).probe;
    const s = Math.max(1.5, Math.min(7, (probe.inr || 3) * 0.8));
    const toGoal = goal.clone().sub(p);
    if (toGoal.length() < s * 1.2) break;
    // lean the heading a little towards the goal so the walk cannot wander off the part
    const heading = n.clone().multiplyScalar(0.85).addScaledVector(toGoal.normalize(), 0.15).normalize();
    const q = p.clone().addScaledVector(heading, s);
    const r = probeCut(bvh, toV(q), toV(heading), 0, [0, 0, 1], 24, true);
    if (!r.probe.inside) break;
    const next = v3(r.centre);
    const step = next.clone().sub(p);
    if (step.length() < 0.2) break;
    n = n.clone().lerp(step.normalize(), 0.6).normalize();
    p = next;
    path.push(toV(p));
  }
  void m;
  return path;
}

/** Centre line of a whole elongated model: from one end to the other along its main axis, staying in the middle of the body. */
export function autoBodyPath(bvh: MeshBVH, m: IndexedMesh): V3[] {
  const v = m.vertices, n = v.length / 3, c = [0, 0, 0];
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) c[k] += v[i * 3 + k] / n;
  const ax = localAxis(m, [c[0], c[1], c[2]], 1e9);
  let lo = Infinity, hi = -Infinity, il = 0, ih = 0;
  for (let i = 0; i < n; i++) { const t = (v[i * 3] - c[0]) * ax[0] + (v[i * 3 + 1] - c[1]) * ax[1] + (v[i * 3 + 2] - c[2]) * ax[2]; if (t < lo) { lo = t; il = i; } if (t > hi) { hi = t; ih = i; } }
  const A: V3 = [v[il * 3], v[il * 3 + 1], v[il * 3 + 2]], B: V3 = [v[ih * 3], v[ih * 3 + 1], v[ih * 3 + 2]];
  const out = (p: V3): V3 => { const d = new THREE.Vector3(p[0] - c[0], p[1] - c[1], p[2] - c[2]).normalize(); return [d.x, d.y, d.z]; };
  const path = traceCentreline(bvh, m, A, B, out(A));
  return path;
}

/** Centre line of a whole elongated model: the mean of the vertices in thin slabs along its main axis. */
export function mainAxisPath(m: IndexedMesh, slabs = 40): V3[] {
  const v = m.vertices, n = v.length / 3;
  const c = [0, 0, 0];
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) c[k] += v[i * 3 + k] / n;
  const ax = localAxis(m, [c[0], c[1], c[2]], 1e9);
  const proj = (i: number) => (v[i * 3] - c[0]) * ax[0] + (v[i * 3 + 1] - c[1]) * ax[1] + (v[i * 3 + 2] - c[2]) * ax[2];
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < n; i++) { const t = proj(i); if (t < lo) lo = t; if (t > hi) hi = t; }
  const sums = Array.from({ length: slabs }, () => [0, 0, 0, 0]);
  for (let i = 0; i < n; i++) {
    const k = Math.min(slabs - 1, Math.floor(((proj(i) - lo) / Math.max(1e-6, hi - lo)) * slabs));
    sums[k][0] += v[i * 3]; sums[k][1] += v[i * 3 + 1]; sums[k][2] += v[i * 3 + 2]; sums[k][3]++;
  }
  const path = sums.filter((s) => s[3] > 0).map((s) => [s[0] / s[3], s[1] / s[3], s[2] / s[3]] as V3);
  // the ends of a slab path sit inside the tips: extend to the model's extremes
  return path;
}

/** Turn a mesh by quarter turns about x, y and z (in that order). */
export const rotateQuarters = (m: IndexedMesh, q: [number, number, number]): IndexedMesh => {
  if (!q[0] && !q[1] && !q[2]) return m;
  const v = new Float32Array(m.vertices.length);
  const cs = (n: number) => { const a = (n * Math.PI) / 2; return [Math.round(Math.cos(a)), Math.round(Math.sin(a))]; };
  const [cx, sx] = cs(q[0]), [cy, sy] = cs(q[1]), [cz, sz] = cs(q[2]);
  for (let i = 0; i < v.length; i += 3) {
    let x = m.vertices[i], y = m.vertices[i + 1], z = m.vertices[i + 2], t;
    t = y * cx - z * sx; z = y * sx + z * cx; y = t;
    t = z * cy - x * sy; x = z * sy + x * cy; z = t;
    t = x * cz - y * sz; y = x * sz + y * cz; x = t;
    v[i] = x; v[i + 1] = y; v[i + 2] = z;
  }
  return { vertices: v, indices: m.indices };
};

export interface BedFit { size: V3; fits: boolean; /** footprint rotation (°) that fits best, and the uniform scale still needed (1 = none) */ angle: number; scale: number; margin: number }

/** Does a model fit the bed, trying turns of the footprint? Plates keep a margin. */
export function fitToBed(m: IndexedMesh, bed: { x: number; y: number; z: number }, margin = 4): BedFit {
  const b = bounds(m), size: V3 = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
  let best = { angle: 0, scale: Infinity };
  const v = m.vertices;
  for (let deg = 0; deg < 180; deg += 5) {
    const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < v.length; i += 3) { const x = v[i] * c - v[i + 1] * s, y = v[i] * s + v[i + 1] * c; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    const sc = Math.min((bed.x - 2 * margin) / (x1 - x0), (bed.y - 2 * margin) / (y1 - y0), bed.z / Math.max(1e-6, size[2]));
    if (best.scale === Infinity || sc > best.scale) best = { angle: deg, scale: sc };
  }
  return { size, fits: best.scale >= 1, angle: best.angle, scale: Math.min(1, best.scale), margin };
}
