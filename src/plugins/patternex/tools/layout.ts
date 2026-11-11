// Pattern layout tools: tiling / repeat with seeded jitter and seamless wraps, two-colour dithered
// gradients, and the surface brush (strokes painted onto a placement).
import { boundsOf, type Pattern, type PatternShape, type Ring } from '../model';
import { rng } from '../library/geom';
import { patternOf, strokeLines, solidRings } from './shape';

export interface TileSpec {
  nx: number; ny: number;
  /** Gap between tiles (mm). */
  gap_x: number; gap_y: number;
  /** Shift every other row by half a tile (brick). */
  stagger: boolean;
  /** Random offset (mm) and rotation (degrees) per tile, seeded so it repeats. */
  jitter_mm: number; jitter_deg: number; seed: number;
  /** Seamless wrap: make the total width equal this circumference (mm) by adjusting the gap; 0 = off. */
  wrap_mm: number;
}
export const defaultTileSpec = (): TileSpec => ({ nx: 4, ny: 2, gap_x: 2, gap_y: 2, stagger: false, jitter_mm: 0, jitter_deg: 0, seed: 1, wrap_mm: 0 });

/** Gap that makes n tiles of width w close a loop of circumference c exactly (seamless wrap). */
export const seamlessGap = (n: number, w: number, c: number) => Math.max(0, c / Math.max(1, n) - w);
/** Tile count that best fits a circumference with at least `minGap` between tiles. */
export const seamlessCount = (w: number, c: number, minGap = 0) => Math.max(1, Math.floor(c / (w + minGap)));

export function tilePattern(base: Pattern, spec: TileSpec, id: string): Pattern {
  const [x0, y0, x1, y1] = base.bounds;
  const w = x1 - x0, h = y1 - y0;
  const gx = spec.wrap_mm > 0 ? seamlessGap(spec.nx, w, spec.wrap_mm) : spec.gap_x;
  const r = rng(spec.seed || 1);
  const shapes: PatternShape[] = base.shapes.map((s) => ({ ...s, polygon_rings: [] }));
  for (let j = 0; j < spec.ny; j++) for (let i = 0; i < spec.nx; i++) {
    const dx = i * (w + gx) + (spec.stagger && j % 2 ? (w + gx) / 2 : 0) + (r() * 2 - 1) * spec.jitter_mm;
    const dy = -j * (h + spec.gap_y) + (r() * 2 - 1) * spec.jitter_mm;
    const a = ((r() * 2 - 1) * spec.jitter_deg * Math.PI) / 180, c = Math.cos(a), sn = Math.sin(a);
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    base.shapes.forEach((s, k) => {
      for (const ring of s.polygon_rings) shapes[k].polygon_rings.push(ring.map(([x, y]) => {
        const ux = x - cx, uy = y - cy;
        return [cx + c * ux - sn * uy + dx, cy + sn * ux + c * uy + dy] as [number, number];
      }));
    });
  }
  const out: Pattern = { ...base, id, name: `${base.name} ×${spec.nx * spec.ny}`, shapes, bounds: boundsOf(shapes), meta: { kind: 'tile', spec, base: base.id } };
  delete out.origin;
  return out;
}

/**
 * Two-colour dithered gradient: ordered (Bayer 8×8) dither of a linear ramp, cell by cell, so two filaments
 * read as a smooth blend from a distance. Cells should be ≥ 2 line widths to print cleanly.
 */
export interface GradientSpec { width_mm: number; height_mm: number; cell_mm: number; angle_deg: number; from: number; to: number; colorA: string; colorB: string }
export const defaultGradientSpec = (): GradientSpec => ({ width_mm: 40, height_mm: 20, cell_mm: 1, angle_deg: 0, from: 0, to: 1, colorA: '#2f2f33', colorB: '#7d7d85' });

const BAYER8 = (() => {
  const m = [[0]];
  let n = 1;
  let cur = m;
  while (n < 8) {
    const nx: number[][] = Array.from({ length: n * 2 }, () => new Array(n * 2).fill(0));
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const v = cur[y][x] * 4;
      nx[y][x] = v; nx[y][x + n] = v + 2; nx[y + n][x] = v + 3; nx[y + n][x + n] = v + 1;
    }
    cur = nx; n *= 2;
  }
  return cur.map((r) => r.map((v) => (v + 0.5) / 64));
})();
export const bayer = (x: number, y: number) => BAYER8[((y % 8) + 8) % 8][((x % 8) + 8) % 8];

export function gradientPattern(spec: GradientSpec, id: string): Pattern {
  const nx = Math.max(1, Math.round(spec.width_mm / spec.cell_mm)), ny = Math.max(1, Math.round(spec.height_mm / spec.cell_mm));
  const a = (spec.angle_deg * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a);
  const A: Ring[] = [], B: Ring[] = [];
  const c = spec.cell_mm;
  // projection range of the cell centres on the gradient direction
  const corners = [[0, 0], [nx, 0], [0, ny], [nx, ny]].map(([x, y]) => x * ca + y * sa);
  const lo = Math.min(...corners), hi = Math.max(...corners);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const t = ((i + 0.5) * ca + (j + 0.5) * sa - lo) / (hi - lo || 1);
    const v = spec.from + (spec.to - spec.from) * t; // share of colour B
    const cell: Ring = [[i * c, j * c], [(i + 1) * c, j * c], [(i + 1) * c, (j + 1) * c], [i * c, (j + 1) * c]];
    (v > bayer(i, j) ? B : A).push(cell);
  }
  return patternOf(id, 'Dithered gradient', [{ color: spec.colorA, rings: solidRings(A) }, { color: spec.colorB, rings: solidRings(B) }]);
}

/** Brush: strokes (pattern mm) grown to their width; the origin stays fixed so painted parts do not move. */
export function brushPattern(id: string, strokes: { pts: [number, number][]; width: number; color: string }[]): Pattern {
  const byColor = new Map<string, Ring[]>();
  for (const s of strokes) {
    const rings = strokeLines([s.pts], s.width);
    byColor.set(s.color, [...(byColor.get(s.color) ?? []), ...rings]);
  }
  const p = patternOf(id, 'Brush', [...byColor].map(([color, rings]) => ({ color, rings: solidRings(rings) })), { kind: 'brush', strokes });
  p.origin = [0, 0];
  if (!p.shapes.length) p.bounds = [-1, -1, 1, 1];
  return p;
}

// ---------- bleed calibration
/**
 * Calibrated transition volume from a measured bleed: the length (mm) of mixed colour on the outer wall
 * after a no-purge change, times the line cross-section (width × layer height), summed over the
 * `lines` walls that carried it (the outer wall only, normally 1).
 */
export const calibratedVolume = (bleedMm: number, lineW: number, layerH: number, lines = 1) => Math.max(0, bleedMm) * lineW * layerH * Math.max(1, lines);
