import { describe, expect, it } from 'vitest';
import { PRINTERS } from '../src/profiles/printers';
import { effectiveNozzle, NOZZLES, resolveConfig } from '../src/profiles/resolve';
import { PROCESS_PRESETS } from '../src/profiles/settings';

describe('nozzle selection', () => {
  for (const p of PRINTERS) {
    it(`${p.vendor} ${p.model}: every nozzle gives a valid config`, () => {
      for (const nz of NOZZLES) {
        for (const preset of PROCESS_PRESETS) {
          const c = resolveConfig({ printerId: p.id, plate: p.plates[0].type, filamentId: 'generic-pla', presetId: preset.id, overrides: {}, machineOverrides: { nozzle_diameter: nz } });
          expect(c.nozzle_diameter).toBe(nz);
          const lh = Number(c.layer_height);
          expect(lh).toBeGreaterThanOrEqual(0.04 - 1e-9);
          expect(lh).toBeLessThanOrEqual(nz * 0.75 + 1e-9);
          expect(Number(c.initial_layer_print_height)).toBeLessThanOrEqual(nz * 0.75 + 1e-9);
          expect(Number(c.line_width)).toBeGreaterThanOrEqual(nz);
          expect(Number(c.max_layer_height)).toBeGreaterThanOrEqual(lh - 1e-9);
          expect(Number(c.min_layer_height)).toBeLessThanOrEqual(lh + 1e-9);
        }
      }
    });
  }
  it('defaults to the printer nozzle', () => {
    expect(effectiveNozzle('bbl-p1s', {})).toBe(0.4);
    expect(effectiveNozzle('bbl-p1s', { nozzle_diameter: 0.6 })).toBe(0.6);
  });
});
