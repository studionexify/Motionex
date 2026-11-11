// Variable layer height: adaptive profile from surface slope, Gaussian smoothing, height-range edits.
import type { IndexedMesh } from './mesh';

export interface LayerProfileOptions {
  minHeight: number; // e.g. 0.2 × nozzle
  maxHeight: number; // e.g. 0.7 × nozzle
  firstLayer: number;
  /** 0 = maximum quality (thin layers on slopes), 1 = maximum speed. */
  quality: number;
}

/**
 * Adaptive layer heights: the allowed height at z is limited by the shallowest
 * non-flat surface crossing z, using a cusp-height criterion h = cusp / |n_z|.
 */
export function adaptiveProfile(mesh: IndexedMesh, o: LayerProfileOptions): number[] {
  const v = mesh.vertices, ix = mesh.indices;
  let maxZ = 0;
  for (let i = 2; i < v.length; i += 3) maxZ = Math.max(maxZ, v[i]);
  const BIN = 0.02;
  const nb = Math.ceil(maxZ / BIN) + 1;
  const limit = new Float32Array(nb).fill(o.maxHeight);
  const cusp = o.minHeight + o.quality * (o.maxHeight - o.minHeight) * 0.5;
  for (let t = 0; t < ix.length; t += 3) {
    const a = ix[t] * 3, b = ix[t + 1] * 3, c = ix[t + 2] * 3;
    const ux = v[b] - v[a], uy = v[b + 1] - v[a + 1], uz = v[b + 2] - v[a + 2];
    const wx = v[c] - v[a], wy = v[c + 1] - v[a + 1], wz = v[c + 2] - v[a + 2];
    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-12) continue;
    const anz = Math.abs(nz / len);
    if (anz > 0.995 || anz < 0.05) continue; // flat tops/bottoms print exactly; vertical walls need no refinement
    const h = Math.min(o.maxHeight, Math.max(o.minHeight, cusp / anz));
    const z0 = Math.min(v[a + 2], v[b + 2], v[c + 2]), z1 = Math.max(v[a + 2], v[b + 2], v[c + 2]);
    for (let k = Math.floor(z0 / BIN); k <= Math.ceil(z1 / BIN) && k < nb; k++) if (h < limit[k]) limit[k] = h;
  }
  const out: number[] = [o.firstLayer];
  let z = o.firstLayer;
  while (z < maxZ - 1e-4) {
    // largest h such that every bin in [z, z+h] allows it
    let h = o.maxHeight;
    for (let k = Math.floor(z / BIN); k * BIN < z + h && k < nb; k++) h = Math.min(h, limit[k]);
    h = Math.max(o.minHeight, h);
    if (z + h > maxZ && maxZ - z < o.minHeight * 0.5) break;
    out.push(+h.toFixed(4));
    z += h;
  }
  return out;
}

/** Gaussian smoothing of layer heights (radius in layers); first layer untouched. */
export function smoothProfile(h: number[], radius: number, keepMin: boolean): number[] {
  if (h.length < 3 || radius < 1) return h.slice();
  const sigma = radius / 2;
  const w: number[] = [];
  for (let k = -radius; k <= radius; k++) w.push(Math.exp(-(k * k) / (2 * sigma * sigma)));
  const out = h.slice();
  for (let i = 1; i < h.length; i++) {
    let s = 0, ws = 0;
    for (let k = -radius; k <= radius; k++) {
      const j = i + k;
      if (j < 1 || j >= h.length) continue;
      s += h[j] * w[k + radius]; ws += w[k + radius];
    }
    out[i] = keepMin ? Math.min(h[i], s / ws) : s / ws;
    out[i] = +out[i].toFixed(4);
  }
  return out;
}

/** Force a fixed layer height inside [z0, z1] (height-range modifier); layers outside keep the profile. */
export function applyHeightRange(h: number[], z0: number, z1: number, height: number, maxZ: number): number[] {
  const heightAt = (z: number) => {
    let acc = 0;
    for (const x of h) { if (acc + x > z + 1e-6) return x; acc += x; }
    return h[h.length - 1];
  };
  const out = [h[0]];
  let z = h[0];
  while (z < maxZ - 1e-4) {
    let n = z >= z0 - 1e-6 && z < z1 - 1e-6 ? height : heightAt(z);
    if (z < z0 - 1e-6 && z + n > z0 + 1e-6) n = Math.max(0.04, z0 - z); // land exactly on the range start
    out.push(+n.toFixed(4));
    z += n;
  }
  return out;
}

/** Uniform profile helper (used for display when no custom profile). */
export function uniformProfile(maxZ: number, first: number, h: number): number[] {
  const out = [first];
  let z = first;
  while (z + h * 0.5 < maxZ) { out.push(h); z += h; }
  return out;
}
