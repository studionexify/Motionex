// Relief pattern library: traditional surface patterns from around the world plus modern and textile
// textures, each a height field h(u, v) in 0..1 (1 = raised). u runs round the piece (one unit per
// repeat), v runs up in the same units (square cells, stretched by the "cell height" setting).
// Original implementations of public-domain motifs; no artwork is copied.

export type Field = (u: number, v: number, seed: number) => number;
export interface Pattern { id: string; name: string; group: string; count: number; depth: number; fn: Field; noise?: boolean }

const TAU = Math.PI * 2;
const fr = (x: number) => x - Math.floor(x);
const cl = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x));
/** Edge softness (0 knife-sharp … 1 round), set per relief before evaluating. Edges stay a hair wide so the slicer path is continuous. */
let EDGE = 0.15;
export const setEdge = (e: number) => { EDGE = Math.min(1, Math.max(0, e)); };
/** Step from 0 to 1 centred between a and b; its width shrinks with EDGE so shapes keep exact positions but crisp sides. */
const ss = (a: number, b: number, x: number) => { const m = (a + b) / 2, hw = Math.max(0.004, Math.abs(b - a) / 2 * EDGE * 2) * Math.sign(b - a || 1); const t = cl((x - (m - hw)) / (2 * hw)); return t * t * (3 - 2 * t); };
const tri = (x: number) => 1 - Math.abs(2 * fr(x) - 1);            // 0..1..0
/** Narrowest printable line, in pattern-cell units (set per piece: about 1 mm on the real surface). */
let MINW = 0;
export const setMinLine = (w: number) => { MINW = Math.max(0, w); };
/** Ridge of width w centred on d = 0: flat top, crisp bevelled sides; never thinner than MINW. */
const line = (d: number, w0: number) => lineW(d, Math.max(w0, MINW));
const lineW = (d: number, w: number) => 1 - ss(w * 0.5, w * 0.5 + Math.max(0.01, w * 0.5), Math.abs(d));
const hash2 = (x: number, y: number, s: number) => { const h = Math.sin(x * 127.1 + y * 311.7 + s * 17.3) * 43758.5453; return h - Math.floor(h); };
function noise2(x: number, y: number, s: number) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi, s), b = hash2(xi + 1, yi, s), c = hash2(xi, yi + 1, s), d = hash2(xi + 1, yi + 1, s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
const fbm = (x: number, y: number, s: number, o = 4) => { let a = 0, w = 0.5, f = 1; for (let i = 0; i < o; i++) { a += w * noise2(x * f, y * f, s + i); w *= 0.5; f *= 2; } return a / (1 - 0.5 ** o); };
/** Voronoi: distance to nearest and second nearest feature point, and the cell id. */
function voro(x: number, y: number, s: number, jit = 0.85) {
  const xi = Math.floor(x), yi = Math.floor(y); let d1 = 9, d2 = 9, id = 0;
  for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
    const cx = xi + i, cy = yi + j, px = cx + 0.5 + (hash2(cx, cy, s) - 0.5) * jit, py = cy + 0.5 + (hash2(cy, cx, s + 3) - 0.5) * jit;
    const d = Math.hypot(x - px, y - py);
    if (d < d1) { d2 = d1; d1 = d; id = hash2(cx, cy, s + 9); } else if (d < d2) d2 = d;
  }
  return { d1, d2, id };
}
/** Exact hexagonal tiling (pointy-top, neighbouring centres 1 apart). hd: hex distance from the cell centre,
 *  0 at the centre … 0.5 on the cell edge; cx, cy the centre; dx, dy the offset from it. */
function hex(x: number, y: number) {
  const r3 = Math.sqrt(3), ay = y / r3;
  const c1x = Math.round(x), c1y = Math.round(ay) * r3;
  const c2x = Math.floor(x) + 0.5, c2y = (Math.floor(ay) + 0.5) * r3;
  const d1 = (x - c1x) ** 2 + (y - c1y) ** 2, d2 = (x - c2x) ** 2 + (y - c2y) ** 2;
  const cx = d1 <= d2 ? c1x : c2x, cy = d1 <= d2 ? c1y : c2y;
  const dx = x - cx, dy = y - cy, ax = Math.abs(dx), ay2 = Math.abs(dy);
  return { hd: Math.max(ax, ax * 0.5 + ay2 * (r3 / 2)), cx, cy, dx, dy };
}
/** Exact distance from a point to the nearest of n straight lines through the centre (every π/n). */
const radial = (x: number, y: number, n: number) => { const step = Math.PI / n, a = Math.atan2(y, x); return Math.hypot(x, y) * Math.abs(Math.sin(a - Math.round(a / step) * step)); };
const circ = (x: number, y: number) => Math.hypot(x, y);
const local = (u: number, v: number) => [fr(u) - 0.5, fr(v) - 0.5];

const P = (group: string, list: [string, string, number, number, Field, boolean?][]): Pattern[] =>
  list.map(([id, name, count, depth, fn, noise]) => ({ id, name, group, count, depth, fn, noise }));

export const PATTERNS: Pattern[] = [
  ...P('Japan', [
    ['seigaiha', 'Seigaiha waves', 14, 1.2, (u, v) => { const row = Math.floor(v * 2); const x = u + (row % 2) * 0.5, y = v * 2; let best = 0; for (const dy of [0, 1]) { const cy = Math.floor(y) + dy, cx = Math.round(x - ((cy % 2 + 2) % 2) * 0.5) + ((cy % 2 + 2) % 2) * 0.5; const r = circ(x - cx, (y - cy) * 0.5) * 2; if (y - cy <= 0.05) best = Math.max(best, r < 1 ? 0.35 + 0.65 * tri(r * 3) : 0); } return best; }],
    ['asanoha', 'Asanoha hemp leaf', 12, 1, (u, v) => { const h = hex(u, v); const a = Math.atan2(h.dy, h.dx); const sp = radial(h.dx, h.dy, 3); const s6 = radial(h.dx, h.dy, 6); return Math.max(line(sp, 0.06), line(s6, 0.05), line(0.5 - h.hd, 0.08)); }],
    ['kikko', 'Kikkō tortoise shell', 12, 1.2, (u, v) => { const h = hex(u, v); return ss(0.38, 0.46, 0.5 - Math.abs(0.5 - h.hd) + 0.0) * 0 + (1 - ss(0.36, 0.48, h.hd)) * 0.8 + line(0.5 - h.hd, 0.05) * 0.2; }],
    ['shippo', 'Shippō circles', 12, 1, (u, v) => { const [x, y] = local(u, v); const r1 = circ(x, y), r2 = circ(fr(u) - (fr(u) > 0.5 ? 1 : 0), fr(v) - (fr(v) > 0.5 ? 1 : 0)); return Math.max(line(r1 - 0.5 / Math.SQRT2 * 1.0, 0.07), line(r2 - 0.5, 0.07)); }],
    ['yagasuri', 'Yagasuri arrows', 16, 1, (u, v) => { const col = Math.floor(u); const y = fr(v + (col % 2) * 0.5); const x = fr(u) - 0.5; return cl(1 - Math.abs(y - 0.5 - Math.abs(x) * 0.8) * 4) * (Math.abs(x) < 0.45 ? 1 : 0); }],
    ['uroko', 'Uroko triangles', 16, 1, (u, v) => { const y = fr(v), x = fr(u + Math.floor(v) * 0.5); return 1 - y < 1 - Math.abs(2 * x - 1) ? 1 : 0.15; }],
    ['kagome', 'Kagome basket', 14, 1, (u, v) => { const r3 = Math.sqrt(3); const a = line(fr(v * r3 / 1.5) - 0.5, 0.12), b = line(fr((u + v / r3) ) - 0.5, 0.1), c = line(fr((u - v / r3)) - 0.5, 0.1); return Math.max(a, b, c); }],
    ['sayagata', 'Sayagata lattice', 14, 1, (u, v) => { const x = fr(u) * 4, y = fr(v) * 4; const xi = Math.floor(x), yi = Math.floor(y); const on = (xi === 1 || yi === 1 || (xi === 3 && yi < 2) || (yi === 3 && xi > 1)) ? 1 : 0; return 0.15 + on * 0.85; }],
    ['ichimatsu', 'Ichimatsu checks', 20, 0.8, (u, v) => ((Math.floor(u) + Math.floor(v)) % 2 === 0 ? 1 : 0)],
    ['tatewaku', 'Tatewaku rising steam', 10, 1.4, (u, v) => { const x = fr(u) - 0.5; const w = 0.18 * Math.sin(v * TAU); return line(Math.abs(x) - 0.25 - w, 0.12); }],
    ['samekomon', 'Same-komon dots', 40, 0.5, (u, v) => { const [x, y] = local(u * 2, v * 2); return 1 - ss(0.12, 0.2, circ(x, y)); }],
    ['igeta', 'Igeta well-crib', 14, 1, (u, v) => { const [x, y] = local(u, v); return Math.max(line(Math.abs(x) - 0.18, 0.1), line(Math.abs(y) - 0.18, 0.1)) * (Math.max(Math.abs(x), Math.abs(y)) < 0.42 ? 1 : 0); }],
  ]),
  ...P('China', [
    ['huiwen', 'Huiwen fret', 12, 1.2, (u, v) => { const x = fr(u) * 5, y = fr(v) * 5; const xi = Math.floor(x), yi = Math.floor(y); const ring = Math.min(xi, yi, 4 - xi, 4 - yi); const gap = (ring === 0 && yi === 4 && xi === 4) || (ring === 1 && xi === 3 && yi === 2); return (ring % 2 === 0 && !gap) || (xi === 2 && yi === 2) ? 1 : 0.1; }],
    ['ruyi', 'Ruyi clouds', 10, 1.2, (u, v) => { const row = Math.floor(v); const x = fr(u + row * 0.5) - 0.5, y = fr(v) - 0.35; const c = Math.min(circ(x, y) - 0.22, circ(x - 0.22, y + 0.12) - 0.14, circ(x + 0.22, y + 0.12) - 0.14); return line(c, 0.07) + (c < 0 ? 0.3 : 0); }],
    ['coins', 'Linked coins', 12, 1, (u, v) => { const [x, y] = local(u, v); const r = circ(x, y); const sq = Math.max(Math.abs(x), Math.abs(y)); return Math.max(line(r - 0.42, 0.08), line(circ(fr(u) - Math.round(fr(u)), fr(v) - Math.round(fr(v))) - 0.42, 0.08)) * (sq < 0.08 ? 0 : 1); }],
    ['icecrack', 'Ice-crack lattice', 10, 1, (u, v, s) => { const q = voro(u, v, s, 1); return 1 - line(q.d2 - q.d1, 0.06) * 0.85; }, true],
    ['bamboo', 'Bamboo canes', 12, 1.2, (u, v) => { const x = fr(u) - 0.5; const node = line(fr(v * 0.5 + (Math.floor(u) % 3) * 0.33) - 0.5, 0.06); return Math.sqrt(cl(1 - (2 * x) ** 2)) * 0.85 + node * 0.25; }],
    ['wanzi', 'Wanzi key lattice', 10, 1, (u, v) => { const x = fr(u) * 6, y = fr(v) * 6; const xi = Math.floor(x), yi = Math.floor(y); const on = xi === 3 || yi === 3 || (yi === 0 && xi >= 3) || (xi === 0 && yi <= 3) || (yi === 5 && xi <= 3) || (xi === 5 && yi >= 3); return on ? 1 : 0.1; }],
  ]),
  ...P('Islamic & Moorish', [
    ['khatam', 'Eight-point star (khatam)', 10, 1.2, (u, v) => { const [x, y] = local(u, v); const a = Math.max(Math.abs(x), Math.abs(y)), b = (Math.abs(x) + Math.abs(y)) / Math.SQRT2; const st = Math.min(a, b); return Math.max(1 - ss(0.3, 0.33, st), line(st - 0.4, 0.05)); }],
    ['zellige', 'Zellige stars & crosses', 10, 1, (u, v) => { const [x, y] = local(u, v); const st = Math.min(Math.max(Math.abs(x), Math.abs(y)), (Math.abs(x) + Math.abs(y)) / Math.SQRT2); return Math.max(line(st - 0.3, 0.06), line(Math.max(Math.abs(x), Math.abs(y)) - 0.48, 0.05)) + (st < 0.3 ? 0.35 : 0); }],
    ['girih', 'Girih ten-fold', 8, 1.2, (u, v) => { const [x, y] = local(u, v); const a = Math.atan2(y, x), r = circ(x, y); const star = r * Math.cos(((a % (TAU / 10)) + TAU) % (TAU / 10) - TAU / 20); return Math.max(line(star - 0.32, 0.05), line(radial(x, y, 5), 0.04) * (r < 0.32 ? 1 : 0), line(Math.max(Math.abs(x), Math.abs(y)) - 0.5, 0.05)); }],
    ['mashrabiya', 'Mashrabiya screen', 14, 1.2, (u, v) => { const [x, y] = local(u, v); const d = Math.min(Math.abs(Math.abs(x) - Math.abs(y)), Math.abs(x), Math.abs(y)); return Math.max(line(d, 0.12), 1 - ss(0.1, 0.16, circ(x, y))); }],
    ['trellis', 'Moroccan trellis', 10, 1.2, (u, v) => { const x = fr(u) - 0.5, y = fr(v * 0.8) - 0.5; const lobe = Math.min(circ(Math.abs(x) - 0.5, y) , circ(x, Math.abs(y) - 0.5)); return line(lobe - 0.35, 0.08); }],
    ['muqarnas', 'Muqarnas cells', 12, 1.6, (u, v) => { const row = Math.floor(v); const x = fr(u + row * 0.5) - 0.5, y = fr(v); return cl(Math.sqrt(cl(1 - (2 * x) ** 2)) * (0.3 + 0.7 * y)); }],
    ['arabesque', 'Arabesque vine', 8, 1, (u, v) => { const x = fr(u), y = fr(v); const s = 0.5 + 0.32 * Math.sin(y * TAU); const c = circ(x - s - 0.15 * Math.cos(y * TAU), (fr(y * 2) - 0.5) * 0.5); return Math.max(line(x - s, 0.08), line(c - 0.12, 0.06)); }],
  ]),
  ...P('Greek & Roman', [
    ['meander', 'Greek meander', 10, 1.2, (u, v) => { const x = fr(u) * 4, y = fr(v * 0.5) * 4; const xi = Math.floor(x), yi = Math.floor(y); const on = yi === 0 || (xi === 3 && yi <= 3) || (yi === 3 && xi >= 1) || (xi === 1 && yi >= 1 && yi <= 3) || (yi === 1 && xi === 2); return on ? 1 : 0.1; }],
    ['eggdart', 'Egg and dart', 14, 1.4, (u, v) => { const x = fr(u) - 0.5, y = fr(v) - 0.5; const egg = 1 - ss(0.75, 1, circ(x / 0.3, y / 0.42)); const dart = Math.abs(x + 0.5 - 0.5) > 0.45 ? 0.9 * (1 - Math.abs(y) * 2) : 0; return Math.max(egg, dart); }],
    ['doric', 'Doric fluting', 20, 1.6, (u) => { const x = fr(u) - 0.5; return 1 - Math.sqrt(cl(1 - (2 * x / 0.9) ** 2)); }],
    ['vitruvian', 'Vitruvian scroll', 8, 1.2, (u, v) => { const x = fr(u), y = fr(v * 0.6); const a = Math.atan2(y - 0.5, x - 0.5), r = circ(x - 0.5, y - 0.5); const sp = fr(r * 4 - a / TAU); return y < 0.25 ? 0.9 : line(sp - 0.5, 0.25) * (r < 0.45 ? 1 : 0); }],
    ['rinceau', 'Acanthus rinceau', 8, 1.2, (u, v) => { const y = fr(v); const s = 0.5 + 0.3 * Math.sin(u * TAU); const leaf = 1 - ss(0.3, 0.5, Math.abs(y - s) / (0.25 + 0.2 * Math.abs(Math.cos(u * TAU * 2)))); return leaf; }],
    ['opus', 'Opus reticulatum', 14, 1, (u, v) => { const x = fr(u + v), y = fr(u - v); return 1 - Math.max(line(x, 0.12), line(y, 0.12), line(x - 1, 0.12), line(y - 1, 0.12)); }],
  ]),
  ...P('Celtic & Nordic', [
    ['knot', 'Celtic knot band', 8, 1.2, (u, v) => { const x = fr(u), y = fr(v); const a = line(y - 0.5 - 0.35 * Math.sin(x * TAU), 0.15), b = line(y - 0.5 + 0.35 * Math.sin(x * TAU), 0.15); const over = Math.sin(x * TAU * 2) > 0; return Math.max(a * (over ? 1 : 0.6), b * (over ? 0.6 : 1)); }],
    ['triskele', 'Spiral triskele', 8, 1, (u, v) => { const [x, y] = local(u, v); const a = Math.atan2(y, x), r = circ(x, y); return r < 0.48 ? line(fr(r * 5 - a * 3 / TAU) - 0.5, 0.3) : 0.1; }],
    ['cable', 'Cable knit', 8, 1.6, (u, v) => { const x = fr(u) - 0.5, y = fr(v * 0.7); const twist = Math.sin(y * TAU) * 0.18; const a = line(x - twist, 0.22), b = line(x + twist, 0.22); return Math.max(a * (fr(y) < 0.5 ? 1 : 0.7), b * (fr(y) < 0.5 ? 0.7 : 1), line(Math.abs(x) - 0.47, 0.06) * 0.6); }],
    ['herringbone', 'Herringbone', 16, 1, (u, v) => { const col = Math.floor(u); const x = fr(u), y = fr(v * 2 + (col % 2 ? x : -x)); return line(y - 0.5, 0.5); }],
    ['selbu', 'Selbu star', 8, 1, (u, v) => { const [x, y] = local(u, v); const ax = Math.abs(x), ay = Math.abs(y); const petal = (ax < 0.12 && ay < 0.45) || (ay < 0.12 && ax < 0.45) || (Math.abs(ax - ay) < 0.08 && ax < 0.3); return petal ? 1 : 0.15; }],
    ['runes', 'Runic staves', 14, 1, (u, v, s) => { const x = fr(u), y = fr(v); const k = Math.floor(hash2(Math.floor(u), Math.floor(v), s) * 4); const stem = line(x - 0.5, 0.12); const br = k === 0 ? line(y - 0.7 - (x - 0.5), 0.1) : k === 1 ? line(y - 0.3 + (x - 0.5), 0.1) : k === 2 ? line(y - 0.5 - Math.abs(x - 0.5), 0.1) : 0; return Math.max(stem, br * (Math.abs(x - 0.5) < 0.3 ? 1 : 0)) * (y > 0.1 && y < 0.9 ? 1 : 0); }, true],
  ]),
  ...P('Africa', [
    ['kente', 'Kente strips', 8, 0.8, (u, v) => { const x = fr(u), y = fr(v * 2); const strip = Math.floor(u) % 2; return strip ? (y < 0.5 ? line(fr(x * 4) - 0.5, 0.4) : 0.6) : (x > 0.2 && x < 0.8 ? line(fr(y * 3) - 0.5, 0.3) : 1); }],
    ['bogolan', 'Bogolan mudcloth', 12, 1, (u, v, s) => { const cell = Math.floor(hash2(Math.floor(u), Math.floor(v), s) * 4), [x, y] = local(u, v); if (cell === 0) return 1 - ss(0.1, 0.16, circ(x, y)); if (cell === 1) return line(fr(y * 3) - 0.5, 0.25) * (Math.abs(x) < 0.35 ? 1 : 0); if (cell === 2) return Math.max(line(x, 0.12), line(y, 0.12)) * (circ(x, y) < 0.35 ? 1 : 0); return line(y - x, 0.12); }, true],
    ['zulu', 'Zulu zigzag', 14, 1, (u, v) => { const y = fr(v * 1.5); return line(y - 0.5 - (tri(u) - 0.5) * 0.6, 0.35) ; }],
    ['kuba', 'Kuba maze', 12, 1, (u, v, s) => { const x = fr(u) * 3, y = fr(v) * 3; const k = hash2(Math.floor(u), Math.floor(v), s) > 0.5; const d = Math.min(Math.abs(fr(x) - 0.5), Math.abs(fr(y) - 0.5)); return (k ? Math.floor(x) + Math.floor(y) : Math.floor(x) - Math.floor(y)) % 2 === 0 ? 1 - line(d - 0.5, 0.2) : line(d, 0.3); }, true],
    ['adire', 'Adire resist dots', 14, 0.8, (u, v) => { const [x, y] = local(u, v); const r = circ(x, y); return Math.max(line(r - 0.3, 0.08), 1 - ss(0.07, 0.11, r)); }],
    ['ndebele', 'Ndebele blocks', 8, 1.2, (u, v) => { const [x, y] = local(u, v * 0.6); const st = Math.max(Math.abs(x), Math.abs(y) * 1.4); return st < 0.42 ? (fr(st * 6) < 0.6 ? 1 : 0.4) : 0.1; }],
  ]),
  ...P('India & Persia', [
    ['jali', 'Jali lattice', 12, 1.2, (u, v) => { const [x, y] = local(u, v); const ring = line(circ(x, y) - 0.3, 0.08); const diag = Math.max(line(Math.abs(x) - Math.abs(y), 0.06) * (circ(x, y) > 0.3 ? 1 : 0), line(Math.max(Math.abs(x), Math.abs(y)) - 0.5, 0.06)); return Math.max(ring, diag); }],
    ['paisley', 'Paisley boteh', 6, 1.2, (u, v) => { const row = Math.floor(v); const x = fr(u + row * 0.5) - 0.5, y = fr(v) - 0.5; const body = circ(x, y + 0.08) - 0.24 + Math.max(0, y) * 0.15; const tail = circ(x - 0.18 - y * 0.2, y - 0.25) - 0.06; const d = Math.min(body, tail); return line(d, 0.07) + (d < -0.05 ? line(circ(x, y + 0.08) - 0.12, 0.06) : 0); }],
    ['mandala', 'Mandala rosette', 6, 1.2, (u, v) => { const [x, y] = local(u, v); const a = Math.atan2(y, x), r = circ(x, y) * 2; return r > 1 ? 0.1 : cl(0.5 + 0.5 * Math.cos(a * 12) * Math.cos(r * TAU * 1.5)) * 0.7 + line(r - 0.95, 0.08) * 0.3; }],
    ['blockprint', 'Block-print buti', 12, 1, (u, v) => { const row = Math.floor(v); const [x, y] = local(u + row * 0.5, v); const a = Math.atan2(y, x), r = circ(x, y); const petal = r < 0.3 * (0.6 + 0.4 * Math.abs(Math.cos(a * 3))) ? 1 : 0; return Math.max(petal, 1 - ss(0.05, 0.08, r)); }],
    ['persian', 'Persian medallion', 6, 1.2, (u, v) => { const [x, y] = local(u, v * 0.7); const d = Math.abs(x) + Math.abs(y); return Math.max(line(d - 0.42, 0.06), line(d - 0.3, 0.04), d < 0.15 ? 1 : 0, line(circ(x, y) - 0.2, 0.05)); }],
  ]),
  ...P('Americas & Pacific', [
    ['xicalcoliuhqui', 'Stepped fret', 10, 1.2, (u, v) => { const x = Math.floor(fr(u) * 6), y = Math.floor(fr(v) * 6); const stair = x - y === 0 || x - y === 1; const hook = (y === 5 && x <= 1) || (x === 0 && y >= 4); return stair || hook ? 1 : 0.1; }],
    ['zapotec', 'Zapotec diamond steps', 10, 1, (u, v) => { const [x, y] = local(u, v); const d = Math.floor((Math.abs(x) + Math.abs(y)) * 8) / 8; return fr(d * 4) < 0.5 ? 1 : 0.2; }],
    ['navajo', 'Eye-dazzler', 10, 1, (u, v) => { const [x, y] = local(u, v); return fr((Math.abs(x) + Math.abs(y)) * 6) < 0.5 ? 1 : 0.15; }],
    ['koru', 'Koru spirals', 8, 1.2, (u, v) => { const [x, y] = local(u, v); const a = Math.atan2(y, x), r = circ(x, y); return r < 0.46 ? line(fr(r * 5 + a / TAU) - 0.5, 0.35) : 0.1; }],
    ['nihomano', 'Niho mano shark teeth', 18, 1, (u, v) => { const y = fr(v * 2), x = fr(u); return y < 1 - Math.abs(2 * x - 1) ? 1 : 0.1; }],
    ['tapa', 'Tapa cloth', 10, 1, (u, v) => { const x = fr(u), y = fr(v); const band = Math.floor(v * 3) % 3; return band === 0 ? (y * 3 % 1 < 1 - Math.abs(2 * fr(u * 2) - 1) ? 1 : 0.2) : band === 1 ? line(fr(x * 3) - 0.5, 0.3) : 0.7; }],
  ]),
  ...P('Art Deco & architecture', [
    ['sunburst', 'Deco sunburst', 8, 1.2, (u, v) => { const x = fr(u) - 0.5, y = fr(v); const a = Math.atan2(y, x); return y < 0.08 ? 1 : line(fr(a / Math.PI * 10) - 0.5, 0.4); }],
    ['decofan', 'Deco fans', 10, 1, (u, v) => { const row = Math.floor(v); const x = fr(u + row * 0.5) - 0.5, y = fr(v); const r = circ(x, y); return r < 0.5 ? line(fr(r * 5) - 0.5, 0.3) : 0.1; }],
    ['chevron', 'Chevron', 14, 1, (u, v) => line(fr(v + tri(u) * 0.5) - 0.5, 0.45)],
    ['scallop', 'Scallops', 14, 1.2, (u, v) => { const row = Math.floor(v); const x = fr(u + row * 0.5) - 0.5, y = fr(v); return cl(Math.sqrt(cl(0.25 - x * x)) * 2 - (1 - y) * 0.6); }],
    ['ziggurat', 'Ziggurat steps', 10, 1.4, (u, v) => { const x = Math.abs(fr(u) - 0.5) * 2, y = fr(v); return Math.floor((1 - x) * 4) / 4 > y ? 1 : 0.1; }],
    ['brick', 'Brickwork', 12, 1, (u, v) => { const row = Math.floor(v * 2); const x = fr(u + (row % 2) * 0.5), y = fr(v * 2); return 1 - Math.max(line(x, 0.08), line(x - 1, 0.08), line(y, 0.16), line(y - 1, 0.16)); }],
    ['stonewall', 'Stone wall', 8, 1.6, (u, v, s) => { const q = voro(u * 1.5, v * 2, s); return ss(0, 0.18, q.d2 - q.d1) * (0.8 + 0.2 * q.id); }, true],
    ['louvre', 'Louvres', 20, 1.4, (u, v) => fr(v * 2)],
    ['coffers', 'Coffers', 10, 1.4, (u, v) => { const [x, y] = local(u, v); return ss(0.25, 0.45, Math.max(Math.abs(x), Math.abs(y))); }],
    ['gothic', 'Gothic arches', 10, 1.2, (u, v) => { const x = fr(u) - 0.5, y = fr(v * 0.6); const arch = y < 0.6 ? Math.abs(x) - 0.35 : Math.max(circ(x + 0.35, y - 0.6), circ(x - 0.35, y - 0.6)) - 0.7; return line(arch, 0.08) + (arch < 0 ? 0 : 0.1); }],
  ]),
  ...P('Modern & parametric', [
    ['hexcells', 'Hex cells', 14, 1.2, (u, v) => ss(0.36, 0.46, hex(u, v).hd)],
    ['hexdomes', 'Hex domes', 14, 1.2, (u, v) => cl(1 - hex(u, v).hd * 2)],
    ['voronoi', 'Voronoi cells', 10, 1.2, (u, v, s) => { const q = voro(u, v, s); return ss(0, 0.12, q.d2 - q.d1); }, true],
    ['voronoiridge', 'Voronoi ridges', 10, 1.2, (u, v, s) => { const q = voro(u, v, s); return 1 - ss(0, 0.1, q.d2 - q.d1); }, true],
    ['triangles', 'Triangle facets', 14, 1, (u, v) => { const y = fr(v), x = fr(u + Math.floor(v) * 0.5); return Math.min(y, 1 - Math.abs(2 * x - 1)) * 2; }],
    ['waffle', 'Waffle', 16, 1.2, (u, v) => { const [x, y] = local(u, v); return Math.max(line(Math.abs(x) - 0.5, 0.2), line(Math.abs(y) - 0.5, 0.2)); }],
    ['basket', 'Basket weave', 12, 1, (u, v) => { const x = fr(u) * 2, y = fr(v) * 2; const q = (Math.floor(x) + Math.floor(y)) % 2; const t = q ? fr(x) : fr(y); return Math.sqrt(cl(1 - (2 * t - 1) ** 2)); }],
    ['quilted', 'Quilted', 10, 1.4, (u, v) => { const x = fr(u + v), y = fr(u - v); return Math.sqrt(cl(Math.sin(x * Math.PI) * Math.sin(y * Math.PI))); }],
    ['studs', 'Studs', 16, 1, (u, v) => { const [x, y] = local(u, v); return 1 - ss(0.22, 0.28, circ(x, y)); }],
    ['dimples', 'Golf dimples', 16, 0.8, (u, v) => { const h = hex(u, v); return cl(h.hd * 2.2); }],
    ['crosshatch', 'Cross-hatch', 20, 0.8, (u, v) => Math.max(line(fr(u + v) - 0.5, 0.25), line(fr(u - v) - 0.5, 0.25))],
    ['chainmail', 'Chainmail rings', 16, 1, (u, v) => { const row = Math.floor(v); const [x, y] = local(u + row * 0.5, v); return line(circ(x, y) - 0.36, 0.1); }],
    ['moire', 'Moiré rings', 4, 0.8, (u, v) => { const [x, y] = local(u, v); return 0.5 + 0.5 * Math.cos(circ(x, y) * 60) * Math.cos(circ(x - 0.1, y) * 60); }],
    ['spiralstair', 'Spiral steps', 12, 1.2, (u, v) => fr(u + v * 0.5)],
    ['pixel', 'Pixel noise', 24, 0.8, (u, v, s) => (hash2(Math.floor(u), Math.floor(v), s) > 0.5 ? 1 : 0), true],
    ['circuit', 'Circuit traces', 10, 0.8, (u, v, s) => { const x = fr(u) * 4, y = fr(v) * 4; const h = hash2(Math.floor(u * 4), Math.floor(v * 4), s); return h > 0.5 ? line(fr(y) - 0.5, 0.25) : h > 0.2 ? line(fr(x) - 0.5, 0.25) : 1 - ss(0.2, 0.3, circ(fr(x) - 0.5, fr(y) - 0.5)); }, true],
  ]),
  ...P('Nature', [
    ['fishscale', 'Fish scales', 16, 1.2, (u, v) => { const row = Math.floor(v * 1.5); const x = fr(u + row * 0.5) - 0.5, y = fr(v * 1.5); return cl(1 - circ(x, y) * 2) * 0.4 + line(circ(x, y) - 0.5, 0.1) * 0.6; }],
    ['pinecone', 'Pine cone', 14, 1.6, (u, v) => { const x = fr(u + v * 0.5) - 0.5, y = fr(u - v * 0.5) - 0.5; return cl(1 - Math.max(Math.abs(x), Math.abs(y)) * 2) ** 0.6; }],
    ['bark', 'Tree bark', 10, 1.6, (u, v, s) => 1 - ss(0.2, 0.6, Math.abs(fbm(u * 3, v * 0.6, s) - 0.5) * 3), true],
    ['woodgrain', 'Wood grain', 6, 0.6, (u, v, s) => 0.5 + 0.5 * Math.sin((u + fbm(u * 0.8, v * 0.3, s) * 1.5) * TAU * 3), true],
    ['ripples', 'Water ripples', 4, 0.8, (u, v, s) => { const q = voro(u, v, s, 0.9); return 0.5 + 0.5 * Math.cos(q.d1 * 30) * Math.exp(-q.d1 * 2); }, true],
    ['leaves', 'Leaf veins', 8, 1, (u, v) => { const row = Math.floor(v); const x = fr(u + row * 0.5) - 0.5, y = fr(v) - 0.5; const leaf = Math.abs(x) < 0.4 * Math.cos(y * Math.PI) ** 0.7; return leaf ? Math.max(0.6, line(x, 0.05), line(fr((y + Math.abs(x)) * 5) - 0.5, 0.1) * 0.9) : 0; }],
    ['crocodile', 'Crocodile', 10, 1.2, (u, v, s) => { const q = voro(u, v * 1.4, s, 0.5); return ss(0, 0.15, q.d2 - q.d1); }, true],
    ['coral', 'Brain coral', 6, 1.2, (u, v, s) => 1 - Math.abs(Math.sin(fbm(u * 2, v * 2, s) * 18)), true],
    ['sanddunes', 'Sand dunes', 4, 1.2, (u, v, s) => tri(v * 2 + fbm(u, v, s) * 1.5), true],
    ['honeycomb', 'Honeycomb', 14, 1.2, (u, v) => line(0.5 - hex(u, v).hd, 0.12)],
    ['cactus', 'Cactus ribs & areoles', 14, 1.6, (u, v) => { const x = fr(u) - 0.5; const rib = Math.sqrt(cl(1 - (2 * x) ** 2)); return Math.max(rib * 0.85, (1 - ss(0.04, 0.08, circ(x, fr(v) - 0.5))) ); }],
    ['feathers', 'Feathers', 10, 1, (u, v) => { const row = Math.floor(v * 1.4); const x = fr(u + row * 0.5) - 0.5, y = fr(v * 1.4); return y < 1 - Math.abs(x) * 2 ? 0.6 + 0.4 * line(fr((y - Math.abs(x)) * 6) - 0.5, 0.4) : 0.1; }],
  ]),
  ...P('Textiles', [
    ['tartan', 'Tartan', 6, 0.8, (u, v) => { const f = (t: number) => (fr(t) < 0.15 ? 1 : fr(t) < 0.2 ? 0.2 : fr(t) > 0.6 && fr(t) < 0.65 ? 0.8 : 0.4); return (f(u) + f(v)) / 2; }],
    ['houndstooth', 'Houndstooth', 14, 0.8, (u, v) => { const x = fr(u) * 4, y = fr(v) * 4; const xi = Math.floor(x), yi = Math.floor(y); const base = (xi < 2) === (yi < 2); const tooth = (xi === 2 && yi === 1 && fr(x) > fr(y)) || (xi === 1 && yi === 2 && fr(x) < fr(y)) || (xi === 0 && yi === 3) || (xi === 3 && yi === 0); return base !== tooth ? 1 : 0; }],
    ['argyle', 'Argyle', 8, 0.8, (u, v) => { const x = fr(u) - 0.5, y = fr(v * 0.7) - 0.5; const d = Math.abs(x) + Math.abs(y); return Math.max(d < 0.5 ? 0.7 : 0.2, line(fr(u + v * 0.7) - 0.5, 0.05), line(fr(u - v * 0.7) - 0.5, 0.05)); }],
    ['polka', 'Polka dots', 12, 1, (u, v) => { const row = Math.floor(v); const [x, y] = local(u + row * 0.5, v); return 1 - ss(0.2, 0.25, circ(x, y)); }],
    ['tweed', 'Tweed', 30, 0.5, (u, v, s) => line(fr(u * 2 + (Math.floor(v * 4) % 2) * 0.5) - 0.5, 0.5) * (0.7 + 0.3 * noise2(u * 8, v * 8, s)), true],
    ['crochet', 'Crochet granny', 8, 1.2, (u, v) => { const [x, y] = local(u, v); const sq = Math.max(Math.abs(x), Math.abs(y)); return sq > 0.46 ? 0.2 : line(fr(sq * 5 + 0.25) - 0.5, 0.45); }],
    ['denimtwill', 'Twill', 30, 0.5, (u, v) => line(fr(u + v) - 0.5, 0.5)],
    ['lace', 'Lace', 10, 1, (u, v) => { const [x, y] = local(u, v); const r = circ(x, y), a = Math.atan2(y, x); return Math.max(line(r - 0.3 - 0.05 * Math.cos(a * 8), 0.05), line(Math.max(Math.abs(x), Math.abs(y)) - 0.5, 0.05), r < 0.08 ? 1 : 0); }],
    ['smocking', 'Smocking', 14, 1.2, (u, v) => { const x = fr(u + v * 0.5), y = fr(u - v * 0.5); return Math.sqrt(cl(1 - Math.min(circ(x - 0.5, y - 0.5) * 2.2, 1))); }],
  ]),
];

const BY_ID = new Map(PATTERNS.map((p) => [p.id, p]));
export const patternById = (id: string) => BY_ID.get(id);
export const PATTERN_GROUPS = [...new Set(PATTERNS.map((p) => p.group))];

/** Grey height map imported from an image, SVG, DXF or text (0..255, 255 = raised). */
export interface HeightMap { w: number; h: number; data: string /* base64 of w*h bytes */ }
const cache = new WeakMap<HeightMap, Uint8Array>();
export function heightBytes(m: HeightMap): Uint8Array {
  let b = cache.get(m);
  if (!b) { const s = atob(m.data); b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i); cache.set(m, b); }
  return b;
}
export function sampleMap(m: HeightMap, x: number, y: number): number {
  const b = heightBytes(m), W = m.w, H = m.h;
  const fx = fr(x) * W - 0.5, fy = cl(y) * (H - 1);
  const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
  const X = (i: number) => ((i % W) + W) % W, Y = (j: number) => Math.min(H - 1, Math.max(0, j));
  const g = (i: number, j: number) => b[Y(j) * W + X(i)];
  const top = g(x0, y0) + (g(x0 + 1, y0) - g(x0, y0)) * tx, bot = g(x0, y0 + 1) + (g(x0 + 1, y0 + 1) - g(x0, y0 + 1)) * tx;
  return (top + (bot - top) * ty) / 255;
}
export function bytesToMap(w: number, h: number, bytes: Uint8Array): HeightMap {
  let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { w, h, data: btoa(s) };
}

/** Smooth (Catmull-Rom) sample of a height map: no pixel steps between samples. */
export function sampleMapCubic(m: HeightMap, x: number, y: number): number {
  const b = heightBytes(m), W = m.w, H = m.h;
  const fx = fr(x) * W - 0.5, fy = cl(y) * (H - 1);
  const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
  const X = (i: number) => ((i % W) + W) % W, Y = (j: number) => Math.min(H - 1, Math.max(0, j));
  const cr = (p0: number, p1: number, p2: number, p3: number, t: number) => p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)));
  const row = (j: number) => cr(b[Y(j) * W + X(x0 - 1)], b[Y(j) * W + X(x0)], b[Y(j) * W + X(x0 + 1)], b[Y(j) * W + X(x0 + 2)], tx);
  return cl(cr(row(y0 - 1), row(y0), row(y0 + 1), row(y0 + 2), ty) / 255);
}
/** Image traced as a clean outline: the smoothed sample cut at half height; the edge rises over about one
 *  image pixel, so the mesh can trace it as a smooth vector curve. */
export function sampleMapVector(m: HeightMap, x: number, y: number): number {
  // imports are already softened (Soften edges); a hard 1-px edge still rises over about a pixel here
  const v = sampleMapCubic(m, x, y);
  const t = cl((v - 0.25) / 0.5);
  return t * t * (3 - 2 * t);
}
