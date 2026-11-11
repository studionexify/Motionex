# Advanced panel: UI-to-kernel wiring audit

Scope: every tech parameter (ParamSpec) and toggle in the Advanced panel (`src/ui/advanced/*`), the registry
(`src/engine/advanced/techs.ts`), the store bridge (`src/state/advanced.ts`), the session
(`src/engine/advanced/session.ts`), the modules (`src/engine/advanced/modules/*`), the machine model
(`src/engine/advanced/machine.ts`), and the mesh/cut/connector sliders in `src/ui/ToolPanels.tsx`.

Method: for each ParamSpec key, grep for a read site (`pnum`/`param` with the tech id and key), confirm the
key name matches the registry, check the unit conversion at the read site, and confirm the value reaches the
worker. Math was not reviewed beyond units and key wiring.

## Pipeline checked

1. UI control → `setTech(id, {param|enabled})` (`src/state/advanced.ts`) → `useAdvanced.techs`.
2. `advancedSliceConfig()` (`src/state/advanced.ts`) → `opts.advanced` in `src/state/slicing.ts:107`.
3. `postMessage({meshes, cfg, opts})` → `src/engine/worker.ts` → `slice()` (`src/engine/slicer.ts:185`)
   → `classic/slicer.ts:132` `createAdvancedSession(...)`.
4. `resolveTechs()` (`src/engine/advanced/techs.ts:438`) merges defaults with overrides; `ctx.pnum`/`ctx.param`
   (`session.ts:147-148`) serve the values to modules.

Worker transfer: `AdvancedConfig` is plain data (numbers, strings, booleans, arrays). The caustic image is a
`number[]`. Nothing is lost in structured clone. `machineCaps` uses `structuredClone` on the toolhead, so the
`tipLength` override does not leak between calls.

Key names: every key read in a module exists in the registry under the same name. No typos were found. Every
module `id` matches a registry id (34 modules; `sdf_frep` has no module by design).

## Tech parameters

Status key: OK = read and unit-correct. DEAD = never read. SHADOWED = read but overridden by another source.
CONDITIONAL = read only in some configurations. FIXED = was silent, now warns when changed from its default.

| Tech (id) | Param key | Declared (techs.ts) | Consumed by | Status |
|---|---|---|---|---|
| fea_stress | elements | :62 | modules/fea.ts:20 → stress.ts `partModel` | OK |
| fea_stress | loadN | :63 | modules/fea.ts:20 (passed as `newtons`), but stress.ts:136 uses `a.params.load?.newtons ?? newtons` | SHADOWED (see Finding 1) |
| fea_stress | family | :64 | modules/fea.ts:91 | OK |
| fea_stress | threshold | :65 | modules/fea.ts:84 (`quantile(vm, p)`, p is a fraction 0–1) | OK |
| sdf_frep | tpms | :74 | none | DEAD → FIXED (warning) |
| sdf_frep | cell | :75 | none | DEAD → FIXED (warning) |
| sdf_frep | grade | :76 | none | DEAD → FIXED (warning) |
| eulerian_spiral | minW | :85 | modules/eulerianSpiral.ts:12 (mm) | OK |
| eulerian_spiral | maxW | :86 | modules/eulerianSpiral.ts:12 (mm) | OK |
| conformal_layers | layers | :95 | none (conformal.ts:11 hard-codes `maxSlope` 89) | DEAD → FIXED (warning) |
| hot_on_hot | margin | :104 | modules/rheology.ts:116, 128 (°C) | OK |
| hot_on_hot | maxFanCut | :105 | modules/rheology.ts:116, 132 (fraction) | OK |
| kinematic_extrusion | paK | :114 | modules/motion.ts:80 | OK |
| z_weave | amp | :124 | modules/weave.ts:32, 69 (× layer h) | OK |
| z_weave | wavelength | :125 | modules/weave.ts:32–33, 87 (mm) | OK |
| z_weave | pins | :126 | modules/weave.ts:38 | OK |
| z_weave | pinPitch | :127 | modules/weave.ts:39 (mm) | OK |
| subvoxel_aa | maxSlope | :137 | modules/surfacePasses.ts:21 → surface.ts:65 (surfaceAbove returns degrees) | OK |
| subvoxel_aa | minH | :138 | modules/surfacePasses.ts:21 (mm) | OK |
| turing_infill | F | :147 | modules/turing.ts:122 | OK |
| turing_infill | k | :148 | modules/turing.ts:122 | OK |
| turing_infill | aniso | :149 | modules/turing.ts:122 | OK |
| turing_infill | scale | :150 | modules/turing.ts:91 | OK |
| corner_overshoot | gain | :159 | modules/motion.ts:106 | OK |
| corner_overshoot | minAngle | :160 | modules/motion.ts:107 (deg → rad), compared with the interior angle at :122 | OK |
| spatial_lattice | cell | :169 | modules/lattice.ts:17 (clamped to tip length − 0.4 mm) | OK (adapted) |
| spatial_lattice | flow | :170 | modules/lattice.ts:19 | OK |
| spatial_lattice | speed | :171 | modules/lattice.ts:19 (mm/s) | OK |
| spatial_lattice | dwell | :172 | modules/lattice.ts:19 (s) | OK |
| metamaterial | cell | :181 | modules/cells.ts:105 (mm) | OK |
| metamaterial | angle | :182 | modules/cells.ts:104, but `design?.reentrantAngle ??` overrides it when homogenization designs a re-entrant cell (negative target ν) | CONDITIONAL (see Finding 3) |
| metamaterial | dither | :183 | modules/cells.ts:105 | OK |
| dovetail | depth | :192 | modules/dovetail.ts:45–46 (mm) | OK |
| dovetail | pitch | :193 | modules/dovetail.ts:45–46 (mm) | OK |
| sgd_slicing | w1 | :203 | modules/sgdSlicing.ts:14 | OK |
| sgd_slicing | w2 | :204 | modules/sgdSlicing.ts:14 | OK |
| sgd_slicing | w3 | :205 | modules/sgdSlicing.ts:14 | OK |
| sgd_slicing | w4 | :206 | modules/sgdSlicing.ts:14 | OK |
| sgd_slicing | iters | :207 | modules/sgdSlicing.ts:15 | OK |
| sgd_slicing | ctrl | :208 | modules/sgdSlicing.ts:15 | OK |
| eikonal_offsets | method | :217 | modules/eikonal.ts:37 (`'fmm'` vs heat) | OK |
| eikonal_offsets | smooth | :218 | modules/eikonal.ts:38 | OK |
| eikonal_offsets | cell | :219 | modules/eikonal.ts:38 (mm) | OK |
| inverse_warp | gain | :228 | modules/inverseWarp.ts:114 | OK |
| inverse_warp | kerfs | :229 | modules/inverseWarp.ts:134 (bool) | OK |
| inverse_warp | elements | :230 | modules/inverseWarp.ts:117 | OK |
| gloss_modulation | contrast | :240 | modules/rheology.ts:61, 98 | OK |
| foam_control | coreTemp | :249 | modules/foam.ts:28 (°C) | OK |
| foam_control | hubTemp | :250 | modules/foam.ts:28 (°C) | OK |
| foam_control | xmax | :251 | modules/foam.ts:28 | OK |
| knot_braiding | pitch | :260 | modules/weave.ts:155 (mm) | OK |
| knot_braiding | lift | :261 | modules/weave.ts:155 (× h) | OK |
| co_molding | port | :270 | modules/coMolding.ts:31, 68 (mm) | OK |
| co_molding | columnPitch | :271 | modules/coMolding.ts:31 (mm) | OK |
| co_molding | columnR | :272 | modules/coMolding.ts:68 (mm) | OK |
| thick_vase | (none) | :282 `params: []` | n/a | OK |
| tangent_entry | radius | :289 | modules/seams.ts:38 (mm) | OK |
| tangent_entry | merge | :290 | modules/seams.ts:39 (deg → rad) | OK |
| scarf_splice | length | :299 | modules/seams.ts:109 (mm) | OK |
| scarf_splice | slow | :300 | modules/seams.ts:110 | OK |
| scarf_splice | fanOffMs | :301 | modules/seams.ts:111 (ms → s) | OK |
| harmonic_dome | band | :310 | modules/harmonicDome.ts:33 → harmonic.ts:85 (0 = automatic, as the tip says) | OK |
| harmonic_dome | minRatio | :311 | modules/harmonicDome.ts:33 | OK |
| harmonic_dome | maxRatio | :312 | modules/harmonicDome.ts:33 | OK |
| conformal_ironing | flow | :321 | modules/surfacePasses.ts:112 (unitless fraction of a layer's volume; see Note B) | OK |
| conformal_ironing | spacing | :322 | modules/surfacePasses.ts:112 (mm) | OK |
| conformal_ironing | speed | :323 | modules/surfacePasses.ts:112 (mm/s) | OK |
| perimeter_feathering | depth | :332 | modules/surfacePasses.ts:45, 69 (× h) | OK |
| iso_gloss | fanGamma | :341 | modules/rheology.ts:26, 48 | OK |
| quasicrystal | spacing | :351 | modules/quasicrystal.ts:127 (0 = from density, as the tip says) | OK |
| quasicrystal | maxTilt | :352 | modules/quasicrystal.ts:122 (deg) | OK |
| metric_morph | shrink | :361 | modules/metricMorph.ts:34 | OK |
| metric_morph | layers | :362 | modules/metricMorph.ts:34 | OK |
| monge_ampere | ior | :371 | modules/mongeAmpere.ts:127 | OK |
| monge_ampere | iters | :372 | modules/mongeAmpere.ts:127 | OK |
| symplectic_shaper | tolerance | :381 | modules/motion.ts:45 (mm) | OK |
| morse_router | persistence | :390 | modules/morse.ts:109 (mm) | OK |
| spinor_fields | smooth | :399 | modules/fea.ts:19 | OK |
| band_gap | freq | :408 | modules/bandGap.ts:54–55 (Hz) | OK |
| band_gap | valley | :409 | modules/bandGap.ts:53 (bool) | OK |
| homogenization | targetE | :418 | modules/cells.ts:55 | OK |
| homogenization | targetNu | :419 | modules/cells.ts:55; used only when negative (cells.ts:58–60) | CONDITIONAL (only negative ν has an effect) |

## Toggles (35 technologies)

| Toggle | Path | Status |
|---|---|---|
| Per-tech on/off (`setTech(id,{enabled})`) | `TechList.tsx` → `state/advanced.ts:setTech` → `resolveTechs` (techs.ts:441) → `ctx.on()` (session.ts) → `MODULES.filter` | OK for 34 techs |
| sdf_frep | Enabled by intent, but has no module; the report marks it `applied` unconditionally (session.ts, `applied` line) | OK, see Finding 2 |
| Heatmap, Interior zones, field chips | UI-only (`state/advanced.ts`, Zone Inspector) | OK |
| Intent cards | `resolveTechs` default selection and report `intent` | OK |

## Advanced-panel inputs (not ParamSpec)

| Control | Store key | Consumer | Status |
|---|---|---|---|
| Resolution select | `resolution` | `advancedSliceConfig` → `RESOLUTION_CELLS[adv.resolution]` (session.ts) and analysis (`runAnalysis`) | OK |
| Load direction | `load.dir` | session.ts → analysis `load` → stress.ts:133 `a.params.load?.dir` | OK |
| Load newtons | `load.newtons` | session.ts → stress.ts:136 (takes precedence over loadN) | OK (see Finding 1) |
| Caustic image | `caustic.pixels` | `advancedSliceConfig` → `session.ctx.adv.caustic` → `mongeAmpere.ts:121` | OK |
| Caustic mode | `caustic.mode` | mongeAmpere.ts:122 (lens), :140 (lampshade) | OK |
| Caustic throw | `caustic.throwMm` | mongeAmpere.ts:93–94, 135 | OK |
| Paint tools | `paintValue` / per-triangle paint | `analysis`, stress.ts:47 | OK (out of scope, not traced in depth) |

## Machine capability overrides (MachineCard)

| Field | Consumer | Status |
|---|---|---|
| kinematics | machine.ts `kin` → session.ts report | OK |
| axes (via 5-axis kinematics) | machine.ts `axes` → morse.ts, session.ts, techs.ts | OK |
| tipLength | machine.ts `clearanceSlope` and toolhead offsets | OK |
| resonanceX / resonanceY | machine.ts → motion.ts (`caps.resonance`) | OK |
| maxFlow | machine.ts → weave.ts | OK |
| maxAccelZ | machine.ts → weave.ts, techs.ts | OK |
| inputShaper | machine.ts → motion.ts, techs.ts | OK |
| pressureAdvance | machine.ts → motion.ts, classic/slicer.ts | OK |
| heatedChamber | machine.ts → rheology.ts, inverseWarp.ts | OK |
| continuousFiber | machine.ts → techs.ts:401 (band-gap mould verdict) | OK |
| heaterHalfWidth | machine.ts `clearanceSlope` (no UI control) | OK, API only |
| chamberTemp | machine.ts → rheology.ts (no UI control) | OK, API only |
| rotaryA / rotaryC | Stored in caps, read nowhere, no UI control | DEAD (API only) |

## Other tool panels (`src/ui/ToolPanels.tsx`)

| Panel | Control | Consumer | Status |
|---|---|---|---|
| Cut | Height, Tilt X, Tilt Y | `state/tools.ts:33–49` (plane rotation), Viewport.tsx:412 | OK |
| Groove | Depth, Width, Flap angle, Groove angle, Depth tol., Width tol. | `state/cutConnectors.ts:131–143`; `state/tools.ts:63` | OK |
| Connector | Type, Style, Shape, Depth, Size, Depth tol. (%), Size tol. (%), Bulge, Space | `state/cutConnectors.ts:61–105` (tol. at :93, bulge :64, space :72) | OK |
| Text / SVG emboss | Size, Depth | `state/tools.ts:297`; ToolPanels.tsx:140–141 | OK |
| Edges | Crease angle | Viewport.tsx:378, 608, 644; `meshedit` | OK |
| Edges | Chamfer/fillet size, Round segments | `bevelSelectedEdges(size, segments)` | OK |
| Edges | Smooth levels, Relax passes | `subdivideObject` / `smoothObject` | OK |
| Edges | Max edge | `refineObject` / `remeshObject` (`state/meshTools.ts:145`) | OK |

No dead sliders were found in ToolPanels.tsx.

## Findings

1. **FEA `loadN` is shadowed (SHADOWED, not fixed).** `fea_stress.loadN` (techs.ts:63) is passed as
   `newtons` to `partStress` (fea.ts:20). `stress.ts:136` then uses `a.params.load?.newtons ?? newtons`. The
   panel's Load case always supplies `load` (store default 50 N, `advancedSliceConfig` always includes it),
   so the tech slider has no effect in the app. Two inputs (Load card and the tech tensor weight) describe the
   same quantity. Which one should win is a design decision, so this was not changed. Either remove `loadN`
   or make the Load card the single source and drop the slider.

2. **sdf_frep TPMS settings are unwired (DEAD, FIXED to warn).** `tpms`, `cell`, `grade` (techs.ts:74–76)
   have no reader. `sdf_frep` has no module, and session.ts reports it as `applied` unconditionally. Real TPMS
   infill is math work, so it is out of scope. `session.ts` now warns when any of these is changed from its
   default (see Changes).

3. **Metamaterial angle is overridden by homogenization (CONDITIONAL).** `cells.ts:104`
   (`design?.reentrantAngle ?? s.pnum('metamaterial','angle')`). When homogenization designs a re-entrant cell
   (metamaterial on and `targetNu < 0`), the user's angle slider is silently replaced. Intended by the code,
   but the UI does not show it. Not changed.

4. **conformal_layers.layers is unwired (DEAD, FIXED to warn).** `conformal.ts` does not read it. It hard-codes
   `maxSlope` to 89 (conformal.ts:11). A layer count would need a new algorithm. Warns when changed.

5. **Machine rotaryA / rotaryC are dead (API only).** They are in `MachineOverrides` (types.ts) and stored in
   `caps`, but nothing reads them and the UI has no control. Remove them or implement the rotary path.

## Notes (checked, not changed)

- **A. Spatial-lattice cell clamp.** `lattice.ts:17` clamps the cell to `tip_len − 0.4 mm`. The panel allows up
  to 20 mm without telling the user. Consider surfacing the clamp in the tip or the report.
- **B. Conformal-ironing flow units.** The registry flow (default 0.015) is a unitless fraction of a layer's
  volume (surfacePasses.ts:112 computes `w·h·flow / filament area`). The classic `ironing_flow` default is 10%.
  This is a deliberate burnishing default, but it is not labelled in the UI.
- **C. Harmonic-dome band and quasicrystal spacing.** Both treat 0 as automatic, as their tooltips say
  (harmonic.ts:85, quasicrystal.ts:127). Correct.
- **D. Units spot-checked.** Degree/radian conversions: corner minAngle (motion.ts:107), tangent merge
  (seams.ts:39), subvoxel maxSlope (surface.ts returns degrees), quasicrystal maxTilt. Time: fanOffMs
  (seams.ts:111). All match their registry units.
- **E. Machine-card ↔ session parity.** The UI calls `resolveTechs` with the same overrides and caps as the
  session, so the chip statuses match the slice.

## Changes

| File | Change |
|---|---|
| `src/engine/advanced/session.ts` | Added `UNWIRED_PARAMS` (sdf_frep tpms/cell/grade, conformal_layers layers). When one is enabled and differs from its default, `createAdvancedSession` calls `ctx.warn`, so the engine report and toast say the setting is ignored. No behaviour change otherwise. |
| `AUDIT_WIRING.md` | This report (new). |

No other source files were modified. No commit was made.

## Verification

- `npx tsc --noEmit`: exit 0, no errors.
- Not run: the app, or a slice in the worker. The wiring was verified by reading the code, not by running it.
