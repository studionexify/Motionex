import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { DST_COMPOSITE_AI, DST_DIGITAL_CREATION, hasDisclosure, readPngText, tagJpeg, tagPng, type DisclosureInfo } from '../../src/renex/metadata';
import { ALL_SWATCHES, FINISHES, FINISH_KINDS, finishFor } from '../../src/renex/materials';
import { rigidFit } from '../../src/renex/source';
import { GROUP, defaultPrintSettings, preparePrinted } from '../../src/renex/printSurface';
import { PLANTS, buildPlant } from '../../src/renex/plants';
import { CANDELA_TO_WORLD, buildBulb, buildSoil, kelvinToRGB, lumens } from '../../src/renex/components';
import { buildBackdrop, BACKDROPS, exposureFor, frameCamera } from '../../src/renex/scenes';
import { buildScene, flatLayout } from '../../src/renex/engine';
import { defaultSetup } from '../../src/renex/profiles';
import type { RenexSceneSource } from '../../src/renex/source';

// 1×1 PNG and a minimal JPEG (SOI + EOI) are enough to test the container writers
const PNG_1PX = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
const JPEG_MIN = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
const info: DisclosureInfo = { title: 'Spiral planter', source: 'Plantex', details: ['Layer height 0.2 mm'], aiAssisted: false };

/** Closed cylinder soup (Z up, on the bed). */
function cylinder(r: number, h: number, n = 48): Float32Array {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2;
    const p0 = [Math.cos(a0) * r, Math.sin(a0) * r], p1 = [Math.cos(a1) * r, Math.sin(a1) * r];
    out.push(p0[0], p0[1], 0, p1[0], p1[1], 0, p1[0], p1[1], h, p0[0], p0[1], 0, p1[0], p1[1], h, p0[0], p0[1], h);
    out.push(0, 0, h, p0[0], p0[1], h, p1[0], p1[1], h);
    out.push(0, 0, 0, p1[0], p1[1], 0, p0[0], p0[1], 0);
  }
  return new Float32Array(out);
}

describe('Renex disclosure metadata', () => {
  it('writes PNG text chunks + XMP with the IPTC digital source type', () => {
    const tagged = tagPng(PNG_1PX, info);
    const t = readPngText(tagged);
    expect(t.Software).toBe('NexSpiro Renex');
    expect(t.Description).toMatch(/Not a photograph/);
    expect(t['XML:com.adobe.xmp']).toContain(DST_DIGITAL_CREATION);
    expect(hasDisclosure(tagged)).toBe(true);
    // the image data is untouched: IEND still last
    expect(Array.from(tagged.subarray(-8, -4)).map((c) => String.fromCharCode(c)).join('')).toBe('IEND');
  });
  it('marks AI-assisted images as composite with trained algorithmic media', () => {
    const t = readPngText(tagPng(PNG_1PX, { ...info, aiAssisted: true, aiProvider: 'Test' }));
    expect(t['XML:com.adobe.xmp']).toContain(DST_COMPOSITE_AI);
    expect(t.Description).toMatch(/generative AI/);
  });
  it('writes EXIF, XMP and a comment into JPEG', () => {
    const tagged = tagJpeg(JPEG_MIN, info);
    expect(tagged[0]).toBe(0xff); expect(tagged[1]).toBe(0xd8);
    expect(tagged[2]).toBe(0xff); expect(tagged[3]).toBe(0xe1);
    expect(hasDisclosure(tagged)).toBe(true);
    expect(new TextDecoder('latin1').decode(tagged)).toContain('Exif');
  });
});

describe('Renex materials', () => {
  it('maps filament names to finishes', () => {
    expect(finishFor('PETG', 'Bambu PETG Translucent')).toBe('PETG Translucent');
    expect(finishFor('PLA', 'PLA Silk+')).toBe('PLA Silk');
    expect(finishFor('PLA', 'PolyTerra Matte')).toBe('PLA Matte');
    expect(finishFor('PLA Wood', 'PLA Wood')).toBe('PLA Wood');
    expect(finishFor('PA-CF', '')).toBe('PA-CF');
    expect(finishFor('TPU', '95A')).toBe('TPU');
  });
  it('has physically plausible values for every finish', () => {
    for (const k of FINISH_KINDS) {
      const f = FINISHES[k];
      expect(f.ior).toBeGreaterThan(1.3); expect(f.ior).toBeLessThan(1.7);
      expect(f.roughness).toBeGreaterThan(0); expect(f.roughness).toBeLessThanOrEqual(1);
      expect(f.transmission).toBeGreaterThanOrEqual(0); expect(f.transmission).toBeLessThanOrEqual(1);
    }
  });
  it('ships brand and NexSpiro swatches with valid hex', () => {
    expect(ALL_SWATCHES.length).toBeGreaterThanOrEqual(300);
    for (const s of ALL_SWATCHES) expect(s.hex).toMatch(/^#[0-9a-fA-F]{6}$/);
  });
});

describe('Renex geometry', () => {
  it('recovers a rigid transform between vertex sets', () => {
    const a = cylinder(20, 40);
    const m = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(0.4, -1.1, 2.0)).setPosition(12, -7, 30);
    const b = new Float32Array(a.length);
    const v = new THREE.Vector3();
    for (let i = 0; i < a.length; i += 3) { v.set(a[i], a[i + 1], a[i + 2]).applyMatrix4(m); b.set([v.x, v.y, v.z], i); }
    const fit = rigidFit(a, b);
    for (let i = 0; i < 60; i += 3) {
      v.set(a[i], a[i + 1], a[i + 2]).applyMatrix4(fit);
      expect(v.distanceTo(new THREE.Vector3(b[i], b[i + 1], b[i + 2]))).toBeLessThan(1e-3);
    }
  });
  it('splits a printed part into wall / top / bed groups with layer-aligned UVs', () => {
    const s = defaultPrintSettings();
    const r = preparePrinted({ name: 'cyl', soup: cylinder(30, 50), toScene: new THREE.Matrix4(), hex: '#cc5533', finish: 'PLA' }, s);
    const mesh = r.meshes[0];
    const groups = mesh.geometry.groups.map((g) => g.materialIndex);
    expect(groups).toEqual([GROUP.wall, GROUP.top, GROUP.bottom]);
    // wall v coordinate = z / (layer height × 64): the top rim is at 50 / 12.8
    const uv = mesh.geometry.getAttribute('uv') as THREE.BufferAttribute;
    const wall = mesh.geometry.groups[0];
    let maxV = 0;
    for (let i = wall.start; i < wall.start + wall.count; i++) maxV = Math.max(maxV, uv.getY(i));
    expect(maxV).toBeCloseTo(50 / (s.layerHeight * 64), 2);
    const mats = mesh.material as THREE.MeshPhysicalMaterial[];
    expect(mats[0].normalMap).toBeTruthy();
  });
  it('adds support columns under overhangs when supports are attached', () => {
    // a T: thin post with a wide cap → the cap underside overhangs
    const post = cylinder(4, 20), cap = cylinder(25, 5);
    for (let i = 2; i < cap.length; i += 3) cap[i] += 20;
    const soup = new Float32Array([...post, ...cap]);
    const r = preparePrinted({ name: 'T', soup, toScene: new THREE.Matrix4(), hex: '#fff', finish: 'PLA' }, { ...defaultPrintSettings(), supports: 'attached' });
    expect(r.meshes.length).toBe(2);
    const sup = new THREE.Box3().setFromObject(r.meshes[1]);
    expect(sup.min.z).toBeLessThan(1);
    expect(sup.max.z).toBeLessThan(20.01);
  });
  it('lays parts out flat without overlap', () => {
    const parts = [0, 1, 2].map((k) => ({ key: `p${k}`, name: `p${k}`, printSoup: cylinder(30, 10), assembled: new THREE.Matrix4(), hex: '#fff', finish: 'PLA' as const, colourName: '', materialName: '' }));
    const ms = flatLayout(parts);
    const boxes = ms.map((m) => new THREE.Box3(new THREE.Vector3(-30, -30, 0), new THREE.Vector3(30, 30, 10)).applyMatrix4(m));
    expect(boxes[0].intersectsBox(boxes[1])).toBe(false);
    expect(boxes[1].intersectsBox(boxes[2])).toBe(false);
  });
});

describe('Renex plants', () => {
  it('has a large catalogue', () => { expect(PLANTS.length).toBeGreaterThanOrEqual(70); });
  it('builds every plant as finite, sensibly sized geometry', () => {
    for (const def of PLANTS) {
      const g = buildPlant(def, { seed: 3, rimRadius: 60, rimAboveSoil: 15 });
      const box = new THREE.Box3().setFromObject(g);
      expect(box.isEmpty(), def.id).toBe(false);
      const size = box.getSize(new THREE.Vector3());
      for (const v of [size.x, size.y, size.z]) { expect(Number.isFinite(v), def.id).toBe(true); expect(v, def.id).toBeLessThan(def.height * 4 + def.spread * 4); }
      g.traverse((o) => { const m = o as THREE.Mesh; if (m.geometry) { const p = m.geometry.getAttribute('position'); for (let i = 0; i < p.array.length; i += 97) expect(Number.isFinite(p.array[i]), def.id).toBe(true); } });
    }
  });
});

describe('Renex lighting and scenes', () => {
  it('bulb light carries the real luminous intensity in world units', () => {
    const b = buildBulb({ profile: [[13.5, 0], [13.5, 25], [30, 60], [28, 90], [0.5, 108]], watts: 8, lit: true, kelvin: 2700, glass: 'clear', base: 'screw' });
    let light: THREE.PointLight | undefined;
    b.traverse((o) => { if ((o as THREE.PointLight).isPointLight) light = o as THREE.PointLight; });
    expect(light).toBeTruthy();
    expect(light!.intensity).toBeCloseTo((lumens(8) / (4 * Math.PI)) * CANDELA_TO_WORLD, 3);
    const off = buildBulb({ profile: [[13.5, 0], [30, 60], [0.5, 108]], watts: 8, lit: false, kelvin: 2700, glass: 'clear', base: 'screw' });
    let any = false; off.traverse((o) => { if ((o as THREE.Light).isLight) any = true; });
    expect(any).toBe(false);
  });
  it('warm white is warmer than daylight', () => {
    const w = kelvinToRGB(2700), d = kelvinToRGB(6500);
    expect(w.r / w.b).toBeGreaterThan(d.r / d.b);
  });
  it('exposure halves per EV', () => { expect(exposureFor(10) / exposureFor(11)).toBeCloseTo(2, 6); });
  it('builds every backdrop', () => { for (const b of BACKDROPS) expect(buildBackdrop({ id: b.id, colour: '#eeeeee', radius: 60, height: 150 })).toBeTruthy(); });
  it('soil fills the pot opening', () => {
    const s = buildSoil({ radius: 50, z: 80, dressing: 'pebbles', moisture: 0.5 });
    const box = new THREE.Box3().setFromObject(s);
    expect(box.max.x).toBeLessThanOrEqual(50.5);
    expect(box.min.z).toBeGreaterThan(78);
  });
  it('frames the product with a thin-lens aperture of f / N', () => {
    const cam = Object.assign(new THREE.PerspectiveCamera(), { fStop: 1.4, focusDistance: 1, apertureBlades: 0 });
    const box = new THREE.Box3(new THREE.Vector3(-0.5, 0, -0.5), new THREE.Vector3(0.5, 1.5, 0.5));
    frameCamera(cam, box, { az: 30, el: 15, focal: 85, fNumber: 8, fill: 0.7, dolly: 1, focusZ: 0, blades: 9 }, 1, 0.01);
    // aperture (world) = 85 mm / 8 · 0.01 → fStop field = focal / aperture
    expect(cam.getFocalLength() / cam.fStop).toBeCloseTo((85 / 8) * 0.01, 6);
    expect(cam.focusDistance).toBeGreaterThan(1);
  });
});

describe('Renex scene assembly', () => {
  const src = (): RenexSceneSource => ({
    source: 'plantex', title: 'Test pot', print: defaultPrintSettings(), warnings: [],
    parts: [{ key: 'body', name: 'Pot', printSoup: cylinder(50, 90), assembled: new THREE.Matrix4(), hex: '#c0603f', finish: 'PLA Matte', colourName: 'Terracotta', materialName: 'PLA Matte' }],
    planter: { kind: 'planter', soilZ: 80, soilRadius: 47, rimZ: 90, rimRadius: 50 },
  });
  it('puts the product on the floor with soil and plant', () => {
    const b = buildScene(src(), { ...defaultSetup('plantex'), plants: [{ id: 'snake-plant', scale: 1, seed: 1 }] }, 1);
    expect(b.scene.getObjectByName('Soil')).toBeTruthy();
    expect(b.scene.getObjectByName('Snake plant')).toBeTruthy();
    // world is Y-up in decimetres: a 90 mm pot spans 0.9 units above the floor
    expect(b.productBox.min.y).toBeCloseTo(0, 3);
    expect(b.productBox.max.y).toBeGreaterThan(0.9);
    expect(b.scene.environment).toBeTruthy();
  });
  it('hides parts and switches to the flat-lay', () => {
    const s = src();
    const b = buildScene(s, { ...defaultSetup('plantex'), layout: 'parts', plants: [] }, 1);
    expect(b.scene.getObjectByName('Soil')).toBeFalsy();
    const h = buildScene(s, { ...defaultSetup('plantex'), parts: { body: { hidden: true } }, plants: [] }, 1);
    expect(h.scene.getObjectByName('Pot')).toBeFalsy();
  });
});

describe('Renex batch + lamps', () => {
  it('expands sizes × shots × light states', async () => {
    const { batchJobs } = await import('../../src/renex/profiles');
    const { SHOTS } = await import('../../src/renex/scenes');
    const base = defaultSetup('lumonex');
    const jobs = batchJobs(base, { aspects: ['1:1', '9:16'], shots: ['hero', 'side'], light: 'both' }, SHOTS, true);
    expect(jobs.length).toBe(8);
    expect(new Set(jobs.map((j) => j.label)).size).toBe(8);
    expect(jobs.find((j) => j.label === '9:16-side-off'.replace(/[^\w-]+/g, '_'))?.setup.height).toBe(2048);
    expect(batchJobs(base, { aspects: [], shots: [], light: 'current' }, SHOTS, true).length).toBe(1);
  });
  it('every Lumonex lamp type has a light source, wall sconces included', async () => {
    const { buildLamp } = await import('../../src/plugins/lumonex/build');
    const { defaultDesign } = await import('../../src/plugins/lumonex/model');
    for (const kind of ['table', 'wall', 'pendant', 'floor', 'ceiling', 'lantern', 'mount'] as const) {
      const parts = buildLamp({ ...defaultDesign(kind), showBulb: true }, { x: 256, y: 256, z: 256 }).parts;
      expect(parts.some((p) => p.key === 'ghost-bulb' && p.soup.length), kind).toBe(true);
    }
  });
});

describe('Renex model import', () => {
  it('groups CAD meshes by colour into a few parts that stand on the table', async () => {
    const { partsFromMeshes } = await import('../../src/renex/cad/importModel');
    const cube = (dx: number, color?: [number, number, number]) => {
      const p = new Float32Array([0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0, 0, 0, 10, 10, 0, 10, 10, 10, 10, 0, 10, 10]);
      for (let i = 0; i < p.length; i += 3) { p[i] += dx; p[i + 2] += 50; }
      return { name: `c${dx}`, color, positions: p, indices: new Uint32Array([0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6]) };
    };
    const meshes = [cube(0, [1, 0, 0]), cube(20, [1, 0, 0]), ...Array.from({ length: 30 }, (_, i) => cube(40 + i * 20, [0, i / 30, 1]))];
    const parts = partsFromMeshes(meshes, 12);
    expect(parts.length).toBe(12);
    for (const p of parts) {
      let minZ = Infinity; for (let i = 2; i < p.printSoup.length; i += 3) minZ = Math.min(minZ, p.printSoup[i]);
      expect(minZ).toBeCloseTo(0, 5);
    }
    expect(parts.reduce((s, p) => s + p.printSoup.length / 9, 0)).toBe(meshes.length * 4);
  });
});
