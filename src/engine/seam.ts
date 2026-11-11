// Seam treatments for closed wall loops: scarf joint seam and seam gap.
// A loop arrives already rotated so it starts at the seam point.

/** Length of a closed loop (flat xy). */
export function loopLength(pts: number[]): number {
  const n = pts.length / 2;
  let L = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    L += Math.hypot(pts[j * 2] - pts[i * 2], pts[j * 2 + 1] - pts[i * 2 + 1]);
  }
  return L;
}

/** True when every corner of the loop is wider than `thresholdDeg` (180° = straight), i.e. no corner can hide a seam. */
export function isSmoothLoop(pts: number[], thresholdDeg: number): boolean {
  const n = pts.length / 2;
  if (n < 3) return false;
  const cosT = Math.cos((thresholdDeg * Math.PI) / 180);
  for (let i = 0; i < n; i++) {
    const p = (i - 1 + n) % n, q = (i + 1) % n;
    const ax = pts[p * 2] - pts[i * 2], ay = pts[p * 2 + 1] - pts[i * 2 + 1];
    const bx = pts[q * 2] - pts[i * 2], by = pts[q * 2 + 1] - pts[i * 2 + 1];
    const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
    if (la < 1e-6 || lb < 1e-6) continue;
    // interior angle between the two edges at this vertex: cos > cos(threshold) means sharper than the threshold
    if ((ax * bx + ay * by) / (la * lb) > cosT) return false;
  }
  return true;
}

/** Walk a closed loop from its start: positions at arc lengths `marks` (ascending, ≤ loop length) inserted as vertices. */
function walkWithMarks(pts: number[], marks: number[]): { x: number; y: number; s: number }[] {
  const n = pts.length / 2;
  const out: { x: number; y: number; s: number }[] = [{ x: pts[0], y: pts[1], s: 0 }];
  let s = 0, m = 0;
  while (m < marks.length && marks[m] <= 1e-9) m++;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = pts[i * 2], ay = pts[i * 2 + 1], bx = pts[j * 2], by = pts[j * 2 + 1];
    const len = Math.hypot(bx - ax, by - ay);
    while (m < marks.length && marks[m] < s + len - 1e-9) {
      const t = (marks[m] - s) / len;
      out.push({ x: ax + (bx - ax) * t, y: ay + (by - ay) * t, s: marks[m] });
      m++;
    }
    s += len;
    out.push({ x: bx, y: by, s });
  }
  return out;
}

export interface ScarfParams {
  /** Ramp length (mm); the loop length if the scarf goes around the entire wall. */
  length: number;
  /** Height the ramp starts at, as a fraction of the layer height (0..1). */
  startFrac: number;
  steps: number;
  /** The overlapping end stops this far before the end of the ramp (mm). */
  gap: number;
}

/**
 * Scarf joint: the loop starts low and thin, rising in `steps` steps to full height and flow over the ramp length;
 * after closing the loop it runs over the ramp again at full height with the complementary (falling) flow.
 * Returns an open polyline with, per point, the depth below the layer top (fraction of layer height) and the
 * flow multiplier of the segment that ends there.
 */
export function scarfLoop(pts: number[], p: ScarfParams): { pts: number[]; depth: number[]; flows: number[] } {
  const P = loopLength(pts);
  const L = Math.max(0.1, Math.min(p.length, P));
  const steps = Math.max(1, Math.round(p.steps));
  const f0 = Math.max(0, Math.min(1, p.startFrac));
  const fracAt = (s: number) => f0 + (1 - f0) * Math.min(1, Math.floor((s / L) * steps + 1e-9 + 1) / steps);
  const marks = Array.from({ length: steps }, (_, k) => (L * (k + 1)) / steps).filter((m) => m < P - 1e-6);
  const walk = walkWithMarks(pts, marks);
  const out: number[] = [], depth: number[] = [], flows: number[] = [];
  out.push(walk[0].x, walk[0].y); depth.push(1 - f0); flows.push(0);
  // the ramp up and the rest of the loop
  for (let k = 1; k < walk.length; k++) {
    const mid = (walk[k - 1].s + walk[k].s) / 2;
    const f = mid < L ? fracAt(mid) : 1;
    out.push(walk[k].x, walk[k].y);
    depth.push(mid < L ? 1 - f : 0);
    flows.push(f);
  }
  // the overlap: back over the ramp at full height with the complementary flow
  const end = Math.max(0, L - p.gap);
  for (let k = 1; k < walk.length && walk[k - 1].s < end - 1e-9; k++) {
    const s1 = Math.min(walk[k].s, end);
    const mid = (walk[k - 1].s + s1) / 2;
    const f = fracAt(mid);
    const t = walk[k].s > walk[k - 1].s ? (s1 - walk[k - 1].s) / (walk[k].s - walk[k - 1].s) : 1;
    out.push(walk[k - 1].x + (walk[k].x - walk[k - 1].x) * t, walk[k - 1].y + (walk[k].y - walk[k - 1].y) * t);
    depth.push(0);
    flows.push(Math.max(0, 1 - f)); // complementary flow: ramp + overlap add up to one full line
  }
  return { pts: out, depth, flows };
}

/** Seam gap: the closed loop as an open path that stops `gap` mm before its start point. */
export function seamGapLoop(pts: number[], gap: number): number[] {
  const P = loopLength(pts);
  if (gap <= 0 || gap >= P * 0.5) return [...pts, pts[0], pts[1]];
  const walk = walkWithMarks(pts, [P - gap]);
  const out: number[] = [];
  for (const w of walk) { if (w.s > P - gap + 1e-9) break; out.push(w.x, w.y); }
  return out;
}
