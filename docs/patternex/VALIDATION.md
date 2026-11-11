# Patternex — validation report (spec §9, §10 step 10)

Status: core phases 2–10 built and tested. Extended scope (§11) is not started.

## 1. Phase status
| # | Phase | State | Where |
| --- | --- | --- | --- |
| 1 | Repo inspection + hook proposal | Approved | `PHASE1_REPORT.md` |
| 2 | SVG import, built-in patterns, data model | Done | `src/plugins/patternex/{svg,builtin,model}.ts` |
| 3 | Planar placement UI | Done (see limits) | `ui/PatternexPanel.tsx`, `ui/overlay.ts`, Viewport hooks |
| 4 | Region resolution (Stages A–B) + colour preview | Done | `projection.ts`, `resolve.ts`, `slicer.ts filRegions()` |
| 5 | AMS tool changes + purge modes | Done | `engine.ts transition()`, `slicer.ts changeTo()` |
| 6 | Single-colour pause mode, constraint check, swap summary | Done | `engine.ts regionsAt()`, `buildReport()` |
| 7 | No-purge, change-point shift, bleed preview | Done | `engine.ts applyShift()`, `zoneAfter()` |
| 8 | Cylindrical projection | Done | `projection.ts` |
| 9 | Motionex region hand-off | Done | `api.ts sharedRegions`, `motionex/engine.ts`, `registry.ts` |
| 10 | Validation report + test prints | This file | `tests/patternex/test-prints.test.ts` |

## 2. As-built hook map
| Spec stage | Code |
| --- | --- |
| A — project placements | `projection.ts` `frameOf / toPattern / fromPattern / faces` |
| B — per-layer masks, split by material | `EnginePlugin.prepare()` → `PluginSession.regionsAt()`, merged in `slicer.ts filRegions()` before perimeters; plugin regions override paint and base |
| C — ordering | unchanged Nexspiro rule: each layer starts with the loaded tool, then ascending (`slicer.ts` filament plan) — test "starts each layer with the last tool" |
| D — tool change / pause / purge | `PluginSession.transition()` called in `changeTo()`: purge volume override, prime-tower skip, `M117` swap label, a `; PATTERNEX_CHANGE` marker |
| §8 order: mask → material → motion, shift after motion | `ENGINE_PLUGINS = [motionex, patternex]`; Patternex `postToolpath` applies the change-point shift on the final move list |
| Shared region contract | `PatternexRegion { region_id, layer_range, polygon_mask_per_layer, attributes }` published by `sharedRegions()`; Motionex registers them and accepts their ids as application targets |

Machine values come from profiles: tool-change macro (`change_filament_gcode`), pause (`machine_pause_gcode` / macro), flush matrix, `filament_change_time`, prime-tower keys. Patternex adds only the per-slot transition volume (panel; default 45 mm³, marked *uncalibrated*).

## 3. Automated tests (`npm test`)
- `svg.test.ts` (15): units/viewBox, nested transforms, fill inheritance, even-odd, open paths (skip / auto-close), self-intersection, arc tolerance, relative/smooth/packed-flag commands, defs/hidden, colour groups, determinism, 2,000 shapes.
- `engine.test.ts` (17): planar + cylindrical round trips; masks on a cube wall, top, through, and stripes wrapped on a cylinder; golden AMS G-code (deterministic, tool-change count); tool ordering; full / reduced / no purge; tower skip; bleed zones and calibration; change-point shift earlier/later (filament conserved); two-colour SVG → two slots; unassigned → base; single colour skip / band / whole-layer; Motionex limited to a Patternex region; 50 placements.
- `state.test.ts` (5): object-local → plate transform (incl. non-uniform scale normals), config filtering, default actions, persistence.
- `test-prints.test.ts` (4): the §9 test prints below.
- Browser smoke test (manual run, Playwright + Chromium): import STL → install Patternex → place *checker* on the top → slice → report shows 2 tool changes, colour preview renders the pattern on slot 2. No console errors.

## 4. Test prints
Generate the G-code and a JSON report for each:
```bash
PATTERNEX_TEST_PRINTS=out/test-prints npx vitest run tests/patternex/test-prints.test.ts
```
| File | Printer | Model | Report (as generated) | What to check on the print |
| --- | --- | --- | --- | --- |
| `1-logo-top-ams-p1s` | P1S + AMS | 60×50×3 tile, logo on top, 0.6 mm deep | 3 tool changes, 1.04 g purge, +4.8 min | logo edges sharp, no white inside the "N"/ring |
| `2-logo-top-manual-swap-a1` | A1, AMS off (`has_ams=false`, `M400 U1` pause) | tile with a 1 mm raised block, block in black | 1 swap at layer 16, Z 3.2, "Black PLA" | printer pauses once; display shows *Load Black PLA* |
| `3-stripes-cylinder-a1` | A1 + AMS | Ø30×30 cylinder, 16 stripes, 20 mm tall | 100 changes (one per layer), 34.7 g purge, +100 min | stripes line up all the way round, no seam gap |
| `4-no-purge-bleed-panel-p1s` | P1S + AMS | 60×40×2 panel, right half black, **no purge** | 10 changes, 0 g purge, bleed zones reported, *uncalibrated* warning | measure the mixed-colour length after each change; enter `bleed length × line width × layer height` as the slot's transition volume |

Purge grams use the flush volumes actually applied (default `flush_volume` 280 mm³ when no matrix is set) at the filament density.

## 5. Corrections to the Phase 1 report
- **No-purge on the AMS is feasible.** With `flush_length = 0` the AMS still cuts and loads, but the old filament left in the melt zone is pushed into the part — that is the bleed. Patternex sets the flush to 0 and skips the tower band for those changes.

## 6. Known limits (v1)
- **Placement gizmo**: move is drag-on-surface (snaps to the face under the cursor); rotation, scale (uniform/non-uniform) and flip are numeric fields in the panel, not 3D handles.
- **Depth** is measured from each layer's mid-plane. A flat-face region includes material whose mid-plane lies within `depth` of the exposed surface.
- **Planar projection** paints every surface facing the projection within the pattern's footprint/height range; flat-face (top/bottom) regions are limited to `anchor Z ± depth`.
- **Cylindrical** wraps walls only (no caps). The default axis is the object's vertical centre line.
- **Single-colour printers**: a region that does not fill its whole layer cannot be swapped at a layer boundary. *Skip* (default) leaves it in the base colour and warns; *Bands* colours those whole layers; *Allow* emits a pause per change. A logo on a flat top is only swap-friendly if it is raised (its layers are logo only) — see test print 2.
- **Change-point shift** stays within the extrusion run next to the change (same layer).
- **Reduced purge** without a volume uses half of the matrix value.
- Region outlines in the preview are capped at 200k points.
- Patterns, placements and region actions are saved in the `.3mf` project (`Metadata/nexspiro_project.json` → `patternex`) and restored on open; placements on objects missing from the project are dropped.

## 7. Pattern library (§11.1, started)
- 64 original procedural families in 8 types (Geometric, Polygons, Tiles, Shapes, Math, Organic, Lines, Ornament) × presets × variants × densities × seeds = 2,755 uninked designs (`library/families.ts`, `library/catalog.ts`). Polygons include Archimedean tilings (4.8.8, 3.6.3.6, 3.12.12), rhombille and Cairo pentagons; Math includes superformula, rose, spirograph, Lissajous, phyllotaxis, Sierpinski, Koch and Hilbert.
- Designs load uninked; the user inks each region (filament slot or base). Leaving a design with unsaved inks asks to save them — saved inks reload with the design, otherwise they are removed.
- Library window at 98% of the screen: type and palette filters, search, lazy thumbnails, slider editor for every family parameter, seed and palette, live preview plus a cube showing the target.
- Apply to: a picked face, one side (top/bottom/front/back/left/right), all four sides, or the whole body (cylindrical wrap). With *fit to target* the pattern is regenerated at the target's size so the cell size stays as set.

## 8. Not started (spec §11 extended scope)
Library categories for logos and text, user uploads with tags, the text tool, raster tracing/halftone/dither, palette quantisation, paint brush, spherical/UV projection, tiling, angle filter, region booleans, edge treatments, non-colour region actions, dithered gradients, extra purge strategies (into infill/object), bleed calibration wizard, swap optimiser, waste/cost estimate per pattern, rule engine, style presets, per-order templates, project files, Emerald/Nexder/Nexcal integration, job logging.
