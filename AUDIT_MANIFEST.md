# AUDIT_MANIFEST (merged: A = math/engine, B = plugins/tools, WIRING = UI->kernel)

# AUDIT MANIFEST A: slicing strategies and extrusion (E) models

Read-only audit. No source files were modified. Line numbers are from the working tree at audit time.

## 1. Inventory

Legend. **E 3D?** = E is computed from a 3D length (dZ included). **E 2D?** = E is computed from XY length only. "planar" = the move stays at one Z, so 2D and 3D agree.

### 1a. Advanced engine technologies (`src/engine/advanced/modules/*`, registry `index.ts:29`)

| id (techs.ts n) | name | entry (file:line) | signature | where E is computed | E 3D or 2D |
|---|---|---|---|---|---|
| `z_weave` (7) | Sinusoidal Z-weaving and Z-pinning | `src/engine/advanced/modules/weave.ts:28` | `zWeave: TechModule` with `post(s, layers)` | `weave.ts:100` `e = (op.e/n) * (height/L.h)`, where `op.e` is the slicer's 2D-based E split over `n` sub-segments | **2D** (height ratio only, no slope term). Non-planar. See S1. |
| `z_weave` pins | Z-pinning rivets | `weave.ts:118` | same module | `weave.ts:118` `e: vol/filA` (vertical, so 3D is trivially correct) | 3D (vertical) |
| `knot_braiding` (19) | Topological knot braiding | `weave.ts:150` | `knotBraiding: TechModule` with `wallsPost(s,_o,layer,_ex,rings)` | Z lift `zs = bump*lift*h` at `weave.ts:187-188` (lift default 0.5 h, `techs.ts:258`). E comes from the slicer, `classic/slicer.ts:669` (2D len) and `:678` | **2D** with per-point dZ. See S2. |
| `thick_vase` (21) | Multi-perimeter helical thick-vase | `src/engine/advanced/modules/thickVase.ts:46` | `thickVase: TechModule` with `infill` and `post` | Re-orders existing pieces, keeps their E. Helix Z from `classic/slicer.ts:672`: `startZ + h*run/totalLen`, with `run` 2D | 2D run, but dZ per loop = h, so negligible |
| `eulerian_spiral` (3) | Eulerian continuous spiralization | `eulerianSpiral.ts:5` → `spiralFill` at `src/engine/advanced/eulerian.ts:29` | `infill(s,_o,region,c)` | slicer `classic/slicer.ts:678`, 2D | planar, 2D is correct |
| `tangent_entry` (22) | Sub-surface tangential spiral entry | `seams.ts:34` | `tangentEntry: TechModule` | `seams.ts:78-80` `len*ePerMm*flow` with `ePerMm = p.e/Ltot` (line 57). Approach points carry their own Z (`seams.ts:59-63`) | **2D** on non-planar approach. See S3. |
| `scarf_splice` (23) | 3D volumetric scarf-wedge splice | `seams.ts:105` | `scarfSplice: TechModule` | `seams.ts:128-130` `len*ePerMm*flow`, 2D length, Z ramp of ~half a layer | **2D** (name says "3D"). See S3. |
| `spatial_lattice` (11) | Mid-air spatial lattice weaving | `lattice.ts:10` | `spatialLattice: TechModule` | diagonal `lattice.ts:54` `Math.hypot(x-lx, y-ly, za-lz) * ePerMm`; posts `lattice.ts:55` `cell*ePerMm` (vertical) | **3D** (correct) |
| `metric_morph` (29) | Riemannian metric tensor slicing | `metricMorph.ts:30` | `metricMorph: TechModule` | `metricMorph.ts:81`, 2D length × `ePerMm = w*lh/area` (line 75). Z is fixed per layer (line 76) | planar, 2D correct |
| `conformal_ironing` (25) | 3D conformal ironing | `surfacePasses.ts:107` | `conformalIroning: TechModule` | `surfacePasses.ts:157` `Math.hypot(x-lx, y-ly) * ePerMm` (line 115). Z varies per point over the surface | **2D** with dZ. Low impact (ironing flow). See S4. |
| `quasicrystal` (28) | 6D cut-and-project quasicrystal infill | `quasicrystal.ts:118` → `quasicrystalLines` at `:81` | `quasicrystal: TechModule`, `quasicrystalLines(region, z, o, spacing): Paths` | slicer `classic/slicer.ts:678` | planar, 2D correct |
| `turing_infill` (9) | Gray-Scott Turing infill | `turing.ts:84` | `turingInfill: TechModule` | slicer, 2D | planar, 2D correct |
| `fea_stress` (1) | FEA stress-aligned fields | `fea.ts:59` | `feaStress: TechModule` | slicer, 2D | planar, 2D correct |
| `band_gap` (34) | Topological band-gap infill | `bandGap.ts:49` | `bandGap: TechModule` | slicer, 2D | planar, 2D correct |
| `metamaterial` (12) | Re-entrant auxetic cells | `cells.ts:99`; lines `cells.ts:81` `reentrantLines(...)` | `metamaterial: TechModule` | slicer, 2D | planar, 2D correct |
| `homogenization` (35) | Gyroid / 6D elastic homogenization | `cells.ts:51` | `homogenization: TechModule` | slicer, 2D | planar, 2D correct |
| `harmonic_dome` (24), `sgd_slicing` (14), `conformal_layers` (4), `eikonal_offsets` (15), `morse_router` (32), `co_molding` (20), `dovetail` (13), `mongeAmpere` (30), `spinor_fields` (33) | layer plans, walls, routing | `modules/*.ts` | `TechModule` | E from slicer `classic/slicer.ts` (2D) | depends on whether layer is planar; not audited per module |
| `inverse_warp` (16), `subvoxel_aa` (8), `perimeter_feathering` (26), `iso_gloss` (27), `gloss_modulation` (17), `hot_on_hot` (5), `foam_control` (18), `kinematic_extrusion` (6), `symplectic_shaper` (31), `corner_overshoot` (10) | post-passes | `modules/*.ts` | `TechModule` | flow scaling of existing E; `motion.ts:116` uses 2D len for corner logic only | not audited per module for E |

Other modules that change E: `motion.ts`, `rheology.ts`, `foam.ts` modify flow of existing moves. `foam.ts:37` uses 3D length for timing only.

### 1b. Main (non-advanced) slicer paths that feed E for all of the above

| item | file:line | E source | 3D or 2D |
|---|---|---|---|
| Main slicer entry | `src/engine/slicer.ts:181` `slice(meshes, cfg, progress, opts)` | dispatches to advanced via `slicer.ts:185` when `opts.advanced` | n/a |
| Main extrusion loop | `src/engine/slicer.ts:1129-1145` | `const len = Math.hypot(x - px, y - py)` (`:1129`); `zz` may vary via `it.spiral` / `it.depth` (`:1133`); `e: len*ePerMm*segFlow` (`:1145`) | **2D**. Non-planar `depth` (scarf) moves get 2D E |
| Advanced classic slicer extrusion | `src/engine/advanced/classic/slicer.ts:669-678` | `len` 2D (`:669`); `zz` with `zoff` per-point wall offsets (`:672`); `e: len*ePerMm` (`:678`) | **2D** with dZ from `zs` |
| Advanced classic slicer entry | `src/engine/advanced/classic/slicer.ts:118` `slice(...)` | | |
| Advanced planner | `src/engine/advanced/planner.ts:18`, `classic/gcode.ts:89` | `Math.hypot(dx,dy,dz)` | 3D, used for timing only, not for E |
| Shared move helper | `src/engine/advanced/runs.ts:82` `moveLike(m,x,y,z,e,patch)` | passes E through | n/a |

### 1c. Motionex (motion brushes, spirograph/cycloid presets)

| id | name | entry (file:line) | signature | E | 3D or 2D |
|---|---|---|---|---|---|
| `motionex` | Motionex plugin | `src/plugins/motionex/engine.ts:146` `motionexEngine.postToolpath(layerOps, config, ctx)` | `postToolpath(layerOps, config, ctx): {check, movedPaths}` | `runToOps` `engine.ts:127`, `:138`: `len = Math.hypot(dx,dy,dz)`; `e = len * run.ePerMm * q.flow` (`:140`) | **3D** (incl. dZ). `ePerMm` from `opsToLayers` `engine.ts:75`, `:95` `lenSum += Math.hypot(...3D)`. Energy is conserved per run. |
| applyMotion | `src/plugins/motionex/modifier.ts:460` | `applyMotion(layers, apps, brushes, p, opt?, check?, regions?) → {layers, warnings}` | n/a |
| applyBrushToPath | `modifier.ts:249` | `applyBrushToPath(path, b, p, opt, weight, warn, layer?, check?, source?, repeats?) → Toolpath` | XY offsets; Z via `dz` at `modifier.ts:266-382`, `:382` `q.z = c.z + dz` |
| composePath | `modifier.ts:258` | `composePath(path, layers, p, opt, warn, layer?, check?, source?)` | 2D nearest-point search at `modifier.ts:212` (for clearance only, not E) |
| Spirograph (hypotrochoid) preset | `src/plugins/motionex/presets.ts:293-298` | key `spiro-R-r`, `lat`/`along` from `f(u)`, `amp: 1.6`, `period: 4.5`, `speed: slow` | E comes from the run via `runToOps`, 3D. The preset sets only lateral/along offsets, no dZ. |
| Cycloid preset | `presets.ts:290-291` | `lat`/`along` cos/sin, `amp` derived from `k*4/TAU` | same |
| Z modulation (dZ) | `modifier.ts:266-315` (`dz[]` accumulator), `:382` | `q.zOff = dz` | 3D via runToOps |

### 1d. Patternex (Spirograph family and other pattern engines)

| id | name | entry (file:line) | signature | E | notes |
|---|---|---|---|---|---|
| `spirograph` (Math category) | Spirograph (hypotrochoid/epitrochoid) | `src/plugins/patternex/library/families.ts:877` (`gen` at `:878`) | `gen(p, W, H)` returns `GenShape[]` (2D rings) | none | Produces a 2D colour mask (`c` = ink group), not a toolpath. Feeds `buildPattern` at `src/plugins/patternex/library/catalog.ts:93` (`f.gen(params, w, h, rng)` at `:96`). |
| Patternex engine | `src/plugins/patternex/engine.ts:527` `patternexEngine` | `PatternexSession` class `engine.ts:80`; `applyShift` `engine.ts:339`; `applyRegionEffects` `engine.ts:576` | `applyShift(ops, marker, shift, p)` | `engine.ts:330-333` splits E by 3D fraction `f` (`len3`); `engine.ts:432` uses 2D `Math.hypot(op.x-s[0], op.y-s[1])` for the zone length | Mixed. `effects.ts:144-151` (`fuzzMove`) splits E equally over 2D length, which conserves total E. |
| Projection | `src/plugins/patternex/projection.ts:44` `frameOf`, `:73` `toPattern`, `:81` `fromPattern` | maps 3D faces to 2D pattern space | n/a | |

### 1e. Other plugins

| plugin | entry | toolpath / E? |
|---|---|---|
| Hanex (wave overhang, planar) | `src/plugins/hanex/engine.ts:192` `hanexEngine`; `core/plan.ts:95` `planComponent(comp, p, opts)`; E at `core/plan.ts:192-194` `vol/Af`, `vol = area*flow*len` (2D) | Yes. Waves are at constant Z (`hanex/engine.ts:172`), so 2D is correct. |
| Bulnex (push block) | `src/plugins/bulnex/engine.ts:80` `bulnexEngine`; `ejectBlock` `:16` | Fixed G-code E commands, not geometric E |
| Flenex, Clickex, Lumonex, Plantex | `src/plugins/flenex/build.ts:65` `runBuild`, `src/plugins/clickex/build.ts:142` `buildClicker`, `src/plugins/lumonex/build.ts:150` `buildLamp`, `src/plugins/plantex/mesh.ts:373` `buildBody` | Mesh/3MF generators, no E model |
| Renex | `src/renex/engine.ts:70` `buildScene` | Render only |

## 2. How to call headlessly from vitest

Test helper patterns from `tests/`:

- **Advanced techs.** `tests/advanced/helpers.ts`: `adv(meshes, printerId, [techId], intent?, {overrides?, params?, extra?, filaments?})` returns `{out, rep}`. It calls `slice` from `src/engine/slicer.ts:181` with `advanced: {intent, printerId, techs, resolution: 'draft'}`. Read moves with `segments(out, layer, feature)`. Meshes come from `tests/advanced/shapes.ts` (`indexed`). Example: `adv(indexed(box), 'bbl-p1s', ['z_weave'], 'structural', {params: {z_weave: {amp: 0.45, wavelength: 1}}})`.
  - Note: `segments()` at `helpers.ts:~20` says the 6th element is `w`, but it reads `m[i*8+3]` (E index) and checks it `> 0`. The packing comment points to a `packMoves()` that does not exist in `src` (`src/engine/types.ts:175`). Verify the layout before relying on it.
- **Main slicer.** `tests/engine.test.ts:51`: `slice([meshInput(box(...), 'cube')], cfgFor(printerId))` (`tests/fixtures.ts` for `box`, `tee`, `cylinder`).
- **Motionex.** `tests/motionex/helpers.ts`: `profiles(machine?, process?)` (`:2-4`). Pattern from `tests/motionex/modifier.test.ts:3,19`: `applyBrushToPath(path, {...PRESETS[x]}, profiles(), DEFAULT_OPTIONS, () => 1, () => {})`. Use `PRESETS` from `src/plugins/motionex/presets.ts`. For the full engine, use `applyMotion` (`modifier.ts:460`) or `motionexEngine.postToolpath` with a `layerOps` array.
- **Patternex.** `tests/patternex/library.test.ts:16-25`: `buildPattern(specOf(libraryEntries().find(e => e.family==='spirograph' && e.preset==='classic')!))` from `src/plugins/patternex/library/catalog.ts`. This test already covers the Spirograph family.
- **Hanex.** `tests/hanex/integration.test.ts`, `plan.test.ts`: `planComponent` and `hanexEngine`.

## 3. Suspicious spots

**S1. zWeave uses 2D length for E on non-planar moves.** `src/engine/advanced/modules/weave.ts:86` (`len` 2D) and `:100` (`e = (op.e/n)*(height/L.h)`). Moves are at `z = op.z + off` with `off = sign*amp*sin(kx)sin(ky)` (`:96`). Along the slope, the true bead length is `sqrt(dxy^2 + dz^2)`, so E is short by that factor. Slope is at most `amp*k*sqrt(2)`, where `amp = A*L.h` (`:66`) and `k = 2π/λ`. At the defaults (A=0.25, λ=4 mm, h=0.2 mm) the factor is about 1.006, so the error is small. At the slider limits (A=0.45, λ=1 mm, h=0.2 mm) the factor is about 1.28. The VMax clamp at `:71` limits speed, not E. Fix: scale E by `sqrt(1+(dz/dxy)^2)` or use `hypot(dxy, dz)` as `len`.

**S2. Knot braiding relies on the slicer's 2D E for per-point Z lift.** `src/engine/advanced/modules/weave.ts:187-188` sets `zs = bump*lift*h`, and `classic/slicer.ts:672` applies it. E is 2D (`classic/slicer.ts:669`, `:678`). Default lift is 0.5 h (`techs.ts:258`), so the dZ is about 0.1 mm over a 0.3 mm resample step at the peak. The error is up to about 5% and small at defaults.

**S3. Tangent entry and scarf splice use 2D E, despite the "3D" name.** `src/engine/advanced/modules/seams.ts:78-80` and `:128-130`. The approach path (`seams.ts:59-63`) has its own Z per point, which is a real sub-surface descent, and E is not 3D. The scarf (`scarfSplice`, id `scarf_splice`) is described as "3D volumetric" in `seams.ts:105` and its header, but its E is 2D. Scarf Z ramp is about half a layer, so the error is small. Approach descent may be larger; not quantified.

**S4. Ironing/conformal passes use 2D E over a Z-varying surface.** `src/engine/advanced/modules/surfacePasses.ts:157` (`Math.hypot(x-lx, y-ly) * ePerMm`). Low impact because ironing flow is small, but not 3D.

**S5. Main slicer depth (scarf) and helix moves use 2D E.** `src/engine/slicer.ts:1129` (`len` 2D) with Z from `it.depth` at `:1133` and E at `:1145`. The same pattern is at `classic/slicer.ts:669-678`. Impact is small for short Z ramps.

**S6. Motionex ownE path keeps slicer E.** `src/plugins/motionex/engine.ts:131` (`ownE = run.path.clipped && run.path.modifiedBy !== 'motionex'`) and its use in `runToOps`: when a path was only clipped, the slicer's E (2D-based) is kept even if Z was modified by another plugin. Edge case, not triggered by motionex's own dZ.

**S7. Hard-coded constants (selected).**
- `src/engine/advanced/modules/rheology.ts:10` `PLA_MELT = { K: 4500, n: 0.35 }` is the default for every material. `wallShear` (`:13`) and `cells.ts` (`PLA.nu`, `:32`) also assume PLA.
- `src/engine/advanced/modules/weave.ts` zWeave body: `fd = s.filaments[0]?.diameter ?? 1.75` (fallback filament diameter).
- `weave.ts` zWeave body: `rv = 1.2` (pin radius, mm), `0.25` mm map margin, `N` clamped to 2..8.
- `weave.ts` zWeave body: subdivision `ceil(len/(lambda/8))` (line 87); pin dwell `G4 P300`, feed `5` mm/s, Z lift `0.4` mm.
- `weave.ts` knot braiding body: bump width `0.35` rad (line 187); spacing floor `0.2`; resample `0.3` mm.
- `src/engine/advanced/modules/thickVase.ts` (`inBand`/helix helper, line 28): sampling `0.5` mm.
- `src/engine/advanced/modules/lattice.ts:55`: strand dwell (`dwell`); lattice fan `M106 S255` (line ~44).
- `src/engine/advanced/modules/cells.ts` (line ~126): sampling `n = ceil(L/1.5)`.
- `src/engine/advanced/modules/motion.ts:13` `ringing(a,T,f,zeta=0.05,dt=2e-5)`.
- `src/plugins/motionex/engine.ts` `postOps` (line ~82): blob feed `2` mm/s.
- `src/plugins/motionex/modifier.ts:18` tangent step clamp `±0.5`.
- `src/plugins/motionex/presets.ts:293-298` spirograph `amp: 1.6`, `period: 4.5`, 96 samples.
- `src/engine/slicer.ts:1145` bead width scaled by `Math.min(1.5, Math.max(0.3, segFlow))`.

**S8. Naming vs. behaviour.** `scarf_splice` ("3D volumetric") and `metric_morph` ("4D") use 2D E. The code is planar per layer, so the names overstate the model.

**S9. Test helper inconsistency.** `tests/advanced/helpers.ts` `segments()`: comment says `[x0,y0,x1,y1,z1,w]`, code returns the E field. Referenced `packMoves()` does not exist in `src`.

## 4. Summary
- Correctly 3D: Motionex (`engine.ts:138-140`), lattice diagonals (`lattice.ts:54`), hanex waves (planar).
- 2D on non-planar moves: zWeave (`weave.ts:86,100`), slicer depth/helix/zs (`slicer.ts:1129`, `classic/slicer.ts:669-678`), tangent/scarf (`seams.ts:78,128`), ironing (`surfacePasses.ts:157`).
- Most risk is in zWeave at high amplitude and short wavelength.

---
# AUDIT MANIFEST B: plugins, toolpath modules, seams, post-processing

Read-only audit of `/home/user/NexSpiro`. No source files were modified. Only this file was written.

Paths are relative to the repo root. Line numbers come from `grep -n` on the current tree.

---

## 1. Pipeline map

| Stage | Entry point | Notes |
|---|---|---|
| Worker entry | `src/engine/worker.ts:6` `self.onmessage` calls `slice(meshes, cfg, progress, opts)` | Off the UI thread |
| Top-level slice | `src/engine/slicer.ts:181` `slice(meshes: MeshInput[], cfg: Config, progress?, opts: SliceOptions = {}): SliceOutput` | Dispatch order: `opts.program` (calib, :182), `opts.advanced` (:185), then Basic |
| Advanced dispatch | `src/engine/slicer.ts:185` to `src/engine/advanced/classic/slicer.ts:118` `slice(...)` | Advanced sessions: `src/engine/advanced/session.ts:121` `createAdvancedSession` |
| Plugin prepare | `src/engine/slicer.ts:333` `preparePlugins(opts.plugins, ...)` | Calls each engine plugin's `prepare` |
| Plugin post-toolpath | `src/engine/slicer.ts:1796` `runPlugins(layerOps, opts.plugins, ...)` | Per-plugin `postToolpath`, in `ENGINE_PLUGINS` order |
| Program body | `src/engine/slicer.ts:1798` `programBodyPlugins(...)` | Bulnex repeats the print here |
| G-code emit | `src/engine/gcode.ts:139` `emit({cfg, filaments, layers, objectLabels, headerLines, bodyTransform})` | Writes text, header, and the packed move arrays |
| Plugin config | `src/plugins/engine.ts:11` `ENGINE_PLUGINS = [hanex, motionex, patternex, bulnex]` | Plugin order is fixed here |

`SliceOptions` (`src/engine/types.ts:146`) holds `filaments`, `flushMatrix`, `layerActions`, `plugins: Record<pluginId, config>`, `program`, and `advanced: AdvancedConfig`. `SliceOutput` (`types.ts:173`) holds `gcode`, `moves`, `moveFeatures`, `layers`, `stats`, `warnings`, `pluginReports`, and `advanced`.

---

## 2. Advanced technology modules (toolpath modifiers)

### 2a. Registry

- Tech registry: `src/engine/advanced/techs.ts:55` `TECHS: TechDef[]` (35 entries), `:425` `TECH_BY_ID`.
- Module registry: `src/engine/advanced/modules/index.ts:29` `MODULES: TechModule[]` (34 entries, pipeline order listed at lines 30-49).
- `sdf_frep` (`techs.ts:70`, n=2) has no module. It is native, and `session.ts:231-236` reports it as applied.
- Each module is a `TechModule` (`src/engine/advanced/session.ts:70`) with optional hooks: `inspect`, `prepare`, `warp`, `reshape`, `regions`, `walls`, `wallsPost`, `infill`, `post`, `finalize`.
- Params are read as `s.pnum(id, key)` or `s.param(id, key)`. Their defaults and ranges are the `ParamSpec` list in `techs.ts`.
- Intent-based enablement: `techs.ts:189` `resolveTechs`. Each `TechDef.intents` lists the intents that switch it on by default.

### 2b. Module table

Hook names are read from each module file. Param tuples are `key = default [min..max] unit`, from `techs.ts`.

| n | id | Module file:line (export) | Registry (techs.ts:line) | Stage | Hooks | Params (default [min..max]) | Tests (tests/advanced unless noted) |
|---|---|---|---|---|---|---|---|
| 1 | fea_stress | modules/fea.ts:59 `feaStress` | 58 | infill | inspect, infill | elements=4000 [500..40000]; loadN=50 [1..5000] N; family=both (max/min/both); threshold=0.4 [0..1] | phase2, phase3, phase4, fea.test.ts (adjacent: advanced/fea.ts) |
| 2 | sdf_frep | none (native, see 2a) | 70 | fields | none | tpms=off (off/gyroid/schwarz_p/diamond); cell=8 [2..30] mm; grade=4 [0..20] mm | phase2, phase3 |
| 3 | eulerian_spiral | modules/eulerianSpiral.ts:5 | 81 | infill | infill | minW=0.3 [0.1..2] mm; maxW=1.2 [0.2..3] mm | phase2, phase3, advanced-golden |
| 4 | conformal_layers | modules/conformal.ts:6 | 91 | post | post | layers=3 [1..8] | phase2, phase3 |
| 5 | hot_on_hot | modules/rheology.ts:111 | 100 | rheology | finalize | margin=15 [0..80] °C; maxFanCut=0.6 [0..1] | phase2, phase3, phase5 |
| 6 | kinematic_extrusion | modules/motion.ts:76 | 110 | motion | finalize | paK=0.04 [0..0.5] s | phase2, phase3, phase5 |
| 7 | z_weave | modules/weave.ts:28 | 120 | post | post | amp=0.25 [0.05..0.45] × h; wavelength=4 [1..20] mm; pins=true; pinPitch=8 [3..30] mm | phase2, phase3 |
| 8 | subvoxel_aa | modules/surfacePasses.ts:13 | 133 | post | post | maxSlope=35 [5..60]°; minH=0.04 [0.02..0.2] mm | phase2, phase3, advanced-golden |
| 9 | turing_infill | modules/turing.ts:84 | 143 | infill | infill | F=0.037 [0.01..0.08]; k=0.06 [0.03..0.07]; aniso=0.6 [0..0.95]; scale=1 [0.4..3] | phase2, phase3, phase4 |
| 10 | corner_overshoot | modules/motion.ts:102 | 155 | post | post | gain=1 [0..3]; minAngle=60 [20..150]° | phase2, phase3, phase5 |
| 11 | spatial_lattice | modules/lattice.ts:10 | 165 | post | post | cell=6 [2..20] mm; flow=0.85 [0.5..1.2]; speed=8 [2..30] mm/s; dwell=0.6 [0..3] s. Replaces the solid part (intent-less) | phase2, phase3, phase4 |
| 12 | metamaterial | modules/cells.ts:99 | 177 | infill | infill | cell=6 [2..20] mm; angle=60 [30..85]°; dither=0.35 [0..1] | phase2, phase3, phase4 |
| 13 | dovetail | modules/dovetail.ts:40 | 188 | regions | regions | depth=1.2 [0.4..5] mm; pitch=3 [1..12] mm | phase2, phase3, phase4; tests/flenex/joints.test.ts |
| 14 | sgd_slicing | modules/sgdSlicing.ts:6 | 199 | layers (warp) | warp | w1=1 [0..10]; w2=4 [0..20]; w3=0.3 [0..10]; w4=1 [0..10]; iters=200 [10..2000]; ctrl=8 [3..24] | phase2, phase3 |
| 15 | eikonal_offsets | modules/eikonal.ts:18 | 213 | walls | walls | method=heat (heat/fmm); smooth=2 [0.5..20]; cell=0.1 [0.03..0.5] mm | phase2, phase3 |
| 16 | inverse_warp | modules/inverseWarp.ts:110 | 224 | post | post | gain=1 [0..2]; kerfs=true; elements=3000 [500..40000] | phase2, phase3, phase4 |
| 17 | gloss_modulation | modules/rheology.ts:57 | 236 | rheology | finalize | contrast=0.7 [0..1] | phase2, phase3, phase5 |
| 18 | foam_control | modules/foam.ts:24 | 245 | rheology | finalize | coreTemp=250 [200..290] °C; hubTemp=200 [180..260] °C; xmax=2.8 [1..4] | phase1, phase2, phase3, phase4 |
| 19 | knot_braiding | modules/weave.ts:150 | 256 | post (wallsPost) | wallsPost | pitch=6 [2..20] mm; lift=0.5 [0.1..0.8] × h | phase1, phase2, phase3 |
| 20 | co_molding | modules/coMolding.ts:56 | 266 | regions | reshape, regions | port=4 [1.5..12] mm; columnPitch=12 [5..40] mm; columnR=1.6 [0.8..5] mm | phase2, phase3, phase4 |
| 21 | thick_vase | modules/thickVase.ts:46 | 278 | post | infill, post | (see techs.ts:278-283) | phase1, phase2, phase3, advanced-golden |
| 22 | tangent_entry | modules/seams.ts:34 | 285 | post | post | radius=0.8 [0.2..3] mm; merge=3 [1..15]° | phase2, phase3, advanced-golden |
| 23 | scarf_splice | modules/seams.ts:105 | 295 | post | post | length=12 [2..40] mm; slow=0.6 [0.2..1]; fanOffMs=150 [0..1000] ms | phase2, phase3, advanced-golden |
| 24 | harmonic_dome | modules/harmonicDome.ts:23 | 306 | layers | inspect, warp | band=0 [0..200] mm (0 = dome height + 2 mm); minRatio=0.5 [0.2..1] × h; maxRatio=1.5 [1..2.5] × h | phase1, phase2, phase3 |
| 25 | conformal_ironing | modules/surfacePasses.ts:107 | 317 | post | post | flow=0.015 [0..0.1]; spacing=0.15 [0.05..0.5] mm; speed=30 [5..120] mm/s | phase2, phase3 |
| 26 | perimeter_feathering | modules/surfacePasses.ts:41 | 328 | post | post | depth=0.5 [0.1..0.9] × h | phase2, phase3 |
| 27 | iso_gloss | modules/rheology.ts:21 | 337 | rheology | finalize | fanGamma=0.6 [0..2] | phase2, phase3, phase5 |
| 28 | quasicrystal | modules/quasicrystal.ts:118 | 347 | infill | infill | spacing=0 [0..20] mm (0 = from infill density); maxTilt=45 [20..60]° | phase1, phase2, phase3, phase4 |
| 29 | metric_morph | modules/metricMorph.ts:30 | 357 | route | post | shrink=0.7 [0.4..0.95]; layers=4 [2..10] | phase2, phase3, phase4 |
| 30 | monge_ampere | modules/mongeAmpere.ts:118 | 367 | route | reshape, wallsPost | ior=1.57 [1.3..1.8]; iters=120 [20..1000] | phase2, phase3, phase4 |
| 31 | symplectic_shaper | modules/motion.ts:40 | 377 | motion | finalize | tolerance=0.02 [0.002..0.2] mm | phase1, phase2, phase3, phase5 |
| 32 | morse_router | modules/morse.ts:101 | 386 | route | inspect, prepare | persistence=1.5 [0..20] mm | phase2, phase3, phase5 |
| 33 | spinor_fields | modules/fea.ts:111 | 395 | fields | prepare | smooth=12 [0..100] passes | phase2, phase3, phase4 |
| 34 | band_gap | modules/bandGap.ts:49 | 404 | infill | infill | freq=800 [50..20000] Hz; valley=false | phase2, phase3, phase4; adjacent tests/advanced/bloch.test.ts |
| 35 | homogenization | modules/cells.ts:51 | 414 | fields | prepare, infill | targetE=0.2 [0.02..0.9] × solid; targetNu=0.3 [-0.8..0.45] | phase2, phase3, phase4; adjacent tests/advanced/homogenize.test.ts |

Notes on the table:
- Rows 1-35 cover all 35 `TechId`s. `sdf_frep` is native (2a).
- "phase1..phase5" are `tests/advanced/phaseN.test.ts`. Those files use the shared `adv()` harness in `tests/advanced/helpers.ts`, which lists every tech id. Membership in a phase file means the tech id is exercised there, not that every assertion was checked.
- Stage column is from `techs.ts` (`stage`). Some hooks run in another stage: for example, `hot_on_hot` has `stage: 'rheology'` and a `finalize` hook.
- For thick_vase, the params are in `techs.ts:278-283`. Re-read them before use.

### 2c. Headless tech run (verified)

Advanced mode is requested through `opts.advanced`. `tests/advanced/helpers.ts` builds it like this:

```ts
slice(meshes, cfgFor(printerId), () => {}, {
  advanced: { intent: 'structural', printerId, techs: { z_weave: { enabled: true, params: { amp: 0.3 } } }, resolution: 'draft' },
});
```

The `techs` object has one entry per enabled tech, with optional `params`. Read the results from `out.advanced.techs` (status is `applied`, `adapted`, `unavailable`, `disabled`, or `idle`).

---

## 3. Seam optimizers and seam handling

| Item | File:line | What it does | Parameters (default [range]) | Driven by | Test coverage |
|---|---|---|---|---|---|
| `pickSeam` | `src/engine/order.ts:14` (`SeamMode` at :4) | Picks the loop start point. Modes: nearest, aligned, back, random. Honours painted enforce/block hints | `seam_position = aligned` (nearest/aligned/back/random); `seam_placement_away_from_overhangs = false` | `src/engine/slicer.ts:1450` via `settings.ts:82` | Keyword hit only: `tests/patternex/tools.test.ts`, `tests/phase2.test.ts`. No direct unit test of `pickSeam` |
| `seamGapLoop` | `src/engine/seam.ts:102` | Opens a closed loop short of its start by a gap | `seam_gap = 15` % of nozzle [0..100] (`settings.ts:85`) | `slicer.ts:1482-1483` | `tests/phase2.test.ts` (grep hit) |
| `scarfLoop` | `src/engine/seam.ts:69` (`ScarfParams` at :53) | Scarf joint: height and flow ramp at loop start and end | `seam_slope_type = none` (none/external/all); `seam_slope_min_length = 10` mm [0..100]; `seam_slope_start_height = 10%`; `seam_slope_gap = 0`; `seam_slope_steps = 10` [1..100]; `seam_slope_conditional = true`; `scarf_angle_threshold = 155` [0..180]°; `seam_slope_entire_loop = false`; `seam_slope_inner_walls = true` (settings.ts:92-100) | `slicer.ts:1434-1477`; filament overrides at `slicer.ts:1434-1437` | `tests/phase2.test.ts`, `tests/phase3.test.ts` |
| `isSmoothLoop` | `src/engine/seam.ts:16` | Gate for conditional scarf: all corners wider than threshold | threshold from `scarf_angle_threshold` | `slicer.ts:1473` | `tests/phase2.test.ts` (grep hit) |
| `loopLength` | `src/engine/seam.ts:5` | Helper | none | `slicer.ts:1476` | none direct |
| `tangentEntry` (Advanced) | `src/engine/advanced/modules/seams.ts:34` | Tangential spiral entry, sub-surface | `radius = 0.8` [0.2..3] mm; `merge = 3`° [1..15] | Advanced registry `techs.ts:285`, index `modules/index.ts:44` | `tests/advanced/advanced-golden.test.ts`, `phase2`, `phase3` |
| `scarfSplice` (Advanced) | `src/engine/advanced/modules/seams.ts:105` | Volumetric scarf wedge, thermal re-melt | `length = 12` [2..40] mm; `slow = 0.6` [0.2..1]; `fanOffMs = 150` [0..1000] | `techs.ts:295`, `modules/index.ts:44` | `tests/advanced/advanced-golden.test.ts`, `phase2`, `phase3` |
| `fitArc` | `src/engine/arc.ts:20` (`ArcFit` at :5) | Replaces runs of short segments with G2/G3 arcs. Tolerance 0.012 mm | `enable_arc_fitting = false` (`settings.ts:103`) | `src/engine/gcode.ts:298`; `src/engine/advanced/classic/gcode.ts:178` | `tests/phase3.test.ts`, `tests/advanced/basic-golden.test.ts` (grep hits); the arc tests in `tests/motionex/integration.test.ts` disable it |

Notes:
- `seam.ts` is used by the Basic path (`slicer.ts:22`). `arc.ts` is used by the Basic path (`gcode.ts:6`) and by the Advanced classic G-code writer (`advanced/classic/gcode.ts:8`).
- `equalizePressure` (`src/engine/gcode.ts:43`) rescales extrusion rate limits. It is called at `gcode.ts:196` with `max_volumetric_extrusion_rate_slope_positive` and `..._negative`. Only `tests/settings-wiring.test.ts` mentions those keys.

---

## 4. G-code post-processing

| Function | File:line | Role | Parameters / inputs |
|---|---|---|---|
| `emit` | `src/engine/gcode.ts:139` | Final G-code writer. Takes `EmitInput` (`:89`) and returns `EmitOutput` (`:100`). Packs moves with `MOVE_STRIDE = 8` (`:110`) and `AUX_STRIDE = 2` (`:111`) | `cfg`, `filaments`, `layers`, `objectLabels`, `headerLines`, `bodyTransform` |
| `equalizePressure` | `src/engine/gcode.ts:43` | Limits volumetric rate slope | `max_volumetric_extrusion_rate_slope_positive`, `..._negative` (`gcode.ts:196`) |
| `moveTime` | `src/engine/gcode.ts:65` | Trapezoid move time estimate | `len`, `v`, `a` |
| `expandMacro` | `src/engine/gcode.ts:78` | Expands `{placeholder}` start/end macro templates | `cfg`, `extra` |
| `layerFanSpeed` | `src/engine/gcode.ts:114` | Layer fan PWM from layer time and bridge/first-layer rules | `c`, `b`, `layer`, `layerTime` |
| `auxFanSpeed` | `src/engine/gcode.ts:129` | Aux fan | `c`, `layer` |
| `bodyTransform` | `EmitInput` hook, filled by `programBodyPlugins` at `slicer.ts:1798` | Rewrites body lines (Bulnex repeats the print here) | `(body: string[]) => string[]` |
| `paLine` | `src/engine/slicer.ts:179` (also `advanced/classic/slicer.ts:116`) | Pressure-advance line. `klipper`: `SET_PRESSURE_ADVANCE ADVANCE=k`; otherwise `M900 K<k>` | flavour, k |

Tests: `tests/gcode-sanity.test.ts`, `tests/engine.test.ts` (asserts `;LAYER_CHANGE` and `G1 X.. Y.. E..`), `tests/advanced/basic-golden.test.ts`.

---

## 5. Plugins

### 5a. UI plugin registry: `src/plugins/registry.ts`

`PLUGINS: UiPlugin[]` at `registry.ts:41`. Each entry has `id`, `name`, `badge`, `Panel`, `sliceConfig()`, optional `preview()`, `Studio`, `projectData`, and `loadProjectData`.

| id | name | registry.ts line | sliceConfig returns | Toolpath effect | Engine plugin | Tests |
|---|---|---|---|---|---|---|
| motionex | Motionex | 42 | `motionexConfig(printerId)` (MotionexPanel) plus Patternex motion apps | Yes, via engine | `motionexEngine` | `tests/motionex/*.test.ts` |
| patternex | Patternex | 62 | `patternexConfig()` | Yes, via engine | `patternexEngine` | `tests/patternex/*.test.ts` |
| hanex | Hanex | 69 | `hanexConfig(printerId)` (HanexPanel.tsx:50) | Yes, via engine | `hanexEngine` | `tests/hanex/*.test.ts` |
| bulnex | Bulnex | 75 | `bulnexConfig()` | Yes, program body | `bulnexEngine` | `tests/bulnex/*.test.ts` |
| plantex | Plantex | 81 | `undefined` | None (meshes placed on plate) | none | `tests/plantex/mesh.test.ts`, `tests/renex/renex.test.ts` |
| lumonex | Lumonex | 90 | `undefined` | None (meshes placed on plate) | none | `tests/lumonex/build.test.ts`, `tests/renex/renex.test.ts` |
| clickex | Clickex | 99 | `undefined` | None (meshes placed on plate) | none | `tests/clickex/build.test.ts`, `model.test.ts` |
| flenex | Flenex | 108 | `undefined` | None (meshes placed on plate) | none | `tests/flenex/*.test.ts` |

`installedPlugins()` (`registry.ts:~139`) filters by `store.plugins`. `pluginConfigs()` builds the `opts.plugins` record.

### 5b. Engine plugins: `src/plugins/engine.ts:11` `ENGINE_PLUGINS`

Order: hanex, motionex, patternex, bulnex (fixed by this array). Each implements `EnginePlugin` (`src/plugins/api.ts`): `prepare?`, `postToolpath`, `programBody?`, `gcodeHeader?`.

| id | Engine object (file:line) | Version | Config type | Hooks | Config keys and defaults | Test |
|---|---|---|---|---|---|---|
| hanex | `hanex/engine.ts:192` `hanexEngine` | 0.1.0 | `HanexConfig` (`engine.ts:16`) | prepare, postToolpath | `profile` (preset `hanex-pla` at `core/profile.ts:124`; also `hanex-petg`, `hanex-abs`). Profile base (`profile.ts:95`): nozzle 0.4, tipFlat 1.0, lineWidth 0.45, sheetHeight 0.2, overlap 0.5, flowRatio 1.0, rNominal 0.9, flowFloor 0.6, filament 1.75 mm. `tipDiameter` from toolhead. `maxFaceAngleDeg` undefined. `minArea = 4` mm² (`HanexPanel.tsx:30`) | `tests/hanex/integration.test.ts`, `plan.test.ts`, `calibration.test.ts`, `fmm.test.ts` |
| motionex | `motionex/engine.ts:146` `motionexEngine` | 0.3.0 | `MotionexConfig` (`engine.ts:16`) | postToolpath | `applications[]` (`model.ts:92`: `brush_id`, `target{type,walls,faces}`, `mask{z_start,z_end,fade_in_mm,fade_out_mm,angle_min?,angle_max?,blend_mm?}`, `order`, `blend` add/override, `enabled`, size). `brushes[]` (presets `preset-<key>` at `presets.ts:313`, e.g. `preset-sine`). `options` = `DEFAULT_OPTIONS` `{resampleStep: 0.2, loopSpeedShare: 0.5, bondInnerWalls: true}` (`modifier.ts:19`). `collisionMode` `clamp` / `skip` / `fail` (`core/toolhead.ts:25`). `toolhead` from `defaultToolhead(printerId)` | `tests/motionex/integration.test.ts`, `modifier.test.ts`, `phases.test.ts`, `clearance.test.ts`, `preview.test.ts` |
| patternex | `patternex/engine.ts:527` `patternexEngine` | 1.0.0 | `PatternexConfig` (`engine.ts:20`) | prepare, postToolpath | `patterns[]` (built-ins: `builtinPattern(kind)` with kind stripes/checker/dots/hex, `builtin.ts:4-12`; defaults W=40, H=40, cell=5, colours `#2f2f33` / `#7d7d85`). `placements[]` (`newPlacement`, `model.ts:129`). `actions[]` (`RegionAction`, `model.ts:67`: `material.mode` slot/manual/keep, `purge.mode` full/reduced/none (`model.ts:65`), `change_point_shift_mm`). `singleColour` (skip or manual policy). `transitionVolume[]` (default empty = estimate). `purgeTarget` tower/infill/object | `tests/patternex/engine.test.ts`, `features.test.ts`, `tools.test.ts`, `svg.test.ts`, `library.test.ts`, `state.test.ts`, `test-prints.test.ts` |
| bulnex | `bulnex/engine.ts:80` `bulnexEngine` | 1.0.0 | `BulnexConfig` (`bulnex/model.ts:9`) | prepare, postToolpath, programBody, gcodeHeader | `DEFAULT_BULNEX` (`model.ts:52`): cycles=10; pushHeightPct=0.3 (of part height); passes=2; pushSpeed=20 mm/s; currentFraction=0.5 [0.2..1]; releaseBedTemp=28 °C; coolWaitMin=15; nozzleStandbyTemp=140 °C (0 = off); fanDuringCool=true; minHeight=8 mm; maxContactArea=0 (material default); `calibration?` boolean (release ladder, `model.ts:40-50`) | `tests/bulnex/bulnex.test.ts`, `tests/bulnex/vision.test.ts` |

Notes:
- Hanex runs first and replaces overhang regions. Motionex runs second, so its path changes are preserved. Patternex runs third. Bulnex runs last and repeats the body (`engine.ts:122` `programBody`).
- Patternex `prepare` (`engine.ts:531`) adds region masks before perimeters. Motionex consumes Patternex regions through `patternexMotionApps()` (`registry.ts:52-53`).

### 5c. Ex tool folders (geometry builders, no slicer hook)

These folders put meshes on the plate. They have no `EnginePlugin`. Their outputs reach the slicer as ordinary objects.

| Folder | Main builders (file:line) | Tests |
|---|---|---|
| `src/plugins/clickex` | `build.ts:142` `buildClicker(spec, plan)`; `:180` `printParts`; `:72` `baseShells`; `:93` `capShells`; `models.ts`, `plan.ts`, `export3mf.ts` | `tests/clickex/build.test.ts`, `model.test.ts` |
| `src/plugins/flenex` | `build.ts:14` `BuildRequest`, `:48` `newCache`; `design.ts` (SPINES, RELIEFS, ADDONS); `joints.ts`, `joints-extra.ts`, `csg.ts`, `creature.ts`, `export3mf.ts`; `worker.ts` | `tests/flenex/build.test.ts`, `joints.test.ts`, `output.test.ts`, `presets.test.ts`, `slice.test.ts`, `smart.test.ts` |
| `src/plugins/lumonex` | `build.ts:150` `buildLamp(design, bed)`; `:69` `rotateXYZ`; `:90` `piecesFor`; `:519` `knuckle`; `catalog.ts`, `joinery.ts`, `presets.ts` | `tests/lumonex/build.test.ts` |
| `src/plugins/plantex` | `mesh.ts:125` `buildShell`; `:373` `buildBody(spec, masks, draft)`; `:426` `buildSaucer`; `:447` `buildInsert`; `model.ts` (PlantexSpec types) | `tests/plantex/mesh.test.ts` |
| `src/renex` | `engine.ts:70` `buildScene`; `:181` `RenexRenderer`; `:33` `flatLayout`; `:20` `partMatrix`; `renderer`-side only | `tests/renex/renex.test.ts` |

Other plugin-adjacent folders found: `src/plugins/api.ts` (plugin contract), `src/plugins/engine.ts` (runner), `src/plugins/registry.ts` (UI registry). `src/io/gcode3mf.ts` is a 3MF export helper, not a toolpath tool.

---

## 6. Headless end-to-end recipes

### 6a. Common setup (used by every test)

From `tests/engine.test.ts:9-12`, `tests/fixtures.ts`, `tests/motionex/integration.test.ts:7-8`:

```ts
import { slice } from '../src/engine/slicer';           // src/engine/slicer.ts:181
import { weld } from '../src/engine/mesh';
import { resolveConfig } from '../src/profiles/resolve'; // profiles/resolve.ts:72
import { box, tee, cylinder } from './fixtures';

const cfg = resolveConfig({ printerId: 'bbl-a1', plate: 'textured_pei_plate', filamentId: 'generic-pla', presetId: '0.20', overrides: {} });
const mesh = (soup: Float32Array) => { const m = weld(soup); return { id: 'part', name: 'part', vertices: m.vertices, indices: m.indices }; };
const out = slice([mesh(box(100, 100, 0, 20, 20, 20))], cfg);
// out.gcode, out.stats.filamentGrams, out.warnings, out.pluginReports, out.advanced
```

Printer ids include `bbl-a1`, `bbl-p1s`, `bbl-x1c` (`src/profiles/printers.ts:132+`). Filament id `generic-pla`. Preset `0.20`. Plate `textured_pei_plate`.

### 6b. Per plugin

```ts
// Motionex (tests/motionex/integration.test.ts:12-18)
import { PRESETS } from '../src/plugins/motionex/presets';
import { defaultToolhead } from '../src/plugins/motionex/core/toolhead';
import { DEFAULT_OPTIONS } from '../src/plugins/motionex/modifier';
const sine = PRESETS.find((b) => b.id === 'preset-sine')!;
const mx = { applications: [{ brush_id: sine.id, target: { type: 'body', walls: 'outer' }, mask: { z_start: 2, z_end: 1e4, fade_in_mm: 0, fade_out_mm: 0 }, order: 0, blend: 'add', enabled: true }],
  brushes: [sine], options: DEFAULT_OPTIONS, collisionMode: 'clamp', toolhead: defaultToolhead('bbl-x1c'), printerId: 'bbl-x1c' };
slice([mesh(box(...))], cfg, () => {}, { plugins: { motionex: mx } });

// Hanex (tests/hanex/integration.test.ts:12-15, 30+)
import { preset } from '../src/plugins/hanex/core/profile';
slice([mesh(tee(120, 120))], cfg, () => {}, { plugins: { hanex: { profile: preset('hanex-pla'), tipDiameter: 1.0, minArea: 4 } } });
// out.pluginReports.hanex.layers

// Bulnex (tests/bulnex/bulnex.test.ts:39)
import { DEFAULT_BULNEX } from '../src/plugins/bulnex/model';
slice([mesh(box(120, 20, 0, 16, 16, 12))], cfg, () => {}, { plugins: { bulnex: { ...DEFAULT_BULNEX, cycles: 3, passes: 2, coolWaitMin: 2 } } });

// Patternex (tests/patternex/engine.test.ts:9-28, 301-304)
// Placements and actions are built with newPlacement() (model.ts:129) and an action { region_ref, material:{mode:'slot',slot_index:1}, purge:{mode:'full',change_point_shift_mm:0}, motion:null }.
// filaments: 3 slots, see slots() in that test
slice([mesh(box(60, 60, 0, 20, 20, 4))], cfg, () => {}, { filaments, plugins: { patternex: { patterns: [builtinPattern('dots')], placements, actions, singleColour: 'skip', transitionVolume: [] } } });
```

### 6c. Per Advanced tech

```ts
// tests/advanced/helpers.ts: adv(meshes, printerId, [techIds], intent, { params })
slice([mesh], cfgFor('bbl-a1'), () => {}, {
  advanced: { intent: 'structural', printerId: 'bbl-a1', techs: { z_weave: { enabled: true } }, resolution: 'draft' },
});
```

### 6d. Smoke results (run this session, not from the repo)

A scratch bundle was built with esbuild (`node_modules/.bin/esbuild --bundle --platform=node --format=esm`) and run with `node`. The script is at `/tmp/claude-0/-home-user-NexSpiro/b6f6eb0e-c388-5573-8b01-37f2fd72bf5e/scratchpad/smoke/smoke.ts`. Results:

| Run | Result |
|---|---|
| Basic, 20 mm cube, bbl-a1 | 8171 G-code lines, 3.22 g, no warnings |
| Bulnex, 16x16x12 box, cycles=2 | `pluginReports` has `bulnex`; 120 `;LAYER_CHANGE` (body repeated twice) |
| Hanex, T part (`fixtures.tee`) | `pluginReports.hanex.layers.length === 1` |
| Advanced, `z_weave` enabled, 20 mm cube | Runs; status list in `out.advanced.techs` |

Headless runs work in plain Node. The Clipper and mesh code do not need a browser or a worker.

---

## 7. Coverage gaps and notes

- Advanced: all 34 modules plus native `sdf_frep` are exercised by `tests/advanced/phase*.test.ts` through `adv()`. Tech `sdf_frep` has no module, so it has no dedicated unit file. `spinor_fields` and `homogenization` have only the phase files plus adjacent `tests/advanced/fea.test.ts` and `homogenize.test.ts`.
- Seams: no test file is dedicated to `src/engine/seam.ts` or `src/engine/order.ts` (`pickSeam`). Coverage is indirect, through slicer runs with `seam_position`, scarf settings, and the Advanced seam modules.
- Arc fitting: `src/engine/arc.ts` has no dedicated test. It is covered only when `enable_arc_fitting` is turned on in a slice run.
- Motionex and Hanex are the most tested plugins. Bulnex and Patternex have dedicated tests through `slice()`. Clickex, Flenex, Lumonex, Plantex and Renex are tested at the geometry-builder level only.
- Hanex profile presets are `hanex-pla`, `hanex-petg`, `hanex-abs` (`core/profile.ts:124-126`). Other profile fields in `HanexProfile` are documented in the interface at `core/profile.ts:14`.
- Some parameter ranges are not in code (for example Bulnex `pushSpeed`, `passes`). They are unbounded in `model.ts` and checked only by UI inputs. These are listed with defaults only.
- Two inconsistencies to note: `src/plugins/registry.ts` has 8 UI plugins, while the engine has 4 plugins. The four engine plugins are the only ones that modify toolpaths. The other four ex tools only produce geometry.
