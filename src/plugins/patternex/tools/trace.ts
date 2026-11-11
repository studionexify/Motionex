// Raster → vector: quantise a PNG/JPG to 1–4 colours (k-means in Lab, or snapped to the loaded filaments),
// then trace each colour's pixel mask into outlines (pixel-edge tracing, then simplified).
import type { Pattern, Ring } from '../model';
import { deltaE, hexOf, lab, patternOf, ringArea, simplifyRing, solidRings } from './shape';
import { rng } from '../library/geom';

export interface RasterImage { width: number; height: number; /** RGBA, row-major, top row first. */ data: Uint8ClampedArray | Uint8Array }

export interface TraceSpec {
  colors: number;
  /** Snap colours to these (the loaded filaments) instead of free k-means. */
  palette?: string[];
  /** Output width in mm. */
  width_mm: number;
  /** Alpha below this is background (not traced). */
  alphaCut: number;
  /** Treat the most common colour (usually the background) as base: not traced. */
  dropBackground: boolean;
  smooth_mm: number;
  speck_mm2: number;
}
export const defaultTraceSpec = (): TraceSpec => ({ colors: 2, width_mm: 40, alphaCut: 128, dropBackground: true, smooth_mm: 0.15, speck_mm2: 0.3 });

/** k-means++ in Lab on (sub-sampled) opaque pixels. Returns centres as hex. */
export function quantise(img: RasterImage, k: number, alphaCut: number, seed = 1): string[] {
  const px: [number, number, number][] = [], lb: [number, number, number][] = [];
  const step = Math.max(1, Math.floor(Math.sqrt((img.width * img.height) / 20000)));
  for (let y = 0; y < img.height; y += step) for (let x = 0; x < img.width; x += step) {
    const i = (y * img.width + x) * 4;
    if (img.data[i + 3] < alphaCut) continue;
    const c: [number, number, number] = [img.data[i], img.data[i + 1], img.data[i + 2]];
    px.push(c); lb.push(lab(c));
  }
  if (!px.length) return [];
  const r = rng(seed);
  const cent: [number, number, number][] = [lb[Math.floor(r() * lb.length)]];
  const d2 = (a: number[], b: number[]) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
  while (cent.length < Math.min(k, px.length)) {
    const ds = lb.map((p) => Math.min(...cent.map((c) => d2(p, c))));
    const tot = ds.reduce((a, b) => a + b, 0);
    if (tot <= 0) break;
    let t = r() * tot, i = 0;
    while (t > ds[i] && i < ds.length - 1) t -= ds[i++];
    cent.push(lb[i]);
  }
  const asg = new Int32Array(lb.length);
  for (let it = 0; it < 20; it++) {
    lb.forEach((p, i) => { let b = 0, bd = Infinity; cent.forEach((c, j) => { const d = d2(p, c); if (d < bd) { bd = d; b = j; } }); asg[i] = b; });
    const sum = cent.map(() => [0, 0, 0, 0]);
    px.forEach((p, i) => { const s = sum[asg[i]]; s[0] += p[0]; s[1] += p[1]; s[2] += p[2]; s[3]++; });
    sum.forEach((s, j) => { if (s[3]) cent[j] = lab([s[0] / s[3], s[1] / s[3], s[2] / s[3]]); });
  }
  // report centres as the mean sRGB of their pixels
  const sum = cent.map(() => [0, 0, 0, 0]);
  px.forEach((p, i) => { const s = sum[asg[i]]; s[0] += p[0]; s[1] += p[1]; s[2] += p[2]; s[3]++; });
  return sum.filter((s) => s[3]).map((s) => hexOf([s[0] / s[3], s[1] / s[3], s[2] / s[3]]));
}

/** Nearest palette colour by ΔE (palette quantisation to the AMS filaments). */
export const nearest = (c: string, palette: string[]) => palette.reduce((b, p) => (deltaE(c, p) < deltaE(c, b) ? p : b), palette[0]);

/** Boundary tracing of a binary mask along pixel edges: closed outlines in pixel units (Y down). */
export function traceMask(mask: Uint8Array, w: number, h: number): [number, number][][] {
  // edges between inside and outside pixels, walked into loops (pixel-corner lattice)
  const at = (x: number, y: number) => (x >= 0 && y >= 0 && x < w && y < h ? mask[y * w + x] : 0);
  const next = new Map<number, number[]>();
  const key = (x: number, y: number) => y * (w + 1) + x;
  const add = (x0: number, y0: number, x1: number, y1: number) => { const k = key(x0, y0); const l = next.get(k); if (l) l.push(key(x1, y1)); else next.set(k, [key(x1, y1)]); };
  for (let y = 0; y <= h; y++) for (let x = 0; x <= w; x++) {
    // horizontal edge above pixel (x, y): between (x,y-1) and (x,y)
    if (x < w && at(x, y - 1) !== at(x, y)) { if (at(x, y)) add(x + 1, y, x, y); else add(x, y, x + 1, y); }
    if (y < h && at(x - 1, y) !== at(x, y)) { if (at(x, y)) add(x, y, x, y + 1); else add(x, y + 1, x, y); }
  }
  const loops: [number, number][][] = [];
  for (const [start, outs] of next) {
    while (outs.length) {
      const loop: [number, number][] = [];
      let cur = start, nx = outs.pop()!;
      loop.push([cur % (w + 1), Math.floor(cur / (w + 1))]);
      let guard = 0;
      while (nx !== start && guard++ < 4 * (w + 1) * (h + 1)) {
        loop.push([nx % (w + 1), Math.floor(nx / (w + 1))]);
        const l = next.get(nx);
        if (!l || !l.length) break;
        cur = nx; nx = l.pop()!;
      }
      if (loop.length >= 4) loops.push(loop);
    }
  }
  return loops;
}

export interface TraceResult { pattern: Pattern; colors: string[]; dropped: string | null }

export function traceImage(img: RasterImage, spec: TraceSpec, id: string, name = 'Traced image'): TraceResult {
  const k = Math.max(1, Math.min(4, spec.colors + (spec.dropBackground ? 1 : 0)));
  let centres = quantise(img, k, spec.alphaCut);
  if (spec.palette?.length) centres = [...new Set(centres.map((c) => nearest(c, spec.palette!)))];
  const N = img.width * img.height;
  const label = new Int16Array(N).fill(-1);
  const counts = new Array(centres.length).fill(0);
  for (let i = 0; i < N; i++) {
    if (img.data[i * 4 + 3] < spec.alphaCut) continue;
    const c = hexOf([img.data[i * 4], img.data[i * 4 + 1], img.data[i * 4 + 2]]);
    let b = 0, bd = Infinity;
    centres.forEach((cc, j) => { const d = deltaE(c, cc); if (d < bd) { bd = d; b = j; } });
    label[i] = b; counts[b]++;
  }
  let dropped: number | null = null;
  if (spec.dropBackground && centres.length > 1) {
    // background = the colour that touches the image border most
    const border = new Array(centres.length).fill(0);
    for (let x = 0; x < img.width; x++) { const a = label[x], b = label[(img.height - 1) * img.width + x]; if (a >= 0) border[a]++; if (b >= 0) border[b]++; }
    for (let y = 0; y < img.height; y++) { const a = label[y * img.width], b = label[y * img.width + img.width - 1]; if (a >= 0) border[a]++; if (b >= 0) border[b]++; }
    dropped = border.indexOf(Math.max(...border));
  }
  const px = spec.width_mm / img.width;
  const groups: { color: string; rings: Ring[] }[] = [];
  centres.forEach((c, j) => {
    if (j === dropped || !counts[j]) return;
    const mask = new Uint8Array(N);
    for (let i = 0; i < N; i++) mask[i] = label[i] === j ? 1 : 0;
    let rings: Ring[] = traceMask(mask, img.width, img.height).map((l) => l.map(([x, y]) => [x * px, (img.height - y) * px] as [number, number]));
    rings = solidRings(rings);
    rings = rings.filter((r) => Math.abs(ringArea(r)) >= spec.speck_mm2).map((r) => simplifyRing(r, Math.max(spec.smooth_mm, px * 0.9)));
    groups.push({ color: c, rings: rings.filter((r) => r.length >= 3) });
  });
  return { pattern: patternOf(id, name, groups, { kind: 'trace', spec }), colors: groups.map((g) => g.color), dropped: dropped === null ? null : centres[dropped] };
}
