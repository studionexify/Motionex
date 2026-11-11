// Arc fitting: replaces runs of short extrusion segments that lie on a circle with one G2/G3 move.
import type { Op } from './gcode';

type Move = Extract<Op, { k: 'move' }>;
export interface ArcFit { end: number; cx: number; cy: number; cw: boolean }

function circle3(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): [number, number, number] | null {
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-9) return null;
  const a2 = ax * ax + ay * ay, b2 = bx * bx + by * by, c2 = cx * cx + cy * cy;
  const ux = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d;
  const uy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d;
  return [ux, uy, Math.hypot(ax - ux, ay - uy)];
}

const compatible = (m: Op, ref: Move): m is Move =>
  m.k === 'move' && !m.travel && m.e > 0 && m.z === ref.z && m.f === ref.f && m.feature === ref.feature && m.w === ref.w;

/** Longest arc starting at (x, y) and covering ops[start..end] (≥ 3 segments), or null. */
export function fitArc(ops: Op[], start: number, x: number, y: number, tol = 0.012): ArcFit | null {
  const first = ops[start];
  if (first.k !== 'move' || first.travel || first.e <= 0) return null;
  let best: ArcFit | null = null;
  let j = start + 2;
  const maxEnd = Math.min(ops.length - 1, start + 400);
  for (; j <= maxEnd; j++) {
    if (!compatible(ops[j], first) || !compatible(ops[j - 1], first)) break;
    const mid = ops[start + ((j - start) >> 1)] as Move, end = ops[j] as Move;
    const c = circle3(x, y, mid.x, mid.y, end.x, end.y);
    if (!c) break;
    const [ux, uy, r] = c;
    if (r < 0.5 || r > 500) break;
    let ok = true, sweep = 0, px = x, py = y, dir = 0;
    for (let k = start; k <= j; k++) {
      const m = ops[k] as Move;
      if (Math.abs(Math.hypot(m.x - ux, m.y - uy) - r) > tol) { ok = false; break; }
      // chord midpoint must stay close too (segments are straight)
      const mx = (m.x + px) / 2, my = (m.y + py) / 2;
      if (r - Math.hypot(mx - ux, my - uy) > tol) { ok = false; break; }
      const cr = (px - ux) * (m.y - uy) - (py - uy) * (m.x - ux);
      const s = Math.sign(cr);
      if (dir === 0) dir = s; else if (s !== 0 && s !== dir) { ok = false; break; }
      sweep += Math.abs(Math.atan2(cr, (px - ux) * (m.x - ux) + (py - uy) * (m.y - uy)));
      px = m.x; py = m.y;
    }
    if (!ok || sweep > Math.PI * 1.9) break;
    best = { end: j, cx: ux, cy: uy, cw: dir < 0 };
  }
  return best;
}
