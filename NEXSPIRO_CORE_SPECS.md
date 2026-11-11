# NEXSPIRO_CORE_SPECS — Core Architecture Blueprint (plugins excluded)

Scanned from branch `ccr-98df53cd-c9au4g`, app version 0.2.8. Everything under `src/plugins/**` (Motionex, Patternex, Hanex, Bulnex, Plantex, Lumonex, Clickex, Flenex, registry) is **out of scope**. Core code only *references* plugins through `s.plugins.includes(...)` guards and the `ObjectPatternex` type import in `src/state/store.ts:14`.

---

## 1. TECH STACK & ENGINE PIPELINE

| Layer | Technology | Evidence |
|---|---|---|
| Desktop shell | Electron 33 (`electron/src/main.ts`, `electron/preload.cjs`), electron-builder (NSIS / DMG / AppImage+deb) | `package.json` `main`, `build` |
| Web runtime | Same bundle runs in a browser (`vite base: './'`), GitHub Pages workflow | `vite.config.ts`, `.github/workflows/pages.yml` |
| UI | React 18 + TypeScript 5.6, Vite 5, `@vitejs/plugin-react` | `src/main.tsx`, `src/App.tsx` |
| 3D | Three.js 0.170 (WebGL), `OrbitControls`, `three-mesh-bvh` (raycast), `three-bvh-csg` (boolean), `three-gpu-pathtracer` (Renex render studio) | `src/viewport/Viewport.tsx:8,243` |
| State | **Zustand 4** single global store `useStore = create<State>()` (`src/state/store.ts:286`); immutable scene records, meshes shared by reference. Side stores: `src/state/advanced.ts` (Advanced engine), `devices.ts`, `measure.ts` | `store.ts:1` |
| Slicing engine | **Custom pure-TypeScript slicer** (no LibSlic3r/WASM). Runs in an ES-module Web Worker (`src/engine/worker.ts`, started by `src/workers.ts:47`). Workers: `slicer`, `nest` (arrange), `analysis` (Advanced FEA) | `src/workers.ts:11` |
| Geometry libs | `clipper-lib` (2D offsets/booleans, `src/engine/clipper.ts`), `manifold-3d` (solid ops), `opentype.js` (text), `occt-import-js` (STEP/IGES/BREP in worker `src/renex/cad/occtWorker.ts`), `bwip-js` (barcodes) | `package.json` |
| G-code templating | Own implementation of Prusa/Orca/Bambu placeholder language (`src/engine/placeholder.ts`, vars in `templateVars.ts`) | |
| Printer connectivity | `src/connect/` (HTTP: Moonraker/Octo/etc., Web Serial), Electron LAN discovery `electron/src/discover.ts`, `lan.ts` | |
| Tests | Vitest 2 (node env), ~90 test files in `tests/` | |
| Styling | **Plain global CSS** with CSS custom properties (no Tailwind/CSS-modules). Files: `src/styles.css`, `src/ui/density.css`, `src/ui/shell/shell.css`, `src/ui/kit/kit.css`, `src/ui/transform.css`, `src/ui/inspector/inspector.css`, `src/ui/advanced/*` | |
| Fonts | `@fontsource/inter` (UI), `@fontsource/jetbrains-mono` (mono) | |

**Design tokens** (`src/styles.css:7-53`): `--ns-canvas-a/b`, `--ns-grid`, `--ns-plate`, `--ns-panel(-2)`, `--ns-line`, `--ns-text(-2/-3)`, `--ns-active`, `--ns-primary(-hover/-soft)`, `--ns-ok/warn/err`, `--ns-mod-ink` (modified value), `--ns-shadow(-lg)`, `--ns-hover`, `--ns-r-outer: 12px`, `--ns-r-inner: 8px`, `--ns-font-ui/mono`; light + dark sets; semantic aliases `--surface-*`, `--border*`, `--text*`, `--accent*`, `--modified`, `--warning`, `--error`. Theme in store: `Theme = 'dark' | 'light'`.

**Breakpoints**: 1760 / 1500 / 1480 / 1280 / 1180 px (toolbar & tab label collapse, `styles.css:225,633-697,987`), 1024 / 900 / 767 px (tablet/phone density, `density.css:92-223`), `(hover: none)` touch rules (`density.css:199,206`).

**Pipeline**: Import → `weld` to `IndexedMesh` (`engine/mesh.ts`) → `SceneObject` in store → `sliceNow()` (`state/slicing.ts:71`) builds `MeshInput[]` (`plateMeshes`, :44) + resolved `Config` (`currentConfig`, :17) → worker `engine/worker.ts` → `slice()` (`engine/slicer.ts:289`; Advanced path `engine/advanced/classic/slicer.ts:121`) → `slice.ts` (mesh→layers), `walls.ts`/`arachne.ts`, `fill.ts`/`patterns.ts`/`lightning.ts`, `support.ts`, `seam.ts`, `order.ts`/`travel.ts`, `wipeTower.ts` → `gcode.ts` (emit + stats) → `SliceOutput` back to store → `viewport/toolpaths.ts` preview.

---

## 2. FILE TREE & MODULE MAP (non-plugin)

```
electron/
  src/main.ts            Electron main process, window, IPC, file dialogs
  src/devices.ts         printer connections in main process
  src/discover.ts, lan.ts LAN printer discovery (mDNS/SSDP)
  src/updates.ts         auto-update
  preload.cjs            contextBridge API
scripts/                 build-electron.mjs, package-win.mjs, e2e/collision.mjs
src/
  main.tsx, App.tsx      React entry, workspace router (home/prepare/preview/motion/device/project/calibration)
  platform.ts            web-vs-Electron file open/save abstraction
  workers.ts             worker URL registry + blob preloading (slicer, nest, analysis)
  state/                 Zustand store + all actions
    store.ts             State shape: objects, parts, plates, tool, workspace, slice, filaments, overrides, UI flags
    slicing.ts           sliceNow / cancelSlice / plateMeshes / currentConfig
    actions.ts           import files, new project, exportGcode
    project.ts           3MF project save/load (+ placements)
    printjob.ts          exportPlateFile('3mf'|'gcode'), filename_format, send to printer
    tools.ts             cut, boolean, text/SVG emboss, bake parts
    meshTools.ts         edges: crease select, bevel, subdivide, smooth, remesh, exactify, repair
    objectOps.ts         mirror, split, centre, drop, clone, copy/paste, STL export, primitives, cut-and-separate
    ops.ts               PrimSpec primitives, modifier/part ops, height ranges, orient/arrange
    tree.ts              object-list tree model
    ui.ts                keyboard shortcuts / tool switching / export guards
    measure.ts           measure features (point/edge/face/circle)
    cutConnectors.ts     cut plug/dowel/groove settings
    fillBed.ts, calibration.ts, devices.ts, amsSync.ts, userPresets.ts, errors.ts, advanced.ts, motionPaint.ts
  engine/                pure-TS slicing kernel (worker-safe)
    slicer.ts            main slice() orchestrator (2706 lines)
    slice.ts, layers.ts  triangle→contour, variable layer heights
    walls.ts, arachne.ts, wallParity.ts  perimeters (classic + variable width)
    fill.ts, patterns.ts, infillOptions.ts, lightning.ts  infill
    support.ts, supportExtras.ts          normal/tree support, raft, interfaces
    seam.ts, order.ts, travel.ts, arc.ts  seam placement, ordering, travel/avoid, arc fitting
    wipeTower.ts, toolmap.ts, interlock.ts  multi-material
    gcode.ts, gcodeParity.ts, placeholder.ts, templateVars.ts  G-code emission + templates + stats
    calibGcode.ts        calibration program generators
    mesh.ts, meshops.ts, meshedit.ts, repair.ts, topology.ts, exactify.ts, facesets.ts  mesh kernel
    arrange.ts, nest.ts, nestWorker.ts    auto-arrange
    paint.ts, brush.ts   paint data → per-layer masks
    adaptivePA.ts, noise.ts (fuzzy skin), outlineSmooth.ts, validate.ts, slicerOptionKinds.ts, types.ts, util.ts, clipper.ts
    advanced/            "Advanced engine": 35 techs (modules/*), classic/* fork of slicer, FEA, SDF, planner
  viewport/
    Viewport.tsx         Three scene, camera, gizmos, raycast, paint, box select (1961 lines)
    toolpaths.ts         preview geometry + colour schemes
    plate.ts             bed/plate meshes, multi-plate layout
    rotateSnap.ts        rotation ring snapping
    edgeOverlay.ts, flatFaces.ts, threads.ts, thumbnail.ts
  ui/
    shell/               MenuBar, FileMenu, Rail (workspace tabs), TopRight, ViewBar, ActionDock, ObjectPill, RightColumn, CommandPalette, PhoneArrows
    Sidebar.tsx, ParamRow.tsx   process dock (global/objects), param rows
    inspector/           object inspector
    PrepareOverlays.tsx  top toolbar + VLH and brim-ears panels
    ToolPanels.tsx       boolean, text/SVG, measure, edges, lay-on-face panels
    TransformPanel.tsx   move/rotate/scale numeric panel
    ContextMenu.tsx      canvas/object/part right-click menus
    PreviewOverlays.tsx  legend, layer slider, move slider, G-code view, progress
    Modals.tsx           Printer / Filament modals; ImportDialog, PrintModal, FillBedDialog, ExportBooleanDialog, FilamentSequenceEditor, ColorMixing
    Pages.tsx            Home / Project / Calibration pages; DevicePage.tsx
    advanced/            Advanced-mode panel, tech graph, paint panel
  profiles/
    settings.ts          process schema (389 ParamDefs), migrateConfig
    machineParams.ts     87 printer params;  filamentParams.ts  103 filament params
    printers.ts, filaments.ts, vendor/*.json (51 vendor printer profiles), resolve.ts, userPresets.ts, mixing.ts, flush.ts, changer.ts, amsSync.ts
  io/                    stl.ts, obj.ts, amf.ts, threemf.ts, cad.ts, gcode3mf.ts, load.ts, md5.ts
  connect/               client.ts, http.ts, serial.ts, types.ts
  renex/                 render studio (path-traced product renders) + OCCT CAD import worker
tests/                   vitest suites (engine, parity, stress, advanced, io)
docs/                    parity reports (ORCA_BAMBU_PARITY, options, machine-gcode, ux-flows), stability
```

---

## 3. VIEWPORT & TOOLBAR INVENTORY

### Top toolbar (`src/ui/PrepareOverlays.tsx:25-62`), `Tool` union in `store.ts:20`

| Tool | Key | Status | Implementation |
|---|---|---|---|
| Auto orient | – | **Wired** | `autoOrient()` / `orientPlate()` (`state/ops.ts`) |
| Arrange (all / Shift = selected, right-click settings) | A | **Wired** | `arrange.ts`, `nest.ts` in `nest` worker |
| Split to objects | – | **Wired** | `splitObject` `objectOps.ts:95` |
| Variable layer height `vlh` | H | **Wired** | panel `PrepareOverlays.tsx:310`, `o.layerHeights` consumed in `slicer.ts:383` (only first profile per plate is used — warning `:386`) |
| Move / Rotate / Scale | M / R / S | **Wired** | gizmos in `Viewport.tsx`, numeric `TransformPanel.tsx` |
| Lay on face `face` | F | **Wired** | `Viewport.tsx:427`, `flatFaces.ts` |
| Cut `cut` | C | **Wired** | `cutObject` `tools.ts:120`, connectors/grooves `cutConnectors.ts`, preview `cutPreview` |
| Mesh boolean `boolean` | B | **Wired (panel-driven)** | `booleanSelected` `tools.ts:284` (three-bvh-csg/manifold); no viewport interaction (0 refs in Viewport) |
| Support / Seam / Colour paint | L / P / N | **Wired** | `isPaintTool` `Viewport.tsx:167`, `ObjectPaint` masks → `engine/paint.ts`; colour paint needs ≥2 filaments |
| Text shape `text` (+ SVG emboss) | T | **Wired** | `textMesh`/`svgMesh`/`embossVolume` `tools.ts:400-488` |
| Measure | U | **Wired** | `ToolPanels.tsx:204`, modes auto/point/edge/face/circle |
| Brim ears | E | **Wired** | `PrepareOverlays.tsx:379` sets `brim_type = brim_ears` |
| Edges (chamfer/fillet/smooth) | G | **Wired** | `ToolPanels.tsx:261`, `meshTools.ts` |
| Duplicate / Delete / Fix model | Ctrl+D / Del | **Wired** | `repairObjects` `meshTools.ts:161` |
| `paint_adv` | – | Wired (Advanced mode only) | `AdvPaintPanel.tsx` |
| `sculpt_pick`, `paint_motion`, `pick_motion`, `lasso_motion`, `band_motion`, `object_motion`, `place_pattern` | – | Plugin-owned (Motionex / Patternex) — out of scope | |

Also in MenuBar Tools menu (`ui/shell/MenuBar.tsx:134-143`) and ObjectPill (`ui/shell/ObjectPill.tsx`).

### Camera & gizmos (`Viewport.tsx:243-254, 848, 939`)
- `OrbitControls`, damping 0.15, `screenSpacePanning`, `zoomToCursor`.
- Mouse: **LEFT orbit, MIDDLE pan, RIGHT pan, wheel zoom**. With paint tool active, left press on mesh paints, on empty space orbits (`paintButtons`, `:1699`).
- Handle snapping with Shift: **1 mm move, 5° rotate, 5 % scale**; Alt on scale toggles uniform.
- Rotation ring (`rotateSnap.ts`): pointer within tick band (0.88–1.16 ring radii) → 5° steps; band 1.16–1.5 → 45°; Shift ≥5° anywhere.
- Box select: left→right = window, right→left = crossing (`:1544`).
- Raycast: three-mesh-bvh; helper overlays set `raycast = () => {}` to be non-pickable.
- ViewBar / view cube (hidden on phones, `density.css:223`), touch orbit (`TouchMods.tsx`, `PhoneArrows.tsx`).

### Context menus (`src/ui/ContextMenu.tsx`)
- **Empty canvas**: Add model…, Add Primitive (+ Text shape), Paste, Select All, Arrange, Arrange All Plates, Auto Orient, Expand/Collapse All, Delete All, Lock plate, Plate Settings…, Add Plate, Delete Plate.
- **Object**: Rename, Copy, Paste, Duplicate, Clone…, Fill bed with copies…, Delete, Center on plate, Drop to bed, Auto orient, Mirror X/Y/Z, Fix model, Split to objects, Filament ▸ (slots + mixes), Printable, Move to plate ▸, Add part/negative/modifier/support enforcer/blocker ▸ shapes, Add wall cutter / wall shell, Cut along wall cutters and separate, Add height range modifier, Paint support/seam/colour, Cut, Export as STL…; plugin-guarded items (Motionex, Patternex).
- **Part**: Delete part, Move, Rotate, Scale, Edit settings (→ `processMode: 'objects'`).

---

## 4. SETTINGS & PARAMETER TAXONOMY

- `ProcessTab = 'Quality' | 'Strength' | 'Speed' | 'Support' | 'Others'` (`profiles/settings.ts:4`). Same tabs in Global and Objects mode (`store.processMode: 'global' | 'objects'`, `store.ts:140`). Multimaterial options live under *Others*.
- `ParamDef { key, label, tab, group, type: float|int|bool|enum|percent|floatOrPercent|string|text, unit, min, max, step, options, def, tip, advanced?, disabledWhen?, percentOf? }`. **389 process keys** (Quality 112, Strength 68, Speed 62, Support 54, Others 93).

| Tab | Groups |
|---|---|
| Quality | Layer height, Line width, Seam, Precision, Ironing, Wall generator, Advanced |
| Strength | Walls, Top/bottom shells, Sparse infill, Advanced |
| Speed | Initial layer speed, Other layers speed, Travel speed, Acceleration, Jerk(XY) |
| Support | Support, Raft, Support filament, Support ironing, Tree Support, Advanced |
| Others | Bed adhesion, Prime tower, Flush options, Special mode, Advanced, G-code output, Post-processing scripts, Color Mixing (Experimental), Notes |

**Printer settings** (`machineParams.ts`, 87 keys, `PrinterModal` `ui/Modals.tsx:37`): Machine limits, Speed/Acceleration limitation, Layer height limits, Extruder Clearance, Cooling fan, Accessory, Retraction, Retraction when switching material, Multi-material, Single extruder multi-material, Ooze prevention, Advanced, Notes. **Machine G-code**: `machine_start_gcode`, `machine_end_gcode`, `printing_by_object_gcode`, `before_layer_change_gcode`, `layer_change_gcode`, `time_lapse_gcode`, `change_filament_gcode`, `machine_pause_gcode`, `change_extrusion_role_gcode` (+ `emit_machine_limits_to_gcode`). Rendered by `engine/placeholder.ts`. 51 vendor profiles in `profiles/vendor/*.json`.

**Filament settings** (`filamentParams.ts`, 103 keys, `FilamentModal` `Modals.tsx:65`): Basic information, Print temperature, Volumetric speed limitation, Part cooling fan, Auxiliary part cooling fan, Exhaust fan, Retraction, Ironing, Filament scarf seam settings, Multimaterial, Toolchange (single- & multi-extruder MM), Filament start/end G-code, Change extrusion role G-code, Notes. User presets: `profiles/userPresets.ts`, `state/userPresets.ts`; AMS sync `amsSync.ts`.

**Override tree** (`store.ts`):
- `State.overrides: Config` — global process overrides over the preset.
- `SceneObject.overrides?: Config` — per-object.
- `SceneObject.parts?: ScenePart[]` — `type: PartType = 'part' | 'negative' | 'modifier' | 'support_enforcer' | 'support_blocker'` (`engine/types.ts:85`), each with own `overrides`, transform, optional `prim`.
- `SceneObject.heightRanges?: HeightRange[]` — `{ id, z0, z1, overrides }` (`store.ts:72`).
- `SceneObject.paint` (support/seam/color/adv masks), `layerHeights`, `filament`, `printable`, per-plate settings via `plates[]`.
- Resolution: `profiles/resolve.ts` + `currentConfig(plate)`; tested in `tests/object-overrides.test.ts`.

---

## 5. PREVIEW & SLICING PIPELINE

- **Trigger**: `sliceNow()` `state/slicing.ts:71` → sets `slice.status = 'slicing'` → `startWorker('slicer')` → `postMessage({...})` (:121). Messages back: `{type:'progress', stage, pct}` → `slice.stage/progress` (:109); `done` → `slice.result: SliceOutput` (:113); errors → `fail()`. `cancelSlice()` (:31) terminates worker. Edits during slice set `slice.dirty`. UI: `SliceProgress` (`PreviewOverlays.tsx:277`).
- **SliceOutput** (`engine/types.ts:198`): `gcode`, packed `moves: Float32Array`, `moveFeatures`, `moveAux` (fan %, temp), `moveLines`, `moveWave`, `pauses`, `layers`, `stats`, `warnings`, `pluginReports`, `advanced`.
- **Colour schemes** (`ColorScheme`, `store.ts:22`; `viewport/toolpaths.ts:263-270`): feature (line type), filament, wave, speed, height, width, flow (speed·w·h), layer_time, layer_time_log, fan, temperature. Feature order: outer/inner/overhang wall, sparse & solid infill, top/bottom surface, bridge, internal bridge, ironing, skirt, brim, support, support interface, travel, prime tower, gap infill, wave overhang (`types.ts:219`). Legend `PreviewOverlays.tsx:30`.
- **Scrubbers**: `LayerSlider` (dual handle, vertical, `PreviewOverlays.tsx:165`; arrow keys, one-layer toggle, `layerRange` + `oneLayer`/`savedLow`) and `MoveSlider` (horizontal, `:240`, `moveCursor`) with synced G-code listing (`showGcode`, `:260`). Viewport applies `toolpaths.setRange(lo, hi, moveCursor)` (`Viewport.tsx:1846`).
- **Toolhead animation**: **not implemented** — no play/animate loop or nozzle marker; the move cursor only truncates the drawn path.
- **Statistics** (`SliceStats`, `types.ts:169`): `timeSeconds`, `filamentMm`, `filamentGrams`, `filamentCost`, `layerCount`, `toolChanges`, `perFilament[{grams,mm,cost}]`, `towerGrams`, `byFeature{time,filamentMm,grams}`, `flushGrams`, `repeat`. Computed in `engine/gcode.ts` (weight = volume × density, `:483`, `:657`; time from per-move `time` with acceleration in planner).

---

## 6. FILE I/O

**Import** (`io/load.ts:31` `SUPPORTED_EXT = .stl .obj .3mf .amf`; dispatcher `state/actions.ts:19-29`):
| Format | Handler |
|---|---|
| .stl (ascii/binary) | `parseSTL` `io/stl.ts:2` |
| .obj | `parseOBJPolys` `io/obj.ts` |
| .3mf | project → `openProject` (`state/project.ts`) or model → `parse3MF` `io/threemf.ts:158` (colours, paint, plates, printer model) |
| .amf | `parseAMF` `io/amf.ts` |
| .step/.stp/.iges/.igs/.brep | `loadCadFile` `io/cad.ts:8` → OCCT worker; keeps CAD face ids |
| .svg | **not a file-import handler**; only via Text/SVG emboss tool (`svgMesh` `state/tools.ts:457`) |

**Export**:
| Output | Handler |
|---|---|
| .gcode | `exportGcode` `state/actions.ts:162` (Ctrl+G); also `exportPlateFile('gcode')` `state/printjob.ts:90` |
| .gcode.3mf (sliced plate) | `exportPlateFile('3mf')` → `buildGcode3mf` `io/gcode3mf.ts:19` (+ thumbnails, md5) |
| .3mf project | `saveProject` (`state/project.ts:134`, Ctrl+S) |
| .stl | `exportStl` `objectOps.ts:197` (`writeSTL` `io/stl.ts:25`); optional boolean-merge dialog `ExportBooleanDialog.tsx` |
| Send to printer | `PrintModal.tsx` + `connect/*` |

---

## 7. KNOWN GAPS, STUBS & TODOs

Grep for `TODO|FIXME|XXX|HACK|stub|mock|unimplemented|not implemented|placeholder|() => {}` across non-plugin `src/` and `electron/src/` found **zero TODO/FIXME/stub markers**. Remaining hits are intentional:

| File:line | Finding | Nature |
|---|---|---|
| `src/engine/advanced/session.ts:165` | Runtime warning "`<setting>` is not implemented in this engine build; the setting is ignored." | **Real gap**: some Advanced-tech params are exposed but unused |
| `src/viewport/Viewport.tsx:271,299,708,724,726,782` | `raycast = () => {}` | Intentional: makes overlays unpickable |
| `src/connect/serial.ts:57,59,211`, `src/state/devices.ts:31,49,56,88,103`, `electron/src/devices.ts:54,92`, `src/ui/PrintModal.tsx:68` | `.catch(() => {})` | Swallowed errors in device connect/disconnect — audit candidate (silent failures) |
| `src/engine/slicer.ts:289`, `advanced/classic/slicer.ts:121,135`, `renex/engine.ts:195`, `connect/client.ts:153` | default no-op callbacks | Intentional |
| `placeholder` hits in `engine/placeholder.ts`, `templateVars.ts`, `gcode.ts:85,684`, `printjob.ts:23`, `Modals.tsx:59` | G-code template placeholders | Not stubs |

**Functional gaps found during scan** (not marked in code):
1. No toolhead playback animation in Preview.
2. SVG is not a direct import format (emboss tool only); `.svg` absent from `SUPPORTED_EXT`.
3. Variable layer height: only the first object's profile per plate is applied (`slicer.ts:383-386`).
4. Mesh boolean has no viewport interaction (panel only).
5. E (extrusion) computed from 2D XY length in main loop `slicer.ts` and `advanced/classic/slicer.ts:669-678` — under-extrudes on non-planar moves (see `AUDIT_MANIFEST.md`).
6. Tool union carries plugin-only tools (`sculpt_pick`, `*_motion`, `place_pattern`) inside the core store type — coupling to plugins.

Related prior audits: `AUDIT_MANIFEST.md`, `AUDIT_WIRING.md`, `docs/ORCA_BAMBU_PARITY.md`, `docs/parity/*.md`, `docs/STABILITY_REPORT.md`.
