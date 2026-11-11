// Filament settings, laid out in filament settings pages (Filament, Cooling, Setting overrides,
// Advanced, Notes). Values come from the filament profile; each filament slot can override any of them.
import type { FilamentProfile } from './filaments';
import type { Config, ParamDef } from './settings';

const opts = (...pairs: [string, string][]) => pairs.map(([value, label]) => ({ value, label }));
const noPa = (c: Config) => !c.enable_pressure_advance;
const noOverhangFan = (c: Config) => !c.enable_overhang_bridge_fan;
const noSlow = (c: Config) => !c.slow_down_for_layer_cooling;
const noScarf = (c: Config) => c.filament_scarf_seam_type === 'none';

export const FILAMENT_PAGES = ['Filament', 'Cooling', 'Setting overrides', 'Advanced', 'Notes'] as const;

/** Printer retraction settings a filament may override (the "Setting overrides" page). */
export const FILAMENT_OVERRIDE_KEYS = [
  'retraction_length', 'z_hop', 'z_hop_types', 'retraction_speed', 'deretraction_speed', 'retract_restart_extra',
  'retraction_minimum_travel', 'retract_when_changing_layer', 'wipe', 'wipe_distance', 'retract_before_wipe',
];

export const FILAMENT_PARAMS: ParamDef[] = [
  // ---------------- Filament › Basic information
  { key: 'filament_type', label: 'Type', tab: 'Filament', group: 'Basic information', type: 'enum', def: 'PLA',
    options: opts(['PLA', 'PLA'], ['PETG', 'PETG'], ['ABS', 'ABS'], ['ASA', 'ASA'], ['TPU', 'TPU'], ['PA', 'PA'], ['PA-CF', 'PA-CF'], ['PET-CF', 'PET-CF'], ['PC', 'PC'], ['PVA', 'PVA'], ['HIPS', 'HIPS'], ['PLA-CF', 'PLA-CF'], ['Support', 'Support']),
    tip: 'Material family; shown as the badge on the filament slot.' },
  { key: 'filament_vendor', label: 'Vendor', tab: 'Filament', group: 'Basic information', type: 'string', def: 'Generic', tip: 'Manufacturer of the filament.' },
  { key: 'filament_soluble', label: 'Soluble material', tab: 'Filament', group: 'Basic information', type: 'bool', def: false, tip: 'Dissolves in water or another solvent (PVA, HIPS). Soluble support interfaces print with no Z gap.' },
  { key: 'filament_is_support', label: 'Support material', tab: 'Filament', group: 'Basic information', type: 'bool', def: false, tip: 'Breakaway or soluble support material. Used as an interface it prints with no Z gap.' },
  { key: 'filament_diameter', label: 'Diameter', tab: 'Filament', group: 'Basic information', type: 'float', unit: 'mm', min: 1, max: 3.5, step: 0.01, def: 1.75, tip: 'Filament diameter.' },
  { key: 'filament_flow_ratio', label: 'Flow ratio', tab: 'Filament', group: 'Basic information', type: 'float', min: 0.5, max: 1.5, step: 0.001, def: 0.98, tip: 'Material flow multiplier, found with the flow rate calibration.' },
  { key: 'enable_pressure_advance', label: 'Enable pressure advance', tab: 'Filament', group: 'Basic information', type: 'bool', def: false, tip: 'Send this filament\'s pressure advance value to the printer (M900 / SET_PRESSURE_ADVANCE).' },
  { key: 'pressure_advance', label: 'Pressure advance', tab: 'Filament', group: 'Basic information', type: 'float', min: 0, max: 2, step: 0.001, def: 0.02, disabledWhen: noPa, tip: 'K factor, found with the Flow Dynamics calibration.' },
  { key: 'adaptive_pressure_advance', label: 'Enable adaptive pressure advance (beta)', tab: 'Filament', group: 'Basic information', type: 'bool', def: false, disabledWhen: noPa, tip: 'Writes a pressure advance for each line type from the measurements below, by the flow and acceleration it is printed at. The value above stays the fallback.' },
  { key: 'adaptive_pressure_advance_overhangs', label: 'Enable adaptive pressure advance within features (beta)', tab: 'Filament', group: 'Basic information', type: 'bool', def: false, disabledWhen: (c) => noPa(c) || c.adaptive_pressure_advance !== true, tip: 'Also changes the pressure advance inside a line type when its flow changes (overhangs, line width changes). Not for printers that pause on a PA change.' },
  { key: 'adaptive_pressure_advance_bridges', label: 'Static pressure advance for bridges', tab: 'Filament', group: 'Basic information', type: 'float', min: 0, max: 2, step: 0.001, def: 0, disabledWhen: (c) => noPa(c) || c.adaptive_pressure_advance !== true, tip: 'Pressure advance for bridges. 0 = the same as other lines (adaptive).' },
  { key: 'adaptive_pressure_advance_model', label: 'Adaptive pressure advance measurements (beta)', tab: 'Filament', group: 'Basic information', type: 'text', def: '0,0,0\n0,0,0', disabledWhen: (c) => noPa(c) || c.adaptive_pressure_advance !== true, tip: 'One "PA,flow,acceleration" set per line, e.g. 0.04,3.96,3000 (PA found with the pressure advance test at that volumetric flow, mm³/s, and acceleration, mm/s²). At least two flows per acceleration.' },
  { key: 'filament_density', label: 'Density', tab: 'Filament', group: 'Basic information', type: 'float', unit: 'g/cm³', min: 0.5, max: 5, step: 0.01, def: 1.24, tip: 'Used for the weight estimate.' },
  { key: 'filament_cost', label: 'Price', tab: 'Filament', group: 'Basic information', type: 'float', unit: 'money/kg', min: 0, max: 1000, step: 0.5, def: 20, tip: 'Used for the cost estimate.' },
  { key: 'nozzle_temperature_range_low', label: 'Recommended nozzle temperature (min)', tab: 'Filament', group: 'Basic information', type: 'int', unit: '°C', min: 0, max: 500, def: 190, tip: 'Lowest recommended nozzle temperature; slicing warns below it.' },
  { key: 'nozzle_temperature_range_high', label: 'Recommended nozzle temperature (max)', tab: 'Filament', group: 'Basic information', type: 'int', unit: '°C', min: 0, max: 500, def: 240, tip: 'Highest recommended nozzle temperature; slicing warns above it.' },
  { key: 'filament_prime_volume', label: 'Filament prime volume', tab: 'Filament', group: 'Basic information', type: 'float', unit: 'mm³', min: 0, max: 1000, def: 45, tip: 'Volume primed on the prime tower after changing to this filament.' },

  // ---------------- Filament › Print temperature
  { key: 'chamber_temperatures', label: 'Chamber temperature', tab: 'Filament', group: 'Print temperature', type: 'int', unit: '°C', min: 0, max: 80, def: 0, tip: 'Heated or actively controlled chamber target (M141). 0 = not controlled.' },
  { key: 'chamber_minimal_temperature', label: 'Chamber minimal temperature', tab: 'Filament', group: 'Print temperature', type: 'int', unit: '°C', min: 0, max: 80, def: 0, tip: 'Chamber temperature at which printing may start while the chamber keeps heating. Writes no command: the start G-code reads it as [chamber_minimal_temperature].' },
  { key: 'activate_chamber_temp_control', label: 'Activate temperature control', tab: 'Filament', group: 'Print temperature', type: 'bool', def: true, tip: 'Writes the chamber temperature into the G-code (M141, and M191 to wait for it on firmware that supports it). Off leaves the chamber to the start G-code.' },
  { key: 'idle_temperature', label: 'Idle temperature', tab: 'Filament', group: 'Print temperature', type: 'int', unit: '°C', min: 0, max: 500, def: 0, tip: 'Tool changers with ooze prevention: the temperature a parked head with this filament waits at. 0 uses the standby temperature variation of the printer.' },
  { key: 'nozzle_temperature_initial_layer', label: 'Nozzle (initial layer)', tab: 'Filament', group: 'Print temperature', type: 'int', unit: '°C', min: 0, max: 500, def: 220, tip: 'Nozzle temperature for the first layer.' },
  { key: 'nozzle_temperature', label: 'Nozzle (other layers)', tab: 'Filament', group: 'Print temperature', type: 'int', unit: '°C', min: 0, max: 500, def: 220, tip: 'Nozzle temperature after the first layer.' },
  { key: 'cool_plate_temp_initial_layer', label: 'Cool Plate (initial layer)', tab: 'Filament', group: 'Print temperature', type: 'int', unit: '°C', min: 0, max: 120, def: 35, tip: 'Bed temperature on the Cool Plate, first layer. 0 = this filament does not stick to that plate.' },
  { key: 'cool_plate_temp', label: 'Cool Plate (other layers)', tab: 'Filament', group: 'Print temperature', type: 'int', unit: '°C', min: 0, max: 120, def: 35, tip: 'Bed temperature on the Cool Plate after the first layer.' },
  { key: 'eng_plate_temp_initial_layer', label: 'Engineering Plate (initial layer)', tab: 'Filament', group: 'Print temperature', type: 'int', unit: '°C', min: 0, max: 120, def: 55, tip: 'Bed temperature on the Engineering Plate, first layer.' },
  { key: 'eng_plate_temp', label: 'Engineering Plate (other layers)', tab: 'Filament', group: 'Print temperature', type: 'int', unit: '°C', min: 0, max: 120, def: 55, tip: 'Bed temperature on the Engineering Plate after the first layer.' },
  { key: 'hot_plate_temp_initial_layer', label: 'Smooth PEI / High Temp Plate (initial layer)', tab: 'Filament', group: 'Print temperature', type: 'int', unit: '°C', min: 0, max: 120, def: 55, tip: 'Bed temperature on the smooth PEI / High Temp Plate, first layer.' },
  { key: 'hot_plate_temp', label: 'Smooth PEI / High Temp Plate (other layers)', tab: 'Filament', group: 'Print temperature', type: 'int', unit: '°C', min: 0, max: 120, def: 55, tip: 'Bed temperature on the smooth PEI / High Temp Plate after the first layer.' },
  { key: 'textured_plate_temp_initial_layer', label: 'Textured PEI Plate (initial layer)', tab: 'Filament', group: 'Print temperature', type: 'int', unit: '°C', min: 0, max: 120, def: 55, tip: 'Bed temperature on the Textured PEI Plate, first layer.' },
  { key: 'textured_plate_temp', label: 'Textured PEI Plate (other layers)', tab: 'Filament', group: 'Print temperature', type: 'int', unit: '°C', min: 0, max: 120, def: 55, tip: 'Bed temperature on the Textured PEI Plate after the first layer.' },
  { key: 'supertack_plate_temp_initial_layer', label: 'Cool Plate SuperTack (initial layer)', tab: 'Filament', group: 'Print temperature', type: 'int', unit: '°C', min: 0, max: 120, def: 35, tip: 'Bed temperature on the Cool Plate SuperTack, first layer. 0 = this filament does not stick to that plate.' },
  { key: 'supertack_plate_temp', label: 'Cool Plate SuperTack (other layers)', tab: 'Filament', group: 'Print temperature', type: 'int', unit: '°C', min: 0, max: 120, def: 35, tip: 'Bed temperature on the Cool Plate SuperTack after the first layer.' },
  { key: 'textured_cool_plate_temp_initial_layer', label: 'Textured Cool Plate (initial layer)', tab: 'Filament', group: 'Print temperature', type: 'int', unit: '°C', min: 0, max: 120, def: 40, tip: 'Bed temperature on the Textured Cool Plate, first layer.' },
  { key: 'textured_cool_plate_temp', label: 'Textured Cool Plate (other layers)', tab: 'Filament', group: 'Print temperature', type: 'int', unit: '°C', min: 0, max: 120, def: 40, tip: 'Bed temperature on the Textured Cool Plate after the first layer.' },

  // ---------------- Filament › Volumetric speed limitation
  { key: 'filament_max_volumetric_speed', label: 'Max volumetric speed', tab: 'Filament', group: 'Volumetric speed limitation', type: 'float', unit: 'mm³/s', min: 0.5, max: 200, step: 0.5, def: 21, tip: 'Every move is slowed so that width × height × speed stays below this melt rate.' },
  { key: 'filament_shrink', label: 'Shrinkage (XY)', tab: 'Filament', group: 'Basic information', type: 'percent', unit: '%', min: 50, max: 150, def: 100, tip: 'Size the part keeps after cooling, as a percentage (94% if a 100 mm test measures 94 mm). The model is scaled up in X and Y to make up for it.' },
  { key: 'filament_shrinkage_compensation_z', label: 'Shrinkage (Z)', tab: 'Filament', group: 'Basic information', type: 'percent', unit: '%', min: 50, max: 150, def: 100, tip: 'Height the part keeps after cooling, as a percentage. The model is scaled up in Z to make up for it.' },

  // ---------------- Filament › Filament scarf seam settings
  { key: 'filament_scarf_seam_type', label: 'Scarf seam type', tab: 'Filament', group: 'Filament scarf seam settings', type: 'enum', def: 'none', options: opts(['none', 'None'], ['external', 'Contour'], ['all', 'Contour and hole']), tip: 'Scarf joint seam for this filament (used unless the process overrides it).' },
  { key: 'filament_scarf_height', label: 'Scarf start height', tab: 'Filament', group: 'Filament scarf seam settings', type: 'floatOrPercent', unit: 'mm/%', def: '10%', percentOf: 'layer_height', disabledWhen: noScarf, tip: 'Height the scarf ramp starts at.' },
  { key: 'filament_scarf_gap', label: 'Scarf slope gap', tab: 'Filament', group: 'Filament scarf seam settings', type: 'floatOrPercent', unit: 'mm/%', def: 0, percentOf: 'nozzle_diameter', disabledWhen: noScarf, tip: 'The overlapping end of the scarf stops this far short of the seam.' },
  { key: 'filament_scarf_length', label: 'Scarf length', tab: 'Filament', group: 'Filament scarf seam settings', type: 'float', unit: 'mm', min: 0, max: 100, def: 10, disabledWhen: noScarf, tip: 'Length of the scarf ramp.' },

  // ---------------- Cooling › Part cooling fan
  { key: 'close_fan_the_first_x_layers', label: 'No cooling for the first', tab: 'Cooling', group: 'Part cooling fan', type: 'int', unit: 'layers', min: 0, max: 1000, def: 1, tip: 'Number of first layers printed at the special first-layer fan speed (usually off) for bed adhesion.' },
  { key: 'first_x_layer_part_fan_speed', label: 'Fan speed for those layers', tab: 'Cooling', group: 'Part cooling fan', type: 'int', unit: '%', min: 0, max: 100, def: 0, tip: 'Part fan speed during the first layers above.' },
  { key: 'initial_layer_fan_speed', label: 'First layer fan speed', tab: 'Cooling', group: 'Part cooling fan', type: 'int', unit: '%', min: -1, max: 100, def: -1, tip: 'Exact part fan speed for the first layer, overriding every other cooling rule there (a little air keeps printed ducts cool over a hot bed). −1 = off.' },
  { key: 'full_fan_speed_layer', label: 'Full fan speed at layer', tab: 'Cooling', group: 'Part cooling fan', type: 'int', min: 0, max: 1000, def: 0, tip: 'Fan speed ramps up linearly from the first cooled layer to full speed at this layer. 0 = no ramp.' },
  { key: 'fan_min_speed', label: 'Min fan speed', tab: 'Cooling', group: 'Part cooling fan', type: 'int', unit: '%', min: 0, max: 100, def: 100, tip: 'Fan speed for layers that take as long as the layer time threshold below.' },
  { key: 'fan_cooling_layer_time', label: 'Min fan speed layer time', tab: 'Cooling', group: 'Part cooling fan', type: 'int', unit: 's', min: 0, max: 1000, def: 100, tip: 'Layers faster than this get more fan (up to the max speed); slower layers get the min speed, or no fan unless "Keep fan always on".' },
  { key: 'fan_max_speed', label: 'Max fan speed', tab: 'Cooling', group: 'Part cooling fan', type: 'int', unit: '%', min: 0, max: 100, def: 100, tip: 'Fan speed for layers shorter than the max fan speed layer time.' },
  { key: 'slow_down_layer_time', label: 'Max fan speed layer time', tab: 'Cooling', group: 'Part cooling fan', type: 'int', unit: 's', min: 0, max: 1000, def: 4, tip: 'Layers shorter than this run the fan at max speed and are slowed down to take this long.' },
  { key: 'reduce_fan_stop_start_freq', label: 'Keep fan always on', tab: 'Cooling', group: 'Part cooling fan', type: 'bool', def: true, tip: 'Never switch the fan off after the first layers; run at least the min speed.' },
  { key: 'slow_down_for_layer_cooling', label: 'Slow printing down for better layer cooling', tab: 'Cooling', group: 'Part cooling fan', type: 'bool', def: true, tip: 'Slow down layers that print faster than the max fan speed layer time.' },
  { key: 'no_slow_down_for_cooling_on_outwalls', label: 'Don\'t slow down outer walls', tab: 'Cooling', group: 'Part cooling fan', type: 'bool', def: false, disabledWhen: noSlow, tip: 'Keep outer walls at full speed while slowing down for cooling, for an even surface.' },
  { key: 'slow_down_min_speed', label: 'Min print speed', tab: 'Cooling', group: 'Part cooling fan', type: 'float', unit: 'mm/s', min: 0, max: 1000, def: 20, disabledWhen: noSlow, tip: 'Cooling slowdown never goes below this speed.' },
  { key: 'enable_overhang_bridge_fan', label: 'Force cooling for overhang and bridge', tab: 'Cooling', group: 'Part cooling fan', type: 'bool', def: true, tip: 'Run the fan at the overhang speed while printing bridges and overhanging walls.' },
  { key: 'overhang_fan_threshold', label: 'Cooling overhang threshold', tab: 'Cooling', group: 'Part cooling fan', type: 'enum', def: '25%', disabledWhen: noOverhangFan,
    options: opts(['0%', '0%'], ['10%', '10%'], ['25%', '25%'], ['50%', '50%'], ['75%', '75%'], ['95%', '95%']), tip: 'Walls overhanging by more than this percentage of their width get the overhang fan speed. 0% = every outer wall.' },
  { key: 'overhang_fan_speed', label: 'Fan speed for overhang', tab: 'Cooling', group: 'Part cooling fan', type: 'int', unit: '%', min: 0, max: 100, def: 100, disabledWhen: noOverhangFan, tip: 'Fan speed for bridges and overhanging walls.' },
  { key: 'internal_bridge_fan_speed', label: 'Internal bridges fan speed', tab: 'Cooling', group: 'Part cooling fan', type: 'int', unit: '%', min: -1, max: 100, def: -1, tip: 'Fan speed on internal bridges. −1 = the overhang / bridge fan settings.' },
  { key: 'ironing_fan_speed', label: 'Ironing fan speed', tab: 'Cooling', group: 'Part cooling fan', type: 'int', unit: '%', min: -1, max: 100, def: -1, tip: 'Fan speed while ironing. −1 = keep the layer\'s fan speed.' },
  { key: 'support_material_interface_fan_speed', label: 'Support interface fan speed', tab: 'Cooling', group: 'Part cooling fan', type: 'int', unit: '%', min: -1, max: 100, def: -1, tip: 'Part fan speed while printing support interfaces. More air there bonds the support less to the part, so it comes off more easily. −1 = keep the layer fan.' },
  // ---------------- Cooling › Auxiliary part cooling fan
  { key: 'close_additional_fan_first_x_layers', label: 'For the first', tab: 'Cooling', group: 'Auxiliary part cooling fan', type: 'int', unit: 'layers', min: 0, max: 1000, def: 1, tip: 'First layers use the special auxiliary fan speed.' },
  { key: 'first_x_layer_fan_speed', label: 'Fan speed for those layers', tab: 'Cooling', group: 'Auxiliary part cooling fan', type: 'int', unit: '%', min: 0, max: 100, def: 0, tip: 'Auxiliary fan speed for the first layers.' },
  { key: 'additional_fan_full_speed_layer', label: 'Full fan speed at layer', tab: 'Cooling', group: 'Auxiliary part cooling fan', type: 'int', min: 0, max: 1000, def: 0, tip: 'Auxiliary fan ramps up linearly to its speed at this layer. 0 = no ramp.' },
  { key: 'additional_cooling_fan_speed', label: 'Fan speed', tab: 'Cooling', group: 'Auxiliary part cooling fan', type: 'int', unit: '%', min: 0, max: 100, def: 0, tip: 'Auxiliary fan speed (M106 P2), on printers that have one.' },
  { key: 'activate_air_filtration', label: 'Activate air filtration', tab: 'Cooling', group: 'Exhaust fan', type: 'bool', def: false, tip: 'Runs the exhaust / filtration fan (M106 P3) for this filament, e.g. to vent ABS fumes.' },
  { key: 'activate_air_filtration_during_print', label: 'During print', tab: 'Cooling', group: 'Exhaust fan', type: 'bool', def: true, disabledWhen: (c) => c.activate_air_filtration !== true, tip: 'Exhaust fan on while printing.' },
  { key: 'during_print_exhaust_fan_speed', label: 'Fan speed (during print)', tab: 'Cooling', group: 'Exhaust fan', type: 'int', unit: '%', min: 0, max: 100, def: 60, disabledWhen: (c) => c.activate_air_filtration !== true, tip: 'Exhaust fan speed while printing (the highest of the filaments used).' },
  { key: 'activate_air_filtration_on_completion', label: 'After completion', tab: 'Cooling', group: 'Exhaust fan', type: 'bool', def: true, disabledWhen: (c) => c.activate_air_filtration !== true, tip: 'Exhaust fan on when the print has finished, before the end G-code.' },
  { key: 'complete_print_exhaust_fan_speed', label: 'Fan speed (after completion)', tab: 'Cooling', group: 'Exhaust fan', type: 'int', unit: '%', min: 0, max: 100, def: 80, disabledWhen: (c) => c.activate_air_filtration !== true, tip: 'Exhaust fan speed after the print.' },

  // ---------------- Setting overrides (nullable: unset = use the printer value)
  { key: 'filament_ironing_flow', label: 'Ironing flow', tab: 'Setting overrides', group: 'Ironing', type: 'percent', unit: '%', min: -1, max: 100, def: -1, tip: 'Overrides the process ironing flow for this filament. −1 = the process value.' },
  { key: 'filament_ironing_spacing', label: 'Ironing line spacing', tab: 'Setting overrides', group: 'Ironing', type: 'float', unit: 'mm', min: -1, max: 1, step: 0.01, def: -1, tip: 'Overrides the process ironing line spacing for this filament. −1 = the process value.' },
  { key: 'filament_ironing_inset', label: 'Ironing inset', tab: 'Setting overrides', group: 'Ironing', type: 'float', unit: 'mm', min: -1, max: 100, step: 0.05, def: -1, tip: 'Overrides the process ironing inset for this filament. −1 = the process value.' },
  { key: 'filament_ironing_speed', label: 'Ironing speed', tab: 'Setting overrides', group: 'Ironing', type: 'float', unit: 'mm/s', min: -1, max: 300, def: -1, tip: 'Overrides the process ironing speed for this filament. −1 = the process value.' },
  { key: 'filament_retraction_length', label: 'Length', tab: 'Setting overrides', group: 'Retraction', type: 'float', unit: 'mm', min: 0, max: 20, step: 0.1, def: 0.8, tip: 'Overrides the printer\'s retraction length for this filament.' },
  { key: 'filament_z_hop', label: 'Z hop when retract', tab: 'Setting overrides', group: 'Retraction', type: 'float', unit: 'mm', min: 0, max: 5, step: 0.05, def: 0.4, tip: 'Overrides the printer\'s Z hop.' },
  { key: 'filament_z_hop_types', label: 'Z hop type', tab: 'Setting overrides', group: 'Retraction', type: 'enum', def: 'normal', options: opts(['auto', 'Auto'], ['normal', 'Normal'], ['slope', 'Slope'], ['spiral', 'Spiral']), tip: 'Overrides the printer\'s Z hop type.' },
  { key: 'filament_retraction_speed', label: 'Retraction speed', tab: 'Setting overrides', group: 'Retraction', type: 'float', unit: 'mm/s', min: 1, max: 200, def: 30, tip: 'Overrides the printer\'s retraction speed.' },
  { key: 'filament_deretraction_speed', label: 'Deretraction speed', tab: 'Setting overrides', group: 'Retraction', type: 'float', unit: 'mm/s', min: 0, max: 200, def: 30, tip: 'Overrides the printer\'s deretraction speed.' },
  { key: 'filament_retract_restart_extra', label: 'Extra length on restart', tab: 'Setting overrides', group: 'Retraction', type: 'float', unit: 'mm', min: -5, max: 5, step: 0.01, def: 0, tip: 'Overrides the printer\'s extra restart length.' },
  { key: 'filament_retraction_minimum_travel', label: 'Travel distance threshold', tab: 'Setting overrides', group: 'Retraction', type: 'float', unit: 'mm', min: 0, max: 100, step: 0.1, def: 1, tip: 'Overrides the printer\'s travel threshold.' },
  { key: 'filament_retract_when_changing_layer', label: 'Retract when change layer', tab: 'Setting overrides', group: 'Retraction', type: 'bool', def: false, tip: 'Overrides the printer\'s setting.' },
  { key: 'filament_wipe', label: 'Wipe while retracting', tab: 'Setting overrides', group: 'Retraction', type: 'bool', def: false, tip: 'Overrides the printer\'s setting.' },
  { key: 'filament_wipe_distance', label: 'Wipe distance', tab: 'Setting overrides', group: 'Retraction', type: 'float', unit: 'mm', min: 0, max: 20, step: 0.1, def: 2, tip: 'Overrides the printer\'s wipe distance.' },
  { key: 'filament_retract_before_wipe', label: 'Retract amount before wipe', tab: 'Setting overrides', group: 'Retraction', type: 'percent', unit: '%', min: 0, max: 100, def: 100, tip: 'Overrides the printer\'s setting.' },

  // ---------------- Advanced
  { key: 'filament_start_gcode', label: 'Filament start G-code', tab: 'Advanced', group: 'Filament start G-code', type: 'text', def: '', tip: 'Run whenever this filament starts printing (start of the print and after changing to it).' },
  { key: 'filament_end_gcode', label: 'Filament end G-code', tab: 'Advanced', group: 'Filament end G-code', type: 'text', def: '', tip: 'Run when this filament stops printing (before changing away from it and at the end of the print).' },
  { key: 'filament_minimal_purge_on_wipe_tower', label: 'Minimal purge on wipe tower', tab: 'Advanced', group: 'Multimaterial', type: 'float', unit: 'mm³', min: 0, max: 1000, def: 15, tip: 'The purge on the prime tower after a change to this filament is never less than this, whatever is flushed into infill or objects.' },
  { key: 'filament_loading_speed_start', label: 'Loading speed at the start', tab: 'Advanced', group: 'Toolchange parameters with single extruder MM printers', type: 'float', unit: 'mm/s', min: 0, max: 200, def: 3, tip: 'Filament unit with ramming: speed of the first part of loading the filament back to the nozzle.' },
  { key: 'filament_loading_speed', label: 'Loading speed', tab: 'Advanced', group: 'Toolchange parameters with single extruder MM printers', type: 'float', unit: 'mm/s', min: 0, max: 200, def: 28, tip: 'Speed of the fast loading phase (the last tenth is loaded at a tenth of it).' },
  { key: 'filament_unloading_speed_start', label: 'Unloading speed at the start', tab: 'Advanced', group: 'Toolchange parameters with single extruder MM printers', type: 'float', unit: 'mm/s', min: 0, max: 200, def: 100, tip: 'Speed of the first 15 mm pulled back right after ramming.' },
  { key: 'filament_unloading_speed', label: 'Unloading speed', tab: 'Advanced', group: 'Toolchange parameters with single extruder MM printers', type: 'float', unit: 'mm/s', min: 0, max: 200, def: 90, tip: 'Speed of the pull into the cooling tube (slowing down towards its end).' },
  { key: 'filament_toolchange_delay', label: 'Delay after unloading', tab: 'Advanced', group: 'Toolchange parameters with single extruder MM printers', type: 'float', unit: 's', min: 0, max: 60, def: 0, tip: 'Wait (G4) with the filament in the cooling tube before it is parked, for flexible filaments that need time to shrink.' },
  { key: 'filament_cooling_moves', label: 'Number of cooling moves', tab: 'Advanced', group: 'Toolchange parameters with single extruder MM printers', type: 'int', min: 0, max: 20, def: 4, tip: 'The filament tip is moved up and down the cooling tube this many times to shape and cool it.' },
  { key: 'filament_cooling_initial_speed', label: 'Speed of the first cooling move', tab: 'Advanced', group: 'Toolchange parameters with single extruder MM printers', type: 'float', unit: 'mm/s', min: 0, max: 200, def: 2.2, tip: 'Cooling moves speed up from this…' },
  { key: 'filament_cooling_final_speed', label: 'Speed of the last cooling move', tab: 'Advanced', group: 'Toolchange parameters with single extruder MM printers', type: 'float', unit: 'mm/s', min: 0, max: 200, def: 3.4, tip: '…to this speed.' },
  { key: 'filament_stamping_loading_speed', label: 'Stamping loading speed', tab: 'Advanced', group: 'Toolchange parameters with single extruder MM printers', type: 'float', unit: 'mm/s', min: 0, max: 200, def: 0, tip: 'Speed of the stamping push between cooling moves.' },
  { key: 'filament_stamping_distance', label: 'Stamping distance measured from the center of the cooling tube', tab: 'Advanced', group: 'Toolchange parameters with single extruder MM printers', type: 'float', unit: 'mm', min: 0, max: 200, def: 0, tip: 'Between cooling moves the filament is pushed down this far (from the middle of the cooling tube) and pulled back, to flatten the tip. 0 = no stamping.' },
  { key: 'filament_ramming_parameters', label: 'Ramming parameters', tab: 'Advanced', group: 'Toolchange parameters with single extruder MM printers', type: 'string', def: '120 100 6.6 6.8 7.2 7.6 7.9 8.2 8.7 9.4 9.9 10.0| 0.05 6.6 0.45 6.8 0.95 7.8 1.45 8.3 1.95 9.7 2.45 10 2.95 7.6 3.45 7.6 3.95 7.6 4.45 7.6 4.95 7.6', tip: 'Ramming before the filament is unloaded: line width %, row step %, then the volumetric speed (mm³/s) of each 0.25 s step. The part after | is kept for the ramming dialog.' },
  { key: 'filament_multitool_ramming', label: 'Enable ramming for multi-tool setups', tab: 'Advanced', group: 'Toolchange parameters with multi extruder MM printers', type: 'bool', def: false, tip: 'Tool changers: a short ramming on the prime tower before this head is parked.' },
  { key: 'filament_multitool_ramming_volume', label: 'Multi-tool ramming volume', tab: 'Advanced', group: 'Toolchange parameters with multi extruder MM printers', type: 'float', unit: 'mm³', min: 0, max: 1000, def: 10, disabledWhen: (c) => c.filament_multitool_ramming !== true, tip: 'Volume rammed before the head is parked.' },
  { key: 'filament_multitool_ramming_flow', label: 'Multi-tool ramming flow', tab: 'Advanced', group: 'Toolchange parameters with multi extruder MM printers', type: 'float', unit: 'mm³/s', min: 0, max: 100, def: 10, disabledWhen: (c) => c.filament_multitool_ramming !== true, tip: 'Flow of that ramming.' },
  { key: 'filament_change_extrusion_role_gcode', label: 'Change extrusion role G-code', tab: 'Advanced', group: 'Change extrusion role G-code', type: 'text', def: '', tip: 'Inserted after the printer\'s change extrusion role G-code every time the line type changes while this filament prints. Placeholders: [extrusion_role], [last_extrusion_role], [layer_num], [layer_z].' },
  // ---------------- Notes
  { key: 'filament_notes', label: 'Filament notes', tab: 'Notes', group: 'Notes', type: 'text', def: '', tip: 'Free text kept with the filament settings and written into the G-code config block.' },
];
/** Keys only meaningful when the user sets them (Setting overrides page). */
export const NULLABLE_FILAMENT_KEYS = new Set(FILAMENT_OVERRIDE_KEYS.map((k) => `filament_${k}`));

/** Cooling and temperature defaults by material, from generic filament profiles. */
const BY_TYPE: Record<string, Config> = {
  PLA: { nozzle_temperature_range_low: 190, nozzle_temperature_range_high: 240, fan_cooling_layer_time: 100, reduce_fan_stop_start_freq: true, overhang_fan_threshold: '50%', additional_cooling_fan_speed: 70 },
  PETG: { nozzle_temperature_range_low: 220, nozzle_temperature_range_high: 260, fan_cooling_layer_time: 30, reduce_fan_stop_start_freq: true, overhang_fan_threshold: '10%', overhang_fan_speed: 90, additional_cooling_fan_speed: 0 },
  ABS: { nozzle_temperature_range_low: 240, nozzle_temperature_range_high: 270, fan_cooling_layer_time: 30, reduce_fan_stop_start_freq: false, overhang_fan_threshold: '25%', overhang_fan_speed: 80, close_fan_the_first_x_layers: 3, additional_cooling_fan_speed: 0 },
  ASA: { nozzle_temperature_range_low: 240, nozzle_temperature_range_high: 270, fan_cooling_layer_time: 35, reduce_fan_stop_start_freq: false, overhang_fan_threshold: '25%', overhang_fan_speed: 80, additional_cooling_fan_speed: 0 },
  TPU: { nozzle_temperature_range_low: 200, nozzle_temperature_range_high: 250, fan_cooling_layer_time: 100, reduce_fan_stop_start_freq: true, overhang_fan_threshold: '95%', additional_cooling_fan_speed: 70 },
};

/** Full filament config of a profile, with a slot's user overrides on top. */
export function filamentConfig(f: FilamentProfile, overrides: Config = {}): Config {
  const base: Config = Object.fromEntries(FILAMENT_PARAMS.filter((p) => !NULLABLE_FILAMENT_KEYS.has(p.key)).map((p) => [p.key, p.def]));
  const bed = (t: keyof FilamentProfile['bedTemp']) => f.bedTemp[t] ?? 0;
  const superTack = f.bedTemp.supertack_plate ?? (bed('cool_plate') || bed('engineering_plate'));
  const texCool = f.bedTemp.textured_cool_plate ?? (bed('cool_plate') > 0 ? Math.max(40, bed('cool_plate')) : 0);
  const fromProfile: Config = {
    filament_type: f.type, filament_diameter: f.diameter, filament_density: f.density, filament_cost: f.cost, filament_flow_ratio: f.flowRatio,
    nozzle_temperature: f.nozzleTemp, nozzle_temperature_initial_layer: f.nozzleTempInitial,
    cool_plate_temp: bed('cool_plate'), cool_plate_temp_initial_layer: bed('cool_plate'), eng_plate_temp: bed('engineering_plate'), eng_plate_temp_initial_layer: bed('engineering_plate'),
    hot_plate_temp: bed('high_temp_plate'), hot_plate_temp_initial_layer: bed('high_temp_plate'), textured_plate_temp: bed('textured_pei_plate'), textured_plate_temp_initial_layer: bed('textured_pei_plate'),
    // SuperTack / Textured Cool Plate: the profile's own value, else from the Cool Plate (SuperTack also holds what needs an engineering plate)
    supertack_plate_temp: superTack, supertack_plate_temp_initial_layer: superTack, textured_cool_plate_temp: texCool, textured_cool_plate_temp_initial_layer: texCool,
    fan_min_speed: f.fanMin, fan_max_speed: f.fanMax, close_fan_the_first_x_layers: f.fanOffFirstLayers, slow_down_layer_time: f.slowDownLayerTime,
    slow_down_min_speed: f.slowDownMinSpeed, filament_max_volumetric_speed: f.maxVolumetricSpeed,
    ...(f.retractionLength !== undefined ? { filament_retraction_length: f.retractionLength } : {}),
  };
  return { ...base, ...(BY_TYPE[f.type] ?? {}), ...fromProfile, ...(f.settings ?? {}), ...overrides };
}

/** Bed temperature keys of a plate type. */
export const PLATE_TEMP_KEYS: Record<string, [string, string]> = {
  cool_plate: ['cool_plate_temp_initial_layer', 'cool_plate_temp'],
  engineering_plate: ['eng_plate_temp_initial_layer', 'eng_plate_temp'],
  high_temp_plate: ['hot_plate_temp_initial_layer', 'hot_plate_temp'],
  textured_pei_plate: ['textured_plate_temp_initial_layer', 'textured_plate_temp'],
  supertack_plate: ['supertack_plate_temp_initial_layer', 'supertack_plate_temp'],
  textured_cool_plate: ['textured_cool_plate_temp_initial_layer', 'textured_cool_plate_temp'],
};
