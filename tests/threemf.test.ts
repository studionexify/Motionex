// 3MF import: plain, Orca / Bambu style (components in separate files, painted colour, per-part filament), core materials.
import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { parse3MF, paintState, paintSplit } from '../src/io/threemf';
import { loadModelFile } from '../src/io/load';

const cube = (s = 10) => {
  const v = [[0,0,0],[s,0,0],[s,s,0],[0,s,0],[0,0,s],[s,0,s],[s,s,s],[0,s,s]];
  const t = [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]];
  return { v, t };
};
const meshXml = (paint?: (i: number) => string | undefined, extra = '') => {
  const { v, t } = cube();
  return `<mesh><vertices>${v.map((p) => `<vertex x="${p[0]}" y="${p[1]}" z="${p[2]}"/>`).join('')}</vertices><triangles>${t.map((x, i) => `<triangle v1="${x[0]}" v2="${x[1]}" v3="${x[2]}"${paint?.(i) ? ` paint_color="${paint(i)}"` : ''}${extra}/>`).join('\n')}</triangles></mesh>`;
};
const NS = 'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06"';
async function zip(files: Record<string, string>) {
  const z = new JSZip();
  for (const [k, v] of Object.entries(files)) z.file(k, v);
  const b = await z.generateAsync({ type: 'uint8array' });
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

describe('3MF import', () => {
  it('reads the painted-triangle code', () => {
    expect(paintState('4')).toBe(1);
    expect(paintState('8')).toBe(2);
    expect(paintState('0C')).toBe(3);
    expect(paintState('1C')).toBe(4);
    // split in 2: children 8 and 8 → 2
    expect(paintState('881')).toBe(2);
  });

  it('splits a painted triangle into its painted pieces', () => {
    const area = (p: number[][]) => { const u = [0, 1, 2].map((k) => p[1][k] - p[0][k]), v = [0, 1, 2].map((k) => p[2][k] - p[0][k]); return Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2; };
    const out: { p: [number, number, number][]; st: number }[] = [];
    // 3-side split: children (read last-first) 4, 8, 4, 0C → states 1, 2, 1, 3; the second child read splits again in 2
    paintSplit('4' + '0C' + '4' + '84' + '1' + '3', [0, 0, 0], [8, 0, 0], [0, 8, 0], out as never);
    expect(out.length).toBe(5);
    expect(out.reduce((s, l) => s + area(l.p), 0)).toBeCloseTo(32, 6);
    expect(new Set(out.map((l) => l.st))).toEqual(new Set([1, 2, 3]));
  });

  it('opens a plain 3MF with a transform', async () => {
    const buf = await zip({ '3D/3dmodel.model': `<?xml version="1.0"?><model unit="millimeter" ${NS}><resources><object id="1" type="model">${meshXml()}</object></resources><build><item objectid="1" transform="1 0 0 0 1 0 0 0 1 50 0 0"/></build></model>` });
    const r = await parse3MF(buf);
    expect(r.objects).toHaveLength(1);
    expect(r.objects[0].soup.length).toBe(12 * 9);
    expect(Math.min(...Array.from(r.objects[0].soup).filter((_, i) => i % 3 === 0))).toBe(50);
    expect(r.objects[0].color).toBeUndefined();
  });

  it('opens an Orca / Bambu multi-colour project: painted faces, part filaments, modifiers left out', async () => {
    const buf = await zip({
      '_rels/.rels': `<Relationships><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`,
      '3D/3dmodel.model': `<model unit="millimeter" ${NS} requiredextensions="p"><resources>
        <object id="5" p:UUID="a" type="model"><components>
          <component p:path="/3D/Objects/object_1.model" objectid="1" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>
          <component p:path="/3D/Objects/object_1.model" objectid="2" transform="1 0 0 0 1 0 0 0 1 20 0 0"/>
          <component p:path="/3D/Objects/object_1.model" objectid="3" transform="1 0 0 0 1 0 0 0 1 40 0 0"/>
        </components></object>
        <object id="6" type="model"><components><component p:path="/3D/Objects/object_2.model" objectid="1"/></components></object>
      </resources><build><item objectid="5" printable="1"/><item objectid="6" transform="1 0 0 0 1 0 0 0 1 0 60 0"/></build></model>`,
      '3D/Objects/object_1.model': `<model unit="millimeter" ${NS}><resources>
        <object id="1" type="model">${meshXml((i) => (i < 2 ? '8' : i < 4 ? '0C' : undefined))}</object>
        <object id="2" type="model">${meshXml()}</object>
        <object id="3" type="model">${meshXml()}</object>
      </resources></model>`,
      '3D/Objects/object_2.model': `<model unit="millimeter" ${NS}><resources><object id="1" type="model">${meshXml()}</object></resources></model>`,
      'Metadata/model_settings.config': `<?xml version="1.0"?><config>
        <object id="5"><metadata key="name" value="Vase &amp; lid"/><metadata key="extruder" value="1"/>
          <part id="1" subtype="normal_part"><metadata key="extruder" value="1"/></part>
          <part id="2" subtype="normal_part"><metadata key="extruder" value="4"/></part>
          <part id="3" subtype="modifier_part"><metadata key="extruder" value="2"/></part>
        </object>
        <object id="6"><metadata key="extruder" value="2"/></object>
      </config>`,
      'Metadata/project_settings.config': JSON.stringify({ filament_colour: ['#FFFFFF', '#FF0000', '#00FF00', '#0000FF'] }),
    });
    const r = await parse3MF(buf);
    expect(r.filamentColors).toEqual(['#FFFFFF', '#FF0000', '#00FF00', '#0000FF']);
    expect(r.objects).toHaveLength(2);
    const [a, b] = r.objects;
    expect(a.soup.length).toBe(24 * 9); // modifier part left out
    expect(Array.from(a.color!.slice(0, 6))).toEqual([2, 2, 3, 3, 1, 1]);
    expect(a.color![12]).toBe(4); // second part on filament 4
    expect(b.color).toBeUndefined();
    expect(b.filament).toBe(1);
    expect(a.name).toBe("Vase & lid");

    const models = await loadModelFile('vase.3mf', buf);
    expect(models[0].color).toBeDefined();
    expect(models[0].color!.length).toBe(models[0].mesh.indices.length / 3);
    expect(models[0].mesh.faceGroups).toBeUndefined();
    expect(models[1].filament).toBe(1);
  });

  it('maps core 3MF materials to slots', async () => {
    const { v, t } = cube();
    const buf = await zip({ '3D/3dmodel.model': `<model ${NS}><resources><basematerials id="9"><base name="R" displaycolor="#FF0000FF"/><base name="B" displaycolor="#0000FFFF"/></basematerials>
      <object id="1" type="model" pid="9" pindex="0"><mesh><vertices>${v.map((p) => `<vertex x="${p[0]}" y="${p[1]}" z="${p[2]}"/>`).join('')}</vertices><triangles>${t.map((x, i) => `<triangle v1="${x[0]}" v2="${x[1]}" v3="${x[2]}"${i >= 6 ? ' pid="9" p1="1"' : ''}/>`).join('')}</triangles></mesh></object></resources><build><item objectid="1"/></build></model>` });
    const r = await parse3MF(buf);
    expect(r.filamentColors).toEqual(['#FF0000', '#0000FF']);
    expect(Array.from(r.objects[0].color!)).toEqual([1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2]);
  });
});
