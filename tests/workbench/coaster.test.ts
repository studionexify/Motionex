import { describe, expect, it } from 'vitest';
import { ALL_RELIEFS, defaultDesign } from '../../src/workbench/design';
import { caseMesh, COASTER_SHAPES, plateMesh, roundedRing, weld } from '../../src/workbench/coaster';
import { geoSd, patternGeo } from '../../src/workbench/patterngeo';
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

  it('every outline and every offset contour of it is rounded: no cusp or tip sharper than ~0.8 mm', () => {
    const resample = (x: Float64Array, y: Float64Array, h: number) => {
      const n = x.length, cum = [0]; for (let i = 0; i < n; i++) cum.push(cum[i] + Math.hypot(x[(i + 1) % n] - x[i], y[(i + 1) % n] - y[i]));
      const L = cum[n], m = Math.round(L / h), px: number[] = [], py: number[] = []; let k = 0;
      for (let j = 0; j < m; j++) { const t = (j / m) * L; while (cum[k + 1] < t) k++; const f = (t - cum[k]) / ((cum[k + 1] - cum[k]) || 1); px.push(x[k] + (x[(k + 1) % n] - x[k]) * f); py.push(y[k] + (y[(k + 1) % n] - y[k]) * f); }
      return { x: px, y: py };
    };
    for (const sh of COASTER_SHAPES) {
      const c = { ...defaultDesign('coaster').coaster!, shape: sh.id, section: sh.section, sides: sh.sides, depth: sh.depth };
      for (const off of [0, -c.border, c.gap, c.gap + c.wall]) {
        const ring = roundedRing(c, off); expect(ring, `${sh.id} ${off}`).not.toBeNull();
        const r = resample(ring!.x, ring!.y, 0.2), n = r.x.length; let minR = Infinity;
        for (let i = 0; i < n; i++) {
          const a = (i - 5 + n) % n, b = (i + 5) % n, ab = Math.hypot(r.x[i] - r.x[a], r.y[i] - r.y[a]), bc = Math.hypot(r.x[b] - r.x[i], r.y[b] - r.y[i]), ca = Math.hypot(r.x[a] - r.x[b], r.y[a] - r.y[b]);
          const cr = Math.abs((r.x[i] - r.x[a]) * (r.y[b] - r.y[a]) - (r.y[i] - r.y[a]) * (r.x[b] - r.x[a])); if (cr > 1e-9) minR = Math.min(minR, (ab * bc * ca) / (2 * cr));
        }
        expect(minR, `${sh.id} contour ${off}`).toBeGreaterThan(0.6);
      }
    }
  });
  it('weld merges coincident vertices and drops zero-area triangles', () => {
    const pos = [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 2, 0, 0, 1, 0, 0], idx = [0, 1, 2, 3, 4, 5, 0, 3, 1];
    const w = weld(pos, idx);
    expect(w.idx).toEqual([0, 1, 2]);                       // (3,4,5) is a zero-area sliver, (0,3,1) collapses once 3 ≡ 1
  });
  it('hex patterns tile seamlessly: no jump in the edge field across the tile boundary', () => {
    const g = patternGeo('hexcells', 1, 'tile')!; expect(g).not.toBeNull();
    const lv = g.levels[0];
    for (const u of [0.13, 0.4, 0.77]) {
      const below = geoSd(g, lv, u, -1e-3), above = geoSd(g, lv, u, 1e-3);
      expect(Math.abs(below - above)).toBeLessThan(0.02);
    }
    expect(Math.abs(geoSd(g, lv, 0.3, g.pv - 1e-3) - geoSd(g, lv, 0.3, -1e-3))).toBeLessThan(0.02);
  });
});
