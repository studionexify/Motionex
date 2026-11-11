// Quick looks for the wall-art modes, without slicing: the part is cut at a few hundred heights, each
// outline is placed on the band (u round it, s up it) and the caller colours it, or leaves bits out.
import { sliceMesh } from '../../../engine/slice';
import { SCALE } from '../../../engine/clipper';
import type { IndexedMesh } from '../../../engine/mesh';
import { loopFractions, signedArea, wallHeights, type Pt } from './loops';

export interface PreviewObject { id: string; mesh: IndexedMesh }

export interface PreviewRow {
  z: number;
  /** Climbed since the previous row (mm). */
  dz: number;
  /** Distance up the band (NaN outside it). */
  s: number;
  total: number;
  loops: { pts: Pt[]; u: Float64Array; length: number; cx: number; cy: number }[];
}

/** Outer outlines of the chosen objects, cut every `step` mm (at most maxRows cuts), with band positions. */
export function previewRows(objs: PreviewObject[], ids: string[] | undefined, zStart: number, zEnd: number, followCurve: boolean, step: number, maxRows = 260, rimMm = 0): PreviewRow[][] {
  const want = new Set(ids ?? []);
  const out: PreviewRow[][] = [];
  for (const o of objs) {
    if (want.size && !want.has(o.id)) continue;
    const v = o.mesh.vertices;
    let zMax = 0;
    for (let i = 2; i < v.length; i += 3) zMax = Math.max(zMax, v[i]);
    const h = Math.max(step, zMax / maxRows);
    const zs: number[] = [];
    for (let z = h; z <= zMax + 1e-6; z += h) zs.push(+z.toFixed(4));
    if (!zs.length) continue;
    const cut = sliceMesh(o.mesh, zs.map((z) => z - Math.min(h, step) / 2));
    const loops = cut.map((paths) => paths.map((p) => p.map((q) => ({ x: q.X / SCALE, y: q.Y / SCALE }))).filter((l) => l.length > 2 && signedArea(l) > 0));
    const per = loops.map((ls) => (ls.length ? Math.max(...ls.map((l) => l.reduce((s, q, i) => s + Math.hypot(l[(i + 1) % l.length].x - q.x, l[(i + 1) % l.length].y - q.y), 0))) : NaN));
    let top = 0;
    loops.forEach((ls, i) => { if (ls.length) top = zs[i]; });
    const band = wallHeights(zs, per, zStart, Math.min(zEnd, top - rimMm), followCurve);
    out.push(zs.map((z, i) => ({
      z, dz: i ? z - zs[i - 1] : z, s: band.s[i], total: band.total,
      loops: loops[i].map((pts) => { const f = loopFractions(pts); return { pts, u: f.u, length: f.length, cx: f.cx, cy: f.cy }; }),
    })));
  }
  return out;
}
