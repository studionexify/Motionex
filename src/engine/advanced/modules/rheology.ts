// #27 Iso-thermal velocity gloss mapping, #17 shear-induced gloss modulation and #5 transient thermal
// "hot-on-hot" planning (lumped bead cooling ρch·dT/dt = −h_conv(T − T_amb) over the planned layer time): the passes that set speed, fan and layer time for what the surface and the
// layer bond need.
import type { LayerOps } from '../classic/gcode';
import { planLayer } from '../planner';
import type { Move } from '../runs';
import type { TechModule } from '../session';

/** PLA melt as a power-law fluid: τ = K γ̇ⁿ (K in Pa·sⁿ). */
export const PLA_MELT = { K: 4500, n: 0.35 };

/** Wall shear stress of a power-law melt in a round nozzle: τ_w = K((3n+1)/4n · 4Q/πR³)ⁿ (Pa). */
export function wallShear(Qmm3s: number, Rmm: number, K = PLA_MELT.K, n = PLA_MELT.n): number {
  const Q = Qmm3s * 1e-9, R = Rmm * 1e-3;
  const gw = ((3 * n + 1) / (4 * n)) * ((4 * Q) / (Math.PI * R ** 3));
  return K * gw ** n;
}

const layerTime = (L: LayerOps, a: number) => planLayer(L, a).reduce((t, p) => t + p.t, 0);

export const isoGloss: TechModule = {
  id: 'iso_gloss',
  finalize(s, layers) {
    const r = s.report('iso_gloss');
    const v0 = s.num('outer_wall_speed') || 200, minT = s.num('slow_down_layer_time');
    const gamma = s.pnum('iso_gloss', 'fanGamma');
    const a = s.num('default_acceleration') || 5000;
    let fixedMoves = 0, slowed = 0, fanUp = 0;
    for (const L of layers.slice(1)) {
      let hasOuter = false;
      for (const op of L.ops) if (op.k === 'move' && !op.travel && op.feature === 'outer_wall') {
        // the outer wall keeps one speed, untouched by the cooling slowdown
        op.f = Math.min(op.f, v0); op.fixed = true; hasOuter = true; fixedMoves++;
      }
      if (!hasOuter || minT <= 0) continue;
      const t = layerTime(L, a);
      if (t >= minT) continue;
      // short layer: take the time from the other printing moves (and the fan), never the outer wall
      let tOuter = 0;
      for (const p of planLayer(L, a)) { const m = L.ops[p.op] as Move; if (!m.travel && m.feature === 'outer_wall') tOuter += p.t; }
      const rest = t - tOuter, need = minT - tOuter;
      if (rest > 1e-3 && need > rest) {
        const k = rest / need;
        for (const op of L.ops) if (op.k === 'move' && !op.travel && op.feature !== 'outer_wall') { op.f = Math.max(op.f * k, s.num('slow_down_min_speed') || 10); op.fixed = true; }
        slowed++;
      }
      // what slowing cannot recover, the fan does: fan′ = fan·(t_min / t)^γ
      const f2 = Math.min(100, L.fan * (minT / Math.max(t, 1e-3)) ** gamma);
      if (f2 > L.fan + 0.5) { L.fan = Math.round(f2); fanUp++; }
    }
    if (!fixedMoves) { r.status = 'idle'; r.reason = 'No outer wall.'; return; }
    const w = s.num('outer_wall_line_width') || s.num('line_width') || 0.42, h = s.num('layer_height') || 0.2;
    r.stats = { outer_wall_mm_s: v0, wall_shear_kPa: +(wallShear(v0 * w * h, s.caps.nozzle / 2) / 1000).toFixed(1), short_layers_rebalanced: slowed, fan_raised_layers: fanUp };
  },
};

export const glossModulation: TechModule = {
  id: 'gloss_modulation',
  finalize(s, layers) {
    const r = s.report('gloss_modulation');
    const contrast = s.pnum('gloss_modulation', 'contrast');
    // painted matte (3) and gloss (4) faces as points on a 1 mm hash
    const cells = new Map<number, { x: number; y: number; z: number; v: number }[]>();
    const key = (x: number, y: number, z: number) => (Math.floor(x) + 2048) + 4096 * ((Math.floor(y) + 2048) + 4096 * Math.floor(z * 2));
    let painted = 0;
    for (const m of s.meshes) {
      const p = m.paint?.adv;
      if (!p) continue;
      const v = m.vertices, ix = m.indices!;
      for (let t = 0; t < p.length; t++) {
        if (p[t] !== 3 && p[t] !== 4) continue;
        painted++;
        const A = ix[t * 3] * 3, B = ix[t * 3 + 1] * 3, C = ix[t * 3 + 2] * 3;
        const n = Math.max(1, Math.ceil(Math.max(Math.hypot(v[B] - v[A], v[B + 1] - v[A + 1], v[B + 2] - v[A + 2]), Math.hypot(v[C] - v[A], v[C + 1] - v[A + 1], v[C + 2] - v[A + 2])) / 0.5));
        for (let i = 0; i <= n; i++) for (let j = 0; j <= n - i; j++) {
          const x = v[A] + (i / n) * (v[B] - v[A]) + (j / n) * (v[C] - v[A]), y = v[A + 1] + (i / n) * (v[B + 1] - v[A + 1]) + (j / n) * (v[C + 1] - v[A + 1]), z = v[A + 2] + (i / n) * (v[B + 2] - v[A + 2]) + (j / n) * (v[C + 2] - v[A + 2]);
          const k = key(x, y, z);
          const l = cells.get(k); if (l) l.push({ x, y, z, v: p[t] }); else cells.set(k, [{ x, y, z, v: p[t] }]);
        }
      }
    }
    if (!painted) { r.status = 'idle'; r.reason = 'Paint matte or gloss areas with the Advanced paint tool.'; return; }
    const near = (x: number, y: number, z: number): number => {
      let best = 0, bd = 1.0;
      for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const l = cells.get(key(x + dx, y + dy, z + dz * 0.5));
        if (l) for (const q of l) { const d = Math.hypot(q.x - x, q.y - y, q.z - z); if (d < bd) { bd = d; best = q.v; } }
      }
      return best;
    };
    const w = s.num('outer_wall_line_width') || 0.42, h = s.num('layer_height') || 0.2, R = s.caps.nozzle / 2;
    let matte = 0, gloss = 0, tauM = 0, tauG = Infinity;
    for (const L of layers) for (const op of L.ops) {
      if (op.k !== 'move' || op.travel || op.feature !== 'outer_wall') continue;
      const v = near(op.x, op.y, op.z - op.h / 2);
      if (!v) continue;
      // matte: high shear and fast quench (sharkskin texture); gloss: low shear, slow and hot
      const k = v === 3 ? 1 + 0.8 * contrast : 1 - 0.5 * contrast;
      op.f = op.f * k; op.fixed = true;
      const tw = wallShear(op.f * w * h, R);
      if (v === 3) { matte++; tauM = Math.max(tauM, tw); } else { gloss++; tauG = Math.min(tauG, tw); }
    }
    if (!matte && !gloss) { r.status = 'idle'; r.reason = 'No outer wall passes through the painted areas.'; return; }
    r.stats = { matte_moves: matte, gloss_moves: gloss, matte_shear_kPa: +(tauM / 1000).toFixed(1), gloss_shear_kPa: Number.isFinite(tauG) ? +(tauG / 1000).toFixed(1) : 0, contrast };
  },
};

/** Glass transition of common filaments (°C). */
const tgOf = (type: string) => (/ABS|ASA/i.test(type) ? 105 : /PC/i.test(type) ? 145 : /PETG/i.test(type) ? 80 : /PA|NYLON/i.test(type) ? 70 : /TPU/i.test(type) ? -30 : 60);

export const hotOnHot: TechModule = {
  id: 'hot_on_hot',
  finalize(s, layers) {
    const r = s.report('hot_on_hot');
    const type = s.filaments[0]?.type ?? 'PLA';
    const Tg = tgOf(type), margin = s.pnum('hot_on_hot', 'margin'), maxCut = s.pnum('hot_on_hot', 'maxFanCut');
    const Tn = s.filaments[0]?.nozzleTemp ?? 220, Tamb = s.caps.heatedChamber ? s.caps.chamberTemp : 25;
    const a = s.num('default_acceleration') || 5000;
    // lumped 1D bead: τ = ρ c h / h_conv, h_conv = 15 + 85·fan W/m²K (natural → forced)
    const rho = 1240, c = 1800;
    let cut = 0, cold = 0, worst = Infinity;
    for (const L of layers.slice(1)) {
      const t = layerTime(L, a);
      const tau = (fan: number) => (rho * c * L.h * 1e-3) / (15 + 85 * (fan / 100));
      const Ti = (fan: number) => Tamb + (Tn - Tamb) * Math.exp(-t / tau(fan));
      // the bond needs the layer below still above Tg + margin when the next bead lands on it
      const Tc = Ti;
      const target = Tg + margin;
      let fan = L.fan;
      if (Tc(fan) < target && fan > 0) {
        // the weakest fan that still keeps the interface above Tg + margin, down to (1 − maxCut)·fan
        const lo = fan * (1 - maxCut);
        let f2 = fan;
        while (f2 > lo && Tc(f2) < target) f2 -= 1;
        if (f2 < fan) { L.fan = Math.max(Math.round(lo), Math.round(f2)); cut++; }
        fan = L.fan;
      }
      if (Tc(fan) < target) cold++;
      worst = Math.min(worst, Tc(fan));
    }
    r.stats = { Tg_C: Tg, weld_target_C: Tg + margin, ambient_C: Tamb, fan_reduced_layers: cut, layers_below_target: cold, coldest_interface_C: Number.isFinite(worst) ? Math.round(worst) : 0 };
    if (cold) s.warn(`Hot-on-hot: ${cold} layers bond below Tg + ${margin} °C even with the fan reduced; add a layer-time minimum or print several parts together.`);
  },
};
