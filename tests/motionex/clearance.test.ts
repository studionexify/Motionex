// No line in a layer may print over a moved wall: the slicer's spacing is restored after Motionex runs.
import { describe, expect, it } from 'vitest';
import { slice } from '../../src/engine/slicer';
import { weld } from '../../src/engine/mesh';
import { resolveConfig } from '../../src/profiles/resolve';
import { box, cylinder } from '../fixtures';
import { PRESETS } from '../../src/plugins/motionex/presets';
import { defaultToolhead } from '../../src/plugins/motionex/core/toolhead';
import { DEFAULT_OPTIONS } from '../../src/plugins/motionex/modifier';
import { clearOverlaps, segmentInCapsule } from '../../src/plugins/motionex/core/clearance';
import type { MotionexConfig } from '../../src/plugins/motionex/engine';
import { pt, type MotionApplication, type MotionBrush } from '../../src/plugins/motionex/model';
import type { Layer, ToolpathPoint } from '../../src/plugins/motionex/core/types';

const cfg = () => resolveConfig({ printerId: 'bbl-x1c', plate: 'textured_pei_plate', filamentId: 'generic-pla', presetId: '0.20', overrides: { enable_arc_fitting: false, sparse_infill_density: 20 } });
const sine = PRESETS.find((b) => b.id === 'preset-sine')!;
/** A deep motion that pushes the outer wall well into the part, with forward-and-back movement too. */
const deep = (along = 0): MotionBrush => ({ ...structuredClone(sine), id: 'deep', amplitude: 2.5, period_mm: 6,
  curves: { ...structuredClone(sine.curves), along_offset: along ? { interpolation: 'linear', points: [pt(0, 0), pt(0.5, along), pt(1, 0)] } : sine.curves.along_offset } });
const app = (): MotionApplication => ({ brush_id: 'deep', target: { type: 'body', walls: 'outer' }, mask: { z_start: 1, z_end: 1e4, fade_in_mm: 0, fade_out_mm: 0 }, order: 0, blend: 'add', enabled: true });
const mx = (b: MotionBrush): MotionexConfig => ({ applications: [app()], brushes: [b], options: DEFAULT_OPTIONS, collisionMode: 'clamp', toolhead: defaultToolhead('bbl-x1c'), printerId: 'bbl-x1c' });

type Seg = { ax: number; ay: number; bx: number; by: number; type: string };
/** Printing segments of one layer, by type, from the G-code. */
function layerSegs(gcode: string, z: string): Seg[] {
  const start = gcode.indexOf(`;Z:${z}\n`);
  const end = gcode.indexOf(';LAYER_CHANGE', start);
  const out: Seg[] = [];
  let type = '', x = NaN, y = NaN;
  for (const l of gcode.slice(start, end).split('\n')) {
    if (l.startsWith(';TYPE:')) type = l.slice(6);
    if (!/^G[0123] /.test(l)) continue;
    const mx = /X([-\d.]+)/.exec(l), my = /Y([-\d.]+)/.exec(l);
    const nx = mx ? +mx[1] : x, ny = my ? +my[1] : y;
    if (/ E[\d.]/.test(l) && !/ E-/.test(l) && Number.isFinite(x) && (nx !== x || ny !== y)) out.push({ ax: x, ay: y, bx: nx, by: ny, type });
    x = nx; y = ny;
  }
  return out;
}
function segDist(a: Seg, b: Seg): number {
  const pd = (px: number, py: number, s: Seg) => {
    const dx = s.bx - s.ax, dy = s.by - s.ay, L2 = dx * dx + dy * dy || 1;
    const u = Math.max(0, Math.min(1, ((px - s.ax) * dx + (py - s.ay) * dy) / L2));
    return Math.hypot(px - s.ax - u * dx, py - s.ay - u * dy);
  };
  const cross = (o: [number, number], p: [number, number], q: [number, number]) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
  const A: [number, number] = [a.ax, a.ay], B: [number, number] = [a.bx, a.by], C: [number, number] = [b.ax, b.ay], D: [number, number] = [b.bx, b.by];
  const d1 = cross(C, D, A), d2 = cross(C, D, B), d3 = cross(A, B, C), d4 = cross(A, B, D);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return 0;
  return Math.min(pd(a.ax, a.ay, b), pd(a.bx, a.by, b), pd(b.ax, b.ay, a), pd(b.bx, b.by, a));
}
/** Closest approach of any non-outer-wall line to the outer wall in a layer. */
function closest(gcode: string, z: string): { d: number; type: string; outer: number; others: number } {
  const segs = layerSegs(gcode, z);
  const outer = segs.filter((s) => s.type === 'Outer wall' || s.type === 'outer wall');
  const others = segs.filter((s) => !/outer wall/i.test(s.type));
  let d = Infinity, type = '';
  for (const o of others) for (const w of outer) { const x = segDist(o, w); if (x < d) { d = x; type = o.type; } }
  return { d, type, outer: outer.length, others: others.length };
}

describe('motion walls never share space with other lines', () => {
  const lw = 0.42, h = 0.2;
  // inner wall next to the outer wall: (0.42 + 0.45)/2 − h(1 − π/4) − tolerance; infill reaches in a little more
  const minAllowed = (0.42 + 0.42) / 2 - 0.15 * 0.45 - 0.03;

  for (const [name, mesh] of [['box', () => ({ id: 'b', name: 'b', ...weld(box(100, 100, 0, 30, 30, 6)) })], ['cylinder', () => ({ id: 'c', name: 'c', ...weld(cylinder(128, 128, 15, 6, 64)) })]] as const) {
    it(`${name}: infill and inner walls are cut back from a deep motion wall`, () => {
      const plain = slice([mesh()], cfg());
      expect(closest(plain.gcode, '3').d).toBeGreaterThan(minAllowed); // the slicer's own spacing
      for (const [what, b] of [['wave', { ...sine, id: 'deep' }], ['deep wave', deep(0)], ['deep wave with loops', deep(1.2)]] as const) {
        const out = slice([mesh()], cfg(), () => {}, { plugins: { motionex: mx(b) } });
        for (const z of ['2', '3', '4.4']) {
          const c = closest(out.gcode, z);
          expect(c.outer).toBeGreaterThan(100);
          expect(c.others).toBeGreaterThan(10);
          expect(c.d, `${what}: closest ${c.type} at ${c.d.toFixed(3)} mm (z ${z})`).toBeGreaterThan(minAllowed);
        }
      }
    });
  }
});

describe('inner walls follow a wave without breaking up', () => {
  it('a gentle wave adds no extra retractions: the inner walls are offsets of the wave, not cut pieces', () => {
    const mesh = () => ({ id: 'b', name: 'b', ...weld(box(100, 100, 0, 20, 20, 10)) });
    const retracts = (g: string) => (g.match(/^G1 E-/gm) ?? []).length;
    const plain = slice([mesh()], cfg());
    const out = slice([mesh()], cfg(), () => {}, { plugins: { motionex: mx({ ...sine, id: 'deep' }) } });
    expect(retracts(out.gcode)).toBeLessThanOrEqual(retracts(plain.gcode) * 1.1);
  });
});

describe('clearOverlaps', () => {
  it('finds the exact part of a segment inside a capsule', () => {
    const iv = segmentInCapsule(-2, 0, 2, 0, { ax: 0, ay: -5, bx: 0, by: 5, w: 0.4 }, 0.5)!;
    expect(iv[0]).toBeCloseTo(0.375, 9); expect(iv[1]).toBeCloseTo(0.625, 9);
    expect(segmentInCapsule(-2, 1, 2, 1, { ax: 0, ay: -5, bx: 0, by: 0, w: 0.4 }, 0.5)).toBeNull();
    const end = segmentInCapsule(-2, 0.3, 2, 0.3, { ax: 0, ay: -5, bx: 0, by: 0, w: 0.4 }, 0.5)!; // round end cap
    expect(end[0]).toBeCloseTo((2 - 0.4) / 4, 9); expect(end[1]).toBeCloseTo((2 + 0.4) / 4, 9);
  });

  it('cuts an infill line where it crosses a motion wall and keeps its order and plastic', () => {
    const P = (x: number, y: number, e = 0): ToolpathPoint => ({ x, y, z: 1, f: 50, flow: 1, e });
    const layer: Layer = { index: 3, z: 1, height: 0.2, paths: [
      { feature: 'outer_wall', closed: false, modifiedBy: 'motionex', points: [P(5, -5), P(5, 5)] },
      { feature: 'sparse_infill', closed: false, points: [P(0, 0), P(10, 0, 1)] },
    ] };
    expect(clearOverlaps(layer, () => 0.4, { layerHeight: 0.2, infillOverlap: 0.15, retractOver: 1, retractLength: 0.8 })).toBe(1);
    const pts = layer.paths[1].points;
    expect(layer.paths[1].clipped).toBe(true);
    expect(pts.map((q) => +q.x.toFixed(4))).toEqual([0, 4.66, 5.34, 10].map((v, i) => (i === 1 ? +(5 - (0.4 - 0.06 - 0.02)).toFixed(4) : i === 2 ? +(5 + 0.32).toFixed(4) : v)));
    expect(pts[2].travel).toBe(true);
    expect(pts[1].post?.retract_mm).toBeUndefined(); // 0.64 mm jump: no retraction needed
    const e = pts.reduce((s, q) => s + q.e, 0);
    expect(e).toBeCloseTo(1 - 0.064, 6); // the plastic of the cut part is gone, the rest kept
  });
});
