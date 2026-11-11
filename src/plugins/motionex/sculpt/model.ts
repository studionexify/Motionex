// Path sculpt: hand-made moves of the toolpath on an unrolled map of the wall. It works on top of any
// pattern (motions, weave, lace, Patternex regions, velocity paint): the wall is cut open and laid flat as a
// grid, columns go round the part from +X counter-clockwise, rows go up from the bottom of the band. Every
// cell holds how far the outer wall is pushed out (+) or pulled in (−), in mm. Plain data, so it travels to the
// slicing worker and into the project file.

export interface SculptSettings {
  enabled: boolean;
  /** Grid size: columns round the part, rows up the band. */
  w: number;
  h: number;
  /** Moves by cell number (row from the top × w + column), mm, + = out. */
  d: Record<number, number>;
  /** Band the map covers (plate mm). z_end of 1e4 = up to the top of the part. */
  z_start: number;
  z_end: number;
  /** Cap on how far any point may move (mm). */
  max_mm: number;
  /** Plate object ids; empty = every object. */
  objects?: string[];
}

export function defaultSculpt(): SculptSettings {
  return { enabled: false, w: 72, h: 40, d: {}, z_start: 0, z_end: 1e4, max_mm: 3 };
}

/** Move (mm) at fraction u (0..1) round the part and height z, smoothly blended between cells (wraps round). */
export function sculptAt(s: SculptSettings, u: number, z: number, top: number): number {
  const span = Math.max(1e-6, Math.min(s.z_end, top) - s.z_start);
  const t = (z - s.z_start) / span;
  if (t < 0 || t > 1) return 0;
  const fx = (u - Math.floor(u)) * s.w - 0.5, fy = (1 - t) * s.h - 0.5; // rows count from the top
  const x0 = Math.floor(fx), y0 = Math.floor(fy), ax = fx - x0, ay = fy - y0;
  const at = (x: number, y: number) => (y < 0 || y >= s.h ? 0 : s.d[y * s.w + (((x % s.w) + s.w) % s.w)] ?? 0);
  const v = at(x0, y0) * (1 - ax) * (1 - ay) + at(x0 + 1, y0) * ax * (1 - ay) + at(x0, y0 + 1) * (1 - ax) * ay + at(x0 + 1, y0 + 1) * ax * ay;
  const cap = s.max_mm > 0 ? s.max_mm : Infinity;
  return Math.max(-cap, Math.min(cap, v));
}

export const sculptActive = (s: SculptSettings) => s.enabled && Object.keys(s.d).length > 0;
