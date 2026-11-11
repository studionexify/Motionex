// Velocity painting preview: the outer outline at each row, shaded by the speed it will print at
// (light = the lightest level, dark = the darkest), outside the band in plain grey.
import { paintLevels, speedLadder, type PaintSettings } from './model';
import { levelAt } from './engine';
import { bandRows } from '../wall/loops';
import { previewRows, type PreviewObject } from '../wall/preview';

export function buildPaintPreview(objs: PreviewObject[], p: PaintSettings, layerHeight: number): { positions: Float32Array; colors: Float32Array } | null {
  const pos: number[] = [], col: number[] = [];
  const levels = paintLevels(p);
  const img = p.calibration ? speedLadder(levels) : p.image;
  const view = { x: Math.cos((p.front_deg * Math.PI) / 180), y: Math.sin((p.front_deg * Math.PI) / 180) };
  const across = { x: -view.y, y: view.x };
  for (const rows of previewRows(objs, p.objects, p.z_start, p.z_end, p.follow_curve, layerHeight)) {
    const total = rows[0]?.total ?? 0;
    const map = bandRows(total, img.h, p.fit_height, p.picture?.pixel_mm ?? 3);
    let eMin = Infinity, eMax = -Infinity;
    if (p.projection === 'front') for (const r of rows) if (Number.isFinite(r.s)) for (const l of r.loops) for (const q of l.pts) { const e = q.x * across.x + q.y * across.y; eMin = Math.min(eMin, e); eMax = Math.max(eMax, e); }
    for (const r of rows) {
      for (const l of r.loops) {
        const n = l.pts.length;
        for (let i = 0; i < n; i++) {
          const a = l.pts[i], b = l.pts[(i + 1) % n];
          let shade = 0.55;
          if (Number.isFinite(r.s)) {
            let u: number;
            if (p.projection === 'wrap') { let u1 = l.u[(i + 1) % n]; if (u1 - l.u[i] < -0.5) u1 += 1; u = (l.u[i] + u1) / 2; u -= Math.floor(u); }
            else {
              const len = Math.hypot(b.x - a.x, b.y - a.y) || 1, nx = (b.y - a.y) / len, ny = -(b.x - a.x) / len;
              if (nx * view.x + ny * view.y < 0.17) { push(a, b, r.z, 0.55); continue; }
              const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
              u = Math.max(0, Math.min(1 - 1e-9, (mx * across.x + my * across.y - eMin) / Math.max(1e-6, eMax - eMin)));
            }
            const L = Math.max(0, Math.min(levels - 1, levelAt(p, img, u, map.rowFromBottom(r.s))));
            shade = 0.92 - (0.8 * L) / Math.max(1, levels - 1);
          }
          push(a, b, r.z, shade);
        }
      }
    }
  }
  function push(a: { x: number; y: number }, b: { x: number; y: number }, z: number, v: number) {
    pos.push(a.x, a.y, z, b.x, b.y, z);
    // warm tint so painted greys read apart from the plain wall
    col.push(v, v * 0.96, v * 0.9, v, v * 0.96, v * 0.9);
  }
  return pos.length ? { positions: Float32Array.from(pos), colors: Float32Array.from(col) } : null;
}
