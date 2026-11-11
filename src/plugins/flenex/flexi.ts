// Flenex cut engine. A flexi is a solid model plus a list of cuts. Each cut is a plane (a point and a
// normal) with a joint. Building cuts the model apart with a thin kerf, carves the sockets and slots,
// then fuses the moving parts on, so the result prints in one piece and moves once it is off the bed.
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import type { IndexedMesh } from '../../engine/mesh';
import { openEdgeCount } from '../../engine/mesh';
import { free, meshOf, pieces, solid, toGeometry, transform, unionAll, bounds, type Solid, type V3 } from './csg';
import { buildExtraJoint, EXTRA_KINDS } from './joints-extra';
import { buildJoint, defaultJoint, type JointInfo, type JointSpec, type Probe } from './joints';
import type { Fit } from './fit';

export interface Cut {
  id: string;
  name: string;
  /** A point in the section where the joint sits (model frame, mm). It is re-centred on the section. */
  origin: V3;
  /** Direction from piece A into piece B. */
  normal: V3;
  /** Rotates the hinge axis around the normal (°). */
  roll: number;
  /** Radius of the kerf disc (0 = automatic from the section). */
  radius: number;
  joint: JointSpec;
  enabled: boolean;
  /** Set on cuts that come from a part (group) and the position in it. */
  group?: string;
  index?: number;
}

export const newCut = (id: string, origin: V3, normal: V3, joint: JointSpec = defaultJoint(), roll = 0): Cut => ({ id, name: `Cut ${id}`, origin, normal, roll, radius: 0, joint, enabled: true });

export interface CutReport {
  id: string;
  name: string;
  ok: boolean;
  /** Centre the joint was placed on. */
  centre: V3;
  radius: number;
  info?: JointInfo;
  probe?: Probe;
  warnings: string[];
}

export interface FlexiResult {
  mesh: IndexedMesh;
  /** Connected pieces of the finished model, and the piece of each triangle. */
  pieces: IndexedMesh[];
  triPiece: Int32Array;
  reports: CutReport[];
  warnings: string[];
  /** Mesh is closed (no open edges). */
  closed: boolean;
}

const v3 = (a: V3) => new THREE.Vector3(a[0], a[1], a[2]);

/** The frame of a cut: x across the hinge, y along its axis, z the normal. */
export function cutFrame(origin: V3, normalIn: V3, roll: number, up: V3 = [0, 0, 1]): THREE.Matrix4 {
  const n = v3(normalIn).normalize();
  const upV = v3(up).normalize();
  let a = upV.clone().sub(n.clone().multiplyScalar(upV.dot(n)));
  if (a.lengthSq() < 1e-6) a = Math.abs(n.x) < 0.9 ? new THREE.Vector3(1, 0, 0).sub(n.clone().multiplyScalar(n.x)) : new THREE.Vector3(0, 1, 0).sub(n.clone().multiplyScalar(n.y));
  a.normalize();
  a.applyAxisAngle(n, roll * Math.PI / 180);
  const u = a.clone().cross(n).normalize();
  const m = new THREE.Matrix4().makeBasis(u, a, n);
  m.setPosition(v3(origin));
  return m;
}

/** BVH of the model for the probes. */
export const modelBvh = (m: IndexedMesh) => new MeshBVH(toGeometry(m));

/** Farthest point of the model's section with the cut plane from the centre (within `gate` mm): sets how far the kerf must reach. */
export function sectionReach(m: IndexedMesh, centre: V3, normal: V3, gate: number): number {
  const n = v3(normal).normalize(), c = v3(centre);
  const V = m.vertices, I = m.indices, d = new Float32Array(V.length / 3);
  for (let i = 0; i < d.length; i++) d[i] = (V[i * 3] - c.x) * n.x + (V[i * 3 + 1] - c.y) * n.y + (V[i * 3 + 2] - c.z) * n.z;
  let best = 0;
  const p = new THREE.Vector3();
  const edge = (a: number, b: number) => {
    if ((d[a] > 0) === (d[b] > 0)) return;
    const t = d[a] / (d[a] - d[b]);
    p.set(V[a * 3] + (V[b * 3] - V[a * 3]) * t - c.x, V[a * 3 + 1] + (V[b * 3 + 1] - V[a * 3 + 1]) * t - c.y, V[a * 3 + 2] + (V[b * 3 + 2] - V[a * 3 + 2]) * t - c.z);
    const r = p.length();
    if (r <= gate && r > best) best = r;
  };
  for (let t = 0; t < I.length; t += 3) { edge(I[t], I[t + 1]); edge(I[t + 1], I[t + 2]); edge(I[t + 2], I[t]); }
  return best;
}

/** Shoot rays from `origin` to learn the section: its centre, thinnest and widest reach, depth either side. */
export function probeCut(bvh: MeshBVH, origin: V3, normal: V3, roll: number, up: V3 = [0, 0, 1], rays = 24, robust = false): { probe: Probe; centre: V3 } {
  const M = cutFrame(origin, normal, roll, up);
  const x = new THREE.Vector3(), y = new THREE.Vector3(), z = new THREE.Vector3();
  M.extractBasis(x, y, z);
  const ray = new THREE.Ray();
  const hit = (o: THREE.Vector3, d: THREE.Vector3): number => {
    ray.origin.copy(o); ray.direction.copy(d);
    const h = bvh.raycastFirst(ray, THREE.DoubleSide);
    return h ? h.distance : Infinity;
  };
  const c = v3(origin);
  // inside test: most of six rays leave through a back face
  const inside = (() => {
    let n = 0;
    for (const d of [z, z.clone().negate(), x, x.clone().negate(), y, y.clone().negate()]) {
      ray.origin.copy(c); ray.direction.copy(d);
      const h = bvh.raycastFirst(ray, THREE.DoubleSide);
      if (h && h.face!.normal.dot(d) > 0) n++;
    }
    return n >= 4;
  })();
  const dirs = Array.from({ length: rays }, (_, i) => { const a = (i / rays) * Math.PI * 2; return x.clone().multiplyScalar(Math.cos(a)).add(y.clone().multiplyScalar(Math.sin(a))); });
  // re-centre on the section, three times
  for (let it = 0; it < 3; it++) {
    const hits: (THREE.Vector3 | null)[] = dirs.map((d) => { const t = hit(c, d); return isFinite(t) ? c.clone().addScaledVector(d, t) : null; });
    let target: THREE.Vector3;
    if (robust) {
      // midpoints of opposite rays, then their median: a leg or wing running off to one side moves a few midpoints, not the centre
      const half = rays / 2, mids: THREE.Vector3[] = [];
      for (let i = 0; i < half; i++) { const a = hits[i], b = hits[i + half]; if (a && b) mids.push(a.clone().add(b).multiplyScalar(0.5)); }
      if (mids.length < half * 0.6) break;
      const med = (k: 'x' | 'y' | 'z') => { const v = mids.map((m) => m[k]).sort((p, q) => p - q); return v[Math.floor(v.length / 2)]; };
      target = new THREE.Vector3(med('x'), med('y'), med('z'));
    } else {
      const ok = hits.filter((h): h is THREE.Vector3 => !!h);
      if (ok.length < rays * 0.6) break;
      target = new THREE.Vector3();
      for (const h of ok) target.add(h);
      target.multiplyScalar(1 / ok.length);
    }
    // keep the centre in the cut plane
    const off = target.sub(c); off.addScaledVector(z, -off.dot(z));
    c.add(off);
  }
  let inr = Infinity, outr = 0;
  for (const d of dirs) { const t = hit(c, d); if (isFinite(t)) { inr = Math.min(inr, t); outr = Math.max(outr, t); } }
  const fy = [hit(c, y), hit(c, y.clone().negate())].filter(isFinite);
  const extentA = fy.length ? Math.min(...fy) : inr;
  const dA = hit(c, z.clone().negate()), dB = hit(c, z);
  return {
    centre: [c.x, c.y, c.z],
    probe: { inr: isFinite(inr) ? inr : 0, outr, depthA: isFinite(dA) ? dA : 1e3, depthB: isFinite(dB) ? dB : 1e3, extentA: isFinite(extentA) ? extentA : 0, inside },
  };
}


export function buildFlexi(base: IndexedMesh, cuts: Cut[], fit: Fit, up: V3 = [0, 0, 1], progress?: (done: number, total: number) => void): FlexiResult {
  const bvh = modelBvh(base);
  const reports: CutReport[] = [];
  const warnings: string[] = [];
  const cutters: Solid[] = [], adds: Solid[] = [];
  for (const cut of cuts) {
    if (!cut.enabled) continue;
    const { probe, centre } = probeCut(bvh, cut.origin, cut.normal, cut.roll, up);
    const rep: CutReport = { id: cut.id, name: cut.name, ok: false, centre, radius: 0, probe, warnings: [] };
    reports.push(rep);
    if (!probe.inside || probe.inr < fit.minPin * 2) { rep.warnings.push(probe.inside ? 'The section here is too thin for a joint.' : 'This cut is outside the model.'); continue; }
    const M = cutFrame(centre, cut.normal, cut.roll, up);
    const radius = cut.radius > 0 ? cut.radius : Math.max(probe.outr, sectionReach(base, centre, cut.normal, probe.outr * 6)) * 1.04 + fit.gap * 2;
    const parts = (EXTRA_KINDS.has(cut.joint.kind) ? buildExtraJoint : buildJoint)(cut.joint, { probe, fit, apex: apexFor(M, up), radiusLimit: radius });
    rep.info = parts.info; rep.radius = radius; rep.warnings.push(...parts.info.warnings);
    const tf = (m: IndexedMesh) => solid(transform(m, M));
    cutters.push(tf(parts.kerf), ...parts.cutB.map(tf));
    adds.push(...parts.addA.map(tf), ...parts.addB.map(tf));
    rep.ok = true;
    progress?.(reports.length, cuts.length + 2);
  }
  const bs = solid(base);
  let r = bs;
  if (cutters.length) { const cu = unionAll(cutters); r = bs.subtract(cu); free(cu); }
  progress?.(cuts.length + 1, cuts.length + 2);
  if (adds.length) { const ad = unionAll(adds); const r2 = r.add(ad); free(r, ad); r = r2; }
  const m = meshOf(r);
  free(r, ...(r === bs ? [] : [bs]), ...cutters, ...adds);
  const res = pieces(m);
  if (res.meshes.length < 2 && reports.some((x) => x.ok)) warnings.push('The cuts did not separate the model into pieces: a cut may not pass through the whole section.');
  for (const r of reports) for (const o of reports) if (o !== r && o.ok && r.ok && o.id > r.id) {
    const d = v3(r.centre).distanceTo(v3(o.centre));
    const need = Math.max((r.info?.reachB ?? 0) + (o.info?.reachA ?? 0), (o.info?.reachB ?? 0) + (r.info?.reachA ?? 0)) + fit.wall;
    if (d < need * 0.95) r.warnings.push(`Too close to ${o.name} (${d.toFixed(1)} mm apart, the joints need about ${need.toFixed(1)} mm).`);
  }
  for (const r of reports) for (const w of r.warnings) warnings.push(`${r.name}: ${w}`);
  return { mesh: m, pieces: res.meshes, triPiece: res.triPiece, reports, warnings, closed: openEdgeCount(m) === 0 };
}

/** Angle in the (u, z) plane of the print-up direction, for teardrop pins (undefined when the pin axis is vertical). */
function apexFor(M: THREE.Matrix4, up: V3): number | undefined {
  const x = new THREE.Vector3(), y = new THREE.Vector3(), z = new THREE.Vector3();
  M.extractBasis(x, y, z);
  const u = v3(up);
  if (Math.abs(u.dot(y)) > 0.95) return undefined;
  return Math.atan2(u.dot(z), u.dot(x));
}

export { bounds };
