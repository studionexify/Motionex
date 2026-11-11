# UX flows outside the Prepare tools — parity check vs Bambu Studio / Snapmaker Orca

Method: drove the dev build (`vite --port 5181`) with Playwright at 1600×950 (scripts and screenshots in the session scratchpad `ux-flow/`), read the code, and compared with the Bambu Studio wiki (quick-start, preset, calibration_flow_rate, calibration_pa, multi-color-printing) and the Snapmaker Orca QSG.
Status: **OK** = behaves as a Bambu/Orca user expects; **fixed** = fixed in this pass; **issue open** = not fixed (file outside this pass's scope or needs a feature).

## Presets and filaments

| Action | Expected (Bambu/Orca) | Observed | Status | Files |
|---|---|---|---|---|
| Printer / plate type / nozzle pick | Combo boxes in the sidebar, printer edit opens printer settings | Printer, bed and nozzle selects + edit pencil | OK | src/ui/Sidebar.tsx |
| Process value edit marks modified | Changed value orange, preset name gets "(modified)", per-value reset arrow | Value orange, "Standard 0.20 (modified)", reset arrow per value and preset, tab badge, "1 changed" chip | OK | src/ui/ParamRow.tsx, src/ui/Sidebar.tsx |
| Save as user preset | "Save as…" next to the preset | Present | OK | src/ui/Sidebar.tsx |
| Settings search | Search box + Ctrl+F | "Search 50 settings (Ctrl+F)"; palette also finds settings | OK | src/ui/Sidebar.tsx |
| Printer / filament settings dialogs | Search, per-value reset, "revert all" | PrinterModal / FilamentModal with search, reset, Revert all | OK | src/ui/Modals.tsx |
| Esc closes a settings / print dialog | Esc closes the dialog | Esc did nothing in any `Modal` (Print dialog stayed open) | **fixed** — Esc closes the topmost Modal | src/ui/Modals.tsx |
| Filament list add/remove/colour/type | "+" adds a slot, swatch picks colour, type badge, edit pencil | "+", numbered swatch, preset select, type badge, edit | OK | src/ui/Sidebar.tsx |

## Slicing, preview and export

| Action | Expected | Observed | Status | Files |
|---|---|---|---|---|
| Slice plate (Ctrl+R) | Switches to Preview, progress, Esc/Cancel stops | Preview opens at once, progress % in the CTA, Cancel button + Esc | OK | src/state/actions.ts, src/ui/shell/ActionDock.tsx |
| Slice all plates | In the Slice dropdown / File menu | In the top menu bar File menu; missing in the floating File menu | **fixed** (added to floating File menu) | src/ui/shell/FileMenu.tsx |
| Slice all plates in command palette | Palette lists every menu action | Only "Slice plate" | issue open (palette actions live in src/state/ui.ts) | src/state/ui.ts |
| Preview layer slider / move slider | Vertical layer slider with height, horizontal move slider | Both present (layer + Z, move n/N) | OK | src/ui/PreviewOverlays.tsx |
| Colour-by modes, legend, feature visibility | Line type / speed / height / filament…; legend with toggles | Mode select, per-filament weights, Line types collapsible | OK | src/ui/PreviewOverlays.tsx |
| Stats time/filament/cost | Estimated time, filament g, cost | Time, filament, layers in dock; Details in legend | OK | src/ui/shell/ActionDock.tsx, src/ui/PreviewOverlays.tsx |
| Layer actions (pause / filament change / custom G-code) | "+" on the layer slider | "+" on the slider opens the layer actions | OK | src/ui/PreviewOverlays.tsx |
| Export G-code (Ctrl+G, menus, dock CTA) | Uses filename_format, runs post-processing, exports the sliced plate | Saved `<object>_<model>.gcode`, ignored filename_format, post-processing scripts and thumbnails; differed from Preview "Export" | **fixed** — routed through `exportPlateFile('gcode')` (now `Overhang_test_0.2mm_PLA_6m29s.gcode`) | src/state/actions.ts, src/state/printjob.ts |
| Export .gcode.3mf | File menu entry | Present; Bambu printers default to .gcode.3mf in Preview Export | OK | src/state/printjob.ts |

## Print / Device

| Action | Expected | Observed | Status | Files |
|---|---|---|---|---|
| Print dialog without printers | Prompt to add a device | "No printers added yet" + Add a printer, Send only / Print disabled | OK | src/ui/PrintModal.tsx |
| Print dialog printer pick, filament mapping, options | Printer combo, AMS mapping, bed levelling / timelapse options | Implemented (code read; no real printer to connect) | OK (UI only) | src/ui/PrintModal.tsx |
| Device page, add by IP | Choose connection type, enter IP / access code | Landing with LAN (access code), Klipper/Moonraker, OctoPrint, USB cards + Add printer | OK | src/ui/DevicePage.tsx |
| Controls disabled when not connected | Greyed out | Controls gated on connection state | OK | src/ui/DevicePage.tsx, src/state/devices.ts |

## Project, calibration, menus

| Action | Expected | Observed | Status | Files |
|---|---|---|---|---|
| Save project (Ctrl+S) | Writes .3mf, toast | `Overhang_test.3mf` downloaded, "Project saved" toast | OK | src/state/project.ts |
| Open project (.3mf) | Confirms before replacing the plate | `confirm()` then load, "Opened project" toast | OK | src/state/actions.ts |
| Project info page | Title, notes, model info | Project page present; calibration fills title + how-to notes | OK | src/ui/Pages.tsx |
| Calibrations (temp, PA tower/line/pattern, flow 1/2, MVS, retraction) | Each builds a plate that slices | All 8 sliced in the browser: temp 355 layers, PA 160, PA line 2, PA pattern 4, flow 15, flow fine 15, MVS 200 (vase), retraction 115 | OK | src/state/calibration.ts |
| Calibration settings between tests | Each test applies only its own settings | MVS's `spiral_mode: true` (and others) stayed on for the next test: the retraction test sliced as a vase | **fixed** — the previous test's override keys are removed first; test tests/calibration-overrides.test.ts | src/state/calibration.ts |
| VFA (vertical fine artifacts) test | Orca Calibration › VFA | Not offered | issue open (new calibration) | src/state/calibration.ts |
| Import formats | STL/OBJ/3MF/AMF/STEP | File picker accepts all of them, menu said "STL / OBJ / 3MF" | **fixed** label | src/ui/shell/FileMenu.tsx, src/ui/shell/MenuBar.tsx |
| Keyboard shortcuts | Ctrl+N/O/S/I/R/G/P, Ctrl+0–6 views, ? shortcut sheet, Ctrl+Tab tabs | All wired; Ctrl+G/P show a toast when not sliced | OK | src/App.tsx |
| Command palette (Ctrl+K) | Fuzzy search of actions and settings | Actions + settings with values, Enter runs, Esc closes | OK | src/ui/shell/CommandPalette.tsx |
| Preferences (Ctrl+,) | Preferences dialog | Opens from menu and shortcut | OK | src/ui/shell/MenuBar.tsx |
| Error / toast messages | Info/warn/error toasts | Info toasts with close; import errors, open edges, slice all summary | OK | src/state/actions.ts |
