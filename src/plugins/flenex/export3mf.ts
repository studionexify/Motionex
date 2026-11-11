// Coloured 3MF writer for Flenex. The mesh carries one colour per triangle in three ways, so it opens
// coloured in any slicer: the 3MF core materials (basematerials + pid/p1), the Bambu / Orca
// `paint_color` triangle attribute (extruder per triangle) and a filament colour list in the project settings.
import JSZip from 'jszip';
import type { IndexedMesh } from '../../engine/mesh';

export interface Export3mfOptions {
  name: string;
  mesh: IndexedMesh;
  /** One palette slot (1-based) per triangle. */
  paint: Uint8Array;
  palette: string[];
  /** Where the model sits on the bed (mm); the mesh itself is centred on x / y and rests on z = 0. */
  place?: [number, number];
  printerName?: string;
}

/** Bambu / Orca / Prusa extruder code of a whole triangle painted with extruder `e` (1-based). */
export function paintCode(e: number): string {
  if (e <= 0) return '';
  if (e === 1) return '4';
  if (e === 2) return '8';
  return `${(e - 3).toString(16).toUpperCase()}C`;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const hex6 = (h: string) => h.replace('#', '').toUpperCase().padStart(6, '0').slice(0, 6);

export function build3mfModel(o: Export3mfOptions): string {
  const { mesh, paint, palette } = o;
  const used = Array.from(new Set(paint)).filter((x) => x > 0).sort((a, b) => a - b);
  const slots = used.length ? used : [1];
  const index = new Map(slots.map((s, i) => [s, i]));
  const v = mesh.vertices, ix = mesh.indices;
  const verts: string[] = [];
  for (let i = 0; i < v.length; i += 3) verts.push(`<vertex x="${+v[i].toFixed(4)}" y="${+v[i + 1].toFixed(4)}" z="${+v[i + 2].toFixed(4)}"/>`);
  const tris: string[] = [];
  for (let t = 0; t < ix.length; t += 3) {
    const slot = paint[t / 3] || 1;
    const pc = paintCode(slot);
    tris.push(`<triangle v1="${ix[t]}" v2="${ix[t + 1]}" v3="${ix[t + 2]}" pid="1" p1="${index.get(slot) ?? 0}"${pc ? ` paint_color="${pc}"` : ''}/>`);
  }
  const bases = slots.map((s) => `<base name="Colour ${s}" displaycolor="#${hex6(palette[s - 1] ?? '#808080')}FF"/>`).join('');
  const [px, py] = o.place ?? [0, 0];
  return `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
 <metadata name="Application">NexSpiro Flenex</metadata>
 <metadata name="Title">${esc(o.name)}</metadata>
 <resources>
  <basematerials id="1">${bases}</basematerials>
  <object id="2" name="${esc(o.name)}" type="model" pid="1" pindex="0"><mesh><vertices>${verts.join('')}</vertices><triangles>${tris.join('')}</triangles></mesh></object>
 </resources>
 <build><item objectid="2" transform="1 0 0 0 1 0 0 0 1 ${px} ${py} 0"/></build>
</model>`;
}

export async function build3mf(o: Export3mfOptions): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
 <Default Extension="json" ContentType="application/json"/>
 <Default Extension="config" ContentType="text/plain"/>
</Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`);
  zip.file('3D/3dmodel.model', build3mfModel(o));
  const used = Array.from(new Set(o.paint)).filter((x) => x > 0).sort((a, b) => a - b);
  zip.file('Metadata/project_settings.config', JSON.stringify({ filament_colour: (used.length ? used : [1]).map((s) => `#${hex6(o.palette[s - 1] ?? '#808080')}`), printer_settings_id: o.printerName ?? '' }, null, 1));
  zip.file('Metadata/flenex.json', JSON.stringify({ app: 'NexSpiro Flenex', version: 1, name: o.name, palette: o.palette, slots: used, triangles: o.paint.length }));
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}
