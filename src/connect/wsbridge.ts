// Browser side of the Motionex printer bridge (bridge/main.ts). It speaks the same DeviceBridge interface the
// desktop app exposes, so the rest of the printer code is unchanged: once paired, window.nexspiro.devices
// points here and every network printer goes through the bridge on your computer.
import type { DeviceBridge, FoundPrinter } from './client';
import type { PrinterStatus, SavedDevice } from './types';

export type BridgeState = 'off' | 'connecting' | 'pairing' | 'ready' | 'error';
const KEY = 'motionex.bridge.v1';
interface Saved { url: string; code: string }
const read = (): Saved => { try { return { url: 'ws://127.0.0.1:47800', code: '', ...JSON.parse(localStorage.getItem(KEY) ?? '{}') }; } catch { return { url: 'ws://127.0.0.1:47800', code: '' }; } };

export class WsBridge {
  state: BridgeState = 'off';
  error = '';
  info: { version: string; host: string } | null = null;
  private ws: WebSocket | null = null;
  private rid = 0;
  private wait = new Map<number, { ok: (v: any) => void; no: (e: Error) => void }>();
  private ls = { status: new Set<(id: string, s: PrinterStatus) => void>(), progress: new Set<(id: string, f: number) => void>() };
  private watchers = new Set<() => void>();
  private retry = 0;
  saved = read();

  onChange(cb: () => void) { this.watchers.add(cb); return () => this.watchers.delete(cb); }
  private set(s: BridgeState, err = '') { this.state = s; this.error = err; this.watchers.forEach((f) => f()); }

  /** Connect (and pair). Resolves true when ready. */
  connect(url = this.saved.url, code = this.saved.code): Promise<boolean> {
    this.saved = { url, code };
    try { localStorage.setItem(KEY, JSON.stringify(this.saved)); } catch { /* blocked */ }
    this.ws?.close();
    clearTimeout(this.retry);
    if (!code) { this.set('pairing'); return Promise.resolve(false); }
    this.set('connecting');
    return new Promise((resolve) => {
      let ws: WebSocket;
      try { ws = new WebSocket(url); } catch (e) { this.set('error', String((e as Error).message)); resolve(false); return; }
      this.ws = ws;
      ws.onopen = async () => {
        try {
          this.info = await this.req('hello', [], { code });
          (window as any).nexspiro = { ...((window as any).nexspiro ?? {}), devices: this.api };
          this.set('ready'); resolve(true);
        } catch (e) { this.set('pairing', String((e as Error).message)); resolve(false); }
      };
      ws.onmessage = (ev) => {
        const m = JSON.parse(String(ev.data));
        if (m.ev === 'status') this.ls.status.forEach((f) => f(m.id, m.s));
        else if (m.ev === 'progress') this.ls.progress.forEach((f) => f(m.id, m.f));
        else if (m.rid != null) { const w = this.wait.get(m.rid); if (w) { this.wait.delete(m.rid); m.ok ? w.ok(m.result) : w.no(new Error(m.error)); } }
      };
      ws.onerror = () => { if (this.state === 'connecting') { this.set('error', 'The bridge is not running on this computer (or your browser blocked the local connection).'); resolve(false); } };
      ws.onclose = (ev) => {
        for (const w of this.wait.values()) w.no(new Error('Bridge disconnected')); this.wait.clear();
        if ((window as any).nexspiro?.devices === this.api) delete (window as any).nexspiro.devices;
        if (ev.code === 4003) { this.set('error', 'The bridge does not allow this site. Start it with --origin ' + location.origin); return; }
        if (this.state === 'ready') { this.set('error', 'Lost the bridge. Reconnecting…'); this.retry = window.setTimeout(() => void this.connect(), 3000); }
      };
    });
  }
  disconnect() { clearTimeout(this.retry); this.ws?.close(); this.set('off'); }

  private req(op: string, args: unknown[] = [], extra: Record<string, unknown> = {}): Promise<any> {
    return new Promise((ok, no) => {
      if (!this.ws || this.ws.readyState !== 1) { no(new Error('Bridge is not connected')); return; }
      const rid = ++this.rid; this.wait.set(rid, { ok, no });
      this.ws.send(JSON.stringify({ rid, op, args, ...extra }));
    });
  }

  /** DeviceBridge for the existing printer code. */
  readonly api: DeviceBridge = {
    load: () => this.req('load') as Promise<SavedDevice[]>,
    save: (list) => this.req('save', [list]),
    connect: (id, cfg) => this.req('connect', [id, cfg]),
    disconnect: (id) => this.req('disconnect', [id]),
    call: async (id, method, args) => {
      if (method === 'upload') {
        const [name, data] = args as [string, ArrayBuffer];
        const b = new Uint8Array(data); let s = '';
        for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
        return this.req('call', [id, 'upload', [name, btoa(s)]]);
      }
      return this.req('call', [id, method, args]);
    },
    camera: async () => false,
    discover: () => this.req('discover') as Promise<FoundPrinter[]>,
    onStatus: (cb) => { this.ls.status.add(cb); return () => this.ls.status.delete(cb); },
    onProgress: (cb) => { this.ls.progress.add(cb); return () => this.ls.progress.delete(cb); },
    onFrame: () => () => {},
  };
}

export const bridge = new WsBridge();
