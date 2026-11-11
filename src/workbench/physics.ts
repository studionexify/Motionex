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
  'bbl-a1': { accel: 10000, scv: 9, hotendFlow: 28 }, 'bbl-a1mini': { accel: 10000, scv: 9, hotendFlow: 28 },
  'bbl-p1s': { accel: 10000, scv: 9, hotendFlow: 30 }, 'bbl-h2d': { accel: 12000, scv: 9, hotendFlow: 40 },
  ender3v3: { accel: 8000, scv: 6, hotendFlow: 24 }, k1max: { accel: 8000, scv: 6, hotendFlow: 30 }, k2plus: { accel: 10000, scv: 6, hotendFlow: 32 },
  mk4: { accel: 4000, scv: 6, hotendFlow: 20 }, coreone: { accel: 5000, scv: 6, hotendFlow: 25 },
  neptune4pro: { accel: 5000, scv: 5, hotendFlow: 22 }, kobra3: { accel: 8000, scv: 6, hotendFlow: 24 },
};
export const DEFAULT_PHYSICS: Physics = { accel: 5000, scv: 5, lag: 0.035, hotendFlow: 20, sag: 1, ooze: 0.25 };
export const physicsFor = (printer: string): Physics => ({ ...DEFAULT_PHYSICS, ...PHYSICS_BY_PRINTER[printer] });

export const DEFECT = { blob: 1, thin: 2, sag: 4, starve: 8 } as const;

export interface PrintSim {
  /** Per segment (same index as result.segs): actual bead width, height, droop, average speed, deposited/nominal ratio, defect bits. */
  width: Float32Array; height: Float32Array; droop: Float32Array; speed: Float32Array; ratio: Float32Array; defects: Uint8Array;
  stats: { seconds: number; blobs: number; thin: number; sag: number; starve: number; minRatio: number; maxRatio: number; maxDroop: number };
}

const BUCKETS = 2048;

export function simulate(res: GenResult, s: SliceSettings, ph: Physics): PrintSim {
  const segs = res.segs, n = segs.length;
  const width = new Float32Array(n), height = new Float32Array(n), droop = new Float32Array(n), speed = new Float32Array(n), ratio = new Float32Array(n), defects = new Uint8Array(n);
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
    speed[i] = vavg;
    if (g.kind === 'travel') {
      if (g.ret) { Q = 0; oozeLeft = ph.ooze; } else Q *= Math.exp(-t / Math.max(1e-3, lag || 1e-3));
      continue;
    }
    // commanded flow and lagged nozzle flow
    const Anom = d > 0 ? (g.e * fa) / d : g.w * g.h;
    const Qcmd = Anom * vavg;
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
  return { width, height, droop, speed, ratio, defects, stats: { seconds, blobs, thin, sag: sagN, starve, minRatio: minRatio === 9 ? 1 : minRatio, maxRatio, maxDroop } };
}

/**
 * Flow compensation: simulate, then scale each extrusion move's E by planned/deposited so slow corners
 * (where motion meets relief) stop blobbing and rushed stretches stop thinning. A few damped passes,
 * because changing E changes the melt pressure that follows. Rewrites the G-code in place.
 */
export function compensate(res: GenResult, s: SliceSettings, ph: Physics): PrintSim {
  const segs = res.segs, lines = res.gcode.split('\n');
  const nominal = segs.map((g) => g.e);
  const base = simulate(res, s, ph);                  // gives the planned speed and time of every move
  const lag = Math.max(1e-4, ph.lag);
  // Exact inverse of the melt-pressure model in simulate(): choose the commanded flow Qc of each move so the
  // average delivered flow equals the planned flow Qd (pressure advance). Q is the nozzle flow at the move's start.
  let Q = 0;
  for (let i = 0; i < segs.length; i++) {
    const g = segs[i], d = Math.hypot(g.x - g.x0, g.y - g.y0, g.z - g.z0), v = base.speed[i], t = v > 0 ? d / v : 0;
    if (g.kind === 'travel') { if (g.ret) Q = 0; else Q *= Math.exp(-t / lag); continue; }
    if (!(t > 0) || !(nominal[i] > 0)) continue;
    const Qd = (nominal[i] / t) * (Math.PI * (s.filamentDia / 2) ** 2);   // planned mm³/s
    const a = Math.exp(-t / lag), bq = (lag / t) * (1 - a);
    let Qc = bq < 0.999 ? (Qd - Q * bq) / (1 - bq) : Qd;
    Qc = Math.min(Qd * 3, Math.max(0, Qc));
    g.e = nominal[i] * (Qc / Qd);
    Q = Qc + (Q - Qc) * a;
  }
  // final judgement against the plan
  let total = 0;
  for (let i = 0; i < segs.length; i++) {
    const g = segs[i]; if (g.kind === 'travel') continue;
    total += g.e;
    if (g.gl != null && g.e !== nominal[i]) lines[g.gl] = lines[g.gl].replace(/ E[-0-9.]+/, ` E${(Math.round(g.e * 1e5) / 1e5).toString()}`);
  }
  res.gcode = lines.join('\n');
  res.stats.filamentMm = total + 0; res.stats.grams = (total * Math.PI * (s.filamentDia / 2) ** 2) / 1000 * 1.24;
  // a fresh simulation on the compensated moves, scored against the original plan
  const finalSim = simulate(res, s, ph);
  let blobs = 0, thin = 0, mn = 9, mx = 0;
  for (let i = 0; i < segs.length; i++) {
    if (segs[i].kind === 'travel' || !(nominal[i] > 0)) continue;
    const r = finalSim.ratio[i] * (segs[i].e / nominal[i]);
    finalSim.ratio[i] = r;
    let f = finalSim.defects[i] & ~(DEFECT.blob | DEFECT.thin);
    if (r > 1.3) { f |= DEFECT.blob; blobs++; } else if (r < 0.75) { f |= DEFECT.thin; thin++; }
    finalSim.defects[i] = f; mn = Math.min(mn, r); mx = Math.max(mx, r);
    // width shown = what actually lands, against the planned bead
    finalSim.width[i] = Math.max(0.05, (r * nominal[i] * Math.PI * (s.filamentDia / 2) ** 2) / Math.max(1e-6, Math.hypot(segs[i].x - segs[i].x0, segs[i].y - segs[i].y0, segs[i].z - segs[i].z0)) / Math.max(0.01, finalSim.height[i]));
  }
  finalSim.stats.blobs = blobs; finalSim.stats.thin = thin; finalSim.stats.minRatio = mn === 9 ? 1 : mn; finalSim.stats.maxRatio = mx;
  return finalSim;
}
