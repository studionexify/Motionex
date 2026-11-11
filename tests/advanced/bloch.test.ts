import { describe, it, expect } from 'vitest';
import { bandEdges, chern, valleyChern, resonantHoneycomb, type Lattice } from '../../src/engine/advanced/bloch';

const frame = (mA: number, mB: number): Lattice => ({ a1: [1, 0], a2: [0.5, 0.866], m: [mA, mB], springs: [{ i: 0, j: 1, n: [0, 0], k: 1 }, { i: 0, j: 1, n: [0, -1], k: 1 }, { i: 0, j: 1, n: [1, -1], k: 1 }] });

describe('Bloch bands and topology (#34)', () => {
  it('a passive honeycomb with sublattice contrast has Chern 0 and valley Chern ±½', () => {
    const L = frame(1.1, 0.9);
    const e = bandEdges(L, 30);
    expect(e.gaps.length).toBe(1);
    const c = chern(L, 1, 24).chern;
    expect(Math.abs(c)).toBeLessThan(1e-6);
    const v = valleyChern(L, 1, 48);
    console.log('valley', v);
    expect(Math.abs(Math.abs(v) - 0.5)).toBeLessThan(0.15);
  });
  it('local resonators open a gap at their resonance', () => {
    const kR = 6 * 1e4, mR = 1;
    const fr = Math.sqrt(kR / mR) / (2 * Math.PI);
    const L = resonantHoneycomb({ a: 5, frameK: 1e7, mA: 0.1, mB: 0.1, mR, kR });
    const e = bandEdges(L, 20);
    console.log(fr, e.gaps);
    expect(e.gaps.some((g) => g.lo < fr * 1.05 && g.hi > fr)).toBe(true);
  });
});
