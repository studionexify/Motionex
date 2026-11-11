// Stage 8: path ordering (greedy nearest-neighbour TSP) & seam placement.
import type { Polyline2 } from './types';

export type SeamMode = 'nearest' | 'aligned' | 'aligned_back' | 'back' | 'random';

/** Rotate a closed loop so it starts at vertex `i`. */
export function rotateLoop(pts: number[], i: number): number[] {
  if (i === 0) return pts;
  return [...pts.slice(i * 2), ...pts.slice(0, i * 2)];
}

export interface SeamHints { enforce: [number, number][]; block: [number, number][] }

export function pickSeam(pts: number[], mode: SeamMode, px: number, py: number, prev: [number, number] | null, rnd: () => number, hints?: SeamHints): number {
  const n = pts.length / 2;
  const back = mode === 'aligned_back' && !!prev;
  // painted seam enforcers win when close to this loop
  if (hints?.enforce.length) {
    let bi = -1, bd = 2.25; // within 1.5 mm
    for (let i = 0; i < n; i++) for (const [ex, ey] of hints.enforce) {
      const d = (pts[i * 2] - ex) ** 2 + (pts[i * 2 + 1] - ey) ** 2;
      if (d < bd) { bd = d; bi = i; }
    }
    if (bi >= 0) return bi;
  }
  const blocked = (i: number) => !!hints?.block.some(([bx, by]) => (pts[i * 2] - bx) ** 2 + (pts[i * 2 + 1] - by) ** 2 < 4);
  if (mode === 'random') {
    for (let k = 0; k < 20; k++) { const i = Math.floor(rnd() * n); if (!blocked(i)) return i; }
    return Math.floor(rnd() * n);
  }
  // aligned back (OrcaSlicer spAlignedBack): aligned seams that start at the back and keep to it
  if (mode === 'aligned_back') mode = prev ? 'aligned' : 'back';
  let best = 0, bestScore = Infinity;
  const tx = mode === 'aligned' && prev ? prev[0] : px;
  const ty = mode === 'aligned' && prev ? prev[1] : py;
  let maxY = -Infinity;
  if (back) for (let i = 0; i < n; i++) maxY = Math.max(maxY, pts[i * 2 + 1]);
  for (let i = 0; i < n; i++) {
    const x = pts[i * 2], y = pts[i * 2 + 1];
    let score: number;
    if (mode === 'back') score = -y + 0.01 * Math.abs(x - tx);
    else score = (x - tx) ** 2 + (y - ty) ** 2 + (back ? (maxY - y) * 0.5 : 0);
    // prefer concave/sharp corners slightly: hides the seam
    const ax = pts[((i - 1 + n) % n) * 2] - x, ay = pts[((i - 1 + n) % n) * 2 + 1] - y;
    const bx = pts[((i + 1) % n) * 2] - x, by = pts[((i + 1) % n) * 2 + 1] - y;
    const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
    if (la > 0 && lb > 0) {
      const cos = (ax * bx + ay * by) / (la * lb);
      if (cos > -0.5) score -= mode === 'back' ? 2 : 4; // corner sharper than 120°
    }
    if (hints?.block.length && blocked(i)) score += 1e9;
    if (score < bestScore) { bestScore = score; best = i; }
  }
  return best;
}

/** Greedy nearest-neighbour ordering; open paths may be reversed. */
export function orderPaths<T extends Polyline2>(paths: T[], sx: number, sy: number): { paths: T[]; x: number; y: number } {
  const left = paths.slice();
  const out: T[] = [];
  let x = sx, y = sy;
  while (left.length) {
    let bi = 0, bd = Infinity, brev = false;
    for (let i = 0; i < left.length; i++) {
      const p = left[i].pts;
      const d0 = (p[0] - x) ** 2 + (p[1] - y) ** 2;
      if (d0 < bd) { bd = d0; bi = i; brev = false; }
      if (!left[i].closed) {
        const n = p.length;
        const d1 = (p[n - 2] - x) ** 2 + (p[n - 1] - y) ** 2;
        if (d1 < bd) { bd = d1; bi = i; brev = true; }
      }
    }
    const p = left.splice(bi, 1)[0];
    if (brev) {
      const r: number[] = [];
      for (let i = p.pts.length - 2; i >= 0; i -= 2) r.push(p.pts[i], p.pts[i + 1]);
      p.pts = r;
      const w = (p as { widths?: number[] }).widths;
      if (w) (p as { widths?: number[] }).widths = w.slice().reverse();
    }
    out.push(p);
    const n = p.pts.length;
    if (p.closed) { x = p.pts[0]; y = p.pts[1]; } else { x = p.pts[n - 2]; y = p.pts[n - 1]; }
  }
  return { paths: out, x, y };
}

/** Douglas–Peucker simplification on a flat xy array. */
export function simplify(pts: number[], tol: number, closed: boolean): number[] {
  const n = pts.length / 2;
  if (n < 3 || tol <= 0) return pts;
  const keep = new Uint8Array(n);
  keep[0] = 1; keep[n - 1] = 1;
  const stack: [number, number][] = [[0, n - 1]];
  const t2 = tol * tol;
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const ax = pts[a * 2], ay = pts[a * 2 + 1], bx = pts[b * 2], by = pts[b * 2 + 1];
    const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
    let md = -1, mi = -1;
    for (let i = a + 1; i < b; i++) {
      const px = pts[i * 2] - ax, py = pts[i * 2 + 1] - ay;
      let d: number;
      if (L === 0) d = px * px + py * py;
      else { const c = px * dy - py * dx; d = (c * c) / L; }
      if (d > md) { md = d; mi = i; }
    }
    if (md > t2) { keep[mi] = 1; stack.push([a, mi], [mi, b]); }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[i * 2], pts[i * 2 + 1]);
  return closed && out.length < 6 ? pts : out;
}
