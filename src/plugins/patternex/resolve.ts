// Stage B: resolve placements into per-layer region masks (Clipper paths, plate mm × SCALE).
// - Side walls facing the projection: the outline is sampled, pieces whose surface point falls inside the
//   pattern become open polylines, and those are grown inward by the region depth.
// - Flat faces facing the projection (planar, mostly vertical axis): the pattern footprint, limited to
//   material within `depth` of the exposed top/bottom surface.
// - Through regions: the whole cross-section under the pattern footprint.
import ClipperLib from 'clipper-lib';
import { difference, intersection, SCALE, union } from '../../engine/clipper';
import type { Path, Paths } from '../../engine/types';
import type { Pattern } from './model';
import { faces, fromPattern, frameOf, minCosOf, ShapeIndex, toPattern, type Frame, type V3, type WorldPlacement } from './projection';

const C: any = (ClipperLib as any).default ?? ClipperLib;

export interface GroupResolver {
  /** "placementId:#rrggbb" */
  regionId: string;
  placementId: string;
  color: string;
  object: number;
  /** Layer index range that can hold this region (inclusive). */
  layerRange: [number, number];
  /** Region paths at a layer (already clipped to the slice). */
  at(layer: number): Paths;
  /**
   * Relief: the object's cross-section with the artwork raised (grown outward by h) or recessed (cut in by h).
   * `slice` is the unmodified cross-section. Returns null when the artwork does not touch this layer.
   */
  relief(layer: number, slice: Paths, mode: 'raise' | 'recess', h: number): Paths | null;
  /** Whether the artwork lies on a flat (top/bottom) face. */
  flat: boolean;
}

export interface ResolveContext {
  layerZ: number[];
  /** Layer heights (mm). */
  layerH: number[];
  /** Slice plane height for each layer (usually mid-layer). */
  planes: number[];
  sliceAt(object: number, layer: number): Paths;
}

const SAMPLE = 0.2; // mm between wall samples

/** Wall pieces of a slice whose surface point lies in the pattern, as open polylines (int coords). */
function wallPieces(slice: Paths, z: number, f: Frame, idx: ShapeIndex, minCos = 0.2): Paths {
  const out: Paths = [];
  for (const path of slice) {
    const n = path.length;
    if (n < 3) continue;
    let cur: Path | null = null;
    const flush = () => { if (cur && cur.length >= 2) out.push(cur); cur = null; };
    for (let k = 0; k < n; k++) {
      const a = path[k], b = path[(k + 1) % n];
      const ax = a.X / SCALE, ay = a.Y / SCALE, bx = b.X / SCALE, by = b.Y / SCALE;
      const len = Math.hypot(bx - ax, by - ay);
      if (len < 1e-6) continue;
      // Clipper keeps material on the left, so the outward normal is to the right of travel.
      const nrm: V3 = [(by - ay) / len, -(bx - ax) / len, 0];
      const steps = Math.max(1, Math.ceil(len / SAMPLE));
      for (let s = 0; s < steps; s++) {
        const t0 = s / steps, t1 = (s + 1) / steps, tm = (t0 + t1) / 2;
        const mx = ax + (bx - ax) * tm, my = ay + (by - ay) * tm;
        const hit = faces(f, mx, my, z, nrm, minCos) && (() => { const [px, py] = toPattern(f, mx, my, z); return idx.contains(px, py); })();
        if (hit) {
          const p0 = { X: Math.round((ax + (bx - ax) * t0) * SCALE), Y: Math.round((ay + (by - ay) * t0) * SCALE) };
          const p1 = { X: Math.round((ax + (bx - ax) * t1) * SCALE), Y: Math.round((ay + (by - ay) * t1) * SCALE) };
          if (!cur) cur = [p0];
          cur.push(p1);
        } else flush();
      }
    }
    flush();
  }
  return out;
}

/** Grow open polylines into a strip of `depth` on each side (caller clips to the slice). */
function strip(lines: Paths, depth: number): Paths {
  if (!lines.length) return [];
  const co = new C.ClipperOffset(2, SCALE * 0.0025);
  co.AddPaths(lines, C.JoinType.jtSquare, C.EndType.etOpenButt);
  const res: Paths = [];
  co.Execute(res, Math.round(depth * SCALE));
  return res;
}

/** Pattern footprint projected along the planar axis onto the horizontal plane at z (int coords). */
function footprint(f: Frame, idx: ShapeIndex, z: number): Paths {
  const az = f.axis[2];
  const out: Paths = [];
  for (const s of idx.shapeList()) {
    const rings: Paths = s.rings.map((r) => r.map(([px, py]) => {
      const q = fromPattern(f, px, py);
      const t = Math.abs(az) > 1e-6 ? (z - q[2]) / az : 0;
      return { X: Math.round((q[0] + t * f.axis[0]) * SCALE), Y: Math.round((q[1] + t * f.axis[1]) * SCALE) };
    }));
    out.push(...union(rings, [], s.evenodd ? C.PolyFillType.pftEvenOdd : C.PolyFillType.pftNonZero));
  }
  return union(out);
}

/** Through regions with a near-horizontal axis: strips along the axis under the pattern's cross-section at z. */
function throughStrips(f: Frame, idx: ShapeIndex, z: number, reach: number): Paths {
  // pattern-space line for this height: sample along the in-plane horizontal direction
  const hd: V3 = [f.u[0], f.u[1], 0];
  const hl = Math.hypot(hd[0], hd[1]) || 1;
  const ux = hd[0] / hl, uy = hd[1] / hl;
  const [b0, , b2] = idx.bounds;
  const span = Math.max(Math.abs(b2 - b0) * Math.max(Math.abs(f.sx), Math.abs(f.sy)), 1) * 1.5 + 2;
  const out: Paths = [];
  let start: number | null = null;
  const ox = f.origin[0], oy = f.origin[1];
  const step = SAMPLE / 2;
  const ax = f.axis[0], ay = f.axis[1];
  const al = Math.hypot(ax, ay) || 1;
  const dx = ax / al, dy = ay / al;
  const push = (l0: number, l1: number) => {
    const p = (l: number, s: number) => ({ X: Math.round((ox + ux * l + dx * s) * SCALE), Y: Math.round((oy + uy * l + dy * s) * SCALE) });
    out.push([p(l0, -reach), p(l1, -reach), p(l1, reach), p(l0, reach)]);
  };
  for (let l = -span; l <= span + 1e-9; l += step) {
    const [px, py] = toPattern(f, ox + ux * l, oy + uy * l, z);
    const inside = idx.contains(px, py);
    if (inside && start === null) start = l;
    if (!inside && start !== null) { push(start, l); start = null; }
  }
  if (start !== null) push(start, span);
  return union(out);
}

/** Layer index range [first,last] whose z lies in [z0,z1]. */
function layersIn(layerZ: number[], layerH: number[], z0: number, z1: number): [number, number] {
  let a = -1, b = -1;
  for (let i = 0; i < layerZ.length; i++) {
    const lo = layerZ[i] - layerH[i];
    if (layerZ[i] >= z0 - 1e-6 && lo <= z1 + 1e-6) { if (a < 0) a = i; b = i; }
  }
  return a < 0 ? [1, 0] : [a, b];
}

export function placementGroups(p: WorldPlacement, pattern: Pattern, depth: number, ctx: ResolveContext): GroupResolver[] {
  const f = frameOf(p, pattern);
  const groups = new Map<string, Pattern['shapes']>();
  for (const s of pattern.shapes) { const l = groups.get(s.fill_color); if (l) l.push(s); else groups.set(s.fill_color, [s]); }
  const N = ctx.layerZ.length;
  // z extent of the placed pattern
  let zLo = Infinity, zHi = -Infinity;
  const [b0, b1, b2, b3] = pattern.bounds;
  for (let i = 0; i <= 8; i++) for (let j = 0; j <= 8; j++) {
    const q = fromPattern(f, b0 + ((b2 - b0) * i) / 8, b1 + ((b3 - b1) * j) / 8);
    zLo = Math.min(zLo, q[2]); zHi = Math.max(zHi, q[2]);
  }
  const vertical = f.kind === 'planar' && Math.abs(f.axis[2]) > 0.7;
  const horizontalAxis = f.kind === 'planar' && Math.abs(f.axis[2]) < 0.3;
  let range: [number, number];
  if (p.through && vertical) range = [0, N - 1];
  else if (vertical) {
    // flat face at the anchor: material within `depth` below (top) or above (bottom) it
    const az = p.position_xyz[2];
    range = f.axis[2] > 0 ? layersIn(ctx.layerZ, ctx.layerH, az - depth, az + 1e-3) : layersIn(ctx.layerZ, ctx.layerH, az - 1e-3, az + depth);
  } else range = layersIn(ctx.layerZ, ctx.layerH, zLo - depth, zHi + depth);

  const minCos = minCosOf(p);
  return [...groups].map(([color, shapes]) => {
    const idx = new ShapeIndex(shapes);
    const cache = new Map<number, Paths>();
    const regionId = `${p.id}:${color}`;
    const at = (li: number): Paths => {
      if (li < range[0] || li > range[1] || !p.visible) return [];
      const hit = cache.get(li);
      if (hit) return hit;
      const sl = ctx.sliceAt(p.object, li);
      let r: Paths = [];
      if (sl.length) {
        const z = ctx.planes[li];
        if (vertical) {
          const fp = footprint(f, idx, z);
          if (p.through) r = intersection(fp, sl);
          else {
            // keep material within depth of the exposed surface on the projection side
            const zs = z + (f.axis[2] > 0 ? depth : -depth);
            let j = li;
            if (f.axis[2] > 0) { while (j < N - 1 && ctx.layerZ[j] < zs - 1e-6) j++; }
            else { while (j > 0 && ctx.layerZ[j] - ctx.layerH[j] > zs + 1e-6) j--; }
            const beyond = (f.axis[2] > 0 ? ctx.layerZ[N - 1] < zs - 1e-6 : zs < 0) || j === li ? [] : ctx.sliceAt(p.object, j);
            r = difference(intersection(fp, sl), beyond);
          }
        } else if (p.through && horizontalAxis) {
          r = intersection(throughStrips(f, idx, z, 2000), sl);
        } else if (p.through && f.kind === 'planar') {
          r = intersection(footprint(f, idx, z), sl);
        } else {
          r = intersection(union(strip(wallPieces(sl, z, f, idx, minCos), depth)), sl);
        }
      }
      cache.set(li, r);
      return r;
    };
    const relief = (li: number, sl: Paths, mode: 'raise' | 'recess', h: number): Paths | null => {
      if (!sl.length || !p.visible || h <= 0) return null;
      const z = ctx.planes[li];
      if (vertical) {
        // flat faces: recess cuts the footprint out of the top (or bottom) h mm; raising needs layers above the
        // model, which the layer plan does not have, so it is reported instead
        if (mode !== 'recess') return null;
        const az = p.position_xyz[2];
        const inBand = f.axis[2] > 0 ? z > az - h - 1e-6 && z <= az + 1e-3 : z >= az - 1e-3 && z < az + h + 1e-6;
        if (!inBand) return null;
        const cut = intersection(footprint(f, idx, z), sl);
        return cut.length ? difference(sl, cut) : null;
      }
      if (li < range[0] || li > range[1]) return null;
      const lines = wallPieces(sl, z, f, idx, minCos);
      if (!lines.length) return null;
      const band = union(strip(lines, h));
      return mode === 'raise' ? union(sl, band) : difference(sl, band);
    };
    return { regionId, placementId: p.id, color, object: p.object, layerRange: range, at, relief, flat: vertical };
  });
}
