import { describe, expect, it } from 'vitest';
import { meshVolume, openEdgeCount, type IndexedMesh } from '../src/engine/mesh';
import { repairMesh } from '../src/engine/repair';

const CUBE_V = [0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0, 0, 0, 10, 10, 0, 10, 10, 10, 10, 0, 10, 10];
// outward-wound cube, 12 triangles (2 per face)
const CUBE_I = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
const mk = (v: number[], i: number[]): IndexedMesh => ({ vertices: new Float32Array(v), indices: new Uint32Array(i) });
const oriented = (m: IndexedMesh) => {
  const d = new Set<string>();
  for (let t = 0; t < m.indices.length; t += 3) for (let k = 0; k < 3; k++) {
    const key = `${m.indices[t + k]}_${m.indices[t + (k + 1) % 3]}`;
    if (d.has(key)) return false;
    d.add(key);
  }
  for (const k of d) { const [a, b] = k.split('_'); if (!d.has(`${b}_${a}`)) return false; }
  return true;
};

function cylinder(seg: number, r: number, h: number): IndexedMesh {
  const v: number[] = [], ix: number[] = [];
  for (let i = 0; i < seg; i++) { const a = (i / seg) * Math.PI * 2; v.push(r * Math.cos(a), r * Math.sin(a), 0, r * Math.cos(a), r * Math.sin(a), h); }
  for (let i = 0; i < seg; i++) { const j = (i + 1) % seg; ix.push(2 * i, 2 * j, 2 * j + 1, 2 * i, 2 * j + 1, 2 * i + 1); }
  return mk(v, ix);
}

describe('repairMesh', () => {
  it('closes a cube with a missing face', () => {
    const r = repairMesh(mk(CUBE_V, CUBE_I.slice(0, 30)));
    expect(r.report.openEdgesBefore).toBe(4);
    expect(openEdgeCount(r.mesh)).toBe(0);
    expect(r.report.holesFilled).toBe(1);
    expect(meshVolume(r.mesh)).toBeCloseTo(1000, 1);
    expect(oriented(r.mesh)).toBe(true);
    expect(r.triSource.length).toBe(r.mesh.indices.length / 3);
  });
  it('makes winding consistent and outward', () => {
    const i = CUBE_I.slice();
    for (const t of [1, 4, 7]) { const x = i[t * 3 + 1]; i[t * 3 + 1] = i[t * 3 + 2]; i[t * 3 + 2] = x; }
    const r = repairMesh(mk(CUBE_V, i));
    expect(oriented(r.mesh)).toBe(true);
    expect(meshVolume(r.mesh)).toBeCloseTo(1000, 1);
    expect(r.report.flipped).toBeGreaterThan(0);
    // fully inverted cube gets turned outward
    const inv = CUBE_I.slice();
    for (let t = 0; t < 12; t++) { const x = inv[t * 3 + 1]; inv[t * 3 + 1] = inv[t * 3 + 2]; inv[t * 3 + 2] = x; }
    expect(meshVolume(repairMesh(mk(CUBE_V, inv)).mesh)).toBeCloseTo(1000, 1);
  });
  it('welds duplicate vertices (triangle soup)', () => {
    const v: number[] = [], ix: number[] = [];
    for (let k = 0; k < CUBE_I.length; k++) { const j = CUBE_I[k]; v.push(CUBE_V[j * 3] + 1e-7, CUBE_V[j * 3 + 1], CUBE_V[j * 3 + 2]); ix.push(k); }
    const m = mk(v, ix);
    expect(openEdgeCount(m)).toBe(36);
    const r = repairMesh(m);
    expect(r.report.weldedVerts).toBe(36 - 8);
    expect(r.mesh.vertices.length / 3).toBe(8);
    expect(openEdgeCount(r.mesh)).toBe(0);
    expect(r.report.holesFilled).toBe(0);
  });
  it('removes degenerate and duplicate triangles', () => {
    const r = repairMesh(mk(CUBE_V, [...CUBE_I, 0, 0, 1, 0, 1, 1, ...CUBE_I.slice(0, 3)]));
    expect(r.report.removedDegenerate).toBe(2);
    expect(r.report.removedDuplicate).toBe(1);
    expect(r.mesh.indices.length).toBe(36);
    expect(openEdgeCount(r.mesh)).toBe(0);
  });
  it('closes an open cylinder (vase with open top and bottom)', () => {
    const m = cylinder(48, 20, 50);
    expect(openEdgeCount(m)).toBe(96);
    const r = repairMesh(m);
    expect(r.report.holesFilled).toBe(2);
    expect(r.report.openEdgesAfter).toBe(0);
    expect(oriented(r.mesh)).toBe(true);
    const ideal = 0.5 * 48 * 20 * 20 * Math.sin((2 * Math.PI) / 48) * 50;
    expect(meshVolume(r.mesh)).toBeCloseTo(ideal, 0);
  });
  it('does not throw on garbage', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let n = 0; n < 30; n++) {
      const nv = 1 + Math.floor(rnd() * 40);
      const v = Array.from({ length: nv * 3 }, () => (rnd() < 0.03 ? NaN : Math.floor(rnd() * 6)));
      const ix = Array.from({ length: Math.floor(rnd() * 60) * 3 }, () => Math.floor(rnd() * (nv + 3)));
      const r = repairMesh(mk(v, ix));
      expect(r.triSource.length).toBe(r.mesh.indices.length / 3);
      for (const i of r.mesh.indices) expect(i).toBeLessThan(r.mesh.vertices.length / 3);
    }
    expect(() => repairMesh(mk([], []))).not.toThrow();
  });
});
