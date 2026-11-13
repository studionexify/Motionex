// Coaster sets: N flat plates of one outline shape, with a relief on top (raised, carved, or cut right
// through), and a case that follows the plate outline with a clearance gap and a finger notch.
// Geometry is exact: every outline, border and relief edge is a cut line of a planar tessellation (each
// cut point located on the true function, shared between cells), so plates come out CAD-clean.
import { planarPattern, sectionMul, type Design, type SectionKind } from './design';

export type ReliefMode = 'emboss' | 'deboss' | 'through';
export interface CoasterSet {
  shape: string;            // id in COASTER_SHAPES
  section: SectionKind; sides: number; depth: number;
  diameter: number;         // mm, across the corners
  thickness: number;        // plate, mm
  count: number;            // plates in the set
  mode: ReliefMode;
  border: number;           // plain rim around the relief, mm
  caseOn: boolean;
  gap: number;              // clearance between plate and case wall, mm
  wall: number;             // case wall, mm
  floor: number;            // case floor, mm
  notch: number;            // finger notch width, mm (0 = none)
}

/** Basic plate outlines (top view). Each maps onto the section engine, so every shape is exact. */
export const COASTER_SHAPES: { id: string; name: string; section: SectionKind; sides: number; depth: number }[] = [
  { id: 'circle', name: 'Circle', section: 'round', sides: 8, depth: 0 },
  { id: 'hexagon', name: 'Hexagon', section: 'faceted', sides: 6, depth: 0 },
  { id: 'octagon', name: 'Octagon', section: 'faceted', sides: 8, depth: 0 },
  { id: 'pentagon', name: 'Pentagon', section: 'faceted', sides: 5, depth: 0 },
  { id: 'triangle', name: 'Triangle', section: 'faceted', sides: 3, depth: 0 },
  { id: 'square', name: 'Square', section: 'square', sides: 4, depth: 0.02 },
  { id: 'rsquare', name: 'Rounded square', section: 'square', sides: 4, depth: 0.45 },
  { id: 'squircle', name: 'Squircle', section: 'square', sides: 4, depth: 0.7 },
  { id: 'decagon', name: 'Decagon', section: 'faceted', sides: 10, depth: 0 },
  { id: 'scallop', name: 'Scallop', section: 'petal', sides: 14, depth: 0.08 },
  { id: 'flower', name: 'Flower', section: 'flower', sides: 8, depth: 0.16 },
  { id: 'daisy', name: 'Daisy', section: 'petal', sides: 12, depth: 0.18 },
  { id: 'clover', name: 'Clover', section: 'petal', sides: 4, depth: 0.28 },
  { id: 'trefoil', name: 'Trefoil', section: 'petal', sides: 3, depth: 0.3 },
  { id: 'cloud', name: 'Cloud', section: 'flower', sides: 6, depth: 0.12 },
  { id: 'star5', name: 'Star', section: 'star', sides: 5, depth: 0.35 },
  { id: 'star8', name: 'Eight-point star', section: 'star', sides: 8, depth: 0.22 },
  { id: 'sun', name: 'Sun', section: 'star', sides: 16, depth: 0.1 },
  { id: 'cog', name: 'Cog', section: 'teeth', sides: 16, depth: 0.08 },
  { id: 'wavy', name: 'Wavy', section: 'fluted', sides: 18, depth: 0.08 },
  { id: 'fluted', name: 'Fluted', section: 'fluted', sides: 32, depth: 0.05 },
  { id: 'bottlecap', name: 'Bottle cap', section: 'fluted', sides: 21, depth: 0.12 },
];

export const defaultCoaster = (): CoasterSet => ({
  shape: 'scallop', section: 'petal', sides: 14, depth: 0.08, diameter: 100, thickness: 4, count: 4, mode: 'deboss', border: 6,
  caseOn: true, gap: 1, wall: 2.4, floor: 2, notch: 34,
});

/** Case height: floor + the stack + a little headroom. */
export const caseHeight = (c: CoasterSet) => c.floor + c.count * c.thickness + 1.5;

// ── outline: polygon from the polar shape, and signed distance to it (negative inside)
function outline(c: CoasterSet) {
  const N = 1440, R = c.diameter / 2, xs = new Float64Array(N), ys = new Float64Array(N), rs = new Float64Array(N);
  for (let i = 0; i < N; i++) { const th = (i / N) * Math.PI * 2, r = R * sectionMul(c, th); rs[i] = r; xs[i] = r * Math.cos(th); ys[i] = r * Math.sin(th); }
  const win = 260;
  const sd = (x: number, y: number) => {
    const th = Math.atan2(y, x), fi = (((th / (Math.PI * 2)) % 1) + 1) % 1 * N, i0 = Math.floor(fi);
    const rr = rs[i0 % N] + (rs[(i0 + 1) % N] - rs[i0 % N]) * (fi - i0), inside = Math.hypot(x, y) < rr;
    let best = Infinity;
    for (let k = -win; k < win; k++) {
      const a = (i0 + k + N) % N, b = (a + 1) % N, ax = xs[a], ay = ys[a], bx = xs[b] - ax, by = ys[b] - ay;
      const t = Math.min(1, Math.max(0, ((x - ax) * bx + (y - ay) * by) / (bx * bx + by * by)));
      const d = (x - ax - bx * t) ** 2 + (y - ay - by * t) ** 2;
      if (d < best) best = d;
    }
    return inside ? -Math.sqrt(best) : Math.sqrt(best);
  };
  return { sd, R };
}

// ── exact planar prism: solid between zBot and zTop over the region kept, cut along every contour
interface PrismIn { x0: number; y0: number; size: number; step: number; nC: number; evalC: (x: number, y: number, out: Float32Array, o: number) => void; keep: (x: number, y: number) => boolean; zTop: (x: number, y: number) => number; zBot: (x: number, y: number) => number }
export function prism(p: PrismIn): { pos: number[]; idx: number[] } {
  const n = Math.max(2, Math.ceil(p.size / p.step)), h = p.size / n, W = n + 1, C = p.nC;
  const vx: number[] = [], vy: number[] = [];
  let vals = new Float32Array(Math.max(1024, W * W * 2) * C);
  const ensure = (k: number) => { if (k * C > vals.length) { const nv = new Float32Array(Math.max(k * C, vals.length * 2)); nv.set(vals); vals = nv; } };
  for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) { const k = vx.length; vx.push(p.x0 + j * h); vy.push(p.y0 + i * h); ensure(k + 1); p.evalC(vx[k], vy[k], vals, k * C); }
  const tmp = new Float32Array(C);
  const cut = (a: number, b: number, c: number) => {
    const ax = vx[a], ay = vy[a], dx = vx[b] - ax, dy = vy[b] - ay;
    let lo = 0, hi = 1, flo = vals[a * C + c], fhi = vals[b * C + c], t = flo / (flo - fhi);
    for (let it = 0; it < 5; it++) {
      p.evalC(ax + dx * t, ay + dy * t, tmp, 0); const g = tmp[c];
      if (Math.abs(g) < 1e-5) break;
      if ((g > 0) === (flo > 0)) { lo = t; flo = g; } else { hi = t; fhi = g; }
      t = lo + (hi - lo) * (flo / (flo - fhi)); if (!(t > lo && t < hi)) t = (lo + hi) / 2;
    }
    const k = vx.length; vx.push(ax + dx * t); vy.push(ay + dy * t); ensure(k + 1); p.evalC(vx[k], vy[k], vals, k * C); vals[k * C + c] = 0;
    return k;
  };
  const side = (k: number, c: number) => { const v = vals[k * C + c]; return v > 0 ? 1 : v < 0 ? -1 : 0; };
  const shared = new Map<number, number>();
  const edgeId = (i: number, j: number, q: number) => (q === 0 ? 2 * (i * W + j) : q === 1 ? 2 * (i * W + j + 1) + 1 : q === 2 ? 2 * ((i + 1) * W + j) : 2 * (i * W + j) + 1);
  const top: number[] = [];
  const emit = (a: number, b: number, c: number) => { if (a === b || b === c || a === c) return; const cx = (vx[a] + vx[b] + vx[c]) / 3, cy = (vy[a] + vy[b] + vy[c]) / 3; if (p.keep(cx, cy)) top.push(a, b, c); };
  const cross = (a: number, b: number, c: number) => (vx[b] - vx[a]) * (vy[c] - vy[a]) - (vy[b] - vy[a]) * (vx[c] - vx[a]);
  const earClip = (poly: number[]) => {
    const v = poly.filter((x, k) => x !== poly[(k + 1) % poly.length]); let g = 0;
    while (v.length > 3 && g++ < 200) {
      let done = false;
      for (let k = 0; k < v.length; k++) {
        const a = v[(k + v.length - 1) % v.length], b = v[k], c = v[(k + 1) % v.length];
        if (cross(a, b, c) <= 1e-12) continue;
        let inside = false; for (const q of v) { if (q === a || q === b || q === c) continue; if (cross(a, b, q) >= 0 && cross(b, c, q) >= 0 && cross(c, a, q) >= 0) { inside = true; break; } }
        if (inside) continue;
        emit(a, b, c); v.splice(k, 1); done = true; break;
      }
      if (!done) break;
    }
    for (let k = 1; k + 1 < v.length; k++) emit(v[0], v[k], v[k + 1]);
  };
  type Poly = { v: number[]; m: number[]; frozen?: boolean };
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const a = i * W + j, b = a + 1, e = a + W + 1, cc = a + W;
    const pointOn = (u: number, w: number, mU: number, mW: number, c: number) => {
      const common = mU & mW;
      if (common) {
        const q = common & 1 ? 0 : common & 2 ? 1 : common & 4 ? 2 : 3, key = edgeId(i, j, q) * C + c, hit = shared.get(key);
        if (hit !== undefined && Math.min(vx[u], vx[w]) - 1e-9 <= vx[hit] && vx[hit] <= Math.max(vx[u], vx[w]) + 1e-9 && Math.min(vy[u], vy[w]) - 1e-9 <= vy[hit] && vy[hit] <= Math.max(vy[u], vy[w]) + 1e-9) return { x: hit, m: common };
        const x = cut(u, w, c); shared.set(key, x); return { x, m: common };
      }
      return { x: cut(u, w, c), m: 0 };
    };
    const insertOnly = (P: Poly, c: number): Poly => {
      const v: number[] = [], m: number[] = [], L = P.v.length;
      for (let k = 0; k < L; k++) { const u = P.v[k], w = P.v[(k + 1) % L]; v.push(u); m.push(P.m[k]); if (side(u, c) * side(w, c) < 0) { const r = pointOn(u, w, P.m[k], P.m[(k + 1) % L], c); v.push(r.x); m.push(r.m); } }
      return { v, m, frozen: P.frozen };
    };
    let polys: Poly[] = [{ v: [a, b, e, cc], m: [0b1001, 0b0011, 0b0110, 0b1100] }];
    for (let c = 0; c < C; c++) {
      const next: Poly[] = [];
      for (const P of polys) {
        let pos = false, neg = false; for (const v of P.v) { const s = side(v, c); if (s > 0) pos = true; else if (s < 0) neg = true; }
        if (!(pos && neg)) { next.push(P); continue; }
        if (P.frozen) { next.push(insertOnly(P, c)); continue; }
        const A: number[] = [], Am: number[] = [], B: number[] = [], Bm: number[] = []; let crossings = 0; const L = P.v.length;
        for (let k = 0; k < L; k++) {
          const u = P.v[k], w = P.v[(k + 1) % L], su = side(u, c), sw = side(w, c);
          if (su >= 0) { A.push(u); Am.push(P.m[k]); } if (su <= 0) { B.push(u); Bm.push(P.m[k]); }
          if (su * sw < 0) { crossings++; const r = pointOn(u, w, P.m[k], P.m[(k + 1) % L], c); A.push(r.x); Am.push(r.m); B.push(r.x); Bm.push(r.m); }
        }
        if (crossings !== 2 || A.length < 3 || B.length < 3) { const Q = insertOnly(P, c); Q.frozen = true; next.push(Q); continue; }
        next.push({ v: A, m: Am }, { v: B, m: Bm });
      }
      polys = next;
    }
    for (const P of polys) {
      if (!P.frozen) { earClip(P.v); continue; }
      P.v = P.v.filter((x, k) => x !== P.v[(k + 1) % P.v.length]);
      let mx = 0, my = 0; for (const v of P.v) { mx += vx[v]; my += vy[v]; }
      const k = vx.length; vx.push(mx / P.v.length); vy.push(my / P.v.length); ensure(k + 1); p.evalC(vx[k], vy[k], vals, k * C);
      for (let q = 0; q < P.v.length; q++) emit(k, P.v[q], P.v[(q + 1) % P.v.length]);
    }
  }
  // vertices: top copies then bottom copies; walls on every boundary edge of the kept region
  const nv = vx.length, pos: number[] = new Array(nv * 6);
  for (let k = 0; k < nv; k++) { pos[k * 3] = vx[k]; pos[k * 3 + 1] = vy[k]; pos[k * 3 + 2] = p.zTop(vx[k], vy[k]); const o = (nv + k) * 3; pos[o] = vx[k]; pos[o + 1] = vy[k]; pos[o + 2] = p.zBot(vx[k], vy[k]); }
  const idx: number[] = top.slice();
  for (let t = 0; t < top.length; t += 3) idx.push(nv + top[t], nv + top[t + 2], nv + top[t + 1]);
  const half = new Map<number, number>();
  const key = (a: number, b: number) => a * 4194304 + b;
  for (let t = 0; t < top.length; t += 3) for (let k = 0; k < 3; k++) { const a = top[t + k], b = top[t + (k + 1) % 3]; half.set(key(a, b), (half.get(key(a, b)) ?? 0) + 1); }
  for (let t = 0; t < top.length; t += 3) for (let k = 0; k < 3; k++) {
    const a = top[t + k], b = top[t + (k + 1) % 3];
    if (half.has(key(b, a))) continue;                         // interior edge
    idx.push(a, nv + a, nv + b, a, nv + b, b);
  }
  return { pos, idx };
}

/** Plate mesh at the origin (z from 0 to its top). */
export function plateMesh(d: Design, step: number) {
  const c = d.coaster!, o = outline(c), rl = d.relief, R = o.R;
  const reliefOn = rl.kind !== 'smooth' && rl.depth !== 0;
  const cell = c.diameter / Math.max(1, Math.round(rl.count));
  const pat = reliefOn ? planarPattern(rl, cell) : null;
  const bev = pat ? pat.bev : 0.4;
  const through = c.mode === 'through';
  const L = pat?.sharp ? pat.levels : 0;
  const isos = through ? [0] : [-bev / 2, bev / 2];
  const nC = 1 + (reliefOn ? (through ? 1 : 2) : 0) + L * isos.length;
  const evalC = (x: number, y: number, out: Float32Array, k: number) => {
    const sd = o.sd(x, y);
    out[k] = sd;
    let q = k + 1;
    if (reliefOn) { if (through) out[q++] = sd + c.border; else { out[q++] = sd + c.border - bev / 2; out[q++] = sd + c.border + bev / 2; } }
    if (L) { const e = pat!.edges(x / cell, y / cell)!; for (let l = 0; l < L; l++) for (const iso of isos) out[q++] = e[l] - iso; }
  };
  const inner = (x: number, y: number) => through ? (o.sd(x, y) < -c.border ? 1 : 0) : Math.min(1, Math.max(0, (-o.sd(x, y) - c.border) / bev + 0.5));
  const T = c.thickness, dep = Math.min(rl.depth, through ? T : c.mode === 'deboss' ? T - 0.8 : 6);
  const zTop = (x: number, y: number) => {
    if (!pat || through) return T;
    const k = inner(x, y); if (k <= 0) return T;
    const h = pat.height(x / cell, y / cell) * k;
    return c.mode === 'emboss' ? T + dep * h : T - dep * h;
  };
  const keep = (x: number, y: number) => o.sd(x, y) < 0 && !(through && pat && inner(x, y) > 0.5 && pat.height(x / cell, y / cell) > 0.5);
  return prism({ x0: -R - 1, y0: -R - 1, size: 2 * R + 2, step, nC, evalC, keep, zTop, zBot: () => 0 });
}

/** Case mesh at the origin: floor under the outer outline, wall ring with a finger notch at the front. */
export function caseMesh(d: Design, step: number) {
  const c = d.coaster!, o = outline(c), R = o.R + c.gap + c.wall + 1;
  const H = caseHeight(c), F = c.floor, nb = F + c.thickness;
  const Rc = o.R + c.gap + c.wall / 2, half = c.notch > 0 ? c.notch / 2 / Rc : 0;
  const wallH = (x: number, y: number) => {
    if (!half) return H;
    let dth = Math.atan2(y, x) + Math.PI / 2; dth = Math.atan2(Math.sin(dth), Math.cos(dth));
    if (Math.abs(dth) >= half) return H;
    return H - (H - nb) * (0.5 + 0.5 * Math.cos((Math.PI * dth) / half));
  };
  const outer = c.gap + c.wall;
  const floorM = prism({ x0: -R, y0: -R, size: 2 * R, step, nC: 1, evalC: (x, y, out, k) => { out[k] = o.sd(x, y) - outer; }, keep: (x, y) => o.sd(x, y) < outer, zTop: () => F, zBot: () => 0 });
  const ringM = prism({ x0: -R, y0: -R, size: 2 * R, step, nC: 2, evalC: (x, y, out, k) => { const s = o.sd(x, y); out[k] = s - c.gap; out[k + 1] = s - outer; }, keep: (x, y) => { const s = o.sd(x, y); return s > c.gap && s < outer; }, zTop: wallH, zBot: () => F });
  return [floorM, ringM];
}

/** Rough grams and print time for the whole set. */
export function coasterEstimate(c: CoasterSet) {
  const R = c.diameter / 2, area = Math.PI * R * R * 0.92;
  const plate = area * c.thickness * 0.55;                      // ~55 % fill
  const perim = 2 * Math.PI * (R + c.gap + c.wall / 2);
  const cas = c.caseOn ? Math.PI * (R + c.gap + c.wall) ** 2 * c.floor * 0.6 + perim * c.wall * caseHeight(c) : 0;
  const vol = plate * c.count + cas;
  return { grams: (vol / 1000) * 1.24, seconds: vol / 9, height: c.caseOn ? caseHeight(c) : c.thickness };
}
