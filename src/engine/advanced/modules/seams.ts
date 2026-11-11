// #22 Sub-surface tangential spiral entry and #23 3D volumetric scarf-wedge splice: the two ways the
// Advanced engine hides the start and end of an outer-wall loop.
import type { LayerOps, Op } from '../classic/gcode';
import { along, flowPatch, moveLike, runPoints, runsOf, signedArea, type Move, type Run } from '../runs';
import type { SessionCtx, TechModule } from '../session';
import type { PartAnalysis } from '../analysis';

const MARK = '; NEXSPIRO_SEAM';
const smooth = (t: number) => { const x = Math.max(0, Math.min(1, t)); return x * x * (3 - 2 * x); };

/** Depth of a point inside the parts (mm, positive inside) from their signed distance fields. */
function depthAt(parts: PartAnalysis[], x: number, y: number, z: number): number {
  let best = -Infinity;
  for (const p of parts) {
    if (x < p.sdf.min[0] - 1 || y < p.sdf.min[1] - 1 || x > p.sdf.max[0] + 1 || y > p.sdf.max[1] + 1) continue;
    best = Math.max(best, -p.sdf.sdf.sample(x, y, z));
  }
  return best;
}

/** Outer-wall loops of a layer, last first (so edits keep earlier indices valid). */
const outerLoops = (L: LayerOps) => runsOf(L).filter((r) => r.closed && r.feature === 'outer_wall').reverse();
const marked = (L: LayerOps, r: Run) => { for (let i = r.start - 1; i >= 0 && i >= r.start - 8; i--) { const op = L.ops[i]; if (op.k === 'raw' && op.text.startsWith(MARK)) return true; if (op.k === 'move' && !op.travel) break; } return false; };

/** Point on the loop at arc s (wrapping), offset towards the part interior by d. */
function inset(p: ReturnType<typeof runPoints>, ccw: boolean, s: number, d: number) {
  const L = p.s[p.s.length - 1];
  const a = along(p, ((s % L) + L) % L);
  // the material is on the left of a counter-clockwise outer contour and of a clockwise hole
  const nx = ccw ? -a.ty : a.ty, ny = ccw ? a.tx : -a.tx;
  return { x: a.x + nx * d, y: a.y + ny * d, z: a.z, tx: a.tx, ty: a.ty, nx, ny };
}

export const tangentEntry: TechModule = {
  id: 'tangent_entry',
  post(s, layers) {
    const r = s.report('tangent_entry');
    const radius = s.pnum('tangent_entry', 'radius');
    const merge = (s.pnum('tangent_entry', 'merge') * Math.PI) / 180;
    const walls = Math.max(1, Math.round(s.num('wall_loops')));
    const w = s.num('outer_wall_line_width') || s.num('line_width') || s.caps.nozzle;
    const wi = s.num('inner_wall_line_width') || w;
    const D = w / 2 + (walls - 1) * wi + wi * 0.5; // just inside the innermost wall
    let done = 0, skipped = 0, worst = 0;
    layers.forEach((L, li) => {
      if (li === 0 || s.helicalLayers.has(li)) return;
      for (const run of outerLoops(L)) {
        const p = runPoints(L, run);
        const Ltot = p.s[p.s.length - 1];
        // merge length for the chosen angle, shortened (steeper merge) on small loops
        let Lm = (1.5 * D) / Math.tan(merge);
        if (Lm > 0.35 * Ltot) Lm = 0.35 * Ltot;
        if (Lm < 2 * w) { skipped++; continue; }
        const ang = Math.atan((1.5 * D) / Lm);
        const ccw = signedArea(p.x, p.y) > 0;
        const tmpl = L.ops[run.start] as Move;
        const ePerMm = p.e / Math.max(Ltot, 1e-9);
        // approach: from Lm before the seam, inset by D, merging into the wall at the seam
        const approach: { x: number; y: number; z: number }[] = [];
        const steps = Math.max(6, Math.ceil(Lm / 0.6));
        for (let k = 0; k <= steps; k++) { const t = k / steps; const q = inset(p, ccw, -Lm + t * Lm, D * (1 - smooth(t))); approach.push(q); }
        // Archimedean spiral (one turn, r = radius·θ/2π) ending at the approach start, deeper inside
        const a0 = inset(p, ccw, -Lm, D);
        const cx = a0.x + a0.nx * radius, cy = a0.y + a0.ny * radius;
        const endAng = Math.atan2(a0.y - cy, a0.x - cx);
        const spiral: { x: number; y: number }[] = [];
        const turns = 24;
        for (let k = 0; k <= turns; k++) { const th = (k / turns) * 2 * Math.PI; const rho = (radius * th) / (2 * Math.PI); const ph = endAng - 2 * Math.PI + th; spiral.push({ x: cx + rho * Math.cos(ph), y: cy + rho * Math.sin(ph) }); }
        // lead-out: past the seam, peeling back inside
        const out: { x: number; y: number; z: number }[] = [];
        for (let k = 0; k <= steps; k++) { const t = k / steps; out.push(inset(p, ccw, t * Lm, D * smooth(t))); }
        // everything off the wall must stay inside the part
        const inside = (x: number, y: number) => depthAt(s.parts, x, y, tmpl.z - tmpl.h / 2) >= w * 0.5;
        if (![...spiral, ...approach.slice(0, -2), ...out.slice(2)].every((q) => inside(q.x, q.y))) { skipped++; continue; }
        const ops: Op[] = [{ k: 'raw', text: `${MARK} tangent entry` }];
        let qx = spiral[0].x, qy = spiral[0].y, qz = tmpl.z;
        const ext = (x: number, y: number, z: number, flow: number, fs: number, feature: Move['feature'] = 'inner_wall') => {
          const len = Math.hypot(x - qx, y - qy, z - qz); // true 3-D length: the approach descends / rises
          if (len < 1e-5) return;
          ops.push(moveLike(tmpl, x, y, z, len * ePerMm * flow, { f: tmpl.f * fs, feature, ...flowPatch(tmpl, flow) }));
          qx = x; qy = y; qz = z;
        };
        spiral.forEach((q, k) => ext(q.x, q.y, tmpl.z, 0.4 * (k / turns), 0.5));
        approach.forEach((q, k) => ext(q.x, q.y, q.z, 0.4 + 0.6 * smooth(k / steps), 0.8));
        // the loop itself, unchanged
        for (let i = run.start; i <= run.end; i++) ops.push(L.ops[i]);
        qx = p.x[p.x.length - 1]; qy = p.y[p.y.length - 1]; qz = p.z[p.z.length - 1];
        out.forEach((q, k) => ext(q.x, q.y, q.z, 1 - smooth(k / steps), 0.8));
        // the travel that led to the seam now leads to the spiral's centre
        for (let i = run.start - 1; i >= 0; i--) {
          const m = L.ops[i];
          if (m.k === 'move' && !m.travel) break;
          if (m.k === 'move' && Math.hypot(m.x - run.x0, m.y - run.y0) < 1e-3) L.ops[i] = { ...m, x: spiral[0].x, y: spiral[0].y };
        }
        L.ops.splice(run.start, run.end - run.start + 1, ...ops);
        done++;
        worst = Math.max(worst, (ang * 180) / Math.PI);
      }
    });
    if (!done) { r.status = 'idle'; r.reason = 'No outer loop with room for a buried entry.'; return; }
    r.stats = { loops: done, too_small: skipped, merge_angle_deg: +worst.toFixed(1) };
  },
};

export const scarfSplice: TechModule = {
  id: 'scarf_splice',
  post(s, layers) {
    const r = s.report('scarf_splice');
    const want = s.pnum('scarf_splice', 'length');
    const slow = s.pnum('scarf_splice', 'slow');
    const fanOff = s.pnum('scarf_splice', 'fanOffMs') / 1000;
    let done = 0;
    layers.forEach((L, li) => {
      if (li === 0 || s.helicalLayers.has(li)) return;
      for (const run of outerLoops(L)) {
        if (marked(L, run)) continue;
        const p = runPoints(L, run);
        const Ltot = p.s[p.s.length - 1];
        const Ls = Math.min(want, 0.4 * Ltot);
        if (Ls < 1) continue;
        const tmpl = L.ops[run.start] as Move;
        const ePerMm = p.e / Math.max(Ltot, 1e-9);
        const h = tmpl.h;
        const ops: Op[] = [{ k: 'raw', text: `${MARK} scarf` }];
        let qx = p.x[0], qy = p.y[0], qz = p.z[0];
        const step = 0.5;
        const ext = (x: number, y: number, z: number, flow: number, f: number) => {
          const len = Math.hypot(x - qx, y - qy, z - qz); // true 3-D length of the sloped wedge bead
          if (len < 1e-5) return;
          ops.push(moveLike(tmpl, x, y, z, len * ePerMm * flow, { f, ...flowPatch(tmpl, flow) }));
          qx = x; qy = y; qz = z;
        };
        // wedge start: half a layer low, flow on the Hermite ramp E(s) = 3(s/L)² − 2(s/L)³; beads already
        // lowered by surface passes only drop what is left of the half-layer budget
        const n1 = Math.max(4, Math.ceil(Ls / step));
        const devAt = (sv: number) => {
          let i = 1;
          while (i < p.s.length - 1 && p.s[i] < sv) i++;
          return (L.ops[run.start + i - 1] as Move).dev ?? 0;
        };
        for (let k = 1; k <= n1; k++) {
          const t = k / n1, tm = (k - 0.5) / n1;
          const a = along(p, t * Ls);
          const prior = devAt(t * Ls);
          // the wedge eases in no faster than the head clearance allows (a plunge steeper than the machine's slope limit would collide)
          const ease = Math.tan((Math.min(s.caps.maxSlopeDeg, 80) * Math.PI) / 180) * 0.98 * t * Ls;
          const drop = Math.max(0, Math.min(0.5 * h * (1 - t), 0.5 * h + prior, ease));
          ext(a.x, a.y, a.z - drop, smooth(tm), tmpl.f);
        }
        // the rest of the loop as printed
        for (let i = run.start; i <= run.end; i++) {
          const m = L.ops[i] as Move;
          const sEnd = p.s[i - run.start + 1];
          if (sEnd <= Ls + 1e-6) continue;
          const sStart = p.s[i - run.start];
          if (sStart < Ls) {
            // this move starts inside the wedge: print only its part after the wedge
            ops.push(moveLike(m, m.x, m.y, m.z, m.e * ((sEnd - Ls) / Math.max(sEnd - sStart, 1e-9))));
          } else ops.push(m);
          qx = m.x; qy = m.y; qz = m.z;
        }
        // closure: over the wedge again at full height with the complementary flow, slower, fan off
        const vClose = tmpl.f * slow;
        const fanOn = L.fan > 0 ? `M106 S${Math.round((L.fan / 100) * 255)}` : '';
        if (fanOn && fanOff > 0) ops.push({ k: 'raw', text: 'M106 S0 ; scarf re-melt' });
        const fanBack = Math.min(Ls, fanOff * vClose);
        let restored = !fanOn || fanOff <= 0;
        for (let k = 1; k <= n1; k++) {
          const t = k / n1, tm = (k - 0.5) / n1;
          const a = along(p, t * Ls);
          ext(a.x, a.y, a.z, 1 - smooth(tm), vClose);
          if (!restored && t * Ls >= fanBack) { ops.push({ k: 'raw', text: fanOn }); restored = true; }
        }
        if (!restored) ops.push({ k: 'raw', text: fanOn });
        L.ops.splice(run.start, run.end - run.start + 1, ...ops);
        done++;
      }
    });
    if (!done) { r.status = 'idle'; r.reason = 'No outer loops left to splice.'; return; }
    s.nonPlanar = true;
    r.stats = { loops: done, length_mm: want };
  },
};

export type { SessionCtx };
