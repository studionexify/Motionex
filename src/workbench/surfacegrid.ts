// Feature-following surface sampling. A relief is a height field over (height, angle); sampling it on a
// plain grid turns every sharp pattern edge into a staircase. Here every grid edge that a pattern edge
// crosses is located exactly (bisection on the real function) and the nearer grid point is moved onto it,
// so the mesh outline follows the pattern's true geometry. Quads are then split along the edge, not across.
// Points stay exactly on the surface: their radius is evaluated at the moved (height, angle).
import { surfaceParts, type Design } from './design';

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
  const parts = surfaceParts(d, face);
  const W = cols + 1, N = (rows + 1) * W, H = d.height;
  const zs = new Float64Array(N), ths = new Float64Array(N), f = new Float32Array(N), rv = new Float32Array(N);
  const level = (z: number, th: number) => Math.abs(parts.rel(z, th));
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i <= rows; i++) for (let j = 0; j <= cols; j++) {
    const k = i * W + j, z = (i / rows) * H, th = (j / cols) * TAU;
    zs[k] = z; ths[k] = th;
    const r0 = parts.on ? parts.rel(z, th) : 0, v = Math.abs(r0); rv[k] = r0; f[k] = v; if (v < lo) lo = v; if (v > hi) hi = v;
  }
  const hasRelief = parts.on && hi - lo > 1e-3;
  const moved = new Uint8Array(N);
  if (snap && hasRelief) {
    // Trace the foot, the middle and the top of every slope (three levels), each onto its own grid points,
    // so the whole bevel — not just its centre line — follows the pattern's true outline.
    // Points next to a pattern edge are projected straight onto it (along the local slope direction, in
    // millimetres on the surface), to whichever traced level — foot, middle or top of the bevel — is
    // nearest. Projection spaces the points evenly along every edge, straight or diagonal, and inside a
    // thin line each point goes to the edge on its own side.
    const R0 = d.maxDiameter / 2, dzc = H / rows, duc = (TAU * R0) / cols, cell = Math.min(dzc, duc);
    const isos = levels.map((l) => lo + (hi - lo) * l);
    const f0 = f.slice();   // levels before any point moves (for the local range)
    const scan = levels.length > 1 ? 6 : 4, iters = levels.length > 1 ? 7 : 5;
    const cand = new Uint8Array(N);
    for (let i = 0; i <= rows; i++) for (let j = 0; j <= cols; j++) {
      const k = i * W + j; let mn = f[k], mx = f[k];
      if (j > 0) { mn = Math.min(mn, f[k - 1]); mx = Math.max(mx, f[k - 1]); } if (j < cols) { mn = Math.min(mn, f[k + 1]); mx = Math.max(mx, f[k + 1]); }
      if (i > 0) { mn = Math.min(mn, f[k - W]); mx = Math.max(mx, f[k - W]); } if (i < rows) { mn = Math.min(mn, f[k + W]); mx = Math.max(mx, f[k + W]); }
      for (const v of isos) if (mn < v && mx > v) { cand[k] = 1; break; }
    }
    const lv = (z: number, u: number) => level(z, u / R0);
    for (let i = 0; i <= rows; i++) for (let j = 0; j < cols; j++) {
      const k = i * W + j; if (!cand[k]) continue;
      const z0 = zs[k], u0 = ths[k] * R0, h = cell * 0.35, edgeRow = i === 0 || i === rows;
      let gz = edgeRow ? 0 : (lv(z0 + h, u0) - lv(z0 - h, u0)) / (2 * h);
      const gu = (lv(z0, u0 + h) - lv(z0, u0 - h)) / (2 * h);
      const gl = Math.hypot(gz, gu); if (gl < 1e-9) continue;
      const dz = gz / gl, du = gu / gl, reach = cell * 0.6;
      // foot and top measured against this spot's own low and high (thin lines never reach full height)
      let llo = Infinity, lhi = -Infinity;
      for (let di = -2; di <= 2; di++) for (let dj = -2; dj <= 2; dj++) { const ii = i + di, jj = (j + dj + cols) % cols; if (ii < 0 || ii > rows) continue; const v = f0[ii * W + jj]; if (v < llo) llo = v; if (v > lhi) lhi = v; }
      const localIsos = lhi - llo > (hi - lo) * 0.15 ? levels.map((l) => llo + (lhi - llo) * l) : isos;
      let best = Infinity, bz = z0, bu = u0;
      for (const iso of localIsos) {
        const g0 = lv(z0, u0) - iso;
        // walk out both ways to the first sign change, then bisect
        for (const sgn of [1, -1]) {
          let prevT = 0, prevV = g0;
          for (let st = 1; st <= scan; st++) {
            const t = (sgn * reach * st) / scan, v = lv(z0 + dz * t, u0 + du * t) - iso;
            if (v * prevV <= 0) {
              let a = prevT, b = t, fa = prevV;
              for (let it = 0; it < iters; it++) { const m = (a + b) / 2, fm = lv(z0 + dz * m, u0 + du * m) - iso; if (fm * fa > 0) { a = m; fa = fm; } else b = m; }
              const tt = (a + b) / 2;
              if (Math.abs(tt) < best) { best = Math.abs(tt); bz = z0 + dz * tt; bu = u0 + du * tt; }
              break;
            }
            prevT = t; prevV = v;
          }
        }
      }
      if (best === Infinity) continue;
      if (!edgeRow) zs[k] = bz;
      ths[k] = bu / R0; moved[k] = 1;
      rv[k] = parts.rel(zs[k], ths[k]); f[k] = Math.abs(rv[k]);
    }
    // the seam column (2π) mirrors column 0
    for (let i = 0; i <= rows; i++) { const a = i * W, b = a + cols; zs[b] = zs[a]; ths[b] = ths[a] + TAU; f[b] = f[a]; rv[b] = rv[a]; }
  }
  const pos = new Float32Array(N * 3);
  for (let k = 0; k < N; k++) {
    const r = parts.radius(zs[k], ths[k], rv[k]);
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
    // split along the shorter diagonal in 3D (well-shaped triangles that follow traced edges); fall back to
    // the relief level when both are about equal
    const p = g.pos, dae = (p[a * 3] - p[e * 3]) ** 2 + (p[a * 3 + 1] - p[e * 3 + 1]) ** 2 + (p[a * 3 + 2] - p[e * 3 + 2]) ** 2;
    const dbc = (p[b * 3] - p[c * 3]) ** 2 + (p[b * 3 + 1] - p[c * 3 + 1]) ** 2 + (p[b * 3 + 2] - p[c * 3 + 2]) ** 2;
    const ae = Math.abs(dae - dbc) < 0.02 * (dae + dbc) ? quadDiagonal(f, a, b, c, e) : dae < dbc;
    if (ae) { tri(a, b, e); tri(a, e, c); } else { tri(a, b, c); tri(b, e, c); }
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
