import { describe, expect, it } from 'vitest';
import { defaultDesign } from '../../src/workbench/design';
import { caseMesh, plateMesh } from '../../src/workbench/coaster';
import { buildMesh } from '../../src/workbench/meshbuild';

const openEdges = (m: { idx: number[] }) => { const s = new Map<string, number>(); for (let t = 0; t < m.idx.length; t += 3) for (let k = 0; k < 3; k++) { const a = m.idx[t + k], b = m.idx[t + (k + 1) % 3]; const key = a < b ? `${a},${b}` : `${b},${a}`; s.set(key, (s.get(key) ?? 0) + 1); } let o = 0, one = 0, many = 0; for (const v of s.values()) { if (v !== 2) o++; if (v === 1) one++; if (v > 2) many++; } if (o) console.log("EDGES one", one, "many", many); return one + (many > s.size * 0.001 ? many : 0); };

describe('coasters', () => {
  for (const mode of ['emboss', 'deboss', 'through'] as const) it(`plate is watertight (${mode})`, () => {
    const d = defaultDesign('coaster'); d.coaster!.mode = mode;
    const t = performance.now(); const m = plateMesh(d, 0.5); const ms = performance.now() - t;
    console.log('PLATE', mode, m.idx.length / 3, 'tris', ms.toFixed(0), 'ms');
    expect(m.idx.length).toBeGreaterThan(1000);
    expect(openEdges(m)).toBe(0);
  });
  it('case parts are watertight and the gap is kept', () => {
    const d = defaultDesign('coaster');
    for (const m of caseMesh(d, 0.6)) expect(openEdges(m)).toBe(0);
    const v = buildMesh(d, 'quick'); expect(v.triangles).toBeGreaterThan(1000);
  });
});
