// Weave test prints: calibration rings for the A1 and P1S combos, checked here and written as
// .gcode.3mf (plus plain .gcode) when WEAVE_TEST_PRINTS=<dir> is set:
//   WEAVE_TEST_PRINTS=out/weave-tests npx vitest run tests/motionex/weave-prints.test.ts
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { slice, slotFromConfig } from '../../src/engine/slicer';
import { weld } from '../../src/engine/mesh';
import { resolveConfig } from '../../src/profiles/resolve';
import { printerById } from '../../src/profiles/printers';
import { buildGcode3mf } from '../../src/io/gcode3mf';
import { TRANSITION_MARKER } from '../../src/plugins/api';
import { defaultToolhead } from '../../src/plugins/motionex/core/toolhead';
import { DEFAULT_OPTIONS } from '../../src/plugins/motionex/modifier';
import type { MotionexReport } from '../../src/plugins/motionex/engine';
import { defaultWeave, type WeaveSettings } from '../../src/plugins/motionex/weave/model';
import { motifImage } from '../../src/plugins/motionex/weave/motifs';
import { gridFor } from '../../src/plugins/motionex/weave/image';
import { weavePrintSettings } from '../../src/plugins/motionex/weave/plan';
import { cycleLayers } from '../../src/plugins/motionex/weave/model';

const OUT = process.env.WEAVE_TEST_PRINTS;
const RING_R = 25, RING_H = 22;

/** Closed solid cylinder centred on the bed. */
function ring(cx: number, cy: number, r: number, h: number, seg = 180): Float32Array {
  const out: number[] = [];
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * 2 * Math.PI, a1 = ((i + 1) / seg) * 2 * Math.PI;
    const p0 = [cx + r * Math.cos(a0), cy + r * Math.sin(a0)], p1 = [cx + r * Math.cos(a1), cy + r * Math.sin(a1)];
    out.push(cx, cy, 0, p1[0], p1[1], 0, p0[0], p0[1], 0, cx, cy, h, p0[0], p0[1], h, p1[0], p1[1], h);
    out.push(p0[0], p0[1], 0, p1[0], p1[1], 0, p1[0], p1[1], h, p0[0], p0[1], 0, p1[0], p1[1], h, p0[0], p0[1], h);
  }
  return new Float32Array(out);
}

interface TestPrint { file: string; printerId: string; weave: Partial<WeaveSettings>; colours: string[]; what: string }

const PRINTS: TestPrint[] = [
  { file: 'weave-A1-bleed-depth-ladder', printerId: 'bbl-a1', colours: ['#F2EFE9', '#C8344A'],
    weave: { change: { mode: 'bleed', volume_mm3: 0 } }, what: 'A1 combo · white/red · bleed (no purge) · depth ladder 0.06–0.18 mm' },
  { file: 'weave-P1S-small-purge-depth-ladder', printerId: 'bbl-p1s', colours: ['#F2EFE9', '#C8344A'],
    weave: { change: { mode: 'reduced', volume_mm3: 30 } }, what: 'P1S combo · white/red · 30 mm³ purge · depth ladder 0.06–0.18 mm' },
  { file: 'weave-A1-mono-relief', printerId: 'bbl-a1', colours: ['#F2EFE9'],
    weave: { mode: 'mono', slots: [0], picture: { kind: 'motif', motif: 'greek-key', levels: 2 } }, what: 'A1 · one filament · Greek key relief · no filament changes' },
];

function build(t: TestPrint) {
  const printer = printerById(t.printerId);
  const cx = printer.bed.x / 2, cy = printer.bed.y / 2;
  const base = { ...defaultWeave(), enabled: true, calibration: true, ...t.weave } as WeaveSettings;
  const c = resolveConfig({ printerId: t.printerId, plate: 'textured_pei_plate', filamentId: 'generic-pla', presetId: '0.20', overrides: weavePrintSettings(base) as never });
  // grid: 1.2 mm pixels round the ring, one row per turn of the colours
  const g = gridFor(2 * Math.PI * RING_R, RING_H - base.z_start, 1.2, cycleLayers(base) * Number(c.layer_height), 0);
  const n = base.mode === 'colour' ? base.slots.length : 2;
  const weave: WeaveSettings = { ...base, image: motifImage(base.picture?.motif ?? 'checker', g.w, g.h, n) };
  const a = slotFromConfig(c);
  const filaments = t.colours.map((color, i) => ({ ...a, name: `PLA ${i + 1}`, color }));
  const out = slice([{ id: 'ring', name: 'Weave calibration ring', ...weld(ring(cx, cy, RING_R, RING_H)) }], c, () => {}, {
    filaments,
    plugins: { motionex: { applications: [], brushes: [], options: DEFAULT_OPTIONS, collisionMode: 'clamp', toolhead: defaultToolhead(t.printerId), printerId: t.printerId, weave } },
  });
  return { out, cfg: c, printer, weave, filaments };
}

describe('weave test prints', () => {
  for (const t of PRINTS) {
    it(t.what, async () => {
      const { out, cfg, printer, weave, filaments } = build(t);
      const rep = (out.pluginReports!.motionex as MotionexReport).weave!;
      // every woven layer got its woven loop and a tucked seam
      expect(rep.wovenLayers).toBeGreaterThan(95);
      expect(rep.loops).toBe(rep.wovenLayers);
      expect(rep.seamsTucked).toBeGreaterThanOrEqual(rep.wovenLayers);
      expect(rep.swing).toBeLessThanOrEqual(0.6 * rep.lineWidth + 1e-9);
      const changes = (out.gcode.match(new RegExp(`^${TRANSITION_MARKER}`, 'gm')) ?? []).length;
      if (weave.mode === 'colour') {
        expect(changes).toBe(rep.wovenLayers - 1);
        if (weave.change.mode === 'bleed') { expect(out.gcode).not.toMatch(/mode=full|mode=reduced/); expect(out.gcode).not.toMatch(/;TYPE:Prime tower/i); }
        else expect(out.gcode).not.toMatch(/mode=full/);
      } else expect(out.stats.toolChanges).toBe(0);
      // stays on the bed and below the ring top
      // (the print body; the makers' own start / end G-code park and wipe off the plate)
      const printBody = out.gcode.split(';===== end of start G-code =====').pop()!.split(';===== NexSpiro end G-code')[0];
      const xs = [...printBody.matchAll(/^G1 X([-\d.]+) Y([-\d.]+)/gm)].map((m) => [+m[1], +m[2]]);
      expect(xs.every(([x, y]) => x > -40 && x < printer.bed.x + 5 && y > -5 && y < printer.bed.y + 5)).toBe(true);
      expect(out.gcode).not.toMatch(/NaN|Infinity/);
      // open top: nothing but the woven wall above the floor (no lid from a minimum top thickness)
      const above = out.gcode.split(/^;Z:1\.2$/m)[1] ?? '';
      expect(above).not.toMatch(/^;TYPE:(top surface|internal solid infill|sparse infill)/im);
      expect(out.warnings.filter((w) => /Weave/.test(w))).toEqual([]);
      if (!OUT) return;
      fs.mkdirSync(OUT, { recursive: true });
      const bytes = await buildGcode3mf([{ gcode: out.gcode, stats: out.stats, objects: [{ id: 1, name: 'Weave calibration ring' }], filaments: filaments.map((f) => ({ type: 'PLA', color: f.color })), supportUsed: false }], cfg, printer.printerModelId!, printer.nozzle);
      fs.writeFileSync(path.join(OUT, `${t.file}.gcode.3mf`), bytes);
      fs.writeFileSync(path.join(OUT, `${t.file}.gcode`), out.gcode);
      const s = out.stats;
      fs.appendFileSync(path.join(OUT, 'SUMMARY.txt'), `${t.file}: ${t.what}\n  time ${(s.timeSeconds / 3600).toFixed(2)} h · ${s.filamentGrams.toFixed(1)} g · ${s.toolChanges} filament changes · ${rep.wovenLayers} woven layers · ${weave.image.w}×${weave.image.h} pixels · swing ${rep.swing.toFixed(2)} mm\n`);
    });
  }
});
