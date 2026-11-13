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
    // Sharp reliefs: every vertex near an edge is moved exactly onto the nearest bevel line (top or foot of a
    // straight bevel, sd = ∓bevel/2), by Newton steps on the true signed distance (|∇sd| = 1, so one or two
    // steps land within microns). Edges come out as clean as the geometry they come from.
    const R0 = d.maxDiameter / 2, cell = Math.min(H / rows, (TAU * R0) / cols);
    const probe = [0.2, 0.5, 0.8].some((t) => parts.edges(H * t, 0.3));
    if (probe) {
      const hstep = 0.04;
      for (let i = 0; i <= rows; i++) {
        const fixedZ = i === 0 || i === rows;
        for (let j = 0; j < cols; j++) {
          const k = i * W + j; let z = zs[k], th = ths[k];
          const e0 = parts.edges(z, th); if (!e0) continue;
          const Rz = Math.max(1, R0);
          // nearest bevel line among all levels
          let best = Infinity, lv = -1, iso = 0;
          for (let l = 0; l < e0.sd.length; l++) for (const s of [-e0.bev / 2, e0.bev / 2]) { const c = Math.abs(e0.sd[l] - s); if (c < best) { best = c; lv = l; iso = s; } }
          if (lv < 0 || best > cell * 0.75) continue;
          for (let it = 0; it < 3; it++) {
            const e = parts.edges(z, th); if (!e) break;
            const c = e.sd[lv] - iso; if (Math.abs(c) < 1e-4) break;
            const ez1 = fixedZ ? null : parts.edges(z + hstep, th), ez0 = fixedZ ? null : parts.edges(z - hstep, th);
            const eu1 = parts.edges(z, th + hstep / Rz), eu0 = parts.edges(z, th - hstep / Rz);
            if (!eu1 || !eu0) break;
            const gz = ez1 && ez0 ? (ez1.sd[lv] - ez0.sd[lv]) / (2 * hstep) : 0, gu = (eu1.sd[lv] - eu0.sd[lv]) / (2 * hstep);
            const g2 = gz * gz + gu * gu; if (g2 < 1e-6) break;
            let sz = (c * gz) / g2, su = (c * gu) / g2; const m = Math.hypot(sz, su);
            if (m > cell) { sz *= cell / m; su *= cell / m; }
            z -= sz; th -= su / Rz;
          }
          if (!fixedZ) zs[k] = Math.min(H, Math.max(0, z));
          ths[k] = th; moved[k] = 1;
          rv[k] = parts.rel(zs[k], ths[k]); f[k] = Math.abs(rv[k]);
        }
      }
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
