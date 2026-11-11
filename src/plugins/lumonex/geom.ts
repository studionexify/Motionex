// Lumonex geometry kernel: closed, outward-facing shells built from rings of points. Every part is a
// union of shells (the slicer unions overlapping shells with non-zero fill), and holes that a ring
// cannot express (side cable exits, switch cut-outs, magnet pockets) are negative part volumes.
import { weld, type IndexedMesh } from '../../engine/mesh';

export type V3 = [number, number, number];
/** One closed loop of points, all at the same "row" of a shell. */
export type Ring = V3[];
/** Triangle soup (x, y, z per vertex, 3 vertices per triangle). */
export type Soup = number[];

const TAU = Math.PI * 2;
export const tau = TAU;

/** Polar ring around (cx, cy): r(θ) for n samples, θ = 2πj/n, exactly periodic. */
export function polarRing(n: number, z: number, r: (a: number) => number, cx = 0, cy = 0): Ring {
  const out: Ring = [];
  for (let j = 0; j < n; j++) { const a = (j / n) * TAU, k = Math.max(0, r(a)); out.push([cx + k * Math.cos(a), cy + k * Math.sin(a), z]); }
  return out;
}

function quad(out: Soup, a: V3, b: V3, c: V3, d: V3) { out.push(...a, ...b, ...c, ...a, ...c, ...d); }

/** Surface between consecutive rings (same point count), facing out when rings run bottom → top counter-clockwise. */
function band(out: Soup, rings: Ring[], flip: boolean) {
  for (let k = 0; k < rings.length - 1; k++) {
    const A = rings[k], B = rings[k + 1], n = A.length;
    for (let j = 0; j < n; j++) {
      const j1 = (j + 1) % n;
      if (flip) quad(out, A[j], B[j], B[j1], A[j1]);
      else quad(out, A[j], A[j1], B[j1], B[j]);
    }
  }
}

/** Annulus between an outer and an inner ring (same count). */
function annulus(out: Soup, outer: Ring, inner: Ring, up: boolean) {
  const n = outer.length;
  for (let j = 0; j < n; j++) {
    const j1 = (j + 1) % n;
    if (up) quad(out, outer[j], outer[j1], inner[j1], inner[j]);
    else quad(out, outer[j], inner[j], inner[j1], outer[j1]);
  }
}

function fan(out: Soup, ring: Ring, up: boolean) {
  const n = ring.length;
  const c: V3 = [0, 0, 0];
  for (const p of ring) { c[0] += p[0] / n; c[1] += p[1] / n; c[2] += p[2] / n; }
  for (let j = 0; j < n; j++) {
    const j1 = (j + 1) % n;
    if (up) out.push(...c, ...ring[j], ...ring[j1]);
    else out.push(...c, ...ring[j1], ...ring[j]);
  }
}

/** Signed volume of a soup (> 0 when it faces out). */
export function soupVolume(s: ArrayLike<number>): number {
  let v = 0;
  for (let i = 0; i < s.length; i += 9) {
    const ax = s[i], ay = s[i + 1], az = s[i + 2], bx = s[i + 3], by = s[i + 4], bz = s[i + 5], cx = s[i + 6], cy = s[i + 7], cz = s[i + 8];
    v += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return v / 6;
}

/** Make a closed soup face outward. */
export function orient(s: Soup): Soup {
  if (soupVolume(s) >= 0) return s;
  for (let i = 0; i < s.length; i += 9) for (let k = 0; k < 3; k++) { const t = s[i + 3 + k]; s[i + 3 + k] = s[i + 6 + k]; s[i + 6 + k] = t; }
  return s;
}

/** Hollow closed shell: outer and inner rings bottom → top, capped by annuli. */
export function tubeShell(outer: Ring[], inner: Ring[]): Soup {
  const out: Soup = [];
  band(out, outer, false);
  band(out, inner, true);
  annulus(out, outer[0], inner[0], false);
  annulus(out, outer[outer.length - 1], inner[inner.length - 1], true);
  return orient(out);
}

/** Solid closed shell: rings bottom → top, capped with fans. */
export function solidShell(rings: Ring[]): Soup {
  const out: Soup = [];
  band(out, rings, false);
  fan(out, rings[0], false);
  fan(out, rings[rings.length - 1], true);
  return orient(out);
}

/** Solid of revolution from [r, z] samples (r > 0), n segments. */
export function lathe(profile: [number, number][], n = 64, cx = 0, cy = 0): Soup {
  return solidShell(profile.map(([r, z]) => polarRing(n, z, () => r, cx, cy)));
}

/** Hollow solid of revolution: [rOuter, rInner, z] rows. */
export function latheTube(rows: [number, number, number][], n = 64, cx = 0, cy = 0): Soup {
  return tubeShell(rows.map(([ro, , z]) => polarRing(n, z, () => ro, cx, cy)), rows.map(([, ri, z]) => polarRing(n, z, () => ri, cx, cy)));
}

export const cylinder = (r: number, z0: number, z1: number, n = 48, cx = 0, cy = 0) => lathe([[r, z0], [r, z1]], n, cx, cy);
export const ringSolid = (ro: number, ri: number, z0: number, z1: number, n = 64) => latheTube([[ro, ri, z0], [ro, ri, z1]], n);

/** Axis-aligned box. */
export function box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): Soup {
  const r: Ring = [[x0, y0, 0], [x1, y0, 0], [x1, y1, 0], [x0, y1, 0]];
  return solidShell([r.map(([x, y]) => [x, y, z0] as V3), r.map(([x, y]) => [x, y, z1] as V3)]);
}

/** Rounded rectangle prism (plates, backplates). */
export function roundedPrism(w: number, h: number, rad: number, z0: number, z1: number, n = 12): Soup {
  const pts: [number, number][] = [];
  const rr = Math.min(rad, w / 2 - 0.01, h / 2 - 0.01);
  const corners: [number, number, number][] = [[w / 2 - rr, h / 2 - rr, 0], [-w / 2 + rr, h / 2 - rr, 90], [-w / 2 + rr, -h / 2 + rr, 180], [w / 2 - rr, -h / 2 + rr, 270]];
  for (const [cx, cy, a0] of corners) for (let i = 0; i <= n; i++) { const a = ((a0 + (90 * i) / n) * Math.PI) / 180; pts.push([cx + rr * Math.cos(a), cy + rr * Math.sin(a)]); }
  return solidShell([pts.map(([x, y]) => [x, y, z0] as V3), pts.map(([x, y]) => [x, y, z1] as V3)]);
}

/** Extrude a closed CCW polygon between z0 and z1. */
export const prism = (poly: [number, number][], z0: number, z1: number): Soup =>
  solidShell([poly.map(([x, y]) => [x, y, z0] as V3), poly.map(([x, y]) => [x, y, z1] as V3)]);

/** Cylinder from point a to point b (struts, legs, arms, cross holes). */
export function strut(a: V3, b: V3, r: number, n = 24): Soup {
  const d: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const L = Math.hypot(...d) || 1;
  const w: V3 = [d[0] / L, d[1] / L, d[2] / L];
  const t: V3 = Math.abs(w[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  let u: V3 = [w[1] * t[2] - w[2] * t[1], w[2] * t[0] - w[0] * t[2], w[0] * t[1] - w[1] * t[0]];
  const ul = Math.hypot(...u); u = [u[0] / ul, u[1] / ul, u[2] / ul];
  const v: V3 = [w[1] * u[2] - w[2] * u[1], w[2] * u[0] - w[0] * u[2], w[0] * u[1] - w[1] * u[0]];
  const ring = (c: V3): Ring => Array.from({ length: n }, (_, j) => {
    const a = (j / n) * TAU, ca = Math.cos(a) * r, sa = Math.sin(a) * r;
    return [c[0] + u[0] * ca + v[0] * sa, c[1] + u[1] * ca + v[1] * sa, c[2] + u[2] * ca + v[2] * sa] as V3;
  });
  return solidShell([ring(a), ring(b)]);
}

/** Torus section swept along a circular arc in the XZ plane (handles, bails, hooks). */
export function arcTube(R: number, r: number, a0: number, a1: number, cx = 0, cz = 0, steps = 32, n = 16): Soup {
  const rings: Ring[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = a0 + ((a1 - a0) * i) / steps;
    const c: V3 = [cx + R * Math.cos(a), 0, cz + R * Math.sin(a)];
    const nx = Math.cos(a), nz = Math.sin(a);
    rings.push(Array.from({ length: n }, (_, j) => {
      const b = (j / n) * TAU, cb = Math.cos(b) * r, sb = Math.sin(b) * r;
      return [c[0] + nx * cb, sb, c[2] + nz * cb] as V3;
    }));
  }
  return solidShell(rings);
}

export function translate(s: Soup, dx: number, dy: number, dz: number): Soup {
  for (let i = 0; i < s.length; i += 3) { s[i] += dx; s[i + 1] += dy; s[i + 2] += dz; }
  return s;
}

/** Rotate about Z by degrees. */
export function rotateZ(s: Soup, deg: number): Soup {
  const c = Math.cos((deg * Math.PI) / 180), sn = Math.sin((deg * Math.PI) / 180);
  for (let i = 0; i < s.length; i += 3) { const x = s[i], y = s[i + 1]; s[i] = x * c - y * sn; s[i + 1] = x * sn + y * c; }
  return s;
}

/** Rotate about X by degrees (keeps winding: rotations are proper). */
export function rotateX(s: Soup, deg: number): Soup {
  const c = Math.cos((deg * Math.PI) / 180), sn = Math.sin((deg * Math.PI) / 180);
  for (let i = 0; i < s.length; i += 3) { const y = s[i + 1], z = s[i + 2]; s[i + 1] = y * c - z * sn; s[i + 2] = y * sn + z * c; }
  return s;
}

/** Turn a part upside down (rotate 180° about X). */
export const flip = (s: Soup) => rotateX(s, 180);

export function bounds(s: ArrayLike<number>): { min: V3; max: V3 } {
  const min: V3 = [Infinity, Infinity, Infinity], max: V3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < s.length; i += 3) for (let k = 0; k < 3; k++) { const v = s[i + k]; if (v < min[k]) min[k] = v; if (v > max[k]) max[k] = v; }
  return { min, max };
}

export const merge = (...soups: Soup[]): Soup => { const out: Soup = []; for (const s of soups) for (let i = 0; i < s.length; i++) out.push(s[i]); return out; };

export function toMesh(s: Soup): IndexedMesh { return weld(new Float32Array(s), 1e-6); }

// ---------------------------------------------------------------- periodic helpers
export const fract = (x: number) => x - Math.floor(x);
/** Triangle wave 0..1..0 over one period. */
export const tri = (x: number) => 1 - Math.abs(2 * fract(x) - 1);
export const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
export const smooth = (e0: number, e1: number, x: number) => { const t = clamp((x - e0) / (e1 - e0 || 1e-9), 0, 1); return t * t * (3 - 2 * t); };
/** Shortest angular distance (radians). */
export const angDist = (a: number, b: number) => { const d = fract((a - b) / TAU + 0.5) - 0.5; return Math.abs(d * TAU); };

/** Append without spreading (soups are too big for argument lists). */
export function app<T>(out: T[], s: ArrayLike<T>): T[] { for (let i = 0; i < s.length; i++) out.push(s[i]); return out; }
