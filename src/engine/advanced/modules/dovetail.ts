// #13 Interfacial multi-material dovetailing. In a band `depth` wide on both sides of every boundary
// between two materials, the material is chosen by a checkerboard of fingers of size pitch/2 whose
// phase flips every layer: each material reaches into the other, and the fingers of one layer are
// capped by the other material on the next, a 3D interlock with no straight interface plane.
import { difference, intersection, offset, union, SCALE } from '../../clipper';
import type { Paths } from '../../types';
import type { MaterialRegion, TechModule } from '../session';

/** Checkerboard squares of side `cell` over a box, in one of the two phases. */
function checker(minX: number, minY: number, maxX: number, maxY: number, cell: number, phase: 0 | 1): Paths {
  const out: Paths = [];
  const i0 = Math.floor(minX / cell) - 1, j0 = Math.floor(minY / cell) - 1;
  for (let j = j0; j * cell <= maxY + cell; j++) for (let i = i0; i * cell <= maxX + cell; i++) {
    if (((i + j) & 1) !== phase) continue;
    const x0 = i * cell, y0 = j * cell, x1 = x0 + cell, y1 = y0 + cell;
    out.push([{ X: Math.round(x0 * SCALE), Y: Math.round(y0 * SCALE) }, { X: Math.round(x1 * SCALE), Y: Math.round(y0 * SCALE) }, { X: Math.round(x1 * SCALE), Y: Math.round(y1 * SCALE) }, { X: Math.round(x0 * SCALE), Y: Math.round(y1 * SCALE) }]);
  }
  return out;
}

export function dovetailRegions(regs: MaterialRegion[], layer: number, depth: number, pitch: number): { regions: MaterialRegion[]; fingers: number } {
  if (regs.length < 2) return { regions: regs, fingers: 0 };
  let out = regs.map((r) => ({ fil: r.fil, paths: r.paths }));
  let fingers = 0;
  for (let a = 0; a < out.length; a++) for (let b = a + 1; b < out.length; b++) {
    const A = out[a].paths, B = out[b].paths;
    const band = union(intersection(A, offset(B, depth)), intersection(B, offset(A, depth)));
    if (!band.length) continue;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of band) for (const q of p) { minX = Math.min(minX, q.X / SCALE); maxX = Math.max(maxX, q.X / SCALE); minY = Math.min(minY, q.Y / SCALE); maxY = Math.max(maxY, q.Y / SCALE); }
    const toA = intersection(band, checker(minX, minY, maxX, maxY, pitch / 2, (layer & 1) as 0 | 1));
    const toB = difference(band, toA);
    out[a] = { fil: out[a].fil, paths: union(difference(A, band), toA) };
    out[b] = { fil: out[b].fil, paths: union(difference(B, band), toB) };
    fingers += toA.length + toB.length;
  }
  return { regions: out.filter((r) => r.paths.length), fingers };
}

export const dovetail: TechModule = {
  id: 'dovetail',
  regions(s, o, layer, regs) {
    if (layer === 0) return regs;
    const r = s.report('dovetail');
    const res = dovetailRegions(regs, layer, s.pnum('dovetail', 'depth'), s.pnum('dovetail', 'pitch'));
    if (res.fingers) r.stats = { interfaces_layers: (Number(r.stats?.interfaces_layers) || 0) + 1, fingers: (Number(r.stats?.fingers) || 0) + res.fingers, depth_mm: s.pnum('dovetail', 'depth'), pitch_mm: s.pnum('dovetail', 'pitch') };
    return res.regions;
  },
};
