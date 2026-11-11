import { describe, expect, it } from 'vitest';
import { buildBody, buildInsert, buildSaucer } from '../../src/plugins/plantex/mesh';
import { defaultSpec, normalizeSpec, textureLayer } from '../../src/plugins/plantex/model';
import { paintBody } from '../../src/plugins/plantex/paint';
import { PRESETS } from '../../src/plugins/plantex/presets';
import type { IndexedMesh } from '../../src/engine/mesh';

/** Every directed edge appears once and its reverse appears once: closed and consistently wound. */
function manifold(m: IndexedMesh) {
  const e = new Map<string, number>();
  const ix = m.indices;
  for (let t = 0; t < ix.length; t += 3) for (let k = 0; k < 3; k++) {
    const key = `${ix[t + k]},${ix[t + (k + 1) % 3]}`;
    e.set(key, (e.get(key) ?? 0) + 1);
  }
  let bad = 0;
  for (const [k, n] of e) { const [a, b] = k.split(','); if (n !== 1 || e.get(`${b},${a}`) !== 1) bad++; }
  return bad;
}
function volume(m: IndexedMesh) {
  const v = m.vertices, ix = m.indices; let s = 0;
  for (let t = 0; t < ix.length; t += 3) {
    const a = ix[t] * 3, b = ix[t + 1] * 3, c = ix[t + 2] * 3;
    s += v[a] * (v[b + 1] * v[c + 2] - v[b + 2] * v[c + 1]) - v[a + 1] * (v[b] * v[c + 2] - v[b + 2] * v[c]) + v[a + 2] * (v[b] * v[c + 1] - v[b + 1] * v[c]);
  }
  return s / 6;
}

describe('plantex mesh', () => {
  it('walled planter with drain holes is closed and outward', () => {
    const s = defaultSpec(); s.drain = { enabled: true, center: 12, count: 5, diameter: 6, ring: 0.6 };
    const r = buildBody(s, undefined, true);
    expect(manifold(r.mesh)).toBe(0);
    expect(volume(r.mesh)).toBeGreaterThan(0);
  });
  it('cut-through textures stay closed', () => {
    const s = defaultSpec();
    s.textures = [textureLayer({ kind: 'lattice', mode: 'cut', countU: 12, countV: 6, cutLevel: 0.3 }), textureLayer({ kind: 'ribs', mode: 'emboss', depth: 1 })];
    const r = buildBody(s, undefined, true);
    expect(manifold(r.mesh)).toBe(0);
    expect(volume(r.mesh)).toBeGreaterThan(0);
  });
  it('smooth filleted holes, feet and rim rounding stay closed', () => {
    for (const fillet of [0, 0.6, 1.2]) {
      const s = defaultSpec();
      s.fillet = fillet; s.rimRound = fillet;
      s.feet = { enabled: true, count: 4, height: 3, size: 10, ring: 0.7 };
      s.drain = { enabled: true, center: 14, count: 6, diameter: 5, ring: 0.6 };
      s.textures = [textureLayer({ kind: 'voronoi', mode: 'cut', countU: 10, countV: 4, shape: 0.3, invert: true, z0: 0.1, z1: 0.9 })];
      const r = buildBody(s, undefined, true);
      expect(manifold(r.mesh), `fillet ${fillet}`).toBe(0);
      expect(volume(r.mesh)).toBeGreaterThan(0);
    }
  });
  it('self-watering planter and insert are closed', () => {
    const s = defaultSpec();
    s.profile = [{ z: 0, r: 45 }, { z: 1, r: 60 }];
    s.selfWater = { enabled: true, reservoir: 25, gap: 1.5, wall: 1.6, wick: 14, slots: 8, overflow: 6 };
    const body = buildBody(s, undefined, true), ins = buildInsert(s, undefined, true);
    expect(manifold(body.mesh)).toBe(0);
    expect(manifold(ins.mesh)).toBe(0);
    expect(volume(ins.mesh)).toBeGreaterThan(0);
    expect(ins.warnings).toEqual([]);
  });
  it('colour layers paint only their area of the outer wall', () => {
    const s = defaultSpec();
    s.textures = [textureLayer({ kind: 'rings', countU: 1, countV: 6, depth: 0, filament: 1 })];
    const r = buildBody(s, undefined, true);
    const p = paintBody(r.mesh, s, () => undefined)!;
    const n = p.filter((c) => c === 2).length;
    expect(n).toBeGreaterThan(p.length * 0.05);
    expect(n).toBeLessThan(p.length * 0.6);
    s.textures[0].filament = -1;
    expect(paintBody(r.mesh, s, () => undefined)).toBeUndefined();
  });
  it('vase mode is one closed solid', () => {
    const s = { ...defaultSpec(), vaseMode: true, twist: 90 };
    const r = buildBody(s, undefined, true);
    expect(manifold(r.mesh)).toBe(0);
    expect(volume(r.mesh)).toBeGreaterThan(0);
  });
  it('saucer is closed', () => {
    const r = buildSaucer(defaultSpec(), true);
    expect(manifold(r.mesh)).toBe(0);
    expect(volume(r.mesh)).toBeGreaterThan(0);
  });
  it('every preset builds a closed mesh', { timeout: 120_000 }, () => {
    expect(PRESETS.length).toBeGreaterThanOrEqual(40);
    for (const p of PRESETS) {
      const r = buildBody(normalizeSpec(p.spec), undefined, true);
      expect(manifold(r.mesh), p.spec.name).toBe(0);
      expect(volume(r.mesh), p.spec.name).toBeGreaterThan(0);
      expect(r.mesh.vertices.every(Number.isFinite), p.spec.name).toBe(true);
    }
  });
});
