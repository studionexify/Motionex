// #18 Thermodynamic cellular foaming. A foaming filament (LW-PLA) expands with melt temperature,
// X(T) = 1 + (X_max − 1)·smoothstep((T − T₀)/(T₁ − T₀)): solid hubs (walls, skins, bolt-hole bosses) are
// printed cool, cores hot and foamed. The hotend is a first-order system, τ dT/dt = T_set − T, so each
// temperature change is commanded τ·ln(|ΔT|/2 K) seconds ahead of the zone (look-ahead), zones shorter
// than τ/2 keep the current setting (hysteresis), and every extrusion's flow is divided by the expansion
// the observer predicts for the nozzle at that moment.
import type { LayerOps, Op } from '../classic/gcode';
import { moveTime } from '../classic/gcode';
import { smoothstep } from '../grid';
import { flowPatch } from '../runs';
import type { SessionCtx, TechModule } from '../session';

const T0 = 205, T1 = 250;
export const expansion = (T: number, xmax: number) => 1 + (xmax - 1) * smoothstep((T - T0) / (T1 - T0));

interface Step { layer: number; op: number; t: number; dt: number; zone: 0 | 1 }

/** Core (foam) or hub (solid) for an extrusion move. */
function zoneOf(s: SessionCtx, op: Extract<Op, { k: 'move' }>): 0 | 1 {
  if (op.feature !== 'sparse_infill') return 0;
  for (const a of s.parts) for (const b of a.bosses) if (op.z >= b.z0 - 1 && op.z <= b.z1 + 1 && Math.hypot(op.x - b.cx, op.y - b.cy) <= b.r + Math.max(2.5 * b.r, 3)) return 0;
  return 1;
}

export const foamControl: TechModule = {
  id: 'foam_control',
  finalize(s, layers: LayerOps[]) {
    const r = s.report('foam_control');
    const hub = s.pnum('foam_control', 'hubTemp'), core = s.pnum('foam_control', 'coreTemp'), xmax = s.pnum('foam_control', 'xmax');
    const tau = s.caps.heaterTau;
    const accel = s.num('default_acceleration') || 5000;
    // 1) timeline of extrusions with their zone
    const steps: Step[] = [];
    let t = 0, px = NaN, py = NaN, pz = NaN;
    layers.forEach((L, li) => L.ops.forEach((op, oi) => {
      if (op.k === 'raw' && op.time) t += op.time;
      if (op.k !== 'move') return;
      const len = Number.isNaN(px) ? 0 : Math.hypot(op.x - px, op.y - py, op.z - pz);
      const dt = moveTime(len, op.f, accel);
      px = op.x; py = op.y; pz = op.z;
      if (!op.travel && op.e > 0) steps.push({ layer: li, op: oi, t, dt, zone: li === 0 ? 0 : zoneOf(s, op) });
      t += dt;
    }));
    if (!steps.length || !steps.some((x) => x.zone === 1)) { r.status = 'idle'; r.reason = 'No core (sparse infill) to foam.'; return; }
    // 2) zone runs; runs shorter than τ/2 take the setting of the run before (hysteresis)
    type RunZ = { start: number; end: number; zone: 0 | 1 };
    const runs: RunZ[] = [];
    for (let i = 0; i < steps.length; i++) {
      const last = runs[runs.length - 1];
      if (last && last.zone === steps[i].zone) last.end = i; else runs.push({ start: i, end: i, zone: steps[i].zone });
    }
    const dur = (q: RunZ) => steps[q.end].t + steps[q.end].dt - steps[q.start].t;
    for (let i = 1; i < runs.length; i++) if (dur(runs[i]) < 0.5 * tau) runs[i].zone = runs[i - 1].zone;
    const merged: RunZ[] = [];
    for (const q of runs) { const l = merged[merged.length - 1]; if (l && l.zone === q.zone) l.end = q.end; else merged.push({ ...q }); }
    // 3) set-point changes, commanded ahead of each run
    const lead = tau * Math.log(Math.max(1.0001, Math.abs(core - hub) / 2));
    const inserts = new Map<string, number>(); // "layer:op" -> temperature
    const setAt: { t: number; T: number }[] = [{ t: 0, T: hub }];
    inserts.set(`${steps[0].layer}:${steps[0].op}`, hub);
    for (let i = 1; i < merged.length; i++) {
      const T = merged[i].zone ? core : hub;
      const tc = Math.max(0, steps[merged[i].start].t - lead);
      // the extrusion running at the command time carries the M104
      let k = merged[i].start;
      while (k > 0 && steps[k].t > tc) k--;
      inserts.set(`${steps[k].layer}:${steps[k].op}`, T);
      setAt.push({ t: steps[k].t, T });
    }
    // 4) observer: predicted nozzle temperature → expansion → flow
    let Tn = s.filaments[0]?.nozzleTemp ?? hub, tPrev = 0, si = 0, Tset = hub;
    let xlo = Infinity, xhi = 0, scale = 0;
    for (const st of steps) {
      while (si < setAt.length && setAt[si].t <= st.t) { Tset = setAt[si].T; si++; }
      const tm = st.t + st.dt / 2;
      Tn = Tset + (Tn - Tset) * Math.exp(-(tm - tPrev) / tau);
      tPrev = tm;
      const X = expansion(Tn, xmax);
      const op = layers[st.layer].ops[st.op] as Extract<Op, { k: 'move' }>;
      op.e /= X;
      op.w = flowPatch(op, 1 / X).w; // declared as the unexpanded melt bead: the filament really is 1/X of the nominal volume
      xlo = Math.min(xlo, X); xhi = Math.max(xhi, X); scale += 1 / X;
    }
    // 5) write the commands (from the end so indices stay valid)
    const keys = [...inserts.entries()].map(([k, T]) => { const [l, o] = k.split(':').map(Number); return { l, o, T }; }).sort((a, b) => b.l - a.l || b.o - a.o);
    for (const { l, o, T } of keys) layers[l].ops.splice(o, 0, { k: 'raw', text: `M104 S${Math.round(T)} ; NexSpiro foam look-ahead` });
    r.stats = { hub_C: hub, core_C: core, setpoint_changes: keys.length, lead_s: +lead.toFixed(1), heater_tau_s: tau, expansion_range: `${xlo.toFixed(2)}–${xhi.toFixed(2)}`, mean_flow_scale: +(scale / steps.length).toFixed(3) };
  },
};
