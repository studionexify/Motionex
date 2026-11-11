// OrcaSlicer G-code options on the op stream: extrusion rate smoothing segments and the fan speed-up time.
import type { Op } from './gcode';
import type { FeatureType } from './types';

type M = Extract<Op, { k: 'move' }>;
const EXTERNAL = new Set<FeatureType>(['outer_wall', 'overhang_wall', 'bridge']);
/** Moves extrusion rate smoothing applies to (only outer walls and overhangs with "Apply only on external features"). */
export const smoothedMove = (op: Op, externalOnly: boolean): op is M => op.k === 'move' && !op.travel && op.e > 0 && (!externalOnly || EXTERNAL.has(op.feature));

/**
 * Smoothing segment length (OrcaSlicer max_volumetric_extrusion_rate_slope_segment_length): extrusions longer than
 * `segLen` are split into equal pieces no longer than it, so the pressure equalizer can change the speed along them.
 */
export function splitForSmoothing(ops: Op[], segLen: number, externalOnly: boolean): Op[] {
  if (!(segLen > 0)) return ops;
  const out: Op[] = [];
  let x = NaN, y = NaN, z = NaN;
  for (const op of ops) {
    if (op.k === 'move') {
      const L = Math.hypot(op.x - x, op.y - y);
      if (smoothedMove(op, externalOnly) && Number.isFinite(L) && L > segLen * 1.0001) {
        const n = Math.ceil(L / segLen);
        for (let k = 1; k <= n; k++) {
          const t = k / n;
          out.push({ ...op, x: x + (op.x - x) * t, y: y + (op.y - y) * t, z: z + (op.z - z) * t, e: op.e / n, ...(op.t !== undefined ? { t: op.t / n } : {}) });
        }
      } else out.push(op);
      x = op.x; y = op.y; z = op.z;
    } else {
      out.push(op);
      if (op.k === 'lift') { x = op.x; y = op.y; z = op.z; }
      else if (op.k === 'raw' && op.resetPos) { x = NaN; y = NaN; z = NaN; }
    }
  }
  return out;
}

/** Ops for the pressure equalizer: with "external only", other extrusions break the runs and are left alone. */
export function smoothingView(ops: Op[], externalOnly: boolean): Op[] {
  if (!externalOnly) return ops;
  const out: Op[] = [];
  for (const op of ops) {
    if (op.k === 'move' && !op.travel && op.e > 0 && !smoothedMove(op, true)) out.push({ k: 'retract', len: 1, speed: 1 });
    else out.push(op);
  }
  return out;
}

/**
 * Fan speed-up time (OrcaSlicer fan_speedup_time): a fan increase starts this many seconds of printing before the
 * line that asks for it. With "only overhangs", only the overhang / bridge fan (fanMin) is moved forward.
 */
export function fanSpeedup(ops: Op[], seconds: number, overhangsOnly: boolean, layerFan: number): void {
  if (!(seconds > 0)) return;
  const want = (m: M) => (m.fanSet !== undefined ? m.fanSet : Math.max(layerFan, m.fanMin ?? 0));
  const ex: M[] = [], times: number[] = [];
  for (const op of ops) if (op.k === 'move') { if (!op.travel && op.e > 0) { ex.push(op); times.push(0); } else if (ex.length) times[times.length - 1] += op.t ?? 0; }
  // fan rises are taken from the fan speeds as planned, before any of them is moved
  const orig = ex.map(want), origMin = ex.map((m) => m.fanMin ?? 0);
  for (let k = ex.length - 1; k > 0; k--) {
    const target = overhangsOnly ? Math.max(layerFan, origMin[k]) : orig[k];
    if (target <= orig[k - 1] || (overhangsOnly && !(origMin[k] > layerFan))) continue;
    // back over the moves printed before it, until the speed-up time is covered
    let left = seconds;
    for (let j = k - 1; j >= 0 && left > 0; j--) {
      left -= (ex[j].t ?? 0) + times[j];
      if (orig[j] >= target || want(ex[j]) >= target) break;
      if (ex[j].fanSet !== undefined) { if (!overhangsOnly) ex[j].fanSet = target; else break; }
      else ex[j].fanMin = Math.max(ex[j].fanMin ?? 0, target);
    }
  }
}
