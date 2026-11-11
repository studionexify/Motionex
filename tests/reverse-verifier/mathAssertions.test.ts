// Self-tests for the locked assertions: each must PASS on correct synthetic geometry and FAIL on the exact bug it guards.
import { describe, expect, it } from 'vitest';
import {
  type GMove, checkVolumetricConservation, checkWeaveAlternation, checkSpiroSignature, checkContinuity, checkRampAngle,
  reconstructPointCloud, expectedE,
} from './mathAssertions';

const D = 1.75, W = 0.42, H = 0.2;
function ring(layer: number, z: number, r: (th: number) => number, N = 720, eFn?: (dL: number, dz: number) => number): GMove[] {
  const out: GMove[] = [];
  let px = r(0), py = 0;
  out.push({ type: 'G0', x: px, y: py, z, e: 0, f: 3000, isExtruding: false, layerIndex: layer, line: 0 });
  for (let n = 1; n <= N; n++) {
    const th = (n / N) * 2 * Math.PI, rr = r(th);
    const x = rr * Math.cos(th), y = rr * Math.sin(th);
    const dL = Math.hypot(x - px, y - py);
    out.push({ type: 'G1', x, y, z, e: eFn ? eFn(dL, 0) : expectedE(dL, W, H, 1, 'rect', D), f: 3000, isExtruding: true, layerIndex: layer, layerHeight: H, feature: 'wall', line: n });
    px = x; py = y;
  }
  return out;
}
const opts = { filamentDiameter: D, width: () => W, crossSection: 'rect' as const };

describe('volumetric conservation', () => {
  it('passes with true 3-D lengths on a helical ramp', () => {
    const m: GMove[] = [{ type: 'G0', x: 0, y: 0, z: 0, e: 0, f: 1, isExtruding: false, layerIndex: 0, line: 1 }];
    for (let k = 1; k <= 50; k++) m.push({ type: 'G1', x: k, y: 0, z: k * 0.8, e: expectedE(Math.hypot(1, 0.8), W, H, 1, 'rect', D), f: 1, isExtruding: true, layerIndex: 0, layerHeight: H, line: k + 1 });
    expect(checkVolumetricConservation(m, opts).pass).toBe(true);
  });
  it('FAILS the 2-D-instead-of-3-D distance bug', () => {
    const m: GMove[] = [{ type: 'G0', x: 0, y: 0, z: 0, e: 0, f: 1, isExtruding: false, layerIndex: 0, line: 1 }];
    for (let k = 1; k <= 50; k++) m.push({ type: 'G1', x: k, y: 0, z: k * 0.8, e: expectedE(1, W, H, 1, 'rect', D), f: 1, isExtruding: true, layerIndex: 0, layerHeight: H, line: k + 1 });
    const r = checkVolumetricConservation(m, opts);
    expect(r.pass).toBe(false);
    expect(r.metrics.maxRelErrPct).toBeGreaterThan(2);
  });
  it('FAILS a 3 % flow error and un-retracted extrusion', () => {
    const a = ring(0, 0.2, () => 20, 360, (dL) => expectedE(dL, W, H, 1.03, 'rect', D));
    expect(checkVolumetricConservation(a, opts).pass).toBe(false);
    const b: GMove[] = [
      { type: 'G0', x: 0, y: 0, z: 0.2, e: 0, f: 1, isExtruding: false, layerIndex: 0, line: 1 },
      { type: 'G1', x: 0, y: 0, z: 0.2, e: -0.8, f: 1, isExtruding: false, layerIndex: 0, line: 2 },
      { type: 'G1', x: 5, y: 0, z: 0.2, e: expectedE(5, W, H, 1, 'rect', D), f: 1, isExtruding: true, layerIndex: 0, layerHeight: H, line: 3 },
    ];
    expect(checkVolumetricConservation(b, opts).pass).toBe(false);
  });
});

describe('weave / spiro signatures', () => {
  const L = 6, A = 1;
  const wave = (ph: number) => (th: number) => 20 + A * Math.cos(L * th + ph);
  it('real alternating weave passes; stacked identical waves fail', () => {
    const weave = [0, 1, 2, 3].flatMap((l) => ring(l, 0.2 * (l + 1), wave(l % 2 ? Math.PI : 0)));
    const stacked = [0, 1, 2, 3].flatMap((l) => ring(l, 0.2 * (l + 1), wave(0)));
    const c = { x: 0, y: 0 };
    expect(checkWeaveAlternation(reconstructPointCloud(weave), { center: c, lobes: L, amplitude: A }).pass).toBe(true);
    expect(checkWeaveAlternation(reconstructPointCloud(stacked), { center: c, lobes: L, amplitude: A }).pass).toBe(false);
  });
  it('spiro lobe count and amplitude', () => {
    const pts = reconstructPointCloud(ring(0, 0.2, wave(0)));
    expect(checkSpiroSignature(pts, { center: { x: 0, y: 0 }, lobes: L, amplitude: A }).pass).toBe(true);
    expect(checkSpiroSignature(pts, { center: { x: 0, y: 0 }, lobes: L + 1, amplitude: A }).pass).toBe(false);
    expect(checkSpiroSignature(pts, { center: { x: 0, y: 0 }, lobes: L, amplitude: 1.5 }).pass).toBe(false);
  });
});

describe('continuity & ramp', () => {
  it('flags a travel jump inside a continuous span and a steep ramp', () => {
    const m = ring(0, 0.2, () => 10, 60);
    const j: GMove = { type: 'G0', x: 30, y: 30, z: 0.2, e: 0, f: 1, isExtruding: false, layerIndex: 0, line: 99 };
    const c = { maxJump: 1, zMode: 'monotonic' as const };
    expect(checkContinuity(m, c).pass).toBe(true);
    expect(checkContinuity([...m, j, ...m], c).pass).toBe(false);
    const steep: GMove[] = [m[0], { ...m[1], z: 0.2 + 2 }];
    expect(checkRampAngle(steep, 45).pass).toBe(false);
    expect(checkRampAngle(m, 45).pass).toBe(true);
  });
});

import { checkZWeaveAntiPhase, beadArea } from './mathAssertions';
describe('z-weave & models', () => {
  const mk = (flip: boolean) => {
    const pts = [];
    for (let l = 3; l < 8; l++) for (let x = 0; x < 20; x += 0.5) for (let y = 0; y < 20; y += 0.5) pts.push({ x, y, z: 0.2 * l + (flip && l % 2 ? -1 : 1) * 0.1 * Math.sin(x) * Math.sin(y), layer: l });
    return pts;
  };
  it('anti-phase passes, same-phase fails', () => {
    const o = { fromLayer: 3, cell: 0.5, minAmplitude: 0.02 };
    expect(checkZWeaveAntiPhase(mk(true), o).pass).toBe(true);
    expect(checkZWeaveAntiPhase(mk(false), o).pass).toBe(false);
  });
  it('circle bead area', () => { expect(beadArea('circle', 0.4, 0.2)).toBeCloseTo(Math.PI * 0.04, 9); });
});

describe('vertical plunges', () => {
  const P = { tipRadius: 0.5, coneAngleDeg: 40, tipLen: 2.2, margin: 0.2, beadHalfWidth: 0.2 };
  const bead = (x: number, y: number, z: number): GMove => ({ type: 'G1', x, y, z, e: 0.01, f: 1, isExtruding: true, layerIndex: 0, line: 1 });
  const wall = (r: number, z: number): GMove[] => {
    const m: GMove[] = [{ type: 'G0', x: r, y: 0, z, e: 0, f: 1, isExtruding: false, layerIndex: 0, line: 0 }];
    for (let k = 1; k <= 120; k++) m.push(bead(r * Math.cos((k / 120) * 2 * Math.PI), r * Math.sin((k / 120) * 2 * Math.PI), z));
    return m;
  };
  const plunge = (): GMove[] => [{ type: 'G0', x: 0, y: 0, z: 1.0, e: 0, f: 1, isExtruding: false, layerIndex: 1, line: 500 }, { ...bead(0, 0, 1.4), line: 501, layerIndex: 1 }];
  it('exempts a plunge into a clear void, flags one beside a wall, and a too-deep one', () => {
    expect(checkRampAngle([...wall(3, 1.2), ...plunge()], 10, P).pass).toBe(true);
    expect(checkRampAngle([...wall(0.9, 1.2), ...plunge()], 10, P).pass).toBe(false);
    expect(checkRampAngle([...wall(3, 1.2), { type: 'G0', x: 0, y: 0, z: 0.5, e: 0, f: 1, isExtruding: false, layerIndex: 1, line: 500 }, { ...bead(0, 0, 3.4), line: 501, layerIndex: 1 }], 10, P).pass).toBe(false);
    expect(checkRampAngle(plunge(), 10).pass).toBe(false); // without plunge options the 90 deg rule still applies
  });
  it('treats a steep diagonal like a plunge: exempt only through a clear cone, and joined strands do not count', () => {
    const diag = (): GMove[] => [{ type: 'G0', x: 0, y: 0, z: 1.8, e: 0, f: 1, isExtruding: false, layerIndex: 1, line: 500 }, { ...bead(2.6, 0, 0.0 + 0.2), line: 501, layerIndex: 1 }];
    expect(checkRampAngle([...wall(6, 1.2), ...diag()], 10, P).pass).toBe(true);
    expect(checkRampAngle([...wall(1.2, 1.9), ...diag()], 10, P).pass).toBe(false);
  });
});
