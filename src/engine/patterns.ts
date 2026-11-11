// Stage 7b: the remaining infill patterns, plus sparse infill anchors (lines joined along the inner wall).
import { bounds, clipLines, SCALE, toInt } from './clipper';
import { linesFill } from './fill';
import type { Path, Paths, Polyline2 } from './types';
import { pushAll } from './util';

const toPoly = (p: Path, closed = false): Polyline2 => {
  const pts: number[] = [];
  for (const q of p) pts.push(q.X / SCALE, q.Y / SCALE);
  return { pts, closed };
};
const rot = (paths: Paths, ang: number): Paths => {
  const c = Math.cos(ang), s = Math.sin(ang);
  return paths.map((p) => p.map((q) => ({ X: Math.round(q.X * c - q.Y * s), Y: Math.round(q.X * s + q.Y * c) })));
};
const mmBounds = (region: Paths) => {
  const b = bounds(region);
  return { x0: b.minX / SCALE, y0: b.minY / SCALE, x1: b.maxX / SCALE, y1: b.maxY / SCALE };
};
/** Clip mm polylines (flat arrays) to a region. */
function clipPolys(polys: number[][], region: Paths): Polyline2[] {
  const lines: Paths = polys.filter((p) => p.length >= 4).map((p) => {
    const out: Path = [];
    for (let i = 0; i < p.length; i += 2) out.push({ X: toInt(p[i]), Y: toInt(p[i + 1]) });
    return out;
  });
  return clipLines(lines, region).map((p) => toPoly(p));
}
/** Generate polylines in a frame rotated by `angleDeg`, then rotate them back and clip. */
function inRotatedFrame(region: Paths, angleDeg: number, gen: (x0: number, y0: number, x1: number, y1: number) => number[][]): Polyline2[] {
  const a = (angleDeg * Math.PI) / 180;
  const rr = rot(region, -a);
  const b = mmBounds(rr);
  if (!isFinite(b.x0)) return [];
  const polys = gen(b.x0 - 1, b.y0 - 1, b.x1 + 1, b.y1 + 1);
  const lines: Paths = polys.filter((p) => p.length >= 4).map((p) => {
    const out: Path = [];
    for (let i = 0; i < p.length; i += 2) out.push({ X: toInt(p[i]), Y: toInt(p[i + 1]) });
    return out;
  });
  return clipLines(lines, rr).map((p) => toPoly(rot([p], a)[0]));
}

const frac = (x: number) => x - Math.floor(x);

/** Cubic: three line families at 0/60/120°, shifted with Z so the lattice forms cubes standing on a corner. */
export function cubicFill(region: Paths, spacing: number, z: number, baseAngle: number): Polyline2[] {
  const L = spacing * 3;
  const sh = z / L;
  return [[0, sh], [60, -sh], [120, sh]].flatMap(([a, ph]) => linesFill(region, L, baseAngle + a, false, frac(ph)));
}

/** Tri-hexagon (kagome): like triangles, but one family is shifted half a period so lines never meet three at a time. */
export function triHexagonFill(region: Paths, spacing: number, baseAngle: number): Polyline2[] {
  const L = spacing * 3;
  return [[0, 0], [60, 0], [120, 0.5]].flatMap(([a, ph]) => linesFill(region, L, baseAngle + a, false, ph));
}

/** 2D honeycomb: zig-zag rows plus vertical connectors forming regular hexagons (side m). */
export function honeycombFill(region: Paths, width: number, density: number, baseAngle: number): Polyline2[] {
  const m = (2 * width) / (Math.sqrt(3) * Math.max(0.01, density));
  const dx = (Math.sqrt(3) / 2) * m;
  return inRotatedFrame(region, baseAngle, (x0, y0, x1, y1) => {
    const out: number[][] = [];
    const k0 = Math.floor(x0 / dx) - 1, k1 = Math.ceil(x1 / dx) + 1;
    const r0 = Math.floor(y0 / (1.5 * m)) - 1, r1 = Math.ceil(y1 / (1.5 * m)) + 1;
    for (let r = r0; r <= r1; r++) {
      const yr = r * 1.5 * m;
      const row: number[] = [];
      for (let k = k0; k <= k1; k++) row.push(k * dx, yr + (((k + r) % 2 + 2) % 2 === 0 ? 0 : 0.5 * m));
      out.push(row);
      for (let k = k0; k <= k1; k++) if (((k + r) % 2 + 2) % 2 === 1) out.push([k * dx, yr + 0.5 * m, k * dx, yr + 1.5 * m]);
    }
    return out;
  });
}

/** 3D honeycomb: mirrored zig-zags whose amplitude follows Z, alternating X/Y each half period (truncated octahedra). */
export function honeycomb3dFill(region: Paths, spacing: number, z: number, baseAngle: number): Polyline2[] {
  const g = spacing * 1.15;
  const t = frac(z / (2 * g));
  const alongX = t < 0.5;
  const tri = 1 - Math.abs(4 * frac(z / (2 * g) * 2) - 2) / 2; // 0..1..0 triangle wave per half period
  const amp = (g / 4) * tri;
  return inRotatedFrame(region, baseAngle + (alongX ? 0 : 90), (x0, y0, x1, y1) => {
    const out: number[][] = [];
    const k0 = Math.floor(x0 / (g / 2)) - 1, k1 = Math.ceil(x1 / (g / 2)) + 1;
    for (let j = Math.floor(y0 / g) - 1; j <= Math.ceil(y1 / g) + 1; j++) {
      const row: number[] = [];
      const mirror = (j % 2 + 2) % 2 === 0 ? 1 : -1;
      for (let k = k0; k <= k1; k++) row.push(k * (g / 2), j * g + ((k % 2 + 2) % 2 === 0 ? 1 : -1) * amp * mirror);
      out.push(row);
    }
    return out;
  });
}

/** Hilbert curve d → (x, y) on a 2^order grid. */
function hilbertPoint(order: number, d: number): [number, number] {
  let x = 0, y = 0, t = d;
  for (let s = 1; s < 1 << order; s *= 2) {
    const rx = 1 & (t / 2), ry = 1 & (t ^ rx);
    if (ry === 0) { if (rx === 1) { x = s - 1 - x; y = s - 1 - y; } [x, y] = [y, x]; }
    x += s * rx; y += s * ry; t = Math.floor(t / 4);
  }
  return [x, y];
}
/** Hilbert curve across the region, cell size = spacing, anchored to the plate origin. */
export function hilbertFill(region: Paths, spacing: number): Polyline2[] {
  const b = mmBounds(region);
  if (!isFinite(b.x0)) return [];
  const gx0 = Math.floor(b.x0 / spacing), gy0 = Math.floor(b.y0 / spacing);
  const cells = Math.max(Math.ceil(b.x1 / spacing) - gx0, Math.ceil(b.y1 / spacing) - gy0) + 1;
  const order = Math.max(1, Math.min(11, Math.ceil(Math.log2(cells))));
  const n = 1 << order;
  const pts: number[] = [];
  for (let d = 0; d < n * n; d++) {
    const [x, y] = hilbertPoint(order, d);
    pts.push((gx0 + x + 0.5) * spacing, (gy0 + y + 0.5) * spacing);
  }
  return clipPolys([pts], region);
}

/** Archimedean chords: a spiral r = spacing·θ/2π around the region centre, as chords about one spacing long. */
export function archimedeanFill(region: Paths, spacing: number, centre?: [number, number]): Polyline2[] {
  const b = mmBounds(region);
  if (!isFinite(b.x0)) return [];
  const cx = centre ? centre[0] : (b.x0 + b.x1) / 2, cy = centre ? centre[1] : (b.y0 + b.y1) / 2;
  const rMax = Math.max(Math.hypot(b.x0 - cx, b.y0 - cy), Math.hypot(b.x1 - cx, b.y0 - cy), Math.hypot(b.x0 - cx, b.y1 - cy), Math.hypot(b.x1 - cx, b.y1 - cy)) + spacing;
  const a = spacing / (2 * Math.PI);
  const pts: number[] = [cx, cy];
  for (let th = 0.5; a * th < rMax;) {
    const r = a * th;
    pts.push(cx + r * Math.cos(th), cy + r * Math.sin(th));
    th += Math.max(0.05, Math.min(0.6, spacing / Math.max(r, spacing)));
  }
  return clipPolys([pts], region);
}

/** Octagram spiral: an eight-pointed star wound outward by one spacing per turn. */
export function octagramFill(region: Paths, spacing: number, centre?: [number, number]): Polyline2[] {
  const b = mmBounds(region);
  if (!isFinite(b.x0)) return [];
  const cx = centre ? centre[0] : (b.x0 + b.x1) / 2, cy = centre ? centre[1] : (b.y0 + b.y1) / 2;
  const rMax = Math.max(Math.hypot(b.x0 - cx, b.y0 - cy), Math.hypot(b.x1 - cx, b.y0 - cy), Math.hypot(b.x0 - cx, b.y1 - cy), Math.hypot(b.x1 - cx, b.y1 - cy)) + spacing;
  const pts: number[] = [];
  const perTurn = 16;
  for (let k = 0; ; k++) {
    const th = (k / perTurn) * 2 * Math.PI;
    const base = spacing * (k / perTurn);
    if (base > rMax) break;
    const r = base * (k % 2 === 0 ? 1 : 0.62) + spacing * 0.3;
    pts.push(cx + r * Math.cos(th), cy + r * Math.sin(th));
  }
  return clipPolys([pts], region);
}

/** Cross hatch: blocks of layers at alternating directions, so the infill locks crosswise without line crossings in a layer. */
export function crossHatchFill(region: Paths, spacing: number, z: number, baseAngle: number): Polyline2[] {
  const block = Math.max(spacing * 2, 1);
  const flip = Math.floor(z / block) % 2 === 1;
  return linesFill(region, spacing, baseAngle + (flip ? 90 : 0));
}

// ---------------------------------------------------------------------------------------------------------------
// Sparse infill anchors

interface Loop { pts: number[]; cum: number[]; len: number }
function loopsOf(region: Paths): Loop[] {
  return region.map((p) => {
    const pts: number[] = [];
    for (const q of p) pts.push(q.X / SCALE, q.Y / SCALE);
    const cum = [0];
    const n = pts.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      cum.push(cum[i] + Math.hypot(pts[j * 2] - pts[i * 2], pts[j * 2 + 1] - pts[i * 2 + 1]));
    }
    return { pts, cum, len: cum[n] };
  }).filter((l) => l.len > 0);
}

/** Position of a point projected on the nearest loop: loop index and arc length. */
function project(loops: Loop[], grid: Map<string, [number, number][]>, cell: number, x: number, y: number, tol: number): { loop: number; s: number } | null {
  let best: { loop: number; s: number } | null = null, bd = tol * tol;
  const cx = Math.floor(x / cell), cy = Math.floor(y / cell);
  for (let gx = cx - 1; gx <= cx + 1; gx++) for (let gy = cy - 1; gy <= cy + 1; gy++) {
    for (const [li, si] of grid.get(`${gx},${gy}`) ?? []) {
      const L = loops[li], n = L.pts.length / 2, sj = (si + 1) % n;
      const ax = L.pts[si * 2], ay = L.pts[si * 2 + 1], bx = L.pts[sj * 2], by = L.pts[sj * 2 + 1];
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
      const t = l2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
      const d = (ax + t * dx - x) ** 2 + (ay + t * dy - y) ** 2;
      if (d < bd) { bd = d; best = { loop: li, s: L.cum[si] + t * Math.sqrt(l2) }; }
    }
  }
  return best;
}
/** Points of a loop between arc positions s0 → s1 going forward (wrapping), excluding the endpoints themselves. */
function arcPoints(L: Loop, s0: number, s1: number): number[] {
  const n = L.pts.length / 2;
  const out: number[] = [];
  const span = ((s1 - s0) % L.len + L.len) % L.len;
  for (let i = 1; i <= n; i++) {
    const s = L.cum[i % n === 0 ? 0 : i];
    const rel = ((s - s0) % L.len + L.len) % L.len;
    if (rel > 1e-6 && rel < span - 1e-6) out.push(rel, i % n);
  }
  const pairs: [number, number][] = [];
  for (let k = 0; k < out.length; k += 2) pairs.push([out[k], out[k + 1]]);
  pairs.sort((a, b) => a[0] - b[0]);
  return pairs.flatMap(([, i]) => [L.pts[i * 2], L.pts[i * 2 + 1]]);
}
function pointAt(L: Loop, s: number): [number, number] {
  s = ((s % L.len) + L.len) % L.len;
  const n = L.pts.length / 2;
  let i = 0;
  while (i < n - 1 && L.cum[i + 1] < s) i++;
  const j = (i + 1) % n, seg = L.cum[i + 1] - L.cum[i];
  const t = seg ? (s - L.cum[i]) / seg : 0;
  return [L.pts[i * 2] + t * (L.pts[j * 2] - L.pts[i * 2]), L.pts[i * 2 + 1] + t * (L.pts[j * 2 + 1] - L.pts[i * 2 + 1])];
}

/**
 * Joins open infill lines whose ends sit close together on the region boundary with a short walk along it
 * (≤ anchorMax), and extends the remaining free ends along the boundary by up to anchorLen.
 */
export function anchorInfill(lines: Polyline2[], region: Paths, width: number, anchorLen: number, anchorMax: number): Polyline2[] {
  const open = lines.filter((l) => !l.closed && l.pts.length >= 4);
  if (open.length < 1 || (anchorLen <= 0 && anchorMax <= 0)) return lines;
  const loops = loopsOf(region);
  if (!loops.length) return lines;
  const cell = Math.max(1, width * 4);
  const grid = new Map<string, [number, number][]>();
  loops.forEach((L, li) => {
    const n = L.pts.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const gx0 = Math.floor(Math.min(L.pts[i * 2], L.pts[j * 2]) / cell), gx1 = Math.floor(Math.max(L.pts[i * 2], L.pts[j * 2]) / cell);
      const gy0 = Math.floor(Math.min(L.pts[i * 2 + 1], L.pts[j * 2 + 1]) / cell), gy1 = Math.floor(Math.max(L.pts[i * 2 + 1], L.pts[j * 2 + 1]) / cell);
      for (let gx = gx0; gx <= gx1; gx++) for (let gy = gy0; gy <= gy1; gy++) {
        const k = `${gx},${gy}`;
        const l = grid.get(k); if (l) l.push([li, i]); else grid.set(k, [[li, i]]);
      }
    }
  });
  // endpoints on the boundary: line index, which end (0 start / 1 end), loop, arc position
  interface End { line: number; end: 0 | 1; loop: number; s: number; used: boolean }
  const ends: End[] = [];
  open.forEach((l, i) => {
    const n = l.pts.length;
    for (const e of [0, 1] as const) {
      const x = e ? l.pts[n - 2] : l.pts[0], y = e ? l.pts[n - 1] : l.pts[1];
      const p = project(loops, grid, cell, x, y, width * 0.75 + 0.05);
      if (p) ends.push({ line: i, end: e, loop: p.loop, s: p.s, used: false });
    }
  });
  // candidate joins: neighbours along each loop
  const byLoop = new Map<number, End[]>();
  for (const e of ends) { const l = byLoop.get(e.loop); if (l) l.push(e); else byLoop.set(e.loop, [e]); }
  const cands: { a: End; b: End; d: number }[] = [];
  for (const [li, es] of byLoop) {
    es.sort((p, q) => p.s - q.s);
    const len = loops[li].len;
    for (let k = 0; k < es.length && es.length > 1; k++) {
      const a = es[k], b = es[(k + 1) % es.length];
      if (a === b || a.line === b.line) continue;
      const d = ((b.s - a.s) % len + len) % len;
      if (d <= anchorMax) cands.push({ a, b, d });
    }
  }
  cands.sort((p, q) => p.d - q.d);
  // union-find over lines so joins never close a chain into a loop
  const parent = open.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const links = new Map<string, number[]>(); // "line:end" → bridge points from that end to the partner
  const partner = new Map<string, string>();
  for (const c of cands) {
    if (c.a.used || c.b.used) continue;
    const ra = find(c.a.line), rb = find(c.b.line);
    if (ra === rb) continue;
    parent[ra] = rb;
    c.a.used = c.b.used = true;
    const L = loops[c.a.loop];
    const bridge = arcPoints(L, c.a.s, c.b.s);
    const ka = `${c.a.line}:${c.a.end}`, kb = `${c.b.line}:${c.b.end}`;
    links.set(ka, bridge);
    const rev: number[] = [];
    for (let i = bridge.length - 2; i >= 0; i -= 2) rev.push(bridge[i], bridge[i + 1]);
    links.set(kb, rev);
    partner.set(ka, kb); partner.set(kb, ka);
  }
  // single-sided anchors on free ends, kept short of the neighbouring ends
  const tails = new Map<string, number[]>();
  if (anchorLen > 0) for (const [li, es] of byLoop) {
    const L = loops[li];
    for (let k = 0; k < es.length; k++) {
      const e = es[k];
      if (e.used) continue;
      const next = es.length > 1 ? es[(k + 1) % es.length] : null, prev = es.length > 1 ? es[(k - 1 + es.length) % es.length] : null;
      const gapF = next ? ((next.s - e.s) % L.len + L.len) % L.len : L.len;
      const gapB = prev ? ((e.s - prev.s) % L.len + L.len) % L.len : L.len;
      const fwd = gapF >= gapB;
      const room = Math.max(0, (fwd ? gapF : gapB) / 2 - width);
      const len = Math.min(anchorLen, anchorMax > 0 ? anchorMax : anchorLen, room);
      if (len < width) continue;
      const s1 = fwd ? e.s + len : e.s - len;
      const pts = fwd ? arcPoints(L, e.s, s1) : (() => { const a = arcPoints(L, s1, e.s); const r: number[] = []; for (let i = a.length - 2; i >= 0; i -= 2) r.push(a[i], a[i + 1]); return r; })();
      tails.set(`${e.line}:${e.end}`, [...pts, ...pointAt(L, s1)]);
    }
  }
  // walk chains
  const done = new Uint8Array(open.length);
  const out: Polyline2[] = lines.filter((l) => l.closed || l.pts.length < 4);
  const reversed = (p: number[]) => { const r: number[] = []; for (let i = p.length - 2; i >= 0; i -= 2) r.push(p[i], p[i + 1]); return r; };
  for (let start = 0; start < open.length; start++) {
    if (done[start]) continue;
    // go to one end of the chain
    let cur = start, enterEnd: 0 | 1 = 0;
    for (let guard = 0; guard < open.length; guard++) {
      const p = partner.get(`${cur}:${enterEnd}`);
      if (!p) break;
      const [ln, en] = p.split(':').map(Number);
      if (ln === start) break;
      cur = ln; enterEnd = (1 - en) as 0 | 1;
    }
    // cur's free end is enterEnd: walk forward from it
    const pts: number[] = [];
    const head = tails.get(`${cur}:${enterEnd}`);
    if (head) pushAll(pts, reversed(head));
    let end: 0 | 1 = enterEnd;
    for (let guard = 0; guard <= open.length; guard++) {
      done[cur] = 1;
      const seg = end === 0 ? open[cur].pts : reversed(open[cur].pts);
      pushAll(pts, seg);
      const exit = (1 - end) as 0 | 1;
      const key = `${cur}:${exit}`;
      const p = partner.get(key);
      if (!p) { const tail = tails.get(key); if (tail) pushAll(pts, tail); break; }
      pushAll(pts, links.get(key)!);
      const [ln, en] = p.split(':').map(Number);
      if (done[ln]) break;
      cur = ln; end = en as 0 | 1;
    }
    out.push({ pts, closed: false });
  }
  return out;
}
