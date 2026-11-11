// #24 Harmonic scalar field dome slicing: φ isosurfaces become the layers near domes.
import { domeWarp, harmonicField } from '../harmonic';
import type { TechModule, Warp } from '../session';
import { CompositeWarp } from '../warp';
import type { PartAnalysis } from '../analysis';

/** Harmonic potential per triangle, sampled just inside the surface (Zone Inspector field). */
function inspectHarmonic(a: PartAnalysis) {
  const hr = harmonicField(a);
  if (!hr) return;
  const g = a.sdf.sdf, s = a.surf;
  const out = new Float32Array(s.triCount);
  const phi = new Float32Array(hr.phi.length);
  phi.set(hr.phi);
  for (let t = 0; t < s.triCount; t++) {
    const d = g.h * 0.7;
    const p = g.cellAt(s.centroid[t * 3] - s.normal[t * 3] * d, s.centroid[t * 3 + 1] - s.normal[t * 3 + 1] * d, s.centroid[t * 3 + 2] - s.normal[t * 3 + 2] * d);
    out[t] = p >= 0 && a.sdf.inside[p] ? phi[p] : 0;
  }
  a.extra.harmonic = out;
}

export const harmonicDome: TechModule = {
  id: 'harmonic_dome',
  inspect: inspectHarmonic,
  warp(s) {
    const r = s.report('harmonic_dome');
    const warps: Warp[] = [];
    let cells = 0, iters = 0, conf = 0, slope = 0, n = 0;
    for (const a of s.parts) {
      const hr = harmonicField(a);
      if (!hr) continue;
      const dw = domeWarp(a, hr, { maxSlopeDeg: s.caps.maxSlopeDeg * 0.8, minRatio: s.pnum('harmonic_dome', 'minRatio'), maxRatio: s.pnum('harmonic_dome', 'maxRatio'), band: s.pnum('harmonic_dome', 'band') });
      if (!dw) continue;
      warps.push(dw.field);
      const st = dw.field.stats(dw.field.material);
      cells += hr.domeCells; iters += hr.iterations; conf += dw.conformity; slope = Math.max(slope, (Math.atan(st.maxSlope) * 180) / Math.PI); n++;
    }
    if (!warps.length) { r.status = 'idle'; r.reason = 'No dome or shallow top surfaces on this part.'; return undefined; }
    r.stats = { dome_cells: cells, cg_iterations: iters, conformity_pct: Math.round((100 * conf) / n), max_layer_tilt_deg: +slope.toFixed(1) };
    return warps.length === 1 ? warps[0] : new CompositeWarp(warps, 'harmonic_dome');
  },
};
