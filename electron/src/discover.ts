// LAN printer discovery (desktop main process). Read-only: listens and probes, never sends G-code.
// - Bambu Lab printers broadcast SSDP NOTIFY packets on UDP 2021 (and 1990) every few seconds.
// - Klipper/Moonraker printers are found by probing GET /server/info on port 7125 across the local /24.
import dgram from 'node:dgram';
import os from 'node:os';
import { ipcMain } from 'electron';

export interface FoundPrinter {
  kind: 'bbl_lan' | 'moonraker';
  host: string;
  name?: string;
  serial?: string;
  hostname?: string; // Klipper host name (stable when the IP changes)
  model?: string; // vendor model code, e.g. N2S (A1), C12 (P1S), BL-P001 (X1C)
}

/** Parse one Bambu SSDP NOTIFY packet. Exported for tests. */
export function parseBambuSsdp(text: string, from: string): FoundPrinter | null {
  if (!/urn:bambulab-com:device/i.test(text)) return null;
  const h: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) h[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return {
    kind: 'bbl_lan',
    host: h['location'] || from,
    serial: h['usn'] || undefined,
    name: h['devname.bambu.com'] || undefined,
    model: h['devmodel.bambu.com'] || undefined,
  };
}

function listenSsdp(ms: number, found: Map<string, FoundPrinter>) {
  return Promise.all([2021, 1990].map((port) => new Promise<void>((resolve) => {
    const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const done = () => { try { s.close(); } catch { /* closed */ } resolve(); };
    s.on('error', done);
    s.on('message', (msg, r) => {
      const p = parseBambuSsdp(msg.toString('utf8'), r.address);
      if (p) found.set(`${p.kind}:${p.serial ?? p.host}`, p);
    });
    s.bind(port, () => setTimeout(done, ms));
  })));
}

function localSubnets(): string[] {
  const out = new Set<string>();
  for (const list of Object.values(os.networkInterfaces())) for (const a of list ?? []) {
    if (a.family !== 'IPv4' || a.internal) continue;
    if (!/^(10|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(a.address)) continue; // private LANs only
    out.add(a.address.split('.').slice(0, 3).join('.'));
  }
  return [...out];
}

async function probeMoonraker(host: string, found: Map<string, FoundPrinter>) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 700);
  try {
    const r = await fetch(`http://${host}:7125/server/info`, { signal: ctl.signal });
    if (!r.ok) return;
    const j: any = await r.json();
    if (!j?.result?.klippy_state && !j?.result?.moonraker_version) return;
    let hostname: string | undefined;
    try { hostname = ((await (await fetch(`http://${host}:7125/printer/info`, { signal: ctl.signal })).json()) as any)?.result?.hostname || undefined; } catch { /* optional */ }
    found.set(`moonraker:${host}`, { kind: 'moonraker', host, hostname, name: hostname ?? `Klipper @ ${host}` });
  } catch { /* not a printer */ } finally { clearTimeout(t); }
}

async function scanMoonraker(found: Map<string, FoundPrinter>) {
  const hosts = localSubnets().flatMap((n) => Array.from({ length: 254 }, (_, i) => `${n}.${i + 1}`));
  for (let i = 0; i < hosts.length; i += 64) await Promise.all(hosts.slice(i, i + 64).map((h) => probeMoonraker(h, found)));
}

export async function discoverPrinters(ms = 6000): Promise<FoundPrinter[]> {
  const found = new Map<string, FoundPrinter>();
  await Promise.all([listenSsdp(ms, found), scanMoonraker(found)]);
  return [...found.values()];
}

export function registerDiscoveryIpc() {
  ipcMain.handle('nx:dev:discover', () => discoverPrinters());
}
