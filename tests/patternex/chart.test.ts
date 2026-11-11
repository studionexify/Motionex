// Patternex charts: grid editing helpers, chart → pattern conversion, and a chart wrapped round a real cylinder.
import { describe, expect, it } from 'vitest';
import { BASE, CHART_PRESETS, chartActions, chartPreset, chartSize, chartToPattern, estimateChanges, fillCells, mirrorChart, normalizeChart, paintCells, resizeChart, slotKey, slotOfKey, usedSlots, type ChartSpec } from '../../src/plugins/patternex/chart';
import { newPlacement } from '../../src/plugins/patternex';
import { placementGroups } from '../../src/plugins/patternex/resolve';
import { frameOf, toPattern, type WorldPlacement } from '../../src/plugins/patternex/projection';
import { ShapeIndex } from '../../src/plugins/patternex/projection';
import { areaTotal } from '../../src/engine/clipper';
import { sliceMesh } from '../../src/engine/slice';
import { weld } from '../../src/engine/mesh';
import { slice, slotFromConfig } from '../../src/engine/slicer';
import { resolveConfig } from '../../src/profiles/resolve';
import { cylinder } from '../fixtures';
import type { MeshInput } from '../../src/engine/types';
import type { PatternexConfig, PatternexReport } from '../../src/plugins/patternex/engine';

const spec = (o: Partial<ChartSpec> = {}): ChartSpec => normalizeChart({ name: 't', cols: 4, rows: 2, repX: 1, repY: 1, cells: [], cellH: 1, cellW: 2, startZ: 0, projection: 'wrap', ...o });

describe('chart editing', () => {
  it('paint, fill, mirror and resize keep the grid consistent', () => {
    let s = spec();
    expect(s.cells).toEqual(Array(8).fill(BASE));
    s = paintCells(s, [[0, 0], [1, 0], [9, 9]], 1);
    expect(s.cells.slice(0, 4)).toEqual([1, 1, BASE, BASE]);
    expect(paintCells(s, [[0, 0]], 1)).toBe(s); // no-op keeps identity (no undo step)
    const f = fillCells(s, 3, 1, 2);
    expect(f.cells.filter((v) => v === 2).length).toBe(6);
    expect(mirrorChart(s, 'x').cells.slice(0, 4)).toEqual([BASE, BASE, 1, 1]);
    expect(mirrorChart(s, 'y').cells.slice(4, 8)).toEqual([1, 1, BASE, BASE]);
    const r = resizeChart(s, 2, 3);
    expect(r.cells).toEqual([1, 1, BASE, BASE, BASE, BASE]);
  });

  it('flood fill wraps across the seam for wrapped charts only', () => {
    const s = paintCells(spec({ rows: 1 }), [[1, 0], [2, 0]], 1); // [_, 1, 1, _]
    expect(fillCells(s, 0, 0, 2).cells).toEqual([2, 1, 1, 2]);
    expect(fillCells({ ...s, projection: 'front' }, 0, 0, 2).cells).toEqual([2, 1, 1, BASE]);
  });

  it('normalize clamps sizes and junk cells', () => {
    const n = normalizeChart({ ...spec(), cols: 0, rows: 500, repX: -3, cells: [7, 99, NaN] as number[] });
    expect(n.cols).toBe(1);
    expect(n.rows).toBe(160);
    expect(n.repX).toBe(1);
    expect(n.cells[0]).toBe(7);
    expect(n.cells[1]).toBe(BASE);
  });

  it('slot keys round-trip and never collide', () => {
    const keys = Array.from({ length: 16 }, (_, k) => slotKey(k));
    expect(new Set(keys).size).toBe(16);
    keys.forEach((k, i) => { expect(k).toMatch(/^#[0-9a-f]{6}$/); expect(slotOfKey(k)).toBe(i); });
    expect(slotOfKey('#000000')).toBeNull();
  });

  it('every preset is valid', () => {
    for (const p of CHART_PRESETS) {
      const s = chartPreset(p.id);
      expect(s.cells.length).toBe(s.cols * s.rows);
    }
    expect(usedSlots(chartPreset('nordic'))).toEqual([1, 2]);
  });
});

describe('chart → pattern', () => {
  it('covers exactly the painted cells, merged into rectangles', () => {
    const s = paintCells(spec({ repX: 3 }), [[0, 0], [1, 0], [0, 1], [1, 1], [3, 1]], 1);
    const circ = 24; // 12 columns → 2 mm cells
    const p = chartToPattern(s, circ, 'c');
    expect(chartSize(s, circ).cellW).toBeCloseTo(2, 9);
    expect(p.bounds).toEqual([-12, 0, 12, 2]);
    expect(p.origin).toEqual([0, 0]);
    expect(p.meta?.kind).toBe('chart');
    const idx = new ShapeIndex(p.shapes);
    let filled = 0;
    for (let C = 0; C < 12; C++) for (let R = 0; R < 2; R++) {
      const on = idx.contains(-12 + (C + 0.5) * 2, (R + 0.5) * 1);
      const c = C % 4;
      expect(on).toBe(c < 2 || (c === 3 && R === 1));
      if (on) filled++;
    }
    expect(filled).toBe(15);
    // the 2×2 block merges into one rectangle per repeat, the single cell stays alone (seam run merges with col 0)
    expect(p.shapes.length).toBeLessThanOrEqual(9);
  });

  it('actions name one group per used slot', () => {
    const s = paintCells(paintCells(spec(), [[0, 0]], 1), [[1, 0]], 3);
    const a = chartActions('pl', s, true);
    expect(a.map((x) => [x.region_ref.color_group, x.material.slot_index, x.material.mode])).toEqual([[slotKey(1), 1, 'slot'], [slotKey(3), 3, 'slot']]);
    expect(chartActions('pl', s, false)[0].material.mode).toBe('manual');
  });

  it('change estimate grows with colours per layer', () => {
    const one = paintCells(spec({ rows: 1 }), [[0, 0]], 1);
    const two = paintCells(one, [[1, 0]], 2);
    expect(estimateChanges(spec(), 0.2, 0)).toBe(0);
    expect(estimateChanges(one, 0.2, 0)).toBe(5); // 1 mm row = 5 layers, one change each
    expect(estimateChanges(two, 0.2, 0)).toBeGreaterThan(estimateChanges(one, 0.2, 0));
  });
});

describe('a chart wrapped round a cylinder', () => {
  const R = 12, circ = 2 * Math.PI * R;
  const cyl: MeshInput = { id: 'm', name: 'm', ...weld(cylinder(100, 100, R, 10, 96)) };
  const s = normalizeChart({ ...chartPreset('checker'), repX: 6, repY: 2, cellH: 2, startZ: 2 }); // 12 columns, 4 rows of 2 mm from z 2 to 10
  const pat = chartToPattern(s, circ, 'chk');
  const place: WorldPlacement = {
    ...newPlacement('p1', pat, 'm:0', [100, 100 - R, 2], [0, -1, 0]), object: 0,
    projection: 'cylindrical', projection_axis: [0, 0, 1], axis_origin: [100, 100, 0],
  };

  it('the frame maps the chart bottom to startZ and the full width to one turn', () => {
    const f = frameOf(place, pat);
    expect(toPattern(f, 100, 100 - R, 2)).toEqual([expect.closeTo(0, 6), expect.closeTo(0, 6)]);
    const back = toPattern(f, 100 - R * 1e-3, 100 + R, 6);
    expect(Math.abs(back[0])).toBeCloseTo(circ / 2, 1);
  });

  it('half of the wall carries the colour in every checker row', () => {
    const layerZ: number[] = [], layerH: number[] = [];
    for (let i = 1; i <= 50; i++) { layerZ.push(+(0.2 * i).toFixed(4)); layerH.push(0.2); }
    const planes = layerZ.map((z) => z - 0.1);
    const sl = sliceMesh(cyl as never, planes);
    const ctx = { layerZ, layerH, planes, sliceAt: (_o: number, i: number) => sl[i] };
    const groups = placementGroups(place, pat, 0.5, ctx as unknown as Parameters<typeof placementGroups>[3]);
    expect(groups.length).toBe(1);
    const a = areaTotal(groups[0].at(15)); // z ≈ 3.1, inside the first row
    expect(a).toBeGreaterThan(circ * 0.5 * 0.5 * 0.8);
    expect(a).toBeLessThan(circ * 0.5 * 0.5 * 1.2);
    expect(groups[0].at(2).length).toBe(0); // below startZ
  });

  it('slices with AMS tool changes into slot 2', () => {
    const c = resolveConfig({ printerId: 'bbl-x1c', plate: 'textured_pei_plate', filamentId: 'generic-pla', presetId: '0.20', overrides: { enable_arc_fitting: false } });
    const a = slotFromConfig(c);
    const px: PatternexConfig = { patterns: [pat], placements: [place], actions: chartActions('p1', s, true), singleColour: 'skip', transitionVolume: [] };
    const out = slice([cyl], c, () => {}, { filaments: [a, { ...a, name: 'Red', color: '#ff0000' }], plugins: { patternex: px } });
    const rep = out.pluginReports!.patternex as PatternexReport;
    expect(rep.toolChanges).toBeGreaterThan(10);
    expect(out.gcode).toContain('M620 S1A');
  });
});
