// RE-PINNED (reverse-verifier remediation): Basic hashes changed only because a first-layer bottom-surface width of 0 now means
// 'same as initial layer' as its tooltip says (checked: reverting that one line restores the old hashes). Advanced hashes changed because
// E now follows true 3-D bead length / local bead height on non-planar paths (see tests/reverse-verifier).
// Basic mode must keep producing exactly the G-code of the classic engine. These hashes were taken from
// the engine before the Advanced core existed; if a deliberate Basic-engine change alters them, update
// them in the same commit and say why.
// Updated with the Basic settings rework (PR #22), which changed the classic engine's defaults and
// toolpath rules (walls, seams, cooling, travel). The new hashes were checked to be identical before and after
// merging the Advanced core, so the Advanced plumbing itself still leaves Basic mode untouched. The P1S hash
// changed once more only because the G-code config block now reads gcode_flavor = bbl (flavour renamed).
// All four changed again only because the config block lists the new outline_smoothing / outline_smoothing_corner
// settings (off by default); with those two lines removed the G-code hashes are exactly the previous ones.
// The two cylinder hashes changed with the slicing speed-up: cross-section outlines now drop the points that lie
// on a straight wall (the crossings of a flat face's diagonal edge, which slid from layer to layer) and the ones
// within the path resolution, so identical layers are recognised and their polygon work is reused. Wall points
// move by less than the Resolution setting (0.012 mm); the cube and the supported tee are unchanged.
// All four changed again only because the config block lists the new multi-material printer settings (changer_type,
// toolhead_count, tool_prime_volume, standby_temperature_delta, tool_preheat_time); with those five lines removed the
// G-code hashes are exactly the previous ones.
// Arc fitting is now on by default; the cases that predate that pin it off so their G-code (and hashes) stay as they were.
// All four changed again only because the config block lists the new filament-unit printer settings (purge_target,
// filament_slots); with those two lines removed the G-code hashes are exactly the previous ones.
// All four changed again only because the config block lists the new tool-changer printer settings
// (tool_off_after_last_use, tool_map); with those two lines removed the G-code hashes are exactly the previous ones.
// All four changed again only because the config block lists the new colour-mixing and ooze-prevention settings
// (mix_subdivide, mix_subdivide_full_domain, mix_subdivide_infill, ooze_prevention, preheat_delta_temperature);
// with those five lines removed the G-code hashes are exactly the previous ones.
// And again for mmu_segmented_region_max_width, mmu_segmented_region_interlocking_depth and default_wipe_tower_pos
// (config block only; with those lines removed the G-code is byte-identical to the original hashes above).
// The P1S hash changed on purpose: the P1S now runs Bambu Studio's own start / end / change / layer G-code and Bambu's
// machine values (retract_before_wipe 0 %, Z hop limit 249 mm, 250 mm print height); the other three are unchanged.
// Re-pinned once more for the end-of-print marker comment before Bambu's end G-code (the only line that differs).
// Re-pinned: the first travel's Z hop no longer starts from a guessed X0 Y0 (it drove the Snapmaker U1 to Y-0.8,
// error 0003-0522); it now rises on the way to the first point. Only that hop and the M73 / time estimates differ.
import { describe, expect, it } from 'vitest';
import { weld } from '../../src/engine/mesh';
import { slice } from '../../src/engine/slicer';
import { resolveConfig } from '../../src/profiles/resolve';
import { md5 } from '../../src/io/md5';
import { box, cylinder, tee } from '../fixtures';

const cfgFor = (printerId: string, overrides = {}) =>
  resolveConfig({ printerId, plate: 'textured_pei_plate', filamentId: 'generic-pla', presetId: '0.20', overrides });
const mesh = (soup: Float32Array, name: string) => { const m = weld(soup); return { id: name, name, vertices: m.vertices, indices: m.indices }; };

const CASES: { name: string; run: () => string; hash: string }[] = [
  { name: 'cube on P1S', run: () => slice([mesh(box(100, 100, 0, 20, 20, 20), 'cube')], cfgFor('bbl-p1s', { enable_arc_fitting: false })).gcode, hash: '1ed7aa1c6be363dfdf44f5775197b1c9' },
  { name: 'cylinder on Voron (arachne, arcs)', run: () => slice([mesh(cylinder(80, 80, 12, 15), 'cyl')], cfgFor('voron-24-350', { wall_generator: 'arachne', enable_arc_fitting: true })).gcode, hash: '277cf03c800ea27b2903eab1d6a1db19' },
  { name: 'tee with tree support on Prusa MK4S', run: () => slice([mesh(tee(100, 100), 'tee')], cfgFor('prusa-mk4s', { enable_support: true, support_type: 'tree_auto', enable_arc_fitting: false })).gcode, hash: '6986d56ba42e54385cfb3df0cbb063a2' },
  { name: 'vase cylinder on Ender-3 V2', run: () => slice([mesh(cylinder(100, 100, 15, 20), 'vase')], cfgFor('creality-ender3v2', { spiral_mode: true, enable_arc_fitting: false })).gcode, hash: 'e2b22580f16ec80db0e8710e7ca41f30' },
];

describe('Basic mode is the classic engine', () => {
  for (const c of CASES) it(`${c.name} — G-code unchanged`, () => {
    expect(md5(c.run())).toBe(c.hash);
  });
});
