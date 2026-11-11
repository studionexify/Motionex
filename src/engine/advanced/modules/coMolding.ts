// #20 In-situ sacrificial co-molding (opt-in). The part prints as a hermetic shell: everything deeper
// than the shell thickness (from the signed distance field, so the cavity closes top and bottom in 3D)
// becomes a cavity, crossed by a grid of perforated vascular columns (tubes with windows every few mm so
// the cast fills them and they end up as reinforcing ribs). A sprue tube carries the casting resin or
// low-melt alloy from the top to the bottom of the cavity (bottom-up filling, no trapped air) and a
// vent opens the highest point of the cavity.
import { difference, intersection, union, SCALE } from '../../clipper';
import type { Paths } from '../../types';
import { rasterize } from '../offsets';
import type { SessionCtx, TechModule } from '../session';
import { levelRegion } from './fea';

const circle = (cx: number, cy: number, r: number, n = 24): Paths[number] => Array.from({ length: n }, (_, k) => ({ X: Math.round((cx + r * Math.cos((k / n) * 2 * Math.PI)) * SCALE), Y: Math.round((cy + r * Math.sin((k / n) * 2 * Math.PI)) * SCALE) }));
const rect = (x0: number, y0: number, x1: number, y1: number): Paths[number] => [{ X: Math.round(x0 * SCALE), Y: Math.round(y0 * SCALE) }, { X: Math.round(x1 * SCALE), Y: Math.round(y0 * SCALE) }, { X: Math.round(x1 * SCALE), Y: Math.round(y1 * SCALE) }, { X: Math.round(x0 * SCALE), Y: Math.round(y1 * SCALE) }];

interface Plan { shell: number; vent: [number, number, number]; sprue: [number, number, number, number]; columns: [number, number][] }

/** Cavity extent along z at (x, y): [bottom, top] where the depth exceeds the shell, or null. */
function cavitySpan(s: SessionCtx, o: number, x: number, y: number, shell: number): [number, number] | null {
  const a = s.parts[o];
  let lo = Infinity, hi = -Infinity;
  for (let z = a.sdf.min[2]; z <= a.sdf.max[2]; z += 0.25) if (-a.sdf.sdf.sample(x, y, z) > shell) { lo = Math.min(lo, z); hi = Math.max(hi, z); }
  return Number.isFinite(lo) ? [lo, hi] : null;
}

function plan(s: SessionCtx, o: number): Plan | null {
  const a = s.parts[o];
  const walls = Math.max(1, Math.round(s.num('wall_loops')) || 2);
  const lw = s.num('line_width') || s.caps.nozzle * 1.05;
  const shell = Math.max(walls * lw + 0.4, 1.6);
  const pitch = s.pnum('co_molding', 'columnPitch'), port = s.pnum('co_molding', 'port');
  const cols: [number, number][] = [];
  let vent: [number, number, number] | null = null, cx = 0, cy = 0, n = 0;
  const step = Math.max(1, Math.min(pitch / 4, 3));
  const spans: { x: number; y: number; lo: number; hi: number }[] = [];
  for (let y = a.sdf.min[1] + step / 2; y < a.sdf.max[1]; y += step) for (let x = a.sdf.min[0] + step / 2; x < a.sdf.max[0]; x += step) {
    const sp = cavitySpan(s, o, x, y, shell + port);
    if (!sp) continue;
    spans.push({ x, y, lo: sp[0], hi: sp[1] });
    cx += x; cy += y; n++;
    if (!vent || sp[1] > vent[2]) vent = [x, y, sp[1]];
  }
  if (!vent || n < 4) return null;
  cx /= n; cy /= n;
  // sprue: the cavity point farthest from the vent
  let best = spans[0], bd = -1;
  for (const q of spans) { const d = Math.hypot(q.x - vent[0], q.y - vent[1]); if (d > bd) { bd = d; best = q; } }
  for (let y = a.sdf.min[1] + pitch / 2; y < a.sdf.max[1]; y += pitch) for (let x = a.sdf.min[0] + pitch / 2; x < a.sdf.max[0]; x += pitch) {
    if (Math.hypot(x - best.x, y - best.y) < port * 2 || Math.hypot(x - vent[0], y - vent[1]) < port * 2) continue;
    if (cavitySpan(s, o, x, y, shell)) cols.push([x, y]);
  }
  void cx; void cy;
  return { shell, vent, sprue: [best.x, best.y, best.lo, best.hi], columns: cols };
}

export const coMolding: TechModule = {
  id: 'co_molding',
  reshape(s, o, layer, slice, z) {
    if (!slice.length || !Number.isFinite(z)) return slice;
    const r = s.report('co_molding');
    const p = s.memo(`mold:${o}`, () => plan(s, o));
    if (!p) { r.status = 'idle'; r.reason = 'The part is too thin for a cavity inside its shell.'; return slice; }
    const a = s.parts[o];
    const zc = z - (s.layerH[layer] ?? 0.2) / 2;
    const ras = rasterize(slice, Math.max(0.3, a.sdf.sdf.h / 2));
    if (!ras) return slice;
    let cavity = intersection(levelRegion(ras, (x, y) => -a.sdf.sdf.sample(x, y, zc), p.shell, 1).paths, slice);
    const port = s.pnum('co_molding', 'port'), R = s.pnum('co_molding', 'columnR');
    let solid = slice;
    if (cavity.length) {
      // columns: tubes (wall 0.9 mm) with two opposite windows in 1.2 mm bands every 4 mm
      const window = zc % 4 < 1.2;
      const tubes: Paths = [];
      for (const [x, y] of p.columns) {
        let ring = difference([circle(x, y, R)], [circle(x, y, Math.max(0.3, R - 0.9))]);
        if (window) ring = difference(ring, [rect(x - R - 1, y - 0.6, x + R + 1, y + 0.6)]);
        tubes.push(...ring);
      }
      // the sprue tube walls inside the cavity (open at its lower end)
      const [sx, sy, slo] = p.sprue;
      if (zc > slo + 1) tubes.push(...difference([circle(sx, sy, port / 2 + 1.2)], [circle(sx, sy, port / 2)]));
      cavity = difference(cavity, tubes);
      solid = difference(slice, cavity);
    }
    // ports through the solid shell: the sprue bore from the top, the vent above the cavity's high point
    const holes: Paths = [];
    if (zc > p.sprue[2] + 1) holes.push(circle(p.sprue[0], p.sprue[1], port / 2));
    if (zc >= p.vent[2] - 0.5) holes.push(circle(p.vent[0], p.vent[1], port / 2));
    if (holes.length) solid = difference(solid, union(holes));
    r.stats = { shell_mm: +p.shell.toFixed(2), columns: p.columns.length, sprue_xy: `${p.sprue[0].toFixed(1)}, ${p.sprue[1].toFixed(1)}`, vent_xy: `${p.vent[0].toFixed(1)}, ${p.vent[1].toFixed(1)}`, cavity_layers: (Number(r.stats?.cavity_layers) || 0) + (cavity.length ? 1 : 0) };
    return solid;
  },
};
