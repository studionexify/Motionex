// Part stress field (#1) and its spinor frame smoothing (#33).
// Load case: painted fixture (1) and load (2) faces win; otherwise the part is held where it sits on the
// bed and at all but one of its bolt holes, and loaded at the remaining bolt hole (or its top face).
// Principal frames are smoothed as rotors in their double cover: a frame and its axis-flipped copies
// (right products with 1, i, j, k) and ±q are one orientation, averaged with the sign-blind outer
// product Σ w q qᵀ; principal directions come back through the Hopf map q ↦ q e q̄.
import type { PartAnalysis } from './analysis';
import { eigSym3, elementStress, latticeIndex, NodalField, nodePos, solveElastic, voxelModel, vonMises, type VoxelModel } from './fea';

export interface LoadCaseInfo { fixtures: number; loads: number; auto: boolean; dir: [number, number, number]; newtons: number; source: string }

export interface PartStress {
  model: VoxelModel;
  u: Float64Array;
  /** Element stresses (6 each), smoothed when the spinor pass ran. */
  sigma: Float32Array;
  field: NodalField;
  /** von Mises per element. */
  vm: Float32Array;
  load: LoadCaseInfo;
  iterations: number;
  residual: number;
  ms: number;
  spinor?: { passes: number; meanTurnDeg: number };
}

export const PLA = { E: 3500, nu: 0.35 };

/** Element size for at most `maxEl` elements in the part. */
export function partModel(a: PartAnalysis, maxEl: number): VoxelModel {
  const b = a.sdf;
  let h = Math.max(0.4, Math.cbrt(Math.max(a.volume, 1) / maxEl));
  let m: VoxelModel | null = null;
  for (let tries = 0; tries < 4; tries++) {
    const hh = h;
    // slightly dilated so walls thinner than an element keep one layer of elements
    m = voxelModel(b.min, b.max, hh, (x, y, z) => b.sdf.sample(x, y, z) < 0.25 * hh);
    if (m.cells.length <= maxEl * 1.15) break;
    h *= Math.cbrt(m.cells.length / maxEl) * 1.02;
  }
  return m!;
}

/** Surface nodes near the triangles painted with `value` (sampled every half element). */
function paintedNodes(a: PartAnalysis, m: VoxelModel, value: number): Set<number> {
  const out = new Set<number>();
  const paint = a.params.advPaint;
  if (!paint) return out;
  const v = a.mesh.vertices, ix = a.mesh.indices, h = m.h;
  const reach2 = (0.9 * h) ** 2;
  const mark = (x: number, y: number, z: number) => {
    const i0 = Math.floor((x - m.ox) / h), j0 = Math.floor((y - m.oy) / h), k0 = Math.floor((z - m.oz) / h);
    for (let k = k0 - 1; k <= k0 + 2; k++) for (let j = j0 - 1; j <= j0 + 2; j++) for (let i = i0 - 1; i <= i0 + 2; i++) {
      if (i < 0 || j < 0 || k < 0 || i > m.nx || j > m.ny || k > m.nz) continue;
      const n = m.nodeOf[latticeIndex(m, i, j, k)];
      if (n < 0 || m.valence[n] >= 8) continue;
      const px = m.ox + i * h, py = m.oy + j * h, pz = m.oz + k * h;
      if ((px - x) ** 2 + (py - y) ** 2 + (pz - z) ** 2 <= reach2) out.add(n);
    }
  };
  for (let t = 0; t < paint.length; t++) {
    if (paint[t] !== value) continue;
    const A = ix[t * 3] * 3, B = ix[t * 3 + 1] * 3, C = ix[t * 3 + 2] * 3;
    const ab = Math.hypot(v[B] - v[A], v[B + 1] - v[A + 1], v[B + 2] - v[A + 2]), ac = Math.hypot(v[C] - v[A], v[C + 1] - v[A + 1], v[C + 2] - v[A + 2]);
    const n = Math.max(1, Math.ceil(Math.max(ab, ac) / (h * 0.5)));
    for (let p = 0; p <= n; p++) for (let q = 0; q <= n - p; q++) {
      const s = p / n, r = q / n;
      mark(v[A] + s * (v[B] - v[A]) + r * (v[C] - v[A]), v[A + 1] + s * (v[B + 1] - v[A + 1]) + r * (v[C + 1] - v[A + 1]), v[A + 2] + s * (v[B + 2] - v[A + 2]) + r * (v[C + 2] - v[A + 2]));
    }
  }
  return out;
}

/** Fixtures and nodal loads of a part. */
export function partLoadCase(a: PartAnalysis, m: VoxelModel, newtons: number, dir?: [number, number, number]): { fixed: Uint8Array; f: Float64Array; info: LoadCaseInfo } {
  const fixed = new Uint8Array(m.nodes);
  const f = new Float64Array(m.nodes * 3);
  const surface = (n: number) => m.valence[n] < 8;
  const paintFix = paintedNodes(a, m, 1), paintLoad = paintedNodes(a, m, 2);
  let fix = new Set<number>(), load = new Set<number>();
  const sources: string[] = [];
  const bed = new Set<number>();
  for (let n = 0; n < m.nodes; n++) if (nodePos(m, n)[2] <= m.oz + 1e-6) bed.add(n);
  const bore = (b: PartAnalysis['bosses'][number]) => {
    const s = new Set<number>();
    for (let n = 0; n < m.nodes; n++) {
      if (!surface(n)) continue;
      const [x, y, z] = nodePos(m, n);
      if (z < b.z0 - m.h || z > b.z1 + m.h) continue;
      if (Math.abs(Math.hypot(x - b.cx, y - b.cy) - b.r) <= m.h * 0.9) s.add(n);
    }
    return s;
  };
  if (paintFix.size) { fix = paintFix; sources.push('painted fixtures'); }
  else {
    fix = new Set(bed);
    sources.push('bed contact');
  }
  if (paintLoad.size) { load = paintLoad; sources.push('painted load'); }
  else {
    const bosses = a.bosses.slice();
    if (bosses.length) {
      // the bolt hole farthest from where the part is held carries the load, the others hold it
      let cx = 0, cy = 0, cz = 0;
      for (const n of fix) { const p = nodePos(m, n); cx += p[0]; cy += p[1]; cz += p[2]; }
      const k = Math.max(1, fix.size); cx /= k; cy /= k; cz /= k;
      bosses.sort((p, q) => Math.hypot(q.cx - cx, q.cy - cy, (q.z0 + q.z1) / 2 - cz) - Math.hypot(p.cx - cx, p.cy - cy, (p.z0 + p.z1) / 2 - cz));
      load = bore(bosses[0]);
      if (!paintFix.size) for (const b of bosses.slice(1)) { for (const n of bore(b)) fix.add(n); sources.push('bolt holes'); }
      sources.push('farthest bolt hole');
    }
    if (!load.size) {
      let top = -Infinity;
      for (let n = 0; n < m.nodes; n++) if (surface(n)) top = Math.max(top, nodePos(m, n)[2]);
      for (let n = 0; n < m.nodes; n++) if (surface(n) && nodePos(m, n)[2] >= top - m.h * 0.01) load.add(n);
      sources.push('top face');
    }
  }
  // a piece that touches no fixture floats free (singular stiffness, the solve cannot converge): it
  // stands on support, so hold its lowest nodes
  const root = new Int32Array(m.nodes).map((_, i) => i);
  const find = (x: number): number => { while (root[x] !== x) { root[x] = root[root[x]]; x = root[x]; } return x; };
  for (let e = 0; e < m.cells.length; e++) { const r0 = find(m.en[e * 8]); for (let q = 1; q < 8; q++) { const r = find(m.en[e * 8 + q]); if (r !== r0) root[r] = r0; } }
  const held = new Set<number>();
  for (const n of fix) held.add(find(n));
  const low = new Map<number, number>();
  for (let n = 0; n < m.nodes; n++) { const r = find(n); if (held.has(r)) continue; const z = nodePos(m, n)[2]; if (!(low.get(r)! <= z)) low.set(r, z); }
  if (low.size) {
    for (let n = 0; n < m.nodes; n++) { const r = find(n); const z0 = low.get(r); if (z0 !== undefined && nodePos(m, n)[2] <= z0 + 1e-6) fix.add(n); }
    sources.push('support under floating pieces');
  }
  for (const n of fix) load.delete(n);
  const d = dir ?? a.params.load?.dir ?? [0, 0, -1];
  const dl = Math.hypot(d[0], d[1], d[2]) || 1;
  const unit: [number, number, number] = [d[0] / dl, d[1] / dl, d[2] / dl];
  const F = a.params.load?.newtons ?? newtons;
  for (const n of fix) fixed[n] = 7;
  if (load.size) for (const n of load) for (let q = 0; q < 3; q++) f[n * 3 + q] = (unit[q] * F) / load.size;
  return { fixed, f, info: { fixtures: fix.size, loads: load.size, auto: !paintFix.size && !paintLoad.size, dir: unit, newtons: F, source: sources.join(' + ') } };
}

/** Solve the part under its load case. */
export function partStress(a: PartAnalysis, o: { maxEl: number; newtons: number; spinorPasses?: number }): PartStress | null {
  const t0 = now();
  const m = partModel(a, o.maxEl);
  if (m.cells.length < 8) return null;
  const lc = partLoadCase(a, m, o.newtons);
  if (!lc.info.fixtures || !lc.info.loads) return null;
  const sol = solveElastic(m, { ...PLA, fixed: lc.fixed, f: lc.f, tol: 1e-5, maxIter: 3000 });
  let sigma = elementStress(m, sol.u, PLA.E, PLA.nu);
  let spinor: PartStress['spinor'];
  if (o.spinorPasses && o.spinorPasses > 0) { const s = smoothFrames(m, sigma, o.spinorPasses); sigma = s.sigma; spinor = { passes: o.spinorPasses, meanTurnDeg: s.meanTurnDeg }; }
  const vm = new Float32Array(m.cells.length);
  for (let e = 0; e < vm.length; e++) vm[e] = vonMises(sigma, e * 6);
  return { model: m, u: sol.u, sigma, field: new NodalField(m, sigma, 6), vm, load: lc.info, iterations: sol.iterations, residual: sol.residual, ms: now() - t0, spinor };
}

// ---------------------------------------------------------------- rotors (unit quaternions w, x, y, z)

type Q = [number, number, number, number];

/** Rotor of a right-handed rotation matrix (columns = frame axes, row-major 3×3). */
export function rotorOf(R: ArrayLike<number>): Q {
  const m00 = R[0], m01 = R[1], m02 = R[2], m10 = R[3], m11 = R[4], m12 = R[5], m20 = R[6], m21 = R[7], m22 = R[8];
  const tr = m00 + m11 + m22;
  let q: Q;
  if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; q = [0.25 * s, (m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s]; }
  else if (m00 > m11 && m00 > m22) { const s = Math.sqrt(1 + m00 - m11 - m22) * 2; q = [(m21 - m12) / s, 0.25 * s, (m01 + m10) / s, (m02 + m20) / s]; }
  else if (m11 > m22) { const s = Math.sqrt(1 + m11 - m00 - m22) * 2; q = [(m02 - m20) / s, (m01 + m10) / s, 0.25 * s, (m12 + m21) / s]; }
  else { const s = Math.sqrt(1 + m22 - m00 - m11) * 2; q = [(m10 - m01) / s, (m02 + m20) / s, (m12 + m21) / s, 0.25 * s]; }
  const l = Math.hypot(...q);
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

const qmul = (a: Q, b: Q): Q => [
  a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
  a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
  a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
  a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
];

/** Hopf map S³ → S²: the image q e q̄ of a unit axis e under the rotor. */
export function hopf(q: Q | ArrayLike<number>, e: [number, number, number]): [number, number, number] {
  const p = qmul(qmul(q as Q, [0, e[0], e[1], e[2]]), [q[0], -q[1], -q[2], -q[3]]);
  return [p[1], p[2], p[3]];
}

/** The four rotors of one principal frame up to axis signs (q·1, q·i, q·j, q·k). */
const variants = (q: Q): Q[] => [q, qmul(q, [0, 1, 0, 0]), qmul(q, [0, 0, 1, 0]), qmul(q, [0, 0, 0, 1])];

/** Smooth the principal frames of an element stress field (eigenvalues kept). */
export function smoothFrames(m: VoxelModel, sigma: Float32Array, passes: number): { sigma: Float32Array; meanTurnDeg: number } {
  const ne = m.cells.length;
  const vals = new Float64Array(ne * 3), q = new Float64Array(ne * 4), w = new Float64Array(ne);
  for (let e = 0; e < ne; e++) {
    const { values, vectors } = eigSym3(sigma, e * 6);
    vals.set(values, e * 3);
    q.set(rotorOf(vectors), e * 4);
    w[e] = values[0] - values[2] + 1e-9;
  }
  const q0 = Float64Array.from(q);
  const nb = (e: number): number[] => {
    const c = m.cells[e], i = c % m.nx, j = Math.floor(c / m.nx) % m.ny, k = Math.floor(c / (m.nx * m.ny));
    const out: number[] = [];
    for (const [di, dj, dk] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      const a = i + di, b = j + dj, d = k + dk;
      if (a < 0 || b < 0 || d < 0 || a >= m.nx || b >= m.ny || d >= m.nz) continue;
      const n = m.elemOf[a + m.nx * (b + m.ny * d)];
      if (n >= 0) out.push(n);
    }
    return out;
  };
  const nbs = Array.from({ length: ne }, (_, e) => nb(e));
  const M = new Float64Array(16);
  for (let pass = 0; pass < passes; pass++) {
    const next = new Float64Array(q.length);
    for (let e = 0; e < ne; e++) {
      const qe = [q[e * 4], q[e * 4 + 1], q[e * 4 + 2], q[e * 4 + 3]] as Q;
      M.fill(0);
      const add = (r: Q, wt: number) => { for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) M[a * 4 + b] += wt * r[a] * r[b]; };
      add(qe, w[e]);
      for (const n of nbs[e]) {
        const qn = [q[n * 4], q[n * 4 + 1], q[n * 4 + 2], q[n * 4 + 3]] as Q;
        // the frame variant closest to this one (|q·q'| is blind to the double cover's sign)
        let best = qn, bd = -1;
        for (const v of variants(qn)) { const d = Math.abs(v[0] * qe[0] + v[1] * qe[1] + v[2] * qe[2] + v[3] * qe[3]); if (d > bd) { bd = d; best = v; } }
        add(best, w[n]);
      }
      // dominant eigenvector of M by power iteration from the current rotor
      let x = qe.slice() as Q;
      for (let it = 0; it < 12; it++) {
        const y: Q = [0, 0, 0, 0];
        for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) y[a] += M[a * 4 + b] * x[b];
        const l = Math.hypot(...y) || 1;
        x = [y[0] / l, y[1] / l, y[2] / l, y[3] / l];
      }
      next.set(x, e * 4);
    }
    q.set(next);
  }
  const out = new Float32Array(ne * 6);
  let turn = 0;
  for (let e = 0; e < ne; e++) {
    const r = [q[e * 4], q[e * 4 + 1], q[e * 4 + 2], q[e * 4 + 3]] as Q;
    const d1 = hopf(r, [1, 0, 0]), d2 = hopf(r, [0, 1, 0]), d3 = hopf(r, [0, 0, 1]);
    const l1 = vals[e * 3], l2 = vals[e * 3 + 1], l3 = vals[e * 3 + 2];
    const S = (a: number, b: number) => l1 * d1[a] * d1[b] + l2 * d2[a] * d2[b] + l3 * d3[a] * d3[b];
    out[e * 6] = S(0, 0); out[e * 6 + 1] = S(1, 1); out[e * 6 + 2] = S(2, 2); out[e * 6 + 3] = S(1, 2); out[e * 6 + 4] = S(0, 2); out[e * 6 + 5] = S(0, 1);
    const o = [q0[e * 4], q0[e * 4 + 1], q0[e * 4 + 2], q0[e * 4 + 3]] as Q;
    let bd = 0;
    for (const v of variants(o)) bd = Math.max(bd, Math.abs(v[0] * r[0] + v[1] * r[1] + v[2] * r[2] + v[3] * r[3]));
    turn += 2 * Math.acos(Math.min(1, bd));
  }
  return { sigma: out, meanTurnDeg: ((turn / Math.max(1, ne)) * 180) / Math.PI };
}

/** von Mises stress at a point (0 outside the model). */
export function vmAt(ps: PartStress, x: number, y: number, z: number, tmp: number[] = [0, 0, 0, 0, 0, 0]): number {
  return ps.field.at(x, y, z, tmp) ? vonMises(tmp) : 0;
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
