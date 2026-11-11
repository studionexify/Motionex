// Builds the file sent to a printer for the sliced plate: .gcode.3mf for A1/P1/X1/H2 printers,
// G-code with embedded thumbnails for everything else. Also used by "Export plate".
import { buildGcode3mf, gcodeThumbnailBlock } from '../io/gcode3mf';
import { remapTools } from '../engine/toolmap';
import { changerOf, toolMapOf } from '../profiles/changer';
import { filamentById } from '../profiles/filaments';
import { printerById } from '../profiles/printers';
import { saveFile } from '../platform';
import { renderThumbnail } from '../viewport/thumbnail';
import { currentConfig, plateObjects, sliceNow } from './slicing';
import { useStore } from './store';

export interface PrintJob { name: string; data: ArrayBuffer; kind: '3mf' | 'gcode'; usedSlots: number[] }

const safeName = (s: string) => s.replace(/[^\w.-]+/g, '_').replace(/_+/g, '_').slice(0, 60) || 'plate';

export async function ensureSliced() {
  const s = useStore.getState();
  if (s.slice.result && !s.slice.dirty && s.slice.plate === s.activePlate) return s.slice.result;
  return sliceNow();
}

/** filename_format: expand the placeholders of the export name. */
export function formatFilename(fmt: string, v: { base: string; plate: string; cfg: Record<string, unknown>; seconds: number; grams: number }, ext: string): string {
  const hms = (t: number) => { const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60); return h ? `${h}h${m}m` : `${m}m${Math.round(t % 60)}s`; };
  const vals: Record<string, string> = {
    input_filename_base: v.base, plate_name: v.plate, print_time: hms(v.seconds), total_weight: v.grams.toFixed(2),
    layer_height: String(v.cfg.layer_height ?? ''), filament_type: String(v.cfg.filament_type ?? ''), printer_model: String(v.cfg.printer_model ?? ''),
  };
  let name = (fmt || '[input_filename_base]').replace(/\[([a-z_]+)\]/g, (m, k) => vals[k] ?? (v.cfg[k] !== undefined ? String(v.cfg[k]) : m));
  name = safeName(name.replace(/\.(gcode|3mf)$/i, '').replace(/\.gcode$/i, ''));
  return `${name}.${ext}`;
}

/** Run the post-processing scripts (desktop only); returns the G-code unchanged elsewhere. */
async function postProcess(gcode: string, cfg: Record<string, unknown>, outputName: string): Promise<string> {
  const scripts = String(cfg.post_process ?? '').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  if (!scripts.length) return gcode;
  const pp = window.nexspiro?.postProcess;
  if (!pp) { useStore.getState().set({ toast: { kind: 'warn', text: 'Post-processing scripts run only in the desktop app; the G-code was exported without them.' } }); return gcode; }
  const env: Record<string, string> = {};
  for (const [k, val] of Object.entries(cfg)) if (typeof val !== 'object') env[`SLIC3R_${k.toUpperCase()}`] = String(val);
  try { return (await pp({ gcode, scripts, env, outputName })).gcode; }
  catch (e: any) { useStore.getState().set({ toast: { kind: 'error', text: `Post-processing failed: ${e?.message ?? e}` } }); throw e; }
}

/** Options for a print job: `toolMap` sends filament slot n to physical head toolMap[n] (tool changers). */
export interface PrintJobOptions { toolMap?: number[] }

export async function buildPrintJob(format?: '3mf' | 'gcode', jo: PrintJobOptions = {}): Promise<PrintJob | null> {
  const r = await ensureSliced();
  if (!r) return null;
  const s = useStore.getState();
  const p = printerById(s.printerId);
  const objs = plateObjects(s.slice.plate);
  const base = `${safeName(objs[0]?.name ?? 'plate')}${objs.length > 1 ? `_+${objs.length - 1}` : ''}`;
  const kind = format ?? (p.flavor === 'bbl' ? '3mf' : 'gcode');
  const cfgOut = currentConfig(s.slice.plate);
  const fname = (ext: string) => formatFilename(String(cfgOut.filename_format ?? ''), { base, plate: s.plates[s.slice.plate]?.name ?? 'plate', cfg: cfgOut, seconds: r.stats.timeSeconds, grams: r.stats.filamentGrams }, ext);
  // tool changer: the dialog's mapping, else the printer setting (slot n → head n when neither is set)
  const toolMap = changerOf(cfgOut) === 'toolchanger' ? jo.toolMap ?? toolMapOf(cfgOut) : [];
  const gcodeOut = await postProcess(remapTools(r.gcode, toolMap), cfgOut, fname('gcode'));
  const usedSlots = r.stats.perFilament.map((f, k) => (f.mm > 0 ? k : -1)).filter((k) => k >= 0);
  if (kind === '3mf') {
    const thumb = await renderThumbnail(objs, 512);
    const cfg = currentConfig(s.slice.plate);
    const bytes = await buildGcode3mf([{
      gcode: gcodeOut, stats: r.stats, thumbnail: thumb ?? undefined,
      objects: objs.map((o, i) => ({ id: i + 1, name: o.name })),
      filaments: s.filaments.map((f) => ({ type: filamentById(f.presetId).type, color: f.color })),
      supportUsed: cfg.enable_support === true,
    }], cfg, p.printerModelId ?? '', p.nozzle);
    return { name: fname('gcode.3mf'), data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, kind, usedSlots };
  }
  // PrusaSlicer-style thumbnails right after the header comments (Klipper/Moonraker & printer screens read them)
  let gcode = gcodeOut;
  const blocks: string[] = [];
  for (const sz of [32, 300]) {
    const png = await renderThumbnail(objs, sz);
    if (png) blocks.push(gcodeThumbnailBlock(png, sz, sz));
  }
  if (blocks.length) {
    const k = gcode.indexOf('\n\n');
    gcode = k > 0 ? `${gcode.slice(0, k + 1)};\n${blocks.join('\n')}\n${gcode.slice(k + 1)}` : `${blocks.join('\n')}\n${gcode}`;
  }
  const bytes = new TextEncoder().encode(gcode);
  return { name: fname('gcode'), data: bytes.buffer as ArrayBuffer, kind, usedSlots };
}

export async function exportPlateFile(format: '3mf' | 'gcode') {
  const job = await buildPrintJob(format);
  if (!job) return;
  const saved = await saveFile(job.name, job.data, format === '3mf' ? '3mf' : 'gcode');
  if (saved) useStore.getState().set({ toast: { kind: 'info', text: `Exported ${saved}` } });
}
