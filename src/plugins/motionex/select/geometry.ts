// Where a rule's selection is on one layer, and how strongly a point is selected (1 inside, fading to 0 over
// the rule's blend distance outside). The Select window and the slicer use the same code, so the highlight in
// the window is what the slicer does.
import type { FeatureType } from '../../../engine/types';
import type { SelectRule } from './model';

export type Poly = [number, number][];

/** One piece of a selection on a layer. polys null = the whole layer (of `obj`, or every object). */
export interface Piece {
  polys: Poly[] | null;
  /** Bounding box of polys, grown by the blend distance (quick reject). */
  box?: [number, number, number, number];
  /** Vertical factor: 1 on the selected layers, less on the layers it fades over. */
  zf: number;
  obj?: string;
  /** Only these features (a picked line keeps to its own kind of line). */
  features?: Set<FeatureType>;
}

/** Moves applied to an object's selections (it was moved since): object id → [dx, dy]. */
export type Shifts = Record<string, [number, number]>;

const shiftOf = (r: SelectRule, obj: string | undefined, now: Record<string, [number, number]> | undefined): [number, number] => {
  if (!obj || !now) return [0, 0];
  const a = r.anchors[obj], b = now[obj];
  return a && b ? [b[0] - a[0], b[1] - a[1]] : [0, 0];
};

const box = (polys: Poly[], grow: number): [number, number, number, number] => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of polys) for (const [x, y] of p) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
  return [x0 - grow, y0 - grow, x1 + grow, y1 + grow];
};

/** A strip of half-width hw along a polyline, as one quad per segment (overlaps are fine for point tests). */
export function stripPolys(pts: [number, number][], hw: number, dx = 0, dy = 0): Poly[] {
  const out: Poly[] = [];
  for (let k = 1; k < pts.length; k++) {
    const [ax, ay] = pts[k - 1], [bx, by] = pts[k];
    const L = Math.hypot(bx - ax, by - ay);
    if (L < 1e-6) continue;
    // extend each quad by hw along the line so corners between segments are covered
    const ux = (bx - ax) / L, uy = (by - ay) / L, nx = -uy * hw, ny = ux * hw, ex = ux * hw, ey = uy * hw;
    out.push([[ax - ex + nx + dx, ay - ey + ny + dy], [bx + ex + nx + dx, by + ey + ny + dy], [bx + ex - nx + dx, by + ey - ny + dy], [ax - ex - nx + dx, ay - ey - ny + dy]]);
  }
  return out;
}

export function circlePoly(x: number, y: number, r: number, n = 20): Poly {
  const out: Poly = [];
  for (let k = 0; k < n; k++) { const a = (k / n) * Math.PI * 2; out.push([x + r * Math.cos(a), y + r * Math.sin(a)]); }
  return out;
}

/**
 * The pieces of a rule on the layer whose top is z (height h). With blend > 0 nearby layers get pieces too,
 * with zf < 1, so changes fade in and out vertically. `exact` leaves those out (filament regions).
 */
export function piecesAt(r: SelectRule, z: number, h: number, now?: Record<string, [number, number]>, exact = false): Piece[] {
  const blend = exact ? 0 : Math.max(0, r.blend_mm);
  const tol = h / 2 + 1e-4;
  const zfOf = (dz: number) => (dz <= tol ? 1 : blend > 0 ? Math.max(0, 1 - (dz - tol) / blend) : 0);
  const p = r.pick;
  const out: Piece[] = [];
  if (p.kind === 'layers') {
    const lo = Math.min(p.z0, p.z1), hi = Math.max(p.z0, p.z1);
    const dz = z < lo - 1e-4 ? lo - z : z > hi + 1e-4 ? z - hi : 0;
    const zf = dz === 0 ? 1 : zfOf(dz + tol);
    if (zf > 0) out.push({ polys: null, zf, obj: p.obj });
    return out;
  }
  // picked lines and dabs with a set spread: whole layers above and below, fading or not
  const sp = r.spread;
  const spreadF = (pz: number) => {
    const k = Math.round((z - pz) / Math.max(1e-3, h));
    if (k === 0) return Math.abs(z - pz) <= tol ? 1 : 0;
    const n = k > 0 ? sp!.above : sp!.below, a = Math.abs(k);
    if (a > n) return 0;
    return exact || sp!.fade === 'sudden' ? 1 : 1 - a / (n + 1);
  };
  if (p.kind === 'lines') {
    for (const l of p.lines) {
      const zf = sp ? spreadF(l.z) : zfOf(Math.abs(l.z - z));
      if (zf <= 0) continue;
      const [dx, dy] = shiftOf(r, l.obj, now);
      // on its own layer the strip covers that line only; above and below, a full line width
      const own = Math.abs(l.z - z) <= tol;
      const polys = stripPolys(l.pts, own && !exact ? l.w * 0.45 : l.w * 0.5, dx, dy);
      if (!polys.length) continue;
      // with a spread, the layers above and below change the same kind of line as the picked one
      out.push({ polys, box: box(polys, blend), zf, obj: l.obj, features: own || sp ? new Set([l.feature]) : undefined });
    }
    return out;
  }
  for (const d of p.dabs) {
    if (sp && (sp.above || sp.below)) {
      // the dab's own circle (as at its centre height) carried up and down the spread
      const zf = spreadF(d.z);
      if (zf <= 0 && Math.abs(d.z - z) >= d.r) continue;
      const [dx, dy] = shiftOf(r, d.obj, now);
      const polys = [circlePoly(d.x + dx, d.y + dy, d.r)];
      out.push({ polys, box: box(polys, blend), zf: Math.max(zf, Math.abs(d.z - z) < d.r ? 1 : 0), obj: d.obj });
      continue;
    }
    const dz = Math.abs(d.z - z);
    if (dz >= d.r + blend) continue;
    const [dx, dy] = shiftOf(r, d.obj, now);
    if (dz < d.r) {
      const polys = [circlePoly(d.x + dx, d.y + dy, Math.sqrt(d.r * d.r - dz * dz))];
      out.push({ polys, box: box(polys, blend), zf: 1, obj: d.obj });
    } else if (!exact) {
      // just past the ball: a small disc that fades with the distance
      const polys = [circlePoly(d.x + dx, d.y + dy, Math.max(0.3, d.r * 0.3))];
      out.push({ polys, box: box(polys, blend), zf: Math.max(0, 1 - (dz - d.r) / Math.max(1e-6, blend)), obj: d.obj });
    }
  }
  return out;
}

export function pointInPoly(x: number, y: number, poly: Poly): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function edgeDist(x: number, y: number, poly: Poly): number {
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, ay] = poly[j], [bx, by] = poly[i];
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2));
    const d = Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
    if (d < best) best = d;
  }
  return best;
}

/**
 * Selection strength 0..1 of a point of a move. `inObj(obj)` says whether the point lies on that object (used
 * for whole-layer pieces limited to one object); omit it to accept every point.
 */
export function weightAt(pieces: Piece[], blend: number, x: number, y: number, feature: FeatureType, inObj?: (obj: string) => boolean): number {
  let best = 0;
  for (const pc of pieces) {
    if (pc.zf <= best) continue;
    if (pc.features && !pc.features.has(feature)) continue;
    if (!pc.polys) {
      if (pc.obj && inObj && !inObj(pc.obj)) continue;
      best = pc.zf;
      continue;
    }
    const b = pc.box!;
    if (x < b[0] || y < b[1] || x > b[2] || y > b[3]) continue;
    let xy = 0;
    for (const poly of pc.polys) {
      if (pointInPoly(x, y, poly)) { xy = 1; break; }
      if (blend > 0) { const d = edgeDist(x, y, poly); if (d < blend) xy = Math.max(xy, 1 - d / blend); }
    }
    // smooth step: no visible kink where the fade starts or ends
    const s = xy * xy * (3 - 2 * xy);
    best = Math.max(best, s * pc.zf);
  }
  return best;
}
