// Spec §9 test prints. Always checks the four jobs slice cleanly; writes the G-code when
// PATTERNEX_TEST_PRINTS=<dir> is set (e.g. `PATTERNEX_TEST_PRINTS=out/test-prints npx vitest run tests/patternex/test-prints.test.ts`).
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { slice, slotFromConfig } from '../../src/engine/slicer';
import { weld } from '../../src/engine/mesh';
import { resolveConfig } from '../../src/profiles/resolve';
import { box, cylinder } from '../fixtures';
import { builtinPattern, newPlacement, parseSvg, type Pattern, type RegionAction } from '../../src/plugins/patternex';
import type { WorldPlacement } from '../../src/plugins/patternex/projection';
import type { PatternexConfig, PatternexReport } from '../../src/plugins/patternex/engine';

const OUT = process.env.PATTERNEX_TEST_PRINTS;
const cfg = (printerId: string, o = {}) => resolveConfig({ printerId, plate: 'textured_pei_plate', filamentId: 'generic-pla', presetId: '0.20', overrides: o });
const slots = (c: ReturnType<typeof cfg>) => { const a = slotFromConfig(c); return [{ ...a, name: 'White', color: '#ffffff' }, { ...a, name: 'Black', color: '#111111' }]; };
const LOGO = parseSvg(`<svg viewBox="0 0 40 20" width="40mm" height="20mm">
  <path fill="#000" d="M2 18V2h6l6 10V2h4v16h-6L6 8v10z"/><circle cx="27" cy="10" r="7" fill="#000"/><circle cx="27" cy="10" r="3.5" fill="#fff"/>
</svg>`, { id: 'logo', name: 'Test logo' }).pattern;
const place = (pattern: Pattern, o: Partial<WorldPlacement>): WorldPlacement => ({ ...newPlacement('p', pattern, 'm:0', [0, 0, 0], [0, 0, 1]), object: 0, ...o });
const act = (o: Partial<RegionAction> = {}): RegionAction => ({ region_ref: { placement_id: 'p', color_group: '#000000' }, material: { mode: 'slot', slot_index: 1 }, purge: { mode: 'full', change_point_shift_mm: 0 }, motion: null, ...o });
const job = (pattern: Pattern, p: Partial<WorldPlacement>, actions: RegionAction[], o: Partial<PatternexConfig> = {}): PatternexConfig =>
  ({ patterns: [pattern], placements: [place(pattern, p)], actions, singleColour: 'skip', transitionVolume: [], ...o });

function write(name: string, gcode: string, rep: PatternexReport) {
  if (!OUT) return;
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, `${name}.gcode`), gcode);
  fs.writeFileSync(path.join(OUT, `${name}.report.json`), JSON.stringify({ ...rep, outlines: rep.outlines.length, bleedZones: rep.bleedZones.length }, null, 2));
}

describe('Patternex test prints', () => {
  it('1 · logo on a flat top, multi-colour (P1S + AMS)', () => {
    const c = cfg('bbl-p1s');
    const m = { id: 'tile', name: 'tile', ...weld(box(98, 103, 0, 60, 50, 3)) };
    const out = slice([m], c, () => {}, { filaments: slots(c), plugins: { patternex: job(LOGO, { position_xyz: [128, 128, 3], projection_axis: [0, 0, 1], depth_mode: 'fixed', depth_mm: 0.6 }, [act()]) } });
    const rep = out.pluginReports!.patternex as PatternexReport;
    expect(rep.toolChanges).toBeGreaterThan(0);
    expect(out.gcode).toContain('M620 S1A');
    write('1-logo-top-ams-p1s', out.gcode, rep);
  });

  it('2 · logo on a top, single-colour swap (A1 without AMS: layer bands, M400 U1 pause)', () => {
    // the logo is raised 1 mm above the tile, so its four layers are logo only and swap at a layer boundary
    const c = cfg('bbl-a1', {});
    const cs = { ...c, has_ams: false, change_filament_gcode: '; ===== manual swap [previous_extruder] -> [next_extruder] =====\nG1 Z[toolchange_z] F1200\nM400 U1 ; pause: load the next colour, then resume\n; ===== end manual swap =====' };
    const tile = weld(box(98, 103, 0, 60, 50, 3));
    const raised = weld(box(108, 118, 3, 40, 20, 1));
    const merge = { id: 'tile', name: 'tile', vertices: new Float32Array([...tile.vertices, ...raised.vertices]), indices: new Uint32Array([...tile.indices, ...[...raised.indices].map((i) => i + tile.vertices.length / 3)]) };
    const full = builtinPattern('checker', { width: 40, height: 20, cell: 40, colors: ['#000000', '#ffffff'] }); // the raised logo block's footprint
    const out = slice([merge], cs, () => {}, { filaments: slots(cs), plugins: { patternex: job(full, { position_xyz: [128, 128, 4], projection_axis: [0, 0, 1], depth_mode: 'fixed', depth_mm: 1 }, [act({ material: { mode: 'manual', slot_index: 1, swap_label: 'Black PLA' } })], { singleColour: 'skip' }) } });
    const rep = out.pluginReports!.patternex as PatternexReport;
    expect(rep.unsupported).toEqual([]);
    expect(rep.swaps.length).toBe(1);
    expect(rep.swaps[0].z).toBeCloseTo(3.2, 3); // first layer of the raised block
    expect(out.gcode).toContain('M117 Load Black PLA');
    write('2-logo-top-manual-swap-a1', out.gcode, rep);
  });

  it('3 · stripes wrapped on a cylinder (A1 + AMS)', () => {
    const c = cfg('bbl-a1');
    const r = 15, circ = 2 * Math.PI * r;
    const stripes = builtinPattern('stripes', { width: circ, height: 20, cell: circ / 16, colors: ['#ffffff', '#000000'] });
    const m = { id: 'cyl', name: 'cyl', ...weld(cylinder(128, 128, r, 30, 128)) };
    const out = slice([m], c, () => {}, { filaments: slots(c), plugins: { patternex: job(stripes, { pattern_id: stripes.id, projection: 'cylindrical', projection_axis: [0, 0, 1], position_xyz: [128 + r, 128, 15], axis_origin: [128, 128, 0] }, [act()]) } });
    const rep = out.pluginReports!.patternex as PatternexReport;
    expect(rep.regions[0].layerCount).toBeGreaterThan(80);
    write('3-stripes-cylinder-a1', out.gcode, rep);
  });

  it('4 · no-purge two-colour panel to measure bleed (P1S + AMS)', () => {
    const c = cfg('bbl-p1s');
    const half = builtinPattern('checker', { width: 30, height: 40, cell: 30, colors: ['#000000', '#ffffff'] });
    const m = { id: 'panel', name: 'panel', ...weld(box(98, 108, 0, 60, 40, 2)) };
    const out = slice([m], c, () => {}, { filaments: slots(c), plugins: { patternex: job(half, { position_xyz: [143, 128, 2], projection_axis: [0, 0, 1], through: true }, [act({ purge: { mode: 'none', change_point_shift_mm: 0 } })]) } });
    const rep = out.pluginReports!.patternex as PatternexReport;
    expect(rep.transitions.none).toBeGreaterThan(0);
    expect(rep.bleedZones.length).toBeGreaterThan(0);
    expect(rep.uncalibrated.length).toBeGreaterThan(0);
    write('4-no-purge-bleed-panel-p1s', out.gcode, rep);
  });
});
