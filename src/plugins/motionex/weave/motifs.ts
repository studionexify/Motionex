// Built-in weave pictures: classic textile and pottery motifs drawn at any grid size and any number of
// colours (index 0 is the ground colour). Pixel-art tiles are written as strings: '.' ground, digits
// and '#' are colours.
import type { WeaveImage } from './model';

export interface Motif {
  id: string;
  name: string;
  description: string;
  /** Smallest number of colours it needs. */
  minColours: number;
  /** Palette index at column x, row y (row 0 = top) of a w × h grid with n colours. */
  at(x: number, y: number, w: number, h: number, n: number): number;
}

const tile = (rows: string[]) => {
  const h = rows.length, w = rows[0].length;
  return (x: number, y: number, n: number) => {
    const c = rows[((y % h) + h) % h][((x % w) + w) % w];
    if (c === '.' || c === undefined) return 0;
    const v = c === '#' ? 1 : Number(c);
    return Math.min(v, n - 1);
  };
};

const STAR = tile([
  '.....#.....',
  '....#2#....',
  '.#..#2#..#.',
  '..#######..',
  '..##222##..',
  '####2.2####',
  '..##222##..',
  '..#######..',
  '.#..#2#..#.',
  '....#2#....',
  '.....#.....',
  '...........',
]);
const BIRD = tile([
  '..............',
  '.....##.......',
  '....####......',
  '...##.###.....',
  '..####.####...',
  '.#########....',
  '...########...',
  '....#######.#.',
  '.....#####.##.',
  '......#..#....',
  '.....##..##...',
  '..............',
]);
const KEY = tile([
  '##########',
  '..........',
  '#######...',
  '......#...',
  '#####.#...',
  '#...#.#...',
  '#.###.#...',
  '#.....#...',
  '#######...',
  '..........',
  '##########',
  '..........',
]);
const ROSETTE = tile([
  '..........',
  '....##....',
  '...#22#...',
  '.##2..2##.',
  '#2..##..2#',
  '#2..##..2#',
  '.##2..2##.',
  '...#22#...',
  '....##....',
  '..........',
]);

export const MOTIFS: Motif[] = [
  { id: 'checker', name: 'Checker', description: 'Squares of each colour in turn.', minColours: 2,
    at: (x, y, w, _h, n) => (Math.floor(x / Math.max(1, Math.round(w / 32))) + Math.floor(y / Math.max(1, Math.round(w / 32)))) % n },
  { id: 'twill', name: 'Twill', description: 'Diagonal ribs like denim; twists round the part.', minColours: 2,
    at: (x, y, _w, _h, n) => Math.floor((((x + y) % 8) + 8) % 8 / (8 / n)) % n },
  { id: 'chevron', name: 'Chevron', description: 'Zig-zag bands.', minColours: 2,
    at: (x, y, _w, _h, n) => { const p = 12, a = Math.abs(((x % p) + p) % p - p / 2); return Math.floor(((y + a) % (3 * n)) / 3) % n; } },
  { id: 'greek-key', name: 'Greek key', description: 'Meander border, as on classical urns.', minColours: 2,
    at: (x, y, _w, _h, n) => KEY(x, y, n) },
  { id: 'kilim', name: 'Kilim diamonds', description: 'Nested diamonds from oriental carpets; three colours if you have them.', minColours: 2,
    at: (x, y, _w, _h, n) => {
      const p = 16, cx = ((x % p) + p) % p - p / 2, cy = ((y % p) + p) % p - p / 2, d = Math.abs(cx) + Math.abs(cy);
      if (d < 3) return n > 2 ? 2 : 1;
      if (d < 5) return 0;
      if (d < 7) return 1;
      return Math.abs(cx) === Math.abs(cy) ? 1 : 0;
    } },
  { id: 'folk-star', name: 'Folk star', description: 'Eight-point stars, as in folk embroidery.', minColours: 2, at: (x, y, _w, _h, n) => STAR(x, y, n) },
  { id: 'birds', name: 'Folk birds', description: 'Rows of little birds, each row facing the other way.', minColours: 2,
    at: (x, y, _w, _h, n) => { const row = Math.floor(y / 12); return BIRD(row % 2 ? 13 - (x % 14) : x, y, n); } },
  { id: 'rosette', name: 'Rosette', description: 'Small rosettes on a plain ground.', minColours: 2, at: (x, y, _w, _h, n) => ROSETTE(x + (Math.floor(y / 10) % 2) * 5, y, n) },
  { id: 'houndstooth', name: 'Houndstooth', description: 'Broken checks with pointed teeth.', minColours: 2,
    at: (x, y) => {
      const a = ((x % 8) + 8) % 8, b = ((y % 8) + 8) % 8;
      if (a < 4 && b < 4) return 1;
      if (a >= 4 && b >= 4) return 0;
      return (a + b) % 4 < 2 ? 1 : 0;
    } },
  { id: 'basket', name: 'Basket', description: 'Blocks of lines that swap direction, like a woven basket.', minColours: 2,
    at: (x, y) => { const bx = Math.floor(x / 4), by = Math.floor(y / 4), along = (bx + by) % 2 === 0; return along ? (y % 2) : (x % 2); } },
  { id: 'ripple', name: 'Ripple bands', description: 'Wavy bands that run round the part.', minColours: 2,
    at: (x, y, w, _h, n) => { const k = Math.max(1, Math.round(w / 6)); return Math.floor((y + 3 * Math.sin((2 * Math.PI * x) / k)) / 4 + 100 * n) % n; } },
  { id: 'stripes', name: 'Stripes', description: 'Plain upright stripes of each colour.', minColours: 2, at: (x, _y, _w, _h, n) => Math.floor(x / 3) % n },
];

/** A motif drawn on a w × h grid with n colours. */
export function motifImage(id: string, w: number, h: number, n: number): WeaveImage {
  const m = MOTIFS.find((x) => x.id === id) ?? MOTIFS[0];
  const W = Math.max(2, Math.round(w)), H = Math.max(2, Math.round(h)), N = Math.max(2, n);
  const px = new Array<number>(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) px[y * W + x] = Math.max(0, Math.min(N - 1, m.at(x, y, W, H, N)));
  return { w: W, h: H, px, name: m.name };
}
