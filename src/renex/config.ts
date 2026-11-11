// Print settings Renex reads from the active NexSpiro process profile, so rendered surfaces match the print.
import { currentConfig } from '../state/slicing';
import { useStore } from '../state/store';
import { defaultPrintSettings, type PrintSettings, type SeamMode } from './printSurface';

const num = (v: unknown, ref: number, def: number) => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') { const n = parseFloat(v); if (Number.isFinite(n)) return v.trim().endsWith('%') ? (n / 100) * ref : n; }
  return def;
};

export function printSettingsFromConfig(): PrintSettings {
  const d = defaultPrintSettings();
  try {
    const c = currentConfig() as Record<string, unknown>;
    const nozzle = num(c.nozzle_diameter, 0.4, 0.4);
    const lh = num(c.layer_height, nozzle, d.layerHeight);
    return {
      layerHeight: lh,
      firstLayerHeight: num(c.initial_layer_print_height, nozzle, lh),
      lineWidth: num(c.outer_wall_line_width, nozzle, num(c.line_width, nozzle, nozzle * 1.05)) || nozzle * 1.05,
      seam: (['aligned', 'back', 'nearest', 'random'].includes(String(c.seam_position)) ? c.seam_position : 'aligned') as SeamMode,
      supports: c.enable_support ? 'attached' : 'off',
      supportAngle: num(c.support_threshold_angle, 1, 30) || 30,
      texturedBed: useStore.getState().plate === 'textured_pei_plate',
    };
  } catch { return d; }
}
