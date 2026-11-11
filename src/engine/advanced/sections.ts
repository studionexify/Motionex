// Cross-section profile of a part along Z: area, island count and holes per sampled plane. From it the
// router finds necks (area minima), helical bands (steady single-island stretches) and bosses (round holes).
import { area, toExPolygons, SCALE } from '../clipper';
import { sliceMesh } from './classic/slice';
import type { IndexedMesh } from '../mesh';
import type { Paths } from '../types';

export interface Boss { cx: number; cy: number; r: number; z0: number; z1: number }

export interface SectionProfile {
  z: number[];
  area: number[];
  islands: number[];
  perimeter: number[];
  slices: Paths[];
  bosses: Boss[];
  /** Z bands around cross-section minima (high-stress necks). */
  necks: [number, number][];
  /** Z bands where each plane is one steady island (continuous helix candidates). */
  helical: [number, number][];
}

const perim = (p: Paths[number]) => {
  let s = 0;
  for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; s += Math.hypot(b.X - a.X, b.Y - a.Y); }
  return s / SCALE;
};

export function sectionProfile(mesh: IndexedMesh, zMin: number, zMax: number, step: number): SectionProfile {
  const z: number[] = [];
  for (let t = zMin + step / 2; t < zMax; t += step) z.push(+t.toFixed(4));
  if (!z.length) z.push((zMin + zMax) / 2);
  const slices = sliceMesh(mesh, z);
  const areas: number[] = [], islands: number[] = [], perimeter: number[] = [];
  type Hole = { cx: number; cy: number; r: number; z: number };
  const holes: Hole[] = [];
  slices.forEach((sl, i) => {
    const exs = toExPolygons(sl);
    let a = 0, pr = 0;
    for (const ex of exs) {
      a += area(ex.contour) + ex.holes.reduce((s, h) => s + area(h), 0);
      pr += perim(ex.contour) + ex.holes.reduce((s, h) => s + perim(h), 0);
      for (const h of ex.holes) {
        const ha = Math.abs(area(h)), hp = perim(h);
        if (hp <= 0) continue;
        const circ = (4 * Math.PI * ha) / (hp * hp);
        const r = Math.sqrt(ha / Math.PI);
        if (circ > 0.85 && r >= 0.8 && r <= 12) {
          let cx = 0, cy = 0;
          for (const q of h) { cx += q.X; cy += q.Y; }
          holes.push({ cx: cx / h.length / SCALE, cy: cy / h.length / SCALE, r, z: z[i] });
        }
      }
    }
    areas.push(a); islands.push(exs.length); perimeter.push(pr);
  });

  // bosses: round holes repeated over at least three planes at the same place
  const bosses: Boss[] = [];
  for (const h of holes) {
    const b = bosses.find((x) => Math.hypot(x.cx - h.cx, x.cy - h.cy) < Math.max(0.5, h.r * 0.2) && Math.abs(x.r - h.r) < Math.max(0.4, h.r * 0.25) && h.z - x.z1 <= step * 1.5 + 1e-6);
    if (b) { b.z1 = h.z; b.r = (b.r + h.r) / 2; } else bosses.push({ cx: h.cx, cy: h.cy, r: h.r, z0: h.z, z1: h.z });
  }
  const realBosses = bosses.filter((b) => (b.z1 - b.z0) / step >= 2 - 1e-6).map((b) => ({ ...b, z0: b.z0 - step / 2, z1: b.z1 + step / 2 }));

  // necks: planes whose area is under 60 % of the largest area on both sides within a quarter of the height
  const necks: [number, number][] = [];
  const N = z.length;
  const reach = Math.max(2, Math.round(N / 4));
  const isNeck = (i: number) => {
    let lo = 0, hi = 0;
    for (let k = Math.max(0, i - reach); k < i; k++) lo = Math.max(lo, areas[k]);
    for (let k = i + 1; k <= Math.min(N - 1, i + reach); k++) hi = Math.max(hi, areas[k]);
    return areas[i] > 0 && lo > 0 && hi > 0 && areas[i] < 0.6 * Math.min(lo, hi);
  };
  for (let i = 0; i < N; i++) {
    if (!isNeck(i)) continue;
    const last = necks[necks.length - 1];
    if (last && z[i] - last[1] <= step * 1.5) last[1] = z[i] + step / 2;
    else necks.push([z[i] - step / 2, z[i] + step / 2]);
  }

  // helical bands: one island per plane and the outline changes slowly (no top or bottom skins inside)
  const helical: [number, number][] = [];
  let start = -1;
  const steady = (i: number) => islands[i] === 1 && i > 0 && islands[i - 1] === 1 && Math.abs(areas[i] - areas[i - 1]) <= 0.05 * Math.max(areas[i], 1e-6)
    && Math.abs(areas[i] - areas[i - 1]) <= perimeter[i] * step * 0.5;
  for (let i = 0; i <= N; i++) {
    if (i < N && steady(i)) { if (start < 0) start = i - 1; continue; }
    if (start >= 0 && i - start >= 8) helical.push([z[start] - step / 2, z[i - 1] + step / 2]);
    start = -1;
  }
  return { z, area: areas, islands, perimeter, slices, bosses: realBosses, necks, helical };
}
