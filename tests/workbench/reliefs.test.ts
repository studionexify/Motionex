import { describe, expect, it } from 'vitest';
import { ALL_RELIEFS, defaultDesign, makeSurface } from '../../src/workbench/design';
import { bytesToMap } from '../../src/workbench/reliefs';
import { DEFAULT_SLICE, slice } from '../../src/workbench/generator';
import { parseDxf } from '../../src/workbench/relief-import';

describe('relief library', () => {
  it('every relief gives a finite, varying surface', () => {
    expect(ALL_RELIEFS.length).toBeGreaterThan(90);
    for (const r of ALL_RELIEFS) {
      const d = { ...defaultDesign('vase'), relief: { kind: r.id, count: r.count, depth: r.depth, start: 0, end: 1, transition: 0.05, seed: 3 } };
      const f = makeSurface(d); let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < 40; i++) for (let j = 0; j < 90; j++) { const v = f(20 + i * 3.7, j * 0.0698); expect(Number.isFinite(v)).toBe(true); lo = Math.min(lo, v); hi = Math.max(hi, v); }
      if (r.id !== 'smooth') expect(hi - lo, r.id).toBeGreaterThan(0.05);
    }
  });
  it('image height maps raise the dark parts', () => {
    const b = new Uint8Array(16 * 16); for (let i = 0; i < 16; i++) b[i * 16 + 8] = 255;
    const d = { ...defaultDesign('vase'), section: 'round' as const, relief: { kind: 'image', count: 1, depth: 2, start: 0, end: 1, transition: 0.001, map: bytesToMap(16, 16, b) } };
    const f = makeSurface(d), plain = makeSurface({ ...d, relief: { ...d.relief, kind: 'smooth' } });
    expect(f(90, (8.5 / 16) * Math.PI * 2) - plain(90, (8.5 / 16) * Math.PI * 2)).toBeGreaterThan(1.5);
  });
  it('reads DXF lines, polylines and circles', () => {
    const dxf = ['0', 'SECTION', '2', 'ENTITIES', '0', 'LINE', '10', '0', '20', '0', '11', '10', '21', '5', '0', 'CIRCLE', '10', '5', '20', '5', '40', '2', '0', 'LWPOLYLINE', '70', '1', '10', '0', '20', '0', '10', '3', '20', '0', '10', '3', '20', '3', '0', 'ENDSEC', '0', 'EOF'].join('\n');
    const p = parseDxf(dxf);
    expect(p.length).toBe(3); expect(p[2].length).toBe(4);
  });
  it('top layers close the piece', () => {
    const d = { ...defaultDesign('vase'), height: 6, maxDiameter: 40 };
    const r = slice(d, { ...DEFAULT_SLICE, topLayers: 3, spiral: false }, [], () => undefined);
    expect(r.segs.some((g) => g.kind === 'top')).toBe(true);
  });
});
