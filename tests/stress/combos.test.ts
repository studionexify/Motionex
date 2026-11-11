// Random combinations of settings at their limits: each slice must finish and pass the strict G-code validator.
// The seed is fixed so a failure replays.
import { describe, expect, it } from 'vitest';
import { slice } from '../../src/engine/slicer';
import { PROCESS_PARAMS, type Config, type ParamDef } from '../../src/profiles/settings';
import { box, cylinder, tee } from '../fixtures';
import { cfgWith, mesh, rng } from './helpers';
import { describeIssues, validateSlice } from './gcodeValidator';

const plate = () => [mesh(tee(128, 128), 'tee'), mesh(cylinder(128, 175, 8, 10, 48), 'cyl'), mesh(box(80, 80, 0, 0.8, 12, 6), 'thin')];

describe('random setting combinations', () => {
  const rnd = rng(7);
  const defs = PROCESS_PARAMS.filter((p) => p.type !== 'string' && p.type !== 'text');
  const pick = (p: ParamDef): Config[string] => {
    if (p.type === 'bool') return rnd() < 0.5;
    if (p.type === 'enum') { const o = p.options ?? []; return o[Math.floor(rnd() * o.length)]?.value ?? p.def; }
    if (p.type === 'floatOrPercent') return rnd() < 0.5 ? `${Math.round(rnd() * 400)}%` : String(+(rnd() * (p.max ?? 5)).toFixed(2));
    const lo = p.min ?? 0, hi = p.max ?? Math.max(10, Number(p.def) * 4);
    const r = rnd(), v = r < 0.25 ? lo : r < 0.5 ? hi : lo + (hi - lo) * rnd();
    return p.type === 'int' || p.type === 'percent' ? Math.round(v) : +v.toFixed(3);
  };
  for (let k = 0; k < 80; k++) {
    const o: Config = {};
    for (let j = 0; j < 8; j++) { const p = defs[Math.floor(rnd() * defs.length)]; o[p.key] = pick(p); }
    // the sweep looks for crashes and bad G-code, not for minutes-long 0.04 mm slices
    if (Number(o.layer_height) < 0.08) o.layer_height = 0.08;
    if (Number(o.raft_layers) > 5) o.raft_layers = 3;
    it(`combination ${k}: ${Object.entries(o).map(([a, b]) => `${a}=${b}`).join(', ')}`, () => {
      const cfg = cfgWith({ overrides: o });
      const out = slice(plate(), cfg);
      const issues = validateSlice(out, cfg, { allowZReset: o.print_sequence === 'by_object' });
      expect(issues, describeIssues(issues)).toEqual([]);
    });
  }
});

