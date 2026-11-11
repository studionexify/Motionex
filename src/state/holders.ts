// Filament holders: what is physically loaded in each machine (AMS trays, tool heads, spool holders), kept per
// saved device — or per printer model when no device is saved for it. The project's filament slots mirror the
// selected machine's holders: editing one side edits the other. Slots marked `planned` are filaments a design
// asked for that are not loaded yet; they sit after the holders and never write back to the machine.
//
// Live printers: a spool the printer identified by RFID fills its holder automatically. Trays without RFID are
// what someone typed: a printer reading never overwrites a holder the user set here — it is shown as a hint.
// When the machine side changes and objects or plugin designs use the slots that changed, the user is asked
// (follow the new filaments / keep my colours / not now).
import { create } from 'zustand';
import { amsToSlots, statusHasAms, type AmsSlot } from '../profiles/amsSync';
import { filamentById } from '../profiles/filaments';
import type { MixedFilament } from '../profiles/mixing';
import { useDevices } from './devices';
import { useStore, type FilamentSlotState, type SceneObject } from './store';

export type HolderSource = 'user' | 'rfid' | 'printer';
export interface Holder {
  presetId: string;
  color: string;
  source: HolderSource;
  /** Tray / head label from the printer ("A1", "T2"), when it reports one. */
  tray?: string;
  /** What the printer reads for a holder the user set differently (non-RFID trays only). */
  reported?: { presetId: string; color: string; type: string };
}

export interface SlotChange { slot: number; from?: FilamentSlotState; to?: Holder }
export interface HolderPrompt { machine: string; changes: SlotChange[]; affected: string[] }

interface HoldersState {
  lists: Record<string, Holder[]>;
  /** false after "Not now": the project keeps its own filaments until the user links it again. */
  linked: boolean;
  prompt: HolderPrompt | null;
}

const KEY = 'nexspiro.holders';
const storage = typeof localStorage !== 'undefined' ? localStorage : undefined;
const loadLists = (): Record<string, Holder[]> => { try { return JSON.parse(storage?.getItem(KEY) ?? '{}') ?? {}; } catch { return {}; } };
export const useHolders = create<HoldersState>(() => ({ lists: loadLists(), linked: true, prompt: null }));
const persist = () => { try { storage?.setItem(KEY, JSON.stringify(useHolders.getState().lists)); } catch { /* storage full / blocked */ } };

const same = (a: { presetId: string; color: string }, b: { presetId: string; color: string }) => a.presetId === b.presetId && a.color.toLowerCase() === b.color.toLowerCase();
const sameList = (a: { presetId: string; color: string }[], b: { presetId: string; color: string }[]) => a.length === b.length && a.every((x, i) => same(x, b[i]));

/* ---------- which machine */

/** Holder list key of the project's printer: the selected device when it is that model, else the first saved
 *  device of that model, else the model itself. */
export function activeKey(): string {
  const { printerId } = useStore.getState(), d = useDevices.getState();
  const dev = d.devices.find((x) => x.id === d.selected && x.printerId === printerId) ?? d.devices.find((x) => x.printerId === printerId);
  return dev ? dev.id : `model:${printerId}`;
}
export function machineName(key = activeKey()): string {
  const d = useDevices.getState().devices.find((x) => x.id === key);
  return d?.name ?? 'this printer';
}
export const holdersOf = (key = activeKey()) => useHolders.getState().lists[key];

/* ---------- plugin designs that use filament slots */

/** A plugin design bound to the project's filament slots. */
export interface FilamentLink {
  id: string;
  /** Name of the design for prompts, or null when the plugin has nothing that uses filaments. */
  label: () => string | null;
  /** Project slots (0-based) the design uses. */
  slotsUsed: (filaments: FilamentSlotState[]) => number[];
  /** "Use machine filaments": a slot's colour/material changed under the design (colour-bound designs recolour). */
  follow?: (from: FilamentSlotState[], to: FilamentSlotState[]) => void;
  /** Slots moved: old index → new index (slot-bound designs renumber). */
  remap?: (map: number[]) => void;
}
const links = new Map<string, FilamentLink>();
export function registerFilamentLink(l: FilamentLink) { links.set(l.id, l); }
export const filamentLinks = () => [...links.values()];

/* ---------- applying a new slot list */

const objectSlots = (o: SceneObject) => {
  const out = new Set<number>([o.filament ?? 0]);
  o.paint?.color?.forEach((c) => { if (c > 0) out.add(c - 1); });
  for (const a of o.patternex?.actions ?? []) {
    if (a.material.mode !== 'keep') out.add(a.material.slot_index);
    if (a.dither) out.add(a.dither.slot_index);
  }
  return out;
};

/** Patternex artwork on an object, its filament slots renumbered. */
const remapPatternex = (px: SceneObject['patternex'], map: number[]): SceneObject['patternex'] => px && {
  ...px,
  actions: px.actions.map((a) => ({
    ...a,
    material: a.material.mode === 'keep' ? a.material : { ...a.material, slot_index: map[a.material.slot_index] ?? 0 },
    dither: a.dither ? { ...a.dither, slot_index: map[a.dither.slot_index] ?? 0 } : a.dither,
  })),
};

/** What uses each project slot: object names and plugin designs. */
export function slotUsers(filaments = useStore.getState().filaments): Map<number, string[]> {
  const out = new Map<number, string[]>();
  const add = (k: number, who: string) => { const l = out.get(k) ?? []; if (!l.includes(who)) l.push(who); out.set(k, l); };
  for (const o of useStore.getState().objects) for (const k of objectSlots(o)) add(k, o.name);
  for (const l of links.values()) { const n = l.label(); if (n) for (const k of l.slotsUsed(filaments)) add(k, n); }
  return out;
}

const remapMixes = (mixes: MixedFilament[], map: number[]) => mixes.map((m) => (m.kind === 'cycle' ? { ...m, seq: m.seq.map((x) => map[x] ?? 0) } : { ...m, a: map[m.a] ?? 0, b: map[m.b] ?? 0 }));

/** Replace the project's slots with `next`; objects, colour paint, mixes and plugin designs follow `map`. */
function commit(next: FilamentSlotState[], map: number[], recolour: boolean) {
  const s = useStore.getState(), before = s.filaments;
  const moved = map.some((j, i) => j !== i);
  if (moved && s.objects.length) {
    s.updateObjects((o) => ({
      ...o,
      filament: o.filament === undefined ? undefined : map[o.filament] ?? 0,
      paint: o.paint?.color ? { ...o.paint, color: o.paint.color.map((c) => (c > 0 ? (map[c - 1] ?? 0) + 1 : 0)) } : o.paint,
      patternex: remapPatternex(o.patternex, map),
    }), s.objects.filter((o) => [...objectSlots(o)].some((k) => map[k] !== k)).map((o) => o.id));
  }
  applying = true;
  try {
    useStore.getState().set({ filaments: next, mixes: moved ? remapMixes(s.mixes, map) : s.mixes, flushMatrix: null });
    useStore.getState().markDirty();
  } finally { applying = false; }
  for (const l of links.values()) {
    if (moved) l.remap?.(map);
    if (recolour) l.follow?.(before.map((_, i) => before[i]), before.map((_, i) => next[map[i] ?? 0] ?? before[i]));
  }
}

const slotOf = (h: Holder, old?: FilamentSlotState): FilamentSlotState =>
  old && old.presetId === h.presetId ? { ...old, color: h.color, planned: undefined } : { presetId: h.presetId, color: h.color };

/** The project's slots after taking the machine's holders. follow: slot k becomes holder k (designs recolour).
 *  keep: every used slot finds the holder with the same filament, or stays as a planned slot. */
export function plan(holders: Holder[], mode: 'follow' | 'keep', cur = useStore.getState().filaments): { next: FilamentSlotState[]; map: number[] } {
  const loaded = cur.map((f, i) => ({ f, i })).filter((x) => !x.f.planned);
  const planned = cur.map((f, i) => ({ f, i })).filter((x) => x.f.planned);
  const next: FilamentSlotState[] = holders.map((h, j) => slotOf(h, loaded[j]?.f));
  const map: number[] = cur.map(() => 0);
  const findHolder = (f: FilamentSlotState) => holders.findIndex((h) => same(h, f));
  const keepPlanned = (f: FilamentSlotState) => { const j = next.findIndex((x) => same(x, f)); if (j >= 0) return j; next.push({ ...f, planned: true }); return next.length - 1; };
  if (mode === 'follow') {
    loaded.forEach(({ f, i }, k) => { map[i] = k < holders.length ? k : Math.max(0, findHolder(f)); });
  } else {
    const used = slotUsers(cur);
    loaded.forEach(({ f, i }, k) => {
      const j = findHolder(f);
      map[i] = j >= 0 ? j : used.has(i) ? keepPlanned(f) : Math.min(k, Math.max(0, holders.length - 1));
    });
  }
  for (const { f, i } of planned) { const j = findHolder(f); map[i] = j >= 0 ? j : keepPlanned(f); }
  if (!next.length) next.push(cur[0] ?? { presetId: 'generic-pla', color: filamentById('generic-pla').color });
  return { next, map };
}

let applying = false;

/** Bring the project in line with the active machine's holders: silently when nothing that is used changes,
 *  otherwise ask. */
export function pullFromMachine(opts: { ask?: boolean } = {}) {
  const st = useHolders.getState();
  if (!st.linked) return;
  const key = activeKey(), holders = st.lists[key];
  if (!holders) { pushToMachine(); return; }
  const cur = useStore.getState().filaments;
  const loaded = cur.filter((f) => !f.planned);
  if (sameList(loaded, holders)) return;
  const users = slotUsers(cur);
  const changes: SlotChange[] = [];
  const n = Math.max(loaded.length, holders.length);
  const idx = cur.map((f, i) => ({ f, i })).filter((x) => !x.f.planned);
  for (let k = 0; k < n; k++) {
    const from = idx[k]?.f, to = holders[k];
    if (from && to && same(from, to)) continue;
    changes.push({ slot: idx[k]?.i ?? k, from, to });
  }
  const affected = [...new Set(changes.flatMap((c) => users.get(c.slot) ?? []))];
  if (!affected.length || opts.ask === false) { const p = plan(holders, 'follow'); commit(p.next, p.map, true); return; }
  useHolders.setState({ prompt: { machine: machineName(key), changes, affected } });
}

/** Answer to the filament-change prompt. */
export function answerPrompt(choice: 'follow' | 'keep' | 'later') {
  const key = activeKey(), holders = useHolders.getState().lists[key];
  useHolders.setState({ prompt: null });
  if (choice === 'later' || !holders) { useHolders.setState({ linked: false }); return; }
  const p = plan(holders, choice);
  commit(p.next, p.map, choice === 'follow');
  useHolders.setState({ linked: true });
}

/** Link the project to the machine again ("Use machine filaments" in the Filament card). */
export function relink() { useHolders.setState({ linked: true }); pullFromMachine(); }

/** Project slots → the active machine's holders (the Filament card edits the machine). */
export function pushToMachine() {
  const st = useHolders.getState();
  if (!st.linked || applying) return;
  const key = activeKey(), old = st.lists[key] ?? [];
  const loaded = useStore.getState().filaments.filter((f) => !f.planned);
  if (sameList(loaded, old) && old.length) return;
  const next: Holder[] = loaded.map((f, k) => {
    const h = old[k];
    if (h && same(h, f)) return h;
    return { presetId: f.presetId, color: f.color, source: 'user', tray: h?.tray };
  });
  setLists({ ...st.lists, [key]: next });
}

function setLists(lists: Record<string, Holder[]>) { useHolders.setState({ lists }); persist(); }

/* ---------- editing holders (Device tab) */

export function setHolders(key: string, list: Holder[]) {
  setLists({ ...useHolders.getState().lists, [key]: list });
  if (key === activeKey()) pullFromMachine();
}
export function editHolder(key: string, i: number, patch: Partial<Pick<Holder, 'presetId' | 'color'>>) {
  const list = (holdersOf(key) ?? []).map((h, k) => (k === i ? { ...h, ...patch, source: 'user' as const, reported: undefined } : h));
  setHolders(key, list);
}
export function addHolder(key: string) {
  const list = holdersOf(key) ?? [];
  const last = list[list.length - 1];
  setHolders(key, [...list, { presetId: last?.presetId ?? 'generic-pla', color: '#FFFFFF', source: 'user' }]);
}
export function removeHolder(key: string, i: number) {
  const list = holdersOf(key) ?? [];
  if (list.length <= 1) return;
  setHolders(key, list.filter((_, k) => k !== i));
}
/** Take what the printer reads for a holder the user had set differently. */
export function takeReported(key: string, i: number) {
  const list = (holdersOf(key) ?? []).map((h, k) => (k === i && h.reported ? { presetId: h.reported.presetId, color: h.reported.color, source: 'printer' as const, tray: h.tray } : h));
  setHolders(key, list);
}

/* ---------- live printers */

/** Merge what a printer reports into its holders. RFID spools always win; other trays fill holders the user has
 *  not set, and only show as a hint on holders the user set. `force` (Sync AMS): take every tray as reported. */
export function mergeTrays(old: Holder[], trays: AmsSlot[], force = false): Holder[] {
  const out: Holder[] = trays.map((t, k) => {
    const h = old.find((x) => x.tray === t.tray) ?? (old.every((x) => !x.tray) ? old[k] : undefined);
    const fromTray: Holder = { presetId: t.presetId, color: t.color, source: t.rfid ? 'rfid' : 'printer', tray: t.tray };
    if (force || t.rfid || !h || h.source !== 'user') return fromTray;
    if (same(h, t)) return { ...h, tray: t.tray, reported: undefined };
    return { ...h, tray: t.tray, reported: { presetId: t.presetId, color: t.color, type: t.trayType } };
  });
  // holders the user added that the printer does not report (an external spool holder)
  for (const h of old) if (h.source === 'user' && !h.tray && !out.includes(h) && old.indexOf(h) >= trays.length) out.push(h);
  return out;
}

const sameHolders = (a: Holder[], b: Holder[]) => JSON.stringify(a) === JSON.stringify(b);

/** A device reported trays: update its holders (and the project when it is the active machine). */
export function adoptTrays(deviceId: string, trays: AmsSlot[], force = false) {
  const st = useHolders.getState(), old = st.lists[deviceId] ?? [];
  const next = mergeTrays(old, trays, force);
  if (sameHolders(old, next)) return;
  setLists({ ...st.lists, [deviceId]: next });
  if (deviceId === activeKey()) { if (force) useHolders.setState({ linked: true }); pullFromMachine({ ask: !force }); }
}

let started = false;
/** Keep holders, live printers and the project's filament slots in step. */
export function startHolderSync() {
  if (started) return;
  started = true;
  let lastKey = activeKey();
  const sig = new Map<string, string>();
  useDevices.subscribe((d) => {
    for (const dev of d.devices) {
      const s = d.status[dev.id];
      if (!statusHasAms(s)) continue;
      const trays = amsToSlots(s.ams);
      const k = JSON.stringify(trays);
      if (!trays.length || sig.get(dev.id) === k) continue;
      sig.set(dev.id, k);
      adoptTrays(dev.id, trays);
    }
    const key = activeKey();
    if (key !== lastKey) { lastKey = key; useHolders.setState({ linked: true }); pullFromMachine(); }
  });
  useStore.subscribe((s, p) => {
    if (s.printerId !== p.printerId) { const key = activeKey(); if (key !== lastKey) { lastKey = key; useHolders.setState({ linked: true }); pullFromMachine(); } return; }
    if (s.filaments !== p.filaments && !applying) pushToMachine();
  });
  if (!holdersOf()) pushToMachine(); else pullFromMachine();
}

/* ---------- plugins asking for a filament */

/** Slot that has this filament: an exact loaded slot, else a planned slot (added, "load before printing").
 *  `presetId` omitted: any material with that colour. Full (16 slots): the nearest colour. */
export function slotForFilament(hex: string, presetId?: string): number {
  const s = useStore.getState();
  const eq = (f: FilamentSlotState) => f.color.toLowerCase() === hex.toLowerCase() && (!presetId || f.presetId === presetId);
  const i = s.filaments.findIndex(eq);
  if (i >= 0) return i;
  if (s.filaments.length >= 16) return nearestSlot(hex);
  s.set({ filaments: [...s.filaments, { presetId: presetId ?? s.filaments.find((f) => !f.planned)?.presetId ?? 'generic-pla', color: hex.toUpperCase(), planned: true }], flushMatrix: null });
  s.markDirty();
  return useStore.getState().filaments.length - 1;
}

const rgb = (h: string) => { const n = parseInt(h.replace('#', '').slice(0, 6), 16) || 0; return [n >> 16, (n >> 8) & 255, n & 255]; };
export const colourDistance = (a: string, b: string) => { const p = rgb(a), q = rgb(b); return (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2; };
/** Loaded slot nearest in colour (planned slots only when nothing is loaded). */
export function nearestSlot(hex: string): number {
  const f = useStore.getState().filaments;
  const pool = f.map((x, i) => ({ x, i })).filter((e) => !e.x.planned);
  const list = pool.length ? pool : f.map((x, i) => ({ x, i }));
  return list.reduce((b, e) => (colourDistance(e.x.color, hex) < colourDistance(f[b].color, hex) ? e.i : b), list[0]?.i ?? 0);
}
/** Is a colour (optionally a material) loaded in the machine? */
export const isLoaded = (hex: string, presetId?: string) => useStore.getState().filaments.some((f) => !f.planned && f.color.toLowerCase() === hex.toLowerCase() && (!presetId || f.presetId === presetId));
