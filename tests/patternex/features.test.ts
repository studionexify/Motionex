// Patternex beyond colour, through Nexspiro's real slicer: relief (raise / recess), dithering, band merging,
// purge into infill / a sacrificial object, per-region infill, speed and fuzzy skin, surface-angle filter.
import { describe, expect, it } from 'vitest';
import { slice, slotFromConfig } from '../../src/engine/slicer';
import { weld } from '../../src/engine/mesh';
import { resolveConfig } from '../../src/profiles/resolve';
import { box, cylinder } from '../fixtures';
import { newPlacement, parseSvg, type Pattern, type RegionAction } from '../../src/plugins/patternex';
import type { WorldPlacement } from '../../src/plugins/patternex/projection';
import type { PatternexConfig, PatternexReport } from '../../src/plugins/patternex/engine';
import type { MeshInput } from '../../src/engine/types';
import { purgeFirst } from '../../src/plugins/patternex/effects';
import type { Op } from '../../src/engine/gcode';

const cfg = (printerId = 'bbl-p1s', o = {}) => resolveConfig({ printerId, plate: 'textured_pei_plate', filamentId: 'generic-pla', presetId: '0.20', overrides: { enable_arc_fitting: false, ...o } });
const mesh = (soup: Float32Array, id = 'm'): MeshInput => ({ id, name: id, ...weld(soup) });
const slots = (c: ReturnType<typeof cfg>) => { const a = slotFromConfig(c); return [a, { ...a, name: 'Black', color: '#111111' }, { ...a, name: 'Red', color: '#ff0000' }]; };
const rect: Pattern = parseSvg('<svg viewBox="0 0 10 4" width="10mm" height="4mm"><rect width="10" height="4" fill="#000"/></svg>', { id: 'rect' }).pattern;
const place = (over: Partial<WorldPlacement>): WorldPlacement => ({ ...newPlacement('p1', rect, 'm:0', [0, 0, 0], [0, 0, 1]), object: 0, ...over });
const act = (over: Partial<RegionAction> = {}): RegionAction => ({ region_ref: { placement_id: 'p1' }, material: { mode: 'slot', slot_index: 1 }, purge: { mode: 'full', change_point_shift_mm: 0 }, motion: null, ...over });
const pcfg = (placements: WorldPlacement[], actions: RegionAction[], o: Partial<PatternexConfig> = {}): PatternexConfig => ({ patterns: [rect], placements, actions, singleColour: 'skip', transitionVolume: [], ...o });
/** A printer without an AMS (manual swaps). */
const SINGLE = 'creality-ender3v3ke';
const cube = () => mesh(box(60, 60, 0, 20, 20, 10));
/** Side wall (-Y face of the cube), centred at mid height. */
const front = (o: Partial<WorldPlacement> = {}) => place({ position_xyz: [70, 60, 5], projection_axis: [0, -1, 0], ...o });

/** Smallest Y extruded per layer (keyed by layer Z) and overall. */
const extremes = (gcode: string) => {
  let minY = Infinity; const ys: Record<string, number> = {};
  // the part only: not the end G-code, nor Bambu's own change G-code (M620 … M621), which purges at the chute
  const part = gcode.split(';===== NexSpiro end G-code')[0].replace(/^M620 S\d+A[\s\S]*?^M621 S\d+A.*$/gm, '');
  for (const L of part.split(';LAYER_CHANGE').slice(1)) {
    const z = Number(/;Z:([\d.]+)/.exec(L)?.[1] ?? 0).toFixed(1);
    for (const p of extrusions(L)) { minY = Math.min(minY, p[1]); ys[z] = Math.min(ys[z] ?? Infinity, p[1]); }
  }
  return { minY, ys };
};
/** End points of extrusion moves (G-code omits unchanged axes, so X/Y are tracked). */
function extrusions(gcode: string): [number, number][] {
  let x = NaN, y = NaN; const out: [number, number][] = [];
  for (const line of gcode.split('\n')) {
    if (!/^G[0123] /.test(line)) continue;
    const px = x, py = y;
    const mx = / X(-?[\d.]+)/.exec(line), my = / Y(-?[\d.]+)/.exec(line);
    if (mx) x = Number(mx[1]); if (my) y = Number(my[1]);
    if (!/ E[\d.]/.test(line) || !isFinite(x) || !isFinite(y)) continue;
    // sample along the segment so long lines count where they pass, not only where they end
    const n = isFinite(px) ? Math.max(1, Math.ceil(Math.hypot(x - px, y - py))) : 1;
    for (let k = 1; k <= n; k++) out.push(isFinite(px) ? [px + ((x - px) * k) / n, py + ((y - py) * k) / n] : [x, y]);
  }
  return out;
}
const changesTo = (gcode: string, slot: number) => (gcode.match(new RegExp(`M620 S${slot}A`, 'g')) ?? []).length;
/** Filament (E) extruded in the layer at height z. */
const layerE = (gcode: string, z: string) => {
  const L = gcode.split(';LAYER_CHANGE').find((l) => new RegExp(`;Z:${z}\\b`).test(l)) ?? '';
  return [...L.matchAll(/ E([\d.]+)/g)].reduce((a, m) => a + Number(m[1]), 0);
};

describe('relief (single- and multi-colour)', () => {
  it('raised text on a wall pushes the outer wall out by the height, only where the artwork is', () => {
    const c = cfg(SINGLE); // no AMS
    const plain = slice([cube()], c, () => {}, { filaments: [slotFromConfig(c)] });
    const raised = slice([cube()], c, () => {}, { filaments: [slotFromConfig(c)], plugins: { patternex: pcfg([front()], [act({ material: { mode: 'keep', slot_index: 0 }, relief: { mode: 'raise', height_mm: 0.8 } })]) } });
    const a = extremes(plain.gcode), b = extremes(raised.gcode);
    expect(a.minY - b.minY).toBeGreaterThan(0.7);
    expect(a.minY - b.minY).toBeLessThan(0.9);
    // the artwork spans z 3..7: layers near the bottom are unchanged
    expect(b.ys['1.0']).toBeCloseTo(a.ys['1.0'], 2);
    expect((raised.pluginReports!.patternex as PatternexReport).reliefs).toBe(1);
    expect(raised.gcode).not.toMatch(/M600|T1/); // no colour change: geometry only
  });
  it('recessed artwork on the top face removes the top material under the footprint', () => {
    const c = cfg(SINGLE);
    const base = slice([cube()], c, () => {}, { filaments: [slotFromConfig(c)] });
    const rec = slice([cube()], c, () => {}, { filaments: [slotFromConfig(c)], plugins: { patternex: pcfg([place({ position_xyz: [70, 70, 10], projection_axis: [0, 0, 1] })], [act({ material: { mode: 'keep', slot_index: 0 }, relief: { mode: 'recess', height_mm: 0.6 } })]) } });
    // nothing is printed inside the 10×4 footprint on the top layer; the plain cube fills it
    const top = (g: string) => g.split(';LAYER_CHANGE').find((l) => /;Z:10\b/.test(l)) ?? '';
    const inside = (g: string) => extrusions(top(g)).filter(([x, y]) => x > 65.6 && x < 74.4 && y > 68.4 && y < 71.6).length;
    expect(inside(base.gcode)).toBeGreaterThan(5);
    expect(inside(rec.gcode)).toBe(0);
    void layerE;
  });
  it('raised AND inked: the bump prints in the ink on an AMS', () => {
    const c = cfg();
    const out = slice([cube()], c, () => {}, { filaments: slots(c), plugins: { patternex: pcfg([front()], [act({ relief: { mode: 'raise', height_mm: 0.6 } })]) } });
    expect((out.pluginReports!.patternex as PatternexReport).toolChanges).toBeGreaterThan(0);
    const plain = slice([cube()], c, () => {}, { filaments: slots(c) });
    expect(extremes(plain.gcode).minY - extremes(out.gcode).minY).toBeCloseTo(0.6, 1);
  });
});

describe('dithering', () => {
  it('layer dither alternates the two slots in the given share', () => {
    const c = cfg();
    const out = slice([cube()], c, () => {}, { filaments: slots(c), plugins: { patternex: pcfg([front()], [act({ dither: { slot_index: 2, ratio: 0.5, mode: 'layer' } })]) } });
    const t1 = changesTo(out.gcode, 1), t2 = changesTo(out.gcode, 2);
    expect(t1).toBeGreaterThan(3); expect(t2).toBeGreaterThan(3);
    expect(Math.abs(t1 - t2)).toBeLessThanOrEqual(2);
  });
  it('line dither uses both inks on the same layer', () => {
    const c = cfg();
    const out = slice([cube()], c, () => {}, { filaments: slots(c), plugins: { patternex: pcfg([front()], [act({ dither: { slot_index: 2, ratio: 0.5, mode: 'line' } })]) } });
    const layer = out.gcode.split(';LAYER_CHANGE').find((l) => /M620 S1A/.test(l) && /M620 S2A/.test(l));
    expect(layer).toBeTruthy();
  });
});

describe('single-colour band merging', () => {
  it('fills short base gaps between bands of the same colour and reports swaps saved', () => {
    const c = cfg(SINGLE);
    // two stripes 0.6 mm apart (3 layers) on the wall
    const two: Pattern = parseSvg('<svg viewBox="0 0 10 4" width="10mm" height="4mm"><rect width="10" height="1.4" fill="#000"/><rect y="2" width="10" height="2" fill="#000"/></svg>', { id: 'rect' }).pattern;
    const run = (merge: number) => slice([cube()], c, () => {}, { filaments: slots(c), plugins: { patternex: { ...pcfg([front()], [act()], { singleColour: 'band', swapMergeLayers: merge }), patterns: [two] } } });
    const a = run(0).pluginReports!.patternex as PatternexReport, b = run(5).pluginReports!.patternex as PatternexReport;
    expect(a.swaps.length).toBe(4);
    expect(b.swaps.length).toBe(2);
    expect(b.swapsSaved).toBe(2);
  });
});

describe('purge targets', () => {
  const twoObjects = () => [cube(), mesh(box(100, 60, 0, 15, 15, 10), 'purge')];
  it('purge into a sacrificial object reduces tower purge and prints that object first after each change', () => {
    const c = cfg();
    const p = (o: Partial<PatternexConfig>) => pcfg([front()], [act()], o);
    const tower = slice(twoObjects(), c, () => {}, { filaments: slots(c), plugins: { patternex: p({}) } });
    const obj = slice(twoObjects(), c, () => {}, { filaments: slots(c), plugins: { patternex: p({ purgeTarget: 'object', purgeObject: 1 }) } });
    const rt = tower.pluginReports!.patternex as PatternexReport, ro = obj.pluginReports!.patternex as PatternexReport;
    expect(ro.purgeMm3).toBeLessThan(rt.purgeMm3);
    expect(ro.purgeAbsorbedMm3).toBeGreaterThan(0);
    expect(ro.toolChanges).toBe(rt.toolChanges);
    // filament used is about the same: purge moved, not removed
    expect(Math.abs(obj.stats.filamentMm - tower.stats.filamentMm) / tower.stats.filamentMm).toBeLessThan(0.05);
  });
  it('purgeFirst keeps the extruder balanced (retract/deretract pairs) when moving chunks', () => {
    const mv = (x: number, e: number, travel = false, feature: any = 'sparse_infill'): Op => ({ k: 'move', x, y: 0, z: 1, e, f: 100, feature: travel ? 'travel' : feature, w: 0.4, h: 0.2, travel });
    const ops: Op[] = [
      { k: 'tool', tool: 1 },
      mv(1, 0, true), { k: 'retract', len: -0.8, speed: 30 }, mv(2, 1, false, 'outer_wall'), { k: 'retract', len: 0.8, speed: 30 },
      mv(5, 0, true), { k: 'retract', len: -0.8, speed: 30 }, mv(6, 2), mv(7, 2),
      mv(9, 0, true), mv(10, 1, false, 'inner_wall'),
    ];
    const e = purgeFirst(ops, 0, (ms) => ms.every((m) => m.k === 'move' && m.feature === 'sparse_infill'), { len: 0.8, speed: 30, deretractSpeed: 30, afterChange: true });
    expect(e).toBe(4);
    // infill now comes right after the tool change
    const firstExtr = ops.find((o) => o.k === 'move' && !o.travel) as Extract<Op, { k: 'move' }>;
    expect(firstExtr.feature).toBe('sparse_infill');
    // retraction state never doubles up: alternating signs
    const r = ops.filter((o) => o.k === 'retract').map((o) => Math.sign((o as { len: number }).len));
    for (let k = 1; k < r.length; k++) expect(r[k]).not.toBe(r[k - 1]);
    expect(r[0]).toBe(-1); // starts retracted after the AMS change
    // every extrusion happens while deretracted
    let retracted = true;
    for (const o of ops) { if (o.k === 'retract') retracted = o.len > 0; if (o.k === 'move' && !o.travel) expect(retracted).toBe(false); }
  });
});

describe('region effects', () => {
  it('speed factor slows moves inside the region; fuzzy skin adds points on the outer wall there', () => {
    const c = cfg('bbl-p1s', { slow_down_layer_time: 0 });
    const run = (effects: RegionAction['effects']) => slice([cube()], c, () => {}, { filaments: slots(c), plugins: { patternex: pcfg([front()], [act({ material: { mode: 'keep', slot_index: 0 }, effects })]) } });
    const base = run(null), slow = run({ speed: 0.5 }), fuzzy = run({ fuzzy: true });
    expect(slow.stats.timeSeconds).toBeGreaterThan(base.stats.timeSeconds + 1);
    expect(fuzzy.gcode.split('\n').length).toBeGreaterThan(base.gcode.split('\n').length + 100);
    // fuzzy points stay within the configured thickness of the wall
    const ys = extrusions(fuzzy.gcode.split(';LAYER_CHANGE').find((l) => /;Z:5\b/.test(l))!).map((p) => p[1]);
    expect(Math.min(...ys)).toBeGreaterThan(60.21 - 0.31);
  });
  it('transparency: solid infill behind the region', () => {
    const c = cfg();
    const base = slice([cube()], c, () => {}, { filaments: slots(c), plugins: { patternex: pcfg([place({ position_xyz: [70, 60, 5], projection_axis: [0, -1, 0], through: true })], [act({ material: { mode: 'keep', slot_index: 0 } })]) } });
    const clear = slice([cube()], c, () => {}, { filaments: slots(c), plugins: { patternex: pcfg([place({ position_xyz: [70, 60, 5], projection_axis: [0, -1, 0], through: true })], [act({ material: { mode: 'keep', slot_index: 0 }, effects: { transparency: true } })]) } });
    expect(clear.stats.filamentMm).toBeGreaterThan(base.stats.filamentMm * 1.05);
  });
});

describe('surface-angle filter', () => {
  it('a wrap on a cylinder covers less of the wall with a tighter angle', () => {
    const c = cfg();
    const cyl = () => mesh(cylinder(100, 100, 12, 10, 96));
    const wide: Pattern = parseSvg('<svg viewBox="0 0 80 4" width="80mm" height="4mm"><rect width="80" height="4" fill="#000"/></svg>', { id: 'rect' }).pattern;
    const run = (max_angle?: number) => slice([cyl()], c, () => {}, { filaments: slots(c), plugins: { patternex: { ...pcfg([place({ position_xyz: [100, 88, 5], projection_axis: [0, -1, 0], max_angle })], [act()]), patterns: [wide] } } });
    const used = (r: ReturnType<typeof run>) => (r.pluginReports!.patternex as PatternexReport).outlines.filter((o) => o.layer === 25).flatMap((o) => o.rings).reduce((a, ring) => a + ring.length, 0);
    expect(used(run(30))).toBeGreaterThan(0);
    expect(used(run(30))).toBeLessThan(used(run(80)) * 0.8);
  });
});
