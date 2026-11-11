// Pre-slice overhang check: finds downward faces that need support when support is off, so the user is told
// before printing (a sphere, a T, an arch...). Faces resting on the bed are ignored.
import type { MeshInput } from './types';

export interface OverhangFinding { name: string; area: number }

/**
 * Area (mm²) of each mesh's faces whose slope from horizontal is under `thresholdDeg` and that face down,
 * excluding faces within `bedTol` of the bed. Meshes under `minArea` are left out.
 */
export function findOverhangs(meshes: Pick<MeshInput, 'name' | 'vertices' | 'indices'>[], thresholdDeg: number, bedTol = 0.3, minArea = 4): OverhangFinding[] {
  // a face needs support when its normal points down within (90 - threshold)° of straight down: -nz > cos(threshold)
  const lim = Math.cos((Math.max(1, Math.min(89, thresholdDeg)) * Math.PI) / 180);
  const out: OverhangFinding[] = [];
  for (const m of meshes) {
    const v = m.vertices, ix = m.indices;
    let zMin = Infinity;
    for (let i = 2; i < v.length; i += 3) zMin = Math.min(zMin, v[i]);
    let area = 0;
    for (let t = 0; t < ix.length; t += 3) {
      const a = ix[t] * 3, b = ix[t + 1] * 3, c = ix[t + 2] * 3;
      if (Math.max(v[a + 2], v[b + 2], v[c + 2]) <= zMin + bedTol) continue; // on the bed
      const ux = v[b] - v[a], uy = v[b + 1] - v[a + 1], uz = v[b + 2] - v[a + 2];
      const wx = v[c] - v[a], wy = v[c + 1] - v[a + 1], wz = v[c + 2] - v[a + 2];
      const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
      const len = Math.hypot(nx, ny, nz);
      if (!len || -nz / len <= lim) continue;
      area += len / 2;
    }
    if (area >= minArea) out.push({ name: m.name || 'A model', area });
  }
  return out;
}

export function overhangMessage(found: OverhangFinding[], thresholdDeg: number): string {
  const names = found.map((f) => f.name);
  const who = names.length === 1 ? names[0] : names.length === 2 ? `${names[0]} and ${names[1]}` : `${names[0]} and ${names.length - 1} other models`;
  const area = Math.round(found.reduce((s, f) => s + f.area, 0));
  return `${who} ${found.length === 1 ? 'has' : 'have'} overhangs flatter than ${thresholdDeg}° (about ${area} mm²) and support is off. They will sag or fail to print. Turn on support, or turn the model so the overhang faces up.`;
}
