// Motionex wall patterns pushed far past their presets: each slice must finish and pass the strict G-code validator.
import { describe, expect, it } from 'vitest';
import { slice } from '../../src/engine/slicer';
import { PRESETS } from '../../src/plugins/motionex/presets';
import { defaultToolhead } from '../../src/plugins/motionex/core/toolhead';
import { DEFAULT_OPTIONS, MIN_PERIOD_MM, placedBrush } from '../../src/plugins/motionex/modifier';
import { box, cylinder } from '../fixtures';
import { cfgWith, mesh, PRINTER } from './helpers';
import { describeIssues, validateSlice } from './gcodeValidator';

describe('Motionex wall patterns at extremes', () => {
  const shapes = () => [mesh(box(110, 110, 0, 14, 14, 5), 'cube'), mesh(cylinder(150, 150, 6, 5, 48), 'cyl')];
  const cases: [string, (b: any) => { amplitude: number; period_mm: number; z_amplitude?: number; scale: number }][] = [
    ['preset', (b) => ({ amplitude: b.amplitude, period_mm: b.period_mm, z_amplitude: b.z_amplitude, scale: 1 })],
    ['20× amplitude, big Z waves', (b) => ({ amplitude: b.amplitude * 20, period_mm: b.period_mm, z_amplitude: (b.z_amplitude ?? 0) * 10 + 2, scale: 3 })],
    ['0.05 mm period', (b) => ({ amplitude: b.amplitude, period_mm: 0.05, z_amplitude: 0, scale: 1 })],
    ['zero amplitude and scale', (b) => ({ amplitude: 0, period_mm: b.period_mm, z_amplitude: 0, scale: 0 })],
    ['10× scale', () => ({ amplitude: 5, period_mm: 0.2, z_amplitude: 3, scale: 10 })],
  ];
  const check = (b: any, label: string, f: (typeof cases)[number][1], mode: string) => {
    const { scale, ...shape } = f(b);
    const brush = { ...b, ...shape };
    const app = { brush_id: b.id, brush, target: { type: 'body', walls: 'all' }, mask: { z_start: 0, z_end: 1e4, fade_in_mm: 0, fade_out_mm: 0 }, order: 0, blend: 'add', enabled: true, scale };
    const cfg = cfgWith({ overrides: { enable_arc_fitting: false } });
    const out = slice(shapes(), cfg, () => {}, { plugins: { motionex: { applications: [app], brushes: [brush], options: DEFAULT_OPTIONS, collisionMode: mode, toolhead: defaultToolhead(PRINTER), printerId: PRINTER } } as any });
    // a "plastic amount" curve may triple the flow on purpose: the per-mm ceiling does not apply
    const issues = validateSlice(out, cfg, { skipFlowCeiling: true });
    expect(issues, `${b.id}: ${label} / ${mode}\n${describeIssues(issues)}`).toEqual([]);
  };
  // one pattern of each family through every extreme, in both collision modes
  const families = [...new Map(PRESETS.map((b: any) => [b.category, b])).values()];
  for (const b of families) it(`${b.category}: ${b.id}, every extreme`, () => { for (const [label, f] of cases) for (const mode of ['clamp', 'warn']) check(b, label, f, mode); });
  // every pattern in the library at the harshest setting
  it(`all ${PRESETS.length} library patterns at 20× amplitude with big Z waves`, () => { for (const b of PRESETS) check(b, cases[1][0], cases[1][1], 'clamp'); }, 600_000);
  it('a size of 0 or a 0 / invalid spacing no longer stalls event placement (was ~70 s, then "Invalid array length")', () => {
    const b: any = PRESETS.find((p: any) => p.events?.length);
    for (const [period, scale] of [[b.period_mm, 0], [0, 1], [NaN, 1], [-3, 1]]) {
      const placed = placedBrush({ scale } as any, { ...b, period_mm: period });
      expect(placed.period_mm).toBeGreaterThanOrEqual(MIN_PERIOD_MM);
      const t0 = Date.now();
      check({ ...b, period_mm: period }, `period ${period}, size ${scale}`, () => ({ amplitude: b.amplitude, period_mm: period, z_amplitude: 0, scale }), 'clamp');
      expect(Date.now() - t0).toBeLessThan(15_000);
    }
  });
});
