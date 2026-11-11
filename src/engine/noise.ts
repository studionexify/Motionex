// Fuzzy skin: displacement / extrusion noise along wall loops (fuzzy skin modes and noise types).
export type NoiseType = 'classic' | 'perlin' | 'billow' | 'ridgedmulti' | 'voronoi' | 'ripple';
export type FuzzyMode = 'displacement' | 'extrusion' | 'combined';

// ---------------------------------------------------------------- improved Perlin noise (3D)
const P = new Uint8Array(512);
{
  // fixed permutation (deterministic output for identical inputs)
  const p = Array.from({ length: 256 }, (_, i) => i);
  let s = 1337;
  for (let i = 255; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    [p[i], p[j]] = [p[j], p[i]];
  }
  for (let i = 0; i < 512; i++) P[i] = p[i & 255];
}
const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a: number, b: number, t: number) => a + t * (b - a);
function grad(h: number, x: number, y: number, z: number) {
  const u = (h & 15) < 8 ? x : y, v = (h & 15) < 4 ? y : (h & 15) === 12 || (h & 15) === 14 ? x : z;
  return ((h & 1) ? -u : u) + ((h & 2) ? -v : v);
}
/** Classic improved Perlin noise in [-1, 1]. */
export function perlin3(x: number, y: number, z: number): number {
  const X = Math.floor(x) & 255, Y = Math.floor(y) & 255, Z = Math.floor(z) & 255;
  x -= Math.floor(x); y -= Math.floor(y); z -= Math.floor(z);
  const u = fade(x), v = fade(y), w = fade(z);
  const A = P[X] + Y, AA = P[A] + Z, AB = P[A + 1] + Z, B = P[X + 1] + Y, BA = P[B] + Z, BB = P[B + 1] + Z;
  return lerp(
    lerp(lerp(grad(P[AA], x, y, z), grad(P[BA], x - 1, y, z), u), lerp(grad(P[AB], x, y - 1, z), grad(P[BB], x - 1, y - 1, z), u), v),
    lerp(lerp(grad(P[AA + 1], x, y, z - 1), grad(P[BA + 1], x - 1, y, z - 1), u), lerp(grad(P[AB + 1], x, y - 1, z - 1), grad(P[BB + 1], x - 1, y - 1, z - 1), u), v),
    w,
  );
}

const hash3 = (x: number, y: number, z: number) => {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};
/** Cellular (Voronoi) noise: distance to the nearest feature point, mapped to [-1, 1]. */
export function voronoi3(x: number, y: number, z: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  let best = Infinity;
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
    const cx = xi + dx, cy = yi + dy, cz = zi + dz;
    const px = cx + hash3(cx, cy, cz), py = cy + hash3(cy, cz, cx), pz = cz + hash3(cz, cx, cy);
    const d = (px - x) ** 2 + (py - y) ** 2 + (pz - z) ** 2;
    if (d < best) best = d;
  }
  return Math.min(1, Math.sqrt(best)) * 2 - 1;
}

/** Coherent noise in [-1, 1] at a point (mm), using the fuzzy skin feature size, octaves and persistence. */
export function coherentNoise(type: NoiseType, x: number, y: number, z: number, scale: number, octaves: number, persistence: number): number {
  const f0 = 1 / Math.max(0.1, scale);
  if (type === 'voronoi') return voronoi3(x * f0, y * f0, z * f0);
  let sum = 0, amp = 1, norm = 0, f = f0;
  for (let o = 0; o < Math.max(1, octaves); o++) {
    const n = perlin3(x * f + o * 19.1, y * f + o * 7.3, z * f + o * 3.7);
    const v = type === 'billow' ? Math.abs(n) * 2 - 1 : type === 'ridgedmulti' ? 1 - 2 * Math.abs(n) : n;
    sum += v * amp; norm += amp; amp *= persistence; f *= 2;
  }
  return Math.max(-1, Math.min(1, sum / norm));
}

export interface FuzzyParams {
  thickness: number; pointDistance: number; mode: FuzzyMode; noise: NoiseType;
  scale: number; octaves: number; persistence: number; z: number; rnd: () => number;
  /** Line width (extrusion mode varies the flow relative to it). */
  width: number;
  /** Ripple noise: full sine cycles per loop, and the phase shift of this layer (radians). */
  ripples?: number; ripplePhase?: number;
}

/**
 * Ripple phase shift of a layer (OrcaSlicer ripple_phase_shift_rad): the pattern moves on by `offsetPct` % of a
 * wavelength once every `every` layers.
 */
export function ripplePhase(layer: number, offsetPct: number, every: number): number {
  if (!offsetPct || every <= 0) return 0;
  const period = Math.floor(Math.max(0, layer) / Math.max(1, every));
  return (period * (offsetPct / 100) * 2 * Math.PI) % (2 * Math.PI);
}

/**
 * Re-samples a closed loop every `pointDistance` mm and jitters it. Returns the new points and,
 * for extrusion / combined modes, a flow multiplier per point (1 = unchanged).
 */
export function fuzzLoop(pts: number[], p: FuzzyParams): { pts: number[]; flows?: number[] } {
  const out: number[] = [];
  const flows: number[] = [];
  const n = pts.length / 2;
  const wantFlow = p.mode !== 'displacement';
  const disp = p.mode === 'extrusion' ? 0 : p.mode === 'combined' ? 0.5 : 1;
  // ripple: a sine wave along the arc length, N cycles per loop, peaking at the leftmost point (stable over layers)
  let perim = 0, anchor = 0, minX = Infinity;
  if (p.noise === 'ripple') {
    for (let i = 0; i < n; i++) {
      if (pts[i * 2] < minX - 1e-9) { minX = pts[i * 2]; anchor = perim; }
      perim += Math.hypot(pts[((i + 1) % n) * 2] - pts[i * 2], pts[((i + 1) % n) * 2 + 1] - pts[i * 2 + 1]);
    }
  }
  const N = Math.max(1, Math.round(p.ripples ?? 15));
  let arc = 0;
  for (let i = 0; i < n; i++) {
    const ax = pts[i * 2], ay = pts[i * 2 + 1];
    const bx = pts[((i + 1) % n) * 2], by = pts[((i + 1) % n) * 2 + 1];
    const len = Math.hypot(bx - ax, by - ay);
    const steps = Math.max(1, Math.floor(len / Math.max(0.05, p.pointDistance)));
    // outward normal of a CCW contour is (dy, -dx); the sign does not matter for noise
    const nx = len ? (by - ay) / len : 0, ny = len ? -(bx - ax) / len : 0;
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      const x = ax + (bx - ax) * t, y = ay + (by - ay) * t;
      const r = p.noise === 'ripple' ? Math.sin((N * 2 * Math.PI * (arc + len * t - anchor)) / Math.max(perim, 1e-6) + Math.PI / 2 + (p.ripplePhase ?? 0))
        : p.noise === 'classic' ? p.rnd() * 2 - 1 : coherentNoise(p.noise, x, y, p.z, p.scale, p.octaves, p.persistence);
      const d = r * p.thickness;
      out.push(x + nx * d * disp, y + ny * d * disp);
      // extrusion mode: the bead swells and thins by the noise instead of moving
      if (wantFlow) flows.push(Math.max(0.2, 1 + (r * p.thickness * (1 - disp)) / Math.max(0.1, p.width)));
    }
    arc += len;
  }
  return wantFlow ? { pts: out, flows } : { pts: out };
}
