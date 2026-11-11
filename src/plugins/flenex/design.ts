// Flenex design model: a creature is a lofted body along a spine with add-ons (eyes, horns, legs, wings...),
// then a list of cuts that turn it into a print-in-place flexi. The same cuts work on an imported model.
import { defaultJoint, type JointSpec } from './joints';
import type { Cut } from './flexi';

export type SpineKind = 'straight' | 'wave' | 's-curve' | 'double-wave' | 'arch' | 'c-curve' | 'hook' | 'zigzag' | 'spiral' | 'question';
export const SPINES: { id: SpineKind; name: string }[] = [
  { id: 'straight', name: 'Straight' }, { id: 's-curve', name: 'S curve' }, { id: 'wave', name: 'Wave (slither)' },
  { id: 'double-wave', name: 'Double wave' }, { id: 'arch', name: 'Arch' }, { id: 'c-curve', name: 'C curve' },
  { id: 'hook', name: 'Hooked tail' }, { id: 'zigzag', name: 'Zigzag' }, { id: 'spiral', name: 'Flat coil' }, { id: 'question', name: 'Question mark' },
];

export type SectionKind = 'round' | 'squircle' | 'diamond' | 'hexagon' | 'teardrop' | 'rounded-box' | 'star' | 'lens';
export const SECTION_KINDS: { id: SectionKind; name: string }[] = [
  { id: 'round', name: 'Round / oval' }, { id: 'squircle', name: 'Soft square' }, { id: 'rounded-box', name: 'Rounded box' },
  { id: 'diamond', name: 'Diamond' }, { id: 'hexagon', name: 'Hexagon' }, { id: 'teardrop', name: 'Teardrop' },
  { id: 'lens', name: 'Lens (pointed sides)' }, { id: 'star', name: 'Ridged star' },
];

export type ReliefKind = 'none' | 'ribs' | 'rings' | 'scales' | 'dorsal-ridge' | 'faceted' | 'twist-ribs' | 'bumps' | 'belly-plates' | 'saw-edge' | 'spine-rows';
export const RELIEFS: { id: ReliefKind; name: string }[] = [
  { id: 'none', name: 'Smooth' }, { id: 'ribs', name: 'Lengthwise ribs' }, { id: 'rings', name: 'Rings (segmented)' },
  { id: 'scales', name: 'Scales' }, { id: 'dorsal-ridge', name: 'Dorsal ridge' }, { id: 'faceted', name: 'Faceted' },
  { id: 'twist-ribs', name: 'Twisting ribs' }, { id: 'bumps', name: 'Bumps' }, { id: 'belly-plates', name: 'Belly plates' },
  { id: 'saw-edge', name: 'Saw edge' }, { id: 'spine-rows', name: 'Spine rows' },
];

export type AddOnKind =
  | 'eyes' | 'horns' | 'ears' | 'spikes' | 'sail' | 'fins' | 'tailfin' | 'legs' | 'wings' | 'arms' | 'snout' | 'beak'
  | 'plates' | 'knobs' | 'frill' | 'club' | 'antennae' | 'shell' | 'mane' | 'tailspike' | 'gills' | 'jaw' | 'cheeks' | 'nostrils';

export interface AddOnInfo { id: AddOnKind; name: string; blurb: string; fields: ('t' | 'size' | 'length' | 'width' | 'count' | 'spread' | 'tilt' | 'curl' | 'side')[] }
export const ADDONS: AddOnInfo[] = [
  { id: 'eyes', name: 'Eyes', blurb: 'Round bulges (long = eye stalks).', fields: ['t', 'size', 'length', 'spread'] },
  { id: 'horns', name: 'Horns', blurb: 'Curved horn pair.', fields: ['t', 'size', 'length', 'tilt', 'curl', 'spread'] },
  { id: 'ears', name: 'Ears', blurb: 'Standing ear blades.', fields: ['t', 'size', 'length', 'width', 'tilt', 'spread'] },
  { id: 'spikes', name: 'Spikes', blurb: 'A row of cones on the back, sides or belly.', fields: ['t', 'size', 'length', 'count', 'spread', 'side'] },
  { id: 'sail', name: 'Dorsal sail', blurb: 'A tall fin along the back with scalloped edge.', fields: ['t', 'size', 'length', 'count', 'spread', 'curl'] },
  { id: 'fins', name: 'Side fins', blurb: 'Flat pectoral fins on the bed.', fields: ['t', 'size', 'length', 'width', 'tilt', 'curl', 'count', 'spread'] },
  { id: 'tailfin', name: 'Tail fin', blurb: 'Standing caudal fin at the tail end.', fields: ['t', 'size', 'length', 'width', 'curl'] },
  { id: 'legs', name: 'Legs', blurb: 'Sprawling legs in pairs with foot pads.', fields: ['t', 'size', 'length', 'width', 'tilt', 'count', 'spread'] },
  { id: 'wings', name: 'Wings', blurb: 'Bat-style wings; tilt 0 lies flat, 90 stands up.', fields: ['t', 'size', 'length', 'width', 'tilt', 'curl'] },
  { id: 'arms', name: 'Arms / tentacles', blurb: 'Curling tubes lying on the bed.', fields: ['t', 'size', 'length', 'count', 'spread', 'tilt', 'curl'] },
  { id: 'snout', name: 'Snout', blurb: 'Elongated muzzle.', fields: ['t', 'size', 'length', 'width'] },
  { id: 'jaw', name: 'Lower jaw', blurb: 'Chin under the head.', fields: ['t', 'size', 'length', 'width'] },
  { id: 'beak', name: 'Beak', blurb: 'Pointed upper and lower beak.', fields: ['t', 'size', 'length', 'width'] },
  { id: 'cheeks', name: 'Cheeks', blurb: 'Round bulges on the sides of the head.', fields: ['t', 'size', 'width'] },
  { id: 'nostrils', name: 'Nostrils / snout bumps', blurb: 'Two small bumps on top of the snout.', fields: ['t', 'size', 'spread'] },
  { id: 'plates', name: 'Back plates', blurb: 'Standing plates like a stegosaurus.', fields: ['t', 'size', 'length', 'count', 'spread'] },
  { id: 'knobs', name: 'Knobs / warts', blurb: 'Rows of round bumps.', fields: ['t', 'size', 'count', 'spread', 'side'] },
  { id: 'frill', name: 'Neck frill', blurb: 'Radial blades behind the head.', fields: ['t', 'size', 'length', 'count', 'spread'] },
  { id: 'gills', name: 'Gills', blurb: 'Feathery branches on both sides of the neck.', fields: ['t', 'size', 'length', 'count', 'curl'] },
  { id: 'mane', name: 'Mane', blurb: 'Soft blades along the neck and back.', fields: ['t', 'size', 'length', 'count', 'spread'] },
  { id: 'shell', name: 'Shell', blurb: 'Dome over part of the back.', fields: ['t', 'size', 'length', 'width', 'spread'] },
  { id: 'club', name: 'Tail club', blurb: 'A ball at the end of the tail.', fields: ['size'] },
  { id: 'tailspike', name: 'Tail spike', blurb: 'A cone pointing from the tail tip.', fields: ['size', 'length'] },
  { id: 'antennae', name: 'Antennae', blurb: 'Two thin stalks with ball tips.', fields: ['t', 'size', 'length', 'tilt', 'curl'] },
];

export interface AddOn {
  id: string;
  kind: AddOnKind;
  /** Position along the body, 0 head → 1 tail. */
  t: number;
  /** Overall size relative to the local body (1 = nominal). */
  size: number;
  /** Elongation. */
  length: number;
  width: number;
  count: number;
  /** Distance to the last repeat (share of the body) or fan angle (°), depending on the kind. */
  spread: number;
  /** Degrees (lean back / lift). */
  tilt: number;
  curl: number;
  side: 'top' | 'sides' | 'belly';
}

let seq = 0;
export const newAddOnId = () => `a${Date.now().toString(36)}${(seq++).toString(36)}`;
const DEFAULT_COUNT: Partial<Record<AddOnKind, number>> = { spikes: 8, plates: 7, knobs: 6, mane: 10, frill: 7, sail: 5, gills: 3, arms: 6, legs: 1, fins: 1 };
export const addOn = (kind: AddOnKind, o: Partial<AddOn> = {}): AddOn => ({ id: newAddOnId(), kind, t: 0.08, size: 1, length: 1, width: 1, count: DEFAULT_COUNT[kind] ?? 1, spread: 0.3, tilt: 20, curl: 0.3, side: 'top', ...o });

export interface BodySpec {
  /** Spine length (mm) and the radius of the thickest part (mm). */
  length: number;
  thickness: number;
  /** Height as a share of width. */
  heightRatio: number;
  spine: { kind: SpineKind; bend: number; waves: number; phase: number };
  /** Nine radius multipliers, head → tail. */
  profile: number[];
  section: { kind: SectionKind; power: number; /** share of the underside left flat on the bed (0 = round line contact) */ flat: number; sides: number };
  relief: { kind: ReliefKind; depth: number; period: number; from: number; to: number };
  /** Rounding of both ends (share of the thickness). */
  endRound: number;
}

export interface SegmentSpec {
  mode: 'even' | 'scaled' | 'length';
  count: number;
  /** Segment length for mode "length" (mm). */
  length: number;
  /** Share of thickness-proportional spacing for mode "scaled". */
  ratio: number;
  /** Where cuts start and end along the body (0 head → 1 tail). */
  from: number;
  to: number;
  joint: JointSpec;
  /** Alternate the hinge direction between neighbouring cuts. */
  alternate: boolean;
  firstRoll: number;
  /** Cuts on each arm / tentacle (0 = from the thickness). */
  armCuts: number;
}

export interface CreatureDesign {
  version: 1;
  name: string;
  family: string;
  body: BodySpec;
  addons: AddOn[];
  segments: SegmentSpec;
}

export const defaultBody = (): BodySpec => ({
  length: 180, thickness: 11, heightRatio: 0.95,
  spine: { kind: 's-curve', bend: 40, waves: 1, phase: 0 },
  profile: [0.7, 0.92, 1, 1, 0.97, 0.9, 0.78, 0.55, 0.2],
  section: { kind: 'round', power: 2, flat: 0.3, sides: 6 },
  relief: { kind: 'none', depth: 0.1, period: 8, from: 0, to: 1 },
  endRound: 0.7,
});

export const defaultSegments = (): SegmentSpec => ({
  mode: 'scaled', count: 14, length: 12, ratio: 2.5, from: 0.16, to: 0.97, joint: defaultJoint('ball'), alternate: true, firstRoll: 0, armCuts: 0,
});

export type { Cut };
