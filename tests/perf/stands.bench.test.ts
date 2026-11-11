// Wall-clock benchmark of the whole pipeline on a plate of wavy stands (opt-in: NEXSPIRO_BENCH=1).
import { it } from 'vitest';
import { slice } from '../../src/engine/slicer';
import { resolveConfig } from '../../src/profiles/resolve';
import { holdersPlate, standsPlate } from './stands';

const run = process.env.NEXSPIRO_BENCH ? it : it.skip;
run('slices 9 wavy stands', () => {
  const n = Number(process.env.NEXSPIRO_N ?? 9);
  const cfg = resolveConfig({ printerId: 'bbl-p1s', plate: 'textured_pei_plate', filamentId: 'generic-pla', presetId: '0.20', overrides: {} });
  const meshes = process.env.NEXSPIRO_SHAPE === 'wavy' ? standsPlate(n) : holdersPlate(n);
  const tris = meshes.reduce((a, m) => a + m.indices.length / 3, 0);
  const marks: string[] = [];
  let t0 = performance.now(), last = '';
  const out = slice(meshes, cfg, (stage) => { if (stage !== last) { const t = performance.now(); if (last) marks.push(`${last}: ${((t - t0) / 1000).toFixed(1)}s`); t0 = t; last = stage; } });
  marks.push(`${last}: ${((performance.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`tris=${tris} layers=${out.layers.length} gcode=${(out.gcode.length / 1e6).toFixed(1)}MB\n${marks.join('\n')}`);
}, 3_600_000);
import { afterAll } from 'vitest';
afterAll(() => { const st = (globalThis as any).__clipStats ?? {}; Object.entries<any>(st).sort((a, b) => b[1].ms - a[1].ms).slice(0, 25).forEach(([k, v]) => console.log(`${v.ms.toFixed(0).padStart(7)}ms n=${v.n} avgV=${(v.pts / v.n).toFixed(0)} ${k}`)); });
