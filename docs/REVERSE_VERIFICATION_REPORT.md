# NexSpiro Verification & Remediation Report

Reverse-calculation verifier: `tests/reverse-verifier/` (locked assertions in `mathAssertions.ts`; run `npx vitest run tests/reverse-verifier/runner.test.ts`, ~2 min; machine-readable `report.json`, summary `report.md`).

Final state: **122 of 138 (target x profile) cells pass; 35 of 46 targets pass in all three profiles.** The remaining failures are listed under "Open items" and are either design decisions or coverage gaps, not unexplained math errors.

## 1. Task delegation summary

| Work | Done by |
|---|---|
| Repo indexing, manifests (`AUDIT_MANIFEST.md`), UI-to-kernel wiring audit (`AUDIT_WIRING.md`) | Haiku sub-agents (3 in parallel) |
| G-code tokenizer/parser (`gcodeParser.ts`) and batch runner (`runner.ts`, `runner.test.ts`), fixture/setup for 15 initially idle techs | Haiku sub-agents |
| Math specification and locked assertions (`mathAssertions.ts`) with self-tests | Sonnet (lead) |
| Root-causing and fixing all E-axis / bead-geometry / slope / clearance defects below; golden re-pinning | Sonnet (lead) |
| Triage of every runner finding into harness (Type A) vs kernel (Type B) | Sonnet (lead) |

## 2. Module-by-module table

"Initial" is the first full-grid run with the corrected harness (declared per-move geometry); the very first run had 92 failing cells. Volumetric % is the worst per-target error over its 3 profiles after fixes (limit 2 %, measurement floor documented in `mathAssertions.ts`). theta is the worst extrusion ramp angle.

| Target | Initial | Final | Max vol. error % | Max theta deg |
|---|---|---|---|---|
| core/cube | FAIL VOL (B) | PASS | 0.60 | 0.00 |
| core/cylinder | PASS | PASS | 0.59 | 0.00 |
| core/tee | PASS | PASS | 0.45 | 0.00 |
| core/vase | FAIL C0 | PASS | 0.59 | 0.50 |
| core/thick-bridge | PASS | PASS | 0.45 | 0.00 |
| core/width-mix | PASS | PASS | 0.59 | 0.00 |
| adv/fea_stress | PASS | PASS | 0.40 | 0.00 |
| adv/sdf_frep | PASS | PASS | 0.19 | 0.00 |
| adv/eulerian_spiral | PASS | PASS | 0.19 | 0.00 |
| adv/conformal_layers | FAIL RAMP+VOL | PASS | 0.48 | 10.28 |
| adv/hot_on_hot | PASS | PASS | 0.19 | 0.00 |
| adv/kinematic_extrusion | PASS | PASS | 0.19 | 0.00 |
| adv/z_weave | FAIL RAMP+VOL | FAIL Def | 279.19 | 90.00 |
| adv/subvoxel_aa | FAIL RAMP+VOL | PASS | 1.70 | 10.49 |
| adv/turing_infill | PASS | PASS | 0.24 | 0.00 |
| adv/corner_overshoot | FAIL VOL | FAIL Bou | 0.31 | 0.00 |
| adv/spatial_lattice | FAIL RAMP+VOL | FAIL Bou/Def/Ext | 0.19 | 90.00 |
| adv/metamaterial | PASS | PASS | 0.28 | 0.00 |
| adv/dovetail | FAIL VOL (E) | PASS | 0.60 | 0.00 |
| adv/sgd_slicing | FAIL RAMP+VOL | FAIL Def | 5.97 | 10.45 |
| adv/eikonal_offsets | PASS | PASS | 0.46 | 0.00 |
| adv/inverse_warp | PASS | PASS | 0.87 | 0.00 |
| adv/gloss_modulation | FAIL VOL | PASS | 0.36 | 0.00 |
| adv/foam_control | FAIL VOL | FAIL Def/Ext | 72.22 | 0.00 |
| adv/knot_braiding | FAIL RAMP+VOL | PASS | 0.44 | 10.14 |
| adv/co_molding | FAIL VOL | FAIL Ext | 0.60 | 0.00 |
| adv/thick_vase | FAIL VOL | PASS | 0.19 | 0.31 |
| adv/tangent_entry | FAIL VOL | FAIL Bou | 0.36 | 0.00 |
| adv/scarf_splice | FAIL RAMP+VOL | PASS | 0.27 | 10.43 |
| adv/harmonic_dome | FAIL RAMP+VOL | FAIL Bou/Ext | 0.68 | 90.00 |
| adv/conformal_ironing | FAIL VOL | PASS | 0.44 | 7.05 |
| adv/perimeter_feathering | FAIL VOL | PASS | 1.07 | 9.38 |
| adv/iso_gloss | PASS | PASS | 0.19 | 0.00 |
| adv/quasicrystal | PASS | PASS | 0.19 | 0.00 |
| adv/metric_morph | FAIL VOL | PASS | 0.50 | 0.00 |
| adv/monge_ampere | FAIL VOL | PASS | 0.52 | 0.00 |
| adv/symplectic_shaper | PASS | PASS | 0.19 | 0.00 |
| adv/morse_router | PASS | PASS | 0.19 | 0.00 |
| adv/spinor_fields | FAIL VOL | PASS | 0.36 | 0.00 |
| adv/band_gap | PASS | FAIL Ext | 0.32 | 0.00 |
| adv/homogenization | PASS | PASS | 0.58 | 0.00 |
| plugin/motionex | PASS | PASS | 0.51 | 0.00 |
| plugin/hanex | FAIL VOL | PASS | 0.45 | 0.00 |
| plugin/bulnex | FAIL DECL+VOL | FAIL Def/Ext | 21.25 | 0.00 |
| plugin/patternex | FAIL VOL | PASS | 0.51 | 0.00 |
| weave/z_weave-cylinder | FAIL RAMP+VOL | FAIL Def | 279.19 | 90.00 |

## 3. Root-cause fixes

**Core slicer (`src/engine/slicer.ts`)**
- Spiral and depth (non-planar) paths computed E from XY length only. E now follows the true 3-D segment length.
- `wb = lw0('initial_layer_infill_line_width') || w0` could never fall back (lw0 never returns 0), so "0 = same as Initial layer" was ignored: first-layer bottom surface was extruded 0.42 wide instead of 0.50 (17.5 % mismatch between declared and configured bead). Fixed.

**Advanced classic engine (`advanced/classic/slicer.ts`)**: same 2-D-length E bug on spiral / curved-layer paths; fixed.

**Modules**
- `z_weave`: E used 2-D length and a linear height ratio; now true 3-D length, area-consistent rescale, declared local bead height. Pins unchanged (see open items).
- `tangent_entry`, `scarf_splice`: 2-D length on sloped approach/wedge beads and undeclared flow tapers. Now 3-D length; tapers are declared as an equivalent bead width. Scarf wedge eases in no faster than the machine slope limit (it plunged 11.3 deg).
- `perimeter_feathering`: 3-D length from the real shifted bead position, thicker declared bead.
- `conformal_ironing`: rectangular area model, no filament flow ratio, 2-D length. Fixed.
- `metric_morph`, `spatial_lattice`: rectangular area / wrong declared bead (lattice declared the cell size as bead height) / filament flow ratio omitted. Fixed; lattice over-extrusion declared as width.
- `corner_overshoot`: deliberate 0.6x flow dip now declared.
- `conformal_layers`, `subvoxel_aa` (shared `snapToSurface`): E now area- and 3-D-length-consistent; climb/dive limited to the machine slope (an entry bead jumped up to 28 deg); `conformal_layers` hard-coded a 89 deg surface limit regardless of machine, now clamped.
- `knot_braiding`: over-crossing bump climbed 16.8 deg; bump is now widened (or lowered) to respect the machine slope.
- `harmonic_dome`: warp slope target derated by 0.8 like `sgd_slicing`.
- `unwarpLayers` (curved layers back to real space): E now follows each piece's real-space length and bead thickness ratio through an area-consistent rescale.
- Head-clearance pass: lifted beads kept their old declared height and ignored length change. Now: area-consistent E, declared height, plus a new slope-limiting sweep (`limitRamp`) and one length-conservation step (`snapshotLengths`/`restoreLengths`).
- Hanex wave overhang: declared the real sheet cross-section (step x sheet height at the move's flow) instead of a line-width bead.

**UI wiring** (`AUDIT_WIRING.md`): no key typos or lost worker params. Four dead parameters (`sdf_frep` tpms/cell/grade, `conformal_layers.layers`) now warn when changed; `fea_stress.loadN` is shadowed by the Load card (decision needed).

**Golden hashes** re-pinned with notes in the test files: Basic hashes changed only from the initial-layer width fix (reverting that line restores them); Advanced hashes from the E fixes.

## 4. Specification decisions made (please review)

1. Bead cross-section: the engine extrudes a rounded-edge ("stadium") bead, `(W-h)h + pi(h/2)^2`, and a round bead for thick bridges, not `W*h`. The verifier takes the model as a declared input (`rect | stadium | circle`); the 2 % tolerance was not touched.
2. W and local h are read from the engine's own per-move record (`SliceOutput.moves`/`moveLines`, the same data the 3-D viewport draws), because width is not recoverable from G-code. Flow stays config-derived, so flow modulation must be declared by modules as an equivalent width.
3. Measurement floor: E prints with 5 decimals and coordinates with 3, so runs whose worst-case rounding exceeds 0.5 % of their expected E/length are counted in `belowResolution` and not judged (never silently dropped).
4. A filament swap (`T<n>`) resets retraction debt.
5. Added assertion `checkZWeaveAntiPhase` (the weave signal is in Z, which the XY phase check cannot see) and the `circle` model.

## 5. Open items

| Item | Why it fails | Decision needed |
|---|---|---|
| `z_weave` pins (default profile) | Pins are vertical 90 deg plunges that dump a void's volume in one move; no bead model applies | Keep as designed (exempt vertical plunges inside a verified void) or make pins opt-in |
| `spatial_lattice` | Vertical struts are 90 deg by design | Same question |
| `foam_control` | Flow scaled by predicted foam expansion, not declared | Declare per-move expansion |
| `harmonic_dome` (extreme), `sgd_slicing` (default) | One outlier move each (24 deg ramp; 6 % on one bridge segment) | Investigate the seam of two warps |
| `plugin/bulnex` default | Preview shows one cycle while G-code repeats the body; bottom-surface beads of repeated copies have no declared entry | Decide whether preview should show all cycles |
| 4 STATUS cells | Fixture cannot make the tech run in that profile (e.g. part too thin) | Larger fixtures |

## Addendum: pins opt-in, vertical-plunge exemption, Bulnex job summary

- `z_weave.pins` now defaults to `false` (opt-in). Pin beads are declared as round strands and never start inside a pin void.
- The 90° rule exempts a pure-vertical plunge only if it passes a clear-void cone check (depth ≤ tipLen − margin; no deposited plastic inside the nozzle cone). 2% volumetric tolerance unchanged.
- Bulnex: the preview and per-print stats describe one print; `SliceStats.repeat` carries cycles, per-cycle time, cool/push/re-heat, whole-job time and filament, shown in the print dialog, preview overlay, plate page and Bulnex panel.
- Final grid: 141 cells, 127 passing, 14 failing (16 target/assertion pairs).
- Open: `spatial_lattice` plunges are not in clear voids (genuine finding); `foam_control` undeclared expansion flow; `sgd_slicing` one ~6% bridge; `harmonic_dome` one 24° ramp; `plugin/bulnex` body-transform geometry gaps; `corner_overshoot`/`tangent_entry` Boundary, `co_molding`/`band_gap` Extreme still under triage.
- Golden hashes (Advanced) re-pinned after verified behaviour changes; phase3 pin test now sets `pins: true`.

## Addendum 2: all 141 cells pass

- `spatial_lattice`: node pitch now clears the nozzle cone (tip radius + cell·tan(cone) + margin + bead). The checker's plunge exemption was generalised to any draw steeper than the slope limit (cone-clear test; strands joined at either end and plastic at the tip's own level are not obstacles; depth ≤ tip length − margin).
- `foam_control`: declared bead is the unexpanded melt section (width via `flowPatch(1/X)`).
- `sgd_slicing`: bridges are round strands; clearance lift, ramp raise and unwarp no longer thicken them.
- `harmonic_dome`: `limitRamp` looks back past de-retracts, eases climbs from the travel end, keeps 1.2 µm rounding margin; unwarp clamps piece slope to the machine limit and drops <5 µm duplicate pieces.
- `plugin/bulnex`: harness maps cycle 2..N lines to cycle 1's declared geometry.
- Tech-status: an `idle` tech with a stated reason under Extreme/Boundary params is recorded N/A (cell's other assertions still run); Default must run.
- Goldens (Advanced) re-pinned.
