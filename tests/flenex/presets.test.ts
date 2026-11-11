import { beforeAll, describe, expect, it } from 'vitest';
import { initKernel, volume } from '../../src/plugins/flenex/csg';
import { autoCuts, buildCreature, chainCuts } from '../../src/plugins/flenex/creature';
import { buildFlexi } from '../../src/plugins/flenex/flexi';
import { fitFor } from '../../src/plugins/flenex/fit';
import { PRESETS, designFromPreset } from '../../src/plugins/flenex/presets';
import { openEdgeCount } from '../../src/engine/mesh';
import { bounds } from '../../src/plugins/flenex/csg';

beforeAll(initKernel);

describe('catalogue', () => {
  it('has a long list of designs', () => { expect(PRESETS.length).toBeGreaterThanOrEqual(40); });
  for (const p of PRESETS) {
    it(`${p.name} builds a closed solid on the bed and cuts into a flexi`, () => {
      const d = designFromPreset(p);
      const base = buildCreature(d);
      expect(base.warnings).toEqual([]);
      expect(openEdgeCount(base.mesh)).toBe(0);
      expect(volume(base.mesh)).toBeGreaterThan(0);
      expect(bounds(base.mesh).min[2]).toBeGreaterThanOrEqual(-1e-3);
      const cuts = [...autoCuts(d, base.stations), ...chainCuts(d, base.chains, 100)];
      const r = buildFlexi(base.mesh, cuts, fitFor(0.4));
      expect(openEdgeCount(r.mesh)).toBe(0);
      expect(r.pieces.length).toBeGreaterThanOrEqual(1);
      if (d.segments.from < 1) expect(cuts.length).toBeGreaterThan(0);
    });
  }
});
