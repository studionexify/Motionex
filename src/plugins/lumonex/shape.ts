// Lumonex shape language: a silhouette (7 editable radius handles), a cross-section, X/Y/Z scaling,
// twist and lean, then stacked surface patterns (up to 4 layers, each in its own height band).
// Everything resolves to an outer radius R(θ, t) and an inner radius, so any combination gives a
// closed printable shell.
import { clamp, fract, polarRing, smooth, tau, tri, tubeShell, solidShell, type Ring, type Soup, type V3 } from './geom';
import { app } from './geom';

export type SectionKind = 'circle' | 'polygon' | 'star' | 'squircle' | 'petal' | 'gear' | 'half' | 'teardrop';

export const SECTIONS: [SectionKind, string][] = [
  ['circle', 'Round'], ['polygon', 'Polygon'], ['star', 'Star'], ['squircle', 'Squircle'], ['petal', 'Petal'],
  ['gear', 'Gear / cog'], ['half', 'Half (flat back, wall)'], ['teardrop', 'Teardrop'],
];

export type PatternKind =
  | 'none' | 'flutes' | 'pleats' | 'origami' | 'chevron' | 'cog' | 'waves' | 'helix' | 'stack' | 'accordion'
  | 'rhombo' | 'lattice' | 'scales' | 'knurl' | 'bubbles' | 'honeycomb' | 'voronoi' | 'ripple' | 'basket'
  | 'bamboo' | 'spiral' | 'noise' | 'steps' | 'fins' | 'ribbon' | 'wave-fins';

export const PATTERNS: [PatternKind, string][] = [
  ['none', 'None'], ['flutes', 'Flutes (round ribs)'], ['pleats', 'Pleats (sharp)'], ['origami', 'Origami facets'],
  ['chevron', 'Chevron / zig-zag'], ['cog', 'Cog teeth'], ['waves', 'Waves'], ['helix', 'Helix ribs'],
  ['stack', 'Stack (pillow rings)'], ['accordion', 'Accordion'], ['rhombo', 'Rhombo pillows'], ['lattice', 'Lattice ridges'],
  ['scales', 'Scales'], ['knurl', 'Diamond knurl'], ['bubbles', 'Bubbles / dimples'], ['honeycomb', 'Honeycomb'],
  ['voronoi', 'Voronoi cells'], ['ripple', 'Ripple'], ['basket', 'Basket weave'], ['bamboo', 'Bamboo'],
  ['spiral', 'Spiral groove'], ['noise', 'Organic noise'], ['steps', 'Terraced steps'],
  ['fins', 'Horizontal fins / slats'], ['ribbon', 'Twisted ribbons'], ['wave-fins', 'Wavy fins'],
];

export type Envelope = 'flat' | 'fade-up' | 'fade-down' | 'middle' | 'ends';

export interface PatternLayer {
  type: PatternKind;
  enabled: boolean;
  /** Repeats around. */
  count: number;
  /** Repeats up the height. */
  rows: number;
  /** Radial depth in mm (negative cuts in). */
  depth: number;
  /** Turns of twist over the band. */
  twist: number;
  /** 0.2..4: shape of each repeat (rounder ↔ sharper). */
  sharpness: number;
  /** Height band (0..1). */
  from: number;
  to: number;
  envelope: Envelope;
  /** Random seed for noise / voronoi. */
  seed: number;
}

export interface ShapeSpec {
  /** Silhouette id the handles came from (label only). */
  silhouette: string;
  /** 7 radius handles, bottom → top, as a fraction of the maximum radius. */
  handles: number[];
  height: number;
  /** Maximum diameter (mm). */
  diameter: number;
  scaleX: number;
  scaleY: number;
  section: SectionKind;
  sides: number;
  /** 0 sharp corners .. 1 round. */
  rounding: number;
  /** Star / petal / gear depth (0..0.6), squircle exponent uses it too. */
  sectionDepth: number;
  /** Degrees of whole-body twist over the height. */
  twist: number;
  /** Top offset along X / Y (mm), for leaning forms. */
  leanX: number;
  leanY: number;
  patterns: PatternLayer[];
  /** Wall thickness (mm), measured normal to the silhouette. */
  wall: number;
  /** Inner wall follows the pattern (thin, glowing ribs) or stays smooth (solid ribs). */
  innerFollows: boolean;
  /** Solid body for spiral-vase printing instead of a wall. */
  vase: boolean;
  /** Close the bottom with a floor of this thickness (0 = open). */
  floor: number;
  /** Close the top with a lid of this thickness (0 = open). */
  roof: number;
}

export const pattern = (type: PatternKind, p: Partial<PatternLayer> = {}): PatternLayer => ({
  type, enabled: true, count: 36, rows: 6, depth: 3, twist: 0, sharpness: 1, from: 0, to: 1, envelope: 'flat', seed: 1, ...p,
});

// ---------------------------------------------------------------- silhouettes
export const SILHOUETTES: { id: string; name: string; handles: number[] }[] = [
  { id: 'cylinder', name: 'Cylinder', handles: [1, 1, 1, 1, 1, 1, 1] },
  { id: 'drum', name: 'Drum (soft edges)', handles: [0.94, 0.99, 1, 1, 1, 0.99, 0.94] },
  { id: 'cone', name: 'Cone (wide bottom)', handles: [1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4] },
  { id: 'empire', name: 'Empire (coolie)', handles: [1, 0.88, 0.76, 0.64, 0.52, 0.42, 0.34] },
  { id: 'taper', name: 'Taper (wide top)', handles: [0.5, 0.58, 0.66, 0.74, 0.82, 0.91, 1] },
  { id: 'barrel', name: 'Barrel', handles: [0.8, 0.93, 0.99, 1, 0.99, 0.93, 0.8] },
  { id: 'orb', name: 'Orb / globe', handles: [0.42, 0.82, 0.97, 1, 0.97, 0.82, 0.42] },
  { id: 'capsule', name: 'Capsule (Amphora)', handles: [0.6, 0.95, 1, 1, 1, 0.95, 0.6] },
  { id: 'dome', name: 'Dome / mushroom cap', handles: [1, 0.98, 0.93, 0.84, 0.7, 0.48, 0.2] },
  { id: 'bell', name: 'Bell', handles: [1, 0.86, 0.68, 0.58, 0.54, 0.46, 0.3] },
  { id: 'tulip', name: 'Tulip', handles: [0.45, 0.72, 0.92, 1, 0.96, 0.9, 0.86] },
  { id: 'hourglass', name: 'Hourglass', handles: [1, 0.82, 0.64, 0.56, 0.64, 0.82, 1] },
  { id: 'gourd', name: 'Gourd', handles: [0.5, 0.8, 0.98, 0.95, 0.7, 0.55, 0.48] },
  { id: 'onion', name: 'Onion', handles: [0.36, 0.78, 0.98, 1, 0.82, 0.48, 0.26] },
  { id: 'pagoda', name: 'Pagoda (tiered)', handles: [1, 0.66, 0.86, 0.56, 0.72, 0.42, 0.5] },
  { id: 'pear', name: 'Pear / teardrop', handles: [0.66, 0.96, 1, 0.9, 0.7, 0.48, 0.3] },
  { id: 'saucer', name: 'Saucer (flat wide)', handles: [0.5, 0.9, 1, 0.98, 0.86, 0.6, 0.3] },
  { id: 'vase', name: 'Vase', handles: [0.7, 0.9, 1, 0.76, 0.5, 0.52, 0.66] },
  { id: 'lantern', name: 'Lantern (pillow)', handles: [0.72, 0.9, 0.98, 1, 0.98, 0.9, 0.72] },
  { id: 'flare', name: 'Flared skirt', handles: [1, 0.74, 0.6, 0.55, 0.53, 0.52, 0.52] },
  { id: 'trumpet', name: 'Trumpet', handles: [1, 0.6, 0.44, 0.38, 0.35, 0.34, 0.34] },
  { id: 'spool', name: 'Spool', handles: [1, 0.78, 0.7, 0.68, 0.7, 0.78, 1] },
  { id: 'chalice', name: 'Chalice', handles: [0.66, 0.42, 0.36, 0.46, 0.72, 0.94, 1] },
];

/** Catmull-Rom through the 7 handles. */
export function handleAt(h: number[], t: number): number {
  const n = h.length - 1, x = clamp(t, 0, 1) * n, i = Math.min(n - 1, Math.floor(x)), u = x - i;
  const p0 = h[Math.max(0, i - 1)], p1 = h[i], p2 = h[i + 1], p3 = h[Math.min(n, i + 2)];
  return Math.max(0.02, 0.5 * (2 * p1 + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u * u + (-p0 + 3 * p1 - 3 * p2 + p3) * u * u * u));
}

// ---------------------------------------------------------------- cross-section (unit circumradius)
export function sectionAt(s: ShapeSpec, a: number): number {
  const n = Math.max(2, Math.round(s.sides)), k = clamp(s.sectionDepth, 0, 0.9), rnd = clamp(s.rounding, 0, 1);
  switch (s.section) {
    case 'polygon': {
      const seg = tau / n, poly = Math.cos(Math.PI / n) / Math.cos(fract(a / seg) * seg - Math.PI / n);
      return poly + (1 - poly) * rnd;
    }
    case 'star': return 1 - k * Math.pow(tri((a * n) / tau), 1 / Math.max(0.2, 1 - rnd * 0.8));
    case 'petal': return 1 - k * (1 - Math.abs(Math.cos((a * n) / 2)));
    case 'gear': return 1 - k * smooth(0.5 - 0.25 * (1 - rnd) - 0.01, 0.5 + 0.25 * (1 - rnd) + 0.01, tri((a * n) / tau));
    case 'squircle': {
      const p = 2 + (1 - rnd) * 8, c = Math.abs(Math.cos(a)), sn = Math.abs(Math.sin(a));
      return Math.pow(Math.pow(c, p) + Math.pow(sn, p), -1 / p) / Math.SQRT2 ** (1 - 2 / p);
    }
    case 'half': {
      const flat = Math.max(0.05, 1 - k); // back wall at x = -flat
      const c = -Math.cos(a);
      return c > 0 ? Math.min(1, flat / c) : 1;
    }
    case 'teardrop': return 1 - k * 0.5 * (1 + Math.cos(a)) * (1 - Math.abs(Math.sin(a)));
    default: return 1;
  }
}

// ---------------------------------------------------------------- patterns
function hash(x: number, y: number, seed: number) { const h = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453; return h - Math.floor(h); }

function valueNoise(x: number, y: number, seed: number, periodX: number) {
  const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
  const w = (i: number) => ((i % periodX) + periodX) % periodX;
  const a = hash(w(xi), yi, seed), b = hash(w(xi + 1), yi, seed), c = hash(w(xi), yi + 1, seed), d = hash(w(xi + 1), yi + 1, seed);
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

function cellular(u: number, v: number, seed: number, periodX: number): [number, number] {
  const xi = Math.floor(u), yi = Math.floor(v);
  let f1 = 9, f2 = 9;
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
    const cx = xi + dx, cy = yi + dy, wx = ((cx % periodX) + periodX) % periodX;
    const px = cx + hash(wx, cy, seed), py = cy + hash(wx, cy, seed + 9);
    const d = Math.hypot(u - px, v - py);
    if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) f2 = d;
  }
  return [f1, f2];
}

const shape = (x: number, sharp: number) => Math.pow(clamp(x, 0, 1), sharp);

/** Unit pattern value (0..1, sometimes −1..1) at angle a, height t. */
export function patternUnit(p: PatternLayer, a: number, t: number): number {
  const n = Math.max(1, Math.round(p.count)), m = Math.max(0.5, p.rows), sh = clamp(p.sharpness, 0.2, 6);
  const tb = (t - p.from) / Math.max(1e-6, p.to - p.from);
  const u = (a / tau) * n + p.twist * n * tb, v = tb * m;
  switch (p.type) {
    case 'flutes': return shape(0.5 + 0.5 * Math.cos(tau * u), sh);
    case 'pleats': return shape(tri(u), sh);
    case 'origami': return shape(tri(u + 0.5 * tri(v)), sh);
    case 'chevron': return shape(tri(u + tri(v)), sh);
    case 'cog': { const w = 0.25 / sh; return smooth(0.5 - w - 0.02, 0.5 - w + 0.02, tri(u)); }
    case 'waves': return 0.5 + 0.5 * Math.sin(tau * u) * Math.cos(tau * v);
    case 'helix': return shape(0.5 + 0.5 * Math.cos(tau * (u + v)), sh);
    case 'stack': return Math.pow(Math.max(0, Math.sin(Math.PI * fract(v))), 0.5 / sh);
    case 'accordion': return shape(tri(v), sh);
    case 'rhombo': { const d = Math.abs(2 * fract(u) - 1) + Math.abs(2 * fract(v) - 1); return shape(1 - Math.min(1, d), 1 / sh); }
    case 'lattice': { const d = Math.abs(2 * fract(u) - 1) + Math.abs(2 * fract(v) - 1); return shape(1 - Math.min(1, Math.abs(d - 1) / (0.18 / sh)), 1); }
    case 'scales': {
      const row = Math.floor(v), uu = u + (row % 2) * 0.5, cx = Math.floor(uu) + 0.5;
      const dx = (uu - cx) * 2, dy = (fract(v) - 0) * 1.2;
      const d = Math.hypot(dx, dy);
      return d < 1 ? Math.pow(1 - d * d, 0.5 / sh) : 0;
    }
    case 'knurl': return shape(0.5 * (tri(u + v) + tri(u - v)), sh);
    case 'bubbles': {
      const row = Math.floor(v), uu = u + (row % 2) * 0.5;
      const d = Math.hypot((fract(uu) - 0.5) * 2, (fract(v) - 0.5) * 2);
      return d < 0.9 ? Math.pow(1 - (d / 0.9) ** 2, 0.5 / sh) : 0;
    }
    case 'honeycomb': {
      const row = Math.floor(v), uu = u + (row % 2) * 0.5;
      const dx = Math.abs(fract(uu) - 0.5) * 2, dy = Math.abs(fract(v) - 0.5) * 2;
      const hex = Math.max(dx * 0.866 + dy * 0.5, dy);
      return smooth(0.8 - 0.1 / sh, 0.95, hex);
    }
    case 'voronoi': { const [f1, f2] = cellular(u, v, p.seed, n); return 1 - smooth(0, 0.12 * sh, f2 - f1); }
    case 'ripple': return 0.5 + 0.5 * Math.sin(tau * v + 0.6 * Math.sin(tau * u));
    case 'basket': {
      const cu = Math.floor(u * 2), cv = Math.floor(v * 2), odd = (cu + cv) % 2 === 0;
      return odd ? 0.5 + 0.5 * Math.cos(tau * v * 2) : 0.5 + 0.5 * Math.cos(tau * u * 2);
    }
    case 'bamboo': {
      const node = Math.exp(-((fract(v + 0.5) - 0.5) ** 2) / 0.002);
      return 0.35 * shape(0.5 + 0.5 * Math.cos(tau * u), sh) + 0.65 * node;
    }
    case 'spiral': return -smooth(0.85 - 0.1 / sh, 1, 0.5 + 0.5 * Math.cos(tau * (u / n + v)));
    case 'noise': return valueNoise(u, v * 2, p.seed, n) * 0.65 + valueNoise(u * 2, v * 4, p.seed + 3, n * 2) * 0.35;
    case 'steps': return Math.floor(v) / Math.max(1, Math.ceil(m) - 1) + smooth(1 - 0.1 * sh, 1, fract(v)) / Math.max(1, m);
    case 'fins': return smooth(1 - 0.35 / sh, 1 - 0.3 / sh + 0.04, 1 - Math.abs(2 * fract(v) - 1));
    case 'ribbon': { const w = 0.5 + 0.5 * Math.cos(tau * (u + v)); return Math.pow(w, sh) * (0.6 + 0.4 * Math.cos(tau * v * 2)); }
    case 'wave-fins': return smooth(0.7, 0.72 + 0.1 / sh, 1 - Math.abs(2 * fract(v + 0.25 * Math.sin(tau * u / Math.max(1, n / 4))) - 1));
    default: return 0;
  }
}

function envelopeAt(e: Envelope, tb: number) {
  switch (e) {
    case 'fade-up': return tb;
    case 'fade-down': return 1 - tb;
    case 'middle': return Math.sin(Math.PI * tb);
    case 'ends': return 1 - Math.sin(Math.PI * tb);
    default: return 1;
  }
}

/** Radial offset of all pattern layers (mm). */
export function patternOffset(layers: PatternLayer[], a: number, t: number): number {
  let d = 0;
  for (const p of layers) {
    if (!p.enabled || p.type === 'none' || !p.depth) continue;
    const lo = Math.min(p.from, p.to), hi = Math.max(p.from, p.to);
    if (t < lo - 1e-9 || t > hi + 1e-9) continue;
    const tb = (t - lo) / Math.max(1e-6, hi - lo);
    const edge = Math.min(1, Math.min(tb, 1 - tb) / 0.04 + (lo <= 0 && tb < 0.5 ? 1 : 0) + (hi >= 1 && tb > 0.5 ? 1 : 0));
    d += p.depth * patternUnit(p, a, t) * envelopeAt(p.envelope, tb) * edge;
  }
  return d;
}

// ---------------------------------------------------------------- evaluation
/** Smooth (pattern-free) radius at angle a, height t. */
export function baseRadius(s: ShapeSpec, a: number, t: number): number {
  return (s.diameter / 2) * handleAt(s.handles, t) * sectionAt(s, a - (s.twist * Math.PI) / 180 * t);
}

export function outerRadius(s: ShapeSpec, a: number, t: number): number {
  const at = a - ((s.twist * Math.PI) / 180) * t;
  return Math.max(0.5, baseRadius(s, a, t) + patternOffset(s.patterns, at, t));
}

/** Silhouette slope factor: radial wall needed for a normal wall of 1 mm. */
export function slopeFactor(s: ShapeSpec, t: number): number {
  const dt = 0.002, R = s.diameter / 2;
  const dr = (handleAt(s.handles, Math.min(1, t + dt)) - handleAt(s.handles, Math.max(0, t - dt))) * R / ((Math.min(1, t + dt) - Math.max(0, t - dt)) * s.height);
  return Math.min(3, Math.sqrt(1 + dr * dr));
}

export function innerRadius(s: ShapeSpec, a: number, t: number): number {
  const w = s.wall * slopeFactor(s, t);
  if (s.innerFollows) return Math.max(0.3, outerRadius(s, a, t) - w);
  const at = a - ((s.twist * Math.PI) / 180) * t;
  return Math.max(0.3, baseRadius(s, a, t) + Math.min(0, patternOffset(s.patterns, at, t)) - w);
}

export interface Resolution { around: number; rows: number }

export function resolutionFor(s: ShapeSpec, quality: 'draft' | 'normal' | 'fine' = 'normal'): Resolution {
  const q = quality === 'draft' ? 0.5 : quality === 'fine' ? 1.8 : 1;
  const maxCount = Math.max(1, ...s.patterns.filter((p) => p.enabled && p.type !== 'none').map((p) => p.count));
  const maxRows = Math.max(1, ...s.patterns.filter((p) => p.enabled && p.type !== 'none').map((p) => p.rows * (1 + Math.abs(p.twist))));
  const circ = Math.PI * s.diameter * Math.max(s.scaleX, s.scaleY);
  const around = Math.round(clamp(Math.max(circ / 1.2, maxCount * 10, s.section === 'circle' ? 96 : Math.max(96, s.sides * 12)) * q, 48, 720));
  const rows = Math.round(clamp(Math.max(s.height / 1.2, maxRows * 12, 24) * q, 8, 600));
  return { around, rows };
}

/** Point for radius r at angle a, height t (applies scale X/Y and lean). */
function place(s: ShapeSpec, r: number, a: number, t: number, z0: number): V3 {
  return [r * Math.cos(a) * s.scaleX + s.leanX * t, r * Math.sin(a) * s.scaleY + s.leanY * t, z0 + t * s.height];
}

export interface RingOptions {
  /** Extra inner radius (piece-local z, mm from the piece bottom): sockets carved into thick walls. */
  inner?: (a: number, z: number) => number;
  /** Dense rows (0.3 mm) over this many mm from the bottom, for threads and slots. */
  denseBottom?: number;
}

/** Rings of the outer and inner surface. tFrom..tTo lets a tall body be cut into printable pieces. */
export function shapeRings(s: ShapeSpec, res: Resolution, tFrom = 0, tTo = 1, z0 = 0, o: RingOptions = {}): { outer: Ring[]; inner: Ring[]; ts: number[] } {
  const rows = Math.max(2, Math.ceil(res.rows * (tTo - tFrom)));
  const set = new Set<number>();
  for (let k = 0; k <= rows; k++) set.add(tFrom + ((tTo - tFrom) * k) / rows);
  if (o.denseBottom) {
    const span = Math.min(o.denseBottom + 1, (tTo - tFrom) * s.height);
    for (let z = 0; z <= span; z += 0.3) set.add(tFrom + z / s.height);
    set.add(tFrom + Math.min(span, o.denseBottom) / s.height);
  }
  const ts = [...set].filter((t) => t >= tFrom - 1e-12 && t <= tTo + 1e-12).sort((x, y) => x - y)
    .filter((t, i, l) => i === 0 || i === l.length - 1 || (t - l[i - 1]) * s.height > 0.02);
  if (ts.length > 2 && (ts[ts.length - 1] - ts[ts.length - 2]) * s.height <= 0.02) ts.splice(ts.length - 2, 1);
  const outer: Ring[] = [], inner: Ring[] = [];
  const zb = z0 - tFrom * s.height;
  for (const t of ts) {
    const zl = (t - tFrom) * s.height;
    const or: Ring = [], ir: Ring = [];
    for (let j = 0; j < res.around; j++) {
      const a = (j / res.around) * tau;
      const ro = outerRadius(s, a, t);
      let ri = innerRadius(s, a, t);
      if (o.inner) ri = Math.max(ri, o.inner(a, zl) / Math.min(s.scaleX, s.scaleY));
      ri = Math.min(ri, ro - 0.4);
      or.push(place(s, ro, a, t, zb));
      ir.push(place(s, ri, a, t, zb));
    }
    outer.push(or); inner.push(ir);
  }
  return { outer, inner, ts };
}

/** Closed shell of the shape between tFrom and tTo (wall, vase solid, floors and roofs). */
export function shapeShell(s: ShapeSpec, res: Resolution, tFrom = 0, tTo = 1, z0 = 0, o: RingOptions = {}): Soup {
  const { outer, inner } = shapeRings(s, res, tFrom, tTo, z0, o);
  if (s.vase) return solidShell(outer);
  const out = tubeShell(outer, inner);
  const zb = z0 - tFrom * s.height;
  if (s.floor > 0 && tFrom <= 0) app(out, capDisc(s, res, 0, s.floor / s.height, zb));
  if (s.roof > 0 && tTo >= 1) app(out, capDisc(s, res, 1 - s.roof / s.height, 1, zb));
  return out;
}

/** Solid disc that fills the inside between t0 and t1 (overlaps the wall so they union). */
function capDisc(s: ShapeSpec, res: Resolution, t0: number, t1: number, zb: number): Soup {
  const ring = (t: number): Ring => polarRing(res.around, zb + t * s.height, (a) => (innerRadius(s, a, t) + Math.min(0.6, s.wall * 0.5))).map(([x, y, z]) => [x * s.scaleX + s.leanX * t, y * s.scaleY + s.leanY * t, z] as V3);
  return solidShell([ring(t0), ring(t1)]);
}

/** Smallest inner radius at height t (for fittings and joints). */
export function minInnerAt(s: ShapeSpec, t: number, n = 180): number {
  let m = Infinity;
  for (let j = 0; j < n; j++) { const a = (j / n) * tau; m = Math.min(m, innerRadius(s, a, t) * Math.min(s.scaleX, s.scaleY)); }
  return m;
}

export function maxOuterAt(s: ShapeSpec, t: number, n = 180): number {
  let m = 0;
  for (let j = 0; j < n; j++) { const a = (j / n) * tau; m = Math.max(m, outerRadius(s, a, t) * Math.max(s.scaleX, s.scaleY)); }
  return m;
}

/** Steepest overhang of the outer silhouette (degrees from vertical) when printed upright or flipped. */
export function worstOverhang(s: ShapeSpec, flipped: boolean): number {
  let worst = 0;
  const R = s.diameter / 2;
  for (let i = 0; i < 60; i++) {
    const t0 = i / 60, t1 = (i + 1) / 60;
    const dr = (handleAt(s.handles, t1) - handleAt(s.handles, t0)) * R, dz = (t1 - t0) * s.height;
    const growing = flipped ? dr < 0 : dr > 0;
    if (growing) worst = Math.max(worst, (Math.atan2(Math.abs(dr), dz) * 180) / Math.PI);
  }
  return worst;
}

export const defaultShape = (p: Partial<ShapeSpec> = {}): ShapeSpec => ({
  silhouette: 'cylinder', handles: [1, 1, 1, 1, 1, 1, 1], height: 160, diameter: 180, scaleX: 1, scaleY: 1,
  section: 'circle', sides: 6, rounding: 0.2, sectionDepth: 0.2, twist: 0, leanX: 0, leanY: 0,
  patterns: [], wall: 1.6, innerFollows: true, vase: false, floor: 0, roof: 0, ...p,
});
