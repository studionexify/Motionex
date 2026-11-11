// Motion planner run inside the slicer (#6): the firmware's trapezoidal look-ahead with junction
// deviation. Junction speed v_j² = a·δ·sin(θ/2)/(1 − sin(θ/2)) (θ the angle between the moves, π for
// straight), δ = scv²(√2 − 1)/a from the square-corner velocity; a backward pass caps every entry speed
// so the head can still stop, a forward pass caps it by what acceleration can reach.
import type { LayerOps } from './classic/gcode';

export interface Planned { op: number; len: number; vIn: number; vOut: number; vMax: number; a: number; t: number; tAccel: number; tDecel: number }

/** Plan the moves of one layer. Retractions, raws and travels without length end a junction chain (stop). */
export function planLayer(L: LayerOps, accel0: number, scv = 5): Planned[] {
  const out: Planned[] = [];
  let a = accel0, px = NaN, py = NaN, pz = NaN, dx0 = 0, dy0 = 0, dz0 = 0;
  for (let i = 0; i < L.ops.length; i++) {
    const op = L.ops[i];
    if (op.k === 'accel') { a = op.a; continue; }
    if (op.k !== 'move') { if (op.k === 'retract' || (op.k === 'raw' && (op.resetPos || op.time))) { dx0 = dy0 = dz0 = 0; } continue; }
    const len = Number.isNaN(px) ? 0 : Math.hypot(op.x - px, op.y - py, op.z - pz);
    const dx = len ? (op.x - px) / len : 0, dy = len ? (op.y - py) / len : 0, dz = len ? (op.z - pz) / len : 0;
    px = op.x; py = op.y; pz = op.z;
    if (len < 1e-6) continue;
    let vj = 0;
    if (out.length && (dx0 || dy0 || dz0)) {
      const cos = -(dx * dx0 + dy * dy0 + dz * dz0); // cos of the angle between the paths (−1 straight)
      const s = Math.sqrt(Math.max(0, (1 - cos) / 2)); // sin(θ/2)
      const delta = (scv * scv * (Math.SQRT2 - 1)) / a;
      vj = s > 0.9999 ? Infinity : Math.sqrt((a * delta * s) / (1 - s));
    }
    const prev = out[out.length - 1];
    if (prev) prev.vOut = Math.min(prev.vMax, op.f, vj);
    out.push({ op: i, len, vIn: prev ? prev.vOut : 0, vOut: 0, vMax: op.f, a, t: 0, tAccel: 0, tDecel: 0 });
    dx0 = dx; dy0 = dy; dz0 = dz;
  }
  // backward: reachable exit speeds
  for (let k = out.length - 1; k >= 0; k--) {
    const p = out[k];
    p.vOut = Math.min(p.vOut, k + 1 < out.length ? out[k + 1].vIn : 0);
    p.vIn = Math.min(p.vIn, Math.sqrt(p.vOut * p.vOut + 2 * p.a * p.len), p.vMax);
    if (k > 0) out[k - 1].vOut = Math.min(out[k - 1].vOut, p.vIn);
  }
  // forward: accelerations from the entry
  for (let k = 0; k < out.length; k++) {
    const p = out[k];
    if (k > 0) p.vIn = Math.min(p.vIn, out[k - 1].vOut);
    p.vOut = Math.min(p.vOut, Math.sqrt(p.vIn * p.vIn + 2 * p.a * p.len));
    // trapezoid (or triangle) timing
    const vc = Math.min(p.vMax, Math.sqrt((2 * p.a * p.len + p.vIn * p.vIn + p.vOut * p.vOut) / 2));
    const da = (vc * vc - p.vIn * p.vIn) / (2 * p.a), dd = (vc * vc - p.vOut * p.vOut) / (2 * p.a);
    p.tAccel = (vc - p.vIn) / p.a; p.tDecel = (vc - p.vOut) / p.a;
    p.t = p.tAccel + p.tDecel + Math.max(0, p.len - da - dd) / Math.max(vc, 1e-9);
    p.vMax = vc;
  }
  return out;
}
