// #8 Sub-voxel anti-aliasing, #26 normal-aligned perimeter feathering and #25 3D conformal ironing:
// the passes that make printed surfaces follow the true CAD surface between layer steps.
import type { LayerOps, Op } from '../classic/gcode';
import { snapToSurface } from '../surface';
import { beadArea, flowPatch, moveLike, rescaleE, type Move } from '../runs';
import type { TechModule } from '../session';
import { PlasticMap, headFloor } from '../clearance';
import { isolines, maskDistance, smoothLoop, loopLength, type RasterRegion } from '../offsets';
import type { PartAnalysis } from '../analysis';

const smooth = (t: number) => { const x = Math.max(0, Math.min(1, t)); return x * x * (3 - 2 * x); };

export const subvoxelAA: TechModule = {
  id: 'subvoxel_aa',
  post(s, layers) {
    const r = s.report('subvoxel_aa');
    // the outer bead is lowered onto the true surface (its neighbours stay on the layer): the flat of
    // the nozzle tip spans the neighbour, so raising inner beads would plough the next one over
    const moved = snapToSurface(layers, s.parts, {
      features: new Set(['outer_wall', 'overhang_wall']),
      maxSlope: Math.min(s.pnum('subvoxel_aa', 'maxSlope'), s.caps.maxSlopeDeg), minH: s.pnum('subvoxel_aa', 'minH'), reach: 0.5, rampDeg: s.caps.maxSlopeDeg, lowerOnly: true,
    });
    if (!moved) { r.status = 'idle'; r.reason = 'No walls under shallow slopes.'; return; }
    s.nonPlanar = true;
    r.stats = { contoured_points: moved };
  },
};

/** Outward unit normal of the nearest part surface at a point, from its SDF gradient. */
function normalAt(parts: PartAnalysis[], x: number, y: number, z: number): [number, number, number] | null {
  for (const p of parts) {
    if (x < p.sdf.min[0] - 1 || y < p.sdf.min[1] - 1 || x > p.sdf.max[0] + 1 || y > p.sdf.max[1] + 1) continue;
    const g = p.sdf.sdf.gradient(x, y, z);
    const l = Math.hypot(g[0], g[1], g[2]);
    if (l < 0.3) continue;
    return [g[0] / l, g[1] / l, g[2] / l];
  }
  return null;
}

export const perimeterFeathering: TechModule = {
  id: 'perimeter_feathering',
  post(s, layers) {
    const r = s.report('perimeter_feathering');
    const depth = s.pnum('perimeter_feathering', 'depth');
    let moved = 0;
    layers.forEach((L, li) => {
      if (li < 2 || s.helicalLayers.has(li)) return;
      const out: Op[] = [];
      let px = NaN, py = NaN, pz = NaN, qx = NaN, qy = NaN;
      for (const op of L.ops) {
        if (op.k === 'raw' && op.resetPos) { px = NaN; py = NaN; }
        if (op.k !== 'move' || op.travel || op.e <= 0 || op.feature !== 'outer_wall' || Number.isNaN(px)) {
          if (op.k === 'move') { px = op.x; py = op.y; pz = op.z; qx = op.x; qy = op.y; }
          out.push(op); continue;
        }
        const len = Math.hypot(op.x - px, op.y - py);
        const dens = op.e / Math.max(Math.hypot(len, op.z - (Number.isNaN(pz) ? op.z : pz)), 1e-9); // E per mm of the incoming bead's true 3-D length
        const n = Math.max(1, Math.ceil(len / 0.6));
        for (let k = 1; k <= n; k++) {
          const t = k / n, x = px + (op.x - px) * t, y = py + (op.y - py) * t;
          const nn = normalAt(s.parts, x, y, op.z - op.h / 2);
          let z = op.z, ox = 0, oy = 0, hNew = op.h;
          // rounded sides leaning in (up-facing, 30°–80° from horizontal): shingle the bead down and out
          const prior = op.dev ?? 0;
          if (nn && nn[2] > 0.17 && nn[2] < 0.87) {
            const fade = smooth((nn[2] - 0.17) / 0.12) * smooth((0.87 - nn[2]) / 0.12);
            // whatever earlier passes already lowered this bead counts against the half-layer budget
            const dz = Math.max(0, Math.min(depth * op.h * fade, 0.5 * op.h + prior));
            const hl = Math.hypot(nn[0], nn[1]) || 1;
            const cot = hl / nn[2]; // horizontal shift per mm of drop along the true surface
            const shift = Math.min(dz * cot, op.w * 0.5);
            ox = (nn[0] / hl) * shift; oy = (nn[1] / hl) * shift;
            z = op.z - dz; hNew = op.h + dz; // the shingled bead is thicker by the drop
            if (dz > 1e-4) moved++;
          }
          // volume conserved on the sloped bead: E follows the true 3-D length and the declared (thicker) height
          const seg3 = Math.hypot(x + ox - qx, y + oy - qy, z - (Number.isNaN(pz) ? op.z : pz)); // from where the previous piece really ended (shingling shifts x, y)
          out.push(moveLike(op, x + ox, y + oy, z, rescaleE(dens * seg3, op.w, op.h, hNew), { dev: prior + (z - op.z), h: hNew }));
          pz = z; qx = x + ox; qy = y + oy;
        }
        px = op.x; py = op.y; pz = op.z;
      }
      L.ops = out;
    });
    if (!moved) { r.status = 'idle'; r.reason = 'No rounded sides between 30° and 80°.'; return; }
    s.nonPlanar = true;
    r.stats = { feathered_points: moved, max_drop_mm: +(depth * (s.num('layer_height') || 0.2)).toFixed(3) };
  },
};

/** Up-facing surface cells (slope in range) seen from above, with their heights. */
function burnishRegion(a: PartAnalysis, cell: number, maxSlope: number): { r: RasterRegion; z: Float32Array } | null {
  const b = a.sdf;
  const nx = Math.ceil((b.max[0] - b.min[0]) / cell) + 5, ny = Math.ceil((b.max[1] - b.min[1]) / cell) + 5;
  const ox = b.min[0] - 2 * cell, oy = b.min[1] - 2 * cell;
  const mask = new Uint8Array(nx * ny), z = new Float32Array(nx * ny);
  let n = 0;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const x = ox + i * cell, y = oy + j * cell;
    const hit = a.surf.grid.cast(x, y, b.max[2] + 1, 0, 0, -1);
    if (!hit) continue;
    const nz = a.surf.normal[hit.tri * 3 + 2];
    const slope = (Math.acos(Math.min(1, nz)) * 180) / Math.PI;
    if (nz <= 0 || slope < 1 || slope > maxSlope) continue;
    mask[i + nx * j] = 1; z[i + nx * j] = b.max[2] + 1 - hit.t; n++;
  }
  return n > 20 ? { r: { nx, ny, ox, oy, h: cell, mask }, z } : null;
}

export const conformalIroning: TechModule = {
  id: 'conformal_ironing',
  post(s, layers) {
    const r = s.report('conformal_ironing');
    if (!layers.length) return;
    const spacing = s.pnum('conformal_ironing', 'spacing'), flow = s.pnum('conformal_ironing', 'flow'), speed = s.pnum('conformal_ironing', 'speed');
    const h = s.num('layer_height') || 0.2, w = s.num('line_width') || s.caps.nozzle;
    const fd = s.filaments[0]?.diameter ?? 1.75;
    const ePerMm = ((beadArea(w, h) * flow) / (Math.PI * (fd / 2) ** 2)) * (s.filaments[0]?.flowRatio || 1);
    // everything printed, for the head check of the final pass
    const done = new PlasticMap(s.caps.bed.x + 2, s.caps.bed.y + 2), none = new PlasticMap(4, 4);
    let top = 0;
    for (const L of layers) for (const op of L.ops) if (op.k === 'move' && !op.travel && op.e > 0) { done.stamp(op.x, op.y, op.z); top = Math.max(top, op.z); }
    const safe = top + 2;
    const last = layers[layers.length - 1];
    const ops: Op[] = [];
    const tmpl: Move = { k: 'move', x: 0, y: 0, z: safe, e: 0, f: speed, feature: 'ironing', w: spacing, h: 0.02, travel: false };
    const travel = (x: number, y: number, z: number, f = s.num('travel_speed') || 200): Move => ({ k: 'move', x, y, z: +z.toFixed(4), e: 0, f, feature: 'travel', w: 0, h: last.h, travel: true });
    const retract = s.num('retraction_length') || 0.8, rs = s.num('retraction_speed') || 30;
    let points = 0, dropped = 0, passes = 0;
    for (const a of s.parts) {
      const reg = burnishRegion(a, Math.max(0.2, spacing), s.caps.maxSlopeDeg);
      if (!reg) continue;
      // concentric isolines of the region, spaced like ironing lines, each a closed pass
      const d = maskDistance(reg.r);
      const loops: number[][] = [];
      for (let lev = spacing / 2; lev < 400; lev += spacing) {
        const ls = isolines(reg.r, d, lev).map((l) => smoothLoop(l, Math.max(0.3, spacing * 2), 1)).filter((l) => loopLength(l) > 2);
        if (!ls.length) break;
        loops.push(...ls);
      }
      const zAt = (x: number, y: number) => {
        const i = Math.round((x - reg.r.ox) / reg.r.h), j = Math.round((y - reg.r.oy) / reg.r.h);
        const q = i + reg.r.nx * j;
        return i >= 0 && j >= 0 && i < reg.r.nx && j < reg.r.ny && reg.r.mask[q] ? reg.z[q] : NaN;
      };
      for (const loop of loops) {
        let drawing = false, lx = 0, ly = 0, lz = 0;
        const lift = () => { ops.push({ k: 'retract', len: retract, speed: rs }, travel(lx, ly, safe)); drawing = false; };
        const n = loop.length / 2;
        for (let k = 0; k <= n; k++) {
          const x = loop[(k % n) * 2], y = loop[(k % n) * 2 + 1];
          const z = zAt(x, y);
          // the nozzle may plough the stair-step peaks (≤ ½ layer) but the head must clear everything else
          const ok = Number.isFinite(z) && headFloor(done, none, x, y, z, s.caps.toolhead) <= z + h * 0.6;
          if (!ok) { if (Number.isFinite(z)) dropped++; if (drawing) lift(); continue; }
          if (!drawing) {
            ops.push(travel(x, y, safe), travel(x, y, z + 0.4), travel(x, y, z, 10), { k: 'retract', len: -retract, speed: rs });
            drawing = true; passes++;
          } else {
            ops.push(moveLike(tmpl, x, y, z, Math.hypot(x - lx, y - ly, z - lz) * ePerMm, { f: speed, ...flowPatch({ w: w, h: tmpl.h }, flow * beadArea(w, h) / Math.max(beadArea(w, tmpl.h), 1e-12)) }));
            points++;
          }
          lx = x; ly = y; lz = z;
        }
        if (drawing) lift();
      }
    }
    if (!points) { r.status = 'idle'; r.reason = `No up-facing slopes within ${s.caps.maxSlopeDeg.toFixed(0)}° to burnish.`; return; }
    last.ops.push({ k: 'raw', text: '; NexSpiro conformal ironing' }, ...ops);
    s.nonPlanar = true;
    r.stats = { passes, points, skipped_for_clearance: dropped, spacing_mm: spacing };
  },
};

export type { LayerOps };
