// "Avoid crossing wall": travel moves that would leave the part and come back in through the same loop are routed
// along the inside of that loop instead, so the nozzle never drags across the outer surface.
import { SCALE } from './clipper';
import ClipperLib from 'clipper-lib';
import type { Paths } from './types';

const C: any = (ClipperLib as any).default ?? ClipperLib;

interface Poly { pts: number[]; minX: number; minY: number; maxX: number; maxY: number }

export class TravelPlanner {
  private polys: Poly[];
  constructor(private region: Paths, private maxDetour: (direct: number) => number) {
    this.polys = region.map((p) => {
      const pts: number[] = [];
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const q of p) {
        const x = q.X / SCALE, y = q.Y / SCALE;
        pts.push(x, y);
        minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      }
      return { pts, minX, minY, maxX, maxY };
    }).filter((p) => p.pts.length >= 6);
  }

  private inside(x: number, y: number): boolean {
    const pt = { X: Math.round(x * SCALE), Y: Math.round(y * SCALE) };
    let n = 0;
    for (const p of this.region) if (C.Clipper.PointInPolygon(pt, p) !== 0) n++;
    return n % 2 === 1;
  }

  /**
   * Intermediate points for a travel from A to B ([] = go straight). Crossings into areas outside the region
   * that re-enter through the same loop become a walk along that loop (the shorter way round).
   */
  route(ax: number, ay: number, bx: number, by: number): number[] {
    if (!this.polys.length) return [];
    const dx = bx - ax, dy = by - ay;
    const direct = Math.hypot(dx, dy);
    if (direct < 1e-3) return [];
    const minX = Math.min(ax, bx), maxX = Math.max(ax, bx), minY = Math.min(ay, by), maxY = Math.max(ay, by);
    // crossings: t along AB, polygon, edge index, point
    const hits: { t: number; poly: number; edge: number; x: number; y: number }[] = [];
    this.polys.forEach((P, pi) => {
      if (P.maxX < minX || P.minX > maxX || P.maxY < minY || P.minY > maxY) return;
      const n = P.pts.length / 2;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const cx = P.pts[i * 2], cy = P.pts[i * 2 + 1], ex = P.pts[j * 2] - cx, ey = P.pts[j * 2 + 1] - cy;
        const den = dx * ey - dy * ex;
        if (Math.abs(den) < 1e-12) continue;
        const t = ((cx - ax) * ey - (cy - ay) * ex) / den;
        const u = ((cx - ax) * dy - (cy - ay) * dx) / den;
        if (t > 1e-9 && t < 1 - 1e-9 && u >= 0 && u <= 1) hits.push({ t, poly: pi, edge: i, x: ax + dx * t, y: ay + dy * t });
      }
    });
    if (!hits.length) return [];
    hits.sort((a, b) => a.t - b.t);
    // walk the crossings; while outside the region, try to replace the outside stretch by a boundary walk
    let inside = this.inside(ax + dx * hits[0].t * 0.5, ay + dy * hits[0].t * 0.5);
    const out: number[] = [];
    let changed = false;
    for (let k = 0; k < hits.length; k++) {
      const h = hits[k];
      if (inside && k + 1 < hits.length) {
        const e = hits[k + 1];
        if (e.poly === h.poly) {
          const walk = this.walk(h.poly, h.edge, h.x, h.y, e.edge, e.x, e.y);
          out.push(h.x, h.y, ...walk, e.x, e.y);
          changed = true;
          k++; // still inside after re-entering
          continue;
        }
      }
      inside = !inside;
    }
    if (!changed) return [];
    let len = 0, px = ax, py = ay;
    for (let i = 0; i < out.length; i += 2) { len += Math.hypot(out[i] - px, out[i + 1] - py); px = out[i]; py = out[i + 1]; }
    len += Math.hypot(bx - px, by - py);
    const limit = this.maxDetour(direct);
    if (limit > 0 && len - direct > limit) return [];
    return out;
  }

  /** Boundary points from a point on edge i to a point on edge j of polygon `pi`, the shorter way round. */
  private walk(pi: number, i: number, x0: number, y0: number, j: number, x1: number, y1: number): number[] {
    const P = this.polys[pi].pts, n = P.length / 2;
    const fwd: number[] = [], bwd: number[] = [];
    for (let k = (i + 1) % n, guard = 0; guard < n; k = (k + 1) % n, guard++) { fwd.push(P[k * 2], P[k * 2 + 1]); if (k === j) break; }
    for (let k = i, guard = 0; guard < n; k = (k - 1 + n) % n, guard++) { if (k === j) break; bwd.push(P[k * 2], P[k * 2 + 1]); }
    if (i === j) { fwd.length = 0; bwd.length = 0; }
    const length = (pts: number[]) => {
      let L = 0, px = x0, py = y0;
      for (let k = 0; k < pts.length; k += 2) { L += Math.hypot(pts[k] - px, pts[k + 1] - py); px = pts[k]; py = pts[k + 1]; }
      return L + Math.hypot(x1 - px, y1 - py);
    };
    return length(fwd) <= length(bwd) ? fwd : bwd;
  }
}
