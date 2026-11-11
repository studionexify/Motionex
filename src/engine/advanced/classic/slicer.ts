// Frozen classic engine of Advanced mode (as on main at 08b924a). Advanced mode slices with this engine
// only, so Basic-engine changes never alter Advanced output and vice versa.
// The NexSpiro slicing pipeline (stages 2–10). Pure TypeScript, runs in a Web Worker or Node.
import { MODIFIER_KEYS, OBJECT_KEYS, type Config } from '../../../profiles/settings';
import {
  area, bounds, difference, exToPaths, intersection, offset, opening, SCALE, toExPolygons, union,
} from '../../clipper';
import ClipperLib from 'clipper-lib';
import { concentricFill, linesFill, sparseFill, type SparsePattern } from './fill';
import { emit, expandMacro, type LayerOps, type Op } from './gcode';
import { flushSplit, renderVendor, usesVendorTemplates } from '../../templateVars';
import type { IndexedMesh } from '../../mesh';
import { splitNarrow } from './arachne';
import { smoothOverhangRuns } from '../../overhangRuns';
import { orderLayerTools } from '../../toolmap';
import { orderPaths, pickSeam, rotateLoop, simplify, type SeamHints, type SeamMode } from '../../order';
import { colorRegionsAtZ, footprintsInBand, paintedTris, pointsAtZ, type PaintedTri } from '../../paint';
import { sliceMesh } from './slice';
import { preparePlugins, runPlugins } from '../../../plugins/engine';
import { changerOf, flushesIntoTower, slotCount, toolheadCount } from '../../../profiles/changer';
import { TRANSITION_MARKER, type FaceRegion, type TransitionPlan } from '../../../plugins/api';
import { computeOverhangs, generateSupport, generateTreeSupport } from './support';
import type { ExPolygon, FeatureType, FilamentSlot, MeshInput, Paths, Polyline2, SliceOptions, SliceOutput } from '../../types';
import { createAdvancedSession } from '../session';
import { pushAll } from '../../util';

const C: any = (ClipperLib as any).default ?? ClipperLib;

export type ProgressFn = (stage: string, pct: number) => void;

/** zs: per-point Z offsets (mm) from the layer top, for non-planar wall patterns (Advanced mode). */
interface PathItem extends Polyline2 { feature: FeatureType; width: number; flow: number; spiral?: boolean; widths?: number[]; zs?: number[] }

const spacingOf = (w: number, h: number) => w - h * (1 - Math.PI / 4);

function pathToPoly(p: Paths[number]): number[] {
  const out: number[] = [];
  for (const q of p) out.push(q.X / SCALE, q.Y / SCALE);
  return out;
}

function pointInPaths(x: number, y: number, paths: Paths): boolean {
  const pt = { X: Math.round(x * SCALE), Y: Math.round(y * SCALE) };
  let inside = 0;
  for (const p of paths) if (C.Clipper.PointInPolygon(pt, p) !== 0) inside++;
  return inside % 2 === 1;
}

const rectPath = (x0: number, y0: number, x1: number, y1: number) => [
  { X: Math.round(x0 * SCALE), Y: Math.round(y0 * SCALE) }, { X: Math.round(x1 * SCALE), Y: Math.round(y0 * SCALE) },
  { X: Math.round(x1 * SCALE), Y: Math.round(y1 * SCALE) }, { X: Math.round(x0 * SCALE), Y: Math.round(y1 * SCALE) },
];

/** Splits a wall loop into runs, marking segments unsupported by the layer below as overhang. */
function splitOverhang(item: PathItem, support: Paths | null): PathItem[] {
  if (!support) return [item];
  const pts = item.closed ? [...item.pts, item.pts[0], item.pts[1]] : item.pts;
  const n = pts.length / 2;
  const runs: PathItem[] = [];
  // per segment (index k = segment k-1 → k), then short flickering runs merged so the wall only switches where the overhang is real
  const feats: FeatureType[] = new Array(n).fill(item.feature);
  for (let i = 0; i < n - 1; i++) {
    const mx = (pts[i * 2] + pts[i * 2 + 2]) / 2, my = (pts[i * 2 + 1] + pts[i * 2 + 3]) / 2;
    if (!pointInPaths(mx, my, support)) feats[i + 1] = 'overhang_wall';
  }
  smoothOverhangRuns(pts, false, feats, new Array(n).fill(0), new Array(n).fill(0), Math.max(4, 8 * item.width));
  let curFeat: FeatureType | null = null;
  let cur: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const f = feats[i + 1];
    if (f !== curFeat) {
      if (cur.length >= 4) runs.push({ ...item, feature: curFeat!, pts: cur, closed: false });
      cur = [pts[i * 2], pts[i * 2 + 1]];
      curFeat = f;
    }
    cur.push(pts[i * 2 + 2], pts[i * 2 + 3]);
  }
  if (cur.length >= 4) runs.push({ ...item, feature: curFeat!, pts: cur, closed: false });
  if (runs.length === 1 && runs[0].feature === item.feature) return [item];
  return runs;
}

function fuzz(pts: number[], thick: number, dist: number, rnd: () => number): number[] {
  const out: number[] = [];
  const n = pts.length / 2;
  for (let i = 0; i < n; i++) {
    const ax = pts[i * 2], ay = pts[i * 2 + 1];
    const bx = pts[((i + 1) % n) * 2], by = pts[((i + 1) % n) * 2 + 1];
    const len = Math.hypot(bx - ax, by - ay);
    const steps = Math.max(1, Math.floor(len / dist));
    const nx = len ? -(by - ay) / len : 0, ny = len ? (bx - ax) / len : 0;
    for (let s = 0; s < steps; s++) {
      const t = s / steps, r = (rnd() * 2 - 1) * thick;
      out.push(ax + (bx - ax) * t + nx * r, ay + (by - ay) * t + ny * r);
    }
  }
  return out;
}

function mulberry(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (o: Record<string, unknown> | undefined, keys: string[]) =>
  Object.fromEntries(Object.entries(o ?? {}).filter(([k]) => keys.includes(k))) as Config;

/** Filament slot derived from the flat config (single-material default). */
export function slotFromConfig(cfg: Config): FilamentSlot {
  return {
    name: String(cfg.filament_settings_id ?? 'Filament'), type: String(cfg.filament_type ?? 'PLA'), color: String(cfg.filament_colour ?? '#5DBE7A'),
    diameter: Number(cfg.filament_diameter ?? 1.75), density: Number(cfg.filament_density ?? 1.24), cost: Number(cfg.filament_cost ?? 20),
    nozzleTemp: Number(cfg.nozzle_temperature ?? 210), nozzleTempInitial: Number(cfg.nozzle_temperature_initial_layer ?? 210),
    flowRatio: Number(cfg.filament_flow_ratio ?? 1), maxVolumetricSpeed: Number(cfg.filament_max_volumetric_speed ?? 15),
  };
}

interface Island { obj: number; fil: number; ex: ExPolygon; loops: PathItem[][]; inner: Paths; thin: PathItem[] }
type Regions = { top: Paths; bottom: Paths; bridge: Paths; solid: Paths; sparse: Paths; sparseMods: { paths: Paths; density: number; pattern: SparsePattern }[] };

/** Pressure advance command for the firmware flavour. */
export const paLine = (flavor: string, k: number) => (flavor === 'klipper' ? `SET_PRESSURE_ADVANCE ADVANCE=${k}` : `M900 K${k}`);

export function slice(meshes: MeshInput[], cfg: Config, progress: ProgressFn = () => {}, opts: SliceOptions = {}): SliceOutput {
  // values changed mid-print by 'config' layer actions (calibration towers etc.)
  const live: Record<string, number> = {};
  const num = (k: string) => (k in live ? live[k] : Number(cfg[k] ?? 0));
  const str = (k: string) => String(cfg[k] ?? '');
  const bool = (k: string) => cfg[k] === true;
  const warnings: string[] = [];
  const rnd = mulberry(42);
  const filaments = opts.filaments?.length ? opts.filaments : [slotFromConfig(cfg)];
  const clampFil = (f: number) => Math.max(0, Math.min(filaments.length - 1, f | 0));

  // Advanced mode: analyse the parts, route zones to technologies; curved layers warp the meshes
  let realMaxZ = 0;
  for (const m of meshes) for (let i = 2; i < m.vertices.length; i += 3) realMaxZ = Math.max(realMaxZ, m.vertices[i]);
  const adv = opts.advanced ? (progress('Analysing parts (Advanced)', 0.01), createAdvancedSession(meshes, cfg, opts.advanced, filaments, () => {})) : undefined;
  if (adv) meshes = adv.meshes;

  // per-object effective config
  const ocfg: Config[] = meshes.map((m) => ({ ...cfg, ...pick(m.overrides, OBJECT_KEYS) }));
  const onum = (o: number, k: string) => Number(ocfg[o][k] ?? 0);
  const ostr = (o: number, k: string) => String(ocfg[o][k] ?? '');

  const nozzle = num('nozzle_diameter');
  const lw = (k: string) => num(k) || num('line_width') || nozzle * 1.05;
  const h0 = num('initial_layer_print_height');
  const hN = num('layer_height');
  const vase = bool('spiral_mode');
  const flavor = str('gcode_flavor');
  const changer = changerOf(cfg);
  const hasAms = changer !== 'manual';
  const toolChanger = changer === 'toolchanger';
  const towerFlush = flushesIntoTower(cfg); // a filament unit without a purge chute flushes onto the prime tower

  // ---------- layer plan (variable layer height profile if any object has one)
  let maxZ = 0;
  for (const m of meshes) for (let i = 2; i < m.vertices.length; i += 3) maxZ = Math.max(maxZ, m.vertices[i]);
  if (maxZ <= 0) throw new Error('Nothing to slice: the plate is empty.');
  const zs: number[] = [], hs: number[] = [];
  const profile = vase ? undefined : meshes.find((m) => m.layerHeights?.length)?.layerHeights;
  let z = 0;
  if (profile) {
    if (meshes.filter((m) => m.layerHeights?.length).length > 1) warnings.push('Several objects have variable layer heights; the first profile is used for the whole plate.');
    for (const h of profile) {
      if (z + h * 0.5 >= maxZ) break;
      z = +(z + h).toFixed(4); zs.push(z); hs.push(h);
    }
  } else { z = h0; zs.push(z); hs.push(h0); }
  while (z + hN * 0.5 < maxZ) { z = +(z + hN).toFixed(4); zs.push(z); hs.push(hN); }
  const N = zs.length;
  const planes = zs.map((zz, i) => zz - hs[i] / 2);
  adv?.setLayers(zs, hs);

  // ---------- stage 2/3: slice objects & parts
  progress('Slicing mesh', 0.04);
  const objSlices: Paths[][] = [];
  const modSlices: { o: number; ov: Config; slices: Paths[] }[] = [];
  const encVol: Paths[] = Array.from({ length: N }, () => []);
  const blkVol: Paths[] = Array.from({ length: N }, () => []);
  meshes.forEach((m, oi) => {
    const s = sliceMesh(m as IndexedMesh, planes);
    const negatives = (m.parts ?? []).filter((p) => p.type === 'negative').map((p) => sliceMesh(p as IndexedMesh, planes));
    if (negatives.length) for (let i = 0; i < N; i++) {
      const cut = negatives.flatMap((n) => n[i]);
      if (cut.length && s[i].length) s[i] = difference(s[i], union(cut));
    }
    for (const p of m.parts ?? []) {
      if (p.type === 'modifier') {
        const ov = pick(p.overrides, MODIFIER_KEYS);
        if (Object.keys(ov).length) modSlices.push({ o: oi, ov, slices: sliceMesh(p as IndexedMesh, planes) });
      } else if (p.type === 'support_enforcer' || p.type === 'support_blocker') {
        const ps = sliceMesh(p as IndexedMesh, planes);
        const target = p.type === 'support_enforcer' ? encVol : blkVol;
        for (let i = 0; i < N; i++) if (ps[i].length) target[i] = target[i].concat(ps[i]);
      }
    }
    objSlices.push(s);
    progress('Slicing mesh', 0.04 + 0.14 * ((oi + 1) / meshes.length));
  });
  const xyc = num('xy_contour_compensation'), xyh = num('xy_hole_compensation'), efc = num('elefant_foot_compensation');
  for (const sl of objSlices) {
    for (let i = 0; i < N; i++) {
      if ((xyc || xyh) && sl[i].length) {
        const exs = toExPolygons(sl[i]);
        const outer = offset(exs.map((e) => e.contour), xyc);
        const holes = offset(exs.flatMap((e) => e.holes.map((h) => h.slice().reverse())), xyh);
        sl[i] = difference(outer, holes);
      }
      if (i === 0 && efc > 0) sl[i] = offset(sl[i], -efc);
    }
  }
  const layerSlices: Paths[] = Array.from({ length: N }, (_, i) => union(objSlices.flatMap((s) => s[i])));

  // ---------- multi-material: base filament per layer (colour-change actions) + painted colour regions
  const colorActions = (opts.layerActions ?? []).filter((a) => a.type === 'color' && a.filament !== undefined).sort((a, b) => a.z - b.z);
  const baseFilAt = (o: number, i: number) => {
    let f = clampFil(meshes[o].filament ?? 0);
    for (const a of colorActions) if (zs[i] >= a.z - 1e-6) f = clampFil(a.filament!);
    return f;
  };
  const colorTris: PaintedTri[][] = meshes.map((m) => paintedTris(m as IndexedMesh, m.paint?.color));
  // painted colour reach (Orca / Bambu "Maximum width of a segmented region"; 0 = nearest surface, no limit), deeper every
  // other layer by the interlocking depth
  const segWidth = Math.max(0, num('mmu_segmented_region_max_width')), segInterlock = Math.max(0, num('mmu_segmented_region_interlocking_depth'));
  // with no width limit a painted top / bottom face colours its shell, as deep as the top / bottom shells
  const paintFlatReach = Math.max(0.5, num('top_shell_thickness'), num('bottom_shell_thickness'), num('top_shell_layers') * num('layer_height'), num('bottom_shell_layers') * num('layer_height'));
  const paintDepthAt = (i: number) => (segWidth > 0 ? segWidth + (segInterlock > 0 && i % 2 === 1 ? segInterlock : 0) : 0);
  // plugins that add material regions (Patternex) are set up here, before perimeters
  const sessions = preparePlugins(opts.plugins, {
    cfg, meshes, layerZ: zs, layerH: hs, planes, sliceAt: (o, i) => objSlices[o]?.[i] ?? [],
    filamentCount: filaments.length, hasAms, changer, toolheads: toolheadCount(cfg), warn: (msg) => { if (!warnings.includes(msg)) warnings.push(msg); },
  });
  if (adv) sessions.set('nexspiro-advanced', adv.plugin);
  // raised / recessed artwork changes the cross-sections themselves, before walls, surfaces and support
  const reshapers = [...sessions.values()].filter((x) => x.reshape);
  if (reshapers.length) {
    const next = objSlices.map((sl, o) => sl.map((p, i) => reshapers.reduce((acc, x) => x.reshape!(o, i, acc), p)));
    next.forEach((sl, o) => sl.forEach((p, i) => { objSlices[o][i] = p; }));
    for (let i = 0; i < N; i++) layerSlices[i] = union(objSlices.flatMap((sl) => sl[i]));
  }
  const modifierPlugins = [...sessions.values()].filter((x) => x.modifiersAt);
  const regionPlugins = [...sessions.values()].filter((x) => x.regionsAt);
  const transitionPlugins = [...sessions.values()].filter((x) => x.transition);
  const filRegionsCache = new Map<number, { fil: number; paths: Paths }[]>();
  const paintOverlapWarned = new Set<number>();
  const filRegions = (o: number, i: number): { fil: number; paths: Paths }[] => {
    const key = o * 1_000_000 + i;
    const hit = filRegionsCache.get(key);
    if (hit) return hit;
    const r = filRegionsUncached(o, i);
    filRegionsCache.set(key, r);
    return r;
  };
  const filRegionsUncached = (o: number, i: number): { fil: number; paths: Paths }[] => {
    const sl = objSlices[o][i];
    if (!sl.length) return [];
    const base = baseFilAt(o, i);
    const contribs = regionPlugins.flatMap((x) => x.regionsAt!(o, i));
    if (!colorTris[o].length && !contribs.length) return [{ fil: base, paths: sl }];
    const map = colorTris[o].length ? colorRegionsAtZ(meshes[o] as IndexedMesh, colorTris[o], sl, planes[i], paintDepthAt(i), paintFlatReach) : new Map<number, Paths>();
    let out: { fil: number; paths: Paths }[] = [];
    let taken: Paths = [];
    for (const [c, paths] of [...map.entries()].sort((a, b) => a[0] - b[0])) {
      const fil = clampFil(c - 1);
      const r = taken.length ? difference(paths, taken) : paths;
      if (!r.length) continue;
      out.push({ fil, paths: r });
      taken = union(taken, r);
    }
    const rest = taken.length ? difference(sl, taken) : sl;
    if (rest.length) out.unshift({ fil: base, paths: rest });
    // plugin regions win over paint and the base material; later contributions win over earlier ones
    for (const c of contribs) {
      const r = intersection(c.paths, sl);
      if (!r.length) continue;
      if (taken.length && !paintOverlapWarned.has(o) && intersection(r, taken).length) {
        paintOverlapWarned.add(o);
        warnings.push(`${meshes[o].name}: Patternex artwork covers colour paint; the artwork's ink is used there (artwork › paint › object filament).`);
      }
      out = out.map((e) => ({ fil: e.fil, paths: difference(e.paths, r) })).filter((e) => e.paths.length);
      out.push({ fil: clampFil(c.fil), paths: r });
    }
    // merge regions sharing a filament
    const merged = new Map<number, Paths>();
    for (const r of out) merged.set(r.fil, merged.has(r.fil) ? union(merged.get(r.fil)!, r.paths) : r.paths);
    const regs = [...merged].map(([fil, paths]) => ({ fil, paths }));
    // Advanced: material interfaces (dovetail fingers)
    return adv?.regions && regs.length > 1 ? adv.regions(o, i, regs) : regs;
  };

  // ---------- stage 4: perimeters (classic), per object & filament region
  progress('Generating perimeters', 0.2);
  const wo0 = lw('outer_wall_line_width'), wi0 = lw('inner_wall_line_width');
  const arachne = str('wall_generator') === 'arachne' && !vase;
  const layerIslands: Island[][] = [];
  const layerInner: Paths[][] = []; // [layer][obj]
  const filInner: Map<number, Paths>[][] = []; // [layer][obj] fil -> inner
  for (let i = 0; i < N; i++) {
    const h = hs[i];
    const wo = i === 0 ? lw('initial_layer_line_width') : wo0;
    const wi = i === 0 ? lw('initial_layer_line_width') : wi0;
    const so = spacingOf(wo, h), si = spacingOf(wi, h);
    const islands: Island[] = [];
    const inners: Paths[] = [];
    const finners: Map<number, Paths>[] = [];
    for (let oi = 0; oi < meshes.length; oi++) {
      const walls = vase ? 1 : Math.max(0, Math.round(onum(oi, 'wall_loops')));
      const objInner: Paths = [];
      const fmap = new Map<number, Paths>();
      for (const reg of filRegions(oi, i)) {
        const regInner: Paths = [];
        for (const ex of toExPolygons(reg.paths)) {
          const ip = exToPaths(ex);
          const loops: PathItem[][] = [];
          const custom = adv?.walls && !vase && walls > 0 ? adv.walls(oi, ex, { walls, wo, wi, so, si, h, z: zs[i], layer: i }) : undefined;
          if (custom) {
            for (const ring of custom.loops) loops.push(ring.map((l) => ({ ...l })));
            if (adv?.wallsPost) adv.wallsPost(oi, i, ex, loops);
            pushAll(regInner, custom.inner);
            islands.push({ obj: oi, fil: reg.fil, ex, loops, inner: custom.inner, thin: [] });
            continue;
          }
          if (arachne && walls > 0) {
            // variable-width walls: narrow areas get one bead whose width follows the region
            const thin: PathItem[] = [];
            let A = ip;
            for (let k = 0; k < walls && A.length; k++) {
              const w = k === 0 ? wo : wi, sp = k === 0 ? so : si;
              const sn = splitNarrow(A, w, nozzle * 0.3, Math.min(2 * w, nozzle * 2));
              const feature: FeatureType = k === 0 ? 'outer_wall' : 'inner_wall';
              for (const t of sn.thin) thin.push({ ...t, feature, width: t.widths.reduce((a, b) => a + b, 0) / t.widths.length, flow: 1 });
              const ps = sn.wide.length ? offset(sn.wide, -w / 2).filter((p) => p.length >= 3) : [];
              if (ps.length) loops.push(ps.map((p) => ({ pts: pathToPoly(p), closed: true, feature, width: w, flow: 1 })));
              A = sn.wide.length ? offset(sn.wide, -sp) : [];
            }
            pushAll(regInner, A);
            if (adv?.wallsPost) adv.wallsPost(oi, i, ex, loops);
            islands.push({ obj: oi, fil: reg.fil, ex, loops, inner: A, thin });
            continue;
          }
          let boundary = 0;
          for (let k = 0; k < walls; k++) {
            const d = k === 0 ? wo / 2 : wo / 2 + (so + si) / 2 + (k - 1) * si;
            const ps = offset(ip, -d);
            if (!ps.length) break;
            const w = k === 0 ? wo : wi;
            loops.push(ps.filter((p) => p.length >= 3).map((p) => ({
              pts: pathToPoly(p), closed: true, feature: (k === 0 ? 'outer_wall' : 'inner_wall') as FeatureType, width: w, flow: 1,
            })));
            boundary = d + (k === 0 ? so : si) / 2;
          }
          const inner = walls > 0 ? (loops.length === walls ? offset(ip, -boundary) : []) : ip;
          if (adv?.wallsPost && !vase) adv.wallsPost(oi, i, ex, loops);
          pushAll(regInner, inner);
          islands.push({ obj: oi, fil: reg.fil, ex, loops, inner, thin: [] });
        }
        const u = union(regInner);
        fmap.set(reg.fil, u);
        pushAll(objInner, u);
      }
      inners.push(union(objInner));
      finners.push(fmap);
    }
    layerIslands.push(islands);
    layerInner.push(inners);
    filInner.push(finners);
    if (i % 10 === 0) progress('Generating perimeters', 0.2 + 0.15 * (i / N));
  }

  // ---------- stage 5: region classification (per object)
  progress('Classifying surfaces', 0.36);
  const regions: Regions[][] = [];
  for (let i = 0; i < N; i++) {
    const per: Regions[] = [];
    for (let o = 0; o < meshes.length; o++) {
      const empty: Regions = { top: [], bottom: [], bridge: [], solid: [], sparse: [], sparseMods: [] };
      const inner = layerInner[i][o];
      if (!inner.length) { per.push(empty); continue; }
      const density = vase ? 0 : onum(o, 'sparse_infill_density') / 100;
      const topLayers = vase ? 0 : Math.max(Math.round(onum(o, 'top_shell_layers')), onum(o, 'top_shell_thickness') > 0 ? Math.ceil(onum(o, 'top_shell_thickness') / hN - 1e-6) : 0);
      const botLayers = Math.max(Math.round(onum(o, 'bottom_shell_layers')), onum(o, 'bottom_shell_thickness') > 0 ? Math.ceil(onum(o, 'bottom_shell_thickness') / hN - 1e-6) : 0);
      const sw = lw('internal_solid_infill_line_width');
      const clean = (p: Paths) => opening(p, sw * 0.25);
      const above = i + 1 < N ? objSlices[o][i + 1] : [];
      const below = i > 0 ? objSlices[o][i - 1] : [];
      // no top shells at all (0 layers, 0 thickness) leaves the top open, as in Bambu Studio / Orca
      let top = (vase && i >= botLayers) || topLayers === 0 ? [] : clean(i + 1 < N ? difference(inner, above) : inner);
      const bottomAll = clean(i > 0 ? difference(inner, below) : inner);
      const bottom = i === 0 ? bottomAll : [];
      let bridge = i === 0 ? [] : bottomAll;
      if (vase && i >= botLayers) { top = []; bridge = []; }

      let solid: Paths = [];
      if (vase) solid = i < botLayers ? inner : [];
      else {
        if (topLayers > 0) {
          let cov: Paths | null = null;
          for (let k = 1; k <= topLayers; k++) {
            if (i + k >= N) { cov = []; break; }
            cov = cov === null ? layerInner[i + k][o] : intersection(cov, layerInner[i + k][o]);
            if (!cov.length) break;
          }
          solid = solid.concat(difference(inner, cov ?? []));
        }
        if (botLayers > 0) {
          let cov: Paths | null = null;
          for (let k = 1; k <= botLayers; k++) {
            if (i - k < 0) { cov = []; break; }
            cov = cov === null ? layerInner[i - k][o] : intersection(cov, layerInner[i - k][o]);
            if (!cov.length) break;
          }
          solid = solid.concat(difference(inner, cov ?? []));
        }
        solid = clean(difference(union(solid), union([...top, ...bottom, ...bridge])));
      }
      let sparse = vase ? [] : difference(inner, union([...top, ...bottom, ...bridge, ...solid]));
      if (density >= 0.999) { solid = union([...solid, ...sparse]); sparse = []; }
      else if (num('minimum_sparse_infill_area') > 0 && sparse.length) {
        const small = toExPolygons(sparse).filter((e) => area(e.contour) + e.holes.reduce((s2, hh) => s2 + area(hh), 0) < num('minimum_sparse_infill_area'));
        if (small.length) {
          const sp = small.flatMap(exToPaths);
          solid = union([...solid, ...sp]);
          sparse = difference(sparse, sp);
        }
      }
      // modifier volumes re-parameterise sparse infill inside them
      const sparseMods: Regions['sparseMods'] = [];
      for (const mod of modSlices) {
        if (mod.o !== o || !mod.slices[i].length || !sparse.length) continue;
        const r = intersection(sparse, mod.slices[i]);
        if (!r.length) continue;
        sparse = difference(sparse, mod.slices[i]);
        const d = mod.ov.sparse_infill_density !== undefined ? Number(mod.ov.sparse_infill_density) / 100 : density;
        const pat = (mod.ov.sparse_infill_pattern ?? ostr(o, 'sparse_infill_pattern')) as SparsePattern;
        if (d >= 0.999) solid = union(solid, r);
        else if (d > 0) sparseMods.push({ paths: r, density: d, pattern: pat });
      }
      // plugin regions with their own infill (Patternex effects) work the same way
      for (const x of modifierPlugins) for (const mod of x.modifiersAt!(o, i)) {
        if (!sparse.length) break;
        const r = intersection(sparse, mod.paths);
        if (!r.length) continue;
        sparse = difference(sparse, mod.paths);
        const d = mod.overrides.sparse_infill_density !== undefined ? Number(mod.overrides.sparse_infill_density) / 100 : density;
        const pat = (mod.overrides.sparse_infill_pattern ?? ostr(o, 'sparse_infill_pattern')) as SparsePattern;
        if (d >= 0.999) solid = union(solid, r);
        else if (d > 0) sparseMods.push({ paths: r, density: d, pattern: pat });
      }
      per.push({ top, bottom, bridge, solid, sparse, sparseMods });
    }
    regions.push(per);
    if (i % 10 === 0) progress('Classifying surfaces', 0.36 + 0.14 * (i / N));
  }

  // ---------- stage 6: support (auto overhangs + painted/volume enforcers & blockers)
  let support: { base: Paths[]; iface: Paths[] } | null = null;
  if (bool('enable_support')) {
    progress('Generating support', 0.5);
    const type = str('support_type') || 'normal_auto';
    const manual = type.endsWith('manual');
    const sw = lw('support_line_width');
    const over: Paths[] = manual ? Array.from({ length: N }, () => []) : computeOverhangs(layerSlices, hs, num('support_threshold_angle'), bool('support_remove_small_overhang'), sw);
    const supTris = meshes.map((m) => paintedTris(m as IndexedMesh, m.paint?.support));
    const blocked: Paths[] = Array.from({ length: N }, () => []);
    for (let i = 1; i < N; i++) {
      const add: Paths = [];
      let sub: Paths = [];
      meshes.forEach((m, o) => {
        if (!supTris[o].length) return;
        const enf = footprintsInBand(m as IndexedMesh, supTris[o], 1, zs[i] - hs[i], zs[i]);
        if (enf.length) pushAll(add, difference(intersection(enf, objSlices[o][i]), objSlices[o][i - 1]));
        const blk = footprintsInBand(m as IndexedMesh, supTris[o], 2, zs[i] - hs[i], zs[i], 0.5);
        if (blk.length) sub = sub.concat(blk);
      });
      if (encVol[i].length) pushAll(add, intersection(difference(layerSlices[i], layerSlices[i - 1]), union(encVol[i])));
      if (add.length) over[i] = union(over[i], add);
      if (sub.length && over[i].length) over[i] = difference(over[i], union(sub));
      if (blkVol[i].length) blocked[i] = union(blkVol[i]);
    }
    const common = {
      topZDistance: num('support_top_z_distance'), xyDistance: num('support_object_xy_distance'),
      interfaceLayers: Math.round(num('support_interface_top_layers')), buildPlateOnly: bool('support_on_build_plate_only'),
      lineWidth: sw, blocked,
    };
    support = type.startsWith('tree')
      ? generateTreeSupport(layerSlices, hs, over, {
        ...common, branchAngle: num('tree_support_branch_angle') || 40, tipDiameter: num('tree_support_tip_diameter') || 1.6,
        branchDiameter: num('tree_support_branch_diameter') || 6, branchDistance: num('tree_support_branch_distance') || 4,
      })
      : generateSupport(layerSlices, hs, over, common);
  }

  // ---------- filament plan & prime tower
  const supportFil = num('support_filament') > 0 ? clampFil(num('support_filament') - 1) : -1;
  const layerFils: number[][] = [];
  const usedFils = new Set<number>();
  for (let i = 0; i < N; i++) {
    const s = new Set(layerIslands[i].map((isl) => isl.fil));
    if (support && supportFil >= 0 && (support.base[i].length || support.iface[i].length)) s.add(supportFil);
    layerFils.push([...s]);
    s.forEach((f) => usedFils.add(f));
  }
  // simulate tool order: current tool first, then ascending
  const changesPerLayer: number[] = [];
  {
    let cur = -1;
    for (let i = 0; i < N; i++) {
      const order = orderLayerTools(layerFils[i], cur, i, opts.filamentSequence);
      let c = 0;
      for (const f of order) { if ((cur !== -1 || (towerFlush && usedFils.size > 1)) && f !== cur) c++; cur = f; }
      changesPerLayer.push(c);
    }
  }
  const useTower = (bool('enable_prime_tower') || towerFlush) && usedFils.size > 1 && !vase;
  if (towerFlush && useTower && !bool('enable_prime_tower')) warnings.push('This filament unit has no purge chute, so the flush goes onto the prime tower: the tower is printed even though it is off.');
  const lastChangeLayer = changesPerLayer.reduce((a, c, i) => (c > 0 ? i : a), -1);
  const tw = num('prime_tower_width') || 35;
  const maxFlush = Math.max(0, ...[...usedFils].flatMap((p) => [...usedFils].filter((f) => f !== p).map((f) => opts.flushMatrix?.[p]?.[f] ?? num('flush_volume') ?? 0)));
  const primeVol = (num('prime_volume') || 45) + (towerFlush ? maxFlush : hasAms ? 0 : num('flush_volume'));
  const bandDepth = Math.max(1.5, primeVol / (tw * hN));
  const maxChanges = Math.max(1, ...changesPerLayer);
  const td = Math.max(4, bandDepth * maxChanges);
  let tx = num('prime_tower_x'), ty = num('prime_tower_y');
  // unset: the printer's default position (Bambu Studio's default_wipe_tower_pos, a fraction of the bed), kept on the bed
  const towerPos = /^\s*([\d.]+)\s*x\s*([\d.]+)\s*$/i.exec(str('default_wipe_tower_pos'));
  const brimM = Math.max(0, num('prime_tower_brim_width')) + 2;
  if (tx < 0) tx = towerPos ? Math.min(Math.max(brimM, Number(towerPos[1]) * num('bed_x')), num('bed_x') - tw - brimM) : Math.max(5, num('bed_x') - tw - 15);
  if (ty < 0) ty = towerPos ? Math.min(Math.max(brimM, Number(towerPos[2]) * num('bed_y')), num('bed_y') - td - brimM) : Math.max(5, num('bed_y') - td - 25);
  if (useTower) {
    const tb = offset([rectPath(tx, ty, tx + tw, ty + td)], 3);
    if (intersection(tb, layerSlices[0]).length) warnings.push('The prime tower overlaps an object — move it in Others › Prime tower.');
    if (tx + tw > num('bed_x') || ty + td > num('bed_y')) warnings.push('The prime tower does not fit on the plate.');
  }

  // ---------- bed adhesion (first layer)
  const brimLoops: PathItem[] = [];
  const skirtLoops: PathItem[] = [];
  {
    const w = lw('initial_layer_line_width');
    const s = spacingOf(w, h0);
    let brimType = str('brim_type');
    if (brimType === 'auto_brim') {
      const b = bounds(layerSlices[0]);
      const minDim = Math.min(b.maxX - b.minX, b.maxY - b.minY) / SCALE;
      brimType = isFinite(minDim) && (maxZ / Math.max(minDim, 0.1) > 3 || minDim < 6) ? 'outer_only' : 'no_brim';
    }
    const bw = num('brim_width'), gap = num('brim_object_gap');
    const exs0 = toExPolygons(layerSlices[0]);
    if (brimType !== 'no_brim' && bw > 0) {
      const count = Math.max(1, Math.floor(bw / s));
      const outers = exs0.map((e) => e.contour);
      if (brimType === 'outer_only' || brimType === 'outer_and_inner') {
        for (let k = count - 1; k >= 0; k--) for (const p of offset(outers, gap + w / 2 + k * s)) brimLoops.push({ pts: pathToPoly(p), closed: true, feature: 'brim', width: w, flow: 1 });
      }
      if (brimType === 'inner_only' || brimType === 'outer_and_inner') {
        const holes = exs0.flatMap((e) => e.holes.map((h) => h.slice().reverse()));
        for (let k = 0; k < count; k++) for (const p of offset(holes, -(gap + w / 2 + k * s))) brimLoops.push({ pts: pathToPoly(p), closed: true, feature: 'brim', width: w, flow: 1 });
      }
    }
    // brim and skirt lines past the bed (less half a line) would be printed off the edge of the plate
    const bx = num('bed_x'), by = num('bed_y');
    const offBed = (loops: PathItem[]) => loops.some((l) => { for (let k = 0; k < l.pts.length; k += 2) if (l.pts[k] < w / 2 - 1e-3 || l.pts[k + 1] < w / 2 - 1e-3 || l.pts[k] > bx - w / 2 + 1e-3 || l.pts[k + 1] > by - w / 2 + 1e-3) return true; return false; });
    if (brimLoops.length && offBed(brimLoops)) {
      // a brim wider than the room around the part: fill only the part of its area that is on the bed
      const outer = brimType === 'outer_only' || brimType === 'outer_and_inner', inner = brimType === 'inner_only' || brimType === 'outer_and_inner';
      // inner loops are kept where they fit; the outer band is taken from the contours only (never the holes)
      const keepInner = inner ? brimLoops.filter((l) => l.pts.length && !offBed([l]) && exs0.some((e) => pointInPaths(l.pts[0], l.pts[1], [e.contour]))) : [];
      const contours = exs0.map((e) => e.contour);
      const outerArea = outer ? intersection(difference(offset(contours, gap + bw + w / 2), offset(contours, gap)), [rectPath(w / 2, w / 2, bx - w / 2, by - w / 2)]) : [];
      brimLoops.length = 0;
      pushAll(brimLoops, keepInner);
      for (const p of concentricFill(outerArea, s, w / 2)) brimLoops.push({ ...p, feature: 'brim', width: w, flow: 1 });
      warnings.push('The brim is cut at the edge of the plate: the part is too close to the edge for the full brim width.');
    }
    const skirtN = Math.round(num('skirt_loops'));
    if (skirtN > 0) {
      let base = union([...layerSlices[0], ...(support ? [...support.base[0], ...support.iface[0]] : []), ...(useTower ? [rectPath(tx, ty, tx + tw, ty + td)] : [])]);
      if (brimLoops.length) base = union(base, offset(base, gap + bw));
      let dropped = 0;
      for (let k = skirtN - 1; k >= 0; k--) {
        for (const p of offset(base, num('skirt_distance') + w / 2 + k * s, 'round')) {
          const loop: PathItem = { pts: pathToPoly(p), closed: true, feature: 'skirt', width: w, flow: 1 };
          if (offBed([loop])) dropped++; else skirtLoops.push(loop);
        }
      }
      if (dropped) warnings.push(`${dropped} skirt loop${dropped === 1 ? '' : 's'} would leave the plate and ${dropped === 1 ? 'was' : 'were'} left out.`);
    }
  }

  // ---------- stage 7/8: infill, ordering, ops
  progress('Generating infill & toolpaths', 0.58);
  const resolution = num('resolution');
  const solidDir = num('solid_infill_direction');
  const wallSeq = str('wall_sequence');

  let curObj = -1; // object being emitted: per-object speeds apply to its features
  const speedFor = (feat: FeatureType, layer: number): number => {
    const num = (k: string) => (k in live ? live[k] : curObj >= 0 ? onum(curObj, k) : Number(cfg[k] ?? 0));
    if (layer === 0) {
      if (feat === 'outer_wall' || feat === 'inner_wall' || feat === 'overhang_wall' || feat === 'skirt' || feat === 'brim' || feat === 'prime_tower') return num('initial_layer_speed');
      return num('initial_layer_infill_speed');
    }
    switch (feat) {
      case 'outer_wall': return num('outer_wall_speed');
      case 'inner_wall': return num('inner_wall_speed');
      case 'overhang_wall': return num('overhang_speed');
      case 'sparse_infill': return num('sparse_infill_speed');
      case 'internal_solid_infill': case 'bottom_surface': return num('internal_solid_infill_speed');
      case 'top_surface': return num('top_surface_speed');
      case 'bridge': return num('bridge_speed');
      case 'ironing': return num('ironing_speed');
      case 'support': return num('support_speed');
      case 'support_interface': return num('support_interface_speed');
      case 'prime_tower': return Math.min(num('sparse_infill_speed'), 150);
      default: return num('initial_layer_speed');
    }
  };
  const accelFor = (feat: FeatureType, layer: number): number => {
    if (layer === 0) return num('initial_layer_acceleration');
    if (feat === 'outer_wall' || feat === 'overhang_wall') return num('outer_wall_acceleration');
    if (feat === 'top_surface' || feat === 'ironing') return num('top_surface_acceleration');
    return num('default_acceleration');
  };

  let retractLen = num('retraction_length'), retractSpeed = num('retraction_speed'), deretractSpeed = num('deretraction_speed') || retractSpeed;
  let zHop = num('z_hop');
  const minTravel = num('retraction_minimum_travel');
  let objFlow = 1; // per-object flow multiplier (flow calibration)
  const travelSpeed = num('travel_speed');
  const reduceInfillRetract = bool('reduce_infill_retraction');
  const fanOffLayers = num('close_fan_the_first_x_layers');
  const labels = bool('label_objects') && flavor !== 'bbl';
  const labelName = (o: number) => `obj${o}_${meshes[o].name.replace(/[^A-Za-z0-9_]/g, '_')}`;
  const seamTris = meshes.map((m) => paintedTris(m as IndexedMesh, m.paint?.seam));
  const actionsByLayer = new Map<number, typeof opts.layerActions>();
  for (const a of opts.layerActions ?? []) {
    if (a.type === 'color') continue;
    if (a.type === 'config' && a.key) { (a as any)._v = Number(a.value); }
    const li = zs.findIndex((zz) => zz >= a.z - 1e-6);
    if (li < 0) continue;
    actionsByLayer.set(li, [...(actionsByLayer.get(li) ?? []), a]);
  }

  const layerOps: LayerOps[] = [];
  let px = 0, py = 0;
  let retracted = false;
  let prevSeams: [number, number][] = [];
  let curZ = 0;
  let curTool = -1;

  for (let i = 0; i < N; i++) {
    const h = hs[i], zTop = zs[i];
    const ops: Op[] = [];
    const seams: [number, number][] = [];
    let lastFeature: FeatureType | null = null;
    let accelSet = -1;

    const layerFan = i < fanOffLayers ? 0 : num('fan_max_speed');
    const travel = (x: number, y: number, feat: FeatureType, zz = zTop) => {
      if (isNaN(px)) {
        // position unknown after a filament change macro
        ops.push({ k: 'move', x, y, z: zz, e: 0, f: travelSpeed, feature: 'travel', w: 0, h, travel: true });
        px = x; py = y; curZ = zz;
        return;
      }
      const d = Math.hypot(x - px, y - py);
      if (d < 1e-4 && Math.abs(zz - curZ) < 1e-6) return;
      const skipRetract = reduceInfillRetract && feat === 'sparse_infill' && lastFeature === 'sparse_infill';
      const needRetract = retractLen > 0 && d > minTravel && !skipRetract;
      if (needRetract && !retracted) { ops.push({ k: 'retract', len: retractLen, speed: retractSpeed }); retracted = true; }
      const hop = needRetract && zHop > 0;
      const ta = num('travel_acceleration');
      if (ta && ta !== accelSet) { ops.push({ k: 'accel', a: ta }); accelSet = ta; }
      if (hop) ops.push({ k: 'move', x: px, y: py, z: curZ + zHop, e: 0, f: num('max_speed_z') || 10, feature: 'travel', w: 0, h, travel: true, fixed: true });
      ops.push({ k: 'move', x, y, z: hop ? curZ + zHop : zz, e: 0, f: i === 0 ? Math.min(travelSpeed, 250) : travelSpeed, feature: 'travel', w: 0, h, travel: true });
      if (hop) ops.push({ k: 'move', x, y, z: zz, e: 0, f: num('max_speed_z') || 10, feature: 'travel', w: 0, h, travel: true, fixed: true });
      curZ = zz; px = x; py = y;
    };

    const extrudePath = (it: PathItem) => {
      let pts = it.pts;
      if (pts.length < 4) return;
      const fl = filaments[Math.max(0, curTool)];
      const filArea = Math.PI * (fl.diameter / 2) ** 2;
      const startZ = it.spiral ? zTop - h : zTop;
      travel(pts[0], pts[1], it.feature, startZ);
      if (retracted) { ops.push({ k: 'retract', len: -retractLen, speed: deretractSpeed }); retracted = false; }
      const a = accelFor(it.feature, i);
      if (a !== accelSet) { ops.push({ k: 'accel', a }); accelSet = a; }
      const hEff = it.feature === 'bridge' ? Math.min(it.width, nozzle) : h;
      const xs = it.feature === 'bridge'
        ? Math.PI * (nozzle / 2) ** 2
        : it.width > hEff ? (it.width - hEff) * hEff + Math.PI * (hEff / 2) ** 2 : it.width * hEff;
      const ePerMm = (xs / filArea) * (fl.flowRatio || 1) * it.flow * objFlow;
      const varW = it.widths && it.widths.length * 2 === pts.length ? (it.closed ? [...it.widths, it.widths[0]] : it.widths) : null;
      const zoff = it.zs && it.zs.length * 2 === pts.length ? (it.closed ? [...it.zs, it.zs[0]] : it.zs) : null;
      const xsOf = (w: number) => (w > h ? (w - h) * h + Math.PI * (h / 2) ** 2 : w * h);
      let v = speedFor(it.feature, i);
      const maxVol = 'filament_max_volumetric_speed' in live ? live.filament_max_volumetric_speed : fl.maxVolumetricSpeed;
      v = Math.min(v, (maxVol || 1e9) / Math.max(xs, 1e-6));
      if (it.closed) pts = [...pts, pts[0], pts[1]];
      let totalLen = 0;
      if (it.spiral) for (let k = 2; k < pts.length; k += 2) totalLen += Math.hypot(pts[k] - pts[k - 2], pts[k + 1] - pts[k - 1]);
      let run = 0;
      for (let k = 2; k < pts.length; k += 2) {
        const x = pts[k], y = pts[k + 1];
        const len = Math.hypot(x - px, y - py);
        if (len < 1e-5) continue;
        run += len;
        const zz = (it.spiral ? startZ + (h * run) / Math.max(totalLen, 1e-6) : zTop) + (zoff ? zoff[k / 2] : 0);
        // volumetric conservation: E follows the true 3-D segment length (spiral and curved-layer paths change Z)
        const len3 = Math.hypot(len, zz - curZ);
        if (varW) {
          const sw = (varW[k / 2 - 1] + varW[k / 2]) / 2, sxs = xsOf(sw);
          const sv = Math.min(v * Math.min(1, it.width / sw), (maxVol || 1e9) / Math.max(sxs, 1e-6));
          ops.push({ k: 'move', x, y, z: zz, e: len3 * (sxs / filArea) * (fl.flowRatio || 1) * it.flow * objFlow, f: sv, feature: it.feature, w: sw, h: hEff, travel: false });
        } else
        ops.push({ k: 'move', x, y, z: zz, e: len3 * ePerMm, f: v, feature: it.feature, w: it.width, h: hEff, travel: false });
        px = x; py = y; curZ = zz;
      }
      lastFeature = it.feature;
    };

    // --- prime tower
    let towerOutlineDone = false;
    let bandsDone = 0;
    const towerOutline = () => {
      if (towerOutlineDone) return;
      towerOutlineDone = true;
      const w = i === 0 ? lw('initial_layer_line_width') : lw('support_line_width');
      const loops: PathItem[] = [];
      if (i === 0) for (let k = 3; k >= 1; k--) for (const p of offset([rectPath(tx, ty, tx + tw, ty + td)], k * w)) loops.push({ pts: pathToPoly(p), closed: true, feature: 'brim', width: w, flow: 1 });
      for (const p of offset([rectPath(tx, ty, tx + tw, ty + td)], -w / 2)) loops.push({ pts: pathToPoly(p), closed: true, feature: 'prime_tower', width: w, flow: 1 });
      for (const it of orderPaths(loops, px, py).paths) extrudePath(it);
    };
    const towerBand = (k: number, solid: boolean) => {
      const w = i === 0 ? lw('initial_layer_line_width') : lw('support_line_width');
      const y0 = ty + k * bandDepth, y1 = Math.min(ty + td, y0 + bandDepth);
      const reg = offset([rectPath(tx, y0, tx + tw, y1)], -w);
      const lines = linesFill(reg, solid ? spacingOf(w, h) : 4, solid ? (i % 2 ? 45 : -45) : 90);
      for (const it of orderPaths(lines.map((l) => ({ ...l, feature: 'prime_tower' as FeatureType, width: w, flow: 1 })), px, py).paths) extrudePath(it);
    };
    const towerActive = useTower && i <= lastChangeLayer;

    // --- filament change
    const changeTo = (next: number) => {
      if (next === curTool) return;
      if (curTool === -1 && (!hasAms || usesVendorTemplates(cfg) || ((usedFils.size <= 1 || toolChanger) && next === 0))) { ops.push({ k: 'tool', tool: next }); curTool = next; return; }
      const fl = filaments[next];
      const prev = curTool < 0 ? 0 : curTool;
      let flushVol = toolChanger ? num('tool_prime_volume') : opts.flushMatrix?.[prev]?.[next] ?? num('flush_volume') ?? 0;
      let plan: TransitionPlan | undefined;
      for (const x of transitionPlugins) plan = x.transition!({ layer: i, from: prev, to: next, flushVolume: flushVol }) ?? plan;
      if (plan?.flushVolume !== undefined) flushVol = toolChanger ? Math.min(flushVol, plan.flushVolume) : plan.flushVolume;
      if (plan) ops.push({ k: 'raw', text: `${TRANSITION_MARKER} ${prev}->${next} mode=${plan.skipTower ? 'none' : plan.flushVolume !== undefined ? 'reduced' : 'full'} shift=${(plan.shiftMm ?? 0).toFixed(3)}${plan.regionId ? ` region=${plan.regionId}` : ''}` });
      if (plan?.label && !hasAms) ops.push({ k: 'raw', text: `M117 Load ${plan.label.replace(/[;\n]/g, ' ')}` });
      const flushLen = towerFlush && towerActive ? 0 : (flushVol || 0) / (Math.PI * (fl.diameter / 2) ** 2); // no chute: the tower band takes it
      if (!retracted && curTool >= 0) { ops.push({ k: 'retract', len: retractLen, speed: retractSpeed }); }
      ops.push({
        k: 'raw', resetPos: true, time: num('filament_change_time'),
        text: usesVendorTemplates(cfg)
          ? renderVendor(str('change_filament_gcode'), cfg, filaments, {
            previous_extruder: prev, next_extruder: next, layer_num: i, layer_z: zTop, max_layer_z: zTop, current_extruder: prev,
            new_filament_temp: Math.round(i === 0 ? fl.nozzleTempInitial : fl.nozzleTemp), old_filament_temp: Math.round(filaments[prev].nozzleTemp),
            ...flushSplit(towerFlush && towerActive ? 0 : flushVol || 0, Math.PI * (fl.diameter / 2) ** 2),
            old_retract_length_toolchange: num('retract_length_toolchange'), new_retract_length_toolchange: num('retract_length_toolchange'),
            x_after_toolchange: isNaN(px) ? 0 : px, y_after_toolchange: isNaN(py) ? 0 : py, z_after_toolchange: zTop,
            travel_point_1_x: isNaN(px) ? 0 : px, travel_point_1_y: isNaN(py) ? 0 : py, travel_point_2_x: isNaN(px) ? 0 : px, travel_point_2_y: isNaN(py) ? 0 : py,
            travel_point_3_x: isNaN(px) ? 0 : px, travel_point_3_y: isNaN(py) ? 0 : py, position: [isNaN(px) ? 0 : px, isNaN(py) ? 0 : py, zTop],
            wipe_tower_x: tx + tw / 2, wipe_tower_y: ty + td / 2, toolchange_z: zTop + 3,
          }, 'Filament change G-code')
          : expandMacro(str('change_filament_gcode'), cfg, {
            previous_extruder: prev, next_extruder: next, toolchange_z: (zTop + 3).toFixed(2), layer_z: zTop.toFixed(2), layer_num: i,
            new_filament_temp: i === 0 ? fl.nozzleTempInitial : fl.nozzleTemp, old_filament_temp: filaments[prev].nozzleTemp,
            flush_length: flushLen.toFixed(2), wipe_tower_x: (tx + tw / 2).toFixed(2), wipe_tower_y: (ty + td / 2).toFixed(2),
          }),
      });
      if (layerFan > 0) ops.push({ k: 'raw', text: `M106 S${Math.round((layerFan / 100) * 255)} ; restore part fan` });
      if (toolChanger && curTool >= 0 && cfg.ooze_prevention !== false && num('standby_temperature_delta') < 0)
        ops.push({ k: 'raw', text: `M104 T${prev} S${Math.max(0, Math.round(filaments[prev].nozzleTemp + num('standby_temperature_delta')))} ; park T${prev} at standby` });
      if (fl.pressureAdvance !== undefined) ops.push({ k: 'raw', text: paLine(flavor, fl.pressureAdvance) });
      ops.push({ k: 'tool', tool: next });
      retracted = hasAms; // the AMS sequence ends with a retraction; M600 leaves the nozzle primed
      px = NaN; py = NaN;
      const wasFirst = curTool === -1;
      curTool = next;
      if (towerActive && (!wasFirst || towerFlush) && !plan?.skipTower) { towerOutline(); towerBand(bandsDone++, true); }
    };

    // --- layer actions (pause / custom G-code / setting change)
    for (const a of actionsByLayer.get(i) ?? []) {
      if (a.type === 'config' && a.key) {
        live[a.key] = Number(a.value);
        retractLen = num('retraction_length'); retractSpeed = num('retraction_speed'); deretractSpeed = num('deretraction_speed') || retractSpeed; zHop = num('z_hop');
        if (a.gcode) ops.push({ k: 'raw', text: a.gcode });
        continue;
      }
      if (a.type === 'pause') ops.push({ k: 'raw', text: `; PAUSE at layer ${i + 1}\n${str('machine_pause_gcode') || 'M601'}`, resetPos: true });
      else if (a.type === 'custom' && a.gcode) ops.push({ k: 'raw', text: `; custom G-code at layer ${i + 1}\n${a.gcode}` });
    }

    // order filaments: current first
    const order = orderLayerTools(layerFils[i], curTool, i, opts.filamentSequence);
    if (!order.length && curTool === -1) changeTo(supportFil >= 0 ? supportFil : 0);

    // --- first-layer adhesion (printed with the first filament of the layer)
    if (order.length) changeTo(order[0]);
    if (i === 0) {
      for (const it of orderPaths(skirtLoops, px, py).paths) extrudePath(it);
      for (const it of orderPaths(brimLoops, px, py).paths) extrudePath(it);
    } else if (i < Math.round(num('skirt_height'))) {
      for (const it of orderPaths(skirtLoops.map((s) => ({ ...s })), px, py).paths) extrudePath(it);
    }

    const islands = layerIslands[i];
    const lowerSupport = i > 0 ? offset(layerSlices[i - 1], wo0 / 2) : null;
    for (const fil of order) {
      changeTo(fil);
      for (let o = 0; o < meshes.length; o++) {
        const objIslands = islands.filter((s) => s.obj === o && s.fil === fil);
        if (!objIslands.length) continue;
        objFlow = onum(o, 'flow_ratio_scale') || 1;
        curObj = o;
        const rg = regions[i][o];
        const sw = lw('internal_solid_infill_line_width'), twid = lw('top_surface_line_width'), spw = lw('sparse_infill_line_width');
        const w0 = lw('initial_layer_line_width');
        const fInner = filInner[i][o].get(fil) ?? [];
        const overlap = onum(o, 'infill_wall_overlap') / 100;
        const clipTo = (r: Paths, w: number) => (r.length && fInner.length ? intersection(r, offset(fInner, -(w / 2) + overlap * w)) : []);
        const fills: PathItem[] = [];
        const add = (polys: Polyline2[], feature: FeatureType, width: number, flow = 1) => {
          for (const p of polys) fills.push({ ...p, pts: simplify(p.pts, resolution, p.closed), feature, width, flow });
        };
        const solidAngle = solidDir + (i % 2 ? 90 : 0);
        const surface = (r: Paths, pattern: string, w: number, feature: FeatureType) => {
          const reg = clipTo(r, w);
          if (!reg.length) return;
          const s = spacingOf(w, h);
          if (pattern === 'concentric') add(concentricFill(reg, s, 0), feature, w);
          else add(linesFill(reg, s, pattern === 'aligned_rectilinear' ? solidDir : solidAngle, pattern === 'monotonic'), feature, w);
        };
        surface(rg.bottom, ostr(o, 'bottom_surface_pattern'), i === 0 ? w0 : sw, 'bottom_surface');
        if (rg.bridge.length) {
          for (const ex of toExPolygons(clipTo(rg.bridge, nozzle))) {
            const b = bounds([ex.contour]);
            const ang = (b.maxX - b.minX) > (b.maxY - b.minY) ? 90 : 0;
            add(linesFill(exToPaths(ex), nozzle, ang), 'bridge', nozzle, num('bridge_flow') || 1);
          }
        }
        if (rg.solid.length) {
          const ww = i === 0 ? w0 : sw;
          add(linesFill(clipTo(rg.solid, ww), spacingOf(ww, h), solidAngle), 'internal_solid_infill', ww);
        }
        const dens = vase ? 0 : onum(o, 'sparse_infill_density') / 100;
        if (rg.sparse.length && dens > 0) {
          const reg = clipTo(rg.sparse, spw);
          const custom = adv?.infill && reg.length ? adv.infill(o, reg, { width: spw, density: dens, z: zTop, h, layer: i, pattern: ostr(o, 'sparse_infill_pattern') }) : undefined;
          if (custom) for (const p of custom.paths) fills.push({ ...p, pts: p.widths ? p.pts : simplify(p.pts, resolution, p.closed), feature: p.feature ?? 'sparse_infill', width: p.width, flow: p.flow ?? 1 });
          // what the Advanced zone router left (or everything in Basic mode) gets the regular pattern
          const rest = custom ? custom.rest : reg;
          if (rest.length) add(sparseFill(rest, ostr(o, 'sparse_infill_pattern') as SparsePattern, spw, dens, i, zTop, onum(o, 'infill_direction')), 'sparse_infill', spw);
        }
        for (const m of rg.sparseMods) add(sparseFill(clipTo(m.paths, spw), m.pattern, spw, m.density, i, zTop, onum(o, 'infill_direction')), 'sparse_infill', spw);
        if (rg.top.length) surface(rg.top, ostr(o, 'top_surface_pattern'), twid, 'top_surface');
        const ironing = ostr(o, 'ironing_type');
        if (rg.top.length && (ironing === 'top' || (ironing === 'topmost' && i === N - 1))) {
          const reg = intersection(offset(rg.top, -twid / 2), fInner);
          for (const p of linesFill(reg, num('ironing_spacing'), solidAngle + 90)) {
            fills.push({ ...p, feature: 'ironing', width: num('ironing_spacing'), flow: (num('ironing_flow') / 100) * (h / num('ironing_spacing')) });
          }
        }

        // assign fills to islands by first point
        const byIsland = new Map<Island, PathItem[]>();
        for (const it of fills) {
          let owner = objIslands[0];
          if (objIslands.length > 1) owner = objIslands.find((s) => pointInPaths(it.pts[0], it.pts[1], exToPaths(s.ex))) ?? objIslands[0];
          const l = byIsland.get(owner); if (l) l.push(it); else byIsland.set(owner, [it]);
        }

        if (labels) ops.push({ k: 'raw', text: flavor === 'klipper' ? `EXCLUDE_OBJECT_START NAME=${labelName(o)}` : `M486 S${o}` });
        const hints: SeamHints | undefined = seamTris[o].length
          ? { enforce: pointsAtZ(meshes[o] as IndexedMesh, seamTris[o], 1, planes[i]), block: pointsAtZ(meshes[o] as IndexedMesh, seamTris[o], 2, planes[i]) }
          : undefined;
        const seamMode = ostr(o, 'seam_position') as SeamMode;
        const fuzzy = ostr(o, 'fuzzy_skin');
        const left = objIslands.slice();
        while (left.length) {
          let bi = 0, bd = Infinity;
          left.forEach((s, k) => {
            const c = s.ex.contour[0];
            const d = (c.X / SCALE - (isNaN(px) ? 0 : px)) ** 2 + (c.Y / SCALE - (isNaN(py) ? 0 : py)) ** 2;
            if (d < bd) { bd = d; bi = k; }
          });
          const isl = left.splice(bi, 1)[0];
          const depthOrder = isl.loops.map((_, k) => k);
          let seq: number[];
          if (wallSeq === 'outer_inner') seq = depthOrder;
          else if (wallSeq === 'inner_outer_inner' && depthOrder.length >= 3) seq = [...depthOrder.slice(2).reverse(), 0, 1];
          else seq = depthOrder.slice().reverse();
          const wallItems: PathItem[] = [];
          for (const k of seq) {
            const ordered = orderPaths(isl.loops[k].map((l) => ({ ...l })), isNaN(px) ? 0 : px, isNaN(py) ? 0 : py).paths;
            for (const loop of ordered) {
              // loops with per-point data (Z offsets, widths) keep every point so the arrays stay aligned
              const perPoint = !!(loop.zs || loop.widths);
              let pts = perPoint ? loop.pts : simplify(loop.pts, resolution, true);
              const prev = seamMode === 'aligned' && prevSeams.length
                ? prevSeams.reduce((b, s) => ((s[0] - pts[0]) ** 2 + (s[1] - pts[1]) ** 2 < (b[0] - pts[0]) ** 2 + (b[1] - pts[1]) ** 2 ? s : b))
                : null;
              const si = pickSeam(pts, seamMode, isNaN(px) ? 0 : px, isNaN(py) ? 0 : py, prev, rnd, hints);
              pts = rotateLoop(pts, si);
              const zs = loop.zs && loop.zs.length * 2 === loop.pts.length ? [...loop.zs.slice(si), ...loop.zs.slice(0, si)] : undefined;
              const widths = loop.widths && loop.widths.length * 2 === loop.pts.length ? [...loop.widths.slice(si), ...loop.widths.slice(0, si)] : undefined;
              if (k === 0) seams.push([pts[0], pts[1]]);
              if (!perPoint && fuzzy !== 'none' && i > 0 && (fuzzy === 'all' || k === 0)) pts = fuzz(pts, onum(o, 'fuzzy_skin_thickness'), num('fuzzy_skin_point_distance'), rnd);
              const item: PathItem = { ...loop, pts, zs, widths, spiral: vase && i >= Math.round(num('bottom_shell_layers')) };
              pushAll(wallItems, (i > 0 && !vase && !perPoint ? splitOverhang(item, lowerSupport) : [item]));
            }
          }
          if (isl.thin.length) pushAll(wallItems, orderPaths(isl.thin.map((t) => ({ ...t, pts: t.pts.slice(), widths: t.widths!.slice() })), isNaN(px) ? 0 : px, isNaN(py) ? 0 : py).paths);
          const isFill = byIsland.get(isl) ?? [];
          const fillOrdered = () => {
            const groups: FeatureType[] = ['bottom_surface', 'bridge', 'internal_solid_infill', 'sparse_infill', 'top_surface', 'ironing'];
            const outp: PathItem[] = [];
            for (const g of groups) pushAll(outp, orderPaths(isFill.filter((f) => f.feature === g), isNaN(px) ? 0 : px, isNaN(py) ? 0 : py).paths);
            return outp;
          };
          if (bool('is_infill_first')) { for (const it of fillOrdered()) extrudePath(it); for (const it of wallItems) extrudePath(it); }
          else { for (const it of wallItems) extrudePath(it); for (const it of fillOrdered()) extrudePath(it); }
        }
        if (labels) ops.push({ k: 'raw', text: flavor === 'klipper' ? `EXCLUDE_OBJECT_END NAME=${labelName(o)}` : 'M486 S-1' });
      }
    }
    objFlow = 1;
    curObj = -1;

    // --- support
    if (support && (support.base[i].length || support.iface[i].length)) {
      if (supportFil >= 0) changeTo(supportFil);
      const sw = i === 0 ? lw('initial_layer_line_width') : lw('support_line_width');
      const items: PathItem[] = [];
      if (support.base[i].length) {
        for (const p of offset(support.base[i], -sw / 2)) items.push({ pts: pathToPoly(p), closed: true, feature: 'support', width: sw, flow: 1 });
        for (const p of linesFill(offset(support.base[i], -sw), num('support_base_pattern_spacing') + sw, num('support_angle') + (i === 0 ? 90 : 0))) items.push({ ...p, feature: 'support', width: sw, flow: 1 });
      }
      if (support.iface[i].length) {
        for (const p of linesFill(support.iface[i], num('support_interface_spacing') + sw, num('support_angle') + 90)) items.push({ ...p, feature: 'support_interface', width: sw, flow: 1 });
      }
      for (const it of orderPaths(items, isNaN(px) ? 0 : px, isNaN(py) ? 0 : py).paths) extrudePath(it);
    }

    // --- tower remainder: keep it growing every layer until the last filament change
    if (towerActive) {
      towerOutline();
      for (let k = bandsDone; k < maxChanges; k++) towerBand(k, i === 0);
    }

    if (seams.length) prevSeams = seams;
    const L: LayerOps = { z: zTop, h, ops, fan: layerFan };
    if (i === 1) {
      const fl = filaments[Math.max(0, curTool)];
      if (fl.nozzleTemp !== fl.nozzleTempInitial) L.temp = fl.nozzleTemp;
      if (num('bed_temperature') !== num('bed_temperature_initial_layer')) L.bedTemp = num('bed_temperature');
    }
    layerOps.push(L);
    if (i % 5 === 0) progress('Generating infill & toolpaths', 0.58 + 0.32 * (i / N));
  }

  // ---------- stage 10: emit
  progress('Writing G-code', 0.92);
  const objectLabels = meshes.map((m, o) => {
    const b = bounds(objSlices[o].flat());
    const x0 = b.minX / SCALE, y0 = b.minY / SCALE, x1 = b.maxX / SCALE, y1 = b.maxY / SCALE;
    return { name: labelName(o), cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, polygon: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] as [number, number][] };
  }).filter((l) => isFinite(l.cx));
  // ---------- Advanced: geometry passes (curved layers, helices, seams, weaving…) before the plugins
  const stageCtx = { cfg, layerZ: zs, layerH: hs, warn: (msg: string) => { if (!warnings.includes(msg)) warnings.push(msg); } };
  if (adv) { progress('Advanced toolpath passes', 0.88); adv.post(layerOps, stageCtx); }
  // ---------- plugins: post-toolpath, pre-G-code
  let pluginRun: ReturnType<typeof runPlugins> = { header: [], reports: {} };
  if (opts.plugins && Object.keys(opts.plugins).length) {
    progress('Running plugins', 0.9);
    const faceRegions: FaceRegion[] = [];
    meshes.forEach((m, o) => (m.faceSets ?? []).forEach((fs) => {
      if (!fs.tris.length) return;
      const tris: PaintedTri[] = [];
      const v = m.vertices, ix = m.indices;
      for (const t of fs.tris) {
        const za = v[ix[t * 3] * 3 + 2], zb = v[ix[t * 3 + 1] * 3 + 2], zc = v[ix[t * 3 + 2] * 3 + 2];
        tris.push({ t, zmin: Math.min(za, zb, zc), zmax: Math.max(za, zb, zc), value: 1 });
      }
      // The strip reaches in far enough to cover every wall line under the picked surface.
      const depth = Math.max(1, onum(o, 'wall_loops')) * lw('inner_wall_line_width') + lw('outer_wall_line_width');
      const cache = new Map<number, [number, number][][]>();
      faceRegions.push({
        id: `${m.id}:${fs.id}`, name: fs.name,
        polygonsAt(li) {
          const hit = cache.get(li);
          if (hit) return hit;
          const sl = objSlices[o][li];
          const map = sl?.length ? colorRegionsAtZ(m as IndexedMesh, tris, sl, planes[li], depth) : new Map();
          const r = (map.get(1) ?? []).map((p: Paths[number]) => p.map((q) => [q.X / SCALE, q.Y / SCALE] as [number, number]));
          cache.set(li, r);
          return r;
        },
      });
    }));
    pluginRun = runPlugins(layerOps, opts.plugins, { cfg, layerZ: zs, faceRegions, warn: (msg) => { if (!warnings.includes(msg)) warnings.push(msg); } }, sessions);
  }
  // ---------- Advanced: rheology & motion passes on the final move list
  if (adv) { progress('Advanced rheology & motion', 0.91); adv.finalize(layerOps, stageCtx); }
  const advHeader = adv ? [`; NexSpiro Advanced engine: intent=${opts.advanced!.intent} machine=${adv.ctx.caps.name}`] : [];
  const res = emit({ cfg, filaments, layers: layerOps, objectLabels: labels ? objectLabels : [], headerLines: [...pluginRun.header, ...advHeader] });

  const bx = num('bed_x'), by = num('bed_y');
  const all = bounds(layerSlices.flat());
  if (all.minX / SCALE < -0.01 || all.minY / SCALE < -0.01 || all.maxX / SCALE > bx + 0.01 || all.maxY / SCALE > by + 0.01) {
    warnings.push('Some geometry lies outside the printable area.');
  }
  if (realMaxZ > num('bed_z')) warnings.push(`Model height ${realMaxZ.toFixed(1)} mm exceeds the printer's maximum height (${num('bed_z')} mm).`);
  if (usedFils.size > 1 && !hasAms) warnings.push(`This print uses ${usedFils.size} filaments; the printer will pause for each manual filament change (${res.stats.toolChanges}).`);
  if (changer === 'ams' && slotCount(cfg) > 0 && Math.max(...usedFils) + 1 > slotCount(cfg)) warnings.push(`This print uses filament slot ${Math.max(...usedFils) + 1} but the filament unit has ${slotCount(cfg)} slots. Move the filaments to slots 1–${slotCount(cfg)}, or swap spools by hand when the printer asks.`);
  progress('Done', 1);
  const advanced = adv?.report();
  if (advanced) for (const w of advanced.warnings) if (!warnings.includes(w)) warnings.push(w);
  return { ...res, warnings, pluginReports: pluginRun.reports, ...(advanced ? { advanced } : {}) };
}
