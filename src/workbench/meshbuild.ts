// Builds the piece's mesh at a given quality. Used by the 3D view (in a worker when available) and the
// STL export. CAD-like result: rounds get ≥1440 segments (≤0.25°, <0.001 mm chord error), reliefs are
// sampled at a fraction of a millimetre with their outlines traced exactly, flat stretches are merged,
// and normals are smooth across curves but split at real creases (> 25°), so edges read sharp.
import * as THREE from 'three';
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { surfaceGrid, triangulate } from './surfacegrid';
import { makeInner, type Design } from './design';
import { isStandPart, seatOf } from './fitting';
import { buildStand, standSoup } from './stand';

export type MeshQuality = 'quick' | 'view' | 'export';
const SPEC: Record<MeshQuality, { relief: number; plainRow: number; minCols: number; maxVerts: number; snap: boolean }> = {
  quick: { relief: 1.2, plainRow: 2, minCols: 360, maxVerts: 120_000, snap: false },
  view: { relief: 0.5, plainRow: 1.0, minCols: 1440, maxVerts: 800_000, snap: true },
  export: { relief: 0.3, plainRow: 0.6, minCols: 1440, maxVerts: 2_000_000, snap: true },
};

function gridSize(d: Design, q: MeshQuality, face: 'outer' | 'inner') {
  const sp = SPEC[q], R = d.maxDiameter / 2, rl = d.relief;
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

/** The stand of a table shade as a mesh (print orientation: deck down). */
function standMesh(d: Design): BuiltMesh | null {
  const m = buildStand(d); if (!m) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(standSoup(m), 3));
  const creased = toCreasedNormals(geo, (25 * Math.PI) / 180);
  const position = creased.getAttribute('position').array as Float32Array;
  return { position, normal: creased.getAttribute('normal').array as Float32Array, src: new Uint32Array(position.length / 3), outer: { rows: 1, cols: 1, pos: new Float32Array(12) }, inner: { rows: 1, cols: 1 }, triangles: position.length / 9 };
}

export function buildMesh(d: Design, q: MeshQuality): BuiltMesh {
  if (isStandPart(d)) { const sm = standMesh(d); if (sm) return sm; }
  // both faces share the angular division (the rim joins them point for point)
  const o = gridSize(d, q, 'outer'), i2 = gridSize(d, q, 'inner'), cols = Math.max(o.cols, i2.cols);
  const go = surfaceGrid(d, o.rows, cols, 'outer', SPEC[q].snap), gi = surfaceGrid(d, i2.rows, cols, 'inner', SPEC[q].snap);
  const W = cols + 1, G = (o.rows + 1) * W, G2 = (i2.rows + 1) * W;
  const seat = seatOf(d), open = d.openBottom || !!seat;
  const floor = open ? 0 : Math.min(d.height * 0.3, d.wall * 0.6 + 1.2);
  const pos = new Float32Array((G + G2 + 2 + (seat ? 4 * W : 0)) * 3);
  pos.set(go.pos, 0); pos.set(gi.pos, G * 3);
  if (!open) for (let k = G * 3; k < (G + G2) * 3; k += 3) pos[k + 2] = Math.max(pos[k + 2], floor);
  const cBot = G + G2, cFloor = cBot + 1;
  pos[cBot * 3 + 2] = 0; pos[cFloor * 3 + 2] = floor;
  const eps = Math.max(1e-4, Math.abs(d.relief.depth) * 0.002);
  // flat stretches: largest block whose fan stays within 0.02 mm of the true surface (chord ≤ √(8·R·tol))
  const Rmin = Math.max(5, (d.maxDiameter / 2) * 0.5), blockMM = Math.min(8, Math.sqrt(8 * Rmin * 0.02) * 1.4);
  const C = (2 * Math.PI * d.maxDiameter / 2) / cols;
  const idx: number[] = [];
  const push = (a: Uint32Array) => { for (let k = 0; k < a.length; k++) idx.push(a[k]); };
  push(triangulate(go, d.height / o.rows, C, eps, false, 0, blockMM));
  push(triangulate(gi, d.height / i2.rows, C, eps, true, G, blockMM));
  const topO = o.rows * W, topI = G + i2.rows * W;
  for (let j = 0; j < cols; j++) {
    idx.push(topO + j, topO + j + 1, topI + j + 1, topO + j, topI + j + 1, topI + j);     // rim
    if (open) idx.push(j, G + j + 1, j + 1, j, G + j, G + j + 1);
    else idx.push(cBot, j + 1, j, cFloor, G + j, G + j + 1);
  }
  // lamp holder seat: a flat ring from the hole out into the wall (its rim is buried half a wall deep)
  const S0 = cFloor + 1;
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
      idx.push(o0, h0 + 1, o0 + 1, o0, h0, h0 + 1);       // underside
      idx.push(o1, o1 + 1, h1 + 1, o1, h1 + 1, h1);       // top
      idx.push(h0, h1 + 1, h0 + 1, h0, h1, h1 + 1);       // hole wall
      idx.push(o0, o0 + 1, o1 + 1, o0, o1 + 1, o1);       // rim (inside the wall)
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(idx);
  // seat vertices take the base colour of the floor point
  const src = Uint32Array.from(idx, (k) => (k >= S0 ? cFloor : k));
  const creased = toCreasedNormals(geo, (25 * Math.PI) / 180);
  return {
    position: creased.getAttribute('position').array as Float32Array, normal: creased.getAttribute('normal').array as Float32Array, src,
    outer: { rows: o.rows, cols, pos: go.pos }, inner: { rows: i2.rows, cols }, triangles: idx.length / 3,
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
