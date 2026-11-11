# Patternex — Phase 1: repo inspection and hook-point proposal

Status: **approved** — hooks implemented as proposed (see VALIDATION.md for the as-built map).

## 1. Stack
- TypeScript 5.6, React 18 + zustand UI, three.js viewport, Vite web build, Electron desktop shell.
- Clipper (`clipper-lib`, integer coords × `SCALE`) for all 2D polygon ops; vitest tests.
- Slicer runs in a Web Worker (`src/engine/worker.ts`); store → worker bridge in `src/state/slicing.ts`.

## 2. Core: original, not a fork
- `src/engine/*` is an original TypeScript pipeline (~3.5k lines). It borrows common slicer
  *conventions* (config key names like `change_filament_gcode`, `[next_extruder]` macro placeholders,
  `M620/T/M621` AMS sequence) but contains no Orca/Prusa/Cura C++ code.

## 3. Existing plugin system
- `src/plugins/api.ts` — `EnginePlugin.postToolpath(layers: LayerOps[], config, ctx)`: one hook,
  **after toolpaths, before G-code emission**. Plugins edit the move list; Nexspiro writes G-code.
- `src/plugins/engine.ts` — fixed run order list (`[motionexEngine]`).
- `src/plugins/registry.ts` — UI side: dock tab, `sliceConfig()` plain data sent to the worker.
- `src/plugins/motionex/core/regions.ts` — already defines the §8 contract `PatternexRegion
  { region_id, layer_range, polygon_mask_per_layer, attributes }` and a `RegionRegistry`, with
  placeholder band/box regions "until Patternex exists".

## 4. How the data is represented
| Concept | Location | Representation |
| --- | --- | --- |
| Mesh | `engine/types.ts` `MeshInput` | world-space indexed `Float32Array`/`Uint32Array`, per-object `filament`, per-triangle `paint.color` |
| Layers | `slicer.ts` `zs[]`, `planes[]`, `objSlices[o][i]: Paths` | Clipper paths per object per layer |
| Regions (colour) | `slicer.ts:195-225` `filRegions(o,i)` → `{fil, paths}[]`; `paint.ts colorRegionsAtZ()` | painted tris → wall strip of `mmu_paint_depth` + flat-face footprints |
| Extruders/filaments | `SliceOptions.filaments: FilamentSlot[]`, `flushMatrix[from][to]` (mm³) | 0-based slot index; matrix from `profiles/flush.ts` |
| Tool changes | `slicer.ts:629 changeTo()` | `change_filament_gcode` macro expanded per printer; `has_ams` decides AMS vs `M600`; `Op {k:'tool'}` |
| Pause | `machine_pause_gcode` per printer (`M601`, `PAUSE`, `M400 U1`) | already profile-driven |
| Layer tool order | `slicer.ts:417, 668` | "current tool first, then ascending" — already satisfies §3.4 ordering |
| Prime tower | `slicer.ts:427+` | sized from `prime_volume` / flush |

## 5. Gap analysis
- The only hook (`postToolpath`) runs **after** perimeters/infill are split by filament. Patternex
  must inject regions **before** stage 4 (perimeters) — so v1 cannot be built on the current API alone.
- Purge is per-pair matrix only; no per-transition mode (full/reduced/none) and no change-point shift.
- No transition-volume (bleed) field in filament/machine profiles.
- Single-colour mid-layer changes are emitted today as an `M600` per change — infeasible in practice,
  currently only warned about generically (`slicer.ts:869`).
- No SVG parser in deps; must be written (no new runtime dependency needed — `DOMParser` is unavailable in
  the worker, so parse on the UI thread and send polygons as plain data).

## 6. Proposed hook points (needs approval — this extends the plugin API)
1. **`EnginePlugin.regions?(ctx: RegionContext): RegionContribution[]`** — new, runs before stage 4.
   - Input: meshes, `zs`, `planes`, `objSlices`, cfg. Output per object/layer: `{ fil, paths, regionId, purge }`.
   - Wired into `filRegions()` (`slicer.ts:204`) as an extra source alongside painted colour, applied
     after paint (plugin wins over paint; documented order).
   - Also registers each region into a shared `RegionRegistry` exposed on `PluginContext.regions`,
     so Motionex reads Patternex regions instead of its placeholders (§8).
2. **`EnginePlugin.transition?(t: {layer, from, to, regionId}): TransitionPlan`** — new, consulted in
   `changeTo()` (`slicer.ts:629`): returns purge volume override (full/reduced/none) and change-point
   shift in mm.
3. **Order guarantee for §8:** no-purge change-point shift must apply after Motionex. Proposal: emit
   transitions as markers (`Op {k:'marker'}`) during toolpathing, and resolve the shift in a
   final `postToolpath` pass registered *after* Motionex in `ENGINE_PLUGINS`.
4. Profile fields (no hard-coding): `patternex_transition_volume` per filament (+ `uncalibrated` flag),
   reuse `change_filament_gcode`, `machine_pause_gcode`, `flushMatrix`, prime-tower keys.

## 7. Feasibility flags
- **Single-colour + vertical-wall regions:** mid-layer manual swaps are flagged unsupported (per §3.5);
  fallback = layer bands.
- **No-purge on the AMS:** the AMS `T` sequence always cuts and flushes into the chute inside the
  macro; "no purge" can only zero the *tower/flush* volume, not the in-macro cut purge. True deliberate bleed
  needs a Klipper toolchanger/ERCF-style macro or `M600` printers.
- **Change-point shift earlier** than the region boundary requires look-ahead across the move list —
  feasible in the post-pass, but only within the same layer.
- **Creality CFS / Anycubic ACE** — not driven by Nexspiro yet (README); out of scope for v1.

## 8. Questions blocking Phase 2 (owner: Ankit, spec §12)
1. Approve extending `EnginePlugin` with `regions()` and `transition()` (§6), or prefer Patternex to
   write into `MeshInput.paint.color` UI-side (zero engine change, but loses per-region purge and depth control)?
2. v1 multi-colour targets: AMS only (already wired), or also Prusa MMU / Klipper toolchanger?
3. Default region depth: outer-wall thickness (spec default) or reuse existing `mmu_paint_depth` (1.5 mm)?
