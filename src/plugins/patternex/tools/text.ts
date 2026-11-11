// Live text → artwork. Glyph outlines come from bundled open-licence fonts (or a font file the user adds),
// laid out with size, tracking, kerning, line height and alignment, optionally bent on an arc.
// Variable fields ({name}, {serial}, {date}, {lot} …) are filled per copy from a CSV batch or counters.
import opentype from 'opentype.js';
import type { Pattern, Ring } from '../model';
import { offsetRings, patternOf, solidRings, thinFeatures } from './shape';

export interface FontEntry { id: string; name: string; licence: string; url?: string; font?: opentype.Font }

/** Bundled fonts (SIL OFL 1.1, Roboto Mono: Apache 2.0). URLs are resolved by the bundler. */
export const BUNDLED_FONTS: FontEntry[] = [
  { id: 'inter', name: 'Inter Bold', licence: 'OFL-1.1', url: new URL('./fonts/inter.woff', import.meta.url).href },
  { id: 'oswald', name: 'Oswald SemiBold', licence: 'OFL-1.1', url: new URL('./fonts/oswald.woff', import.meta.url).href },
  { id: 'roboto-mono', name: 'Roboto Mono Bold', licence: 'Apache-2.0', url: new URL('./fonts/roboto-mono.woff', import.meta.url).href },
  { id: 'allerta-stencil', name: 'Allerta Stencil', licence: 'OFL-1.1', url: new URL('./fonts/allerta-stencil.woff', import.meta.url).href },
  { id: 'pacifico', name: 'Pacifico (script)', licence: 'OFL-1.1', url: new URL('./fonts/pacifico.woff', import.meta.url).href },
];

const loaded = new Map<string, opentype.Font>();
export const fontList = (): FontEntry[] => [...BUNDLED_FONTS, ...[...loaded.keys()].filter((k) => k.startsWith('user:')).map((k) => ({ id: k, name: loaded.get(k)!.names.fullName?.en ?? k.slice(5), licence: 'user' }))];

/** Raw bytes of fonts the user added, so projects can carry them. */
const userBytes = new Map<string, Uint8Array>();

export function registerFont(id: string, buf: ArrayBuffer): opentype.Font {
  const f = opentype.parse(buf);
  loaded.set(id, f);
  if (id.startsWith('user:')) userBytes.set(id, new Uint8Array(buf.slice(0)));
  return f;
}

const toB64 = (b: Uint8Array) => { let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); };
const fromB64 = (s: string) => { const bin = atob(s); const b = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i); return b; };

/** Base64 of a user font (for embedding in a project), or undefined for bundled / unknown fonts. */
export const userFontData = (id: string): string | undefined => { const b = userBytes.get(id); return b ? toB64(b) : undefined; };

/** Register a font embedded in a project (no-op when already loaded). Returns false if it cannot be read. */
export function restoreFont(id: string, b64: string): boolean {
  if (loaded.has(id)) return true;
  try { const b = fromB64(b64); registerFont(id, b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer); return true; } catch { return false; }
}
export const fontById = (id: string) => loaded.get(id);

export async function loadFont(id: string): Promise<opentype.Font> {
  const hit = loaded.get(id);
  if (hit) return hit;
  const e = BUNDLED_FONTS.find((f) => f.id === id);
  if (!e?.url) throw new Error(`Font ${id} is not available`);
  const buf = await (await fetch(e.url)).arrayBuffer();
  return registerFont(id, buf);
}

export interface TextSpec {
  text: string;
  font: string;
  /** Cap height is not used: size is the font size (em) in mm. */
  size_mm: number;
  /** Extra space between letters, in 1/1000 em (like design tools). */
  tracking: number;
  kerning: boolean;
  /** Line spacing as a multiple of the size. */
  line_height: number;
  align: 'left' | 'center' | 'right';
  /** Bend the baseline on a circle of this radius (mm); 0 = straight. Negative bends the other way. */
  arc_radius_mm: number;
  /** Outline growth (mm) — bold up thin fonts for printing. */
  weight_mm: number;
  color: string;
}

export const defaultTextSpec = (): TextSpec => ({ text: 'NexSpiro', font: 'inter', size_mm: 8, tracking: 0, kerning: true, line_height: 1.2, align: 'center', arc_radius_mm: 0, weight_mm: 0, color: '#2f2f33' });

/** Fill {field} placeholders. Unknown fields stay as written so the user sees them. */
export function fillFields(template: string, values: Record<string, string>): string {
  return template.replace(/\{([a-z0-9_]+)(?::(\d+))?\}/gi, (m, k: string, pad?: string) => {
    const v = values[k.toLowerCase()];
    if (v === undefined) return m;
    return pad && /^\d+$/.test(v) ? v.padStart(Number(pad), '0') : v;
  });
}
export const fieldsOf = (template: string) => [...new Set([...template.matchAll(/\{([a-z0-9_]+)(?::\d+)?\}/gi)].map((m) => m[1].toLowerCase()))];

/** Minimal CSV (RFC 4180 quoting). First row = field names (lower-cased). */
export function parseCsv(src: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', q = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) { if (c === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; continue; }
    if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && src[i + 1] === '\n') i++; row.push(cell); cell = ''; if (row.some((x) => x !== '')) rows.push(row); row = []; }
    else cell += c;
  }
  row.push(cell); if (row.some((x) => x !== '')) rows.push(row);
  if (rows.length < 2) return [];
  const head = rows[0].map((h) => h.trim().toLowerCase());
  return rows.slice(1).map((r) => Object.fromEntries(head.map((h, k) => [h, (r[k] ?? '').trim()])));
}

/** Values for copy n of a batch: serial counter, today's date, and the CSV row when there is one. */
export function batchValues(n: number, o: { start: number; step: number; lot?: string; row?: Record<string, string>; date?: Date }): Record<string, string> {
  const d = o.date ?? new Date();
  const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { serial: String(o.start + n * o.step), date: iso, lot: o.lot ?? '', n: String(n + 1), ...(o.row ?? {}) };
}

/** Flatten an opentype path into rings (curves at `tol` mm). Y is flipped to Y-up. */
function pathRings(cmds: opentype.PathCommand[], tol: number): Ring[] {
  const rings: Ring[] = [];
  let cur: Ring = [];
  let x = 0, y = 0;
  const push = (px: number, py: number) => cur.push([px, -py]);
  const steps = (len: number) => Math.max(2, Math.min(32, Math.ceil(Math.sqrt(len / Math.max(tol, 1e-3)))));
  for (const c of cmds) {
    if (c.type === 'M') { if (cur.length >= 3) rings.push(cur); cur = []; x = c.x; y = c.y; push(x, y); }
    else if (c.type === 'L') { x = c.x; y = c.y; push(x, y); }
    else if (c.type === 'Q') {
      const n = steps(Math.hypot(c.x1 - x, c.y1 - y) + Math.hypot(c.x - c.x1, c.y - c.y1));
      for (let k = 1; k <= n; k++) { const t = k / n, u = 1 - t; push(u * u * x + 2 * u * t * c.x1 + t * t * c.x, u * u * y + 2 * u * t * c.y1 + t * t * c.y); }
      x = c.x; y = c.y;
    } else if (c.type === 'C') {
      const n = steps(Math.hypot(c.x1 - x, c.y1 - y) + Math.hypot(c.x2 - c.x1, c.y2 - c.y1) + Math.hypot(c.x - c.x2, c.y - c.y2));
      for (let k = 1; k <= n; k++) {
        const t = k / n, u = 1 - t;
        push(u * u * u * x + 3 * u * u * t * c.x1 + 3 * u * t * t * c.x2 + t * t * t * c.x, u * u * u * y + 3 * u * u * t * c.y1 + 3 * u * t * t * c.y2 + t * t * t * c.y);
      }
      x = c.x; y = c.y;
    } else if (c.type === 'Z') { if (cur.length >= 3) rings.push(cur); cur = []; }
  }
  if (cur.length >= 3) rings.push(cur);
  // drop a repeated closing point
  return rings.map((r) => (r.length > 3 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1] ? r.slice(0, -1) : r));
}

export interface TextLayout { rings: Ring[]; width: number; height: number; lines: number }

/** Lay out text with a font: rings in mm, Y up, first baseline at y = 0. */
export function layoutText(font: opentype.Font, spec: TextSpec): TextLayout {
  const size = Math.max(0.5, spec.size_mm);
  const lines = spec.text.split(/\r?\n/);
  const scale = size / font.unitsPerEm;
  const track = (spec.tracking / 1000) * size;
  const placed: { rings: Ring[]; width: number }[] = [];
  for (const line of lines) {
    const glyphs = font.stringToGlyphs(line);
    let x = 0;
    const rings: Ring[] = [];
    glyphs.forEach((g, k) => {
      const p = g.getPath(x, 0, size);
      rings.push(...pathRings(p.commands, 0.02));
      let adv = (g.advanceWidth ?? 0) * scale;
      if (spec.kerning && k < glyphs.length - 1) adv += font.getKerningValue(g, glyphs[k + 1]) * scale;
      x += adv + track;
    });
    placed.push({ rings, width: Math.max(0, x - track) });
  }
  const W = Math.max(...placed.map((p) => p.width), 0);
  const out: Ring[] = [];
  placed.forEach((p, li) => {
    const dx = spec.align === 'left' ? 0 : spec.align === 'right' ? W - p.width : (W - p.width) / 2;
    const dy = -li * size * spec.line_height;
    for (const r of p.rings) out.push(r.map(([x, y]) => [x + dx, y + dy] as [number, number]));
  });
  let rings = out;
  if (spec.arc_radius_mm) rings = arcRings(rings, W, spec.arc_radius_mm);
  return { rings, width: W, height: size * (1 + (lines.length - 1) * spec.line_height), lines: lines.length };
}

/**
 * Bend text on a circle: x along the baseline becomes arc length, y becomes radial offset.
 * R > 0 curves the baseline up like a smile turned over (text on top of a circle); R < 0 the other way.
 * Lengths along the baseline are kept (arc length = x), so letters do not stretch.
 */
export function arcRings(rings: Ring[], width: number, R: number): Ring[] {
  const r0 = Math.abs(R), sgn = Math.sign(R) || 1, cx = width / 2;
  return rings.map((r) => r.map(([x, y]) => {
    const a = (x - cx) / r0;
    const rad = r0 + sgn * y;
    return [rad * Math.sin(a), sgn * (rad * Math.cos(a) - r0)] as [number, number];
  }));
}

/** Text spec → pattern (one ink group), plus the minimum-stroke check against the nozzle. */
export function textPattern(font: opentype.Font, spec: TextSpec, id: string, nozzle = 0.4): { pattern: Pattern; minStroke: { min: number; lostShare: number; ok: boolean } } {
  const lay = layoutText(font, spec);
  let rings = solidRings(lay.rings);
  if (spec.weight_mm) rings = solidRings(offsetOrSame(rings, spec.weight_mm));
  const min = 2 * nozzle;
  const t = thinFeatures(rings, min);
  const name = spec.text.length > 24 ? spec.text.slice(0, 24) + '…' : spec.text || 'Text';
  return {
    pattern: patternOf(id, `Text: ${name}`, [{ color: spec.color, rings }], { kind: 'text', spec }),
    minStroke: { min, lostShare: t.lostShare, ok: t.lostShare < 0.02 },
  };
}

const offsetOrSame = (r: Ring[], d: number) => (d ? offsetRings(r, d) : r);
