// Colour mixing: mixed (virtual) filaments resolve to a physical slot per layer.
import { describe, expect, it } from 'vitest';
import { slice, slotFromConfig } from '../src/engine/slicer';
import { weld } from '../src/engine/mesh';
import { resolveConfig } from '../src/profiles/resolve';
import { deltaE, gradientSlots, matchMixes, mixColor, mixProblems, mixSequence, mixesAfterSlotRemoved, resolveFilament, shiftIndex, spreadCycle, type MixedFilament } from '../src/profiles/mixing';
import { box } from './fixtures';
import { colorRegionsAtZ, paintedTris } from '../src/engine/paint';
import { areaTotal, SCALE } from '../src/engine/clipper';

const ratio = (a: number, b: number, ra: number, rb: number): MixedFilament => ({ id: 'm', kind: 'ratio', a, b, ra, rb });

describe('mix sequences', () => {
  it('spreads a ratio evenly', () => {
    expect(mixSequence(ratio(0, 1, 1, 1))).toEqual([0, 1]);
    expect(mixSequence(ratio(0, 1, 2, 1))).toEqual([0, 0, 1]);
    const s = mixSequence(ratio(0, 1, 3, 2));
    expect(s.filter((k) => k === 0).length).toBe(3);
    expect(s.filter((k) => k === 1).length).toBe(2);
    // never two B layers in a row when A is the majority
    expect(s.join('')).not.toMatch(/11/);
  });
  it('repeats a cycle and resolves per layer', () => {
    const c: MixedFilament = { id: 'c', kind: 'cycle', seq: [0, 1, 1, 2] };
    expect([0, 1, 2, 3, 4, 5].map((i) => resolveFilament(4, i, 4, [c]))).toEqual([0, 1, 1, 2, 0, 1]);
    expect(resolveFilament(2, 7, 4, [c])).toBe(2); // physical slots pass through
  });
  it('blends in linear light and flags bad mixes', () => {
    expect(mixColor(ratio(0, 1, 1, 1), ['#000000', '#FFFFFF'])).toBe('#BCBCBC');
    expect(mixColor(ratio(0, 1, 1, 1), ['#FF0000', '#FF0000'])).toBe('#FF0000');
    expect(mixProblems(ratio(0, 0, 1, 1), 4)).toHaveLength(1);
    expect(mixProblems(ratio(0, 5, 1, 1), 4).length).toBeGreaterThan(0);
    expect(mixProblems(ratio(0, 1, 1, 1), 4)).toEqual([]);
  });
  it('keeps references valid when slots change', () => {
    expect(mixesAfterSlotRemoved([ratio(1, 3, 1, 1)], 1)).toEqual([ratio(0, 2, 1, 1)]);
    expect(shiftIndex(4, null, 4, 1)).toBe(5);
    expect(shiftIndex(2, null, 4, 1)).toBe(2);
    expect(shiftIndex(4, 4, 5, -1)).toBe(0);
    expect(shiftIndex(5, 4, 5, -1)).toBe(4);
  });
});

describe('gradient', () => {
  const g: MixedFilament & { kind: 'gradient' } = { id: 'g', kind: 'gradient', a: 0, b: 1, start: 0, end: 100 };
  it('goes from all A to all B with the share following the height', () => {
    const n = 100;
    const s = gradientSlots(g, Array.from({ length: n }, (_, i) => i / (n - 1)));
    expect(s.slice(0, 5).every((k) => k === 0)).toBe(true);
    expect(s.slice(-5).every((k) => k === 1)).toBe(true);
    const share = (lo: number, hi: number) => s.slice(lo, hi).filter((k) => k === 1).length / (hi - lo);
    expect(share(40, 60)).toBeGreaterThan(0.4);
    expect(share(40, 60)).toBeLessThan(0.6);
    expect(share(0, 25)).toBeLessThan(share(25, 50));
    expect(share(50, 75)).toBeLessThan(share(75, 100));
  });
  it('holds A below the start and B above the end', () => {
    const s = gradientSlots({ ...g, start: 30, end: 60 }, Array.from({ length: 50 }, (_, i) => i / 49));
    expect(s.slice(0, 14).every((k) => k === 0)).toBe(true);
    expect(s.slice(30).every((k) => k === 1)).toBe(true);
  });
});

describe('match', () => {
  const colors = ['#FFFFFF', '#D32F2F', '#1E88E5', '#111111'];
  it('finds a physical-like or blended colour close to the target', () => {
    const pink = mixColor({ id: 'x', kind: 'ratio', a: 0, b: 1, ra: 1, rb: 1 }, colors);
    const m = matchMixes(pink, colors);
    expect(m[0].dE).toBeLessThan(1);
    expect(m.length).toBeGreaterThan(1);
    for (let i = 1; i < m.length; i++) expect(m[i].dE + 0.5).toBeGreaterThanOrEqual(m[i - 1].dE);
    expect(mixProblems(m[0].mix, colors.length)).toEqual([]);
  });
  it('spreads three-filament cycles evenly', () => {
    const c = spreadCycle([0, 1, 2], [3, 2, 1]);
    expect(c).toHaveLength(6);
    expect(c.filter((k) => k === 0)).toHaveLength(3);
    expect(c.join('')).not.toMatch(/000/);
    expect(deltaE('#000000', '#FFFFFF')).toBeGreaterThan(99);
    expect(deltaE('#FF0000', '#FF0000')).toBe(0);
  });
});

describe('slicing a mixed filament on the Snapmaker U1', () => {
  const c = resolveConfig({ printerId: 'snapmaker-u1', plate: 'textured_pei_plate', filamentId: 'generic-pla', presetId: '0.20', overrides: {} as never });
  const a = slotFromConfig(c);
  const filaments = [0, 1, 2, 3].map((k) => ({ ...a, name: `PLA ${k + 1}`, color: ['#ffffff', '#cc2222', '#2222cc', '#111111'][k] }));
  const run = (m: MixedFilament) => slice([{ id: 'b', name: 'b', filament: 4, ...weld(box(100, 100, 0, 20, 20, 6)) }], c, () => {}, { filaments, mixes: [m] });

  it('swaps heads layer by layer for a 1:1 ratio', () => {
    const out = run(ratio(0, 1, 1, 1));
    const g = out.gcode;
    expect(g).toMatch(/^T1\b/m);
    expect(out.stats.perFilament[0].grams).toBeGreaterThan(0);
    expect(out.stats.perFilament[1].grams).toBeGreaterThan(0);
    expect(out.stats.perFilament[2]?.grams ?? 0).toBe(0);
    expect(out.stats.toolChanges).toBeGreaterThanOrEqual(out.stats.layerCount - 2);
    expect(out.warnings.join(' ')).not.toMatch(/Colour mixing/);
  });

  it('uses each filament in proportion for a 2:1 ratio', () => {
    const out = run(ratio(0, 2, 2, 1));
    const ga = out.stats.perFilament[0].grams, gb = out.stats.perFilament[2].grams;
    expect(ga / gb).toBeGreaterThan(1.4);
    expect(ga / gb).toBeLessThan(2.8);
  });

  it('fades a gradient from A at the bottom to B at the top', () => {
    const out = slice([{ id: 'b', name: 'b', filament: 4, ...weld(box(100, 100, 0, 20, 20, 10)) }], c, () => {}, { filaments, mixes: [{ id: 'g', kind: 'gradient', a: 0, b: 3, start: 0, end: 100 }] });
    // tool in use when each layer's first extrusion starts
    let cur = 0;
    const tools: number[] = [];
    for (const chunk of out.gcode.split(/^;LAYER_CHANGE/m).slice(1)) {
      const t = [...chunk.matchAll(/^T(\d+)\b/gm)];
      if (t.length) cur = Number(t[t.length - 1][1]);
      tools.push(cur);
    }
    const n = tools.length;
    expect(n).toBeGreaterThan(30);
    expect(tools.slice(0, n / 2).filter((t) => t === 3).length).toBeLessThan(tools.slice(n / 2).filter((t) => t === 3).length);
    expect(tools.slice(0, 3).every((t: number) => t === 0)).toBe(true);
    expect(tools.slice(n - 3).every((t: number) => t === 3)).toBe(true);
    expect(out.stats.perFilament[0].grams).toBeGreaterThan(0);
    expect(out.stats.perFilament[3].grams).toBeGreaterThan(0);
  });

  it('warns on a single-nozzle printer', () => {
    const p = resolveConfig({ printerId: 'bbl-p1s', plate: 'textured_pei_plate', filamentId: 'generic-pla', presetId: '0.20', overrides: {} as never });
    const out = slice([{ id: 'b', name: 'b', filament: 2, ...weld(box(100, 100, 0, 20, 20, 3)) }], p, () => {}, { filaments: filaments.slice(0, 2), mixes: [ratio(0, 1, 1, 1)] });
    expect(out.warnings.join(' ')).toMatch(/Colour mixing changes filament on every layer/);
  });
});

describe('Subdivide Mix Layer', () => {
  const run = (o: Record<string, unknown>, filament = 4, paint = false) => {
    const c = resolveConfig({ printerId: 'snapmaker-u1', plate: 'textured_pei_plate', filamentId: 'generic-pla', presetId: '0.20', overrides: o as never });
    const a = slotFromConfig(c);
    const filaments = [0, 1, 2, 3].map((k) => ({ ...a, name: `PLA ${k + 1}`, color: ['#ffffff', '#cc2222', '#2222cc', '#111111'][k] }));
    const mesh = weld(box(100, 100, 0, 20, 20, 4));
    const m: any = { id: 'b', name: 'b', filament, ...mesh };
    if (paint) m.paint = { color: new Uint8Array(mesh.indices.length / 3).fill(5) };
    return slice([m], c, () => {}, { filaments, mixes: [{ id: 'm', kind: 'ratio', a: 0, b: 1, ra: 1, rb: 1 }] });
  };
  /** Per layer: extrusion Z values in print order, and the tools used. */
  const layers = (g: string) => g.split(/^;LAYER_CHANGE/m).slice(1).map((chunk) => {
    let z = NaN, x = NaN, y = NaN;
    const ez: number[] = [];
    const tools = new Set<number>();
    for (const l of chunk.split('\n')) {
      const t = /^T(\d+)\b/.exec(l); if (t) tools.add(+t[1]);
      if (!/^G[0-3]\b/.test(l)) continue;
      const zm = /\bZ([-\d.]+)/.exec(l); if (zm) z = +zm[1];
      const xm = /\bX([-\d.]+)/.exec(l); if (xm) x = +xm[1];
      const ym = /\bY([-\d.]+)/.exec(l); if (ym) y = +ym[1];
      // extrusions on the object only (the prime tower stands apart)
      if (/\bE[\d.]+/.test(l) && !/\bE-/.test(l) && (xm || ym) && x >= 99 && x <= 121 && y >= 99 && y <= 121) ez.push(z);
    }
    return { ez, tools };
  });

  it('prints the outer wall of a 1:1 mix as two 0.1 mm passes, the lower one first', () => {
    const off = run({});
    const on = run({ mix_subdivide: true });
    const L = layers(on.gcode).slice(3, -3);
    expect(L.length).toBeGreaterThan(8);
    for (const l of L) {
      const top = Math.max(...l.ez);
      expect(l.ez.some((z) => Math.abs(z - (top - 0.1)) < 1e-3)).toBe(true);
      // safety: never extrude lower again once the layer top has been printed
      const firstTop = l.ez.findIndex((z) => Math.abs(z - top) < 1e-3);
      expect(l.ez.slice(firstTop).every((z) => z > top - 1e-3)).toBe(true);
    }
    // both filaments on every layer, and about the same material overall (the passes are half height)
    expect(on.stats.toolChanges).toBeGreaterThan(off.stats.toolChanges * 1.5);
    expect(Math.abs(on.stats.filamentGrams - off.stats.filamentGrams) / off.stats.filamentGrams).toBeLessThan(0.03);
  });

  it('splits infill too with "Apply subdivision to infill"', () => {
    const walls = run({ mix_subdivide: true });
    const all = run({ mix_subdivide: true, mix_subdivide_infill: true });
    const low = (g: string) => layers(g).slice(3, -3).reduce((a, l) => { const top = Math.max(...l.ez); return a + l.ez.filter((z) => z < top - 1e-3).length; }, 0);
    expect(low(all.gcode)).toBeGreaterThan(low(walls.gcode) * 1.5);
    expect(Math.abs(all.stats.filamentGrams - walls.stats.filamentGrams) / walls.stats.filamentGrams).toBeLessThan(0.03);
  });

  it('subdivides painted mixes only with "Full domain"', () => {
    const low = (g: string) => layers(g).slice(3, -3).reduce((a, l) => { const top = Math.max(...l.ez); return a + l.ez.filter((z) => z < top - 1e-3).length; }, 0);
    expect(low(run({ mix_subdivide: true }, 0, true).gcode)).toBe(0);
    expect(low(run({ mix_subdivide: true, mix_subdivide_full_domain: true }, 0, true).gcode)).toBeGreaterThan(20);
  });
});

describe('segmented regions (painted colour reach)', () => {
  const c0 = resolveConfig({ printerId: 'snapmaker-u1', plate: 'textured_pei_plate', filamentId: 'generic-pla', presetId: '0.20', overrides: {} as never });
  const a = slotFromConfig(c0);
  const filaments = [0, 1].map((k) => ({ ...a, name: `PLA ${k + 1}`, color: ['#ffffff', '#cc2222'][k] }));
  // a 20 mm cube with its -X side painted filament 2
  const mesh = weld(box(100, 100, 0, 20, 20, 6));
  const color = new Uint8Array(mesh.indices.length / 3);
  for (let t = 0; t < color.length; t++) {
    const xs = [0, 1, 2].map((j) => mesh.vertices[mesh.indices[t * 3 + j] * 3]);
    if (xs.every((x) => Math.abs(x - 100) < 1e-6)) color[t] = 2;
  }
  const grams = (o: Record<string, unknown>) => {
    const c = resolveConfig({ printerId: 'snapmaker-u1', plate: 'textured_pei_plate', filamentId: 'generic-pla', presetId: '0.20', overrides: o as never });
    return slice([{ id: 'b', name: 'b', ...mesh, paint: { color } } as any], c, () => {}, { filaments }).stats.perFilament.map((p) => p.grams);
  };
  it('0 (default) fills in to the nearest surface; a width limits it; interlocking reaches further every other layer', () => {
    const full = grams({});
    const w2 = grams({ mmu_segmented_region_max_width: 2 });
    const w2d = grams({ mmu_segmented_region_max_width: 2, mmu_segmented_region_interlocking_depth: 2 });
    // nearest-surface: one side of four owns about a quarter of the cross-section
    const sq = [[100, 100], [120, 100], [120, 120], [100, 120]].map(([x, y]) => ({ X: x * SCALE, Y: y * SCALE }));
    const areaOf = (d: number) => areaTotal(colorRegionsAtZ(mesh as any, paintedTris(mesh as any, color), [sq], 3, d).get(2) ?? []);
    expect(areaOf(0)).toBeGreaterThan(90);
    expect(areaOf(0)).toBeLessThan(115);
    expect(areaOf(2)).toBeCloseTo(40, 0);
    expect(w2[1]).toBeLessThan(full[1] * 0.9); // walls and prime tower use filament 2 either way
    expect(w2d[1]).toBeGreaterThan(w2[1] * 1.1);
    // material conserved whatever the split
    // (prime tower and purge follow the number of changes, so the total moves a little)
    for (const g of [w2, w2d]) expect(Math.abs(g[0] + g[1] - (full[0] + full[1])) / (full[0] + full[1])).toBeLessThan(0.08);
  });
});

describe('Bambu Studio multimaterial defaults on the A1 and P1S', () => {
  const towerX = (printerId: string) => {
    const c = resolveConfig({ printerId, plate: 'textured_pei_plate', filamentId: 'generic-pla', presetId: '0.20', overrides: {} as never });
    const a = slotFromConfig(c);
    const out = slice([{ id: 'b', name: 'b', ...weld(box(110, 110, 0, 20, 20, 3)) } as any], c, () => {}, { filaments: [a, { ...a, color: '#cc2222' }], layerActions: [{ z: 1.5, type: 'color', filament: 1 }] });
    let inTower = false;
    const xs: number[] = [], ys: number[] = [];
    for (const l of out.gcode.split('\n')) {
      if (l.startsWith(';TYPE:')) inTower = l === ';TYPE:prime tower';
      if (!inTower || !/^G1 .*E[\d.]/.test(l)) continue;
      const x = /X([\d.]+)/.exec(l), y = /Y([\d.]+)/.exec(l);
      if (x) xs.push(+x[1]); if (y) ys.push(+y[1]);
    }
    return { c, x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
  };
  it('matches the profile values', () => {
    for (const id of ['bbl-a1', 'bbl-p1s']) {
      const c = resolveConfig({ printerId: id, plate: 'textured_pei_plate', filamentId: 'generic-pla', presetId: '0.20', overrides: {} as never });
      expect([c.enable_prime_tower, c.prime_tower_width, c.prime_tower_brim_width, c.prime_tower_max_speed, c.interface_shells, c.wall_filament, c.sparse_infill_filament, c.solid_infill_filament, c.retract_length_toolchange, c.mmu_segmented_region_max_width, c.flush_into_infill, c.flush_into_objects, c.flush_into_support])
        .toEqual([true, 35, 3, 90, false, 0, 0, 0, 2, 0, false, false, true]);
    }
  });
  it('puts the prime tower where Bambu Studio does: back left on the A1, back right of centre on the P1S', () => {
    const a1 = towerX('bbl-a1'), p1s = towerX('bbl-p1s');
    expect(a1.x0).toBeLessThan(15);
    expect(a1.y1).toBeGreaterThan(230);
    expect(p1s.x0).toBeGreaterThan(150);
    expect(p1s.x0).toBeLessThan(180);
    expect(p1s.y1).toBeGreaterThan(230);
    for (const t of [a1, p1s]) { expect(t.x1).toBeLessThanOrEqual(256); expect(t.y1).toBeLessThanOrEqual(256); expect(t.x0).toBeGreaterThanOrEqual(0); }
  });
});
