// Motionex printer bridge. Run it on any computer on the same network as your printers; the Motionex
// web app (in your browser) talks to it over a local WebSocket and it talks to the printers:
//   Bambu Lab A1 / P1S  — LAN mode (MQTT + FTPS), same code as the desktop app
//   Klipper / Moonraker — Elegoo Neptune 4 Max, Snapmaker U1
//   OctoPrint           — any OctoPrint printer
// It only listens on this computer (127.0.0.1), only answers the Motionex site, and only after the
// page has been paired with the code it prints at start-up.
//
//   node motionex-bridge.cjs [--port 47800] [--origin https://motionex.pages.dev] [--lan]
import { WebSocketServer, type WebSocket } from 'ws';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { LanConnection, type LanConfig } from '../electron/src/lan';
import { discoverPrinters } from '../electron/src/discover';
import { MoonrakerConnection, OctoPrintConnection } from '../src/connect/http';
import type { PrinterConnection, SavedDevice } from '../src/connect/types';

const VERSION = '1.0.0';
const arg = (name: string, d?: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : d; };
const dir = path.join(os.homedir(), '.motionex-bridge');
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const cfgFile = path.join(dir, 'config.json'), devFile = path.join(dir, 'devices.json');
const readJson = <T,>(f: string, d: T): T => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f: string, v: unknown) => fs.writeFileSync(f, JSON.stringify(v, null, 2), { mode: 0o600 });

// Secrets (Bambu access codes, OctoPrint/Moonraker API keys) are encrypted at rest with AES-256-GCM.
// The key is random, kept in its own file (owner-only) and bound to this user and computer, so a copied
// devices.json is useless on its own.
const keyFile = path.join(dir, 'secret.key');
if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, crypto.randomBytes(32), { mode: 0o600 });
const KEY = crypto.scryptSync(fs.readFileSync(keyFile), `motionex-bridge|${os.userInfo().username}|${os.hostname()}`, 32);
const SECRET_FIELDS = ['accessCode', 'apiKey'] as const;
function seal(v: string) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([c.update(v, 'utf8'), c.final()]);
  return `enc:v1:${Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64')}`;
}
function unseal(v: string) {
  if (!v.startsWith('enc:v1:')) return v;   // older plain entries are re-saved encrypted below
  try {
    const b = Buffer.from(v.slice(7), 'base64'), d = crypto.createDecipheriv('aes-256-gcm', KEY, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
  } catch { return ''; }
}
const sealDevices = (list: SavedDevice[]) => list.map((d) => { const c: Record<string, unknown> = { ...d.config }; for (const k of SECRET_FIELDS) if (typeof c[k] === 'string' && c[k]) c[k] = seal(c[k] as string); return { ...d, config: c }; });
const openDevices = (list: SavedDevice[]) => list.map((d) => { const c: Record<string, unknown> = { ...d.config }; for (const k of SECRET_FIELDS) if (typeof c[k] === 'string' && c[k]) c[k] = unseal(c[k] as string); return { ...d, config: c as SavedDevice['config'] }; });
const loadDevicesFile = () => openDevices(readJson<SavedDevice[]>(devFile, []));
const saveDevicesFile = (list: SavedDevice[]) => writeJson(devFile, sealDevices(list));
// upgrade any plain-text secrets left by an older bridge
{ const raw = readJson<SavedDevice[]>(devFile, []); if (raw.some((d) => SECRET_FIELDS.some((k) => d.config[k] && !String(d.config[k]).startsWith('enc:v1:')))) saveDevicesFile(openDevices(raw)); }

const cfg = readJson<{ code?: string; origins?: string[] }>(cfgFile, {});
if (!cfg.code) cfg.code = crypto.randomInt(100000, 999999).toString();
const extraOrigin = arg('origin');
cfg.origins = [...new Set([...(cfg.origins ?? ['https://motionex.pages.dev']), ...(extraOrigin ? [extraOrigin] : [])])];
writeJson(cfgFile, cfg);
const port = +(arg('port', '47800')!);
const host = process.argv.includes('--lan') ? '0.0.0.0' : '127.0.0.1';

/** Allowed pages: the configured site(s), their preview deployments (*.motionex.pages.dev) and local development. */
function originAllowed(o: string | undefined) {
  if (!o) return false;
  try {
    const u = new URL(o);
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return true;
    return cfg.origins!.some((a) => { const b = new URL(a); return u.protocol === b.protocol && (u.hostname === b.hostname || u.hostname.endsWith(`.${b.hostname}`)); });
  } catch { return false; }
}

const conns = new Map<string, { c: PrinterConnection; off: () => void }>();
const clients = new Set<WebSocket>();
const broadcast = (m: unknown) => { const s = JSON.stringify(m); for (const ws of clients) if (ws.readyState === 1) ws.send(s); };

function create(c: LanConfig): PrinterConnection {
  switch (c.kind) {
    case 'bbl_lan': return new LanConnection(c);
    case 'moonraker': return new MoonrakerConnection(c);
    case 'octoprint': return new OctoPrintConnection(c);
    default: throw new Error(`${c.kind} printers connect from the browser (USB), not the bridge`);
  }
}

const ALLOWED = ['startPrint', 'pause', 'resume', 'cancel', 'sendGcode', 'listFiles', 'deleteFile', 'setLight', 'setSpeed', 'cameraUrl'];
async function handle(op: string, a: any[]): Promise<unknown> {
  switch (op) {
    case 'load': return loadDevicesFile();
    case 'save': saveDevicesFile(a[0]); return true;
    case 'discover': return discoverPrinters();
    case 'connect': {
      const [id, c] = a as [string, LanConfig];
      const old = conns.get(id); if (old) { old.off(); await old.c.disconnect().catch(() => {}); }
      const conn = create(c);
      conns.set(id, { c: conn, off: conn.onStatus((s) => broadcast({ ev: 'status', id, s })) });
      await conn.connect();
      return conn.status();
    }
    case 'disconnect': { const e = conns.get(a[0]); if (e) { e.off(); conns.delete(a[0]); await e.c.disconnect(); } return null; }
    case 'call': {
      const [id, method, args] = a as [string, string, unknown[]];
      const e = conns.get(id); if (!e) throw new Error('Printer is not connected');
      const c = e.c as any;
      if (method === 'upload') {
        const [name, b64] = args as [string, string];
        const buf = Buffer.from(b64, 'base64');
        return c.upload(name, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), (f: number) => broadcast({ ev: 'progress', id, f }));
      }
      if (!ALLOWED.includes(method) || typeof c[method] !== 'function') throw new Error(`Unsupported: ${method}`);
      return c[method](...args);
    }
    case 'camera': return false;
  }
  throw new Error(`Unknown request ${op}`);
}

const wss = new WebSocketServer({ host, port, maxPayload: 512 * 1024 * 1024 });
wss.on('connection', (ws, req) => {
  if (!originAllowed(req.headers.origin)) { ws.close(4003, 'This site is not allowed to use the bridge'); return; }
  let paired = false;
  ws.on('message', async (raw) => {
    let m: any; try { m = JSON.parse(String(raw)); } catch { return; }
    if (m.op === 'hello') {
      paired = String(m.code ?? '') === cfg.code;
      ws.send(JSON.stringify({ rid: m.rid, ok: paired, result: paired ? { version: VERSION, host: os.hostname() } : undefined, error: paired ? undefined : 'Wrong pairing code' }));
      if (paired) clients.add(ws);
      return;
    }
    if (!paired) { ws.send(JSON.stringify({ rid: m.rid, ok: false, error: 'Pair first' })); return; }
    try { ws.send(JSON.stringify({ rid: m.rid, ok: true, result: await handle(m.op, m.args ?? []) })); }
    catch (e) { ws.send(JSON.stringify({ rid: m.rid, ok: false, error: String((e as Error)?.message ?? e) })); }
  });
  ws.on('close', () => clients.delete(ws));
});
wss.on('listening', () => {
  console.log(`\n  Motionex printer bridge ${VERSION}`);
  console.log(`  Listening on ws://${host}:${port}  ·  allowed site(s): ${cfg.origins!.join(', ')}`);
  console.log(`\n  Pairing code:  ${cfg.code}\n`);
  console.log('  Open Motionex in your browser → Printers → Bridge, and enter this code once.');
  console.log(`  Printers and settings are kept in ${dir}\n  Leave this window open while you print. Ctrl+C to stop.\n`);
});
wss.on('error', (e) => { console.error(`Could not start: ${(e as Error).message}`); process.exit(1); });
const stop = async () => { for (const e of conns.values()) await e.c.disconnect().catch(() => {}); process.exit(0); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
