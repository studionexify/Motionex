import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { meshVolume, weld } from '../src/engine/mesh';
import { useStore, worldBounds } from '../src/state/store';
import { cutObject, objectFromWorld } from '../src/state/tools';
import { DEFAULT_CONNECTOR, connectorMeshes } from '../src/state/cutConnectors';
import { flatFaces } from '../src/viewport/flatFaces';
import { box } from './fixtures';

const cubeObject = () => {
  const o = objectFromWorld('Cube', weld(box(-10, -10, 0, 20, 20, 20)));
  useStore.setState({ objects: [o], selected: [o.id] });
  return o;
};
const vols = () => useStore.getState().objects.map((o) => ({ name: o.name, v: meshVolume(o.mesh) }));

describe('cut connectors', () => {
  const opts = { height: 10, tiltX: 0, tiltY: 0, keepAbove: true, keepBelow: true, flipAbove: false };
  it('plug: the pin moves volume from the lower part to the upper part', () => {
    const o = cubeObject();
    const c = { ...DEFAULT_CONNECTOR, type: 'plug' as const, shape: 'square' as const, size: 4, depth: 5 };
    cutObject(o.id, { ...opts, connectors: [{ x: 0, y: 0 }], connector: c });
    const v = vols();
    const pin = 2 * 2 * 2 * 5; // square inscribed in the 4 mm circle (polygons are sized by their circumscribed circle)
    expect(v.find((x) => x.name.includes('upper'))!.v).toBeCloseTo(4000 + pin, -1);
    expect(v.find((x) => x.name.includes('lower'))!.v).toBeCloseTo(4000 - pin, -1);
  });
  it('dowel: sockets in both halves plus a loose dowel', () => {
    const o = cubeObject();
    const c = { ...DEFAULT_CONNECTOR, type: 'dowel' as const, shape: 'square' as const, size: 4, depth: 5 };
    cutObject(o.id, { ...opts, connectors: [{ x: -4, y: 0 }, { x: 4, y: 0 }], connector: c });
    const v = vols();
    expect(v.filter((x) => x.name.includes('dowel'))).toHaveLength(2);
    expect(v.find((x) => x.name.includes('dowel'))!.v).toBeCloseTo(8 * 10, -1);
    expect(v.find((x) => x.name.includes('upper'))!.v).toBeCloseTo(4000 - 2 * 40, -1);
    expect(v.find((x) => x.name.includes('lower'))!.v).toBeCloseTo(4000 - 2 * 40, -1);
  });
  it('tolerance widens the socket, frustum tapers the pin, snap has a bulge and a slit', () => {
    const c = { ...DEFAULT_CONNECTOR, size: 4, depth: 5, shape: 'circle' as const };
    const tight = connectorMeshes([{ x: 0, y: 0 }], c), loose = connectorMeshes([{ x: 0, y: 0 }], { ...c, tolSize: 10 });
    expect(meshVolume(loose.subLower[0])).toBeGreaterThan(meshVolume(tight.subLower[0]) * 1.15);
    const fr = connectorMeshes([{ x: 0, y: 0 }], { ...c, style: 'frustum' });
    expect(meshVolume(fr.addUpper[0])).toBeLessThan(meshVolume(tight.addUpper[0]) * 0.85);
    const sn = connectorMeshes([{ x: 0, y: 0 }], { ...c, type: 'snap' });
    expect(sn.subPin).toHaveLength(1);
    const bb = new THREE.Box3().setFromArray(Array.from(sn.addUpper[0].vertices));
    expect(bb.max.x).toBeCloseTo(2 * 1.15, 1);
    expect(bb.min.z).toBeCloseTo(-5, 1);
  });
});

describe('lay on face candidates', () => {
  it('clusters hull facets into planes, biggest first', () => {
    const f = flatFaces(box(0, 0, 0, 30, 20, 5), new THREE.Matrix4());
    expect(f).toHaveLength(6);
    expect(f[0].area).toBeCloseTo(600, 0);
    expect(Math.abs(f[0].normal.z)).toBeCloseTo(1, 5);
  });
  it('a tilted object exposes its flat faces in world space', () => {
    const m = new THREE.Matrix4().makeRotationX(0.3);
    const f = flatFaces(box(0, 0, 0, 10, 10, 10), m);
    expect(f).toHaveLength(6);
    expect(f.some((x) => Math.abs(x.normal.z) > 0.99)).toBe(false);
  });
});

describe('worldBounds sanity', () => {
  it('cube sits on the bed', () => { const o = cubeObject(); expect(worldBounds(o).min[2]).toBeCloseTo(0, 5); });
});

import { measure, pickFeature, type MeasureFeature } from '../src/state/measure';
describe('measure', () => {
  const pt = (p: [number, number, number]): MeasureFeature => ({ kind: 'point', objId: 'a', p });
  const edge = (a: [number, number, number], b: [number, number, number]): MeasureFeature => ({ kind: 'edge', objId: 'a', a, b });
  const plane = (p: [number, number, number], n: [number, number, number]): MeasureFeature => ({ kind: 'plane', objId: 'a', p, n });
  it('point to point, point to edge, point to plane', () => {
    expect(measure(pt([0, 0, 0]), pt([3, 4, 0])).distance).toBeCloseTo(5);
    expect(measure(pt([0, 5, 0]), edge([-10, 0, 0], [10, 0, 0])).distance).toBeCloseTo(5);
    expect(measure(pt([1, 2, 7]), plane([0, 0, 2], [0, 0, 1])).distance).toBeCloseTo(5);
  });
  it('parallel planes give a distance, others an angle', () => {
    const r = measure(plane([0, 0, 0], [0, 0, 1]), plane([5, 5, 12], [0, 0, -1]));
    expect(r.distance).toBeCloseTo(12); expect(r.angle).toBeCloseTo(0);
    const t = measure(plane([0, 0, 0], [0, 0, 1]), plane([0, 0, 0], [1, 0, 1].map((x) => x / Math.SQRT2) as any));
    expect(t.distance).toBeNull(); expect(t.angle).toBeCloseTo(45);
  });
  it('edges: skew distance and angle', () => {
    const r = measure(edge([0, 0, 0], [10, 0, 0]), edge([5, -5, 3], [5, 5, 3]));
    expect(r.distance).toBeCloseTo(3); expect(r.angle).toBeCloseTo(90);
  });
  it('auto picks an edge near a sharp crease, a plane on flat faces', () => {
    const tri: [THREE.Vector3, THREE.Vector3, THREE.Vector3] = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(10, 0, 0), new THREE.Vector3(0, 10, 0)];
    const n = new THREE.Vector3(0, 0, 1);
    expect(pickFeature('a', 'auto', new THREE.Vector3(5, 0.3, 0), tri, n, () => true, true).kind).toBe('edge');
    expect(pickFeature('a', 'auto', new THREE.Vector3(3, 3, 0), tri, n, () => true, true).kind).toBe('plane');
    expect(pickFeature('a', 'auto', new THREE.Vector3(3, 3, 0), tri, n, () => true, false).kind).toBe('point');
  });
});

import { embossVolume, textMesh } from '../src/state/tools';
import { objectMatrix } from '../src/state/store';
describe('emboss volumes (text / SVG as parts)', () => {
  const worldPart = () => {
    const o = useStore.getState().objects[0];
    const p = o.parts![o.parts!.length - 1];
    const m = objectMatrix(o);
    const b = new THREE.Box3();
    for (let i = 0; i < p.mesh.vertices.length; i += 3) b.expandByPoint(new THREE.Vector3().fromArray(p.mesh.vertices, i).applyMatrix4(m));
    return { p, b };
  };
  it('a part stands on the picked face, a negative part reaches into it', () => {
    const o = cubeObject();
    const shape = weld(box(-3, -1, 0, 6, 2, 1));
    embossVolume(shape, 'part', { objId: o.id, point: [0, 0, 20], normal: [0, 0, 1] }, 1.5, 'T', false);
    let { p, b } = worldPart();
    expect(p.type).toBe('part');
    expect(b.max.z).toBeCloseTo(21.5, 3);
    expect(b.min.z).toBeLessThan(20);
    embossVolume(shape, 'negative', { objId: o.id, point: [10, 0, 10], normal: [1, 0, 0] }, 2, 'N', false);
    ({ p, b } = worldPart());
    expect(p.type).toBe('negative');
    expect(b.min.x).toBeCloseTo(8, 3);
    // upright on a side face: the shape's long side (6 mm) runs horizontally
    expect(b.max.y - b.min.y).toBeCloseTo(6, 3);
  });
  it('use surface bends the shape onto a curved face', () => {
    const o = objectFromWorld('Cyl', weld(cylinderFix(0, 0, 10, 20)));
    useStore.setState({ objects: [o], selected: [o.id] });
    const shape = weld(box(-6, -1, 0, 12, 2, 1));
    embossVolume(shape, 'part', { objId: o.id, point: [10, 0, 10], normal: [1, 0, 0] }, 1, 'T', true);
    const { b } = worldPart();
    // ends follow the curve back towards the axis instead of sticking out along the tangent plane
    expect(b.min.x).toBeLessThan(9.2);
  });
  it('text meshes come out flat on z = 0..depth', async () => {
    const t = await textMesh('Hi', 'helvetiker_bold', 10, 2);
    const b = new THREE.Box3().setFromArray(Array.from(t.vertices));
    expect(b.min.z).toBeCloseTo(0); expect(b.max.z).toBeCloseTo(2);
  });
});
import { cylinder as cylinderFix } from './fixtures';

import { arrangeItems, convexHull } from '../src/engine/arrange';
describe('arrange', () => {
  const rect = (w: number, h: number): [number, number][] => [[0, 0], [w, 0], [w, h], [0, h]];
  const overlaps = (a: { x: number; y: number }, b: { x: number; y: number }, w: number, h: number, gap: number) =>
    Math.abs(a.x - b.x) < w + gap - 0.6 && Math.abs(a.y - b.y) < h + gap - 0.6;
  it('packs without overlap, keeps the spacing, centres the group', () => {
    const items = Array.from({ length: 6 }, (_, k) => ({ id: `r${k}`, hull: rect(40, 30) }));
    const res = arrangeItems(items, { x: 256, y: 256 }, { spacing: 6, rotations: [0], align: 'center', edge: 2 });
    expect(res.size).toBe(6);
    const ps = [...res.values()];
    for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) expect(overlaps(ps[i], ps[j], 40, 30, 6)).toBe(false);
    const cx = ps.reduce((a, p) => a + p.x, 0) / ps.length;
    expect(Math.abs(cx - 128)).toBeLessThan(25);
  });
  it('rotation lets a long part fit', () => {
    const res0 = arrangeItems([{ id: 'a', hull: rect(20, 240) }, { id: 'b', hull: rect(240, 20) }], { x: 256, y: 120 }, { spacing: 4, rotations: [0], align: 'center', edge: 2 });
    expect(res0.has('a')).toBe(false);
    const res1 = arrangeItems([{ id: 'a', hull: rect(20, 240) }, { id: 'b', hull: rect(240, 20) }], { x: 256, y: 120 }, { spacing: 4, rotations: [0, 90], align: 'center', edge: 2 });
    expect(res1.size).toBe(2);
    expect(res1.get('a')!.rotation).toBe(90);
  });
  it('triangles nest closer than their bounding boxes', () => {
    const tri: [number, number][] = [[0, 0], [60, 0], [0, 60]];
    // a 190 mm bed holds 9 bounding boxes of 60 mm; paired triangles hold more
    const res = arrangeItems(Array.from({ length: 12 }, (_, k) => ({ id: `t${k}`, hull: tri })), { x: 190, y: 190 }, { spacing: 2, rotations: [0, 180], align: 'center', edge: 2 });
    expect(res.size).toBe(12);
  });
  it('convex hull', () => {
    expect(convexHull([[0, 0], [2, 0], [1, 1], [2, 2], [0, 2], [1, 0.5]])).toHaveLength(4);
  });
});

import { DEFAULT_GROOVE } from '../src/state/cutConnectors';
describe('dovetail cut', () => {
  it('moves a dovetail key from the lower part onto the upper part, with a looser groove', () => {
    const o = cubeObject();
    const g = { ...DEFAULT_GROOVE, depth: 3, width: 6, flapsAngle: 60, depthTol: 0.2, widthTol: 0.2 };
    cutObject(o.id, { height: 10, tiltX: 0, tiltY: 0, keepAbove: true, keepBelow: true, flipAbove: false, groove: g });
    const objs = useStore.getState().objects;
    const up = objs.find((x) => x.name.includes('upper'))!, lo = objs.find((x) => x.name.includes('lower'))!;
    // trapezoid 6 mm at the plane, 6 + 2·3/tan60 at the bottom, 3 deep, 20 long
    const key = ((6 + (6 + (2 * 3) / Math.tan(Math.PI / 3))) / 2) * 3 * 20;
    expect(meshVolume(up.mesh)).toBeCloseTo(4000 + key, -1);
    expect(meshVolume(lo.mesh)).toBeLessThan(4000 - key);
    // the key reaches 3 mm below the cut plane
    expect(worldBounds(up).max[2] - worldBounds(up).min[2]).toBeCloseTo(13, 1);
  });
});

import { circleFeature } from '../src/state/measure';
import { booleanMeshes } from '../src/state/tools';
import { fillTriangles } from '../src/engine/brush';
describe('measure circles', () => {
  it('finds a hole edge as a circle with its centre and diameter', () => {
    const m = booleanMeshes(weld(box(0, 0, 0, 30, 30, 10)), weld(cylinderFix(15, 12, 5, 12, 64)), 'difference');
    // a triangle of the top face
    let top = -1;
    for (let t = 0; t < m.indices.length / 3 && top < 0; t++) if ([0, 1, 2].every((k) => Math.abs(m.vertices[m.indices[t * 3 + k] * 3 + 2] - 10) < 1e-4)) top = t;
    const region = fillTriangles(m, top, 1);
    const vert = (i: number) => new THREE.Vector3().fromArray(m.vertices, i * 3);
    const c = circleFeature('a', m, region, vert, new THREE.Vector3(20, 12, 10))!;
    expect(c).not.toBeNull();
    expect(c.r).toBeCloseTo(5, 1);
    expect(c.center[0]).toBeCloseTo(15, 1); expect(c.center[1]).toBeCloseTo(12, 1); expect(c.center[2]).toBeCloseTo(10, 3);
    expect(measure(c, { kind: 'point', objId: 'a', p: [15, 12, 0] }).distance).toBeCloseTo(10, 2);
  });
});
