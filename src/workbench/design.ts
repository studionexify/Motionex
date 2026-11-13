// Motionex Studio — design model. A piece is a revolved single wall: a side profile (radius vs height),
// a top-down section, twist / narrowing, and a surface relief. surfaceR(z, θ) is the one function the
// mesh, the estimate and the slicer all read, so what you see is what gets printed.

export type Family = 'vase' | 'pendant' | 'shade' | 'bowl';
export type SectionKind = 'round' | 'faceted' | 'square' | 'petal' | 'star' | 'fluted' | 'flower' | 'teeth';
export type BaseRelief = 'smooth' | 'ribbed' | 'grooves' | 'fins' | 'rings' | 'wavy' | 'guilloche' | 'vwaves' | 'bubbles' | 'bumps' | 'pyramid' | 'diamond' | 'hammered' | 'sand';
/** A built-in relief, a pattern id from reliefs.ts, or 'image' (imported picture / SVG / DXF / text). */
export type ReliefKind = BaseRelief | (string & {});
export interface Relief {
  kind: ReliefKind; count: number; depth: number; start: number; end: number; transition: number;
  aspect?: number; slant?: number; invert?: boolean; sharp?: number; seed?: number; rowShift?: number;
  map?: HeightMap; mapMode?: 'tile' | 'band'; tilesUp?: number;
  /** Image as a sharp traced outline (default) or as grey shades (photos). */
  mapVector?: boolean;
  /** Which face carries the relief. Raised/carved is the sign of depth. */
  side?: 'outside' | 'inside' | 'both';
  /** Edge softness 0 (knife-sharp) … 1 (rounded). */
  edge?: number;
}
import { bevelH, geoSd, mapGeo, patternGeo, type Geo } from './patterngeo';
import { PATTERNS, patternById, sampleMapCubic, sampleMapVector, setEdge, setMinLine, type HeightMap } from './reliefs';
export type TwistShape = 'linear' | 's' | 'wave';

export interface ProfilePoint { r: number; t: number } // r: 0..1 of max radius, t: 0..1 of height
export interface Design {
  name: string;
  family: Family;
  outline: string;
  profile: ProfilePoint[];
  smoothing: number;     // 0 straight … 1 round
  height: number;        // mm
  maxDiameter: number;   // mm
  section: SectionKind;
  sides: number;
  depth: number;         // 0.05..0.5 of radius
  twist: number;         // degrees over the height
  twistShape: TwistShape;
  narrowTop: number;     // -0.6..0.6
  relief: Relief;
  wall: number;          // mm, for the STL wall and estimate
  openBottom: boolean;
}

const TAU = Math.PI * 2;
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const frac = (v: number) => v - Math.floor(v);
const P = (pairs: [number, number][]): ProfilePoint[] => pairs.map(([r, t]) => ({ r, t }));

/** Side silhouettes (r, t). Picking one rewrites the profile and suggests a size and section. */
export const OUTLINES: { id: string; name: string; families: Family[]; pts: ProfilePoint[]; h?: number; d?: number; section?: SectionKind }[] = [
  { id: 'vase', name: 'Vase', families: ['vase'], pts: P([[0.62, 0], [0.92, 0.3], [1, 0.55], [0.72, 0.85], [0.78, 1]]) },
  { id: 'bulb', name: 'Bulb', families: ['vase', 'pendant'], pts: P([[0.55, 0], [0.95, 0.3], [1, 0.5], [0.7, 0.82], [0.35, 1]]) },
  { id: 'cylinder', name: 'Cylinder', families: ['vase', 'shade'], pts: P([[1, 0], [1, 0.5], [1, 1]]), section: 'round' },
  { id: 'hourglass', name: 'Hourglass', families: ['vase', 'shade'], pts: P([[1, 0], [0.62, 0.5], [1, 1]]) },
  { id: 'barrel', name: 'Barrel', families: ['vase', 'shade'], pts: P([[0.8, 0], [1, 0.5], [0.8, 1]]) },
  { id: 'drop', name: 'Drop', families: ['vase', 'pendant'], pts: P([[0.6, 0], [1, 0.25], [0.8, 0.65], [0.22, 1]]) },
  { id: 'cone', name: 'Cone', families: ['vase', 'shade', 'pendant'], pts: P([[1, 0], [0.62, 0.5], [0.25, 1]]) },
  { id: 'funnel', name: 'Funnel', families: ['vase', 'bowl'], pts: P([[0.4, 0], [0.62, 0.5], [1, 1]]) },
  { id: 'meiping', name: 'Shoulder jar', families: ['vase'], pts: P([[0.5, 0], [0.7, 0.45], [1, 0.8], [0.45, 0.95], [0.38, 1]]) },
  { id: 'egg', name: 'Egg', families: ['vase', 'pendant'], pts: P([[0.45, 0], [0.92, 0.25], [1, 0.5], [0.85, 0.78], [0.5, 1]]) },
  { id: 'pebble', name: 'Standing pebble', families: ['vase'], pts: P([[0.7, 0], [1, 0.25], [0.95, 0.65], [0.62, 1]]) },
  { id: 'lobed', name: 'Two lobes', families: ['vase', 'shade'], pts: P([[0.75, 0], [1, 0.25], [0.72, 0.5], [1, 0.75], [0.7, 1]]) },
  { id: 'dome', name: 'Deep dome', families: ['pendant'], pts: P([[1, 0], [0.98, 0.35], [0.82, 0.7], [0.45, 0.93], [0.2, 1]]), h: 160, d: 220 },
  { id: 'bell', name: 'Bell jar', families: ['pendant', 'shade'], pts: P([[1, 0], [0.88, 0.15], [0.7, 0.45], [0.62, 0.8], [0.4, 1]]), h: 190, d: 200 },
  { id: 'halfsphere', name: 'Half sphere', families: ['pendant', 'bowl'], pts: P([[1, 0], [0.94, 0.35], [0.75, 0.68], [0.4, 0.93], [0.2, 1]]), h: 110, d: 220 },
  { id: 'drum', name: 'Soft drum', families: ['shade'], pts: P([[0.92, 0], [1, 0.2], [1, 0.8], [0.92, 1]]), h: 180, d: 220 },
  { id: 'taper', name: 'Tapered drum', families: ['shade'], pts: P([[1, 0], [0.86, 0.5], [0.72, 1]]), h: 200, d: 230 },
  { id: 'waist', name: 'High waist', families: ['shade', 'vase'], pts: P([[0.9, 0], [1, 0.3], [0.7, 0.72], [0.85, 1]]) },
  { id: 'bowl', name: 'Bowl', families: ['bowl'], pts: P([[0.55, 0], [0.85, 0.35], [1, 1]]), h: 70, d: 180 },
  { id: 'tray', name: 'Low tray', families: ['bowl'], pts: P([[0.86, 0], [0.97, 0.4], [1, 1]]), h: 40, d: 160 },
];

export const FAMILIES: { id: Family; name: string; h: number; d: number; outline: string; hint: string }[] = [
  { id: 'vase', name: 'Vase', h: 185, d: 140, outline: 'vase', hint: 'Single-wall vase, prints in spiral mode.' },
  { id: 'pendant', name: 'Pendant', h: 160, d: 220, outline: 'dome', hint: 'Lamp shade that hangs. Print it upside down (flip in the slicer).' },
  { id: 'shade', name: 'Table shade', h: 200, d: 220, outline: 'drum', hint: 'Open-ended drum for a table lamp.' },
  { id: 'bowl', name: 'Bowl & tray', h: 70, d: 180, outline: 'bowl', hint: 'Low, wide pieces.' },
];

export const SECTIONS: { id: SectionKind; name: string }[] = [
  { id: 'round', name: 'Round' }, { id: 'faceted', name: 'Faceted' }, { id: 'square', name: 'Square' }, { id: 'petal', name: 'Petal' },
  { id: 'star', name: 'Star' }, { id: 'fluted', name: 'Fluted' }, { id: 'flower', name: 'Flower' }, { id: 'teeth', name: 'Teeth' },
];

export const RELIEFS: { id: ReliefKind; name: string; group: string; count: number; depth: number }[] = [
  { id: 'smooth', name: 'Smooth', group: 'Smooth', count: 0, depth: 0 },
  { id: 'ribbed', name: 'Ribbed', group: 'Vertical', count: 60, depth: 1.2 },
  { id: 'grooves', name: 'Grooves', group: 'Vertical', count: 40, depth: 1.5 },
  { id: 'fins', name: 'Fins', group: 'Vertical', count: 24, depth: 3 },
  { id: 'rings', name: 'Rings', group: 'Rings', count: 30, depth: 1.2 },
  { id: 'wavy', name: 'Wavy', group: 'Waves', count: 12, depth: 3 },
  { id: 'guilloche', name: 'Guilloche', group: 'Waves', count: 40, depth: 1 },
  { id: 'vwaves', name: 'Vertical waves', group: 'Waves', count: 16, depth: 2.5 },
  { id: 'bubbles', name: 'Bubbles', group: 'Bubbles', count: 18, depth: 2.5 },
  { id: 'bumps', name: 'Bumps', group: 'Bubbles', count: 10, depth: 5 },
  { id: 'pyramid', name: 'Pyramid', group: 'Points', count: 24, depth: 2 },
  { id: 'diamond', name: 'Diamond', group: 'Points', count: 20, depth: 2 },
  { id: 'hammered', name: 'Hammered', group: 'Grain', count: 30, depth: 1.5 },
  { id: 'sand', name: 'Sand', group: 'Grain', count: 120, depth: 0.4 },
];

export function defaultDesign(family: Family = 'vase'): Design {
  const f = FAMILIES.find((x) => x.id === family)!;
  const o = OUTLINES.find((x) => x.id === f.outline)!;
  return {
    name: 'Untitled piece', family, outline: o.id, profile: structuredClone(o.pts), smoothing: 0.8,
    height: o.h ?? f.h, maxDiameter: o.d ?? f.d, section: 'round', sides: 8, depth: 0.15, twist: 0, twistShape: 'linear', narrowTop: 0,
    relief: { kind: 'smooth', count: 0, depth: 0, start: 0, end: 1, transition: 0.06 }, wall: 1.5, openBottom: family === 'shade' || family === 'pendant',
  };
}

// ── profile curve: blend of polyline and Catmull-Rom by smoothing
function sortedProfile(d: Design) { return [...d.profile].sort((a, b) => a.t - b.t); }

export function profileR(d: Design, t: number, pts = sortedProfile(d)): number {
  if (pts.length === 0) return 0.5;
  if (t <= pts[0].t) return pts[0].r;
  if (t >= pts[pts.length - 1].t) return pts[pts.length - 1].r;
  let i = 0;
  while (i < pts.length - 2 && t > pts[i + 1].t) i++;
  const p1 = pts[i], p2 = pts[i + 1], p0 = pts[i - 1] ?? p1, p3 = pts[i + 2] ?? p2;
  const span = p2.t - p1.t || 1e-6, u = (t - p1.t) / span;
  const lin = p1.r + (p2.r - p1.r) * u;
  // Catmull-Rom with slopes scaled to this span
  const m1 = ((p2.r - p0.r) / ((p2.t - p0.t) || 1e-6)) * span, m2 = ((p3.r - p1.r) / ((p3.t - p1.t) || 1e-6)) * span;
  const u2 = u * u, u3 = u2 * u;
  const cr = (2 * u3 - 3 * u2 + 1) * p1.r + (u3 - 2 * u2 + u) * m1 + (-2 * u3 + 3 * u2) * p2.r + (u3 - u2) * m2;
  return Math.max(0.02, lin + (cr - lin) * d.smoothing);
}

function sectionMul(d: Design, th: number): number {
  const n = Math.max(3, Math.round(d.sides)), k = d.depth;
  switch (d.section) {
    case 'round': return 1;
    case 'faceted': { const a = TAU / n, x = frac(th / a) * a - a / 2; return Math.cos(Math.PI / n) / Math.cos(x); }
    case 'square': { const p = 2 + 8 * (1 - k); const c = Math.abs(Math.cos(th)), s = Math.abs(Math.sin(th)); const r = (c ** p + s ** p) ** (-1 / p); return r / 2 ** (0.5 - 1 / p); }
    case 'petal': return 1 - k * (1 - Math.abs(Math.cos((n * th) / 2)));
    case 'star': { const u = frac((n * th) / TAU); return 1 - k * 2 * Math.abs(u - 0.5); }
    case 'fluted': return 1 - k * 0.5 * Math.max(0, Math.cos(n * th)) ** 0.6;
    case 'flower': return 1 - k * (1 - Math.abs(Math.cos((n * th) / 2)) ** 0.5);
    case 'teeth': return 1 - k * frac((n * th) / TAU);
  }
}

function hash(x: number, y: number, z: number) { const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453; return s - Math.floor(s); }
function vnoise(x: number, y: number, z: number) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z), xf = x - xi, yf = y - yi, zf = z - zi;
  const sm = (v: number) => v * v * (3 - 2 * v), u = sm(xf), v = sm(yf), w = sm(zf);
  const L = (a: number, b: number, t: number) => a + (b - a) * t;
  const c = (dx: number, dy: number, dz: number) => hash(xi + dx, yi + dy, zi + dz);
  return L(L(L(c(0, 0, 0), c(1, 0, 0), u), L(c(0, 1, 0), c(1, 1, 0), u), v), L(L(c(0, 0, 1), c(1, 0, 1), u), L(c(0, 1, 1), c(1, 1, 1), u), v), w);
}

/** Relief offset in mm (outward positive) at height t and angle θ for a wall of base radius R. */
/** Cumulative cell rows from the base up to height fraction t: ∫ n / (2πR) · ds along the side profile. Cached per shape. */
let rowKey = NaN, rowTab: Float64Array = new Float64Array(0);
function cellRows(d: Design, t: number, n: number): number {
  // cheap numeric fingerprint of everything the table depends on (this runs for every relief sample)
  let key = d.height * 1.000003 + d.maxDiameter * 7.13 + d.narrowTop * 131.7 + d.smoothing * 977.1 + n * 3.7 + d.profile.length * 11.9;
  for (let i = 0; i < d.profile.length; i++) key += d.profile[i].r * (13.37 + i * 5.1) + d.profile[i].t * (71.3 + i * 3.3);
  const N = 1024;
  if (key !== rowKey) {
    rowKey = key; rowTab = new Float64Array(N + 1);
    const pts = sortedProfile(d), Rmax = d.maxDiameter / 2, dz = d.height / N;
    const Rat = (tt: number) => profileR(d, tt, pts) * Rmax * (1 - d.narrowTop * tt);
    let acc = 0, prevR = Rat(0);
    for (let i = 1; i <= N; i++) {
      const R1 = Rat(i / N), ds = Math.hypot(dz, R1 - prevR), Rm = Math.max(1, (R1 + prevR) / 2);
      acc += ds * n / (TAU * Rm); rowTab[i] = acc; prevR = R1;
    }
  }
  const x = clamp(t, 0, 1) * N, i = Math.min(N - 1, Math.floor(x)), f = x - i;
  return rowTab[i] + (rowTab[i + 1] - rowTab[i]) * f;
}

export function relief(d: Design, t: number, th: number, R: number, raw = false): number {
  const rl = d.relief;
  if (rl.kind === 'smooth' || rl.depth === 0) return 0;
  const tr = Math.max(1e-3, rl.transition);
  const band = clamp((t - rl.start) / tr, 0, 1) * clamp((rl.end - t) / tr, 0, 1);
  if (band <= 0) return 0;
  const n = Math.max(1, Math.round(rl.count)), z = t * d.height;
  const cell = (TAU * R) / n; // square cells: height = width
  // v = true surface distance up the side measured in local cell widths, so cells stay square (circles stay round)
  const u = (th / TAU) * n, v = cellRows(d, t, n);
  let f = 0;
  switch (rl.kind) {
    case 'ribbed': f = 0.5 + 0.5 * Math.cos(n * th); break;
    case 'grooves': f = -(Math.max(0, Math.cos(n * th)) ** 4); break;
    case 'fins': f = Math.max(0, Math.cos(n * th)) ** 12; break;
    case 'rings': f = 0.5 + 0.5 * Math.cos(TAU * z / Math.max(1, d.height / n)); break;
    case 'wavy': f = Math.sin(n * th + TAU * 3 * t); break;
    case 'guilloche': f = 0.5 * (Math.sin(n * th + TAU * 5 * t) + Math.sin(n * th - TAU * 5 * t)); break;
    case 'vwaves': f = Math.sin(n * th + 0.6 * Math.sin(TAU * z / 30)); break;
    case 'bubbles': { const row = Math.floor(v); const x = frac(u + (row % 2) * 0.5) - 0.5, y = frac(v) - 0.5; const r = Math.hypot(x, y) / 0.44; f = r < 1 ? Math.sqrt(1 - r * r) : 0; break; }
    case 'bumps': { const vv = v / 2, row = Math.floor(vv); const x = frac(u + (row % 2) * 0.5) - 0.5, y = (frac(vv) - 0.5) * 2; const r = Math.hypot(x, y * 0.5) / 0.46; f = r < 1 ? Math.sqrt(1 - r * r) : 0; break; }
    case 'pyramid': f = 1 - Math.max(Math.abs(2 * frac(u) - 1), Math.abs(2 * frac(v) - 1)); break;
    case 'diamond': f = Math.max(0, 1 - Math.abs(2 * frac(u) - 1) - Math.abs(2 * frac(v) - 1)); break;
    case 'hammered': { const s = n / 30 / 6; f = 2 * vnoise(Math.cos(th) * R * s, Math.sin(th) * R * s, z * s) - 1; break; }
    case 'sand': { const s = n / 120; f = 2 * vnoise(Math.cos(th) * R * s, Math.sin(th) * R * s, z * s) - 1; break; }
    default: {
      // pattern library / imported height map
      const vv = v / Math.max(0.1, rl.aspect ?? 1);
      const uu = u + vv * Math.tan(((rl.slant ?? 0) * Math.PI) / 180) + Math.floor(vv) * (rl.rowShift ?? 0);
      const gp = geoOf(d, cell, raw);
      if (rl.kind === 'image') {
        if (!rl.map) return 0;
        setEdge(rl.edge ?? 0.15);
        const y = rl.mapMode === 'band' ? 1 - frac(clamp((t - rl.start) / Math.max(1e-3, rl.end - rl.start), 0, 0.9999) * Math.max(1, rl.tilesUp ?? 1)) : 1 - frac(vv);
        if (gp) f = geoHeight(gp, uu, y, cell, bevelOf(rl, cellMaxOf(d)));
        else f = rl.mapVector === false ? sampleMapCubic(rl.map, uu, y) : sampleMapVector(rl.map, uu, y);
      } else {
        const p = patternById(rl.kind); if (!p) return 0;
        if (gp) f = geoHeight(gp, uu, vv, cell, bevelOf(rl, cellMaxOf(d)));
        else f = clamp(p.fn(uu, vv, rl.seed ?? 1), 0, 1);
      }
      if ((rl.sharp ?? 1) !== 1) f = f ** (rl.sharp ?? 1);
      if (rl.invert) f = 1 - f;
    }
  }
  return f * rl.depth * band;
}

function twistEase(d: Design, t: number) {
  if (d.twistShape === 's') return t * t * (3 - 2 * t);
  if (d.twistShape === 'wave') return Math.sin(Math.PI * t);
  return t;
}

/** Radius (mm) of the outer wall at height z (mm) and angle θ (rad). The function every stage reads. */
export function makeSurface(d: Design) {
  const pts = sortedProfile(d), Rmax = d.maxDiameter / 2, tw = (d.twist * Math.PI) / 180;
  return (z: number, th: number): number => {
    const t = clamp(z / d.height, 0, 1);
    const R = profileR(d, t, pts) * Rmax * (1 - d.narrowTop * t);
    const a = th - tw * twistEase(d, t);
    const side = d.relief.side ?? 'outside';
    return Math.max(1, R * sectionMul(d, a) + (side !== 'inside' ? relief(d, t, a, R) : 0));
  };
}

/** The face split into the plain shape and the relief offset (fast meshing: the relief is evaluated once
 *  per point and reused for both the position and the edge tracing). face radius = plain ± relief. */
export function surfaceParts(d: Design, face: 'outer' | 'inner') {
  const pts = sortedProfile(d), Rmax = d.maxDiameter / 2, tw = (d.twist * Math.PI) / 180;
  const side = d.relief.side ?? 'outside';
  const on = d.relief.kind !== 'smooth' && d.relief.depth !== 0 && (face === 'outer' ? side !== 'inside' : side !== 'outside');
  let lastT = NaN, lastR = 0, lastTw = 0;
  const row = (z: number) => { const t = clamp(z / d.height, 0, 1); if (t !== lastT) { lastT = t; lastR = profileR(d, t, pts) * Rmax * (1 - d.narrowTop * t); lastTw = tw * twistEase(d, t); } return t; };
  return {
    on,
    /** relief offset at (z, θ): + outward on the outer face, + into the cavity on the inner face */
    rel: (z: number, th: number) => { if (!on) return 0; const t = row(z); return relief(d, t, th - lastTw, lastR); },
    /** signed distances to the relief's sharp edges (mm), or null */
    edges: (z: number, th: number) => { if (!on) return null; const t = row(z); return reliefEdges(d, t, th - lastTw, lastR); },
    /** face radius given the relief offset */
    radius: (z: number, th: number, rel: number) => {
      row(z); const b = lastR * sectionMul(d, th - lastTw);
      return face === 'outer' ? Math.max(1, b + rel) : Math.max(0.5, b - d.wall - rel);
    },
  };
}

/** Radius (mm) of the inner wall face: the outer shape minus the wall, with the relief inside if asked. */
export function makeInner(d: Design) {
  const pts = sortedProfile(d), Rmax = d.maxDiameter / 2, tw = (d.twist * Math.PI) / 180;
  return (z: number, th: number): number => {
    const t = clamp(z / d.height, 0, 1);
    const R = profileR(d, t, pts) * Rmax * (1 - d.narrowTop * t);
    const a = th - tw * twistEase(d, t);
    const side = d.relief.side ?? 'outside';
    return Math.max(0.5, R * sectionMul(d, a) - d.wall - (side !== 'outside' ? relief(d, t, a, R) : 0));
  };
}

/** Quick numbers for the estimate card (single-wall, spiral). */
export function estimate(d: Design, lineWidth = 0.5, layer = 0.24, speed = 40) {
  const surf = makeSurface(d);
  let area = 0, maxR = 0, minR = Infinity;
  const NZ = 60, NT = 180;
  for (let i = 0; i < NZ; i++) {
    const z = ((i + 0.5) / NZ) * d.height;
    let per = 0, prev = surf(z, 0);
    for (let j = 1; j <= NT; j++) { const th = (j / NT) * TAU, r = surf(z, th); per += Math.hypot(r * Math.cos(th) - prev * Math.cos(th - TAU / NT), r * Math.sin(th) - prev * Math.sin(th - TAU / NT)); prev = r; maxR = Math.max(maxR, r); minR = Math.min(minR, r); }
    area += per * (d.height / NZ);
  }
  const pathLen = area / layer;
  const vol = area * lineWidth + (d.openBottom ? 0 : Math.PI * (profileR(d, 0) * d.maxDiameter / 2) ** 2 * 1.2);
  const grams = (vol / 1000) * 1.24;
  const meters = vol / (Math.PI * 0.875 ** 2) / 1000;
  const warnings: string[] = [];
  const slope = overhang(d);
  if (slope > 50) warnings.push(`Overhang reaches ${slope.toFixed(0)}°: above 45° the wall may sag.`);
  if (d.relief.kind !== 'smooth' && d.relief.depth > d.wall * 1.5) warnings.push(`Relief ${d.relief.depth.toFixed(1)} mm is deep for a ${d.wall} mm wall.`);
  if (minR < 8) warnings.push('The piece gets very narrow: the nozzle may not fit inside.');
  return { maxDiameter: maxR * 2, seconds: pathLen / speed, grams, meters, warnings };
}

/** Worst outward overhang of the profile in degrees from vertical. */
export function overhang(d: Design): number {
  let worst = 0; const Rm = d.maxDiameter / 2;
  for (let i = 1; i <= 100; i++) {
    const t0 = (i - 1) / 100, t1 = i / 100;
    const dr = (profileR(d, t1) * (1 - d.narrowTop * t1) - profileR(d, t0) * (1 - d.narrowTop * t0)) * Rm, dz = d.height / 100;
    worst = Math.max(worst, (Math.atan2(dr, dz) * 180) / Math.PI);
  }
  return worst;
}

const pick = <T,>(a: readonly T[]) => a[Math.floor(Math.random() * a.length)];
/** A random but printable piece in this family. */
export function surprise(family: Family): Design {
  const d = defaultDesign(family);
  const outs = OUTLINES.filter((o) => o.families.includes(family));
  const o = pick(outs);
  d.outline = o.id; d.profile = structuredClone(o.pts); if (o.h) d.height = o.h; if (o.d) d.maxDiameter = o.d;
  d.section = pick(SECTIONS).id; d.sides = 4 + Math.floor(Math.random() * 10); d.depth = 0.06 + Math.random() * 0.18;
  if (Math.random() < 0.45) d.section = 'round';
  d.twist = Math.random() < 0.5 ? 0 : Math.round(Math.random() * 18) * 10; d.twistShape = pick(['linear', 's', 'wave'] as const);
  const r = pick(RELIEFS); d.relief = { ...d.relief, kind: r.id, count: r.count, depth: r.depth };
  for (let k = 0; k < 6 && overhang(d) > 50; k++) d.height *= 1.15;
  return d;
}

/** Every relief the UI offers: the basics plus the pattern library, grouped. */
export const ALL_RELIEFS: { id: ReliefKind; name: string; group: string; count: number; depth: number }[] = [
  ...RELIEFS.map((r) => ({ ...r, group: 'Basics' })),
  ...PATTERNS.map((p) => ({ id: p.id, name: p.name, group: p.group, count: p.count, depth: p.depth })),
];
export const NOISE_RELIEFS = new Set(['hammered', 'sand', ...PATTERNS.filter((p) => p.noise).map((p) => p.id)]);

/** Mesh grid fine enough for the relief: ~32 samples per pattern cell each way, capped at maxVerts. */
export function meshGrid(d: Design, maxVerts = 600_000, quick = false) {
  const rl = d.relief, R = d.maxDiameter / 2;
  let cols = 160, rows = Math.max(60, Math.round(d.height / 1));
  if (d.section !== 'round') cols = Math.max(cols, d.sides * 16);
  if (rl.kind !== 'smooth' && rl.depth !== 0) {
    const n = Math.max(1, rl.count), cell = (2 * Math.PI * R) / n, vcell = cell * (rl.aspect ?? 1);
    cols = Math.max(cols, n * 48);
    rows = Math.max(rows, Math.round(d.height / Math.max(0.15, vcell / 48)));
    if (rl.kind === 'rings') rows = Math.max(rows, n * 24);
  }
  cols = Math.min(cols, 1800); rows = Math.min(rows, 1400);
  const k = Math.sqrt(Math.min(1, maxVerts / ((rows + 1) * (cols + 1))));
  if (k < 1) { cols = Math.max(96, Math.floor(cols * k)); rows = Math.max(40, Math.floor(rows * k)); }
  if (quick) { cols = Math.max(96, cols >> 1); rows = Math.max(40, rows >> 1); }
  return { rows, cols };
}

// ── exact pattern geometry (see patterngeo.ts)
/** Bevel width in mm from the edge-softness setting: 0 → 0.25 mm (crisp), 1 → 1.75 mm; never over 30 % of a cell. */
export const bevelOf = (rl: Relief, cellMax: number) => Math.min(cellMax * 0.3, 0.25 + 1.5 * (rl.edge ?? 0.15));
const cellMaxOf = (d: Design) => (TAU * d.maxDiameter / 2) / Math.max(1, Math.round(d.relief.count));
/** Sharp-pattern geometry for this relief, or null for smooth patterns / thumbnails. */
let memo: { rl: Relief | null; kind: string; seed: number; edge: number; vec: boolean; map: unknown; maxD: number; n: number; g: Geo | null; minW: number } =
  { rl: null, kind: '', seed: 0, edge: 0, vec: true, map: null, maxD: 0, n: 0, g: null, minW: 0 };
function geoOf(d: Design, _cell: number, raw: boolean): Geo | null {
  const rl = d.relief;
  if (raw) return null;
  // one geometry per piece: line widths are fixed from the widest cell, so every row shares it
  const n = Math.max(1, Math.round(rl.count)), edge = rl.edge ?? 0.15, seed = rl.seed ?? 1, vec = rl.mapVector !== false;
  const m = memo;
  if (m.rl === rl && m.kind === rl.kind && m.seed === seed && m.edge === edge && m.vec === vec && m.map === rl.map && m.maxD === d.maxDiameter && m.n === n) {
    if (rl.kind !== 'image') { setEdge(edge); setMinLine(m.minW); }
    return m.g;
  }
  const cellMax = (TAU * d.maxDiameter / 2) / n, minW = 1.1 / Math.max(1, cellMax);
  let g: Geo | null = null;
  if (rl.kind === 'image') g = rl.map && vec ? mapGeo(rl.map) : null;
  else {
    // pattern lines at least ~1.6 mm wide on the real surface (4 nozzle widths): crisp to print and to mesh
    setEdge(edge); setMinLine(minW);
    const pg = patternGeo(rl.kind, seed, `${minW.toFixed(4)}|${edge}`);
    g = pg && pg.sharp ? pg : null;
  }
  memo = { rl, kind: rl.kind, seed, edge, vec, map: rl.map, maxD: d.maxDiameter, n, g, minW };
  return g;
}
function geoHeight(g: Geo, u: number, v: number, cell: number, bev: number) {
  let f = g.base;
  for (const lv of g.levels) f += lv.step * bevelH(geoSd(g, lv, u, v) * cell, bev);
  return f;
}
/** Signed distances (mm) to every edge of a sharp relief at (t, θ), and the bevel width; null when the relief
 *  has no sharp edges. The mesher snaps vertices onto sd = ±bevel/2. */
export function reliefEdges(d: Design, t: number, th: number, R: number): { sd: number[]; bev: number } | null {
  const rl = d.relief;
  if (rl.kind === 'smooth' || rl.depth === 0) return null;
  const tr = Math.max(1e-3, rl.transition);
  if (clamp((t - rl.start) / tr, 0, 1) * clamp((rl.end - t) / tr, 0, 1) <= 0) return null;
  const n = Math.max(1, Math.round(rl.count)), cell = (TAU * R) / n;
  const gp = geoOf(d, cell, false); if (!gp) return null;
  const u = (th / TAU) * n, v = cellRows(d, t, n);
  const vv = v / Math.max(0.1, rl.aspect ?? 1);
  const uu = u + vv * Math.tan(((rl.slant ?? 0) * Math.PI) / 180) + Math.floor(vv) * (rl.rowShift ?? 0);
  const y = rl.kind !== 'image' ? vv : rl.mapMode === 'band' ? 1 - frac(clamp((t - rl.start) / Math.max(1e-3, rl.end - rl.start), 0, 0.9999) * Math.max(1, rl.tilesUp ?? 1)) : 1 - frac(vv);
  return { sd: gp.levels.map((lv) => geoSd(gp, lv, uu, y) * cell), bev: bevelOf(rl, cellMaxOf(d)) };
}
