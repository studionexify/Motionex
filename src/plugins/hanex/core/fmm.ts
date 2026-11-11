// Eikonal solver: |∇D| = 1/F on a regular grid, by the Fast Marching Method (Sethian 1996)
// with the second-order upwind stencil where the two upwind neighbours are known.
//
// Nodes outside the domain are impassable (F = 0), so the front bends around holes: the
// solution is the geodesic distance inside the domain, which is what makes the waves diffract
// round obstacles instead of jumping across them like a Euclidean offset would.
import { distToSegment, type Ring, type Vec2 } from './geom';

export interface Grid {
  /** World position of node (0, 0), mm. */
  x0: number;
  y0: number;
  /** Node spacing, mm. */
  h: number;
  nx: number;
  ny: number;
  /** 1 where the node lies inside the propagation domain. */
  inside: Uint8Array;
}

export const nodeX = (g: Grid, i: number) => g.x0 + i * g.h;
export const nodeY = (g: Grid, j: number) => g.y0 + j * g.h;

/** Build a grid covering the rings' bounds (plus margin) and mark nodes inside them (even-odd). */
export function rasterize(rings: Ring[], h: number, margin = 2 * h): Grid {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rings) for (const [x, y] of r) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  x0 -= margin; y0 -= margin; x1 += margin; y1 += margin;
  const nx = Math.ceil((x1 - x0) / h) + 1, ny = Math.ceil((y1 - y0) / h) + 1;
  const inside = new Uint8Array(nx * ny);
  const xs: number[] = [];
  for (let j = 0; j < ny; j++) {
    const y = y0 + j * h;
    xs.length = 0;
    for (const r of rings) {
      for (let a = 0, b = r.length - 1; a < r.length; b = a++) {
        const [xa, ya] = r[a], [xb, yb] = r[b];
        if ((ya > y) !== (yb > y)) xs.push(xa + ((y - ya) * (xb - xa)) / (yb - ya));
      }
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil((xs[k] - x0) / h)), i1 = Math.min(nx - 1, Math.floor((xs[k + 1] - x0) / h));
      for (let i = i0; i <= i1; i++) inside[j * nx + i] = 1;
    }
  }
  return { x0, y0, h, nx, ny, inside };
}

/** A wave source: a point or an open polyline along which D = 0. */
export type Seed = { kind: 'point'; p: Vec2 } | { kind: 'polyline'; pts: Vec2[] };

const TRIAL = 1, KNOWN = 2;

/** Binary min-heap of node indices keyed by tentative distance (lazy deletion). */
class Heap {
  private k: number[] = [];
  private v: number[] = [];
  get size() { return this.k.length; }
  push(key: number, val: number) {
    const k = this.k, v = this.v;
    let i = k.length; k.push(key); v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p]; v[i] = v[p]; i = p;
    }
    k[i] = key; v[i] = val;
  }
  pop(): number {
    const k = this.k, v = this.v;
    const top = v[0];
    const lk = k.pop()!, lv = v.pop()!;
    const n = k.length;
    if (n) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const c = l + 1 < n && k[l + 1] < k[l] ? l + 1 : l;
        if (k[c] >= lk) break;
        k[i] = k[c]; v[i] = v[c]; i = c;
      }
      k[i] = lk; v[i] = lv;
    }
    return top;
  }
}

export interface MarchOptions {
  /** Propagation speed per node (default 1 everywhere). Must be > 0 inside the domain. */
  speed?: Float32Array;
  /** Nodes within this distance of a seed get the exact Euclidean distance (default 6 h; measured
   *  max error on a point source falls from 0.26 h to 0.09 h when going from 2.5 h to 6 h). */
  initRadius?: number;
  /** Disable the second-order stencil (for comparison tests). */
  firstOrder?: boolean;
}

/**
 * Solve the eikonal equation from the seeds. Returns D per node (Infinity outside the domain
 * or where unreachable).
 */
export function fastMarch(g: Grid, seeds: Seed[], opts: MarchOptions = {}): Float64Array {
  const { nx, ny, h, inside } = g;
  const N = nx * ny;
  const D = new Float64Array(N).fill(Infinity);
  const state = new Uint8Array(N);
  const speed = opts.speed;
  const r0 = opts.initRadius ?? 6 * h;
  const heap = new Heap();

  // 1. exact initialisation in a small tube around each seed (removes the O(h log h) point-source error)
  const initNode = (i: number, j: number, d: number) => {
    const id = j * nx + i;
    if (!inside[id]) return;
    const f = speed ? speed[id] : 1;
    if (d / f < D[id]) D[id] = d / f;
    state[id] = KNOWN;
  };
  const span = (a: number, b: number, o: number) => [Math.max(0, Math.floor((a - r0 - o) / h)), Math.min(b, Math.ceil((a + r0 - o) / h))];
  for (const s of seeds) {
    const segs: [Vec2, Vec2][] = s.kind === 'point' ? [[s.p, s.p]] : s.pts.slice(1).map((p, k) => [s.pts[k], p]);
    for (const [a, b] of segs) {
      const [i0] = span(Math.min(a[0], b[0]), nx - 1, g.x0), [, i1] = span(Math.max(a[0], b[0]), nx - 1, g.x0);
      const [j0] = span(Math.min(a[1], b[1]), ny - 1, g.y0), [, j1] = span(Math.max(a[1], b[1]), ny - 1, g.y0);
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const d = distToSegment([g.x0 + i * h, g.y0 + j * h], a, b);
        if (d <= r0) initNode(i, j, d);
      }
    }
  }

  // 2. local update of one node from its known neighbours
  const valid = (i: number, j: number) => i >= 0 && j >= 0 && i < nx && j < ny;
  const known = (i: number, j: number) => valid(i, j) && state[j * nx + i] === KNOWN;
  // per-axis upwind term: alpha·(T − beta)² ; t1 is the nearest upwind value (for the causality check)
  const axis = (i: number, j: number, di: number, dj: number, second: boolean) => {
    let best = Infinity, bi = 0;
    for (const s of [-1, 1]) {
      if (known(i + s * di, j + s * dj)) {
        const t = D[(j + s * dj) * nx + i + s * di];
        if (t < best) { best = t; bi = s; }
      }
    }
    if (best === Infinity) return null;
    if (second && known(i + 2 * bi * di, j + 2 * bi * dj)) {
      const t2 = D[(j + 2 * bi * dj) * nx + i + 2 * bi * di];
      if (t2 <= best) return { alpha: 9 / (4 * h * h), beta: (4 * best - t2) / 3, t1: best };
    }
    return { alpha: 1 / (h * h), beta: best, t1: best };
  };
  const solve = (terms: { alpha: number; beta: number; t1: number }[], rhs: number): number => {
    if (terms.length === 2) {
      const [p, q] = terms;
      const a = p.alpha + q.alpha;
      const b = -2 * (p.alpha * p.beta + q.alpha * q.beta);
      const c = p.alpha * p.beta * p.beta + q.alpha * q.beta * q.beta - rhs;
      const disc = b * b - 4 * a * c;
      if (disc >= 0) {
        const t = (-b + Math.sqrt(disc)) / (2 * a);
        if (t >= Math.max(p.t1, q.t1)) return t;
      }
      return Infinity;
    }
    const [p] = terms;
    return p.beta + Math.sqrt(rhs / p.alpha);
  };
  const update = (i: number, j: number) => {
    const id = j * nx + i;
    const f = speed ? speed[id] : 1;
    if (!(f > 0)) return;
    const rhs = 1 / (f * f);
    let t = Infinity;
    for (const second of opts.firstOrder ? [false] : [true, false]) {
      const terms = [axis(i, j, 1, 0, second), axis(i, j, 0, 1, second)].filter((x): x is NonNullable<typeof x> => !!x);
      if (!terms.length) return;
      if (terms.length === 2) t = solve(terms, rhs);
      if (t === Infinity) {
        // causality failed with both axes: fall back to the single best axis
        const one = terms.map((x) => solve([x], rhs));
        t = Math.min(...one);
      }
      if (t < Infinity) break;
    }
    if (t < D[id]) { D[id] = t; state[id] = TRIAL; heap.push(t, id); }
  };

  const touch = (id: number) => {
    const i = id % nx, j = (id - i) / nx;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const a = i + di, b = j + dj;
      if (!valid(a, b)) continue;
      const nid = b * nx + a;
      if (inside[nid] && state[nid] !== KNOWN) update(a, b);
    }
  };

  for (let id = 0; id < N; id++) if (state[id] === KNOWN) touch(id);
  // 3. march
  while (heap.size) {
    const id = heap.pop();
    if (state[id] === KNOWN) continue;
    state[id] = KNOWN;
    touch(id);
  }
  return D;
}

/** Bilinear sample of a node field at a world point (NaN outside the grid or next to unreached nodes). */
export function sample(g: Grid, D: Float64Array, x: number, y: number): number {
  const fx = (x - g.x0) / g.h, fy = (y - g.y0) / g.h;
  const i = Math.floor(fx), j = Math.floor(fy);
  if (i < 0 || j < 0 || i + 1 >= g.nx || j + 1 >= g.ny) return NaN;
  const tx = fx - i, ty = fy - j;
  const a = D[j * g.nx + i], b = D[j * g.nx + i + 1], c = D[(j + 1) * g.nx + i], d = D[(j + 1) * g.nx + i + 1];
  if (![a, b, c, d].every(Number.isFinite)) return NaN;
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}
