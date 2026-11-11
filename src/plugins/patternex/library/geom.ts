// Small geometry helpers for the pattern generators. Rings are [x, y] in mm, Y up.
import type { Ring } from '../model';

export type Rnd = () => number;

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number): Rnd {
  let a = (seed >>> 0) || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const rect = (x0: number, y0: number, x1: number, y1: number): Ring => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

export function ngon(cx: number, cy: number, r: number, n: number, a0 = 0): Ring {
  return Array.from({ length: n }, (_, k) => { const a = a0 + (2 * Math.PI * k) / n; return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as [number, number]; });
}

export const circle = (cx: number, cy: number, r: number, seg = 0) => ngon(cx, cy, r, seg || Math.max(12, Math.min(64, Math.round(r * 8))));

export function star(cx: number, cy: number, ro: number, ri: number, n: number, a0 = -Math.PI / 2): Ring {
  const out: Ring = [];
  for (let k = 0; k < n * 2; k++) { const r = k % 2 ? ri : ro, a = a0 + (Math.PI * k) / n; out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
  return out;
}

/** Polar curve r(θ) sampled into a ring. */
export function polar(cx: number, cy: number, f: (a: number) => number, seg = 96, a0 = 0): Ring {
  return Array.from({ length: seg }, (_, k) => { const a = a0 + (2 * Math.PI * k) / seg, r = Math.max(0.05, f(a)); return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as [number, number]; });
}

export function transform(r: Ring, cx: number, cy: number, rot: number, sx = 1, sy = sx): Ring {
  const c = Math.cos(rot), s = Math.sin(rot);
  return r.map(([x, y]) => [cx + c * x * sx - s * y * sy, cy + s * x * sx + c * y * sy] as [number, number]);
}

/** Shape outline centred on the origin with radius ~1 (used by the radial/arrangement families). */
export function unitShape(kind: number, inner = 0.45): Ring {
  switch (Math.round(kind) % 8) {
    case 0: return circle(0, 0, 1, 48);
    case 1: return ngon(0, 0, 1, 4, Math.PI / 4);
    case 2: return ngon(0, 0, 1, 3, -Math.PI / 2);
    case 3: return star(0, 0, 1, inner, 5);
    case 4: { const out: Ring = []; for (let k = 0; k <= 24; k++) { const a = (Math.PI * k) / 24; out.push([Math.cos(a), Math.sin(a) - 0.4]); } return out; } // semicircle
    case 5: return polar(0, 0, (a) => Math.abs(Math.cos(a)) ** 0.6 * 1, 64).map(([x, y]) => [x, y * 0.5] as [number, number]); // petal/lens
    case 6: return ngon(0, 0, 1, 6, 0);
    default: return [[0, 1], [0.35, 0.35], [1, 0], [0.35, -0.35], [0, -1], [-0.35, -0.35], [-1, 0], [-0.35, 0.35]]; // sparkle
  }
}
export const SHAPE_NAMES = ['circle', 'square', 'triangle', 'star', 'semicircle', 'petal', 'hexagon', 'sparkle'];

/** Thick stroke along a polyline (butt ends), as one ring. Fine for smooth, non-overlapping curves. */
export function stroke(pts: [number, number][], w: number): Ring {
  if (pts.length < 2) return [];
  const L: Ring = [], R: Ring = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    let dx = b[0] - a[0], dy = b[1] - a[1];
    const l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l;
    const h = w / 2;
    L.push([pts[i][0] - dy * h, pts[i][1] + dx * h]);
    R.push([pts[i][0] + dy * h, pts[i][1] - dx * h]);
  }
  return [...L, ...R.reverse()];
}

/** Smooth 1-D value noise in [0,1], periodic over `period` samples. */
export function noise1(rnd: Rnd, period: number): (t: number) => number {
  const v = Array.from({ length: period }, rnd);
  return (t) => {
    const x = ((t % period) + period) % period, i = Math.floor(x), f = x - i, s = f * f * (3 - 2 * f);
    return v[i] * (1 - s) + v[(i + 1) % period] * s;
  };
}

/** Voronoi cell of site i within a rectangle (half-plane clipping). */
export function voronoiCell(sites: [number, number][], i: number, box: Ring): Ring {
  let poly = box;
  const [px, py] = sites[i];
  for (let j = 0; j < sites.length && poly.length; j++) {
    if (j === i) continue;
    const [qx, qy] = sites[j];
    const mx = (px + qx) / 2, my = (py + qy) / 2, nx = qx - px, ny = qy - py;
    const side = (p: [number, number]) => (p[0] - mx) * nx + (p[1] - my) * ny; // <= 0 keeps p's side
    const out: Ring = [];
    for (let k = 0; k < poly.length; k++) {
      const a = poly[k], b = poly[(k + 1) % poly.length], sa = side(a), sb = side(b);
      if (sa <= 0) out.push(a);
      if ((sa <= 0) !== (sb <= 0)) { const t = sa / (sa - sb); out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]); }
    }
    poly = out;
  }
  return poly;
}

/** Shrink a convex polygon towards its centroid by `gap` mm (approximate inset). */
export function shrink(r: Ring, gap: number): Ring {
  if (r.length < 3) return r;
  const cx = r.reduce((s, p) => s + p[0], 0) / r.length, cy = r.reduce((s, p) => s + p[1], 0) / r.length;
  return r.map(([x, y]) => { const d = Math.hypot(x - cx, y - cy) || 1, k = Math.max(0, (d - gap) / d); return [cx + (x - cx) * k, cy + (y - cy) * k] as [number, number]; });
}

/** Clip a ring to a rectangle (Sutherland–Hodgman). */
export function clipRect(r: Ring, x0: number, y0: number, x1: number, y1: number): Ring {
  let poly = r;
  const edges: [(p: [number, number]) => number, number, number][] = [[(p) => p[0] - x0, 0, x0], [(p) => x1 - p[0], 0, x1], [(p) => p[1] - y0, 1, y0], [(p) => y1 - p[1], 1, y1]];
  for (const [f, axis, v] of edges) {
    const out: Ring = [];
    for (let k = 0; k < poly.length; k++) {
      const a = poly[k], b = poly[(k + 1) % poly.length], fa = f(a), fb = f(b);
      if (fa >= 0) out.push(a);
      if ((fa >= 0) !== (fb >= 0)) {
        const t = (axis === 0 ? (v - a[0]) / (b[0] - a[0]) : (v - a[1]) / (b[1] - a[1]));
        out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      }
    }
    poly = out;
    if (!poly.length) break;
  }
  return poly;
}
