// Shared geometry for the Patternex tools (text, codes, trace, clean-up): pattern rings ↔ Clipper paths,
// Douglas–Peucker simplification, speck removal, colour merging and the minimum-feature check.
import ClipperLib from 'clipper-lib';
import { area, SCALE, union } from '../../../engine/clipper';
import type { Path, Paths } from '../../../engine/types';
import { boundsOf, type Pattern, type PatternShape, type Ring } from '../model';

const C: any = (ClipperLib as any).default ?? ClipperLib;

export const ringsToPaths = (rings: Ring[]): Paths => rings.filter((r) => r.length >= 3).map((r) => r.map(([x, y]) => ({ X: Math.round(x * SCALE), Y: Math.round(y * SCALE) })));
export const pathsToRings = (ps: Paths): Ring[] => ps.map((p) => p.map((q) => [q.X / SCALE, q.Y / SCALE] as [number, number]));

/** Signed area (mm², CCW positive) of a ring. */
export function ringArea(r: Ring): number {
  let s = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1]);
  return s / 2;
}

/** Union of one colour's rings (resolved with its fill rule) as clean nonzero rings: outer CCW, holes CW. */
export function solidRings(rings: Ring[], evenodd = false): Ring[] {
  return pathsToRings(union(ringsToPaths(rings), [], evenodd ? C.PolyFillType.pftEvenOdd : C.PolyFillType.pftNonZero));
}

/** Morphological offset of a ring set (mm, + grows). Round joins keep letter shapes. */
export function offsetRings(rings: Ring[], d: number): Ring[] {
  if (!rings.length || !d) return rings;
  const co = new C.ClipperOffset(2, SCALE * 0.005);
  co.AddPaths(ringsToPaths(rings), C.JoinType.jtRound, C.EndType.etClosedPolygon);
  const out: Paths = [];
  co.Execute(out, Math.round(d * SCALE));
  return pathsToRings(out);
}

/** Open polylines grown into a stroke of width w (round ends). */
export function strokeLines(lines: [number, number][][], w: number): Ring[] {
  const co = new C.ClipperOffset(2, SCALE * 0.005);
  co.AddPaths(lines.filter((l) => l.length >= 1).map((l) => (l.length === 1 ? [l[0], l[0]] : l).map(([x, y]) => ({ X: Math.round(x * SCALE), Y: Math.round(y * SCALE) }))), C.JoinType.jtRound, C.EndType.etOpenRound);
  const out: Paths = [];
  co.Execute(out, Math.round((w / 2) * SCALE));
  return pathsToRings(out);
}

/** Douglas–Peucker on a closed ring (tolerance mm). */
export function simplifyRing(r: Ring, tol: number): Ring {
  if (r.length <= 4 || tol <= 0) return r;
  const keep = new Uint8Array(r.length);
  const dp = (a: number, b: number) => {
    let best = -1, bi = -1;
    const [ax, ay] = r[a], [bx, by] = r[b % r.length];
    const dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy) || 1e-12;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((r[i][0] - ax) * dy - (r[i][1] - ay) * dx) / L;
      if (d > best) { best = d; bi = i; }
    }
    if (best > tol) { keep[bi] = 1; dp(a, bi); dp(bi, b); }
  };
  // split at the point farthest from the first so the closed ring keeps its shape
  let far = 0, fd = -1;
  for (let i = 1; i < r.length; i++) { const d = Math.hypot(r[i][0] - r[0][0], r[i][1] - r[0][1]); if (d > fd) { fd = d; far = i; } }
  keep[0] = keep[far] = 1;
  dp(0, far); dp(far, r.length);
  const out = r.filter((_, i) => keep[i]);
  return out.length >= 3 ? out : r;
}

export function rgbOf(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16) || 0, parseInt(h.slice(2, 4), 16) || 0, parseInt(h.slice(4, 6), 16) || 0];
}
export const hexOf = ([r, g, b]: number[]) => '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');

/** CIE76 ΔE between two sRGB colours (Lab, D65). ~2.3 is a just-noticeable difference. */
export function deltaE(a: string, b: string): number {
  const [l1, a1, b1] = lab(rgbOf(a)), [l2, a2, b2] = lab(rgbOf(b));
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}
export function lab([r, g, b]: number[]): [number, number, number] {
  const lin = (c: number) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const R = lin(r), G = lin(g), B = lin(b);
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const x = f((0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047), y = f(0.2126 * R + 0.7152 * G + 0.0722 * B), z = f((0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

export interface CleanupOptions {
  /** Merge colours closer than this ΔE (0 = off). */
  mergeDeltaE: number;
  /** Douglas–Peucker tolerance, mm (0 = off). */
  simplifyMm: number;
  /** Drop islands and holes smaller than this, mm² (0 = off). */
  speckMm2: number;
}
export interface CleanupReport { colorsBefore: number; colorsAfter: number; pointsBefore: number; pointsAfter: number; specksRemoved: number }

/**
 * SVG clean-up: near-identical colours become one region group (the most used colour wins), outlines are
 * simplified and specks too small to print are removed. Later shapes still paint over earlier ones.
 */
export function cleanupPattern(p: Pattern, o: CleanupOptions): { pattern: Pattern; report: CleanupReport } {
  const count = (shapes: PatternShape[]) => shapes.reduce((n, s) => n + s.polygon_rings.reduce((a, r) => a + r.length, 0), 0);
  const colorsBefore = new Set(p.shapes.map((s) => s.fill_color)).size;
  // colour clusters, most-used (by area) first
  const weight = new Map<string, number>();
  for (const s of p.shapes) weight.set(s.fill_color, (weight.get(s.fill_color) ?? 0) + Math.abs(s.polygon_rings.reduce((a, r) => a + ringArea(r), 0)));
  const reps: string[] = [];
  const map = new Map<string, string>();
  for (const c of [...weight.keys()].sort((a, b) => weight.get(b)! - weight.get(a)!)) {
    const hit = o.mergeDeltaE > 0 ? reps.find((r) => deltaE(r, c) <= o.mergeDeltaE) : undefined;
    if (hit) map.set(c, hit); else { reps.push(c); map.set(c, c); }
  }
  let specks = 0;
  const shapes: PatternShape[] = [];
  for (const s of p.shapes) {
    let rings = s.polygon_rings;
    if (o.speckMm2 > 0 || o.simplifyMm > 0) {
      rings = solidRings(rings, s.fill_rule === 'evenodd');
      if (o.speckMm2 > 0) { const n = rings.length; rings = rings.filter((r) => Math.abs(ringArea(r)) >= o.speckMm2); specks += n - rings.length; }
      if (o.simplifyMm > 0) rings = rings.map((r) => simplifyRing(r, o.simplifyMm)).filter((r) => r.length >= 3);
    }
    if (rings.length) shapes.push({ polygon_rings: rings, fill_color: map.get(s.fill_color) ?? s.fill_color, fill_rule: o.speckMm2 > 0 || o.simplifyMm > 0 ? 'nonzero' : s.fill_rule });
  }
  const pattern: Pattern = { ...p, shapes, bounds: boundsOf(shapes) };
  return { pattern, report: { colorsBefore, colorsAfter: new Set(shapes.map((s) => s.fill_color)).size, pointsBefore: count(p.shapes), pointsAfter: count(shapes), specksRemoved: specks } };
}

/**
 * Minimum-feature check: parts of the artwork narrower than `minWidth` disappear under a morphological
 * opening (erode by w/2, grow back). Returns the share of area lost (0..1) and the thin parts.
 */
export function thinFeatures(rings: Ring[], minWidth: number): { lostShare: number; thin: Ring[] } {
  const solid = ringsToPaths(solidRings(rings));
  const total = solid.reduce((a, p) => a + area(p), 0);
  if (total <= 0) return { lostShare: 0, thin: [] };
  const opened = ringsToPaths(offsetRings(offsetRings(pathsToRings(solid), -minWidth / 2), minWidth / 2));
  const lost = pathsToRings(exec(C.ClipType.ctDifference, solid, opened)).filter((r) => Math.abs(ringArea(r)) > (minWidth * minWidth) / 20);
  const lostA = lost.reduce((a, r) => a + ringArea(r), 0);
  return { lostShare: Math.max(0, Math.min(1, lostA / total)), thin: lost };
}

function exec(ct: number, a: Paths, b: Paths): Paths {
  const c = new C.Clipper();
  c.AddPaths(a, C.PolyType.ptSubject, true);
  c.AddPaths(b, C.PolyType.ptClip, true);
  const out: Paths = [];
  c.Execute(ct, out, C.PolyFillType.pftNonZero, C.PolyFillType.pftNonZero);
  return out;
}

/** Pattern from coloured ring sets (each colour one nonzero shape). */
export function patternOf(id: string, name: string, groups: { color: string; rings: Ring[] }[], meta?: Pattern['meta'], tol = 0.02): Pattern {
  const shapes: PatternShape[] = groups.filter((g) => g.rings.length).map((g) => ({ polygon_rings: g.rings, fill_color: g.color, fill_rule: 'nonzero' }));
  return { id, name, source: 'builtin', shapes, tolerance_mm: tol, bounds: boundsOf(shapes), ...(meta ? { meta } : {}) };
}

export type { Path };
