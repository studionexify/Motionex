import { describe, expect, it } from 'vitest';
import { FAMILIES, CATEGORIES } from '../../src/plugins/patternex/library/families';
import { buildPattern, GROUP_KEYS, libraryCounts, libraryEntries, patternSvg, searchLibrary, specOf } from '../../src/plugins/patternex/library/catalog';
import { ShapeIndex } from '../../src/plugins/patternex/projection';

describe('pattern library', () => {
  it('has thousands of entries across every category, with unique keys', () => {
    const all = libraryEntries();
    expect(all.length).toBeGreaterThan(2000);
    expect(new Set(all.map((e) => e.key)).size).toBe(all.length);
    const c = libraryCounts();
    for (const k of CATEGORIES) expect(c[k]).toBeGreaterThan(50);
  });

  it('every family and preset builds valid, in-bounds geometry quickly and deterministically', () => {
    for (const f of FAMILIES) for (const preset of Object.keys(f.presets)) {
      const e = libraryEntries().find((x) => x.family === f.id && x.preset === preset)!;
      const t0 = performance.now();
      const p = buildPattern(specOf(e));
      const ms = performance.now() - t0;
      expect(p.shapes.length, `${f.id}/${preset}`).toBeGreaterThan(0);
      const [x0, y0, x1, y1] = p.bounds;
      expect(x0 >= -1e-6 && y0 >= -1e-6 && x1 <= 40 + 1e-6 && y1 <= 40 + 1e-6, `${f.id}/${preset} ${p.bounds}`).toBe(true);
      for (const s of p.shapes) for (const r of s.polygon_rings) for (const [x, y] of r) expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true);
      expect(ms, `${f.id}/${preset} took ${ms.toFixed(0)} ms`).toBeLessThan(1500);
      expect(buildPattern(specOf(e))).toEqual(p);
      // something is actually filled
      const idx = new ShapeIndex(p.shapes);
      let hit = 0;
      for (let i = 0; i < 160 && !hit; i++) for (let j = 0; j < 160; j++) if (idx.contains(i * 0.25 + 0.13, j * 0.25 + 0.11)) { hit++; break; }
      expect(hit, `${f.id}/${preset} fills nothing`).toBeGreaterThan(0);
    }
  });

  it('seeds change the result; inks do not change the id; size follows the spec', () => {
    const e = libraryEntries().find((x) => x.family === 'voronoi')!;
    const a = buildPattern(specOf(e)), b = buildPattern({ ...specOf(e), seed: 99 });
    expect(a.id).not.toBe(b.id);
    expect(JSON.stringify(a.shapes)).not.toBe(JSON.stringify(b.shapes));
    expect(buildPattern({ ...specOf(e), inks: [-1, 1, 2] }).id).toBe(a.id);
    // library patterns are uninked: only neutral group keys
    expect(a.shapes.every((s) => GROUP_KEYS.includes(s.fill_color))).toBe(true);
    const big = buildPattern(specOf(e, 120, 30));
    expect(big.bounds[2]).toBeGreaterThan(100);
    expect(big.bounds[3]).toBeLessThanOrEqual(30 + 1e-6);
  });

  it('search filters by words, tags and category', () => {
    expect(searchLibrary('voronoi', 'All').every((e) => e.family === 'voronoi')).toBe(true);
    expect(searchLibrary('', 'Tiles').every((e) => e.category === 'Tiles')).toBe(true);
    expect(searchLibrary('maze fine', 'All').length).toBeGreaterThan(0);
    expect(searchLibrary('zzzz', 'All')).toEqual([]);
  });

  it('renders an SVG preview', () => {
    const p = buildPattern(specOf(libraryEntries()[0]));
    expect(patternSvg(p, 40, 40)).toMatch(/^<svg[^>]*viewBox="0 0 40 40".*<path/);
  });
});
