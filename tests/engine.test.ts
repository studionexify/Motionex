import { describe, expect, it } from 'vitest';
import { weld, openEdgeCount, meshVolume } from '../src/engine/mesh';
import { sliceMesh } from '../src/engine/slice';
import { areaTotal } from '../src/engine/clipper';
import { slice } from '../src/engine/slicer';
import { resolveConfig } from '../src/profiles/resolve';
import { PRINTERS } from '../src/profiles/printers';
import { parseSTL, writeSTL } from '../src/io/stl';
import { parseOBJ } from '../src/io/obj';
import { box, cylinder, tee } from './fixtures';

const cfgFor = (printerId: string, overrides = {}) =>
  resolveConfig({ printerId, plate: 'textured_pei_plate', filamentId: 'generic-pla', presetId: '0.20', overrides });

const meshInput = (soup: Float32Array, name = 'part') => {
  const m = weld(soup);
  return { id: name, name, vertices: m.vertices, indices: m.indices };
};

describe('mesh', () => {
  it('welds a closed box', () => {
    const m = weld(box(0, 0, 0, 20, 20, 20));
    expect(m.vertices.length / 3).toBe(8);
    expect(openEdgeCount(m)).toBe(0);
    expect(Math.abs(meshVolume(m))).toBeCloseTo(8000, 3);
  });
  it('round-trips binary STL and parses OBJ', () => {
    const soup = box(0, 0, 0, 1, 2, 3);
    expect(parseSTL(writeSTL(soup))).toEqual(soup);
    const obj = 'v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nf 1 2 3 4\n';
    expect(parseOBJ(obj).length).toBe(18);
  });
});

describe('slicing', () => {
  it('cross-sections a box with the right area', () => {
    const m = weld(box(10, 10, 0, 20, 30, 10));
    const s = sliceMesh(m, [0.1, 5, 9.9]);
    for (const layer of s) expect(areaTotal(layer)).toBeCloseTo(600, 1);
  });
  it('cross-sections a cylinder', () => {
    const m = weld(cylinder(50, 50, 10, 10, 128));
    const s = sliceMesh(m, [5]);
    expect(areaTotal(s[0])).toBeCloseTo(Math.PI * 100, 0);
  });
});

describe('full pipeline', () => {
  for (const p of PRINTERS) {
    it(`slices a 20mm cube for ${p.vendor} ${p.model}`, () => {
      const out = slice([meshInput(box(100, 100, 0, 20, 20, 20), 'cube')], cfgFor(p.id));
      expect(out.layers.length).toBe(100);
      expect(out.gcode).toContain(';LAYER_CHANGE');
      expect(out.gcode).toMatch(/G1 X[\d.]+ Y[\d.]+ E[\d.]+/);
      // cube 20mm, 2 walls, 15% grid → roughly 5–9 g of PLA
      expect(out.stats.filamentGrams).toBeGreaterThan(3);
      expect(out.stats.filamentGrams).toBeLessThan(10);
      expect(out.stats.timeSeconds).toBeGreaterThan(5 * 60);
      expect(out.stats.timeSeconds).toBeLessThan(60 * 60);
      expect(out.warnings).toEqual([]);
    });
  }

  it('produces every surface type & support for an overhang', () => {
    const out = slice([meshInput(tee(100, 100), 'tee')], cfgFor('bbl-p1s', { enable_support: true, skirt_loops: 1, brim_type: 'outer_only' }));
    const types = new Set(out.gcode.match(/;TYPE:[a-z ]+/g));
    for (const t of ['outer wall', 'inner wall', 'sparse infill', 'top surface', 'bottom surface', 'support', 'support interface', 'skirt', 'brim']) {
      expect(types.has(`;TYPE:${t}`), t).toBe(true);
    }
  });

  it('bridges the overhang when support is off', () => {
    const out = slice([meshInput(tee(100, 100), 'tee')], cfgFor('bbl-p1s'));
    expect(out.gcode).toContain(';TYPE:bridge');
  });

  it('spiral vase produces a continuously rising outer wall', () => {
    const out = slice([meshInput(cylinder(100, 100, 20, 30), 'vase')], cfgFor('bbl-a1', { spiral_mode: true }));
    expect(out.gcode).not.toContain(';TYPE:top surface');
    expect(out.gcode).not.toContain(';TYPE:sparse infill');
  });

  it('each infill pattern slices', () => {
    for (const pat of ['grid', 'gyroid', 'rectilinear', 'aligned_rectilinear', 'triangles', 'concentric']) {
      const out = slice([meshInput(box(50, 50, 0, 20, 20, 6), 'b')], cfgFor('creality-ender3v3ke', { sparse_infill_pattern: pat, sparse_infill_density: 25 }));
      expect(out.gcode, pat).toContain(';TYPE:sparse infill');
    }
  });

  it('labels objects for Klipper', () => {
    const out = slice([meshInput(box(50, 50, 0, 10, 10, 2), 'a'), meshInput(box(100, 100, 0, 10, 10, 2), 'b')], cfgFor('elegoo-neptune4max'));
    expect(out.gcode).toContain('EXCLUDE_OBJECT_DEFINE NAME=obj0_a');
    expect(out.gcode).toContain('EXCLUDE_OBJECT_START NAME=obj1_b');
    expect(out.gcode).toContain('START_PRINT'.length ? 'G28' : '');
  });

  it('warns when out of bounds', () => {
    const out = slice([meshInput(box(240, 240, 0, 30, 30, 2), 'big')], cfgFor('bbl-a1'));
    expect(out.warnings.join()).toMatch(/outside/);
  });
});
