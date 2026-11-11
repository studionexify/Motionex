// Stage 6: support synthesis — overhang detection, normal (grid / snug) projection and tree supports.
import { difference, intersection, offset, opening, SCALE, union, bounds, toExPolygons, exToPaths, area } from './clipper';
import ClipperLib from 'clipper-lib';
import type { Path, Paths } from './types';
import { pushAll } from './util';

const C: any = (ClipperLib as any).default ?? ClipperLib;

export interface SupportParams {
  topZDistance: number; // mm
  /** Gap between the model and support standing on it (mm). */
  bottomZDistance?: number;
  xyDistance: number; // mm
  /** XY gap on the first layer (mm); defaults to xyDistance. */
  firstLayerGap?: number;
  interfaceLayers: number;
  /** Dense layers where support stands on the model (−1 = same as top). */
  bottomInterfaceLayers?: number;
  buildPlateOnly: boolean;
  lineWidth: number;
  /** Regions where support is forbidden at each layer (blockers). */
  blocked?: Paths[];
  /** Normal support: grow (or shrink) the support area horizontally (mm). */
  expansion?: number;
  /** Normal support style: 'grid' snaps the support to a grid of blocks, 'snug' follows the overhang. */
  style?: string;
  /** Under the overhang itself the XY distance may be ignored (the top Z gap keeps it removable). */
  topOverridesXY?: boolean;
}

export interface TreeParams extends SupportParams {
  branchAngle: number; // degrees from vertical a branch may lean per layer
  tipDiameter: number;
  branchDiameter: number; // maximum trunk diameter
  branchDistance: number; // tip spacing (mm)
  /** Branches thicken going down at this angle (degrees). */
  diameterAngle?: number;
  /** Organic: preferred branch angle (degrees) when merging, not avoiding the model (tree_support_angle_slow). */
  slowAngle?: number;
  /** Organic: tip spacing along the tip rows (connect length from the branch density); rows stay branchDistance apart. */
  tipSpacingAlong?: number;
  /** Non-organic trees: brim around the branch feet on the first layer (auto width, or a fixed width in mm). */
  brim?: { auto: boolean; width: number };
}

export interface SupportLayers { base: Paths[]; iface: Paths[]; bottomIface?: Paths[] }

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

/**
 * Keeps only the overhangs that must be supported:
 * - criticalOnly: regions starting in mid-air (no contact with the layer below) and the parts of other
 *   overhangs further than `reach` from it (cantilever tips).
 * - noBridges: overhangs anchored on two or more sides whose span is at most `maxBridge` are bridged instead.
 */
export function filterOverhangs(over: Paths[], slices: Paths[], lineWidth: number, opts: { criticalOnly: boolean; noBridges: boolean; maxBridge: number; reach: number }): Paths[] {
  if (!opts.criticalOnly && !opts.noBridges) return over;
  return over.map((o, i) => {
    if (!o.length || i === 0) return o;
    const below = slices[i - 1];
    const keep: Paths = [];
    for (const ex of toExPolygons(o)) {
      const paths = exToPaths(ex);
      const contact = below.length ? intersection(offset(paths, lineWidth), below) : [];
      const anchors = toExPolygons(contact).filter((c) => Math.abs(area(c.contour)) > lineWidth * lineWidth);
      if (opts.noBridges && anchors.length >= 2) {
        // bridgeable when every point is within half the max bridge length of an anchor
        const reachable = offset(contact, opts.maxBridge / 2);
        if (!difference(paths, reachable).length) continue;
      }
      if (opts.criticalOnly) {
        if (!anchors.length) { pushAll(keep, paths); continue; } // floating island
        const tip = difference(paths, offset(below, opts.reach));
        if (tip.length) pushAll(keep, tip);
        continue;
      }
      pushAll(keep, paths);
    }
    return keep.length ? union(keep) : [];
  });
}

const gapLayers = (heights: number[], z: number) => Math.max(0, Math.round(z / heights[Math.min(1, heights.length - 1)]));

function splitInterface(S: Paths[], over: Paths[], slices: Paths[], gap: number, bottomGap: number, n: number, nb: number): SupportLayers {
  const N = S.length;
  const base: Paths[] = Array.from({ length: N }, () => []);
  const iface: Paths[] = Array.from({ length: N }, () => []);
  const bottomIface: Paths[] = Array.from({ length: N }, () => []);
  for (let i = 0; i < N; i++) {
    if (!S[i].length) continue;
    let ov: Paths = [];
    for (let k = 1; k <= n; k++) {
      const j = i + k + gap;
      if (j < N && over[j].length) ov = ov.concat(over[j]);
    }
    const iz = ov.length ? intersection(S[i], union(ov)) : [];
    let rest = iz.length ? difference(S[i], iz) : S[i];
    // bottom interface: support resting on the model
    let bz: Paths = [];
    if (nb > 0 && rest.length) {
      let model: Paths = [];
      for (let k = 1; k <= nb; k++) {
        const j = i - k - bottomGap;
        if (j >= 0 && slices[j].length) model = model.concat(slices[j]);
      }
      bz = model.length ? intersection(rest, union(model)) : [];
      if (bz.length) rest = difference(rest, bz);
    }
    iface[i] = iz;
    bottomIface[i] = bz;
    base[i] = rest;
  }
  return { base, iface, bottomIface };
}

/** Snap a region outward to a square grid (Grid style: blocky, stable support). */
function snapToGrid(region: Paths, cell: number): Paths {
  const b = bounds(region);
  if (!isFinite(b.minX)) return [];
  const x0 = Math.floor(b.minX / SCALE / cell) * cell, y0 = Math.floor(b.minY / SCALE / cell) * cell;
  const cells: Paths = [];
  const probe = (x: number, y: number) => inside(x, y, region);
  for (let y = y0; y < b.maxY / SCALE; y += cell) for (let x = x0; x < b.maxX / SCALE; x += cell) {
    // a cell is taken when its centre or a corner lies in the region
    if (probe(x + cell / 2, y + cell / 2) || probe(x, y) || probe(x + cell, y) || probe(x, y + cell) || probe(x + cell, y + cell)) {
      cells.push([{ X: Math.round(x * SCALE), Y: Math.round(y * SCALE) }, { X: Math.round((x + cell) * SCALE), Y: Math.round(y * SCALE) },
        { X: Math.round((x + cell) * SCALE), Y: Math.round((y + cell) * SCALE) }, { X: Math.round(x * SCALE), Y: Math.round((y + cell) * SCALE) }]);
    }
  }
  return cells.length ? union(cells) : [];
}

/** Normal supports: project overhangs straight down, keeping clear of the model. */
export function generateSupport(slices: Paths[], heights: number[], over: Paths[], p: SupportParams): SupportLayers {
  const N = slices.length;
  if (N < 2) return { base: Array.from({ length: N }, () => []), iface: Array.from({ length: N }, () => []) };
  const gap = gapLayers(heights, p.topZDistance);
  const bottomGap = gapLayers(heights, p.bottomZDistance ?? p.topZDistance);
  const grid = p.style !== 'snug';
  let cur: Paths = [];
  let shadow: Paths = []; // projection of the overhangs above, for "Z overrides X/Y"
  const S: Paths[] = Array.from({ length: N }, () => []);
  for (let i = N - 2; i >= 0; i--) {
    const src = i + 1 + gap < N ? over[i + 1 + gap] : [];
    if (src.length) {
      let add = src;
      if (p.expansion) add = offset(add, p.expansion);
      if (grid) add = snapToGrid(add, Math.max(2, p.lineWidth * 6));
      cur = union(cur, add);
      if (p.topOverridesXY) shadow = union(shadow, src);
    }
    if (!cur.length) continue;
    const xy = i === 0 ? (p.firstLayerGap ?? p.xyDistance) : p.xyDistance;
    let keepOut = offset(slices[i], xy);
    if (p.topOverridesXY && shadow.length) keepOut = union(difference(keepOut, shadow), slices[i]);
    cur = difference(cur, keepOut);
    if (p.blocked?.[i]?.length) cur = difference(cur, p.blocked[i]);
    let blocked: Paths = [];
    for (let k = 1; k <= bottomGap && i - k >= 0; k++) blocked = blocked.concat(slices[i - k]);
    S[i] = opening(blocked.length ? difference(cur, union(blocked)) : cur, p.lineWidth * 0.5);
  }
  if (p.buildPlateOnly) {
    for (let i = 1; i < N; i++) S[i] = S[i].length && S[i - 1].length ? intersection(S[i], offset(S[i - 1], 0.01)) : [];
  }
  const nb = p.bottomInterfaceLayers === undefined ? 0 : p.bottomInterfaceLayers < 0 ? p.interfaceLayers : p.bottomInterfaceLayers;
  return splitInterface(S, over, slices, gap, bottomGap, p.interfaceLayers, nb);
}

// ---------------------------------------------------------------- tree supports

interface Node { x: number; y: number; r: number; dead?: boolean; /** Z of the tip the branch started at. */ top?: number }

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
function sampleTips(region: Paths, spacing: number, along = spacing): [number, number][] {
  const out: [number, number][] = [];
  const b = bounds(region);
  if (!isFinite(b.minX)) return out;
  const x0 = b.minX / SCALE, y0 = b.minY / SCALE, x1 = b.maxX / SCALE, y1 = b.maxY / SCALE;
  for (let y = y0 + spacing / 2; y < y1; y += spacing) for (let x = x0 + along / 2; x < x1; x += along) if (inside(x, y, region)) out.push([x, y]);
  if (!out.length) { const p = region[0][0]; out.push([p.X / SCALE, p.Y / SCALE]); }
  return out;
}

/** Tree style → tip / trunk scale, merge reach and smoothing. */
export function treeStyle(style: string): { tip: number; trunk: number; attract: number; organic: boolean; hybrid: boolean } {
  switch (style) {
    case 'tree_slim': return { tip: 0.8, trunk: 0.7, attract: 3, organic: false, hybrid: false };
    case 'tree_strong': return { tip: 1.25, trunk: 1.4, attract: 3, organic: false, hybrid: false };
    case 'tree_hybrid': return { tip: 1, trunk: 1, attract: 3, organic: false, hybrid: true };
    case 'tree_organic': return { tip: 1, trunk: 1.1, attract: 5, organic: true, hybrid: false };
    default: return { tip: 1, trunk: 1, attract: 3, organic: false, hybrid: false };
  }
}

/**
 * Tree supports: tips seeded under overhangs grow downward, steering around the model
 * (at most `branchAngle` per layer), attracting each other and merging into thicker trunks.
 * Hybrid style supports large flat overhangs with normal support columns instead of tips.
 */
export function generateTreeSupport(slices: Paths[], heights: number[], over: Paths[], p: TreeParams): SupportLayers {
  const N = slices.length;
  const S: Paths[] = Array.from({ length: N }, () => []);
  if (N < 2) return { base: S, iface: S.map(() => []) };
  const st = treeStyle(p.style ?? 'default');
  const gap = gapLayers(heights, p.topZDistance);
  const bottomGap = gapLayers(heights, p.bottomZDistance ?? p.topZDistance);
  const tan = Math.tan((Math.max(5, Math.min(80, p.branchAngle)) * Math.PI) / 180);
  const grow = Math.tan((Math.max(0, Math.min(15, p.diameterAngle ?? 5)) * Math.PI) / 180);
  const rTip = (p.tipDiameter / 2) * st.tip, rMax = Math.max(rTip, (p.branchDiameter / 2) * st.trunk);
  // organic: merging moves at the preferred (slow) angle, below the maximum branch angle
  const slowTan = st.organic && p.slowAngle !== undefined ? Math.tan((Math.max(0, Math.min(p.slowAngle, Math.max(5, Math.min(80, p.branchAngle)) - 1e-6)) * Math.PI) / 180) : -1;
  const zAt: number[] = [];
  heights.reduce((z, h, k) => (zAt[k] = z + h), 0);
  let nodes: Node[] = [];
  // hybrid: large flat overhangs get normal columns
  let flatOver: Paths[] | null = null;
  if (st.hybrid) {
    const big = (o: Paths) => toExPolygons(o).filter((e) => Math.abs(area(e.contour)) > (p.branchDistance * 3) ** 2).flatMap(exToPaths);
    flatOver = over.map(big);
    over = over.map((o, i) => (flatOver![i].length ? difference(o, flatOver![i]) : o));
  }

  for (let i = N - 2; i >= 0; i--) {
    const h = heights[i + 1];
    const step = h * tan;
    const src = i + 1 + gap < N ? over[i + 1 + gap] : [];
    if (src.length) for (const [x, y] of sampleTips(src, p.branchDistance, st.organic && p.tipSpacingAlong ? p.tipSpacingAlong : p.branchDistance)) nodes.push({ x, y, r: rTip, top: zAt[i + 1] });
    if (!nodes.length) continue;

    // attraction: move toward nearest neighbour (merging branches)
    for (const n of nodes) {
      let best: Node | null = null, bd = Infinity;
      for (const m of nodes) {
        if (m === n) continue;
        const d = (m.x - n.x) ** 2 + (m.y - n.y) ** 2;
        if (d < bd) { bd = d; best = m; }
      }
      if (best && Math.sqrt(bd) < p.branchDistance * st.attract) {
        const d = Math.sqrt(bd), mv = Math.min(slowTan >= 0 ? h * slowTan : step * (st.organic ? 0.8 : 0.5), d / 2);
        if (d > 0) { n.x += ((best.x - n.x) / d) * mv; n.y += ((best.y - n.y) / d) * mv; }
      }
    }
    // merge overlapping nodes
    const merged: Node[] = [];
    for (const n of nodes) {
      const m = merged.find((q) => Math.hypot(q.x - n.x, q.y - n.y) < Math.max(q.r, n.r) * (st.organic ? 0.9 : 0.6));
      if (m) {
        const w = m.r * m.r + n.r * n.r;
        m.x = (m.x * m.r * m.r + n.x * n.r * n.r) / w; m.y = (m.y * m.r * m.r + n.y * n.r * n.r) / w;
        m.r = Math.min(rMax, Math.sqrt(w));
        m.top = Math.max(m.top ?? 0, n.top ?? 0);
      } else merged.push({ ...n });
    }
    nodes = merged;

    // avoidance: keep each branch clear of the model at this layer
    const xy = i === 0 ? (p.firstLayerGap ?? p.xyDistance) : p.xyDistance;
    const keepOut = slices[i].length ? offset(slices[i], xy) : [];
    const below = bottomGap > 0 ? union(Array.from({ length: bottomGap }, (_, k) => slices[i - k - 1] ?? []).flat()) : [];
    const alive: Node[] = [];
    for (const n of nodes) {
      n.r = Math.min(rMax, n.r + h * grow); // trunks thicken toward the bed
      const avoid = keepOut.length ? offset(keepOut, n.r) : [];
      if (avoid.length && inside(n.x, n.y, avoid)) {
        const [qx, qy] = nearestBoundary(n.x, n.y, avoid);
        const d = Math.hypot(qx - n.x, qy - n.y);
        if (d <= step * 1.5 + 1e-6) {
          const ux = d ? (qx - n.x) / d : 0, uy = d ? (qy - n.y) / d : 0;
          n.x = qx + ux * 0.05; n.y = qy + uy * 0.05;
        } else continue; // branch rests on the model surface here
      }
      if (below.length && inside(n.x, n.y, below)) continue; // keep the bottom Z gap above the model
      if (p.blocked?.[i]?.length && inside(n.x, n.y, p.blocked[i])) continue;
      alive.push(n);
    }
    nodes = alive;
    if (!nodes.length) continue;
    // tree support brim (Orca / Bambu): on the first layer each branch foot grows by the brim width;
    // auto: max(2, min(r + distance to top / r * 0.5, 12)) - r
    const brimOf = (n: Node) => {
      if (i !== 0 || !p.brim || st.organic) return 0;
      if (!p.brim.auto) return Math.max(0, p.brim.width);
      const dTop = Math.max(0, (n.top ?? zAt[0]) - zAt[0]);
      return Math.max(0, Math.max(2, Math.min(n.r + dTop / Math.max(n.r, 1e-3) * 0.5, 12)) - n.r);
    };
    const circles = union(nodes.map((n) => { const r = n.r + brimOf(n); return circle(n.x, n.y, r, r > n.r ? 32 : 16); }));
    S[i] = keepOut.length ? difference(circles, keepOut) : circles;
  }
  if (p.buildPlateOnly) {
    // keep only branches that reach the bed: each layer must sit on the one below (branches lean ≤ step)
    for (let i = 1; i < N; i++) S[i] = S[i].length && S[i - 1].length ? intersection(S[i], offset(S[i - 1], heights[i] * tan + rTip)) : [];
  }
  if (flatOver && flatOver.some((o) => o.length)) {
    const normal = generateSupport(slices, heights, flatOver, { ...p, style: 'snug' });
    for (let i = 0; i < N; i++) {
      const col = union(normal.base[i], normal.iface[i]);
      if (col.length) S[i] = union(S[i], col);
    }
    // the interface split below sees both the tree tips' and the columns' overhangs
    over = over.map((o, i) => (flatOver![i].length ? union(o, flatOver![i]) : o));
  }
  const nb = p.bottomInterfaceLayers === undefined ? 0 : p.bottomInterfaceLayers < 0 ? p.interfaceLayers : p.bottomInterfaceLayers;
  return splitInterface(S, over, slices, gap, bottomGap, p.interfaceLayers, nb);
}
