// Resolve the flat engine config: system defaults ← printer ← preset ← user overrides, plus machine & filament.
import type { FilamentSlot } from '../engine/types';
import { filamentById } from './filaments';
import { FILAMENT_OVERRIDE_KEYS, filamentConfig, PLATE_TEMP_KEYS } from './filamentParams';
import { MACHINE_DEFAULTS } from './machineParams';
import { printerById, type PlateType } from './printers';
import { PROCESS_DEFAULTS, PROCESS_PRESETS, type Config } from './settings';

export interface ProfileSelection {
  printerId: string;
  plate: PlateType;
  filamentId: string;
  presetId: string;
  overrides: Config;
  machineOverrides?: Config;
  /** The first filament slot's own setting overrides. */
  filamentOverrides?: Config;
}

/** Base process values before user overrides (used for "modified" detection). */
/** Nozzle diameters offered on every printer (mm). */
export const NOZZLES = [0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.8, 1.0];

/** The nozzle in use: the user's choice (machine override) or the printer's own. */
export function effectiveNozzle(printerId: string, machineOverrides?: Config): number {
  const v = Number(machineOverrides?.nozzle_diameter);
  return v > 0 ? v : printerById(printerId).nozzle;
}

export function baseProcess(sel: Pick<ProfileSelection, 'printerId' | 'presetId' | 'machineOverrides'>): Config {
  const printer = printerById(sel.printerId);
  const preset = PROCESS_PRESETS.find((p) => p.id === sel.presetId) ?? PROCESS_PRESETS[3];
  const nz = effectiveNozzle(sel.printerId, sel.machineOverrides);
  const scaled: Config = nz === 0.4 ? {} : {
    line_width: +(nz * 1.05).toFixed(2), outer_wall_line_width: +(nz * 1.05).toFixed(2), inner_wall_line_width: +(nz * 1.125).toFixed(2),
    top_surface_line_width: +(nz * 1.05).toFixed(2), sparse_infill_line_width: +(nz * 1.125).toFixed(2),
    internal_solid_infill_line_width: +(nz * 1.05).toFixed(2), support_line_width: +(nz * 1.05).toFixed(2), initial_layer_line_width: +(nz * 1.25).toFixed(2),
  };
  const merged: Config = { ...PROCESS_DEFAULTS, ...scaled, ...printer.processOverrides, ...preset.values };
  // layers stay between 10% and 75% of the nozzle diameter (and never below 0.04 mm)
  const lo = Math.max(0.04, +(nz * 0.1).toFixed(2)), hi = Math.floor(nz * 75 + 1e-9) / 100;
  const fit = (v: unknown) => Math.min(hi, Math.max(lo, Number(v)));
  merged.layer_height = +fit(merged.layer_height).toFixed(2);
  merged.initial_layer_print_height = +fit(merged.initial_layer_print_height).toFixed(2);
  return merged;
}

/** Layer height limits that follow the nozzle (variable layer height bounds). */
function nozzleLimits(nz: number, machine: Config): Config {
  if (nz === 0.4) return {};
  return { min_layer_height: Math.min(Number(machine.min_layer_height ?? 0.08), Math.max(0.04, +(nz * 0.2).toFixed(2))), max_layer_height: Math.floor(nz * 75 + 1e-9) / 100 };
}

/** Printer settings: defaults ← printer profile ← user edits. */
export function machineConfig(printerId: string, overrides: Config = {}): Config {
  return { ...MACHINE_DEFAULTS, ...printerById(printerId).machine, ...overrides };
}

/** Printer retraction settings with a filament's "Setting overrides" applied. */
export function retractionOverrides(fcfg: Config): Config {
  const out: Config = {};
  for (const k of FILAMENT_OVERRIDE_KEYS) if (fcfg[`filament_${k}`] !== undefined) out[k] = fcfg[`filament_${k}`];
  return out;
}

/** Bed temperatures (initial layer, other layers) of a filament config on a plate type. */
export function bedTemps(fcfg: Config, plate: PlateType): [number, number] {
  const [k0, k1] = PLATE_TEMP_KEYS[plate] ?? PLATE_TEMP_KEYS.textured_pei_plate;
  return [Number(fcfg[k0] ?? 0), Number(fcfg[k1] ?? 0)];
}

export function resolveConfig(sel: ProfileSelection): Config {
  const printer = printerById(sel.printerId);
  const fil = filamentById(sel.filamentId);
  const fcfg = filamentConfig(fil, sel.filamentOverrides);
  const [bed0, bed] = bedTemps(fcfg, sel.plate);
  const machine = machineConfig(sel.printerId, sel.machineOverrides);
  const nz = effectiveNozzle(sel.printerId, sel.machineOverrides);
  return {
    ...baseProcess(sel),
    ...sel.overrides,
    ...machine,
    ...nozzleLimits(nz, machine),
    ...(sel.machineOverrides?.min_layer_height !== undefined ? { min_layer_height: sel.machineOverrides.min_layer_height } : {}),
    ...(sel.machineOverrides?.max_layer_height !== undefined ? { max_layer_height: sel.machineOverrides.max_layer_height } : {}),
    ...fcfg,
    ...retractionOverrides(fcfg),
    printer_model: `${printer.vendor} ${printer.model}`,
    gcode_flavor: printer.flavor,
    nozzle_diameter: nz,
    bed_x: printer.bed.x, bed_y: printer.bed.y, bed_z: printer.bed.z,
    printable_height: printer.bed.z,
    curr_bed_type: sel.plate,
    filament_settings_id: fil.name,
    filament_colour: fil.color,
    bed_temperature: bed,
    bed_temperature_initial_layer: bed0,
    chamber_temperature: Number(fcfg.chamber_temperatures ?? 0),
  };
}

/** Validation warnings shown before slicing. */
export function validate(sel: ProfileSelection): string[] {
  const w: string[] = [];
  const fil = filamentById(sel.filamentId);
  const c = resolveConfig(sel);
  if (!c.bed_temperature) w.push(`${fil.name} is not recommended on this build plate.`);
  if ((c.layer_height as number) > (c.nozzle_diameter as number) * 0.8) w.push('Layer height exceeds 80% of the nozzle diameter.');
  const lo = Number(c.min_layer_height), hi = Number(c.max_layer_height);
  if (lo > 0 && hi > 0 && (Number(c.layer_height) < lo - 1e-9 || Number(c.layer_height) > hi + 1e-9)) w.push(`Layer height ${c.layer_height} mm is outside the printer's ${lo}–${hi} mm range.`);
  const t = Number(c.nozzle_temperature), tl = Number(c.nozzle_temperature_range_low), th = Number(c.nozzle_temperature_range_high);
  if (tl > 0 && th > 0 && (t < tl || t > th)) w.push(`Nozzle temperature ${t} °C is outside the recommended ${tl}–${th} °C for ${fil.name}.`);
  return w;
}

/** Values found with the Calibration workspace (stored per filament slot). */
export interface SlotTuning { flowRatio?: number; pressureAdvance?: number; maxVolumetricSpeed?: number; nozzleTemp?: number; retractionLength?: number }

/** Filament settings a calibration result stands for. */
export function tuningConfig(t: SlotTuning | undefined): Config {
  if (!t) return {};
  const c: Config = {};
  if (t.flowRatio !== undefined) c.filament_flow_ratio = t.flowRatio;
  if (t.pressureAdvance !== undefined) { c.enable_pressure_advance = true; c.pressure_advance = t.pressureAdvance; }
  if (t.maxVolumetricSpeed !== undefined) c.filament_max_volumetric_speed = t.maxVolumetricSpeed;
  if (t.nozzleTemp !== undefined) { c.nozzle_temperature = t.nozzleTemp; c.nozzle_temperature_initial_layer = t.nozzleTemp; }
  if (t.retractionLength !== undefined) c.filament_retraction_length = t.retractionLength;
  return c;
}

export interface SlotState { presetId: string; color: string; tuning?: SlotTuning; overrides?: Config }
/** A slot's own filament settings: its edits, with calibration results on top. */
export const slotOverrides = (s: SlotState): Config => ({ ...(s.overrides ?? {}), ...tuningConfig(s.tuning) });

/** Engine filament slots from the UI slot list (preset + colour + own settings). */
export function filamentSlots(slots: SlotState[]): FilamentSlot[] {
  return slots.map((s) => {
    const f = filamentById(s.presetId);
    const c = filamentConfig(f, slotOverrides(s));
    return {
      name: f.name, type: String(c.filament_type), color: s.color, diameter: Number(c.filament_diameter), density: Number(c.filament_density), cost: Number(c.filament_cost),
      nozzleTemp: Number(c.nozzle_temperature), nozzleTempInitial: Number(c.nozzle_temperature_initial_layer),
      flowRatio: Number(c.filament_flow_ratio), maxVolumetricSpeed: Number(c.filament_max_volumetric_speed),
      pressureAdvance: c.enable_pressure_advance ? Number(c.pressure_advance) : undefined,
      settings: { ...c, ...retractionOverrides(c) },
    };
  });
}
