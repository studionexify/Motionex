// Motionex Studio — printed stands for table shades. A stand is a deck (a rim the shade drops over, a
// 45° seat cone, spokes and a hub with the lamp holder hole) on legs or a pedestal. It is modelled in
// print orientation: deck on the bed, feet up, so nothing needs support. Every solid is a loft between
// two flat outlines, which gives the 3D mesh and the exact outline of every printed layer from the same
// description; the layers are unioned with Clipper and filled solid with concentric lines.
import { areaTotal, cleanPaths, difference, offset, toExPolygons, toInt, union, SCALE } from '../engine/clipper';
import type { Path, Paths } from '../engine/types';
import { holderById } from '../plugins/lumonex/catalog';
import type { Design } from './design';
import { fittingOf, holeDia, isStandPart, maxOuter, minInner, seatLand, STAND_SPIGOT, type Fitting, type StandKind } from './fitting';
import { nozzleLimits, PRINTERS, type GenResult, type Seg, type SliceSettings } from './generator';

type Pt = [number, number];
const TAU = Math.PI * 2;
const rad = (deg: number) => (deg * Math.PI) / 180;
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

type Curve = 'line' | 'sabre' | 'cabriole' | 'twist';
interface LegStyle { shape: 'round' | 'square' | 'blade'; d0: number; d1: number; curve: Curve }
export interface StandType { id: StandKind; name: string; group: 'Legs' | 'Pedestals' | ''; blurb: string; legs: number; splay: number; size: number; leg?: LegStyle; pedestal?: 'drum' | 'cone' | 'hourglass' }

/** Every stand a table shade can sit on. Picking one loads its leg count, lean and thickness; all three stay editable. */
export const STANDS: StandType[] = [
  { id: 'none', name: 'No stand', group: '', blurb: 'The seat is printed in the shade, for a lamp base you already have.', legs: 0, splay: 0, size: 0 },
  { id: 'tripod', name: 'Tripod', group: 'Legs', blurb: 'Three round legs leaning out.', legs: 3, splay: 15, size: 13, leg: { shape: 'round', d0: 1, d1: 0.75, curve: 'line' } },
  { id: 'four', name: 'Four legs', group: 'Legs', blurb: 'Four round legs leaning out.', legs: 4, splay: 12, size: 12, leg: { shape: 'round', d0: 1, d1: 0.75, curve: 'line' } },
  { id: 'five', name: 'Five-leg star', group: 'Legs', blurb: 'Five slim legs, wide stance.', legs: 5, splay: 20, size: 10, leg: { shape: 'round', d0: 1, d1: 0.7, curve: 'line' } },
  { id: 'straight', name: 'Straight legs', group: 'Legs', blurb: 'Upright round posts.', legs: 4, splay: 0, size: 12, leg: { shape: 'round', d0: 1, d1: 1, curve: 'line' } },
  { id: 'tapered', name: 'Mid-century tapered', group: 'Legs', blurb: 'Thick at the deck, slim at the foot.', legs: 4, splay: 10, size: 12, leg: { shape: 'round', d0: 1.35, d1: 0.5, curve: 'line' } },
  { id: 'square', name: 'Square legs', group: 'Legs', blurb: 'Square posts with a slight taper.', legs: 4, splay: 8, size: 12, leg: { shape: 'square', d0: 1, d1: 0.8, curve: 'line' } },
  { id: 'blade', name: 'Blade fins', group: 'Legs', blurb: 'Thin upright fins, edge on.', legs: 3, splay: 6, size: 12, leg: { shape: 'blade', d0: 1.7, d1: 1, curve: 'line' } },
  { id: 'sabre', name: 'Sabre legs', group: 'Legs', blurb: 'Start upright and sweep outwards.', legs: 4, splay: 14, size: 12, leg: { shape: 'round', d0: 1.1, d1: 0.7, curve: 'sabre' } },
  { id: 'cabriole', name: 'Cabriole legs', group: 'Legs', blurb: 'Bow out at the knee and return to the foot.', legs: 4, splay: 14, size: 12, leg: { shape: 'round', d0: 1.15, d1: 0.7, curve: 'cabriole' } },
  { id: 'twisted', name: 'Twisted legs', group: 'Legs', blurb: 'Legs that turn around the lamp as they go down.', legs: 5, splay: 6, size: 11, leg: { shape: 'round', d0: 1, d1: 0.8, curve: 'twist' } },
  { id: 'bun', name: 'Bun feet', group: 'Legs', blurb: 'Short-looking, stout round feet.', legs: 4, splay: 0, size: 22, leg: { shape: 'round', d0: 1, d1: 0.8, curve: 'line' } },
  { id: 'drum', name: 'Drum pedestal', group: 'Pedestals', blurb: 'Closed cylinder on four feet; the cable leaves between them.', legs: 4, splay: 0, size: 12, pedestal: 'drum' },
  { id: 'cone', name: 'Flared pedestal', group: 'Pedestals', blurb: 'Cone that widens to the table.', legs: 4, splay: 12, size: 12, pedestal: 'cone' },
  { id: 'hourglass', name: 'Hourglass pedestal', group: 'Pedestals', blurb: 'Waisted in the middle.', legs: 4, splay: 0, size: 12, pedestal: 'hourglass' },
];
export const standType = (id: StandKind) => STANDS.find((s) => s.id === id) ?? STANDS[0];

/** A solid between outline `a` at z0 and outline `b` at z1 (same point count, counter-clockwise), optionally with a hole. */
interface Prim { z0: number; z1: number; a: Pt[]; b: Pt[]; ha?: Pt[]; hb?: Pt[]; /** outline = one arc out + one arc back (annular sector): caps are triangle strips */ strip?: boolean }
export interface StandModel {
  prims: Prim[]; height: number; radius: number; deck: number; rim: number; flange: number; holeR: number; warnings: string[];
  /** Closed hollows subtracted from the solid (the ballast pocket). */
  voids: Prim[];
  /** Ballast pocket: the print pauses after the last layer at or below z so it can be filled; cm3 = fillable volume. */
  pause?: { z: number; cm3: number };
  /** Counterbore above the seat plate (solid decks), radius in mm. */
  bore?: number;
}
/** Bulk densities (g/cm³) for the fill guide. */
export const BALLAST_FILL = { steel: 4.6, sand: 1.6 };
/** Extra deck depth for the pocket (mm). The minimum still leaves fillable channel under the 5 mm roof. */
export const BALLAST_DEPTH = { min: 6, def: 12, max: 40 };
/** Pause command per machine (what each one's own slicer uses for a pause at a layer). */
const PAUSE_CMD: Record<string, string> = { 'bbl-a1': 'M400 U1', 'bbl-p1s': 'M400 U1', 'elegoo-n4max': 'PAUSE', 'snapmaker-u1': 'PAUSE' };
export const pauseCommand = (printer: string) => PAUSE_CMD[printer] ?? 'M601';
/** Annular sector from angle a0 to a1 between radii ri and ro (counter-clockwise; n points per arc). */
const sector = (a0: number, a1: number, ri: number, ro: number, n = 12): Pt[] => {
  const p: Pt[] = [];
  for (let i = 0; i < n; i++) { const a = a0 + ((a1 - a0) * i) / (n - 1); p.push([ro * Math.cos(a), ro * Math.sin(a)]); }
  for (let i = n - 1; i >= 0; i--) { const a = a0 + ((a1 - a0) * i) / (n - 1); p.push([ri * Math.cos(a), ri * Math.sin(a)]); }
  return p;
};

const circle = (r: number, n: number, cx = 0, cy = 0): Pt[] => Array.from({ length: n }, (_, i) => [cx + r * Math.cos((i / n) * TAU), cy + r * Math.sin((i / n) * TAU)] as Pt);
const segsFor = (r: number) => Math.round(clamp((TAU * r) / 1.5, 48, 200));
const signedArea = (p: Pt[]) => { let s = 0; for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; s += a[0] * b[1] - b[0] * a[1]; } return s / 2; };
function loft(z0: number, z1: number, a: Pt[], b: Pt[]): Prim { return signedArea(a) < 0 ? { z0, z1, a: [...a].reverse(), b: [...b].reverse() } : { z0, z1, a, b }; }
function tube(z0: number, z1: number, ro0: number, ro1: number, ri0: number, ri1: number): Prim {
  const n = segsFor(Math.max(ro0, ro1));
  const p: Prim = { z0, z1, a: circle(ro0, n), b: circle(ro1, n) };
  if (ri0 > 0.05 && ri1 > 0.05) { p.ha = circle(ri0, n); p.hb = circle(ri1, n); }
  return p;
}

/** The stand of a table shade, in print orientation (z = 0 on the bed is the top of the deck), or null. */
export function buildStand(d: Design): StandModel | null {
  const f = fittingOf(d), type = standType(f.stand);
  if (d.family !== 'shade' || type.id === 'none') return null;
  const warnings: string[] = [];
  const hs = STAND_SPIGOT;
  // the spigot goes inside the shade; the 45° cone above it centres the shade's bottom edge
  const Rs = Math.max(12, Math.min(minInner(d, 0), minInner(d, hs / 2), minInner(d, hs)) - 0.3);
  const step = clamp(d.wall + 1.5, 2.5, 6), Rf = Rs + step, zc1 = hs + step, deck0 = zc1 + 2;
  const build = f.build ?? 'standard', light = build === 'light', heavy = build === 'heavy';
  // heavy + ballast: the deck grows `ballastDepth` mm deeper to hold a sealed pocket for steel shot or sand
  const ballast = heavy && !!f.ballast, bd = ballast ? clamp(f.ballastDepth ?? BALLAST_DEPTH.def, BALLAST_DEPTH.min, BALLAST_DEPTH.max) : 0;
  const clear = clamp(f.standHeight, 20, 400), H = deck0 + bd + clear, L = H - zc1;
  const size = clamp(f.legSize * (light ? 0.85 : heavy ? 1.35 : 1), 5, 54), N = Math.round(clamp(f.legs || type.legs, 3, 12)), splay = clamp(f.splay, 0, 35);
  const prims: Prim[] = [];

  const seat = f.seat !== 'none', holeR = seat ? holeDia(f) / 2 : 0, hubR = holeR + seatLand(f) + 2;
  const deck = deck0 + bd;
  const T = Math.min(deck, clamp(f.thickness, 1.2, 8));
  const leg = type.leg, wall = light ? 1.8 : Math.max(2.4, size * (heavy ? 0.36 : 0.22));
  const halfTop = leg ? (size * leg.d0) / 2 : wall / 2;
  // rim wide enough to carry the leg tops; a small shade gets a solid deck instead of hub + spokes
  // leg centre line: the leg (square corners too) stays on the flange, and the rim reaches under its inner edge
  const Rc0 = Math.sqrt(Math.max(0, Rf * Rf - halfTop * halfTop)) - halfTop - 0.2;
  let rimIn = Math.min(Rs - 8, Rc0 - halfTop - 0.5);
  const solid = heavy || rimIn < hubR + 4;
  if (solid) rimIn = seat ? holeR : Math.max(0, rimIn);
  if (seat && Rs < holeR + seatLand(f)) warnings.push(`The shade is only Ø${(Rs * 2).toFixed(0)} mm inside at the bottom: too small for the Ø${(holeR * 2).toFixed(1)} mm holder hole and its ring.`);
  // a solid deck keeps the seat only `T` thick: above it a counterbore takes the holder body, so the
  // shade ring's thread still reaches through and clamps
  const holderDef = holderById(f.holder);
  const bore = solid && seat ? (f.seat === 'ring' ? Math.max(holeR, holderDef.body / 2 + 1) : 12) : 0;
  const deckTube = (z0: number, z1: number, ro0: number, ro1: number) => {
    if (!bore || T <= z0 + 1e-9) return [tube(z0, z1, ro0, ro1, bore || rimIn, bore || rimIn)];
    if (T >= z1 - 1e-9) return [tube(z0, z1, ro0, ro1, rimIn, rimIn)];
    const rt = lerp(ro0, ro1, (T - z0) / (z1 - z0));
    return [tube(z0, T, ro0, rt, rimIn, rimIn), tube(T, z1, rt, ro1, bore, bore)];
  };
  prims.push(...deckTube(0, hs, Rs, Rs), ...deckTube(hs, zc1, Rs, Rf), ...deckTube(zc1, deck, Rf, Rf));
  if (seat && !solid) {
    prims.push(tube(0, T, hubR, hubR, holeR, holeR));
    const ns = light ? 3 : Math.max(3, Math.min(6, leg ? N : 4)), r0 = hubR - 1.5, r1 = rimIn + 1.5, hw = light ? 3 : 4;
    for (let i = 0; i < ns; i++) {
      const a = (i / ns) * TAU + Math.PI / 2, c = Math.cos(a), s = Math.sin(a);
      const q: Pt[] = [[r0 * c + hw * s, r0 * s - hw * c], [r1 * c + hw * s, r1 * s - hw * c], [r1 * c - hw * s, r1 * s + hw * c], [r0 * c - hw * s, r0 * s + hw * c]];
      prims.push(loft(0, T, q, q));
    }
  }

  let radius = Rf;
  if (leg) {
    const tanS = Math.tan(rad(splay));
    const off = (u: number) => leg.curve === 'sabre' ? L * tanS * u * u : leg.curve === 'cabriole' ? L * tanS * (0.6 * Math.sin(Math.PI * u) + 0.3 * u) : L * tanS * u;
    const twist = leg.curve === 'twist' ? Math.min(Math.PI / 3, (0.5 * L) / Math.max(20, Rc0)) : 0;
    const K = leg.curve === 'line' ? 1 : 14, ht = Math.max(1.6, size * 0.18);
    const outline = (i: number, u: number): Pt[] => {
      const a = (i / N) * TAU + Math.PI / 2 + twist * u, c = Math.cos(a), s = Math.sin(a), rc = Rc0 + off(u), h = (size * lerp(leg.d0, leg.d1, u)) / 2;
      radius = Math.max(radius, rc + h);
      if (leg.shape === 'round') return circle(h, 28, rc * c, rc * s);
      const t = leg.shape === 'blade' ? ht : h; // half size across the radius
      return ([[-h, -t], [h, -t], [h, t], [-h, t]] as Pt[]).map(([x, y]) => [rc * c + x * c - y * s, rc * s + x * s + y * c] as Pt);
    };
    // light: hollow legs, a 2.4 mm wall around a void that opens at the foot (the deck closes the other end)
    const LW = 2.4, hollow = (i: number, u: number): Pt[] | null => {
      if (!light) return null;
      const a = (i / N) * TAU + Math.PI / 2 + twist * u, c = Math.cos(a), s = Math.sin(a), rc = Rc0 + off(u), h = (size * lerp(leg.d0, leg.d1, u)) / 2 - LW;
      if (leg.shape === 'round') return h > 1.2 ? circle(h, 28, rc * c, rc * s) : null;
      const t = (leg.shape === 'blade' ? ht : (size * lerp(leg.d0, leg.d1, u)) / 2) - LW;
      return h > 1.2 && t > 1.2 ? ([[-h, -t], [h, -t], [h, t], [-h, t]] as Pt[]).map(([x, y]) => [rc * c + x * c - y * s, rc * s + x * s + y * c] as Pt) : null;
    };
    for (let i = 0; i < N; i++) for (let k = 0; k < K; k++) {
      const u0 = k / K, u1 = (k + 1) / K, p = loft(zc1 + L * u0, zc1 + L * u1, outline(i, u0), outline(i, u1));
      const h0 = hollow(i, u0), h1 = hollow(i, u1);
      if (h0 && h1) { p.ha = h0; p.hb = h1; }
      prims.push(p);
    }
    // heavy: a foot pad on every leg, flaring at 45° (printed upward, so it needs no support)
    if (heavy) {
      const padH = Math.min(8, clear * 0.12);
      for (let i = 0; i < N; i++) {
        // the pad starts on the leg where it is at the pad's base, and its growth plus the leg's own lean stays within 45°
        const up = clamp((H - padH - zc1) / L, 0, 1), o0 = outline(i, up), o = outline(i, 1);
        const cen = (q: Pt[]): Pt => [q.reduce((a, v) => a + v[0], 0) / q.length, q.reduce((a, v) => a + v[1], 0) / q.length];
        const [ax, ay] = cen(o0), [cx0, cy0] = cen(o), shift = Math.hypot(cx0 - ax, cy0 - ay) / padH;
        const h1 = (size * leg.d1) / 2, g = (h1 + padH * Math.max(0, 0.9 - shift)) / h1;
        const big = o.map(([x, y]) => [cx0 + (x - cx0) * g, cy0 + (y - cy0) * g] as Pt);
        prims.push(loft(H - padH, H, o0, big));
        radius = Math.max(radius, Math.hypot(cx0, cy0) + h1 * g);
      }
    }
  } else {
    // pedestal: a wall on castle feet, so the cable can leave between the feet
    const fh = Math.min(14, clear * 0.3), zf = H - fh, Lb = zf - zc1, zm = zc1 + Lb / 2;
    const tanC = Math.tan(rad(Math.max(4, splay))), waist = Rf - Math.min(0.35 * Rf, Math.tan(rad(28)) * (Lb / 2));
    const rAt = (z: number) => type.pedestal === 'cone' ? Rf + (z - zc1) * tanC : type.pedestal === 'hourglass' ? (z <= zm ? lerp(Rf, waist, (z - zc1) / (Lb / 2)) : lerp(waist, Rf, (z - zm) / (Lb / 2))) : Rf;
    const rEnd = rAt(zf), nf = Math.max(3, Math.min(8, N));
    // light: pointed windows round the wall. Their sides lean at most 39° (0.8 mm per mm), so the arch
    // above each window prints without support even on the leaning hourglass and cone walls.
    let win: { nw: number; zA: number; zB: number; wm: number } | null = null;
    if (light) {
      const nw = 2 * nf, zA = deck + 4, zB = zf - 6, hb = zB - zA, Rmx = Math.max(Rf, rAt(zA), rAt(zB), waist);
      const wm = Math.min((TAU / nw) * 0.36, (0.8 * (hb / 2)) / Rmx);
      if (hb > 20 && wm * Math.min(Rf, waist) >= 4) win = { nw, zA, zB, wm };
    }
    const zs = new Set<number>([zc1, zf]);
    if (type.pedestal === 'hourglass') zs.add(zm);
    if (win) for (let k = 0; k <= 24; k++) zs.add(win.zA + ((win.zB - win.zA) * k) / 24);
    const cuts = [...zs].sort((a, b) => a - b);
    for (let k = 0; k + 1 < cuts.length; k++) {
      const z0 = cuts[k], z1 = cuts[k + 1], r0 = rAt(z0), r1 = rAt(z1);
      if (!win || z0 < win.zA - 1e-9 || z1 > win.zB + 1e-9) { prims.push(tube(z0, z1, r0, r1, r0 - wall, r1 - wall)); continue; }
      const W = win, half = (z: number) => W.wm * (1 - Math.abs((2 * (z - (W.zA + W.zB) / 2)) / (W.zB - W.zA)));
      for (let j = 0; j < W.nw; j++) {
        const c0 = ((j + 0.5) / W.nw) * TAU, c1 = ((j + 1.5) / W.nw) * TAU; // column between window j and j+1
        prims.push({ z0, z1, a: sector(c0 + half(z0), c1 - half(z0), r0 - wall, r0), b: sector(c0 + half(z1), c1 - half(z1), r1 - wall, r1), strip: true });
      }
    }
    const arc = (TAU / nf) * 0.6, M = 8;
    for (let i = 0; i < nf; i++) for (let m = 0; m < M; m++) {
      const a0 = (i / nf) * TAU - arc / 2 + (arc * m) / M, a1 = a0 + arc / M, ri = rEnd - wall;
      const q: Pt[] = [[ri * Math.cos(a0), ri * Math.sin(a0)], [rEnd * Math.cos(a0), rEnd * Math.sin(a0)], [rEnd * Math.cos(a1), rEnd * Math.sin(a1)], [ri * Math.cos(a1), ri * Math.sin(a1)]];
      prims.push(loft(zf, H, q, q));
    }
    radius = Math.max(radius, rEnd);
  }
  if (maxOuter(d, 0) > radius * 1.6) warnings.push('The shade is much wider than the stand’s footprint: use more lean or a wider stand so it cannot tip.');
  // ballast pocket: concentric channels 10 mm wide in the deck, 1.6 mm floor, each closed by a 45° roof
  // and a 1.6 mm lid. The print pauses where the roofs begin, so the shot is poured into open channels.
  const voids: Prim[] = [];
  let pause: StandModel['pause'];
  if (ballast) {
    const a = (bore || (seat ? holeR + seatLand(f) : 6)) + 2.4, b = Math.min(Rs - 2.4, leg ? Rc0 - halfTop - 2 : Rf - wall - 2);
    const pz0 = 1.6, cw = 10, top = deck - 1.6, zr = top - cw / 2;
    const n = Math.floor((b - a + 2.4) / (cw + 2.4));
    let cm3 = 0;
    for (let k = 0; k < n; k++) {
      const ri = a + k * (cw + 2.4), ro = ri + cw, rm = (ri + ro) / 2;
      voids.push(tube(pz0, zr, ro, ro, ri, ri), tube(zr, top, ro, rm + 0.05, ri, rm - 0.05));
      cm3 += (Math.PI * (ro * ro - ri * ri) * (zr - pz0)) / 1000;
    }
    if (n > 0) pause = { z: zr, cm3 };
    else warnings.push('The shade is too small for a ballast pocket in the stand.');
  }
  const holder = holderDef, need = (f.seat === 'ring' ? holder.length : 12) + 20;
  if (seat && clear < need) warnings.push(`The stand is ${clear} mm high; the ${holder.name} holder and its cable need about ${need} mm under the deck.`);
  return { prims, voids, pause, bore: bore || undefined, height: H, radius, deck, rim: Rs, flange: Rf, holeR, warnings };
}

/** Size of the part that is shown and sliced (the piece, or its stand). */
export function partSize(d: Design): { height: number; diameter: number } {
  if (isStandPart(d)) { const m = buildStand(d); if (m) return { height: m.height, diameter: m.radius * 2 }; }
  return { height: d.height, diameter: d.maxDiameter };
}

// ── mesh (triangle soup, outward normals)
export function standSoup(m: StandModel): Float32Array {
  const out: number[] = [];
  const tri = (a: Pt, az: number, b: Pt, bz: number, c: Pt, cz: number) => { out.push(a[0], a[1], az, b[0], b[1], bz, c[0], c[1], cz); };
  for (const [list, inward] of [[m.prims, false], [m.voids, true]] as const) for (const p of list) {
    const start = out.length;
    const n = p.a.length, { z0, z1 } = p;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      tri(p.a[i], z0, p.a[j], z0, p.b[j], z1); tri(p.a[i], z0, p.b[j], z1, p.b[i], z1);
      if (p.ha && p.hb) {
        tri(p.ha[i], z0, p.hb[j], z1, p.ha[j], z0); tri(p.ha[i], z0, p.hb[i], z1, p.hb[j], z1);
        tri(p.a[i], z0, p.ha[j], z0, p.a[j], z0); tri(p.a[i], z0, p.ha[i], z0, p.ha[j], z0);
        tri(p.b[i], z1, p.b[j], z1, p.hb[j], z1); tri(p.b[i], z1, p.hb[j], z1, p.hb[i], z1);
      }
    }
    if (p.strip) {
      const k = n / 2; // outer arc a[0..k-1], inner arc back a[k..n-1]
      for (let i = 0; i + 1 < k; i++) {
        const o0 = i, o1 = i + 1, i1 = n - 2 - i, i0 = n - 1 - i;
        tri(p.a[o0], z0, p.a[i1], z0, p.a[o1], z0); tri(p.a[o0], z0, p.a[i0], z0, p.a[i1], z0);
        tri(p.b[o0], z1, p.b[o1], z1, p.b[i1], z1); tri(p.b[o0], z1, p.b[i1], z1, p.b[i0], z1);
      }
    } else if (!p.ha) {
      const cen = (q: Pt[]): Pt => [q.reduce((s, v) => s + v[0], 0) / n, q.reduce((s, v) => s + v[1], 0) / n];
      const c0 = cen(p.a), c1 = cen(p.b);
      for (let i = 0; i < n; i++) { const j = (i + 1) % n; tri(c0, z0, p.a[j], z0, p.a[i], z0); tri(c1, z1, p.b[i], z1, p.b[j], z1); }
    }
    // a hollow's faces point into it: swap two corners of each of its triangles
    if (inward) for (let t = start; t < out.length; t += 9) for (let q = 0; q < 3; q++) { const v = out[t + 3 + q]; out[t + 3 + q] = out[t + 6 + q]; out[t + 6 + q] = v; }
  }
  return Float32Array.from(out);
}

// ── layers
const toPath = (q: Pt[], rev = false): Path => { const p = q.map(([x, y]) => ({ X: toInt(x), Y: toInt(y) })); return rev ? p.reverse() : p; };
/** The stand's solid outline at height z: outer loops counter-clockwise, holes clockwise. */
export function standSection(m: StandModel, z: number): Paths {
  const cut = (list: Prim[]) => {
    const paths: Paths = [];
    for (const p of list) {
      if (z < p.z0 - 1e-9 || z > p.z1 + 1e-9) continue;
      const t = p.z1 > p.z0 ? clamp((z - p.z0) / (p.z1 - p.z0), 0, 1) : 0;
      const mix = (a: Pt[], b: Pt[]) => a.map((v, i) => [lerp(v[0], b[i][0], t), lerp(v[1], b[i][1], t)] as Pt);
      paths.push(toPath(mix(p.a, p.b)));
      if (p.ha && p.hb) paths.push(toPath(mix(p.ha, p.hb), true));
    }
    return paths.length ? union(paths) : [];
  };
  const solid = cut(m.prims), hollow = m.voids.length ? cut(m.voids) : [];
  const out = hollow.length ? difference(solid, hollow) : solid;
  return out.length ? cleanPaths(out, 0.002) : [];
}

export function standEstimate(d: Design, lineWidth: number, layer: number, speed: number) {
  const m = buildStand(d); if (!m) return null;
  let vol = 0; const dz = 1;
  for (let z = dz / 2; z < m.height; z += dz) vol += areaTotal(standSection(m, z)) * dz;
  return { maxDiameter: m.radius * 2, seconds: vol / (lineWidth * layer) / speed, grams: (vol / 1000) * 1.24, meters: vol / (Math.PI * 0.875 ** 2) / 1000, warnings: [...m.warnings] };
}

const f3 = (v: number) => (Math.round(v * 1000) / 1000).toString();
const f5 = (v: number) => (Math.round(v * 100000) / 100000).toString();

/** G-code for the stand: solid, concentric lines, island by island. Same result shape as the piece slicer. */
export function sliceStand(design: Design, s0: SliceSettings): GenResult {
  const NZ = nozzleLimits(s0.nozzle ?? 0.4, s0.printer);
  const s: SliceSettings = { ...s0, flip: false, lineWidth: clamp(s0.lineWidth, NZ.lineMin, NZ.lineMax), layerHeight: clamp(s0.layerHeight, NZ.layerMin, NZ.layerMax), firstLayerHeight: clamp(s0.firstLayerHeight, NZ.layerMin, NZ.layerMax) };
  const out: string[] = [], segs: Seg[] = [], layerStart: number[] = [], layerZ: number[] = [], warnings: string[] = [];
  const m = buildStand(design);
  const fa = Math.PI * (s.filamentDia / 2) ** 2, cx = s.bedX / 2, cy = s.bedY / 2, w = s.lineWidth;
  let x = cx, y = cy, z = 0, eTot = 0, len = 0, secs = 0, layer = 0;
  const emit = (l: string) => { out.push(l); };
  const travel = (nx: number, ny: number, nz = z) => {
    const dd = Math.hypot(nx - x, ny - y, nz - z); if (dd < 1e-4) return;
    const r = s.retract > 0 && dd > 2;
    if (r) emit(`G1 E-${f3(s.retract)} F2400`);
    emit(`G0 X${f3(nx)} Y${f3(ny)}${nz !== z ? ` Z${f3(nz)}` : ''} F${Math.round(s.travelSpeed * 60)}`);
    const ugl = out.length;
    if (r) emit(`G1 E${f3(s.retract)} F2400`);
    segs.push({ gl: r ? ugl : undefined, x0: x, y0: y, z0: z, x: nx, y: ny, z: nz, kind: 'travel', speed: s.travelSpeed, flow: 0, h: 0, w: 0, e: 0, ret: r, layer, ruled: false, rule: -1 });
    secs += dd / s.travelSpeed; x = nx; y = ny; z = nz;
  };
  const extrude = (nx: number, ny: number, h: number, bw: number, speed: number, kind: Seg['kind']) => {
    const dd = Math.hypot(nx - x, ny - y); if (dd < 1e-4) return;
    const bead = bw * s.flowRatio, sp = Math.min(speed, s.maxVolumetric / (h * bead)), e = (dd * h * bead) / fa;
    segs.push({ gl: out.length, x0: x, y0: y, z0: z, x: nx, y: ny, z, kind, speed: sp, flow: 1, h, w: bead, e, ret: false, layer, ruled: false, rule: -1 });
    out.push(`G1 X${f3(nx)} Y${f3(ny)} E${f5(e)} F${Math.round(sp * 60)}`);
    eTot += e; len += dd; secs += dd / sp; x = nx; y = ny;
  };
  const lh = Math.max(0.05, s.layerHeight), flh = Math.max(0.05, s.firstLayerHeight);
  emit('; Generated by Motionex Studio');
  emit(`; piece: ${design.name} · stand (${fittingOf(design).stand}) · h=${m ? f3(m.height) : 0} · Ø${m ? f3(m.radius * 2) : 0} · layer ${lh} · line ${w}`);
  emit('; printed deck-down (upside down); turn it over to use it');
  emit(`M140 S${s.bedTemp}`); emit(`M104 S${s.nozzleTemp}`); emit(`M190 S${s.bedTemp}`); emit(`M109 S${s.nozzleTemp}`);
  for (const l of s.startGcode.split('\n')) emit(l);
  emit('M83'); emit('M106 S0');
  if (!m) {
    warnings.push('This piece has no stand.');
    return { gcode: out.join('\n') + '\n', segs, layers: 0, layerStart, layerZ, warnings, stats: { lengthMm: 0, filamentMm: 0, grams: 0, seconds: 0, lines: out.length, maxOffset: 0 } };
  }
  warnings.push(...m.warnings);
  if (m.radius * 2 > Math.min(s.bedX, s.bedY) - 4) warnings.push(`The stand (Ø${(m.radius * 2).toFixed(0)} mm) does not fit the ${s.bedX}×${s.bedY} mm bed.`);
  const printer = PRINTERS.find((p) => p.id === s.printer);
  if (printer && m.height > printer.bed[2]) warnings.push(`The stand (${m.height.toFixed(0)} mm) is taller than the ${printer.name} (${printer.bed[2]} mm).`);
  travel(10, 10, flh); extrude(10, Math.min(s.bedY - 10, 110), flh, w * 1.5, s.firstLayerSpeed, 'base');
  travel(10.6, Math.min(s.bedY - 10, 110)); extrude(10.6, 10, flh, w * 1.5, s.firstLayerSpeed, 'base');

  const H = m.height, nLayers = Math.max(1, 1 + Math.ceil((H - flh) / lh - 1e-6));
  const near = (p: Path) => { let best = 0, bd = Infinity; for (let i = 0; i < p.length; i++) { const dd = Math.hypot(cx + p[i].X / SCALE - x, cy + p[i].Y / SCALE - y); if (dd < bd) { bd = dd; best = i; } } return [best, bd] as const; };
  for (let li = 0; li < nLayers; li++) {
    const zTop = li === 0 ? flh : Math.min(H, flh + li * lh), h = li === 0 ? flh : lh, speed = li === 0 ? s.firstLayerSpeed : s.speed;
    layer = li; layerStart.push(segs.length); layerZ.push(zTop);
    emit(';LAYER_CHANGE'); emit(`;LAYER:${li}`); emit(`;Z:${f3(zTop)}`); emit(`M73 P${Math.round((li / nLayers) * 100)}`);
    if (li === 1) emit(`M106 S${Math.round((s.fan / 100) * 255)}`);
    const zNext = li + 1 < nLayers ? Math.min(H, flh + (li + 1) * lh) : Infinity;
    const region = standSection(m, Math.max(0, zTop - h / 2));
    const islands = toExPolygons(offset(region, -w / 2));
    const todo = islands.map((ex) => [ex.contour, ...ex.holes] as Paths);
    while (todo.length) {
      // nearest island next, to keep travels short
      let bi = 0, bd = Infinity; for (let i = 0; i < todo.length; i++) { const dd = near(todo[i][0])[1]; if (dd < bd) { bd = dd; bi = i; } }
      let level: Paths = todo.splice(bi, 1)[0], depth = 0;
      while (level.length && depth < 600) {
        for (const p of level) {
          if (p.length < 3) continue;
          const [st] = near(p);
          travel(cx + p[st].X / SCALE, cy + p[st].Y / SCALE, zTop);
          for (let i = 1; i <= p.length; i++) { const q = p[(st + i) % p.length]; extrude(cx + q.X / SCALE, cy + q.Y / SCALE, h, w, speed, li === 0 ? 'base' : depth === 0 ? 'wall' : 'inner'); }
        }
        level = offset(level, -w); depth++;
      }
    }
    if (m.pause && zTop <= m.pause.z + 1e-6 && zNext > m.pause.z + 1e-6) {
      const steel = Math.round(m.pause.cm3 * BALLAST_FILL.steel), sand = Math.round(m.pause.cm3 * BALLAST_FILL.sand);
      emit(`; BALLAST PAUSE after layer ${li} (z ${f3(zTop)}): pour up to ${m.pause.cm3.toFixed(0)} cm3 into the open channels, level with the top of the print, then resume`);
      emit(`; about ${steel} g steel shot or ${sand} g dry sand`);
      travel(10, Math.min(s.bedY - 10, 200), Math.min(zTop + 10, m.height + 10));
      emit('M117 Fill ballast pocket, then resume');
      emit(pauseCommand(s.printer));
    }
  }
  emit(`; filament used: ${(eTot / 1000).toFixed(3)} m`);
  for (const l of s.endGcode.replace('{bedY_minus10}', String(s.bedY - 10)).split('\n')) emit(l);
  if (s0.lineWidth !== s.lineWidth || s0.layerHeight !== s.layerHeight) warnings.push(`Line width / layer height were kept within the ${NZ.d} mm nozzle's range.`);
  return { gcode: out.join('\n') + '\n', segs, layers: nLayers, layerStart, layerZ, warnings,
    stats: { lengthMm: len, filamentMm: eTot, grams: ((eTot * fa) / 1000) * 1.24, seconds: secs, lines: out.length, maxOffset: 0 } };
}

/** Defaults of a stand type, copied into the fitting when the type is picked. */
export function applyStand(f: Fitting, id: StandKind) { const t = standType(id); f.stand = id; if (id !== 'none') { f.legs = t.legs; f.splay = t.splay; f.legSize = t.size; } }
