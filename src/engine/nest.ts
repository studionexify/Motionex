// Fill-bed nesting: pack as many copies of one footprint onto the plate as fit, on a raster.
//
// Every shape is the top-down silhouette of the part (all triangles projected to XY, so holes and
// cavities stay open and other copies can sit in them), grown by its brim / support margin. The
// silhouette is rasterised conservatively (a cell is taken if any triangle touches it), so cells that
// are free are truly free. Each placed copy reserves its cells grown by the gap shape (8 directions,
// at least one cell), and a new copy may only use cells nobody reserved: copies never touch and their
// gaps are never smaller than asked.
//
// Placement is bottom-left: for each allowed orientation (rotation step x mirror) find the first
// position in scan order (front row first, then left to right) where it fits, and keep the
// orientation that ends lowest. Free space only shrinks, so each orientation's scan resumes where
// it stopped last time, which keeps the whole fill to about one pass over the plate per orientation.

export type Mirror = 'none' | 'x' | 'y';

export interface NestRequest {
  /** Triangles of the part in XY (x0,y0,x1,y1,x2,y2 per triangle), around the part's origin. */
  tris: Float32Array;
  bed: { x: number; y: number };
  /** Cell size in mm. */
  res: number;
  /** Brim / support outset around the silhouette (mm). */
  margin: number;
  /** Minimum gap in mm toward N, NE, E, SE, S, SW, W, NW (+Y is north). */
  gaps: number[];
  /** Keep-clear band along the bed edges (mm). */
  edge: number;
  rotations: number[];
  mirrors: Mirror[];
  /** Things already on the plate (bed coordinates), each with its own outset. */
  obstacles: { tris: Float32Array; margin: number }[];
  /** Areas of the bed nothing may cover (bed coordinates). */
  excluded: [number, number][][];
  /** Stop after this many copies (the original counts as one). */
  max?: number;
}

export interface NestPlacement { x: number; y: number; rotation: number; mirror: Mirror }

/** A raster shape: horizontal runs per row, columns relative to the cell `x0`, rows from `y0`. */
interface Mask { x0: number; y0: number; w: number; h: number; rows: Int32Array[] }

const EMPTY = new Int32Array(0);

// ---------------------------------------------------------------- rasterising
/** Cells touched by any triangle (separating-axis test against each cell square). */
function rasterTris(t: Float32Array, res: number): Mask {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < t.length; i += 2) {
    if (t[i] < minX) minX = t[i]; if (t[i] > maxX) maxX = t[i];
    if (t[i + 1] < minY) minY = t[i + 1]; if (t[i + 1] > maxY) maxY = t[i + 1];
  }
  if (!isFinite(minX)) return { x0: 0, y0: 0, w: 0, h: 0, rows: [] };
  const x0 = Math.floor(minX / res), y0 = Math.floor(minY / res);
  const w = Math.floor(maxX / res) - x0 + 1, h = Math.floor(maxY / res) - y0 + 1;
  const grid = new Uint8Array(w * h);
  const eps = 1e-9;
  for (let k = 0; k < t.length; k += 6) {
    const ax = t[k], ay = t[k + 1], bx = t[k + 2], by = t[k + 3], cx = t[k + 4], cy = t[k + 5];
    const i0 = Math.floor(Math.min(ax, bx, cx) / res) - x0, i1 = Math.floor(Math.max(ax, bx, cx) / res) - x0;
    const j0 = Math.floor(Math.min(ay, by, cy) / res) - y0, j1 = Math.floor(Math.max(ay, by, cy) / res) - y0;
    if (i0 === i1 || j0 === j1) { for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) grid[j * w + i] = 1; continue; }
    // edge normals for the SAT test
    const ex = [by - ay, cy - by, ay - cy], ey = [ax - bx, bx - cx, cx - ax];
    const px = [ax, bx, cx], py = [ay, by, cy];
    for (let j = j0; j <= j1; j++) {
      const ly = (j + y0) * res, hy = ly + res;
      for (let i = i0; i <= i1; i++) {
        if (grid[j * w + i]) continue;
        const lx = (i + x0) * res, hx = lx + res;
        let hit = true;
        for (let e = 0; e < 3 && hit; e++) {
          const nx = ex[e], ny = ey[e];
          // triangle projects onto [d, d] on its own edge normal, plus the third vertex
          const d = nx * px[e] + ny * py[e];
          const o = nx * px[(e + 2) % 3] + ny * py[(e + 2) % 3];
          const tMin = Math.min(d, o), tMax = Math.max(d, o);
          const c1 = nx * lx + ny * ly, c2 = nx * hx + ny * ly, c3 = nx * lx + ny * hy, c4 = nx * hx + ny * hy;
          const bMin = Math.min(c1, c2, c3, c4), bMax = Math.max(c1, c2, c3, c4);
          if (bMax < tMin - eps || bMin > tMax + eps) hit = false;
        }
        if (hit) grid[j * w + i] = 1;
      }
    }
  }
  return gridToMask(grid, w, h, x0, y0);
}

function gridToMask(grid: Uint8Array, w: number, h: number, x0: number, y0: number): Mask {
  const rows: Int32Array[] = [];
  const tmp: number[] = [];
  for (let j = 0; j < h; j++) {
    tmp.length = 0;
    let i = 0;
    while (i < w) {
      if (!grid[j * w + i]) { i++; continue; }
      const s = i;
      while (i < w && grid[j * w + i]) i++;
      tmp.push(s, i - 1);
    }
    rows.push(tmp.length ? Int32Array.from(tmp) : EMPTY);
  }
  return { x0, y0, w, h, rows };
}

/** A convex structuring element as one run [lo, hi] per row dy in [-r, r]. */
interface Kernel { r: number; lo: Int32Array; hi: Int32Array }

/** Kernel from a convex star polygon given by radii along 8 directions (E first, counter-clockwise). */
function starKernel(radii: number[], res: number): Kernel {
  const pad = res * Math.SQRT1_2; // a cell centre test can miss up to half a diagonal
  const pts = radii.map((g, k) => { const a = (k * Math.PI) / 4, rr = Math.max(0, g) + pad; return [rr * Math.cos(a), rr * Math.sin(a)]; });
  const inside = (x: number, y: number) => {
    for (let k = 0; k < 8; k++) {
      const [ax, ay] = pts[k], [bx, by] = pts[(k + 1) % 8];
      // inside the triangle (0, a, b) ⇔ on the left of a→b and within the sector
      const cross = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
      const s1 = ax * y - ay * x, s2 = bx * y - by * x;
      if (s1 >= -1e-12 && s2 <= 1e-12 && cross >= -1e-12) return true;
    }
    return false;
  };
  const r = Math.max(1, Math.ceil(Math.max(...pts.map(([x, y]) => Math.hypot(x, y))) / res));
  const lo = new Int32Array(2 * r + 1), hi = new Int32Array(2 * r + 1);
  for (let dy = -r; dy <= r; dy++) {
    let a = 1, b = 0;
    for (let dx = -r; dx <= r; dx++) if (inside(dx * res, dy * res)) { if (a > b) a = dx; b = dx; }
    // always at least the 3x3 neighbourhood: copies never share or touch a cell
    if (Math.abs(dy) <= 1) { a = Math.min(a > b ? -1 : a, -1); b = Math.max(b, 1); }
    lo[dy + r] = a; hi[dy + r] = b;
  }
  return { r, lo, hi };
}

const diskKernel = (radius: number, res: number): Kernel => {
  const r = Math.ceil(radius / res + 1e-9);
  const lo = new Int32Array(2 * r + 1), hi = new Int32Array(2 * r + 1);
  for (let dy = -r; dy <= r; dy++) {
    const span = Math.floor(Math.sqrt(Math.max(0, (r + 0.5) ** 2 - dy * dy)));
    lo[dy + r] = -span; hi[dy + r] = span;
  }
  return { r, lo, hi };
};

/** Minkowski sum of a mask and a kernel. */
function dilate(m: Mask, k: Kernel): Mask {
  if (!m.h || k.r === 0) return m;
  const xl = Math.min(...k.lo), xh = Math.max(...k.hi);
  const w = m.w - xl + xh, h = m.h + 2 * k.r;
  const grid = new Uint8Array(w * h);
  for (let j = 0; j < m.h; j++) {
    const row = m.rows[j];
    for (let s = 0; s < row.length; s += 2) {
      for (let dy = -k.r; dy <= k.r; dy++) {
        const lo = k.lo[dy + k.r], hi = k.hi[dy + k.r];
        if (lo > hi) continue;
        const y = j + dy + k.r, base = y * w - xl;
        grid.fill(1, base + row[s] + lo, base + row[s + 1] + hi + 1);
      }
    }
  }
  return gridToMask(grid, w, h, m.x0 + xl, m.y0 - k.r);
}

function transformTris(t: Float32Array, rotation: number, mirror: Mirror): Float32Array {
  const a = (rotation * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  const mx = mirror === 'x' ? -1 : 1, my = mirror === 'y' ? -1 : 1;
  const out = new Float32Array(t.length);
  for (let i = 0; i < t.length; i += 2) {
    const x = t[i] * mx, y = t[i + 1] * my;
    out[i] = c * x - s * y; out[i + 1] = s * x + c * y;
  }
  return out;
}

// ---------------------------------------------------------------- the plate
class Plate {
  occ: Uint8Array;
  /** Last occupied column at or left of x in each row, or -1. */
  prev: Int32Array;
  constructor(public W: number, public H: number) {
    this.occ = new Uint8Array(W * H);
    this.prev = new Int32Array(W * H).fill(-1);
  }
  /** Mark a mask placed with its cell origin at (px, py); cells off the plate are dropped. */
  mark(m: Mask, px: number, py: number) {
    const { W, H } = this;
    for (let j = 0; j < m.h; j++) {
      const y = py + m.y0 + j;
      if (y < 0 || y >= H) continue;
      const row = m.rows[j];
      for (let s = 0; s < row.length; s += 2) {
        const a = Math.max(0, px + m.x0 + row[s]), b = Math.min(W - 1, px + m.x0 + row[s + 1]);
        if (a <= b) this.occ.fill(1, y * W + a, y * W + b + 1);
      }
      this.reindex(y);
    }
  }
  reindex(y: number) {
    const { W } = this, o = y * W;
    let last = -1;
    for (let x = 0; x < W; x++) { if (this.occ[o + x]) last = x; this.prev[o + x] = last; }
  }
  /** 0 when the mask fits at (px, py), otherwise how far right the scan may jump. */
  test(m: Mask, px: number, py: number): number {
    const { W } = this;
    for (let j = 0; j < m.h; j++) {
      const row = m.rows[j];
      if (!row.length) continue;
      const y = py + m.y0 + j;
      for (let s = 0; s < row.length; s += 2) {
        const a = px + m.x0 + row[s], b = px + m.x0 + row[s + 1];
        const hit = this.prev[y * W + b];
        if (hit >= a) return hit - a + 1;
      }
    }
    return 0;
  }
}

function rasterPolygon(poly: [number, number][], res: number): Mask {
  const tris: number[] = [];
  for (let i = 1; i + 1 < poly.length; i++) tris.push(...poly[0], ...poly[i], ...poly[i + 1]);
  return rasterTris(Float32Array.from(tris), res);
}

/** Pack copies of the part on the plate. Returns bed-coordinate positions for the part's origin. */
export function nest(req: NestRequest, onProgress?: (placed: number) => void): NestPlacement[] {
  const { res } = req;
  const W = Math.floor(req.bed.x / res + 1e-6), H = Math.floor(req.bed.y / res + 1e-6);
  const plate = new Plate(W, H);
  // gaps arrive N, NE, E, SE, S, SW, W, NW; the kernel wants E first going counter-clockwise.
  // A gap is shared by both neighbours, so opposite directions use the larger of the two.
  const g = req.gaps;
  const byAngle = [g[2], g[1], g[0], g[7], g[6], g[5], g[4], g[3]].map((v) => Math.max(0, v || 0));
  const sym = byAngle.map((v, k) => Math.max(v, byAngle[(k + 4) % 8]));
  const gapK = starKernel(sym, res);

  // the bed edge band, excluded areas and anything already on the plate
  const edge = Math.max(0, Math.ceil(req.edge / res - 1e-9));
  if (edge) {
    const band: Mask = { x0: 0, y0: 0, w: W, h: H, rows: Array.from({ length: H }, (_, j) => (j < edge || j >= H - edge ? Int32Array.from([0, W - 1]) : Int32Array.from([0, edge - 1, W - edge, W - 1]))) };
    plate.mark(band, 0, 0);
  }
  for (const poly of req.excluded) plate.mark(rasterPolygon(poly, res), 0, 0);
  for (const ob of req.obstacles) {
    let m = rasterTris(ob.tris, res);
    if (ob.margin > 0) m = dilate(m, diskKernel(ob.margin, res));
    plate.mark(dilate(m, gapK), 0, 0);
  }

  // one body mask (what a copy covers) and one reserve mask (what it keeps others out of) per orientation
  const marginK = req.margin > 0 ? diskKernel(req.margin, res) : null;
  const variants = req.mirrors.flatMap((mirror) => req.rotations.map((rotation) => {
    let body = rasterTris(transformTris(req.tris, rotation, mirror), res);
    if (marginK) body = dilate(body, marginK);
    return { rotation, mirror, body, reserve: dilate(body, gapK), cx: 0, cy: -Infinity as number, done: false };
  })).filter((v) => v.body.h > 0);
  for (const v of variants) {
    // scan range: the body stays on the plate
    v.cy = -v.body.y0;
    v.cx = -v.body.x0;
  }

  const out: NestPlacement[] = [];
  const max = req.max ?? Infinity;
  while (out.length < max) {
    let best: (typeof variants)[number] | null = null, bestScore = Infinity;
    for (const v of variants) {
      if (v.done) continue;
      // the original object must stay unmirrored
      if (!out.length && v.mirror !== 'none') continue;
      const b = v.body, xMax = W - b.x0 - b.w, yMax = H - b.y0 - b.h;
      let found = false;
      while (v.cy <= yMax) {
        if (v.cx > xMax) { v.cy++; v.cx = -b.x0; continue; }
        const jump = plate.test(b, v.cx, v.cy);
        if (!jump) { found = true; break; }
        v.cx += jump;
      }
      if (!found) { v.done = true; continue; }
      // lowest top edge first, then leftmost: the plate fills from the front, row by row
      const score = (v.cy + b.y0 + b.h) * (W + 1) + (v.cx + b.x0);
      if (score < bestScore) { bestScore = score; best = v; }
    }
    if (!best) break;
    plate.mark(best.reserve, best.cx, best.cy);
    out.push({ x: best.cx * res, y: best.cy * res, rotation: best.rotation, mirror: best.mirror });
    onProgress?.(out.length);
  }
  return out;
}
