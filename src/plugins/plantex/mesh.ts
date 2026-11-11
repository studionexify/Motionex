// Mesh builder. The body is a grid over (angle, meridian row): the floor (a pole at the centre, or a
// ring around the centre drain hole), floor rings, then wall rows up to the rim. Walled bodies get a
// matching inner grid offset by the wall thickness.
//
// Holes (cut-through textures, drain holes, overflow) are a signed distance field over the grid (> 0 in
// a hole). Each cell is clipped against the field's zero line (marching squares), so hole edges follow
// the true contour instead of the grid. Along every open edge — hole contours, the rim, the centre hole
// — outer and inner surfaces are joined by a rounded profile (fillet radius), so the result is a closed,
// consistently wound shell with smooth edges. Vase mode builds one closed solid instead.
import type { IndexedMesh } from '../../engine/mesh';
import type { PlantexSpec } from './model';
import { bodyFn } from './shape';
import { textureField, type Mask } from './textures';

const TAU = Math.PI * 2;

export interface BuildResult { mesh: IndexedMesh; warnings: string[]; triangles: number }

type V3 = [number, number, number];

interface ShellOptions {
  N: number;
  height: number;
  /** Base radius at angle a, height z (no texture). */
  radius(a: number, z: number): number;
  /** Signed displacement along the surface normal at angle fraction u, height z. */
  disp?(u: number, z: number): number;
  /** Max wall row step (mm). */
  step: number;
  solid: boolean;
  wall: number;
  floor: number;
  /** Cut field on the wall (unitless, > 0 in a hole); turned into a distance by its gradient. */
  wallField?(u: number, z: number): number;
  /** Wall heights where cut-through holes may open. */
  wallBand?: [number, number];
  /** Round holes through the wall (centre on the outer surface, radius mm). */
  wallHoles?: { c: V3; r: number }[];
  /** Round holes through the floor (x, y, radius mm). */
  floorHoles?: [number, number, number][];
  /** Centre drain hole radius (mm), 0 = none. */
  centerHole?: number;
  /** Hole edge rounding and rim rounding (mm). */
  fillet?: number;
  rimRound?: number;
  /** Segments per quarter-round of a fillet. */
  arc?: number;
  /** Raise the inner floor at (angle, ρ 0..1) by this many mm (saucer ribs). */
  floorBump?(a: number, rho: number): number;
  /** Lower the outer floor at (x, y) by this many mm (feet). */
  floorDrop?(x: number, y: number): number;
}

function normalAt(o: ShellOptions, a: number, z: number): V3 {
  const e = 1e-3, r = o.radius(a, z);
  const ra = (o.radius(a + e, z) - o.radius(a - e, z)) / (2 * e);
  const z1 = Math.min(o.height, z + e), z0 = Math.max(0, z - e);
  const rz = (o.radius(a, z1) - o.radius(a, z0)) / ((z1 - z0) || e);
  const c = Math.cos(a), s = Math.sin(a);
  // dP/da × dP/dz
  const ta = [ra * c - r * s, ra * s + r * c, 0], tz = [rz * c, rz * s, 1];
  const n: V3 = [ta[1] * tz[2] - ta[2] * tz[1], ta[2] * tz[0] - ta[0] * tz[2], ta[0] * tz[1] - ta[1] * tz[0]];
  const l = Math.hypot(n[0], n[1], n[2]) || 1;
  return [n[0] / l, n[1] / l, n[2] / l];
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const lerp3 = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

interface Row { start: number; pole: boolean; kind: 'floor' | 'wall' | 'cap'; z: number }

/** Shared grid construction: vertex buffer, ring rows and the wall point function. */
function grid(o: ShellOptions) {
  const N = o.N;
  const verts: number[] = [];
  const add = (p: V3) => { verts.push(p[0], p[1], p[2]); return verts.length / 3 - 1; };
  const ring = (kind: Row['kind'], z: number, pt: (i: number) => V3): Row => {
    const start = verts.length / 3;
    for (let i = 0; i < N; i++) add(pt(i));
    return { start, pole: false, kind, z };
  };
  const ang = (i: number) => (i * TAU) / N;
  const wallPt = (i: number, z: number, inset: number, d?: (u: number, z: number) => number): V3 => {
    const a = ang(i), r = o.radius(a, z), n = normalAt(o, a, z);
    const k = (d ? d(i / N, z) : 0) - inset;
    return [r * Math.cos(a) + n[0] * k, r * Math.sin(a) + n[1] * k, Math.max(0, Math.min(o.height, z + n[2] * k))];
  };
  let rMax0 = 0;
  for (let i = 0; i < N; i++) rMax0 = Math.max(rMax0, o.radius(ang(i), 0));
  const F = Math.max(4, Math.min(80, Math.ceil(rMax0 / 1.2)));
  const vid = (rows: Row[], r: number, i: number) => (rows[r].pole ? rows[r].start : rows[r].start + (((i % N) + N) % N));
  const pos = (id: number): V3 => [verts[id * 3], verts[id * 3 + 1], verts[id * 3 + 2]];
  return { N, verts, add, ring, ang, wallPt, F, vid, pos };
}

/** Vase mode: one closed solid (floor fan, wall, top cap). */
function buildSolid(o: ShellOptions): IndexedMesh {
  const g = grid(o);
  const { N, F, ang } = g;
  const H = o.height;
  const nz = Math.max(2, Math.ceil(H / o.step));
  const rows: Row[] = [{ start: g.add([0, 0, 0]), pole: true, kind: 'floor', z: 0 }];
  for (let k = 1; k < F; k++) rows.push(g.ring('floor', 0, (i) => { const a = ang(i), r = o.radius(a, 0) * (k / F); return [r * Math.cos(a), r * Math.sin(a), 0]; }));
  let top: V3[] = [];
  for (let j = 0; j <= nz; j++) {
    const z = (H * j) / nz;
    const pts = Array.from({ length: N }, (_, i) => g.wallPt(i, z, 0, o.disp));
    if (j === 0) for (const p of pts) p[2] = 0;
    if (j === nz) for (const p of pts) p[2] = H;
    top = pts;
    rows.push(g.ring('wall', z, (i) => pts[i]));
  }
  for (let k = F - 1; k >= 1; k--) rows.push(g.ring('cap', H, (i) => [top[i][0] * (k / F), top[i][1] * (k / F), H]));
  rows.push({ start: g.add([0, 0, H]), pole: true, kind: 'cap', z: H });
  const idx: number[] = [];
  const tri = (a: number, b: number, c: number) => { if (a !== b && b !== c && a !== c) idx.push(a, b, c); };
  for (let j = 0; j < rows.length - 1; j++) for (let i = 0; i < N; i++) {
    const a = g.vid(rows, j, i), b = g.vid(rows, j, i + 1), c = g.vid(rows, j + 1, i), d = g.vid(rows, j + 1, i + 1);
    tri(a, b, c); tri(b, d, c);
  }
  return { vertices: Float32Array.from(g.verts), indices: Uint32Array.from(idx) };
}

export function buildShell(o: ShellOptions): IndexedMesh {
  if (o.solid) return buildSolid(o);
  const g = grid(o);
  const { N, F, ang, verts, add, pos } = g;
  const H = o.height;
  const fillet = Math.max(0, o.fillet ?? 0), rimR = Math.max(0, Math.min(o.rimRound ?? 0, o.wall / 2));
  const K = fillet > 0 || rimR > 0 ? Math.max(1, o.arc ?? 4) : 0;
  const zTop = H - rimR;
  const nz = Math.max(2, Math.ceil(zTop / o.step));
  const fl = Math.min(o.floor, zTop - 1);
  const rc = o.centerHole && o.centerHole > 0 ? o.centerHole + fillet : 0;
  const drop = o.floorDrop ?? (() => 0);
  const bump = o.floorBump ?? (() => 0);

  // outer grid: [pole] floor rings, wall rows
  const outer: Row[] = [];
  const floorPt = (i: number, t: number, z: (x: number, y: number) => number): V3 => {
    const a = ang(i), R = o.radius(a, 0), r = rc + (R - rc) * t;
    const x = r * Math.cos(a), y = r * Math.sin(a);
    return [x, y, z(x, y)];
  };
  if (!rc) outer.push({ start: add([0, 0, -drop(0, 0)]), pole: true, kind: 'floor', z: 0 });
  for (let k = rc ? 0 : 1; k < F; k++) outer.push(g.ring('floor', 0, (i) => floorPt(i, k / F, (x, y) => -drop(x, y))));
  const wallRow0 = outer.length;
  for (let j = 0; j <= nz; j++) {
    const z = (zTop * j) / nz;
    const pts = Array.from({ length: N }, (_, i) => g.wallPt(i, z, 0, o.disp));
    if (j === 0) for (const p of pts) p[2] = 0;
    if (j === nz) for (const p of pts) p[2] = zTop;
    outer.push(g.ring('wall', z, (i) => pts[i]));
  }
  const R = outer.length;

  // inner grid, row for row
  const inner: Row[] = [];
  const iw0 = Array.from({ length: N }, (_, i) => g.wallPt(i, fl, o.wall));
  if (!rc) inner.push({ start: add([0, 0, fl + bump(0, 0)]), pole: true, kind: 'floor', z: fl });
  for (let k = rc ? 0 : 1; k < F; k++) {
    const t = k / F;
    inner.push(g.ring('floor', fl, (i) => {
      const a = ang(i), c: V3 = [rc * Math.cos(a), rc * Math.sin(a), fl];
      const p = lerp3(c, [iw0[i][0], iw0[i][1], fl], t);
      p[2] = fl + bump(a, t);
      return p;
    }));
  }
  for (let j = 0; j <= nz; j++) {
    const z = fl + ((zTop * j) / nz) * (zTop - fl) / zTop;
    const pts = j === 0 ? iw0.map((p) => [p[0], p[1], fl] as V3) : Array.from({ length: N }, (_, i) => g.wallPt(i, z, o.wall));
    for (const p of pts) p[2] = j === 0 ? fl : j === nz ? zTop : Math.max(fl, p[2]);
    inner.push(g.ring('wall', z, (i) => pts[i]));
  }

  // inner copy of every outer vertex (grid, then crossings as they are made)
  const innerOf: number[] = [];
  for (let r = 0; r < R; r++) {
    if (outer[r].pole) { innerOf[outer[r].start] = inner[r].start; continue; }
    for (let i = 0; i < N; i++) innerOf[outer[r].start + i] = inner[r].start + i;
  }

  // ---- signed distance field (mm, > 0 in a hole) on the outer grid
  const at = (r: number, i: number) => r * N + (((i % N) + N) % N);
  const P = (r: number, i: number) => pos(g.vid(outer, r, i));
  /** 3D gradient of a per-vertex field from the surface neighbours. */
  const gradient = (f: Float64Array, r: number, i: number): V3 => {
    const rp = r + 1 < R && !outer[r + 1].pole ? r + 1 : r, rm = r - 1 >= 0 && !outer[r - 1].pole ? r - 1 : r;
    const t1 = sub(P(r, i + 1), P(r, i - 1)), t2 = sub(P(rp, i), P(rm, i));
    const f1 = f[at(r, i + 1)] - f[at(r, i - 1)], f2 = f[at(rp, i)] - f[at(rm, i)];
    const a = dot(t1, t1), b = dot(t1, t2), c = dot(t2, t2), det = a * c - b * b;
    if (!(Math.abs(det) > 1e-12)) return [0, 0, 0];
    const al = (c * f1 - b * f2) / det, be = (a * f2 - b * f1) / det;
    return [al * t1[0] + be * t2[0], al * t1[1] + be * t2[1], al * t1[2] + be * t2[2]];
  };
  const FAR = 25;
  const d = new Float64Array(R * N).fill(-FAR);
  const holesOnWall = !!(o.wallField || o.wallHoles?.length), holesOnFloor = !!o.floorHoles?.length;
  if (o.wallField) {
    const raw = new Float64Array(R * N).fill(-1);
    for (let r = wallRow0; r < R; r++) for (let i = 0; i < N; i++) raw[at(r, i)] = o.wallField(i / N, outer[r].z);
    for (let r = wallRow0; r < R; r++) for (let i = 0; i < N; i++) {
      const gl = Math.hypot(...gradient(raw, r, i)), v = raw[at(r, i)];
      d[at(r, i)] = gl > 1e-9 ? Math.max(-FAR, Math.min(FAR, v / gl)) : v > 0 ? FAR : -FAR;
    }
    if (o.wallBand) for (let r = wallRow0; r < R; r++) {
      const lim = Math.min(outer[r].z - o.wallBand[0], o.wallBand[1] - outer[r].z);
      for (let i = 0; i < N; i++) d[at(r, i)] = Math.min(d[at(r, i)], lim);
    }
  }
  if (o.wallHoles?.length) for (let r = wallRow0; r < R; r++) for (let i = 0; i < N; i++) {
    const p = P(r, i);
    for (const h of o.wallHoles) d[at(r, i)] = Math.max(d[at(r, i)], h.r - Math.hypot(...sub(p, h.c)));
  }
  if (holesOnFloor) for (let r = 0; r < wallRow0; r++) {
    if (outer[r].pole) continue;
    for (let i = 0; i < N; i++) {
      const p = P(r, i);
      for (const [hx, hy, hr] of o.floorHoles!) d[at(r, i)] = Math.max(d[at(r, i)], hr - Math.hypot(p[0] - hx, p[1] - hy));
    }
  }
  // rows that must stay solid: next to the pole, the centre-hole ring, the rim
  const solidRow = (r: number) => r === R - 1 || r === 0 || (r === 1 && outer[0].pole);
  const v = new Float64Array(R * N);
  for (let r = 0; r < R; r++) for (let i = 0; i < N; i++) {
    let x = outer[r].pole ? -FAR : d[at(r, i)];
    if (solidRow(r)) x = Math.min(x, -fillet - 0.05);
    d[at(r, i)] = x;
    x += fillet;
    v[at(r, i)] = x === 0 ? -1e-9 : x;
  }

  // ---- direction of each open edge (in the surface, toward the opening), per outer vertex
  const nhat: V3[] = [];
  const rad: number[] = [];
  if (holesOnWall || holesOnFloor) for (let r = 0; r < R; r++) {
    if (outer[r].pole) continue;
    for (let i = 0; i < N; i++) {
      const id = g.vid(outer, r, i);
      nhat[id] = gradient(d, r, i);
      rad[id] = fillet;
    }
  }
  for (let i = 0; i < N; i++) {
    const top = g.vid(outer, R - 1, i);
    nhat[top] = sub(P(R - 1, i), P(R - 2, i));
    rad[top] = rimR;
    if (rc) {
      const id = g.vid(outer, 0, i), p = P(0, i);
      nhat[id] = [-p[0], -p[1], 0];
      rad[id] = fillet;
    }
  }

  // ---- crossings on grid edges (shared by both cells and by outer / inner)
  const crossings = new Map<number, number>();
  const cross = (p: number, q: number, vp: number, vq: number): number => {
    const key = p < q ? p * 1e7 + q : q * 1e7 + p;
    const hit = crossings.get(key);
    if (hit !== undefined) return hit;
    const t = vp / (vp - vq);
    const id = add(lerp3(pos(p), pos(q), t));
    innerOf[id] = add(lerp3(pos(innerOf[p]), pos(innerOf[q]), t));
    nhat[id] = lerp3(nhat[p] ?? [0, 0, 0], nhat[q] ?? [0, 0, 0], t);
    rad[id] = fillet;
    crossings.set(key, id);
    return id;
  };

  const idx: number[] = [];
  const tri = (a: number, b: number, c: number) => { if (a !== b && b !== c && a !== c) idx.push(a, b, c); };
  const poly = (ids: number[]) => {
    for (let k = 1; k + 1 < ids.length; k++) {
      tri(ids[0], ids[k], ids[k + 1]);
      tri(innerOf[ids[0]], innerOf[ids[k + 1]], innerOf[ids[k]]);
    }
  };
  /** Open edges X→Y, in outer-surface order. */
  const open: [number, number][] = [];

  for (let j = 0; j < R - 1; j++) for (let i = 0; i < N; i++) {
    const a = g.vid(outer, j, i), b = g.vid(outer, j, i + 1), c = g.vid(outer, j + 1, i), dd = g.vid(outer, j + 1, i + 1);
    if (outer[j].pole) { poly([a, dd, c]); continue; }
    const va = v[at(j, i)], vb = v[at(j, i + 1)], vc = v[at(j + 1, i)], vd = v[at(j + 1, i + 1)];
    if (j === R - 2) open.push([dd, c]);
    if (j === 0 && rc) open.push([a, b]);
    const ins = +(va < 0) + +(vb < 0) + +(vc < 0) + +(vd < 0);
    if (ins === 4) { poly([a, b, dd, c]); continue; }
    if (ins === 0) continue;
    const saddleAD = va < 0 && vd < 0 && vb >= 0 && vc >= 0, saddleBC = vb < 0 && vc < 0 && va >= 0 && vd >= 0;
    if (saddleAD || saddleBC) {
      const eab = cross(a, b, va, vb), ebd = cross(b, dd, vb, vd), edc = cross(dd, c, vd, vc), eca = cross(c, a, vc, va);
      const centre = (va + vb + vc + vd) / 4 < 0;
      if (saddleAD) {
        poly([a, eab, eca]); poly([dd, edc, ebd]);
        if (centre) { poly([eab, ebd, edc, eca]); open.push([eab, ebd], [edc, eca]); } else open.push([eab, eca], [edc, ebd]);
      } else {
        poly([eab, b, ebd]); poly([edc, c, eca]);
        if (centre) { poly([eab, ebd, edc, eca]); open.push([eca, eab], [ebd, edc]); } else open.push([ebd, eab], [eca, edc]);
      }
      continue;
    }
    const loop: [number, number][] = [[a, va], [b, vb], [dd, vd], [c, vc]];
    const out: number[] = [], isX: boolean[] = [];
    for (let k = 0; k < 4; k++) {
      const [p, vp] = loop[k], [q, vq] = loop[(k + 1) % 4];
      if (vp < 0) { out.push(p); isX.push(false); }
      if ((vp < 0) !== (vq < 0)) { out.push(cross(p, q, vp, vq)); isX.push(true); }
    }
    poly(out);
    for (let k = 0; k < out.length; k++) if (isX[k] && isX[(k + 1) % out.length]) open.push([out[k], out[(k + 1) % out.length]]);
  }

  // ---- rounded edge profile per open-edge vertex: outer → quarter round → flat → quarter round → inner
  const chains = new Map<number, number[]>();
  const chain = (X: number): number[] => {
    const hit = chains.get(X);
    if (hit) return hit;
    const Xi = innerOf[X];
    if (!K) { const c = [X, Xi]; chains.set(X, c); return c; }
    const A = pos(X), B = pos(Xi), T = sub(A, B), L = Math.hypot(...T) || 1e-9;
    const Nn: V3 = [T[0] / L, T[1] / L, T[2] / L];
    let n = nhat[X] ?? [0, 0, 0];
    const s = dot(n, Nn);
    n = [n[0] - s * Nn[0], n[1] - s * Nn[1], n[2] - s * Nn[2]];
    const nl = Math.hypot(...n);
    n = nl > 1e-9 ? [n[0] / nl, n[1] / nl, n[2] / nl] : [0, 0, 0];
    const r = Math.min(rad[X] ?? 0, 0.49 * L);
    const ids = [X];
    for (let k = 1; k <= K; k++) {
      const f = (k / K) * (Math.PI / 2), c = r * (1 - Math.cos(f)), w = r * Math.sin(f);
      ids.push(add([A[0] - Nn[0] * c + n[0] * w, A[1] - Nn[1] * c + n[1] * w, A[2] - Nn[2] * c + n[2] * w]));
    }
    for (let k = K; k >= 1; k--) {
      const f = (k / K) * (Math.PI / 2), c = r * (1 - Math.cos(f)), w = r * Math.sin(f);
      ids.push(add([B[0] + Nn[0] * c + n[0] * w, B[1] + Nn[1] * c + n[1] * w, B[2] + Nn[2] * c + n[2] * w]));
    }
    ids.push(Xi);
    chains.set(X, ids);
    return ids;
  };
  for (const [X, Y] of open) {
    const cx = chain(X), cy = chain(Y);
    for (let k = 0; k + 1 < cx.length; k++) { tri(cy[k], cx[k], cx[k + 1]); tri(cy[k], cx[k + 1], cy[k + 1]); }
  }
  return { vertices: Float32Array.from(verts), indices: Uint32Array.from(idx) };
}

/** Feet: lower the outer floor in round pads (or one ring) near the edge. */
function feetDrop(spec: PlantexSpec, r0: number, f = spec.feet): ((x: number, y: number) => number) | undefined {
  if (!f.enabled || f.height <= 0) return undefined;
  const rr = r0 * f.ring, half = f.size / 2, blend = 1;
  const centres = Array.from({ length: Math.max(0, Math.round(f.count)) }, (_, k) => {
    const a = (k * TAU) / f.count + Math.PI / 2;
    return [Math.cos(a) * rr, Math.sin(a) * rr];
  });
  return (x, y) => {
    const dist = f.count < 1 ? Math.abs(Math.hypot(x, y) - rr) : Math.min(...centres.map(([cx, cy]) => Math.hypot(x - cx, y - cy)));
    const t = Math.min(1, Math.max(0, (half + blend - dist) / blend));
    return f.height * t * t * (3 - 2 * t);
  };
}

const resolution = (spec: PlantexSpec, draft: boolean, cap = Infinity) => ({
  N: Math.max(24, Math.round(Math.min(cap, draft ? Math.min(spec.around, 160) : spec.around) / 4) * 4),
  step: draft ? Math.max(spec.step, 1.5) : Math.max(0.2, spec.step),
  arc: draft ? 2 : 5,
});

/** Planter / vase body for a spec. `masks` resolves linked Patternex artwork. */
export function buildBody(spec: PlantexSpec, masks: (key: string) => Mask | undefined = () => undefined, draft = false): BuildResult {
  const warnings: string[] = [];
  const body = bodyFn(spec);
  const H = body.height;
  let rRef = 0;
  for (let k = 0; k <= 8; k++) rRef += body.radius(0, (H * k) / 8) / 9;
  const tex = textureField(spec, rRef, masks);
  const solid = spec.vaseMode;
  if (solid && spec.textures.some((t) => t.enabled && t.mode === 'cut')) warnings.push('Vase mode prints one closed wall: cut-through layers are debossed instead.');
  if (solid && spec.drain.enabled) warnings.push('Vase mode has a solid bottom: drain holes are left out.');
  const wall = Math.max(0.8, spec.wall);
  if (!solid && tex.maxDeboss > wall - 0.6) warnings.push(`Deboss depth ${tex.maxDeboss.toFixed(1)} mm leaves less than 0.6 mm of a ${wall} mm wall.`);
  const { N, step, arc } = resolution(spec, draft);
  const fl = Math.max(0.8, spec.floor);
  const sw = spec.selfWater;
  const selfWater = !solid && spec.kind === 'planter' && sw.enabled;
  const d = spec.drain;
  let r0 = 0;
  for (let k = 0; k < 16; k++) r0 += body.radius((k * TAU) / 16, 0) / 16;
  const rIn = r0 - wall;
  const holes: [number, number, number][] = [];
  let center = 0;
  if (!solid && d.enabled && !selfWater) {
    center = d.center / 2;
    for (let k = 0; k < d.count; k++) {
      const a = (k * TAU) / d.count;
      holes.push([Math.cos(a) * rIn * d.ring, Math.sin(a) * rIn * d.ring, d.diameter / 2]);
    }
  }
  if (selfWater && d.enabled) warnings.push('Self-watering: the planter floor stays closed to hold the reservoir; water drains through the overflow hole.');
  const wallHoles: { c: V3; r: number }[] = [];
  if (selfWater && sw.overflow > 0) {
    const z = fl + Math.max(sw.overflow / 2 + 1, sw.reservoir - sw.overflow / 2 - 2);
    const r = body.radius(0, z);
    wallHoles.push({ c: [r + tex.disp(0, z), 0, z], r: sw.overflow / 2 });
  }
  const fillet = Math.max(0, Math.min(spec.fillet, wall / 2));
  const mesh = buildShell({
    N, height: H, step, solid, wall, floor: fl, arc,
    radius: body.radius,
    disp: tex.disp,
    wallField: tex.hasCut ? tex.cutField : undefined,
    wallBand: [fl + spec.solidBase, H - spec.solidRim],
    wallHoles: wallHoles.length ? wallHoles : undefined,
    floorHoles: holes.length ? holes : undefined,
    centerHole: center,
    fillet, rimRound: spec.rimRound,
    floorDrop: solid ? undefined : feetDrop(spec, r0),
  });
  return { mesh, warnings, triangles: mesh.indices.length / 3 };
}

/** Saucer matching the base outline of the body. */
export function buildSaucer(spec: PlantexSpec, draft = false): BuildResult {
  const body = bodyFn(spec);
  const s = spec.saucer;
  let emb = 0;
  for (const t of spec.textures) if (t.enabled && t.mode === 'emboss' && t.z0 <= 0.05) emb = Math.max(emb, t.depth);
  const h = Math.max(s.floor + 2, s.height);
  const { N, arc } = resolution(spec, draft, 240);
  const ribs = Math.max(0, Math.round(s.ribs));
  const ribH = 1.6;
  const mesh = buildShell({
    N, height: h, step: draft ? 2 : 0.8, solid: false, wall: s.wall, floor: s.floor, arc, rimRound: Math.min(spec.rimRound, s.wall / 2),
    radius: (a, z) => body.radius(a, 0) + emb + s.gap + s.wall + s.flare * (z / h),
    floorBump: ribs ? (a, rho) => (rho > 0.25 && rho < 0.9 && Math.abs(((a * ribs) / TAU) % 1 - 0.5) > 0.42 ? ribH : 0) : undefined,
  });
  return { mesh, warnings: [], triangles: mesh.indices.length / 3 };
}

/**
 * Self-watering insert: an inner pot that stands on legs above the planter floor (the reservoir), with a
 * centre wick hole and slots in its floor. Its outline follows the planter's inner wall minus a gap.
 */
export function buildInsert(spec: PlantexSpec, masks: (key: string) => Mask | undefined = () => undefined, draft = false): BuildResult {
  const warnings: string[] = [];
  const body = bodyFn(spec);
  const sw = spec.selfWater;
  const H = body.height;
  let rRef = 0;
  for (let k = 0; k <= 8; k++) rRef += body.radius(0, (H * k) / 8) / 9;
  const deboss = textureField(spec, rRef, masks).maxDeboss;
  const fl = Math.max(0.8, spec.floor);
  const lift = Math.max(5, sw.reservoir);
  const h = Math.max(10, H - fl - lift - 2);
  const off = Math.max(0.8, spec.wall) + deboss + sw.gap;
  const radius = (a: number, z: number) => Math.max(5, body.radius(a, z + fl + lift) - off);
  // the insert must pass through the rim: every height must fit under the narrowest opening above it
  for (let k = 0; k < 24; k++) {
    const a = (k * TAU) / 24;
    let above = Infinity;
    for (let z = H; z >= fl + lift; z -= 2) {
      above = Math.min(above, body.radius(a, z) - Math.max(0.8, spec.wall) - deboss);
      if (radius(a, z - fl - lift) > above + 0.01) { warnings.push('The insert is wider than the opening above it and will not drop in: open up the rim or narrow the belly.'); k = 24; break; }
    }
  }
  const { N, step, arc } = resolution(spec, draft, 240);
  let r0 = 0;
  for (let k = 0; k < 16; k++) r0 += radius((k * TAU) / 16, 0) / 16;
  const slots: [number, number, number][] = [];
  for (let k = 0; k < sw.slots; k++) {
    const a = (k * TAU) / sw.slots + Math.PI / Math.max(1, sw.slots) + Math.PI / 6;
    slots.push([Math.cos(a) * r0 * 0.62, Math.sin(a) * r0 * 0.62, 2.5]);
  }
  const mesh = buildShell({
    N, height: h, step: Math.max(step, 0.8), solid: false, wall: sw.wall, floor: Math.max(1.2, sw.wall), arc,
    radius,
    centerHole: sw.wick / 2,
    floorHoles: slots.length ? slots : undefined,
    fillet: Math.min(spec.fillet, sw.wall / 2), rimRound: Math.min(spec.rimRound, sw.wall / 2),
    floorDrop: feetDrop(spec, r0, { enabled: true, count: 3, height: lift, size: 10, ring: 0.8 }),
  });
  return { mesh, warnings, triangles: mesh.indices.length / 3 };
}
