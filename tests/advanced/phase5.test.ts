// Phase 5: rheology, kinematics, the Morse–Smale router and end-to-end compiles on every printer family.
import { describe, expect, it } from 'vitest';
import { slice } from '../../src/engine/slicer';
import { resolveConfig } from '../../src/profiles/resolve';
import { box, cylinder, dome, indexed } from './shapes';
import { adv, paintBy, ran, sane } from './helpers';
import { planLayer } from '../../src/engine/advanced/planner';
import { periodAccel, ringing } from '../../src/engine/advanced/modules/motion';
import { wallShear } from '../../src/engine/advanced/modules/rheology';
import { reebGraph } from '../../src/engine/advanced/modules/morse';
import { analyzePart } from '../../src/engine/advanced/analysis';
import type { LayerOps } from '../../src/engine/advanced/classic/gcode';
import type { IntentId } from '../../src/engine/advanced/types';

const cfgFor = (printerId: string, overrides = {}) => resolveConfig({ printerId, plate: 'textured_pei_plate', filamentId: 'generic-pla', presetId: '0.20', overrides });
const mv = (x: number, y: number, f = 100) => ({ k: 'move' as const, x, y, z: 0.2, e: 0.01, f, feature: 'outer_wall' as const, w: 0.42, h: 0.2, travel: false });

describe('motion planner (#6)', () => {
  it('slows to the junction speed at a right angle and accelerates on straights', () => {
    const L: LayerOps = { z: 0.2, h: 0.2, fan: 0, ops: [{ ...mv(0, 0), travel: true, e: 0 }, mv(50, 0), mv(50, 50)] };
    const p = planLayer(L, 5000, 5);
    // corner exit speed close to the square-corner velocity
    expect(p[0].vOut).toBeGreaterThan(4);
    expect(p[0].vOut).toBeLessThan(8);
    expect(p[0].vMax).toBeCloseTo(100, 0);
    expect(p[1].vOut).toBe(0);
  });
});

describe('symplectic shaper (#31)', () => {
  it('an acceleration lasting whole resonance periods leaves (almost) no ringing', () => {
    const f = 50, v = 200, a = 7000;
    const r0 = ringing(a, v / a, f);
    const pa = periodAccel(v, a, f);
    expect(pa.a).toBeLessThanOrEqual(a);
    const r1 = ringing(pa.a, v / pa.a, f);
    expect(r1).toBeLessThan(r0 * 0.3);
  });
  it('retimes accelerations on a machine without input shaping', () => {
    const { out, rep } = adv(indexed(box(80, 80, 0, 30, 30, 5), 'b'), 'creality-ender3v2', ['symplectic_shaper'], 'aesthetic');
    const r = rep.get('symplectic_shaper')!;
    console.log('shaper', r.stats);
    ran(r.status);
    sane(out.gcode);
  });
  it('does not double-shape on X1-class firmware (firmware input shaper)', () => {
    const { rep } = adv(indexed(box(80, 80, 0, 30, 30, 5), 'b'), 'bbl-x1c', ['symplectic_shaper'], 'aesthetic');
    expect(rep.get('symplectic_shaper')!.status).toBe('adapted');
    expect(String(rep.get('symplectic_shaper')!.stats!.firmware_shaper)).toContain('no double');
  });
});

describe('kinematic extrusion (#6) and corner overshoot (#10)', () => {
  it('software pressure advance where the firmware has none', () => {
    const { rep } = adv(indexed(box(80, 80, 0, 30, 30, 4), 'b'), 'creality-ender3v2', ['kinematic_extrusion'], 'aesthetic');
    const r = rep.get('kinematic_extrusion')!;
    ran(r.status);
    expect(Number(r.stats!.flow_adjusted_moves)).toBeGreaterThan(50);
    expect(Number(r.stats!.slow_corners)).toBeGreaterThan(10);
  });
  it('swings past sharp outer corners', () => {
    const tri = indexed(cylinder(100, 100, 12, 6, 3), 'tri');
    const { out, rep } = adv(tri, 'creality-ender3v2', ['corner_overshoot'], 'aesthetic');
    const r = rep.get('corner_overshoot')!;
    ran(r.status);
    expect(Number(r.stats!.corners)).toBeGreaterThan(20);
    sane(out.gcode);
  });
});

describe('gloss (#27, #17) and hot-on-hot (#5)', () => {
  it('power-law wall shear grows with flow as Qⁿ', () => {
    expect(wallShear(20, 0.2) / wallShear(10, 0.2)).toBeCloseTo(2 ** 0.35, 5);
  });
  it('iso-gloss keeps one outer-wall speed on every layer', () => {
    const { out, rep } = adv(indexed(cylinder(100, 100, 4, 15), 'pin'), 'bbl-x1c', ['iso_gloss'], 'aesthetic');
    ran(rep.get('iso_gloss')!.status);
    const v = new Set<number>();
    for (const k of [10, 30, 60]) for (let i = out.layers[k].moveStart; i < out.layers[k].moveEnd; i++) if (out.moveFeatures[i] === 0 && out.moves[i * 8 + 3] > 0) v.add(Math.round(out.moves[i * 8 + 5]));
    expect(v.size).toBe(1);
  });
  it('modulates the outer wall where matte and gloss are painted', () => {
    const m = indexed(box(80, 80, 0, 30, 30, 10), 'b') as any;
    m.paint = { adv: paintBy(m, (x) => (x < 95 ? 3 : 4)) };
    const { rep } = adv(m, 'bbl-x1c', ['gloss_modulation'], 'optical');
    const r = rep.get('gloss_modulation')!;
    ran(r.status);
    expect(Number(r.stats!.matte_shear_kPa)).toBeGreaterThan(Number(r.stats!.gloss_shear_kPa));
  });
  it('cuts the fan to keep the layer below hot for the bond', () => {
    const { rep } = adv(indexed(box(80, 80, 0, 40, 40, 6), 'b'), 'bbl-x1c', ['hot_on_hot'], 'structural');
    const r = rep.get('hot_on_hot')!;
    console.log('hoh', r.stats);
    ran(r.status);
    expect(Number(r.stats!.fan_reduced_layers)).toBeGreaterThan(5);
  });
});

describe('Morse–Smale router (#32)', () => {
  it('finds the branches of a two-tower part joined by a bridge', () => {
    const soup = new Float32Array([...box(60, 60, 0, 10, 10, 20), ...box(90, 60, 0, 10, 10, 20), ...box(60, 60, 20, 40, 10, 5), ...box(75, 60, 25, 10, 10, 10)]);
    const m = indexed(soup, 'arch');
    const a = analyzePart(m as any, { cells: 40, shell: 0.9, lineWidth: 0.45, layerHeight: 0.2, overhangDeg: 30 });
    const g = reebGraph(a, 1.5);
    // two legs born on the bed, merged under the bridge, one tower on top
    expect(g.branches.filter((b) => b.birth === 'bed').length).toBe(2);
    expect(g.saddles).toBeGreaterThanOrEqual(1);
    const { rep } = adv(m, 'bbl-x1c', ['morse_router'], 'structural');
    ran(rep.get('morse_router')!.status);
    expect(Number(rep.get('morse_router')!.stats!.branches)).toBeGreaterThanOrEqual(2);
  });
  it('routes a branch born in mid-air to support on a 3-axis printer', () => {
    // a T: the overhanging arm starts as a separate island? no — a mushroom cap born mid-air over a slot
    const soup = new Float32Array([...box(60, 60, 0, 10, 10, 10), ...box(80, 60, 6, 10, 10, 4), ...box(60, 60, 10, 30, 10, 4)]);
    const { rep } = adv(indexed(soup, 'hook'), 'bbl-x1c', ['morse_router'], 'structural');
    expect(String(rep.get('morse_router')!.stats!.routes)).toContain('support');
  });
});

describe('end to end: every intent on every printer family', () => {
  const printers = ['bbl-x1c', 'bbl-a1', 'bbl-h2d', 'voron-24-350', 'prusa-mk4s', 'creality-ender3v2'];
  const intents: IntentId[] = ['structural', 'aesthetic', 'optical', 'acoustic', 'morph4d'];
  for (const p of printers) it(`${p}`, () => {
    for (const intent of intents) {
      const out = slice([indexed(dome(110, 110, 14, 8, 4), 'part') as any], cfgFor(p), () => {}, { advanced: { intent, printerId: p, techs: {}, resolution: 'draft' } });
      sane(out.gcode);
      const rep = out.advanced!;
      expect(rep.techs.length).toBe(35);
      // no technology silently missing from the engine build
      expect(rep.techs.filter((t) => t.reason === 'Not part of this engine build.').map((t) => t.id)).toEqual([]);
      if (rep.clearance) expect(rep.clearance.unresolved / Math.max(1, rep.clearance.checked)).toBeLessThan(0.01);
      expect(out.gcode).toMatch(/G1 X[\d.]+ Y[\d.]+ (Z[\d.]+ )?E[\d.]+/);
    }
  }, 240000);
});
