// Exact primitives (re-tessellated on scale), wall cutters / wall shells, and Motionex lead/lag waves.
import { beforeEach, describe, expect, it } from 'vitest';
import { centreMesh } from '../src/io/load';
import { weld } from '../src/engine/mesh';
import { box } from './fixtures';
import { slice } from '../src/engine/slicer';
import { currentConfig, plateMeshes, plateObjects } from '../src/state/slicing';
import { newId, useStore, type SceneObject } from '../src/state/store';
import { addWallPart, centreOnBed, primitive, PRIMITIVE_CHORD_TOL, setPartWall, shellPrimitive } from '../src/state/ops';
import { addShape, pieces } from '../src/state/objectOps';
import { bakedWorldMesh } from '../src/state/tools';
import { layerPhase, waveValue } from '../src/plugins/motionex/modifier';
import type { MotionBrush } from '../src/plugins/motionex/model';

const S = () => useStore.getState();
function reset(...objs: SceneObject[]) {
  useStore.setState({
    printerId: 'bbl-a1', objects: objs, selected: objs.map((o) => o.id), selectedPart: null, undoStack: [], redoStack: [], activePlate: 0,
    plates: [{ id: 'plate1', name: 'Plate 1', layerActions: [] }], edgeSel: null, toast: null,
  });
}
const boxObject = (size = 20): SceneObject => {
  const mesh = primitive('box', size);
  centreMesh(mesh);
  return centreOnBed({ id: newId(), name: 'box', mesh, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], openEdges: 0 }, S().printerId);
};
/** Largest distance of any side-wall vertex mid-edge from the true circle, for a centred cylinder mesh scaled by k. */
function cylinderChordError(o: SceneObject): number {
  const v = o.mesh.vertices, k = o.scale[0], ix = o.mesh.indices;
  let r = 0;
  for (let i = 0; i < v.length; i += 3) r = Math.max(r, Math.hypot(v[i], v[i + 1]));
  let worst = 0;
  for (let t = 0; t < ix.length; t += 3) for (let e = 0; e < 3; e++) {
    const a = ix[t + e] * 3, b = ix[t + ((e + 1) % 3)] * 3;
    const ra = Math.hypot(v[a], v[a + 1]), rb = Math.hypot(v[b], v[b + 1]);
    if (Math.abs(ra - r) > 1e-4 || Math.abs(rb - r) > 1e-4) continue;
    worst = Math.max(worst, (r - Math.hypot((v[a] + v[b]) / 2, (v[a + 1] + v[b + 1]) / 2)) * k);
  }
  return worst;
}

describe('exact primitives', () => {
  beforeEach(() => reset());
  it('a scaled-up cylinder is re-tessellated so its world chord error stays under the tolerance', () => {
    addShape('cylinder');
    const id = S().objects[0].id;
    expect(S().objects[0].prim?.shape).toBe('cylinder');
    S().updateObjects((o) => ({ ...o, scale: [8, 8, 8] }), [id]);
    const o = S().objects[0];
    expect(o.prim?.tess).toBe(8);
    expect(cylinderChordError(o)).toBeLessThanOrEqual(PRIMITIVE_CHORD_TOL * 1.01);
  });
  it('an edited mesh is no longer re-made from its primitive', () => {
    addShape('sphere');
    const id = S().objects[0].id;
    S().updateObjects((o) => ({ ...o, mesh: primitive('box', 20) }), [id]);
    const before = S().objects[0].mesh;
    S().updateObjects((o) => ({ ...o, scale: [5, 5, 5] }), [id]);
    expect(S().objects[0].mesh).toBe(before);
  });
});

describe('wall cutters and wall shells', () => {
  it('a shell is the outer surface plus its exact inset, facing in', () => {
    const r = 10, w = 1.5;
    const m = shellPrimitive('cylinder', 2 * r, w);
    const v = m.vertices;
    let inner = Infinity;
    for (let t = m.innerFrom * 3; t < m.indices.length; t++) { const i = m.indices[t] * 3; inner = Math.min(inner, Math.hypot(v[i], v[i + 1]) || Infinity); }
    let innerMax = 0;
    for (let t = m.innerFrom * 3; t < m.indices.length; t++) { const i = m.indices[t] * 3; innerMax = Math.max(innerMax, Math.hypot(v[i], v[i + 1]), Math.abs(v[i + 2])); }
    expect(innerMax).toBeCloseTo(r - w, 4);
    // signed volume = outer minus inner
    let vol = 0;
    for (let t = 0; t < m.indices.length; t += 3) {
      const a = m.indices[t] * 3, b = m.indices[t + 1] * 3, c = m.indices[t + 2] * 3;
      vol += (v[a] * (v[b + 1] * v[c + 2] - v[b + 2] * v[c + 1]) - v[a + 1] * (v[b] * v[c + 2] - v[b + 2] * v[c]) + v[a + 2] * (v[b] * v[c + 1] - v[b + 1] * v[c])) / 6;
    }
    expect(vol).toBeCloseTo(Math.PI * r * r * 2 * r - Math.PI * (r - w) ** 2 * 2 * (r - w), -1);
    expect(() => shellPrimitive('sphere', 4, 3)).toThrow(/thicker/);
  });

  it('a wall cutter slices as a ring cut, not a full hole, and the bake splits the body in two', () => {
    // a 30 x 30 x 6 plate; the cutter (4 mm) is scaled 4x so a 16 mm cylinder passes right through it
    const mesh = weld(box(0, 0, 0, 30, 30, 6));
    centreMesh(mesh);
    const o = centreOnBed({ id: newId(), name: 'plate', mesh, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], openEdges: 0 }, S().printerId);
    reset(o);
    expect(addWallPart(o.id, 'cut', 'cylinder', 0.8)).toBe(true);
    S().updateObjects((x) => ({ ...x, parts: x.parts!.map((p) => ({ ...p, scale: [4, 4, 4] })) }), [o.id]);
    const obj = S().objects[0];
    const part = obj.parts![0];
    expect(part.type).toBe('negative');
    expect(part.prim?.tess).toBeCloseTo(4, 6);
    const cfg = currentConfig();
    const used = (objs: SceneObject[]) => { reset(...objs); return slice(plateMeshes(plateObjects(0), 0), cfg).stats.filamentMm; };
    const ring = used([obj]);
    const full = used([{ ...obj, parts: [{ ...part, prim: undefined, mesh: primitive('cylinder', part.prim!.size) }] }]);
    // a full hole loses the 16 mm core; the wall cutter keeps it and only removes a 0.8 mm skin
    expect(ring).toBeGreaterThan(full * 1.2);
    const baked = bakedWorldMesh(obj);
    expect(pieces(baked).length).toBe(2);
  });

  it('the wall stays true in the world when the object is scaled, and can be changed', () => {
    const o = boxObject(20);
    reset(o);
    addWallPart(o.id, 'add', 'sphere', 0.6);
    const pid = S().objects[0].parts![0].id;
    S().updateObjects((x) => ({ ...x, scale: [2, 2, 2] }), [o.id]);
    let p = S().objects[0].parts![0];
    expect(p.prim?.tess).toBeCloseTo(2, 6); // the part scales with the object: its shell is re-made so the wall stays 0.6 mm
    let rIn = 0;
    for (let t = p.prim!.innerFrom! * 3; t < p.mesh.indices.length; t++) { const i = p.mesh.indices[t] * 3; rIn = Math.max(rIn, Math.hypot(p.mesh.vertices[i], p.mesh.vertices[i + 1], p.mesh.vertices[i + 2])); }
    expect((p.prim!.size / 2 - rIn) * 2).toBeCloseTo(0.6, 3);
    setPartWall(o.id, pid, 1.2);
    p = S().objects[0].parts![0];
    expect(p.prim?.wall).toBe(1.2);
    expect(p.name).toMatch(/1\.2 mm/);
  });
});

describe('Motionex lead/lag wave', () => {
  const brush = (layers: MotionBrush['layers']) => ({ layers } as MotionBrush);
  it('wave shapes run lead → 0 → lag → 0', () => {
    for (const s of ['sine', 'triangle', 'rounded'] as const) {
      expect(waveValue(s, 0)).toBeCloseTo(0, 6);
      expect(waveValue(s, 0.25)).toBeCloseTo(1, 6);
      expect(waveValue(s, 0.75)).toBeCloseTo(-1, 6);
    }
    expect(waveValue('square', 0.1)).toBe(1);
    expect(waveValue('square', 0.6)).toBe(-1);
  });
  it('lead and lag amounts are separate', () => {
    const e = { shift_deg: 40, lag_deg: 10, mode: 'wave' as const, wave_shape: 'triangle' as const, every: 8, band_on: 0, band_off: 0 };
    expect(layerPhase(brush(e), 2)).toBeCloseTo(40, 6);
    expect(layerPhase(brush(e), 6)).toBeCloseTo(-10, 6);
  });
  it('alternate keeps its old behaviour without a lag and lags with one', () => {
    const e = { shift_deg: 180, mode: 'alternate' as const, every: 1, band_on: 0, band_off: 0 };
    expect(layerPhase(brush(e), 0)).toBe(0);
    expect(layerPhase(brush(e), 1)).toBe(180);
    expect(layerPhase(brush({ ...e, lag_deg: 30 }), 0)).toBe(-30);
  });
});

describe('wall position', () => {
  const radii = (m: ReturnType<typeof shellPrimitive>) => {
    let ro = 0, ri = 0;
    for (let t = 0; t < m.indices.length; t++) { const i = m.indices[t] * 3, d = Math.hypot(m.vertices[i], m.vertices[i + 1]); if (t < m.innerFrom * 3) ro = Math.max(ro, d); else ri = Math.max(ri, d); }
    return [ro, ri];
  };
  it('inside, centred, outside and uneven walls sit where asked', () => {
    const r = 10, w = 2;
    for (const [out, ro, ri] of [[0, 10, 8], [1, 11, 9], [2, 12, 10], [0.5, 10.5, 8.5]]) {
      const [a, b] = radii(shellPrimitive('cylinder', 2 * r, w, 1e-3, out));
      expect(a).toBeCloseTo(ro, 4); expect(b).toBeCloseTo(ri, 4);
    }
  });
});
