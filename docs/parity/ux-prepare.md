# Prepare workspace — UX parity check (Bambu Studio / OrcaSlicer)

Method: Playwright against `npm run dev` (1440×900 and 390×844), driving the toolbar, the keyboard and the right-click menu, and reading the store (`window.__nxStore`) to check the geometry and undo. Scripts: the scratchpad `ux-prepare/t*.js`. No console errors were logged during any of the runs below.

Status: **OK**: matches expected behaviour · **fixed**: fixed in this pass · **issue open**: not fixed (outside the files this pass could edit, or a design decision).

## Tools (toolbar, shortcut, context menu)

| Action | Expected (Bambu/Orca) | Observed | Status | Files |
|---|---|---|---|---|
| Tool shortcuts M R S F C B L P N H T U E G | The key toggles the gizmo; the tooltip shows the key | Every key opens its tool and the same key closes it; the tooltips match (`Label (K)`) | OK | src/App.tsx `useShortcuts`, src/ui/PrepareOverlays.tsx `Toolbar` |
| Esc inside a tool | First Esc closes the gizmo and keeps the selection; the next Esc deselects | One Esc closes the tool **and** clears the selection | issue open (src/App.tsx, not editable here) | src/App.tsx:105 |
| Shortcut list (`?`) | Lists every tool key | `G` (Edges) is missing from the list | issue open (src/App.tsx) | src/App.tsx `SHORTCUTS` |
| Bambu keys `+`/`-` (add/remove instance), Ctrl+Del (delete all) | Present in Bambu | Not bound; Delete All is only in the empty-space context menu | issue open (src/App.tsx) | — |
| Move / Rotate / Scale numeric fields | Type a value, Enter applies it, undo works | X=50 moved the object, Ctrl+Z restored it; rotate 45° dropped the object to the bed; scale 200 % → ×2 | OK | src/ui/TransformPanel.tsx |
| Cut: height/tilt numeric fields | You can type any value, including decimals and negatives | Each key press was parsed and clamped, so "0." became 0 and "-" was rejected: you could not type 5.5 or -30 | **fixed** (draft text committed on Enter/blur, Esc reverts) | src/ui/ToolPanels.tsx `Slider` |
| Cut: perform, undo/redo | 2 parts (upper part flipped onto the cut face), one undo step | Lower part 0–5.5 mm, upper part 14.5 mm tall placed beside it; undo/redo work | OK | src/state/tools.ts `cutObject` |
| Undo after cut / split / union | The selection follows the restored scene | The selection keeps the ids of objects that no longer exist (e.g. 2 selected, 1 object) | issue open (src/state/store.ts `undo`/`redo`) | src/state/store.ts:390 |
| Mesh boolean (B) | Panel lists the base and the tools; Union/Difference/Intersection | Works for 2+ selected; union → 1 object, one undo step | OK | src/ui/ToolPanels.tsx, src/state/tools.ts |
| Lay on face (F), Text (T), Measure (U), Brim ears (E), Support/Seam/Colour painting (L/P/N), VLH (H), Edges (G) | The panel opens next to the toolbar; Esc closes it | All open and close; colour painting explains that a second filament is needed; the context-menu "Paint colour" item is disabled with 1 filament | OK | src/ui/ToolPanels.tsx, src/ui/advanced/* |
| Split to objects | Splits into parts; a single-shell object reports that there is nothing to split | Shows the toast "single piece, nothing to split" | OK | src/state/objectOps.ts `splitObject` |
| Mirror X/Y/Z | Mirrors in place, one undo step | OK | OK | src/state/objectOps.ts `mirrorObjects` |
| Clone… (N copies) | One action → one undo | Took 2 undos: the first only undid the arrange and left the copies in place | **fixed** (`oneUndoStep`) + test | src/state/objectOps.ts `cloneObjects`, src/state/ops.ts `oneUndoStep` |
| Arrange all (A) / selected (Shift+A) | One undo step | Took one undo step per plate | **fixed** + test | src/state/ops.ts `arrangeAll`/`arrangeSelected` |
| Arrange settings (right-click the Arrange button) | Popover closes on Esc, a click outside or a tool change | Stayed open over the Measure, Colour and VLH panels; Esc did nothing | **fixed** (listeners bound once; an inline `onClose` was re-binding them during the zustand sync render and dropping the event) | src/ui/PrepareOverlays.tsx `ArrangeSettings` |
| Duplicate (Ctrl+D), Copy/Paste (Ctrl+C/V), Delete, Select all | Standard | Duplicate, undo and redo OK; paste places the copies offset; Delete then Ctrl+Z restores | OK | src/App.tsx, src/state/objectOps.ts |
| Add primitive | Placed on the plate without overlapping existing objects | A second shape lands exactly on top of the first (both at the plate centre) | issue open (minor; Bambu also adds at the centre but arranges imports) | src/state/objectOps.ts `addShape` |
| Object filament (context menu › Filament) | Only existing slots | The menu offers only the existing slots; `setObjectFilament` itself does not validate | OK | src/ui/ContextMenu.tsx |
| Printable toggle, Center, Drop to bed | Standard, undoable | OK | OK | src/state/objectOps.ts |
| Context menus (object / empty space) | Bambu-like object menu (parts, modifiers, negative parts, height range, paint, cut, export) and empty-space menu (add, paste, select all, arrange, plates) | Present; Cut is disabled for multi-select (Bambu does the same) | OK | src/ui/ContextMenu.tsx |
| Tool buttons with nothing selected | Gizmos are disabled without a selection | Move/Rotate/Cut etc. stay enabled and show "Select an object…" | issue open (design choice) | src/ui/PrepareOverlays.tsx `T()` |
| Phone width (390 px) | No horizontal scroll; panels usable | No horizontal scroll; the Move/Cut/Colour panels become bottom sheets and fit | OK | src/ui/*.css |
| Plates add/delete/move | — | Not exercised in depth (src/ui/PlateControls.tsx is owned by another agent); the plate items in the context menu are present | not checked | src/ui/PlateControls.tsx |
