// Every Prepare tool, run through the store the way its button runs it: it must change the scene (one undo step,
// slice marked out of date), and what it leaves behind must slice — through the same plate → worker mapping the app
// uses — into G-code that passes the strict validator.
import { beforeEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { slice } from '../../src/engine/slicer';
import { centreMesh } from '../../src/io/load';
import { currentConfig, plateMeshes, plateObjects } from '../../src/state/slicing';
import { MIN_SCALE, newId, saneTransform, useStore, worldBounds, type SceneObject } from '../../src/state/store';
import { addPart, addHeightRange, arrange, autoOrient, layOnFace, primitive, vlhAdaptive, vlhRange, vlhReset, vlhSmooth, type ShapeKind } from '../../src/state/ops';
import { addShape, centreObjects, cloneObjects, dropObjects, mirrorObjects, setObjectFilament, splitObject, togglePrintable } from '../../src/state/objectOps';
import { applyPartsBoolean, booleanSelected, cutObject } from '../../src/state/tools';
import { bevelSelectedEdges, refineObject, remeshObject, selectCreaseEdges, smoothObject, subdivideObject } from '../../src/state/meshTools';
import { centreOnBed } from '../../src/state/ops';
import { weld } from '../../src/engine/mesh';
import { box } from '../fixtures';
import { describeIssues, validateSlice } from './gcodeValidator';

const S = () => useStore.getState();
function objectOf(shape: ShapeKind | Float32Array, name = 'obj'): SceneObject {
  const mesh = shape instanceof Float32Array ? weld(shape) : primitive(shape, 20);
  centreMesh(mesh);
  return centreOnBed({ id: newId(), name, mesh, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], openEdges: 0 }, S().printerId);
}
function reset(...objs: SceneObject[]) {
  useStore.setState({
    printerId: 'bbl-a1', objects: objs, selected: objs.map((o) => o.id), selectedPart: null, undoStack: [], redoStack: [], activePlate: 0,
    plates: [{ id: 'plate1', name: 'Plate 1', layerActions: [] }], edgeSel: null, toast: null,
    slice: { status: 'idle', stage: '', progress: 0, result: null, error: null, dirty: false, plate: 0 },
  });
}
/** Slice the active plate exactly as sliceNow builds it, and validate. */
function sliceable() {
  const objs = plateObjects(0).filter((o) => o.printable !== false);
  expect(objs.length).toBeGreaterThan(0);
  for (const o of S().objects) for (const v of [...o.position, ...o.rotation, ...o.scale]) expect(Number.isFinite(v)).toBe(true);
  const cfg = currentConfig(0);
  const out = slice(plateMeshes(objs, 0), cfg);
  const issues = validateSlice(out, cfg);
  expect(issues, describeIssues(issues)).toEqual([]);
  expect(out.stats.filamentMm).toBeGreaterThan(0);
  return out;
}
/** The tool changed the scene, recorded one undo step and marked the slice out of date. */
function changed(before: SceneObject[]) {
  expect(S().objects).not.toBe(before);
  expect(S().undoStack.length).toBeGreaterThan(0);
  expect(S().slice.dirty).toBe(true);
}
const run = (tool: () => void) => { const before = S().objects; tool(); changed(before); return sliceable(); };

beforeEach(() => reset(objectOf('box')));

describe('transforms', () => {
  it('move, rotate and scale through the store', () => {
    const id = S().objects[0].id;
    run(() => S().updateObjects((o) => ({ ...o, position: [o.position[0] + 15, o.position[1] - 10, o.position[2]] }), [id]));
    run(() => S().updateObjects((o) => ({ ...o, rotation: [33, 47, 12] }), [id]));
    dropObjects([id]);
    run(() => S().updateObjects((o) => ({ ...o, scale: [0.5, 2, 1.25] }), [id]));
    dropObjects([id]);
    sliceable();
  });
  it('a scale of 0 (typed or dragged through) is held at the minimum instead of leaving NaN geometry', () => {
    const id = S().objects[0].id;
    S().updateObjects((o) => ({ ...o, scale: [0, 1, 1] }), [id]);
    expect(S().objects[0].scale[0]).toBe(MIN_SCALE);
    // the next uniform scale used to divide by that 0
    S().updateObjects((o) => ({ ...o, scale: o.scale.map((x) => (x / o.scale[0]) * 1) as [number, number, number] }), [id]);
    for (const v of S().objects[0].scale) expect(Number.isFinite(v)).toBe(true);
  });
  it('non-finite transforms are repaired, parts included; valid objects are returned as is', () => {
    const o = S().objects[0];
    expect(saneTransform(o)).toBe(o);
    const bad = saneTransform({ ...o, position: [NaN, 1, Infinity], rotation: [0, NaN, 0], scale: [-0, NaN, -1e-9], parts: [{ id: 'p', name: 'p', type: 'modifier', mesh: o.mesh, position: [NaN, 0, 0], rotation: [0, 0, 0], scale: [0, 1, 1], overrides: {} }] } as SceneObject);
    expect(bad.position).toEqual([0, 1, 0]);
    expect(bad.rotation).toEqual([0, 0, 0]);
    expect(bad.scale).toEqual([MIN_SCALE, 1, -MIN_SCALE]);
    expect(bad.parts![0].position[0]).toBe(0);
    expect(bad.parts![0].scale[0]).toBe(MIN_SCALE);
  });
  it('a gizmo dragged past zero (negative scale) still slices', () => {
    const id = S().objects[0].id;
    S().updateObjects((o) => ({ ...o, scale: [-1, 1, 1] }), [id]);
    sliceable();
  });
  it('lay on face, auto orient, centre, drop, arrange', () => {
    const id = S().objects[0].id;
    S().updateObjects((o) => ({ ...o, rotation: [20, 10, 0] }), [id]);
    run(() => layOnFace(id, new THREE.Vector3(0, 0, -1)));
    expect(Math.abs(worldBounds(S().objects[0]).min[2])).toBeLessThan(1e-3);
    S().updateObjects((o) => ({ ...o, rotation: [40, 0, 0] }), [id]);
    run(() => autoOrient([id]));
    run(() => centreObjects([id]));
    S().updateObjects((o) => ({ ...o, position: [o.position[0], o.position[1], 12] }), [id]);
    run(() => dropObjects([id]));
    expect(Math.abs(worldBounds(S().objects[0]).min[2])).toBeLessThan(1e-3);
    S().addObjects([objectOf('cylinder', 'b'), objectOf('sphere', 'c')]);
    run(() => arrange());
  });
  it('mirror on each axis', () => {
    reset(objectOf(box(0, 0, 0, 30, 10, 5).map((v, i) => (i % 3 === 2 && v > 0 ? v + (i % 9) : v)) as Float32Array));
    for (const axis of [0, 1, 2] as const) run(() => mirrorObjects(axis));
  });
  it('undo and redo restore a sliceable scene', () => {
    const id = S().objects[0].id;
    S().updateObjects((o) => ({ ...o, scale: [2, 2, 2] }), [id]);
    S().undo();
    expect(S().objects[0].scale).toEqual([1, 1, 1]);
    S().redo();
    expect(S().objects[0].scale).toEqual([2, 2, 2]);
    dropObjects([id]);
    sliceable();
  });
});

describe('object tools', () => {
  it('every shape from the Add shape menu slices', () => {
    for (const k of ['box', 'cylinder', 'sphere', 'cone', 'disc', 'torus', 'tube', 'hemisphere', 'pyramid', 'prism', 'capsule'] as ShapeKind[]) {
      reset();
      addShape(k);
      expect(S().objects.length, k).toBe(1);
      sliceable();
    }
  });
  it('clone, split, filament, printable', () => {
    run(() => cloneObjects(2));
    expect(S().objects.length).toBe(3);
    reset(objectOf(Float32Array.from([...box(0, 0, 0, 10, 10, 10), ...box(30, 0, 0, 10, 10, 6)])));
    run(() => splitObject(S().objects[0].id));
    expect(S().objects.length).toBe(2);
    run(() => setObjectFilament(1, [S().objects[0].id]));
    togglePrintable([S().objects[0].id]);
    expect(S().objects[0].printable).toBe(false);
    sliceable();
  });
  it('cut: flat, tilted, keep one side, flip the upper part', () => {
    const id = () => S().objects[0].id;
    run(() => cutObject(id(), { height: 10, tiltX: 0, tiltY: 0, keepAbove: true, keepBelow: true, flipAbove: false }));
    expect(S().objects.length).toBe(2);
    reset(objectOf('box'));
    run(() => cutObject(id(), { height: 10, tiltX: 25, tiltY: -15, keepAbove: true, keepBelow: true, flipAbove: true }));
    reset(objectOf('box'));
    run(() => cutObject(id(), { height: 5, tiltX: 0, tiltY: 0, keepAbove: false, keepBelow: true, flipAbove: false }));
    expect(S().objects.length).toBe(1);
  });
  it('a cut plane that misses the object says so and changes nothing', () => {
    const before = S().objects;
    cutObject(S().objects[0].id, { height: 500, tiltX: 0, tiltY: 0, keepAbove: true, keepBelow: true, flipAbove: false });
    expect(S().objects).toBe(before);
    expect(S().toast?.text).toMatch(/does not cross/);
  });
  it('boolean union, difference, intersection', () => {
    for (const op of ['union', 'difference', 'intersection'] as const) {
      const a = objectOf('box', 'a'), b = objectOf('sphere', 'b');
      b.position = [a.position[0] + 8, a.position[1], a.position[2] + 4];
      reset(a, b);
      run(() => booleanSelected(op));
      expect(S().objects.length, op).toBe(1);
    }
  });
  it('boolean with one object selected explains what to do', () => {
    booleanSelected('union');
    expect(S().toast?.kind).toBe('warn');
  });
  it('parts: negative, modifier, enforcer, blocker — sliced live and applied', () => {
    const id = S().objects[0].id;
    for (const t of ['negative', 'modifier', 'support_enforcer', 'support_blocker', 'part'] as const) addPart(id, t, 'cylinder');
    expect(S().objects[0].parts!.length).toBe(5);
    sliceable();
    run(() => applyPartsBoolean([id]));
    expect(S().objects[0].parts!.every((p) => p.type !== 'negative' && p.type !== 'part')).toBe(true);
  });
});

describe('surface tools', () => {
  it('chamfer and fillet picked edges, subdivide, relax, refine, remesh', () => {
    const id = S().objects[0].id;
    selectCreaseEdges(id);
    expect(S().edgeSel?.edges.length).toBeGreaterThan(0);
    run(() => expect(bevelSelectedEdges(1, 1)).toBeNull());
    selectCreaseEdges(id);
    run(() => expect(bevelSelectedEdges(1, 3)).toBeNull());
    run(() => subdivideObject(id, { levels: 1, creaseDeg: 30 }));
    run(() => smoothObject(id, { iterations: 3, creaseDeg: 30 }));
    run(() => refineObject(id, 2));
    run(() => remeshObject(id, 2, 30));
  });
  it('bevel with nothing picked explains itself', () => {
    expect(bevelSelectedEdges(1, 1)).toMatch(/Pick some edges/);
  });
});

describe('variable layer height and height ranges', () => {
  it('adaptive, smooth, fixed range, reset, range modifier', () => {
    reset(objectOf('sphere'));
    const id = S().objects[0].id;
    run(() => vlhAdaptive(id, 0.5));
    expect(S().objects[0].layerHeights?.length).toBeGreaterThan(10);
    run(() => vlhSmooth(id, 3, false));
    run(() => vlhRange(id, 2, 8, 0.12));
    run(() => vlhReset(id));
    run(() => addHeightRange(id));
    expect(S().objects[0].heightRanges?.length).toBe(1);
  });
});
