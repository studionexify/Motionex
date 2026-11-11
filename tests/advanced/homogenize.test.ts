import { describe, it, expect } from 'vitest';
import { homogenize, homogenize2D, gyroidCell, reentrantCell, engineering, solidFraction } from '../../src/engine/advanced/homogenize';
import { isoC } from '../../src/engine/advanced/fea';

describe('periodic homogenization (#35)', () => {
  it('recovers the solid stiffness for a full cell', () => {
    const c = { nx: 4, ny: 4, nz: 4, solid: new Uint8Array(64).fill(1) };
    const C = homogenize(c, 3500, 0.35);
    const ref = isoC(3500, 0.35);
    for (let i = 0; i < 36; i++) expect(Math.abs(C[i] - ref[i])).toBeLessThan(1e-3 * 3500);
  });
  it('gyroid stiffness grows with density and is cubic', () => {
    const t0 = performance.now();
    const lo = engineering(homogenize(gyroidCell(10, 0.2), 3500, 0.35));
    const hi = engineering(homogenize(gyroidCell(10, 0.4), 3500, 0.35));
    console.log('gyroid', lo.Ex, hi.Ex, Math.round(performance.now() - t0));
    expect(hi.Ex).toBeGreaterThan(lo.Ex * 1.8);
    expect(lo.Ex).toBeLessThan(3500 * 0.2);
    expect(Math.abs(lo.Ex - lo.Ey) / lo.Ex).toBeLessThan(0.05);
  });
  it('re-entrant honeycomb is auxetic', () => {
    const c = reentrantCell(32, 60, 0.06);
    const p = homogenize2D(c, 3500, 0.35);
    console.log('reentrant', solidFraction(c), p.nuxy, p.nuyx, p.Ex, p.Ey);
    expect(p.nuyx).toBeLessThan(0);
  });
});
