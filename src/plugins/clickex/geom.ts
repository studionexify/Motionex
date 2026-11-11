// Clickex geometry kernel: 2D regions are Clipper paths (mm × SCALE), 3D parts are stacks of closed prisms.
// Every prism is its own closed shell (caps by earcut, vertical walls), so a part is a union of shells the
// slicer merges with non-zero fill (the same idea Lumonex uses). Shells are welded one by one, never across,
// so every shell stays watertight even where two shells touch face to face.
import { ShapeUtils, Vector2 } from 'three';
import ClipperLib from 'clipper-lib';
import { area, cleanPaths, difference, SCALE, toExPolygons, union } from '../../engine/clipper';
import { simplifyRing } from '../patternex/tools/shape';
import { openEdgeCount, repairTJunctions, weld, type IndexedMesh } from '../../engine/mesh';
import type { Path, Paths } from '../../engine/types';

export type XY = [number, number];
export type Ring = XY[];

export const toPath = (r: Ring): Path => r.map(([x, y]) => ({ X: Math.round(x * SCALE), Y: Math.round(y * SCALE) }));
export const toRing = (p: Path): Ring => p.map((q) => [q.X / SCALE, q.Y / SCALE]);
export const toPaths = (rs: Ring[]): Paths => rs.filter((r) => r.length >= 3).map(toPath);
export const toRings = (ps: Paths): Ring[] => ps.map(toRing);

const rad = (d: number) => (d * Math.PI) / 180;

/** Rectangle w × h centred on (cx, cy), turned by `angle` degrees. */
export function rectPath(cx: number, cy: number, w: number, h: number, angle = 0): Path {
  const c = Math.cos(rad(angle)), s = Math.sin(rad(angle));
  const pts: XY[] = [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]];
  return toPath(pts.map(([x, y]) => [cx + x * c - y * s, cy + x * s + y * c]));
}

export function circlePath(cx: number, cy: number, r: number, n = 64): Path {
  return toPath(Array.from({ length: n }, (_, i) => { const a = (i / n) * Math.PI * 2; return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as XY; }));
}

/** Plus-shaped socket: two bars `len` × `wid`, turned by `angle`. */
export function crossPaths(cx: number, cy: number, len: number, wid: number, angle = 0): Paths {
  return union([rectPath(cx, cy, len, wid, angle), rectPath(cx, cy, wid, len, angle)]);
}

const C: any = (ClipperLib as any).default ?? ClipperLib;

/** Offset by d mm (+ grows). Round joins; arcs are cut to 0.02 mm so outlines stay light. */
function offsetPaths(p: Paths, d: number, join: 'miter' | 'round'): Paths {
  if (!p.length || d === 0) return p;
  const co = new C.ClipperOffset(2, SCALE * 0.02);
  co.AddPaths(p, join === 'round' ? C.JoinType.jtRound : C.JoinType.jtMiter, C.EndType.etClosedPolygon);
  const out: Paths = [];
  co.Execute(out, Math.round(d * SCALE));
  return out;
}
export const grow = (p: Paths, d: number, join: 'miter' | 'round' = 'round'): Paths => offsetPaths(p, d, join);
export const shrink = (p: Paths, d: number, join: 'miter' | 'round' = 'round'): Paths => offsetPaths(p, -d, join);

/** Douglas–Peucker on every ring (tolerance mm): keeps the shape, drops the thousands of points a trace leaves. */
export function simplify(p: Paths, tol = 0.02): Paths {
  return p.map((path) => {
    const r = simplifyRing(toRing(path), tol);
    return toPath(r);
  }).filter((q) => q.length >= 3);
}

/** Round convex corners by r (opening), then concave ones (closing). */
export function smooth(p: Paths, r: number): Paths {
  if (r <= 0 || !p.length) return p;
  return shrink(grow(grow(shrink(p, r), r), r), r);
}

export const netArea = (p: Paths) => (p.length ? toExPolygons(p).reduce((s, e) => s + Math.abs(area(e.contour)) - e.holes.reduce((a, h) => a + Math.abs(area(h)), 0), 0) : 0);
export const isEmpty = (p: Paths, eps = 1e-3) => netArea(p) < eps;

export function translatePaths(ps: Paths, dx: number, dy: number): Paths {
  const ox = Math.round(dx * SCALE), oy = Math.round(dy * SCALE);
  return ps.map((p) => p.map((q) => ({ X: q.X + ox, Y: q.Y + oy })));
}

export function transformPaths(ps: Paths, scale: number, angle: number, dx: number, dy: number, flipX = false): Paths {
  const c = Math.cos(rad(angle)) * scale, s = Math.sin(rad(angle)) * scale;
  return ps.map((p) => {
    const out = p.map((q) => {
      const x = (flipX ? -q.X : q.X) / SCALE, y = q.Y / SCALE;
      return { X: Math.round((x * c - y * s + dx) * SCALE), Y: Math.round((x * s + y * c + dy) * SCALE) };
    });
    return flipX ? out.reverse() : out;
  });
}

export function boundsMm(ps: Paths): { min: XY; max: XY; w: number; h: number; cx: number; cy: number } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of ps) for (const q of p) { if (q.X < x0) x0 = q.X; if (q.X > x1) x1 = q.X; if (q.Y < y0) y0 = q.Y; if (q.Y > y1) y1 = q.Y; }
  if (x0 === Infinity) return { min: [0, 0], max: [0, 0], w: 0, h: 0, cx: 0, cy: 0 };
  return { min: [x0 / SCALE, y0 / SCALE], max: [x1 / SCALE, y1 / SCALE], w: (x1 - x0) / SCALE, h: (y1 - y0) / SCALE, cx: (x0 + x1) / 2 / SCALE, cy: (y0 + y1) / 2 / SCALE };
}

/** Split into connected pieces (each outer with its holes). */
export const components = (p: Paths): Paths[] => toExPolygons(p).map((e) => [e.contour, ...e.holes]);

/** Keep the largest connected piece. */
export function largest(p: Paths): Paths {
  const parts = components(p);
  if (parts.length <= 1) return p;
  return parts.reduce((b, c) => (netArea(c) > netArea(b) ? c : b));
}

/** Drop holes smaller than `maxArea` mm² (all holes when it is Infinity). */
export function fillHoles(p: Paths, maxArea = Infinity): Paths {
  return toExPolygons(p).flatMap((e) => [e.contour, ...e.holes.filter((h) => Math.abs(area(h)) > maxArea)]);
}

export function convexHull(ps: Paths): Paths {
  const pts: XY[] = ps.flatMap(toRing).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return [];
  const cross = (o: XY, a: XY, b: XY) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo: XY[] = [], up: XY[] = [];
  for (const p of pts) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  for (const p of [...pts].reverse()) { while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
  return [toPath([...lo.slice(0, -1), ...up.slice(0, -1)])];
}

// ---------------------------------------------------------------- pole of inaccessibility (polylabel)
function segDist2(px: number, py: number, a: XY, b: XY): number {
  let x = a[0], y = a[1], dx = b[0] - x, dy = b[1] - y;
  if (dx || dy) {
    const t = ((px - x) * dx + (py - y) * dy) / (dx * dx + dy * dy);
    if (t > 1) { x = b[0]; y = b[1]; } else if (t > 0) { x += dx * t; y += dy * t; }
  }
  dx = px - x; dy = py - y;
  return dx * dx + dy * dy;
}

/** Signed distance from a point to the region (+ inside), rings taken even-odd. */
export function pointDist(rings: Ring[], px: number, py: number): number {
  let inside = false, min = Infinity;
  for (const r of rings) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const a = r[i], b = r[j];
      if ((a[1] > py) !== (b[1] > py) && px < ((b[0] - a[0]) * (py - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
      min = Math.min(min, segDist2(px, py, a, b));
    }
  }
  return (inside ? 1 : -1) * Math.sqrt(min);
}

/** The point deepest inside a region (largest inscribed circle), by the polylabel quadtree search. */
export function pole(region: Paths, precision = 0.1): { x: number; y: number; d: number } {
  const rings = toRings(region);
  const b = boundsMm(region);
  if (!rings.length || !b.w) return { x: 0, y: 0, d: 0 };
  const cell = Math.min(b.w, b.h) || 1;
  let h = cell / 2;
  const cells: { x: number; y: number; h: number; d: number; max: number }[] = [];
  const mk = (x: number, y: number, hh: number) => { const d = pointDist(rings, x, y); return { x, y, h: hh, d, max: d + hh * Math.SQRT2 }; };
  for (let x = b.min[0]; x < b.max[0]; x += cell) for (let y = b.min[1]; y < b.max[1]; y += cell) cells.push(mk(x + h, y + h, h));
  let best = mk(b.cx, b.cy, 0);
  for (const c of cells) if (c.d > best.d) best = c;
  while (cells.length) {
    cells.sort((p, q) => q.max - p.max);
    const c = cells.shift()!;
    if (c.d > best.d) best = c;
    if (c.max - best.d <= precision) continue;
    h = c.h / 2;
    cells.push(mk(c.x - h, c.y - h, h), mk(c.x + h, c.y - h, h), mk(c.x - h, c.y + h, h), mk(c.x + h, c.y + h, h));
  }
  return { x: best.x, y: best.y, d: best.d };
}

/** Does a square (side × side, turned by angle) centred on (cx, cy) lie inside the region? */
export const squareFits = (region: Paths, cx: number, cy: number, side: number, angle = 0) => isEmpty(difference([rectPath(cx, cy, side, side, angle)], region));
export const clean = (p: Paths) => cleanPaths(p, 0.004);

// ---------------------------------------------------------------- prisms and shells
const signedArea = (r: Vector2[]) => { let s = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += (r[j].x - r[i].x) * (r[j].y + r[i].y); return s / 2; };

/** Drop repeated and exactly collinear points (integer test), so caps and walls share every vertex. */
function straighten(p: Path): Path {
  let pts = p.filter((q, i) => { const n = p[(i + 1) % p.length]; return q.X !== n.X || q.Y !== n.Y; });
  for (let again = true; again && pts.length >= 3;) {
    again = false;
    const keep: Path = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[(i + pts.length - 1) % pts.length], b = pts[i], c = pts[(i + 1) % pts.length];
      if ((b.X - a.X) * (c.Y - b.Y) - (b.Y - a.Y) * (c.X - b.X) === 0) { again = true; continue; }
      keep.push(b);
    }
    pts = keep;
  }
  return pts;
}

/** Closed triangle soup (x y z …) of `paths` extruded from z0 to z1; holes follow the nesting of the paths. */
export function prism(paths: Paths, z0: number, z1: number): number[] {
  const soup: number[] = [];
  if (z1 - z0 < 1e-6) return soup;
  for (const ex of toExPolygons(clean(paths))) {
    const toV = (p: Path) => p.map((q) => new Vector2(q.X / SCALE, q.Y / SCALE));
    let c = toV(straighten(ex.contour));
    let hs = ex.holes.map((h) => toV(straighten(h)));
    if (c.length < 3) continue;
    if (signedArea(c) < 0) c = c.reverse();
    hs = hs.filter((h) => h.length >= 3).map((h) => (signedArea(h) > 0 ? h.reverse() : h));
    const verts = [...c, ...hs.flat()];
    const faces = ShapeUtils.triangulateShape(c.map((v) => v.clone()), hs.map((h) => h.map((v) => v.clone())));
    for (const [ia, ib, ic] of faces) {
      let A = verts[ia], B = verts[ib], D = verts[ic];
      if ((B.x - A.x) * (D.y - A.y) - (B.y - A.y) * (D.x - A.x) < 0) [B, D] = [D, B];
      soup.push(A.x, A.y, z1, B.x, B.y, z1, D.x, D.y, z1, A.x, A.y, z0, D.x, D.y, z0, B.x, B.y, z0);
    }
    for (const ring of [c, ...hs]) {
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length];
        soup.push(a.x, a.y, z0, b.x, b.y, z0, b.x, b.y, z1, a.x, a.y, z0, b.x, b.y, z1, a.x, a.y, z1);
      }
    }
  }
  return soup;
}

/** One closed solid with the filament colour (palette index) it prints in. */
export interface Shell { soup: number[]; slot: number }

export interface PartMesh { mesh: IndexedMesh; /** Palette index per triangle. */ slots: Uint8Array }

export function meshOfShells(shells: Shell[]): PartMesh {
  const verts: number[] = [], idx: number[] = [], slots: number[] = [];
  for (const s of shells) {
    if (!s.soup.length) continue;
    // earcut can leave a vertex on another triangle's edge (collinear hole corners): split those open edges
    let m = weld(new Float32Array(s.soup));
    if (openEdgeCount(m)) m = repairTJunctions(m);
    const base = verts.length / 3;
    for (let i = 0; i < m.vertices.length; i++) verts.push(m.vertices[i]);
    for (let i = 0; i < m.indices.length; i++) idx.push(m.indices[i] + base);
    for (let t = 0; t < m.indices.length / 3; t++) slots.push(s.slot);
  }
  return { mesh: { vertices: new Float32Array(verts), indices: Uint32Array.from(idx) }, slots: Uint8Array.from(slots) };
}

/** Turn a part upside down (rotate 180° about X) and drop it on z = 0: the top face lands on the bed. */
export function flipOnBed(m: PartMesh): PartMesh {
  const v = new Float32Array(m.mesh.vertices);
  let min = Infinity;
  for (let i = 0; i < v.length; i += 3) { v[i + 1] = -v[i + 1]; v[i + 2] = -v[i + 2]; if (v[i + 2] < min) min = v[i + 2]; }
  for (let i = 2; i < v.length; i += 3) v[i] -= min;
  return { mesh: { vertices: v, indices: m.mesh.indices }, slots: m.slots };
}
