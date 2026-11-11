// Phase 1: machine capability model, implicit field ingestion, surface fields, zones, Advanced slicing.
import { describe, expect, it } from 'vitest';
import { meshSdf, pointTriDist2, eikonalUpdate } from '../../src/engine/advanced/sdf';
import { machineCaps, clearanceSlope } from '../../src/engine/advanced/machine';
import { analyzePart, topology, toObjectAnalysis } from '../../src/engine/advanced/analysis';
import { surfaceFields } from '../../src/engine/advanced/meshfields';
import { TriGrid } from '../../src/engine/advanced/raycast';
import { TECHS, resolveTechs } from '../../src/engine/advanced/techs';
import { zoneIndex } from '../../src/engine/advanced/types';
import { slice } from '../../src/engine/slicer';
import { resolveConfig } from '../../src/profiles/resolve';
import { PRINTERS } from '../../src/profiles/printers';
import { defaultToolhead } from '../../src/plugins/motionex/core/toolhead';
import { box, bracket, cylinder, dome, indexed, sphere, tube } from './shapes';

const cfgFor = (printerId: string, overrides = {}) =>
  resolveConfig({ printerId, plate: 'textured_pei_plate', filamentId: 'generic-pla', presetId: '0.20', overrides });
const params = { cells: 48, shell: 0.87, lineWidth: 0.42, layerHeight: 0.2, overhangDeg: 30 };

describe('technology registry', () => {
  it('has all 35 technologies, numbered 1–35 with unique ids', () => {
    expect(TECHS.length).toBe(35);
    expect(TECHS.map((t) => t.n)).toEqual(Array.from({ length: 35 }, (_, i) => i + 1));
    expect(new Set(TECHS.map((t) => t.id)).size).toBe(35);
    for (const t of TECHS) for (const p of t.params) expect(p.def).not.toBeUndefined();
  });
  it('turns technologies on per intent and adapts them to the machine', () => {
    const caps = machineCaps('bbl-x1c', cfgFor('bbl-x1c'));
    const ctx = { caps, filamentType: 'PLA', materials: 1, wallLoops: 2, hasCaustic: false };
    const aesthetic = resolveTechs({ intent: 'aesthetic', printerId: 'bbl-x1c', techs: {} }, ctx);
    const on = (id: string) => aesthetic.find((r) => r.def.id === id)!;
    expect(on('thick_vase').enabled).toBe(true);
    expect(on('quasicrystal').enabled).toBe(false);
    expect(on('harmonic_dome').verdict.status).toBe('adapted'); // limited by the A1/P1/X1 heater block
    expect(on('symplectic_shaper').verdict.status).toBe('adapted'); // firmware already shapes
    expect(on('knot_braiding').verdict.status).toBe('unavailable'); // two walls only
    const foam = resolveTechs({ intent: 'acoustic', printerId: 'bbl-x1c', techs: {} }, ctx).find((r) => r.def.id === 'foam_control')!;
    expect(foam.verdict.status).toBe('unavailable'); // PLA does not foam
    // user override wins over the intent default
    const forced = resolveTechs({ intent: 'aesthetic', printerId: 'bbl-x1c', techs: { quasicrystal: { enabled: true, params: { spacing: 7 } } } }, ctx).find((r) => r.def.id === 'quasicrystal')!;
    expect(forced.enabled).toBe(true);
    expect(forced.params.spacing).toBe(7);
  });
});

describe('machine capability model', () => {
  it('derives a capability profile for every printer', () => {
    for (const p of PRINTERS) {
      const c = machineCaps(p.id, cfgFor(p.id));
      expect(c.axes).toBe(3);
      expect(c.maxSlopeDeg).toBeGreaterThan(3);
      expect(c.maxSlopeDeg).toBeLessThan(60);
      expect(c.maxFlow).toBeGreaterThan(5);
      expect(['corexy', 'cartesian', 'bedslinger', 'delta']).toContain(c.kinematics);
    }
  });
  it('knows firmware features and chambers', () => {
    expect(machineCaps('bbl-x1e', cfgFor('bbl-x1e')).heatedChamber).toBe(true);
    expect(machineCaps('bbl-p1p', cfgFor('bbl-p1p')).enclosed).toBe(false);
    expect(machineCaps('creality-ender3v2', cfgFor('creality-ender3v2')).inputShaper).toBe(false);
    expect(machineCaps('bbl-a1', cfgFor('bbl-a1')).kinematics).toBe('bedslinger');
  });
  it('limits curved layers by the heater block, and lifts the limit for rotary axes', () => {
    const head = defaultToolhead('bbl-x1c');
    const { maxSlopeDeg } = clearanceSlope(head);
    // heater block 14×16 mm, 2.2 mm above the tip: atan(2.0 / 10.6) ≈ 10.7°
    expect(maxSlopeDeg).toBeGreaterThan(9);
    expect(maxSlopeDeg).toBeLessThan(13);
    const longer = machineCaps('bbl-x1c', cfgFor('bbl-x1c'), { tipLength: 8 });
    expect(longer.maxSlopeDeg).toBeGreaterThan(maxSlopeDeg);
    const fiveAxis = machineCaps('generic-klipper', cfgFor('generic-klipper'), { kinematics: 'five_axis_ac' });
    expect(fiveAxis.axes).toBe(5);
    expect(fiveAxis.maxSlopeDeg).toBeGreaterThan(60);
  });
});

describe('implicit field ingestion (SDF)', () => {
  it('point–triangle distance and the Eikonal update are exact on simple cases', () => {
    expect(Math.sqrt(pointTriDist2(0.2, 0.2, 3, 0, 0, 0, 1, 0, 0, 0, 1, 0))).toBeCloseTo(3, 9);
    expect(Math.sqrt(pointTriDist2(-2, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0))).toBeCloseTo(2, 9);
    expect(eikonalUpdate(1, Infinity, Infinity, 0.5)).toBeCloseTo(1.5, 9);
    // two equal neighbours: diagonal front, (2a + √(2h²)) / 2
    expect(eikonalUpdate(1, 1, Infinity, 1)).toBeCloseTo(1 + Math.SQRT1_2, 9);
  });
  it('matches the analytic distance of a sphere', () => {
    const m = indexed(sphere(0, 0, 10, 10, 64, 32));
    const { sdf } = meshSdf(m, 48);
    for (const [x, y, z] of [[0, 0, 10], [3, 2, 9], [0, 0, 21], [10.8, 0, 10], [5, 5, 15], [0, -10.5, 7], [0, 9.5, 10]]) {
      const exact = Math.hypot(x, y, z - 10) - 10;
      // exact distances near the surface; first-order fast sweeping deeper inside (≲ 8 % of the depth)
      const tol = Math.abs(exact) < 1.5 ? 0.2 : 0.08 * Math.abs(exact);
      expect(Math.abs(sdf.sample(x, y, z) - exact)).toBeLessThan(tol);
    }
    expect(sdf.sample(0, 0, 10)).toBeLessThan(-9);
  });
  it('signs a box correctly and gives unit gradients', () => {
    const m = indexed(box(0, 0, 0, 20, 10, 6));
    const { sdf, inside } = meshSdf(m, 40);
    expect(sdf.sample(10, 5, 3)).toBeCloseTo(-3, 0);
    expect(sdf.sample(10, 5, 7)).toBeCloseTo(1, 0);
    const vol = inside.reduce((s, v) => s + v, 0) * sdf.h ** 3;
    expect(Math.abs(vol - 1200) / 1200).toBeLessThan(0.1);
    const g = sdf.gradient(10, 5, 6.5);
    expect(Math.hypot(...g)).toBeCloseTo(1, 1);
    expect(g[2]).toBeGreaterThan(0.9);
  });
});

describe('surface fields', () => {
  it('curvature of a sphere is 1/R (mean) and 1/R² (Gaussian)', () => {
    const f = surfaceFields(indexed(sphere(0, 0, 0, 5, 64, 32)));
    const mid = Array.from(f.meanCurv).sort((a, b) => a - b)[Math.floor(f.triCount / 2)];
    expect(mid).toBeCloseTo(0.2, 1);
    let kSum = 0, aSum = 0;
    for (let t = 0; t < f.triCount; t++) { kSum += f.gaussCurv[t] * f.area[t]; aSum += f.area[t]; }
    // Gauss–Bonnet: ∫K dA = 4π
    expect(kSum).toBeCloseTo(4 * Math.PI, 0);
    expect(aSum).toBeCloseTo(4 * Math.PI * 25, -1);
  });
  it('measures wall thickness through the part', () => {
    const f = surfaceFields(indexed(tube(0, 0, 20, 2, 30)));
    const side = Array.from(f.thickness).filter((_, t) => Math.abs(f.normal[t * 3 + 2]) < 0.1);
    const med = side.sort((a, b) => a - b)[Math.floor(side.length / 2)];
    expect(med).toBeCloseTo(2, 1);
  });
  it('ray casts find the top of a part', () => {
    const g = new TriGrid(indexed(dome(0, 0, 20, 10, 8)));
    expect(g.topAt(0, 0)).toBeCloseTo(18, 1);
    expect(g.topAt(30, 0)).toBe(-Infinity);
  });
  it('topology: a sphere has genus 0, a torus-like tube genus 1', () => {
    expect(topology(indexed(sphere(0, 0, 0, 5)))).toEqual([1, 0]);
    expect(topology(indexed(tube(0, 0, 10, 3, 5)))).toEqual([1, 1]);
  });
});

describe('zone router', () => {
  it('finds domes, helical bands and bosses', () => {
    const silo = analyzePart(indexed(dome(50, 50, 20, 30, 10)) as any, params);
    const share = (a: typeof silo, k: Parameters<typeof zoneIndex>[0]) => {
      let s = 0, all = 0;
      for (let t = 0; t < a.surf.triCount; t++) { all += a.surf.area[t]; if (a.triZone[t] === zoneIndex(k)) s += a.surf.area[t]; }
      return s / all;
    };
    expect(share(silo, 'dome')).toBeGreaterThan(0.1);
    expect(share(silo, 'helical')).toBeGreaterThan(0.2);
    expect(silo.sections.helical.length).toBeGreaterThan(0);
    const ring = analyzePart(indexed(tube(50, 50, 15, 11, 8)) as any, params);
    expect(ring.bosses.length).toBe(1);
    expect(ring.bosses[0].r).toBeCloseTo(4, 0);
    expect(share(ring, 'boss')).toBeGreaterThan(0.05);
  });
  it('finds the neck of a bracket and its core volume', () => {
    const a = analyzePart(indexed(bracket(50, 50)) as any, params);
    expect(a.sections.necks.length).toBeGreaterThan(0);
    const [z0, z1] = a.sections.necks[0];
    expect(z0).toBeGreaterThan(5);
    expect(z1).toBeLessThan(17);
    expect(a.zones.find((z) => z.kind === 'core')!.volumeMm3).toBeGreaterThan(500);
    const o = toObjectAnalysis('b', 'bracket', a);
    expect(o.triZone.length).toBe(a.surf.triCount);
    expect(o.voxels.length % 4).toBe(0);
    expect(o.ranges.thickness![1]).toBeGreaterThan(o.ranges.thickness![0]);
  });
});

describe('Advanced slicing', () => {
  it('slices with every intent and reports zones, machine and technologies', () => {
    for (const intent of ['structural', 'aesthetic', 'optical', 'acoustic', 'morph4d'] as const) {
      const out = slice([indexed(dome(100, 100, 15, 12, 6), 'silo')], cfgFor('bbl-x1c'), () => {}, { advanced: { intent, printerId: 'bbl-x1c', techs: {}, resolution: 'draft' } });
      expect(out.gcode).toContain('; NexSpiro Advanced engine: intent=' + intent);
      expect(out.advanced).toBeDefined();
      expect(out.advanced!.techs.length).toBe(35);
      expect(out.advanced!.zones.some((z) => z.kind === 'dome')).toBe(true);
      expect(out.advanced!.machine.name).toBe('Bambu Lab X1 Carbon');
      // 4D Flat-Morph prints the part as a flat sheet (metric morph) by design
      expect(out.layers.length).toBeGreaterThan(intent === 'morph4d' ? 3 : 50);
    }
  });
  it('runs on Klipper and Marlin machines too', () => {
    for (const id of ['voron-24-350', 'prusa-mk4s', 'creality-ender3v2']) {
      const out = slice([indexed(cylinder(100, 100, 10, 10), 'c')], cfgFor(id), () => {}, { advanced: { intent: 'structural', printerId: id, techs: {}, resolution: 'draft' } });
      expect(out.advanced!.machine.firmware).toBe(PRINTERS.find((p) => p.id === id)!.flavor);
      expect(out.gcode).toMatch(/G1 X[\d.]+ Y[\d.]+ E[\d.]+/);
    }
  });
});
