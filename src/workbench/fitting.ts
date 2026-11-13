// Motionex Studio — lamp fitting. What turns a shade into a lamp: the seat the lamp holder mounts in
// (a flat plate with a hole, printed as part of the shade), the bulb that has to fit inside, and for
// table shades a separately printed stand (stand.ts). Holder and bulb sizes come from the Lumonex
// catalogue (nominal trade sizes); the hole is the holder's nominal size plus the fit clearance and can
// be overridden, because lamp holders differ slightly from brand to brand.
import { bulbById, bulbRadius, holderById, HOLDERS, BULBS, type Bulb, type Holder } from '../plugins/lumonex/catalog';
import { makeInner, makeSurface, type Design, type Family } from './design';

/** How the lamp holder is held: 'ring' = the holder's threaded skirt goes through the plate and its shade
 *  ring clamps it; 'grip' = an M10×1 threaded nipple / cord grip through a small hole, the holder screws
 *  onto it; 'cord' = a plain hole for the cable, the holder hangs on a knot or strain relief. */
export type SeatKind = 'none' | 'ring' | 'grip' | 'cord';
export type StandKind = 'none' | 'tripod' | 'four' | 'five' | 'straight' | 'tapered' | 'square' | 'blade' | 'sabre' | 'cabriole' | 'twisted' | 'bun' | 'drum' | 'cone' | 'hourglass';

export interface Fitting {
  seat: SeatKind;
  /** Lamp holder (Lumonex catalogue id). */
  holder: string;
  /** Bulb (catalogue id): shown in the view and checked against the wall. */
  bulb: string;
  /** Hole diameter override in mm (0 = from the holder and the seat type). */
  hole: number;
  /** Fit clearance added to the holder's nominal diameter (mm). */
  clearance: number;
  /** Seat plate thickness (mm). A shade ring clamps about 2–5 mm. */
  thickness: number;
  showBulb: boolean;
  /** Table shades: the printed stand the shade sits on ('none' = the seat is in the shade itself). */
  stand: StandKind;
  /** Clear height under the stand's deck (mm). */
  standHeight: number;
  legs: number;
  /** Leg lean outward, degrees from vertical. */
  splay: number;
  /** Leg thickness (mm). */
  legSize: number;
}

export const SEATS: { id: SeatKind; name: string; hint: string }[] = [
  { id: 'none', name: 'None', hint: 'Plain shade, no lamp holder seat.' },
  { id: 'ring', name: 'Shade ring', hint: 'The holder’s threaded skirt passes through the hole and its shade ring clamps the plate. Needs a holder with a threaded skirt and ring.' },
  { id: 'grip', name: 'Cord grip (M10)', hint: 'Ø10.5 hole for an M10×1 threaded nipple or cord grip; the holder screws onto it.' },
  { id: 'cord', name: 'Cord hole', hint: 'Plain hole for the cable; the holder hangs below on a strain relief.' },
];

/** Holders that mount in a flat seat (threaded skirt + shade ring, or on a nipple). */
export const SEAT_HOLDERS: Holder[] = HOLDERS.filter((h) => h.mount === 'ring');
export const bulbsFor = (holder: string): Bulb[] => { const h = holderById(holder); return BULBS.filter((b) => h.bulbs.includes(b.id)); };

/** M10×1 lamp nipple: 10 mm thread, drilled 10.5. Round 3-core flex is about Ø6.5. */
const NIPPLE = 10.2, CORD = 7.2;
/** Flat land the shade ring (or the nipple's nut and washer) needs around the hole, mm. */
export const seatLand = (f: Fitting) => (f.seat === 'ring' ? (holderById(f.holder).ringHole >= 35 ? 8 : 6) : 7);

export function defaultFitting(family: Family): Fitting {
  const lamp = family === 'pendant' || family === 'shade';
  return {
    seat: lamp ? 'ring' : 'none', holder: 'e27', bulb: 'a60', hole: 0, clearance: 0.3, thickness: 3, showBulb: true,
    stand: family === 'shade' ? 'tripod' : 'none', standHeight: 95, legs: 3, splay: 15, legSize: 13,
  };
}
/** The design's fitting (older saved pieces have none: they get the default for their family). */
export const fittingOf = (d: Design): Fitting => ({ ...defaultFitting(d.family), ...(d.fitting ?? {}) });
export const isLamp = (d: Design) => d.family === 'pendant' || d.family === 'shade';
/** True when this design is the stand of a table shade (shown and sliced instead of the shade). */
export const isStandPart = (d: Design) => d.part === 'stand' && d.family === 'shade' && fittingOf(d).stand !== 'none';

/** Hole diameter (mm) of the seat. */
export function holeDia(f: Fitting): number {
  if (f.hole > 0) return f.hole;
  if (f.seat === 'ring') return holderById(f.holder).ringHole + f.clearance;
  if (f.seat === 'grip') return NIPPLE + f.clearance;
  return CORD + f.clearance;
}

export interface Seat { z0: number; z1: number; holeR: number; top: boolean; kind: SeatKind }
/** The seat plate printed inside the shade (design coordinates), or null. Pendants carry it at the top,
 *  table shades at the bottom; a table shade on a printed stand has its seat on the stand instead. */
export function seatOf(d: Design): Seat | null {
  if (!isLamp(d)) return null;
  const f = fittingOf(d);
  if (f.seat === 'none' || (d.family === 'shade' && f.stand !== 'none')) return null;
  const T = Math.min(8, Math.max(1.2, f.thickness), d.height * 0.4), top = d.family === 'pendant';
  return { z0: top ? d.height - T : 0, z1: top ? d.height : T, holeR: holeDia(f) / 2, top, kind: f.seat };
}

/** The print orientation a lamp piece needs so its seat is laid on the bed: true = upside down, false = upright, null = free. */
export function requiredFlip(d: Design): boolean | null {
  if (isStandPart(d)) return false;
  const s = seatOf(d);
  return s ? s.top : null;
}

const TAU = Math.PI * 2;
function minInner(d: Design, z: number, n = 72): number {
  const inner = makeInner(d); let m = Infinity;
  for (let j = 0; j < n; j++) m = Math.min(m, inner(z, (j / n) * TAU));
  return m;
}

/** Smallest inside radius the opening needs for the seat: hole + land for the ring / nut. */
export function seatNeed(d: Design): number { const f = fittingOf(d); return holeDia(f) / 2 + seatLand(f); }

/** Widen the end of the profile that carries the seat until the holder fits. Returns true if it changed. */
export function fitOpening(d: Design): boolean {
  const s = seatOf(d); if (!s) return false;
  const need = seatNeed(d) + 0.5, zc = (s.z0 + s.z1) / 2, zw = s.top ? s.z0 : s.z1;
  let changed = false;
  for (let k = 0; k < 8; k++) {
    const have = Math.min(minInner(d, zc), minInner(d, zw));
    if (have >= need) break;
    const pts = [...d.profile].sort((a, b) => a.t - b.t), end = s.top ? pts[pts.length - 1] : pts[0];
    const grow = (need + d.wall) / Math.max(1, have + d.wall);
    const nr = Math.min(1, Math.max(end.r * grow, end.r + 0.01));
    if (nr <= end.r + 1e-6) { // already at full radius: the piece itself is too small
      const nd = Math.ceil(d.maxDiameter * grow + 1); if (nd <= d.maxDiameter) break; d.maxDiameter = nd;
    } else end.r = nr;
    changed = true;
  }
  return changed;
}

export interface BulbPlace { holder: Holder; bulb: Bulb; /** Design z of the socket mouth and of the seat face the holder sits on. */ mouth: number; face: number; /** +1: the bulb points up, −1: down. */ dir: 1 | -1; /** Design z of a bulb profile height. */ zOf: (zb: number) => number }
/** Where the bulb sits (design coordinates of the shade), or null without a seat. */
export function bulbPlace(d: Design): BulbPlace | null {
  if (!isLamp(d)) return null;
  const f = fittingOf(d); if (f.seat === 'none') return null;
  const holder = holderById(f.holder), bulb = bulbById(f.bulb), cap = bulb.profile[1]?.[1] ?? 0;
  const s = seatOf(d);
  // ring: the socket mouth stands `above` the plate; nipple / cord: the whole holder is on the bulb side
  const reach = f.seat === 'ring' ? holder.above : holder.length;
  const dir: 1 | -1 = d.family === 'pendant' ? -1 : 1;
  const face = s ? (s.top ? s.z0 : s.z1) : STAND_SPIGOT; // on a stand the hub top is the spigot top
  const mouth = face + dir * reach;
  return { holder, bulb, mouth, face, dir, zOf: (zb) => mouth + dir * (zb - cap) };
}
/** Height of the stand's locating spigot inside the shade (mm). */
export const STAND_SPIGOT = 3;

/** Smallest gap between the bulb glass and the inside wall (mm), and how far the bulb sticks out of the shade. */
export function bulbFit(d: Design): { gap: number; out: number; openR: number } | null {
  const p = bulbPlace(d); if (!p) return null;
  let gap = Infinity, out = 0;
  const cap = p.bulb.profile[1]?.[1] ?? 0;
  for (const [r, zb] of p.bulb.profile) {
    if (zb < cap) continue;
    const z = p.zOf(zb);
    if (z < 0 || z > d.height) { out = Math.max(out, z < 0 ? -z : z - d.height); continue; }
    gap = Math.min(gap, minInner(d, z, 36) - r);
  }
  const openR = minInner(d, p.dir < 0 ? 0 : d.height, 36);
  return { gap, out, openR };
}

/** Plain-language problems with the lamp fitting. */
export function fittingWarnings(d: Design): string[] {
  if (!isLamp(d)) return [];
  const f = fittingOf(d), w: string[] = [];
  if (f.seat === 'none') return w;
  const holder = holderById(f.holder), bulb = bulbById(f.bulb), hole = holeDia(f);
  const s = seatOf(d);
  if (s) {
    const have = Math.min(minInner(d, (s.z0 + s.z1) / 2), minInner(d, s.top ? s.z0 : s.z1)), need = seatNeed(d);
    if (have < s.holeR + 1.5) w.push(`The ${s.top ? 'top' : 'bottom'} opening (Ø${(have * 2).toFixed(0)} mm inside) is smaller than the Ø${hole.toFixed(1)} mm holder hole: there is no seat. Widen the opening.`);
    else if (have < need - 0.05) w.push(`The seat is only ${(have - s.holeR).toFixed(1)} mm wide around the Ø${hole.toFixed(1)} mm hole; the ${f.seat === 'ring' ? 'shade ring' : 'nut'} needs about ${seatLand(f)} mm. Widen the opening.`);
  }
  if (f.seat === 'ring' && f.thickness > 5) w.push(`A ${f.thickness} mm seat may be too thick for the shade ring's thread: 2–4 mm is usual.`);
  if (!holder.bulbs.includes(bulb.id)) w.push(`${bulb.name} does not fit the ${holder.name} holder.`);
  const fit = bulbFit(d);
  if (fit) {
    const R = bulbRadius(bulb);
    if (fit.gap < 2) w.push(`${bulb.name} does not fit: it ${fit.gap < 0 ? 'is wider than' : 'touches'} the inside of the shade. Use a smaller bulb or a wider piece.`);
    else if (fit.gap < 20) w.push(`${bulb.name} sits ${fit.gap.toFixed(0)} mm from the wall. Keep 20 mm or more (PLA softens near 55 °C); LED bulbs only.`);
    if (fit.openR < R + 1.5) w.push(`The open end (Ø${(fit.openR * 2).toFixed(0)} mm) is narrower than the bulb (Ø${(R * 2).toFixed(0)} mm): the bulb cannot be changed.`);
    if (fit.out > 15) w.push(`${bulb.name} reaches ${fit.out.toFixed(0)} mm beyond the shade.`);
  }
  if (d.family === 'shade' && f.stand !== 'none') {
    const need = (f.seat === 'ring' ? holder.length : 12) + 20;
    if (f.standHeight < need) w.push(`The stand is ${f.standHeight} mm high; the ${holder.name} holder and its cable need about ${need} mm under the deck.`);
  }
  return w;
}

/** Preview-only solids (never printed): the lamp holder and the bulb as lathe profiles [r, z] in design coordinates. */
export function ghosts(d: Design): { name: string; color: string; profile: [number, number][] }[] {
  const p = bulbPlace(d), f = fittingOf(d);
  if (!p || !f.showBulb || isStandPart(d)) return [];
  const cap = p.bulb.profile[1]?.[1] ?? 0;
  const bulb = p.bulb.profile.filter(([, zb]) => zb >= cap).map(([r, zb]) => [Math.max(0.2, r), p.zOf(zb)] as [number, number]);
  const hr = p.holder.body / 2, back = f.seat === 'ring' ? p.face - p.dir * p.holder.length : p.face;
  const holder: [number, number][] = [[0.2, back], [hr, back], [hr, p.mouth], [0.2, p.mouth]];
  return [{ name: 'holder', color: '#3a3d42', profile: holder }, { name: 'bulb', color: '#fff3c4', profile: bulb }];
}

/** Outer radius of the piece's surface, largest over the round (for sizes and estimates). */
export function maxOuter(d: Design, z: number, n = 72): number {
  const surf = makeSurface(d); let m = 0;
  for (let j = 0; j < n; j++) m = Math.max(m, surf(z, (j / n) * TAU));
  return m;
}
export { minInner };
