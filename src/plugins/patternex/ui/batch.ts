// Batch personalisation: copies of an object, each with its text / code / Braille artwork filled from a
// CSV row or a serial counter. The first row goes on the original object.
import { useStore, newId, type SceneObject } from '../../../state/store';
import { arrange } from '../../../state/ops';
import type { Pattern } from '../model';
import { batchValues, fillFields, loadFont, parseCsv, textPattern, type TextSpec } from '../tools/text';
import { codePattern, braillePattern, type BrailleSpec, type CodeSpec } from '../tools/codes';
import { printerById } from '../../../profiles/printers';
import { addPattern, type ObjectPatternex } from './state';
import { px, changed } from './PatternexPanel';

/** Rebuild generated artwork with its template text filled in. */
export async function regenerate(pat: Pattern, values: Record<string, string>, id: string): Promise<Pattern | null> {
  const m = pat.meta;
  if (!m) return null;
  const nozzle = Number(printerById(useStore.getState().printerId).machine.nozzle_diameter ?? 0.4) || 0.4;
  if (m.kind === 'text') {
    const spec = m.spec as TextSpec;
    const font = await loadFont(spec.font);
    return { ...textPattern(font, { ...spec, text: fillFields(spec.text, values) }, id, nozzle).pattern, meta: m };
  }
  if (m.kind === 'code') { const spec = m.spec as CodeSpec; return { ...codePattern({ ...spec, text: fillFields(spec.text, values) }, id, nozzle).pattern, meta: m }; }
  if (m.kind === 'braille') { const spec = m.spec as BrailleSpec; return { ...braillePattern({ ...spec, text: fillFields(spec.text, values) }, id), meta: m }; }
  return null;
}

/** Returns the number of objects that carry personalised artwork. */
export async function runBatch(placementId: string, o: { csv: string; count: number; start: number; step: number; lot?: string }): Promise<number> {
  const s = useStore.getState();
  const pl = px.placements.find((p) => p.id === placementId);
  const pat = pl && px.patterns.find((p) => p.id === pl.pattern_id);
  const obj = pl && s.objects.find((x) => x.id === pl.object_id);
  if (!pl || !pat || !obj) return 0;
  const rows = o.csv ? parseCsv(o.csv) : [];
  const n = rows.length || o.count;
  const made: Pattern[] = [];
  for (let k = 0; k < n; k++) {
    const p = await regenerate(pat, batchValues(k, { start: o.start, step: o.step, lot: o.lot, row: rows[k] }), `${pat.id.split('#')[0]}#${k + 1}`);
    if (!p) return 0;
    made.push(p);
  }
  made.forEach((p) => addPattern(px, p));
  // the original object takes the first value; copies take the rest
  const swap = (pe: ObjectPatternex, p: Pattern, plId: string): ObjectPatternex => ({
    placements: pe.placements.map((x) => (x.id === placementId ? { ...structuredClone(x), id: plId, pattern_id: p.id } : structuredClone(x))),
    actions: pe.actions.map((a) => (a.region_ref.placement_id === placementId ? { ...structuredClone(a), region_ref: { ...a.region_ref, placement_id: plId } } : structuredClone(a))),
    patterns: [...(pe.patterns ?? []).filter((x) => x.id !== pat.id), p],
  });
  const pe = obj.patternex!;
  const copies: SceneObject[] = made.slice(1).map((p, k) => {
    const id = newId();
    return { ...obj, id, name: `${obj.name} (${k + 2})`, position: [obj.position[0] + 6 * (k + 1), obj.position[1] + 6 * (k + 1), obj.position[2]], patternex: swap(pe, p, `${placementId.split('~')[0]}-b${k + 2}`) };
  });
  s.updateObjects((x) => ({ ...x, patternex: swap(pe, made[0], placementId) }), [obj.id]);
  if (copies.length) { useStore.getState().addObjects(copies); arrange(); }
  changed(false);
  return n;
}
