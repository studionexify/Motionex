import { describe, expect, it } from 'vitest';
import { weld } from '../src/engine/mesh';
import { slice } from '../src/engine/slicer';
import { resolveConfig } from '../src/profiles/resolve';
import { FEATURE_ORDER, type MeshInput } from '../src/engine/types';
import { box, cylinder } from './fixtures';

const cfgFor = (printerId: string, overrides = {}) =>
  resolveConfig({ printerId, plate: 'textured_pei_plate', filamentId: 'generic-pla', presetId: '0.20', overrides });
const mesh = (soup: Float32Array, name = 'part', extra: Partial<MeshInput> = {}): MeshInput => {
  const m = weld(soup);
  return { id: name, name, vertices: m.vertices, indices: m.indices, ...extra };
};
const wallMm = (g: string) => g.split('\n').filter((l) => /^G1 .*E[\d.]+/.test(l)).length;

describe('arachne walls', () => {
  it('fills a thin wall that classic perimeters cannot', () => {
    // 0.6 mm thin fin: too narrow for two 0.42 beads
    const fin = mesh(box(100, 100, 0, 0.6, 20, 5));
    const classic = slice([fin], cfgFor('bbl-p1s', { wall_generator: 'classic' }));
    const arachne = slice([fin], cfgFor('bbl-p1s', { wall_generator: 'arachne' }));
    const wallVol = (o: ReturnType<typeof slice>) => {
      // sum w*h*len over wall moves (moves are end points; previous move is the start)
      let v = 0;
      for (let k = 1; k < o.moveFeatures.length; k++) {
        const f = FEATURE_ORDER[o.moveFeatures[k]];
        if (f !== 'outer_wall' && f !== 'inner_wall') continue;
        const m = o.moves, a = (k - 1) * 8, b = k * 8;
        v += Math.hypot(m[b] - m[a], m[b + 1] - m[a + 1]) * m[b + 3] * m[b + 4];
      }
      return v;
    };
    const finVolume = 0.6 * 20 * 5; // mm³
    const av = wallVol(arachne), cv = wallVol(classic);
    expect(av).toBeGreaterThan(finVolume * 0.75);
    expect(av).toBeLessThan(finVolume * 1.3);
    expect(Math.abs(av - finVolume)).toBeLessThan(Math.abs(cv - finVolume));
    // moves carry variable widths close to the fin width
    const ws: number[] = [];
    for (let k = 0; k < arachne.moves.length; k += 8) if (arachne.moves[k + 3] > 0) ws.push(arachne.moves[k + 3]);
    const mid = ws.sort((a, b) => a - b)[Math.floor(ws.length / 2)];
    expect(mid).toBeGreaterThan(0.45);
    expect(mid).toBeLessThan(0.75);
    expect(wallMm(arachne.gcode)).toBeGreaterThan(0);
  });
  it('matches classic on a plain thick box', () => {
    const b = mesh(box(100, 100, 0, 20, 20, 5));
    const c = slice([b], cfgFor('bbl-p1s', { wall_generator: 'classic' }));
    const a = slice([b], cfgFor('bbl-p1s', { wall_generator: 'arachne' }));
    expect(a.stats.filamentMm / c.stats.filamentMm).toBeGreaterThan(0.95);
    expect(a.stats.filamentMm / c.stats.filamentMm).toBeLessThan(1.05);
  });
});

describe('config layer actions', () => {
  it('changes retraction and flow mid-print', () => {
    const cfg = cfgFor('bbl-p1s');
    const parts = [mesh(cylinder(80, 80, 5, 10), 'a'), mesh(cylinder(120, 80, 5, 10), 'b')];
    const g = slice(parts, cfg, undefined, { layerActions: [{ z: 5, type: 'config', key: 'retraction_length', value: 3, gcode: '; RETRACT 3' }] }).gcode;
    const after = g.slice(g.indexOf('; RETRACT 3'));
    expect(after).toMatch(/G1 E-3(\.0+)? /);
    expect(g.slice(0, g.indexOf('; RETRACT 3'))).not.toMatch(/G1 E-3(\.0+)? /);
  });
  it('per-object flow scale changes extrusion', () => {
    const cfg = cfgFor('bbl-p1s');
    const a = slice([mesh(box(60, 60, 0, 20, 20, 3))], cfg);
    const b = slice([mesh(box(60, 60, 0, 20, 20, 3), 'p', { overrides: { flow_ratio_scale: 1.1 } })], cfg);
    expect(b.stats.filamentMm / a.stats.filamentMm).toBeGreaterThan(1.07);
  });
});

describe('arc fitting', () => {
  it('emits G2/G3 on round parts and keeps the same filament use', () => {
    const c = mesh(cylinder(100, 100, 15, 4, 128));
    const a = slice([c], cfgFor('bbl-p1s', { enable_arc_fitting: false }));
    const b = slice([c], cfgFor('bbl-p1s', { enable_arc_fitting: true }));
    // arc-fitted paths (the spiral Z hop is a full-circle G3 with only Z, I, J)
    const arcs = b.gcode.split('\n').filter((l) => /^G[23] X/.test(l));
    expect(arcs.length).toBeGreaterThan(10);
    expect(b.gcode.length).toBeLessThan(a.gcode.length * 0.9);
    expect(Math.abs(b.stats.filamentMm - a.stats.filamentMm)).toBeLessThan(0.01 * a.stats.filamentMm);
    // every arc ends on the circle it describes
    for (const l of arcs.slice(0, 50)) {
      expect(l).toMatch(/^G[23] X[\d.-]+ Y[\d.-]+ I[\d.-]+ J[\d.-]+ E[\d.]+/);
    }
  });
});

import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { md5 } from '../src/io/md5';
import { buildGcode3mf, gcodeThumbnailBlock } from '../src/io/gcode3mf';

describe('.gcode.3mf export', () => {
  it('md5 matches node crypto for many lengths', () => {
    for (const n of [0, 1, 55, 56, 63, 64, 65, 1000, 100000]) {
      const b = new Uint8Array(n).map((_, i) => (i * 31 + 7) & 255);
      expect(md5(b)).toBe(createHash('md5').update(b).digest('hex'));
    }
  });
  it('packages plate G-code, checksum and slice info', async () => {
    const cfg = cfgFor('bbl-a1');
    const out = slice([mesh(box(100, 100, 0, 20, 20, 2))], cfg);
    const bytes = await buildGcode3mf([{ gcode: out.gcode, stats: out.stats, objects: [{ id: 1, name: 'cube & co' }], filaments: [{ type: 'PLA', color: '#FF5C8D' }], supportUsed: false, thumbnail: new Uint8Array([137, 80, 78, 71]) }], cfg, 'N2S', 0.4);
    const zip = await JSZip.loadAsync(bytes);
    const g = await zip.file('Metadata/plate_1.gcode')!.async('string');
    expect(g).toBe(out.gcode);
    expect(await zip.file('Metadata/plate_1.gcode.md5')!.async('string')).toBe(createHash('md5').update(g).digest('hex').toUpperCase());
    const info = await zip.file('Metadata/slice_info.config')!.async('string');
    expect(info).toContain('<metadata key="printer_model_id" value="N2S"/>');
    expect(info).toContain('name="cube &amp; co"');
    expect(info).toMatch(/<filament id="1" type="PLA" color="#FF5C8D" used_m="[\d.]+" used_g="[\d.]+"\/>/);
    expect(zip.file('Metadata/plate_1.png')).toBeTruthy();
    expect(JSON.parse(await zip.file('Metadata/project_settings.config')!.async('string')).filament_colour).toEqual(['#FF5C8D']);
  });
  it('writes thumbnail blocks with 78-column base64', () => {
    const t = gcodeThumbnailBlock(new Uint8Array(500).fill(65), 300, 300);
    const lines = t.split('\n');
    expect(lines[0]).toMatch(/^; thumbnail begin 300x300 \d+$/);
    expect(lines.slice(1, -2).every((l) => l.length <= 80)).toBe(true);
  });
});

import { buildCalibration, CALIBRATIONS } from '../src/state/calibration';

describe('calibration routines', () => {
  const sliceCal = (id: Parameters<typeof buildCalibration>[0], printerId = 'bbl-p1s') => {
    const c = CALIBRATIONS.find((x) => x.id === id)!;
    const r = buildCalibration(id, c.params({ nozzleTemp: 220, maxVolumetricSpeed: 21 } as any, printerId.startsWith('bbl') ? 'bbl' : 'klipper'), printerId, 'generic-pla');
    const cfg = cfgFor(printerId, r.overrides);
    const meshes = r.objects.map((o) => {
      const v = o.mesh.vertices.slice();
      for (let i = 0; i < v.length; i += 3) { v[i] += o.position[0]; v[i + 1] += o.position[1]; }
      return { id: o.id, name: o.name, vertices: v, indices: o.mesh.indices, overrides: o.overrides };
    });
    return { r, out: slice(meshes, cfg, undefined, { layerActions: r.layerActions, program: r.program }) };
  };
  it('temperature tower steps M104 per block', () => {
    const { out } = sliceCal('temp');
    const temps = [...out.gcode.matchAll(/^M104 S(\d+) ; temperature tower/gm)].map((m) => +m[1]);
    expect(temps).toEqual([235, 230, 225, 220, 215, 210, 205]);
  });
  it('pressure advance tower emits increasing K (Klipper syntax on Klipper printers)', () => {
    const { out } = sliceCal('pa', 'creality-ender3v3ke');
    const ks = [...out.gcode.matchAll(/^SET_PRESSURE_ADVANCE ADVANCE=([\d.]+) ; PA tower/gm)].map((m) => +m[1]);
    expect(ks.length).toBeGreaterThan(20);
    expect(ks.every((k, i) => i === 0 || k > ks[i - 1])).toBe(true);
  });
  it('flow patches extrude proportionally to their offset', () => {
    const { r, out } = sliceCal('flow');
    expect(r.objects.length).toBe(9);
    expect(out.stats.filamentMm).toBeGreaterThan(0);
    expect(r.choices[0].tuning.flowRatio).toBeCloseTo(0.98 * 0.8, 3);
  });
  it('volumetric speed test raises wall speed with height in vase mode', () => {
    const { out } = sliceCal('mvs');
    const speeds: number[] = [];
    for (const l of out.layers.slice(10)) {
      const k = l.moveEnd - 1;
      if (k > l.moveStart) speeds.push(out.moves[k * 8 + 5]);
    }
    expect(speeds.at(-1)!).toBeGreaterThan(speeds[0] * 2);
  });
  it('PA line: slow-fast-slow lines with rising K, numbers on a tab', () => {
    const { r, out } = sliceCal('pa_line');
    expect(r.objects).toHaveLength(0);
    const ks = [...out.gcode.matchAll(/^M900 K([\d.]+) ; pressure advance/gm)].map((m) => +m[1]);
    expect(ks.slice(0, 51)).toEqual(Array.from({ length: 51 }, (_, i) => +(i * 0.002).toFixed(4)));
    expect(out.layers).toHaveLength(2); // lines + number layer
    // each test line: 20 mm at 20 mm/s, 40 mm at 100 mm/s, 20 mm at 20 mm/s
    const speeds = new Set<number>();
    for (let i = out.layers[0].moveStart; i < out.layers[0].moveEnd; i++) if (out.moveFeatures[i] === 0) speeds.add(Math.round(out.moves[i * 8 + 5]));
    expect([...speeds].sort((a, b) => a - b)).toEqual(expect.arrayContaining([20, 100]));
    expect(out.stats.filamentMm).toBeGreaterThan(50);
  });
  it('PA pattern: four layers of chevrons, K per chevron', () => {
    const { out } = sliceCal('pa_pattern', 'creality-ender3v3ke');
    expect(out.layers).toHaveLength(4);
    const ks = [...out.gcode.matchAll(/^SET_PRESSURE_ADVANCE ADVANCE=([\d.]+) ; pressure advance/gm)].map((m) => +m[1]);
    const n = 17; // 0 → 0.08 in 0.005
    expect(new Set(ks).size).toBe(n);
    expect(ks.filter((k) => k === 0.08)).toHaveLength(4);
  });
  it('flow blocks use the object flow ratio and carry number tabs; temperature blocks are labelled', () => {
    const { r } = sliceCal('flow_fine');
    expect(r.objects.map((o) => o.overrides!.print_flow_ratio)).toEqual([1, 0.99, 0.98, 0.97, 0.96, 0.95, 0.94, 0.93, 0.92, 0.91]);
    const lowest = (o: (typeof r.objects)[0]) => { let m = Infinity; for (let i = 1; i < o.mesh.vertices.length; i += 3) m = Math.min(m, o.mesh.vertices[i]); return m; };
    expect(lowest(r.objects[0])).toBeLessThan(-12); // tab in front of the 20 mm block
    const t = sliceCal('temp');
    expect(t.r.objects[0].mesh.indices.length).toBeGreaterThan(400);
  });
  it('retraction test increases retraction length', () => {
    const { out } = sliceCal('retraction');
    // a retraction may run during the wipe (Bambu: retract_before_wipe 0 %): sum each run of E- moves
    const lens: number[] = [];
    let run = 0;
    for (const l of out.gcode.split('\n')) {
      const m = /^G1 (?:[XYZ][-\d.]+ )*E-([\d.]+)/.exec(l);
      if (m) run += +m[1];
      else if (/^G[0123] /.test(l) && run) { lens.push(run); run = 0; }
    }
    expect(Math.max(...lens)).toBeGreaterThan(1.5);
  });
});

import { cutAtZ0 } from '../src/engine/meshops';
import { meshVolume, openEdgeCount } from '../src/engine/mesh';

describe('cut tool', () => {
  it('splits a ring into two closed halves with matching volume', () => {
    // ring: tube with a hole, shifted so z = 0 crosses it at 1/3 height
    const soup: number[] = [];
    const seg = 48, ro = 20, ri = 12, h = 12, z0 = -4;
    const P = (r: number, a: number, zz: number) => [r * Math.cos(a), r * Math.sin(a), zz];
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
      const o0b = P(ro, a0, z0), o1b = P(ro, a1, z0), o0t = P(ro, a0, z0 + h), o1t = P(ro, a1, z0 + h);
      const i0b = P(ri, a0, z0), i1b = P(ri, a1, z0), i0t = P(ri, a0, z0 + h), i1t = P(ri, a1, z0 + h);
      soup.push(...o0b, ...o1b, ...o1t, ...o0b, ...o1t, ...o0t);
      soup.push(...i0b, ...i1t, ...i1b, ...i0b, ...i0t, ...i1t);
      soup.push(...o0t, ...o1t, ...i1t, ...o0t, ...i1t, ...i0t);
      soup.push(...o0b, ...i1b, ...o1b, ...o0b, ...i0b, ...i1b);
    }
    const m = weld(new Float32Array(soup));
    const total = meshVolume(m);
    const r = cutAtZ0(m);
    expect(r.capLoops).toBe(2);
    expect(r.openLoops).toBe(0);
    expect(openEdgeCount(r.below!)).toBe(0);
    expect(openEdgeCount(r.above!)).toBe(0);
    const vb = meshVolume(r.below!), va = meshVolume(r.above!);
    expect(vb).toBeGreaterThan(0); expect(va).toBeGreaterThan(0);
    expect(vb + va).toBeCloseTo(total, 1);
    expect(vb / total).toBeCloseTo(4 / 12, 2);
  });
});

import { booleanMeshes } from '../src/state/tools';
import { sliceMesh } from '../src/engine/slice';
import { areaTotal } from '../src/engine/clipper';
describe('mesh boolean', () => {
  const cube = (x: number, s: number) => weld(box(x, 0, 0, s, s, s));
  it('union, difference and intersection of two overlapping cubes', () => {
    const a = cube(0, 10), b = cube(5, 10);
    expect(meshVolume(booleanMeshes(a, b, 'union'))).toBeCloseTo(1500, 0);
    expect(meshVolume(booleanMeshes(a, b, 'difference'))).toBeCloseTo(500, 0);
    expect(meshVolume(booleanMeshes(a, b, 'intersection'))).toBeCloseTo(500, 0);
    expect(openEdgeCount(booleanMeshes(a, b, 'union'))).toBe(0);
  });
  it('produces a mesh the slicer reads correctly (T-junctions repaired)', () => {
    const u = booleanMeshes(weld(box(0, 0, 0, 10, 10, 10)), weld(box(5, 3, 2, 10, 10, 10)), 'union');
    const zs = [1, 5, 9, 11];
    const areas = sliceMesh(u, zs).map((p) => +areaTotal(p).toFixed(1));
    expect(areas).toEqual([100, 165, 165, 100]);
  });
});
