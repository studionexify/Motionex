import { describe, it, expect } from 'vitest';
import { voxelModel, solveElastic, elementStress, eigSym3, nodePos, NodalField, hexMatrices, isoC } from '../../src/engine/advanced/fea';

describe('voxel FEA', () => {
  it('element stiffness is symmetric with rigid-body null space', () => {
    const { K } = hexMatrices(isoC(1, 0.3), 1);
    for (let i = 0; i < 24; i++) for (let j = 0; j < 24; j++) expect(Math.abs(K[i * 24 + j] - K[j * 24 + i])).toBeLessThan(1e-12);
    // translation in x has no force
    const u = new Float64Array(24); for (let a = 0; a < 8; a++) u[a * 3] = 1;
    for (let i = 0; i < 24; i++) { let s = 0; for (let j = 0; j < 24; j++) s += K[i * 24 + j] * u[j]; expect(Math.abs(s)).toBeLessThan(1e-12); }
  });

  it('cantilever tip deflection matches beam theory and bending stress is axial', () => {
    const L = 40, b = 6, t = 6, F = 10, E = 3500;
    const m = voxelModel([0, 0, 0], [L, b, t], 1, () => true);
    const fixed = new Uint8Array(m.nodes);
    const f = new Float64Array(m.nodes * 3);
    let tip = 0;
    for (let n = 0; n < m.nodes; n++) { const p = nodePos(m, n); if (p[0] < 1e-6) fixed[n] = 7; if (p[0] > L - 1e-6) tip++; }
    for (let n = 0; n < m.nodes; n++) { const p = nodePos(m, n); if (p[0] > L - 1e-6) f[n * 3 + 2] = -F / tip; }
    const t0 = performance.now();
    const sol = solveElastic(m, { E, nu: 0.35, fixed, f, tol: 1e-7, maxIter: 5000 });
    const ms = performance.now() - t0;
    let w = 0, c = 0;
    for (let n = 0; n < m.nodes; n++) { const p = nodePos(m, n); if (p[0] > L - 1e-6) { w += sol.u[n * 3 + 2]; c++; } }
    w /= c;
    const I = (b * t ** 3) / 12;
    const exact = (F * L ** 3) / (3 * E * I);
    console.log('cantilever', { elements: m.cells.length, it: sol.iterations, ms: Math.round(ms), w, exact });
    expect(-w / exact).toBeGreaterThan(0.75);
    expect(-w / exact).toBeLessThan(1.1);
    const s = elementStress(m, sol.u, E, 0.35);
    const field = new NodalField(m, s, 6);
    const o = [0, 0, 0, 0, 0, 0];
    field.at(10, 3, 5.5, o);
    const { values, vectors } = eigSym3(o);
    // near the top fibre at x = 10: tension along x, σ ≈ M c / I
    expect(values[0]).toBeGreaterThan(0);
    expect(Math.abs(vectors[0])).toBeGreaterThan(0.95);
    const sigma = (F * (L - 10) * 2.5) / I;
    expect(values[0] / sigma).toBeGreaterThan(0.6);
    expect(values[0] / sigma).toBeLessThan(1.4);
  });

  it('eigSym3 recovers a rotated tensor', () => {
    const { values, vectors } = eigSym3([3, 1, -2, 0.5, 0.2, 0.7]);
    // reconstruct
    const A = [[3, 0.7, 0.2], [0.7, 1, 0.5], [0.2, 0.5, -2]];
    for (let c = 0; c < 3; c++) {
      const v = [vectors[c], vectors[3 + c], vectors[6 + c]];
      for (let r = 0; r < 3; r++) expect(A[r][0] * v[0] + A[r][1] * v[1] + A[r][2] * v[2]).toBeCloseTo(values[c] * v[r], 9);
    }
    expect(values[0]).toBeGreaterThanOrEqual(values[1]);
    expect(values[1]).toBeGreaterThanOrEqual(values[2]);
  });
});
