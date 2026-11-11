// Lace geometry shared by the slicer pass and the preview: which parts of each wall loop are solid.
// Every loop is cut into bins round the part (by u, the fraction round from the +X side). The pattern
// says which bins should be open; then the printability rule runs layer by layer, bottom to top:
//   a solid bin needs a solid bin below it within the overhang reach (layer height × tan(overhang)),
//   or must sit over a gap below that is short enough to bridge.
// Solid that would hang in the air stays open instead, so holes close upwards in points, never in flat
// unsupported roofs. Tiny strands (blobs) and slivers of holes (closed by ooze anyway) are cleaned up.
import { pixelAt } from '../weave/image';
import type { WeaveImage } from '../weave/model';
import type { LaceSettings } from './model';
import { lacePattern, patternOpen, type LacePattern } from './patterns';
import { bandRows, type BandMap, type Pt } from '../wall/loops';

export interface LaceLoop {
  pts: Pt[];
  /** Fraction round the part of each point (see loopFractions). */
  u: ArrayLike<number>;
  length: number;
  cx: number; cy: number;
}

export interface LaceMask {
  /** 1 = solid, per bin; bin b covers u in [b/B, (b+1)/B). */
  solid: Uint8Array;
  B: number;
}

export interface LaceStats {
  /** Bins the pattern wanted open, and open after the printability rule and clean-up. */
  wantedOpen: number;
  open: number;
  /** Bins left open because solid there would have hung in the air (hole tops drawn into points). */
  openedForSupport: number;
  total: number;
  /** Separate holes on the layers (open runs). */
  holes: number;
}

interface Chain { cx: number; cy: number; length: number; mask: LaceMask; /** Pattern cells round this part, fixed from the band's first layer up. */ cells?: number }

const BIN_MM = 0.2;

/** Runs of equal values in a circular mask: [value, start, length][]. A mask with one value is one run. */
export function circularRuns(m: Uint8Array): [number, number, number][] {
  const B = m.length, out: [number, number, number][] = [];
  if (!B) return out;
  let s0 = 0;
  while (s0 < B && m[s0] === m[(s0 - 1 + B) % B]) s0++;
  if (s0 === B) return [[m[0], 0, B]];
  let start = s0, v = m[s0], len = 0;
  for (let k = 0; k < B; k++) {
    const b = (s0 + k) % B;
    if (m[b] === v) len++;
    else { out.push([v, start, len]); start = b; v = m[b]; len = 1; }
  }
  out.push([v, start, len]);
  return out;
}

/** Bins within `reach` bins of a solid bin (circular). */
function dilate(m: Uint8Array, reach: number): Uint8Array {
  const B = m.length, out = new Uint8Array(B);
  if (!m.some((v) => v)) return out;
  if (reach <= 0) { out.set(m); return out; }
  const dist = new Float64Array(B).fill(Infinity);
  // two sweeps each way, twice round, so distances wrap across the seam
  let d = Infinity;
  for (let k = 0; k < 2 * B; k++) { const b = k % B; d = m[b] ? 0 : d + 1; if (d < dist[b]) dist[b] = d; }
  d = Infinity;
  for (let k = 2 * B - 1; k >= 0; k--) { const b = k % B; d = m[b] ? 0 : d + 1; if (d < dist[b]) dist[b] = d; }
  for (let b = 0; b < B; b++) out[b] = dist[b] <= reach ? 1 : 0;
  return out;
}

/** Same mask at a different bin count. */
function resample(m: LaceMask, B: number): Uint8Array {
  if (m.B === B) return m.solid;
  const out = new Uint8Array(B);
  for (let b = 0; b < B; b++) out[b] = m.solid[Math.min(m.B - 1, Math.floor(((b + 0.5) * m.B) / B))];
  return out;
}

/**
 * Walks a part's wall loops from the bottom up and decides where each loop is solid. Call layer() once
 * per layer in order (the preview may skip layers: pass the height climbed since the last call).
 */
export class LaceTracker {
  private chains: Chain[] = [];
  readonly stats: LaceStats = { wantedOpen: 0, open: 0, openedForSupport: 0, total: 0, holes: 0 };
  private pat: LacePattern;
  private rows: BandMap;

  constructor(private l: LaceSettings, private band: { total: number }) {
    this.pat = lacePattern(l.pattern);
    this.rows = bandRows(band.total, l.image.h, l.fit_height, l.picture?.pixel_mm ?? 3);
  }

  /** Should the wall be open here, before the printability rule? s = mm up the band. */
  wantOpen(u: number, s: number, loopLength: number, cells: number): boolean {
    const l = this.l, t = this.band.total > 0 ? s / this.band.total : 0;
    if (l.source === 'image') {
      const img: WeaveImage = l.image;
      const rowB = this.rows.rowFromBottom(s);
      const row = img.h - 1 - (((rowB % img.h) + img.h) % img.h);
      return pixelAt(img, u * img.w * Math.max(1, l.tiles_around), row) > 0;
    }
    const N = cells;
    const open = Math.max(0, Math.min(1, l.open * (1 + l.grade * (2 * t - 1))));
    if (open <= 0.02) return false;
    // cells keep their count round the part, so they widen on bellies and narrow on necks
    const cw = loopLength / N;
    const X = ((u + (l.twist_deg / 360) * t) * N) * cw;
    return patternOpen(this.pat, X, s, { cw, ch: l.cell_h, strand: l.strand_mm, open, seed: l.seed });
  }

  /**
   * Solid masks for this layer's loops. `inBand` false: everything solid (floor, rim). `dz` = height
   * climbed since the previous call.
   */
  layer(loops: LaceLoop[], s: number, dz: number, inBand: boolean): LaceMask[] {
    const l = this.l;
    const reachMm = Math.max(0, dz) * Math.tan((Math.max(0, Math.min(80, l.overhang_deg)) * Math.PI) / 180);
    const used = new Set<Chain>();
    const out: LaceMask[] = [];
    const next: Chain[] = [];
    for (const lp of loops) {
      const B = Math.max(64, Math.min(8192, Math.ceil(lp.length / BIN_MM)));
      const binMm = lp.length / B;
      // the loop below: nearest centre, similar size
      let below: Chain | undefined, bd = Infinity;
      for (const c of this.chains) {
        if (used.has(c)) continue;
        const d = Math.hypot(c.cx - lp.cx, c.cy - lp.cy);
        if (d < bd && d < 3 + 0.25 * Math.max(c.length, lp.length) / (2 * Math.PI)) { bd = d; below = c; }
      }
      if (below) used.add(below);
      const solid = new Uint8Array(B).fill(1);
      const cells = below?.cells ?? (inBand ? Math.max(3, Math.round(lp.length / Math.max(0.5, l.cell_w))) : undefined);
      if (inBand) {
        let wanted = 0;
        for (let b = 0; b < B; b++) if (this.wantOpen((b + 0.5) / B, s, lp.length, cells!)) { solid[b] = 0; wanted++; }
        this.stats.wantedOpen += wanted;
      }
      // printability: solid only over solid (within reach) or over a gap short enough to bridge
      if (below) {
        const prev = resample(below.mask, B);
        const ok = dilate(prev, reachMm / binMm);
        for (const [v, st, len] of circularRuns(prev)) if (!v && len * binMm <= l.bridge_mm) for (let k = 0; k < len; k++) ok[(st + k) % B] = 1;
        for (let b = 0; b < B; b++) if (!ok[b] && solid[b]) { solid[b] = 0; this.stats.openedForSupport++; }
      }
      // clean-up: slivers of hole are filled (a bridge this short is fine), blobs of strand dropped
      if (inBand || below) {
        for (const [v, st, len] of circularRuns(solid)) if (!v && len < B && len * binMm < l.min_hole_mm && len * binMm <= l.bridge_mm) for (let k = 0; k < len; k++) solid[(st + k) % B] = 1;
        for (const [v, st, len] of circularRuns(solid)) if (v && len < B && len * binMm < l.min_strand_mm) for (let k = 0; k < len; k++) solid[(st + k) % B] = 0;
      }
      let open = 0, holes = 0;
      for (let b = 0; b < B; b++) if (!solid[b]) open++;
      if (open) for (const [v] of circularRuns(solid)) if (!v) holes++;
      this.stats.open += open;
      this.stats.holes += holes;
      if (inBand) this.stats.total += B;
      const mask = { solid, B };
      out.push(mask);
      next.push({ cx: lp.cx, cy: lp.cy, length: lp.length, mask, cells });
    }
    this.chains = next;
    return out;
  }
}

/** Solid at u on a mask. */
export const solidAt = (m: LaceMask, u: number) => m.solid[Math.min(m.B - 1, Math.max(0, Math.floor((u - Math.floor(u)) * m.B)))] === 1;
