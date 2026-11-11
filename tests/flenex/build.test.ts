import { describe, expect, it } from 'vitest';
import { newCache, runBuild, type BuildRequest } from '../../src/plugins/flenex/build';
import { PRESETS, designFromPreset } from '../../src/plugins/flenex/presets';
import { newGroup } from '../../src/plugins/flenex/groups';
import { cylinder, initKernel } from '../../src/plugins/flenex/csg';

const req = (over: Partial<BuildRequest> = {}): BuildRequest => ({
  source: 'creature', design: designFromPreset(PRESETS.find((p) => p.id === 'gecko')!), importId: 0, importRot: [0, 0, 0], importScale: 1, cutsMode: 'auto', manualCuts: [], groups: [],
  printerId: 'bbl-a1', clearance: 0, gap: 0, paintOps: [{ kind: 'fill', slot: 1 }], ...over,
});

describe('worker build function', () => {
  it('builds a creature flexi with plain data and reports progress', async () => {
    const msgs: string[] = [], cache = newCache();
    const r = await runBuild(req(), cache, (m) => msgs.push(m));
    expect(r.pieceCount).toBeGreaterThan(3);
    expect(r.closed).toBe(true);
    expect(r.paint.length).toBe(r.mesh.indices.length / 3);
    expect(msgs.length).toBeGreaterThanOrEqual(3);
    expect(r.fit.fits).toBe(true);
    // the base model is cached: changing only the cuts is much cheaper
    const t0 = performance.now();
    const design = req().design; design.segments.count = 8; design.segments.mode = 'even';
    await runBuild(req({ design }), cache);
    expect(performance.now() - t0).toBeLessThan(5000);
  });

  it('an imported model with a part of 5 cuts gives 5 joints; the count changes them', async () => {
    await initKernel();
    const cache = newCache();
    const m = cylinder(8, 8, 0, 120, 40);
    // stand the rod along x like an imported limb
    const v = new Float32Array(m.vertices.length);
    for (let i = 0; i < v.length; i += 3) { v[i] = m.vertices[i + 2] - 60; v[i + 1] = m.vertices[i]; v[i + 2] = m.vertices[i + 1] + 8; }
    cache.imports.set(7, { vertices: v, indices: m.indices });
    const path: [number, number, number][] = Array.from({ length: 13 }, (_, k) => [-60 + k * 10, 0, 8]);
    const g = newGroup('p1', 'Rod', path, undefined, 5);
    const r5 = await runBuild(req({ source: 'import', importId: 7, cutsMode: 'manual', groups: [g] }), cache);
    expect(r5.cuts.length).toBe(5);
    expect(r5.pieceCount).toBe(6);
    expect(r5.reports.every((x) => x.ok)).toBe(true);
    // every plane is square to the rod (normal along x)
    for (const c of r5.cuts) expect(Math.abs(c.normal[0])).toBeGreaterThan(0.99);
    // delete one cut and add a count: edits stay by position
    g.edits[2] = { deleted: true }; g.count = 7;
    const r7 = await runBuild(req({ source: 'import', importId: 7, cutsMode: 'manual', groups: [g] }), cache);
    expect(r7.cuts.length).toBe(6);
  });
});
