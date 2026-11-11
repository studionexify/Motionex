// Wavefront OBJ reader (v / f, polygons fan-triangulated, negative indices supported).
export function parseOBJ(text: string): Float32Array { return parseOBJPolys(text).soup; }

/** Same as parseOBJ, plus the source polygon id of every triangle (quads keep their two triangles together). */
export function parseOBJPolys(text: string): { soup: Float32Array; groups: Uint32Array } {
  const verts: number[] = [];
  const out: number[] = [];
  const groups: number[] = [];
  let poly = 0;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('v ')) {
      const p = line.split(/\s+/);
      verts.push(+p[1], +p[2], +p[3]);
    } else if (line.startsWith('f ')) {
      const idx = line.split(/\s+/).slice(1).map((tok) => {
        const i = parseInt(tok.split('/')[0], 10);
        return i < 0 ? verts.length / 3 + i : i - 1;
      });
      for (let k = 1; k + 1 < idx.length; k++) {
        for (const i of [idx[0], idx[k], idx[k + 1]]) out.push(verts[i * 3], verts[i * 3 + 1], verts[i * 3 + 2]);
        groups.push(poly);
      }
      poly++;
    }
  }
  if (!out.length) throw new Error('OBJ file has no faces.');
  return { soup: new Float32Array(out), groups: Uint32Array.from(groups) };
}
