// Patternex in Nexspiro's real slicer: projection, region masks, tool changes, swaps, no-purge and Motionex hand-off.
import { describe, expect, it } from 'vitest';
import { slice, slotFromConfig } from '../../src/engine/slicer';
import { weld } from '../../src/engine/mesh';
import { resolveConfig } from '../../src/profiles/resolve';
import { areaTotal, SCALE } from '../../src/engine/clipper';
import { sliceMesh } from '../../src/engine/slice';
import { bambuFlushes, box, cylinder } from '../fixtures';
import { builtinPattern, newPlacement, parseSvg, type Pattern, type RegionAction } from '../../src/plugins/patternex';
import { frameOf, fromPattern, toPattern, type WorldPlacement } from '../../src/plugins/patternex/projection';
import { placementGroups } from '../../src/plugins/patternex/resolve';
import type { PatternexConfig, PatternexReport } from '../../src/plugins/patternex/engine';
import type { MeshInput } from '../../src/engine/types';
import { PRESETS } from '../../src/plugins/motionex/presets';
import { defaultToolhead } from '../../src/plugins/motionex/core/toolhead';
import { DEFAULT_OPTIONS } from '../../src/plugins/motionex/modifier';
import type { MotionexConfig, MotionexReport } from '../../src/plugins/motionex/engine';

// NexSpiro's own Bambu filament change macro (the X1C); the A1 / P1S now run Bambu Studio's template (vendor-gcode.test.ts)
const cfg = (printerId = 'bbl-x1c', o = {}) => resolveConfig({ printerId, plate: 'textured_pei_plate', filamentId: 'generic-pla', presetId: '0.20', overrides: { enable_arc_fitting: false, ...o } });
const mesh = (soup: Float32Array, id = 'm'): MeshInput => ({ id, name: id, ...weld(soup) });
const slots = (c: ReturnType<typeof cfg>) => { const a = slotFromConfig(c); return [a, { ...a, name: 'Black', color: '#111111' }, { ...a, name: 'Red', color: '#ff0000' }]; };
/** A 10×4 mm black rectangle centred on the origin. */
const rect: Pattern = parseSvg('<svg viewBox="0 0 10 4" width="10mm" height="4mm"><rect width="10" height="4" fill="#000"/></svg>', { id: 'rect' }).pattern;

const place = (over: Partial<WorldPlacement>, pattern = rect): WorldPlacement => ({ ...newPlacement('p1', pattern, 'm:0', [0, 0, 0], [0, 0, 1]), object: 0, ...over });
const act = (over: Partial<RegionAction> = {}): RegionAction => ({ region_ref: { placement_id: 'p1' }, material: { mode: 'slot', slot_index: 1 }, purge: { mode: 'full', change_point_shift_mm: 0 }, motion: null, ...over });
const pcfg = (placements: WorldPlacement[], actions: RegionAction[], patterns: Pattern[] = [rect], o: Partial<PatternexConfig> = {}): PatternexConfig =>
  ({ patterns, placements, actions, singleColour: 'skip', transitionVolume: [], ...o });

/** Layer tops and slices of a mesh, for resolving regions without the full slicer. */
function layersOf(m: MeshInput, h = 0.2, top = 10) {
  const layerZ: number[] = [], layerH: number[] = [];
  for (let z = h; z <= top + 1e-6; z += h) { layerZ.push(+z.toFixed(4)); layerH.push(h); }
  const planes = layerZ.map((z) => z - h / 2);
  const s = sliceMesh(m as any, planes);
  return { layerZ, layerH, planes, sliceAt: (_o: number, i: number) => s[i] };
}

describe('projection', () => {
  it('planar: plate ↔ pattern round trip, with rotation, scale and flip', () => {
    const p = place({ position_xyz: [70, 60, 5], projection_axis: [0, -1, 0], rotation: 30, scale_xy: [2, 0.5], flip: true });
    const f = frameOf(p, rect);
    for (const [u, v] of [[0, 0], [10, 4], [3, 1]]) {
      const q = fromPattern(f, u, v);
      expect(q[1]).toBeCloseTo(60, 6); // on the projection plane
      const back = toPattern(f, ...q);
      expect(back[0]).toBeCloseTo(u, 6); expect(back[1]).toBeCloseTo(v, 6);
    }
    // the pattern centre lands on the anchor; "up" in the pattern is +Z on a wall
    // (the SVG's Y is flipped on import, so the rect spans y -4..0 in pattern space)
    const c = fromPattern(frameOf(place({ position_xyz: [70, 60, 5], projection_axis: [0, -1, 0] }), rect), 5, -2);
    expect(c).toEqual([70, 60, 5].map((x) => expect.closeTo(x, 6)));
    const up = fromPattern(frameOf(place({ position_xyz: [70, 60, 5], projection_axis: [0, -1, 0] }), rect), 5, 0);
    expect(up[2]).toBeCloseTo(7, 6);
  });

  it('cylindrical: arc length around the axis maps to pattern X', () => {
    const p = place({ projection: 'cylindrical', projection_axis: [0, 0, 1], position_xyz: [112, 100, 5], axis_origin: [100, 100, 0] });
    const f = frameOf(p, rect);
    const q = fromPattern(f, 5 + (Math.PI / 2) * 12, -2); // a quarter turn along the surface
    expect(Math.hypot(q[0] - 100, q[1] - 100)).toBeCloseTo(12, 6);
    expect(q[2]).toBeCloseTo(5, 6);
    const back = toPattern(f, ...q);
    expect(back[0]).toBeCloseTo(5 + (Math.PI / 2) * 12, 6);
  });
});

describe('region masks', () => {
  const cube = mesh(box(60, 60, 0, 20, 20, 10));
  const ctx = layersOf(cube);

  it('planar on a cube wall: a 10 mm band of wall depth, only between z 3 and 7', () => {
    const [g] = placementGroups(place({ position_xyz: [70, 60, 5], projection_axis: [0, -1, 0] }), rect, 0.5, ctx);
    const z = (i: number) => ctx.layerZ[i];
    for (let i = 0; i < ctx.layerZ.length; i++) {
      const a = areaTotal(g.at(i));
      if (z(i) > 3.25 && z(i) < 6.95) expect(a).toBeCloseTo(10 * 0.5, 1);
      if (z(i) < 2.9 || z(i) > 7.3) expect(a).toBe(0);
    }
    // only the front wall: every point sits within 0.5 mm of y = 60
    for (const p of g.at(25)) for (const q of p) expect(q.Y / SCALE).toBeLessThanOrEqual(60.5 + 1e-6);
  });

  it('back faces are not printed through the part; through regions are', () => {
    const [g] = placementGroups(place({ position_xyz: [70, 60, 5], projection_axis: [0, -1, 0] }), rect, 0.5, ctx);
    expect(g.at(25).flat().every((q) => q.Y / SCALE < 61)).toBe(true);
    const [t] = placementGroups(place({ position_xyz: [70, 60, 5], projection_axis: [0, -1, 0], through: true }), rect, 0.5, ctx);
    expect(areaTotal(t.at(25))).toBeCloseTo(10 * 20, 0);
  });

  it('planar on the top: the footprint, only in the top `depth` of layers', () => {
    const [g] = placementGroups(place({ position_xyz: [70, 70, 10], projection_axis: [0, 0, 1] }), rect, 0.6, ctx);
    const used = ctx.layerZ.map((_, i) => areaTotal(g.at(i)));
    const hit = used.map((a, i) => (a > 0 ? i : -1)).filter((i) => i >= 0);
    expect(hit.length).toBe(3); // 0.6 mm at 0.2 mm layers
    expect(Math.max(...hit)).toBe(ctx.layerZ.length - 1);
    expect(used[hit[0]]).toBeCloseTo(40, 0);
  });

  it('cylindrical stripes wrap all the way round a cylinder', () => {
    const cyl = mesh(cylinder(100, 100, 12, 10, 96));
    const c = layersOf(cyl);
    const circ = 2 * Math.PI * 12;
    const stripes = builtinPattern('stripes', { width: circ, height: 6, cell: circ / 12 });
    const groups = placementGroups(place({ pattern_id: stripes.id, projection: 'cylindrical', projection_axis: [0, 0, 1], position_xyz: [112, 100, 5], axis_origin: [100, 100, 0] }), stripes, 0.5, c);
    expect(groups.length).toBe(2);
    for (const g of groups) {
      const a = areaTotal(g.at(25));
      expect(a).toBeGreaterThan(circ * 0.5 * 0.5 * 0.85); // half the circumference each, 0.5 deep
      expect(a).toBeLessThan(circ * 0.5 * 0.5 * 1.15);
      expect(g.at(c.layerZ.length - 1).length).toBe(0); // outside the 6 mm tall pattern
    }
  });
});

describe('slicing with Patternex (AMS)', () => {
  const cube = () => mesh(box(60, 60, 0, 20, 20, 10));
  const logo = (o: Partial<RegionAction> = {}) => pcfg([place({ position_xyz: [70, 70, 10], projection_axis: [0, 0, 1] })], [act(o)]);

  it('a logo on the top gets AMS tool changes; output is deterministic (golden)', () => {
    const c = cfg();
    const run = () => slice([cube()], c, () => {}, { filaments: slots(c), plugins: { patternex: logo() } });
    const a = run(), b = run();
    expect(a.gcode).toBe(b.gcode);
    const rep = a.pluginReports!.patternex as PatternexReport;
    expect(rep.regions[0].layerCount).toBeGreaterThan(0);
    expect(a.gcode).toContain('M620 S1A');
    // golden: n logo layers → n changes (each layer starts with the tool left loaded), half of them into slot 2
    const n = rep.regions[0].layerCount;
    expect(n).toBe(2); // outer-wall depth 0.42 mm at 0.2 mm layers
    expect((a.gcode.match(/M620 S1A/g) ?? []).length).toBe(Math.ceil(n / 2));
    expect(rep.toolChanges).toBe(n);
    expect(rep.transitions.full).toBe(rep.toolChanges);
    expect(rep.purgeGrams).toBeGreaterThan(0);
    expect(rep.addedTimeS).toBe(rep.toolChanges * 95);
    expect(a.stats.perFilament[1].grams).toBeGreaterThan(0.01);
  });

  it('starts each layer with the last tool of the previous one', () => {
    const c = cfg();
    const out = slice([cube()], c, () => {}, { filaments: slots(c), plugins: { patternex: logo() } });
    const layers = out.gcode.split(';LAYER_CHANGE').slice(1);
    let last = -1, violations = 0;
    for (const L of layers) {
      const ts = [...L.matchAll(/^T(\d+)/gm)].map((m) => +m[1]);
      if (ts.length && last >= 0 && ts[0] === last) violations++; // changing to the tool already loaded
      if (ts.length) last = ts[ts.length - 1];
    }
    expect(violations).toBe(0);
  });

  it('reduced purge uses the set volume; no purge flushes nothing and skips the tower', () => {
    const c = cfg();
    const full = slice([cube()], c, () => {}, { filaments: slots(c), plugins: { patternex: logo() } });
    const red = slice([cube()], c, () => {}, { filaments: slots(c), plugins: { patternex: logo({ purge: { mode: 'reduced', volume_mm3: 30, change_point_shift_mm: 0 } }) } });
    const none = slice([cube()], c, () => {}, { filaments: slots(c), plugins: { patternex: logo({ purge: { mode: 'none', change_point_shift_mm: 0 } }) } });
    // Bambu Studio's X1 Carbon change G-code: the purge is in its FLUSH blocks, plus the refill of the toolchange retraction
    const refill = Number(c.retract_length_toolchange);
    const flush = (g: string) => bambuFlushes(g).slice(1).map((e) => e - refill); // [0] is the first load
    expect(Math.max(...flush(red.gcode))).toBeCloseTo(30 / (Math.PI * 0.875 ** 2), 1);
    expect(Math.max(...flush(none.gcode))).toBeLessThanOrEqual(1e-6);
    expect(Math.min(...flush(full.gcode))).toBeGreaterThan(5);
    expect(none.stats.towerGrams).toBeLessThan(full.stats.towerGrams);
    const rep = none.pluginReports!.patternex as PatternexReport;
    expect(rep.transitions.none).toBeGreaterThan(0);
    expect(rep.purgeMm3).toBe(0);
    expect(rep.bleedZones.length).toBeGreaterThan(0);
    expect(rep.uncalibrated).toEqual([1, 0]); // into the logo, then back to the base
    expect(none.warnings.some((w) => /uncalibrated/.test(w))).toBe(true);
    // calibrated: no warning, and the bleed zone length follows the transition volume
    const cal = slice([cube()], c, () => {}, { filaments: slots(c), plugins: { patternex: { ...logo({ purge: { mode: 'none', change_point_shift_mm: 0 } }), transitionVolume: [10, 10, 10] } } });
    const rc = cal.pluginReports!.patternex as PatternexReport;
    expect(rc.uncalibrated).toEqual([]);
    expect(Math.max(...rc.bleedZones.map((z) => z.lengthMm))).toBeLessThan(Math.max(...rep.bleedZones.map((z) => z.lengthMm)));
  });

  it('change-point shift moves extrusion across the change and keeps total filament', () => {
    const c = cfg();
    const base = slice([cube()], c, () => {}, { filaments: slots(c), plugins: { patternex: logo({ purge: { mode: 'none', change_point_shift_mm: 0 } }) } });
    const early = slice([cube()], c, () => {}, { filaments: slots(c), plugins: { patternex: logo({ purge: { mode: 'none', change_point_shift_mm: 3 } }) } });
    const late = slice([cube()], c, () => {}, { filaments: slots(c), plugins: { patternex: logo({ purge: { mode: 'none', change_point_shift_mm: -3 } }) } });
    expect((early.pluginReports!.patternex as PatternexReport).shifted).toBeGreaterThan(0);
    expect((late.pluginReports!.patternex as PatternexReport).shifted).toBeGreaterThan(0);
    for (const o of [early, late]) {
      expect(o.stats.filamentMm).toBeCloseTo(base.stats.filamentMm, 0);
      expect(o.gcode).not.toBe(base.gcode);
    }
    // shifting earlier moves filament from slot 0 to slot 1
    expect(early.stats.perFilament[1].mm).toBeGreaterThan(base.stats.perFilament[1].mm);
    expect(late.stats.perFilament[1].mm).toBeLessThan(base.stats.perFilament[1].mm);
  });

  it('an SVG with two fill colours gives two region groups mapped to two slots', () => {
    const two = parseSvg('<svg viewBox="0 0 10 4" width="10mm" height="4mm"><rect width="5" height="4" fill="#000"/><rect x="5" width="5" height="4" fill="#f00"/></svg>', { id: 'two' }).pattern;
    const c = cfg();
    const p = place({ pattern_id: 'two', position_xyz: [70, 70, 10], projection_axis: [0, 0, 1] });
    const out = slice([cube()], c, () => {}, { filaments: slots(c), plugins: { patternex: pcfg([p], [
      act({ region_ref: { placement_id: 'p1', color_group: '#000000' }, material: { mode: 'slot', slot_index: 1 } }),
      act({ region_ref: { placement_id: 'p1', color_group: '#ff0000' }, material: { mode: 'slot', slot_index: 2 } }),
    ], [two]) } });
    expect(out.stats.perFilament[1].grams).toBeGreaterThan(0.005);
    expect(out.stats.perFilament[2].grams).toBeGreaterThan(0.005);
    expect((out.pluginReports!.patternex as PatternexReport).regions.map((r) => r.fil)).toEqual([1, 2]);
  });

  it('unassigned regions keep the base material', () => {
    const c = cfg();
    const out = slice([cube()], c, () => {}, { filaments: slots(c), plugins: { patternex: pcfg([place({ position_xyz: [70, 70, 10], projection_axis: [0, 0, 1] })], []) } });
    expect(out.stats.toolChanges).toBe(0);
  });
});

describe('single-colour printers (stop and swap)', () => {
  const pid = 'creality-ender3v3ke';
  const cube = () => mesh(box(60, 60, 0, 20, 20, 10));
  const band = (policy: PatternexConfig['singleColour'], pos: [number, number, number] = [70, 70, 10], pattern = rect) =>
    pcfg([place({ position_xyz: pos, projection_axis: [0, 0, 1], pattern_id: pattern.id })], [act({ material: { mode: 'manual', slot_index: 1, swap_label: 'Black PLA' } })], [pattern], { singleColour: policy });

  it('a logo inside a layer needs mid-layer swaps: flagged, left in the base colour, never printed wrong', () => {
    const c = cfg(pid);
    const out = slice([cube()], c, () => {}, { filaments: slots(c), plugins: { patternex: band('skip') } });
    const rep = out.pluginReports!.patternex as PatternexReport;
    expect(rep.unsupported.length).toBe(1);
    expect(out.gcode).not.toMatch(/^M600/m);
    expect(out.warnings.some((w) => /middle of a layer/.test(w))).toBe(true);
  });

  it('layer-band fallback: one swap with the colour label, and a swap summary', () => {
    const c = cfg(pid);
    const out = slice([cube()], c, () => {}, { filaments: slots(c), plugins: { patternex: band('band') } });
    const rep = out.pluginReports!.patternex as PatternexReport;
    expect(rep.manual).toBe(true);
    expect(rep.swaps.length).toBe(1);
    expect(rep.swaps[0]).toMatchObject({ from: 0, to: 1, label: 'Black PLA' });
    expect(rep.swaps[0].z).toBeCloseTo(9.8, 1); // top 0.42 mm = the last two layers
    expect((out.gcode.match(/^M600/gm) ?? []).length).toBe(1);
    expect(out.gcode).toContain('M117 Load Black PLA');
  });

  it('a pattern covering whole layers is supported as is', () => {
    const big = builtinPattern('checker', { width: 40, height: 40, cell: 40 }); // one 40 mm square
    const c = cfg(pid);
    const out = slice([cube()], c, () => {}, { filaments: slots(c), plugins: { patternex: { ...band('skip', [70, 70, 10], big), actions: [act({ region_ref: { placement_id: 'p1' }, material: { mode: 'manual', slot_index: 1, swap_label: 'Black' } })] } } });
    const rep = out.pluginReports!.patternex as PatternexReport;
    expect(rep.unsupported).toEqual([]);
    expect(rep.swaps.length).toBe(1);
  });
});

describe('Motionex hand-off', () => {
  it('Motionex edits only the walls inside a Patternex region', () => {
    const c = cfg('bbl-x1c');
    const sine = PRESETS.find((b) => b.id === 'preset-sine')!;
    const p = place({ position_xyz: [110, 100, 5], projection_axis: [0, -1, 0] });
    const regionId = 'p1:#000000';
    const mx: MotionexConfig = {
      applications: [{ brush_id: sine.id, target: { type: 'faces', walls: 'outer', faces: [regionId] }, mask: { z_start: 0, z_end: 1e4, fade_in_mm: 0, fade_out_mm: 0 }, order: 0, blend: 'add', enabled: true }],
      brushes: [sine], options: DEFAULT_OPTIONS, collisionMode: 'clamp', toolhead: defaultToolhead('bbl-x1c'), printerId: 'bbl-x1c',
    };
    const cubeM = mesh(box(100, 100, 0, 20, 20, 10));
    const pc = pcfg([p], [act({ material: { mode: 'slot', slot_index: 0 }, motion: { motionex_brush_id: sine.id } })]);
    const out = slice([cubeM], c, () => {}, { filaments: slots(c), plugins: { motionex: mx, patternex: pc } });
    const rep = out.pluginReports!.motionex as MotionexReport;
    expect(rep.movedPaths).toBeGreaterThan(0);
    // outside the region's z band (3..7) nothing moved: compare to a plain slice at layer z=1 and z=9
    const plain = slice([cubeM], c, () => {}, { filaments: slots(c) });
    const layer = (g: string, z: string) => g.slice(g.indexOf(`;Z:${z}\n`), g.indexOf(';LAYER_CHANGE', g.indexOf(`;Z:${z}\n`))).replace(/^M73.*\n/gm, '');
    expect(layer(out.gcode, '1')).toBe(layer(plain.gcode, '1'));
    expect(layer(out.gcode, '9')).toBe(layer(plain.gcode, '9'));
    expect(layer(out.gcode, '5')).not.toBe(layer(plain.gcode, '5'));
  });
});

describe('Motionex on uninked artwork, and paint overlap', () => {
  it('a motion aimed at an uninked region still moves only that region, with no material change', () => {
    const c = cfg('bbl-x1c');
    const sine = PRESETS.find((b) => b.id === 'preset-sine')!;
    const regionId = 'p1:#000000';
    const mx: MotionexConfig = {
      applications: [{ brush_id: sine.id, target: { type: 'faces', walls: 'outer', faces: [regionId] }, mask: { z_start: 0, z_end: 1e4, fade_in_mm: 0, fade_out_mm: 0 }, order: 0, blend: 'add', enabled: true }],
      brushes: [sine], options: DEFAULT_OPTIONS, collisionMode: 'clamp', toolhead: defaultToolhead('bbl-x1c'), printerId: 'bbl-x1c',
    };
    const m = mesh(box(100, 100, 0, 20, 20, 10));
    const pc = { ...pcfg([place({ position_xyz: [110, 100, 5], projection_axis: [0, -1, 0] })], []), motionTargets: [regionId] };
    const out = slice([m], c, () => {}, { filaments: slots(c), plugins: { motionex: mx, patternex: pc } });
    expect((out.pluginReports!.motionex as MotionexReport).movedPaths).toBeGreaterThan(0);
    expect(out.stats.toolChanges).toBe(0);
  });

  it('warns when artwork covers colour paint (artwork wins)', () => {
    const c = cfg();
    const m = mesh(box(60, 60, 0, 20, 20, 10));
    const color = new Uint8Array(m.indices.length / 3).fill(3); // everything painted slot 3
    const out = slice([{ ...m, paint: { color } }], c, () => {}, { filaments: slots(c), plugins: { patternex: pcfg([place({ position_xyz: [70, 70, 10], projection_axis: [0, 0, 1] })], [act()]) } });
    expect(out.warnings.some((w) => /covers colour paint/.test(w))).toBe(true);
  });
});

describe('scale', () => {
  it('50 placements of a 40-shape pattern resolve without stalling', () => {
    const c = cfg();
    const dots = builtinPattern('dots', { width: 10, height: 10, cell: 1.5 });
    const placements = Array.from({ length: 50 }, (_, k) => ({ ...place({ pattern_id: dots.id, position_xyz: [62 + (k % 8) * 2, 62 + Math.floor(k / 8) * 2, 10], projection_axis: [0, 0, 1], scale_xy: [0.2, 0.2] }), id: `p${k}` }));
    const actions = placements.map((p) => act({ region_ref: { placement_id: p.id } }));
    const t0 = performance.now();
    const out = slice([mesh(box(60, 60, 0, 20, 20, 4))], c, () => {}, { filaments: slots(c), plugins: { patternex: pcfg(placements, actions, [dots]) } });
    expect(performance.now() - t0).toBeLessThan(60_000);
    expect((out.pluginReports!.patternex as PatternexReport).regions.length).toBe(50);
  });
});
