import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, generate } from '../../src/workbench/generator';
import { PRESETS } from '../../src/plugins/motionex/presets';

describe('Motionex direct G-code generator', () => {
  it('writes a plain cylinder with the expected layer count', () => {
    const r = generate({ ...DEFAULT_SETTINGS, motionOn: false, height: 10 }, null);
    expect(r.layers).toBe(1 + Math.ceil((10 - 0.25) / 0.2 - 1e-6));
    expect(r.gcode).toContain(';LAYER:0');
    expect(r.gcode).toContain('M109 S215');
    expect(r.stats.maxOffset).toBe(0);
    expect(r.gcode).not.toMatch(/[XYZEF]-?(NaN|Infinity)/);
  });
  it('applies library motions without bad numbers and stays on the bed', () => {
    for (const b of PRESETS.filter((_, i) => i % 8 === 0)) {
      const r = generate({ ...DEFAULT_SETTINGS, height: 2, diameter: 30 }, b);
      expect(r.gcode, b.id).not.toMatch(/[XYZEF]-?(NaN|Infinity)/);
      for (const s of r.segs) { expect(s.x).toBeGreaterThan(0); expect(s.y).toBeGreaterThan(0); expect(s.x).toBeLessThan(256); }
    }
  });
  it('moves the outer wall by the motion size', () => {
    const wave = PRESETS.find((b) => b.id === 'preset-sine')!;
    const r = generate({ ...DEFAULT_SETTINGS, height: 5 }, wave);
    expect(r.stats.maxOffset).toBeGreaterThan(wave.amplitude * 0.9);
    expect(r.stats.maxOffset).toBeLessThan(wave.amplitude * 1.1);
  });
  it('spiral vase climbs continuously', () => {
    const r = generate({ ...DEFAULT_SETTINGS, spiral: true, baseLayers: 2, height: 4, motionOn: false }, null);
    const zs = new Set(r.segs.filter((s) => s.kind === 'wall').map((s) => s.z.toFixed(3)));
    expect(zs.size).toBeGreaterThan(100);
  });
});
