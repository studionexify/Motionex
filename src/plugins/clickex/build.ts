// Clickex 3D build: a planned clicker (outline, switch positions, artwork) becomes printable parts.
//
//   BASE   floor · switch well · plate with the switch hole · shoulder with the housing pocket · rim
//   BUTTON top plate (rounded edge, colour inlay or relief) · skirt over the rim · boss with the cross socket
//
// Heights are measured up from the print bed with the base standing as printed; the button is built in its
// assembled place and flipped onto its face for printing. Every layer is its own closed prism (see geom.ts).
import { difference, intersection, union } from '../../engine/clipper';
import type { Paths } from '../../engine/types';
import { meshVolume } from '../../engine/mesh';
import type { Art } from './art';
import { boundsMm, circlePath, crossPaths, flipOnBed, grow, isEmpty, meshOfShells, netArea, prism, rectPath, shrink, type PartMesh, type Shell } from './geom';
import type { ClickexSpec, EdgeProfile } from './model';
import { effectiveSwitch, rimInset, pocketSize, type Plan, type Unit } from './plan';

export interface Heights {
  floor: number; plateBottom: number; plateTop: number; shoulder: number; rimTop: number;
  skirtBottom: number; ceil: number; capTop: number; bossBottom: number; stub: number;
  /** How far the stem reaches into the button's socket at rest. */
  engage: number;
  total: number;
}

export function heightsOf(spec: ClickexSpec): Heights {
  const sw = effectiveSwitch(spec), b = spec.body;
  const floor = (b.floor === 'solid' ? b.floorT : 0) + b.extraHeight;
  const well = Math.max(1, sw.belowPlate - sw.plate) + sw.pins + 0.6;
  const plateBottom = floor + well, plateTop = plateBottom + sw.plate, shoulder = plateTop + 1;
  const skirtBottom = shoulder + spec.sw.travel + 0.3;
  const rimTop = skirtBottom + 2;
  const bossBottom = plateTop + sw.housingTop + 0.3;
  const ceil = plateTop + sw.stemTop + 0.1;
  const capTop = ceil + b.capTop;
  return { floor, plateBottom, plateTop, shoulder, rimTop, skirtBottom, ceil, capTop, bossBottom, stub: Math.max(0.5, Math.min(spec.sw.travel, ceil - bossBottom)), engage: sw.stemTop - sw.housingTop - 0.3, total: capTop };
}

export interface Part {
  key: 'base' | 'button';
  name: string;
  mesh: PartMesh['mesh'];
  /** Palette index per triangle. */
  slots: Uint8Array;
  /** Colours by index (0 = the part's main colour). */
  palette: string[];
  unit?: string;
  /** Prints the way up it is built (model buttons) and needs supports under its hollow underside. */
  upright?: boolean;
  supports?: boolean;
}

export interface PlacedSwitch { cx: number; cy: number; angle: number; plateTop: number }

export interface Report {
  warnings: string[];
  fits: boolean;
  size: [number, number, number];
  baseGrams: number;
  buttonGrams: number;
  engage: number;
  minSize: number | null;
  triangles: number;
}

export interface BuiltClicker { parts: Part[]; switches: PlacedSwitch[]; heights: Heights; report: Report }

const PLA = 1.24e-3; // g per mm³

export const mapColor = (spec: ClickexSpec, hex: string) => (spec.colors.map[hex.toLowerCase()] ?? hex).toLowerCase();


/* ---------- edge profiles (button top edge, base top edge) */

/** The profile fitted to the part: no wider than maxW, no deeper than maxH (a fillet is round: width = height). */
export function clampEdge(p: EdgeProfile, maxW: number, maxH: number): EdgeProfile {
  const w = Math.max(0, Math.min(p.width, maxW)), h = Math.max(0, Math.min(p.height, maxH));
  if (p.kind === 'none' || w < 0.05 || (p.kind !== 'fillet' && h < 0.05)) return { ...p, kind: 'none', width: 0, height: 0 };
  if (p.kind === 'fillet') { const r = Math.min(w, Math.max(0, maxH)); return r < 0.05 ? { ...p, kind: 'none', width: 0, height: 0 } : { ...p, width: r, height: r }; }
  return { ...p, width: w, height: h, steps: Math.max(1, Math.min(8, Math.round(p.steps))) };
}

/** How far the outline is moved in at depth d below the top face (0 at the top, 0 below the profile). */
export function edgeInset(p: EdgeProfile, d: number): number {
  if (p.kind === 'none' || d < 0 || d >= p.height) return 0;
  if (p.kind === 'fillet') { const r = p.width, t = r - d; return r - Math.sqrt(Math.max(0, r * r - t * t)); }
  if (p.kind === 'chamfer') return p.width * (1 - d / p.height);
  const n = p.steps, i = Math.min(n - 1, Math.floor(d / (p.height / n)));
  return (p.width * (n - i)) / n;
}

/** Depths below the top where the profile changes: slab boundaries. */
export function edgeCuts(p: EdgeProfile): number[] {
  if (p.kind === 'none') return [];
  const n = p.kind === 'step' ? p.steps : p.kind === 'fillet' ? 6 : Math.max(2, Math.min(12, Math.ceil(p.height / 0.15)));
  return Array.from({ length: n + 1 }, (_, j) => (p.height * j) / n);
}

/** Splits [z0, z1] where a profile hanging down from `top` changes; returns slabs with their inset. */
function profiledSlabs(p: EdgeProfile, top: number, z0: number, z1: number, extra: number[] = []): { za: number; zb: number; e: number }[] {
  const cuts = new Set<number>([z0, z1, ...extra.filter((z) => z > z0 && z < z1)]);
  for (const c of edgeCuts(p)) { const z = top - c; if (z > z0 + 1e-9 && z < z1 - 1e-9) cuts.add(z); }
  const zs = [...cuts].sort((a, b) => a - b), out: { za: number; zb: number; e: number }[] = [];
  for (let i = 0; i + 1 < zs.length; i++) {
    const za = zs[i], zb = zs[i + 1];
    if (zb - za < 0.02) continue;
    out.push({ za, zb, e: edgeInset(p, top - (za + zb) / 2) });
  }
  return out;
}

export function baseShells(spec: ClickexSpec, plan: Plan, H: Heights): Shell[] {
  const sw = effectiveSwitch(spec), tol = spec.fit.switchTol, out: Shell[] = [];
  const { base, loop, units } = plan;
  const wells = units.map((u) => rectPath(u.cx, u.cy, sw.clipSpan + 0.2 + tol, sw.clipSpan + 0.2 + tol, u.angle));
  const holes = units.map((u) => rectPath(u.cx, u.cy, sw.cutout + tol, sw.cutout + tol, u.angle));
  const pockets = units.map((u) => rectPath(u.cx, u.cy, pocketSize(spec), pocketSize(spec), u.angle));
  const add = (paths: Paths, z0: number, z1: number, slot = 0) => out.push({ soup: prism(paths, z0, z1), slot });
  // the base's top edge profile runs down from the shoulder through every layer it reaches
  const bb = boundsMm(base);
  const edge = clampEdge(spec.body.baseEdge, 0.45 * Math.min(bb.w, bb.h), Math.max(0, H.shoulder - 0.4));
  const layer = (inner: Paths | null, z0: number, z1: number) => {
    for (const { za, zb, e } of profiledSlabs(edge, H.shoulder, z0, z1)) {
      const outer = e > 0.001 ? shrink(base, e) : base;
      add(inner ? difference(outer, inner) : outer, za, zb);
    }
  };
  if (H.floor > 0 && spec.body.floor === 'solid') layer(null, 0, H.floor);
  layer(wells, H.floor, H.plateBottom);
  layer(holes, H.plateBottom, H.plateTop);
  layer(pockets, H.plateTop, H.shoulder);
  // rim: a ring per button, inside the button's skirt; coloured like the button when the gap is hidden
  const inset = rimInset(spec);
  const rims = units.flatMap((u) => difference(shrink(u.cap, inset), shrink(u.cap, inset + spec.body.rimWall)));
  // the pocket may cut into a tight rim: drop the slivers that leaves (thinner than 0.3 mm)
  const rim = grow(shrink(difference(union(rims), pockets), 0.15), 0.15);
  add(rim, H.shoulder, H.rimTop, spec.body.hideGap ? 1 : 0);
  if (loop.length) add(loop, 0, spec.keychain.thickness);
  return out;
}

export function capShells(spec: ClickexSpec, H: Heights, u: Unit, palette: string[]): Shell[] {
  const sw = effectiveSwitch(spec), b = spec.body, c = spec.colors;
  const out: Shell[] = [];
  const add = (paths: Paths, z0: number, z1: number, slot = 0) => { if (paths.length) out.push({ soup: prism(paths, z0, z1), slot }); };
  const top = H.capTop, cb = boundsMm(u.cap);
  const edge = clampEdge(b.capEdge, 0.45 * Math.min(cb.w, cb.h), b.capTop);
  const topInset = edgeInset(edge, 0);
  const inlay = c.mode === 'raise' ? 0 : Math.min(c.inlay, b.capTop);
  const groups = u.art.map((g) => ({ slot: Math.max(0, palette.indexOf(mapColor(spec, g.color))), paths: g.paths }));
  const everything = union(groups.flatMap((g) => g.paths));

  // top plate in slabs: full outline, then the edge profile; the inlay zone is split by colour
  for (const { za, zb, e } of profiledSlabs(edge, top, H.ceil, top, inlay > 0 ? [top - inlay] : [])) {
    const zm = (za + zb) / 2;
    const outline = e > 0.001 ? shrink(u.cap, e) : u.cap;
    if (zm > top - inlay && c.mode === 'color' && groups.length) {
      const used: Paths[] = [];
      for (const g of groups) { const r = intersection(g.paths, outline); if (r.length) { add(r, za, zb, g.slot); used.push(r); } }
      add(difference(outline, union(used.flat())), za, zb, 0);
    } else if (zm > top - inlay && c.mode === 'engrave' && groups.length) {
      add(difference(outline, everything), za, zb, 0);
    } else add(outline, za, zb, 0);
  }
  if (c.mode === 'raise') {
    const face = topInset > 0.001 ? shrink(u.cap, topInset) : u.cap;
    for (const g of groups) add(intersection(g.paths, face), top, top + c.raise, g.slot);
  }
  // skirt: slides over the base's rim
  add(difference(u.cap, shrink(u.cap, b.wall)), H.skirtBottom, H.ceil);
  // boss: lower stub enters the switch housing, wider part above it; cross socket through both
  const socket = crossPaths(u.cx, u.cy, sw.armLen + spec.fit.bossTol, sw.armWid + spec.fit.bossTol, u.angle);
  const split = H.bossBottom + H.stub;
  add(difference([circlePath(u.cx, u.cy, spec.fit.bossD / 2, 40)], socket), H.bossBottom, Math.min(split, H.ceil));
  if (split < H.ceil - 0.05) add(difference([circlePath(u.cx, u.cy, spec.fit.bossD / 2 + 1.2, 40)], socket), split, H.ceil);
  return out;
}

export function paletteOf(spec: ClickexSpec, art: Art): string[] {
  const p = [spec.colors.button.toLowerCase()];
  for (const g of art) { const h = mapColor(spec, g.color); if (!p.includes(h)) p.push(h); }
  return p;
}

export function buildClicker(spec: ClickexSpec, plan: Plan): BuiltClicker {
  const H = heightsOf(spec), sw = effectiveSwitch(spec);
  const warnings = [...plan.warnings];
  if (!plan.units.length) return { parts: [], switches: [], heights: H, report: { warnings, fits: false, size: [0, 0, 0], baseGrams: 0, buttonGrams: 0, engage: H.engage, minSize: null, triangles: 0 } };

  const baseShellsList = baseShells(spec, plan, H);
  const basePalette = [spec.colors.base.toLowerCase(), spec.colors.button.toLowerCase()];
  const baseMesh = meshOfShells(baseShellsList);
  const parts: Part[] = [{ key: 'base', name: `${spec.name} base`, mesh: baseMesh.mesh, slots: baseMesh.slots, palette: basePalette }];

  let buttonVol = 0, tris = baseMesh.mesh.indices.length / 3;
  plan.units.forEach((u, i) => {
    const palette = paletteOf(spec, u.art);
    const m = meshOfShells(capShells(spec, H, u, palette));
    buttonVol += meshVolume(m.mesh);
    tris += m.mesh.indices.length / 3;
    parts.push({ key: 'button', name: plan.units.length > 1 ? `${spec.name} key ${i + 1}${u.label && u.label.trim() ? ` (${u.label})` : ''}` : `${spec.name} button`, mesh: m.mesh, slots: m.slots, palette, unit: u.id });
  });

  // checks that matter on the printer
  const tight = plan.units.some((u) => !isEmpty(difference([rectPath(u.cx, u.cy, pocketSize(spec), pocketSize(spec), u.angle)], shrink(u.cap, rimInset(spec) + spec.body.rimWall))));
  if (tight) warnings.push('The switch pocket cuts into the rim, so the gap under the button will look open. Make the base a little larger or reduce Wall.');
  const wallSock = (spec.fit.bossD - (sw.armLen + spec.fit.bossTol)) / 2;
  if (wallSock < 0.55) warnings.push(`Socket wall is only ${wallSock.toFixed(2)} mm: raise Boss diameter in Fit (up to about 5.6 mm) or print with a 0.2 mm nozzle.`);
  if (spec.sw.travel < 2.2) warnings.push(`Button travel ${spec.sw.travel} mm is below the switch's click point (about 2 mm plus margin). Raise Travel in Switch.`);
  if (spec.sw.travel > sw.housingTop - 2) warnings.push('Long travel: the boss may bottom out before the skirt does. Check the fit test.');
  if (spec.body.wall < 0.8) warnings.push('Button wall under 0.8 mm may print as a single thin line.');
  if (spec.body.plate < 1.2 || spec.body.plate > 2) warnings.push(`Plate thickness ${spec.body.plate} mm: MX clips hold best between 1.2 and 2 mm.`);

  const bb = [plan.size[0], plan.size[1]] as const;
  const report: Report = {
    warnings, fits: plan.fits, size: [+bb[0].toFixed(1), +bb[1].toFixed(1), +H.total.toFixed(1) + (spec.colors.mode === 'raise' ? spec.colors.raise : 0)],
    baseGrams: +(meshVolume(baseMesh.mesh) * PLA).toFixed(1), buttonGrams: +(buttonVol * PLA).toFixed(1), engage: +H.engage.toFixed(1), minSize: plan.minSize, triangles: tris,
  };
  return { parts, switches: plan.units.map((u) => ({ cx: u.cx, cy: u.cy, angle: u.angle, plateTop: H.plateTop })), heights: H, report };
}

/** Parts in print orientation: the base as built, every button upside down on its face. */
export function printParts(b: BuiltClicker): Part[] {
  return b.parts.map((p) => {
    if (p.key !== 'button' || p.upright) return p;
    const f = flipOnBed({ mesh: p.mesh, slots: p.slots });
    return { ...p, mesh: f.mesh, slots: f.slots };
  });
}

export { grow, netArea };
