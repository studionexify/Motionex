import fs from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { openEdgeCount, weld, type IndexedMesh } from '../src/engine/mesh';
import { bevelEdges, refineMesh, remeshEven, subdivide, type EdgePair } from '../src/engine/meshedit';
import { buildTopology, EDGE_SHARP } from '../src/engine/topology';
import { smoothPaths } from '../src/engine/outlineSmooth';
import { SCALE } from '../src/engine/clipper';
import { slice } from '../src/engine/slicer';
import { resolveConfig } from '../src/profiles/resolve';
import { primitive } from '../src/state/ops';

const volume = (m: IndexedMesh) => {
  const v = m.vertices, ix = m.indices;
  let s = 0;
  for (let t = 0; t < ix.length; t += 3) {
    const a = ix[t] * 3, b = ix[t + 1] * 3, c = ix[t + 2] * 3;
    s += v[a] * (v[b + 1] * v[c + 2] - v[b + 2] * v[c + 1]) - v[a + 1] * (v[b] * v[c + 2] - v[b + 2] * v[c]) + v[a + 2] * (v[b] * v[c + 1] - v[b + 1] * v[c]);
  }
  return s / 6;
};
const oriented = (m: IndexedMesh) => {
  const d = new Map<string, number>();
  for (let t = 0; t < m.indices.length; t += 3) for (let k = 0; k < 3; k++) {
    const key = `${m.indices[t + k]}_${m.indices[t + ((k + 1) % 3)]}`;
    d.set(key, (d.get(key) ?? 0) + 1);
  }
  for (const [key, c] of d) { const [a, b] = key.split('_'); if (c !== 1 || d.get(`${b}_${a}`) !== 1) return false; }
  return true;
};

describe('even remeshing', () => {
  it('evens a heavily split cube: closed, same volume, creases kept, fewer triangles', () => {
    const cube = primitive('box', 20);
    const fine = refineMesh(cube, 1.5).mesh; // many small triangles
    const r = remeshEven(fine, 4, { creaseDeg: 40 });
    expect(r.collapses).toBeGreaterThan(0);
    expect(r.mesh.indices.length).toBeLessThan(fine.indices.length);
    expect(openEdgeCount(r.mesh)).toBe(0);
    expect(oriented(r.mesh)).toBe(true);
    expect(volume(r.mesh)).toBeCloseTo(8000, 0);
    const t = buildTopology(r.mesh, 40);
    expect(Array.from(t.kind).filter((k) => k === EDGE_SHARP).length).toBeGreaterThanOrEqual(12);
    expect(r.triSource.length).toBe(r.mesh.indices.length / 3);
  });
  it('evens a sphere and stays closed', () => {
    const s = primitive('sphere', 20);
    const r = remeshEven(s, 2.5, { creaseDeg: 60 });
    expect(openEdgeCount(r.mesh)).toBe(0);
    expect(oriented(r.mesh)).toBe(true);
    expect(Math.abs(volume(r.mesh) - volume(s)) / volume(s)).toBeLessThan(0.15);
  });
});

describe('outline smoothing', () => {
  it('calms a noisy circle and keeps the corners of a square', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5);
    const noisy = Array.from({ length: 120 }, (_, i) => {
      const r = 10 + rnd() * 0.6, a = (2 * Math.PI * i) / 120;
      return { X: Math.round(r * Math.cos(a) * SCALE), Y: Math.round(r * Math.sin(a) * SCALE) };
    });
    const dev = (p: { X: number; Y: number }[]) => { const r = p.map((q) => Math.hypot(q.X, q.Y) / SCALE); const m = r.reduce((a, b) => a + b, 0) / r.length; return Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / r.length); };
    const sm = smoothPaths([noisy], 2, 35)[0];
    expect(dev(sm)).toBeLessThan(dev(noisy) * 0.6);
    expect(Math.abs(sm.reduce((a, q) => a + Math.hypot(q.X, q.Y) / SCALE, 0) / sm.length - 10)).toBeLessThan(0.1); // little shrink
    const sq = [{ X: 0, Y: 0 }, { X: 10 * SCALE, Y: 0 }, { X: 10 * SCALE, Y: 10 * SCALE }, { X: 0, Y: 10 * SCALE }];
    const ss = smoothPaths([sq], 1, 35)[0];
    for (const c of sq) expect(ss.some((p) => p.X === c.X && p.Y === c.Y)).toBe(true);
  });
  it('is off by default and changes the sliced walls when enabled', () => {
    const cyl = primitive('cylinder', 20); // 48 segments
    const mesh = (m: IndexedMesh) => ({ id: 'p', name: 'p', vertices: m.vertices.map((v, i) => (i % 3 === 2 ? v + 10 : v)), indices: m.indices });
    const cfg = (o = {}) => resolveConfig({ printerId: 'bbl-p1s', plate: 'textured_pei_plate', filamentId: 'generic-pla', presetId: '0.20', overrides: o, machineOverrides: {}, filamentOverrides: {} });
    const a = slice([mesh(cyl)], cfg()).gcode;
    const b = slice([mesh(cyl)], cfg({ outline_smoothing: 0 })).gcode;
    const c = slice([mesh(cyl)], cfg({ outline_smoothing: 0.5 })).gcode;
    expect(b).toBe(a);
    expect(c).not.toBe(a);
  }, 60000);
});

describe('CAD import mesh', () => {
  const file = 'node_modules/occt-import-js/test/testfiles/rounded-cube/rounded-cube.step';
  it.skipIf(!fs.existsSync(file))('keeps B-rep faces so face boundaries are sharp edges', async () => {
    const occt = await (createRequire(import.meta.url)('occt-import-js') as () => Promise<any>)();
    const res = occt.ReadStepFile(new Uint8Array(fs.readFileSync(file)), { linearUnit: 'millimeter', linearDeflectionType: 'bounding_box_ratio', linearDeflection: 0.002, angularDeflection: 0.1 });
    expect(res.success).toBe(true);
    const m = res.meshes[0];
    const idx: number[] = m.index.array, pos: number[] = m.attributes.position.array;
    const faces = new Uint32Array(idx.length / 3);
    m.brep_faces.forEach((f: { first: number; last: number }, k: number) => faces.fill(k, f.first, f.last + 1));
    const soup = new Float32Array(idx.length * 3);
    idx.forEach((i, k) => { soup[k * 3] = pos[i * 3]; soup[k * 3 + 1] = pos[i * 3 + 1]; soup[k * 3 + 2] = pos[i * 3 + 2]; });
    const mesh = weld(soup, 1e-5, faces);
    mesh.groupKind = 'cad';
    expect(new Set(mesh.faceGroups).size).toBeGreaterThan(6);
    expect(openEdgeCount(mesh)).toBe(0);
    const cad = buildTopology(mesh, 89);
    // every boundary between two CAD faces that bends at all is an edge, even above the crease angle
    let boundaries = 0;
    for (let e = 0; e < cad.edgeCount; e++) {
      const a = cad.edgeTris[e * 2], b = cad.edgeTris[e * 2 + 1];
      if (a >= 0 && b >= 0 && mesh.faceGroups![a] !== mesh.faceGroups![b] && cad.dihedral[e] >= 2) { boundaries++; expect(cad.kind[e]).toBe(EDGE_SHARP); }
    }
    expect(boundaries).toBeGreaterThan(0);
    // the edges of a CAD face can be bevelled
    const t = buildTopology(mesh, 30);
    const pairs: EdgePair[] = [];
    for (let e = 0; e < t.edgeCount; e++) if (t.kind[e] === EDGE_SHARP) pairs.push([t.edgeV[e * 2], t.edgeV[e * 2 + 1]]);
    const r = bevelEdges(mesh, pairs, 0.3, 3);
    if (r) { expect(openEdgeCount(r.mesh)).toBe(0); expect(r.mesh.groupKind).toBe('cad'); }
    // CAD meshes subdivide with Loop, not as quads
    expect(subdivide(mesh, { levels: 1 }).mesh.indices.length).toBe(mesh.indices.length * 4);
  }, 60000);
});
