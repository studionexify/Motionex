// Weave zones: modifier volumes and height ranges that carry a wave texture (WAVE_KEYS in their
// overrides). A shape zone is sliced once at every layer plane into outlines; a height band is a z range
// on its own object. The wave field (wave.ts) fades each zone in and out with a soft edge.
import type { Paths } from '../../../engine/types';
import { sliceMesh } from '../../../engine/slice';
import { SCALE, union } from '../../../engine/clipper';
import type { WaveStyle } from './model';
import type { WaveShape } from '../model';

type Overrides = Record<string, unknown>;

/** A part or height range carries a wave zone when it says wave here or keep plain. */
export const isWaveZone = (ov: Overrides | undefined | null) => ov?.wave_mode === 'wave' || ov?.wave_mode === 'plain';

/** A zone's own texture settings; missing ones follow the whole-part wave. */
export function ownStyle(ov: Overrides): Partial<WaveStyle> {
  const out: Partial<WaveStyle> = {};
  const n = (k: string) => { const v = Number(ov[k]); return ov[k] !== undefined && ov[k] !== '' && Number.isFinite(v) ? v : undefined; };
  if (typeof ov.wave_shape === 'string') out.shape = ov.wave_shape as WaveShape;
  if (n('wave_height') !== undefined) out.height_mm = Math.max(0, n('wave_height')!);
  if (n('wave_length') !== undefined) out.length_mm = Math.max(0.2, n('wave_length')!);
  if (n('wave_flip_every') !== undefined) out.flip_every = Math.max(0, Math.round(n('wave_flip_every')!));
  if (n('wave_flip_deg') !== undefined) out.flip_deg = n('wave_flip_deg')!;
  if (ov.wave_flip_mode === 'alternate' || ov.wave_flip_mode === 'steady') out.flip_mode = ov.wave_flip_mode;
  return out;
}

/** Outlines of a shape zone on one layer (mm), with a fast even–odd inside test. */
export class RingSet {
  readonly minX: number; readonly minY: number; readonly maxX: number; readonly maxY: number;
  /** Edges as x0, y0, x1, y1. */
  private e: Float64Array;
  /** Edge indices per horizontal strip. */
  private strips: Uint32Array[];
  private h: number;

  constructor(rings: Float64Array[]) {
    let n = 0, minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const r of rings) n += r.length / 2;
    const e = new Float64Array(n * 4);
    let k = 0;
    for (const r of rings) {
      const m = r.length / 2;
      for (let i = 0; i < m; i++) {
        const j = (i + 1) % m, x0 = r[2 * i], y0 = r[2 * i + 1];
        e[k++] = x0; e[k++] = y0; e[k++] = r[2 * j]; e[k++] = r[2 * j + 1];
        if (x0 < minX) minX = x0; if (x0 > maxX) maxX = x0; if (y0 < minY) minY = y0; if (y0 > maxY) maxY = y0;
      }
    }
    this.e = e; this.minX = minX; this.minY = minY; this.maxX = maxX; this.maxY = maxY;
    const B = Math.max(1, Math.min(256, Math.ceil(n / 4)));
    this.h = (maxY - minY) / B || 1;
    const lists: number[][] = Array.from({ length: B }, () => []);
    for (let i = 0; i < n; i++) {
      const ya = e[4 * i + 1], yb = e[4 * i + 3];
      const a = this.strip(Math.min(ya, yb), B), b = this.strip(Math.max(ya, yb), B);
      for (let s = a; s <= b; s++) lists[s].push(i);
    }
    this.strips = lists.map((l) => Uint32Array.from(l));
  }

  private strip(y: number, B = this.strips.length) { return Math.max(0, Math.min(B - 1, Math.floor((y - this.minY) / this.h))); }

  get empty() { return this.e.length === 0; }

  /** Does the box overlap the outlines' bounds grown by `grow` mm? */
  touches(minX: number, minY: number, maxX: number, maxY: number, grow: number) {
    return !this.empty && maxX >= this.minX - grow && minX <= this.maxX + grow && maxY >= this.minY - grow && minY <= this.maxY + grow;
  }

  inside(x: number, y: number): boolean {
    if (this.empty || x < this.minX || x > this.maxX || y < this.minY || y > this.maxY) return false;
    const e = this.e;
    let r = false;
    for (const i of this.strips[this.strip(y)]) {
      const x0 = e[4 * i], y0 = e[4 * i + 1], x1 = e[4 * i + 2], y1 = e[4 * i + 3];
      if ((y0 > y) !== (y1 > y) && x < ((x1 - x0) * (y - y0)) / (y1 - y0) + x0) r = !r;
    }
    return r;
  }
}

export interface WaveZone {
  kind: 'shape' | 'band';
  /** Object (index in the list the zones were collected from) the zone belongs to. */
  object: number;
  /** Keep plain: the wave fades out inside. */
  plain: boolean;
  own: Partial<WaveStyle>;
  /** Soft edge (mm); missing = the whole-part wave's. */
  blend?: number;
  /** Height band (object mm on the slice plane). */
  z0: number; z1: number;
  /** Shape: outlines per layer plane (null where the shape misses the plane). */
  layers?: (RingSet | null)[];
}

/** What an object brings to the zones: its parts (world mesh + overrides) and height ranges. */
export interface ZoneSource {
  parts?: { type: string; vertices: Float32Array; indices: Uint32Array; overrides?: Overrides }[];
  heightRanges?: { z0: number; z1: number; overrides: Overrides }[];
}

const toRings = (paths: Paths): Float64Array[] => paths.filter((p) => p.length > 2).map((p) => {
  const r = new Float64Array(p.length * 2);
  p.forEach((q, i) => { r[2 * i] = q.X / SCALE; r[2 * i + 1] = q.Y / SCALE; });
  return r;
});

/**
 * Wave zones of the objects, in the order they apply: an object's height bands, then its shapes, each in
 * list order (later ones win where they overlap). Shapes are sliced at `planes` (object mm, one per layer).
 */
export function collectZones(objects: ZoneSource[], planes: number[]): WaveZone[] {
  const out: WaveZone[] = [];
  const blendOf = (ov: Overrides) => { const v = Number(ov.wave_blend); return ov.wave_blend !== undefined && Number.isFinite(v) && v >= 0 ? v : undefined; };
  objects.forEach((o, object) => {
    for (const r of o.heightRanges ?? []) {
      if (!isWaveZone(r.overrides)) continue;
      out.push({ kind: 'band', object, plain: r.overrides.wave_mode === 'plain', own: ownStyle(r.overrides), blend: blendOf(r.overrides), z0: r.z0, z1: r.z1 });
    }
    for (const p of o.parts ?? []) {
      if (p.type !== 'modifier' || !isWaveZone(p.overrides)) continue;
      const ov = p.overrides!;
      let z0 = Infinity, z1 = -Infinity;
      for (let i = 2; i < p.vertices.length; i += 3) { if (p.vertices[i] < z0) z0 = p.vertices[i]; if (p.vertices[i] > z1) z1 = p.vertices[i]; }
      // the sweep needs the planes in rising order, as the slicer gives them
      const slices = sliceMesh({ vertices: p.vertices, indices: p.indices }, planes, 'regular');
      const layers = slices.map((paths) => { if (!paths.length) return null; const rs = new RingSet(toRings(union(paths))); return rs.empty ? null : rs; });
      if (!layers.some((l) => l)) continue;
      out.push({ kind: 'shape', object, plain: ov.wave_mode === 'plain', own: ownStyle(ov), blend: blendOf(ov), z0, z1, layers });
    }
  });
  return out;
}
