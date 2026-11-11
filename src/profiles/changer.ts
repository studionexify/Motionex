// How a printer changes filament, from its machine settings. One place, so the slicer, the plugins and
// the panels agree:
//   ams          one nozzle, filaments swapped by a unit (Bambu AMS, MMU, CFS, ACE): purge on every change
//   toolchanger  one nozzle per filament (Prusa XL, Snapmaker U1, Klipper tool changers, IDEX): the next
//                head is picked up already loaded, so no purge, only a small prime and a few seconds
//   manual       one nozzle, the printer pauses (M600) and someone swaps the spool
import type { Config } from './settings';

export type ChangerKind = 'ams' | 'toolchanger' | 'manual';

export function changerOf(cfg: Config | undefined): ChangerKind {
  const t = String(cfg?.changer_type ?? '');
  if (t === 'toolchanger' || t === 'ams' || t === 'manual') return t;
  return cfg?.has_ams === true ? 'ams' : 'manual';
}

/** Filament changes happen without anyone at the printer. */
export const autoChanges = (cfg: Config | undefined) => changerOf(cfg) !== 'manual';

/** Toolheads on a tool changer (1 for every other printer). */
export const toolheadCount = (cfg: Config | undefined) => (changerOf(cfg) === 'toolchanger' ? Math.max(1, Math.round(Number(cfg?.toolhead_count) || 1)) : 1);

/** Short label for the printer's filament change, for panels and badges. */
export function changerLabel(cfg: Config | undefined): string {
  const k = changerOf(cfg);
  return k === 'toolchanger' ? `${toolheadCount(cfg)} toolheads` : k === 'ams' ? 'AMS' : 'Manual';
}

export type PurgeTarget = 'chute' | 'tower';

/** Where a filament unit flushes the old colour: a purge chute behind the bed (Bambu, CFS, ACE) or the prime tower
 *  (MMU3, ERCF / Happy Hare, BoxTurtle and any unit without a chute). Unset: chute on Bambu printers, tower otherwise. */
export function purgeTarget(cfg: Config | undefined): PurgeTarget {
  const t = String(cfg?.purge_target ?? '');
  if (t === 'chute' || t === 'tower') return t;
  const flavor = cfg?.gcode_flavor;
  return flavor === 'bbl' || (flavor === undefined && cfg?.has_ams === true) ? 'chute' : 'tower';
}

/** A filament unit that flushes into the prime tower: the flush is printed there and [flush_length] is 0. */
export const flushesIntoTower = (cfg: Config | undefined) => changerOf(cfg) === 'ams' && purgeTarget(cfg) === 'tower';

/** Filament slots the printer can feed without a manual swap: heads on a tool changer, the unit's slots on a
 *  filament unit (0 = not set, no limit checked), 1 for manual changes. */
export function slotCount(cfg: Config | undefined): number {
  const k = changerOf(cfg);
  if (k === 'toolchanger') return toolheadCount(cfg);
  if (k === 'manual') return 1;
  return Math.max(0, Math.round(Number(cfg?.filament_slots) || 0));
}

/** Tool changers: physical head for each filament slot, from the printer's tool_map setting ("2,0,1,3");
 *  [] for every other printer and when unset (slot n prints with head n). Applied to the finished G-code at send time. */
export function toolMapOf(cfg: Config | undefined): number[] {
  if (changerOf(cfg) !== 'toolchanger') return [];
  return String(cfg?.tool_map ?? '').split(',').map((x, k) => { const n = Number(x.trim()); return x.trim() !== '' && Number.isInteger(n) && n >= 0 ? n : k; });
}
