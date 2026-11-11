// Flenex joints. Every joint is built in a local frame: the cut plane is z = 0 with the normal +z
// pointing from piece A (z < 0) into piece B (z > 0); x is across the hinge ("u") and y along its axis ("a").
//   kerf    the slab removed from the model so the two pieces separate (widening with the range of motion)
//   cutB    what is carved out of B (socket / slot)
//   addA    what is fused onto A (ball and neck, tongue, mushroom pin)
//   addB    what is fused onto B after carving (hinge pin)
// A and B never touch: the cavity is the moving part grown by the machine clearance.
import * as THREE from 'three';
import { boolean, bounds, cylinder, fromGeometry, merge, prism, sphere, sweptSlot, volume, type V3 } from './csg';
import type { IndexedMesh } from '../../engine/mesh';
import type { Fit } from './fit';

export type JointKind = 'ball' | 'hinge' | 'swivel' | 'universal' | 'chain' | 'dowel' | 'snap' | 'dovetail' | 'plain';
export type PinShape = 'round' | 'hex' | 'teardrop';

export interface JointSpec {
  kind: JointKind;
  /** Multiplies the automatic size of the head / pin (1 = automatic). */
  scale: number;
  /** Range of motion each way (°). */
  rom: number;
  /** Neck radius as a share of the ball radius (ball) or stem share (swivel). */
  neck: number;
  /** Pin cross-section of hinges and swivel stems. */
  pin: PinShape;
  /** Per-cut clearance override (mm, 0 = machine). */
  clearance: number;
  /** How deep pins and dovetails go (1 = automatic). */
  reach: number;
}

export type JointGroup = 'moving' | 'assembly';
export const JOINTS: { id: JointKind; name: string; group: JointGroup; blurb: string }[] = [
  { id: 'ball', name: 'Ball & socket', group: 'moving', blurb: 'Moves in every direction. The classic flexi joint.' },
  { id: 'hinge', name: 'Hinge', group: 'moving', blurb: 'Bends one way around a pin; stiff sideways. Alternate directions along the body.' },
  { id: 'universal', name: 'Universal (double hinge)', group: 'moving', blurb: 'Two hinges at right angles with a floating block between: bends any way, firmer than a ball.' },
  { id: 'swivel', name: 'Swivel (mushroom)', group: 'moving', blurb: 'Twists around the spine with a little tilt.' },
  { id: 'chain', name: 'Chain link', group: 'moving', blurb: 'Two interlocked rings. Needs almost no length, so pieces can be very short.' },
  { id: 'dowel', name: 'Dowel pin', group: 'assembly', blurb: 'A pin in a close-fit hole. Not a moving joint: for printing big models in parts.' },
  { id: 'snap', name: 'Snap pin', group: 'assembly', blurb: 'A barbed pin that clicks into its socket and holds.' },
  { id: 'dovetail', name: 'Dovetail slide', group: 'assembly', blurb: 'A tongue sliding into a dovetail groove. Pieces lock against pulling apart.' },
  { id: 'plain', name: 'Plain cut', group: 'assembly', blurb: 'A clean gap and nothing else: loose pieces, e.g. a detachable head or wing.' },
];

export const defaultJoint = (kind: JointKind = 'ball'): JointSpec => ({
  kind, scale: 1, rom: kind === 'hinge' || kind === 'universal' ? 30 : kind === 'chain' ? 25 : kind === 'ball' || kind === 'swivel' ? 24 : 0, neck: 0.5, pin: 'round', clearance: 0, reach: 1,
});

/** What the model looks like at the cut: found by shooting rays from the joint centre. */
export interface Probe {
  /** Distance to the wall in the cut plane: smallest and largest. */
  inr: number;
  outr: number;
  /** Distances to the surface along -normal (piece A) and +normal (piece B). */
  depthA: number;
  depthB: number;
  /** Section extent along the hinge axis (both ways, smallest). */
  extentA: number;
  inside: boolean;
}

export interface JointParts {
  kerf: IndexedMesh;
  cutB: IndexedMesh[];
  addA: IndexedMesh[];
  addB: IndexedMesh[];
  info: JointInfo;
}

export interface JointInfo {
  kind: JointKind;
  /** Head radius (ball / swivel) or pin radius (hinge), mm. */
  head: number;
  neck: number;
  /** Tilt the joint really allows, ° each way. */
  rom: number;
  /** Reach of the joint from the cut centre, along the normal into B (mm). */
  reachB: number;
  reachA: number;
  /** Radius around the centre that the joint's parts fill. */
  span: number;
  /** Where the joint pivots (local frame) and the axis it bends around (undefined: every direction). */
  pivot: V3;
  axis?: V3;
  /** Universal joints: the second pivot and axis. */
  pivot2?: V3;
  axis2?: V3;
  /** Does it move after printing? */
  moves?: boolean;
  /** Set when this joint is a ball & socket standing in for the cut type that did not fit (the type that was asked for). */
  fellBack?: JointKind;
  warnings: string[];
}

export const D2R = Math.PI / 180;
export const EMBED = 1.0;

/** Solid of revolution about z from a (r, z) profile; adds the axis points when the profile does not touch it. */
export function revolve(profile: [number, number][], seg = 28): IndexedMesh {
  const pts = profile.map(([r, z]) => new THREE.Vector2(r, z));
  if (pts[0].x > 1e-9) pts.unshift(new THREE.Vector2(0, pts[0].y));
  if (pts[pts.length - 1].x > 1e-9) pts.push(new THREE.Vector2(0, pts[pts.length - 1].y));
  const g = new THREE.LatheGeometry(pts, seg);
  g.rotateX(Math.PI / 2);
  const m = fromGeometry(g);
  if (volume(m) < 0) { const ix = m.indices.slice(); for (let i = 0; i < ix.length; i += 3) { const t = ix[i + 1]; ix[i + 1] = ix[i + 2]; ix[i + 2] = t; } m.indices = ix; }
  return m;
}

/** Closed 2D polygon in (u, z) extruded along the hinge axis y from a0 to a1. */
export function axisPrism(poly: [number, number][], a0: number, a1: number): IndexedMesh {
  const m = prism(poly, 0, a1 - a0);
  // prism gives x = u, y = z(local), extrusion = +z → map (x, y, z) to (u, a, z_local): swap y and z
  const v = m.vertices, out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i += 3) { out[i] = v[i]; out[i + 1] = v[i + 2] + a0; out[i + 2] = v[i + 1]; }
  // the swap mirrors the mesh: flip the winding back
  const ix = m.indices.slice();
  for (let i = 0; i < ix.length; i += 3) { const t = ix[i + 1]; ix[i + 1] = ix[i + 2]; ix[i + 2] = t; }
  const r = { vertices: out, indices: ix };
  if (volume(r) < 0) { for (let i = 0; i < ix.length; i += 3) { const t = ix[i + 1]; ix[i + 1] = ix[i + 2]; ix[i + 2] = t; } }
  return r;
}

const circlePoly = (cx: number, cz: number, r: number, n = 24): [number, number][] =>
  Array.from({ length: n }, (_, i) => { const a = (i / n) * Math.PI * 2; return [cx + r * Math.cos(a), cz + r * Math.sin(a)] as [number, number]; });

/** Pin outline in the (u, z) plane. teardrop points its tip along `apex` (radians in the (u, z) plane). */
export function pinPoly(cx: number, cz: number, r: number, shape: PinShape, apex = Math.PI / 2): [number, number][] {
  if (shape === 'hex') return Array.from({ length: 6 }, (_, i) => { const a = (i / 6) * Math.PI * 2 + Math.PI / 6; return [cx + r * Math.cos(a), cz + r * Math.sin(a)] as [number, number]; });
  if (shape === 'round') return circlePoly(cx, cz, r);
  // teardrop: circle with a 45° tip so a horizontal pin prints without support
  const pts: [number, number][] = [];
  const tip = r * Math.SQRT2;
  const n = 22;
  for (let i = 0; i <= n; i++) {
    const a = apex + Math.PI / 4 + (i / n) * (Math.PI * 2 - Math.PI / 2);
    pts.push([cx + r * Math.cos(a), cz + r * Math.sin(a)]);
  }
  pts.push([cx + tip * Math.cos(apex), cz + tip * Math.sin(apex)]);
  return pts;
}

/** Offset an open (r, z) polyline to its right-hand side by d, with mitred corners. */
export function offsetPolyline(pts: [number, number][], d: number): [number, number][] {
  const nrm = (a: [number, number], b: [number, number]): [number, number] => { const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1; return [dz / l, -dx / l]; };
  const out: [number, number][] = [];
  for (let i = 0; i < pts.length; i++) {
    const n1 = i > 0 ? nrm(pts[i - 1], pts[i]) : null, n2 = i < pts.length - 1 ? nrm(pts[i], pts[i + 1]) : null;
    const a = n1 ?? n2!, b = n2 ?? n1!;
    const k = d / (1 + a[0] * b[0] + a[1] * b[1]);
    out.push([pts[i][0] + (a[0] + b[0]) * k, pts[i][1] + (a[1] + b[1]) * k]);
  }
  return out;
}

/** Largest tilt (rad) at which a neck of radius rn still clears an opening of radius rho. */
function maxTilt(rn: number, rho: number, dz: number, c: number): number {
  let best = 0;
  for (let d = 0; d <= 80; d += 0.5) {
    const t = d * D2R;
    if (rn / Math.cos(t) + dz * Math.tan(t) + c <= rho) best = t; else break;
  }
  return best;
}

export interface JointContext { probe: Probe; fit: Fit; /** apex direction (radians in the (u, z) plane) for teardrop pins, or undefined when the axis is vertical */ apex?: number; radiusLimit: number }

export function buildJoint(spec: JointSpec, ctx: JointContext): JointParts {
  const { probe: P, fit } = ctx;
  const c = spec.clearance > 0 ? spec.clearance : fit.clearance;
  const g = fit.gap;
  // each face tilts by half of the bend the joint should allow, so the gap opens by tan(rom) per unit of radius
  const t = 0.5 * Math.tan(Math.min(60, Math.max(0, spec.rom)) * D2R);
  const R = ctx.radiusLimit;
  const w: string[] = [];
  const kerfProfile: [number, number][] = [[0, -g / 2], [R, -g / 2 - t * R], [R, g / 2 + t * R], [0, g / 2]];

  if (spec.kind === 'ball') {
    const maxFit = Math.min(P.inr - c - fit.wall, (P.depthB - g / 2 - c - fit.wall) / 1.52);
    let rb = Math.min(0.62 * P.inr * spec.scale, maxFit);
    // below about 8.5 × the clearance the socket opening would be wider than the ball
    const minBall = Math.max(2 * fit.minPin, 8.5 * c);
    if (rb < minBall) { w.push(`Section is too thin for a ball joint (radius ${rb.toFixed(1)} mm, needs ${minBall.toFixed(1)}); make the body thicker or cut elsewhere.`); rb = minBall; }
    const dz = 0.5 * rb, zc = g / 2 + dz;
    const rho = Math.sqrt((rb + c) ** 2 - dz ** 2);
    const rn0 = Math.min(spec.neck * rb, (rho - c - dz * t) * Math.cos(Math.atan(t)));
    const rn = Math.max(fit.minPin, rn0);
    const tilt = maxTilt(rn, rho, dz, c);
    const rom = Math.min(spec.rom, tilt / D2R);
    if (rom < spec.rom - 1) w.push(`Ball neck limits the range of motion to ${rom.toFixed(0)}° (asked ${spec.rom}°); use a bigger ball or a thinner neck.`);
    if (rho >= rb) w.push('Socket opening is wider than the ball: it would fall out.');
    // socket: the sphere grown by the clearance, from the cut plane up
    const rs = (rb + c) * 1.006, arc: [number, number][] = [[0, 0], [Math.sqrt(Math.max(0, rs * rs - zc * zc)) || 0, 0]];
    const a0 = Math.asin(Math.min(1, Math.max(-1, -zc / rs)));
    for (let i = 0; i <= 20; i++) { const a = a0 + (i / 20) * (Math.PI / 2 - a0); arc.push([rs * Math.cos(a), zc + rs * Math.sin(a)]); }
    const cavity = revolve(arc.filter((p, i) => i < 2 || p[0] > 1e-6 || i === arc.length - 1), 32);
    const head = sphere(rb, 28, [0, 0, zc]);
    const neck = cylinder(rn, rn, -g / 2 - EMBED, zc, 20);
    return {
      kerf: revolve(kerfProfile, 40), cutB: [cavity], addA: [boolean(head, neck, 'union')], addB: [],
      info: { kind: 'ball', head: rb, neck: rn, rom, reachB: zc + rb + c, reachA: EMBED, span: rs, pivot: [0, 0, zc], moves: true, warnings: w },
    };
  }

  if (spec.kind === 'swivel') {
    const maxHead = Math.min(P.inr - c - fit.wall, (P.depthB - g / 2 - 2 * fit.wall) / 2.4);
    let rh = Math.min(0.62 * P.inr * spec.scale, maxHead);
    if (rh < 2.2 * fit.minPin) { w.push(`Section is too thin for a swivel (head radius ${rh.toFixed(1)} mm).`); rh = Math.max(rh, 2.2 * fit.minPin); }
    const rs = Math.max(fit.minPin, spec.neck * 0.7 * rh);
    const lip = Math.max(fit.wall * 0.8, 1.0);
    const z0 = g / 2 + lip, half = rh - rs, zm = z0 + half, z1 = zm + half;
    const stem = cylinder(rs, rs, -g / 2 - EMBED, z0 + 0.2, 20);
    const head = revolve([[rs, z0], [rh, zm], [rs, z1], [0, z1]], 32);
    const outline = offsetPolyline([[rs, 0], [rs, z0], [rh, zm], [rs, z1], [0, z1]], c * 1.01);
    const cav = revolve([[0, 0], ...outline], 32);
    const rom = Math.min(spec.rom, Math.atan(c / Math.max(0.5, lip)) / D2R + 6);
    return {
      kerf: revolve(kerfProfile, 40), cutB: [cav], addA: [boolean(stem, head, 'union')], addB: [],
      info: { kind: 'swivel', head: rh, neck: rs, rom, reachB: z1 + c, reachA: EMBED, span: rh + c, pivot: [0, 0, zm], axis: [0, 0, 1], moves: true, warnings: w },
    };
  }

  // hinge: tongue (A) in a slot (B) around a pin (B)
  const h = hingeCore(P, spec, ctx, c, g);
  w.push(...h.warnings);
  return {
    kerf: hingeKerf(R, g, t),
    cutB: [h.slot], addA: [h.tongue], addB: [h.pin],
    info: { kind: 'hinge', head: h.rp, neck: h.T / 2, rom: spec.rom, reachB: h.slotTop, reachA: EMBED, span: Math.max(h.slotHalf, h.Ws / 2 + EMBED), pivot: [0, 0, h.zp], axis: [0, 1, 0], moves: true, warnings: w },
  };
}

export interface HingeCore { slot: IndexedMesh; tongue: IndexedMesh; pin: IndexedMesh; zp: number; rp: number; rt: number; T: number; Ws: number; slotTop: number; slotHalf: number; warnings: string[] }

/** The three parts of a hinge in its own frame (A below z = -g/2, B above z = +g/2, axis along y). */
export function hingeCore(P: Probe, spec: JointSpec, ctx: JointContext, c: number, g: number): HingeCore {
  const { fit } = ctx, w: string[] = [];
  const pinShape = spec.pin;
  let rp = Math.max(fit.minPin, 0.22 * P.inr * spec.scale);
  rp = Math.min(rp, 3.6);
  const wallPin = Math.max(1.0, fit.nozzle * 2.4);
  const rt = rp + c + wallPin;
  const zp = g / 2 + rt + c + 0.4;
  let T = Math.min(10, Math.max(3 * fit.nozzle, P.inr * 0.55 * spec.scale));
  const sideRoom = P.extentA - fit.wall;
  if (T / 2 + c > sideRoom) { T = Math.max(2 * fit.nozzle, 2 * (sideRoom - c)); w.push('Section is narrow along the hinge axis; the tongue is thinned.'); }
  if (T < 2 * fit.nozzle) w.push('Section is too narrow for a hinge here.');
  const Ws = T + 2 * c;
  const tongueOuter: [number, number][] = [[-rt, -g / 2 - EMBED], [rt, -g / 2 - EMBED], [rt, zp]];
  for (let i = 0; i <= 24; i++) { const a = (i / 24) * Math.PI; tongueOuter.push([rt * Math.cos(a), zp + rt * Math.sin(a)]); }
  tongueOuter.push([-rt, zp]);
  // the slot is whatever the tongue sweeps through over its range of motion, plus the clearance
  const slot = sweptSlot(tongueOuter, [0, zp], spec.rom, c, 0, -Ws / 2, Ws / 2);
  const sb = bounds(slot);
  const slotHalf = Math.max(Math.abs(sb.min[0]), Math.abs(sb.max[0]));
  const slotTop = sb.max[2];
  if (slotTop > P.depthB - fit.wall) w.push('Piece is shorter than the hinge slot; space the cuts further apart.');
  if (slotHalf > P.inr - fit.wall * 0.6) w.push('The hinge slot is nearly as wide as the section: lower the range of motion or thicken the body.');
  const tongueRaw = axisPrism(tongueOuter, -T / 2, T / 2);
  const hole = axisPrism(pinPoly(0, zp, rp + c, pinShape, ctx.apex), -T / 2 - 1, T / 2 + 1);
  const tongue = boolean(tongueRaw, hole, 'difference');
  const pin = axisPrism(pinPoly(0, zp, rp, pinShape, ctx.apex), -Ws / 2 - EMBED, Ws / 2 + EMBED);
  return { slot, tongue, pin, zp, rp, rt, T, Ws, slotTop, slotHalf, warnings: w };
}

/** Hinge kerf: a bow-tie in (u, z) extruded along the axis. */
export function hingeKerf(R: number, g: number, t: number): IndexedMesh {
  const poly: [number, number][] = [[-R, -g / 2 - t * R], [0, -g / 2], [R, -g / 2 - t * R], [R, g / 2 + t * R], [0, g / 2], [-R, g / 2 + t * R]];
  return axisPrism(poly, -R, R);
}
export { merge };
export type { V3 };
