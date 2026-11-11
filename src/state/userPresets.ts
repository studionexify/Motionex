// User process preset actions (save / apply / rename / overwrite / delete) on the store.
import { PROCESS_PRESETS } from '../profiles/settings';
import { USER_PREFIX, userPresetModified, type UserPreset } from '../profiles/userPresets';
import { newId, useStore } from './store';

const st = () => useStore.getState();
const toast = (text: string, kind: 'info' | 'warn' | 'error' = 'info') => st().set({ toast: { kind, text } });

/** The applied user preset, if the current base preset still is its base. */
export function activeUserPreset(s = st()): UserPreset | null {
  const p = s.userPresets.find((x) => x.id === s.userPresetId);
  return p && p.basePresetId === s.presetId ? p : null;
}
export const isActiveUserPresetModified = (s = st()) => { const p = activeUserPreset(s); return !!p && userPresetModified(p, s.presetId, s.overrides); };

/** Save the current process settings (system preset + plate overrides) as a new user preset and make it active. */
export function saveUserPreset(name: string): UserPreset | null {
  const s = st();
  const n = name.trim();
  if (!n) return null;
  if (s.userPresets.some((p) => p.name.toLowerCase() === n.toLowerCase())) { toast(`A preset named "${n}" already exists — use Update to overwrite it.`, 'warn'); return null; }
  const p: UserPreset = { id: newId('up'), name: n, basePresetId: s.presetId, overrides: structuredClone(s.overrides), updated: Date.now() };
  s.set({ userPresets: [...s.userPresets, p], userPresetId: p.id });
  toast(`Saved preset "${n}"`);
  return p;
}

/** Restore a user preset: its system preset and exactly its overrides. */
export function applyUserPreset(id: string) {
  const s = st();
  const p = s.userPresets.find((x) => x.id === id);
  if (!p) return;
  const base = PROCESS_PRESETS.some((x) => x.id === p.basePresetId) ? p.basePresetId : s.presetId;
  s.set({ presetId: base, overrides: structuredClone(p.overrides), userPresetId: p.id });
  s.markDirty();
}

/** Overwrite a user preset with the current settings ("Update preset"). */
export function updateUserPreset(id: string) {
  const s = st();
  s.set({ userPresets: s.userPresets.map((p) => (p.id === id ? { ...p, basePresetId: s.presetId, overrides: structuredClone(s.overrides), updated: Date.now() } : p)), userPresetId: id });
  const p = s.userPresets.find((x) => x.id === id);
  if (p) toast(`Updated preset "${p.name}"`);
}

export function renameUserPreset(id: string, name: string) {
  const n = name.trim();
  if (!n) return;
  const s = st();
  if (s.userPresets.some((p) => p.id !== id && p.name.toLowerCase() === n.toLowerCase())) { toast(`A preset named "${n}" already exists.`, 'warn'); return; }
  s.set({ userPresets: s.userPresets.map((p) => (p.id === id ? { ...p, name: n } : p)) });
}

export function deleteUserPreset(id: string) {
  const s = st();
  s.set({ userPresets: s.userPresets.filter((p) => p.id !== id), userPresetId: s.userPresetId === id ? null : s.userPresetId });
}

/** Choose a system preset (keeps the plate's overrides, as before) — the user preset is no longer active. */
export function selectSystemPreset(id: string) {
  st().set({ presetId: id, userPresetId: null });
  st().markDirty();
}

/** Value for <select> handlers that list system and user presets together. */
export function selectPresetValue(v: string) {
  if (v.startsWith(USER_PREFIX)) applyUserPreset(v.slice(USER_PREFIX.length));
  else selectSystemPreset(v);
}
export const currentPresetValue = (s = st()) => { const p = activeUserPreset(s); return p ? USER_PREFIX + p.id : s.presetId; };

/** Merge presets from a project: unknown ids are added; same name gets a "(project)" suffix. */
export function mergeUserPresets(incoming: UserPreset[]) {
  if (!incoming.length) return;
  const s = st();
  const ids = new Set(s.userPresets.map((p) => p.id));
  const names = new Set(s.userPresets.map((p) => p.name.toLowerCase()));
  const add = incoming.filter((p) => !ids.has(p.id)).map((p) => (names.has(p.name.toLowerCase()) ? { ...p, name: `${p.name} (project)` } : p));
  if (add.length) s.set({ userPresets: [...s.userPresets, ...add] });
}
