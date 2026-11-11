// Pattern families: parametric generators grouped by type. Every family is original procedural code;
// the library multiplies families × presets × seeds × palettes into thousands of ready patterns,
// and the editor exposes each family's parameters as sliders.
import type { Ring } from '../model';
import { circle, clipRect, ngon, noise1, polar, rect, shrink, star, stroke, transform, unitShape, voronoiCell, type Rnd } from './geom';

export interface GenShape { rings: Ring[]; c: number; evenodd?: boolean }
export interface ParamDef { key: string; label: string; min: number; max: number; step: number; def: number }
export type Category = 'Geometric' | 'Polygons' | 'Tiles' | 'Shapes' | 'Math' | 'Organic' | 'Lines' | 'Ornament';
export const CATEGORIES: Category[] = ['Geometric', 'Polygons', 'Tiles', 'Shapes', 'Math', 'Organic', 'Lines', 'Ornament'];

/** Centre of tile i of size `size`. */
const cx = (i: number, size: number) => (i + 0.5) * size;

export interface Family {
  id: string;
  name: string;
  category: Category;
  tags: string[];
  /** How many colour groups the family uses, counting the base (1 = shapes on the base material). */
  colors: number;
  seeded?: boolean;
  params: ParamDef[];
  /** Extra library variety: each preset is also listed for every value of this parameter. */
  variants?: { key: string; values: number[] };
  /** Named starting points; the library shows each preset at several densities and seeds. */
  presets: Record<string, Record<string, number>>;
  gen(p: Record<string, number>, W: number, H: number, rnd: Rnd): GenShape[];
}

const P = (key: string, label: string, min: number, max: number, step: number, def: number): ParamDef => ({ key, label, min, max, step, def });
const CELL = P('cell', 'Cell size (mm)', 1, 20, 0.5, 5);
const GAP = P('gap', 'Gap (mm)', 0, 3, 0.1, 0.4);
const ROT = P('rot', 'Rotation (°)', 0, 180, 1, 0);
const D2R = Math.PI / 180;

/** Clip all rings to the pattern box and drop empty ones. */
const fit = (W: number, H: number, shapes: GenShape[]): GenShape[] =>
  shapes.map((s) => ({ ...s, rings: s.rings.map((r) => clipRect(r, 0, 0, W, H)).filter((r) => r.length >= 3) })).filter((s) => s.rings.length);

/** Grid cell loop helper. */
function grid(W: number, H: number, cw: number, ch: number, f: (i: number, j: number, x: number, y: number) => void) {
  for (let j = 0, y = 0; y < H - 1e-9; j++, y += ch) for (let i = 0, x = 0; x < W - 1e-9; i++, x += cw) f(i, j, x, y);
}

/** Rotate the whole layout about the pattern centre, then clip (so stripes etc. can run at an angle). */
function rotated(W: number, H: number, deg: number, make: (w: number, h: number) => GenShape[]): GenShape[] {
  if (!deg) return fit(W, H, make(W, H));
  const R = Math.hypot(W, H);
  const a = deg * D2R;
  const shapes = make(R * 2, R * 2).map((s) => ({ ...s, rings: s.rings.map((r) => transform(r.map(([x, y]) => [x - R, y - R] as [number, number]), W / 2, H / 2, a)) }));
  return fit(W, H, shapes);
}

const bandsY = (w: number, h: number, cell: number, duty: number, colors: number) => {
  const out: GenShape[] = Array.from({ length: colors }, (_, c) => ({ rings: [], c }));
  for (let k = 0, x = 0; x < w; k++, x += cell) {
    const c = k % colors;
    out[c].rings.push(rect(x, 0, Math.min(w, x + cell * (c === colors - 1 ? 1 : duty)), h));
  }
  return out;
};

export const FAMILIES: Family[] = [
  // ---------------- Geometric
  {
    id: 'stripes', name: 'Stripes', category: 'Geometric', tags: ['lines', 'bands'], colors: 2,
    params: [CELL, P('duty', 'Stripe share', 0.1, 0.9, 0.05, 0.5), ROT],
    presets: { classic: {}, thin: { cell: 3, duty: 0.25 }, wide: { cell: 10 }, diagonal: { rot: 45 }, pinstripe: { cell: 2, duty: 0.15, rot: 90 } },
    gen: (p, W, H) => rotated(W, H, p.rot, (w, h) => {
      const out: GenShape[] = [{ rings: [], c: 1 }];
      for (let x = 0; x < w; x += p.cell) out[0].rings.push(rect(x, 0, x + p.cell * p.duty, h));
      return out;
    }),
  },
  {
    id: 'tricolor-bands', name: 'Colour bands', category: 'Geometric', tags: ['bands', 'multi-colour'], colors: 3,
    params: [P('cell', 'Band (mm)', 1, 20, 0.5, 4), ROT],
    presets: { even: {}, slim: { cell: 2 }, slanted: { rot: 30 }, horizontal: { rot: 90 } },
    gen: (p, W, H) => rotated(W, H, p.rot, (w, h) => bandsY(w, h, p.cell, 1, 3)),
  },
  {
    id: 'chevron', name: 'Chevron', category: 'Geometric', tags: ['zigzag', 'arrows'], colors: 2,
    params: [CELL, P('amp', 'Peak height (mm)', 0.5, 15, 0.5, 4), P('duty', 'Stripe share', 0.2, 0.8, 0.05, 0.5), ROT],
    presets: { classic: {}, steep: { amp: 8 }, shallow: { amp: 2 }, fine: { cell: 2.5, amp: 2 }, sideways: { rot: 90 } },
    gen: (p, W, H) => rotated(W, H, p.rot, (w, h) => {
      const rings: Ring[] = [], t = p.cell * p.duty;
      for (let y = -p.amp; y < h + p.amp; y += p.cell) {
        const top: [number, number][] = [], bot: [number, number][] = [];
        for (let x = 0, k = 0; x <= w + p.cell; x += p.cell, k++) { const yy = y + (k % 2 ? p.amp : 0); bot.push([x, yy]); top.push([x, yy + t]); }
        rings.push([...bot, ...top.reverse()]);
      }
      return [{ rings, c: 1 }];
    }),
  },
  {
    id: 'zigzag', name: 'Zigzag lines', category: 'Geometric', tags: ['zigzag', 'lines'], colors: 2,
    params: [CELL, P('amp', 'Amplitude (mm)', 0.5, 10, 0.5, 2), P('w', 'Line width (mm)', 0.4, 5, 0.1, 1), ROT],
    presets: { classic: {}, bold: { w: 2.5 }, tight: { cell: 2.5, amp: 1 }, tall: { amp: 5 } },
    gen: (p, W, H) => rotated(W, H, p.rot, (w, h) => {
      const rings: Ring[] = [];
      for (let y = 0; y < h + p.cell; y += p.cell) {
        const pts: [number, number][] = [];
        for (let x = 0, k = 0; x <= w + p.cell; x += p.amp * 1.2, k++) pts.push([x, y + (k % 2 ? p.amp : 0)]);
        rings.push(stroke(pts, p.w));
      }
      return [{ rings, c: 1 }];
    }),
  },
  {
    id: 'checker', name: 'Checker', category: 'Geometric', tags: ['grid', 'squares'], colors: 2,
    params: [CELL, ROT],
    presets: { classic: {}, small: { cell: 2.5 }, large: { cell: 10 }, diamond: { rot: 45 } },
    gen: (p, W, H) => rotated(W, H, p.rot, (w, h) => {
      const out: GenShape = { rings: [], c: 1 };
      grid(w, h, p.cell, p.cell, (i, j, x, y) => { if ((i + j) % 2) out.rings.push(rect(x, y, x + p.cell, y + p.cell)); });
      return [out];
    }),
  },
  {
    id: 'gingham', name: 'Gingham', category: 'Geometric', tags: ['plaid', 'grid', 'multi-colour'], colors: 3,
    params: [CELL, P('duty', 'Band share', 0.2, 0.8, 0.05, 0.5)],
    presets: { classic: {}, picnic: { cell: 8 }, fine: { cell: 3 } },
    gen: (p, W, H) => {
      const a: Ring[] = [], b: Ring[] = [];
      const t = p.cell * p.duty;
      grid(W, H, p.cell, p.cell, (_i, _j, x, y) => {
        b.push(rect(x, y, x + t, y + t)); // crossings, darkest
        a.push(rect(x + t, y, x + p.cell, y + t), rect(x, y + t, x + t, y + p.cell));
      });
      return fit(W, H, [{ rings: a, c: 1 }, { rings: b, c: 2 }]);
    },
  },
  {
    id: 'dots', name: 'Polka dots', category: 'Geometric', tags: ['dots', 'circles'], colors: 1,
    params: [CELL, P('r', 'Dot size', 0.1, 0.48, 0.01, 0.3), P('offset', 'Offset rows', 0, 1, 1, 1)],
    presets: { classic: {}, grid: { offset: 0 }, tiny: { cell: 2, r: 0.2 }, bold: { r: 0.45 }, sparse: { cell: 8, r: 0.15 } },
    gen: (p, W, H) => {
      const rings: Ring[] = [];
      for (let j = 0, y = p.cell / 2; y < H; j++, y += p.cell) for (let x = p.cell / 2 + (p.offset && j % 2 ? p.cell / 2 : 0); x < W; x += p.cell) rings.push(circle(x, y, p.cell * p.r));
      return fit(W, H, [{ rings, c: 1 }]);
    },
  },
  {
    id: 'halftone', name: 'Halftone gradient', category: 'Geometric', tags: ['dots', 'gradient'], colors: 1,
    params: [CELL, P('r0', 'Smallest dot', 0.02, 0.4, 0.01, 0.05), P('r1', 'Largest dot', 0.1, 0.5, 0.01, 0.48), P('dir', 'Direction (°)', 0, 360, 15, 0), P('radial', 'Radial', 0, 1, 1, 0)],
    presets: { linear: {}, radial: { radial: 1 }, diagonal: { dir: 45 }, fine: { cell: 2 } },
    gen: (p, W, H) => {
      const rings: Ring[] = [], ca = Math.cos(p.dir * D2R), sa = Math.sin(p.dir * D2R), R = Math.hypot(W, H) / 2;
      for (let j = 0, y = p.cell / 2; y < H; j++, y += p.cell * 0.87) for (let x = p.cell / 2 + (j % 2 ? p.cell / 2 : 0); x < W; x += p.cell) {
        const t = p.radial ? Math.hypot(x - W / 2, y - H / 2) / R : (((x - W / 2) * ca + (y - H / 2) * sa) / R + 1) / 2;
        const r = p.cell * (p.r0 + (p.r1 - p.r0) * Math.max(0, Math.min(1, t)));
        if (r > 0.08) rings.push(circle(x, y, r, 16));
      }
      return fit(W, H, [{ rings, c: 1 }]);
    },
  },
  {
    id: 'triangles', name: 'Triangles', category: 'Geometric', tags: ['triangles', 'grid'], colors: 2,
    params: [CELL, GAP],
    presets: { classic: {}, tight: { gap: 0 }, large: { cell: 10 }, small: { cell: 3, gap: 0.2 } },
    gen: (p, W, H) => {
      const a: Ring[] = [], hh = p.cell * 0.866;
      for (let j = 0, y = 0; y < H; j++, y += hh) for (let i = -1, x = -p.cell; x < W + p.cell; i++, x += p.cell / 2) {
        const up = (i + j) % 2 === 0;
        const tri: Ring = up ? [[x, y], [x + p.cell, y], [x + p.cell / 2, y + hh]] : [[x, y + hh], [x + p.cell / 2, y], [x + p.cell, y + hh]];
        if (up) a.push(shrink(tri, p.gap));
      }
      return fit(W, H, [{ rings: a, c: 1 }]);
    },
  },
  {
    id: 'argyle', name: 'Argyle diamonds', category: 'Geometric', tags: ['diamonds', 'knit', 'multi-colour'], colors: 3,
    params: [P('cell', 'Diamond width (mm)', 2, 20, 0.5, 8), P('ratio', 'Height ratio', 1, 2.5, 0.1, 1.5), GAP],
    presets: { classic: {}, tall: { ratio: 2.2 }, small: { cell: 4 } },
    gen: (p, W, H) => {
      const a: Ring[] = [], b: Ring[] = [], dh = p.cell * p.ratio;
      for (let j = 0, y = 0; y < H + dh; j++, y += dh / 2) for (let i = 0, x = (j % 2) * p.cell / 2; x < W + p.cell; i++, x += p.cell) {
        const d = shrink([[x, y - dh / 2], [x + p.cell / 2, y], [x, y + dh / 2], [x - p.cell / 2, y]], p.gap);
        (i + Math.floor(j / 2)) % 2 ? a.push(d) : b.push(d);
      }
      return fit(W, H, [{ rings: a, c: 1 }, { rings: b, c: 2 }]);
    },
  },
  {
    id: 'rings', name: 'Concentric rings', category: 'Geometric', tags: ['circles', 'target'], colors: 2,
    params: [P('cell', 'Ring pitch (mm)', 0.8, 10, 0.1, 3), P('duty', 'Ring share', 0.1, 0.9, 0.05, 0.5), P('sides', 'Sides (0 = round)', 0, 12, 1, 0)],
    presets: { target: {}, fine: { cell: 1.5 }, square: { sides: 4 }, hex: { sides: 6 }, bold: { cell: 6, duty: 0.6 } },
    gen: (p, W, H) => {
      const shapes: GenShape[] = [];
      const R = Math.hypot(W, H) / 2;
      const mk = (r: number) => (p.sides >= 3 ? ngon(W / 2, H / 2, r, p.sides, Math.PI / p.sides) : circle(W / 2, H / 2, r, 96));
      for (let r = p.cell; r < R + p.cell; r += p.cell) shapes.push({ rings: [mk(r), mk(Math.max(0.05, r - p.cell * p.duty))], c: 1, evenodd: true });
      return fit(W, H, shapes);
    },
  },
  {
    id: 'spiral', name: 'Spiral', category: 'Geometric', tags: ['swirl', 'circle'], colors: 2,
    params: [P('arms', 'Arms', 1, 12, 1, 1), P('pitch', 'Pitch (mm)', 1, 15, 0.5, 4), P('w', 'Width (mm)', 0.4, 6, 0.1, 1.5)],
    presets: { single: {}, double: { arms: 2 }, galaxy: { arms: 5, pitch: 10, w: 1 }, tight: { pitch: 2, w: 0.8 } },
    gen: (p, W, H) => {
      const rings: Ring[] = [], R = Math.hypot(W, H) / 2;
      for (let k = 0; k < p.arms; k++) {
        const pts: [number, number][] = [], a0 = (2 * Math.PI * k) / p.arms;
        for (let t = 0.2; (p.pitch * t) / (2 * Math.PI) * p.arms < R; t += 0.05) { const r = (p.pitch * t) / (2 * Math.PI) * p.arms; pts.push([W / 2 + r * Math.cos(t + a0), H / 2 + r * Math.sin(t + a0)]); }
        rings.push(stroke(pts, p.w));
      }
      return fit(W, H, [{ rings, c: 1 }]);
    },
  },
  {
    id: 'sunburst', name: 'Sunburst', category: 'Geometric', tags: ['rays', 'radial'], colors: 2,
    params: [P('rays', 'Rays', 4, 72, 1, 24), P('duty', 'Ray share', 0.1, 0.9, 0.05, 0.5), P('hole', 'Centre (mm)', 0, 20, 0.5, 0)],
    presets: { classic: {}, many: { rays: 48 }, few: { rays: 8 }, ring: { hole: 6 } },
    gen: (p, W, H) => {
      const rings: Ring[] = [], R = Math.hypot(W, H), cx = W / 2, cy = H / 2;
      for (let k = 0; k < p.rays; k++) {
        const a0 = (2 * Math.PI * k) / p.rays, a1 = a0 + (2 * Math.PI * p.duty) / p.rays;
        rings.push([[cx + p.hole * Math.cos(a0), cy + p.hole * Math.sin(a0)], [cx + R * Math.cos(a0), cy + R * Math.sin(a0)], [cx + R * Math.cos(a1), cy + R * Math.sin(a1)], [cx + p.hole * Math.cos(a1), cy + p.hole * Math.sin(a1)]]);
      }
      return fit(W, H, [{ rings, c: 1 }]);
    },
  },
  {
    id: 'lattice', name: 'Lattice', category: 'Geometric', tags: ['grid', 'mesh'], colors: 2,
    params: [CELL, P('w', 'Bar width (mm)', 0.3, 4, 0.1, 0.8), ROT],
    presets: { square: {}, diagonal: { rot: 45 }, fine: { cell: 2.5, w: 0.5 }, heavy: { w: 2 } },
    gen: (p, W, H) => rotated(W, H, p.rot, (w, h) => {
      const rings: Ring[] = [];
      for (let x = 0; x < w; x += p.cell) rings.push(rect(x, 0, x + p.w, h));
      for (let y = 0; y < h; y += p.cell) rings.push(rect(0, y, w, y + p.w));
      return [{ rings, c: 1 }];
    }),
  },
  {
    id: 'crosses', name: 'Crosses', category: 'Geometric', tags: ['plus', 'swiss'], colors: 1,
    params: [CELL, P('arm', 'Arm length', 0.2, 0.5, 0.01, 0.35), P('w', 'Arm width', 0.05, 0.3, 0.01, 0.12), P('offset', 'Offset rows', 0, 1, 1, 1)],
    presets: { classic: {}, grid: { offset: 0 }, bold: { w: 0.22 }, tiny: { cell: 3 } },
    gen: (p, W, H) => {
      const rings: Ring[] = [];
      for (let j = 0, y = p.cell / 2; y < H; j++, y += p.cell) for (let x = p.cell / 2 + (p.offset && j % 2 ? p.cell / 2 : 0); x < W; x += p.cell) {
        const a = p.cell * p.arm, t = (p.cell * p.w) / 2;
        rings.push([[x - t, y - a], [x + t, y - a], [x + t, y - t], [x + a, y - t], [x + a, y + t], [x + t, y + t], [x + t, y + a], [x - t, y + a], [x - t, y + t], [x - a, y + t], [x - a, y - t], [x - t, y - t]]);
      }
      return fit(W, H, [{ rings, c: 1 }]);
    },
  },

  // ---------------- Tiles
  {
    id: 'hex', name: 'Honeycomb', category: 'Tiles', tags: ['hexagon', 'bee'], colors: 3,
    params: [CELL, GAP, P('tri', 'Three colours', 0, 1, 1, 1)],
    presets: { honeycomb: { tri: 0, gap: 0.5 }, tricolour: {}, small: { cell: 3 }, tight: { gap: 0.15 } },
    gen: (p, W, H) => {
      const out: GenShape[] = [{ rings: [], c: 0 }, { rings: [], c: 1 }, { rings: [], c: 2 }];
      const r = p.cell / 2, dx = Math.sqrt(3) * r, dy = 1.5 * r;
      for (let j = 0, y = 0; y < H + r; j++, y += dy) for (let i = 0, x = j % 2 ? dx / 2 : 0; x < W + dx; i++, x += dx) {
        // three-colouring of the hex grid: (i - j/2) mod 3 on axial coordinates
        // odd rows are shifted right: axial q = i - floor(j/2); (q - j) mod 3 is a proper 3-colouring
        const q = i - Math.floor(j / 2);
        const c = p.tri ? (((q - j) % 3) + 3) % 3 : 1;
        out[c].rings.push(ngon(x, y, Math.max(0.1, r - p.gap / 2), 6, Math.PI / 6));
      }
      return fit(W, H, out.filter((s) => s.c !== 0 || p.tri));
    },
  },
  {
    id: 'brick', name: 'Brick', category: 'Tiles', tags: ['wall', 'running bond'], colors: 2,
    params: [P('cell', 'Brick length (mm)', 2, 20, 0.5, 8), P('ratio', 'Height ratio', 0.2, 1, 0.05, 0.45), GAP, P('alt', 'Two-tone', 0, 1, 1, 0)],
    presets: { running: {}, stack: { ratio: 0.5 }, twotone: { alt: 1 }, small: { cell: 4 } },
    gen: (p, W, H) => {
      const a: Ring[] = [], b: Ring[] = [], bh = p.cell * p.ratio;
      for (let j = 0, y = 0; y < H; j++, y += bh) for (let i = 0, x = j % 2 ? -p.cell / 2 : 0; x < W; i++, x += p.cell) {
        const r = rect(x + p.gap / 2, y + p.gap / 2, x + p.cell - p.gap / 2, y + bh - p.gap / 2);
        (p.alt && (i + j) % 2 ? b : a).push(r);
      }
      return fit(W, H, [{ rings: a, c: 1 }, ...(p.alt ? [{ rings: b, c: 0 } as GenShape] : [])]);
    },
  },
  {
    id: 'parquet', name: 'Chevron parquet', category: 'Tiles', tags: ['parquet', 'floor', 'herringbone'], colors: 2,
    params: [P('cell', 'Plank length (mm)', 2, 20, 0.5, 8), P('ratio', 'Width ratio', 0.15, 0.5, 0.05, 0.3), GAP],
    presets: { classic: {}, slim: { ratio: 0.2 }, large: { cell: 14 } },
    gen: (p, W, H) => {
      // columns of planks tilted ±45°, meeting in a V at the column joints
      const a: Ring[] = [], b: Ring[] = [], L = p.cell, w = L * p.ratio, k = Math.SQRT1_2;
      const cw = L * k, pitch = w / k;
      for (let c = 0, x = 0; x < W + cw; c++, x += cw) for (let y = -L; y < H + L; y += pitch) {
        const plank = shrink(rect(-L / 2, -w / 2, L / 2, w / 2), p.gap);
        (c % 2 ? b : a).push(transform(plank, x + cw / 2, y, c % 2 ? -Math.PI / 4 : Math.PI / 4));
      }
      return fit(W, H, [{ rings: a, c: 1 }, { rings: b, c: 0 }]);
    },
  },
  {
    id: 'basketweave', name: 'Basketweave', category: 'Tiles', tags: ['weave', 'textile'], colors: 2,
    params: [CELL, P('n', 'Strips per block', 2, 4, 1, 2), GAP],
    presets: { classic: {}, triple: { n: 3 }, large: { cell: 10 } },
    gen: (p, W, H) => {
      const a: Ring[] = [], b: Ring[] = [], s = p.cell / p.n;
      grid(W, H, p.cell, p.cell, (i, j, x, y) => {
        for (let k = 0; k < p.n; k++) {
          if ((i + j) % 2) a.push(shrink(rect(x, y + k * s, x + p.cell, y + (k + 1) * s), p.gap / 2));
          else b.push(shrink(rect(x + k * s, y, x + (k + 1) * s, y + p.cell), p.gap / 2));
        }
      });
      return fit(W, H, [{ rings: a, c: 1 }, { rings: b, c: 0 }]);
    },
  },
  {
    id: 'scales', name: 'Fish scales', category: 'Tiles', tags: ['scales', 'seigaiha', 'waves'], colors: 2,
    params: [CELL, P('rings', 'Rings per scale', 1, 5, 1, 3), P('duty', 'Line share', 0.2, 0.8, 0.05, 0.5)],
    presets: { seigaiha: {}, simple: { rings: 1 }, fine: { cell: 3, rings: 2 } },
    gen: (p, W, H) => {
      const shapes: GenShape[] = [];
      const r = p.cell / 2;
      for (let j = Math.ceil(H / (r / 2)) + 2; j >= -1; j--) for (let x = (j % 2) * r; x < W + p.cell; x += p.cell) {
        const y = j * (r / 2);
        for (let k = p.rings; k >= 1; k--) {
          const rr = (r * k) / p.rings, ri = rr - (r / p.rings) * p.duty;
          const half = (rad: number): Ring => { const out: Ring = []; for (let t = 0; t <= 24; t++) { const a = (Math.PI * t) / 24; out.push([x + rad * Math.cos(a), y + rad * Math.sin(a)]); } return out; };
          shapes.push({ rings: [half(rr), ...(ri > 0.05 ? [half(ri)] : [])], c: 1, evenodd: true });
        }
      }
      return fit(W, H, shapes);
    },
  },
  {
    id: 'truchet', name: 'Truchet arcs', category: 'Tiles', tags: ['maze', 'arcs', 'random'], colors: 2, seeded: true,
    params: [CELL, P('w', 'Line width (share)', 0.1, 0.45, 0.01, 0.25)],
    presets: { classic: {}, bold: { w: 0.4 }, fine: { cell: 3, w: 0.2 } },
    gen: (p, W, H, rnd) => {
      const rings: Ring[] = [];
      const arc = (cx: number, cy: number, a0: number) => {
        const r = p.cell / 2, h = (p.cell * p.w) / 2, out: [number, number][] = [];
        for (let t = 0; t <= 12; t++) { const a = a0 + (Math.PI / 2) * (t / 12); out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
        return stroke(out, h * 2);
      };
      grid(W, H, p.cell, p.cell, (_i, _j, x, y) => {
        if (rnd() < 0.5) { rings.push(arc(x, y, 0), arc(x + p.cell, y + p.cell, Math.PI)); }
        else { rings.push(arc(x + p.cell, y, Math.PI / 2), arc(x, y + p.cell, -Math.PI / 2)); }
      });
      return fit(W, H, [{ rings, c: 1 }]);
    },
  },
  {
    id: 'quarter-circles', name: 'Quarter circles', category: 'Tiles', tags: ['mosaic', 'random', 'mid-century'], colors: 3, seeded: true,
    params: [CELL],
    presets: { classic: {}, large: { cell: 10 }, small: { cell: 3 } },
    gen: (p, W, H, rnd) => {
      const out: GenShape[] = [{ rings: [], c: 1 }, { rings: [], c: 2 }];
      grid(W, H, p.cell, p.cell, (_i, _j, x, y) => {
        const corner = Math.floor(rnd() * 4), cx = x + (corner % 2 ? p.cell : 0), cy = y + (corner > 1 ? p.cell : 0);
        const a0 = [0, Math.PI / 2, -Math.PI / 2, Math.PI][corner];
        const r: Ring = [[cx, cy]];
        for (let t = 0; t <= 16; t++) { const a = a0 + (Math.PI / 2) * (t / 16); r.push([cx + p.cell * Math.cos(a), cy + p.cell * Math.sin(a)]); }
        out[rnd() < 0.5 ? 0 : 1].rings.push(r);
      });
      return fit(W, H, out);
    },
  },
  {
    id: 'mosaic', name: 'Mosaic squares', category: 'Tiles', tags: ['mosaic', 'random', 'subdivision'], colors: 3, seeded: true,
    params: [P('cell', 'Block (mm)', 4, 40, 1, 20), P('depth', 'Split depth', 1, 5, 1, 3), GAP],
    presets: { classic: {}, fine: { depth: 5 }, chunky: { depth: 2 } },
    gen: (p, W, H, rnd) => {
      const out: GenShape[] = [{ rings: [], c: 0 }, { rings: [], c: 1 }, { rings: [], c: 2 }];
      const split = (x: number, y: number, s: number, d: number) => {
        if (d > 0 && rnd() < 0.65) { const h = s / 2; split(x, y, h, d - 1); split(x + h, y, h, d - 1); split(x, y + h, h, d - 1); split(x + h, y + h, h, d - 1); return; }
        out[Math.floor(rnd() * 3)].rings.push(rect(x + p.gap / 2, y + p.gap / 2, x + s - p.gap / 2, y + s - p.gap / 2));
      };
      grid(W, H, p.cell, p.cell, (_i, _j, x, y) => split(x, y, p.cell, p.depth));
      return fit(W, H, out.filter((s) => s.c));
    },
  },
  {
    id: 'pinwheel', name: 'Pinwheel', category: 'Tiles', tags: ['quilt', 'triangles'], colors: 2,
    params: [CELL],
    presets: { classic: {}, large: { cell: 10 }, small: { cell: 3 } },
    gen: (p, W, H) => {
      const rings: Ring[] = [];
      grid(W, H, p.cell, p.cell, (i, j, x, y) => {
        const s = p.cell / 2, cx = x + s, cy = y + s;
        for (let k = 0; k < 4; k++) rings.push(transform([[0, 0], [s, 0], [s, s]], cx, cy, (k * Math.PI) / 2 + ((i + j) % 2 ? Math.PI / 2 : 0)));
      });
      return fit(W, H, [{ rings, c: 1 }]);
    },
  },
  {
    id: 'stars-grid', name: 'Star tiles', category: 'Tiles', tags: ['stars', 'grid'], colors: 2,
    params: [CELL, P('points', 'Points', 4, 12, 1, 8), P('inner', 'Inner radius', 0.2, 0.9, 0.02, 0.5), P('size', 'Star size', 0.2, 0.75, 0.01, 0.5)],
    variants: { key: 'points', values: [4, 5, 6, 8, 10, 12] },
    presets: { moroccan: {}, five: { points: 5, inner: 0.4 }, compass: { points: 4, inner: 0.3, size: 0.6 }, burst: { points: 12, inner: 0.7 } },
    gen: (p, W, H) => {
      const rings: Ring[] = [];
      grid(W, H, p.cell, p.cell, (_i, _j, x, y) => { const r = p.cell * p.size; rings.push(star(x + p.cell / 2, y + p.cell / 2, r, r * p.inner, p.points, Math.PI / p.points)); });
      return fit(W, H, [{ rings, c: 1 }]);
    },
  },
  {
    id: 'quatrefoil', name: 'Quatrefoil', category: 'Tiles', tags: ['gothic', 'clover', 'trellis'], colors: 2,
    params: [CELL, P('lobe', 'Lobe size', 0.15, 0.35, 0.01, 0.27)],
    presets: { classic: {}, large: { cell: 10 }, small: { cell: 3 } },
    gen: (p, W, H) => {
      const rings: Ring[] = [];
      grid(W, H, p.cell, p.cell, (_i, _j, x, y) => {
        const cx = x + p.cell / 2, cy = y + p.cell / 2, r = p.cell * p.lobe;
        rings.push(polar(cx, cy, (a) => r * (1.2 + 0.8 * Math.abs(Math.cos(2 * a))), 96, Math.PI / 4));
      });
      return fit(W, H, [{ rings, c: 1 }]);
    },
  },

  // ---------------- Shapes (radial arrangements, logos, badges)
  {
    id: 'radial', name: 'Radial arrangement', category: 'Shapes', tags: ['radial', 'logo', 'mandala'], colors: 3,
    params: [
      P('shape', 'Shape', 0, 7, 1, 4), P('count', 'Count', 2, 36, 1, 8), P('layers', 'Layers', 1, 6, 1, 3), P('radius', 'Radius (share)', 0.05, 0.48, 0.01, 0.35),
      P('size', 'Shape size (share)', 0.03, 0.4, 0.01, 0.14), P('spin', 'Spin (°)', 0, 360, 5, 0), P('rotStep', 'Rotate step (°)', 0, 90, 1, 0),
      P('scaleEnd', 'Inner layer scale', 0.2, 1.5, 0.05, 0.6), P('inner', 'Star inner', 0.2, 0.9, 0.05, 0.45),
    ],
    variants: { key: 'shape', values: [0, 1, 2, 3, 4, 5, 6, 7] },
    presets: { semicircles: {}, petals: { shape: 5, count: 12 }, stars: { shape: 3, count: 6, layers: 2 }, dots: { shape: 0, count: 16, layers: 4 }, squares: { shape: 1, count: 10, rotStep: 15 }, sparkles: { shape: 7, count: 8, size: 0.1 } },
    gen: (p, W, H) => {
      const out: GenShape[] = [];
      const S = Math.min(W, H), cx = W / 2, cy = H / 2, base = unitShape(p.shape, p.inner);
      for (let l = 0; l < p.layers; l++) {
        const f = p.layers > 1 ? l / (p.layers - 1) : 0, k = 1 + (p.scaleEnd - 1) * f;
        const rad = S * p.radius * k, sz = S * p.size * k;
        const rings: Ring[] = [];
        for (let i = 0; i < p.count; i++) {
          const a = (p.spin * D2R) + (2 * Math.PI * i) / p.count + (l % 2 ? Math.PI / p.count : 0);
          rings.push(transform(base, cx + rad * Math.cos(a), cy + rad * Math.sin(a), a + Math.PI / 2 + p.rotStep * i * D2R, sz));
        }
        out.push({ rings, c: 1 + (l % 2) });
      }
      return fit(W, H, out);
    },
  },
  {
    id: 'rosette', name: 'Rosette', category: 'Shapes', tags: ['flower', 'petals', 'logo'], colors: 2,
    params: [P('petals', 'Petals', 3, 24, 1, 8), P('depth', 'Petal depth', 0.05, 0.9, 0.01, 0.4), P('size', 'Size (share)', 0.2, 0.5, 0.01, 0.45), P('hole', 'Centre hole', 0, 0.6, 0.01, 0.15)],
    variants: { key: 'petals', values: [4, 5, 6, 8, 10, 12, 16] },
    presets: { daisy: {}, gear: { petals: 16, depth: 0.12 }, clover: { petals: 4, depth: 0.7 }, lotus: { petals: 12, depth: 0.6 } },
    gen: (p, W, H) => {
      const R = Math.min(W, H) * p.size, cx = W / 2, cy = H / 2;
      const outer = polar(cx, cy, (a) => R * (1 - p.depth + p.depth * Math.abs(Math.cos((p.petals * a) / 2))), 360);
      return fit(W, H, [{ rings: p.hole > 0 ? [outer, circle(cx, cy, R * p.hole, 64)] : [outer], c: 1, evenodd: true }]);
    },
  },
  {
    id: 'polystar', name: 'Star / polygon', category: 'Shapes', tags: ['star', 'polygon', 'badge'], colors: 2,
    params: [P('points', 'Points', 3, 24, 1, 5), P('inner', 'Inner radius', 0.1, 1, 0.01, 0.45), P('size', 'Size (share)', 0.2, 0.5, 0.01, 0.45), P('outline', 'Outline (mm)', 0, 5, 0.1, 0)],
    variants: { key: 'points', values: [3, 4, 5, 6, 7, 8, 10, 12] },
    presets: { star: {}, polygon: { inner: 1, points: 6 }, burst: { points: 16, inner: 0.75 }, outlined: { outline: 1.5 }, triangle: { points: 3, inner: 1 } },
    gen: (p, W, H) => {
      const R = Math.min(W, H) * p.size, cx = W / 2, cy = H / 2;
      const s = star(cx, cy, R, R * p.inner, p.points);
      const rings = p.outline > 0 ? [s, star(cx, cy, Math.max(0.1, R - p.outline * 1.4), Math.max(0.05, R * p.inner - p.outline), p.points)] : [s];
      return fit(W, H, [{ rings, c: 1, evenodd: true }]);
    },
  },
  {
    id: 'mandala', name: 'Mandala', category: 'Shapes', tags: ['mandala', 'radial', 'ornament'], colors: 3,
    params: [P('layers', 'Layers', 2, 7, 1, 4), P('petals', 'Petals', 4, 24, 1, 12), P('size', 'Size (share)', 0.25, 0.5, 0.01, 0.48), P('twist', 'Twist per layer (°)', 0, 45, 1, 15)],
    variants: { key: 'petals', values: [6, 8, 10, 12, 16] },
    presets: { lotus: {}, dense: { layers: 6, petals: 18 }, simple: { layers: 3, petals: 8 }, twisted: { twist: 35 } },
    gen: (p, W, H) => {
      const out: GenShape[] = [], cx = W / 2, cy = H / 2, R = Math.min(W, H) * p.size;
      for (let l = p.layers; l >= 1; l--) {
        const r = (R * l) / p.layers, rot = l * p.twist * D2R;
        const ring = polar(cx, cy, (a) => r * (0.75 + 0.25 * Math.abs(Math.cos((p.petals * (a - rot)) / 2))), 360);
        out.push({ rings: [ring, circle(cx, cy, r * 0.62, 96)], c: 1 + (l % 2), evenodd: true });
      }
      out.push({ rings: [circle(cx, cy, R * 0.12, 48)], c: 1 });
      return fit(W, H, out);
    },
  },
  {
    id: 'gear', name: 'Gear badge', category: 'Shapes', tags: ['gear', 'cog', 'badge', 'logo'], colors: 2,
    params: [P('teeth', 'Teeth', 6, 48, 1, 16), P('tooth', 'Tooth depth', 0.04, 0.3, 0.01, 0.12), P('size', 'Size (share)', 0.25, 0.5, 0.01, 0.46), P('hole', 'Hole', 0, 0.7, 0.01, 0.3)],
    variants: { key: 'teeth', values: [8, 12, 16, 24, 32] },
    presets: { gear: {}, fine: { teeth: 40, tooth: 0.06 }, chunky: { teeth: 8, tooth: 0.22 }, solid: { hole: 0 } },
    gen: (p, W, H) => {
      const R = Math.min(W, H) * p.size, cx = W / 2, cy = H / 2;
      const outer = polar(cx, cy, (a) => R * (1 - p.tooth * (Math.cos(p.teeth * a) > 0 ? 0 : 1)), p.teeth * 16);
      return fit(W, H, [{ rings: p.hole > 0 ? [outer, circle(cx, cy, R * p.hole, 64)] : [outer], c: 1, evenodd: true }]);
    },
  },
  {
    id: 'flower-of-life', name: 'Overlapping circles', category: 'Shapes', tags: ['sacred geometry', 'circles', 'outline'], colors: 2,
    params: [P('cell', 'Circle radius (mm)', 1, 15, 0.5, 5), P('w', 'Line width (mm)', 0.3, 3, 0.1, 0.6)],
    presets: { classic: {}, fine: { cell: 3, w: 0.4 }, bold: { w: 1.4 } },
    gen: (p, W, H) => {
      const shapes: GenShape[] = [], r = p.cell, dx = r, dy = r * 0.866;
      for (let j = 0, y = 0; y < H + r; j++, y += dy) for (let x = j % 2 ? dx / 2 : 0; x < W + r; x += dx) shapes.push({ rings: [circle(x, y, r + p.w / 2, 48), circle(x, y, r - p.w / 2, 48)], c: 1, evenodd: true });
      return fit(W, H, shapes);
    },
  },

  // ---------------- Organic
  {
    id: 'voronoi', name: 'Voronoi cells', category: 'Organic', tags: ['cells', 'cracked', 'random'], colors: 3, seeded: true,
    params: [P('n', 'Cells', 8, 200, 1, 40), GAP, P('jitter', 'Irregularity', 0, 1, 0.05, 1)],
    presets: { cells: {}, giraffe: { n: 25, gap: 1.2 }, pebbles: { n: 80, gap: 0.6 }, crackle: { n: 150, gap: 0.25 }, tiles: { jitter: 0.3, n: 36 } },
    gen: (p, W, H, rnd) => {
      const sites: [number, number][] = [];
      const g = Math.ceil(Math.sqrt(p.n * (W / H))), gh = Math.ceil(p.n / g);
      for (let j = 0; j < gh; j++) for (let i = 0; i < g; i++) sites.push([((i + 0.5 + (rnd() - 0.5) * p.jitter) / g) * W, ((j + 0.5 + (rnd() - 0.5) * p.jitter) / gh) * H]);
      const out: GenShape[] = [{ rings: [], c: 1 }, { rings: [], c: 2 }, { rings: [], c: 0 }];
      const box = rect(-1, -1, W + 1, H + 1);
      sites.forEach((_, i) => { const cell = voronoiCell(sites, i, box); if (cell.length >= 3) out[Math.floor(rnd() * 3)].rings.push(shrink(cell, p.gap / 2)); });
      return fit(W, H, out.filter((s) => s.c));
    },
  },
  {
    id: 'blobs', name: 'Blobs', category: 'Organic', tags: ['spots', 'camo', 'random'], colors: 3, seeded: true,
    params: [P('n', 'Count', 3, 80, 1, 18), P('size', 'Size (mm)', 1, 15, 0.5, 5), P('wobble', 'Wobble', 0, 0.6, 0.02, 0.3)],
    presets: { spots: {}, camo: { n: 30, size: 8, wobble: 0.45 }, leopard: { n: 50, size: 3, wobble: 0.35 }, bubbles: { wobble: 0.05, n: 40, size: 3 } },
    gen: (p, W, H, rnd) => {
      const out: GenShape[] = [{ rings: [], c: 1 }, { rings: [], c: 2 }];
      for (let k = 0; k < p.n; k++) {
        const nz = noise1(rnd, 7), cx = rnd() * W, cy = rnd() * H, r = p.size * (0.6 + rnd() * 0.8);
        out[k % 2].rings.push(polar(cx, cy, (a) => r * (1 + p.wobble * (nz((a / (2 * Math.PI)) * 7) * 2 - 1)), 64));
      }
      return fit(W, H, out);
    },
  },
  {
    id: 'topo', name: 'Topographic', category: 'Organic', tags: ['contour', 'map', 'rings'], colors: 2, seeded: true,
    params: [P('n', 'Lines', 3, 30, 1, 12), P('w', 'Line width (mm)', 0.3, 2, 0.1, 0.6), P('wobble', 'Wobble', 0, 0.8, 0.02, 0.35), P('peaks', 'Peaks', 1, 4, 1, 1)],
    presets: { hill: {}, ridges: { peaks: 3, n: 8 }, calm: { wobble: 0.1 }, dense: { n: 24, w: 0.4 } },
    gen: (p, W, H, rnd) => {
      const shapes: GenShape[] = [];
      for (let pk = 0; pk < p.peaks; pk++) {
        const cx = p.peaks === 1 ? W / 2 : rnd() * W, cy = p.peaks === 1 ? H / 2 : rnd() * H, nz = noise1(rnd, 9), R = Math.hypot(W, H) / (p.peaks === 1 ? 2 : 2.5);
        for (let k = 1; k <= p.n; k++) {
          const r = (R * k) / p.n, f = (a: number) => r * (1 + p.wobble * (nz((a / (2 * Math.PI)) * 9 + k * 0.15) - 0.5));
          shapes.push({ rings: [polar(cx, cy, (a) => f(a) + p.w / 2, 128), polar(cx, cy, (a) => f(a) - p.w / 2, 128)], c: 1, evenodd: true });
        }
      }
      return fit(W, H, shapes);
    },
  },
  {
    id: 'waves', name: 'Waves', category: 'Organic', tags: ['sea', 'sine', 'water'], colors: 2,
    params: [P('cell', 'Wave pitch (mm)', 1, 15, 0.5, 4), P('amp', 'Amplitude (mm)', 0, 8, 0.25, 1.5), P('len', 'Wavelength (mm)', 2, 40, 1, 10), P('duty', 'Band share', 0.1, 0.9, 0.05, 0.5), ROT],
    presets: { ocean: {}, ripple: { cell: 2, amp: 0.6, len: 5 }, swell: { amp: 4, len: 25, cell: 6 }, vertical: { rot: 90 } },
    gen: (p, W, H) => rotated(W, H, p.rot, (w, h) => {
      const rings: Ring[] = [];
      for (let y = -p.amp; y < h + p.amp; y += p.cell) {
        const lo: [number, number][] = [], hi: [number, number][] = [];
        for (let x = 0; x <= w; x += 0.5) { const s = p.amp * Math.sin((2 * Math.PI * x) / p.len); lo.push([x, y + s]); hi.push([x, y + s + p.cell * p.duty]); }
        rings.push([...lo, ...hi.reverse()]);
      }
      return [{ rings, c: 1 }];
    }),
  },
  {
    id: 'scatter', name: 'Scatter', category: 'Organic', tags: ['confetti', 'terrazzo', 'random'], colors: 3, seeded: true,
    params: [P('n', 'Count', 10, 600, 10, 150), P('size', 'Size (mm)', 0.3, 6, 0.1, 1.2), P('vary', 'Size variation', 0, 1, 0.05, 0.6), P('shape', 'Shape', 0, 7, 1, 0)],
    presets: { terrazzo: { shape: 6, vary: 0.8 }, confetti: { shape: 1 }, stardust: { shape: 3, size: 1, n: 120 }, speckle: { n: 500, size: 0.5 } },
    gen: (p, W, H, rnd) => {
      const out: GenShape[] = [{ rings: [], c: 1 }, { rings: [], c: 2 }];
      const base = unitShape(p.shape);
      for (let k = 0; k < p.n; k++) out[k % 2].rings.push(transform(base, rnd() * W, rnd() * H, rnd() * Math.PI * 2, p.size * (1 - p.vary + rnd() * p.vary * 2) / 2));
      return fit(W, H, out);
    },
  },
  {
    id: 'leaves', name: 'Leaves', category: 'Organic', tags: ['botanical', 'nature', 'random'], colors: 3, seeded: true,
    params: [P('n', 'Count', 5, 200, 5, 60), P('size', 'Leaf length (mm)', 1, 15, 0.5, 5), P('slim', 'Slimness', 0.2, 0.7, 0.02, 0.4)],
    presets: { foliage: {}, fern: { slim: 0.25, n: 120, size: 3 }, autumn: { size: 8, n: 30 } },
    gen: (p, W, H, rnd) => {
      const out: GenShape[] = [{ rings: [], c: 1 }, { rings: [], c: 2 }];
      const leaf = polar(0, 0, (a) => Math.abs(Math.cos(a)) ** 0.7, 48).map(([x, y]) => [x, y * p.slim] as [number, number]);
      for (let k = 0; k < p.n; k++) out[k % 2].rings.push(transform(leaf, rnd() * W, rnd() * H, rnd() * Math.PI, p.size / 2));
      return fit(W, H, out);
    },
  },
  {
    id: 'bubbles', name: 'Packed circles', category: 'Organic', tags: ['bubbles', 'foam', 'random'], colors: 3, seeded: true,
    params: [P('n', 'Attempts', 50, 1500, 50, 500), P('rmin', 'Smallest (mm)', 0.3, 4, 0.1, 0.6), P('rmax', 'Largest (mm)', 1, 15, 0.5, 5), GAP],
    presets: { foam: {}, big: { rmax: 10 }, fine: { rmax: 2, rmin: 0.4, n: 1200 } },
    gen: (p, W, H, rnd) => {
      const placed: [number, number, number][] = [];
      for (let k = 0; k < p.n; k++) {
        const x = rnd() * W, y = rnd() * H;
        let r = p.rmax;
        for (const [qx, qy, qr] of placed) r = Math.min(r, Math.hypot(x - qx, y - qy) - qr - p.gap);
        if (r >= p.rmin) placed.push([x, y, r]);
      }
      const out: GenShape[] = [{ rings: [], c: 1 }, { rings: [], c: 2 }];
      placed.forEach(([x, y, r], k) => out[k % 2].rings.push(circle(x, y, r)));
      return fit(W, H, out);
    },
  },

  // ---------------- Lines (scrawl / hand-drawn)
  {
    id: 'scribble', name: 'Scribble', category: 'Lines', tags: ['hand drawn', 'scrawl', 'random'], colors: 2, seeded: true,
    params: [P('n', 'Strokes', 1, 30, 1, 8), P('len', 'Stroke length (mm)', 5, 200, 5, 60), P('w', 'Pen width (mm)', 0.3, 3, 0.1, 0.8), P('curl', 'Curl', 0, 1, 0.05, 0.4)],
    presets: { doodle: {}, marker: { w: 2, n: 4 }, nest: { n: 20, curl: 0.8, len: 40 }, calm: { curl: 0.1 } },
    gen: (p, W, H, rnd) => {
      const rings: Ring[] = [];
      for (let k = 0; k < p.n; k++) {
        let x = rnd() * W, y = rnd() * H, a = rnd() * Math.PI * 2, da = 0;
        const pts: [number, number][] = [[x, y]];
        for (let s = 0; s < p.len / 0.5; s++) {
          da = da * 0.9 + (rnd() - 0.5) * p.curl * 0.6; a += da;
          x += Math.cos(a) * 0.5; y += Math.sin(a) * 0.5;
          if (x < 0 || x > W) a = Math.PI - a; if (y < 0 || y > H) a = -a;
          pts.push([Math.max(0, Math.min(W, x)), Math.max(0, Math.min(H, y))]);
        }
        // split into short pieces so the stroke outline never folds over itself
        for (let i = 0; i < pts.length - 1; i += 12) rings.push(stroke(pts.slice(i, i + 13), p.w));
      }
      return fit(W, H, [{ rings, c: 1 }]);
    },
  },
  {
    id: 'wavy-lines', name: 'Wavy lines', category: 'Lines', tags: ['lines', 'wave', 'hand drawn'], colors: 2, seeded: true,
    params: [P('cell', 'Line pitch (mm)', 1, 10, 0.25, 3), P('w', 'Line width (mm)', 0.3, 3, 0.1, 0.8), P('wobble', 'Wobble (mm)', 0, 4, 0.1, 1), P('len', 'Wavelength (mm)', 3, 40, 1, 12), ROT],
    presets: { flow: {}, tight: { cell: 1.5, w: 0.5 }, loose: { wobble: 2.5 }, diagonal: { rot: 45 } },
    gen: (p, W, H, rnd) => rotated(W, H, p.rot, (w, h) => {
      const rings: Ring[] = [];
      for (let y = 0; y < h; y += p.cell) {
        const nz = noise1(rnd, 16), pts: [number, number][] = [];
        for (let x = 0; x <= w; x += 0.5) pts.push([x, y + p.wobble * (Math.sin((2 * Math.PI * x) / p.len) * 0.6 + (nz(x / p.len) - 0.5))]);
        rings.push(stroke(pts, p.w));
      }
      return [{ rings, c: 1 }];
    }),
  },
  {
    id: 'hatch', name: 'Hatching', category: 'Lines', tags: ['hatch', 'engraving', 'lines'], colors: 2,
    params: [P('cell', 'Pitch (mm)', 0.6, 6, 0.1, 1.5), P('w', 'Line width (mm)', 0.3, 2, 0.1, 0.5), P('cross', 'Cross-hatch', 0, 1, 1, 0), ROT],
    presets: { hatch: { rot: 45 }, crosshatch: { rot: 45, cross: 1 }, fine: { cell: 0.9, w: 0.4, rot: 30 } },
    gen: (p, W, H) => {
      const lines = (rot: number) => rotated(W, H, rot, (w, h) => { const r: Ring[] = []; for (let x = 0; x < w; x += p.cell) r.push(rect(x, 0, x + p.w, h)); return [{ rings: r, c: 1 }]; });
      return p.cross ? [...lines(p.rot), ...lines(p.rot + 90)] : lines(p.rot);
    },
  },
  {
    id: 'maze', name: 'Maze (10 PRINT)', category: 'Lines', tags: ['maze', 'diagonal', 'random', 'retro'], colors: 2, seeded: true,
    params: [CELL, P('w', 'Line width (mm)', 0.3, 3, 0.1, 0.8)],
    presets: { classic: {}, bold: { w: 1.8 }, fine: { cell: 2.5, w: 0.5 } },
    gen: (p, W, H, rnd) => {
      const rings: Ring[] = [];
      grid(W, H, p.cell, p.cell, (_i, _j, x, y) => rings.push(rnd() < 0.5 ? stroke([[x, y], [x + p.cell, y + p.cell]], p.w) : stroke([[x + p.cell, y], [x, y + p.cell]], p.w)));
      return fit(W, H, [{ rings, c: 1 }]);
    },
  },
  {
    id: 'grid-maze', name: 'Labyrinth', category: 'Lines', tags: ['maze', 'labyrinth', 'random'], colors: 2, seeded: true,
    params: [CELL, P('w', 'Wall width (mm)', 0.3, 2, 0.1, 0.7)],
    presets: { classic: {}, large: { cell: 8 }, fine: { cell: 2.5, w: 0.5 } },
    gen: (p, W, H, rnd) => {
      // recursive-backtracker maze on a grid; draw the walls that remain
      const nx = Math.max(1, Math.floor(W / p.cell)), ny = Math.max(1, Math.floor(H / p.cell));
      const seen = new Uint8Array(nx * ny), right = new Uint8Array(nx * ny).fill(1), up = new Uint8Array(nx * ny).fill(1);
      const stack = [0]; seen[0] = 1;
      while (stack.length) {
        const c = stack[stack.length - 1], x = c % nx, y = Math.floor(c / nx);
        const n = [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]].filter(([a, b]) => a >= 0 && b >= 0 && a < nx && b < ny && !seen[b * nx + a]);
        if (!n.length) { stack.pop(); continue; }
        const [a, b] = n[Math.floor(rnd() * n.length)], d = b * nx + a;
        if (a > x) right[c] = 0; else if (a < x) right[d] = 0; else if (b > y) up[c] = 0; else up[d] = 0;
        seen[d] = 1; stack.push(d);
      }
      const rings: Ring[] = [], h = p.w / 2;
      for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
        const c = y * nx + x, X = x * p.cell, Y = y * p.cell;
        if (right[c]) rings.push(rect(X + p.cell - h, Y - h, X + p.cell + h, Y + p.cell + h));
        if (up[c]) rings.push(rect(X - h, Y + p.cell - h, X + p.cell + h, Y + p.cell + h));
      }
      rings.push(rect(-h, -h, nx * p.cell + h, h), rect(-h, -h, h, ny * p.cell + h));
      return fit(W, H, [{ rings, c: 1 }]);
    },
  },

  // ---------------- Ornament
  {
    id: 'greek-key', name: 'Greek key', category: 'Ornament', tags: ['meander', 'border', 'classic'], colors: 2,
    params: [CELL, P('w', 'Line width (share)', 0.1, 0.3, 0.01, 0.18), P('rows', 'Rows', 1, 10, 1, 4)],
    variants: { key: 'rows', values: [1, 2, 3, 4, 6] },
    presets: { border: { rows: 1, cell: 8 }, field: {}, fine: { cell: 4 } },
    gen: (p, W, H) => {
      const rings: Ring[] = [], c = p.cell, t = c * p.w;
      // one meander unit as a stroked path in a c × c cell
      const unit: [number, number][] = [[0, 0], [c, 0], [c, c * 0.8], [c * 0.2, c * 0.8], [c * 0.2, c * 0.4], [c * 0.6, c * 0.4]];
      const pitch = H / p.rows;
      for (let r = 0; r < p.rows; r++) for (let x = 0; x < W; x += c * 1.1) rings.push(stroke(unit.map(([a, b]) => [a + x, b + r * pitch + (pitch - c) / 2] as [number, number]), t));
      return fit(W, H, [{ rings, c: 1 }]);
    },
  },
  {
    id: 'scallops', name: 'Scallop border', category: 'Ornament', tags: ['border', 'lace', 'edge'], colors: 2,
    params: [CELL, P('rows', 'Rows', 1, 12, 1, 3), P('hole', 'Eyelets', 0, 1, 1, 1)],
    variants: { key: 'rows', values: [1, 2, 3, 4, 6, 8] },
    presets: { lace: {}, plain: { hole: 0 }, deep: { rows: 6, cell: 3 } },
    gen: (p, W, H) => {
      const shapes: GenShape[] = [], pitch = H / p.rows, r = p.cell / 2;
      for (let row = 0; row < p.rows; row++) for (let x = r; x < W + r; x += p.cell) {
        const y = row * pitch + pitch / 2, half: Ring = [];
        for (let t = 0; t <= 24; t++) { const a = Math.PI + (Math.PI * t) / 24; half.push([x + r * Math.cos(a), y + r * Math.sin(a)]); }
        shapes.push({ rings: p.hole ? [half, circle(x, y - r * 0.45, r * 0.22, 16)] : [half], c: 1, evenodd: true });
      }
      return fit(W, H, shapes);
    },
  },
  {
    id: 'damask', name: 'Damask motif', category: 'Ornament', tags: ['wallpaper', 'ornament', 'repeat'], colors: 2,
    params: [P('cell', 'Repeat (mm)', 4, 30, 1, 12), P('lobes', 'Lobes', 3, 9, 1, 5), P('depth', 'Lobe depth', 0.1, 0.7, 0.02, 0.35)],
    variants: { key: 'lobes', values: [3, 4, 5, 6, 7, 8] },
    presets: { classic: {}, ornate: { lobes: 8, depth: 0.5 }, small: { cell: 7 } },
    gen: (p, W, H) => {
      const rings: Ring[] = [];
      for (let j = 0, y = p.cell / 2; y < H + p.cell; j++, y += p.cell * 0.75) for (let x = (j % 2 ? p.cell / 2 : 0); x < W + p.cell; x += p.cell) {
        const r = p.cell * 0.32;
        // teardrop body with lobed outline, stretched vertically
        rings.push(polar(x, y, (a) => r * (1 - p.depth + p.depth * Math.abs(Math.cos((p.lobes * a) / 2))) * (1 + 0.35 * Math.sin(a)), 180).map(([px, py]) => [px, y + (py - y) * 1.3] as [number, number]));
      }
      return fit(W, H, [{ rings, c: 1 }]);
    },
  },
  // ---------------- Polygons (mathematically generated tilings and polygon sets)
  {
    id: 'polygon-grid', name: 'Regular polygons', category: 'Polygons', tags: ['polygon', 'grid', 'n-gon'], colors: 2,
    variants: { key: 'sides', values: [3, 4, 5, 6, 7, 8, 9, 10, 12, 16] },
    params: [CELL, P('sides', 'Sides', 3, 24, 1, 6), P('size', 'Size (share)', 0.2, 0.7, 0.01, 0.42), P('turn', 'Turn per cell (°)', 0, 45, 1, 0), P('offset', 'Offset rows', 0, 1, 1, 1)],
    presets: { grid: { offset: 0 }, offset: {}, twisting: { turn: 12 }, large: { size: 0.6 } },
    gen: (p, W, H) => {
      const rings: Ring[] = [];
      let k = 0;
      for (let j = 0, y = p.cell / 2; y < H + p.cell; j++, y += p.cell) for (let x = p.cell / 2 + (p.offset && j % 2 ? p.cell / 2 : 0); x < W + p.cell; x += p.cell, k++)
        rings.push(ngon(x, y, p.cell * p.size, p.sides, -Math.PI / 2 + k * p.turn * D2R));
      return fit(W, H, [{ rings, c: 1 }]);
    },
  },
  {
    id: 'polygon-tunnel', name: 'Polygon tunnel', category: 'Polygons', tags: ['polygon', 'nested', 'vortex', 'op art'], colors: 3,
    variants: { key: 'sides', values: [3, 4, 5, 6, 8, 12] },
    params: [P('sides', 'Sides', 3, 16, 1, 4), P('rings', 'Rings', 3, 40, 1, 14), P('twist', 'Twist per ring (°)', 0, 30, 0.5, 6), P('w', 'Line share', 0.1, 0.9, 0.05, 0.5), P('size', 'Size (share)', 0.3, 0.75, 0.01, 0.7)],
    presets: { vortex: {}, straight: { twist: 0 }, tight: { rings: 28, twist: 3 }, bold: { w: 0.8 } },
    gen: (p, W, H) => {
      const shapes: GenShape[] = [], R = Math.min(W, H) * p.size, cx = W / 2, cy = H / 2;
      for (let k = p.rings; k >= 1; k--) {
        const r0 = (R * k) / p.rings, r1 = (R * (k - p.w)) / p.rings, a = k * p.twist * D2R - Math.PI / 2;
        shapes.push({ rings: [ngon(cx, cy, r0, p.sides, a), ngon(cx, cy, Math.max(0.05, r1), p.sides, a)], c: 1 + (k % 2), evenodd: true });
      }
      return fit(W, H, shapes);
    },
  },
  {
    id: 'octagon-square', name: 'Octagons & squares (4.8.8)', category: 'Polygons', tags: ['archimedean', 'tiling', 'octagon'], colors: 3,
    params: [P('cell', 'Pitch (mm)', 2, 20, 0.5, 6), GAP],
    presets: { classic: {}, tight: { gap: 0.1 }, large: { cell: 12 } },
    gen: (p, W, H) => {
      // regular octagons on a square lattice; the leftover holes are squares rotated 45°
      const s = p.cell / (1 + Math.SQRT2), R = s / (2 * Math.sin(Math.PI / 8));
      const oct: Ring[] = [], sq: Ring[] = [];
      for (let y = 0; y < H + p.cell; y += p.cell) for (let x = 0; x < W + p.cell; x += p.cell) {
        oct.push(shrink(ngon(x, y, R, 8, Math.PI / 8), p.gap / 2));
        sq.push(shrink(ngon(x + p.cell / 2, y + p.cell / 2, s / Math.SQRT2, 4, 0), p.gap / 2));
      }
      return fit(W, H, [{ rings: oct, c: 1 }, { rings: sq, c: 2 }]);
    },
  },
  {
    id: 'trihexagonal', name: 'Trihexagonal (3.6.3.6)', category: 'Polygons', tags: ['archimedean', 'tiling', 'kagome', 'hexagon', 'triangle'], colors: 3,
    params: [P('cell', 'Hexagon side (mm)', 1, 12, 0.25, 3), GAP],
    presets: { kagome: {}, large: { cell: 6 }, open: { gap: 0.8 } },
    gen: (p, W, H) => {
      // hexagons meet at their corners on a triangular lattice of spacing 2s; the gaps are triangles
      const s = p.cell, d = 2 * s, dy = d * Math.sqrt(3) / 2, hex: Ring[] = [], tri: Ring[] = [];
      for (let j = -1, y = 0; y < H + d; j++, y += dy) for (let x = (j & 1) ? s : 0; x < W + d; x += d) {
        hex.push(shrink(ngon(x, y, s, 6, 0), p.gap / 2));
        tri.push(shrink([[x + s, y], [x + 2 * s, y], [x + 1.5 * s, y + dy / 2 * 1.0 / 1]].map(([a, b]) => [a, b] as [number, number]), p.gap / 2));
        tri.push(shrink([[x + s, y], [x + 1.5 * s, y - dy / 2], [x + 2 * s, y]], p.gap / 2));
      }
      return fit(W, H, [{ rings: hex, c: 1 }, { rings: tri, c: 2 }]);
    },
  },
  {
    id: 'truncated-hex', name: 'Dodecagons & triangles (3.12.12)', category: 'Polygons', tags: ['archimedean', 'tiling', 'dodecagon'], colors: 3,
    params: [P('cell', 'Pitch (mm)', 2, 20, 0.5, 6), GAP],
    presets: { classic: {}, large: { cell: 12 }, open: { gap: 0.6 } },
    gen: (p, W, H) => {
      // dodecagons share edges on a triangular lattice; each gap is a small triangle
      const d = p.cell, dy = d * Math.sqrt(3) / 2, R = d / 2 / Math.cos(Math.PI / 12), s = 2 * R * Math.sin(Math.PI / 12);
      const dod: Ring[] = [], tri: Ring[] = [];
      for (let j = -1, y = 0; y < H + d; j++, y += dy) for (let x = (j & 1) ? d / 2 : 0; x < W + d; x += d) {
        dod.push(shrink(ngon(x, y, R, 12, Math.PI / 12), p.gap / 2));
        const tr = s / Math.sqrt(3);
        tri.push(shrink(ngon(x + d / 2, y + dy / 3, tr, 3, Math.PI / 2), p.gap / 2), shrink(ngon(x + d / 2, y - dy / 3, tr, 3, -Math.PI / 2), p.gap / 2));
      }
      return fit(W, H, [{ rings: dod, c: 1 }, { rings: tri, c: 2 }]);
    },
  },
  {
    id: 'rhombille', name: 'Tumbling blocks (rhombille)', category: 'Polygons', tags: ['cubes', 'isometric', 'rhombus', '3d illusion'], colors: 4,
    params: [P('cell', 'Block size (mm)', 1.5, 20, 0.25, 5), GAP],
    presets: { classic: {}, large: { cell: 10 }, small: { cell: 2.5 } },
    gen: (p, W, H) => {
      // each hexagon split into three 120° rhombi, one per ink: the classic cube illusion
      const r = p.cell, dx = Math.sqrt(3) * r, dy = 1.5 * r, out: GenShape[] = [{ rings: [], c: 1 }, { rings: [], c: 2 }, { rings: [], c: 3 }];
      for (let j = -1, y = 0; y < H + r * 2; j++, y += dy) for (let x = (j & 1) ? dx / 2 : 0; x < W + dx; x += dx) {
        const v = (k: number): [number, number] => [x + r * Math.cos(Math.PI / 6 + (k * Math.PI) / 3), y + r * Math.sin(Math.PI / 6 + (k * Math.PI) / 3)];
        const c: [number, number] = [x, y];
        out[0].rings.push(shrink([c, v(0), v(1), v(2)], p.gap / 2));
        out[1].rings.push(shrink([c, v(2), v(3), v(4)], p.gap / 2));
        out[2].rings.push(shrink([c, v(4), v(5), v(0)], p.gap / 2));
      }
      return fit(W, H, out);
    },
  },
  {
    id: 'cairo', name: 'Cairo pentagons', category: 'Polygons', tags: ['pentagon', 'tiling', 'cairo'], colors: 3,
    params: [P('cell', 'Pitch (mm)', 2, 20, 0.5, 8), GAP],
    presets: { classic: {}, large: { cell: 14 }, open: { gap: 0.6 } },
    gen: (p, W, H) => {
      // four congruent pentagons per square cell around its centre (a = cell/4), alternating pairs rotated 90°
      const a = p.cell / 4, out: GenShape[] = [{ rings: [], c: 1 }, { rings: [], c: 2 }];
      const base: [number, number][] = [[0, 0], [a, -a * 0.6], [2 * a, 0], [2 * a, 2 * a * 0.0 + a * 1.4], [0, a * 1.4]];
      for (let j = 0, y = 0; y < H + p.cell; j++, y += p.cell) for (let i = 0, x = 0; x < W + p.cell; i++, x += p.cell) {
        for (let k = 0; k < 4; k++) {
          const rot = (k * Math.PI) / 2 + ((i + j) % 2 ? Math.PI / 4 : 0) * 0;
          const pent = transform(base.map(([u, v]) => [u - a, v - a * 1.6] as [number, number]), x + p.cell / 2, y + p.cell / 2, rot);
          out[k % 2].rings.push(shrink(pent, p.gap / 2));
        }
      }
      return fit(W, H, out);
    },
  },

  // ---------------- Math curves and fractals
  {
    id: 'superformula', name: 'Superformula', category: 'Math', tags: ['gielis', 'supershape', 'curve'], colors: 2,
    variants: { key: 'm', values: [3, 4, 5, 6, 7, 8, 10, 12] },
    params: [P('m', 'Symmetry m', 1, 24, 1, 6), P('n1', 'n1', 0.2, 12, 0.1, 1), P('n2', 'n2', 0.2, 12, 0.1, 1.7), P('n3', 'n3', 0.2, 12, 0.1, 1.7), P('size', 'Size (share)', 0.2, 0.5, 0.01, 0.45), P('tile', 'Tile (0 = single)', 0, 6, 1, 0)],
    presets: { flower: {}, star: { n1: 0.3, n2: 0.3, n3: 0.3 }, rounded: { n1: 2, n2: 4, n3: 4 }, spiky: { n1: 0.5, n2: 1, n3: 2.5 }, tiled: { tile: 4 } },
    gen: (p, W, H) => {
      const sf = (a: number) => {
        const t = (p.m * a) / 4;
        const v = Math.abs(Math.cos(t)) ** p.n2 + Math.abs(Math.sin(t)) ** p.n3;
        return v === 0 ? 1 : v ** (-1 / p.n1);
      };
      const samples = Array.from({ length: 720 }, (_, k) => sf((2 * Math.PI * k) / 720));
      const mx = Math.max(...samples.filter(Number.isFinite));
      const rings: Ring[] = [];
      const n = p.tile || 1, cw = W / n, ch = H / n;
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        const R = Math.min(cw, ch) * p.size;
        rings.push(polar(cx(i, cw), cx(j, ch), (a) => (R * sf(a)) / mx, 720));
      }
      return fit(W, H, [{ rings, c: 1, evenodd: true }]);
    },
  },
  {
    id: 'rose', name: 'Rose curves', category: 'Math', tags: ['rhodonea', 'petals', 'curve'], colors: 2,
    variants: { key: 'k', values: [2, 3, 4, 5, 6, 7, 8] },
    params: [P('k', 'Petal number k', 1, 12, 1, 5), P('d', 'Denominator d', 1, 7, 1, 1), P('w', 'Line width (mm, 0 = filled)', 0, 3, 0.1, 0), P('size', 'Size (share)', 0.2, 0.5, 0.01, 0.46)],
    presets: { filled: {}, outline: { w: 0.8 }, nested: { d: 3, w: 0.6 }, wide: { d: 2, w: 0.6 } },
    gen: (p, W, H) => {
      // r = cos(k/d · θ), closed after π·d (odd k·d) or 2π·d
      const k = p.k / p.d, R = Math.min(W, H) * p.size, T = Math.PI * p.d * ((p.k * p.d) % 2 ? 1 : 2), cxx = W / 2, cyy = H / 2;
      const pts: [number, number][] = [];
      for (let t = 0; t <= T; t += T / 1600) { const r = R * Math.cos(k * t); pts.push([cxx + r * Math.cos(t), cyy + r * Math.sin(t)]); }
      if (p.w <= 0) return fit(W, H, [{ rings: [pts], c: 1, evenodd: true }]);
      const rings: Ring[] = [];
      for (let i = 0; i < pts.length - 1; i += 20) rings.push(stroke(pts.slice(i, i + 21), p.w));
      return fit(W, H, [{ rings, c: 1 }]);
    },
  },
  {
    id: 'spirograph', name: 'Spirograph', category: 'Math', tags: ['hypotrochoid', 'epitrochoid', 'guilloche', 'curve'], colors: 2,
    variants: { key: 'r', values: [3, 5, 7, 9, 11, 13] },
    params: [P('R', 'Ring teeth R', 10, 40, 1, 24), P('r', 'Wheel teeth r', 1, 30, 1, 7), P('d', 'Pen offset', 0.1, 1.5, 0.05, 0.8), P('epi', 'Outside (epitrochoid)', 0, 1, 1, 0), P('w', 'Line width (mm)', 0.2, 2, 0.05, 0.5), P('size', 'Size (share)', 0.2, 0.5, 0.01, 0.46)],
    presets: { classic: {}, guilloche: { R: 36, d: 1.2, w: 0.3 }, epicycle: { epi: 1 }, bold: { w: 1.2 } },
    gen: (p, W, H) => {
      const g = (a: number, b: number): number => (b ? g(b, a % b) : a);
      const R = p.R, r = p.r, d = p.d * r, turns = r / g(R, r), s = p.epi ? 1 : -1;
      const pts: [number, number][] = [];
      let mx = 0;
      for (let t = 0; t <= 2 * Math.PI * turns; t += 0.01) {
        const x = (R - s * -r) * 0 + (p.epi ? (R + r) * Math.cos(t) - d * Math.cos(((R + r) / r) * t) : (R - r) * Math.cos(t) + d * Math.cos(((R - r) / r) * t));
        const y = p.epi ? (R + r) * Math.sin(t) - d * Math.sin(((R + r) / r) * t) : (R - r) * Math.sin(t) - d * Math.sin(((R - r) / r) * t);
        pts.push([x, y]); mx = Math.max(mx, Math.hypot(x, y));
      }
      const k = (Math.min(W, H) * p.size) / (mx || 1);
      const sc = pts.map(([x, y]) => [W / 2 + x * k, H / 2 + y * k] as [number, number]);
      const rings: Ring[] = [];
      for (let i = 0; i < sc.length - 1; i += 16) rings.push(stroke(sc.slice(i, i + 17), p.w));
      return fit(W, H, [{ rings, c: 1 }]);
    },
  },
  {
    id: 'lissajous', name: 'Lissajous', category: 'Math', tags: ['harmonic', 'oscillator', 'curve'], colors: 2,
    variants: { key: 'a', values: [1, 2, 3, 4, 5] },
    params: [P('a', 'Frequency X', 1, 9, 1, 3), P('b', 'Frequency Y', 1, 9, 1, 4), P('phase', 'Phase (°)', 0, 180, 1, 90), P('w', 'Line width (mm)', 0.2, 3, 0.05, 0.8)],
    presets: { classic: {}, knot: { b: 2 }, fine: { a: 5, b: 6, w: 0.4 } },
    gen: (p, W, H) => {
      const pts: [number, number][] = [];
      for (let t = 0; t <= 2 * Math.PI + 1e-9; t += 0.004) pts.push([W / 2 + (W * 0.46) * Math.sin(p.a * t + p.phase * D2R), H / 2 + (H * 0.46) * Math.sin(p.b * t)]);
      const rings: Ring[] = [];
      for (let i = 0; i < pts.length - 1; i += 16) rings.push(stroke(pts.slice(i, i + 17), p.w));
      return fit(W, H, [{ rings, c: 1 }]);
    },
  },
  {
    id: 'phyllotaxis', name: 'Phyllotaxis (golden angle)', category: 'Math', tags: ['sunflower', 'fibonacci', 'golden ratio', 'dots'], colors: 3,
    params: [P('n', 'Seeds', 50, 2000, 10, 500), P('size', 'Seed size', 0.2, 1, 0.02, 0.6), P('angle', 'Divergence (°)', 130, 145, 0.01, 137.51), P('grow', 'Grow outward', 0, 1, 0.05, 0.5), P('shape', 'Seed shape', 0, 7, 1, 0)],
    presets: { sunflower: {}, dense: { n: 1500, size: 0.5 }, spiral: { angle: 137.3 }, hex: { shape: 6 } },
    gen: (p, W, H) => {
      const R = Math.min(W, H) * 0.48, c = R / Math.sqrt(p.n), out: GenShape[] = [{ rings: [], c: 1 }, { rings: [], c: 2 }];
      const base = unitShape(p.shape);
      for (let i = 1; i <= p.n; i++) {
        const r = c * Math.sqrt(i), a = i * p.angle * D2R, s = c * p.size * (1 - p.grow + p.grow * (r / R) * 1.5);
        out[i % 13 < 8 ? 0 : 1].rings.push(transform(base, W / 2 + r * Math.cos(a), H / 2 + r * Math.sin(a), a, s / 2 + 0.05));
      }
      return fit(W, H, out);
    },
  },
  {
    id: 'sierpinski', name: 'Sierpinski triangle', category: 'Math', tags: ['fractal', 'triangle', 'self-similar'], colors: 2,
    variants: { key: 'depth', values: [2, 3, 4, 5, 6] },
    params: [P('depth', 'Depth', 0, 7, 1, 4), GAP],
    presets: { classic: {}, gapped: { gap: 0.3 } },
    gen: (p, W, H) => {
      const rings: Ring[] = [];
      const sub = (a: [number, number], b: [number, number], c: [number, number], d: number) => {
        if (!d) { rings.push(shrink([a, b, c], p.gap)); return; }
        const m = (u: [number, number], v: [number, number]): [number, number] => [(u[0] + v[0]) / 2, (u[1] + v[1]) / 2];
        sub(a, m(a, b), m(a, c), d - 1); sub(m(a, b), b, m(b, c), d - 1); sub(m(a, c), m(b, c), c, d - 1);
      };
      const s = Math.min(W, H / 0.866);
      sub([(W - s) / 2, (H - s * 0.866) / 2], [(W + s) / 2, (H - s * 0.866) / 2], [W / 2, (H + s * 0.866) / 2], p.depth);
      return fit(W, H, [{ rings, c: 1 }]);
    },
  },
  {
    id: 'carpet', name: 'Sierpinski carpet', category: 'Math', tags: ['fractal', 'square', 'self-similar'], colors: 2,
    variants: { key: 'depth', values: [1, 2, 3, 4] },
    params: [P('depth', 'Depth', 1, 5, 1, 3)],
    presets: { classic: {} },
    gen: (p, W, H) => {
      // holes of a Menger-sponge face: removed squares are the inked region
      const rings: Ring[] = [];
      const go = (x: number, y: number, w: number, h: number, d: number) => {
        if (!d) return;
        const tw = w / 3, th = h / 3;
        rings.push(rect(x + tw, y + th, x + 2 * tw, y + 2 * th));
        for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) if (i !== 1 || j !== 1) go(x + i * tw, y + j * th, tw, th, d - 1);
      };
      go(0, 0, W, H, p.depth);
      return fit(W, H, [{ rings, c: 1 }]);
    },
  },
  {
    id: 'koch', name: 'Koch snowflake', category: 'Math', tags: ['fractal', 'snowflake', 'winter'], colors: 2,
    variants: { key: 'depth', values: [1, 2, 3, 4, 5] },
    params: [P('depth', 'Depth', 0, 6, 1, 3), P('size', 'Size (share)', 0.2, 0.5, 0.01, 0.42), P('tile', 'Tile (0 = single)', 0, 6, 1, 0)],
    presets: { single: {}, tiled: { tile: 3, depth: 3 } },
    gen: (p, W, H) => {
      const flake = (cxx: number, cyy: number, R: number): Ring => {
        let pts: [number, number][] = ngon(cxx, cyy, R, 3, Math.PI / 2);
        for (let d = 0; d < p.depth; d++) {
          const next: [number, number][] = [];
          for (let i = 0; i < pts.length; i++) {
            const a = pts[i], b = pts[(i + 1) % pts.length], dx = (b[0] - a[0]) / 3, dy = (b[1] - a[1]) / 3;
            const p1: [number, number] = [a[0] + dx, a[1] + dy], p2: [number, number] = [a[0] + 2 * dx, a[1] + 2 * dy];
            const peak: [number, number] = [p1[0] + dx * 0.5 + dy * 0.866, p1[1] + dy * 0.5 - dx * 0.866];
            next.push(a, p1, peak, p2);
          }
          pts = next;
        }
        return pts;
      };
      const n = p.tile || 1, cw = W / n, ch = H / n, rings: Ring[] = [];
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) rings.push(flake(cx(i, cw), cx(j, ch), Math.min(cw, ch) * p.size));
      return fit(W, H, [{ rings, c: 1 }]);
    },
  },
  {
    id: 'hilbert', name: 'Hilbert curve', category: 'Math', tags: ['space-filling', 'fractal', 'maze'], colors: 2,
    variants: { key: 'order', values: [2, 3, 4, 5] },
    params: [P('order', 'Order', 1, 6, 1, 4), P('w', 'Line share', 0.15, 0.8, 0.05, 0.4)],
    presets: { classic: {} },
    gen: (p, W, H) => {
      const n = 2 ** p.order, pts: [number, number][] = [];
      for (let i = 0; i < n * n; i++) {
        // standard d → (x, y)
        let x = 0, y = 0, t = i;
        for (let s = 1; s < n; s *= 2) {
          const rx = 1 & (t / 2), ry = 1 & (t ^ rx);
          if (ry === 0) { if (rx === 1) { x = s - 1 - x; y = s - 1 - y; } [x, y] = [y, x]; }
          x += s * rx; y += s * ry; t = Math.floor(t / 4);
        }
        pts.push([((x + 0.5) / n) * W, ((y + 0.5) / n) * H]);
      }
      const w = (Math.min(W, H) / n) * p.w, rings: Ring[] = [];
      for (let i = 0; i < pts.length - 1; i++) rings.push(stroke([pts[i], pts[i + 1]], w), ngon(pts[i][0], pts[i][1], w / Math.SQRT2, 4, Math.PI / 4));
      return fit(W, H, [{ rings, c: 1 }]);
    },
  },
  {
    id: 'moire', name: 'Moiré rings', category: 'Math', tags: ['interference', 'op art', 'circles'], colors: 3,
    params: [P('cell', 'Ring pitch (mm)', 0.8, 6, 0.1, 2), P('shift', 'Centre offset (share)', 0, 0.5, 0.01, 0.15)],
    presets: { classic: {}, wide: { shift: 0.35 }, fine: { cell: 1.2 } },
    gen: (p, W, H) => {
      const shapes: GenShape[] = [], R = Math.hypot(W, H);
      for (const [k, ox] of [[1, -p.shift], [2, p.shift]] as const) {
        const cxx = W / 2 + ox * W;
        for (let r = p.cell; r < R; r += p.cell * 2) shapes.push({ rings: [circle(cxx, H / 2, r + p.cell / 2, 96), circle(cxx, H / 2, r, 96)], c: k, evenodd: true });
      }
      return fit(W, H, shapes);
    },
  },

];

export const familyById = (id: string) => FAMILIES.find((f) => f.id === id);
export const defaults = (f: Family) => Object.fromEntries(f.params.map((d) => [d.key, d.def]));
