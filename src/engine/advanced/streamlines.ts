// Evenly spaced streamlines of a 2D line (director) field (Jobard & Lefer): RK4 integration with the
// direction's sign aligned step to step (a line field has no orientation), lines stop where they come
// closer than d_test to an earlier line, and new seeds are taken d_sep to either side of every
// accepted line until the region is covered.
import type { RasterRegion } from './offsets';

/** Unit director at a point (either sign), or null where the field is undefined. */
export type Director = (x: number, y: number) => [number, number] | null;

export interface StreamOptions {
  /** Separation between neighbouring lines (mm). */
  dsep: number;
  /** Lines stop when closer than this to another line (fraction of dsep). */
  test?: number;
  /** Integration step (mm). */
  step?: number;
  /** Shortest line kept (mm). */
  minLen?: number;
  maxLines?: number;
}

/** Director field on the raster as ψ = w·e^{2iθ} per cell, sampled bilinearly (smooth across θ ≡ θ + π). */
export class PsiField {
  constructor(readonly r: RasterRegion, readonly re: Float64Array, readonly im: Float64Array) {}
  static sample(r: RasterRegion, f: (x: number, y: number) => [number, number, number] | null): PsiField {
    const n = r.nx * r.ny, re = new Float64Array(n), im = new Float64Array(n);
    for (let j = 0; j < r.ny; j++) for (let i = 0; i < r.nx; i++) {
      const p = i + r.nx * j;
      if (!r.mask[p]) continue;
      const v = f(r.ox + i * r.h, r.oy + j * r.h);
      if (!v) continue;
      const th = Math.atan2(v[1], v[0]);
      re[p] = v[2] * Math.cos(2 * th); im[p] = v[2] * Math.sin(2 * th);
    }
    return new PsiField(r, re, im);
  }
  /** Bilinear ψ at a point. */
  psi(x: number, y: number): [number, number] {
    const r = this.r;
    const fx = (x - r.ox) / r.h, fy = (y - r.oy) / r.h;
    const i = Math.floor(fx), j = Math.floor(fy), tx = fx - i, ty = fy - j;
    let a = 0, b = 0, ws = 0;
    for (const [di, dj] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      const ii = i + di, jj = j + dj;
      if (ii < 0 || jj < 0 || ii >= r.nx || jj >= r.ny) continue;
      const p = ii + r.nx * jj;
      if (!r.mask[p]) continue;
      const w = (di ? tx : 1 - tx) * (dj ? ty : 1 - ty);
      a += w * this.re[p]; b += w * this.im[p]; ws += w;
    }
    return ws > 1e-9 ? [a / ws, b / ws] : [0, 0];
  }
  director: Director = (x, y) => {
    const [a, b] = this.psi(x, y);
    if (a * a + b * b < 1e-18) return null;
    const th = Math.atan2(b, a) / 2;
    return [Math.cos(th), Math.sin(th)];
  };

  /** ±½ defects: plaquettes around which arg ψ winds by ±2π (θ by ±π). */
  defects(): { x: number; y: number; s: number }[] {
    const r = this.r, out: { x: number; y: number; s: number }[] = [];
    const arg = (p: number) => Math.atan2(this.im[p], this.re[p]);
    const wrap = (d: number) => d - 2 * Math.PI * Math.round(d / (2 * Math.PI));
    for (let j = 0; j + 1 < r.ny; j++) for (let i = 0; i + 1 < r.nx; i++) {
      const c = [i + r.nx * j, i + 1 + r.nx * j, i + 1 + r.nx * (j + 1), i + r.nx * (j + 1)];
      if (c.some((p) => !r.mask[p] || this.re[p] * this.re[p] + this.im[p] * this.im[p] < 1e-18)) continue;
      let wsum = 0;
      for (let k = 0; k < 4; k++) wsum += wrap(arg(c[(k + 1) % 4]) - arg(c[k]));
      const s = Math.round(wsum / (2 * Math.PI));
      if (s) out.push({ x: r.ox + (i + 0.5) * r.h, y: r.oy + (j + 0.5) * r.h, s });
    }
    return out;
  }

  /**
   * Move every ±½ defect out of the material: ψ(w) ← ψ(w)·((w − b)/(w − p))^s / |…| cancels the
   * winding s at p and puts it at b, the nearest point outside the region (a hole or the outside).
   */
  relocateDefects(): { found: number; moved: number } {
    const r = this.r;
    const ds = this.defects();
    if (!ds.length) return { found: 0, moved: 0 };
    // nearest empty cell centre for each defect
    const empty: [number, number][] = [];
    for (let j = 0; j < r.ny; j++) for (let i = 0; i < r.nx; i++) {
      const p = i + r.nx * j;
      if (r.mask[p]) continue;
      const edge = (i > 0 && r.mask[p - 1]) || (i < r.nx - 1 && r.mask[p + 1]) || (j > 0 && r.mask[p - r.nx]) || (j < r.ny - 1 && r.mask[p + r.nx]);
      if (edge) empty.push([r.ox + i * r.h, r.oy + j * r.h]);
    }
    if (!empty.length) return { found: ds.length, moved: 0 };
    for (const d of ds) {
      let bx = 0, by = 0, bd = Infinity;
      for (const [x, y] of empty) { const q = (x - d.x) ** 2 + (y - d.y) ** 2; if (q < bd) { bd = q; bx = x; by = y; } }
      for (let j = 0; j < r.ny; j++) for (let i = 0; i < r.nx; i++) {
        const p = i + r.nx * j;
        if (!r.mask[p]) continue;
        const x = r.ox + i * r.h, y = r.oy + j * r.h;
        // g = (w − b)/(w − p) for s = +1, its inverse for s = −1
        let gr = 0, gi = 0;
        const ar = x - bx, ai = y - by, br = x - d.x, bi = y - d.y;
        const [nr, ni, dr, di] = d.s > 0 ? [ar, ai, br, bi] : [br, bi, ar, ai];
        const den = dr * dr + di * di;
        if (den < 1e-12) continue;
        gr = (nr * dr + ni * di) / den; gi = (ni * dr - nr * di) / den;
        const gl = Math.hypot(gr, gi) || 1;
        gr /= gl; gi /= gl;
        const re = this.re[p] * gr - this.im[p] * gi, im = this.re[p] * gi + this.im[p] * gr;
        this.re[p] = re; this.im[p] = im;
      }
    }
    return { found: ds.length, moved: ds.length - this.defects().length };
  }
}

/** Evenly spaced streamlines inside the raster mask. */
export function evenStreamlines(r: RasterRegion, dir: Director, o: StreamOptions): number[][] {
  const dsep = o.dsep, dtest = dsep * (o.test ?? 0.5), step = o.step ?? Math.min(dsep / 3, 0.6), minLen = o.minLen ?? dsep;
  const cell = dsep;
  const gx = Math.ceil((r.nx * r.h) / cell) + 2, gy = Math.ceil((r.ny * r.h) / cell) + 2;
  const x0 = r.ox - r.h, y0 = r.oy - r.h;
  const buckets = new Map<number, number[]>();
  const key = (x: number, y: number) => Math.floor((x - x0) / cell) + gx * Math.floor((y - y0) / cell);
  const inside = (x: number, y: number) => {
    const i = Math.round((x - r.ox) / r.h), j = Math.round((y - r.oy) / r.h);
    return i >= 0 && j >= 0 && i < r.nx && j < r.ny && r.mask[i + r.nx * j] === 1;
  };
  const far = (x: number, y: number, d: number, line = -1, own?: number[], ownSkip = 0) => {
    const ci = Math.floor((x - x0) / cell), cj = Math.floor((y - y0) / cell);
    const d2 = d * d;
    for (let b = cj - 1; b <= cj + 1; b++) for (let a = ci - 1; a <= ci + 1; a++) {
      if (a < 0 || b < 0 || a >= gx || b >= gy) continue;
      const pts = buckets.get(a + gx * b);
      if (!pts) continue;
      for (let k = 0; k < pts.length; k += 3) if (pts[k + 2] !== line && (pts[k] - x) ** 2 + (pts[k + 1] - y) ** 2 < d2) return false;
    }
    // the line being traced may not curl back onto itself either
    if (own) for (let k = 0; k + ownSkip * 2 < own.length; k += 2) if ((own[k] - x) ** 2 + (own[k + 1] - y) ** 2 < d2) return false;
    return true;
  };
  const lines: number[][] = [];
  const add = (pts: number[], id: number) => {
    for (let k = 0; k < pts.length; k += 2) {
      const kk = key(pts[k], pts[k + 1]);
      let b = buckets.get(kk);
      if (!b) buckets.set(kk, (b = []));
      b.push(pts[k], pts[k + 1], id);
    }
  };
  const aligned = (d: [number, number] | null, px: number, py: number): [number, number] | null => (!d ? null : d[0] * px + d[1] * py < 0 ? [-d[0], -d[1]] : d);
  const trace = (sx: number, sy: number, d0: [number, number], sign: number, id: number): number[] => {
    const out: number[] = [];
    let x = sx, y = sy, px = d0[0] * sign, py = d0[1] * sign;
    const maxSteps = Math.ceil((4 * (r.nx + r.ny) * r.h) / step);
    const skip = Math.ceil((2 * dsep) / step);
    for (let s = 0; s < maxSteps; s++) {
      const k1 = aligned(dir(x, y), px, py);
      if (!k1) break;
      const k2 = aligned(dir(x + 0.5 * step * k1[0], y + 0.5 * step * k1[1]), k1[0], k1[1]) ?? k1;
      const k3 = aligned(dir(x + 0.5 * step * k2[0], y + 0.5 * step * k2[1]), k1[0], k1[1]) ?? k2;
      const k4 = aligned(dir(x + step * k3[0], y + step * k3[1]), k1[0], k1[1]) ?? k3;
      let vx = (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]) / 6, vy = (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1]) / 6;
      const l = Math.hypot(vx, vy);
      if (l < 1e-9) break;
      vx /= l; vy /= l;
      const nx = x + step * vx, ny = y + step * vy;
      if (!inside(nx, ny) || !far(nx, ny, dtest, id, out, skip)) break;
      x = nx; y = ny; px = vx; py = vy;
      out.push(x, y);
    }
    return out;
  };
  const queue: [number, number][] = [];
  // first seed: the most interior cell
  let best = -1, bi = 0;
  for (let p = 0; p < r.mask.length; p++) if (r.mask[p]) {
    const i = p % r.nx, j = Math.floor(p / r.nx);
    const d = Math.min(i, j, r.nx - 1 - i, r.ny - 1 - j);
    if (d > best) { best = d; bi = p; }
  }
  if (best < 0) return [];
  queue.push([r.ox + (bi % r.nx) * r.h, r.oy + Math.floor(bi / r.nx) * r.h]);
  let scan = 0;
  const maxLines = o.maxLines ?? 5000;
  const lineLen = (p: number[]) => { let L = 0; for (let k = 2; k < p.length; k += 2) L += Math.hypot(p[k] - p[k - 2], p[k + 1] - p[k - 1]); return L; };
  while (lines.length < maxLines) {
    let seed = queue.shift();
    const fromScan = !seed;
    if (!seed) {
      // coverage sweep: any cell still far from every line seeds a new one
      for (; scan < r.mask.length; scan += 1) {
        if (!r.mask[scan]) continue;
        const x = r.ox + (scan % r.nx) * r.h, y = r.oy + Math.floor(scan / r.nx) * r.h;
        if (far(x, y, dsep)) { seed = [x, y]; break; }
      }
      if (!seed) break;
    }
    const [sx, sy] = seed;
    if (fromScan) scan++;
    if (!inside(sx, sy) || !far(sx, sy, dsep)) continue;
    const d0 = dir(sx, sy);
    if (!d0) continue;
    const id = lines.length;
    const fwd = trace(sx, sy, d0, 1, id);
    const bwd = trace(sx, sy, d0, -1, id);
    const pts: number[] = [];
    for (let k = bwd.length - 2; k >= 0; k -= 2) pts.push(bwd[k], bwd[k + 1]);
    pts.push(sx, sy, ...fwd);
    if (pts.length < 4 || lineLen(pts) < minLen) continue;
    lines.push(pts);
    add(pts, id);
    // seeds one separation to either side, every few steps along the new line
    const every = Math.max(1, Math.round(dsep / (2 * step)));
    for (let k = 0; k + 2 < pts.length; k += 2 * every) {
      const tx = pts[k + 2] - pts[k], ty = pts[k + 3] - pts[k + 1];
      const l = Math.hypot(tx, ty) || 1;
      queue.push([pts[k] - (ty / l) * dsep, pts[k + 1] + (tx / l) * dsep], [pts[k] + (ty / l) * dsep, pts[k + 1] - (tx / l) * dsep]);
    }
  }
  return lines;
}
