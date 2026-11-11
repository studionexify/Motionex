// Eulerian continuous spiralization (#3): concentric rings of a region joined into unbroken spirals.
// Rings nest level by level; a chain of rings that each have exactly one neighbour on the next level
// becomes a single spiral (each ring stops one spacing short of closing and steps inward), so a
// convex island is one extrusion with no travel. The innermost ring widens to fill what is left
// instead of a separate zig-zag gap fill.
import { area, offset, SCALE } from '../clipper';
import type { Paths } from '../types';
import type { InfillPath } from './session';

interface Ring { pts: number[]; level: number; len: number; cx: number; cy: number }

const toPts = (p: Paths[number]) => p.flatMap((q) => [q.X / SCALE, q.Y / SCALE]);
const ringLen = (p: number[]) => { let L = 0; const n = p.length / 2; for (let i = 0; i < n; i++) { const j = (i + 1) % n; L += Math.hypot(p[j * 2] - p[i * 2], p[j * 2 + 1] - p[i * 2 + 1]); } return L; };

function nearestIndex(p: number[], x: number, y: number): number {
  let bi = 0, bd = Infinity;
  for (let i = 0; i < p.length; i += 2) { const d = (p[i] - x) ** 2 + (p[i + 1] - y) ** 2; if (d < bd) { bd = d; bi = i / 2; } }
  return bi;
}
const minDist = (a: number[], b: number[]) => {
  let best = Infinity;
  for (let i = 0; i < a.length; i += 2) for (let j = 0; j < b.length; j += 2) best = Math.min(best, (a[i] - b[j]) ** 2 + (a[i + 1] - b[j + 1]) ** 2);
  return Math.sqrt(best);
};

export interface SpiralOptions { spacing: number; width: number; minW: number; maxW: number; maxRings?: number }

/** Concentric rings joined into spirals; returns open paths (one per chain). */
export function spiralFill(region: Paths, o: SpiralOptions): InfillPath[] {
  const levels: Ring[][] = [];
  for (let k = 0; k < (o.maxRings ?? 400); k++) {
    const ps = offset(region, -(o.width / 2 + k * o.spacing)).filter((p) => p.length >= 3 && Math.abs(area(p)) > o.width * o.width);
    if (!ps.length) break;
    levels.push(ps.map((p) => {
      const pts = toPts(p);
      let cx = 0, cy = 0;
      for (let i = 0; i < pts.length; i += 2) { cx += pts[i]; cy += pts[i + 1]; }
      return { pts, level: k, len: ringLen(pts), cx: cx / (pts.length / 2), cy: cy / (pts.length / 2) };
    }));
  }
  if (!levels.length) return [];
  // parent → child links where the nesting is one-to-one
  const reach = o.spacing * 1.6;
  const child = new Map<Ring, Ring>();
  const parents = new Map<Ring, number>();
  for (let k = 0; k + 1 < levels.length; k++) {
    for (const r of levels[k]) {
      const near = levels[k + 1].filter((c) => Math.hypot(c.cx - r.cx, c.cy - r.cy) < r.len && minDist(r.pts, c.pts) <= reach);
      if (near.length === 1) { child.set(r, near[0]); parents.set(near[0], (parents.get(near[0]) ?? 0) + 1); }
    }
  }
  const used = new Set<Ring>();
  const out: InfillPath[] = [];
  const nozzleMin = Math.max(o.minW, o.width * 0.7), nozzleMax = Math.max(nozzleMin, o.maxW);
  for (const lv of levels) for (const start of lv) {
    if (used.has(start)) continue;
    // a chain follows unique children whose only parent is the current ring
    const chain: Ring[] = [start];
    used.add(start);
    for (let r = child.get(start); r && !used.has(r) && parents.get(r) === 1; r = child.get(r)) { chain.push(r); used.add(r); }
    const pts: number[] = [];
    const widths: number[] = [];
    let x = chain[0].pts[0], y = chain[0].pts[1];
    chain.forEach((ring, ci) => {
      const n = ring.pts.length / 2;
      const s = nearestIndex(ring.pts, x, y);
      // walk the ring, stopping one spacing short of closing so the step inward does not overlap
      let walked = 0;
      const last = ci === chain.length - 1;
      const stop = last ? ring.len : Math.max(ring.len * 0.5, ring.len - o.spacing);
      let w = o.width;
      if (last) {
        // what the innermost ring leaves uncovered: widen it rather than add gap fill
        const rest = offset(region, -(o.width / 2 + ring.level * o.spacing + o.spacing / 2));
        const ra = rest.reduce((t, p) => t + Math.abs(area(p)), 0);
        if (ra > 0 && o.spacing <= o.width * 1.6) w = Math.min(nozzleMax, Math.max(nozzleMin, o.width + (2 * ra) / Math.max(ring.len, 1e-6)));
      }
      for (let k = 0; k <= n; k++) {
        const i = (s + k) % n;
        const px = ring.pts[i * 2], py = ring.pts[i * 2 + 1];
        const seg = k > 0 ? Math.hypot(px - x, py - y) : 0;
        if (walked + seg > stop) {
          // stop part-way along this edge, exactly `stop` from the ring's start
          const u = seg > 0 ? (stop - walked) / seg : 0;
          if (u > 1e-6) { x += (px - x) * u; y += (py - y) * u; pts.push(x, y); widths.push(w); }
          break;
        }
        walked += seg;
        pts.push(px, py); widths.push(w);
        x = px; y = py;
      }
    });
    if (pts.length >= 4) {
      const modulated = widths.some((w) => Math.abs(w - o.width) > 1e-6);
      out.push({ pts, closed: false, width: o.width, ...(modulated ? { widths } : {}) });
    }
  }
  return out;
}
