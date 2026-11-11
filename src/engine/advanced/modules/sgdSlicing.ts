// #14 Differentiable SGD slicing: refines the layer deformation to cut overhangs within head clearance.
import { optimiseLayers } from '../sgd';
import type { TechModule, Warp } from '../session';
import { CompositeWarp, DisplacementField, SumWarp } from '../warp';

export const sgdSlicing: TechModule = {
  id: 'sgd_slicing',
  warp(s, base) {
    const r = s.report('sgd_slicing');
    const fields: DisplacementField[] = [];
    let o0 = 0, o1 = 0, l0 = 0, l1 = 0;
    for (const a of s.parts) {
      const res = optimiseLayers(a, {
        w1: s.pnum('sgd_slicing', 'w1'), w2: s.pnum('sgd_slicing', 'w2'), w3: s.pnum('sgd_slicing', 'w3'), w4: s.pnum('sgd_slicing', 'w4'),
        iters: s.pnum('sgd_slicing', 'iters'), ctrl: s.pnum('sgd_slicing', 'ctrl'),
        maxSlopeDeg: s.caps.maxSlopeDeg * 0.8, overhangDeg: s.num('support_threshold_angle') || 30, minRatio: 0.5, maxRatio: 1.5,
      }, base);
      if (!res) continue;
      // keep the optimised part within the hard limits (global scale on this part's refinement)
      const tanMax = Math.tan((s.caps.maxSlopeDeg * Math.PI) / 180);
      let k = 1;
      for (let it = 0; it < 30; it++) {
        const st = res.field.scaled(k).stats();
        if (st.maxSlope <= tanMax * 0.8 && st.minRatio >= 0.5 && st.maxRatio <= 1.5) break;
        k *= 0.85;
      }
      fields.push(k < 1 ? res.field.scaled(k) : res.field);
      o0 += res.overhang0; o1 += res.overhang * k + res.overhang0 * (1 - k); l0 += res.loss0; l1 += res.loss;
    }
    if (!fields.length) { r.status = 'idle'; r.reason = 'No overhangs to optimise.'; return base; }
    const mine: Warp = fields.length === 1 ? fields[0] : new CompositeWarp(fields, 'sgd_slicing');
    r.stats = { loss_start: +l0.toFixed(4), loss_end: +l1.toFixed(4), overhang_loss_cut_pct: o0 > 0 ? Math.round(100 * (1 - o1 / o0)) : 0 };
    return base ? new SumWarp(base, mine, 'sgd_slicing') : mine;
  },
};
