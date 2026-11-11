// Bindings of the redesigned shell (src/state/ui.ts) against the real store, Advanced state and plugins.
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

beforeAll(() => {
  const mem = new Map<string, string>();
  (globalThis as any).localStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => mem.set(k, v), removeItem: (k: string) => mem.delete(k) };
});

const mesh = { vertices: new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10]), indices: new Uint32Array([0, 1, 2, 0, 1, 3, 0, 2, 3, 1, 2, 3]) };
const obj = (id: string, extra: any = {}) => ({ id, name: id, mesh, position: [50, 50, 0], rotation: [0, 0, 0], scale: [1, 1, 1], openEdges: 0, ...extra });
const stats = { timeSeconds: 3725, filamentMm: 1000, filamentGrams: 12.345, filamentCost: 0.4, layerCount: 10, toolChanges: 0, perFilament: [], towerGrams: 0, byFeature: {} };
const check = (n: number, blocking: boolean) => ({ collisions: n ? [{ x: 0, y: 0, z: 1, layer: 4 }, { x: 0, y: 0, z: 2, layer: 9 }] : [], collisionCount: n, blocking, flowCapHits: 0, speedHits: 0, zSpeedHits: 0, accelHits: 0, loopSlowed: 0, events: { dwell: 0, retract: 0, flow: 0 }, notes: [] });

async function load() {
  const ui = await import('../src/state/ui');
  const { useStore } = await import('../src/state/store');
  const { useAdvanced } = await import('../src/state/advanced');
  const { mx } = await import('../src/plugins/motionex/ui/MotionexPanel');
  const { px } = await import('../src/plugins/patternex/ui/PatternexPanel');
  const { defaultApplication } = await import('../src/plugins/motionex/index');
  return { ui, useStore, useAdvanced, mx, px, defaultApplication };
}
const done = (useStore: any, c?: any, dirty = false) => useStore.getState().set({
  slice: { status: 'done', stage: 'Done', progress: 1, error: null, dirty, plate: 0, result: { gcode: '', stats, warnings: [], layers: [], pluginReports: c ? { motionex: { check: c, movedPaths: 1 } } : undefined } },
});

describe('ui bindings', () => {
  beforeEach(async () => {
    const { useStore, mx } = await load();
    mx.applications = []; mx.weave.enabled = false;
    useStore.getState().set({ objects: [], plugins: ['motionex', 'patternex'], presetId: '0.20', slice: { status: 'idle', stage: '', progress: 0, result: null, error: null, dirty: true, plate: 0 } });
  });

  it('applies intent presets and matches them back', async () => {
    const { ui, useStore, useAdvanced, mx } = await load();
    expect(ui.INTENT_PRESETS.map((p) => p.id)).toEqual(['woven', 'smooth', 'structural', 'standard', 'draft']);
    ui.applyIntentPreset('draft');
    expect(useAdvanced.getState().engineMode).toBe('basic');
    expect(useStore.getState().presetId).toBe('0.28');
    expect(useStore.getState().slice.dirty).toBe(true);
    expect(ui.activeIntentPreset()).toBe('draft');
    ui.applyIntentPreset('structural');
    expect(useAdvanced.getState()).toMatchObject({ engineMode: 'advanced', intent: 'structural' });
    expect(ui.activeIntentPreset()).toBe('structural');
    ui.applyIntentPreset('smooth');
    expect(ui.activeIntentPreset()).toBe('smooth');
    ui.applyIntentPreset('woven');
    expect(useStore.getState().dock.tab).toBe('motionex');
    expect(ui.activeIntentPreset()).toBeNull(); // weave not on yet: not a woven picture
    mx.weave.enabled = true;
    expect(ui.activeIntentPreset()).toBe('woven');
    useStore.getState().set({ presetId: '0.12' });
    expect(ui.activeIntentPreset()).toBeNull();
  });

  it('enumerates and toggles per-object effects', async () => {
    const { ui, useStore, mx, px, defaultApplication } = await load();
    useStore.getState().set({ objects: [obj('a', { paint: { motion: new Uint8Array([0, 2, 0, 0]) } }), obj('b')] as any });
    const id = mx.library.all()[0].id;
    mx.applications = [defaultApplication(id), { ...defaultApplication(id), target: { type: 'faces', walls: 'outer', faces: ['2'] }, surface: 2 }];
    px.placements = [{ id: 'pl1', object_id: 'b', pattern_id: 'nope', projection: 'planar', depth_mode: 'fixed', depth_mm: 1.5, through: false, visible: true } as any];
    expect(ui.objectEffects('a').map((e) => e.id)).toEqual(['mx:app:0', 'mx:app:1']);
    expect(ui.objectEffects('b').map((e) => e.id)).toEqual(['mx:app:0', 'px:pl1']);
    ui.setEffectEnabled('b', 'mx:app:0', false);
    expect(mx.applications[0].enabled).toBe(false);
    expect(ui.objectEffects('a')[0].enabled).toBe(false);
    ui.setEffectEnabled('a', 'mx:app:0', true);
    expect(mx.applications[0].enabled).toBe(true);
    // weave stays listed after being switched off from the stack
    mx.weave.enabled = true;
    expect(ui.objectEffects('a').some((e) => e.id === 'mx:weave')).toBe(true);
    ui.setEffectEnabled('a', 'mx:weave', false);
    expect(ui.objectEffects('a').find((e) => e.id === 'mx:weave')?.enabled).toBe(false);
    ui.openEffect('a', 'mx:app:1');
    expect(useStore.getState().dock).toMatchObject({ open: true, tab: 'motionex' });
    expect(useStore.getState().selected).toEqual(['a']);
    expect(ui.objectEffects(null)).toEqual([]);
  });

  it('gates export on a blocking collision and auto-fixes', async () => {
    const { ui, useStore, mx, defaultApplication } = await load();
    useStore.getState().set({ objects: [obj('a')] as any });
    expect(ui.clearanceStatus().state).toBe('none');
    done(useStore, check(0, false));
    expect(ui.clearanceStatus().state).toBe('ok');
    expect(ui.sliceSummary().ready).toBe(true);
    mx.applications = [defaultApplication(mx.library.all()[0].id)];
    done(useStore, check(5, true));
    const st = ui.clearanceStatus();
    expect(st).toMatchObject({ state: 'collision', layers: [4, 9], canAutoFix: true });
    expect(ui.sliceSummary().ready).toBe(false);
    expect(ui.objectEffects('a')[0].status).toBe('error');
    const msg = ui.autoFixClearance();
    expect(msg).toMatch(/70% size/);
    expect(mx.applications[0].scale).toBeCloseTo(0.7);
    expect(useStore.getState().slice.dirty).toBe(true);
    done(useStore, check(3, false));
    expect(ui.clearanceStatus().state).toBe('warn');
    expect(ui.sliceSummary().ready).toBe(true);
  });

  it('marks a collision from an older slice as stale', async () => {
    const { ui, useStore, mx, defaultApplication } = await load();
    useStore.getState().set({ objects: [obj('a')] as any });
    mx.applications = [defaultApplication(mx.library.all()[0].id)];
    done(useStore, check(5, true));
    expect(ui.clearanceStatus().stale).toBe(false);
    done(useStore, check(5, true), true);
    expect(ui.clearanceStatus()).toMatchObject({ state: 'collision', stale: true });
    expect(ui.clearanceStatus().message).toMatch(/out of date/);
  });

  it('auto-fix repeats lower-and-re-slice until clear, then falls back to clamping at the floor', async () => {
    const { ui, useStore, mx, defaultApplication } = await load();
    useStore.getState().set({ objects: [obj('a')] as any });
    mx.collisionMode = 'fail';
    mx.applications = [defaultApplication(mx.library.all()[0].id)];
    done(useStore, check(5, true));
    // the fake slice keeps colliding until the motion is under 40 % size
    let slices = 0;
    const slice = async () => { slices++; done(useStore, (mx.applications[0].scale ?? 1) < 0.4 ? check(0, false) : check(5, true)); };
    const msg = await ui.autoFixUntilClear(slice);
    expect(slices).toBe(3); // 0.7 → 0.49 → 0.343
    expect(mx.applications[0].scale).toBeCloseTo(0.343);
    expect(msg).toMatch(/now clears/);
    expect(ui.sliceSummary().ready).toBe(true);
    // a collision that no size clears: lowers to the floor, then switches the check to clamp (export allowed, warned)
    mx.applications[0].scale = 0.06;
    done(useStore, check(5, true));
    const stuck = async () => { done(useStore, mx.collisionMode === 'clamp' ? check(5, false) : check(5, true)); };
    const msg2 = await ui.autoFixUntilClear(stuck);
    expect(mx.applications[0].scale).toBe(0.05);
    expect(mx.collisionMode).toBe('clamp');
    expect(msg2).toMatch(/lowered automatically/);
    expect(ui.clearanceStatus().state).toBe('warn');
    mx.collisionMode = 'clamp';
  });

  it('summarises the slice', async () => {
    const { ui, useStore } = await load();
    expect(ui.sliceSummary()).toEqual({ status: 'empty', progress: 0, ready: false });
    useStore.getState().set({ objects: [obj('a')] as any });
    expect(ui.sliceSummary().status).toBe('idle');
    useStore.getState().set({ slice: { ...useStore.getState().slice, status: 'slicing', progress: 0.4 } });
    expect(ui.sliceSummary()).toMatchObject({ status: 'slicing', progress: 0.4, ready: false });
    done(useStore);
    expect(ui.sliceSummary()).toMatchObject({ status: 'done', progress: 1, time: '1h 2m', weight: '12.3 g', ready: true });
    expect(ui.sliceSummary().changes).toBeUndefined();
    done(useStore, undefined, true);
    expect(ui.sliceSummary()).toMatchObject({ status: 'idle', ready: false });
  });

  it('palette covers params, tools, plugins, techs and actions', async () => {
    const { ui, useStore } = await load();
    const items = ui.paletteItems();
    const { PROCESS_PARAMS } = await import('../src/profiles/settings');
    expect(items.filter((i) => i.id.startsWith('param:')).length).toBe(PROCESS_PARAMS.length);
    for (const s of ['Settings', 'Tools', 'Plugins & effects', 'Physics Core', 'Actions']) expect(items.some((i) => i.section === s)).toBe(true);
    items.find((i) => i.id === 'param:sparse_infill_density')!.run();
    expect(useStore.getState().processTab).toBe('Strength');
    items.find((i) => i.id === 'tool:cut')!.run();
    expect(useStore.getState().tool).toBe('cut');
    const pinned = ui.useUi.getState().pinnedParams.includes('layer_height');
    items.find((i) => i.id === 'pin:layer_height')!.run();
    expect(ui.useUi.getState().pinnedParams.includes('layer_height')).toBe(!pinned);
  });
});
