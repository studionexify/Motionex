// Machine capability model. Every Advanced technology asks this model what the selected printer can
// physically do (axes, kinematics, firmware features, head clearance, flow, chamber) and adapts itself:
// it runs as designed, runs in a reduced form, or reports why it cannot run on this machine.
import { printerById } from '../../profiles/printers';
import type { Config } from '../../profiles/settings';
import { changerOf } from '../../profiles/changer';
import { defaultToolhead, type ToolheadProfile } from '../../plugins/motionex/core/toolhead';
import type { Kinematics, MachineOverrides } from './types';

export interface MachineCaps {
  printerId: string;
  name: string;
  firmware: 'bbl' | 'klipper' | 'marlin';
  kinematics: Kinematics;
  /** 3 for gantry printers; 5 for machines with two rotary axes. */
  axes: number;
  bed: { x: number; y: number; z: number };
  nozzle: number;
  maxSpeedXY: number;
  maxAccelXY: number;
  maxSpeedZ: number;
  maxAccelZ: number;
  /** Klipper square-corner velocity / Marlin junction speed equivalent (mm/s). */
  cornerVelocity: number;
  inputShaper: boolean;
  pressureAdvance: boolean;
  arcs: boolean;
  /** Frame resonance per axis (Hz) and damping ratio, used by the resonance-aware planner. */
  resonance: { x: number; y: number; zeta: number };
  /** Hotend melt limit (mm³/s). */
  maxFlow: number;
  enclosed: boolean;
  heatedChamber: boolean;
  chamberTemp: number;
  /** Automatic filament changes (AMS), a tool changer, manual swaps, or one material only. */
  multiMaterial: 'ams' | 'toolchanger' | 'manual';
  continuousFiber: boolean;
  /** Part-fan response time (s): how fast a fan change reaches the plastic. */
  fanLag: number;
  /** Hotend heating time constant (s), for temperature look-ahead. */
  heaterTau: number;
  toolhead: ToolheadProfile;
  /** Steepest surface the nozzle can follow before the heater block or duct reaches printed plastic (deg). */
  maxSlopeDeg: number;
  /** Largest height change (mm) within the heater block's footprint. */
  maxNonPlanarDepth: number;
  rotaryA?: [number, number];
  rotaryC?: boolean;
  notes: string[];
}

interface Spec {
  kinematics: Kinematics; inputShaper: boolean; pressureAdvance: boolean; arcs: boolean;
  maxAccelZ: number; maxFlow: number; enclosed: boolean; heatedChamber: boolean; chamberTemp?: number;
  resonance: [number, number]; cornerVelocity?: number;
}

/** What the printer profiles do not say: kinematics, firmware features, flow, chamber, resonance. */
const SPECS: Record<string, Spec> = {
  'bbl-x1c': { kinematics: 'corexy', inputShaper: true, pressureAdvance: true, arcs: true, maxAccelZ: 500, maxFlow: 32, enclosed: true, heatedChamber: false, resonance: [62, 52] },
  'bbl-x1e': { kinematics: 'corexy', inputShaper: true, pressureAdvance: true, arcs: true, maxAccelZ: 500, maxFlow: 32, enclosed: true, heatedChamber: true, chamberTemp: 60, resonance: [62, 52] },
  'bbl-p1s': { kinematics: 'corexy', inputShaper: true, pressureAdvance: true, arcs: true, maxAccelZ: 500, maxFlow: 32, enclosed: true, heatedChamber: false, resonance: [58, 48] },
  'bbl-p1p': { kinematics: 'corexy', inputShaper: true, pressureAdvance: true, arcs: true, maxAccelZ: 500, maxFlow: 32, enclosed: false, heatedChamber: false, resonance: [58, 48] },
  'bbl-a1': { kinematics: 'bedslinger', inputShaper: true, pressureAdvance: true, arcs: true, maxAccelZ: 1500, maxFlow: 28, enclosed: false, heatedChamber: false, resonance: [55, 38] },
  'bbl-a1mini': { kinematics: 'bedslinger', inputShaper: true, pressureAdvance: true, arcs: true, maxAccelZ: 1500, maxFlow: 28, enclosed: false, heatedChamber: false, resonance: [60, 45] },
  'bbl-h2d': { kinematics: 'corexy', inputShaper: true, pressureAdvance: true, arcs: true, maxAccelZ: 500, maxFlow: 40, enclosed: true, heatedChamber: true, chamberTemp: 65, resonance: [60, 50] },
  'creality-k2plus': { kinematics: 'corexy', inputShaper: true, pressureAdvance: true, arcs: true, maxAccelZ: 500, maxFlow: 32, enclosed: true, heatedChamber: true, chamberTemp: 60, resonance: [55, 45] },
  'qidi-xplus3': { kinematics: 'corexy', inputShaper: true, pressureAdvance: true, arcs: true, maxAccelZ: 500, maxFlow: 32, enclosed: true, heatedChamber: true, chamberTemp: 65, resonance: [55, 45] },
  'qidi-xmax3': { kinematics: 'corexy', inputShaper: true, pressureAdvance: true, arcs: true, maxAccelZ: 500, maxFlow: 32, enclosed: true, heatedChamber: true, chamberTemp: 65, resonance: [50, 42] },
  'qidi-q1pro': { kinematics: 'corexy', inputShaper: true, pressureAdvance: true, arcs: true, maxAccelZ: 500, maxFlow: 32, enclosed: true, heatedChamber: true, chamberTemp: 60, resonance: [58, 48] },
  'prusa-mk4s': { kinematics: 'bedslinger', inputShaper: true, pressureAdvance: true, arcs: true, maxAccelZ: 200, maxFlow: 20, enclosed: false, heatedChamber: false, resonance: [50, 40], cornerVelocity: 8 },
  'prusa-coreone': { kinematics: 'corexy', inputShaper: true, pressureAdvance: true, arcs: true, maxAccelZ: 200, maxFlow: 25, enclosed: true, heatedChamber: false, resonance: [60, 55], cornerVelocity: 8 },
  'prusa-xl': { kinematics: 'corexy', inputShaper: true, pressureAdvance: true, arcs: true, maxAccelZ: 200, maxFlow: 25, enclosed: false, heatedChamber: false, resonance: [45, 40], cornerVelocity: 8 },
  'prusa-mk3s': { kinematics: 'bedslinger', inputShaper: false, pressureAdvance: true, arcs: true, maxAccelZ: 200, maxFlow: 12, enclosed: false, heatedChamber: false, resonance: [40, 32], cornerVelocity: 8 },
  'prusa-mini': { kinematics: 'bedslinger', inputShaper: true, pressureAdvance: true, arcs: true, maxAccelZ: 200, maxFlow: 12, enclosed: false, heatedChamber: false, resonance: [50, 40], cornerVelocity: 8 },
};

const enclosedIds = new Set(['creality-k1', 'creality-k1c', 'creality-k1max', 'voron-24-350', 'voron-trident-300', 'voron-02', 'sovol-sv08', 'elegoo-centauri']);

function defaultSpec(printerId: string, flavor: string): Spec {
  const known = SPECS[printerId];
  if (known) return known;
  const enclosed = enclosedIds.has(printerId);
  if (flavor === 'klipper') {
    const corexy = /voron|k1|k2|qidi|sv08|centauri/.test(printerId);
    return { kinematics: corexy ? 'corexy' : 'bedslinger', inputShaper: true, pressureAdvance: true, arcs: true, maxAccelZ: corexy ? 350 : 500, maxFlow: 24, enclosed, heatedChamber: false, resonance: corexy ? [55, 45] : [45, 35] };
  }
  // Marlin machines: most stock firmwares have neither input shaping nor linear advance enabled
  const modern = /kobra3|v3se/.test(printerId);
  return { kinematics: 'bedslinger', inputShaper: modern, pressureAdvance: false, arcs: true, maxAccelZ: 100, maxFlow: 12, enclosed, heatedChamber: false, resonance: [38, 30], cornerVelocity: 8 };
}

/** Steepest slope the head can ride: the heater block's lowest edge must stay above material rising at that slope. */
export function clearanceSlope(head: ToolheadProfile, halfWidthOverride?: number, tipOverride?: number): { maxSlopeDeg: number; depth: number } {
  const tip = tipOverride ?? head.nozzle.tip_len;
  // A surface rising at slope θ in direction d is tanθ·(p·d) above the tip at offset p. The worst
  // direction reaches the farthest point of each volume's footprint, so that distance sets the limit.
  let half = Infinity;
  for (const v of head.volumes) {
    if (v.offset[2] > 20) continue;
    const reach = v.shape === 'box'
      ? Math.hypot(Math.abs(v.offset[0]) + v.dims[0] / 2, Math.abs(v.offset[1]) + v.dims[1] / 2)
      : Math.hypot(v.offset[0], v.offset[1]) + v.dims[0];
    const s = Math.atan2(Math.max(v.offset[2] - head.margin, 0.05), reach);
    half = Math.min(half, s);
  }
  if (halfWidthOverride) half = Math.min(half, Math.atan2(Math.max(tip - head.margin, 0.05), halfWidthOverride));
  // the nozzle cone itself: a slope steeper than 90° − cone half-angle touches the cone
  const cone = (Math.PI / 2) - (head.nozzle.cone_angle_deg * Math.PI) / 180;
  const ang = Math.min(half, cone);
  return { maxSlopeDeg: (ang * 180) / Math.PI, depth: Math.max(0, tip - head.margin) };
}

/** Capabilities of the selected printer, with the user's overrides applied. */
export function machineCaps(printerId: string, cfg: Config, ov: MachineOverrides = {}): MachineCaps {
  const p = printerById(printerId);
  const spec = defaultSpec(p.id, p.flavor);
  const num = (k: string, d: number) => (typeof cfg[k] === 'number' && Number.isFinite(cfg[k] as number) ? (cfg[k] as number) : d);
  const head = defaultToolhead(p.id);
  if (ov.tipLength) {
    // a longer nozzle lifts the whole head above the tip
    const dz = ov.tipLength - head.nozzle.tip_len;
    head.nozzle.tip_len = ov.tipLength;
    for (const v of head.volumes) v.offset = [v.offset[0], v.offset[1], v.offset[2] + dz];
  }
  const cl = clearanceSlope(head, ov.heaterHalfWidth, ov.tipLength);
  const axes = ov.axes ?? (ov.kinematics?.startsWith('five_axis') ? 5 : 3);
  const kin: Kinematics = ov.kinematics ?? spec.kinematics;
  const notes: string[] = [];
  if (!(ov.inputShaper ?? spec.inputShaper)) notes.push('No firmware input shaping: the slicer shapes motion itself.');
  if (!(ov.pressureAdvance ?? spec.pressureAdvance)) notes.push('No pressure advance: corner flow is compensated in the toolpath.');
  if (axes >= 5) notes.push('Rotary axes available: curved layers are not limited by the head clearance.');
  else notes.push(`Curved layers limited to ${cl.maxSlopeDeg.toFixed(0)}° by the heater block (${head.name}).`);
  const heated = ov.heatedChamber ?? spec.heatedChamber;
  return {
    printerId: p.id,
    name: `${p.vendor} ${p.model}`,
    firmware: p.flavor,
    kinematics: kin,
    axes,
    bed: { ...p.bed },
    nozzle: p.nozzle,
    maxSpeedXY: num('max_speed_xy', 300),
    maxAccelXY: num('max_acceleration', 5000),
    maxSpeedZ: num('max_speed_z', 10),
    maxAccelZ: ov.maxAccelZ ?? spec.maxAccelZ,
    cornerVelocity: spec.cornerVelocity ?? (p.flavor === 'marlin' ? 8 : 5),
    inputShaper: ov.inputShaper ?? spec.inputShaper,
    pressureAdvance: ov.pressureAdvance ?? spec.pressureAdvance,
    arcs: spec.arcs,
    resonance: { x: ov.resonanceX ?? spec.resonance[0], y: ov.resonanceY ?? spec.resonance[1], zeta: 0.08 },
    maxFlow: ov.maxFlow ?? spec.maxFlow,
    enclosed: spec.enclosed || heated,
    heatedChamber: heated,
    chamberTemp: heated ? (ov.chamberTemp ?? spec.chamberTemp ?? 50) : spec.enclosed ? 35 : 25,
    multiMaterial: changerOf(cfg),
    continuousFiber: ov.continuousFiber ?? false,
    fanLag: 0.12,
    heaterTau: p.vendor === 'Bambu Lab' ? 4 : 6,
    toolhead: head,
    maxSlopeDeg: axes >= 5 ? 75 : cl.maxSlopeDeg,
    maxNonPlanarDepth: axes >= 5 ? 50 : cl.depth,
    rotaryA: ov.rotaryA,
    rotaryC: ov.rotaryC,
    notes,
  };
}
