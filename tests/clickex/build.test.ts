import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { openEdgeCount } from '../../src/engine/mesh';
import { meshVolume } from '../../src/engine/mesh';
import { buildClicker, heightsOf, printParts } from '../../src/plugins/clickex/build';
import { SAMPLES, sampleArt } from '../../src/plugins/clickex/samples';
import { defaultSpec } from '../../src/plugins/clickex/model';
import { planBlocks, planSingle } from '../../src/plugins/clickex/plan';
import { registerFont } from '../../src/plugins/patternex/tools/text';

const font = () => { const b = readFileSync('src/plugins/patternex/tools/fonts/inter.woff'); return registerFont('inter', b.buffer.slice(b.byteOffset, b.byteOffset + b.length) as ArrayBuffer); };

describe('Clickex single clicker', () => {
  it('builds a closed base and button for every sample', () => {
    for (const s of SAMPLES) {
      const spec = defaultSpec();
      const plan = planSingle(spec, sampleArt(s.id));
      const built = buildClicker(spec, plan);
      expect(built.parts.length, s.id).toBe(2);
      for (const p of built.parts) {
        expect(p.mesh.indices.length, `${s.id} ${p.key}`).toBeGreaterThan(0);
        expect(openEdgeCount(p.mesh), `${s.id} ${p.key} open edges`).toBe(0);
        expect(meshVolume(p.mesh), `${s.id} ${p.key} volume`).toBeGreaterThan(0);
      }
      expect(plan.fits, s.id).toBe(true);
    }
  });

  it('puts the switch hole at the plate and the socket under the ceiling', () => {
    const spec = defaultSpec();
    const H = heightsOf(spec);
    expect(H.engage).toBeGreaterThan(3);
    expect(H.bossBottom).toBeGreaterThan(H.plateTop + spec.sw.housingTop);
    expect(H.ceil).toBeGreaterThan(H.bossBottom + H.stub - 1e-6);
    expect(H.skirtBottom).toBeGreaterThan(H.shoulder + spec.sw.travel);
  });

  it('flips the button onto its face', () => {
    const spec = defaultSpec();
    const built = buildClicker(spec, planSingle(spec, sampleArt('heart')));
    const printed = printParts(built);
    for (const p of printed) {
      let min = Infinity;
      for (let i = 2; i < p.mesh.vertices.length; i += 3) min = Math.min(min, p.mesh.vertices[i]);
      expect(min).toBeCloseTo(0, 4);
    }
  });

  it('grows the base when the switch does not fit and the base is not locked', () => {
    const spec = defaultSpec();
    spec.shape.baseStyle = 'shape'; spec.shape.baseShape = 'circle'; spec.shape.size = 20;
    const plan = planSingle(spec, sampleArt('star'));
    expect(plan.fits).toBe(true);
    expect(plan.grown).toBeTruthy();
    spec.shape.lockBase = true;
    const locked = planSingle(spec, sampleArt('star'));
    expect(locked.fits).toBe(false);
    expect(locked.minSize).toBeGreaterThan(20);
  });

  it('colour inlay creates one palette entry per design colour; raise adds relief above the top', () => {
    const spec = defaultSpec();
    const art = sampleArt('pumpkin');
    const plan = planSingle(spec, art);
    const b = buildClicker(spec, plan);
    const btn = b.parts[1];
    expect(btn.palette.length).toBeGreaterThanOrEqual(3);
    spec.colors.mode = 'raise';
    const r = buildClicker(spec, planSingle(spec, art));
    let max = 0;
    for (let i = 2; i < r.parts[1].mesh.vertices.length; i += 3) max = Math.max(max, r.parts[1].mesh.vertices[i]);
    expect(max).toBeCloseTo(r.heights.capTop + spec.colors.raise, 3);
  });

  it('attaches a keychain loop', () => {
    const spec = defaultSpec();
    spec.keychain.enabled = true;
    const plan = planSingle(spec, sampleArt('heart'));
    expect(plan.loop.length).toBeGreaterThan(0);
    const built = buildClicker(spec, plan);
    expect(openEdgeCount(built.parts[0].mesh)).toBe(0);
  });
});

describe('Clickex blocks', () => {
  it('Name makes four keys, each with its own button', () => {
    const spec = defaultSpec();
    spec.source = 'blocks';
    const plan = planBlocks(spec, font());
    expect(plan.units.length).toBe(4);
    const built = buildClicker(spec, plan);
    expect(built.parts.length).toBe(5);
    for (const p of built.parts) expect(openEdgeCount(p.mesh)).toBe(0);
  });

  it('WASD and arrows use four keys in a T', () => {
    const spec = defaultSpec();
    spec.source = 'blocks';
    for (const layout of ['wasd', 'arrows'] as const) {
      spec.blocks.layout = layout;
      const plan = planBlocks(spec, font());
      expect(plan.units.length).toBe(4);
      expect(plan.units.filter((u) => u.art.length).length).toBe(4);
    }
  });
});
