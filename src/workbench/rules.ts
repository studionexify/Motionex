// Body rules: the NexSpiro "Select & apply" editor for Motionex. The user selects parts of the piece
// with tools (line, segment, brush, box, lasso, band); each selection becomes a rule that changes the
// motion, speed, flow and temperature of the lines there. Selections are stored in piece space
// (height in mm, angle in turns) so they survive re-slicing and most shape edits.
import type { LayerEffect } from '../plugins/motionex/model';

/** A selected patch of the wall: design height z0..z1 (mm), angle a0..a1 in turns (a1 may exceed 1 to wrap). */
export interface Rect { z0: number; z1: number; a0: number; a1: number; neg?: boolean }

export interface Rule {
  id: string; name: string; enabled: boolean; color: string;
  rects: Rect[];
  reachUp: number; reachDown: number;          // extra layers above / below the selection
  lines: { outer: boolean; inner: boolean; base: boolean };
  wallShape: 'all' | 'curved' | 'straight';
  // change there
  brushId: string | null; size: number; spacing: number; phase: number;
  layers: LayerEffect | null; useBrushLayers: boolean;
  speed: number | null; flow: number | null; temp: number | null; // % / % / °C, null = keep as sliced
  soft: number;                                // soft edge, mm
}

export const RULE_COLORS = ['#e8467c', '#2f9be8', '#f2a31b', '#3fbf7f', '#9b5de5', '#00b8b8', '#e85d2f', '#7d8597'];

export function newRule(n: number): Rule {
  return {
    id: Math.random().toString(36).slice(2, 9), name: `Selection ${n}`, enabled: true, color: RULE_COLORS[(n - 1) % RULE_COLORS.length],
    rects: [], reachUp: 0, reachDown: 0, lines: { outer: true, inner: true, base: false }, wallShape: 'all',
    brushId: null, size: 1, spacing: 1, phase: 0, layers: null, useBrushLayers: true, speed: null, flow: null, temp: null, soft: 2,
  };
}

const smooth = (x: number) => (x <= 0 ? 1 : x >= 1 ? 0 : 1 - x * x * (3 - 2 * x));

/** Angular distance (turns) from a to the arc [a0,a1], wrap-aware. */
function arcDist(a: number, a0: number, a1: number) {
  if (a1 - a0 >= 1) return 0;
  const u = ((a - a0) % 1 + 1) % 1, span = a1 - a0;
  if (u <= span) return 0;
  return Math.min(u - span, 1 - u);
}

/** Rules prepared for one height: only the rects that can reach it. */
export interface PreparedRule { rule: Rule; pos: Rect[]; neg: Rect[]; lo: number; hi: number }

export function prepareRules(rules: Rule[], z: number, lh: number): PreparedRule[] {
  const out: PreparedRule[] = [];
  for (const rule of rules) {
    if (!rule.enabled || !rule.rects.length) continue;
    const lo = rule.reachDown * lh, hi = rule.reachUp * lh, m = rule.soft;
    const pos: Rect[] = [], neg: Rect[] = [];
    for (const r of rule.rects) if (z >= r.z0 - lo - m - 1e-6 && z <= r.z1 + hi + m + 1e-6) (r.neg ? neg : pos).push(r);
    if (pos.length) out.push({ rule, pos, neg, lo, hi });
  }
  return out;
}

/** Weight 0..1 of a prepared rule at piece height z, angle a (turns), radius r (mm). */
export function ruleWeight(p: PreparedRule, z: number, a: number, r: number): number {
  const soft = p.rule.soft, circ = Math.PI * 2 * Math.max(1, r);
  const w = (rects: Rect[], lo: number, hi: number) => {
    let best = 0;
    for (const q of rects) {
      const dz = z < q.z0 - lo ? q.z0 - lo - z : z > q.z1 + hi ? z - q.z1 - hi : 0;
      const da = arcDist(a, q.a0, q.a1) * circ;
      const d = Math.hypot(dz, da);
      const v = soft > 0 ? smooth(d / soft) : d <= 1e-6 ? 1 : 0;
      if (v > best) { best = v; if (best >= 1) break; }
    }
    return best;
  };
  let v = w(p.pos, p.lo, p.hi);
  if (v > 0 && p.neg.length) v *= 1 - w(p.neg, 0, 0);
  return v;
}

/** Merge per-row selected angle cells into rects (rows: z centre + half height, cells: boolean per column). */
export function rowsToRects(rows: { z: number; dz: number; cells: boolean[] }[], neg = false): Rect[] {
  const out: Rect[] = [];
  for (const row of rows) {
    const n = row.cells.length;
    let j = 0;
    while (j < n) {
      if (!row.cells[j]) { j++; continue; }
      let k = j; while (k + 1 < n && row.cells[k + 1]) k++;
      out.push({ z0: row.z - row.dz, z1: row.z + row.dz, a0: j / n, a1: (k + 1) / n, ...(neg ? { neg } : {}) });
      j = k + 1;
    }
  }
  // merge vertically identical runs to keep the list short
  out.sort((p, q) => p.a0 - q.a0 || p.a1 - q.a1 || p.z0 - q.z0);
  const merged: Rect[] = [];
  for (const r of out) {
    const m = merged[merged.length - 1];
    if (m && Math.abs(m.a0 - r.a0) < 1e-9 && Math.abs(m.a1 - r.a1) < 1e-9 && r.z0 <= m.z1 + 1e-6 && !!m.neg === !!r.neg) m.z1 = Math.max(m.z1, r.z1);
    else merged.push({ ...r });
  }
  return merged;
}
