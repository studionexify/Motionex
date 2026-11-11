// Motionex direct G-code generator: builds a printable wall shape straight from parameters (no model,
// no slicer) and drives the outer wall with a motion from the library. Pure functions, no DOM, so the
// same code runs in the app and in the standalone web page.
import { evalCurve } from '../plugins/motionex/curve';
import { effectPhase } from '../plugins/motionex/modifier';
import type { MotionBrush } from '../plugins/motionex/model';

export type ShapeKind = 'cylinder' | 'polygon' | 'vase' | 'cone' | 'twisted';

export interface GenSettings {
  // shape
  shape: ShapeKind;
  diameter: number;      // mm, at the base
  topDiameter: number;   // mm (cone / vase rim)
  height: number;        // mm
  sides: number;         // polygon / twisted
  twistDeg: number;      // twisted: total twist over the height
  bulge: number;         // vase: belly size, mm added to the radius
  // print
  layerHeight: number;
  firstLayerHeight: number;
  lineWidth: number;
  baseLayers: number;    // solid bottom layers
  innerWalls: number;    // plain walls inside the motion wall
  spiral: boolean;       // continuous Z on the walls (vase mode)
  speed: number;         // mm/s outer wall
  firstLayerSpeed: number;
  travelSpeed: number;
  // motion
  motionOn: boolean;
  amplitudeScale: number;
  periodScale: number;
  phaseDeg: number;
  layerEffects: boolean;
  zStart: number;        // mm above the bed where motion starts
  fadeMm: number;        // fade-in height
  // machine
  bedX: number; bedY: number;
  nozzle: number; filamentDia: number;
  nozzleTemp: number; bedTemp: number;
  fan: number;           // 0..100
  retract: number;       // mm
  startGcode: string;
  endGcode: string;
}

export const DEFAULT_SETTINGS: GenSettings = {
  shape: 'cylinder', diameter: 60, topDiameter: 40, height: 40, sides: 6, twistDeg: 90, bulge: 10,
  layerHeight: 0.2, firstLayerHeight: 0.25, lineWidth: 0.45, baseLayers: 3, innerWalls: 1, spiral: false,
  speed: 40, firstLayerSpeed: 20, travelSpeed: 150,
  motionOn: true, amplitudeScale: 1, periodScale: 1, phaseDeg: 0, layerEffects: true, zStart: 1, fadeMm: 1,
  bedX: 256, bedY: 256, nozzle: 0.4, filamentDia: 1.75, nozzleTemp: 215, bedTemp: 60, fan: 100, retract: 0.8,
  startGcode: 'G28 ; home\nG90\nM83 ; relative extrusion\nG1 Z5 F3000\nG92 E0',
  endGcode: 'G91\nG1 Z10 F600\nG90\nG1 X10 Y{bedY_minus10} F6000\nM104 S0\nM140 S0\nM106 S0\nM84',
};

/** One preview segment: from the previous point to this one. */
export interface Seg { x0: number; y0: number; z0: number; x: number; y: number; z: number; kind: 'wall' | 'motion' | 'base' | 'travel'; speed: number; flow: number }

export interface GenResult {
  gcode: string;
  segs: Seg[];
  layers: number;
  /** Index into segs where each layer starts. */
  layerStart: number[];
  stats: { lengthMm: number; filamentMm: number; grams: number; seconds: number; lines: number; maxOffset: number };
  warnings: string[];
}

const TAU = Math.PI * 2;
const frac = (u: number) => ((u % 1) + 1) % 1;
const f3 = (v: number) => (Math.round(v * 1000) / 1000).toString();
const f5 = (v: number) => (Math.round(v * 100000) / 100000).toString();

/** Radius scale and outline at height z: closed list of [x, y] around (0,0), counter-clockwise. */
function outline(s: GenSettings, z: number, res: number): [number, number][] {
  const t = s.height > 0 ? Math.min(1, Math.max(0, z / s.height)) : 0;
  let r = s.diameter / 2;
  if (s.shape === 'cone') r = (s.diameter + (s.topDiameter - s.diameter) * t) / 2;
  if (s.shape === 'vase') r = (s.diameter + (s.topDiameter - s.diameter) * t) / 2 + s.bulge * Math.sin(Math.PI * t) ** 1.5;
  r = Math.max(1, r);
  const pts: [number, number][] = [];
  if (s.shape === 'polygon' || s.shape === 'twisted') {
    const n = Math.max(3, Math.round(s.sides));
    const rot = s.shape === 'twisted' ? (s.twistDeg * Math.PI / 180) * t : 0;
    const side = 2 * r * Math.sin(Math.PI / n);
    const per = Math.max(2, Math.ceil(side / res));
    for (let i = 0; i < n; i++) {
      const a0 = rot + (i / n) * TAU, a1 = rot + ((i + 1) / n) * TAU;
      const x0 = r * Math.cos(a0), y0 = r * Math.sin(a0), x1 = r * Math.cos(a1), y1 = r * Math.sin(a1);
      for (let k = 0; k < per; k++) { const f = k / per; pts.push([x0 + (x1 - x0) * f, y0 + (y1 - y0) * f]); }
    }
  } else {
    const n = Math.max(48, Math.ceil((TAU * r) / res));
    for (let i = 0; i < n; i++) { const a = (i / n) * TAU; pts.push([r * Math.cos(a), r * Math.sin(a)]); }
  }
  return pts;
}

/** Shrink an outline toward the centre by d (fine for the convex shapes generated here). */
function inset(pts: [number, number][], d: number): [number, number][] {
  return pts.map(([x, y]) => { const r = Math.hypot(x, y) || 1; const k = Math.max(0, (r - d) / r); return [x * k, y * k]; });
}

function loopLength(p: [number, number][]) {
  let L = 0;
  for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; L += Math.hypot(b[0] - a[0], b[1] - a[1]); }
  return L;
}

export function generate(s: GenSettings, brush: MotionBrush | null): GenResult {
  const out: string[] = [];
  const segs: Seg[] = [];
  const layerStart: number[] = [];
  const warnings: string[] = [];
  const cx = s.bedX / 2, cy = s.bedY / 2;
  const fa = Math.PI * (s.filamentDia / 2) ** 2;
  let x = cx, y = cy, z = 0, eTot = 0, len = 0, secs = 0, maxOff = 0;

  const emit = (line: string) => out.push(line);
  const travel = (nx: number, ny: number, nz = z) => {
    const d = Math.hypot(nx - x, ny - y, nz - z);
    if (d < 1e-4) return;
    if (s.retract > 0 && d > 2) emit(`G1 E-${f3(s.retract)} F2400`);
    emit(`G0 X${f3(nx)} Y${f3(ny)}${nz !== z ? ` Z${f3(nz)}` : ''} F${Math.round(s.travelSpeed * 60)}`);
    if (s.retract > 0 && d > 2) emit(`G1 E${f3(s.retract)} F2400`);
    segs.push({ x0: x, y0: y, z0: z, x: nx, y: ny, z: nz, kind: 'travel', speed: s.travelSpeed, flow: 0 });
    secs += d / s.travelSpeed; x = nx; y = ny; z = nz;
  };
  const extrude = (nx: number, ny: number, nz: number, h: number, w: number, speed: number, flow: number, kind: Seg['kind']) => {
    const d = Math.hypot(nx - x, ny - y, nz - z);
    if (d < 1e-4) return;
    const e = (d * h * w * flow) / fa;
    eTot += e; len += d; secs += d / speed;
    emit(`G1 X${f3(nx)} Y${f3(ny)}${Math.abs(nz - z) > 1e-6 ? ` Z${f3(nz)}` : ''} E${f5(e)} F${Math.round(speed * 60)}`);
    segs.push({ x0: x, y0: y, z0: z, x: nx, y: ny, z: nz, kind, speed, flow });
    x = nx; y = ny; z = nz;
  };

  const lh = Math.max(0.05, s.layerHeight), flh = Math.max(0.05, s.firstLayerHeight);
  const nLayers = Math.max(1, 1 + Math.ceil((s.height - flh) / lh - 1e-6));
  const res = brush && s.motionOn ? Math.min(0.5, Math.max(0.15, (brush.period_mm * s.periodScale) / 20)) : 0.5;

  emit('; Generated by Motionex — direct G-code generator');
  emit(`; shape=${s.shape} d=${s.diameter} h=${s.height} layers=${nLayers} motion=${s.motionOn && brush ? brush.name : 'none'}`);
  emit(`M140 S${s.bedTemp}`); emit(`M104 S${s.nozzleTemp}`); emit(`M190 S${s.bedTemp}`); emit(`M109 S${s.nozzleTemp}`);
  for (const l of s.startGcode.split('\n')) emit(l);
  emit('M83');
  // prime line
  travel(10, 10, flh); extrude(10, Math.min(s.bedY - 10, 110), flh, flh, s.lineWidth * 1.5, s.firstLayerSpeed, 1, 'base');
  travel(10.6, Math.min(s.bedY - 10, 110)); extrude(10.6, 10, flh, flh, s.lineWidth * 1.5, s.firstLayerSpeed, 1, 'base');

  const motion = s.motionOn && brush ? brush : null;
  const amp = motion ? motion.amplitude * s.amplitudeScale : 0;
  const zamp = motion ? (motion.z_amplitude ?? 0) * s.amplitudeScale : 0;
  const period = motion ? Math.max(0.2, motion.period_mm * s.periodScale) : 1;
  if (motion && amp > s.lineWidth * 4) warnings.push(`Motion size ${amp.toFixed(2)} mm is large for a ${s.lineWidth} mm line: layers may not bond.`);
  if (s.diameter > Math.min(s.bedX, s.bedY) - 10) warnings.push('The part is bigger than the bed.');

  for (let li = 0; li < nLayers; li++) {
    const zTop = li === 0 ? flh : Math.min(s.height, flh + li * lh);
    const h = li === 0 ? flh : lh;
    const speed = li === 0 ? s.firstLayerSpeed : s.speed;
    layerStart.push(segs.length);
    emit(`;LAYER:${li}`); emit(`;Z:${f3(zTop)}`);
    if (li === 1) emit(`M106 S${Math.round((s.fan / 100) * 255)}`);
    const base = outline(s, zTop, res);
    const isBase = li < s.baseLayers;
    const spiralNow = s.spiral && !isBase && li > 0;

    // inner walls (plain), then solid base fill as concentric rings
    // plain rings don't follow the motion, so they use a coarser outline
    const plain = res < 0.5 ? outline(s, zTop, 0.5) : base;
    const rings: [number, number][][] = [];
    for (let k = 1; k <= s.innerWalls; k++) rings.push(inset(plain, k * s.lineWidth));
    if (isBase) {
      let r0 = 0; for (const [px, py] of plain) r0 = Math.max(r0, Math.hypot(px, py));
      for (let k = s.innerWalls + 1; k * s.lineWidth < r0 - s.lineWidth / 2; k++) rings.push(inset(plain, k * s.lineWidth));
    }
    if (!spiralNow) for (const ring of rings) {
      if (ring.length < 3 || loopLength(ring) < 1) continue;
      travel(cx + ring[0][0], cy + ring[0][1], zTop);
      for (let i = 1; i <= ring.length; i++) { const p = ring[i % ring.length]; extrude(cx + p[0], cy + p[1], zTop, h, s.lineWidth, speed, 1, isBase && rings.indexOf(ring) >= s.innerWalls ? 'base' : 'wall'); }
    }

    // outer wall with motion
    const L = loopLength(base);
    const reps = motion && motion.repeat_mode === 'stretch' ? Math.max(1, Math.round(L / period)) : L / period;
    const per = L / reps;
    let lp: number | null = 0;
    if (motion && s.layerEffects) lp = effectPhase(motion.layers ?? null, li);
    const phase = ((motion?.phase_deg ?? 0) + s.phaseDeg + (lp ?? 0)) / 360;
    const fade = motion && lp !== null ? Math.max(0, Math.min(1, s.fadeMm > 0 ? (zTop - s.zStart) / s.fadeMm : zTop >= s.zStart ? 1 : 0)) : 0;
    const n = base.length;
    let acc = 0;
    for (let i = 0; i <= n; i++) {
      const p = base[i % n], pn = base[(i + 1) % n], pp = base[(i - 1 + n) % n];
      if (i > 0) acc += Math.hypot(p[0] - pp[0], p[1] - pp[1]);
      // tangent and outward normal
      let tx = pn[0] - pp[0], ty = pn[1] - pp[1]; const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
      const nx = ty, ny = -tx;
      let ox = 0, oy = 0, oz = 0, flow = 1, sp = 1;
      if (motion && fade > 0) {
        const u = frac(acc / per + phase);
        const lat = evalCurve(motion.curves.lateral_offset, u) * amp * fade;
        const al = evalCurve(motion.curves.along_offset, u) * amp * fade;
        oz = evalCurve(motion.curves.z_offset, u) * zamp * fade;
        flow = 1 + (evalCurve(motion.curves.extrusion_mult, u) - 1) * fade;
        flow = Math.min(motion.limits.max_flow_mult, Math.max(motion.limits.min_flow_mult, flow));
        sp = Math.max(0.1, 1 + (evalCurve(motion.curves.speed_mult, u) - 1) * fade);
        ox = nx * lat + tx * al; oy = ny * lat + ty * al;
        maxOff = Math.max(maxOff, Math.hypot(lat, al));
      }
      const zz = spiralNow ? zTop - h + h * (acc / L) : zTop;
      const px = cx + p[0] + ox, py = cy + p[1] + oy, pz = Math.max(0.05, zz + oz);
      if (i === 0) { travel(px, py, li === 0 || !spiralNow ? zTop : z); continue; }
      extrude(px, py, pz, h, s.lineWidth, speed * sp, flow, motion && fade > 0 ? 'motion' : 'wall');
    }
  }
  emit(`; filament used: ${(eTot / 1000).toFixed(3)} m`);
  for (const l of s.endGcode.replace('{bedY_minus10}', String(s.bedY - 10)).split('\n')) emit(l);
  const grams = (eTot * fa) / 1000 * 1.24;
  return { gcode: out.join('\n') + '\n', segs, layers: nLayers, layerStart, warnings,
    stats: { lengthMm: len, filamentMm: eTot, grams, seconds: secs, lines: out.length, maxOffset: maxOff } };
}

/** Sample a motion's side-to-side and along curves for library thumbnails. */
export function motionSamples(b: MotionBrush, n = 96): [number, number][] {
  const r: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const u = (i / n) * 2;
    r.push([u + evalCurve(b.curves.along_offset, frac(u)) * 0.25, evalCurve(b.curves.lateral_offset, frac(u))]);
  }
  return r;
}
