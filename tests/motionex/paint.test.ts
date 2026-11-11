// Velocity painting: pictures as outer wall speed, inside the real slicer.
import { describe, expect, it } from 'vitest';
import { slice, slotFromConfig } from '../../src/engine/slicer';
import { weld } from '../../src/engine/mesh';
import { resolveConfig } from '../../src/profiles/resolve';
import { cylinder } from '../fixtures';
import { defaultToolhead } from '../../src/plugins/motionex/core/toolhead';
import { DEFAULT_OPTIONS } from '../../src/plugins/motionex/modifier';
import type { MotionexConfig, MotionexReport } from '../../src/plugins/motionex/engine';
import { defaultPaint, paintLevels, speedLadder, speedOfLevel, type PaintSettings } from '../../src/plugins/motionex/paint/model';
import { paintPrintSettings } from '../../src/plugins/motionex/paint/plan';
import { motifImage } from '../../src/plugins/motionex/weave/motifs';

const CX = 128, CY = 128, R = 20;
const cfg = (o: Record<string, unknown> = {}, printerId = 'bbl-p1s') => resolveConfig({ printerId, plate: 'textured_pei_plate', filamentId: 'generic-pla', presetId: '0.20', overrides: o as never });
const paint = (p: Partial<PaintSettings> = {}): PaintSettings => ({ ...defaultPaint(), enabled: true, image: motifImage('checker', 16, 6, 2), z_start: 1.2, ...p });
const mx = (p: PaintSettings, printerId = 'bbl-p1s'): MotionexConfig => ({ applications: [], brushes: [], options: DEFAULT_OPTIONS, collisionMode: 'clamp', toolhead: defaultToolhead(printerId), printerId, paint: p });
const part = () => ({ id: 'vase', name: 'vase', ...weld(cylinder(CX, CY, R, 12, 128)) });

/** Outer wall extrusions above z0: [x0, y0, x1, y1, e, F mm/s]. */
function outerMoves(gcode: string, z0: number) {
  const out: [number, number, number, number, number, number][] = [];
  let z = 0, cur = '', x = NaN, y = NaN, f = 0;
  for (const l of gcode.split('\n')) {
    if (l.startsWith(';Z:')) z = +l.slice(3);
    if (l.startsWith(';TYPE:')) cur = l.slice(6);
    if (!/^G[0123] /.test(l)) continue;
    const g = (k: string) => { const m = new RegExp(`${k}(-?[\\d.]+)`).exec(l); return m ? +m[1] : NaN; };
    const px = x, py = y;
    if (!isNaN(g('X'))) x = g('X');
    if (!isNaN(g('Y'))) y = g('Y');
    if (!isNaN(g('F'))) f = g('F') / 60;
    if (cur === 'outer wall' && z > z0 && l.startsWith('G1') && g('E') > 0 && /[XY]/.test(l)) out.push([px, py, x, y, g('E'), f]);
  }
  return out;
}

describe('velocity paint', () => {
  it('spreads the grey levels evenly between the two speeds', () => {
    const p = paint({ speed_light: 40, speed_dark: 120, image: { w: 3, h: 1, px: [0, 1, 2] } });
    expect(paintLevels(p)).toBe(3);
    expect([0, 1, 2].map((k) => speedOfLevel(p, k))).toEqual([40, 80, 120]);
    expect(speedLadder(4, 2).px).toEqual([0, 1, 2, 3, 0, 1, 2, 3]);
  });

  it('prints the picture as outer wall speeds, with the same plastic per mm', () => {
    const c = cfg({ ...paintPrintSettings(paint()), enable_arc_fitting: true });
    const out = slice([part()], c, () => {}, { filaments: [slotFromConfig(c)], plugins: { motionex: mx(paint()) } });
    const rep = (out.pluginReports!.motionex as MotionexReport).paint!;
    expect(rep.paintedLayers).toBeGreaterThan(40);
    expect(rep.speeds).toEqual([40, 140]);
    const mv = outerMoves(out.gcode, 1.3);
    const speeds = new Set(mv.map((m) => Math.round(m[5])));
    expect([...speeds].sort()).toEqual([140, 40]);
    // both speeds take a fair share of the wall (a checker)
    const len = (m: typeof mv[number]) => Math.hypot(m[2] - m[0], m[3] - m[1]);
    const slow = mv.filter((m) => Math.round(m[5]) === 40).reduce((s, m) => s + len(m), 0), all = mv.reduce((s, m) => s + len(m), 0);
    expect(slow / all).toBeGreaterThan(0.35);
    expect(slow / all).toBeLessThan(0.65);
    // extrusion per mm unchanged by the cutting
    const epm = mv.filter((m) => len(m) > 0.3).map((m) => m[4] / len(m));
    const mean = epm.reduce((a, b) => a + b, 0) / epm.length;
    expect(Math.max(...epm.map((v) => Math.abs(v / mean - 1)))).toBeLessThan(0.05);
    // no arcs in the outer wall: one F per arc would flatten the picture
    const sections = out.gcode.split(';Z:1.4')[1].split(';TYPE:outer wall').slice(1).map((s) => s.split(';TYPE:')[0]);
    expect(sections.some((s) => /^G[23] /m.test(s))).toBe(false);
    expect(out.gcode).not.toMatch(/NaN|Infinity/);
  });

  it('keeps the picture in the same place on every layer (columns stack)', () => {
    const p = paint({ image: { w: 4, h: 1, px: [0, 1, 0, 1] } });
    const c = cfg({ ...paintPrintSettings(p), enable_arc_fitting: false });
    const out = slice([part()], c, () => {}, { filaments: [slotFromConfig(c)], plugins: { motionex: mx(p) } });
    // angle of each fast stretch's middle, per layer: same quarters on every layer
    const mv = outerMoves(out.gcode, 1.3);
    const quarter = (m: typeof mv[number]) => { const a = Math.atan2((m[1] + m[3]) / 2 - CY, (m[0] + m[2]) / 2 - CX); return Math.floor((((a / (2 * Math.PI)) % 1) + 1) % 1 * 4); };
    const fastQ = new Set(mv.filter((m) => m[5] > 100 && Math.hypot(m[2] - m[0], m[3] - m[1]) > 0.2).map(quarter));
    expect([...fastQ].sort()).toEqual([1, 3]);
  });

  it('front projection paints only the side facing the viewer', () => {
    const p = paint({ projection: 'front', front_deg: -90, image: { w: 2, h: 1, px: [1, 1] } });
    const c = cfg({ ...paintPrintSettings(p), enable_arc_fitting: false, outer_wall_speed: 90 });
    const out = slice([part()], c, () => {}, { filaments: [slotFromConfig(c)], plugins: { motionex: mx(p) } });
    const mv = outerMoves(out.gcode, 1.3).filter((m) => Math.hypot(m[2] - m[0], m[3] - m[1]) > 0.2);
    const front = mv.filter((m) => (m[1] + m[3]) / 2 < CY - 8), back = mv.filter((m) => (m[1] + m[3]) / 2 > CY + 8);
    expect(front.every((m) => Math.round(m[5]) === 140)).toBe(true);
    expect(back.every((m) => Math.round(m[5]) !== 140)).toBe(true);
  });

  it('caps speeds at what the filament can melt, and warns', () => {
    const p = paint({ speed_dark: 600 });
    const c = cfg({ ...paintPrintSettings(p), enable_arc_fitting: false });
    const out = slice([part()], c, () => {}, { filaments: [slotFromConfig(c)], plugins: { motionex: mx(p) } });
    const rep = (out.pluginReports!.motionex as MotionexReport).paint!;
    expect(rep.speeds[1]).toBeLessThan(600);
    expect(rep.speeds[1]).toBeCloseTo(rep.flowLimit, 3);
    expect(out.warnings.some((w) => /can melt/.test(w))).toBe(true);
  });

  it('sets the painting acceleration around painted walls and puts it back', () => {
    const p = paint({ accel: 12000 });
    const c = cfg({ ...paintPrintSettings(p), enable_arc_fitting: false });
    const out = slice([part()], c, () => {}, { filaments: [slotFromConfig(c)], plugins: { motionex: mx(p) } });
    const body = out.gcode.split(';Z:3')[1].split(';Z:3.2')[0];
    const idx = body.indexOf(';TYPE:outer wall');
    expect(body.slice(0, idx).match(/M204 S(\d+)/g)?.pop()).toBe('M204 S12000');
    expect(body.slice(idx).match(/M204 S(\d+)/g)?.some((m) => m !== 'M204 S12000')).toBe(true);
  });
});
