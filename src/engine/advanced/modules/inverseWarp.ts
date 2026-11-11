// #16 Inverse thermal-shrinkage warping by the inherent-strain method. The part is built in height
// bands on the voxel FEA model: each band is activated and given the inherent (cooling) strain
// ε* = −s(1, 1, ζ, 0, 0, 0) while the part is held by the bed, the band displacements add up; then the
// bed reaction is released (3-2-1 support) to give the final distortion u. The toolpath is pre-distorted
// by x′ = x − g·u(x) in the layer plane, and long thick sections get stress-relief kerfs (short gaps in
// the interior infill) that break the continuous shrinkage path.
import { HEX_OFF, latticeIndex, nodePos, solveElastic, stiffnessOp, hexMatrices, isoC, type VoxelModel } from '../fea';
import type { Op } from '../classic/gcode';
import { moveLike, type Move } from '../runs';
import type { SessionCtx, TechModule } from '../session';
import { partModel, PLA } from '../stress';

/** Linear cooling shrinkage of common filaments (bead direction). */
export function shrinkOf(type: string): number {
  const t = type.toUpperCase();
  if (/PP\b|^PP/.test(t)) return 0.015;
  if (/PA|NYLON/.test(t)) return 0.012;
  if (/PC/.test(t)) return 0.008;
  if (/ABS/.test(t)) return 0.007;
  if (/ASA/.test(t)) return 0.006;
  if (/PETG/.test(t)) return 0.004;
  if (/TPU/.test(t)) return 0.002;
  return 0.003; // PLA
}

/** Trilinear sample of nodal displacements (3 per node) at a point; zeros where no node carries a value. */
export function sampleU(m: VoxelModel, u: Float64Array, x: number, y: number, z: number, out = [0, 0, 0]): number[] {
  const fx = (x - m.ox) / m.h, fy = (y - m.oy) / m.h, fz = (z - m.oz) / m.h;
  const i = Math.min(m.nx - 1, Math.max(0, Math.floor(fx))), j = Math.min(m.ny - 1, Math.max(0, Math.floor(fy))), k = Math.min(m.nz - 1, Math.max(0, Math.floor(fz)));
  const tx = Math.min(1, Math.max(0, fx - i)), ty = Math.min(1, Math.max(0, fy - j)), tz = Math.min(1, Math.max(0, fz - k));
  out[0] = out[1] = out[2] = 0;
  let ws = 0;
  for (const [a, b, d] of HEX_OFF) {
    const n = m.nodeOf[latticeIndex(m, i + a, j + b, k + d)];
    if (n < 0) continue;
    const w = (a ? tx : 1 - tx) * (b ? ty : 1 - ty) * (d ? tz : 1 - tz);
    ws += w;
    for (let q = 0; q < 3; q++) out[q] += w * u[n * 3 + q];
  }
  if (ws > 1e-9) for (let q = 0; q < 3; q++) out[q] /= ws;
  return out;
}

export interface WarpPrediction { m: VoxelModel; u: Float64Array; maxXY: number; curl: number; bands: number; iterations: number }

/** Inherent-strain prediction of the final distortion of a part. */
export function predictWarp(m: VoxelModel, shrink: number, bands = 4): WarpPrediction {
  const ne = m.cells.length, N = m.nodes * 3;
  const ez = new Float32Array(ne);
  m.cells.forEach((c, e) => { ez[e] = Math.floor(c / (m.nx * m.ny)); });
  const kmax = m.nz;
  const eps = [-shrink, -shrink, -0.3 * shrink, 0, 0, 0];
  const total = new Float64Array(N);
  const bed = new Uint8Array(m.nodes);
  for (let n = 0; n < m.nodes; n++) if (nodePos(m, n)[2] <= m.oz + 1e-6) bed[n] = 7;
  let iterations = 0;
  const cut = (b: number) => Math.round((kmax * b) / bands);
  for (let b = 0; b < bands; b++) {
    const scale = new Float32Array(ne), eigen = new Float64Array(ne * 6);
    const used = new Uint8Array(m.nodes);
    for (let e = 0; e < ne; e++) {
      if (ez[e] >= cut(b + 1)) continue;
      scale[e] = 1;
      for (let a = 0; a < 8; a++) used[m.en[e * 8 + a]] = 1;
      if (ez[e] >= cut(b)) for (let q = 0; q < 6; q++) eigen[e * 6 + q] = eps[q];
    }
    const fixed = new Uint8Array(m.nodes);
    for (let n = 0; n < m.nodes; n++) fixed[n] = bed[n] || !used[n] ? 7 : 0;
    const sol = solveElastic(m, { ...PLA, fixed, eigen, scale, tol: 1e-5, maxIter: 2500 });
    iterations += sol.iterations;
    for (let i = 0; i < N; i++) total[i] += sol.u[i];
  }
  // release: the bed's reaction R = K u − f* at the bed nodes, applied reversed on a 3-2-1 support
  const { K, F } = hexMatrices(isoC(PLA.E, PLA.nu), m.h);
  const Ku = new Float64Array(N);
  stiffnessOp(m, K)(total, Ku);
  for (let e = 0; e < ne; e++) for (let a = 0; a < 8; a++) {
    const n = m.en[e * 8 + a] * 3;
    for (let d = 0; d < 3; d++) { let v = 0; for (let j = 0; j < 6; j++) v += F[(a * 3 + d) * 6 + j] * eps[j]; Ku[n + d] -= v; }
  }
  const f = new Float64Array(N);
  const bedNodes: number[] = [];
  for (let n = 0; n < m.nodes; n++) if (bed[n]) { bedNodes.push(n); for (let d = 0; d < 3; d++) f[n * 3 + d] = -Ku[n * 3 + d]; }
  let maxXY = 0, curl = 0;
  if (bedNodes.length >= 3) {
    // 3-2-1: the bed node nearest the centre fixed, one along x free in x, one more free in x and y
    const P = bedNodes.map((n) => nodePos(m, n));
    const cx = P.reduce((s, p) => s + p[0], 0) / P.length, cy = P.reduce((s, p) => s + p[1], 0) / P.length;
    const byD = bedNodes.map((n, i) => ({ n, d: Math.hypot(P[i][0] - cx, P[i][1] - cy), p: P[i] })).sort((a, b) => a.d - b.d);
    const n0 = byD[0];
    const n1 = byD.reduce((b, q) => (Math.abs(q.p[1] - n0.p[1]) < m.h * 0.5 && Math.abs(q.p[0] - n0.p[0]) > Math.abs(b.p[0] - n0.p[0]) ? q : b), byD[1]);
    const n2 = byD.reduce((b, q) => (Math.abs(q.p[1] - n0.p[1]) > Math.abs(b.p[1] - n0.p[1]) ? q : b), byD[1]);
    const fixed = new Uint8Array(m.nodes);
    fixed[n0.n] = 7; fixed[n1.n] |= 6; fixed[n2.n] |= 4;
    const rel = solveElastic(m, { ...PLA, fixed, f, tol: 1e-5, maxIter: 3000 });
    iterations += rel.iterations;
    for (let i = 0; i < N; i++) total[i] += rel.u[i];
  }
  let zlo = Infinity, zhi = -Infinity;
  for (let n = 0; n < m.nodes; n++) {
    maxXY = Math.max(maxXY, Math.hypot(total[n * 3], total[n * 3 + 1]));
    if (bed[n]) { zlo = Math.min(zlo, total[n * 3 + 2]); zhi = Math.max(zhi, total[n * 3 + 2]); }
  }
  curl = Number.isFinite(zhi) ? zhi - zlo : 0;
  return { m, u: total, maxXY, curl, bands, iterations };
}

const KERF = new Set(['sparse_infill', 'internal_solid_infill']);

export const inverseWarp: TechModule = {
  id: 'inverse_warp',
  post(s: SessionCtx, layers) {
    const r = s.report('inverse_warp');
    const gain = s.pnum('inverse_warp', 'gain');
    const type = s.filaments[0]?.type ?? 'PLA';
    const shrink = shrinkOf(type) * (s.caps.heatedChamber ? 0.6 : 1);
    const preds = s.parts.map((a) => predictWarp(partModel(a, s.pnum('inverse_warp', 'elements')), shrink));
    const tmp = [0, 0, 0];
    let moved = 0, maxShift = 0;
    for (const L of layers) for (const op of L.ops) {
      if (op.k !== 'move') continue;
      // the object this point belongs to: the first whose box holds it
      const p = preds.find((q) => op.x >= q.m.ox - 1 && op.y >= q.m.oy - 1 && op.x <= q.m.ox + q.m.nx * q.m.h + 1 && op.y <= q.m.oy + q.m.ny * q.m.h + 1);
      if (!p) continue;
      sampleU(p.m, p.u, op.x, op.y, Math.max(p.m.oz, op.z - op.h / 2), tmp);
      const dx = -gain * tmp[0], dy = -gain * tmp[1];
      if (Math.abs(dx) + Math.abs(dy) < 1e-5) continue;
      op.x = +(op.x + dx).toFixed(4); op.y = +(op.y + dy).toFixed(4);
      maxShift = Math.max(maxShift, Math.hypot(dx, dy));
      moved++;
    }
    // stress-relief kerfs across long thick sections: 0.6 mm gaps in the interior infill every `pitch`
    let kerfs = 0;
    if (s.param('inverse_warp', 'kerfs') === true) {
      const pitch = 20, gap = 0.6;
      for (const L of layers.slice(1)) {
        const out: Op[] = [];
        let px = NaN, py = NaN;
        for (const op of L.ops) {
          if (op.k !== 'move' || op.travel || op.e <= 0 || !KERF.has(op.feature) || Number.isNaN(px)) { if (op.k === 'move') { px = op.x; py = op.y; } out.push(op); continue; }
          const ka = Math.floor(px / pitch), kb = Math.floor(op.x / pitch);
          const len = Math.hypot(op.x - px, op.y - py);
          if (ka !== kb && len > 3 * gap) {
            const xk = (Math.max(ka, kb)) * pitch, t = (xk - px) / (op.x - px);
            const cx = px + (op.x - px) * t, cy = py + (op.y - py) * t;
            const deep = s.parts.some((a) => -a.sdf.sdf.sample(cx, cy, op.z - op.h / 2) >= 2.5 && -a.sdf.sdf.sample(cx, cy + 2, op.z - op.h / 2) >= 1.5 && -a.sdf.sdf.sample(cx, cy - 2, op.z - op.h / 2) >= 1.5);
            if (deep) {
              const t0 = Math.max(0, t - gap / 2 / len), t1 = Math.min(1, t + gap / 2 / len);
              const ax = px + (op.x - px) * t0, ay = py + (op.y - py) * t0, bx = px + (op.x - px) * t1, by = py + (op.y - py) * t1;
              out.push(moveLike(op as Move, ax, ay, op.z, op.e * t0));
              out.push({ ...(op as Move), x: bx, y: by, e: 0, travel: true, feature: 'travel', w: 0 });
              out.push(moveLike(op as Move, op.x, op.y, op.z, op.e * (1 - t1)));
              kerfs++;
              px = op.x; py = op.y;
              continue;
            }
          }
          px = op.x; py = op.y;
          out.push(op);
        }
        L.ops = out;
      }
    }
    const worst = preds.reduce((a, b) => (b.maxXY > a.maxXY ? b : a));
    r.stats = { shrink_pct: +(shrink * 100).toFixed(2), predicted_max_xy_mm: +worst.maxXY.toFixed(3), predicted_curl_mm: +worst.curl.toFixed(3), max_correction_mm: +maxShift.toFixed(3), corrected_points: moved, kerfs, cg_iterations: preds.reduce((t, p) => t + p.iterations, 0) };
    if (worst.curl > 0.3) s.warn(`Inverse warp: ${worst.curl.toFixed(2)} mm of corner curl predicted; use a brim or a warmer chamber (the layer plane cannot pre-bend it).`);
  },
};
