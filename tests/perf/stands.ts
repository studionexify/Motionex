// Synthetic "wavy stand" plate resembling a tray of holders with negative cylinder parts.
import { weld } from '../../src/engine/mesh';
import { cylinder } from '../fixtures';
import type { MeshInput } from '../../src/engine/types';

/** Closed wavy-walled shell (outer + inner skin), ~ 4*nSeg*nZ triangles. */
export function wavyShell(cx: number, cy: number, w: number, d: number, h: number, nSeg = 160, nZ = 120, wall = 2.4): Float32Array {
  const out: number[] = [];
  const ring = (z: number, grow: number) => {
    const p: number[][] = [];
    for (let i = 0; i < nSeg; i++) {
      const a = (i / nSeg) * Math.PI * 2;
      const wob = 1 + 0.05 * Math.sin(10 * a + z * 0.35) + 0.03 * Math.sin(3 * a - z * 0.1);
      p.push([cx + ((w / 2 + grow) * Math.cos(a)) * wob, cy + ((d / 2 + grow) * Math.sin(a)) * wob, z]);
    }
    return p;
  };
  const tri = (a: number[], b: number[], c: number[]) => out.push(...a, ...b, ...c);
  const outerR = Array.from({ length: nZ + 1 }, (_, k) => ring((k / nZ) * h, 0));
  const innerR = Array.from({ length: nZ + 1 }, (_, k) => ring((k / nZ) * h, -wall));
  for (let k = 0; k < nZ; k++) for (let i = 0; i < nSeg; i++) {
    const j = (i + 1) % nSeg;
    tri(outerR[k][i], outerR[k][j], outerR[k + 1][j]); tri(outerR[k][i], outerR[k + 1][j], outerR[k + 1][i]);
    tri(innerR[k][i], innerR[k + 1][j], innerR[k][j]); tri(innerR[k][i], innerR[k + 1][i], innerR[k + 1][j]);
  }
  // bottom annulus and top annulus
  for (let i = 0; i < nSeg; i++) {
    const j = (i + 1) % nSeg;
    tri(outerR[0][i], innerR[0][j], outerR[0][j]); tri(outerR[0][i], innerR[0][i], innerR[0][j]);
    tri(outerR[nZ][i], outerR[nZ][j], innerR[nZ][j]); tri(outerR[nZ][i], innerR[nZ][j], innerR[nZ][i]);
  }
  return new Float32Array(out);
}

export function standsPlate(n = 9, opts: { nSeg?: number; nZ?: number; h?: number } = {}): MeshInput[] {
  const meshes: MeshInput[] = [];
  const cols = Math.ceil(Math.sqrt(n));
  for (let k = 0; k < n; k++) {
    const cx = 30 + (k % cols) * 75, cy = 30 + Math.floor(k / cols) * 75;
    const m = weld(wavyShell(cx, cy, 68, 60, opts.h ?? 40, opts.nSeg ?? 160, opts.nZ ?? 120));
    const neg = weld(cylinder(cx, cy + 5, 14, 30, 48));
    meshes.push({
      id: `o${k}`, name: `stand ${k}`, vertices: m.vertices, indices: m.indices,
      parts: [{ type: 'negative', overrides: {}, vertices: neg.vertices, indices: neg.indices }],
    } as any);
  }
  return meshes;
}

/** Hollow holder whose wavy outline is extruded straight up (the usual stand / organiser shape): every layer is the same. */
export function extrudedHolder(cx: number, cy: number, w: number, d: number, h: number, nSeg = 720, wall = 2.4, bottom = 2): Float32Array {
  const out: number[] = [];
  const loop = (grow: number) => Array.from({ length: nSeg }, (_, i) => {
    const a = (i / nSeg) * Math.PI * 2;
    const wob = 1 + 0.06 * Math.sin(14 * a) + 0.03 * Math.sin(5 * a);
    return [cx + (w / 2 + grow) * Math.cos(a) * wob, cy + (d / 2 + grow) * Math.sin(a) * wob];
  });
  const O = loop(0), I = loop(-wall);
  const tri = (a: number[], b: number[], c: number[]) => out.push(...a, ...b, ...c);
  const P = (p: number[], z: number) => [p[0], p[1], z];
  for (let i = 0; i < nSeg; i++) {
    const j = (i + 1) % nSeg;
    tri(P(O[i], 0), P(O[j], 0), P(O[j], h)); tri(P(O[i], 0), P(O[j], h), P(O[i], h));
    tri(P(I[i], bottom), P(I[j], h), P(I[j], bottom)); tri(P(I[i], bottom), P(I[i], h), P(I[j], h));
    tri(P(O[i], h), P(O[j], h), P(I[j], h)); tri(P(O[i], h), P(I[j], h), P(I[i], h));
    // floor: fan of the outline at z=0, fan of the pocket at z=bottom
    tri([cx, cy, 0], P(O[j], 0), P(O[i], 0)); tri([cx, cy, bottom], P(I[i], bottom), P(I[j], bottom));
  }
  return new Float32Array(out);
}

export function holdersPlate(n = 9): MeshInput[] {
  const meshes: MeshInput[] = [];
  const cols = Math.ceil(Math.sqrt(n));
  for (let k = 0; k < n; k++) {
    const cx = 30 + (k % cols) * 75, cy = 30 + Math.floor(k / cols) * 75;
    const m = weld(extrudedHolder(cx, cy, 68, 60, 40));
    const neg = weld(cylinder(cx, cy + 5, 14, 30, 48));
    meshes.push({ id: `h${k}`, name: `holder ${k}`, vertices: m.vertices, indices: m.indices, parts: [{ type: 'negative', overrides: {}, vertices: neg.vertices, indices: neg.indices }] } as any);
  }
  return meshes;
}
