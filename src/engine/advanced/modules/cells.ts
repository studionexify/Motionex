// #35 homogenization (cell design) and #12 voxel metamaterial (graded re-entrant auxetic cells).
// The homogenization pass computes the effective stiffness tensor C^H of the infill cell by periodic
// voxel FEA and inverts it for the cell parameters that hit the target stiffness and Poisson ratio:
// the gyroid solid fraction for E (power-law fit E = C ρⁿ through two homogenized cells, verified by a
// third), and the re-entrant angle for a negative ν. Bolt-hole hubs get twice the target stiffness.
import { clipLines, SCALE } from '../../clipper';
import type { Paths } from '../../types';
import { sparseFill } from '../classic/fill';
import { engineering, gibsonAshbyNu, gyroidCell, homogenize, homogenize2D, reentrantCell } from '../homogenize';
import type { InfillPath, TechModule } from '../session';
import { PLA } from '../stress';
import { designDensity, stressOf } from './fea';

export interface CellDesign { density: number; achievedE: number; targetE: number; reentrantAngle?: number; nu?: number; C11: number; C12: number; C44: number; zener: number }

const cache = new Map<string, unknown>();
const cached = <T>(k: string, f: () => T): T => { if (!cache.has(k)) cache.set(k, f()); return cache.get(k) as T; };

/** Gyroid modulus (relative to solid) at a solid fraction, by homogenization (8³ voxels). */
const gyroidE = (rho: number) => cached(`gy:${rho.toFixed(3)}`, () => engineering(homogenize(gyroidCell(8, rho), 1, PLA.nu, [0, 1, 2, 3, 4, 5], 1e-4)));

export function designGyroid(targetRel: number): { density: number; e: ReturnType<typeof engineering> } {
  const a = 0.15, b = 0.45;
  const Ea = gyroidE(a).Ex, Eb = gyroidE(b).Ex;
  const n = Math.log(Eb / Ea) / Math.log(b / a), C = Ea / a ** n;
  const rho = Math.max(0.08, Math.min(0.9, (targetRel / C) ** (1 / n)));
  const r = Math.round(rho * 100) / 100;
  return { density: r, e: gyroidE(r) };
}

/** Homogenized in-plane Poisson ratio of the re-entrant cell at an angle. */
const reNu = (angle: number) => cached(`re:${angle}`, () => homogenize2D(reentrantCell(16, angle, 0.09), 1, PLA.nu).nuyx);

/**
 * Re-entrant angle for a target Poisson ratio: bisection on the homogenized ratio (ν rises towards 0
 * as the cell opens up), starting from the Gibson–Ashby thin-strut bracket.
 */
export function designReentrant(targetNu: number): { angle: number; nu: number; analytic: number } {
  let lo = 40, hi = 86;
  let best = { angle: 60, nu: reNu(60) };
  for (let it = 0; it < 5; it++) {
    const mid = Math.round((lo + hi) / 2);
    const nu = reNu(mid);
    if (Math.abs(nu - targetNu) < Math.abs(best.nu - targetNu)) best = { angle: mid, nu };
    if (nu < targetNu) lo = mid; else hi = mid;
    if (hi - lo <= 1) break;
  }
  return { ...best, analytic: gibsonAshbyNu(best.angle) };
}

export const homogenization: TechModule = {
  id: 'homogenization',
  prepare(s) {
    const r = s.report('homogenization');
    const tE = s.pnum('homogenization', 'targetE'), tNu = s.pnum('homogenization', 'targetNu');
    const g = designGyroid(tE);
    const C = cached(`gyC:${g.density}`, () => homogenize(gyroidCell(8, g.density), PLA.E, PLA.nu, [0, 1, 2, 3, 4, 5], 1e-4));
    const d: CellDesign = { density: g.density, achievedE: g.e.Ex, targetE: tE, C11: C[0], C12: C[1], C44: C[21], zener: g.e.zener };
    if (tNu < 0 && s.on('metamaterial')) {
      const re = designReentrant(tNu);
      d.reentrantAngle = re.angle; d.nu = re.nu;
    }
    s.shared.set('cellDesign', d);
    r.stats = {
      gyroid_density: d.density, E_target_rel: tE, E_homogenized_rel: +d.achievedE.toFixed(3),
      C11_MPa: +d.C11.toFixed(0), C12_MPa: +d.C12.toFixed(0), C44_MPa: +d.C44.toFixed(0), zener_anisotropy: +d.zener.toFixed(2),
      ...(d.reentrantAngle ? { reentrant_angle_deg: d.reentrantAngle, poisson_homogenized: +d.nu!.toFixed(2) } : {}),
    };
    if (tNu < 0 && !s.on('metamaterial')) r.reason = 'A negative Poisson ratio needs Auxetic cell infill (Vibration-damping infill).';
  },
  infill(s, o, region, c) {
    const d = s.shared.get('cellDesign') as CellDesign | undefined;
    if (!d) return undefined;
    return sparseFill(region, 'gyroid', c.width, d.density, c.layer, c.z, 0).map((p) => ({ ...p, width: c.width }));
  },
};

const PHI = (1 + Math.sqrt(5)) / 2;

/** Re-entrant honeycomb rows over a box, aperiodically dithered by the golden ratio. */
export function reentrantLines(minX: number, minY: number, maxX: number, maxY: number, cell: number, angleDeg: number, dither: number, phase = 0): number[][] {
  const th = -((90 - angleDeg) * Math.PI) / 180;
  const l = cell / 2 / Math.cos(th), hv = 2 * l, ls = l * Math.sin(th);
  // shared column positions X_m and row positions Y_j, each step stretched by the golden-ratio sequence
  const xs: number[] = [minX - cell];
  for (let m = 0; xs[xs.length - 1] < maxX + cell; m++) xs.push(xs[xs.length - 1] + l * Math.cos(th) * (1 + dither * 0.5 * (((m * PHI + phase) % 1) - 0.5)));
  const ys: number[] = [minY - 2 * cell];
  for (let j = 0; ys[ys.length - 1] < maxY + 2 * cell; j++) ys.push(ys[ys.length - 1] + (hv * (1 + dither * (((j * PHI * PHI + phase) % 1) - 0.5)) + ls));
  const out: number[][] = [];
  for (let j = 0; j + 1 < ys.length; j++) {
    const row: number[] = [];
    xs.forEach((x, m) => row.push(x, ys[j] + ((m + j) % 2 ? ls : 0)));
    out.push(row);
    xs.forEach((x, m) => { if ((m + j) % 2) out.push([x, ys[j] + ls, x, ys[j + 1]]); });
  }
  return out;
}

export const metamaterial: TechModule = {
  id: 'metamaterial',
  infill(s, o, region, c) {
    const r = s.report('metamaterial');
    const design = s.shared.get('cellDesign') as CellDesign | undefined;
    const angle = design?.reentrantAngle ?? s.pnum('metamaterial', 'angle');
    const cell = s.pnum('metamaterial', 'cell'), dither = s.pnum('metamaterial', 'dither');
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of region) for (const q of p) { minX = Math.min(minX, q.X / SCALE); maxX = Math.max(maxX, q.X / SCALE); minY = Math.min(minY, q.Y / SCALE); maxY = Math.max(maxY, q.Y / SCALE); }
    if (!Number.isFinite(minX)) return undefined;
    const lines = reentrantLines(minX, minY, maxX, maxY, cell, angle, dither);
    const paths: Paths = lines.map((l) => { const p = []; for (let k = 0; k < l.length; k += 2) p.push({ X: Math.round(l[k] * SCALE), Y: Math.round(l[k + 1] * SCALE) }); return p; });
    const clipped = clipLines(paths, region);
    // compliance grading by strut width: thin (compliant) deep in the core or where stress is low, full at the skin
    const a = s.parts[o];
    const ps = s.on('fea_stress') ? stressOf(s, o) : null;
    const z = c.z - c.h / 2;
    const tmp = [0, 0, 0, 0, 0, 0];
    const vmMax = ps ? Math.max(1e-9, ...Array.from(ps.vm).sort((x, y) => x - y).slice(Math.floor(ps.vm.length * 0.95), Math.floor(ps.vm.length * 0.95) + 1)) : 1;
    const out: InfillPath[] = [];
    let wmin = Infinity, wmax = 0;
    for (const p of clipped) {
      const pts: number[] = [], widths: number[] = [];
      for (let k = 0; k < p.length; k++) {
        const x = p[k].X / SCALE, y = p[k].Y / SCALE;
        // resample long struts so the width can vary along them
        if (k > 0) {
          const x0 = p[k - 1].X / SCALE, y0 = p[k - 1].Y / SCALE, L = Math.hypot(x - x0, y - y0), n = Math.ceil(L / 1.5);
          for (let q = 1; q < n; q++) push(x0 + ((x - x0) * q) / n, y0 + ((y - y0) * q) / n);
        }
        push(x, y);
      }
      function push(x: number, y: number) {
        let comp: number;
        if (ps && ps.field.at(x, y, z, tmp)) comp = 1 - Math.min(1, Math.sqrt(0.5 * ((tmp[0] - tmp[1]) ** 2 + (tmp[1] - tmp[2]) ** 2 + (tmp[2] - tmp[0]) ** 2) + 3 * (tmp[3] ** 2 + tmp[4] ** 2 + tmp[5] ** 2)) / vmMax);
        else comp = Math.min(1, Math.max(0, -a.sdf.sdf.sample(x, y, z) / Math.max(3, cell)));
        const w = c.width * (1.3 - 0.55 * comp);
        pts.push(x, y); widths.push(w);
        wmin = Math.min(wmin, w); wmax = Math.max(wmax, w);
      }
      if (pts.length >= 4) out.push({ pts, closed: false, width: c.width, widths });
    }
    r.stats = { cells_mm: cell, reentrant_angle_deg: angle, poisson_gibson_ashby: +gibsonAshbyNu(angle).toFixed(2), ...(design?.nu !== undefined ? { poisson_homogenized: +design.nu.toFixed(2) } : {}), golden_dither: dither, width_range_mm: `${wmin.toFixed(2)}–${wmax.toFixed(2)}`, struts: (Number(r.stats?.struts) || 0) + out.length };
    return out;
  },
};

export { designDensity };
