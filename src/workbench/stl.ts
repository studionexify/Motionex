// Binary STL of a Design: outer surface, inner surface (offset inward by the wall), rim, and floor.
import { makeInner, makeSurface, meshGrid, type Design } from './design';

export function stlFromDesign(d: Design): ArrayBuffer {
  const surf = makeSurface(d), inner = makeInner(d);
  const { rows, cols } = meshGrid(d, 900_000);
  const floor = d.openBottom ? 0 : Math.min(d.height * 0.3, d.wall * 0.6 + 1.2);
  const P = (i: number, j: number, isIn: boolean): [number, number, number] => {
    const z = (i / rows) * d.height, th = (j / cols) * Math.PI * 2;
    const r = isIn ? inner(z, th) : surf(z, th);
    return [r * Math.cos(th), r * Math.sin(th), isIn ? Math.max(z, floor) : z];
  };
  const tris: [number, number, number][][] = [];
  const quad = (a: number[], b: number[], c: number[], e: number[]) => { tris.push([a, b, c] as never, [a, c, e] as never); };
  for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) {
    quad(P(i, j, false), P(i, j + 1, false), P(i + 1, j + 1, false), P(i + 1, j, false));
    quad(P(i, j, true), P(i + 1, j, true), P(i + 1, j + 1, true), P(i, j + 1, true));
  }
  for (let j = 0; j < cols; j++) {
    // rim
    quad(P(rows, j, false), P(rows, j + 1, false), P(rows, j + 1, true), P(rows, j, true));
    if (d.openBottom) quad(P(0, j, false), P(0, j, true), P(0, j + 1, true), P(0, j + 1, false));
    else {
      const th0 = (j / cols) * Math.PI * 2, th1 = ((j + 1) / cols) * Math.PI * 2;
      const r0 = surf(0, th0), r1 = surf(0, th1);
      tris.push([[0, 0, 0], [r1 * Math.cos(th1), r1 * Math.sin(th1), 0], [r0 * Math.cos(th0), r0 * Math.sin(th0), 0]] as never);
      const a = P(0, j, true), b = P(0, j + 1, true);
      tris.push([[0, 0, floor], a, b] as never);
    }
  }
  const buf = new ArrayBuffer(84 + tris.length * 50), v = new DataView(buf);
  v.setUint32(80, tris.length, true);
  let o = 84;
  for (const t of tris) {
    const [a, b, c] = t as unknown as number[][];
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], wx = c[0] - a[0], wy = c[1] - a[1], wz = c[2] - a[2];
    let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx; const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    for (const f of [nx, ny, nz, ...a, ...b, ...c]) { v.setFloat32(o, f, true); o += 4; }
    o += 2;
  }
  return buf;
}
