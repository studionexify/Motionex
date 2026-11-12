// Print physics for the preview: works out how the printer really moves and how much plastic lands
// where, so the preview shows the print as it will come out, not just the commanded path.
//  · Motion planning: acceleration and cornering speed (square-corner velocity, as Klipper/Marlin JD)
//    with forward/backward passes, so the nozzle slows at corners and sharp motion turns.
//  · Melt pressure lag: the nozzle flow follows the commanded flow with a time constant, so slowing
//    down releases extra plastic (blobs) and speeding up starves the line (thin spots).
//  · Hotend melt limit: flow above the hotend's mm³/s is lost (under-extrusion).
//  · Seams & starts: ooze blob after a retracted travel; pressure rebuilds from low.
//  · Overhang sag: a line placed beyond the line below droops by how far it is unsupported.
import type { GenResult, SliceSettings } from './generator';

export interface Physics {
  accel: number;        // mm/s²
  scv: number;          // square corner velocity, mm/s
  lag: number;          // melt pressure time constant, s (0 = perfect pressure advance)
  hotendFlow: number;   // mm³/s the hotend can melt
  sag: number;          // sag strength (1 = typical PLA with fan)
  ooze: number;         // mm³ released at a restart after travel
}
export const PHYSICS_BY_PRINTER: Record<string, Partial<Physics>> = {
  'bbl-a1': { accel: 10000, scv: 9, hotendFlow: 21 }, 'bbl-p1s': { accel: 10000, scv: 9, hotendFlow: 21 },
  'snapmaker-u1': { accel: 10000, scv: 8, hotendFlow: 20 }, 'elegoo-n4max': { accel: 5000, scv: 5, hotendFlow: 18 },
};
export const DEFAULT_PHYSICS: Physics = { accel: 5000, scv: 5, lag: 0.035, hotendFlow: 20, sag: 1, ooze: 0.25 };
export const physicsFor = (printer: string): Physics => ({ ...DEFAULT_PHYSICS, ...PHYSICS_BY_PRINTER[printer] });

export const DEFECT = { blob: 1, thin: 2, sag: 4, starve: 8 } as const;

export interface PrintSim {
  /** Per segment (same index as result.segs): actual bead width, height, droop, average speed, deposited/nominal ratio, defect bits. */
  /** Planner speed at the end of each move (mm/s). */
  vexit: Float32Array;
  width: Float32Array; height: Float32Array; droop: Float32Array; speed: Float32Array; ratio: Float32Array; defects: Uint8Array;
  stats: { seconds: number; blobs: number; thin: number; sag: number; starve: number; minRatio: number; maxRatio: number; maxDroop: number };
}

const BUCKETS = 2048;

/** plan: the originally planned filament per move (defaults to the G-code's own); results are judged against it. */
export function simulate(res: GenResult, s: SliceSettings, ph: Physics, plan?: number[]): PrintSim {
  const segs = res.segs, n = segs.length;
  const vexit = new Float32Array(n), width = new Float32Array(n), height = new Float32Array(n), droop = new Float32Array(n), speed = new Float32Array(n), ratio = new Float32Array(n), defects = new Uint8Array(n);
  const fa = Math.PI * (s.filamentDia / 2) ** 2;
  const a = Math.max(100, ph.accel);
  const jd = (ph.scv * ph.scv * (Math.SQRT2 - 1)) / a;

  // lengths, unit vectors, cruise speeds
  const len = new Float64Array(n), ux = new Float64Array(n), uy = new Float64Array(n), uz = new Float64Array(n), vmax2 = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const g = segs[i], dx = g.x - g.x0, dy = g.y - g.y0, dz = g.z - g.z0, d = Math.hypot(dx, dy, dz);
    len[i] = d; if (d > 0) { ux[i] = dx / d; uy[i] = dy / d; uz[i] = dz / d; }
    vmax2[i] = g.speed * g.speed;
  }
  // junction limits (entry of i)
  const entry2 = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    if (i === 0 || segs[i].ret || segs[i - 1].ret) { entry2[i] = 0; continue; }
    const cos = -(ux[i] * ux[i - 1] + uy[i] * uy[i - 1] + uz[i] * uz[i - 1]);
    const sinHalf = Math.sqrt(Math.max(0, (1 - cos) / 2));
    let v2 = sinHalf > 0.9999 ? Infinity : (a * jd * sinHalf) / (1 - sinHalf);
    v2 = Math.min(v2, vmax2[i], vmax2[i - 1]);
    entry2[i] = v2;
  }
  // backward pass: entry speed must allow decelerating to the next entry
  const exit2 = new Float64Array(n);
  let next = 0;
  for (let i = n - 1; i >= 0; i--) { exit2[i] = next; entry2[i] = Math.min(entry2[i], next + 2 * a * len[i]); next = entry2[i]; }
  // forward pass
  let prev = 0;
  for (let i = 0; i < n; i++) { entry2[i] = Math.min(entry2[i], prev); const ex = Math.min(exit2[i], entry2[i] + 2 * a * len[i]); exit2[i] = ex; prev = ex; }

  // bucketed radius of the previous layer's outer line, for overhang
  const cx = s.bedX / 2, cy = s.bedY / 2;
  let prevR = new Float32Array(BUCKETS).fill(NaN), curR = new Float32Array(BUCKETS).fill(NaN);
  let layer = -1;

  let Q = 0, oozeLeft = 0, seconds = 0;
  let blobs = 0, thin = 0, sagN = 0, starve = 0, minRatio = 9, maxRatio = 0, maxDroop = 0;
  const lag = Math.max(0, ph.lag);
  for (let i = 0; i < n; i++) {
    const g = segs[i], d = len[i];
    if (g.layer !== layer) { if (layer >= 0) { const t = prevR; prevR = curR; curR = t; curR.fill(NaN); } layer = g.layer; }
    // time with trapezoid profile
    const v0 = Math.sqrt(entry2[i]), v1 = Math.sqrt(exit2[i]), vm = Math.max(1e-3, g.speed);
    let t = 0;
    if (d > 0) {
      const peak = Math.min(vm, Math.sqrt((2 * a * d + entry2[i] + exit2[i]) / 2));
      const da = (peak * peak - entry2[i]) / (2 * a), dd = (peak * peak - exit2[i]) / (2 * a);
      t = (peak - v0) / a + (peak - v1) / a + Math.max(0, d - da - dd) / Math.max(1e-3, peak);
    }
    seconds += t;
    const vavg = t > 0 ? d / t : 0;
    speed[i] = vavg; vexit[i] = v1;
    if (g.kind === 'travel') {
      if (g.ret) { Q = 0; oozeLeft = ph.ooze; } else Q *= Math.exp(-t / Math.max(1e-3, lag || 1e-3));
      continue;
    }
    // commanded flow and lagged nozzle flow
    const Acmd = d > 0 ? (g.e * fa) / d : g.w * g.h;
    const Anom = plan && d > 0 ? (plan[i] * fa) / d : Acmd;
    const Qcmd = Acmd * vavg;
    const Q0 = Q;
    Q = lag > 0 ? Qcmd + (Q - Qcmd) * Math.exp(-t / lag) : Qcmd;
    let Qavg = lag > 0 && t > 0 ? Qcmd + (Q0 - Qcmd) * (lag / t) * (1 - Math.exp(-t / lag)) : Qcmd;
    let flags = 0;
    if (Qavg > ph.hotendFlow) { Qavg = ph.hotendFlow; Q = Math.min(Q, ph.hotendFlow); flags |= DEFECT.starve; starve++; }
    let vol = Qavg * t;
    if (oozeLeft > 0) { const take = Math.min(oozeLeft, oozeLeft * Math.min(1, d / 0.8)); vol += take; oozeLeft -= take; if (oozeLeft < 0.01) oozeLeft = 0; }
    const A = d > 0 ? vol / d : Anom;
    const r = Anom > 0 ? A / Anom : 1;
    ratio[i] = r;
    // bead: width grows with area; height swells a little on blobs
    const hh = g.h * Math.min(1.35, Math.max(0.7, Math.sqrt(r)));
    height[i] = hh;
    width[i] = Math.max(0.05, A / hh);
    // overhang sag (outer wall lines only)
    if (g.kind === 'wall' || g.kind === 'motion') {
      const mx = (g.x + g.x0) / 2 - cx, my = (g.y + g.y0) / 2 - cy;
      const R = Math.hypot(mx, my), b = Math.floor(((Math.atan2(my, mx) / (Math.PI * 2) + 1) % 1) * BUCKETS) % BUCKETS;
      const pr = prevR[b];
      if (!Number.isNaN(pr) && g.layer > 0) {
        const off = Math.abs(R - pr) - g.w / 2;           // unsupported part of the bead
        if (off > 0) {
          const f = Math.min(1.6, off / Math.max(0.1, g.w));
          const dr = ph.sag * g.h * f * f * (0.6 + 0.4 * Math.min(2, r)) * (1 + Math.max(0, 25 - vavg) / 50);
          droop[i] = Math.min(g.h * 2.5, dr);
        }
      }
      if (Number.isNaN(curR[b]) || R > curR[b]) curR[b] = R;
    }
    if (r > 1.3) { flags |= DEFECT.blob; blobs++; }
    else if (r < 0.75) { flags |= DEFECT.thin; thin++; }
    if (droop[i] > 0.25 * g.h) { flags |= DEFECT.sag; sagN++; }
    defects[i] = flags;
    if (r < minRatio) minRatio = r; if (r > maxRatio) maxRatio = r; if (droop[i] > maxDroop) maxDroop = droop[i];
  }
  // The molten bead spreads along the line over about one nozzle width: judge (and draw) the material
  // averaged over that length, not per tiny move.
  {
    const win = Math.max(0.3, s.lineWidth), sm = new Float32Array(n);
    let i0 = 0;
    while (i0 < n) {
      if (segs[i0].kind === 'travel') { i0++; continue; }
      let i1 = i0; while (i1 + 1 < n && segs[i1 + 1].kind !== 'travel') i1++;
      for (let i = i0; i <= i1; i++) {
        let wsum = len[i], rsum = ratio[i] * len[i], back = len[i] / 2, fwd = len[i] / 2;
        for (let j = i - 1; j >= i0 && back < win / 2; j--) { const w = Math.min(len[j], win / 2 - back); wsum += w; rsum += ratio[j] * w; back += len[j]; }
        for (let j = i + 1; j <= i1 && fwd < win / 2; j++) { const w = Math.min(len[j], win / 2 - fwd); wsum += w; rsum += ratio[j] * w; fwd += len[j]; }
        sm[i] = wsum > 0 ? rsum / wsum : ratio[i];
      }
      i0 = i1 + 1;
    }
    blobs = 0; thin = 0; minRatio = 9; maxRatio = 0;
    for (let i = 0; i < n; i++) {
      if (segs[i].kind === 'travel') continue;
      const k = ratio[i] > 0 ? sm[i] / ratio[i] : 1;
      ratio[i] = sm[i]; width[i] *= k;
      let f = defects[i] & ~(DEFECT.blob | DEFECT.thin);
      if (sm[i] > 1.3) { f |= DEFECT.blob; blobs++; } else if (sm[i] < 0.75) { f |= DEFECT.thin; thin++; }
      defects[i] = f; minRatio = Math.min(minRatio, sm[i]); maxRatio = Math.max(maxRatio, sm[i]);
    }
  }
  return { vexit, width, height, droop, speed, ratio, defects, stats: { seconds, blobs, thin, sag: sagN, starve, minRatio: minRatio === 9 ? 1 : minRatio, maxRatio, maxDroop } };
}

/**
 * Flow compensation: simulate, then scale each extrusion move's E by planned/deposited so slow corners
 * (where motion meets relief) stop blobbing and rushed stretches stop thinning. A few damped passes,
 * because changing E changes the melt pressure that follows. Rewrites the G-code in place.
 */
export function compensate(res: GenResult, s: SliceSettings, ph0: Physics): PrintSim {
  const segs = res.segs, lines = res.gcode.split('\n');
  const fa = Math.PI * (s.filamentDia / 2) ** 2;
  // Restart blobs: prime less after each retraction by the ooze volume (shorter un-retract), as slicers do.
  const deprime = s.evenFlow !== false && s.retract > 0 ? Math.min(s.retract * 0.9, ph0.ooze / fa) : 0;
  if (deprime > 0) for (const g of segs) if (g.kind === 'travel' && g.ret && g.gl != null) lines[g.gl] = `G1 E${(Math.round((s.retract - deprime) * 1000) / 1000).toString()} F2400 ; primed less by the restart ooze`;
  const ph: Physics = { ...ph0, ooze: Math.max(0, ph0.ooze - deprime * fa) };
  const nominal = segs.map((g) => g.e);
  const base = simulate(res, s, ph);                  // gives the planned speed and time of every move
  const lag = Math.max(1e-4, ph.lag);
  // Exact inverse of the melt-pressure model in simulate(): choose the commanded flow Qc of each move so the
  // average delivered flow equals the planned flow Qd (pressure advance). Q is the nozzle flow at the move's start.
  // Pressure advance (as printer firmware does it): the nozzle flow lags the commanded flow by `lag`, so
  // command Q + lag·dQ/dt. Over one move that is the planned filament plus lag × (planned flow at its end −
  // planned flow at the end of the move before), in filament mm. It sums to zero over a line, so the total
  // filament stays the same; it just moves plastic away from slow-downs (blobs) to speed-ups (thin spots).
  const n = segs.length;
  let Qprev = 0;
  for (let i = 0; i < n; i++) {
    const g = segs[i], d = Math.hypot(g.x - g.x0, g.y - g.y0, g.z - g.z0);
    if (g.kind === 'travel') { Qprev = g.ret ? 0 : Qprev * Math.exp(-(d / Math.max(1, base.speed[i])) / lag); continue; }
    if (!(d > 0) || !(nominal[i] > 0)) continue;
    const A = (nominal[i] * fa) / d;                 // planned bead area
    const Qend = A * base.vexit[i];
    let extra = (lag * 0.9 * (Qend - Qprev)) / fa;   // 0.9: the per-move model slightly overshoots at hard stops
    if (extra > 0 && s.evenThin === false) extra = 0;
    if (extra < 0 && s.evenFlow === false) extra = 0;
    g.e = nominal[i] + extra;
    Qprev = Qend;
  }
  let total = 0;
  for (let i = 0; i < segs.length; i++) {
    const g = segs[i]; if (g.kind === 'travel') continue;
    total += g.e;
    if (g.gl != null && g.e !== nominal[i]) lines[g.gl] = lines[g.gl].replace(/ E[-0-9.]+/, ` E${(Math.round(g.e * 1e5) / 1e5).toString()}`);
  }
  res.gcode = lines.join('\n');
  res.stats.filamentMm = total; res.stats.grams = (total * Math.PI * (s.filamentDia / 2) ** 2) / 1000 * 1.24;
  res.plan = nominal;
  const finalSim = simulate(res, s, ph, nominal);
  return finalSim;
}
