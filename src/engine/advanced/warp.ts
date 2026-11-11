// Curved layers by deform–slice–undeform: a displacement field d(x, y, z′) maps the flat layers of
// the warped space onto curved layers in real space, z = z′ + d. Meshes are warped into z′, sliced
// with the ordinary planar slicer, and every move is mapped back here (flow scaled by ∂z/∂z′).
import type { LayerOps, Op } from './classic/gcode';
import type { Warp } from './session';
import type { TechId } from './types';
import { rescaleE } from './runs';

/** First layers stay flat on the bed: the warp is zero up to FLAT and fades in over RAMP above it. */
export const FLAT = 0.45, RAMP = 1.2;
const bedFade = (zw: number) => { const t = (zw - FLAT) / RAMP; return t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t); };

/** Displacement sampled on a regular grid: (nx × ny) columns, nz levels of z′ from 0 with spacing hz. */
export class DisplacementField implements Warp {
  readonly d: Float32Array;
  /** Nodes where the layers run through material (where the limits apply), if known. */
  material?: Uint8Array;
  constructor(
    readonly nx: number, readonly ny: number, readonly nz: number,
    readonly ox: number, readonly oy: number, readonly h: number, readonly hz: number,
    readonly source: TechId, d?: Float32Array,
  ) {
    this.d = d ?? new Float32Array(nx * ny * nz);
  }
  idx(i: number, j: number, k: number) { return i + this.nx * (j + this.ny * k); }
  inside(x: number, y: number) {
    const fx = (x - this.ox) / this.h, fy = (y - this.oy) / this.h;
    return fx >= 0 && fy >= 0 && fx <= this.nx - 1 && fy <= this.ny - 1;
  }
  private at(i: number, j: number, k: number) {
    if (i < 0 || j < 0 || i >= this.nx || j >= this.ny) return 0;
    k = k < 0 ? 0 : k >= this.nz ? this.nz - 1 : k;
    return this.d[i + this.nx * (j + this.ny * k)];
  }
  dz(x: number, y: number, zw: number): number {
    const fade = bedFade(zw);
    return fade ? fade * this.raw(x, y, zw) : 0;
  }
  private raw(x: number, y: number, zw: number): number {
    const fx = (x - this.ox) / this.h, fy = (y - this.oy) / this.h, fz = zw / this.hz;
    if (fx < -1 || fy < -1 || fx > this.nx || fy > this.ny || zw <= 0) return 0;
    const i = Math.floor(fx), j = Math.floor(fy), k = Math.floor(fz);
    const tx = fx - i, ty = fy - j, tz = Math.min(1, Math.max(0, fz - k));
    const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
    const c00 = lerp(this.at(i, j, k), this.at(i + 1, j, k), tx), c10 = lerp(this.at(i, j + 1, k), this.at(i + 1, j + 1, k), tx);
    const c01 = lerp(this.at(i, j, k + 1), this.at(i + 1, j, k + 1), tx), c11 = lerp(this.at(i, j + 1, k + 1), this.at(i + 1, j + 1, k + 1), tx);
    return lerp(lerp(c00, c10, ty), lerp(c01, c11, ty), tz);
  }
  ratio(x: number, y: number, zw: number): number {
    const e = this.hz * 0.5;
    return 1 + (this.dz(x, y, zw + e) - this.dz(x, y, Math.max(0, zw - e))) / (zw - e < 0 ? zw + e : 2 * e);
  }
  toWarped(x: number, y: number, z: number): number {
    if (!this.inside(x, y) && !this.dz(x, y, z)) return z;
    // f(z′) = z′ + d(z′) is increasing (layer ratio > 0): bisection
    let lo = z - 60, hi = z + 60;
    lo = Math.max(lo, 0);
    if (z <= 0) return z;
    for (let it = 0; it < 48; it++) {
      const m = (lo + hi) / 2;
      if (m + this.dz(x, y, m) < z) lo = m; else hi = m;
    }
    return (lo + hi) / 2;
  }
  /** Largest slope |∇xy d| and layer ratio range over the field (sampled at grid nodes; only where `mask` is set). */
  stats(mask?: Uint8Array): { maxSlope: number; minRatio: number; maxRatio: number; maxAbs: number } {
    let maxSlope = 0, minRatio = Infinity, maxRatio = -Infinity, maxAbs = 0;
    const val = (i: number, j: number, k: number) => this.at(i, j, k) * bedFade(k * this.hz);
    for (let k = 0; k < this.nz; k++) for (let j = 0; j < this.ny; j++) for (let i = 0; i < this.nx; i++) {
      if (mask && !mask[this.idx(i, j, k)]) continue;
      const v = val(i, j, k);
      maxAbs = Math.max(maxAbs, Math.abs(v));
      if (i < this.nx - 1 && j < this.ny - 1) {
        // steepest of the axis and diagonal directions (forward differences would read a cone's apex as √2 too steep)
        const gx = Math.abs(val(i + 1, j, k) - v), gy = Math.abs(val(i, j + 1, k) - v);
        const g1 = Math.abs(val(i + 1, j + 1, k) - v) / Math.SQRT2, g2 = Math.abs(val(i + 1, j, k) - val(i, j + 1, k)) / Math.SQRT2;
        // a smooth plane reads at worst cos 22.5° low: divide it back in
        maxSlope = Math.max(maxSlope, Math.max(gx, gy, g1, g2) / this.h / 0.924);
      }
      if (k < this.nz - 1) {
        const r = 1 + (val(i, j, k + 1) - v) / this.hz;
        minRatio = Math.min(minRatio, r); maxRatio = Math.max(maxRatio, r);
      }
    }
    return { maxSlope, minRatio: Number.isFinite(minRatio) ? minRatio : 1, maxRatio: Number.isFinite(maxRatio) ? maxRatio : 1, maxAbs };
  }
  scaled(s: number): DisplacementField {
    const f = new DisplacementField(this.nx, this.ny, this.nz, this.ox, this.oy, this.h, this.hz, this.source, this.d.map((v) => v * s));
    f.material = this.material;
    return f;
  }
}

/** Several objects, each with its own field (fields do not overlap in XY). */
export class CompositeWarp implements Warp {
  constructor(readonly parts: Warp[], readonly source: TechId) {}
  private pick(x: number, y: number) { return this.parts.find((p) => !(p instanceof DisplacementField) || p.inside(x, y)); }
  dz(x: number, y: number, zw: number) { return this.pick(x, y)?.dz(x, y, zw) ?? 0; }
  ratio(x: number, y: number, zw: number) { return this.pick(x, y)?.ratio(x, y, zw) ?? 1; }
  toWarped(x: number, y: number, z: number) { return this.pick(x, y)?.toWarped(x, y, z) ?? z; }
}

/** Sum of two warps in warped space (the second refines the first). */
export class SumWarp implements Warp {
  constructor(readonly a: Warp, readonly b: Warp, readonly source: TechId) {}
  dz(x: number, y: number, zw: number) { return this.a.dz(x, y, zw) + this.b.dz(x, y, zw); }
  ratio(x: number, y: number, zw: number) { return this.a.ratio(x, y, zw) + this.b.ratio(x, y, zw) - 1; }
  toWarped(x: number, y: number, z: number) {
    if (z <= 0) return z;
    let lo = Math.max(0, z - 60), hi = z + 60;
    for (let it = 0; it < 48; it++) { const m = (lo + hi) / 2; if (m + this.dz(x, y, m) < z) lo = m; else hi = m; }
    return (lo + hi) / 2;
  }
}

/**
 * Map every move from warped space back to real space. Moves are split adaptively, only where the
 * curved layer bends away from the straight chord by more than `tol`, so planar regions keep their
 * long moves; extrusion is scaled by the local layer-thickness ratio. Returns the non-planar move count.
 */
export function unwarpLayers(layers: LayerOps[], w: Warp, tol = 0.01, minSeg = 0.3, maxSlopeDeg = 90): number {
  let curved = 0;
  const tanMax = Math.tan((Math.min(maxSlopeDeg, 89) * Math.PI) / 180) * 0.95;
  for (const L of layers) {
    const out: Op[] = [];
    let px = NaN, py = NaN, pz = NaN, pdz = 0;
    // last emitted point in real space: each piece's E follows its true 3-D length there
    let qx = NaN, qy = NaN, qz = NaN;
    for (const op of L.ops) {
      if (op.k === 'raw' && op.resetPos) { px = NaN; py = NaN; pz = NaN; qx = NaN; }
      if (op.k !== 'move') { out.push(op); continue; }
      const dz1 = w.dz(op.x, op.y, op.z);
      const emitTo = (x: number, y: number, zw: number, dz: number, share: number) => {
        const r = op.travel || op.feature === 'bridge' ? 1 : Math.max(0.05, w.ratio(x, y, zw)); // a bridge strand is round: layer stretch does not thicken it
        if (Math.abs(dz) > 1e-4) curved++;
        let zr = +(zw + dz).toFixed(4);
        // a short piece never climbs or dives faster than the machine's head-clearance slope, whatever the warp does between its ends
        if (!op.travel && op.e > 0 && !Number.isNaN(qx) && maxSlopeDeg < 90) {
          const lim = tanMax * Math.hypot(x - qx, y - qy);
          zr = +Math.max(qz - lim, Math.min(qz + lim, zr)).toFixed(4);
        }
        // volume conserved: the piece is as long as it is in real space (warping stretches it) and its bead is r x as thick
        let e = op.e * share * r;
        if (!op.travel && !Number.isNaN(qx) && !Number.isNaN(px) && op.e > 0) {
          const opLen = Math.max(Math.hypot(op.x - px, op.y - py, op.z - pz), 1e-9);
          e = rescaleE((op.e * Math.hypot(x - qx, y - qy, zr - qz)) / opLen, op.w, op.h, op.h * r);
        }
        // a bead piece shorter than 5 µm in XY is a duplicate point of the path (rounding), not a move
        if (!op.travel && op.e > 0 && !Number.isNaN(qx) && Math.hypot(x - qx, y - qy) < 0.005) return;
        qx = x; qy = y; qz = zr;
        out.push({ ...op, x, y, z: zr, e, h: op.h * r, ...(Math.abs(dz) > 1e-4 ? { noArc: true } : {}) });
      };
      if (Number.isNaN(px) || op.fixed) { emitTo(op.x, op.y, op.z, dz1, 1); }
      else {
        const len = Math.hypot(op.x - px, op.y - py);
        // recursive midpoint test of the warp along the move
        const seg = (t0: number, d0: number, t1: number, d1: number, depth: number) => {
          const tm = (t0 + t1) / 2;
          const xm = px + (op.x - px) * tm, ym = py + (op.y - py) * tm, zm = pz + (op.z - pz) * tm;
          const dm = w.dz(xm, ym, zm);
          if (depth < 7 && (t1 - t0) * len > minSeg && Math.abs(dm - (d0 + d1) / 2) > tol) {
            seg(t0, d0, tm, dm, depth + 1);
            seg(tm, dm, t1, d1, depth + 1);
          } else emitTo(px + (op.x - px) * t1, py + (op.y - py) * t1, pz + (op.z - pz) * t1, d1, t1 - t0);
        };
        seg(0, pdz, 1, dz1, 0);
      }
      px = op.x; py = op.y; pz = op.z; pdz = dz1;
    }
    L.ops = out;
  }
  return curved;
}
