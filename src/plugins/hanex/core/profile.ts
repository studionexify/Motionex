// Hanex print profile: everything the wave planner and the G-code writer need, plus the derived
// quantities (wave spacing, grid step, trigger width) with the formulas in one place.

export type SeedMode = 'point' | 'edge' | 'auto';

/** Physical print-head dimensions that bound what Hanex can do. */
export interface ToolheadGeometry {
  /** Nozzle bore, mm. */
  nozzleDiameter: number;
  /** Outer diameter of the flat land at the nozzle tip, mm (presses the bead onto the previous arc). */
  tipFlatDiameter: number;
}

export interface HanexProfile {
  id: string;
  name: string;
  material: string;
  toolhead: ToolheadGeometry;
  filamentDiameter: number;
  /** Bead width of a wave arc, mm. */
  lineWidth: number;
  /** Thickness of the wave sheet, mm (usually the layer height). */
  sheetHeight: number;
  /** Fraction of a bead shared with the previous arc: Δd = lineWidth·(1 − overlap). */
  overlap: number;
  /** Extrusion multiplier on the volumetric model (calibrated with HNX-03). */
  flowRatio: number;
  /** Curvature flow modulation: flow = nominal·clamp(R/rNominal, flowFloor, 1). */
  rNominal: number;
  flowFloor: number;
  /** mm/s */
  waveSpeed: number;
  rimSpeed: number;
  travelSpeed: number;
  /** Part-cooling fan PWM 0–255 while printing waves. */
  fan: number;
  /** Arc length each arc runs onto solid anchor at its ends, mm. */
  leadIn: number;
  seedMode: SeedMode;
  /** Point mode: the source sits this far inside the anchor, so the first arc in the air already has this radius. */
  startRadius: number;
  /** Print the free edge of the overhang as a rim after the waves (tacked onto the arc ends). */
  rim: boolean;
  retractLength: number;
  retractSpeed: number;
  zHop: number;
  /**
   * Unsupported width (mm) a normal bead can bridge by squish alone. Overhang bands narrower than
   * the trigger width are left to the normal slicer.
   */
  supportReach: number;
  /** Wave layers above this many mm of unsupported width; default max(2·lineWidth, tip land). */
  triggerWidth?: number;
  /** Grid step of the distance field, mm; default from waveStep(). */
  gridStep?: number;
}

/** Spacing between successive wavefronts, Δd = w·(1 − overlap). */
export const waveStep = (p: HanexProfile) => p.lineWidth * (1 - p.overlap);

/**
 * Grid step for the distance field. Contours must be resolved well below Δd and the cells cut off at
 * the domain edge (≤ h√2) must stay inside the half-bead inset, so h ≤ min(Δd/3, w/4).
 */
export const gridStep = (p: HanexProfile) => p.gridStep ?? Math.max(0.03, Math.min(waveStep(p) / 3, p.lineWidth / 4));

/**
 * Unsupported width above which a layer is waved. The nozzle land presses a bead onto the edge below
 * out to about its own diameter, so a wider land (toolhead) handles wider ledges by itself: the default
 * is max(2w, tip land diameter).
 */
export const triggerWidth = (p: HanexProfile) => p.triggerWidth ?? Math.max(2 * p.lineWidth, p.toolhead.tipFlatDiameter);

/** Filament cross-section, mm². */
export const filamentArea = (p: HanexProfile) => Math.PI * (p.filamentDiameter / 2) ** 2;

/**
 * Overhang face geometry. `faceAngleDeg` is the angle between the supporting wall and the underside
 * of the overhang: 90° = flat ceiling, 95° = underside rising 5° above horizontal as it leaves the wall.
 * Each layer then adds a free band b = h / tan(φ − 90°) (∞ for a flat ceiling). Hanex is needed when
 * b exceeds the bead's own reach; the steepest rise that still needs waves is atan(h / reach).
 */
export function faceBand(faceAngleDeg: number, layerHeight: number): number {
  const rise = ((faceAngleDeg - 90) * Math.PI) / 180;
  if (rise <= 0) return Infinity;
  return layerHeight / Math.tan(rise);
}
export function needsWaves(faceAngleDeg: number, layerHeight: number, p: HanexProfile): boolean {
  return faceBand(faceAngleDeg, layerHeight) > Math.max(p.supportReach, triggerWidth(p));
}
/** Largest face angle (wall-to-underside) for which every layer still needs waves. */
export const maxWaveFaceAngle = (layerHeight: number, p: HanexProfile) =>
  90 + (Math.atan(layerHeight / Math.max(p.supportReach, triggerWidth(p))) * 180) / Math.PI;

const base: Omit<HanexProfile, 'id' | 'name' | 'material'> = {
  toolhead: { nozzleDiameter: 0.4, tipFlatDiameter: 1.0 },
  filamentDiameter: 1.75,
  lineWidth: 0.45,
  sheetHeight: 0.2,
  overlap: 0.5,
  flowRatio: 1.0,
  rNominal: 0.9,
  flowFloor: 0.6,
  waveSpeed: 3,
  rimSpeed: 4,
  travelSpeed: 150,
  fan: 255,
  leadIn: 1.75,
  seedMode: 'point',
  startRadius: 1.5,
  rim: true,
  retractLength: 0.8,
  retractSpeed: 35,
  zHop: 0.4,
  supportReach: 0.225,
};

/**
 * Starting points, to be replaced with calibrated values (see docs/hanex/CALIBRATION.md).
 * Overlap 50% and single-digit mm/s speeds follow published arc-overhang practice: the new bead must
 * fuse sideways into a previous arc that is still warm but already rigid.
 */
export const PRESETS: HanexProfile[] = [
  { ...base, id: 'hanex-pla', name: 'Hanex PLA', material: 'PLA' },
  { ...base, id: 'hanex-petg', name: 'Hanex PETG', material: 'PETG', waveSpeed: 2.5, rimSpeed: 3, fan: 200, flowRatio: 0.95 },
  { ...base, id: 'hanex-abs', name: 'Hanex ABS/ASA', material: 'ABS', waveSpeed: 2.5, rimSpeed: 3, fan: 160 },
];

export const preset = (id: string): HanexProfile => structuredClone(PRESETS.find((p) => p.id === id) ?? PRESETS[0]);

/**
 * The nozzle land must still press on the previous arc while it lays the next one: the previous bead
 * centre sits Δd from the nozzle axis and its far edge at Δd + w/2, which must be under the land
 * (radius tip/2). So Δd ≤ (tip − w)/2, i.e. overlap ≥ 1 − (tip − w)/(2w).
 */
export const maxStepForTip = (p: HanexProfile) => Math.max(0, (p.toolhead.tipFlatDiameter - p.lineWidth) / 2);
export const minOverlapForTip = (p: HanexProfile) => Math.max(0, 1 - maxStepForTip(p) / p.lineWidth);

/** Problems that make a profile physically meaningless (empty when fine). */
export function validateProfile(p: HanexProfile): string[] {
  const e: string[] = [];
  if (!(p.overlap >= 0 && p.overlap < 1)) e.push('overlap must be in [0, 1)');
  if (p.lineWidth < p.toolhead.nozzleDiameter * 0.8 || p.lineWidth > p.toolhead.nozzleDiameter * 2) e.push('lineWidth should be 0.8–2× the nozzle diameter');
  if (p.sheetHeight <= 0 || p.sheetHeight > 0.8 * p.toolhead.nozzleDiameter) e.push('sheetHeight must be in (0, 0.8·nozzle]');
  if (!(p.flowFloor > 0 && p.flowFloor <= 1)) e.push('flowFloor must be in (0, 1]');
  if (p.leadIn < 0) e.push('leadIn must be ≥ 0');
  if (p.waveSpeed <= 0 || p.rimSpeed <= 0 || p.travelSpeed <= 0) e.push('speeds must be > 0');
  if (p.fan < 0 || p.fan > 255) e.push('fan is a 0–255 PWM value');
  if (p.toolhead.tipFlatDiameter < p.toolhead.nozzleDiameter) e.push('tip flat must be wider than the bore');
  else if (waveStep(p) > maxStepForTip(p) + 1e-9) e.push(`wave step ${waveStep(p).toFixed(3)} mm leaves the previous arc outside the nozzle land: raise overlap to ≥ ${minOverlapForTip(p).toFixed(2)}`);
  return e;
}
