// USB serial (Marlin) connection. NexSpiro is the print host: G-code is streamed line by line
// with line numbers + checksums, waiting for "ok" and honouring "Resend:" requests.
// The protocol core (MarlinHost) is transport-agnostic; SerialConnection binds it to Web Serial,
// which works in the desktop app and in Chrome/Edge.
import { Emitter, type PrinterConnection, type PrinterStatus, type RemoteFile } from './types';

export interface LineTransport {
  write(text: string): Promise<void>;
  onLine(cb: (line: string) => void): () => void;
  close(): Promise<void>;
}

export const checksum = (s: string) => { let c = 0; for (let i = 0; i < s.length; i++) c ^= s.charCodeAt(i); return c & 0xff; };

/** Strip comments/blank lines so only real commands are sent. */
export function gcodeLines(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.replace(/;.*$/, '').trim();
    if (l) out.push(l);
  }
  return out;
}

export function parseTemps(line: string): Partial<PrinterStatus> | null {
  const t = /T:\s*([\d.]+)\s*\/\s*([\d.]+)/.exec(line);
  if (!t) return null;
  const b = /B:\s*([\d.]+)\s*\/\s*([\d.]+)/.exec(line);
  return { nozzleTemp: +t[1], nozzleTarget: +t[2], ...(b ? { bedTemp: +b[1], bedTarget: +b[2] } : {}) };
}

export class MarlinHost {
  private st: PrinterStatus = { state: 'offline' };
  private ev = new Emitter<PrinterStatus>();
  private lineNo = 0;
  private sent = new Map<number, string>();
  private waiting: { resolve: () => void; reject: (e: Error) => void } | null = null;
  private queue: string[] = []; // manual commands, sent between print lines
  private job: { name: string; lines: string[]; pos: number; started: number } | null = null;
  private files = new Map<string, string>();
  private running = false;
  private paused = false;
  private off: (() => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private t: LineTransport, private ackTimeoutMs = 30000) {}

  status() { return this.st; }
  onStatus(cb: (s: PrinterStatus) => void) { return this.ev.on(cb); }
  private set(p: Partial<PrinterStatus>) { this.st = { ...this.st, ...p }; this.ev.emit(this.st); }

  async start() {
    this.off = this.t.onLine((l) => this.onLine(l));
    this.set({ state: 'connecting' });
    await this.raw('M110 N0', true);
    this.lineNo = 1;
    await this.raw('M155 S2', true).catch(() => {}); // temperature auto-report (not all firmwares)
    this.set({ state: 'idle', message: undefined });
    this.timer = setInterval(() => { if (!this.job || this.paused) void this.command('M105').catch((e) => console.warn('serial M105 poll failed', e)); }, 5000);
  }
  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.job = null;
    this.off?.(); this.off = null;
    this.waiting?.reject(new Error('Disconnected'));
    await this.t.close();
    this.set({ state: 'offline' });
  }

  private onLine(line: string) {
    const l = line.trim();
    if (!l) return;
    const temps = parseTemps(l);
    if (temps) this.set(temps);
    const rs = /^(?:Resend|rs)[: ]\s*N?(\d+)/i.exec(l);
    if (rs) { this.resendFrom = Number(rs[1]); return; }
    if (/^ok\b/i.test(l)) {
      const w = this.waiting; this.waiting = null;
      w?.resolve();
      return;
    }
    if (/^Error:/i.test(l) && !/checksum|line number|resend/i.test(l)) {
      this.set({ message: l.slice(6).trim() });
      if (/kill|halted|printer stopped/i.test(l)) { this.job = null; this.set({ state: 'error' }); }
    }
  }
  private resendFrom: number | null = null;

  /** Send one numbered line and wait for its ok, resending on request. */
  private async sendNumbered(cmd: string) {
    const n = this.lineNo++;
    this.sent.set(n, cmd);
    if (this.sent.size > 200) this.sent.delete(n - 200);
    await this.transmit(n, cmd);
    while (this.resendFrom !== null) {
      const from = this.resendFrom; this.resendFrom = null;
      for (let k = from; k < this.lineNo; k++) {
        const c = this.sent.get(k);
        if (c === undefined) throw new Error(`Printer asked to resend line ${k}, which is no longer buffered`);
        await this.transmit(k, c);
        if (this.resendFrom !== null) break;
      }
    }
  }
  private transmit(n: number, cmd: string) {
    const body = `N${n} ${cmd}`;
    return this.wait(() => this.t.write(`${body}*${checksum(body)}\n`));
  }
  private wait(send: () => Promise<void>) {
    return new Promise<void>((resolve, reject) => {
      const to = setTimeout(() => { if (this.waiting?.resolve === done) { this.waiting = null; reject(new Error('Printer stopped responding (no "ok")')); } }, this.ackTimeoutMs);
      const done = () => { clearTimeout(to); resolve(); };
      this.waiting = { resolve: done, reject: (e) => { clearTimeout(to); reject(e); } };
      send().catch((e) => { clearTimeout(to); this.waiting = null; reject(e); });
    });
  }
  private async raw(cmd: string, unnumbered = false) {
    if (unnumbered) {
      const body = cmd === 'M110 N0' ? 'N0 M110 N0' : cmd;
      return this.wait(() => this.t.write(body === cmd ? `${cmd}\n` : `${body}*${checksum(body)}\n`));
    }
    return this.sendNumbered(cmd);
  }

  /** Queue a manual command; runs between print lines while printing. */
  command(line: string): Promise<void> {
    const cmds = gcodeLines(line);
    if (!this.running) {
      return (async () => { this.running = true; try { for (const c of cmds) await this.sendNumbered(c); } finally { this.running = false; } void this.pump(); })();
    }
    this.queue.push(...cmds);
    return Promise.resolve();
  }

  store(name: string, text: string) { this.files.set(name, text); }
  listFiles(): RemoteFile[] { return [...this.files.entries()].map(([name, t]) => ({ name, size: t.length })); }
  deleteFile(name: string) { this.files.delete(name); }

  print(name: string) {
    const text = this.files.get(name);
    if (text === undefined) throw new Error(`${name} is not loaded`);
    if (this.job) throw new Error('A print is already running');
    const lines = gcodeLines(text);
    this.job = { name, lines, pos: 0, started: Date.now() };
    this.paused = false;
    this.set({ state: 'printing', fileName: name, progress: 0, message: undefined });
    void this.pump();
  }
  pause() { if (this.job) { this.paused = true; this.set({ state: 'paused' }); } }
  resume() { if (this.job && this.paused) { this.paused = false; this.set({ state: 'printing' }); void this.pump(); } }
  async cancel() {
    this.job = null; this.paused = false;
    this.queue = [];
    this.set({ state: 'idle', progress: undefined, fileName: undefined });
    await this.command('M104 S0\nM140 S0\nM107\nM84');
  }

  private async pump() {
    if (this.running) return;
    this.running = true;
    try {
      for (;;) {
        if (this.queue.length) { await this.sendNumbered(this.queue.shift()!); continue; }
        const j = this.job;
        if (!j || this.paused) break;
        if (j.pos >= j.lines.length) {
          this.job = null;
          this.set({ state: 'finished', progress: 1, remainingSeconds: 0 });
          break;
        }
        await this.sendNumbered(j.lines[j.pos++]);
        if (j.pos % 20 === 0 || j.pos === j.lines.length) {
          const p = j.pos / j.lines.length, el = (Date.now() - j.started) / 1000;
          this.set({ progress: p, remainingSeconds: p > 0.02 ? el / p - el : undefined });
        }
      }
    } catch (e: any) {
      this.job = null;
      this.set({ state: 'error', message: e.message });
    } finally { this.running = false; }
  }
}

// ------------------------------------------------------------------ Web Serial binding

interface WebSerialPort { open(o: { baudRate: number }): Promise<void>; close(): Promise<void>; readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array>; setSignals?(s: { dataTerminalReady?: boolean }): Promise<void> }

export const hasWebSerial = () => typeof navigator !== 'undefined' && 'serial' in navigator;

async function webSerialTransport(port: WebSerialPort, baudRate: number): Promise<LineTransport> {
  await port.open({ baudRate });
  const enc = new TextEncoder(), dec = new TextDecoder();
  const writer = port.writable.getWriter();
  const reader = port.readable.getReader();
  const ls = new Emitter<string>();
  let buf = '', closed = false;
  (async () => {
    try {
      while (!closed) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let k: number;
        while ((k = buf.indexOf('\n')) >= 0) { ls.emit(buf.slice(0, k)); buf = buf.slice(k + 1); }
      }
    } catch { /* port closed */ }
  })();
  return {
    write: (t) => writer.write(enc.encode(t)),
    onLine: (cb) => ls.on(cb),
    close: async () => { closed = true; try { await reader.cancel(); } catch { /* */ } reader.releaseLock(); writer.releaseLock(); await port.close().catch(() => {}); },
  };
}

export class SerialConnection implements PrinterConnection {
  readonly kind = 'serial' as const;
  private host: MarlinHost | null = null;
  private ev = new Emitter<PrinterStatus>();
  private st: PrinterStatus = { state: 'offline' };
  constructor(private baudRate = 115200) {}

  async connect() {
    if (!hasWebSerial()) throw new Error('USB serial needs the NexSpiro desktop app, or Chrome / Edge.');
    const port = await (navigator as any).serial.requestPort({}) as WebSerialPort;
    const t = await webSerialTransport(port, this.baudRate);
    // opening the port resets most boards; give the firmware time to boot
    await new Promise((r) => setTimeout(r, 2500));
    const h = new MarlinHost(t);
    h.onStatus((s) => { this.st = s; this.ev.emit(s); });
    this.host = h;
    await h.start();
  }
  private get h() { if (!this.host) throw new Error('Not connected'); return this.host; }
  async disconnect() { await this.host?.stop(); this.host = null; }
  status() { return this.host?.status() ?? this.st; }
  onStatus(cb: (s: PrinterStatus) => void) { return this.ev.on(cb); }
  async upload(name: string, data: ArrayBuffer, onProgress?: (f: number) => void) { this.h.store(name, new TextDecoder().decode(data)); onProgress?.(1); }
  async startPrint(name: string) { this.h.print(name); }
  async pause() { this.h.pause(); }
  async resume() { this.h.resume(); }
  async cancel() { await this.h.cancel(); }
  async sendGcode(line: string) { await this.h.command(line); }
  async listFiles() { return this.h.listFiles(); }
  async deleteFile(name: string) { this.h.deleteFile(name); }
}
