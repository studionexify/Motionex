// Put a library pattern on a target: a picked face, one side of the object, every side, or wrapped round the body.
import * as THREE from 'three';
import { objectMatrix, useStore, worldBounds, type SceneObject } from '../../../state/store';
import { newPlacement, type Pattern } from '../model';
import type { V3 } from '../projection';
import type { RegionAction } from '../model';
import { addPattern, type ObjPlacement, type PatternexState } from '../ui/state';

export type Side = 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right';
export type Target = { kind: 'face' } | { kind: 'side'; side: Side } | { kind: 'sides' } | { kind: 'wrap' };
export const SIDES: Side[] = ['top', 'front', 'right', 'back', 'left', 'bottom'];

const NORMAL: Record<Side, V3> = { top: [0, 0, 1], bottom: [0, 0, -1], front: [0, -1, 0], back: [0, 1, 0], left: [-1, 0, 0], right: [1, 0, 0] };

/** Size (mm) the pattern should have to cover a target, from the object's plate-aligned bounds. */
export function targetSize(o: SceneObject | undefined, t: Target): { width: number; height: number } | null {
  if (!o || t.kind === 'face') return null;
  const b = worldBounds(o);
  const dx = b.max[0] - b.min[0], dy = b.max[1] - b.min[1], dz = b.max[2] - b.min[2];
  if (t.kind === 'wrap') return { width: Math.PI * Math.max(dx, dy), height: dz };
  if (t.kind === 'sides') return { width: Math.max(dx, dy), height: dz };
  const s = t.side;
  return s === 'top' || s === 'bottom' ? { width: dx, height: dy } : s === 'front' || s === 'back' ? { width: dx, height: dz } : { width: dy, height: dz };
}

function mkPlacement(o: SceneObject, pattern: Pattern, at: V3, n: V3, over: Partial<ObjPlacement> = {}): ObjPlacement {
  const inv = objectMatrix(o).invert();
  const local = new THREE.Vector3(...at).applyMatrix4(inv).toArray() as V3;
  const nl = new THREE.Vector3(...n).transformDirection(inv).normalize().toArray() as V3;
  const id = `pl${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  return { ...newPlacement(id, pattern, `${o.id}:side`, local, nl), object_id: o.id, anchor_normal: nl, ...over };
}

/**
 * Place `make(width, height)` on the target. For sides the pattern is rebuilt to each side's size,
 * so tiles keep their cell size. Returns the new placement ids.
 */
export function applyToObject(px: PatternexState, o: SceneObject, t: Target, make: (w: number, h: number) => Pattern, actions: (placementId: string, p: Pattern) => RegionAction[]): string[] {
  const b = worldBounds(o);
  const c: V3 = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
  const ids: string[] = [];
  const add = (p: ObjPlacement, pat: Pattern) => { px.placements.push(p); px.actions.push(...actions(p.id, pat)); ids.push(p.id); };
  const side = (s: Side) => {
    const n = NORMAL[s];
    const at: V3 = [c[0] + n[0] * (b.max[0] - b.min[0]) / 2, c[1] + n[1] * (b.max[1] - b.min[1]) / 2, c[2] + n[2] * (b.max[2] - b.min[2]) / 2];
    const sz = targetSize(o, { kind: 'side', side: s })!;
    const pat = addPattern(px, make(Math.max(1, sz.width), Math.max(1, sz.height)));
    add(mkPlacement(o, pat, at, n), pat);
  };
  if (t.kind === 'side') side(t.side);
  else if (t.kind === 'sides') (['front', 'right', 'back', 'left'] as Side[]).forEach(side);
  else if (t.kind === 'wrap') {
    const sz = targetSize(o, t)!;
    const pat = addPattern(px, make(Math.max(1, sz.width), Math.max(1, sz.height)));
    const R = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1]) / 2;
    const inv = objectMatrix(o).invert();
    const originLocal = new THREE.Vector3(c[0], c[1], b.min[2]).applyMatrix4(inv).toArray() as V3;
    const axisLocal = new THREE.Vector3(0, 0, 1).transformDirection(inv).normalize().toArray() as V3;
    add(mkPlacement(o, pat, [c[0], c[1] - R, c[2]], [0, -1, 0], { projection: 'cylindrical', projection_axis: axisLocal, axis_origin: originLocal }), pat);
  }
  if (ids.length) px.selected = ids[ids.length - 1];
  return ids;
}

/** The object a library apply targets: the selection, else the only/first object. */
export function targetObject(): SceneObject | undefined {
  const s = useStore.getState();
  return s.objects.find((o) => o.id === s.selected[0]) ?? s.objects[0];
}

/** Region actions from the user's inks: one per inked group key colour (uninked groups stay base material). */
export function inkActions(placementId: string, pattern: Pattern, inkByKey: Record<string, number>, ams: boolean): RegionAction[] {
  const keys = [...new Set(pattern.shapes.map((s) => s.fill_color))];
  return keys.filter((k) => (inkByKey[k] ?? -1) >= 0).map((k) => ({
    region_ref: { placement_id: placementId, color_group: k },
    material: { mode: ams ? 'slot' : 'manual', slot_index: inkByKey[k] },
    purge: { mode: 'full', change_point_shift_mm: 0 },
    motion: null,
  }));
}
