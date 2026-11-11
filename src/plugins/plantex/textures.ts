// Surface textures: each kind is a height field h(U, V) in 0..1 over pattern cells (U around, V up).
// Layers are banded, faded, shifted / thickened by reference planes, and summed into a displacement
// (emboss +, deboss −) or a cut-through mask.
import type { PlantexSpec, RefPlane, TextureKind, TextureLayer } from './model';

const TAU = Math.PI * 2;
const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const fract = (x: number) => x - Math.floor(x);
const tri = (x: number) => 1 - Math.abs(2 * fract(x) - 1);
const sstep = (a: number, b: number, x: number) => { const t = clamp((x - a) / (b - a || 1e-6)); return t * t * (3 - 2 * t); };
const mod = (a: number, n: number) => ((a % n) + n) % n;

function hash(x: number, y: number, s: number): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(s | 0, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** A raster mask (Patternex artwork), sampled 0..1 with wrap. */
export interface Mask { w: number; h: number; data: Float32Array }
export function sampleMask(m: Mask, u: number, v: number): number {
  const x = fract(u) * m.w - 0.5, y = fract(v) * m.h - 0.5;
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const at = (i: number, j: number) => m.data[mod(j, m.h) * m.w + mod(i, m.w)];
  return (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) + (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy;
}

interface Ctx { cu: number; shape: number; sharp: number; seed: number; mask?: Mask }

/** Band of half-width w around 0 with an edge softness from `sharp`. */
const band = (d: number, w: number, sharp: number) => { const e = (1 - sharp) * 0.6 * w + 0.004; return 1 - sstep(w - e, w + e, Math.abs(d)); };

/** Nearest / second-nearest jittered points (Voronoi), periodic in U over cu cells. */
function voronoi(U: number, V: number, c: Ctx): { f1: number; f2: number; id: number } {
  const ix = Math.floor(U), iy = Math.floor(V);
  let f1 = 9, f2 = 9, id = 0;
  for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
    const cx = ix + i, cy = iy + j, wx = mod(cx, c.cu);
    const px = cx + 0.15 + 0.7 * hash(wx, cy, c.seed), py = cy + 0.15 + 0.7 * hash(wx, cy, c.seed + 7);
    const d = Math.hypot(U - px, V - py);
    if (d < f1) { f2 = f1; f1 = d; id = wx * 7919 + cy; } else if (d < f2) f2 = d;
  }
  return { f1, f2, id };
}

function valueNoise(U: number, V: number, c: Ctx, period: number): number {
  const ix = Math.floor(U), iy = Math.floor(V), fx = U - ix, fy = V - iy;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const h = (i: number, j: number) => hash(mod(i, period), j, c.seed);
  return (h(ix, iy) * (1 - sx) + h(ix + 1, iy) * sx) * (1 - sy) + (h(ix, iy + 1) * (1 - sx) + h(ix + 1, iy + 1) * sx) * sy;
}

const HEX_Y = Math.sqrt(3);

export const KINDS: Record<TextureKind, { label: string; fn: (U: number, V: number, c: Ctx) => number }> = {
  ribs: { label: 'Ribs', fn: (U, _V, c) => clamp(tri(U) / Math.max(0.05, 1 - c.shape * 0.9)) },
  flutes: { label: 'Flutes (round)', fn: (U, _V, c) => { const x = 2 * fract(U) - 1; return Math.pow(Math.max(0, 1 - x * x), 0.3 + c.shape); } },
  fins: { label: 'Fins (blades)', fn: (U, _V, c) => band(fract(U) - 0.5, 0.04 + c.shape * 0.4, c.sharp) },
  pleats: { label: 'Pleats (accordion)', fn: (U) => tri(U) },
  lattice: {
    label: 'Lattice (diagonal)', fn: (U, V, c) => {
      const w = 0.03 + c.shape * 0.2;
      const a = fract(U + V), b = fract(U - V);
      return Math.max(band(Math.min(a, 1 - a), w, c.sharp), band(Math.min(b, 1 - b), w, c.sharp));
    },
  },
  diamonds: { label: 'Diamonds (facets)', fn: (U, V, c) => clamp((1 - Math.max(Math.abs(2 * fract(U + V) - 1), Math.abs(2 * fract(U - V) - 1))) / Math.max(0.05, 1 - c.shape * 0.9)) },
  pyramids: { label: 'Pyramids / studs', fn: (U, V, c) => clamp((1 - Math.max(Math.abs(2 * fract(U) - 1), Math.abs(2 * fract(V) - 1))) / Math.max(0.05, 1 - c.shape * 0.9)) },
  knurl: { label: 'Knurl', fn: (U, V) => tri(U + V) * tri(U - V) },
  hex: {
    label: 'Honeycomb', fn: (U, V, c) => {
      const y = V * HEX_Y;
      const ax = fract(U) - 0.5, ay = (y - HEX_Y * Math.round(y / HEX_Y));
      const bx = fract(U + 0.5) - 0.5, by = y - HEX_Y * (Math.floor(y / HEX_Y) + 0.5);
      const da = Math.hypot(ax, ay), db = Math.hypot(bx, by);
      const d = Math.min(da, db);
      return sstep(0.5 - (0.04 + c.shape * 0.2) - (1 - c.sharp) * 0.05, 0.5 - (0.04 + c.shape * 0.2), d);
    },
  },
  voronoi: { label: 'Voronoi cells', fn: (U, V, c) => { const v = voronoi(U, V, c); return 1 - sstep(0, 0.02 + c.shape * 0.25 + (1 - c.sharp) * 0.05, v.f2 - v.f1); } },
  bubbles: { label: 'Bubbles / pearls', fn: (U, V, c) => { const v = voronoi(U, V, c); const r = 0.2 + c.shape * 0.45; return Math.sqrt(clamp(1 - (v.f1 / r) ** 2)); } },
  craters: {
    label: 'Craters (moon)', fn: (U, V, c) => {
      const v = voronoi(U, V, c);
      const r = 0.25 + c.shape * 0.4, x = v.f1 / r;
      return x > 1.25 ? 0.35 : clamp(0.35 + (x < 1 ? x * x * 0.65 : (1.25 - x) * 2.6));
    },
  },
  waves: { label: 'Waves (horizontal)', fn: (U, V, c) => band(fract(V + 0.35 * Math.sin(TAU * U)) - 0.5, 0.06 + c.shape * 0.35, c.sharp) },
  rings: { label: 'Rings (horizontal ribs)', fn: (_U, V, c) => clamp(tri(V) / Math.max(0.05, 1 - c.shape * 0.9)) },
  steps: { label: 'Steps (terraces)', fn: (_U, V, c) => Math.pow(fract(V), 0.4 + c.sharp * 2) },
  bricks: {
    label: 'Bricks', fn: (U, V, c) => {
      const row = Math.floor(V);
      const x = fract(U + (row & 1 ? 0.5 : 0)), y = fract(V);
      const g = 0.02 + c.shape * 0.15;
      const e = Math.min(x, 1 - x, (y) * 0.5, (1 - y) * 0.5);
      return sstep(g * 0.5, g * 0.5 + 0.02 + (1 - c.sharp) * 0.05, e);
    },
  },
  weave: {
    label: 'Basket weave', fn: (U, V) => {
      const ix = Math.floor(U * 2), iy = Math.floor(V * 2);
      const fu = fract(U * 2), fv = fract(V * 2);
      return (ix + iy) & 1 ? Math.sin(Math.PI * fv) * (0.6 + 0.4 * Math.sin(Math.PI * fu)) : Math.sin(Math.PI * fu) * (0.6 + 0.4 * Math.sin(Math.PI * fv));
    },
  },
  scales: {
    label: 'Scales', fn: (U, V, c) => {
      const row = Math.floor(V);
      const x = fract(U + (row & 1 ? 0.5 : 0)) - 0.5, y = fract(V);
      const d = Math.hypot(x, y * 0.9);
      const x2 = fract(U + (row & 1 ? 0 : 0.5)) - 0.5, d2 = Math.hypot(x2, (y + 1) * 0.9 - 0.9 * 0.5 - 0.45);
      return Math.max(clamp(1 - d / (0.55 + c.shape * 0.3)), clamp(1 - d2 / (0.55 + c.shape * 0.3)) * 0.6);
    },
  },
  zigzag: { label: 'Zig-zag bands', fn: (U, V, c) => band(fract(V + 0.5 * tri(U)) - 0.5, 0.06 + c.shape * 0.35, c.sharp) },
  ribbons: {
    label: 'Ribbons (ogee)', fn: (U, V, c) => {
      const x = fract(U) - 0.5, a = 0.3 * Math.sin(TAU * V), w = 0.04 + c.shape * 0.15;
      return Math.max(band(x - a, w, c.sharp), band(x + a, w, c.sharp));
    },
  },
  facets: { label: 'Facets (low-poly)', fn: (U, V, c) => { const v = voronoi(U, V, c); return 0.25 + 0.75 * hash(v.id, 3, c.seed) * (1 - c.shape * v.f1); } },
  dots: {
    label: 'Dots', fn: (U, V, c) => {
      const row = Math.floor(V);
      const x = fract(U + (row & 1 ? 0.5 : 0)) - 0.5, y = fract(V) - 0.5;
      const r = 0.1 + c.shape * 0.38;
      return Math.sqrt(clamp(1 - (Math.hypot(x, y) / r) ** 2));
    },
  },
  noise: {
    label: 'Noise (organic)', fn: (U, V, c) => {
      let s = 0, a = 0.5, f = 1;
      for (let o = 0; o < 4; o++) { s += a * valueNoise(U * f, V * f, c, c.cu * f); a *= 0.5; f *= 2; }
      return clamp((s / 0.9375 - 0.5) * (1 + c.shape * 2) + 0.5);
    },
  },
  helix: { label: 'Helix ribs', fn: (U, V, c) => clamp(tri(U + V) / Math.max(0.05, 1 - c.shape * 0.9)) },
  petals: {
    label: 'Petals / flames', fn: (U, V, c) => {
      const x = Math.abs(2 * fract(U) - 1), y = fract(V);
      const w = Math.pow(Math.max(0, 1 - y), 0.7) * (0.4 + c.shape * 0.6) * Math.sin(Math.PI * Math.min(1, y * 1.6 + 0.2));
      return clamp((w - x) / (0.05 + (1 - c.sharp) * 0.2));
    },
  },
  pattern: { label: 'Patternex artwork', fn: (U, V, c) => (c.mask ? sampleMask(c.mask, U, V) : 0) },
};

/** Blend reference planes at band position b. */
export function planeAt(planes: RefPlane[], b: number, blend: 'linear' | 'smooth'): RefPlane {
  if (!planes.length) return { z: b, shift: 0, scale: 1, depth: 1 };
  const p = [...planes].sort((x, y) => x.z - y.z);
  if (b <= p[0].z) return p[0];
  if (b >= p[p.length - 1].z) return p[p.length - 1];
  let i = 0;
  while (b > p[i + 1].z) i++;
  let t = (b - p[i].z) / Math.max(1e-6, p[i + 1].z - p[i].z);
  if (blend === 'smooth') t = 0.5 - 0.5 * Math.cos(Math.PI * t);
  const l = (k: 'shift' | 'scale' | 'depth') => p[i][k] + (p[i + 1][k] - p[i][k]) * t;
  return { z: b, shift: l('shift'), scale: l('scale'), depth: l('depth') };
}

export interface TextureField {
  /** Signed displacement (mm) at angle fraction u (0..1) and height z (mm). */
  disp(u: number, z: number): number;
  /** True where a cut-through layer opens the wall. */
  cut(u: number, z: number): boolean;
  /** Smooth cut field: > 0 inside a hole, 0 on its edge (unitless; the mesher turns it into a distance). */
  cutField(u: number, z: number): number;
  hasCut: boolean;
  /** Deepest deboss (mm), to keep the wall printable. */
  maxDeboss: number;
}

/** One layer's height (0..1, after band, planes and fade) at (u, z). */
export function layerValue(L: TextureLayer, u: number, z: number, H: number, rRef: number, mask?: Mask): number {
  const zb0 = L.z0 * H, zb1 = L.z1 * H;
  if (z < zb0 - 1e-6 || z > zb1 + 1e-6 || zb1 - zb0 < 1e-3) return 0;
  const b = (z - zb0) / (zb1 - zb0);
  const pl = planeAt(L.planes, b, L.planeBlend);
  const cu = Math.max(1, Math.round(L.countU));
  let uu = u + (L.offsetU + pl.shift + (L.waveAmp ? L.waveAmp * Math.sin((TAU * z) / Math.max(1, L.wavePeriod)) : 0)) / 360;
  if (L.rotate) uu += (z * Math.tan((clamp(L.rotate, -80, 80) * Math.PI) / 180)) / (TAU * Math.max(5, rRef));
  const U = uu * cu, V = b * Math.max(0.01, L.countV) + L.offsetV;
  const k = KINDS[L.kind] ?? KINDS.ribs;
  let h = k.fn(U, V, { cu, shape: clamp(L.shape * pl.scale), sharp: clamp(L.sharp), seed: L.seed, mask });
  if (L.invert) h = 1 - h;
  let f = pl.depth;
  if (L.fade > 0) f *= sstep(0, 1, Math.min(z - zb0, zb1 - z) / L.fade);
  return h * f;
}

export function textureField(spec: PlantexSpec, rRef: number, masks: (key: string) => Mask | undefined): TextureField {
  const H = spec.height;
  const layers = spec.textures.filter((t) => t.enabled);
  const maskOf = (L: TextureLayer) => (L.kind === 'pattern' && L.patternKey ? masks(L.patternKey) : undefined);
  const cutting = spec.vaseMode ? [] : layers.filter((l) => l.mode === 'cut');
  const relief = layers.filter((l) => l.mode !== 'cut' || spec.vaseMode);
  const lm = new Map(layers.map((l) => [l.id, maskOf(l)]));
  return {
    hasCut: cutting.length > 0,
    maxDeboss: relief.reduce((s, l) => s + (l.mode === 'emboss' ? 0 : l.depth), 0),
    disp(u, z) {
      let d = 0;
      for (const L of relief) {
        const v = layerValue(L, u, z, H, rRef, lm.get(L.id));
        if (v) d += (L.mode === 'emboss' ? 1 : -1) * L.depth * v;
      }
      return d;
    },
    cut(u, z) {
      for (const L of cutting) if (layerValue(L, u, z, H, rRef, lm.get(L.id)) > L.cutLevel) return true;
      return false;
    },
    cutField(u, z) {
      let g = -1;
      for (const L of cutting) g = Math.max(g, layerValue(L, u, z, H, rRef, lm.get(L.id)) - L.cutLevel);
      return g;
    },
  };
}
