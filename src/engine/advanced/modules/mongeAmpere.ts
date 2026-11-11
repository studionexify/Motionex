// #30 Monge–Ampère optical lenses. The light leaving the lens footprint (uniform density f) must land as
// the target image (density g) on a screen `throw` mm away: the optimal transport map T = ∇φ solves
// det(∇²φ) = f / g(∇φ). It is computed by entropic optimal transport (log-domain Sinkhorn with ε-scaling,
// the Gaussian kernel as separable 1D log-sum-exp passes) and its barycentric projection. In the thin-lens,
// small-angle limit Snell's law turns the ray displacement into the surface slope
// ∇h = (T(x) − x) / ((n − 1)·throw), integrated to the height field h by a least-squares Poisson solve.
// Lens mode carves h into the top of the part; lampshade mode prints the image into the outer wall of a
// shade as bead widths (Beer–Lambert transmission: brighter = thinner).
import { difference, intersection } from '../../clipper';
import { solveMasked2 } from '../solvers';
import type { SessionCtx, TechModule, WallLoop } from '../session';
import type { CausticTarget } from '../types';
import { levelRegion } from './fea';
import { rasterize } from '../offsets';

/** log Σ_y exp(h(y) − |x − y|²/ε) over an n×n grid, separably (one axis, then the other). */
function lse2(h: Float64Array, n: number, eps: number): Float64Array {
  const A = new Float64Array(n * n), R = new Float64Array(n * n), t = new Float64Array(n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    let m = -Infinity;
    for (let q = 0; q < n; q++) { t[q] = h[q + n * j] - ((i - q) * (i - q)) / eps; if (t[q] > m) m = t[q]; }
    let s = 0;
    for (let q = 0; q < n; q++) s += Math.exp(t[q] - m);
    A[i + n * j] = m + Math.log(s);
  }
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    let m = -Infinity;
    for (let q = 0; q < n; q++) { t[q] = A[i + n * q] - ((j - q) * (j - q)) / eps; if (t[q] > m) m = t[q]; }
    let s = 0;
    for (let q = 0; q < n; q++) s += Math.exp(t[q] - m);
    R[i + n * j] = m + Math.log(s);
  }
  return R;
}

/**
 * Entropic optimal transport (quadratic cost, in cell units) on an n×n grid from density mu to nu, by
 * log-domain Sinkhorn with ε-scaling (ε halves from n² down to `epsMin`). Returns the barycentric
 * projection T(x) = Σ_y π(x, y) y / Σ_y π(x, y) and the final marginal error.
 */
export function sinkhornMap(mu: Float64Array, nu: Float64Array, n: number, epsMin: number, iters: number): { T: Float64Array; err: number } {
  const N = n * n, f = new Float64Array(N), g = new Float64Array(N);
  const lmu = mu.map((v) => Math.log(Math.max(v, 1e-300))), lnu = nu.map((v) => Math.log(Math.max(v, 1e-300)));
  const stages: number[] = [];
  for (let e = n * n; e > epsMin; e /= 2) stages.push(e);
  stages.push(epsMin);
  const per = Math.max(3, Math.ceil(iters / stages.length));
  let eps = stages[0];
  for (const e of stages) {
    eps = e;
    for (let it = 0; it < per; it++) {
      const Lg = lse2(g.map((v) => v / eps), n, eps);
      for (let q = 0; q < N; q++) f[q] = eps * (lmu[q] - Lg[q]);
      const Lf = lse2(f.map((v) => v / eps), n, eps);
      for (let q = 0; q < N; q++) g[q] = eps * (lnu[q] - Lf[q]);
    }
  }
  const Lg = lse2(g.map((v) => v / eps), n, eps);
  let err = 0;
  for (let q = 0; q < N; q++) err += Math.abs(Math.exp(f[q] / eps + Lg[q]) - mu[q]);
  const T = new Float64Array(N * 2);
  for (const ax of [0, 1]) {
    const w = new Float64Array(N);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) w[i + n * j] = g[i + n * j] / eps + Math.log((ax ? j : i) + 1);
    const Lw = lse2(w, n, eps);
    for (let q = 0; q < N; q++) T[q * 2 + ax] = Math.exp(Lw[q] - Lg[q]) - 1;
  }
  return { T, err };
}

/** Target image resampled to n×n, normalised to a density (a small floor keeps every cell reachable). */
function targetDensity(t: CausticTarget, n: number): Float64Array {
  const d = new Float64Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const x = Math.min(t.width - 1, Math.floor(((i + 0.5) / n) * t.width)), y = Math.min(t.height - 1, Math.floor(((n - 1 - j + 0.5) / n) * t.height));
    d[i + n * j] = 0.02 + Math.max(0, t.pixels[y * t.width + x] ?? 0);
  }
  const s = d.reduce((a, b) => a + b, 0);
  return d.map((v) => v / s);
}

export interface Lens { n: number; ox: number; oy: number; size: number; h: Float64Array; maxH: number; err: number }

/** Lens height field over a square footprint (mm) for a target image at a throw distance. */
export function designLens(t: CausticTarget, ox: number, oy: number, size: number, ior: number, iters: number, n = 40): Lens {
  const mu = new Float64Array(n * n).fill(1 / (n * n));
  const { T, err } = sinkhornMap(mu, targetDensity(t, n), n, 1, iters);
  const cell = size / n;
  // slope field and its divergence
  const gx = new Float64Array(n * n), gy = new Float64Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const q = i + n * j;
    gx[q] = ((T[q * 2] - i) * cell) / ((ior - 1) * t.throwMm);
    gy[q] = ((T[q * 2 + 1] - j) * cell) / ((ior - 1) * t.throwMm);
  }
  const div = new Float64Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const q = i + n * j;
    const dx = ((i + 1 < n ? gx[q + 1] : gx[q]) - (i > 0 ? gx[q - 1] : gx[q])) / (2 * cell);
    const dy = ((j + 1 < n ? gy[q + n] : gy[q]) - (j > 0 ? gy[q - n] : gy[q])) / (2 * cell);
    div[q] = dx + dy;
  }
  // −Δh = −∇·g, h = 0 round the rim
  const mask = new Uint8Array(n * n).fill(1);
  const rhs = div.map((v) => -v);
  const sol = solveMasked2(n, n, cell, mask, 0, 1, rhs, 1e-8, 400);
  let lo = Infinity, hi = -Infinity;
  for (const v of sol.x) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  const h = sol.x.map((v) => v - lo);
  return { n, ox, oy, size, h, maxH: hi - lo, err };
}

const lensAt = (L: Lens, x: number, y: number) => {
  const i = Math.min(L.n - 1, Math.max(0, Math.floor(((x - L.ox) / L.size) * L.n))), j = Math.min(L.n - 1, Math.max(0, Math.floor(((y - L.oy) / L.size) * L.n)));
  return L.h[i + L.n * j];
};

export const mongeAmpere: TechModule = {
  id: 'monge_ampere',
  reshape(s: SessionCtx, o, layer, slice, z) {
    const t = s.adv.caustic;
    if (!t || t.mode !== 'lens' || !slice.length || !Number.isFinite(z)) return slice;
    const r = s.report('monge_ampere');
    const a = s.parts[o];
    const L = s.memo(`lens:${o}`, () => {
      const size = Math.max(a.sdf.max[0] - a.sdf.min[0], a.sdf.max[1] - a.sdf.min[1]);
      return designLens(t, (a.sdf.min[0] + a.sdf.max[0]) / 2 - size / 2, (a.sdf.min[1] + a.sdf.max[1]) / 2 - size / 2, size, s.pnum('monge_ampere', 'ior'), Math.round(s.pnum('monge_ampere', 'iters')));
    });
    // carve: keep material below top − (maxH − h(x, y))
    const top = a.sdf.max[2];
    if (z < top - L.maxH - 0.5) return slice;
    const ras = rasterize(slice, Math.max(0.25, L.size / L.n / 2));
    if (!ras) return slice;
    const keep = levelRegion(ras, (x, y) => top - L.maxH + lensAt(L, x, y) - (z - (s.layerH[layer] ?? 0.2) / 2), 0, 0.5).paths;
    r.stats = { mode: 'lens', grid: L.n, lens_relief_mm: +L.maxH.toFixed(2), transport_marginal_error: +L.err.toExponential(2), throw_mm: t.throwMm };
    return keep.length ? intersection(slice, keep) : difference(slice, slice);
  },
  wallsPost(s, o, layer, _ex, rings: WallLoop[][]) {
    const t = s.adv.caustic;
    if (!t || t.mode !== 'lampshade' || !rings.length) return;
    const r = s.report('monge_ampere');
    const a = s.parts[o];
    const cx = (a.sdf.min[0] + a.sdf.max[0]) / 2, cy = (a.sdf.min[1] + a.sdf.max[1]) / 2, zmin = a.sdf.min[2], zmax = a.sdf.max[2];
    const z = s.layerZ[layer] ?? 0;
    const v = 1 - (z - zmin) / Math.max(1e-6, zmax - zmin);
    let n = 0;
    for (const loop of rings[0]) {
      if (!loop.closed || loop.pts.length < 6) continue;
      const w0 = loop.width, widths: number[] = [];
      for (let k = 0; k < loop.pts.length; k += 2) {
        const u = (Math.atan2(loop.pts[k + 1] - cy, loop.pts[k] - cx) / (2 * Math.PI) + 1) % 1;
        const px = Math.min(t.width - 1, Math.floor(u * t.width)), py = Math.min(t.height - 1, Math.max(0, Math.floor(v * t.height)));
        const b = Math.max(0, Math.min(1, t.pixels[py * t.width + px] ?? 0.5));
        // Beer–Lambert: transmission e^{−μ w}; bright pixels get the thinnest bead
        widths.push(+(w0 * (1.6 - 0.9 * b)).toFixed(3));
      }
      loop.widths = widths;
      n++;
    }
    r.stats = { mode: 'lampshade', shaded_loops: (Number(r.stats?.shaded_loops) || 0) + n, width_range: `${(rings[0][0]?.width * 0.7).toFixed(2)}–${(rings[0][0]?.width * 1.6).toFixed(2)} mm` };
  },
};

