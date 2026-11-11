import { describe, expect, it } from 'vitest';
import { primitive } from '../src/state/ops';
import { cloneObject, type SceneObject } from '../src/state/store';
import { booleanAll, booleanMeshes, bakeObjectParts } from '../src/state/tools';
import { openEdgeCount, transformVertices } from '../src/engine/mesh';
import { meshVolume } from '../src/engine/mesh';

const obj = (): SceneObject => {
  const mesh = primitive('box', 20);
  return {
    id: 'a', name: 'A', mesh, position: [0, 0, 10], rotation: [0, 0, 0], scale: [1, 1, 1], openEdges: 0,
    overrides: { wall_loops: 3 },
    parts: [
      { id: 'p1', name: 'neg', type: 'negative', mesh: primitive('cylinder', 10), position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], overrides: {} },
      { id: 'p2', name: 'mod', type: 'modifier', mesh: primitive('box', 6), position: [3, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], overrides: { sparse_infill_density: 50 } },
    ],
    heightRanges: [{ id: 'h1', z0: 0, z1: 5, overrides: { layer_height: 0.1 } }],
    paint: { support: new Uint8Array([1, 2]) },
  };
};

describe('cloneObject', () => {
  it('copies parts with fresh ids and independent data', () => {
    const a = obj();
    const c = cloneObject(a, { name: 'copy' });
    expect(c.id).not.toBe(a.id);
    expect(c.parts).toHaveLength(2);
    expect(c.parts!.map((p) => p.type)).toEqual(['negative', 'modifier']);
    for (const p of c.parts!) expect(a.parts!.some((q) => q.id === p.id)).toBe(false);
    expect(c.parts![0].mesh).toBe(a.parts![0].mesh);
    c.parts![1].overrides.sparse_infill_density = 10;
    c.position[0] = 99;
    c.paint!.support![0] = 9;
    expect(a.parts![1].overrides.sparse_infill_density).toBe(50);
    expect(a.position[0]).toBe(0);
    expect(a.paint!.support![0]).toBe(1);
    expect(c.heightRanges![0].id).not.toBe('h1');
    expect(c.overrides).toEqual({ wall_loops: 3 });
  });
});

describe('boolean with overlap', () => {
  const box = (s: number, at: [number, number, number]) => ({ vertices: transformVertices(primitive('box', s).vertices, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, ...at, 1]), indices: primitive('box', s).indices });
  it('unions several overlapping boxes into one closed solid', () => {
    const r = booleanAll([box(10, [0, 0, 0]), box(10, [5, 0, 0]), box(10, [0, 5, 0])], 'union');
    expect(openEdgeCount(r)).toBe(0);
    expect(meshVolume(r)).toBeGreaterThan(1000);
    expect(meshVolume(r)).toBeLessThan(3000);
  });
  it('subtracts several overlapping cutters', () => {
    const r = booleanAll([box(20, [0, 0, 0]), box(6, [-3, 0, 0]), box(6, [3, 0, 0])], 'difference');
    expect(openEdgeCount(r)).toBe(0);
    expect(meshVolume(r)).toBeLessThan(8000);
  });
  it('bakes negative parts into the body', () => {
    const a = obj();
    const b = bakeObjectParts(a);
    expect(b.parts!.map((p) => p.type)).toEqual(['modifier']);
    expect(meshVolume(b.mesh)).toBeLessThan(meshVolume(a.mesh));
    expect(booleanMeshes(a.mesh, a.mesh, 'union').indices.length).toBeGreaterThan(0);
  });
});
