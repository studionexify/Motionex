import { describe, expect, it, beforeAll } from 'vitest';
import { DOMParser } from '@xmldom/xmldom';
import JSZip from 'jszip';
import { loadModelFile } from '../src/io/load';

const tetra = (unit = 'millimeter', mats = '') => `<?xml version="1.0"?><amf unit="${unit}">${mats}
<object id="0"><metadata type="name">Tetra</metadata><mesh><vertices>
${[[0, 0, 0], [10, 0, 0], [0, 10, 0], [0, 0, 10]].map(([x, y, z]) => `<vertex><coordinates><x>${x}</x><y>${y}</y><z>${z}</z></coordinates></vertex>`).join('')}
</vertices><volume materialid="1"><triangle><v1>0</v1><v2>2</v2><v3>1</v3></triangle><triangle><v1>0</v1><v2>1</v2><v3>3</v3></triangle></volume>
<volume materialid="2"><triangle><v1>1</v1><v2>2</v2><v3>3</v3></triangle><triangle><v1>0</v1><v2>3</v2><v3>2</v3></triangle></volume></mesh></object></amf>`;
const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;

describe('AMF import', () => {
  beforeAll(() => { (globalThis as any).DOMParser = DOMParser; });
  it('reads a plain AMF tetrahedron in mm', async () => {
    const [m] = await loadModelFile('t.amf', enc(tetra()));
    expect(m.mesh.indices.length).toBe(12);
    expect(m.openEdges).toBe(0);
  });
  it('converts inches and keeps two materials as colour paint', async () => {
    const [m] = await loadModelFile('t.amf', enc(tetra('inch', '<material id="1"/><material id="2"/>')));
    let max = 0; for (let i = 0; i < m.mesh.vertices.length; i++) max = Math.max(max, m.mesh.vertices[i]);
    expect(max).toBeGreaterThan(200);
    expect(m.color && new Set(m.color).size).toBe(2);
  });
  it('reads a zip-compressed AMF', async () => {
    const zip = new JSZip(); zip.file('t.amf', tetra());
    const [m] = await loadModelFile('t.amf', await zip.generateAsync({ type: 'arraybuffer' }));
    expect(m.mesh.indices.length).toBe(12);
  });
});
