// Deterministic 1D value noise with octaves. Same seed → same output on every platform.

function hash(i: number, seed: number): number {
  let h = (i * 374761393 + seed * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return ((h >>> 0) / 4294967295) * 2 - 1;
}

function value1d(x: number, seed: number): number {
  const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f);
  return hash(i, seed) * (1 - u) + hash(i + 1, seed) * u;
}

/** Fractal value noise in roughly [-1, 1]. */
export function noise1d(x: number, seed: number, octaves = 3, persistence = 0.5): number {
  let sum = 0, amp = 1, freq = 1, norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += value1d(x * freq, seed + o * 101) * amp;
    norm += amp; amp *= persistence; freq *= 2;
  }
  return sum / norm;
}
