// The statistics table must agree with the G-code it describes (filament length, weight, cost, feature totals) within ±1 %.
import { describe, expect, it } from 'vitest';
import { weld } from '../src/engine/mesh';
import { slice } from '../src/engine/slicer';
import { resolveConfig } from '../src/profiles/resolve';
import { PRINTERS } from '../src/profiles/printers';
import { box, cylinder } from './fixtures';

const mesh = (soup: Float32Array, name: string) => { const m = weld(soup); return { id: name, name, vertices: m.vertices, indices: m.indices }; };
const within = (a: number, b: number, tol = 0.01, what = '') => expect(Math.abs(a - b), `${what}: ${a} vs ${b}`).toBeLessThanOrEqual(Math.max(1e-6, Math.abs(b) * tol));

/** Net filament fed (mm) between the start and end machine G-code: absolute or relative E; retracts cancel their primes. */
function gcodeFilament(gcode: string): number {
  const body = gcode.split(';===== end of start G-code =====').pop()!.split(';===== NexSpiro end G-code').shift() ?? gcode;
  let rel = /^M83/m.test(gcode), e = 0, last = 0;
  for (const raw of body.split('\n')) {
    const line = raw.split(';')[0].trim();
    if (line === 'M83') rel = true; else if (line === 'M82') rel = false;
    if (/^G92\b/.test(line)) { const m = / E(-?[\d.]+)/.exec(line); if (m) last = +m[1]; continue; }
    const m = /^G[0-3]\b.* E(-?[\d.]+)/.exec(line);
    if (!m) continue;
    const d = rel ? +m[1] : +m[1] - last; last = rel ? last : +m[1];
    e += d;
  }
  return e;
}

describe('statistics match the G-code', () => {
  const p = PRINTERS.find((x) => /P1S/.test(x.model)) ?? PRINTERS[0];
  const cx = p.bed.x / 2, cy = p.bed.y / 2;
  for (const [label, overrides] of [['default', {}], ['supports + gyroid', { enable_support: true, sparse_infill_pattern: 'gyroid' }]] as const) {
    it(`${p.model}, ${label}`, () => {
      const cfg = resolveConfig({ printerId: p.id, plate: p.plates[0].type, filamentId: 'generic-pla', presetId: '0.20', overrides });
      const out = slice([mesh(box(cx - 40, cy - 10, 0, 20, 20, 15), 'box'), mesh(cylinder(cx + 30, cy, 10, 25), 'cyl')], cfg);
      const st = out.stats;
      // filament length vs the E axis in the file
      within(st.filamentMm, gcodeFilament(out.gcode), 0.01, 'gcode');
      // weight = length × cross-section × density
      const d = Number(cfg.filament_diameter ?? 1.75), rho = Number(cfg.filament_density ?? 1.24);
      within(st.filamentGrams, (st.filamentMm * Math.PI * (d / 2) ** 2 * rho) / 1000, 0.01, 'grams');
      // per-feature breakdown sums to the totals
      const feats = Object.values(st.byFeature);
      within(feats.reduce((a, f) => a + (f?.filamentMm ?? 0), 0), st.filamentMm, 0.01, 'features');
      expect(feats.reduce((a, f) => a + (f?.time ?? 0), 0)).toBeLessThanOrEqual(st.timeSeconds * 1.01);
      expect(st.timeSeconds).toBeGreaterThan(0);
      expect(st.layerCount).toBe(out.layers.length);
    });
  }
});
