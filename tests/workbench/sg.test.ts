import { it, expect } from 'vitest';
import { defaultDesign, meshGrid } from '../../src/workbench/design';
import { surfaceGrid } from '../../src/workbench/surfacegrid';
import { stlFromDesign } from '../../src/workbench/stl';
it('grid speed + stl', () => {
  for (const kind of ['trellis', 'hexcells']) {
    const d = { ...defaultDesign('vase'), relief: { kind, count: 10, depth: 1.2, start: 0, end: 1, transition: 0.06 } };
    const { rows, cols } = meshGrid(d, 380_000);
    let t = performance.now(); const g = surfaceGrid(d, rows, cols, 'outer'); const a = performance.now() - t;
    for (const v of g.pos) expect(Number.isFinite(v)).toBe(true);
    t = performance.now(); const stl = stlFromDesign(d); const b = performance.now() - t;
    console.log('SG', kind, rows, cols, 'grid ms', a.toFixed(0), 'stl ms', b.toFixed(0), 'MB', (stl.byteLength / 1e6).toFixed(0));
  }
});
