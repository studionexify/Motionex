// Sync AMS: copy the connected printer's loaded AMS trays (material + colour) into the project's filament slots.
import { amsToSlots, statusHasAms, type AmsSlot } from '../profiles/amsSync';
import { filamentById } from '../profiles/filaments';
import type { PrinterStatus } from '../connect/types';
import { useDevices } from './devices';
import { useStore, type FilamentSlotState } from './store';
import { adoptTrays, startHolderSync } from './holders';

/** The connected device to sync from: the selected one if it reports AMS, else any connected device that does. */
export function amsSource(d = useDevices.getState()): { id: string; name: string; status: PrinterStatus } | null {
  const ids = [d.selected, ...d.devices.map((x) => x.id)].filter((x): x is string => !!x);
  for (const id of ids) if (statusHasAms(d.status[id])) return { id, name: d.devices.find((x) => x.id === id)?.name ?? 'printer', status: d.status[id] };
  return null;
}

/** Why Sync AMS is unavailable, or null when it can run. */
export function amsUnavailableReason(d = useDevices.getState()): string | null {
  if (amsSource(d)) return null;
  const connected = d.devices.some((x) => { const s = d.status[x.id]; return s && s.state !== 'offline' && s.state !== 'connecting'; });
  return connected ? 'The connected printer reports no AMS' : 'Connect a printer with an AMS in the Device tab first';
}

/** New slot list: one slot per loaded tray, keeping a slot's own tuning / overrides when it keeps the same filament. */
export function slotsFromAms(trays: AmsSlot[], current: FilamentSlotState[]): FilamentSlotState[] {
  return trays.map((t, k) => {
    const old = current[k];
    return old && old.presetId === t.presetId ? { ...old, color: t.color } : { presetId: t.presetId, color: t.color };
  });
}

export function syncAmsFromPrinter(): boolean {
  const s = useStore.getState();
  const src = amsSource();
  if (!src) { s.set({ toast: { kind: 'warn', text: `Sync AMS: ${amsUnavailableReason()}.` } }); return false; }
  const trays = amsToSlots(src.status.ams);
  if (!trays.length) { s.set({ toast: { kind: 'warn', text: `Sync AMS: ${src.name} reports no loaded trays.` } }); return false; }
  const n = trays.length;
  // objects and colour paint that use slots that no longer exist fall back to slot 1 (recorded as one undo step)
  if (s.objects.some((o) => (o.filament ?? 0) >= n || o.paint?.color?.some((c) => c > n))) {
    s.updateObjects((o) => ({
      ...o,
      filament: o.filament !== undefined && o.filament >= n ? 0 : o.filament,
      paint: o.paint?.color ? { ...o.paint, color: o.paint.color.map((c) => (c > n ? 0 : c)) } : o.paint,
    }), s.objects.map((o) => o.id));
  }
  s.set({ filaments: [...slotsFromAms(trays, s.filaments), ...s.filaments.filter((f) => f.planned)], flushMatrix: null });
  s.markDirty();
  adoptTrays(src.id, trays, true);
  const unmatched = trays.filter((t) => !t.matched);
  const list = trays.map((t) => `${t.tray} ${t.trayType}`).join(', ');
  s.set({ toast: { kind: unmatched.length ? 'warn' : 'info', text: `Synced ${n} filament slot${n > 1 ? 's' : ''} from ${src.name}: ${list}.${unmatched.length ? ` No matching preset for ${unmatched.map((t) => t.trayType).join(', ')} — using ${filamentById('generic-pla').name}.` : ''}` } });
  return true;
}

/** Keep the project's filament slots in step with the machine's filament holders (and live printers). */
export function startAutoFilamentSync() { startHolderSync(); }
