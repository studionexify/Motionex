// Rotate gizmo: the angle follows the pointer exactly (polar angle around the ring centre, measured from where the drag
// began) and snaps to the tick marks drawn on the ring: 5° inside the tick band, 45° in the band just outside it.
import * as THREE from 'three';

/** Pointer radius (in ring radii) of the tick band and of the outer 45° band. */
export const TICK_BAND = { inner: 0.88, mid: 1.16, outer: 1.5 };

/** Step the pointer radius selects, in degrees (0 = free rotation). Shift always gives at least 5°. */
export function snapStepDeg(radii: number, shift: boolean): number {
  if (radii >= TICK_BAND.mid && radii <= TICK_BAND.outer) return 45;
  if (radii >= TICK_BAND.inner && radii < TICK_BAND.mid) return 5;
  return shift ? 5 : 0;
}

/** Radius of TransformControls' rotate rings in world units (its circles have radius 0.5 gizmo units; the gizmo is scaled by distance). */
export function ringRadius(camera: THREE.Camera, size: number, centre: THREE.Vector3): number {
  let factor: number;
  if ((camera as THREE.OrthographicCamera).isOrthographicCamera) {
    const c = camera as THREE.OrthographicCamera;
    factor = (c.top - c.bottom) / c.zoom;
  } else {
    const c = camera as THREE.PerspectiveCamera;
    factor = centre.distanceTo(c.position) * Math.min((1.9 * Math.tan((Math.PI * c.fov) / 360)) / c.zoom, 7);
  }
  return 0.5 * ((factor * size) / 4);
}

/** Where a pointer ray meets the plane through `centre` with normal `axis`; null when the ring is seen edge-on. */
export function planeHit(ray: THREE.Ray, centre: THREE.Vector3, axis: THREE.Vector3): THREE.Vector3 | null {
  if (Math.abs(ray.direction.dot(axis)) < 0.04) return null;
  const hit = new THREE.Vector3();
  return ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(axis, centre), hit) ? hit : null;
}

/** Signed angle (radians, counter-clockwise about `axis`) from direction `a` to direction `b`. */
export function signedAngle(a: THREE.Vector3, b: THREE.Vector3, axis: THREE.Vector3): number {
  return Math.atan2(axis.dot(new THREE.Vector3().crossVectors(a, b)), a.dot(b));
}

/** Rotation amount for a pointer at `end` having started at `start` (both relative to the centre), snapped like the tick marks. */
export function rotateAngle(start: THREE.Vector3, end: THREE.Vector3, axis: THREE.Vector3, ringR: number, shift: boolean): number {
  const raw = signedAngle(start, end, axis);
  const step = snapStepDeg(end.length() / ringR, shift);
  if (!step) return raw;
  const s = THREE.MathUtils.degToRad(step);
  return Math.round(raw / s) * s;
}

/** Orientation that puts tick 0 on the drag's start direction, ticks running counter-clockwise about `axis`. */
export function tickBasis(start: THREE.Vector3, axis: THREE.Vector3): THREE.Quaternion {
  const u = start.clone().sub(axis.clone().multiplyScalar(start.dot(axis))).normalize();
  const v = new THREE.Vector3().crossVectors(axis, u);
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(u, v, axis));
}
