// Frozen classic engine of Advanced mode (as on main at 08b924a). Advanced mode slices with this engine
// only, so Basic-engine changes never alter Advanced output and vice versa.
// Stage 7: surface & sparse infill pattern generators. Output: open/closed polylines in mm.
import { bounds, clipLines, offset, SCALE, toInt } from '../../clipper';
import type { Path, Paths, Polyline2 } from '../../types';

function rotatePaths(paths: Paths, ang: number): Paths {
  const c = Math.cos(ang), s = Math.sin(ang);
  return paths.map((p) => p.map((q) => ({ X: Math.round(q.X * c - q.Y * s), Y: Math.round(q.X * s + q.Y * c) })));
}

const toPoly = (p: Path, closed: boolean): Polyline2 => {
  const pts: number[] = [];
  for (const q of p) pts.push(q.X / SCALE, q.Y / SCALE);
  return { pts, closed };
};

/**
 * Parallel lines at `angleDeg` with centre spacing `spacing` (mm), clipped to region.
 * monotonic=true keeps every line in the same direction (no zig-zag), as for top skins.
 */
export function linesFill(region: Paths, spacing: number, angleDeg: number, monotonic = false, phase = 0): Polyline2[] {
  if (!region.length || spacing <= 0) return [];
  const ang = (angleDeg * Math.PI) / 180;
  const rot = rotatePaths(region, -ang);
  const b = bounds(rot);
  if (!isFinite(b.minX)) return [];
  const sp = toInt(spacing);
  const lines: Paths = [];
  const start = Math.floor(b.minY / sp) * sp + Math.round(phase * sp) + sp / 2;
  for (let y = start; y < b.maxY; y += sp) {
    lines.push([{ X: b.minX - 10, Y: Math.round(y) }, { X: b.maxX + 10, Y: Math.round(y) }]);
  }
  const clipped = clipLines(lines, rot);
  // normalise direction (+X), sort by scanline then x
  for (const p of clipped) if (p[0].X > p[p.length - 1].X) p.reverse();
  clipped.sort((a, b2) => (a[0].Y - b2[0].Y) || (a[0].X - b2[0].X));
  if (!monotonic) {
    let row = 0, lastY = NaN;
    for (const p of clipped) {
      if (p[0].Y !== lastY) { row++; lastY = p[0].Y; }
      if (row % 2 === 0) p.reverse();
    }
  }
  return rotatePaths(clipped, ang).map((p) => toPoly(p, false));
}

/** Concentric loops shrinking inward by `spacing`. */
export function concentricFill(region: Paths, spacing: number, firstInset: number): Polyline2[] {
  const out: Polyline2[] = [];
  let cur = offset(region, -firstInset);
  let guard = 0;
  while (cur.length && guard++ < 2000) {
    for (const p of cur) out.push(toPoly(p, true));
    cur = offset(cur, -spacing);
  }
  return out;
}

/**
 * Gyroid: iso-lines of sin(x)cos(y)+sin(y)cos(z)+sin(z)cos(x)=0 at this layer's z,
 * extracted with marching squares and clipped to the region.
 */
export function gyroidFill(region: Paths, spacing: number, z: number): Polyline2[] {
  if (!region.length) return [];
  const b = bounds(region);
  const minX = b.minX / SCALE, minY = b.minY / SCALE, maxX = b.maxX / SCALE, maxY = b.maxY / SCALE;
  const period = spacing * 2; // two walls per period ⇒ mean wall spacing ≈ spacing
  const k = (2 * Math.PI) / period;
  const step = period / 16;
  const nx = Math.ceil((maxX - minX) / step) + 2, ny = Math.ceil((maxY - minY) / step) + 2;
  const sz = Math.sin(z * k), cz = Math.cos(z * k);
  const f = (x: number, y: number) => {
    const X = x * k, Y = y * k;
    return Math.sin(X) * Math.cos(Y) + Math.sin(Y) * cz + sz * Math.cos(X);
  };
  const grid = new Float64Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) grid[j * nx + i] = f(minX + i * step, minY + j * step);

  // marching squares → segments keyed by edge id for chaining
  const pX = new Map<number, number>(), pY = new Map<number, number>();
  const hKey = (i: number, j: number) => (j * nx + i) * 2; // edge (i,j)-(i+1,j)
  const vKey = (i: number, j: number) => (j * nx + i) * 2 + 1; // edge (i,j)-(i,j+1)
  const edgePt = (key: number) => {
    if (pX.has(key)) return;
    const cell = key >> 1, i = cell % nx, j = Math.floor(cell / nx);
    const a = grid[j * nx + i];
    let x: number, y: number;
    if ((key & 1) === 0) { const c = grid[j * nx + i + 1]; const t = a / (a - c); x = minX + (i + t) * step; y = minY + j * step; }
    else { const c = grid[(j + 1) * nx + i]; const t = a / (a - c); x = minX + i * step; y = minY + (j + t) * step; }
    pX.set(key, x); pY.set(key, y);
  };
  const segs: number[] = [];
  for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    const v0 = grid[j * nx + i], v1 = grid[j * nx + i + 1], v2 = grid[(j + 1) * nx + i + 1], v3 = grid[(j + 1) * nx + i];
    const e: number[] = [];
    if ((v0 > 0) !== (v1 > 0)) e.push(hKey(i, j));
    if ((v1 > 0) !== (v2 > 0)) e.push(vKey(i + 1, j));
    if ((v3 > 0) !== (v2 > 0)) e.push(hKey(i, j + 1));
    if ((v0 > 0) !== (v3 > 0)) e.push(vKey(i, j));
    for (const k2 of e) edgePt(k2);
    if (e.length === 2) segs.push(e[0], e[1]);
    else if (e.length === 4) segs.push(e[0], e[1], e[2], e[3]);
  }
  // chain
  const adj = new Map<number, number[]>();
  for (let s = 0; s < segs.length / 2; s++) for (const k2 of [segs[s * 2], segs[s * 2 + 1]]) {
    const l = adj.get(k2); if (l) l.push(s); else adj.set(k2, [s]);
  }
  const used = new Uint8Array(segs.length / 2);
  const lines: Paths = [];
  const walk = (s0: number, from: number, to: number) => {
    const keys = [from, to];
    let cur = to;
    for (;;) {
      const c = adj.get(cur); let n = -1;
      if (c) for (const s of c) if (!used[s]) { n = s; break; }
      if (n < 0) break;
      used[n] = 1;
      cur = segs[n * 2] === cur ? segs[n * 2 + 1] : segs[n * 2];
      keys.push(cur);
    }
    return keys;
  };
  for (let s = 0; s < used.length; s++) {
    if (used[s]) continue;
    used[s] = 1;
    const fwd = walk(s, segs[s * 2], segs[s * 2 + 1]);
    const back = walk(s, fwd[1], fwd[0]).slice(2).reverse();
    const keys = [...back, ...fwd];
    lines.push(keys.map((k2) => ({ X: toInt(pX.get(k2)!), Y: toInt(pY.get(k2)!) })));
  }
  return clipLines(lines, region).map((p) => toPoly(p, false));
}

export type SparsePattern = 'rectilinear' | 'aligned_rectilinear' | 'grid' | 'triangles' | 'gyroid' | 'concentric';

export function sparseFill(region: Paths, pattern: SparsePattern, width: number, density: number, layer: number, z: number, baseAngle: number): Polyline2[] {
  if (density <= 0) return [];
  const s = width / Math.min(1, density);
  switch (pattern) {
    case 'grid': return [...linesFill(region, s * 2, baseAngle), ...linesFill(region, s * 2, baseAngle + 90)];
    case 'triangles': return [0, 60, 120].flatMap((a) => linesFill(region, s * 3, baseAngle + a));
    case 'gyroid': return gyroidFill(region, s, z);
    case 'concentric': return concentricFill(region, s, s / 2);
    case 'aligned_rectilinear': return linesFill(region, s, baseAngle);
    default: return linesFill(region, s, baseAngle + (layer % 2 ? 90 : 0));
  }
}
