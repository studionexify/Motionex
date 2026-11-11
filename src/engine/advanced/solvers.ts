// Linear solvers for the field PDEs: preconditioned conjugate gradients, masked 3D Laplace with
// Dirichlet/Neumann boundaries, and a multigrid-preconditioned 2D Poisson / screened-Poisson solver.

export type Op = (x: Float64Array, out: Float64Array) => void;

export interface CgResult { x: Float64Array; iterations: number; residual: number }

/** Preconditioned conjugate gradients for a symmetric positive-definite operator. */
export function pcg(A: Op, b: Float64Array, x0?: Float64Array, precond?: Op, tol = 1e-6, maxIter = 2000): CgResult {
  const n = b.length;
  const x = x0 ? Float64Array.from(x0) : new Float64Array(n);
  const r = new Float64Array(n), z = new Float64Array(n), p = new Float64Array(n), Ap = new Float64Array(n);
  A(x, Ap);
  let bn = 0;
  for (let i = 0; i < n; i++) { r[i] = b[i] - Ap[i]; bn += b[i] * b[i]; }
  bn = Math.sqrt(bn) || 1;
  const applyM = (src: Float64Array, dst: Float64Array) => { if (precond) precond(src, dst); else dst.set(src); };
  applyM(r, z);
  p.set(z);
  let rz = dot(r, z);
  let res = Math.sqrt(dot(r, r)) / bn;
  let it = 0;
  for (; it < maxIter && res > tol; it++) {
    A(p, Ap);
    const pAp = dot(p, Ap);
    if (!(Math.abs(pAp) > 1e-300)) break;
    const alpha = rz / pAp;
    for (let i = 0; i < n; i++) { x[i] += alpha * p[i]; r[i] -= alpha * Ap[i]; }
    res = Math.sqrt(dot(r, r)) / bn;
    if (res <= tol) { it++; break; }
    applyM(r, z);
    const rz2 = dot(r, z);
    const beta = rz2 / rz;
    rz = rz2;
    for (let i = 0; i < n; i++) p[i] = z[i] + beta * p[i];
  }
  return { x, iterations: it, residual: res };
}

export function dot(a: Float64Array, b: Float64Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/**
 * Laplace ∇²φ = 0 on the cells where `kind` is 1 (unknown); cells with kind 2 are Dirichlet (value
 * from `fixed`); every other neighbour is a zero-flux (Neumann) boundary. 7-point stencil, Jacobi PCG.
 */
export function laplace3(nx: number, ny: number, nz: number, kind: Uint8Array, fixed: Float32Array, tol = 1e-6, maxIter = 4000, guess?: Float32Array): { phi: Float32Array; iterations: number; residual: number } {
  const N = nx * ny * nz, sx = 1, sy = nx, sz = nx * ny;
  const ids = new Int32Array(N).fill(-1);
  const cells: number[] = [];
  for (let p = 0; p < N; p++) if (kind[p] === 1) { ids[p] = cells.length; cells.push(p); }
  const n = cells.length;
  const phi = new Float32Array(N);
  for (let p = 0; p < N; p++) if (kind[p] === 2) phi[p] = fixed[p];
  if (!n) return { phi, iterations: 0, residual: 0 };
  // neighbour list per unknown: up to 6 entries, each an unknown id (≥ 0) or a Dirichlet value (encoded)
  const nbU = new Int32Array(n * 6).fill(-1);
  const diag = new Float64Array(n);
  const b = new Float64Array(n);
  const ijk = (p: number) => [p % nx, Math.floor(p / nx) % ny, Math.floor(p / sz)];
  for (let u = 0; u < n; u++) {
    const p = cells[u];
    const [i, j, k] = ijk(p);
    const nbs = [i > 0 ? p - sx : -1, i < nx - 1 ? p + sx : -1, j > 0 ? p - sy : -1, j < ny - 1 ? p + sy : -1, k > 0 ? p - sz : -1, k < nz - 1 ? p + sz : -1];
    let d = 0;
    nbs.forEach((q, e) => {
      if (q < 0) return;
      if (kind[q] === 1) { nbU[u * 6 + e] = ids[q]; d++; }
      else if (kind[q] === 2) { b[u] += fixed[q]; d++; }
    });
    diag[u] = d || 1;
  }
  const A: Op = (x, out) => {
    for (let u = 0; u < n; u++) {
      let s = diag[u] * x[u];
      for (let e = 0; e < 6; e++) { const v = nbU[u * 6 + e]; if (v >= 0) s -= x[v]; }
      out[u] = s;
    }
  };
  const M: Op = (r, z) => { for (let u = 0; u < n; u++) z[u] = r[u] / diag[u]; };
  const x0 = new Float64Array(n);
  if (guess) for (let u = 0; u < n; u++) x0[u] = guess[cells[u]];
  const res = pcg(A, b, x0, M, tol, maxIter);
  for (let u = 0; u < n; u++) phi[cells[u]] = res.x[u];
  return { phi, iterations: res.iterations, residual: res.residual };
}

// ---------------- 2D masked grids: (αI − βΔ) u = f with Dirichlet zero outside the mask

interface Level { nx: number; ny: number; mask: Uint8Array; h: number }

function coarsen(l: Level): Level | null {
  if (l.nx < 6 || l.ny < 6) return null;
  const nx = Math.ceil(l.nx / 2), ny = Math.ceil(l.ny / 2);
  const mask = new Uint8Array(nx * ny);
  let any = 0;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    // a coarse cell is inside when most of its children are (keeps the coarse problem well posed)
    let c = 0;
    for (let dj = 0; dj < 2; dj++) for (let di = 0; di < 2; di++) {
      const fi = 2 * i + di, fj = 2 * j + dj;
      if (fi < l.nx && fj < l.ny && l.mask[fi + l.nx * fj]) c++;
    }
    if (c >= 2) { mask[i + nx * j] = 1; any++; }
  }
  return any >= 4 ? { nx, ny, mask, h: l.h * 2 } : null;
}

/** Operator (αI − βΔ_h) on a masked grid (Dirichlet 0 outside). */
function applyOp(l: Level, alpha: number, beta: number, x: Float64Array, out: Float64Array) {
  const { nx, ny, mask } = l;
  const k = beta / (l.h * l.h);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const p = i + nx * j;
    if (!mask[p]) { out[p] = 0; continue; }
    const xl = i > 0 && mask[p - 1] ? x[p - 1] : 0, xr = i < nx - 1 && mask[p + 1] ? x[p + 1] : 0;
    const xd = j > 0 && mask[p - nx] ? x[p - nx] : 0, xu = j < ny - 1 && mask[p + nx] ? x[p + nx] : 0;
    out[p] = (alpha + 4 * k) * x[p] - k * (xl + xr + xd + xu);
  }
}

function jacobi(l: Level, alpha: number, beta: number, x: Float64Array, f: Float64Array, sweeps: number, tmp: Float64Array) {
  const k = beta / (l.h * l.h), d = alpha + 4 * k, w = 0.8;
  for (let s = 0; s < sweeps; s++) {
    applyOp(l, alpha, beta, x, tmp);
    for (let p = 0; p < x.length; p++) if (l.mask[p]) x[p] += (w * (f[p] - tmp[p])) / d;
  }
}

/** One V-cycle as a (symmetric) preconditioner: z ≈ A⁻¹ r. */
function vcycle(levels: Level[], li: number, alpha: number, beta: number, f: Float64Array, x: Float64Array) {
  const l = levels[li];
  const tmp = new Float64Array(f.length);
  x.fill(0);
  if (li === levels.length - 1) { jacobi(l, alpha, beta, x, f, 30, tmp); return; }
  jacobi(l, alpha, beta, x, f, 2, tmp);
  applyOp(l, alpha, beta, x, tmp);
  const c = levels[li + 1];
  const rc = new Float64Array(c.nx * c.ny);
  // full-weighting restriction of the residual (sum of children / 4 × 4 for the h² scaling of Δ)
  for (let j = 0; j < l.ny; j++) for (let i = 0; i < l.nx; i++) {
    const p = i + l.nx * j;
    if (!l.mask[p]) continue;
    const q = (i >> 1) + c.nx * (j >> 1);
    if (c.mask[q]) rc[q] += (f[p] - tmp[p]) * 0.25;
  }
  const ec = new Float64Array(c.nx * c.ny);
  vcycle(levels, li + 1, alpha, beta, rc, ec);
  // piecewise-constant prolongation (transpose of the restriction up to scale: keeps symmetry)
  for (let j = 0; j < l.ny; j++) for (let i = 0; i < l.nx; i++) {
    const p = i + l.nx * j;
    if (l.mask[p]) x[p] += ec[(i >> 1) + c.nx * (j >> 1)];
  }
  jacobi(l, alpha, beta, x, f, 2, tmp);
}

/**
 * Solve (αI − βΔ) u = f on a masked nx×ny grid with spacing h, Dirichlet 0 outside the mask.
 * Multigrid-preconditioned CG: a handful of iterations even for the pure Poisson case (α = 0).
 */
export function solveMasked2(nx: number, ny: number, h: number, mask: Uint8Array, alpha: number, beta: number, f: Float64Array, tol = 1e-6, maxIter = 300): CgResult {
  const levels: Level[] = [{ nx, ny, mask, h }];
  for (let l = coarsen(levels[0]); l && levels.length < 12; l = coarsen(l)) levels.push(l);
  const fine = levels[0];
  const A: Op = (x, out) => applyOp(fine, alpha, beta, x, out);
  const M: Op = (r, z) => vcycle(levels, 0, alpha, beta, r, z);
  const b = Float64Array.from(f);
  for (let p = 0; p < b.length; p++) if (!mask[p]) b[p] = 0;
  return pcg(A, b, undefined, M, tol, maxIter);
}

/**
 * Same operator as `solveMasked2` but on a compact list of the masked cells with Jacobi-PCG: the right
 * choice for thin domains (bands a few cells wide), where multigrid coarsening has nothing to keep.
 */
export function solveSparse2(nx: number, ny: number, h: number, mask: Uint8Array, alpha: number, beta: number, f: Float64Array, tol = 1e-8, maxIter = 500): CgResult {
  const id = new Int32Array(nx * ny).fill(-1);
  const cells: number[] = [];
  for (let p = 0; p < mask.length; p++) if (mask[p]) { id[p] = cells.length; cells.push(p); }
  const n = cells.length;
  const nb = new Int32Array(n * 4).fill(-1);
  for (let u = 0; u < n; u++) {
    const p = cells[u], i = p % nx, j = (p - i) / nx;
    if (i > 0) nb[u * 4] = id[p - 1];
    if (i < nx - 1) nb[u * 4 + 1] = id[p + 1];
    if (j > 0) nb[u * 4 + 2] = id[p - nx];
    if (j < ny - 1) nb[u * 4 + 3] = id[p + nx];
  }
  const k = beta / (h * h), d = alpha + 4 * k;
  const A: Op = (x, out) => {
    for (let u = 0; u < n; u++) {
      let s = d * x[u];
      for (let e = 0; e < 4; e++) { const v = nb[u * 4 + e]; if (v >= 0) s -= k * x[v]; }
      out[u] = s;
    }
  };
  const M: Op = (r, z) => { for (let u = 0; u < n; u++) z[u] = r[u] / d; };
  const b = new Float64Array(n);
  for (let u = 0; u < n; u++) b[u] = f[cells[u]];
  const res = pcg(A, b, undefined, M, tol, maxIter);
  const x = new Float64Array(nx * ny);
  for (let u = 0; u < n; u++) x[cells[u]] = res.x[u];
  return { x, iterations: res.iterations, residual: res.residual };
}
