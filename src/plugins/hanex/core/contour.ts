// Iso-contours of a grid field by marching squares, all levels kΔ at once.
// Every cell is visited once; it emits a segment for each level that crosses it, so the cost is
// proportional to grid size + output size rather than grid size × number of levels.
import type { Grid } from './fmm';
import type { Polyline, Vec2 } from './geom';

export interface Contour { level: number; k: number; pts: Polyline; closed: boolean }

// corner order: 0 (i,j)  1 (i+1,j)  2 (i+1,j+1)  3 (i,j+1);  edges: 0 = 0-1, 1 = 1-2, 2 = 3-2, 3 = 0-3
const EDGE_CORNERS: [number, number][] = [[0, 1], [1, 2], [3, 2], [0, 3]];
const CORNER_EDGES: [number, number][] = [[3, 0], [0, 1], [1, 2], [2, 3]];

/**
 * Extract contours at levels k·step for k = kMin..(max level present). Only cells whose four
 * corners are finite are used, so contours stop one cell inside the domain edge; callers clip them
 * to the printable region afterwards.
 */
export function isoContours(g: Grid, D: Float64Array, step: number, kMin = 1): Contour[] {
  const { nx, ny, h, x0, y0 } = g;
  // per level: flat segment list [edgeIdA, edgeIdB] and the edge-point coordinates
  const segs = new Map<number, number[]>();
  const pts = new Map<number, Map<number, Vec2>>();
  const eid = (i: number, j: number, e: number) =>
    e === 0 ? 2 * (j * nx + i) : e === 2 ? 2 * ((j + 1) * nx + i) : e === 3 ? 2 * (j * nx + i) + 1 : 2 * (j * nx + i + 1) + 1;
  const cx = [0, 1, 1, 0], cy = [0, 0, 1, 1];
  const v = [0, 0, 0, 0];
  for (let j = 0; j + 1 < ny; j++) {
    for (let i = 0; i + 1 < nx; i++) {
      v[0] = D[j * nx + i]; v[1] = D[j * nx + i + 1]; v[2] = D[(j + 1) * nx + i + 1]; v[3] = D[(j + 1) * nx + i];
      if (!(Number.isFinite(v[0]) && Number.isFinite(v[1]) && Number.isFinite(v[2]) && Number.isFinite(v[3]))) continue;
      const lo = Math.min(v[0], v[1], v[2], v[3]), hi = Math.max(v[0], v[1], v[2], v[3]);
      const k0 = Math.max(kMin, Math.floor(lo / step) + 1), k1 = Math.floor(hi / step);
      for (let k = k0; k <= k1; k++) {
        // tiny bias so a node exactly on the level counts as "above" consistently
        const L = k * step - 1e-12;
        if (!(lo < L && L < hi)) continue;
        const above = v.map((x) => x >= L);
        const cut = [0, 1, 2, 3].filter((e) => above[EDGE_CORNERS[e][0]] !== above[EDGE_CORNERS[e][1]]);
        let pairs: [number, number][];
        if (cut.length === 2) pairs = [[cut[0], cut[1]]];
        else {
          // saddle: isolate the corners whose state differs from the cell centre
          const centre = (v[0] + v[1] + v[2] + v[3]) / 4 >= L;
          pairs = [0, 1, 2, 3].filter((c) => above[c] !== centre).map((c) => CORNER_EDGES[c]);
        }
        let list = segs.get(k), pm = pts.get(k);
        if (!list) { list = []; segs.set(k, list); pm = new Map(); pts.set(k, pm); }
        for (const [ea, eb] of pairs) {
          for (const e of [ea, eb]) {
            const id = eid(i, j, e);
            if (!pm!.has(id)) {
              const [a, b] = EDGE_CORNERS[e];
              const t = (L - v[a]) / (v[b] - v[a]);
              pm!.set(id, [x0 + (i + cx[a] + t * (cx[b] - cx[a])) * h, y0 + (j + cy[a] + t * (cy[b] - cy[a])) * h]);
            }
          }
          list.push(eid(i, j, ea), eid(i, j, eb));
        }
      }
    }
  }
  const out: Contour[] = [];
  for (const k of [...segs.keys()].sort((a, b) => a - b)) {
    for (const c of stitch(segs.get(k)!, pts.get(k)!)) out.push({ level: k * step, k, ...c });
  }
  return out;
}

/** Join segments sharing grid-edge ids into polylines (each edge point is shared by at most two segments). */
function stitch(flat: number[], pts: Map<number, Vec2>): { pts: Polyline; closed: boolean }[] {
  const n = flat.length / 2;
  const at = new Map<number, number[]>();
  for (let s = 0; s < n; s++) for (const e of [flat[2 * s], flat[2 * s + 1]]) { const l = at.get(e); if (l) l.push(s); else at.set(e, [s]); }
  const used = new Uint8Array(n);
  const walk = (s: number, from: number) => {
    const ids = [from];
    let cur = s, e = from;
    for (;;) {
      used[cur] = 1;
      const next = flat[2 * cur] === e ? flat[2 * cur + 1] : flat[2 * cur];
      ids.push(next);
      const nb = (at.get(next) ?? []).find((t) => !used[t]);
      if (nb === undefined) break;
      cur = nb; e = next;
    }
    return ids;
  };
  const res: { pts: Polyline; closed: boolean }[] = [];
  // open chains first (start at an end point), then closed loops
  for (const [e, l] of at) if (l.length === 1 && !used[l[0]]) res.push({ pts: walk(l[0], e).map((id) => pts.get(id)!), closed: false });
  for (let s = 0; s < n; s++) if (!used[s]) {
    const ids = walk(s, flat[2 * s]);
    res.push({ pts: ids.map((id) => pts.get(id)!), closed: ids[0] === ids[ids.length - 1] });
  }
  return res;
}
