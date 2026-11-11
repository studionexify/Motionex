// Batch reverse-verifier: slices fixtures headlessly, parses the G-code and runs the LOCKED mathAssertions
// against it, using the slicer's declared per-move geometry. Every (target, profile) is one `it`; every
// assertion is one row in report.json / report.md (failure count, first 5 failures, feature breakdown).
import { afterAll, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { slice, slotFromConfig } from '../../src/engine/slicer';
import { TECHS, type TechDef } from '../../src/engine/advanced/techs';
import { PRESETS as MOTION_PRESETS } from '../../src/plugins/motionex/presets';
import { defaultToolhead } from '../../src/plugins/motionex/core/toolhead';
import { DEFAULT_OPTIONS } from '../../src/plugins/motionex/modifier';
import { preset as hanexPreset } from '../../src/plugins/hanex/core/profile';
import { DEFAULT_BULNEX } from '../../src/plugins/bulnex/model';
import { builtinPattern, newPlacement } from '../../src/plugins/patternex';
import { adv, paintBy } from '../advanced/helpers';
import { indexed, dome } from '../advanced/shapes';
import { box, cylinder, tee } from '../fixtures';
import type { Config } from '../../src/profiles/settings';
import {
  LINE_WIDTH_KEYS, PLANAR_THETA_MAX_DEG, PRINTER, PROFILE_BOUNDARY, PROFILE_EXTREME, PROFILES,
  advRampLimit, plungeFor, cfgWith, errorRow, M, meshOf, outerWallWidth, pointsOf, REPORT_FIRST_FAILURES,
  specParams, standardRows, statusRow, toRows, type Profile, type Row, type VolCtx,
} from './runner';

const HERE = fileURLToPath(new URL('.', import.meta.url));

/** Runner-declared expectations (not in the locked spec): the vase base skip and the continuity travel bound. */
const VASE_BASE_LAYERS = 3;
const VASE_MAX_JUMP_MM = 0.5;
const MOTION_Z_START = 2; // motionex recipe mask z_start (mm)
/** z_weave: weave.ts skips the first three layers (li < 3: solid base), so only layers 3.. are woven. */
const WEAVE_FIRST_LAYER = 3;
/** z_weave: Z-offset grid cell (mm) for the anti-phase check. */
const ZW_CELL = 0.5;

interface Target { id: string; run: (p: Profile) => Row[] }
interface ReportRow extends Row { target: string; profile: Profile }
type Intent = 'structural' | 'aesthetic' | 'optical' | 'acoustic' | 'morph4d';

const PART_EXCLUDED = new Set(['brim', 'skirt', 'prime tower']);
const featName = (f?: string) => (f ?? '').replace(/_/g, ' ').trim().toLowerCase();
const boundaryOv = (profile: Profile) => (profile === PROFILE_BOUNDARY ? { layer_height: 0.08 } : {});
const finish = (results: M.AssertionResult[], moves: M.GMove[], ctx: VolCtx) => toRows(results, { moves, vol: ctx });

// ---------------------------------------------------------------------------------------------------------
// 1. Core planar slicer (cube / cylinder / tee), vase, thick-bridge and variable-width edge configs
// ---------------------------------------------------------------------------------------------------------
type CoreKind = 'cube' | 'cylinder' | 'tee' | 'vase' | 'thick-bridge' | 'width-mix';
const KIND_OVERRIDES: Record<CoreKind, Record<string, unknown>> = {
  cube: {},
  cylinder: {},
  tee: {},
  vase: { spiral_mode: true },
  'thick-bridge': { thick_bridges: true },
  'width-mix': { outer_wall_line_width: 0.3, inner_wall_line_width: 0.6 },
};

function coreGeom(kind: CoreKind, profile: Profile): { soup: Float32Array; height: number; radius?: number } {
  const tiny = profile === PROFILE_BOUNDARY;
  switch (kind) {
    case 'cube': return tiny ? { soup: box(100, 100, 0, 6, 6, 6), height: 6 } : { soup: box(100, 100, 0, 20, 20, 20), height: 20 };
    case 'cylinder':
    case 'width-mix': return tiny ? { soup: cylinder(100, 100, 3, 6), height: 6, radius: 3 } : { soup: cylinder(100, 100, 10, 20), height: 20, radius: 10 };
    case 'vase': return tiny ? { soup: cylinder(100, 100, 3, 6), height: 6, radius: 3 } : { soup: cylinder(100, 100, 15, 30), height: 30, radius: 15 };
    case 'tee':
    case 'thick-bridge': return { soup: tee(100, 100), height: 14 };
  }
}

function coreProfileOverrides(profile: Profile): Record<string, unknown> {
  if (profile === PROFILE_EXTREME) {
    const o: Record<string, unknown> = { layer_height: 0.72, sparse_infill_density: 90 }; // ~90 % of ParamSpec max (0.8 / 100)
    for (const k of LINE_WIDTH_KEYS) o[k] = 1.8; // ~90 % of line-width max (2.0)
    return o;
  }
  if (profile === PROFILE_BOUNDARY) {
    const o: Record<string, unknown> = { layer_height: 0.08, sparse_infill_density: 0 };
    for (const k of LINE_WIDTH_KEYS) o[k] = 0.1; // line_width ParamSpec min
    return o;
  }
  return {};
}

function coreRun(kind: CoreKind) {
  return (profile: Profile): Row[] => {
    const g = coreGeom(kind, profile);
    const cfg = cfgWith(PRINTER, { ...coreProfileOverrides(profile), ...KIND_OVERRIDES[kind] });
    const out = slice([meshOf(g.soup)], cfg, () => {}, {});
    const { moves, ctx, results } = standardRows(out, cfg, PLANAR_THETA_MAX_DEG);
    // Envelope scope = the part itself: brim, skirt and prime-tower beads sit outside it by design.
    const partMoves = moves.filter((m) => !PART_EXCLUDED.has(featName(m.feature)));
    results.push(M.checkEnvelope(M.reconstructPointCloud(partMoves), {
      height: g.height,
      layerHeight: Number(cfg.layer_height),
      lineWidth: outerWallWidth(cfg),
      ...(g.radius !== undefined ? { radius: g.radius, center: { x: 100, y: 100 } } : {}),
    }));
    // the span is the print itself: end G-code (lift, park) after the last bead is not part of the spiral
    const lastBead = Math.max(0, ...moves.filter((m) => m.isExtruding).map((m) => m.line));
    if (kind === 'vase') results.push(M.checkContinuity(moves.filter((m) => m.line <= lastBead), { maxJump: VASE_MAX_JUMP_MM, zMode: 'monotonic', fromLayer: VASE_BASE_LAYERS }));
    return finish(results, moves, ctx);
  };
}

// ---------------------------------------------------------------------------------------------------------
// 2. Every Advanced technology, enabled alone, with the fixture and machine it needs to RUN (see advCase)
// ---------------------------------------------------------------------------------------------------------
const CAUSTIC = { width: 8, height: 8, pixels: Array.from({ length: 64 }, (_, k) => ((k % 8) < 4 ? 1 : 0)), throwMm: 300, mode: 'lens' as const };

interface AdvCase {
  printer: string; intent: Intent; mesh: any; ov: Record<string, unknown>;
  filamentId?: string; filaments?: unknown[]; extra?: Record<string, unknown>;
  techs?: string[]; params?: Record<string, Record<string, number | boolean | string>>;
}

/**
 * Setup per technology: the machine, intent and shape from tests/advanced/phase*.test.ts (the setups those tests
 * prove RUN). Default techs keep the v1 setup (20 mm cube, A1, structural).
 */
function advCase(id: string, profile: Profile): AdvCase {
  const tiny = profile === PROFILE_BOUNDARY;
  const ov = boundaryOv(profile);
  const s = tiny ? 6 : 20;
  const base: AdvCase = { printer: PRINTER, intent: 'structural', mesh: meshOf(box(100, 100, 0, s, s, s)), ov };
  switch (id) {
    case 'conformal_layers': return { ...base, printer: 'bbl-x1c', intent: 'aesthetic', mesh: meshOf(dome(100, 100, 20, 8, 4)) };
    case 'subvoxel_aa': return { ...base, printer: 'bbl-x1c', mesh: meshOf(dome(100, 100, 20, 8, 4)) };
    case 'corner_overshoot': return { ...base, printer: 'creality-ender3v2', intent: 'aesthetic', mesh: meshOf(cylinder(100, 100, 12, 6, 3)) };
    case 'dovetail': {
      // Two materials painted per triangle (paint.color = filament index + 1) on an AMS machine.
      const m: any = indexed(box(110, 80, 0, 30, 30, 10), 'b');
      m.paint = { color: paintBy(m, (x) => (x < 125 ? 1 : 2)) }; // left half filament 1, right half filament 2
      const a = slotFromConfig(cfgWith('bbl-x1c', {}));
      return { ...base, printer: 'bbl-x1c', mesh: m, ov: { ...ov, has_ams: true }, filaments: [a, { ...a, name: 'Black', color: '#111111' }] };
    }
    case 'sgd_slicing': return { ...base, printer: 'bbl-x1c', intent: 'aesthetic', mesh: meshOf(tee(100, 100)) };
    case 'gloss_modulation': {
      const m: any = indexed(box(80, 80, 0, 30, 30, 10), 'b');
      m.paint = { adv: paintBy(m, (x) => (x < 95 ? 3 : 4)) };
      return { ...base, printer: 'bbl-x1c', intent: 'optical', mesh: m };
    }
    case 'foam_control': return { ...base, printer: 'bbl-x1c', intent: 'acoustic', filamentId: 'generic-lw-pla', mesh: meshOf(box(70, 70, 0, 70, 70, 8)) };
    case 'knot_braiding': return { ...base, printer: 'bbl-x1c', ov: { ...ov, wall_loops: 4 }, mesh: meshOf(cylinder(100, 100, 12, 8)) };
    case 'harmonic_dome': return { ...base, printer: 'bbl-x1c', mesh: meshOf(dome(100, 100, 20, 8, 4)) };
    case 'conformal_ironing': return { ...base, printer: 'bbl-x1c', mesh: meshOf(dome(100, 100, 20, 8, 2.5)) };
    case 'monge_ampere': return { ...base, printer: 'bbl-x1c', intent: 'optical', mesh: meshOf(box(80, 80, 0, 40, 40, 6)), extra: { caustic: CAUSTIC } };
    case 'spinor_fields': return {
      ...base, printer: 'bbl-x1c', mesh: meshOf(box(80, 80, 0, 30, 30, 10)),
      techs: ['fea_stress', 'spinor_fields'], params: { fea_stress: { threshold: 0, family: 'max' } },
    };
    case 'co_molding': return { ...base, printer: 'bbl-x1c', mesh: meshOf(box(80, 80, 0, 40, 40, 20)) };
    case 'tangent_entry': return { ...base, printer: 'bbl-p1s', mesh: meshOf(box(90, 90, 0, 30, 30, 8)) };
    case 'band_gap': return { ...base, printer: 'bbl-x1c', intent: 'acoustic', mesh: meshOf(box(70, 70, 0, 60, 60, 10)) };
    default: return base;
  }
}

function advRun(tech: TechDef) {
  return (profile: Profile): Row[] => {
    const c = advCase(tech.id, profile);
    const params = specParams(tech.params, profile);
    const { out, rep } = adv(c.mesh, c.printer, (c.techs ?? [tech.id]) as any, c.intent, {
      overrides: c.ov,
      ...(c.filamentId ? { filamentId: c.filamentId } : {}),
      ...(c.filaments ? { filaments: c.filaments } : {}),
      ...(c.extra ? { extra: c.extra } : {}),
      params: { ...(c.params ?? {}), ...(params ? { [tech.id]: params } : {}) },
    });
    const cfg = cfgWith(c.printer, c.ov, c.filamentId);
    const t = rep.get(tech.id);
    const { moves, ctx, results } = standardRows(out, cfg, advRampLimit(c.printer, cfg), plungeFor(c.printer, cfg));
    if (tech.id === 'z_weave') results.push(zWeaveCheck(moves, cfg, profile));
    return [statusRow(t?.status, t?.reason, profile), ...finish(results, moves, ctx)];
  };
}

// ---------------------------------------------------------------------------------------------------------
// 3. Engine plugins (manifest section 6b recipes)
// ---------------------------------------------------------------------------------------------------------
const SINE = MOTION_PRESETS.find((b) => b.id === 'preset-sine')!;

/**
 * Motionex 'sine' preset: a steady lateral wave on the outer wall (no per-layer phase flip), so the XY check is
 * the spirographic signature only (no alternating-phase weave to test).
 */
function motionexRun(profile: Profile): Row[] {
  const tiny = profile === PROFILE_BOUNDARY;
  const R = tiny ? 3 : 10, H = tiny ? 6 : 20;
  const amp = profile === PROFILE_EXTREME ? 2.0 : tiny ? 0.05 : SINE.amplitude;
  const period = profile === PROFILE_EXTREME ? 2 : tiny ? 2 : SINE.period_mm;
  const brush = { ...SINE, amplitude: amp, period_mm: period };
  const cfg = cfgWith('bbl-x1c', { enable_arc_fitting: false, ...boundaryOv(profile) });
  const mx = {
    applications: [{ brush_id: SINE.id, target: { type: 'body', walls: 'outer' }, mask: { z_start: 2, z_end: 1e4, fade_in_mm: 0, fade_out_mm: 0 }, order: 0, blend: 'add', enabled: true }],
    brushes: [brush], options: DEFAULT_OPTIONS, collisionMode: 'clamp', toolhead: defaultToolhead('bbl-x1c'), printerId: 'bbl-x1c',
  };
  const out = slice([meshOf(cylinder(100, 100, R, H))], cfg, () => {}, { plugins: { motionex: mx } });
  const { moves, ctx, results } = standardRows(out, cfg, PLANAR_THETA_MAX_DEG);
  const Rwall = R - outerWallWidth(cfg) / 2;
  const lobes = Math.round((2 * Math.PI * Rwall) / period);
  const modulated = [...new Set(pointsOf(moves, 'outer wall').filter((p) => p.z >= MOTION_Z_START).map((p) => p.layer))];
  results.push(M.checkSpiroSignature(pointsOf(moves, 'outer wall'), { center: { x: 100, y: 100 }, lobes, amplitude: amp, layers: modulated }));
  return finish(results, moves, ctx);
}

function hanexRun(profile: Profile): Row[] {
  const tiny = profile === PROFILE_BOUNDARY;
  const cfg = cfgWith(PRINTER, boundaryOv(profile));
  const p = profile === PROFILE_EXTREME ? { tipDiameter: 2.5, minArea: 50 } : tiny ? { tipDiameter: 0.4, minArea: 0 } : { tipDiameter: 1.0, minArea: 4 };
  const soup = tiny ? box(100, 100, 0, 6, 6, 6) : tee(100, 100);
  const out = slice([meshOf(soup)], cfg, () => {}, { plugins: { hanex: { profile: hanexPreset('hanex-pla'), ...p } } });
  const { moves, ctx, results } = standardRows(out, cfg, PLANAR_THETA_MAX_DEG);
  return finish(results, moves, ctx);
}

function bulnexRun(profile: Profile): Row[] {
  const tiny = profile === PROFILE_BOUNDARY;
  const cfg = cfgWith(PRINTER, boundaryOv(profile));
  const b = profile === PROFILE_EXTREME
    ? { ...DEFAULT_BULNEX, cycles: 9, passes: 4, pushHeightPct: 0.9, coolWaitMin: 15 }
    : tiny ? { ...DEFAULT_BULNEX, cycles: 1, passes: 1, pushHeightPct: 0.05, coolWaitMin: 0 }
      : { ...DEFAULT_BULNEX, cycles: 3, passes: 2, coolWaitMin: 2 };
  const soup = tiny ? box(120, 20, 0, 6, 6, 6) : box(120, 20, 0, 16, 16, 12);
  const out = slice([meshOf(soup)], cfg, () => {}, { plugins: { bulnex: b } });
  const { moves, ctx, results } = standardRows(out, cfg, PLANAR_THETA_MAX_DEG);
  return finish(results, moves, ctx);
}

function patternexRun(profile: Profile): Row[] {
  const tiny = profile === PROFILE_BOUNDARY;
  const cfg = cfgWith('bbl-p1s', boundaryOv(profile));
  const a = slotFromConfig(cfg);
  const filaments = [a, { ...a, name: 'Black', color: '#111111' }, { ...a, name: 'Red', color: '#ff0000' }];
  const pattern = builtinPattern('dots');
  const top = tiny ? 6 : 4;
  const at = tiny ? 63 : 70;
  const scale = profile === PROFILE_EXTREME ? 1.8 : tiny ? 0.3 : 1;
  const placement = {
    ...newPlacement('p1', pattern, 'm:0', [at, at, top], [0, 0, 1]),
    object: 0, position_xyz: [at, at, top], projection_axis: [0, 0, 1], scale_xy: [scale, scale],
  };
  const purge = profile === PROFILE_EXTREME
    ? { mode: 'reduced', volume_mm3: 30, change_point_shift_mm: 0 }
    : tiny ? { mode: 'none', change_point_shift_mm: 0 } : { mode: 'full', change_point_shift_mm: 0 };
  const action = { region_ref: { placement_id: 'p1' }, material: { mode: 'slot', slot_index: 1 }, purge, motion: null };
  const pcfg = { patterns: [pattern], placements: [placement], actions: [action], singleColour: 'skip', transitionVolume: [] };
  const soup = tiny ? box(60, 60, 0, 6, 6, 6) : box(60, 60, 0, 20, 20, 4);
  const out = slice([meshOf(soup, 'm')], cfg, () => {}, { filaments, plugins: { patternex: pcfg as any } });
  const { moves, ctx, results } = standardRows(out, cfg, PLANAR_THETA_MAX_DEG);
  return finish(results, moves, ctx);
}

// ---------------------------------------------------------------------------------------------------------
// 4. z_weave: the weave is a Z modulation (egg-crate), checked by anti-phase Z offsets of adjacent layers
// ---------------------------------------------------------------------------------------------------------
const ZW = TECHS.find((t) => t.id === 'z_weave')!;

function zWeaveCheck(moves: M.GMove[], cfg: Config, profile: Profile): M.AssertionResult {
  const defaults = Object.fromEntries(ZW.params.map((s) => [s.key, s.def])) as Record<string, number>;
  const eff = { ...defaults, ...((specParams(ZW.params, profile) ?? {}) as Record<string, number>) };
  // Inner walls carry the weave (weave.ts WOVEN). Min amplitude: 0.2 * amp * layer_height * 0.5 (mm).
  return M.checkZWeaveAntiPhase(pointsOf(moves, 'inner wall'), {
    fromLayer: WEAVE_FIRST_LAYER, cell: ZW_CELL, minAmplitude: 0.2 * eff.amp * Number(cfg.layer_height) * 0.5,
  });
}

function weaveRun(profile: Profile, pins = false): Row[] {
  const tiny = profile === PROFILE_BOUNDARY;
  const R = tiny ? 3 : 10, H = tiny ? 6 : 20;
  const ov = boundaryOv(profile);
  const p = specParams(ZW.params, profile);
  const { out, rep } = adv([meshOf(cylinder(100, 100, R, H))] as any, PRINTER, ['z_weave'], 'structural', {
    overrides: ov, ...(p || pins ? { params: { z_weave: { ...(p ?? {}), ...(pins ? { pins: true } : {}) } } } : {}),
  });
  const cfg = cfgWith(PRINTER, ov);
  const t = rep.get('z_weave');
  const { moves, ctx, results } = standardRows(out, cfg, advRampLimit(PRINTER, cfg), plungeFor(PRINTER, cfg));
  results.push(zWeaveCheck(moves, cfg, profile));
  return [statusRow(t?.status, t?.reason, profile), ...finish(results, moves, ctx)];
}

// ---------------------------------------------------------------------------------------------------------
const TARGETS: Target[] = [
  ...(['cube', 'cylinder', 'tee', 'vase', 'thick-bridge', 'width-mix'] as CoreKind[]).map((k) => ({ id: `core/${k}`, run: coreRun(k) })),
  ...TECHS.map((t) => ({ id: `adv/${t.id}`, run: advRun(t) })),
  { id: 'plugin/motionex', run: motionexRun },
  { id: 'plugin/hanex', run: hanexRun },
  { id: 'plugin/bulnex', run: bulnexRun },
  { id: 'plugin/patternex', run: patternexRun },
  { id: 'weave/z_weave-cylinder', run: (p: Profile) => weaveRun(p) },
  // Z-pins are opt-in: with them on, every vertical plunge must pass the clear-void check
  { id: 'weave/z_weave-pins-cylinder', run: (p: Profile) => weaveRun(p, true) },
];

const report: ReportRow[] = [];

function runSafely(t: Target, profile: Profile): Row[] {
  try {
    return t.run(profile);
  } catch (e) {
    // Harness / slice / parse error: recorded as a failing row, never swallowed.
    return [errorRow('slice-ran', e)];
  }
}

describe('batch reverse-verifier', () => {
  for (const t of TARGETS) {
    for (const profile of PROFILES) {
      it(`${t.id} | ${profile}`, () => {
        const rows = runSafely(t, profile);
        for (const r of rows) report.push({ target: t.id, profile, ...r });
        const bad = rows.filter((r) => !r.pass);
        if (bad.length) {
          throw new Error(bad.map((b) => `${b.assertion} (${b.failureCount}): ${b.firstFailures[0]?.message ?? 'failed'}`).join('\n'));
        }
        expect(bad).toHaveLength(0);
      }, 240_000);
    }
  }

  afterAll(() => {
    writeFileSync(`${HERE}report.json`, JSON.stringify(report.map((r) => ({
      target: r.target, profile: r.profile, assertion: r.assertion, type: r.type, pass: r.pass,
      failureCount: r.failureCount, metrics: r.metrics, firstFailures: r.firstFailures.slice(0, REPORT_FIRST_FAILURES),
      ...(r.byFeature ? { byFeature: r.byFeature } : {}), ...(r.reason ? { reason: r.reason } : {}),
    })), null, 2));
    writeFileSync(`${HERE}report.md`, toMarkdown(report));
  });
});

/** The one worst numeric metric of a failing assertion, labelled. */
function worstOf(r: ReportRow): string {
  if (r.assertion === 'volumetric-extrusion-conservation') return `worst ${(r.metrics.maxRelErrPct ?? 0).toFixed(2)} %`;
  if (r.assertion === 'z-weave-antiphase') return `worst corr ${(r.metrics.worstCorrelation ?? 0).toFixed(3)} (need <= -0.8)`;
  if (r.assertion === 'declared-geometry-map') return `max pos err ${(r.metrics.maxPosErrMm ?? 0).toFixed(4)} mm, fallback ${r.metrics.fallbackMoves ?? 0}`;
  if (r.assertion === 'nonplanar-ramp-angle') return `max ramp ${(r.metrics.maxThetaDeg ?? 0).toFixed(2)} deg`;
  if (r.assertion === 'c0-continuity') return `max gap ${(r.metrics.maxGapMm ?? 0).toFixed(3)} mm`;
  if (r.assertion === 'tech-status') return 'not run';
  return '-';
}

function toMarkdown(rows: ReportRow[]): string {
  const esc = (s: string) => s.replace(/\|/g, '/').replace(/\n/g, ' ');
  const cells = new Map<string, ReportRow[]>();
  for (const r of rows) {
    const k = `${r.target}\u0000${r.profile}`;
    cells.set(k, [...(cells.get(k) ?? []), r]);
  }
  const targets = [...new Set(rows.map((r) => r.target))];
  const grid = (t: string, p: Profile) => {
    const g = cells.get(`${t}\u0000${p}`) ?? [];
    const bad = g.filter((r) => !r.pass);
    if (!bad.length) return 'PASS';
    return 'FAIL ' + [...new Set(bad.map((r) => `[${r.type}] ${r.assertion}`))].join(', ');
  };
  const failing = rows.filter((r) => !r.pass);
  const lines: string[] = [
    '# Batch reverse-verifier summary', '',
    `Rows: ${rows.length}, (target, profile) cells: ${cells.size}, failing cells: ${[...cells.values()].filter((g) => g.some((r) => !r.pass)).length}, failing (target, assertion) pairs: ${failing.length}`, '',
    '## Pass / fail grid', '',
    '| Target | Default | Extreme Modulation | Boundary Edge-Cases |', '|---|---|---|---|',
  ];
  for (const t of targets) lines.push(`| ${t} | ${PROFILES.map((p) => esc(grid(t, p))).join(' | ')} |`);
  lines.push('', '## Failing assertions', '',
    'Type tags: VOLUME volumetric conservation, SAFETY finite/bed, RAMP non-planar angle, ENVELOPE, SIGNATURE spiro, CONTINUITY C0, WEAVE z-weave anti-phase, STATUS advanced tech not run, HARNESS declared-geometry / slice error.', '',
    '| Target | Profile | Type | Assertion | Count | Worst | Feature breakdown (count, worst %) | Example (one message) |',
    '|---|---|---|---|---|---|---|---|');
  for (const r of failing) {
    const feats = r.byFeature
      ? Object.entries(r.byFeature).map(([f, v]) => `${f}: ${v.count} (${v.worstPct.toFixed(2)} %)`).join('; ')
      : '-';
    const ex = r.reason ? `STATUS: ${r.reason}` : (r.firstFailures[0]?.message ?? '');
    lines.push(`| ${r.target} | ${r.profile} | ${r.type} | ${r.assertion} | ${r.failureCount} | ${esc(worstOf(r))} | ${esc(feats)} | ${esc(ex).slice(0, 260)} |`);
  }
  lines.push('', '`Worst` for volumetric is the locked maxRelErrPct (tolerance 2 %). Counts are exact (locked checker counts every failure; report keeps the first 5 in report.json).', '');
  return lines.join('\n');
}

