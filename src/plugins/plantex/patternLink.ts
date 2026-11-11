// Link to the Patternex library: entries are referenced by key and rasterised on demand into a small
// height mask (one tile), so Plantex carries no copy of the artwork and loads nothing until it is used.
import { buildPattern, GROUP_KEYS, libraryEntries, specOf, type LibraryEntry } from '../patternex/library/catalog';
import type { Mask } from './textures';

const SIZE = 128;
const cache = new Map<string, Mask>();
let byKey: Map<string, LibraryEntry> | null = null;

export function patternEntry(key: string): LibraryEntry | undefined {
  byKey ??= new Map(libraryEntries().map((e) => [e.key, e]));
  return byKey.get(key);
}

/** Tile mask of a Patternex library entry: 1 inside inked shapes, 0 on the base. */
export function patternMask(key: string): Mask | undefined {
  const hit = cache.get(key);
  if (hit) return hit;
  const e = patternEntry(key);
  if (!e) return undefined;
  const W = 40, H = 40;
  const pat = buildPattern(specOf(e, W, H));
  const inked = pat.shapes.filter((s) => s.fill_color !== GROUP_KEYS[0]);
  const shapes = inked.length ? inked : pat.shapes;
  const data = new Float32Array(SIZE * SIZE);
  for (const s of shapes) {
    for (let py = 0; py < SIZE; py++) {
      // pattern y grows down; mask v grows up the body
      const y = H - ((py + 0.5) / SIZE) * H;
      const xs: [number, number][] = [];
      for (const r of s.polygon_rings) for (let k = 0; k < r.length; k++) {
        const [x0, y0] = r[k], [x1, y1] = r[(k + 1) % r.length];
        if ((y0 <= y) !== (y1 <= y)) xs.push([x0 + ((y - y0) / (y1 - y0)) * (x1 - x0), y1 > y0 ? 1 : -1]);
      }
      if (!xs.length) continue;
      xs.sort((a, b) => a[0] - b[0]);
      let wind = 0, k = 0;
      for (let px = 0; px < SIZE; px++) {
        const x = ((px + 0.5) / SIZE) * W;
        while (k < xs.length && xs[k][0] <= x) { wind += s.fill_rule === 'evenodd' ? 1 : xs[k][1]; k++; }
        const inside = s.fill_rule === 'evenodd' ? (wind & 1) === 1 : wind !== 0;
        if (inside) data[py * SIZE + px] = 1;
      }
    }
  }
  const m: Mask = { w: SIZE, h: SIZE, data };
  cache.set(key, m);
  return m;
}
