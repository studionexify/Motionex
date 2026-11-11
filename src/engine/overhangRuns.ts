// Overhang line-type smoothing shared by both slicing engines.
import type { FeatureType } from './types';

/**
 * Overhang classes along a wall flicker where the wall runs almost exactly along the lower layer's edge
 * (spheres, domes, gentle slopes): the line type, speed and fan switch every millimetre, and each switch is a
 * pressure change that prints as a bump. Runs of one class shorter than `minRun` mm are merged into the longer
 * neighbouring run (on a tie, the slower one), so a wall changes class only where the overhang really changes.
 * Segment k (1..n-1) runs from point k-1 to point k; index 0 is unused.
 */
export function smoothOverhangRuns(pts: number[], closed: boolean, feats: FeatureType[], speeds: number[], fans: number[], minRun: number) {
  const n = pts.length / 2;
  if (n < 3) return;
  type Run = { a: number; b: number; len: number; f: FeatureType; s: number; fan: number };
  const runs: Run[] = [];
  for (let k = 1; k < n; k++) {
    const len = Math.hypot(pts[k * 2] - pts[k * 2 - 2], pts[k * 2 + 1] - pts[k * 2 - 1]);
    const r = runs[runs.length - 1];
    if (r && r.f === feats[k] && r.s === speeds[k] && r.fan === fans[k]) { r.b = k; r.len += len; }
    else runs.push({ a: k, b: k, len, f: feats[k], s: speeds[k], fan: fans[k] });
  }
  const same = (x: Run, y: Run) => x.f === y.f && x.s === y.s && x.fan === y.fan;
  // a closed loop's last and first runs are one run
  if (closed && runs.length > 1 && same(runs[0], runs[runs.length - 1])) { const last = runs.pop()!; runs[0].len += last.len; (runs[0] as Run & { wrap?: Run }).wrap = last; }
  const slower = (x: Run, y: Run) => (x.s > 0 ? x.s : Infinity) <= (y.s > 0 ? y.s : Infinity);
  for (let guard = 0; runs.length > 1 && guard < 10000; guard++) {
    let mi = -1;
    for (let r = 0; r < runs.length; r++) if (runs[r].len < minRun && (mi < 0 || runs[r].len < runs[mi].len)) mi = r;
    if (mi < 0) break;
    const m = runs.length;
    const pi = mi > 0 ? mi - 1 : closed ? m - 1 : -1, ni = mi < m - 1 ? mi + 1 : closed ? 0 : -1;
    const P = pi >= 0 && pi !== mi ? runs[pi] : null, Nx = ni >= 0 && ni !== mi ? runs[ni] : null;
    const to = !P ? Nx! : !Nx ? P : P.len > Nx.len ? P : Nx.len > P.len ? Nx : slower(P, Nx) ? P : Nx;
    const cur = runs[mi];
    cur.f = to.f; cur.s = to.s; cur.fan = to.fan;
    // merge equal neighbours
    for (let r = runs.length - 1; r >= 0 && runs.length > 1; r--) {
      const q = closed ? (r + 1) % runs.length : r + 1;
      if (q >= runs.length || q === r) continue;
      if (same(runs[r], runs[q])) {
        const keep = runs[r], gone = runs[q];
        keep.len += gone.len;
        (keep as Run & { parts?: Run[] }).parts = [...((keep as any).parts ?? []), gone, ...((gone as any).parts ?? [])];
        if ((gone as any).wrap) (keep as any).parts.push((gone as any).wrap);
        runs.splice(q, 1);
      }
    }
  }
  // write back: every original segment range takes its (merged) run's class
  const paint = (r: Run, c: Run) => { for (let k = r.a; k <= r.b; k++) { feats[k] = c.f; speeds[k] = c.s; fans[k] = c.fan; } };
  for (const r of runs) {
    paint(r, r);
    if ((r as any).wrap) paint((r as any).wrap, r);
    for (const q of (r as any).parts ?? []) { paint(q, r); if (q.wrap) paint(q.wrap, r); }
  }
}
