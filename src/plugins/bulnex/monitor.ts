// Bulnex monitor: watches a running Bulnex job through the printer's status and camera (LAN,
// desktop app) and sends a phone notification when something looks wrong. It only alerts — the user
// decides whether to stop the printer.
//
// Phases are read from the bed target temperature, which the Bulnex G-code sets on purpose:
//   print temperature → printing;  release temperature → cooling / pushing;  back up → the push is done.
import { handleOf, useDevices } from '../../state/devices';
import type { PrinterStatus } from '../../connect/types';
import { BulnexVision, DEFAULT_VISION, GRID_H, GRID_W, toGray, type Gray, type VisionOptions } from './vision';

export interface NotifySettings {
  /** ntfy server (https://ntfy.sh or self-hosted). */
  ntfyServer: string;
  /** ntfy topic the phone app subscribes to. Empty = phone notifications off. */
  ntfyTopic: string;
  /** Attach the camera frame to alerts. */
  attachImage: boolean;
  desktop: boolean;
}
export const DEFAULT_NOTIFY: NotifySettings = { ntfyServer: 'https://ntfy.sh', ntfyTopic: '', attachImage: true, desktop: true };

export interface MonitorSettings extends NotifySettings {
  deviceId: string;
  releaseBedTemp: number;
  cycles: number;
  /** Cycles the print model learns from before it judges (the first print should be watched once). */
  referenceCycles: number;
  vision: VisionOptions;
}

export type Phase = 'idle' | 'starting' | 'printing' | 'cooling' | 'checking-bed';
export interface LogEntry { t: number; kind: 'info' | 'alert'; text: string }
export interface MonitorState {
  running: boolean;
  phase: Phase;
  cycle: number;
  /** Last frame's anomaly heat map (GRID_W × GRID_H z-scores) and its cluster. */
  heat: Float32Array | null;
  cluster: number[];
  frame: string | null;
  log: LogEntry[];
  emptyTrained: number;
}

let state: MonitorState = { running: false, phase: 'idle', cycle: 0, heat: null, cluster: [], frame: null, log: [], emptyTrained: 0 };
const listeners = new Set<() => void>();
const emit = (patch: Partial<MonitorState>) => { state = { ...state, ...patch }; listeners.forEach((l) => l()); };
export const monitorSubscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export const monitorState = () => state;

let vision: BulnexVision | null = null;
let stopFns: (() => void)[] = [];
let settings: MonitorSettings | null = null;
let lastJpeg: Blob | null = null;
let lastGray: Gray | null = null;
let lastPrintFrame = 0;
let pushDoneAt = 0;
const lastAlert = new Map<string, number>();

const log = (kind: LogEntry['kind'], text: string) => emit({ log: [{ t: Date.now(), kind, text }, ...state.log].slice(0, 100) });

/** Phone (ntfy) + desktop notification. Same kind of alert at most every 10 minutes. */
export async function notify(s: NotifySettings, title: string, message: string, kind = title, image?: Blob | null): Promise<void> {
  const now = Date.now();
  if (now - (lastAlert.get(kind) ?? 0) < 10 * 60_000) return;
  lastAlert.set(kind, now);
  if (s.desktop && typeof Notification !== 'undefined') {
    try {
      if (Notification.permission === 'default') await Notification.requestPermission();
      if (Notification.permission === 'granted') new Notification(title, { body: message });
    } catch { /* notifications unavailable */ }
  }
  if (!s.ntfyTopic.trim()) return;
  const url = `${s.ntfyServer.replace(/\/+$/, '')}/${encodeURIComponent(s.ntfyTopic.trim())}`;
  // header values must be plain ASCII
  const ascii = (t: string) => t.replace(/[^\x20-\x7E]/g, '');
  try {
    if (image && s.attachImage) await fetch(url, { method: 'PUT', body: image, headers: { Title: ascii(title), Message: ascii(message), Filename: 'bulnex.jpg', Priority: 'high', Tags: 'warning' } });
    else await fetch(url, { method: 'POST', body: message, headers: { Title: ascii(title), Priority: kind === 'done' ? 'default' : 'high', Tags: kind === 'done' ? 'white_check_mark' : 'warning' } });
  } catch (e: any) { log('info', `Phone notification failed: ${e?.message ?? e}`); }
}

async function decode(url: string): Promise<{ jpeg: Blob; gray: Gray } | null> {
  try {
    const jpeg = await (await fetch(url)).blob();
    const bmp = await createImageBitmap(jpeg);
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = c.getContext('2d')!;
    ctx.drawImage(bmp, 0, 0);
    const px = ctx.getImageData(0, 0, bmp.width, bmp.height);
    bmp.close();
    return { jpeg, gray: toGray(px.data, px.width, px.height) };
  } catch { return null; }
}

function phaseOf(st: PrinterStatus, s: MonitorSettings): Phase {
  if (st.state !== 'printing' && st.state !== 'paused') return 'idle';
  if (st.bedTarget != null && Math.abs(st.bedTarget - s.releaseBedTemp) < 1.5) return 'cooling';
  if (!st.layer) return 'starting';
  return 'printing';
}

function alert(kind: string, title: string, text: string) {
  log('alert', text);
  if (settings) void notify(settings, title, text, kind, lastJpeg);
}

function onStatus(st: PrinterStatus) {
  if (!settings) return;
  const s = settings;
  const phase = phaseOf(st, s);
  const prev = state.phase;
  if (prev === 'cooling' && phase !== 'cooling' && phase !== 'idle') {
    // bed target went back up: the row was pushed. Look at the plate a few seconds later.
    pushDoneAt = Date.now();
    emit({ phase: 'checking-bed', cycle: state.cycle + 1 });
    log('info', `Push done — checking the plate (cycle ${state.cycle} → ${state.cycle + 1}).`);
    return;
  }
  if (state.phase === 'checking-bed' && Date.now() - pushDoneAt < 15_000) return;
  if (phase !== prev) {
    if (phase === 'cooling') log('info', `Cycle ${state.cycle} printed — cooling the bed to ${s.releaseBedTemp} °C.`);
    if (phase === 'starting' && prev === 'idle') { emit({ cycle: 1 }); log('info', 'Job started — learning the empty plate.'); }
    if (prev !== 'idle' && phase === 'idle') {
      if (st.state === 'finished') { log('info', 'All cycles finished.'); if (settings) void notify(settings, 'Bulnex: job finished', `${state.cycle} of ${s.cycles} cycles done.`, 'done'); }
      else if (st.state === 'error') alert('error', 'Bulnex: printer error', st.message ?? 'The printer reported an error.');
    }
    emit({ phase });
  }
  for (const h of st.hms ?? []) if (h.severity === 'error') alert(`hms:${h.code}`, 'Bulnex: printer error', h.message);
}

async function onFrame(url: string) {
  if (!settings || !vision) return;
  const st = useDevices.getState().status[settings.deviceId];
  const d = await decode(url);
  if (!d) return;
  lastJpeg = d.jpeg; lastGray = d.gray;
  emit({ frame: url });
  const phase = state.phase;
  if (phase === 'starting') {
    // the plate is empty before the first layer: these frames teach the empty-bed model
    vision.learnEmpty(d.gray);
    emit({ emptyTrained: vision.empty.n });
    return;
  }
  if (phase === 'checking-bed') {
    if (Date.now() - pushDoneAt < 4000) return; // let the head settle
    const v = vision.checkEmpty(d.gray);
    emit({ heat: v.z, cluster: v.cluster, emptyTrained: vision.empty.n, phase: 'printing' });
    if (!v.trained) log('info', 'Plate check: still learning the empty plate.');
    else if (v.anomaly) alert('bed', 'Bulnex: plate not clear', `After cycle ${state.cycle - 1} the plate does not look empty (${v.score} areas differ). The next print may land on a part.`);
    else log('info', 'Plate is clear.');
    return;
  }
  if (phase === 'printing' && st?.layer && st.totalLayers) {
    const now = Date.now();
    if (now - lastPrintFrame < 4000) return;
    lastPrintFrame = now;
    const learn = state.cycle <= settings.referenceCycles;
    const v = vision.checkPrint(d.gray, st.layer / st.totalLayers, learn);
    if (!learn) emit({ heat: v.z, cluster: v.cluster });
    if (v.alert) alert('print', 'Bulnex: print problem', `Cycle ${state.cycle}, layer ${st.layer}/${st.totalLayers}: the print does not look like the reference cycle (spaghetti, a detached part or a blob).`);
  }
}

export async function startMonitor(s: MonitorSettings): Promise<void> {
  stopMonitor();
  settings = s;
  vision = new BulnexVision(s.vision ?? DEFAULT_VISION);
  lastAlert.clear();
  emit({ running: true, phase: 'idle', cycle: 0, heat: null, cluster: [], log: [], emptyTrained: 0 });
  const st = useDevices.getState().status[s.deviceId];
  if (st) onStatus(st);
  stopFns.push(useDevices.subscribe((d, p) => { const x = d.status[s.deviceId]; if (x && x !== p.status[s.deviceId]) onStatus(x); }));
  const stop = await handleOf(s.deviceId).camera((u) => { void onFrame(u); });
  if (!stop) { log('alert', 'This printer has no camera stream here — status alerts only (needs the desktop app and an A1 or P1).'); return; }
  stopFns.push(stop);
  log('info', 'Monitoring started.');
}

export function stopMonitor(): void {
  stopFns.forEach((f) => f());
  stopFns = [];
  if (state.running) emit({ running: false, phase: 'idle' });
  settings = null;
}

/** "Learn empty bed": the user confirms the plate is empty now. */
export function learnEmptyNow(): boolean {
  if (!vision || !lastGray) return false;
  vision.learnEmpty(lastGray);
  emit({ emptyTrained: vision.empty.n });
  return true;
}

export { GRID_W, GRID_H };
