// Built-in patterns so Patternex works without files (spec §3.1). Sizes in mm; two colours each.
import { boundsOf, type Pattern, type PatternShape, type Ring } from './model';

export interface BuiltinOptions { width?: number; height?: number; cell?: number; colors?: [string, string] }
export type BuiltinKind = 'stripes' | 'checker' | 'dots' | 'hex';
export const BUILTIN_KINDS: BuiltinKind[] = ['stripes', 'checker', 'dots', 'hex'];

const rect = (x0: number, y0: number, x1: number, y1: number): Ring => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const ngon = (cx: number, cy: number, r: number, n: number, a0 = 0): Ring =>
  Array.from({ length: n }, (_, k) => { const a = a0 + (2 * Math.PI * k) / n; return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as [number, number]; });

export function builtinPattern(kind: BuiltinKind, o: BuiltinOptions = {}): Pattern {
  const W = o.width ?? 40, H = o.height ?? 40, c = o.cell ?? 5;
  // default colours are the library's neutral ink keys (Ink A / Ink B), uninked until the user picks a filament
  const [a, b] = o.colors ?? ['#2f2f33', '#7d7d85'];
  const A: Ring[] = [], B: Ring[] = [];
  if (kind === 'stripes') {
    for (let k = 0, x = 0; x < W - 1e-9; k++, x += c) (k % 2 ? B : A).push(rect(x, 0, Math.min(W, x + c), H));
  } else if (kind === 'checker') {
    for (let j = 0, y = 0; y < H - 1e-9; j++, y += c) for (let i = 0, x = 0; x < W - 1e-9; i++, x += c)
      ((i + j) % 2 ? B : A).push(rect(x, y, Math.min(W, x + c), Math.min(H, y + c)));
  } else if (kind === 'dots') {
    for (let y = c / 2; y <= H - c / 2 + 1e-9; y += c) for (let x = c / 2; x <= W - c / 2 + 1e-9; x += c) B.push(ngon(x, y, c * 0.3, 24));
  } else {
    const r = c / 2, dx = Math.sqrt(3) * r, dy = 1.5 * r;
    for (let j = 0, y = r; y <= H - r + 1e-9; j++, y += dy) for (let i = 0, x = dx / 2 + (j % 2 ? dx / 2 : 0); x <= W - dx / 2 + 1e-9; i++, x += dx)
      ((i + j) % 2 ? B : A).push(ngon(x, y, r * 0.92, 6, Math.PI / 6));
  }
  const shapes: PatternShape[] = [];
  // dots: the background stays the base material, so only the dots are a region
  if (A.length) shapes.push({ polygon_rings: A, fill_color: a, fill_rule: 'nonzero' });
  if (B.length) shapes.push({ polygon_rings: B, fill_color: b, fill_rule: 'nonzero' });
  return { id: `builtin:${kind}`, name: kind[0].toUpperCase() + kind.slice(1), source: 'builtin', shapes, tolerance_mm: 0, bounds: boundsOf(shapes) };
}
