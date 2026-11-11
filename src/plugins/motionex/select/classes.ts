// Sorts the Select window's printed lines into the kinds a person thinks in: the outer wall, inner wall 1, 2, 3…
// (counted inwards from the outer wall), sparse infill, top layer 1, 2, 3… (counted down from the top skin),
// bottom layer 1, 2, 3… (counted up from the bottom skin), other solid infill and support, and on the walls
// which stretches are curved. The slice does not carry wall numbers or shell numbers, so they are measured from
// the lines themselves (the Select window and the slicer use the same code, so the highlight is what prints):
// - wall number: distance from the line to the nearest outer wall of the same layer, in line widths;
// - top / bottom number: layers to the nearest top (or bottom) skin straight above (or below) the line;
// - curved: the wall keeps turning the same way on both sides of the point (a corner turns on one side only).
import { FEATURE_ORDER, type FeatureType } from '../../../engine/types';
import type { LayerOps } from '../../../engine/gcode';

/** Printed segments: start xyz, end xyz; the move each came from (consecutive numbers = one line), its layer and kind. */
export interface Segs {
  pos: Float32Array;
  move: Uint32Array;
  layer: Uint32Array;
  feature: Uint8Array;
  count: number;
}

export type LineClass = 'outer' | 'inner' | 'infill' | 'top' | 'bottom' | 'solid' | 'support' | 'other';
export const CLASS_IDS: LineClass[] = ['outer', 'inner', 'infill', 'top', 'bottom', 'solid', 'support', 'other'];

export interface LineClasses {
  /** Per segment: index into CLASS_IDS. */
  cls: Uint8Array;
  /** Per segment: 1-based number within its kind (inner wall 1 = next to the outer wall, top 1 = the top skin). 0 = not counted. */
  rank: Uint8Array;
  /** Per segment: 1 = on a curved stretch of a wall. */
  curved: Uint8Array;
  /** Largest number found per counted kind. */
  max: { inner: number; top: number; bottom: number };
  /** Segments per kind. */
  count: Record<LineClass, number>;
}

const F = (n: FeatureType) => FEATURE_ORDER.indexOf(n);
const OUTER = new Set([F('outer_wall'), F('overhang_wall'), F('wave_overhang')]);
const INNER = F('inner_wall'), SPARSE = F('sparse_infill');
const TOP = new Set([F('top_surface'), F('ironing')]), BOTTOM = F('bottom_surface');
const SOLID = new Set([F('internal_solid_infill'), F('top_surface'), F('bottom_surface'), F('bridge'), F('gap_infill'), F('ironing')]);
const SUPPORT = new Set([F('support'), F('support_interface')]);
/** Farthest a top or bottom skin is looked for, in layers. */
const SHELL_REACH = 30;
const CELL = 2;
/** Curved: turning at least this much per mm (radius under 150 mm), over CURVE_SPAN mm on each side. */
const CURVE_K = 1 / 150, CURVE_SPAN = 1.5;

const key = (x: number, y: number) => `${Math.floor(x / CELL)},${Math.floor(y / CELL)}`;
const near = (set: Set<string> | undefined, x: number, y: number) => {
  if (!set) return false;
  const i = Math.floor(x / CELL), j = Math.floor(y / CELL);
  for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) if (set.has(`${i + a},${j + b}`)) return true;
  return false;
};

/** `width(s)`: the line width of a segment (mm). */
export function classifyLines(segs: Segs, layerCount: number, width: (s: number) => number): LineClasses {
  const n = segs.count, P = segs.pos;
  const cls = new Uint8Array(n), rank = new Uint8Array(n), curved = new Uint8Array(n);
  const max = { inner: 0, top: 0, bottom: 0 };
  const count = Object.fromEntries(CLASS_IDS.map((c) => [c, 0])) as Record<LineClass, number>;
  const mid = (s: number, a: 0 | 1) => (P[s * 6 + a] + P[s * 6 + 3 + a]) / 2;

  // skin cells per layer, and the outer wall points per layer for the wall numbers
  const topCells: Set<string>[] = Array.from({ length: layerCount }, () => new Set());
  const botCells: Set<string>[] = Array.from({ length: layerCount }, () => new Set());
  const outerGrid: Map<string, number[]>[] = Array.from({ length: layerCount }, () => new Map());
  for (let s = 0; s < n; s++) {
    const f = segs.feature[s], li = segs.layer[s];
    if (TOP.has(f) || f === BOTTOM) {
      // every cell the skin line passes, not just its middle: long skin lines cover their whole width
      const cells = TOP.has(f) ? topCells[li] : botCells[li];
      const ax = P[s * 6], ay = P[s * 6 + 1], ex = P[s * 6 + 3] - ax, ey = P[s * 6 + 4] - ay;
      const steps = Math.max(1, Math.ceil(Math.hypot(ex, ey) / CELL));
      for (let k = 0; k <= steps; k++) cells.add(key(ax + (ex * k) / steps, ay + (ey * k) / steps));
    }
    else if (OUTER.has(f)) {
      // points every ~0.5 mm along the outer wall, binned in 1 mm cells
      const ax = P[s * 6], ay = P[s * 6 + 1], ex = P[s * 6 + 3] - ax, ey = P[s * 6 + 4] - ay;
      const steps = Math.max(1, Math.ceil(Math.hypot(ex, ey) / 0.5));
      for (let k = 0; k <= steps; k++) {
        const x = ax + (ex * k) / steps, y = ay + (ey * k) / steps, c = `${Math.floor(x)},${Math.floor(y)}`;
        const g = outerGrid[li].get(c);
        if (g) g.push(x, y); else outerGrid[li].set(c, [x, y]);
      }
    }
  }
  const outerDist = (li: number, x: number, y: number) => {
    const g = outerGrid[li], i = Math.floor(x), j = Math.floor(y);
    let best = Infinity;
    for (let r = 0; r <= 12; r++) {
      for (let a = -r; a <= r; a++) for (let b = -r; b <= r; b++) {
        if (Math.max(Math.abs(a), Math.abs(b)) !== r) continue;
        const pts = g.get(`${i + a},${j + b}`);
        if (pts) for (let k = 0; k < pts.length; k += 2) best = Math.min(best, Math.hypot(pts[k] - x, pts[k + 1] - y));
      }
      if (best <= r) break; // nothing in a farther ring can be nearer
    }
    return best;
  };

  // one class per run (consecutive segments of one feature on one layer), measured at a few points along it
  let s = 0;
  while (s < n) {
    let e = s + 1;
    while (e < n && segs.layer[e] === segs.layer[s] && segs.feature[e] === segs.feature[s] && segs.move[e] === segs.move[e - 1] + 1) e++;
    const f = segs.feature[s], li = segs.layer[s];
    let c: LineClass = 'other', r = 0;
    if (OUTER.has(f)) { c = 'outer'; r = 1; }
    else if (f === INNER) {
      c = 'inner';
      const w = width(s) || 0.42, probe = [s, Math.floor((s + e - 1) / 2), e - 1];
      const ds = probe.map((p) => outerDist(li, mid(p, 0), mid(p, 1))).filter(Number.isFinite).sort((a, b) => a - b);
      r = ds.length ? Math.max(1, Math.min(250, Math.round(ds[Math.floor(ds.length / 2)] / w))) : 1;
    } else if (f === SPARSE) c = 'infill';
    else if (SUPPORT.has(f)) c = 'support';
    else if (SOLID.has(f)) {
      const m = Math.floor((s + e - 1) / 2), x = mid(m, 0), y = mid(m, 1);
      let up = Infinity, down = Infinity;
      for (let k = 0; k <= SHELL_REACH && li + k < layerCount; k++) if (near(topCells[li + k], x, y)) { up = k; break; }
      for (let k = 0; k <= SHELL_REACH && li - k >= 0; k++) if (near(botCells[li - k], x, y)) { down = k; break; }
      if (up === Infinity && down === Infinity) c = 'solid';
      else if (up <= down) { c = 'top'; r = Math.min(250, up + 1); }
      else { c = 'bottom'; r = Math.min(250, down + 1); }
    }
    if (c === 'outer' || c === 'inner') markCurved(P, s, e, curved);
    const ci = CLASS_IDS.indexOf(c);
    for (let k = s; k < e; k++) { cls[k] = ci; rank[k] = r; }
    count[c] += e - s;
    if (c === 'inner' || c === 'top' || c === 'bottom') max[c] = Math.max(max[c], r);
    s = e;
  }
  return { cls, rank, curved, max, count };
}

/** Curved stretches of one line (segments s..e-1): the heading changes the same way before and after each segment. */
function markCurved(P: Float32Array, s: number, e: number, out: Uint8Array) {
  const m = e - s;
  if (m < 3) return;
  const head = new Float64Array(m), arc = new Float64Array(m + 1);
  for (let k = 0; k < m; k++) {
    const i = (s + k) * 6, dx = P[i + 3] - P[i], dy = P[i + 4] - P[i + 1];
    head[k] = Math.atan2(dy, dx);
    arc[k + 1] = arc[k] + Math.hypot(dx, dy);
  }
  // unwrapped heading, so turns add up across ±180°
  const turn = new Float64Array(m);
  for (let k = 1; k < m; k++) { let d = head[k] - head[k - 1]; d -= Math.round(d / (2 * Math.PI)) * 2 * Math.PI; turn[k] = turn[k - 1] + d; }
  let a = 0, b = 0;
  for (let k = 0; k < m; k++) {
    const mid = (arc[k] + arc[k + 1]) / 2;
    while (a < k && (arc[a] + arc[a + 1]) / 2 < mid - CURVE_SPAN) a++;
    while (b < m - 1 && (arc[b + 1] + arc[b + 2]) / 2 <= mid + CURVE_SPAN) b++;
    const back = turn[k] - turn[a], fwd = turn[b] - turn[k];
    const lb = mid - (arc[a] + arc[a + 1]) / 2, lf = (arc[b] + arc[b + 1]) / 2 - mid;
    if (lb < CURVE_SPAN * 0.5 || lf < CURVE_SPAN * 0.5) continue;
    const need = CURVE_K * CURVE_SPAN;
    if (Math.sign(back) === Math.sign(fwd) && Math.abs(back) >= need * (lb / CURVE_SPAN) && Math.abs(fwd) >= need * (lf / CURVE_SPAN)) out[s + k] = 1;
  }
}

const SKIP = new Set(['travel', 'skirt', 'brim', 'prime_tower'].map((f) => FEATURE_ORDER.indexOf(f as FeatureType)));

/**
 * Segments of the slicer's own moves, so the slicer can measure line classes the same way the window does.
 * `opAt[layer][op]` gives the segment of each printing move op (-1 for anything else).
 */
export function segsOfOps(layers: LayerOps[]): { segs: Segs; opAt: Int32Array[]; width: Float32Array } {
  let count = 0;
  for (const L of layers) for (const op of L.ops) if (op.k === 'move' && !op.travel && op.e > 0) count++;
  const pos = new Float32Array(count * 6), move = new Uint32Array(count), layer = new Uint32Array(count), feature = new Uint8Array(count), width = new Float32Array(count);
  const opAt: Int32Array[] = [];
  let s = 0, mv = 0;
  layers.forEach((L, li) => {
    const at = new Int32Array(L.ops.length).fill(-1);
    let px = NaN, py = NaN, pz = NaN;
    L.ops.forEach((op, k) => {
      if (op.k === 'raw' && op.resetPos) { px = NaN; mv += 2; return; }
      if (op.k !== 'move') return;
      mv++;
      const f = FEATURE_ORDER.indexOf(op.feature);
      if (!op.travel && op.e > 0 && !Number.isNaN(px) && !SKIP.has(f)) {
        pos.set([px, py, pz, op.x, op.y, op.z], s * 6);
        move[s] = mv; layer[s] = li; feature[s] = f; width[s] = op.w; at[k] = s; s++;
      } else if (!op.travel && op.e > 0) mv++; // a line that can't be drawn breaks the run
      px = op.x; py = op.y; pz = op.z;
    });
    opAt.push(at);
  });
  return { segs: { pos: pos.subarray(0, s * 6), move: move.subarray(0, s), layer: layer.subarray(0, s), feature: feature.subarray(0, s), count: s }, opAt, width: width.subarray(0, s) };
}

/** What the window shows: each kind on or off, and for the counted kinds how many from the outside in. */
export interface LineFilter {
  outer: boolean;
  inner: boolean; innerUpTo: number;
  infill: boolean;
  top: boolean; topUpTo: number;
  bottom: boolean; bottomUpTo: number;
  solid: boolean;
  support: boolean;
  other: boolean;
}
/** Everything shown. The counts are high, so every number found is shown until the person lowers them. */
export const SHOW_ALL: LineFilter = { outer: true, inner: true, innerUpTo: 99, infill: true, top: true, topUpTo: 99, bottom: true, bottomUpTo: 99, solid: true, support: true, other: true };

export function visibleMask(lc: LineClasses, f: LineFilter): Uint8Array {
  const out = new Uint8Array(lc.cls.length);
  for (let s = 0; s < out.length; s++) {
    const c = CLASS_IDS[lc.cls[s]], r = lc.rank[s];
    out[s] = (c === 'inner' ? f.inner && r <= f.innerUpTo
      : c === 'top' ? f.top && r <= f.topUpTo
      : c === 'bottom' ? f.bottom && r <= f.bottomUpTo
      : f[c]) ? 1 : 0;
  }
  return out;
}
