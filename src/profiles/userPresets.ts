// User process presets: a named snapshot of the plate's process changes on top of a system preset.
// Applying one restores the system preset and the same overrides, so it resolves exactly as when it was saved.
import type { Config } from './settings';

export interface UserPreset {
  id: string;
  name: string;
  /** System process preset (PROCESS_PRESETS id) the overrides build on. */
  basePresetId: string;
  overrides: Config;
  updated: number;
}

const stable = (c: Config) => JSON.stringify(Object.keys(c).sort().map((k) => [k, c[k]]));
export const sameConfig = (a: Config, b: Config) => stable(a) === stable(b);

/** The current settings differ from what the user preset stores. */
export const userPresetModified = (p: UserPreset, presetId: string, overrides: Config) => p.basePresetId !== presetId || !sameConfig(p.overrides, overrides);

/** Validate presets read from storage or a project file (drops malformed entries). */
export function sanitizeUserPresets(v: unknown): UserPreset[] {
  if (!Array.isArray(v)) return [];
  return v.filter((p) => p && typeof p.id === 'string' && typeof p.name === 'string' && typeof p.basePresetId === 'string' && p.overrides && typeof p.overrides === 'object')
    .map((p) => ({ id: p.id, name: p.name, basePresetId: p.basePresetId, overrides: { ...p.overrides }, updated: Number(p.updated) || 0 }));
}

/** Option value used in process preset selects for a user preset. */
export const USER_PREFIX = 'user:';
