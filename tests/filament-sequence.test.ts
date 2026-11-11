// Plate filament printing sequence (Bambu's first_layer_print_sequence / other_layers_print_sequence):
// Auto keeps the loaded filament first; Custom prints each layer's filaments in the user's order.
import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { slice, slotFromConfig } from '../src/engine/slicer';
import { weld } from '../src/engine/mesh';
import { resolveConfig } from '../src/profiles/resolve';
import { orderLayerTools, sequenceForLayer, sequenceFromBambu, sequenceToBambu, type FilamentSequence } from '../src/engine/toolmap';
import { parse3MF } from '../src/io/threemf';
import { plateSettingsXml } from '../src/state/project';
import { box } from './fixtures';

function run(filamentSequence?: FilamentSequence) {
  const c = resolveConfig({ printerId: 'generic-klipper-mmu', plate: 'textured_pei_plate', filamentId: 'generic-pla', presetId: '0.20', overrides: {} as never, machineOverrides: {} });
  const a = slotFromConfig(c);
  const filaments = [0, 1, 2].map((k) => ({ ...a, color: ['#ffffff', '#cc2222', '#2244cc'][k] }));
  const meshes = [0, 1, 2].map((k) => ({ id: `b${k}`, name: `b${k}`, ...weld(box(60 + k * 22, 60, 0, 12, 12, 1.2)), filament: k }));
  return slice(meshes, c, () => {}, { filaments, filamentSequence });
}
/** Tool selections (T lines) per layer. */
const toolsPerLayer = (g: string) => g.split(';LAYER_CHANGE').slice(1).map((l) => [...l.matchAll(/^T(\d+)/gm)].map((m) => +m[1]));

describe('filament printing sequence', () => {
  it('orderLayerTools: auto, custom, missing filaments, ranges', () => {
    expect(orderLayerTools([2, 0, 1], 1, 3)).toEqual([1, 0, 2]);
    const seq: FilamentSequence = { first: [2, 0, 1], other: [1, 2, 0], ranges: [{ from: 3, to: 4, order: [0, 2, 1] }, { from: 4, to: 0, order: [2, 1, 0] }] };
    expect(orderLayerTools([0, 1, 2], 0, 0, seq)).toEqual([2, 0, 1]);
    expect(orderLayerTools([0, 2], 0, 1, seq)).toEqual([2, 0]); // absent ones skipped
    expect(sequenceForLayer(seq, 2)).toEqual([0, 2, 1]); // layer 3
    expect(sequenceForLayer(seq, 3)).toEqual([2, 1, 0]); // layer 4: the later range wins
    expect(sequenceForLayer(seq, 50)).toEqual([2, 1, 0]);
    expect(orderLayerTools([3, 1, 0], 3, 1, { other: [1] })).toEqual([1, 3, 0]); // unlisted: auto order after
    expect(sequenceForLayer({ first: [1] }, 1)).toBeUndefined();
  });

  it('Auto is unchanged', () => {
    const a = run(), b = run({});
    expect(b.gcode).toBe(a.gcode);
    expect(toolsPerLayer(a.gcode)[1]).toEqual([0, 1]); // T2 stays loaded first
  });

  it('custom first-layer and other-layer orders change the G-code tool order', () => {
    const out = run({ first: [2, 1, 0], other: [1, 0, 2] });
    const t = toolsPerLayer(out.gcode);
    expect(t[0]).toEqual([2, 1, 0]);
    expect(t[1]).toEqual([1, 0, 2]);
    expect(t[2]).toEqual([1, 0, 2]);
    const changes = t.flat().length - 1;
    expect(out.stats.toolChanges).toBeGreaterThanOrEqual(changes);
    expect(out.gcode).toMatch(/;TYPE:prime tower/);
    expect(out.stats.towerGrams).toBeGreaterThan(0);
  });

  it('layer-range overrides', () => {
    const t = toolsPerLayer(run({ other: [1, 0, 2], ranges: [{ from: 3, to: 4, order: [0, 2, 1] }] }).gcode);
    expect(t[1]).toEqual([1, 0, 2]);
    expect(t[2]).toEqual([0, 2, 1]);
    expect(t[3]).toEqual([0, 2, 1]); // layer 4: the range again, although 1 is loaded
    expect(t[4]).toEqual([0, 2]); // layer 5: back to the other-layers order, 1 still loaded
  });

  it('Bambu metadata round trip', () => {
    const seq: FilamentSequence = { first: [1, 0], other: [0, 1], ranges: [{ from: 5, to: 9, order: [1, 0] }] };
    const md = sequenceToBambu(seq);
    expect(md.first_layer_print_sequence).toBe('2 1');
    expect(md.other_layers_print_sequence_nums).toBe('2');
    expect(md.other_layers_print_sequence).toBe('2 2147483646 1 2 5 9 2 1');
    expect(sequenceFromBambu(md)).toEqual(seq);
    expect(sequenceFromBambu(sequenceToBambu(undefined))).toBeUndefined();
    // as Bambu writes an Auto plate
    expect(sequenceFromBambu({ first_layer_print_sequence: '0', other_layers_print_sequence: '0', other_layers_print_sequence_nums: '0' })).toBeUndefined();
  });

  it('3MF plate settings round trip', async () => {
    const seq: FilamentSequence = { first: [2, 0, 1], other: [1, 2, 0], ranges: [{ from: 10, to: 0, order: [0, 1, 2] }] };
    const cube = '<mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="10" y="0" z="0"/><vertex x="0" y="10" z="0"/><vertex x="0" y="0" z="10"/></vertices><triangles><triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="1" v3="3"/><triangle v1="1" v2="2" v3="3"/><triangle v1="0" v2="3" v3="2"/></triangles></mesh>';
    const z = new JSZip();
    z.file('3D/3dmodel.model', `<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model">${cube}</object><object id="2" type="model">${cube}</object></resources><build><item objectid="1"/><item objectid="2"/></build></model>`);
    z.file('Metadata/model_settings.config', plateSettingsXml([
      { id: 'a', name: 'Plate 1', layerActions: [] },
      { id: 'b', name: 'Plate "2"', layerActions: [], filamentSequence: seq },
    ], [0, 1]));
    const r = await parse3MF((await z.generateAsync({ type: 'uint8array' })).buffer as ArrayBuffer);
    expect(r.plateCount).toBe(2);
    expect(r.plateSequences?.[0]).toBeUndefined();
    expect(r.plateSequences?.[1]).toEqual(seq);
    expect(r.objects.map((o) => o.plate)).toEqual([0, 1]);
  });
});
