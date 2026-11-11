// Small shape builders for scenarios, calibration prints and tests (mm, CCW outer rings).
import type { Ring, Vec2 } from './geom';

export const rectRing = (x0: number, y0: number, x1: number, y1: number): Ring => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

/** Circle as a polygon; segment count keeps the chord error under ~2 µm for small holes. */
export function circleRing(c: Vec2, r: number, n = Math.max(48, Math.ceil(Math.PI / Math.acos(1 - 0.002 / Math.max(r, 0.01))))): Ring {
  const out: Ring = [];
  for (let k = 0; k < n; k++) { const a = (2 * Math.PI * k) / n; out.push([c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)]); }
  return out;
}

export const reverse = (r: Ring): Ring => r.slice().reverse();
export const translate = (r: Ring, dx: number, dy: number): Ring => r.map(([x, y]) => [x + dx, y + dy] as Vec2);
