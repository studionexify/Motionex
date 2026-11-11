// Stage A: map between plate space (mm, world) and pattern space for a placement, and test whether
// a pattern point is filled. Planar projects along an axis; cylindrical wraps around one.
import type { Pattern, PatternShape, Placement, Ring } from './model';

export type V3 = [number, number, number];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const norm = (a: V3): V3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/** A placement in plate coordinates (the UI converts from object-local before slicing). */
export interface WorldPlacement extends Placement {
  /** Index of the MeshInput the placement belongs to. */
  object: number;
  /** Cylindrical: a point on the wrap axis (defaults to the anchor shifted onto the object's centre line). */
  axis_origin?: V3;
}

export interface Frame {
  kind: 'planar' | 'cylindrical';
  /** Projection direction (planar) or wrap axis (cylindrical), unit. */
  axis: V3;
  /** Planar: in-plane right/up. Cylindrical: u = reference radial direction, v = axis. */
  u: V3; v: V3;
  origin: V3;
  /** Cylindrical radius at the anchor (arc length = angle × radius). */
  radius: number;
  /** Height of the anchor along the axis (cylindrical). */
  h0: number;
  cos: number; sin: number;
  sx: number; sy: number;
  /** Pattern centre: placements are centred on the pattern's bounding box. */
  cx: number; cy: number;
}

/** In-plane basis for a projection direction: v points "up" (towards +Z) on walls, +Y on flat faces. */
export function planeBasis(n: V3): { u: V3; v: V3 } {
  const a = norm(n);
  const ref: V3 = Math.abs(a[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0];
  const u = norm(cross(ref, a));
  return { u, v: cross(a, u) };
}

export function frameOf(p: WorldPlacement, pattern: Pattern): Frame {
  const rot = (p.rotation * Math.PI) / 180;
  const [cx, cy] = pattern.origin ?? [(pattern.bounds[0] + pattern.bounds[2]) / 2, (pattern.bounds[1] + pattern.bounds[3]) / 2];
  const sx = (p.scale_xy[0] || 1) * (p.flip ? -1 : 1), sy = p.scale_xy[1] || 1;
  const axis = norm(p.projection_axis);
  if (p.projection === 'cylindrical') {
    const o = p.axis_origin ?? p.position_xyz;
    const d = sub(p.position_xyz, o);
    const h0 = dot(d, axis);
    const radial: V3 = [d[0] - axis[0] * h0, d[1] - axis[1] * h0, d[2] - axis[2] * h0];
    const radius = Math.hypot(...radial);
    const u = radius > 1e-6 ? norm(radial) : planeBasis(axis).u;
    return { kind: 'cylindrical', axis, u, v: axis, origin: o, radius: Math.max(radius, 1e-3), h0, cos: Math.cos(rot), sin: Math.sin(rot), sx, sy, cx, cy };
  }
  const { u, v } = planeBasis(axis);
  return { kind: 'planar', axis, u, v, origin: p.position_xyz, radius: 0, h0: 0, cos: Math.cos(rot), sin: Math.sin(rot), sx, sy, cx, cy };
}

/** Surface coordinates (mm, before rotation/scale) of a plate point. */
function surfaceUV(f: Frame, x: number, y: number, z: number): [number, number] {
  const d: V3 = [x - f.origin[0], y - f.origin[1], z - f.origin[2]];
  if (f.kind === 'planar') return [dot(d, f.u), dot(d, f.v)];
  const h = dot(d, f.axis);
  const w = cross(f.axis, f.u);
  const ang = Math.atan2(dot(d, w), dot(d, f.u));
  return [ang * f.radius, h - f.h0];
}

/** Plate point → pattern coordinates. */
export function toPattern(f: Frame, x: number, y: number, z: number): [number, number] {
  const [a, b] = surfaceUV(f, x, y, z);
  // undo rotation, then scale
  const ra = f.cos * a + f.sin * b, rb = -f.sin * a + f.cos * b;
  return [f.cx + ra / f.sx, f.cy + rb / f.sy];
}

/** Pattern point → plate point on the projection plane (planar) or cylinder (cylindrical). */
export function fromPattern(f: Frame, px: number, py: number): V3 {
  const a0 = (px - f.cx) * f.sx, b0 = (py - f.cy) * f.sy;
  const a = f.cos * a0 - f.sin * b0, b = f.sin * a0 + f.cos * b0;
  if (f.kind === 'planar') return [f.origin[0] + f.u[0] * a + f.v[0] * b, f.origin[1] + f.u[1] * a + f.v[1] * b, f.origin[2] + f.u[2] * a + f.v[2] * b];
  const ang = a / f.radius, w = cross(f.axis, f.u), h = b + f.h0;
  const c = Math.cos(ang) * f.radius, s = Math.sin(ang) * f.radius;
  return [f.origin[0] + f.u[0] * c + w[0] * s + f.axis[0] * h, f.origin[1] + f.u[1] * c + w[1] * s + f.axis[1] * h, f.origin[2] + f.u[2] * c + w[2] * s + f.axis[2] * h];
}

/** Does the surface at (x,y,z) with outward normal n face the projection? */
/** Minimum cosine between surface normal and projection for a placement (surface-angle filter). */
export const minCosOf = (p: { max_angle?: number }) => (p.max_angle === undefined ? 0.2 : Math.cos((Math.max(0, Math.min(89.9, p.max_angle)) * Math.PI) / 180));

export function faces(f: Frame, x: number, y: number, z: number, n: V3, minCos = 0.2): boolean {
  if (f.kind === 'planar') return dot(n, f.axis) > minCos;
  const d: V3 = [x - f.origin[0], y - f.origin[1], z - f.origin[2]];
  const h = dot(d, f.axis);
  const r = norm([d[0] - f.axis[0] * h, d[1] - f.axis[1] * h, d[2] - f.axis[2] * h]);
  return dot(n, r) > minCos;
}

// ---------- point-in-pattern
interface IndexedShape { rings: Ring[]; evenodd: boolean; bb: [number, number, number, number] }

function winding(rings: Ring[], x: number, y: number): number {
  let w = 0;
  for (const r of rings) {
    for (let i = 0, n = r.length, j = n - 1; i < n; j = i++) {
      const [x0, y0] = r[j], [x1, y1] = r[i];
      if (y0 <= y) { if (y1 > y && (x1 - x0) * (y - y0) - (x - x0) * (y1 - y0) > 0) w++; }
      else if (y1 <= y && (x1 - x0) * (y - y0) - (x - x0) * (y1 - y0) < 0) w--;
    }
  }
  return w;
}
function crossings(rings: Ring[], x: number, y: number): number {
  let c = 0;
  for (const r of rings) for (let i = 0, n = r.length, j = n - 1; i < n; j = i++) {
    const [x0, y0] = r[j], [x1, y1] = r[i];
    if ((y0 > y) !== (y1 > y) && x < ((x1 - x0) * (y - y0)) / (y1 - y0) + x0) c++;
  }
  return c;
}

/** Grid-bucketed fill test over a set of shapes (one colour group). */
export class ShapeIndex {
  private shapes: IndexedShape[];
  private grid = new Map<number, number[]>();
  private x0 = 0; private y0 = 0; private cs = 1; private g = 1;
  readonly bounds: [number, number, number, number];
  constructor(shapes: PatternShape[]) {
    this.shapes = shapes.map((s) => {
      let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
      for (const r of s.polygon_rings) for (const [x, y] of r) { a = Math.min(a, x); b = Math.min(b, y); c = Math.max(c, x); d = Math.max(d, y); }
      return { rings: s.polygon_rings, evenodd: s.fill_rule === 'evenodd', bb: [a, b, c, d] as [number, number, number, number] };
    }).filter((s) => isFinite(s.bb[0]));
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
    for (const s of this.shapes) { a = Math.min(a, s.bb[0]); b = Math.min(b, s.bb[1]); c = Math.max(c, s.bb[2]); d = Math.max(d, s.bb[3]); }
    this.bounds = isFinite(a) ? [a, b, c, d] : [0, 0, 0, 0];
    if (!this.shapes.length) return;
    this.g = Math.max(1, Math.min(128, Math.ceil(Math.sqrt(this.shapes.length) * 2)));
    this.x0 = a; this.y0 = b; this.cs = Math.max((c - a), (d - b)) / this.g || 1;
    this.shapes.forEach((s, k) => {
      for (let i = this.cell(s.bb[0], this.x0); i <= this.cell(s.bb[2], this.x0); i++)
        for (let j = this.cell(s.bb[1], this.y0); j <= this.cell(s.bb[3], this.y0); j++) {
          const key = i * 1024 + j, l = this.grid.get(key); if (l) l.push(k); else this.grid.set(key, [k]);
        }
    });
  }
  private cell(v: number, lo: number) { return Math.max(0, Math.min(this.g - 1, Math.floor((v - lo) / this.cs))); }
  contains(x: number, y: number): boolean {
    const [a, b, c, d] = this.bounds;
    if (x < a || x > c || y < b || y > d) return false;
    const l = this.grid.get(this.cell(x, this.x0) * 1024 + this.cell(y, this.y0));
    if (!l) return false;
    for (const k of l) {
      const s = this.shapes[k];
      if (x < s.bb[0] || x > s.bb[2] || y < s.bb[1] || y > s.bb[3]) continue;
      if (s.evenodd ? crossings(s.rings, x, y) % 2 === 1 : winding(s.rings, x, y) !== 0) return true;
    }
    return false;
  }
  /** All rings (for building footprint polygons with Clipper). */
  shapeList(): { rings: Ring[]; evenodd: boolean }[] { return this.shapes; }
}
