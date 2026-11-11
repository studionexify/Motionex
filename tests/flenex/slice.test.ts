import { beforeAll, describe, expect, it } from 'vitest';
import { initKernel } from '../../src/plugins/flenex/csg';
import { autoCuts, buildCreature, chainCuts } from '../../src/plugins/flenex/creature';
import { buildFlexi } from '../../src/plugins/flenex/flexi';
import { fitFor } from '../../src/plugins/flenex/fit';
import { PRESETS, designFromPreset } from '../../src/plugins/flenex/presets';
import { slice } from '../../src/engine/slicer';
import { resolveConfig } from '../../src/profiles/resolve';

beforeAll(initKernel);

describe('NexSpiro slices a flexi', () => {
  for (const id of ['bar']) {
    it(`${id}: layers, walls and G-code come out, joints stay separate pieces`, () => {
      const d = designFromPreset(PRESETS.find((p) => p.id === id)!);
      const base = buildCreature(d);
      const r = buildFlexi(base.mesh, [...autoCuts(d, base.stations), ...chainCuts(d, base.chains, 100)], fitFor(0.4));
      expect(r.pieces.length).toBeGreaterThan(3);
      const v = r.mesh.vertices.slice();
      for (let i = 0; i < v.length; i += 3) { v[i] += 100; v[i + 1] += 100; }
      const cfg = resolveConfig({ printerId: 'bbl-a1', plate: 'textured_pei_plate', filamentId: 'generic-pla', presetId: '0.20', overrides: {} });
      const out = slice([{ id: id, name: id, vertices: v, indices: r.mesh.indices }], cfg);
      expect(out.layers.length).toBeGreaterThan(20);
      expect(out.gcode).toContain(';TYPE:outer wall');
      expect(out.gcode).toMatch(/G1 X[\d.]+ Y[\d.]+ E[\d.]+/);
      expect(out.stats.filamentGrams).toBeGreaterThan(3);
      expect(out.warnings.filter((w) => /open|manifold|hole/i.test(w))).toEqual([]);
    }, 120000);
  }
});
