// Mesh → signed distance field f(x, y, z) (negative inside), the implicit form every Advanced solver
// reads. Exact point–triangle distances in a narrow band around the surface, the Eikonal equation
// |∇f| = 1 solved by fast sweeping everywhere else, and the sign from ray parity along each column.
import { gridFor, Grid3 } from './grid';

export interface MeshLike { vertices: Float32Array; indices: Uint32Array }

export interface SdfField {
  sdf: Grid3;
  /** 1 inside the solid, 0 outside (cell centres). */
  inside: Uint8Array;
  min: number[];
  max: number[];
}

export function meshBoundsOf(m: MeshLike) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  const v = m.vertices;
  for (let i = 0; i < v.length; i += 3) for (let k = 0; k < 3; k++) {
    const a = v[i + k];
    if (a < min[k]) min[k] = a;
    if (a > max[k]) max[k] = a;
  }
  return { min, max };
}

/** Squared distance from p to triangle abc (Ericson, Real-Time Collision Detection §5.1.5). */
export function pointTriDist2(px: number, py: number, pz: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number): number {
  const abx = bx - ax, aby = by - ay, abz = bz - az, acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  const sq = (x: number, y: number, z: number) => x * x + y * y + z * z;
  if (d1 <= 0 && d2 <= 0) return sq(apx, apy, apz);
  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return sq(bpx, bpy, bpz);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return sq(apx - v * abx, apy - v * aby, apz - v * abz); }
  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return sq(cpx, cpy, cpz);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); return sq(apx - w * acx, apy - w * acy, apz - w * acz); }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return sq(px - (bx + w * (cx - bx)), py - (by + w * (cy - by)), pz - (bz + w * (cz - bz)));
  }
  const denom = 1 / (va + vb + vc), v = vb * denom, w = vc * denom;
  return sq(px - (ax + abx * v + acx * w), py - (ay + aby * v + acy * w), pz - (az + abz * v + acz * w));
}

/** Inside/outside of every cell centre by counting surface crossings along +Z through each column. */
export function insideMask(m: MeshLike, g: Grid3): Uint8Array {
  const out = new Uint8Array(g.n);
  const cols: number[][] = Array.from({ length: g.nx * g.ny }, () => []);
  const v = m.vertices, ix = m.indices;
  // tiny irrational offsets keep rays off shared edges and vertices
  const ex = g.h * 1.1e-4 * Math.SQRT2, ey = g.h * 0.7e-4 * Math.sqrt(3);
  for (let t = 0; t < ix.length; t += 3) {
    const a = ix[t] * 3, b = ix[t + 1] * 3, c = ix[t + 2] * 3;
    const x0 = v[a], y0 = v[a + 1], x1 = v[b], y1 = v[b + 1], x2 = v[c], y2 = v[c + 1];
    const den = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2);
    if (Math.abs(den) < 1e-14) continue; // vertical triangle: never crossed by a vertical ray
    const i0 = Math.max(0, Math.floor((Math.min(x0, x1, x2) - g.ox) / g.h)), i1 = Math.min(g.nx - 1, Math.ceil((Math.max(x0, x1, x2) - g.ox) / g.h));
    const j0 = Math.max(0, Math.floor((Math.min(y0, y1, y2) - g.oy) / g.h)), j1 = Math.min(g.ny - 1, Math.ceil((Math.max(y0, y1, y2) - g.oy) / g.h));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const px = g.x(i) + ex, py = g.y(j) + ey;
      const l0 = ((y1 - y2) * (px - x2) + (x2 - x1) * (py - y2)) / den;
      const l1 = ((y2 - y0) * (px - x2) + (x0 - x2) * (py - y2)) / den;
      const l2 = 1 - l0 - l1;
      if (l0 < 0 || l1 < 0 || l2 < 0) continue;
      cols[i + g.nx * j].push(l0 * v[a + 2] + l1 * v[b + 2] + l2 * v[c + 2]);
    }
  }
  for (let j = 0; j < g.ny; j++) for (let i = 0; i < g.nx; i++) {
    const zs = cols[i + g.nx * j];
    if (zs.length < 2) continue;
    zs.sort((p, q) => p - q);
    let c = 0;
    for (let k = 0; k < g.nz; k++) {
      const z = g.z(k);
      while (c < zs.length && zs[c] < z) c++;
      if (c % 2 === 1) out[g.idx(i, j, k)] = 1;
    }
  }
  return out;
}

/** One Godunov upwind update of |∇u| = 1/f with spacing h for the 3D Eikonal equation. */
export function eikonalUpdate(a: number, b: number, c: number, hf: number): number {
  // sort a ≤ b ≤ c
  if (a > b) [a, b] = [b, a];
  if (b > c) [b, c] = [c, b];
  if (a > b) [a, b] = [b, a];
  let x = a + hf;
  if (x <= b) return x;
  x = (a + b + Math.sqrt(Math.max(0, 2 * hf * hf - (a - b) * (a - b)))) / 2;
  if (x <= c) return x;
  const s = a + b + c;
  return (s + Math.sqrt(Math.max(0, s * s - 3 * (a * a + b * b + c * c - hf * hf)))) / 3;
}

/** Fast sweeping: fills `d` from the frozen cells outward (8 alternating sweep orders, `rounds` times). */
export function fastSweep(g: Grid3, d: Float32Array, frozen: Uint8Array, rounds = 2, speed?: Float32Array): void {
  const { nx, ny, nz, h } = g;
  const sx = nx, sxy = nx * ny;
  for (let r = 0; r < rounds; r++) {
    for (let o = 0; o < 8; o++) {
      const di = o & 1 ? -1 : 1, dj = o & 2 ? -1 : 1, dk = o & 4 ? -1 : 1;
      for (let k = dk > 0 ? 0 : nz - 1; k >= 0 && k < nz; k += dk) {
        for (let j = dj > 0 ? 0 : ny - 1; j >= 0 && j < ny; j += dj) {
          for (let i = di > 0 ? 0 : nx - 1; i >= 0 && i < nx; i += di) {
            const p = i + sx * j + sxy * k;
            if (frozen[p]) continue;
            const a = Math.min(i > 0 ? d[p - 1] : Infinity, i < nx - 1 ? d[p + 1] : Infinity);
            const b = Math.min(j > 0 ? d[p - sx] : Infinity, j < ny - 1 ? d[p + sx] : Infinity);
            const c = Math.min(k > 0 ? d[p - sxy] : Infinity, k < nz - 1 ? d[p + sxy] : Infinity);
            if (a === Infinity && b === Infinity && c === Infinity) continue;
            const hf = speed ? h / Math.max(1e-6, speed[p]) : h;
            const u = eikonalUpdate(a, b, c, hf);
            if (u < d[p]) d[p] = u;
          }
        }
      }
    }
  }
}

/**
 * Signed distance field of a closed mesh. `maxCells` voxels along the longest side (plus padding).
 * Distances are exact within ~1.5 cells of the surface and Eikonal-accurate (first order) elsewhere.
 */
export function meshSdf(m: MeshLike, maxCells = 64, minH = 0.25): SdfField {
  const { min, max } = meshBoundsOf(m);
  const g = gridFor(min, max, maxCells, 4, minH);
  const d = new Float32Array(g.n).fill(Infinity);
  const frozen = new Uint8Array(g.n);
  const v = m.vertices, ix = m.indices;
  const band = 1.6 * g.h;
  for (let t = 0; t < ix.length; t += 3) {
    const a = ix[t] * 3, b = ix[t + 1] * 3, c = ix[t + 2] * 3;
    const ax = v[a], ay = v[a + 1], az = v[a + 2], bx = v[b], by = v[b + 1], bz = v[b + 2], cx = v[c], cy = v[c + 1], cz = v[c + 2];
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx, cx) - band - g.ox) / g.h)), i1 = Math.min(g.nx - 1, Math.ceil((Math.max(ax, bx, cx) + band - g.ox) / g.h));
    const j0 = Math.max(0, Math.floor((Math.min(ay, by, cy) - band - g.oy) / g.h)), j1 = Math.min(g.ny - 1, Math.ceil((Math.max(ay, by, cy) + band - g.oy) / g.h));
    const k0 = Math.max(0, Math.floor((Math.min(az, bz, cz) - band - g.oz) / g.h)), k1 = Math.min(g.nz - 1, Math.ceil((Math.max(az, bz, cz) + band - g.oz) / g.h));
    // plane distance prunes cells far from a large triangle's plane before the exact test
    let nxp = (by - ay) * (cz - az) - (bz - az) * (cy - ay), nyp = (bz - az) * (cx - ax) - (bx - ax) * (cz - az), nzp = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const nl = Math.hypot(nxp, nyp, nzp) || 1;
    nxp /= nl; nyp /= nl; nzp /= nl;
    for (let k = k0; k <= k1; k++) {
      const pz = g.z(k);
      for (let j = j0; j <= j1; j++) {
        const py = g.y(j);
        for (let i = i0; i <= i1; i++) {
          const px = g.x(i);
          const pd = Math.abs((px - ax) * nxp + (py - ay) * nyp + (pz - az) * nzp);
          if (pd > band) continue;
          const p = g.idx(i, j, k);
          const dd = Math.sqrt(pointTriDist2(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz));
          if (dd < d[p]) d[p] = dd;
        }
      }
    }
  }
  for (let p = 0; p < g.n; p++) if (d[p] <= band) frozen[p] = 1;
  fastSweep(g, d, frozen, 2);
  const inside = insideMask(m, g);
  for (let p = 0; p < g.n; p++) {
    if (!Number.isFinite(d[p])) d[p] = g.h * Math.max(g.nx, g.ny, g.nz);
    g.data[p] = inside[p] ? -d[p] : d[p];
  }
  return { sdf: g, inside, min, max };
}
