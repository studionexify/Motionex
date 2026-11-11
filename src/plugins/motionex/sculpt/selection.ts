// Picked cells of the Path sculpt map, shared by the unrolled-wall grid and the 3D view, so picking on either
// shows on both. Also turns a point on the model into a cell of the map.
import { useSyncExternalStore } from 'react';
import type { SculptSettings } from './model';

interface Picked { grid: string; set: Set<number> }
const picked = new Map<string, Picked>();
let version = 0;
const listeners = new Set<() => void>();
export const brush = { radius: 2 };

/** Picked cells of tool `id` on a w × h grid (a new grid size starts empty). */
export function pickedOf(id: string, w: number, h: number): Set<number> {
  const key = `${w}x${h}`;
  let p = picked.get(id);
  if (!p || p.grid !== key) { p = { grid: key, set: new Set() }; picked.set(id, p); }
  return p.set;
}

/** Tell both views the picks changed. */
export function pickChanged(): void {
  version++;
  listeners.forEach((l) => l());
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('nx-sculpt-pick'));
}
export const usePickVersion = () => useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => version);

/** The cell of the map under world point (x, y, z) on an object whose axis is at (cx, cy) and whose top is at `top`; null outside the band. */
export function cellAt(s: SculptSettings, cx: number, cy: number, top: number, x: number, y: number, z: number): [number, number] | null {
  const span = Math.max(1e-6, Math.min(s.z_end, top) - s.z_start);
  const t = (z - s.z_start) / span;
  if (t < 0 || t > 1) return null;
  const u = Math.atan2(y - cy, x - cx) / (2 * Math.PI);
  return [Math.min(s.w - 1, Math.floor((u - Math.floor(u)) * s.w)), Math.min(s.h - 1, Math.floor((1 - t) * s.h))];
}

/** Centre of cell (col, row) as an angle fraction and height. */
export function cellCentre(s: SculptSettings, top: number, col: number, row: number): { u: number; z: number } {
  const span = Math.max(1e-6, Math.min(s.z_end, top) - s.z_start);
  return { u: (col + 0.5) / s.w, z: s.z_start + (1 - (row + 0.5) / s.h) * span };
}

/** Pick (or unpick) the cells round a hit point with the brush. Returns whether anything changed. */
export function pickPoint(s: SculptSettings, cx: number, cy: number, top: number, x: number, y: number, z: number, erase: boolean): boolean {
  const c = cellAt(s, cx, cy, top, x, y, z);
  if (!c) return false;
  const S = pickedOf('sculpt', s.w, s.h), r = brush.radius;
  const before = S.size;
  let changed = false;
  for (let dy = -r + 1; dy < r; dy++) for (let dx = -r + 1; dx < r; dx++) {
    if (dx * dx + dy * dy >= r * r + 0.5) continue;
    const yy = c[1] + dy;
    if (yy < 0 || yy >= s.h) continue;
    const i = yy * s.w + (((c[0] + dx) % s.w) + s.w) % s.w;
    if (erase) { if (S.delete(i)) changed = true; } else S.add(i);
  }
  return changed || S.size !== before;
}
