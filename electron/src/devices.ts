// Device manager for the desktop app: owns every printer connection in the main process and
// relays status / camera frames to the renderer over IPC.
import { app, ipcMain, safeStorage, type WebContents } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { LanConnection, type LanConfig } from './lan';
import { MoonrakerConnection, OctoPrintConnection } from '../../src/connect/http';
import type { PrinterConnection, SavedDevice } from '../../src/connect/types';

const conns = new Map<string, { c: PrinterConnection; off: (() => void)[]; cam?: () => void }>();
const SECRET_KEYS = ['accessCode', 'apiKey'] as const;
const file = () => path.join(app.getPath('userData'), 'devices.json');

function create(cfg: LanConfig): PrinterConnection {
  switch (cfg.kind) {
    case 'bbl_lan': return new LanConnection(cfg);
    case 'moonraker': return new MoonrakerConnection(cfg);
    case 'octoprint': return new OctoPrintConnection(cfg);
    default: throw new Error(`${cfg.kind} connections run in the window, not the main process`);
  }
}

function seal(v: string) {
  return safeStorage.isEncryptionAvailable() ? 'enc:' + safeStorage.encryptString(v).toString('base64') : v;
}
function unseal(v: string) {
  if (!v.startsWith('enc:')) return v;
  try { return safeStorage.decryptString(Buffer.from(v.slice(4), 'base64')); } catch { return ''; }
}

const send = (wc: WebContents, ch: string, ...args: unknown[]) => { if (!wc.isDestroyed()) wc.send(ch, ...args); };

export function registerDeviceIpc() {
  ipcMain.handle('nx:devices:load', async () => {
    try {
      const list = JSON.parse(await fs.readFile(file(), 'utf8')) as SavedDevice[];
      for (const d of list) for (const k of SECRET_KEYS) if (d.config[k]) d.config[k] = unseal(d.config[k]!);
      return list;
    } catch { return []; }
  });
  ipcMain.handle('nx:devices:save', async (_e, list: SavedDevice[]) => {
    const out = list.map((d) => {
      const config = { ...d.config };
      for (const k of SECRET_KEYS) if (config[k]) config[k] = seal(config[k]!);
      return { ...d, config };
    });
    await fs.mkdir(path.dirname(file()), { recursive: true });
    await fs.writeFile(file(), JSON.stringify(out, null, 2));
    return true;
  });

  ipcMain.handle('nx:dev:connect', async (ev, id: string, cfg: LanConfig) => {
    const old = conns.get(id);
    if (old) { old.off.forEach((f) => f()); old.cam?.(); await old.c.disconnect().catch(() => {}); }
    const c = create(cfg);
    const entry = { c, off: [c.onStatus((s) => send(ev.sender, 'nx:dev:status', id, s))] };
    conns.set(id, entry);
    await c.connect();
    return c.status();
  });
  ipcMain.handle('nx:dev:disconnect', async (_e, id: string) => {
    const e = conns.get(id);
    if (!e) return;
    e.off.forEach((f) => f()); e.cam?.();
    conns.delete(id);
    await e.c.disconnect();
  });
  ipcMain.handle('nx:dev:call', async (ev, id: string, method: string, args: unknown[]) => {
    const e = conns.get(id);
    if (!e) throw new Error('Printer is not connected');
    const c = e.c as any;
    if (method === 'upload') {
      const [name, data] = args as [string, ArrayBuffer];
      return c.upload(name, data, (f: number) => send(ev.sender, 'nx:dev:progress', id, f));
    }
    const allowed = ['startPrint', 'pause', 'resume', 'cancel', 'sendGcode', 'listFiles', 'deleteFile', 'setLight', 'setSpeed', 'cameraUrl'];
    if (!allowed.includes(method) || typeof c[method] !== 'function') throw new Error(`Unsupported: ${method}`);
    return c[method](...args);
  });
  ipcMain.handle('nx:dev:camera', async (ev, id: string, on: boolean) => {
    const e = conns.get(id);
    if (!e) return false;
    e.cam?.(); e.cam = undefined;
    if (!on) { (e.c as any).stopCamera?.(); return true; }
    if (!e.c.onFrame) return false;
    e.cam = e.c.onFrame((jpg) => send(ev.sender, 'nx:dev:frame', id, jpg));
    return true;
  });
}

export async function disconnectAll() {
  await Promise.all([...conns.values()].map((e) => e.c.disconnect().catch(() => {})));
  conns.clear();
}
