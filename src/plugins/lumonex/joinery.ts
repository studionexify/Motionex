// Lumonex joinery: how two stacked pieces lock together. Every joint is a male spigot that rises
// from the top of the lower piece and a female socket at the bottom of the upper piece, both
// described as radius functions r(θ, z) (z = mm from the joint face), plus negative volumes for
// cross holes, slots, nut traps and magnet pockets, and loose extra parts (pins, rings).
import { BOLTS, MAGNETS } from './catalog';
import { angDist, box, clamp, cylinder, fract, merge, polarRing, prism, rotateZ, smooth, strut, tau, tri, tubeShell, type Ring, type Soup } from './geom';

export type JointKind =
  | 'thread' | 'bayonet' | 'cam' | 'snap-ring' | 'snap-fingers' | 'crush-ribs' | 'taper' | 'hex' | 'square'
  | 'spline' | 'key' | 'detent' | 'collet' | 'magnet' | 'bolt' | 'pin' | 'insert' | 'press' | 'dovetail-key' | 'butt-glue';

export const JOINTS: { id: JointKind; name: string; lock: 'mechanical' | 'friction' | 'fastener' | 'permanent'; note: string }[] = [
  { id: 'thread', name: 'Screw thread', lock: 'mechanical', note: 'Trapezoid thread; screw the pieces together. Strongest tool-free joint.' },
  { id: 'bayonet', name: 'Bayonet twist-lock', lock: 'mechanical', note: 'Three pins, L-slots, 30° turn to lock.' },
  { id: 'cam', name: 'Quarter-turn cam lock', lock: 'mechanical', note: 'Helical ramp pulls the joint tight over a 90° turn.' },
  { id: 'snap-ring', name: 'Annular snap ring', lock: 'mechanical', note: 'Barb clicks into a groove; push to assemble.' },
  { id: 'snap-fingers', name: 'Cantilever snap fingers', lock: 'mechanical', note: 'Slotted spigot with barbs; squeeze to release.' },
  { id: 'crush-ribs', name: 'Press-fit with crush ribs', lock: 'friction', note: 'Ribs deform for a tight, repeatable press fit.' },
  { id: 'taper', name: 'Morse-style taper', lock: 'friction', note: 'Self-holding 3° taper; tap to seat.' },
  { id: 'hex', name: 'Hex spigot (anti-rotation)', lock: 'friction', note: 'Hexagon keeps parts aligned and stops spinning.' },
  { id: 'square', name: 'Square spigot (indexed)', lock: 'friction', note: 'Four positions; good for faceted shades.' },
  { id: 'spline', name: 'Splined spigot', lock: 'friction', note: '12-tooth spline: many indexed positions, no rotation.' },
  { id: 'key', name: 'Keyed spigot', lock: 'friction', note: 'Single key: assembles one way only (pattern alignment).' },
  { id: 'detent', name: 'Ball-detent click', lock: 'mechanical', note: 'Bumps snap into dimples; audible click.' },
  { id: 'collet', name: 'Split collet (self-clamping)', lock: 'friction', note: 'Slotted, flared spigot squeezed by a tapered socket.' },
  { id: 'magnet', name: 'Magnetic (neodymium pockets)', lock: 'mechanical', note: 'Press-in disc magnets in both faces; detachable.' },
  { id: 'bolt', name: 'Through-bolt + nut trap', lock: 'fastener', note: 'Metric bolt across the joint, hex nut captured.' },
  { id: 'pin', name: 'Cross pin (printed)', lock: 'fastener', note: 'Printed pin through both parts; no hardware.' },
  { id: 'insert', name: 'Heat-set insert + screw', lock: 'fastener', note: 'Brass inserts in the spigot, screws through the socket.' },
  { id: 'dovetail-key', name: 'Dovetail keys (twin)', lock: 'friction', note: 'Two keys with an undercut-free dovetail face; slides and stays aligned.' },
  { id: 'press', name: 'Plain press-fit', lock: 'friction', note: 'Straight spigot with small interference.' },
  { id: 'butt-glue', name: 'Glue socket', lock: 'permanent', note: 'Loose slip fit with glue grooves for CA / epoxy.' },
];

export interface JointSpec {
  kind: JointKind;
  /** Engagement length (mm). */
  length: number;
  /** Radial fit clearance (mm). */
  clearance: number;
  /** Thread pitch / bayonet pin size etc. */
  pitch: number;
  /** Count of pins, keys, magnets, fingers, inserts. */
  count: number;
  bolt: keyof typeof BOLTS;
  magnet: number;
}

export const defaultJoint = (p: Partial<JointSpec> = {}): JointSpec => ({ kind: 'thread', length: 14, clearance: 0.25, pitch: 3, count: 3, bolt: 'M4', magnet: 1, ...p });

export interface JointGeometry {
  /** Male outer radius at angle a, height z above the joint face (0..length). */
  male(a: number, z: number): number;
  /** Female socket radius at angle a, depth z from the socket mouth (0..length). */
  female(a: number, z: number): number;
  /** Negative volumes in the lower piece (joint face at z = 0). */
  maleCuts: Soup[];
  /** Negative volumes in the upper piece (socket mouth at z = 0). */
  femaleCuts: Soup[];
  /** Separate printed parts (laid flat for printing), with names. */
  extras: { name: string; soup: Soup }[];
  /** Spigot length (may be shorter than the socket for clearance). */
  maleLength: number;
  notes: string[];
}

const thr = (x: number) => clamp(tri(x) * 1.7 - 0.35, 0, 1);

/**
 * Joint radii for a spigot of nominal radius rc with a bore of rb. `outer` is the smallest outer
 * radius of the pieces at the joint (room for magnets, nut traps).
 */
export function jointGeometry(j: JointSpec, rc: number, rb: number, outer: number): JointGeometry {
  const L = Math.max(4, j.length), c = j.clearance, P = Math.max(1.2, j.pitch), n = Math.max(1, Math.round(j.count));
  const cuts = { m: [] as Soup[], f: [] as Soup[] };
  const extras: { name: string; soup: Soup }[] = [];
  const notes: string[] = [];
  const tip = (z: number) => smooth(L - 1.2, L, z); // lead-in chamfer on the spigot
  let male = (_a: number, z: number) => rc - 0.6 * tip(z);
  let female = (_a: number, _z: number) => rc + c;
  let maleLength = L - 0.4;
  const pinW = Math.max(3, P * 1.4), pinH = Math.max(1.2, Math.min(2.2, (outer - rc) * 0.5));
  switch (j.kind) {
    case 'thread': {
      const d = 0.6 * P;
      male = (a, z) => rc - d + d * thr(z / P - a / tau) * (1 - tip(z)) - 0.2 * tip(z);
      female = (a, z) => rc - d + d * thr(z / P - a / tau) + c;
      notes.push(`Thread ${(rc * 2).toFixed(1)} × ${P} mm, ${(L / P).toFixed(1)} turns.`);
      break;
    }
    case 'bayonet': case 'cam': {
      const zp = L * 0.6, turn = j.kind === 'cam' ? Math.PI / 2 : Math.PI / 6, ww = pinW / rc, ramp = j.kind === 'cam' ? Math.min(3, L * 0.25) : 0;
      const ang = (i: number) => (i / n) * tau;
      male = (a, z) => {
        let r = rc - 0.4 * tip(z);
        for (let i = 0; i < n; i++) if (angDist(a, ang(i)) < ww / 2 && Math.abs(z - zp) < pinW / 2) r = Math.max(r, rc + pinH * smooth(pinW / 2, pinW / 2 - 0.6, Math.abs(z - zp)));
        return r;
      };
      female = (a, z) => {
        let r = rc + c;
        for (let i = 0; i < n; i++) {
          const da = fract((a - ang(i)) / tau) * tau; // angle past the entry
          const entry = angDist(a, ang(i)) < ww / 2 + 0.03 && z <= zp + ramp + pinW / 2 + c;
          const zc = zp + ramp * (1 - Math.min(1, da / turn));
          const slot = da <= turn + ww / 2 && Math.abs(z - zc) < pinW / 2 + c;
          if (entry || slot) r = rc + pinH + c + 0.2;
        }
        return r;
      };
      notes.push(`${n} pins, turn ${Math.round((turn * 180) / Math.PI)}° to lock.`);
      break;
    }
    case 'snap-ring': case 'snap-fingers': {
      const zb = L * 0.55, h = Math.min(1.2, (outer - rc) * 0.4), ramp = 2;
      const barb = (z: number) => (z >= zb && z <= zb + ramp ? h * (1 - (z - zb) / ramp) : 0);
      male = (_a, z) => rc + barb(z) - 0.5 * tip(z);
      female = (_a, z) => rc + c + (z >= zb - 0.3 && z <= zb + ramp + 0.3 ? h + 0.15 : 0) + (z < zb ? h * smooth(zb, 0, z) * 0 : 0);
      if (j.kind === 'snap-fingers') {
        // the female mouth gets a lead-in ramp so fingers flex in; slots make the fingers
        female = (_a, z) => rc + c + (z < 2 ? h * (1 - z / 2) + 0.2 : 0) + (z >= zb - 0.3 && z <= zb + ramp + 0.3 ? h + 0.15 : 0);
        for (let i = 0; i < Math.max(2, n); i++) cuts.m.push(rotateZ(box(rb - 1, -0.9, L * 0.25, rc + h + 1, 0.9, L + 1), (i * 360) / Math.max(2, n)));
        notes.push(`${Math.max(2, n)} fingers; squeeze to release.`);
      } else {
        // a closed ring needs a lead-in on the female so the barb can pass
        female = (_a, z) => rc + c + (z < zb ? h * 0.6 * (1 - z / zb) + 0.1 : 0) + (z >= zb - 0.3 && z <= zb + ramp + 0.3 ? h + 0.15 : 0);
        notes.push('Use PETG or PLA+ for the snap ring; brittle PLA may crack.');
      }
      break;
    }
    case 'crush-ribs': {
      const ribs = Math.max(6, n * 2);
      female = (a, _z) => rc + c + 0.15 - 0.45 * smooth(0.6, 1, Math.cos(a * ribs) * 0.5 + 0.5);
      break;
    }
    case 'taper': {
      const k = Math.tan((1.5 * Math.PI) / 180);
      male = (_a, z) => rc - z * k - 0.3 * tip(z);
      female = (_a, z) => rc - z * k + c * 0.4;
      break;
    }
    case 'hex': case 'square': {
      const s = j.kind === 'hex' ? 6 : 4, seg = tau / s;
      const poly = (a: number) => Math.cos(Math.PI / s) / Math.cos(fract(a / seg) * seg - Math.PI / s);
      male = (a, z) => (rc - 0.5 * tip(z)) * poly(a);
      female = (a, _z) => (rc + c / Math.cos(Math.PI / s)) * poly(a);
      break;
    }
    case 'spline': {
      const teeth = Math.max(8, n * 4), d = 1;
      const sq = (a: number) => smooth(0.4, 0.6, tri((a * teeth) / tau));
      male = (a, z) => rc - d + d * sq(a) - 0.4 * tip(z);
      female = (a, _z) => rc - d + d * smooth(0.3, 0.5, tri((a * teeth) / tau)) + c;
      break;
    }
    case 'key': case 'dovetail-key': {
      const keys = j.kind === 'key' ? 1 : 2, kw = 4 / rc, kh = Math.min(1.8, (outer - rc) * 0.5);
      const keyAt = (a: number, extra: number, z: number) => {
        for (let i = 0; i < keys; i++) {
          const d = angDist(a, (i / keys) * tau);
          // dovetail: key widens towards its outer face
          const w = j.kind === 'dovetail-key' ? kw / 2 + extra : kw / 2 + extra;
          if (d < w) return j.kind === 'dovetail-key' ? kh * smooth(w, w * 0.6, d) : kh;
        }
        return 0;
        void z;
      };
      male = (a, z) => rc + keyAt(a, 0, z) - 0.4 * tip(z);
      female = (a, z) => rc + c + (keyAt(a, c / rc + 0.02, z) ? kh + c : 0);
      break;
    }
    case 'detent': {
      const zb = L * 0.5, br = 1.6, bh = Math.min(0.8, (outer - rc) * 0.3), bumps = Math.max(3, n);
      const bump = (a: number, z: number, grow: number) => {
        let v = 0;
        for (let i = 0; i < bumps; i++) {
          const dx = angDist(a, (i / bumps) * tau) * rc, d = Math.hypot(dx, z - zb);
          if (d < br + grow) v = Math.max(v, (bh + grow * 0.5) * Math.sqrt(Math.max(0, 1 - (d / (br + grow)) ** 2)));
        }
        return v;
      };
      male = (a, z) => rc + bump(a, z, 0) - 0.4 * tip(z);
      female = (a, z) => rc + c + bump(a, z, 0.25) + (z < zb ? bh * 0.5 * (1 - z / zb) : 0);
      break;
    }
    case 'collet': {
      male = (_a, z) => rc + 0.5 * smooth(L * 0.5, L, z) - 0.3 * tip(z);
      female = (_a, z) => rc + c + 0.6 - 0.6 * smooth(0, L, z);
      for (let i = 0; i < Math.max(3, n); i++) cuts.m.push(rotateZ(box(rb - 1, -0.75, L * 0.3, rc + 2, 0.75, L + 1), (i * 360) / Math.max(3, n)));
      break;
    }
    case 'magnet': {
      const mg = MAGNETS[clamp(Math.round(j.magnet), 0, MAGNETS.length - 1)];
      const ring = (rc + outer) / 2;
      maleLength = Math.min(L, 6);
      male = (_a, z) => rc - 0.4 * smooth(maleLength - 1, maleLength, z);
      if (outer - rc < mg.d + 1.6) notes.push(`Wall too thin for ${mg.name} magnets: widen the piece or pick a smaller magnet.`);
      for (let i = 0; i < Math.max(2, n); i++) {
        const a = (i / Math.max(2, n)) * tau + Math.PI / Math.max(2, n), x = ring * Math.cos(a), y = ring * Math.sin(a);
        cuts.m.push(cylinder(mg.d / 2 + 0.1, -mg.h - 0.2, 0.01, 24, x, y));
        cuts.f.push(cylinder(mg.d / 2 + 0.1, -0.01, mg.h + 0.2, 24, x, y));
      }
      notes.push(`${Math.max(2, n)} × ${mg.name} mm magnets per face — check polarity before gluing.`);
      break;
    }
    case 'bolt': case 'pin': case 'insert': {
      const b = BOLTS[j.bolt] ?? BOLTS.M4, zc = L * 0.5;
      if (j.kind === 'insert') {
        for (const sgn of [1, -1]) {
          cuts.m.push(strut([sgn * (rc + 0.5), 0, zc], [sgn * (rc - b.insertL), 0, zc], b.insert / 2, 20));
          cuts.f.push(strut([sgn * (outer + 1), 0, zc], [sgn * (rc - 0.5), 0, zc], b.hole / 2, 20));
          cuts.f.push(strut([sgn * (outer + 1), 0, zc], [sgn * (outer - 1.2), 0, zc], b.hole + 0.6, 20));
        }
        notes.push(`2 × ${j.bolt} heat-set inserts (Ø${b.insert} × ${b.insertL}) + ${j.bolt} × 8 screws.`);
      } else {
        const hole = j.kind === 'pin' ? Math.max(3, b.hole + 0.6) : b.hole;
        cuts.m.push(strut([-(outer + 2), 0, zc], [outer + 2, 0, zc], hole / 2, 24));
        cuts.f.push(strut([-(outer + 2), 0, zc], [outer + 2, 0, zc], hole / 2, 24));
        if (j.kind === 'bolt') {
          const af = b.nutAF + 0.3, hx: [number, number][] = Array.from({ length: 6 }, (_, i) => { const a = (i / 6) * tau; return [(af / Math.sqrt(3)) * Math.cos(a), (af / Math.sqrt(3)) * Math.sin(a)]; });
          // nut trap on +X, opening outward, axis along X
          const trap = prism(hx, 0, b.nutH + 0.4);
          for (let i = 0; i < trap.length; i += 3) { const x = trap[i], y = trap[i + 1], z = trap[i + 2]; trap[i] = outer - b.nutH - 0.2 + z; trap[i + 1] = y; trap[i + 2] = zc + x; }
          // rotation above turned the prism inside out (axis swap is a reflection): fix winding
          for (let i = 0; i < trap.length; i += 9) for (let k = 0; k < 3; k++) { const t = trap[i + 3 + k]; trap[i + 3 + k] = trap[i + 6 + k]; trap[i + 6 + k] = t; }
          cuts.f.push(trap);
          cuts.f.push(strut([-(outer + 1), 0, zc], [-(outer - 2.5), 0, zc], b.hole + 1.6, 24));
          notes.push(`${j.bolt} × ${Math.ceil((outer * 2 + 4) / 5) * 5} bolt + nut.`);
        } else {
          const len = outer * 2 + 2;
          extras.push({ name: 'Cross pin', soup: merge(cylinder(hole / 2 - 0.15, 0, len - 1, 24), cylinder(hole / 2 - 0.8, len - 1, len, 24), cylinder(hole / 2 + 1.2, -2, 0, 24)) });
          notes.push('Print the cross pin standing; tap it through with a drop of glue.');
        }
      }
      break;
    }
    case 'press': {
      female = (_a, _z) => rc - 0.05;
      break;
    }
    case 'butt-glue': {
      female = (_a, z) => rc + c + 0.15 + (fract(z / 3) > 0.7 ? 0.4 : 0);
      male = (_a, z) => rc - (fract(z / 3) > 0.7 ? 0.4 : 0) - 0.4 * tip(z);
      notes.push('Glue grooves hold adhesive; permanent joint.');
      break;
    }
  }
  return { male, female, maleCuts: cuts.m, femaleCuts: cuts.f, extras, maleLength, notes };
}

/** Rings of a spigot rising from z0 (joint face) with bore rb. */
export function spigotShell(g: JointGeometry, rb: number, z0: number, around: number, below = 0.6): Soup {
  const L = g.maleLength, outer: Ring[] = [], inner: Ring[] = [];
  const zs: number[] = [-below];
  const steps = Math.max(1, Math.ceil(L / 0.3));
  for (let k = 0; k <= steps; k++) zs.push((L * k) / steps);
  for (const z of zs) {
    const zz = Math.max(0, Math.min(L, z));
    outer.push(polarRing(around, z0 + z, (a) => Math.max(rb + 0.6, g.male(a, zz))));
    inner.push(polarRing(around, z0 + z, () => rb - 0.05));
  }
  return tubeShell(outer, inner);
}

/** Clearance check used by tests and the report: female always clears male. */
export function minFit(g: JointGeometry, samples = 72): number {
  let m = Infinity;
  for (let i = 0; i < samples; i++) for (let z = 0.2; z < g.maleLength - 1.5; z += 0.5) {
    const a = (i / samples) * tau;
    m = Math.min(m, g.female(a, z) - g.male(a, z));
  }
  return m;
}

export const jointByKind = (k: JointKind) => JOINTS.find((x) => x.id === k) ?? JOINTS[0];
