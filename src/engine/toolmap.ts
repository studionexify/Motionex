// Filament slot → physical head on a tool changer. The slicer writes slot n as head n (T<n>, M104 T<n>…);
// at send time the user may have loaded the colours on other heads (the Print dialog, like Bambu's AMS mapping),
// so the tool numbers in the finished G-code are rewritten. Only the command part of a line is touched.

import { toolMapOf } from '../profiles/changer';

/** Parses "2,0,1,3" into [2,0,1,3]; blanks and junk keep the identity for that slot. */
export const parseToolMap = (v: unknown): number[] => toolMapOf({ changer_type: 'toolchanger', tool_map: String(v ?? '') });

/** True when the map sends every slot to its own head. */
export const isIdentityMap = (map: number[]) => map.every((h, k) => h === k);

/** Problems with a map for the slots a print uses (two slots on one head, a head the printer lacks). */
export function toolMapProblems(map: number[], usedSlots: number[], heads: number): string[] {
  const out: string[] = [];
  const at = (k: number) => map[k] ?? k;
  const seen = new Map<number, number>();
  for (const k of usedSlots) {
    const h = at(k);
    if (h >= heads) out.push(`Filament ${k + 1} is mapped to head T${h}, the printer has ${heads} heads (T0–T${heads - 1}).`);
    const other = seen.get(h);
    if (other !== undefined) out.push(`Filaments ${other + 1} and ${k + 1} are both mapped to head T${h}.`);
    else seen.set(h, k);
  }
  return out;
}

const TOOL_LINE = /^(\s*)T(\d+)(?=\s|;|$)/;
const TEMP_CMD = /^\s*(M104|M109|M106|M107|M568|M221|M218|G10)\b/i;

/** Rewrites tool numbers in G-code: T<n> lines and the T parameter of temperature / fan / offset commands. */
export function remapTools(gcode: string, map: number[]): string {
  if (!map.length || isIdentityMap(map)) return gcode;
  const to = (n: string) => String(map[Number(n)] ?? Number(n));
  return gcode.split('\n').map((line) => {
    const c = line.indexOf(';');
    const cmd = c >= 0 ? line.slice(0, c) : line;
    const rest = c >= 0 ? line.slice(c) : '';
    let out = cmd;
    if (TOOL_LINE.test(cmd)) out = cmd.replace(TOOL_LINE, (_, sp, n) => `${sp}T${to(n)}`);
    else if (TEMP_CMD.test(cmd)) out = cmd.replace(/(\s)T(\d+)\b/g, (_, sp, n) => `${sp}T${to(n)}`);
    return out === cmd ? line : out + rest;
  }).join('\n');
}

// ----- Filament printing sequence per layer (Bambu Studio's plate setting "filament sequence for different layers").
// Slots are 0-based here; layers in ranges are 1-based and inclusive (layer 1 = first layer), as in Bambu.

/** A custom order for a range of layers; `to` 0 = up to the last layer. */
export interface LayerSeqRange { from: number; to: number; order: number[] }
/** Resolved sequence passed to the slicer. A missing field means Auto (current tool first, then ascending). */
export interface FilamentSequence {
  first?: number[];
  other?: number[];
  /** Overrides for other layers; a later range wins over an earlier one. */
  ranges?: LayerSeqRange[];
}

/** The custom order for 0-based layer `layer`, or undefined for Auto. */
export function sequenceForLayer(seq: FilamentSequence | undefined, layer: number): number[] | undefined {
  if (!seq) return undefined;
  if (layer === 0) return seq.first?.length ? seq.first : undefined;
  const n = layer + 1;
  for (let k = (seq.ranges?.length ?? 0) - 1; k >= 0; k--) {
    const r = seq.ranges![k];
    if (r.order.length && n >= r.from && (r.to <= 0 || n <= r.to)) return r.order;
  }
  return seq.other?.length ? seq.other : undefined;
}

/**
 * Order of the filaments printed on a layer. Auto: the loaded tool first (no change), then ascending.
 * Custom: the filaments present on the layer in the user's order; ones missing from the order follow, in Auto order.
 */
export function orderLayerTools(fils: Iterable<number>, cur: number, layer: number, seq?: FilamentSequence): number[] {
  const auto = (a: number, b: number) => (a === cur ? -1 : b === cur ? 1 : a - b);
  const list = [...fils];
  const custom = sequenceForLayer(seq, layer);
  if (!custom) return list.sort(auto);
  const rank = (f: number) => { const i = custom.indexOf(f); return i < 0 ? Infinity : i; };
  return list.sort((a, b) => (rank(a) - rank(b)) || (rank(a) === Infinity ? auto(a, b) : 0));
}

/** Bambu's "huge" end layer (INT_MAX - 1 after its loader's fix-up): the range runs to the last layer. */
const BAMBU_END = 2147483646;

/** Bambu plate metadata values (1-based filaments; 0 = Auto) from a sequence. */
export function sequenceToBambu(seq: FilamentSequence | undefined): Record<string, string> {
  const first = seq?.first?.length ? seq.first.map((f) => f + 1) : [0];
  const rows: LayerSeqRange[] = [];
  if (seq?.other?.length) rows.push({ from: 2, to: 0, order: seq.other });
  for (const r of seq?.ranges ?? []) if (r.order.length) rows.push(r);
  // Bambu splits the flat list into equal rows: pad shorter orders by repeating their last filament
  const w = Math.max(0, ...rows.map((r) => r.order.length));
  const flat = rows.flatMap((r) => [Math.max(1, r.from), r.to <= 0 ? BAMBU_END : r.to, ...r.order.map((f) => f + 1), ...Array(w - r.order.length).fill(r.order[r.order.length - 1] + 1)]);
  return {
    first_layer_print_sequence: first.join(' '),
    other_layers_print_sequence: rows.length ? flat.join(' ') : '0',
    other_layers_print_sequence_nums: String(rows.length),
    first_layer_sequence_choice: seq?.first?.length ? 'Customize' : 'Auto',
    other_layers_sequence_choice: rows.length ? 'Customize' : 'Auto',
  };
}

/** Reads Bambu plate metadata (see sequenceToBambu); undefined when everything is Auto. */
export function sequenceFromBambu(md: Record<string, string | undefined>): FilamentSequence | undefined {
  const ints = (s?: string) => (s ?? '').trim().split(/[\s,]+/).filter(Boolean).map(Number).filter((n) => Number.isFinite(n));
  const dedupe = (a: number[]) => [...new Set(a.filter((f) => f >= 1).map((f) => f - 1))];
  const out: FilamentSequence = {};
  const first = ints(md.first_layer_print_sequence);
  if (md.first_layer_sequence_choice !== 'Auto' && first.some((f) => f > 0)) out.first = dedupe(first);
  const flat = ints(md.other_layers_print_sequence), n = Math.round(+(md.other_layers_print_sequence_nums ?? 0));
  if (md.other_layers_sequence_choice !== 'Auto' && n > 0 && flat.length >= n * 3 && flat.length % n === 0) {
    const w = flat.length / n;
    for (let k = 0; k < n; k++) {
      const row = flat.slice(k * w, (k + 1) * w);
      const from = row[0], to = row[1] >= BAMBU_END ? 0 : row[1], order = dedupe(row.slice(2));
      if (!order.length) continue;
      if (from <= 2 && to === 0 && !out.other && !out.ranges) out.other = order;
      else (out.ranges ??= []).push({ from, to, order });
    }
  }
  return out.first || out.other || out.ranges ? out : undefined;
}
