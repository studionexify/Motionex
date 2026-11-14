// Builds the piece's mesh at a given quality. Used by the 3D view (in a worker when available) and the
// STL export. CAD-like result: rounds get ≥1440 segments (≤0.25°, <0.001 mm chord error), reliefs are
// sampled at a fraction of a millimetre with their outlines traced exactly, flat stretches are merged,
// and normals are smooth across curves but split at real creases (> 25°), so edges read sharp.
import { surfaceGrid, triangulate } from './surfacegrid';
import { faceMesh } from './tessellate';
import { caseMesh, plateMesh } from './coaster';
import { makeInner, surfaceParts, type Design } from './design';
import { isStandPart, seatOf } from './fitting';
import { buildStand, standSoup } from './stand';

export type MeshQuality = 'quick' | 'view' | 'export';
const SPEC: Record<MeshQuality, { relief: number; plainRow: number; minCols: number; maxVerts: number; snap: boolean; levels?: number[]; finest: number; perFeature: number; smooth?: boolean }> = {
  // quick: still traced (no staircase), just coarser — the fast preview while editing
  quick: { relief: 1.0, plainRow: 2.5, minCols: 480, maxVerts: 200_000, snap: true, levels: [0.5], finest: 0.6, perFeature: 2.2, smooth: true },
  view: { relief: 0.6, plainRow: 1.0, minCols: 1440, maxVerts: 700_000, snap: true, levels: [0.15, 0.85], finest: 0.3, perFeature: 4 },
  export: { relief: 0.3, plainRow: 0.6, minCols: 1440, maxVerts: 2_400_000, snap: true, levels: [0.15, 0.85], finest: 0.15, perFeature: 4 },
};

/** Narrowest feature of the relief (mm): smallest plateau or line width, measured along both directions
 *  of the pattern. Thin lines need several mesh rows across them to come out clean. */
function finestFeature(d: Design): number {
  const rl = d.relief, R = d.maxDiameter / 2;
  if (rl.kind === 'smooth' || rl.depth === 0) return Infinity;
  const n = Math.max(1, rl.count), cellMM = (2 * Math.PI * R) / n;
  const parts = surfaceParts(d, rl.side === 'inside' ? 'inner' : 'outer');
  const z0 = d.height * 0.5, S = 1200, runs: number[] = [];
  const scan = (fz: (k: number) => number, fth: (k: number) => number, mmPer: number) => {
    let lo = Infinity, hi = -Infinity; const v = new Float32Array(S);
    for (let k = 0; k < S; k++) { v[k] = Math.abs(parts.rel(fz(k), fth(k))); lo = Math.min(lo, v[k]); hi = Math.max(hi, v[k]); }
    if (hi - lo < 1e-3) return;
    const mid = (lo + hi) / 2; let last = -1;
    for (let k = 1; k < S; k++) if ((v[k] - mid) * (v[k - 1] - mid) < 0) { if (last >= 0) runs.push((k - last) * mmPer); last = k; }
  };
  for (const dz of [0, 0.31, 0.57]) scan(() => z0 + dz * cellMM, (k) => ((k / S) * 3 * 2 * Math.PI) / n, (3 * cellMM) / S);   // round
  for (const a of [0, 0.37]) scan((k) => Math.min(d.height, z0 - 1.5 * cellMM + (k / S) * 3 * cellMM), () => ((a + 0.1) * 2 * Math.PI) / n, (3 * cellMM) / S);   // up
  if (!runs.length) return Infinity;
  runs.sort((x, y) => x - y);
  return runs[Math.floor(runs.length * 0.1)];
}

function gridSize(d: Design, q: MeshQuality, face: 'outer' | 'inner') {
  const sp0 = SPEC[q], R = d.maxDiameter / 2, rl = d.relief;
  const fine = finestFeature(d);
  const sp = { ...sp0, relief: Math.max(sp0.finest, Math.min(sp0.relief, fine / sp0.perFeature)) };
  const relief = rl.kind !== 'smooth' && rl.depth !== 0 && (face === 'outer' ? rl.side !== 'inside' : rl.side === 'inside' || rl.side === 'both');
  let cols = Math.max(sp.minCols, d.section !== 'round' ? d.sides * 48 : 0, relief ? Math.ceil((2 * Math.PI * R) / sp.relief) : 0);
  let rows = Math.ceil(d.height / (relief ? sp.relief : sp.plainRow));
  const k = Math.sqrt(Math.min(1, sp.maxVerts / ((rows + 1) * (cols + 1))));
  if (k < 1) { cols = Math.max(sp.minCols / 2, Math.floor(cols * k)); rows = Math.max(40, Math.floor(rows * k)); }
  return { rows, cols };
}

export interface BuiltMesh {
  /** expanded (non-indexed) triangles */
  position: Float32Array; normal: Float32Array;
  /** for each expanded vertex: its grid point (outer 0..G-1, inner G..G+G2-1, base centre G+G2) */
  src: Uint32Array;
  outer: { rows: number; cols: number; pos: Float32Array }; inner: { rows: number; cols: number };
  triangles: number;
}

/** Coaster set: the case (if on) with one plate beside it in the view; every plate laid out for export. */
function buildCoaster(d: Design, q: MeshQuality): BuiltMesh {
  const c = d.coaster!;
  const step = q === 'quick' ? 1.2 : q === 'view' ? 0.6 : 0.22;   // contours are cut exactly at any step
  const parts: { pos: number[]; idx: number[]; dx: number; dy: number }[] = [];
  // cut-through holes have only their outline to show: mesh the plate finer so curves stay smooth
  const plate = plateMesh(d, c.mode === 'through' && q !== 'export' ? step * 0.55 : step), R = c.diameter / 2, Rc = R + c.gap + c.wall;
  if (c.caseOn) for (const m of caseMesh(d, step)) parts.push({ ...m, dx: 0, dy: 0 });
  const startX = c.caseOn ? Rc + R + 12 : 0;
  const n = q === 'export' ? c.count : 1, perRow = Math.max(1, Math.ceil(Math.sqrt(n)));
  for (let k = 0; k < n; k++) parts.push({ ...plate, dx: startX + (k % perRow) * (2 * R + 8), dy: Math.floor(k / perRow) * (2 * R + 8) });
  let nv = 0, ni = 0; for (const p of parts) { nv += p.pos.length / 3; ni += p.idx.length; }
  const pos = new Float32Array(nv * 3), idx = new Uint32Array(ni);
  let ov = 0, oi = 0;
  for (const p of parts) {
    const v0 = ov;
    for (let k = 0; k < p.pos.length; k += 3) { pos[ov * 3] = p.pos[k] + p.dx; pos[ov * 3 + 1] = p.pos[k + 1] + p.dy; pos[ov * 3 + 2] = p.pos[k + 2]; ov++; }
    for (const i of p.idx) idx[oi++] = i + v0;
  }
  const { position, normal } = creasedNormals(pos, idx, Math.cos((25 * Math.PI) / 180));
  return { position, normal, src: new Uint32Array(idx.length), outer: { rows: 1, cols: 1, pos: new Float32Array(6) }, inner: { rows: 1, cols: 1 }, triangles: idx.length / 3 };
}

/** The stand of a table shade as a mesh (print orientation: deck down). */
function standMesh(d: Design): BuiltMesh | null {
  const m = buildStand(d); if (!m) return null;
  const soup = standSoup(m), n = soup.length / 3, idx = new Uint32Array(n);
  for (let k = 0; k < n; k++) idx[k] = k;
  const { position, normal } = creasedNormals(soup, idx, Math.cos((25 * Math.PI) / 180));
  return { position, normal, src: new Uint32Array(position.length / 3), outer: { rows: 1, cols: 1, pos: new Float32Array(12) }, inner: { rows: 1, cols: 1 }, triangles: position.length / 9 };
}

export function buildMesh(d: Design, q: MeshQuality): BuiltMesh {
  if (d.family === 'coaster' && d.coaster) return buildCoaster(d, q);
  if (isStandPart(d)) { const sm = standMesh(d); if (sm) return sm; }
  // both faces share the angular division (the rim joins them point for point)
  const o = gridSize(d, q, 'outer'), i2 = gridSize(d, q, 'inner'), cols = Math.max(o.cols, i2.cols);
  const W = cols + 1, G = (o.rows + 1) * W, G2 = (i2.rows + 1) * W;
  const seat = seatOf(d), open = d.openBottom || !!seat;
  const floor = open ? 0 : Math.min(d.height * 0.3, d.wall * 0.6 + 1.2);
  const eps = Math.max(1e-4, Math.abs(d.relief.depth) * 0.002);
  // flat stretches: largest block whose fan stays within 0.02 mm of the true surface (chord ≤ √(8·R·tol))
  const Rmin = Math.max(5, (d.maxDiameter / 2) * 0.5), blockMM = Math.min(8, Math.sqrt(8 * Rmin * 0.02) * 1.4);
  const C = (2 * Math.PI * d.maxDiameter / 2) / cols;
  // each face: exact edge-cut tessellation for sharp reliefs, otherwise the smooth grid mesher
  const face = (f: 'outer' | 'inner', rows: number, flip: boolean) => {
    const fm = faceMesh(d, rows, cols, f, blockMM, flip);
    if (fm) return fm;
    const g = surfaceGrid(d, rows, cols, f, false);
    const Gf = (rows + 1) * W, srcf = new Uint32Array(Gf); for (let k = 0; k < Gf; k++) srcf[k] = k;
    return { pos: g.pos, idx: triangulate(g, d.height / rows, C, eps, flip, 0, blockMM), src: srcf, G: Gf };
  };
  const fo = face('outer', o.rows, false), fi = face('inner', i2.rows, true);
  const No = fo.pos.length / 3, Ni = fi.pos.length / 3, cBot = No + Ni, cFloor = cBot + 1;
  const S0 = No + Ni + 2;
  const pos = new Float32Array((S0 + (seat ? 4 * W : 0)) * 3);
  pos.set(fo.pos, 0); pos.set(fi.pos, No * 3);
  if (!open) for (let k = No * 3; k < (No + Ni) * 3; k += 3) pos[k + 2] = Math.max(pos[k + 2], floor);
  pos[cBot * 3 + 2] = 0; pos[cFloor * 3 + 2] = floor;
  const rest: number[] = [];
  const topO = o.rows * W, topI = No + i2.rows * W;
  for (let j = 0; j < cols; j++) {
    rest.push(topO + j, topO + j + 1, topI + j + 1, topO + j, topI + j + 1, topI + j);     // rim
    if (open) rest.push(j, No + j + 1, j + 1, j, No + j, No + j + 1);
    else rest.push(cBot, j + 1, j, cFloor, No + j, No + j + 1);
  }
  // lamp holder seat: a flat ring from the hole out into the wall (its rim is buried half a wall deep)
  if (seat) {
    const inner = makeInner(d), bury = d.wall / 2;
    for (let j = 0; j < W; j++) {
      const th = (j / cols) * Math.PI * 2, c = Math.cos(th), s = Math.sin(th);
      const put = (k: number, r: number, z: number) => { pos[k * 3] = r * c; pos[k * 3 + 1] = r * s; pos[k * 3 + 2] = z; };
      put(S0 + j, Math.max(seat.holeR, inner(seat.z0, th) + bury), seat.z0); put(S0 + W + j, Math.max(seat.holeR, inner(seat.z1, th) + bury), seat.z1);
      put(S0 + 2 * W + j, seat.holeR, seat.z0); put(S0 + 3 * W + j, seat.holeR, seat.z1);
    }
    for (let j = 0; j < cols; j++) {
      const o0 = S0 + j, o1 = S0 + W + j, h0 = S0 + 2 * W + j, h1 = S0 + 3 * W + j;
      rest.push(o0, h0 + 1, o0 + 1, o0, h0, h0 + 1);       // underside
      rest.push(o1, o1 + 1, h1 + 1, o1, h1 + 1, h1);       // top
      rest.push(h0, h1 + 1, h0 + 1, h0, h1, h1 + 1);       // hole wall
      rest.push(o0, o0 + 1, o1 + 1, o0, o1 + 1, o1);       // rim (inside the wall)
    }
  }
  const idx = new Uint32Array(fo.idx.length + fi.idx.length + rest.length);
  idx.set(fo.idx, 0);
  for (let k = 0; k < fi.idx.length; k++) idx[fo.idx.length + k] = fi.idx[k] + No;
  idx.set(rest, fo.idx.length + fi.idx.length);
  const { position, normal } = creasedNormals(pos, idx, Math.cos((25 * Math.PI) / 180));
  // per corner: the grid point it belongs to (for painting rule colours)
  const src = new Uint32Array(idx.length);
  for (let k = 0; k < idx.length; k++) { const v = idx[k]; src[k] = v < No ? fo.src[v] : v < No + Ni ? G + fi.src[v - No] : v >= S0 ? G + G2 + 1 : G + G2 + (v - No - Ni); }
  return {
    position, normal, src,
    outer: { rows: o.rows, cols, pos: fo.pos.subarray(0, G * 3) }, inner: { rows: i2.rows, cols }, triangles: idx.length / 3,
  };
}

/** Binary STL from a built mesh. */
export function meshToStl(m: BuiltMesh): ArrayBuffer {
  const n = m.position.length / 9, buf = new ArrayBuffer(84 + n * 50), v = new DataView(buf), p = m.position;
  v.setUint32(80, n, true);
  let o = 84;
  for (let t = 0; t < n; t++) {
    const k = t * 9;
    const ux = p[k + 3] - p[k], uy = p[k + 4] - p[k + 1], uz = p[k + 5] - p[k + 2], wx = p[k + 6] - p[k], wy = p[k + 7] - p[k + 1], wz = p[k + 8] - p[k + 2];
    let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx; const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    v.setFloat32(o, nx, true); v.setFloat32(o + 4, ny, true); v.setFloat32(o + 8, nz, true); o += 12;
    for (let m2 = 0; m2 < 9; m2++) { v.setFloat32(o, p[k + m2], true); o += 4; }
    o += 2;
  }
  return buf;
}

/** Expanded triangles with crease-aware normals: each corner averages only the neighbouring faces that bend
 *  less than the crease angle, so curves shade smooth and real edges stay sharp. Flat arrays, no objects. */
function creasedNormals(pos: Float32Array, idx: Uint32Array, cosCrease: number) {
  const T = idx.length / 3, nv = pos.length / 3;
  const fn = new Float32Array(T * 3);
  for (let t = 0; t < T; t++) {
    const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2], wx = pos[c] - pos[a], wy = pos[c + 1] - pos[a + 1], wz = pos[c + 2] - pos[a + 2];
    fn[t * 3] = uy * wz - uz * wy; fn[t * 3 + 1] = uz * wx - ux * wz; fn[t * 3 + 2] = ux * wy - uy * wx;   // area-weighted
  }
  // faces around each vertex (CSR)
  const cnt = new Uint32Array(nv + 1);
  for (let k = 0; k < idx.length; k++) cnt[idx[k] + 1]++;
  for (let v = 0; v < nv; v++) cnt[v + 1] += cnt[v];
  const fill = cnt.slice(0, nv), adj = new Uint32Array(idx.length);
  for (let k = 0; k < idx.length; k++) adj[fill[idx[k]]++] = (k / 3) | 0;
  const position = new Float32Array(T * 9), normal = new Float32Array(T * 9);
  for (let t = 0; t < T; t++) {
    const nx0 = fn[t * 3], ny0 = fn[t * 3 + 1], nz0 = fn[t * 3 + 2], l0 = Math.hypot(nx0, ny0, nz0) || 1;
    for (let c = 0; c < 3; c++) {
      const v = idx[t * 3 + c], o = (t * 3 + c) * 3;
      position[o] = pos[v * 3]; position[o + 1] = pos[v * 3 + 1]; position[o + 2] = pos[v * 3 + 2];
      let sx = 0, sy = 0, sz = 0;
      for (let q = cnt[v]; q < cnt[v + 1]; q++) {
        const f = adj[q], fx = fn[f * 3], fy = fn[f * 3 + 1], fz = fn[f * 3 + 2], lf = Math.hypot(fx, fy, fz) || 1;
        if ((fx * nx0 + fy * ny0 + fz * nz0) / (lf * l0) >= cosCrease) { sx += fx; sy += fy; sz += fz; }
      }
      const l = Math.hypot(sx, sy, sz) || 1;
      normal[o] = sx / l; normal[o + 1] = sy / l; normal[o + 2] = sz / l;
    }
  }
  return { position, normal };
}
