// Hanex inside the real Nexspiro slicer: a T-shaped part (10 mm pillar, 40 mm slab on top) sliced with
// and without the plugin.
import { describe, test } from 'vitest';
import assert from 'node:assert/strict';
import { slice } from '../../src/engine/slicer';
import { weld } from '../../src/engine/mesh';
import { resolveConfig } from '../../src/profiles/resolve';
import { box, tee } from '../fixtures';
import { preset } from '../../src/plugins/hanex/core/profile';
import { angleSpecimen, prismsToSoup } from '../../src/plugins/hanex/core/calibration';
import { layerTrigger, printProfile, type HanexConfig, type HanexReport } from '../../src/plugins/hanex/engine';

const cfg = (o = {}) => resolveConfig({ printerId: 'bbl-p1s', plate: 'textured_pei_plate', filamentId: 'generic-pla', presetId: '0.20', overrides: { enable_support: false, ...o } });
const mesh = (soup: Float32Array) => { const m = weld(soup); return { id: 'part', name: 'part', vertices: m.vertices, indices: m.indices }; };
const config = (o: Partial<HanexConfig> = {}): HanexConfig => ({ profile: preset('hanex-pla'), tipDiameter: 1.0, minArea: 4, ...o });

describe('Hanex in the slicer (T part)', () => {
  const c = cfg();
  const plain = slice([mesh(tee(120, 120))], c);
  const out = slice([mesh(tee(120, 120))], c, () => {}, { plugins: { hanex: config() } });
  const rep = out.pluginReports?.hanex as HanexReport;

  test('waves exactly on the first slab layer, both wings', () => {
    assert.ok(rep, 'report');
    assert.equal(rep.layers.length, 1, JSON.stringify(rep.layers));
    const L = rep.layers[0];
    assert.ok(Math.abs(L.z - 10.2) < 0.05, `z ${L.z}`);
    assert.equal(L.regions, 2);
    assert.ok(L.arcs > 40);
    // two wings of 15 × 10 mm
    assert.ok(Math.abs(L.area - 300) < 3, `area ${L.area}`);
    assert.deepEqual(rep.warnings, []);
  });

  test('G-code: Nexspiro bridge/overhang extrusion inside the wings is replaced by wave moves', () => {
    const lines = out.gcode.split('\n');
    assert.ok(lines.some((l) => l === ';TYPE:wave overhang'));
    assert.ok(lines.includes('M106 S255'));
    assert.ok(out.stats.byFeature.wave_overhang && out.stats.byFeature.wave_overhang.filamentMm > 0);
    assert.ok(rep.removedMm > 100, `removed ${rep.removedMm} mm`);
    // the plain slice bridges the wings; with Hanex the bridge filament on that layer drops
    const bridge = (g: string) => {
      const ls = g.split('\n'); let on = false, layer = false, e = 0;
      for (const l of ls) {
        if (l.startsWith(';Z:')) layer = Math.abs(Number(l.slice(3)) - 10.2) < 0.05;
        if (l.startsWith(';TYPE:')) on = l === ';TYPE:bridge' || l === ';TYPE:overhang wall';
        const m = /E([\d.]+)/.exec(l);
        if (layer && on && l.startsWith('G1') && m) e += Number(m[1]);
      }
      return e;
    };
    assert.ok(bridge(plain.gcode) > 1, 'plain slice bridges');
    assert.ok(bridge(out.gcode) < bridge(plain.gcode) * 0.2, `${bridge(out.gcode)} vs ${bridge(plain.gcode)}`);
  });

  test('extruder state is balanced: net retraction over the file equals the plain slice', () => {
    const net = (g: string) => g.split('\n').filter((l) => /^G1 E-?[\d.]+ F/.test(l)).reduce((s, l) => s + Number(/E(-?[\d.]+)/.exec(l)![1]), 0);
    assert.ok(Math.abs(net(out.gcode) - net(plain.gcode)) < 1e-6, `${net(out.gcode)} vs ${net(plain.gcode)}`);
  });

  test('wave moves keep their calibrated speed through cooling slowdown', () => {
    const lines = out.gcode.split('\n');
    const i = lines.indexOf(';TYPE:wave overhang');
    const f = lines.slice(i, i + 40).map((l) => /F(\d+)/.exec(l)?.[1]).find(Boolean);
    assert.equal(Number(f), preset('hanex-pla').waveSpeed * 60);
  });
});

test('plain box: Hanex does nothing', () => {
  const out = slice([mesh(box(100, 100, 0, 20, 20, 10))], cfg(), () => {}, { plugins: { hanex: config() } });
  const rep = out.pluginReports?.hanex as HanexReport;
  assert.equal(rep.layers.length, 0);
  assert.ok(!out.gcode.includes('wave overhang'));
});

test('toolhead sets the face-angle limit; a user limit narrows what is waved', () => {
  const p = printProfile(config(), cfg() as Record<string, unknown>);
  const wide = printProfile(config({ tipDiameter: 1.6 }), cfg() as Record<string, unknown>);
  assert.ok(layerTrigger(wide, 0.2) > layerTrigger(p, 0.2), 'wider land bridges more by itself');
  // 95° rising face at 0.2 mm: band 2.29 mm is waved by default, not when the user caps at 93°
  assert.ok(layerTrigger(p, 0.2) < 2.28);
  assert.ok(layerTrigger(p, 0.2, 93) > 2.29);
});

describe('support blocking and face-angle limit', () => {
  test('with supports on, no support is generated under the wave regions', () => {
    const c = cfg({ enable_support: true });
    const plain = slice([mesh(tee(120, 120))], c);
    const out = slice([mesh(tee(120, 120))], c, () => {}, { plugins: { hanex: config() } });
    const sup = (o: typeof out) => (o.stats.byFeature.support?.filamentMm ?? 0) + (o.stats.byFeature.support_interface?.filamentMm ?? 0);
    assert.ok(sup(plain) > 10, `plain support ${sup(plain)}`);
    assert.ok(sup(out) < 0.05 * sup(plain), `hanex support ${sup(out)} vs ${sup(plain)}`);
    assert.ok(out.gcode.includes(';TYPE:wave overhang'));
  });

  test('a rising underside past the print head limit warns but still slices', () => {
    // 110°: each layer adds 0.2/tan 20° = 0.55 mm — a whole bead in the air, below the 1.0 mm trigger
    const out = slice([mesh(prismsToSoup(angleSpecimen(110, 0.2)).map((v, i) => (i % 3 === 2 ? v : v + 100)))], cfg(), () => {}, { plugins: { hanex: config() } });
    const rep = out.pluginReports?.hanex as HanexReport;
    assert.ok(rep.pastLimit.length >= 3, `${rep.pastLimit.length} past-limit layers`);
    assert.ok(out.warnings.some((w) => w.includes('past this print head') && w.includes('continue')));
    assert.ok(out.gcode.length > 1000);
  });
});
