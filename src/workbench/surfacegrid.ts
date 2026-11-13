// Feature-following surface sampling. A relief is a height field over (height, angle); sampling it on a
// plain grid turns every sharp pattern edge into a staircase. Here every grid edge that a pattern edge
// crosses is located exactly (bisection on the real function) and the nearer grid point is moved onto it,
// so the mesh outline follows the pattern's true geometry. Quads are then split along the edge, not across.
// Points stay exactly on the surface: their radius is evaluated at the moved (height, angle).
import { makeInner, makeSurface, type Design } from './design';

export interface SurfaceGrid {
  rows: number; cols: number;
  /** x, y, z per grid point, (rows+1)·(cols+1) points, row-major from the bottom. */
  pos: Float32Array;
  /** relief level per point (for choosing the split of each quad). */
  f: Float32Array;
  /** 1 where the point was moved onto a pattern edge. */
  moved: Uint8Array;
}

const TAU = Math.PI * 2;

export function surfaceGrid(d: Design, rows: number, cols: number, face: 'outer' | 'inner', snap = true, levels: number[] = [0.5, 0.1, 0.9]): SurfaceGrid {
  const surf = face === 'outer' ? makeSurface(d) : makeInner(d);
  const plain = face === 'outer' ? makeSurface({ ...d, relief: { ...d.relief, kind: 'smooth' } }) : makeInner({ ...d, relief: { ...d.relief, kind: 'smooth' } });
  const W = cols + 1, N = (rows + 1) * W, H = d.height;
  const zs = new Float64Array(N), ths = new Float64Array(N), f = new Float32Array(N);
  const level = (z: number, th: number) => Math.abs(surf(z, th) - plain(z, th));
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i <= rows; i++) for (let j = 0; j <= cols; j++) {
    const k = i * W + j, z = (i / rows) * H, th = (j / cols) * TAU;
    zs[k] = z; ths[k] = th;
    const v = level(z, th); f[k] = v; if (v < lo) lo = v; if (v > hi) hi = v;
  }
  const hasRelief = d.relief.kind !== 'smooth' && d.relief.depth !== 0 && hi - lo > 1e-3;
  const moved = new Uint8Array(N);
  if (snap && hasRelief) {
    // Trace the foot, the middle and the top of every slope (three levels), each onto its own grid points,
    // so the whole bevel — not just its centre line — follows the pattern's true outline.
    const sz = new Float64Array(N), sth = new Float64Array(N), cnt = new Uint16Array(N), side = new Uint8Array(N);
    for (const lvl of levels) {
      const iso = lo + (hi - lo) * lvl;
      sz.fill(0); sth.fill(0); cnt.fill(0); side.fill(0);
      // dir: which neighbour the crossing lies towards (1 right, 2 left, 4 up, 8 down)
      const cross = (a: number, b: number, dirA: number, dirB: number) => {
        const fa = f[a] - iso, fb = f[b] - iso;
        if (fa * fb >= 0) return;
        let t0 = 0, t1 = 1;
        const za = zs[a], ta = ths[a], dz = zs[b] - za, dt = ths[b] - ta;
        for (let it = 0; it < 8; it++) { const tm = (t0 + t1) / 2; if ((level(za + dz * tm, ta + dt * tm) - iso) * fa > 0) t0 = tm; else t1 = tm; }
        const t = (t0 + t1) / 2;
        // nearer endpoint that is still free; a point already on a traced line stays there
        let k = t < 0.5 ? a : b;
        if (moved[k]) k = k === a ? b : a;
        if (moved[k]) return;
        sz[k] += za + dz * t; sth[k] += ta + dt * t; cnt[k]++; side[k] |= k === a ? dirA : dirB;
      };
      for (let i = 0; i <= rows; i++) for (let j = 0; j <= cols; j++) {
        const k = i * W + j;
        if (j < cols) cross(k, k + 1, 1, 2);
        if (i < rows) cross(k, k + W, 4, 8);
      }
      for (let k = 0; k < N; k++) if (cnt[k]) {
        // a point with edges on both sides sits in a ridge narrower than two cells: moving it would fold the mesh
        if ((side[k] & 3) === 3 || (side[k] & 12) === 12) continue;
        const i = Math.floor(k / W);
        if (i !== 0 && i !== rows) zs[k] = sz[k] / cnt[k];     // keep the base and the rim flat
        ths[k] = sth[k] / cnt[k];
        moved[k] = 1;
        f[k] = level(zs[k], ths[k]);
      }
    }
    // the seam column (2π) mirrors column 0
    for (let i = 0; i <= rows; i++) { const a = i * W, b = a + cols; zs[b] = zs[a]; ths[b] = ths[a] + TAU; f[b] = f[a]; }
  }
  const pos = new Float32Array(N * 3);
  for (let k = 0; k < N; k++) {
    const r = surf(zs[k], ths[k]);
    pos[k * 3] = r * Math.cos(ths[k]); pos[k * 3 + 1] = r * Math.sin(ths[k]); pos[k * 3 + 2] = zs[k];
  }
  return { rows, cols, pos, f, moved };
}

/** Split each quad along the diagonal whose ends are most alike, so triangles follow pattern edges. */
export function quadDiagonal(f: Float32Array, a: number, b: number, c: number, e: number): boolean {
  // a=(i,j) b=(i,j+1) c=(i+1,j) e=(i+1,j+1); true = split a–e, false = split b–c
  return Math.abs(f[a] - f[e]) <= Math.abs(f[b] - f[c]);
}

/**
 * Triangles for a grid face. Flat stretches (no relief change, nothing traced) are joined into blocks of up to
 * ~2 mm, each fanned from its centre over every grid point on its border — so neighbours always share the
 * same edge points (no cracks) and the curve error stays far below 0.01 mm. Everything else gets a quad
 * per cell, split along the pattern edge. `flip` reverses the winding (inner face).
 */
export function triangulate(g: SurfaceGrid, rowMM: number, colMM: number, eps: number, flip: boolean, base = 0, blockMM = 2): Uint32Array {
  const { rows, cols, f, moved } = g, W = cols + 1;
  const even = (v: number) => Math.max(2, Math.min(32, Math.floor(v / 2) * 2));
  const sr = even(blockMM / Math.max(1e-3, rowMM)), sc = even(blockMM / Math.max(1e-3, colMM));
  const out: number[] = [];
  const tri = (a: number, b: number, c: number) => { if (flip) out.push(base + a, base + c, base + b); else out.push(base + a, base + b, base + c); };
  const quad = (i: number, j: number) => {
    const a = i * W + j, b = a + 1, c = a + W, e = c + 1;
    if (quadDiagonal(f, a, b, c, e)) { tri(a, b, e); tri(a, e, c); } else { tri(a, b, c); tri(b, e, c); }
  };
  const flat = (i0: number, j0: number) => {
    const f0 = f[i0 * W + j0];
    for (let i = i0; i <= i0 + sr; i++) for (let j = j0; j <= j0 + sc; j++) { const k = i * W + j; if (moved[k] || Math.abs(f[k] - f0) > eps) return false; }
    return true;
  };
  for (let i0 = 0; i0 < rows; i0 += sr) for (let j0 = 0; j0 < cols; j0 += sc) {
    const fits = i0 + sr <= rows && j0 + sc <= cols;
    if (fits && (sr > 1 || sc > 1) && flat(i0, j0)) {
      const ctr = (i0 + sr / 2) * W + (j0 + sc / 2), ring: number[] = [];
      for (let j = j0; j < j0 + sc; j++) ring.push(i0 * W + j);
      for (let i = i0; i < i0 + sr; i++) ring.push(i * W + j0 + sc);
      for (let j = j0 + sc; j > j0; j--) ring.push((i0 + sr) * W + j);
      for (let i = i0 + sr; i > i0; i--) ring.push(i * W + j0);
      for (let k = 0; k < ring.length; k++) tri(ctr, ring[k], ring[(k + 1) % ring.length]);
    } else {
      for (let i = i0; i < Math.min(rows, i0 + sr); i++) for (let j = j0; j < Math.min(cols, j0 + sc); j++) quad(i, j);
    }
  }
  return Uint32Array.from(out);
}
