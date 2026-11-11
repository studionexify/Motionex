// Vector symbols for block keys (arrows, heart, star …): unit-size polygons, centred, Y up.
import { union } from '../../engine/clipper';
import type { Paths } from '../../engine/types';
import { baseShapePaths } from './catalog';
import { toPath, transformPaths, type XY } from './geom';

const P = (pts: XY[]) => toPath(pts);

const arrowUp = (): Paths => [P([[-0.1, -0.45], [0.1, -0.45], [0.1, 0.1], [0.32, 0.1], [0, 0.45], [-0.32, 0.1], [-0.1, 0.1]])];

export const SYMBOLS: { id: string; name: string; make(): Paths }[] = [
  { id: 'up', name: 'Arrow up', make: arrowUp },
  { id: 'down', name: 'Arrow down', make: () => transformPaths(arrowUp(), 1, 180, 0, 0) },
  { id: 'left', name: 'Arrow left', make: () => transformPaths(arrowUp(), 1, 90, 0, 0) },
  { id: 'right', name: 'Arrow right', make: () => transformPaths(arrowUp(), 1, -90, 0, 0) },
  { id: 'heart', name: 'Heart', make: () => baseShapePaths('heart', 0.9) },
  { id: 'star', name: 'Star', make: () => baseShapePaths('star', 0.95) },
  { id: 'bolt', name: 'Bolt', make: () => [P([[0.1, 0.5], [-0.3, -0.05], [-0.04, -0.05], [-0.12, -0.5], [0.3, 0.1], [0.04, 0.1]])] },
  { id: 'plus', name: 'Plus', make: () => union([P([[-0.1, -0.4], [0.1, -0.4], [0.1, 0.4], [-0.1, 0.4]]), P([[-0.4, -0.1], [0.4, -0.1], [0.4, 0.1], [-0.4, 0.1]])]) },
  { id: 'minus', name: 'Minus', make: () => [P([[-0.4, -0.1], [0.4, -0.1], [0.4, 0.1], [-0.4, 0.1]])] },
  { id: 'dot', name: 'Dot', make: () => baseShapePaths('circle', 0.5) },
  { id: 'diamond', name: 'Diamond', make: () => baseShapePaths('diamond', 0.8) },
  { id: 'esc', name: 'Esc bar', make: () => [P([[-0.45, -0.06], [0.45, -0.06], [0.45, 0.06], [-0.45, 0.06]])] },
];

export const symbolById = (id: string) => SYMBOLS.find((s) => s.id === id);

/** Split key text into characters and {symbol} tokens. */
export function keyTokens(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') { const j = text.indexOf('}', i); if (j > i && symbolById(text.slice(i + 1, j))) { out.push(text.slice(i, j + 1)); i = j; continue; } }
    if (text[i] !== '\n') out.push(text[i]);
  }
  return out;
}
