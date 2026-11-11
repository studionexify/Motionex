// Patternex charts: a colourwork grid painted cell by cell (like a knitting chart) that wraps round an
// object or lies on its front. A chart is plain data; `chartToPattern` turns it into an ordinary Patternex
// pattern (one rectangle per run of same-coloured cells), so placement, slicing and tool changes are the
// same code paths as SVG artwork.
import { boundsOf, type Pattern, type PatternShape, type RegionAction, type Ring } from './model';

/** Cell value: a 0-based filament slot, or BASE (the object's own filament, no change). */
export const BASE = -1;

export interface ChartSpec {
  name: string;
  /** Cells across one repeat, and rows up one repeat. */
  cols: number;
  rows: number;
  /** Repeats around (wrap) / across (front), and repeats upwards. */
  repX: number;
  repY: number;
  /** Row-major, row 0 at the bottom: cells[r * cols + c]. */
  cells: number[];
  /** Height of one row (mm). Wrap: the cell width follows from the circumference. */
  cellH: number;
  /** Front projection only: width of one cell (mm). */
  cellW: number;
  /** Bottom of the chart above the object's base (mm). */
  startZ: number;
  projection: 'wrap' | 'front';
}

export const CHART_LIMITS = { cols: [1, 96], rows: [1, 160], rep: [1, 64], cellH: [0.2, 20], cellW: [0.4, 20], startZ: [0, 500] } as const;
const clampInt = (v: number, [a, b]: readonly [number, number]) => Math.max(a, Math.min(b, Math.round(Number.isFinite(v) ? v : a)));
const clamp = (v: number, [a, b]: readonly [number, number]) => Math.max(a, Math.min(b, Number.isFinite(v) ? v : a));

/** A chart with every field in range and `cells` the right length. */
export function normalizeChart(s: ChartSpec): ChartSpec {
  const cols = clampInt(s.cols, CHART_LIMITS.cols), rows = clampInt(s.rows, CHART_LIMITS.rows);
  const cells = Array.from({ length: cols * rows }, (_, i) => {
    const v = s.cells[i];
    return Number.isInteger(v) && v >= BASE && v < 16 ? v : BASE;
  });
  return {
    name: s.name || 'Chart', cols, rows, cells,
    repX: clampInt(s.repX, CHART_LIMITS.rep), repY: clampInt(s.repY, CHART_LIMITS.rep),
    cellH: clamp(s.cellH, CHART_LIMITS.cellH), cellW: clamp(s.cellW, CHART_LIMITS.cellW),
    startZ: clamp(s.startZ, CHART_LIMITS.startZ), projection: s.projection === 'front' ? 'front' : 'wrap',
  };
}

export const cellAt = (s: ChartSpec, c: number, r: number) => s.cells[r * s.cols + c] ?? BASE;

/** Resize keeping the painted cells anchored bottom-left. */
export function resizeChart(s: ChartSpec, cols: number, rows: number): ChartSpec {
  const n = normalizeChart({ ...s, cols, rows, cells: [] });
  for (let r = 0; r < Math.min(rows, s.rows); r++) for (let c = 0; c < Math.min(cols, s.cols); c++) n.cells[r * n.cols + c] = cellAt(s, c, r);
  return n;
}

export function paintCells(s: ChartSpec, at: [number, number][], v: number): ChartSpec {
  const cells = s.cells.slice();
  let hit = false;
  for (const [c, r] of at) {
    if (c < 0 || r < 0 || c >= s.cols || r >= s.rows) continue;
    const i = r * s.cols + c;
    if (cells[i] !== v) { cells[i] = v; hit = true; }
  }
  return hit ? { ...s, cells } : s;
}

/** Flood fill of the 4-connected area of one value (wrapping across the left/right edge when the chart wraps). */
export function fillCells(s: ChartSpec, c0: number, r0: number, v: number): ChartSpec {
  if (c0 < 0 || r0 < 0 || c0 >= s.cols || r0 >= s.rows) return s;
  const from = cellAt(s, c0, r0);
  if (from === v) return s;
  const cells = s.cells.slice(), stack: [number, number][] = [[c0, r0]];
  while (stack.length) {
    const [c, r] = stack.pop()!;
    if (r < 0 || r >= s.rows) continue;
    const cc = s.projection === 'wrap' ? (c + s.cols) % s.cols : c;
    if (cc < 0 || cc >= s.cols || cells[r * s.cols + cc] !== from) continue;
    cells[r * s.cols + cc] = v;
    stack.push([cc + 1, r], [cc - 1, r], [cc, r + 1], [cc, r - 1]);
  }
  return { ...s, cells };
}

export function mirrorChart(s: ChartSpec, axis: 'x' | 'y'): ChartSpec {
  const cells = s.cells.map((_, i) => {
    const r = Math.floor(i / s.cols), c = i % s.cols;
    return axis === 'x' ? cellAt(s, s.cols - 1 - c, r) : cellAt(s, c, s.rows - 1 - r);
  });
  return { ...s, cells };
}

/** Slots a chart uses (sorted, BASE excluded). */
export const usedSlots = (s: ChartSpec) => [...new Set(s.cells.filter((v) => v !== BASE))].sort((a, b) => a - b);

/** Colour-group key of a slot inside chart patterns: one fixed colour per slot, so groups never merge. */
export const slotKey = (slot: number) => `#c0${(0x10 + slot).toString(16).padStart(2, '0')}00`;
export const slotOfKey = (key: string) => (/^#c0[0-9a-f]{2}00$/.test(key) ? parseInt(key.slice(3, 5), 16) - 0x10 : null);

/** Whole-chart size in mm: width covers every repeat across, height every repeat up. */
export function chartSize(s: ChartSpec, circumference: number): { width: number; height: number; cellW: number } {
  const totalCols = s.cols * s.repX;
  const width = s.projection === 'wrap' ? circumference : s.cellW * totalCols;
  return { width, height: s.cellH * s.rows * s.repY, cellW: width / totalCols };
}

/**
 * The chart as a Patternex pattern in pattern mm: x ∈ [-width/2, width/2] (wrap: the seam is opposite the anchor),
 * y ∈ [0, height] with row 0 at y = 0. Origin [0, 0] is the anchor point. Runs of equal cells in a row become one
 * rectangle; identical runs in consecutive rows are merged into taller rectangles.
 */
export function chartToPattern(spec: ChartSpec, circumference: number, id: string): Pattern {
  const s = normalizeChart(spec);
  const { width, height, cellW } = chartSize(s, circumference);
  const totalCols = s.cols * s.repX, totalRows = s.rows * s.repY;
  const x0 = -width / 2;
  // runs per row: [start col, end col (excl), slot]
  const runsOf = (R: number) => {
    const r = R % s.rows, out: [number, number, number][] = [];
    for (let C = 0; C < totalCols;) {
      const v = cellAt(s, C % s.cols, r);
      let E = C + 1;
      while (E < totalCols && cellAt(s, E % s.cols, r) === v) E++;
      if (v !== BASE) out.push([C, E, v]);
      C = E;
    }
    return out;
  };
  const open = new Map<string, { c0: number; c1: number; slot: number; r0: number; r1: number }>();
  const rects: { c0: number; c1: number; slot: number; r0: number; r1: number }[] = [];
  for (let R = 0; R < totalRows; R++) {
    const seen = new Set<string>();
    for (const [c0, c1, slot] of runsOf(R)) {
      const k = `${c0}:${c1}:${slot}`;
      seen.add(k);
      const o = open.get(k);
      if (o) o.r1 = R + 1; else open.set(k, { c0, c1, slot, r0: R, r1: R + 1 });
    }
    for (const [k, o] of open) if (!seen.has(k)) { rects.push(o); open.delete(k); }
  }
  rects.push(...open.values());
  const bySlot = new Map<number, Ring[]>();
  for (const q of rects) {
    const xa = x0 + q.c0 * cellW, xb = x0 + q.c1 * cellW, ya = q.r0 * s.cellH, yb = q.r1 * s.cellH;
    const ring: Ring = [[xa, ya], [xb, ya], [xb, yb], [xa, yb]];
    const l = bySlot.get(q.slot);
    if (l) l.push(ring); else bySlot.set(q.slot, [ring]);
  }
  // one shape per rectangle (non-overlapping), grouped by slot colour key
  const shapes: PatternShape[] = [];
  for (const slot of [...bySlot.keys()].sort((a, b) => a - b)) for (const ring of bySlot.get(slot)!) shapes.push({ polygon_rings: [ring], fill_color: slotKey(slot), fill_rule: 'nonzero' });
  const pat: Pattern = { id, name: s.name, source: 'builtin', shapes, tolerance_mm: 0.01, bounds: [x0, 0, x0 + width, height], origin: [0, 0], meta: { kind: 'chart', spec: s } };
  if (shapes.length) {
    // keep the full chart frame as bounds (empty edge columns still take their place)
    const b = boundsOf(shapes);
    pat.bounds = [Math.min(b[0], x0), Math.min(b[1], 0), Math.max(b[2], x0 + width), Math.max(b[3], height)];
  }
  return pat;
}

/** Region actions for a chart placement: each used slot prints with that filament. */
export function chartActions(placementId: string, s: ChartSpec, ams: boolean): RegionAction[] {
  return usedSlots(s).map((slot) => ({
    region_ref: { placement_id: placementId, color_group: slotKey(slot) },
    material: { mode: ams ? 'slot' : 'manual', slot_index: slot },
    purge: { mode: 'full', change_point_shift_mm: 0 },
    motion: null,
  }));
}

/**
 * Rough colour-change count before slicing: in every layer the head prints each colour the layer uses once,
 * starting with the colour it ended the previous layer on. `baseSlot` is the object's filament.
 */
export function estimateChanges(s: ChartSpec, layerHeight: number, baseSlot: number): number {
  const lh = Math.max(0.04, layerHeight);
  const totalRows = s.rows * s.repY;
  let changes = 0, last = baseSlot;
  for (let R = 0; R < totalRows; R++) {
    const r = R % s.rows;
    const used = new Set<number>([baseSlot]);
    for (let c = 0; c < s.cols; c++) { const v = cellAt(s, c, r); used.add(v === BASE ? baseSlot : v); }
    const layers = Math.max(1, Math.round(s.cellH / lh));
    if (used.size < 2) { if (last !== baseSlot) changes++; last = baseSlot; continue; }
    // each layer prints every colour once, starting with the one already loaded: k − 1 changes a layer
    changes += (used.size - 1) * layers + (used.has(last) ? 0 : 1);
    last = [...used].find((x) => x !== last) ?? last;
  }
  return changes;
}

const blank = (cols: number, rows: number) => Array<number>(cols * rows).fill(BASE);
function fromRows(rows: string[], map: Record<string, number>): number[] {
  // rows given top-down, like a chart drawn on paper
  return rows.slice().reverse().flatMap((line) => [...line].map((ch) => map[ch] ?? BASE));
}

/** Starter charts. Slots: 1 = second filament, 2 = third. */
export const CHART_PRESETS: { id: string; name: string; make: () => ChartSpec }[] = [
  {
    id: 'nordic', name: 'Nordic diamond', make: () => ({
      name: 'Nordic diamond band', cols: 12, rows: 18, repX: 10, repY: 1, cellH: 0.8, cellW: 2.4, startZ: 10, projection: 'wrap',
      cells: fromRows([
        '............',
        'aaaaaaaaaaaa',
        '............',
        '.....aa.....',
        'b...aaaa...b',
        '...aa..aa...',
        '..aa.bb.aa..',
        '.aa.bbbb.aa.',
        'aa.bbbbbb.aa',
        'aa.bbbbbb.aa',
        '.aa.bbbb.aa.',
        '..aa.bb.aa..',
        '...aa..aa...',
        'b...aaaa...b',
        '.....aa.....',
        '............',
        'aaaaaaaaaaaa',
        '............',
      ], { a: 1, b: 2 }),
    }),
  },
  {
    id: 'zigzag', name: 'Zigzag', make: () => ({
      name: 'Zigzag', cols: 8, rows: 8, repX: 14, repY: 2, cellH: 0.8, cellW: 2, startZ: 5, projection: 'wrap',
      cells: fromRows(['a.......', '.a.....a', '..a...a.', '...a.a..', '....a...', '........', '........', '........'], { a: 1 }),
    }),
  },
  {
    id: 'checker', name: 'Checker', make: () => ({
      name: 'Checker', cols: 2, rows: 2, repX: 24, repY: 10, cellH: 2, cellW: 4, startZ: 5, projection: 'wrap',
      cells: fromRows(['a.', '.a'], { a: 1 }),
    }),
  },
  {
    id: 'stripes', name: 'Stripes', make: () => ({
      name: 'Stripes', cols: 1, rows: 6, repX: 1, repY: 6, cellH: 1, cellW: 4, startZ: 5, projection: 'wrap',
      cells: fromRows(['a', 'a', '.', '.', '.', '.'], { a: 1 }),
    }),
  },
  { id: 'blank', name: 'Blank', make: () => ({ name: 'Untitled chart', cols: 12, rows: 12, repX: 8, repY: 1, cellH: 0.8, cellW: 2.4, startZ: 10, projection: 'wrap', cells: blank(12, 12) }) },
];

export const chartPreset = (id: string) => normalizeChart((CHART_PRESETS.find((p) => p.id === id) ?? CHART_PRESETS[0]).make());
