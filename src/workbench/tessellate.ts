// Feature-exact surface tessellation for sharp reliefs. The face is sampled on a regular (height, angle) grid,
// and every grid cell is cut exactly along the relief's edge lines — the top and the foot of each bevel,
// sd = ∓bevel/2 for every raised level (marching-squares style). Each cut point is located on the true signed
// distance and shared with the neighbouring cell, so the mesh is watertight; flat plateaus are planar
// polygons, bevels are straight bands, and lines only a few grid cells wide still come out clean.
import { surfaceParts, type Design } from './design';

const TAU = Math.PI * 2;
export interface FaceMesh { pos: Float32Array; idx: Uint32Array; src: Uint32Array; G: number }

export function faceMesh(d: Design, rows: number, cols: number, face: 'outer' | 'inner', blockMM: number, flip: boolean): FaceMesh | null {
  const parts = surfaceParts(d, face);
  if (!parts.on) return null;
  const H = d.height, W = cols + 1, G = (rows + 1) * W;
  let probe: { sd: number[]; bev: number } | null = null;
  for (const t of [0.5, 0.25, 0.75, 0.1, 0.9]) { probe = parts.edges(H * t, 0.3); if (probe) break; }
  if (!probe) return null;
  const L = probe.sd.length, C = L * 2, bev = probe.bev;
  const iso = (c: number) => ((c & 1) ? bev / 2 : -bev / 2), lvl = (c: number) => c >> 1;
  const FAR = 1e3;

  // vertices: grid points first
  const vz: number[] = [], vt: number[] = [], vsrc: number[] = [];
  let vals: Float32Array = new Float32Array(Math.max(1024, G * 2) * C);
  const ensure = (n: number) => { if (n * C > vals.length) { const nv = new Float32Array(Math.max(n * C, vals.length * 2)); nv.set(vals); vals = nv; } };
  const evalAt = (z: number, th: number, out: Float32Array, o: number) => {
    const e = parts.edges(z, th);
    for (let c = 0; c < C; c++) out[o + c] = e ? e.sd[lvl(c)] - iso(c) : FAR;
  };
  ensure(G);
  for (let i = 0; i <= rows; i++) for (let j = 0; j <= cols; j++) {
    const z = (i / rows) * H, th = (j / cols) * TAU, k = i * W + j;
    vz.push(z); vt.push(th); vsrc.push(k);
    evalAt(z, th, vals, k * C);
  }
  // seam column mirrors column 0 exactly
  for (let i = 0; i <= rows; i++) for (let c = 0; c < C; c++) vals[(i * W + cols) * C + c] = vals[i * W * C + c];

  const tmp = new Float32Array(C);
  /** Point on contour c between vertices a and b, located on the true field (regula falsi). */
  const cut = (a: number, b: number, c: number, src: number) => {
    const za = vz[a], ta = vt[a], dz = vz[b] - za, dt = vt[b] - ta;
    let lo = 0, hi = 1, flo = vals[a * C + c], fhi = vals[b * C + c];
    let t = flo / (flo - fhi);
    for (let it = 0; it < 4; it++) {
      evalAt(za + dz * t, ta + dt * t, tmp, 0);
      const g = tmp[c];
      if (Math.abs(g) < 1e-5) break;
      if ((g > 0) === (flo > 0)) { lo = t; flo = g; } else { hi = t; fhi = g; }
      t = lo + (hi - lo) * (flo / (flo - fhi));
      if (!(t > lo && t < hi)) t = (lo + hi) / 2;
    }
    const n = vz.length;
    vz.push(za + dz * t); vt.push(ta + dt * t); vsrc.push(src);
    ensure(n + 1);
    evalAt(vz[n], vt[n], vals, n * C);
    vals[n * C + c] = 0;
    return n;
  };
  const shared = new Map<number, number>();
  // cell edge ids: horizontal (i,j)→(i,j+1) = 2k, vertical (i,j)→(i+1,j) = 2k+1
  const edgeId = (i: number, j: number, q: number) => (q === 0 ? 2 * (i * W + j) : q === 1 ? 2 * (i * W + j + 1) + 1 : q === 2 ? 2 * ((i + 1) * W + j) : 2 * (i * W + j) + 1);

  const idx: number[] = [];
  const tri = (a: number, b: number, c: number) => { if (flip) idx.push(a, c, b); else idx.push(a, b, c); };
  const sideOf = (k: number, c: number) => { const v = vals[k * C + c]; return v > 0 ? 1 : v < 0 ? -1 : 0; };
  const flat = (k: number, ref: number) => { for (let c = 0; c < C; c++) if (sideOf(k, c) !== sideOf(ref, c) || sideOf(k, c) === 0) return false; return true; };

  /** Ear clipping in the (arc length, height) plane: never folds, keeps the winding of the cell. */
  const R0c = d.maxDiameter / 2;
  const earClip = (poly: number[]) => {
    const v = poly.slice();
    const X = (k: number) => vt[k] * R0c, Y = (k: number) => vz[k];
    const cross = (a: number, b: number, c: number) => (X(b) - X(a)) * (Y(c) - Y(a)) - (Y(b) - Y(a)) * (X(c) - X(a));
    let area = 0; for (let k = 0; k < v.length; k++) { const a = v[k], b = v[(k + 1) % v.length]; area += X(a) * Y(b) - X(b) * Y(a); }
    const sgn = area >= 0 ? 1 : -1;
    let guard = 0;
    while (v.length > 3 && guard++ < 200) {
      let clipped = false;
      for (let k = 0; k < v.length; k++) {
        const a = v[(k + v.length - 1) % v.length], b = v[k], c = v[(k + 1) % v.length];
        if (cross(a, b, c) * sgn <= 1e-12) continue;
        let inside = false;
        for (const p of v) { if (p === a || p === b || p === c) continue; if (cross(a, b, p) * sgn >= 0 && cross(b, c, p) * sgn >= 0 && cross(c, a, p) * sgn >= 0) { inside = true; break; } }
        if (inside) continue;
        tri(a, b, c); v.splice(k, 1); clipped = true; break;
      }
      if (!clipped) break;
    }
    for (let k = 1; k + 1 < v.length; k++) tri(v[0], v[k], v[k + 1]);
  };
  const cellPolys = (i: number, j: number) => {
    const a = i * W + j, b = a + 1, e = a + W + 1, cc = a + W;
    // vertex, membership mask of the cell's edges (0 ab, 1 be, 2 ec, 3 ca)
    let polys: { v: number[]; m: number[]; frozen?: boolean }[] = [{ v: [a, b, e, cc], m: [0b1001, 0b0011, 0b0110, 0b1100] }];
    /** The polygon with contour c's crossing points inserted on its border (no split). */
    const insertOnly = (P: { v: number[]; m: number[]; frozen?: boolean }, c: number) => {
      const v: number[] = [], m: number[] = [], n = P.v.length;
      for (let k = 0; k < n; k++) {
        const u = P.v[k], w = P.v[(k + 1) % n];
        v.push(u); m.push(P.m[k]);
        if (sideOf(u, c) * sideOf(w, c) < 0) {
          const common = P.m[k] & P.m[(k + 1) % n];
          let x: number;
          if (common) {
            const q = common & 1 ? 0 : common & 2 ? 1 : common & 4 ? 2 : 3, key = edgeId(i, j, q) * C + c;
            const hit = shared.get(key);
            x = hit !== undefined ? hit : cut(u, w, c, a); if (hit === undefined) shared.set(key, x);
          } else x = cut(u, w, c, a);
          v.push(x); m.push(common);
        }
      }
      return { v, m, frozen: P.frozen };
    };
    for (let c = 0; c < C; c++) {
      const next: typeof polys = [];
      for (const P of polys) {
        const n = P.v.length; let has = false, pos = false, neg = false;
        for (const v of P.v) { const s = sideOf(v, c); if (s > 0) pos = true; else if (s < 0) neg = true; }
        has = pos && neg;
        if (!has) { next.push(P); continue; }
        if (P.frozen) { next.push(insertOnly(P, c)); continue; }
        const A: number[] = [], Am: number[] = [], B: number[] = [], Bm: number[] = [];
        let crossings = 0;
        for (let k = 0; k < n; k++) {
          const u = P.v[k], w = P.v[(k + 1) % n], su = sideOf(u, c), sw = sideOf(w, c), mu = P.m[k];
          if (su >= 0) { A.push(u); Am.push(mu); } if (su <= 0) { B.push(u); Bm.push(mu); }
          if (su * sw < 0) {
            crossings++;
            const common = P.m[k] & P.m[(k + 1) % n];
            let x: number;
            if (common) {
              const q = common & 1 ? 0 : common & 2 ? 1 : common & 4 ? 2 : 3, key = edgeId(i, j, q) * C + c;
              const hit = shared.get(key);
              if (hit !== undefined && Math.min(vz[u], vz[w]) - 1e-9 <= vz[hit] && vz[hit] <= Math.max(vz[u], vz[w]) + 1e-9 && Math.min(vt[u], vt[w]) - 1e-9 <= vt[hit] && vt[hit] <= Math.max(vt[u], vt[w]) + 1e-9) x = hit;
              else { x = cut(u, w, c, a); shared.set(key, x); }
            } else x = cut(u, w, c, a);
            const mx = common;
            A.push(x); Am.push(mx); B.push(x); Bm.push(mx);
          }
        }
        // saddle (the contour crosses this piece four times): keep it whole, but with every cut point on its
        // border so the neighbours stay joined; it is fanned from its centre at the end
        if (crossings !== 2 || A.length < 3 || B.length < 3) { const Q = insertOnly(P, c); Q.frozen = true; next.push(Q); continue; }
        next.push({ v: A, m: Am }, { v: B, m: Bm });
      }
      polys = next;
    }
    for (const P of polys) {
      if (!P.frozen) { earClip(P.v); continue; }
      let mz = 0, mt = 0; for (const v of P.v) { mz += vz[v]; mt += vt[v]; }
      const n = vz.length; vz.push(mz / P.v.length); vt.push(mt / P.v.length); vsrc.push(a); ensure(n + 1); evalAt(vz[n], vt[n], vals, n * C);
      for (let k = 0; k < P.v.length; k++) tri(n, P.v[k], P.v[(k + 1) % P.v.length]);
    }
  };

  // flat stretches merge into larger fans (same rule as the plain mesher)
  const R0 = d.maxDiameter / 2, rowMM = H / rows, colMM = (TAU * R0) / cols;
  const even = (v: number) => Math.max(2, Math.min(32, Math.floor(v / 2) * 2));
  const sr = even(blockMM / rowMM), sc = even(blockMM / colMM);
  for (let i0 = 0; i0 < rows; i0 += sr) for (let j0 = 0; j0 < cols; j0 += sc) {
    const fits = i0 + sr <= rows && j0 + sc <= cols;
    let isFlat = fits;
    if (isFlat) { const ref = i0 * W + j0; for (let i = i0; i <= i0 + sr && isFlat; i++) for (let j = j0; j <= j0 + sc; j++) if (!flat(i * W + j, ref)) { isFlat = false; break; } }
    if (isFlat) {
      const ctr = (i0 + sr / 2) * W + (j0 + sc / 2), ring: number[] = [];
      for (let j = j0; j < j0 + sc; j++) ring.push(i0 * W + j);
      for (let i = i0; i < i0 + sr; i++) ring.push(i * W + j0 + sc);
      for (let j = j0 + sc; j > j0; j--) ring.push((i0 + sr) * W + j);
      for (let i = i0 + sr; i > i0; i--) ring.push(i * W + j0);
      for (let k = 0; k < ring.length; k++) tri(ctr, ring[k], ring[(k + 1) % ring.length]);
    } else for (let i = i0; i < Math.min(rows, i0 + sr); i++) for (let j = j0; j < Math.min(cols, j0 + sc); j++) cellPolys(i, j);
  }

  const nv = vz.length, pos = new Float32Array(nv * 3);
  for (let k = 0; k < nv; k++) {
    const z = vz[k], th = vt[k], r = parts.radius(z, th, parts.rel(z, th));
    pos[k * 3] = r * Math.cos(th); pos[k * 3 + 1] = r * Math.sin(th); pos[k * 3 + 2] = z;
  }
  return { pos, idx: Uint32Array.from(idx), src: Uint32Array.from(vsrc), G };
}
