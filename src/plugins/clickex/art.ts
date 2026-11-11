// Clickex artwork: every import source (image, SVG, icon, text, samples) becomes colour groups of clean
// region paths in mm (Y up). Placement, outlines and the 3D build only ever see this one form.
import { union } from '../../engine/clipper';
import type { Paths } from '../../engine/types';
import { parseSvg, pathSubpaths } from '../patternex/svg';
import { layoutText, type TextSpec } from '../patternex/tools/text';
import { solidRings, strokeLines } from '../patternex/tools/shape';
import { traceImage, type RasterImage } from '../patternex/tools/trace';
import type { Pattern, Ring as PRing } from '../patternex/model';
import { boundsMm, grow, simplify, smooth, toPaths, transformPaths, type XY } from './geom';

export interface ArtGroup { color: string; paths: Paths }
export type Art = ArtGroup[];

export const artPaths = (a: Art): Paths => a.flatMap((g) => g.paths);
export const artBounds = (a: Art) => boundsMm(artPaths(a));
export const artColors = (a: Art): string[] => [...new Set(a.map((g) => g.color.toLowerCase()))];

/** Union same-coloured groups and drop empty ones. */
export function tidy(groups: { color: string; paths: Paths }[]): Art {
  const by = new Map<string, Paths>();
  for (const g of groups) {
    const c = g.color.toLowerCase();
    by.set(c, [...(by.get(c) ?? []), ...g.paths]);
  }
  return [...by].map(([color, paths]) => ({ color, paths: union(paths) })).filter((g) => g.paths.length);
}

/** Pattern (Patternex form) → art: each shape resolved by its own fill rule, then grouped by colour. */
export function artFromPattern(p: Pattern): Art {
  return tidy(p.shapes.map((s) => ({ color: s.fill_color, paths: toPaths(solidRings(s.polygon_rings as PRing[], s.fill_rule === 'evenodd')) })));
}

export function artFromSvg(svg: string): { art: Art; warnings: string[] } {
  const r = parseSvg(svg, { tolerance_mm: 0.03, autoClose: true });
  return { art: artFromPattern(r.pattern), warnings: r.warnings };
}

export interface TraceOptions { colors: number; alphaCut: number; removeBg: boolean; smooth: number; speck: number }

export function artFromImage(img: RasterImage, o: TraceOptions): { art: Art; warnings: string[] } {
  // a picture with transparency already has its background removed
  let see = false;
  for (let i = 3; i < img.data.length; i += 4) if (img.data[i] < o.alphaCut) { see = true; break; }
  const r = traceImage(img, { colors: Math.max(1, Math.min(4, o.colors)), width_mm: 100, alphaCut: o.alphaCut, dropBackground: o.removeBg && !see, smooth_mm: o.smooth, speck_mm2: o.speck }, 'clickex');
  const art = artFromPattern(r.pattern).map((g) => ({ ...g, paths: smooth(g.paths, Math.max(0.2, o.smooth)) }));
  const warnings: string[] = [];
  if (!art.length) warnings.push('Nothing was found in the image. Try a PNG with a transparent background or switch Remove background off.');
  return { art, warnings };
}

// ---------------------------------------------------------------- icons (Lucide, ISC licence)
type Node = [string, Record<string, string>];
let iconData: Promise<Record<string, Node[]>> | null = null;
export const loadIcons = () => (iconData ??= import('./data/lucide.json').then((m) => (m.default ?? m) as unknown as Record<string, Node[]>));

const num = (s: string | undefined, d = 0) => { const n = parseFloat(s ?? ''); return isFinite(n) ? n : d; };

function nodeLines(tag: string, a: Record<string, string>): XY[][] {
  const flip = ([x, y]: XY): XY => [x, 24 - y];
  const closed = (pts: XY[]) => [...pts, pts[0]];
  const ellipse = (cx: number, cy: number, rx: number, ry: number): XY[] => closed(Array.from({ length: 48 }, (_, i) => { const t = (i / 48) * Math.PI * 2; return [cx + rx * Math.cos(t), cy + ry * Math.sin(t)] as XY; }));
  switch (tag) {
    case 'path': return pathSubpaths(a.d ?? '', 0.02).map((s) => (s.closed && s.pts.length ? closed(s.pts) : s.pts).map(flip));
    case 'circle': return [ellipse(num(a.cx), num(a.cy), num(a.r), num(a.r)).map(flip)];
    case 'ellipse': return [ellipse(num(a.cx), num(a.cy), num(a.rx), num(a.ry)).map(flip)];
    case 'line': return [[flip([num(a.x1), num(a.y1)]), flip([num(a.x2), num(a.y2)])]];
    case 'polyline': case 'polygon': {
      const v = (a.points ?? '').match(/-?\d*\.?\d+/g)?.map(Number) ?? [], pts: XY[] = [];
      for (let i = 0; i + 1 < v.length; i += 2) pts.push([v[i], v[i + 1]]);
      return pts.length ? [(tag === 'polygon' ? closed(pts) : pts).map(flip)] : [];
    }
    case 'rect': {
      const x = num(a.x), y = num(a.y), w = num(a.width), h = num(a.height), r = Math.min(num(a.rx, num(a.ry)), w / 2, h / 2);
      const d = r > 0 ? `M${x + r},${y}H${x + w - r}A${r},${r} 0 0 1 ${x + w},${y + r}V${y + h - r}A${r},${r} 0 0 1 ${x + w - r},${y + h}H${x + r}A${r},${r} 0 0 1 ${x},${y + h - r}V${y + r}A${r},${r} 0 0 1 ${x + r},${y}Z` : `M${x},${y}H${x + w}V${y + h}H${x}Z`;
      return pathSubpaths(d, 0.02).map((s) => closed(s.pts).map(flip));
    }
    default: return [];
  }
}

/** A Lucide icon as solid art: its strokes (2 on a 24 grid by default) grown into regions. */
export async function artFromIcon(name: string, stroke: number, color: string): Promise<Art> {
  const nodes = (await loadIcons())[name];
  if (!nodes) return [];
  const lines = nodes.flatMap(([tag, attrs]) => nodeLines(tag, attrs));
  const rings = solidRings(strokeLines(lines, stroke));
  return tidy([{ color, paths: toPaths(rings) }]);
}

// ---------------------------------------------------------------- text
export function artFromText(font: Parameters<typeof layoutText>[0], spec: TextSpec, color: string): Art {
  const lay = layoutText(font, spec);
  let paths = toPaths(solidRings(lay.rings));
  if (spec.weight_mm) paths = grow(paths, spec.weight_mm);
  return tidy([{ color, paths }]);
}

// ---------------------------------------------------------------- placement
export interface Placement { scale: number; angle: number; dx: number; dy: number; flip: boolean }

/** Centre the art on the origin, scale it, turn it, move it. */
export function placeArt(art: Art, p: Placement): Art {
  const b = artBounds(art);
  const centred = art.map((g) => ({ color: g.color, paths: transformPaths(g.paths, 1, 0, -b.cx, -b.cy) }));
  return centred.map((g) => ({ color: g.color, paths: simplify(transformPaths(g.paths, p.scale, p.angle, p.dx, p.dy, p.flip), 0.02) }));
}

/** Art → inline SVG markup (for thumbnails). Y is flipped back to screen orientation. */
export function artToSvg(art: Art, size = 64, pad = 0.06): string {
  const b = artBounds(art);
  const m = Math.max(b.w, b.h) || 1, k = (size * (1 - 2 * pad)) / m;
  const ox = size / 2 - b.cx * k, oy = size / 2 + b.cy * k;
  const body = art.map((g) => `<path fill="${g.color}" fill-rule="nonzero" d="${g.paths.map((p) => 'M' + p.map((q) => `${(q.X / 1e4 * k + ox).toFixed(2)},${(oy - q.Y / 1e4 * k).toFixed(2)}`).join('L') + 'Z').join('')}"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">${body}</svg>`;
}
