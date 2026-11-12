// Printer host for Motionex Studio, shared by the desktop app and the web app. It maps the printer
// connection layer (useDevices: Bambu LAN, Klipper/Moonraker, OctoPrint, USB) onto the studio's StudioHost.
import { connectDevice, handleOf, removeDevice, saveDevice, uploadAndPrint, useDevices, reloadDevices } from '../state/devices';
import { discoverPrinters } from '../connect/client';
import { PRINTERS as PROFILES } from '../profiles/printers';
import { PRINTERS as MACHINES } from './generator';
import type { PrinterLink, StudioHost, PrinterSetup } from './studio';
import type { ConnectionKind } from '../connect/types';
import type { WsBridge } from '../connect/wsbridge';

const bedOf = (printerId: string): [number, number, number] | undefined => {
  const m = MACHINES.find((x) => x.id === printerId); if (m) return m.bed;
  const p = (PROFILES as { id: string; bed: { x: number; y: number; z: number } }[]).find((x) => x.id === printerId);
  return p ? [p.bed.x, p.bed.y, p.bed.z] : undefined;
};

export function makeHost(opts: { manage?: () => void; bridge?: WsBridge } = {}): StudioHost {
  const setup: PrinterSetup | undefined = opts.bridge ? {
    bridge: opts.bridge,
    async add(p) {
      const id = Math.random().toString(36).slice(2, 10);
      await saveDevice({ id, name: p.name, printerId: p.machine, config: { kind: p.kind as ConnectionKind, host: p.host, serial: p.serial, accessCode: p.accessCode, apiKey: p.apiKey } });
      await connectDevice(id).catch(() => {});
      return id;
    },
    remove: (id) => removeDevice(id),
    discover: () => discoverPrinters(),
    reload: () => reloadDevices(),
  } : undefined;
  return {
    printers(): PrinterLink[] {
      const st = useDevices.getState();
      return st.devices.map((d) => {
        const s = st.status[d.id];
        return { id: d.id, name: d.name, state: st.busy[d.id] ?? s?.state ?? 'offline', progress: s?.progress, detail: s?.message, bed: bedOf(d.printerId), machine: d.printerId, kind: d.config.kind, address: d.config.host };
      });
    },
    subscribe(cb) { return useDevices.subscribe(cb); },
    async send(id, fileName, gcode, start, onProgress) {
      const off = useDevices.subscribe((s) => { const f = s.upload[id]; if (f != null) onProgress?.(f); });
      try { await uploadAndPrint(id, fileName, new TextEncoder().encode(gcode).buffer as ArrayBuffer, start); } finally { off(); }
    },
    async control(id, action) {
      if (action === 'connect') return connectDevice(id);
      const h = handleOf(id);
      if (action === 'pause') return h.pause();
      if (action === 'resume') return h.resume();
      return h.cancel();
    },
    manage() { opts.manage?.(); },
    setup,
  };
}
