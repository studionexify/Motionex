import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { planeHit, ringRadius, rotateAngle, snapStepDeg, tickBasis } from '../src/viewport/rotateSnap';

const Z = new THREE.Vector3(0, 0, 1);
const at = (deg: number, r = 1) => new THREE.Vector3(Math.cos((deg * Math.PI) / 180) * r, Math.sin((deg * Math.PI) / 180) * r, 0);
const deg = (rad: number) => (rad * 180) / Math.PI;

describe('rotate gizmo snapping', () => {
  it('follows the pointer angle exactly (free band)', () => {
    expect(deg(rotateAngle(at(10), at(53.7, 0.5), Z, 1, false))).toBeCloseTo(43.7, 6);
    expect(deg(rotateAngle(at(10, 3), at(-20, 3), Z, 1, false))).toBeCloseTo(-30, 6);
  });
  it('snaps to 5° inside the tick band, relative to the drag start', () => {
    expect(deg(rotateAngle(at(10), at(10 + 43.7, 1.05), Z, 1, false))).toBeCloseTo(45, 6);
    expect(deg(rotateAngle(at(10), at(10 + 41.2, 1.0), Z, 1, false))).toBeCloseTo(40, 6);
  });
  it('snaps to 45° just outside the tick band, and Shift gives 5° anywhere', () => {
    expect(deg(rotateAngle(at(0), at(61, 1.3), Z, 1, false))).toBeCloseTo(45, 6);
    expect(deg(rotateAngle(at(0), at(70, 1.3), Z, 1, false))).toBeCloseTo(90, 6);
    expect(deg(rotateAngle(at(0), at(33, 2.5), Z, 1, true))).toBeCloseTo(35, 6);
    expect(snapStepDeg(2.5, false)).toBe(0);
  });
  it('the ring radius matches the TransformControls rings (0.5 · factor · size / 4)', () => {
    const cam = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
    cam.position.set(0, -100, 0); cam.updateMatrixWorld();
    const centre = new THREE.Vector3(0, 0, 0);
    const factor = 100 * (1.9 * Math.tan((Math.PI * 45) / 360));
    expect(ringRadius(cam, 0.85, centre)).toBeCloseTo(0.5 * (factor * 0.85) / 4, 9);
  });
  it('plane hits are rejected edge-on, and tick 0 lies on the start direction', () => {
    const edge = new THREE.Ray(new THREE.Vector3(5, 5, 0), new THREE.Vector3(1, 0, 0.001).normalize());
    expect(planeHit(edge, new THREE.Vector3(), Z)).toBeNull();
    const down = new THREE.Ray(new THREE.Vector3(3, 4, 10), new THREE.Vector3(0, 0, -1));
    expect(planeHit(down, new THREE.Vector3(), Z)!.toArray()).toEqual([3, 4, 0]);
    const start = at(37);
    const q = tickBasis(start, Z);
    const tick0 = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
    expect(tick0.angleTo(start)).toBeCloseTo(0, 9);
    const tick90 = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    expect(deg(Math.atan2(tick90.y, tick90.x))).toBeCloseTo(127, 6);
  });
});
