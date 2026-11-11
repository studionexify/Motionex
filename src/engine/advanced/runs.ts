// Helpers for editing a layer's ordered move list: extrusion runs, positions, splitting and resampling.
import type { LayerOps, Op } from './classic/gcode';
import type { FeatureType } from '../types';

export type Move = Extract<Op, { k: 'move' }>;

export interface Run {
  /** Index of the first and last extrusion move of the run (inclusive). */
  start: number;
  end: number;
  feature: FeatureType;
  /** Nozzle position before the run's first move. */
  x0: number; y0: number; z0: number;
  /** The run ends where it started (a wall loop). */
  closed: boolean;
  length: number;
}

/** Consecutive extrusion moves of one feature, uninterrupted by travel, retraction or raw ops. */
export function runsOf(L: LayerOps): Run[] {
  const out: Run[] = [];
  let x = NaN, y = NaN, z = NaN;
  let cur: Run | null = null;
  const close = () => {
    if (!cur) return;
    const last = L.ops[cur.end] as Move;
    cur.closed = Math.hypot(last.x - cur.x0, last.y - cur.y0) < 0.01 && cur.end > cur.start + 1;
    out.push(cur);
    cur = null;
  };
  L.ops.forEach((op, i) => {
    if (op.k === 'raw' && op.resetPos) { close(); x = NaN; y = NaN; z = NaN; return; }
    if (op.k !== 'move') { if (op.k !== 'accel') close(); return; }
    if (op.travel || op.e <= 0) { close(); x = op.x; y = op.y; z = op.z; return; }
    if (cur && cur.feature === op.feature) {
      cur.end = i; cur.length += Math.hypot(op.x - x, op.y - y);
    } else {
      close();
      if (!Number.isNaN(x)) cur = { start: i, end: i, feature: op.feature, x0: x, y0: y, z0: z, closed: false, length: Math.hypot(op.x - x, op.y - y) };
    }
    x = op.x; y = op.y; z = op.z;
  });
  close();
  return out;
}

/** Points of a run (start position first), with cumulative arc length. */
export function runPoints(L: LayerOps, r: Run): { x: number[]; y: number[]; z: number[]; s: number[]; e: number; f: number; w: number; h: number } {
  const x = [r.x0], y = [r.y0], z = [(L.ops[r.start] as Move).z], s = [0];
  let e = 0;
  for (let i = r.start; i <= r.end; i++) {
    const m = L.ops[i];
    if (m.k !== 'move') continue;
    s.push(s[s.length - 1] + Math.hypot(m.x - x[x.length - 1], m.y - y[y.length - 1]));
    x.push(m.x); y.push(m.y); z.push(m.z);
    e += m.e;
  }
  const first = L.ops[r.start] as Move;
  return { x, y, z, s, e, f: first.f, w: first.w, h: first.h };
}

/** Position along a polyline at arc length t (clamped), with the local unit tangent. */
export function along(p: { x: number[]; y: number[]; z: number[]; s: number[] }, t: number): { x: number; y: number; z: number; tx: number; ty: number } {
  const n = p.s.length;
  const L = p.s[n - 1];
  t = Math.max(0, Math.min(L, t));
  let i = 1;
  while (i < n - 1 && p.s[i] < t) i++;
  const s0 = p.s[i - 1], s1 = p.s[i], u = s1 > s0 ? (t - s0) / (s1 - s0) : 0;
  const dx = p.x[i] - p.x[i - 1], dy = p.y[i] - p.y[i - 1], d = Math.hypot(dx, dy) || 1;
  return { x: p.x[i - 1] + dx * u, y: p.y[i - 1] + dy * u, z: p.z[i - 1] + (p.z[i] - p.z[i - 1]) * u, tx: dx / d, ty: dy / d };
}

/** Signed area of a closed point list (counter-clockwise > 0). */
export function signedArea(x: number[], y: number[]): number {
  let a = 0;
  for (let i = 0; i < x.length; i++) { const j = (i + 1) % x.length; a += x[i] * y[j] - x[j] * y[i]; }
  return a / 2;
}

/** Template move with the run's properties. */
export const moveLike = (m: Move, x: number, y: number, z: number, e: number, patch: Partial<Move> = {}): Move =>
  ({ ...m, x, y, z: +z.toFixed(4), e, t: undefined, noArc: true, ...patch });

/** Cross-section of a bead of width w and height h (rounded-edge model the slicer uses for E). */
export const beadArea = (w: number, h: number): number => (w > h ? (w - h) * h + Math.PI * (h / 2) ** 2 : w * h);
/** Continuous version of beadArea for rescaling: round at w == h (thick bridges), ellipse when taller than wide. */
const contArea = (w: number, h: number): number => (h <= w ? (w - h) * h + Math.PI * (h / 2) ** 2 : (Math.PI / 4) * w * h);
/** E of a bead whose height changes from h0 to h1 at the same width and 3-D length (volume ∝ cross-section). */
export const rescaleE = (e: number, w: number, h0: number, h1: number): number => (contArea(w, h0) > 0 ? (e * contArea(w, h1)) / contArea(w, h0) : e);

/** Inverse of beadArea at fixed height: the width whose bead has cross-section `area`. */
export const widthForArea = (area: number, h: number): number => (area >= Math.PI * (h / 2) ** 2 ? (area - Math.PI * (h / 2) ** 2) / h + h : area / h);
/** Declared geometry for a bead printed at `flow` x the nominal volume (a taper): same height, effective width. */
export const flowPatch = (m: { w: number; h: number }, flow: number): { w: number } =>
  ({ w: m.w > 0 && flow > 0 ? widthForArea(flow * beadArea(m.w, m.h), m.h) : m.w });
