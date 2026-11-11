import { describe, expect, it } from 'vitest';
import { weld } from '../src/engine/mesh';
import { slice } from '../src/engine/slicer';
import { resolveConfig } from '../src/profiles/resolve';
import { PRINTERS } from '../src/profiles/printers';
import { box, cylinder, tee } from './fixtures';

const mesh = (soup: Float32Array, name: string) => { const m = weld(soup); return { id: name, name, vertices: m.vertices, indices: m.indices }; };

describe('G-code sanity', () => {
  for (const p of PRINTERS) {
    it(`${p.model}: finite, in-bounds, monotonic Z`, () => {
      const cx = p.bed.x / 2, cy = p.bed.y / 2;
      const cfg = resolveConfig({ printerId: p.id, plate: p.plates[0].type, filamentId: 'generic-petg', presetId: '0.16', overrides: { enable_support: true, sparse_infill_pattern: 'gyroid', skirt_loops: 2 } });
      const out = slice([mesh(tee(cx, cy), 'tee'), mesh(cylinder(cx, cy + 40, 8, 12), 'cyl')], cfg);
      const code = out.gcode.split('\n').filter((l) => !l.startsWith(';')).join('\n');
      expect(code).not.toMatch(/NaN|Infinity|undefined|\[[a-z_]+\]/); // no unexpanded placeholders
      let z = 0, maxZ = 0, e = 0;
      const body = out.gcode.split(';===== end of start G-code =====').pop()!.split('\n');
      for (const line of body) {
        const m = /^G[01] (.*)/.exec(line);
        if (!m) continue;
        // extrusions stay on the bed (the makers' own macros may travel off it: purge chutes, wipers, parking)
        const extruding = / E\d/.test(` ${m[1]}`) && /[XY]/.test(m[1]);
        for (const tok of m[1].split(' ')) {
          const v = parseFloat(tok.slice(1));
          if (tok[0] === 'X' && extruding) { expect(v).toBeGreaterThanOrEqual(-1); expect(v).toBeLessThanOrEqual(p.bed.x + 1); }
          if (tok[0] === 'Y' && extruding) { expect(v).toBeGreaterThanOrEqual(-1); expect(v).toBeLessThanOrEqual(p.bed.y + 1); }
          if (tok[0] === 'Z') z = v;
          if (tok[0] === 'E') e += v;
        }
        if (extruding) maxZ = Math.max(maxZ, z);
      }
      expect(maxZ).toBeGreaterThan(13.5); // top extruding layer (the model is 14 mm)
      expect(maxZ).toBeLessThan(16);
      expect(e).toBeGreaterThan(100);
      expect(out.layers.every((L, i) => i === 0 || L.z > out.layers[i - 1].z)).toBe(true);
    });
  }
  it('box sliced at 0.08 mm ends within half a layer of the model top', () => {
    const cfg = resolveConfig({ printerId: 'bbl-a1', plate: 'textured_pei_plate', filamentId: 'generic-pla', presetId: '0.08', overrides: {} });
    const out = slice([mesh(box(100, 100, 0, 10, 10, 4), 'b')], cfg);
    const top = out.layers[out.layers.length - 1].z;
    expect(Math.abs(top - 4)).toBeLessThanOrEqual(0.04 + 1e-6);
    expect(out.layers.length).toBe(48);
  });
});
