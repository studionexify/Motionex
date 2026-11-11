// Support / raft / brim helpers for the OrcaSlicer / Bambu Studio parity options (enforce_support_layers, organic branch
// density, small support perimeters, brim ear detection). The settings are read in slicer.ts; these functions do the geometry.
import { difference, SCALE, union } from './clipper';
import type { Path, Paths, Polyline2 } from './types';

/**
 * Enforce support for the first `n` object layers (Orca `enforce_support_layers`): there every part of the layer not
 * standing on the layer below is an overhang, whatever its angle (lower layer offset 0).
 */
export function enforceFirstLayers(over: Paths[], slices: Paths[], objStart: number, n: number): Paths[] {
  if (n <= 0) return over;
  const out = over.slice();
  for (let i = Math.max(1, objStart + 1); i < Math.min(slices.length, objStart + n); i++) {
    if (!slices[i].length) continue;
    const full = slices[i - 1].length ? difference(slices[i], slices[i - 1]) : slices[i];
    if (full.length) out[i] = out[i].length ? union(out[i], full) : full;
  }
  return out;
}

/**
 * Organic tree tip spacing along a tip row (Orca TreeSupport3D connect_length):
 * line width * 100 / branch density + max(2 * tip radius - line width, 0).
 */
export function organicTipSpacing(lineWidth: number, topRate: number, tipDiameter: number): number {
  return (lineWidth * 100) / Math.max(1, topRate) + Math.max(tipDiameter - lineWidth, 0);
}

/** Length of a polyline (with the closing segment for a loop), mm. */
export function polyLength(p: Polyline2): number {
  const a = p.pts;
  let L = 0;
  for (let k = 2; k < a.length; k += 2) L += Math.hypot(a[k] - a[k - 2], a[k + 1] - a[k - 1]);
  if (p.closed && a.length >= 4) L += Math.hypot(a[0] - a[a.length - 2], a[1] - a[a.length - 1]);
  return L;
}

/**
 * Small support perimeters (Orca GCode::speed_for_path): a support path no longer than a circle of radius `threshold`
 * prints at `small` (resolved against the support / interface speed; 0 = half of it). Returns undefined when not small.
 */
export function smallSupportSpeed(p: Polyline2, threshold: number, small: number, base: number): number | undefined {
  if (!(threshold > 0) || polyLength(p) > threshold * 2 * Math.PI) return undefined;
  const v = small > 0 ? small : base * 0.5;
  return v > 0 ? v : undefined;
}

/** Douglas-Peucker simplification of a closed contour (Orca brim ear decimation); keeps at least 4 points. */
export function decimateLoop(path: Path, tol: number): Path {
  if (!(tol > 0) || path.length < 4) return path;
  const pts = [...path, path[0]];
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const t = tol * SCALE;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let best = -1, bd = 0;
    const ax = pts[a].X, ay = pts[a].Y, dx = pts[b].X - ax, dy = pts[b].Y - ay, L = Math.hypot(dx, dy);
    for (let k = a + 1; k < b; k++) {
      const d = L > 0 ? Math.abs((pts[k].X - ax) * dy - (pts[k].Y - ay) * dx) / L : Math.hypot(pts[k].X - ax, pts[k].Y - ay);
      if (d > bd) { bd = d; best = k; }
    }
    if (best >= 0 && bd > t) { keep[best] = 1; stack.push([a, best], [best, b]); }
  }
  const out = pts.filter((_, k) => keep[k]);
  out.pop();
  return out.length >= 4 ? out : path;
}

/**
 * Sharp convex corners of the material along a loop (contours counter-clockwise, holes clockwise: material on the left),
 * with an interior angle below `maxAngle` degrees: where auto brim ears go.
 */
export function sharpCorners(path: Path, maxAngle: number): [number, number][] {
  const out: [number, number][] = [];
  const n = path.length;
  for (let k = 0; k < n; k++) {
    const p = path[k], a = path[(k - 1 + n) % n], b = path[(k + 1) % n];
    const ax = (a.X - p.X) / SCALE, ay = (a.Y - p.Y) / SCALE, bx = (b.X - p.X) / SCALE, by = (b.Y - p.Y) / SCALE;
    const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
    if (la < 1e-3 || lb < 1e-3) continue;
    const ang = Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by) / (la * lb)))) * 180 / Math.PI;
    if (ax * by - ay * bx < 0 && ang < maxAngle) out.push([p.X / SCALE, p.Y / SCALE]);
  }
  return out;
}
