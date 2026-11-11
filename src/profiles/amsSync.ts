// AMS → filament slots: map the trays a printer reports (material type + colour) onto the project's filament slots.
import type { AmsUnit, PrinterStatus } from '../connect/types';
import { FILAMENTS } from './filaments';

export interface AmsSlot { presetId: string; color: string; /** Tray label, e.g. "A1" (AMS unit letter + tray number). */ tray: string; trayType: string; matched: boolean; rfid?: boolean }

/** Closest filament preset for an AMS tray type ("PLA", "PLA Matte", "PETG HF", "TPU-AMS"…); exact preset type first, then the material family. */
export function closestFilament(trayType: string): { id: string; matched: boolean } {
  const t = trayType.trim().toUpperCase().replace(/[_\s]+/g, '-');
  if (!t) return { id: 'generic-pla', matched: false };
  const exact = FILAMENTS.find((f) => f.type.toUpperCase() === t);
  if (exact) return { id: exact.id, matched: true };
  const has = (re: RegExp) => re.test(t);
  if (has(/^LW-?PLA|FOAM/)) return { id: 'generic-lw-pla', matched: true };
  if (has(/^PLA/) && has(/MATTE|-M$/)) return { id: 'generic-pla-matte', matched: true };
  if (has(/^PLA/)) return { id: 'generic-pla', matched: true };
  if (has(/^PETG|^PET|^PCTG/)) return { id: 'generic-petg', matched: true };
  if (has(/^ASA/)) return { id: 'generic-asa', matched: true };
  if (has(/^ABS/)) return { id: 'generic-abs', matched: true };
  if (has(/^TPU|^TPE/)) return { id: 'generic-tpu', matched: true };
  return { id: 'generic-pla', matched: false };
}

const normColor = (c: string, fallback: string) => {
  const m = /^#?([0-9a-f]{6})/i.exec(c.trim());
  return m ? `#${m[1].toUpperCase()}` : fallback;
};

/** True when a status has at least one AMS unit (a connected printer reporting its trays). */
export const statusHasAms = (s: PrinterStatus | undefined) => !!s && s.state !== 'offline' && s.state !== 'connecting' && !!s.ams?.some((u) => u.trays.length);

/** Loaded trays (non-empty type) in AMS order (unit 0 trays 1–4, unit 1 …), one filament slot each. */
export function amsToSlots(ams: AmsUnit[] | undefined): AmsSlot[] {
  const out: AmsSlot[] = [];
  (ams ?? []).forEach((u, ui) => u.trays.forEach((t, ti) => {
    if (!t.type?.trim()) return; // empty tray
    const { id, matched } = closestFilament(t.type);
    const fil = FILAMENTS.find((f) => f.id === id)!;
    out.push({ presetId: id, color: normColor(t.color ?? '', fil.color), tray: `${String.fromCharCode(65 + (Number(u.id) >= 0 ? Number(u.id) : ui) % 26)}${(Number(t.id) >= 0 ? Number(t.id) : ti) + 1}`, trayType: t.type.trim(), matched, rfid: !!t.rfid });
  }));
  return out;
}
