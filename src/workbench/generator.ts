// Motionex slicer: turns a Design (the revolved wall from design.ts) into G-code, with Motionex
// motions applied to the outer wall per layer zone. Pure functions, no DOM: runs in the app and the web page.
import { evalCurve } from '../plugins/motionex/curve';
import { effectPhase } from '../plugins/motionex/modifier';
import type { LayerEffect, MotionBrush } from '../plugins/motionex/model';
import { makeInner, makeSurface, profileR, type Design } from './design';
import { prepareRules, ruleWeight, type PreparedRule, type Rule } from './rules';

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
  /** Which wall lines get the motion (NexSpiro 'Lines to change'): outer wall and/or inner wall lines innerFrom..innerTo (1 = next to the outer). */
  lines?: { outer: boolean; inner: boolean; innerFrom: number; innerTo: number };
}

export interface SliceSettings {
  layerHeight: number; firstLayerHeight: number; lineWidth: number;
  baseLayers: number; topLayers: number; innerWalls: number; spiral: boolean; flip: boolean;
  speed: number; firstLayerSpeed: number; travelSpeed: number; maxVolumetric: number;
  bedX: number; bedY: number; filamentDia: number; flowRatio: number;
  nozzleTemp: number; bedTemp: number; fan: number; retract: number;
  startGcode: string; endGcode: string;
  printer: string;
  /** Nozzle diameter, mm. */
  nozzle?: number;
  /** Trim / add extrusion per move so slow-downs at corners don't leave blobs (uses the print physics). */
  evenFlow?: boolean;
  /** Push extra extrusion where pressure has not built up yet (after travels, speed-ups) so lines don't print thin. */
  evenThin?: boolean;
  /** Layer height that rule reach (in layers) is measured with; set by coarse previews. */
  reachLayerHeight?: number;
}

export const DEFAULT_SLICE: SliceSettings = {
  layerHeight: 0.2, firstLayerHeight: 0.24, lineWidth: 0.45, baseLayers: 4, topLayers: 0, innerWalls: 0, spiral: false, flip: false,
  speed: 40, firstLayerSpeed: 20, travelSpeed: 150, maxVolumetric: 12,
  bedX: 256, bedY: 256, filamentDia: 1.75, flowRatio: 0.98, nozzleTemp: 220, bedTemp: 60, fan: 80, retract: 0.8,
  startGcode: 'G28 ; home\nG90\nM83 ; relative extrusion\nG1 Z5 F3000\nG92 E0',
  endGcode: 'G91\nG1 Z10 F600\nG90\nG1 X10 Y{bedY_minus10} F6000\nM104 S0\nM140 S0\nM106 S0\nM84',
  printer: 'bbl-a1', nozzle: 0.4, evenFlow: true, evenThin: true,
};

/** Your machines and the nozzles fitted to them. Everything else (line, layer, flow, detail limits) follows. */
export const PRINTERS: { id: string; name: string; bed: [number, number, number]; nozzles: number[] }[] = [
  { id: 'bbl-a1', name: 'Bambu Lab A1 combo', bed: [256, 256, 256], nozzles: [0.4] },
  { id: 'bbl-p1s', name: 'Bambu Lab P1S combo', bed: [256, 256, 250], nozzles: [0.4] },
  { id: 'snapmaker-u1', name: 'Snapmaker U1', bed: [270, 270, 270], nozzles: [0.4] },
  { id: 'elegoo-n4max', name: 'Elegoo Neptune 4 Max', bed: [420, 420, 480], nozzles: [0.4, 1.0] },
];

/** What a nozzle can physically lay down. A bead can't be much wider than ~2× the nozzle or narrower than
 *  ~0.6×, layers stay within 20–75 % of the nozzle, and no detail (motion wave, relief cell) can be finer
 *  than about 2.5 line widths. */
export interface NozzleLimits { d: number; lineMin: number; lineMax: number; lineDef: number; layerMin: number; layerMax: number; layerDef: number; beadMin: number; beadMax: number; minFeature: number; flow: number; speedDef: number }
export function nozzleLimits(d: number, printer = ''): NozzleLimits {
  const big = d >= 0.8;
  const hotend: Record<string, number> = { 'bbl-a1': 21, 'bbl-p1s': 21, 'snapmaker-u1': 20, 'elegoo-n4max': big ? 32 : 18 };
  const r2 = (v: number) => Math.round(v * 100) / 100;
  return {
    d, lineMin: r2(d * 0.85), lineMax: r2(d * 1.6), lineDef: r2(d * (big ? 1.1 : 1.125)),
    layerMin: r2(d * 0.2), layerMax: r2(d * 0.75), layerDef: r2(d * (big ? 0.5 : 0.5)),
    beadMin: r2(d * 0.6), beadMax: r2(d * 2), minFeature: r2(d * 1.125 * 2.5),
    flow: hotend[printer] ?? (big ? 30 : 18), speedDef: big ? 25 : 40,
  };
}


/** Lines per layer for the design's wall thickness. */
export const wallLines = (d: Design, s: SliceSettings) => Math.max(1, Math.round(d.wall / Math.max(0.1, s.lineWidth)));

export function newZone(brushId: string, from = 0, to = 1): MotionZone {
  return { id: Math.random().toString(36).slice(2, 9), enabled: true, brushId, from, to, size: 1, spacing: 1, phase: 0, layers: null, useBrushLayers: true, fade: 1 };
}

/** One move. h/w: nominal bead height and width (w includes flow), e: filament mm, ret: travel with retraction, layer: layer index. */
export interface Seg { x0: number; y0: number; z0: number; x: number; y: number; z: number; kind: 'wall' | 'motion' | 'base' | 'top' | 'inner' | 'travel'; speed: number; flow: number; h: number; w: number; e: number; ret: boolean; layer: number; ruled: boolean; rule: number; gl?: number }
export interface GenResult {
  gcode: string; segs: Seg[]; layers: number; layerStart: number[]; layerZ: number[];
  stats: { lengthMm: number; filamentMm: number; grams: number; seconds: number; lines: number; maxOffset: number };
  warnings: string[];
  /** Planned filament per move before flow compensation (set by compensate). */
  plan?: number[];
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

export function slice(design: Design, s0: SliceSettings, zones: MotionZone[], brushes: (id: string) => MotionBrush | undefined, rules: Rule[] = []): GenResult {
  if (design.family === 'coaster') return { gcode: '', segs: [], layers: 1, layerStart: [0], layerZ: [0], warnings: ['Coaster sets are not sliced in Motionex yet: use Export model (STL) and slice the plates and case in your usual slicer.'], stats: { lengthMm: 0, filamentMm: 0, grams: 0, seconds: 0, lines: 0, maxOffset: 0 } };
  // Keep every setting within what the nozzle can print (a 1 mm nozzle cannot lay a 5 mm bead).
  const NZ = nozzleLimits(s0.nozzle ?? 0.4, s0.printer);
  const clampN = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
  const s: SliceSettings = { ...s0, lineWidth: clampN(s0.lineWidth, NZ.lineMin, NZ.lineMax), layerHeight: clampN(s0.layerHeight, NZ.layerMin, NZ.layerMax), firstLayerHeight: clampN(s0.firstLayerHeight, NZ.layerMin, NZ.layerMax) };
  let beadClamped = 0, periodClamped = false;
  const out: string[] = [], segs: Seg[] = [], layerStart: number[] = [], layerZ: number[] = [], warnings: string[] = [];
  const surfRaw = makeSurface(design);
  const H = design.height;
  const surf = s.flip ? (z: number, th: number) => surfRaw(H - z, th) : surfRaw;
  const cx = s.bedX / 2, cy = s.bedY / 2;
  const fa = Math.PI * (s.filamentDia / 2) ** 2;
  let x = cx, y = cy, z = 0, eTot = 0, len = 0, secs = 0, maxOff = 0, curLayer = 0, curRuled = false, curRule = -1;
  // Moves are merged while they stay on a straight line (within 0.01 mm) with the same bead, speed and
  // rule, so a smooth wall becomes a few long moves instead of thousands of tiny ones: smaller G-code,
  // faster slicing, physics and preview. Detail (motions, reliefs) keeps every point it needs.
  const TOL = 0.01;
  let pend: { s: Seg; pts: number[]; sp: number } | null = null;
  const flush = () => {
    if (!pend) return;
    const g = pend.s, d = Math.hypot(g.x - g.x0, g.y - g.y0, g.z - g.z0);
    const e = (d * g.h * g.w) / fa;
    g.e = e; eTot += e; len += d; secs += d / pend.sp;
    g.gl = out.length;
    out.push(`G1 X${f3(g.x)} Y${f3(g.y)}${Math.abs(g.z - g.z0) > 1e-6 ? ` Z${f3(g.z)}` : ''} E${f5(e)} F${Math.round(pend.sp * 60)}`);
    segs.push(g);
    pend = null;
  };
  const emit = (l: string) => { flush(); out.push(l); };
  const volCap = (h: number, w: number) => s.maxVolumetric / (h * w);

  const travel = (nx: number, ny: number, nz = z) => {
    const d = Math.hypot(nx - x, ny - y, nz - z);
    if (d < 1e-4) return;
    const r = s.retract > 0 && d > 2;
    if (r) emit(`G1 E-${f3(s.retract)} F2400`);
    emit(`G0 X${f3(nx)} Y${f3(ny)}${nz !== z ? ` Z${f3(nz)}` : ''} F${Math.round(s.travelSpeed * 60)}`);
    const ugl = out.length;
    if (r) emit(`G1 E${f3(s.retract)} F2400`);
    segs.push({ gl: r ? ugl : undefined, x0: x, y0: y, z0: z, x: nx, y: ny, z: nz, kind: 'travel', speed: s.travelSpeed, flow: 0, h: 0, w: 0, e: 0, ret: r, layer: curLayer, ruled: false, rule: -1 });
    secs += d / s.travelSpeed; x = nx; y = ny; z = nz;
  };
  const extrude = (nx: number, ny: number, nz: number, h: number, w: number, speed: number, flow0: number, kind: Seg['kind']) => {
    const bead = w * flow0 * s.flowRatio;
    const flow = bead > NZ.beadMax ? NZ.beadMax / (w * s.flowRatio) : bead < NZ.beadMin && flow0 > 0.05 ? NZ.beadMin / (w * s.flowRatio) : flow0;
    if (flow !== flow0) beadClamped++;
    const d = Math.hypot(nx - x, ny - y, nz - z);
    if (d < 1e-4) return;
    const sp = Math.min(speed, volCap(h, w * flow));
    const bw = w * flow * s.flowRatio;
    if (pend) {
      const g = pend.s;
      if (g.kind === kind && g.h === h && Math.abs(g.w - bw) < 0.004 && Math.abs(pend.sp - sp) < 0.5 && g.ruled === curRuled && g.rule === curRule && g.layer === curLayer && pend.pts.length < 240) {
        // every point merged so far must stay within TOL of the new straight move
        const ax = g.x0, ay = g.y0, az = g.z0, dx = nx - ax, dy = ny - ay, dz = nz - az, L2 = dx * dx + dy * dy + dz * dz;
        let ok = L2 > 0;
        const pts = pend.pts;
        pts.push(x, y, z);                  // the current end becomes an inner point of the merged move
        for (let i = 0; ok && i < pts.length; i += 3) {
          const px = pts[i] - ax, py = pts[i + 1] - ay, pz = pts[i + 2] - az, t = (px * dx + py * dy + pz * dz) / L2;
          if (t <= 0 || t >= 1) { ok = false; break; }
          const ex = px - t * dx, ey = py - t * dy, ez = pz - t * dz;
          if (ex * ex + ey * ey + ez * ez > TOL * TOL) ok = false;
        }
        if (ok) { g.x = nx; g.y = ny; g.z = nz; x = nx; y = ny; z = nz; return; }
        pts.length -= 3;
      }
      flush();
    }
    pend = { s: { x0: x, y0: y, z0: z, x: nx, y: ny, z: nz, kind, speed: sp, flow, h, w: bw, e: 0, ret: false, layer: curLayer, ruled: curRuled, rule: curRule }, pts: [], sp };
    x = nx; y = ny; z = nz;
  };

  const lh = Math.max(0.05, s.layerHeight), flh = Math.max(0.05, s.firstLayerHeight);
  const nLayers = Math.max(1, 1 + Math.ceil((H - flh) / lh - 1e-6));
  const active = zones.filter((zn) => zn.enabled && brushes(zn.brushId));
  const minPeriod = Math.min(4, ...active.map((zn) => brushes(zn.brushId)!.period_mm * zn.spacing), ...rules.filter((r) => r.enabled && r.brushId && brushes(r.brushId)).map((r) => brushes(r.brushId!)!.period_mm * r.spacing));
  const res0 = minPeriod < 4 || active.length ? Math.min(0.6, Math.max(0.15, minPeriod / 20)) : 0.6;
  const reliefCell = design.relief.kind !== 'smooth' && design.relief.depth !== 0 ? (TAU * design.maxDiameter / 2) / Math.max(1, design.relief.count) * Math.min(1, design.relief.aspect ?? 1) : Infinity;
  const res = Math.min(res0, Math.max(0.12, reliefCell / 28));

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

  let curTemp = s.nozzleTemp;
  const walls = wallLines(design, s);
  if (s.spiral && walls > 1) warnings.push(`Spiral vase needs a single-line wall: this ${design.wall} mm wall prints as ${walls} lines per layer, so it is sliced layer by layer.`);
  const innerRaw = makeInner(design);
  const inner = s.flip ? (z: number, th: number) => innerRaw(H - z, th) : innerRaw;
  /** Wall line k (0 = outer) as a real slicer lays it out: the outer half of the lines follows the outer face,
   *  the inner half follows the inner face, and the middle line widens or narrows (flow) to fill what is left,
   *  so each face keeps its exact shape and no half-strength copy of the relief appears in between. */
  const wallFlow: number[][] = [];
  const wallLoop = (zz: number, nn: number, k: number): [number, number][] => {
    const w = s.lineWidth, out: [number, number][] = [], fl: number[] = [];
    const m = Math.ceil(walls / 2);            // lines 0..m-1 hug the outer face
    for (let i = 0; i < nn; i++) {
      const th = (i / nn) * TAU, ro = surf(zz, th), ri = walls === 1 ? ro - w : inner(zz, th);
      let r = ro - w / 2, f = 1;
      if (walls > 1) {
        const gap = (ro - ri) - walls * w;     // + : extra room, − : squeezed (relief cuts in)
        if (k < m) r = ro - w / 2 - k * w; else r = ri + w / 2 + (walls - 1 - k) * w;
        if (k === m - 1 || k === m) { r += (k === m - 1 ? -1 : 1) * gap / 4; f = Math.min(2.5, Math.max(0.15, 1 + gap / (2 * w))); }
      }
      fl.push(f);
      out.push([Math.max(0.3, r) * Math.cos(th), Math.max(0.3, r) * Math.sin(th)]);
    }
    wallFlow[k] = fl;
    return out;
  };

  const isBaseLayer = (li: number) => li < baseOn;
  const baseOn = !design.openBottom && !s.flip ? s.baseLayers : design.openBottom ? 0 : s.baseLayers;
  for (let li = 0; li < nLayers; li++) {
    const zTop = li === 0 ? flh : Math.min(H, flh + li * lh);
    const h = li === 0 ? flh : lh;
    const speed = li === 0 ? s.firstLayerSpeed : s.speed;
    flush();
    layerStart.push(segs.length); layerZ.push(zTop); curLayer = li;
    const zd = s.flip ? H - zTop : zTop;
    const prep = prepareRules(rules, zd, s.reachLayerHeight ?? lh);
    const kindOk = (p: PreparedRule, k: 'outer' | 'inner' | 'base' | 'top', wi: number) => !!p.rule.lines[k] && (k !== 'inner' || (wi >= (p.rule.lines.innerFrom ?? 1) && wi <= (p.rule.lines.innerTo ?? 99)));
    /** Rule effect at a point: speed / flow multipliers, the strongest motion rule and its weight. */
    const ruleAt = (k: 'outer' | 'inner' | 'base' | 'top', a: number, r: number, curved: boolean, wi: number) => {
      let sp = 1, fl = 1, mw = 0, mr: Rule | null = null, any = false, idx = -1;
      for (const p of prep) {
        if (!kindOk(p, k, wi)) continue;
        if (p.rule.wallShape !== 'all' && (p.rule.wallShape === 'curved') !== curved) continue;
        const w = ruleWeight(p, zd, a, r); if (w <= 0) continue;
        any = true; if (w >= 0.5) idx = rules.indexOf(p.rule);
        if (p.rule.speed != null) sp = sp * (1 - w) + (p.rule.speed / 100) * w;
        if (p.rule.flow != null) fl = fl * (1 - w) + (p.rule.flow / 100) * w;
        if (p.rule.brushId && (k === 'outer' || k === 'inner')) { mr = p.rule; mw = w; }
      }
      return { sp, fl, mr, mw, any, idx };
    };
    {
      let t = s.nozzleTemp;
      for (const p of prep) if (p.rule.temp != null && p.pos.some((q) => zd >= q.z0 - p.lo && zd <= q.z1 + p.hi)) t = p.rule.temp;
      if (t !== curTemp) { emit(`M104 S${Math.round(t)}`); curTemp = t; }
    }
    emit(';LAYER_CHANGE'); emit(`;LAYER:${li}`); emit(`;Z:${f3(zTop)}`); emit(`M73 P${Math.round((li / nLayers) * 100)}`);
    if (li === 1) emit(`M106 S${Math.round((s.fan / 100) * 255)}`);
    const isTop = !isBaseLayer(li) && s.topLayers > 0 && li >= nLayers - s.topLayers && !s.flip;
    const isBase = li < baseOn || isTop;
    const spiralNow = s.spiral && walls === 1 && !isBase && li > 0;
    const t = zTop / H;

    // walls: N lines from the outer surface to the inner surface (wall thickness / line width)
    const zone = active.find((zn) => t >= zn.from - 1e-9 && t <= zn.to + 1e-9) ?? null;
    const brush = zone ? brushes(zone.brushId)! : null;
    const amp = brush ? brush.amplitude * zone!.size : 0, zamp = brush ? (brush.z_amplitude ?? 0) * zone!.size : 0;
    const period = brush ? Math.max(NZ.minFeature, brush.period_mm * zone!.spacing) : 1;
    if (brush && brush.period_mm * zone!.spacing < NZ.minFeature) periodClamped = true;
    const approxR = profileR(design, s.flip ? 1 - t : t) * design.maxDiameter / 2;
    const n = Math.max(120, Math.ceil((TAU * approxR) / res));
    const loops: [number, number][][] = [];
    for (let k = 0; k < walls; k++) loops.push(wallLoop(zTop, n, k));
    const outer = loops[0];
    let L = 0; for (let i = 0; i < n; i++) { const a = outer[i], b = outer[(i + 1) % n]; L += Math.hypot(b[0] - a[0], b[1] - a[1]); }
    // whole number of repeats per loop, so the motion meets itself seamlessly where the loop closes
    const reps = Math.max(1, Math.round(L / period));
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
    const zoneOn = (k: number) => { const ln = zone?.lines ?? { outer: true, inner: false, innerFrom: 1, innerTo: 99 }; return k === 0 ? ln.outer : ln.inner && k >= ln.innerFrom && k <= ln.innerTo; };

    // inner lines first, outer wall last (cleanest outside)
    for (let k = walls - 1; k >= 0; k--) {
      const loop = loops[k];
      const lk: 'outer' | 'inner' = k === 0 ? 'outer' : 'inner';
      let Lk = 0; for (let i = 0; i < n; i++) { const a = loop[i], b = loop[(i + 1) % n]; Lk += Math.hypot(b[0] - a[0], b[1] - a[1]); }
      const zOnK = zoneOn(k);
      let acc = 0;
      for (let i = 0; i <= n; i++) {
        const p = loop[i % n], pn = loop[(i + 1) % n], pp = loop[(i - 1 + n) % n];
        if (i > 0) acc += Math.hypot(p[0] - pp[0], p[1] - pp[1]);
        const along = Lk > 0 ? acc / Lk : 0;           // 0..1 round the loop: same phase on every line
        let tx = pn[0] - pp[0], ty = pn[1] - pp[1]; const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
        const nx = ty, ny = -tx;
        let ox = 0, oy = 0, oz = 0, flow = 1, sp = 1;
        let moving = false;
        const wf = wallFlow[k]?.[i % n] ?? 1;
        if (brush && fade > 0 && zOnK) {
          const u = frac(along * reps + phase);
          const lat = evalCurve(brush.curves.lateral_offset, u) * amp * fade, al = evalCurve(brush.curves.along_offset, u) * amp * fade;
          oz = evalCurve(brush.curves.z_offset, u) * zamp * fade;
          flow = Math.min(brush.limits.max_flow_mult, Math.max(brush.limits.min_flow_mult, 1 + (evalCurve(brush.curves.extrusion_mult, u) - 1) * fade));
          sp = Math.max(0.1, 1 + (evalCurve(brush.curves.speed_mult, u) - 1) * fade);
          ox = nx * lat + tx * al; oy = ny * lat + ty * al;
          maxOff = Math.max(maxOff, Math.hypot(lat, al));
          moving = true;
        }
        curRuled = false; curRule = -1;
        if (prep.length && li >= Math.max(1, baseOn)) {
          const ax = p[0] - pp[0], ay = p[1] - pp[1], bx = pn[0] - p[0], by = pn[1] - p[1];
          const turn = Math.abs(Math.atan2(ax * by - ay * bx, ax * bx + ay * by)) / Math.max(1e-6, (Math.hypot(ax, ay) + Math.hypot(bx, by)) / 2);
          const q = ruleAt(lk, frac(Math.atan2(p[1], p[0]) / TAU), Math.hypot(p[0], p[1]), turn > 1 / 150, k);
          curRuled = q.any; curRule = q.idx;
          sp *= q.sp; flow *= q.fl;
          if (q.mr && q.mw > 0) {
            const rb = brushes(q.mr.brushId!);
            if (rb) {
              const rp = Math.max(NZ.minFeature, rb.period_mm * q.mr.spacing); if (rb.period_mm * q.mr.spacing < NZ.minFeature) periodClamped = true;
              const rr = Math.max(1, Math.round(L / rp));
              const eff = q.mr.useBrushLayers ? rb.layers ?? null : q.mr.layers;
              const lp = effectPhase(eff, li);
              if (lp !== null) {
                const u = frac(along * rr + ((rb.phase_deg ?? 0) + q.mr.phase + (eff?.cross && li % 2 ? -lp : lp)) / 360);
                const ra = rb.amplitude * q.mr.size, w = q.mw;
                const lat = evalCurve(rb.curves.lateral_offset, u) * ra, al = evalCurve(rb.curves.along_offset, u) * ra;
                ox = ox * (1 - w) + (nx * lat + tx * al) * w; oy = oy * (1 - w) + (ny * lat + ty * al) * w;
                oz = oz * (1 - w) + evalCurve(rb.curves.z_offset, u) * (rb.z_amplitude ?? 0) * q.mr.size * w;
                flow = flow * (1 - w) + Math.min(rb.limits.max_flow_mult, Math.max(rb.limits.min_flow_mult, evalCurve(rb.curves.extrusion_mult, u))) * q.fl * w;
                sp = sp * (1 - w) + Math.max(0.1, evalCurve(rb.curves.speed_mult, u)) * q.sp * w;
                maxOff = Math.max(maxOff, Math.hypot(lat, al) * w);
                moving = true;
              }
            }
          }
        }
        const zz = spiralNow ? zTop - h + h * along : zTop;
        const px = cx + p[0] + ox, py = cy + p[1] + oy, pz = Math.max(0.05, zz + oz);
        if (i === 0) { travel(px, py, spiralNow ? z : zTop); continue; }
        extrude(px, py, pz, h, s.lineWidth, speed * sp, flow * wf, k > 0 ? 'inner' : moving ? 'motion' : 'wall');
      }
    }
    curRuled = false; curRule = -1;

    // solid bottom / top: rings inside the innermost wall line
    if (isBase && !spiralNow) {
      const inner = wallLoop(zTop, 240, walls - 1);
      let r0 = 0; for (const [px, py] of inner) r0 = Math.max(r0, Math.hypot(px, py));
      const kind = isTop ? 'top' : 'base';
      for (let j = 1; j * s.lineWidth < r0 - s.lineWidth / 2; j++) {
        const ring = inset(inner, j * s.lineWidth);
        travel(cx + ring[0][0], cy + ring[0][1], zTop);
        for (let i = 1; i <= ring.length; i++) {
          const p = ring[i % ring.length];
          let sp = 1, fl = 1;
          if (prep.length) { const q = ruleAt(kind, frac(Math.atan2(p[1], p[0]) / TAU), Math.hypot(p[0], p[1]), true, 0); sp = q.sp; fl = q.fl; curRuled = q.any; curRule = q.idx; }
          extrude(cx + p[0], cy + p[1], zTop, h, s.lineWidth, speed * sp, fl, kind);
        }
        curRuled = false; curRule = -1;
      }
    }
  }
  emit(`; filament used: ${(eTot / 1000).toFixed(3)} m`);
  for (const l of s.endGcode.replace('{bedY_minus10}', String(s.bedY - 10)).split('\n')) emit(l);
  if (beadClamped) warnings.push(`${beadClamped} moves asked for a bead the ${NZ.d} mm nozzle can't lay (${NZ.beadMin}–${NZ.beadMax} mm wide); they were limited.`);
  if (periodClamped) warnings.push(`A motion repeats faster than the ${NZ.d} mm nozzle can draw; it was stretched to at least ${NZ.minFeature} mm per wave.`);
  if (design.relief.kind !== 'smooth' && design.relief.depth !== 0 && (Math.PI * design.maxDiameter) / Math.max(1, design.relief.count) < NZ.minFeature * 1.5) warnings.push(`The relief is finer than the ${NZ.d} mm nozzle can show: use a lower count.`);
  if (s0.lineWidth !== s.lineWidth || s0.layerHeight !== s.layerHeight) warnings.push(`Line width / layer height were kept within the ${NZ.d} mm nozzle's range.`);
  if (!segs.length) warnings.push('Nothing to print: the layer height is taller than the piece.');
  flush();
  return { gcode: out.join('\n') + '\n', segs, layers: nLayers, layerStart, layerZ, warnings,
    stats: { lengthMm: len, filamentMm: eTot, grams: (eTot * fa) / 1000 * 1.24, seconds: secs, lines: out.length, maxOffset: maxOff } };
}

/** Motion curve samples for library thumbnails. */
export function motionSamples(b: MotionBrush, n = 96): [number, number][] {
  const r: [number, number][] = [];
  for (let i = 0; i <= n; i++) { const u = (i / n) * 2; r.push([u + evalCurve(b.curves.along_offset, frac(u)) * 0.25, evalCurve(b.curves.lateral_offset, frac(u))]); }
  return r;
}

const KINDS: Seg['kind'][] = ['wall', 'motion', 'base', 'top', 'inner', 'travel'];
/** Pack moves into flat typed arrays (fast to hand from a Web Worker to the page; no object copying). */
export function packSegs(segs: Seg[]) {
  const n = segs.length, f = new Float32Array(n * 11), i32 = new Int32Array(n * 3), u8 = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    const g = segs[i], o = i * 11;
    f[o] = g.x0; f[o + 1] = g.y0; f[o + 2] = g.z0; f[o + 3] = g.x; f[o + 4] = g.y; f[o + 5] = g.z; f[o + 6] = g.speed; f[o + 7] = g.flow; f[o + 8] = g.h; f[o + 9] = g.w; f[o + 10] = g.e;
    i32[i * 3] = g.layer; i32[i * 3 + 1] = g.rule; i32[i * 3 + 2] = g.gl ?? -1;
    u8[i * 3] = KINDS.indexOf(g.kind); u8[i * 3 + 1] = g.ret ? 1 : 0; u8[i * 3 + 2] = g.ruled ? 1 : 0;
  }
  return { n, f, i32, u8 };
}
export function unpackSegs(p: ReturnType<typeof packSegs>): Seg[] {
  const { n, f, i32, u8 } = p, out = new Array<Seg>(n);
  for (let i = 0; i < n; i++) {
    const o = i * 11, gl = i32[i * 3 + 2];
    out[i] = { x0: f[o], y0: f[o + 1], z0: f[o + 2], x: f[o + 3], y: f[o + 4], z: f[o + 5], speed: f[o + 6], flow: f[o + 7], h: f[o + 8], w: f[o + 9], e: f[o + 10],
      layer: i32[i * 3], rule: i32[i * 3 + 1], gl: gl >= 0 ? gl : undefined, kind: KINDS[u8[i * 3]], ret: u8[i * 3 + 1] === 1, ruled: u8[i * 3 + 2] === 1 };
  }
  return out;
}
