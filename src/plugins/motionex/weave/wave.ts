// Wave texture for the weave pass and its preview. The line swings in and out along the wall and each
// layer's wave is shifted against the one below (crest over trough = knit, a quarter = twill, none =
// ribs). The whole part has one style; zones (modifier volumes, height bands) cross-fade to their own
// style or to a plain wall. Every edge is a soft one at least a stitch long, along the line and from
// layer to layer, so the wave meets the straight wall without a step or a kink.
//
// Per sample: wave = Σ zones (override cross-fade) A·shape(N·u + phase(layer)/360), N a whole number of
// stitches round the loop (so it closes on itself at the seam), kept from layer to layer while it fits.
import { effectPhase, makeRepeatLock, waveValue, wallClearance } from '../modifier';
import type { LayerEffect } from '../model';
import { defaultWave, type WaveStyle, type WeaveSettings, type WeaveWave } from './model';
import type { ExtraOffset, LoopSamples } from './core';
import type { WaveZone } from './zones';

/** The layer effect a wave style uses: flip back and forth (alternate) or keep sliding (steady). */
export function waveEffect(s: WaveStyle): LayerEffect | null {
  const every = Math.round(s.flip_every);
  if (every <= 0 || !s.flip_deg) return null;
  return { shift_deg: s.flip_deg, mode: s.flip_mode === 'steady' ? 'steady' : 'alternate', every, band_on: 0, band_off: 0 };
}

/** Wave offset (mm, + = out) at fraction u round a loop of n stitches, on (absolute) layer `layer`. */
export function waveAt(s: WaveStyle, n: number, u: number, layer: number): number {
  const ph = effectPhase(waveEffect(s), layer) ?? 0;
  return s.height_mm * waveValue(s.shape, n * u + ph / 360);
}

/** Corners that turn this much more than the loop's own roundness (over ±W) stay plain. */
const EDGE_TURN = (30 * Math.PI) / 180;
/** The vertical blend looks at most this many layers up and down. */
const MAX_LAYERS = 6;
/** A stitch count is kept from layer to layer while the stitch stays within ±25% of its length. */
const FIT = 0.25;

const smooth = (t: number) => { const u = t < 0 ? 0 : t > 1 ? 1 : t; return u * u * (3 - 2 * u); };

/** Sorted positions (mm along a loop of length L) → distance from position s to the nearest one, round the loop. */
function nearest(pos: number[], s: number, L: number): number {
  if (!pos.length) return Infinity;
  let lo = 0, hi = pos.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (pos[m] < s) lo = m + 1; else hi = m; }
  const a = pos[(lo - 1 + pos.length) % pos.length], b = pos[lo % pos.length];
  const d = (p: number) => { const x = Math.abs(p - s) % L; return Math.min(x, L - x); };
  return Math.min(d(a), d(b));
}

/**
 * Weight (0..1) along a closed loop from inside flags: 1 deep inside, 0 far outside, a smoothstep over
 * T mm of line centred on each edge. No edge on the loop: all in or all out.
 */
export function arcWeights(inside: Uint8Array, s: number[], L: number, T: number): Float64Array {
  const M = inside.length, w = new Float64Array(M);
  const edges: number[] = [];
  for (let i = 0; i < M; i++) {
    const j = (i + 1) % M;
    if (inside[i] !== inside[j]) edges.push(j ? (s[i] + s[j]) / 2 : ((s[i] + L) / 2) % L);
  }
  edges.sort((a, b) => a - b);
  for (let i = 0; i < M; i++) {
    if (!edges.length) { w[i] = inside[i]; continue; }
    const d = nearest(edges, s[i], L);
    w[i] = smooth(0.5 + (inside[i] ? d : -d) / Math.max(1e-6, T));
  }
  return w;
}

export interface WaveStats {
  /** Layers (slicer index) the wave reached. */
  layers: Set<number>;
  /** Zones (index) that changed some loop. */
  zones: Set<number>;
  /** Times a stitch count was re-picked because the loop grew or shrank. */
  repicks: number;
  /** Loops where ribs or sharp edges were kept plain. */
  edgeLoops: number;
}

export interface WaveFieldOptions {
  /** Slice plane (object mm) of each layer, by slicer layer index. Zones were sliced on these. */
  planes: number[];
  /** Is (x, y) on object o at layer i? Height bands act only on their own object. Missing = yes. */
  onObject?: (o: number, layer: number, x: number, y: number) => boolean;
  /** Largest move from the wall (mm), the weave's cap. */
  cap?: number;
}

/** The wave texture of one weave: whole-part style plus zones, for any loop on any layer. */
export class WaveField {
  readonly base: WeaveWave;
  readonly zones: WaveZone[];
  readonly stats: WaveStats = { layers: new Set(), zones: new Set(), repicks: 0, edgeLoops: 0 };
  private planes: number[];
  private opt: WaveFieldOptions;
  private z0: number; private z1: number;
  private styles: WaveStyle[];
  private blends: number[];
  private reach: number[];
  private active: Uint8Array;
  private locks: Map<string, number>[];
  private lh: number;

  constructor(w: WeaveSettings, zones: WaveZone[], opt: WaveFieldOptions) {
    this.base = { ...defaultWave(), ...(w.wave ?? {}) };
    this.zones = zones;
    this.opt = opt;
    this.planes = opt.planes;
    this.z0 = w.z_start; this.z1 = w.z_end;
    const b = this.base;
    this.styles = zones.map((z) => ({ ...pickStyle(b), ...z.own }));
    // soft edge: the zone's own or the whole part's, never shorter than one stitch
    this.blends = zones.map((z, k) => Math.max(z.blend ?? b.blend_mm, this.styles[k].length_mm, 0.2));
    const dz: number[] = [];
    for (let i = 1; i < this.planes.length; i++) { const d = this.planes[i] - this.planes[i - 1]; if (d > 1e-4 && this.planes[i - 1] > -0.5) dz.push(d); }
    dz.sort((a, c) => a - c);
    this.lh = dz.length ? dz[dz.length >> 1] : 0.2;
    this.reach = this.blends.map((T) => Math.min(MAX_LAYERS, Math.ceil(T / 2 / this.lh)));
    this.locks = [new Map(), ...zones.map(() => new Map<string, number>())];
    const N = this.planes.length;
    this.active = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      if (this.baseWeight(i) > 0) { this.active[i] = 1; continue; }
      for (let k = 0; k < zones.length && !this.active[i]; k++) {
        const z = zones[k];
        if (z.plain) continue;
        if (z.kind === 'band') { if (this.bandWeight(k, i) > 0) this.active[i] = 1; continue; }
        for (let j = -this.reach[k]; j <= this.reach[k]; j++) if (z.layers?.[i + j]) { this.active[i] = 1; break; }
      }
    }
  }

  /** Shortest stitch any part of this weave uses (mm), or Infinity with no wave. */
  get shortestStitch(): number {
    let m = Infinity;
    if (this.base.enabled && this.base.height_mm > 0) m = this.base.length_mm;
    this.zones.forEach((z, k) => { if (!z.plain && this.styles[k].height_mm > 0) m = Math.min(m, this.styles[k].length_mm); });
    return m;
  }

  /** Could the wave reach slicer layer i? */
  activeAt(i: number): boolean { return !!this.active[i]; }

  /** Whole-part weight at layer i: the From–To band, faded in and out over the soft edge. */
  baseWeight(i: number): number {
    const b = this.base, p = this.planes[i];
    if (!b.enabled || !(b.height_mm > 0) || p === undefined || p < 0) return 0;
    const T = Math.max(b.blend_mm, b.length_mm, 0.2);
    if (p < this.z0 || p > this.z1) return 0;
    return smooth((p - this.z0) / T) * (this.z1 >= 1e4 - 1 ? 1 : smooth((this.z1 - p) / T));
  }

  private bandWeight(k: number, i: number): number {
    const z = this.zones[k], p = this.planes[i], T = this.blends[k];
    if (p === undefined || p < 0) return 0;
    return smooth(0.5 + (p - z.z0) / T) * smooth(0.5 + (z.z1 - p) / T);
  }

  /** Weight of shape zone k along a loop of layer i: the outlines of nearby layers, blended up and down. */
  private shapeWeight(k: number, i: number, s: LoopSamples, box: [number, number, number, number]): Float64Array | null {
    const z = this.zones[k], T = this.blends[k], m = this.reach[k], M = s.x.length;
    let acc: Float64Array | null = null, tot = 0;
    const inside = new Uint8Array(M);
    for (let j = -m; j <= m; j++) {
      const wj = m + 1 - Math.abs(j);
      tot += wj;
      const rs = z.layers?.[i + j];
      if (!rs || !rs.touches(box[0], box[1], box[2], box[3], T)) continue;
      let any = false;
      for (let q = 0; q < M; q++) { inside[q] = rs.inside(s.x[q], s.y[q]) ? 1 : 0; if (inside[q]) any = true; }
      if (!any) continue;
      const w = arcWeights(inside, s.s, s.L, T);
      acc ??= new Float64Array(M);
      for (let q = 0; q < M; q++) acc[q] += wj * w[q];
    }
    if (!acc) return null;
    let peak = 0;
    for (let q = 0; q < M; q++) { acc[q] /= tot; if (acc[q] > peak) peak = acc[q]; }
    return peak > 1e-4 ? acc : null;
  }

  /** Wave values of one style round a loop, with a whole number of stitches kept from layer to layer. */
  private values(style: WaveStyle, lock: number, s: LoopSamples, cx: number, cy: number, layer: number): Float64Array {
    const M = s.x.length, out = new Float64Array(M);
    if (!(style.height_mm > 0)) return out;
    const len = Math.max(0.2, style.length_mm);
    const map = this.locks[lock];
    const had = map.get(`${Math.round(cx / 2)}|${Math.round(cy / 2)}`);
    const n = makeRepeatLock(map)(cx, cy, Math.max(1, Math.round(s.L / len)), (c) => { const r = s.L / c / len; return r > 1 - FIT && r < 1 + FIT; });
    if (had !== undefined && had !== n) this.stats.repicks++;
    for (let q = 0; q < M; q++) out[q] = waveAt(style, n, s.u[q], layer);
    return out;
  }

  /** Keep ribs, thin fins and sharp corners plain: 1 on open wall, easing to 0 over a stitch or two at them. */
  private edgeFactor(s: LoopSamples, len: number, T: number): Float64Array | null {
    const M = s.x.length, L = s.L;
    if (M < 8) return null;
    const flag = new Uint8Array(M);
    // corners: the turn over ±W, against what a round loop of this length turns over the same stretch
    const W = Math.max(1, 0.5 * len), kW = Math.max(1, Math.round(W / (L / M)));
    const expected = (2 * kW * (L / M)) / (L / (2 * Math.PI));
    for (let i = 0; i < M; i++) {
      const a = (i - kW + M) % M, c = (i + kW) % M;
      const ux = s.x[i] - s.x[a], uy = s.y[i] - s.y[a], vx = s.x[c] - s.x[i], vy = s.y[c] - s.y[i];
      const lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
      if (lu < 1e-9 || lv < 1e-9) continue;
      const turn = Math.acos(Math.max(-1, Math.min(1, (ux * vx + uy * vy) / (lu * lv))));
      if (turn - expected > EDGE_TURN) flag[i] = 1;
    }
    // fins: the facing wall is close (a thin rib, both of its sides)
    const fin = Math.max(3, 1.5 * len);
    const pts = s.x.map((x, i) => ({ x, y: s.y[i], s: s.s[i] }));
    pts.push({ x: s.x[0], y: s.y[0], s: L });
    const gap = wallClearance(pts, true, fin);
    for (let i = 0; i < M; i++) if (gap[i] < fin) flag[i] = 1;
    const marks: number[] = [];
    for (let i = 0; i < M; i++) if (flag[i]) marks.push(s.s[i]);
    if (!marks.length) return null;
    const out = new Float64Array(M);
    for (let i = 0; i < M; i++) out[i] = smooth((nearest(marks, s.s[i], L) - 0.5 * len) / T);
    return out;
  }

  /**
   * The extra offset for loops of slicer layer i (on object o when the caller knows it). Returns null
   * from the term when no wave reaches the loop.
   */
  term(i: number, o?: number): ExtraOffset {
    return (s) => {
      if (!this.activeAt(i)) return null;
      const M = s.x.length;
      if (M < 4) return null;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, cx = 0, cy = 0;
      for (let q = 0; q < M; q++) {
        const x = s.x[q], y = s.y[q];
        cx += x; cy += y;
        if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
      cx /= M; cy /= M;
      const box: [number, number, number, number] = [minX, minY, maxX, maxY];
      const w0 = this.baseWeight(i);
      const parts: { k: number; w: Float64Array | number }[] = [];
      this.zones.forEach((z, k) => {
        if (z.kind === 'band') {
          const on = o !== undefined ? o === z.object : !this.opt.onObject || this.opt.onObject(z.object, i, s.x[0], s.y[0]);
          if (!on) return;
          const w = this.bandWeight(k, i);
          if (w > 0) parts.push({ k, w });
        } else {
          const w = this.shapeWeight(k, i, s, box);
          if (w) parts.push({ k, w });
        }
      });
      if (w0 <= 0 && !parts.some((p) => !this.zones[p.k].plain)) return null;
      const off = new Float64Array(M), str = new Float64Array(M);
      if (w0 > 0) {
        const v = this.values(this.base, 0, s, cx, cy, i);
        for (let q = 0; q < M; q++) { off[q] = w0 * v[q]; str[q] = w0; }
      }
      let len = w0 > 0 ? this.base.length_mm : Infinity;
      for (const { k, w } of parts) {
        const z = this.zones[k];
        const v = z.plain ? null : this.values(this.styles[k], k + 1, s, cx, cy, i);
        if (!z.plain) len = Math.min(len, this.styles[k].length_mm);
        let touched = false;
        for (let q = 0; q < M; q++) {
          const wz = typeof w === 'number' ? w : w[q];
          if (wz <= 0) continue;
          touched = true;
          off[q] = off[q] * (1 - wz) + (v ? v[q] * wz : 0);
          str[q] = str[q] * (1 - wz) + (v ? wz : 0);
        }
        if (touched) this.stats.zones.add(k);
      }
      let peak = 0;
      for (let q = 0; q < M; q++) peak = Math.max(peak, str[q]);
      if (peak <= 1e-4) return null;
      if (this.base.smooth_edges && Number.isFinite(len)) {
        const e = this.edgeFactor(s, len, Math.max(this.base.blend_mm, len));
        if (e) { this.stats.edgeLoops++; for (let q = 0; q < M; q++) { off[q] *= e[q]; str[q] *= e[q]; } }
      }
      // small loops (a neck, a tip): the wave may take at most 0.3 of the loop's inner radius, so it never folds
      const inr = (2 * Math.abs(s.area)) / s.L, cap = Math.min(0.3 * inr, this.opt.cap ?? Infinity);
      let big = 0;
      for (let q = 0; q < M; q++) big = Math.max(big, Math.abs(off[q]));
      if (big > cap && big > 0) { const f = cap / big; for (let q = 0; q < M; q++) off[q] *= f; }
      this.stats.layers.add(i);
      return { off, strength: str };
    };
  }
}

/** Only the style fields of a whole-part wave. */
export const pickStyle = (w: WaveStyle): WaveStyle => ({ shape: w.shape, height_mm: w.height_mm, length_mm: w.length_mm, flip_every: w.flip_every, flip_deg: w.flip_deg, flip_mode: w.flip_mode });
