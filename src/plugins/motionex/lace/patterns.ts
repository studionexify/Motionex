// Lace patterns: where a wall is open, as a function of the position on the wall in mm (X round the
// part, Y up it). Every pattern is drawn on a grid of cells; the hole shapes have pointed or steep tops
// so they print without support (the overhang rule in core.ts still checks every layer).

export interface PatternParams {
  /** Cell width round the part and height up it (mm). */
  cw: number; ch: number;
  /** Lace left between holes (mm). */
  strand: number;
  /** Hole size inside its cell (0..1). */
  open: number;
  seed: number;
}

export interface LacePattern {
  id: string;
  name: string;
  description: string;
  /** Odd rows shifted half a cell round. */
  stagger: boolean;
  /** Open at (dx, dy), mm from the cell centre; a, b = room for the hole (half width, half height). */
  hole?(dx: number, dy: number, a: number, b: number, P: PatternParams): boolean;
  /** Whole-wall patterns (not one hole per cell): open at (X, Y) mm. */
  at?(X: number, Y: number, P: PatternParams): boolean;
}

/** Pointed (gothic) arch: round bottom, straight sides, top closing in a point at ~40° from vertical. */
function arch(dx: number, dy: number, a: number, b: number): boolean {
  const ax = Math.abs(dx);
  if (ax > a || dy < -b || dy > b) return false;
  const y0 = b - 1.2 * a; // where the point starts
  if (dy > y0) return ax <= a * ((b - dy) / Math.max(1e-6, b - y0));
  const yb = -b + a; // centre of the round bottom
  if (dy < yb) return dx * dx + (dy - yb) ** 2 <= a * a;
  return true;
}

/** Hash of two integers and a seed to [0, 1). */
export function hash2(i: number, j: number, seed: number): number {
  let h = Math.imul(i, 374761393) ^ Math.imul(j, 668265263) ^ Math.imul(seed, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export const LACE_PATTERNS: LacePattern[] = [
  { id: 'diamond', name: 'Diamond lattice', description: 'Diamonds between diagonal strands: the classic trellis.', stagger: true,
    // centred lattice: a diamond in every cell and one on every cell corner, so the strands run unbroken
    at: (X, Y, P) => {
      const q = Math.sqrt(1 / (P.cw * P.cw) + 1 / (P.ch * P.ch));
      const k = Math.max(0, 1 - P.strand * q) * P.open, a = (k * P.cw) / 2, b = (k * P.ch) / 2;
      if (a <= 0 || b <= 0) return false;
      const fx = X / P.cw, fy = Y / P.ch;
      for (const [ox, oy] of [[0.5, 0.5], [0, 0]]) {
        const dx = (fx - ox - Math.round(fx - ox)) * P.cw, dy = (fy - oy - Math.round(fy - oy)) * P.ch;
        if (Math.abs(dx) / a + Math.abs(dy) / b <= 1) return true;
      }
      return false;
    } },
  { id: 'lancet', name: 'Gothic arches', description: 'Pointed arch windows, like church tracery.', stagger: true,
    hole: (dx, dy, a, b) => arch(dx, dy, a * 0.8, b) },
  { id: 'teardrop', name: 'Teardrops', description: 'Round holes with pointed tops, the printable circle.', stagger: true,
    hole: (dx, dy, a, b) => {
      const r = Math.min(a, (2 * b) / (1 + Math.SQRT2)), cy = -b + r, apex = cy + r * Math.SQRT2;
      if (dx * dx + (dy - cy) ** 2 <= r * r) return true;
      return dy >= cy && dy <= apex && Math.abs(dx) <= Math.min(r, apex - dy);
    } },
  { id: 'honeycomb', name: 'Honeycomb', description: 'Upright hexagons, points up so they need no bridging.', stagger: true,
    hole: (dx, dy, a, b) => { const c = Math.min(b, a); return Math.abs(dx) <= a && Math.abs(dy) + Math.abs(dx) * (c / a) <= b; } },
  { id: 'vesica', name: 'Almonds', description: 'Almond (vesica) holes, pointed top and bottom, in brick rows.', stagger: true,
    // the overlap of two circles: their centres sit (r - a) either side, so the lens is 2a wide and 2b tall
    hole: (dx, dy, a, b) => { const r = (a * a + b * b) / (2 * a); return (Math.abs(dx) + (r - a)) ** 2 + dy * dy <= r * r; } },
  { id: 'slots', name: 'Slots', description: 'Tall narrow slots in brick rows.', stagger: true,
    hole: (dx, dy, a, b) => arch(dx, dy, a * 0.4, b) },
  { id: 'waves', name: 'Waves', description: 'Wavy slots that ripple up the wall.', stagger: true,
    hole: (dx, dy, a, b) => {
      if (Math.abs(dy) > b) return false;
      const c = 0.45 * a * Math.sin((Math.PI * dy) / b);
      const half = 0.35 * a * Math.min(1, (b - Math.abs(dy)) / Math.max(1e-6, 0.6 * a));
      return Math.abs(dx - c) <= half;
    } },
  { id: 'voronoi', name: 'Voronoi', description: 'Organic cells, like a leaf skeleton or coral. Tops are drawn into points by the overhang rule.', stagger: false,
    at: (X, Y, P) => {
      const gx = X / P.cw, gy = Y / P.ch;
      const i0 = Math.floor(gx), j0 = Math.floor(gy);
      let d1 = Infinity, d2 = Infinity;
      for (let j = j0 - 1; j <= j0 + 1; j++) for (let i = i0 - 1; i <= i0 + 1; i++) {
        const sx = (i + 0.15 + 0.7 * hash2(i, j, P.seed)) * P.cw, sy = (j + 0.15 + 0.7 * hash2(i, j, P.seed + 1)) * P.ch;
        const d = Math.hypot(X - sx, Y - sy);
        if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d;
      }
      // distance to the nearest cell edge, against half a strand plus the closing-up from `open`
      const shrink = (1 - P.open) * 0.35 * Math.min(P.cw, P.ch);
      return (d2 - d1) / 2 >= P.strand / 2 + shrink;
    } },
];

export const lacePattern = (id: string) => LACE_PATTERNS.find((p) => p.id === id) ?? LACE_PATTERNS[0];

/**
 * Open at a point of the wall: X mm round the part (on the cell grid of this layer), Y mm up the band.
 * `open` is the hole size for this height (grade applied by the caller).
 */
export function patternOpen(pat: LacePattern, X: number, Y: number, P: PatternParams): boolean {
  if (pat.at) return pat.at(X, Y, P);
  const row = Math.floor(Y / P.ch);
  const shift = pat.stagger && row & 1 ? 0.5 : 0;
  const cx = X / P.cw - shift;
  const dx = (cx - Math.floor(cx) - 0.5) * P.cw, dy = (Y / P.ch - row - 0.5) * P.ch;
  const a = Math.max(0, (P.cw - P.strand) / 2) * P.open, b = Math.max(0, (P.ch - P.strand) / 2) * P.open;
  if (a <= 0 || b <= 0) return false;
  return pat.hole!(dx, dy, a, b, P);
}
