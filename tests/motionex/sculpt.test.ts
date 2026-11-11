// Path sculpt: hand-made moves on the unrolled wall, in the real slicer and in the preview warp.
import { describe, expect, it } from 'vitest';
import { slice, slotFromConfig } from '../../src/engine/slicer';
import { weld } from '../../src/engine/mesh';
import { resolveConfig } from '../../src/profiles/resolve';
import { cylinder } from '../fixtures';
import { defaultToolhead } from '../../src/plugins/motionex/core/toolhead';
import { DEFAULT_OPTIONS } from '../../src/plugins/motionex/modifier';
import type { MotionexConfig } from '../../src/plugins/motionex/engine';
import { defaultSculpt, sculptAt } from '../../src/plugins/motionex/sculpt/model';
import { makeWarp } from '../../src/plugins/motionex/sculpt/preview';

const CX = 128, CY = 128, R = 20;
const cfg = () => resolveConfig({ printerId: 'bbl-p1s', plate: 'textured_pei_plate', filamentId: 'generic-pla', presetId: '0.20', overrides: { wall_loops: 1, sparse_infill_density: 0, enable_arc_fitting: false } as never });
const vase = () => ({ id: 'v', name: 'v', ...weld(cylinder(CX, CY, R, 12, 96)) });
const mx = (sculpt?: MotionexConfig['sculpt']): MotionexConfig => ({ applications: [], brushes: [], options: DEFAULT_OPTIONS, collisionMode: 'clamp', toolhead: defaultToolhead('bbl-p1s'), printerId: 'bbl-p1s', sculpt });

/** Outer-wall radius by angle bucket (0 = +X side), for layers around z. */
function radii(gcode: string, zWant: number): number[] {
  const out: number[][] = Array.from({ length: 4 }, () => []);
  let z = 0, cur = '', x = NaN, y = NaN;
  for (const l of gcode.split('\n')) {
    if (l.startsWith(';Z:')) z = +l.slice(3);
    if (l.startsWith(';TYPE:')) cur = l.slice(6);
    const mxm = /X([-\d.]+)/.exec(l), mym = /Y([-\d.]+)/.exec(l);
    if (l.startsWith('G1') || l.startsWith('G0')) { if (mxm) x = +mxm[1]; if (mym) y = +mym[1]; }
    if (/outer wall/i.test(cur) && l.startsWith('G1') && / E[\d.]/.test(l) && Math.abs(z - zWant) < 0.11) {
      const a = Math.atan2(y - CY, x - CX), q = Math.floor((((a / (2 * Math.PI)) % 1) + 1) % 1 * 4);
      out[q].push(Math.hypot(x - CX, y - CY));
    }
  }
  return out.map((r) => (r.length ? r.reduce((s, v) => s + v, 0) / r.length : NaN));
}

describe('path sculpt', () => {
  it('blends cells smoothly and wraps round the part', () => {
    const s = { ...defaultSculpt(), enabled: true, w: 8, h: 4, d: { 0: 1 } as Record<number, number> };
    expect(sculptAt(s, 0.5 / 8, 87.5, 100)).toBeCloseTo(1, 5); // centre of the top-left cell, row 0 = top
    expect(sculptAt(s, 0.99, 87.5, 100)).toBeGreaterThan(0.05); // wraps to the first column
    expect(sculptAt(s, 0.5, 50, 100)).toBe(0);
    expect(sculptAt({ ...s, d: { 0: 9 }, max_mm: 2 }, 0.5 / 8, 87.5, 100)).toBeLessThanOrEqual(2);
  });

  it('pushes the picked part of the wall out in the slicer and leaves the rest', () => {
    const c = cfg(), a = slotFromConfig(c);
    // 4 columns × 1 row: only the first column (angles 0..90°, +X to +Y) moves 1.5 mm out
    const sculpt = { ...defaultSculpt(), enabled: true, w: 4, h: 1, d: { 0: 1.5 } as Record<number, number>, max_mm: 3 };
    const plain = slice([vase()], c, () => {}, { filaments: [a], plugins: {} });
    const moved = slice([vase()], c, () => {}, { filaments: [a], plugins: { motionex: mx(sculpt) } });
    const z = 6;
    const r0 = radii(plain.gcode, z), r1 = radii(moved.gcode, z);
    expect(r1[0] - r0[0]).toBeGreaterThan(0.6);
    expect(Math.abs(r1[2] - r0[2])).toBeLessThan(0.05);
    expect(Math.abs(r1[3] - r0[3])).toBeLessThan(0.3);
  });

  it('warps preview points the same way', () => {
    const o = vase();
    const s = { ...defaultSculpt(), enabled: true, w: 4, h: 1, d: { 0: 1.5 } as Record<number, number> };
    const warp = makeWarp(s, [{ id: o.id, mesh: o }])!;
    const [x, y] = warp(CX + R * Math.cos(0.4), CY + R * Math.sin(0.4), 6);
    expect(Math.hypot(x - CX, y - CY)).toBeGreaterThan(R + 0.8);
    const [x2, y2] = warp(CX - R, CY, 6);
    expect(Math.hypot(x2 - CX, y2 - CY)).toBeCloseTo(R, 1);
    expect(makeWarp({ ...s, d: {} }, [{ id: o.id, mesh: o }])).toBeNull();
  });
});

import { cellAt, pickedOf, pickPoint } from '../../src/plugins/motionex/sculpt/selection';
describe('picking on the model', () => {
  const s = { ...defaultSculpt(), enabled: true, w: 8, h: 4 };
  it('turns a point on the wall into a cell of the map', () => {
    // +X side, near the top of a 100 mm part: first column, top row
    expect(cellAt(s, 0, 0, 100, 10, 0.1, 95)).toEqual([0, 0]);
    // -X side, near the bottom: column 4, bottom row
    expect(cellAt(s, 0, 0, 100, -10, -0.01, 5)).toEqual([4, 3]);
    expect(cellAt({ ...s, z_start: 50 }, 0, 0, 100, 10, 0, 20)).toBeNull();
  });
  it('picks and unpicks with the brush, wrapping round the part', () => {
    pickedOf('sculpt', 8, 4).clear();
    expect(pickPoint(s, 0, 0, 100, 10, -0.1, 50, false)).toBe(true); // column 7 (just below +X)
    const S = pickedOf('sculpt', 8, 4);
    expect(S.size).toBeGreaterThan(1);
    expect([...S].some((i) => i % 8 === 0) && [...S].some((i) => i % 8 === 7)).toBe(true);
    pickPoint(s, 0, 0, 100, 10, -0.1, 50, true);
    expect(S.size).toBe(0);
  });
});
