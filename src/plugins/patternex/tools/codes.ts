// Machine-readable markings: QR, Data Matrix and 1D barcodes (bwip-js, MIT) and Braille (ADA sizes).
// Codes are built as module grids, so the printed module size can be checked against the nozzle.
import { toSVG } from 'bwip-js/generic';
import type { Pattern, Ring } from '../model';
import { patternOf, solidRings } from './shape';
import { circle } from '../library/geom';

export type CodeKind = 'qrcode' | 'datamatrix' | 'code128' | 'ean13' | 'code39';
export const CODE_KINDS: { id: CodeKind; name: string; twoD: boolean }[] = [
  { id: 'qrcode', name: 'QR code', twoD: true },
  { id: 'datamatrix', name: 'Data Matrix', twoD: true },
  { id: 'code128', name: 'Code 128', twoD: false },
  { id: 'code39', name: 'Code 39', twoD: false },
  { id: 'ean13', name: 'EAN-13', twoD: false },
];

export interface CodeSpec {
  kind: CodeKind;
  text: string;
  /** Overall width (mm). 2D codes are square. */
  width_mm: number;
  /** 1D codes: bar height (mm). */
  height_mm: number;
  /** Quiet zone in modules (scanners need 4 for QR, 1 for Data Matrix, 10 for 1D). Printed as the base colour. */
  quiet: boolean;
  color: string;
  /** Print the inverse (light modules inked) for dark base filament. */
  invert: boolean;
}

export const defaultCodeSpec = (): CodeSpec => ({ kind: 'qrcode', text: 'https://studionexify.com', width_mm: 25, height_mm: 10, quiet: true, color: '#2f2f33', invert: false });

/** Smallest module a printer resolves reliably: two extrusion widths across (one line per module is too blobby). */
export const minModuleMm = (nozzle: number) => Math.max(0.8, 2 * nozzle);

export interface CodeResult { pattern: Pattern; modules: number; moduleMm: number; ok: boolean; message: string }

/** Smallest positive step between distinct values (the module unit of a bwip drawing). */
function unitOf(vals: number[]): number {
  const v = [...new Set(vals.map((x) => Math.round(x * 1000) / 1000))].sort((a, b) => a - b);
  let u = Infinity;
  for (let i = 1; i < v.length; i++) if (v[i] - v[i - 1] > 1e-6) u = Math.min(u, v[i] - v[i - 1]);
  return isFinite(u) ? u : 1;
}

export function codePattern(spec: CodeSpec, id: string, nozzle = 0.4): CodeResult {
  const kind = CODE_KINDS.find((k) => k.id === spec.kind)!;
  const opts: Record<string, unknown> = { bcid: spec.kind, text: spec.text || ' ', scale: 1 };
  if (!kind.twoD) Object.assign(opts, { height: 10, includetext: false });
  const svg = toSVG(opts as unknown as Parameters<typeof toSVG>[0]);
  const vb = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg);
  const vw = Number(vb?.[1] ?? 1), vh = Number(vb?.[2] ?? 1);
  const quiet = spec.quiet ? (spec.kind === 'qrcode' ? 4 : spec.kind === 'datamatrix' ? 1 : 10) : 0;
  // module grid in drawing units: 2D codes are filled paths, 1D codes are stroked vertical bars
  let cells: Ring[] = [];
  let unit = 1;
  if (kind.twoD) {
    const d = [...svg.matchAll(/<path[^>]*\sd="([^"]+)"/g)].map((m) => m[1]).join(' ');
    unit = unitOf([...d.matchAll(/-?[\d.]+/g)].map((m) => Number(m[0])));
    // bwip draws 2D codes as straight-edged subpaths (M … L … Z) filled even-odd
    for (const sub of d.split(/M/).filter((x) => x.trim())) {
      const n = [...sub.matchAll(/-?[\d.]+/g)].map((m) => Number(m[0]));
      const ring: Ring = [];
      for (let k = 0; k + 1 < n.length; k += 2) ring.push([n[k], vh - n[k + 1]]);
      if (ring.length >= 3) cells.push(ring);
    }
    cells = solidRings(cells, true);
  } else {
    const bars: [number, number][] = [];
    for (const m of svg.matchAll(/<path[^>]*stroke-width="([\d.]+)"[^>]*\sd="([^"]+)"/g)) {
      const w = Number(m[1]);
      for (const x of m[2].matchAll(/M([\d.]+) /g)) bars.push([Number(x[1]) - w / 2, Number(x[1]) + w / 2]);
    }
    unit = Math.min(...bars.map(([a, b]) => b - a));
    cells = bars.map(([a, b]) => [[a, 0], [b, 0], [b, vh], [a, vh]] as Ring);
  }
  const modules = Math.round(vw / unit);
  const moduleMm = spec.width_mm / (modules + 2 * quiet);
  const sx = moduleMm / unit;
  const sy = kind.twoD ? sx : spec.height_mm / vh;
  // centre on the origin
  let rings: Ring[] = cells.map((r) => r.map(([x, y]) => [(x - vw / 2) * sx, (y - vh / 2) * sy] as [number, number]));
  rings = solidRings(rings);
  const w = (modules + 2 * quiet) * moduleMm, h = kind.twoD ? w : spec.height_mm + 2 * quiet * moduleMm;
  if (spec.invert) {
    const fr: Ring = [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]];
    rings = solidRings([fr, ...rings.map((r) => r.slice().reverse())]);
  }
  const min = minModuleMm(nozzle);
  const ok = moduleMm >= min - 1e-9;
  const pattern = patternOf(id, `${kind.name}: ${spec.text.slice(0, 20)}`, [{ color: spec.color, rings }], { kind: 'code', spec });
  // the quiet zone is part of the artwork (printed in the base colour): keep it in the bounds
  pattern.origin = [0, 0];
  pattern.bounds = [-w / 2, -h / 2, w / 2, h / 2];
  return {
    pattern, modules, moduleMm, ok,
    message: ok ? `${modules} modules · ${moduleMm.toFixed(2)} mm each` : `Modules are ${moduleMm.toFixed(2)} mm — at least ${min.toFixed(2)} mm (2 × nozzle) scans reliably. Make it ≥ ${(min * (modules + 2 * quiet)).toFixed(1)} mm wide or shorten the text.`,
  };
}

// ---------- Braille (Grade 1 / uncontracted, ADA 703.3 sizes)
/** Dots 1–6 per character (bit k = dot k+1). */
const BRAILLE: Record<string, number[]> = {
  a: [1], b: [1, 2], c: [1, 4], d: [1, 4, 5], e: [1, 5], f: [1, 2, 4], g: [1, 2, 4, 5], h: [1, 2, 5], i: [2, 4], j: [2, 4, 5],
  k: [1, 3], l: [1, 2, 3], m: [1, 3, 4], n: [1, 3, 4, 5], o: [1, 3, 5], p: [1, 2, 3, 4], q: [1, 2, 3, 4, 5], r: [1, 2, 3, 5], s: [2, 3, 4], t: [2, 3, 4, 5],
  u: [1, 3, 6], v: [1, 2, 3, 6], w: [2, 4, 5, 6], x: [1, 3, 4, 6], y: [1, 3, 4, 5, 6], z: [1, 3, 5, 6],
  ',': [2], ';': [2, 3], ':': [2, 5], '.': [2, 5, 6], '!': [2, 3, 5], '?': [2, 3, 6], "'": [3], '-': [3, 6],
};
const NUMBER_SIGN = [3, 4, 5, 6], CAPITAL = [6];
const DIGIT_LETTER = 'jabcdefghi';

/** ADA 703.3.1 (inches → mm): dot base 1.5–1.6, height 0.6–0.9, dot spacing 2.3–2.5, cell spacing 6.1–7.6, line spacing 10–10.2. */
export const ADA = { dot_mm: 1.55, height_mm: 0.75, dot_spacing_mm: 2.4, cell_spacing_mm: 6.4, line_spacing_mm: 10.1 };

/** Text → cells (each a set of dots 1–6), with capital and number signs. */
export function brailleCells(text: string): number[][] {
  const out: number[][] = [];
  for (const word of text.split(/(\s+)/)) {
    if (/^\s+$/.test(word)) { out.push([]); continue; }
    let inNumber = false;
    for (const ch of word) {
      if (/[0-9]/.test(ch)) { if (!inNumber) { out.push(NUMBER_SIGN); inNumber = true; } out.push(BRAILLE[DIGIT_LETTER[Number(ch)]]); continue; }
      inNumber = false;
      const lo = ch.toLowerCase();
      if (ch !== lo) out.push(CAPITAL);
      out.push(BRAILLE[lo] ?? [1, 2, 3, 4, 5, 6]);
    }
  }
  return out;
}

export interface BrailleSpec { text: string; color: string; scale: number }
export const defaultBrailleSpec = (): BrailleSpec => ({ text: 'Exit', color: '#2f2f33', scale: 1 });

/** Braille dots as a pattern (meant to be raised by ADA.height_mm on a single-colour printer). */
export function braillePattern(spec: BrailleSpec, id: string): Pattern {
  const k = spec.scale || 1;
  const rings: Ring[] = [];
  spec.text.split(/\r?\n/).forEach((line, li) => {
    brailleCells(line).forEach((cell, ci) => {
      for (const d of cell) {
        const col = d <= 3 ? 0 : 1, row = (d - 1) % 3;
        const x = (ci * ADA.cell_spacing_mm + col * ADA.dot_spacing_mm) * k;
        const y = (-li * ADA.line_spacing_mm - row * ADA.dot_spacing_mm) * k;
        rings.push(circle(x, y, (ADA.dot_mm / 2) * k, 24));
      }
    });
  });
  return patternOf(id, `Braille: ${spec.text.slice(0, 20)}`, [{ color: spec.color, rings }], { kind: 'braille', spec });
}
