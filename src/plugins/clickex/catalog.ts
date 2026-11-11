// Clickex reference data: switch families, base shapes and the colour palette.
// Dimensions are nominal datasheet / community values (mm). Switch heights are measured from the TOP of the
// mounting plate. Nominal values differ a little between makers, so the Switch tab can override the two
// heights and Fit can add tolerance; print the fit test before a long print.
import { circlePath, smooth, toPath, type XY } from './geom';
import type { Paths } from '../../engine/types';

export interface SwitchSpec {
  id: string;
  name: string;
  /** Square hole the switch clips into. */
  cutout: number;
  /** Plate thickness the clips are made for. */
  plate: number;
  /** Top housing width (the flange resting on the plate). */
  flange: number;
  /** Clip width under the plate (the space the well must have). */
  clipSpan: number;
  /** Bottom of the housing below the top of the plate. */
  belowPlate: number;
  /** Pins / centre post under the housing. */
  pins: number;
  /** Top of the housing above the plate. */
  housingTop: number;
  /** Stem top above the plate, at rest. */
  stemTop: number;
  /** Cross stem arm length and arm width (what the button's socket must hold). */
  armLen: number;
  armWid: number;
  /** Round collar of the stem that the button boss must slide into. */
  collarD: number;
  note: string;
}

export const SWITCHES: SwitchSpec[] = [
  {
    id: 'mx', name: 'MX-style (Cherry MX, Gateron, Kailh, Outemu …)', cutout: 14, plate: 1.5, flange: 15.6, clipSpan: 15.2,
    belowPlate: 5, pins: 3.3, housingTop: 6.6, stemTop: 10.2, armLen: 4, armWid: 1.35, collarD: 5.5,
    note: 'Clicky switches (Kailh Box Jade/Navy, Blue-style) give the loudest click; tactile ones are quieter.',
  },
];

export const switchById = (id: string): SwitchSpec => SWITCHES.find((s) => s.id === id) ?? SWITCHES[0];

// ---------------------------------------------------------------- base shapes
export interface BaseShapeDef { id: string; name: string; ring(): XY[] }

const poly = (n: number, r: number, rot = -Math.PI / 2): XY[] => Array.from({ length: n }, (_, i) => { const a = rot + (i / n) * Math.PI * 2; return [r * Math.cos(a), r * Math.sin(a)] as XY; });
const star = (n: number, ro: number, ri: number): XY[] => Array.from({ length: n * 2 }, (_, i) => { const a = -Math.PI / 2 + (i / (n * 2)) * Math.PI * 2, r = i % 2 ? ri : ro; return [r * Math.cos(a), r * Math.sin(a)] as XY; });
const polar = (n: number, f: (a: number) => number): XY[] => Array.from({ length: n }, (_, i) => { const a = (i / n) * Math.PI * 2, r = f(a); return [r * Math.cos(a), r * Math.sin(a)] as XY; });

/** Unit shapes: bounding box about 1 × 1, centred. */
export const BASE_SHAPES: BaseShapeDef[] = [
  { id: 'circle', name: 'Circle', ring: () => polar(96, () => 0.5) },
  { id: 'square', name: 'Square', ring: () => [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]] },
  { id: 'squircle', name: 'Squircle', ring: () => polar(120, (a) => 0.5 / Math.pow(Math.abs(Math.cos(a)) ** 4 + Math.abs(Math.sin(a)) ** 4, 0.25)) },
  { id: 'pill', name: 'Pill', ring: () => { const o: XY[] = []; for (let i = 0; i <= 24; i++) { const a = -Math.PI / 2 + (i / 24) * Math.PI; o.push([0.2 + 0.3 * Math.cos(a), 0.3 * Math.sin(a)]); } for (let i = 0; i <= 24; i++) { const a = Math.PI / 2 + (i / 24) * Math.PI; o.push([-0.2 + 0.3 * Math.cos(a), 0.3 * Math.sin(a)]); } return o; } },
  { id: 'hexagon', name: 'Hexagon', ring: () => poly(6, 0.5, 0) },
  { id: 'octagon', name: 'Octagon', ring: () => poly(8, 0.5, Math.PI / 8) },
  { id: 'diamond', name: 'Diamond', ring: () => [[0, -0.5], [0.5, 0], [0, 0.5], [-0.5, 0]] },
  { id: 'triangle', name: 'Triangle', ring: () => poly(3, 0.5) },
  { id: 'heart', name: 'Heart', ring: () => Array.from({ length: 160 }, (_, i) => { const t = (i / 160) * Math.PI * 2; return [(16 * Math.sin(t) ** 3) / 34, (13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t) + 2.5) / 34] as XY; }) },
  { id: 'star', name: 'Star', ring: () => star(5, 0.5, 0.23) },
  { id: 'badge', name: 'Badge', ring: () => star(12, 0.5, 0.44) },
  { id: 'shield', name: 'Shield', ring: () => { const o: XY[] = [[-0.45, 0.5], [0.45, 0.5]]; for (let i = 0; i <= 24; i++) { const t = i / 24; o.push([0.45 * Math.cos(t * Math.PI / 2) ** 0.9, -0.5 * Math.sin(t * Math.PI / 2) ** 1.6]); } for (let i = 24; i >= 0; i--) { const t = i / 24; o.push([-0.45 * Math.cos(t * Math.PI / 2) ** 0.9, -0.5 * Math.sin(t * Math.PI / 2) ** 1.6]); } return o; } },
  { id: 'drop', name: 'Drop', ring: () => polar(120, (a) => { const k = Math.sin(a - Math.PI / 2); return 0.34 + 0.16 * Math.max(0, k) ** 3 * 2.2; }).map(([x, y]) => [x, y + 0.02] as XY) },
  { id: 'flower', name: 'Flower', ring: () => polar(160, (a) => 0.38 + 0.12 * Math.cos(5 * a)) },
  { id: 'gear', name: 'Gear', ring: () => polar(160, (a) => { const k = Math.cos(10 * a); return k > 0.2 ? 0.5 : k < -0.2 ? 0.42 : 0.46 + (k * 0.04) / 0.2; }) },
  { id: 'cloud', name: 'Cloud', ring: () => polar(200, (a) => 0.34 + 0.1 * Math.abs(Math.sin(3.5 * a)) ** 0.7) },
];

export const baseShapeById = (id: string) => BASE_SHAPES.find((s) => s.id === id) ?? BASE_SHAPES[0];

/** A base shape as paths, its largest side = size mm, corners rounded by `round` mm. */
export function baseShapePaths(id: string, size: number, round = 0): Paths {
  const ring = baseShapeById(id).ring();
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of ring) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  const k = size / Math.max(x1 - x0, y1 - y0), cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const p: Paths = [toPath(ring.map(([x, y]) => [(x - cx) * k, (y - cy) * k] as XY))];
  return smooth(p, round);
}

// ---------------------------------------------------------------- colours
export const COLOR_PALETTE = ['#ffffff', '#e9e5dc', '#2f2f33', '#e85d4a', '#f28c28', '#f2c14e', '#5dbe7a', '#3d7ddb', '#9b59b6', '#ff5c8d', '#8c8c8c', '#7a4b2b'];

export { circlePath };
