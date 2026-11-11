// Turn per-triangle paint into per-layer geometry (support/seam enforcers & blockers, colour regions).
import { areaTotal, clipLinesOutside, difference, intersection, offset, SCALE, union } from './clipper';
import type { Path, Paths } from './types';
import type { IndexedMesh } from './mesh';
import ClipperLib from 'clipper-lib';

const C: any = (ClipperLib as any).default ?? ClipperLib;

export interface PaintedTri { t: number; zmin: number; zmax: number; value: number }

export function paintedTris(mesh: IndexedMesh, flags: Uint8Array | undefined): PaintedTri[] {
  if (!flags) return [];
  const v = mesh.vertices, ix = mesh.indices;
  const out: PaintedTri[] = [];
  for (let t = 0; t < flags.length && t * 3 < ix.length; t++) {
    if (!flags[t]) continue;
    const za = v[ix[t * 3] * 3 + 2], zb = v[ix[t * 3 + 1] * 3 + 2], zc = v[ix[t * 3 + 2] * 3 + 2];
    out.push({ t, zmin: Math.min(za, zb, zc), zmax: Math.max(za, zb, zc), value: flags[t] });
  }
  return out;
}

/** XY projection of a triangle as a positive Clipper path (empty if degenerate). */
export function triFootprint(mesh: IndexedMesh, t: number): Path {
  const v = mesh.vertices, ix = mesh.indices;
  const p: Path = [];
  for (let k = 0; k < 3; k++) {
    const i = ix[t * 3 + k] * 3;
    p.push({ X: Math.round(v[i] * SCALE), Y: Math.round(v[i + 1] * SCALE) });
  }
  if (!C.Clipper.Orientation(p)) p.reverse();
  return Math.abs(C.Clipper.Area(p)) < 1 ? [] : p;
}

/** Plane intersection segment of triangle t at height z (null if it does not cross). */
export function triSegment(mesh: IndexedMesh, t: number, z: number): [number, number, number, number] | null {
  const v = mesh.vertices, ix = mesh.indices;
  const pts: number[] = [];
  for (let e = 0; e < 3; e++) {
    const a = ix[t * 3 + e] * 3, b = ix[t * 3 + ((e + 1) % 3)] * 3;
    const za = v[a + 2], zb = v[b + 2];
    if ((za >= z) === (zb >= z)) continue;
    const s = (z - za) / (zb - za);
    pts.push(v[a] + s * (v[b] - v[a]), v[a + 1] + s * (v[b + 1] - v[a + 1]));
  }
  return pts.length === 4 ? [pts[0], pts[1], pts[2], pts[3]] : null;
}

/** Footprints of painted triangles (with the given value) whose z-range overlaps [z0, z1]. */
export function footprintsInBand(mesh: IndexedMesh, tris: PaintedTri[], value: number, z0: number, z1: number, grow = 0): Paths {
  const out: Paths = [];
  for (const p of tris) {
    if (p.value !== value || p.zmax < z0 || p.zmin > z1) continue;
    const f = triFootprint(mesh, p.t);
    if (f.length) out.push(f);
  }
  if (!out.length) return [];
  return grow ? offset(union(out), grow) : union(out);
}

/** Midpoints of painted triangles crossing plane z (seam hints). */
export function pointsAtZ(mesh: IndexedMesh, tris: PaintedTri[], value: number, z: number): [number, number][] {
  const out: [number, number][] = [];
  for (const p of tris) {
    if (p.value !== value || p.zmin > z || p.zmax < z) continue;
    const s = triSegment(mesh, p.t, z);
    if (s) out.push([(s[0] + s[2]) / 2, (s[1] + s[3]) / 2]);
  }
  return out;
}

/**
 * Colour regions of one object layer. Painted side walls are extruded inward by `depth`
 * from the slice outline; painted near-horizontal faces within ±depth of the layer project down/up.
 * Returns region paths keyed by 1-based colour value; the caller assigns the remainder to the base filament.
 */
/** Strip of half-width `d` (mm) around open polylines. */
function lineStrip(lines: Paths, d: number): Paths {
  if (!lines.length) return [];
  const co = new C.ClipperOffset(2, SCALE * 0.0025);
  co.AddPaths(lines, C.JoinType.jtRound, C.EndType.etOpenRound);
  const out: Paths = [];
  co.Execute(out, Math.round(d * SCALE));
  return out;
}

/**
 * Colour regions of a layer from painted triangles.
 * `depth` > 0: each painted colour reaches this far in from the painted surface (Orca / Bambu
 * "Maximum width of a segmented region"); the rest keeps the object's filament.
 * `depth` 0 (Orca default): no limit, every point takes the colour of the nearest surface, painted or not
 * (a wavefront grown from each colour's surface inside the cross-section); painted top / bottom faces colour the
 * layers within `flatReach` mm of them (the top / bottom shell).
 */
/**
 * `penetration` (top / bottom paint penetration): how far below a painted top face and above a painted bottom face
 * the flat paint reaches (mm); without it a flat face reaches `flatReach` both ways.
 */
export function colorRegionsAtZ(mesh: IndexedMesh, tris: PaintedTri[], slice: Paths, z: number, depth: number, flatReach = 0.5, penetration?: { top: number; bottom: number }): Map<number, Paths> {
  const byColor = new Map<number, { lines: Paths; flats: Paths }>();
  const get = (c: number) => { let e = byColor.get(c); if (!e) byColor.set(c, (e = { lines: [], flats: [] })); return e; };
  const v = mesh.vertices, ix = mesh.indices;
  for (const p of tris) {
    const reach = depth > 0 ? depth : penetration ? Math.max(penetration.top, penetration.bottom, 0.05) : flatReach;
    if (p.zmax < z - reach || p.zmin > z + reach) continue;
    const s = p.zmin <= z && p.zmax >= z ? triSegment(mesh, p.t, z) : null;
    if (s) get(p.value).lines.push([{ X: Math.round(s[0] * SCALE), Y: Math.round(s[1] * SCALE) }, { X: Math.round(s[2] * SCALE), Y: Math.round(s[3] * SCALE) }]);
    // near-horizontal faces close to this layer paint the whole footprint
    const a = ix[p.t * 3] * 3, b = ix[p.t * 3 + 1] * 3, c = ix[p.t * 3 + 2] * 3;
    const ux = v[b] - v[a], uy = v[b + 1] - v[a + 1], uz = v[b + 2] - v[a + 2];
    const wx = v[c] - v[a], wy = v[c + 1] - v[a + 1], wz = v[c + 2] - v[a + 2];
    const nz = ux * wy - uy * wx, len = Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, nz);
    // a top face colours the layers below it, a bottom face those above it, each as deep as its penetration
    const within = !penetration || (nz > 0 ? p.zmin >= z - 1e-6 && p.zmin <= z + penetration.top + 1e-6 : p.zmax <= z + 1e-6 && p.zmax >= z - penetration.bottom - 1e-6);
    if (len > 0 && Math.abs(nz / len) > 0.7 && within) {
      const f = triFootprint(mesh, p.t);
      if (f.length) get(p.value).flats.push(f);
    }
  }
  if (depth <= 0) return floodRegions(byColor, slice);
  const out = new Map<number, Paths>();
  for (const [color, e] of byColor) {
    let region: Paths = [];
    if (e.lines.length) {
      const co = new C.ClipperOffset(2, SCALE * 0.0025);
      co.AddPaths(e.lines, C.JoinType.jtRound, C.EndType.etOpenRound);
      const strip: Paths = [];
      co.Execute(strip, Math.round(depth * SCALE));
      region = region.concat(strip);
    }
    if (e.flats.length) region = region.concat(offset(union(e.flats), 0.05));
    const r = intersection(union(region), slice);
    if (r.length) out.set(color, r);
  }
  return out;
}

/** Cells of a grid whose centre lies inside `paths` (even-odd scanline fill). */
function rasterize(paths: Paths, x0: number, y0: number, cell: number, nx: number, ny: number, mark: (i: number) => void) {
  const xs: number[] = [];
  for (let r = 0; r < ny; r++) {
    const y = y0 + (r + 0.5) * cell;
    xs.length = 0;
    for (const p of paths) for (let k = 0; k < p.length; k++) {
      const a = p[k], b = p[(k + 1) % p.length];
      const ay = a.Y / SCALE, by = b.Y / SCALE;
      if ((ay <= y) !== (by <= y)) xs.push(a.X / SCALE + ((y - ay) / (by - ay)) * (b.X - a.X) / SCALE);
    }
    xs.sort((m, n) => m - n);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const c0 = Math.max(0, Math.ceil((xs[k] - x0) / cell - 0.5)), c1 = Math.min(nx - 1, Math.floor((xs[k + 1] - x0) / cell - 0.5));
      for (let c = c0; c <= c1; c++) mark(r * nx + c);
    }
  }
}

/** No width limit: each colour owns the points nearer to its surface than to any other (unpainted surface = the
 *  object's filament, key -1). The band along the surface is exact (strips around the painted lines); the inside is
 *  shared out by a nearest-colour flood on a fine grid, then clipped to the true outline. */
function floodRegions(byColor: Map<number, { lines: Paths; flats: Paths }>, slice: Paths): Map<number, Paths> {
  const out = new Map<number, Paths>();
  if (!slice.length || !byColor.size) return out;
  let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
  for (const p of slice) for (const q of p) { xmin = Math.min(xmin, q.X); xmax = Math.max(xmax, q.X); ymin = Math.min(ymin, q.Y); ymax = Math.max(ymax, q.Y); }
  const span = Math.max(xmax - xmin, ymax - ymin) / SCALE;
  const keys = [...byColor.keys()].sort((a, b) => a - b);
  const outline: Paths = slice.map((p) => [...p, p[0]]);
  const painted = union(keys.flatMap((k) => lineStrip(byColor.get(k)!.lines, 0.3)));
  const lines = new Map<number, Paths>(keys.map((k) => [k, byColor.get(k)!.lines]));
  lines.set(-1, clipLinesOutside(outline, painted));
  // 1. the surface band, exact: what shows on the outside of the print
  const band = Math.min(1, Math.max(0.4, span / 20));
  const parts = new Map<number, Paths>();
  let taken: Paths = [];
  const claim = (key: number, reg: Paths) => {
    let r = intersection(reg, slice);
    if (taken.length && r.length) r = difference(r, taken);
    if (!r.length) return;
    parts.set(key, parts.has(key) ? union(parts.get(key)!, r) : r);
    taken = union(taken, r);
  };
  for (const k of keys) if (byColor.get(k)!.flats.length) claim(k, offset(union(byColor.get(k)!.flats), 0.05));
  for (const k of [...keys, -1]) claim(k, lineStrip(lines.get(k)!, band));
  const inner = taken.length ? difference(slice, taken) : slice;
  if (inner.length && areaTotal(inner) > 1e-4) {
    // 2. the inside: multi-source flood on a grid from the band's colours
    const cell = Math.max(0.2, span / 160);
    const x0 = xmin / SCALE - cell, y0 = ymin / SCALE - cell;
    const nx = Math.ceil(span / cell) + 3, ny = Math.ceil(span / cell) + 3;
    const label = new Int16Array(nx * ny).fill(-2); // -2 outside, -3 inside unassigned, else key (+1 offset: -1 → 0)
    rasterize(inner, x0, y0, cell, nx, ny, (i) => { label[i] = -3; });
    const queue: number[] = [];
    for (const [k, reg] of parts) rasterize(reg, x0, y0, cell, nx, ny, (i) => { if (label[i] !== -3) { label[i] = k + 1; queue.push(i); } });
    for (let q = 0; q < queue.length; q++) {
      const i = queue[q], cx = i % nx, cy = (i / nx) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ex = cx + dx, ey = cy + dy;
        if (ex < 0 || ey < 0 || ex >= nx || ey >= ny) continue;
        const j = ey * nx + ex;
        if (label[j] === -3) { label[j] = label[i]; queue.push(j); }
      }
    }
    // cells back to rectangles (row runs), per colour, clipped to the inside
    for (const k of keys) {
      const rects: Paths = [];
      for (let r = 0; r < ny; r++) {
        let c = 0;
        while (c < nx) {
          if (label[r * nx + c] !== k + 1) { c++; continue; }
          let e = c;
          while (e + 1 < nx && label[r * nx + e + 1] === k + 1) e++;
          const ax = x0 + c * cell, bx = x0 + (e + 1) * cell, ay = y0 + r * cell, by = y0 + (r + 1) * cell;
          rects.push([{ X: Math.round(ax * SCALE), Y: Math.round(ay * SCALE) }, { X: Math.round(bx * SCALE), Y: Math.round(ay * SCALE) }, { X: Math.round(bx * SCALE), Y: Math.round(by * SCALE) }, { X: Math.round(ax * SCALE), Y: Math.round(by * SCALE) }]);
          c = e + 1;
        }
      }
      if (!rects.length) continue;
      const r = intersection(union(rects), inner);
      if (r.length) parts.set(k, parts.has(k) ? union(parts.get(k)!, r) : r);
    }
  }
  for (const k of keys) { const r = parts.get(k); if (r?.length) out.set(k, r); }
  return out;
}
