// Frozen classic engine of Advanced mode (as on main at 08b924a). Advanced mode slices with this engine
// only, so Basic-engine changes never alter Advanced output and vice versa.
// Stage 6: support synthesis — overhang detection, normal (grid) projection and tree supports.
import { difference, intersection, offset, opening, SCALE, union, bounds } from '../../clipper';
import ClipperLib from 'clipper-lib';
import type { Path, Paths } from '../../types';

const C: any = (ClipperLib as any).default ?? ClipperLib;

export interface SupportParams {
  topZDistance: number; // mm
  xyDistance: number; // mm
  interfaceLayers: number;
  buildPlateOnly: boolean;
  lineWidth: number;
  /** Regions where support is forbidden at each layer (blockers). */
  blocked?: Paths[];
}

export interface TreeParams extends SupportParams {
  branchAngle: number; // degrees from vertical a branch may lean per layer
  tipDiameter: number;
  branchDiameter: number; // maximum trunk diameter
  branchDistance: number; // tip spacing (mm)
}

export interface SupportLayers { base: Paths[]; iface: Paths[] }

/** Areas of each layer not supported by the layer below (+ allowed step-out at the threshold angle). */
export function computeOverhangs(slices: Paths[], heights: number[], thresholdAngle: number, removeSmall: boolean, lineWidth: number): Paths[] {
  const tanT = Math.tan((Math.max(1, Math.min(89.9, thresholdAngle)) * Math.PI) / 180);
  const over: Paths[] = [[]];
  for (let i = 1; i < slices.length; i++) {
    let o = difference(slices[i], offset(slices[i - 1], heights[i] / tanT));
    if (removeSmall) o = opening(o, lineWidth);
    over.push(o);
  }
  return over;
}

const gapLayers = (heights: number[], z: number) => Math.max(0, Math.round(z / heights[Math.min(1, heights.length - 1)]));

function splitInterface(S: Paths[], over: Paths[], gap: number, n: number): SupportLayers {
  const N = S.length;
  const base: Paths[] = Array.from({ length: N }, () => []);
  const iface: Paths[] = Array.from({ length: N }, () => []);
  for (let i = 0; i < N; i++) {
    if (!S[i].length) continue;
    let ov: Paths = [];
    for (let k = 1; k <= n; k++) {
      const j = i + k + gap;
      if (j < N && over[j].length) ov = ov.concat(over[j]);
    }
    const iz = ov.length ? intersection(S[i], union(ov)) : [];
    iface[i] = iz;
    base[i] = iz.length ? difference(S[i], iz) : S[i];
  }
  return { base, iface };
}

/** Normal supports: project overhangs straight down, keeping clear of the model. */
export function generateSupport(slices: Paths[], heights: number[], over: Paths[], p: SupportParams): SupportLayers {
  const N = slices.length;
  if (N < 2) return { base: Array.from({ length: N }, () => []), iface: Array.from({ length: N }, () => []) };
  const gap = gapLayers(heights, p.topZDistance);
  let cur: Paths = [];
  const S: Paths[] = Array.from({ length: N }, () => []);
  for (let i = N - 2; i >= 0; i--) {
    const src = i + 1 + gap < N ? over[i + 1 + gap] : [];
    if (src.length) cur = union(cur, src);
    if (!cur.length) continue;
    cur = difference(cur, offset(slices[i], p.xyDistance));
    if (p.blocked?.[i]?.length) cur = difference(cur, p.blocked[i]);
    let blocked: Paths = [];
    for (let k = 1; k <= gap && i - k >= 0; k++) blocked = blocked.concat(slices[i - k]);
    S[i] = opening(blocked.length ? difference(cur, union(blocked)) : cur, p.lineWidth * 0.5);
  }
  if (p.buildPlateOnly) {
    for (let i = 1; i < N; i++) S[i] = S[i].length && S[i - 1].length ? intersection(S[i], offset(S[i - 1], 0.01)) : [];
  }
  return splitInterface(S, over, gap, p.interfaceLayers);
}

// ---------------------------------------------------------------- tree supports

interface Node { x: number; y: number; r: number; dead?: boolean }

function circle(x: number, y: number, r: number, seg = 16): Path {
  const p: Path = [];
  for (let k = 0; k < seg; k++) {
    const a = (k / seg) * Math.PI * 2;
    p.push({ X: Math.round((x + r * Math.cos(a)) * SCALE), Y: Math.round((y + r * Math.sin(a)) * SCALE) });
  }
  return p;
}

const inside = (x: number, y: number, paths: Paths) => {
  const pt = { X: Math.round(x * SCALE), Y: Math.round(y * SCALE) };
  let n = 0;
  for (const p of paths) if (C.Clipper.PointInPolygon(pt, p) !== 0) n++;
  return n % 2 === 1;
};

/** Closest point on the boundary of `paths` to (x, y). */
function nearestBoundary(x: number, y: number, paths: Paths): [number, number] {
  let bx = x, by = y, bd = Infinity;
  for (const p of paths) {
    for (let k = 0; k < p.length; k++) {
      const ax = p[k].X / SCALE, ay = p[k].Y / SCALE;
      const cx = p[(k + 1) % p.length].X / SCALE, cy = p[(k + 1) % p.length].Y / SCALE;
      const dx = cx - ax, dy = cy - ay, L = dx * dx + dy * dy;
      const t = L ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L)) : 0;
      const qx = ax + t * dx, qy = ay + t * dy;
      const d = (qx - x) ** 2 + (qy - y) ** 2;
      if (d < bd) { bd = d; bx = qx; by = qy; }
    }
  }
  return [bx, by];
}

/** Sample tip points inside an overhang region on a square grid. */
function sampleTips(region: Paths, spacing: number): [number, number][] {
  const out: [number, number][] = [];
  const b = bounds(region);
  if (!isFinite(b.minX)) return out;
  const x0 = b.minX / SCALE, y0 = b.minY / SCALE, x1 = b.maxX / SCALE, y1 = b.maxY / SCALE;
  for (let y = y0 + spacing / 2; y < y1; y += spacing) for (let x = x0 + spacing / 2; x < x1; x += spacing) if (inside(x, y, region)) out.push([x, y]);
  if (!out.length) { const p = region[0][0]; out.push([p.X / SCALE, p.Y / SCALE]); }
  return out;
}

/**
 * Tree supports: tips seeded under overhangs grow downward, steering around the model
 * (at most `branchAngle` per layer), attracting each other and merging into thicker trunks.
 */
export function generateTreeSupport(slices: Paths[], heights: number[], over: Paths[], p: TreeParams): SupportLayers {
  const N = slices.length;
  const S: Paths[] = Array.from({ length: N }, () => []);
  if (N < 2) return { base: S, iface: S.map(() => []) };
  const gap = gapLayers(heights, p.topZDistance);
  const tan = Math.tan((Math.max(5, Math.min(80, p.branchAngle)) * Math.PI) / 180);
  const rTip = p.tipDiameter / 2, rMax = p.branchDiameter / 2;
  let nodes: Node[] = [];

  for (let i = N - 2; i >= 0; i--) {
    const h = heights[i + 1];
    const step = h * tan;
    const src = i + 1 + gap < N ? over[i + 1 + gap] : [];
    if (src.length) for (const [x, y] of sampleTips(src, p.branchDistance)) nodes.push({ x, y, r: rTip });
    if (!nodes.length) continue;

    // attraction: move toward nearest neighbour (merging branches)
    for (const n of nodes) {
      let best: Node | null = null, bd = Infinity;
      for (const m of nodes) {
        if (m === n) continue;
        const d = (m.x - n.x) ** 2 + (m.y - n.y) ** 2;
        if (d < bd) { bd = d; best = m; }
      }
      if (best && Math.sqrt(bd) < p.branchDistance * 3) {
        const d = Math.sqrt(bd), mv = Math.min(step * 0.5, d / 2);
        if (d > 0) { n.x += ((best.x - n.x) / d) * mv; n.y += ((best.y - n.y) / d) * mv; }
      }
    }
    // merge overlapping nodes
    const merged: Node[] = [];
    for (const n of nodes) {
      const m = merged.find((q) => Math.hypot(q.x - n.x, q.y - n.y) < Math.max(q.r, n.r) * 0.6);
      if (m) {
        const w = m.r * m.r + n.r * n.r;
        m.x = (m.x * m.r * m.r + n.x * n.r * n.r) / w; m.y = (m.y * m.r * m.r + n.y * n.r * n.r) / w;
        m.r = Math.min(rMax, Math.sqrt(w));
      } else merged.push({ ...n });
    }
    nodes = merged;

    // avoidance: keep each branch clear of the model at this layer
    const keepOut = slices[i].length ? offset(slices[i], p.xyDistance) : [];
    const alive: Node[] = [];
    for (const n of nodes) {
      n.r = Math.min(rMax, n.r + h * 0.04); // trunks thicken toward the bed
      const avoid = keepOut.length ? offset(keepOut, n.r) : [];
      if (avoid.length && inside(n.x, n.y, avoid)) {
        const [qx, qy] = nearestBoundary(n.x, n.y, avoid);
        const d = Math.hypot(qx - n.x, qy - n.y);
        if (d <= step * 1.5 + 1e-6) {
          const ux = d ? (qx - n.x) / d : 0, uy = d ? (qy - n.y) / d : 0;
          n.x = qx + ux * 0.05; n.y = qy + uy * 0.05;
        } else continue; // branch rests on the model surface here

      }
      if (p.blocked?.[i]?.length && inside(n.x, n.y, p.blocked[i])) continue;
      alive.push(n);
    }
    nodes = alive;
    if (!nodes.length) continue;
    const circles = union(nodes.map((n) => circle(n.x, n.y, n.r)));
    S[i] = keepOut.length ? difference(circles, keepOut) : circles;
  }
  if (p.buildPlateOnly) {
    // keep only branches that reach the bed: each layer must sit on the one below (branches lean ≤ step)
    for (let i = 1; i < N; i++) S[i] = S[i].length && S[i - 1].length ? intersection(S[i], offset(S[i - 1], heights[i] * tan + rTip)) : [];
  }
  return splitInterface(S, over, gap, p.interfaceLayers);
}
