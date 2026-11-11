// AMF (Additive Manufacturing File, ISO/ASTM 52915) import: plain XML or zip-compressed. Every <object> becomes one
// model; each <volume> keeps its triangles, and a volume's materialid maps to a 1-based filament slot when the file
// defines more than one material. Units are converted to mm.
import JSZip from 'jszip';

export interface AmfObject { name: string; soup: Float32Array; color?: Uint8Array }

const UNIT: Record<string, number> = { millimeter: 1, millimetre: 1, inch: 25.4, feet: 304.8, meter: 1000, metre: 1000, micron: 0.001 };

async function amfText(data: ArrayBuffer): Promise<string> {
  const b = new Uint8Array(data);
  if (b[0] === 0x50 && b[1] === 0x4b) { // "PK": zip-compressed AMF
    const zip = await JSZip.loadAsync(data);
    const f = Object.values(zip.files).find((e) => !e.dir && /\.amf$/i.test(e.name)) ?? Object.values(zip.files).find((e) => !e.dir);
    if (!f) throw new Error('The AMF archive is empty.');
    return f.async('string');
  }
  return new TextDecoder().decode(b);
}

const kids = (el: Element, tag: string) => Array.from(el.childNodes).filter((c): c is Element => c.nodeType === 1 && ((c as Element).localName || c.nodeName).toLowerCase() === tag);
const num = (el: Element, tag: string) => Number(kids(el, tag)[0]?.textContent ?? 0);

export async function parseAMF(data: ArrayBuffer): Promise<AmfObject[]> {
  const doc = new DOMParser().parseFromString(await amfText(data), 'application/xml');
  const root = doc.documentElement;
  if (!root || (root.localName || root.nodeName).toLowerCase() !== 'amf' || doc.getElementsByTagName('parsererror').length) throw new Error('Not a valid AMF file.');
  const scale = UNIT[(root.getAttribute('unit') ?? 'millimeter').toLowerCase()] ?? 1;
  const materials = kids(root, 'material').map((m) => m.getAttribute('id') ?? '');
  const slotOf = (id: string | null) => { const k = id ? materials.indexOf(id) : -1; return k < 0 ? 0 : k + 1; };
  const out: AmfObject[] = [];
  for (const obj of kids(root, 'object')) {
    const mesh = kids(obj, 'mesh')[0];
    if (!mesh) continue;
    const verts = kids(mesh, 'vertices')[0];
    const pts = verts ? kids(verts, 'vertex').map((v) => { const c = kids(v, 'coordinates')[0]; return c ? [num(c, 'x'), num(c, 'y'), num(c, 'z')] : [0, 0, 0]; }) : [];
    const tri: number[] = []; const col: number[] = [];
    for (const vol of kids(mesh, 'volume')) {
      const slot = slotOf(vol.getAttribute('materialid'));
      for (const t of kids(vol, 'triangle')) {
        const ids = [num(t, 'v1'), num(t, 'v2'), num(t, 'v3')];
        if (ids.some((i) => !pts[i])) continue;
        for (const i of ids) tri.push(pts[i][0] * scale, pts[i][1] * scale, pts[i][2] * scale);
        col.push(slot);
      }
    }
    if (!tri.length) continue;
    const name = kids(obj, 'metadata').find((m) => m.getAttribute('type') === 'name')?.textContent?.trim() || `Object ${obj.getAttribute('id') ?? out.length + 1}`;
    out.push({ name, soup: new Float32Array(tri), color: materials.length > 1 && col.some((c) => c) ? new Uint8Array(col) : undefined });
  }
  if (!out.length) throw new Error('The AMF file contains no geometry.');
  return out;
}
