// #29 Riemannian metric tensor slicing (4D flat-morph). The part is read as the target surface, its top
// height field z = f(x, y). Its metric in the plan coordinates is g = I + ∇f⊗∇f: lengths along the
// gradient e₁ stretch by √(1 + |∇f|²), across it (e₂) they do not. A fast-printed bead shrinks to λ of
// its length along itself and grows to λ⊥ ≈ λ^{-1/2} across when heated above Tg, so the flat sheet's
// activated metric along e₂ relative to e₁ is ρ(α) = (λ cos²α + λ⊥ sin²α)/(λ sin²α + λ⊥ cos²α) for beads
// at angle α from e₂. Solving ρ(α) = 1/√(1 + |∇f|²) point by point gives the bead director field; the
// sheet is printed flat (outline = the part's footprint) with its beads as evenly spaced streamlines
// of that field, so heating buckles it into the target's curvature.
import type { Op } from '../classic/gcode';
import { clipLines, SCALE } from '../../clipper';
import { isolines, maskDistance, smoothLoop, toPath, type RasterRegion } from '../offsets';
import { beadArea, type Move } from '../runs';
import type { SessionCtx, TechModule } from '../session';
import { evenStreamlines, PsiField } from '../streamlines';
import type { Paths } from '../../types';

/** Bead angle from e₂ that gives the length ratio r (e₂ : e₁) for shrink λ; clamped when out of reach. */
export function directorAngle(r: number, lambda: number): { alpha: number; reached: boolean } {
  const lp = 1 / Math.sqrt(lambda);
  const rho = (a: number) => (lambda * Math.cos(a) ** 2 + lp * Math.sin(a) ** 2) / (lambda * Math.sin(a) ** 2 + lp * Math.cos(a) ** 2);
  // ρ increases monotonically from λ/λ⊥ (α = 0) to λ⊥/λ (α = π/2)
  const lo = rho(0), hi = rho(Math.PI / 2);
  if (r <= lo) return { alpha: 0, reached: r >= lo - 1e-9 };
  if (r >= hi) return { alpha: Math.PI / 2, reached: r <= hi + 1e-9 };
  let a = 0, b = Math.PI / 2;
  for (let k = 0; k < 40; k++) { const m = (a + b) / 2; if (rho(m) < r) a = m; else b = m; }
  return { alpha: (a + b) / 2, reached: true };
}

export const metricMorph: TechModule = {
  id: 'metric_morph',
  post(s: SessionCtx, layers) {
    const r = s.report('metric_morph');
    const lambda = s.pnum('metric_morph', 'shrink'), nLayers = Math.max(1, Math.round(s.pnum('metric_morph', 'layers')));
    if (layers.length < 1) return;
    const a = s.parts[0];
    const cell = Math.max(0.5, Math.min(2, (a.sdf.max[0] - a.sdf.min[0]) / 120));
    const nx = Math.ceil((a.sdf.max[0] - a.sdf.min[0]) / cell) + 4, ny = Math.ceil((a.sdf.max[1] - a.sdf.min[1]) / cell) + 4;
    const ox = a.sdf.min[0] - 2 * cell, oy = a.sdf.min[1] - 2 * cell;
    const mask = new Uint8Array(nx * ny), f = new Float64Array(nx * ny);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const hit = a.surf.grid.cast(ox + i * cell, oy + j * cell, a.sdf.max[2] + 1, 0, 0, -1);
      if (!hit) continue;
      mask[i + nx * j] = 1; f[i + nx * j] = a.sdf.max[2] + 1 - hit.t;
    }
    const ras: RasterRegion = { nx, ny, ox, oy, h: cell, mask };
    let unreached = 0, total = 0, maxSlope = 0;
    const psi = PsiField.sample(ras, (x, y) => {
      const i = Math.round((x - ox) / cell), j = Math.round((y - oy) / cell);
      const at = (ii: number, jj: number) => (ii >= 0 && jj >= 0 && ii < nx && jj < ny && mask[ii + nx * jj] ? f[ii + nx * jj] : f[i + nx * j]);
      const gx = (at(i + 1, j) - at(i - 1, j)) / (2 * cell), gy = (at(i, j + 1) - at(i, j - 1)) / (2 * cell);
      const g2 = gx * gx + gy * gy;
      maxSlope = Math.max(maxSlope, Math.sqrt(g2));
      // e₁ along the gradient, e₂ across; flat spots: any direction (radial default)
      const th1 = g2 > 1e-8 ? Math.atan2(gy, gx) : 0;
      const d = directorAngle(1 / Math.sqrt(1 + g2), lambda);
      total++; if (!d.reached) unreached++;
      const th = th1 + Math.PI / 2 - d.alpha; // α measured from e₂ towards e₁
      return [Math.cos(th), Math.sin(th), 1];
    });
    const w = s.num('line_width') || s.caps.nozzle * 1.05, h = s.num('initial_layer_print_height') || 0.2, hh = s.num('layer_height') || 0.2;
    const lines = evenStreamlines(ras, psi.director, { dsep: w * 0.95, step: Math.min(0.4, w) });
    // outline of the footprint
    const d = maskDistance(ras);
    const outline = isolines(ras, d, cell * 0.5).map((l) => smoothLoop(l, 0.5, 2));
    const region: Paths = outline.map(toPath);
    const clipped = clipLines(lines.map((l) => { const p = []; for (let k = 0; k < l.length; k += 2) p.push({ X: Math.round(l[k] * SCALE), Y: Math.round(l[k + 1] * SCALE) }); return p; }), region);
    const fd = s.filaments[0]?.diameter ?? 1.75, area = Math.PI * (fd / 2) ** 2;
    const speed = Math.max(40, s.num('inner_wall_speed') || 100); // fast, cool beads store the most prestrain
    const travelF = s.num('travel_speed') || 200, retract = s.num('retraction_length') || 0.8, rs = s.num('retraction_speed') || 30;
    const sheet: Op[][] = [];
    for (let k = 0; k < nLayers; k++) {
      const z = +(h + k * hh).toFixed(4), lh = k ? hh : h;
      const ops: Op[] = [{ k: 'raw', text: `; NexSpiro metric morph sheet layer ${k + 1}/${nLayers}` }];
      const ePerMm = (beadArea(w, lh) / area) * (s.filaments[0]?.flowRatio || 1); // same rounded-bead cross-section the planar engine extrudes
      const m = (x: number, y: number, e: number, feature: Move['feature']): Move => ({ k: 'move', x: +x.toFixed(4), y: +y.toFixed(4), z, e, f: speed, feature, w, h: lh, travel: false });
      const run = (pts: number[], feature: Move['feature'], closed: boolean) => {
        if (pts.length < 4) return;
        ops.push({ k: 'retract', len: retract, speed: rs }, { k: 'move', x: pts[0], y: pts[1], z, e: 0, f: travelF, feature: 'travel', w: 0, h: lh, travel: true }, { k: 'retract', len: -retract, speed: rs });
        const P = closed ? [...pts, pts[0], pts[1]] : pts;
        for (let q = 2; q < P.length; q += 2) ops.push(m(P[q], P[q + 1], Math.hypot(P[q] - P[q - 2], P[q + 1] - P[q - 1]) * ePerMm, feature));
      };
      for (const l of outline) run(l, 'outer_wall', true);
      // alternate the streamline order each layer; all layers keep the same directors (in-plane metric)
      const ls = k % 2 ? clipped.slice().reverse() : clipped;
      for (const p of ls) run(p.flatMap((q) => [q.X / SCALE, q.Y / SCALE]), 'internal_solid_infill', false);
      sheet.push(ops);
    }
    // the sheet replaces the part
    while (layers.length < nLayers) layers.push({ z: 0, h: hh, ops: [], fan: layers[layers.length - 1].fan });
    layers.forEach((L, li) => { L.ops = li < nLayers ? sheet[li] : []; if (li < nLayers) { L.z = +(h + li * hh).toFixed(4); L.h = li ? hh : h; } });
    layers.length = Math.min(layers.length, nLayers);
    r.stats = { sheet_layers: nLayers, bead_shrink: lambda, max_target_slope_deg: +((Math.atan(maxSlope) * 180) / Math.PI).toFixed(1), streamlines: clipped.length, metric_out_of_reach_pct: +((100 * unreached) / Math.max(1, total)).toFixed(1) };
    if (unreached / Math.max(1, total) > 0.05) s.warn(`Metric morph: ${((100 * unreached) / total).toFixed(0)} % of the target is steeper than the bead shrink can reach; the morphed shape will be flatter there.`);
  },
};
