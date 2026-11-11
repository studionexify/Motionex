// Walls straight from the 3D model, for the Select window's live preview: each layer's cross-section of the
// meshes, offset inwards into the outer wall and the inner walls, with the current layer height, first layer
// height, wall count and line widths; optionally (fill) the inside too: top and bottom skins from the shell
// layer counts and sparse infill at the infill density, as straight lines (the real slice's pattern may differ).
// The result has the slice's own shape (SliceOutput), so the window shows, picks and drafts motions on it as on
// a real slice, and a change of layer height or wall count shows in a moment.
import { clipLines, difference, intersection, offset, SCALE, union } from '../../../engine/clipper';
const unionAll = (p: Paths) => (p.length ? union(p) : []);
import type { Paths } from '../../../engine/types';
import { sliceMesh } from '../../../engine/slice';
import { FEATURE_ORDER, type FeatureType, type MeshInput, type SliceOutput } from '../../../engine/types';
import type { Config } from '../../../profiles/settings';

const num = (cfg: Config, k: string, d: number) => { const v = parseFloat(String(cfg[k] ?? '')); return Number.isFinite(v) && v > 0 ? v : d; };

export interface ModelWallSettings { layerH: number; firstH: number; walls: number; outerW: number; innerW: number; fill?: boolean; top?: number; bottom?: number; density?: number; fillW?: number }

export function wallSettings(cfg: Config): ModelWallSettings {
  const lw = num(cfg, 'line_width', 0.42);
  return {
    layerH: num(cfg, 'layer_height', 0.2), firstH: num(cfg, 'initial_layer_print_height', num(cfg, 'layer_height', 0.2)),
    walls: Math.max(1, Math.round(num(cfg, 'wall_loops', 2))), outerW: num(cfg, 'outer_wall_line_width', lw), innerW: num(cfg, 'inner_wall_line_width', lw),
    top: Math.round(Number(cfg.top_shell_layers ?? 5)) || 0, bottom: Math.round(Number(cfg.bottom_shell_layers ?? 3)) || 0,
    density: Number.isFinite(parseFloat(String(cfg.sparse_infill_density))) ? parseFloat(String(cfg.sparse_infill_density)) : 15,
    fillW: num(cfg, 'sparse_infill_line_width', lw),
  };
}

export function wallsFromModel(meshes: MeshInput[], s: ModelWallSettings, maxLayers = 4000): SliceOutput | null {
  let top = 0;
  for (const m of meshes) for (let k = 2; k < m.vertices.length; k += 3) top = Math.max(top, m.vertices[k]);
  if (top <= 0) return null;
  const tops: number[] = [];
  for (let z = s.firstH; z <= top + 1e-6 && tops.length < maxLayers; z += s.layerH) tops.push(+z.toFixed(5));
  const planes = tops.map((z, i) => z - (i ? s.layerH : s.firstH) / 2);
  const sections = meshes.map((m) => sliceMesh(m, planes));
  const moves: number[] = [], feats: number[] = [];
  const OUT = FEATURE_ORDER.indexOf('outer_wall'), IN = FEATURE_ORDER.indexOf('inner_wall'), TR = FEATURE_ORDER.indexOf('travel' as FeatureType);
  const push = (x: number, y: number, z: number, w: number, h: number, f: number) => { moves.push(x, y, z, w, h, 40, 0, 0); feats.push(f); };
  push(0, 0, 0, 0, 0, TR);
  const layers: SliceOutput['layers'] = [];
  const F = (n: string) => FEATURE_ORDER.indexOf(n as FeatureType);
  const TOP = F('top_surface'), BOT = F('bottom_surface'), SOLID = F('internal_solid_infill'), SPARSE = F('sparse_infill');
  const depth = s.outerW + (s.walls - 1) * s.innerW;
  const lines = (region: Paths, spacing: number, deg: number, w: number, h: number, z: number, f: number) => {
    if (!region.length || spacing <= 0) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of region) for (const q of p) { x0 = Math.min(x0, q.X); y0 = Math.min(y0, q.Y); x1 = Math.max(x1, q.X); y1 = Math.max(y1, q.Y); }
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, R = Math.hypot(x1 - x0, y1 - y0) / 2 + 1, a = (deg * Math.PI) / 180;
    const ux = Math.cos(a), uy = Math.sin(a), st = spacing * SCALE;
    const raw: Paths = [];
    // lines on a fixed grid (not centred on the part), so they line up from layer to layer
    const off = ((cx * -uy + cy * ux) % st + st) % st;
    for (let d = -R - off; d <= R; d += st) raw.push([{ X: Math.round(cx - uy * d - ux * R), Y: Math.round(cy + ux * d - uy * R) }, { X: Math.round(cx - uy * d + ux * R), Y: Math.round(cy + ux * d + uy * R) }]);
    const cut = clipLines(raw, region);
    cut.forEach((ln, i) => {
      const pts = i % 2 ? [...ln].reverse() : ln;
      if (pts.length < 2) return;
      push(pts[0].X / SCALE, pts[0].Y / SCALE, z, 0, h, TR);
      for (let j = 1; j < pts.length; j++) push(pts[j].X / SCALE, pts[j].Y / SCALE, z, w, h, f);
    });
  };
  const fillLayer = (sec: Paths[], li: number, z: number, h: number) => {
    const core = offset(sec[li], -depth);
    if (!core.length) return;
    const n = tops.length, lw = s.innerW;
    // exposed above / below this very layer: the top or bottom surface
    const above = li + 1 < n ? sec[li + 1] ?? [] : [];
    const below = li > 0 ? sec[li - 1] ?? [] : [];
    const topSurf = difference(core, above), botSurf = difference(core, below);
    // the rest of the skins: not covered by every one of the next shell layers up (or down)
    let coverUp: Paths = core, coverDown: Paths = core;
    for (let k = 1; k <= (s.top ?? 0); k++) coverUp = li + k < n ? intersection(coverUp, sec[li + k] ?? []) : [];
    for (let k = 1; k <= (s.bottom ?? 0); k++) coverDown = li - k >= 0 ? intersection(coverDown, sec[li - k] ?? []) : [];
    const solid = [...difference(core, coverUp), ...difference(core, coverDown)];
    const deg = li % 2 ? 45 : -45;
    lines(botSurf, lw, deg, lw, h, z, BOT);
    lines(difference(topSurf, botSurf), lw, deg, lw, h, z, TOP);
    const inner = difference(difference(solid.length ? unionAll(solid) : [], topSurf), botSurf);
    lines(inner, lw, deg, lw, h, z, SOLID);
    const d = Math.max(0, Math.min(100, s.density ?? 15));
    if (d > 0) lines(difference(core, unionAll([...solid, ...topSurf, ...botSurf])), (s.fillW ?? lw) / (d / 100), li % 2 ? 45 : 135, s.fillW ?? lw, h, z, SPARSE);
  };
  tops.forEach((z, li) => {
    const h = li ? s.layerH : s.firstH, start = feats.length;
    for (const sec of sections) {
      const sl = sec[li];
      if (!sl?.length) continue;
      for (let k = 0; k < s.walls; k++) {
        const w = k ? s.innerW : s.outerW;
        const d = k ? s.outerW + (k - 0.5) * s.innerW : s.outerW / 2;
        const loops: Paths = offset(sl, -d);
        for (const loop of loops) {
          if (loop.length < 3) continue;
          push(loop[0].X / SCALE, loop[0].Y / SCALE, z, 0, h, TR);
          for (let j = 1; j <= loop.length; j++) { const q = loop[j % loop.length]; push(q.X / SCALE, q.Y / SCALE, z, w, h, k ? IN : OUT); }
        }
      }
      if (s.fill) fillLayer(sec, li, z, h);
    }
    layers.push({ index: li, z, height: h, moveStart: start, moveEnd: feats.length, time: 0 });
  });
  return { moves: new Float32Array(moves), moveFeatures: new Uint8Array(feats), layers, stats: { timeSeconds: 0, toolChanges: 0, towerGrams: 0, flushGrams: 0 } } as unknown as SliceOutput;
}
