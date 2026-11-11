// Mixed filaments (colour mixing by layer alternation), as in Snapmaker Orca's Color Mixing.
// A mixed filament is a virtual filament: on each layer it prints with one of the physical filaments, so the
// stacked thin layers read as a blend from a normal viewing distance. Virtual filaments are numbered after the
// physical ones: with 4 physical filaments the first mix is filament 5.
//   ratio  two filaments, A:B layers (2:1 → A A B A A B …, spread as evenly as possible)
//   cycle  a custom sequence of filaments repeated layer by layer (1,2,2,3 …)
//   gradient  A at the bottom fading into B at the top of each object (between start % and end % of its height);
//          on each layer the share of B follows the height and error diffusion picks A or B, so no long runs

export type MixedFilament =
  | { id: string; name?: string; kind: 'ratio'; a: number; b: number; ra: number; rb: number }
  | { id: string; name?: string; kind: 'cycle'; seq: number[] }
  | { id: string; name?: string; kind: 'gradient'; a: number; b: number; start: number; end: number };

export const MAX_CYCLE = 24;
export const MAX_RATIO = 9;

/** Layer-by-layer sequence of physical slots (0-based) the mix repeats. */
export function mixSequence(m: MixedFilament): number[] {
  if (m.kind === 'gradient') return [m.a, m.b];
  if (m.kind === 'cycle') return m.seq.length ? m.seq.slice(0, MAX_CYCLE) : [0];
  const ra = Math.max(0, Math.min(MAX_RATIO, Math.round(m.ra)));
  const rb = Math.max(0, Math.min(MAX_RATIO, Math.round(m.rb)));
  if (!ra && !rb) return [m.a];
  if (!rb) return [m.a];
  if (!ra) return [m.b];
  // even spread: put B on the layers where the running share of B crosses an integer
  const n = ra + rb;
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(Math.floor(((i + 1) * rb) / n) > Math.floor((i * rb) / n) ? m.b : m.a);
  return out;
}

/** Share of B in a gradient at height fraction t (0 bottom … 1 top of the object). */
export function gradientShare(m: { start: number; end: number }, t: number): number {
  const s = Math.max(0, Math.min(100, m.start)) / 100, e = Math.max(0, Math.min(100, m.end)) / 100;
  if (e <= s) return t >= s ? 1 : 0;
  return Math.max(0, Math.min(1, (t - s) / (e - s)));
}

/** Gradient: slot per layer for height fractions `ts` (error diffusion, so the B share tracks the ramp). */
export function gradientSlots(m: Extract<MixedFilament, { kind: 'gradient' }>, ts: ArrayLike<number>): number[] {
  const out: number[] = [];
  let acc = 0;
  for (let i = 0; i < ts.length; i++) {
    if (!(ts[i] >= 0)) { out.push(m.a); continue; } // not a layer of this object
    acc += gradientShare(m, ts[i]);
    if (acc >= 0.5) { out.push(m.b); acc -= 1; } else out.push(m.a);
  }
  return out;
}
const gradCache = new WeakMap<ArrayLike<number>, Map<string, number[]>>();

/** Physical slot used by a mix on layer `layer`. Gradients need `ts`, the object's height fraction per layer. */
export const mixSlotAt = (m: MixedFilament, layer: number, ts?: ArrayLike<number>) => {
  if (m.kind === 'gradient') {
    if (!ts) return m.a;
    let c = gradCache.get(ts);
    if (!c) gradCache.set(ts, (c = new Map()));
    const key = `${m.a},${m.b},${m.start},${m.end}`;
    let g = c.get(key);
    if (!g) c.set(key, (g = gradientSlots(m, ts)));
    return g[layer] ?? m.a;
  }
  const s = mixSequence(m);
  return s[((layer % s.length) + s.length) % s.length];
};

const lin = (c: number) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const gam = (c: number) => Math.round(255 * Math.max(0, Math.min(1, c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055)));
const rgbOf = (hex: string): [number, number, number] => {
  const m = /^#?([0-9a-f]{6})/i.exec(hex.trim());
  const v = m ? parseInt(m[1], 16) : 0x808080;
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
};

/** Expected look of the mix: layer shares averaged in linear light (how thin stacked layers blend to the eye). */
export function mixColor(m: MixedFilament, colors: string[]): string {
  const seq = mixSequence(m);
  const acc = [0, 0, 0];
  for (const k of seq) { const c = rgbOf(colors[k] ?? '#808080'); for (let j = 0; j < 3; j++) acc[j] += lin(c[j]); }
  return `#${acc.map((v) => gam(v / seq.length).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

/** Share of each physical slot in the mix, e.g. {0: 0.67, 1: 0.33}. */
export function mixShares(m: MixedFilament): Map<number, number> {
  const seq = mixSequence(m);
  const out = new Map<number, number>();
  for (const k of seq) out.set(k, (out.get(k) ?? 0) + 1 / seq.length);
  return out;
}

/** Short description: "F1 2 : 1 F2" or "1 → 2 → 2 → 3". */
export function mixLabel(m: MixedFilament): string {
  if (m.kind === 'ratio') return `F${m.a + 1} ${m.ra} : ${m.rb} F${m.b + 1}`;
  if (m.kind === 'gradient') return `F${m.a + 1} ↗ F${m.b + 1} (${m.start}–${m.end}%)`;
  return m.seq.map((k) => k + 1).join(' → ');
}

/** Problems with a mix for `physical` filament slots (empty when it can be printed). */
export function mixProblems(m: MixedFilament, physical: number): string[] {
  const seq = mixSequence(m);
  const out: string[] = [];
  if (seq.some((k) => k < 0 || k >= physical)) out.push('Uses a filament slot that no longer exists.');
  if (new Set(seq).size < 2) out.push('Needs at least two different filaments.');
  return out;
}

/** Filament index (physical or virtual) → physical slot on a layer. Unknown virtual indices fall back to slot 0. */
export function resolveFilament(fil: number, layer: number, physical: number, mixes: MixedFilament[] | undefined, ts?: ArrayLike<number>): number {
  if (fil < physical) return Math.max(0, fil);
  const m = mixes?.[fil - physical];
  if (!m) return Math.max(0, physical - 1);
  const k = mixSlotAt(m, layer, ts);
  return k >= 0 && k < physical ? k : 0;
}

/** Colours of every choosable filament: the physical ones, then each mix's blended colour. */
export const allFilamentColors = (colors: string[], mixes: MixedFilament[] | undefined) => [...colors, ...(mixes ?? []).map((m) => mixColor(m, colors))];

/** Mixes after physical slot `k` is removed: references to it go to slot 1, later slots move down by one. */
export function mixesAfterSlotRemoved(mixes: MixedFilament[], k: number): MixedFilament[] {
  const f = (x: number) => (x === k ? 0 : x > k ? x - 1 : x);
  return mixes.map((m) => (m.kind === 'cycle' ? { ...m, seq: m.seq.map(f) } : { ...m, a: f(m.a), b: f(m.b) }));
}

/** Remaps a filament index (0-based) when the filament list changes shape: `from` is the first index affected,
 *  `delta` +1 (inserted before it) or -1 (removed at from - 1… handled by the caller), `gone` the removed index. */
export function shiftIndex(f: number | undefined, gone: number | null, from: number, delta: number): number | undefined {
  if (f === undefined) return f;
  if (gone !== null && f === gone) return 0;
  return f >= from ? f + delta : f;
}

/** CSS background for a mix swatch: a vertical ramp for gradients (bottom A → top B), the blend otherwise. */
export function mixCss(m: MixedFilament, colors: string[]): string {
  if (m.kind !== 'gradient') return mixColor(m, colors);
  const a = colors[m.a] ?? '#808080', b = colors[m.b] ?? '#808080';
  return `linear-gradient(to top, ${a} ${m.start}%, ${b} ${m.end}%)`;
}

// ---------- Match: find the mix of loaded filaments that looks closest to a target colour
const toLab = (hex: string): [number, number, number] => {
  const [r, g, b] = rgbOf(hex).map(lin);
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047, y = 0.2126 * r + 0.7152 * g + 0.0722 * b, z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
};
/** CIE94 colour difference (ΔE, graphic arts): about 1–2 is barely visible, above 10 clearly different. */
export function deltaE(a: string, b: string): number {
  const p = toLab(a), q = toLab(b);
  const c1 = Math.hypot(p[1], p[2]), c2 = Math.hypot(q[1], q[2]);
  const dL = p[0] - q[0], dC = c1 - c2;
  const dH2 = Math.max(0, (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2 - dC * dC);
  return Math.sqrt(dL * dL + (dC / (1 + 0.045 * c1)) ** 2 + dH2 / (1 + 0.015 * c1) ** 2);
}
const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

/** Cycle that spreads `counts[j]` layers of `slots[j]` as evenly as possible (largest share first). */
export function spreadCycle(slots: number[], counts: number[]): number[] {
  const n = counts.reduce((a, c) => a + c, 0);
  const acc = counts.map(() => 0);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    counts.forEach((c, j) => { acc[j] += c / n; });
    let best = 0;
    acc.forEach((v, j) => { if (v > acc[best]) best = j; });
    out.push(slots[best]); acc[best] -= 1;
  }
  return out;
}

export interface MixMatch { mix: MixedFilament; color: string; dE: number }

/** Mixes of the loaded filaments closest to `target`, best first: pairs at ratios up to 9:9 and three-filament
 *  cycles up to 6 layers. `max` results; ties prefer shorter repeats (finer texture). */
export function matchMixes(target: string, colors: string[], max = 6): MixMatch[] {
  const out: MixMatch[] = [];
  const P = colors.length;
  const push = (mix: MixedFilament) => { const color = mixColor(mix, colors); out.push({ mix, color, dE: deltaE(color, target) }); };
  for (let a = 0; a < P; a++) for (let b = a + 1; b < P; b++) for (let ra = 1; ra <= MAX_RATIO; ra++) for (let rb = 1; rb <= MAX_RATIO; rb++) {
    if (gcd(ra, rb) !== 1) continue;
    push({ id: 'match', kind: 'ratio', a, b, ra, rb });
  }
  for (let a = 0; a < P; a++) for (let b = a + 1; b < P; b++) for (let c = b + 1; c < P; c++)
    for (let x = 1; x <= 4; x++) for (let y = 1; y <= 4; y++) for (let z = 1; z <= 4; z++) {
      if (x + y + z > 6 || gcd(gcd(x, y), z) !== 1) continue;
      push({ id: 'match', kind: 'cycle', seq: spreadCycle([a, b, c], [x, y, z]) });
    }
  const len = (m: MixedFilament) => mixSequence(m).length;
  out.sort((p, q) => (Math.abs(p.dE - q.dE) < 0.5 ? len(p.mix) - len(q.mix) : p.dE - q.dE));
  // one entry per distinct look
  const seen: MixMatch[] = [];
  for (const m of out) { if (seen.length >= max) break; if (!seen.some((s) => deltaE(s.color, m.color) < 2.5)) seen.push(m); }
  return seen;
}

// ---------- Subdivide Mix Layer: print mix areas in thinner passes inside each layer
/** Thinnest pass a subdivided layer may use (mm). */
export const MIN_SUBLAYER = 0.04;

/** Passes per layer for a mix: one per filament it uses (2 or 3+), fewer when the passes would be too thin; 1 = off. */
export function subPassCount(m: MixedFilament, h: number): number {
  const distinct = new Set(mixSequence(m)).size;
  return Math.max(1, Math.min(distinct, Math.floor(h / MIN_SUBLAYER + 1e-9)));
}

/** Slot of each pass (bottom → top) on layer `layer` when a layer is split into `n` passes. */
export function mixSubSlots(m: MixedFilament, layer: number, n: number, ts?: ArrayLike<number>): number[] {
  if (m.kind === 'gradient') {
    const t = ts?.[layer] ?? 0;
    const share = gradientShare(m, t >= 0 ? t : 0);
    const dither = (layer * 0.6180339887498949) % 1;
    const b = Math.max(0, Math.min(n, Math.floor(share * n + dither)));
    return Array.from({ length: n }, (_, j) => (Math.floor(((j + 1) * b) / n) > Math.floor((j * b) / n) ? m.b : m.a));
  }
  const s = mixSequence(m);
  return Array.from({ length: n }, (_, j) => s[(layer * n + j) % s.length]);
}
