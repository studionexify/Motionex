# Hanex — support-free horizontal overhangs

Hanex is Nexspiro's third plugin. It prints flat (90°) and slightly rising (up to ~97°) overhangs in mid-air on a 3-axis FDM printer, with no support material. It does this with "wave" toolpaths: each new arc fuses sideways onto the previous one.

Status: **installed in Nexspiro** (Plugins → Hanex). It plans in the slicing worker, shows as the *Wave overhang* line type in Preview, and is calibrated with the prints in `CALIBRATION.md`.

![Reference layer: point-seeded wavefronts diffracting round a Ø10 hole](screenshots/reference-layer.png)

*Reference scenario (HNX-05). Colour shows print order, red is the rim and dashed lines are travels. The fronts start at a point inside the anchor (bottom), bend round the hole, and meet in a shock line behind it.*

![Hanex panel after slicing a flat-tab specimen](screenshots/panel-sliced.png)

## Pipeline (one layer)

| Step | What | Code |
| --- | --- | --- |
| 0 | Detection: `overhang = layer Z − layer Z−1`, keeping only parts wider than the trigger width; `anchor = layer Z ∩ layer Z−1` | `core/detect.ts` |
| A | Geodesic distance field, `\|∇D\| = 1/F`, solved by the Fast Marching Method over overhang ∪ anchor band; holes are impassable | `core/fmm.ts` |
| B | Wavefronts are the iso-contours of D at `kΔd` (marching squares, all levels in one pass), clipped to the printable region | `core/contour.ts`, `core/plan.ts` |
| C | Sequencing: arcs are printed in dependency order, with short gaps bridged by extruding links | `core/plan.ts` |
| D | Extrusion: sheet volume `Δd·h·flowRatio·mod(R)` per mm, plus fan and feedrate | `core/plan.ts`, `core/gcode.ts` |

## The maths

- **Wave spacing:** `Δd = w·(1 − overlap)`.
- **Nozzle-land bound:** the land must still press on the previous arc. Its far edge sits at `Δd + w/2` from the nozzle axis, and that must be within `tip/2`, so `Δd ≤ (tip − w)/2`.
  - With a 1.0 mm land and a 0.45 mm bead, overlap must be at least 39%.
  - `validateProfile` enforces this.
- **Distance field:**
  - Solver: FMM with a second-order upwind stencil.
  - Seeding: exact Euclidean distance in a tube of 6 grid steps around each seed.
  - Grid step: `h = min(Δd/3, w/4)`.
  - Measured errors (`tests/hanex/fmm.test.ts`):
    - straight front: exact (< 1e-9 mm);
    - point source at h = 0.1 mm: < 10 µm out to 20 mm away;
    - error converges as h shrinks;
    - behind a circular obstacle: within 4h of the exact taut-string geodesic (tangent + arc + tangent).
- **Diffraction:** nodes inside holes are outside the domain, so they have F = 0. D is therefore the geodesic distance, and the fronts wrap round holes instead of jumping across them.
- **Clipping:** arcs are clipped to `(overhang ∪ lead-in band) ⊖ w/2`, so no bead centre comes within half a bead of a hole or a free edge.
- **Anchor clamping:**
  - An arc whose ends reach the solid keeps exactly `leadIn` mm of arc length on the anchor at each end.
  - Arcs that lie entirely on solid are dropped, because the normal slicer already prints there.
- **Sequencing:**
  - Each piece of front `k` depends on the pieces of front `k−1` within `1.5Δd` of it.
  - Among the ready pieces, the nearest is printed next.
  - So one side of a hole is swept for many levels, and the pieces behind the hole wait until both sides arrive.
  - On the reference case this cuts travels from 138 (strict level order) to 12.
  - Gaps up to 3w are printed as extruding links.
- **Extrusion:**
  - Volume per mm is `Δd·h`, so beads at spacing Δd fill the sheet exactly.
  - Curvature modulation: `mod = clamp(R/R_nom, flowFloor, 1)`, with R the circumradius over a ±w chord.
  - The floor (default 0.6) stops tight turns from starving the bead.
- **Rising faces:**
  - φ is the angle between wall and underside: 90° is a flat ceiling; 95° means the underside rises 5° away from the wall.
  - Each layer then adds a free band `b = h / tan(φ − 90°)`: 2.29 mm at 95° with 0.2 mm layers.
  - Hanex waves each band onto the previous layer's sheet. Detection handles this automatically.
  - Above `maxWaveFaceAngle()` the band is narrow enough for a normal overhang.

## Works on any model

- Hanex needs only the cross-sections of layer Z and layer Z−1, as Clipper paths: `planLayer(current, below, profile)`.
- That is the same data the slicer already has for every object, so imported meshes need no special handling.
- What it handles:
  - multiple overhang components per layer;
  - islands inside the overhang, which act as extra anchors;
  - holes, which act as obstacles.
- Floating islands with nothing solid next to them are reported, not printed.

## Limits

- **Clamping at both ends is only possible where the front still reaches the anchor.**
  - Once an arc is wider than the overhang, its ends land on free edges.
  - There they are tied by the rim, which is printed last along every free edge, not by the anchor.
- **Edge seeding** (straight fronts from the whole anchor edge) has no hoop effect and no end clamping.
  - It is kept as an option for HNX-06 to compare against.
- **Speed function F(x, y)** is supported by the solver (`PlanOptions.speed`) but is not exposed in profiles yet.

## Inside Nexspiro

- **Engine** (`src/plugins/hanex/engine.ts`, runs first in `ENGINE_PLUGINS`):
  - `prepare` runs detection and planning on every layer of every object, using the slicer's own cross-sections.
  - `postToolpath` turns Nexspiro's extrusion inside each wave region into travel; this removes the bridge infill and overhang walls there.
  - It then appends the waves after the rest of the layer, under the `wave_overhang` feature, with the Hanex fan and retraction/z-hop.
  - It leaves the extruder in the retraction state the next layer expects.
  - Wave moves are `fixed`, so cooling slowdown never changes their calibrated speed.
- **Machine values** come from the printer and filament profiles: nozzle diameter, filament diameter, retraction, z-hop and travel speed. Line width scales with the fitted nozzle.
- **Print head:**
  - The flat land diameter of the nozzle tip comes from the print-head profile Nexspiro keeps per printer, shared with Motionex.
  - It sets the minimum overlap, the widest ledge left to normal printing, and the face-angle limit `90° + atan(h / max(2w, land))`. That limit is about 101° for a 1.0 mm land at 0.2 mm layers.
  - The panel can cap it lower.
- **Panel** (`ui/HanexPanel.tsx`): material preset, wave settings, print head and face-angle limit, specimens you can add to the plate (flat tab, rising face 92.5–100°), and an after-slice report with a per-layer table.
- **Supports:** Hanex publishes its wave regions through the new `PluginSession.supportBlockersAt(layer)` hook, so support never starts under them. Supports elsewhere on the model work as usual.
- **Past the face-angle limit:**
  - A rising underside steeper than the print head's limit leaves a band per layer narrower than the trigger width.
  - When that band is still at least a bead wide, Hanex lists the layers in its report and shows a warning, but the slice continues.
  - Those layers print normally.

## Files

- `src/plugins/hanex/core/*` — engine.
- `tests/hanex/*` — 45 tests, including slicing a real T-shaped part with the plugin.
- `docs/hanex/CALIBRATION.md` — printer calibration procedure.
