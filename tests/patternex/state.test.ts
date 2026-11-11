import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { builtinPattern, newPlacement } from '../../src/plugins/patternex';
import { createPatternexState, defaultActions, savePatternexState, toPatternexConfig, toWorldPlacements, type ObjPlacement } from '../../src/plugins/patternex/ui/state';

const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }; };
const pat = builtinPattern('checker');
const place = (o: Partial<ObjPlacement> = {}): ObjPlacement => ({ ...newPlacement('a', pat, 'o1:0', [0, 10, 5], [0, 1, 0]), object_id: 'o1', ...o });

describe('Patternex UI state', () => {
  it('follows the object: local placement → plate coordinates with rotation, translation and scale', () => {
    const m = new THREE.Matrix4().compose(new THREE.Vector3(100, 50, 0), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, Math.PI / 2)), new THREE.Vector3(2, 1, 1));
    const [w] = toWorldPlacements([place()], [{ id: 'o1', matrix: m.elements }]);
    // local (0,10,5) → scale (0,10,5) → rotate 90° about Z (-10,0,5) → +(100,50,0)
    expect(w.position_xyz.map((v) => +v.toFixed(6))).toEqual([90, 50, 5]);
    // the +Y face normal turns to -X
    expect(w.projection_axis.map((v) => +v.toFixed(6))).toEqual([-1, 0, 0]);
    expect(w.object).toBe(0);
  });

  it('non-uniform scale keeps normals perpendicular to the surface', () => {
    const m = new THREE.Matrix4().makeScale(4, 1, 1);
    const [w] = toWorldPlacements([place({ projection_axis: [Math.SQRT1_2, Math.SQRT1_2, 0] })], [{ id: 'o1', matrix: m.elements }]);
    // a 45° face stretched 4× in X leans towards Y: normal ∝ (1/4, 1, 0)
    expect(w.projection_axis[1] / w.projection_axis[0]).toBeCloseTo(4, 6);
  });

  it('hidden placements and missing objects are left out; config only carries what is used', () => {
    const s = createPatternexState(null);
    s.patterns.push(pat, builtinPattern('dots'));
    s.placements.push(place(), place({ id: 'b', visible: false }), place({ id: 'c', object_id: 'gone' }));
    s.actions.push(...defaultActions('a', pat, 3), ...defaultActions('b', pat, 3));
    const c = toPatternexConfig(s, [{ id: 'o1', matrix: new THREE.Matrix4().elements }])!;
    expect(c.placements.map((p) => p.id)).toEqual(['a']);
    expect(c.patterns.map((p) => p.id)).toEqual([pat.id]);
    expect(c.actions.every((a) => a.region_ref.placement_id === 'a')).toBe(true);
    expect(toPatternexConfig(createPatternexState(null), [])).toBeUndefined();
  });

  it('default actions: the first colour stays base, others take slots 2, 3…; one colour goes on slot 2', () => {
    expect(defaultActions('a', pat, 3).map((a) => [a.region_ref.color_group, a.material.slot_index])).toEqual([['#7d7d85', 1]]);
    expect(defaultActions('a', builtinPattern('dots'), 3).map((a) => a.material.slot_index)).toEqual([1]);
    expect(defaultActions('a', pat, 1)).toEqual([]);
  });

  it('persists settings, not placements (those live on scene objects)', () => {
    const store = mem();
    const s = createPatternexState(store);
    s.patterns.push(pat); s.placements.push(place()); s.armed = pat.id; s.singleColour = 'band';
    savePatternexState(s, store);
    const r = createPatternexState(store);
    expect(r.placements.length).toBe(0);
    expect(r.singleColour).toBe('band');
    expect(r.armed).toBeNull();
  });
});

describe('placements live on scene objects', () => {
  it('collect and split round-trip; copies of an object get unique, stable placement ids', async () => {
    const { collectPlacements, splitByObject } = await import('../../src/plugins/patternex/ui/state');
    const pe = { placements: [place()], actions: defaultActions('a', pat, 3), patterns: [pat] };
    const objs = [{ id: 'o1', patternex: pe }, { id: 'o2', patternex: structuredClone(pe) }];
    const c = collectPlacements(objs);
    expect(c.renamed).toBe(true);
    expect(c.placements.map((p) => [p.id, p.object_id])).toEqual([['a', 'o1'], ['a~o2', 'o2']]);
    expect(c.actions.map((x) => x.region_ref.placement_id)).toEqual(['a', 'a~o2']);
    expect(c.patterns.map((p) => p.id)).toEqual([pat.id]);
    const by = splitByObject(c.placements, c.actions, c.patterns);
    expect(by.get('o2')!.placements[0].id).toBe('a~o2');
    expect(by.get('o2')!.patterns!.map((p) => p.id)).toEqual([pat.id]);
    // stable: collecting again renames nothing
    const again = collectPlacements([{ id: 'o1', patternex: by.get('o1')! }, { id: 'o2', patternex: by.get('o2')! }]);
    expect(again.renamed).toBe(false);
  });

  it('mirroring an object mirrors its placements: position, normal, flip and rotation', async () => {
    const { reframePlacements } = await import('../../src/plugins/patternex/ui/state');
    const I = new THREE.Matrix4().elements;
    const pe = { placements: [place({ position_xyz: [5, 10, 2], projection_axis: [1, 0, 0], rotation: 30 })], actions: [] };
    const m = reframePlacements(pe, I, I, (v, isDir) => (isDir ? [-v[0], v[1], v[2]] : [-v[0], v[1], v[2]]));
    const p = m.placements[0];
    expect(p.position_xyz).toEqual([-5, 10, 2]);
    expect(p.projection_axis.map((v) => +v.toFixed(6))).toEqual([-1, 0, 0]);
    expect(p.flip).toBe(true);
    expect(p.rotation).toBe(-30);
    // moving to a new frame without a reflection keeps flip and rotation
    const t = new THREE.Matrix4().makeTranslation(-5, 0, 0);
    const q = reframePlacements(pe, I, t.elements).placements[0];
    expect(q.position_xyz).toEqual([0, 10, 2]);
    expect(q.flip).toBe(false);
  });
});

describe('saved inks', () => {
  it('persist per library design', () => {
    const store = mem();
    const s = createPatternexState(store);
    expect(s.savedInks).toEqual({});
    s.savedInks['hex/tricolour/-/0/1'] = { '#2f2f33': 1 };
    savePatternexState(s, store);
    expect(createPatternexState(store).savedInks).toEqual({ 'hex/tricolour/-/0/1': { '#2f2f33': 1 } });
  });
});
