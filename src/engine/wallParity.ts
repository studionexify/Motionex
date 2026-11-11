// OrcaSlicer / Snapmaker Orca wall and geometry options that have no home in the older stages:
// polyholes, "make overhang printable" (conical overhangs), reverse on even layers, wall resolution (Arachne
// meshfix), extra perimeters on overhangs, curled perimeter slowdown and the intra-layer object order.
import { area, difference, exToPaths, intersection, offset, opening, SCALE, toExPolygons, union } from './clipper';
import type { Path, Paths } from './types';

const P = (x: number, y: number) => ({ X: Math.round(x * SCALE), Y: Math.round(y * SCALE) });

export interface PolyholeOptions {
  /** Maximum deviation of a point from the circle radius: mm, or "N%" of the radius. */
  threshold: number | string | boolean | undefined;
  maxEdges: number;
  twisted: boolean;
  nozzle: number;
}

/** Threshold (mm) for a hole of mean radius r. */
function holeTolerance(t: PolyholeOptions['threshold'], r: number): number {
  let v = 0.01;
  if (typeof t === 'number') v = t;
  else if (typeof t === 'string') v = t.trim().endsWith('%') ? (parseFloat(t) / 100) * r : parseFloat(t) || 0.01;
  return Math.max(1 / SCALE, v);
}

/** OrcaSlicer create_polyholes: regular polygons (5 rotated copies when twisted) circumscribing radius r. */
export function polyholeShapes(cx: number, cy: number, r: number, nozzle: number, twisted: boolean, maxEdges: number): Path[] {
  const n = Math.min(Math.max(3, Math.round(maxEdges)), Math.max(3, Math.round((4 * r * 0.4) / Math.max(0.05, nozzle))));
  const copies = twisted ? 5 : 1;
  const rot = twisted ? (2 * Math.PI) / (n * copies) : 0;
  const R = r / Math.cos(Math.PI / n);
  const list: Path[] = new Array(copies);
  for (let k = 0; k < copies; k++) {
    const pts: Path = [];
    for (let e = 0; e < n; e++) { const a = rot * k + (2 * Math.PI * e) / n; pts.push(P(cx + R * Math.cos(a), cy + R * Math.sin(a))); }
    pts.reverse(); // holes run clockwise
    // OrcaSlicer orders the rotations 0, 2, 4, 1, 3 so neighbouring layers differ by two steps
    list[k % 2 === 0 ? k / 2 : Math.floor((copies + 1) / 2) + Math.floor(k / 2)] = pts;
  }
  return list;
}

interface HoleRec { layer: number; cx: number; cy: number; r: number; tol: number; path: Path }

/**
 * Convert holes to polyholes (OrcaSlicer PrintObject::_transform_hole_to_polyholes): convex, almost circular holes
 * that span at least two layers (or sit on the first layer) are replaced by a regular polygon with an edge count
 * that depends on the diameter and the nozzle, rotated every layer when twisted.
 */
export function applyPolyholes(sl: Paths[], from: number, opt: PolyholeOptions): void {
  const found: HoleRec[][] = sl.map(() => []);
  const exs = sl.map((p, i) => (i >= from && p.length ? toExPolygons(p) : []));
  for (let i = from; i < sl.length; i++) {
    for (const ex of exs[i]) for (const h of ex.holes) {
      if (h.length <= 8) continue;
      const pts = h.map((q) => [q.X / SCALE, q.Y / SCALE] as [number, number]);
      // convex hole
      let sign = 0, convex = true;
      for (let k = 0; k < pts.length && convex; k++) {
        const a = pts[k], b = pts[(k + 1) % pts.length], c = pts[(k + 2) % pts.length];
        const cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
        if (Math.abs(cr) < 1e-12) continue;
        if (!sign) sign = Math.sign(cr); else if (Math.sign(cr) !== sign) convex = false;
      }
      if (!convex) continue;
      // area centroid
      let A = 0, cx = 0, cy = 0;
      for (let k = 0; k < pts.length; k++) {
        const a = pts[k], b = pts[(k + 1) % pts.length], c = a[0] * b[1] - b[0] * a[1];
        A += c; cx += (a[0] + b[0]) * c; cy += (a[1] + b[1]) * c;
      }
      if (Math.abs(A) < 1e-12) continue;
      cx /= 3 * A; cy /= 3 * A;
      let dmin = Infinity, dmax = 0, sum = 0, lmin = Infinity, lmax = 0;
      for (let k = 0; k < pts.length; k++) {
        const d = Math.hypot(pts[k][0] - cx, pts[k][1] - cy);
        dmin = Math.min(dmin, d); dmax = Math.max(dmax, d); sum += d;
        const b = pts[(k + 1) % pts.length];
        const m = Math.hypot((pts[k][0] + b[0]) / 2 - cx, (pts[k][1] + b[1]) / 2 - cy);
        lmin = Math.min(lmin, m); lmax = Math.max(lmax, m);
      }
      const tol = holeTolerance(opt.threshold, sum / pts.length);
      if (dmax - dmin < tol * 2 && lmax - lmin < tol * 2) found[i].push({ layer: i, cx, cy, r: dmax, tol, path: h });
    }
  }
  // chains of the same hole over consecutive layers
  const replace = new Map<number, Map<Path, Path>>();
  for (let i = from; i < sl.length; i++) {
    for (const h of found[i].splice(0)) {
      const chain = [h];
      for (let j = i + 1; j < sl.length; j++) {
        const k = found[j].findIndex((q) => Math.hypot(q.cx - h.cx, q.cy - h.cy) < h.tol && Math.abs(q.r - h.r) < h.tol);
        if (k < 0) break;
        chain.push(found[j].splice(k, 1)[0]);
      }
      if (chain.length < 2 && !(chain.length === 1 && h.layer === from)) continue;
      const shapes = polyholeShapes(h.cx, h.cy, h.r, opt.nozzle, opt.twisted, opt.maxEdges);
      for (const c of chain) {
        let m = replace.get(c.layer);
        if (!m) replace.set(c.layer, (m = new Map()));
        m.set(c.path, shapes[c.layer % shapes.length]);
      }
    }
  }
  for (const [i, m] of replace) {
    const out: Paths = [];
    for (const ex of exs[i]) {
      out.push(ex.contour);
      for (const h of ex.holes) out.push(m.get(h) ?? h);
    }
    sl[i] = union(out);
  }
}

/**
 * Make overhang printable (OrcaSlicer PrintObject::apply_conical_overhang): from the top down, every layer takes in
 * the layer above shrunk by tan(angle) · layer height, so no overhang is steeper than the angle. Holes smaller than
 * `maxHoleArea` (mm²) that the layer above covers completely are kept open instead of being filled by the cone.
 */
export function applyConicalOverhang(sl: Paths[], from: number, hs: number[], angleDeg: number, maxHoleArea: number): void {
  if (angleDeg >= 90) return;
  const t = Math.tan((angleDeg * Math.PI) / 180);
  for (let i = sl.length - 2; i >= from; i--) {
    let upper = sl[i + 1];
    if (!upper.length) continue;
    const cur = sl[i];
    if (maxHoleArea > 0) {
      for (const ex of toExPolygons(cur)) for (const h of ex.holes) {
        if (Math.abs(area(h)) >= maxHoleArea) continue;
        const hp = [h.slice().reverse()];
        const hit = intersection(upper, hp);
        if (hit.length && !difference(hp, hit).length) upper = difference(upper, hp);
      }
    }
    const grown = offset(upper, -t * hs[i + 1]);
    if (!grown.length) continue;
    // islands already inside the current layer add nothing
    const add = toExPolygons(grown).map(exToPaths).filter((p) => difference(p, cur).length);
    if (add.length) sl[i] = union(cur, add.flat());
  }
}

/** A closed loop run the other way round, keeping its start point (the seam). */
export function reverseKeepStart(pts: number[]): number[] {
  const out = [pts[0], pts[1]];
  for (let k = pts.length - 2; k >= 2; k -= 2) out.push(pts[k], pts[k + 1]);
  return out;
}

/** True if a point of the loop lies more than `d` mm beyond the edge of the layer below. */
export function overhangsBy(pts: number[], lowerGrown: (x: number, y: number) => boolean): boolean {
  for (let k = 0; k < pts.length; k += 2) if (!lowerGrown(pts[k], pts[k + 1])) return true;
  return false;
}

/** Fraction (0..1) of a closed loop's length whose segment midpoints lie outside the supported area. */
export function unsupportedFraction(pts: number[], inside: (x: number, y: number) => boolean): number {
  const n = pts.length / 2;
  let tot = 0, out = 0;
  for (let k = 0; k < n; k++) {
    const ax = pts[k * 2], ay = pts[k * 2 + 1], bx = pts[((k + 1) % n) * 2], by = pts[((k + 1) % n) * 2 + 1];
    const L = Math.hypot(bx - ax, by - ay);
    tot += L;
    // sampled every half millimetre: long straight segments cross supported and unsupported parts
    const steps = Math.max(1, Math.ceil(L / 0.5));
    for (let j = 0; j < steps; j++) {
      const t = (j + 0.5) / steps;
      if (!inside(ax + (bx - ax) * t, ay + (by - ay) * t)) out += L / steps;
    }
  }
  return tot > 0 ? out / tot : 0;
}

/**
 * Maximum wall resolution / deviation (Arachne meshfix, Cura semantics): a vertex is dropped when one of its
 * segments is shorter than `maxRes` and removing it moves the path by less than `maxDev`.
 */
export function simplifyWall(pts: number[], closed: boolean, maxRes: number, maxDev: number, widths?: number[]): { pts: number[]; widths?: number[] } {
  if (maxRes <= 0 || maxDev <= 0) return { pts, widths };
  let xs = pts.slice(), ws = widths ? widths.slice() : undefined;
  const minN = closed ? 3 : 2;
  let changed = true;
  while (changed) {
    changed = false;
    const n = xs.length / 2;
    if (n <= minN) break;
    const keep: number[] = [], kw: number[] = [];
    let lastX = NaN, lastY = NaN, skipped = false;
    for (let k = 0; k < n; k++) {
      const x = xs[k * 2], y = xs[k * 2 + 1];
      const end = !closed && (k === 0 || k === n - 1);
      if (!end && !skipped && keep.length / 2 + (n - k) > minN) {
        const pk = k === 0 ? n - 1 : k - 1, nk = (k + 1) % n;
        const ax = isNaN(lastX) ? xs[pk * 2] : lastX, ay = isNaN(lastY) ? xs[pk * 2 + 1] : lastY;
        const bx = xs[nk * 2], by = xs[nk * 2 + 1];
        const short = Math.min(Math.hypot(x - ax, y - ay), Math.hypot(bx - x, by - y)) < maxRes;
        const L = Math.hypot(bx - ax, by - ay);
        const dev = L > 1e-9 ? Math.abs((x - ax) * (by - ay) - (y - ay) * (bx - ax)) / L : Math.hypot(x - ax, y - ay);
        if (short && dev < maxDev) { skipped = true; changed = true; continue; }
      }
      skipped = false;
      keep.push(x, y); if (ws) kw.push(ws[k]);
      lastX = x; lastY = y;
    }
    xs = keep; if (ws) ws = kw;
  }
  return { pts: xs, widths: ws };
}

/**
 * Extra perimeters on overhangs (OrcaSlicer generate_extra_perimeters_over_overhangs): the part of the area left
 * for infill that hangs beyond the layer below (by more than half a line) is filled with concentric loops instead
 * of infill, so the overhang is printed as walls anchored to each other. Returns the loops and the new infill area.
 */
export function overhangPerimeters(inner: Paths, lower: Paths, w: number, spacing: number): { loops: Path[]; inner: Paths } {
  if (!inner.length) return { loops: [], inner };
  const ov = opening(difference(inner, offset(lower, w / 2)), w * 0.3);
  if (!ov.length) return { loops: [], inner };
  // anchor: the loops reach one line back over the supported part
  const region = intersection(inner, offset(ov, spacing));
  const loops: Path[] = [];
  let ring = offset(region, -w / 2);
  for (let k = 0; ring.length && k < 200; k++) {
    for (const q of ring) if (q.length >= 3) loops.push(q);
    ring = offset(ring, -spacing);
  }
  return { loops, inner: difference(inner, region) };
}

/** Spatial hash of points for "is something within r" queries (curled perimeter detection). */
export class PointGrid {
  private cells = new Map<string, number[]>();
  constructor(private r: number) {}
  get size() { return this.cells.size; }
  add(x: number, y: number) {
    const k = `${Math.floor(x / this.r)},${Math.floor(y / this.r)}`;
    const c = this.cells.get(k);
    if (c) c.push(x, y); else this.cells.set(k, [x, y]);
  }
  near(x: number, y: number): boolean {
    const cx = Math.floor(x / this.r), cy = Math.floor(y / this.r), r2 = this.r * this.r;
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
      const c = this.cells.get(`${cx + a},${cy + b}`);
      if (c) for (let k = 0; k < c.length; k += 2) if ((c[k] - x) ** 2 + (c[k + 1] - y) ** 2 <= r2) return true;
    }
    return false;
  }
}

/** Intra-layer object order "Default" (OrcaSlicer print_order): nearest neighbour chaining from (x, y). */
export function nearestObjectOrder(objs: number[], centre: (o: number) => [number, number] | null, x: number, y: number): number[] {
  const left = objs.slice(), out: number[] = [];
  let cx = x, cy = y;
  while (left.length) {
    let bi = 0, bd = Infinity;
    left.forEach((o, k) => { const c = centre(o); const d = c ? (c[0] - cx) ** 2 + (c[1] - cy) ** 2 : Infinity; if (d < bd) { bd = d; bi = k; } });
    const o = left.splice(bi, 1)[0];
    out.push(o);
    const c = centre(o);
    if (c) { cx = c[0]; cy = c[1]; }
  }
  return out;
}
