// Stage 4: perimeters of one island. Classic offset loops or Arachne-style variable-width beads, plus the extras
// around them: one wall on top surfaces, detect thin wall and gap fill.
import { clipLines, difference, exToPaths, intersection, offset, opening, orientation, SCALE, union } from './clipper';
import { medialAxis, splitNarrow, type VarPath } from './arachne';
import type { ExPolygon, FeatureType, Path, Paths } from './types';
import { pushAll } from './util';
import { overhangPerimeters, simplifyWall } from './wallParity';

export interface WallItem {
  pts: number[];
  closed: boolean;
  feature: FeatureType;
  width: number;
  /** Wall index from the outside (0 = outer wall). */
  ring: number;
  /** Loop of a hole (clockwise) rather than of an outer contour. */
  hole: boolean;
  widths?: number[];
}

export interface WallParams {
  walls: number;
  wo: number; wi: number; so: number; si: number;
  nozzle: number;
  arachne: boolean;
  /** Arachne: narrowest bead, narrowest feature printed, two-bead margin (mm). */
  minBead: number; minFeature: number; margin: number;
  thinWalls: boolean;
  gapFill: boolean;
  /** Arachne: length (mm) over which bead widths blend, wedge angle (°) above which tips get no centre bead,
   *  number of walls from the centre that share a width difference. */
  transitionLength?: number; transitionAngle?: number; distributionCount?: number;
  /** Precise wall: the first inner wall keeps a full half-line from the outer wall (no overlap squeezing it out). */
  precise?: boolean;
  /** Part of the island that is a top surface and should keep only its outer wall (null = none). */
  topOneWall: Paths | null;
  /** Arachne: open thin walls shorter than this factor x their width are dropped (min_length_factor). */
  minLengthFactor?: number;
  /** Arachne: maximum wall resolution / deviation (mm, 0 = off). */
  maxResolution?: number; maxDeviation?: number;
  /** Extra perimeters on overhangs: the layer below (null = off). */
  overhangBelow?: Paths | null;
}

export interface IslandWalls {
  /** Loops by depth (0 = outer). Inner walls cut by "one wall on top" become open paths. */
  loops: WallItem[][];
  /** Area left for infill and skins. */
  inner: Paths;
  /** Single variable-width beads (Arachne thin parts, detected thin walls). */
  thin: WallItem[];
  /** Gap fill between walls. */
  gaps: WallItem[];
}

const toPts = (p: Path) => { const out: number[] = []; for (const q of p) out.push(q.X / SCALE, q.Y / SCALE); return out; };
const varItem = (v: VarPath, feature: FeatureType, ring: number): WallItem => ({
  pts: v.pts, closed: false, feature, ring, hole: false, widths: v.widths,
  width: v.widths.reduce((a, b) => a + b, 0) / Math.max(1, v.widths.length),
});

export function islandWalls(ex: ExPolygon, p: WallParams): IslandWalls {
  const ip = exToPaths(ex);
  const loops: WallItem[][] = [];
  const thin: WallItem[] = [];
  const gaps: WallItem[] = [];
  if (p.walls <= 0) return { loops, inner: ip, thin, gaps };

  if (p.arachne) {
    // variable-width walls: narrow areas get one bead whose width follows the region
    let A = ip;
    for (let k = 0; k < p.walls && A.length; k++) {
      const w = k === 0 ? p.wo : p.wi, sp = k === 0 ? p.so : p.si;
      const feature: FeatureType = k === 0 ? 'outer_wall' : 'inner_wall';
      const sn = splitNarrow(A, w, p.minBead, Math.min(2 * w, p.nozzle * 2), { margin: p.margin, dropW: p.minFeature });
      for (const t of sn.thin) {
        const v = shapeBead(t, w, p);
        if (v) thin.push(varItem(v, feature, k));
      }
      const ps = sn.wide.length ? offset(sn.wide, -w / 2).filter((q) => q.length >= 3) : [];
      if (ps.length) loops.push(ps.map((q) => ({ pts: toPts(q), closed: true, feature, width: w, ring: k, hole: !orientation(q) })));
      // precise wall: the next bead centre ends up (wo + wi) / 2 from the outer wall's centre
      A = sn.wide.length ? offset(sn.wide, -(k === 0 && p.precise ? p.wo : sp)) : [];
    }
    distribute(loops, thin, p);
    // minimum wall length: short open beads are not worth printing
    const f = p.minLengthFactor ?? 0;
    const kept = f > 0 ? thin.filter((t) => lenOf(t.pts) >= f * t.width) : thin;
    // maximum wall resolution / deviation (Arachne meshfix)
    if ((p.maxResolution ?? 0) > 0 && (p.maxDeviation ?? 0) > 0) {
      for (const ring of loops) for (const l of ring) l.pts = simplifyWall(l.pts, true, p.maxResolution!, p.maxDeviation!).pts;
      for (const t of kept) { const r = simplifyWall(t.pts, false, p.maxResolution!, p.maxDeviation!, t.widths); t.pts = r.pts; t.widths = r.widths; }
    }
    return overhangExtras({ loops: cutInnerWallsOnTop(loops, ip, p), inner: topInner(A, ip, p), thin: kept, gaps }, p);
  }

  // classic: constant-width offset loops
  const polys: Paths[] = [];
  let boundary = 0;
  for (let k = 0; k < p.walls; k++) {
    // precise wall: outer and first inner bead centres a full (wo + wi) / 2 apart instead of the overlapped spacing
    const first = p.precise ? (p.wo + p.wi) / 2 : (p.so + p.si) / 2;
    const d = k === 0 ? p.wo / 2 : p.wo / 2 + first + (k - 1) * p.si;
    const ps = offset(ip, -d).filter((q) => q.length >= 3);
    if (!ps.length) break;
    const w = k === 0 ? p.wo : p.wi;
    polys.push(ps);
    loops.push(ps.map((q) => ({ pts: toPts(q), closed: true, feature: (k === 0 ? 'outer_wall' : 'inner_wall') as FeatureType, width: w, ring: k, hole: !orientation(q) })));
    boundary = d + (k === 0 ? p.so : p.si) / 2;
  }
  let inner = loops.length === p.walls ? offset(ip, -boundary) : [];

  if (p.thinWalls) {
    // parts of the island the outer loop cannot reach: print them as single beads
    const reach = polys.length ? offset(polys[0], p.wo / 2 + 0.01) : [];
    const narrow = opening(difference(ip, reach), p.nozzle * 0.15);
    if (narrow.length) for (const v of medialAxis(narrow, p.nozzle * 0.5, p.wo * 1.6)) {
      if (lenOf(v.pts) >= p.wo) thin.push({ ...varItem(v, 'outer_wall', 0), widths: v.widths.map((x) => Math.min(p.wo * 1.6, Math.max(p.nozzle * 0.6, x))) });
    }
  }
  if (p.gapFill && polys.length) {
    // gap fill: what neither a wall bead nor the infill area covers
    const rings: Paths = [];
    polys.forEach((ps, k) => {
      const w = k === 0 ? p.wo : p.wi;
      pushAll(rings, difference(offset(ps, w / 2), offset(ps, -w / 2)));
    });
    const covered = union([...rings, ...inner, ...thinCover(thin)]);
    const g = opening(difference(ip, covered), p.wo * 0.1);
    if (g.length) for (const v of medialAxis(g, p.nozzle * 0.25, p.wo * 2)) {
      if (lenOf(v.pts) >= p.wo) gaps.push({ ...varItem(v, 'gap_infill', p.walls), widths: v.widths.map((x) => Math.min(p.wo * 2, Math.max(p.nozzle * 0.25, x))) });
    }
  }
  return overhangExtras({ loops: cutInnerWallsOnTop(loops, ip, p), inner: topInner(inner, ip, p), thin, gaps }, p);
}

/** Extra perimeters on overhangs: concentric overhang wall loops instead of infill where the island hangs out. */
function overhangExtras(w: IslandWalls, p: WallParams): IslandWalls {
  if (!p.overhangBelow || !w.inner.length) return w;
  const r = overhangPerimeters(w.inner, p.overhangBelow, p.wi, p.si);
  if (!r.loops.length) return w;
  w.loops.push(r.loops.map((q) => ({ pts: toPts(q), closed: true, feature: 'overhang_wall' as FeatureType, width: p.wi, ring: w.loops.length, hole: !orientation(q) })));
  w.inner = r.inner;
  return w;
}

/**
 * Arachne transitions on one centre bead: widths blend over the transition length, and a tip that opens wider
 * than the transition angle (a blunt wedge) is trimmed back to where the bead reaches its nominal width.
 */
function shapeBead(v: VarPath, w: number, p: WallParams): VarPath | null {
  let pts = v.pts.slice(), widths = v.widths.slice();
  const ang = ((p.transitionAngle ?? 10) * Math.PI) / 180;
  const trimEnd = (rev: boolean) => {
    if (rev) { pts = reversePts(pts); widths.reverse(); }
    // tip opening angle: the bead reaches its nominal width w after s mm (tip widths are clamped, so measure the reach)
    let s = 0, k = 1;
    while (k < widths.length && widths[k] < w) { s += Math.hypot(pts[k * 2] - pts[k * 2 - 2], pts[k * 2 + 1] - pts[k * 2 - 1]); k++; }
    const tip = k < widths.length ? 2 * Math.atan2(w / 2, Math.max(1e-6, s)) : 0;
    if (tip > ang) {
      let cut = 0;
      while (cut < widths.length - 2 && widths[cut] < w * 0.999) cut++;
      if (cut) { pts = pts.slice(cut * 2); widths = widths.slice(cut); }
    }
    if (rev) { pts = reversePts(pts); widths.reverse(); }
  };
  trimEnd(false); trimEnd(true);
  if (widths.length < 2 || lenOf(pts) < w) return null;
  // blend widths over the transition length (moving average along the bead)
  const L = p.transitionLength ?? 0;
  if (L > 0 && widths.length > 2) {
    const acc = [0];
    for (let k = 1; k < widths.length; k++) acc.push(acc[k - 1] + Math.hypot(pts[k * 2] - pts[k * 2 - 2], pts[k * 2 + 1] - pts[k * 2 - 1]));
    const out = widths.map((_, k) => {
      let sum = 0, n = 0;
      for (let j = 0; j < widths.length; j++) if (Math.abs(acc[j] - acc[k]) <= L / 2) { sum += widths[j]; n++; }
      return sum / n;
    });
    widths = out;
  }
  return { ...v, pts, widths };
}
const reversePts = (pts: number[]) => { const o: number[] = []; for (let k = pts.length - 2; k >= 0; k -= 2) o.push(pts[k], pts[k + 1]); return o; };

/**
 * Wall distribution count: a centre bead's deviation from the nominal width is shared with the innermost
 * (count − 1) wall rings, so each changes by an equal part instead of the centre bead taking all of it.
 */
function distribute(loops: WallItem[][], thin: WallItem[], p: WallParams) {
  const n = Math.min(p.distributionCount ?? 1, loops.length + 1);
  if (n <= 1 || !thin.length) return;
  let dev = 0, cnt = 0;
  for (const t of thin) for (const x of t.widths ?? []) { dev += x - p.wi; cnt++; }
  if (!cnt) return;
  const share = dev / cnt / n;
  for (const t of thin) t.widths = t.widths!.map((x) => x - share * (n - 1));
  for (let r = loops.length - 1, used = 1; r >= 0 && used < n; r--, used++) {
    // each side of the centre bead belongs to the same ring, so the ring takes half the share per bead
    for (const l of loops[r]) l.width = Math.max(p.nozzle * 0.5, l.width + share / 2);
  }
}

function lenOf(pts: number[]) {
  let s = 0;
  for (let k = 2; k < pts.length; k += 2) s += Math.hypot(pts[k] - pts[k - 2], pts[k + 1] - pts[k - 1]);
  return s;
}
/** Area covered by variable-width beads (approximated by their mean width). */
function thinCover(items: WallItem[]): Paths {
  const out: Paths = [];
  for (const t of items) {
    const path: Path = [];
    for (let k = 0; k < t.pts.length; k += 2) path.push({ X: Math.round(t.pts[k] * SCALE), Y: Math.round(t.pts[k + 1] * SCALE) });
    pushAll(out, strokeOpen(path, t.width / 2));
  }
  return out;
}
/** Offset an open polyline into a polygon (round ends). */
function strokeOpen(path: Path, r: number): Paths {
  // approximate with a chain of small square segments, enough for coverage tests
  const out: Paths = [];
  for (let k = 1; k < path.length; k++) {
    const a = path[k - 1], b = path[k];
    const dx = b.X - a.X, dy = b.Y - a.Y, L = Math.hypot(dx, dy);
    if (L < 1) continue;
    const nx = (-dy / L) * r * SCALE, ny = (dx / L) * r * SCALE;
    out.push([
      { X: Math.round(a.X + nx), Y: Math.round(a.Y + ny) }, { X: Math.round(b.X + nx), Y: Math.round(b.Y + ny) },
      { X: Math.round(b.X - nx), Y: Math.round(b.Y - ny) }, { X: Math.round(a.X - nx), Y: Math.round(a.Y - ny) },
    ]);
  }
  return out.length ? union(out) : [];
}

/** One wall on top surfaces: inner walls stop where the island is a top surface. */
function cutInnerWallsOnTop(loops: WallItem[][], ip: Paths, p: WallParams): WallItem[][] {
  if (!p.topOneWall?.length || loops.length < 2) return loops;
  const keep = difference(ip, p.topOneWall);
  return loops.map((ring, k) => {
    if (k === 0) return ring;
    const out: WallItem[] = [];
    for (const l of ring) {
      const path: Path = [];
      for (let i = 0; i < l.pts.length; i += 2) path.push({ X: Math.round(l.pts[i] * SCALE), Y: Math.round(l.pts[i + 1] * SCALE) });
      path.push(path[0]);
      const pieces = keep.length ? clipLines([path], keep) : [];
      if (pieces.length === 1 && pieces[0].length >= path.length - 1) { out.push(l); continue; }
      for (const pc of pieces) if (pc.length >= 2) out.push({ ...l, pts: toPts(pc), closed: false });
    }
    return out;
  });
}
/** With one wall on top, the infill area reaches the outer wall under the top surface (filled as top skin). */
function topInner(inner: Paths, ip: Paths, p: WallParams): Paths {
  if (!p.topOneWall?.length || p.walls < 2) return inner;
  const insideOuter = offset(ip, -(p.wo / 2 + p.so / 2));
  const freed = intersection(insideOuter, p.topOneWall);
  return freed.length ? union(inner, freed) : inner;
}
