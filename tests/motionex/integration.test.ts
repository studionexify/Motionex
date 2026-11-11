// Motionex inside Nexspiro's real slicer: picked surfaces, wall choice, and G-code written by Nexspiro.
import { describe, expect, it } from 'vitest';
import { slice } from '../../src/engine/slicer';
import { weld } from '../../src/engine/mesh';
import { growFaces, triNormals } from '../../src/engine/facesets';
import { resolveConfig } from '../../src/profiles/resolve';
import { box, cylinder } from '../fixtures';
import { PRESETS } from '../../src/plugins/motionex/presets';
import { defaultToolhead } from '../../src/plugins/motionex/core/toolhead';
import { DEFAULT_OPTIONS } from '../../src/plugins/motionex/modifier';
import type { MotionexConfig, MotionexReport } from '../../src/plugins/motionex/engine';
import type { MotionApplication } from '../../src/plugins/motionex/model';

const cfg = (printerId = 'bbl-x1c', o = {}) => resolveConfig({ printerId, plate: 'textured_pei_plate', filamentId: 'generic-pla', presetId: '0.20', overrides: { enable_arc_fitting: false, ...o } });
const sine = PRESETS.find((b) => b.id === 'preset-sine')!;
const app = (target: MotionApplication['target']): MotionApplication => ({ brush_id: sine.id, target, mask: { z_start: 2, z_end: 1e4, fade_in_mm: 0, fade_out_mm: 0 }, order: 0, blend: 'add', enabled: true });
const mx = (apps: MotionApplication[], printerId = 'bbl-x1c'): MotionexConfig => ({ applications: apps, brushes: [sine], options: DEFAULT_OPTIONS, collisionMode: 'clamp', toolhead: defaultToolhead(printerId), printerId });

/** Wall moves of one layer, by feature, from the G-code text. */
function wallXY(gcode: string, layerZ: string, type: string): [number, number][] {
  const start = gcode.indexOf(`;Z:${layerZ}\n`);
  const end = gcode.indexOf(';LAYER_CHANGE', start);
  const lines = gcode.slice(start, end).split('\n');
  const out: [number, number][] = [];
  let cur = '', x = NaN, y = NaN;
  for (const l of lines) {
    if (l.startsWith(';TYPE:')) cur = l.slice(6);
    const mx = /X([-\d.]+)/.exec(l), my = /Y([-\d.]+)/.exec(l);
    if (mx) x = +mx[1]; if (my) y = +my[1];
    if (cur === type && l.startsWith('G1') && / E[\d.]/.test(l) && (mx || my)) out.push([x, y]); // a bare G1 E (deretraction) is not a wall move
  }
  return out;
}

describe('face picking', () => {
  it('grows to one flat side of a cube and the whole curved side of a cylinder', () => {
    const cube = weld(box(0, 0, 0, 20, 20, 20));
    expect(growFaces(cube, 8).length).toBe(2); // one flat side = two triangles
    const cyl = weld(cylinder(0, 0, 10, 20, 64));
    expect(growFaces(cyl, 2).length).toBe(128); // 64 segments × 2 side triangles, caps excluded
  });
});

describe('Motionex in the slicer', () => {
  const mesh = () => ({ id: 'cube', name: 'cube', ...weld(box(100, 100, 0, 20, 20, 10)) });

  it('whole body, outer wall: waves on every side; inner walls follow; Nexspiro writes the G-code', () => {
    const plain = slice([mesh()], cfg());
    const out = slice([mesh()], cfg(), () => {}, { plugins: { motionex: mx([app({ type: 'body', walls: 'outer' })]) } });
    const rep = out.pluginReports!.motionex as MotionexReport;
    expect(rep.movedPaths).toBeGreaterThan(30);
    expect(out.gcode).toMatch(/^; plugin: Motionex/m);
    expect(out.gcode).toMatch(/^; motionex: .* whole body, outer walls/m);
    const outer = wallXY(out.gcode, '5', 'outer wall');
    expect(outer.length).toBeGreaterThan(wallXY(plain.gcode, '5', 'outer wall').length * 5);
    // sine waves push the wall in and out of the flat 100..120 faces
    expect(outer.some(([x]) => x > 120.1)).toBe(true);
    // the inner wall follows the outer wall's waves so the two stay fused, but stays inside the part
    const inner = wallXY(out.gcode, '5', 'inner wall');
    expect(inner).not.toEqual(wallXY(plain.gcode, '5', 'inner wall'));
    expect(inner.every(([x, y]) => x > 99.5 && x < 120.5 && y > 99.5 && y < 120.5)).toBe(true);
    const loose = slice([mesh()], cfg(), () => {}, { plugins: { motionex: { ...mx([app({ type: 'body', walls: 'outer' })]), options: { ...DEFAULT_OPTIONS, bondInnerWalls: false } } } });
    // without bonding the inner wall stays where the slicer put it, only cut back where the waves reach it
    const onSquare = ([x, y]: [number, number]) => (Math.abs(x - 100.602) < 2e-3 || Math.abs(x - 119.398) < 2e-3) ? y > 100.6 && y < 119.4 : (Math.abs(y - 100.602) < 2e-3 || Math.abs(y - 119.398) < 2e-3) && x > 100.6 && x < 119.4;
    const looseInner = wallXY(loose.gcode, '5', 'inner wall');
    expect(wallXY(plain.gcode, '5', 'inner wall').every(onSquare)).toBe(true);
    expect(looseInner.length).toBeGreaterThan(4);
    expect(looseInner.every(onSquare)).toBe(true);
    // below the mask start the print is unchanged
    expect(wallXY(out.gcode, '1', 'outer wall')).toEqual(wallXY(plain.gcode, '1', 'outer wall'));
    expect(out.stats.filamentMm).toBeGreaterThan(plain.stats.filamentMm);
  });

  it('inner walls only', () => {
    const plain = slice([mesh()], cfg());
    const out = slice([mesh()], cfg(), () => {}, { plugins: { motionex: mx([app({ type: 'body', walls: 'inner' })]) } });
    expect(wallXY(out.gcode, '5', 'outer wall')).toEqual(wallXY(plain.gcode, '5', 'outer wall'));
    expect(wallXY(out.gcode, '5', 'inner wall').length).toBeGreaterThan(wallXY(plain.gcode, '5', 'inner wall').length * 3);
  });

  it('picked face: only the +X side gets the motion', () => {
    const m = mesh();
    const n = triNormals(m);
    const seed = Array.from({ length: m.indices.length / 3 }, (_, t) => t).find((t) => n[t * 3] > 0.99)!;
    const tris = growFaces(m, seed);
    expect(tris.length).toBe(2);
    const out = slice([{ ...m, faceSets: [{ id: 'fs1', name: 'Right side', tris }] }], cfg(), () => {}, {
      plugins: { motionex: mx([app({ type: 'faces', walls: 'outer', faces: ['cube:fs1'] })]) },
    });
    const outer = wallXY(out.gcode, '5', 'outer wall');
    const off = (v: number, lo: number, hi: number) => v < lo - 0.05 || v > hi + 0.05;
    // the waved points sit near x = 120 (right side); the far left side stays straight
    const waved = outer.filter(([x, y]) => off(x, 100.2, 119.8) && y > 101 && y < 119);
    expect(waved.length).toBeGreaterThan(10);
    expect(waved.every(([x]) => x > 115)).toBe(true);
  });

  it('no plugin config means byte-identical output', () => {
    const a = slice([mesh()], cfg()), b = slice([mesh()], cfg(), () => {}, { plugins: {} });
    expect(b.gcode).toBe(a.gcode);
  });
});
