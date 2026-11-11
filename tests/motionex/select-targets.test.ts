// Select & apply, round 3: rules aimed at wall numbers, skin numbers and curved / straight stretches; the
// window's live draft of motions; and the rule's own motion tuning.
import { describe, expect, it } from 'vitest';
import { slice, slotFromConfig } from '../../src/engine/slicer';
import { weld } from '../../src/engine/mesh';
import { resolveConfig } from '../../src/profiles/resolve';
import { box, cylinder } from '../fixtures';
import { defaultToolhead } from '../../src/plugins/motionex/core/toolhead';
import { DEFAULT_OPTIONS } from '../../src/plugins/motionex/modifier';
import type { MotionexConfig } from '../../src/plugins/motionex/engine';
import { ALL_TARGETS, groupsOfTargets, newRule, tunedBrush, type RuleTargets, type SelectRule } from '../../src/plugins/motionex/select/model';
import { classifyLines, CLASS_IDS, segsOfOps } from '../../src/plugins/motionex/select/classes';
import { makeDraft } from '../../src/plugins/motionex/select/draft';
import { PRESETS } from '../../src/plugins/motionex/presets';
import { MOVE_STRIDE, type LayerOps } from '../../src/engine/gcode';
import { FEATURE_ORDER } from '../../src/engine/types';

const CX = 128, CY = 128, R = 15;
const cfg = () => resolveConfig({ printerId: 'snapmaker-u1', plate: 'textured_pei_plate', filamentId: 'generic-pla', presetId: '0.20', overrides: { wall_loops: 3 } as never });
const mxc = (rules: SelectRule[]): MotionexConfig => ({
  applications: [], brushes: PRESETS.filter((b) => rules.some((r) => r.apply.motion?.brush_id === b.id)), options: DEFAULT_OPTIONS,
  collisionMode: 'clamp', toolhead: defaultToolhead('snapmaker-u1'), printerId: 'snapmaker-u1', rules,
});
const rule = (p: Partial<SelectRule>): SelectRule => ({ ...newRule(1), ...p });
const targets = (t: Partial<RuleTargets>): Pick<SelectRule, 'targets' | 'lines'> => { const x = { ...ALL_TARGETS, outer: false, inner: null, infill: false, top: null, bottom: null, solid: false, support: false, ...t }; return { targets: x, lines: groupsOfTargets(x) }; };
function run(rules: SelectRule[], mesh = weld(cylinder(CX, CY, R, 8, 96))) {
  const c = cfg();
  const a = slotFromConfig(c);
  return slice([{ id: 'p', name: 'p', ...mesh }], c, () => {}, { filaments: [a], plugins: rules.length ? { motionex: mxc(rules) } : undefined });
}
/** Distance from the centre of each printed move of a feature on the layer near z. */
function radii(out: ReturnType<typeof run>, z: number, feature: string) {
  const L = out.layers.find((l) => Math.abs(l.z - z) < 0.05)!;
  const f = FEATURE_ORDER.indexOf(feature as never), r: number[] = [];
  for (let k = L.moveStart; k < L.moveEnd; k++) if (out.moveFeatures[k] === f) r.push(Math.hypot(out.moves[k * MOVE_STRIDE] - CX, out.moves[k * MOVE_STRIDE + 1] - CY));
  return r;
}
const spread = (r: number[]) => Math.max(...r) - Math.min(...r);

describe('line classes', () => {
  it('numbers three walls and marks a circle curved and a box side straight', () => {
    const out = run([]);
    // rebuild ops from the slice to measure them the way the slicer pass does
    const layers: LayerOps[] = out.layers.map((L) => ({ z: L.z, h: L.height, fan: 0, ops: Array.from({ length: L.moveEnd - L.moveStart }, (_, j) => {
      const k = L.moveStart + j, b = k * MOVE_STRIDE, f = FEATURE_ORDER[out.moveFeatures[k]];
      return { k: 'move' as const, x: out.moves[b], y: out.moves[b + 1], z: out.moves[b + 2], e: f === 'travel' ? 0 : 1, f: 1, feature: f, w: out.moves[b + 3], h: out.moves[b + 4], travel: f === 'travel' };
    }) }));
    const { segs, width } = segsOfOps(layers);
    const lc = classifyLines(segs, layers.length, (k) => width[k]);
    expect(lc.max.inner).toBe(2);
    const outer = CLASS_IDS.indexOf('outer');
    const outerSegs = [...lc.cls.keys()].filter((s) => lc.cls[s] === outer);
    expect(outerSegs.filter((s) => lc.curved[s]).length / outerSegs.length).toBeGreaterThan(0.9);

    const bx = run([], weld(box(110, 110, 0, 36, 36, 6)));
    const bl: LayerOps[] = bx.layers.map((L) => ({ z: L.z, h: L.height, fan: 0, ops: Array.from({ length: L.moveEnd - L.moveStart }, (_, j) => {
      const k = L.moveStart + j, b = k * MOVE_STRIDE, f = FEATURE_ORDER[bx.moveFeatures[k]];
      return { k: 'move' as const, x: bx.moves[b], y: bx.moves[b + 1], z: bx.moves[b + 2], e: f === 'travel' ? 0 : 1, f: 1, feature: f, w: bx.moves[b + 3], h: bx.moves[b + 4], travel: f === 'travel' };
    }) }));
    const b2 = segsOfOps(bl), lb = classifyLines(b2.segs, bl.length, (k) => b2.width[k]);
    const bo = [...lb.cls.keys()].filter((s) => lb.cls[s] === outer);
    expect(bo.filter((s) => lb.curved[s]).length / bo.length).toBeLessThan(0.05);
  });
});

describe('rules aimed at numbered lines', () => {
  it('a motion on inner wall 2 only moves that wall', () => {
    const base = run([]);
    const out = run([rule({ pick: { kind: 'layers', z0: 3, z1: 5 }, ...targets({ inner: [2, 2] }), apply: { motion: { brush_id: PRESETS[0].id, scale: 2 } }, blend_mm: 0 })]);
    const z = out.layers.find((l) => l.z > 4 - 0.05 && l.z < 4 + 0.15)!.z;
    // outer wall untouched; the inner walls as a whole now spread wider than before
    expect(spread(radii(out, z, 'outer_wall'))).toBeLessThan(spread(radii(base, z, 'outer_wall')) + 0.05);
    expect(spread(radii(out, z, 'inner_wall'))).toBeGreaterThan(spread(radii(base, z, 'inner_wall')) + 0.15);
    // inner wall 1 (the ring next to the outer wall) stays where it was
    const r1 = Math.max(...radii(base, z, 'inner_wall'));
    const onRing = (o: typeof out) => radii(o, z, 'inner_wall').filter((r) => Math.abs(r - r1) < 0.03).length;
    expect(onRing(out)).toBeGreaterThan(20);
    // nothing of inner wall 2 reaches into inner wall 1's lane
    expect(radii(out, z, 'inner_wall').every((r) => Math.abs(r - r1) < 0.03 || r < r1 - 0.12)).toBe(true);
  });

  it('speed on top layer 1 only slows the top surface', () => {
    const mesh = weld(box(110, 110, 0, 30, 30, 4));
    const base = run([], mesh);
    const out = run([rule({ pick: { kind: 'layers', z0: 0, z1: 10 }, ...targets({ top: [1, 1] }), apply: { speed: 50 }, blend_mm: 0 })], mesh);
    const top = FEATURE_ORDER.indexOf('top_surface'), inner = FEATURE_ORDER.indexOf('internal_solid_infill');
    const avg = (o: typeof out, f: number) => { let s = 0, n = 0; for (let k = 0; k < o.moveFeatures.length; k++) if (o.moveFeatures[k] === f) { s += o.moves[k * MOVE_STRIDE + 5]; n++; } return s / Math.max(1, n); };
    expect(avg(out, top)).toBeLessThan(avg(base, top) * 0.8);
    expect(Math.abs(avg(out, inner) - avg(base, inner))).toBeLessThan(avg(base, inner) * 0.05);
  });
});

describe('live draft', () => {
  it('draws the motion on the outer wall without slicing, fast', () => {
    const out = run([]);
    const r = rule({ pick: { kind: 'layers', z0: 3, z1: 5 }, apply: { motion: { brush_id: PRESETS[0].id, scale: 2 } }, blend_mm: 0 });
    const d = makeDraft({ result: out, rules: [r], now: {}, boxes: [], brushOf: (id) => PRESETS.find((b) => b.id === id), cfg: cfg(), printerId: 'snapmaker-u1' })!;
    expect(d).toBeTruthy();
    expect(d.pos.length).toBeGreaterThan(600);
    expect(d.replaced.size).toBeGreaterThan(10);
    let lo = Infinity, hi = 0;
    for (let k = 0; k < d.pos.length; k += 3) { const rr = Math.hypot(d.pos[k] - CX, d.pos[k + 1] - CY); if (d.pos[k + 2] > 3.9 && d.pos[k + 2] < 4.1 && rr > R - 0.5) { lo = Math.min(lo, rr); hi = Math.max(hi, rr); } }
    expect(hi - lo).toBeGreaterThan(0.5);
    expect(d.ms).toBeLessThan(2000);
  });

  it("the rule's own tuning changes the motion and leaves the library one alone", () => {
    const b = PRESETS[0];
    const t = tunedBrush({ brush_id: b.id, scale: 1, amp: b.amplitude * 2, period: 7, layers: null, z: 0.08 }, b);
    expect(t.amplitude).toBeCloseTo(b.amplitude * 2);
    expect(t.period_mm).toBe(7);
    expect(t.layers).toBeNull();
    expect(t.z_amplitude).toBeCloseTo(0.08);
    expect(tunedBrush({ brush_id: b.id, scale: 1 }, b)).toBe(b);
  });
});

describe('walls from the 3D model', () => {
  it('builds outer and inner wall loops per layer at the chosen layer height, and drafts motions on them', async () => {
    const { wallsFromModel } = await import('../../src/plugins/motionex/select/modelWalls');
    const mesh = { id: 'p', name: 'p', ...weld(cylinder(CX, CY, R, 8, 96)) };
    const a = wallsFromModel([mesh], { layerH: 0.2, firstH: 0.2, walls: 3, outerW: 0.42, innerW: 0.45 })!;
    const b = wallsFromModel([mesh], { layerH: 0.1, firstH: 0.2, walls: 2, outerW: 0.42, innerW: 0.45 })!;
    expect(a.layers.length).toBe(40);
    expect(b.layers.length).toBe(79);
    const OUT = FEATURE_ORDER.indexOf('outer_wall');
    const L = a.layers[10], rs: number[] = [];
    for (let k = L.moveStart; k < L.moveEnd; k++) if (a.moveFeatures[k] === OUT) rs.push(Math.hypot(a.moves[k * MOVE_STRIDE] - CX, a.moves[k * MOVE_STRIDE + 1] - CY));
    expect(Math.abs(rs[0] - (R - 0.21))).toBeLessThan(0.05);
    const r = rule({ pick: { kind: 'layers', z0: 3, z1: 5 }, apply: { motion: { brush_id: PRESETS[0].id, scale: 1 } }, blend_mm: 0 });
    const d = makeDraft({ result: a, rules: [r], now: {}, boxes: [], brushOf: (id) => PRESETS.find((x) => x.id === id), cfg: cfg(), printerId: 'snapmaker-u1' })!;
    expect(d.pos.length).toBeGreaterThan(600);
  });

  it('a motion on one inner wall is made small enough not to reach the next wall', () => {
    const out = run([]);
    const r = rule({ pick: { kind: 'layers', z0: 3, z1: 5 }, ...targets({ inner: [2, 2] }), apply: { motion: { brush_id: PRESETS[0].id, scale: 2 } }, blend_mm: 0 });
    const d = makeDraft({ result: out, rules: [r], now: {}, boxes: [], brushOf: (id) => PRESETS.find((x) => x.id === id), cfg: cfg(), printerId: 'snapmaker-u1' })!;
    expect(d.limited).toHaveLength(1);
    expect(d.limited[0].mm).toBeLessThan(0.3);
    // the outer wall alone is not limited (the inner walls follow it)
    const o = rule({ pick: { kind: 'layers', z0: 3, z1: 5 }, ...targets({ outer: true }), apply: { motion: { brush_id: PRESETS[0].id, scale: 2 } }, blend_mm: 0 });
    expect(makeDraft({ result: out, rules: [o], now: {}, boxes: [], brushOf: (id) => PRESETS.find((x) => x.id === id), cfg: cfg(), printerId: 'snapmaker-u1' })!.limited).toHaveLength(0);
  });
});

describe('model preview with infill and skins', () => {
  it('adds bottom, top, solid and sparse lines, numbered like a slice', async () => {
    const { wallsFromModel } = await import('../../src/plugins/motionex/select/modelWalls');
    const mesh = { id: 'p', name: 'p', ...weld(box(110, 110, 0, 30, 30, 6)) };
    const r = wallsFromModel([mesh], { layerH: 0.2, firstH: 0.2, walls: 2, outerW: 0.42, innerW: 0.45, fill: true, top: 4, bottom: 3, density: 15, fillW: 0.45 })!;
    const has = (f: string) => r.moveFeatures.includes(FEATURE_ORDER.indexOf(f as never));
    for (const f of ['bottom_surface', 'top_surface', 'internal_solid_infill', 'sparse_infill']) expect(has(f), f).toBe(true);
    const segs = (await import('../../src/plugins/motionex/ui/selectView')).segmentsOf;
    const sg = segs(r);
    const lc = classifyLines(sg, r.layers.length, () => 0.45);
    expect(lc.max.top).toBe(4);
    expect(lc.max.bottom).toBe(3);
    const off = wallsFromModel([mesh], { layerH: 0.2, firstH: 0.2, walls: 2, outerW: 0.42, innerW: 0.45, fill: false })!;
    expect(off.moveFeatures.includes(FEATURE_ORDER.indexOf('sparse_infill'))).toBe(false);
  });
});

describe('reach up and down', () => {
  const line = { z: 2, h: 0.2, feature: 'outer_wall' as const, w: 0.42, pts: [[0, 0], [10, 0]] as [number, number][] };
  it('a new rule picks only its own layer', async () => {
    const { piecesAt } = await import('../../src/plugins/motionex/select/geometry');
    const r = rule({ pick: { kind: 'lines', lines: [line] } });
    expect(piecesAt(r, 2, 0.2)).toHaveLength(1);
    expect(piecesAt(r, 2.2, 0.2)).toHaveLength(0);
    expect(piecesAt(r, 1.8, 0.2)).toHaveLength(0);
  });
  it('gradual fades over the chosen layers, sudden keeps full strength, then both stop', async () => {
    const { piecesAt } = await import('../../src/plugins/motionex/select/geometry');
    const g = rule({ pick: { kind: 'lines', lines: [line] }, spread: { above: 3, below: 1, fade: 'gradual' } });
    expect(piecesAt(g, 2.2, 0.2)[0].zf).toBeCloseTo(0.75);
    expect(piecesAt(g, 2.6, 0.2)[0].zf).toBeCloseTo(0.25);
    expect(piecesAt(g, 2.8, 0.2)).toHaveLength(0);
    expect(piecesAt(g, 1.8, 0.2)[0].zf).toBeCloseTo(0.5);
    expect(piecesAt(g, 1.6, 0.2)).toHaveLength(0);
    const s = rule({ pick: { kind: 'lines', lines: [line] }, spread: { above: 3, below: 0, fade: 'sudden' } });
    expect(piecesAt(s, 2.6, 0.2)[0].zf).toBe(1);
    expect(piecesAt(s, 2.6, 0.2)[0].features?.has('outer_wall')).toBe(true);
    expect(piecesAt(s, 1.8, 0.2)).toHaveLength(0);
  });
});
