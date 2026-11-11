// Snapping extrusions onto the true CAD surface inside their own layer band: the shared core of
// conformal skins (#4) and sub-voxel anti-aliasing (#8). A bead whose layer cuts a sloped surface is
// moved to the surface height there (never more than half a layer), with flow for its new height.
import type { LayerOps, Op } from './classic/gcode';
import type { FeatureType } from '../types';
import type { PartAnalysis } from './analysis';
import { rescaleE } from './runs';

type Move = Extract<Op, { k: 'move' }>;

/** Height of the part surface just above (x, y, zFrom) within `reach`, or NaN. */
export function surfaceAbove(parts: PartAnalysis[], x: number, y: number, zFrom: number, reach: number): { z: number; slope: number } | null {
  for (const p of parts) {
    const b = p.sdf;
    if (x < b.min[0] - 0.5 || y < b.min[1] - 0.5 || x > b.max[0] + 0.5 || y > b.max[1] + 0.5) continue;
    const hit = p.surf.grid.cast(x, y, zFrom, 0, 0, 1, 1e-6, reach);
    if (!hit) continue;
    const nz = p.surf.normal[hit.tri * 3 + 2];
    if (nz <= 0) continue; // the underside of something above, not a top surface
    return { z: zFrom + hit.t, slope: (Math.acos(Math.min(1, nz)) * 180) / Math.PI };
  }
  return null;
}

export interface SnapOptions {
  features: Set<FeatureType>;
  /** Only where the surface is flatter than this (deg). */
  maxSlope: number;
  /** Thinnest bead allowed (mm). */
  minH: number;
  /** Largest deviation from the layer, as a share of the layer height (≤ 0.5). */
  reach?: number;
  /** Split moves so the bead follows the surface at this spacing (mm). */
  step?: number;
  /** Steepest climb or dive the nozzle may make between pieces (deg): the machine's head-clearance slope. */
  rampDeg?: number;
  /** Only ever lower beads (anti-aliasing the outer edge), never raise them. */
  lowerOnly?: boolean;
}

/** Returns the number of moved points. */
export function snapToSurface(layers: LayerOps[], parts: PartAnalysis[], o: SnapOptions): number {
  let moved = 0;
  const reach = Math.min(0.5, o.reach ?? 0.5), step = o.step ?? 0.6;
  for (const L of layers) {
    const out: Op[] = [];
    let px = NaN, py = NaN, pz = NaN;
    for (const op of L.ops) {
      if (op.k === 'raw' && op.resetPos) { px = NaN; py = NaN; }
      if (op.k !== 'move' || op.travel || op.e <= 0 || !o.features.has(op.feature) || Number.isNaN(px)) {
        if (op.k === 'move') { px = op.x; py = op.y; pz = op.z; }
        out.push(op);
        continue;
      }
      const len = Math.hypot(op.x - px, op.y - py);
      const n = Math.max(1, Math.ceil(len / step));
      const z0 = pz;
      // E per mm of true 3-D path, then each piece takes its own 3-D length and its own bead height
      const dens = op.e / Math.max(Math.hypot(len, op.z - z0), 1e-9);
      let qz = z0;
      for (let s = 1; s <= n; s++) {
        const t = s / n;
        const x = px + (op.x - px) * t, y = py + (op.y - py) * t;
        const zl = z0 + (op.z - z0) * t;
        const h = op.h;
        const hit = surfaceAbove(parts, x, y, zl - h * (0.5 + reach), h * (2 * reach + 0.5));
        let z = zl, nhDecl = h;
        // only where this layer's band contains the surface: elsewhere the bead is interior or below it
        const prior = op.dev ?? 0;
        let dev = prior;
        if (hit && hit.slope > 0.5 && hit.slope <= o.maxSlope && Math.abs(hit.z - zl) <= reach * h && !(o.lowerOnly && hit.z >= zl)) {
          // one budget for every pass: a bead never ends up more than half a layer off its surface
          const dz = Math.max(-0.5 * h - prior, Math.min(0.5 * h - prior, hit.z - zl));
          const nh = Math.max(o.minH, h + dz);
          z = zl - h + nh;
          nhDecl = nh;
          dev = prior + (z - zl);
          if (Math.abs(z - zl) > 1e-4) moved++;
        }
        if (o.rampDeg !== undefined && !Number.isNaN(qz)) {
          // never climb or dive faster than the head allows: a bead entering the surface eases in over several pieces
          const lim = Math.tan((Math.min(o.rampDeg, 80) * Math.PI) / 180) * 0.95 * Math.hypot(len / n, 0);
          const zc = Math.max(qz - lim, Math.min(qz + lim, z));
          if (zc !== z) { nhDecl = Math.max(o.minH, nhDecl + (zc - z)); z = zc; }
        }
        const zr = +z.toFixed(4);
        const e = rescaleE(dens * Math.hypot(len / n, zr - qz), op.w, h, nhDecl);
        qz = zr;
        const m: Move = { ...op, x, y, z: zr, e, h: nhDecl, noArc: true, dev };
        out.push(m);
      }
      px = op.x; py = op.y; pz = op.z;
    }
    L.ops = out;
  }
  return moved;
}
