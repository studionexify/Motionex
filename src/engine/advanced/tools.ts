// The Advanced tools the user switches: the 35 technologies grouped by what they do to the print, so
// technologies that do the same job sit behind one toggle. A tool's parts are its technologies; the
// user can untick parts, and an exclusive tool runs exactly one of them. The part analysis passes
// (distance field, topology router) change no toolpath and are always on, so they are not tools.
import type { TechId, ToolId, ToolOverride } from './types';

export type ToolGroup = 'surface' | 'strength' | 'damping' | 'process' | 'special';

export interface ToolDef {
  id: ToolId;
  name: string;
  group: ToolGroup;
  /** What happens to the print when the tool is on. */
  does: string;
  /** Technologies it runs, in the order they are listed. */
  techs: TechId[];
  /** Exactly one technology runs (a mode). */
  exclusive?: boolean;
}

export const TOOL_GROUPS: { id: ToolGroup; title: string }[] = [
  { id: 'surface', title: 'Surface finish' },
  { id: 'strength', title: 'Strength' },
  { id: 'damping', title: 'Vibration & sound' },
  { id: 'process', title: 'Motion & material' },
  { id: 'special', title: 'Special prints' },
];

/** Analysis passes behind every tool: always on, never change the toolpath. */
export const ANALYSIS_TECHS: TechId[] = ['sdf_frep', 'morse_router'];

export const TOOLS: ToolDef[] = [
  {
    id: 'surface_smoothing', name: 'Smooth curved surfaces', group: 'surface',
    does: 'Beads follow the true model surface between layer steps, so slopes, domes and rounded sides show less stair-stepping. These moves leave the layer plane; the print head\'s clearance is checked.',
    techs: ['subvoxel_aa', 'perimeter_feathering', 'conformal_layers', 'conformal_ironing'],
  },
  {
    id: 'curved_layers', name: 'Curved layers', group: 'surface',
    does: 'Whole layers bend instead of staying flat, within the print head\'s clearance: they follow curved tops and tilt to shrink overhangs.',
    techs: ['harmonic_dome', 'sgd_slicing'],
  },
  {
    id: 'seam_hiding', name: 'Hide seams', group: 'surface',
    does: 'The start and end of every outer wall are hidden, so no seam line or zit shows on the surface.',
    techs: ['tangent_entry', 'scarf_splice'],
  },
  {
    id: 'spiral_printing', name: 'Continuous spiral printing', group: 'surface',
    does: 'Paths are joined into continuous spirals: fewer starts, stops, seams and retractions.',
    techs: ['thick_vase', 'eulerian_spiral'],
  },
  {
    id: 'even_walls', name: 'Even inner walls', group: 'surface',
    does: 'Inner walls are smooth, evenly spaced offsets of the outline: no corner spikes or gap-fill zig-zags.',
    techs: ['eikonal_offsets'],
  },
  {
    id: 'gloss_control', name: 'Gloss control', group: 'surface',
    does: 'Sets the outer wall\'s sheen through its print speed and cooling: even all the way up, or matte and glossy where you paint it.',
    techs: ['iso_gloss', 'gloss_modulation'],
  },
  {
    id: 'strength_infill', name: 'Strength infill', group: 'strength',
    does: 'Replaces the regular sparse infill with load-aware patterns, each in the zone it suits: stress lines where the part is loaded, an isotropic core, organic ribs elsewhere.',
    techs: ['fea_stress', 'spinor_fields', 'quasicrystal', 'turing_infill'],
  },
  {
    id: 'layer_bonding', name: 'Layer bonding', group: 'strength',
    does: 'Makes the part stronger between layers, where FDM prints are weakest: hotter layer welds and layers that key into each other.',
    techs: ['hot_on_hot', 'z_weave', 'knot_braiding'],
  },
  {
    id: 'stiffness_target', name: 'Stiffness targeting', group: 'strength',
    does: 'Simulates the infill cell and picks the density (and auxetic angle) that reaches the stiffness and Poisson ratio you set; the other infill tools use that density.',
    techs: ['homogenization'],
  },
  {
    id: 'warp_compensation', name: 'Warp compensation', group: 'strength',
    does: 'Predicts how the part shrinks as it cools and pre-distorts the toolpath the other way, so it cools to its true shape.',
    techs: ['inverse_warp'],
  },
  {
    id: 'material_interlock', name: 'Multi-material interlock', group: 'strength',
    does: 'Where two filaments meet, they interleave as fingers that flip every layer, locking the materials together.',
    techs: ['dovetail'],
  },
  {
    id: 'damping_infill', name: 'Vibration-damping infill', group: 'damping',
    does: 'Infill built to absorb or block vibration and sound instead of only filling space.',
    techs: ['band_gap', 'metamaterial'],
  },
  {
    id: 'motion_compensation', name: 'Motion compensation', group: 'process',
    does: 'Uses the printer\'s motion limits to clean up corners and ringing: even flow where the head slows, crisp sharp corners, less ghosting.',
    techs: ['kinematic_extrusion', 'corner_overshoot', 'symplectic_shaper'],
  },
  {
    id: 'foaming', name: 'Foaming filament control', group: 'process',
    does: 'With a foaming filament (LW-PLA): walls and hubs print cool and solid, cores hot and foamed, and flow follows the expansion.',
    techs: ['foam_control'],
  },
  {
    id: 'special_print', name: 'Special print mode', group: 'special', exclusive: true,
    does: 'Turns the part into a special-purpose print instead of a regular solid. One mode at a time.',
    techs: ['spatial_lattice', 'co_molding', 'metric_morph', 'monge_ampere'],
  },
];

export const TOOL_BY_ID = Object.fromEntries(TOOLS.map((t) => [t.id, t])) as Record<ToolId, ToolDef>;
export const TOOL_OF_TECH: Partial<Record<TechId, ToolDef>> = Object.fromEntries(TOOLS.flatMap((t) => t.techs.map((id) => [id, t])));

/**
 * Technologies a tool runs when it is on: the parts the user ticked, else those the intent turns on,
 * else all of them (the first, for an exclusive tool).
 */
export function toolParts(tool: ToolDef, ov: ToolOverride | undefined, intentParts: TechId[]): TechId[] {
  const own = ov?.parts?.filter((id) => tool.techs.includes(id)) ?? [];
  const parts = own.length ? own : intentParts.length ? intentParts : tool.techs;
  return tool.exclusive ? parts.slice(0, 1) : parts;
}
