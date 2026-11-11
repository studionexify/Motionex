// HTTP-based connections: Klipper/Moonraker and OctoPrint. Uses fetch only, so the same code
// runs in the Electron main process (no CORS limits) and in the browser build.
import { Emitter, type AmsTray, type ConnectionConfig, type PrinterConnection, type PrinterStatus, type PrintOptions, type RemoteFile } from './types';

abstract class HttpPrinter implements PrinterConnection {
  abstract readonly kind: 'moonraker' | 'octoprint';
  protected st: PrinterStatus = { state: 'offline' };
  protected ev = new Emitter<PrinterStatus>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private failures = 0;
  constructor(protected cfg: ConnectionConfig, protected fetchFn: typeof fetch = (...a) => fetch(...a)) {}

  protected abstract defaultPort: number;
  protected get base() {
    const h = (this.cfg.host ?? '').trim().replace(/\/+$/, '');
    if (/^https?:\/\//.test(h)) return h;
    return `http://${h}:${this.cfg.port || this.defaultPort}`;
  }
  protected headers(): Record<string, string> { return this.cfg.apiKey ? { 'X-Api-Key': this.cfg.apiKey } : {}; }
  protected async req(path: string, init: RequestInit = {}, timeoutMs = 8000): Promise<any> {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await this.fetchFn(this.base + path, { ...init, headers: { ...this.headers(), ...(init.headers as Record<string, string> | undefined) }, signal: ctl.signal });
      const text = await r.text();
      if (!r.ok) {
        let msg = text;
        try { const j = JSON.parse(text); msg = j.error?.message ?? j.error ?? j.message ?? text; } catch { /* plain text */ }
        throw new Error(`${r.status} ${String(msg).slice(0, 200)}`);
      }
      try { return text ? JSON.parse(text) : null; } catch { return text; }
    } catch (e: any) {
      if (e?.name === 'AbortError') throw new Error(`No response from ${this.base}`);
      if (e instanceof TypeError) throw new Error(`Can't reach ${this.base}. Check the IP, that the printer is on the same Wi-Fi, and the connection type.`);
      throw e;
    } finally { clearTimeout(t); }
  }
  protected set(s: PrinterStatus) { this.st = s; this.ev.emit(s); }

  protected abstract poll(): Promise<PrinterStatus>;

  async connect() {
    this.set({ state: 'connecting' });
    try {
      this.set(await this.poll());
    } catch (e: any) {
      this.set({ state: 'offline', message: e.message });
      throw e;
    }
    this.timer = setInterval(async () => {
      try { this.set(await this.poll()); this.failures = 0; }
      catch (e: any) { if (++this.failures >= 3) this.set({ ...this.st, state: 'offline', message: e.message }); }
    }, 2000);
  }
  async disconnect() { if (this.timer) clearInterval(this.timer); this.timer = null; this.set({ state: 'offline' }); }
  status() { return this.st; }
  onStatus(cb: (s: PrinterStatus) => void) { return this.ev.on(cb); }
  protected async refresh() { try { this.set(await this.poll()); } catch { /* next poll retries */ } }

  abstract upload(fileName: string, data: ArrayBuffer, onProgress?: (f: number) => void): Promise<void>;
  abstract startPrint(fileName: string, opts?: PrintOptions): Promise<void>;
  abstract pause(): Promise<void>;
  abstract resume(): Promise<void>;
  abstract cancel(): Promise<void>;
  abstract sendGcode(line: string): Promise<void>;
  abstract listFiles(): Promise<RemoteFile[]>;
  abstract deleteFile(name: string): Promise<void>;
  abstract cameraUrl(): Promise<string | null>;
}

const absUrl = (base: string, u: string | undefined | null) => {
  if (!u) return null;
  if (/^https?:\/\//.test(u)) return u;
  const host = new URL(base);
  return `${host.protocol}//${host.hostname}${u.startsWith('/') ? '' : '/'}${u}`;
};

/** Snapmaker U1 print_task_config → one 'AMS' unit with a tray per tool head (type + colour the printer detected). */
export function taskConfigTrays(tc: any, active = -1): PrinterStatus['ams'] {
  if (!tc) return undefined;
  const types: unknown[] = tc.filament_type ?? tc.filament_types ?? [];
  const colors: unknown[] = tc.filament_color_rgba ?? tc.filament_color ?? tc.filament_colors ?? [];
  const exist: unknown[] = tc.filament_exist ?? [];
  const sub: unknown[] = tc.filament_sub_type ?? [];
  // RFID-read spools (official tags) are flagged by the firmware; hand-set heads are not
  const tag: unknown[] = tc.filament_rfid ?? tc.filament_official ?? tc.filament_is_official ?? [];
  if (!Array.isArray(types) || !types.length) return undefined;
  const trays = types.map((t, i) => {
    const present = exist[i] === undefined ? !!t : !!exist[i];
    const c = String(colors[i] ?? '').replace(/^#/, '');
    const st = String(sub[i] ?? '').trim();
    return { id: String(i), type: present ? `${String(t ?? '').trim()}${st && st.toUpperCase() !== 'NONE' && st.toUpperCase() !== 'BASIC' ? ' ' + st : ''}` : '', color: c ? `#${c.slice(0, 6)}` : '#FFFFFF', active: i === active, rfid: present && (tag[i] === true || tag[i] === 1 || tag[i] === 'true') };
  });
  return [{ id: '0', trays }];
}

/** Happy Hare `mmu` object → one unit with a tray per gate (gate_status 0 = empty). */
export function mmuTrays(mmu: any): PrinterStatus['ams'] {
  const mats: unknown[] = mmu?.gate_material;
  if (!Array.isArray(mats) || !mats.length) return undefined;
  const cols: unknown[] = mmu.gate_color ?? [], st: unknown[] = mmu.gate_status ?? [];
  const trays = mats.map((m, i) => {
    const c = String(cols[i] ?? '').replace(/^#/, '');
    const loaded = st[i] === undefined ? !!m : Number(st[i]) !== 0;
    return { id: String(i), type: loaded ? String(m ?? '').trim() : '', color: /^[0-9a-f]{6}/i.test(c) ? `#${c.slice(0, 6)}` : '#FFFFFF', active: Number(mmu.gate) === i };
  });
  return [{ id: '0', trays }];
}

/** A Spoolman spool record → a tray (material + colour the user entered in Spoolman). */
export function spoolmanTray(spool: any): AmsTray | undefined {
  const f = spool?.filament;
  if (!f?.material) return undefined;
  const c = String(f.color_hex ?? f.multi_color_hexes?.split(',')[0] ?? '').replace(/^#/, '');
  return { id: '0', type: String(f.material).trim(), color: /^[0-9a-f]{6}/i.test(c) ? `#${c.slice(0, 6)}` : '#FFFFFF', active: true };
}

export class MoonrakerConnection extends HttpPrinter {
  readonly kind = 'moonraker' as const;
  protected defaultPort = 7125;

  /** Extruder objects Klipper reports (extruder, extruder1…): read once, a tool changer has one per head. */
  private extruders: string[] | null = null;
  /** Snapmaker U1 reports loaded filament (RFID / user-set) in print_task_config. */
  private hasTaskConfig = false;
  /** Happy Hare MMU (ERCF, Tradrack…): reports a material + colour per gate. */
  private hasMmu = false;
  /** Spoolman's active spool (single-tool Klipper printers), re-read every few polls. */
  private spool: { at: number; tray?: AmsTray } = { at: 0 };

  protected async poll(): Promise<PrinterStatus> {
    if (!this.extruders) {
      try {
        const l = await this.req('/printer/objects/list');
        const names = ((l.result?.objects ?? []) as string[]).filter((o) => /^extruder\d*$/.test(o));
        this.extruders = names.sort((a, b) => (Number(a.slice(8)) || 0) - (Number(b.slice(8)) || 0));
        if (!this.extruders.length) this.extruders = ['extruder'];
        this.hasTaskConfig = ((l.result?.objects ?? []) as string[]).includes('print_task_config');
        this.hasMmu = ((l.result?.objects ?? []) as string[]).includes('mmu');
      } catch { /* older Moonraker or not reachable yet: single extruder for now, asked again next poll */ }
    }
    const exts = this.extruders ?? ['extruder'];
    const extra = exts.filter((e) => e !== 'extruder').join('&');
    const r = await this.req(`/printer/objects/query?print_stats&virtual_sdcard&extruder&heater_bed&fan&gcode_move&webhooks&toolhead${extra ? `&${extra}` : ''}${this.hasTaskConfig ? '&print_task_config' : ''}${this.hasMmu ? '&mmu' : ''}`);
    const s = r.result.status;
    const heads = exts.length > 1 ? exts.map((e) => ({ temp: s[e]?.temperature, target: s[e]?.target })) : undefined;
    const activeName = String(s.toolhead?.extruder ?? '');
    const active = heads ? exts.indexOf(activeName) : -1;
    const ps = s.print_stats ?? {};
    const map: Record<string, PrinterStatus['state']> = { standby: 'idle', printing: 'printing', paused: 'paused', complete: 'finished', cancelled: 'idle', error: 'error' };
    const progress = Number(s.virtual_sdcard?.progress ?? 0);
    const dur = Number(ps.print_duration ?? 0);
    const klippy = s.webhooks?.state;
    return {
      state: klippy && klippy !== 'ready' ? 'error' : map[ps.state] ?? 'idle',
      message: klippy && klippy !== 'ready' ? s.webhooks?.state_message : ps.message || undefined,
      progress,
      fileName: ps.filename || undefined,
      layer: ps.info?.current_layer ?? undefined,
      totalLayers: ps.info?.total_layer ?? undefined,
      remainingSeconds: progress > 0.01 && dur > 0 ? Math.max(0, dur / progress - dur) : undefined,
      nozzleTemp: (active >= 0 ? s[activeName] : s.extruder)?.temperature, nozzleTarget: (active >= 0 ? s[activeName] : s.extruder)?.target,
      heads, activeHead: active >= 0 ? active : undefined,
      bedTemp: s.heater_bed?.temperature, bedTarget: s.heater_bed?.target,
      fanPercent: s.fan ? Math.round(Number(s.fan.speed) * 100) : undefined,
      speedPercent: s.gcode_move ? Math.round(Number(s.gcode_move.speed_factor) * 100) : undefined,
      ams: taskConfigTrays(s.print_task_config, active) ?? mmuTrays(s.mmu) ?? (await this.spoolTray()),
    };
  }
  /** The active Spoolman spool as one holder (most Klipper printers have one spool and no AMS). */
  private async spoolTray(): Promise<PrinterStatus['ams']> {
    if (Date.now() - this.spool.at > 15000) {
      this.spool.at = Date.now();
      try {
        const id = (await this.req('/server/spoolman/spool_id')).result?.spool_id;
        if (id == null) this.spool.tray = undefined;
        else {
          const r = await this.req('/server/spoolman/proxy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ request_method: 'GET', path: `/v1/spool/${id}` }) });
          this.spool.tray = spoolmanTray(r.result ?? r);
        }
      } catch { this.spool.tray = undefined; /* no Spoolman on this printer */ }
    }
    return this.spool.tray ? [{ id: '0', trays: [this.spool.tray] }] : undefined;
  }
  async upload(fileName: string, data: ArrayBuffer, onProgress?: (f: number) => void) {
    const fd = new FormData();
    fd.append('root', 'gcodes');
    fd.append('file', new Blob([data]), fileName);
    onProgress?.(0);
    await this.req('/server/files/upload', { method: 'POST', body: fd }, 600000);
    onProgress?.(1);
  }
  async startPrint(fileName: string) { await this.req(`/printer/print/start?filename=${encodeURIComponent(fileName)}`, { method: 'POST' }); await this.refresh(); }
  async pause() { await this.req('/printer/print/pause', { method: 'POST' }); await this.refresh(); }
  async resume() { await this.req('/printer/print/resume', { method: 'POST' }); await this.refresh(); }
  async cancel() { await this.req('/printer/print/cancel', { method: 'POST' }); await this.refresh(); }
  async sendGcode(line: string) { await this.req(`/printer/gcode/script?script=${encodeURIComponent(line)}`, { method: 'POST' }, 120000); }
  async listFiles(): Promise<RemoteFile[]> {
    const r = await this.req('/server/files/list?root=gcodes');
    return (r.result as any[]).map((f) => ({ name: f.path, size: f.size, modified: f.modified ? f.modified * 1000 : undefined })).sort((a, b) => (b.modified ?? 0) - (a.modified ?? 0));
  }
  async deleteFile(name: string) { await this.req(`/server/files/gcodes/${name.split('/').map(encodeURIComponent).join('/')}`, { method: 'DELETE' }); }
  async cameraUrl() {
    try {
      const r = await this.req('/server/webcams/list');
      const cam = (r.result?.webcams ?? []).find((w: any) => w.enabled !== false);
      if (cam) {
        // WebRTC / HLS streams can't play in an <img>; use the JPEG snapshot (polled by the viewer) instead.
        const mjpeg = !cam.service || /mjpeg|uv4l/i.test(cam.service);
        return absUrl(this.base, (mjpeg && cam.stream_url) || cam.snapshot_url || '/webcam/?action=snapshot');
      }
    } catch { /* older Moonraker */ }
    return absUrl(this.base, '/webcam/?action=stream');
  }
}

export class OctoPrintConnection extends HttpPrinter {
  readonly kind = 'octoprint' as const;
  protected defaultPort = 80;

  protected async poll(): Promise<PrinterStatus> {
    const job = await this.req('/api/job');
    let pr: any = null;
    try { pr = await this.req('/api/printer?exclude=sd'); } catch { /* 409 when the printer is not connected */ }
    const text = String(job.state ?? '');
    const state: PrinterStatus['state'] = /^Printing|Starting|Resuming|Finishing/.test(text) ? 'printing'
      : /^Paus/.test(text) ? 'paused' : /^Offline|Closed/.test(text) ? 'offline' : /Error/.test(text) ? 'error' : 'idle';
    const t = pr?.temperature ?? {};
    return {
      state, message: state === 'error' || state === 'offline' ? text : undefined,
      progress: job.progress?.completion != null ? job.progress.completion / 100 : undefined,
      remainingSeconds: job.progress?.printTimeLeft ?? undefined,
      fileName: job.job?.file?.name ?? undefined,
      nozzleTemp: t.tool0?.actual, nozzleTarget: t.tool0?.target,
      bedTemp: t.bed?.actual, bedTarget: t.bed?.target,
      chamberTemp: t.chamber?.actual,
    };
  }
  private json(body: unknown): RequestInit { return { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }; }
  async upload(fileName: string, data: ArrayBuffer, onProgress?: (f: number) => void) {
    const fd = new FormData();
    fd.append('file', new Blob([data]), fileName);
    onProgress?.(0);
    await this.req('/api/files/local', { method: 'POST', body: fd }, 600000);
    onProgress?.(1);
  }
  async startPrint(fileName: string) { await this.req(`/api/files/local/${encodeURIComponent(fileName)}`, this.json({ command: 'select', print: true })); await this.refresh(); }
  async pause() { await this.req('/api/job', this.json({ command: 'pause', action: 'pause' })); await this.refresh(); }
  async resume() { await this.req('/api/job', this.json({ command: 'pause', action: 'resume' })); await this.refresh(); }
  async cancel() { await this.req('/api/job', this.json({ command: 'cancel' })); await this.refresh(); }
  async sendGcode(line: string) { await this.req('/api/printer/command', this.json({ commands: line.split('\n').map((l) => l.trim()).filter(Boolean) })); }
  async listFiles(): Promise<RemoteFile[]> {
    const r = await this.req('/api/files/local');
    return (r.files as any[]).filter((f) => f.type !== 'folder').map((f) => ({ name: f.name, size: f.size, modified: f.date ? f.date * 1000 : undefined })).sort((a, b) => (b.modified ?? 0) - (a.modified ?? 0));
  }
  async deleteFile(name: string) { await this.req(`/api/files/local/${encodeURIComponent(name)}`, { method: 'DELETE' }); }
  async cameraUrl() {
    try {
      const s = await this.req('/api/settings');
      const u = s.webcam?.streamUrl ?? s.webcam?.webcams?.[0]?.streamUrl;
      if (u) return absUrl(this.base, u);
    } catch { /* no permission */ }
    return absUrl(this.base, '/webcam/?action=stream');
  }
}
