import { beforeAll, describe, expect, it } from 'vitest';
import { initKernel, type V3 } from '../../src/plugins/flenex/csg';
import { tube } from '../../src/plugins/flenex/forms';
import { modelBvh } from '../../src/plugins/flenex/flexi';
import { mainAxisPath, smartPlane, traceCentreline } from '../../src/plugins/flenex/place';
import { pathLength } from '../../src/plugins/flenex/groups';

beforeAll(initKernel);

// a wavy snake lying along x: y = 22 sin(2π x / 110), radius 6, resting on z = 6
const wave = (x: number) => 22 * Math.sin((2 * Math.PI * x) / 110);
const path: V3[] = Array.from({ length: 160 }, (_, i) => { const x = i * 1.5; return [x, wave(x), 6] as V3; });
const snake = tube(path, path.map(() => 6), 24);
const bvh = modelBvh(snake);
const tangent = (x: number): V3 => { const dy = (22 * 2 * Math.PI / 110) * Math.cos((2 * Math.PI * x) / 110), l = Math.hypot(1, dy); return [1 / l, dy / l, 0]; };
const angle = (a: V3, b: V3) => (Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) * 180) / Math.PI;

describe('cuts square to a wavy body', () => {
  for (const x of [20, 45, 80, 110, 150]) {
    it(`centre line mode at x = ${x} follows the wave`, () => {
      // the cursor is on the skin: top of the tube, surface normal up
      const top: V3 = [x, wave(x), 12];
      const { origin, normal } = smartPlane(snake, bvh, top, [0, 0, 1], 'centreline');
      expect(angle(normal, tangent(x))).toBeLessThan(7);
      expect(Math.abs(origin[1] - wave(x))).toBeLessThan(1.5); // re-centred in the body
    });
  }
  it('keeps the same sense while dragging along the body', () => {
    let keep: V3 | undefined;
    for (let x = 10; x < 200; x += 12) {
      const r = smartPlane(snake, bvh, [x, wave(x), 12], [0, 0, 1], 'centreline', keep);
      if (keep) expect(r.normal[0] * keep[0] + r.normal[1] * keep[1]).toBeGreaterThan(0.6);
      keep = r.normal;
    }
  });
  it('a straight "across X" cut ignores the curve', () => {
    const r = smartPlane(snake, bvh, [80, wave(80), 12], [0, 0, 1], 'x');
    expect(r.normal).toEqual([1, 0, 0]);
  });
  it('traces the centre line between two clicks and finds the main axis path', () => {
    const t = traceCentreline(bvh, snake, [10, wave(10), 12], [200, wave(200), 12], [0, 0, 1]);
    expect(pathLength(t)).toBeGreaterThan(180);
    for (const p of t.slice(2, -2)) expect(Math.abs(p[1] - wave(p[0]))).toBeLessThan(3);
    const m = mainAxisPath(snake);
    expect(m.length).toBeGreaterThan(30);
  });
});

describe('whole body as one part', () => {
  it('walks a gecko (legs and all) from head to tail along its spine', async () => {
    const { buildCreature } = await import('../../src/plugins/flenex/creature');
    const { PRESETS, designFromPreset } = await import('../../src/plugins/flenex/presets');
    const { autoBodyPath } = await import('../../src/plugins/flenex/place');
    const d = designFromPreset(PRESETS.find((p) => p.id === 'gecko')!);
    const base = buildCreature(d);
    const path = autoBodyPath(modelBvh(base.mesh), base.mesh);
    expect(pathLength(path)).toBeGreaterThan(d.body.length * 0.8);
    // every point stays near the body's own centre line
    for (const p of path) {
      let best = Infinity;
      for (const s of base.stations) best = Math.min(best, Math.hypot(p[0] - s.P.x, p[1] - s.P.y));
      expect(best).toBeLessThan(d.body.thickness * 0.7);
    }
  });
});
