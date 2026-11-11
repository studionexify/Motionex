// The Advanced slicing session: analyses every part, routes zones to technologies, adapts them to the
// machine, and exposes the hooks the slicer calls at each pipeline stage. Basic mode never creates one.
import type { Config } from '../../profiles/settings';
import type { LayerOps } from './classic/gcode';
import type { IndexedMesh } from '../mesh';
import type { FilamentSlot, MeshInput, Paths, Polyline2, ExPolygon, FeatureType } from '../types';
import type { PluginSession } from '../../plugins/api';
import { analyzePart, RESOLUTION_CELLS, type PartAnalysis } from './analysis';
import { machineCaps, type MachineCaps } from './machine';
import { resolveTechs, TECHS, type ResolvedTech } from './techs';
import type { AdvancedConfig, AdvancedReport, TechId, TechReport, ParamValue } from './types';
import { MODULES } from './modules';
import { unwarpLayers } from './warp';
import { clearancePass, limitRamp, restoreLengths, snapshotLengths, type ClearanceReport } from './clearance';
import { difference } from '../clipper';
import { pushAll } from '../util';

export interface WallLoop { pts: number[]; closed: boolean; feature: FeatureType; width: number; flow: number; /** Per-point Z offsets from the layer top. */ zs?: number[]; /** Per-point bead widths. */ widths?: number[] }
export interface WallResult { loops: WallLoop[][]; inner: Paths }
export interface InfillPath extends Polyline2 { width: number; flow?: number; feature?: 'sparse_infill' | 'internal_solid_infill'; /** Width per point (variable-width beads). */ widths?: number[] }

/** Context the slicer gives the wall hook for one island. */
export interface WallCtx { walls: number; wo: number; wi: number; so: number; si: number; h: number; z: number; layer: number }
/** Context for the infill hook. */
export interface InfillCtx { width: number; density: number; z: number; h: number; layer: number; pattern: string }
/** Part of a sparse region an infill technology fills (the rest goes to the next one, then the regular pattern). */
export interface InfillClaim { paths: InfillPath[]; used: Paths }
/** One material region of a layer cross-section. */
export interface MaterialRegion { fil: number; paths: Paths }

export interface StageCtx {
  cfg: Config;
  layerZ: number[];
  layerH: number[];
  warn(msg: string): void;
}

export interface SessionCtx {
  cfg: Config;
  num(k: string): number;
  caps: MachineCaps;
  adv: AdvancedConfig;
  filaments: FilamentSlot[];
  meshes: MeshInput[];
  parts: PartAnalysis[];
  techs: Map<TechId, ResolvedTech>;
  /** Report entry of a technology (created on first use). */
  report(id: TechId): TechReport;
  warn(msg: string): void;
  /** True when the technology is enabled and the machine allows it. */
  on(id: TechId): boolean;
  param(id: TechId, key: string): ParamValue;
  pnum(id: TechId, key: string): number;
  /** Set by any pass that moves extrusions off their layer plane (triggers the clearance check). */
  nonPlanar: boolean;
  /** Curved-layer warp in effect, if any. */
  warp?: Warp;
  /** Layer indices compiled as one continuous helix (seam passes skip them). */
  helicalLayers: Set<number>;
  /** Layer tops and heights of the plan (sliced space), set once the slicer has planned the layers. */
  layerZ: number[];
  layerH: number[];
  /** Results shared between technologies (stress field, cell designs…), keyed by name. */
  shared: Map<string, unknown>;
  /** Shared result computed on first use. */
  memo<T>(key: string, make: () => T): T;
}

/** A technology implementation: any subset of the stage hooks. */
export interface TechModule {
  id: TechId;
  /** Adds this technology's field to a part analysis for the Zone Inspector (no slicing). */
  inspect?(a: PartAnalysis): void;
  prepare?(s: SessionCtx): void;
  /** Z displacement field for curved layers: real z = z′ + dz(x, y, z′). `base` is the warp so far. */
  warp?(s: SessionCtx, base?: Warp): Warp | undefined;
  reshape?(s: SessionCtx, object: number, layer: number, slice: Paths, z: number): Paths;
  /** Edit the material regions of one layer of an object (multi-material interfaces). */
  regions?(s: SessionCtx, object: number, layer: number, regions: MaterialRegion[]): MaterialRegion[];
  walls?(s: SessionCtx, object: number, ex: ExPolygon, c: WallCtx): WallResult | undefined;
  /** Edit the finished wall rings of one island (any generator), ring 0 = outer wall. */
  wallsPost?(s: SessionCtx, object: number, layer: number, ex: ExPolygon, rings: WallLoop[][]): void;
  /**
   * Infill for a sparse region: paths for the whole region, or a claim on part of it. Technologies are
   * asked in order; `last` is set for the last one still to be asked, which should fill what is left.
   */
  infill?(s: SessionCtx, object: number, region: Paths, c: InfillCtx, last: boolean): InfillPath[] | InfillClaim | undefined;
  post?(s: SessionCtx, layers: LayerOps[], c: StageCtx): void;
  finalize?(s: SessionCtx, layers: LayerOps[], c: StageCtx): void;
}

export interface Warp {
  /** Displacement in Z at a point of the warped (sliced) space. */
  dz(x: number, y: number, zw: number): number;
  /** Map a real point into warped space (for warping the mesh). */
  toWarped(x: number, y: number, z: number): number;
  /** d(real z)/d(warped z): local layer-thickness ratio. */
  ratio(x: number, y: number, zw: number): number;
  source: TechId;
}

export interface AdvancedSession {
  ctx: SessionCtx;
  /** Meshes to slice: warped into curved-layer space when a layer technology is active. */
  meshes: MeshInput[];
  warp?: Warp;
  plugin: PluginSession;
  /** Wall generator override for one island (first technology that answers wins). */
  walls?: (object: number, ex: ExPolygon, c: WallCtx) => WallResult | undefined;
  /** Infill for one sparse region: paths, and what is left for the regular pattern. */
  infill?: (object: number, region: Paths, c: InfillCtx) => { paths: InfillPath[]; rest: Paths } | undefined;
  regions?: (object: number, layer: number, regions: MaterialRegion[]) => MaterialRegion[];
  /** The slicer's layer plan (before walls and infill). */
  setLayers(z: number[], h: number[]): void;
  wallsPost?: (object: number, layer: number, ex: ExPolygon, rings: WallLoop[][]) => void;
  post(layers: LayerOps[], c: StageCtx): void;
  finalize(layers: LayerOps[], c: StageCtx): void;
  report(): AdvancedReport;
}

/** Tech parameters that no module reads yet (see AUDIT_WIRING.md). */
const UNWIRED_PARAMS: [TechId, string][] = TECHS.flatMap((t) => t.params.filter((p) => p.unwired).map((p): [TechId, string] => [t.id, p.key]));

export function createAdvancedSession(meshes: MeshInput[], cfg: Config, adv: AdvancedConfig, filaments: FilamentSlot[], warn: (m: string) => void): AdvancedSession {
  const t0 = now();
  const num = (k: string) => Number(cfg[k] ?? 0);
  const caps = machineCaps(adv.printerId, cfg, adv.machine);
  const nozzle = num('nozzle_diameter') || 0.4;
  const lw = (k: string) => num(k) || num('line_width') || nozzle * 1.05;
  const wallLoops = Math.max(1, Math.round(num('wall_loops')) || 2);
  const shell = lw('outer_wall_line_width') + (wallLoops - 1) * lw('inner_wall_line_width');
  const cells = RESOLUTION_CELLS[adv.resolution ?? 'normal'];
  const parts = meshes.map((m) => analyzePart(m as IndexedMesh, {
    cells, shell, lineWidth: lw('line_width'), layerHeight: num('layer_height') || 0.2, overhangDeg: num('support_threshold_angle') || 30, color: m.paint?.color,
    advPaint: m.paint?.adv, load: adv.load,
  }));
  const usedFils = new Set(meshes.map((m) => m.filament ?? 0));
  for (const m of meshes) m.paint?.color?.forEach((c) => { if (c) usedFils.add(c - 1); });
  const resolved = resolveTechs(adv, {
    caps, filamentType: filaments[0]?.type ?? String(cfg.filament_type ?? 'PLA'), materials: usedFils.size, wallLoops, hasCaustic: !!adv.caustic?.pixels?.length,
  });
  const techs = new Map(resolved.map((r) => [r.def.id, r]));
  const reports = new Map<TechId, TechReport>();
  const warnings: string[] = [];
  const ctx: SessionCtx = {
    cfg, num, caps, adv, filaments, meshes, parts, techs,
    report(id) { let r = reports.get(id); if (!r) { r = { id, status: 'applied', stats: {} }; reports.set(id, r); } return r; },
    warn(msg) { if (!warnings.includes(msg)) warnings.push(msg); warn(msg); },
    on(id) { const t = techs.get(id); return !!t && t.enabled && t.verdict.status !== 'unavailable'; },
    param(id, key) { return techs.get(id)!.params[key]; },
    pnum(id, key) { return Number(techs.get(id)!.params[key]); },
    nonPlanar: false,
    helicalLayers: new Set(),
    layerZ: [], layerH: [],
    shared: new Map(),
    memo<T>(key: string, make: () => T): T {
      if (!ctx.shared.has(key)) ctx.shared.set(key, make());
      return ctx.shared.get(key) as T;
    },
  };
  // parameters with no reader in this engine build: say so when the user changed them, instead of ignoring them silently
  for (const [id, key] of UNWIRED_PARAMS) {
    const t = techs.get(id);
    const spec = t?.def.params.find((p) => p.key === key);
    if (t?.enabled && spec && t.params[key] !== spec.def) ctx.warn(`${t.def.name}: "${spec.label}" is not implemented in this engine build; the setting is ignored.`);
  }
  const active = MODULES.filter((m) => ctx.on(m.id));
  const timed =<T>(id: TechId, fn: () => T): T => {
    const s = now();
    try { return fn(); } finally { const r = ctx.report(id); r.ms = (r.ms ?? 0) + (now() - s); }
  };
  for (const m of active) if (m.prepare) timed(m.id, () => m.prepare!(ctx));
  // curved layers: each layer technology refines the warp of the ones before it (dome field, then SGD)
  let warp: Warp | undefined;
  for (const m of active) if (m.warp) warp = timed(m.id, () => m.warp!(ctx, warp));
  ctx.warp = warp;
  const sliceMeshes = warp ? meshes.map((m) => warpMesh(m, warp!)) : meshes;
  let clearance: ClearanceReport | undefined;

  const reshapers = active.filter((m) => m.reshape);
  const wallers = active.filter((m) => m.walls);
  const fillers = active.filter((m) => m.infill);
  const wallPosts = active.filter((m) => m.wallsPost);
  const plugin: PluginSession = {
    reshape: reshapers.length ? (o, i, sl) => reshapers.reduce((acc, m) => timed(m.id, () => m.reshape!(ctx, o, i, acc, ctx.layerZ[i] ?? NaN)), sl) : undefined,
  };
  const walls = wallers.length ? (o: number, ex: ExPolygon, c: WallCtx) => {
    for (const m of wallers) { const r = timed(m.id, () => m.walls!(ctx, o, ex, c)); if (r) return r; }
    return undefined;
  } : undefined;
  // zone routing of the sparse infill: each technology fills the part of the region it is made for
  // (stress paths where the part is loaded, quasicrystal cores…) and passes on the rest
  const infill = fillers.length ? (o: number, region: Paths, c: InfillCtx) => {
    const paths: InfillPath[] = [];
    let rest = region, any = false;
    for (let k = 0; k < fillers.length && rest.length; k++) {
      const m = fillers[k];
      const r = timed(m.id, () => m.infill!(ctx, o, rest, c, k === fillers.length - 1));
      if (!r) continue;
      any = true;
      if (Array.isArray(r)) { pushAll(paths, r); rest = []; break; }
      pushAll(paths, r.paths);
      if (r.used.length) rest = difference(rest, r.used);
    }
    return any ? { paths, rest } : undefined;
  } : undefined;
  const regioners = active.filter((m) => m.regions);
  const regions = regioners.length ? (o: number, i: number, regs: MaterialRegion[]) => regioners.reduce((acc, m) => timed(m.id, () => m.regions!(ctx, o, i, acc)), regs) : undefined;

  const wallsPost = wallPosts.length ? (o: number, i: number, ex: ExPolygon, rings: WallLoop[][]) => {
    for (const m of wallPosts) timed(m.id, () => m.wallsPost!(ctx, o, i, ex, rings));
  } : undefined;

  return {
    ctx, meshes: sliceMeshes, warp, plugin, walls, infill, wallsPost, regions,
    setLayers(z, h) { ctx.layerZ = z; ctx.layerH = h; },
    post(layers, c) {
      // curved layers back to real space first, then every geometry pass, then the head-clearance check
      if (warp) { const n = unwarpLayers(layers, warp, 0.01, 0.3, caps.maxSlopeDeg); if (n) ctx.nonPlanar = true; }
      for (const m of active) if (m.post) timed(m.id, () => m.post!(ctx, layers, c));
      if (ctx.nonPlanar) {
        const lengths = snapshotLengths(layers);
        clearance = clearancePass(layers, caps.toolhead, caps.bed, true, 3);
        limitRamp(layers, caps.maxSlopeDeg);
        restoreLengths(layers, lengths);
        if (clearance.raised) ctx.warn(`Head clearance: lifted ${clearance.raised} non-planar points so the ${caps.toolhead.name} clears the print.`);
        if (clearance.unresolved) ctx.warn(`Head clearance: ${clearance.unresolved} non-planar points may touch the print with the ${caps.toolhead.name} (worst ${clearance.worstLeft.toFixed(2)} mm). Check the toolhead shape in Machine capabilities.`);
      }
    },
    finalize(layers, c) { for (const m of active) if (m.finalize) timed(m.id, () => m.finalize!(ctx, layers, c)); },
    report() {
      const zoneTotals = new Map<string, { kind: any; areaMm2: number; volumeMm3: number; triangles: number }>();
      for (const p of parts) for (const z of p.zones) {
        const s = zoneTotals.get(z.kind) ?? { kind: z.kind, areaMm2: 0, volumeMm3: 0, triangles: 0 };
        s.areaMm2 += z.areaMm2; s.volumeMm3 += z.volumeMm3; s.triangles += z.triangles;
        zoneTotals.set(z.kind, s);
      }
      const implemented = new Set(MODULES.map((m) => m.id));
      const techReports: TechReport[] = resolved.map((r) => {
        const used = reports.get(r.def.id);
        if (!r.enabled) return { id: r.def.id, status: 'disabled' };
        if (r.verdict.status === 'unavailable') return { id: r.def.id, status: 'unavailable', reason: r.verdict.reason };
        if (!implemented.has(r.def.id) && r.def.id !== 'sdf_frep') return { id: r.def.id, status: 'idle', reason: 'Not part of this engine build.' };
        const applied = r.def.id === 'sdf_frep' || (used && used.status === 'applied' && Object.keys(used.stats ?? {}).length > 0);
        const status = used?.status === 'idle' || !applied ? 'idle' : r.verdict.status === 'adapted' ? 'adapted' : 'applied';
        return { id: r.def.id, status, reason: used?.reason ?? r.verdict.reason, stats: used?.stats, ms: used?.ms };
      });
      const sdf = techReports.find((r) => r.id === 'sdf_frep');
      if (sdf && sdf.status !== 'disabled') {
        sdf.stats = { ...(sdf.stats ?? {}), voxels: parts.reduce((s, p) => s + p.sdf.sdf.n, 0), cell_mm: +Math.min(...parts.map((p) => p.sdf.sdf.h)).toFixed(3) };
      }
      return {
        intent: adv.intent,
        machine: { name: caps.name, kinematics: caps.kinematics, axes: caps.axes, maxSlopeDeg: +caps.maxSlopeDeg.toFixed(1), firmware: caps.firmware, notes: caps.notes },
        zones: [...zoneTotals.values()],
        techs: techReports,
        ...(clearance ? { clearance } : {}),
        warnings,
        ms: Math.round(now() - t0),
      };
    },
  };
}

/** Warp a mesh into curved-layer space (z → z′) so planar slicing yields curved layers. */
function warpMesh(m: MeshInput, w: Warp): MeshInput {
  const v = m.vertices.slice();
  for (let i = 0; i < v.length; i += 3) v[i + 2] = w.toWarped(v[i], v[i + 1], v[i + 2]);
  return { ...m, vertices: v, parts: m.parts?.map((p) => {
    const pv = p.vertices.slice();
    for (let i = 0; i < pv.length; i += 3) pv[i + 2] = w.toWarped(pv[i], pv[i + 1], pv[i + 2]);
    return { ...p, vertices: pv };
  }) };
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
