// #34 Topological band-gap infill: a honeycomb frame whose cells each hold a local resonator (a solid
// disc on three spiral ligaments). The resonance f_r = (1/2π)√(3E w³ / (m_r L³)) of a disc of mass m_r on
// three fixed–guided ligaments of length L opens a band gap from about f_r to f_r√(1 + m_r/m_frame);
// the ligament length is chosen so the gap is centred (geometrically) on the target frequency. The
// band structure of the designed lattice is then computed by Bloch–Floquet analysis and its Chern
// number reported (0: a passive, time-reversal-symmetric lattice is never Chern-topological). With the
// valley-Hall option the A/B corners carry unequal pads, gapping the Dirac cone at K with valley Chern
// numbers ±½, and the pads swap across the middle of the part: a valley-Hall edge channel.
import { clipLines, pointIn, SCALE } from '../../clipper';
import type { Paths } from '../../types';
import { bandEdges, chern, resonantHoneycomb, valleyChern, type Lattice } from '../bloch';
import type { InfillPath, SessionCtx, TechModule } from '../session';
import { coreRegion } from './quasicrystal';

const E = 3.5e9, RHO = 1240; // PLA, SI

export interface BandDesign { a: number; R: number; L: number; arcs: number; fr: number; gap: [number, number] | null; chern: number; valley?: number; target: number; inGap: boolean }

/** Cell side a (mm), disc radius R and ligament length L for a target frequency (Hz) and line width (mm). */
export function designBandGap(target: number, width: number, valley: boolean, maxCell = 40): BandDesign | null {
  const w = width * 1e-3;
  for (let a = 4; a <= maxCell; a += 0.5) {
    const rin = (a * Math.sqrt(3)) / 2, R = 0.45 * rin;
    const rMean = (R + rin) / 2;
    const mR = RHO * Math.PI * (R * 1e-3) ** 2, mF = RHO * 3 * (a * 1e-3) * w;
    const fr = target / (1 + mR / mF) ** 0.25;
    const om = 2 * Math.PI * fr;
    const L = Math.cbrt((3 * E * w ** 3) / (mR * om * om)) * 1e3; // mm
    const avail = 2 * Math.PI * 0.9 * rMean;
    if (L < 6 * width || L > avail || rin - R < 3 * width) continue;
    const dPad = valley ? 0.15 : 0;
    const lat: Lattice = resonantHoneycomb({ a, frameK: (E * w) / (a * 1e-3), mA: (mF / 2) * (1 + dPad), mB: (mF / 2) * (1 - dPad), mR, kR: (3 * E * w ** 3) / (L * 1e-3) ** 3 });
    const e = bandEdges(lat, 16);
    const g = e.gaps.find((x) => x.lo <= target && x.hi >= target) ?? e.gaps[0];
    const c = g ? chern(lat, g.below, 12).chern : 0;
    let v: number | undefined;
    if (valley) {
      const frame: Lattice = { a1: lat.a1, a2: lat.a2, m: [lat.m[0], lat.m[1]], springs: lat.springs.filter((s) => s.i < 2 && s.j < 2) };
      v = valleyChern(frame, 1, 36);
    }
    return { a, R, L, arcs: L / rMean, fr, gap: g ? [g.lo, g.hi] : null, chern: Math.round(c * 1000) / 1000, valley: v, target, inGap: !!g && g.lo <= target && g.hi >= target };
  }
  return null;
}

const circle = (cx: number, cy: number, r: number, n = 24) => { const p: number[] = []; for (let k = 0; k <= n; k++) { const t = (k / n) * 2 * Math.PI; p.push(cx + r * Math.cos(t), cy + r * Math.sin(t)); } return p; };
const toPath = (l: number[]) => { const p = []; for (let k = 0; k < l.length; k += 2) p.push({ X: Math.round(l[k] * SCALE), Y: Math.round(l[k + 1] * SCALE) }); return p; };

export const bandGap: TechModule = {
  id: 'band_gap',
  infill(s: SessionCtx, o, region, c, last) {
    const r = s.report('band_gap');
    const valley = s.param('band_gap', 'valley') === true;
    const d = s.memo(`bg:${c.width}`, () => designBandGap(s.pnum('band_gap', 'freq'), c.width, valley));
    if (!d) { r.status = 'idle'; r.reason = `No resonator cell up to 40 mm reaches ${s.pnum('band_gap', 'freq')} Hz with ${c.width.toFixed(2)} mm lines.`; return undefined; }
    const used = last ? region : coreRegion(s, o, region, c.z - c.h / 2);
    if (!used.length) return undefined;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of used) for (const q of p) { minX = Math.min(minX, q.X / SCALE); maxX = Math.max(maxX, q.X / SCALE); minY = Math.min(minY, q.Y / SCALE); maxY = Math.max(maxY, q.Y / SCALE); }
    const a = d.a, s3 = Math.sqrt(3), rin = (a * s3) / 2;
    const ribs: Paths = [], extra: number[][] = [], closed: number[][] = [];
    const inside = (x: number, y: number) => pointIn(x, y, used);
    const midX = (minX + maxX) / 2;
    let resonators = 0;
    for (let j = Math.floor((minY - a) / (1.5 * a)); j * 1.5 * a <= maxY + a; j++) for (let i = Math.floor((minX - a * s3) / (a * s3)) - 1; ; i++) {
      const cx = i * a * s3 + (j % 2 ? (a * s3) / 2 : 0), cy = j * 1.5 * a;
      if (cx > maxX + a * s3) break;
      const V = Array.from({ length: 6 }, (_, k) => [cx + a * Math.cos(((30 + 60 * k) * Math.PI) / 180), cy + a * Math.sin(((30 + 60 * k) * Math.PI) / 180)]);
      for (let k = 0; k < 3; k++) ribs.push(toPath([V[k][0], V[k][1], V[k + 1][0], V[k + 1][1]]));
      if (!inside(cx, cy) || !V.every(([x, y]) => inside(x, y))) continue;
      resonators++;
      // the disc: concentric rings
      for (let rr = c.width / 2; rr <= d.R - c.width / 2 + 1e-6; rr += c.width) closed.push(circle(cx, cy, rr, Math.max(8, Math.ceil((2 * Math.PI * rr) / 0.8))));
      // three spiral ligaments from the rim to the frame
      for (let q = 0; q < 3; q++) {
        const p0 = (q * 2 * Math.PI) / 3 + Math.PI / 6, sp: number[] = [];
        const n = Math.max(8, Math.ceil(d.L / 0.6));
        for (let k = 0; k <= n; k++) { const t = k / n, ph = p0 + t * d.arcs, rr = d.R + t * (rin - c.width / 2 - d.R); sp.push(cx + rr * Math.cos(ph), cy + rr * Math.sin(ph)); }
        extra.push(sp);
      }
      // valley-Hall pads on the A corners (swapped to the B corners past the middle: the edge channel)
      if (valley) for (let k = cx < midX ? 0 : 1; k < 6; k += 2) closed.push(circle(V[k][0], V[k][1], c.width, 10));
    }
    const out: InfillPath[] = [];
    for (const p of clipLines(ribs, used)) out.push({ pts: p.flatMap((q) => [q.X / SCALE, q.Y / SCALE]), closed: false, width: c.width });
    for (const p of clipLines(extra.map(toPath), used)) out.push({ pts: p.flatMap((q) => [q.X / SCALE, q.Y / SCALE]), closed: false, width: c.width });
    for (const l of closed) out.push({ pts: l.slice(0, -2), closed: true, width: c.width });
    r.stats = {
      target_Hz: d.target, cell_mm: d.a, disc_mm: +d.R.toFixed(2), ligament_mm: +d.L.toFixed(1), resonance_Hz: Math.round(d.fr),
      gap_Hz: d.gap ? `${Math.round(d.gap[0])}–${Math.round(d.gap[1])}` : 'none', target_in_gap: d.inGap ? 'yes' : 'no', chern: d.chern,
      ...(d.valley !== undefined ? { valley_chern: +d.valley.toFixed(2) } : {}), resonators: (Number(r.stats?.resonators) || 0) + resonators,
    };
    return { paths: out, used };
  },
};
