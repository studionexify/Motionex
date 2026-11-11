// Cut groups: a body part (the body, the tail, one limb or tentacle) is a centre line with a number of cuts spread
// along it. Changing the count re-spaces the cuts; edits to single cuts (moved, turned, another joint type, deleted)
// are kept by position in the group, so they survive a change of count.
import * as THREE from 'three';
import type { MeshBVH } from 'three-mesh-bvh';
import type { V3 } from './csg';
import { newCut, probeCut, type Cut } from './flexi';
import { defaultJoint, type JointSpec } from './joints';

export interface CutEdit { deleted?: boolean; origin?: V3; normal?: V3; roll?: number; radius?: number; enabled?: boolean; name?: string; joint?: JointSpec }

export interface CutGroup {
  id: string;
  name: string;
  /** Centre line of the part, in the order the cuts run along it. */
  path: V3[];
  /** Share of the path that carries cuts. */
  from: number;
  to: number;
  count: number;
  spacing: 'even' | 'thickness';
  joint: JointSpec;
  /** Alternate the hinge direction between neighbours. */
  alternate: boolean;
  enabled: boolean;
  edits: Record<number, CutEdit>;
}

export const newGroup = (id: string, name: string, path: V3[], joint: JointSpec = defaultJoint('ball'), count = 6): CutGroup => ({
  id, name, path, from: 0.08, to: 0.92, count, spacing: 'even', joint, alternate: true, enabled: true, edits: {},
});

/** Point and tangent at arc-length fraction u of a polyline. */
export function along(path: V3[], u: number): { p: V3; t: V3 } {
  const pts = path.map((q) => new THREE.Vector3(...q)), cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + pts[i].distanceTo(pts[i - 1]));
  const target = Math.min(1, Math.max(0, u)) * cum[cum.length - 1];
  let j = 1; while (j < cum.length - 1 && cum[j] < target) j++;
  const f = (target - cum[j - 1]) / Math.max(1e-9, cum[j] - cum[j - 1]);
  const P = pts[j - 1].clone().lerp(pts[j], Math.min(1, Math.max(0, f)));
  // tangent from a short stretch either side, so a rough path does not kink the planes
  const a = Math.max(0, j - 2), b = Math.min(pts.length - 1, j + 1);
  const T = pts[b].clone().sub(pts[a]).normalize();
  return { p: [P.x, P.y, P.z], t: [T.x, T.y, T.z] };
}

export function pathLength(path: V3[]): number { let l = 0; for (let i = 1; i < path.length; i++) l += Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1], path[i][2] - path[i - 1][2]); return l; }

/** Where the cuts of a group sit along its path (fractions 0..1). */
export function groupPositions(g: CutGroup, thickness?: (u: number) => number): number[] {
  const n = Math.max(0, Math.round(g.count));
  if (!n) return [];
  const a = Math.min(g.from, g.to - 0.01), b = g.to;
  if (g.spacing === 'even' || !thickness) return Array.from({ length: n }, (_, i) => a + ((i + 0.5) / n) * (b - a));
  // thick parts get longer pieces: integrate 1 / thickness along the part and split it evenly
  const m = 200, cum = [0];
  for (let i = 1; i <= m; i++) cum.push(cum[i - 1] + 1 / Math.max(1.5, thickness(a + (i / m) * (b - a))));
  const out: number[] = []; let j = 1;
  for (let i = 0; i < n; i++) { const target = ((i + 0.5) / n) * cum[m]; while (j < m && cum[j] < target) j++; out.push(a + (j / m) * (b - a)); }
  return out;
}

export function cutsFromGroup(g: CutGroup, bvh?: MeshBVH): Cut[] {
  if (!g.enabled || g.path.length < 2) return [];
  const thickness = bvh ? (u: number) => { const { p, t } = along(g.path, u); return probeCut(bvh, p, t, 0).probe.inr || 3; } : undefined;
  const us = groupPositions(g, thickness), out: Cut[] = [];
  us.forEach((u, i) => {
    const ed = g.edits[i];
    if (ed?.deleted) return;
    const { p, t } = along(g.path, u);
    const joint = ed?.joint ? { ...ed.joint } : { ...g.joint };
    const roll = ed?.roll ?? (g.alternate && joint.kind === 'hinge' && i % 2 ? 90 : 0);
    const c = newCut(`${g.id}:${i}`, ed?.origin ?? p, ed?.normal ?? t, joint, roll);
    c.name = ed?.name ?? `${g.name} ${i + 1}`;
    c.radius = ed?.radius ?? 0;
    c.enabled = ed?.enabled ?? true;
    c.group = g.id; c.index = i;
    out.push(c);
  });
  return out;
}
