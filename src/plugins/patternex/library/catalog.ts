// The pattern library: families × presets × seeds × palettes, generated on demand.
// Entries are cheap descriptors; geometry is built only when a thumbnail or preview needs it.
import { boundsOf, type Pattern, type PatternShape, type Ring } from '../model';
import { hashStr } from '../svg';
import { CATEGORIES, defaults, FAMILIES, familyById, type Category, type Family } from './families';
import { rng, SHAPE_NAMES } from './geom';

/**
 * Library patterns are not inked: each region group gets a neutral key colour and the user picks the
 * ink (a filament slot, or the base material) per group. Group 0 is drawn in the base material.
 */
export const GROUP_KEYS = ['#ffffff', '#2f2f33', '#7d7d85', '#b9b9c0'];
export const GROUP_NAMES = ['Base', 'Ink A', 'Ink B', 'Ink C'];
export const NEUTRAL_BG = '#ecebe8';

export interface LibraryEntry {
  key: string;
  family: string;
  preset: string;
  seed: number;
  /** Density step: cell / count scaled by DENSITY[density]. */
  density: number;
  /** Value of the family's variant parameter, when it has one. */
  variant?: number;
  name: string;
  category: Category;
  tags: string[];
}

const SEEDS_PER_PRESET = 12;
export const DENSITY = [1, 0.6, 1.6];
const DENSITY_NAMES = ['', ' fine', ' coarse'];
/** Parameters scaled by the density step: bigger cell = coarser, more items = finer. */
const DENSITY_KEY: Record<string, 'up' | 'down'> = { cell: 'up', n: 'down', count: 'down', rays: 'down' };

let cache: LibraryEntry[] | null = null;
/** All library entries (thousands), in a stable order. */
export function libraryEntries(): LibraryEntry[] {
  if (cache) return cache;
  const out: LibraryEntry[] = [];
  for (const f of FAMILIES) for (const preset of Object.keys(f.presets)) {
    const seeds = f.seeded ? SEEDS_PER_PRESET : 1;
    const vars: (number | undefined)[] = f.variants ? f.variants.values : [undefined];
    const vlabel = (v: number | undefined) => (v === undefined ? '' : ` ${f.variants!.key === 'shape' ? SHAPE_NAMES[v] : `${v} ${f.params.find((d) => d.key === f.variants!.key)?.label.toLowerCase().split(' ')[0]}`}`);
    const dens = f.params.some((d) => d.key in DENSITY_KEY) ? DENSITY.map((_, i) => i) : [0];
    for (const variant of vars) for (const density of dens) for (let seed = 1; seed <= seeds; seed++) {
      out.push({
        key: `${f.id}/${preset}/${variant ?? '-'}/${density}/${seed}`, family: f.id, preset, seed, density, variant,
        name: `${f.name} · ${preset}${vlabel(variant)}${DENSITY_NAMES[density]}${f.seeded ? ` #${seed}` : ''}`, category: f.category,
        tags: [...f.tags, preset, ...(density ? [DENSITY_NAMES[density].trim()] : []), `${f.colors} colour`],
      });
    }
  }
  return (cache = out);
}

export function libraryCounts(): Record<Category | 'All', number> {
  const all = libraryEntries();
  const c = Object.fromEntries(CATEGORIES.map((k) => [k, 0])) as Record<Category | 'All', number>;
  for (const e of all) c[e.category]++;
  c.All = all.length;
  return c;
}

export function searchLibrary(q: string, category: Category | 'All'): LibraryEntry[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  return libraryEntries().filter((e) => (category === 'All' || e.category === category)
    && words.every((w) => e.name.toLowerCase().includes(w) || e.tags.some((t) => t.includes(w)) || e.category.toLowerCase().includes(w)));
}

/** Everything that defines a generated pattern; editable in the library window. */
export interface GenSpec {
  family: string; params: Record<string, number>; seed: number; width: number; height: number;
  /** Ink per region group (index = group): a 0-based filament slot, or -1 = base material / not inked. */
  inks?: number[];
}

export function specOf(e: LibraryEntry, width = 40, height = 40): GenSpec {
  const f = familyById(e.family)!;
  const params: Record<string, number> = { ...defaults(f), ...f.presets[e.preset], ...(e.variant !== undefined && f.variants ? { [f.variants.key]: e.variant } : {}) };
  const k = DENSITY[e.density ?? 0];
  if (k !== 1) for (const d of f.params) {
    const dir = DENSITY_KEY[d.key];
    if (!dir) continue;
    const v = dir === 'up' ? params[d.key] * k : params[d.key] / k;
    params[d.key] = Math.max(d.min, Math.min(d.max, Math.round(v / d.step) * d.step));
  }
  return { family: e.family, params, seed: e.seed, width, height };
}

/** Build the pattern for a spec. Deterministic: same spec → same geometry and id. */
export function buildPattern(spec: GenSpec, name?: string): Pattern {
  const f: Family = familyById(spec.family)!;
  const params = { ...defaults(f), ...spec.params };
  const raw = f.gen(params, spec.width, spec.height, rng(spec.seed * 7919 + 17));
  const byColor = new Map<string, PatternShape[]>();
  for (const s of raw) {
    if (!s.rings.length) continue;
    const color = GROUP_KEYS[Math.min(GROUP_KEYS.length - 1, Math.max(0, s.c))];
    const shape: PatternShape = { polygon_rings: s.rings.map(clean).filter((r) => r.length >= 3).map((r) => (s.evenodd ? r : ccw(r))), fill_color: color, fill_rule: s.evenodd ? 'evenodd' : 'nonzero' };
    if (!shape.polygon_rings.length) continue;
    const l = byColor.get(color); if (l) l.push(shape); else byColor.set(color, [shape]);
  }
  // colour 0 is the background: drawn shapes in it are kept (they print in the base material)
  const shapes = [...byColor.values()].flat();
  // inks do not change geometry, so they are not part of the id
  const { inks: _inks, ...geom } = spec;
  const id = `gen:${spec.family}:${hashStr(JSON.stringify(geom))}`;
  return { id, name: name ?? `${f.name}`, source: 'builtin', shapes, tolerance_mm: 0.05, bounds: shapes.length ? boundsOf(shapes) : [0, 0, spec.width, spec.height] };
}

/** Counter-clockwise ring (non-zero fill: overlapping pieces add up instead of cancelling). */
const ccw = (r: Ring): Ring => {
  let a = 0;
  for (let i = 0; i < r.length; i++) { const [x0, y0] = r[i], [x1, y1] = r[(i + 1) % r.length]; a += x0 * y1 - x1 * y0; }
  return a < 0 ? r.slice().reverse() : r;
};

const clean = (r: Ring): Ring => {
  const out: Ring = [];
  for (const p of r) { const q = out[out.length - 1]; if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-4) out.push([+p[0].toFixed(4), +p[1].toFixed(4)]); }
  return out;
};

/**
 * SVG markup for previews, viewBox = the pattern area. `inkColors` maps a group key colour to the colour to draw
 * (the chosen filament); groups without an ink keep their neutral grey.
 */
export function patternSvg(pat: Pattern, w: number, h: number, bg = NEUTRAL_BG, maxPoints = 60_000, inkColors: Record<string, string> = {}): string {
  const total = pat.shapes.reduce((n, s) => n + s.polygon_rings.reduce((a, r) => a + r.length, 0), 0);
  const step = Math.max(1, Math.ceil(total / maxPoints));
  const paths = pat.shapes.map((s) => {
    const d = s.polygon_rings.map((r) => {
      let out = '';
      for (let k = 0; k < r.length; k += step) out += `${k ? 'L' : 'M'}${r[k][0].toFixed(2)} ${(h - r[k][1]).toFixed(2)}`;
      return out + 'Z';
    }).join('');
    return `<path fill="${inkColors[s.fill_color] ?? s.fill_color}" fill-rule="${s.fill_rule}" d="${d}"/>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid slice"><rect width="${w}" height="${h}" fill="${bg}"/>${paths}</svg>`;
}

