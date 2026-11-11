// Test prints for velocity painting, lace and tool-changer weave, checked here and written as .gcode.3mf
// (Bambu printers) or .gcode when ART_TEST_PRINTS=<dir> is set:
//   ART_TEST_PRINTS=out/art-tests npx vitest run tests/motionex/art-prints.test.ts
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { slice, slotFromConfig } from '../../src/engine/slicer';
import { weld } from '../../src/engine/mesh';
import { resolveConfig } from '../../src/profiles/resolve';
import { printerById } from '../../src/profiles/printers';
import { buildGcode3mf } from '../../src/io/gcode3mf';
import { defaultToolhead } from '../../src/plugins/motionex/core/toolhead';
import { DEFAULT_OPTIONS } from '../../src/plugins/motionex/modifier';
import type { MotionexConfig, MotionexReport } from '../../src/plugins/motionex/engine';
import { defaultPaint } from '../../src/plugins/motionex/paint/model';
import { paintPrintSettings } from '../../src/plugins/motionex/paint/plan';
import { defaultLace } from '../../src/plugins/motionex/lace/model';
import { lacePrintSettings } from '../../src/plugins/motionex/lace/plan';
import { cycleLayers, defaultWeave } from '../../src/plugins/motionex/weave/model';
import { weavePrintSettings } from '../../src/plugins/motionex/weave/plan';
import { motifImage } from '../../src/plugins/motionex/weave/motifs';
import { gridFor } from '../../src/plugins/motionex/weave/image';

const OUT = process.env.ART_TEST_PRINTS;

/** Closed solid cylinder centred on (cx, cy). */
function cyl(cx: number, cy: number, r: number, h: number, seg = 180): Float32Array {
  const out: number[] = [];
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * 2 * Math.PI, a1 = ((i + 1) / seg) * 2 * Math.PI;
    const p0 = [cx + r * Math.cos(a0), cy + r * Math.sin(a0)], p1 = [cx + r * Math.cos(a1), cy + r * Math.sin(a1)];
    out.push(cx, cy, 0, p1[0], p1[1], 0, p0[0], p0[1], 0, cx, cy, h, p0[0], p0[1], h, p1[0], p1[1], h);
    out.push(p0[0], p0[1], 0, p1[0], p1[1], 0, p1[0], p1[1], h, p0[0], p0[1], 0, p1[0], p1[1], h, p0[0], p0[1], h);
  }
  return new Float32Array(out);
}

interface Print { file: string; printerId: string; colours: string[]; r: number; h: number; what: string; make: (lh: number) => { mx: Partial<MotionexConfig>; settings: Record<string, unknown> } }

const PRINTS: Print[] = [
  { file: 'paint-A1-speed-ladder', printerId: 'bbl-a1', colours: ['#C9A227'], r: 25, h: 30, what: 'A1 · silk PLA · velocity paint speed ladder, 6 speeds 40–160 mm/s, twice round',
    make: () => { const p = { ...defaultPaint(), enabled: true, calibration: true, picture: { kind: 'motif' as const, levels: 6 }, speed_light: 40, speed_dark: 160, accel: 10000 }; return { mx: { paint: p }, settings: { ...paintPrintSettings(p), wall_loops: 2, sparse_infill_density: 0, top_shell_layers: 0, top_shell_thickness: 0 } }; } },
  { file: 'paint-P1S-folk-star', printerId: 'bbl-p1s', colours: ['#C9A227'], r: 30, h: 50, what: 'P1S · silk PLA · velocity paint folk star, 40 / 160 mm/s',
    make: () => { const p = { ...defaultPaint(), enabled: true, speed_light: 40, speed_dark: 160, accel: 10000, z_start: 2, image: motifImage('folk-star', 63, 16, 2) }; return { mx: { paint: p }, settings: { ...paintPrintSettings(p), wall_loops: 2, sparse_infill_density: 0, top_shell_layers: 0, top_shell_thickness: 0 } }; } },
  { file: 'lace-A1-diamond', printerId: 'bbl-a1', colours: ['#E9E4DA'], r: 25, h: 40, what: 'A1 · PLA · diamond lace 8 × 10 mm cells, 1.6 mm strands, solid floor and 4 mm rim',
    make: () => { const l = { ...defaultLace(), enabled: true }; return { mx: { lace: l }, settings: lacePrintSettings(l) }; } },
  { file: 'lace-A1-gothic', printerId: 'bbl-a1', colours: ['#E9E4DA'], r: 25, h: 40, what: 'A1 · PLA · gothic arch lace 10 × 18 mm cells',
    make: () => { const l = { ...defaultLace(), enabled: true, pattern: 'lancet', cell_w: 10, cell_h: 18, strand_mm: 2 }; return { mx: { lace: l }, settings: lacePrintSettings(l) }; } },
  { file: 'weave-U1-toolchanger', printerId: 'snapmaker-u1', colours: ['#F2EFE9', '#C8344A'], r: 25, h: 22, what: 'Snapmaker U1 · two heads · weave depth ladder, head swap every layer, no purge',
    make: (lh) => { const w = { ...defaultWeave(), enabled: true, calibration: true }; const g = gridFor(2 * Math.PI * 25, 22 - w.z_start, 1.2, cycleLayers(w) * lh, 0); return { mx: { weave: { ...w, image: motifImage('checker', g.w, g.h, 2) } }, settings: weavePrintSettings(w) }; } },
];

describe('art test prints', () => {
  for (const t of PRINTS) {
    it(t.what, async () => {
      const printer = printerById(t.printerId);
      const cx = printer.bed.x / 2, cy = printer.bed.y / 2;
      const base = resolveConfig({ printerId: t.printerId, plate: 'textured_pei_plate', filamentId: 'generic-pla', presetId: '0.20', overrides: {} });
      const m = t.make(Number(base.layer_height));
      const c = resolveConfig({ printerId: t.printerId, plate: 'textured_pei_plate', filamentId: 'generic-pla', presetId: '0.20', overrides: m.settings as never });
      const a = slotFromConfig(c);
      const filaments = t.colours.map((color, i) => ({ ...a, name: `PLA ${i + 1}`, color }));
      const mx: MotionexConfig = { applications: [], brushes: [], options: DEFAULT_OPTIONS, collisionMode: 'clamp', toolhead: defaultToolhead(t.printerId), printerId: t.printerId, ...m.mx };
      const out = slice([{ id: 'part', name: t.file, ...weld(cyl(cx, cy, t.r, t.h)) }], c, () => {}, { filaments, plugins: { motionex: mx } });
      const rep = out.pluginReports!.motionex as MotionexReport;
      if (m.mx.paint) { expect(rep.paint!.paintedLayers).toBeGreaterThan(100); expect(out.stats.toolChanges).toBe(0); }
      if (m.mx.lace) { expect(rep.lace!.laceLayers).toBeGreaterThan(100); expect(rep.lace!.openShare).toBeGreaterThan(0.1); }
      if (m.mx.weave) { expect(out.stats.toolChanges).toBe(rep.weave!.wovenLayers - 1); expect(out.gcode).toMatch(/^T1(?: ; park.*)?$/m); }
      expect(out.gcode).not.toMatch(/NaN|Infinity/);
      expect(out.warnings.filter((w) => /Velocity paint|Lace|Weave/.test(w) && !/minimum layer time/.test(w))).toEqual([]);
      if (!OUT) return;
      fs.mkdirSync(OUT, { recursive: true });
      if (printer.printerModelId) {
        const bytes = await buildGcode3mf([{ gcode: out.gcode, stats: out.stats, objects: [{ id: 1, name: t.file }], filaments: filaments.map((f) => ({ type: 'PLA', color: f.color })), supportUsed: false }], c, printer.printerModelId, printer.nozzle);
        fs.writeFileSync(path.join(OUT, `${t.file}.gcode.3mf`), bytes);
      }
      fs.writeFileSync(path.join(OUT, `${t.file}.gcode`), out.gcode);
      const s = out.stats;
      fs.appendFileSync(path.join(OUT, 'SUMMARY.txt'), `${t.file}: ${t.what}\n  time ${(s.timeSeconds / 3600).toFixed(2)} h · ${s.filamentGrams.toFixed(1)} g · ${s.toolChanges} changes${rep.lace ? ` · ${Math.round(rep.lace.openShare * 100)}% open, ${rep.lace.retractions} retractions` : ''}${rep.paint ? ` · speeds ${rep.paint.speeds.map((v) => Math.round(v)).join('/')} mm/s, ramp ${rep.paint.rampMm.toFixed(1)} mm` : ''}\n`);
    });
  }
});
