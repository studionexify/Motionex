# NexSpiro: Production Audit Report (core only)

**Scope:** the core app (UI, viewport, state, engine, I/O, connect). Nothing under `src/plugins/**` was read for changes or modified. Every `s.plugins.includes(...)` guard is left as it was.

**How it was checked:**
- static review of the target files;
- `npx tsc --noEmit`;
- the full Vitest suite: 2395 tests passing before any change was made;
- one new regression test, `tests/macro-parity.test.ts`.

**Legend:** ✅ verified, no change needed · 🔧 fixed in this pass · ⚠️ known limitation, documented and not fixed · ⏳ not verified (needs manual or visual QA on hardware)

> **Honest caveat:** this was a code and test audit. I did not drive the Electron UI at 1920×1080, 1440×900 or 2560×1440. I did not compare print times or weights against Bambu Studio or Orca on real files, and I did not test on real printers. Those items are marked ⏳ and need a manual QA pass before the print-farm rollout.

---

## Mandate 1: Viewport tools and interaction

| # | Item | Status | Notes |
|---|------|--------|-------|
| 1.1 | Orbit / pan bindings | ✅ | `Viewport.tsx:254`, `normalButtons`: left = orbit, middle/right = pan. Paint tools swap to `paintButtons` (`:1699`). |
| 1.1 | Zoom toward cursor | ✅ | `Viewport.tsx:247`, `controls.zoomToCursor = true`, so zoom goes to the point under the cursor rather than the origin. |
| 1.2 | Rotate dual-band snap | ✅ | `rotateSnap.ts:9-13`: 5° in the tick band (0.88–1.16 R), 45° in the outer band (1.16–1.5 R), and Shift gives at least 5° anywhere. Covered by `tests/rotate-snap.test.ts` and `tests/gizmos.test.ts`. |
| 1.2 | Out-of-bounds warning | ✅ | `isOutOfBounds` drives the shader `uOOB` (`Viewport.tsx:734`) and the Sidebar warning icon (`Sidebar.tsx:437`) live while you transform. |
| 1.3 | Lay on Face | ✅ | `Viewport.tsx:1435` → `layOnFace` with the world-space face normal. Parts are excluded. |
| 1.4 | Cut tool / connectors | ✅ | Covered by the existing `cutSwap`, `phase2` and `phase3` tests. No defects found in review. |
| 1.5 | VLH on plates with several objects | 🔧 | The engine builds one layer stack per plate, as Bambu does for a shared plate (`slicer.ts:383-386`, which already warns in the log). **Added:** a visible badge in the VLH panel (`PrepareOverlays.tsx`, `VlhPanel`) whenever more than one object on the same plate has its own profile. It explains that the first object's profile is used for the whole plate. Real per-object layer stacks would need interleaved Z planning and remain out of scope. ⚠️ |
| 1.6 | Boolean picking in the viewport | 🔧 | `Viewport.tsx` (click handler): with the Boolean tool open, a plain click toggles an object in or out of the operand list, and the first pick is the base. Shift is no longer needed. `ToolPanels.tsx` `BooleanPanel` has updated instructions and a new **Clear picks** button. |
| 1.7 | Context menus | ✅ | `ContextMenu.tsx` actions all go through store actions (`ops.ts` / `tools.ts`), which recompute bounds and plates. No dead entries found. |
| 1.2 | Gizmo hover / planar handles | ⏳ | Needs hands-on mouse testing; not scriptable headless. |

## Mandate 2: Slicing pipeline and G-code

| # | Item | Status | Notes |
|---|------|--------|-------|
| 2.1 | Non-planar E uses 3-D length | ✅ | Already correct. `slicer.ts:1606` and `advanced/classic/slicer.ts:711` compute `len3 = hypot(len_xy, Δz)` and use it for **E** on both the constant-width and variable-width paths. The "XY-only" gap noted in the earlier spec is not in the current code. |
| 2.2 | Macro parser | ✅ + test | New `tests/macro-parity.test.ts` checks `{initial_extruder}`, `[nozzle_temperature]`, `[bed_temperature]`, `[layer_num]`, `[layer_z]`, `[total_layer_count]`, `{filament_preset[0]}`, `[printer_model]`, indexed vectors, and `{if}/{else}/{endif}`, all passing. |
| 2.2 | Injection points | ✅ | Start, end, before-layer and layer-change are wired in `gcode.ts:493/504/653`. Timelapse, toolchange and pause are in `slicer.ts:1998-2078`. |
| 2.3 | Support / tree | ✅ | Covered by `tests/parity-support.test.ts`. |
| 2.4 | Wipe tower / flush | ✅ | Covered by `tests/parity-mmu.test.ts`, `multimaterial.test.ts` and `toolchanger.test.ts`. |

## Mandate 3: Preview

| # | Item | Status | Notes |
|---|------|--------|-------|
| 3.1 | Toolhead marker | ✅ | Already present: a cone `nozzle` mesh in `toolpaths.ts:160-169`, placed at the cursor move's XYZ in `setRange` (`:314-326`). |
| 3.1 | Play/Pause and speed | 🔧 | New `MovePlayer` in `PreviewOverlays.tsx`, inside the move slider: a ▶/❚❚ button and a 1×/2×/5×/10× speed toggle. It steps `moveCursor` every 40 ms, which moves the nozzle marker, and stops at the end of the layer. |
| 3.2 | Layer slider / arrow keys / right-click actions | ✅ | `PreviewOverlays.tsx:177-212`. |
| 3.3 | Colour schemes / legend toggles | ✅ | Covered by `ui-bindings.test.ts`. |
| 3.4 | Stats consistency (±1 %) | 🔧 + test | New `tests/stats-consistency.test.ts` slices two plates on a P1S and checks that reported length matches the E axis in the G-code, grams = length × area × density, and the per-feature table sums to the total, all within ±1 %. **Bug found and fixed:** the feature table was short by 15–17 % because wipe-retract moves put negative E into the *travel* row while the matching unretracts only counted in the total (`gcode.ts`, `byFeature`). Travel rows now carry no filament, as in Bambu/Orca. Comparing against Bambu Studio's own estimates for the same files is still ⏳: it needs reference exports from the fleet. |

## Mandate 4: Sidebar and parameters

| # | Item | Status | Notes |
|---|------|--------|-------|
| 4.1 | Names and units | ✅ | Covered by `settings-wiring.test.ts`, `parity-options.test.ts` and the "settings at their limits" tests. |
| 4.2 | Global vs Objects override and reset | ✅ | `ParamRow.tsx:47` shows the reset icon on modified rows, and reset calls `onReset`. Covered by `object-overrides.test.ts`. |
| 4.3 | Labels truncated | 🔧 | `styles.css` `.prow .plabel` had `nowrap + ellipsis`, so long names such as "Minimum sparse infill threshold" were cut off. Labels now wrap at word boundaries. The grid is now `minmax(0,1fr) 18px minmax(96px,132px)`, so the input keeps a usable minimum width. The `inspector.css` pinned row got the same fix. Ellipsis on file names, crumbs and pills was left as is, because truncation is intended there. |
| 4.3 | Overlay layout at 1440×900, 1920×1080 and 2560×1440 | 🔧 verified | A headless Chromium script (Playwright) loaded the app, dropped a cube, sliced it, and checked every floating panel for overlap and for leaving the screen. **Bug found and fixed:** in Preview, the view cube overlapped the layer slider by about 11 px at the bottom, which blocked clicks near layer 1 (`shell.css`: `.ws-preview .viewcube` moved from `right: 62px` to `right: 86px`). After the fix there is no overlap at any of the three sizes. Screenshots: `docs/audit-prepare-1440.png`, `docs/audit-preview-1440.png`. |
| 4.3 | All 389 process rows in Expert mode | 🔧 verified | The same script turned Expert mode on and walked all 5 tabs (112 + 68 + 62 + 54 + 93 = 389 rows) at 1440 and 1920 wide. No label is cut off and no label runs into its input. **Bug found and fixed:** the unit "layers" spilled out of its column ("Skirt height", "Top interface layers"). In `styles.css`, the input now shrinks (`flex: 1 1 auto; min-width: 0`) and the unit no longer wraps. |
| 3.1 | Playback in the browser | ✅ | The script pressed Play: the cursor reset to the layer start and moved forward, with no page errors. |

## Mandate 5: File I/O and errors

| # | Item | Status | Notes |
|---|------|--------|-------|
| 5.1 | SVG dropped on the canvas | 🔧 | `actions.ts` `importBuffers` now asks *"SVG detected: X. Load it into the Text/Emboss volume tool?"*. If you say yes, it hands the file over through the new `state/svgHandoff.ts` and opens the Text tool with the SVG preloaded (`ToolPanels.tsx` `TextPanel`). If you say no, you get a toast. Before this change, dropping an SVG raised an "Unsupported file type" error. |
| 5.1 | STL / OBJ / 3MF / AMF / STEP | ✅ | Covered by `threemf`, `amf`, `cad-remesh-smooth` and `engine` tests. |
| 5.2 | Project round-trip / `.gcode.3mf` | ✅ | Covered by `project-facegroups.test.ts` and `threemf.test.ts`. |
| 5.3 | Silent `.catch(() => {})` | 🔧 | User-facing failures now report. **`state/devices.ts`** has a new `reportDeviceError()`, which shows an error toast and strips IPC prefixes; it is used for background reconnects at startup. **`ui/PrintModal.tsx:68`**: auto-connect failure shows a toast. **`connect/serial.ts:59`** (M105 poll) and **`devices.ts`** `learnIdentity` now log a warning; they are routine background tasks and should not toast every 5 s. Catches on disconnect and teardown (`devices.ts:49/56/88`, `serial.ts:211`, `electron/src/devices.ts:54/92`) stay silent on purpose: they run during cleanup, after the connection is already gone. |

## Mandate 6: Store hygiene

| # | Item | Status | Notes |
|---|------|--------|-------|
| 6.1 | Plugin tool ids in core `Tool` | 🔧 | `store.ts:20` now splits the union into `CoreTool` (core only) and `PluginTool`: the reserved plugin ids plus a generic `` `plugin:${string}` `` form. `Tool = CoreTool \| PluginTool`, so existing plugin code compiles unchanged, and core code can type against `CoreTool`. |

---

## Files changed

- `src/state/actions.ts`: SVG drop prompt.
- `src/state/svgHandoff.ts` (new): hands a dropped SVG to the Text tool.
- `src/ui/ToolPanels.tsx`: TextPanel picks up the handed-off SVG; Boolean panel copy and Clear picks button.
- `src/viewport/Viewport.tsx`: Boolean-mode click picking.
- `src/ui/PreviewOverlays.tsx`: toolhead Play/Pause and speed control.
- `src/ui/PrepareOverlays.tsx`: shared-VLH badge.
- `src/state/devices.ts`, `src/ui/PrintModal.tsx`, `src/connect/serial.ts`: error reporting.
- `src/state/store.ts`: `CoreTool` / `PluginTool` split.
- `src/styles.css`, `src/ui/inspector/inspector.css`: parameter labels no longer truncate.
- `tests/macro-parity.test.ts` (new).
- Second pass: `src/engine/gcode.ts` (feature-table filament), `src/styles.css` (unit column), `src/ui/shell/shell.css` (view cube position in Preview), `tests/stats-consistency.test.ts` (new), and two screenshots in `docs/`.

## Still open: needs people or hardware
- **Printer connections:** serial, LAN and MQTT on real printers. There are none in this environment.
- **Bambu Studio comparison:** time, weight and cost against Bambu Studio's own numbers for the same files. Needs reference `.gcode.3mf` exports.
- **Gizmo hover and drag feel:** needs hands-on mouse testing.
- **Per-object variable layer heights:** a design change, not a defect (see 1.5).

## Build and test verification

```
$ npx tsc --noEmit
(no errors)

$ npx vitest run
 Test Files  107 passed | 1 skipped (108)
      Tests  2399 passed | 1 skipped (2400)
```
No regressions: 2395 tests passed before the audit, and 2399 pass after. The 4 new ones are the 2 macro tests and the 2 stats-consistency tests.
