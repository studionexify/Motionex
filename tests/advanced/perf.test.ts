// Regression: the Zone Inspector must stay quick on parts with many islands or with pieces off the bed
// (switching to Advanced runs it straight away).
import { expect, it } from 'vitest';
import { analyzePart } from '../../src/engine/advanced/analysis';
import { morseRouter, reebGraph } from '../../src/engine/advanced/modules/morse';
import { partStress } from '../../src/engine/advanced/stress';
import { box, cylinder } from '../fixtures';
import { indexed, sphere } from './shapes';

const part = (soup: Float32Array) => { const m = indexed(soup); return analyzePart({ vertices: m.vertices, indices: m.indices }, { cells: 64, shell: 0.84, lineWidth: 0.42, layerHeight: 0.2, overhangDeg: 30 } as any); };

it('Reeb graph of 100 islands per plane stays fast and keeps one branch per pillar', () => {
  const s: number[] = [];
  for (let i = 0; i < 10; i++) for (let j = 0; j < 10; j++) s.push(...cylinder(i * 8, j * 8, 2, 30, 24));
  const a = part(new Float32Array([...box(-4, -4, 0, 80, 80, 2), ...s]));
  const t = performance.now();
  morseRouter.inspect!(a);
  const g = reebGraph(a, 1.5);
  expect(performance.now() - t).toBeLessThan(8000);
  expect(g.branches.length).toBe(101); // the base and one branch per pillar

}, 60000);

it('FEA holds pieces that touch no fixture instead of failing to converge', () => {
  const s: number[] = [...box(-10, -10, 0, 20, 20, 10)];
  for (let i = 0; i < 4; i++) s.push(...sphere(30 + i * 15, 0, 20, 5, 24, 12));
  const ps = partStress(part(new Float32Array(s)), { maxEl: 4000, newtons: 50 })!;
  expect(ps).toBeTruthy();
  expect(ps.load.source).toMatch(/floating/);
  expect(ps.iterations).toBeLessThan(3000);
  expect(Number.isFinite(ps.vm.reduce((m, v) => Math.max(m, v), 0))).toBe(true);
}, 60000);
