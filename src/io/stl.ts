// STL reader (binary + ASCII). Returns a flat triangle soup (xyz per corner).
export function parseSTL(buf: ArrayBuffer): Float32Array {
  const dv = new DataView(buf);
  if (buf.byteLength >= 84) {
    const count = dv.getUint32(80, true);
    if (84 + count * 50 === buf.byteLength) {
      const out = new Float32Array(count * 9);
      for (let t = 0; t < count; t++) {
        const o = 84 + t * 50 + 12;
        for (let k = 0; k < 9; k++) out[t * 9 + k] = dv.getFloat32(o + k * 4, true);
      }
      return out;
    }
  }
  const text = new TextDecoder().decode(buf);
  const re = /vertex\s+([-+\d.eE]+)\s+([-+\d.eE]+)\s+([-+\d.eE]+)/g;
  const vals: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) vals.push(+m[1], +m[2], +m[3]);
  if (!vals.length) throw new Error('Not a valid STL file.');
  return new Float32Array(vals);
}

/** Binary STL writer (used for tests / export). */
export function writeSTL(soup: Float32Array): ArrayBuffer {
  const count = soup.length / 9;
  const buf = new ArrayBuffer(84 + count * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, count, true);
  for (let t = 0; t < count; t++) {
    const o = 84 + t * 50;
    for (let k = 0; k < 9; k++) dv.setFloat32(o + 12 + k * 4, soup[t * 9 + k], true);
  }
  return buf;
}
