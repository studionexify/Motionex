// Registry of the 35 Advanced technologies: what each one is, which intents turn it on, which pipeline
// stage it runs in, its tunable parameters (the "tensor weights" power users edit), and how it adapts
// to the selected machine and filament. Users switch them through the tools in tools.ts.
import type { MachineCaps } from './machine';
import { TOOL_OF_TECH, toolParts, type ToolDef } from './tools';
import type { AdvancedConfig, IntentId, ParamValue, TechId, TechStatus } from './types';

export type Stage = 'fields' | 'layers' | 'regions' | 'walls' | 'infill' | 'post' | 'rheology' | 'motion' | 'route';

export interface ParamSpec {
  key: string;
  label: string;
  type: 'number' | 'bool' | 'enum';
  def: ParamValue;
  min?: number; max?: number; step?: number; unit?: string;
  options?: { value: string; label: string }[];
  tip?: string;
  /** No module reads it in this engine build: hidden in the UI, and a changed value is reported as ignored. */
  unwired?: boolean;
}

export interface MouldContext {
  caps: MachineCaps;
  filamentType: string;
  /** Filament slots in this print and whether objects use more than one. */
  materials: number;
  wallLoops: number;
  hasCaustic: boolean;
}

export interface Verdict { status: Exclude<TechStatus, 'applied' | 'disabled' | 'idle'> | 'ok'; reason?: string }

export interface TechDef {
  id: TechId;
  n: number;
  /** Plain name of what it does (shown as a part of its tool). */
  name: string;
  /** The method's technical name from the NexSpiro compendium (docs/advanced/ENGINE.md). */
  technique: string;
  part: 1 | 2 | 3 | 4 | 5;
  math: string;
  summary: string;
  stage: Stage;
  /** Intents that switch it on by default. Empty: opt-in only. */
  intents: IntentId[];
  /** Fields this technology reads (for the node graph). */
  reads: string[];
  params: ParamSpec[];
  mould(ctx: MouldContext): Verdict;
}

const ok: Verdict = { status: 'ok' };
const slopeLimited = (what: string) => (c: MouldContext): Verdict => (c.caps.axes >= 5 ? ok
  : c.caps.maxSlopeDeg < 3 ? { status: 'unavailable', reason: `The print head leaves no room for ${what} (clearance ${c.caps.maxSlopeDeg.toFixed(1)}°).` }
    : { status: 'adapted', reason: `${what[0].toUpperCase()}${what.slice(1)} limited to ${c.caps.maxSlopeDeg.toFixed(0)}° slopes by ${c.caps.toolhead.name}.` });
const HIGH_SHRINK = /ABS|ASA|PC|PA|NYLON|PP/i;
const FOAMING = /LW|FOAM|AERO/i;

const ALL: IntentId[] = ['structural', 'aesthetic', 'optical', 'acoustic', 'morph4d'];

export const TECHS: TechDef[] = [
  // ---------------- Part I
  {
    id: 'fea_stress', n: 1, name: 'Stress-line infill', technique: 'FEA stress-aligned vector fields', part: 1, math: 'Linear elasticity FEA, principal stress σ, RK4 streamlines', stage: 'infill',
    summary: 'Solves the part under its load case and lays infill along the principal stress directions.',
    intents: ['structural'], reads: ['sdf', 'stress'],
    params: [
      { key: 'elements', label: 'FEA elements (max)', type: 'number', def: 4000, min: 500, max: 40000, step: 500, tip: 'Hexahedral elements in the voxel FEA model.' },
      { key: 'loadN', label: 'Load', type: 'number', def: 50, min: 1, max: 5000, step: 1, unit: 'N', tip: 'Total force of the inferred or painted load case.' },
      { key: 'family', label: 'Path family', type: 'enum', def: 'both', options: [{ value: 'max', label: 'Tension (σ₁)' }, { value: 'min', label: 'Compression (σ₃)' }, { value: 'both', label: 'Both, alternating layers' }] },
      { key: 'threshold', label: 'Stress percentile', type: 'number', def: 0.4, min: 0, max: 1, step: 0.05, tip: 'Infill below this von Mises percentile keeps the regular pattern.' },
    ],
    mould: () => ok,
  },
  {
    id: 'sdf_frep', n: 2, name: 'Part distance field', technique: 'Implicit SDF slicing & F-Reps', part: 1, math: 'Signed distance f(x,y,z)=0, fast sweeping, marching squares', stage: 'fields',
    summary: 'Turns each mesh into a signed distance field; graded F-rep (TPMS) infill is sliced directly from its implicit equation.',
    intents: ALL, reads: [],
    params: [
      { key: 'tpms', label: 'Graded TPMS infill', type: 'enum', def: 'off', unwired: true, options: [{ value: 'off', label: 'Off' }, { value: 'gyroid', label: 'Gyroid' }, { value: 'schwarz_p', label: 'Schwarz P' }, { value: 'diamond', label: 'Diamond' }] },
      { key: 'cell', label: 'TPMS cell', type: 'number', def: 8, unwired: true, min: 2, max: 30, step: 0.5, unit: 'mm' },
      { key: 'grade', label: 'Skin grading depth', type: 'number', def: 4, unwired: true, min: 0, max: 20, step: 0.5, unit: 'mm', tip: 'TPMS walls thicken towards the skin over this depth.' },
    ],
    mould: () => ok,
  },
  {
    id: 'eulerian_spiral', n: 3, name: 'Spiral infill', technique: 'Eulerian continuous spiralization', part: 1, math: 'Connected Fermat/concentric spirals, width modulation', stage: 'infill',
    summary: 'Joins concentric rings into one unbroken spiral per island and widens the last ring instead of gap fill.',
    intents: ['aesthetic', 'optical'], reads: ['regions'],
    params: [
      { key: 'minW', label: 'Min width', type: 'number', def: 0.3, min: 0.1, max: 2, step: 0.01, unit: 'mm' },
      { key: 'maxW', label: 'Max width', type: 'number', def: 1.2, min: 0.2, max: 3, step: 0.01, unit: 'mm' },
    ],
    mould: (c) => (1.2 > c.caps.nozzle * 2.5 ? { status: 'adapted', reason: `Line width kept within ${(c.caps.nozzle * 0.75).toFixed(2)}–${(c.caps.nozzle * 2.5).toFixed(2)} mm for a ${c.caps.nozzle} mm nozzle.` } : ok),
  },
  {
    id: 'conformal_layers', n: 4, name: 'Curved top skins', technique: 'Non-planar conformal & geodesic layering', part: 1, math: 'Manifold offsets S_d, projected geodesics, clearance cone', stage: 'post',
    summary: 'Drapes the last top-skin layers over curved tops so the lines follow the surface.',
    intents: ['aesthetic'], reads: ['sdf', 'heightmap'],
    params: [
      { key: 'layers', label: 'Conformal layers', type: 'number', def: 3, unwired: true, min: 1, max: 8, step: 1 },
    ],
    mould: slopeLimited('curved top skins'),
  },
  {
    id: 'hot_on_hot', n: 5, name: 'Hot layer welds', technique: 'Transient thermal "hot-on-hot" planning', part: 1, math: '∂T/∂t = α∇²T (1D bead stack), interface temperature', stage: 'rheology',
    summary: 'Predicts the temperature the next layer lands on and tunes fan and layer time to keep it above the glass transition, so layers weld.',
    intents: ['structural', 'optical', 'acoustic', 'morph4d'], reads: ['layer_times'],
    params: [
      { key: 'margin', label: 'Weld margin over Tg', type: 'number', def: 15, min: 0, max: 80, step: 1, unit: '°C' },
      { key: 'maxFanCut', label: 'Max fan reduction', type: 'number', def: 0.6, min: 0, max: 1, step: 0.05 },
    ],
    mould: (c) => (c.caps.heatedChamber ? { status: 'adapted', reason: `Heated chamber at ${c.caps.chamberTemp} °C is the ambient of the thermal model.` } : ok),
  },
  {
    id: 'kinematic_extrusion', n: 6, name: 'Corner flow control', technique: 'Kinematics-coupled dynamic extrusion', part: 1, math: 'Trapezoidal look-ahead planner, junction deviation, pressure model', stage: 'motion',
    summary: 'Runs the printer\'s motion planner inside the slicer and tapers flow where the head slows at corners.',
    intents: ALL, reads: ['moves'],
    params: [
      { key: 'paK', label: 'Melt pressure lag K', type: 'number', def: 0.04, min: 0, max: 0.5, step: 0.005, unit: 's' },
    ],
    mould: (c) => (c.caps.pressureAdvance ? { status: 'adapted', reason: 'Firmware pressure advance handles corner flow; NexSpiro plans per-feature acceleration and corner speed only.' } : ok),
  },
  // ---------------- Part II
  {
    id: 'z_weave', n: 7, name: 'Z-wave interlock', technique: 'Sinusoidal Z-weaving & Z-pinning', part: 2, math: 'z = z₀ + A sin(ωs), alternating phase; vertical polymer rivets', stage: 'post',
    summary: 'Interlocks layers with an alternating vertical wave in inner walls and infill, and drives polymer pins through stacked voids.',
    intents: ['structural'], reads: ['moves'],
    params: [
      { key: 'amp', label: 'Amplitude (× layer h)', type: 'number', def: 0.25, min: 0.05, max: 0.45, step: 0.01 },
      { key: 'wavelength', label: 'Wavelength', type: 'number', def: 4, min: 1, max: 20, step: 0.5, unit: 'mm' },
      { key: 'pins', label: 'Z-pins', type: 'bool', def: false, tip: 'Opt-in. Dives the nozzle into stacked voids and fills them with a vertical column of plastic.' },
      { key: 'pinPitch', label: 'Pin pitch', type: 'number', def: 8, min: 3, max: 30, step: 0.5, unit: 'mm' },
    ],
    mould: (c) => (c.caps.maxAccelZ < 50 || c.caps.maxSpeedZ < 3 ? { status: 'unavailable', reason: 'Z axis too slow for weaving.' }
      : { status: 'adapted', reason: `Woven segments slowed to the Z axis limits (${c.caps.maxAccelZ} mm/s², ${c.caps.maxSpeedZ} mm/s); pins at most ${Math.floor(c.caps.maxNonPlanarDepth / 0.2)} layers deep (nozzle tip ${c.caps.toolhead.nozzle.tip_len} mm).` }),
  },
  {
    id: 'subvoxel_aa', n: 8, name: 'Sloped-wall smoothing', technique: 'Sub-voxel anti-aliasing', part: 2, math: 'Coupled Z + E modulation along perimeters', stage: 'post',
    summary: 'Lowers the outer wall under shallow slopes to the true surface height, with matching flow, inside the layer.',
    intents: ['aesthetic', 'optical'], reads: ['heightmap'],
    params: [
      { key: 'maxSlope', label: 'Up to slope', type: 'number', def: 35, min: 5, max: 60, step: 1, unit: '°' },
      { key: 'minH', label: 'Thinnest bead', type: 'number', def: 0.04, min: 0.02, max: 0.2, step: 0.01, unit: 'mm' },
    ],
    mould: () => ok,
  },
  {
    id: 'turing_infill', n: 9, name: 'Organic rib infill', technique: 'Anisotropic Gray-Scott Turing infill', part: 2, math: '∂u/∂t = ∇·(D_u∇u) − uv² + F(1−u); ∂v/∂t = ∇·(D_v∇v) + uv² − (F+k)v', stage: 'infill',
    summary: 'Grows bone-like ribs from a reaction–diffusion pattern stretched along the load paths, denser around bolt holes.',
    intents: ['structural'], reads: ['stress', 'bosses'],
    params: [
      { key: 'F', label: 'Feed F', type: 'number', def: 0.037, min: 0.01, max: 0.08, step: 0.001 },
      { key: 'k', label: 'Kill k', type: 'number', def: 0.06, min: 0.03, max: 0.07, step: 0.001 },
      { key: 'aniso', label: 'Anisotropy β', type: 'number', def: 0.6, min: 0, max: 0.95, step: 0.05, tip: 'D = D₀(I + β d⊗d) along the stress or boundary direction.' },
      { key: 'scale', label: 'Pattern scale', type: 'number', def: 1, min: 0.4, max: 3, step: 0.05, tip: '1 = rib spacing matched to the sparse infill density.' },
    ],
    mould: () => ok,
  },
  {
    id: 'corner_overshoot', n: 10, name: 'Sharp-corner overshoot', technique: 'Viscoelastic corner-overshoot compensation', part: 2, math: 'Die swell + drag catenary inward pull', stage: 'post',
    summary: 'Swings the nozzle slightly past sharp outer corners with a brief flow dip so the bead lands on the corner.',
    intents: ['aesthetic', 'structural'], reads: ['moves'],
    params: [
      { key: 'gain', label: 'Drag gain', type: 'number', def: 1, min: 0, max: 3, step: 0.1 },
      { key: 'minAngle', label: 'Corners sharper than', type: 'number', def: 60, min: 20, max: 150, step: 5, unit: '°' },
    ],
    mould: (c) => (c.caps.pressureAdvance ? { status: 'adapted', reason: 'Overshoot reduced: pressure advance already trims the corner bulge.' } : ok),
  },
  {
    id: 'spatial_lattice', n: 11, name: 'Wire truss', technique: 'Mid-air spatial lattice weaving', part: 2, math: 'Octahedral truss, tensioned free-space XYZ draws', stage: 'post',
    summary: 'Prints the part as a free-standing 3D wire truss (anchor dwell, cooled diagonal draws). Opt-in: it replaces the solid part.',
    intents: [], reads: ['sdf'],
    params: [
      { key: 'cell', label: 'Cell height', type: 'number', def: 6, min: 2, max: 20, step: 0.5, unit: 'mm' },
      { key: 'flow', label: 'Draw flow', type: 'number', def: 0.85, min: 0.5, max: 1.2, step: 0.01 },
      { key: 'speed', label: 'Draw speed', type: 'number', def: 8, min: 2, max: 30, step: 1, unit: 'mm/s' },
      { key: 'dwell', label: 'Anchor dwell', type: 'number', def: 0.6, min: 0, max: 3, step: 0.1, unit: 's' },
    ],
    mould: (c) => ({ status: 'adapted', reason: `Truss pitch set from the heater block (${c.caps.toolhead.name}) so the head clears printed struts.` }),
  },
  {
    id: 'metamaterial', n: 12, name: 'Auxetic cell infill', technique: 'Voxel metamaterial & acoustic grading', part: 2, math: 'Re-entrant auxetic cells, golden-ratio phase dithering', stage: 'infill',
    summary: 'Auxetic (negative Poisson ratio) cells, thinner where the part is lightly loaded and irregularly spaced so resonances scatter.',
    intents: ['acoustic'], reads: ['compliance'],
    params: [
      { key: 'cell', label: 'Cell size', type: 'number', def: 6, min: 2, max: 20, step: 0.5, unit: 'mm' },
      { key: 'angle', label: 'Re-entrant angle', type: 'number', def: 60, min: 30, max: 85, step: 1, unit: '°' },
      { key: 'dither', label: 'Phase dithering', type: 'number', def: 0.35, min: 0, max: 1, step: 0.05 },
    ],
    mould: () => ok,
  },
  {
    id: 'dovetail', n: 13, name: 'Material finger joint', technique: 'Interfacial multi-material dovetailing', part: 2, math: 'Alternating-phase T-slot / fractal boundary waves', stage: 'regions',
    summary: 'Interleaves fingers across material boundaries, flipping phase each layer, for a mechanical lock.',
    intents: ['structural'], reads: ['materials'],
    params: [
      { key: 'depth', label: 'Finger depth', type: 'number', def: 1.2, min: 0.4, max: 5, step: 0.1, unit: 'mm' },
      { key: 'pitch', label: 'Finger pitch', type: 'number', def: 3, min: 1, max: 12, step: 0.5, unit: 'mm' },
    ],
    mould: (c) => (c.caps.multiMaterial === 'manual' ? { status: 'unavailable', reason: 'Needs automatic material changes (AMS or tool changer): manual swaps every layer are impractical.' } : ok),
  },
  // ---------------- Part III
  {
    id: 'sgd_slicing', n: 14, name: 'Overhang-reducing layers', technique: 'Differentiable SGD slicing', part: 3, math: 'L(Θ) = w₁L_overhang + w₂L_collision + w₃L_anisotropy + w₄L_error, Adam on B-splines', stage: 'layers',
    summary: 'Tilts layers where that shrinks overhangs, optimised so the print head never reaches into the part.',
    intents: ['aesthetic'], reads: ['sdf', 'overhang'],
    params: [
      { key: 'w1', label: 'w₁ overhang', type: 'number', def: 1, min: 0, max: 10, step: 0.1 },
      { key: 'w2', label: 'w₂ collision', type: 'number', def: 4, min: 0, max: 20, step: 0.1 },
      { key: 'w3', label: 'w₃ anisotropy', type: 'number', def: 0.3, min: 0, max: 10, step: 0.1 },
      { key: 'w4', label: 'w₄ error', type: 'number', def: 1, min: 0, max: 10, step: 0.1 },
      { key: 'iters', label: 'Iterations', type: 'number', def: 200, min: 10, max: 2000, step: 10 },
      { key: 'ctrl', label: 'Control points', type: 'number', def: 8, min: 3, max: 24, step: 1 },
    ],
    mould: slopeLimited('overhang-reducing layers'),
  },
  {
    id: 'eikonal_offsets', n: 15, name: 'Smooth wall offsets', technique: 'Eikonal wavefront & heat-method offsets', part: 3, math: '|∇φ| = 1/f (fast marching), ∂u/∂t = Δu (heat method)', stage: 'walls',
    summary: 'Inner walls from PDE distance fields: smooth (C²) offsets with no medial-axis spikes or gap-fill zig-zags.',
    intents: ['aesthetic', 'structural', 'optical', 'acoustic'], reads: ['regions'],
    params: [
      { key: 'method', label: 'Solver', type: 'enum', def: 'heat', options: [{ value: 'heat', label: 'Heat method' }, { value: 'fmm', label: 'Fast marching' }] },
      { key: 'smooth', label: 'Smoothing (heat time ×h²)', type: 'number', def: 2, min: 0.5, max: 20, step: 0.5 },
      { key: 'cell', label: 'Grid cell', type: 'number', def: 0.1, min: 0.03, max: 0.5, step: 0.01, unit: 'mm' },
    ],
    mould: () => ok,
  },
  {
    id: 'inverse_warp', n: 16, name: 'Shrinkage pre-distortion', technique: 'Inverse thermal-shrinkage warping', part: 3, math: 'Inherent-strain thermo-elastic FEA, x′ = x − u(x)', stage: 'post',
    summary: 'Simulates cooling shrinkage, pre-distorts the toolpath by the inverse displacement and cuts stress-relief kerfs in thick walls.',
    intents: ['structural'], reads: ['sdf', 'displacement'],
    params: [
      { key: 'gain', label: 'Compensation', type: 'number', def: 1, min: 0, max: 2, step: 0.05 },
      { key: 'kerfs', label: 'Relief kerfs', type: 'bool', def: true },
      { key: 'elements', label: 'FEA elements (max)', type: 'number', def: 3000, min: 500, max: 40000, step: 500 },
    ],
    mould: (c) => (HIGH_SHRINK.test(c.filamentType) ? (c.caps.heatedChamber ? ok : { status: 'adapted', reason: `No heated chamber: ${c.filamentType} cools from Tg to ${c.caps.chamberTemp} °C, so the predicted warp is larger.` })
      : { status: 'adapted', reason: `${c.filamentType} shrinks little; compensation is small.` }),
  },
  {
    id: 'gloss_modulation', n: 17, name: 'Painted matte / gloss', technique: 'Shear-induced optical & gloss modulation', part: 3, math: 'Wall shear τ_w = K((3n+1)/4n · 4Q/πR³)ⁿ, cooling rate', stage: 'rheology',
    summary: 'Prints matte or glossy areas (painted) from one spool by setting shear rate and cooling along the outer wall.',
    intents: ['optical'], reads: ['gloss_paint'],
    params: [
      { key: 'contrast', label: 'Contrast', type: 'number', def: 0.7, min: 0, max: 1, step: 0.05 },
    ],
    mould: () => ok,
  },
  {
    id: 'foam_control', n: 18, name: 'Foam temperature control', technique: 'Thermodynamic cellular foaming', part: 3, math: 'Expansion X(T), first-order heater observer, look-ahead', stage: 'rheology',
    summary: 'Solid hubs and foamed cores in one print: temperature is scheduled ahead of each zone and flow follows the predicted expansion.',
    intents: ['acoustic', 'structural'], reads: ['zones'],
    params: [
      { key: 'coreTemp', label: 'Core temperature', type: 'number', def: 250, min: 200, max: 290, step: 1, unit: '°C' },
      { key: 'hubTemp', label: 'Hub temperature', type: 'number', def: 200, min: 180, max: 260, step: 1, unit: '°C' },
      { key: 'xmax', label: 'Max expansion', type: 'number', def: 2.8, min: 1, max: 4, step: 0.1 },
    ],
    mould: (c) => (FOAMING.test(c.filamentType) ? { status: 'adapted', reason: `Temperature look-ahead uses the hotend time constant (${c.caps.heaterTau} s).` } : { status: 'unavailable', reason: `${c.filamentType} does not foam: choose a foaming filament (LW-PLA).` }),
  },
  {
    id: 'knot_braiding', n: 19, name: 'Braided inner walls', technique: 'Topological knot-theory braiding', part: 3, math: 'Lissajous strand exchange, alternating over/under crossings', stage: 'post',
    summary: 'Braids two inner walls around each other: they swap sides at every crossing and alternate over/under each layer.',
    intents: ['structural'], reads: ['walls'],
    params: [
      { key: 'pitch', label: 'Crossing pitch', type: 'number', def: 6, min: 2, max: 20, step: 0.5, unit: 'mm' },
      { key: 'lift', label: 'Over-crossing lift (× h)', type: 'number', def: 0.5, min: 0.1, max: 0.8, step: 0.05 },
    ],
    mould: (c) => (c.wallLoops < 3 ? { status: 'unavailable', reason: 'Needs at least 3 walls (the outer wall is never braided).' } : ok),
  },
  {
    id: 'co_molding', n: 20, name: 'Casting shell', technique: 'In-situ sacrificial co-molding', part: 3, math: 'Hermetic shell, perforated vascular columns, injection & vent ports', stage: 'regions',
    summary: 'Prints a sealed shell with vascular support columns and injection/vent ports for casting epoxy or low-melt alloy. Opt-in.',
    intents: [], reads: ['sdf'],
    params: [
      { key: 'port', label: 'Port diameter', type: 'number', def: 4, min: 1.5, max: 12, step: 0.5, unit: 'mm' },
      { key: 'columnPitch', label: 'Column pitch', type: 'number', def: 12, min: 5, max: 40, step: 1, unit: 'mm' },
      { key: 'columnR', label: 'Column radius', type: 'number', def: 1.6, min: 0.8, max: 5, step: 0.1, unit: 'mm' },
    ],
    mould: () => ok,
  },
  // ---------------- Part IV
  {
    id: 'thick_vase', n: 21, name: 'Helical layers', technique: 'Multi-perimeter helical "thick-vase"', part: 4, math: 'Coupled helix H(t) with dz/dt > 0 across walls and infill', stage: 'post',
    summary: 'In steady single-island bands every wall and the infill climb as one helix: no seams, no retractions.',
    intents: ['aesthetic', 'optical'], reads: ['helical_bands'],
    params: [],
    mould: () => ok,
  },
  {
    id: 'tangent_entry', n: 22, name: 'Spiral seam entry', technique: 'Sub-surface tangential spiral entry', part: 4, math: 'Archimedean ramp r = a + bθ, <3° tangent merge', stage: 'post',
    summary: 'Starts and ends outer walls inside the part on a spiral that merges tangentially, so pressure transients stay hidden.',
    intents: ['aesthetic'], reads: ['regions'],
    params: [
      { key: 'radius', label: 'Spiral radius', type: 'number', def: 0.8, min: 0.2, max: 3, step: 0.1, unit: 'mm' },
      { key: 'merge', label: 'Merge angle', type: 'number', def: 3, min: 1, max: 15, step: 0.5, unit: '°' },
    ],
    mould: () => ok,
  },
  {
    id: 'scarf_splice', n: 23, name: 'Scarf seam joint', technique: '3D volumetric scarf-wedge splice', part: 4, math: 'E(s) = E_max(3(s/L)² − 2(s/L)³), thermal re-melt', stage: 'post',
    summary: 'Overlaps each outer loop\'s start and end as complementary wedges, slowed with the fan off to re-melt the joint.',
    intents: ['aesthetic', 'optical'], reads: ['moves'],
    params: [
      { key: 'length', label: 'Scarf length', type: 'number', def: 12, min: 2, max: 40, step: 0.5, unit: 'mm' },
      { key: 'slow', label: 'Closure speed', type: 'number', def: 0.6, min: 0.2, max: 1, step: 0.05 },
      { key: 'fanOffMs', label: 'Fan off', type: 'number', def: 150, min: 0, max: 1000, step: 10, unit: 'ms' },
    ],
    mould: () => ok,
  },
  {
    id: 'harmonic_dome', n: 24, name: 'Dome-following layers', technique: 'Harmonic scalar field dome slicing', part: 4, math: '∇²φ = 0, φ = 0 on the bed, φ = 1 on the dome', stage: 'layers',
    summary: 'Layers start flat on the bed and morph into shells parallel to curved tops, within the head\'s clearance.',
    intents: ['aesthetic', 'optical'], reads: ['sdf', 'harmonic'],
    params: [
      { key: 'band', label: 'Morph band', type: 'number', def: 0, min: 0, max: 200, step: 0.5, unit: 'mm', tip: 'Height over which layers morph from flat to conformal. 0 = automatic (dome height + 2 mm).' },
      { key: 'minRatio', label: 'Thinnest layer (× h)', type: 'number', def: 0.5, min: 0.2, max: 1, step: 0.05 },
      { key: 'maxRatio', label: 'Thickest layer (× h)', type: 'number', def: 1.5, min: 1, max: 2.5, step: 0.05 },
    ],
    mould: slopeLimited('dome-following layers'),
  },
  {
    id: 'conformal_ironing', n: 25, name: 'Curved-surface ironing', technique: '3D conformal ironing', part: 4, math: 'Normal-following XYZ spiral burnishing', stage: 'post',
    summary: 'A final low-flow spiral pass that rides the true CAD surface on domes and slopes.',
    intents: ['aesthetic', 'optical'], reads: ['heightmap'],
    params: [
      { key: 'flow', label: 'Flow', type: 'number', def: 0.015, min: 0, max: 0.1, step: 0.005 },
      { key: 'spacing', label: 'Spacing', type: 'number', def: 0.15, min: 0.05, max: 0.5, step: 0.01, unit: 'mm' },
      { key: 'speed', label: 'Speed', type: 'number', def: 30, min: 5, max: 120, step: 1, unit: 'mm/s' },
    ],
    mould: slopeLimited('curved-surface ironing'),
  },
  {
    id: 'perimeter_feathering', n: 26, name: 'Rounded-side shingling', technique: 'Normal-aligned perimeter feathering', part: 4, math: 'Shingled outer ribbon following the surface normal', stage: 'post',
    summary: 'Drops the outer bead onto the true surface on rounded sides so each layer overlaps the one below like a shingle.',
    intents: ['aesthetic'], reads: ['sdf'],
    params: [
      { key: 'depth', label: 'Max drop (× h)', type: 'number', def: 0.5, min: 0.1, max: 0.9, step: 0.05 },
    ],
    mould: slopeLimited('rounded-side shingling'),
  },
  {
    id: 'iso_gloss', n: 27, name: 'Even sheen', technique: 'Iso-thermal velocity gloss mapping', part: 4, math: 'Invariant τ_w and Δt_cool on the outer wall', stage: 'rheology',
    summary: 'Keeps outer-wall speed and cooling constant all the way up; cooling slowdowns go to infill, travel or fan.',
    intents: ['aesthetic', 'optical'], reads: ['layer_times'],
    params: [
      { key: 'fanGamma', label: 'Fan response γ', type: 'number', def: 0.6, min: 0, max: 2, step: 0.05 },
    ],
    mould: () => ok,
  },
  // ---------------- Part V
  {
    id: 'quasicrystal', n: 28, name: 'Isotropic core infill', technique: '6D cut-and-project quasicrystal infill', part: 5, math: 'ℤ⁶ → ℝ³ icosahedral projection, triacontahedral window, Ammann planes', stage: 'infill',
    summary: 'Aperiodic infill planes with no repeating weak plane to split along: near-equal stiffness in every direction.',
    intents: ['structural'], reads: ['core'],
    params: [
      { key: 'spacing', label: 'Mean plane spacing', type: 'number', def: 0, min: 0, max: 20, step: 0.1, unit: 'mm', tip: '0 = from the sparse infill density.' },
      { key: 'maxTilt', label: 'Max plane tilt', type: 'number', def: 45, min: 20, max: 60, step: 1, unit: '°' },
    ],
    mould: () => ok,
  },
  {
    id: 'metric_morph', n: 29, name: 'Heat-morph sheet', technique: 'Riemannian metric tensor slicing (4D)', part: 5, math: 'g_ij target metric, prestrain eigen-directions, geodesic foliation', stage: 'route',
    summary: 'Prints a flat sheet whose bead directions encode the target surface\'s metric, so it buckles into the shape when heated.',
    intents: ['morph4d'], reads: ['metric'],
    params: [
      { key: 'shrink', label: 'Bead shrink when heated', type: 'number', def: 0.7, min: 0.4, max: 0.95, step: 0.01, tip: 'Length ratio of a fast-printed PLA bead after heating above Tg.' },
      { key: 'layers', label: 'Sheet layers', type: 'number', def: 4, min: 2, max: 10, step: 1 },
    ],
    mould: (c) => (/PLA/i.test(c.filamentType) ? ok : { status: 'adapted', reason: `${c.filamentType} holds less prestrain than PLA; the shape change will be smaller.` }),
  },
  {
    id: 'monge_ampere', n: 30, name: 'Caustic lens / lampshade', technique: 'Monge–Ampère optical & acoustic lenses', part: 5, math: 'det(∇²φ) = f/g(∇φ), optimal transport, Snell refraction', stage: 'route',
    summary: 'Computes a transport map from the lamp light to a target image and turns it into lens heights or lampshade bead widths.',
    intents: ['optical'], reads: ['caustic_image'],
    params: [
      { key: 'ior', label: 'Refractive index', type: 'number', def: 1.57, min: 1.3, max: 1.8, step: 0.01 },
      { key: 'iters', label: 'Transport iterations', type: 'number', def: 120, min: 20, max: 1000, step: 10 },
    ],
    mould: (c) => (c.hasCaustic ? ok : { status: 'unavailable', reason: 'Load a target image under Caustic target (Optical / Caustic Lamp intent).' }),
  },
  {
    id: 'symplectic_shaper', n: 31, name: 'Anti-ringing timing', technique: 'Symplectic phase-space trajectory compilation', part: 5, math: 'H = p²/2m + k(q − q_cmd)²/2, Störmer–Verlet, SE(3) poses', stage: 'motion',
    summary: 'Simulates frame ringing and times accelerations to whole resonance periods, so ghosting cancels out.',
    intents: ALL, reads: ['moves'],
    params: [
      { key: 'tolerance', label: 'Ringing tolerance', type: 'number', def: 0.02, min: 0.002, max: 0.2, step: 0.002, unit: 'mm' },
    ],
    mould: (c) => (c.caps.inputShaper ? { status: 'adapted', reason: 'Firmware input shaping is on: NexSpiro only times accelerations to the resonance period and smooths corners (no double shaping).' } : ok),
  },
  {
    id: 'morse_router', n: 32, name: 'Part topology analysis', technique: 'Morse–Smale complex & persistent homology', part: 5, math: 'Reeb graph, critical points, 0/1-dim persistence', stage: 'route',
    summary: 'Splits the part into topological branches and routes each sub-volume to the right solvers.',
    intents: ALL, reads: ['harmonic', 'sections'],
    params: [
      { key: 'persistence', label: 'Persistence threshold', type: 'number', def: 1.5, min: 0, max: 20, step: 0.1, unit: 'mm' },
    ],
    mould: (c) => (c.caps.axes >= 5 ? ok : { status: 'adapted', reason: 'Branches are routed to curved layers or support on this 3-axis printer (multi-axis reorientation needs rotary axes).' }),
  },
  {
    id: 'spinor_fields', n: 33, name: 'Stress-line smoothing', technique: 'Clifford algebra spinor field slicing', part: 5, math: 'Cl(3,0) rotors, double cover, ±½ defects, Hopf map S³→S²', stage: 'fields',
    summary: 'Smooths the stress-line directions and moves their singular points into holes, so the paths do not kink.',
    intents: ['structural', 'morph4d'], reads: ['stress'],
    params: [
      { key: 'smooth', label: 'Smoothing passes', type: 'number', def: 12, min: 0, max: 100, step: 1 },
    ],
    mould: (c) => (c.caps.continuousFiber ? ok : { status: 'adapted', reason: 'No continuous-fiber head: defect-free paths steer the polymer beads.' }),
  },
  {
    id: 'band_gap', n: 34, name: 'Band-gap lattice', technique: 'Topological band-gap infill', part: 5, math: 'Bloch–Floquet dispersion, Berry curvature, (valley) Chern numbers', stage: 'infill',
    summary: 'Fills the core with a resonator lattice whose band gap blocks the target vibration frequency.',
    intents: ['acoustic'], reads: ['core'],
    params: [
      { key: 'freq', label: 'Target frequency', type: 'number', def: 800, min: 50, max: 20000, step: 10, unit: 'Hz' },
      { key: 'valley', label: 'Valley-Hall edge channel', type: 'bool', def: false },
    ],
    mould: () => ok,
  },
  {
    id: 'homogenization', n: 35, name: 'Stiffness-matched cells', technique: '6D elasticity tensor homogenization', part: 5, math: 'Periodic unit-cell FEA → C^H_ijkl (6×6 Voigt), inverse design', stage: 'fields',
    summary: 'Simulates the infill cell\'s stiffness and picks its density (and auxetic angle) to hit the target stiffness and Poisson ratio.',
    intents: ['acoustic', 'structural'], reads: ['zones'],
    params: [
      { key: 'targetE', label: 'Target stiffness (× solid)', type: 'number', def: 0.2, min: 0.02, max: 0.9, step: 0.01 },
      { key: 'targetNu', label: 'Target Poisson ratio', type: 'number', def: 0.3, min: -0.8, max: 0.45, step: 0.01 },
    ],
    mould: () => ok,
  },
];

export const TECH_BY_ID = Object.fromEntries(TECHS.map((t) => [t.id, t])) as Record<TechId, TechDef>;

export const INTENTS: { id: IntentId; name: string; blurb: string }[] = [
  { id: 'structural', name: 'Structural Armor', blurb: 'Strong functional parts: load-aware infill, layers that lock together, and warp compensation.' },
  { id: 'aesthetic', name: 'Seamless Aesthetic', blurb: 'Clean visible surfaces: no seams, no stair-stepping on curves, even sheen.' },
  { id: 'optical', name: 'Optical / Caustic Lamp', blurb: 'Lamps and lenses: project an image with light, clear seamless walls, gloss control.' },
  { id: 'acoustic', name: 'Acoustic Damping', blurb: 'Parts that absorb vibration and sound: damping infill, tuned stiffness, foamed cores.' },
  { id: 'morph4d', name: '4D Flat-Morph', blurb: 'Prints a flat sheet that curls into the model\'s shape when warmed.' },
];

export interface ResolvedTech { def: TechDef; enabled: boolean; params: Record<string, ParamValue>; verdict: Verdict }

/** A tool's technologies that the intent turns on by default. */
export const intentParts = (tool: ToolDef, intent: IntentId): TechId[] => tool.techs.filter((id) => TECH_BY_ID[id].intents.includes(intent));

/** Which technologies run for this config on this machine, with their parameters. */
export function resolveTechs(cfg: AdvancedConfig, ctx: MouldContext): ResolvedTech[] {
  return TECHS.map((def) => {
    const ov = cfg.techs[def.id];
    // a tool switch wins over the technology's own switch, which wins over the intent default
    const tool = TOOL_OF_TECH[def.id], tov = tool && cfg.tools?.[tool.id];
    const enabled = tov ? tov.enabled && toolParts(tool, tov, intentParts(tool, cfg.intent)).includes(def.id) : ov?.enabled ?? def.intents.includes(cfg.intent);
    const params: Record<string, ParamValue> = {};
    for (const p of def.params) params[p.key] = ov?.params?.[p.key] ?? p.def;
    return { def, enabled, params, verdict: def.mould(ctx) };
  });
}
