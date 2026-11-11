// Starting designs (bodies + textures) and the texture library. All original parametric recipes; each
// one is just a spec, so any of them can be edited freely after loading.
import type { PlantexSpec, ProfilePoint, RefPlane, SectionSpec, TextureLayer } from './model';
import { DEFAULT_SECTION } from './model';

export type PresetCategory = 'Planter' | 'Vase' | 'Bowl' | 'Tall' | 'Weave';
export interface Preset { id: string; category: PresetCategory; spec: Partial<PlantexSpec> }

const P = (...pts: [number, number][]): ProfilePoint[] => pts.map(([z, r]) => ({ z, r }));
const S = (p: Partial<SectionSpec>): SectionSpec => ({ ...DEFAULT_SECTION, ...p });
const T = (p: Partial<TextureLayer>): TextureLayer => ({ name: p.kind ? p.kind[0].toUpperCase() + p.kind.slice(1) : 'Texture', ...p }) as TextureLayer;
const zig = (n: number, amp: number): RefPlane[] => Array.from({ length: n + 1 }, (_, k) => ({ z: k / n, shift: k % 2 ? amp : 0, scale: 1, depth: 1 }));

// profiles (radius in mm)
const BOWL = P([0, 46], [0.45, 68], [1, 56]);
const GLOBE = P([0, 40], [0.5, 66], [1, 48]);
const STACK = P([0, 50], [0.22, 64], [0.46, 54], [0.5, 50], [0.54, 54], [0.78, 64], [1, 54]);
const DRUM = P([0, 52], [0.5, 58], [1, 54]);
const CYL = P([0, 52], [1, 52]);
const TAPER = P([0, 42], [1, 58]);
const SQUAT = P([0, 50], [0.35, 72], [0.8, 66], [1, 52]);
const BULB = P([0, 30], [0.35, 46], [0.72, 22], [0.86, 16], [1, 22]);
const PEAR = P([0, 30], [0.3, 46], [0.65, 30], [0.85, 15], [1, 18]);
const URN = P([0, 26], [0.3, 40], [0.6, 44], [0.85, 26], [1, 30]);
const CONE = P([0, 46], [0.85, 22], [1, 16]);
const SPOOL = P([0, 34], [0.25, 22], [0.5, 34], [0.75, 22], [1, 34]);
const DOUBLE = P([0, 22], [0.25, 38], [0.48, 24], [0.75, 38], [1, 24]);
const FLARE = P([0, 22], [0.55, 26], [0.8, 42], [1, 50]);
const BOTTLE = P([0, 34], [0.6, 36], [0.78, 18], [1, 16]);
const TALLCYL = P([0, 32], [1, 30]);
const LANTERN = P([0, 26], [0.5, 44], [1, 26]);

export const PRESETS: Preset[] = [
  // ---- planters
  { id: 'pleat-bowl', category: 'Planter', spec: { name: 'Pleat Bowl', kind: 'planter', height: 100, profile: BOWL, textures: [T({ kind: 'pleats', depth: 3, countU: 40 })] } },
  { id: 'diamond-lattice-bowl', category: 'Planter', spec: { name: 'Diamond Lattice Bowl', kind: 'planter', height: 100, profile: BOWL, textures: [T({ kind: 'lattice', depth: 2, countU: 18, countV: 4, shape: 0.25, sharp: 0.8 })] } },
  { id: 'twin-stack', category: 'Planter', spec: { name: 'Twin Stack', kind: 'planter', height: 120, profile: STACK, textures: [T({ kind: 'fins', depth: 2.5, countU: 60, shape: 0.3, rotate: 25, planes: zig(2, 0) })] } },
  { id: 'folded-facets', category: 'Planter', spec: { name: 'Folded Facets', kind: 'planter', height: 100, profile: GLOBE, textures: [T({ kind: 'diamonds', depth: 3.5, countU: 14, countV: 2.5, shape: 0.1 })] } },
  { id: 'rib-globe', category: 'Planter', spec: { name: 'Rib Globe', kind: 'planter', height: 100, profile: GLOBE, textures: [T({ kind: 'fins', depth: 3, countU: 56, shape: 0.35, sharp: 0.9 })] } },
  { id: 'swirl-band', category: 'Planter', spec: { name: 'Swirl Band', kind: 'planter', height: 110, profile: SQUAT, twist: 80, twistEase: 'ease', section: S({ kind: 'star', n: 30, depth: 0.08 }) } },
  { id: 'petal-cup', category: 'Planter', spec: { name: 'Petal Cup', kind: 'planter', height: 95, profile: P([0, 36], [0.5, 62], [1, 60]), section: S({ kind: 'petal', n: 18, depth: 0.12 }) } },
  { id: 'half-twist', category: 'Planter', spec: { name: 'Half Twist Ribs', kind: 'planter', height: 100, profile: GLOBE, textures: [T({ kind: 'ribs', depth: 2.5, countU: 64, rotate: 35, z0: 0, z1: 1, planes: [{ z: 0, shift: 0, scale: 1, depth: 1 }, { z: 0.6, shift: 0, scale: 1, depth: 1 }, { z: 0.61, shift: 0, scale: 1, depth: 0 }] })] } },
  { id: 'faceted-rock', category: 'Planter', spec: { name: 'Faceted Rock', kind: 'planter', height: 95, profile: SQUAT, section: S({ kind: 'polygon', n: 7, round: 0.3 }), textures: [T({ kind: 'facets', depth: 4, countU: 8, countV: 3, shape: 0.6, seed: 4 })] } },
  { id: 'chevron-globe', category: 'Planter', spec: { name: 'Chevron Globe', kind: 'planter', height: 100, profile: GLOBE, textures: [T({ kind: 'fins', depth: 2.4, countU: 70, shape: 0.35, planes: zig(2, 10), planeBlend: 'linear' })] } },
  { id: 'ogee-cutwork', category: 'Planter', spec: { name: 'Ogee Cutwork', kind: 'planter', height: 95, profile: SQUAT, wall: 3, textures: [T({ kind: 'ribbons', mode: 'cut', countU: 10, countV: 2, shape: 0.35, cutLevel: 0.5, invert: true, z0: 0.12, z1: 0.88 })] } },
  { id: 'terrace-rings', category: 'Planter', spec: { name: 'Terrace Rings', kind: 'planter', height: 100, profile: P([0, 50], [0.6, 66], [1, 60]), textures: [T({ kind: 'steps', depth: 3, countU: 1, countV: 9, sharp: 0.8 })] } },
  { id: 'open-arches', category: 'Planter', spec: { name: 'Open Arches', kind: 'planter', height: 100, profile: SQUAT, textures: [T({ kind: 'ribbons', depth: 3, countU: 12, countV: 1.5, shape: 0.25 })] } },
  { id: 'fluted-melon', category: 'Planter', spec: { name: 'Fluted Melon', kind: 'planter', height: 95, profile: GLOBE, section: S({ kind: 'petal', n: 12, depth: 0.06 }), textures: [T({ kind: 'zigzag', depth: 1.2, countU: 12, countV: 14, shape: 0.15, z0: 0.15, z1: 0.85 })] } },
  { id: 'double-drum', category: 'Planter', spec: { name: 'Double Drum', kind: 'planter', height: 120, profile: P([0, 50], [0.25, 62], [0.5, 50], [0.75, 62], [1, 52]), textures: [T({ kind: 'pleats', depth: 3, countU: 48 })] } },
  { id: 'diamond-band', category: 'Planter', spec: { name: 'Diamond Band', kind: 'planter', height: 95, profile: DRUM, textures: [T({ kind: 'diamonds', depth: 3, countU: 10, countV: 2, shape: 0.15, z0: 0.08, z1: 0.92 })] } },
  { id: 'fin-drum', category: 'Planter', spec: { name: 'Fin Drum', kind: 'planter', height: 90, profile: DRUM, textures: [T({ kind: 'fins', depth: 2.4, countU: 80, shape: 0.3, z0: 0.05, z1: 0.95, fade: 3 })] } },
  { id: 'honey-pot', category: 'Planter', spec: { name: 'Honey Pot', kind: 'planter', height: 100, profile: BOWL, textures: [T({ kind: 'hex', depth: 1.6, countU: 22, countV: 6, shape: 0.2 })] } },
  { id: 'brick-pot', category: 'Planter', spec: { name: 'Brick Pot', kind: 'planter', height: 90, profile: TAPER, textures: [T({ kind: 'bricks', depth: 1.2, countU: 16, countV: 12, shape: 0.2 })] } },
  { id: 'basket', category: 'Planter', spec: { name: 'Basket', kind: 'planter', height: 95, profile: TAPER, textures: [T({ kind: 'weave', depth: 1.8, countU: 18, countV: 7 })] } },
  { id: 'hex-planter', category: 'Planter', spec: { name: 'Hex Planter', kind: 'planter', height: 100, profile: TAPER, section: S({ kind: 'polygon', n: 6, round: 0.15 }), twist: 30 } },
  { id: 'square-soft', category: 'Planter', spec: { name: 'Soft Square', kind: 'planter', height: 100, profile: CYL, section: S({ kind: 'superellipse', exponent: 5 }), textures: [T({ kind: 'rings', depth: 1, countU: 1, countV: 20, shape: 0.3 })] } },
  { id: 'gear-pot', category: 'Planter', spec: { name: 'Gear Pot', kind: 'planter', height: 100, profile: TAPER, section: S({ kind: 'gear', n: 16, depth: 0.08, round: 0.4 }), twist: 45 } },
  { id: 'scales-pot', category: 'Planter', spec: { name: 'Dragon Scales', kind: 'planter', height: 100, profile: BOWL, textures: [T({ kind: 'scales', depth: 1.8, countU: 18, countV: 8, shape: 0.3 })] } },
  { id: 'voronoi-shade', category: 'Planter', spec: { name: 'Voronoi Shade', kind: 'planter', height: 100, profile: GLOBE, wall: 3, textures: [T({ kind: 'voronoi', mode: 'cut', countU: 14, countV: 5, shape: 0.25, invert: true, cutLevel: 0.5, z0: 0.15, z1: 0.85, seed: 3 })] } },
  { id: 'wave-cup', category: 'Planter', spec: { name: 'Wave Cup', kind: 'planter', height: 90, profile: TAPER, textures: [T({ kind: 'waves', depth: 1.6, countU: 6, countV: 10, shape: 0.25 })] } },
  { id: 'saucer-set', category: 'Planter', spec: { name: 'Pot + Saucer Set', kind: 'planter', height: 90, profile: TAPER, saucer: { enabled: true, gap: 2, wall: 2, floor: 2, height: 14, flare: 4, ribs: 6 }, textures: [T({ kind: 'flutes', depth: 1.8, countU: 30, mode: 'deboss' })] } },
  { id: 'spiral-fins', category: 'Planter', spec: { name: 'Spiral Fins', kind: 'planter', height: 100, profile: SQUAT, textures: [T({ kind: 'fins', depth: 2.5, countU: 48, shape: 0.3, rotate: 40 })] } },
  { id: 'zigzag-fins', category: 'Planter', spec: { name: 'Zig-Zag Fins', kind: 'planter', height: 110, profile: BOWL, textures: [T({ kind: 'fins', depth: 2.4, countU: 64, shape: 0.3, planes: zig(4, 9), planeBlend: 'linear' })] } },
  { id: 'wavy-fins', category: 'Planter', spec: { name: 'Wavy Fins', kind: 'planter', height: 110, profile: GLOBE, textures: [T({ kind: 'fins', depth: 2.4, countU: 64, shape: 0.3, planes: zig(3, 12), planeBlend: 'smooth' })] } },
  { id: 'self-water', category: 'Planter', spec: { name: 'Self-Watering Pot', kind: 'planter', height: 120, profile: P([0, 46], [1, 62]), selfWater: { enabled: true, reservoir: 28, gap: 1.5, wall: 1.6, wick: 14, slots: 8, overflow: 6 }, textures: [T({ kind: 'fins', depth: 2, countU: 56, shape: 0.3 })] } },
  { id: 'footed-lace', category: 'Planter', spec: { name: 'Footed Lace', kind: 'planter', height: 100, profile: GLOBE, wall: 3.2, fillet: 1.4, rimRound: 1.4, feet: { enabled: true, count: 4, height: 5, size: 16, ring: 0.7 }, textures: [T({ kind: 'hex', mode: 'cut', countU: 16, countV: 5, shape: 0.35, invert: true, cutLevel: 0.5, z0: 0.15, z1: 0.85 })] } },
  // ---- bowls
  { id: 'low-bowl', category: 'Bowl', spec: { name: 'Low Succulent Bowl', kind: 'planter', height: 55, profile: P([0, 50], [0.6, 74], [1, 72]), textures: [T({ kind: 'pleats', depth: 2, countU: 36 })] } },
  { id: 'crater-bowl', category: 'Bowl', spec: { name: 'Crater Bowl', kind: 'planter', height: 60, profile: P([0, 46], [0.7, 70], [1, 64]), textures: [T({ kind: 'craters', depth: 2, countU: 12, countV: 3, shape: 0.5, seed: 9 })] } },
  { id: 'lotus-bowl', category: 'Bowl', spec: { name: 'Lotus Bowl', kind: 'planter', height: 60, profile: P([0, 40], [1, 76]), section: S({ kind: 'petal', n: 10, depth: 0.14 }) } },
  { id: 'pebble-bowl', category: 'Bowl', spec: { name: 'Pebble Bowl', kind: 'planter', height: 55, profile: P([0, 46], [0.6, 70], [1, 62]), textures: [T({ kind: 'bubbles', depth: 1.8, countU: 18, countV: 3, shape: 0.6, seed: 2 })] } },
  // ---- vases
  { id: 'fluted-pear', category: 'Vase', spec: { name: 'Fluted Pear', kind: 'vase', vaseMode: true, height: 160, profile: PEAR, textures: [T({ kind: 'flutes', depth: 1.6, countU: 36 })] } },
  { id: 'lattice-cone', category: 'Vase', spec: { name: 'Lattice Cone', kind: 'vase', vaseMode: true, height: 150, profile: P([0, 22], [0.3, 26], [0.7, 46], [1, 20]), textures: [T({ kind: 'lattice', depth: 2, countU: 14, countV: 5, shape: 0.2 })] } },
  { id: 'stud-column', category: 'Vase', spec: { name: 'Stud Column', kind: 'vase', vaseMode: true, height: 170, profile: P([0, 30], [0.5, 32], [0.85, 30], [1, 24]), textures: [T({ kind: 'pyramids', depth: 3, countU: 14, countV: 14, z1: 0.88, fade: 4 })] } },
  { id: 'smooth-pear', category: 'Vase', spec: { name: 'Smooth Pear', kind: 'vase', vaseMode: true, height: 150, profile: PEAR, textures: [T({ kind: 'rings', depth: 0.6, countU: 1, countV: 40, shape: 0.2 })] } },
  { id: 'spike-pillar', category: 'Vase', spec: { name: 'Spike Pillar', kind: 'vase', vaseMode: true, height: 150, profile: P([0, 30], [0.6, 34], [1, 26]), textures: [T({ kind: 'pyramids', depth: 6, countU: 8, countV: 9, shape: 0.0, z1: 0.9, fade: 6 })] } },
  { id: 'ring-donut', category: 'Vase', spec: { name: 'Ripple Column', kind: 'vase', vaseMode: true, height: 150, profile: TALLCYL, textures: [T({ kind: 'rings', depth: 2.5, countU: 1, countV: 12 })] } },
  { id: 'flare-trumpet', category: 'Vase', spec: { name: 'Fine-Rib Trumpet', kind: 'vase', vaseMode: true, height: 160, profile: P([0, 46], [0.55, 28], [0.85, 18], [1, 22]), textures: [T({ kind: 'ribs', depth: 1.2, countU: 90 })] } },
  { id: 'diamond-urn', category: 'Vase', spec: { name: 'Diamond Urn', kind: 'vase', vaseMode: true, height: 170, profile: URN, textures: [T({ kind: 'diamonds', depth: 2.5, countU: 16, countV: 10, shape: 0.1 })] } },
  { id: 'twisted-lantern', category: 'Vase', spec: { name: 'Twisted Lantern', kind: 'vase', vaseMode: true, height: 160, profile: LANTERN, section: S({ kind: 'star', n: 9, depth: 0.15 }), twist: 120 } },
  { id: 'voronoi-vase', category: 'Vase', spec: { name: 'Cellular Vase', kind: 'vase', vaseMode: false, height: 160, profile: URN, wall: 3, textures: [T({ kind: 'voronoi', mode: 'cut', countU: 10, countV: 8, shape: 0.3, invert: true, cutLevel: 0.5, z0: 0.12, z1: 0.88, seed: 5 })] } },
  { id: 'hex-cells', category: 'Vase', spec: { name: 'Hex Cells', kind: 'vase', vaseMode: true, height: 150, profile: P([0, 26], [0.5, 34], [1, 26]), section: S({ kind: 'polygon', n: 6, round: 0.2 }), textures: [T({ kind: 'hex', depth: 2, countU: 6, countV: 4, shape: 0.15 })] } },
  { id: 'crackle', category: 'Vase', spec: { name: 'Crackle', kind: 'vase', vaseMode: true, height: 160, profile: LANTERN, textures: [T({ kind: 'voronoi', depth: 1.8, countU: 16, countV: 12, shape: 0.06, seed: 11 })] } },
  { id: 'sprout', category: 'Vase', spec: { name: 'Sprout', kind: 'vase', vaseMode: true, height: 160, profile: P([0, 22], [0.5, 24], [0.75, 36], [1, 44]), textures: [T({ kind: 'fins', depth: 4, countU: 24, shape: 0.3, z0: 0.45 }), T({ kind: 'ribs', depth: 1, countU: 48, z1: 0.5 })] } },
  { id: 'rhombus-urn', category: 'Vase', spec: { name: 'Rhombus Lattice Urn', kind: 'vase', vaseMode: true, height: 170, profile: URN, textures: [T({ kind: 'lattice', depth: 1.8, countU: 18, countV: 7, shape: 0.15 })] } },
  { id: 'cut-crown', category: 'Vase', spec: { name: 'Cut Crown', kind: 'vase', vaseMode: false, height: 140, profile: P([0, 30], [0.55, 58], [1, 42]), section: S({ kind: 'star', n: 10, depth: 0.12 }), wall: 3, textures: [T({ kind: 'voronoi', mode: 'cut', countU: 20, countV: 4, shape: 0.2, invert: true, cutLevel: 0.5, z0: 0.25, z1: 0.8 })] } },
  { id: 'flames', category: 'Vase', spec: { name: 'Flames', kind: 'vase', vaseMode: true, height: 170, profile: URN, textures: [T({ kind: 'petals', depth: 3, countU: 7, countV: 2, shape: 0.6 })] } },
  { id: 'helix-pear', category: 'Vase', spec: { name: 'Helix Pear', kind: 'vase', vaseMode: true, height: 160, profile: PEAR, textures: [T({ kind: 'ribs', depth: 1.8, countU: 40, rotate: 30 })] } },
  { id: 'side-sweep', category: 'Vase', spec: { name: 'Side Sweep', kind: 'vase', vaseMode: true, height: 140, profile: P([0, 30], [0.4, 50], [0.8, 34], [0.9, 16], [1, 18]), textures: [T({ kind: 'ribs', depth: 1.6, countU: 60, rotate: 20, planes: [{ z: 0, shift: 0, scale: 1, depth: 1 }, { z: 1, shift: 60, scale: 1, depth: 1 }] })] } },
  { id: 'double-gourd', category: 'Vase', spec: { name: 'Double Gourd', kind: 'vase', vaseMode: true, height: 170, profile: DOUBLE, textures: [T({ kind: 'ribs', depth: 1.4, countU: 70 })] } },
  { id: 'spool', category: 'Vase', spec: { name: 'Spool', kind: 'vase', vaseMode: true, height: 160, profile: SPOOL, textures: [T({ kind: 'ribs', depth: 1.4, countU: 60 })] } },
  { id: 'genie', category: 'Vase', spec: { name: 'Genie Bulb', kind: 'vase', vaseMode: true, height: 160, profile: BULB, textures: [T({ kind: 'flutes', depth: 1.4, countU: 40 })] } },
  { id: 'bell', category: 'Vase', spec: { name: 'Bell', kind: 'vase', vaseMode: true, height: 150, profile: CONE, textures: [T({ kind: 'ribs', depth: 1, countU: 110 })] } },
  { id: 'hex-honeycomb-column', category: 'Vase', spec: { name: 'Honeycomb Column', kind: 'vase', vaseMode: true, height: 170, profile: P([0, 30], [1, 30]), section: S({ kind: 'polygon', n: 6, round: 0 }), textures: [T({ kind: 'hex', depth: 3, countU: 6, countV: 6, shape: 0.05, sharp: 1 })] } },
  { id: 'bark', category: 'Vase', spec: { name: 'Bark', kind: 'vase', vaseMode: true, height: 160, profile: URN, textures: [T({ kind: 'voronoi', depth: 2, countU: 24, countV: 10, shape: 0.05, rotate: 0, seed: 7 }), T({ kind: 'noise', depth: 0.8, countU: 30, countV: 20 })] } },
  { id: 'claw', category: 'Vase', spec: { name: 'Leaf Claw', kind: 'vase', vaseMode: true, height: 150, profile: P([0, 40], [0.45, 44], [0.7, 30], [1, 36]), textures: [T({ kind: 'petals', depth: 5, countU: 5, countV: 1, shape: 0.8, z1: 0.75 }), T({ kind: 'ribs', depth: 1, countU: 40, z0: 0.6 })] } },
  { id: 'pearls', category: 'Vase', spec: { name: 'Pearls', kind: 'vase', vaseMode: true, height: 150, profile: PEAR, textures: [T({ kind: 'bubbles', depth: 2, countU: 16, countV: 10, shape: 0.5, seed: 21 })] } },
  { id: 'moon', category: 'Vase', spec: { name: 'Moon Twist', kind: 'vase', vaseMode: true, height: 160, profile: URN, section: S({ kind: 'wave', n: 3, depth: 0.12 }), twist: 140, textures: [T({ kind: 'craters', depth: 2.4, countU: 14, countV: 10, shape: 0.55, seed: 13 })] } },
  { id: 'tall-fluted', category: 'Tall', spec: { name: 'Tall Fluted Column', kind: 'vase', vaseMode: true, height: 220, profile: P([0, 30], [0.85, 30], [0.95, 26], [1, 24]), textures: [T({ kind: 'ribs', depth: 1.4, countU: 52, z1: 0.9 })] } },
  { id: 'tall-flare', category: 'Tall', spec: { name: 'Tulip Flare', kind: 'vase', vaseMode: true, height: 200, profile: FLARE, section: S({ kind: 'petal', n: 8, depth: 0.08 }), twist: 60 } },
  { id: 'tall-bottle', category: 'Tall', spec: { name: 'Bottle', kind: 'vase', vaseMode: true, height: 210, profile: BOTTLE, textures: [T({ kind: 'helix', depth: 1.2, countU: 30, countV: 2 })] } },
  { id: 'tall-oval', category: 'Tall', spec: { name: 'Oval Sleeve', kind: 'vase', vaseMode: true, height: 200, profile: TALLCYL, section: S({ kind: 'circle', aspect: 1.6 }), textures: [T({ kind: 'waves', depth: 1.4, countU: 4, countV: 18, shape: 0.2 })] } },
  { id: 'tall-square-twist', category: 'Tall', spec: { name: 'Square Twist', kind: 'vase', vaseMode: true, height: 200, profile: P([0, 30], [0.5, 34], [1, 28]), section: S({ kind: 'superellipse', exponent: 6 }), twist: 180 } },
  { id: 'morph-star', category: 'Tall', spec: { name: 'Star to Circle', kind: 'vase', vaseMode: true, height: 190, profile: P([0, 34], [1, 30]), section: { ...S({ kind: 'star', n: 6, depth: 0.25 }), morphTo: S({ kind: 'circle' }) }, twist: 90 } },
  // ---- weave bodies: plain closed walls for Motionex weave (the picture is woven in while slicing)
  { id: 'weave-amphora', category: 'Weave', spec: { name: 'Weave Amphora', kind: 'vase', vaseMode: true, height: 170, profile: P([0, 30], [0.08, 31], [0.4, 50], [0.75, 42], [0.9, 31], [1, 31]) } },
  { id: 'weave-flared', category: 'Weave', spec: { name: 'Weave Flared Column', kind: 'vase', vaseMode: true, height: 180, profile: P([0, 38], [0.68, 38], [0.76, 40], [0.88, 50], [1, 60]), section: S({ kind: 'superellipse', exponent: 2.6 }) } },
  { id: 'weave-twist-ovoid', category: 'Weave', spec: { name: 'Weave Twisted Ovoid', kind: 'vase', vaseMode: true, height: 200, profile: P([0, 30], [0.35, 46], [0.75, 40], [1, 22]), section: S({ kind: 'superellipse', exponent: 3, aspect: 0.78 }), twist: 70, twistEase: 'ease' } },
  { id: 'weave-saucer', category: 'Weave', spec: { name: 'Weave Saucer Column', kind: 'vase', vaseMode: true, height: 150, profile: P([0, 62], [0.06, 72], [0.12, 68], [0.2, 36], [1, 36]) } },
  { id: 'weave-jar', category: 'Weave', spec: { name: 'Weave Ginger Jar', kind: 'vase', vaseMode: true, height: 190, profile: P([0, 34], [0.4, 54], [0.8, 44], [0.92, 34], [1, 34]) } },
  { id: 'weave-cylinder', category: 'Weave', spec: { name: 'Weave Cylinder', kind: 'vase', vaseMode: true, height: 160, profile: P([0, 40], [1, 40]) } },
];

/** Texture library: named recipes the user drops onto a design. */
export interface TexturePreset { id: string; name: string; group: string; layer: Partial<TextureLayer> }
const L = (id: string, name: string, group: string, layer: Partial<TextureLayer>): TexturePreset => ({ id, name, group, layer: { name, ...layer } });

export const TEXTURE_LIBRARY: TexturePreset[] = [
  L('ribs-fine', 'Fine ribs', 'Vertical', { kind: 'ribs', depth: 1, countU: 96 }),
  L('ribs-bold', 'Bold ribs', 'Vertical', { kind: 'ribs', depth: 2.5, countU: 36 }),
  L('ribs-flat', 'Flat-top ribs', 'Vertical', { kind: 'ribs', depth: 1.6, countU: 48, shape: 0.8 }),
  L('flutes', 'Flutes', 'Vertical', { kind: 'flutes', depth: 1.6, countU: 32 }),
  L('scallops', 'Scallops (deboss)', 'Vertical', { kind: 'flutes', mode: 'deboss', depth: 1.4, countU: 24 }),
  L('fins-thin', 'Thin fins', 'Vertical', { kind: 'fins', depth: 2.5, countU: 72, shape: 0.25 }),
  L('fins-wide', 'Wide fins', 'Vertical', { kind: 'fins', depth: 2, countU: 40, shape: 0.6 }),
  L('pleats', 'Accordion pleats', 'Vertical', { kind: 'pleats', depth: 3, countU: 40 }),
  L('spiral-ribs', 'Spiral ribs', 'Twisted', { kind: 'ribs', depth: 1.6, countU: 48, rotate: 30 }),
  L('spiral-fins', 'Spiral fins', 'Twisted', { kind: 'fins', depth: 2.4, countU: 48, shape: 0.3, rotate: 40 }),
  L('counter-twist', 'Counter twist', 'Twisted', { kind: 'ribs', depth: 1.6, countU: 48, rotate: -30 }),
  L('helix', 'Helix', 'Twisted', { kind: 'helix', depth: 1.4, countU: 30, countV: 2 }),
  L('chevron', 'Chevron fins', 'Modulated', { kind: 'fins', depth: 2.4, countU: 64, shape: 0.3, planes: zig(2, 10), planeBlend: 'linear' }),
  L('zigzag-ribs', 'Zig-zag ribs', 'Modulated', { kind: 'ribs', depth: 1.8, countU: 48, planes: zig(6, 7), planeBlend: 'linear' }),
  L('wavy-ribs', 'Wavy ribs', 'Modulated', { kind: 'ribs', depth: 1.8, countU: 48, planes: zig(4, 8), planeBlend: 'smooth' }),
  L('sine-ribs', 'Sine ribs', 'Modulated', { kind: 'ribs', depth: 1.6, countU: 48, waveAmp: 6, wavePeriod: 30 }),
  L('swell-fins', 'Swelling fins', 'Modulated', { kind: 'fins', depth: 2.4, countU: 48, shape: 0.2, planes: [{ z: 0, shift: 0, scale: 0.4, depth: 0.4 }, { z: 0.5, shift: 0, scale: 2, depth: 1 }, { z: 1, shift: 0, scale: 0.4, depth: 0.4 }] }),
  L('fade-up', 'Fade-up ribs', 'Modulated', { kind: 'ribs', depth: 2, countU: 48, planes: [{ z: 0, shift: 0, scale: 1, depth: 1 }, { z: 1, shift: 0, scale: 1, depth: 0 }] }),
  L('lattice', 'Diamond lattice', 'Lattice', { kind: 'lattice', depth: 2, countU: 18, countV: 5, shape: 0.2 }),
  L('lattice-fine', 'Fine lattice', 'Lattice', { kind: 'lattice', depth: 1.2, countU: 30, countV: 10, shape: 0.15 }),
  L('lattice-cut', 'Open lattice (cut)', 'Lattice', { kind: 'lattice', mode: 'cut', countU: 14, countV: 4, shape: 0.25, invert: true, cutLevel: 0.5, z0: 0.12, z1: 0.88 }),
  L('knurl', 'Knurl', 'Lattice', { kind: 'knurl', depth: 1.2, countU: 48, countV: 16 }),
  L('diamonds', 'Diamond facets', 'Facets', { kind: 'diamonds', depth: 2.5, countU: 16, countV: 6 }),
  L('diamonds-big', 'Big folds', 'Facets', { kind: 'diamonds', depth: 4, countU: 10, countV: 2 }),
  L('pyramids', 'Pyramid studs', 'Facets', { kind: 'pyramids', depth: 2.5, countU: 18, countV: 12 }),
  L('spikes', 'Spikes', 'Facets', { kind: 'pyramids', depth: 5, countU: 10, countV: 8, shape: 0 }),
  L('low-poly', 'Low poly', 'Facets', { kind: 'facets', depth: 3, countU: 10, countV: 4, shape: 0.5 }),
  L('hex', 'Honeycomb', 'Cells', { kind: 'hex', depth: 1.6, countU: 20, countV: 6, shape: 0.2 }),
  L('hex-cut', 'Honeycomb (cut)', 'Cells', { kind: 'hex', mode: 'cut', countU: 16, countV: 5, shape: 0.25, invert: true, cutLevel: 0.5, z0: 0.12, z1: 0.88 }),
  L('voronoi', 'Voronoi', 'Cells', { kind: 'voronoi', depth: 1.8, countU: 14, countV: 6, shape: 0.12 }),
  L('voronoi-cut', 'Voronoi (cut)', 'Cells', { kind: 'voronoi', mode: 'cut', countU: 12, countV: 5, shape: 0.25, invert: true, cutLevel: 0.5, z0: 0.12, z1: 0.88 }),
  L('crackle', 'Crackle', 'Cells', { kind: 'voronoi', depth: 1.2, countU: 24, countV: 12, shape: 0.05 }),
  L('bubbles', 'Bubbles', 'Organic', { kind: 'bubbles', depth: 1.8, countU: 16, countV: 6, shape: 0.5 }),
  L('pearls', 'Pearls', 'Organic', { kind: 'dots', depth: 1.6, countU: 24, countV: 12, shape: 0.6 }),
  L('craters', 'Moon craters', 'Organic', { kind: 'craters', depth: 2, countU: 12, countV: 6, shape: 0.5 }),
  L('noise', 'Stone', 'Organic', { kind: 'noise', depth: 1.4, countU: 16, countV: 10 }),
  L('scales', 'Scales', 'Organic', { kind: 'scales', depth: 1.8, countU: 18, countV: 8 }),
  L('petals', 'Petals', 'Organic', { kind: 'petals', depth: 3, countU: 8, countV: 2, shape: 0.6 }),
  L('ribbons', 'Ogee ribbons', 'Organic', { kind: 'ribbons', depth: 2.4, countU: 12, countV: 1.5, shape: 0.25 }),
  L('ribbons-cut', 'Ogee cutwork', 'Organic', { kind: 'ribbons', mode: 'cut', countU: 10, countV: 2, shape: 0.35, invert: true, cutLevel: 0.5, z0: 0.12, z1: 0.88 }),
  L('rings', 'Rings', 'Horizontal', { kind: 'rings', depth: 1.4, countU: 1, countV: 20 }),
  L('steps', 'Terraces', 'Horizontal', { kind: 'steps', depth: 3, countU: 1, countV: 9 }),
  L('waves', 'Waves', 'Horizontal', { kind: 'waves', depth: 1.6, countU: 6, countV: 10, shape: 0.25 }),
  L('zigzag', 'Zig-zag bands', 'Horizontal', { kind: 'zigzag', depth: 1.4, countU: 12, countV: 10, shape: 0.2 }),
  L('bricks', 'Bricks', 'Surface', { kind: 'bricks', depth: 1.2, countU: 16, countV: 12, shape: 0.2 }),
  L('weave', 'Basket weave', 'Surface', { kind: 'weave', depth: 1.8, countU: 18, countV: 7 }),
  L('dots', 'Polka dots', 'Surface', { kind: 'dots', depth: 1.2, countU: 16, countV: 10, shape: 0.4 }),
  L('dots-cut', 'Perforated (cut)', 'Surface', { kind: 'dots', mode: 'cut', countU: 24, countV: 10, shape: 0.4, cutLevel: 0.3, z0: 0.12, z1: 0.88 }),
];
