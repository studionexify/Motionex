// Plugin steps on plate objects. An object remembers the plugin that made it (Clickex, Lumonex, Plantex, Flenex:
// the generator, with its design) and the plugins applied to it afterwards (Patternex artwork, Motionex surface
// paint and wave zones). Any step can be reopened in its Studio. Sending an edited design back replaces the
// objects it made, in place; when later steps were applied on top, the user is asked to re-apply them, drop
// them, or cancel the send.
import { create } from 'zustand';
import { isWaveZone } from '../plugins/motionex/weave/zones';
import { newId, objectPlate, useStore, type SceneObject } from './store';

export interface PluginStep {
  plugin: string;
  /** Objects made by one send share a group: editing the design replaces the whole group. */
  group?: string;
  at: number;
  /** Generator's design (plugin project data); kept on one object of the group. */
  spec?: unknown;
}

export const GENERATORS: Record<string, string> = { clickex: 'Clickex', lumonex: 'Lumonex', plantex: 'Plantex', flenex: 'Flenex' };
export const MODIFIERS: Record<string, string> = { patternex: 'Patternex', motionex: 'Motionex' };
export const stepLabel = (plugin: string) => GENERATORS[plugin] ?? MODIFIERS[plugin] ?? plugin;

/* ---------- what an object carries */

const hasMotion = (o: SceneObject) => !!o.paint?.motion?.some((v) => v > 0) || !!o.parts?.some((p) => p.type === 'modifier' && isWaveZone(p.overrides));
const hasPatternex = (o: SceneObject) => !!o.patternex?.placements?.length;

/** The object's steps, generator first, with modifier steps for what the object actually carries. */
export function stepsOf(o: SceneObject): PluginStep[] {
  const out = (o.steps ?? []).filter((s) => GENERATORS[s.plugin] || (s.plugin === 'patternex' ? hasPatternex(o) : s.plugin === 'motionex' ? hasMotion(o) : true));
  if (hasPatternex(o) && !out.some((s) => s.plugin === 'patternex')) out.push({ plugin: 'patternex', at: 0 });
  if (hasMotion(o) && !out.some((s) => s.plugin === 'motionex')) out.push({ plugin: 'motionex', at: 0 });
  return out;
}
export const generatorOf = (o: SceneObject) => (o.steps?.[0] && GENERATORS[o.steps[0].plugin] ? o.steps[0] : undefined);
/** Steps applied after the generator. */
export const laterSteps = (o: SceneObject) => stepsOf(o).filter((s) => !GENERATORS[s.plugin]);

/** Keep recorded modifier steps in the order they were applied (called when objects change). */
export function recordModifierSteps(prev: SceneObject[], next: SceneObject[]): SceneObject[] | null {
  const before = new Map(prev.map((o) => [o.id, o]));
  let changed = false;
  const out = next.map((o) => {
    const p = before.get(o.id);
    if (p === o) return o;
    let steps = o.steps ?? [];
    const add = (plugin: string, has: boolean) => {
      const there = steps.some((s) => s.plugin === plugin);
      if (has && !there) steps = [...steps, { plugin, at: Date.now() }];
      if (!has && there) steps = steps.filter((s) => s.plugin !== plugin);
    };
    add('patternex', hasPatternex(o));
    add('motionex', hasMotion(o));
    if (steps === (o.steps ?? []) || (steps.length === 0 && !o.steps)) return o;
    changed = true;
    return { ...o, steps };
  });
  return changed ? out : null;
}

/* ---------- sending a design to the plate */

export interface Transfer { plugin: string; old: SceneObject[]; group: string; plates: number }

/** Before a generator replaces the objects it placed: remember them. */
export function beginTransfer(plugin: string, placedIds: string[]): Transfer {
  const ids = new Set(placedIds);
  const old = useStore.getState().objects.filter((o) => ids.has(o.id));
  const group = old.map((o) => generatorOf(o)).find((g) => g?.plugin === plugin)?.group ?? newId();
  return { plugin, old: old.map((o) => structuredClone(o)), group, plates: useStore.getState().plates.length };
}

interface StepPrompt { plugin: string; objects: { name: string; steps: string[] }[]; resolve: (c: 'reapply' | 'drop' | 'cancel') => void }
export const useStepPrompt = create<{ prompt: StepPrompt | null }>(() => ({ prompt: null }));

const nameKey = (n: string) => n.replace(/\s+\(\d+\)$/, '');

/** After the generator placed its new objects: they take the design (spec), the place of the objects they
 *  replace, their settings, and — when the user agrees — the steps applied on top of them. */
export function endTransfer(t: Transfer, newIds: string[], spec: unknown, onCancel?: (oldIds: string[]) => void): void {
  const ids = new Set(newIds);
  const st = useStore.getState();
  const fresh = st.objects.filter((o) => ids.has(o.id));
  if (!fresh.length) return;
  // pair old ↔ new by name (part names are stable for a design), then by order
  const pool = [...t.old];
  const pair = new Map<string, SceneObject>();
  for (const o of fresh) { const i = pool.findIndex((x) => nameKey(x.name) === nameKey(o.name)); if (i >= 0) { pair.set(o.id, pool[i]); pool.splice(i, 1); } }
  for (const o of fresh) if (!pair.has(o.id) && pool.length) pair.set(o.id, pool.shift()!);
  const at = Date.now();
  const stamp = (o: SceneObject, k: number): SceneObject => {
    const old = pair.get(o.id);
    const gen: PluginStep = { plugin: t.plugin, group: t.group, at, ...(k === 0 ? { spec: structuredClone(spec) } : {}) };
    const base: SceneObject = { ...o, steps: [gen] };
    if (!old) return base;
    // the same place on the plate, the user's own settings and name
    return { ...base, position: old.position, rotation: old.rotation, overrides: old.overrides ? { ...(o.overrides ?? {}), ...old.overrides } : o.overrides, printable: old.printable, hidden: old.hidden };
  };
  useStore.setState({ objects: st.objects.map((o) => (ids.has(o.id) ? stamp(o, newIds.indexOf(o.id)) : o)) });
  if (pair.size) {
    // replaced in place: plates the send added and no longer needs go again, and the view follows the objects
    const s2 = useStore.getState(), count = s2.plates.length;
    const used = (k: number) => s2.objects.some((o) => objectPlate(o, s2.printerId, count) === k);
    let n = count;
    while (n > Math.max(1, t.plates) && !used(n - 1)) n--;
    const first = s2.objects.find((o) => ids.has(o.id));
    const active = first ? Math.min(n - 1, objectPlate(first, s2.printerId, count)) : Math.min(s2.activePlate, n - 1);
    useStore.setState({ plates: n < count ? s2.plates.slice(0, n) : s2.plates, activePlate: Math.max(0, active) });
  }

  const withLater = t.old.filter((o) => laterSteps(o).length);
  if (!withLater.length) return;
  const resolve = (c: 'reapply' | 'drop' | 'cancel') => {
    useStepPrompt.setState({ prompt: null });
    const s = useStore.getState();
    if (c === 'cancel') {
      const keep = s.objects.filter((o) => !ids.has(o.id));
      useStore.setState({ objects: [...keep, ...t.old], selected: t.old.map((o) => o.id) });
      onCancel?.(t.old.map((o) => o.id));
      s.markDirty();
      return;
    }
    if (c === 'drop') return;
    const review: string[] = [];
    useStore.setState({
      objects: s.objects.map((o) => {
        const old = ids.has(o.id) ? pair.get(o.id) : undefined;
        if (!old || !laterSteps(old).length) return o;
        const r = reapply(old, o);
        if (r.review) review.push(o.name);
        return r.object;
      }),
    });
    s.markDirty();
    if (review.length) s.set({ toast: { kind: 'warn', text: `Re-applied the later steps. Check ${review.join(', ')}: the shape changed a lot, so painted areas may have moved.` } });
  };
  useStepPrompt.setState({ prompt: { plugin: t.plugin, objects: withLater.map((o) => ({ name: o.name, steps: laterSteps(o).map((x) => stepLabel(x.plugin)) })), resolve } });
}

/* ---------- re-applying modifier steps on a new mesh */

const centroids = (m: SceneObject['mesh']) => {
  const v = m.vertices, ix = m.indices, n = ix.length / 3, c = new Float32Array(n * 3);
  for (let t = 0; t < n; t++) for (let a = 0; a < 3; a++) c[t * 3 + a] = (v[ix[t * 3] * 3 + a] + v[ix[t * 3 + 1] * 3 + a] + v[ix[t * 3 + 2] * 3 + a]) / 3;
  return c;
};

/** For every triangle of `to`, the nearest triangle of `from` (by centroid, object-local) and how far it is. */
export function nearestTriangles(from: SceneObject['mesh'], to: SceneObject['mesh']): { map: Uint32Array; far: number } {
  const a = centroids(from), b = centroids(to), na = a.length / 3, nb = b.length / 3;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < na; i++) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], a[i * 3 + k]); hi[k] = Math.max(hi[k], a[i * 3 + k]); }
  const size = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2], 1e-6);
  const cell = Math.max(size / Math.cbrt(Math.max(1, na / 4)), 1e-4);
  const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
  const grid = new Map<string, number[]>();
  const ci = (v: number, k: number) => Math.floor((v - lo[k]) / cell);
  for (let i = 0; i < na; i++) { const k = key(ci(a[i * 3], 0), ci(a[i * 3 + 1], 1), ci(a[i * 3 + 2], 2)); const l = grid.get(k); if (l) l.push(i); else grid.set(k, [i]); }
  const map = new Uint32Array(nb);
  let far = 0;
  for (let j = 0; j < nb; j++) {
    const x = b[j * 3], y = b[j * 3 + 1], z = b[j * 3 + 2];
    const gx = ci(x, 0), gy = ci(y, 1), gz = ci(z, 2);
    let best = -1, bd = Infinity;
    // grow a shell of cells until the nearest found is closer than anything further out can be
    for (let r = 0; r <= 64; r++) {
      for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== r) continue;
        const l = grid.get(key(gx + dx, gy + dy, gz + dz));
        if (l) for (const i of l) { const d = (a[i * 3] - x) ** 2 + (a[i * 3 + 1] - y) ** 2 + (a[i * 3 + 2] - z) ** 2; if (d < bd) { bd = d; best = i; } }
      }
      if (best >= 0 && Math.sqrt(bd) <= r * cell) break;
    }
    map[j] = Math.max(0, best);
    far = Math.max(far, Math.sqrt(bd));
  }
  return { map, far };
}

/** The modifier steps of `old` carried onto its replacement `fresh`. review: the shapes differ a lot. */
export function reapply(old: SceneObject, fresh: SceneObject): { object: SceneObject; review: boolean } {
  const o: SceneObject = { ...fresh };
  let review = false;
  if (old.paint?.motion?.some((v) => v > 0)) {
    const { map, far } = nearestTriangles(old.mesh, fresh.mesh);
    const src = old.paint.motion, motion = new Uint8Array(map.length);
    for (let t = 0; t < map.length; t++) motion[t] = src[map[t]] ?? 0;
    o.paint = { ...(fresh.paint ?? {}), motion };
    const v = fresh.mesh.vertices; let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < v.length; i += 3) { lo = Math.min(lo, v[i]); hi = Math.max(hi, v[i]); }
    if (far > 0.1 * Math.max(1, hi - lo)) review = true;
  }
  if (old.patternex) o.patternex = structuredClone(old.patternex);
  // modifier volumes added on the plate (wave zones, settings modifiers) stay where they were
  const extra = (old.parts ?? []).filter((p) => !(fresh.parts ?? []).some((q) => q.id === p.id));
  if (extra.length) o.parts = [...(fresh.parts ?? []), ...extra.map((p) => structuredClone(p))];
  o.steps = [...(fresh.steps ?? []).filter((s) => GENERATORS[s.plugin]), ...laterSteps(old).map((s) => ({ ...s }))];
  return { object: o, review };
}

/* ---------- reopening a step */

/** The design that made an object (from any object of its group). */
export function designOf(o: SceneObject): { plugin: string; spec: unknown; group: string; objects: SceneObject[] } | null {
  const g = generatorOf(o);
  if (!g?.group) return null;
  const objects = useStore.getState().objects.filter((x) => generatorOf(x)?.group === g.group);
  const spec = objects.map((x) => generatorOf(x)?.spec).find((x) => x !== undefined);
  return spec === undefined ? null : { plugin: g.plugin, spec, group: g.group, objects };
}

let started = false;
/** Record modifier steps as objects change. */
export function startStepTracking() {
  if (started) return;
  started = true;
  let busy = false;
  useStore.subscribe((s, p) => {
    if (busy || s.objects === p.objects) return;
    const next = recordModifierSteps(p.objects, s.objects);
    if (!next) return;
    busy = true;
    try { useStore.setState({ objects: next }); } finally { busy = false; }
  });
}
