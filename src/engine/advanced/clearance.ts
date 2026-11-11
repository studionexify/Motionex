// Clearance-cone collision checker for non-planar moves (Task 2.3). Walks the final move list in print
// order, keeps height maps of printed plastic (finished layers, and the current layer with a lag), and
// tests every move that leaves its layer's plane against the nozzle cone and the head's volumes
// (heater block, fan duct, carriage). Offending points are lifted (up to half a layer) or reported.
import type { LayerOps, Op } from './classic/gcode';
import type { Move } from './runs';
import type { ToolheadProfile } from '../../plugins/motionex/core/toolhead';
import { rescaleE } from './runs';

/** worst: deepest collision found; worstLeft: deepest one left unresolved. */
export interface ClearanceReport { checked: number; collisions: number; raised: number; unresolved: number; worst: number; worstLeft: number }

/** Highest printed plastic per 0.25 mm cell, with a 4 mm max level for fast rejection. */
export class PlasticMap {
  readonly c = 0.25;
  private readonly K = 16;
  readonly nx: number; readonly ny: number;
  private readonly cnx: number; private readonly cny: number;
  readonly h: Float32Array; private readonly coarse: Float32Array;
  /** Exact position of the point that set each cell's height (no cell-size margin in distances). */
  readonly px: Float32Array; readonly py: Float32Array;
  private touched: number[] = [];
  constructor(w: number, d: number) {
    this.nx = Math.ceil(w / this.c) + 2; this.ny = Math.ceil(d / this.c) + 2;
    this.cnx = Math.ceil(this.nx / this.K); this.cny = Math.ceil(this.ny / this.K);
    this.h = new Float32Array(this.nx * this.ny); this.coarse = new Float32Array(this.cnx * this.cny);
    this.px = new Float32Array(this.nx * this.ny); this.py = new Float32Array(this.nx * this.ny);
  }
  /** Empty the map again (only the cells that were written). */
  reset() {
    for (const k of this.touched) { this.h[k] = 0; const i = k % this.nx, j = (k - i) / this.nx; this.coarse[Math.floor(i / this.K) + this.cnx * Math.floor(j / this.K)] = 0; }
    this.touched = [];
  }
  stamp(x: number, y: number, z: number) {
    const i = Math.round(x / this.c), j = Math.round(y / this.c);
    if (i < 0 || j < 0 || i >= this.nx || j >= this.ny) return;
    const k = i + this.nx * j;
    if (z > this.h[k]) {
      if (!this.h[k]) this.touched.push(k);
      this.h[k] = z; this.px[k] = x; this.py[k] = y;
      const q = Math.floor(i / this.K) + this.cnx * Math.floor(j / this.K);
      if (z > this.coarse[q]) this.coarse[q] = z;
    }
  }
  private range(a: number, b: number, n: number): [number, number] { return [Math.max(0, Math.floor(a / this.c)), Math.min(n - 1, Math.ceil(b / this.c))]; }
  /** Highest plastic in a rectangle, or −∞ when nothing there exceeds `above` (fast reject). */
  maxAbove(x0: number, y0: number, x1: number, y1: number, above: number): number {
    const [i0, i1] = this.range(x0, x1, this.nx), [j0, j1] = this.range(y0, y1, this.ny);
    let best = -Infinity;
    for (let cj = Math.floor(j0 / this.K); cj <= Math.floor(j1 / this.K); cj++) for (let ci = Math.floor(i0 / this.K); ci <= Math.floor(i1 / this.K); ci++) {
      if (this.coarse[ci + this.cnx * cj] <= above) continue;
      const a0 = Math.max(i0, ci * this.K), a1 = Math.min(i1, ci * this.K + this.K - 1), b0 = Math.max(j0, cj * this.K), b1 = Math.min(j1, cj * this.K + this.K - 1);
      for (let j = b0; j <= b1; j++) for (let i = a0; i <= a1; i++) { const v = this.h[i + this.nx * j]; if (v > best) best = v; }
    }
    return best > above ? best : -Infinity;
  }
  /**
   * Lowest tip height keeping the nozzle cone clear of plastic outside the tip's own flat (−∞: free).
   * Plastic under the flat is the surface being printed on (a tilted layer's neighbours sit up to
   * r·tanθ into it by definition of the slope limit); the cone above it must not touch anything.
   */
  coneFloor(x: number, y: number, rTip: number, tipLen: number, tanA: number, above: number): number {
    const R = rTip + tipLen * tanA;
    if (this.maxAbove(x - R, y - R, x + R, y + R, above) === -Infinity) return -Infinity;
    const [i0, i1] = this.range(x - R, x + R, this.nx), [j0, j1] = this.range(y - R, y + R, this.ny);
    let floor = -Infinity;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const k = i + this.nx * j, hh = this.h[k];
      if (hh <= above) continue;
      const d = Math.hypot(this.px[k] - x, this.py[k] - y);
      if (d > R || d <= rTip) continue;
      floor = Math.max(floor, hh - (d - rTip) / tanA);
    }
    return floor;
  }
}

/**
 * Lowest safe nozzle-tip height at (x, y), or −∞ when nothing constrains it below `z`. `done` holds
 * finished layers, `cur` the current layer so far. The tip's flat may not sink into a finished layer;
 * within the current layer, neighbouring beads of a tilted layer sit a little higher by design, so
 * only the cone and head volumes see them.
 */
export function headFloor(done: PlasticMap, cur: PlasticMap, x: number, y: number, z: number, head: ToolheadProfile, why?: { by: string }): number {
  const tanA = Math.tan((head.nozzle.cone_angle_deg * Math.PI) / 180), rTip = head.nozzle.tip_diameter / 2;
  const cd = done.coneFloor(x, y, rTip, head.nozzle.tip_len, tanA, z), cc = cur.coneFloor(x, y, rTip, head.nozzle.tip_len, tanA, z);
  let floor = Math.max(cd, cc);
  if (why) why.by = cd >= cc ? 'cone/done' : 'cone/current';
  const r = rTip * 0.7, under = done.maxAbove(x - r, y - r, x + r, y + r, z - 0.03);
  if (under !== -Infinity && under + 0.03 > floor) { floor = under + 0.03; if (why) why.by = 'tip/done'; }
  for (const v of head.volumes) {
    const cx = x + v.offset[0], cy = y + v.offset[1];
    const hx = v.shape === 'box' ? v.dims[0] / 2 : v.dims[0], hy = v.shape === 'box' ? v.dims[1] / 2 : v.dims[0];
    const lim = z + v.offset[2] - head.margin;
    const top = Math.max(done.maxAbove(cx - hx, cy - hy, cx + hx, cy + hy, lim), cur.maxAbove(cx - hx, cy - hy, cx + hx, cy + hy, lim));
    if (top !== -Infinity && top - v.offset[2] + head.margin > floor) { floor = top - v.offset[2] + head.margin; if (why) why.by = v.name; }
  }
  return floor;
}

/**
 * Check (and with `fix`, repair) every non-planar move: one whose Z differs from its layer's top by
 * more than 1 µm. Plastic of the current layer counts once the nozzle is `lag` mm past it.
 */
export function clearancePass(layers: LayerOps[], head: ToolheadProfile, bed: { x: number; y: number }, fix = true, lag = 3, onCollision?: (c: { layer: number; x: number; y: number; z: number; floor: number; feature: string }) => void): ClearanceReport {
  const done = new PlasticMap(bed.x + 2, bed.y + 2);
  const rep: ClearanceReport = { checked: 0, collisions: 0, raised: 0, unresolved: 0, worst: 0, worstLeft: 0 };
  const cur = new PlasticMap(bed.x + 2, bed.y + 2);
  for (const L of layers) {
    cur.reset();
    const printed: number[] = [];
    const pending: { x: number; y: number; z: number; s: number }[] = [];
    let s = 0, px = NaN, py = NaN, head0 = 0;
    for (const op of L.ops) {
      if (op.k === 'raw' && op.resetPos) { px = NaN; py = NaN; }
      if (op.k !== 'move') continue;
      if (!Number.isNaN(px)) s += Math.hypot(op.x - px, op.y - py);
      px = op.x; py = op.y;
      while (head0 < pending.length && pending[head0].s < s - lag) { const q = pending[head0++]; cur.stamp(q.x, q.y, q.z); }
      if (op.travel || op.e <= 0) continue;
      // conformal ironing ploughs the stair-step peaks on purpose and checks the head itself
      if (op.feature === 'ironing' || op.noClear) continue;
      if (Math.abs(op.z - L.z) > 1e-3) {
        rep.checked++;
        const why = onCollision ? { by: '' } : undefined;
        const floor = headFloor(done, cur, op.x, op.y, op.z, head, why);
        if (op.z < floor - 1e-4) {
          rep.collisions++;
          onCollision?.({ layer: layers.indexOf(L), x: op.x, y: op.y, z: op.z, floor, feature: op.feature + ' by ' + why!.by });
          rep.worst = Math.max(rep.worst, floor - op.z);
          // lift by at most half a layer (a thicker bead, flow to match), a whole layer inside the
          // infill where a thicker bead is never seen; anything worse is reported
          // a bead that surface passes lowered may always go back up by what they took off
          const maxLift = Math.max(op.h * (op.feature === 'sparse_infill' || op.feature === 'internal_solid_infill' ? 1 : 0.5), -(op.dev ?? 0) + op.h * 0.25);
          if (fix && floor - op.z <= maxLift + 1e-4) {
            const lift = floor - op.z;
            // the bead keeps its bottom and gains the lift in thickness: declared height and E follow the same cross-section
            if (op.feature !== 'bridge') { // a bridge is a round strand in mid-air: raised, it keeps its section
              op.e = rescaleE(op.e, op.w, op.h, op.h + lift);
              op.h = +(op.h + lift).toFixed(5);
            }
            op.z = +(op.z + lift).toFixed(4);
            rep.raised++;
          } else { rep.unresolved++; rep.worstLeft = Math.max(rep.worstLeft, floor - op.z); }
        }
      }
      pending.push({ x: op.x, y: op.y, z: op.z, s });
      printed.push(op.x, op.y, op.z);
    }
    for (let i = 0; i < printed.length; i += 3) done.stamp(printed[i], printed[i + 1], printed[i + 2]);
  }
  return rep;
}

/**
 * After the head-clearance lifts, a bead can sit steeper than the machine's slope limit against its neighbour
 * (a lifted bead between unlifted ones). Raise the lower neighbours - raising only adds clearance - until every
 * extruding step within a continuous run is at most `maxSlopeDeg`. A bead is never raised by more than the
 * clearance pass could lift it (half a layer; a whole layer in infill). Raised beads keep their bottom and gain
 * the lift in thickness, and E follows the new cross-section. Returns steps still too steep.
 */
export function limitRamp(layers: LayerOps[], maxSlopeDeg: number): { raised: number; left: number } {
  const tan = Math.tan((Math.min(maxSlopeDeg, 80) * Math.PI) / 180) * 0.98;
  let raised = 0, left = 0;
  for (const L of layers) {
    const ops = L.ops;
    let i = 0;
    while (i < ops.length) {
      const first = ops[i];
      const skip = (o: Op) => o.k !== 'move' || o.travel || o.e <= 0 || !!o.noClear || !!o.fixed || o.feature === 'ironing';
      if (skip(first) || i === 0) { i++; continue; }
      let si = i - 1; // a de-retract or comment between the travel and the first bead does not move the head
      while (si >= 0 && ops[si].k !== 'move' && !(ops[si].k === 'raw' && (ops[si] as { resetPos?: boolean }).resetPos)) si--;
      const start = ops[si];
      if (!start || start.k !== 'move') { i++; continue; }
      // continuous run of extruding moves from i
      const idx: number[] = [];
      let j = i;
      while (j < ops.length) { const o = ops[j]; if (!skip(o)) { idx.push(j); j++; } else break; }
      i = j;
      const n = idx.length;
      const ms = idx.map((k) => ops[k] as Move);
      const px = [start.x, ...ms.map((m) => m.x)], py = [start.y, ...ms.map((m) => m.y)];
      const z0 = [start.z, ...ms.map((m) => m.z)];
      const z = z0.slice();
      let startUp = 0;
      const dxy = ms.map((_, q) => Math.hypot(px[q + 1] - px[q], py[q + 1] - py[q]));
      const cap = ms.map((m) => m.h * (m.feature === 'sparse_infill' || m.feature === 'internal_solid_infill' ? 1 : 0.5));
      const allow = (q: number) => Math.max(0, tan * dxy[q] - 0.0012); // G-code coordinates are rounded to 1 µm: keep clear of the limit on short steps
      const room = (q: number) => z0[q + 1] + cap[q] - z[q + 1];
      for (let pass = 0; pass < 4; pass++) {
        let changed = false;
        for (let q = 0; q < n; q++) { // forward: bead q+1 follows q
          const need = z[q] - allow(q) - z[q + 1];
          if (need > 1e-5) { const up = Math.min(need, Math.max(0, room(q))); if (up > 0) { z[q + 1] += up; changed = true; } }
        }
        for (let q = n - 1; q >= 0; q--) { // backward: bead q (index q in z, a moved bead unless q == 0) follows q+1
          const need = z[q + 1] - allow(q) - z[q];
          if (need > 1e-5 && q >= 1) { const up = Math.min(need, Math.max(0, room(q - 1))); if (up > 0) { z[q] += up; changed = true; } }
          // the run starts from a travel end: that point may simply go higher, so a climb is eased in from there
          else if (need > 1e-5 && q === 0 && start.travel && dxy[0] > 0.05) { z[0] += need; changed = true; startUp = Math.max(startUp, z[0] - z0[0]); }
        }
        if (!changed) break;
      }
      for (let q = 0; q < n; q++) if (Math.atan2(Math.abs(z[q + 1] - z[q]), dxy[q]) > Math.atan(tan / 0.98) + 1e-6) left++;
      let any = false;
      for (let q = 0; q < n; q++) {
        const m = ms[q], up = z[q + 1] - z0[q + 1];
        if (up < 1e-5) continue;
        any = true;
        if (m.feature !== 'bridge') { // a bridge is a round strand in mid-air: raised, it keeps its section
          m.e = rescaleE(m.e, m.w, m.h, m.h + up); // the length change is settled once by restoreLengths
          m.h = +(m.h + up).toFixed(5);
        }
        m.z = +z[q + 1].toFixed(4);
        raised++;
      }
      void any;
      if (startUp > 1e-6) start.z = +(start.z + startUp).toFixed(4);
    }
  }
  return { raised, left };
}

/** True 3-D length from each extruding move back to the move before it, taken before passes that move beads in Z. */
export function snapshotLengths(layers: LayerOps[]): Map<Op, number> {
  const snap = new Map<Op, number>();
  for (const L of layers) {
    let prev: Op | null = null;
    for (const o of L.ops) {
      if (o.k === 'raw' && o.resetPos) prev = null;
      if (o.k !== 'move') continue;
      if (prev && prev.k === 'move' && !o.travel && o.e > 0) snap.set(o, Math.hypot(o.x - prev.x, o.y - prev.y, o.z - prev.z));
      prev = o;
    }
  }
  return snap;
}

/** After beads were lifted, scale each bead's E by the change of its true 3-D length so volume stays conserved. */
export function restoreLengths(layers: LayerOps[], snap: Map<Op, number>): void {
  for (const L of layers) {
    let prev: Op | null = null;
    for (const o of L.ops) {
      if (o.k === 'raw' && o.resetPos) prev = null;
      if (o.k !== 'move') continue;
      const was = snap.get(o);
      if (was !== undefined && prev && prev.k === 'move') {
        const now = Math.hypot(o.x - prev.x, o.y - prev.y, o.z - prev.z);
        if (was > 1e-9) o.e *= now / was;
      }
      prev = o;
    }
  }
}
