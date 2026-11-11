// #21 Multi-perimeter helical "thick-vase": in steady single-island bands every wall and the infill of
// a layer climb as one helix (dz/dt > 0 throughout). For the beads to stack at a constant height, each
// layer prints its loops in the same canonical order (outer walls by size, inner walls, then infill),
// so every point sits at the same fraction of the helix turn layer after layer. Hops that stay inside
// the part lose their retraction, and the infill is a connected spiral.
import type { Op } from '../classic/gcode';
import { spiralFill } from '../eulerian';
import type { SessionCtx, TechModule } from '../session';
import type { PartAnalysis } from '../analysis';
import { signedArea, type Move } from '../runs';

const inBand = (s: SessionCtx, o: number, z: number) => s.parts[o]?.sections.helical.some(([a, b]) => z >= a + 0.3 && z <= b - 0.3) ?? false;

/** Every object present at this height is inside one of its helical bands. */
function layerIsHelical(s: SessionCtx, z: number): boolean {
  let any = false;
  for (let o = 0; o < s.parts.length; o++) {
    const p = s.parts[o];
    if (z < p.sdf.min[2] || z > p.sdf.max[2]) continue;
    if (!inBand(s, o, z)) return false;
    any = true;
  }
  return any;
}

/** The straight travel between two points stays inside the part (no wall is crossed). */
export function travelInside(parts: PartAnalysis[], x0: number, y0: number, x1: number, y1: number, z: number, margin: number): boolean {
  const n = Math.max(2, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 0.5));
  for (let k = 0; k <= n; k++) {
    const x = x0 + ((x1 - x0) * k) / n, y = y0 + ((y1 - y0) * k) / n;
    let inside = false;
    for (const p of parts) {
      if (x < p.sdf.min[0] || y < p.sdf.min[1] || x > p.sdf.max[0] || y > p.sdf.max[1]) continue;
      if (-p.sdf.sdf.sample(x, y, z) >= margin) { inside = true; break; }
    }
    if (!inside) return false;
  }
  return true;
}

const SKIN = new Set(['top_surface', 'bottom_surface', 'bridge', 'internal_solid_infill', 'ironing', 'support', 'support_interface', 'prime_tower', 'skirt', 'brim']);
const RANK: Record<string, number> = { outer_wall: 0, overhang_wall: 0, inner_wall: 1 };

interface Piece { moves: Move[]; x0: number; y0: number; rank: number; area: number; angle: number; length: number }

export const thickVase: TechModule = {
  id: 'thick_vase',
  infill(s, o, region, c) {
    if (!inBand(s, o, c.z)) return undefined;
    return spiralFill(region, { spacing: c.width / Math.max(0.05, Math.min(1, c.density)), width: c.width, minW: c.width, maxW: c.width });
  },
  post(s, layers) {
    const r = s.report('thick_vase');
    let helical = 0, removed = 0, kept = 0;
    const w = s.num('outer_wall_line_width') || s.num('line_width') || s.caps.nozzle;
    const retract = s.num('retraction_length'), rs = s.num('retraction_speed') || 30, ds = s.num('deretraction_speed') || rs;
    const travelF = s.num('travel_speed') || 200;
    layers.forEach((L, li) => {
      if (li === 0 || !layerIsHelical(s, L.z)) return;
      // only layers made of plain moves, retractions, acceleration changes and one object's label pair
      // (Klipper EXCLUDE_OBJECT / Marlin M486) can be re-ordered
      const raws = L.ops.filter((op): op is Extract<Op, { k: 'raw' }> => op.k === 'raw');
      const isStart = (t: string) => /^EXCLUDE_OBJECT_START|^M486 S\d/.test(t), isEnd = (t: string) => /^EXCLUDE_OBJECT_END|^M486 S-1/.test(t);
      const labels = raws.length === 2 && isStart(raws[0].text) && isEnd(raws[1].text);
      if ((raws.length && !labels) || L.ops.some((op) => op.k === 'tool' || (op.k === 'move' && !op.travel && SKIN.has(op.feature)))) return;
      // 1) cut the layer into extrusion pieces (with the position each starts from)
      const pieces: Piece[] = [];
      let px = NaN, py = NaN, cur: Piece | null = null;
      let accel: Op | null = null;
      for (const op of L.ops) {
        if (op.k === 'accel') { accel = op; continue; }
        if (op.k !== 'move') { cur = null; continue; }
        if (op.travel || op.e <= 0) { cur = null; px = op.x; py = op.y; continue; }
        if (!cur || cur.moves[cur.moves.length - 1].feature !== op.feature) {
          cur = { moves: [], x0: px, y0: py, rank: RANK[op.feature] ?? 2, area: 0, angle: 0, length: 0 };
          pieces.push(cur);
        }
        cur.length += Number.isNaN(px) ? 0 : Math.hypot(op.x - px, op.y - py);
        cur.moves.push(op);
        px = op.x; py = op.y;
      }
      if (!pieces.length || pieces.some((p) => Number.isNaN(p.x0))) return;
      // centre of the layer, for a stable order of open pieces
      let cx = 0, cy = 0, n = 0;
      for (const p of pieces) for (const m of p.moves) { cx += m.x; cy += m.y; n++; }
      cx /= n; cy /= n;
      for (const p of pieces) {
        p.area = Math.abs(signedArea([p.x0, ...p.moves.map((m) => m.x)], [p.y0, ...p.moves.map((m) => m.y)]));
        p.angle = Math.atan2(p.y0 - cy, p.x0 - cx);
      }
      // 2) canonical order: outer walls (largest loop first), inner walls (largest first), infill by angle
      pieces.sort((a, b) => a.rank - b.rank || (a.rank < 2 ? b.area - a.area : a.angle - b.angle));
      // 3) rebuild: hops inside the part travel without retraction
      const ops: Op[] = [];
      if (labels) ops.push(raws[0]);
      if (accel) ops.push(accel);
      let qx = NaN, qy = NaN;
      const first = L.ops.find((op) => op.k === 'move') as Move;
      qx = first.x; qy = first.y;
      // where the nozzle really is when the layer starts: the previous layer's last move
      const prev = layers[li - 1]?.ops;
      for (let i = (prev?.length ?? 0) - 1; i >= 0; i--) { const m = prev![i]; if (m.k === 'move') { qx = m.x; qy = m.y; break; } }
      for (const p of pieces) {
        const d = Math.hypot(p.x0 - qx, p.y0 - qy);
        if (d > 1e-4) {
          const inside = d <= 3 * w || (d <= 20 && travelInside(s.parts, qx, qy, p.x0, p.y0, L.z - L.h / 2, w * 0.3));
          if (!inside && retract > 0) { ops.push({ k: 'retract', len: retract, speed: rs }); kept++; } else removed++;
          ops.push({ k: 'move', x: p.x0, y: p.y0, z: L.z, e: 0, f: travelF, feature: 'travel', w: 0, h: L.h, travel: true });
          if (!inside && retract > 0) ops.push({ k: 'retract', len: -retract, speed: ds });
        }
        ops.push(...p.moves);
        const last = p.moves[p.moves.length - 1];
        qx = last.x; qy = last.y;
      }
      if (labels) ops.push(raws[1]);
      // 4) one helix: each point drops below its layer surface by the part of the turn still to come,
      // so z climbs with the extruded length from the previous layer's top to this one's (relative to
      // the move's own z: curved layers stay curved)
      let total = 0;
      for (const p of pieces) total += p.length;
      if (total <= 0) return;
      let sAcc = 0, lastZ = L.z;
      px = NaN; py = NaN;
      for (const op of ops) {
        if (op.k !== 'move') continue;
        if (!op.travel && op.e > 0 && !Number.isNaN(px)) sAcc += Math.hypot(op.x - px, op.y - py);
        px = op.x; py = op.y;
        const base = op.travel ? lastZ : op.z;
        if (!op.travel) lastZ = op.z;
        op.z = +(base - L.h * (1 - Math.min(sAcc, total) / total)).toFixed(4);
        op.noArc = true;
      }
      L.ops = ops;
      s.helicalLayers.add(li);
      helical++;
    });
    if (!helical) { r.status = 'idle'; r.reason = 'No steady single-island band (no helical zone) on this part.'; return; }
    s.nonPlanar = true;
    r.stats = { helical_layers: helical, retractions_removed: removed, retractions_kept: kept };
  },
};
