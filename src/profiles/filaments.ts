// Filament profiles (material defaults). Bed temperatures are per plate type.
import type { PlateType } from './printers';
import type { Config } from './settings';

export interface FilamentProfile {
  id: string;
  name: string;
  type: string;
  color: string;
  diameter: number; // mm
  density: number; // g/cm³
  cost: number; // per kg
  nozzleTemp: number;
  nozzleTempInitial: number;
  bedTemp: Partial<Record<PlateType, number>>; // 0 = not supported
  fanMin: number; // %
  fanMax: number; // %
  fanOffFirstLayers: number;
  slowDownLayerTime: number; // s
  slowDownMinSpeed: number; // mm/s
  maxVolumetricSpeed: number; // mm³/s
  flowRatio: number;
  retractionLength?: number; // overrides printer when set
  /** Any other filament setting (see filamentParams.ts) that differs from the material defaults. */
  settings?: Config;
}

export const FILAMENTS: FilamentProfile[] = [
  { id: 'generic-pla', name: 'Generic PLA', type: 'PLA', color: '#5DBE7A', diameter: 1.75, density: 1.24, cost: 20,
    nozzleTemp: 220, nozzleTempInitial: 220, bedTemp: { cool_plate: 35, engineering_plate: 55, high_temp_plate: 55, textured_pei_plate: 55 },
    fanMin: 100, fanMax: 100, fanOffFirstLayers: 1, slowDownLayerTime: 4, slowDownMinSpeed: 20, maxVolumetricSpeed: 21, flowRatio: 0.98 },
  { id: 'generic-pla-matte', name: 'Generic PLA Matte', type: 'PLA', color: '#E9D8C8', diameter: 1.75, density: 1.32, cost: 22,
    nozzleTemp: 220, nozzleTempInitial: 220, bedTemp: { cool_plate: 35, engineering_plate: 55, high_temp_plate: 55, textured_pei_plate: 55 },
    fanMin: 100, fanMax: 100, fanOffFirstLayers: 1, slowDownLayerTime: 4, slowDownMinSpeed: 20, maxVolumetricSpeed: 22, flowRatio: 0.98 },
  { id: 'generic-petg', name: 'Generic PETG', type: 'PETG', color: '#85A3B2', diameter: 1.75, density: 1.27, cost: 22,
    nozzleTemp: 250, nozzleTempInitial: 250, bedTemp: { cool_plate: 0, engineering_plate: 70, high_temp_plate: 70, textured_pei_plate: 70 },
    fanMin: 30, fanMax: 60, fanOffFirstLayers: 3, slowDownLayerTime: 8, slowDownMinSpeed: 20, maxVolumetricSpeed: 12, flowRatio: 0.95 },
  { id: 'generic-abs', name: 'Generic ABS', type: 'ABS', color: '#FF5C8D', diameter: 1.75, density: 1.04, cost: 20,
    nozzleTemp: 260, nozzleTempInitial: 260, bedTemp: { cool_plate: 0, engineering_plate: 90, high_temp_plate: 90, textured_pei_plate: 90 },
    fanMin: 10, fanMax: 40, fanOffFirstLayers: 3, slowDownLayerTime: 12, slowDownMinSpeed: 20, maxVolumetricSpeed: 16, flowRatio: 0.95 },
  { id: 'generic-asa', name: 'Generic ASA', type: 'ASA', color: '#732553', diameter: 1.75, density: 1.07, cost: 25,
    nozzleTemp: 260, nozzleTempInitial: 260, bedTemp: { cool_plate: 0, engineering_plate: 90, high_temp_plate: 90, textured_pei_plate: 90 },
    fanMin: 10, fanMax: 40, fanOffFirstLayers: 3, slowDownLayerTime: 12, slowDownMinSpeed: 20, maxVolumetricSpeed: 16, flowRatio: 0.95 },
  { id: 'generic-tpu', name: 'Generic TPU 95A', type: 'TPU', color: '#1E3442', diameter: 1.75, density: 1.21, cost: 30,
    nozzleTemp: 230, nozzleTempInitial: 230, bedTemp: { cool_plate: 30, engineering_plate: 35, high_temp_plate: 35, textured_pei_plate: 35 },
    fanMin: 100, fanMax: 100, fanOffFirstLayers: 1, slowDownLayerTime: 8, slowDownMinSpeed: 10, maxVolumetricSpeed: 3.6, flowRatio: 1, retractionLength: 0.4 },
  // foaming PLA: expands up to ~2.8× when printed hot (Advanced foam control schedules the temperature)
  { id: 'generic-lw-pla', name: 'Generic LW-PLA (foaming)', type: 'LW-PLA', color: '#D9D2C5', diameter: 1.75, density: 1.24, cost: 45,
    nozzleTemp: 230, nozzleTempInitial: 230, bedTemp: { cool_plate: 35, engineering_plate: 55, high_temp_plate: 55, textured_pei_plate: 55 },
    fanMin: 30, fanMax: 60, fanOffFirstLayers: 1, slowDownLayerTime: 6, slowDownMinSpeed: 20, maxVolumetricSpeed: 12, flowRatio: 1, retractionLength: 0.4 },
];

export const filamentById = (id: string) => FILAMENTS.find((f) => f.id === id) ?? FILAMENTS[0];
