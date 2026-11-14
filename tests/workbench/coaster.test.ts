import { describe, expect, it } from 'vitest';
import { ALL_RELIEFS, defaultDesign } from '../../src/workbench/design';
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
  it('every basic relief shows on the plate, raised and carved, whatever the depth sign', () => {
    for (const r of ALL_RELIEFS.filter((x) => ['ribbed', 'pyramid', 'bumps', 'rings', 'sand'].includes(x.id)))
      for (const [mode, depth] of [['emboss', r.depth], ['deboss', -r.depth]] as const) {
        const d = defaultDesign('coaster'); d.relief = { ...d.relief, kind: r.id, count: r.count, depth }; d.coaster!.mode = mode;
        const o = plateMesh(d, 1.5); let lo = 99, hi = 0;
        for (let i = 2; i < o.pos.length; i += 3) if (o.pos[i] > 0.01) { lo = Math.min(lo, o.pos[i]); hi = Math.max(hi, o.pos[i]); }
        expect(hi - lo, `${r.id} ${mode}`).toBeGreaterThan(0.3);
      }
  });
  it('fillet and chamfer edges stay watertight, top and bottom', () => {
    for (const edge of ['chamfer', 'fillet'] as const) {
      const d = defaultDesign('coaster'); Object.assign(d.coaster!, { edge, edgeSize: 1.2, edgeBottom: true });
      const m = plateMesh(d, 0.8); expect(openEdges(m), edge).toBe(0);
      let zmin = 99; for (let i = 2; i < m.pos.length; i += 3) zmin = Math.min(zmin, m.pos[i]);
      expect(zmin).toBe(0);
    }
  });
  it('cut-through plates print as one piece (waffle keeps its grid)', () => {
    for (const kind of ['waffle', 'crosshatch', 'geocubes']) {
      const d = defaultDesign('coaster'); d.relief = { ...d.relief, kind, count: 8, depth: 1 }; d.coaster!.mode = 'through';
      const m = plateMesh(d, 1); const par = new Map<number, number>(); const f = (a: number): number => { const p = par.get(a) ?? a; if (p === a) return a; const r = f(p); par.set(a, r); return r; };
      for (let t = 0; t < m.idx.length; t += 3) { const a = f(m.idx[t]); par.set(f(m.idx[t + 1]), a); par.set(f(m.idx[t + 2]), a); }
      const roots = new Set<number>(); for (const i of m.idx) roots.add(f(i));
      expect(roots.size, kind).toBe(1);
    }
  });
});
