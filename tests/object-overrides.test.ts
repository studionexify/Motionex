import { describe, expect, it } from 'vitest';
import { weld } from '../src/engine/mesh';
import { slice } from '../src/engine/slicer';
import { resolveConfig } from '../src/profiles/resolve';
import type { MeshInput } from '../src/engine/types';
import { box } from './fixtures';

const cfg = resolveConfig({ printerId: 'bbl-p1s', plate: 'textured_pei_plate', filamentId: 'generic-pla', presetId: '0.20', overrides: {} });
const mesh = (soup: Float32Array, id: string, overrides?: MeshInput['overrides']): MeshInput => {
  const m = weld(soup);
  return { id, name: id, vertices: m.vertices, indices: m.indices, overrides };
};
function wallFeeds(gcode: string) {
  const left = new Set<number>(), right = new Set<number>();
  let layer = 0, type = '', x = 0, f = 0;
  for (const l of gcode.split('\n')) {
    if (l.startsWith(';LAYER_CHANGE')) layer++;
    const t = /^;TYPE:(.*)/.exec(l); if (t) type = t[1];
    if (!/^G[01] /.test(l)) continue;
    const X = /X([-\d.]+)/.exec(l), F = /F([\d.]+)/.exec(l);
    if (X) x = Number(X[1]);
    if (F) f = Number(F[1]);
    if (layer === 5 && /E[\d.]+/.test(l) && /outer wall/i.test(type)) (x < 128 ? left : right).add(f);
  }
  return { left: [...left], right: [...right] };
}

/** Outer wall feed rates (mm/min) on layer 5, split by x position (left object < 128 < right object). */
describe('per-object settings', () => {
  it('apply a speed override to that object only', () => {
    const a = mesh(box(60, 100, 0, 30, 30, 10), 'a');
    const b = mesh(box(170, 100, 0, 30, 30, 10), 'b', { outer_wall_speed: 40 });
    const out = slice([a, b], cfg);
    const f = wallFeeds(out.gcode);
    expect(f.right.length).toBeGreaterThan(0);
    expect(Math.max(...f.right)).toBeLessThanOrEqual(40 * 60);
    expect(Math.max(...f.left)).toBeGreaterThan(40 * 60);
  });
});
