// Clickex edge profiles: square, fillet, chamfer and steps on the button's and the base's top edge.
import { describe, expect, it } from 'vitest';
import { meshVolume, openEdgeCount } from '../../src/engine/mesh';
import { buildClicker, clampEdge, edgeInset } from '../../src/plugins/clickex/build';
import { sampleArt, SAMPLES } from '../../src/plugins/clickex/samples';
import { defaultSpec, normalizeSpec, type EdgeKind } from '../../src/plugins/clickex/model';
import { planSingle } from '../../src/plugins/clickex/plan';

const build = (cap: EdgeKind, base: EdgeKind) => {
  const spec = defaultSpec();
  spec.body.capEdge = { kind: cap, width: 1.2, height: 1.2, steps: 3 };
  spec.body.baseEdge = { kind: base, width: 1.5, height: 2, steps: 3 };
  return buildClicker(spec, planSingle(spec, sampleArt(SAMPLES[0].id)));
};
const vol = (b: ReturnType<typeof build>, k: 'base' | 'button') => meshVolume(b.parts.find((p) => p.key === k)!.mesh);

describe('Clickex edge profiles', () => {
  it('insets: fillet round, chamfer straight, steps in even ledges', () => {
    const f = clampEdge({ kind: 'fillet', width: 1, height: 1, steps: 2 }, 9, 9);
    expect(edgeInset(f, 0)).toBeCloseTo(1); expect(edgeInset(f, 0.999)).toBeLessThan(0.05); expect(edgeInset(f, 1.2)).toBe(0);
    const c = clampEdge({ kind: 'chamfer', width: 2, height: 1, steps: 2 }, 9, 9);
    expect(edgeInset(c, 0.5)).toBeCloseTo(1);
    const s = clampEdge({ kind: 'step', width: 3, height: 3, steps: 3 }, 9, 9);
    expect([0.5, 1.5, 2.5].map((d) => edgeInset(s, d))).toEqual([3, 2, 1]);
    expect(clampEdge({ kind: 'chamfer', width: 5, height: 5, steps: 1 }, 1, 2)).toMatchObject({ width: 1, height: 2 });
  });

  it('every profile builds closed parts, and cutting the edge removes material', () => {
    const sq = build('none', 'none');
    for (const cap of ['fillet', 'chamfer', 'step'] as EdgeKind[]) for (const base of ['none', 'fillet', 'chamfer', 'step'] as EdgeKind[]) {
      const b = build(cap, base);
      for (const p of b.parts) expect(openEdgeCount(p.mesh), `${cap}/${base} ${p.key}`).toBe(0);
      expect(vol(b, 'button'), cap).toBeLessThan(vol(sq, 'button'));
      if (base !== 'none') expect(vol(b, 'base'), base).toBeLessThan(vol(sq, 'base'));
    }
  });

  it('old designs keep their rounded button edge', () => {
    const s = normalizeSpec({ body: { capRound: 0.8 } } as never);
    expect(s.body.capEdge).toMatchObject({ kind: 'fillet', width: 0.8 });
    expect(normalizeSpec({ body: { capRound: 0 } } as never).body.capEdge.kind).toBe('none');
    expect(s.body.baseEdge.kind).toBe('none');
  });
});
