// What a design studio hands Renex: its printed parts (geometry in print orientation and where each part
// sits in the finished product), the real hardware it needs, and the print settings that decide how the
// surfaces look. Plantex and Lumonex each provide one (see plugins/*/renexSource.ts).
import * as THREE from 'three';
import type { FinishKind } from './materials';
import type { PrintSettings } from './printSurface';
import type { RenexSource } from './profiles';

export interface SourcePart {
  key: string;
  name: string;
  /** Triangle soup in print orientation, bed at z = 0 (mm). */
  printSoup: Float32Array;
  /** Print frame → assembled product (Z up, mm). */
  assembled: THREE.Matrix4;
  /** Extra offset in the exploded view (mm). */
  exploded?: THREE.Vector3;
  hex: string;
  finish: FinishKind;
  colourName: string;
  materialName: string;
  paint?: Uint8Array;
  paintHex?: string[];
}

export interface PlanterInfo {
  kind: 'planter' | 'vase';
  /** Soil surface height and the inner radius there (assembled frame, mm). */
  soilZ: number;
  soilRadius: number;
  rimZ: number;
  rimRadius: number;
  /** Saucer floor height + inner radius (for standing water), if there is a saucer. */
  saucer?: { z: number; radius: number; depth: number };
}

export interface LampInfo {
  kind: string;
  watts: number;
  /** Bulb: lathe profile from the cap bottom, and its frame (origin at cap bottom, +Z out of the holder). */
  bulb?: { profile: [number, number][]; frame: THREE.Matrix4; base: 'screw' | 'bayonet' | 'none'; name: string };
  /** LED puck for battery lamps. */
  puck?: { diameter: number; frame: THREE.Matrix4 };
  holder?: { body: number; length: number; above: number; kind: 'screw' | 'bayonet' | 'pad'; frame: THREE.Matrix4 };
  /** Cord route in the assembled frame (mm); empty for battery lamps. */
  cord: THREE.Vector3[];
  /** Mains cord ends at a plug (table/floor) or goes into the ceiling (pendant). */
  cordEnd: 'plug' | 'ceiling' | 'wall' | 'none';
  cordDiameter: number;
  /** Floor contact for felt pads: centre + radius (mm), if the lamp stands on a surface. */
  foot?: { centre: THREE.Vector3; radius: number };
  /** The studio's own lit/unlit toggle (initial value). */
  lit: boolean;
}

export interface RenexSceneSource {
  source: RenexSource;
  title: string;
  parts: SourcePart[];
  print: PrintSettings;
  planter?: PlanterInfo;
  lamp?: LampInfo;
  warnings: string[];
}

/**
 * Rigid transform that maps `from` points onto `to` points (same order), least squares (Horn 1987,
 * quaternion method). Used to recover a part's print → assembly transform from its two vertex sets.
 */
export function rigidFit(from: ArrayLike<number>, to: ArrayLike<number>, maxPoints = 600): THREE.Matrix4 {
  const n = Math.min(from.length, to.length) / 3;
  const step = Math.max(1, Math.floor(n / maxPoints));
  const ca = new THREE.Vector3(), cb = new THREE.Vector3();
  let m = 0;
  for (let i = 0; i < n; i += step) { ca.x += from[i * 3]; ca.y += from[i * 3 + 1]; ca.z += from[i * 3 + 2]; cb.x += to[i * 3]; cb.y += to[i * 3 + 1]; cb.z += to[i * 3 + 2]; m++; }
  ca.divideScalar(m); cb.divideScalar(m);
  const S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < n; i += step) {
    const a = [from[i * 3] - ca.x, from[i * 3 + 1] - ca.y, from[i * 3 + 2] - ca.z];
    const b = [to[i * 3] - cb.x, to[i * 3 + 1] - cb.y, to[i * 3 + 2] - cb.z];
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) S[r][c] += a[r] * b[c];
  }
  const [[xx, xy, xz], [yx, yy, yz], [zx, zy, zz]] = S;
  const N = [
    [xx + yy + zz, yz - zy, zx - xz, xy - yx],
    [yz - zy, xx - yy - zz, xy + yx, zx + xz],
    [zx - xz, xy + yx, -xx + yy - zz, yz + zy],
    [xy - yx, zx + xz, yz + zy, -xx - yy + zz],
  ];
  // largest eigenvector by power iteration on a shifted matrix (shift keeps it positive definite)
  const shift = Math.abs(xx) + Math.abs(yy) + Math.abs(zz) + Math.abs(xy) + Math.abs(xz) + Math.abs(yx) + Math.abs(yz) + Math.abs(zx) + Math.abs(zy) + 1e-9;
  let q = [1, 0.01, 0.02, 0.03];
  for (let it = 0; it < 200; it++) {
    const nq = [0, 0, 0, 0];
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) nq[r] += (N[r][c] + (r === c ? shift : 0)) * q[c];
    const len = Math.hypot(...nq) || 1;
    q = nq.map((v) => v / len);
  }
  const quat = new THREE.Quaternion(q[1], q[2], q[3], q[0]).normalize();
  const rot = new THREE.Matrix4().makeRotationFromQuaternion(quat);
  const t = cb.clone().sub(ca.clone().applyQuaternion(quat));
  return rot.setPosition(t);
}

/** Lowest z of a soup and the shift that puts it on the bed. */
export function toBed(soup: Float32Array): Float32Array {
  let minZ = Infinity;
  for (let i = 2; i < soup.length; i += 3) minZ = Math.min(minZ, soup[i]);
  if (Number.isFinite(minZ) && minZ !== 0) for (let i = 2; i < soup.length; i += 3) soup[i] -= minZ;
  return soup;
}

/** Indexed mesh → triangle soup. */
export function soupOf(vertices: ArrayLike<number>, indices: ArrayLike<number>): Float32Array {
  const out = new Float32Array(indices.length * 3);
  for (let i = 0; i < indices.length; i++) { const v = indices[i] * 3; out[i * 3] = vertices[v]; out[i * 3 + 1] = vertices[v + 1]; out[i * 3 + 2] = vertices[v + 2]; }
  return out;
}
