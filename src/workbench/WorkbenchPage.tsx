// React host for Motionex Studio (the screen Motionex opens on), with the NexSpiro printer
// connections (Bambu LAN, Klipper, OctoPrint, USB) plugged in as the studio's printer host.
import { useEffect, useRef } from 'react';
import { mountStudio } from './studio';
import { initDevices } from '../state/devices';
import { makeHost } from './host';
import { useStore } from '../state/store';
import './studio.css';

const appHost = makeHost({ manage: () => useStore.getState().set({ workspace: 'device' }) });

export function WorkbenchPage() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { void initDevices(); return ref.current ? mountStudio(ref.current, { host: appHost, worker: () => new Worker(new URL('./slice.worker.ts', import.meta.url), { type: 'module' }), meshWorker: () => new Worker(new URL('./mesh.worker.ts', import.meta.url), { type: 'module' }) }) : undefined; }, []);
  return <div ref={ref} className="wb-host" style={{ gridColumn: '1 / -1', minHeight: 0, height: '100%', overflow: 'hidden' }} />;
}
