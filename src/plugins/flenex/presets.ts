// Flenex catalogue: creature presets are only data (body shape, add-ons, segment rules), so every one of
// them can be changed in the Studio and new designs follow the same patterns.
import { addOn, defaultBody, defaultSegments, type AddOn, type AddOnKind, type BodySpec, type CreatureDesign, type SegmentSpec } from './design';
import { defaultJoint, type JointKind } from './joints';

export const PROFILES: Record<string, { name: string; handles: number[] }> = {
  snake: { name: 'Snake', handles: [0.62, 0.85, 1, 1, 1, 0.95, 0.85, 0.6, 0.22] },
  worm: { name: 'Worm', handles: [0.9, 1, 1, 1, 1, 1, 1, 0.95, 0.6] },
  eel: { name: 'Eel', handles: [0.7, 0.9, 1, 1, 1, 0.95, 0.85, 0.7, 0.3] },
  dragon: { name: 'Dragon', handles: [0.85, 0.8, 0.95, 1.1, 1.1, 1, 0.8, 0.5, 0.15] },
  fish: { name: 'Fish', handles: [0.6, 0.95, 1.2, 1.25, 1.1, 0.85, 0.5, 0.28, 0.2] },
  shark: { name: 'Shark', handles: [0.5, 0.9, 1.25, 1.3, 1.1, 0.8, 0.5, 0.3, 0.25] },
  tadpole: { name: 'Tadpole', handles: [1.1, 1.3, 1.1, 0.8, 0.55, 0.4, 0.3, 0.25, 0.15] },
  lizard: { name: 'Lizard', handles: [0.9, 0.8, 1, 1.05, 1, 0.9, 0.7, 0.45, 0.15] },
  croc: { name: 'Crocodile', handles: [0.8, 0.85, 1, 1.1, 1.1, 1, 0.8, 0.5, 0.15] },
  whale: { name: 'Whale', handles: [0.8, 1.15, 1.35, 1.3, 1.05, 0.7, 0.45, 0.3, 0.25] },
  spindle: { name: 'Spindle', handles: [0.3, 0.7, 0.95, 1, 1, 0.95, 0.7, 0.4, 0.1] },
  club: { name: 'Club tail', handles: [0.9, 0.9, 1, 1, 0.9, 0.7, 0.5, 0.45, 0.8] },
  bar: { name: 'Even bar', handles: [1, 1, 1, 1, 1, 1, 1, 1, 1] },
  carrot: { name: 'Carrot', handles: [1.2, 1.15, 1.05, 0.95, 0.8, 0.65, 0.5, 0.35, 0.15] },
  seahorse: { name: 'Seahorse', handles: [0.7, 0.8, 1.2, 1.3, 1.1, 0.8, 0.55, 0.4, 0.25] },
  mantle: { name: 'Mantle (octopus)', handles: [0.45, 0.9, 1.1, 1.05, 0.85, 0.55, 0.3, 0.14, 0.06] },
  frog: { name: 'Frog', handles: [0.7, 1.05, 1.25, 1.2, 1.0, 0.65, 0.35, 0.18, 0.08] },
  trex: { name: 'Big-headed', handles: [1.0, 1.15, 0.95, 0.9, 1.1, 1.2, 1.0, 0.6, 0.2] },
  caterpillar: { name: 'Caterpillar', handles: [1.1, 0.95, 1, 1, 1, 1, 0.95, 0.85, 0.6] },
};

export interface PresetDef {
  id: string;
  name: string;
  family: string;
  profile: string;
  body?: Partial<Omit<BodySpec, 'spine' | 'section' | 'relief'>> & { spine?: Partial<BodySpec['spine']>; section?: Partial<BodySpec['section']>; relief?: Partial<BodySpec['relief']> };
  addons?: [AddOnKind, Partial<AddOn>][];
  seg?: Partial<SegmentSpec> & { kind?: JointKind };
}

export const FAMILIES = ['Snake', 'Dragon', 'Sea', 'Reptile', 'Bug', 'Land', 'Fantasy', 'Basic'] as const;

const P = (id: string, name: string, family: string, profile: string, body: PresetDef['body'], addons: PresetDef['addons'], seg?: PresetDef['seg']): PresetDef => ({ id, name, family, profile, body, addons, seg });

export const PRESETS: PresetDef[] = [
  // ---- basic shapes (the plain pattern to build on)
  P('bar', 'Flexi bar', 'Basic', 'bar', { length: 160, thickness: 9, spine: { kind: 'straight' } }, [], { from: 0.05, to: 0.95 }),
  P('rope', 'Flexi rope', 'Basic', 'bar', { length: 220, thickness: 6, heightRatio: 1, spine: { kind: 'wave', bend: 30, waves: 2 }, section: { flat: 0.2 } }, [], { from: 0.04, to: 0.96, ratio: 2.7 }),
  P('spindle', 'Spindle', 'Basic', 'spindle', { length: 170, thickness: 12, spine: { kind: 'straight' } }, [], { from: 0.1, to: 0.9 }),
  P('carrot', 'Carrot', 'Basic', 'carrot', { length: 150, thickness: 13, spine: { kind: 'arch', bend: 25 } }, [], { from: 0.1, to: 0.95 }),
  P('hex', 'Hex bar', 'Basic', 'bar', { length: 150, thickness: 9, section: { kind: 'hexagon' }, spine: { kind: 's-curve', bend: 25 } }, [], { from: 0.05, to: 0.95 }),
  P('star', 'Star rod', 'Basic', 'bar', { length: 150, thickness: 10, section: { kind: 'star', sides: 5 }, spine: { kind: 'straight' } }, [], { from: 0.05, to: 0.95 }),
  // ---- snakes
  P('snake', 'Flexi snake', 'Snake', 'snake', { length: 200, thickness: 10, spine: { kind: 's-curve', bend: 40 } }, [['eyes', { t: 0.035 }], ['nostrils', { t: 0.0, spread: 0.3 }]]),
  P('cobra', 'Cobra', 'Snake', 'snake', { length: 220, thickness: 10, spine: { kind: 'question', bend: 40 }, relief: { kind: 'scales', depth: 0.08, period: 7 } }, [['eyes', { t: 0.05 }], ['frill', { t: 0.1, count: 7, spread: 0.45, size: 1.1, length: 1 }]]),
  P('viper', 'Viper', 'Snake', 'snake', { length: 200, thickness: 10, section: { kind: 'diamond' }, spine: { kind: 'wave', bend: 38, waves: 2 }, relief: { kind: 'dorsal-ridge', depth: 0.2 } }, [['eyes', { t: 0.04 }]]),
  P('python', 'Python', 'Snake', 'snake', { length: 240, thickness: 13, spine: { kind: 'double-wave', bend: 38 }, relief: { kind: 'scales', depth: 0.07, period: 8 } }, [['eyes', { t: 0.035 }]]),
  P('coil', 'Coiled snake', 'Snake', 'snake', { length: 300, thickness: 10, spine: { kind: 'spiral', waves: 1.3 } }, [['eyes', { t: 0.03 }]], { ratio: 2.7 }),
  P('serpent', 'Sea serpent', 'Snake', 'eel', { length: 240, thickness: 12, spine: { kind: 'wave', bend: 42, waves: 2.5 }, relief: { kind: 'ribs', depth: 0.12 } }, [['eyes', { t: 0.04 }], ['sail', { t: 0.15, spread: 0.7, count: 7, size: 0.9 }], ['tailfin', { t: 0.985 }]]),
  P('worm', 'Worm', 'Snake', 'worm', { length: 170, thickness: 11, spine: { kind: 'hook', bend: 40 }, relief: { kind: 'rings', depth: 0.1, period: 9 } }, []),
  P('eel', 'Moray eel', 'Snake', 'eel', { length: 230, thickness: 11, spine: { kind: 'wave', bend: 36, waves: 1.5 } }, [['eyes', { t: 0.04 }], ['jaw', { t: 0.02, size: 0.9 }], ['sail', { t: 0.1, spread: 0.85, count: 12, size: 0.35 }]]),
  // ---- dragons & fantasy
  P('dragon', 'Flexi dragon', 'Dragon', 'dragon', { length: 220, thickness: 12, spine: { kind: 's-curve', bend: 35 }, relief: { kind: 'scales', depth: 0.07, period: 7 } },
    [['snout', { t: 0.0 }], ['eyes', { t: 0.035 }], ['horns', { t: 0.07, tilt: 45, curl: 0.5 }], ['spikes', { t: 0.14, count: 14, spread: 0.55, size: 0.8 }], ['legs', { t: 0.24, count: 1, tilt: 25 }], ['legs', { t: 0.62, count: 1, tilt: 25 }], ['tailspike', {}]]),
  P('wyvern', 'Wyvern', 'Dragon', 'dragon', { length: 230, thickness: 11, spine: { kind: 's-curve', bend: 40 } },
    [['snout', { t: 0.0, size: 0.9 }], ['eyes', { t: 0.035 }], ['horns', { t: 0.07, tilt: 50, curl: 0.7, length: 1.3 }], ['wings', { t: 0.25, tilt: 0, size: 1.1 }], ['legs', { t: 0.55, count: 1 }], ['tailspike', {}]]),
  P('eastern', 'Eastern dragon', 'Dragon', 'eel', { length: 280, thickness: 11, spine: { kind: 'double-wave', bend: 40 }, relief: { kind: 'scales', depth: 0.06, period: 7 } },
    [['snout', { t: 0.0, size: 0.9 }], ['eyes', { t: 0.04 }], ['horns', { t: 0.08, curl: 0.4, tilt: 55 }], ['mane', { t: 0.1, spread: 0.8, count: 14, size: 0.8 }], ['legs', { t: 0.3, count: 1, size: 0.7 }], ['legs', { t: 0.62, count: 1, size: 0.7 }]]),
  P('hydra', 'Dragon wyrm', 'Dragon', 'worm', { length: 240, thickness: 13, spine: { kind: 'wave', bend: 34, waves: 2 }, relief: { kind: 'saw-edge', depth: 0.12, period: 10 } },
    [['snout', { t: 0.0, length: 0.9 }], ['eyes', { t: 0.04 }], ['horns', { t: 0.08, tilt: 30 }], ['plates', { t: 0.12, count: 9, spread: 0.7 }], ['tailspike', {}]]),
  P('drake', 'Fire drake', 'Dragon', 'dragon', { length: 200, thickness: 12, spine: { kind: 'arch', bend: 30 } },
    [['snout', { t: 0 }], ['eyes', { t: 0.035 }], ['horns', { t: 0.07 }], ['sail', { t: 0.14, spread: 0.65, count: 6, size: 0.9 }], ['legs', { t: 0.25, count: 1 }], ['legs', { t: 0.6, count: 1 }], ['tailfin', { t: 0.985, size: 0.7 }]]),
  P('wurm', 'Cave wurm', 'Fantasy', 'worm', { length: 200, thickness: 14, spine: { kind: 'c-curve', bend: 45 }, relief: { kind: 'rings', depth: 0.14, period: 11 } }, [['jaw', { t: 0.0, size: 1.1 }], ['snout', { t: 0.0, size: 0.8, length: 0.6 }]]),
  P('basilisk', 'Basilisk', 'Fantasy', 'croc', { length: 230, thickness: 11, spine: { kind: 's-curve', bend: 38 } },
    [['snout', { t: 0 }], ['eyes', { t: 0.04, size: 1.2 }], ['frill', { t: 0.09, count: 7, spread: 0.4 }], ['legs', { t: 0.25, count: 2, spread: 0.3, tilt: 20 }], ['spikes', { t: 0.14, count: 12, spread: 0.7, size: 0.6 }]]),
  // ---- sea
  P('fish', 'Flexi fish', 'Sea', 'fish', { length: 180, thickness: 14, heightRatio: 1.05, spine: { kind: 's-curve', bend: 22 } }, [['eyes', { t: 0.07 }], ['fins', { t: 0.25, size: 0.9 }], ['sail', { t: 0.3, spread: 0.3, count: 3, size: 0.8 }], ['tailfin', { t: 0.985 }]], { from: 0.28 }),
  P('shark', 'Shark', 'Sea', 'shark', { length: 220, thickness: 16, spine: { kind: 's-curve', bend: 18 } }, [['snout', { t: 0, size: 0.7 }], ['eyes', { t: 0.08, size: 0.8 }], ['fins', { t: 0.24, size: 1.4, tilt: 35 }], ['sail', { t: 0.34, spread: 0.1, count: 1, size: 1.4 }], ['tailfin', { t: 0.985, size: 1.1, curl: 0.7 }]], { from: 0.32 }),
  P('whale', 'Whale', 'Sea', 'whale', { length: 220, thickness: 20, heightRatio: 0.85, spine: { kind: 'arch', bend: 22 } }, [['eyes', { t: 0.14, size: 0.7 }], ['fins', { t: 0.3, size: 1.1, tilt: 40 }], ['tailfin', { t: 0.985, size: 1.2, curl: 0.5, width: 0.7 }]], { from: 0.4 }),
  P('seahorse', 'Seahorse', 'Sea', 'seahorse', { length: 190, thickness: 12, spine: { kind: 'question', bend: 55 }, relief: { kind: 'rings', depth: 0.1, period: 9 } }, [['snout', { t: 0, size: 1.1, length: 2.2 }], ['eyes', { t: 0.07 }], ['sail', { t: 0.2, spread: 0.3, count: 3, size: 0.5 }]], { from: 0.2 }),
  P('tadpole', 'Tadpole', 'Sea', 'tadpole', { length: 160, thickness: 14, spine: { kind: 's-curve', bend: 30 } }, [['eyes', { t: 0.09, size: 1.2 }]], { from: 0.3 }),
  P('octopus', 'Octopus', 'Sea', 'mantle', { length: 70, thickness: 24, heightRatio: 1.0, spine: { kind: 'straight' }, section: { flat: 0.4 } }, [['eyes', { t: 0.55, size: 1.2, length: 1.0 }], ['arms', { t: 0.2, count: 8, spread: 190, tilt: 180, curl: 0.45, size: 0.75, length: 3.6 }]], { from: 1, to: 1, armCuts: 4 }),
  P('squid', 'Squid', 'Sea', 'spindle', { length: 150, thickness: 14, spine: { kind: 'straight' } }, [['eyes', { t: 0.78, size: 1.2, length: 1.0 }], ['fins', { t: 0.14, size: 1.3, length: 1.3, tilt: 35 }], ['arms', { t: 0.93, count: 8, spread: 60, tilt: 0, curl: 0.2, size: 0.55, length: 1.1 }]], { from: 0.3, to: 0.7, armCuts: 3 }),
  P('axolotl', 'Axolotl', 'Sea', 'lizard', { length: 170, thickness: 11, section: { flat: 0.4 }, spine: { kind: 's-curve', bend: 40 } }, [['snout', { t: 0, size: 0.5, length: 0.5, width: 1.4 }], ['eyes', { t: 0.05 }], ['gills', { t: 0.1, count: 3, size: 1.1, curl: 0.3 }], ['legs', { t: 0.25, count: 1, size: 0.7 }], ['legs', { t: 0.55, count: 1, size: 0.7 }], ['tailfin', { t: 0.985, size: 0.55, curl: 0.2 }]], { from: 0.34 }),
  P('turtle', 'Sea turtle', 'Sea', 'lizard', { length: 130, thickness: 15, spine: { kind: 'straight' }, section: { flat: 0.5 } }, [['snout', { t: 0, size: 0.6 }], ['eyes', { t: 0.06 }], ['shell', { t: 0.2, spread: 0.5, size: 1.1, width: 1.2 }], ['fins', { t: 0.22, size: 1.8, tilt: 50 }], ['tailspike', { size: 0.4 }]], { from: 0.72, to: 0.95 }),
  // ---- reptiles
  P('gecko', 'Gecko', 'Reptile', 'lizard', { length: 170, thickness: 9, spine: { kind: 's-curve', bend: 40 } }, [['snout', { t: 0, size: 0.6 }], ['eyes', { t: 0.05, size: 1.4 }], ['legs', { t: 0.25, count: 1, size: 0.85 }], ['legs', { t: 0.58, count: 1, size: 0.85 }]], { from: 0.34 }),
  P('croc', 'Crocodile', 'Reptile', 'croc', { length: 230, thickness: 12, spine: { kind: 's-curve', bend: 25 }, relief: { kind: 'bumps', depth: 0.12, period: 8 } }, [['snout', { t: 0, size: 1.2, length: 1.7 }], ['eyes', { t: 0.1, length: 1.4 }], ['nostrils', { t: 0.0 }], ['legs', { t: 0.27, count: 1 }], ['legs', { t: 0.6, count: 1 }], ['spikes', { t: 0.2, count: 14, spread: 0.7, size: 0.45 }]], { from: 0.38 }),
  P('trex', 'T-Rex', 'Reptile', 'trex', { length: 210, thickness: 15, heightRatio: 1.1, spine: { kind: 'arch', bend: 16 } }, [['snout', { t: 0, size: 1.3, width: 1.1, length: 1.4 }], ['jaw', { t: 0.0, size: 1.2 }], ['eyes', { t: 0.09, size: 0.9 }], ['spikes', { t: 0.55, count: 10, spread: 0.4, size: 0.4 }], ['legs', { t: 0.3, count: 1, size: 1.2, tilt: 10 }], ['legs', { t: 0.2, count: 1, size: 0.3, tilt: -20 }]], { from: 0.56, to: 0.96 }),
  P('iguana', 'Iguana', 'Reptile', 'lizard', { length: 230, thickness: 9, spine: { kind: 'wave', bend: 30, waves: 1.5 } }, [['snout', { t: 0, size: 0.7 }], ['eyes', { t: 0.05 }], ['spikes', { t: 0.1, count: 16, spread: 0.55, size: 0.5 }], ['legs', { t: 0.25, count: 1 }], ['legs', { t: 0.5, count: 1 }]], { from: 0.3 }),
  P('chameleon', 'Chameleon', 'Reptile', 'seahorse', { length: 200, thickness: 12, spine: { kind: 'spiral', waves: 0.9 } }, [['eyes', { t: 0.07, size: 1.2, length: 1.7 }], ['horns', { t: 0.04, size: 0.7, tilt: 80 }], ['legs', { t: 0.3, count: 1, size: 0.8 }]], { from: 0.4 }),
  P('frog', 'Frog', 'Reptile', 'frog', { length: 120, thickness: 20, heightRatio: 0.8, spine: { kind: 'straight' }, section: { flat: 0.45 } }, [['eyes', { t: 0.2, size: 1.3, length: 1.7 }], ['nostrils', { t: 0.02 }], ['legs', { t: 0.22, count: 1, size: 0.55, tilt: -15 }], ['legs', { t: 0.42, count: 1, size: 0.95, tilt: 45 }]], { from: 0.7, to: 0.97 }),
  // ---- bugs
  P('caterpillar', 'Caterpillar', 'Bug', 'caterpillar', { length: 170, thickness: 12, spine: { kind: 's-curve', bend: 30 }, relief: { kind: 'rings', depth: 0.12, period: 10 } }, [['eyes', { t: 0.04 }], ['antennae', { t: 0.0, length: 0.9 }]], { from: 0.12 }),
  P('centipede', 'Centipede', 'Bug', 'worm', { length: 230, thickness: 8, section: { flat: 0.5 }, spine: { kind: 'wave', bend: 38, waves: 2 }, relief: { kind: 'rings', depth: 0.1, period: 7 } }, [['eyes', { t: 0.03 }], ['antennae', { t: 0.0 }], ['legs', { t: 0.15, count: 14, spread: 0.7, size: 0.35, tilt: 30 }]], { ratio: 2.6, from: 0.1 }),
  P('scorpion', 'Scorpion tail', 'Bug', 'caterpillar', { length: 220, thickness: 10, spine: { kind: 'question', bend: 50 } }, [['eyes', { t: 0.03 }], ['legs', { t: 0.12, count: 4, spread: 0.2, size: 0.5 }], ['tailspike', { size: 0.9 }]], { from: 0.3 }),
  P('larva', 'Grub', 'Bug', 'worm', { length: 120, thickness: 16, spine: { kind: 'c-curve', bend: 55 }, relief: { kind: 'rings', depth: 0.1, period: 12 } }, [['eyes', { t: 0.04, size: 0.8 }]], { from: 0.08 }),
  // ---- land animals and fantasy
  P('lizardman', 'Salamander', 'Land', 'lizard', { length: 180, thickness: 10, spine: { kind: 's-curve', bend: 45 }, relief: { kind: 'bumps', depth: 0.1 } }, [['snout', { t: 0, size: 0.6, width: 1.3 }], ['eyes', { t: 0.05, size: 1.2 }], ['legs', { t: 0.25, count: 1 }], ['legs', { t: 0.55, count: 1 }]], { from: 0.34 }),
  P('cat', 'Cat', 'Land', 'club', { length: 190, thickness: 11, spine: { kind: 'question', bend: 38 } }, [['snout', { t: 0, size: 0.5, length: 0.4 }], ['ears', { t: 0.05, size: 1.1 }], ['eyes', { t: 0.06 }], ['legs', { t: 0.25, count: 1, size: 0.8 }], ['legs', { t: 0.5, count: 1, size: 0.8 }]], { from: 0.58 }),
  P('bat', 'Bat', 'Fantasy', 'spindle', { length: 100, thickness: 12, spine: { kind: 'straight' } }, [['ears', { t: 0.08, size: 1.2, length: 1.4 }], ['eyes', { t: 0.1 }], ['wings', { t: 0.3, size: 1.6, tilt: 0 }]], { from: 0.8, to: 0.95 }),
  P('phoenix', 'Phoenix', 'Fantasy', 'seahorse', { length: 220, thickness: 10, spine: { kind: 's-curve', bend: 45 } }, [['beak', { t: 0, size: 0.8 }], ['eyes', { t: 0.07 }], ['mane', { t: 0.05, count: 5, spread: 0.1, size: 1.4, length: 1.5 }], ['wings', { t: 0.3, size: 1.4, tilt: 15, curl: 0.5 }], ['tailfin', { t: 0.985, size: 1.2, curl: 0.2 }]], { from: 0.45 }),
  P('unicorn', 'Unicorn wyrm', 'Fantasy', 'dragon', { length: 210, thickness: 11, spine: { kind: 'wave', bend: 30, waves: 1.5 } }, [['snout', { t: 0, size: 0.9, length: 1.2 }], ['eyes', { t: 0.04 }], ['horns', { t: 0.0, tilt: 75, length: 1.6, size: 0.7 }], ['ears', { t: 0.07 }], ['mane', { t: 0.1, count: 14, spread: 0.6, size: 0.8 }]], { from: 0.2 }),
  P('mermaid', 'Merfolk tail', 'Fantasy', 'fish', { length: 220, thickness: 15, spine: { kind: 's-curve', bend: 28 }, relief: { kind: 'scales', depth: 0.08, period: 8 } }, [['tailfin', { t: 0.985, size: 1.3, curl: 0.6 }]], { from: 0.05, to: 0.9 }),
];

export function presetById(id: string): PresetDef | undefined { return PRESETS.find((p) => p.id === id); }

export function designFromPreset(def: PresetDef): CreatureDesign {
  const body = defaultBody();
  const o = def.body ?? {};
  const { spine, section, relief, ...rest } = o;
  Object.assign(body, rest);
  body.profile = (PROFILES[def.profile] ?? PROFILES.snake).handles.slice();
  Object.assign(body.spine, { kind: 's-curve', bend: 40, waves: 1, phase: 0 }, spine ?? {});
  Object.assign(body.section, section ?? {});
  Object.assign(body.relief, relief ?? {});
  const segments = defaultSegments();
  const { kind, ...segRest } = def.seg ?? {};
  Object.assign(segments, segRest);
  segments.joint = defaultJoint(kind ?? 'ball');
  return { version: 1, name: def.name, family: def.family, body, addons: (def.addons ?? []).map(([k, p]) => addOn(k, p)), segments };
}
