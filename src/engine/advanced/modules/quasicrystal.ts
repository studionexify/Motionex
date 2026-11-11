// #28 6D cut-and-project quasicrystal infill. The icosahedral quasicrystal is the projection of ℤ⁶ along
// its six five-fold axes; by de Bruijn's multigrid duality it is the arrangement of six families of
// planes normal to those axes, each spaced as a Fibonacci chain (the 1D cut-and-project of ℤ², gaps L
// and S with L/S = τ). Families whose planes lean more than maxTilt from vertical cannot be printed and
// are dropped; the frame orientation maximises the printable families and their in-plane isotropy.
import { clipLines, intersection, SCALE } from '../../clipper';
import { rasterize } from '../offsets';
import { zoneIndex } from '../types';
import type { Paths } from '../../types';
import type { SessionCtx, TechModule } from '../session';
import { designDensity, levelRegion } from './fea';

const TAU = (1 + Math.sqrt(5)) / 2;

/** The six five-fold axes of the icosahedron (unit vectors, one per ± pair). */
export function fiveFoldAxes(): [number, number, number][] {
  const raw: [number, number, number][] = [[0, 1, TAU], [0, -1, TAU], [1, TAU, 0], [-1, TAU, 0], [TAU, 0, 1], [TAU, 0, -1]];
  return raw.map(([x, y, z]) => { const l = Math.hypot(x, y, z); return [x / l, y / l, z / l]; });
}

/** Fibonacci chain positions: x_n = n + ⌊n/τ + α⌋/τ (gaps 1 and τ in Sturmian order). */
export const fibonacci = (n: number, alpha: number) => n + Math.floor(n / TAU + alpha) / TAU;
const MEAN_GAP = 1 + 1 / (TAU * TAU);

type V = [number, number, number];
const rotate = (v: V, R: number[]): V => [R[0] * v[0] + R[1] * v[1] + R[2] * v[2], R[3] * v[0] + R[4] * v[1] + R[5] * v[2], R[6] * v[0] + R[7] * v[1] + R[8] * v[2]];

/** Rotation taking `up` to +z, then turning ψ about z. */
function frame(up: V, psi: number): number[] {
  const [ux, uy, uz] = up;
  // Rodrigues from up to z
  const ax = [uy, -ux, 0], s = Math.hypot(ax[0], ax[1]), c = uz;
  let R = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  if (s > 1e-9) {
    const kx = ax[0] / s, ky = ax[1] / s;
    const t = 1 - c;
    R = [c + kx * kx * t, kx * ky * t, ky * s, kx * ky * t, c + ky * ky * t, -kx * s, -ky * s, kx * s, c];
  } else if (c < 0) R = [1, 0, 0, 0, -1, 0, 0, 0, -1];
  const cp = Math.cos(psi), sp = Math.sin(psi);
  const Z = [cp, -sp, 0, sp, cp, 0, 0, 0, 1];
  const out = new Array(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) out[i * 3 + j] += Z[i * 3 + k] * R[k * 3 + j];
  return out;
}

export interface QcOrientation { normals: V[]; tilts: number[]; score: number; aniso: number }

/** Search frame orientations: most printable families, then most isotropic in the layer, then least tilt. */
export function orientQuasicrystal(maxTiltDeg: number): QcOrientation {
  const axes = fiveFoldAxes();
  let best: QcOrientation | null = null;
  const N = 240;
  for (let k = 0; k < N; k++) {
    // Fibonacci sphere (upper half) of up directions
    const z = 1 - k / N, r = Math.sqrt(1 - z * z), ph = k * 2 * Math.PI / TAU;
    const up: V = [r * Math.cos(ph), r * Math.sin(ph), z];
    const R = frame(up, 0);
    const normals: V[] = [], tilts: number[] = [];
    for (const a of axes) {
      const n = rotate(a, R);
      const tilt = (Math.asin(Math.min(1, Math.abs(n[2]))) * 180) / Math.PI; // plane tilt from vertical
      if (tilt <= maxTiltDeg + 1e-6) { normals.push(n); tilts.push(tilt); }
    }
    if (!normals.length) continue;
    // in-plane line density by direction: A(φ) = Σ |n_xy| cos²(φ − φ_f)
    let lo = Infinity, hi = 0;
    for (let q = 0; q < 36; q++) {
      const phi = (q / 36) * Math.PI;
      let A = 0;
      for (const n of normals) { const l = Math.hypot(n[0], n[1]); A += l * Math.cos(phi - Math.atan2(n[1], n[0])) ** 2; }
      lo = Math.min(lo, A); hi = Math.max(hi, A);
    }
    const aniso = (hi - lo) / Math.max(hi, 1e-9);
    const score = normals.length * 100 - aniso * 50 - Math.max(...tilts) * 0.1;
    if (!best || score > best.score) best = { normals, tilts, score, aniso };
  }
  return best ?? { normals: [], tilts: [], score: 0, aniso: 1 };
}

/** Intersection lines of the plane families with the layer z, clipped to the region. */
export function quasicrystalLines(region: Paths, z: number, o: QcOrientation, spacing: number): Paths {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of region) for (const q of p) { minX = Math.min(minX, q.X); maxX = Math.max(maxX, q.X); minY = Math.min(minY, q.Y); maxY = Math.max(maxY, q.Y); }
  if (!Number.isFinite(minX)) return [];
  minX /= SCALE; maxX /= SCALE; minY /= SCALE; maxY /= SCALE;
  const lines: Paths = [];
  const scale = spacing / MEAN_GAP;
  o.normals.forEach((n, f) => {
    const lxy = Math.hypot(n[0], n[1]);
    const ex = n[0] / lxy, ey = n[1] / lxy, tx = -ey, ty = ex;
    const corners = [[minX, minY], [maxX, minY], [minX, maxY], [maxX, maxY]].map(([x, y]) => n[0] * x + n[1] * y + n[2] * z);
    const pLo = Math.min(...corners), pHi = Math.max(...corners);
    const alpha = (f * 0.618034 + 0.5) % 1;
    const half = Math.hypot(maxX - minX, maxY - minY);
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    for (let k = Math.floor(pLo / (scale * TAU)) - 2; ; k++) {
      const p = fibonacci(k, alpha) * scale;
      if (p > pHi + scale) break;
      if (p < pLo - scale) continue;
      // points with n·X = p in this layer: X = c + s·t with n_xy·c = p − n_z z
      const d = (p - n[2] * z - (n[0] * cx + n[1] * cy)) / lxy;
      const px = cx + ex * d, py = cy + ey * d;
      lines.push([{ X: Math.round((px - tx * half) * SCALE), Y: Math.round((py - ty * half) * SCALE) }, { X: Math.round((px + tx * half) * SCALE), Y: Math.round((py + ty * half) * SCALE) }]);
    }
  });
  return clipLines(lines, region);
}

const CORE = zoneIndex('core');
/** Core cells of the part's volume zones at this layer (true when the router puts the point in 'core'). */
function inCore(s: SessionCtx, o: number, x: number, y: number, z: number): boolean {
  const a = s.parts[o];
  const g = a.sdf.sdf, q = g.cellAt(x, y, z);
  return q >= 0 && a.voxZone[q] === CORE;
}
export { inCore };

export const quasicrystal: TechModule = {
  id: 'quasicrystal',
  infill(s, o, region, c, last) {
    const r = s.report('quasicrystal');
    const ori = s.memo('qc:orient', () => orientQuasicrystal(s.pnum('quasicrystal', 'maxTilt')));
    if (!ori.normals.length) { r.status = 'idle'; r.reason = 'No plane family within the tilt limit.'; return undefined; }
    // mean plane spacing: from the parameter, or so the line density matches the infill density
    const density = designDensity(s, c.density);
    const sumL = ori.normals.reduce((t, n) => t + Math.hypot(n[0], n[1]), 0);
    const spacing = s.pnum('quasicrystal', 'spacing') || (sumL * c.width) / density;
    let used = region;
    if (!last) {
      // the core zone (deep interior) only: elsewhere the next technology or the regular pattern
      used = coreRegion(s, o, region, c.z - c.h / 2);
      if (!used.length) return undefined;
    }
    const lines = quasicrystalLines(used, c.z - c.h / 2, ori, spacing);
    r.stats = { families: ori.normals.length, max_tilt_deg: +Math.max(...ori.tilts).toFixed(1), in_plane_anisotropy: +ori.aniso.toFixed(3), spacing_mm: +spacing.toFixed(2), lines: (Number(r.stats?.lines) || 0) + lines.length };
    return { paths: lines.map((p) => ({ pts: p.flatMap((q) => [q.X / SCALE, q.Y / SCALE]), closed: false, width: c.width })), used };
  },
};

/** Polygons of the region lying in the core zone at height z. */
export function coreRegion(s: SessionCtx, o: number, region: Paths, z: number): Paths {
  const ras = rasterize(region, Math.max(0.5, s.parts[o].sdf.sdf.h / 2));
  if (!ras) return [];
  const lr = levelRegion(ras, (x, y) => (inCore(s, o, x, y, z) ? 1 : 0), 0.5, 4);
  return lr.paths.length ? intersection(lr.paths, region) : [];
}
