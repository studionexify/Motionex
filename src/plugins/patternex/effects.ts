// Patternex engine helpers beyond colour: two-filament dithering, band merging for single-colour printers,
// purge into infill / a sacrificial object (move reordering) and per-region speed / fuzzy skin.
import ClipperLib from 'clipper-lib';
import type { Op } from '../../engine/gcode';
import { difference, intersection, SCALE } from '../../engine/clipper';
import type { Paths } from '../../engine/types';

const C: any = (ClipperLib as any).default ?? ClipperLib;
type Move = Extract<Op, { k: 'move' }>;

// ---------- dithering
/** Even (Bresenham) spread: is step k one of the `ratio` share? Exactly round(n·ratio) of any n consecutive steps. */
export const ditherPick = (k: number, ratio: number) => {
  const r = Math.max(0, Math.min(1, ratio));
  return Math.floor((k + 1) * r + 1e-9) - Math.floor(k * r + 1e-9) === 1;
};

/**
 * Line dithering: split region paths into stripes one line wide; the `ratio` share goes to filament B.
 * Stripes run along X and shift by half a stripe every layer, so B lines sit between A lines of the layer below.
 */
export function ditherStripes(paths: Paths, layer: number, lineW: number, ratio: number): { a: Paths; b: Paths } {
  if (!paths.length) return { a: [], b: [] };
  let y0 = Infinity, y1 = -Infinity, x0 = Infinity, x1 = -Infinity;
  for (const p of paths) for (const q of p) { y0 = Math.min(y0, q.Y); y1 = Math.max(y1, q.Y); x0 = Math.min(x0, q.X); x1 = Math.max(x1, q.X); }
  const w = Math.max(1, Math.round(lineW * SCALE));
  const phase = layer % 2 ? Math.round(w / 2) : 0;
  const stripes: Paths = [];
  const k0 = Math.floor((y0 - phase) / w);
  for (let k = k0; k * w + phase <= y1; k++) {
    if (!ditherPick(((k % 1e6) + 1e6) % 1e6, ratio)) continue;
    const ya = k * w + phase, yb = ya + w;
    stripes.push([{ X: x0 - w, Y: ya }, { X: x1 + w, Y: ya }, { X: x1 + w, Y: yb }, { X: x0 - w, Y: yb }]);
  }
  const b = intersection(paths, stripes);
  return { a: difference(paths, stripes), b };
}

// ---------- single-colour band merging
/**
 * Swap optimiser for single-colour printers. `seq[i]` is the ink of layer i (−1 = base material).
 * A run of base layers shorter than `minGap` between two runs of the same ink is printed in that ink too:
 * each merge removes two manual swaps. Ink runs are never dropped (that would lose artwork).
 */
export function mergeBands(seq: number[], minGap: number): { seq: number[]; merged: number; swapsBefore: number; swapsAfter: number } {
  const out = seq.slice();
  let merged = 0;
  if (minGap > 0) {
    let i = 0;
    while (i < out.length) {
      if (out[i] !== -1) { i++; continue; }
      let j = i; while (j < out.length && out[j] === -1) j++;
      const before = i > 0 ? out[i - 1] : -1, after = j < out.length ? out[j] : -1;
      if (before !== -1 && before === after && j - i < minGap) { for (let k = i; k < j; k++) out[k] = before; merged++; }
      i = j;
    }
  }
  return { seq: out, merged, swapsBefore: countChanges(seq), swapsAfter: countChanges(out) };
}
/** Material changes along a layer sequence, starting from the base material. */
export function countChanges(seq: number[]): number {
  let n = 0, cur = -1;
  for (const v of seq) if (v !== cur) { n++; cur = v; }
  return n;
}

// ---------- purge into infill / a sacrificial object
const isTravel = (op: Op) => op.k === 'move' && op.travel;

/** Retraction state after ops[0..i) (true = retracted), given the state at the start. */
function retractedAt(ops: Op[], i: number, start: boolean, afterReset = start): boolean {
  let r = start;
  for (let k = 0; k < i; k++) { const op = ops[k]; if (op.k === 'retract') r = op.len > 0; else if ((op.k === 'raw' && op.resetPos) || op.k === 'tool') r = afterReset; }
  return r;
}

export interface Chunk { from: number; to: number }

/** Chunks after a tool op: from a travel move up to the next travel / tool / raw op (exclusive). */
export function chunksAfter(ops: Op[], toolIdx: number): Chunk[] {
  const out: Chunk[] = [];
  let k = toolIdx + 1;
  while (k < ops.length && ops[k].k !== 'tool') {
    if (!isTravel(ops[k])) { k++; continue; }
    let j = k + 1;
    while (j < ops.length && !isTravel(ops[j]) && ops[j].k !== 'tool' && ops[j].k !== 'raw') j++;
    // a retraction right before the next travel belongs to that travel, not to this chunk
    let end = j;
    while (end > k + 1 && ops[end - 1].k === 'retract' && (ops[end - 1] as { len: number }).len > 0) end--;
    out.push({ from: k, to: end });
    k = j;
  }
  return out;
}

/**
 * Move the chunks picked by `take` to right after ops[toolIdx], fixing retraction state at both ends so the
 * extruder stays balanced. Returns the filament length (mm of E) moved, which absorbs the colour change.
 */
export function purgeFirst(ops: Op[], toolIdx: number, take: (moves: Move[]) => boolean, retract: { len: number; speed: number; deretractSpeed: number; /** Nozzle retracted after a filament change macro (AMS). */ afterChange: boolean }, maxE = Infinity): number {
  const chunks = chunksAfter(ops, toolIdx);
  // retraction state is tracked from the start of the layer; tool changes leave the nozzle retracted on AMS
  const startState = false;
  const picked: Chunk[] = [];
  let e = 0;
  for (const c of chunks) {
    if (e >= maxE) break;
    const ms = ops.slice(c.from, c.to).filter((op): op is Move => op.k === 'move' && !op.travel && op.e > 0);
    if (!ms.length || !take(ms)) continue;
    picked.push(c);
    e += ms.reduce((a, m) => a + m.e, 0);
  }
  if (!picked.length) return 0;
  const fix = (a: boolean, b: boolean): Op[] => (a === b ? [] : a ? [{ k: 'retract', len: -retract.len, speed: retract.deretractSpeed }] : [{ k: 'retract', len: retract.len, speed: retract.speed }]);
  // cut from the back so earlier indices stay valid; patch each hole so the state after it is unchanged
  const blocks: { ops: Op[]; sIn: boolean; sOut: boolean }[] = [];
  for (const c of [...picked].reverse()) {
    const sIn = retractedAt(ops, c.from, startState, retract.afterChange), sOut = retractedAt(ops, c.to, startState, retract.afterChange);
    blocks.unshift({ ops: ops.slice(c.from, c.to), sIn, sOut });
    ops.splice(c.from, c.to - c.from, ...fix(sIn, sOut));
  }
  const at = toolIdx + 1;
  const sAt = retractedAt(ops, at, startState, retract.afterChange);
  const ins: Op[] = [];
  let st = sAt;
  for (const b of blocks) { ins.push(...fix(st, b.sIn), ...b.ops); st = b.sOut; }
  ins.push(...fix(st, sAt));
  ops.splice(at, 0, ...ins);
  return e;
}

// ---------- per-region speed and fuzzy skin
export function inPaths(paths: Paths, x: number, y: number): boolean {
  const p = { X: Math.round(x * SCALE), Y: Math.round(y * SCALE) };
  let inside = false;
  for (const path of paths) {
    const r = C.Clipper.PointInPolygon(p, path);
    if (r !== 0) inside = !inside;
  }
  return inside;
}

/** Split an extrusion into ~dist mm pieces whose ends are pushed sideways by up to ±thick (fuzzy skin). */
export function fuzzMove(m: Move, from: [number, number], thick: number, dist: number, rnd: () => number): Move[] {
  const dx = m.x - from[0], dy = m.y - from[1], len = Math.hypot(dx, dy);
  if (len < dist * 1.5) return [m];
  const n = Math.round(len / dist), nx = -dy / len, ny = dx / len;
  const out: Move[] = [];
  for (let k = 1; k <= n; k++) {
    const t = k / n, j = k === n ? 0 : (rnd() * 2 - 1) * thick;
    out.push({ ...m, x: from[0] + dx * t + nx * j, y: from[1] + dy * t + ny * j, e: m.e / n, t: undefined, noArc: true });
  }
  return out;
}
