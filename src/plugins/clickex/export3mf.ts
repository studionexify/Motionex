// Clickex → 3MF: every part in print orientation, laid out side by side on the bed, with its colours as
// 3MF base materials (one per palette entry, assigned per triangle). Plain core 3MF, readable by any slicer.
import JSZip from 'jszip';
import { meshBounds } from '../../engine/mesh';
import type { Part } from './build';

const hex8 = (h: string) => `${h.replace('#', '').toUpperCase().padEnd(6, '0').slice(0, 6)}FF`;
const f = (n: number) => +n.toFixed(4);

export async function build3mf(title: string, parts: Part[], bed: { x: number; y: number }): Promise<Uint8Array> {
  // lay parts in a row, centred on the bed
  const boxes = parts.map((p) => meshBounds(p.mesh.vertices));
  const gap = 10;
  const widths = boxes.map((b) => b.max[0] - b.min[0]);
  const total = widths.reduce((s, w) => s + w, 0) + gap * Math.max(0, parts.length - 1);
  let x = bed.x / 2 - total / 2;
  let res = '', items = '';
  parts.forEach((p, i) => {
    const b = boxes[i], mid = 10 * (i + 1);
    const w = widths[i], cy = (b.min[1] + b.max[1]) / 2;
    const dx = x - b.min[0], dy = bed.y / 2 - cy;
    x += w + gap;
    const v = p.mesh.vertices, ix = p.mesh.indices;
    let vs = '';
    for (let k = 0; k < v.length; k += 3) vs += `<vertex x="${f(v[k] + dx)}" y="${f(v[k + 1] + dy)}" z="${f(v[k + 2])}"/>`;
    let ts = '';
    for (let t = 0; t < ix.length; t += 3) ts += `<triangle v1="${ix[t]}" v2="${ix[t + 1]}" v3="${ix[t + 2]}" pid="${mid}" p1="${p.slots[t / 3] ?? 0}"/>`;
    res += `<basematerials id="${mid}">${p.palette.map((c, k) => `<base name="${p.name} colour ${k + 1}" displaycolor="#${hex8(c)}"/>`).join('')}</basematerials>`;
    res += `<object id="${mid + 1}" type="model" name="${p.name.replace(/[<>&"]/g, '')}" pid="${mid}" pindex="0"><mesh><vertices>${vs}</vertices><triangles>${ts}</triangles></mesh></object>`;
    items += `<item objectid="${mid + 1}"/>`;
  });
  const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
<metadata name="Title">${title.replace(/[<>&"]/g, '')}</metadata>
<metadata name="Application">NexSpiro Clickex</metadata>
<resources>${res}</resources>
<build>${items}</build>
</model>`;
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`);
  zip.file('3D/3dmodel.model', model);
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}
