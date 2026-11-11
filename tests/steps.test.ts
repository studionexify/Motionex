// Plugin steps on plate objects: generator design kept with its objects, replaced in place, later steps asked.
import { beforeEach, describe, expect, it } from 'vitest';
import { useStore, type SceneObject } from '../src/state/store';
import { beginTransfer, designOf, endTransfer, laterSteps, nearestTriangles, reapply, recordModifierSteps, stepsOf, useStepPrompt } from '../src/state/steps';

const quad = (dx = 0): SceneObject['mesh'] => ({ vertices: new Float32Array([0 + dx, 0, 0, 10 + dx, 0, 0, 10 + dx, 10, 0, 0 + dx, 10, 0]), indices: new Uint32Array([0, 1, 2, 0, 2, 3]) });
const obj = (id: string, name: string, extra: Partial<SceneObject> = {}): SceneObject => ({ id, name, mesh: quad(), position: [50, 50, 0], rotation: [0, 0, 0], scale: [1, 1, 1], openEdges: 0, ...extra });

beforeEach(() => { useStore.setState({ objects: [], plates: [{ id: 'p1', name: 'Plate 1', layerActions: [] }], activePlate: 0 }); useStepPrompt.setState({ prompt: null }); });

/** A pretend generator send: remove `placed`, add fresh objects named like the design's parts. */
function send(placed: string[], names: string[], spec: unknown) {
  const tx = beginTransfer('clickex', placed);
  const keep = useStore.getState().objects.filter((o) => !placed.includes(o.id));
  const fresh = names.map((n, i) => obj(`n${Math.random()}`, n, { position: [100 + i, 100, 0] }));
  useStore.setState({ objects: [...keep, ...fresh] });
  let cancelled: string[] | null = null;
  endTransfer(tx, fresh.map((o) => o.id), spec, (old) => { cancelled = old; });
  return { ids: fresh.map((o) => o.id), cancelled: () => cancelled };
}

describe('plugin steps', () => {
  it('a send stamps the design; a re-send replaces in place and keeps the group', () => {
    const a = send([], ['Clickex · Base', 'Clickex · Button'], { spec: { v: 1 } });
    let objs = useStore.getState().objects;
    expect(objs[0].steps?.[0]).toMatchObject({ plugin: 'clickex', spec: { spec: { v: 1 } } });
    const group = objs[0].steps![0].group;
    expect(objs[1].steps![0].group).toBe(group);
    expect(designOf(objs[1])?.spec).toEqual({ spec: { v: 1 } });
    // the user moves the base and changes a setting, then edits the design
    useStore.setState({ objects: objs.map((o, i) => (i === 0 ? { ...o, position: [20, 30, 0], overrides: { wall_loops: 5 } } : o)) });
    send(a.ids, ['Clickex · Base', 'Clickex · Button'], { spec: { v: 2 } });
    objs = useStore.getState().objects;
    expect(objs).toHaveLength(2);
    const base = objs.find((o) => o.name === 'Clickex · Base')!;
    expect(base.position).toEqual([20, 30, 0]);
    expect(base.overrides).toMatchObject({ wall_loops: 5 });
    expect(base.steps![0].group).toBe(group);
    expect(designOf(base)?.spec).toEqual({ spec: { v: 2 } });
    expect(useStepPrompt.getState().prompt).toBeNull();
  });

  it('records modifier steps in order and drops them when removed', () => {
    const o = obj('a', 'A', { steps: [{ plugin: 'clickex', at: 1, group: 'g' }] });
    const withArt = { ...o, patternex: { placements: [{} as never], actions: [] } };
    const r = recordModifierSteps([o], [withArt])!;
    expect(r[0].steps!.map((s) => s.plugin)).toEqual(['clickex', 'patternex']);
    const painted = { ...r[0], paint: { motion: new Uint8Array([1, 0]) } };
    const r2 = recordModifierSteps(r, [painted])!;
    expect(stepsOf(r2[0]).map((s) => s.plugin)).toEqual(['clickex', 'patternex', 'motionex']);
    const r3 = recordModifierSteps(r2, [{ ...r2[0], patternex: undefined }])!;
    expect(laterSteps(r3[0]).map((s) => s.plugin)).toEqual(['motionex']);
  });

  it('asks when later steps exist: re-apply carries them, cancel restores', () => {
    const a = send([], ['Clickex · Base'], { v: 1 });
    useStore.setState({ objects: useStore.getState().objects.map((o) => ({ ...o, paint: { motion: new Uint8Array([2, 0]) }, patternex: { placements: [{} as never], actions: [] }, steps: [...o.steps!, { plugin: 'patternex', at: 2 }] })) });
    const b = send(a.ids, ['Clickex · Base'], { v: 2 });
    const p = useStepPrompt.getState().prompt!;
    expect(p.objects[0].steps).toEqual(['Patternex', 'Motionex']);
    p.resolve('reapply');
    const o = useStore.getState().objects[0];
    expect(o.id).toBe(b.ids[0]);
    expect(Array.from(o.paint!.motion!)).toEqual([2, 0]);
    expect(o.patternex?.placements).toHaveLength(1);
    expect(stepsOf(o).map((s) => s.plugin)).toEqual(['clickex', 'patternex', 'motionex']);
    // and once more, cancelled: the objects as they were come back
    const c = send(b.ids, ['Clickex · Base'], { v: 3 });
    useStepPrompt.getState().prompt!.resolve('cancel');
    const back = useStore.getState().objects;
    expect(back.map((x) => x.id)).toEqual(b.ids);
    expect(c.cancelled()).toEqual(b.ids);
  });

  it('maps painted triangles to the nearest triangle of the new shape', () => {
    const { map, far } = nearestTriangles(quad(), quad(0.5));
    expect(Array.from(map)).toEqual([0, 1]);
    expect(far).toBeLessThan(1);
    const r = reapply(obj('o', 'O', { paint: { motion: new Uint8Array([0, 3]) } }), obj('n', 'N', { mesh: quad(0.2) }));
    expect(Array.from(r.object.paint!.motion!)).toEqual([0, 3]);
    expect(r.review).toBe(false);
  });
});
