// Every process, machine and filament setting at the ends of what its input accepts (and 0, and every option):
// the slice must finish and the G-code must pass the strict validator.
import { describe, expect, it } from 'vitest';
import { slice } from '../../src/engine/slicer';
import { PROCESS_PARAMS, type ParamDef } from '../../src/profiles/settings';
import { MACHINE_PARAMS } from '../../src/profiles/machineParams';
import { FILAMENT_PARAMS } from '../../src/profiles/filamentParams';
import { box, cylinder, tee } from '../fixtures';
import { cfgWith, edgeValues, mesh } from './helpers';
import { describeIssues, validateSlice } from './gcodeValidator';

// an overhanging T (supports, bridges), a round part with curved walls, and a wall two lines thick
const plate = () => [mesh(tee(128, 128), 'tee'), mesh(cylinder(128, 170, 10, 8, 48), 'cyl'), mesh(box(90, 90, 0, 0.9, 15, 6), 'thin')];

const groups: [string, ParamDef[], 'overrides' | 'machineOverrides' | 'filamentOverrides'][] = [
  ['process', PROCESS_PARAMS, 'overrides'], ['printer', MACHINE_PARAMS, 'machineOverrides'], ['filament', FILAMENT_PARAMS, 'filamentOverrides'],
];

for (const [name, defs, field] of groups) {
  describe(`${name} settings at their limits`, () => {
    for (const p of defs) {
      const vals = edgeValues(p);
      if (!vals.length) continue;
      it(`${p.key} = ${vals.map((v) => JSON.stringify(v)).join(' | ')}`, () => {
        for (const v of vals) {
          const cfg = cfgWith({ [field]: { [p.key]: v } });
          const out = slice(plate(), cfg);
          // printing by object starts every object again from the first layer
          const issues = validateSlice(out, cfg, { allowZReset: p.key === 'print_sequence' });
          expect(issues, `${p.key}=${JSON.stringify(v)}\n${describeIssues(issues)}`).toEqual([]);
          expect(out.stats.filamentMm, `${p.key}=${JSON.stringify(v)} printed nothing`).toBeGreaterThan(0);
        }
      });
    }
  });
}
