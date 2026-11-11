// Surface fields on the triangle mesh: normals, slope, discrete curvature (cotangent mean curvature,
// angle-deficit Gaussian curvature) and local wall thickness along the inward normal.
import type { MeshLike } from './sdf';
import { TriGrid } from './raycast';

export interface SurfaceFields {
  triCount: number;
  /** Unit normal per triangle (xyz). */
  normal: Float32Array;
  centroid: Float32Array;
  area: Float32Array;
  /** Angle from straight up, degrees (0 = facing up, 90 = vertical wall, 180 = facing down). */
  slope: Float32Array;
  /** Signed mean curvature per triangle (1/mm, positive = convex). */
  meanCurv: Float32Array;
  /** Gaussian curvature per triangle (1/mm²). */
  gaussCurv: Float32Array;
  /** Wall thickness through the part along the inward normal (mm). */
  thickness: Float32Array;
  /** Per-vertex signed mean curvature and normal (for smooth sampling). */
  vertexH: Float32Array;
  vertexN: Float32Array;
  grid: TriGrid;
}

export function surfaceFields(m: MeshLike, maxThickness = 1e3): SurfaceFields {
  const v = m.vertices, ix = m.indices;
  const T = ix.length / 3, V = v.length / 3;
  const normal = new Float32Array(T * 3), centroid = new Float32Array(T * 3), area = new Float32Array(T), slope = new Float32Array(T);
  const vArea = new Float64Array(V), vAngle = new Float64Array(V), vN = new Float64Array(V * 3), lap = new Float64Array(V * 3);
  for (let t = 0; t < T; t++) {
    const ia = ix[t * 3], ib = ix[t * 3 + 1], ic = ix[t * 3 + 2];
    const ax = v[ia * 3], ay = v[ia * 3 + 1], az = v[ia * 3 + 2];
    const bx = v[ib * 3], by = v[ib * 3 + 1], bz = v[ib * 3 + 2];
    const cx = v[ic * 3], cy = v[ic * 3 + 1], cz = v[ic * 3 + 2];
    const ux = bx - ax, uy = by - ay, uz = bz - az, wx = cx - ax, wy = cy - ay, wz = cz - az;
    let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    const len = Math.hypot(nx, ny, nz);
    const A = len / 2;
    area[t] = A;
    if (len > 0) { nx /= len; ny /= len; nz /= len; }
    normal[t * 3] = nx; normal[t * 3 + 1] = ny; normal[t * 3 + 2] = nz;
    centroid[t * 3] = (ax + bx + cx) / 3; centroid[t * 3 + 1] = (ay + by + cy) / 3; centroid[t * 3 + 2] = (az + bz + cz) / 3;
    slope[t] = (Math.acos(Math.max(-1, Math.min(1, nz))) * 180) / Math.PI;
    // corner angles and cotangent weights of the opposite edges
    const P = [[ax, ay, az], [bx, by, bz], [cx, cy, cz]], I = [ia, ib, ic];
    for (let k = 0; k < 3; k++) {
      const p = P[k], q = P[(k + 1) % 3], r = P[(k + 2) % 3];
      const e1 = [q[0] - p[0], q[1] - p[1], q[2] - p[2]], e2 = [r[0] - p[0], r[1] - p[1], r[2] - p[2]];
      const dot = e1[0] * e2[0] + e1[1] * e2[1] + e1[2] * e2[2];
      const cr = Math.hypot(e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]);
      const ang = Math.atan2(cr, dot);
      vAngle[I[k]] += ang;
      vArea[I[k]] += A / 3;
      vN[I[k] * 3] += nx * A; vN[I[k] * 3 + 1] += ny * A; vN[I[k] * 3 + 2] += nz * A;
      // cot(angle at p) weighs edge q–r
      const cot = cr > 1e-12 ? dot / cr : 0;
      const qi = I[(k + 1) % 3], ri = I[(k + 2) % 3];
      for (let c = 0; c < 3; c++) {
        const d = r[c] - q[c];
        lap[qi * 3 + c] += cot * d;
        lap[ri * 3 + c] -= cot * d;
      }
    }
  }
  // boundary vertices (open meshes) get no Gaussian curvature
  const boundary = boundaryVertices(ix, V);
  const vertexH = new Float32Array(V), vertexK = new Float32Array(V), vertexN = new Float32Array(V * 3);
  for (let i = 0; i < V; i++) {
    const nl = Math.hypot(vN[i * 3], vN[i * 3 + 1], vN[i * 3 + 2]) || 1;
    const nx = vN[i * 3] / nl, ny = vN[i * 3 + 1] / nl, nz = vN[i * 3 + 2] / nl;
    vertexN[i * 3] = nx; vertexN[i * 3 + 1] = ny; vertexN[i * 3 + 2] = nz;
    const A = Math.max(vArea[i], 1e-12);
    // Laplace–Beltrami of the position = −2 H n; for an outward normal on a convex surface it points inward
    const lx = lap[i * 3] / (2 * A), ly = lap[i * 3 + 1] / (2 * A), lz = lap[i * 3 + 2] / (2 * A);
    vertexH[i] = boundary[i] ? 0 : -0.5 * (lx * nx + ly * ny + lz * nz);
    vertexK[i] = boundary[i] ? 0 : (2 * Math.PI - vAngle[i]) / A;
  }
  const meanCurv = new Float32Array(T), gaussCurv = new Float32Array(T);
  for (let t = 0; t < T; t++) {
    const a = ix[t * 3], b = ix[t * 3 + 1], c = ix[t * 3 + 2];
    meanCurv[t] = (vertexH[a] + vertexH[b] + vertexH[c]) / 3;
    gaussCurv[t] = (vertexK[a] + vertexK[b] + vertexK[c]) / 3;
  }
  const grid = new TriGrid(m);
  const thickness = new Float32Array(T);
  for (let t = 0; t < T; t++) {
    const px = centroid[t * 3], py = centroid[t * 3 + 1], pz = centroid[t * 3 + 2];
    const nx = normal[t * 3], ny = normal[t * 3 + 1], nz = normal[t * 3 + 2];
    if (!nx && !ny && !nz) { thickness[t] = 0; continue; }
    const hit = grid.cast(px, py, pz, -nx, -ny, -nz, 1e-5, maxThickness, t);
    thickness[t] = hit ? hit.t : maxThickness;
  }
  return { triCount: T, normal, centroid, area, slope, meanCurv, gaussCurv, thickness, vertexH, vertexN, grid };
}

/** Vertices on an open edge (edge used by one triangle). */
export function boundaryVertices(ix: Uint32Array, V: number): Uint8Array {
  const count = new Map<number, number>();
  for (let t = 0; t < ix.length; t += 3) for (let k = 0; k < 3; k++) {
    const a = ix[t + k], b = ix[t + ((k + 1) % 3)];
    const key = a < b ? a * V + b : b * V + a;
    count.set(key, (count.get(key) ?? 0) + 1);
  }
  const out = new Uint8Array(V);
  for (const [key, c] of count) if (c === 1) { out[Math.floor(key / V)] = 1; out[key % V] = 1; }
  return out;
}

/** Triangle adjacency through shared edges (−1 on open edges), three per triangle. */
export function triNeighbours(ix: Uint32Array, V: number): Int32Array {
  const T = ix.length / 3;
  const out = new Int32Array(T * 3).fill(-1);
  const edge = new Map<number, number>();
  for (let t = 0; t < T; t++) for (let k = 0; k < 3; k++) {
    const a = ix[t * 3 + k], b = ix[t * 3 + ((k + 1) % 3)];
    const key = a < b ? a * V + b : b * V + a;
    const o = edge.get(key);
    if (o === undefined) edge.set(key, t * 3 + k);
    else { out[t * 3 + k] = Math.floor(o / 3); out[o] = t; }
  }
  return out;
}
