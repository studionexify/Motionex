// More Flenex cut types, built in the same cut-plane frame as joints.ts (A below, B above, x across, y along the axis, z the normal).
//   universal  two hinges at right angles with a floating block between (three pieces)
//   chain      two interlocked rings, each on a short post
//   dowel      a pin in a close-fit hole      (assembly)
//   snap       a barbed pin that clicks home  (assembly)
//   dovetail   a tongue sliding in a groove   (assembly)
//   plain      a gap and nothing else
import * as THREE from 'three';
import { boolean, box, cylinder, fromGeometry, prism, sweptSlot, transform, volume, type V3 } from './csg';
import type { IndexedMesh } from '../../engine/mesh';
import { EMBED, axisPrism, buildJoint, defaultJoint, hingeCore, hingeKerf, offsetPolyline, pinPoly, revolve, type JointContext, type JointInfo, type JointParts, type JointSpec } from './joints';

const D2R = Math.PI / 180;
const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));

/** A slab from the A face to `zTop`, widening with radius (each face tilts by t). */
function slab(R: number, g: number, zTop: number, tl: number, tu = tl): IndexedMesh {
  return revolve([[0, -g / 2], [R, -g / 2 - tl * R], [R, zTop + tu * R], [0, zTop]], 40);
}

const info = (o: Partial<JointInfo> & { kind: JointInfo['kind'] }): JointInfo => ({ head: 0, neck: 0, rom: 0, reachA: EMBED, reachB: EMBED, span: 0, pivot: [0, 0, 0], moves: false, warnings: [], ...o });

/** A ball & socket in place of a joint that does not fit the section, with the reason recorded on the joint. */
function ballInstead(spec: JointSpec, ctx: JointContext, why: string): JointParts {
  const d = defaultJoint('ball');
  const parts = buildJoint({ ...spec, kind: 'ball', rom: Math.min(spec.rom || d.rom, 30), neck: d.neck }, ctx);
  parts.info.fellBack = spec.kind;
  parts.info.warnings.unshift(`${why} A ball & socket is used here instead.`);
  return parts;
}

export function buildExtraJoint(spec: JointSpec, ctx: JointContext): JointParts {
  const { probe: P, fit } = ctx;
  const c = spec.clearance > 0 ? spec.clearance : fit.clearance;
  const g = fit.gap, R = ctx.radiusLimit;
  const t = 0.5 * Math.tan(clamp(spec.rom, 0, 60) * D2R);
  const w: string[] = [];
  const cf = Math.max(0.12, c * 0.5); // assembly fits are tighter than moving fits

  switch (spec.kind) {
    case 'plain':
      return { kerf: slab(R, g, g / 2, 0), cutB: [], addA: [], addB: [], info: info({ kind: 'plain', reachA: 0, reachB: 0, span: 0 }) };

    case 'dowel': {
      const rpin = clamp(0.3 * P.inr * spec.scale, Math.max(1.5, fit.minPin * 1.2), Math.max(1.6, P.inr - fit.wall - cf));
      let Lb = Math.max(3 * rpin, 6) * spec.reach;
      Lb = Math.min(Lb, P.depthB - g / 2 - fit.wall - cf);
      const Le = Math.max(2, Math.min(Lb, P.depthA - fit.wall));
      if (Lb < 3) w.push('Piece is too short for a pin: space the cuts further apart.');
      const top = g / 2 + Lb;
      const pin = spec.pin === 'hex'
        ? prism(pinPoly(0, 0, rpin, 'hex'), -g / 2 - Le, top)
        : revolve([[rpin, -g / 2 - Le], [rpin, top - 0.9 * rpin], [rpin * 0.55, top]], 28);
      const socket = spec.pin === 'hex'
        ? prism(pinPoly(0, 0, rpin + cf, 'hex'), 0, top + cf)
        : revolve([[0, 0], [rpin + cf, 0], [rpin + cf, top + cf], [0, top + cf]], 28);
      return { kerf: slab(R, g, g / 2, 0), cutB: [socket], addA: [pin], addB: [], info: info({ kind: 'dowel', head: rpin, reachA: Le, reachB: top + cf, span: rpin + cf }) };
    }

    case 'snap': {
      const rs = clamp(0.2 * P.inr * spec.scale, Math.max(1.4, fit.minPin * 1.3), 4);
      const rb = rs * 1.55, hh = (rb - rs) * 0.9 + 0.8;
      const zs = g / 2 + Math.max(1.0, fit.wall * 0.8) + 2.2 * rs * spec.reach;
      const ztop = zs + hh + rs * 0.8;
      const room = P.depthB - fit.wall - cf;
      if (ztop + cf > room) w.push('Piece is shorter than the snap pin: space the cuts further apart.');
      const Le = Math.max(2, Math.min(zs + 1, P.depthA - fit.wall));
      const pin = revolve([[rs, -g / 2 - Le], [rs, zs], [rb, zs], [rb, zs + hh], [rs * 0.6, ztop], [0, ztop]], 28);
      const outline = offsetPolyline([[rs, 0], [rs, zs], [rb, zs], [rb, zs + hh], [rs * 0.6, ztop], [0, ztop]], cf);
      const cav = revolve([[0, 0], ...outline], 28);
      return { kerf: slab(R, g, g / 2, 0), cutB: [cav], addA: [pin], addB: [], info: info({ kind: 'snap', head: rb, neck: rs, reachA: Le, reachB: ztop + cf, span: rb + cf, warnings: w }) };
    }

    case 'dovetail': {
      const wn = clamp(0.26 * P.inr * spec.scale, 1.6, 9);
      const d = clamp(0.55 * P.inr * spec.reach, 3, Math.max(3, P.depthB - g / 2 - fit.wall - cf));
      const wh = wn + d * Math.tan(20 * D2R);
      if (wh + cf > P.inr - fit.wall * 0.5) w.push('The dovetail is wider than the section allows: lower the joint size.');
      const L = Math.max(4, P.extentA - 0.8);
      const prof: [number, number][] = [[-wn, -g / 2 - EMBED], [wn, -g / 2 - EMBED], [wn, g / 2], [wh, g / 2 + d], [-wh, g / 2 + d], [-wn, g / 2]];
      const tongue = axisPrism(prof, -L, L);
      // the groove runs right through B so the tongue can slide in from either side
      const groove = sweptSlot(prof.slice(2), [0, g / 2 + d / 2], 0, cf, 0, -R, R, 2);
      return { kerf: slab(R, g, g / 2, 0), cutB: [groove], addA: [tongue], addB: [], info: info({ kind: 'dovetail', head: wh, neck: wn, reachA: EMBED, reachB: g / 2 + d + cf, span: wh + cf, axis: [0, 1, 0], warnings: w }) };
    }

    case 'chain': {
      let rm = clamp(0.13 * P.inr * spec.scale, Math.max(1.2, fit.minPin * 1.2), 2.6), Rm = 2 * rm + c + 0.7;
      for (let i = 0; i < 10 && Rm + rm > P.inr - 0.8 && rm > 0.95; i++) { rm *= 0.92; Rm = 2 * rm + c + 0.7; }
      if (Rm + rm > P.inr - 0.4) return ballInstead(spec, ctx, 'The section is too thin for chain links of a printable size.');
      const p = Math.max(1.3, rm * 1.2);
      const z1 = -g / 2 + p + Rm, z2 = z1 + Rm, zB = z2 + Rm + p;
      const ring = (axis: 'y' | 'x', zc: number): IndexedMesh => {
        const geo = new THREE.TorusGeometry(Rm, rm, 14, 40);
        if (axis === 'y') geo.rotateX(Math.PI / 2); else geo.rotateY(Math.PI / 2);
        geo.translate(0, 0, zc);
        return fromGeometry(geo);
      };
      const post1 = cylinder(rm * 0.9, rm * 0.9, -g / 2 - EMBED, z1 - Rm + rm * 0.5, 16);
      const post2 = cylinder(rm * 0.9, rm * 0.9, z2 + Rm - rm * 0.5, zB + EMBED, 16);
      return {
        kerf: slab(R, g, zB, t), cutB: [], addA: [ring('y', z1), post1, ring('x', z2), post2], addB: [],
        info: info({ kind: 'chain', head: rm, neck: Rm, rom: spec.rom * 0.8, reachA: EMBED, reachB: EMBED, span: Rm + rm, pivot: [0, 0, z1 + Rm / 2], moves: true, warnings: w }),
      };
    }

    case 'universal': {
      // two hinges, A → block → B, the second turned a quarter about the normal
      let mul = 1, h1 = hingeCore({ ...P, depthB: 1e3 }, { ...spec, scale: spec.scale }, ctx, c, g), h2 = h1, Zt = 0, bx = 0, by = 0, rc = 0;
      const rcLimit = P.inr - 0.8;
      for (let i = 0; i < 9; i++) {
        const sp = { ...spec, scale: spec.scale * mul };
        h1 = hingeCore({ ...P, depthB: 1e3 }, sp, ctx, c, g);
        Zt = h1.slotTop + fit.wall;
        h2 = hingeCore({ ...P, extentA: P.inr, depthB: P.depthB - (Zt + g) }, sp, ctx, c, g);
        bx = Math.max(h1.slotHalf, h2.T / 2, h2.Ws / 2) + fit.wall;
        by = Math.max(h1.Ws / 2, h2.rt) + fit.wall;
        rc = Math.hypot(bx, by);
        if (rc <= rcLimit) break;
        mul *= 0.9;
      }
      if (rc > rcLimit) return ballInstead(spec, ctx, 'The section is too small for a universal joint.');
      const rcut = Math.min(rc, rcLimit);
      const z0b = Zt + g / 2; // frame of the second hinge: its A face is the top of the block
      const M2 = new THREE.Matrix4().makeTranslation(0, 0, z0b).multiply(new THREE.Matrix4().makeRotationZ(Math.PI / 2));
      const blockBox = transform(box(2 * bx, 2 * by, Zt - g / 2), new THREE.Matrix4().makeTranslation(0, 0, (g / 2 + Zt) / 2));
      const blockRound = boolean(blockBox, cylinder(rcut, rcut, g / 2 - 1, Zt + 1, 40), 'intersection');
      const slot2 = transform(h2.slot, M2), tongue2 = transform(h2.tongue, M2), pin2 = transform(h2.pin, M2);
      const block = boolean(boolean(blockRound, h1.slot, 'difference'), boolean(h1.pin, tongue2, 'union'), 'union');
      const Rk = R;
      const zTop = Zt + g;
      return {
        // the block between the hinges has flat faces, so both outer faces carry the whole slope
        kerf: slab(Rk, g, zTop, 2.2 * t, 2.2 * t), cutB: [slot2], addA: [h1.tongue, block], addB: [pin2],
        info: info({
          kind: 'universal', head: h1.rp, neck: h1.T / 2, rom: spec.rom, reachA: EMBED, reachB: z0b + h2.slotTop, span: Math.max(rcut, h2.slotHalf),
          pivot: [0, 0, h1.zp], axis: [0, 1, 0], pivot2: [0, 0, z0b + h2.zp], axis2: [1, 0, 0], moves: true, warnings: [...w, ...h1.warnings, ...h2.warnings],
        }),
      };
    }
    default:
      throw new Error(`Not an extra joint: ${spec.kind}`);
  }
  void volume; void hingeKerf; void (0 as unknown as V3);
}

export const EXTRA_KINDS = new Set(['universal', 'chain', 'dowel', 'snap', 'dovetail', 'plain']);
