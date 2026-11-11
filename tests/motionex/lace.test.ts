// Lace: holes cut into the walls by the toolpath, checked for printability on the G-code itself.
import { describe, expect, it } from 'vitest';
import { slice, slotFromConfig } from '../../src/engine/slicer';
import { weld } from '../../src/engine/mesh';
import { resolveConfig } from '../../src/profiles/resolve';
import { cylinder } from '../fixtures';
import { defaultToolhead } from '../../src/plugins/motionex/core/toolhead';
import { DEFAULT_OPTIONS } from '../../src/plugins/motionex/modifier';
import type { MotionexConfig, MotionexReport } from '../../src/plugins/motionex/engine';
import { defaultLace, type LaceSettings } from '../../src/plugins/motionex/lace/model';
import { lacePrintSettings } from '../../src/plugins/motionex/lace/plan';
import { LACE_PATTERNS, patternOpen } from '../../src/plugins/motionex/lace/patterns';
import { circularRuns, LaceTracker } from '../../src/plugins/motionex/lace/core';
import { defaultPaint } from '../../src/plugins/motionex/paint/model';

const CX = 128, CY = 128, R = 20, H = 30;
const cfg = (o: Record<string, unknown> = {}, printerId = 'bbl-p1s') => resolveConfig({ printerId, plate: 'textured_pei_plate', filamentId: 'generic-pla', presetId: '0.20', overrides: o as never });
const lace = (l: Partial<LaceSettings> = {}): LaceSettings => ({ ...defaultLace(), enabled: true, ...l });
const mx = (l: LaceSettings, printerId = 'bbl-p1s'): MotionexConfig => ({ applications: [], brushes: [], options: DEFAULT_OPTIONS, collisionMode: 'clamp', toolhead: defaultToolhead(printerId), printerId, lace: l });
const part = () => ({ id: 'vase', name: 'vase', ...weld(cylinder(CX, CY, R, H, 160)) });
const BINS = 1440;

function run(l: LaceSettings, o: Record<string, unknown> = {}) {
  const c = cfg({ ...lacePrintSettings(l), enable_arc_fitting: false, ...o });
  const out = slice([part()], c, () => {}, { filaments: [slotFromConfig(c)], plugins: { motionex: mx(l) } });
  return { out, rep: (out.pluginReports!.motionex as MotionexReport).lace!, c };
}

/** Outer wall coverage per layer, as angle bins (1 = printed), from the G-code. */
function coverage(gcode: string, type = 'outer wall'): { z: number; bins: Uint8Array }[] {
  const out: { z: number; bins: Uint8Array }[] = [];
  let cur = '', x = NaN, y = NaN, L: { z: number; bins: Uint8Array } | null = null;
  for (const l of gcode.split('\n')) {
    if (l.startsWith(';Z:')) { L = { z: +l.slice(3), bins: new Uint8Array(BINS) }; out.push(L); }
    if (l.startsWith(';TYPE:')) cur = l.slice(6);
    if (!/^G[01] /.test(l)) continue;
    const g = (k: string) => { const m = new RegExp(`${k}(-?[\\d.]+)`).exec(l); return m ? +m[1] : NaN; };
    const px = x, py = y;
    if (!isNaN(g('X'))) x = g('X');
    if (!isNaN(g('Y'))) y = g('Y');
    if (cur !== type || !L || !(g('E') > 0) || !/[XY]/.test(l) || isNaN(px)) continue;
    const len = Math.hypot(x - px, y - py), m = Math.max(1, Math.ceil(len / 0.05));
    for (let k = 0; k <= m; k++) {
      const a = Math.atan2(py + ((y - py) * k) / m - CY, px + ((x - px) * k) / m - CX) / (2 * Math.PI);
      L.bins[Math.floor((a - Math.floor(a)) * BINS) % BINS] = 1;
    }
  }
  return out.filter((q) => q.z > 0);
}

/** Every printed bin stands on printed plastic within the overhang reach, or bridges a short gap. */
function unsupported(layers: { z: number; bins: Uint8Array }[], reachMm: number, bridgeMm: number): number {
  const binMm = (2 * Math.PI * R) / BINS;
  let bad = 0;
  for (let k = 1; k < layers.length; k++) {
    const below = layers[k - 1].bins, here = layers[k].bins;
    const ok = new Uint8Array(BINS);
    const reach = Math.ceil(reachMm / binMm);
    for (let b = 0; b < BINS; b++) if (below[b]) for (let d = -reach; d <= reach; d++) ok[(b + d + BINS) % BINS] = 1;
    for (const [v, st, len] of circularRuns(below)) if (!v && len * binMm <= bridgeMm) for (let q = 0; q < len; q++) ok[(st + q) % BINS] = 1;
    // printed stretches with nothing under them must be short bridges between supported plastic
    const loose = new Uint8Array(BINS);
    for (let b = 0; b < BINS; b++) loose[b] = here[b] && !ok[b] ? 1 : 0;
    for (const [v, st, len] of circularRuns(loose)) {
      if (!v) continue;
      const before = (st - 1 + BINS) % BINS, after = (st + len) % BINS;
      const anchored = here[before] && ok[before] && here[after] && ok[after];
      if (!anchored || len * binMm > bridgeMm) bad += len;
    }
  }
  return bad;
}
const share = (bins: Uint8Array) => bins.reduce((s, v) => s + v, 0) / bins.length;

describe('lace patterns', () => {
  it('every pattern opens part of a cell and leaves strands', () => {
    for (const p of LACE_PATTERNS) {
      let open = 0, n = 0;
      for (let x = 0; x < 16; x += 0.25) for (let y = 0; y < 20; y += 0.25) { n++; if (patternOpen(p, x, y, { cw: 8, ch: 10, strand: 1.6, open: 0.85, seed: 7 })) open++; }
      expect(open / n, p.id).toBeGreaterThan(0.08);
      expect(open / n, p.id).toBeLessThan(0.8);
    }
  });

  it('draws flat hole tops into points instead of leaving them hanging', () => {
    // a square-topped hole: open for 10 mm of height, 10.5 mm wide, far more than a 3 mm bridge
    const px = new Array(36).fill(0);
    px[12 + 1] = 1;
    const l = lace({ source: 'image', image: { w: 12, h: 3, px }, z_start: 0, z_end: 30, rim_mm: 0, min_strand_mm: 0, min_hole_mm: 0 });
    const t = new LaceTracker(l, { total: 30 });
    const loop = { pts: [], u: [], length: 2 * Math.PI * R, cx: 0, cy: 0 };
    const open: number[] = [];
    for (let z = 0.2; z <= 30; z += 0.2) open.push(t.layer([loop], z, 0.2, true)[0].solid.filter((v) => !v).length);
    const top = open.findIndex((v, k) => k > 60 && v === 0);
    // the hole is designed to end at 20 mm; it closes in a point over the next ~10 mm (45°), not at once
    expect(open[100]).toBeGreaterThan(0);
    expect(open[110]).toBeLessThan(open[90]);
    expect(top * 0.2).toBeGreaterThan(22);
    expect(t.stats.openedForSupport).toBeGreaterThan(0);
  });
});

describe('lace walls in the slicer', () => {
  it('cuts printable holes: solid floor and rim, lace in between, every strand supported', () => {
    const l = lace({ pattern: 'diamond', cell_w: 8, cell_h: 10, z_start: 4, rim_mm: 4 });
    const { out, rep, c } = run(l);
    expect(rep.laceLayers).toBeGreaterThan(80);
    expect(rep.holes).toBeGreaterThan(500);
    expect(rep.openShare).toBeGreaterThan(0.1);
    expect(rep.openShare).toBeLessThan(0.7);
    expect(rep.retractions).toBeGreaterThan(100);
    const cov = coverage(out.gcode);
    const at = (z: number) => cov.reduce((b, q) => (Math.abs(q.z - z) < Math.abs(b.z - z) ? q : b));
    expect(share(at(2).bins)).toBeGreaterThan(0.99); // wall below the band
    expect(share(at(28).bins)).toBeGreaterThan(0.99); // rim
    expect(share(at(14).bins)).toBeLessThan(0.9); // lace
    // independent check on the G-code: overhang 45° at 0.2 mm layers (+ a bin of slack), 3 mm bridges
    expect(unsupported(cov, 0.2 + 0.15, 3 + 0.3)).toBe(0);
    // holes go through every wall: the inner wall is cut too
    const inner = out.gcode.split(';Z:14')[1].split(';Z:14.2')[0];
    expect(inner).toMatch(/;TYPE:inner wall/);
    expect(Number(c.wall_loops)).toBe(2);
    expect(out.gcode).not.toMatch(/NaN|Infinity/);
  });

  it('places a picture: dark pixels open, the rest of the wall stays whole', () => {
    // one dark column of 8: a slot an eighth of the way round, starting at +X
    const px = [1, 0, 0, 0, 0, 0, 0, 0];
    const l = lace({ source: 'image', image: { w: 8, h: 1, px }, z_start: 4, rim_mm: 4 });
    const { out } = run(l);
    const mid = coverage(out.gcode).find((q) => Math.abs(q.z - 14) < 0.01)!;
    const openAt = (deg: number) => !mid.bins[Math.floor((deg / 360) * BINS) % BINS];
    expect(openAt(22)).toBe(true);
    expect(openAt(90)).toBe(false);
    expect(openAt(200)).toBe(false);
    expect(1 - share(mid.bins)).toBeLessThan(0.16);
  });

  it('combines with velocity paint: the lace keeps the painted speeds on its strands', () => {
    const l = lace();
    const c = cfg({ ...lacePrintSettings(l), enable_arc_fitting: false });
    const p = { ...defaultPaint(), enabled: true, z_start: 4, speed_light: 30, speed_dark: 150, image: { w: 2, h: 1, px: [0, 1] } };
    const out = slice([part()], c, () => {}, { filaments: [slotFromConfig(c)], plugins: { motionex: { ...mx(l), paint: p } } });
    const rep = out.pluginReports!.motionex as MotionexReport;
    expect(rep.lace!.laceLayers).toBeGreaterThan(80);
    expect(rep.paint!.paintedLayers).toBeGreaterThan(80);
    // outer wall strands at 14 mm: half the way round slow, half fast, by angle (the picture's two columns)
    const layer = out.gcode.split(';Z:14\n')[1].split(';Z:')[0];
    let cur = '', x = NaN, y = NaN, f = 0;
    const byHalf: Record<string, Set<number>> = { a: new Set(), b: new Set() };
    for (const ln of layer.split('\n')) {
      if (ln.startsWith(';TYPE:')) cur = ln.slice(6);
      if (!/^G[01] /.test(ln)) continue;
      const g = (k: string) => { const m = new RegExp(`${k}(-?[\\d.]+)`).exec(ln); return m ? +m[1] : NaN; };
      const px = x, py = y;
      if (!isNaN(g('X'))) x = g('X'); if (!isNaN(g('Y'))) y = g('Y'); if (!isNaN(g('F'))) f = g('F') / 60;
      if (cur !== 'outer wall' || !(g('E') > 0) || isNaN(px) || Math.hypot(x - px, y - py) < 0.3) continue;
      const a = Math.atan2((y + py) / 2 - CY, (x + px) / 2 - CX) / (2 * Math.PI);
      const u = a - Math.floor(a);
      if (u > 0.05 && u < 0.45) byHalf.a.add(Math.round(f)); else if (u > 0.55 && u < 0.95) byHalf.b.add(Math.round(f));
    }
    expect([...byHalf.a]).toEqual([30]);
    expect([...byHalf.b]).toEqual([150]);
  });

  it('outer wall only leaves the inner wall whole behind the holes', () => {
    const l = lace({ walls: 'outer' });
    const { out } = run(l, { wall_loops: 2 });
    const at14 = (type: string) => coverage(out.gcode, type).find((q) => Math.abs(q.z - 14) < 0.01)!.bins;
    expect(share(at14('inner wall'))).toBeGreaterThan(0.99);
    expect(share(at14('outer wall'))).toBeLessThan(0.9);
    expect(out.warnings.some((w) => /inner walls show through/.test(w))).toBe(true);
  });
});
