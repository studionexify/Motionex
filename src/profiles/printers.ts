// Printer (machine) profiles. Add printers by appending to PRINTERS — the rest of the app is data-driven.
import type { Config } from './settings';

export type GcodeFlavor = 'marlin' | 'klipper' | 'bbl';
import type { ConnectionKind } from '../connect/types';
export type { ConnectionKind };
import vendorA1 from './vendor/bbl-a1.json';
import vendorP1S from './vendor/bbl-p1s.json';
import vendorU1 from './vendor/snapmaker-u1.json';
import vendorN4Max from './vendor/elegoo-neptune4max.json';
import { GENERATED_VENDOR } from './vendor/index';

export type PlateType = 'cool_plate' | 'engineering_plate' | 'high_temp_plate' | 'textured_pei_plate' | 'supertack_plate' | 'textured_cool_plate';

export interface PrinterProfile {
  id: string;
  vendor: string;
  model: string;
  nozzle: number;
  bed: { x: number; y: number; z: number };
  /** Bed areas the nozzle cannot print on (e.g. wiper/cutter zones), polygons in mm. */
  excludedAreas?: [number, number][][];
  plates: { type: PlateType; label: string }[];
  flavor: GcodeFlavor;
  connections: ConnectionKind[];
  /** printer_model_id written into .gcode.3mf slice info (A1/P1/X1/H2 printers). */
  printerModelId?: string;
  /** Camera of A1/P1/X1/H2 printers: TLS JPEG stream (A1/P1) or RTSPS (X1/H2). */
  cameraMode?: 'jpeg' | 'rtsp';
  /** Short note shown in the printer picker (firmware quirks, what to check). */
  note?: string;
  machine: Config; // printer-level settings (retraction, limits, g-code macros)
  processOverrides: Config; // speed/accel defaults tuned for this machine
}

const BBL_PLATES: PrinterProfile['plates'] = [
  { type: 'cool_plate', label: 'Cool Plate' },
  { type: 'supertack_plate', label: 'Cool Plate SuperTack' },
  { type: 'textured_cool_plate', label: 'Textured Cool Plate' },
  { type: 'engineering_plate', label: 'Engineering Plate' },
  { type: 'high_temp_plate', label: 'Smooth PEI / High Temp Plate' },
  { type: 'textured_pei_plate', label: 'Textured PEI Plate' },
];
const PEI_PLATES: PrinterProfile['plates'] = [
  { type: 'textured_pei_plate', label: 'Textured PEI Spring Steel' },
  { type: 'high_temp_plate', label: 'Smooth PEI Spring Steel' },
];

const bblStart = (name: string, purgeY: number, purgeX0: number) => `;===== NexSpiro start G-code: ${name} =====
M104 S0 ; keep hotend cold while homing
M140 S[bed_temperature_initial_layer] ; start heating bed
G90
M83 ; relative extrusion
G28 ; home all axes
M190 S[bed_temperature_initial_layer] ; wait for bed
G29 ; auto bed levelling
M104 S[nozzle_temperature_initial_layer]
G1 X${purgeX0} Y${purgeY} Z5 F18000
M109 S[nozzle_temperature_initial_layer] ; wait for hotend
G1 Z0.3 F1200
G1 X${purgeX0 + 80} E12 F1500 ; purge line
G1 X${purgeX0 + 110} E2 F3000
G1 Z1 F1200
;===== end of start G-code =====`;

const bblChange = (chuteX: number, chuteY: number) => `; ===== NexSpiro filament change [previous_extruder] -> [next_extruder] =====
M620 S[next_extruder]A
M204 S9000
G1 Z[toolchange_z] F1200
G1 X${chuteX} Y${chuteY - 20} F21000
G1 Y${chuteY} F3000 ; over the purge chute
M400
M106 P1 S0 ; part fan off while flushing
M104 S[new_filament_temp]
T[next_extruder] ; AMS: cut, unload, load
M400
G92 E0
M109 S[new_filament_temp]
G1 E[flush_length] F240 ; flush the previous colour
M400
G1 E-0.8 F1800
G1 X${chuteX + 20} F15000 ; wipe
G1 X${chuteX} F15000
G1 X${chuteX + 20} F15000
M621 S[next_extruder]A
; ===== end filament change =====`;

const bblEnd = `;===== NexSpiro end G-code =====
G1 E-0.8 F1800 ; retract
G91
G1 Z2 F900 ; lift
G90
G1 X128 Y250 F18000 ; present the print
M140 S0 ; bed off
M104 S0 ; hotend off
M106 S0 ; part fan off
M84 ; motors off`;

const baseMachine = (o: Config): Config => ({
  retraction_length: 0.8,
  retraction_speed: 30,
  deretraction_speed: 30,
  z_hop: 0.4,
  retraction_minimum_travel: 1,
  max_speed_xy: 500,
  max_speed_z: 20,
  max_acceleration: 20000,
  layer_change_gcode: '',
  change_filament_gcode: `; ===== filament change [previous_extruder] -> [next_extruder] =====
G1 Z[toolchange_z] F1200
M600 ; swap to filament [next_extruder], then resume
; ===== end filament change =====`,
  machine_pause_gcode: 'M601',
  filament_change_time: 0,
  has_ams: false,
  ...o,
});


/** Timelapse snapshot (A1/P1/X1/H2): the printer only records when the job enabled timelapse. */
const BBL_TIMELAPSE = `; SKIPPABLE_START
; SKIPTYPE: timelapse
M622.1 S1 ; for prev firmware, default turned on
M1002 judge_flag timelapse_record_flag
M622 J1
 M971 S11 C10 O0
M623
; SKIPPABLE_END`;

/** A1/P1/X1/H2 machine values on top of the base machine (Z hop, wipe, timelapse, extruder clearance). */
const bblMachine = (o: Config, gantry: 'corexy' | 'bedslinger' = 'corexy'): Config => baseMachine({
  z_hop_types: 'auto', retract_when_changing_layer: true, wipe: true, wipe_distance: 2, retract_length_toolchange: 2,
  time_lapse_gcode: BBL_TIMELAPSE, min_layer_height: 0.08, max_layer_height: 0.28,
  ...(gantry === 'corexy'
    ? { extruder_clearance_max_radius: 68, extruder_clearance_height_to_rod: 36, extruder_clearance_height_to_lid: 90, auxiliary_fan: true }
    : { extruder_clearance_max_radius: 76, extruder_clearance_height_to_rod: 25, extruder_clearance_height_to_lid: 250, auxiliary_fan: false }),
  ...o,
});

export const PRINTERS: PrinterProfile[] = [
  {
    id: 'bbl-a1', printerModelId: 'N2S', cameraMode: 'jpeg', vendor: 'Bambu Lab', model: 'A1', nozzle: 0.4, bed: { x: 256, y: 256, z: 256 },
    plates: BBL_PLATES, flavor: 'bbl', connections: ['bbl_lan'],
    machine: bblMachine({ machine_start_gcode: bblStart('Bambu Lab A1', -0.5, 20), machine_end_gcode: bblEnd, max_acceleration: 12000, change_filament_gcode: bblChange(-38, 245), machine_pause_gcode: 'M400 U1', filament_change_time: 60, has_ams: true, default_wipe_tower_pos: '0.0x1.0' }, 'bedslinger'),
    processOverrides: { travel_speed: 700, default_acceleration: 10000, outer_wall_acceleration: 5000 },
  },
  {
    id: 'bbl-a1mini', printerModelId: 'N1', cameraMode: 'jpeg', vendor: 'Bambu Lab', model: 'A1 mini', nozzle: 0.4, bed: { x: 180, y: 180, z: 180 },
    plates: BBL_PLATES, flavor: 'bbl', connections: ['bbl_lan'],
    machine: bblMachine({ machine_start_gcode: bblStart('Bambu Lab A1 mini', -0.5, 10), machine_end_gcode: bblEnd.replace('X128 Y250', 'X90 Y175'), max_acceleration: 10000, change_filament_gcode: bblChange(-13, 175), machine_pause_gcode: 'M400 U1', filament_change_time: 60, has_ams: true }, 'bedslinger'),
    processOverrides: { travel_speed: 700, default_acceleration: 10000 },
  },
  {
    id: 'bbl-p1s', printerModelId: 'C12', cameraMode: 'jpeg', vendor: 'Bambu Lab', model: 'P1S', nozzle: 0.4, bed: { x: 256, y: 256, z: 256 },
    excludedAreas: [[[0, 0], [18, 0], [18, 28], [0, 28]]],
    plates: BBL_PLATES, flavor: 'bbl', connections: ['bbl_lan'],
    machine: bblMachine({ machine_start_gcode: bblStart('Bambu Lab P1S', 0.5, 20), machine_end_gcode: bblEnd, change_filament_gcode: bblChange(70, 265), machine_pause_gcode: 'M400 U1', filament_change_time: 95, has_ams: true, default_wipe_tower_pos: '0.644x0.977' }),
    processOverrides: {},
  },
  {
    id: 'bbl-p1p', printerModelId: 'C11', cameraMode: 'jpeg', vendor: 'Bambu Lab', model: 'P1P', nozzle: 0.4, bed: { x: 256, y: 256, z: 256 },
    excludedAreas: [[[0, 0], [18, 0], [18, 28], [0, 28]]],
    plates: BBL_PLATES, flavor: 'bbl', connections: ['bbl_lan'],
    machine: bblMachine({ machine_start_gcode: bblStart('Bambu Lab P1P', 0.5, 20), machine_end_gcode: bblEnd, change_filament_gcode: bblChange(70, 265), machine_pause_gcode: 'M400 U1', filament_change_time: 95, has_ams: true, auxiliary_fan: false }),
    processOverrides: {},
  },
  {
    id: 'bbl-x1c', printerModelId: 'BL-P001', cameraMode: 'rtsp', vendor: 'Bambu Lab', model: 'X1 Carbon', nozzle: 0.4, bed: { x: 256, y: 256, z: 256 },
    excludedAreas: [[[0, 0], [18, 0], [18, 28], [0, 28]]],
    plates: BBL_PLATES, flavor: 'bbl', connections: ['bbl_lan'],
    machine: bblMachine({ machine_start_gcode: bblStart('Bambu Lab X1 Carbon', 0.5, 20), machine_end_gcode: bblEnd, change_filament_gcode: bblChange(70, 265), machine_pause_gcode: 'M400 U1', filament_change_time: 95, has_ams: true }),
    processOverrides: {},
  },
  {
    id: 'bbl-x1e', printerModelId: 'C13', cameraMode: 'rtsp', vendor: 'Bambu Lab', model: 'X1E', nozzle: 0.4, bed: { x: 256, y: 256, z: 256 },
    excludedAreas: [[[0, 0], [18, 0], [18, 28], [0, 28]]],
    plates: BBL_PLATES, flavor: 'bbl', connections: ['bbl_lan'],
    machine: bblMachine({ machine_start_gcode: bblStart('Bambu Lab X1E', 0.5, 20), machine_end_gcode: bblEnd, change_filament_gcode: bblChange(70, 265), machine_pause_gcode: 'M400 U1', filament_change_time: 95, has_ams: true }),
    processOverrides: {},
  },
  {
    id: 'creality-ender3v3ke', vendor: 'Creality', model: 'Ender-3 V3 KE', nozzle: 0.4, bed: { x: 220, y: 220, z: 240 },
    plates: PEI_PLATES, flavor: 'klipper', connections: ['moonraker'],
    machine: baseMachine({
      machine_start_gcode: `;===== NexSpiro start G-code: Creality Ender-3 V3 KE =====
M140 S[bed_temperature_initial_layer]
M104 S[nozzle_temperature_initial_layer]
START_PRINT EXTRUDER_TEMP=[nozzle_temperature_initial_layer] BED_TEMP=[bed_temperature_initial_layer]
M190 S[bed_temperature_initial_layer]
M109 S[nozzle_temperature_initial_layer]
G90
M83`,
      machine_end_gcode: 'END_PRINT',
      machine_pause_gcode: 'PAUSE',
      retraction_length: 0.8, retraction_speed: 40, deretraction_speed: 40, z_hop: 0.2,
      max_acceleration: 8000,
    }),
    processOverrides: {
      outer_wall_speed: 200, inner_wall_speed: 300, sparse_infill_speed: 270, internal_solid_infill_speed: 250, top_surface_speed: 200,
      travel_speed: 500, default_acceleration: 5000, outer_wall_acceleration: 3000, travel_acceleration: 8000, initial_layer_speed: 50,
    },
  },
  {
    id: 'elegoo-neptune4max', vendor: 'Elegoo', model: 'Neptune 4 Max', nozzle: 0.4, bed: { x: 420, y: 420, z: 480 },
    plates: PEI_PLATES, flavor: 'klipper', connections: ['moonraker'],
    machine: baseMachine({
      machine_start_gcode: `;===== NexSpiro start G-code: Elegoo Neptune 4 Max =====
G90
M83
M140 S[bed_temperature_initial_layer]
M104 S140 ; preheat nozzle below ooze temperature
G28 ; home all axes
M190 S[bed_temperature_initial_layer]
M109 S[nozzle_temperature_initial_layer]
G1 X5 Y10 Z0.3 F6000
G1 Y200 E15 F1500 ; purge line
G1 X5.4 F6000
G1 Y10 E10 F1500
G1 Z1 F600`,
      machine_end_gcode: `G1 E-1 F2400
G91
G1 Z5 F600
G90
G1 X10 Y400 F6000
M104 S0
M140 S0
M106 S0
M84`,
      retraction_length: 0.8, retraction_speed: 40, deretraction_speed: 40, z_hop: 0.2,
      max_acceleration: 5000,
      machine_pause_gcode: 'PAUSE',
    }),
    processOverrides: {
      outer_wall_speed: 150, inner_wall_speed: 200, sparse_infill_speed: 250, internal_solid_infill_speed: 200, top_surface_speed: 150,
      travel_speed: 400, default_acceleration: 5000, outer_wall_acceleration: 3000, top_surface_acceleration: 3000, travel_acceleration: 5000,
    },
  },
];


// ---------------------------------------------------------------- full catalogue (Phase 4)
const marlinStart = (name: string, purgeX = 5, purgeY0 = 20, purgeLen = 180, mesh = 'G29 ; auto bed levelling') => `;===== NexSpiro start G-code: ${name} =====
G90
M83
M140 S[bed_temperature_initial_layer]
M104 S150 ; preheat below ooze temperature
G28 ; home all axes
M190 S[bed_temperature_initial_layer]
${mesh}
M109 S[nozzle_temperature_initial_layer]
G1 Z2 F1500
G1 X${purgeX} Y${purgeY0} Z0.3 F6000
G1 Y${purgeY0 + purgeLen} E15 F1500 ; purge line
G1 X${purgeX + 0.4} F6000
G1 Y${purgeY0} E12 F1500
G1 Z1 F600`;
const marlinEnd = (x: number, y: number) => `G1 E-1 F2400
G91
G1 Z5 F600
G90
G1 X${x} Y${y} F6000 ; present the print
M104 S0
M140 S0
M106 S0
M84`;
const klipperStart = (name: string, macro: string) => `;===== NexSpiro start G-code: ${name} =====
M140 S[bed_temperature_initial_layer]
M104 S[nozzle_temperature_initial_layer]
${macro}
M190 S[bed_temperature_initial_layer]
M109 S[nozzle_temperature_initial_layer]
G90
M83`;

interface Spec {
  id: string; vendor: string; model: string; bed: [number, number, number]; flavor: GcodeFlavor;
  connections: ConnectionKind[]; accel: number; speed: 'slow' | 'medium' | 'fast'; start: string; end: string;
  retract?: number; pause?: string; note?: string; plates?: PrinterProfile['plates'];
}
const SPEEDS = {
  slow: { outer_wall_speed: 60, inner_wall_speed: 90, sparse_infill_speed: 120, internal_solid_infill_speed: 100, top_surface_speed: 60, travel_speed: 180, default_acceleration: 1000, outer_wall_acceleration: 800, top_surface_acceleration: 800, travel_acceleration: 1500, initial_layer_speed: 25, initial_layer_infill_speed: 40, initial_layer_acceleration: 500 },
  medium: { outer_wall_speed: 120, inner_wall_speed: 180, sparse_infill_speed: 220, internal_solid_infill_speed: 180, top_surface_speed: 120, travel_speed: 300, default_acceleration: 4000, outer_wall_acceleration: 2500, top_surface_acceleration: 2500, travel_acceleration: 5000, initial_layer_speed: 40 },
  fast: { outer_wall_speed: 200, inner_wall_speed: 300, sparse_infill_speed: 270, internal_solid_infill_speed: 250, top_surface_speed: 200, travel_speed: 500, default_acceleration: 8000, outer_wall_acceleration: 5000, top_surface_acceleration: 5000, travel_acceleration: 12000, initial_layer_speed: 50 },
};
const make = (p: Spec): PrinterProfile => ({
  id: p.id, vendor: p.vendor, model: p.model, nozzle: 0.4, bed: { x: p.bed[0], y: p.bed[1], z: p.bed[2] },
  plates: p.plates ?? PEI_PLATES, flavor: p.flavor, connections: p.connections, note: p.note,
  machine: baseMachine({
    machine_start_gcode: p.start, machine_end_gcode: p.end, max_acceleration: p.accel,
    retraction_length: p.retract ?? (p.flavor === 'marlin' ? 1 : 0.8), retraction_speed: 40, deretraction_speed: 40, z_hop: 0.2,
    machine_pause_gcode: p.pause ?? (p.flavor === 'klipper' ? 'PAUSE' : 'M601'),
  }),
  processOverrides: { ...SPEEDS[p.speed], default_acceleration: Math.min(SPEEDS[p.speed].default_acceleration, p.accel) },
});
const K = (id: string, vendor: string, model: string, bed: [number, number, number], macro: string, speed: Spec['speed'], accel: number, extra: Partial<Spec> = {}) =>
  make({ id, vendor, model, bed, flavor: 'klipper', connections: ['moonraker'], accel, speed, start: klipperStart(`${vendor} ${model}`, macro), end: extra.end ?? 'END_PRINT', ...extra });
const M = (id: string, vendor: string, model: string, bed: [number, number, number], speed: Spec['speed'], accel: number, extra: Partial<Spec> = {}) =>
  make({ id, vendor, model, bed, flavor: 'marlin', connections: ['serial', 'octoprint'], accel, speed, start: marlinStart(`${vendor} ${model}`), end: marlinEnd(10, bed[1] - 10), ...extra });

/** G-code for a head swap: heat the next head if it isn't yet, pick it up (the firmware applies its offsets), wait for it. */
const TOOL_CHANGE = `; ===== NexSpiro tool change T[previous_extruder] -> T[next_extruder] =====
M104 T[next_extruder] S[new_filament_temp] ; next head to print temperature (preheated already when there was time)
T[next_extruder] ; park the head in use, pick up the next one
M109 T[next_extruder] S[new_filament_temp]
G92 E0
; ===== end tool change =====`;

/** A printer with one nozzle per filament: head swaps instead of filament swaps. */
const toolchanger = (p: PrinterProfile, heads: number, swapSeconds: number, extra: Record<string, unknown> = {}): PrinterProfile => ({
  ...p,
  machine: {
    ...p.machine, changer_type: 'toolchanger', toolhead_count: heads, has_ams: false, change_filament_gcode: TOOL_CHANGE, filament_change_time: swapSeconds,
    retract_restart_extra_toolchange: 0.1,
    tool_prime_volume: 3, ooze_prevention: true, standby_temperature_delta: -40, tool_preheat_time: 30, preheat_delta_temperature: 0,
    ...extra,
  },
});

/** Filament change on a unit without a purge chute (MMU3, ERCF / Happy Hare, BoxTurtle / AFC): the swap happens over the
 *  prime tower, which then takes the flush ([flush_length] is 0 while the tower is printed). */
const TOWER_UNIT_CHANGE = (unit: string) => `; ===== NexSpiro filament change [previous_extruder] -> [next_extruder] =====
G1 Z[toolchange_z] F1200
G1 X[wipe_tower_x] Y[wipe_tower_y] F9000 ; over the prime tower, so any ooze lands there
M104 S[new_filament_temp]
T[next_extruder] ; ${unit}: unload, select, load to the nozzle
M109 S[new_filament_temp]
G92 E0
G1 E[flush_length] F240 ; flush here only without a prime tower
; ===== end filament change =====`;

/** Filament change on a unit with a purge chute (Creality CFS, Anycubic ACE Pro): the firmware's T command cuts,
 *  unloads, loads and parks over the chute; the flush is pushed out there. */
const CHUTE_UNIT_CHANGE = (unit: string) => `; ===== NexSpiro filament change [previous_extruder] -> [next_extruder] =====
G1 Z[toolchange_z] F1200
M104 S[new_filament_temp]
T[next_extruder] ; ${unit}: cut, unload, load, park over the purge chute
M109 S[new_filament_temp]
G92 E0
G1 E[flush_length] F300 ; flush the previous colour into the chute
G1 E-0.8 F1800
; ===== end filament change =====`;

const VERIFY = (slicer: string) => ` Check the start and change G-code against ${slicer} before the first print.`;

/** A single-nozzle printer with a filament unit: a filament swap (and a flush) on every colour change. */
const filamentUnit = (p: PrinterProfile, u: { id: string; model: string; unit: string; slots: number; seconds: number; purge: 'chute' | 'tower'; note: string }): PrinterProfile => ({
  ...p, id: u.id, model: u.model, note: u.note,
  machine: {
    ...p.machine, changer_type: 'ams', has_ams: false, purge_target: u.purge, filament_slots: u.slots, filament_change_time: u.seconds,
    change_filament_gcode: u.purge === 'tower' ? TOWER_UNIT_CHANGE(u.unit) : CHUTE_UNIT_CHANGE(u.unit),
  },
});

const H2D: PrinterProfile = {
  id: 'bbl-h2d', printerModelId: 'O1D', cameraMode: 'rtsp', vendor: 'Bambu Lab', model: 'H2D', nozzle: 0.4, bed: { x: 350, y: 320, z: 325 },
  plates: BBL_PLATES, flavor: 'bbl', connections: ['bbl_lan'],
  note: 'Prints with one of the H2D\'s two nozzles: every colour comes from the AMS through that nozzle, with a cut, a flush into the chute and ~95 s per change, as on the X1. Printing with both nozzles (one filament each, no flush between them) is not supported: use Bambu Studio for dual-nozzle prints.',
  machine: bblMachine({ machine_start_gcode: bblStart('Bambu Lab H2D', 0.5, 20), machine_end_gcode: bblEnd.replace('X128 Y250', 'X160 Y310'), change_filament_gcode: bblChange(340, 300), machine_pause_gcode: 'M400 U1', filament_change_time: 95, has_ams: true }),
  processOverrides: {},
};

PRINTERS.push(
  H2D,
  // Creality
  K('creality-k1', 'Creality', 'K1', [220, 220, 250], 'START_PRINT EXTRUDER_TEMP=[nozzle_temperature_initial_layer] BED_TEMP=[bed_temperature_initial_layer]', 'fast', 20000),
  K('creality-k1c', 'Creality', 'K1C', [220, 220, 250], 'START_PRINT EXTRUDER_TEMP=[nozzle_temperature_initial_layer] BED_TEMP=[bed_temperature_initial_layer]', 'fast', 20000),
  K('creality-k1max', 'Creality', 'K1 Max', [300, 300, 300], 'START_PRINT EXTRUDER_TEMP=[nozzle_temperature_initial_layer] BED_TEMP=[bed_temperature_initial_layer]', 'fast', 20000),
  K('creality-k2plus', 'Creality', 'K2 Plus', [350, 350, 350], 'START_PRINT EXTRUDER_TEMP=[nozzle_temperature_initial_layer] BED_TEMP=[bed_temperature_initial_layer]', 'fast', 20000, { note: 'Single colour. With a CFS, pick K2 Plus Combo (CFS).' }),
  K('creality-ender3v3', 'Creality', 'Ender-3 V3', [220, 220, 250], 'START_PRINT EXTRUDER_TEMP=[nozzle_temperature_initial_layer] BED_TEMP=[bed_temperature_initial_layer]', 'fast', 20000),
  M('creality-ender3v3se', 'Creality', 'Ender-3 V3 SE', [220, 220, 250], 'medium', 3000, { start: marlinStart('Creality Ender-3 V3 SE', 5, 20, 180, 'G29 ; CR Touch levelling') }),
  M('creality-ender3s1', 'Creality', 'Ender-3 S1', [220, 220, 270], 'slow', 1000),
  M('creality-ender3v2', 'Creality', 'Ender-3 V2', [220, 220, 250], 'slow', 1000, { start: marlinStart('Creality Ender-3 V2', 5, 20, 180, '; (no probe) use the saved mesh: M420 S1') }),
  K('creality-cr10se', 'Creality', 'CR-10 SE', [220, 220, 265], 'START_PRINT EXTRUDER_TEMP=[nozzle_temperature_initial_layer] BED_TEMP=[bed_temperature_initial_layer]', 'fast', 8000),
  // Elegoo
  K('elegoo-neptune4', 'Elegoo', 'Neptune 4', [225, 225, 265], '', 'fast', 5000, { start: marlinStart('Elegoo Neptune 4').replace('G29 ; auto bed levelling', 'BED_MESH_PROFILE LOAD=default'), end: marlinEnd(10, 215) }),
  K('elegoo-neptune4pro', 'Elegoo', 'Neptune 4 Pro', [225, 225, 265], '', 'fast', 5000, { start: marlinStart('Elegoo Neptune 4 Pro').replace('G29 ; auto bed levelling', 'BED_MESH_PROFILE LOAD=default'), end: marlinEnd(10, 215) }),
  K('elegoo-neptune4plus', 'Elegoo', 'Neptune 4 Plus', [320, 320, 385], '', 'fast', 5000, { start: marlinStart('Elegoo Neptune 4 Plus').replace('G29 ; auto bed levelling', 'BED_MESH_PROFILE LOAD=default'), end: marlinEnd(10, 310) }),
  M('elegoo-neptune3pro', 'Elegoo', 'Neptune 3 Pro', [225, 225, 280], 'slow', 1500),
  make({ id: 'elegoo-centauri', vendor: 'Elegoo', model: 'Centauri Carbon', bed: [256, 256, 256], flavor: 'klipper', connections: [], accel: 20000, speed: 'fast',
    start: klipperStart('Elegoo Centauri Carbon', 'START_PRINT EXTRUDER_TEMP=[nozzle_temperature_initial_layer] BED_TEMP=[bed_temperature_initial_layer]'), end: 'END_PRINT',
    note: 'Uses Elegoo\'s own network protocol — export the G-code and print from USB stick.' }),
  // Prusa (PrusaLink accepts the OctoPrint upload API)
  M('prusa-mk4s', 'Prusa', 'MK4S', [250, 210, 220], 'medium', 4000, { connections: ['octoprint', 'serial'], start: marlinStart('Prusa MK4S', 5, 20, 120, 'G29 ; mesh bed levelling'), note: 'PrusaLink: use OctoPrint connection with the PrusaLink API key.' }),
  M('prusa-mk3s', 'Prusa', 'MK3S+', [250, 210, 210], 'slow', 1250, { connections: ['octoprint', 'serial'], start: marlinStart('Prusa MK3S+', 5, 20, 120, 'G80 ; mesh bed levelling') }),
  M('prusa-mini', 'Prusa', 'MINI+', [180, 180, 180], 'medium', 2500, { connections: ['octoprint', 'serial'], start: marlinStart('Prusa MINI+', 5, 20, 120, 'G29 ; mesh bed levelling') }),
  M('prusa-coreone', 'Prusa', 'CORE One', [250, 220, 270], 'fast', 8000, { connections: ['octoprint'], start: marlinStart('Prusa CORE One', 5, 20, 120, 'G29 ; mesh bed levelling') }),
  M('prusa-xl', 'Prusa', 'XL (single tool)', [360, 360, 360], 'medium', 5000, { connections: ['octoprint'], start: marlinStart('Prusa XL', 5, 20, 200, 'G29 ; mesh bed levelling') }),
  // Anycubic
  M('anycubic-kobra2neo', 'Anycubic', 'Kobra 2 Neo', [220, 220, 250], 'medium', 2500),
  M('anycubic-kobra2max', 'Anycubic', 'Kobra 2 Max', [420, 420, 500], 'medium', 3000),
  M('anycubic-kobra3', 'Anycubic', 'Kobra 3', [250, 250, 260], 'fast', 10000, { connections: ['serial'], note: 'Single colour. With an ACE Pro, pick Kobra 3 Combo (ACE Pro).' }),
  // Voron & other Klipper machines
  K('voron-24-350', 'Voron', '2.4 350', [350, 350, 340], 'PRINT_START BED=[bed_temperature_initial_layer] HOTEND=[nozzle_temperature_initial_layer]', 'fast', 10000, { end: 'PRINT_END' }),
  K('voron-trident-300', 'Voron', 'Trident 300', [300, 300, 250], 'PRINT_START BED=[bed_temperature_initial_layer] HOTEND=[nozzle_temperature_initial_layer]', 'fast', 10000, { end: 'PRINT_END' }),
  K('voron-02', 'Voron', '0.2', [120, 120, 120], 'PRINT_START BED=[bed_temperature_initial_layer] HOTEND=[nozzle_temperature_initial_layer]', 'fast', 10000, { end: 'PRINT_END' }),
  K('qidi-q1pro', 'Qidi', 'Q1 Pro', [245, 245, 240], 'PRINT_START BED=[bed_temperature_initial_layer] HOTEND=[nozzle_temperature_initial_layer] CHAMBER=0', 'fast', 20000, { end: 'PRINT_END' }),
  K('qidi-xplus3', 'Qidi', 'X-Plus 3', [280, 280, 270], 'PRINT_START BED=[bed_temperature_initial_layer] HOTEND=[nozzle_temperature_initial_layer] CHAMBER=0', 'fast', 20000, { end: 'PRINT_END' }),
  K('qidi-xmax3', 'Qidi', 'X-Max 3', [325, 325, 315], 'PRINT_START BED=[bed_temperature_initial_layer] HOTEND=[nozzle_temperature_initial_layer] CHAMBER=0', 'fast', 20000, { end: 'PRINT_END' }),
  K('sovol-sv08', 'Sovol', 'SV08', [350, 350, 345], 'START_PRINT EXTRUDER_TEMP=[nozzle_temperature_initial_layer] BED_TEMP=[bed_temperature_initial_layer]', 'fast', 20000),
  K('sovol-sv07', 'Sovol', 'SV07', [220, 220, 250], 'PRINT_START BED_TEMP=[bed_temperature_initial_layer] EXTRUDER_TEMP=[nozzle_temperature_initial_layer]', 'fast', 8000, { end: 'PRINT_END' }),
  M('sovol-sv06', 'Sovol', 'SV06', [220, 220, 250], 'slow', 1500),
  K('artillery-x4plus', 'Artillery', 'Sidewinder X4 Plus', [300, 300, 400], 'START_PRINT EXTRUDER_TEMP=[nozzle_temperature_initial_layer] BED_TEMP=[bed_temperature_initial_layer]', 'fast', 7000),
  // filament units: one nozzle, a filament swap and a flush on every colour change (chute or prime tower)
  filamentUnit(M('prusa-mk4s', 'Prusa', 'MK4S', [250, 210, 220], 'medium', 4000, { connections: ['octoprint', 'serial'], start: marlinStart('Prusa MK4S MMU3', 5, 20, 120, 'G29 ; mesh bed levelling') }),
    { id: 'prusa-mk4s-mmu3', model: 'MK4S + MMU3', unit: 'MMU3', slots: 5, seconds: 40, purge: 'tower',
      note: 'Five filaments through one nozzle. The MMU3 has no purge chute, so each change is flushed on the prime tower (sized from the flushing volumes).' + VERIFY('PrusaSlicer\'s MK4S MMU3 profile') }),
  filamentUnit(M('prusa-coreone', 'Prusa', 'CORE One', [250, 220, 270], 'fast', 8000, { connections: ['octoprint'], start: marlinStart('Prusa CORE One MMU3', 5, 20, 120, 'G29 ; mesh bed levelling') }),
    { id: 'prusa-coreone-mmu3', model: 'CORE One + MMU3', unit: 'MMU3', slots: 5, seconds: 40, purge: 'tower',
      note: 'Five filaments through one nozzle, flushed on the prime tower (the MMU3 has no purge chute).' + VERIFY('PrusaSlicer\'s CORE One MMU3 profile') }),
  filamentUnit(M('prusa-mk3s', 'Prusa', 'MK3S+', [250, 210, 210], 'slow', 1250, { connections: ['octoprint', 'serial'], start: marlinStart('Prusa MK3S+ MMU3', 5, 20, 120, 'G80 ; mesh bed levelling') }),
    { id: 'prusa-mk3s-mmu3', model: 'MK3S+ + MMU3', unit: 'MMU3', slots: 5, seconds: 45, purge: 'tower',
      note: 'Five filaments through one nozzle, flushed on the prime tower (the MMU3 has no purge chute).' + VERIFY('PrusaSlicer\'s MK3S+ MMU3 profile') }),
  filamentUnit(K('creality-k2plus', 'Creality', 'K2 Plus', [350, 350, 350], 'START_PRINT EXTRUDER_TEMP=[nozzle_temperature_initial_layer] BED_TEMP=[bed_temperature_initial_layer]', 'fast', 20000),
    { id: 'creality-k2plus-cfs', model: 'K2 Plus Combo (CFS)', unit: 'CFS', slots: 4, seconds: 80, purge: 'chute',
      note: 'CFS: cut, unload, load and flush into the purge chute. 4 slots per CFS: set Filament slots to 8, 12 or 16 with more units.' + VERIFY('Creality Print\'s K2 Plus CFS profile (the T command must park the nozzle over the chute)') }),
  filamentUnit(K('creality-k1c', 'Creality', 'K1C', [220, 220, 250], 'START_PRINT EXTRUDER_TEMP=[nozzle_temperature_initial_layer] BED_TEMP=[bed_temperature_initial_layer]', 'fast', 20000),
    { id: 'creality-k1c-cfs', model: 'K1C + CFS', unit: 'CFS', slots: 4, seconds: 80, purge: 'chute',
      note: 'K1C with the CFS upgrade (cutter and purge chute).' + VERIFY('Creality Print\'s K1C CFS profile (the T command must park the nozzle over the chute)') }),
  filamentUnit(K('creality-k1max', 'Creality', 'K1 Max', [300, 300, 300], 'START_PRINT EXTRUDER_TEMP=[nozzle_temperature_initial_layer] BED_TEMP=[bed_temperature_initial_layer]', 'fast', 20000),
    { id: 'creality-k1max-cfs', model: 'K1 Max + CFS', unit: 'CFS', slots: 4, seconds: 80, purge: 'chute',
      note: 'K1 Max with the CFS upgrade (cutter and purge chute).' + VERIFY('Creality Print\'s K1 Max CFS profile (the T command must park the nozzle over the chute)') }),
  filamentUnit(K('creality-hi', 'Creality', 'Hi', [260, 260, 300], 'START_PRINT EXTRUDER_TEMP=[nozzle_temperature_initial_layer] BED_TEMP=[bed_temperature_initial_layer]', 'fast', 12000),
    { id: 'creality-hi-cfs', model: 'Hi Combo (CFS)', unit: 'CFS', slots: 4, seconds: 80, purge: 'chute',
      note: 'Hi Combo: CFS feeding a bed-slinger, flushed into the purge chute.' + VERIFY('Creality Print\'s Hi Combo profile (bed size and the T command too)') }),
  filamentUnit(M('anycubic-kobra3', 'Anycubic', 'Kobra 3', [250, 250, 260], 'fast', 10000, { connections: ['serial'] }),
    { id: 'anycubic-kobra3-ace', model: 'Kobra 3 Combo (ACE Pro)', unit: 'ACE Pro', slots: 4, seconds: 75, purge: 'chute',
      note: 'ACE Pro: cut, unload, load and flush into the purge chute. Set Filament slots to 8 with two ACE Pro units.' + VERIFY('Anycubic Slicer Next\'s Kobra 3 Combo profile (the T command must park the nozzle over the chute)') }),
  filamentUnit(M('anycubic-kobras1', 'Anycubic', 'Kobra S1', [250, 250, 250], 'fast', 20000, { connections: [] }),
    { id: 'anycubic-kobras1-ace', model: 'Kobra S1 Combo (ACE Pro)', unit: 'ACE Pro', slots: 4, seconds: 75, purge: 'chute',
      note: 'ACE Pro, flushed into the purge chute. Export the G-code and print from USB or Anycubic\'s app.' + VERIFY('Anycubic Slicer Next\'s Kobra S1 Combo profile (the T command must park the nozzle over the chute)') }),
  filamentUnit(K('generic-klipper-mmu', 'Generic', 'Klipper printer', [300, 300, 300], 'PRINT_START BED=[bed_temperature_initial_layer] HOTEND=[nozzle_temperature_initial_layer]', 'medium', 5000, { end: 'PRINT_END' }),
    { id: 'generic-klipper-mmu', model: 'Klipper multi-material unit', unit: 'MMU', slots: 8, seconds: 45, purge: 'tower',
      note: 'ERCF / Tradrack (Happy Hare), BoxTurtle / AFC and other Klipper units: T0…Tn macros swap the filament, the prime tower takes the flush. Set Filament slots to your lane count (4–12); with a purge bucket (Blobifier), set Purge into to Purge chute and move the flush in the change G-code over the bucket.' }),
  // tool changers and IDEX: one nozzle per filament, no purge between colours
  toolchanger(M('prusa-xl-5t', 'Prusa', 'XL (5 toolheads)', [360, 360, 360], 'medium', 5000, { connections: ['octoprint'], start: marlinStart('Prusa XL 5T', 5, 20, 200, 'G29 ; mesh bed levelling'),
    note: 'Five heads, one filament each. Check the start G-code against PrusaSlicer\'s XL profile before the first print.' }), 5, 12),
  toolchanger(K('snapmaker-u1', 'Snapmaker', 'U1', [270, 270, 270], 'PRINT_START BED=[bed_temperature_initial_layer] HOTEND=[nozzle_temperature_initial_layer]', 'fast', 10000, { end: 'PRINT_END', connections: ['moonraker'],
    note: 'Four-head tool changer: each colour on its own head, swapped in seconds with no purge. Heads waiting for their turn sit at standby, are preheated before their pick-up and switch off after their last use. Send over LAN with a Klipper / Moonraker connection (the printer\'s IP, port 7125); in the Print dialog, map each filament to the head it is loaded on. Check the start macro against Snapmaker\'s own profile before the first print.' }), 4, 6, { standby_temperature_delta: -150, tool_preheat_time: 30, preheat_delta_temperature: 0 }),
  toolchanger(K('generic-toolchanger', 'Generic', 'Klipper tool changer', [300, 300, 300], 'PRINT_START BED=[bed_temperature_initial_layer] HOTEND=[nozzle_temperature_initial_layer]', 'fast', 10000, { end: 'PRINT_END',
    note: 'StealthChanger, TapChanger, Jubilee and other Klipper tool changers: T0…Tn macros pick up the head and apply its offsets. Set the number of heads in Printer settings.' }), 4, 10),
  toolchanger(M('generic-idex', 'Generic', 'IDEX printer', [300, 300, 300], 'medium', 4000, { note: 'Independent dual extruder (two heads, T0 / T1). The firmware parks the idle head and applies its offset.' }), 2, 6),
  // generic
  M('generic-marlin', 'Generic', 'Marlin printer', [220, 220, 250], 'slow', 1000, { note: 'Starting point for any Marlin printer — set the bed size and start G-code in Printer settings.' }),
  K('generic-klipper', 'Generic', 'Klipper printer', [300, 300, 300], 'PRINT_START BED=[bed_temperature_initial_layer] HOTEND=[nozzle_temperature_initial_layer]', 'medium', 5000, { end: 'PRINT_END', note: 'Expects PRINT_START / PRINT_END macros in printer.cfg.' }),
);

// ---------------------------------------------------------------- the makers' own profiles, verbatim
// Start, end, filament change, layer change and time lapse G-code are the printer makers' own templates, unchanged
// (src/profiles/vendor/*.json, with the slicer repository and commit they come from), run by placeholder.ts with
// the variables those slicers give them. The machine values below are taken from the same profiles.
const VENDOR: Record<string, { tpl: VendorProfile; machine: Config; process?: Config; bed?: Partial<PrinterProfile['bed']> }> = {
  'bbl-a1': { tpl: vendorA1 as VendorProfile, machine: {
    retract_before_wipe: 0, retract_lift_below: 255, max_speed_z: 30, max_acceleration: 12000,
    extruder_clearance_max_radius: 73, extruder_clearance_height_to_rod: 25, extruder_clearance_height_to_lid: 256,
  } },
  'bbl-p1s': { tpl: vendorP1S as VendorProfile, bed: { z: 250 }, machine: {
    retract_before_wipe: 0, retract_lift_below: 249, max_speed_z: 20, max_acceleration: 20000,
    extruder_clearance_max_radius: 68, extruder_clearance_height_to_rod: 34, extruder_clearance_height_to_lid: 90,
  } },
  'snapmaker-u1': { tpl: vendorU1 as VendorProfile, machine: {
    retraction_length: 1.5, retraction_speed: 30, deretraction_speed: 30, z_hop: 0.4, z_hop_types: 'auto', wipe: true, wipe_distance: 2,
    retract_before_wipe: 0, retract_length_toolchange: 10, retract_restart_extra_toolchange: 0, retract_when_changing_layer: true,
    retract_lift_below: 269, retraction_minimum_travel: 1, max_layer_height: 0.32, max_speed_z: 20, max_acceleration: 20000,
    extruder_clearance_max_radius: 72.5, extruder_clearance_height_to_rod: 27.5, extruder_clearance_height_to_lid: 140,
    auxiliary_fan: true, filament_change_time: 5, chamber_cooling_mode: 1,
  }, process: { prime_tower_width: 30, prime_tower_brim_width: 5, prime_volume: 45 } },
  'elegoo-neptune4max': { tpl: vendorN4Max as VendorProfile, bed: { x: 426, y: 426, z: 480 }, machine: {
    retraction_length: 0.8, retraction_speed: 60, deretraction_speed: 30, z_hop: 0.4, z_hop_types: 'auto', wipe: true, wipe_distance: 1.2,
    retract_before_wipe: 0, retract_length_toolchange: 2, retract_restart_extra_toolchange: 0, retraction_minimum_travel: 0.8,
    retract_when_changing_layer: true, retract_lift_below: 479, max_speed_z: 20, max_acceleration: 5000,
    extruder_clearance_max_radius: 47, extruder_clearance_height_to_rod: 34, extruder_clearance_height_to_lid: 34, auxiliary_fan: false,
  }, process: {
    // Elegoo's "0.20mm Standard @Elegoo N4Max 0.4 nozzle" (OrcaSlicer): values that differ from NexSpiro's defaults
    outer_wall_speed: 160, inner_wall_speed: 200, sparse_infill_speed: 200, internal_solid_infill_speed: 250, top_surface_speed: 200, travel_speed: 500,
    default_acceleration: 3000, outer_wall_acceleration: 1500, top_surface_acceleration: 2000, travel_acceleration: 3000,
    bottom_shell_layers: 4, bottom_shell_thickness: 0.8, elefant_foot_compensation: 0.1, filter_out_gap_fill: 1, print_flow_ratio: 0.97,
    sparse_infill_pattern: 'cubic', support_interface_bottom_layers: 2, enable_prime_tower: false, wipe_speed: 100,
    tree_support_branch_angle: 45, tree_support_branch_diameter: 2, tree_support_tip_diameter: 2, tree_support_wall_count: 0,
  } },
};
interface VendorProfile { vendor: string; repo: string; commit: string; profile: string; templates: Record<string, string>; head_wrap_detect_zone?: string[] | null }
for (const p of PRINTERS) {
  const v = VENDOR[p.id];
  if (!v) continue;
  if (v.bed) p.bed = { ...p.bed, ...v.bed };
  p.machine = {
    ...p.machine, ...v.machine, ...v.tpl.templates, gcode_templates: 'vendor',
    gcode_template_source: `${v.tpl.vendor}: ${v.tpl.repo}@${v.tpl.commit.slice(0, 10)} ${v.tpl.profile}`,
    head_wrap_detect_zone: (v.tpl.head_wrap_detect_zone ?? []).join(','),
  };
  if (v.process) p.processOverrides = { ...p.processOverrides, ...v.process };
}

// Every other printer with a maker's profile in OrcaSlicer / Bambu Studio: templates, machine values, bed and excluded
// areas from the resolved profile (src/profiles/vendor/<id>.json, generated with its source). NexSpiro keeps its own
// G-code for a block the profile leaves empty (e.g. the filament change of a unit Orca drives itself).
interface GeneratedVendor extends VendorProfile {
  flavor: GcodeFlavor; bed: Partial<PrinterProfile['bed']>; excluded_areas: [number, number][][]; machine: Config;
  /** Other profile values the templates read (H2D: hotend_heating_rate per nozzle), for names NexSpiro does not set. */
  template_vars?: Record<string, unknown>;
}
for (const p of PRINTERS) {
  const v = GENERATED_VENDOR[p.id] as GeneratedVendor | undefined;
  if (!v || VENDOR[p.id]) continue;
  p.bed = { ...p.bed, ...v.bed };
  if (v.excluded_areas.length) p.excludedAreas = v.excluded_areas;
  p.flavor = v.flavor;
  // the profile's layer height range is for its own process presets; NexSpiro's presets (0.08–0.28 mm) keep theirs
  const { min_layer_height: _min, max_layer_height: _max, ...values } = v.machine;
  p.machine = {
    ...p.machine, ...values, ...v.templates, gcode_templates: 'vendor',
    gcode_template_source: `${v.vendor}: ${v.repo}@${v.commit.slice(0, 10)} ${v.profile}`,
    head_wrap_detect_zone: (v.head_wrap_detect_zone ?? []).join(','),
    ...(v.template_vars && Object.keys(v.template_vars).length ? { vendor_template_vars: JSON.stringify(v.template_vars) } : {}),
  };
  // a filament unit: OrcaSlicer flushes on the prime tower (purge_in_prime_tower, on by default) or leaves the purge to the
  // firmware's change command over its chute (Creality K2 / Hi CFS, Anycubic ACE Pro)
  if (p.machine.changer_type === 'ams' && !/flush_length/.test(String(v.templates.change_filament_gcode ?? '')) && v.templates.change_filament_gcode) {
    p.machine.purge_target = v.machine.purge_in_prime_tower === false ? 'chute' : 'tower';
  }
  const accel = Number(p.machine.max_acceleration);
  if (accel > 0 && Number(p.processOverrides.default_acceleration) > accel) p.processOverrides = { ...p.processOverrides, default_acceleration: accel };
}

export const printerById = (id: string) => PRINTERS.find((p) => p.id === id) ?? PRINTERS[0];
/** Display name; pass the nozzle in use (see effectiveNozzle) to show a chosen nozzle instead of the printer's own. */
export const printerName = (p: PrinterProfile, nozzle: number = p.nozzle) => `${p.vendor} ${p.model} ${nozzle} nozzle`;

/** Note for the printer picker when exact arc output (G2/G3) needs something on the firmware side; null when arcs work as shipped. */
export function arcSupportNote(p: PrinterProfile): string | null {
  if (p.flavor === 'bbl') return null;
  if (p.flavor === 'klipper') return 'Exact arcs (G2/G3) need [gcode_arcs] in printer.cfg. Without it, turn off Arc fitting; NexSpiro then writes fine segments.';
  return 'Exact arcs (G2/G3) need ARC_SUPPORT in Marlin. It is on in most builds, but some vendor firmware leaves it out. If arcs are ignored, turn off Arc fitting.';
}
