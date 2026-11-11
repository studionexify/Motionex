// Regular voxel grid with values at cell centres: the common carrier of every Advanced field
// (signed distance, thickness, harmonic potential, stress, reaction–diffusion concentrations…).

export class Grid3 {
  readonly n: number;
  readonly data: Float32Array;
  constructor(
    readonly nx: number, readonly ny: number, readonly nz: number,
    /** World position of cell (0,0,0)'s centre. */
    readonly ox: number, readonly oy: number, readonly oz: number,
    readonly h: number,
    data?: Float32Array,
  ) {
    this.n = nx * ny * nz;
    this.data = data ?? new Float32Array(this.n);
  }

  /** Same shape, new values (filled with `v`). */
  like(v = 0): Grid3 {
    const g = new Grid3(this.nx, this.ny, this.nz, this.ox, this.oy, this.oz, this.h);
    if (v) g.data.fill(v);
    return g;
  }

  idx(i: number, j: number, k: number): number { return i + this.nx * (j + this.ny * k); }
  get(i: number, j: number, k: number): number {
    i = i < 0 ? 0 : i >= this.nx ? this.nx - 1 : i;
    j = j < 0 ? 0 : j >= this.ny ? this.ny - 1 : j;
    k = k < 0 ? 0 : k >= this.nz ? this.nz - 1 : k;
    return this.data[i + this.nx * (j + this.ny * k)];
  }
  x(i: number) { return this.ox + i * this.h; }
  y(j: number) { return this.oy + j * this.h; }
  z(k: number) { return this.oz + k * this.h; }

  /** Trilinear sample at a world point (clamped at the border). */
  sample(x: number, y: number, z: number): number {
    const fx = (x - this.ox) / this.h, fy = (y - this.oy) / this.h, fz = (z - this.oz) / this.h;
    const i = Math.floor(fx), j = Math.floor(fy), k = Math.floor(fz);
    const tx = fx - i, ty = fy - j, tz = fz - k;
    const c000 = this.get(i, j, k), c100 = this.get(i + 1, j, k), c010 = this.get(i, j + 1, k), c110 = this.get(i + 1, j + 1, k);
    const c001 = this.get(i, j, k + 1), c101 = this.get(i + 1, j, k + 1), c011 = this.get(i, j + 1, k + 1), c111 = this.get(i + 1, j + 1, k + 1);
    const a = c000 + (c100 - c000) * tx, b = c010 + (c110 - c010) * tx;
    const c = c001 + (c101 - c001) * tx, d = c011 + (c111 - c011) * tx;
    const e = a + (b - a) * ty, f = c + (d - c) * ty;
    return e + (f - e) * tz;
  }

  /** Central-difference gradient at a world point. */
  gradient(x: number, y: number, z: number, out: [number, number, number] = [0, 0, 0]): [number, number, number] {
    const d = this.h * 0.5;
    out[0] = (this.sample(x + d, y, z) - this.sample(x - d, y, z)) / (2 * d);
    out[1] = (this.sample(x, y + d, z) - this.sample(x, y - d, z)) / (2 * d);
    out[2] = (this.sample(x, y, z + d) - this.sample(x, y, z - d)) / (2 * d);
    return out;
  }

  /** Cell containing a world point, or -1 outside the grid. */
  cellAt(x: number, y: number, z: number): number {
    const i = Math.round((x - this.ox) / this.h), j = Math.round((y - this.oy) / this.h), k = Math.round((z - this.oz) / this.h);
    if (i < 0 || j < 0 || k < 0 || i >= this.nx || j >= this.ny || k >= this.nz) return -1;
    return this.idx(i, j, k);
  }

  /** Values of one horizontal plane (nearest layer of cells) as a 2D grid. */
  planeAt(z: number): Grid2 {
    const fk = (z - this.oz) / this.h;
    const k0 = Math.max(0, Math.min(this.nz - 1, Math.floor(fk))), k1 = Math.min(this.nz - 1, k0 + 1);
    const t = Math.max(0, Math.min(1, fk - k0));
    const g = new Grid2(this.nx, this.ny, this.ox, this.oy, this.h);
    const s = this.nx * this.ny;
    for (let p = 0; p < s; p++) g.data[p] = this.data[p + s * k0] * (1 - t) + this.data[p + s * k1] * t;
    return g;
  }
}

export class Grid2 {
  readonly data: Float32Array;
  constructor(readonly nx: number, readonly ny: number, readonly ox: number, readonly oy: number, readonly h: number, data?: Float32Array) {
    this.data = data ?? new Float32Array(nx * ny);
  }
  like(v = 0): Grid2 {
    const g = new Grid2(this.nx, this.ny, this.ox, this.oy, this.h);
    if (v) g.data.fill(v);
    return g;
  }
  idx(i: number, j: number) { return i + this.nx * j; }
  get(i: number, j: number) {
    i = i < 0 ? 0 : i >= this.nx ? this.nx - 1 : i;
    j = j < 0 ? 0 : j >= this.ny ? this.ny - 1 : j;
    return this.data[i + this.nx * j];
  }
  x(i: number) { return this.ox + i * this.h; }
  y(j: number) { return this.oy + j * this.h; }
  sample(x: number, y: number): number {
    const fx = (x - this.ox) / this.h, fy = (y - this.oy) / this.h;
    const i = Math.floor(fx), j = Math.floor(fy);
    const tx = fx - i, ty = fy - j;
    const a = this.get(i, j), b = this.get(i + 1, j), c = this.get(i, j + 1), d = this.get(i + 1, j + 1);
    return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
  }
  gradient(x: number, y: number): [number, number] {
    const d = this.h * 0.5;
    return [(this.sample(x + d, y) - this.sample(x - d, y)) / (2 * d), (this.sample(x, y + d) - this.sample(x, y - d)) / (2 * d)];
  }
}

/** Grid covering a box with `pad` cells of margin, at most `maxCells` along the longest side. */
export function gridFor(min: number[], max: number[], maxCells: number, pad = 2, minH = 0.25): Grid3 {
  const size = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2], 1e-3);
  const h = Math.max(minH, size / Math.max(4, maxCells - 2 * pad));
  const nx = Math.ceil((max[0] - min[0]) / h) + 1 + 2 * pad;
  const ny = Math.ceil((max[1] - min[1]) / h) + 1 + 2 * pad;
  const nz = Math.ceil((max[2] - min[2]) / h) + 1 + 2 * pad;
  return new Grid3(nx, ny, nz, min[0] - pad * h, min[1] - pad * h, min[2] - pad * h, h);
}

/** Deterministic PRNG (mulberry32) so every field and pattern is reproducible. */
export function rng(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
export const smoothstep = (t: number) => { const x = clamp(t, 0, 1); return x * x * (3 - 2 * x); };
