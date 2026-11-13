// Binary STL of a Design: outer face, inner face, rim, and floor (or open bottom).
// Both faces use the feature-following grid (surfacegrid.ts): relief outlines are traced exactly, so the
// exported model has clean geometric edges instead of a pixel staircase.
import { meshGrid, type Design } from './design';
import { quadDiagonal, surfaceGrid } from './surfacegrid';

export function stlFromDesign(d: Design): ArrayBuffer {
  const { rows, cols } = meshGrid(d, 450_000);
  const W = cols + 1;
  const go = surfaceGrid(d, rows, cols, 'outer'), gi = surfaceGrid(d, rows, cols, 'inner');
  const floor = d.openBottom ? 0 : Math.min(d.height * 0.3, d.wall * 0.6 + 1.2);
  if (!d.openBottom) for (let k = 0; k < gi.pos.length; k += 3) gi.pos[k + 2] = Math.max(gi.pos[k + 2], floor);
  const P = (g: Float32Array, k: number): [number, number, number] => [g[k * 3], g[k * 3 + 1], g[k * 3 + 2]];
  const n = rows * cols * 4 + cols * 4, buf = new ArrayBuffer(84 + n * 50), v = new DataView(buf);
  v.setUint32(80, n, true);
  let o = 84;
  // write each triangle straight into the STL buffer (no giant intermediate arrays)
  const tri = (a: number[], b: number[], c: number[]) => {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], wx = c[0] - a[0], wy = c[1] - a[1], wz = c[2] - a[2];
    let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx; const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    v.setFloat32(o, nx, true); v.setFloat32(o + 4, ny, true); v.setFloat32(o + 8, nz, true); o += 12;
    for (const p of [a, b, c]) { v.setFloat32(o, p[0], true); v.setFloat32(o + 4, p[1], true); v.setFloat32(o + 8, p[2], true); o += 12; }
    o += 2;
  };
  for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) {
    const a = i * W + j, b = a + 1, c = a + W, e = c + 1;
    const oa = P(go.pos, a), ob = P(go.pos, b), oc = P(go.pos, c), oe = P(go.pos, e);
    if (quadDiagonal(go.f, a, b, c, e)) { tri(oa, ob, oe); tri(oa, oe, oc); } else { tri(oa, ob, oc); tri(ob, oe, oc); }
    const ia = P(gi.pos, a), ib = P(gi.pos, b), ic = P(gi.pos, c), ie = P(gi.pos, e);
    if (quadDiagonal(gi.f, a, b, c, e)) { tri(ia, ie, ib); tri(ia, ic, ie); } else { tri(ia, ic, ib); tri(ib, ic, ie); }
  }
  for (let j = 0; j < cols; j++) {
    const t0 = rows * W + j, t1 = t0 + 1;
    tri(P(go.pos, t0), P(go.pos, t1), P(gi.pos, t1)); tri(P(go.pos, t0), P(gi.pos, t1), P(gi.pos, t0));        // rim
    if (d.openBottom) { tri(P(go.pos, j), P(gi.pos, j + 1), P(go.pos, j + 1)); tri(P(go.pos, j), P(gi.pos, j), P(gi.pos, j + 1)); }
    else {
      tri([0, 0, 0], P(go.pos, j + 1), P(go.pos, j));                                                        // underside
      tri([0, 0, floor], P(gi.pos, j), P(gi.pos, j + 1));                                                    // floor inside
    }
  }
  return buf;
}
