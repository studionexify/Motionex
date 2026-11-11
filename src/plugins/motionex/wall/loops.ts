// Wall geometry shared by the wall-art modes (weave, velocity painting, lace): closed wall loops found in
// a layer's moves, where each point sits round the part (u, 0..1 from the +X side, counter-clockwise)
// and how far up the wall each layer is (measured along the curve of bellies and flares when asked).
import type { LayerOps, Op } from '../../../engine/gcode';

export type Move = Extract<Op, { k: 'move' }>;
export interface Pt { x: number; y: number }

export const OUTER = new Set<Move['feature']>(['outer_wall', 'overhang_wall']);
export const WALLS = new Set<Move['feature']>(['outer_wall', 'overhang_wall', 'inner_wall']);

/** A run of wall moves in a layer: ops[start..end) print it, starting from pts[0]. */
export interface WallRun {
  start: number; end: number;
  /** pts[0] is where the run starts (the end of the move before it), then one point per move. */
  pts: Pt[];
  feat: Move['feature'][];
  f: number[];
  e: number[];
  z: number; w: number; h: number;
  ePerMm: number;
  /** First and last point within joining distance: a closed loop (pts[last] dropped from `loop`). */
  closed: boolean;
}

/**
 * Runs of printing moves with a feature in `features`, between travels. `from`: where the head stands
 * when the layer starts (spiral vase layers print straight on from the previous layer, no travel first).
 */
export function wallRuns(L: LayerOps, features: Set<Move['feature']>, from: Pt | null = null): WallRun[] {
  const out: WallRun[] = [];
  let last: Pt | null = from ? { ...from } : null;
  let i = 0;
  const ops = L.ops;
  while (i < ops.length) {
    const op = ops[i];
    if (op.k === 'raw' && op.resetPos) { last = null; i++; continue; }
    if (op.k !== 'move') { i++; continue; }
    if (op.travel || op.e <= 0 || !last || !features.has(op.feature)) { last = { x: op.x, y: op.y }; i++; continue; }
    const pts: Pt[] = [{ ...last }], feat: Move['feature'][] = [], f: number[] = [], e: number[] = [];
    let j = i, eSum = 0, len = 0, z = op.z;
    while (j < ops.length) {
      const m = ops[j];
      if (m.k !== 'move' || m.travel || m.e <= 0 || !features.has(m.feature)) break;
      const p = pts[pts.length - 1];
      len += Math.hypot(m.x - p.x, m.y - p.y);
      eSum += m.e;
      pts.push({ x: m.x, y: m.y }); feat.push(m.feature); f.push(m.f); e.push(m.e);
      z = Math.max(z, m.z);
      j++;
    }
    const a = pts[0], b = pts[pts.length - 1];
    // closed: ends meet, or nearly meet on a long loop (a seam tucked inside the wall leaves a ~1 mm gap)
    const gap = Math.hypot(a.x - b.x, a.y - b.y);
    const closed = pts.length > 3 && len > 1 && (gap < Math.max(0.1, 1.5 * op.w) || (gap < 2.5 && len > 30 * gap));
    out.push({ start: i, end: j, pts, feat, f, e, z, w: op.w, h: op.h, ePerMm: len > 0 ? eSum / len : 0, closed });
    last = { x: b.x, y: b.y };
    i = j;
  }
  return out;
}

/**
 * Nearest point on a layer's closed loops (2 mm grid of short segments), with its u: inner walls and cut
 * or open runs take the u of the outer wall next to them.
 */
export class LoopLocator {
  private cells = new Map<string, number[]>();
  private seg: { ax: number; ay: number; bx: number; by: number; u0: number; u1: number; loop: number }[] = [];
  constructor(loops: { pts: Pt[]; u: ArrayLike<number> }[]) {
    loops.forEach((l, li) => {
      const n = l.pts.length;
      for (let i = 0; i < n; i++) {
        const a = l.pts[i], b = l.pts[(i + 1) % n], len = Math.hypot(b.x - a.x, b.y - a.y);
        let u1 = l.u[(i + 1) % n];
        if (u1 - l.u[i] > 0.5) u1 -= 1; else if (u1 - l.u[i] < -0.5) u1 += 1;
        const m = Math.max(1, Math.ceil(len / 1));
        for (let k = 0; k < m; k++) {
          const t0 = k / m, t1 = (k + 1) / m;
          const s = { ax: a.x + (b.x - a.x) * t0, ay: a.y + (b.y - a.y) * t0, bx: a.x + (b.x - a.x) * t1, by: a.y + (b.y - a.y) * t1, u0: l.u[i] + (u1 - l.u[i]) * t0, u1: l.u[i] + (u1 - l.u[i]) * t1, loop: li };
          const id = this.seg.length;
          this.seg.push(s);
          const key = `${Math.floor((s.ax + s.bx) / 4)},${Math.floor((s.ay + s.by) / 4)}`;
          const c = this.cells.get(key); if (c) c.push(id); else this.cells.set(key, [id]);
        }
      }
    });
  }
  at(p: Pt): { u: number; loop: number } | null {
    const gx = Math.floor(p.x / 2), gy = Math.floor(p.y / 2);
    let best: { u: number; loop: number } | null = null, bd = Infinity;
    // rings of cells until something is found, plus one more ring (a nearer segment may sit next door)
    for (let r = 0, stop = 4; r <= stop; r++) {
      for (let i = gx - r; i <= gx + r; i++) for (let j = gy - r; j <= gy + r; j++) {
        if (Math.max(Math.abs(i - gx), Math.abs(j - gy)) !== r) continue;
        for (const id of this.cells.get(`${i},${j}`) ?? []) {
          const s = this.seg[id], dx = s.bx - s.ax, dy = s.by - s.ay, l2 = dx * dx + dy * dy;
          const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - s.ax) * dx + (p.y - s.ay) * dy) / l2)) : 0;
          const d = (s.ax + dx * t - p.x) ** 2 + (s.ay + dy * t - p.y) ** 2;
          if (d < bd) { bd = d; let u = s.u0 + (s.u1 - s.u0) * t; u -= Math.floor(u); best = { u, loop: s.loop }; }
        }
      }
      if (best && stop === 4) stop = r + 1;
    }
    return best;
  }
}

/** Signed area of a closed polyline. + = counter-clockwise. */
export function signedArea(p: Pt[]): number {
  let a = 0;
  for (let i = 0; i < p.length; i++) { const q = p[(i + 1) % p.length], c = p[i]; a += c.x * q.y - q.x * c.y; }
  return a / 2;
}

export function pointInPoly(p: Pt, poly: Pt[]): boolean {
  let r = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) r = !r;
  }
  return r;
}

export const perimeter = (p: Pt[]) => p.reduce((s, q, i) => s + Math.hypot(p[(i + 1) % p.length].x - q.x, p[(i + 1) % p.length].y - q.y), 0);

/** Closed loops that are not inside a bigger loop of the same layer (holes of a tube are left out). */
export function outermostLoops<T extends { pts: Pt[] }>(loops: T[]): T[] {
  const area = loops.map((l) => Math.abs(signedArea(l.pts)));
  return loops.filter((l, i) => !loops.some((o, k) => k !== i && area[k] > area[i] && pointInPoly(l.pts[0], o.pts)));
}

/**
 * Where each point of a closed loop sits round the part: u (0..1) by distance along the loop, from the
 * point nearest the +X direction of the loop's centre, counter-clockwise whichever way the loop runs.
 * Same convention as the weave, so pictures line up from layer to layer and between modes.
 */
export function loopFractions(pts: Pt[]): { u: Float64Array; length: number; cx: number; cy: number; ccw: boolean } {
  const n = pts.length;
  const s = new Float64Array(n);
  let L = 0;
  for (let i = 0; i < n; i++) { s[i] = L; const q = pts[(i + 1) % n]; L += Math.hypot(q.x - pts[i].x, q.y - pts[i].y); }
  let cx = 0, cy = 0, wsum = 0;
  // centre by length-weighted midpoints: uneven point spacing doesn't pull it
  for (let i = 0; i < n; i++) {
    const q = pts[(i + 1) % n], l = Math.hypot(q.x - pts[i].x, q.y - pts[i].y);
    cx += ((pts[i].x + q.x) / 2) * l; cy += ((pts[i].y + q.y) / 2) * l; wsum += l;
  }
  cx /= wsum || 1; cy /= wsum || 1;
  let i0 = 0, best = Infinity;
  for (let i = 0; i < n; i++) { const a = Math.abs(Math.atan2(pts[i].y - cy, pts[i].x - cx)); if (a < best) { best = a; i0 = i; } }
  const ccw = signedArea(pts) >= 0;
  const u = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let f = L > 0 ? (s[i] - s[i0]) / L : 0;
    f -= Math.floor(f);
    u[i] = ccw ? f : (1 - f) % 1;
  }
  return { u, length: L, cx, cy, ccw };
}

/**
 * Distance up the wall for each layer inside [zStart, zEnd] (NaN outside), measured along the wall's
 * profile when followCurve is on (height and change of radius from the loop length), and the band total.
 */
export function wallHeights(layerZ: number[], perimeters: number[], zStart: number, zEnd: number, followCurve: boolean): { s: Float64Array; total: number; first: number; last: number } {
  const N = layerZ.length, s = new Float64Array(N).fill(NaN);
  let prevZ = NaN, prevR = NaN, acc = 0, first = -1, last = -1;
  for (let i = 0; i < N; i++) {
    const z = layerZ[i];
    if (z < zStart - 1e-6 || z > zEnd + 1e-6) continue;
    const r = Number.isFinite(perimeters[i]) && perimeters[i] > 0 ? perimeters[i] / (2 * Math.PI) : NaN;
    if (first >= 0) {
      const dz = z - prevZ, dr = followCurve && Number.isFinite(r) && Number.isFinite(prevR) ? r - prevR : 0;
      acc += Math.hypot(dz, dr);
    } else first = i;
    s[i] = acc;
    prevZ = z;
    if (Number.isFinite(r)) prevR = r;
    last = i;
  }
  return { s, total: acc, first, last };
}

/** Where the head ends a layer (its last move), or null when the layer has no move. */
export function layerEnd(L: LayerOps): (Pt & { z: number }) | null {
  for (let k = L.ops.length - 1; k >= 0; k--) { const op = L.ops[k]; if (op.k === 'raw' && op.resetPos) return null; if (op.k === 'move') return { x: op.x, y: op.y, z: op.z }; }
  return null;
}

/** Picture row and column for a point: rows by distance up the band, columns round the part. */
export interface BandMap {
  /** Picture rows counted from the bottom of the band (may exceed the picture height when tiling). */
  rowFromBottom(sMm: number): number;
}

export function bandRows(total: number, imageH: number, fit: 'stretch' | 'tile', rowMm: number): BandMap {
  return {
    rowFromBottom(sMm) {
      if (fit === 'tile') return Math.floor(sMm / Math.max(1e-3, rowMm) + 1e-6);
      return total <= 0 ? 0 : Math.min(imageH - 1, Math.floor((sMm / total) * imageH * (1 - 1e-9)));
    },
  };
}

export const round4 = (v: number) => Math.round(v * 1e4) / 1e4;
export const round5 = (v: number) => Math.round(v * 1e5) / 1e5;
