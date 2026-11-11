// #35 Numerical homogenization of a periodic infill cell: voxel FEA on the unit cell with periodic
// displacements, one solve per unit macro-strain ε⁰ (Voigt), then
//   C^H_ij = (1/|Y|) Σ_e (χ⁰ᵢ − χᵢ)ᵉᵀ K_e (χ⁰ⱼ − χⱼ)ᵉ
// (Andreassen & Andreasen 2014). Void voxels keep 10⁻³ of the solid stiffness (ersatz material).
import { HEX_OFF, hexMatrices, isoC } from './fea';
import { pcg } from './solvers';

export interface Cell { nx: number; ny: number; nz: number; solid: Uint8Array }

/** Sheet gyroid voxel cell with solid fraction ≈ the target (|g| < t, t found by bisection). */
export function gyroidCell(n: number, fraction: number): Cell {
  const g = new Float64Array(n * n * n);
  for (let k = 0; k < n; k++) for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const X = (2 * Math.PI * (i + 0.5)) / n, Y = (2 * Math.PI * (j + 0.5)) / n, Z = (2 * Math.PI * (k + 0.5)) / n;
    g[i + n * (j + n * k)] = Math.abs(Math.sin(X) * Math.cos(Y) + Math.sin(Y) * Math.cos(Z) + Math.sin(Z) * Math.cos(X));
  }
  const sorted = Float64Array.from(g).sort();
  const t = sorted[Math.max(0, Math.min(sorted.length - 1, Math.round(fraction * sorted.length) - 1))];
  const solid = new Uint8Array(g.length);
  for (let q = 0; q < g.length; q++) solid[q] = g[q] <= t ? 1 : 0;
  return { nx: n, ny: n, nz: n, solid };
}

/**
 * Re-entrant (bow-tie) honeycomb cell extruded in z. Rows of zig-zag struts (length l, inclined θ below
 * the horizontal, θ = 90° − re-entrant angle) joined by vertical struts of length h = 2l; one period is
 * two struts wide (2 l cos θ = 1) and two rows high. Strut thickness t is relative to the cell width.
 */
export function reentrantCell(n: number, angleDeg: number, t: number, hOverL = 2): Cell {
  const th = -((90 - angleDeg) * Math.PI) / 180;
  const l = 0.5 / Math.cos(th), hv = hOverL * l, ls = l * Math.sin(th);
  const dy = hv + ls, H = 2 * dy;
  const ny = Math.max(4, Math.round(n * H)), nz = 2;
  const segs: [number, number, number, number][] = [];
  for (let j = 0; j < 2; j++) for (let m = 0; m < 2; m++) {
    const y = (mm: number, jj: number) => jj * dy + ((mm + jj) % 2 ? ls : 0) - ls;
    segs.push([m * 0.5, y(m, j), (m + 1) * 0.5, y(m + 1, j)]);
    if ((m + j) % 2 === 1) segs.push([m * 0.5, y(m, j), m * 0.5, (j + 1) * dy - ls]);
  }
  const solid = new Uint8Array(n * ny * nz);
  const d2 = (px: number, py: number, [ax, ay, bx, by]: [number, number, number, number]) => {
    const vx = bx - ax, vy = by - ay, L = vx * vx + vy * vy || 1;
    const u = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / L));
    return (px - ax - u * vx) ** 2 + (py - ay - u * vy) ** 2;
  };
  const hc = 1 / n;
  for (let j = 0; j < ny; j++) for (let i = 0; i < n; i++) {
    const x = (i + 0.5) * hc, y = (j + 0.5) * hc;
    let on = false;
    for (const sg of segs) for (const sx of [-1, 0, 1]) for (const sy of [-1, 0, 1]) if (!on && d2(x + sx, y + sy * ny * hc, sg) <= (t / 2) ** 2) on = true;
    if (on) for (let k = 0; k < nz; k++) solid[i + n * (j + ny * k)] = 1;
  }
  return { nx: n, ny, nz, solid };
}

/** Gibson–Ashby Poisson ratio ν₁₂ of a hexagonal honeycomb (θ negative for re-entrant). */
export const gibsonAshbyNu = (angleDeg: number, hOverL = 2) => { const th = -((90 - angleDeg) * Math.PI) / 180; return Math.cos(th) ** 2 / ((hOverL + Math.sin(th)) * Math.sin(th)); };

export const solidFraction = (c: Cell) => c.solid.reduce((s, v) => s + v, 0) / c.solid.length;

/** Effective 6×6 stiffness (row-major) of a periodic cell of solid modulus E, Poisson ν. */
export function homogenize(c: Cell, E: number, nu: number, cases: number[] = [0, 1, 2, 3, 4, 5], tol = 1e-6): Float64Array {
  const { nx, ny, nz } = c;
  const h = 1 / Math.max(nx, ny, nz);
  const { K } = hexMatrices(isoC(1, nu), h);
  const ne = nx * ny * nz, N = ne * 3; // periodic: one node per cell corner
  const node = (i: number, j: number, k: number) => ((i % nx) + nx * ((j % ny) + ny * (k % nz)));
  const en = new Int32Array(ne * 8);
  const sc = new Float64Array(ne);
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const e = i + nx * (j + ny * k);
    for (let a = 0; a < 8; a++) en[e * 8 + a] = node(i + HEX_OFF[a][0], j + HEX_OFF[a][1], k + HEX_OFF[a][2]);
    sc[e] = c.solid[e] ? 1 : 1e-3;
  }
  // nodal displacements of a unit strain on one element (local corner offsets × h)
  const chi0 = (v: number) => {
    const u = new Float64Array(24);
    for (let a = 0; a < 8; a++) {
      const x = HEX_OFF[a][0] * h, y = HEX_OFF[a][1] * h, z = HEX_OFF[a][2] * h;
      const eps = [0, 0, 0, 0, 0, 0]; eps[v] = 1;
      // u = ε·x with engineering shears split symmetrically
      u[a * 3] = eps[0] * x + 0.5 * eps[5] * y + 0.5 * eps[4] * z;
      u[a * 3 + 1] = 0.5 * eps[5] * x + eps[1] * y + 0.5 * eps[3] * z;
      u[a * 3 + 2] = 0.5 * eps[4] * x + 0.5 * eps[3] * y + eps[2] * z;
    }
    return u;
  };
  const ue = new Float64Array(24);
  const A = (x: Float64Array, out: Float64Array) => {
    out.fill(0);
    for (let e = 0; e < ne; e++) {
      for (let a = 0; a < 8; a++) { const n = en[e * 8 + a] * 3; ue[a * 3] = x[n]; ue[a * 3 + 1] = x[n + 1]; ue[a * 3 + 2] = x[n + 2]; }
      for (let r = 0; r < 24; r++) { let v = 0; for (let q = 0; q < 24; q++) v += K[r * 24 + q] * ue[q]; out[en[e * 8 + (r / 3 | 0)] * 3 + (r % 3)] += v * sc[e]; }
    }
    // pin node 0 (rigid translation)
    out[0] = x[0]; out[1] = x[1]; out[2] = x[2];
  };
  const diag = new Float64Array(N);
  for (let e = 0; e < ne; e++) for (let r = 0; r < 24; r++) diag[en[e * 8 + (r / 3 | 0)] * 3 + (r % 3)] += K[r * 25] * sc[e];
  const M = (r: Float64Array, z: Float64Array) => { for (let i = 0; i < N; i++) z[i] = i < 3 ? r[i] : r[i] / diag[i]; };
  const chiE: Float64Array[] = [];
  const chis: (Float64Array | null)[] = [null, null, null, null, null, null];
  const c0 = [0, 1, 2, 3, 4, 5].map(chi0);
  for (const v of cases) {
    const b = new Float64Array(N);
    const u0 = c0[v];
    for (let e = 0; e < ne; e++) for (let r = 0; r < 24; r++) {
      let s = 0;
      for (let q = 0; q < 24; q++) s += K[r * 24 + q] * u0[q];
      b[en[e * 8 + (r / 3 | 0)] * 3 + (r % 3)] += s * sc[e];
    }
    b[0] = b[1] = b[2] = 0;
    chis[v] = pcg(A, b, undefined, M, tol, 4000).x;
  }
  const C = new Float64Array(36);
  const vol = 1 * (nx * h) * (ny * h) * (nz * h);
  const du = (v: number, e: number, out: Float64Array) => {
    const x = chis[v]!, u0 = c0[v];
    for (let a = 0; a < 8; a++) { const n = en[e * 8 + a] * 3; for (let d = 0; d < 3; d++) out[a * 3 + d] = u0[a * 3 + d] - x[n + d]; }
  };
  const di = new Float64Array(24), dj = new Float64Array(24);
  for (const i of cases) for (const j of cases) {
    if (j < i) continue;
    let s = 0;
    for (let e = 0; e < ne; e++) {
      du(i, e, di); du(j, e, dj);
      let q = 0;
      for (let r = 0; r < 24; r++) { let v = 0; for (let t = 0; t < 24; t++) v += K[r * 24 + t] * dj[t]; q += di[r] * v; }
      s += q * sc[e];
    }
    C[i * 6 + j] = C[j * 6 + i] = (s * E) / vol;
  }
  void chiE;
  return C;
}

/** Inverse of a symmetric positive-definite 6×6 (Gauss–Jordan). */
export function inv6(C: Float64Array): Float64Array {
  const n = 6, a = Array.from({ length: n }, (_, i) => [...Array.from(C.slice(i * 6, i * 6 + 6)), ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
    [a[c], a[p]] = [a[p], a[c]];
    const d = a[c][c] || 1e-30;
    for (let k = 0; k < 2 * n; k++) a[c][k] /= d;
    for (let r = 0; r < n; r++) if (r !== c) { const f = a[r][c]; for (let k = 0; k < 2 * n; k++) a[r][k] -= f * a[c][k]; }
  }
  const out = new Float64Array(36);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) out[i * 6 + j] = a[i][n + j];
  return out;
}

/** Engineering constants from C^H: E_x, E_y, E_z, ν_xy, ν_yx, G_yz, Zener anisotropy. */
export function engineering(C: Float64Array) {
  const S = inv6(C);
  return { Ex: 1 / S[0], Ey: 1 / S[7], Ez: 1 / S[14], nuxy: -S[1] / S[0], nuyx: -S[6] / S[7], Gyz: 1 / S[21], zener: (2 * C[21]) / Math.max(1e-12, C[0] - C[1]) };
}

/** In-plane constants (x–y) of an extruded 2D cell: only the in-plane strains are solved. */
export function homogenize2D(c: Cell, E: number, nu: number) {
  const C = homogenize(c, E, nu, [0, 1, 5]);
  // in-plane compliance of the 3×3 block (xx, yy, xy) under plane stress in z for an extrusion: keep it simple, use the block
  const a = C[0], b = C[1], d = C[7], g = C[35];
  const det = a * d - b * b;
  return { Ex: det / d, Ey: det / a, nuxy: b / d, nuyx: b / a, Gxy: g, C };
}
