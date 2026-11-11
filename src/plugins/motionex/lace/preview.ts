// Lace preview: the outer outline at each row with the open stretches left out, so the openwork shows
// on the model, holes drawn out into points by the same printability rule the slicer uses.
import { LaceTracker, solidAt } from './core';
import type { LaceSettings } from './model';
import type { Config } from '../../../profiles/settings';
import { laceLimits } from './plan';
import { previewRows, type PreviewObject } from '../wall/preview';

export function buildLacePreview(objs: PreviewObject[], lace: LaceSettings, layerHeight: number, colour: [number, number, number], cfg?: Config): { positions: Float32Array; colors: Float32Array } | null {
  // strands and holes as the nozzle in use will print them
  const l = cfg ? { ...lace, ...laceLimits(lace, cfg) } : lace;
  const pos: number[] = [], col: number[] = [];
  for (const rows of previewRows(objs, l.objects, l.z_start, l.z_end, l.follow_curve, layerHeight, 260, l.rim_mm)) {
    const t = new LaceTracker(l, { total: rows[0]?.total ?? 0 });
    for (const r of rows) {
      const inBand = Number.isFinite(r.s);
      const masks = t.layer(r.loops, inBand ? r.s : 0, r.dz, inBand);
      r.loops.forEach((lp, k) => {
        const n = lp.pts.length;
        for (let i = 0; i < n; i++) {
          const a = lp.pts[i], b = lp.pts[(i + 1) % n];
          let u1 = lp.u[(i + 1) % n];
          if (u1 - lp.u[i] < -0.5) u1 += 1;
          // a segment is cut into ~0.5 mm pieces so hole edges land where they will print
          const m = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 0.5));
          for (let q = 0; q < m; q++) {
            const t0 = q / m, t1 = (q + 1) / m;
            if (!solidAt(masks[k], lp.u[i] + (u1 - lp.u[i]) * ((t0 + t1) / 2))) continue;
            pos.push(a.x + (b.x - a.x) * t0, a.y + (b.y - a.y) * t0, r.z, a.x + (b.x - a.x) * t1, a.y + (b.y - a.y) * t1, r.z);
            col.push(...colour, ...colour);
          }
        }
      });
    }
  }
  return pos.length ? { positions: Float32Array.from(pos), colors: Float32Array.from(col) } : null;
}
