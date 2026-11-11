// Phase 4: field solvers and lattices — FEA stress paths and spinor frames, reaction–diffusion,
// quasicrystal, band-gap and homogenized cells, foam, inverse warp, lattices, dovetails, co-molding,
// metric morphing and caustic lenses.
import { describe, expect, it } from 'vitest';
import { slice } from '../../src/engine/slicer';
import { box, indexed } from './shapes';
import { adv, cfgFor, layerAt, paintBy, ran, sane, segments, type Mesh } from './helpers';

describe('FEA stress-aligned paths (#1) and spinor frames (#33)', () => {
  it('follows the bending stress of a painted cantilever', () => {
    const m: Mesh = indexed(box(70, 95, 0, 60, 10, 10), 'beam');
    m.paint = { adv: paintBy(m, (x) => (x < 70.01 ? 1 : x > 129.99 ? 2 : 0)) };
    const t0 = performance.now();
    const { out, rep } = adv(m, 'bbl-x1c', ['fea_stress', 'spinor_fields'], 'structural', { params: { fea_stress: { threshold: 0, family: 'max' } } });
    const ms = performance.now() - t0;
    const r = rep.get('fea_stress')!;
    console.log('fea', r.stats, rep.get('spinor_fields')!.stats, Math.round(ms));
    ran(r.status);
    expect(String(r.stats!.load)).toContain('painted');
    expect(Number(r.stats!.streamlines)).toBeGreaterThan(20);
    ran(rep.get('spinor_fields')!.status);
    // upper fibres are in tension along the beam, so the tension trajectories run along x
    let along = 0, total = 0;
    for (const [x0, y0, x1, y1] of segments(out, layerAt(out, 8), 'sparse_infill')) { const l = Math.hypot(x1 - x0, y1 - y0); total += l; along += Math.abs(x1 - x0); }
    expect(total).toBeGreaterThan(50);
    expect(along / total).toBeGreaterThan(0.85);
    sane(out.gcode);
  });
});

import { orientQuasicrystal, fibonacci } from '../../src/engine/advanced/modules/quasicrystal';
import { designBandGap } from '../../src/engine/advanced/modules/bandGap';

describe('quasicrystal infill (#28)', () => {
  it('puts a five-fold axis up: five printable families at 26.6°, isotropic in the layer', () => {
    const o = orientQuasicrystal(45);
    expect(o.normals.length).toBe(5);
    expect(Math.max(...o.tilts)).toBeCloseTo(26.57, 0);
    expect(o.aniso).toBeLessThan(0.02);
  });
  it('spaces planes as a Fibonacci chain (gaps 1 and τ)', () => {
    const gaps = new Set<string>();
    for (let n = 0; n < 50; n++) gaps.add((fibonacci(n + 1, 0.3) - fibonacci(n, 0.3)).toFixed(6));
    expect([...gaps].sort()).toEqual(['1.000000', '1.618034']);
  });
  it('fills the core of a block', () => {
    const { out, rep } = adv(indexed(box(80, 80, 0, 40, 40, 20), 'blk'), 'bbl-x1c', ['quasicrystal']);
    ran(rep.get('quasicrystal')!.status);
    expect(Number(rep.get('quasicrystal')!.stats!.lines)).toBeGreaterThan(100);
    sane(out.gcode);
  });
});

describe('Gray–Scott Turing infill (#9)', () => {
  it('grows ribs and keeps them from layer to layer', () => {
    const { out, rep } = adv(indexed(box(80, 80, 0, 40, 40, 12), 'blk'), 'bbl-x1c', ['turing_infill']);
    const r = rep.get('turing_infill')!;
    console.log('turing', r.stats, r.ms);
    ran(r.status);
    expect(Number(r.stats!.ribs)).toBeGreaterThan(50);
    // consecutive layers print nearly the same ribs (Z continuation)
    const a = segments(out, layerAt(out, 6), 'sparse_infill'), b = segments(out, layerAt(out, 6.2), 'sparse_infill');
    const la = a.reduce((t, s) => t + Math.hypot(s[2] - s[0], s[3] - s[1]), 0), lb = b.reduce((t, s) => t + Math.hypot(s[2] - s[0], s[3] - s[1]), 0);
    expect(la).toBeGreaterThan(100);
    expect(Math.abs(la - lb) / la).toBeLessThan(0.15);
    sane(out.gcode);
  });
});

describe('metamaterial, band gap and homogenization (#12, #34, #35)', () => {
  it('designs a resonator lattice whose gap holds the target frequency', () => {
    const d = designBandGap(800, 0.45, false)!;
    console.log(d);
    expect(d.inGap).toBe(true);
    expect(d.chern).toBe(0);
  });
  it('acoustic intent: band-gap core, graded auxetic cells, homogenized design', () => {
    const { out, rep } = adv(indexed(box(70, 70, 0, 60, 60, 10), 'pad'), 'bbl-x1c', ['band_gap', 'metamaterial', 'homogenization'], 'acoustic', { params: { homogenization: { targetNu: -0.5 } } });
    for (const id of ['band_gap', 'metamaterial', 'homogenization'] as const) { console.log(id, rep.get(id)!.stats, rep.get(id)!.ms); ran(rep.get(id)!.status); }
    expect(Number(rep.get('homogenization')!.stats!.poisson_homogenized)).toBeLessThan(0);
    expect(Number(rep.get('band_gap')!.stats!.resonators)).toBeGreaterThan(0);
    sane(out.gcode);
  });
});

import { dovetailRegions } from '../../src/engine/advanced/modules/dovetail';
import { designLens, sinkhornMap } from '../../src/engine/advanced/modules/mongeAmpere';
import { directorAngle } from '../../src/engine/advanced/modules/metricMorph';
import { SCALE, areaTotal } from '../../src/engine/clipper';
import { dome, tube } from './shapes';

const sq = (x0: number, y0: number, x1: number, y1: number) => [{ X: x0 * SCALE, Y: y0 * SCALE }, { X: x1 * SCALE, Y: y0 * SCALE }, { X: x1 * SCALE, Y: y1 * SCALE }, { X: x0 * SCALE, Y: y1 * SCALE }];

describe('foam control (#18)', () => {
  it('is unavailable without a foaming filament', () => {
    const { rep } = adv(indexed(box(80, 80, 0, 30, 30, 10), 'b'), 'bbl-x1c', ['foam_control']);
    expect(rep.get('foam_control')!.status).toBe('unavailable');
  });
  it('schedules hub/core temperatures ahead and scales flow by the predicted expansion', () => {
    const { out, rep } = adv(indexed(box(70, 70, 0, 70, 70, 8), 'b'), 'bbl-x1c', ['foam_control'], 'acoustic', { filamentId: 'generic-lw-pla' });
    const r = rep.get('foam_control')!;
    console.log('foam', r.stats);
    ran(r.status);
    expect(Number(r.stats!.setpoint_changes)).toBeGreaterThan(4);
    expect(out.gcode).toContain('M104 S250 ; NexSpiro foam look-ahead');
    expect(Number(r.stats!.mean_flow_scale)).toBeLessThan(0.9);
    sane(out.gcode);
  });
});

describe('inverse warp (#16)', () => {
  it('predicts ABS shrink, pre-distorts outward and cuts kerfs', () => {
    const { out, rep } = adv(indexed(box(60, 90, 0, 80, 20, 8), 'bar'), 'bbl-p1s', ['inverse_warp'], 'structural', { filamentId: 'generic-abs' });
    const r = rep.get('inverse_warp')!;
    console.log('warp', r.stats, r.ms);
    ran(r.status);
    expect(Number(r.stats!.predicted_max_xy_mm)).toBeGreaterThan(0.05);
    expect(Number(r.stats!.kerfs)).toBeGreaterThan(0);
    // the bar's far end is printed beyond its CAD length (compensating the shrink toward the middle)
    let maxX = 0;
    const L = out.layers[layerAt(out, 6)];
    for (let i = L.moveStart; i < L.moveEnd; i++) if (out.moves[i * 8 + 3] > 0) maxX = Math.max(maxX, out.moves[i * 8]);
    expect(maxX).toBeGreaterThan(140 + 0.05);
    sane(out.gcode);
  });
});

describe('spatial lattice (#11)', () => {
  it('replaces the part with a truss whose cells fit under the nozzle tip', () => {
    const { out, rep } = adv(indexed(box(80, 80, 0, 30, 30, 20), 'b'), 'bbl-x1c', ['spatial_lattice']);
    const r = rep.get('spatial_lattice')!;
    console.log('lattice', r.stats);
    ran(r.status);
    expect(Number(r.stats!.posts)).toBeGreaterThan(20);
    expect(out.gcode).toContain('strand freezes');
    sane(out.gcode);
  });
});

describe('dovetail (#13)', () => {
  it('interleaves two materials across their boundary, flipping each layer', () => {
    const A = [sq(0, 0, 10, 20)], B = [sq(10, 0, 20, 20)];
    const l0 = dovetailRegions([{ fil: 0, paths: A }, { fil: 1, paths: B }], 1, 1.2, 3);
    const l1 = dovetailRegions([{ fil: 0, paths: A }, { fil: 1, paths: B }], 2, 1.2, 3);
    expect(l0.fingers).toBeGreaterThan(4);
    // total area is preserved, and material 0 now reaches past x = 10
    expect(Math.abs(areaTotal(l0.regions[0].paths) + areaTotal(l0.regions[1].paths) - 400)).toBeLessThan(1);
    const maxX = (ps: typeof A) => Math.max(...ps.flat().map((q) => q.X / SCALE));
    expect(maxX(l0.regions[0].paths)).toBeGreaterThan(10.5);
    // the next layer is the complementary pattern
    expect(Math.abs(areaTotal(l0.regions[0].paths) - areaTotal(l1.regions[0].paths))).toBeLessThan(1.5);
  });
  it('needs automatic material changes', () => {
    const { rep } = adv(indexed(box(80, 80, 0, 30, 30, 10), 'b'), 'creality-ender3v3ke', ['dovetail']);
    expect(rep.get('dovetail')!.status).toBe('unavailable');
  });
});

describe('co-molding (#20)', () => {
  it('hollows a block into a shell with columns, sprue and vent', () => {
    const { out, rep } = adv(indexed(box(80, 80, 0, 40, 40, 20), 'b'), 'bbl-x1c', ['co_molding']);
    const r = rep.get('co_molding')!;
    console.log('mold', r.stats);
    ran(r.status);
    expect(Number(r.stats!.columns)).toBeGreaterThan(2);
    expect(Number(r.stats!.cavity_layers)).toBeGreaterThan(30);
    // far less plastic than the solid block
    const basic = slice([indexed(box(80, 80, 0, 40, 40, 20), 'b')], cfgFor('bbl-x1c', { sparse_infill_density: 100 }));
    expect(out.stats.filamentMm).toBeLessThan(basic.stats.filamentMm * 0.6);
    sane(out.gcode);
  });
});

describe('metric morph (#29)', () => {
  it('bead angle reaches the needed shrink ratio', () => {
    const d = directorAngle(0.8, 0.7);
    expect(d.reached).toBe(true);
    const lp = 1 / Math.sqrt(0.7), a = d.alpha;
    const rho = (0.7 * Math.cos(a) ** 2 + lp * Math.sin(a) ** 2) / (0.7 * Math.sin(a) ** 2 + lp * Math.cos(a) ** 2);
    expect(rho).toBeCloseTo(0.8, 4);
  });
  it('prints a dome as a flat sheet', () => {
    const { out, rep } = adv(indexed(dome(100, 100, 25, 2, 10), 'd'), 'bbl-x1c', ['metric_morph'], 'morph4d');
    const r = rep.get('metric_morph')!;
    console.log('morph', r.stats);
    ran(r.status);
    expect(out.layers.length).toBe(4);
    expect(Number(r.stats!.streamlines)).toBeGreaterThan(20);
    sane(out.gcode);
  });
});

describe('Monge–Ampère lens (#30)', () => {
  it('transport map moves light towards the bright half', () => {
    const n = 24, mu = new Float64Array(n * n).fill(1 / (n * n)), nu = new Float64Array(n * n);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) nu[i + n * j] = i >= n / 2 ? 1 : 0.01;
    const s = nu.reduce((a, b) => a + b, 0);
    const { T } = sinkhornMap(mu, nu.map((v) => v / s), n, 1, 200);
    // the left column maps far right
    expect(T[(0 + n * 12) * 2]).toBeGreaterThan(n / 2 - 3);
  });
  it('carves a lens into the top of a slab', () => {
    const img = { width: 8, height: 8, pixels: Array.from({ length: 64 }, (_, k) => ((k % 8) < 4 ? 1 : 0)), throwMm: 300, mode: 'lens' as const };
    const L = designLens(img, 0, 0, 40, 1.5, 200, 32);
    expect(L.maxH).toBeGreaterThan(0.2);
    const { out, rep } = adv(indexed(box(80, 80, 0, 40, 40, 6), 'slab'), 'bbl-x1c', ['monge_ampere'], 'optical', { extra: { caustic: img } });
    const r = rep.get('monge_ampere')!;
    console.log('lens', r.stats);
    ran(r.status);
    sane(out.gcode);
  });
});

describe('Phase 4 intents end to end', () => {
  it('Structural Armor on a bracket runs every structural field technology', () => {
    const t0 = performance.now();
    const out = slice([indexed(box(60, 90, 0, 60, 30, 12), 'bracket') as any], cfgFor('bbl-x1c'), () => {}, { advanced: { intent: 'structural', printerId: 'bbl-x1c', techs: {}, resolution: 'draft' } });
    const rep = new Map(out.advanced!.techs.map((t) => [t.id, t]));
    console.log('structural', Math.round(performance.now() - t0), out.advanced!.techs.filter((t) => t.status !== 'disabled').map((t) => `${t.id}:${t.status}`).join(' '));
    for (const id of ['fea_stress', 'quasicrystal', 'inverse_warp', 'homogenization', 'spinor_fields'] as const) ran(rep.get(id)!.status);
    sane(out.gcode);
  });
  it('lampshade mode prints the image as outer-wall widths', () => {
    const img = { width: 4, height: 4, pixels: [1, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 0, 1], throwMm: 200, mode: 'lampshade' as const };
    const { out, rep } = adv(indexed(tube(100, 100, 30, 1.2, 30), 'shade'), 'bbl-x1c', ['monge_ampere'], 'optical', { extra: { caustic: img } });
    ran(rep.get('monge_ampere')!.status);
    const w = segments(out, layerAt(out, 15), 'outer_wall').map((s) => s[5]);
    expect(Math.max(...w) - Math.min(...w)).toBeGreaterThan(0.2);
    sane(out.gcode);
  });
});
