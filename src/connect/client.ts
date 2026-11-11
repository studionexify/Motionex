// Renderer-side access to printer connections. On the desktop app, network printers run in the
// main process (window.nexspiro.devices); USB serial runs here via Web Serial. In the browser
// build, Moonraker / OctoPrint are reached directly (the printer must allow CORS).
import { MoonrakerConnection, OctoPrintConnection } from './http';
import { SerialConnection } from './serial';
import { CONNECTION_INFO, type ConnectionConfig, type PrinterConnection, type PrinterStatus, type PrintOptions, type RemoteFile, type SavedDevice } from './types';

export interface DeviceBridge {
  load(): Promise<SavedDevice[]>;
  save(list: SavedDevice[]): Promise<boolean>;
  connect(id: string, cfg: ConnectionConfig): Promise<PrinterStatus>;
  disconnect(id: string): Promise<void>;
  call(id: string, method: string, args: unknown[]): Promise<any>;
  camera(id: string, on: boolean): Promise<boolean>;
  discover?(): Promise<FoundPrinter[]>;
  onStatus(cb: (id: string, s: PrinterStatus) => void): () => void;
  onProgress(cb: (id: string, f: number) => void): () => void;
  onFrame(cb: (id: string, jpeg: Uint8Array) => void): () => void;
}

/** A printer seen on the local network (desktop only). */
export interface FoundPrinter { kind: 'bbl_lan' | 'moonraker'; host: string; name?: string; serial?: string; hostname?: string; model?: string }

/** Scan the Wi-Fi/LAN for printers (~6 s). Empty in the browser build. */
export async function discoverPrinters(): Promise<FoundPrinter[]> {
  const b = bridge();
  return b?.discover ? b.discover() : [];
}

const bridge = (): DeviceBridge | undefined => (window as any).nexspiro?.devices;

export interface DeviceHandle {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  upload(name: string, data: ArrayBuffer, onProgress?: (f: number) => void): Promise<void>;
  startPrint(name: string, o?: PrintOptions): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  cancel(): Promise<void>;
  sendGcode(line: string): Promise<void>;
  listFiles(): Promise<RemoteFile[]>;
  deleteFile(name: string): Promise<void>;
  setLight(on: boolean): Promise<void>;
  setSpeed(level: number): Promise<void>;
  cameraUrl(): Promise<string | null>;
  /** JPEG frame stream (A1/P1). Returns an unsubscribe function, or null if unsupported. */
  camera(cb: (url: string) => void): Promise<(() => void) | null>;
}

/** Camera viewers per device: the stream stays on until the last one (Device page, Bulnex monitor) stops. */
const cameraUsers = new Map<string, number>();

/** Desktop: connection lives in the main process. */
function ipcHandle(d: SavedDevice, b: DeviceBridge, onStatus: (s: PrinterStatus) => void): DeviceHandle {
  const call = (m: string, ...a: unknown[]) => b.call(d.id, m, a);
  let offStatus: (() => void) | null = null;
  return {
    async connect() {
      offStatus?.();
      offStatus = b.onStatus((id, s) => { if (id === d.id) onStatus(s); });
      onStatus(await b.connect(d.id, d.config));
    },
    async disconnect() { await b.disconnect(d.id); offStatus?.(); offStatus = null; onStatus({ state: 'offline' }); },
    async upload(name, data, onProgress) {
      const off = b.onProgress((id, f) => { if (id === d.id) onProgress?.(f); });
      try { await call('upload', name, data); } finally { off(); }
    },
    startPrint: (n, o) => call('startPrint', n, o),
    pause: () => call('pause'), resume: () => call('resume'), cancel: () => call('cancel'),
    sendGcode: (l) => call('sendGcode', l),
    listFiles: () => call('listFiles'), deleteFile: (n) => call('deleteFile', n),
    async setLight(on) { if (d.config.kind === 'bbl_lan') await call('setLight', on); else await call('sendGcode', on ? 'SET_LED LED=chamber_light WHITE=1' : 'SET_LED LED=chamber_light WHITE=0'); },
    async setSpeed(level) { if (d.config.kind === 'bbl_lan') await call('setSpeed', level); else await call('sendGcode', `M220 S${level}`); },
    cameraUrl: () => call('cameraUrl'),
    async camera(cb) {
      if (d.config.kind !== 'bbl_lan') return null;
      let last = '';
      const off = b.onFrame((id, jpg) => {
        if (id !== d.id) return;
        if (last) URL.revokeObjectURL(last);
        last = URL.createObjectURL(new Blob([jpg], { type: 'image/jpeg' }));
        cb(last);
      });
      const users = cameraUsers.get(d.id) ?? 0;
      const ok = users > 0 || await b.camera(d.id, true);
      if (!ok) { off(); return null; }
      cameraUsers.set(d.id, users + 1);
      let stopped = false;
      return () => {
        if (stopped) return;
        stopped = true;
        off();
        const left = (cameraUsers.get(d.id) ?? 1) - 1;
        cameraUsers.set(d.id, left);
        if (left <= 0) void b.camera(d.id, false);
        if (last) URL.revokeObjectURL(last);
      };
    },
  };
}

/** Browser / serial: connection object lives in this window. */
function localHandle(d: SavedDevice, onStatus: (s: PrinterStatus) => void): DeviceHandle {
  let c: PrinterConnection;
  const cfg = d.config;
  if (cfg.kind === 'moonraker') c = new MoonrakerConnection(cfg);
  else if (cfg.kind === 'octoprint') c = new OctoPrintConnection(cfg);
  else if (cfg.kind === 'serial') c = new SerialConnection(cfg.baudRate ?? 115200);
  else throw new Error(`${CONNECTION_INFO[cfg.kind].label} needs the NexSpiro desktop app (it uses direct network sockets).`);
  let off: (() => void) | null = null;
  return {
    async connect() { off?.(); off = c.onStatus(onStatus); await c.connect(); onStatus(c.status()); },
    async disconnect() { await c.disconnect(); off?.(); off = null; onStatus({ state: 'offline' }); },
    upload: (n, data, p) => c.upload(n, data, p),
    startPrint: (n, o) => c.startPrint(n, o), pause: () => c.pause(), resume: () => c.resume(), cancel: () => c.cancel(),
    sendGcode: (l) => c.sendGcode(l), listFiles: () => c.listFiles(), deleteFile: (n) => c.deleteFile(n),
    async setLight(on) { await c.sendGcode(cfg.kind === 'serial' ? (on ? 'M355 S1' : 'M355 S0') : on ? 'SET_LED LED=chamber_light WHITE=1' : 'SET_LED LED=chamber_light WHITE=0'); },
    async setSpeed(level) { await c.sendGcode(`M220 S${level}`); },
    cameraUrl: async () => (c.cameraUrl ? c.cameraUrl() : null),
    camera: async () => null,
  };
}

export function deviceHandle(d: SavedDevice, onStatus: (s: PrinterStatus) => void): DeviceHandle {
  const b = bridge();
  if (b && d.config.kind !== 'serial') return ipcHandle(d, b, onStatus);
  return localHandle(d, onStatus);
}

const LS_KEY = 'nexspiro.devices';
export async function loadDevices(): Promise<SavedDevice[]> {
  const b = bridge();
  let list: SavedDevice[];
  if (b) list = await b.load();
  else try { list = JSON.parse(localStorage.getItem(LS_KEY) ?? '[]'); } catch { list = []; }
  // devices saved before the connection kind was renamed
  return list.map((d) => {
    if ((d.config.kind as string) === 'bambu_lan') return { ...d, config: { ...d.config, kind: 'bbl_lan' } };
    // A Bambu printer saved with a Klipper/OctoPrint connection can never connect: switch it to LAN.
    if (d.printerId.startsWith('bbl-') && d.config.kind !== 'bbl_lan') return { ...d, config: { ...d.config, kind: 'bbl_lan' } };
    return d;
  });
}
export async function saveDevices(list: SavedDevice[]) {
  const b = bridge();
  if (b) { await b.save(list); return; }
  try { localStorage.setItem(LS_KEY, JSON.stringify(list)); } catch { /* storage unavailable */ }
}

/** Serial port chooser (desktop): main asks the window which port to open. */
export function onSerialPortRequest(cb: (ports: { portId: string; displayName?: string; portName?: string }[], pick: (id: string) => void) => void) {
  const s = (window as any).nexspiro?.serial;
  if (!s) return () => {};
  return s.onPorts((ports: any[]) => cb(ports, (id: string) => s.pick(id)));
}
