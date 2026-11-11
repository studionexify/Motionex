// Calibration prints, profile maths and multi-layer detection on arbitrary geometry.
// Writes the G-code when HANEX_TEST_PRINTS=<dir> is set:
//   HANEX_TEST_PRINTS=out/hanex npx vitest run tests/hanex/calibration.test.ts
// Printer overrides as JSON in HANEX_PRINTER, e.g. HANEX_PRINTER='{"bedX":256,"bedY":256,"nozzleTemp":220}'
import { describe, test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { applyCalibration, buildTestPrint, calibrationSuite, DEFAULT_PRINTER, angleSpecimen, type Prism } from '../../src/plugins/hanex/core/calibration';
import { faceBand, maxWaveFaceAngle, minOverlapForTip, needsWaves, preset, PRESETS, validateProfile, waveStep } from '../../src/plugins/hanex/core/profile';
import { detectOverhangs } from '../../src/plugins/hanex/core/detect';
import { toPaths } from '../../src/plugins/hanex/core/geom';
import { union } from '../../src/engine/clipper';

const OUT = process.env.HANEX_TEST_PRINTS;
const printer = { ...DEFAULT_PRINTER, ...(process.env.HANEX_PRINTER ? JSON.parse(process.env.HANEX_PRINTER) : {}) };
const base = preset(process.env.HANEX_PROFILE ?? 'hanex-pla');

describe('profile maths', () => {
  test('presets are valid', () => { for (const p of PRESETS) assert.deepEqual(validateProfile(p), [], p.id); });
  test('wave step Δd = w(1 − overlap)', () => assert.ok(Math.abs(waveStep(base) - 0.45 * 0.5) < 1e-12));
  test('face band b = h / tan(φ − 90°): flat ceiling is unbounded, 95° at 0.2 mm is 2.286 mm', () => {
    assert.equal(faceBand(90, 0.2), Infinity);
    assert.ok(Math.abs(faceBand(95, 0.2) - 0.2 / Math.tan((5 * Math.PI) / 180)) < 1e-12);
    assert.ok(Math.abs(faceBand(95, 0.2) - 2.286) < 1e-3);
    assert.ok(needsWaves(90, 0.2, base) && needsWaves(95, 0.2, base));
    assert.ok(!needsWaves(140, 0.2, base)); // 50° rise: a normal overhang
    const lim = maxWaveFaceAngle(0.2, base);
    assert.ok(needsWaves(lim - 0.01, 0.2, base) && !needsWaves(lim + 0.01, 0.2, base));
  });
  test('nozzle land bound: Δd ≤ (tip − w)/2', () => {
    const p = { ...base, overlap: minOverlapForTip(base) - 0.05 };
    assert.ok(validateProfile(p).some((e) => e.includes('nozzle land')));
    assert.deepEqual(validateProfile({ ...base, overlap: minOverlapForTip(base) }), []);
  });
  test('applyCalibration writes winners and rejects nonsense', () => {
    const p = applyCalibration(base, { overlap: 0.6, waveSpeed: 2, flowRatio: 1.15, seedMode: 'edge' });
    assert.equal(p.overlap, 0.6); assert.equal(p.waveSpeed, 2); assert.equal(p.flowRatio, 1.15); assert.equal(p.seedMode, 'edge');
    assert.ok(p.rimSpeed <= 2.6);
    assert.throws(() => applyCalibration(base, { overlap: 1.2 }));
  });
});

describe('detection on stacked geometry', () => {
  const slice = (prisms: Prism[], z: number) => union(prisms.filter((p) => p.z0 < z && z < p.z1).flatMap((p) => toPaths(p.rings)));
  test('flat tab: exactly one wave layer, at the tab bottom', () => {
    const prisms = angleSpecimen(90, 0.2);
    const hits: number[] = [];
    for (let z = 0.3; z < 7.2; z += 0.2) if (detectOverhangs(slice(prisms, z), slice(prisms, z - 0.2), base).components.length) hits.push(Math.round(z * 10) / 10);
    assert.deepEqual(hits, [6.1]);
  });
  test('95° rising tab: every layer of the rise gets a band of h/tan 5° and is waved', () => {
    const prisms = angleSpecimen(95, 0.2);
    let layers = 0;
    for (let z = 6.1; z < 7.4; z += 0.2) {
      const d = detectOverhangs(slice(prisms, z), slice(prisms, z - 0.2), base);
      if (!d.components.length) continue;
      layers++;
      const area = d.components.reduce((s, c) => s + c.area, 0);
      // band width × tab width (16 mm), first layer is half a band (prism mid-height)
      assert.ok(area <= 16 * faceBand(95, 0.2) * 1.001, `area ${area}`);
    }
    assert.ok(layers >= 6, `${layers} wave layers`);
  });
  test('thin ledge (below trigger width) is left to the normal slicer', () => {
    const prisms: Prism[] = [{ rings: [[[0, 0], [20, 0], [20, 10], [0, 10]]], z0: 0, z1: 5 }, { rings: [[[0, 10], [20, 10], [20, 10.6], [0, 10.6]]], z0: 4, z1: 5 }];
    assert.equal(detectOverhangs(slice(prisms, 4.1), slice(prisms, 3.9), base).components.length, 0);
  });
});

describe('calibration prints', () => {
  const suite = calibrationSuite(base, printer);
  test('suite covers every tunable and validation case', () => {
    assert.deepEqual(suite.map((t) => t.id), ['HNX-01', 'HNX-02', 'HNX-03', 'HNX-04', 'HNX-05', 'HNX-06', 'HNX-07', 'HNX-08']);
  });
  for (const tp of suite) test(`${tp.id} ${tp.title}: builds clean G-code`, () => {
    const { gcode, report } = buildTestPrint(tp, printer);
    assert.deepEqual(report.problems, []);
    for (const s of report.specimens) {
      assert.ok(s.layers >= 1 && s.arcs > 0, `${s.label}: ${s.layers} layers, ${s.arcs} arcs`);
      assert.deepEqual(s.warnings, [], s.label);
    }
    const lines = gcode.split('\n');
    assert.ok(lines.includes('M83 ; relative E'));
    assert.ok(lines.some((l) => l.startsWith('M106 P0 S') && l.includes('Hanex')));
    // every coordinate on the bed, E finite
    for (const l of lines) {
      const x = /X(-?[\d.]+)/.exec(l), y = /Y(-?[\d.]+)/.exec(l), e = /E(-?[\d.]+)/.exec(l);
      if (l.startsWith(';')) continue;
      if (x) assert.ok(+x[1] >= 0 && +x[1] <= printer.bedX, l);
      if (y) assert.ok(+y[1] >= 0 && +y[1] <= printer.bedY, l);
      if (e) assert.ok(Number.isFinite(+e[1]), l);
    }
    if (OUT) {
      fs.mkdirSync(OUT, { recursive: true });
      const name = `${tp.id}-${tp.title.replace(/[^\w]+/g, '-').replace(/-+$/, '')}`;
      fs.writeFileSync(path.join(OUT, `${name}.gcode`), gcode);
      fs.writeFileSync(path.join(OUT, `${name}.report.json`), JSON.stringify(report, null, 2));
    }
  }, 120_000);
});
