// Machine fit: tolerances worked out from the selected printer's nozzle and the layer height.
// Print-in-place joints live on the clearance, so it follows the nozzle (0.4 mm → 0.30 mm gaps).
import { printerById, type PrinterProfile } from '../../profiles/printers';
import { autoChanges } from '../../profiles/changer';

export interface Fit {
  nozzle: number;
  layer: number;
  /** Air gap around every moving part (mm). */
  clearance: number;
  /** Distance between the faces of two neighbouring pieces at the joint centre (mm). */
  gap: number;
  /** Thinnest wall worth printing around a joint (mm). */
  wall: number;
  /** Smallest pin / neck radius that still prints solid (mm). */
  minPin: number;
}

/** nozzle: the nozzle actually fitted (the project's nozzle setting), else the printer's default. */
export interface FitOverrides { clearance?: number; gap?: number; layer?: number; nozzle?: number }

export function fitFor(nozzle: number, o: FitOverrides = {}): Fit {
  const layer = o.layer ?? Math.min(0.2, nozzle * 0.5);
  const clearance = o.clearance && o.clearance > 0 ? o.clearance : Math.min(0.5, Math.max(0.18, 0.5 * nozzle + 0.1));
  const gap = o.gap && o.gap > 0 ? o.gap : Math.max(0.35, +(clearance * 1.6).toFixed(2));
  return { nozzle, layer, clearance, gap, wall: Math.max(1.2, nozzle * 3), minPin: Math.max(1.0, nozzle * 2.2) };
}

export interface MachineInfo {
  printer: PrinterProfile;
  bed: { x: number; y: number; z: number };
  nozzle: number;
  /** Colours one print can carry without a manual swap (AMS slots, or 1). */
  colours: number;
  multiColour: 'ams' | 'manual';
  fit: Fit;
}

export function machineFor(printerId: string, o: FitOverrides = {}): MachineInfo {
  const printer = printerById(printerId);
  const ams = autoChanges(printer.machine);
  return {
    printer, bed: printer.bed, nozzle: o.nozzle && o.nozzle > 0 ? o.nozzle : printer.nozzle,
    colours: ams ? 16 : 1, multiColour: ams ? 'ams' : 'manual',
    fit: fitFor(o.nozzle && o.nozzle > 0 ? o.nozzle : printer.nozzle, o),
  };
}
