// Keeps every line of a layer from printing over a moved wall, the way a slicer keeps its extrusions apart.
//
// A slicer never lays two lines on the same spot: walls are spaced one line apart (less the small
// rounding of the bead's edges), and infill stops at the innermost wall, reaching into it only by the
// "infill/wall overlap". When Motionex moves a wall after slicing, the lines around it were placed for
// the old wall, so they can end up under the new one. This pass restores the slicer's spacing.
//
// Each printed line is a stroke: every point within half its width of its centre line. Two lines of
// widths wa and wb clash when their centre lines come closer than (wa + wb) / 2 − allowed overlap.
// For a wall that clearance is measured as a capsule round each segment of the moved wall, and every
// other line in the layer is cut exactly where it enters a capsule. The cut is worked out per segment
// as an interval of the segment (a line meets a capsule, which is convex, in one interval), so the cut
// points are exact and the order and direction of the line are kept.
//
// Priority, highest first: the motion walls themselves, then walls that follow them (bonded inner
// walls), then everything else (infill, skins, gap fill, support...). A line is only ever cut by lines
// of higher priority; the motion walls are left exactly as designed.
import type { Layer, Toolpath, ToolpathPoint } from "./types";

export interface ClearanceOptions {
  /** Layer height (mm); a bead's rounded edges let neighbours overlap by h·(1 − π/4), as slicers space walls. */
  layerHeight: number;
  /** Infill/wall overlap as a share of the infill line width (0.15 = 15 %). */
  infillOverlap: number;
  /** Printed pieces shorter than this share of their own line width are dropped (too short to print). */
  minPieceShare?: number;
  /** Gaps longer than this (mm) retract while crossing; 0 = never. */
  retractOver?: number;
  retractLength?: number;
}

/** Line width (mm) of a path. */
export type WidthOf = (path: Toolpath, index: number) => number;

/** Overlap (mm) too small to matter; keeps rounding in the slicer's own spacing from cutting lines. */
const TOLERANCE = 0.02;

interface Capsule { ax: number; ay: number; bx: number; by: number; w: number }

/** Lines that stop at the walls and may reach into them by the infill/wall overlap. */
const isFill = (f: string) => /infill|surface|gap_fill|bridge|ironing/.test(f);

/**
 * Priority of a path: 0 motion wall, 1 wall following it, 2 anything else, 3 left alone. A plain outer
 * wall is the visible surface, so it is never cut (when a motion runs on the inner walls only, the
 * outer skin stays whole).
 */
export function tierOf(p: Toolpath): 0 | 1 | 2 | 3 {
  if (p.follows) return 1;
  if (p.modifiedBy === "motionex") return 0;
  if (p.feature === "outer_wall" || p.feature === "overhang_wall") return 3;
  return 2;
}

/** Parameter interval (t in [0, 1]) where segment p0→p1 lies strictly inside the capsule round c with radius r. */
export function segmentInCapsule(p0x: number, p0y: number, p1x: number, p1y: number, c: Capsule, r: number): [number, number] | null {
  const vx = p1x - p0x, vy = p1y - p0y;
  let lo = Infinity, hi = -Infinity;
  const disk = (cx: number, cy: number) => {
    // |p0 + t v − c|² = r²
    const fx = p0x - cx, fy = p0y - cy;
    const A = vx * vx + vy * vy, B = 2 * (fx * vx + fy * vy), C = fx * fx + fy * fy - r * r;
    if (A < 1e-18) { if (C < 0) { lo = Math.min(lo, 0); hi = Math.max(hi, 1); } return; }
    const D = B * B - 4 * A * C;
    if (D <= 0) return;
    const s = Math.sqrt(D);
    lo = Math.min(lo, (-B - s) / (2 * A)); hi = Math.max(hi, (-B + s) / (2 * A));
  };
  disk(c.ax, c.ay);
  disk(c.bx, c.by);
  // the rectangle between the two end disks: 0 ≤ along ≤ |ab| and |across| ≤ r
  const ex = c.bx - c.ax, ey = c.by - c.ay, el = Math.hypot(ex, ey);
  if (el > 1e-12) {
    const ux = ex / el, uy = ey / el;
    const along0 = (p0x - c.ax) * ux + (p0y - c.ay) * uy, dAlong = vx * ux + vy * uy;
    const across0 = (p0x - c.ax) * -uy + (p0y - c.ay) * ux, dAcross = vx * -uy + vy * ux;
    let t0 = -Infinity, t1 = Infinity;
    const slab = (v0: number, dv: number, min: number, max: number) => {
      if (Math.abs(dv) < 1e-15) { if (v0 <= min || v0 >= max) { t0 = Infinity; t1 = -Infinity; } return; }
      let a = (min - v0) / dv, b = (max - v0) / dv;
      if (a > b) [a, b] = [b, a];
      t0 = Math.max(t0, a); t1 = Math.min(t1, b);
    };
    slab(along0, dAlong, 0, el);
    slab(across0, dAcross, -r, r);
    if (t1 > t0) { lo = Math.min(lo, t0); hi = Math.max(hi, t1); }
  }
  // the capsule is convex, so the three pieces together meet the line in one interval
  lo = Math.max(lo, 0); hi = Math.min(hi, 1);
  return hi > lo ? [lo, hi] : null;
}

/** Spatial grid of capsules for quick lookup along a line. */
class CapsuleGrid {
  private cells = new Map<number, number[]>();
  private stamp: Uint32Array;
  private tick = 0;
  constructor(readonly caps: Capsule[], readonly cell: number, reach: number) {
    this.stamp = new Uint32Array(caps.length);
    const pad = reach;
    caps.forEach((c, i) => {
      const x0 = Math.floor((Math.min(c.ax, c.bx) - pad) / cell), x1 = Math.floor((Math.max(c.ax, c.bx) + pad) / cell);
      const y0 = Math.floor((Math.min(c.ay, c.by) - pad) / cell), y1 = Math.floor((Math.max(c.ay, c.by) + pad) / cell);
      for (let gx = x0; gx <= x1; gx++) for (let gy = y0; gy <= y1; gy++) {
        const k = key(gx, gy), l = this.cells.get(k);
        if (l) l.push(i); else this.cells.set(k, [i]);
      }
    });
  }
  /** Capsules whose padded box touches a cell the segment passes through. */
  near(ax: number, ay: number, bx: number, by: number): number[] {
    if (++this.tick === 0xffffffff) { this.stamp.fill(0); this.tick = 1; }
    const out: number[] = [];
    const len = Math.hypot(bx - ax, by - ay);
    const n = Math.max(1, Math.ceil(len / (this.cell * 0.5)));
    let lastKey = NaN;
    for (let k = 0; k <= n; k++) {
      const x = ax + ((bx - ax) * k) / n, y = ay + ((by - ay) * k) / n;
      const gx = Math.floor(x / this.cell), gy = Math.floor(y / this.cell);
      const ck = key(gx, gy);
      if (ck === lastKey) continue;
      lastKey = ck;
      // neighbours too: the sample step is half a cell, so a segment may clip a corner between samples
      for (let ix = gx - 1; ix <= gx + 1; ix++) for (let iy = gy - 1; iy <= gy + 1; iy++) {
        for (const i of this.cells.get(key(ix, iy)) ?? []) if (this.stamp[i] !== this.tick) { this.stamp[i] = this.tick; out.push(i); }
      }
    }
    return out;
  }
}
const key = (gx: number, gy: number) => (gx + 32768) * 65536 + (gy + 32768);

/** Printed segments of a path as capsule centre lines. */
function capsulesOf(path: Toolpath, w: number, out: Capsule[]): void {
  const p = path.points;
  for (let i = 1; i < p.length; i++) {
    if (p[i].travel) continue;
    if (Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y) < 1e-9) continue;
    out.push({ ax: p[i - 1].x, ay: p[i - 1].y, bx: p[i].x, by: p[i].y, w });
  }
}

/**
 * Cut a path where it comes closer to the capsules than they allow. Returns null when nothing is cut,
 * otherwise the new points (possibly none): kept pieces in their original order, joined by travels.
 */
function cutPath(path: Toolpath, w: number, grid: CapsuleGrid, clearance: (capW: number) => number, opt: ClearanceOptions): ToolpathPoint[] | null {
  const P = path.points;
  if (P.length < 2) return null;
  type Piece = ToolpathPoint[];
  const pieces: Piece[] = [];
  let cur: Piece | null = null;
  let cut = false;
  const lerp = (a: ToolpathPoint, b: ToolpathPoint, t: number, segE: number): ToolpathPoint => ({
    x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t, f: b.f, flow: b.flow, e: segE,
    ...(b.w !== undefined ? { w: b.w } : {}), ...(b.slope !== undefined ? { slope: (a.slope ?? 0) + ((b.slope ?? 0) - (a.slope ?? 0)) * t } : {}),
  });
  for (let i = 1; i < P.length; i++) {
    const a = P[i - 1], b = P[i];
    if (b.travel) { cur = null; continue; }
    const bad: [number, number][] = [];
    for (const ci of grid.near(a.x, a.y, b.x, b.y)) {
      const c = grid.caps[ci];
      const iv = segmentInCapsule(a.x, a.y, b.x, b.y, c, clearance(c.w));
      if (iv) bad.push(iv);
    }
    // kept parts of this segment = [0, 1] minus the union of the bad intervals
    const keep: [number, number][] = [];
    if (!bad.length) keep.push([0, 1]);
    else {
      cut = true;
      bad.sort((u, v) => u[0] - v[0]);
      let t = 0;
      for (const [s, e] of bad) { if (s > t + 1e-9) keep.push([t, s]); t = Math.max(t, e); }
      if (t < 1 - 1e-9) keep.push([t, 1]);
    }
    for (const [s, e] of keep) {
      const startsAtA = s <= 1e-9, endsAtB = e >= 1 - 1e-9;
      const end = endsAtB ? { ...b, e: b.e * (e - s) } : lerp(a, b, e, b.e * (e - s));
      if (endsAtB) delete end.travel;
      if (!endsAtB) delete end.post;
      if (startsAtA && cur) cur.push(end);
      else {
        const start = startsAtA ? { ...a, e: 0 } : lerp(a, b, s, 0);
        delete start.travel; delete start.post;
        cur = [start, end];
        pieces.push(cur);
      }
      if (!endsAtB) cur = null;
    }
    if (!keep.length || keep[keep.length - 1][1] < 1 - 1e-9) cur = null;
  }
  if (!cut) return null;
  // too-short leftovers would only make a blob
  const minLen = w * (opt.minPieceShare ?? 1);
  const kept = pieces.filter((pc) => {
    let L = 0;
    for (let k = 1; k < pc.length; k++) L += Math.hypot(pc[k].x - pc[k - 1].x, pc[k].y - pc[k - 1].y);
    return L >= minLen;
  });
  const out: ToolpathPoint[] = [];
  for (const pc of kept) {
    if (!out.length) { out.push(...pc); continue; }
    const last = out[out.length - 1], first = pc[0];
    const gap = Math.hypot(first.x - last.x, first.y - last.y);
    if (gap > 1e-6) {
      const jump: ToolpathPoint = { ...first, travel: true, e: 0 };
      if (opt.retractOver && opt.retractLength && gap > opt.retractOver) {
        out[out.length - 1] = { ...last, post: { ...last.post, retract_mm: opt.retractLength } };
        jump.post = { unretract_mm: opt.retractLength };
      }
      out.push(jump, ...pc.slice(1));
    } else out.push(...pc.slice(1));
  }
  return out;
}

/**
 * Cut the lines of one layer so none prints over a motion wall or a wall following it.
 * Returns how many paths were cut. Cut paths get `clipped: true`; a path cut away entirely is left
 * with no points.
 */
export function clearOverlaps(layer: Layer, widthOf: WidthOf, opt: ClearanceOptions): number {
  const tiers = layer.paths.map(tierOf);
  if (!tiers.some((t) => t === 0)) return 0;
  const edge = Math.max(0, opt.layerHeight * (1 - Math.PI / 4));
  let changed = 0;
  for (const level of [1, 2] as const) {
    const caps: Capsule[] = [];
    layer.paths.forEach((p, k) => { if (tiers[k] < level) capsulesOf(p, widthOf(p, k), caps); });
    if (!caps.length) continue;
    const maxW = caps.reduce((m, c) => Math.max(m, c.w), 0);
    let maxT = 0;
    layer.paths.forEach((p, k) => { if (tiers[k] === level) maxT = Math.max(maxT, widthOf(p, k)); });
    const reach = (maxW + maxT) / 2;
    const grid = new CapsuleGrid(caps, Math.max(0.5, reach * 2), reach);
    layer.paths = layer.paths.map((p, k) => {
      if (tiers[k] !== level || p.points.length < 2) return p;
      const w = widthOf(p, k);
      // centre lines may come as close as their half widths, less the bead's rounded edge, and for
      // infill less the infill/wall overlap as well
      const overlap = isFill(p.feature) ? Math.max(edge, opt.infillOverlap * w) : edge;
      // less a hair (TOLERANCE) so lines the slicer itself spaced exactly are never nicked
      const clearance = (capW: number) => Math.max(0, (capW + w) / 2 - overlap - TOLERANCE);
      const pts = cutPath(p, w, grid, clearance, opt);
      if (!pts) return p;
      changed++;
      return { ...p, points: pts, clipped: true };
    });
  }
  return changed;
}
