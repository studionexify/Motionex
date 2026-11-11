// Lay-on-face candidates: facets of the object's convex hull,
// merged by normal into flat planes, the biggest planes offered as clickable surfaces.
import * as THREE from 'three';
import { ConvexGeometry } from 'three/examples/jsm/geometries/ConvexGeometry.js';

export interface FlatFace {
  /** World-space outward normal of the plane (the object is laid so this points down). */
  normal: THREE.Vector3;
  area: number;
  /** Triangles of the plane, world space, flat xyz list. */
  tris: number[];
}

const MAX_POINTS = 20000;
const MAX_FACES = 64;

export function flatFaces(vertices: ArrayLike<number>, matrix: THREE.Matrix4): FlatFace[] {
  const n = vertices.length / 3;
  const stride = Math.max(1, Math.ceil(n / MAX_POINTS));
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < n; i += stride) pts.push(new THREE.Vector3(vertices[i * 3], vertices[i * 3 + 1], vertices[i * 3 + 2]).applyMatrix4(matrix));
  if (pts.length < 4) return [];
  let geo: THREE.BufferGeometry;
  try { geo = new ConvexGeometry(pts); } catch { return []; }
  const p = geo.getAttribute('position');
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), nrm = new THREE.Vector3();
  const faces: FlatFace[] = [];
  for (let t = 0; t < p.count; t += 3) {
    a.fromBufferAttribute(p, t); b.fromBufferAttribute(p, t + 1); c.fromBufferAttribute(p, t + 2);
    nrm.subVectors(c, b).cross(new THREE.Vector3().subVectors(a, b));
    const area = nrm.length() / 2;
    if (area < 1e-9) continue;
    nrm.normalize();
    // facets of one plane: same normal and same offset along it
    const d = nrm.dot(a);
    let f = faces.find((x) => x.normal.dot(nrm) > 0.9995 && Math.abs(x.normal.dot(a) - d) < 0.05);
    if (!f) { f = { normal: nrm.clone(), area: 0, tris: [] }; faces.push(f); }
    f.area += area;
    f.tris.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  }
  geo.dispose();
  faces.sort((x, y) => y.area - x.area);
  // planes too small to stand on are dropped
  const minArea = Math.max(faces[0]?.area ?? 0, 1) * 0.002;
  return faces.filter((f) => f.area >= minArea).slice(0, MAX_FACES);
}
