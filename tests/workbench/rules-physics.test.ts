import { describe, expect, it } from 'vitest';
import { DEFAULT_SLICE, slice } from '../../src/workbench/generator';
import { defaultDesign } from '../../src/workbench/design';
import { PRESETS } from '../../src/plugins/motionex/presets';
import { newRule, rowsToRects } from '../../src/workbench/rules';
import { DEFAULT_PHYSICS, simulate } from '../../src/workbench/physics';

const brush = (id: string) => PRESETS.find((b) => b.id === id);
const small = () => ({ ...defaultDesign('vase'), height: 8, maxDiameter: 40, openBottom: true });

describe('body rules', () => {
  it('applies motion only inside the selected patch', () => {
    const r = newRule(1); r.brushId = 'preset-sine'; r.soft = 0; r.lines = { outer: true, inner: false, base: false };
    r.rects = [{ z0: 4, z1: 6, a0: 0, a1: 0.25 }];
    const res = slice(small(), { ...DEFAULT_SLICE, spiral: false, baseLayers: 0 }, [], brush, [r]);
    const m = res.segs.filter((s) => s.kind === 'motion');
    expect(m.length).toBeGreaterThan(0);
    for (const s of m) {
      expect(s.z).toBeGreaterThan(3.7); expect(s.z).toBeLessThan(6.3);
      const a = ((Math.atan2(s.y - 128, s.x - 128) / (2 * Math.PI)) + 1) % 1;
      expect(a < 0.3 || a > 0.97).toBe(true);
    }
  });
  it('speed, flow and temperature rules change the G-code', () => {
    const r = newRule(1); r.speed = 50; r.flow = 150; r.temp = 235; r.soft = 0;
    r.rects = [{ z0: 0, z1: 8, a0: 0, a1: 1 }];
    const base = slice(small(), { ...DEFAULT_SLICE, spiral: false, baseLayers: 0 }, [], brush);
    const res = slice(small(), { ...DEFAULT_SLICE, spiral: false, baseLayers: 0 }, [], brush, [r]);
    expect(res.gcode).toContain('M104 S235');
    expect(res.stats.filamentMm).toBeGreaterThan(base.stats.filamentMm * 1.3);
    expect(res.stats.seconds).toBeGreaterThan(base.stats.seconds * 1.5);
  });
  it('merges selected cells into rects', () => {
    const rects = rowsToRects([{ z: 1, dz: 0.5, cells: [false, true, true, false] }, { z: 2, dz: 0.5, cells: [false, true, true, false] }]);
    expect(rects).toEqual([{ z0: 0.5, z1: 2.5, a0: 0.25, a1: 0.75 }]);
  });
});

describe('print physics', () => {
  it('slow corners give blobs, a starved hotend gives thin lines, overhangs sag', () => {
    const d = { ...small(), section: 'square' as const, sides: 4, depth: 0.3 };
    const res = slice(d, { ...DEFAULT_SLICE, spiral: false, speed: 120, maxVolumetric: 40 }, [], brush);
    const lazy = simulate(res, DEFAULT_SLICE, { ...DEFAULT_PHYSICS, accel: 1500, lag: 0.06, hotendFlow: 40 });
    expect(lazy.stats.blobs).toBeGreaterThan(0);
    const starved = simulate(res, DEFAULT_SLICE, { ...DEFAULT_PHYSICS, hotendFlow: 4 });
    expect(starved.stats.starve).toBeGreaterThan(0);
    for (const v of lazy.width) expect(Number.isFinite(v)).toBe(true);
    // a strongly flared bowl overhangs
    const flare = { ...defaultDesign('bowl'), height: 10, maxDiameter: 120, profile: [{ r: 0.2, t: 0 }, { r: 1, t: 1 }], smoothing: 0, openBottom: true };
    const fr = slice(flare, { ...DEFAULT_SLICE, spiral: false, baseLayers: 0 }, [], brush);
    expect(simulate(fr, DEFAULT_SLICE, DEFAULT_PHYSICS).stats.sag).toBeGreaterThan(0);
  });
});

describe('flow compensation', () => {
  it('cuts blobs where motion rides on relief and keeps the G-code valid', async () => {
    const { compensate } = await import('../../src/workbench/physics');
    const { newZone } = await import('../../src/workbench/generator');
    const d = { ...defaultDesign('vase'), height: 10, maxDiameter: 60, openBottom: true, relief: { kind: 'bubbles', count: 18, depth: 2.5, start: 0, end: 1, transition: 0.01 } };
    const z = newZone('preset-sine', 0, 1); z.fade = 0;
    const s = { ...DEFAULT_SLICE, baseLayers: 0 };
    const ph = { ...DEFAULT_PHYSICS, lag: 0.05 };
    const before = simulate(slice(d, s, [z], brush), s, ph).stats;
    const res = slice(d, s, [z], brush);
    const after = compensate(res, s, ph).stats;
    expect(before.blobs).toBeGreaterThan(0);
    expect(after.blobs).toBeLessThan(before.blobs * 0.3);
    expect(res.gcode).not.toMatch(/[XYZEF]-?(NaN|Infinity)/);
  });
});

describe('thin lines and seams', () => {
  it('thin-lines fix removes thin lines; motion closes on itself', async () => {
    const { compensate } = await import('../../src/workbench/physics');
    const { newZone } = await import('../../src/workbench/generator');
    const d = { ...defaultDesign('vase'), height: 10, maxDiameter: 60, openBottom: true, section: 'square' as const, depth: 0.3, relief: { kind: 'bubbles', count: 18, depth: 2.5, start: 0, end: 1, transition: 0.01 } };
    const z = newZone('preset-plump', 0, 1); z.fade = 0; z.size = 4; z.spacing = 1.25;
    const s = { ...DEFAULT_SLICE, baseLayers: 0 };
    const off = slice(d, { ...s, evenThin: false }, [z], brush); const a = compensate(off, { ...s, evenThin: false }, DEFAULT_PHYSICS).stats;
    const on = slice(d, s, [z], brush); const b = compensate(on, s, DEFAULT_PHYSICS).stats;
    expect(b.thin).toBeLessThan(Math.max(3, a.thin * 0.2));
    // seam: last outer-wall point of a layer meets the first (motion offset continuous)
    const L = 12, segs = on.segs.slice(on.layerStart[L], on.layerStart[L + 1]).filter((g) => g.kind === 'motion' || g.kind === 'wall');
    const first = segs[0], last = segs[segs.length - 1];
    expect(Math.hypot(last.x - first.x0, last.y - first.y0)).toBeLessThan(0.6);
  });
});
