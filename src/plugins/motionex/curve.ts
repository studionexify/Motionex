import type { Curve } from "./model";

/** Evaluate a curve at t ∈ [0,1]. Outside the point range the end values hold. */
export function evalCurve(c: Curve, t: number): number {
  const p = c.points;
  if (p.length === 0) return 0;
  if (t <= p[0].t) return p[0].v;
  if (t >= p[p.length - 1].t) return p[p.length - 1].v;
  let i = 0;
  while (i < p.length - 2 && t >= p[i + 1].t) i++;
  const a = p[i], b = p[i + 1];
  if (c.interpolation === "step") return a.v;
  const span = b.t - a.t;
  if (span <= 0) return b.v;
  if (c.interpolation === "linear") return a.v + (b.v - a.v) * ((t - a.t) / span);
  // Cubic bezier: P0=a, P1=a+out, P2=b+in, P3=b. Control x is clamped into the span so x(s) is monotonic.
  const x1 = clamp(a.t + a.out_handle[0], a.t, b.t), x2 = clamp(b.t + b.in_handle[0], a.t, b.t);
  const y1 = a.v + a.out_handle[1], y2 = b.v + b.in_handle[1];
  let lo = 0, hi = 1, s = 0.5;
  for (let k = 0; k < 40; k++) {
    s = (lo + hi) / 2;
    if (bez(a.t, x1, x2, b.t, s) < t) lo = s; else hi = s;
  }
  return bez(a.v, y1, y2, b.v, s);
}

function bez(p0: number, p1: number, p2: number, p3: number, s: number): number {
  const u = 1 - s;
  return u * u * u * p0 + 3 * u * u * s * p1 + 3 * u * s * s * p2 + s * s * s * p3;
}

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
