// Regressions for slicing big plates: no argument-limit blowups, chunked G-code, memoised polygon work,
// and overlapping parts / modifiers.
import { describe, expect, it } from 'vitest';
import { weld } from '../src/engine/mesh';
import { slice } from '../src/engine/slicer';
import { difference, intersection, offset, union } from '../src/engine/clipper';
import { joinLines, lineCount, pushAll, TypedBuilder } from '../src/engine/util';
import { resolveConfig } from '../src/profiles/resolve';
import { box, cylinder } from './fixtures';

const cfg = (overrides = {}) => resolveConfig({ printerId: 'bbl-p1s', plate: 'textured_pei_plate', filamentId: 'generic-pla', presetId: '0.20', overrides });
const mesh = (soup: Float32Array, name = 'part', parts: { type: string; soup: Float32Array; overrides?: Record<string, unknown> }[] = []) => {
  const m = weld(soup);
  return {
    id: name, name, vertices: m.vertices, indices: m.indices,
    parts: parts.map((p) => { const w = weld(p.soup); return { type: p.type, overrides: p.overrides ?? {}, vertices: w.vertices, indices: w.indices }; }),
  } as any;
};
const cat = (...a: Float32Array[]) => { const o = new Float32Array(a.reduce((n, x) => n + x.length, 0)); let k = 0; for (const x of a) { o.set(x, k); k += x.length; } return o; };

describe('large data', () => {
  it('pushAll takes arrays that spread cannot', () => {
    const src = Array.from({ length: 600_000 }, (_, i) => i);
    expect(() => ([] as number[]).push(...src)).toThrow(RangeError);
    expect(pushAll([], src).length).toBe(600_000);
  });
  it('joins a few hundred thousand lines, numbered or not', () => {
    const lines = Array.from({ length: 350_000 }, (_, i) => (i % 5 === 0 ? `; c${i}` : `G1 X${i}`));
    const g = joinLines(lines);
    expect(g.endsWith('G1 X349999\n')).toBe(true);
    expect(lineCount(g)).toBe(350_001);
    const n = joinLines(lines, true).split('\n');
    expect(n[1]).toBe('N1 G1 X1');
    expect(n[0]).toBe('; c0');
  });
  it('typed builder crosses block boundaries', () => {
    const b = new TypedBuilder(Float32Array, 8);
    for (let i = 0; i < 100; i++) b.push(i, -i);
    const a = b.toTyped();
    expect(a.length).toBe(200);
    expect(a[198]).toBe(99); expect(a[199]).toBe(-99);
  });
});

describe('polygon memo', () => {
  it('returns equal results that can be edited without poisoning later calls', () => {
    const sq = (s: number) => [[{ X: 0, Y: 0 }, { X: s, Y: 0 }, { X: s, Y: s }, { X: 0, Y: s }]];
    const a = Array.from({ length: 40 }, (_, i) => ({ X: Math.round(100000 * Math.cos(i / 6.4)), Y: Math.round(100000 * Math.sin(i / 6.4)) }));
    const r1 = offset([a], -3), r2 = offset([a], -3);
    expect(r2).toEqual(r1);
    r1[0].length = 0; r1.push([]);
    expect(offset([a], -3)).toEqual(r2);
    const u1 = union([a], sq(50000)), u2 = union([a], sq(50000));
    expect(u2).toEqual(u1);
    expect(intersection([a], sq(50000))).toEqual(intersection([a], sq(50000)));
    expect(difference([a], sq(50000))).toEqual(difference([a], sq(50000)));
  });
});

describe('overlapping parts', () => {
  const body = () => box(100, 100, 0, 30, 30, 10);
  const used = (m: any[], c = cfg()) => slice(m, c).stats.filamentMm;
  const cyl = (x: number) => cylinder(x, 115, 6, 10, 48);
  it('a negative made of overlapping shells cuts like one', () => {
    const none = used([mesh(body())]);
    const single = used([mesh(body(), 'a', [{ type: 'negative', soup: cyl(115) }])]);
    const doubled = used([mesh(body(), 'a', [{ type: 'negative', soup: cat(cyl(115), cyl(115)) }])]);
    expect(Math.abs(single - none)).toBeGreaterThan(10);
    expect(doubled).toBeCloseTo(single, 3);
  });
  it('overlapping negative parts cut their union', () => {
    const one = used([mesh(body(), 'a', [{ type: 'negative', soup: cyl(115) }])]);
    const two = used([mesh(body(), 'a', [{ type: 'negative', soup: cyl(115) }, { type: 'negative', soup: cyl(117) }])]);
    const apart = used([mesh(body(), 'a', [{ type: 'negative', soup: cyl(110) }, { type: 'negative', soup: cyl(120) }])]);
    expect(two).toBeLessThan(one);
    expect(two).toBeGreaterThan(apart * 0.9); // the overlap is removed once, not twice
    expect(apart).toBeLessThan(one);
  });
  it('a later modifier wins where modifiers overlap', () => {
    const big = box(95, 95, 0, 40, 40, 10), half = box(95, 95, 0, 20, 40, 10);
    const solid = { type: 'modifier', soup: big, overrides: { sparse_infill_density: 100 } };
    const empty = { type: 'modifier', soup: half, overrides: { sparse_infill_density: 0 } };
    const c = cfg({ sparse_infill_density: 15, top_shell_layers: 0, bottom_shell_layers: 0 });
    const a = used([mesh(box(100, 100, 0, 30, 30, 10), 'a', [solid, empty])], c);
    const b = used([mesh(box(100, 100, 0, 30, 30, 10), 'a', [empty, solid])], c);
    expect(a).toBeLessThan(b);
  });
});

describe('identical layers', () => {
  it('slice output of an extruded body is stable and its layers repeat', () => {
    const out = slice([mesh(cylinder(110, 110, 12, 20, 96))], cfg());
    expect(out.layers.length).toBe(100);
    expect(out.warnings).toEqual([]);
    expect(slice([mesh(cylinder(110, 110, 12, 20, 96))], cfg()).gcode).toBe(out.gcode);
  });
});
