// Weave mode: picture → per-layer colours and in/out wall offsets, inside the real slicer.
import { describe, expect, it } from 'vitest';
import { slice, slotFromConfig } from '../../src/engine/slicer';
import { weld } from '../../src/engine/mesh';
import { resolveConfig } from '../../src/profiles/resolve';
import { TRANSITION_MARKER } from '../../src/plugins/api';
import { bambuFlushes, cylinder } from '../fixtures';
import { defaultToolhead } from '../../src/plugins/motionex/core/toolhead';
import { DEFAULT_OPTIONS } from '../../src/plugins/motionex/modifier';
import type { MotionexConfig, MotionexReport } from '../../src/plugins/motionex/engine';
import { defaultWeave, type WeaveSettings } from '../../src/plugins/motionex/weave/model';
import { filamentAt, offsetAt, planLayers, weaveLoop } from '../../src/plugins/motionex/weave/core';
import { greyLevels, gridFor, parseHex, quantize, resampleRGB, resizeImage, suggestPalette } from '../../src/plugins/motionex/weave/image';
import { MOTIFS, motifImage } from '../../src/plugins/motionex/weave/motifs';
import { estimateWeave, weavePrintSettings } from '../../src/plugins/motionex/weave/plan';

const CX = 128, CY = 128, R = 20;
const settings = (w: Partial<WeaveSettings> = {}) => ({ ...weavePrintSettings({ ...defaultWeave(), ...w }), enable_arc_fitting: false });
// NexSpiro's own Bambu filament change macro (the X1C); the A1 / P1S now run Bambu Studio's template (vendor-gcode.test.ts)
const cfg = (printerId = 'bbl-x1c', o: Record<string, unknown> = {}) => resolveConfig({ printerId, plate: 'textured_pei_plate', filamentId: 'generic-pla', presetId: '0.20', overrides: o as never });
const slots = (c: ReturnType<typeof cfg>) => { const a = slotFromConfig(c); return [{ ...a, name: 'White', color: '#ffffff' }, { ...a, name: 'Red', color: '#cc2222' }, { ...a, name: 'Black', color: '#111111' }]; };
const weave = (w: Partial<WeaveSettings> = {}): WeaveSettings => ({ ...defaultWeave(), enabled: true, image: motifImage('checker', 64, 24, 2), z_start: 1.2, ...w });
const mx = (w: WeaveSettings, printerId = 'bbl-p1s'): MotionexConfig => ({ applications: [], brushes: [], options: DEFAULT_OPTIONS, collisionMode: 'clamp', toolhead: defaultToolhead(printerId), printerId, weave: w });
const vase = () => ({ id: 'vase', name: 'vase', ...weld(cylinder(CX, CY, R, 16, 128)) });

/** Extruding outer-wall points per layer, from the G-code; each layer's list starts with the point the first line starts from. */
function outerByLayer(gcode: string): Map<string, [number, number][]> {
  const out = new Map<string, [number, number][]>();
  let z = '', cur = '', x = NaN, y = NaN;
  for (const l of gcode.split('\n')) {
    if (l.startsWith(';Z:')) z = l.slice(3);
    if (l.startsWith(';TYPE:')) cur = l.slice(6);
    const mx = /X([-\d.]+)/.exec(l), my = /Y([-\d.]+)/.exec(l);
    const px = x, py = y;
    if (l.startsWith('G1') || l.startsWith('G0')) { if (mx) x = +mx[1]; if (my) y = +my[1]; }
    if (cur === 'Outer wall' || cur === 'outer wall') {
      if (l.startsWith('G1') && / E[\d.]/.test(l) && (mx || my)) {
        const a = out.get(z) ?? [];
        if (!a.length) a.push([px, py]);
        a.push([x, y]); out.set(z, a);
      }
    }
  }
  return out;
}
const radius = ([x, y]: [number, number]) => Math.hypot(x - CX, y - CY);

describe('weave pictures', () => {
  it('reduces an image to the filament colours, with and without dithering', () => {
    // left half black, right half white, 8 × 2
    const w = 8, h = 2, rgba: number[] = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rgba.push(...(x < 4 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
    const rgb = resampleRGB(rgba, w, h, 4, 1);
    expect(quantize(rgb, 4, 1, [parseHex('#fff'), parseHex('#000')])).toEqual([1, 1, 0, 0]);
    // a mid grey dithers into a mix of both
    const grey = new Float32Array(16 * 3).fill(128);
    const d = quantize(grey, 16, 1, [parseHex('#ffffff'), parseHex('#000000')], 'floyd');
    expect(d.filter((v) => v === 1).length).toBeGreaterThan(4);
    expect(d.filter((v) => v === 0).length).toBeGreaterThan(4);
    expect(greyLevels(rgb, 4, 1, 3)).toEqual([2, 2, 0, 0]);
    const pal = suggestPalette(resampleRGB(rgba, w, h, w, h), 2);
    expect(pal[0][0]).toBeGreaterThan(200); // lightest first
    expect(pal[1][0]).toBeLessThan(50);
  });

  it('draws every motif at any size and colour count', () => {
    for (const m of MOTIFS) for (const n of [2, 3]) {
      const img = motifImage(m.id, 40, 30, n);
      expect(img.px.length).toBe(1200);
      expect(img.px.every((v) => v >= 0 && v < n)).toBe(true);
      expect(new Set(img.px).size).toBeGreaterThan(1);
    }
    expect(resizeImage(motifImage('checker', 64, 64, 2), 10, 5).px.length).toBe(50);
    const g = gridFor(2 * Math.PI * 30, 100, 1.2, 0.4, 0.5);
    expect(g.w).toBe(157);
    expect(g.h).toBeLessThanOrEqual(250);
  });
});

describe('weave plan', () => {
  it('cycles the colours layer by layer inside the band and maps rows bottom to top', () => {
    const zs = Array.from({ length: 50 }, (_, i) => 0.2 * (i + 1));
    const w = weave({ image: { w: 4, h: 5, px: new Array(20).fill(0) }, z_start: 2, z_end: 7 });
    const plan = planLayers(w, zs);
    expect(plan[8]).toBeNull(); // z 1.8
    expect(plan[9]?.k).toBe(0);
    expect(plan.filter(Boolean).length).toBe(26);
    expect(plan[9]?.colour).toBe(0);
    expect(plan[10]?.colour).toBe(1);
    expect(plan[11]?.colour).toBe(0);
    // stretch: first row is the bottom row of the picture, the last one the top
    expect(plan[9]?.row).toBe(4);
    expect(plan[34]?.row).toBe(0);
    // filament per layer: band cycles the slots, the floor and the top print the first one
    const ws = { ...w, slots: [2, 0] };
    expect(filamentAt(ws, zs, 3)).toBe(2);
    expect(filamentAt(ws, zs, 9)).toBe(2);
    expect(filamentAt(ws, zs, 10)).toBe(0);
    expect(filamentAt(ws, zs, 49)).toBe(2);
    // two layers per colour
    const two = planLayers({ ...w, layers_per_colour: 2 }, zs);
    expect([9, 10, 11, 12].map((i) => two[i]?.colour)).toEqual([0, 0, 1, 1]);
  });

  it('pushes the layer out where the picture shows its colour and in where it does not', () => {
    const w = weave({ image: { w: 2, h: 1, px: [0, 1] }, stitch: 0 });
    const L = { k: 0, colour: 0, row: 0, rowFromBottom: 0, depthMul: 1, parity: 0 };
    expect(offsetAt(w, L, 0.25)).toBeCloseTo(w.depth_mm);
    expect(offsetAt(w, L, 0.75)).toBeCloseTo(-w.depth_mm * w.recess);
    expect(offsetAt(w, { ...L, colour: 1 }, 0.75)).toBeCloseTo(w.depth_mm);
    // mono texture: light pixels stay flat, dark ones go in and out on alternate layers
    const m = { ...w, mode: 'mono' as const };
    expect(offsetAt(m, L, 0.25)).toBe(0);
    expect(offsetAt(m, L, 0.75)).toBeCloseTo(w.depth_mm);
    expect(offsetAt(m, { ...L, parity: 1 }, 0.75)).toBeCloseTo(-w.depth_mm * w.recess);
  });

  it('weaves a loop outwards, starting on the seam line', () => {
    const pts = Array.from({ length: 64 }, (_, i) => ({ x: 10 * Math.cos((i / 64) * 2 * Math.PI), y: 10 * Math.sin((i / 64) * 2 * Math.PI) }));
    for (const loop of [pts, [...pts].reverse()]) {
      const out = weaveLoop(loop, () => 0.2, 0.2, 0, 90);
      expect(out[0].y).toBeGreaterThan(10); // seam at +Y, pushed out
      expect(out.every((p) => Math.abs(Math.hypot(p.x, p.y) - 10.2) < 0.02)).toBe(true);
      expect(Math.hypot(out[0].x - out[out.length - 1].x, out[0].y - out[out.length - 1].y)).toBeLessThan(1e-9);
    }
  });

  it('estimates changes, time and purge', () => {
    const w = weave();
    const full = estimateWeave(w, { bandMm: 100, layerHeight: 0.2, changeTime: 95, flushMm3: 150, filamentDensity: 1.24 });
    expect(full.changes).toBe(499);
    expect(full.purgeGrams).toBeCloseTo((499 * 150 * 1.24) / 1000);
    const bleed = estimateWeave({ ...w, change: { mode: 'bleed', volume_mm3: 0 } }, { bandMm: 100, layerHeight: 0.2, changeTime: 95, flushMm3: 150, filamentDensity: 1.24 });
    expect(bleed.purgeGrams).toBe(0);
    expect(bleed.changeSeconds).toBe(499 * 95);
    expect(estimateWeave({ ...w, mode: 'mono' }, { bandMm: 100, layerHeight: 0.2, changeTime: 95, flushMm3: 150, filamentDensity: 1.24 }).changes).toBe(0);
  });
});

describe('weave in the slicer', () => {
  it('colour weave: a filament change every layer, picture in the wall, seam tucked inside', () => {
    const c = cfg('bbl-p1s', settings());
    const plain = slice([vase()], c, () => {}, { filaments: slots(c), plugins: { motionex: mx({ ...weave(), enabled: false }) } });
    const out = slice([vase()], c, () => {}, { filaments: slots(c), plugins: { motionex: mx(weave()) } });
    const rep = (out.pluginReports!.motionex as MotionexReport).weave!;
    expect(out.gcode).toMatch(/^; motionex weave: colour Checker 64x24/m);
    expect(rep.wovenLayers).toBeGreaterThan(60);
    expect(rep.loops).toBe(rep.wovenLayers);
    // one change per woven layer (the first woven layer keeps the floor colour)
    const changes = (out.gcode.match(new RegExp(`^${TRANSITION_MARKER}`, 'gm')) ?? []).length;
    expect(changes).toBe(rep.wovenLayers - 1);
    expect(out.stats.toolChanges).toBeGreaterThanOrEqual(rep.wovenLayers - 1);
    expect(plain.stats.toolChanges).toBe(0);
    // wall at mid height: in and out round the vase
    const L = outerByLayer(out.gcode), P = outerByLayer(plain.gcode);
    const z = '8';
    const r = L.get(z)!.map(radius), rp = P.get(z)!.map(radius);
    const nominal = rp.reduce((a, b) => a + b, 0) / rp.length;
    expect(Math.max(...r)).toBeGreaterThan(nominal + 0.08);
    expect(Math.min(...r)).toBeLessThan(nominal - 0.04);
    // inward seam: the loop starts and ends inside the wall, below the pulled-in line
    expect(radius(L.get(z)![0])).toBeLessThan(nominal - 0.3);
    expect(radius(L.get(z)![L.get(z)!.length - 1])).toBeLessThan(nominal - 0.3);
    // seam on the chosen line (90° = +Y)
    const firstOnWall = L.get(z)![1]; // end of the lead-in
    expect(firstOnWall[1] - CY).toBeGreaterThan(R * 0.9);
    // full purge keeps the flush in the change G-code
    expect(out.gcode).toMatch(/mode=full/);
  });

  it('bleed mode: no flush and no prime tower band for weave changes', () => {
    const w = weave({ change: { mode: 'bleed', volume_mm3: 0 } });
    const c = cfg('bbl-a1mini', settings(w));
    expect(c.enable_prime_tower).toBe(false);
    const out = slice([vase()], c, () => {}, { filaments: slots(c), plugins: { motionex: mx(w, 'bbl-a1mini') } });
    expect(out.gcode).toMatch(/mode=none/);
    expect(out.gcode).not.toMatch(/mode=full/);
    // Bambu Studio's A1 mini change G-code: nothing in its FLUSH blocks
    const flushed = (g: string) => bambuFlushes(g).slice(1);
    expect(flushed(out.gcode).length).toBeGreaterThan(0);
    expect(Math.max(...flushed(out.gcode))).toBe(0);
    expect(out.gcode).not.toMatch(/;TYPE:Prime tower/i);
    const reduced = slice([vase()], c, () => {}, { filaments: slots(c), plugins: { motionex: mx({ ...w, change: { mode: 'reduced', volume_mm3: 20 } }, 'bbl-a1mini') } });
    expect(reduced.gcode).toMatch(/mode=reduced/);
    expect(Math.max(...flushed(reduced.gcode))).toBeCloseTo(20 / (Math.PI * 0.875 ** 2), 1); // 20 mm³ of 1.75 mm filament
  });

  it('three colours take turns; mono relief makes no filament change', () => {
    const c = cfg('bbl-x1c', settings()); // T lines of the print only (Bambu's own start / end G-code on the P1S also select tools)
    const three = slice([vase()], c, () => {}, { filaments: slots(c), plugins: { motionex: mx(weave({ image: motifImage('kilim', 64, 20, 3), slots: [0, 1, 2] })) } });
    const tools = [...three.gcode.matchAll(/^T(\d)$/gm)].map((m) => +m[1]);
    expect(new Set(tools)).toEqual(new Set([0, 1, 2]));
    // taking turns: no colour repeats on the next layer
    for (let k = 1; k < tools.length; k++) expect(tools[k]).not.toBe(tools[k - 1]);
    const mono = slice([vase()], c, () => {}, { filaments: slots(c).slice(0, 1), plugins: { motionex: mx(weave({ mode: 'mono', image: motifImage('greek-key', 64, 20, 2), slots: [0] })) } });
    expect(mono.stats.toolChanges).toBe(0);
    const r = outerByLayer(mono.gcode).get('8')!.map(radius);
    expect(Math.max(...r) - Math.min(...r)).toBeGreaterThan(0.3); // relief plus the tucked seam
  });

  it('warns when the setup cannot weave', () => {
    const c = cfg('bbl-p1s', { ...settings(), spiral_mode: true });
    const out = slice([vase()], c, () => {}, { filaments: slots(c), plugins: { motionex: mx(weave()) } });
    expect(out.warnings.join('\n')).toMatch(/spiral vase is on/);
  });
});

describe('weave preview and vase shapes', () => {
  it('draws the picture on the part in the filament colours, pushed out to the woven line', async () => {
    const { buildWeavePreview } = await import('../../src/plugins/motionex/weave/preview');
    const m = weld(cylinder(0, 0, R, 16, 128));
    const w = weave({ image: { w: 2, h: 1, px: [0, 1] } });
    const lines = buildWeavePreview([{ id: 'a', mesh: m }], w, 0.2, [[1, 1, 1], [1, 0, 0]])!;
    expect(lines.positions.length).toBeGreaterThan(1000);
    for (let k = 0; k < lines.positions.length; k += 3) expect(Math.hypot(lines.positions[k], lines.positions[k + 1])).toBeGreaterThan(R - 0.05);
    const reds: number[] = [], whites: number[] = [];
    for (let k = 0; k < lines.colors.length; k += 3) (lines.colors[k + 1] === 0 ? reds : whites).push(k);
    expect(reds.length).toBeGreaterThan(100);
    expect(whites.length).toBeGreaterThan(100);
    // only the chosen objects
    expect(buildWeavePreview([{ id: 'a', mesh: m }], { ...w, objects: ['b'] }, 0.2, [[1, 1, 1], [1, 0, 0]])).toBeNull();
  });

  it('Plantex weave bodies slice into one woven loop per layer', async () => {
    const { PRESETS } = await import('../../src/plugins/plantex/presets');
    const { buildBody } = await import('../../src/plugins/plantex/mesh');
    const { normalizeSpec } = await import('../../src/plugins/plantex/model');
    const weaves = PRESETS.filter((p) => p.category === 'Weave');
    expect(weaves.length).toBeGreaterThanOrEqual(5);
    const spec = normalizeSpec({ ...weaves.find((p) => p.id === 'weave-amphora')!.spec, height: 30 });
    const body = buildBody(spec, () => undefined, true).mesh;
    const v = body.vertices;
    for (let i = 0; i < v.length; i += 3) { v[i] += CX; v[i + 1] += CY; }
    const c = cfg('bbl-p1s', settings());
    const out = slice([{ id: 'amphora', name: 'amphora', ...body }], c, () => {}, { filaments: slots(c), plugins: { motionex: mx(weave()) } });
    const rep = (out.pluginReports!.motionex as MotionexReport).weave!;
    expect(rep.loops).toBe(rep.wovenLayers);
    expect(rep.wovenLayers).toBeGreaterThan(100);
  });
});
