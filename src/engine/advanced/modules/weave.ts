// #7 Sinusoidal Z-weaving & Z-pinning and #19 topological knot braiding: interlocking between layers
// and between neighbouring walls.
import type { Op } from '../classic/gcode';
import { moveLike, rescaleE, type Move } from '../runs';
import type { TechModule, WallLoop } from '../session';
import type { PartAnalysis } from '../analysis';

const WOVEN = new Set(['inner_wall', 'sparse_infill']);

/** Offset map per 0.5 mm cell: the Z offset of the last bead printed there (0 = flat). */
class OffsetMap {
  readonly c = 0.5; readonly nx: number; readonly a: Float32Array;
  constructor(w: number, d: number) { this.nx = Math.ceil(w / this.c) + 2; this.a = new Float32Array(this.nx * (Math.ceil(d / this.c) + 2)); }
  private k(x: number, y: number) { const i = Math.round(x / this.c), j = Math.round(y / this.c); return i < 0 || j < 0 || i >= this.nx ? -1 : i + this.nx * j; }
  get(x: number, y: number) { const k = this.k(x, y); return k >= 0 && k < this.a.length ? this.a[k] : 0; }
  set(x: number, y: number, v: number) { const k = this.k(x, y); if (k >= 0 && k < this.a.length) this.a[k] = v; }
}

const depthAt = (parts: PartAnalysis[], x: number, y: number, z: number) => {
  let best = -Infinity;
  for (const p of parts) {
    if (x < p.sdf.min[0] || y < p.sdf.min[1] || x > p.sdf.max[0] || y > p.sdf.max[1] || z < p.sdf.min[2] || z > p.sdf.max[2]) continue;
    best = Math.max(best, -p.sdf.sdf.sample(x, y, z));
  }
  return best;
};

export const zWeave: TechModule = {
  id: 'z_weave',
  post(s, layers) {
    const r = s.report('z_weave');
    const A = s.pnum('z_weave', 'amp'), lambda = s.pnum('z_weave', 'wavelength');
    const k = (2 * Math.PI) / lambda;
    const offs = new OffsetMap(s.caps.bed.x + 2, s.caps.bed.y + 2);
    const tops = new Set(['top_surface', 'bottom_surface', 'bridge', 'internal_solid_infill']);
    let woven = 0, slowed = 0;
    // pins: voids through `N` layers in deep cores, filled from the top by a vertical extrusion
    const pins = s.param('z_weave', 'pins') === true;
    const pitch = s.pnum('z_weave', 'pinPitch');
    const rv = 1.2, head = s.caps.toolhead;
    const tanA = Math.tan((head.nozzle.cone_angle_deg * Math.PI) / 180), rTip = head.nozzle.tip_diameter / 2;
    // how deep the tip can enter a void of radius rv before its cone touches the void's rim (0.25 mm map margin)
    const dive = Math.max(0, Math.min((rv - rTip - 0.25) / tanA, head.nozzle.tip_len - head.margin));
    const h0 = s.num('layer_height') || 0.2;
    const N = Math.max(2, Math.min(8, Math.floor(dive / h0) + 1));
    const w = s.num('sparse_infill_line_width') || s.num('line_width') || s.caps.nozzle;
    const shell = (s.num('outer_wall_line_width') || w) + Math.max(0, Math.round(s.num('wall_loops')) - 1) * (s.num('inner_wall_line_width') || w);
    const fd = s.filaments[0]?.diameter ?? 1.75, filA = Math.PI * (fd / 2) ** 2;
    let pinCount = 0;
    const siteCache = new Map<number, [number, number][]>();
    const pinSitesCache = (i: number, make: () => [number, number][]) => { if (!siteCache.has(i)) siteCache.set(i, make()); return siteCache.get(i)!; };
    const pinSites = (z: number) => {
      const out: [number, number][] = [];
      if (!pins) return out;
      for (const p of s.parts) for (let x = Math.ceil(p.sdf.min[0] / pitch) * pitch; x <= p.sdf.max[0]; x += pitch) for (let y = Math.ceil(p.sdf.min[1] / pitch) * pitch; y <= p.sdf.max[1]; y += pitch) {
        // the void must sit in the core for the whole stack
        let ok = true;
        for (let q = 0; q < N && ok; q++) ok = depthAt(s.parts, x, y, z - q * h0) > shell + 2 * w + rv;
        if (ok) out.push([x, y]);
      }
      return out;
    };
    layers.forEach((L, li) => {
      if (li < 3 || s.helicalLayers.has(li)) {
        for (const op of L.ops) if (op.k === 'move' && !op.travel && op.e > 0) offs.set(op.x, op.y, 0);
        return;
      }
      const sign = li % 2 ? 1 : -1;
      const amp = A * L.h;
      // Z axis limits: |dz/dt| = amp·k·v·√2 ≤ vz and amp·k²·v²·2 ≤ az
      const vMax = Math.min(s.caps.maxSpeedZ / (amp * k * Math.SQRT2), Math.sqrt(s.caps.maxAccelZ / (2 * amp * k * k)));
      // stack top for pins: this layer closes a stack of N layers
      const stackTop = pins && (li - 3) % N === N - 1;
      const stackIdx = Math.floor((li - 3) / N);
      const sites = pins ? pinSitesCache(stackIdx, () => pinSites(layers[Math.min(layers.length - 1, 3 + stackIdx * N + N - 1)].z)) : [];
      const out: Op[] = [];
      let px = NaN, py = NaN, pz = NaN;
      for (const op of L.ops) {
        if (op.k === 'raw' && op.resetPos) { px = NaN; py = NaN; }
        if (op.k !== 'move') { out.push(op); continue; }
        if (op.travel || op.e <= 0 || Number.isNaN(px)) { px = op.x; py = op.y; pz = op.z; out.push(op); continue; }
        if (!WOVEN.has(op.feature)) {
          if (tops.has(op.feature) || op.feature === 'outer_wall') offs.set(op.x, op.y, 0);
          px = op.x; py = op.y; pz = op.z; out.push(op); continue;
        }
        const len = Math.hypot(op.x - px, op.y - py);
        const dens = op.e / Math.max(Math.hypot(len, op.z - (Number.isNaN(pz) ? op.z : pz)), 1e-9); // E per mm of the incoming bead's true 3-D length
        const n = Math.max(1, Math.ceil(len / (lambda / 8)));
        let lx = px, ly = py; // end of the previous piece
        const inVoid = (x: number, y: number) => sites.some(([sx, sy]) => (sx - x) ** 2 + (sy - y) ** 2 < (rv + w / 2) ** 2);
        for (let q = 1; q <= n; q++) {
          const t = q / n, x = px + (op.x - px) * t, y = py + (op.y - py) * t;
          // pins: no infill inside the void circles of this stack. A piece is a bead from the previous piece's end to
          // its own end, so both ends must be outside the void - otherwise the bead would start inside it.
          const bx = lx, by = ly;
          lx = x; ly = y;
          if (op.feature === 'sparse_infill' && sites.length && (inVoid(x, y) || inVoid(bx, by))) {
            out.push({ ...op, x, y, e: 0, travel: true, feature: 'travel', t: undefined });
            continue;
          }
          // egg-crate pattern of XY, sign flipping every layer: beads of neighbouring layers interlock
          const off = sign * amp * Math.sin(k * x) * Math.sin(k * y);
          const below = offs.get(x, y);
          const height = Math.max(0.3 * L.h, L.h + off - below);
          offs.set(x, y, off);
          // volumetric conservation: the bead follows the sloped segment, so E scales with its true 3-D length
          const seg3 = Math.hypot(len / n, op.z + off - (Number.isNaN(pz) ? op.z : pz));
          // ...and the bead's declared height is the real local height (layer + off - below), so the preview and E agree
          const m = moveLike(op, x, y, op.z + off, rescaleE(dens * seg3, op.w, op.h, height), { h: height });
          pz = op.z + off;
          if (m.f > vMax) { m.f = vMax; slowed++; }
          out.push(m);
          woven++;
        }
        px = op.x; py = op.y; pz = op.z + (sign * amp * Math.sin(k * op.x) * Math.sin(k * op.y));
      }
      if (stackTop && sites.length) {
        // fill each void: dive into it, extrude while rising to the layer top
        const vol = Math.PI * rv * rv * N * L.h;
        const retract = s.num('retraction_length') || 0.8, rs = s.num('retraction_speed') || 30;
        for (const [x, y] of sites) {
          // the layer's real height here (curved layers move it)
          const zl = L.z + (s.warp ? s.warp.dz(x, y, L.z) : 0);
          out.push({ k: 'retract', len: retract, speed: rs });
          out.push({ k: 'move', x, y, z: +(zl + 0.4).toFixed(4), e: 0, f: s.num('travel_speed') || 200, feature: 'travel', w: 0, h: L.h, travel: true });
          out.push({ k: 'move', x, y, z: +(zl - dive).toFixed(4), e: 0, f: 5, feature: 'travel', w: 0, h: L.h, travel: true, fixed: true });
          out.push({ k: 'retract', len: -retract, speed: rs });
          // the column is a volume dump: pi rv^2 over the filled stack, laid down while the tip rises `dive`. Declared as the round
          // bead of that average cross-section so the preview and the E check agree (the plunge itself is judged by the clear-void rule)
          const dBead = 2 * Math.sqrt(vol / (Math.PI * Math.max(dive, 1e-6)));
          const pin: Move = { k: 'move', x, y, z: +zl.toFixed(4), e: (vol / filA) * (s.filaments[0]?.flowRatio || 1), f: Math.max(0.5, Math.min(2, (s.caps.maxFlow * 0.3) / (Math.PI * rv * rv))), feature: 'sparse_infill', w: dBead, h: dBead * 0.9999, travel: false, fixed: true, noArc: true };
          out.push(pin);
          out.push({ k: 'raw', text: 'G4 P300 ; let the pin settle', time: 0.3 });
          pinCount++;
        }
      }
      L.ops = out;
    });
    if (!woven) { r.status = 'idle'; r.reason = 'No inner walls or sparse infill to weave.'; return; }
    s.nonPlanar = true;
    r.stats = { woven_points: woven, slowed_for_z_axis: slowed, z_pins: pinCount, pin_stack_layers: N, pin_dive_mm: +dive.toFixed(2) };
  },
};

// ---------------- #19 braiding

function resample(pts: number[], step: number): number[] {
  const n = pts.length / 2;
  let L = 0;
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; L += Math.hypot(pts[j * 2] - pts[i * 2], pts[j * 2 + 1] - pts[i * 2 + 1]); }
  const m = Math.max(12, Math.round(L / step));
  const out: number[] = [];
  let seg = 0, s0 = 0, segL = Math.hypot(pts[2] - pts[0], pts[3] - pts[1]);
  for (let k = 0; k < m; k++) {
    const t = (k / m) * L;
    while (s0 + segL < t && seg < n - 1) { s0 += segL; seg++; const j = (seg + 1) % n; segL = Math.hypot(pts[j * 2] - pts[seg * 2], pts[j * 2 + 1] - pts[seg * 2 + 1]); }
    const j = (seg + 1) % n, u = segL > 0 ? (t - s0) / segL : 0;
    out.push(pts[seg * 2] + (pts[j * 2] - pts[seg * 2]) * u, pts[seg * 2 + 1] + (pts[j * 2 + 1] - pts[seg * 2 + 1]) * u);
  }
  return out;
}

export const knotBraiding: TechModule = {
  id: 'knot_braiding',
  wallsPost(s, _o, layer, _ex, rings) {
    if (rings.length < 3 || layer < 2 || rings[1].length !== rings[2].length || !rings[1].length) return;
    const r = s.report('knot_braiding');
    const pitch = s.pnum('knot_braiding', 'pitch'), lift = s.pnum('knot_braiding', 'lift');
    const h = s.num('layer_height') || 0.2;
    const seq = String(s.cfg.wall_sequence ?? 'inner_outer');
    // the strand printed second goes over at each crossing; rings print inner-first unless outer_inner
    const secondSlot = seq === 'outer_inner' ? 2 : 1;
    const out1: WallLoop[] = [], out2: WallLoop[] = [];
    for (const a of rings[1]) {
      // pair with the nearest ring-2 loop
      let best = rings[2][0], bd = Infinity;
      for (const b of rings[2]) { const d = (b.pts[0] - a.pts[0]) ** 2 + (b.pts[1] - a.pts[1]) ** 2; if (d < bd) { bd = d; best = b; } }
      const spacing = Math.max(0.2, Math.sqrt(bd) > 2 ? a.width : Math.sqrt(bd));
      const P = resample(a.pts, 0.3);
      const n = P.length / 2;
      let L = 0;
      const sAt: number[] = [0];
      for (let i = 1; i <= n; i++) { L += Math.hypot(P[(i % n) * 2] - P[(i - 1) * 2], P[(i % n) * 2 + 1] - P[(i - 1) * 2 + 1]); sAt.push(L); }
      const periods = Math.max(2, Math.round(L / pitch));
      const om = (2 * Math.PI * periods) / L;
      // counter-clockwise outer rings: the part's inside is on the left
      let area = 0;
      for (let i = 0; i < n; i++) { const j = (i + 1) % n; area += P[i * 2] * P[j * 2 + 1] - P[j * 2] * P[i * 2 + 1]; }
      const left = area > 0 ? 1 : -1;
      const A: number[] = [], B: number[] = [], zA: number[] = [], zB: number[] = [];
      // the over-crossing bump must not climb steeper than the head clearance allows: widen it, and if that is not
      // enough (th would exceed the whole crossing), lower it. Max slope = liftH * om / th <= tanCap.
      const tanCap = Math.tan((Math.min(s.caps.maxSlopeDeg, 80) * Math.PI) / 180) * 0.95;
      let liftH = lift * h, th = 0.35;
      th = Math.max(th, (liftH * om) / tanCap);
      if (th > 1) { th = 1; liftH = tanCap / om; }
      for (let i = 0; i < n; i++) {
        const i0 = (i - 1 + n) % n, i1 = (i + 1) % n;
        const tx = P[i1 * 2] - P[i0 * 2], ty = P[i1 * 2 + 1] - P[i0 * 2 + 1], tl = Math.hypot(tx, ty) || 1;
        const nx = (-ty / tl) * left, ny = (tx / tl) * left; // inward
        const mx = P[i * 2] + nx * spacing / 2, my = P[i * 2 + 1] + ny * spacing / 2;
        const c = Math.cos(om * sAt[i]);
        // strand A starts on ring 1, strand B on ring 2; they swap sides through each crossing
        A.push(mx - nx * (spacing / 2) * c, my - ny * (spacing / 2) * c);
        B.push(mx + nx * (spacing / 2) * c, my + ny * (spacing / 2) * c);
        const bump = Math.max(0, 1 - Math.abs(c) / th);
        zA.push(bump * liftH); zB.push(bump * liftH);
      }
      // alternate which strand fills which slot every layer: a strand over on layer n is under on n+1
      const swap = layer % 2 === 1;
      const s1 = swap ? B : A, s2 = swap ? A : B;
      out1.push({ ...a, pts: s1, ...(secondSlot === 1 ? { zs: zA } : {}) });
      out2.push({ ...best, pts: s2, ...(secondSlot === 2 ? { zs: zB } : {}) });
    }
    rings[1] = out1; rings[2] = out2;
    if (!r.stats || !('braided_loops' in r.stats)) r.stats = { braided_loops: 0 };
    r.stats.braided_loops = (r.stats.braided_loops as number) + out1.length;
    s.nonPlanar = true;
  },
};
