// Lightning infill: tree-shaped infill that only holds up the surfaces above it. Built top-down: under every solid
// area, points are seeded and joined into a tree rooted on the inner walls; going down a layer, every branch tip
// moves toward its parent (at most one layer height × tan(angle)), so the trees shrink into the walls.
import { bounds, intersection, offset, SCALE } from './clipper';
import ClipperLib from 'clipper-lib';
import type { Paths, Polyline2 } from './types';

const C: any = (ClipperLib as any).default ?? ClipperLib;

/** Spatial index of polygon edges for nearest-boundary queries. */
export class EdgeIndex {
  private grid = new Map<string, number[]>();
  private segs: number[] = []; // ax, ay, bx, by
  constructor(paths: Paths, private cell: number) {
    for (const p of paths) for (let i = 0; i < p.length; i++) {
      const a = p[i], b = p[(i + 1) % p.length];
      const k = this.segs.length / 4;
      const ax = a.X / SCALE, ay = a.Y / SCALE, bx = b.X / SCALE, by = b.Y / SCALE;
      this.segs.push(ax, ay, bx, by);
      for (let gx = Math.floor(Math.min(ax, bx) / cell); gx <= Math.floor(Math.max(ax, bx) / cell); gx++)
        for (let gy = Math.floor(Math.min(ay, by) / cell); gy <= Math.floor(Math.max(ay, by) / cell); gy++) {
          const key = `${gx},${gy}`;
          const l = this.grid.get(key); if (l) l.push(k); else this.grid.set(key, [k]);
        }
    }
  }
  get empty() { return this.segs.length === 0; }
  /** Nearest boundary point and its distance (searches growing rings of cells). */
  nearest(x: number, y: number, maxRings = 64): { x: number; y: number; d: number } | null {
    const cx = Math.floor(x / this.cell), cy = Math.floor(y / this.cell);
    let best = null as { x: number; y: number; d: number } | null;
    for (let r = 0; r <= maxRings; r++) {
      for (let gx = cx - r; gx <= cx + r; gx++) for (let gy = cy - r; gy <= cy + r; gy++) {
        if (Math.max(Math.abs(gx - cx), Math.abs(gy - cy)) !== r) continue;
        for (const k of this.grid.get(`${gx},${gy}`) ?? []) {
          const ax = this.segs[k * 4], ay = this.segs[k * 4 + 1], bx = this.segs[k * 4 + 2], by = this.segs[k * 4 + 3];
          const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
          const t = l2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
          const qx = ax + t * dx, qy = ay + t * dy, d = Math.hypot(qx - x, qy - y);
          if (!best || d < best.d) best = { x: qx, y: qy, d };
        }
      }
      if (best && best.d <= r * this.cell) break;
    }
    return best;
  }
}

const insideAny = (x: number, y: number, paths: Paths) => {
  const pt = { X: Math.round(x * SCALE), Y: Math.round(y * SCALE) };
  let n = 0;
  for (const p of paths) if (C.Clipper.PointInPolygon(pt, p) !== 0) n++;
  return n % 2 === 1;
};

interface Node { x: number; y: number; px: number; py: number; root: boolean }

/**
 * @param sparse  sparse-infill region of every layer
 * @param need    per layer: area of that layer's sparse region that has solid infill / skin directly above
 * @param spacing distance between seeded points (infill line spacing)
 * @param heights layer heights
 * @param angle   largest lean of a branch from vertical (degrees): how far a tip moves toward its parent per layer
 * @param opts    OrcaSlicer's lightning angles (degrees). overhang: areas within layer height x tan(angle) of the
 *                walls need no branch (the walls hold them); prune: a tip closer to its parent than layer height x
 *                tan(angle) is dropped; straighten: a branch node moves up to layer height x tan(angle) per layer
 *                toward the straight line between its neighbours.
 * @returns per layer: the lightning polylines
 */
export function lightningInfill(sparse: Paths[], need: Paths[], spacing: number, heights: number[], angle = 45, opts: { overhang?: number; prune?: number; straighten?: number } = {}): Polyline2[][] {
  const N = sparse.length;
  const out: Polyline2[][] = Array.from({ length: N }, () => []);
  let carry: { x: number; y: number }[] = [];
  const tanOf = (a: number) => Math.tan((Math.max(5, Math.min(85, a)) * Math.PI) / 180);
  const tan = Math.tan((Math.max(5, Math.min(80, angle)) * Math.PI) / 180);
  const tanPrune = opts.prune === undefined ? tan : tanOf(opts.prune);
  const tanWall = opts.overhang === undefined ? 0 : tanOf(opts.overhang);
  const tanStraight = opts.straighten === undefined ? 0 : tanOf(opts.straighten);
  for (let i = N - 1; i >= 0; i--) {
    const region = sparse[i];
    if (!region.length) { carry = []; continue; }
    // seed points under the solid areas of the layer above
    const pts: { x: number; y: number }[] = carry.filter((p) => insideAny(p.x, p.y, region));
    // the walls hold what lies within the wall supporting radius of them
    const needHere = need[i]?.length && tanWall > 0 ? intersection(need[i], offset(region, -heights[i] * tanWall)) : need[i];
    if (needHere?.length) {
      const b = bounds(needHere);
      const x0 = Math.floor(b.minX / SCALE / spacing) * spacing, y0 = Math.floor(b.minY / SCALE / spacing) * spacing;
      for (let y = y0 + spacing / 2; y < b.maxY / SCALE; y += spacing) for (let x = x0 + spacing / 2; x < b.maxX / SCALE; x += spacing) {
        if (insideAny(x, y, needHere) && insideAny(x, y, region)) pts.push({ x, y });
      }
    }
    if (!pts.length) { carry = []; continue; }
    const edges = new EdgeIndex(region, Math.max(1, spacing));
    // join each point to the nearer of: the wall, or a point already connected (closer to the wall first)
    const withD = pts.map((p) => ({ ...p, b: edges.nearest(p.x, p.y) }));
    withD.sort((a, b) => (a.b?.d ?? 0) - (b.b?.d ?? 0));
    const cell = spacing * 2;
    const placed = new Map<string, Node[]>();
    const nodes: Node[] = [];
    for (const p of withD) {
      let best = null as Node | null, bd = p.b ? p.b.d : Infinity;
      const cx = Math.floor(p.x / cell), cy = Math.floor(p.y / cell);
      const rings = Math.min(32, Math.ceil(bd / cell) + 1);
      for (let r = 0; r <= rings; r++) {
        for (let gx = cx - r; gx <= cx + r; gx++) for (let gy = cy - r; gy <= cy + r; gy++) {
          if (Math.max(Math.abs(gx - cx), Math.abs(gy - cy)) !== r) continue;
          for (const q of placed.get(`${gx},${gy}`) ?? []) {
            const d = Math.hypot(q.x - p.x, q.y - p.y);
            if (d < bd && d > 1e-6) { bd = d; best = q; }
          }
        }
        if (best && bd <= r * cell) break;
      }
      const n: Node = best ? { x: p.x, y: p.y, px: best.x, py: best.y, root: false } : { x: p.x, y: p.y, px: p.b?.x ?? p.x, py: p.b?.y ?? p.y, root: true };
      nodes.push(n);
      const key = `${cx},${cy}`;
      const l = placed.get(key); if (l) l.push(n); else placed.set(key, [n]);
    }
    // straightening: a node joined to a parent that is itself a child moves toward the line between its child and
    // grandparent, by at most layer height x tan(straightening angle)
    if (tanStraight > 0) {
      const maxMove = heights[i] * tanStraight;
      const at = new Map<string, Node>();
      const key = (x: number, y: number) => `${Math.round(x * 1000)},${Math.round(y * 1000)}`;
      for (const n of nodes) at.set(key(n.x, n.y), n);
      for (const n of nodes) {
        const p = at.get(key(n.px, n.py));
        if (!p || p.root) continue;
        const mx = (n.x + p.px) / 2, my = (n.y + p.py) / 2, d = Math.hypot(mx - p.x, my - p.y);
        if (d < 1e-6) continue;
        const k = Math.min(1, maxMove / d);
        const nx = p.x + (mx - p.x) * k, ny = p.y + (my - p.y) * k;
        if (!insideAny(nx, ny, region)) continue;
        for (const c of nodes) if (c.px === p.x && c.py === p.y) { c.px = nx; c.py = ny; }
        p.x = nx; p.y = ny;
      }
    }
    out[i] = nodes.filter((n) => Math.hypot(n.px - n.x, n.py - n.y) > 0.05).map((n) => ({ pts: [n.x, n.y, n.px, n.py], closed: false }));
    // the layer below: tips move toward their parents and disappear once they reach them (or the wall)
    const step = heights[i] * tan;
    const next: { x: number; y: number }[] = [];
    const seen = new Set<string>();
    for (const n of nodes) {
      const d = Math.hypot(n.px - n.x, n.py - n.y);
      if (d <= Math.max(step, heights[i] * tanPrune)) continue; // reached its parent, or pruned
      const x = n.x + ((n.px - n.x) / d) * step, y = n.y + ((n.py - n.y) / d) * step;
      const key = `${Math.round(x / (spacing * 0.5))},${Math.round(y / (spacing * 0.5))}`;
      if (seen.has(key)) continue; // nearby tips merge
      seen.add(key);
      next.push({ x, y });
    }
    carry = next;
  }
  return out;
}
