// Path sculpt inside the slicer: runs before the other passes, so weave, lace, paint and motions all work
// on the moved wall. Every closed outer wall loop is pushed along its outward normal by the map's value at
// that point (angle round the loop's centre, layer height).
import type { Config } from '../../../profiles/settings';
import type { LayerOps, Op } from '../../../engine/gcode';
import { sculptAt, type SculptSettings } from './model';

type Move = Extract<Op, { k: 'move' }>;
const OUTER = new Set(['outer_wall', 'overhang_wall']);

export interface SculptReport { loops: number; peakMm: number }

export function applySculpt(layers: LayerOps[], s: SculptSettings, _cfg: Config, targets: ((layer: number, x: number, y: number) => boolean) | null, warn: (m: string) => void): SculptReport {
  const rep: SculptReport = { loops: 0, peakMm: 0 };
  const top = layers.reduce((m, L) => Math.max(m, L.z), 0);
  layers.forEach((L, li) => {
    const ops = L.ops;
    let last: Move | null = null;
    let i = 0;
    while (i < ops.length) {
      const op = ops[i];
      if (op.k === 'raw' && op.resetPos) { last = null; i++; continue; }
      if (op.k !== 'move') { i++; continue; }
      if (op.travel || op.e <= 0 || !last || !OUTER.has(op.feature)) { last = op; i++; continue; }
      const run: Move[] = [];
      let j = i;
      while (j < ops.length) {
        const m = ops[j];
        if (m.k !== 'move' || m.travel || m.e <= 0 || !OUTER.has(m.feature)) break;
        run.push(m); j++;
      }
      const a = last, b = run[run.length - 1];
      const closed = run.length > 3 && Math.hypot(a.x - b.x, a.y - b.y) < Math.max(0.1, 1.5 * op.w);
      if (closed && (!targets || targets(li, a.x, a.y))) {
        const pts = [{ x: a.x, y: a.y }, ...run.map((m) => ({ x: m.x, y: m.y }))];
        const n = pts.length - 1; // pts[n] repeats pts[0]
        let cx = 0, cy = 0, area = 0;
        for (let k = 0; k < n; k++) { cx += pts[k].x; cy += pts[k].y; const q = pts[k + 1]; area += pts[k].x * q.y - q.x * pts[k].y; }
        cx /= n; cy /= n;
        const ccw = area >= 0;
        const out = pts.map((p, k) => {
          const p0 = pts[(k - 1 + n) % n], p1 = pts[(k + 1) % n];
          let tx = p1.x - p0.x, ty = p1.y - p0.y;
          const l = Math.hypot(tx, ty) || 1; tx /= l; ty /= l;
          const nx = ccw ? ty : -ty, ny = ccw ? -tx : tx; // outward
          const u = Math.atan2(p.y - cy, p.x - cx) / (2 * Math.PI);
          const d = sculptAt(s, u, L.z, top);
          rep.peakMm = Math.max(rep.peakMm, Math.abs(d));
          return { x: p.x + nx * d, y: p.y + ny * d };
        });
        out[n] = out[0];
        // the travel that arrives at the loop start goes to the moved start
        if (Math.abs(a.x - pts[0].x) < 1e-6 && Math.abs(a.y - pts[0].y) < 1e-6) { a.x = Math.round(out[0].x * 1e4) / 1e4; a.y = Math.round(out[0].y * 1e4) / 1e4; }
        run.forEach((m, k) => { m.x = Math.round(out[k + 1].x * 1e4) / 1e4; m.y = Math.round(out[k + 1].y * 1e4) / 1e4; });
        rep.loops++;
      }
      last = b; i = j;
    }
  });
  if (rep.peakMm > 0 && !rep.loops) warn('Path sculpt: no closed outer wall found in the band. Check the band heights and that the wall prints as one loop.');
  return rep;
}
