// Path sculpt in the quick preview: pushes preview points radially (from the centre of the object they sit
// on) by the map's value, so the thread view and the drool check show the hand-made moves for any pattern.
import { sculptAt, sculptActive, type SculptSettings } from './model';

export type Warp = (x: number, y: number, z: number) => [number, number];

interface Box { id: string; cx: number; cy: number; x0: number; x1: number; y0: number; y1: number; top: number }

export function makeWarp(s: SculptSettings, objs: { id: string; mesh: { vertices: ArrayLike<number> } }[]): Warp | null {
  if (!sculptActive(s)) return null;
  const ids = new Set(s.objects ?? []);
  const boxes: Box[] = [];
  for (const o of objs) {
    if (ids.size && !ids.has(o.id)) continue;
    const v = o.mesh.vertices;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, top = -Infinity;
    for (let i = 0; i < v.length; i += 3) { x0 = Math.min(x0, v[i]); x1 = Math.max(x1, v[i]); y0 = Math.min(y0, v[i + 1]); y1 = Math.max(y1, v[i + 1]); top = Math.max(top, v[i + 2]); }
    if (x1 >= x0) boxes.push({ id: o.id, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, x0, x1, y0, y1, top });
  }
  if (!boxes.length) return null;
  return (x, y, z) => {
    let b = boxes[0], best = Infinity;
    for (const c of boxes) {
      const d = Math.max(c.x0 - x, 0, x - c.x1) ** 2 + Math.max(c.y0 - y, 0, y - c.y1) ** 2;
      if (d < best) { best = d; b = c; }
    }
    const dx = x - b.cx, dy = y - b.cy, r = Math.hypot(dx, dy);
    if (r < 1e-6) return [x, y];
    const d = sculptAt(s, Math.atan2(dy, dx) / (2 * Math.PI), z, b.top);
    return d ? [x + (dx / r) * d, y + (dy / r) * d] : [x, y];
  };
}

/** Warp xyz triples in place. */
export function warpArray(a: Float32Array, warp: Warp): void {
  for (let i = 0; i + 2 < a.length; i += 3) { const [x, y] = warp(a[i], a[i + 1], a[i + 2]); a[i] = x; a[i + 1] = y; }
}
