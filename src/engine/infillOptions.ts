// Infill / surface / bridge / ironing options of OrcaSlicer, Bambu Studio and Snapmaker Orca that NexSpiro adds for
// parity: rotation templates, the Zig Zag family and lateral lattices, adaptive (graded) gyroid, corner smoothing,
// separated / mirrored infill frames, top surface expansion, centre-based fill order and the small area flow model.
// The slicer calls these with the per-object, per-layer config (`c`) so object and height-range overrides apply.
import { bounds, difference, exToPaths, intersection, offset, SCALE, toExPolygons, union } from './clipper';
import { concentricFill, gyroidFill, linesFill } from './fill';
import { archimedeanFill, octagramFill } from './patterns';
import { floatOrPercent, type Config } from '../profiles/settings';
import type { Paths, Polyline2 } from './types';

const num = (c: Config, k: string, d = 0) => { const v = Number(c[k]); return Number.isFinite(v) ? v : d; };

// ---------------------------------------------------------------------------------------------------------------
// Rotation templates (sparse_infill_rotate_template / solid_infill_rotate_template)

/**
 * Angle (degrees) of a rotation template at an object layer, or null when the template is empty.
 * Tokens are separated by commas or spaces and used in turn, repeating at the end of the list:
 * `90` sets the angle, `+15` / `-15` add to it, `N%` is N percent of a full turn, and a `#K` suffix holds the
 * token for K layers (`+5#5`: +5° every 5 layers).
 */
export function templateAngle(tpl: string | undefined, layer: number): number | null {
  const toks = String(tpl ?? '').split(/[\s,]+/).map((t) => t.trim()).filter(Boolean);
  if (!toks.length) return null;
  const parsed = toks.map((t) => {
    const m = /^([+-]?)(\d*\.?\d+)(%?)(?:#(\d+))?/.exec(t);
    if (!m) return null;
    let a = parseFloat(m[2]);
    if (m[3]) a *= 3.6;
    return { rel: m[1] !== '', a: m[1] === '-' ? -a : a, hold: Math.max(1, Number(m[4] ?? 1)) };
  }).filter((p): p is { rel: boolean; a: number; hold: number } => p !== null);
  if (!parsed.length) return null;
  let angle = 0, t = 0, left = 0;
  for (let L = 0; L <= layer; L++) {
    if (left === 0) {
      const p = parsed[t % parsed.length];
      t++;
      angle = p.rel ? angle + p.a : p.a;
      left = p.hold;
    }
    left--;
  }
  return angle;
}

// ---------------------------------------------------------------------------------------------------------------
// Infill frames: separated infills (centred on each part) and symmetric infill about the Y axis

const mapPaths = (paths: Paths, f: (x: number, y: number) => [number, number]) =>
  paths.map((p) => p.map((q) => { const [x, y] = f(q.X / SCALE, q.Y / SCALE); return { X: Math.round(x * SCALE), Y: Math.round(y * SCALE) }; }));
const mapPolys = (polys: Polyline2[], f: (x: number, y: number) => [number, number]): Polyline2[] =>
  polys.map((p) => { const pts = p.pts.slice(); for (let k = 0; k < pts.length; k += 2) [pts[k], pts[k + 1]] = f(pts[k], pts[k + 1]); return { ...p, pts }; });

/**
 * Runs an infill generator in a frame whose origin is (cx, cy) (separated infills: the pattern is anchored on the
 * part, as if it were sliced on its own), mirrored in X when `mirror` (symmetric infill Y axis).
 */
export function inFrame(region: Paths, cx: number, cy: number, mirror: boolean, gen: (r: Paths) => Polyline2[]): Polyline2[] {
  if (!cx && !cy && !mirror) return gen(region);
  const sx = mirror ? -1 : 1;
  const r = mapPaths(region, (x, y) => [(x - cx) * sx, y - cy]);
  return mapPolys(gen(mirror ? r.map((p) => p.slice().reverse()) : r), (x, y) => [x * sx + cx, y + cy]);
}

// ---------------------------------------------------------------------------------------------------------------
// Sparse patterns that are not in fill.ts: Zig Zag, Cross Zag, Locked Zag, Lateral Lattice / 2D Lattice,
// Lateral Honeycomb, and the 3D honeycomb "fill pattern tops"

export const EXTRA_SPARSE = new Set(['zigzag', 'crosszag', 'lockedzag', 'lateral-lattice', '2dlattice', 'lateral-honeycomb']);
/** Patterns OrcaSlicer mirrors with "Symmetric infill Y axis". */
export const SYMMETRIC_PATTERNS = new Set(['zigzag', 'crosszag', 'lockedzag']);

/** Orca's skin depth of Locked Zag (skin_infill_depth default): the band along the walls printed as Cross Zag. */
const LOCKED_SKIN_DEPTH = 2;

/**
 * One family of parallel lines per sweep, at `baseAngle + angle`, shifted across the lines by `shift` mm
 * (OrcaSlicer fill_surface_by_multilines: each sweep gets density / sweeps).
 */
function sweeps(region: Paths, s: number, baseAngle: number, list: [number, number][], layer: number): Polyline2[] {
  const sp = s * list.length;
  const out = list.flatMap(([a, shift]) => linesFill(region, sp, baseAngle + a, false, shift / sp));
  if (layer % 2 === 1) for (const p of out) { const r: number[] = []; for (let k = p.pts.length - 2; k >= 0; k -= 2) r.push(p.pts[k], p.pts[k + 1]); p.pts = r; }
  return out;
}

/** Sparse infill of the extra patterns. `s` = line spacing at this density (width / density). */
export function extraSparseFill(region: Paths, pattern: string, s: number, layer: number, z: number, baseAngle: number, c: Config, fixedAngle = false): Polyline2[] {
  const alt = fixedAngle ? 0 : layer % 2 ? 90 : 0;
  // Cross Zag: each layer pair is shifted by the shift step, alternately left and right
  const shiftStep = Math.max(0, num(c, 'infill_shift_step', 0.4));
  const crossShift = shiftStep * Math.floor(layer / 2) * (layer % 2 === 0 ? -1 : 1);
  switch (pattern) {
    case 'zigzag': return linesFill(region, s, baseAngle + alt);
    case 'crosszag': return linesFill(region, s, baseAngle + alt, false, crossShift / s);
    case 'lockedzag': {
      // skeleton (Zig Zag) inside, skin (Cross Zag) along the walls; the skeleton reaches the lock depth into the skin
      const core = offset(region, -LOCKED_SKIN_DEPTH);
      const skin = core.length ? difference(region, core) : region;
      const lock = Math.max(0, num(c, 'infill_lock_depth', 1));
      const skeleton = core.length ? intersection(offset(core, lock), region) : [];
      return [...(skeleton.length ? linesFill(skeleton, s, baseAngle + alt) : []), ...(skin.length ? linesFill(skin, s, baseAngle + alt, false, crossShift / s) : [])];
    }
    case 'lateral-lattice': case '2dlattice': {
      const [k1, k2] = pattern === '2dlattice' ? ['sparse_infill_lattice_angle_1', 'sparse_infill_lattice_angle_2'] : ['lateral_lattice_angle_1', 'lateral_lattice_angle_2'];
      const clamp = (a: number) => (Math.max(-85, Math.min(85, a)) * Math.PI) / 180;
      return sweeps(region, s, baseAngle, [[90, Math.tan(clamp(num(c, k1, -45))) * z], [90, Math.tan(clamp(num(c, k2, 45))) * z]], layer);
    }
    case 'lateral-honeycomb': {
      const half = 0.5 * (4 / 3) * s;
      const ang = (Math.max(15, Math.min(75, num(c, 'infill_overhang_angle', 60))) * Math.PI) / 180;
      const vPeriod = (3 * half) / Math.tan(ang);
      const tf = (3 * z) / vPeriod, ti = Math.floor(tf);
      const single = (ti + 1) % 3 !== 0;
      const hoff = Math.floor((ti + 1) / 3) % 2 ? half : 0;
      if (single) return sweeps(region, (4 / 3) * s, baseAngle, [[90, hoff]], layer);
      const hp = (1 - (tf - ti)) * half;
      return sweeps(region, (2 / 3) * s, baseAngle, [[90, -hp + hoff], [90, hp + hoff]], layer);
    }
    default: return [];
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Gyroid: Z-buckling bias (gyroid_optimized) and adaptive density (adaptive_infill_*)

/** OrcaSlicer's gyroid density adjustment (FillGyroid::DensityAdjust). */
const GYROID_DENSITY_ADJUST = 2.44;
/** Z frequency factor of the optimized gyroid: shorter vertical columns at low density, 1 at ~30 % and above. */
export function gyroidZFactor(density: number, width: number, layerH: number): number {
  const dAdj = Math.max(density * GYROID_DENSITY_ADJUST, 0.1);
  const raw = Math.sqrt(1 / dAdj) / Math.sqrt(1 + (width > 0 ? layerH / width : 0.5));
  return Math.max(1, Math.min(2, raw));
}

/** Density at fraction t (0 = surface, 1 = centre) of the adaptive gradient. */
export function gradientAt(gradient: string, t: number, dSurf: number, dCore: number): number {
  const u = Math.max(0, Math.min(1, t));
  const g = gradient === 'quadratic' ? u * u : gradient === 'exponential' ? (1 - Math.exp(-4 * u)) / (1 - Math.exp(-4)) : u;
  return dSurf + (dCore - dSurf) * g;
}

/**
 * Splits a sparse region into shells by distance from the object's surface, each with its own gyroid density:
 * the sparse infill density at the surface, the interior density at the point farthest from it.
 * `deep(d)` returns the part of the layer at least d from the surface (in the mode's metric).
 * Stepped shells use densities about 1.5x apart; the other modes use finer steps.
 */
export function adaptiveShells(region: Paths, deep: (d: number) => Paths, mode: string, gradient: string, dSurf: number, dCore: number, width: number): { paths: Paths; density: number }[] {
  if (!region.length) return [];
  // the largest distance that still leaves something (binary search)
  let lo = 0, hi = Math.max(1, Math.hypot(...((b) => [(b.maxX - b.minX) / SCALE, (b.maxY - b.minY) / SCALE])(bounds(region)))) / 2;
  for (let k = 0; k < 14 && hi - lo > width / 4; k++) { const m = (lo + hi) / 2; if (intersection(region, deep(m)).length) lo = m; else hi = m; }
  const dMax = lo;
  if (dMax < width * 2 || Math.abs(dCore - dSurf) < 1e-3) return [{ paths: region, density: dSurf }];
  let steps = 6;
  if (mode === 'stepped_shells') steps = Math.max(1, Math.min(8, Math.round(Math.abs(Math.log(Math.max(dCore, 1e-3) / Math.max(dSurf, 1e-3))) / Math.log(1.5))));
  const out: { paths: Paths; density: number }[] = [];
  let rest = region;
  for (let b = 0; b < steps && rest.length; b++) {
    const inner = b + 1 < steps ? intersection(rest, deep((dMax * (b + 1)) / steps)) : [];
    const band = inner.length ? difference(rest, inner) : rest;
    const t = steps === 1 ? 1 : mode === 'stepped_shells' ? b / (steps - 1) : (b + 0.5) / steps;
    if (band.length) out.push({ paths: band, density: Math.max(0.01, gradientAt(gradient, t, dSurf, dCore)) });
    rest = inner;
  }
  return out;
}

/** In-plane inward offset measured only across X (`axis` 'x') or only across Y (`axis` 'y'), or in both. */
export function directionalShrink(paths: Paths, d: number, axis: 'x' | 'y' | 'xy'): Paths {
  if (axis === 'xy') return offset(paths, -d);
  // stretch the other axis so that the offset only eats along the measured one
  const S = 50;
  const st = mapPaths(paths, (x, y) => (axis === 'x' ? [x, y * S] : [x * S, y]));
  return mapPaths(offset(st, -d), (x, y) => (axis === 'x' ? [x, y / S] : [x / S, y]));
}

/** Gyroid lines of an adaptive shell set. */
export function adaptiveGyroid(shells: { paths: Paths; density: number }[], width: number, z: number, zFactor = 1): Polyline2[] {
  return shells.flatMap((sh) => gyroidFill(sh.paths, width / Math.min(1, sh.density), z, zFactor));
}

// ---------------------------------------------------------------------------------------------------------------
// 3D honeycomb: fill pattern tops (infill_complete_top)

/** The square tops of the truncated octahedra on the layer where the 3D honeycomb turns (they are left open otherwise). */
export function honeycombTops(region: Paths, spacing: number, z: number, zPrev: number, baseAngle: number): Polyline2[] {
  const g = spacing * 1.15;
  const along = (zz: number) => ((zz / (2 * g)) % 1 + 1) % 1 < 0.5;
  if (along(z) === along(zPrev)) return [];
  // the tops close the cells with lines across the previous direction, one per cell row
  return linesFill(region, g, baseAngle + (along(zPrev) ? 90 : 0));
}

// ---------------------------------------------------------------------------------------------------------------
// Sparse infill corner smoothing (sparse_infill_smooth_factor)

/**
 * Rounds the corners of open infill paths: every interior vertex becomes a curve that leaves and rejoins the path
 * at `factor` x half the shorter adjoining leg.
 */
export function smoothCorners(lines: Polyline2[], factor: number): Polyline2[] {
  const f = Math.max(0, Math.min(1, factor));
  if (f <= 0) return lines;
  return lines.map((l) => {
    const p = l.pts, n = p.length / 2;
    if (l.closed || n < 3) return l;
    const out: number[] = [p[0], p[1]];
    for (let i = 1; i < n - 1; i++) {
      const ax = p[i * 2 - 2], ay = p[i * 2 - 1], bx = p[i * 2], by = p[i * 2 + 1], cx = p[i * 2 + 2], cy = p[i * 2 + 3];
      const l1 = Math.hypot(bx - ax, by - ay), l2 = Math.hypot(cx - bx, cy - by);
      const cos = l1 > 0 && l2 > 0 ? ((bx - ax) * (cx - bx) + (by - ay) * (cy - by)) / (l1 * l2) : 1;
      if (cos > 0.999) { out.push(bx, by); continue; }
      const t = (f * Math.min(l1, l2)) / 2;
      const sx = bx - ((bx - ax) / l1) * t, sy = by - ((by - ay) / l1) * t;
      const ex = bx + ((cx - bx) / l2) * t, ey = by + ((cy - by) / l2) * t;
      const segs = Math.max(2, Math.min(8, Math.ceil(Math.acos(Math.max(-1, Math.min(1, cos))) / (Math.PI / 12))));
      for (let k = 0; k <= segs; k++) {
        const u = k / segs, w0 = (1 - u) ** 2, w1 = 2 * u * (1 - u), w2 = u * u;
        out.push(w0 * sx + w1 * bx + w2 * ex, w0 * sy + w1 * by + w2 * ey);
      }
    }
    out.push(p[n * 2 - 2], p[n * 2 - 1]);
    return { ...l, pts: out };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Top surface expansion (top_surface_expansion / _direction / _margin)

/**
 * Grows a top surface by `d` mm: inward closes the holes and gaps left by features rising from it, outward grows
 * its outer edge, both does both. The result stays inside the infill area `inner`, shrunk by `margin` where the
 * surface did not already reach the walls.
 */
export function expandTop(top: Paths, inner: Paths, d: number, dir: string, margin: number): Paths {
  if (!top.length || d <= 0) return top;
  let grown: Paths;
  if (dir === 'inward') {
    // closing: holes and gaps narrower than 2d are filled, the outer edges stay where they are
    grown = union(offset(offset(top, d), -d), top);
  } else if (dir === 'outward') {
    // grow only the outer edges: the holes keep their size
    const exs = toExPolygons(top);
    grown = union(exs.flatMap((ex) => difference(offset([ex.contour], d), ex.holes)));
  } else grown = offset(top, d);
  const limit = margin > 0 ? union(offset(inner, -margin), top) : inner;
  return union(intersection(grown, limit), top);
}

// ---------------------------------------------------------------------------------------------------------------
// Centre-based surface patterns: centre (center_of_surface_pattern) and fill order (top/bottom_surface_fill_order)

export const CENTRED_PATTERNS = new Set(['concentric', 'archimedeanchords', 'octagramspiral']);

/**
 * Surface lines of a centre-based pattern. Archimedean chords and octagram spirals are centred on `centre` (or on
 * each surface when null). `order` 'outward' starts at the centre, 'inward' at the edge; 'default' leaves the
 * order to the shortest-path sorter. Returns the lines and whether their order (and direction) must be kept.
 */
export function centredSurface(region: Paths, pattern: string, spacing: number, centre: [number, number] | null, order: string): { lines: Polyline2[]; keep: boolean } {
  const pieces = centre ? [{ r: region, c: centre }] : toExPolygons(region).map((ex) => {
    const p = exToPaths(ex), b = bounds([ex.contour]);
    return { r: p, c: [(b.minX + b.maxX) / 2 / SCALE, (b.minY + b.maxY) / 2 / SCALE] as [number, number] };
  });
  const keep = order === 'outward' || order === 'inward';
  const lines: Polyline2[] = [];
  for (const { r, c } of pieces) {
    let ls: Polyline2[];
    if (pattern === 'concentric') {
      ls = concentricFill(r, spacing, spacing / 2); // outermost first
      if (order === 'outward') ls.reverse();
    } else {
      ls = pattern === 'archimedeanchords' ? archimedeanFill(r, spacing, c) : octagramFill(r, spacing, c);
      if (keep) {
        // each clipped piece runs outward along the spiral: sort by distance of its start from the centre
        const d0 = (l: Polyline2) => Math.hypot(l.pts[0] - c[0], l.pts[1] - c[1]);
        ls.sort((a, b) => d0(a) - d0(b));
        if (order === 'inward') {
          ls.reverse();
          for (const l of ls) { const q: number[] = []; for (let k = l.pts.length - 2; k >= 0; k -= 2) q.push(l.pts[k], l.pts[k + 1]); l.pts = q; }
        }
      }
    }
    lines.push(...ls);
  }
  return { lines, keep };
}

// ---------------------------------------------------------------------------------------------------------------
// Small area infill flow compensation

export const DEFAULT_FLOW_MODEL = '0,0;\n0.2,0.4444;\n0.4,0.6145;\n0.6,0.7059;\n0.8,0.7619;\n1.5,0.8571;\n2,0.8889;\n3,0.9231;\n5,0.9520;\n10,1';

/**
 * Flow factor of a solid infill line by its length (OrcaSlicer small_area_infill_flow_compensation_model:
 * "length, factor" pairs, monotone cubic (PCHIP) between them, 1 beyond the last). Null when the model is invalid.
 */
export function flowModel(text: string): ((len: number) => number) | null {
  const xs: number[] = [], ys: number[] = [];
  for (const line of String(text).split(/[;\n]+/)) {
    const m = line.split(',').map((s) => s.trim());
    if (m.length < 2 || !m[0]) continue;
    const x = parseFloat(m[0]), y = parseFloat(m[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    xs.push(x); ys.push(y);
  }
  if (xs.length < 2 || Math.abs(xs[0]) > 1e-9) return null;
  for (let k = 1; k < xs.length; k++) if (xs[k] <= xs[k - 1] || ys[k] <= ys[k - 1]) return null;
  const n = xs.length, h = xs.slice(1).map((x, k) => x - xs[k]), dl = h.map((hk, k) => (ys[k + 1] - ys[k]) / hk);
  const m: number[] = new Array(n).fill(0);
  m[0] = dl[0]; m[n - 1] = dl[n - 2];
  for (let k = 1; k < n - 1; k++) {
    if (dl[k - 1] * dl[k] <= 0) { m[k] = 0; continue; }
    const w1 = 2 * h[k] + h[k - 1], w2 = h[k] + 2 * h[k - 1];
    m[k] = (w1 + w2) / (w1 / dl[k - 1] + w2 / dl[k]);
  }
  const xMax = xs[n - 1];
  return (len: number) => {
    if (len <= 0 || len > xMax) return 1;
    let k = 0;
    while (k < n - 2 && len > xs[k + 1]) k++;
    const t = (len - xs[k]) / h[k], t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[k] + (t3 - 2 * t2 + t) * h[k] * m[k] + (-2 * t3 + 3 * t2) * ys[k + 1] + (t3 - t2) * h[k] * m[k + 1];
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Bridges

/** Line width of external bridges (bridge_line_width): 0 = internal solid width, or the nozzle for thick bridges. */
export function bridgeWidth(c: Config, nozzle: number, solidW: number, thick: boolean): number {
  const w = floatOrPercent(c.bridge_line_width, nozzle);
  return w > 0 ? Math.min(w, nozzle) : thick ? nozzle : solidW;
}

/** Bridge direction: auto (the shorter span), a fixed angle, or the auto angle plus the setting (relative bridge angle). */
export function bridgeAngle(setting: number, auto: number, relative: boolean, modelRot: number): number {
  if (setting <= 0) return auto;
  if (relative) return auto + setting;
  return setting + modelRot;
}

/**
 * Internal bridge region of a layer: solid infill over the sparse infill of the layer below. "Filter" drops the
 * small ones (narrower than three solid lines), "Limited filtering" those narrower than one line, "No filtering"
 * keeps everything.
 */
export function internalBridges(solid: Paths, sparseBelow: Paths, filter: string, w: number): Paths {
  if (!solid.length || !sparseBelow.length) return [];
  const raw = intersection(solid, sparseBelow);
  if (!raw.length) return [];
  const r = filter === 'nofilter' ? 0 : filter === 'limited' ? w / 2 : w * 1.5;
  return r > 0 ? offset(offset(raw, -r), r) : raw;
}
