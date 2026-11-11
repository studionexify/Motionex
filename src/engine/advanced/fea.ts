// Linear-elastic voxel finite elements: 8-node trilinear hexahedra on a regular lattice, assembled
// matrix-free and solved by Jacobi-preconditioned conjugate gradients. Used for the stress-aligned
// paths (#1), the spinor frame field (#33), the inherent-strain warp prediction (#16) and, with
// periodic boundaries, the elasticity homogenization of infill cells (#35).
// Units: mm, N, MPa. Voigt order: xx, yy, zz, yz, xz, xy (engineering shear strains).
import { pcg } from './solvers';

const G = 1 / Math.sqrt(3);
/** Local node coordinates (ξ, η, ζ) and lattice offsets of the 8 hexahedron nodes. */
export const HEX_NODE = [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1], [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]] as const;
export const HEX_OFF = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]] as const;

/** Isotropic elasticity matrix (6×6, row-major). */
export function isoC(E: number, nu: number): Float64Array {
  const l = (E * nu) / ((1 + nu) * (1 - 2 * nu)), m = E / (2 * (1 + nu));
  const C = new Float64Array(36);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C[i * 6 + j] = l + (i === j ? 2 * m : 0);
  for (let i = 3; i < 6; i++) C[i * 6 + i] = m;
  return C;
}

/** Strain–displacement matrix B (6×24) of a cube of side h at local point (ξ, η, ζ). */
export function hexB(xi: number, eta: number, zeta: number, h: number): Float64Array {
  const B = new Float64Array(6 * 24);
  const s = 2 / h;
  for (let a = 0; a < 8; a++) {
    const [p, q, r] = HEX_NODE[a];
    const dx = 0.125 * p * (1 + q * eta) * (1 + r * zeta) * s;
    const dy = 0.125 * q * (1 + p * xi) * (1 + r * zeta) * s;
    const dz = 0.125 * r * (1 + p * xi) * (1 + q * eta) * s;
    const c = a * 3;
    B[0 * 24 + c] = dx; B[1 * 24 + c + 1] = dy; B[2 * 24 + c + 2] = dz;
    B[3 * 24 + c + 1] = dz; B[3 * 24 + c + 2] = dy;
    B[4 * 24 + c] = dz; B[4 * 24 + c + 2] = dx;
    B[5 * 24 + c] = dy; B[5 * 24 + c + 1] = dx;
  }
  return B;
}

const gaussPoints = (): [number, number, number][] => {
  const out: [number, number, number][] = [];
  for (const a of [-G, G]) for (const b of [-G, G]) for (const c of [-G, G]) out.push([a, b, c]);
  return out;
};

/** Element stiffness K = ∫ BᵀCB dV (24×24) and eigenstrain load matrix F = ∫ BᵀC dV (24×6) for side h. */
export function hexMatrices(C: Float64Array, h: number): { K: Float64Array; F: Float64Array } {
  const K = new Float64Array(576), F = new Float64Array(144);
  const detJ = (h / 2) ** 3;
  const CB = new Float64Array(6 * 24);
  for (const [a, b, c] of gaussPoints()) {
    const B = hexB(a, b, c, h);
    for (let i = 0; i < 6; i++) for (let j = 0; j < 24; j++) { let s = 0; for (let k = 0; k < 6; k++) s += C[i * 6 + k] * B[k * 24 + j]; CB[i * 24 + j] = s; }
    for (let i = 0; i < 24; i++) {
      for (let j = 0; j < 24; j++) { let s = 0; for (let k = 0; k < 6; k++) s += B[k * 24 + i] * CB[k * 24 + j]; K[i * 24 + j] += s * detJ; }
      for (let j = 0; j < 6; j++) { let s = 0; for (let k = 0; k < 6; k++) s += B[k * 24 + i] * C[k * 6 + j]; F[i * 6 + j] += s * detJ; }
    }
  }
  return { K, F };
}

/** Voxel model: active elements of a regular lattice and the nodes they use. */
export interface VoxelModel {
  nx: number; ny: number; nz: number;
  h: number;
  /** World position of lattice node (0, 0, 0). */
  ox: number; oy: number; oz: number;
  /** Lattice cell of each element. */
  cells: Int32Array;
  /** Element of each lattice cell, -1 when empty. */
  elemOf: Int32Array;
  /** 8 node ids per element (HEX_OFF order). */
  en: Int32Array;
  /** Active node id of each lattice node, -1 unused. */
  nodeOf: Int32Array;
  /** Lattice node of each active node. */
  nodeLat: Int32Array;
  nodes: number;
  /** Elements meeting at each node (8 inside the part, fewer on its surface). */
  valence: Uint8Array;
}

export const latticeIndex = (m: Pick<VoxelModel, 'nx' | 'ny'>, i: number, j: number, k: number) => i + (m.nx + 1) * (j + (m.ny + 1) * k);

/** Build a voxel model of the cells for which `solid(x, y, z)` (cell centre) holds. */
export function voxelModel(min: number[], max: number[], h: number, solid: (x: number, y: number, z: number) => boolean): VoxelModel {
  const nx = Math.max(1, Math.ceil((max[0] - min[0]) / h)), ny = Math.max(1, Math.ceil((max[1] - min[1]) / h)), nz = Math.max(1, Math.ceil((max[2] - min[2]) / h));
  const ox = (min[0] + max[0]) / 2 - (nx * h) / 2, oy = (min[1] + max[1]) / 2 - (ny * h) / 2, oz = min[2];
  const elemOf = new Int32Array(nx * ny * nz).fill(-1);
  const cells: number[] = [];
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    if (!solid(ox + (i + 0.5) * h, oy + (j + 0.5) * h, oz + (k + 0.5) * h)) continue;
    const c = i + nx * (j + ny * k);
    elemOf[c] = cells.length; cells.push(c);
  }
  const nodeOf = new Int32Array((nx + 1) * (ny + 1) * (nz + 1)).fill(-1);
  const en = new Int32Array(cells.length * 8);
  const lat: number[] = [];
  const valence: number[] = [];
  const m = { nx, ny };
  cells.forEach((c, e) => {
    const i = c % nx, j = Math.floor(c / nx) % ny, k = Math.floor(c / (nx * ny));
    for (let a = 0; a < 8; a++) {
      const L = latticeIndex(m, i + HEX_OFF[a][0], j + HEX_OFF[a][1], k + HEX_OFF[a][2]);
      if (nodeOf[L] < 0) { nodeOf[L] = lat.length; lat.push(L); valence.push(0); }
      en[e * 8 + a] = nodeOf[L];
      valence[nodeOf[L]]++;
    }
  });
  return { nx, ny, nz, h, ox, oy, oz, cells: Int32Array.from(cells), elemOf, en, nodeOf, nodeLat: Int32Array.from(lat), nodes: lat.length, valence: Uint8Array.from(valence) };
}

/** World position of an active node. */
export function nodePos(m: VoxelModel, n: number): [number, number, number] {
  const L = m.nodeLat[n], X = m.nx + 1, Y = m.ny + 1;
  return [m.ox + (L % X) * m.h, m.oy + (Math.floor(L / X) % Y) * m.h, m.oz + Math.floor(L / (X * Y)) * m.h];
}

export interface ElasticProblem {
  E: number;
  nu: number;
  /** Fixed DOFs per node: bit 1 x, 2 y, 4 z. */
  fixed: Uint8Array;
  /** Nodal forces (3 per node). */
  f?: Float64Array;
  /** Eigenstrain (inherent strain) per element, 6 per element, or one Voigt vector for all. */
  eigen?: Float64Array;
  /** Per-element stiffness scale (soft void elements, layer activation). */
  scale?: Float32Array;
  tol?: number;
  maxIter?: number;
  x0?: Float64Array;
}

export interface ElasticSolution { u: Float64Array; iterations: number; residual: number }

/** Matrix-free K·x over the model's elements. */
export function stiffnessOp(m: VoxelModel, K: Float64Array, scale?: Float32Array) {
  const ne = m.cells.length, en = m.en;
  const ue = new Float64Array(24);
  return (x: Float64Array, out: Float64Array) => {
    out.fill(0);
    for (let e = 0; e < ne; e++) {
      const s = scale ? scale[e] : 1;
      if (s === 0) continue;
      for (let a = 0; a < 8; a++) { const n = en[e * 8 + a] * 3; ue[a * 3] = x[n]; ue[a * 3 + 1] = x[n + 1]; ue[a * 3 + 2] = x[n + 2]; }
      for (let a = 0; a < 8; a++) {
        const n = en[e * 8 + a] * 3;
        for (let d = 0; d < 3; d++) {
          const row = (a * 3 + d) * 24;
          let v = 0;
          for (let j = 0; j < 24; j++) v += K[row + j] * ue[j];
          out[n + d] += v * s;
        }
      }
    }
  };
}

/** Solve K u = f + f_eigen with fixed DOFs held at zero. */
export function solveElastic(m: VoxelModel, p: ElasticProblem): ElasticSolution {
  const { K, F } = hexMatrices(isoC(p.E, p.nu), m.h);
  const N = m.nodes * 3, ne = m.cells.length;
  const b = new Float64Array(N);
  if (p.f) b.set(p.f);
  if (p.eigen) {
    const per = p.eigen.length === 6 ? 0 : 6;
    for (let e = 0; e < ne; e++) {
      const s = p.scale ? p.scale[e] : 1;
      if (!s) continue;
      for (let a = 0; a < 8; a++) {
        const n = m.en[e * 8 + a] * 3;
        for (let d = 0; d < 3; d++) {
          let v = 0;
          for (let j = 0; j < 6; j++) v += F[(a * 3 + d) * 6 + j] * p.eigen[e * per + j];
          b[n + d] += v * s;
        }
      }
    }
  }
  const fixedDof = new Uint8Array(N);
  for (let n = 0; n < m.nodes; n++) for (let d = 0; d < 3; d++) if (p.fixed[n] & (1 << d)) fixedDof[n * 3 + d] = 1;
  for (let i = 0; i < N; i++) if (fixedDof[i]) b[i] = 0;
  const Kop = stiffnessOp(m, K, p.scale);
  const tmp = new Float64Array(N);
  // fixed DOFs: identity rows and columns (keeps the operator symmetric positive definite)
  const A = (x: Float64Array, out: Float64Array) => {
    tmp.set(x);
    for (let i = 0; i < N; i++) if (fixedDof[i]) tmp[i] = 0;
    Kop(tmp, out);
    for (let i = 0; i < N; i++) if (fixedDof[i]) out[i] = x[i];
  };
  const diag = new Float64Array(N);
  for (let e = 0; e < ne; e++) {
    const s = p.scale ? p.scale[e] : 1;
    for (let a = 0; a < 8; a++) for (let d = 0; d < 3; d++) diag[m.en[e * 8 + a] * 3 + d] += K[(a * 3 + d) * 25] * s;
  }
  for (let i = 0; i < N; i++) diag[i] = fixedDof[i] || diag[i] <= 0 ? 1 : 1 / diag[i];
  const M = (r: Float64Array, z: Float64Array) => { for (let i = 0; i < N; i++) z[i] = r[i] * diag[i]; };
  const r = pcg(A, b, p.x0, M, p.tol ?? 1e-5, p.maxIter ?? 2000);
  return { u: r.x, iterations: r.iterations, residual: r.residual };
}

/** Element stresses σ = C(B u − ε*) at the element centres (6 per element). */
export function elementStress(m: VoxelModel, u: Float64Array, E: number, nu: number, eigen?: Float64Array): Float32Array {
  const C = isoC(E, nu), B = hexB(0, 0, 0, m.h);
  const ne = m.cells.length, out = new Float32Array(ne * 6);
  const eps = new Float64Array(6);
  const per = eigen && eigen.length === 6 ? 0 : 6;
  for (let e = 0; e < ne; e++) {
    for (let i = 0; i < 6; i++) {
      let v = 0;
      for (let a = 0; a < 8; a++) { const n = m.en[e * 8 + a] * 3; v += B[i * 24 + a * 3] * u[n] + B[i * 24 + a * 3 + 1] * u[n + 1] + B[i * 24 + a * 3 + 2] * u[n + 2]; }
      eps[i] = v - (eigen ? eigen[e * per + i] : 0);
    }
    for (let i = 0; i < 6; i++) { let v = 0; for (let j = 0; j < 6; j++) v += C[i * 6 + j] * eps[j]; out[e * 6 + i] = v; }
  }
  return out;
}

export const vonMises = (s: ArrayLike<number>, o = 0) => Math.sqrt(0.5 * ((s[o] - s[o + 1]) ** 2 + (s[o + 1] - s[o + 2]) ** 2 + (s[o + 2] - s[o]) ** 2) + 3 * (s[o + 3] ** 2 + s[o + 4] ** 2 + s[o + 5] ** 2));

/**
 * Eigen-decomposition of a symmetric 3×3 tensor (Voigt xx yy zz yz xz xy) by cyclic Jacobi rotations.
 * Values sorted descending (σ₁ ≥ σ₂ ≥ σ₃); vectors are the columns of a right-handed rotation.
 */
export function eigSym3(s: ArrayLike<number>, o = 0): { values: [number, number, number]; vectors: Float64Array } {
  const a = [[s[o], s[o + 5], s[o + 4]], [s[o + 5], s[o + 1], s[o + 3]], [s[o + 4], s[o + 3], s[o + 2]]];
  const V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 12; sweep++) {
    const off = a[0][1] ** 2 + a[0][2] ** 2 + a[1][2] ** 2;
    if (off < 1e-22 * (a[0][0] ** 2 + a[1][1] ** 2 + a[2][2] ** 2 + 1e-30)) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      if (Math.abs(a[p][q]) < 1e-300) continue;
      const th = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1));
      const c = 1 / Math.sqrt(t * t + 1), sn = t * c;
      for (let k = 0; k < 3; k++) { const akp = a[k][p], akq = a[k][q]; a[k][p] = c * akp - sn * akq; a[k][q] = sn * akp + c * akq; }
      for (let k = 0; k < 3; k++) { const apk = a[p][k], aqk = a[q][k]; a[p][k] = c * apk - sn * aqk; a[q][k] = sn * apk + c * aqk; }
      for (let k = 0; k < 3; k++) { const vkp = V[k][p], vkq = V[k][q]; V[k][p] = c * vkp - sn * vkq; V[k][q] = sn * vkp + c * vkq; }
    }
  }
  const idx = [0, 1, 2].sort((x, y) => a[y][y] - a[x][x]);
  const vectors = new Float64Array(9);
  idx.forEach((c, col) => { for (let r = 0; r < 3; r++) vectors[r * 3 + col] = V[r][c]; });
  // right-handed: v3 = v1 × v2
  const v1 = [vectors[0], vectors[3], vectors[6]], v2 = [vectors[1], vectors[4], vectors[7]];
  vectors[2] = v1[1] * v2[2] - v1[2] * v2[1]; vectors[5] = v1[2] * v2[0] - v1[0] * v2[2]; vectors[8] = v1[0] * v2[1] - v1[1] * v2[0];
  return { values: [a[idx[0]][idx[0]], a[idx[1]][idx[1]], a[idx[2]][idx[2]]], vectors };
}

/** Element values averaged to the lattice nodes, sampled trilinearly anywhere inside the model. */
export class NodalField {
  readonly data: Float32Array;
  readonly weight: Float32Array;
  constructor(readonly m: VoxelModel, values: Float32Array, readonly comps: number) {
    const L = (m.nx + 1) * (m.ny + 1) * (m.nz + 1);
    this.data = new Float32Array(L * comps);
    this.weight = new Float32Array(L);
    const X = m.nx + 1, Y = m.ny + 1;
    m.cells.forEach((c, e) => {
      const i = c % m.nx, j = Math.floor(c / m.nx) % m.ny, k = Math.floor(c / (m.nx * m.ny));
      for (const [a, b, d] of HEX_OFF) {
        const n = i + a + X * (j + b + Y * (k + d));
        this.weight[n]++;
        for (let q = 0; q < comps; q++) this.data[n * comps + q] += values[e * comps + q];
      }
    });
    for (let n = 0; n < L; n++) if (this.weight[n]) for (let q = 0; q < comps; q++) this.data[n * comps + q] /= this.weight[n];
  }

  /** Trilinear sample (only nodes that carry a value count); false outside the model. */
  at(x: number, y: number, z: number, out: Float64Array | number[]): boolean {
    const m = this.m;
    const fx = (x - m.ox) / m.h, fy = (y - m.oy) / m.h, fz = (z - m.oz) / m.h;
    const i = Math.min(m.nx - 1, Math.max(0, Math.floor(fx))), j = Math.min(m.ny - 1, Math.max(0, Math.floor(fy))), k = Math.min(m.nz - 1, Math.max(0, Math.floor(fz)));
    if (fx < -0.5 || fy < -0.5 || fz < -0.5 || fx > m.nx + 0.5 || fy > m.ny + 0.5 || fz > m.nz + 0.5) return false;
    const tx = Math.min(1, Math.max(0, fx - i)), ty = Math.min(1, Math.max(0, fy - j)), tz = Math.min(1, Math.max(0, fz - k));
    const X = m.nx + 1, Y = m.ny + 1;
    let wsum = 0;
    for (let q = 0; q < this.comps; q++) out[q] = 0;
    for (const [a, b, d] of HEX_OFF) {
      const n = i + a + X * (j + b + Y * (k + d));
      if (!this.weight[n]) continue;
      const w = (a ? tx : 1 - tx) * (b ? ty : 1 - ty) * (d ? tz : 1 - tz);
      if (w <= 0) continue;
      wsum += w;
      for (let q = 0; q < this.comps; q++) out[q] += w * this.data[n * this.comps + q];
    }
    if (wsum < 1e-9) return false;
    for (let q = 0; q < this.comps; q++) out[q] /= wsum;
    return true;
  }
}

/** Value at the p-quantile of an array (0 ≤ p ≤ 1). */
export function quantile(values: ArrayLike<number>, p: number): number {
  const a = Float64Array.from(values as ArrayLike<number>).sort();
  if (!a.length) return 0;
  return a[Math.min(a.length - 1, Math.max(0, Math.round(p * (a.length - 1))))];
}
