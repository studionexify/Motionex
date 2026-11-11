import { describe, expect, it } from 'vitest';
import { openEdgeCount } from '../src/engine/mesh';
import { primitive, SHAPES } from '../src/state/ops';

describe('primitive shapes', () => {
  for (const [kind, label] of SHAPES) {
    it(`${label} is closed and faces outward`, () => {
      const m = primitive(kind, 20);
      expect(m.indices.length).toBeGreaterThan(0);
      expect(openEdgeCount(m)).toBe(0);
      // signed volume > 0 means the triangles wind outward
      const v = m.vertices, ix = m.indices;
      let vol = 0;
      for (let t = 0; t < ix.length; t += 3) {
        const a = ix[t] * 3, b = ix[t + 1] * 3, c = ix[t + 2] * 3;
        vol += v[a] * (v[b + 1] * v[c + 2] - v[b + 2] * v[c + 1]) - v[a + 1] * (v[b] * v[c + 2] - v[b + 2] * v[c]) + v[a + 2] * (v[b] * v[c + 1] - v[b + 1] * v[c]);
      }
      expect(vol / 6).toBeGreaterThan(0);
    });
  }
});
