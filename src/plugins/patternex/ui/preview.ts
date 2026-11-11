// Live toolpath view for Patternex (no slicing): outer-wall loops at sample heights, coloured by the
// filament each point will print with, using the same projection + fill test as the slicer.
// Also maps Patternex regions to triangles so the Motionex quick preview can use them as targets.
import * as THREE from 'three';
import { sliceMesh } from '../../../engine/slice';
import { SCALE } from '../../../engine/clipper';
import { transformVertices, type IndexedMesh } from '../../../engine/mesh';
import { objectMatrix, useStore } from '../../../state/store';
import { plateObjects } from '../../../state/slicing';
import type { Pattern } from '../model';
import { faces, frameOf, minCosOf, ShapeIndex, toPattern, type Frame, type V3, type WorldPlacement } from '../projection';
import { toWorldPlacements, type PatternexState } from './state';

export interface PreviewLines { positions: Float32Array; colors: Float32Array; layers: number }

const MAX_LAYERS = 140;
const STEP = 0.4; // mm between samples along a wall

interface Group { f: Frame; idx: ShapeIndex; slot: number; key: string; motion: boolean; minCos: number; relief: number }

const rgb = (hex: string): [number, number, number] => { const c = new THREE.Color(hex); return [c.r, c.g, c.b]; };

/** Inked groups of every visible placement on an object (plate world coordinates). */
function groupsFor(px: PatternexState, wps: WorldPlacement[]): Group[] {
  const out: Group[] = [];
  for (const wp of wps) {
    const pat = px.patterns.find((p) => p.id === wp.pattern_id);
    if (!pat) continue;
    const f = frameOf(wp, pat);
    for (const a of px.actions) {
      if (a.region_ref.placement_id !== wp.id || !a.region_ref.color_group) continue;
      const shapes = pat.shapes.filter((s) => s.fill_color === a.region_ref.color_group);
      if (shapes.length) out.push({ f, idx: new ShapeIndex(shapes), slot: a.material.slot_index, key: `${wp.id}:${a.region_ref.color_group}`, motion: !!a.motion, minCos: minCosOf(wp), relief: a.relief ? (a.relief.mode === 'raise' ? 1 : -1) * a.relief.height_mm : 0 });
    }
  }
  return out;
}

/** World placements per object of the active plate (printable objects only, like the slicer). */
function worldOf(px: PatternexState) {
  const s = useStore.getState();
  const objs = plateObjects(s.activePlate).filter((o) => o.printable !== false && px.placements.some((p) => p.object_id === o.id));
  return objs.map((o) => ({
    o,
    mesh: { vertices: transformVertices(o.mesh.vertices, objectMatrix(o).elements), indices: o.mesh.indices } as IndexedMesh,
    wps: toWorldPlacements(px.placements.filter((p) => p.object_id === o.id), [{ id: o.id, matrix: objectMatrix(o).elements }]),
  }));
}

export function patternexPreview(px: PatternexState): PreviewLines | null {
  const s = useStore.getState();
  const slotRgb = s.filaments.map((f) => rgb(f.color));
  const pos: number[] = [], col: number[] = [];
  let layersDrawn = 0;
  const lh = Number(s.overrides.layer_height) || 0.2;
  for (const { o, mesh, wps } of worldOf(px)) {
    const groups = groupsFor(px, wps);
    if (!groups.length) continue;
    const base = slotRgb[o.filament ?? 0] ?? [0.6, 0.6, 0.6];
    const v = mesh.vertices;
    let zMin = Infinity, zMax = -Infinity;
    for (let i = 2; i < v.length; i += 3) { zMin = Math.min(zMin, v[i]); zMax = Math.max(zMax, v[i]); }
    const n = Math.floor((zMax - zMin) / lh);
    const every = Math.max(1, Math.ceil(n / MAX_LAYERS));
    const planes: number[] = [];
    for (let i = 0; i < n; i += every) planes.push(zMin + (i + 0.5) * lh);
    const loops = sliceMesh(mesh, planes);
    // flat artwork (top/bottom faces): scan lines over the face at the anchor height, inked inside the artwork
    for (const g of groups) {
      if (Math.abs(g.f.axis[2]) < 0.7 || g.motion) continue;
      const zf = g.f.origin[2] - Math.sign(g.f.axis[2]) * lh / 2;
      const [loops] = sliceMesh(mesh, [zf]);
      if (!loops?.length) continue;
      const rings = loops.map((p) => p.map((q) => [q.X / SCALE, q.Y / SCALE] as [number, number]));
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const r of rings) for (const [x, y] of r) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
      const inSlice = (x: number, y: number) => { let c = 0; for (const r of rings) for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const [xi, yi] = r[i], [xj, yj] = r[j]; if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c++; } return c % 2 === 1; };
      const ink = slotRgb[g.slot] ?? base;
      const zl = zf + lh / 2 + 0.02;
      for (let y = y0 + 0.25; y < y1; y += 0.5) for (let x = x0; x < x1; x += STEP) {
        const xm = x + STEP / 2;
        if (!inSlice(xm, y)) continue;
        const [qx, qy] = toPattern(g.f, xm, y, zl);
        const c = g.idx.contains(qx, qy) ? ink : base;
        pos.push(x, y, zl, x + STEP, y, zl); col.push(...c, ...c);
      }
      layersDrawn++;
    }
    planes.forEach((z, li) => {
      let drew = false;
      for (const path of loops[li] ?? []) {
        const m = path.length;
        if (m < 3) continue;
        for (let k = 0; k < m; k++) {
          const a = path[k], b = path[(k + 1) % m];
          const ax = a.X / SCALE, ay = a.Y / SCALE, bx = b.X / SCALE, by = b.Y / SCALE;
          const len = Math.hypot(bx - ax, by - ay);
          if (len < 1e-6) continue;
          const nrm: V3 = [(by - ay) / len, -(bx - ax) / len, 0];
          const steps = Math.max(1, Math.ceil(len / STEP));
          for (let st = 0; st < steps; st++) {
            const t0 = st / steps, t1 = (st + 1) / steps, tm = (t0 + t1) / 2;
            const mx = ax + (bx - ax) * tm, my = ay + (by - ay) * tm;
            // the last matching group wins, as in the slicer (later placements override earlier ones)
            let c = base, motion = false, off = 0;
            for (const g of groups) {
              if (!faces(g.f, mx, my, z, nrm, g.minCos)) continue;
              const [px2, py2] = toPattern(g.f, mx, my, z);
              if (g.idx.contains(px2, py2)) { c = slotRgb[g.slot] ?? base; motion = g.motion; off = g.relief; }
            }
            // Motionex draws the moved path for regions with motion, in the same ink colour
            if (motion) continue;
            // relief: the wall moves out (raised) or in (recessed) where the artwork is
            const ox = nrm[0] * off, oy = nrm[1] * off;
            pos.push(ax + (bx - ax) * t0 + ox, ay + (by - ay) * t0 + oy, z, ax + (bx - ax) * t1 + ox, ay + (by - ay) * t1 + oy, z);
            col.push(...c, ...c);
            drew = true;
          }
        }
      }
      if (drew) layersDrawn++;
    });
  }
  return pos.length ? { positions: Float32Array.from(pos), colors: Float32Array.from(col), layers: layersDrawn } : null;
}

/**
 * Triangles of each object that lie in a Patternex region (centroid inside the artwork, facing the projection):
 * the same test the slicer uses on wall outlines, at triangle resolution, for the Motionex quick preview.
 */
export function regionTriangles(px: PatternexState, regionId: string): Map<string, number[]> {
  const out = new Map<string, number[]>();
  const sep = regionId.lastIndexOf(':');
  const placementId = regionId.slice(0, sep), color = regionId.slice(sep + 1);
  for (const { o, mesh, wps } of worldOf(px)) {
    const wp = wps.find((p) => p.id === placementId);
    const pat: Pattern | undefined = wp && px.patterns.find((p) => p.id === wp.pattern_id);
    if (!wp || !pat) continue;
    const shapes = pat.shapes.filter((s) => s.fill_color === color);
    if (!shapes.length) continue;
    const f = frameOf(wp, pat), idx = new ShapeIndex(shapes);
    const v = mesh.vertices, ix = mesh.indices, tris: number[] = [];
    for (let t = 0; t < ix.length / 3; t++) {
      const a = ix[t * 3] * 3, b = ix[t * 3 + 1] * 3, c = ix[t * 3 + 2] * 3;
      const cx = (v[a] + v[b] + v[c]) / 3, cy = (v[a + 1] + v[b + 1] + v[c + 1]) / 3, cz = (v[a + 2] + v[b + 2] + v[c + 2]) / 3;
      const ux = v[b] - v[a], uy = v[b + 1] - v[a + 1], uz = v[b + 2] - v[a + 2], wx = v[c] - v[a], wy = v[c + 1] - v[a + 1], wz = v[c + 2] - v[a + 2];
      const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx, l = Math.hypot(nx, ny, nz);
      if (l < 1e-12 || !faces(f, cx, cy, cz, [nx / l, ny / l, nz / l], minCosOf(wp))) continue;
      const [qx, qy] = toPattern(f, cx, cy, cz);
      if (idx.contains(qx, qy)) tris.push(t);
    }
    if (tris.length) out.set(o.id, tris);
  }
  return out;
}

/** Ink colour of a region (rgb 0..1), for the Motionex preview of regions with motion. */
export function regionColor(px: PatternexState, regionId: string): [number, number, number] | null {
  const sep = regionId.lastIndexOf(':');
  const a = px.actions.find((x) => x.region_ref.placement_id === regionId.slice(0, sep) && x.region_ref.color_group === regionId.slice(sep + 1));
  const f = a && useStore.getState().filaments[a.material.slot_index];
  return f ? rgb(f.color) : null;
}

/** Patternex regions that can take a motion: id and a readable name. */
export function regionList(px: PatternexState): { id: string; name: string; color: string }[] {
  const out: { id: string; name: string; color: string }[] = [];
  const objs = useStore.getState().objects;
  for (const p of px.placements) {
    const pat = px.patterns.find((x) => x.id === p.pattern_id);
    if (!pat) continue;
    const obj = objs.find((o) => o.id === p.object_id);
    for (const c of new Set(pat.shapes.map((s) => s.fill_color))) out.push({ id: `${p.id}:${c}`, name: `${pat.name} · ${groupName(c)}${obj ? ` · ${obj.name}` : ''}`, color: c });
  }
  return out;
}
const groupName = (c: string) => ({ '#ffffff': 'Base', '#2f2f33': 'Ink A', '#7d7d85': 'Ink B', '#b9b9c0': 'Ink C' } as Record<string, string>)[c] ?? c;
