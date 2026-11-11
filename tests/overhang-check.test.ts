import { describe, expect, it } from 'vitest';
import { findOverhangs } from '../src/engine/overhangCheck';
import { smoothOverhangRuns } from '../src/engine/overhangRuns';
import { slice } from '../src/engine/slicer';
import { resolveConfig } from '../src/profiles/resolve';
import { primitive } from '../src/state/ops';
import { FEATURE_ORDER } from '../src/engine/types';
import { box } from './fixtures';
import { weld } from '../src/engine/mesh';

const sphere = () => {
  const m = primitive('sphere', 20);
  const v = m.vertices.slice(); for (let i = 0; i < v.length; i += 3) { v[i] += 110; v[i + 1] += 110; v[i + 2] += 10; }
  return { id: 's', name: 'Sphere', vertices: v, indices: m.indices };
};

describe('overhang check', () => {
  it('flags a sphere and not a box resting on the bed', () => {
    expect(findOverhangs([sphere()], 30).map((f) => f.name)).toEqual(['Sphere']);
    const b = weld(box(100, 100, 0, 20, 20, 20));
    expect(findOverhangs([{ name: 'Box', vertices: b.vertices, indices: b.indices }], 30)).toEqual([]);
  });
  it('merges short overhang runs into their neighbours', () => {
    const pts: number[] = []; for (let k = 0; k < 41; k++) pts.push(k, 0); // 40 segments of 1 mm
    const f = new Array(41).fill('outer_wall'), s = new Array(41).fill(0), fan = new Array(41).fill(0);
    for (const k of [5, 6, 15, 25, 26, 35]) { f[k] = 'overhang_wall'; s[k] = 30; }
    smoothOverhangRuns(pts, false, f, s, fan, 4);
    expect(new Set(f.slice(1))).toEqual(new Set(['outer_wall']));
    expect(new Set(s.slice(1))).toEqual(new Set([0]));
  });
  it('a sliced sphere switches wall speed or line type only once per loop', () => {
    const cfg = resolveConfig({ printerId: 'creality-ender3v3ke', plate: 'textured_pei' as any, filamentId: 'generic-pla', presetId: '0.20', overrides: {} });
    const out = slice([sphere()], cfg);
    const M = out.moves, S = 8;
    for (const L of out.layers) {
      let switches = 0;
      for (let i = L.moveStart + 1; i < L.moveEnd; i++) {
        const f = FEATURE_ORDER[out.moveFeatures[i]], pf = FEATURE_ORDER[out.moveFeatures[i - 1]];
        const wall = (x: string) => x === 'outer_wall' || x === 'overhang_wall';
        if (wall(f) && wall(pf) && (f !== pf || M[i * S + 5] !== M[(i - 1) * S + 5])) switches++;
      }
      expect(switches, `layer at z ${L.z}`).toBeLessThanOrEqual(2);
    }
  }, 60000);
});
