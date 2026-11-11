// Renex disclosure metadata. Every exported image states, in the formats platforms actually read, that it
// is a computer-generated render of a 3D-printable design and not a photograph:
//  • IPTC Digital Source Type (XMP Iptc4xmpExt:DigitalSourceType) = digitalCreation, or
//    compositeWithTrainedAlgorithmicMedia when the optional AI pass touched the image — the field Google,
//    Meta, LinkedIn and stock sites use for "made with AI / computer generated" labels;
//  • XMP dc:description, photoshop:Credit, xmp:CreatorTool;
//  • PNG tEXt (Software, Description, Comment, Source) / JPEG EXIF ImageDescription + Software + a COM segment.
// Writing is done in pure JS on the encoded bytes, so it works the same in Electron and in the browser.

export interface DisclosureInfo {
  title: string;
  /** Plugin the design came from (Plantex / Lumonex). */
  source: string;
  /** Print settings and materials shown, for the description. */
  details: string[];
  aiAssisted: boolean;
  /** AI provider used, if any. */
  aiProvider?: string;
  author?: string;
  createdAt?: Date;
}

export const DST_DIGITAL_CREATION = 'http://cv.iptc.org/newscodes/digitalsourcetype/digitalCreation';
export const DST_COMPOSITE_AI = 'http://cv.iptc.org/newscodes/digitalsourcetype/compositeWithTrainedAlgorithmicMedia';

export function disclosureText(d: DisclosureInfo): string {
  const base = `Computer-generated photorealistic render of a 3D-printable design (${d.source}), created with NexSpiro Renex. Not a photograph of a physical object.`;
  const ai = d.aiAssisted ? ` Image enhanced with generative AI${d.aiProvider ? ` (${d.aiProvider})` : ''}.` : '';
  return `${base}${ai}`;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function buildXmp(d: DisclosureInfo): string {
  const when = (d.createdAt ?? new Date()).toISOString();
  const desc = disclosureText(d);
  const details = d.details.map((x) => `<rdf:li>${esc(x)}</rdf:li>`).join('');
  return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:dc="http://purl.org/dc/elements/1.1/"
    xmlns:xmp="http://ns.adobe.com/xap/1.0/"
    xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/"
    xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/"
    xmlns:renex="https://nexspiro.app/ns/renex/1.0/"
    Iptc4xmpExt:DigitalSourceType="${d.aiAssisted ? DST_COMPOSITE_AI : DST_DIGITAL_CREATION}"
    xmp:CreatorTool="NexSpiro Renex"
    xmp:CreateDate="${when}"
    photoshop:Credit="Rendered with NexSpiro Renex"
    renex:Rendered="True"
    renex:AIAssisted="${d.aiAssisted ? 'True' : 'False'}"
    renex:Source="${esc(d.source)}">
   <dc:title><rdf:Alt><rdf:li xml:lang="x-default">${esc(d.title)}</rdf:li></rdf:Alt></dc:title>
   <dc:description><rdf:Alt><rdf:li xml:lang="x-default">${esc(desc)}</rdf:li></rdf:Alt></dc:description>${d.author ? `
   <dc:creator><rdf:Seq><rdf:li>${esc(d.author)}</rdf:li></rdf:Seq></dc:creator>` : ''}
   <renex:Details><rdf:Bag>${details}</rdf:Bag></renex:Details>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}

// ---------------------------------------------------------------------------------------------------
// PNG

const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b: Uint8Array): number { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

const latin1 = (s: string) => Uint8Array.from(s, (ch) => { const c = ch.charCodeAt(0); return c < 256 ? c : 63; });
const utf8 = (s: string) => new TextEncoder().encode(s);

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(latin1(type), 4);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

const concat = (parts: Uint8Array[]) => { const n = parts.reduce((s, p) => s + p.length, 0); const o = new Uint8Array(n); let k = 0; for (const p of parts) { o.set(p, k); k += p.length; } return o; };

function tEXt(key: string, value: string) { return chunk('tEXt', concat([latin1(key), new Uint8Array([0]), latin1(value)])); }
function iTXt(key: string, value: string) { return chunk('iTXt', concat([latin1(key), new Uint8Array([0, 0, 0, 0, 0]), utf8(value)])); }

/** Insert disclosure text chunks + XMP after IHDR of a PNG. */
export function tagPng(png: Uint8Array, d: DisclosureInfo): Uint8Array {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!sig.every((v, i) => png[i] === v)) throw new Error('Not a PNG');
  const ihdrLen = new DataView(png.buffer, png.byteOffset).getUint32(8);
  const afterIHDR = 8 + 12 + ihdrLen;
  const text = disclosureText(d);
  const extra = concat([
    tEXt('Software', 'NexSpiro Renex'),
    tEXt('Title', d.title),
    tEXt('Description', text),
    tEXt('Comment', text),
    tEXt('Source', 'Computer-generated render (not a photograph)'),
    ...(d.author ? [tEXt('Author', d.author)] : []),
    iTXt('XML:com.adobe.xmp', buildXmp(d)),
  ]);
  return concat([png.subarray(0, afterIHDR), extra, png.subarray(afterIHDR)]);
}

/** Read tEXt / iTXt chunks of a PNG (for tests and the "verify disclosure" button). */
export function readPngText(png: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let p = 8;
  while (p + 8 <= png.length) {
    const len = dv.getUint32(p), type = String.fromCharCode(...png.subarray(p + 4, p + 8));
    const data = png.subarray(p + 8, p + 8 + len);
    if (type === 'tEXt' || type === 'iTXt') {
      const z = data.indexOf(0);
      const key = String.fromCharCode(...data.subarray(0, z));
      out[key] = type === 'tEXt' ? String.fromCharCode(...data.subarray(z + 1)) : new TextDecoder().decode(data.subarray(z + 5));
    }
    if (type === 'IEND') break;
    p += 12 + len;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------
// JPEG

function segment(marker: number, payload: Uint8Array): Uint8Array {
  if (payload.length + 2 > 0xffff) throw new Error('JPEG segment too large');
  const out = new Uint8Array(4 + payload.length);
  out[0] = 0xff; out[1] = marker; out[2] = (payload.length + 2) >> 8; out[3] = (payload.length + 2) & 0xff;
  out.set(payload, 4);
  return out;
}

/** Minimal big-endian EXIF (IFD0: ImageDescription, Software, Artist) for the APP1 segment. */
function exif(d: DisclosureInfo): Uint8Array {
  const entries: [number, string][] = [[0x010e, disclosureText(d)], [0x0131, 'NexSpiro Renex'], ...(d.author ? [[0x013b, d.author] as [number, string]] : [])];
  const head = 8, ifd = 2 + entries.length * 12 + 4;
  const strs = entries.map(([, s]) => concat([latin1(s), new Uint8Array([0])]));
  const total = head + ifd + strs.reduce((s, x) => s + x.length, 0);
  const b = new Uint8Array(total), dv = new DataView(b.buffer);
  b.set([0x4d, 0x4d, 0, 42, 0, 0, 0, 8]);
  dv.setUint16(head, entries.length);
  let off = head + ifd;
  entries.forEach(([tag], i) => {
    const e = head + 2 + i * 12;
    dv.setUint16(e, tag); dv.setUint16(e + 2, 2); dv.setUint32(e + 4, strs[i].length); dv.setUint32(e + 8, off);
    b.set(strs[i], off); off += strs[i].length;
  });
  dv.setUint32(head + 2 + entries.length * 12, 0);
  return concat([latin1('Exif'), new Uint8Array([0, 0]), b]);
}

/** Insert EXIF, XMP and a comment segment right after SOI of a JPEG. */
export function tagJpeg(jpg: Uint8Array, d: DisclosureInfo): Uint8Array {
  if (jpg[0] !== 0xff || jpg[1] !== 0xd8) throw new Error('Not a JPEG');
  const xmp = concat([latin1('http://ns.adobe.com/xap/1.0/'), new Uint8Array([0]), utf8(buildXmp(d))]);
  return concat([jpg.subarray(0, 2), segment(0xe1, exif(d)), segment(0xe1, xmp), segment(0xfe, utf8(disclosureText(d))), jpg.subarray(2)]);
}

/** Tag an encoded image (PNG or JPEG) by its signature. */
export function tagImage(bytes: Uint8Array, d: DisclosureInfo): Uint8Array {
  if (bytes[0] === 0x89) return tagPng(bytes, d);
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return tagJpeg(bytes, d);
  return bytes;
}

/** True when the bytes carry the Renex render disclosure (any of the written fields). */
export function hasDisclosure(bytes: Uint8Array): boolean {
  const s = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 200000)));
  return s.includes('DigitalSourceType') && s.includes('NexSpiro Renex');
}
