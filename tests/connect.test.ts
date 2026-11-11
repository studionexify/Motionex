// Printer connections against local mock servers (Moonraker, OctoPrint, LAN MQTT broker over TLS).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import tls from 'node:tls';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { MoonrakerConnection, OctoPrintConnection } from '../src/connect/http';
import { checksum, MarlinHost, type LineTransport } from '../src/connect/serial';
import { LanConnection, cameraAuthPacket, FrameParser, hmsCode, mergeReport, statusFromReport } from '../electron/src/lan';

type Handler = (req: http.IncomingMessage, body: Buffer) => { status?: number; json?: unknown };
function mockServer(handler: Handler): Promise<{ port: number; close: () => void; log: { method: string; url: string; body: Buffer; headers: http.IncomingHttpHeaders }[] }> {
  const log: { method: string; url: string; body: Buffer; headers: http.IncomingHttpHeaders }[] = [];
  const srv = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      log.push({ method: req.method!, url: req.url!, body, headers: req.headers });
      const r = handler(req, body);
      res.writeHead(r.status ?? 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r.json ?? {}));
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ port: (srv.address() as AddressInfo).port, close: () => srv.close(), log })));
}

describe('Moonraker', () => {
  let srv: Awaited<ReturnType<typeof mockServer>>;
  let state = 'printing';
  beforeAll(async () => {
    srv = await mockServer((req) => {
      const u = req.url!;
      if (u.startsWith('/printer/objects/query')) return { json: { result: { status: {
        webhooks: { state: 'ready' },
        print_stats: { state, filename: 'cube.gcode', print_duration: 600, info: { current_layer: 12, total_layer: 50 } },
        virtual_sdcard: { progress: 0.25 },
        extruder: { temperature: 219.8, target: 220 }, heater_bed: { temperature: 60.1, target: 60 },
        fan: { speed: 0.5 }, gcode_move: { speed_factor: 1 },
      } } } };
      if (u === '/server/files/list?root=gcodes') return { json: { result: [{ path: 'a.gcode', size: 10, modified: 1700000000 }, { path: 'b.gcode', size: 20, modified: 1700000100 }] } };
      if (u.startsWith('/server/webcams/list')) return { json: { result: { webcams: [{ enabled: true, stream_url: '/webcam/?action=stream' }] } } };
      if (u.startsWith('/printer/print/pause')) { state = 'paused'; return { json: { result: 'ok' } }; }
      if (u.startsWith('/printer/gcode/script')) return { json: { result: 'ok' } };
      if (u.startsWith('/printer/print/start') || u.startsWith('/server/files/upload')) return { json: { result: 'ok' } };
      return { status: 404, json: { error: { message: 'not found' } } };
    });
  });
  afterAll(() => srv.close());

  it('reads status, uploads, prints and lists files', async () => {
    const c = new MoonrakerConnection({ kind: 'moonraker', host: '127.0.0.1', port: srv.port });
    await c.connect();
    const s = c.status();
    expect(s).toMatchObject({ state: 'printing', progress: 0.25, layer: 12, totalLayers: 50, nozzleTemp: 219.8, bedTarget: 60, fanPercent: 50 });
    expect(s.remainingSeconds).toBeCloseTo(1800, 0);
    await c.upload('plate 1.gcode', new TextEncoder().encode('G28\n').buffer);
    const up = srv.log.find((l) => l.url === '/server/files/upload')!;
    expect(up.headers['content-type']).toMatch(/multipart\/form-data/);
    expect(up.body.toString()).toContain('filename="plate 1.gcode"');
    expect(up.body.toString()).toContain('G28');
    await c.startPrint('plate 1.gcode');
    expect(srv.log.some((l) => l.url === '/printer/print/start?filename=plate%201.gcode' && l.method === 'POST')).toBe(true);
    await c.sendGcode('G28 X');
    expect(srv.log.some((l) => l.url === '/printer/gcode/script?script=G28%20X')).toBe(true);
    await c.pause();
    expect(c.status().state).toBe('paused');
    expect((await c.listFiles()).map((f) => f.name)).toEqual(['b.gcode', 'a.gcode']);
    expect(await c.cameraUrl()).toBe('http://127.0.0.1/webcam/?action=stream');
    await c.disconnect();
  });

  it('reads every head of a tool changer (extruder, extruder1…) and the head in use', async () => {
    const tc = await mockServer((req) => {
      const u = req.url!;
      if (u === '/printer/objects/list') return { json: { result: { objects: ['extruder2', 'extruder', 'heater_bed', 'extruder1', 'extruder3', 'extruder_stepper x'] } } };
      if (u.startsWith('/printer/objects/query')) {
        expect(u).toContain('&extruder1&extruder2&extruder3');
        return { json: { result: { status: {
          webhooks: { state: 'ready' }, print_stats: { state: 'printing' }, virtual_sdcard: { progress: 0.5 },
          toolhead: { extruder: 'extruder2' },
          extruder: { temperature: 175, target: 175 }, extruder1: { temperature: 20, target: 0 },
          extruder2: { temperature: 220, target: 220 }, extruder3: { temperature: 200, target: 215 },
          heater_bed: { temperature: 60, target: 60 },
        } } } };
      }
      return { status: 404, json: {} };
    });
    const c = new MoonrakerConnection({ kind: 'moonraker', host: '127.0.0.1', port: tc.port });
    await c.connect();
    const s = c.status();
    expect(s.heads?.map((h) => h.temp)).toEqual([175, 20, 220, 200]);
    expect(s.activeHead).toBe(2);
    expect(s.nozzleTemp).toBe(220); // the head in use
    await c.disconnect();
    tc.close();
  });

  it('reports a clear error when the printer is unreachable', async () => {
    const c = new MoonrakerConnection({ kind: 'moonraker', host: '127.0.0.1', port: 1 });
    await expect(c.connect()).rejects.toThrow();
    expect(c.status().state).toBe('offline');
  });
});

describe('OctoPrint', () => {
  let srv: Awaited<ReturnType<typeof mockServer>>;
  beforeAll(async () => {
    srv = await mockServer((req) => {
      if (req.headers['x-api-key'] !== 'KEY') return { status: 403, json: { error: 'Forbidden' } };
      const u = req.url!;
      if (u === '/api/job' && req.method === 'GET') return { json: { state: 'Printing', job: { file: { name: 'x.gcode' } }, progress: { completion: 42, printTimeLeft: 300 } } };
      if (u.startsWith('/api/printer?')) return { json: { temperature: { tool0: { actual: 200, target: 210 }, bed: { actual: 55, target: 60 } } } };
      if (u === '/api/files/local' && req.method === 'GET') return { json: { files: [{ name: 'x.gcode', size: 5, date: 1, type: 'machinecode' }] } };
      return { json: {} };
    });
  });
  afterAll(() => srv.close());
  it('uses the API key and maps job state', async () => {
    const c = new OctoPrintConnection({ kind: 'octoprint', host: '127.0.0.1', port: srv.port, apiKey: 'KEY' });
    await c.connect();
    expect(c.status()).toMatchObject({ state: 'printing', progress: 0.42, remainingSeconds: 300, nozzleTarget: 210, fileName: 'x.gcode' });
    await c.startPrint('x.gcode');
    const sel = srv.log.find((l) => l.url === '/api/files/local/x.gcode')!;
    expect(JSON.parse(sel.body.toString())).toEqual({ command: 'select', print: true });
    await c.resume();
    expect(srv.log.some((l) => l.url === '/api/job' && l.body.toString().includes('"resume"'))).toBe(true);
    await c.sendGcode('M104 S200\nM140 S60');
    const cmd = srv.log.find((l) => l.url === '/api/printer/command')!;
    expect(JSON.parse(cmd.body.toString()).commands).toEqual(['M104 S200', 'M140 S60']);
    await c.disconnect();
  });
  it('rejects a wrong API key', async () => {
    const c = new OctoPrintConnection({ kind: 'octoprint', host: '127.0.0.1', port: srv.port, apiKey: 'nope' });
    await expect(c.connect()).rejects.toThrow(/403/);
  });
});

describe('LAN access-code protocol', () => {
  it('merges partial reports and maps status, AMS and HMS', () => {
    const acc: Record<string, any> = {};
    mergeReport(acc, { print: { gcode_state: 'RUNNING', mc_percent: 37, mc_remaining_time: 42, layer_num: 10, total_layer_num: 120, nozzle_temper: 219.5, spd_lvl: 2,
      ams: { tray_now: '1', ams: [{ id: '0', humidity: '4', tray: [{ id: '0', tray_type: 'PLA', tray_color: 'FF5C8DFF', remain: 80 }, { id: '1', tray_type: 'PETG', tray_color: '00AE42FF' }] }] },
      hms: [{ attr: 0x03000100, code: 0x00010001 }] } });
    mergeReport(acc, { print: { mc_percent: 38 } }); // P1/A1 deltas
    const s = statusFromReport(acc);
    expect(s).toMatchObject({ state: 'printing', progress: 0.38, remainingSeconds: 2520, layer: 10, totalLayers: 120, speedPercent: 100 });
    expect(s.ams![0].trays[0]).toMatchObject({ type: 'PLA', color: '#FF5C8D', remain: 80, active: false });
    expect(s.ams![0].trays[1].active).toBe(true);
    expect(s.hms![0]).toMatchObject({ code: '0300_0100_0001_0001', severity: 'error' });
    expect(hmsCode(0x0c00_0100, 0x0003_0004)).toBe('0C00_0100_0003_0004');
  });

  it('builds the camera auth packet and splits JPEG frames', () => {
    const p = cameraAuthPacket('bblp', '12345678');
    expect(p.length).toBe(80);
    expect(p.readUInt32LE(0)).toBe(0x40);
    expect(p.readUInt32LE(4)).toBe(0x3000);
    expect(p.subarray(16, 20).toString()).toBe('bblp');
    expect(p.subarray(48, 56).toString()).toBe('12345678');
    const frames: Buffer[] = [];
    const fp = new FrameParser((f) => frames.push(f));
    const jpg = (n: number) => Buffer.from([0xff, 0xd8, ...new Array(n).fill(7), 0xff, 0xd9]);
    const pack = (j: Buffer) => { const h = Buffer.alloc(16); h.writeUInt32LE(j.length, 0); return Buffer.concat([h, j]); };
    const stream = Buffer.concat([pack(jpg(10)), pack(jpg(3000))]);
    fp.push(stream.subarray(0, 7)); fp.push(stream.subarray(7, 2000)); fp.push(stream.subarray(2000));
    expect(frames.map((f) => f.length)).toEqual([14, 3004]);
  });
});

describe('LAN access-code connection over a real MQTT/TLS broker', () => {
  let broker: any, server: tls.Server, port = 0;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nx-mqtt-'));
  const received: any[] = [];
  beforeAll(async () => {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'), '-days', '1', '-subj', '/CN=nexspiro-test'], { stdio: 'ignore' });
    const mod = (await import('aedes')) as any;
    broker = mod.Aedes ? await mod.Aedes.createBroker() : mod.default();
    broker.authenticate = (_c: unknown, user: string, pass: Buffer, cb: (e: Error | null, ok: boolean) => void) => cb(null, user === 'bblp' && pass?.toString() === 'CODE1234');
    broker.on('publish', (pkt: any, client: any) => {
      if (!client || pkt.topic !== 'device/01P00A000000001/request') return;
      const msg = JSON.parse(pkt.payload.toString());
      received.push(msg);
      if (msg.pushing?.command === 'pushall') {
        broker.publish({ topic: 'device/01P00A000000001/report', payload: Buffer.from(JSON.stringify({ print: { gcode_state: 'IDLE', nozzle_temper: 25, bed_temper: 24, lights_report: [{ node: 'chamber_light', mode: 'on' }] } })), qos: 0, retain: false, cmd: 'publish', dup: false }, () => {});
      }
      if (msg.print?.command === 'project_file') {
        // like the firmware: answer the command, then move to PREPARE — or refuse it
        const refuse = msg.print.subtask_name === 'refused';
        const reply = refuse ? { command: 'project_file', sequence_id: msg.print.sequence_id, result: 'fail', reason: 'mqtt message verify failed', err_code: 84033543 }
          : { command: 'project_file', sequence_id: msg.print.sequence_id, result: 'success', gcode_state: 'PREPARE' };
        broker.publish({ topic: 'device/01P00A000000001/report', payload: Buffer.from(JSON.stringify({ print: reply })), qos: 0, retain: false, cmd: 'publish', dup: false }, () => {});
      }
    });
    server = tls.createServer({ key: fs.readFileSync(path.join(dir, 'k.pem')), cert: fs.readFileSync(path.join(dir, 'c.pem')) }, broker.handle);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => { server.close(); broker.close(); });

  it('connects with the access code, receives status and sends commands', async () => {
    const c = new LanConnection({ kind: 'bbl_lan', host: '127.0.0.1', serial: '01p00a000000001', accessCode: 'CODE1234', mqttPort: port });
    const got = new Promise<void>((r) => c.onStatus((s) => { if (s.state === 'idle') r(); }));
    await c.connect();
    await got;
    expect(c.status()).toMatchObject({ state: 'idle', nozzleTemp: 25, light: true });
    await c.startPrint('cube.gcode.3mf', { plate: 2, amsMapping: [0, 2] });
    await c.pause();
    await c.sendGcode('G28');
    await new Promise((r) => setTimeout(r, 200));
    const pf = received.find((m) => m.print?.command === 'project_file');
    expect(pf.print).toMatchObject({ param: 'Metadata/plate_2.gcode', url: 'file:///sdcard/cube.gcode.3mf', subtask_name: 'cube', use_ams: true, ams_mapping: [0, 2] });
    expect(received.some((m) => m.print?.command === 'pause')).toBe(true);
    expect(received.find((m) => m.print?.command === 'gcode_line').print.param).toBe('G28\n');
    // sequence ids increase
    const seqs = received.map((m) => Number(Object.values(m as Record<string, any>)[0].sequence_id));
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    await c.disconnect();
  });
  it('a print the printer refuses is reported, not shown as started', async () => {
    const c = new LanConnection({ kind: 'bbl_lan', host: '127.0.0.1', serial: '01P00A000000001', accessCode: 'CODE1234', mqttPort: port });
    await c.connect();
    await expect(c.startPrint('refused.gcode.3mf', { plate: 1 })).rejects.toThrow(/refused the print \(mqtt message verify failed · 84033543\).*Developer Mode/);
    await c.disconnect();
  });

  it('rejects a wrong access code', async () => {
    const c = new LanConnection({ kind: 'bbl_lan', host: '127.0.0.1', serial: '01P00A000000001', accessCode: 'WRONG', mqttPort: port });
    await expect(c.connect()).rejects.toThrow(/Access code rejected|Not authorized/i);
  });
});

describe('LAN access-code file transfer (implicit FTPS)', () => {
  let ftpd: any, port = 0;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nx-ftp-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nx-ftp-root-'));
  beforeAll(async () => {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'), '-days', '1', '-subj', '/CN=nexspiro-test'], { stdio: 'ignore' });
    const FtpSrv = (await import('ftp-srv')).default as any;
    port = 20000 + Math.floor(Math.random() * 20000);
    ftpd = new FtpSrv({
      url: `ftps://127.0.0.1:${port}`, pasv_url: '127.0.0.1', pasv_min: port + 1, pasv_max: port + 50,
      tls: { key: fs.readFileSync(path.join(dir, 'k.pem')), cert: fs.readFileSync(path.join(dir, 'c.pem')) }, anonymous: false, log: { info() {}, debug() {}, trace() {}, warn() {}, error() {}, child() { return this; } },
    });
    ftpd.on('login', ({ username, password }: any, resolve: any, reject: any) => (username === 'bblp' && password === 'CODE1234' ? resolve({ root }) : reject(new Error('bad login'))));
    await ftpd.listen();
  });
  afterAll(() => ftpd?.close());

  it('uploads, lists, downloads and deletes files', async () => {
    const c = new LanConnection({ kind: 'bbl_lan', host: '127.0.0.1', serial: 'X', accessCode: 'CODE1234', ftpPort: port });
    const data = new TextEncoder().encode('PK fake 3mf '.repeat(1000));
    const prog: number[] = [];
    await c.upload('cube.gcode.3mf', data.buffer, (f) => prog.push(f));
    expect(fs.readFileSync(path.join(root, 'cube.gcode.3mf')).length).toBe(data.length);
    expect(prog.at(-1)).toBe(1);
    expect((await c.listFiles()).map((f) => f.name)).toEqual(['cube.gcode.3mf']);
    expect((await c.download('cube.gcode.3mf')).length).toBe(data.length);
    await c.deleteFile('cube.gcode.3mf');
    expect(fs.existsSync(path.join(root, 'cube.gcode.3mf'))).toBe(false);
  }, 30000);
});



/** A fake Marlin board: verifies checksums and line numbers, asks for one resend, reports temps. */
function fakeMarlin() {
  const ls = new Set<(l: string) => void>();
  const say = (l: string) => setTimeout(() => ls.forEach((f) => f(l)), 0);
  let expected = 0, corruptOnce = true;
  const executed: string[] = [];
  const t: LineTransport = {
    async write(text) {
      const line = text.trim();
      const m = /^N(\d+) (.*)\*(\d+)$/.exec(line);
      if (!m) { executed.push(line); say('ok'); return; }
      const [, n, cmd, cs] = m;
      if (checksum(`N${n} ${cmd}`) !== Number(cs)) { say(`Error:checksum mismatch, Last Line: ${expected - 1}`); say(`Resend: ${expected}`); say('ok'); return; }
      if (cmd === 'M110 N0') { expected = 1; say('ok'); return; }
      if (Number(n) !== expected) { say(`Error:Line Number is not Last Line Number+1, Last Line: ${expected - 1}`); say(`Resend: ${expected}`); say('ok'); return; }
      if (corruptOnce && expected === 5) { corruptOnce = false; say(`Resend: ${expected}`); say('ok'); return; } // simulated line noise
      expected++;
      executed.push(cmd);
      if (cmd === 'M105') say('ok T:205.3 /210.0 B:59.8 /60.0'); else say('ok');
    },
    onLine(cb) { ls.add(cb); return () => ls.delete(cb); },
    async close() {},
  };
  return { t, executed };
}

describe('USB serial host (Marlin)', () => {
  it('streams a file with line numbers and checksums, recovering from a resend request', async () => {
    const { t, executed } = fakeMarlin();
    const h = new MarlinHost(t, 2000);
    await h.start();
    h.store('job.gcode', '; comment\nG28 ; home\n\nG1 X10 Y10\nG1 X20\nG1 X30\nG1 X40\nM105\nM84\n');
    const done = new Promise<void>((r) => h.onStatus((s) => { if (s.state === 'finished') r(); }));
    h.print('job.gcode');
    await done;
    const printed = executed.filter((c) => !c.startsWith('M155'));
    expect(printed).toEqual(['G28', 'G1 X10 Y10', 'G1 X20', 'G1 X30', 'G1 X40', 'M105', 'M84']);
    expect(h.status()).toMatchObject({ state: 'finished', progress: 1, nozzleTemp: 205.3, bedTarget: 60 });
    await h.stop();
  });
  it('pauses, resumes and runs manual commands between print lines', async () => {
    const { t, executed } = fakeMarlin();
    const h = new MarlinHost(t, 2000);
    await h.start();
    h.store('a.gcode', Array.from({ length: 200 }, (_, i) => `G1 X${i}`).join('\n'));
    h.print('a.gcode');
    await new Promise((r) => setTimeout(r, 20));
    h.pause();
    await new Promise((r) => setTimeout(r, 30));
    const atPause = executed.length;
    await new Promise((r) => setTimeout(r, 30));
    expect(executed.length).toBeLessThanOrEqual(atPause + 1);
    await h.command('M117 hello');
    expect(executed).toContain('M117 hello');
    const done = new Promise<void>((r) => h.onStatus((s) => { if (s.state === 'finished') r(); }));
    h.resume();
    await done;
    expect(executed.filter((c) => c.startsWith('G1 X')).length).toBe(200);
    await h.stop();
  });
});
