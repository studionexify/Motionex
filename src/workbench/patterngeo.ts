// Pattern geometry. Every sharp-edged pattern is turned into exact outlines: its formula is evaluated on a
// fine grid (RES samples per pattern cell), each raised level is separated by its true boundary, and a signed
// Euclidean distance field to that boundary is built (exact EDT, periodic). Relief height is then a function
// of real distance in millimetres: flat plateaus, straight bevels of a chosen width, crisp corners — the same
// way CAD tools offset a 2-D profile. The mesher snaps vertices exactly onto the bevel's top and foot lines.
// Smooth patterns (domes, waves, grain) keep their continuous formula.
import { PATTERNS, sampleMapCubic, type HeightMap } from './reliefs';

const RES = 128;   // samples per pattern cell (≈0.3 mm on a 30 mm cell; sub-sample accurate after interpolation)
const TILE = 10;   // tile size in cells: a common period of every pattern's internal repeats

export interface Level { d: Float32Array; step: number }
/** sharp: flat plateaus with exact outlines. hybrid: smooth shading inside regions, exact outlines where the
 *  height jumps (seigaiha, scales, quilted…): heights come from the formula, edges from the distance field. */
export interface Geo { sharp: boolean; hybrid?: boolean; iso?: number; W: number; H: number; pu: number; pv: number; base: number; levels: Level[] }

// ── exact squared EDT (Felzenszwalb–Huttenlocher), periodic via a 3× unrolled line
function edt1(f: Float64Array, n: number, out: Float64Array, v: Int32Array, z: Float64Array) {
  let k = 0; v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
    k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) { while (z[k + 1] < q) k++; out[q] = (q - v[k]) * (q - v[k]) + f[v[k]]; }
}
/** Squared distance (px²) from every pixel to the nearest seed pixel, wrapping in both directions. */
function edt(seed: Uint8Array, W: number, H: number): Float64Array {
  const INF = 1e20, D = new Float64Array(W * H);
  const n = 3 * Math.max(W, H), f = new Float64Array(n), o = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  for (let x = 0; x < W; x++) {
    for (let r = 0; r < 3; r++) for (let y = 0; y < H; y++) f[r * H + y] = seed[y * W + x] ? 0 : INF;
    edt1(f, 3 * H, o, v, z);
    for (let y = 0; y < H; y++) D[y * W + x] = o[H + y];
  }
  for (let y = 0; y < H; y++) {
    for (let r = 0; r < 3; r++) for (let x = 0; x < W; x++) f[r * W + x] = D[y * W + x];
    edt1(f, 3 * W, o, v, z);
    for (let x = 0; x < W; x++) D[y * W + x] = o[W + x];
  }
  return D;
}
/** Signed distance (in cells, negative inside) to the boundary of `inside`. */
function signedField(inside: Uint8Array, W: number, H: number, pxPerCell: number): Float32Array {
  const out = new Uint8Array(W * H); for (let i = 0; i < out.length; i++) out[i] = inside[i] ? 0 : 1;
  const dOut = edt(inside, W, H), dIn = edt(out, W, H), s = new Float32Array(W * H);
  // boundary lies half a sample between an inside and an outside sample
  for (let i = 0; i < s.length; i++) s[i] = (inside[i] ? -(Math.sqrt(dIn[i]) - 0.5) : Math.sqrt(dOut[i]) - 0.5) / pxPerCell;
  // The sampled boundary is a pixel staircase; a distance field is locally linear, so a light binomial
  // smoothing (two passes of [1 4 6 4 1]) removes the staircase while moving straight edges not at all and
  // rounding corners by well under a millimetre.
  const t = new Float32Array(W * H);
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < H; y++) { const r = y * W; for (let x = 0; x < W; x++) t[r + x] = (s[r + (x + W - 2) % W] + 4 * s[r + (x + W - 1) % W] + 6 * s[r + x] + 4 * s[r + (x + 1) % W] + s[r + (x + 2) % W]) / 16; }
    for (let y = 0; y < H; y++) { const a = ((y + H - 2) % H) * W, b = ((y + H - 1) % H) * W, c = y * W, dd = ((y + 1) % H) * W, e = ((y + 2) % H) * W; for (let x = 0; x < W; x++) s[c + x] = (t[a + x] + 4 * t[b + x] + 6 * t[c + x] + 4 * t[dd + x] + t[e + x]) / 16; }
  }
  return s;
}

/** Plateau levels of a sampled field: clusters of the histogram; returns thresholds between them. */
function plateaus(vals: Float32Array): { sharp: boolean; base: number; cuts: { iso: number; step: number }[] } {
  const B = 64, hist = new Float64Array(B);
  let mid = 0;
  for (const x of vals) { const c = Math.min(1, Math.max(0, x)); hist[Math.min(B - 1, Math.floor(c * B))]++; if (c > 0.12 && c < 0.88) mid++; }
  const sharp = mid / vals.length < 0.14;
  if (!sharp) return { sharp, base: 0, cuts: [] };
  const peaks: { c: number; m: number }[] = [];
  for (let i = 0; i < B; i++) {
    if (hist[i] / vals.length < 0.02) continue;
    const last = peaks[peaks.length - 1];
    const c = (i + 0.5) / B;
    if (last && c - last.c < 0.09) { const m = last.m + hist[i]; last.c = (last.c * last.m + c * hist[i]) / m; last.m = m; }
    else peaks.push({ c, m: hist[i] });
  }
  if (peaks.length < 2) return { sharp: false, base: 0, cuts: [] };
  let top = peaks.sort((a, b) => a.c - b.c);
  if (top.length > 4) top = [...top].sort((a, b) => b.m - a.m).slice(0, 4).sort((a, b) => a.c - b.c);
  const cuts = [];
  for (let i = 1; i < top.length; i++) cuts.push({ iso: (top[i - 1].c + top[i].c) / 2, step: top[i].c - top[i - 1].c });
  return { sharp: true, base: top[0].c, cuts };
}

const geoCache = new Map<string, Geo>();
const mapCache = new WeakMap<HeightMap, Geo>();

/** Geometry of a library pattern (cached per pattern, seed and minimum line width). */
export function patternGeo(id: string, seed: number, key: string): Geo | null {
  const ck = `${id}|${seed}|${key}`;
  let g = geoCache.get(ck);
  if (g) return g;
  const p = PATTERNS.find((x) => x.id === id); if (!p) return null;
  const W = TILE * RES, H = TILE * RES, vals = new Float32Array(W * H);
  for (let y = 0; y < H; y++) { const vv = (y + 0.5) / RES; for (let x = 0; x < W; x++) vals[y * W + x] = p.fn((x + 0.5) / RES, vv, seed); }
  g = build(vals, W, H, RES, TILE, TILE, false, (x, y) => p.fn(x / RES, y / RES, seed));
  if (geoCache.size > 6) geoCache.delete(geoCache.keys().next().value!);
  geoCache.set(ck, g);
  return g;
}

/** Geometry of an imported picture traced as outlines (one tile = the picture). */
export function mapGeo(m: HeightMap): Geo {
  let g = mapCache.get(m);
  if (g) return g;
  const sc = Math.max(1, Math.min(4, Math.round(1024 / Math.max(m.w, m.h))));
  const W = m.w * sc, H = m.h * sc, vals = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) vals[y * W + x] = sampleMapCubic(m, (x + 0.5) / W, (y + 0.5) / H);
  // pixels per tile differ in u and v; distances are measured in u-pixels (aspect handled at lookup)
  g = build(vals, W, H, (W + H) / 2, 1, 1, true, (x, y) => sampleMapCubic(m, x / W, y / H));
  mapCache.set(m, g);
  return g;
}

function build(vals: Float32Array, W: number, H: number, pxPerCell: number, pu: number, pv: number, force: boolean, at: (x: number, y: number) => number): Geo {
  const pl = plateaus(vals);
  if (!pl.sharp && !force) {
    // look for jumps: neighbouring samples (1/RES of a cell apart) that differ by more than a smooth slope can
    const mids: number[] = []; let pairs = 0;
    for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) {
      const a = vals[y * W + x], b = vals[y * W + (x + 1) % W], c = vals[((y + 1) % H) * W + x];
      pairs += 2;
      if (Math.abs(a - b) > 0.15) mids.push((a + b) / 2);
      if (Math.abs(a - c) > 0.15) mids.push((a + c) / 2);
    }
    if (mids.length < pairs * 0.002) return { sharp: false, W, H, pu, pv, base: 0, levels: [] };
    mids.sort((p, q) => p - q);
    const iso = mids[Math.floor(mids.length / 2)];
    const inside = new Uint8Array(W * H); for (let i = 0; i < inside.length; i++) inside[i] = vals[i] > iso ? 1 : 0;
    const d = signedField(inside, W, H, pxPerCell);
    refine(d, W, H, pxPerCell, iso, at);
    return { sharp: true, hybrid: true, iso, W, H, pu, pv, base: 0, levels: [{ d, step: 1 }] };
  }
  const cuts = pl.sharp ? pl.cuts : [{ iso: 0.5, step: 1 }];
  const levels: Level[] = cuts.map(({ iso, step }) => {
    const inside = new Uint8Array(W * H); for (let i = 0; i < inside.length; i++) inside[i] = vals[i] > iso ? 1 : 0;
    const d = signedField(inside, W, H, pxPerCell);
    refine(d, W, H, pxPerCell, iso, at);
    return { d, step };
  });
  return { sharp: true, W, H, pu, pv, base: pl.sharp ? pl.base : 0, levels };
}

/** Bilinear lookup of a level's signed distance (cells) at pattern coordinates (u, v). */
export function geoSd(g: Geo, lv: Level, u: number, v: number): number {
  const x = (((u / g.pu) % 1) + 1) % 1 * g.W - 0.5, y = (((v / g.pv) % 1) + 1) % 1 * g.H - 0.5;
  const x0 = Math.floor(x), y0 = Math.floor(y), tx = x - x0, ty = y - y0;
  const W = g.W, H = g.H, X0 = (x0 + W) % W, X1 = (x0 + 1) % W, Y0 = (y0 + H) % H, Y1 = (y0 + 1) % H, d = lv.d;
  const a = d[Y0 * W + X0], b = d[Y0 * W + X1], c = d[Y1 * W + X0], e = d[Y1 * W + X1];
  return (a + (b - a) * tx) * (1 - ty) + (c + (e - c) * tx) * ty;
}

/** Bevel profile: 0 at the foot (sd = +bevel/2), 1 on top (sd = −bevel/2), straight in between. */
export const bevelH = (sdMM: number, bevelMM: number) => Math.min(1, Math.max(0, 0.5 - sdMM / bevelMM));

/** Near every edge, replace the sampled distance with the exact one. Pass 1 finds a true boundary point next
 *  to every edge sample (march along the field's normal, bisect the pattern formula itself). Pass 2 measures
 *  each sample's distance to the boundary through its nearest exact boundary points (to the line through the
 *  two nearest, which is exact on straight edges and corners alike). No pixel steps remain. */
function refine(d: Float32Array, W: number, H: number, ppc: number, iso: number, at: (x: number, y: number) => number) {
  const band = 3 / ppc;
  const g = (x: number, y: number) => at(((x % W) + W) % W, ((y % H) + H) % H) - iso;
  const bx = new Float32Array(W * H).fill(NaN), by = new Float32Array(W * H), inside = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const k = y * W + x, s0 = d[k];
    if (Math.abs(s0) > band) continue;
    const px = x + 0.5, py = y + 0.5, f0 = g(px, py); inside[k] = f0 > 0 ? 1 : 0;
    if (Math.abs(s0) * ppc > 1.6) continue;                       // boundary points only from samples right at the edge
    const gx = d[y * W + (x + 1) % W] - d[y * W + (x + W - 1) % W], gy = d[((y + 1) % H) * W + x] - d[((y + H - 1) % H) * W + x];
    const gl = Math.hypot(gx, gy); if (gl < 1e-9) continue;
    const nx = gx / gl, ny = gy / gl, reach = 2.5;
    let lo = 0, hi = 0, flo = f0, found = false;
    for (const dir of [s0 > 0 ? -1 : 1, s0 > 0 ? 1 : -1]) {
      let prevT = 0, prevF = f0;
      for (let k2 = 1; k2 <= 5; k2++) {
        const t = (dir * reach * k2) / 5, f = g(px + nx * t, py + ny * t);
        if ((f > 0) !== (prevF > 0)) { lo = prevT; hi = t; flo = prevF; found = true; break; }
        prevT = t; prevF = f;
      }
      if (found) break;
    }
    if (!found) continue;
    for (let it = 0; it < 14; it++) { const m = (lo + hi) / 2, fm = g(px + nx * m, py + ny * m); if ((fm > 0) === (flo > 0)) { lo = m; flo = fm; } else hi = m; }
    const tb = (lo + hi) / 2;
    bx[k] = px + nx * tb; by[k] = py + ny * tb;
  }
  const R = 3;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const k = y * W + x; if (Math.abs(d[k]) > band) continue;
    const px = x + 0.5, py = y + 0.5;
    let d1 = Infinity, d2 = Infinity, x1 = 0, y1 = 0, x2 = 0, y2 = 0;
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      const kk = ((y + dy + H) % H) * W + ((x + dx + W) % W), qx = bx[kk];
      if (Number.isNaN(qx)) continue;
      const qy = by[kk] + dy - ((y + dy + H) % H - y) + 0, qxx = qx + dx - ((x + dx + W) % W - x);
      const dd = (qxx - px) ** 2 + (qy - py) ** 2;
      if (dd < d1) { if (Math.hypot(qxx - x1, qy - y1) > 0.25 || d1 === Infinity) { d2 = d1; x2 = x1; y2 = y1; } d1 = dd; x1 = qxx; y1 = qy; }
      else if (dd < d2 && Math.hypot(qxx - x1, qy - y1) > 0.25) { d2 = dd; x2 = qxx; y2 = qy; }
    }
    if (d1 === Infinity) continue;
    let dist = Math.sqrt(d1);
    if (d2 !== Infinity) {
      const ex = x2 - x1, ey = y2 - y1, el = Math.hypot(ex, ey);
      if (el > 0.25 && el < 2.5) {
        const t = ((px - x1) * ex + (py - y1) * ey) / (el * el);
        if (t > -0.5 && t < 1.5) dist = Math.min(dist, Math.abs((px - x1) * ey - (py - y1) * ex) / el);
      }
    }
    d[k] = (inside[k] ? -dist : dist) / ppc;
  }
}
