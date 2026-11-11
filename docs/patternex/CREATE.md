# Patternex · Create, relief and effects

Artwork beyond the pattern library. Everything below becomes an ordinary pattern: preview it, then click the model to place it.

## Finish: works on both printer types
- **Ink**: an AMS colour change (or a manual swap on single-colour printers).
- **Raised / Recessed**: geometry. The cross-section is grown out or cut in by the height under the artwork, before walls, so there is no colour change.
  - Default on single-colour printers.
  - Raised plus ink: the ink fills the whole bump.
  - Flat top faces can only be recessed, since raising needs layers above the model (a warning says so).

## Create tools
- **Text**
  - Bundled fonts: Inter, Oswald, Allerta Stencil, Pacifico (OFL) and Roboto Mono (Apache 2.0). You can add your own TTF, OTF or WOFF; fonts used by text artwork are embedded in the project file (per object, base64), so text can be edited and batched on any machine.
  - Settings: size, tracking, kerning, line height, alignment, arc (keeps arc length) and weight.
  - Wrap round object puts the text on a cylinder.
  - Minimum-stroke check: parts thinner than 2 × nozzle are flagged, using a morphological opening.
- **Batch**
  - Fields: `{name}` and any CSV column, `{serial:4}` (zero-padded counter), `{date}`, `{lot}`.
  - Makes one copy of the object per row, with the text, code or Braille regenerated for that row.
- **QR / Data Matrix / Code 128 / Code 39 / EAN-13** (bwip-js)
  - Module size comes from the width and must be ≥ max(0.8 mm, 2 × nozzle).
  - Quiet zone and invert options.
- **Braille**
  - Grade 1, with capital and number signs.
  - ADA 703.3 sizes: dot Ø1.55 mm, 0.75 mm high, 2.4 mm dot pitch, 6.4 mm cell pitch, 10.1 mm line pitch.
  - Always raised.
- **Logo / image**
  - SVG clean-up: merges colours within ΔE, Douglas–Peucker simplification, speck removal.
  - PNG/JPG trace: 1–4 colours by k-means in Lab, optionally snapped to the loaded filaments. The background stays base.
  - **Brand kit**: saves logos with their inks and relief.
- **Gradient**: two-ink ordered (Bayer 8×8) dither, AMS only.
- **Repeat**: grid or brick layout, gaps, seeded jitter (offset and rotation), and a seamless wrap that makes period × count equal the circumference exactly.
- **Brush**: paint strokes straight onto a face. They become an inkable region.

## Placement
- Shift + drag rotates, Alt + drag scales, using the ring handle on the selected placement.
- The surface-angle filter keeps the artwork off faces turned more than N° from the projection.

## Region effects (per colour group)
- Relief: raised or recessed, with a height.
- Speed factor, fuzzy skin on the outer wall, and the infill density and pattern behind the region.
- Transparency: solid infill behind the region and at most 0.6× speed, for translucent filament.
- Mix with a second slot: alternate layers (both printer types) or alternate lines (AMS, 1-line stripes offset each layer). The share is spread exactly (Bresenham).

## Colour and purge
- **Bleed calibration wizard**
  1. Add a test bar: five bands with no purge.
  2. Measure the mixed length on the outer wall.
  3. The volume is length × line width × layer height. It is saved for that slot and clears "uncalibrated".
- **Purge into infill or a sacrificial object** (AMS): the tower purge shrinks by 90% of what the new filament can print there.
  - Those moves are reordered to come straight after the change, with retraction kept balanced.
  - The report shows the mm³ absorbed.
- **Band merging** (single colour, band mode): base gaps shorter than N layers between bands of the same ink are printed in that ink. Each merge saves two swaps. Ink bands are never dropped.

## Not included
- Wall count per region: the slicer has no per-region wall hook, only modifier infill keys.
- Raised artwork on flat top faces.
