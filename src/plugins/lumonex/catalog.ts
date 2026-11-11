// Lumonex reference data: lamp holders, bulbs (preview only), cables, switches, batteries, pipe sizes,
// magnets, fasteners and the Numakers filament palette from the Lumonex 2026 catalogue.
// Dimensions are nominal datasheet values; the fit clearance setting is added on top.

export interface Holder {
  id: string; name: string;
  /** Hole the holder's threaded skirt / shade ring passes through (mm). */
  ringHole: number;
  /** Outer diameter of the holder body (mm). */
  body: number;
  /** Body length below the shade ring, cord end (mm). */
  length: number;
  /** Height of the lamp socket above the shade ring (mm). */
  above: number;
  /** Bulb families that fit. */
  bulbs: string[];
  /** Mounting: shade ring through a gallery, a spring-clip cup, or a flat pad/puck. */
  mount: 'ring' | 'cup' | 'pad' | 'strip';
  note?: string;
}

export const HOLDERS: Holder[] = [
  { id: 'e27', name: 'E27 Edison (EU/IN)', ringHole: 40.5, body: 40, length: 55, above: 20, bulbs: ['a60', 'g45', 'g80', 'g95', 'g125', 'st64', 't45', 'p45-e27', 'a19'], mount: 'ring', note: 'Threaded shade ring Ø ~44 mm clamps the gallery.' },
  { id: 'e26', name: 'E26 Edison (US)', ringHole: 40.5, body: 39, length: 55, above: 20, bulbs: ['a19', 'g45', 'g80', 'g95', 'st64', 't45'], mount: 'ring', note: 'Uno ring fitter; same gallery hole as E27.' },
  { id: 'e14', name: 'E14 small Edison', ringHole: 29, body: 29, length: 45, above: 17, bulbs: ['c35', 'p45', 'g45-e14'], mount: 'ring' },
  { id: 'e12', name: 'E12 candelabra', ringHole: 22, body: 21, length: 40, above: 15, bulbs: ['c35-e12', 'c32'], mount: 'ring' },
  { id: 'b22', name: 'B22 bayonet', ringHole: 29.5, body: 36, length: 50, above: 18, bulbs: ['a60', 'g45', 'g95'], mount: 'ring' },
  { id: 'b15', name: 'B15 small bayonet', ringHole: 22, body: 25, length: 40, above: 14, bulbs: ['c35', 'p45'], mount: 'ring' },
  { id: 'gu10', name: 'GU10 spot', ringHole: 35.5, body: 30, length: 30, above: 6, bulbs: ['gu10'], mount: 'cup', note: 'Spot sits in a Ø50 cup held by a spring clip.' },
  { id: 'mr16', name: 'GU5.3 / MR16 (12 V)', ringHole: 35.5, body: 20, length: 25, above: 6, bulbs: ['mr16'], mount: 'cup' },
  { id: 'g9', name: 'G9 capsule', ringHole: 25, body: 22, length: 32, above: 8, bulbs: ['g9'], mount: 'ring' },
  { id: 'puck', name: 'LED puck / COB disc', ringHole: 0, body: 60, length: 10, above: 0, bulbs: ['puck60', 'puck45', 'puck30'], mount: 'pad' },
  { id: 'strip', name: 'LED strip (spiral on core)', ringHole: 0, body: 30, length: 0, above: 0, bulbs: ['strip'], mount: 'strip', note: 'Strip is wound on a printed core; set core diameter.' },
  { id: 'battery', name: 'Battery LED module', ringHole: 0, body: 40, length: 8, above: 0, bulbs: ['puck30', 'puck45', 'tealight'], mount: 'pad' },
];

export interface Bulb {
  id: string; name: string;
  /** [radius, z] profile from the bottom of the cap (mm). */
  profile: [number, number][];
  /** Typical LED power (W). */
  watts: number;
}

const globe = (d: number, cap: number, capD = 27): [number, number][] => {
  const r = d / 2, a0 = -Math.acos(Math.min(0.99, (capD / 2 + 2) / r)), zc = cap + 2 - r * Math.sin(a0);
  const pts: [number, number][] = [[capD / 2, 0], [capD / 2, cap]];
  for (let i = 0; i <= 16; i++) { const a = a0 + ((Math.PI / 2 - a0) * i) / 16; pts.push([Math.max(0.5, r * Math.cos(a)), zc + r * Math.sin(a)]); }
  return pts;
};
const aShape = (d: number, L: number, capD = 27): [number, number][] => {
  const r = d / 2, cap = 25;
  return [[capD / 2, 0], [capD / 2, cap], [capD / 2 + 3, cap + 8], [r * 0.85, L - r * 1.25], [r, L - r], [r * 0.87, L - r * 0.5], [r * 0.5, L - r * 0.13], [0.5, L]];
};
const tube = (d: number, L: number, capD = 27, cap = 25): [number, number][] => [[capD / 2, 0], [capD / 2, cap], [d / 2, cap + 6], [d / 2, L - d / 3], [d / 3, L - 3], [0.5, L]];

export const BULBS: Bulb[] = [
  { id: 'a60', name: 'A60 standard (Ø60×108)', profile: aShape(60, 108), watts: 9 },
  { id: 'a19', name: 'A19 standard (Ø60×112)', profile: aShape(60, 112, 26), watts: 9 },
  { id: 'g45', name: 'G45 golf ball (Ø45×78)', profile: globe(45, 22), watts: 4 },
  { id: 'g45-e14', name: 'G45 E14 (Ø45×75)', profile: globe(45, 20, 14), watts: 4 },
  { id: 'g80', name: 'G80 globe (Ø80×120)', profile: globe(80, 25), watts: 6 },
  { id: 'g95', name: 'G95 globe (Ø95×135)', profile: globe(95, 25), watts: 8 },
  { id: 'g125', name: 'G125 globe (Ø125×175)', profile: globe(125, 30), watts: 8 },
  { id: 'st64', name: 'ST64 Edison filament (Ø64×140)', profile: aShape(64, 140), watts: 6 },
  { id: 't45', name: 'T45 tube (Ø45×110)', profile: tube(45, 110), watts: 5 },
  { id: 'p45', name: 'P45 E14 (Ø45×80)', profile: globe(45, 22, 14), watts: 5 },
  { id: 'p45-e27', name: 'P45 E27 (Ø45×80)', profile: globe(45, 22), watts: 5 },
  { id: 'c35', name: 'C35 candle E14 (Ø35×98)', profile: tube(35, 98, 14, 20), watts: 4 },
  { id: 'c35-e12', name: 'C35 candle E12 (Ø35×98)', profile: tube(35, 98, 12, 20), watts: 4 },
  { id: 'c32', name: 'C32 candelabra (Ø32×90)', profile: tube(32, 90, 12, 20), watts: 3 },
  { id: 'gu10', name: 'GU10 spot (Ø50×55)', profile: [[18, 0], [18, 14], [25, 50], [25, 55], [0.5, 55]], watts: 5 },
  { id: 'mr16', name: 'MR16 spot (Ø50×46)', profile: [[6, 0], [6, 10], [25, 42], [25, 46], [0.5, 46]], watts: 5 },
  { id: 'g9', name: 'G9 capsule (Ø16×50)', profile: tube(16, 50, 10, 12), watts: 3 },
  { id: 'puck60', name: 'LED puck Ø60×10', profile: [[30, 0], [30, 10], [0.5, 10]], watts: 5 },
  { id: 'puck45', name: 'LED puck Ø45×9', profile: [[22.5, 0], [22.5, 9], [0.5, 9]], watts: 3 },
  { id: 'puck30', name: 'LED puck Ø30×7', profile: [[15, 0], [15, 7], [0.5, 7]], watts: 1 },
  { id: 'tealight', name: 'LED tealight Ø38×16', profile: [[19, 0], [19, 16], [0.5, 16]], watts: 0.5 },
  { id: 'strip', name: 'LED strip on core (Ø30)', profile: [[15, 0], [15, 100], [0.5, 100]], watts: 6 },
];

export const bulbById = (id: string) => BULBS.find((b) => b.id === id) ?? BULBS[0];
export const holderById = (id: string) => HOLDERS.find((h) => h.id === id) ?? HOLDERS[0];
/** Largest radius of a bulb. */
export const bulbRadius = (b: Bulb) => Math.max(...b.profile.map((p) => p[0]));
export const bulbLength = (b: Bulb) => Math.max(...b.profile.map((p) => p[1]));

export interface Cable { id: string; name: string; d: number }
export const CABLES: Cable[] = [
  { id: 'round2', name: '2-core round 2×0.5 (Ø5)', d: 5 },
  { id: 'round3', name: '3-core round 3×0.75 (Ø6.5)', d: 6.5 },
  { id: 'fabric', name: 'Fabric braided (Ø7)', d: 7 },
  { id: 'flat', name: 'Flat twin (6×3.5)', d: 6 },
  { id: 'thin', name: 'Low-voltage pair 22 AWG (Ø2.5)', d: 2.5 },
  { id: 'usb', name: 'USB-C cable (Ø4)', d: 4 },
];

export interface SwitchKind { id: string; name: string; shape: 'rect' | 'round' | 'none'; w: number; h: number; depth: number }
export const SWITCHES: SwitchKind[] = [
  { id: 'inline', name: 'Inline cord switch (no cut-out)', shape: 'none', w: 0, h: 0, depth: 0 },
  { id: 'rocker-s', name: 'Rocker KCD1 19×13', shape: 'rect', w: 19.2, h: 13.2, depth: 20 },
  { id: 'rocker-l', name: 'Rocker KCD3 21×15', shape: 'rect', w: 21.2, h: 15.2, depth: 24 },
  { id: 'push12', name: 'Push button Ø12', shape: 'round', w: 12.2, h: 12.2, depth: 18 },
  { id: 'push16', name: 'Push button Ø16', shape: 'round', w: 16.2, h: 16.2, depth: 22 },
  { id: 'push19', name: 'Push button Ø19', shape: 'round', w: 19.2, h: 19.2, depth: 24 },
  { id: 'toggle', name: 'Toggle Ø6 bushing', shape: 'round', w: 6.4, h: 6.4, depth: 22 },
  { id: 'slide', name: 'Slide switch SS12 (8.6×4)', shape: 'rect', w: 9, h: 4.4, depth: 8 },
  { id: 'rotary', name: 'Rotary dimmer pot Ø7 (shaft)', shape: 'round', w: 7.2, h: 7.2, depth: 15 },
  { id: 'touch', name: 'Touch dimmer pad (Ø14 pocket)', shape: 'round', w: 14, h: 14, depth: 3 },
  { id: 'usbc', name: 'USB-C charge port (9.2×3.6)', shape: 'rect', w: 9.6, h: 4, depth: 10 },
];

export interface Battery { id: string; name: string; /** pocket: length, width, height (mm) */ l: number; w: number; h: number; cells: number }
export const BATTERIES: Battery[] = [
  { id: 'none', name: 'No battery (mains)', l: 0, w: 0, h: 0, cells: 0 },
  { id: '18650x1', name: '18650 ×1 holder', l: 77, w: 21, h: 20, cells: 1 },
  { id: '18650x2', name: '18650 ×2 holder', l: 77, w: 41, h: 20, cells: 2 },
  { id: '21700x1', name: '21700 ×1 holder', l: 80, w: 24, h: 23, cells: 1 },
  { id: 'aa3', name: 'AA ×3 box', l: 58, w: 47, h: 16, cells: 3 },
  { id: 'aa4', name: 'AA ×4 box', l: 63, w: 58, h: 16, cells: 4 },
  { id: 'aaa3', name: 'AAA ×3 box', l: 50, w: 37, h: 13, cells: 3 },
  { id: 'cr2032', name: 'CR2032 holder', l: 25, w: 22, h: 6, cells: 1 },
  { id: 'lipo', name: 'LiPo pouch 2000 mAh + TP4056', l: 62, w: 36, h: 10, cells: 1 },
];

/** Common pipe / handlebar outer diameters (mm). */
export const PIPES: { name: string; d: number }[] = [
  { name: 'Bicycle bar clamp 22.2', d: 22.2 }, { name: 'Bicycle oversize 25.4', d: 25.4 }, { name: 'Road / MTB 31.8', d: 31.8 },
  { name: 'MTB 35.0', d: 35 }, { name: 'Motorcycle 7/8" (22)', d: 22 }, { name: 'Motorcycle fat bar 28.6', d: 28.6 },
  { name: 'E-scooter stem 34', d: 34 }, { name: 'Roll bar / ATV 38', d: 38 }, { name: 'Roll cage / roof rack 42.4', d: 42.4 },
  { name: 'Tent / camping pole 16', d: 16 }, { name: 'Conduit 20', d: 20 }, { name: 'Railing 48.3', d: 48.3 },
];

export const MAGNETS: { name: string; d: number; h: number }[] = [
  { name: '6×3', d: 6, h: 3 }, { name: '8×3', d: 8, h: 3 }, { name: '10×3', d: 10, h: 3 }, { name: '10×5', d: 10, h: 5 }, { name: '12×4', d: 12, h: 4 },
];

/** Metric bolts: clearance hole, nut across flats, nut height, heat-set insert hole. */
export const BOLTS: Record<string, { hole: number; nutAF: number; nutH: number; insert: number; insertL: number }> = {
  M3: { hole: 3.4, nutAF: 5.6, nutH: 2.6, insert: 4.0, insertL: 5.7 },
  M4: { hole: 4.4, nutAF: 7.1, nutH: 3.3, insert: 5.6, insertL: 8.1 },
  M5: { hole: 5.4, nutAF: 8.1, nutH: 4.1, insert: 6.4, insertL: 9.5 },
  M6: { hole: 6.5, nutAF: 10.1, nutH: 5.2, insert: 8.0, insertL: 12.7 },
};

// ---------------------------------------------------------------- filaments (Numakers palette)
export type MaterialKind = 'PETG Translucent' | 'PLA Matte' | 'PLA+' | 'PLA Stone' | 'PLA Wood' | 'PLA Silk';
export interface Swatch { material: MaterialKind; name: string; hex: string }

const sw = (material: MaterialKind, list: [string, string][]): Swatch[] => list.map(([name, hex]) => ({ material, name, hex }));
export const PALETTE: Swatch[] = [
  ...sw('PETG Translucent', [['Arctic', '#e8edf0'], ['Ice Blue', '#bcdce8'], ['Blue', '#5487e0'], ['Pink', '#f4b8d3'], ['Hot Pink', '#ec6ea6'], ['Red', '#e05a5a'], ['Orange', '#f2a654'], ['Green', '#7fcf72'], ['Yellow', '#f5da4c']]),
  ...sw('PLA Matte', [['Beige', '#d9c3a0'], ['Skin', '#ebc8b0'], ['Moon Gray', '#babcbe'], ['Olive', '#6d7a3a'], ['Mint Green', '#9fdbb8'], ['Ice Blue', '#bfe0ef'], ['Navy Blue', '#1f2a48'], ['Lilac Purple', '#c6aee3'], ['Sakura Pink', '#f3bccb'], ['Ruby Red', '#a3192f'], ['Sunshine Yellow', '#f6c843'], ['White', '#f5f5f3'], ['Black', '#1c1c1c']]),
  ...sw('PLA+', [['Terracotta Orange', '#c8663f'], ['Rust Copper', '#9a4a2d'], ['Teal Blue', '#1f7f86'], ['Apricot', '#f4b98d'], ['Army Green', '#4b5626'], ['Ivory', '#f1ead8'], ['Khaki', '#8b8559'], ['Lagoon', '#2ea8cf'], ['Outrageous Orange', '#ff6b1a'], ['Grass Green', '#3fae49']]),
  ...sw('PLA Stone', [['White', '#e7e6e2']]),
  ...sw('PLA Wood', [['Natural', '#c9a37a']]),
  ...sw('PLA Silk', [['Silk Silver', '#c9ccd0'], ['Silk Antique Gold', '#b8953f'], ['Silk Copper', '#b8703e'], ['Silk Black', '#2a2a2a']]),
];

/** A section's swatch: `name` is a palette colour name, or a filament colour (#rrggbb) taken from a filament slot. */
export const swatch = (material: string, name: string): Swatch =>
  /^#[0-9a-f]{6}$/i.test(name) ? { material: (material as MaterialKind), name, hex: name }
    : PALETTE.find((s) => s.material === material && s.name === name) ?? PALETTE.find((s) => s.name === name) ?? PALETTE[0];

/** Lumonex material for a filament preset (keeps the PLA finish the part already has). */
export function materialForPreset(presetId: string, current: MaterialKind): MaterialKind {
  if (presetId === 'generic-petg') return 'PETG Translucent';
  if (presetId === 'generic-pla-matte') return 'PLA Matte';
  if (presetId === 'generic-pla') return current === 'PLA Matte' || current === 'PETG Translucent' ? 'PLA+' : current;
  return 'PLA+';
}

/** Softening points and the closest a bulb may come to the wall (LED, mm) per material family. */
export const THERMAL: Record<MaterialKind, { softens: number; minGap: number; maxWatts: number }> = {
  'PETG Translucent': { softens: 75, minGap: 20, maxWatts: 9 },
  'PLA Matte': { softens: 55, minGap: 25, maxWatts: 9 },
  'PLA+': { softens: 58, minGap: 25, maxWatts: 9 },
  'PLA Stone': { softens: 55, minGap: 25, maxWatts: 9 },
  'PLA Wood': { softens: 55, minGap: 30, maxWatts: 7 },
  'PLA Silk': { softens: 55, minGap: 25, maxWatts: 9 },
};
