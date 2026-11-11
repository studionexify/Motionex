// Pictures for weave mode: any RGBA image is scaled to the weave grid and reduced to the filament
// colours (nearest colour, optionally dithered), or to grey levels for one-filament relief. Pure
// functions on plain arrays, so they run the same in the browser, the worker and the tests.
import type { WeaveImage } from './model';

export type RGB = [number, number, number];
export type Dither = 'none' | 'floyd' | 'ordered';

/** "#rrggbb" or "#rgb" to [r, g, b] (0..255). */
export function parseHex(c: string): RGB {
  let h = c.trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((x) => x + x).join('');
  const n = parseInt(h.slice(0, 6), 16);
  return Number.isFinite(n) ? [(n >> 16) & 255, (n >> 8) & 255, n & 255] : [128, 128, 128];
}

/** Perceptual-ish RGB distance (weighted by the red mean), cheap and good enough for filament colours. */
export function colourDistance(a: RGB, b: RGB): number {
  const rm = (a[0] + b[0]) / 2, dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
  return (2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db;
}

const luma = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** Area-average resample of an RGBA buffer (alpha is composited over white). Returns RGB floats per pixel. */
export function resampleRGB(src: ArrayLike<number>, sw: number, sh: number, dw: number, dh: number): Float32Array {
  const out = new Float32Array(dw * dh * 3);
  const fx = sw / dw, fy = sh / dh;
  for (let y = 0; y < dh; y++) {
    const y0 = y * fy, y1 = (y + 1) * fy;
    for (let x = 0; x < dw; x++) {
      const x0 = x * fx, x1 = (x + 1) * fx;
      let r = 0, g = 0, b = 0, wsum = 0;
      for (let sy = Math.floor(y0); sy < Math.min(sh, Math.ceil(y1)); sy++) {
        const wy = Math.min(y1, sy + 1) - Math.max(y0, sy);
        for (let sx = Math.floor(x0); sx < Math.min(sw, Math.ceil(x1)); sx++) {
          const w = wy * (Math.min(x1, sx + 1) - Math.max(x0, sx));
          if (w <= 0) continue;
          const k = (sy * sw + sx) * 4, a = (src[k + 3] ?? 255) / 255;
          r += w * (src[k] * a + 255 * (1 - a)); g += w * (src[k + 1] * a + 255 * (1 - a)); b += w * (src[k + 2] * a + 255 * (1 - a));
          wsum += w;
        }
      }
      const o = (y * dw + x) * 3;
      out[o] = r / (wsum || 1); out[o + 1] = g / (wsum || 1); out[o + 2] = b / (wsum || 1);
    }
  }
  return out;
}

const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

/** RGB floats to the nearest palette colour per pixel, with optional error diffusion or ordered dither. */
export function quantize(rgb: Float32Array, w: number, h: number, palette: RGB[], dither: Dither = 'none'): number[] {
  const out = new Array<number>(w * h).fill(0);
  if (!palette.length) return out;
  const buf = Float32Array.from(rgb);
  const nearest = (r: number, g: number, b: number) => {
    let best = 0, bd = Infinity;
    const c: RGB = [r, g, b];
    palette.forEach((p, i) => { const d = colourDistance(c, p); if (d < bd) { bd = d; best = i; } });
    return best;
  };
  // ordered dither spreads by half the average gap between palette colours
  let spread = 0;
  if (dither === 'ordered' && palette.length > 1) {
    let s = 0, n = 0;
    for (let i = 0; i < palette.length; i++) for (let j = i + 1; j < palette.length; j++) { s += Math.sqrt(colourDistance(palette[i], palette[j]) / 8); n++; }
    spread = s / Math.max(1, n) / 2;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const k = (y * w + x) * 3;
    let r = buf[k], g = buf[k + 1], b = buf[k + 2];
    if (dither === 'ordered') { const t = (BAYER4[(y % 4) * 4 + (x % 4)] / 16 - 0.5) * spread; r += t; g += t; b += t; }
    const i = nearest(r, g, b);
    out[y * w + x] = i;
    if (dither !== 'floyd') continue;
    const p = palette[i], er = r - p[0], eg = g - p[1], eb = b - p[2];
    const push = (dx: number, dy: number, f: number) => {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || xx >= w || yy >= h) return;
      const q = (yy * w + xx) * 3;
      buf[q] += er * f; buf[q + 1] += eg * f; buf[q + 2] += eb * f;
    };
    push(1, 0, 7 / 16); push(-1, 1, 3 / 16); push(0, 1, 5 / 16); push(1, 1, 1 / 16);
  }
  return out;
}

/** RGB floats to `levels` grey steps: 0 = lightest, levels − 1 = darkest. */
export function greyLevels(rgb: Float32Array, w: number, h: number, levels: number, dither: Dither = 'none', invert = false): number[] {
  const n = Math.max(2, Math.round(levels));
  const grey: RGB[] = Array.from({ length: n }, (_, i) => { const v = 255 * (1 - i / (n - 1)); return [v, v, v]; });
  const g = new Float32Array(rgb.length);
  for (let k = 0; k < rgb.length; k += 3) { let l = luma(rgb[k], rgb[k + 1], rgb[k + 2]); if (invert) l = 255 - l; g[k] = g[k + 1] = g[k + 2] = l; }
  return quantize(g, w, h, grey, dither);
}

/** Most distinct colours in a picture (k-means, seeded from the extremes), lightest first. */
export function suggestPalette(rgb: Float32Array, k: number): RGB[] {
  const n = rgb.length / 3, K = Math.max(1, Math.min(k, n));
  const step = Math.max(1, Math.floor(n / 4000));
  const pts: RGB[] = [];
  for (let i = 0; i < n; i += step) pts.push([rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]]);
  pts.sort((a, b) => luma(...a) - luma(...b));
  let cs: RGB[] = Array.from({ length: K }, (_, i) => [...pts[Math.round((i / Math.max(1, K - 1)) * (pts.length - 1))]] as RGB);
  for (let it = 0; it < 12; it++) {
    const sum = cs.map(() => [0, 0, 0, 0]);
    for (const p of pts) {
      let best = 0, bd = Infinity;
      cs.forEach((c, i) => { const d = colourDistance(p, c); if (d < bd) { bd = d; best = i; } });
      const s = sum[best]; s[0] += p[0]; s[1] += p[1]; s[2] += p[2]; s[3]++;
    }
    cs = cs.map((c, i) => (sum[i][3] ? [sum[i][0] / sum[i][3], sum[i][1] / sum[i][3], sum[i][2] / sum[i][3]] as RGB : c));
  }
  return cs.map((c) => c.map(Math.round) as RGB).sort((a, b) => luma(...b) - luma(...a));
}

/** Nearest-neighbour resize of a palette picture. */
export function resizeImage(img: WeaveImage, w: number, h: number): WeaveImage {
  const W = Math.max(1, Math.round(w)), H = Math.max(1, Math.round(h));
  const px = new Array<number>(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++)
    px[y * W + x] = img.px[Math.min(img.h - 1, Math.floor(((y + 0.5) / H) * img.h)) * img.w + Math.min(img.w - 1, Math.floor(((x + 0.5) / W) * img.w))] ?? 0;
  return { ...img, w: W, h: H, px };
}

/** Palette index at column x, row y (row 0 = top); x wraps round, y is clamped. */
export function pixelAt(img: WeaveImage, x: number, y: number): number {
  const xx = ((Math.floor(x) % img.w) + img.w) % img.w, yy = Math.max(0, Math.min(img.h - 1, Math.floor(y)));
  return img.px[yy * img.w + xx] ?? 0;
}

/** Remap palette indices (e.g. after a colour was removed): indices ≥ n fold onto the last one. */
export function clampPalette(img: WeaveImage, n: number): WeaveImage {
  if (img.px.every((v) => v < n)) return img;
  return { ...img, px: img.px.map((v) => Math.min(v, Math.max(0, n - 1))) };
}

/** Columns and rows for a part of circumference `around` mm and band height `tall` mm. */
export function gridFor(around: number, tall: number, pixelMm: number, rowMm: number, aspect: number, tiles = 1): { w: number; h: number } {
  const w = Math.max(4, Math.round(around / Math.max(0.2, pixelMm) / Math.max(1, tiles)));
  // keep the picture's aspect: a pixel is pixelMm wide and rowMm tall on the part
  const fromAspect = Math.round((w * pixelMm * aspect) / Math.max(0.05, rowMm));
  const fit = Math.max(1, Math.floor(tall / Math.max(0.05, rowMm)));
  return { w, h: Math.max(2, Math.min(fit, fromAspect || fit)) };
}
