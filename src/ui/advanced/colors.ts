// Colours for the Zone Inspector: one categorical colour per zone, a perceptual sequential ramp for
// magnitudes (thickness, stress, harmonic potential) and a diverging ramp for signed curvature.
import type { FieldId, ZoneKind } from '../../engine/advanced/types';
import { ZONE_KINDS } from '../../engine/advanced/types';

export const ZONE_COLORS: Record<ZoneKind, string> = {
  plain: '#8A99A6',
  dome: '#4FC3F7',
  shallow: '#A5D8F3',
  curved_wall: '#9575CD',
  overhang: '#FF5A5F',
  neck: '#FFAB00',
  boss: '#FF7043',
  helical: '#5DBE7A',
  core: '#26A69A',
  thin: '#F06292',
  interface: '#FFD54F',
  branch: '#B0BEC5',
};

export const ZONE_LABELS: Record<ZoneKind, string> = {
  plain: 'Plain', dome: 'Domes', shallow: 'Shallow slopes', curved_wall: 'Curved walls', overhang: 'Overhangs', neck: 'High-stress necks',
  boss: 'Bosses / holes', helical: 'Helical zones', core: 'Quasicrystal cores', thin: 'Thin walls', interface: 'Material interfaces', branch: 'Branches',
};

export const FIELD_LABELS: Record<FieldId, string> = {
  zones: 'Zones', thickness: 'Thickness', curvature: 'Curvature', overhang: 'Overhang', stress: 'Stress', harmonic: 'Harmonic φ', branch: 'Branches',
};
export const FIELD_UNITS: Partial<Record<FieldId, string>> = { thickness: 'mm', curvature: '1/mm', overhang: '°', stress: 'MPa' };

const hex = (c: string): [number, number, number] => [parseInt(c.slice(1, 3), 16) / 255, parseInt(c.slice(3, 5), 16) / 255, parseInt(c.slice(5, 7), 16) / 255];
export const ZONE_RGB = ZONE_KINDS.map((k) => hex(ZONE_COLORS[k]));

// viridis, sampled at 6 stops (perceptually uniform, colour-blind safe)
const SEQ: [number, number, number][] = [[0.267, 0.005, 0.329], [0.254, 0.265, 0.53], [0.164, 0.471, 0.558], [0.135, 0.659, 0.518], [0.478, 0.821, 0.318], [0.993, 0.906, 0.144]];
// blue – neutral – red for signed values
const DIV: [number, number, number][] = [[0.13, 0.4, 0.67], [0.57, 0.77, 0.87], [0.93, 0.93, 0.93], [0.96, 0.65, 0.51], [0.7, 0.09, 0.17]];

function ramp(stops: [number, number, number][], t: number): [number, number, number] {
  const x = Math.max(0, Math.min(1, t)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x)), f = x - i;
  const a = stops[i], b = stops[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

/** Colour of one value of a field, given the field's display range. */
export function fieldColor(field: FieldId, v: number, range: [number, number]): [number, number, number] {
  if (field === 'zones') return ZONE_RGB[Math.max(0, Math.min(ZONE_RGB.length - 1, Math.round(v)))];
  if (field === 'curvature') {
    const m = Math.max(Math.abs(range[0]), Math.abs(range[1]), 1e-9);
    return ramp(DIV, 0.5 + 0.5 * (v / m));
  }
  const [a, b] = range;
  return ramp(SEQ, b > a ? (v - a) / (b - a) : 0.5);
}

/** CSS gradient of a field's colour scale, for the legend. */
export function legendGradient(field: FieldId): string {
  const stops = field === 'curvature' ? DIV : SEQ;
  return `linear-gradient(90deg, ${stops.map((c, i) => `rgb(${c.map((x) => Math.round(x * 255)).join(',')}) ${(i / (stops.length - 1)) * 100}%`).join(', ')})`;
}
