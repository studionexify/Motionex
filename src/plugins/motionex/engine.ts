// Motionex engine side: turns Nexspiro's move list into Motionex paths, applies the motions,
// runs the print-head collision check, and writes the result back as Nexspiro moves.
// Extrusion is recomputed from each new move's true 3D length; Nexspiro then writes the G-code.
import type { Config } from '../../profiles/settings';
import type { LayerOps, Op } from '../../engine/gcode';
import type { EnginePlugin, PluginContext } from '../api';
import { applyMotion, DEFAULT_OPTIONS, type ModifierOptions } from './modifier';
import { checkCollisions, limitZSpeed, type CollisionMode, type ToolheadProfile } from './core/toolhead';
import { RegionRegistry } from './core/regions';
import { clearOverlaps, type ClearanceOptions } from './core/clearance';
import { emptyCheck, SEAM_TOL, type Layer, type PointAction, type PrintCheck, type Toolpath, type ToolpathPoint } from './core/types';
import type { PrintProfiles, Firmware } from './core/profiles';
import type { MotionApplication, MotionBrush } from './model';
import type { WeaveSettings } from './weave/model';
import { applyWeave, weaveSession, type WeaveReport, type WeaveSession } from './weave/engine';
import type { PaintSettings } from './paint/model';
import { applyPaint, type PaintReport } from './paint/engine';
import type { LaceSettings } from './lace/model';
import { applyLace, type LaceReport } from './lace/engine';
import { pointIn } from '../../engine/clipper';
import type { SculptSettings } from './sculpt/model';
import { applySculpt, type SculptReport } from './sculpt/engine';
import { objectMask, type ObjectMask } from './wall/targets';
import type { SelectRule } from './select/model';
import { applyRulePass, ruleMotions, rulesPrepare, type RuleReport, type RuleSession } from './select/engine';

/** Everything the worker needs, as plain data. */
export interface MotionexConfig {
  applications: MotionApplication[];
  /** The motions the applications use. */
  brushes: MotionBrush[];
  options: ModifierOptions;
  collisionMode: CollisionMode;
  toolhead: ToolheadProfile;
  printerId: string;
  /** Weave mode: a picture woven into the wall, one colour per layer. */
  weave?: WeaveSettings;
  /** Velocity painting: a picture printed into the outer wall as changes of speed (sheen). */
  paint?: PaintSettings;
  /** Lace: holes cut into the walls (openwork). */
  lace?: LaceSettings;
  sculpt?: SculptSettings;
  /** Select & apply rules (only switched-on ones are sent). */
  rules?: SelectRule[];
}

/** What prepare() hands to postToolpath: the weave's hooks and the object masks of each wall-art mode. */
export type MotionexSession = Partial<WeaveSession> & { masks?: { paint?: ObjectMask; lace?: ObjectMask; sculpt?: ObjectMask }; rules?: RuleSession };

export interface MotionexReport {
  check: PrintCheck;
  /** Moves changed by Motionex, for the preview. */
  movedPaths: number;
  weave?: WeaveReport;
  paint?: PaintReport;
  lace?: LaceReport;
  sculpt?: SculptReport;
  select?: RuleReport;
}

type Move = Extract<Op, { k: 'move' }>;

const num = (cfg: Config, k: string, d: number) => { const v = parseFloat(String(cfg[k] ?? '')); return Number.isFinite(v) ? v : d; };

/** Read machine, filament and process values the motion code needs from Nexspiro's config. */
export function profilesFromConfig(cfg: Config, printerId: string): PrintProfiles {
  const num = (k: string, d = 0) => (cfg[k] === undefined || cfg[k] === '' ? d : Number(cfg[k]));
  const flavor = String(cfg.gcode_flavor ?? 'marlin');
  const xy = num('max_speed_xy', 500), acc = num('max_acceleration', 10000);
  const maxFlow = num('filament_max_volumetric_speed', 15);
  return {
    machine: {
      id: printerId, name: String(cfg.printer_model ?? printerId), firmware: (['klipper', 'marlin', 'bbl'].includes(flavor) ? flavor : 'marlin') as Firmware,
      bed: { x: num('bed_x', 256), y: num('bed_y', 256), z: num('bed_z', 256) }, nozzle: num('nozzle_diameter', 0.4),
      maxSpeed: { x: xy, y: xy, z: num('max_speed_z', 12), e: 60 },
      maxAccel: { x: acc, y: acc, z: 500, e: 5000 },
      maxJerk: { x: 9, y: 9, z: 0.4, e: 2.5 },
      maxVolumetricFlow: maxFlow,
    },
    filament: {
      id: 'current', name: String(cfg.filament_type ?? 'Filament'), diameter: num('filament_diameter', 1.75), density: num('filament_density', 1.24),
      nozzleTemp: num('nozzle_temperature', 210), bedTemp: num('bed_temperature', 60), maxVolumetricFlow: maxFlow,
    },
    process: {
      id: 'current', name: 'current', layerHeight: num('layer_height', 0.2), firstLayerHeight: num('initial_layer_print_height', 0.2),
      lineWidth: num('outer_wall_line_width') || num('line_width', 0.42), wallSpeed: num('outer_wall_speed', 60),
      firstLayerSpeed: num('initial_layer_speed', 30), travelSpeed: num('travel_speed', 200), walls: num('wall_loops', 2),
      retractLength: num('retraction_length', 0.8), retractSpeed: num('retraction_speed', 30),
    },
  };
}

interface Run {
  layer: number;
  /** ops[start..end) are the printing moves of this path. */
  start: number; end: number;
  path: Toolpath;
  ePerMm: number;
  w: number; h: number;
  feature: Move['feature'];
}

/** Split each layer's moves into printing paths (runs of moves with one feature, between travels). */
export function opsToLayers(layers: LayerOps[]): { layers: Layer[]; runs: Run[] } {
  const out: Layer[] = [];
  const runs: Run[] = [];
  layers.forEach((L, li) => {
    const paths: Toolpath[] = [];
    let last: { x: number; y: number; z: number } | null = null;
    let i = 0;
    while (i < L.ops.length) {
      const op = L.ops[i];
      if (op.k === 'raw' && op.resetPos) { last = null; i++; continue; }
      if (op.k !== 'move') { i++; continue; }
      // a woven loop's lead-in and tail (tucked inside the wall) are left out: the loop itself is then closed
      if (op.travel || op.e <= 0 || !last || op.tuck) { last = { x: op.x, y: op.y, z: op.z }; i++; continue; }
      const feature = op.feature;
      let j = i;
      const pts: ToolpathPoint[] = [{ x: last.x, y: last.y, z: last.z, f: op.f, flow: 1, e: 0 }];
      let eSum = 0, lenSum = 0;
      while (j < L.ops.length) {
        const m = L.ops[j];
        if (m.k !== 'move' || m.travel || m.e <= 0 || m.feature !== feature || m.tuck) break;
        const p = pts[pts.length - 1];
        lenSum += Math.hypot(m.x - p.x, m.y - p.y, m.z - p.z);
        eSum += m.e;
        pts.push({ x: m.x, y: m.y, z: m.z, f: m.f, flow: 1, e: m.e, w: m.w });
        j++;
      }
      const a = pts[0], b = pts[pts.length - 1];
      const path: Toolpath = { feature, closed: Math.hypot(a.x - b.x, a.y - b.y) < (lenSum > SEAM_TOL * 8 ? SEAM_TOL : 1e-3), points: pts };
      paths.push(path);
      runs.push({ layer: li, start: i, end: j, path, ePerMm: lenSum > 0 ? eSum / lenSum : 0, w: op.w, h: op.h, feature });
      last = { x: b.x, y: b.y, z: b.z };
      i = j;
    }
    out.push({ index: li, z: L.z, height: L.h, paths });
  });
  return { layers: out, runs };
}

function postOps(a: PointAction, at: ToolpathPoint, run: Run, cfg: Config): Op[] {
  const rs = Number(cfg.retraction_speed ?? 30) || 30, ds = Number(cfg.deretraction_speed ?? 0) || rs;
  const out: Op[] = [];
  if (a.retract_mm) out.push({ k: 'retract', len: a.retract_mm, speed: rs });
  // A blob is plastic pushed out on the spot, slowly (2 mm/s of filament).
  if (a.blob_mm) out.push({ k: 'move', x: at.x, y: at.y, z: at.z, e: a.blob_mm, f: 2, feature: run.feature, w: run.w, h: run.h, travel: false, fixed: true, noArc: true });
  if (a.dwell_ms) out.push({ k: 'raw', text: `G4 P${Math.round(a.dwell_ms)} ; motionex pause`, time: a.dwell_ms / 1000 });
  if (a.unretract_mm) out.push({ k: 'retract', len: -a.unretract_mm, speed: ds });
  return out;
}

/**
 * Moves for a changed path, with E from the true 3D length of each move. A path that was only cut
 * (not moved) keeps the slicer's own E for each piece, so variable-width lines keep their plastic.
 */
function runToOps(run: Run, original: ToolpathPoint, cfg: Config): Op[] {
  const pts = run.path.points;
  const out: Op[] = [];
  if (pts.length < 2) return out;
  const ownE = run.path.clipped && run.path.modifiedBy !== 'motionex';
  const s = pts[0];
  if (Math.hypot(s.x - original.x, s.y - original.y, s.z - original.z) > 1e-4)
    out.push({ k: 'move', x: s.x, y: s.y, z: s.z, e: 0, f: Number(cfg.travel_speed ?? 200), feature: 'travel', w: 0, h: run.h, travel: true });
  if (s.post) out.push(...postOps(s.post, s, run, cfg));
  for (let k = 1; k < pts.length; k++) {
    const p = pts[k - 1], q = pts[k];
    const len = Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z);
    if (q.travel) out.push({ k: 'move', x: q.x, y: q.y, z: q.z, e: 0, f: Number(cfg.travel_speed ?? 200), feature: 'travel', w: 0, h: run.h, travel: true, noArc: true });
    else if (len > 1e-6) out.push({ k: 'move', x: q.x, y: q.y, z: q.z, e: ownE ? q.e : len * run.ePerMm * q.flow, f: q.f, feature: run.feature, w: q.w ?? run.w, h: run.h, travel: false, noArc: true });
    if (q.post) out.push(...postOps(q.post, q, run, cfg));
  }
  return out;
}

export const motionexEngine: EnginePlugin<MotionexConfig, MotionexReport> = {
  id: 'motionex',
  name: 'Motionex',
  version: '0.4.0',
  prepare(config, ctx) {
    const weave = config.weave?.enabled ? weaveSession(config.weave, ctx) : undefined;
    const paint = config.paint?.enabled ? objectMask(config.paint.objects, ctx) : undefined;
    const lace = config.lace?.enabled ? objectMask(config.lace.objects, ctx) : undefined;
    const sculpt = config.sculpt?.enabled ? objectMask(config.sculpt.objects, ctx) : undefined;
    const rules = config.rules?.length ? rulesPrepare(config.rules, ctx) : undefined;
    if (!weave && !paint && !lace && !sculpt && !rules) return undefined;
    const session: MotionexSession = { ...(weave ?? {}), masks: { paint, lace, sculpt }, rules: rules?.session };
    if (rules?.regionsAt) {
      // the weave's colour regions first, the selections over them (later contributions win)
      const own = weave?.regionsAt, sel = rules.regionsAt;
      session.regionsAt = (o, l) => [...(own ? own(o, l) : []), ...sel(o, l)];
    }
    return session;
  },
  postToolpath(layerOps, config, ctx: PluginContext) {
    const check = emptyCheck();
    // the weave goes first; motions then add on top of the woven wall
    const session = ctx.session as MotionexSession | undefined;
    // path sculpt first: every other pass then works on the moved wall
    const sculptMask = session?.masks?.sculpt;
    const sculpt = config.sculpt?.enabled ? applySculpt(layerOps, config.sculpt, ctx.cfg, sculptMask ? (l, x, y) => { const m = sculptMask.maskAt(l); return !m || pointIn(x, y, m); } : null, ctx.warn) : undefined;
    const weave = config.weave?.enabled ? applyWeave(layerOps, config.weave, ctx.cfg, session?.weave ? (session as WeaveSession) : undefined, ctx.warn) : undefined;
    // velocity paint sets the outer wall speeds on whole loops, then lace cuts the walls (its pieces keep their speed)
    const paint = config.paint?.enabled ? applyPaint(layerOps, config.paint, ctx.cfg, session?.masks?.paint ? (l) => session.masks!.paint!.maskAt(l) : null, ctx.warn) : undefined;
    const lace = config.lace?.enabled ? applyLace(layerOps, config.lace, ctx.cfg, session?.masks?.lace ? (l) => session.masks!.lace!.maskAt(l) : null, ctx.warn, config.printerId) : undefined;
    const brushById = new Map(config.brushes.map((b) => [b.id, b]));
    const picked = config.rules?.length ? ruleMotions(config.rules, layerOps, session?.rules, (id) => brushById.get(id)) : { apps: [], regions: [], limited: [] };
    for (const l of picked.limited) ctx.warn(`Select & apply: the motion of "${l.name}" was made smaller (at most ${l.mm.toFixed(2)} mm each way) so it doesn't run into the next wall.`);
    const apps = [...config.applications.filter((a) => a.enabled).map((a) => ({ ...a, target: { ...a.target } })), ...picked.apps];
    // speed, flow and temperature of the selections go last, over every motion
    const finish = <T extends MotionexReport>(r: T): T => (config.rules?.length ? { ...r, select: applyRulePass(layerOps, config.rules, ctx, session?.rules) } : r);
    if (!apps.length) return finish({ check, movedPaths: 0, weave, paint, lace, sculpt });
    const profiles = profilesFromConfig(ctx.cfg, config.printerId);
    const regions = new RegionRegistry();
    for (const f of ctx.faceRegions) {
      regions.set({ region_id: f.id, name: f.name, layer_range: [0, layerOps.length - 1], polygon_mask_per_layer: (l) => f.polygonsAt(l), attributes: { source: 'faces' } });
    }
    // Regions owned by Patternex (spec §8): Motionex only edits toolpaths inside their masks.
    for (const r of ctx.sharedRegions ?? []) regions.set(r);
    for (const r of picked.regions) regions.set(r);
    // A picked-surface number means that surface set on every object; a shared region id is used as is.
    for (const a of apps) if (a.target.type === 'faces')
      a.target = {
        ...a.target,
        faces: [
          ...ctx.faceRegions.filter((f) => (a.target.faces ?? []).some((n) => f.id === n || f.id.endsWith(`:${n}`))).map((f) => f.id),
          ...(a.target.faces ?? []).filter((n) => ['patternex', 'select'].includes(String(regions.get(n)?.attributes.source))),
        ],
      };
    const { layers, runs } = opsToLayers(layerOps);
    const originals = runs.map((r) => ({ ...r.path.points[0] }));
    const brushes = new Map(config.brushes.map((b) => [b.id, b]));
    const res = applyMotion(layers, apps, (id) => brushes.get(id), profiles, config.options ?? DEFAULT_OPTIONS, check, regions);
    for (const w of res.warnings) ctx.warn(w.message);
    // applyMotion replaces path objects; map them back to their runs by position in the layer.
    const byLayer = new Map<number, Run[]>();
    for (const r of runs) { const l = byLayer.get(r.layer); if (l) l.push(r); else byLayer.set(r.layer, [r]); }
    for (const [li, rs] of byLayer) rs.forEach((r, k) => { r.path = res.layers[li].paths[k]; });

    if (res.layers.some((l) => l.paths.some((p) => p.points.some((q) => q.zOff)))) {
      checkCollisions(res.layers, config.toolhead, profiles.machine.bed, config.collisionMode, check, (w) => ctx.warn(w.message));
      check.zSpeedHits += limitZSpeed(res.layers, profiles.machine.maxSpeed.z);
    }
    if (check.blocking) ctx.warn('Motionex: export is blocked until the print-head collisions are fixed.');

    // Nothing may print over a moved wall: cut the other lines of each layer back to the slicer's spacing.
    const clear: ClearanceOptions = {
      layerHeight: profiles.process.layerHeight, infillOverlap: num(ctx.cfg, 'infill_wall_overlap', 15) / 100,
      retractOver: Math.max(1, num(ctx.cfg, 'retraction_minimum_travel', 1)), retractLength: num(ctx.cfg, 'retraction_length', 0.8),
    };
    for (const [li, rs] of byLayer) {
      const L = res.layers[li];
      if (!clearOverlaps(L, (_p, k) => rs[k].w, { ...clear, layerHeight: rs[0]?.h || clear.layerHeight })) continue;
      rs.forEach((r, k) => { r.path = L.paths[k]; });
    }

    // Write back from the last run of each layer so earlier op indices stay valid.
    let moved = 0;
    for (let k = runs.length - 1; k >= 0; k--) {
      const r = runs[k];
      if (r.path.modifiedBy !== 'motionex' && !r.path.clipped) continue;
      layerOps[r.layer].ops.splice(r.start, r.end - r.start, ...runToOps(r, originals[k], ctx.cfg));
      moved++;
    }
    return finish({ check, movedPaths: moved, weave, paint, lace, sculpt });
  },
  gcodeHeader(config) {
    const names = new Map(config.brushes.map((b) => [b.id, b]));
    const w = config.weave;
    const weave = w?.enabled ? [`; motionex weave: ${w.mode} ${w.image.name ?? 'picture'} ${w.image.w}x${w.image.h} x${w.tiles_around} round, slots ${w.slots.map((s) => s + 1).join('/')}, ${w.layers_per_colour} layer(s) per colour, depth ${w.depth_mm}mm, z ${w.z_start}-${w.z_end}, change ${w.change.mode}${w.change.mode === 'reduced' ? ` ${w.change.volume_mm3}mm3` : ''}, seam ${w.seam.inward ? `inside ${w.seam.tuck_mm}mm` : 'plain'} at ${w.seam.angle_deg}deg`] : [];
    const p = config.paint, l = config.lace;
    const paint = p?.enabled ? [`; motionex velocity paint: ${p.calibration ? 'speed ladder' : `${p.image.name ?? 'picture'} ${p.image.w}x${p.image.h}`} ${p.projection}${p.projection === 'front' ? ` from ${p.front_deg}deg` : ` x${p.tiles_around} round`}, ${p.speed_light}-${p.speed_dark}mm/s, z ${p.z_start}-${p.z_end}${p.accel ? `, accel ${p.accel}` : ''}`] : [];
    const lace = l?.enabled ? [`; motionex lace: ${l.source === 'image' ? `picture ${l.image.w}x${l.image.h}` : `${l.pattern} ${l.cell_w}x${l.cell_h}mm strand ${l.strand_mm}mm open ${l.open}`}, ${l.walls} walls, overhang ${l.overhang_deg}deg, bridge ${l.bridge_mm}mm, z ${l.z_start}-${l.z_end} rim ${l.rim_mm}mm`] : [];
    const sel = (config.rules ?? []).map((r) => `; motionex select: ${r.name} (${r.pick.kind}) ${[r.apply.filament !== undefined ? `filament ${r.apply.filament + 1}` : '', r.apply.motion ? `motion ${r.apply.motion.brush_id} x${r.apply.motion.scale}` : '', r.apply.speed !== undefined ? `speed ${r.apply.speed}%` : '', r.apply.flow !== undefined ? `flow ${r.apply.flow}%` : '', r.apply.temp !== undefined ? `temp ${r.apply.temp}C` : ''].filter(Boolean).join(', ')}${r.lines.length ? ` on ${r.lines.join('/')}` : ''}, blend ${r.blend_mm}mm`);
    return [...weave, ...lace, ...paint, ...sel, ...config.applications.filter((a) => a.enabled).map((a) => {
      const b = a.brush ?? names.get(a.brush_id);
      const where = a.target.type === 'faces' ? `${(a.target.faces ?? []).length} picked surface(s)` : 'whole body';
      return `; motionex: ${b?.name ?? a.brush_id} v${b?.version ?? '?'} on ${where}, ${a.target.walls} walls, z ${a.mask.z_start}-${a.mask.z_end}${a.scale && a.scale !== 1 ? ` size x${a.scale}` : ''}${a.blend === 'override' ? ' replace' : ''}${a.round_mm ? ` round ${a.round_mm}mm` : ''}${a.tip ? ` tip ${a.tip.mode} ${a.tip.share}` : ''}`;
    })];
  },
};
