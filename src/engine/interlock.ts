// Beam interlocking between filaments (OrcaSlicer / Cura InterlockingGenerator): where two materials of one object
// touch, a band of cells on both sides of the boundary is split into alternating beams, one material each, so the
// materials key into each other. Beam direction turns 90° every `layerCount` layers.
import { bounds, difference, intersection, offset, SCALE, union } from './clipper';
import type { Paths } from './types';

export interface InterlockParams {
  beamWidth: number;
  /** Layers per beam (the direction alternates after them). */
  layerCount: number;
  /** Beam orientation (degrees). */
  orientation: number;
  /** Cells on each side of the boundary. */
  depth: number;
  /** Cells kept clear of the object's outside. */
  avoid: number;
}

/** Stripes of width w, period 2w, at angle a (degrees), covering the box of `area`. */
function stripes(region: Paths, w: number, a: number): Paths {
  const b = bounds(region);
  const cx = (b.minX + b.maxX) / 2 / SCALE, cy = (b.minY + b.maxY) / 2 / SCALE;
  const R = Math.hypot(b.maxX - b.minX, b.maxY - b.minY) / 2 / SCALE + 2 * w;
  const c = Math.cos((a * Math.PI) / 180), s = Math.sin((a * Math.PI) / 180);
  const pt = (u: number, v: number) => ({ X: Math.round((cx + u * c - v * s) * SCALE), Y: Math.round((cy + u * s + v * c) * SCALE) });
  const out: Paths = [];
  // stripes are anchored to the plate origin so neighbouring layers line up
  const off = -cx * s + cy * c;
  const v0 = Math.floor((off - R) / (2 * w)) * 2 * w - off;
  for (let v = v0; v < R; v += 2 * w) out.push([pt(-R, v), pt(R, v), pt(R, v + w), pt(-R, v + w)]);
  return out;
}

/** Regions of one object at one layer, with the touching pairs interlocked. */
export function interlockRegions<T extends { fil: number; paths: Paths }>(regs: T[], outline: Paths, layer: number, p: InterlockParams): T[] {
  if (regs.length < 2 || p.beamWidth <= 0) return regs;
  const cell = p.beamWidth * 2;
  const keep = p.avoid > 0 ? offset(outline, -p.avoid * cell) : outline;
  if (!keep.length) return regs;
  const ang = p.orientation + (Math.floor(layer / Math.max(1, p.layerCount)) % 2 ? 90 : 0);
  const out = regs.map((r) => ({ ...r, paths: r.paths }));
  for (let a = 0; a < out.length; a++) for (let b = a + 1; b < out.length; b++) {
    if (out[a].fil === out[b].fil) continue;
    const d = p.depth * cell;
    const zone = intersection(intersection(offset(out[a].paths, d), offset(out[b].paths, d)), intersection(keep, union(out[a].paths, out[b].paths)));
    if (!zone.length) continue;
    const st = stripes(zone, p.beamWidth, ang);
    const toA = intersection(zone, st), toB = difference(zone, st);
    out[a].paths = union(difference(out[a].paths, zone), toA);
    out[b].paths = union(difference(out[b].paths, zone), toB);
  }
  return out.filter((r) => r.paths.length);
}
