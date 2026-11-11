// #32 Morse–Smale complex & persistent homology router. The height function on the part is tracked
// through its cross-sections: every island of every plane is a Reeb-graph node, linked to the islands
// it overlaps on the next plane. Births are minima, deaths maxima, merges and splits saddles; 0-dim
// persistence by the elder rule (at a merge the younger branch dies), and arcs shorter than the
// persistence threshold are absorbed into their neighbours. Each surviving branch is routed: one that
// starts in mid-air needs curved layers, reorientation (5-axis) or support; a steady single-island
// branch suits the continuous helix; the rest prints planar.
import { intersection, pointIn, toExPolygons, exToPaths } from '../../clipper';
import type { Paths } from '../../types';
import type { PartAnalysis } from '../analysis';
import type { SessionCtx, TechModule } from '../session';

export interface Branch { id: number; z0: number; z1: number; birth: 'bed' | 'minimum' | 'split'; death: 'maximum' | 'merge' | 'top'; persistence: number; route: string }
export interface ReebGraph { branches: Branch[]; minima: number; maxima: number; saddles: number; nodeBranch: number[][]; planes: Paths[][]; z: number[] }

export function reebGraph(a: PartAnalysis, threshold: number): ReebGraph {
  const sec = a.sections;
  const planes: Paths[][] = sec.slices.map((sl) => toExPolygons(sl).map(exToPaths));
  const nodeBranch: number[][] = planes.map((p) => p.map(() => -1));
  const branches: Branch[] = [];
  let minima = 0, maxima = 0, saddles = 0;
  const zmin = a.sdf.min[2];
  const step = sec.z.length > 1 ? sec.z[1] - sec.z[0] : 0.2;
  // island bounding boxes, so only boxes that overlap go to the polygon intersection
  const boxes = planes.map((pl) => pl.map((q) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const path of q) for (const pt of path) { if (pt.X < x0) x0 = pt.X; if (pt.X > x1) x1 = pt.X; if (pt.Y < y0) y0 = pt.Y; if (pt.Y > y1) y1 = pt.Y; }
    return [x0, y0, x1, y1];
  }));
  for (let k = 0; k < planes.length; k++) {
    // overlaps between the islands of plane k − 1 and plane k, computed once per plane pair
    const pred: number[][] = planes[k].map(() => []), succ: number[][] = k ? planes[k - 1].map(() => []) : [];
    if (k) for (let i = 0; i < planes[k].length; i++) {
      const b = boxes[k][i];
      for (let j = 0; j < planes[k - 1].length; j++) {
        const c = boxes[k - 1][j];
        if (c[0] > b[2] || c[2] < b[0] || c[1] > b[3] || c[3] < b[1]) continue;
        if (intersection(planes[k - 1][j], planes[k][i]).length) { pred[i].push(j); succ[j].push(i); }
      }
    }
    for (let i = 0; i < planes[k].length; i++) {
      const prev = pred[i];
      if (!prev.length) {
        // a birth: on the bed or a local minimum of the height function
        const bed = sec.z[k] <= zmin + step * 1.5;
        if (!bed) minima++;
        nodeBranch[k][i] = branches.length;
        branches.push({ id: branches.length, z0: sec.z[k] - step / 2, z1: sec.z[k] + step / 2, birth: bed ? 'bed' : 'minimum', death: 'top', persistence: 0, route: '' });
        continue;
      }
      if (prev.length > 1) {
        // merge saddle: the elder (earliest-born) branch continues, the younger ones die here
        saddles++;
        const ids = [...new Set(prev.map((j) => nodeBranch[k - 1][j]))].sort((x, y) => branches[x].z0 - branches[y].z0);
        for (const id of ids.slice(1)) { branches[id].death = 'merge'; branches[id].z1 = sec.z[k]; }
        nodeBranch[k][i] = ids[0];
        branches[ids[0]].z1 = sec.z[k] + step / 2;
        continue;
      }
      // one predecessor: continue its branch, or start a new one at a split
      const pid = nodeBranch[k - 1][prev[0]];
      const kids = succ[prev[0]];
      if (kids.length > 1 && kids[0] !== i) {
        saddles++;
        nodeBranch[k][i] = branches.length;
        branches.push({ id: branches.length, z0: sec.z[k] - step / 2, z1: sec.z[k] + step / 2, birth: 'split', death: 'top', persistence: 0, route: '' });
      } else { nodeBranch[k][i] = pid; branches[pid].z1 = sec.z[k] + step / 2; }
    }
    // deaths: islands of plane k − 1 with no successor
    if (k) planes[k - 1].forEach((_q, j) => { if (!succ[j].length) { const b = branches[nodeBranch[k - 1][j]]; if (b.death === 'top') { b.death = 'maximum'; maxima++; } } });
  }
  for (const b of branches) b.persistence = b.z1 - b.z0;
  // simplification: short arcs fold into the branch they touch
  const keep = branches.filter((b) => b.persistence >= threshold || b.birth === 'bed');
  const remap = new Map<number, number>();
  for (const b of branches) if (!keep.includes(b)) {
    // nearest kept branch overlapping in z
    let best = keep[0]?.id ?? b.id, bd = Infinity;
    for (const q of keep) { const d = Math.max(0, q.z0 - b.z1, b.z0 - q.z1); if (d < bd) { bd = d; best = q.id; } }
    remap.set(b.id, best);
  }
  for (const row of nodeBranch) for (let i = 0; i < row.length; i++) if (remap.has(row[i])) row[i] = remap.get(row[i])!;
  return { branches: keep, minima, maxima, saddles, nodeBranch, planes, z: sec.z };
}

/** Branch id per triangle (index into the kept branches), for the Zone Inspector. */
export function branchField(a: PartAnalysis, g: ReebGraph): Float32Array {
  const T = a.surf.triCount, out = new Float32Array(T);
  const order = new Map(g.branches.map((b, i) => [b.id, i]));
  for (let t = 0; t < T; t++) {
    const x = a.surf.centroid[t * 3], y = a.surf.centroid[t * 3 + 1], z = a.surf.centroid[t * 3 + 2];
    // the planes are evenly spaced: the nearest one by index
    const k = g.z.length > 1 ? Math.max(0, Math.min(g.z.length - 1, Math.round((z - g.z[0]) / (g.z[1] - g.z[0])))) : 0;
    // the island holding the centroid (surface points sit on the outline: fall back to the first island)
    const best = Math.max(0, (g.planes[k] ?? []).findIndex((p) => pointIn(x, y, p)));
    out[t] = order.get(g.nodeBranch[k]?.[best] ?? 0) ?? 0;
  }
  return out;
}

export const morseRouter: TechModule = {
  id: 'morse_router',
  inspect(a) {
    const g = reebGraph(a, 1.5);
    a.extra.branch = branchField(a, g);
  },
  prepare(s: SessionCtx) {
    const r = s.report('morse_router');
    const thr = s.pnum('morse_router', 'persistence');
    const routes: Record<string, number> = {};
    let branches = 0, minima = 0, saddles = 0, maxima = 0;
    s.parts.forEach((a, o) => {
      const g = reebGraph(a, thr);
      for (const b of g.branches) {
        const helical = a.sections.helical.some(([z0, z1]) => z0 <= b.z0 + 0.5 && z1 >= b.z1 - 0.5);
        b.route = b.birth === 'minimum' || b.birth === 'split'
          ? s.caps.axes >= 5 ? 'reorient (rotary axes)' : s.on('harmonic_dome') || s.on('sgd_slicing') ? 'curved layers' : 'support'
          : helical ? 'helix' : 'planar';
        routes[b.route] = (routes[b.route] ?? 0) + 1;
      }
      s.shared.set(`branches:${o}`, g.branches);
      branches += g.branches.length; minima += g.minima; saddles += g.saddles; maxima += g.maxima;
    });
    r.stats = { branches, minima, saddles, maxima, betti0: s.parts.reduce((t, p) => t + p.betti[0], 0), betti1: s.parts.reduce((t, p) => t + p.betti[1], 0), routes: Object.entries(routes).map(([k, v]) => `${v} ${k}`).join(', ') };
  },
};
