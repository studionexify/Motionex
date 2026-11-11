// Quick look at the woven picture on the model, without slicing: the part is cut once per picture row,
// each outline is pushed out to the woven line, and every bit of it is coloured by the filament that
// shows there from outside. Same geometry code as the slicer pass.
import { sliceMesh } from '../../../engine/slice';
import { SCALE } from '../../../engine/clipper';
import type { IndexedMesh } from '../../../engine/mesh';
import { cycleLayers, type WeaveSettings } from './model';
import { offsetAt, planLayers, signedArea, visibleAt, weaveLoop, type Pt, type WeaveLayer } from './core';
import type { Warp } from '../sculpt/preview';
import { ThreadBuilder, type DroolReport, type ThreadData } from '../../threads';
import { collectZones, type ZoneSource } from './zones';
import { WaveField } from './wave';

/** Most outlines drawn; tall pictures show every n-th row. */
const MAX_ROWS = 260;

/** An object to preview; `zones` are its wave zones (modifier parts in world space, height ranges). */
export interface WeavePreviewObject { id: string; mesh: IndexedMesh; zones?: ZoneSource }

/** real: filament colours · wave: the part grey, the wave texture in one accent colour by its strength. */
export type WeaveView = 'real' | 'wave';
const PLAIN: [number, number, number] = [0.79, 0.8, 0.83], ACCENT: [number, number, number] = [0.05, 0.65, 0.56];
/** Colour of a stretch in the "Wave area" view. */
export const waveTint = (t: number): [number, number, number] => {
  const k = t > 0 ? 0.35 + 0.65 * Math.min(1, t) : 0;
  return [PLAIN[0] + (ACCENT[0] - PLAIN[0]) * k, PLAIN[1] + (ACCENT[1] - PLAIN[1]) * k, PLAIN[2] + (ACCENT[2] - PLAIN[2]) * k];
};

/** The wave field of one object, on its layer planes (layer tops `zs`, height `lh`). */
function fieldFor(o: WeavePreviewObject, w: WeaveSettings, zs: number[], lh: number): WaveField {
  const planes = zs.map((z) => z - lh / 2);
  return new WaveField(w, o.zones ? collectZones([o.zones], planes) : [], { planes, cap: w.max_deviation_mm > 0 ? w.max_deviation_mm : undefined });
}

/**
 * Lines for the 3D view. `colours[i]` is the rgb (0..1) shown for palette index i (filament colours in
 * colour mode, greys in mono). Returns null when the band misses every object.
 */
export function buildWeavePreview(objs: WeavePreviewObject[], w: WeaveSettings, layerHeight: number, colours: [number, number, number][], view: WeaveView = 'real'): { positions: Float32Array; colors: Float32Array } | null {
  const pos: number[] = [], col: number[] = [];
  const ids = new Set(w.objects ?? []);
  const lh = Math.max(0.04, layerHeight);
  for (const o of objs) {
    if (ids.size && !ids.has(o.id)) continue;
    const v = o.mesh.vertices;
    let zMax = 0;
    for (let i = 2; i < v.length; i += 3) zMax = Math.max(zMax, v[i]);
    const zs: number[] = [];
    for (let z = lh; z <= zMax + 1e-6; z += lh) zs.push(+z.toFixed(4));
    if (!zs.length) continue;
    // outline length per layer for "follow the curve": only sampled every few layers, filled in between
    const cyc = cycleLayers(w);
    const every = Math.max(1, Math.ceil(zs.length / 400));
    const samplePlanes = zs.filter((_, i) => i % every === 0).map((z) => z - lh / 2);
    const sampled = sliceMesh(o.mesh, samplePlanes);
    const loopsAt = (paths: typeof sampled[number]): Pt[][] => {
      const loops = paths.map((p) => p.map((q) => ({ x: q.X / SCALE, y: q.Y / SCALE })));
      // the biggest outline and others that aren't inside it (holes of a tube are skipped)
      return loops.filter((l) => l.length > 2 && signedArea(l) > 0);
    };
    const per = new Array<number>(zs.length).fill(NaN);
    sampled.forEach((paths, k) => {
      const ls = loopsAt(paths);
      if (ls.length) per[k * every] = Math.max(...ls.map((l) => l.reduce((s, q, i) => s + Math.hypot(l[(i + 1) % l.length].x - q.x, l[(i + 1) % l.length].y - q.y), 0)));
    });
    const plan = planLayers(w, zs, per);
    const field = fieldFor(o, w, zs, lh);
    const waved = zs.some((_, i) => field.activeAt(i));
    // one outline per picture row (its first layer), thinned to MAX_ROWS; with a wave every layer counts
    // (neighbouring layers swing opposite ways), thinned by an odd step so the swap still shows
    const rowStarts: number[] = [];
    plan.forEach((P, i) => { if (waved ? P || field.activeAt(i) : P && P.k % cyc === 0) rowStarts.push(i); });
    let thin = Math.max(1, Math.ceil(rowStarts.length / MAX_ROWS));
    if (waved && thin % 2 === 0) thin++;
    const keep = rowStarts.filter((_, k) => k % thin === 0);
    if (!keep.length) continue;
    const cut = sliceMesh(o.mesh, keep.map((i) => zs[i] - lh / 2));
    keep.forEach((i, n) => {
      const P = plan[i];
      for (const loop of loopsAt(cut[n])) {
        const L = loop.reduce((s, q, k) => s + Math.hypot(loop[(k + 1) % loop.length].x - q.x, loop[(k + 1) % loop.length].y - q.y), 0);
        const step = Math.max(0.1, Math.min(L / (w.image.w * Math.max(1, w.tiles_around) * 3), field.shortestStitch / 8));
        // the line as seen from outside: the showing colour, at its proud position
        const lat = !P || w.picture?.kind === 'none' ? null : w.mode === 'colour' ? () => w.depth_mm : (u: number) => Math.max(0, offsetAt(w, P, u));
        const woven = weaveLoop(loop, lat, step, 0, w.seam.angle_deg, waved ? field.term(i, 0) : undefined);
        for (let k = 1; k < woven.length; k++) {
          const a = woven[k - 1], b = woven[k];
          const c = view === 'wave' ? waveTint(a.wave ?? 0)
            : !P ? colours[0] ?? [0.6, 0.6, 0.6]
              // no picture: the row shows the colour its layer prints
              : w.picture?.kind === 'none' ? colours[w.mode === 'colour' ? P.colour : 0] ?? [0.6, 0.6, 0.6]
                : colours[w.mode === 'colour' ? visibleAt(w, P, a.u) : Math.min(colours.length - 1, visibleAt(w, P, a.u))] ?? [0.6, 0.6, 0.6];
          pos.push(a.x, a.y, zs[i], b.x, b.y, zs[i]);
          col.push(...c, ...c);
        }
      }
    });
  }
  if (!pos.length) return null;
  return { positions: Float32Array.from(pos), colors: Float32Array.from(col) };
}

/** Most layers drawn as threads; taller bands show every n-th layer, as thicker beads. */
const MAX_THREAD_LAYERS = 450;

/**
 * The woven wall as real threads: every layer is its own loop at its true in or out position, at the real
 * line width and layer height, so the bulges read as they will print. Layers that reach too far from
 * the one below sag, and drip when they reach much further (see ../../threads.ts).
 * `colourOf` gives the filament colour (0..1) a layer prints in; null = the plain wall outside the band.
 */
export function buildWeaveThreads(objs: WeavePreviewObject[], w: WeaveSettings, layerHeight: number, lineWidth: number, colourOf: (P: WeaveLayer | null) => [number, number, number], warp: Warp | null = null, view: WeaveView = 'real'): { threads: ThreadData; report: DroolReport } | null {
  const ids = new Set(w.objects ?? []);
  const lh = Math.max(0.04, layerHeight);
  const tb = new ThreadBuilder(lineWidth, lh, warp);
  const cols = Math.max(1, w.image.w * Math.max(1, w.tiles_around));
  for (const o of objs) {
    if (ids.size && !ids.has(o.id)) continue;
    const v = o.mesh.vertices;
    let zMax = 0;
    for (let i = 2; i < v.length; i += 3) zMax = Math.max(zMax, v[i]);
    const zs: number[] = [];
    for (let z = lh; z <= zMax + 1e-6; z += lh) zs.push(+z.toFixed(4));
    if (!zs.length) continue;
    // outline length per layer for "follow the curve", sampled and filled in between
    const every = Math.max(1, Math.ceil(zs.length / 400));
    const sampled = sliceMesh(o.mesh, zs.filter((_, i) => i % every === 0).map((z) => z - lh / 2));
    const outer = (paths: (typeof sampled)[number]): Pt[][] => paths.map((p) => p.map((q) => ({ x: q.X / SCALE, y: q.Y / SCALE }))).filter((l) => l.length > 2 && signedArea(l) > 0);
    const perim = (l: Pt[]) => l.reduce((s, q, i) => s + Math.hypot(l[(i + 1) % l.length].x - q.x, l[(i + 1) % l.length].y - q.y), 0);
    const per = new Array<number>(zs.length).fill(NaN);
    sampled.forEach((paths, k) => { const ls = outer(paths); if (ls.length) per[k * every] = Math.max(...ls.map(perim)); });
    const plan = planLayers(w, zs, per);
    const field = fieldFor(o, w, zs, lh);
    const bandAt = plan.map((P, i) => (P || field.activeAt(i) ? i : -1)).filter((i) => i >= 0);
    if (!bandAt.length) continue;
    // two plain layers under the band show what the weave stands on
    const lo = Math.max(0, bandAt[0] - 2), hi = bandAt[bandAt.length - 1];
    let stride = Math.max(1, Math.ceil((hi - lo + 1) / MAX_THREAD_LAYERS));
    // a thinned wave keeps an odd step, so neighbouring drawn layers still swing opposite ways
    if (stride > 1 && stride % 2 === 0 && field.shortestStitch < Infinity) stride++;
    const pick: number[] = [];
    for (let i = lo; i <= hi; i += stride) pick.push(i);
    const cut = sliceMesh(o.mesh, pick.map((i) => zs[i] - lh / 2));
    tb.newStack();
    pick.forEach((i, n) => {
      const P = plan[i] ?? null;
      tb.layer(stride);
      const rgb = colourOf(P);
      const waved = field.activeAt(i);
      for (const loop of outer(cut[n])) {
        const step = Math.max(0.1, Math.min(0.6, Math.max(0.15, perim(loop) / (cols * 2.5)), field.shortestStitch / 8));
        const woven = weaveLoop(loop, P ? (u) => offsetAt(w, P, u) : null, step, P ? w.smooth_mm : 0, w.seam.angle_deg, waved ? field.term(i, 0) : undefined);
        const z = zs[i] - lh / 2;
        for (let k = 1; k < woven.length; k++) tb.seg(woven[k - 1].x, woven[k - 1].y, z, woven[k].x, woven[k].y, z, view === 'wave' ? waveTint(woven[k - 1].wave ?? 0) : rgb);
      }
    });
  }
  const out = tb.finish();
  return out.report.beads ? out : null;
}
