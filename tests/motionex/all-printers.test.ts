// Velocity paint, lace and weave on every printer profile: a small vase sliced with each mode, checked
// on the G-code itself (numbers, placeholders, bed, speeds, acceleration syntax and limits).
import { describe, expect, it } from 'vitest';
import { slice, slotFromConfig } from '../../src/engine/slicer';
import { weld } from '../../src/engine/mesh';
import { resolveConfig } from '../../src/profiles/resolve';
import { PRINTERS, printerById } from '../../src/profiles/printers';
import { autoChanges, changerOf } from '../../src/profiles/changer';
import type { Config } from '../../src/profiles/settings';
import { cylinder } from '../fixtures';
import { defaultToolhead } from '../../src/plugins/motionex/core/toolhead';
import { DEFAULT_OPTIONS } from '../../src/plugins/motionex/modifier';
import type { MotionexConfig, MotionexReport } from '../../src/plugins/motionex/engine';
import { defaultPaint, type PaintSettings } from '../../src/plugins/motionex/paint/model';
import { paintPrintSettings, paintStepMm, recommendedPaintAccel, recommendedPixelMm } from '../../src/plugins/motionex/paint/plan';
import { defaultLace, type LaceSettings } from '../../src/plugins/motionex/lace/model';
import { laceLimits, lacePrintSettings } from '../../src/plugins/motionex/lace/plan';
import { LaceTracker } from '../../src/plugins/motionex/lace/core';
import { defaultWeave, type WeaveSettings } from '../../src/plugins/motionex/weave/model';
import { weavePrintSettings } from '../../src/plugins/motionex/weave/plan';
import { motifImage } from '../../src/plugins/motionex/weave/motifs';
import { isBedSlinger, isBowden } from '../../src/plugins/motionex/wall/machine';

const R = 15, H = 12;
// coarse and quick: 0.3 mm layers, a 64-sided cylinder
const COARSE = { layer_height: 0.3, initial_layer_print_height: 0.3, enable_arc_fitting: false, skirt_loops: 0, brim_width: 0, brim_type: 'no_brim' };
const cfg = (printerId: string, o: Record<string, unknown> = {}, machineOverrides?: Config) =>
  resolveConfig({ printerId, plate: 'textured_pei_plate', filamentId: 'generic-pla', presetId: '0.20', overrides: { ...COARSE, ...o } as never, machineOverrides });
const mx = (printerId: string, m: Partial<MotionexConfig>): MotionexConfig => ({ applications: [], brushes: [], options: DEFAULT_OPTIONS, collisionMode: 'clamp', toolhead: defaultToolhead(printerId), printerId, ...m });
const part = (printerId: string) => { const b = printerById(printerId).bed; return { id: 'vase', name: 'vase', ...weld(cylinder(b.x / 2, b.y / 2, R, H, 64)) }; };

const paint = (p: Partial<PaintSettings> = {}): PaintSettings => ({ ...defaultPaint(), enabled: true, image: motifImage('checker', 12, 6, 2), z_start: 1.2, speed_light: 40, speed_dark: 140, accel: 8000, ...p });
const lace = (l: Partial<LaceSettings> = {}): LaceSettings => ({ ...defaultLace(), enabled: true, cell_w: 7, cell_h: 6, z_start: 2, rim_mm: 2, ...l });
const weave = (w: Partial<WeaveSettings> = {}): WeaveSettings => ({ ...defaultWeave(), enabled: true, image: motifImage('checker', 24, 8, 2), z_start: 1.2, ...w });

function run(printerId: string, m: Partial<MotionexConfig>, settings: Record<string, unknown>, filaments = 1, machineOverrides?: Config) {
  const c = cfg(printerId, settings, machineOverrides);
  const a = slotFromConfig(c);
  const fils = Array.from({ length: filaments }, (_, k) => ({ ...a, name: `PLA ${k + 1}`, color: ['#ffffff', '#cc2222'][k] }));
  const out = slice([part(printerId)], c, () => {}, { filaments: fils, plugins: { motionex: mx(printerId, m) } });
  return { out, c, rep: out.pluginReports!.motionex as MotionexReport };
}

interface Scan { outerF: number[]; outerLen: number[]; accels: number[]; badBed: string[]; m204: number; svl: number }

/** One pass over the G-code: outer wall speeds and lengths, acceleration commands, moves off the bed. */
function scan(gcode: string, c: Config, z0 = 0): Scan {
  const bx = Number(c.bed_x), by = Number(c.bed_y);
  const s: Scan = { outerF: [], outerLen: [], accels: [], badBed: [], m204: 0, svl: 0 };
  let body = false, z = 0, cur = '', x = NaN, y = NaN, f = 0, absE = false, lastE = 0;
  for (const l of gcode.split('\n')) {
    // the printer maker's end G-code is not part of the print
    if (l.startsWith(';===== NexSpiro end G-code')) break;
    if (/^M82\b/.test(l)) absE = true;
    if (/^M83\b/.test(l)) absE = false;
    if (/^G92 E0/.test(l)) lastE = 0;
    if (l.startsWith(';Z:')) { body = true; z = +l.slice(3); }
    if (l.startsWith(';TYPE:')) cur = l.slice(6);
    if (!body) continue;
    const m204 = /^M204 S(\d+)/.exec(l), svl = /^SET_VELOCITY_LIMIT ACCEL=(\d+)/.exec(l);
    if (m204) { s.m204++; s.accels.push(+m204[1]); }
    if (svl) { s.svl++; s.accels.push(+svl[1]); }
    if (!/^G[0123] /.test(l)) continue;
    const g = (k: string) => { const r = new RegExp(` ${k}(-?[\\d.]+)`).exec(l); return r ? +r[1] : NaN; };
    const px = x, py = y;
    if (!isNaN(g('X'))) x = g('X');
    if (!isNaN(g('Y'))) y = g('Y');
    if (!isNaN(g('F'))) f = g('F') / 60;
    // absolute E (Anycubic's Kobra 2 Max profile): the extrusion is the change of E
    const eAbs = g('E');
    const e = absE && !isNaN(eAbs) ? eAbs - lastE : eAbs;
    if (absE && !isNaN(eAbs)) lastE = eAbs;
    if (e > 0 && /[XY]/.test(l) && (x < -0.5 || y < -0.5 || x > bx + 0.5 || y > by + 0.5)) s.badBed.push(l);
    if (cur === 'outer wall' && z > z0 && e > 0 && /[XY]/.test(l) && !isNaN(px)) { s.outerF.push(f); s.outerLen.push(Math.hypot(x - px, y - py)); }
  }
  return s;
}

/** Checks every mode shares: clean numbers, no placeholders, on the bed, acceleration in the flavour's syntax and within the limit. */
function sane(gcode: string, c: Config, sc = scan(gcode, c)) {
  expect(gcode).not.toMatch(/NaN|Infinity|undefined/);
  // placeholders left in G-code or its comments (the settings dump at the end lists names like "[mm]")
  expect(gcode.split('\n').filter((l) => !/^; [\w ]+(\[\w+\])? = /.test(l) && /\[[a-z_]+\]/.test(l))).toEqual([]);
  expect(sc.badBed).toEqual([]);
  const max = Number(c.max_acceleration);
  expect(Math.max(0, ...sc.accels)).toBeLessThanOrEqual(max);
  if (c.gcode_flavor === 'klipper') expect(sc.m204).toBe(0);
  else expect(sc.svl).toBe(0);
  return sc;
}

const ids = PRINTERS.map((p) => p.id);
const colourIds = PRINTERS.filter((p) => autoChanges(p.machine)).map((p) => p.id);

describe('wall art on every printer', () => {
  it.each(ids)('%s: velocity paint', (id) => {
    const p = paint();
    const { out, c, rep } = run(id, { paint: p }, paintPrintSettings(p));
    const r = rep.paint!;
    expect(r.paintedLayers).toBeGreaterThan(20);
    const sc = sane(out.gcode, c, scan(out.gcode, c, 1.3));
    // painted speeds within the machine's top speed and what the filament can melt
    const vMax = Math.min(Number(c.max_speed_xy), r.flowLimit);
    expect(Math.max(...r.speeds)).toBeLessThanOrEqual(vMax + 1e-6);
    expect(Math.max(...sc.outerF)).toBeLessThanOrEqual(vMax + 0.5);
    expect(new Set(sc.outerF.map(Math.round)).size).toBeGreaterThanOrEqual(2);
    // painting acceleration: within the limit, written in the flavour's syntax
    const max = Number(c.max_acceleration);
    expect(r.accel).toBe(Math.min(8000, max));
    expect(sc.accels).toContain(Math.min(8000, max));
    // Marlin gets pieces of a millimetre or more; finer only where the slicer's own move was shorter
    if (c.gcode_flavor === 'marlin') {
      expect(r.stepMm).toBeGreaterThanOrEqual(1);
      const short = sc.outerLen.filter((l) => l < 0.3).length;
      expect(short / sc.outerLen.length).toBeLessThan(0.15);
    }
  });

  it.each(ids)('%s: lace', (id) => {
    const l = lace();
    const c0 = cfg(id);
    const { out, c, rep } = run(id, { lace: l }, lacePrintSettings(l, c0));
    const r = rep.lace!;
    sane(out.gcode, c);
    expect(r.laceLayers).toBeGreaterThan(0);
    expect(r.holes).toBeGreaterThan(0);
    expect(r.bowden).toBe(isBowden(c, id));
    expect(r.minStrandMm).toBeGreaterThanOrEqual(2 * Number(c.outer_wall_line_width) - 1e-9);
  });

  it.each(ids)('%s: mono weave', (id) => {
    const w = weave({ mode: 'mono', slots: [0] });
    const c0 = cfg(id);
    const settings = weavePrintSettings(w, c0);
    expect(settings.outer_wall_speed).toBeLessThanOrEqual(Number(c0.outer_wall_speed));
    if (isBedSlinger(c0, id)) expect(settings.outer_wall_speed).toBeLessThanOrEqual(60);
    const { out, c, rep } = run(id, { weave: w }, settings);
    sane(out.gcode, c);
    expect(rep.weave!.wovenLayers).toBeGreaterThan(20);
    expect(rep.weave!.changes).toBe(0);
  });

  it.each(colourIds)('%s: colour weave', (id) => {
    const w = weave({ mode: 'colour', slots: [0, 1] });
    const c0 = cfg(id);
    const { out, c, rep } = run(id, { weave: w }, weavePrintSettings(w, c0), 2);
    sane(out.gcode, c);
    const r = rep.weave!;
    expect(r.wovenLayers).toBeGreaterThan(20);
    expect(r.changes).toBe(r.wovenLayers - 1);
    if (changerOf(c) === 'toolchanger') expect(out.gcode).toMatch(/^T1/m);
  });
});

describe('wall art per machine', () => {
  it('velocity paint in spiral vase paints the climbing open run', () => {
    const p = paint({ accel: 0 });
    const { out, c, rep } = run('voron-24-350', { paint: p }, { ...paintPrintSettings(p), spiral_mode: true, wall_loops: 1, sparse_infill_density: 0, top_shell_layers: 0, bottom_shell_layers: 3 });
    const r = rep.paint!;
    expect(r.paintedLayers).toBeGreaterThan(20);
    const sc = sane(out.gcode, c, scan(out.gcode, c, 1.5));
    expect(new Set(sc.outerF.map(Math.round))).toEqual(new Set([40, 140]));
    // Z keeps climbing through the cut pieces: no step back down inside a layer
    let z = 0, drops = 0, spiral = false;
    for (const l of out.gcode.split('\n')) {
      if (l.startsWith(';Z:')) spiral = +l.slice(3) > 1.5;
      const m = /^G1 .*Z([\d.]+)/.exec(l);
      if (m && spiral) { if (+m[1] < z - 1e-3 && / E[\d.]/.test(l)) drops++; z = +m[1]; }
    }
    expect(drops).toBe(0);
  });

  it('recommends pixels and acceleration from the machine', () => {
    const p = paint({ accel: 0 });
    const slow = cfg('creality-ender3v2'), fast = cfg('voron-24-350');
    // Ender-3 V2: OrcaSlicer's profile limits it to 500 mm/s²
    expect(recommendedPaintAccel(slow)).toBe(500);
    expect(recommendedPaintAccel(fast)).toBe(10000);
    expect(recommendedPaintAccel(cfg('creality-k1'))).toBe(10000);
    // Ender-3 V2: Marlin, 800 mm/s² outer wall → long ramps, so big pixels
    expect(recommendedPixelMm(slow, p)).toBeGreaterThan(recommendedPixelMm(fast, p));
    expect(paintStepMm(p, slow)).toBeGreaterThanOrEqual(1);
    expect(paintStepMm(p, fast)).toBeLessThan(1);
    // a painting acceleration above the machine is clamped, and said so
    const q = paint({ accel: 20000 });
    const { out, rep } = run('creality-ender3v2', { paint: q }, paintPrintSettings(q));
    expect(rep.paint!.accel).toBe(500);
    expect(out.warnings.some((w) => /above this printer/.test(w))).toBe(true);
    expect(out.warnings.some((w) => /pixels of [\d.]+ mm or more/.test(w))).toBe(true);
  });

  it.each([0.2, 0.6, 1.0])('lace scales strands and holes to a %s mm nozzle', (nz) => {
    const l = lace({ cell_w: Math.max(7, 8 * nz), cell_h: Math.max(6, 8 * nz), strand_mm: 1.2, z_start: 2 });
    const { out, c, rep } = run('voron-24-350', { lace: l }, lacePrintSettings(l), 1, { nozzle_diameter: nz });
    const r = rep.lace!, lw = Number(c.outer_wall_line_width);
    expect(lw).toBeCloseTo(nz * 1.05, 2);
    sane(out.gcode, c);
    expect(r.laceLayers).toBeGreaterThan(0);
    expect(r.strandMm).toBeCloseTo(Math.max(1.2, 2 * lw), 6);
    expect(r.minHoleMm).toBeGreaterThanOrEqual(lw);
    expect(out.warnings.some((w) => /under two/.test(w))).toBe(2 * lw > 1.2);
    expect(laceLimits(l, c).min_strand_mm).toBeGreaterThanOrEqual(2 * lw);
  });

  it('lace on Bowden printers: short retractions across small hops, a warning when there are many', () => {
    const c0 = cfg('prusa-mini');
    expect(isBowden(c0, 'prusa-mini')).toBe(true);
    expect(isBowden(cfg('voron-24-350'))).toBe(false);
    expect(isBowden(cfg('voron-24-350', {}, { retraction_length: 4 }))).toBe(true);
    expect(lacePrintSettings(lace(), c0).retraction_minimum_travel).toBe(2);
    const l = lace({ cell_w: 3, cell_h: 4, strand_mm: 1, open: 0.7 });
    const { out, rep } = run('prusa-mini', { lace: l }, lacePrintSettings(l, c0), 1, { retraction_length: 3.2, retraction_minimum_travel: 1 }); // Prusa's own threshold is 1.5 mm
    expect(rep.lace!.bowden).toBe(true);
    expect(rep.lace!.retractions / rep.lace!.laceLayers).toBeGreaterThan(30);
    expect(out.warnings.some((w) => /Bowden/.test(w))).toBe(true);
    // short hops pull back 1.6 mm instead of 3.2
    expect(out.gcode).toMatch(/^G1 E-1\.6 /m);
  });

  it('lace overhang reach follows each layer\'s own height (variable layer height)', () => {
    // a band of open bins narrows by the reach per layer: thin layers close it more slowly
    const loop = (n = 400) => { const pts = Array.from({ length: n }, (_, k) => ({ x: 20 * Math.cos((2 * Math.PI * k) / n), y: 20 * Math.sin((2 * Math.PI * k) / n) })); return { pts, u: pts.map((_, k) => k / n), length: 2 * Math.PI * 20, cx: 0, cy: 0 }; };
    // bottom picture row: half the loop open; top row: all solid. Solid may only creep in by the reach.
    const openMm = (dz: number) => {
      const t = new LaceTracker({ ...lace(), source: 'image', image: { w: 2, h: 2, px: [0, 0, 1, 0] }, fit_height: 'stretch', bridge_mm: 0, overhang_deg: 45, min_hole_mm: 0, min_strand_mm: 0 }, { total: 1 });
      t.layer([loop()], 0, dz, true);
      const m = t.layer([loop()], 0.9, dz, true)[0];
      return (m.solid.filter((v) => !v).length * (2 * Math.PI * 20)) / m.B;
    };
    const half = Math.PI * 20;
    // reach = layer height × tan 45°, from both edges of the hole
    expect(openMm(0.1)).toBeCloseTo(half - 0.2, 0);
    expect(openMm(0.3)).toBeCloseTo(half - 0.6, 0);
    expect(openMm(0.1) - openMm(0.3)).toBeGreaterThan(0.25);
  });
});
