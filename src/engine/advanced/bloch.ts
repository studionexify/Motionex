// Bloch–Floquet band structure of a periodic mass–spring lattice (scalar displacement per mass), and
// its band topology: Berry curvature and Chern numbers by the Fukui–Hatsugai–Suzuki lattice method
// (gauge-invariant plaquette phases of the band projector), valley Chern numbers by integrating the
// curvature over the half of the Brillouin zone around K.

export interface Lattice {
  /** Primitive vectors a₁, a₂ (mm). */
  a1: [number, number]; a2: [number, number];
  /** Mass of each site in the cell (kg per metre of extrusion). */
  m: number[];
  /** Springs: sites i, j, the cell offset (n₁, n₂) of j, stiffness (N/m per metre). */
  springs: { i: number; j: number; n: [number, number]; k: number }[];
}

type C = [number, number];

/** Dynamical matrix D(k) = M^{-½} K(k) M^{-½}, Hermitian, periodic in k (bond phases by cell offset). */
export function dynamical(L: Lattice, k1: number, k2: number): { re: Float64Array; im: Float64Array } {
  const n = L.m.length, re = new Float64Array(n * n), im = new Float64Array(n * n);
  for (const s of L.springs) {
    const ph = 2 * Math.PI * (k1 * s.n[0] + k2 * s.n[1]); // k in reduced coordinates
    const w = s.k / Math.sqrt(L.m[s.i] * L.m[s.j]);
    re[s.i * n + s.i] += s.k / L.m[s.i];
    re[s.j * n + s.j] += s.k / L.m[s.j];
    re[s.i * n + s.j] -= w * Math.cos(ph); im[s.i * n + s.j] -= w * Math.sin(ph);
    re[s.j * n + s.i] -= w * Math.cos(ph); im[s.j * n + s.i] += w * Math.sin(ph);
  }
  return { re, im };
}

/** Eigen-pairs of an n×n Hermitian matrix via the real symmetric 2n×2n embedding and Jacobi. */
export function eigHermitian(re: Float64Array, im: Float64Array, n: number): { values: number[]; vectors: C[][] } {
  const N = 2 * n, A = new Float64Array(N * N), V = new Float64Array(N * N);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const r = re[i * n + j], m = im[i * n + j];
    A[i * N + j] = r; A[(i + n) * N + j + n] = r; A[i * N + j + n] = -m; A[(i + n) * N + j] = m;
  }
  for (let i = 0; i < N; i++) V[i * N + i] = 1;
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0;
    for (let p = 0; p < N; p++) for (let q = p + 1; q < N; q++) off += A[p * N + q] ** 2;
    if (off < 1e-24) break;
    for (let p = 0; p < N; p++) for (let q = p + 1; q < N; q++) {
      const apq = A[p * N + q];
      if (Math.abs(apq) < 1e-300) continue;
      const th = (A[q * N + q] - A[p * N + p]) / (2 * apq);
      const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < N; k++) { const akp = A[k * N + p], akq = A[k * N + q]; A[k * N + p] = c * akp - s * akq; A[k * N + q] = s * akp + c * akq; }
      for (let k = 0; k < N; k++) { const apk = A[p * N + k], aqk = A[q * N + k]; A[p * N + k] = c * apk - s * aqk; A[q * N + k] = s * apk + c * aqk; }
      for (let k = 0; k < N; k++) { const vkp = V[k * N + p], vkq = V[k * N + q]; V[k * N + p] = c * vkp - s * vkq; V[k * N + q] = s * vkp + c * vkq; }
    }
  }
  // each eigenvalue appears twice; keep one complex vector per pair
  const idx = Array.from({ length: N }, (_, i) => i).sort((a, b) => A[a * N + a] - A[b * N + b]);
  const values: number[] = [], vectors: C[][] = [];
  for (let q = 0; q < N; q += 2) {
    const col = idx[q];
    values.push(A[col * N + col]);
    const v: C[] = [];
    let nrm = 0;
    for (let i = 0; i < n; i++) { v.push([V[i * N + col], V[(i + n) * N + col]]); nrm += V[i * N + col] ** 2 + V[(i + n) * N + col] ** 2; }
    nrm = Math.sqrt(nrm) || 1;
    vectors.push(v.map(([a, b]) => [a / nrm, b / nrm]));
  }
  return { values, vectors };
}

/** Frequencies (Hz) of all bands at a reduced wavevector. Stiffness N/m, mass kg → ω² in s⁻². */
export function bandsAt(L: Lattice, k1: number, k2: number): number[] {
  const D = dynamical(L, k1, k2);
  return eigHermitian(D.re, D.im, L.m.length).values.map((w2) => Math.sqrt(Math.max(0, w2)) / (2 * Math.PI));
}

/** Frequencies over a k-grid: each band's [min, max], and the gaps between consecutive bands. */
export function bandEdges(L: Lattice, grid = 24): { bands: [number, number][]; gaps: { below: number; lo: number; hi: number }[] } {
  const n = L.m.length;
  const bands: [number, number][] = Array.from({ length: n }, () => [Infinity, -Infinity]);
  for (let a = 0; a < grid; a++) for (let b = 0; b < grid; b++) {
    const f = bandsAt(L, a / grid, b / grid);
    f.forEach((v, i) => { bands[i][0] = Math.min(bands[i][0], v); bands[i][1] = Math.max(bands[i][1], v); });
  }
  // the high-symmetry points K, K', M explicitly
  for (const [a, b] of [[1 / 3, 2 / 3], [2 / 3, 1 / 3], [0.5, 0], [0, 0.5], [0.5, 0.5]]) bandsAt(L, a, b).forEach((v, i) => { bands[i][0] = Math.min(bands[i][0], v); bands[i][1] = Math.max(bands[i][1], v); });
  const gaps: { below: number; lo: number; hi: number }[] = [];
  for (let i = 0; i + 1 < n; i++) if (bands[i + 1][0] > bands[i][1]) gaps.push({ below: i + 1, lo: bands[i][1], hi: bands[i + 1][0] });
  return { bands, gaps };
}

/**
 * Berry curvature per plaquette of the bands below `nb` (non-Abelian: det of the overlap matrix) and the
 * Chern number Σ F / 2π (an integer for a gapped set of bands).
 */
export function chern(L: Lattice, nb: number, grid = 18): { chern: number; curvature: Float64Array } {
  const n = L.m.length;
  const U: C[][][] = [];
  for (let a = 0; a < grid; a++) for (let b = 0; b < grid; b++) {
    const D = dynamical(L, a / grid, b / grid);
    U.push(eigHermitian(D.re, D.im, n).vectors.slice(0, nb));
  }
  const at = (a: number, b: number) => U[((a % grid) + grid) % grid * grid + ((b % grid) + grid) % grid];
  // link variable: det ⟨u_i(k)|u_j(k')⟩ (complex)
  const link = (P: C[][], Q: C[][]): C => {
    const M: C[][] = P.map((p) => Q.map((q) => { let re = 0, im = 0; for (let s = 0; s < n; s++) { re += p[s][0] * q[s][0] + p[s][1] * q[s][1]; im += p[s][0] * q[s][1] - p[s][1] * q[s][0]; } return [re, im] as C; }));
    return cdet(M);
  };
  const F = new Float64Array(grid * grid);
  let total = 0;
  for (let a = 0; a < grid; a++) for (let b = 0; b < grid; b++) {
    const u1 = link(at(a, b), at(a + 1, b)), u2 = link(at(a + 1, b), at(a + 1, b + 1)), u3 = link(at(a + 1, b + 1), at(a, b + 1)), u4 = link(at(a, b + 1), at(a, b));
    const p = cmul(cmul(u1, u2), cmul(u3, u4));
    const f = Math.atan2(p[1], p[0]);
    F[a * grid + b] = f;
    total += f;
  }
  return { chern: total / (2 * Math.PI), curvature: F };
}

/** Valley Chern number: curvature summed over the plaquettes nearer K = (1/3, 2/3) than K′ = (2/3, 1/3). */
export function valleyChern(L: Lattice, nb: number, grid = 18): number {
  const { curvature } = chern(L, nb, grid);
  let s = 0;
  const d = (a: number, b: number, ka: number, kb: number) => { let da = a - ka, db = b - kb; da -= Math.round(da); db -= Math.round(db); return da * da + db * db + da * db; };
  for (let a = 0; a < grid; a++) for (let b = 0; b < grid; b++) {
    const ka = (a + 0.5) / grid, kb = (b + 0.5) / grid;
    if (d(ka, kb, 1 / 3, 2 / 3) < d(ka, kb, 2 / 3, 1 / 3)) s += curvature[a * grid + b];
  }
  return s / (2 * Math.PI);
}

function cmul(a: C, b: C): C { return [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]]; }
function cdet(M: C[][]): C {
  const n = M.length;
  if (n === 1) return M[0][0];
  const A = M.map((r) => r.map((v) => [v[0], v[1]] as C));
  let det: C = [1, 0];
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.hypot(...A[r][c]) > Math.hypot(...A[p][c])) p = r;
    if (p !== c) { [A[c], A[p]] = [A[p], A[c]]; det = [-det[0], -det[1]]; }
    const piv = A[c][c];
    const pn = piv[0] ** 2 + piv[1] ** 2;
    if (pn < 1e-300) return [0, 0];
    det = cmul(det, piv);
    const inv: C = [piv[0] / pn, -piv[1] / pn];
    for (let r = c + 1; r < n; r++) {
      const f = cmul(A[r][c], inv);
      for (let k = c; k < n; k++) { const t = cmul(f, A[c][k]); A[r][k] = [A[r][k][0] - t[0], A[r][k][1] - t[1]]; }
    }
  }
  return det;
}

/**
 * Honeycomb frame (sites A, B) with one local resonator per hexagonal cell, attached to its six
 * corners. Stiffness/mass per metre of extrusion (the extrusion height cancels in ω).
 */
export function resonantHoneycomb(o: { a: number; frameK: number; mA: number; mB: number; mR: number; kR: number }): Lattice {
  const s3 = Math.sqrt(3);
  const a1: [number, number] = [o.a * s3, 0], a2: [number, number] = [(o.a * s3) / 2, (o.a * 3) / 2];
  // A at (0,0), B at (0, a); neighbours of A: B(0,0), B(0,-1)?, using offsets for a standard honeycomb
  const springs: Lattice['springs'] = [
    { i: 0, j: 1, n: [0, 0], k: o.frameK }, { i: 0, j: 1, n: [0, -1], k: o.frameK }, { i: 0, j: 1, n: [1, -1], k: o.frameK },
  ];
  // the resonator (site 2) at the hexagon centre touches 3 A and 3 B corners
  const kk = o.kR / 6;
  for (const n of [[0, 0], [1, 0], [0, 1]] as [number, number][]) springs.push({ i: 2, j: 0, n, k: kk });
  for (const n of [[0, 0], [1, -1], [1, 0]] as [number, number][]) springs.push({ i: 2, j: 1, n, k: kk });
  return { a1, a2, m: [o.mA, o.mB, o.mR], springs };
}
