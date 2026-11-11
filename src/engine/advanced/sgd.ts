// Differentiable SGD slicing (#14). Layer surfaces are z = z′ + d(x, y, z′); d is a tensor-product
// cubic B-spline whose control points Θ minimise
//   L(Θ) = w₁ L_overhang + w₂ L_collision + w₃ L_anisotropy + w₄ L_error
// with Adam on stochastic mini-batches of surface and volume samples. Every term depends on Θ only
// through d's first derivatives, which are linear in Θ, so gradients are exact.
import type { PartAnalysis } from './analysis';
import { rng, smoothstep } from './grid';
import { zoneIndex } from './types';
import type { Warp } from './session';
import { DisplacementField } from './warp';

export interface SgdOptions {
  w1: number; w2: number; w3: number; w4: number;
  iters: number; ctrl: number;
  maxSlopeDeg: number; overhangDeg: number;
  minRatio: number; maxRatio: number;
  lr?: number; batch?: number; seed?: number;
}

/** Uniform cubic B-spline weights (and derivatives per unit parameter) at local t. */
function bs(t: number): [number[], number[]] {
  const it = 1 - t;
  return [
    [it * it * it / 6, (3 * t * t * t - 6 * t * t + 4) / 6, (-3 * t * t * t + 3 * t * t + 3 * t + 1) / 6, t * t * t / 6],
    [-it * it / 2, (3 * t * t - 4 * t) / 2, (-3 * t * t + 2 * t + 1) / 2, t * t / 2],
  ];
}

export class BSplineField {
  readonly theta: Float64Array;
  constructor(readonly n: [number, number, number], readonly lo: [number, number, number], readonly hi: [number, number, number], readonly ramp: number) {
    this.theta = new Float64Array(n[0] * n[1] * n[2]);
  }
  /** Parameter span, local t and du/dx for one axis. */
  private span(a: number, v: number): [number, number, number] {
    const segs = this.n[a] - 3;
    const u = Math.max(0, Math.min(segs - 1e-9, ((v - this.lo[a]) / (this.hi[a] - this.lo[a])) * segs));
    const s = Math.floor(u);
    return [s, u - s, segs / (this.hi[a] - this.lo[a])];
  }
  /**
   * Value and derivatives (d, ∂x, ∂y, ∂z′) at a point; with `grad`, also the 64 control indices and
   * the weights of each output with respect to them.
   */
  eval(x: number, y: number, z: number, grad?: { idx: number[]; w: number[][] }): [number, number, number, number] {
    const [sx, tx, kx] = this.span(0, x), [sy, ty, ky] = this.span(1, y), [sz, tz, kz] = this.span(2, z);
    const [bx, dbx] = bs(tx), [by, dby] = bs(ty), [bz, dbz] = bs(tz);
    const r = smoothstep(z / this.ramp), dr = z > 0 && z < this.ramp ? (6 * (z / this.ramp) * (1 - z / this.ramp)) / this.ramp : 0;
    let S = 0, Sx = 0, Sy = 0, Sz = 0;
    if (grad) { grad.idx.length = 0; grad.w = [[], [], [], []]; }
    for (let c = 0; c < 4; c++) for (let b = 0; b < 4; b++) for (let a = 0; a < 4; a++) {
      const q = (sx + a) + this.n[0] * ((sy + b) + this.n[1] * (sz + c));
      const w = bx[a] * by[b] * bz[c], wx = dbx[a] * kx * by[b] * bz[c], wy = bx[a] * dby[b] * ky * bz[c], wz = bx[a] * by[b] * dbz[c] * kz;
      const th = this.theta[q];
      S += w * th; Sx += wx * th; Sy += wy * th; Sz += wz * th;
      if (grad) { grad.idx.push(q); grad.w[0].push(r * w); grad.w[1].push(r * wx); grad.w[2].push(r * wy); grad.w[3].push(dr * w + r * wz); }
    }
    return [r * S, r * Sx, r * Sy, dr * S + r * Sz];
  }
}

interface Sample { x: number; y: number; z: number; nx: number; ny: number; nz: number; wt: number }

export interface SgdResult { field: DisplacementField; loss0: number; loss: number; overhang0: number; overhang: number; iterations: number }

/** Optimise a layer deformation for one part. `base` is an existing warp (e.g. the dome field) to refine. */
export function optimiseLayers(a: PartAnalysis, o: SgdOptions, base?: Warp): SgdResult | null {
  const s = a.surf, g = a.sdf.sdf;
  const rand = rng(o.seed ?? 7);
  const cosT = Math.cos((o.overhangDeg * Math.PI) / 180), tanMax = Math.tan((o.maxSlopeDeg * Math.PI) / 180);
  const over: Sample[] = [], top: Sample[] = [];
  for (let t = 0; t < s.triCount; t++) {
    const smp = { x: s.centroid[t * 3], y: s.centroid[t * 3 + 1], z: s.centroid[t * 3 + 2], nx: s.normal[t * 3], ny: s.normal[t * 3 + 1], nz: s.normal[t * 3 + 2], wt: s.area[t] };
    if (a.triZone[t] === zoneIndex('overhang')) over.push(smp);
    else if (a.triZone[t] === zoneIndex('dome') || a.triZone[t] === zoneIndex('shallow')) top.push(smp);
  }
  if (!over.length) return null;
  const vol: Sample[] = [];
  for (let p = 0; p < g.n; p += 3) if (a.sdf.inside[p]) {
    const k = Math.floor(p / (g.nx * g.ny)), j = Math.floor(p / g.nx) % g.ny, i = p % g.nx;
    vol.push({ x: g.x(i), y: g.y(j), z: g.z(k), nx: 0, ny: 0, nz: 0, wt: 1 });
  }
  const pad = g.h * 2;
  const H = a.sdf.max[2];
  const nc = Math.max(4, Math.round(o.ctrl));
  const f = new BSplineField([nc, nc, Math.max(4, Math.round(nc / 2))], [a.sdf.min[0] - pad, a.sdf.min[1] - pad, 0], [a.sdf.max[0] + pad, a.sdf.max[1] + pad, H + pad], Math.min(2, H / 4));
  const baseD = (x: number, y: number, z: number) => {
    if (!base) return [0, 0, 0, 0];
    const e = g.h * 0.5;
    return [base.dz(x, y, z), (base.dz(x + e, y, z) - base.dz(x - e, y, z)) / (2 * e), (base.dz(x, y + e, z) - base.dz(x, y - e, z)) / (2 * e), (base.dz(x, y, z + e) - base.dz(x, y, Math.max(0, z - e))) / (2 * e)];
  };
  // warped coordinate of each sample under the base warp (fixed during optimisation)
  for (const arr of [over, top, vol]) for (const q of arr) q.z = base ? base.toWarped(q.x, q.y, q.z) : q.z;
  const bOver = over.map((q) => baseD(q.x, q.y, q.z)), bTop = top.map((q) => baseD(q.x, q.y, q.z)), bVol = vol.map((q) => baseD(q.x, q.y, q.z));
  const totalW = (arr: Sample[]) => arr.reduce((t, q) => t + q.wt, 0) || 1;
  const Wover = totalW(over), Wtop = totalW(top);

  // a flat underside is a saddle of the loss (zero gradient at zero tilt): start from a tiny random field
  for (let q = 0; q < f.theta.length; q++) f.theta[q] = (rand() - 0.5) * 0.05;
  const grad = new Float64Array(f.theta.length);
  const m1 = new Float64Array(f.theta.length), m2 = new Float64Array(f.theta.length);
  const lr = o.lr ?? 0.04, B = o.batch ?? 96, b1 = 0.9, b2 = 0.999;
  const gl = { idx: [] as number[], w: [[], [], [], []] as number[][] };
  /** Loss of one sample set (and its gradient into `grad` when acc). */
  const terms = (acc: boolean, full: boolean) => {
    let lo = 0, lc = 0, la = 0, le = 0;
    const pick = (arr: Sample[]) => (full || arr.length <= B ? arr.map((_, i) => i) : Array.from({ length: B }, () => Math.floor(rand() * arr.length)));
    const scaleOf = (arr: Sample[], idx: number[]) => (full || arr.length <= B ? 1 : arr.length / idx.length);
    // overhang: down-facing area whose angle to the (tilted) layer is below the support threshold
    const io = pick(over), so = scaleOf(over, io);
    for (const i of io) {
      const q = over[i];
      const [, dx, dy] = f.eval(q.x, q.y, q.z, acc ? gl : undefined);
      const gx = dx + bOver[i][1], gy = dy + bOver[i][2];
      const L = Math.hypot(gx, gy, 1);
      const c = -(q.nx * -gx + q.ny * -gy + q.nz) / L; // −n·ℓ̂, ℓ = (−∂x d, −∂y d, 1)
      const v = c - cosT;
      if (v <= 0) continue;
      const wq = (q.wt / Wover) * so;
      lo += wq * v * v;
      if (acc) {
        // ∂c/∂gx, ∂c/∂gy
        const num = q.nx * gx + q.ny * gy - q.nz;
        const dcdgx = q.nx / L - (num * gx) / (L * L * L), dcdgy = q.ny / L - (num * gy) / (L * L * L);
        const k = o.w1 * 2 * wq * v;
        for (let e = 0; e < gl.idx.length; e++) grad[gl.idx[e]] += k * (dcdgx * gl.w[1][e] + dcdgy * gl.w[2][e]);
      }
    }
    // collision (head clearance) and layer-thickness error on volume samples
    const iv = pick(vol), sv = 1 / Math.max(1, iv.length);
    for (const i of iv) {
      const q = vol[i];
      const [, dx, dy, dzz] = f.eval(q.x, q.y, q.z, acc ? gl : undefined);
      const gx = dx + bVol[i][1], gy = dy + bVol[i][2], gz = dzz + bVol[i][3];
      const sl = Math.hypot(gx, gy);
      if (sl > tanMax) {
        const v = sl - tanMax;
        lc += sv * v * v;
        if (acc) { const k = (o.w2 * 2 * sv * v) / sl; for (let e = 0; e < gl.idx.length; e++) grad[gl.idx[e]] += k * (gx * gl.w[1][e] + gy * gl.w[2][e]); }
      }
      const r = 1 + gz;
      const v = r < o.minRatio ? r - o.minRatio : r > o.maxRatio ? r - o.maxRatio : 0;
      if (v) {
        le += sv * v * v;
        if (acc) { const k = o.w4 * 2 * sv * v; for (let e = 0; e < gl.idx.length; e++) grad[gl.idx[e]] += k * gl.w[3][e]; }
      }
    }
    // anisotropy: layers should lie parallel to the up-facing skin (beads follow the surface)
    const it = pick(top), st = scaleOf(top, it);
    for (const i of it) {
      const q = top[i];
      const [, dx, dy] = f.eval(q.x, q.y, q.z, acc ? gl : undefined);
      const gx = dx + bTop[i][1], gy = dy + bTop[i][2];
      const L = Math.hypot(gx, gy, 1);
      const c = (q.nx * -gx + q.ny * -gy + q.nz) / L;
      const wq = (q.wt / Wtop) * st;
      la += wq * (1 - c);
      if (acc) {
        const num = -(q.nx * gx + q.ny * gy) + q.nz;
        const dcdgx = -q.nx / L - (num * gx) / (L * L * L), dcdgy = -q.ny / L - (num * gy) / (L * L * L);
        const k = -o.w3 * wq;
        for (let e = 0; e < gl.idx.length; e++) grad[gl.idx[e]] += k * (dcdgx * gl.w[1][e] + dcdgy * gl.w[2][e]);
      }
    }
    // small ridge regulariser keeps Θ bounded where no sample constrains it
    let reg = 0;
    for (let q = 0; q < f.theta.length; q++) { reg += f.theta[q] * f.theta[q]; if (acc) grad[q] += 2e-4 * f.theta[q]; }
    return { total: o.w1 * lo + o.w2 * lc + o.w3 * la + o.w4 * le + 1e-4 * reg, lo };
  };
  const start = terms(false, true);
  let iter = 0;
  for (; iter < o.iters; iter++) {
    grad.fill(0);
    terms(true, false);
    for (let q = 0; q < grad.length; q++) {
      m1[q] = b1 * m1[q] + (1 - b1) * grad[q];
      m2[q] = b2 * m2[q] + (1 - b2) * grad[q] * grad[q];
      const mh = m1[q] / (1 - b1 ** (iter + 1)), vh = m2[q] / (1 - b2 ** (iter + 1));
      f.theta[q] -= (lr * mh) / (Math.sqrt(vh) + 1e-8);
    }
  }
  const end = terms(false, true);
  // sample the optimised spline on the analysis grid
  const hz = g.h, nzw = Math.ceil((H + 2 * hz) / hz) + 1;
  const field = new DisplacementField(g.nx, g.ny, nzw, g.ox, g.oy, g.h, hz, 'sgd_slicing');
  for (let k = 0; k < nzw; k++) for (let j = 0; j < g.ny; j++) for (let i = 0; i < g.nx; i++) field.d[field.idx(i, j, k)] = f.eval(g.x(i), g.y(j), k * hz)[0];
  return { field, loss0: start.total, loss: end.total, overhang0: start.lo, overhang: end.lo, iterations: iter };
}
