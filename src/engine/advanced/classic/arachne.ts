// Frozen classic engine of Advanced mode (as on main at 08b924a). Advanced mode slices with this engine
// only, so Basic-engine changes never alter Advanced output and vice versa.
// Variable-width walls (Arachne-style). Regions too narrow for a pair of constant-width
// beads are printed as a single bead that follows the region's medial axis, with the bead
// width following the local region width. This fills thin walls and gaps that classic
// perimeters either skip or double-extrude.
import { SCALE, areaTotal, difference, offset, opening } from '../../clipper';
import type { Paths, Polyline2 } from '../../types';

export interface VarPath extends Polyline2 { widths: number[] }

/**
 * Split `region` into the part that fits normal beads of width `w` (returned as `wide`)
 * and the narrow remainder, converted to medial-axis centerlines with per-point widths.
 */
export function splitNarrow(region: Paths, w: number, minW: number, maxW: number): { wide: Paths; thin: VarPath[] } {
  if (!region.length) return { wide: [], thin: [] };
  // anything that survives an opening by w can hold two beads side by side
  const wide = opening(region, w * 0.999);
  const rest = wide.length ? difference(region, offset(wide, 0.002)) : region;
  if (!rest.length || areaTotal(rest) < minW * minW) return { wide, thin: [] };
  const thin = medialAxis(rest, minW, Math.max(maxW, 2 * w)).filter((p) => pathLen(p.pts) >= w * 1.5);
  return { wide, thin: thin.map((p) => ({ ...p, widths: p.widths.map((x) => Math.min(maxW, Math.max(minW, x))) })) };
}

function pathLen(pts: number[]) {
  let s = 0;
  for (let k = 2; k < pts.length; k += 2) s += Math.hypot(pts[k] - pts[k - 2], pts[k + 1] - pts[k - 1]);
  return s;
}

interface Seg { ax: number; ay: number; bx: number; by: number }

/**
 * Approximate medial axis of a set of thin polygons: from boundary samples, cast a ray along the
 * inward normal to the opposite side; the midpoint is a medial point and the hit distance is the
 * local width. Medial points are deduplicated and chained into polylines.
 */
export function medialAxis(paths: Paths, minWidth: number, maxWidth: number, step = 0.12): VarPath[] {
  const segs: Seg[] = [];
  for (const p of paths) for (let k = 0; k < p.length; k++) {
    const a = p[k], b = p[(k + 1) % p.length];
    segs.push({ ax: a.X / SCALE, ay: a.Y / SCALE, bx: b.X / SCALE, by: b.Y / SCALE });
  }
  const pts: { x: number; y: number; w: number }[] = [];
  for (let si = 0; si < segs.length; si++) {
    const s = segs[si];
    const dx = s.bx - s.ax, dy = s.by - s.ay, L = Math.hypot(dx, dy);
    if (L < 1e-6) continue;
    const nx = -dy / L, ny = dx / L; // left normal = interior for Clipper orientation
    const n = Math.max(1, Math.round(L / step));
    for (let j = 0; j < n; j++) {
      const t = (j + 0.5) / n;
      const ox = s.ax + dx * t, oy = s.ay + dy * t;
      let best = Infinity;
      for (let q = 0; q < segs.length; q++) {
        if (q === si) continue;
        const d = rayHit(ox, oy, nx, ny, segs[q]);
        if (d > 1e-5 && d < best) best = d;
      }
      if (best > maxWidth * 1.15 || best < minWidth * 0.5) continue;
      pts.push({ x: ox + nx * best / 2, y: oy + ny * best / 2, w: best });
    }
  }
  // dedupe on a grid (both sides of a strip produce the same medial points)
  const cell = step * 0.9;
  const grid = new Map<string, { x: number; y: number; w: number; n: number }>();
  for (const p of pts) {
    const key = `${Math.round(p.x / cell)},${Math.round(p.y / cell)}`;
    const g = grid.get(key);
    if (g) { g.x += p.x; g.y += p.y; g.w += p.w; g.n++; } else grid.set(key, { ...p, n: 1 });
  }
  const nodes = [...grid.values()].map((g) => ({ x: g.x / g.n, y: g.y / g.n, w: g.w / g.n, used: false }));
  return chain(nodes, step * 4);
}

function rayHit(ox: number, oy: number, dx: number, dy: number, s: Seg): number {
  const ex = s.bx - s.ax, ey = s.by - s.ay;
  const den = dx * ey - dy * ex;
  if (Math.abs(den) < 1e-12) return Infinity;
  const wx = s.ax - ox, wy = s.ay - oy;
  const t = (wx * ey - wy * ex) / den; // along ray
  const u = (wx * dy - wy * dx) / den; // along segment
  return u >= 0 && u <= 1 && t > 0 ? t : Infinity;
}

function chain(nodes: { x: number; y: number; w: number; used: boolean }[], maxJump: number): VarPath[] {
  const out: VarPath[] = [];
  const near = (a: typeof nodes[0], r: number) => nodes.filter((b) => b !== a && !b.used && (b.x - a.x) ** 2 + (b.y - a.y) ** 2 < r * r);
  while (true) {
    const free = nodes.filter((n) => !n.used);
    if (!free.length) break;
    // start from an end point: the free node with the fewest close neighbours, extreme along x+y
    let start = free[0], bestScore = Infinity;
    for (const n of free) {
      const score = near(n, maxJump).length * 1000 + n.x + n.y;
      if (score < bestScore) { bestScore = score; start = n; }
    }
    const line: typeof nodes = [start];
    start.used = true;
    let cur = start;
    for (;;) {
      let nb: typeof nodes[0] | null = null, bd = maxJump * maxJump;
      for (const n of nodes) {
        if (n.used) continue;
        const d = (n.x - cur.x) ** 2 + (n.y - cur.y) ** 2;
        if (d < bd) { bd = d; nb = n; }
      }
      if (!nb) break;
      nb.used = true;
      // swallow nodes very close to the step (thick parts produce clusters)
      line.push(nb);
      cur = nb;
    }
    if (line.length < 2) continue;
    // decimate to ~0.3 mm spacing and smooth widths
    const pts: number[] = [], widths: number[] = [];
    let lx = Infinity, ly = Infinity;
    for (let k = 0; k < line.length; k++) {
      const n = line[k];
      if (k !== line.length - 1 && Math.hypot(n.x - lx, n.y - ly) < 0.3) continue;
      const a = line[Math.max(0, k - 1)], b = line[Math.min(line.length - 1, k + 1)];
      pts.push(n.x, n.y); widths.push((a.w + n.w * 2 + b.w) / 4);
      lx = n.x; ly = n.y;
    }
    if (pts.length >= 4) out.push({ pts, widths, closed: false });
  }
  return out;
}
