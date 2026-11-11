// Phase 2: PDE solvers (PCG, Laplace, multigrid Poisson, heat method, Eikonal), curved layers,
// SGD slicing, heat-method walls, conformal skins and the head-clearance checker.
import { describe, expect, it } from 'vitest';
import { laplace3, pcg, solveMasked2 } from '../../src/engine/advanced/solvers';
import { eikonalDistance, heatDistance, isolines, loopArea, pdeOffsets, rasterize } from '../../src/engine/advanced/offsets';
import { analyzePart } from '../../src/engine/advanced/analysis';
import { domeWarp, harmonicField } from '../../src/engine/advanced/harmonic';
import { optimiseLayers } from '../../src/engine/advanced/sgd';
import { clearancePass } from '../../src/engine/advanced/clearance';
import { DisplacementField, unwarpLayers } from '../../src/engine/advanced/warp';
import { defaultToolhead } from '../../src/plugins/motionex/core/toolhead';
import { toExPolygons, SCALE } from '../../src/engine/clipper';
import { legacyConfig, slice } from '../../src/engine/slicer';
import { slice as classicSlice } from '../../src/engine/advanced/classic/slicer';
import { resolveConfig } from '../../src/profiles/resolve';
import type { LayerOps } from '../../src/engine/advanced/classic/gcode';
import { box, dome, indexed } from './shapes';
import { tee } from '../fixtures';

const cfgFor = (printerId: string, overrides = {}) => resolveConfig({ printerId, plate: 'textured_pei_plate', filamentId: 'generic-pla', presetId: '0.20', overrides });
const params = { cells: 48, shell: 0.87, lineWidth: 0.42, layerHeight: 0.2, overhangDeg: 30 };
const circle = (cx: number, cy: number, r: number, n = 128) => Array.from({ length: n }, (_, i) => ({ X: Math.round((cx + r * Math.cos((i / n) * Math.PI * 2)) * SCALE), Y: Math.round((cy + r * Math.sin((i / n) * Math.PI * 2)) * SCALE) }));
const square = (x0: number, y0: number, s: number) => [{ X: x0 * SCALE, Y: y0 * SCALE }, { X: (x0 + s) * SCALE, Y: y0 * SCALE }, { X: (x0 + s) * SCALE, Y: (y0 + s) * SCALE }, { X: x0 * SCALE, Y: (y0 + s) * SCALE }];

describe('linear solvers', () => {
  it('PCG solves an SPD tridiagonal system', () => {
    const n = 50;
    const A = (x: Float64Array, o: Float64Array) => { for (let i = 0; i < n; i++) o[i] = 2.5 * x[i] - (i > 0 ? x[i - 1] : 0) - (i < n - 1 ? x[i + 1] : 0); };
    const b = new Float64Array(n).fill(1);
    const r = pcg(A, b, undefined, undefined, 1e-10, 500);
    const o = new Float64Array(n);
    A(r.x, o);
    for (let i = 0; i < n; i++) expect(o[i]).toBeCloseTo(1, 8);
  });
  it('Laplace in a box with φ = 0 below and 1 above is linear in z', () => {
    const nx = 6, ny = 6, nz = 12;
    const kind = new Uint8Array(nx * ny * nz).fill(1), fixed = new Float32Array(nx * ny * nz);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { kind[i + nx * j] = 2; const t = i + nx * (j + ny * (nz - 1)); kind[t] = 2; fixed[t] = 1; }
    const { phi } = laplace3(nx, ny, nz, kind, fixed, 1e-9, 5000);
    for (let k = 0; k < nz; k++) expect(phi[2 + nx * (3 + ny * k)]).toBeCloseTo(k / (nz - 1), 4);
  });
  it('multigrid-preconditioned Poisson converges in few iterations', () => {
    const n = 128, h = 0.1;
    const mask = new Uint8Array(n * n);
    for (let j = 1; j < n - 1; j++) for (let i = 1; i < n - 1; i++) mask[i + n * j] = 1;
    const f = new Float64Array(n * n).fill(1);
    const r = solveMasked2(n, n, h, mask, 0, 1, f, 1e-8, 300);
    expect(r.residual).toBeLessThan(1e-8);
    expect(r.iterations).toBeLessThan(60);
    // −Δu = 1 on a square of side L: centre value ≈ 0.0737 L²
    const L = (n - 1) * h;
    expect(r.x[n / 2 + n * (n / 2)]).toBeCloseTo(0.0737 * L * L, 1);
  });
});

describe('PDE distance & offsets', () => {
  const disk = [circle(0, 0, 10)];
  it('heat-method and Eikonal distances match the true distance inside a disk', () => {
    const r = rasterize(disk, 0.1)!;
    const heat = heatDistance(r, 1), fmm = eikonalDistance(r, disk);
    let eh = 0, ef = 0, n = 0;
    for (let j = 0; j < r.ny; j++) for (let i = 0; i < r.nx; i++) {
      const p = i + r.nx * j;
      if (!r.mask[p]) continue;
      const x = r.ox + i * r.h, y = r.oy + j * r.h, d = 10 - Math.hypot(x, y);
      if (d > 8) continue; // the centre is the medial point (the heat method smooths it on purpose)
      eh = Math.max(eh, Math.abs(heat[p] - d)); ef = Math.max(ef, Math.abs(fmm[p] - d)); n++;
    }
    expect(n).toBeGreaterThan(1000);
    expect(ef).toBeLessThan(0.15);
    expect(eh).toBeLessThan(0.35);
  });
  it('isolines of the distance are the inset circles', () => {
    const r = rasterize(disk, 0.1)!;
    const fmm = eikonalDistance(r, disk);
    const loops = isolines(r, fmm, 3);
    expect(loops.length).toBe(1);
    expect(loopArea(loops[0])).toBeCloseTo(Math.PI * 49, -1); // counter-clockwise, r = 7
  });
  it('builds smooth inner walls and the infill boundary of a square with a hole', () => {
    const ex = toExPolygons([square(0, 0, 20), circle(10, 10, 3).reverse()])[0];
    const res = pdeOffsets(ex, [0.62, 1.05], 1.27, { method: 'heat', cell: 0.08, smooth: 2, minLoop: 1.3 })!;
    expect(res.loops[0].length).toBe(2); // one around the outside, one round the hole
    expect(res.loops[1].length).toBe(2);
    const outer = res.loops[0].map(loopArea).sort((a, b) => b - a)[0];
    expect(outer).toBeGreaterThan(17.8 * 17.8);
    expect(outer).toBeLessThan(19 * 19);
    expect(res.inner.length).toBeGreaterThan(0);
  });
});

describe('harmonic dome field & curved layers', () => {
  const silo = analyzePart(indexed(dome(50, 50, 20, 25, 12)) as any, params);
  it('solves ∇²φ = 0 between the bed (0) and the dome (1)', () => {
    const hr = harmonicField(silo)!;
    expect(hr.domeCells).toBeGreaterThan(50);
    const g = silo.sdf.sdf;
    // φ grows upwards through the centre, from 0 on the bed
    let last = -1, first = NaN;
    for (let k = 0; k < g.nz; k++) {
      const p = g.cellAt(50, 50, g.z(k));
      if (p < 0 || !silo.sdf.inside[p]) continue;
      expect(hr.phi[p]).toBeGreaterThanOrEqual(last - 1e-6);
      if (Number.isNaN(first)) first = hr.phi[p];
      last = hr.phi[p];
    }
    expect(first).toBeLessThan(0.05);
    expect(last).toBeGreaterThan(0.9);
  });
  it('turns φ into layers that respect the head clearance and thickness limits', () => {
    const hr = harmonicField(silo)!;
    const dw = domeWarp(silo, hr, { maxSlopeDeg: 10.7, minRatio: 0.5, maxRatio: 1.5, band: 0 })!;
    const st = dw.field.stats(dw.field.material);
    expect(st.maxSlope).toBeLessThanOrEqual(Math.tan((10.7 * Math.PI) / 180) + 1e-6);
    expect(st.minRatio).toBeGreaterThanOrEqual(0.5 - 1e-6);
    expect(st.maxRatio).toBeLessThanOrEqual(1.5 + 1e-6);
    expect(st.maxAbs).toBeGreaterThan(0.2); // layers really bend
    expect(dw.conformity).toBeGreaterThan(0.3);
    // with a 5-axis head nothing limits the tilt: far more conformal
    const free = domeWarp(silo, hr, { maxSlopeDeg: 75, minRatio: 0.3, maxRatio: 2, band: 0 })!;
    expect(free.conformity).toBeGreaterThan(0.85);
    // inverse map is consistent
    for (const [x, y, z] of [[50, 50, 30], [60, 55, 34], [45, 40, 20]]) {
      const zw = dw.field.toWarped(x, y, z);
      expect(zw + dw.field.dz(x, y, zw)).toBeCloseTo(z, 3);
    }
  });
  it('un-warping splits moves along the curved layer and scales flow by the layer ratio', () => {
    const f = new DisplacementField(11, 11, 11, 0, 0, 1, 1, 'harmonic_dome');
    for (let k = 0; k < 11; k++) for (let j = 0; j < 11; j++) for (let i = 0; i < 11; i++) f.d[f.idx(i, j, k)] = 0.1 * i * (k / 10);
    const L: LayerOps = { z: 5, h: 0.2, fan: 0, ops: [
      { k: 'move', x: 0, y: 5, z: 5, e: 0, f: 100, feature: 'travel', w: 0, h: 0.2, travel: true },
      { k: 'move', x: 10, y: 5, z: 5, e: 1, f: 50, feature: 'outer_wall', w: 0.42, h: 0.2, travel: false },
    ] };
    unwarpLayers([L], f, 0.001, 0.5);
    const moves = L.ops.filter((o) => o.k === 'move') as any[];
    // the warp is linear in x along this move: one chord is exact, no split needed
    expect(moves.length).toBe(2);
    expect(moves[moves.length - 1].z).toBeCloseTo(5 + 0.5, 3);
    const e = moves.slice(1).reduce((t, m) => t + m.e, 0);
    expect(e).toBeGreaterThan(1); // ratio 1 + 0.1·i/10 > 1
  });
});

describe('differentiable SGD slicing', () => {
  it('reduces the overhang loss of a T within the head clearance', () => {
    const a = analyzePart(indexed(tee(60, 60)) as any, params);
    const r = optimiseLayers(a, { w1: 1, w2: 4, w3: 0, w4: 1, iters: 150, ctrl: 8, maxSlopeDeg: 10.7, overhangDeg: 30, minRatio: 0.5, maxRatio: 1.5 })!;
    expect(r.loss).toBeLessThan(r.loss0);
    expect(r.overhang).toBeLessThan(r.overhang0);
  });
});

describe('head clearance', () => {
  it('raises a non-planar move that would drive the nozzle into printed plastic', () => {
    const head = defaultToolhead('bbl-x1c');
    const layer = (z: number, dip = 0): LayerOps => ({ z, h: 0.2, fan: 0, ops: [
      { k: 'move', x: 50, y: 50, z, e: 0, f: 100, feature: 'travel', w: 0, h: 0.2, travel: true },
      ...Array.from({ length: 40 }, (_, i) => ({ k: 'move' as const, x: 50 + i * 0.5, y: 50, z: i === 30 ? z - dip : z, e: 0.02, f: 50, feature: 'outer_wall' as const, w: 0.42, h: 0.2, travel: false })),
    ] });
    const layers = [layer(0.2), layer(0.4), layer(0.6, 0.5)];
    const rep = clearancePass(layers, head, { x: 256, y: 256 }, true);
    expect(rep.checked).toBe(1);
    expect(rep.collisions).toBe(1);
    // 0.5 mm into the layer below is more than half a layer: reported, not silently printed
    expect(rep.unresolved).toBe(1);
    const small = [layer(0.2), layer(0.4), layer(0.6, 0.25)];
    const rep2 = clearancePass(small, head, { x: 256, y: 256 }, true);
    expect(rep2.raised).toBe(1);
    const m = small[2].ops.filter((o) => o.k === 'move')[31] as any;
    expect(m.z).toBeGreaterThanOrEqual(0.4 + 0.03 - 1e-6);
  });
});

describe('Phase 2 in the slicer', () => {
  // only the Phase 2 technologies, so later phases' passes do not change what is measured here
  const P2 = new Set(['harmonic_dome', 'sgd_slicing', 'eikonal_offsets', 'conformal_layers', 'sdf_frep']);
  const ALL = ['fea_stress', 'sdf_frep', 'eulerian_spiral', 'conformal_layers', 'hot_on_hot', 'kinematic_extrusion', 'z_weave', 'subvoxel_aa', 'turing_infill', 'corner_overshoot', 'spatial_lattice', 'metamaterial', 'dovetail', 'sgd_slicing', 'eikonal_offsets', 'inverse_warp', 'gloss_modulation', 'foam_control', 'knot_braiding', 'co_molding', 'thick_vase', 'tangent_entry', 'scarf_splice', 'harmonic_dome', 'conformal_ironing', 'perimeter_feathering', 'iso_gloss', 'quasicrystal', 'metric_morph', 'monge_ampere', 'symplectic_shaper', 'morse_router', 'spinor_fields', 'band_gap', 'homogenization'];
  const phase2 = Object.fromEntries(ALL.filter((id) => !P2.has(id)).map((id) => [id, { enabled: false }]));
  const opts = (intent: 'aesthetic' | 'structural', printerId = 'bbl-x1c', techs = {}) => ({ advanced: { intent, printerId, techs: { ...phase2, ...techs }, resolution: 'draft' as const } });
  it('slices a domed part on curved layers, within the head clearance', () => {
    const out = slice([indexed(dome(100, 100, 18, 20, 10), 'silo')], cfgFor('bbl-x1c'), () => {}, opts('aesthetic'));
    const t = new Map(out.advanced!.techs.map((x) => [x.id, x]));
    expect(['applied', 'adapted']).toContain(t.get('harmonic_dome')!.status);
    expect(Number(t.get('harmonic_dome')!.stats!.max_layer_tilt_deg)).toBeLessThanOrEqual(10.7 * 0.8 + 0.05);
    expect(Number(t.get('harmonic_dome')!.stats!.conformity_pct)).toBeGreaterThan(30);
    expect(['applied', 'adapted']).toContain(t.get('eikonal_offsets')!.status);
    // some moves leave their layer plane, none go below the bed or above the part
    const m = out.moves;
    let off = 0, maxZ = 0;
    for (const L of out.layers) for (let i = L.moveStart; i < L.moveEnd; i++) {
      const z = m[i * 8 + 2];
      maxZ = Math.max(maxZ, z);
      if (Math.abs(z - L.z) > 0.01) off++;
      expect(z).toBeGreaterThanOrEqual(0);
    }
    expect(off).toBeGreaterThan(100);
    expect(maxZ).toBeLessThan(30 + 1.2);
    // the clearance check repairs what it can; the few points it cannot (thin, compressed layers under
    // the dome's apex) are reported in the warnings, at most 0.2 % of the checked points
    const c = out.advanced!.clearance!;
    expect(c.unresolved).toBeLessThanOrEqual(c.checked * 0.002);
    expect(out.gcode).not.toMatch(/NaN|Infinity/);
  });
  it('tilts layers under overhangs with SGD slicing (aesthetic intent)', () => {
    const out = slice([indexed(tee(100, 100), 'tee')], cfgFor('bbl-x1c'), () => {}, opts('aesthetic'));
    const sgd = out.advanced!.techs.find((x) => x.id === 'sgd_slicing')!;
    expect(['applied', 'adapted']).toContain(sgd.status);
    expect(Number(sgd.stats!.loss_end)).toBeLessThan(Number(sgd.stats!.loss_start));
    expect(out.advanced!.clearance!.unresolved).toBe(0);
    expect(out.gcode).not.toMatch(/NaN|Infinity/);
  });
  it('keeps prismatic parts flat and walls in heat-method form', () => {
    const out = slice([indexed(box(80, 80, 0, 20, 20, 10), 'cube')], cfgFor('voron-24-350'), () => {}, opts('structural', 'voron-24-350'));
    const t = new Map(out.advanced!.techs.map((x) => [x.id, x]));
    expect(t.get('eikonal_offsets')!.stats!.cache_hits).toBeGreaterThan(10); // repeated outline: solved once
    expect(out.advanced!.clearance).toBeUndefined();
    // compared with Advanced mode's own classic core (Basic mode is a separate engine)
    const basic = classicSlice([indexed(box(80, 80, 0, 20, 20, 10), 'cube')], legacyConfig(cfgFor('voron-24-350')));
    expect(Math.abs(out.stats.filamentGrams - basic.stats.filamentGrams) / basic.stats.filamentGrams).toBeLessThan(0.03);
  });
});
