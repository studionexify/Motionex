// Thin typed wrapper around clipper-lib (Angus Johnson's Clipper, JS port).
// Coordinates are scaled to integers: 1 unit = 1/SCALE mm (0.1 µm).
import ClipperLib from 'clipper-lib';
import type { ExPolygon, Path, Paths } from './types';

const C: any = (ClipperLib as any).default ?? ClipperLib;

export const SCALE = 10000;

export const toInt = (v: number) => Math.round(v * SCALE);

const CT = C.ClipType;
const PT = C.PolyType;
const PFT = C.PolyFillType;
const JT = C.JoinType;
const ET = C.EndType;

// ---- memo of identical polygon operations
// Extruded models (stands, holders, boxes) repeat the same outline on layer after layer, and every layer then asks
// Clipper the very same questions. Operations are keyed by a 64-bit hash of their inputs; results are handed out as copies of the path arrays.
const MEMO_VERTS = 4_000_000;
const memo = new Map<string, { out: unknown; verts: number }>();
let memoVerts = 0;
// points are never edited in place anywhere in the engine, so copies share them and only copy the arrays
const clonePaths = (ps: Paths): Paths => ps.map((p) => p.slice());
function hashPaths(ps: Paths, h1: number, h2: number): [number, number, number] {
  let n = 0;
  for (const p of ps) {
    h1 = Math.imul(h1 ^ p.length, 0x01000193); h2 = Math.imul(h2 + p.length, 0x85ebca6b) ^ (h2 >>> 13);
    for (const q of p) {
      h1 = Math.imul(h1 ^ q.X, 0x01000193); h1 = Math.imul(h1 ^ q.Y, 0x01000193);
      h2 = Math.imul(h2 ^ (q.X * 31 + q.Y), 0xc2b2ae35); h2 ^= h2 >>> 15;
    }
    n += p.length;
  }
  return [h1, h2, n];
}
function memoized<T extends Paths | ExPolygon[]>(key: string, verts: number, copy: (v: T) => T, compute: () => T): T {
  if (verts < 24) return compute(); // not worth the bookkeeping
  const hit = memo.get(key);
  if (hit) { memo.delete(key); memo.set(key, hit); return copy(hit.out as T); }
  const out = compute();
  const store = copy(out);
  let size = 0;
  for (const p of (Array.isArray(store) && store.length && 'contour' in (store[0] as object) ? (store as ExPolygon[]).flatMap((e) => [e.contour, ...e.holes]) : (store as Paths))) size += p.length;
  memo.set(key, { out: store, verts: size }); memoVerts += size;
  while (memoVerts > MEMO_VERTS && memo.size) { const [k, v] = memo.entries().next().value!; memo.delete(k); memoVerts -= v.verts; }
  return out;
}
const key2 = (tag: string, a: Paths, b: Paths | null, extra: string | number = ''): [string, number] => {
  const [a1, a2, an] = hashPaths(a, 0x811c9dc5, 0x9e3779b9);
  const [b1, b2, bn] = b ? hashPaths(b, a1, a2) : [a1, a2, 0];
  return [`${tag}|${extra}|${a.length}|${an}|${bn}|${b1}|${b2}`, an + bn];
};
const cloneEx = (es: ExPolygon[]): ExPolygon[] => es.map((e) => ({ contour: e.contour.slice(), holes: clonePaths(e.holes) }));

function exec(type: number, subj: Paths, clip: Paths, fill = PFT.pftNonZero): Paths {
  const c = new C.Clipper();
  c.AddPaths(subj, PT.ptSubject, true);
  if (clip.length) c.AddPaths(clip, PT.ptClip, true);
  const out: Paths = [];
  c.Execute(type, out, fill, fill);
  return out;
}

export const union = (a: Paths, b: Paths = [], fill = PFT.pftNonZero) => {
  const [k, v] = key2('u', a, b, fill);
  return memoized(k, v, clonePaths, () => exec(CT.ctUnion, a, b, fill));
};
export const intersection = (a: Paths, b: Paths) => {
  if (!a.length || !b.length) return [];
  const [k, v] = key2('i', a, b);
  return memoized(k, v, clonePaths, () => exec(CT.ctIntersection, a, b));
};
export const difference = (a: Paths, b: Paths) => {
  if (!a.length) return [];
  if (!b.length) return a;
  const [k, v] = key2('d', a, b);
  return memoized(k, v, clonePaths, () => exec(CT.ctDifference, a, b));
};
export const unionEvenOdd = (a: Paths) => exec(CT.ctUnion, a, [], PFT.pftEvenOdd);

/** Offset closed polygons by delta (mm). Negative shrinks. */
export function offset(paths: Paths, deltaMm: number, join: 'miter' | 'round' = 'miter'): Paths {
  if (!paths.length) return [];
  if (deltaMm === 0) return paths;
  const [k, v] = key2('o', paths, null, `${deltaMm}|${join}`);
  return memoized(k, v, clonePaths, () => {
    const co = new C.ClipperOffset(2, SCALE * 0.0025);
    co.AddPaths(paths, join === 'round' ? JT.jtRound : JT.jtMiter, ET.etClosedPolygon);
    const out: Paths = [];
    co.Execute(out, toInt(deltaMm));
    return out;
  });
}

/** Morphological opening: removes features thinner than 2*r. */
export const opening = (paths: Paths, r: number) => offset(offset(paths, -r), r);

/** Clip open polylines against closed region. Returns open paths. */
export function clipLines(lines: Paths, region: Paths): Paths {
  if (!lines.length || !region.length) return [];
  const c = new C.Clipper();
  c.AddPaths(lines, PT.ptSubject, false);
  c.AddPaths(region, PT.ptClip, true);
  const tree = new C.PolyTree();
  c.Execute(CT.ctIntersection, tree, PFT.pftNonZero, PFT.pftNonZero);
  return C.Clipper.OpenPathsFromPolyTree(tree);
}

/** Open polylines minus a closed region (the parts outside it). */
export function clipLinesOutside(lines: Paths, region: Paths): Paths {
  if (!lines.length) return [];
  if (!region.length) return lines;
  const c = new C.Clipper();
  c.AddPaths(lines, PT.ptSubject, false);
  c.AddPaths(region, PT.ptClip, true);
  const tree = new C.PolyTree();
  c.Execute(CT.ctDifference, tree, PFT.pftNonZero, PFT.pftNonZero);
  return C.Clipper.OpenPathsFromPolyTree(tree);
}

export const area = (p: Path) => C.Clipper.Area(p) / (SCALE * SCALE);
export const areaTotal = (ps: Paths) => ps.reduce((s, p) => s + area(p), 0);
export const orientation = (p: Path): boolean => C.Clipper.Orientation(p);

export function cleanPaths(paths: Paths, distMm = 0.005): Paths {
  return C.Clipper.CleanPolygons(paths, distMm * SCALE).filter((p: Path) => p.length >= 3);
}

/** Group a set of paths into ExPolygons (outer + holes). */
export function toExPolygons(paths: Paths): ExPolygon[] {
  if (!paths.length) return [];
  const [k, v] = key2('x', paths, null);
  return memoized(k, v, cloneEx, () => toExPolygons0(paths));
}
function toExPolygons0(paths: Paths): ExPolygon[] {
  const c = new C.Clipper();
  c.AddPaths(paths, PT.ptSubject, true);
  const tree = new C.PolyTree();
  c.Execute(CT.ctUnion, tree, PFT.pftNonZero, PFT.pftNonZero);
  const out: ExPolygon[] = [];
  const walk = (node: any) => {
    for (const child of node.Childs()) {
      // child is an outer; its children are holes; holes' children are outers again.
      const ex: ExPolygon = { contour: child.Contour(), holes: [] };
      for (const hole of child.Childs()) {
        ex.holes.push(hole.Contour());
        walk(hole);
      }
      out.push(ex);
    }
  };
  walk(tree);
  return out;
}

export const exToPaths = (ex: ExPolygon): Paths => [ex.contour, ...ex.holes];

export function bounds(paths: Paths) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of paths) for (const q of p) {
    if (q.X < minX) minX = q.X; if (q.X > maxX) maxX = q.X;
    if (q.Y < minY) minY = q.Y; if (q.Y > maxY) maxY = q.Y;
  }
  return { minX, minY, maxX, maxY };
}

/** Even–odd point-in-polygons test (mm). */
export function pointIn(x: number, y: number, paths: Paths): boolean {
  const X = x * SCALE, Y = y * SCALE;
  let inside = false;
  for (const p of paths) for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const a = p[i], b = p[j];
    if ((a.Y > Y) !== (b.Y > Y) && X < ((b.X - a.X) * (Y - a.Y)) / (b.Y - a.Y) + a.X) inside = !inside;
  }
  return inside;
}
