// Hanex wave planner: one overhang component → ordered, extruding toolpath.
//
//  A. distance field  D (geodesic, |∇D| = 1/F) by Fast Marching over overhang ∪ anchor band
//  B. wavefronts      iso-contours of D at k·Δd, clipped to the printable region
//  C. sequencing      level by level, nearest-end first, short gaps bridged by extruding links
//  D. extrusion       sheet volume Δd·h per mm, modulated by local curvature
import { clipLines, difference, intersection, offset, union } from '../../../engine/clipper';
import type { Paths } from '../../../engine/types';
import { isoContours } from './contour';
import { fastMarch, rasterize, type Seed } from './fmm';
import {
  arcLengths, bboxOf, curvatureRadii, dist, distToSegment, pointAt, pointInRings, polylineLength, simplify, subPolyline,
  toPath, toPaths, toRings, type Polyline, type Ring, type Vec2,
} from './geom';
import { filamentArea, gridStep, waveStep, type HanexProfile } from './profile';
import type { OverhangComponent } from './detect';
import { rectRing } from './shapes';

export type MoveKind = 'wave' | 'link' | 'rim' | 'travel';

export interface HanexMove {
  x: number;
  y: number;
  kind: MoveKind;
  /** Filament length for this move (mm, relative E); 0 for travel. */
  e: number;
  /** Feedrate, mm/s. */
  f: number;
  /** Flow multiplier applied (curvature modulation × flowRatio). */
  flow: number;
  /** Nominal bead cross-section (mm²) before the flow multiplier: sheet step × sheet height, or the rim bead. */
  area?: number;
  /** Wavefront index (D = k·Δd) for wave moves. */
  k?: number;
}

export interface WaveArc { k: number; pts: Polyline }

export interface RegionPlan {
  seedMode: 'point' | 'edge';
  seeds: Seed[];
  step: number;
  gridStep: number;
  /** Arcs in print order (already oriented). */
  arcs: WaveArc[];
  rim: Polyline[];
  moves: HanexMove[];
  /** Printable region (overhang ∪ anchor band, inset by half a bead), mm rings. */
  printable: Ring[];
  overhangRings: Ring[];
  anchorRings: Ring[];
  stats: {
    arcs: number; levels: number; waveLength: number; linkLength: number; rimLength: number;
    travels: number; travelLength: number; volume: number; overhangArea: number; maxD: number; minFlow: number;
  };
  warnings: string[];
}

/** Join open polylines whose ends meet (Clipper splits a closed ring at its start vertex). */
function joinChains(lines: Polyline[], tol = 1e-3): Polyline[] {
  const out = lines.map((l) => l.slice());
  for (let merged = true; merged;) {
    merged = false;
    outer: for (let a = 0; a < out.length; a++) for (let b = 0; b < out.length; b++) {
      if (a === b) continue;
      const A = out[a], B = out[b];
      if (dist(A[A.length - 1], B[0]) < tol) { out[a] = [...A, ...B.slice(1)]; out.splice(b, 1); merged = true; break outer; }
      if (dist(A[A.length - 1], B[B.length - 1]) < tol) { out[a] = [...A, ...B.slice(0, -1).reverse()]; out.splice(b, 1); merged = true; break outer; }
    }
  }
  return out;
}

const closeRing = (r: Ring): Polyline => [...r, r[0]];

/** Interface between overhang and anchor: the overhang's boundary where it touches solid. */
export function anchorInterface(overhang: Paths, anchor: Paths): Polyline[] {
  const lines = toPaths(toRings(overhang).map(closeRing));
  return joinChains(toRings(clipLines(lines, offset(anchor, 0.02)))).filter((l) => polylineLength(l) > 1e-3);
}

function segmentInside(a: Vec2, b: Vec2, rings: Ring[]): boolean {
  for (let t = 0.125; t < 1; t += 0.125) if (!pointInRings(a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), rings)) return false;
  return true;
}

/** Gaps up to this many bead widths between consecutive arcs are printed as extruding links, not travels. */
const LINK_MAX = 3;

export interface PlanOptions {
  /** Where the nozzle is when the region starts (for choosing the first arc direction). */
  start?: Vec2;
  /** Propagation speed F(x, y) (default isotropic 1). */
  speed?: (x: number, y: number) => number;
}

export function planComponent(comp: OverhangComponent, p: HanexProfile, opts: PlanOptions = {}): RegionPlan {
  const w = p.lineWidth, step = waveStep(p), h = gridStep(p);
  const warnings: string[] = [];
  const overhangRings = toRings(comp.overhang), anchorRings = toRings(comp.anchor);

  // printable region: overhang plus a lead-in band of anchor, inset by half a bead (keeps the bead out of holes and off free edges)
  const band = intersection(comp.anchor, offset(comp.overhang, p.leadIn + w / 2));
  const printablePaths = offset(union(comp.overhang, band), -w / 2);
  const printable = toRings(printablePaths);
  // links run along the region edge, so test them against a hair-wider region
  const linkable = toRings(offset(printablePaths, 0.005));
  // FMM domain: a little wider than the printable region so contours reach its boundary
  const reach = Math.max(p.leadIn, p.startRadius) + w + 8 * h;
  const domain = union(comp.overhang, intersection(comp.anchor, offset(comp.overhang, reach)));

  // seeds
  const iface = anchorInterface(comp.overhang, comp.anchor);
  let mode: 'point' | 'edge' = p.seedMode === 'auto' ? (iface.length === 1 ? 'point' : 'edge') : p.seedMode;
  let seeds: Seed[] = [];
  if (!iface.length) {
    warnings.push('overhang does not touch any anchor: no wave can start here');
  } else if (mode === 'point') {
    const chain = iface.reduce((a, b) => (polylineLength(b) > polylineLength(a) ? b : a));
    const L = polylineLength(chain);
    const m = pointAt(chain, L / 2), a = pointAt(chain, L / 2 - 0.05), b = pointAt(chain, L / 2 + 0.05);
    const t = [b[0] - a[0], b[1] - a[1]], tl = Math.hypot(t[0], t[1]) || 1;
    let n: Vec2 = [-t[1] / tl, t[0] / tl];
    const anchorRingsInner = anchorRings;
    if (!pointInRings(m[0] + 0.05 * n[0], m[1] + 0.05 * n[1], anchorRingsInner)) n = [-n[0], -n[1]];
    let r = p.startRadius;
    while (r > 0.01 && !pointInRings(m[0] + r * n[0], m[1] + r * n[1], anchorRingsInner)) r /= 2;
    seeds = [{ kind: 'point', p: [m[0] + r * n[0], m[1] + r * n[1]] }];
  } else {
    seeds = iface.map((pts) => ({ kind: 'polyline' as const, pts }));
  }
  if (!seeds.length) mode = 'edge';

  // A. distance field
  const domainRings = toRings(domain);
  const g = rasterize(domainRings, h);
  let speed: Float32Array | undefined;
  if (opts.speed) {
    speed = new Float32Array(g.nx * g.ny);
    for (let j = 0; j < g.ny; j++) for (let i = 0; i < g.nx; i++) speed[j * g.nx + i] = opts.speed(g.x0 + i * h, g.y0 + j * h);
  }
  const D = seeds.length ? fastMarch(g, seeds, { speed }) : new Float64Array(g.nx * g.ny).fill(Infinity);
  let maxD = 0, unreached = 0;
  for (let id = 0; id < D.length; id++) {
    if (!g.inside[id]) continue;
    if (Number.isFinite(D[id])) maxD = Math.max(maxD, D[id]);
    else unreached++;
  }
  if (seeds.length && unreached) warnings.push(`${unreached} grid nodes of the overhang cannot be reached from the anchor`);

  // B. wavefronts → clipped arcs with lead-in/lead-out onto the anchor
  const inAir = (q: Vec2) => pointInRings(q[0], q[1], overhangRings);
  const byLevel = new Map<number, Polyline[]>();
  for (const c of seeds.length ? isoContours(g, D, step) : []) {
    const pieces = toRings(clipLines([toPath(c.pts)], printablePaths));
    for (let pc of pieces) {
      if (pc.length < 2) continue;
      const air = pc.map(inAir);
      // midpoints too: a long chord can cross the overhang between two anchor vertices
      const anyAir = air.some(Boolean) || pc.slice(1).some((q, i) => inAir([(q[0] + pc[i][0]) / 2, (q[1] + pc[i][1]) / 2]));
      if (!anyAir) continue; // lies wholly on solid: the normal slicer already prints there
      const s = arcLengths(pc), total = s[s.length - 1];
      const first = air.indexOf(true), last = air.lastIndexOf(true);
      const s0 = first > 0 ? Math.max(0, s[first] - p.leadIn) : 0;
      const s1 = last >= 0 && last < pc.length - 1 ? Math.min(total, s[last] + p.leadIn) : total;
      if (s0 > 0 || s1 < total) pc = subPolyline(pc, s0, s1);
      pc = simplify(pc, 0.005);
      if (polylineLength(pc) < w / 2) continue;
      const l = byLevel.get(c.k);
      if (l) l.push(pc); else byLevel.set(c.k, [pc]);
    }
  }

  // C. sequencing
  const moves: HanexMove[] = [];
  const arcs: WaveArc[] = [];
  const Af = filamentArea(p);
  const sheetArea = step * p.sheetHeight;
  let cur: Vec2 | null = opts.start ?? null;
  let waveLength = 0, linkLength = 0, travels = 0, travelLength = 0, volume = 0, minFlow = 1;
  const travelTo = (q: Vec2) => {
    if (cur) { travels++; travelLength += dist(cur, q); }
    moves.push({ x: q[0], y: q[1], kind: 'travel', e: 0, f: p.travelSpeed, flow: 0 });
    cur = q;
  };
  const extrude = (pl: Polyline, kind: 'wave' | 'rim', k?: number) => {
    const area = kind === 'rim' ? (w - p.sheetHeight) * p.sheetHeight + (Math.PI * p.sheetHeight ** 2) / 4 : sheetArea;
    const R = kind === 'wave' ? curvatureRadii(pl, w) : null;
    for (let i = 1; i < pl.length; i++) {
      const len = dist(pl[i - 1], pl[i]);
      const mod = R ? Math.min(1, Math.max(p.flowFloor, Math.min(R[i - 1], R[i]) / p.rNominal)) : 1;
      minFlow = Math.min(minFlow, mod);
      const flow = p.flowRatio * mod;
      const vol = area * flow * len;
      volume += vol;
      moves.push({ x: pl[i][0], y: pl[i][1], kind, e: vol / Af, f: kind === 'rim' ? p.rimSpeed : p.waveSpeed, flow, k, area });
    }
    if (kind === 'wave') waveLength += polylineLength(pl);
    cur = pl[pl.length - 1];
  };
  const goTo = (q: Vec2) => {
    if (cur && dist(cur, q) < 1e-6) return;
    if (cur && dist(cur, q) <= LINK_MAX * w && segmentInside(cur, q, linkable)) {
      const len = dist(cur, q), vol = sheetArea * p.flowRatio * len;
      volume += vol; linkLength += len;
      moves.push({ x: q[0], y: q[1], kind: 'link', e: vol / Af, f: p.waveSpeed, flow: p.flowRatio, area: sheetArea });
      cur = q;
    } else travelTo(q);
  };
  const orient = (pl: Polyline): Polyline => {
    if (!cur) return pl;
    const closed = dist(pl[0], pl[pl.length - 1]) < 1e-6;
    if (closed) {
      // a full loop (e.g. round an island anchor): start at the vertex nearest the nozzle
      let bi = 0, bd = Infinity;
      pl.forEach((q, i) => { const d = dist(q, cur!); if (d < bd) { bd = d; bi = i; } });
      const body = pl.slice(0, -1);
      const r = [...body.slice(bi), ...body.slice(0, bi)];
      return [...r, r[0]];
    }
    return dist(cur, pl[pl.length - 1]) < dist(cur, pl[0]) ? pl.slice().reverse() : pl;
  };
  const nearest = (list: Polyline[]) => {
    if (!cur) return 0;
    let bi = 0, bd = Infinity;
    list.forEach((pl, i) => {
      const closed = dist(pl[0], pl[pl.length - 1]) < 1e-6;
      const d = closed ? Math.min(...pl.map((q) => dist(q, cur!))) : Math.min(dist(pl[0], cur!), dist(pl[pl.length - 1], cur!));
      if (d < bd) { bd = d; bi = i; }
    });
    return bi;
  };
  // A front split by a hole gives several pieces per level. Printing level by level would cross the
  // hole on every level; instead a piece may be printed as soon as the pieces of the previous level it
  // rests on are down (its dependencies), and among ready pieces the nearest goes first. One side of the
  // hole is then swept for many levels, and the pieces behind the hole wait until both sides arrive.
  const levels = [...byLevel.keys()].sort((a, b) => a - b);
  type Piece = { k: number; pts: Polyline; deps: number[]; done: boolean; bb: { x0: number; y0: number; x1: number; y1: number } };
  const pieces: Piece[] = [];
  const idsAt = new Map<number, number[]>();
  for (const k of levels) for (const pts of byLevel.get(k)!) {
    idsAt.set(k, [...(idsAt.get(k) ?? []), pieces.length]);
    pieces.push({ k, pts, deps: [], done: false, bb: bboxOf([pts]) });
  }
  const touchR = 1.5 * step;
  const touches = (a: Piece, b: Piece) => {
    if (a.bb.x0 > b.bb.x1 + touchR || b.bb.x0 > a.bb.x1 + touchR || a.bb.y0 > b.bb.y1 + touchR || b.bb.y0 > a.bb.y1 + touchR) return false;
    for (const q of a.pts) {
      if (q[0] < b.bb.x0 - touchR || q[0] > b.bb.x1 + touchR || q[1] < b.bb.y0 - touchR || q[1] > b.bb.y1 + touchR) continue;
      for (let i = 1; i < b.pts.length; i++) if (distToSegment(q, b.pts[i - 1], b.pts[i]) <= touchR) return true;
    }
    return false;
  };
  for (let li = 1; li < levels.length; li++) {
    for (const id of idsAt.get(levels[li])!) for (const pid of idsAt.get(levels[li - 1])!) if (touches(pieces[id], pieces[pid])) pieces[id].deps.push(pid);
  }
  for (let left = pieces.length; left > 0; left--) {
    const ready = pieces.map((pc, i) => i).filter((i) => !pieces[i].done && pieces[i].deps.every((d) => pieces[d].done));
    const pick = ready.length ? ready[nearest(ready.map((i) => pieces[i].pts))] : pieces.findIndex((pc) => !pc.done);
    const pc = pieces[pick];
    pc.done = true;
    const pl = orient(pc.pts);
    goTo(pl[0]);
    extrude(pl, 'wave', pc.k);
    arcs.push({ k: pc.k, pts: pl });
  }

  // rim: the free edges of the printable region (not the side against the anchor), after all waves
  let rim: Polyline[] = [];
  if (p.rim && arcs.length) {
    const bb = bboxOf(printable);
    const away = difference([toPath(rectRing(bb.x0 - 5, bb.y0 - 5, bb.x1 + 5, bb.y1 + 5))], offset(comp.anchor, w));
    rim = joinChains(toRings(clipLines(toPaths(printable.map(closeRing)), away))).filter((l) => polylineLength(l) >= w);
    const list = rim.slice();
    rim = [];
    while (list.length) {
      const pl = orient(list.splice(nearest(list), 1)[0]);
      goTo(pl[0]);
      extrude(pl, 'rim');
      rim.push(pl);
    }
  }

  return {
    seedMode: mode, seeds, step, gridStep: h, arcs, rim, moves, printable, overhangRings, anchorRings,
    stats: {
      arcs: arcs.length, levels: levels.length, waveLength, linkLength, rimLength: rim.reduce((s, l) => s + polylineLength(l), 0),
      travels, travelLength, volume, overhangArea: comp.area, maxD, minFlow,
    },
    warnings,
  };
}
