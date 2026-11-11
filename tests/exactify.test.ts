import { describe, expect, it } from 'vitest';
import { exactify } from '../src/engine/exactify';
import { openEdgeCount, weld } from '../src/engine/mesh';
import { circleSegments, primitive } from '../src/state/ops';

/** Coarse surface of revolution around Z, like a low-resolution STL export. */
function coarse(profile: [number, number][], seg: number) {
  const out: number[] = [];
  const P = (k: number, j: number) => { const a = (j / seg) * Math.PI * 2, [r, z] = profile[k]; return [r * Math.cos(a), r * Math.sin(a), z]; };
  for (let k = 0; k < profile.length - 1; k++) for (let j = 0; j < seg; j++) {
    const a = P(k, j), b = P(k, j + 1), c = P(k + 1, j + 1), d = P(k + 1, j);
    out.push(...a, ...b, ...c, ...a, ...c, ...d);
  }
  return weld(new Float32Array(out));
}

/** Largest gap between a triangle's centroid and the exact surface: the visible faceting. */
function facetError(m: ReturnType<typeof weld>, dist: (x: number, y: number, z: number) => number) {
  let worst = 0;
  const v = m.vertices, ix = m.indices;
  for (let t = 0; t < ix.length; t += 3) {
    const a = ix[t] * 3, b = ix[t + 1] * 3, c = ix[t + 2] * 3;
    worst = Math.max(worst, Math.abs(dist((v[a] + v[b] + v[c]) / 3, (v[a + 1] + v[b + 1] + v[c + 1]) / 3, (v[a + 2] + v[b + 2] + v[c + 2]) / 3)));
  }
  return worst;
}

describe('exactify (hybrid smooth surface)', () => {
  it('rebuilds a 16-sided cylinder on the true round surface', () => {
    const m = coarse([[0, -10], [10, -10], [10, 10], [0, 10]], 16);
    const side = (x: number, y: number, z: number) => (Math.abs(z) < 9.99 ? Math.hypot(x, y) - 10 : 0);
    expect(facetError(m, side)).toBeGreaterThan(0.1);
    const r = exactify(m, { creaseDeg: 30 });
    expect(r.cylinders).toBe(1);
    expect(r.planes).toBe(2);
    expect(openEdgeCount(r.mesh)).toBe(0);
    expect(facetError(r.mesh, side)).toBeLessThan(0.02);
    // every vertex sits on the exact cylinder or the exact caps
    const v = r.mesh.vertices;
    for (let i = 0; i < v.length; i += 3) {
      const onSide = Math.abs(Math.hypot(v[i], v[i + 1]) - 10) < 1e-3, onCap = Math.abs(Math.abs(v[i + 2]) - 10) < 1e-3;
      expect(onSide || onCap).toBe(true);
    }
  });

  it('rebuilds a coarse sphere on the true sphere', () => {
    const arc = Array.from({ length: 9 }, (_, i) => { const a = -Math.PI / 2 + (Math.PI * i) / 8; return [10 * Math.cos(a), 10 * Math.sin(a)] as [number, number]; });
    const m = coarse(arc, 16);
    const sph = (x: number, y: number, z: number) => Math.hypot(x, y, z) - 10;
    expect(facetError(m, sph)).toBeGreaterThan(0.2);
    const r = exactify(m, { creaseDeg: 30 });
    expect(r.spheres).toBe(1);
    expect(facetError(r.mesh, sph)).toBeLessThan(0.03);
  });

  it('keeps a box a box', () => {
    const r = exactify(primitive('box', 20), { creaseDeg: 30 });
    expect(r.planes).toBe(6);
    const v = r.mesh.vertices;
    for (let i = 0; i < v.length; i++) expect(Math.abs(v[i])).toBeLessThanOrEqual(10 + 1e-4);
  });
});

describe('primitive tessellation', () => {
  it('keeps the chord error of round primitives within a micron', () => {
    const n = circleSegments(10);
    expect(10 * (1 - Math.cos(Math.PI / n))).toBeLessThanOrEqual(0.001 + 1e-9);
  });
});
