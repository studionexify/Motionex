// Select & apply: rules on layer ranges, single lines and brushed areas, inside the real slicer.
import { describe, expect, it } from 'vitest';
import { slice, slotFromConfig } from '../../src/engine/slicer';
import { weld } from '../../src/engine/mesh';
import { resolveConfig } from '../../src/profiles/resolve';
import { cylinder } from '../fixtures';
import { defaultToolhead } from '../../src/plugins/motionex/core/toolhead';
import { DEFAULT_OPTIONS } from '../../src/plugins/motionex/modifier';
import type { MotionexConfig, MotionexReport } from '../../src/plugins/motionex/engine';
import { newRule, type SelectRule } from '../../src/plugins/motionex/select/model';
import { piecesAt, weightAt } from '../../src/plugins/motionex/select/geometry';
import { PRESETS } from '../../src/plugins/motionex/presets';
import { MOVE_STRIDE } from '../../src/engine/gcode';

const CX = 128, CY = 128, R = 15;
const cfg = (printerId = 'snapmaker-u1') => resolveConfig({ printerId, plate: 'textured_pei_plate', filamentId: 'generic-pla', presetId: '0.20', overrides: {} as never });
const part = () => ({ id: 'cyl', name: 'cyl', ...weld(cylinder(CX, CY, R, 8, 96)) });
const mx = (rules: SelectRule[], printerId = 'snapmaker-u1'): MotionexConfig => ({
  applications: [], brushes: PRESETS.filter((b) => rules.some((r) => r.apply.motion?.brush_id === b.id)), options: DEFAULT_OPTIONS,
  collisionMode: 'clamp', toolhead: defaultToolhead(printerId), printerId, rules,
});
const rule = (p: Partial<SelectRule>): SelectRule => ({ ...newRule(1), ...p });
function run(rules: SelectRule[], printerId = 'snapmaker-u1') {
  const c = cfg(printerId);
  const a = slotFromConfig(c);
  const filaments = [0, 1].map((k) => ({ ...a, name: `PLA ${k + 1}`, color: ['#ffffff', '#cc2222'][k] }));
  const out = slice([part()], c, () => {}, { filaments, plugins: { motionex: mx(rules, printerId) } });
  return { out, rep: out.pluginReports?.motionex as MotionexReport | undefined };
}
/** Moves of a layer whose top is near z: [x, y, speed, tool, feature]. */
function movesAt(out: ReturnType<typeof run>['out'], z: number) {
  const L = out.layers.find((l) => Math.abs(l.z - z) < 0.05)!;
  const r: [number, number, number, number, number][] = [];
  for (let k = L.moveStart; k < L.moveEnd; k++) r.push([out.moves[k * MOVE_STRIDE], out.moves[k * MOVE_STRIDE + 1], out.moves[k * MOVE_STRIDE + 5], out.moves[k * MOVE_STRIDE + 7], out.moveFeatures[k]]);
  return r;
}

describe('select geometry', () => {
  it('fades a layer range over the blend distance above and below', () => {
    const r = rule({ pick: { kind: 'layers', z0: 3, z1: 4 }, blend_mm: 1 });
    expect(piecesAt(r, 3.4, 0.2)[0].zf).toBe(1);
    const above = piecesAt(r, 4.6, 0.2)[0].zf;
    expect(above).toBeGreaterThan(0); expect(above).toBeLessThan(1);
    expect(piecesAt(r, 6, 0.2)).toHaveLength(0);
  });
  it('a picked line is selected on its own feature only, with a soft edge along the layer', () => {
    const r = rule({ pick: { kind: 'lines', lines: [{ z: 2, h: 0.2, feature: 'outer_wall', w: 0.42, pts: [[0, 0], [10, 0]] }] }, blend_mm: 2 });
    const p = piecesAt(r, 2, 0.2);
    expect(weightAt(p, 2, 5, 0, 'outer_wall')).toBe(1);
    expect(weightAt(p, 2, 5, 0, 'inner_wall')).toBe(0);
    const near = weightAt(p, 2, 11, 0, 'outer_wall');
    expect(near).toBeGreaterThan(0); expect(near).toBeLessThan(1);
    expect(weightAt(p, 2, 14, 0, 'outer_wall')).toBe(0);
  });
  it('a moved object takes its selections along', () => {
    const r = rule({ pick: { kind: 'brush', dabs: [{ obj: 'a', x: 10, y: 10, z: 2, r: 1 }] }, anchors: { a: [0, 0] }, blend_mm: 0 });
    expect(weightAt(piecesAt(r, 2, 0.2, { a: [0, 0] }), 0, 10, 10, 'outer_wall')).toBe(1);
    expect(weightAt(piecesAt(r, 2, 0.2, { a: [20, 0] }), 0, 10, 10, 'outer_wall')).toBe(0);
    expect(weightAt(piecesAt(r, 2, 0.2, { a: [20, 0] }), 0, 30, 10, 'outer_wall')).toBe(1);
  });
});

describe('select & apply in the slicer', () => {
  it('prints a layer range with another filament on a tool changer', () => {
    const { out } = run([rule({ pick: { kind: 'layers', z0: 3, z1: 4 }, apply: { filament: 1 } })]);
    expect(movesAt(out, 3.4).filter((m) => m[4] === 0).every((m) => m[3] === 1)).toBe(true);
    expect(movesAt(out, 6).filter((m) => m[4] === 0).every((m) => m[3] === 0)).toBe(true);
    expect(out.stats.toolChanges).toBeGreaterThanOrEqual(2);
  });

  it('limits a filament to the outer wall when only that line kind is chosen', () => {
    const { out } = run([rule({ pick: { kind: 'layers', z0: 3, z1: 4 }, lines: ['outer'], apply: { filament: 1 } })]);
    const m = movesAt(out, 3.4);
    expect(m.some((x) => x[3] === 1)).toBe(true);
    expect(m.some((x) => x[3] === 0)).toBe(true);
  });

  it('slows a brushed area, fading out around it', () => {
    const base = run([]).out;
    const { out, rep } = run([rule({ pick: { kind: 'brush', dabs: [{ x: CX + R, y: CY, z: 4, r: 2 }] }, apply: { speed: 50 }, blend_mm: 3 })]);
    expect(Object.values(rep!.select!.moves)[0]).toBeGreaterThan(0);
    const near = movesAt(out, 4).filter((m) => m[4] === 0 && Math.hypot(m[0] - CX - R, m[1] - CY) < 1);
    const far = movesAt(out, 4).filter((m) => m[4] === 0 && Math.hypot(m[0] - CX + R, m[1] - CY) < 3);
    const baseFar = movesAt(base, 4).filter((m) => m[4] === 0 && Math.hypot(m[0] - CX + R, m[1] - CY) < 3);
    expect(near.length).toBeGreaterThan(0);
    expect(Math.max(...near.map((m) => m[2]))).toBeLessThan(Math.min(...baseFar.map((m) => m[2])));
    expect(Math.min(...far.map((m) => m[2]))).toBeCloseTo(Math.min(...baseFar.map((m) => m[2])), 0);
    expect(out.stats.timeSeconds).toBeGreaterThan(base.stats.timeSeconds);
  });

  it('sets the temperature on the selected layers and goes back after', () => {
    const { out } = run([rule({ pick: { kind: 'layers', z0: 3, z1: 3.4 }, apply: { temp: 235 } })]);
    const lines = out.gcode.split('\n');
    const at = lines.findIndex((l) => l.startsWith('M104 S235'));
    expect(at).toBeGreaterThan(0);
    expect(lines.slice(at + 1).some((l) => /^M104 S2[012]\d/.test(l) && !l.startsWith('M104 S235'))).toBe(true);
  });

  it('moves the walls of a picked line with a motion, and only near it', () => {
    const base = run([]).out;
    const L = base.layers.find((l) => Math.abs(l.z - 4) < 0.05)!;
    const pts: [number, number][] = [];
    for (let k = L.moveStart; k < L.moveEnd; k++) if (base.moveFeatures[k] === 0) pts.push([base.moves[k * MOVE_STRIDE], base.moves[k * MOVE_STRIDE + 1]]);
    const brush = PRESETS[0].id;
    const { out, rep } = run([rule({ pick: { kind: 'lines', lines: [{ z: L.z, h: L.height, feature: 'outer_wall', w: 0.42, pts }] }, apply: { motion: { brush_id: brush, scale: 1 } }, blend_mm: 2 })]);
    expect(rep!.movedPaths).toBeGreaterThan(0);
    const r = (m: number[]) => Math.hypot(m[0] - CX, m[1] - CY);
    const spread = (o: typeof out, z: number) => { const rs = movesAt(o, z).filter((m) => m[4] === 0).map(r); return Math.max(...rs) - Math.min(...rs); };
    expect(spread(out, L.z)).toBeGreaterThan(spread(base, L.z) + 0.2);
    expect(spread(out, 7)).toBeCloseTo(spread(base, 7), 2);
  });

  it('a single-layer rule with a motion changes that layer, and pause motions leave marks for the preview', () => {
    const base = run([]).out;
    const r = (m: number[]) => Math.hypot(m[0] - CX, m[1] - CY);
    const spread = (o: typeof base) => { const rs = movesAt(o, 4).filter((m) => m[4] === 0).map(r); return Math.max(...rs) - Math.min(...rs); };
    const one = (brush: string) => run([rule({ pick: { kind: 'layers', z0: 4, z1: 4 }, lines: ['outer'], apply: { motion: { brush_id: brush, scale: 2.5 } }, blend_mm: 2 })]).out;
    expect(spread(one(PRESETS[0].id))).toBeGreaterThan(spread(base) + 0.5);
    const dots = one(PRESETS.find((b) => b.name === 'Big dots')!.id);
    expect(dots.pauses?.length).toBeGreaterThan(0);
    for (let k = 2; k < dots.pauses!.length; k += 4) expect(Math.abs(dots.pauses![k] - 4)).toBeLessThan(1.5);
    expect(base.pauses).toBeUndefined();
  });
});
