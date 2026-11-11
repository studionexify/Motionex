// #6 Kinematics-coupled dynamic extrusion, #31 symplectic phase-space trajectory compilation and #10
// viscoelastic corner-overshoot compensation: the passes that work from the planned motion.
import type { LayerOps, Op } from '../classic/gcode';
import { planLayer } from '../planner';
import { flowPatch, moveLike, type Move } from '../runs';
import type { SessionCtx, TechModule } from '../session';

/**
 * Residual ringing of a mass on a spring (natural frequency f, damping ζ) driven by a commanded
 * acceleration pulse a for time T then coasting: H = p²/2m + k(q − q_cmd)²/2 integrated with
 * Störmer–Verlet (symplectic: no artificial energy drift). Returns the peak amplitude after the pulse (mm).
 */
export function ringing(a: number, T: number, f: number, zeta = 0.05, dt = 2e-5): number {
  const w = 2 * Math.PI * f;
  let q = 0, p = 0; // follower deviation from the command, its velocity
  const steps = Math.ceil((T + 6 / f) / dt);
  let peak = 0;
  for (let k = 0; k < steps; k++) {
    const t = k * dt;
    const acmd = t < T ? a : 0;
    // q'' = −ω²q − 2ζωq' − a_cmd (the command accelerates, the frame lags)
    const force = (qq: number, pp: number) => -w * w * qq - 2 * zeta * w * pp - acmd;
    p += 0.5 * dt * force(q, p);
    q += dt * p;
    p += 0.5 * dt * force(q, p);
    if (t > T) peak = Math.max(peak, Math.abs(q));
  }
  return peak;
}

/** Acceleration (≤ a) whose ramp to v lasts a whole number of resonance periods (zero residual vibration). */
export function periodAccel(v: number, a: number, f: number): { a: number; n: number } {
  const T = 1 / f, ta = v / a;
  const n = Math.max(1, Math.ceil(ta / T - 1e-9));
  return { a: v / (n * T), n };
}

const FEATURE_SPEED: Record<string, string> = { outer_wall: 'outer_wall_speed', inner_wall: 'inner_wall_speed', sparse_infill: 'sparse_infill_speed', internal_solid_infill: 'internal_solid_infill_speed', top_surface: 'top_surface_speed' };

export const symplecticShaper: TechModule = {
  id: 'symplectic_shaper',
  finalize(s: SessionCtx, layers) {
    const r = s.report('symplectic_shaper');
    const f = Math.min(s.caps.resonance.x, s.caps.resonance.y), zeta = s.caps.resonance.zeta || 0.05;
    const tol = s.pnum('symplectic_shaper', 'tolerance');
    let changed = 0, before = 0, after = 0;
    const cache = new Map<string, number>();
    for (const L of layers) {
      let feature = '';
      for (let i = 0; i < L.ops.length; i++) {
        const op = L.ops[i];
        if (op.k === 'move' && !op.travel) feature = op.feature;
        if (op.k !== 'accel') continue;
        // the next printing move's feature decides the cruise speed this acceleration ramps to
        for (let j = i + 1; j < L.ops.length; j++) { const m = L.ops[j]; if (m.k === 'move' && !m.travel) { feature = m.feature; break; } }
        const v = s.num(FEATURE_SPEED[feature] ?? 'inner_wall_speed') || 100;
        const key = `${op.a}:${v}`;
        let a2 = cache.get(key);
        if (a2 === undefined) {
          const r0 = ringing(op.a, v / op.a, f, zeta);
          const pa = periodAccel(v, op.a, f);
          const r1 = ringing(pa.a, v / pa.a, f, zeta);
          before = Math.max(before, r0); after = Math.max(after, r1);
          // shaped firmware already cancels most ringing: retime only when it still matters
          a2 = r0 > tol * (s.caps.inputShaper ? 4 : 1) && r1 < r0 ? Math.round(pa.a) : op.a;
          cache.set(key, a2);
        }
        if (a2 !== op.a) { L.ops[i] = { k: 'accel', a: a2 }; changed++; }
      }
    }
    if (!before) { r.status = 'idle'; r.reason = 'No acceleration changes to retime.'; return; }
    r.stats = { resonance_Hz: f, accel_changes_retimed: changed, ringing_before_mm: +before.toFixed(4), ringing_after_mm: +after.toFixed(4), firmware_shaper: s.caps.inputShaper ? 'on (no double shaping)' : 'off' };
  },
};

export const kinematicExtrusion: TechModule = {
  id: 'kinematic_extrusion',
  finalize(s, layers: LayerOps[]) {
    const r = s.report('kinematic_extrusion');
    const K = s.pnum('kinematic_extrusion', 'paK');
    const a0 = s.num('default_acceleration') || 5000;
    const scv = s.caps.cornerVelocity ?? 5;
    let corners = 0, adjusted = 0, slowest = Infinity;
    for (const L of layers) {
      const plan = planLayer(L, a0, scv);
      for (const p of plan) {
        const m = L.ops[p.op] as Move;
        if (m.travel || m.e <= 0) continue;
        if (p.vOut < 0.5 * p.vMax) { corners++; slowest = Math.min(slowest, p.vOut); }
        if (s.caps.pressureAdvance) continue;
        // software pressure advance: the melt lags the commanded flow by K, so a speed change Δv along a
        // move needs ΔE = K·Δv·(E/len) extra (accelerating) or less (decelerating)
        const ePerMm = m.e / Math.max(p.len, 1e-9);
        const dE = K * ((p.vMax - p.vIn) - (p.vMax - p.vOut)) * ePerMm;
        if (Math.abs(dE) > 1e-6) { m.e = Math.max(0, m.e + dE); adjusted++; }
      }
    }
    r.stats = { planned_layers: layers.length, slow_corners: corners, slowest_corner_mm_s: Number.isFinite(slowest) ? +slowest.toFixed(1) : 0, square_corner_velocity: scv, flow_adjusted_moves: adjusted, pressure_advance: s.caps.pressureAdvance ? 'firmware' : `software K=${K}` };
  },
};

export const cornerOvershoot: TechModule = {
  id: 'corner_overshoot',
  post(s, layers) {
    const r = s.report('corner_overshoot');
    const gain = s.pnum('corner_overshoot', 'gain') * (s.caps.pressureAdvance ? 0.5 : 1);
    const minAngle = (s.pnum('corner_overshoot', 'minAngle') * Math.PI) / 180;
    let n = 0;
    for (const L of layers) {
      const out: Op[] = [];
      let px = NaN, py = NaN, pdx = 0, pdy = 0, prev: Move | null = null;
      for (let i = 0; i < L.ops.length; i++) {
        const op = L.ops[i];
        if (op.k !== 'move') { out.push(op); prev = null; continue; }
        if (op.travel || op.e <= 0 || op.feature !== 'outer_wall' || Number.isNaN(px)) { out.push(op); px = op.x; py = op.y; prev = op.travel ? null : op; pdx = pdy = 0; continue; }
        const len = Math.hypot(op.x - px, op.y - py);
        const dx = (op.x - px) / (len || 1), dy = (op.y - py) / (len || 1);
        // the corner between the previous outer-wall move and this one
        if (prev && prev.feature === 'outer_wall' && (pdx || pdy)) {
          const turn = Math.acos(Math.max(-1, Math.min(1, pdx * dx + pdy * dy))); // 0 straight
          const interior = Math.PI - turn;
          if (interior < minAngle) {
            // drag catenary: the bead is pulled inside the corner by ~ w·(1 − sin(φ/2)); swing past it
            const d = gain * op.w * 0.5 * (1 - Math.sin(interior / 2));
            const cx = px + pdx * d, cy = py + pdy * d;
            const ePer = op.e / Math.max(len, 1e-9);
            // out past the corner with a flow dip, back onto it dry, then on along the next edge
            out.push(moveLike(prev, cx, cy, prev.z, d * ePer * 0.6, flowPatch(prev, 0.6)), moveLike(prev, px, py, prev.z, 0));
            n++;
          }
        }
        out.push(op);
        px = op.x; py = op.y; pdx = dx; pdy = dy; prev = op;
      }
      L.ops = out;
    }
    if (!n) { r.status = 'idle'; r.reason = 'No outer-wall corners sharper than the threshold.'; return; }
    r.stats = { corners: n, gain, firmware_pa: s.caps.pressureAdvance ? 'yes (overshoot halved)' : 'no' };
  },
};

