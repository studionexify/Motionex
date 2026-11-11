// Thick-thread preview: real-size beads, no gap between layers, overhang check (sag and drips), and the
// weave's hand-made moves with the deviation cap.
import { describe, expect, it } from 'vitest';
import { cylinder } from '../fixtures';
import { weld } from '../../src/engine/mesh';
import { ThreadBuilder, SAFE_REACH, DRIP_REACH, linesToThreads, mergeThreads } from '../../src/plugins/threads';
import { buildWeaveThreads } from '../../src/plugins/motionex/weave/preview';
import { defaultWeave, type WeaveSettings } from '../../src/plugins/motionex/weave/model';
import { nudgeAt, offsetAt, planLayers } from '../../src/plugins/motionex/weave/core';
import { motifImage } from '../../src/plugins/motionex/weave/motifs';

const W = 0.42, H = 0.2;
const ring = (tb: ThreadBuilder, z: number, r: number, n = 120) => {
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2, b = ((i + 1) / n) * Math.PI * 2;
    tb.seg(r * Math.cos(a), r * Math.sin(a), z, r * Math.cos(b), r * Math.sin(b), z, [1, 1, 1]);
  }
};

describe('ThreadBuilder', () => {
  it('layers stacked on each other stay fused: no sag, no drips, no gap', () => {
    const tb = new ThreadBuilder(W, H);
    for (let l = 0; l < 5; l++) { tb.layer(); ring(tb, H / 2 + l * H, 20); }
    const { threads, report } = tb.finish();
    expect(report.level).toBe('ok');
    expect(report.drips).toBe(0);
    expect(threads.wh[1]).toBeCloseTo(H);
    // bead tops of neighbouring layers are exactly one layer height apart
    const per = 120, top = (l: number) => threads.start[(l * per) * 3 + 2];
    expect(top(1) - top(0)).toBeCloseTo(H, 5);
  });

  it('a layer that sits a line width out sags; far out it drips and the drips hang below the thread', () => {
    const tb = new ThreadBuilder(W, H);
    tb.layer(); ring(tb, H / 2, 20);
    tb.layer(); ring(tb, H / 2 + H, 20 + W * 0.8);
    const sag = tb.finish().report;
    expect(sag.sagging).toBeGreaterThan(0);
    expect(sag.worstMm).toBeCloseTo(W * 0.8, 1);

    const tb2 = new ThreadBuilder(W, H);
    tb2.layer(); ring(tb2, H / 2, 20);
    tb2.layer(); ring(tb2, H / 2 + H, 20 + W * 2);
    const { threads, report } = tb2.finish();
    expect(report.level).toBe('drip');
    expect(report.drips).toBeGreaterThan(0);
    expect(report.worstMm).toBeGreaterThan(W * DRIP_REACH);
    // a drip starts at the bottom of its bead and hangs down
    const z0 = threads.drips[2], len = threads.drips[3];
    expect(len).toBeGreaterThan(0.5);
    expect(z0).toBeLessThan(H / 2 + H);
    expect(SAFE_REACH).toBeLessThan(DRIP_REACH);
  });

  it('a thinned preview scales the reach by the layers each one stands for', () => {
    const tb = new ThreadBuilder(W, H);
    tb.layer(4); ring(tb, 0.4, 20);
    tb.layer(4); ring(tb, 1.2, 20 + W * 1.2); // 4 layers up and 1.2 lines out = 0.3 lines per layer
    expect(tb.finish().report.level).toBe('ok');
  });

  it('long travels leave a thin sagging string', () => {
    const tb = new ThreadBuilder(W, H);
    tb.string(0, 0, 1, 10, 0, 1, [1, 1, 1]);
    const { threads, report } = tb.finish();
    expect(report.strings).toBe(1);
    expect(Math.min(...Array.from({ length: threads.start.length / 3 }, (_, i) => threads.start[i * 3 + 2]))).toBeLessThan(1);
  });

  it('merges sets and keeps the worst reach', () => {
    const a = new ThreadBuilder(W, H); a.layer(); ring(a, 0.1, 10);
    const b = new ThreadBuilder(W, H); b.layer(); ring(b, 0.1, 10); b.layer(); ring(b, 0.3, 10 + W * 2);
    const m = mergeThreads([a.finish(), b.finish()])!;
    expect(m.report.level).toBe('drip');
    expect(m.threads.wh.length / 2).toBe(m.report.beads);
  });

  it('plain lines become beads at the real size', () => {
    const t = linesToThreads(Float32Array.from([0, 0, 1, 1, 0, 1]), Float32Array.from([1, 0, 0, 1, 0, 0]), W, H);
    expect(Array.from(t.wh)).toEqual([expect.closeTo(W), expect.closeTo(H)]);
    expect(t.start[2]).toBeCloseTo(1 + H / 2);
  });
});

describe('weave threads and hand-made moves', () => {
  const vase = { id: 'v', mesh: weld(cylinder(128, 128, 20, 12, 64)) };
  const weave = (o: Partial<WeaveSettings> = {}): WeaveSettings => ({ ...defaultWeave(), enabled: true, image: motifImage('checker', 32, 12, 2), z_start: 1, ...o });
  const col = () => [0.8, 0.8, 0.8] as [number, number, number];

  it('draws every layer as a loop at the real line size, with no sag at the default depth', () => {
    const t = buildWeaveThreads([vase], weave(), 0.2, 0.42, col)!;
    expect(t).toBeTruthy();
    expect(t.report.beads).toBeGreaterThan(5000);
    expect(t.report.level).toBe('ok');
    expect(t.threads.wh[0]).toBeGreaterThan(0.3);
  });

  it('a deep weave reaches too far out: it sags and drips, a shallow one does not', () => {
    const deep = buildWeaveThreads([vase], weave({ depth_mm: 1.2 }), 0.2, 0.42, col)!;
    expect(deep.report.level).toBe('drip');
    expect(deep.report.drips).toBeGreaterThan(0);
    const shallow = buildWeaveThreads([vase], weave({ depth_mm: 0.1 }), 0.2, 0.42, col)!;
    expect(shallow.report.drips).toBe(0);
  });

  it('depth beyond the old 0.35 mm limit is honoured', () => {
    const w = weave({ depth_mm: 1.5, recess: 0 });
    const P = planLayers(w, Array.from({ length: 40 }, (_, i) => 0.2 * (i + 1)))[10]!;
    const peak = Math.max(...Array.from({ length: 200 }, (_, i) => offsetAt(w, P, i / 200)));
    expect(peak).toBeGreaterThan(0.35);
  });

  it('hand-made moves shift the picked pixels on every layer of that pixel and respect the cap', () => {
    const img = motifImage('checker', 16, 8, 2);
    const w = weave({ image: img, recess: 0, stitch: 0, depth_mm: 0.1, nudge: { w: 16, h: 8, d: {} } });
    const P = planLayers(w, Array.from({ length: 60 }, (_, i) => 0.2 * (i + 1)))[12]!;
    const u = 0.5 / 16; // middle of column 0
    const before = offsetAt(w, P, u);
    w.nudge!.d[P.row * 16 + 0] = 0.7;
    expect(nudgeAt(w, P.row, 0.5)).toBeCloseTo(0.7);
    expect(offsetAt(w, P, u)).toBeCloseTo(before + 0.7, 6);
    w.nudge!.d[P.row * 16 + 0] = 9;
    expect(offsetAt(w, P, u)).toBeCloseTo(w.max_deviation_mm); // capped
    // a map made for another grid size is ignored
    w.nudge = { w: 8, h: 8, d: { 0: 5 } };
    expect(nudgeAt(w, P.row, 0.5)).toBe(0);
  });
});
