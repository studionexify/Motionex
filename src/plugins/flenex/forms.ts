// Flenex form helpers: closed solids from a few parameters (ellipsoids, cones, tubes along a path,
// flat blades). All return outward-facing indexed meshes in millimetres, ready for the boolean kernel.
import * as THREE from 'three';
import type { IndexedMesh } from '../../engine/mesh';
import { loft, prism, sphere, transform, type V3 } from './csg';

const v = (a: V3) => new THREE.Vector3(a[0], a[1], a[2]);

/** Ellipsoid with semi-axes r at c, optionally turned by a quaternion. */
export function ellipsoid(c: V3, r: V3, seg = 20, q?: THREE.Quaternion): IndexedMesh {
  const m = sphere(1, seg, [0, 0, 0], r[0], r[1], r[2]);
  const M = new THREE.Matrix4().compose(v(c), q ?? new THREE.Quaternion(), new THREE.Vector3(1, 1, 1));
  return transform(m, M);
}

/** A circle of n points of radius r around centre c in the plane spanned by unit vectors a, b. */
function circle(c: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3, r: number, n: number): V3[] {
  return Array.from({ length: n }, (_, i) => {
    const t = (i / n) * Math.PI * 2, p = c.clone().addScaledVector(a, Math.cos(t) * r).addScaledVector(b, Math.sin(t) * r);
    return [p.x, p.y, p.z] as V3;
  });
}

/** Round tube along a path with a radius at every point (parallel-transport frames). Ends are closed. */
export function tube(path: V3[], radii: number[], seg = 14): IndexedMesh {
  const pts = path.map(v);
  const T = pts.map((p, i) => (pts[Math.min(pts.length - 1, i + 1)].clone().sub(pts[Math.max(0, i - 1)])).normalize());
  let n0 = Math.abs(T[0].z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
  let a = new THREE.Vector3().crossVectors(T[0], n0).normalize();
  const rings: V3[][] = [];
  for (let i = 0; i < pts.length; i++) {
    if (i > 0) {
      // rotate the frame with the path so it never twists
      const axis = new THREE.Vector3().crossVectors(T[i - 1], T[i]);
      if (axis.lengthSq() > 1e-12) a.applyAxisAngle(axis.normalize(), Math.acos(Math.min(1, Math.max(-1, T[i - 1].dot(T[i])))));
    }
    const b = new THREE.Vector3().crossVectors(T[i], a).normalize();
    rings.push(circle(pts[i], a, b, Math.max(0.05, radii[i]), seg));
  }
  return loft(rings);
}

/** Cone (or frustum) from base point to tip with base radius r0 and tip radius r1. */
export function cone(base: V3, tip: V3, r0: number, r1 = 0.15, seg = 14): IndexedMesh {
  return tube([base, tip], [r0, Math.max(0.05, r1)], seg);
}

/**
 * A flat blade: a 2D outline in the plane of unit vectors ex, ey at origin, thickened along ex × ey
 * (centred on the plane). The outline is closed automatically.
 */
export function blade(outline: [number, number][], thick: number, origin: V3, ex: V3, ey: V3): IndexedMesh {
  const x = v(ex).normalize(), y = v(ey).normalize(), z = new THREE.Vector3().crossVectors(x, y).normalize();
  const m = prism(outline, -thick / 2, thick / 2);
  const M = new THREE.Matrix4().makeBasis(x, y, z);
  M.setPosition(v(origin));
  return transform(m, M);
}

/** Smooth step and helpers shared by the shape code. */
export const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
export const smooth = (x: number) => x * x * (3 - 2 * x);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
