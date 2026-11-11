// Bulnex: bulk production by printing the same part (or a row of copies) again and again, pushing the
// finished parts off the front of the plate with the print head between prints.
//
// Push geometry (A1, bed slinger): the head parks at the part's X centre behind the row, drops to
// the push height and the bed moves so the head sweeps towards Y = 0 — the parts slide off the front edge.
// Everything here is plain data so the config can cross into the slicing worker.

/** User settings (UI → slicer). */
export interface BulnexConfig {
  /** Prints (cycles) in the file, including the first one. */
  cycles: number;
  /** Push height as a fraction of the part height (0..1). */
  pushHeightPct: number;
  /** Push strokes per cycle (repeated full sweeps from behind the row). */
  passes: number;
  /** Push speed, mm/s. */
  pushSpeed: number;
  /** Stepper current during the push as a fraction of normal (0.2..1): a stuck part makes the motor skip instead of tearing the plate. */
  currentFraction: number;
  /** Bed temperature to cool to before pushing, °C. */
  releaseBedTemp: number;
  /** Wait after the bed is switched to the release temperature, minutes. */
  coolWaitMin: number;
  /** Nozzle temperature while the bed cools (limits ooze), °C. 0 = off. */
  nozzleStandbyTemp: number;
  /** Run the part-cooling fan at full speed during the cool-down. */
  fanDuringCool: boolean;
  /** Minimum part height for a reliable push, mm (warning only). */
  minHeight: number;
  /** Override the material's contact-area limit, mm² (0 = material default). */
  maxContactArea: number;
  /** Calibration print: the release ladder, every block pushed on its own with a pause after each. */
  calibration?: boolean;
}

/**
 * Release ladder: five 15 mm blocks of growing footprint along the front of the plate. Each is pushed
 * on its own (smallest first) so the largest footprint that still releases can be read off directly.
 */
export const CALIBRATION_HEIGHT = 15;
export const CALIBRATION_FRONT_Y = 10;
export const CALIBRATION_BLOCKS = [
  { label: 'A', side: 20, x: 22 },
  { label: 'B', side: 30, x: 55 },
  { label: 'C', side: 40, x: 98 },
  { label: 'D', side: 50, x: 151 },
  { label: 'E', side: 60, x: 214 },
];
/** Safety factor applied to the largest block that released. */
export const CALIBRATION_MARGIN = 0.7;

export const DEFAULT_BULNEX: BulnexConfig = {
  cycles: 10, pushHeightPct: 0.3, passes: 2, pushSpeed: 20, currentFraction: 0.5,
  releaseBedTemp: 28, coolWaitMin: 15, nozzleStandbyTemp: 140, fanDuringCool: true,
  minHeight: 8, maxContactArea: 0,
};

/** A1 normal stepper currents (A), restored after every push. */
export const A1_CURRENT = { x: 0.65, y: 1.2, z: 0.6 };
/** Lowest push height above the plate: the nozzle tip must clear the first layers and the plate texture. */
export const MIN_PUSH_Z = 2;
/** Clearance between the head and the row before the push starts (mm behind the last part). */
export const APPROACH_GAP = 8;
/** Y the push sweeps to: the front edge of the plate (the A1 can reach slightly past 0). */
export const PUSH_END_Y = -2;

/**
 * Material families Bulnex supports and the largest first-layer contact area per part that still
 * releases from textured PEI at the release temperature with reduced motor current. PETG bonds much
 * harder than PLA, so its limit is lower.
 */
export const MATERIAL_LIMITS: { family: string; match: RegExp; maxArea: number; releaseTemp: number }[] = [
  { family: 'PLA', match: /^PLA/i, maxArea: 2000, releaseTemp: 28 },
  { family: 'PETG', match: /^PETG|^PCTG/i, maxArea: 1000, releaseTemp: 30 },
];

export function materialOf(filamentType: string) {
  return MATERIAL_LIMITS.find((m) => m.match.test(filamentType.trim()));
}

/** One part on the plate, measured by the engine (plate mm). */
export interface PartGeometry {
  name: string;
  minX: number; maxX: number; minY: number; maxY: number; height: number;
  /** First-layer contact area, mm². */
  contactArea: number;
  /** Part cross-section is present on the push line (x = row centre) at the push height. */
  hitAtPush: boolean;
  /** Width of the cross-section along X at the push height, mm. */
  widthAtPush: number;
}

export interface BulnexCheck { level: 'ok' | 'warn'; text: string }

/** A row of parts pushed in one sweep. */
export interface PushRow { x: number; startY: number; z: number; parts: number }

export interface BulnexReport {
  parts: PartGeometry[];
  row: PushRow | null;
  checks: BulnexCheck[];
  cycles: number;
  /** Seconds added to every cycle by cool-down, push and re-heat (estimate). */
  cycleOverheadS: number;
  /** The three parts of that overhead (s): cool-down wait, push strokes, re-heat (the last cycle does not re-heat). */
  coolS: number; pushS: number; reheatS: number;
  /** Whether this file is the calibration ladder (cycles do not apply). */
  calibration: boolean;
}

export const pushZFor = (height: number, pct: number) => Math.max(MIN_PUSH_Z, Math.min(height - 1, height * pct));

/** The push row: one X (centre of the parts) and the Y behind the last part. Null when nothing to push. */
export function planRow(parts: PartGeometry[], cfg: BulnexConfig): PushRow | null {
  if (!parts.length) return null;
  const x = parts.reduce((s, p) => s + (p.minX + p.maxX) / 2, 0) / parts.length;
  const startY = Math.max(...parts.map((p) => p.maxY)) + APPROACH_GAP;
  const z = pushZFor(Math.min(...parts.map((p) => p.height)), cfg.pushHeightPct);
  return { x, startY, z, parts: parts.length };
}

/** Pre-flight checks. Bulnex warns and still writes the file. */
export function checkParts(parts: PartGeometry[], cfg: BulnexConfig, filamentType: string, bedY: number): BulnexCheck[] {
  const out: BulnexCheck[] = [];
  const warn = (text: string) => out.push({ level: 'warn', text });
  if (!parts.length) { warn('No parts on the plate.'); return out; }
  const mat = materialOf(filamentType);
  if (cfg.calibration) {
    if (!mat) warn(`${filamentType || 'This filament'} is not supported by Bulnex (PLA and PETG families only).`);
    out.push({ level: 'ok', text: `Calibration: ${parts.length} blocks, each pushed on its own (smallest first) with a pause after each push.` });
    return out;
  }
  if (!mat) warn(`${filamentType || 'This filament'} is not supported by Bulnex (PLA and PETG families only): it may not release from the plate.`);
  const names = new Set(parts.map((p) => p.name.replace(/\s*\(\d+\)$/, '').replace(/\s*\(copy\)$/, '')));
  if (names.size > 1) warn('Bulnex prints one design per row; the plate holds different designs.');
  const limit = cfg.maxContactArea > 0 ? cfg.maxContactArea : mat?.maxArea ?? 1000;
  const row = planRow(parts, cfg)!;
  for (const p of parts) {
    if (p.height < cfg.minHeight) warn(`${p.name}: ${p.height.toFixed(1)} mm tall, below the ${cfg.minHeight} mm minimum — the nozzle pushes close to the plate and may drag or ride over it.`);
    if (p.contactArea > limit) warn(`${p.name}: ${Math.round(p.contactArea)} mm² on the plate, above the ${limit} mm² limit for ${mat?.family ?? 'this material'} — it may not release.`);
    const cx = (p.minX + p.maxX) / 2;
    if (Math.abs(cx - row.x) > Math.max(1, (p.maxX - p.minX) / 4)) warn(`${p.name} is not in line with the push row (X ${row.x.toFixed(1)} mm). Use "Arrange row".`);
    if (!p.hitAtPush) warn(`${p.name}: no material on the push line at Z ${row.z.toFixed(1)} mm — the nozzle would pass through. Rotate the part or change the push height.`);
    else if (p.widthAtPush < 3) warn(`${p.name}: only ${p.widthAtPush.toFixed(1)} mm wide at the push height — it may snap instead of sliding.`);
    if (p.height > 0 && (p.maxY - p.minY) / p.height > 6) warn(`${p.name}: long and flat along the push direction — it drags along the plate; consider rotating it.`);
  }
  // parts must not overlap in Y (the sweep pushes them as a chain)
  const byY = [...parts].sort((a, b) => a.minY - b.minY);
  for (let i = 1; i < byY.length; i++) if (byY[i].minY < byY[i - 1].maxY - 0.01) { warn('Parts overlap along the push direction.'); break; }
  if (row.startY > bedY - 2) warn(`The head needs ${APPROACH_GAP} mm behind the last part; move the row forward.`);
  if (cfg.releaseBedTemp > (mat?.releaseTemp ?? 30) + 10) warn(`Release temperature ${cfg.releaseBedTemp} °C is high; parts release best below ${mat?.releaseTemp ?? 30} °C.`);
  if (!out.length) out.push({ level: 'ok', text: `${parts.length} part${parts.length > 1 ? 's' : ''} in one row, push at Z ${row.z.toFixed(1)} mm.` });
  return out;
}

/** Cycle overhead (cool-down wait + push strokes + re-heat), seconds. */
export function cycleParts(cfg: BulnexConfig, row: PushRow | null, bedTemp: number): { coolS: number; pushS: number; reheatS: number } {
  const pushS = row ? cfg.passes * (2 * (row.startY - PUSH_END_Y) / Math.max(1, cfg.pushSpeed) + 6) : 0;
  const reheatS = Math.max(0, bedTemp - cfg.releaseBedTemp) * 3; // ~3 s/°C on the A1 heater
  return { coolS: cfg.coolWaitMin * 60, pushS, reheatS };
}
