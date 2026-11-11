// #15 Eikonal wavefront & heat-method offsets: inner walls as smooth isolines of a PDE distance field.
import { offset } from '../../clipper';
import type { ExPolygon } from '../../types';
import { pdeOffsets } from '../offsets';
import type { TechModule, WallResult, WallLoop } from '../session';

const SC = 10000;
function hashEx(ex: ExPolygon): number {
  let h = 2166136261;
  const mix = (v: number) => { h ^= v & 0xffff; h = Math.imul(h, 16777619); h ^= v >>> 16; h = Math.imul(h, 16777619); };
  for (const p of [ex.contour, ...ex.holes]) { mix(p.length); for (const q of p) { mix(Math.round(q.X / 50)); mix(Math.round(q.Y / 50)); } }
  return h >>> 0;
}

/** Islands repeat from layer to layer on prismatic parts: one PDE solve per distinct outline. */
const caches = new WeakMap<object, Map<string, WallResult | null>>();

export const eikonalOffsets: TechModule = {
  id: 'eikonal_offsets',
  walls(s, _o, ex, c) {
    if (c.walls < 2) return undefined;
    const r = s.report('eikonal_offsets');
    let cache = caches.get(s);
    if (!cache) { cache = new Map(); caches.set(s, cache); }
    const key = `${hashEx(ex)}|${c.walls}|${c.wo}|${c.wi}|${c.h}`;
    if (!r.stats || !('islands' in r.stats)) r.stats = { islands: 0, inner_walls: 0, cache_hits: 0, declined: 0 };
    const stats = r.stats;
    if (cache.has(key)) {
      stats.cache_hits = (stats.cache_hits as number) + 1;
      const hit = cache.get(key);
      return hit ? { loops: hit.loops.map((ring) => ring.map((l) => ({ ...l, pts: l.pts.slice() }))), inner: hit.inner } : undefined;
    }
    // classic spacing: outer wall at wo/2, then inner walls one spacing apart
    const levels: number[] = [];
    for (let k = 1; k < c.walls; k++) levels.push(c.wo / 2 + (c.so + c.si) / 2 + (k - 1) * c.si);
    const boundary = levels[levels.length - 1] + c.si / 2;
    const method = String(s.param('eikonal_offsets', 'method')) === 'fmm' ? 'fmm' : 'heat';
    const res = pdeOffsets(ex, levels, boundary, { method, cell: s.pnum('eikonal_offsets', 'cell'), smooth: s.pnum('eikonal_offsets', 'smooth'), minLoop: 3 * c.wi });
    if (!res || !res.loops[0]?.length) { cache.set(key, null); stats.declined = (stats.declined as number) + 1; return undefined; }
    // the outer wall stays an exact offset (dimensions); inner walls come from the PDE field
    const outer = offset([ex.contour, ...ex.holes], -c.wo / 2).filter((p) => p.length >= 3);
    if (!outer.length) { cache.set(key, null); stats.declined = (stats.declined as number) + 1; return undefined; }
    const ring0: WallLoop[] = outer.map((p) => ({ pts: p.flatMap((q) => [q.X / SC, q.Y / SC]), closed: true, feature: 'outer_wall', width: c.wo, flow: 1 }));
    const loops: WallLoop[][] = [ring0];
    for (const ring of res.loops) {
      if (!ring.length) break;
      loops.push(ring.map((pts) => ({ pts, closed: true, feature: 'inner_wall' as const, width: c.wi, flow: 1 })));
    }
    const out: WallResult = { loops, inner: loops.length === c.walls ? res.inner : [] };
    cache.set(key, out);
    stats.islands = (stats.islands as number) + 1;
    stats.inner_walls = (stats.inner_walls as number) + loops.slice(1).reduce((t, l) => t + l.length, 0);
    return { loops: out.loops.map((ring) => ring.map((l) => ({ ...l, pts: l.pts.slice() }))), inner: out.inner };
  },
};
