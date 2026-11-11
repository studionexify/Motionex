// LAN access-code connection (A1/P1/X1/H2): MQTT (TLS :8883) for status/commands, implicit FTPS (:990) for files,
// and the TLS JPEG stream on :6000 (A1 / P1 series) for the camera. Runs in the Electron main process.
import mqtt, { type MqttClient } from 'mqtt';
import { Client as FtpClient } from 'basic-ftp';
import { Readable, Writable } from 'node:stream';
import tls from 'node:tls';
import { Emitter, type AmsUnit, type ConnectionConfig, type HmsEntry, type PrinterConnection, type PrinterStatus, type PrintOptions, type RemoteFile } from '../../src/connect/types';

export interface LanConfig extends ConnectionConfig { cameraMode?: 'jpeg' | 'rtsp' | 'none'; mqttPort?: number; ftpPort?: number; cameraPort?: number }

const STATE: Record<string, PrinterStatus['state']> = {
  IDLE: 'idle', PREPARE: 'printing', SLICING: 'printing', RUNNING: 'printing', PAUSE: 'paused', FINISH: 'finished', FAILED: 'error',
};
const SPEED: Record<string, number> = { '1': 50, '2': 100, '3': 124, '4': 166 };

const hex = (n: number) => (n >>> 0).toString(16).toUpperCase().padStart(8, '0');
export function hmsCode(attr: number, code: number): string {
  const a = hex(attr), c = hex(code);
  return `${a.slice(0, 4)}_${a.slice(4)}_${c.slice(0, 4)}_${c.slice(4)}`;
}

/** Merge a (partial) MQTT report into the accumulated printer state. P1/A1 send deltas only. */
export function mergeReport(acc: Record<string, any>, msg: Record<string, any>) {
  if (msg.print) {
    const p = msg.print;
    for (const [k, v] of Object.entries(p)) {
      if (k === 'ams' && v && typeof v === 'object' && acc.ams) acc.ams = { ...acc.ams, ...(v as object) };
      else acc[k] = v;
    }
  }
  if (msg.info?.command === 'get_version' && Array.isArray(msg.info.module)) {
    acc._firmware = msg.info.module.find((m: any) => m.name === 'ota')?.sw_ver;
  }
  return acc;
}

export function statusFromReport(p: Record<string, any>): PrinterStatus {
  const ams: AmsUnit[] = (p.ams?.ams ?? []).map((u: any) => ({
    id: String(u.id),
    humidity: u.humidity != null ? Number(u.humidity) : undefined,
    temp: u.temp != null ? Number(u.temp) : undefined,
    trays: (u.tray ?? []).map((t: any) => ({
      id: String(Number(u.id) * 4 + Number(t.id)),
      type: t.tray_type || '',
      color: t.tray_color ? `#${String(t.tray_color).slice(0, 6)}` : '',
      remain: t.remain != null && t.remain >= 0 ? Number(t.remain) : undefined,
      active: String(Number(u.id) * 4 + Number(t.id)) === String(p.ams?.tray_now),
      // a Bambu spool read by the AMS has a non-zero tag / tray UUID; hand-set trays report zeros
      rfid: /[1-9a-f]/i.test(String(t.tray_uuid ?? '')) || /[1-9a-f]/i.test(String(t.tag_uid ?? '')),
    })),
  }));
  const hms: HmsEntry[] = (p.hms ?? []).map((h: any) => {
    const sev = (Number(h.code) >>> 16) & 0xffff;
    return {
      code: hmsCode(Number(h.attr), Number(h.code)),
      message: `HMS ${hmsCode(Number(h.attr), Number(h.code))} — see the printer's HMS documentation`,
      severity: sev <= 2 ? 'error' : sev === 3 ? 'warning' : 'info',
    };
  });
  const light = Array.isArray(p.lights_report) ? p.lights_report.find((l: any) => l.node === 'chamber_light')?.mode === 'on' : undefined;
  let state = STATE[String(p.gcode_state)] ?? 'idle';
  const err = Number(p.print_error ?? 0);
  return {
    state,
    message: err && state === 'error' ? `Print error ${hex(err)}` : undefined,
    progress: p.mc_percent != null ? Number(p.mc_percent) / 100 : undefined,
    remainingSeconds: p.mc_remaining_time != null ? Number(p.mc_remaining_time) * 60 : undefined,
    layer: p.layer_num != null ? Number(p.layer_num) : undefined,
    totalLayers: p.total_layer_num != null ? Number(p.total_layer_num) : undefined,
    fileName: p.subtask_name || p.gcode_file || undefined,
    nozzleTemp: p.nozzle_temper, nozzleTarget: p.nozzle_target_temper,
    bedTemp: p.bed_temper, bedTarget: p.bed_target_temper,
    chamberTemp: p.chamber_temper,
    fanPercent: p.cooling_fan_speed != null ? Math.round((Number(p.cooling_fan_speed) / 15) * 100) : undefined,
    speedPercent: p.spd_lvl != null ? SPEED[String(p.spd_lvl)] : undefined,
    light,
    ams: ams.length ? ams : undefined,
    hms: hms.length ? hms : undefined,
    firmware: p._firmware,
  };
}

/** The 80-byte authentication packet of the :6000 camera stream. */
export function cameraAuthPacket(user: string, code: string): Buffer {
  const b = Buffer.alloc(80);
  b.writeUInt32LE(0x40, 0);
  b.writeUInt32LE(0x3000, 4);
  b.write(user, 16, 32, 'ascii');
  b.write(code, 48, 32, 'ascii');
  return b;
}

/** Splits the camera byte stream (16-byte header with little-endian payload size, then a JPEG). */
export class FrameParser {
  private buf = Buffer.alloc(0);
  constructor(private onFrame: (jpeg: Buffer) => void) {}
  push(chunk: Buffer) {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (this.buf.length >= 16) {
      const size = this.buf.readUInt32LE(0);
      if (size <= 0 || size > 8 * 1024 * 1024) { this.buf = Buffer.alloc(0); return; } // resync
      if (this.buf.length < 16 + size) return;
      const jpg = this.buf.subarray(16, 16 + size);
      this.buf = this.buf.subarray(16 + size);
      if (jpg[0] === 0xff && jpg[1] === 0xd8) this.onFrame(Buffer.from(jpg));
    }
  }
}

export class LanConnection implements PrinterConnection {
  readonly kind = 'bbl_lan' as const;
  private client: MqttClient | null = null;
  private acc: Record<string, any> = {};
  private st: PrinterStatus = { state: 'offline' };
  private ev = new Emitter<PrinterStatus>();
  private frames = new Emitter<Uint8Array>();
  private cam: tls.TLSSocket | null = null;
  private seq = 0;
  private replies = new Set<(msg: any) => void>();

  constructor(private cfg: LanConfig) {}

  private get serial() { return (this.cfg.serial ?? '').trim().toUpperCase(); }
  private set(s: PrinterStatus) { this.st = s; this.ev.emit(s); }

  connect(): Promise<void> {
    if (!this.cfg.host || !this.serial || !this.cfg.accessCode) return Promise.reject(new Error('LAN connection needs the printer IP, serial number and access code.'));
    this.set({ state: 'connecting' });
    return new Promise((resolve, reject) => {
      let settled = false;
      const c = mqtt.connect({
        host: this.cfg.host, port: this.cfg.mqttPort ?? 8883, protocol: 'mqtts',
        username: 'bblp', password: this.cfg.accessCode,
        rejectUnauthorized: false, // printers use a self-signed certificate
        reconnectPeriod: 5000, connectTimeout: 10000, keepalive: 30,
        clientId: `nexspiro_${Math.random().toString(16).slice(2, 10)}`,
      });
      this.client = c;
      c.on('connect', () => {
        c.subscribe(`device/${this.serial}/report`, (err) => {
          if (err) { if (!settled) { settled = true; reject(err); } return; }
          this.publish({ pushing: { command: 'pushall', version: 1, push_target: 1 } });
          this.publish({ info: { command: 'get_version' } });
          if (!settled) { settled = true; resolve(); }
        });
      });
      c.on('message', (_t, payload) => {
        try {
          const msg = JSON.parse(payload.toString());
          for (const r of this.replies) r(msg);
          mergeReport(this.acc, msg);
          this.set(statusFromReport(this.acc));
        } catch { /* ignore malformed */ }
      });
      c.on('error', (e) => {
        const msg = /Not authorized|Bad username/i.test(e.message) ? 'Access code rejected by the printer.' : e.message;
        this.set({ ...this.st, state: 'offline', message: msg });
        if (!settled) { settled = true; c.end(true); reject(new Error(msg)); }
      });
      c.on('offline', () => this.set({ ...this.st, state: 'offline', message: 'Printer unreachable — retrying…' }));
    });
  }

  async disconnect() {
    this.stopCamera();
    await new Promise<void>((r) => (this.client ? this.client.end(true, {}, () => r()) : r()));
    this.client = null;
    this.set({ state: 'offline' });
  }
  status() { return this.st; }
  onStatus(cb: (s: PrinterStatus) => void) { return this.ev.on(cb); }

  /** Publish a command. Every message carries an increasing sequence_id. */
  publish(body: Record<string, Record<string, unknown>>) {
    if (!this.client) throw new Error('Not connected');
    const [k] = Object.keys(body);
    const msg = { [k]: { sequence_id: String(this.seq++), ...body[k] } };
    this.client.publish(`device/${this.serial}/request`, JSON.stringify(msg));
    return msg;
  }

  private async ftp<T>(fn: (c: FtpClient) => Promise<T>): Promise<T> {
    const c = new FtpClient(30000);
    try {
      await c.access({ host: this.cfg.host, port: this.cfg.ftpPort ?? 990, user: 'bblp', password: this.cfg.accessCode, secure: 'implicit', secureOptions: { rejectUnauthorized: false } });
      return await fn(c);
    } finally { c.close(); }
  }

  async upload(fileName: string, data: ArrayBuffer, onProgress?: (f: number) => void) {
    const buf = Buffer.from(data);
    await this.ftp(async (c) => {
      c.trackProgress((info) => onProgress?.(Math.min(1, info.bytes / buf.length)));
      await c.uploadFrom(Readable.from(buf), `/${fileName}`);
      c.trackProgress();
    });
    onProgress?.(1);
  }

  async startPrint(fileName: string, o: PrintOptions = {}) {
    const before = this.acc.print?.gcode_state;
    let sent: Record<string, any>;
    if (/\.3mf$/i.test(fileName)) {
      const useAms = o.useAms !== false && !!(o.amsMapping?.some((t) => t >= 0));
      sent = this.publish({
        print: {
          command: 'project_file',
          param: `Metadata/plate_${o.plate ?? 1}.gcode`,
          url: `file:///sdcard/${fileName}`,
          subtask_name: fileName.replace(/\.gcode\.3mf$|\.3mf$/i, ''),
          project_id: '0', profile_id: '0', task_id: '0', subtask_id: '0',
          md5: '', timelapse: !!o.timelapse, bed_type: 'auto', bed_levelling: o.bedLevelling !== false,
          flow_cali: !!o.flowCalibration, vibration_cali: false, layer_inspect: false,
          use_ams: useAms, ams_mapping: useAms ? o.amsMapping : [],
        },
      });
    } else {
      sent = this.publish({ print: { command: 'gcode_file', param: `/sdcard/${fileName}` } });
    }
    await this.confirmStart(sent.print, before);
  }

  /**
   * The printer answers a print command on its report topic (same command and sequence_id, result "success" or
   * "fail" with a reason) and then moves gcode_state to PREPARE / RUNNING. Without checking, a refused command
   * looked like "Print started" while the printer stayed idle. Recent Bambu firmware refuses print commands from
   * apps other than Bambu's own unless the printer is in LAN Only mode with Developer Mode on.
   */
  private confirmStart(req: { command: string; sequence_id: string }, before: unknown, timeoutMs = 25000): Promise<void> {
    const hint = 'On the printer, turn on LAN Only mode and Developer Mode (Settings → Network / LAN Only), then try again — recent Bambu firmware ignores print commands from other apps otherwise.';
    return new Promise((resolve, reject) => {
      let acked = false;
      const done = (err?: Error) => { clearTimeout(t); this.replies.delete(on); err ? reject(err) : resolve(); };
      const on = (msg: any) => {
        const p = msg?.print;
        if (!p) return;
        if (p.command === req.command && String(p.sequence_id) === req.sequence_id) {
          const failed = p.result && String(p.result).toLowerCase() !== 'success';
          if (failed || p.reason && String(p.reason).toLowerCase() !== 'success') {
            const why = [p.reason, p.err_code ?? p.error_code].filter((x) => x != null && x !== '').join(' · ') || 'refused';
            return done(new Error(`The printer refused the print (${why}). ${hint}`));
          }
          acked = true;
        }
        const st = p.gcode_state;
        if (st && /^(PREPARE|RUNNING|SLICING)$/.test(st) && (acked || st !== before)) done();
        const err = Number(p.print_error ?? 0);
        if (acked && err) done(new Error(`The printer reported print error ${err.toString(16).toUpperCase().padStart(8, '0')}.`));
      };
      const t = setTimeout(() => done(new Error(acked
        ? 'The printer accepted the command but did not start within 25 s. Check its screen for a prompt (filament / plate / AMS mapping).'
        : `The printer did not answer the print command. ${hint}`)), timeoutMs);
      this.replies.add(on);
    });
  }
  async pause() { this.publish({ print: { command: 'pause' } }); }
  async resume() { this.publish({ print: { command: 'resume' } }); }
  async cancel() { this.publish({ print: { command: 'stop' } }); }
  async sendGcode(line: string) { this.publish({ print: { command: 'gcode_line', param: line.endsWith('\n') ? line : line + '\n' } }); }
  async setLight(on: boolean) {
    this.publish({ system: { command: 'ledctrl', led_node: 'chamber_light', led_mode: on ? 'on' : 'off', led_on_time: 500, led_off_time: 500, loop_times: 0, interval_time: 0 } });
  }
  async setSpeed(level: 1 | 2 | 3 | 4) { this.publish({ print: { command: 'print_speed', param: String(level) } }); }

  async listFiles(): Promise<RemoteFile[]> {
    return this.ftp(async (c) => (await c.list('/'))
      .filter((f) => f.isFile && /\.(3mf|gcode)$/i.test(f.name))
      .map((f) => ({ name: f.name, size: f.size, modified: f.modifiedAt?.getTime() }))
      .sort((a, b) => (b.modified ?? 0) - (a.modified ?? 0)));
  }
  async deleteFile(name: string) { await this.ftp((c) => c.remove(`/${name}`)); }

  /** Downloads a file from the printer (used for the thumbnails of the file manager). */
  async download(name: string): Promise<Buffer> {
    const parts: Buffer[] = [];
    await this.ftp((c) => c.downloadTo(new Writable({ write(chunk, _e, cb) { parts.push(chunk); cb(); } }), `/${name}`));
    return Buffer.concat(parts);
  }

  async cameraUrl() {
    if (this.cfg.cameraMode === 'rtsp') return `rtsps://bblp:${this.cfg.accessCode}@${this.cfg.host}:322/streaming/live/1`;
    return null;
  }
  onFrame(cb: (jpeg: Uint8Array) => void) {
    const off = this.frames.on(cb);
    if (this.cfg.cameraMode !== 'rtsp' && !this.cam) this.startCamera();
    return () => { off(); };
  }
  private startCamera() {
    const parser = new FrameParser((j) => this.frames.emit(j));
    const sock = tls.connect({ host: this.cfg.host, port: this.cfg.cameraPort ?? 6000, rejectUnauthorized: false }, () => {
      sock.write(cameraAuthPacket('bblp', this.cfg.accessCode ?? ''));
    });
    sock.on('data', (d: Buffer) => parser.push(d));
    sock.on('error', () => { /* camera is optional */ });
    sock.on('close', () => { if (this.cam === sock) this.cam = null; });
    this.cam = sock;
  }
  stopCamera() { this.cam?.destroy(); this.cam = null; }
}
