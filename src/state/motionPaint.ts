// Surface sets for plugins (paint.motion): every way of choosing where a motion goes ends up here —
// click a surface, paint, lasso or box from the view, a height band, or a whole object.
import * as THREE from 'three';
import { transformVertices } from '../engine/mesh';
import { objectMatrix, useStore, type SceneObject } from './store';

/** Colour of each surface set in the 3D view (set n uses SURFACE_COLORS[n - 1]). */
export const SURFACE_COLORS = ['#ff7a45', '#36cfc9', '#b37feb', '#ffd666', '#ff85c0', '#69c0ff', '#95de64', '#ff4d4f'];

/**
 * Set triangles of each object to value (1..n), or clear them (value 0). Clearing only clears the
 * given set, so erasing one motion's surfaces never removes another's. onlyFree: leave faces that
 * already belong to another motion alone.
 */
export function assignMotion(sel: Map<string, ArrayLike<number>>, value: number, set = useStore.getState().motionSet, record = true, onlyFree = false) {
  const s = useStore.getState();
  const ids = [...sel].filter(([, t]) => t.length).map(([id]) => id);
  if (!ids.length) return;
  s.updateObjects((o) => {
    const arr = o.paint?.motion ? o.paint.motion.slice() : new Uint8Array(o.mesh.indices.length / 3);
    const tris = sel.get(o.id)!;
    for (let k = 0; k < tris.length; k++) { const t = tris[k]; if (onlyFree ? !arr[t] : value || arr[t] === set) arr[t] = value; }
    return { ...o, paint: { ...(o.paint ?? {}), motion: arr } };
  }, ids, record);
}

export const allTris = (o: SceneObject) => Uint32Array.from({ length: o.mesh.indices.length / 3 }, (_, t) => t);

function inside(x: number, y: number, poly: [number, number][]): boolean {
  let r = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) r = !r;
  }
  return r;
}

/**
 * Triangles facing the camera whose centre falls inside a screen polygon (client pixels).
 * rect is the canvas' client rectangle.
 */
export function trisInScreenPolygon(o: SceneObject, poly: [number, number][], camera: THREE.Camera, rect: DOMRect): number[] {
  if (poly.length < 3) return [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of poly) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  const v = transformVertices(o.mesh.vertices, objectMatrix(o).elements), ix = o.mesh.indices;
  const cam = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
  const ortho = (camera as THREE.OrthographicCamera).isOrthographicCamera;
  const look = new THREE.Vector3(); camera.getWorldDirection(look);
  const c = new THREE.Vector3();
  const out: number[] = [];
  for (let t = 0; t < ix.length / 3; t++) {
    const a = ix[t * 3] * 3, b = ix[t * 3 + 1] * 3, d = ix[t * 3 + 2] * 3;
    const ux = v[b] - v[a], uy = v[b + 1] - v[a + 1], uz = v[b + 2] - v[a + 2];
    const wx = v[d] - v[a], wy = v[d + 1] - v[a + 1], wz = v[d + 2] - v[a + 2];
    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    c.set((v[a] + v[b] + v[d]) / 3, (v[a + 1] + v[b + 1] + v[d + 1]) / 3, (v[a + 2] + v[b + 2] + v[d + 2]) / 3);
    // only surfaces facing the viewer, so a lasso round the front doesn't also take the back
    const facing = ortho ? -(nx * look.x + ny * look.y + nz * look.z) : nx * (cam.x - c.x) + ny * (cam.y - c.y) + nz * (cam.z - c.z);
    if (facing <= 0) continue;
    c.project(camera);
    if (c.z > 1 || c.z < -1) continue;
    const sx = rect.left + ((c.x + 1) / 2) * rect.width, sy = rect.top + ((1 - c.y) / 2) * rect.height;
    if (sx < minX || sx > maxX || sy < minY || sy > maxY) continue;
    if (inside(sx, sy, poly)) out.push(t);
  }
  return out;
}

/** Remove every triangle of a surface set from all objects (when its motion is removed). */
export function clearMotionSet(set: number) {
  const s = useStore.getState();
  const ids = s.objects.filter((o) => o.paint?.motion?.some((v) => v === set)).map((o) => o.id);
  if (!ids.length) return;
  s.updateObjects((o) => ({ ...o, paint: { ...o.paint, motion: o.paint!.motion!.map((v) => (v === set ? 0 : v)) } }), ids);
}

/** Triangle count of a surface set, per object. */
export function motionCounts(objects: SceneObject[], set: number): { tris: number; objects: number } {
  let tris = 0, objs = 0;
  for (const o of objects) {
    let n = 0;
    o.paint?.motion?.forEach((v) => { if (v === set) n++; });
    if (n) { tris += n; objs++; }
  }
  return { tris, objects: objs };
}
