// Lumonex builder: turns a LampDesign into printable parts (each with its assembled placement and its
// print orientation), preview-only parts (bulb, holder) and a report: printer fit per part, thermal
// clearance, joints, hardware list and notes.
import {
  BATTERIES, BOLTS, bulbById, bulbLength, bulbRadius, CABLES, holderById, swatch, SWITCHES, THERMAL, type MaterialKind,
} from './catalog';
import {
  arcTube, bounds, box, cylinder, flip, lathe, latheTube, merge, polarRing, prism, ringSolid, rotateX, rotateZ, roundedPrism,
  smooth, solidShell, soupVolume, strut, tau, translate, tubeShell, type Ring, type Soup, type V3,
} from './geom';
import { app } from './geom';
import { jointByKind, jointGeometry, spigotShell, type JointGeometry, type JointSpec } from './joinery';
import type { LampDesign, Section } from './model';
import { innerRadius, maxOuterAt, minInnerAt, resolutionFor, shapeShell, worstOverhang, type Resolution, type ShapeSpec } from './shape';

export interface Placement { pos: V3; rot: V3 }

export interface BuiltPart {
  key: string;
  name: string;
  /** Section id or accessory name, for grouping in the parts list. */
  group: string;
  /** Geometry in assembled coordinates (mm). */
  soup: Soup;
  cuts: Soup[];
  material: MaterialKind | 'Reference';
  color: string;
  hex: string;
  /** Rotation (deg, XYZ) applied about the part's own centre to stand it on the bed for printing. */
  printRot: V3;
  /** Rotation applied in the assembly (about the assembly origin) after building. */
  assemblyRot: V3;
  /** Point the assembly rotation turns about (default: the origin). */
  pivot?: V3;
  /** Preview only (bulb, holder, cord): never sliced. */
  ghost?: boolean;
  /** Print settings for this object (e.g. spiral vase). */
  overrides?: Record<string, unknown>;
  /** Copies to print. */
  copies: number;
}

export interface PartFit { key: string; name: string; size: V3; fits: boolean; axis: string[] }

export interface LumonexReport {
  parts: PartFit[];
  warnings: string[];
  notes: string[];
  hardware: string[];
  /** Smallest gap between bulb and shade wall (mm), or null when no bulb is inside a shade. */
  bulbGap: number | null;
  minGap: number;
  height: number;
  pieces: number;
}

export interface BuildResult { parts: BuiltPart[]; report: LumonexReport }

export interface Bed { x: number; y: number; z: number }

const SEAT_T = 3;

/** Tube from rows of (z, outer(a), inner(a)). */
function rowsTube(rows: { z: number; ro: (a: number) => number; ri: (a: number) => number }[], around: number, cx = 0, cy = 0): Soup {
  return tubeShell(rows.map((r) => polarRing(around, r.z, (a) => Math.max(r.ri(a) + 0.4, r.ro(a)), cx, cy)), rows.map((r) => polarRing(around, r.z, r.ri, cx, cy)));
}

/** Rotate a soup about X/Y/Z axes (degrees, XYZ order) around the origin. */
export function rotateXYZ(s: Soup, r: V3): Soup {
  if (r[0]) rotateX(s, r[0]);
  if (r[1]) {
    const c = Math.cos((r[1] * Math.PI) / 180), sn = Math.sin((r[1] * Math.PI) / 180);
    for (let i = 0; i < s.length; i += 3) { const x = s[i], z = s[i + 2]; s[i] = x * c + z * sn; s[i + 2] = -x * sn + z * c; }
  }
  if (r[2]) rotateZ(s, r[2]);
  return s;
}

/** A part's geometry as it sits in the finished lamp. */
export function assembled(p: Pick<BuiltPart, 'soup' | 'assemblyRot' | 'pivot'>, s: Soup = p.soup): Soup {
  const q = [...s], c = p.pivot ?? [0, 0, 0];
  translate(q, -c[0], -c[1], -c[2]);
  rotateXYZ(q, p.assemblyRot);
  return translate(q, c[0], c[1], c[2]);
}

interface Piece { section: Section; index: number; count: number; tFrom: number; tTo: number; z0: number }

/** How many pieces a section needs to fit the printer height. */
export function piecesFor(sec: Section, bed: Bed, margin: number): number {
  if (sec.pieces > 0) return sec.pieces;
  const usable = bed.z - margin - (sec.joint.length + 2);
  return Math.max(1, Math.ceil(sec.shape.height / Math.max(20, usable)));
}

/** Smallest outer radius around the shape at height t. */
function minOuterAt(s: ShapeSpec, t: number, n = 120): number {
  let m = Infinity;
  for (let j = 0; j < n; j++) { const a = (j / n) * tau; m = Math.min(m, Math.min(s.scaleX, s.scaleY) * (innerRadius({ ...s, wall: 0 }, a, t) + 0)); }
  return m;
}

interface JointPlan { g: JointGeometry; rc: number; rb: number; carve: boolean; spec: JointSpec; collarTop: number }

/** Plan a joint between the top of `lo` (at tLo) and the bottom of `up` (at tUp). */
function planJoint(spec: JointSpec, lo: ShapeSpec, tLo: number, up: ShapeSpec, tUp: number, bore: number, warn: (m: string) => void, label: string): JointPlan | null {
  const inner = Math.min(minInnerAt(lo, tLo), minInnerAt(up, tUp));
  const outer = Math.min(minOuterAt(lo, tLo), minOuterAt(up, tUp));
  if (lo.vase || up.vase) { warn(`${label}: vase-mode pieces cannot carry a joint; glue them or switch vase off.`); return null; }
  // thick wall (poles, stems): carve the socket into the wall; thin wall (shades): add collars inside
  const carve = inner < outer * 0.55;
  let rb: number, rc: number;
  if (carve) {
    rb = Math.max(bore, Math.min(inner, outer - 6));
    rc = Math.min(outer - 2.2, rb + Math.max(2.4, (outer - rb) * 0.55));
    if (rc - rb < 1.6) { warn(`${label}: wall too thin for a ${jointByKind(spec.kind).name} joint (needs ≥ 4 mm).`); rc = rb + 1.6; }
  } else {
    rc = inner - 3.2;
    rb = Math.max(bore, rc - 2.6);
    if (rc < 8) { warn(`${label}: opening too small for a joint.`); return null; }
  }
  const g = jointGeometry(spec, rc, rb, carve ? outer : inner - 0.4);
  return { g, rc, rb, carve, spec, collarTop: 0 };
}

/** Collar ring inside a thin shell between z0 and z1 (assembled), from the shell wall in to rIn(a, zLocal). */
function collar(s: ShapeSpec, sz0: number, z0: number, z1: number, rIn: (a: number, z: number) => number, around: number, chamferDown: boolean, floorZ = -Infinity): Soup {
  const rows: { z: number; ro: (a: number) => number; ri: (a: number) => number }[] = [];
  const minS = Math.min(s.scaleX, s.scaleY);
  const wallAt = (a: number, z: number) => innerRadius(s, a, Math.min(1, Math.max(0, (z - sz0) / s.height))) * minS + 0.6;
  const span = z1 - z0;
  const steps = Math.max(1, Math.ceil(span / 0.3));
  for (let k = 0; k <= steps; k++) { const z = z0 + (span * k) / steps; rows.push({ z, ro: (a) => wallAt(a, z), ri: (a) => rIn(a, z - z0) }); }
  if (chamferDown) {
    // 45° underside so the collar prints without support
    const w = Math.max(...Array.from({ length: 24 }, (_, j) => wallAt((j / 24) * tau, z0) - rIn((j / 24) * tau, 0)));
    const out: typeof rows = [];
    for (let k = 0; k <= Math.ceil(w / 0.6); k++) {
      const dz = (k * 0.6) - w;
      if (dz >= 0) break;
      if (z0 + dz < floorZ) continue;
      const f = k / Math.ceil(w / 0.6);
      out.push({ z: z0 + dz, ro: (a) => rIn(a, 0) + 0.3 + (wallAt(a, z0) - rIn(a, 0)) * f, ri: (a) => rIn(a, 0) });
    }
    rows.unshift(...out);
  }
  return rowsTube(rows, around);
}

export function buildLamp(d: LampDesign, bed: Bed): BuildResult {
  const warnings: string[] = [], notes: string[] = [], hardware: string[] = [];
  const warn = (m: string) => { if (!warnings.includes(m)) warnings.push(m); };
  const parts: BuiltPart[] = [];
  const holder = holderById(d.fitting.holder);
  const bulb = bulbById(d.bulb);
  const cable = CABLES.find((c) => c.id === d.wiring.cable) ?? CABLES[0];
  const bore = cable.d / 2 + 0.8;
  const hc = d.fitting.clearance;
  const add = (p: Omit<BuiltPart, 'copies' | 'assemblyRot' | 'cuts' | 'printRot'> & Partial<Pick<BuiltPart, 'copies' | 'assemblyRot' | 'cuts' | 'printRot' | 'pivot'>>) =>
    parts.push({ copies: 1, assemblyRot: [0, 0, 0], cuts: [], printRot: [0, 0, 0], ...p });
  const hexOf = (s: Section) => swatch(s.material, s.color).hex;

  // ---------------------------------------------------------------- stack layout
  const stack = d.sections.filter((s) => s.attach === 'stack');
  const hung = d.sections.filter((s) => s.attach === 'hung');
  const z0Of = new Map<string, number>();
  let cursor = 0;
  for (const s of stack) { const z = cursor + s.zOffset; z0Of.set(s.id, z); cursor = z + s.shape.height; }
  const stackTop = cursor;
  // where the holder ring sits (assembled z)
  const holderSection = d.kind === 'lantern' ? stack.find((s) => s.role === 'base') ?? stack[0] ?? null
    : d.kind === 'mount' ? stack.find((s) => s.role === 'body') ?? stack[0] ?? null
    : [...stack].reverse().find((s) => s.role !== 'cap' && s.role !== 'deco') ?? null;
  const pole = d.sections.find((s) => s.role === 'pole');
  const poleR = pole ? maxOuterAt(pole.shape, 1, 60) : d.pole.diameter / 2;
  let ringZ: number;
  if (d.kind === 'pendant') ringZ = 0;
  else if (d.kind === 'mount') ringZ = holderSection ? z0Of.get(holderSection.id)! + (holderSection.shape.floor || SEAT_T) + 3 : 0;
  else if (d.kind === 'ceiling') ringZ = stackTop * 0.45 + 11 + d.pole.armLength * 0.25 + 6 + SEAT_T;
  else if (d.kind === 'wall') ringZ = d.wall.plateH * 0.35;
  else ringZ = holderSection ? z0Of.get(holderSection.id)! + holderSection.shape.height : 0;

  for (const s of hung) {
    const gz = s.gallery * s.shape.height;
    z0Of.set(s.id, ringZ - gz - SEAT_T / 2 + s.zOffset + (s.gallery >= 0.5 ? 0 : 0));
  }

  // ---------------------------------------------------------------- sections → pieces
  const pieces: Piece[] = [];
  for (const s of d.sections) {
    if (s.skip) continue;
    const n = piecesFor(s, bed, d.margin);
    for (let i = 0; i < n; i++) pieces.push({ section: s, index: i, count: n, tFrom: i / n, tTo: (i + 1) / n, z0: z0Of.get(s.id)! });
  }
  const res = new Map<string, Resolution>();
  for (const s of d.sections) res.set(s.id, resolutionFor(s.shape, d.quality));

  // joints: between pieces of one section, and between consecutive stacked sections
  type Edge = { lo: Piece; up: Piece; plan: JointPlan };
  const edges: Edge[] = [];
  const jointsLo = new Map<Piece, Edge>(), jointsUp = new Map<Piece, Edge>();
  const link = (lo: Piece, up: Piece, spec: JointSpec, label: string) => {
    const plan = planJoint(spec, lo.section.shape, lo.tTo, up.section.shape, up.tFrom, bore, warn, label);
    if (!plan) return;
    const e = { lo, up, plan };
    edges.push(e); jointsLo.set(lo, e); jointsUp.set(up, e);
    notes.push(`${label}: ${jointByKind(spec.kind).name} (Ø${(plan.rc * 2).toFixed(1)} spigot, ${spec.length} mm).`, ...plan.g.notes.map((n) => `  · ${n}`));
  };
  for (let i = 1; i < pieces.length; i++) {
    const a = pieces[i - 1], b = pieces[i];
    if (a.section === b.section) link(a, b, a.section.joint, `${a.section.name} ${a.index + 1}/${a.count} → ${b.index + 1}/${b.count}`);
  }
  for (let i = 1; i < stack.length; i++) {
    const lo = pieces.filter((p) => p.section === stack[i - 1]).pop(), up = pieces.find((p) => p.section === stack[i]);
    if (lo && up && !stack[i].skip && !stack[i - 1].skip) link(lo, up, stack[i].joint, `${stack[i - 1].name} → ${stack[i].name}`);
  }

  // per-piece geometry
  for (const p of pieces) {
    const s = p.section, sh = s.shape, r = res.get(s.id)!;
    const zA = p.z0 + p.tFrom * sh.height, zB = p.z0 + p.tTo * sh.height;
    const below = jointsUp.get(p), above = jointsLo.get(p);
    const soup: Soup = [];
    const cuts: Soup[] = [];
    const ringOpts = below?.plan.carve ? { inner: (a: number, z: number) => (z <= below.plan.spec.length ? below.plan.g.female(a, z) : 0), denseBottom: below.plan.spec.length } : {};
    app(soup, shapeShell(sh, r, p.tFrom, p.tTo, zA, ringOpts));
    if (below) {
      const pl = below.plan;
      if (!pl.carve) app(soup, collar(sh, p.z0, zA, zA + pl.spec.length + 1.5, (a, z) => (z <= pl.spec.length ? pl.g.female(a, z) : pl.rb), r.around, false));
      for (const c of pl.g.femaleCuts) cuts.push(translate([...c], 0, 0, zA));
    }
    if (above) {
      const pl = above.plan;
      if (!pl.carve) app(soup, collar(sh, p.z0, Math.max(zA + (p.index === 0 ? sh.floor : 0) + 0.7, zB - 6), zB, () => pl.rb, r.around, true, zA + (p.index === 0 ? sh.floor : 0) + 0.4));
      app(soup, spigotShell(pl.g, pl.rb, zB, r.around));
      for (const c of pl.g.maleCuts) cuts.push(translate([...c], 0, 0, zB));
      for (const x of pl.g.extras) add({ key: `${s.id}-x${p.index}-${x.name}`, name: `${x.name} (${s.name})`, group: s.name, soup: x.soup, material: s.material, color: s.color, hex: hexOf(s) });
    }
    // gallery for hung shades
    if (s.attach === 'hung' && s.gallery >= p.tFrom - 1e-9 && s.gallery <= p.tTo + 1e-9) {
      const g = galleryRing(d, s, p.z0, r, holder.ringHole, hc, bore);
      if (sh.vase) {
        add({ key: `${s.id}-gallery`, name: `Gallery insert (${s.name})`, group: s.name, soup: g, material: s.material, color: s.color, hex: hexOf(s) });
        notes.push(`${s.name}: vase mode — the gallery is a separate insert; push it in and glue.`);
      } else app(soup, g);
    }
    // holder seat on the stack top
    if (s === holderSection && p.index === p.count - 1 && d.kind !== 'pendant' && d.kind !== 'wall' && d.kind !== 'ceiling' && d.kind !== 'mount') {
      const seat = holderSeat(d, s, zB, p.z0, r, holder.ringHole, hc, bore, warn);
      app(soup, seat.soup);
      app(cuts, seat.cuts);
      if (seat.part) add({ key: `${s.id}-cup`, name: 'Holder cup', group: s.name, soup: seat.part, material: s.material, color: s.color, hex: hexOf(s) });
    }
    if (s === holderSection && d.kind === 'mount' && p.index === 0) {
      app(soup, ledSeat(d, s, p.z0, r, bore));
      // the head's prongs of the tilt knuckle (they sit between the arm's prongs; pivot axis along Y)
      for (const [y0, y1] of knuckle(d.mount).head) app(soup, box(-7, y0, p.z0 - 14, 7, y1, p.z0 + 1));
      cuts.push(strut([0, -12, p.z0 - 7], [0, 12, p.z0 - 7], 2.7, 16));
    }
    // ballast chamber and felt recess in the bottom of the base
    if (s === stack[0] && s.role === 'base' && p.index === 0 && (d.kind === 'table' || d.kind === 'floor' || d.kind === 'ceiling')) {
      const bb = baseExtras(d, s, p.z0, r, bore, warn, notes);
      app(soup, bb.soup); app(cuts, bb.cuts);
      if (bb.plug) add({ key: `${s.id}-plug`, name: 'Ballast fill plug', group: s.name, soup: bb.plug, material: s.material, color: s.color, hex: hexOf(s) });
    }
    // wire exits and switches go through the bottom piece of the first stacked section (or the head)
    const wireHost = d.kind === 'mount' || d.kind === 'lantern' ? holderSection : stack[0];
    if (s === wireHost && p.index === 0) app(cuts, wireCuts(d, s, p.z0, cable.d, warn));
    // tripod legs
    if (s === stack[0] && s.role === 'base' && d.base.legs >= 3 && p.index === 0) app(soup, legs(d, s, p.z0));

    const flipped = s.attach === 'hung' && s.gallery >= 0.5;
    const overrides = sh.vase ? { spiral_mode: true, bottom_shell_layers: 0, top_shell_layers: 0 } : undefined;
    const label = p.count > 1 ? `${s.name} ${p.index + 1}/${p.count}` : s.name;
    const tilt = d.kind === 'mount' && s === holderSection && d.mount.tilt ? { assemblyRot: [0, d.mount.tilt, 0] as V3, pivot: [0, 0, p.z0 - 7] as V3 } : {};
    add({ key: `${s.id}-${p.index}`, name: label, group: s.name, soup, cuts, material: s.material, color: s.color, hex: hexOf(s), printRot: flipped ? [180, 0, 0] : [0, 0, 0], overrides, ...tilt });
    // overhang check in print orientation
    const oh = worstOverhang(sh, flipped);
    if (oh > 62 && !sh.vase) warn(`${s.name}: ${Math.round(oh)}° overhang in print orientation — add supports, raise the handles, or flip the gallery.`);
  }

  // ---------------------------------------------------------------- lamp-type parts
  accessories(d, add, warn, notes, hardware, { holderRing: holder.ringHole, hc, bore, ringZ, stackTop, cableD: cable.d, hexOf });

  // ---------------------------------------------------------------- preview: holder + bulb
  if (d.showBulb) {
    const hz = ringZ;
    if (holder.length > 0) add({ key: 'ghost-holder', name: `${holder.name} holder (preview)`, group: 'Preview', soup: holder.mount === 'pad' || holder.mount === 'strip' ? [] : lathe([[holder.body / 2, hz - holder.length], [holder.body / 2, hz + holder.above]], 32), material: 'Reference', color: 'Holder', hex: '#2b2b2b', ghost: true });
    const bz = holder.mount === 'pad' || holder.mount === 'strip' ? hz : hz + holder.above - (bulb.profile[1]?.[1] ?? 0);
    add({ key: 'ghost-bulb', name: `${bulb.name} (preview)`, group: 'Preview', soup: lathe(bulb.profile.map(([rr, z]) => [Math.max(0.5, rr), bz + z] as [number, number]), 48), material: 'Reference', color: 'Bulb', hex: '#fff3c4', ghost: true });
  }
  for (const p of parts) if (p.soup.length === 0) p.ghost = true;
  if (d.kind === 'ceiling') {
    const out = poleR + d.pole.armLength, names = new Set(hung.map((s) => s.name));
    for (const p of parts) if (names.has(p.group) || p.group === 'Preview') { translate(p.soup, 0, out, 0); for (const k of p.cuts) translate(k, 0, out, 0); }
    for (const s of hung) { const pp = parts.filter((p) => p.group === s.name); for (const p of pp) p.copies = Math.max(1, d.pole.arms); }
  }

  // ---------------------------------------------------------------- thermal + bulb access
  const bz0 = holder.mount === 'pad' || holder.mount === 'strip' ? ringZ : ringZ + holder.above - (bulb.profile[1]?.[1] ?? 0);
  let gap: number | null = null, minGap = 25;
  const lowPower = (holder.mount === 'pad' || holder.mount === 'strip') && d.watts <= 3;
  for (const s of d.sections) {
    const z0 = z0Of.get(s.id)!, H = s.shape.height;
    // LED pucks and strips at a few watts run cool: only keep them off the wall
    const need = lowPower ? 0 : Math.round(THERMAL[s.material].minGap * Math.sqrt(Math.min(1, Math.max(0.25, d.watts / 9))));
    let worst: number | null = null;
    for (const [rb, zb] of bulb.profile) {
      const z = bz0 + zb;
      if (z < z0 || z > z0 + H) continue;
      const g = minInnerAt(s.shape, (z - z0) / H, 90) - rb;
      if (worst === null || g < worst) worst = g;
    }
    if (worst !== null) {
      if (gap === null || worst < gap) { gap = worst; minGap = need; }
      if (worst < need) warn(`${s.name}: bulb is ${Math.max(0, worst).toFixed(0)} mm from the ${s.material} wall (keep ≥ ${need} mm at ${d.watts} W). Use a smaller bulb, less power or a wider part.`);
    }
    if (d.watts > THERMAL[s.material].maxWatts) warn(`${s.name}: ${d.watts} W is above the ${THERMAL[s.material].maxWatts} W LED limit for ${s.material}.`);
    if (s.attach === 'hung' && !s.skip) {
      const open = Math.max(minInnerAt(s.shape, 0, 60), minInnerAt(s.shape, 1, 60));
      if (open < bulbRadius(bulb) + 1 && holder.mount !== 'pad') warn(`${s.name}: openings (Ø${(open * 2).toFixed(0)}) are smaller than the bulb (Ø${(bulbRadius(bulb) * 2).toFixed(0)}) — the bulb cannot be changed. Widen an opening or split the shade.`);
    }
  }
  if (!holder.bulbs.includes(bulb.id)) warn(`${bulb.name} does not fit the ${holder.name} holder.`);
  notes.push('LED lamps only. Never fit incandescent or halogen bulbs in printed shades.');
  if (hung.length && holderSection) {
    const inner = minInnerAt(holderSection.shape, 1, 60);
    if (d.kind === 'table' && inner < holder.body / 2 + hc && inner > holder.ringHole / 2 + 4) warn(`${holderSection.name}: holder body (Ø${holder.body}) does not fit inside the top (Ø${(inner * 2).toFixed(0)}).`);
  }
  hardware.unshift(`${holder.name} lamp holder`, `${cable.name} cable`);
  const sw = SWITCHES.find((x) => x.id === d.wiring.switchId);
  if (sw && sw.shape !== 'none') hardware.push(`${sw.name}`);
  if (sw?.id === 'inline') hardware.push('Inline cord switch');
  hardware.push(`${bulb.name} LED, ≤ ${d.watts} W`);
  for (const e of edges) for (const n of e.plan.g.notes) if (/bolt|insert|magnet/i.test(n)) hardware.push(n);

  // ---------------------------------------------------------------- printer fit
  const fit: PartFit[] = [];
  const lim: V3 = [bed.x - d.margin * 2, bed.y - d.margin * 2, bed.z - d.margin];
  for (const p of parts) {
    if (p.ghost) continue;
    const s = rotateXYZ([...p.soup], p.printRot);
    const b = bounds(s), size: V3 = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
    // a part can be turned on the bed: compare the footprint either way round
    const fitsXY = (size[0] <= lim[0] && size[1] <= lim[1]) || (size[0] <= lim[1] && size[1] <= lim[0]) || Math.hypot(size[0], size[1]) * 0.71 <= Math.min(lim[0], lim[1]);
    const axis: string[] = [];
    if (!fitsXY) axis.push('XY');
    if (size[2] > lim[2]) axis.push('Z');
    fit.push({ key: p.key, name: p.name, size, fits: axis.length === 0, axis });
    if (axis.includes('XY')) warn(`${p.name} is ${size[0].toFixed(0)} × ${size[1].toFixed(0)} mm — wider than the printer bed (${bed.x} × ${bed.y}). Reduce its diameter or pick a larger printer.`);
    if (axis.includes('Z')) warn(`${p.name} is ${size[2].toFixed(0)} mm tall — over the printer height (${bed.z}). Raise its piece count.`);
  }
  const all = parts.filter((p) => !p.ghost).flatMap((p) => { const b = bounds(assembled(p)); return [b.min[2], b.max[2]]; });
  const height = all.length ? Math.max(...all) - Math.min(...all) : 0;
  return { parts, report: { parts: fit, warnings, notes, hardware: [...new Set(hardware)], bulbGap: gap, minGap, height, pieces: parts.filter((p) => !p.ghost).reduce((a, p) => a + p.copies, 0) } };
}

// ---------------------------------------------------------------- fittings
/** Gallery: the ring (or spoked hub) inside a hung shade that the holder's shade ring clamps. */
function galleryRing(d: LampDesign, s: Section, z0: number, r: Resolution, ringHole: number, hc: number, bore: number): Soup {
  const sh = s.shape, holder = holderById(d.fitting.holder);
  const t = s.gallery, zc = z0 + t * sh.height;
  const zA = Math.max(z0, Math.min(z0 + sh.height - SEAT_T, zc - SEAT_T / 2)), zB = zA + SEAT_T;
  const rh = holder.mount === 'pad' || holder.mount === 'strip' ? bore : ringHole / 2 + hc;
  const minS = Math.min(sh.scaleX, sh.scaleY);
  const wall = (a: number, z: number) => innerRadius(sh, a, Math.min(1, Math.max(0, (z - z0) / sh.height))) * minS + 0.6;
  const atEnd = zA - z0 < 1 || z0 + sh.height - zB < 1;
  if (s.spokes > 0) {
    const out: Soup = [...ringSolid(rh + 6, rh, zA, zB, 64)];
    const reach = Math.max(...Array.from({ length: 36 }, (_, j) => wall((j / 36) * tau, zA)));
    for (let i = 0; i < s.spokes; i++) app(out, rotateZ(box(rh + 4, -3, zA, reach, 3, zB), (i * 360) / s.spokes));
    return out;
  }
  const flipped = t >= 0.5;
  // mid-height galleries get a 45° cone on the side that faces down while printing
  if (atEnd) return rowsTube([{ z: zA, ro: (a) => wall(a, zA), ri: () => rh }, { z: zB, ro: (a) => wall(a, zB), ri: () => rh }], r.around);
  const w = Math.max(...Array.from({ length: 24 }, (_, j) => wall((j / 24) * tau, zA))) - rh;
  const rows: { z: number; ro: (a: number) => number; ri: (a: number) => number }[] = [];
  if (!flipped) {
    for (let k = 0, steps = Math.ceil(w / 0.8); k <= steps; k++) { const z = zA - w + (w * k) / steps; if (z < z0) continue; rows.push({ z, ro: (a) => wall(a, z), ri: (a) => wall(a, z) - 0.4 - (wall(a, z) - rh - 0.4) * (k / steps) }); }
    rows.push({ z: zB, ro: (a) => wall(a, zB), ri: () => rh });
  } else {
    rows.push({ z: zA, ro: (a) => wall(a, zA), ri: () => rh });
    for (let k = 0, steps = Math.ceil(w / 0.8); k <= steps; k++) { const z = zB + (w * k) / steps; if (z > z0 + sh.height) break; rows.push({ z, ro: (a) => wall(a, z), ri: (a) => rh + (wall(a, z) - rh - 0.4) * (k / steps) }); }
  }
  return rowsTube(rows.length >= 2 ? rows : [{ z: zA, ro: (a) => wall(a, zA), ri: () => rh }, { z: zB, ro: (a) => wall(a, zB), ri: () => rh }], r.around);
}

/** Holder seat at the top of the stack: a plate in wide tops, or a separate cup on narrow poles. */
function holderSeat(d: LampDesign, s: Section, zTop: number, z0: number, r: Resolution, ringHole: number, hc: number, bore: number, warn: (m: string) => void): { soup: Soup; cuts: Soup[]; part?: Soup } {
  const holder = holderById(d.fitting.holder), sh = s.shape;
  const inner = minInnerAt(sh, 1, 90);
  const rh = holder.mount === 'pad' || holder.mount === 'strip' ? bore : ringHole / 2 + hc;
  if (inner > rh + 4) {
    const minS = Math.min(sh.scaleX, sh.scaleY);
    const wall = (a: number, z: number) => innerRadius(sh, a, Math.min(1, (z - z0) / sh.height)) * minS + 0.6;
    const zA = zTop - SEAT_T;
    // 45° support cone under the plate
    const w = Math.max(...Array.from({ length: 24 }, (_, j) => wall((j / 24) * tau, zA))) - rh;
    const rows: { z: number; ro: (a: number) => number; ri: (a: number) => number }[] = [];
    for (let k = 0, steps = Math.max(1, Math.ceil(w / 0.8)); k <= steps; k++) { const z = zA - w + (w * k) / steps - 0.13; if (z < z0 + 1) continue; rows.push({ z, ro: (a) => wall(a, z) + 0.3, ri: (a) => wall(a, z) - 0.4 - (wall(a, z) - rh - 0.4) * (k / steps) }); }
    rows.push({ z: zTop - 0.05, ro: (a) => wall(a, zTop) + 0.3, ri: () => rh });
    if (rows.length < 2) rows.unshift({ z: zA, ro: (a) => wall(a, zA), ri: () => rh });
    if (inner < holder.body / 2 + hc && holder.length > 0) warn(`${s.name}: the holder body (Ø${holder.body}) is wider than the inside of the top (Ø${(inner * 2).toFixed(0)}).`);
    return { soup: rowsTube(rows, r.around), cuts: [] };
  }
  // narrow top (pole / stem): a separate cup that slips over the top
  const ro = maxOuterAt(sh, 1, 60), cupR = Math.max(holder.body / 2 + hc + 2.4, ro + 2.4 + d.fitting.clearance);
  const L = Math.max(20, holder.length * 0.6), sleeve = 18;
  const ri = ro + d.fitting.clearance, hb = holder.body / 2 + hc;
  const part = latheTube([[cupR, ri, 0], [cupR, ri, sleeve], [cupR, bore, sleeve], [cupR, bore, sleeve + SEAT_T], [cupR, hb, sleeve + SEAT_T], [cupR, hb, sleeve + SEAT_T + L], [cupR, rh, sleeve + SEAT_T + L], [cupR, rh, sleeve + 2 * SEAT_T + L]], 64);
  translate(part, 0, 0, zTop - sleeve);
  return { soup: [], cuts: [], part };
}

/** LED module seat on the floor of a lantern base or lamp head. */
function ledSeat(d: LampDesign, s: Section, z0: number, r: Resolution, bore: number): Soup {
  const b = bulbById(d.bulb), rr = bulbRadius(b) + 0.3, sh = s.shape;
  const zf = z0 + Math.max(sh.floor, 0);
  const minS = Math.min(sh.scaleX, sh.scaleY);
  const inner = minInnerAt(sh, 0.2, 60);
  const post = Math.min(inner - 1, rr + 2.4);
  const h = Math.max(4, d.kind === 'lantern' ? (d.lantern.boxHeight - sh.floor) * 0.8 : 3);
  void r; void minS;
  return latheTube([[post, post - 2.4, zf - 0.2], [post, post - 2.4, zf + h - 4.5], [post, bore, zf + h - 4.5], [post, bore, zf + h - 2.5], [post, rr, zf + h - 2.5], [post, rr, zf + h]], 48);
}

function wireCuts(d: LampDesign, s: Section, z0: number, cd: number, warn: (m: string) => void): Soup[] {
  const w = d.wiring, sh = s.shape, out: Soup[] = [];
  const R = maxOuterAt(sh, 0.05, 60) + 5;
  const a = (w.exitAngle * Math.PI) / 180;
  const hole = cd / 2 + 0.5 + (w.grommet ? 1.5 : 0);
  const dir = (rr: number, z: number): V3 => [rr * Math.cos(a), rr * Math.sin(a), z];
  switch (w.route) {
    case 'side-exit': out.push(strut(dir(0, z0 + Math.max(hole + 1, w.exitHeight)), dir(R, z0 + Math.max(hole + 1, w.exitHeight)), hole, 24)); break;
    case 'rear': out.push(strut(dir(0, z0 + sh.height * 0.7), dir(R, z0 + sh.height * 0.7), hole, 24)); break;
    case 'bottom-channel': out.push(rotateZ(box(0, -(cd / 2 + 0.6), z0 - 1, R, cd / 2 + 0.6, z0 + cd + 1), w.exitAngle)); break;
    case 'center-down': out.push(cylinder(hole, z0 - 1, z0 + Math.max(sh.floor, 3) + 1, 24)); break;
    default: break;
  }
  if (w.grommet && (w.route === 'side-exit' || w.route === 'rear')) warn('Fit a rubber grommet (or the printed strain-relief) in the cable exit and knot the cable inside.');
  const sw = SWITCHES.find((x) => x.id === w.switchId);
  if (sw && sw.shape !== 'none') {
    const sa = w.switchAngle, zz = z0 + w.switchHeight;
    if (w.switchHeight + sw.h / 2 > sh.height) warn(`Switch at ${w.switchHeight} mm is above the top of ${s.name}.`);
    if (sw.shape === 'rect') out.push(rotateZ(box(0, -sw.w / 2, zz - sw.h / 2, R, sw.w / 2, zz + sw.h / 2), sa));
    else out.push(strut([0, 0, zz], [R * Math.cos((sa * Math.PI) / 180), R * Math.sin((sa * Math.PI) / 180), zz], sw.w / 2, 32));
  }
  if (d.kind === 'lantern' && d.lantern.usb) {
    const sa = w.switchAngle + 180, zz = z0 + Math.max(6, (sh.floor || 2) + 4);
    out.push(rotateZ(box(0, -4.8, zz - 2, R, 4.8, zz + 2), sa));
  }
  return out;
}

function legs(d: LampDesign, s: Section, z0: number): Soup {
  // splayed legs from the hub down to the floor (the hub and everything above stand on them)
  const n = d.base.legs, sh = s.shape, R = sh.diameter / 2, out: Soup = [];
  const L = Math.max(100, sh.diameter * 1.4), t = Math.tan((d.base.legSplay * Math.PI) / 180);
  const lr = Math.max(6, R * 0.14);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * tau + Math.PI / n, c = Math.cos(a), sn = Math.sin(a);
    const r0 = R * 0.55, r1 = r0 + t * L + R * 0.3;
    app(out, strut([r0 * c, r0 * sn, z0 + sh.height * 0.6], [r1 * c, r1 * sn, z0 - L + 2], lr, 20));
    app(out, cylinder(lr * 1.5, z0 - L, z0 - L + 2.5, 24, r1 * c, r1 * sn));
  }
  return out;
}

// ---------------------------------------------------------------- per lamp type
interface Ctx { holderRing: number; hc: number; bore: number; ringZ: number; stackTop: number; cableD: number; hexOf: (s: Section) => string }

type Add = (p: Omit<BuiltPart, 'copies' | 'assemblyRot' | 'cuts' | 'printRot'> & Partial<Pick<BuiltPart, 'copies' | 'assemblyRot' | 'cuts' | 'printRot' | 'pivot'>>) => void;

const keyhole = (x: number, y: number, z0: number, z1: number, screw: number): Soup[] => [
  cylinder(screw * 1.1, z0 - 1, z1 + 1, 24, x, y),
  box(x - screw / 2 - 0.2, y, z0 - 1, x + screw / 2 + 0.2, y + 10, z1 + 1),
  // head pocket behind the slot
  box(x - screw * 1.1, y - screw, z0 - 1, x + screw * 1.1, y + 10, z0 + 3),
];

/** Split clamp half: half annulus + two ears, extruded along Z (pipe axis along Z). */
function clampHalf(rp: number, wall: number, width: number, earL: number, hinge: 'none' | 'top' | 'bottom' = 'none'): Soup {
  const ro = rp + wall, pts: [number, number][] = [], n = 40;
  for (let i = 0; i <= n; i++) { const a = (Math.PI * i) / n; pts.push([ro * Math.cos(a), ro * Math.sin(a)]); }
  for (let i = n; i >= 0; i--) { const a = (Math.PI * i) / n; pts.push([rp * Math.cos(a), rp * Math.sin(a)]); }
  const out = prism(pts, 0, width);
  if (earL > 0) {
    if (hinge !== 'bottom') app(out, box(rp + 0.3, 0, 0, ro + earL, wall * 1.2, width));
    if (hinge === 'none') app(out, box(-ro - earL, 0, 0, -rp - 0.3, wall * 1.2, width));
    else {
      // hinge knuckles on the split line (pin axis along Z): the top half carries the outer two on −X; the bottom
      // half (turned 180° afterwards) carries the middle one, built on +X here
      const sx = hinge === 'top' ? -1 : 1, cx = sx * (ro + earL / 2), g = 0.3;
      if (hinge === 'bottom') { app(out, box(-ro - earL, 0, 0, -rp - 0.3, wall * 1.2, width)); }
      const spans: [number, number][] = hinge === 'top' ? [[0, width / 3 - g], [(2 * width) / 3 + g, width]] : [[width / 3 + g, (2 * width) / 3 - g]];
      for (const [z0, z1] of spans) {
        app(out, cylinder(earL / 2, z0, z1, 32, cx, 0));
        app(out, sx < 0 ? box(cx, 0.01, z0, -rp - 0.3, earL / 2 - 0.2, z1) : box(rp + 0.3, 0.01, z0, cx, earL / 2 - 0.2, z1));
      }
    }
  }
  return out;
}

/** Hex nut pocket opening downward (−Y) at x, centred on z. */
function nutTrap(x: number, y: number, z: number, af: number, h: number): Soup {
  const R = af / Math.sqrt(3) + 0.15;
  const hx: [number, number][] = Array.from({ length: 6 }, (_, i) => [x + R * Math.cos((i / 6) * tau), z + R * Math.sin((i / 6) * tau)]);
  // extrude along Y: build in XZ then swap (proper rotation keeps winding)
  const s = prism(hx.map(([a, c]) => [a, c] as [number, number]), 0, h + 0.4);
  for (let i = 0; i < s.length; i += 3) { const yy = s[i + 1], zz = s[i + 2]; s[i + 1] = y + zz - 0.01; s[i + 2] = yy; }
  return orientCut(s);
}

const orientCut = (s: Soup): Soup => { if (soupVolume(s) < 0) for (let i = 0; i < s.length; i += 9) for (let k = 0; k < 3; k++) { const t = s[i + 3 + k]; s[i + 3 + k] = s[i + 6 + k]; s[i + 6 + k] = t; } return s; };

/** Prong layout of the tilt knuckle: arm prongs (Z spans before the clamp is stood up) and head prongs (Y spans). */
export function knuckle(m: LampDesign['mount']): { arm: [number, number][]; head: [number, number][] } {
  return m.style === 'gopro'
    ? { arm: [[-7.75, -4.6], [-1.55, 1.55], [4.6, 7.75]], head: [[-4.3, -1.85], [1.85, 4.3]] }
    : { arm: [[-7, -4], [4, 7]], head: [[-2.6, 2.6]] };
}

/** Sealed ballast chamber (sand / steel shot) with a fill plug, and a felt recess under the floor. */
function baseExtras(d: LampDesign, s: Section, z0: number, r: Resolution, bore: number, warn: (m: string) => void, notes: string[]): { soup: Soup; cuts: Soup[]; plug?: Soup } {
  const sh = s.shape, out: Soup = [], cuts: Soup[] = [];
  let plug: Soup | undefined;
  const minS = Math.min(sh.scaleX, sh.scaleY);
  const wall = (a: number, z: number) => innerRadius(sh, a, Math.min(1, Math.max(0, (z - z0) / sh.height))) * minS + 0.6;
  if (d.base.ballast) {
    if (sh.floor <= 0) { warn(`${s.name}: the ballast chamber needs a floor — set Floor above 0.`); }
    else {
      const top = z0 + Math.min(sh.height * 0.55, Math.max(20, sh.height - 25));
      const tube = bore + 2;
      const reach = Math.max(...Array.from({ length: 36 }, (_, j) => wall((j / 36) * tau, top))) - tube;
      // cable tube through the chamber, then a roof with a 45° cone underneath
      app(out, latheTube([[tube, bore, z0 + sh.floor - 0.2], [tube, bore, top - reach]], 32));
      const rows: { z: number; ro: (a: number) => number; ri: (a: number) => number }[] = [];
      const steps = Math.max(2, Math.ceil(reach / 0.8));
      for (let k = 0; k <= steps; k++) { const z = top - reach + (reach * k) / steps; if (z < z0 + sh.floor + 1) continue; rows.push({ z, ro: (a) => tube + 0.4 + (wall(a, z) - tube - 0.4) * (k / steps), ri: () => bore }); }
      rows.push({ z: top + 3, ro: (a) => wall(a, top + 3), ri: () => bore });
      if (rows.length >= 2) app(out, rowsTube(rows, r.around));
      const fx = (tube + Math.min(...Array.from({ length: 36 }, (_, j) => wall((j / 36) * tau, top)))) / 2;
      cuts.push(cylinder(6, top - 4, top + 4, 32, fx, 0));
      plug = merge(cylinder(5.85, 0, 6, 32), cylinder(8.5, 6, 8, 32));
      translate(plug, fx, 0, top - 3);
      const vol = Math.PI * (Math.min(...Array.from({ length: 36 }, (_, j) => wall((j / 36) * tau, z0))) ** 2 - tube ** 2) * (top - reach / 2 - z0 - sh.floor) / 1000;
      notes.push(`${s.name}: ballast chamber ≈ ${Math.max(0, vol).toFixed(0)} cm³ (≈ ${(Math.max(0, vol) * 1.6 / 1000).toFixed(1)} kg sand, ${(Math.max(0, vol) * 4.5 / 1000).toFixed(1)} kg steel shot). Fill through the hole under the roof, then press in the plug.`);
    }
  }
  if (d.base.feltRecess > 0) {
    if (sh.floor <= d.base.feltRecess + 0.8) notes.push(`${s.name}: felt recess skipped — the floor is thinner than ${(d.base.feltRecess + 0.8).toFixed(1)} mm.`);
    else {
      const rr = Math.min(...Array.from({ length: 36 }, (_, j) => wall((j / 36) * tau, z0))) - 3;
      cuts.push(cylinder(rr, z0 - 1, z0 + d.base.feltRecess, 96));
      notes.push(`${s.name}: ${d.base.feltRecess} mm recess for a Ø${(rr * 2).toFixed(0)} felt disc.`);
    }
  }
  return { soup: out, cuts, plug };
}

function accessories(d: LampDesign, add: Add, warn: (m: string) => void, notes: string[], hardware: string[], c: Ctx) {
  const acc = d.accessories, mainHex = d.sections[0] ? c.hexOf(d.sections[0]) : '#cccccc';
  const mat = d.sections[0]?.material ?? 'PLA Matte', col = d.sections[0]?.color ?? 'Black';
  const P = (key: string, name: string, soup: Soup, extra: Partial<BuiltPart> = {}) => add({ key, name, group: 'Fittings', soup, material: mat, color: col, hex: mainHex, ...extra });
  const holder = holderById(d.fitting.holder);
  const rh = c.holderRing / 2 + c.hc;

  if (d.kind === 'wall') {
    const w = d.wall, b = BOLTS[w.screw];
    const plate = roundedPrism(w.plateW, w.plateH, w.plateRadius, 0, w.plateT);
    const cuts: Soup[] = [];
    const ks = Math.max(1, w.keyholes);
    for (let i = 0; i < ks; i++) {
      const y = ks === 1 ? w.plateH * 0.3 : -w.plateH * 0.3 + (w.plateH * 0.6 * i) / (ks - 1);
      app(cuts, keyhole(0, y, 0, w.plateT, b.hole / 2));
    }
    if (d.wiring.route === 'in-wall') cuts.push(cylinder(c.cableD / 2 + 3, -1, w.plateT + 1, 24, 0, -w.plateH * 0.1));
    else cuts.push(box(-(c.cableD / 2 + 0.6), -w.plateH / 2 - 1, -1, c.cableD / 2 + 0.6, -w.plateH * 0.1, c.cableD + 1));
    // arm out of the plate (along +Z while the plate lies flat) and a holder cup looking up (+Y)
    const ay = w.plateH * 0.1, armR = w.armDiameter / 2, L = w.armLength;
    const tilt = (w.armAngle * Math.PI) / 180;
    const end: V3 = [0, ay + Math.sin(tilt) * L, w.plateT + Math.cos(tilt) * L];
    const arm = strut([0, ay, w.plateT - 1], end, armR, 32);
    const armBore = strut([0, ay, -1], end, c.bore, 16);
    const cupR = Math.max(holder.body / 2 + c.hc + 2.4, armR + 1);
    const cupH = Math.max(18, holder.length * 0.5);
    const cup = rotateX(latheTube([[cupR, c.bore, -cupH - 3], [cupR, c.bore, -cupH], [cupR, holder.body / 2 + c.hc, -cupH], [cupR, holder.body / 2 + c.hc, 0], [cupR, rh, 0], [cupR, rh, SEAT_T]], 64), -90);
    translate(cup, end[0], end[1] + cupH * 0 , end[2]);
    const cupBore = strut([end[0], end[1] - cupH - 4, end[2]], [end[0], end[1], end[2]], c.bore, 16);
    const all = merge(plate, arm, cup), allCuts = [...cuts, armBore, cupBore];
    // move the cup's shade ring onto the lamp axis at ringZ, then stand the plate on the wall
    for (const s of [all, ...allCuts]) translate(s, 0, c.ringZ - end[1] - SEAT_T, -end[2]);
    P('wall-plate', 'Backplate + arm + cup', all, { cuts: allCuts, assemblyRot: [90, 0, 0] });
    hardware.push(`${ks} × ${w.screw} wall screws + plugs`);
    notes.push('Wall lamp: the plate prints flat; the arm needs supports under the cup, or print the cup end up.');
    // shades hang on the cup: place them over the cup in the assembly
    const cupTop: V3 = [end[0], end[1] + SEAT_T, end[2]];
    for (const p of [] as BuiltPart[]) void p;
    notes.push(`Holder cup centre ${cupTop[2].toFixed(0)} mm from the wall.`);
  }

  if (d.kind === 'pendant') {
    const cp = d.canopy, R = cp.diameter / 2, H = cp.height, n = Math.max(1, cp.cluster);
    const cuts: Soup[] = [];
    const spots = Array.from({ length: n }, (_, i) => (n === 1 ? [0, 0] : [R * 0.5 * Math.cos((i / n) * tau), R * 0.5 * Math.sin((i / n) * tau)]));
    const bosses: Soup[] = [];
    for (const [x, y] of spots) {
      bosses.push(lathe([[c.cableD / 2 + 7, 0.5], [c.cableD / 2 + 3, -12]], 32, x, y));
      cuts.push(cylinder(c.cableD / 2 + 0.3, -14, 4, 24, x, y));
      cuts.push(strut([x, y, -6], [x + 20, y, -6], 1.4, 12)); // M3 grub screw, tapped into the boss
    }
    for (let i = 0; i < 2; i++) cuts.push(strut([(R - 1.2) * (i ? -1 : 1) * 1.3, 0, H - 8], [(R - 4) * (i ? -1 : 1), 0, H - 8], 1.7, 16));
    const canopy = merge(latheTube([[R, R - 2.4, 0], [R, R - 2.4, H]], 96), cylinder(R - 1.2, 0.01, 3, 96), ...bosses);
    // canopy hangs at the ceiling above the shade; built here at z = 0, moved up in the assembly
    const up = (c.ringZ ?? 0) + d.wiring.drop;
    translate(canopy, 0, 0, up); for (const k of cuts) translate(k, 0, 0, up);
    P('canopy', 'Ceiling canopy', canopy, { cuts, printRot: [0, 0, 0] });
    const plate = merge(cylinder(R - 2.8, 0, 3, 96), box(-R * 0.15, -6, 3, R * 0.15, 6, 8));
    const pcuts = [cylinder(3, -1, 9, 16, R * 0.45, 0), cylinder(3, -1, 9, 16, -R * 0.45, 0), cylinder(c.cableD / 2 + 4, -1, 9, 24), strut([R, 0, 5.5], [-R, 0, 5.5], 1.4, 12)];
    translate(plate, 0, 0, up + H - 3); for (const k of pcuts) translate(k, 0, 0, up + H - 3);
    P('canopy-plate', 'Ceiling mounting plate', plate, { cuts: pcuts });
    hardware.push('2 × M3 × 8 canopy screws', `${n} × M3 grub screw (cord grip)`, 'Ceiling screws + plugs');
    if (cp.hook || acc.ceilingHook) acc.ceilingHook = true;
    add({ key: 'ghost-cord', name: 'Cord (preview)', group: 'Preview', soup: cylinder(c.cableD / 2, 0, up, 16), material: 'Reference', color: 'Cord', hex: '#202020', ghost: true });
  }

  if (d.kind === 'ceiling') {
    const pole = d.sections.find((s) => s.role === 'pole');
    const pr = pole ? maxOuterAt(pole.shape, 1, 60) : d.pole.diameter / 2;
    const T = d.pole.jackTravel;
    const g = jointGeometry({ kind: 'thread', length: T + 10, clearance: 0.3, pitch: 3, count: 1, bolt: 'M4', magnet: 1 }, pr * 0.7, 0, pr);
    // top cap: sleeve over the pole + internal thread for the jack screw
    const cap = latheTube([[pr + 3, pr + 0.3, 0], [pr + 3, pr + 0.3, 24], [pr + 3, c.bore, 24], [pr + 3, c.bore, 27]], 64);
    const nut: Ring[] = [], nutIn: Ring[] = [];
    for (let k = 0, st = Math.ceil((T + 10) / 0.3); k <= st; k++) { const z = ((T + 10) * k) / st; nut.push(polarRing(96, 26.8 + z, () => pr + 2.9)); nutIn.push(polarRing(96, 26.8 + z, (a) => g.female(a, z))); }
    app(cap, tubeShell(nut, nutIn));
    translate(cap, 0, 0, c.stackTop - 24);
    P('jack-cap', 'Tension top cap', cap);
    const screw: Ring[] = [];
    for (let k = 0, st = Math.ceil((T + 8) / 0.3); k <= st; k++) { const z = ((T + 8) * k) / st; screw.push(polarRing(96, z, (a) => g.male(a, Math.min(z, g.maleLength)))); }
    const jack = merge(solidShell(screw), cylinder(30, T + 8, T + 14, 96), cylinder(pr + 6, T + 2, T + 9, 64));
    translate(jack, 0, 0, c.stackTop + 3);
    P('jack-screw', 'Jack screw + ceiling pad', jack, { printRot: [180, 0, 0] });
    notes.push(`Floor-to-ceiling: pole + foot + cap = ${c.stackTop.toFixed(0)} mm; the jack screw takes up ${T} mm. Room height ${d.pole.ceiling} mm.`);
    const reach = c.stackTop + 3 + T + 14;
    if (reach < d.pole.ceiling - T * 0.5) warn(`The lamp reaches ${reach.toFixed(0)} mm — ${(d.pole.ceiling - reach).toFixed(0)} mm short of the ${d.pole.ceiling} mm ceiling. Lengthen the pole.`);
    if (c.stackTop + 30 > d.pole.ceiling) warn(`The pole is taller than the ${d.pole.ceiling} mm ceiling — shorten it.`);
    // clamp-on arms
    for (let i = 0; i < d.pole.arms; i++) {
      const z = c.stackTop * (0.45 + (0.4 * i) / Math.max(1, d.pole.arms - 1 || 1));
      const half = clampHalf(pr + 0.2, 5, 22, 10);
      const holes = [strut([pr + 10, -1, 11], [pr + 10, 20, 11], 2.2, 16), strut([-pr - 10, -1, 11], [-pr - 10, 20, 11], 2.2, 16)];
      const arm = merge(half, strut([0, pr + 4, 11], [0, pr + d.pole.armLength, 11 + d.pole.armLength * 0.25], 9, 24),
        latheTube([[holder.body / 2 + c.hc + 2.4, rh, 0], [holder.body / 2 + c.hc + 2.4, rh, SEAT_T]], 64).map((v, k) => (k % 3 === 1 ? v + pr + d.pole.armLength : k % 3 === 2 ? v + 11 + d.pole.armLength * 0.25 + 6 : v)));
      const back = clampHalf(pr + 0.2, 5, 22, 10);
      rotateZ(back, 180);
      for (const s of [arm, back, ...holes]) { rotateZ(s, (i * 360) / Math.max(1, d.pole.arms)); translate(s, 0, 0, z); }
      P(`arm-${i}`, `Clamp arm ${i + 1}`, arm, { cuts: holes.map((h) => [...h]) });
      P(`arm-back-${i}`, `Clamp back ${i + 1}`, back, { cuts: holes.map((h) => [...h]) });
      hardware.push('2 × M4 × 30 bolts + nuts per arm');
    }
    const shade = d.sections.find((s) => s.attach === 'hung');
    if (shade && d.pole.arms > 1) notes.push(`Print ${d.pole.arms} × ${shade.name} — one per arm.`);
  }

  if (d.kind === 'lantern') {
    const bat = BATTERIES.find((b) => b.id === d.lantern.battery) ?? BATTERIES[0];
    const base = d.sections.find((s) => s.role === 'base');
    if (base && bat.l) {
      const inner = minInnerAt(base.shape, 0.5, 60) * 2;
      const roomH = base.shape.height - base.shape.floor;
      if (Math.hypot(bat.l, bat.w) > inner || bat.h > roomH) warn(`${bat.name} (${bat.l}×${bat.w}×${bat.h}) does not fit inside ${base.name} (Ø${inner.toFixed(0)} × ${roomH.toFixed(0)} mm).`);
      // tray that holds the battery holder flat on the floor
      const tray = merge(box(-bat.l / 2 - 2, -bat.w / 2 - 2, 0, bat.l / 2 + 2, bat.w / 2 + 2, 2), box(-bat.l / 2 - 2, -bat.w / 2 - 1.5, 1.5, -bat.l / 2, bat.w / 2 + 1.5, 8), box(bat.l / 2, -bat.w / 2 - 1.5, 1.5, bat.l / 2 + 2, bat.w / 2 + 1.5, 8));
      translate(tray, 0, 0, base.shape.floor);
      P('battery-tray', `Battery tray (${bat.name})`, tray);
      hardware.push(bat.name, d.lantern.usb ? 'USB-C charge board (TP4056)' : 'Battery contacts');
    }
    const cap = d.sections.find((s) => s.role === 'cap');
    if (cap && d.lantern.handle !== 'none') {
      const top = c.stackTop, hs = d.lantern.handleSize;
      let h: Soup;
      if (d.lantern.handle === 'bail') h = merge(arcTube(hs / 2, 3.2, 0, Math.PI, 0, top - 4, 40, 16));
      else if (d.lantern.handle === 'loop') h = rotateX(merge(arcTube(hs / 5, 3.5, 0, tau * 0.999, 0, 0, 48, 16)), 0).map((v, k) => (k % 3 === 2 ? v + top + hs / 5 : v));
      else h = merge(latheTube([[10, 3, top - 2], [10, 3, top + 12]], 32));
      P('handle', `Handle (${d.lantern.handle})`, h, { material: cap.material, color: cap.color, hex: c.hexOf(cap), printRot: d.lantern.handle === 'bail' ? [90, 0, 0] : [0, 0, 0] });
    }
  }

  if (d.kind === 'mount') {
    const m = d.mount, b = BOLTS[m.bolt], rp = m.pipe / 2 + m.shim, ro = rp + m.clampWall, earL = b.nutAF + 4;
    const head = d.sections[0];
    const holes = (y0: number) => [strut([ro + earL / 2, y0 - 1, m.clampWidth / 2], [ro + earL / 2, y0 + ro * 2, m.clampWidth / 2], b.hole / 2, 16), strut([-ro - earL / 2, y0 - 1, m.clampWidth / 2], [-ro - earL / 2, y0 + ro * 2, m.clampWidth / 2], b.hole / 2, 16)];
    if (m.style === 'strap') {
      const saddle = merge(box(-ro + 0.3, 0.1, 0, ro - 0.3, ro * 0.6, m.clampWidth), clampHalf(rp, m.clampWall, m.clampWidth, 0));
      const cut: Soup[] = [cylinder(rp, -1, m.clampWidth + 1, 64), box(-ro - 1, -ro, m.clampWidth * 0.25, ro + 1, ro * 0.4, m.clampWidth * 0.25 + 3.5), box(-ro - 1, -ro, m.clampWidth * 0.75 - 3.5, ro + 1, ro * 0.4, m.clampWidth * 0.75)];
      const sd = merge(saddle, mountArm(m, ro, head));
      cut.push(strut([0, ro + m.armLength + 7, -1], [0, ro + m.armLength + 7, m.clampWidth + 1], 2.7, 16));
      for (const x of [sd, ...cut]) translate(x, 0, -(ro + m.armLength + 14), -m.clampWidth / 2);
      P('clamp-top', 'Strap saddle', sd, { cuts: cut, assemblyRot: [90, 0, 0] });
      hardware.push('2 × zip ties or velcro straps (12 mm)');
    } else {
      const hinge = m.style === 'hinge';
      const top = merge(clampHalf(rp, m.clampWall, m.clampWidth, earL, hinge ? 'top' : 'none'), mountArm(m, ro, head));
      const bot = rotateZ(clampHalf(rp, m.clampWall, m.clampWidth, earL, hinge ? 'bottom' : 'none'), 180);
      const shift = -(ro + m.armLength + 14);
      let tc = holes(-1), bc = holes(-ro * 2 + 1);
      if (hinge) {
        // one bolt on +X; a 3 mm pin through the knuckles on −X (bottom half is turned 180°, so its knuckle is at +X before turning)
        tc = [tc[0], cylinder(1.65, -1, m.clampWidth + 1, 16, -ro - earL / 2, 0)];
        bc = [bc[0], cylinder(1.65, -1, m.clampWidth + 1, 16, -ro - earL / 2, 0)];
      }
      // nut traps on the bottom half
      bc.push(...(hinge ? [1] : [1, -1]).map((sx) => nutTrap(sx * (ro + earL / 2), -m.clampWall * 1.2, m.clampWidth / 2, b.nutAF, b.nutH)));
      tc.push(strut([0, ro + m.armLength + 7, -1], [0, ro + m.armLength + 7, m.clampWidth + 1], 2.7, 16));
      for (const s of [top, bot, ...tc, ...bc]) translate(s, 0, shift, -m.clampWidth / 2);
      P('clamp-top', m.style === 'hinge' ? 'Clamp top (hinge + arm)' : 'Clamp top + arm', top, { cuts: tc, assemblyRot: [90, 0, 0] });
      P('clamp-bottom', 'Clamp bottom', bot, { cuts: bc, assemblyRot: [90, 0, 0] });
      hardware.push(m.style === 'hinge' ? `1 × ${m.bolt} bolt + nut, 1 × 3 mm pin (hinge)` : `2 × ${m.bolt} × ${Math.ceil(ro * 2 / 5) * 5} bolts + nyloc nuts`);
      if (m.shim > 0) notes.push(`Clamp bore Ø${(rp * 2).toFixed(1)} for a Ø${m.pipe} pipe with ${m.shim} mm rubber shim each side.`);
      if (m.style === 'gopro') notes.push('GoPro-style knuckle: M5 thumb screw through the three prongs.');
    }
    hardware.push('M5 × 25 tilt bolt + nyloc nut');
    if (head && m.headBattery) {
      const bat = BATTERIES.find((x) => x.id === d.lantern.battery) ?? BATTERIES[1];
      const room = minInnerAt(head.shape, 0.5, 60) * 2;
      if (bat.l && (Math.min(bat.l, bat.w) > room || Math.max(bat.l, bat.w) > head.shape.height + room)) warn(`${bat.name} does not fit in the lamp head (Ø${room.toFixed(0)}) — choose a smaller battery or a separate pod.`);
    }
  }

  // ---------------------------------------------------------------- generic accessories
  if (acc.ceilingHook) {
    const plate = cylinder(22, 0, 5, 48);
    const hook = arcTube(14, 4, -Math.PI * 0.1, Math.PI * 1.2, 0, -18, 40, 16);
    const stem = strut([0, 0, 0], [14 * Math.cos(-Math.PI * 0.1), 0, -18 + 14 * Math.sin(-Math.PI * 0.1)], 4, 16);
    P('ceiling-hook', 'Ceiling hook', merge(plate, hook, stem), { cuts: [cylinder(2.2, -1, 6, 16, 13, 0), cylinder(2.2, -1, 6, 16, -13, 0)], printRot: [90, 0, 0] });
    hardware.push('2 × 4 mm ceiling screws (hook)');
  }
  if (acc.wallHook) {
    const plate = roundedPrism(36, 70, 8, 0, 6);
    const arm = strut([0, -10, 5], [0, -10, 45], 5, 20);
    const lip = strut([0, -10, 45], [0, 6, 52], 5, 20);
    P('wall-hook', 'Wall hook (cord / pendant swag)', merge(plate, arm, lip), { cuts: [...keyhole(0, 18, 0, 6, 2.2)], material: mat });
  }
  if (acc.sHook) P('s-hook', 'S-hook', merge(arcTube(12, 3, -Math.PI / 2, Math.PI, 0, 12, 32, 12), rotateZ(arcTube(12, 3, -Math.PI / 2, Math.PI, 0, -12, 32, 12), 180).map((v, k) => (k % 3 === 2 ? v : v))), { printRot: [90, 0, 0] });
  for (let i = 0; i < acc.cableClips; i++) {
    const cd = c.cableD;
    P(`clip-${i}`, `Cable clip ${i + 1}`, merge(box(-10, -4, 0, 10, 4, 2), latheTube([[cd / 2 + 2, cd / 2 + 0.2, 0], [cd / 2 + 2, cd / 2 + 0.2, 8]], 32).map((v, k) => (k % 3 === 2 ? v : v))), { cuts: [cylinder(1.7, -1, 3, 12, -7, 0)] });
  }
  if (acc.reducer) {
    P('reducer', 'Reducer ring (E27 gallery → E14 holder)', merge(latheTube([[20.1, 14.8, 0], [20.1, 14.8, 3]], 64), latheTube([[23, 14.8, 0], [23, 14.8, 1.2]], 64)));
  }
  void smooth; void flip; void bulbLength;
}

/** Arm from the top clamp half to the lamp head, ending in a tilt knuckle and the head cup. */
function mountArm(m: LampDesign['mount'], ro: number, head: Section | undefined): Soup {
  const L = m.armLength, out: Soup = [];
  const top: V3 = [0, ro + L, m.clampWidth / 2];
  app(out, strut([0, ro - 1, m.clampWidth / 2], top, 7, 24));
  // the arm's prongs of the tilt knuckle (the head's prongs sit between them)
  for (const [z0, z1] of knuckle(m).arm) app(out, box(-8, top[1] - 1, m.clampWidth / 2 + z0, 8, top[1] + 14, m.clampWidth / 2 + z1));
  void head;
  return out;
}
