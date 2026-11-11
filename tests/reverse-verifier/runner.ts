/**
 * Harness helpers for the batch reverse-verifier (runner.test.ts). No pass/fail judgement of the physics lives
 * here: every assertion comes from the LOCKED mathAssertions.ts. This file wires slicer configs, reads the
 * slicer's DECLARED per-move geometry (SliceOutput.moves / moveLines), splits volumetric checks by cross-section
 * model, produces feature breakdowns and row bookkeeping.
 */
import { resolveConfig } from '../../src/profiles/resolve';
import type { Config } from '../../src/profiles/settings';
import type { SliceOutput } from '../../src/engine/types';
import { machineCaps } from '../../src/engine/advanced/machine';
import { weld } from '../../src/engine/mesh';
import { parseGcode } from './gcodeParser';
import * as M from './mathAssertions';

export const PROFILE_DEFAULT = 'Default' as const;
export const PROFILE_EXTREME = 'Extreme Modulation' as const;
export const PROFILE_BOUNDARY = 'Boundary Edge-Cases' as const;
export const PROFILES = [PROFILE_DEFAULT, PROFILE_EXTREME, PROFILE_BOUNDARY] as const;
export type Profile = (typeof PROFILES)[number];

export const PRINTER = 'bbl-a1';
export const PLANAR_THETA_MAX_DEG = 90;
/** Failures kept per assertion in report.json (the locked file keeps up to 25; the report shows this many). */
export const REPORT_FIRST_FAILURES = 5;
/** Position tolerance (mm) between a parsed G-code end point and the slicer's declared end point (3-decimal print). */
const DECL_POS_TOL = 0.002;

/** Line-width keys that the Extreme / Boundary profiles push. */
export const LINE_WIDTH_KEYS = [
  'line_width', 'initial_layer_line_width', 'outer_wall_line_width', 'inner_wall_line_width', 'top_surface_line_width',
  'sparse_infill_line_width', 'internal_solid_infill_line_width', 'support_line_width',
] as const;

/** Assertion name -> report type tag. */
export const TYPE_OF: Record<string, string> = {
  'volumetric-extrusion-conservation': 'VOLUME',
  'finite-and-bed-safe': 'SAFETY',
  'nonplanar-ramp-angle': 'RAMP',
  'bounding-envelope': 'ENVELOPE',
  'spirographic-signature': 'SIGNATURE',
  'c0-continuity': 'CONTINUITY',
  'z-weave-antiphase': 'WEAVE',
  'tech-status': 'STATUS',
  'declared-geometry-map': 'HARNESS',
  'slice-ran': 'HARNESS',
};

export interface Row {
  assertion: string;
  type: string;
  pass: boolean;
  failureCount: number;
  metrics: Record<string, number>;
  firstFailures: M.Failure[];
  /** Volumetric failures only: feature -> count and worst relative error (%). Exact, computed per feature. */
  byFeature?: Record<string, { count: number; worstPct: number }>;
  /** tech-status rows: the status reason the slicer gave (or the harness error). */
  reason?: string;
}

export function cfgWith(printerId: string, overrides: Record<string, unknown> = {}, filamentId = 'generic-pla'): Config {
  return resolveConfig({ printerId, plate: 'textured_pei_plate', filamentId, presetId: '0.20', overrides: overrides as Config });
}

export function meshOf(soup: Float32Array, id = 'part') {
  const m = weld(soup);
  return { id, name: id, vertices: m.vertices, indices: m.indices };
}

const featName = (f?: string) => (f ?? '').replace(/_/g, ' ').trim().toLowerCase();

const posNum = (cfg: Config, k: string): number | undefined => {
  const v = Number(cfg[k]);
  return Number.isFinite(v) && v > 0 ? v : undefined;
};

// ---------------------------------------------------------------------------------------------------------
// Config-derived width / flow. The width is only a FALLBACK now: the slicer's declared per-move width is used
// whenever the G-code line has a declared entry. Flow is always config-derived (not recoverable from geometry).
// ---------------------------------------------------------------------------------------------------------
export function widthFn(cfg: Config): (m: M.GMove) => number {
  const nz = Number(cfg.nozzle_diameter);
  const chain = (...keys: string[]) => {
    for (const k of keys) { const v = posNum(cfg, k); if (v) return v; }
    return nz * 1.05;
  };
  return (m) => {
    const f = featName(m.feature);
    const onLayer0 = m.layerIndex === 0;
    if (onLayer0 && (f === 'outer wall' || f === 'inner wall' || f === 'overhang wall')) return chain('initial_layer_line_width', 'line_width');
    if (onLayer0 && f === 'bottom surface') return chain('initial_layer_infill_line_width', 'initial_layer_line_width', 'line_width');
    if (f === 'brim') return chain('initial_layer_line_width', 'line_width');
    if (f === 'prime tower') return onLayer0 ? chain('initial_layer_line_width', 'line_width') : chain('support_line_width', 'line_width');
    switch (f) {
      case 'outer wall': case 'overhang wall': return chain('outer_wall_line_width', 'line_width');
      case 'inner wall': return chain('inner_wall_line_width', 'line_width');
      case 'sparse infill': return chain('sparse_infill_line_width', 'line_width');
      case 'internal solid infill': case 'bottom surface': case 'bridge': return chain('internal_solid_infill_line_width', 'line_width');
      case 'top surface': return chain('top_surface_line_width', 'line_width');
      case 'support': case 'support interface': return chain('support_line_width', 'line_width');
      default: return chain('line_width');
    }
  };
}

/** Resolved flow multiplier for a move (see slicer.ts extrudePath). Unchanged from v1. */
export function flowFn(cfg: Config): (m: M.GMove) => number {
  const base = (Number(cfg.filament_flow_ratio) || 1) * (Number(cfg.print_flow_ratio) || 1);
  const init = Number(cfg.initial_layer_flow_ratio) || 1;
  const top = Number(cfg.top_solid_infill_flow_ratio) || 1;
  return (m) => base * (m.layerIndex === 0 ? init : 1) * (featName(m.feature) === 'top surface' ? top : 1);
}

export function outerWallWidth(cfg: Config): number {
  return widthFn(cfg)({ feature: 'outer wall', layerIndex: 1 } as M.GMove);
}

// ---------------------------------------------------------------------------------------------------------
// Declared geometry: SliceOutput.moves (stride MOVE_STRIDE = 8: x,y,z,w,h,speed,time,tool) keyed by the
// 0-based G-code line each move ends on (SliceOutput.moveLines). GMove.line is 1-based.
// ---------------------------------------------------------------------------------------------------------
export interface DeclaredLine {
  /** Width and height of the FIRST declared move on this line (an arc G2/G3 line spans several moves). */
  w: number; h: number;
  /** End position of the LAST declared move on this line (what the parsed G-code line lands on). */
  x: number; y: number; z: number;
}
export type Declared = Map<number, DeclaredLine>;

const MOVE_STRIDE = 8;

export function declaredMap(out: SliceOutput, moves: M.GMove[]): Declared {
  // Basic slicer: SliceOutput.moveLines gives the exact G-code line of every packed move.
  if (out.moveLines) {
    const map: Declared = new Map();
    const mv = out.moves;
    for (let k = 0; k < out.moveLines.length; k++) {
      const line = out.moveLines[k] + 1;
      const x = mv[k * MOVE_STRIDE], y = mv[k * MOVE_STRIDE + 1], z = mv[k * MOVE_STRIDE + 2];
      const prev = map.get(line);
      if (prev) { prev.x = x; prev.y = y; prev.z = z; continue; }
      map.set(line, { w: mv[k * MOVE_STRIDE + 3], h: mv[k * MOVE_STRIDE + 4], x, y, z });
    }
    // Bulnex repeats the finished body N times: cycle c's lines carry the declared geometry of cycle 1's same lines.
    const gl = out.gcode.split('\n');
    const mark = (re: RegExp) => { const r: number[] = []; gl.forEach((t, i) => { if (re.test(t)) r.push(i + 1); }); return r; };
    const ejects = mark(/^; ===== BULNEX eject: cycle \d+/), starts = mark(/^; ===== BULNEX cycle \d+ of/);
    if (ejects.length >= 2 && starts.length >= 1) {
      const bodyLen = ejects[1] - (starts[0] + 1), first = ejects[0] - bodyLen;
      for (let c = 0; c < starts.length; c++) for (let q = 0; q < bodyLen; q++) {
        const d = map.get(first + q);
        if (d) map.set(starts[c] + 1 + q, d);
      }
    }
    // A program-body plugin (Bulnex repeats the finished program) shifts/repeats lines after the moves were recorded, so
    // some line numbers are stale. Those parsed moves are matched by end position instead (same packed bead, same w,h).
    const key = (x: number, y: number, z: number) => `${Math.round(x * 1000)},${Math.round(y * 1000)},${Math.round(z * 1000)}`;
    let byPos: Map<string, DeclaredLine> | null = null;
    for (const m of moves) {
      if (!m.isExtruding) continue;
      const e = map.get(m.line);
      if (e && Math.abs(e.x - m.x) <= DECL_POS_TOL && Math.abs(e.y - m.y) <= DECL_POS_TOL && Math.abs(e.z - m.z) <= DECL_POS_TOL) continue;
      if (!byPos) {
        byPos = new Map();
        for (let k = 0; k < out.moveLines.length; k++) {
          const x = mv[k * MOVE_STRIDE], y = mv[k * MOVE_STRIDE + 1], z = mv[k * MOVE_STRIDE + 2];
          const kk = key(x, y, z);
          if (!byPos.has(kk) && mv[k * MOVE_STRIDE + 3] > 0) byPos.set(kk, { w: mv[k * MOVE_STRIDE + 3], h: mv[k * MOVE_STRIDE + 4], x, y, z });
        }
      }
      const d = byPos.get(key(m.x, m.y, m.z));
      if (d) map.set(m.line, d);
    }
    return map;
  }
  return alignedMap(out, moves);
}

/**
 * Advanced engine: its frozen classic emit (src/engine/advanced/classic/gcode.ts) packs the moves in the same order
 * as it writes them but records no moveLines. Each parsed move that changes XYZ is matched, in order, to the next
 * packed move at the same end point (3-decimal tolerance). The first packed move of a matched run (an arc spans
 * several) supplies w,h. Unmatched extruding moves are reported by checkDeclaredMap, never guessed.
 */
function alignedMap(out: SliceOutput, moves: M.GMove[]): Declared {
  const map: Declared = new Map();
  const mv = out.moves;
  const N = Math.floor(mv.length / MOVE_STRIDE);
  const LOOK = 4000;
  let p = 0;
  let px = NaN, py = NaN, pz = NaN;
  for (const m of moves) {
    const moved = !(m.x === px && m.y === py && m.z === pz) && Number.isFinite(m.x) && Number.isFinite(m.y) && Number.isFinite(m.z);
    if (!moved) continue;
    px = m.x; py = m.y; pz = m.z;
    let hit = -1;
    for (let k = p; k < N && k < p + LOOK; k++) {
      const dx = mv[k * MOVE_STRIDE] - m.x, dy = mv[k * MOVE_STRIDE + 1] - m.y, dz = mv[k * MOVE_STRIDE + 2] - m.z;
      if (Math.abs(dx) <= DECL_POS_TOL && Math.abs(dy) <= DECL_POS_TOL && Math.abs(dz) <= DECL_POS_TOL) { hit = k; break; }
    }
    if (hit < 0) continue;
    const first = p;
    map.set(m.line, { w: mv[first * MOVE_STRIDE + 3], h: mv[first * MOVE_STRIDE + 4], x: mv[hit * MOVE_STRIDE], y: mv[hit * MOVE_STRIDE + 1], z: mv[hit * MOVE_STRIDE + 2] });
    p = hit + 1;
  }
  return map;
}

export interface VolCtx { cfg: Config; decl: Declared; d: number; /** bridges are round beads: core thick_bridges, and always in the Advanced (classic) engine */ circleBridges: boolean }

export function makeCtx(out: SliceOutput, cfg: Config, moves: M.GMove[]): VolCtx {
  return { cfg, decl: declaredMap(out, moves), d: Number(cfg.filament_diameter), circleBridges: cfg.thick_bridges === true || out.advanced !== undefined };
}

/**
 * The declared entry for a parsed move, used only when its end point matches the parsed end point. A stale line
 * (the bulnex body transform repeats G-code lines after the moves were recorded) therefore never supplies w,h.
 */
export function declaredFor(ctx: VolCtx, m: M.GMove): DeclaredLine | undefined {
  const e = ctx.decl.get(m.line);
  if (!e) return undefined;
  const ok = Math.abs(e.x - m.x) <= DECL_POS_TOL && Math.abs(e.y - m.y) <= DECL_POS_TOL && Math.abs(e.z - m.z) <= DECL_POS_TOL;
  return ok && e.w > 0 && e.h > 0 ? e : undefined;
}

/** Options for one cross-section model. Width and h come from the declared geometry, else the fallback. */
function volOpts(ctx: VolCtx, crossSection: M.VolumetricOptions['crossSection']): M.VolumetricOptions {
  const fallback = widthFn(ctx.cfg);
  return {
    filamentDiameter: ctx.d,
    width: (m) => declaredFor(ctx, m)?.w ?? fallback(m),
    hLocal: (m) => declaredFor(ctx, m)?.h ?? (m.layerHeight ?? Number(ctx.cfg.layer_height)),
    flow: flowFn(ctx.cfg),
    crossSection,
  };
}

/** Keeps every move's position and retraction, but zeroes the extrusion of extruding moves outside `keep`. */
function maskExtrusion(moves: M.GMove[], keep: (m: M.GMove) => boolean): M.GMove[] {
  return moves.map((m) => (m.isExtruding && !keep(m) ? { ...m, isExtruding: false, e: 0 } : m));
}

function mergeResults(name: string, rs: M.AssertionResult[]): M.AssertionResult {
  const failureCount = rs.reduce((s, r) => s + (r.metrics.failureCount ?? 0), 0);
  const failures = rs.flatMap((r) => r.failures).sort((a, b) => (a.line ?? 0) - (b.line ?? 0)).slice(0, 25);
  return {
    name, pass: failureCount === 0, failures,
    metrics: {
      maxRelErrPct: Math.max(0, ...rs.map((r) => r.metrics.maxRelErrPct ?? 0)),
      checkedMm: rs.reduce((s, r) => s + (r.metrics.checkedMm ?? 0), 0),
      checkedSegments: rs.reduce((s, r) => s + (r.metrics.checkedSegments ?? 0), 0),
      belowResolution: rs.reduce((s, r) => s + (r.metrics.belowResolution ?? 0), 0),
      failureCount,
    },
  };
}

/**
 * Volumetric conservation. Core thick bridges (cfg.thick_bridges and feature 'bridge') are a round bead ('circle');
 * everything else is a 'stadium' bead. The locked checker takes one cross-section per call, so the two groups are
 * checked separately (the other group's extrusion is zeroed; positions and retractions are kept) and merged.
 */
export function volumetric(moves: M.GMove[], ctx: VolCtx): M.AssertionResult {
  const name = 'volumetric-extrusion-conservation';
  if (!ctx.circleBridges) return M.checkVolumetricConservation(moves, volOpts(ctx, 'stadium'));
  const isBridge = (m: M.GMove) => featName(m.feature) === 'bridge';
  const a = M.checkVolumetricConservation(maskExtrusion(moves, isBridge), volOpts(ctx, 'circle'));
  const b = M.checkVolumetricConservation(maskExtrusion(moves, (m) => !isBridge(m)), volOpts(ctx, 'stadium'));
  return mergeResults(name, [a, b]);
}

/** Exact per-feature breakdown: each feature checked alone (other features' extrusion zeroed). */
export function featureBreakdown(moves: M.GMove[], ctx: VolCtx): Record<string, { count: number; worstPct: number }> {
  const out: Record<string, { count: number; worstPct: number }> = {};
  const feats = new Set(moves.filter((m) => m.isExtruding).map((m) => featName(m.feature)));
  const full = volumetric(moves, ctx).metrics.failureCount ?? 0;
  let sum = 0;
  for (const f of feats) {
    const sub = volumetric(maskExtrusion(moves, (m) => featName(m.feature) === f), ctx);
    const n = sub.metrics.failureCount ?? 0;
    if (n > 0) { out[f || '(none)'] = { count: n, worstPct: sub.metrics.maxRelErrPct }; sum += n; }
  }
  if (full !== sum) out['(unattributed)'] = { count: full - sum, worstPct: 0 };
  return out;
}

/**
 * Harness consistency: every extruding parsed move must find its declared entry on the same G-code line, at the
 * same end point. Missing entries fall back to the config width and are reported as a failure, never silently used.
 */
export function checkDeclaredMap(moves: M.GMove[], decl: Declared): M.AssertionResult {
  const name = 'declared-geometry-map';
  const failures: M.Failure[] = [];
  let hits = 0, count = 0, maxErr = 0;
  const push = (f: M.Failure) => { count++; if (failures.length < 25) failures.push(f); };
  for (const m of moves) {
    if (!m.isExtruding) continue;
    const e = decl.get(m.line);
    if (!e) { push({ assertion: name, line: m.line, message: `no declared move on G-code line ${m.line}` }); continue; }
    hits++;
    const err = Math.max(Math.abs(e.x - m.x), Math.abs(e.y - m.y), Math.abs(e.z - m.z));
    maxErr = Math.max(maxErr, err);
    if (err > DECL_POS_TOL) push({ assertion: name, line: m.line, message: `declared end (${e.x.toFixed(3)},${e.y.toFixed(3)},${e.z.toFixed(3)}) != parsed (${m.x},${m.y},${m.z}) on line ${m.line}`, actual: err, expected: DECL_POS_TOL });
  }
  return { name, pass: count === 0, failures, metrics: { declaredHits: hits, maxPosErrMm: maxErr, failureCount: count } };
}

// ---------------------------------------------------------------------------------------------------------
// Row builders
// ---------------------------------------------------------------------------------------------------------
export function toRows(res: M.AssertionResult[], ctx?: { moves: M.GMove[]; vol: VolCtx }): Row[] {
  return res.map((r) => {
    const row: Row = {
      assertion: r.name, type: TYPE_OF[r.name] ?? 'GEOM', pass: r.pass,
      failureCount: r.metrics.failureCount ?? r.failures.length, metrics: r.metrics,
      firstFailures: r.failures.slice(0, REPORT_FIRST_FAILURES),
    };
    if (!r.pass && ctx && r.name === 'volumetric-extrusion-conservation') row.byFeature = featureBreakdown(ctx.moves, ctx.vol);
    return row;
  });
}

/** A slice or parse exception becomes a failing row. It is never swallowed. */
export function errorRow(assertion: string, e: unknown): Row {
  const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return { assertion, type: TYPE_OF[assertion] ?? 'HARNESS', pass: false, failureCount: 1, metrics: {}, firstFailures: [{ assertion, message: msg.slice(0, 500) }] };
}

/** tech-status row from the Advanced report: passes only when the tech ran. The reason is always kept. */
export function statusRow(status: string | undefined, reason: string | undefined, profile: Profile = PROFILE_DEFAULT): Row {
  // Extreme / Boundary parameters can push a tech past what its fixture allows (a 6 mm part has no room for a buried entry,
  // 18 kHz is out of reach for the cell sizes): the engine declining with a stated reason is "not applicable", never a pass on
  // math. Default must always run, and the other assertions of the cell still run on the (unmodified) output.
  const na = status === 'idle' && !!reason && profile !== PROFILE_DEFAULT;
  const ok = status === 'applied' || status === 'adapted' || na;
  const msg = `status=${status ?? 'missing from advanced output'}${reason ? ` (${reason})` : ''}`;
  return {
    assertion: 'tech-status', type: 'STATUS', pass: ok, failureCount: ok ? 0 : 1, metrics: na ? { notApplicable: 1 } : {},
    firstFailures: ok ? [] : [{ assertion: 'tech-status', message: msg }], reason: reason ?? undefined,
  };
}

/**
 * Drops only the leading NON-extruding moves whose axes are still unset (NaN): the parser leaves an axis NaN until
 * the program first sets it (e.g. a `G1 Z2` before any X). Such moves have no position to check. Extruding moves
 * are never dropped, so a NaN extrusion still reaches the locked checks.
 */
export function trimPrePosition(moves: M.GMove[]): { moves: M.GMove[]; dropped: number } {
  let i = 0;
  while (i < moves.length && !moves[i].isExtruding && !(Number.isFinite(moves[i].x) && Number.isFinite(moves[i].y) && Number.isFinite(moves[i].z))) i++;
  return { moves: i ? moves.slice(i) : moves, dropped: i };
}

/** The three checks every (target, profile) gets, plus the declared-geometry harness check. */
export function standardRows(out: SliceOutput, cfg: Config, thetaMaxDeg: number, plunge?: M.PlungeOptions): { moves: M.GMove[]; ctx: VolCtx; results: M.AssertionResult[] } {
  // machine start G-code (purge lines, priming) is not toolpath: judge only what follows the first layer change
  const lines = out.gcode.split('\n');
  const firstLayer = lines.findIndex((l) => l.startsWith(';LAYER_CHANGE')) + 1;
  const moves = trimPrePosition(parseGcode(out.gcode).moves).moves.filter((m) => firstLayer <= 0 || m.line >= firstLayer);
  const ctx = makeCtx(out, cfg, moves);
  const results = [
    volumetric(moves, ctx),
    M.checkFiniteAndSafe(moves, out.gcode),
    M.checkRampAngle(moves, thetaMaxDeg, plunge),
    checkDeclaredMap(moves, ctx.decl),
  ];
  return { moves, ctx, results };
}

/** Advanced techs: ramp limit is the machine's steepest riding slope (machine.ts maxSlopeDeg). */
export function advRampLimit(printerId: string, cfg: Config): number {
  return machineCaps(printerId, cfg).maxSlopeDeg;
}

export function pickMoves(moves: M.GMove[], feature: string) {
  const f = featName(feature);
  return moves.filter((m) => featName(m.feature) === f);
}

/** Point cloud (extrusion end points) of one feature. */
export function pointsOf(moves: M.GMove[], feature: string): M.Pt3[] {
  return M.reconstructPointCloud(pickMoves(moves, feature));
}

/** Parameter values for the Extreme (90 % of ParamSpec max) and Boundary (ParamSpec min) profiles. */
export function specParams(
  params: { key: string; type: string; def: unknown; min?: number; max?: number; options?: { value: string }[] }[],
  profile: Profile,
): Record<string, number | boolean | string> | undefined {
  if (profile === PROFILE_DEFAULT || params.length === 0) return undefined;
  const out: Record<string, number | boolean | string> = {};
  for (const s of params) {
    if (s.type === 'bool') out[s.key] = profile === PROFILE_EXTREME ? !s.def : Boolean(s.def);
    else if (s.type === 'enum') {
      const o = s.options ?? [];
      out[s.key] = profile === PROFILE_EXTREME ? (o.at(-1)?.value ?? String(s.def)) : (o[0]?.value ?? String(s.def));
    } else if (profile === PROFILE_EXTREME) out[s.key] = s.max !== undefined ? 0.9 * s.max : Number(s.def);
    else out[s.key] = s.min !== undefined ? s.min : Number(s.def);
  }
  return out;
}

export { M };

/** Nozzle-cone geometry for the clear-void exemption of vertical plunges (same cone the engine's clearance pass uses). */
export function plungeFor(printerId: string, cfg: Config): M.PlungeOptions {
  const head = machineCaps(printerId, cfg).toolhead;
  return {
    tipRadius: head.nozzle.tip_diameter / 2, coneAngleDeg: head.nozzle.cone_angle_deg, tipLen: head.nozzle.tip_len,
    margin: head.margin, beadHalfWidth: outerWallWidth(cfg) / 2,
  };
}
