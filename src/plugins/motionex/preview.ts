// Quick look at the motion walls without slicing: the model is cut at a sample of layer heights,
// only where a motion applies, and the motions are applied to those outlines with the same code
// the slicer uses. The result is plain line segments for the 3D view; it takes milliseconds, not a slice.
import { sliceMesh } from '../../engine/slice';
import { SCALE } from '../../engine/clipper';
import type { IndexedMesh } from '../../engine/mesh';
import { composePath, makeRepeatLock, resample, type PathLayer, type RepeatLock, type Weight } from './modifier';
import type { PrintProfiles } from './core/profiles';
import type { Toolpath } from './core/types';
import type { MotionApplication, MotionBrush } from './model';
import type { Warp } from './sculpt/preview';
import { segmentField, ThreadBuilder, type DroolReport, type ThreadData } from '../threads';

export interface PreviewObject {
  id: string;
  /** World-space mesh. */
  mesh: IndexedMesh;
  /** Surface set per triangle (paint.motion). */
  motion?: Uint8Array;
}

export interface PreviewApp {
  app: MotionApplication; brush: MotionBrush; surface: number; color: [number, number, number];
  /** Region targets from other plugins (Patternex): the triangles each object has in the region. */
  trisByObject?: Map<string, number[]>;
}

/**
 * What the preview colours the lines by. motion: which motion it is (and how strongly it applies) ·
 * height: up-and-down movement · plastic: how much plastic each spot gets (after the limits) ·
 * speed: how fast each spot prints.
 */
export type PreviewView = "motion" | "height" | "plastic" | "speed";

export interface PreviewLines {
  /** Segment end points, xyz xyz per segment. */
  positions: Float32Array;
  /** rgb per end point. */
  colors: Float32Array;
  layers: number;
  view: PreviewView;
  /** Lowest and highest value shown (height: mm, plastic and speed: ×), for the legend. */
  range: [number, number];
  /** Pauses, blobs and lift-offs drawn as markers. */
  events: number;
  /** Real-size threads for the thick-thread view, the markers drawn over them, and the drool check. */
  threads?: ThreadData;
  markers?: { positions: Float32Array; colors: Float32Array };
  drool?: DroolReport;
}

/** Colours shared with the legend. */
export const VIEW_COLORS = { low: [0.2, 0.5, 0.95], mid: [0.62, 0.62, 0.62], high: [1, 0.42, 0.18], pause: [0.86, 0.2, 0.86], lift: [0.98, 0.8, 0.1], jump: [0.8, 0.8, 0.8] } as const;
const ramp = (t: number): number[] => {
  const u = Math.max(-1, Math.min(1, t)), m = VIEW_COLORS.mid, e = u < 0 ? VIEW_COLORS.low : VIEW_COLORS.high, a = Math.abs(u);
  return [m[0] + (e[0] - m[0]) * a, m[1] + (e[1] - m[1]) * a, m[2] + (e[2] - m[2]) * a];
};

/** Most layers drawn per object; tall parts show every n-th layer. */
const MAX_LAYERS = 140;
/** Plain wall shown around a picked area (mm), so you can see how the motion runs into it. */
const CONTEXT_MM = 3;
const smooth = (t: number) => { const u = Math.max(0, Math.min(1, t)); return u * u * (3 - 2 * u); };

/** Cross-section of the picked triangles at height z, as 2D segments (x0, y0, x1, y1, …). */
function pickedSegments(m: IndexedMesh, tris: number[], z: number): number[] {
  const v = m.vertices, ix = m.indices, out: number[] = [];
  for (const t of tris) {
    const p: number[] = [];
    for (let e = 0; e < 3; e++) {
      const a = ix[t * 3 + e] * 3, b = ix[t * 3 + ((e + 1) % 3)] * 3;
      const za = v[a + 2], zb = v[b + 2];
      if ((za - z) * (zb - z) > 0 || za === zb) continue;
      const u = (z - za) / (zb - za);
      p.push(v[a] + (v[b] - v[a]) * u, v[a + 1] + (v[b + 1] - v[a + 1]) * u);
    }
    if (p.length >= 4) out.push(p[0], p[1], p[2], p[3]);
  }
  return out;
}

export function buildPreview(objects: PreviewObject[], apps: PreviewApp[], p: PrintProfiles, step = 0.25, view: PreviewView = "motion", warp: Warp | null = null): PreviewLines {
  const pos: number[] = [], col: number[] = [];
  // colours that depend on the value range are filled in at the end: [index into col, value]
  const valued: [number, number][] = [];
  let vLo = Infinity, vHi = -Infinity, events = 0;
  const BASE_F = 50;
  let layersDrawn = 0;
  const lh = p.process.layerHeight || 0.2, first = p.process.firstLayerHeight || lh;
  // thick-thread twin of the lines: real-size beads, plus the markers that stay lines on top of them
  const tb = new ThreadBuilder(p.process.lineWidth || 0.42, lh, warp);
  const mpos: number[] = [], mcol: number[] = [];
  const beadAt: [number, number][] = []; // bead number, index of its first end point's colour in col
  const cross = (x: number, y: number, z: number, r: number, c: readonly number[]) => {
    const q = [x - r, y, z, x + r, y, z, x, y - r, z, x, y + r, z, x, y, z - r, x, y, z + r];
    pos.push(...q); mpos.push(...q);
    for (let k = 0; k < 6; k++) { col.push(c[0], c[1], c[2]); mcol.push(c[0], c[1], c[2]); }
    events++;
  };
  const locks = new Map<string, Map<string, number>>();
  const lockFor = (id: string): RepeatLock => {
    let m = locks.get(id); if (!m) locks.set(id, (m = new Map()));
    return makeRepeatLock(m);
  };
  for (const o of objects) {
    // which motions touch this object, and which of its triangles each one covers
    const mine = apps.map((a) => {
      if (a.app.target.type === 'body') return { ...a, tris: null as number[] | null };
      const tris: number[] = a.trisByObject ? [...(a.trisByObject.get(o.id) ?? [])] : [];
      if (!a.trisByObject) o.motion?.forEach((v, t) => { if (v === a.surface) tris.push(t); });
      return tris.length ? { ...a, tris } : null;
    }).filter((a): a is PreviewApp & { tris: number[] | null } => !!a);
    if (!mine.length) continue;
    const v = o.mesh.vertices;
    let zMin = Infinity, zMax = -Infinity;
    for (let i = 2; i < v.length; i += 3) { zMin = Math.min(zMin, v[i]); zMax = Math.max(zMax, v[i]); }
    // height range worth cutting: where some motion is switched on and has picked faces
    let lo = Infinity, hi = -Infinity;
    for (const a of mine) {
      let tlo = zMin, thi = zMax;
      if (a.tris) {
        tlo = Infinity; thi = -Infinity;
        for (const t of a.tris) for (let k = 0; k < 3; k++) { const z = v[o.mesh.indices[t * 3 + k] * 3 + 2]; tlo = Math.min(tlo, z); thi = Math.max(thi, z); }
      }
      lo = Math.min(lo, Math.max(tlo, a.app.mask.z_start)); hi = Math.max(hi, Math.min(thi, a.app.mask.z_end));
    }
    lo = Math.max(lo, zMin + first * 0.5); hi = Math.min(hi, zMax - 1e-3);
    if (!(hi > lo)) continue;
    const firstIdx = Math.max(0, Math.ceil((lo - zMin - first) / lh));
    const lastIdx = Math.floor((hi - zMin - first) / lh);
    const every = Math.max(1, Math.ceil((lastIdx - firstIdx + 1) / MAX_LAYERS));
    tb.newStack();
    const idx: number[] = [];
    for (let i = firstIdx; i <= lastIdx; i += every) idx.push(i);
    // cut a little under the layer top, like the slicer's mid-layer plane
    const planes = idx.map((i) => zMin + first + i * lh - lh / 2);
    const loops = sliceMesh(o.mesh, planes);
    planes.forEach((z, li) => {
      const layer = idx[li] + 1;
      tb.layer(every);
      const fields = mine.map((a) => (a.tris ? segmentField(pickedSegments(o.mesh, a.tris, z), 2) : null));
      const parts: PathLayer[] = [];
      const ws: Weight[] = [];
      mine.forEach((a, k) => {
        const { z_start, z_end, fade_in_mm, fade_out_mm } = a.app.mask;
        if (z < z_start || z > z_end) return;
        const zw = Math.min(fade_in_mm > 0 ? smooth((z - z_start) / fade_in_mm) : 1, fade_out_mm > 0 ? smooth((z_end - z) / fade_out_mm) : 1);
        const f = fields[k], blend = a.app.mask.blend_mm ?? 1.5;
        // on the picked faces full strength, easing to nothing over the soft edge outside them
        const w: Weight = f ? (x, y) => { const d = f(x, y); return d < 0.05 ? zw : blend > 0 ? zw * (1 - smooth(d / blend)) : 0; } : () => zw;
        ws.push(w);
        parts.push({ brush: a.brush, weight: w, blend: a.app.blend, tip: a.app.tip, repeats: lockFor(`${o.id}|${a.app.brush_id}|${k}`) });
      });
      if (!parts.length) return;
      const near = (x: number, y: number) => fields.some((f, k) => (f ? f(x, y) < (mine[k].app.mask.blend_mm ?? 1.5) + CONTEXT_MM : true));
      let drew = false;
      for (const path of loops[li] ?? []) {
        if (path.length < 3) continue;
        const pts = path.map((q) => ({ x: q.X / SCALE, y: q.Y / SCALE, z, f: BASE_F, flow: 1, e: 0 }));
        pts.push({ ...pts[0] });
        if (!resample(pts, 1).some((q) => near(q.x, q.y))) continue;
        const tp: Toolpath = { feature: 'outer_wall', closed: true, points: pts };
        const out = composePath(tp, parts, p, { resampleStep: step, loopSpeedShare: 1 }, () => {}, layer);
        const base = resample(pts, step);
        if (base.length !== out.points.length) continue;
        // strength and colour per point: the strongest motion there, plain context in grey
        const strength = base.map((q) => { let best = 0, who = -1; ws.forEach((w, k) => { const x = w(q.x, q.y, z, 0); if (x > best) { best = x; who = k; } }); return { best, who, near: near(q.x, q.y) }; });
        const valueOf = (q: (typeof out.points)[number]) =>
          view === "height" ? q.zOff ?? 0 : view === "plastic" ? q.flow : view === "speed" ? q.f / BASE_F : 0;
        for (let i = 1; i < out.points.length; i++) {
          const a = strength[i - 1], b = strength[i];
          if (!a.near && !b.near) continue;
          const pa = out.points[i - 1], pb = out.points[i];
          if (pa.post && (pa.post.dwell_ms || pa.post.blob_mm)) cross(pa.x, pa.y, pa.z, pa.post.blob_mm ? 0.9 : 0.5, VIEW_COLORS.pause);
          if (pa.post?.retract_mm) cross(pa.x, pa.y, pa.z, 0.5, VIEW_COLORS.lift);
          if (pb.travel) {
            // lift-off: the nozzle jumps here without printing
            pos.push(pa.x, pa.y, pa.z + 0.15, pb.x, pb.y, pb.z + 0.15);
            mpos.push(pa.x, pa.y, pa.z + 0.15, pb.x, pb.y, pb.z + 0.15);
            for (let k = 0; k < 2; k++) { col.push(...VIEW_COLORS.jump); mcol.push(...VIEW_COLORS.jump); }
            tb.string(pa.x, pa.y, pa.z, pb.x, pb.y, pb.z, [0.85, 0.85, 0.85]);
            continue;
          }
          pos.push(pa.x, pa.y, pa.z, pb.x, pb.y, pb.z);
          const bead = tb.seg(pa.x, pa.y, pa.z, pb.x, pb.y, pb.z, [0.6, 0.6, 0.6], Math.max(0.4, Math.min(2.2, (pa.flow + pb.flow) / 2)));
          if (bead >= 0) beadAt.push([bead, col.length]);
          for (const [s, q] of [[a, pa], [b, pb]] as const) {
            if (view !== "motion" && s.best > 0) {
              const v = valueOf(q);
              vLo = Math.min(vLo, v); vHi = Math.max(vHi, v);
              valued.push([col.length, v]);
              col.push(0, 0, 0);
              continue;
            }
            const c = s.who >= 0 ? mine[s.who].color : [0.6, 0.6, 0.6];
            const t = view !== "motion" ? 0 : 0.25 + 0.75 * s.best;
            col.push(0.55 + (c[0] - 0.55) * t, 0.55 + (c[1] - 0.55) * t, 0.55 + (c[2] - 0.55) * t);
          }
          drew = true;
        }
      }
      if (drew) layersDrawn++;
    });
  }
  // value colours: height around 0 mm, plastic and speed around 1×, scaled to the largest change seen
  const centre = view === "height" ? 0 : 1;
  const span = Math.max(0.05, Math.abs(vLo - centre), Math.abs(vHi - centre));
  for (const [k, v] of valued) { const c = ramp((v - centre) / span); col[k] = c[0]; col[k + 1] = c[1]; col[k + 2] = c[2]; }
  const { threads, report } = tb.finish();
  // the beads take the colour of the line they stand for
  for (const [b, c] of beadAt) for (let k = 0; k < 3; k++) threads.color[b * 3 + k] = (col[c + k] + col[c + 3 + k]) / 2;
  return { positions: Float32Array.from(pos), colors: Float32Array.from(col), layers: layersDrawn, view,
    range: valued.length ? [vLo, vHi] : [centre, centre], events, threads, drool: report,
    markers: { positions: Float32Array.from(mpos), colors: Float32Array.from(mcol) } };
}
