// React host for Motionex Studio (the screen Motionex opens on), with the NexSpiro printer
// connections (Bambu LAN, Klipper, OctoPrint, USB) plugged in as the studio's printer host.
import { useEffect, useRef } from 'react';
import { mountStudio, type PrinterLink, type StudioHost } from './studio';
import { connectDevice, handleOf, initDevices, uploadAndPrint, useDevices } from '../state/devices';
import { PRINTERS as PROFILES } from '../profiles/printers';
import { useStore } from '../state/store';
import './studio.css';

const appHost: StudioHost = {
  printers(): PrinterLink[] {
    const st = useDevices.getState();
    return st.devices.map((d) => {
      const s = st.status[d.id];
      const prof = (PROFILES as { id: string; bed: { x: number; y: number; z: number } }[]).find((p) => p.id === d.printerId);
      return { id: d.id, name: d.name, state: st.busy[d.id] ?? s?.state ?? 'offline', progress: s?.progress, detail: s?.message, bed: prof ? [prof.bed.x, prof.bed.y, prof.bed.z] : undefined };
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
  manage() { useStore.getState().set({ workspace: 'device' }); },
};

export function WorkbenchPage() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { void initDevices(); return ref.current ? mountStudio(ref.current, { host: appHost }) : undefined; }, []);
  return <div ref={ref} className="wb-host" style={{ gridColumn: '1 / -1', minHeight: 0, height: '100%', overflow: 'hidden' }} />;
}
