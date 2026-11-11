// Accuracy of the eikonal solver and the iso-contour extraction against closed-form solutions.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { fastMarch, rasterize, sample, nodeX, nodeY } from '../../src/plugins/hanex/core/fmm';
import { isoContours } from '../../src/plugins/hanex/core/contour';
import { circleRing, rectRing } from '../../src/plugins/hanex/core/shapes';
import { distToSegment, type Vec2 } from '../../src/plugins/hanex/core/geom';

const maxErr = (g: ReturnType<typeof rasterize>, D: Float64Array, exact: (x: number, y: number) => number, skip = (_x: number, _y: number) => false) => {
  let m = 0, rms = 0, n = 0;
  for (let j = 0; j < g.ny; j++) for (let i = 0; i < g.nx; i++) {
    const id = j * g.nx + i, x = nodeX(g, i), y = nodeY(g, j);
    if (!g.inside[id] || skip(x, y)) continue;
    const e = Math.abs(D[id] - exact(x, y));
    m = Math.max(m, e); rms += e * e; n++;
  }
  return { max: m, rms: Math.sqrt(rms / n) };
};

test('straight seed: D is the exact distance to the line (second-order stencil is exact for planar fronts)', () => {
  const g = rasterize([rectRing(0, 0, 30, 20)], 0.1);
  const D = fastMarch(g, [{ kind: 'polyline', pts: [[0, -1], [0, 21]] }]);
  const { max } = maxErr(g, D, (x) => Math.abs(x));
  assert.ok(max < 1e-9, `max error ${max}`);
});

test('point seed: circular fronts within 0.1 h, ~10x better than first order, error converges with h', () => {
  const p: Vec2 = [0.013, 0.007]; // off-node source
  const exact = (x: number, y: number) => Math.hypot(x - p[0], y - p[1]);
  const run = (h: number, firstOrder = false) => { const g = rasterize([rectRing(-20, -20, 20, 20)], h); return maxErr(g, fastMarch(g, [{ kind: 'point', p }], { firstOrder }), exact); };
  const e2 = run(0.1), e1 = run(0.1, true), fine = run(0.05);
  assert.ok(e2.max < 0.1 * 0.1, `2nd-order max ${e2.max}`); // < 10 µm at 20 mm from the source
  assert.ok(e2.max < e1.max / 5, `2nd ${e2.max} vs 1st ${e1.max}`);
  assert.ok(fine.max < 0.6 * e2.max, `convergence ${fine.max} vs ${e2.max}`);
});

test('speed function: F = 2 halves the travel time', () => {
  const g = rasterize([rectRing(0, 0, 10, 10)], 0.1);
  const speed = new Float32Array(g.nx * g.ny).fill(2);
  const D = fastMarch(g, [{ kind: 'polyline', pts: [[0, -1], [0, 11]] }], { speed });
  assert.ok(Math.abs(sample(g, D, 8, 5) - 4) < 1e-6);
});

test('diffraction: distance behind a circular obstacle is the taut-string geodesic (tangent + arc + tangent)', () => {
  const h = 0.05, c: Vec2 = [0, 0], R = 5, s: Vec2 = [-15, 0];
  const g = rasterize([rectRing(-20, -12, 20, 12), circleRing(c, R, 256)], h);
  const D = fastMarch(g, [{ kind: 'point', p: s }]);
  const geodesic = (x: number, y: number) => {
    if (distToSegment(c, s, [x, y]) >= R) return Math.hypot(x - s[0], y - s[1]);
    const ds = Math.hypot(s[0] - c[0], s[1] - c[1]), dt = Math.hypot(x - c[0], y - c[1]);
    const ang = Math.acos(((s[0] - c[0]) * (x - c[0]) + (s[1] - c[1]) * (y - c[1])) / (ds * dt));
    return Math.sqrt(ds * ds - R * R) + Math.sqrt(dt * dt - R * R) + R * (ang - Math.acos(R / ds) - Math.acos(R / dt));
  };
  // shadow points straight behind the obstacle, where Euclidean distance would be badly wrong
  for (const [x, y] of [[6, 0], [10, 0], [8, 2], [15, -1]] as Vec2[]) {
    const d = sample(g, D, x, y), ex = geodesic(x, y);
    assert.ok(Math.abs(d - ex) < 4 * h, `(${x},${y}) fmm ${d} vs geodesic ${ex}`);
    assert.ok(ex - Math.hypot(x - s[0], y - s[1]) > 0.3, 'test point really is in the shadow');
  }
});

test('marching squares: level sets of a point field are circles of the right radius', () => {
  const g = rasterize([rectRing(-10, -10, 10, 10)], 0.1);
  const D = fastMarch(g, [{ kind: 'point', p: [0, 0] }]);
  const cs = isoContours(g, D, 0.5);
  const ring = cs.filter((c) => c.k === 10); // r = 5
  assert.equal(ring.length, 1);
  assert.ok(ring[0].closed);
  for (const [x, y] of ring[0].pts) assert.ok(Math.abs(Math.hypot(x, y) - 5) < 0.1 * 0.1, `r=${Math.hypot(x, y)}`);
});
