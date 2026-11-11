// Body shape: profile radius by height, cross-section by angle, and twist. Pure functions of the spec.
import type { PlantexSpec, ProfilePoint, SectionSpec } from './model';

const TAU = Math.PI * 2;
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const smoothstep = (t: number) => t * t * (3 - 2 * t);

/** Radius (mm) at height fraction t, through the control points (monotone cubic: no overshoot). */
export function profileFn(points: ProfilePoint[], smooth: boolean): (t: number) => number {
  const p = [...points].sort((a, b) => a.z - b.z);
  if (!p.length) return () => 40;
  if (p.length === 1) return () => p[0].r;
  const n = p.length;
  const d: number[] = [];
  for (let i = 0; i < n - 1; i++) d.push((p[i + 1].r - p[i].r) / Math.max(1e-6, p[i + 1].z - p[i].z));
  const m: number[] = new Array(n).fill(0);
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
    if (s > 9) { const k = 3 / Math.sqrt(s); m[i] = k * a * d[i]; m[i + 1] = k * b * d[i]; }
  }
  return (t) => {
    if (t <= p[0].z) return p[0].r;
    if (t >= p[n - 1].z) return p[n - 1].r;
    let i = 0;
    while (i < n - 2 && t > p[i + 1].z) i++;
    const h = Math.max(1e-6, p[i + 1].z - p[i].z), s = (t - p[i].z) / h;
    if (!smooth) return p[i].r + (p[i + 1].r - p[i].r) * s;
    const s2 = s * s, s3 = s2 * s;
    return (2 * s3 - 3 * s2 + 1) * p[i].r + (s3 - 2 * s2 + s) * h * m[i] + (-2 * s3 + 3 * s2) * p[i + 1].r + (s3 - s2) * h * m[i + 1];
  };
}

/** Radius multiplier (≈ 0.5..1.2) of a cross-section at angle a. */
export function sectionAt(s: Omit<SectionSpec, 'morphTo'>, a: number): number {
  const n = Math.max(2, Math.round(s.n));
  let k: number;
  switch (s.kind) {
    case 'polygon': {
      const seg = TAU / n;
      const x = ((a % seg) + seg) % seg - seg / 2;
      const poly = Math.cos(Math.PI / n) / Math.cos(x);
      // round blends the flat sides out toward the corner circle
      const r = clamp(s.round, 0, 1);
      k = poly + (1 - poly) * r * r;
      break;
    }
    case 'star': {
      const tri = Math.abs((((a * n) / TAU) % 1 + 1) % 1 * 2 - 1);
      k = 1 - s.depth * tri;
      break;
    }
    case 'petal': k = 1 - s.depth * (1 - Math.pow(Math.abs(Math.cos((a * n) / 2)), 0.6)); break;
    case 'wave': k = 1 - s.depth * (0.5 - 0.5 * Math.cos(a * n)); break;
    case 'gear': {
      const c = Math.cos(a * n);
      const sharp = 1 + (1 - clamp(s.round, 0, 1)) * 12;
      k = 1 - s.depth * (0.5 - 0.5 * Math.tanh(c * sharp) / Math.tanh(sharp));
      break;
    }
    case 'superellipse': {
      const e = Math.max(0.5, s.exponent);
      k = Math.pow(Math.pow(Math.abs(Math.cos(a)), e) + Math.pow(Math.abs(Math.sin(a)), e), -1 / e);
      break;
    }
    default: k = 1;
  }
  return k;
}

/** Oval stretch of a section (x by aspect, y by 1/aspect keeps the area). */
function aspectScale(a: number, aspect: number): number {
  if (aspect === 1 || !aspect) return 1;
  const sx = Math.sqrt(aspect), sy = 1 / sx;
  return 1 / Math.sqrt((Math.cos(a) / sx) ** 2 + (Math.sin(a) / sy) ** 2);
}

export function twistAt(spec: PlantexSpec, t: number): number {
  const tw = (spec.twist * Math.PI) / 180;
  if (spec.twistEase === 'ease') return tw * smoothstep(clamp(t, 0, 1));
  if (spec.twistEase === 'wave') return tw * Math.sin(Math.PI * t);
  return tw * t;
}

export interface BodyFn {
  /** Radius (mm) at angle a and height z (mm), before textures. */
  radius(a: number, z: number): number;
  height: number;
}

export function bodyFn(spec: PlantexSpec, scale = 1, extra = 0): BodyFn {
  const prof = profileFn(spec.profile, spec.smooth);
  const H = Math.max(1, spec.height);
  const s0 = spec.section, s1 = spec.section.morphTo;
  return {
    height: H,
    radius(a, z) {
      const t = clamp(z / H, 0, 1);
      const ang = a - twistAt(spec, t);
      let k = sectionAt(s0, ang) * aspectScale(ang, s0.aspect);
      if (s1) k += (sectionAt(s1, ang) * aspectScale(ang, s1.aspect) - k) * smoothstep(t);
      return prof(t) * k * scale + extra;
    },
  };
}
