// Bulnex row layout: turn the part so it is shallow along the push direction (more parts per row),
// then line copies up along Y at the plate centre, front to back, leaving room for the head behind them.
import * as THREE from 'three';
import { newId, objectPlate, plateOrigin, useStore, worldBounds, type SceneObject, type Vec3 } from '../../state/store';
import { printerById } from '../../profiles/printers';
import { APPROACH_GAP } from './model';

/** Gap between the front of the plate and the first part, mm. */
export const FRONT_MARGIN = 3;

/** Z rotation (degrees, 0..179) that gives the smallest Y depth for these XY points. */
export function shallowestRotation(xy: [number, number][]): { deg: number; depth: number; width: number } {
  let best = { deg: 0, depth: Infinity, width: 0 };
  for (let deg = 0; deg < 180; deg += 1) {
    const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    let y0 = Infinity, y1 = -Infinity, x0 = Infinity, x1 = -Infinity;
    for (const [x, y] of xy) {
      const ry = x * s + y * c, rx = x * c - y * s;
      if (ry < y0) y0 = ry; if (ry > y1) y1 = ry; if (rx < x0) x0 = rx; if (rx > x1) x1 = rx;
    }
    // prefer the narrowest row among (near) equal depths so the push line stays on the part
    if (y1 - y0 < best.depth - 1e-6) best = { deg, depth: y1 - y0, width: x1 - x0 };
  }
  return best;
}

/** How many parts of this depth fit in one row. */
export function rowCapacity(depth: number, bedY: number, gap: number): number {
  const room = bedY - FRONT_MARGIN - APPROACH_GAP - 2;
  return Math.max(0, Math.floor((room + gap) / (depth + gap)));
}

/** Y of each part's front edge in the row (plate mm). */
export const rowPositions = (count: number, depth: number, gap: number) => Array.from({ length: count }, (_, k) => FRONT_MARGIN + k * (depth + gap));

function worldXY(o: SceneObject): [number, number][] {
  const m = new THREE.Matrix4().compose(new THREE.Vector3(), new THREE.Quaternion().setFromEuler(new THREE.Euler(...o.rotation.map((d) => (d * Math.PI) / 180) as Vec3, 'XYZ')), new THREE.Vector3(...o.scale)).elements;
  const v = o.mesh.vertices, out: [number, number][] = [];
  const step = Math.max(3, Math.floor(v.length / 3 / 4000) * 3); // sample big meshes
  for (let i = 0; i < v.length; i += step) out.push([m[0] * v[i] + m[4] * v[i + 1] + m[8] * v[i + 2], m[1] * v[i] + m[5] * v[i + 1] + m[9] * v[i + 2]]);
  return out;
}

/** Rotation after turning the object `deg` about the world Z axis. */
function turnedZ(o: SceneObject, deg: number): Vec3 {
  const d = Math.PI / 180;
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), deg * d).multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(o.rotation[0] * d, o.rotation[1] * d, o.rotation[2] * d, 'XYZ')));
  const e = new THREE.Euler().setFromQuaternion(q, 'XYZ');
  return [e.x / d, e.y / d, e.z / d];
}

/** Suggestion for the panel: rotation and parts per row for an object, without changing anything. */
export function suggestRow(o: SceneObject, gap: number, rotate: boolean) {
  const s = useStore.getState();
  const p = printerById(s.printerId);
  const xy = worldXY(o);
  const r = rotate ? shallowestRotation(xy) : (() => { const ys = xy.map((q) => q[1]), xs = xy.map((q) => q[0]); return { deg: 0, depth: Math.max(...ys) - Math.min(...ys), width: Math.max(...xs) - Math.min(...xs) }; })();
  return { ...r, capacity: rowCapacity(r.depth, p.bed.y, gap) };
}

/**
 * Replace the plate's copies of `templateId` with `count` copies in one row (count ≤ capacity).
 * Other designs on the plate are left alone (the checks warn about them). Returns the parts placed.
 */
export function arrangeRow(templateId: string, count: number | 'max', gap: number, rotate: boolean): number {
  const s = useStore.getState();
  const tpl = s.objects.find((o) => o.id === templateId);
  if (!tpl) return 0;
  const p = printerById(s.printerId);
  const plate = objectPlate(tpl, s.printerId, s.plates.length);
  const [ox, oy] = plateOrigin(plate, s.printerId);
  const sug = suggestRow(tpl, gap, rotate);
  const n = Math.max(1, Math.min(sug.capacity || 1, count === 'max' ? sug.capacity : count));
  const base: SceneObject = { ...tpl, rotation: rotate ? turnedZ(tpl, sug.deg) : tpl.rotation };
  const b = worldBounds(base);
  const baseName = tpl.name.replace(/\s*\((\d+|copy)\)$/, '');
  const ys = rowPositions(n, b.max[1] - b.min[1], gap);
  const row: SceneObject[] = ys.map((y, k) => {
    const dx = ox + p.bed.x / 2 - (b.min[0] + b.max[0]) / 2;
    const dy = oy + y - b.min[1];
    return { ...base, id: k === 0 ? tpl.id : newId(), name: k === 0 ? baseName : `${baseName} (${k + 1})`, position: [base.position[0] + dx, base.position[1] + dy, base.position[2] - b.min[2]] };
  });
  s.checkpoint();
  // copies share the template's mesh: those on this plate are replaced by the new row
  useStore.setState((st) => ({
    objects: [...st.objects.filter((o) => !(o.mesh === tpl.mesh && objectPlate(o, st.printerId, st.plates.length) === plate)), ...row],
    selected: [tpl.id],
  }));
  s.markDirty();
  return n;
}
