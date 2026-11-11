import { describe, expect, it } from 'vitest';
import { weld } from '../src/engine/mesh';
import { slice, slotFromConfig } from '../src/engine/slicer';
import { adaptiveProfile, smoothProfile, applyHeightRange } from '../src/engine/layers';
import { pickSeam } from '../src/engine/order';
import { resolveConfig } from '../src/profiles/resolve';
import type { MeshInput } from '../src/engine/types';
import { box, cone, cylinder, tee } from './fixtures';

const cfgFor = (printerId: string, overrides = {}) =>
  resolveConfig({ printerId, plate: 'textured_pei_plate', filamentId: 'generic-pla', presetId: '0.20', overrides });
const mesh = (soup: Float32Array, name = 'part', extra: Partial<MeshInput> = {}): MeshInput => {
  const m = weld(soup);
  return { id: name, name, vertices: m.vertices, indices: m.indices, ...extra };
};
const part = (soup: Float32Array) => { const m = weld(soup); return { vertices: m.vertices, indices: m.indices }; };
const triCount = (m: MeshInput) => m.indices.length / 3;
const twoSlots = (cfg: ReturnType<typeof cfgFor>) => {
  const a = slotFromConfig(cfg);
  return [a, { ...a, name: 'Second', color: '#FF5C8D' }];
};

describe('per-object settings', () => {
  it('overrides wall loops and infill per object', () => {
    const cfg = cfgFor('bbl-p1s');
    const a = slice([mesh(box(60, 60, 0, 20, 20, 10), 'a'), mesh(box(120, 60, 0, 20, 20, 10), 'b')], cfg);
    const b = slice([mesh(box(60, 60, 0, 20, 20, 10), 'a'), mesh(box(120, 60, 0, 20, 20, 10), 'b', { overrides: { sparse_infill_density: 100, wall_loops: 4 } })], cfg);
    expect(b.stats.filamentGrams).toBeGreaterThan(a.stats.filamentGrams * 1.3);
  });
  it('ignores keys that are not per-object settings', () => {
    const cfg = cfgFor('bbl-p1s');
    const a = slice([mesh(box(60, 60, 0, 20, 20, 5))], cfg);
    const b = slice([mesh(box(60, 60, 0, 20, 20, 5), 'p', { overrides: { layer_height: 0.1 } })], cfg);
    expect(b.layers.length).toBe(a.layers.length);
  });
});

describe('variable layer height', () => {
  it('adaptive profile thins layers on slopes and keeps max on vertical walls', () => {
    const m = weld(cone(0, 0, 20, 5, 20));
    const p = adaptiveProfile(m, { minHeight: 0.08, maxHeight: 0.28, firstLayer: 0.2, quality: 0.3 });
    const cyl = adaptiveProfile(weld(cylinder(0, 0, 10, 20)), { minHeight: 0.08, maxHeight: 0.28, firstLayer: 0.2, quality: 0.3 });
    expect(Math.max(...p.slice(1))).toBeLessThan(0.28);
    expect(Math.min(...cyl.slice(1, -1))).toBeCloseTo(0.28, 3);
    const sm = smoothProfile(p, 3, false);
    expect(sm.length).toBe(p.length);
  });
  it('slicer follows the profile', () => {
    const prof = applyHeightRange([0.2, ...Array(60).fill(0.2)], 4, 6, 0.1, 10);
    const out = slice([mesh(box(60, 60, 0, 20, 20, 10), 'b', { layerHeights: prof })], cfgFor('bbl-a1'));
    const thin = out.layers.filter((L) => Math.abs(L.height - 0.1) < 1e-6);
    expect(thin.length).toBeGreaterThanOrEqual(19);
    expect(out.layers[out.layers.length - 1].z).toBeCloseTo(10, 1);
  });
});

describe('parts', () => {
  it('negative part removes material', () => {
    const cfg = cfgFor('bbl-p1s', { sparse_infill_density: 100 });
    const solid = slice([mesh(box(60, 60, 0, 20, 20, 10))], cfg);
    const cut = slice([mesh(box(60, 60, 0, 20, 20, 10), 'c', { parts: [{ type: 'negative', ...part(box(65, 65, -1, 10, 10, 12)) }] })], cfg);
    expect(cut.stats.filamentGrams).toBeLessThan(solid.stats.filamentGrams * 0.85);
  });
  it('modifier changes infill density inside its volume', () => {
    const cfg = cfgFor('bbl-p1s', { sparse_infill_density: 10 });
    const base = slice([mesh(box(60, 60, 0, 30, 30, 10))], cfg);
    const mod = slice([mesh(box(60, 60, 0, 30, 30, 10), 'm', { parts: [{ type: 'modifier', overrides: { sparse_infill_density: 80 }, ...part(box(60, 60, 0, 15, 30, 10)) }] })], cfg);
    expect(mod.stats.filamentGrams).toBeGreaterThan(base.stats.filamentGrams * 1.2);
  });
  it('support blocker volume removes support', () => {
    const cfg = cfgFor('bbl-p1s', { enable_support: true });
    const withSup = slice([mesh(tee(100, 100))], cfg);
    const blocked = slice([mesh(tee(100, 100), 't', { parts: [{ type: 'support_blocker', ...part(box(70, 80, -1, 70, 40, 20)) }] })], cfg);
    expect(withSup.stats.byFeature.support).toBeTruthy();
    expect(blocked.stats.byFeature.support).toBeFalsy();
  });
});

describe('painting', () => {
  it('manual supports only where painted', () => {
    const cfg = cfgFor('bbl-p1s', { enable_support: true, support_type: 'normal_manual' });
    const t = mesh(tee(100, 100));
    expect(slice([t], cfg).stats.byFeature.support).toBeFalsy();
    // paint downward-facing faces of the slab
    const sup = new Uint8Array(triCount(t));
    const v = t.vertices, ix = t.indices;
    for (let k = 0; k < sup.length; k++) {
      const z = [0, 1, 2].map((c) => v[ix[k * 3 + c] * 3 + 2]);
      if (z.every((q) => Math.abs(q - 10) < 1e-3)) sup[k] = 1;
    }
    const painted = slice([{ ...t, paint: { support: sup } }], cfg);
    expect(painted.stats.byFeature.support).toBeTruthy();
  });
  it('blocker paint suppresses auto support', () => {
    const cfg = cfgFor('bbl-p1s', { enable_support: true });
    const t = mesh(tee(100, 100));
    const sup = new Uint8Array(triCount(t)).fill(2);
    expect(slice([{ ...t, paint: { support: sup } }], cfg).stats.byFeature.support).toBeFalsy();
  });
  it('seam enforcer pulls the seam to the painted point', () => {
    const square = [0, 0, 10, 0, 10, 10, 0, 10];
    expect(pickSeam(square, 'back', 0, 0, null, Math.random, { enforce: [[10.2, 0.3]], block: [] })).toBe(1);
    expect(pickSeam(square, 'back', 0, 0, null, Math.random, { enforce: [], block: [[10, 10], [0, 10]] })).not.toBeGreaterThan(1);
  });
  it('colour painting creates a second filament region with filament changes and a prime tower', () => {
    const cfg = cfgFor('bbl-x1c'); // Bambu Studio's own X1 Carbon change G-code
    const t = mesh(cylinder(100, 100, 12, 10));
    const color = new Uint8Array(triCount(t));
    const v = t.vertices, ix = t.indices;
    for (let k = 0; k < color.length; k++) if (v[ix[k * 3] * 3] > 100) color[k] = 2; // paint the +X half with slot 2
    const out = slice([{ ...t, paint: { color } }], cfg, undefined, { filaments: twoSlots(cfg) });
    expect(out.stats.toolChanges).toBeGreaterThan(10);
    expect(out.gcode).toContain('M620 S1A');
    expect(out.gcode).toContain(';TYPE:prime tower');
    expect(out.stats.perFilament[1].grams).toBeGreaterThan(0.1);
    // after each change: fan restored, then the first extrusion is preceded by an un-retract
    const lastEnd = [...out.gcode.matchAll(/^M621 S\d+A$/gm)].at(-1)!; // the end of the last change, well above the fan-off first layer
    const after = out.gcode.slice(lastEnd.index! + lastEnd[0].length);
    expect(after.slice(0, 100)).toContain('M106 S255');
    const firstExtrude = after.search(/\nG1 X[^\n]*E\d/);
    expect(after.slice(0, firstExtrude)).toMatch(/\nG1 E0\.8 F/);
  });
});

describe('multi-material & layer actions', () => {
  it('objects on different filaments change tools on AMS printers', () => {
    const cfg = cfgFor('bbl-a1');
    const out = slice([mesh(box(60, 60, 0, 15, 15, 4), 'a'), mesh(box(120, 60, 0, 15, 15, 4), 'b', { filament: 1 })], cfg, undefined, { filaments: twoSlots(cfg) });
    expect(out.stats.toolChanges).toBeGreaterThan(5);
    expect(out.stats.perFilament.every((f) => f.grams > 0)).toBe(true);
  });
  it('manual printers pause with M600 and skip the AMS sequence', () => {
    const cfg = cfgFor('creality-ender3v3ke');
    const out = slice([mesh(box(60, 60, 0, 15, 15, 4), 'a')], cfg, undefined, {
      filaments: twoSlots(cfg), layerActions: [{ z: 2, type: 'color', filament: 1 }, { z: 3, type: 'pause' }],
    });
    expect(out.gcode.match(/^M600/gm)?.length).toBe(1);
    expect(out.gcode).toContain('PAUSE');
    expect(out.gcode).not.toContain('M620');
  });
  it('custom G-code is inserted at the requested layer', () => {
    const out = slice([mesh(box(60, 60, 0, 15, 15, 4))], cfgFor('bbl-p1s'), undefined, { layerActions: [{ z: 1, type: 'custom', gcode: 'M117 hello' }] });
    const idx = out.gcode.indexOf('M117 hello');
    expect(idx).toBeGreaterThan(out.gcode.indexOf(';Z:1\n'));
  });
});

describe('tree supports', () => {
  it('grows branches under the overhang', () => {
    const cfg = cfgFor('bbl-p1s', { enable_support: true, support_type: 'tree_auto' });
    const out = slice([mesh(tee(100, 100))], cfg);
    expect(out.stats.byFeature.support).toBeTruthy();
    const normal = slice([mesh(tee(100, 100))], cfgFor('bbl-p1s', { enable_support: true }));
    expect(out.stats.byFeature.support!.filamentMm).toBeLessThan(normal.stats.byFeature.support!.filamentMm);
  });
});
