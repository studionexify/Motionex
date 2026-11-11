import { describe, expect, it } from 'vitest';
import { meshVolume, openEdgeCount } from '../../src/engine/mesh';
import { SAMPLE_MODELS } from '../../src/plugins/clickex/models';
import { defaultSpec } from '../../src/plugins/clickex/model';
import { buildFromModel, scaledModel } from '../../src/plugins/clickex/modelmode';

const asset = (id: string) => ({ name: id, mesh: SAMPLE_MODELS.find((m) => m.id === id)!.make() });

describe('Clickex 3D model mode', () => {
  it('sample models are closed solids', () => {
    for (const m of SAMPLE_MODELS) { const mesh = m.make(); expect(openEdgeCount(mesh), m.id).toBe(0); expect(meshVolume(mesh), m.id).toBeGreaterThan(0); }
  });

  for (const cut of ['split', 'top', 'stand'] as const) {
    it(`${cut}: pumpkin becomes a base and a button`, () => {
      const spec = defaultSpec();
      spec.source = 'model'; spec.model.cut = cut;
      spec.model.splitZ = 16;
      if (cut === 'top') spec.model.buttonD = 26;
      const model = scaledModel(asset('pumpkin'), cut === 'top' ? 140 : 100);
      const t = performance.now();
      const b = buildFromModel(spec, model);
      console.log(cut, 'ms', (performance.now() - t).toFixed(0), b.report.warnings);
      expect(b.parts.length).toBe(2);
      for (const p of b.parts) { expect(p.mesh.indices.length, `${cut} ${p.key}`).toBeGreaterThan(0); expect(meshVolume(p.mesh), `${cut} ${p.key}`).toBeGreaterThan(0); }
    });
  }
});
