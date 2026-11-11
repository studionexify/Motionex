// Phase 3: continuous helices, seam elimination and surface passes, interlocking between layers.
import { describe, expect, it } from 'vitest';
import { spiralFill } from '../../src/engine/advanced/eulerian';
import { SCALE } from '../../src/engine/clipper';
import { slice } from '../../src/engine/slicer';
import { resolveConfig } from '../../src/profiles/resolve';
import { cone } from '../fixtures';
import { box, cylinder, dome, indexed, tube } from './shapes';
import type { TechId } from '../../src/engine/advanced/types';

const cfgFor = (printerId: string, overrides = {}) => resolveConfig({ printerId, plate: 'textured_pei_plate', filamentId: 'generic-pla', presetId: '0.20', overrides });
const square = (x0: number, y0: number, s: number) => [{ X: x0 * SCALE, Y: y0 * SCALE }, { X: (x0 + s) * SCALE, Y: y0 * SCALE }, { X: (x0 + s) * SCALE, Y: (y0 + s) * SCALE }, { X: x0 * SCALE, Y: (y0 + s) * SCALE }];
/** Advanced slice with every technology off except the listed ones. */
function adv(mesh: ReturnType<typeof indexed>, printerId: string, on: TechId[], intent: 'aesthetic' | 'structural' = 'aesthetic', overrides = {}, params: Record<string, Record<string, number | boolean>> = {}) {
  const all = ['fea_stress', 'sdf_frep', 'eulerian_spiral', 'conformal_layers', 'hot_on_hot', 'kinematic_extrusion', 'z_weave', 'subvoxel_aa', 'turing_infill', 'corner_overshoot', 'spatial_lattice', 'metamaterial', 'dovetail', 'sgd_slicing', 'eikonal_offsets', 'inverse_warp', 'gloss_modulation', 'foam_control', 'knot_braiding', 'co_molding', 'thick_vase', 'tangent_entry', 'scarf_splice', 'harmonic_dome', 'conformal_ironing', 'perimeter_feathering', 'iso_gloss', 'quasicrystal', 'metric_morph', 'monge_ampere', 'symplectic_shaper', 'morse_router', 'spinor_fields', 'band_gap', 'homogenization'] as TechId[];
  const techs: Record<string, { enabled: boolean; params?: Record<string, number | boolean> }> = Object.fromEntries(all.map((id) => [id, { enabled: on.includes(id) }]));
  for (const [id, p] of Object.entries(params)) techs[id] = { ...techs[id], params: p };
  const out = slice([mesh], cfgFor(printerId, overrides), () => {}, { advanced: { intent, printerId, techs, resolution: 'draft' } });
  const rep = new Map(out.advanced!.techs.map((t) => [t.id, t]));
  return { out, rep };
}
const sane = (g: string) => { expect(g).not.toMatch(/NaN|Infinity|undefined/); };
/** Ran, as designed or adapted to the machine. */
const ran = (st?: string) => expect(['applied', 'adapted']).toContain(st);

describe('Eulerian spiral fill (#3)', () => {
  it('fills a square with one unbroken spiral', () => {
    const paths = spiralFill([square(0, 0, 20)], { spacing: 0.45, width: 0.45, minW: 0.3, maxW: 1.0 });
    expect(paths.length).toBe(1);
    let L = 0;
    const p = paths[0].pts;
    for (let i = 2; i < p.length; i += 2) L += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]);
    // area / spacing ≈ the length of line needed to cover the square
    expect(L).toBeGreaterThan((19.5 * 19.5) / 0.45 * 0.85);
    // ring edges are axis-aligned; anything diagonal is a step inward to the next ring and must be short
    for (let i = 2; i < p.length; i += 2) {
      const dx = Math.abs(p[i] - p[i - 2]), dy = Math.abs(p[i + 1] - p[i - 1]);
      if (dx > 0.01 && dy > 0.01) expect(Math.hypot(dx, dy)).toBeLessThan(1.5);
    }
  });
  it('widens the innermost ring instead of adding gap fill', () => {
    const paths = spiralFill([square(0, 0, 5.3)], { spacing: 0.45, width: 0.45, minW: 0.3, maxW: 1.0 });
    expect(paths.some((p) => p.widths && Math.max(...p.widths) > 0.45)).toBe(true);
    for (const p of paths) for (const w of p.widths ?? []) expect(w).toBeLessThanOrEqual(1.0 + 1e-9);
  });
  it('replaces sparse infill in the slicer', () => {
    const { out, rep } = adv(indexed(box(90, 90, 0, 25, 25, 6), 'b'), 'bbl-p1s', ['eulerian_spiral']);
    ran(rep.get('eulerian_spiral')!.status);
    expect(Number(rep.get('eulerian_spiral')!.stats!.regions)).toBeGreaterThan(5);
    sane(out.gcode);
  });
});

describe('helical thick-vase (#21)', () => {
  it('climbs continuously through every wall and the infill of steady layers', () => {
    const { out, rep } = adv(indexed(tube(100, 100, 15, 3, 20), 'tube'), 'bbl-x1c', ['thick_vase']);
    const r = rep.get('thick_vase')!;
    expect(r.status).toBe('applied');
    expect(Number(r.stats!.helical_layers)).toBeGreaterThan(50);
    // inside a helical layer Z never goes down and spans one layer height
    const L = out.layers[60];
    let last = -Infinity, lo = Infinity, hi = -Infinity;
    for (let i = L.moveStart; i < L.moveEnd; i++) {
      const z = out.moves[i * 8 + 2];
      expect(z).toBeGreaterThanOrEqual(last - 1e-4);
      last = z; lo = Math.min(lo, z); hi = Math.max(hi, z);
    }
    expect(hi - lo).toBeGreaterThan(L.height * 0.8);
    expect(hi - lo).toBeLessThanOrEqual(L.height + 1e-3);
    sane(out.gcode);
  });
  it('removes the retractions between loops', () => {
    // a retraction is a G1 with negative E: alone, or spread over the wipe (Bambu's retract_before_wipe 0 %)
    const count = (g: string) => (g.match(/^G1 [^;\n]*E-/gm) ?? []).length;
    const basic = slice([indexed(tube(100, 100, 15, 3, 20), 'tube')], cfgFor('bbl-x1c'));
    const { out } = adv(indexed(tube(100, 100, 15, 3, 20), 'tube'), 'bbl-x1c', ['thick_vase']);
    expect(count(out.gcode)).toBeLessThan(count(basic.gcode) * 0.6);
  });
});

describe('seam elimination (#22, #23)', () => {
  it('buries the start and end of outer loops on a spiral inside the part', () => {
    const { out, rep } = adv(indexed(box(90, 90, 0, 30, 30, 8), 'b'), 'bbl-p1s', ['tangent_entry']);
    const r = rep.get('tangent_entry')!;
    expect(r.status).toBe('applied');
    expect(Number(r.stats!.loops)).toBeGreaterThan(20);
    expect(Number(r.stats!.merge_angle_deg)).toBeLessThanOrEqual(3.1);
    expect(out.gcode).toContain('; NEXSPIRO_SEAM tangent entry');
    sane(out.gcode);
  });
  it('splices loop ends as complementary wedges with a fan-off re-melt', () => {
    const { out, rep } = adv(indexed(cylinder(100, 100, 12, 8), 'c'), 'bbl-p1s', ['scarf_splice']);
    expect(rep.get('scarf_splice')!.status).toBe('applied');
    expect(out.gcode).toContain('M106 S0 ; scarf re-melt');
    // wedge start lies half a layer under the layer top
    const L = out.layers[20];
    let low = 0;
    for (let i = L.moveStart; i < L.moveEnd; i++) if (out.moves[i * 8 + 2] < L.z - 0.05) low++;
    expect(low).toBeGreaterThan(3);
    sane(out.gcode);
  });
  it('falls back to the scarf where a loop has no room for a buried entry', () => {
    const { rep } = adv(indexed(cylinder(100, 100, 2.5, 6), 'pin'), 'bbl-p1s', ['tangent_entry', 'scarf_splice']);
    expect(rep.get('scarf_splice')!.status).toBe('applied');
  });
});

describe('surface passes (#8, #26, #25)', () => {
  it('anti-aliases walls under shallow slopes', () => {
    const { out, rep } = adv(indexed(dome(100, 100, 20, 8, 4), 'd'), 'bbl-x1c', ['subvoxel_aa']);
    ran(rep.get('subvoxel_aa')!.status);
    expect(Number(rep.get('subvoxel_aa')!.stats!.contoured_points)).toBeGreaterThan(50);
    expect(out.advanced!.clearance!.unresolved).toBe(0);
  });
  it('feathers outer walls on rounded sides', () => {
    const { rep } = adv(indexed(cone(100, 100, 15, 5, 12), 'cone'), 'bbl-x1c', ['perimeter_feathering']);
    ran(rep.get('perimeter_feathering')!.status);
    expect(Number(rep.get('perimeter_feathering')!.stats!.feathered_points)).toBeGreaterThan(100);
  });
  it('burnishes a gentle dome along its true surface within the head clearance', () => {
    const { out, rep } = adv(indexed(dome(100, 100, 20, 8, 2.5), 'd'), 'bbl-x1c', ['conformal_ironing']);
    const r = rep.get('conformal_ironing')!;
    ran(r.status);
    expect(Number(r.stats!.passes)).toBeGreaterThan(5);
    expect(out.gcode).toContain('; NexSpiro conformal ironing');
    sane(out.gcode);
  });
});

describe('interlocking (#7, #19)', () => {
  it('weaves inner walls and infill with an alternating Z wave and drives Z-pins into the core', () => {
    const { out, rep } = adv(indexed(box(90, 90, 0, 30, 30, 12), 'b'), 'bbl-x1c', ['z_weave'], 'structural', {}, { z_weave: { pins: true } }); // pins are opt-in
    const r = rep.get('z_weave')!;
    expect(r.status).toBe('adapted'); // Z-axis limits on the X1C
    expect(Number(r.stats!.woven_points)).toBeGreaterThan(1000);
    expect(Number(r.stats!.z_pins)).toBeGreaterThan(0);
    expect(out.gcode).toContain('G4 P300 ; let the pin settle');
    sane(out.gcode);
  });
  it('braids two inner walls (needs ≥ 3 walls)', () => {
    const { out, rep } = adv(indexed(cylinder(100, 100, 12, 8), 'c'), 'bbl-x1c', ['knot_braiding'], 'structural', { wall_loops: 4 });
    const r = rep.get('knot_braiding')!;
    expect(r.status).toBe('applied');
    expect(Number(r.stats!.braided_loops)).toBeGreaterThan(20);
    sane(out.gcode);
  });
  it('reports braiding as unavailable with two walls', () => {
    const { rep } = adv(indexed(cylinder(100, 100, 12, 4), 'c'), 'bbl-x1c', ['knot_braiding'], 'structural');
    expect(rep.get('knot_braiding')!.status).toBe('unavailable');
  });
});

describe('Seamless Aesthetic, all Phase 1–3 technologies together', () => {
  it('compiles a domed vase-like part on A1/P1/X1, Klipper and Marlin machines', () => {
    for (const id of ['bbl-a1', 'voron-24-350', 'prusa-mk4s']) {
      const out = slice([indexed(dome(100, 100, 16, 18, 6), 'silo')], cfgFor(id), () => {}, { advanced: { intent: 'aesthetic', printerId: id, techs: {}, resolution: 'draft' } });
      sane(out.gcode);
      const applied = out.advanced!.techs.filter((t) => t.status === 'applied' || t.status === 'adapted').map((t) => t.id);
      expect(applied).toEqual(expect.arrayContaining(['harmonic_dome', 'eikonal_offsets', 'thick_vase']));
      // a handful of points near the curved dome top may stay reported (≤ 0.2 % of the checked points,
      // under a quarter millimetre): they are listed as a warning, never printed silently
      const c = out.advanced!.clearance!;
      expect(c.unresolved).toBeLessThanOrEqual(c.checked * 0.002);
      expect(c.worstLeft).toBeLessThan(0.25);
      if (c.unresolved) expect(out.warnings.join(' ')).toContain('may touch the print');
    }
  });
});
