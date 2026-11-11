// Device workspace state: saved printers, live status and the active connection handles.
import { create } from 'zustand';
import { deviceHandle, discoverPrinters, loadDevices, saveDevices, type DeviceHandle, type FoundPrinter } from '../connect/client';
import type { PrinterStatus, SavedDevice } from '../connect/types';
import { useStore } from './store';

/** Tell the operator a printer connection failed instead of swallowing the error. */
export function reportDeviceError(what: string, e: unknown) {
  const msg = String((e as any)?.message ?? e).replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '');
  try { useStore.getState().set({ toast: { kind: 'error', text: `${what}: ${msg}` } }); } catch { /* store not ready */ }
}

interface DevState {
  loaded: boolean;
  devices: SavedDevice[];
  status: Record<string, PrinterStatus>;
  selected: string | null;
  busy: Record<string, string | null>; // id -> current operation label
  upload: Record<string, number | null>;
  set: (p: Partial<DevState>) => void;
}

export const useDevices = create<DevState>((set) => ({
  loaded: false, devices: [], status: {}, selected: null, busy: {}, upload: {},
  set: (p) => set(p),
}));

const handles = new Map<string, DeviceHandle>();
const setStatus = (id: string, s: PrinterStatus) => useDevices.setState((st) => ({ status: { ...st.status, [id]: s } }));
const setBusy = (id: string, label: string | null) => useDevices.setState((st) => ({ busy: { ...st.busy, [id]: label } }));

export async function initDevices() {
  if (useDevices.getState().loaded) return;
  const devices = await loadDevices();
  useDevices.setState({ loaded: true, devices, selected: devices[0]?.id ?? null });
  // Reconnect every saved network printer in the background. Connecting only reads status;
  // it never sends motion or G-code. USB printers need a user gesture, so they are skipped.
  for (const d of devices) if (d.config.kind !== 'serial') void connectDevice(d.id).catch((e) => reportDeviceError(`${d.name} is offline`, e));
}

export function handleOf(id: string): DeviceHandle {
  let h = handles.get(id);
  if (!h) {
    const d = useDevices.getState().devices.find((x) => x.id === id);
    if (!d) throw new Error('Unknown printer');
    h = deviceHandle(d, (s) => setStatus(id, s));
    handles.set(id, h);
  }
  return h;
}

export async function saveDevice(d: SavedDevice) {
  const st = useDevices.getState();
  const exists = st.devices.some((x) => x.id === d.id);
  const devices = exists ? st.devices.map((x) => (x.id === d.id ? d : x)) : [...st.devices, d];
  if (handles.has(d.id)) { await handles.get(d.id)!.disconnect().catch(() => {}); handles.delete(d.id); }
  useDevices.setState({ devices, selected: d.id });
  await saveDevices(devices);
}

export async function removeDevice(id: string) {
  const h = handles.get(id);
  if (h) { await h.disconnect().catch(() => {}); handles.delete(id); }
  const devices = useDevices.getState().devices.filter((d) => d.id !== id);
  useDevices.setState({ devices, selected: devices[0]?.id ?? null });
  await saveDevices(devices);
}

/** Run a device operation with a busy label; errors become a status message and are re-thrown. */
export async function run<T>(id: string, label: string, fn: (h: DeviceHandle) => Promise<T>): Promise<T> {
  setBusy(id, label);
  try { return await fn(handleOf(id)); }
  finally { setBusy(id, null); }
}

const sameMachine = (d: SavedDevice, f: FoundPrinter) =>
  f.kind === d.config.kind && ((!!f.serial && f.serial === d.config.serial) || (!!f.hostname && f.hostname === d.config.hostname));

/** Update a saved printer's address/identity without dropping a live connection's state. */
async function patchConfig(id: string, patch: Partial<SavedDevice['config']>) {
  const devices = useDevices.getState().devices.map((d) => (d.id === id ? { ...d, config: { ...d.config, ...patch } } : d));
  useDevices.setState({ devices });
  await saveDevices(devices);
}

/** The router gave the printer a new IP: find it on the network by serial / host name and update it. */
async function relocate(id: string): Promise<boolean> {
  const d = useDevices.getState().devices.find((x) => x.id === id);
  if (!d || d.config.kind === 'serial' || (!d.config.serial && !d.config.hostname)) return false;
  setBusy(id, 'Looking for printer on Wi-Fi…');
  try {
    const f = (await discoverPrinters()).find((x) => sameMachine(d, x));
    if (!f || f.host === d.config.host) return false;
    const old = handles.get(id);
    if (old) { await old.disconnect().catch(() => {}); handles.delete(id); }
    await patchConfig(id, { host: f.host });
    return true;
  } finally { setBusy(id, null); }
}

/** After the first good connection, remember the printer's stable identity so a new IP is found automatically. */
async function learnIdentity(id: string) {
  const d = useDevices.getState().devices.find((x) => x.id === id);
  if (!d || d.config.kind !== 'moonraker' || d.config.hostname) return;
  const f = (await discoverPrinters()).find((x) => x.kind === 'moonraker' && x.host === d.config.host);
  if (f?.hostname) await patchConfig(id, { hostname: f.hostname });
}

export async function connectDevice(id: string) {
  try { await run(id, 'Connecting…', (h) => h.connect()); void learnIdentity(id).catch((e) => console.warn('printer identity lookup failed', e)); }
  catch (e: any) {
    if (await relocate(id).catch(() => false)) {
      try { await run(id, 'Connecting…', (h) => h.connect()); return; } catch (e2) { e = e2; }
    } setStatus(id, { state: 'offline', message: String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '') }); throw e; }
}
export const disconnectDevice = (id: string) => run(id, 'Disconnecting…', (h) => h.disconnect());

export async function uploadAndPrint(id: string, name: string, data: ArrayBuffer, start: boolean, opts: Parameters<DeviceHandle['startPrint']>[1] = {}) {
  const st = useDevices.getState();
  if (!st.status[id] || st.status[id].state === 'offline') await connectDevice(id);
  const setUp = (f: number | null) => useDevices.setState((s) => ({ upload: { ...s.upload, [id]: f } }));
  try {
    setUp(0);
    await run(id, 'Uploading…', (h) => h.upload(name, data, (f) => setUp(f)));
    if (start) await run(id, 'Starting print…', (h) => h.startPrint(name, opts));
  } finally { setUp(null); }
}
