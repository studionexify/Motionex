// Weave wave texture: the line swings in and out along the wall, each layer flipped against the one
// below; zones (modifier shapes, height bands) switch it on, off or to their own style with soft edges.
import { describe, expect, it } from 'vitest';
import { slice, slotFromConfig } from '../../src/engine/slicer';
import { weld } from '../../src/engine/mesh';
import { resolveConfig } from '../../src/profiles/resolve';
import { box, cylinder } from '../fixtures';
import { defaultToolhead } from '../../src/plugins/motionex/core/toolhead';
import { DEFAULT_OPTIONS } from '../../src/plugins/motionex/modifier';
import type { MotionexConfig, MotionexReport } from '../../src/plugins/motionex/engine';
import { defaultWave, defaultWeave, WAVE_PRESETS, presetOf, type WaveStyle, type WeaveSettings } from '../../src/plugins/motionex/weave/model';
import { weaveLoop, type Pt, type WovenPoint } from '../../src/plugins/motionex/weave/core';
import { weavePrintSettings } from '../../src/plugins/motionex/weave/plan';
import { arcWeights, waveAt, WaveField } from '../../src/plugins/motionex/weave/wave';
import { collectZones, type ZoneSource } from '../../src/plugins/motionex/weave/zones';

const CX = 128, CY = 128, R = 20;
const KNIT = WAVE_PRESETS.find((p) => p.id === 'knit')!.style!;
const style = (id: string) => WAVE_PRESETS.find((p) => p.id === id)!.style!;
const planes = Array.from({ length: 100 }, (_, i) => 0.1 + 0.2 * i);
const circle = (r = R, n = 720, cx = CX, cy = CY): Pt[] => Array.from({ length: n }, (_, i) => ({ x: cx + r * Math.cos((2 * Math.PI * i) / n), y: cy + r * Math.sin((2 * Math.PI * i) / n) }));
const wv = (w: Partial<WeaveSettings> = {}, wave: Partial<WaveStyle> & { enabled?: boolean; smooth_edges?: boolean; blend_mm?: number } = {}): WeaveSettings =>
  ({ ...defaultWeave(), enabled: true, mode: 'mono', picture: { kind: 'none' }, image: { w: 1, h: 1, px: [0] }, z_start: 0, ...w, wave: { ...defaultWave(), enabled: true, ...wave } });
const zoneBox = (x0: number, y0: number, z0: number, sx: number, sy: number, sz: number, ov: Record<string, string | number>): ZoneSource =>
  ({ parts: [{ type: 'modifier', ...weld(box(x0, y0, z0, sx, sy, sz)), overrides: ov }] });
/** Woven loop of layer i through the field (no picture). */
const loopAt = (f: WaveField, i: number, pts = circle()): WovenPoint[] => weaveLoop(pts, null, 0.1, 0, 0, f.term(i));
const angleOf = (p: { x: number; y: number }) => Math.atan2(p.y - CY, p.x - CX);

describe('wave texture', () => {
  it('flips every layer (knit), slides a quarter (twill), stacks straight (ribs)', () => {
    for (let u = 0; u < 1; u += 0.013) {
      expect(waveAt(KNIT, 40, u, 7)).toBeCloseTo(-waveAt(KNIT, 40, u, 8), 9);
      expect(waveAt(KNIT, 40, u, 7)).toBeCloseTo(waveAt(KNIT, 40, u, 9), 9);
      expect(waveAt(style('ribs'), 40, u, 3)).toBeCloseTo(waveAt(style('ribs'), 40, u, 4), 9);
      // twill: each layer the same wave a quarter stitch further on
      expect(waveAt(style('twill'), 40, u, 5)).toBeCloseTo(waveAt(style('twill'), 40, u + 0.25 / 40, 4), 9);
      // basket: swaps every second layer
      expect(waveAt(style('basket'), 40, u, 0)).toBe(waveAt(style('basket'), 40, u, 1));
    }
    expect(presetOf(KNIT)).toBe('knit');
    expect(presetOf({ ...KNIT, height_mm: 0.17 })).toBe('custom');
  });

  it('closes on itself at the seam with a whole number of stitches, crest over trough from layer to layer', () => {
    const f = new WaveField(wv(), [], { planes });
    const a = loopAt(f, 20), b = loopAt(f, 21);
    const L = 2 * Math.PI * R, n = Math.round(L / KNIT.length_mm);
    // smooth all the way round, the seam included (a step there would jump by up to 2·height)
    const ds = L / (a.length - 1), slope = (2 * Math.PI * KNIT.height_mm) / (L / n);
    for (let k = 1; k < a.length; k++) expect(Math.abs(a[k].lat - a[k - 1].lat)).toBeLessThan(slope * ds * 1.3 + 1e-6);
    expect(Math.max(...a.map((q) => q.lat))).toBeCloseTo(KNIT.height_mm, 2);
    // same spot, next layer: the other way
    for (let k = 0; k < a.length; k += 37) expect(a[k].lat + b[k].lat).toBeCloseTo(0, 6);
    // and no line folds back on itself
    for (let k = 1; k < a.length; k++) { const dx = a[k].x - a[k - 1].x, dy = a[k].y - a[k - 1].y; expect(dx * -Math.sin(angleOf(a[k])) + dy * Math.cos(angleOf(a[k]))).toBeGreaterThan(0); }
  });

  it('soft edge along the line: 0 outside, 1 inside, a monotonic ramp T long centred on the edge', () => {
    const M = 1000, L = 100, s = Array.from({ length: M }, (_, i) => (i * L) / M);
    const inside = new Uint8Array(M).map((_, i) => (s[i] >= 30 && s[i] < 70 ? 1 : 0));
    const w = arcWeights(inside, s, L, 4);
    expect(w[0]).toBe(0); expect(w[500]).toBe(1);
    const at = (x: number) => w[Math.round((x / L) * M)];
    expect(at(27.9)).toBe(0); expect(at(32.1)).toBe(1); expect(at(30)).toBeCloseTo(0.5, 1);
    for (let i = 260; i < 340; i++) expect(w[i + 1]).toBeGreaterThanOrEqual(w[i] - 1e-12);
    expect(arcWeights(new Uint8Array(10).fill(1), s.slice(0, 10), 10, 4).every((v) => v === 1)).toBe(true);
  });

  it('a box zone waves only its side of the part, easing in over at least a stitch, and fades out over its top', () => {
    // whole part plain; a box over the +X half from z 5 to 12 says "wave here"
    const zones = collectZones([zoneBox(CX + 2, CY - 40, 5, 40, 80, 7, { wave_mode: 'wave', wave_blend: 3 })], planes);
    expect(zones).toHaveLength(1);
    const f = new WaveField(wv({}, { enabled: false }), zones, { planes });
    const mid = loopAt(f, 40); // z 8.1
    const amp = (pts: WovenPoint[], pick: (a: number) => boolean) => Math.max(0, ...pts.filter((q) => pick(angleOf(q))).map((q) => Math.abs(q.lat)));
    expect(amp(mid, (a) => Math.abs(a) < 0.5)).toBeGreaterThan(0.9 * KNIT.height_mm); // inside, around +X
    expect(amp(mid, (a) => Math.abs(a) > 2.2)).toBe(0); // the -X side stays plain
    // the strength never jumps: along the line it changes by no more than one step of a ≥ 3 mm ramp
    const ds = (2 * Math.PI * R) / (mid.length - 1);
    for (let k = 1; k < mid.length; k++) expect(Math.abs((mid[k].wave ?? 0) - (mid[k - 1].wave ?? 0))).toBeLessThan((1.6 * ds) / 3 + 1e-6);
    // from layer to layer: full in the middle, fading over the top (z 12) instead of stopping in one layer
    const peak = (i: number) => Math.max(0, ...(loopAt(f, i).map((q) => q.wave ?? 0)));
    expect(peak(40)).toBeCloseTo(1, 6);
    const top = [54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66].map(peak); // z 10.9 … 13.3 (top at 12)
    for (let k = 1; k < top.length; k++) expect(top[k]).toBeLessThanOrEqual(top[k - 1] + 1e-9);
    expect(top[0]).toBeGreaterThan(0.6);
    expect(top[top.length - 1]).toBe(0);
    expect(top.filter((v) => v > 0.02 && v < 0.98).length).toBeGreaterThanOrEqual(3);
    expect(f.activeAt(10)).toBe(false);
  });

  it('a "keep plain" zone clears the knit inside and leaves it full outside; a height band brings its own style', () => {
    const plain = collectZones([zoneBox(CX + 10, CY - 5, 0, 20, 10, 20, { wave_mode: 'plain' })], planes);
    const f = new WaveField(wv(), plain, { planes });
    const pts = loopAt(f, 40);
    const at = (a: number) => pts.reduce((b, q) => (Math.abs(angleOf(q) - a) < Math.abs(angleOf(b) - a) ? q : b));
    expect(at(0).wave).toBe(0);
    expect(Math.abs(at(0).lat)).toBeLessThan(1e-9);
    expect(at(Math.PI / 2).wave).toBeCloseTo(1, 6);
    // band 8–14 mm on object 0: chunky knit there
    const band = collectZones([{ heightRanges: [{ z0: 8, z1: 14, overrides: { wave_mode: 'wave', wave_height: 0.3, wave_length: 4 } }] }], planes);
    const g = new WaveField(wv({}, { enabled: false }), band, { planes });
    expect(Math.max(...loopAt(g, 55).map((q) => q.lat))).toBeCloseTo(0.3, 2); // z 11.1
    expect(loopAt(g, 20).every((q) => !q.wave)).toBe(true); // z 4.1
  });

  it('keeps ribs and sharp corners smooth, unless switched off', () => {
    // a round vase with 8 fins, 2 mm thick and 3 mm proud
    const pts: Pt[] = [];
    for (let k = 0; k < 8; k++) {
      const a0 = (k * Math.PI) / 4, half = 1 / R;
      for (let t = 0; t < 40; t++) { const a = a0 + half + ((Math.PI / 4 - 2 * half) * t) / 40; pts.push({ x: CX + R * Math.cos(a), y: CY + R * Math.sin(a) }); }
      const a1 = a0 + Math.PI / 4 - half, a2 = a0 + Math.PI / 4 + half;
      for (const [a, r] of [[a1, R], [a1, R + 3], [a2, R + 3], [a2, R]] as [number, number][]) pts.push({ x: CX + r * Math.cos(a), y: CY + r * Math.sin(a) });
    }
    pts.push(pts.shift()!); // the loop shouldn't start on a fin
    const on = weaveLoop(pts, null, 0.1, 0, 0, new WaveField(wv(), [], { planes }).term(40));
    const off = weaveLoop(pts, null, 0.1, 0, 0, new WaveField(wv({}, { smooth_edges: false }), [], { planes }).term(40));
    const tip = (q: WovenPoint) => Math.hypot(q.x - CX, q.y - CY) > R + 1.5;
    const panel = (q: WovenPoint) => { const a = ((angleOf(q) % (Math.PI / 4)) + Math.PI / 4) % (Math.PI / 4); return Math.abs(a - Math.PI / 8) < 0.12; };
    expect(Math.max(...on.filter(tip).map((q) => q.wave ?? 0))).toBe(0);
    expect(Math.min(...on.filter(panel).map((q) => q.wave ?? 0))).toBeGreaterThan(0.95);
    expect(Math.min(...off.filter(tip).map((q) => q.wave ?? 0))).toBeGreaterThan(0.95);
  });
});

const settings = (w: WeaveSettings, o: Record<string, unknown> = {}) => ({ ...weavePrintSettings(w), enable_arc_fitting: false, ...o });
const cfg = (o: Record<string, unknown> = {}) => resolveConfig({ printerId: 'bbl-p1s', plate: 'textured_pei_plate', filamentId: 'generic-pla', presetId: '0.20', overrides: o as never });
const slots = (c: ReturnType<typeof cfg>) => [{ ...slotFromConfig(c), name: 'White', color: '#ffffff' }];
const mx = (w: WeaveSettings): MotionexConfig => ({ applications: [], brushes: [], options: DEFAULT_OPTIONS, collisionMode: 'clamp', toolhead: defaultToolhead('bbl-p1s'), printerId: 'bbl-p1s', weave: w });

/** Outer-wall extrusions per layer from the G-code: [x, y, e] with the move's start point. */
function outer(gcode: string): Map<string, { x0: number; y0: number; x: number; y: number; e: number }[]> {
  const out = new Map<string, { x0: number; y0: number; x: number; y: number; e: number }[]>();
  let z = '', cur = '', x = NaN, y = NaN;
  for (const l of gcode.split('\n')) {
    if (l.startsWith(';Z:')) z = l.slice(3);
    if (l.startsWith(';TYPE:')) cur = l.slice(6).toLowerCase();
    const mx = /X([-\d.]+)/.exec(l), my = /Y([-\d.]+)/.exec(l), me = / E([-\d.]+)/.exec(l);
    const x0 = x, y0 = y;
    if (l.startsWith('G1') || l.startsWith('G0')) { if (mx) x = +mx[1]; if (my) y = +my[1]; }
    if (cur === 'outer wall' && l.startsWith('G1') && me && +me[1] > 0 && (mx || my)) {
      const a = out.get(z) ?? [];
      a.push({ x0, y0, x, y, e: +me[1] });
      out.set(z, a);
    }
  }
  return out;
}

describe('wave zones in the slicer', () => {
  it('a cylinder zone puts the knit only where it meets the vase, keeps plastic per mm, and leaves infill alone', () => {
    const w = wv({}, { enabled: false });
    const c = cfg(settings(w, { sparse_infill_density: 15, top_shell_layers: 0 }));
    // zone: a Ø20 cylinder standing at the +X side of the Ø40 vase
    const zone = { type: 'modifier' as const, ...weld(cylinder(CX + R, CY, 10, 20, 64)), overrides: { wave_mode: 'wave' } };
    const vase = (parts: typeof zone[] = []) => ({ id: 'vase', name: 'vase', ...weld(cylinder(CX, CY, R, 16, 128)), parts });
    const plain = slice([vase()], c, () => {}, { filaments: slots(c), plugins: { motionex: mx(w) } });
    const out = slice([vase([zone])], c, () => {}, { filaments: slots(c), plugins: { motionex: mx(w) } });
    const rep = (out.pluginReports!.motionex as MotionexReport).weave!;
    expect(rep.wave?.zones).toBe(1);
    expect(rep.wave?.zonesUsed).toBe(1);
    expect(rep.wave?.layers).toBeGreaterThan(50);
    // infill: a wave-only modifier changes nothing there
    expect(out.stats.byFeature.sparse_infill?.filamentMm).toBeCloseTo(plain.stats.byFeature.sparse_infill?.filamentMm ?? 0, 3);
    const L = outer(out.gcode).get('8')!;
    const r = (q: { x: number; y: number }) => Math.hypot(q.x - CX, q.y - CY);
    const near = L.filter((q) => Math.abs(angleOf(q)) < 0.2).map(r), far = L.filter((q) => Math.abs(angleOf(q)) > 2.2).map(r); // the -X side (the seam is at +Y)
    expect(Math.max(...near) - Math.min(...near)).toBeGreaterThan(1.5 * KNIT.height_mm);
    expect(Math.max(...far) - Math.min(...far)).toBeLessThan(0.02);
    // plastic per mm: the same along the waved and the plain wall (volume kept)
    // (summed over each stretch: single G-code moves are rounded to 0.001 mm)
    const perMm = (pick: (a: number) => boolean) => {
      const qs = L.filter((q) => pick(angleOf(q)));
      return qs.reduce((a, q) => a + q.e, 0) / qs.reduce((a, q) => a + Math.hypot(q.x - q.x0, q.y - q.y0), 0);
    };
    const waved = perMm((a) => Math.abs(a) < 0.2), straight = perMm((a) => Math.abs(a) > 2.2);
    expect(Math.abs(waved - straight) / straight).toBeLessThan(0.005);
    // the preview knows where the wave is
    expect(out.moveWave).toBeDefined();
    expect(Math.max(...out.moveWave!)).toBe(255);
    expect(plain.moveWave).toBeUndefined();
    expect(Number.isNaN(out.moves.reduce((a, b) => a + b, 0))).toBe(false);
  });
});

describe('motions on a woven wall', () => {
  it('see each woven loop as one closed line: the seam meets itself on every layer', async () => {
    const { PRESETS } = await import('../../src/plugins/motionex/presets');
    const linen = PRESETS.find((b) => b.id === 'preset-linen')!;
    const w = wv({}, { enabled: false }); // plain weave: tucked seam, no wave of its own
    const c = cfg(settings(w));
    const app = { brush_id: linen.id, target: { type: 'body' as const, walls: 'outer' as const }, mask: { z_start: 0.6, z_end: 1e4, fade_in_mm: 0, fade_out_mm: 0 }, order: 0, blend: 'add' as const, enabled: true };
    const conf: MotionexConfig = { ...mx(w), applications: [app], brushes: [linen] };
    const out = slice([{ id: 'vase', name: 'vase', ...weld(cylinder(CX, CY, R, 12, 128)) }], c, () => {}, { filaments: slots(c), plugins: { motionex: conf } });
    let checked = 0;
    for (const [z, L] of outer(out.gcode)) {
      if (+z < 3 || L.length < 20) continue;
      // L[0] is the lead-in from inside the wall, the last move the tail back inside; between them the loop
      const first = L[1], last = L[L.length - 2];
      expect(Math.hypot(first.x0 - last.x, first.y0 - last.y)).toBeLessThan(0.02);
      // and the lead-in and tail stay inside the wall, unwaved
      expect(Math.hypot(L[0].x0 - CX, L[0].y0 - CY)).toBeLessThan(R - 0.5);
      checked++;
    }
    expect(checked).toBeGreaterThan(30);
  });
});
