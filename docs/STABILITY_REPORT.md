# NexSpiro stability audit: "slicing fails after edits"

Symptom reported: on the web version, slicing sometimes failed with an error after editing, and some tools did
nothing when used.

## How the audit was done

1. **Path trace.** The trace followed each route from the UI to the engine: Prepare tools in `src/state/*` → store → `sliceNow`
   (`src/state/slicing.ts`) → Web Worker (`src/engine/worker.ts`) → `slice()` (`src/engine/slicer.ts`; Advanced:
   `src/engine/advanced/classic/slicer.ts` + modules; plugins: `src/plugins/engine.ts`) → G-code emission
   (`src/engine/gcode.ts`). It also covered the other workers (fill bed, Advanced analysis, Flenex, CAD), the async
   handlers, the `catch` blocks and the error display.
2. **Reproduction in a real browser.** A production build ran in headless Chromium. A redeploy was simulated while
   the tab was open (the hashed worker file removed), then the plate was sliced again.
3. **Discovery sweeps (about 3,000 slices).**
   - Every process, printer and filament setting at its UI limits (inputs clamp to `[min, max]`), 0, and every option.
   - 250 random combinations of eight settings at their limits.
   - The five Advanced intents × two resolutions × five setting variants.
   - All 195 Motionex patterns at extremes (20× amplitude, a 0.05 mm period, 10× scale, large Z waves).
   - Edited or broken geometry: NaN / Infinity vertices, scale 0, negative scale, below or above the bed, open
     meshes, degenerate and out-of-range triangles, bad layer-height profiles.

The classic slicing core proved robust: no crash or invalid G-code came from any single setting or any random
combination. Every failure sat at the edges of the core: in the worker
lifecycle, in geometry that edits can produce, in UI error handling, in two emission bugs (and their Advanced copy) that only a stricter G-code check could see, and
in one Motionex input guard.

## Diagnostic report

| # | Area | Problem | Effect for the user |
|---|------|---------|---------------------|
| 1 | Worker lifecycle (web) | Each slice started a new worker from its hashed URL. A deploy deletes the old hashed files, so a tab opened before the deploy hit a 404 on its next slice. | "Slicing failed: the slicer stopped unexpectedly" after the site updated while the tab was open. Reproduced in Chromium. **Main cause of the report.** |
| 2 | Worker errors | A load failure or crash has no message, so every case showed the same generic text. | No hint whether to reload, or to reduce memory use. |
| 3 | `sliceNow` | A `postMessage` that throws (`DataCloneError`) rejected the promise and left the status at "slicing". | Slicing stuck at "Preparing", with no error. |
| 4 | `sliceNow` | The mesh mapping ran after the worker started, outside any guard. | A throw leaked a worker and left the status unchanged. |
| 5 | Advanced analysis worker | No `onerror` handler at all. | "Analysing…" stays on screen forever on a load failure or crash. |
| 6 | Fill bed worker | `e.message` was empty on a load failure. | "Fill bed failed: undefined". |
| 7 | UI error handling | No global `error` / `unhandledrejection` handler. A tool that throws (a mesh edit, an async import or action) only logged to the console. | The tool silently "does nothing". |
| 8 | UI error handling | No React error boundary. | One render error blanks the whole app. |
| 9 | Lazy chunks | After a redeploy, lazily loaded tools (project files, fonts, CAD) fail with a raw import error. | The tool does nothing. |
| 10 | Transform panel and gizmo | Scale / Size accepted 0 and negative values, and the gizmo can drag the scale through 0. The next uniform scale divides by that 0. | NaN / Infinity geometry. |
| 11 | Engine input | One Infinity vertex made the layer plan unbounded. | About 30 s hang, then `RangeError: Invalid array length`. |
| 12 | Engine input | A NaN vertex made `maxZ` NaN. | An empty G-code file with no warning. |
| 13 | Engine input | A model scaled flat or sitting below the bed. | "Nothing to slice: the plate is empty" for a plate that visibly holds a model. |
| 14 | Engine output | A model thinner than a line, smaller than a layer, open, or cut away by a negative part. | An empty print with no warning. |
| 15 | Engine input | A variable layer profile containing 0, negative or NaN heights. | The print is silently cut short. |
| 16 | Brim and skirt | Brim and skirt loops were plain offsets with no clamp to the bed. | A wide brim (up to 100 mm) printed off the edge of the plate. |
| 17 | Retraction | The de-retraction was `retract + restart_extra` with no floor. | With a negative extra (allowed down to −5 mm), every prime pulled filament back: −439 mm net on a small plate. |
| 18 | Error messages | The engine reported only `e.message`. | "Cannot read properties of undefined" with no clue where in the pipeline it happened. |
| 19 | Styles | The `.empty` selector line had been deleted (CSS minifier warnings). | The Preview "Nothing sliced yet" hint rendered unstyled. |
| 20 | Advanced engine | Its frozen classic core carries its own copy of the brim and skirt code, with the same missing bed clamp as #16. | The same off-plate brim, in Advanced mode. |
| 21 | Motionex | A placement size of 0, or a spacing of 0 / NaN (from a project file or a saved pattern), made the event loop advance by `s += 0`. | About 70 s freeze, then `RangeError: Invalid array length`. |

## Fixes

| # | Fix | Where |
|---|-----|-------|
| 1, 2, 6 | `src/workers.ts` reads each self-contained worker script into memory once the page is idle, then starts workers from that copy, so a redeploy cannot break an open tab. A worker failure without a message is diagnosed: a 404 means "NexSpiro was updated… save, then reload"; otherwise a crash, likely memory. | `workers.ts`, `main.tsx`, `slicing.ts`, `fillBed.ts`, `advanced.ts` |
| 3, 4 | The slice input is built before the worker starts, and a failure is reported. A failed `postMessage` ends the slice with an error. | `slicing.ts` (`plateMeshes`) |
| 5 | The analysis worker has `onerror`, and a stale error from a replaced run is ignored. | `advanced.ts` |
| 7, 9 | `installErrorReporting()` turns every uncaught error or rejection into a toast (deduplicated, browser noise ignored), and turns `vite:preloadError` into the reload message. | `state/errors.ts`, `main.tsx` |
| 8 | A root `ErrorBoundary` offers Try again / Save project / Reload. The scene lives in the store, so nothing is lost. | `ui/ErrorBoundary.tsx` |
| 10 | The store enforces sane transforms on every add and update: non-finite values are reset, and \|scale\| ≥ 0.1 %. The panel refuses a scale of 0 % and a size ≤ 0. A negative scale stays allowed, since it is a mirror and 3MF imports carry them. | `state/store.ts` (`saneTransform`), `ui/TransformPanel.tsx` |
| 11–15 | `checkInputs()` runs before both engines. It collapses triangles that use non-finite vertices, keeping triangle order so paint stays aligned. It cleans layer profiles, names any flat or sunk object, and warns when nothing would be printed. Valid input passes through untouched, so Basic output stays byte for byte (the golden hashes are unchanged). | `engine/validate.ts`, `engine/slicer.ts` |
| 16 | A brim that would leave the bed is rebuilt for its own type, kept on the bed and flagged with a warning. Outer brims fill the contour band ∩ the bed, never the holes. Ears are clipped and stay ears. Inner loops are kept where they fit. Skirt loops off the bed are dropped, with a warning. A brim that fits is unchanged. | `engine/slicer.ts` |
| 17 | The de-retraction length is clamped at ≥ 0, so a negative extra can at most cancel the prime. | `engine/slicer.ts` |
| 18 | The worker appends the pipeline stage to the error ("… (while slicing mesh)") and logs the stack. | `engine/worker.ts` |
| 19 | Restored `.empty` and `.empty .hint`. | `styles.css` |
| 20 | The same conditional clip in the Advanced core. The inner brim is kept once, and the outer band comes from the contours only. Brims that fit are unchanged, so the Advanced golden hashes are unchanged. | `engine/advanced/classic/slicer.ts` |
| 21 | `placedBrush()`, which every placement goes through, floors the repeat at 0.05 mm. The controls bottom out at 0.1 mm, so no reachable output changes. | `plugins/motionex/modifier.ts` |

## Test harness (`tests/stress/`)

| Suite | What it covers |
|-------|----------------|
| `gcodeValidator.ts` | A strict validator. Every body line must be a known command with well-formed words. It rejects NaN / Infinity / undefined / null tokens and unexpanded placeholders, Z below the bed, extrusion above the printable height or off the bed, more than 1.5 mm of filament per mm of travel, retractions or primes over 30 mm, and feed rates ≤ 0. Start and end blocks must be present, and layers must rise. |
| `settings-edges.test.ts` | 311 settings (process, printer, filament) at their limits, validated. |
| `geometry-edges.test.ts` | Invalid coordinates, scale and position edits, models that print nothing, bad layer profiles, awkward but valid geometry, brim and skirt at the plate edge. |
| `combos.test.ts` | 80 seeded random combinations of eight settings at their limits. |
| `advanced-intents.test.ts` | The five Advanced intents × plain, vase, hollow, supported and 100 mm-brim settings. |
| `motionex-extremes.test.ts` | One pattern per family (17 families) through every extreme in both collision modes, plus all 195 library patterns at 20× amplitude with large Z waves. |
| `tools.test.ts` | Every Prepare tool through the store: transforms, scale 0 and negative scale, lay on face, auto orient, arrange, mirror, undo/redo, all 11 shapes, clone, split, filament, printable, cut (flat, tilted, one side, flipped, missing the object), boolean ×3, parts ×5 applied, chamfer, fillet, subdivide, relax, refine, remesh, variable layer height, height ranges. Each tool must change the scene, record an undo step, mark the slice dirty, and leave a plate that slices through the real `plateMeshes` mapping into valid G-code. |
| `bridge.test.ts` | `sliceNow` with a stand-in worker: success, redeploy (404), crash, engine error with its stage, unclonable data, cancel, a replaced slice, broken transforms, empty plate. Also the error reporter. |

Browser check (production build, headless Chromium):
- Slice → simulated redeploy → slice again: now succeeds. Before the fix it showed "Slicing failed: the slicer stopped unexpectedly".
- Worker file already gone: shows the reload message.
- A throwing sync or async handler: shows a toast.

## Independent review

A second pass reviewed the first commit and found four problems, all fixed with regression tests that fail on the
earlier code:
- The cut brim was rebuilt from the whole first layer, so a part with holes got a brim inside the holes, ears turned
  into a full ring, and Advanced "outer and inner" printed the inner brim twice.
- Hosts that answer a missing file with their HTML page (single-page fallback) got the memory message instead of the
  reload message.
- A failed preload was never retried.
- `AbortError` was filtered by message rather than by name.
