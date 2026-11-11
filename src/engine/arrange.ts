// Plate arrange: silhouettes (convex hulls) are packed with a minimum
// spacing, optionally rotated, biggest first, then the group is centred (or aligned to an axis).
export type Pt = [number, number];

export interface ArrangeItem { id: string; hull: Pt[] }
export interface ArrangeOptions {
  /** Gap between objects (mm). */
  spacing: number;
  /** Rotations tried, degrees about Z. */
  rotations: number[];
  /** Where the packed group goes: the bed centre, or flush along the X or Y axis (centred on the other). */
  align: 'center' | 'x' | 'y';
  /** Clear band along the bed edges (mm). */
  edge: number;
  /** Grid cell (mm). */
  res?: number;
}
/** Where an item ended up: rotate its hull by `rotation` about the hull's centroid, then move the centroid to (x, y). */
export interface ArrangePlacement { x: number; y: number; rotation: number }

export function convexHull(pts: Pt[]): Pt[] {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo: Pt[] = [], hi: Pt[] = [];
  for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (hi.length >= 2 && cross(hi[hi.length - 2], hi[hi.length - 1], q) <= 0) hi.pop(); hi.push(q); }
  return lo.slice(0, -1).concat(hi.slice(0, -1));
}

const centroid = (h: Pt[]): Pt => {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < h.length; i++) {
    const [x0, y0] = h[i], [x1, y1] = h[(i + 1) % h.length];
    const c = x0 * y1 - x1 * y0;
    a += c; cx += (x0 + x1) * c; cy += (y0 + y1) * c;
  }
  if (Math.abs(a) < 1e-9) { const n = h.length || 1; return [h.reduce((s, p) => s + p[0], 0) / n, h.reduce((s, p) => s + p[1], 0) / n]; }
  return [cx / (3 * a), cy / (3 * a)];
};
const area = (h: Pt[]) => { let a = 0; for (let i = 0; i < h.length; i++) { const [x0, y0] = h[i], [x1, y1] = h[(i + 1) % h.length]; a += x0 * y1 - x1 * y0; } return Math.abs(a) / 2; };

interface Mask { w: number; h: number; cells: Uint8Array; ox: number; oy: number }
/** Cells covered by the polygon grown by `grow` mm; (ox, oy) = position of the centroid inside the mask, in cells. */
function rasterize(h: Pt[], res: number, grow: number): Mask {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of h) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  x0 -= grow; y0 -= grow; x1 += grow; y1 += grow;
  const w = Math.max(1, Math.ceil((x1 - x0) / res)), hh = Math.max(1, Math.ceil((y1 - y0) / res));
  const cells = new Uint8Array(w * hh);
  // distance from a point to the convex polygon (0 inside)
  const inside = (px: number, py: number) => {
    let out = false;
    for (let i = 0; i < h.length; i++) {
      const [ax, ay] = h[i], [bx, by] = h[(i + 1) % h.length];
      if ((bx - ax) * (py - ay) - (by - ay) * (px - ax) < 0) { out = true; break; }
    }
    if (!out) return true;
    if (grow <= 0) return false;
    for (let i = 0; i < h.length; i++) {
      const [ax, ay] = h[i], [bx, by] = h[(i + 1) % h.length];
      const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L));
      if (Math.hypot(px - ax - t * dx, py - ay - t * dy) <= grow) return true;
    }
    return false;
  };
  // a cell counts when any part of it may be covered: test corners and centre
  for (let j = 0; j < hh; j++) for (let i = 0; i < w; i++) {
    const cx = x0 + i * res, cy = y0 + j * res;
    if (inside(cx + res / 2, cy + res / 2) || inside(cx, cy) || inside(cx + res, cy) || inside(cx, cy + res) || inside(cx + res, cy + res)) cells[j * w + i] = 1;
  }
  const [gx, gy] = centroid(h);
  return { w, h: hh, cells, ox: (gx - x0) / res, oy: (gy - y0) / res };
}

const rotate = (h: Pt[], deg: number): Pt[] => {
  if (!deg) return h;
  const [cx, cy] = centroid(h), a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return h.map(([x, y]) => [cx + (x - cx) * c - (y - cy) * s, cy + (x - cx) * s + (y - cy) * c]);
};

/** Pack the items on a bed of `bed` mm (origin at the bed's corner). Items that do not fit are left out of the map. */
export function arrangeItems(items: ArrangeItem[], bed: { x: number; y: number }, o: ArrangeOptions): Map<string, ArrangePlacement> {
  const res = o.res ?? (Math.max(bed.x, bed.y) > 300 ? 2 : 1);
  const W = Math.floor(bed.x / res), H = Math.floor(bed.y / res);
  const occ = new Uint8Array(W * H);
  const e = Math.ceil(o.edge / res);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) if (i < e || j < e || i >= W - e || j >= H - e) occ[j * W + i] = 1;
  const order = items.slice().sort((a, b) => area(b.hull) - area(a.hull));
  const placed = new Map<string, ArrangePlacement & { mask: Mask; i: number; j: number }>();
  for (const it of order) {
    let best: { i: number; j: number; rot: number; m: Mask; score: number } | null = null;
    for (const rot of o.rotations.length ? o.rotations : [0]) {
      const hull = rotate(it.hull, rot);
      // the object itself (to test) and its spacing halo (to reserve)
      const m = rasterize(hull, res, 0);
      for (let j = 0; j + m.h <= H; j++) {
        // bottom-left: the first row that fits wins for this rotation; keep the lowest overall, then leftmost
        if (best && j > best.j) break;
        for (let i = 0; i + m.w <= W; i++) {
          let ok = true;
          for (let y = 0; y < m.h && ok; y++) for (let x = 0; x < m.w; x++) if (m.cells[y * m.w + x] && occ[(j + y) * W + i + x]) { ok = false; break; }
          if (!ok) continue;
          const score = j * W + i;
          if (!best || score < best.score) best = { i, j, rot, m, score };
          break;
        }
      }
    }
    if (!best) continue;
    // reserve the object grown by the spacing
    const hull = rotate(it.hull, best.rot);
    const halo = rasterize(hull, res, o.spacing);
    const di = Math.round(best.i + best.m.ox - halo.ox), dj = Math.round(best.j + best.m.oy - halo.oy);
    for (let y = 0; y < halo.h; y++) for (let x = 0; x < halo.w; x++) {
      if (!halo.cells[y * halo.w + x]) continue;
      const gi = di + x, gj = dj + y;
      if (gi >= 0 && gj >= 0 && gi < W && gj < H) occ[gj * W + gi] = 1;
    }
    placed.set(it.id, { x: (best.i + best.m.ox) * res, y: (best.j + best.m.oy) * res, rotation: best.rot, mask: best.m, i: best.i, j: best.j });
  }
  // move the packed group to the bed centre (or flush to one axis)
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of placed.values()) { x0 = Math.min(x0, p.i * res); y0 = Math.min(y0, p.j * res); x1 = Math.max(x1, (p.i + p.mask.w) * res); y1 = Math.max(y1, (p.j + p.mask.h) * res); }
  const shiftX = o.align === 'y' ? o.edge - x0 : (bed.x - (x1 - x0)) / 2 - x0;
  const shiftY = o.align === 'x' ? o.edge - y0 : (bed.y - (y1 - y0)) / 2 - y0;
  const out = new Map<string, ArrangePlacement>();
  for (const [id, p] of placed) out.set(id, { x: p.x + shiftX, y: p.y + shiftY, rotation: p.rotation });
  return out;
}
