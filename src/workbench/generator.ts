// Motionex slicer: turns a Design (the revolved wall from design.ts) into G-code, with Motionex
// motions applied to the outer wall per layer zone. Pure functions, no DOM: runs in the app and the web page.
import { evalCurve } from '../plugins/motionex/curve';
import { effectPhase } from '../plugins/motionex/modifier';
import type { LayerEffect, MotionBrush } from '../plugins/motionex/model';
import { makeSurface, profileR, type Design } from './design';

/** One band of layers with its own motion (motion "layer-wise"). Zones are checked top of list first. */
export interface MotionZone {
  id: string;
  enabled: boolean;
  brushId: string;
  from: number; to: number;     // 0..1 of the piece height
  size: number; spacing: number; phase: number;
  /** Layer stacking: how each layer's motion leads or lags the one below (null = lined up). */
  layers: LayerEffect | null;
  /** Use the motion's own stacking instead of `layers`. */
  useBrushLayers: boolean;
  fade: number;                 // mm faded in/out at the zone edges
}

export interface SliceSettings {
  layerHeight: number; firstLayerHeight: number; lineWidth: number;
  baseLayers: number; innerWalls: number; spiral: boolean; flip: boolean;
  speed: number; firstLayerSpeed: number; travelSpeed: number; maxVolumetric: number;
  bedX: number; bedY: number; filamentDia: number; flowRatio: number;
  nozzleTemp: number; bedTemp: number; fan: number; retract: number;
  startGcode: string; endGcode: string;
  printer: string;
}

export const DEFAULT_SLICE: SliceSettings = {
  layerHeight: 0.24, firstLayerHeight: 0.28, lineWidth: 0.5, baseLayers: 4, innerWalls: 0, spiral: true, flip: false,
  speed: 40, firstLayerSpeed: 20, travelSpeed: 150, maxVolumetric: 12,
  bedX: 256, bedY: 256, filamentDia: 1.75, flowRatio: 0.98, nozzleTemp: 220, bedTemp: 60, fan: 80, retract: 0.8,
  startGcode: 'G28 ; home\nG90\nM83 ; relative extrusion\nG1 Z5 F3000\nG92 E0',
  endGcode: 'G91\nG1 Z10 F600\nG90\nG1 X10 Y{bedY_minus10} F6000\nM104 S0\nM140 S0\nM106 S0\nM84',
  printer: 'generic-256',
};

export const PRINTERS: { id: string; name: string; bed: [number, number, number] }[] = [
  { id: 'generic-256', name: 'Generic 256 mm', bed: [256, 256, 256] },
  { id: 'bbl-a1', name: 'Bambu Lab A1', bed: [256, 256, 256] },
  { id: 'bbl-a1mini', name: 'Bambu Lab A1 mini', bed: [180, 180, 180] },
  { id: 'bbl-p1s', name: 'Bambu Lab P1S / X1C', bed: [256, 256, 250] },
  { id: 'bbl-h2d', name: 'Bambu Lab H2D', bed: [350, 320, 325] },
  { id: 'ender3v3', name: 'Creality Ender-3 V3', bed: [220, 220, 240] },
  { id: 'k1max', name: 'Creality K1 Max', bed: [300, 300, 300] },
  { id: 'k2plus', name: 'Creality K2 Plus', bed: [350, 350, 350] },
  { id: 'mk4', name: 'Prusa MK4', bed: [250, 210, 220] },
  { id: 'coreone', name: 'Prusa CORE One', bed: [250, 220, 270] },
  { id: 'neptune4pro', name: 'Elegoo Neptune 4 Pro', bed: [230, 230, 265] },
  { id: 'kobra3', name: 'Anycubic Kobra 3', bed: [255, 255, 260] },
];

export function newZone(brushId: string, from = 0, to = 1): MotionZone {
  return { id: Math.random().toString(36).slice(2, 9), enabled: true, brushId, from, to, size: 1, spacing: 1, phase: 0, layers: null, useBrushLayers: true, fade: 1 };
}

export interface Seg { x0: number; y0: number; z0: number; x: number; y: number; z: number; kind: 'wall' | 'motion' | 'base' | 'travel'; speed: number; flow: number }
export interface GenResult {
  gcode: string; segs: Seg[]; layers: number; layerStart: number[]; layerZ: number[];
  stats: { lengthMm: number; filamentMm: number; grams: number; seconds: number; lines: number; maxOffset: number };
  warnings: string[];
}

const TAU = Math.PI * 2;
const frac = (u: number) => ((u % 1) + 1) % 1;
const f3 = (v: number) => (Math.round(v * 1000) / 1000).toString();
const f5 = (v: number) => (Math.round(v * 100000) / 100000).toString();

function loopAt(surf: (z: number, th: number) => number, z: number, n: number): [number, number][] {
  const p: [number, number][] = [];
  for (let i = 0; i < n; i++) { const th = (i / n) * TAU, r = surf(z, th); p.push([r * Math.cos(th), r * Math.sin(th)]); }
  return p;
}
function inset(pts: [number, number][], d: number): [number, number][] {
  return pts.map(([x, y]) => { const r = Math.hypot(x, y) || 1; const k = Math.max(0, (r - d) / r); return [x * k, y * k]; });
}

export function slice(design: Design, s: SliceSettings, zones: MotionZone[], brushes: (id: string) => MotionBrush | undefined): GenResult {
  const out: string[] = [], segs: Seg[] = [], layerStart: number[] = [], layerZ: number[] = [], warnings: string[] = [];
  const surfRaw = makeSurface(design);
  const H = design.height;
  const surf = s.flip ? (z: number, th: number) => surfRaw(H - z, th) : surfRaw;
  const cx = s.bedX / 2, cy = s.bedY / 2;
  const fa = Math.PI * (s.filamentDia / 2) ** 2;
  let x = cx, y = cy, z = 0, eTot = 0, len = 0, secs = 0, maxOff = 0;
  const emit = (l: string) => out.push(l);
  const volCap = (h: number, w: number) => s.maxVolumetric / (h * w);

  const travel = (nx: number, ny: number, nz = z) => {
    const d = Math.hypot(nx - x, ny - y, nz - z);
    if (d < 1e-4) return;
    const r = s.retract > 0 && d > 2;
    if (r) emit(`G1 E-${f3(s.retract)} F2400`);
    emit(`G0 X${f3(nx)} Y${f3(ny)}${nz !== z ? ` Z${f3(nz)}` : ''} F${Math.round(s.travelSpeed * 60)}`);
    if (r) emit(`G1 E${f3(s.retract)} F2400`);
    segs.push({ x0: x, y0: y, z0: z, x: nx, y: ny, z: nz, kind: 'travel', speed: s.travelSpeed, flow: 0 });
    secs += d / s.travelSpeed; x = nx; y = ny; z = nz;
  };
  const extrude = (nx: number, ny: number, nz: number, h: number, w: number, speed: number, flow: number, kind: Seg['kind']) => {
    const d = Math.hypot(nx - x, ny - y, nz - z);
    if (d < 1e-4) return;
    const sp = Math.min(speed, volCap(h, w * flow));
    const e = (d * h * w * flow * s.flowRatio) / fa;
    eTot += e; len += d; secs += d / sp;
    emit(`G1 X${f3(nx)} Y${f3(ny)}${Math.abs(nz - z) > 1e-6 ? ` Z${f3(nz)}` : ''} E${f5(e)} F${Math.round(sp * 60)}`);
    segs.push({ x0: x, y0: y, z0: z, x: nx, y: ny, z: nz, kind, speed: sp, flow });
    x = nx; y = ny; z = nz;
  };

  const lh = Math.max(0.05, s.layerHeight), flh = Math.max(0.05, s.firstLayerHeight);
  const nLayers = Math.max(1, 1 + Math.ceil((H - flh) / lh - 1e-6));
  const active = zones.filter((zn) => zn.enabled && brushes(zn.brushId));
  const minPeriod = Math.min(4, ...active.map((zn) => brushes(zn.brushId)!.period_mm * zn.spacing));
  const res = active.length ? Math.min(0.6, Math.max(0.15, minPeriod / 20)) : 0.6;

  // piece must fit
  let maxR = 0; for (let i = 0; i <= 20; i++) for (let j = 0; j < 72; j++) maxR = Math.max(maxR, surf((i / 20) * H, (j / 72) * TAU));
  if (maxR * 2 > Math.min(s.bedX, s.bedY) - 4) warnings.push(`Ø${(maxR * 2).toFixed(0)} mm does not fit the ${s.bedX}×${s.bedY} mm bed.`);
  const printer = PRINTERS.find((p) => p.id === s.printer);
  if (printer && H > printer.bed[2]) warnings.push(`${H.toFixed(0)} mm is taller than the ${printer.name} (${printer.bed[2]} mm).`);

  emit('; Generated by Motionex Studio');
  emit(`; piece: ${design.name} · ${design.family} · h=${H} · Ø${design.maxDiameter} · layer ${lh} · line ${s.lineWidth}${s.spiral ? ' · spiral vase' : ''}`);
  emit(`; motion zones: ${active.map((zn) => `${brushes(zn.brushId)!.name} ${Math.round(zn.from * 100)}-${Math.round(zn.to * 100)}%`).join(', ') || 'none'}`);
  emit(`M140 S${s.bedTemp}`); emit(`M104 S${s.nozzleTemp}`); emit(`M190 S${s.bedTemp}`); emit(`M109 S${s.nozzleTemp}`);
  for (const l of s.startGcode.split('\n')) emit(l);
  emit('M83'); emit('M106 S0');
  travel(10, 10, flh); extrude(10, Math.min(s.bedY - 10, 110), flh, flh, s.lineWidth * 1.5, s.firstLayerSpeed, 1, 'base');
  travel(10.6, Math.min(s.bedY - 10, 110)); extrude(10.6, 10, flh, flh, s.lineWidth * 1.5, s.firstLayerSpeed, 1, 'base');

  const baseOn = !design.openBottom && !s.flip ? s.baseLayers : design.openBottom ? 0 : s.baseLayers;
  for (let li = 0; li < nLayers; li++) {
    const zTop = li === 0 ? flh : Math.min(H, flh + li * lh);
    const h = li === 0 ? flh : lh;
    const speed = li === 0 ? s.firstLayerSpeed : s.speed;
    layerStart.push(segs.length); layerZ.push(zTop);
    emit(';LAYER_CHANGE'); emit(`;LAYER:${li}`); emit(`;Z:${f3(zTop)}`); emit(`M73 P${Math.round((li / nLayers) * 100)}`);
    if (li === 1) emit(`M106 S${Math.round((s.fan / 100) * 255)}`);
    const isBase = li < baseOn;
    const spiralNow = s.spiral && !isBase && li > 0;
    const t = zTop / H;

    // plain inner walls and solid base rings (coarse loop)
    if (!spiralNow) {
      const plain = loopAt(surf, zTop, 240);
      const rings: [number, number][][] = [];
      for (let k = 1; k <= s.innerWalls; k++) rings.push(inset(plain, k * s.lineWidth));
      if (isBase) { let r0 = 0; for (const [px, py] of plain) r0 = Math.max(r0, Math.hypot(px, py)); for (let k = s.innerWalls + 1; k * s.lineWidth < r0 - s.lineWidth / 2; k++) rings.push(inset(plain, k * s.lineWidth)); }
      rings.forEach((ring, ri) => {
        travel(cx + ring[0][0], cy + ring[0][1], zTop);
        for (let i = 1; i <= ring.length; i++) { const p = ring[i % ring.length]; extrude(cx + p[0], cy + p[1], zTop, h, s.lineWidth, speed, 1, isBase && ri >= s.innerWalls ? 'base' : 'wall'); }
      });
    }

    // outer wall: zone for this layer (first match wins)
    const zone = active.find((zn) => t >= zn.from - 1e-9 && t <= zn.to + 1e-9) ?? null;
    const brush = zone ? brushes(zone.brushId)! : null;
    const amp = brush ? brush.amplitude * zone!.size : 0, zamp = brush ? (brush.z_amplitude ?? 0) * zone!.size : 0;
    const period = brush ? Math.max(0.2, brush.period_mm * zone!.spacing) : 1;
    // circumference approx for sample count / repeats
    const approxR = profileR(design, s.flip ? 1 - t : t) * design.maxDiameter / 2;
    const n = Math.max(120, Math.ceil((TAU * approxR) / res));
    const loop = loopAt(surf, zTop, n);
    let L = 0; for (let i = 0; i < n; i++) { const a = loop[i], b = loop[(i + 1) % n]; L += Math.hypot(b[0] - a[0], b[1] - a[1]); }
    const reps = brush && brush.repeat_mode === 'stretch' ? Math.max(1, Math.round(L / period)) : L / period;
    const per = L / reps;
    let fade = 0, phase = 0;
    if (brush && zone) {
      const effect = zone.useBrushLayers ? brush.layers ?? null : zone.layers;
      const lp = effectPhase(effect, li);
      if (lp !== null) {
        const zf = zone.from * H, zt = zone.to * H;
        fade = zone.fade > 0 ? Math.min(1, (zTop - zf) / zone.fade + (zf <= flh ? 1 : 0), (zt - zTop) / zone.fade + (zt >= H - 1e-6 ? 1 : 0)) : 1;
        fade = Math.max(0, Math.min(1, fade));
        if (li < Math.max(1, baseOn)) fade = 0; // never on the base / first layer
        phase = ((brush.phase_deg ?? 0) + zone.phase + lp) / 360;
        if (effect?.cross && li % 2) phase = ((brush.phase_deg ?? 0) + zone.phase - lp) / 360;
      }
    }
    let acc = 0;
    for (let i = 0; i <= n; i++) {
      const p = loop[i % n], pn = loop[(i + 1) % n], pp = loop[(i - 1 + n) % n];
      if (i > 0) acc += Math.hypot(p[0] - pp[0], p[1] - pp[1]);
      let tx = pn[0] - pp[0], ty = pn[1] - pp[1]; const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
      const nx = ty, ny = -tx;
      let ox = 0, oy = 0, oz = 0, flow = 1, sp = 1;
      if (brush && fade > 0) {
        const u = frac(acc / per + phase);
        const lat = evalCurve(brush.curves.lateral_offset, u) * amp * fade, al = evalCurve(brush.curves.along_offset, u) * amp * fade;
        oz = evalCurve(brush.curves.z_offset, u) * zamp * fade;
        flow = Math.min(brush.limits.max_flow_mult, Math.max(brush.limits.min_flow_mult, 1 + (evalCurve(brush.curves.extrusion_mult, u) - 1) * fade));
        sp = Math.max(0.1, 1 + (evalCurve(brush.curves.speed_mult, u) - 1) * fade);
        ox = nx * lat + tx * al; oy = ny * lat + ty * al;
        maxOff = Math.max(maxOff, Math.hypot(lat, al));
      }
      const zz = spiralNow ? zTop - h + h * (acc / L) : zTop;
      const px = cx + p[0] + ox, py = cy + p[1] + oy, pz = Math.max(0.05, zz + oz);
      if (i === 0) { travel(px, py, spiralNow ? z : zTop); continue; }
      extrude(px, py, pz, h, s.lineWidth, speed * sp, flow, brush && fade > 0 ? 'motion' : 'wall');
    }
  }
  emit(`; filament used: ${(eTot / 1000).toFixed(3)} m`);
  for (const l of s.endGcode.replace('{bedY_minus10}', String(s.bedY - 10)).split('\n')) emit(l);
  if (!segs.length) warnings.push('Nothing to print: the layer height is taller than the piece.');
  return { gcode: out.join('\n') + '\n', segs, layers: nLayers, layerStart, layerZ, warnings,
    stats: { lengthMm: len, filamentMm: eTot, grams: (eTot * fa) / 1000 * 1.24, seconds: secs, lines: out.length, maxOffset: maxOff } };
}

/** Motion curve samples for library thumbnails. */
export function motionSamples(b: MotionBrush, n = 96): [number, number][] {
  const r: [number, number][] = [];
  for (let i = 0; i <= n; i++) { const u = (i / n) * 2; r.push([u + evalCurve(b.curves.along_offset, frac(u)) * 0.25, evalCurve(b.curves.lateral_offset, frac(u))]); }
  return r;
}
