// Machine / filament / process profiles. Every machine-specific value lives here, never in the engine.

export type Firmware = "klipper" | "marlin" | "bbl";

export interface MachineProfile {
  id: string; name: string; firmware: Firmware;
  bed: { x: number; y: number; z: number };
  nozzle: number;
  maxSpeed: { x: number; y: number; z: number; e: number };       // mm/s
  maxAccel: { x: number; y: number; z: number; e: number };       // mm/s²
  maxJerk: { x: number; y: number; z: number; e: number };        // mm/s (square-corner velocity on Klipper)
  maxVolumetricFlow: number;                                       // mm³/s
}

export interface FilamentProfile {
  id: string; name: string; diameter: number; density: number; nozzleTemp: number; bedTemp: number;
  maxVolumetricFlow: number;
}

export interface ProcessProfile {
  id: string; name: string;
  layerHeight: number; firstLayerHeight: number; lineWidth: number;
  wallSpeed: number; firstLayerSpeed: number; travelSpeed: number;
  walls: number;
  retractLength: number; retractSpeed: number;
}

export const MACHINES: MachineProfile[] = [
  {
    id: "x1c-hotend", name: "Bambu Lab X1 Carbon 0.4", firmware: "bbl",
    bed: { x: 256, y: 256, z: 256 }, nozzle: 0.4,
    maxSpeed: { x: 500, y: 500, z: 20, e: 30 }, maxAccel: { x: 20000, y: 20000, z: 500, e: 5000 },
    maxJerk: { x: 9, y: 9, z: 3, e: 2.5 }, maxVolumetricFlow: 32,
  },
  {
    id: "voron-24-350", name: "Voron 2.4 350 (Klipper)", firmware: "klipper",
    bed: { x: 350, y: 350, z: 340 }, nozzle: 0.4,
    maxSpeed: { x: 500, y: 500, z: 30, e: 60 }, maxAccel: { x: 10000, y: 10000, z: 350, e: 5000 },
    maxJerk: { x: 8, y: 8, z: 0.4, e: 2.5 }, maxVolumetricFlow: 24,
  },
  {
    id: "prusa-mk3s", name: "Prusa MK3S+ (Marlin)", firmware: "marlin",
    bed: { x: 250, y: 210, z: 210 }, nozzle: 0.4,
    maxSpeed: { x: 200, y: 200, z: 12, e: 120 }, maxAccel: { x: 1250, y: 1250, z: 200, e: 5000 },
    maxJerk: { x: 8, y: 8, z: 0.4, e: 4.5 }, maxVolumetricFlow: 15,
  },
];

export const FILAMENTS: FilamentProfile[] = [
  { id: "generic-pla", name: "Generic PLA", diameter: 1.75, density: 1.24, nozzleTemp: 215, bedTemp: 60, maxVolumetricFlow: 21 },
  { id: "generic-petg", name: "Generic PETG", diameter: 1.75, density: 1.27, nozzleTemp: 240, bedTemp: 75, maxVolumetricFlow: 12 },
];

export const PROCESSES: ProcessProfile[] = [
  { id: "std-020", name: "0.20mm Standard", layerHeight: 0.2, firstLayerHeight: 0.2, lineWidth: 0.45, wallSpeed: 60, firstLayerSpeed: 25, travelSpeed: 200, walls: 2, retractLength: 0.8, retractSpeed: 35 },
  { id: "tex-030", name: "0.30mm Texture Wall", layerHeight: 0.3, firstLayerHeight: 0.25, lineWidth: 0.5, wallSpeed: 30, firstLayerSpeed: 20, travelSpeed: 200, walls: 1, retractLength: 0.8, retractSpeed: 35 },
];

export interface PrintProfiles { machine: MachineProfile; filament: FilamentProfile; process: ProcessProfile }
