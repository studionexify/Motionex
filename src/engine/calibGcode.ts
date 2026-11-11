// G-code calibration programs that are drawn directly rather than sliced from a model:
// Calib.cpp: the pressure advance Line test (CalibPressureAdvanceLine) and Pattern test (CalibPressureAdvancePattern).
import type { Config } from '../profiles/settings';
import { emit, type LayerOps, type Op } from './gcode';
import type { FeatureType, FilamentSlot, SliceOutput } from './types';

export interface CalibProgram {
  kind: 'pa_line' | 'pa_pattern';
  start: number;
  end: number;
  step: number;
}

const paLine = (flavor: string, k: number) => (flavor === 'klipper' ? `SET_PRESSURE_ADVANCE ADVANCE=${k}` : `M900 K${k}`);

/** Cross-section of an extrusion (a rectangle with round ends). */
const xsArea = (w: number, h: number) => (w - h) * h + Math.PI * (h / 2) ** 2;

/** Fixed notation without trailing zeros. */
export const numberText = (v: number) => {
  const s = v.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' ? '0' : s;
};

/** Pen that turns drawing calls into move ops. */
class Pen {
  ops: Op[] = [];
  x = 0; y = 0;
  constructor(private z: number, private h: number, private ePerMm: (w: number) => number, private travelF: number) {}
  travel(x: number, y: number, z = this.z) {
    this.ops.push({ k: 'move', x, y, z, e: 0, f: this.travelF, feature: 'travel', w: 0, h: this.h, travel: true });
    this.x = x; this.y = y;
  }
  lift(z: number) { this.z = z; this.ops.push({ k: 'move', x: this.x, y: this.y, z, e: 0, f: 10, feature: 'travel', w: 0, h: this.h, travel: true, fixed: true }); }
  line(x: number, y: number, w: number, f: number, feature: FeatureType = 'outer_wall', e?: number) {
    const len = Math.hypot(x - this.x, y - this.y);
    if (len < 1e-6) return;
    this.ops.push({ k: 'move', x, y, z: this.z, e: e ?? len * this.ePerMm(w), f, feature, w, h: this.h, travel: false, fixed: true, noSlow: true });
    this.x = x; this.y = y;
  }
  raw(text: string) { this.ops.push({ k: 'raw', text }); }
  setZ(z: number, h: number) { this.z = z; this.h = h; }
}

type DigitMode = 'ltr' | 'btt';
const SEG = 2, GAP = 1, SPACING = SEG + GAP, MAX_LEN = 5;

/** One 7-segment-style glyph exactly as Calib.cpp strokes it. */
function drawDigit(pen: Pen, sx: number, sy: number, c: string, mode: DigitMode, w: number, f: number) {
  const len = SEG, gap = w / 2;
  let p0, p0_5, p1, p2, p3, p4, p4_5, p5, g03, g23, dot;
  if (mode === 'btt') {
    p0 = [sx, sy]; p0_5 = [sx, sy + len / 2]; p1 = [sx, sy + len]; p2 = [sx + len, sy + len]; p3 = [sx + len, sy];
    p4 = [sx + len * 2, sy]; p4_5 = [sx + len * 2, sy + len / 2]; p5 = [sx + len * 2, sy + len];
    g03 = [p0[0] + gap, p0[1]]; g23 = [p2[0], p2[1] + gap]; dot = [-len / 2, 0];
  } else {
    p0 = [sx, sy]; p0_5 = [sx + len / 2, sy]; p1 = [sx + len, sy]; p2 = [sx + len, sy - len]; p3 = [sx, sy - len];
    p4 = [sx, sy - len * 2]; p4_5 = [sx + len / 2, sy - len * 2]; p5 = [sx + len, sy - len * 2];
    g03 = [p0[0], p0[1] - gap]; g23 = [p2[0] - gap, p2[1]]; dot = [0, len / 2];
  }
  const mv = (p: number[]) => pen.travel(p[0], p[1]);
  const ln = (p: number[]) => pen.line(p[0], p[1], w, f, 'outer_wall');
  switch (c) {
    case '0': mv(p0); ln(p1); ln(p5); ln(p4); ln(g03); break;
    case '1': mv(p0_5); ln(p4_5); break;
    case '2': mv(p0); ln(p1); ln(p2); ln(p3); ln(p4); ln(p5); break;
    case '3': mv(p0); ln(p1); ln(p5); ln(p4); mv(g23); ln(p3); break;
    case '4': mv(p0); ln(p3); ln(p2); mv(p1); ln(p5); break;
    case '5': mv(p1); ln(p0); ln(p3); ln(p2); ln(p5); ln(p4); break;
    case '6': mv(p1); ln(p0); ln(p4); ln(p5); ln(p2); ln(p3); break;
    case '7': mv(p0); ln(p1); ln(p5); break;
    case '8': mv(p2); ln(p3); ln(p4); ln(p5); ln(p1); ln(p0); ln(p3); break;
    case '9': mv(p5); ln(p1); ln(p0); ln(p3); ln(p2); break;
    case '.': mv(p4_5); ln([p4_5[0] + dot[0], p4_5[1] + dot[1]]); break;
  }
}
function drawNumber(pen: Pen, sx: number, sy: number, v: number, mode: DigitMode, w: number, f: number) {
  const s = numberText(v);
  for (let i = 0; i < s.length && i <= MAX_LEN; i++) {
    if (mode === 'btt') drawDigit(pen, sx, sy + i * SPACING, s[i], mode, w, f);
    else drawDigit(pen, sx + i * SPACING, sy, s[i], mode, w, f);
  }
}

/** Perimeters of a box, then (optionally) a 45° fill inside, as Calib.cpp's draw_box. */
function drawBox(pen: Pen, x0: number, y0: number, sx: number, sy: number, o: { perims: number; h: number; w: number; f: number; filled: boolean }) {
  const spacing = o.w - o.h * (1 - Math.PI / 4);
  const s45 = Math.sin(Math.PI / 4);
  const maxPer = Math.min(Math.floor(sx * s45) / (spacing / s45), Math.floor(sy * s45) / (spacing / s45));
  const perims = Math.max(1, Math.min(o.perims, Math.floor(maxPer)));
  let x = x0, y = y0;
  pen.travel(x, y);
  for (let i = 0; i < perims; i++) {
    if (i) { x += spacing; y += spacing; pen.travel(x, y); }
    y += sy - i * spacing * 2; pen.line(x, y, o.w, o.f);
    x += sx - i * spacing * 2; pen.line(x, y, o.w, o.f);
    y -= sy - i * spacing * 2; pen.line(x, y, o.w, o.f);
    x -= sx - i * spacing * 2; pen.line(x, y, o.w, o.f);
  }
  if (!o.filled) return;
  // 45° zig-zag fill inside the perimeters 
  const b = spacing * (perims - 1) + o.w * (1 - 1 / 3);
  const ax = x0 + b, bx = x0 + sx - b, ay = y0 + b, by = y0 + sy - b;
  if (bx <= ax || by <= ay) return;
  const d = spacing / s45;
  let flip = false;
  for (let c = ax - (by - ay) + d; c < bx; c += d) {
    // line x - y = c - ay, clipped to the rectangle
    const xa = Math.max(ax, c), ya = ay + (xa - c);
    const xb = Math.min(bx, c + (by - ay)), yb = ay + (xb - c);
    if (xb - xa < 0.05) continue;
    const [s, e] = flip ? [[xb, yb], [xa, ya]] : [[xa, ya], [xb, yb]];
    pen.travel(s[0], s[1]); pen.line(e[0], e[1], o.w, o.f, 'internal_solid_infill');
    flip = !flip;
  }
}

/** Build the program's layers and emit it like a sliced plate. */
export function calibProgram(cfg: Config, filaments: FilamentSlot[], p: CalibProgram): SliceOutput {
  const num = (k: string, d = 0) => { const v = Number(cfg[k]); return isFinite(v) && v !== 0 ? v : d; };
  const nozzle = num('nozzle_diameter', 0.4);
  const filArea = Math.PI * (num('filament_diameter', 1.75) / 2) ** 2;
  const flow = num('print_flow_ratio', 1) * num('filament_flow_ratio', 1);
  const flavor = String(cfg.gcode_flavor);
  const bowden = false;
  const bedX = num('bed_x', 220), bedY = num('bed_y', 220);
  const travelF = num('travel_speed', 150);
  const pa = (k: number) => ({ k: 'raw' as const, text: `${paLine(flavor, +k.toFixed(4))} ; pressure advance ${numberText(k)}` });
  const count0 = Math.max(1, Math.ceil((p.end - p.start) / p.step + 1 - 1e-9));
  const layers: LayerOps[] = [];
  const mkPen = (z: number, h: number) => new Pen(z, h, (w) => (xsArea(w, h) / filArea) * flow, travelF);

  if (p.kind === 'pa_line') {
    // CalibPressureAdvanceLine: 0.2 mm layer, 0.6 mm lines 3.5 mm apart; 20 mm slow, 40 mm fast, 20 mm slow
    const H = 0.2, W = 0.6, NUMW = 0.48, SPACE = 3.5, SHORT = 20;
    const LONG = 40 + Math.min(bedX - 120, 0);
    const slow = 20, fast = 100;
    const count = Math.min(count0, Math.floor((bedY - 10) / SPACE));
    const sx = (bedX - SHORT * 2 - LONG - 20) / 2, sy = (bedY - count * SPACE) / 2;
    const pen = mkPen(H, H);
    pen.travel(sx, sy + count * SPACE, H);
    // prime line (1.2× flow)
    pen.line(sx, sy, W, slow, 'outer_wall', (xsArea(W, H) / filArea) * flow * SPACE * count * 1.2);
    for (let i = 0; i < count; i++) {
      pen.ops.push(pa(p.start + i * p.step));
      const y = sy + i * SPACE;
      pen.travel(sx, y);
      pen.line(sx + SHORT, y, W, slow);
      pen.line(sx + SHORT + LONG, y, W, fast);
      pen.line(sx + SHORT * 2 + LONG, y, W, slow);
    }
    pen.ops.push(pa(bowden ? 0.4 : 0));
    // number tab: a filled box beside the lines, numbers on every second line one layer up
    const boxX = sx + SHORT * 2 + LONG;
    drawBox(pen, boxX, sy - SPACE, SPACING * 8, (count + 1) * SPACE, { perims: 2, h: H, w: W, f: fast, filled: true });
    const top = mkPen(H * 2, H);
    for (let i = 0; i < count; i += 2) drawNumber(top, boxX + 3 + W, sy + i * SPACE + SPACE / 2, p.start + i * p.step, 'ltr', NUMW, 60);
    layers.push({ z: H, h: H, ops: pen.ops, fan: 0, layer: 0, tool: 0 });
    layers.push({ z: H * 2, h: H, ops: top.ops, fan: 0, layer: 1, tool: 0 });
  } else {
    // CalibPressureAdvancePattern: 4 layers of nested 90° chevrons (30 mm sides), one per PA value, numbered tab above
    const h1 = Math.abs(nozzle - 0.2) < 1e-6 ? 0.2 : 0.25, h = 0.2;
    const w = nozzle * 1.125, w1 = nozzle * 1.4;
    const walls = 3, side = 30, ang = Math.PI / 4, patSpacing = 2;
    const sp = w - h * (1 - Math.PI / 4), sp1 = w1 - h1 * (1 - Math.PI / 4), spAng = sp / Math.sin(ang);
    const fFirst = 30, fPer = num('outer_wall_speed', 200);
    const n = count0;
    const shift = (walls - 1) * sp1 + w1 + 1;
    const objX = n * ((walls - 1) * spAng) + (n - 1) * (patSpacing + w) + Math.cos(ang) * side + sp1 * walls;
    let mostChars = 0;
    for (let i = 0; i < n; i += 2) mostChars = Math.max(mostChars, numberText(p.start + i * p.step).length);
    mostChars = Math.min(mostChars, MAX_LEN);
    const numH = mostChars * SEG + (mostChars - 1) * GAP;
    const frameY = Math.sin(ang) * side * 2;
    const sizeX = objX + shift, sizeY = frameY + numH + 2 + w1;
    const x0 = (bedX - sizeX) / 2, y0 = (bedY - sizeY) / 2;
    const glyphX = (j: number) => x0 + shift + j * (walls - 1) * spAng + j * w + j * patSpacing + (walls * spAng) / 2 - (w + 2 * SEG) / 2;
    const maxNum = n % 2 === 0 ? n - 1 : n;
    const tabMaxX = glyphX(maxNum - 1) + (w + 2 * SEG - w / 2) + (glyphX(0) - x0);
    for (let i = 0; i < 4; i++) {
      const z = h1 + i * h, lh = i ? h : h1;
      const pen = mkPen(z, lh);
      if (i === 0) {
        pen.travel(x0, y0, z);
        pen.ops.push(pa(p.start));
        drawBox(pen, x0, y0, sizeX, frameY, { perims: walls, h: h1, w: w1, f: fFirst, filled: false });
        drawBox(pen, x0, y0 + frameY + sp1, tabMaxX - x0, numH + sp1 + 2, { perims: walls, h: h1, w: w1, f: fFirst, filled: true });
      }
      if (i === 1) {
        pen.ops.push(pa(p.start));
        for (let j = 0; j < n; j += 2) drawNumber(pen, glyphX(j), y0 + frameY + 1 + w, p.start + j * p.step, 'btt', w, fFirst);
      }
      let tx = x0 + shift, ty = y0, L = side;
      if (i === 0) {
        const shrink = (sp1 * (walls - 1) + w1 * (1 - 1 / 3)) / Math.sin(ang);
        L = side - shrink;
        tx += shrink * Math.sin(Math.PI / 2 - ang);
        ty += sp1 * (walls - 1) + w1 * (1 - 1 / 3);
      }
      const iy = ty;
      pen.lift(z + h); pen.travel(tx, ty, z + h); pen.lift(z);
      for (let j = 0; j < n; j++) {
        pen.ops.push(pa(p.start + j * p.step));
        for (let k = 0; k < walls; k++) {
          tx += Math.cos(ang) * L; ty += Math.sin(ang) * L;
          pen.line(tx, ty, w, i ? fPer : fFirst);
          tx -= Math.cos(ang) * L; ty += Math.sin(ang) * L;
          pen.line(tx, ty, w, i ? fPer : fFirst);
          ty = iy;
          if (k !== walls - 1) tx += spAng;
          else if (j !== n - 1) tx += patSpacing + w;
          else break;
          pen.lift(z + h); pen.travel(tx, ty, z + h); pen.lift(z);
        }
      }
      layers.push({ z, h: lh, ops: pen.ops, fan: 0, layer: i, tool: 0 });
    }
    layers[layers.length - 1].ops.push(pa(bowden ? 0.4 : p.start));
  }
  const res = emit({ cfg, filaments, layers, objectLabels: [] });
  return { ...res, warnings: [] };
}
