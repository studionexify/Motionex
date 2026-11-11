// Eikonal wavefront & heat-method offsets (#15). Distance from a layer region's boundary as a PDE
// solution on a raster grid: either fast sweeping of the Eikonal equation |∇φ| = 1/f, or Crane's heat
// method (short-time heat flow, normalised gradient, Poisson solve), whose isolines stay smooth
// through medial-axis corners. Inner walls are extracted as isolines and smoothed into C² loops.
import { cleanPaths, SCALE, unionEvenOdd } from '../clipper';
import type { ExPolygon, Path, Paths } from '../types';
import { solveMasked2, solveSparse2 } from './solvers';

export interface RasterRegion { nx: number; ny: number; ox: number; oy: number; h: number; mask: Uint8Array }

/** Rasterise polygons (even–odd) onto cell centres, with `pad` empty cells around. */
export function rasterize(paths: Paths, h: number, pad = 2): RasterRegion | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of paths) for (const q of p) { minX = Math.min(minX, q.X); minY = Math.min(minY, q.Y); maxX = Math.max(maxX, q.X); maxY = Math.max(maxY, q.Y); }
  if (!Number.isFinite(minX)) return null;
  const x0 = minX / SCALE - pad * h, y0 = minY / SCALE - pad * h;
  const nx = Math.ceil((maxX - minX) / SCALE / h) + 2 * pad + 1, ny = Math.ceil((maxY - minY) / SCALE / h) + 2 * pad + 1;
  const mask = new Uint8Array(nx * ny);
  const edges: [number, number, number, number][] = [];
  for (const p of paths) for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; edges.push([a.X / SCALE, a.Y / SCALE, b.X / SCALE, b.Y / SCALE]); }
  const xs: number[] = [];
  for (let j = 0; j < ny; j++) {
    const y = y0 + (j + 0.5) * h;
    xs.length = 0;
    for (const [ax, ay, bx, by] of edges) {
      if ((ay <= y) === (by <= y)) continue;
      xs.push(ax + ((y - ay) / (by - ay)) * (bx - ax));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil((xs[k] - x0) / h - 0.5)), i1 = Math.min(nx - 1, Math.floor((xs[k + 1] - x0) / h - 0.5));
      for (let i = i0; i <= i1; i++) mask[i + nx * j] = 1;
    }
  }
  return { nx, ny, ox: x0 + h / 2, oy: y0 + h / 2, h, mask };
}

/**
 * Heat-method distance from the region's boundary (positive inside, 0 outside).
 * 1. heat flow (I − tΔ)u = 0 with u = 1 on the boundary, 2. X = −∇u/|∇u|, 3. Δφ = ∇·X, φ = 0 on the boundary.
 * t is at least (reach/16)² so the heat stays representable (e^−16 ≫ solver error) across the region.
 */
export function heatDistance(r: RasterRegion, smooth = 2, reach?: number): Float64Array {
  const { nx, ny, h, mask } = r;
  let far = reach ?? 0;
  if (!far) {
    // a cheap bound on the deepest point: chessboard distance transform
    const d = new Float64Array(nx * ny);
    for (let p = 0; p < d.length; p++) d[p] = mask[p] ? 1e9 : 0;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { const p = i + nx * j; if (d[p]) d[p] = Math.min(d[p], (i ? d[p - 1] : 0) + 1, (j ? d[p - nx] : 0) + 1); }
    for (let j = ny - 1; j >= 0; j--) for (let i = nx - 1; i >= 0; i--) { const p = i + nx * j; if (d[p]) d[p] = Math.min(d[p], (i < nx - 1 ? d[p + 1] : 0) + 1, (j < ny - 1 ? d[p + nx] : 0) + 1); }
    for (const v of d) far = Math.max(far, v * h);
  }
  const t = Math.max(smooth * h * h, (far / 16) ** 2);
  const k = t / (h * h);
  // boundary values move to the right-hand side: each outside neighbour contributes k·1
  const f = new Float64Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const p = i + nx * j;
    if (!mask[p]) continue;
    let c = 0;
    if (i === 0 || !mask[p - 1]) c++;
    if (i === nx - 1 || !mask[p + 1]) c++;
    if (j === 0 || !mask[p - nx]) c++;
    if (j === ny - 1 || !mask[p + nx]) c++;
    f[p] = k * c;
  }
  const u = solveMasked2(nx, ny, h, mask, 1, t, f, 1e-13, 300).x;
  const val = (i: number, j: number) => (i < 0 || j < 0 || i >= nx || j >= ny || !mask[i + nx * j] ? 1 : u[i + nx * j]);
  const X = new Float64Array(nx * ny), Y = new Float64Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const p = i + nx * j;
    if (!mask[p]) continue;
    const gx = (val(i + 1, j) - val(i - 1, j)) / (2 * h), gy = (val(i, j + 1) - val(i, j - 1)) / (2 * h);
    const g = Math.hypot(gx, gy);
    if (g > 1e-300) { X[p] = -gx / g; Y[p] = -gy / g; }
  }
  // the field continues across the boundary as the boundary normal (one-sided differences)
  const vx = (i: number, j: number, ci: number, cj: number) => (i < 0 || j < 0 || i >= nx || j >= ny || !mask[i + nx * j] ? X[ci + nx * cj] : X[i + nx * j]);
  const vy = (i: number, j: number, ci: number, cj: number) => (i < 0 || j < 0 || i >= nx || j >= ny || !mask[i + nx * j] ? Y[ci + nx * cj] : Y[i + nx * j]);
  const div = new Float64Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const p = i + nx * j;
    if (!mask[p]) continue;
    div[p] = -((vx(i + 1, j, i, j) - vx(i - 1, j, i, j)) / (2 * h) + (vy(i, j + 1, i, j) - vy(i, j - 1, i, j)) / (2 * h));
  }
  const phi = solveMasked2(nx, ny, h, mask, 0, 1, div, 1e-9, 300).x;
  // φ = 0 sits on the outside cell centres, half a cell beyond the true boundary on average
  for (let p = 0; p < phi.length; p++) if (mask[p]) phi[p] = Math.max(0, phi[p] - h / 2);
  return phi;
}

/**
 * Heat method on the band of cells within `reach` of the boundary, anchored to the Eikonal distance
 * `df` on the band's inner edge (Dirichlet). Same PDEs as `heatDistance`, a fraction of the cells,
 * and smoothing set only by `smooth` (not by the part size).
 */
export function heatDistanceBand(r: RasterRegion, df: Float64Array, reach: number, smooth = 2): Float64Array {
  const { nx, ny, h, mask } = r;
  const band = new Uint8Array(nx * ny);
  let n = 0;
  for (let p = 0; p < band.length; p++) if (mask[p] && df[p] <= reach) { band[p] = 1; n++; }
  if (n < 8) return df;
  const t = Math.max(smooth * h * h, (reach / 16) ** 2);
  const k = t / (h * h);
  // neighbour value outside the band: the region's outside (u = 1, φ = 0) or the deep inside (u = 0, φ = df)
  const outU = (q: number) => (mask[q] ? 0 : 1);
  const outPhi = (q: number) => (mask[q] ? df[q] : 0);
  const rhs = (val: (q: number) => number, kk: number) => {
    const f = new Float64Array(nx * ny);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const p = i + nx * j;
      if (!band[p]) continue;
      let s = 0;
      if (i === 0) s += 1 * (val === outU ? 1 : 0); else if (!band[p - 1]) s += val(p - 1);
      if (i === nx - 1) s += val === outU ? 1 : 0; else if (!band[p + 1]) s += val(p + 1);
      if (j === 0) s += val === outU ? 1 : 0; else if (!band[p - nx]) s += val(p - nx);
      if (j === ny - 1) s += val === outU ? 1 : 0; else if (!band[p + nx]) s += val(p + nx);
      f[p] = kk * s;
    }
    return f;
  };
  const u = solveSparse2(nx, ny, h, band, 1, t, rhs(outU, k), 1e-11, 400).x;
  const uv = (i: number, j: number) => { if (i < 0 || j < 0 || i >= nx || j >= ny) return 1; const q = i + nx * j; return band[q] ? u[q] : outU(q); };
  const X = new Float64Array(nx * ny), Y = new Float64Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const p = i + nx * j;
    if (!band[p]) continue;
    const gx = (uv(i + 1, j) - uv(i - 1, j)) / (2 * h), gy = (uv(i, j + 1) - uv(i, j - 1)) / (2 * h);
    const g = Math.hypot(gx, gy);
    if (g > 1e-300) { X[p] = -gx / g; Y[p] = -gy / g; }
  }
  const vx = (i: number, j: number, c: number) => (i < 0 || j < 0 || i >= nx || j >= ny || !band[i + nx * j] ? X[c] : X[i + nx * j]);
  const vy = (i: number, j: number, c: number) => (i < 0 || j < 0 || i >= nx || j >= ny || !band[i + nx * j] ? Y[c] : Y[i + nx * j]);
  const f = rhs(outPhi, 1 / (h * h));
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const p = i + nx * j;
    if (!band[p]) continue;
    f[p] -= (vx(i + 1, j, p) - vx(i - 1, j, p)) / (2 * h) + (vy(i, j + 1, p) - vy(i, j - 1, p)) / (2 * h);
  }
  const phi = solveSparse2(nx, ny, h, band, 0, 1, f, 1e-8, 600).x;
  const out = new Float64Array(nx * ny);
  for (let p = 0; p < out.length; p++) out[p] = band[p] ? Math.max(0, phi[p] - h / 2 * (1 - Math.min(1, df[p] / reach))) : mask[p] ? df[p] : 0;
  return out;
}

/** Fast-sweeping Eikonal distance |∇φ| = 1/f from the boundary (f = 1 when no speed map is given). */
export function eikonalDistance(r: RasterRegion, paths: Paths, speed?: Float64Array): Float64Array {
  const { nx, ny, h, mask } = r;
  const d = new Float64Array(nx * ny).fill(Infinity);
  const segs: [number, number, number, number][] = [];
  for (const p of paths) for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; segs.push([a.X / SCALE, a.Y / SCALE, b.X / SCALE, b.Y / SCALE]); }
  // exact distances for cells touching the boundary
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const p = i + nx * j;
    if (!mask[p]) { d[p] = 0; continue; }
    const edge = (i > 0 && !mask[p - 1]) || (i < nx - 1 && !mask[p + 1]) || (j > 0 && !mask[p - nx]) || (j < ny - 1 && !mask[p + nx]);
    if (!edge) continue;
    const x = r.ox + i * h, y = r.oy + j * h;
    let best = Infinity;
    for (const [ax, ay, bx, by] of segs) {
      const ex = bx - ax, ey = by - ay, l2 = ex * ex + ey * ey;
      const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / l2)) : 0;
      best = Math.min(best, Math.hypot(x - ax - t * ex, y - ay - t * ey));
    }
    d[p] = best;
  }
  for (let round = 0; round < 2; round++) for (let o = 0; o < 4; o++) {
    const di = o & 1 ? -1 : 1, dj = o & 2 ? -1 : 1;
    for (let j = dj > 0 ? 0 : ny - 1; j >= 0 && j < ny; j += dj) for (let i = di > 0 ? 0 : nx - 1; i >= 0 && i < nx; i += di) {
      const p = i + nx * j;
      if (!mask[p]) continue;
      const a = Math.min(i > 0 ? d[p - 1] : Infinity, i < nx - 1 ? d[p + 1] : Infinity);
      const b = Math.min(j > 0 ? d[p - nx] : Infinity, j < ny - 1 ? d[p + nx] : Infinity);
      const hf = speed ? h / Math.max(1e-6, speed[p]) : h;
      let u: number;
      if (Math.abs(a - b) >= hf) u = Math.min(a, b) + hf;
      else u = (a + b + Math.sqrt(2 * hf * hf - (a - b) * (a - b))) / 2;
      if (u < d[p]) d[p] = u;
    }
  }
  return d;
}

/** Distance to the edge of a raster mask (boundary cells at half a cell), by fast sweeping. */
export function maskDistance(r: RasterRegion): Float64Array {
  const { nx, ny, h, mask } = r;
  const d = new Float64Array(nx * ny).fill(Infinity);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const p = i + nx * j;
    if (!mask[p]) { d[p] = 0; continue; }
    const edge = i === 0 || j === 0 || i === nx - 1 || j === ny - 1 || !mask[p - 1] || !mask[p + 1] || !mask[p - nx] || !mask[p + nx];
    if (edge) d[p] = h / 2;
  }
  for (let round = 0; round < 2; round++) for (let o = 0; o < 4; o++) {
    const di = o & 1 ? -1 : 1, dj = o & 2 ? -1 : 1;
    for (let j = dj > 0 ? 0 : ny - 1; j >= 0 && j < ny; j += dj) for (let i = di > 0 ? 0 : nx - 1; i >= 0 && i < nx; i += di) {
      const p = i + nx * j;
      if (!mask[p]) continue;
      const a = Math.min(i > 0 ? d[p - 1] : Infinity, i < nx - 1 ? d[p + 1] : Infinity);
      const b = Math.min(j > 0 ? d[p - nx] : Infinity, j < ny - 1 ? d[p + nx] : Infinity);
      const u = Math.abs(a - b) >= h ? Math.min(a, b) + h : (a + b + Math.sqrt(2 * h * h - (a - b) * (a - b))) / 2;
      if (u < d[p]) d[p] = u;
    }
  }
  return d;
}

/** Closed isolines φ = level by marching squares (cell centres as samples), in mm. */
export function isolines(r: RasterRegion, phi: Float64Array, level: number): number[][] {
  const { nx, ny, h, ox, oy } = r;
  const at = (i: number, j: number) => (i < 0 || j < 0 || i >= nx || j >= ny ? 0 : phi[i + nx * j]);
  // segments keyed by the grid edge each endpoint lies on (exact chaining)
  const edgeKey = (i: number, j: number, dir: 0 | 1) => (j * (nx + 1) + i) * 2 + dir;
  const pos = new Map<number, [number, number]>();
  const next = new Map<number, number>();
  const point = (i: number, j: number, dir: 0 | 1): number => {
    const k = edgeKey(i, j, dir);
    if (!pos.has(k)) {
      const a = at(i, j), b = dir === 0 ? at(i + 1, j) : at(i, j + 1);
      const t = Math.abs(b - a) > 1e-15 ? (level - a) / (b - a) : 0.5;
      pos.set(k, dir === 0 ? [ox + (i + t) * h, oy + j * h] : [ox + i * h, oy + (j + t) * h]);
    }
    return k;
  };
  for (let j = -1; j < ny; j++) for (let i = -1; i < nx; i++) {
    const a = at(i, j) >= level ? 1 : 0, b = at(i + 1, j) >= level ? 1 : 0, c = at(i + 1, j + 1) >= level ? 1 : 0, d = at(i, j + 1) >= level ? 1 : 0;
    const code = a | (b << 1) | (c << 2) | (d << 3);
    if (code === 0 || code === 15) continue;
    // edges of the square: bottom (i,j)→(i+1,j), right (i+1,j)→(i+1,j+1), top (i,j+1)→(i+1,j+1), left (i,j)→(i,j+1)
    const B = () => point(i, j, 0), R = () => point(i + 1, j, 1), T = () => point(i, j + 1, 0), L = () => point(i, j, 1);
    // every segment has the region (≥ level) on its right; loops are reversed below to run
    // counter-clockwise round the region like Clipper's outer contours
    const seg = (p: number, q: number) => next.set(p, q);
    switch (code) {
      case 1: seg(L(), B()); break;
      case 2: seg(B(), R()); break;
      case 3: seg(L(), R()); break;
      case 4: seg(R(), T()); break;
      case 5: { const cen = (at(i, j) + at(i + 1, j) + at(i + 1, j + 1) + at(i, j + 1)) / 4; if (cen >= level) { seg(L(), T()); seg(R(), B()); } else { seg(L(), B()); seg(R(), T()); } break; }
      case 6: seg(B(), T()); break;
      case 7: seg(L(), T()); break;
      case 8: seg(T(), L()); break;
      case 9: seg(T(), B()); break;
      case 10: { const cen = (at(i, j) + at(i + 1, j) + at(i + 1, j + 1) + at(i, j + 1)) / 4; if (cen >= level) { seg(B(), L()); seg(T(), R()); } else { seg(B(), R()); seg(T(), L()); } break; }
      case 11: seg(T(), R()); break;
      case 12: seg(R(), L()); break;
      case 13: seg(R(), B()); break;
      case 14: seg(B(), L()); break;
    }
  }
  const loops: number[][] = [];
  const seen = new Set<number>();
  for (const start of next.keys()) {
    if (seen.has(start)) continue;
    const pts: number[] = [];
    let k: number | undefined = start;
    while (k !== undefined && !seen.has(k)) { seen.add(k); const p = pos.get(k)!; pts.push(p[0], p[1]); k = next.get(k); }
    if (pts.length >= 6 && k === start) {
      const rev: number[] = [];
      for (let q = pts.length - 2; q >= 0; q -= 2) rev.push(pts[q], pts[q + 1]);
      loops.push(rev);
    }
  }
  return loops;
}

/** Resample a closed loop at `step` and smooth it with a cubic B-spline (binomial) filter: C² curve. */
export function smoothLoop(pts: number[], step: number, passes = 3): number[] {
  const n = pts.length / 2;
  let L = 0;
  for (let i = 0; i < n; i++) L += Math.hypot(pts[((i + 1) % n) * 2] - pts[i * 2], pts[((i + 1) % n) * 2 + 1] - pts[i * 2 + 1]);
  const m = Math.max(8, Math.round(L / step));
  const out = new Float64Array(m * 2);
  let seg = 0, segStart = 0, segLen = Math.hypot(pts[2 % (n * 2)] - pts[0], pts[3 % (n * 2)] - pts[1]);
  for (let k = 0; k < m; k++) {
    const s = (k / m) * L;
    while (segStart + segLen < s && seg < n - 1) { segStart += segLen; seg++; const a = seg, b = (seg + 1) % n; segLen = Math.hypot(pts[b * 2] - pts[a * 2], pts[b * 2 + 1] - pts[a * 2 + 1]); }
    const a = seg, b = (seg + 1) % n, t = segLen > 0 ? (s - segStart) / segLen : 0;
    out[k * 2] = pts[a * 2] + (pts[b * 2] - pts[a * 2]) * t;
    out[k * 2 + 1] = pts[a * 2 + 1] + (pts[b * 2 + 1] - pts[a * 2 + 1]) * t;
  }
  let cur = out;
  for (let pass = 0; pass < passes; pass++) {
    const nx = new Float64Array(m * 2);
    for (let k = 0; k < m; k++) for (let c = 0; c < 2; c++) {
      const g = (o: number) => cur[(((k + o) % m) + m) % m * 2 + c];
      nx[k * 2 + c] = (g(-2) + 4 * g(-1) + 6 * g(0) + 4 * g(1) + g(2)) / 16;
    }
    cur = nx;
  }
  return Array.from(cur);
}

export const loopArea = (pts: number[]) => {
  let a = 0;
  const n = pts.length / 2;
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; a += pts[i * 2] * pts[j * 2 + 1] - pts[j * 2] * pts[i * 2 + 1]; }
  return a / 2;
};
export const loopLength = (pts: number[]) => {
  let L = 0;
  const n = pts.length / 2;
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; L += Math.hypot(pts[j * 2] - pts[i * 2], pts[j * 2 + 1] - pts[i * 2 + 1]); }
  return L;
};
export const toPath = (pts: number[]): Path => {
  const out: Path = [];
  for (let i = 0; i < pts.length; i += 2) out.push({ X: Math.round(pts[i] * SCALE), Y: Math.round(pts[i + 1] * SCALE) });
  return out;
};

export interface OffsetSet {
  /** Smoothed loops per requested level. */
  loops: number[][][];
  /** Region where φ ≥ the inner boundary level (for the infill). */
  inner: Paths;
}

/** Offsets of an island at several distances from its boundary, from one PDE distance field. */
export function pdeOffsets(ex: ExPolygon, levels: number[], innerLevel: number, o: { method: 'heat' | 'fmm'; cell: number; smooth: number; minLoop: number }): OffsetSet | null {
  const paths = [ex.contour, ...ex.holes];
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const q of ex.contour) { minX = Math.min(minX, q.X); maxX = Math.max(maxX, q.X); minY = Math.min(minY, q.Y); maxY = Math.max(maxY, q.Y); }
  const size = Math.max(maxX - minX, maxY - minY) / SCALE;
  const h = Math.max(o.cell, size / 180);
  const r = rasterize(paths, h);
  if (!r) return null;
  let count = 0;
  for (const v of r.mask) count += v;
  if (count < 30) return null;
  const df = eikonalDistance(r, paths);
  const reach = Math.max(...levels, innerLevel) + 4 * h;
  const phi = o.method === 'heat' ? heatDistanceBand(r, df, reach, o.smooth) : df;
  const step = Math.max(h * 0.75, 0.2);
  const loopsAt = (lev: number) => isolines(r, phi, lev)
    .map((l) => smoothLoop(l, step))
    .filter((l) => loopLength(l) >= o.minLoop && Math.abs(loopArea(l)) > o.minLoop * h * 0.25);
  const loops = levels.map(loopsAt);
  const innerLoops = loopsAt(innerLevel);
  // the infill boundary needs no 0.2 mm vertices: fewer points keep the region boolean operations fast
  const inner = innerLoops.length ? cleanPaths(unionEvenOdd(innerLoops.map(toPath)), 0.01) : [];
  return { loops, inner };
}
