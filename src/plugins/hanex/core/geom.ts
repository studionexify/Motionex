// Hanex 2D geometry helpers. Everything here is in plate millimetres; Clipper integer paths are
// converted at the module boundary (toRings / toPaths).
import { SCALE } from '../../../engine/clipper';
import type { Path, Paths } from '../../../engine/types';

export type Vec2 = [number, number];
/** Closed ring (last vertex is NOT repeated). */
export type Ring = Vec2[];
/** Open polyline. */
export type Polyline = Vec2[];

export const toRing = (p: Path): Ring => p.map((q) => [q.X / SCALE, q.Y / SCALE] as Vec2);
export const toRings = (ps: Paths): Ring[] => ps.map(toRing);
export const toPath = (r: Ring): Path => r.map(([x, y]) => ({ X: Math.round(x * SCALE), Y: Math.round(y * SCALE) }));
export const toPaths = (rs: Ring[]): Paths => rs.map(toPath);

export const dist = (a: Vec2, b: Vec2) => Math.hypot(b[0] - a[0], b[1] - a[1]);

/** Even-odd point-in-polygon over a set of rings (outer contours and holes together). */
export function pointInRings(x: number, y: number, rings: Ring[]): boolean {
  let inside = false;
  for (const r of rings) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, yi] = r[i], [xj, yj] = r[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

/** Distance from p to segment ab. */
export function distToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

export function polylineLength(pl: Polyline): number {
  let s = 0;
  for (let i = 1; i < pl.length; i++) s += dist(pl[i - 1], pl[i]);
  return s;
}

/** Radius of the circle through three points (Infinity when collinear). */
export function circumradius(a: Vec2, b: Vec2, c: Vec2): number {
  const ab = dist(a, b), bc = dist(b, c), ca = dist(c, a);
  const cross = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
  return cross < 1e-12 ? Infinity : (ab * bc * ca) / (2 * cross);
}

/** Point at arc length s along a polyline (clamped to the ends). */
export function pointAt(pl: Polyline, s: number): Vec2 {
  if (s <= 0) return pl[0];
  for (let i = 1; i < pl.length; i++) {
    const l = dist(pl[i - 1], pl[i]);
    if (s <= l) { const t = l > 0 ? s / l : 0; return [pl[i - 1][0] + t * (pl[i][0] - pl[i - 1][0]), pl[i - 1][1] + t * (pl[i][1] - pl[i - 1][1])]; }
    s -= l;
  }
  return pl[pl.length - 1];
}

/** Cumulative arc length at each vertex. */
export function arcLengths(pl: Polyline): number[] {
  const out = [0];
  for (let i = 1; i < pl.length; i++) out.push(out[i - 1] + dist(pl[i - 1], pl[i]));
  return out;
}

/**
 * Local radius of curvature at each vertex, measured with a chord of ±window mm along the curve
 * (three-point circumradius). A window of about one bead width makes it insensitive to the grid
 * step of the contour extraction while still resolving tight turns.
 */
export function curvatureRadii(pl: Polyline, window: number): number[] {
  const s = arcLengths(pl), total = s[s.length - 1];
  return pl.map((p, i) => {
    const a = pointAt(pl, s[i] - window), c = pointAt(pl, s[i] + window);
    if (s[i] - window < 0 || s[i] + window > total) {
      // near an end: use a one-sided chord of the same total length when the curve is long enough
      if (total < 2 * window) return Infinity;
      const lo = Math.max(0, Math.min(s[i] - window, total - 2 * window));
      return circumradius(pointAt(pl, lo), pointAt(pl, lo + window), pointAt(pl, lo + 2 * window));
    }
    return circumradius(a, p, c);
  });
}

/** Douglas–Peucker simplification of an open polyline. */
export function simplify(pl: Polyline, eps: number): Polyline {
  if (pl.length < 3) return pl.slice();
  const keep = new Uint8Array(pl.length);
  keep[0] = keep[pl.length - 1] = 1;
  const stack: [number, number][] = [[0, pl.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let best = -1, bd = eps;
    for (let i = a + 1; i < b; i++) { const d = distToSegment(pl[i], pl[a], pl[b]); if (d > bd) { bd = d; best = i; } }
    if (best >= 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
  }
  return pl.filter((_, i) => keep[i]);
}

/** Cut a polyline at arc lengths [s0, s1]. */
export function subPolyline(pl: Polyline, s0: number, s1: number): Polyline {
  const s = arcLengths(pl);
  const out: Polyline = [pointAt(pl, s0)];
  for (let i = 0; i < pl.length; i++) if (s[i] > s0 && s[i] < s1) out.push(pl[i]);
  out.push(pointAt(pl, s1));
  return out;
}

export function bboxOf(rings: Ring[]) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rings) for (const [x, y] of r) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return { x0, y0, x1, y1 };
}
