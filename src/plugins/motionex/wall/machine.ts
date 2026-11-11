// What the wall-art modes need to know about the printer: firmware flavour, motion limits, the real
// line width for any nozzle, and the extruder and gantry of known printers (Bowden tubes, bed slingers).
import type { Config } from '../../../profiles/settings';
import { PRINTERS, type GcodeFlavor } from '../../../profiles/printers';

const num = (cfg: Config, k: string, d: number) => { const v = parseFloat(String(cfg[k] ?? '')); return Number.isFinite(v) ? v : d; };

/** Printers with the extruder on the frame and a long PTFE tube to the hot end. */
const BOWDEN = new Set(['creality-ender3v2', 'prusa-mini', 'elegoo-neptune3pro']);
/** Printers that move the bed (Y) under the head: the part's mass swings with every speed change. */
const BED_SLINGERS = new Set([
  'bbl-a1', 'bbl-a1mini', 'creality-ender3v3ke', 'creality-ender3v3', 'creality-ender3v3se', 'creality-ender3s1', 'creality-ender3v2', 'creality-cr10se',
  'elegoo-neptune4', 'elegoo-neptune4pro', 'elegoo-neptune4plus', 'elegoo-neptune4max', 'elegoo-neptune3pro',
  'prusa-mk4s', 'prusa-mk3s', 'prusa-mini', 'anycubic-kobra2neo', 'anycubic-kobra2max', 'anycubic-kobra3',
  'sovol-sv06', 'sovol-sv07', 'artillery-x4plus', 'creality-hi', 'generic-marlin',
]);
/** In a set by id, or by the printer it was built on (a combo with a filament unit: "prusa-mk4s-mmu3"). */
const known = (set: Set<string>, id = '') => set.has(id) || [...set].some((b) => id.startsWith(`${b}-`));

export const flavourOf = (cfg: Config): GcodeFlavor => { const f = String(cfg.gcode_flavor ?? 'marlin'); return f === 'klipper' || f === 'bbl' ? f : 'marlin'; };

/** Firmware acceleration limit (mm/s²); Infinity when the printer sets none. */
export const maxAccelOf = (cfg: Config) => { const a = num(cfg, 'max_acceleration', 0); return a > 0 ? a : Infinity; };

/** Outer wall line width (mm): its own setting, the default line width, or 105% of the nozzle. */
export const outerLineWidth = (cfg: Config) => num(cfg, 'outer_wall_line_width', 0) || num(cfg, 'line_width', 0) || 1.05 * num(cfg, 'nozzle_diameter', 0.4);

/** Printer id from the resolved config (it carries "vendor model" as printer_model). */
export function printerIdOf(cfg: Config): string | undefined {
  const name = String(cfg.printer_model ?? '');
  return PRINTERS.find((p) => `${p.vendor} ${p.model}` === name)?.id;
}

/** Bowden extruder: a known Bowden printer, or a retraction of 2 mm or more (no direct drive needs that much). */
export const isBowden = (cfg: Config, printerId = printerIdOf(cfg)) => num(cfg, 'retraction_length', 0) >= 2 || known(BOWDEN, printerId);

export const isBedSlinger = (cfg: Config, printerId = printerIdOf(cfg)) => known(BED_SLINGERS, printerId);

/**
 * Shortest move (mm) the firmware takes at speed v (mm/s) without starving its planner: Marlin wants
 * about 4 ms per move (fewer, longer moves; its buffer is short and it slows down when it runs low),
 * Klipper and Bambu firmware about 1 ms.
 */
export const minMoveMm = (cfg: Config, v: number) => Math.max(0, v) * (flavourOf(cfg) === 'marlin' ? 0.004 : 0.001);
