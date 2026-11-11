// #1 FEA stress-aligned vector fields and #33 Clifford spinor field slicing: the part is solved under
// its load case; where it is loaded the sparse infill follows the in-plane principal stress lines
// (evenly spaced RK4 streamlines), with the frame field smoothed as rotors and the ±½ defects of each
// layer's line field moved out of the material into holes or past the outline.
import { clipLines, cleanPaths, intersection, SCALE, unionEvenOdd } from '../../clipper';
import type { Paths } from '../../types';
import type { PartAnalysis } from '../analysis';
import { quantile } from '../fea';
import { isolines, loopArea, rasterize, toPath, type RasterRegion } from '../offsets';
import type { InfillPath, SessionCtx, TechModule } from '../session';
import { partStress, vmAt, type PartStress } from '../stress';
import { evenStreamlines, PsiField } from '../streamlines';

/** The part's stress field, solved once per slice (smoothed when spinor fields are on). */
export function stressOf(s: SessionCtx, o: number): PartStress | null {
  return s.memo(`stress:${o}`, () => {
    const a = s.parts[o];
    if (!a) return null;
    const spin = s.on('spinor_fields') ? Math.round(s.pnum('spinor_fields', 'smooth')) : 0;
    const ps = partStress(a, { maxEl: s.pnum('fea_stress', 'elements'), newtons: s.pnum('fea_stress', 'loadN'), spinorPasses: spin });
    if (ps && s.on('fea_stress')) {
      const r = s.report('fea_stress');
      r.stats = { ...(r.stats ?? {}), elements: (Number(r.stats?.elements) || 0) + ps.model.cells.length, element_mm: +ps.model.h.toFixed(2), cg_iterations: ps.iterations, load: ps.load.source, load_N: ps.load.newtons, max_von_mises_MPa: +quantile(ps.vm, 0.99).toFixed(2) };
    }
    if (ps?.spinor) {
      const r = s.report('spinor_fields');
      r.stats = { ...(r.stats ?? {}), smoothing_passes: ps.spinor.passes, mean_frame_turn_deg: +ps.spinor.meanTurnDeg.toFixed(2) };
    }
    return ps;
  });
}

/** Sparse density for the stress, Turing and quasicrystal cells: the homogenization design when there is one. */
export function designDensity(s: SessionCtx, fallback: number): number {
  const d = s.shared.get('cellDesign') as { density?: number } | undefined;
  return Math.max(0.05, Math.min(1, d?.density ?? fallback));
}

/** Real z of a point of the sliced (possibly curved-layer) space. */
const realZ = (s: SessionCtx, x: number, y: number, zw: number) => (s.warp ? zw + s.warp.dz(x, y, zw) : zw);

const toLines = (ls: number[][]): Paths => ls.map((l) => { const p = []; for (let k = 0; k < l.length; k += 2) p.push({ X: Math.round(l[k] * SCALE), Y: Math.round(l[k + 1] * SCALE) }); return p; });
const fromPaths = (ps: Paths, width: number): InfillPath[] => ps.filter((p) => p.length >= 2).map((p) => ({ pts: p.flatMap((q) => [q.X / SCALE, q.Y / SCALE]), closed: false, width }));

/** Region (mask and polygons) of the raster where a field reaches a level. */
export function levelRegion(r: RasterRegion, value: (x: number, y: number) => number, level: number, minArea: number): { mask: RasterRegion; paths: Paths } {
  const phi = new Float64Array(r.nx * r.ny);
  const mask = new Uint8Array(r.nx * r.ny);
  for (let j = 0; j < r.ny; j++) for (let i = 0; i < r.nx; i++) {
    const p = i + r.nx * j;
    if (!r.mask[p]) continue;
    phi[p] = value(r.ox + i * r.h, r.oy + j * r.h);
    if (phi[p] >= level) mask[p] = 1;
  }
  const loops = isolines(r, phi, level).filter((l) => Math.abs(loopArea(l)) >= minArea);
  return { mask: { ...r, mask }, paths: loops.length ? cleanPaths(unionEvenOdd(loops.map(toPath)), 0.02) : [] };
}

export const feaStress: TechModule = {
  id: 'fea_stress',
  inspect(a: PartAnalysis) {
    const ps = partStress(a, { maxEl: 4000, newtons: 50 });
    if (!ps) return;
    const T = a.surf.triCount, out = new Float32Array(T), tmp = [0, 0, 0, 0, 0, 0];
    const h = ps.model.h * 0.5;
    for (let t = 0; t < T; t++) {
      const x = a.surf.centroid[t * 3] - a.surf.normal[t * 3] * h, y = a.surf.centroid[t * 3 + 1] - a.surf.normal[t * 3 + 1] * h, z = a.surf.centroid[t * 3 + 2] - a.surf.normal[t * 3 + 2] * h;
      out[t] = vmAt(ps, x, y, z, tmp);
    }
    a.extra.stress = out;
  },
  infill(s, o, region, c, last) {
    const ps = stressOf(s, o);
    if (!ps) { const r = s.report('fea_stress'); if (!r.stats?.elements) { r.status = 'idle'; r.reason = 'No load case: the part has no fixtures (bed contact or painted) and loads.'; } return undefined; }
    const r = s.report('fea_stress');
    const density = designDensity(s, c.density);
    const dsep = c.width / density;
    const cell = Math.max(0.25, Math.min(dsep / 3, ps.model.h / 2, 1));
    const ras = rasterize(region, cell);
    if (!ras) return undefined;
    const zw = c.z - c.h / 2;
    const tmp = [0, 0, 0, 0, 0, 0];
    // where the part is loaded (von Mises above the chosen percentile) the paths follow the stress
    const thr = quantile(ps.vm, s.pnum('fea_stress', 'threshold'));
    let claim = { mask: ras, paths: region };
    if (!last && thr > 0) {
      claim = levelRegion(ras, (x, y) => vmAt(ps, x, y, realZ(s, x, y, zw), tmp), thr, (2 * dsep) ** 2);
      claim.paths = intersection(claim.paths, region);
      if (!claim.paths.length) return undefined;
    }
    const fam = String(s.param('fea_stress', 'family'));
    const minor = fam === 'min' || (fam === 'both' && c.layer % 2 === 1);
    const psi = PsiField.sample(claim.mask, (x, y) => {
      if (!ps.field.at(x, y, realZ(s, x, y, zw), tmp)) return null;
      const sxx = tmp[0], syy = tmp[1], sxy = tmp[5];
      const th = 0.5 * Math.atan2(2 * sxy, sxx - syy) + (minor ? Math.PI / 2 : 0);
      return [Math.cos(th), Math.sin(th), Math.hypot((sxx - syy) / 2, sxy) + 1e-9];
    });
    if (s.on('spinor_fields')) {
      const d = psi.relocateDefects();
      const sr = s.report('spinor_fields');
      sr.stats = { ...(sr.stats ?? {}), defects_found: (Number(sr.stats?.defects_found) || 0) + d.found, defects_moved_out: (Number(sr.stats?.defects_moved_out) || 0) + d.moved };
    }
    const lines = evenStreamlines(claim.mask, psi.director, { dsep, step: Math.min(0.5, dsep / 3) });
    const clipped = clipLines(toLines(lines), claim.paths);
    r.stats = { ...(r.stats ?? {}), stress_regions: (Number(r.stats?.stress_regions) || 0) + 1, streamlines: (Number(r.stats?.streamlines) || 0) + clipped.length };
    return { paths: fromPaths(clipped, c.width), used: claim.paths };
  },
};

export const spinorFields: TechModule = {
  id: 'spinor_fields',
  prepare(s) {
    if (!s.on('fea_stress') && !s.on('turing_infill')) {
      const r = s.report('spinor_fields');
      r.status = 'idle'; r.reason = 'No stress field to smooth: tick Stress-line infill or Organic rib infill in Strength infill.';
    }
  },
};
