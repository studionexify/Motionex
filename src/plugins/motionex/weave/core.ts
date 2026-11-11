// Weave geometry shared by the slicer pass and the quick preview.
// Layer plan: which colour each layer prints and which picture row it belongs to.
// Loop weave: for one closed outer wall loop, every point's sideways offset (out where the picture
// shows this layer's colour, in where it doesn't), then the offset line itself.
import { CALIBRATION_STEPS, colourCount, cycleLayers, type WeaveSettings } from './model';
import { pixelAt } from './image';

/** Where a layer sits in the weave. null = outside the woven band. */
export interface WeaveLayer {
  /** Layer number inside the band (0 = first woven layer). */
  k: number;
  /** Palette index this layer prints (colour mode) or 0 (mono). */
  colour: number;
  /** Picture row (0 = top row of the picture). */
  row: number;
  /** Rows counted from the bottom of the band, for drift (twist). */
  rowFromBottom: number;
  /** Depth multiplier (calibration ladder), 1 otherwise. */
  depthMul: number;
  /** Mono: in/out layer of the pair (0 or 1). */
  parity: number;
}

export const inBand = (w: WeaveSettings, z: number) => z >= w.z_start - 1e-6 && z <= w.z_end + 1e-6;

/** Palette index printed by the k-th woven layer. */
export const colourOfLayer = (w: WeaveSettings, k: number) => (w.mode === 'colour' ? Math.floor(k / Math.max(1, Math.round(w.layers_per_colour))) % colourCount(w) : 0);

/** Filament slot of a layer at height z (layer top): the band cycles the colours, outside it prints the first one. */
export function filamentAt(w: WeaveSettings, layerZ: number[], i: number): number {
  const first = layerZ.findIndex((z) => inBand(w, z));
  if (w.mode !== 'colour' || first < 0 || i < first || !inBand(w, layerZ[i])) return w.slots[0] ?? 0;
  return w.slots[colourOfLayer(w, i - first)] ?? w.slots[0] ?? 0;
}

/**
 * Plan for every layer. `perimeters[i]` is the outer loop length of layer i (NaN when unknown); with
 * follow_curve the rows are measured along the wall's profile (height and change of radius), so a
 * bulging belly gets as many rows per mm of wall as a straight neck.
 */
export function planLayers(w: WeaveSettings, layerZ: number[], perimeters?: number[]): (WeaveLayer | null)[] {
  const N = layerZ.length, out: (WeaveLayer | null)[] = new Array(N).fill(null);
  const band: number[] = [];
  for (let i = 0; i < N; i++) if (inBand(w, layerZ[i])) band.push(i);
  if (!band.length || !w.image.w || !w.image.h) return out;
  const cyc = cycleLayers(w);
  // distance up the wall at each band layer
  const s = new Float64Array(band.length);
  let lastR = NaN;
  for (let j = 0; j < band.length; j++) {
    const i = band[j], dz = j ? layerZ[i] - layerZ[band[j - 1]] : 0;
    const r = perimeters && Number.isFinite(perimeters[i]) && perimeters[i] > 0 ? perimeters[i] / (2 * Math.PI) : NaN;
    const dr = w.follow_curve && Number.isFinite(r) && Number.isFinite(lastR) ? r - lastR : 0;
    s[j] = (j ? s[j - 1] : 0) + Math.hypot(dz, dr);
    if (Number.isFinite(r)) lastR = r;
  }
  const total = s[band.length - 1] || 1;
  const cycles = Math.ceil(band.length / cyc);
  const cycleH = band.length > 1 ? (s[band.length - 1] / (band.length - 1)) * cyc : cyc * 0.2;
  const H = w.image.h;
  for (let j = 0; j < band.length; j++) {
    const c = Math.floor(j / cyc), at = s[Math.min(band.length - 1, c * cyc)];
    let fromBottom: number;
    if (w.fit_height === 'tile') fromBottom = Math.floor(at / Math.max(1e-3, cycleH) + 1e-6);
    else fromBottom = cycles <= 1 ? 0 : Math.min(H - 1, Math.floor((at / total) * H * (1 - 1e-9)));
    const rowInPic = ((fromBottom % H) + H) % H;
    const depthMul = w.calibration ? CALIBRATION_STEPS[Math.min(CALIBRATION_STEPS.length - 1, Math.floor((s[j] / total) * CALIBRATION_STEPS.length * (1 - 1e-9)))] : 1;
    out[band[j]] = { k: j, colour: colourOfLayer(w, j), row: H - 1 - rowInPic, rowFromBottom: fromBottom, depthMul, parity: Math.floor(j / Math.max(1, Math.round(w.layers_per_colour))) % 2 };
  }
  return out;
}

/** Stitch shape across one pixel (t = 0..1): full height in the middle, dipping by `stitch` at its edges. */
const stitchShape = (stitch: number, t: number) => 1 - Math.max(0, Math.min(1, stitch)) * (1 - Math.sin(Math.PI * t));

/** Hand-made move (mm, + = out) for the pixel under column position x on picture row `row`; 0 when none or the grid changed. */
export function nudgeAt(w: WeaveSettings, row: number, x: number): number {
  const n = w.nudge, img = w.image;
  if (!n || n.w !== img.w || n.h !== img.h) return 0;
  const col = ((Math.floor(x) % img.w) + img.w) % img.w;
  return n.d[Math.max(0, Math.min(img.h - 1, row)) * img.w + col] ?? 0;
}

/** Sideways offset (mm, + = out of the part) at fraction u (0..1) round the loop on a woven layer. */
export function offsetAt(w: WeaveSettings, L: WeaveLayer, u: number): number {
  const img = w.image;
  const x = u * img.w * Math.max(1, w.tiles_around) + w.shift_px_per_row * L.rowFromBottom;
  const p = pixelAt(img, x, L.row), t = x - Math.floor(x);
  const D = w.depth_mm * L.depthMul;
  let off: number;
  if (w.picture?.kind === 'none') off = 0;
  else if (w.mode === 'colour') off = p === L.colour ? D * stitchShape(w.stitch, t) : -D * w.recess;
  else {
    // mono: palette index = darkness level
    const levels = levelsOf(img);
    const dark = levels > 1 ? p / (levels - 1) : 0;
    off = w.mono_style === 'emboss' ? D * (1 - 2 * dark) * stitchShape(w.stitch, t) : dark * D * (L.parity ? -w.recess : 1) * stitchShape(w.stitch, t);
  }
  // hand-made moves shift every layer of the pixel together, so the stack moves as one
  off += nudgeAt(w, L.row, x);
  const cap = w.max_deviation_mm > 0 ? w.max_deviation_mm : Infinity;
  return Math.max(-cap, Math.min(cap, off));
}

const LEVELS = new WeakMap<object, number>();
/** Grey levels a mono picture uses (highest index + 1). */
function levelsOf(img: WeaveSettings['image']): number {
  let n = LEVELS.get(img);
  if (n === undefined) { n = 1; for (const v of img.px) if (v + 1 > n) n = v + 1; LEVELS.set(img, n); }
  return n;
}

/** Visible palette index at fraction u on a picture row (what the preview colours a pixel). */
export function visibleAt(w: WeaveSettings, L: WeaveLayer, u: number): number {
  const x = u * w.image.w * Math.max(1, w.tiles_around) + w.shift_px_per_row * L.rowFromBottom;
  return pixelAt(w.image, x, L.row);
}

export interface Pt { x: number; y: number }
export interface WovenPoint {
  x: number; y: number; /** outward normal */ nx: number; ny: number; /** index of the source segment */ src: number; lat: number; /** fraction round the loop (picture column) */ u: number;
  /** Strength of the wave texture here (0..1), when one was added. */
  wave?: number;
}

/** The resampled loop handed to an extra offset term: positions, arc length and picture column of each sample. */
export interface LoopSamples {
  x: number[]; y: number[];
  /** Arc length from the loop's first point (mm). */
  s: number[];
  /** Fraction round the loop from the +X direction, the same way up as the picture. */
  u: Float64Array;
  /** Loop length (mm). */
  L: number;
  /** Signed area (mm², + = counter-clockwise). */
  area: number;
}

/** An offset added after the picture is eased (so short stitches keep their full height), with its strength. */
export type ExtraOffset = (s: LoopSamples) => { off: Float64Array; strength: Float64Array } | null;

/** Signed area of a closed polyline (last point may repeat the first). + = counter-clockwise. */
export function signedArea(p: Pt[]): number {
  let a = 0;
  for (let i = 0; i < p.length; i++) { const q = p[(i + 1) % p.length], c = p[i]; a += c.x * q.y - q.x * c.y; }
  return a / 2;
}

/**
 * Weave one closed loop. `pts` is the loop (first point not repeated at the end); `lat(u)` the target
 * offset at fraction u round the loop, measured from the point nearest the +X direction from the loop's
 * centre (so pixels stack straight from layer to layer whatever the seam). The result starts at the seam
 * (the point nearest `seamDeg`), and is closed: its last point equals its first. `extra` (the wave texture)
 * is added after the picture is eased.
 */
export function weaveLoop(pts: Pt[], lat: ((u: number) => number) | null, step: number, smoothMm: number, seamDeg: number, extra?: ExtraOffset): WovenPoint[] {
  const n = pts.length;
  if (n < 3) return [];
  // resample, remembering the source segment of each sample
  const sx: number[] = [], sy: number[] = [], ss: number[] = [], src: number[] = [];
  let s = 0;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n], len = Math.hypot(b.x - a.x, b.y - a.y);
    const m = Math.max(1, Math.ceil(len / step - 1e-9));
    for (let k = 0; k < m; k++) { const t = k / m; sx.push(a.x + (b.x - a.x) * t); sy.push(a.y + (b.y - a.y) * t); ss.push(s + len * t); src.push(i); }
    s += len;
  }
  const L = s, M = sx.length;
  if (L <= 1e-6) return [];
  let cx = 0, cy = 0;
  for (let i = 0; i < M; i++) { cx += sx[i]; cy += sy[i]; }
  cx /= M; cy /= M;
  const ccw = signedArea(pts) >= 0;
  // u origin: the sample nearest +X from the centre; seam: nearest the seam direction
  const ang = (i: number) => Math.atan2(sy[i] - cy, sx[i] - cx);
  const seamRad = (seamDeg * Math.PI) / 180;
  let i0 = 0, b0 = Infinity, iS = 0, bS = Infinity;
  for (let i = 0; i < M; i++) {
    const a = Math.abs(ang(i)); if (a < b0) { b0 = a; i0 = i; }
    const d = Math.abs(Math.atan2(Math.sin(ang(i) - seamRad), Math.cos(ang(i) - seamRad))); if (d < bS) { bS = d; iS = i; }
  }
  const off = new Float64Array(M), us = new Float64Array(M);
  for (let i = 0; i < M; i++) {
    let u = (ss[i] - ss[i0]) / L; u -= Math.floor(u);
    if (!ccw) u = (1 - u) % 1; // clockwise loops run the other way round: keep the picture the same way up
    us[i] = u;
  }
  if (lat) {
    for (let i = 0; i < M; i++) off[i] = lat(us[i]);
    // ease between pixels: circular box filter over smoothMm
    const h = Math.round(smoothMm / 2 / (L / M));
    if (h > 0) {
      const pre = new Float64Array(M + 1);
      for (let i = 0; i < M; i++) pre[i + 1] = pre[i] + off[i];
      const sum = (a: number, b: number) => pre[b] - pre[a];
      const sm = new Float64Array(M);
      for (let i = 0; i < M; i++) {
        const a = i - h, b = i + h + 1;
        let t = 0;
        if (a < 0) t += sum(M + a, M) + sum(0, b);
        else if (b > M) t += sum(a, M) + sum(0, b - M);
        else t += sum(a, b);
        sm[i] = t / (2 * h + 1);
      }
      off.set(sm);
    }
  }
  const add = extra ? extra({ x: sx, y: sy, s: ss, u: us, L, area: signedArea(pts) }) : null;
  if (add) for (let i = 0; i < M; i++) off[i] += add.off[i];
  let maxOff = 0;
  for (let i = 0; i < M; i++) maxOff = Math.max(maxOff, Math.abs(off[i]));
  // tangent from the chord over ±R: turns gradually through corners so the offset line never folds
  const R = Math.min(Math.max(step, 1.6 * maxOff), L / 4);
  const posAt = (q: number): [number, number] => {
    q = ((q % L) + L) % L;
    let lo = 0, hi = M - 1;
    if (q >= ss[M - 1]) { const t = (q - ss[M - 1]) / (L - ss[M - 1]); return [sx[M - 1] + (sx[0] - sx[M - 1]) * t, sy[M - 1] + (sy[0] - sy[M - 1]) * t]; }
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (ss[m] <= q) lo = m; else hi = m; }
    const d = ss[hi] - ss[lo], t = d > 0 ? (q - ss[lo]) / d : 0;
    return [sx[lo] + (sx[hi] - sx[lo]) * t, sy[lo] + (sy[hi] - sy[lo]) * t];
  };
  const out: WovenPoint[] = [];
  for (let j = 0; j <= M; j++) {
    const i = (iS + j) % M;
    const [ax, ay] = posAt(ss[i] - R), [bx, by] = posAt(ss[i] + R);
    let tx = bx - ax, ty = by - ay;
    const l = Math.hypot(tx, ty) || 1;
    tx /= l; ty /= l;
    // outward: right of travel on a counter-clockwise loop, left on a clockwise one
    const nx = ccw ? ty : -ty, ny = ccw ? -tx : tx;
    const p: WovenPoint = { x: sx[i] + nx * off[i], y: sy[i] + ny * off[i], nx, ny, src: src[i], lat: off[i], u: us[i] };
    if (add) p.wave = add.strength[i];
    out.push(p);
  }
  return out;
}
