// Exact ray casts against a triangle mesh through a uniform grid of triangle lists (3D DDA walk).
// Used for wall thickness along the inward normal, top-surface height maps and surface projection.
import type { MeshLike } from './sdf';
import { meshBoundsOf } from './sdf';

export interface Hit { t: number; tri: number }

export class TriGrid {
  private cells: Map<number, number[]> = new Map();
  readonly min: number[];
  readonly max: number[];
  readonly cell: number;
  private readonly n: [number, number, number];
  private stamp: Uint32Array;
  private tick = 0;

  constructor(readonly mesh: MeshLike, cellsAlongLongest = 48) {
    const b = meshBoundsOf(mesh);
    const pad = 1e-3;
    this.min = b.min.map((v) => v - pad);
    this.max = b.max.map((v) => v + pad);
    const size = Math.max(this.max[0] - this.min[0], this.max[1] - this.min[1], this.max[2] - this.min[2]);
    this.cell = Math.max(size / cellsAlongLongest, 1e-3);
    this.n = [0, 1, 2].map((k) => Math.max(1, Math.ceil((this.max[k] - this.min[k]) / this.cell))) as [number, number, number];
    const v = mesh.vertices, ix = mesh.indices;
    this.stamp = new Uint32Array(ix.length / 3);
    for (let t = 0; t < ix.length / 3; t++) {
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) {
        const a = v[ix[t * 3 + c] * 3 + k];
        if (a < lo[k]) lo[k] = a;
        if (a > hi[k]) hi[k] = a;
      }
      const c0 = lo.map((a, k) => this.clampCell(Math.floor((a - this.min[k]) / this.cell), k));
      const c1 = hi.map((a, k) => this.clampCell(Math.floor((a - this.min[k]) / this.cell), k));
      for (let z = c0[2]; z <= c1[2]; z++) for (let y = c0[1]; y <= c1[1]; y++) for (let x = c0[0]; x <= c1[0]; x++) {
        const key = x + this.n[0] * (y + this.n[1] * z);
        const l = this.cells.get(key);
        if (l) l.push(t); else this.cells.set(key, [t]);
      }
    }
  }

  private clampCell(c: number, k: number) { return c < 0 ? 0 : c >= this.n[k] ? this.n[k] - 1 : c; }

  /** Möller–Trumbore: distance along the ray to triangle t, or -1. Both faces count. */
  private hitTri(t: number, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): number {
    const v = this.mesh.vertices, ix = this.mesh.indices;
    const a = ix[t * 3] * 3, b = ix[t * 3 + 1] * 3, c = ix[t * 3 + 2] * 3;
    const e1x = v[b] - v[a], e1y = v[b + 1] - v[a + 1], e1z = v[b + 2] - v[a + 2];
    const e2x = v[c] - v[a], e2y = v[c + 1] - v[a + 1], e2z = v[c + 2] - v[a + 2];
    const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(det) < 1e-12) return -1;
    const inv = 1 / det;
    const tx = ox - v[a], ty = oy - v[a + 1], tz = oz - v[a + 2];
    const u = (tx * px + ty * py + tz * pz) * inv;
    if (u < -1e-9 || u > 1 + 1e-9) return -1;
    const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
    const w = (dx * qx + dy * qy + dz * qz) * inv;
    if (w < -1e-9 || u + w > 1 + 1e-9) return -1;
    return (e2x * qx + e2y * qy + e2z * qz) * inv;
  }

  /** Nearest hit with t in (tMin, tMax), optionally skipping one triangle (the one the ray starts on). */
  cast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, tMin = 1e-6, tMax = Infinity, skip = -1): Hit | null {
    // clip the ray to the grid box
    let t0 = tMin, t1 = tMax;
    const o = [ox, oy, oz], d = [dx, dy, dz];
    for (let k = 0; k < 3; k++) {
      if (Math.abs(d[k]) < 1e-15) { if (o[k] < this.min[k] || o[k] > this.max[k]) return null; continue; }
      let a = (this.min[k] - o[k]) / d[k], b = (this.max[k] - o[k]) / d[k];
      if (a > b) [a, b] = [b, a];
      t0 = Math.max(t0, a); t1 = Math.min(t1, b);
      if (t0 > t1) return null;
    }
    if (++this.tick === 0xffffffff) { this.stamp.fill(0); this.tick = 1; }
    const p = [ox + dx * t0, oy + dy * t0, oz + dz * t0];
    const c = p.map((a, k) => this.clampCell(Math.floor((a - this.min[k]) / this.cell), k));
    const step = d.map((a) => (a > 0 ? 1 : a < 0 ? -1 : 0));
    const tNext = d.map((a, k) => (a > 0 ? (this.min[k] + (c[k] + 1) * this.cell - o[k]) / a : a < 0 ? (this.min[k] + c[k] * this.cell - o[k]) / a : Infinity));
    const tDelta = d.map((a) => (a !== 0 ? this.cell / Math.abs(a) : Infinity));
    let best: Hit | null = null;
    for (let guard = 0; guard < 4 * (this.n[0] + this.n[1] + this.n[2]) + 8; guard++) {
      const l = this.cells.get(c[0] + this.n[0] * (c[1] + this.n[1] * c[2]));
      if (l) for (const t of l) {
        if (t === skip || this.stamp[t] === this.tick) continue;
        this.stamp[t] = this.tick;
        const h = this.hitTri(t, ox, oy, oz, dx, dy, dz);
        if (h > tMin && h < tMax && (!best || h < best.t)) best = { t: h, tri: t };
      }
      // the nearest hit so far lies before the next cell boundary: done
      const tn = Math.min(tNext[0], tNext[1], tNext[2]);
      if (best && best.t <= tn) return best;
      if (tn > t1) break;
      const k = tNext[0] <= tNext[1] && tNext[0] <= tNext[2] ? 0 : tNext[1] <= tNext[2] ? 1 : 2;
      c[k] += step[k];
      if (c[k] < 0 || c[k] >= this.n[k]) break;
      tNext[k] += tDelta[k];
    }
    return best;
  }

  /** Highest surface point directly above-or-below (x, y): the top of the part there, or -Infinity. */
  topAt(x: number, y: number): number {
    const h = this.cast(x, y, this.max[2] + 1, 0, 0, -1);
    return h ? this.max[2] + 1 - h.t : -Infinity;
  }
}
