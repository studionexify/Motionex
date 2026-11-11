// Flenex creature builder: a body lofted along a curved spine (lying flat on the bed, belly down) plus
// add-ons, unioned into one solid. The same station list gives the automatic cuts.
import * as THREE from 'three';
import type { IndexedMesh } from '../../engine/mesh';
import { box, free, loft, meshOf, solid, unionAll, type V3 } from './csg';
import { blade, clamp, cone, ellipsoid, lerp, smooth, tube } from './forms';
import { handleAt } from '../lumonex/shape';
import { newCut, type Cut } from './flexi';
import type { AddOn, BodySpec, CreatureDesign, SegmentSpec } from './design';
import type { JointSpec } from './joints';

export interface Station {
  /** Point on the spine at bed level. */
  P: THREE.Vector3;
  /** Tangent (head → tail) and side axis. */
  T: THREE.Vector3;
  S: THREE.Vector3;
  /** Half width, half height of the section, and the top height above the bed. */
  w: number;
  h: number;
  top: number;
  t: number;
  s: number;
}

export interface Mark { kind: string; at: V3; r: number }

/** A flexible limb (tentacle / arm): its centre line and radius, so it can be cut into segments too. */
export interface Chain { name: string; points: V3[]; radii: number[] }

export interface CreatureResult {
  mesh: IndexedMesh;
  stations: Station[];
  marks: Mark[];
  chains: Chain[];
  length: number;
  warnings: string[];
}

const Z = new THREE.Vector3(0, 0, 1);

// ---------------------------------------------------------------- spine
function headingAt(b: BodySpec['spine'], u: number): number {
  const a = (b.bend * Math.PI) / 180, ph = b.phase;
  switch (b.kind) {
    case 'straight': return 0;
    case 'wave': return a * Math.cos(2 * Math.PI * b.waves * u + ph) * (0.35 + 0.65 * Math.sin(Math.PI * Math.min(1, u * 1.2)));
    case 's-curve': return a * Math.cos(2 * Math.PI * u + ph);
    case 'double-wave': return a * Math.cos(4 * Math.PI * u + ph) * 0.8 + a * 0.3 * Math.cos(2 * Math.PI * u);
    case 'arch': return a * Math.cos(Math.PI * u + ph);
    case 'c-curve': return a * (u - 0.5) * 2;
    case 'hook': { const k = Math.max(0, (u - 0.55) / 0.45); return a * 1.6 * k * k; }
    case 'zigzag': return a * Math.tanh(3 * Math.sin(2 * Math.PI * b.waves * u + ph));
    case 'spiral': return b.waves * 2 * Math.PI * Math.pow(u, 1.35);
    case 'question': return a * 2.2 * Math.pow(Math.max(0, u - 0.25) / 0.75, 1.6) - a * 0.2 * Math.sin(Math.PI * u);
  }
}

/** Spine points (head at the right, tail to the left) at uniform arc length. */
function sampleSpine(spec: BodySpec, n: number): { pts: THREE.Vector3[]; tans: THREE.Vector3[] } {
  const dense = 1200, raw: [number, number][] = [[0, 0]];
  let x = 0, y = 0, th0 = headingAt(spec.spine, 0);
  for (let i = 1; i <= dense; i++) {
    const th = headingAt(spec.spine, i / dense) - th0 * 0; // heading is absolute
    x += Math.cos(th) / dense; y += Math.sin(th) / dense;
    raw.push([x, y]);
  }
  const cum = [0];
  for (let i = 1; i < raw.length; i++) cum.push(cum[i - 1] + Math.hypot(raw[i][0] - raw[i - 1][0], raw[i][1] - raw[i - 1][1]));
  const total = cum[cum.length - 1], k = spec.length / total;
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= n; i++) {
    const target = (i / n) * total;
    let j = 1; while (j < cum.length - 1 && cum[j] < target) j++;
    const f = (target - cum[j - 1]) / Math.max(1e-9, cum[j] - cum[j - 1]);
    pts.push(new THREE.Vector3(lerp(raw[j - 1][0], raw[j][0], f) * k, lerp(raw[j - 1][1], raw[j][1], f) * k, 0));
  }
  // head → tail is the order of the points; orient so the head is at +x by mirroring in x when needed
  const tans = pts.map((p, i) => pts[Math.min(n, i + 1)].clone().sub(pts[Math.max(0, i - 1)]).normalize());
  return { pts, tans };
}

// ---------------------------------------------------------------- section
function ringPoint(kind: BodySpec['section']['kind'], power: number, sides: number, phi: number): [number, number] {
  const c = Math.cos(phi), s = Math.sin(phi);
  const sp = (p: number): [number, number] => [Math.sign(c) * Math.pow(Math.abs(c), 2 / p), Math.sign(s) * Math.pow(Math.abs(s), 2 / p)];
  switch (kind) {
    case 'round': return sp(power);
    case 'squircle': return sp(3.6);
    case 'rounded-box': return sp(6);
    case 'diamond': return sp(1.15);
    case 'lens': { const [x, y] = sp(2); return [Math.sign(x) * Math.pow(Math.abs(x), 1.6), y]; }
    case 'teardrop': { const [x, y] = sp(2); return [x * (0.72 + 0.28 * (1 - y) / 2 * 1.4), y]; }
    case 'star': { const k = Math.max(3, sides); const m = 1 + 0.16 * Math.cos(k * phi); return [c * m, s * m]; }
    case 'hexagon': {
      const n = 6, seg = (Math.PI * 2) / n, a = ((phi % seg) + seg) % seg - seg / 2;
      const r = Math.cos(seg / 2) / Math.cos(a);
      return [c * r * 0.98, s * r * 0.98];
    }
  }
}

function relief(b: BodySpec, phi: number, s: number, t: number): number {
  const r = b.relief;
  if (r.kind === 'none' || t < r.from || t > r.to) return 1;
  const edge = smooth(clamp(Math.min(t - r.from, r.to - t) / 0.05, 0, 1));
  const per = Math.max(2, r.period), d = r.depth * edge;
  const wrap = (x: number) => x - Math.floor(x);
  switch (r.kind) {
    case 'ribs': return 1 + d * 0.5 * Math.cos(12 * phi);
    case 'rings': return 1 + d * (0.5 + 0.5 * Math.cos((2 * Math.PI * s) / per));
    case 'scales': { const rows = Math.floor(s / per), u = (((phi / (Math.PI * 2)) * 10 + (rows % 2) * 0.5) % 1 + 1) % 1, v = wrap(s / per); return 1 + d * 0.9 * Math.pow(Math.sin(Math.PI * u), 1.5) * Math.pow(Math.sin(Math.PI * v), 0.8); }
    case 'dorsal-ridge': { const da = Math.atan2(Math.sin(phi - Math.PI / 2), Math.cos(phi - Math.PI / 2)); return 1 + d * 1.6 * Math.exp(-(da * da) / 0.05); }
    case 'faceted': return 1 - d * 0.5 * Math.abs(Math.sin(3 * phi));
    case 'twist-ribs': return 1 + d * 0.5 * Math.cos(6 * phi + (2 * Math.PI * s) / (per * 4));
    case 'bumps': return 1 + d * Math.max(0, Math.cos(5 * phi) * Math.cos((2 * Math.PI * s) / per));
    case 'belly-plates': { const down = Math.exp(-Math.pow(Math.atan2(Math.sin(phi + Math.PI / 2), Math.cos(phi + Math.PI / 2)), 2) / 0.35); return 1 + d * 0.9 * down * wrap(s / per) ** 0.6; }
    case 'saw-edge': { const side = Math.abs(Math.cos(phi)); return 1 + d * Math.pow(side, 6) * (wrap(s / per) < 0.5 ? wrap(s / per) * 2 : 2 - wrap(s / per) * 2); }
    case 'spine-rows': { const da = Math.atan2(Math.sin(phi - Math.PI / 2), Math.cos(phi - Math.PI / 2)); return 1 + d * 2 * Math.exp(-(da * da) / 0.03) * Math.max(0, Math.cos((2 * Math.PI * s) / per)) ** 2; }
  }
}

function endTaper(spec: BodySpec, s: number): number {
  const cap = Math.max(1, spec.thickness * Math.max(0.15, spec.endRound));
  const f = (d: number) => (d >= cap ? 1 : Math.sqrt(Math.max(0, 1 - (1 - d / cap) ** 2)));
  return Math.max(0.04, Math.min(f(s), f(spec.length - s)));
}

// ---------------------------------------------------------------- body
export function bodyStations(spec: BodySpec, step = 2): Station[] {
  const n = Math.max(60, Math.min(300, Math.round(spec.length / step)));
  const { pts, tans } = sampleSpine(spec, n);
  const out: Station[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, s = t * spec.length;
    const m = handleAt(spec.profile, t) * endTaper(spec, s);
    const w = spec.thickness * m, h = spec.thickness * spec.heightRatio * m;
    const T = tans[i], S = new THREE.Vector3().crossVectors(Z, T).normalize();
    const zb = h * (1 - spec.section.flat);
    out.push({ P: pts[i], T, S, w, h, top: h + zb, t, s });
  }
  return out;
}

const NRING = 40;
function bodyMesh(spec: BodySpec, st: Station[]): IndexedMesh {
  const rings: V3[][] = st.map((f) => {
    const zb = f.h * (1 - spec.section.flat);
    return Array.from({ length: NRING }, (_, j) => {
      const phi = (j / NRING) * Math.PI * 2;
      const [cx, cy] = ringPoint(spec.section.kind, spec.section.power, spec.section.sides, phi);
      const k = relief(spec, phi, f.s, f.t);
      const x = cx * f.w * k, zz = Math.max(cy * f.h * k, -zb) + zb;
      const p = f.P.clone().addScaledVector(f.S, x); p.z = zz;
      return [p.x, p.y, p.z] as V3;
    });
  });
  return loft(rings);
}

/** Interpolated frame at body position t. */
export function stationAt(st: Station[], t: number): Station {
  const x = clamp(t, 0, 1) * (st.length - 1), i = Math.min(st.length - 2, Math.floor(x)), f = x - i, a = st[i], b = st[i + 1];
  const T = a.T.clone().lerp(b.T, f).normalize();
  return { P: a.P.clone().lerp(b.P, f), T, S: new THREE.Vector3().crossVectors(Z, T).normalize(), w: lerp(a.w, b.w, f), h: lerp(a.h, b.h, f), top: lerp(a.top, b.top, f), t: lerp(a.t, b.t, f), s: lerp(a.s, b.s, f) };
}

/** World point: along the tangent a, across s, height z above the bed. */
const W = (f: Station, a: number, s: number, z: number): V3 => {
  const p = f.P.clone().addScaledVector(f.T, a).addScaledVector(f.S, s); return [p.x, p.y, z];
};
const wv = (p: V3) => new THREE.Vector3(p[0], p[1], p[2]);
const f_ = (T: THREE.Vector3) => T.clone().setZ(0).normalize();

// ---------------------------------------------------------------- add-ons
interface Ctx { st: Station[]; spec: BodySpec; marks: Mark[]; chains: Chain[]; warn(m: string): void }


function build(a: AddOn, c: Ctx): IndexedMesh[] {
  // head parts sit at the very front, where the body is still rounding off: size them from just behind the tip
  const f0 = stationAt(c.st, a.t), ref = stationAt(c.st, Math.max(a.t, 0.09));
  const front = a.kind === 'snout' || a.kind === 'jaw' || a.kind === 'beak' || a.kind === 'nostrils' || a.kind === 'cheeks';
  const f: Station = a.t < 0.09 ? (front ? ref : { ...f0, w: ref.w, h: ref.h, top: ref.top }) : f0;
  const out: IndexedMesh[] = [];
  const r = (f.w + f.h) / 2, sz = a.size;
  const Hn = f.top;
  switch (a.kind) {
    case 'eyes': {
      const re = Math.max(1.6, 0.3 * Math.min(f.w, f.h) * sz * 1.3);
      for (const sg of [1, -1]) {
        const ang = (a.spread + 0.3) * 0.5; // outward angle
        const ctr = W(f, 0, sg * f.w * (0.72 + 0.1 * a.length * (a.length > 1.5 ? 1 : 0)), Hn * 0.62);
        if (a.length > 1.5) {
          const root = W(f, 0, sg * f.w * 0.3, Hn * 0.85), tip = W(f, 0, sg * f.w * (0.55 + 0.15 * a.length), Hn * (0.8 + 0.25 * a.length));
          out.push(tube([root, tip], [re * 0.55, re * 0.5]), ellipsoid(tip, [re, re, re]));
          c.marks.push({ kind: 'eye', at: tip, r: re });
        } else {
          out.push(ellipsoid(ctr, [re * 0.9, re * 0.8, re], 18));
          c.marks.push({ kind: 'eye', at: ctr, r: re });
        }
        void ang;
      }
      break;
    }
    case 'horns': {
      for (const sg of [1, -1]) {
        const root = W(f, 0, sg * f.w * (0.45 + 0.1 * a.spread), Hn * 0.9);
        const tl = (a.tilt * Math.PI) / 180, L = Math.max(4, 2.2 * r * sz * a.length), n = 12;
        let d = new THREE.Vector3().addScaledVector(f.T, Math.sin(tl)).addScaledVector(f.S, sg * 0.3).addScaledVector(Z, Math.cos(tl)).normalize();
        const path: V3[] = [root], radii: number[] = [Math.max(1.4, 0.34 * r * sz)];
        let p = wv(root);
        const axis = f.S.clone().multiplyScalar(-sg).cross(Z).length() ? f.S.clone() : Z.clone();
        for (let i = 1; i <= n; i++) {
          p = p.clone().addScaledVector(d, L / n);
          d = d.clone().applyAxisAngle(axis, (a.curl * 1.5 * Math.PI) / n * 0.5).normalize();
          path.push([p.x, p.y, p.z]); radii.push(Math.max(0.35, radii[0] * (1 - i / n) ** 0.9));
        }
        out.push(tube(path, radii, 12));
        c.marks.push({ kind: 'horn', at: path[path.length - 1], r: radii[0] });
      }
      break;
    }
    case 'ears': {
      for (const sg of [1, -1]) {
        const wd = f.w * 0.5 * sz * a.width, ht = r * 1.1 * sz * a.length;
        const pts: [number, number][] = [[-wd, -1.5], [wd, -1.5], [wd * 0.7, ht * 0.55], [0, ht], [-wd * 0.7, ht * 0.55]];
        const tl = (a.tilt * Math.PI) / 180;
        const ex = f.S.clone().multiplyScalar(sg).applyAxisAngle(f.T, 0);
        const ey = Z.clone().multiplyScalar(Math.cos(tl)).addScaledVector(f.S, sg * Math.sin(tl));
        const root = W(f, 0, sg * f.w * 0.55, Hn * 0.8);
        out.push(blade(pts, Math.max(2, 0.12 * r), root, [ex.x, ex.y, ex.z], [ey.x, ey.y, ey.z]));
        c.marks.push({ kind: 'ear', at: W(f, 0, sg * f.w * 0.6, Hn * 0.8 + ht * 0.6), r: wd });
      }
      break;
    }
    case 'spikes': {
      const n = Math.max(1, Math.round(a.count));
      for (let i = 0; i < n; i++) {
        const g = stationAt(c.st, a.t + (n > 1 ? (a.spread * i) / (n - 1) : 0));
        const base = Math.max(1.3, 0.2 * (g.w + g.h) / 2 * sz), L = Math.max(3, 0.65 * (g.w + g.h) / 2 * sz * a.length);
        const dirs = a.side === 'top' ? [[0, 1]] : a.side === 'sides' ? [[1, 0], [-1, 0]] : [[0, -1]];
        for (const [sx, sz2] of dirs) {
          const root = sz2 === 1 ? W(g, 0, 0, g.top * 0.82) : sz2 === -1 ? W(g, 0, 0, 0.5) : W(g, 0, sx * g.w * 0.85, g.top * 0.5);
          const tip = sz2 === 1 ? W(g, g.T.length() * 0, 0, g.top + L) : sz2 === -1 ? W(g, 0, 0, -L * 0.2 + 0.5) : W(g, 0, sx * (g.w + L), g.top * 0.5);
          out.push(cone(root, tip, base, 0.25, 10));
        }
      }
      break;
    }
    case 'sail': case 'mane': case 'plates': {
      const t0 = a.t, t1 = clamp(a.t + a.spread, a.t + 0.02, 1);
      if (a.kind === 'plates') {
        const n = Math.max(1, Math.round(a.count));
        for (let i = 0; i < n; i++) {
          const g = stationAt(c.st, t0 + (n > 1 ? ((t1 - t0) * i) / (n - 1) : 0));
          const wd = Math.max(3, ((t1 - t0) * c.spec.length) / Math.max(1, n) * 0.38), ht = Math.max(4, 0.9 * (g.w + g.h) / 2 * a.size * a.length) * (0.7 + 0.3 * Math.sin(Math.PI * i / Math.max(1, n - 1)));
          const pts: [number, number][] = Array.from({ length: 10 }, (_, k) => { const u = (k / 9) * Math.PI; return [Math.cos(u) * wd, Math.sin(u) * ht] as [number, number]; });
          out.push(blade(pts, Math.max(2, 0.14 * (g.w + g.h) / 2), W(g, 0, 0, g.top * 0.8), [g.T.x, g.T.y, 0], [0, 0, 1]));
        }
        break;
      }
      const m = 28, rings: V3[][] = [], thick = Math.max(2, 0.12 * r);
      for (let i = 0; i <= m; i++) {
        const u = i / m, g = stationAt(c.st, lerp(t0, t1, u));
        const env = a.kind === 'sail' ? Math.pow(Math.sin(Math.PI * u), 0.7) : Math.pow(Math.sin(Math.PI * Math.min(1, u * 0.5 + 0.5)), 0.8);
        const sc = a.kind === 'sail' ? (0.6 + 0.4 * Math.abs(Math.cos(Math.PI * a.count * u))) : 1;
        const hh = Math.max(0.1, (a.kind === 'sail' ? 1.5 : 1.0) * (g.w + g.h) / 2 * a.size * a.length * env * (a.kind === 'sail' ? sc : 0.55 + 0.45 * Math.cos(Math.PI * u * a.count) ** 2));
        const z0 = g.top * 0.7, th = a.kind === 'sail' ? thick : thick * 1.4;
        const p = (s: number, z: number): V3 => W(g, 0, s, z);
        rings.push([p(-th / 2, z0), p(th / 2, z0), p(th / 2, g.top + hh), p(-th / 2, g.top + hh)]);
      }
      out.push(loft(rings));
      break;
    }
    case 'fins': {
      const n = Math.max(1, Math.round(a.count));
      for (let k = 0; k < n; k++) {
        const g = stationAt(c.st, a.t + (n > 1 ? a.spread * k / (n - 1) : 0));
        for (const sg of [1, -1]) {
          const L = 2.4 * (g.w + g.h) / 2 * a.size * a.length, Wd = 1.0 * (g.w + g.h) / 2 * a.size * a.width;
          const top: [number, number][] = [], bot: [number, number][] = [];
          for (let i = 0; i <= 12; i++) { const u = i / 12, hw = Wd * 0.5 * Math.pow(Math.sin(Math.PI * Math.min(1, u * 0.9 + 0.08)), 0.75) * (1 - 0.35 * u); top.push([-2 + (L + 2) * u, hw * 0.6]); bot.push([-2 + (L + 2) * u, -hw * 1.0]); }
          const pts: [number, number][] = [...top, ...bot.reverse()];
          const sweep = (a.tilt * Math.PI) / 180;
          const ex = g.S.clone().multiplyScalar(sg).applyAxisAngle(Z, -sg * sweep), ey = new THREE.Vector3().crossVectors(Z, ex);
          out.push(blade(pts, Math.max(2, 0.1 * (g.w + g.h)), W(g, 0, sg * g.w * 0.75, 1.1 + 0 * a.curl), [ex.x, ex.y, ex.z], [ey.x, ey.y, ey.z]));
        }
      }
      break;
    }
    case 'tailfin': {
      const g = stationAt(c.st, Math.min(a.t, 0.985));
      const L = 3 * g.w * a.size * a.length + 6, Hh = 3.6 * (g.w + g.h) / 2 * a.size * a.width + 4, lun = a.curl;
      // caudal fin: swept leading edges out to two lobes, a notch between them (lun = how deep)
      const dn = L * 0.7 * lun, up: [number, number][] = [];
      for (let i = 0; i <= 10; i++) { const u = i / 10; up.push([-3 + (L + 3) * u, Hh * (0.12 + 0.88 * Math.pow(u, 1.6))]); }
      for (let i = 1; i <= 8; i++) { const u = i / 8; up.push([L - dn * Math.sin((Math.PI / 2) * u) - 0.001 * i, Hh * (1 - u)]); }
      const pts: [number, number][] = [...up, ...up.slice(0, -1).reverse().map(([x, y]) => [x, -y] as [number, number])];
      out.push(blade(pts, Math.max(2, 0.12 * g.w * 2), W(g, 0, 0, g.top * 0.5), [g.T.x, g.T.y, 0], [0, 0, 1]));
      break;
    }
    case 'legs': {
      const n = Math.max(1, Math.round(a.count));
      for (let k = 0; k < n; k++) {
        const g = stationAt(c.st, a.t + (n > 1 ? a.spread * k / (n - 1) : 0));
        const rr = (g.w + g.h) / 2;
        for (const sg of [1, -1]) {
          const sw = (a.tilt * Math.PI) / 180, reach = 1.9 * rr * a.size * a.length, rl = Math.max(2.4, 0.46 * rr * a.size);
          // a sprawling leg seen from above: the thigh goes out and back, the shin turns forward, the foot is flat with toes
          const hip = W(g, 0, sg * g.w * 0.4, g.top * 0.45);
          const knee = W(g, Math.sin(sw) * reach * 0.6, sg * (g.w + reach * 0.5 * a.width), rl * 1.5 + 0.1 * rr * a.size);
          const foot = W(g, -Math.sin(sw) * reach * 0.25, sg * (g.w + reach * 0.95 * a.width), rl * 0.85);
          const seg = (p0: V3, p1: V3, r0: number, r1: number) => {
            const dense: V3[] = [], rad: number[] = [];
            for (let i = 0; i <= 8; i++) { const u = i / 8, q = wv(p0).lerp(wv(p1), u); dense.push([q.x, q.y, Math.max(Math.min(r0, r1), q.z)]); rad.push(r0 + (r1 - r0) * u); }
            return tube(dense, rad, 14);
          };
          out.push(seg(hip, knee, rl * 1.55, rl * 1.15), seg(knee, foot, rl * 1.05, rl * 0.85), ellipsoid(knee, [rl * 1.2, rl * 1.2, rl * 1.2], 14));
          // foot pad and toes fanning forward
          const fdir = new THREE.Vector3().subVectors(wv(foot), wv(knee)).setZ(0);
          const fa = Math.atan2(fdir.y, fdir.x) + (sg > 0 ? 0.0 : 0.0), fwd = new THREE.Vector3(f_(g.T).x * -1, f_(g.T).y * -1, 0);
          void fa;
          out.push(ellipsoid(foot, [rl * 1.7, rl * 1.45, rl * 0.85], 16));
          const toes = a.width > 0 ? 4 : 3;
          for (let i = 0; i < toes; i++) {
            const ang = ((i - (toes - 1) / 2) * 0.42), dir = fwd.clone().applyAxisAngle(Z, ang + (sg > 0 ? 0.2 : -0.2) * 0);
            const t0 = wv(foot).addScaledVector(dir, rl * 0.7), t1 = wv(foot).addScaledVector(dir, rl * 3.1);
            out.push(tube([[t0.x, t0.y, rl * 0.7], [t1.x, t1.y, rl * 0.55]], [rl * 0.55, rl * 0.38], 8), ellipsoid([t1.x, t1.y, rl * 0.55], [rl * 0.42, rl * 0.42, rl * 0.4], 8));
          }
          c.marks.push({ kind: 'foot', at: foot, r: rl * 1.5 });
        }
      }
      break;
    }
    case 'wings': {
      for (const sg of [1, -1]) {
        const Lw = 3.0 * r * a.size * a.length, Wd = 1.9 * r * a.size * a.width, cu = 0.12 + 0.22 * a.curl;
        // bat wing: leading edge out to the first finger, three fingers, scalloped membrane between them
        const tips: [number, number][] = [[Lw, -Wd * 0.5], [Lw * 0.88, Wd * 0.05], [Lw * 0.62, Wd * 0.55], [Lw * 0.3, Wd * 0.95]];
        const pts: [number, number][] = [[0, -Wd * 0.12], tips[0]];
        for (let i = 0; i < tips.length - 1; i++) {
          const p = tips[i], q = tips[i + 1], mx = (p[0] + q[0]) / 2, my = (p[1] + q[1]) / 2;
          pts.push([mx - cu * Lw * 0.5, my + cu * Wd * 0.2], q);
        }
        pts.push([0, Wd * 0.7]);
        const tl = (a.tilt * Math.PI) / 180;
        // outline: x outward, y backward along the body; tilt 0 lies flat on the bed, 90 stands up
        const ex = f.S.clone().multiplyScalar(sg).multiplyScalar(Math.cos(tl)).addScaledVector(Z, Math.sin(tl)).normalize();
        const ey = f.T.clone();
        const zr = lerp(1.2, f.top * 0.78, clamp(a.tilt / 90, 0, 1));
        const root = W(f, 0, sg * f.w * 0.4, zr);
        out.push(blade(pts, Math.max(2, 0.09 * r * a.size), root, [ex.x, ex.y, ex.z], [ey.x, ey.y, ey.z]));
        // arm and fingers: thin ribs along the leading edge and between the tips
        const at = (u: number, v: number) => wv(root).addScaledVector(ex, u).addScaledVector(ey, v);
        const rib = (p: [number, number], q: [number, number], rad: number) => { const A = at(p[0], p[1]), B = at(q[0], q[1]); return tube([[A.x, A.y, A.z], [B.x, B.y, B.z]], [rad, rad * 0.8], 8); };
        const rb = Math.max(1.4, 0.16 * r * a.size);
        out.push(rib([0, -Wd * 0.12], tips[0], rb), rib([Lw * 0.2, -Wd * 0.2], tips[1], rb * 0.8), rib([Lw * 0.15, 0], tips[2], rb * 0.7), rib([Lw * 0.1, Wd * 0.3], tips[3], rb * 0.6));
        const tipw = at(tips[0][0], tips[0][1]);
        c.marks.push({ kind: 'wing', at: [tipw.x, tipw.y, tipw.z], r: Wd * 0.4 });
      }
      break;
    }
    case 'arms': {
      const n = Math.max(1, Math.round(a.count));
      const r0 = Math.max(2, 0.55 * Math.min(f.w, f.h) * a.size);
      for (let i = 0; i < n; i++) {
        const fan = n > 1 ? (i / (n - 1) - 0.5) * a.spread : 0;
        const base = Math.atan2(f.T.y, f.T.x) + ((a.tilt * Math.PI) / 180) + fan * (Math.PI / 180);
        const L = Math.max(10, 0.55 * c.spec.length * a.size * a.length * (0.8 + 0.2 * Math.cos(i * 1.7)));
        const m = 22, path: V3[] = [], rad: number[] = [];
        const lat = n > 1 ? (i / (n - 1) - 0.5) * 2 : 0;
        let x = f.P.x + f.S.x * lat * f.w * 0.75, y = f.P.y + f.S.y * lat * f.w * 0.75, th = base;
        const dir = i % 2 ? 1 : -1;
        for (let j = 0; j <= m; j++) {
          const u = j / m;
          rad.push(Math.max(1.1, r0 * (1 - 0.7 * u ** 0.9)));
          path.push([x, y, rad[j] * 0.98]);
          th += dir * a.curl * 2.2 * u * (Math.PI / m) * 1.0;
          x += (Math.cos(th) * L) / m; y += (Math.sin(th) * L) / m;
        }
        out.push(tube(path, rad, 14));
        c.chains.push({ name: `Arm ${i + 1}`, points: path, radii: rad });
      }
      break;
    }
    case 'snout': {
      const L = 1.6 * r * a.size * a.length;
      const ctr = W(f, -L * 0.55, 0, f.top * 0.42);
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0), f.T.clone().setZ(0).normalize());
      out.push(ellipsoid(ctr, [L * 0.75, f.w * 0.62 * a.width * a.size, f.top * 0.34 * a.size], 22, q));
      c.marks.push({ kind: 'snout', at: W(f, -L * 1.2, 0, f.top * 0.42), r: f.w * 0.3 });
      break;
    }
    case 'jaw': {
      const L = 1.2 * r * a.size * a.length;
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0), f.T.clone().setZ(0).normalize());
      out.push(ellipsoid(W(f, -L * 0.4, 0, f.top * 0.18), [L * 0.8, f.w * 0.5 * a.width * a.size, f.top * 0.2 * a.size], 20, q));
      break;
    }
    case 'beak': {
      const L = 1.5 * r * a.size * a.length, bw = 0.5 * f.w * a.width * a.size;
      out.push(cone(W(f, 0, 0, f.top * 0.58), W(f, -L, 0, f.top * 0.4), bw, 0.5, 16), cone(W(f, 0, 0, f.top * 0.4), W(f, -L * 0.8, 0, f.top * 0.34), bw * 0.8, 0.5, 16));
      c.marks.push({ kind: 'beak', at: W(f, -L * 0.9, 0, f.top * 0.4), r: bw });
      break;
    }
    case 'cheeks': {
      for (const sg of [1, -1]) out.push(ellipsoid(W(f, 0, sg * f.w * 0.85, f.top * 0.4), [f.w * 0.5 * a.size * a.width, f.w * 0.42 * a.size, f.top * 0.3 * a.size], 16));
      break;
    }
    case 'nostrils': {
      for (const sg of [1, -1]) out.push(ellipsoid(W(f, 0, sg * f.w * (0.25 + a.spread * 0.4), f.top * 0.95), [1.5 * a.size, 1.5 * a.size, 1.2 * a.size], 12));
      break;
    }
    case 'knobs': {
      const n = Math.max(1, Math.round(a.count));
      for (let i = 0; i < n; i++) {
        const g = stationAt(c.st, a.t + (n > 1 ? (a.spread * i) / (n - 1) : 0));
        const rk = Math.max(1.3, 0.2 * (g.w + g.h) / 2 * a.size);
        const pos: V3[] = a.side === 'top' ? [W(g, 0, 0, g.top * 0.98)] : a.side === 'belly' ? [W(g, 0, 0, 0.3)] : [W(g, 0, g.w * 0.92, g.top * 0.55), W(g, 0, -g.w * 0.92, g.top * 0.55)];
        for (const p of pos) out.push(ellipsoid(p, [rk, rk, rk], 12));
      }
      break;
    }
    case 'frill': {
      const n = Math.max(3, Math.round(a.count)), span = (Math.max(30, a.spread * 100 > 360 ? 300 : 40 + a.spread * 300) * Math.PI) / 180;
      for (let i = 0; i < n; i++) {
        const ang = -span / 2 + (n > 1 ? (span * i) / (n - 1) : 0); // around the neck from the left, over the top, to the right
        const dir = new THREE.Vector3().addScaledVector(f.S, Math.sin(ang)).addScaledVector(Z, Math.cos(ang)).addScaledVector(f.T, 0.6).normalize();
        const root = W(f, 0, Math.sin(ang) * f.w * 0.75, Math.max(2, f.top * 0.5 + Math.cos(ang) * f.h * 0.7));
        const L = r * 1.5 * a.size * a.length, p1 = wv(root).addScaledVector(dir, L);
        const pts: V3[] = [root, [p1.x, p1.y, Math.max(1.5, p1.z)]];
        out.push(tube(pts, [Math.max(1.5, 0.28 * r * a.size), 0.5], 10));
      }
      break;
    }
    case 'gills': {
      const n = Math.max(1, Math.round(a.count));
      for (const sg of [1, -1]) for (let i = 0; i < n; i++) {
        const lift = (i - (n - 1) / 2) * 0.55;
        const root = W(f, 0, sg * f.w * 0.78, f.top * (0.55 + 0.2 * lift));
        const L = r * 1.6 * a.size * a.length;
        const m = 8, path: V3[] = [], rad: number[] = [];
        for (let j = 0; j <= m; j++) { const u = j / m; const p = wv(root).addScaledVector(f.S, sg * L * u * 0.8).addScaledVector(f.T, L * u * 0.5 + a.curl * L * 0.15 * Math.sin(u * 3)).addScaledVector(Z, lift * L * 0.55 * u + 0.3 * L * u * u); path.push([p.x, p.y, Math.max(1, p.z)]); rad.push(Math.max(0.5, 0.2 * r * a.size * (1 - 0.7 * u))); }
        out.push(tube(path, rad, 8));
      }
      break;
    }
    case 'shell': {
      const t1 = clamp(a.t + a.spread, a.t + 0.05, 1), mid = stationAt(c.st, (a.t + t1) / 2), L = (t1 - a.t) * c.spec.length;
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0), mid.T.clone().setZ(0).normalize());
      out.push(ellipsoid(W(mid, 0, 0, 0), [L * 0.52 * a.length, mid.w * 1.28 * a.size * a.width, mid.top * 1.05 * a.size], 28, q));
      break;
    }
    case 'club': {
      const g = stationAt(c.st, 0.97), rk = Math.max(3, 1.5 * g.w * a.size + 2);
      out.push(ellipsoid(W(g, 0, 0, rk * 0.9), [rk * 1.1, rk, rk * 0.9], 18));
      break;
    }
    case 'tailspike': {
      const g = stationAt(c.st, 0.985);
      out.push(cone(W(g, -2, 0, g.top * 0.5), W(g, 8 * a.size * a.length + 6, 0, g.top * 0.5), Math.max(2, g.w * 0.9), 0.4, 14));
      break;
    }
    case 'antennae': {
      for (const sg of [1, -1]) {
        const root = W(f, 0, sg * f.w * 0.35, Hn * 0.9), L = 3 * r * a.size * a.length, tl = (a.tilt * Math.PI) / 180;
        const m = 8, path: V3[] = [], rad: number[] = [];
        for (let j = 0; j <= m; j++) { const u = j / m; const p = wv(root).addScaledVector(f.T, -Math.sin(tl) * L * u * 0.5).addScaledVector(f.S, sg * L * u * 0.35).addScaledVector(Z, Math.cos(tl) * L * u - a.curl * L * 0.3 * u * u); path.push([p.x, p.y, p.z]); rad.push(Math.max(0.9, 0.12 * r * a.size)); }
        out.push(tube(path, rad, 8), ellipsoid(path[m], [1.8 * a.size + 0.6, 1.8 * a.size + 0.6, 1.8 * a.size + 0.6], 12));
      }
      break;
    }
  }
  return out;
}

// ---------------------------------------------------------------- the whole creature
export function buildCreature(design: CreatureDesign): CreatureResult {
  const spec = design.body, st = bodyStations(spec);
  const warnings: string[] = [];
  const marks: Mark[] = [];
  const chains: Chain[] = [];
  const ctx: Ctx = { st, spec, marks, chains, warn: (m) => warnings.push(m) };
  const parts: IndexedMesh[] = [bodyMesh(spec, st)];
  for (const a of design.addons) {
    try { parts.push(...build(a, ctx)); } catch (e) { warnings.push(`${a.kind}: ${(e as Error).message}`); }
  }
  const solids = parts.map((p) => solid(p));
  const all = unionAll(solids);
  const bed = box(2000, 2000, 400);
  // keep everything above the bed (z ≥ 0)
  const keep = solid({ vertices: bed.vertices.map((v, i) => (i % 3 === 2 ? v + 200 : v)), indices: bed.indices });
  const trimmed = all.intersect(keep);
  const mesh = meshOf(trimmed);
  free(all, keep, trimmed, ...solids);
  // narrowest part of a bend: warn when the body would fold over itself
  return { mesh, stations: st, marks, chains, length: spec.length, warnings };
}

// ---------------------------------------------------------------- cuts along the body
/** Parts that ride along on the body and are cut with it (sail, spikes, plates, mane...): how far they stand off the body at body position t. */
function followerReach(design: CreatureDesign, st: Station[], t: number): number {
  let h = 0;
  for (const a of design.addons) {
    if (!['sail', 'spikes', 'plates', 'mane', 'knobs'].includes(a.kind)) continue;
    const t1 = a.t + (a.kind === 'knobs' || a.kind === 'spikes' || a.kind === 'plates' || a.kind === 'mane' || a.kind === 'sail' ? a.spread : 0);
    if (t < a.t - 0.02 || t > t1 + 0.02) continue;
    const f = stationAt(st, t), r = (f.w + f.h) / 2;
    h = Math.max(h, a.kind === 'sail' ? 1.5 * r * a.size * a.length : a.kind === 'spikes' ? 0.65 * r * a.size * a.length : a.kind === 'plates' ? 0.9 * r * a.size * a.length : a.kind === 'mane' ? r * a.size * a.length : 0.25 * r * a.size);
  }
  return h;
}

/** Radius of the kerf disc for a cut at body position t: the body's section plus the parts that ride along. */
export function cutRadius(design: CreatureDesign, st: Station[], t: number): number {
  const f = stationAt(st, t);
  return Math.max(Math.max(f.w, f.top / 2) * 1.12, f.top / 2 + followerReach(design, st, t)) * 1.05 + 1.5;
}

/** Stretches of the body (arc length, mm) a cut must not cross: parts stuck on the body that must stay on one piece. */
export function keepOut(design: CreatureDesign, st: Station[]): [number, number][] {
  const out: [number, number][] = [];
  const L = design.body.length;
  // the kerf widens away from the spine, so a part that reaches far sideways needs a wider berth
  const slope = 0.5 * Math.tan((Math.min(60, design.segments.joint.rom) * Math.PI) / 180);
  const berth = (ext: number) => 2.5 + slope * Math.min(ext, cutRadius(design, st, 0.5) * 1.1 + 4);
  for (const a of design.addons) {
    const f = stationAt(st, a.t), r = (f.w + f.h) / 2, s0 = f.s;
    const push = (lo: number, hi: number, ext: number) => out.push([s0 + lo - berth(ext), s0 + hi + berth(ext)]);
    switch (a.kind) {
      case 'legs': {
        const n = Math.max(1, Math.round(a.count));
        for (let k = 0; k < n; k++) {
          const g = stationAt(st, a.t + (n > 1 ? (a.spread * k) / (n - 1) : 0)), rr = (g.w + g.h) / 2;
          const reach = 1.9 * rr * a.size * a.length, rl = Math.max(2.4, 0.46 * rr * a.size), sw = Math.sin((a.tilt * Math.PI) / 180);
          // along the body: the knee goes back by 0.6 reach × sin, the foot forward by 0.25, the toes another 3.1 rl
          const lo = g.s - Math.max(0, 0.25 * reach * sw) - 3.2 * rl, hi = g.s + Math.max(0, 0.6 * reach * sw) + 1.6 * rl;
          const ext = g.w + reach * a.width;
          out.push([lo - berth(ext), hi + berth(ext)]);
        }
        break;
      }
      case 'wings': { const Wd = 2.4 * r * a.size * a.width, Lw = 4.2 * r * a.size * a.length * 0.7; push(-0.55 * Wd, 1.0 * Wd, Lw); break; }
      case 'fins': {
        const n = Math.max(1, Math.round(a.count));
        for (let k = 0; k < n; k++) {
          const g = stationAt(st, a.t + (n > 1 ? (a.spread * k) / (n - 1) : 0)), rr = (g.w + g.h) / 2, L1 = 2.4 * rr * a.size * a.length, W1 = rr * a.size * a.width;
          out.push([g.s - 0.6 * W1 - berth(L1), g.s + L1 * Math.abs(Math.sin((a.tilt * Math.PI) / 180)) + 0.6 * W1 + berth(L1)]);
        }
        break;
      }
      case 'shell': out.push([s0 - 3, s0 + a.spread * L + 3]); break;
      case 'frill': case 'gills': push(-1.5 * r * a.size, 1.5 * r * a.size * a.length, 1.6 * r * a.size * a.length); break;
      case 'eyes': case 'horns': case 'ears': case 'antennae': case 'cheeks': case 'nostrils': case 'snout': case 'jaw': case 'beak': push(-1.6 * r * a.size, 1.6 * r * a.size, 2 * r * a.size); break;
      default: break;
    }
  }
  return out;
}

/** Cuts along flexible limbs: evenly spaced where the limb is thick enough. */
export function chainCuts(design: CreatureDesign, chains: Chain[], first: number, minInr = 3.8): Cut[] {
  const seg = design.segments, out: Cut[] = [];
  let id = first;
  for (const ch of chains) {
    const pts = ch.points.map(wv), cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + pts[i].distanceTo(pts[i - 1]));
    const total = cum[cum.length - 1];
    const rAt = (u: number) => { const x = clamp(u, 0, 1) * (pts.length - 1), i = Math.min(pts.length - 2, Math.floor(x)); return lerp(ch.radii[i], ch.radii[i + 1], x - i) * 0.95; };
    let k = 0;
    const place = (u: number) => {
      const r = rAt(u);
      if (r < minInr) return false;
      const target = u * total; let j = 1; while (j < cum.length - 1 && cum[j] < target) j++;
      const f = (target - cum[j - 1]) / Math.max(1e-9, cum[j] - cum[j - 1]);
      const P = pts[j - 1].clone().lerp(pts[j], f), T = pts[j].clone().sub(pts[j - 1]).normalize();
      const joint: JointSpec = { ...seg.joint };
      const c = newCut(String(id++), [P.x, P.y, P.z], [T.x, T.y, T.z], joint, seg.firstRoll + (seg.alternate && joint.kind === 'hinge' && k % 2 ? 90 : 0));
      c.name = `${ch.name} joint ${k + 1}`; c.radius = r * 1.5 + 2;
      out.push(c); k++;
      return true;
    };
    if (seg.armCuts > 0) {
      for (let i = 0; i < seg.armCuts; i++) place(0.12 + (0.84 * (i + 0.5)) / seg.armCuts);
    } else {
      let u = 0.12;
      while (u < 0.96) { if (!place(u)) break; u += Math.max(0.05, (seg.ratio * rAt(u)) / total); }
    }
  }
  return out;
}

/** Cuts along the body for the design's segment settings, skipping thin parts and stuck-on parts. */
export function autoCuts(design: CreatureDesign, st: Station[], minInr = 3.8): Cut[] {
  const seg: SegmentSpec = design.segments, L = design.body.length;
  const s0 = clamp(seg.from, 0, 0.98) * L, s1 = clamp(seg.to, seg.from + 0.02, 1) * L;
  const rAt = (s: number) => { const f = stationAt(st, s / L); return Math.min(f.w, f.top / 2) * 0.95; };
  const keep = keepOut(design, st);
  const blocked = (s: number) => keep.find(([a, b]) => s > a && s < b);
  let pos: number[] = [];
  if (seg.mode === 'even') {
    const n = Math.max(1, seg.count);
    pos = Array.from({ length: n }, (_, i) => s0 + ((i + 0.5) / n) * (s1 - s0));
  } else if (seg.mode === 'length') {
    const step = Math.max(4, seg.length);
    for (let s = s0 + step / 2; s < s1; s += step) pos.push(s);
  } else {
    // spacing follows the thickness: thick parts get longer pieces, the thin tail shorter ones
    let s = s0;
    for (let guard = 0; guard < 400; guard++) {
      const step = Math.max(4, seg.ratio * Math.min(rAt(s), rAt(Math.min(L, s + seg.ratio * rAt(s)))));
      s += step / 2; if (s >= s1) break;
      pos.push(s); s += step / 2;
    }
  }
  // move cuts out of stuck-on parts (to the nearer edge) and drop the ones that would sit on top of each other or on thin parts
  const ok: number[] = [];
  for (let s of pos) {
    const b = blocked(s);
    if (b) s = (s - b[0] < b[1] - s ? b[0] : b[1]);
    if (blocked(s) || s < s0 - 1 || s > s1 + 1) continue;
    if (rAt(s) < minInr) continue;
    const prev = ok[ok.length - 1];
    if (prev !== undefined && s - prev < Math.max(4, rAt(s) * 1.2)) continue;
    ok.push(s);
  }
  return ok.map((s, i) => {
    const f = stationAt(st, s / L);
    const joint: JointSpec = { ...seg.joint };
    const roll = seg.firstRoll + (seg.alternate && joint.kind === 'hinge' && i % 2 ? 90 : 0);
    const c = newCut(String(i + 1), [f.P.x, f.P.y, f.top * 0.5], [f.T.x, f.T.y, 0], joint, roll);
    c.name = `Joint ${i + 1}`;
    c.radius = cutRadius(design, st, s / L);
    return c;
  });
}
