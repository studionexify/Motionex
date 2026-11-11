// Inner walls that follow a moved outer wall the way a slicer builds walls: each inner wall is the
// moved outer wall offset inwards by its own distance, not a shifted copy of it.
//
// A shifted copy keeps its distance only where the wall runs straight; on the slopes of a wave the
// true gap shrinks to distance × cos(slope), so the copy prints into the outer wall. A slicer avoids
// this by offsetting polygons (every point of the result is exactly that far from the outline), and
// so does this pass. Where the outer wall moves outwards the inner walls follow by at most `cap`, so a
// tall bump does not drag them away from the infill.
import { intersection, offset, union, SCALE } from "../../../engine/clipper";
import type { Path, Paths } from "../../../engine/types";
import { SEAM_TOL, type Layer, type ToolpathPoint } from "./types";

const OUTER = new Set(["outer_wall", "overhang_wall"]);
const toPath = (pts: { x: number; y: number }[]): Path => pts.map((q) => ({ X: Math.round(q.x * SCALE), Y: Math.round(q.y * SCALE) }));
const near = (a: { x: number; y: number }, b: { x: number; y: number }, tol: number) => Math.hypot(a.x - b.x, a.y - b.y) <= tol;
const signedArea = (pts: { x: number; y: number }[]) => { let s = 0; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) s += (pts[j].x - pts[i].x) * (pts[j].y + pts[i].y); return s / 2; };

interface Loop { now: ToolpathPoint[]; base: ToolpathPoint[]; moved: boolean }

/** Outer-wall loops of a layer: closed paths, or runs of pieces (outer and overhang parts) that join end to end. */
export function outerLoops(layer: Layer): Loop[] {
  const loops: Loop[] = [];
  let cur: Loop | null = null;
  const close = () => {
    if (cur && cur.now.length > 3 && near(cur.now[0], cur.now[cur.now.length - 1], SEAM_TOL) && near(cur.base[0], cur.base[cur.base.length - 1], SEAM_TOL)) loops.push(cur);
    cur = null;
  };
  for (const p of layer.paths) {
    if (!OUTER.has(p.feature) || p.follows || p.points.length < 2) { close(); continue; }
    const now = p.points, base = p.base ?? p.points, moved = p.modifiedBy === "motionex";
    if (cur && near(cur.now[cur.now.length - 1], now[0], 0.05) && near(cur.base[cur.base.length - 1], base[0], 0.05)) {
      cur.now.push(...now.slice(1)); cur.base.push(...base.slice(1)); cur.moved ||= moved;
    } else { close(); cur = { now: [...now], base: [...base], moved }; }
    if (near(cur.now[0], cur.now[cur.now.length - 1], SEAM_TOL) && cur.now.length > 3) close();
  }
  close();
  return loops;
}

/** Distance from a point to a polyline set, through a grid of segments. */
function segmentIndex(lines: { x: number; y: number }[][], cell: number) {
  const segs: number[] = [];
  const grid = new Map<string, number[]>();
  for (const l of lines) for (let i = 1; i < l.length; i++) {
    const k = segs.length;
    segs.push(l[i - 1].x, l[i - 1].y, l[i].x, l[i].y);
    const x0 = Math.floor(Math.min(l[i - 1].x, l[i].x) / cell), x1 = Math.floor(Math.max(l[i - 1].x, l[i].x) / cell);
    const y0 = Math.floor(Math.min(l[i - 1].y, l[i].y) / cell), y1 = Math.floor(Math.max(l[i - 1].y, l[i].y) / cell);
    for (let gx = x0; gx <= x1; gx++) for (let gy = y0; gy <= y1; gy++) { const g = `${gx}|${gy}`; const a = grid.get(g); if (a) a.push(k); else grid.set(g, [k]); }
  }
  return (x: number, y: number, rings = 2) => {
    const gx = Math.floor(x / cell), gy = Math.floor(y / cell);
    let best = Infinity;
    for (let ix = gx - rings; ix <= gx + rings; ix++) for (let iy = gy - rings; iy <= gy + rings; iy++) {
      for (const k of grid.get(`${ix}|${iy}`) ?? []) {
        const ax = segs[k], ay = segs[k + 1], dx = segs[k + 2] - ax, dy = segs[k + 3] - ay, L2 = dx * dx + dy * dy || 1;
        const u = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2));
        best = Math.min(best, Math.hypot(x - ax - u * dx, y - ay - u * dy));
      }
    }
    return best;
  };
}

/**
 * Rebuild the closed inner walls of a layer as offsets of the moved outer walls.
 * cap: how far (mm) an inner wall may move outwards from where the slicer put it.
 * Returns how many inner walls changed.
 */
export function offsetInnerWalls(layer: Layer, cap: number): number {
  const loops = outerLoops(layer);
  if (!loops.some((l) => l.moved)) return 0;
  const movedRegion = union(loops.map((l) => toPath(l.now)));
  const baseLines = loops.map((l) => l.base);
  const cell = 1;
  const distToBase = segmentIndex(baseLines, cell);
  const distToMoved = segmentIndex(loops.filter((l) => l.moved).map((l) => l.now), cell);
  // inner walls that may need to follow: closed, slicer-made, and within reach of a moved wall
  interface Inner { k: number; d: number; pts: ToolpathPoint[] }
  const inners: Inner[] = [];
  layer.paths.forEach((p, k) => {
    if (p.feature !== "inner_wall" || p.modifiedBy === "motionex" || p.points.length < 4) return;
    if (!near(p.points[0], p.points[p.points.length - 1], SEAM_TOL)) return;
    // its distance from the slicer's outer wall: the median over a few points
    const ds: number[] = [];
    const step = Math.max(1, Math.floor(p.points.length / 9));
    for (let i = 0; i < p.points.length; i += step) ds.push(distToBase(p.points[i].x, p.points[i].y, 4));
    ds.sort((a, b) => a - b);
    const d = ds[ds.length >> 1];
    if (!Number.isFinite(d)) return;
    // only near a moved wall (how far the wall moved is unknown here, so be generous)
    if (!p.points.some((q) => distToMoved(q.x, q.y, 6) < d + cap + 6)) return;
    inners.push({ k, d: Math.round(d * 200) / 200, pts: p.points });
  });
  if (!inners.length) return 0;
  const byLevel = new Map<number, Inner[]>();
  for (const i of inners) { const l = byLevel.get(i.d); if (l) l.push(i); else byLevel.set(i.d, [i]); }
  let changed = 0;
  for (const [d, group] of byLevel) {
    // where the wall would be if the slicer had walled the moved outline, kept within cap of where it was
    const follow = offset(movedRegion, -d);
    const allowed = offset(union(group.map((g) => toPath(g.pts))), cap);
    const result: Paths = intersection(follow, allowed).filter((p) => p.length >= 3);
    const newLoops = result.map((p) => p.map((q) => ({ x: q.X / SCALE, y: q.Y / SCALE })));
    // hand each new loop to the old wall it came from: the one nearest to most of its points
    const owner = newLoops.map((nl) => {
      const votes = new Map<number, number>();
      const step = Math.max(1, Math.floor(nl.length / 7));
      for (let i = 0; i < nl.length; i += step) {
        let best = -1, bd = Infinity;
        group.forEach((g, gi) => { for (const q of g.pts) { const dd = (q.x - nl[i].x) ** 2 + (q.y - nl[i].y) ** 2; if (dd < bd) { bd = dd; best = gi; } } });
        votes.set(best, (votes.get(best) ?? 0) + 1);
      }
      return [...votes].sort((a, b) => b[1] - a[1])[0][0];
    });
    group.forEach((g, gi) => {
      const mine = newLoops.filter((_, li) => owner[li] === gi);
      if (!mine.length) return; // nothing to follow: leave it, the overlap pass cuts it if it must
      const orig = g.pts, ccw = signedArea(orig) > 0;
      const tmpl = orig[1] ?? orig[0];
      const pts: ToolpathPoint[] = [];
      let from: { x: number; y: number } = orig[0];
      // nearest loops first, each starting at its point closest to where the last one ended (the seam)
      const todo = mine.map((l) => (signedArea(l) > 0 === ccw ? l : [...l].reverse()));
      while (todo.length) {
        let li = 0, si = 0, bd = Infinity;
        todo.forEach((l, a) => l.forEach((q, b) => { const dd = (q.x - from.x) ** 2 + (q.y - from.y) ** 2; if (dd < bd) { bd = dd; li = a; si = b; } }));
        const l = todo.splice(li, 1)[0];
        const ring = [...l.slice(si), ...l.slice(0, si), l[si]];
        ring.forEach((q, i) => {
          const p: ToolpathPoint = { x: q.x, y: q.y, z: orig[0].z, f: tmpl.f, flow: 1, e: 0, ...(tmpl.w !== undefined ? { w: tmpl.w } : {}) };
          if (i === 0 && pts.length) p.travel = true;
          pts.push(p);
        });
        from = ring[ring.length - 1];
      }
      // unchanged within a few microns: keep the slicer's own line
      const toOrig = segmentIndex([orig], cell), toNew = segmentIndex([pts], cell);
      const same = pts.every((q) => toOrig(q.x, q.y) < 0.005) && orig.every((q) => toNew(q.x, q.y) < 0.005);
      if (same) return;
      layer.paths[g.k] = { ...layer.paths[g.k], points: pts, modifiedBy: "motionex", follows: true, base: layer.paths[g.k].base ?? orig };
      changed++;
    });
  }
  return changed;
}
