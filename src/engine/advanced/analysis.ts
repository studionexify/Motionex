// Part analysis: implicit field, surface fields, cross-section profile, topology and the zone map the
// router works from. Runs in the slicing worker (for slicing) and in the analysis worker (for the
// Zone Inspector), and is deterministic so both see the same zones.
import type { IndexedMesh } from '../mesh';
import { Grid3 } from './grid';
import { surfaceFields, triNeighbours, type SurfaceFields } from './meshfields';
import { meshSdf, type SdfField } from './sdf';
import { sectionProfile, type SectionProfile, type Boss } from './sections';
import { ZONE_KINDS, zoneIndex, type ObjectAnalysis, type ZoneKind, type ZoneStat, type FieldId } from './types';

export interface AnalysisParams {
  /** Voxels along the longest side. */
  cells: number;
  /** Total wall thickness (outer + inner walls), mm. */
  shell: number;
  lineWidth: number;
  layerHeight: number;
  /** Support threshold angle (deg from horizontal). */
  overhangDeg: number;
  /** Paint colour per triangle (multi-material interfaces), if any. */
  color?: Uint8Array;
  /** Advanced paint per triangle: 1 fixture, 2 load face, 3 matte, 4 gloss. */
  advPaint?: Uint8Array;
  /** Load case of the FEA (direction, total force). */
  load?: { dir: [number, number, number]; newtons: number };
}

export interface PartAnalysis {
  mesh: IndexedMesh;
  sdf: SdfField;
  surf: SurfaceFields;
  sections: SectionProfile;
  bosses: Boss[];
  triZone: Uint8Array;
  /** Volume zone per voxel (index into ZONE_KINDS), 255 outside. */
  voxZone: Uint8Array;
  zones: ZoneStat[];
  betti: [number, number];
  volume: number;
  params: AnalysisParams;
  /** Extra per-triangle fields filled by later solvers (harmonic, stress, branch). */
  extra: Partial<Record<FieldId, Float32Array>>;
}

export const RESOLUTION_CELLS = { draft: 40, normal: 64, fine: 96 } as const;

const DEG = Math.PI / 180;

/** Euler characteristic → genus per connected surface: b₁ of the solid it bounds. */
export function topology(m: IndexedMesh): [number, number] {
  const V = m.vertices.length / 3, ix = m.indices, T = ix.length / 3;
  const parent = new Int32Array(V).map((_, i) => i);
  const find = (a: number): number => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  for (let t = 0; t < T; t++) {
    const a = find(ix[t * 3]), b = find(ix[t * 3 + 1]), c = find(ix[t * 3 + 2]);
    parent[b] = a; parent[find(c)] = a;
  }
  const used = new Uint8Array(V);
  for (let t = 0; t < ix.length; t++) used[ix[t]] = 1;
  const comps = new Map<number, { v: number; f: number; e: Set<number> }>();
  for (let i = 0; i < V; i++) if (used[i]) { const r = find(i); const c = comps.get(r) ?? { v: 0, f: 0, e: new Set() }; c.v++; comps.set(r, c); }
  for (let t = 0; t < T; t++) {
    const c = comps.get(find(ix[t * 3]))!;
    c.f++;
    for (let k = 0; k < 3; k++) { const a = ix[t * 3 + k], b = ix[t * 3 + ((k + 1) % 3)]; c.e.add(a < b ? a * V + b : b * V + a); }
  }
  let genus = 0;
  for (const c of comps.values()) { const chi = c.v - c.e.size + c.f; genus += Math.max(0, Math.round((2 - chi) / 2)); }
  return [comps.size, genus];
}

export function analyzePart(mesh: IndexedMesh, p: AnalysisParams): PartAnalysis {
  const sdf = meshSdf(mesh, p.cells);
  const surf = surfaceFields(mesh, Math.max(sdf.max[0] - sdf.min[0], sdf.max[1] - sdf.min[1], sdf.max[2] - sdf.min[2]) * 2);
  const step = Math.max(p.layerHeight, (sdf.max[2] - sdf.min[2]) / 200);
  const sections = sectionProfile(mesh, sdf.min[2], sdf.max[2], step);
  const g = sdf.sdf;
  const T = surf.triCount;

  // ---- surface zones (priority: overhang › boss › neck › interface › thin › helical › dome › shallow › curved wall › plain)
  const triZone = new Uint8Array(T);
  const cosOver = Math.cos(p.overhangDeg * DEG);
  const size = Math.max(sdf.max[0] - sdf.min[0], sdf.max[1] - sdf.min[1], sdf.max[2] - sdf.min[2]);
  const domeCurv = 1 / Math.max(size * 1.5, 5);
  const inBand = (z: number, bands: [number, number][]) => bands.some(([a, b]) => z >= a && z <= b);
  const nearBoss = (x: number, y: number, z: number, pad: number) => sections.bosses.some((b) => z >= b.z0 - pad && z <= b.z1 + pad && Math.hypot(x - b.cx, y - b.cy) <= b.r + pad);
  const nb = p.color ? triNeighbours(mesh.indices, mesh.vertices.length / 3) : null;
  for (let t = 0; t < T; t++) {
    const nz = surf.normal[t * 3 + 2];
    const x = surf.centroid[t * 3], y = surf.centroid[t * 3 + 1], z = surf.centroid[t * 3 + 2];
    const slope = surf.slope[t];
    const side = slope > 45 && slope < 135;
    let k: ZoneKind = 'plain';
    if (nz < -cosOver && z > sdf.min[2] + 0.05) k = 'overhang';
    else if (nearBoss(x, y, z, 0.3)) k = 'boss';
    else if (side && inBand(z, sections.necks)) k = 'neck';
    else if (nb && p.color && [0, 1, 2].some((e) => { const o = nb[t * 3 + e]; return o >= 0 && p.color![o] !== p.color![t]; })) k = 'interface';
    else if (surf.thickness[t] < p.shell * 1.2 && surf.thickness[t] > 0 && side && !inBand(z, sections.helical)) k = 'thin';
    else if (side && inBand(z, sections.helical)) k = 'helical';
    else if (nz > 0 && slope > 1 && slope < 35 && Math.abs(surf.meanCurv[t]) > domeCurv) k = 'dome';
    else if (nz > 0 && slope > 1 && slope < 35) k = 'shallow';
    else if (slope >= 35 && slope <= 80) k = 'curved_wall';
    triZone[t] = zoneIndex(k);
  }

  // ---- volume zones per voxel
  const voxZone = new Uint8Array(g.n).fill(255);
  const hubPad = (b: Boss) => Math.max(2.5 * b.r, 3);
  for (let kk = 0; kk < g.nz; kk++) {
    const z = g.z(kk);
    for (let j = 0; j < g.ny; j++) for (let i = 0; i < g.nx; i++) {
      const q = g.idx(i, j, kk);
      if (!sdf.inside[q]) continue;
      const x = g.x(i), y = g.y(j), depth = -g.data[q];
      let k: ZoneKind = 'plain';
      const boss = sections.bosses.find((b) => z >= b.z0 - 1 && z <= b.z1 + 1 && Math.hypot(x - b.cx, y - b.cy) <= b.r + hubPad(b));
      if (boss) k = 'boss';
      else if (inBand(z, sections.necks)) k = 'neck';
      else if (inBand(z, sections.helical) && depth < p.shell + p.lineWidth) k = 'helical';
      else if (depth > p.shell + 2 * p.lineWidth) k = 'core';
      voxZone[q] = zoneIndex(k);
    }
  }

  // ---- statistics
  const stats = new Map<ZoneKind, ZoneStat>();
  const stat = (k: ZoneKind) => { let s = stats.get(k); if (!s) { s = { kind: k, areaMm2: 0, volumeMm3: 0, triangles: 0 }; stats.set(k, s); } return s; };
  for (let t = 0; t < T; t++) { const s = stat(ZONE_KINDS[triZone[t]]); s.areaMm2 += surf.area[t]; s.triangles++; }
  const cellVol = g.h ** 3;
  let volume = 0;
  for (let q = 0; q < g.n; q++) if (voxZone[q] !== 255) { stat(ZONE_KINDS[voxZone[q]]).volumeMm3 += cellVol; volume += cellVol; }
  const zones = ZONE_KINDS.map((k) => stats.get(k)).filter((s): s is ZoneStat => !!s);
  return { mesh, sdf, surf, sections, bosses: sections.bosses, triZone, voxZone, zones, betti: topology(mesh), volume, params: p, extra: {} };
}

/** Plain-data view for the Zone Inspector. */
export function toObjectAnalysis(id: string, name: string, a: PartAnalysis, maxPoints = 12000): ObjectAnalysis {
  const g: Grid3 = a.sdf.sdf;
  const fields: ObjectAnalysis['fields'] = {
    zones: Float32Array.from(a.triZone),
    thickness: a.surf.thickness.map((v) => Math.min(v, 50)),
    curvature: a.surf.meanCurv,
    overhang: a.surf.slope.map((s) => Math.max(0, s - 90)),
    ...a.extra,
  };
  const ranges: ObjectAnalysis['ranges'] = {};
  const area = a.surf.area;
  for (const [k, arr] of Object.entries(fields) as [FieldId, Float32Array][]) {
    if (k === 'zones') { ranges.zones = [0, ZONE_KINDS.length - 1]; continue; }
    if (k === 'harmonic') { ranges.harmonic = [0, 1]; continue; }
    // robust range: 2nd–98th area-weighted percentile (a few huge triangles count as much as many small ones)
    const idx = Array.from(arr.keys()).filter((t) => Number.isFinite(arr[t])).sort((x, y) => arr[x] - arr[y]);
    const total = idx.reduce((s, t) => s + area[t], 0);
    let acc = 0, lo = NaN, hi = NaN;
    for (const t of idx) { acc += area[t]; if (Number.isNaN(lo) && acc >= 0.02 * total) lo = arr[t]; if (Number.isNaN(hi) && acc >= 0.98 * total) hi = arr[t]; }
    ranges[k] = idx.length ? [Number.isNaN(lo) ? arr[idx[0]] : lo, Number.isNaN(hi) ? arr[idx[idx.length - 1]] : hi] : [0, 1];
    if (ranges[k]![1] <= ranges[k]![0]) ranges[k] = [arr[idx[0]] ?? 0, arr[idx[idx.length - 1]] ?? 1];
  }
  let inside = 0;
  for (let q = 0; q < g.n; q++) if (a.voxZone[q] !== 255 && a.voxZone[q] !== zoneIndex('plain')) inside++;
  const stride = Math.max(1, Math.ceil(inside / maxPoints));
  const pts: number[] = [];
  let c = 0;
  for (let k = 0; k < g.nz; k++) for (let j = 0; j < g.ny; j++) for (let i = 0; i < g.nx; i++) {
    const q = g.idx(i, j, k), zk = a.voxZone[q];
    if (zk === 255 || zk === zoneIndex('plain')) continue;
    if (c++ % stride) continue;
    pts.push(g.x(i), g.y(j), g.z(k), zk);
  }
  return {
    id, name, triZone: a.triZone, fields, ranges, zones: a.zones, voxels: new Float32Array(pts),
    branches: Math.max(1, ...a.sections.islands), betti: a.betti, volumeMm3: a.volume,
  };
}
