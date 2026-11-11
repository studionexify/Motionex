// Harmonic scalar field dome slicing (#24). Solves Laplace ∇²φ = 0 in the part with φ = 0 where it
// stands on the bed and φ = 1 on its domes (zero flux elsewhere). Isosurfaces of φ start flat on the
// bed and morph into shells parallel to the domes; they become the layers, limited per column by the
// machine's head clearance and the allowed layer-thickness range.
import { zoneIndex } from './types';
import type { PartAnalysis } from './analysis';
import { laplace3 } from './solvers';
import { DisplacementField } from './warp';
import { smoothstep } from './grid';

export interface HarmonicResult {
  phi: Float32Array;
  /** Dirichlet cells: 1 bed (φ = 0), 2 dome (φ = 1). */
  bc: Uint8Array;
  domeCells: number;
  iterations: number;
}

/** Cells next to dome / shallow-slope triangles get φ = 1, the bottom cells φ = 0. */
export function harmonicField(a: PartAnalysis): HarmonicResult | null {
  const g = a.sdf.sdf, inside = a.sdf.inside;
  const kind = new Uint8Array(g.n), fixed = new Float32Array(g.n), bc = new Uint8Array(g.n);
  for (let p = 0; p < g.n; p++) if (inside[p]) kind[p] = 1;
  // bed contact: the lowest inside cell of every column that stands on the bed
  const zBed = a.sdf.min[2] + g.h * 1.5;
  for (let j = 0; j < g.ny; j++) for (let i = 0; i < g.nx; i++) {
    for (let k = 0; k < g.nz; k++) {
      if (g.z(k) > zBed) break;
      const p = g.idx(i, j, k);
      if (inside[p]) { kind[p] = 2; fixed[p] = 0; bc[p] = 1; break; }
    }
  }
  const s = a.surf;
  const domeZ = new Set([zoneIndex('dome'), zoneIndex('shallow')]);
  let domeCells = 0;
  const mark = (x: number, y: number, z: number) => {
    const p = g.cellAt(x, y, z);
    if (p < 0 || !inside[p] || bc[p] === 1) return;
    if (bc[p] !== 2) domeCells++;
    kind[p] = 2; fixed[p] = 1; bc[p] = 2;
  };
  const v = a.mesh.vertices, ix = a.mesh.indices;
  for (let t = 0; t < s.triCount; t++) {
    if (!domeZ.has(a.triZone[t])) continue;
    const nx = s.normal[t * 3], ny = s.normal[t * 3 + 1], nz = s.normal[t * 3 + 2];
    const d = g.h * 0.6;
    const pts: [number, number, number][] = [[s.centroid[t * 3], s.centroid[t * 3 + 1], s.centroid[t * 3 + 2]]];
    for (let c = 0; c < 3; c++) { const q = ix[t * 3 + c] * 3; pts.push([(v[q] + s.centroid[t * 3]) / 2, (v[q + 1] + s.centroid[t * 3 + 1]) / 2, (v[q + 2] + s.centroid[t * 3 + 2]) / 2]); }
    for (const [x, y, z] of pts) mark(x - nx * d, y - ny * d, z - nz * d);
  }
  if (!domeCells) return null;
  // initial guess: normalised height (fast convergence)
  const guess = new Float32Array(g.n);
  const H = Math.max(1e-6, a.sdf.max[2] - a.sdf.min[2]);
  for (let k = 0; k < g.nz; k++) for (let p = k * g.nx * g.ny; p < (k + 1) * g.nx * g.ny; p++) guess[p] = (g.z(k) - a.sdf.min[2]) / H;
  const res = laplace3(g.nx, g.ny, g.nz, kind, fixed, 1e-6, 3000, guess);
  for (let p = 0; p < g.n; p++) if (!inside[p]) res.phi[p] = 0;
  return { phi: res.phi, bc, domeCells, iterations: res.iterations };
}

export interface DomeOptions {
  maxSlopeDeg: number;
  minRatio: number;
  maxRatio: number;
  /** Morph band height (mm); 0 = automatic (dome height + 2 mm). */
  band: number;
  /** Projection rounds onto the slope and thickness limits (0: raw φ layers, for diagnostics). */
  rounds?: number;
}

/**
 * Displacement field whose flat warped layers are φ isosurfaces in the dome band, scaled per column
 * to the head's clearance and then globally until slope and thickness limits hold everywhere.
 */
export function domeWarp(a: PartAnalysis, hr: HarmonicResult, o: DomeOptions): { field: DisplacementField; conformity: number; scale: number } | null {
  const g = a.sdf.sdf;
  const zMin = a.sdf.min[2], H = a.sdf.max[2] - zMin;
  if (H <= 0) return null;
  const hz = g.h;
  const nzw = Math.ceil((zMin + H + 2 * hz) / hz) + 1;
  const field = new DisplacementField(g.nx, g.ny, nzw, g.ox, g.oy, g.h, hz, 'harmonic_dome');
  // dome height range for the automatic band
  let domeLo = Infinity;
  for (let p = 0; p < g.n; p++) if (hr.bc[p] === 2) domeLo = Math.min(domeLo, g.z(Math.floor(p / (g.nx * g.ny))));
  const band = o.band > 0 ? o.band : Math.min(H, H - (domeLo - zMin) + 2);
  const w = (zw: number) => (band >= H ? 1 : smoothstep((zw - zMin - (H - band)) / band));
  // columns without material are free: they take whatever the part's layers extend to (−∞ = unset)
  const raw = new Float32Array(field.d.length).fill(-Infinity);
  const colTop = new Float32Array(g.nx * g.ny);
  for (let j = 0; j < g.ny; j++) for (let i = 0; i < g.nx; i++) {
    // monotone φ(z) along the column, from the bed (z = zMin, φ = 0) to the column's top surface
    const zs: number[] = [zMin], ph: number[] = [0];
    let top = -Infinity, topDome = false;
    for (let k = 0; k < g.nz; k++) {
      const p = g.idx(i, j, k);
      if (!a.sdf.inside[p]) continue;
      const z = g.z(k);
      top = z;
      // Dirichlet cells stand for their boundary: φ = 0 is the bed itself, φ = 1 the dome surface
      if (hr.bc[p] === 1) continue;
      if (hr.bc[p] === 2) { topDome = true; continue; }
      if (z <= zs[zs.length - 1]) continue;
      zs.push(z); ph.push(Math.max(ph[ph.length - 1] + 1e-7, Math.min(hr.phi[p], 1 - 1e-6)));
    }
    if (top === -Infinity) continue;
    const surf = a.surf.grid.topAt(g.x(i), g.y(j));
    const T = Number.isFinite(surf) ? Math.max(surf, top) : top + g.h / 2;
    // a dome column reaches φ = 1 on its surface; any other column keeps its top value (zero flux)
    const phiTop = topDome ? 1 : ph[ph.length - 1];
    zs.push(Math.max(T, zs[zs.length - 1] + 1e-6)); ph.push(Math.max(phiTop, ph[ph.length - 1] + 1e-7));
    colTop[i + g.nx * j] = T;
    const pTop = ph[ph.length - 1];
    for (let k = 0; k < nzw; k++) {
      const zw = k * hz;
      const target = (zw - zMin) / H;
      let z: number;
      if (target <= 0) z = zw;
      else if (target >= pTop) z = T + (zw - zMin - H * pTop);
      else {
        let m = 1;
        while (m < ph.length - 1 && ph[m] < target) m++;
        const t = (target - ph[m - 1]) / Math.max(1e-12, ph[m] - ph[m - 1]);
        z = zs[m - 1] + (zs[m] - zs[m - 1]) * t;
      }
      // above the column's material the layer passes through empty space: leave it free (−∞)
      raw[field.idx(i, j, k)] = z > T + hz ? -Infinity : (z - zw) * w(zw);
    }
  }
  // limits as projections, alternated a few times:
  //  · slope: each warped layer becomes the closest surface above the φ layer whose slope never exceeds
  //    the head's clearance (Lipschitz envelope, two chamfer sweeps with diagonals at h√2)
  //  · thickness: along each column, consecutive layers keep their ratio within [min, max]
  const L = Math.tan((o.maxSlopeDeg * 0.75 * Math.PI) / 180) * g.h, Ld = L * Math.SQRT2;
  const S = g.nx * g.ny;
  const d = field.d;
  d.set(raw);
  const lay = new Float32Array(S);
  const lo = (o.minRatio - 1) * hz * 0.98, hi = (o.maxRatio - 1) * hz * 0.98;
  for (let round = 0; round < (o.rounds ?? 4); round++) {
    for (let q = 0; q < S; q++) for (let k = 1; k < nzw; k++) {
      if (d[(k - 1) * S + q] === -Infinity) continue;
      const a = d[(k - 1) * S + q];
      const v = d[k * S + q];
      d[k * S + q] = Math.min(a + hi, Math.max(a + lo, v));
    }
    for (let k = 0; k < nzw; k++) {
      for (let q = 0; q < S; q++) lay[q] = d[k * S + q];
      for (let pass = 0; pass < 2; pass++) {
        for (let j = 0; j < g.ny; j++) for (let i = 0; i < g.nx; i++) {
          const q = i + g.nx * j;
          let v = lay[q];
          if (i > 0) v = Math.max(v, lay[q - 1] - L);
          if (j > 0) { v = Math.max(v, lay[q - g.nx] - L); if (i > 0) v = Math.max(v, lay[q - g.nx - 1] - Ld); if (i < g.nx - 1) v = Math.max(v, lay[q - g.nx + 1] - Ld); }
          lay[q] = v;
        }
        for (let j = g.ny - 1; j >= 0; j--) for (let i = g.nx - 1; i >= 0; i--) {
          const q = i + g.nx * j;
          let v = lay[q];
          if (i < g.nx - 1) v = Math.max(v, lay[q + 1] - L);
          if (j < g.ny - 1) { v = Math.max(v, lay[q + g.nx] - L); if (i < g.nx - 1) v = Math.max(v, lay[q + g.nx + 1] - Ld); if (i > 0) v = Math.max(v, lay[q + g.nx - 1] - Ld); }
          lay[q] = v;
        }
      }
      for (let q = 0; q < S; q++) d[k * S + q] = lay[q];
    }
  }
  for (let q = 0; q < d.length; q++) if (!Number.isFinite(d[q])) d[q] = 0;
  // limits only matter where layers run through material
  const material = new Uint8Array(d.length);
  for (let q = 0; q < d.length; q++) if (Number.isFinite(raw[q])) material[q] = 1;
  // the envelope is per layer: a mild global scale keeps the layer-thickness ratio in range
  const tanMax = Math.tan((o.maxSlopeDeg * 0.8 * Math.PI) / 180);
  let scale = 1;
  for (let it = 0; it < 30; it++) {
    const st = field.scaled(scale).stats(material);
    if (st.maxSlope <= tanMax && st.minRatio >= o.minRatio && st.maxRatio <= o.maxRatio) break;
    scale *= 0.9;
  }
  const out = scale < 1 ? field.scaled(scale) : field;
  out.material = material;
  // conformity: share of the domes' height drop (under the top layer) that the curved top layer follows
  let num = 0, den = 0;
  for (let q = 0; q < S; q++) {
    if (!colTop[q]) continue;
    // the column's highest level still in material
    let kt = -1;
    for (let k = nzw - 1; k >= 0; k--) if (Number.isFinite(raw[k * S + q])) { kt = k; break; }
    if (kt < 0) continue;
    const want = raw[kt * S + q];
    if (want < -1e-3) { num += Math.max(0, -out.d[kt * S + q]); den += -want; }
  }
  return { field: out, conformity: den ? num / den : 0, scale };
}
