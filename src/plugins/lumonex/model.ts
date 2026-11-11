// Lumonex design model. A lamp is a stack of sections (bottom → top in the assembled lamp), each with
// its own shape, pattern, material and joint to the section below, plus the electrical fitting, the
// bulb (preview only), wire routing and the accessories its lamp type needs (canopy, backplate, pipe
// clamp, battery box, hooks). Sections taller than the printer are split into jointed pieces.
import { defaultJoint, type JointSpec } from './joinery';
import { defaultShape, pattern, type ShapeSpec } from './shape';
import type { MaterialKind } from './catalog';

export type LampKind = 'table' | 'wall' | 'pendant' | 'floor' | 'ceiling' | 'lantern' | 'mount';

export const LAMP_KINDS: { id: LampKind; name: string; blurb: string }[] = [
  { id: 'table', name: 'Table lamp', blurb: 'Base + holder seat + hung shade; side cable exit and switch.' },
  { id: 'wall', name: 'Wall lamp', blurb: 'Backplate with keyholes, arm, holder cup and shade (full or half).' },
  { id: 'pendant', name: 'Hanging lamp', blurb: 'Shade with gallery, ceiling canopy, cord grip, optional hook.' },
  { id: 'floor', name: 'Floor lamp', blurb: 'Weighted base + jointed pole segments + shade; 20 joint types.' },
  { id: 'ceiling', name: 'Floor-to-ceiling', blurb: 'Tension pole to room height, jack-screw top, clamp-on arms.' },
  { id: 'lantern', name: 'Lantern', blurb: 'Battery box, switch and USB-C cut-outs, LED seat, handle.' },
  { id: 'mount', name: 'Pipe / vehicle lamp', blurb: 'Split clamp for any pipe or handlebar Ø, tilt arm, LED head.' },
];

export type SectionRole = 'shade' | 'base' | 'stem' | 'pole' | 'body' | 'cap' | 'deco';

export interface Section {
  id: string;
  name: string;
  role: SectionRole;
  shape: ShapeSpec;
  material: MaterialKind;
  color: string;
  /** 'stack': sits on the section below with a joint. 'hung': hangs on the lamp holder by its gallery. */
  attach: 'stack' | 'hung';
  /** Joint to the section below (stack) and for splitting this section into pieces. */
  joint: JointSpec;
  /** Gallery (hung shades): height in the shade (0 bottom .. 1 top). */
  gallery: number;
  /** Gallery spokes (0 = full ring). */
  spokes: number;
  /** Extra Z offset in the assembly (mm). */
  zOffset: number;
  /** Hide from print (keep in the assembly as a reference). */
  skip?: boolean;
  /** Pieces this section is cut into (0 = automatic from the printer height). */
  pieces: number;
}

export interface Fitting {
  holder: string;
  /** Lamp holder fit clearance (mm). */
  clearance: number;
  /** LED strip core diameter / puck size override (mm). */
  coreDiameter: number;
}

export type WireRoute = 'center-down' | 'side-exit' | 'bottom-channel' | 'rear' | 'top' | 'in-wall' | 'surface' | 'internal';

export const WIRE_ROUTES: { id: WireRoute; name: string }[] = [
  { id: 'side-exit', name: 'Side exit near the bottom' },
  { id: 'bottom-channel', name: 'Channel under the base to the edge' },
  { id: 'center-down', name: 'Straight down through the floor' },
  { id: 'rear', name: 'Rear exit (high)' },
  { id: 'top', name: 'Out of the top (pendant / ceiling)' },
  { id: 'in-wall', name: 'Into the wall behind the plate' },
  { id: 'surface', name: 'Surface cable, bottom of the plate' },
  { id: 'internal', name: 'Internal (battery lamps)' },
];

export interface Wiring {
  cable: string;
  route: WireRoute;
  /** Exit direction (degrees around Z) and height above the floor (mm). */
  exitAngle: number;
  exitHeight: number;
  grommet: boolean;
  switchId: string;
  switchAngle: number;
  switchHeight: number;
  /** Cord length to hang a pendant (mm, assembly only). */
  drop: number;
}

export interface BaseOptions {
  /** Ballast cavity for sand / steel shot (floor and table bases). */
  ballast: boolean;
  /** Felt / rubber foot recess depth (mm), 0 = none. */
  feltRecess: number;
  /** Tripod legs instead of a closed base (0 = off, 3..4 legs). */
  legs: number;
  legSplay: number;
}

export interface WallOptions { plateW: number; plateH: number; plateT: number; plateRadius: number; armLength: number; armAngle: number; armDiameter: number; keyholes: number; screw: 'M3' | 'M4' | 'M5' }

export interface CanopyOptions { diameter: number; height: number; holes: number; hook: boolean; cluster: number }

export interface PoleOptions { height: number; diameter: number; ceiling: number; arms: number; armLength: number; jackTravel: number }

export interface LanternOptions { battery: string; usb: boolean; handle: 'bail' | 'loop' | 'rope' | 'none'; handleSize: number; boxHeight: number }

export interface MountOptions {
  pipe: number; clampWidth: number; clampWall: number; bolt: 'M3' | 'M4' | 'M5'; shim: number;
  style: 'two-bolt' | 'hinge' | 'strap' | 'gopro';
  armLength: number; tilt: number; headBattery: boolean;
}

export interface Accessories { ceilingHook: boolean; wallHook: boolean; cableClips: number; sHook: boolean; reducer: boolean }

export interface LampDesign {
  version: 1;
  name: string;
  code?: string;
  kind: LampKind;
  sections: Section[];
  fitting: Fitting;
  bulb: string;
  watts: number;
  showBulb: boolean;
  wiring: Wiring;
  base: BaseOptions;
  wall: WallOptions;
  canopy: CanopyOptions;
  pole: PoleOptions;
  lantern: LanternOptions;
  mount: MountOptions;
  accessories: Accessories;
  quality: 'draft' | 'normal' | 'fine';
  /** Printer margin kept free on every axis (mm). */
  margin: number;
}

let sid = 0;
export const sectionId = () => `s${Date.now().toString(36)}${(sid++).toString(36)}`;

export function section(p: Partial<Section> & { role: SectionRole }): Section {
  return {
    id: sectionId(), name: p.role[0].toUpperCase() + p.role.slice(1), shape: defaultShape(), material: 'PLA Matte', color: 'Beige',
    attach: p.role === 'shade' ? 'hung' : 'stack', joint: defaultJoint(), gallery: 0, spokes: 0, zOffset: 0, pieces: 0, ...p,
  };
}

const flutes = pattern('flutes', { count: 48, depth: 2.4, sharpness: 1.4 });

export function defaultDesign(kind: LampKind = 'table'): LampDesign {
  const base: Omit<LampDesign, 'sections' | 'kind' | 'name'> = {
    version: 1,
    fitting: { holder: 'e27', clearance: 0.3, coreDiameter: 30 },
    bulb: 'a60', watts: 6, showBulb: true,
    wiring: { cable: 'round2', route: 'side-exit', exitAngle: 180, exitHeight: 8, grommet: true, switchId: 'inline', switchAngle: 0, switchHeight: 25, drop: 600 },
    base: { ballast: false, feltRecess: 1, legs: 0, legSplay: 18 },
    wall: { plateW: 120, plateH: 160, plateT: 8, plateRadius: 14, armLength: 90, armAngle: 0, armDiameter: 26, keyholes: 2, screw: 'M4' },
    canopy: { diameter: 110, height: 30, holes: 2, hook: false, cluster: 1 },
    pole: { height: 1500, diameter: 32, ceiling: 2600, arms: 2, armLength: 140, jackTravel: 40 },
    lantern: { battery: '18650x1', usb: true, handle: 'bail', handleSize: 90, boxHeight: 40 },
    mount: { pipe: 22.2, clampWidth: 20, clampWall: 5, bolt: 'M4', shim: 0.6, style: 'two-bolt', armLength: 40, tilt: 0, headBattery: true },
    accessories: { ceilingHook: false, wallHook: false, cableClips: 0, sHook: false, reducer: false },
    quality: 'normal', margin: 4,
  };
  switch (kind) {
    case 'wall': return {
      ...base, kind, name: 'Wall sconce',
      wiring: { ...base.wiring, route: 'in-wall' },
      sections: [section({ role: 'shade', name: 'Shade', material: 'PETG Translucent', color: 'Orange', gallery: 0, shape: defaultShape({ silhouette: 'tulip', handles: [0.45, 0.72, 0.92, 1, 0.96, 0.9, 0.86], height: 150, diameter: 150, patterns: [pattern('pleats', { count: 32, depth: 2.5 })] }) })],
    };
    case 'pendant': return {
      ...base, kind, name: 'Pendant', bulb: 'g95',
      wiring: { ...base.wiring, route: 'top' },
      sections: [section({ role: 'shade', name: 'Shade', material: 'PLA Matte', color: 'White', gallery: 1, shape: defaultShape({ silhouette: 'orb', handles: [0.62, 0.86, 0.98, 1, 0.94, 0.72, 0.3], height: 210, diameter: 240, patterns: [pattern('flutes', { count: 20, depth: 4, sharpness: 2 })] }) })],
    };
    case 'floor': return {
      ...base, kind, name: 'Floor lamp',
      base: { ...base.base, ballast: true },
      wiring: { ...base.wiring, route: 'bottom-channel' },
      sections: [
        section({ role: 'base', name: 'Weighted base', material: 'PLA+', color: 'Terracotta Orange', shape: defaultShape({ silhouette: 'cone', handles: [1, 0.92, 0.8, 0.62, 0.42, 0.26, 0.18], height: 70, diameter: 230, wall: 3, innerFollows: false, floor: 3, patterns: [pattern('flutes', { count: 60, depth: 1.5 })] }) }),
        section({ role: 'pole', name: 'Pole', material: 'PLA+', color: 'Terracotta Orange', joint: defaultJoint({ kind: 'thread', length: 16 }), shape: defaultShape({ height: 1300, diameter: 32, wall: 9, innerFollows: false }) }),
        section({ role: 'shade', name: 'Shade', material: 'PETG Translucent', color: 'Arctic', gallery: 0, shape: defaultShape({ silhouette: 'drum', height: 260, diameter: 240, patterns: [flutes] }) }),
      ],
    };
    case 'ceiling': return {
      ...base, kind, name: 'Floor-to-ceiling tension lamp', bulb: 'g80',
      wiring: { ...base.wiring, route: 'side-exit' },
      sections: [
        section({ role: 'base', name: 'Foot', material: 'PLA+', color: 'Army Green', shape: defaultShape({ silhouette: 'flare', handles: [1, 0.8, 0.62, 0.55, 0.52, 0.5, 0.5], height: 50, diameter: 90, wall: 4, innerFollows: false, floor: 3 }) }),
        section({ role: 'pole', name: 'Pole', material: 'PLA+', color: 'Army Green', joint: defaultJoint({ kind: 'bayonet', length: 18 }), shape: defaultShape({ height: 2400, diameter: 36, wall: 10, innerFollows: false, patterns: [pattern('flutes', { count: 12, depth: 1 })] }) }),
        section({ role: 'shade', name: 'Arm shade', material: 'PETG Translucent', color: 'Yellow', gallery: 1, shape: defaultShape({ silhouette: 'bell', handles: [1, 0.86, 0.68, 0.58, 0.54, 0.46, 0.3], height: 140, diameter: 150, patterns: [pattern('pleats', { count: 24, depth: 3 })] }) }),
      ],
    };
    case 'lantern': return {
      ...base, kind, name: 'Battery lantern', bulb: 'puck45', watts: 2,
      fitting: { ...base.fitting, holder: 'battery' },
      wiring: { ...base.wiring, route: 'internal', switchId: 'push12', switchHeight: 20, cable: 'thin' },
      sections: [
        section({ role: 'base', name: 'Battery base', material: 'PLA Matte', color: 'Black', shape: defaultShape({ silhouette: 'cylinder', height: 40, diameter: 110, wall: 2.4, innerFollows: false, floor: 2 }) }),
        section({ role: 'body', name: 'Glow body', material: 'PETG Translucent', color: 'Orange', joint: defaultJoint({ kind: 'bayonet', length: 10 }), shape: defaultShape({ silhouette: 'lantern', handles: [0.86, 0.95, 0.99, 1, 0.99, 0.95, 0.86], height: 160, diameter: 120, patterns: [pattern('rhombo', { count: 10, rows: 7, depth: 3 })] }) }),
        section({ role: 'cap', name: 'Top cap', material: 'PLA Matte', color: 'Black', joint: defaultJoint({ kind: 'snap-ring', length: 8 }), shape: defaultShape({ silhouette: 'dome', handles: [1, 0.98, 0.94, 0.86, 0.74, 0.56, 0.36], height: 30, diameter: 110, wall: 2.4, roof: 2.4 }) }),
      ],
    };
    case 'mount': return {
      ...base, kind, name: 'Handlebar lamp', bulb: 'puck30', watts: 1,
      fitting: { ...base.fitting, holder: 'battery' },
      wiring: { ...base.wiring, route: 'internal', switchId: 'push12', switchHeight: 12, cable: 'thin' },
      sections: [section({ role: 'body', name: 'Lamp head', material: 'PLA+', color: 'Teal Blue', attach: 'stack', shape: defaultShape({ silhouette: 'cone', handles: [0.72, 0.74, 0.78, 0.82, 0.88, 0.94, 1], height: 55, diameter: 48, wall: 2.2, innerFollows: false, floor: 2, patterns: [pattern('cog', { count: 16, depth: 1.2 })] }) })],
    };
    default: return {
      ...base, kind: 'table', name: 'Table lamp',
      sections: [
        section({ role: 'base', name: 'Base', material: 'PLA+', color: 'Terracotta Orange', shape: defaultShape({ silhouette: 'cylinder', height: 140, diameter: 110, wall: 2.4, innerFollows: false, patterns: [pattern('flutes', { count: 36, depth: 2.2, sharpness: 1.6 })] }) }),
        section({ role: 'shade', name: 'Shade', material: 'PLA+', color: 'Terracotta Orange', gallery: 0.12, shape: defaultShape({ silhouette: 'drum', height: 120, diameter: 200, patterns: [pattern('flutes', { count: 56, depth: 2.6, sharpness: 1.6 })] }) }),
      ],
    };
  }
}
