# Motionex weave mode

Weaves a picture into the wall of a part, the way jacquard-style woven vases are printed.

## How it works

- **Colour weave:** every layer is printed in one filament, and the colours take turns (A, B, A, B… or A, B, C…). On each layer the line is pushed out where the picture shows that layer's colour, and pulled in where it doesn't. Seen from outside, every pixel shows the colour whose layers stand proud.
- **Mono relief:** one filament, no filament changes.
  - *Dark = woven texture*: dark pixels get an in/out texture, light ones a smooth wall.
  - *Light out, dark in*: light pixels stand out and dark ones are recessed.
- **Rows:** one picture row is one turn of the colours (2 layers for two colours at 1 layer per colour). With *Measure rows along the curve*, rows are spaced along the wall's profile, so bellies and flares don't stretch the picture.
- **Columns:** columns are placed by distance round each loop from a fixed direction (+X), so pixels stack straight whatever the seam does. *Twist* drifts the picture by a fraction of a column per row.

## Texture (wave)

The card is laid out in three steps: **1 · Colours and picture**, **2 · Texture**, **3 · Where**. Pick *None (plain wall)* as the picture to use the texture alone (a single-filament knitted lamp shade, or plain colour stripes in colour weave).

- **Ready-made textures**:
  - *Smooth*: no texture.
  - *Knit*: sine, swaps every layer, 0.15 mm high, 2 mm stitch.
  - *Chunky knit*: 0.2 mm high, 4 mm stitch.
  - *Ribs*: the waves stack straight up.
  - *Twill*: slides a quarter stitch per layer, so the stitches run diagonally.
  - *Zigzag*: pointed stitches.
  - *Basket*: square stitches that swap every 2 layers.
- **Wave height**: how far the line swings either side of the wall.
- **Stitch size**: the length of one swing out and back along the wall.
- **Next layer**: what the next layer does.
  - *Swaps every 1–8 layers*: the wave flips round, so crest sits over trough.
  - *Slides along*: a diagonal.
  - *Stays put*: ribs.
- **Shape**: Smooth, Pointed, Square or Rounded.
- **Keep ribs and sharp edges smooth** (on by default): the wave fades out on thin fins, which it finds from the gap to the facing wall. It also fades out on corners that turn over 30° more than the loop's own roundness.
- **Seen from above**: the strip draws the line seen from above, with the next layers over it in the colours they print.

### The maths

- **Offset:** the offset at fraction u round a loop on layer k is `A · shape(N·u + phase(k)/360)`.
- **Stitch count:** N is a whole number of stitches fitted to the loop, so the line closes on itself at the seam. N is kept from layer to layer while the stitch stays within ±25% of its length, so the stitches stack straight.
- **Phase:** phase(k) comes from the same layer effects as the Motion brushes (`effectPhase`).
- **Added after easing:** the wave is added after the picture is eased, so short stitches keep their full height.
- **Small loops:** on a neck or a tip, the wave takes at most 0.3 of the loop's inner radius. It also stays under *Largest move from the wall*.
- **Plastic:** the amount per mm stays the same along the longer waved line.
- **Corners:** pointed and square stitches slow into their turns within the printer's acceleration.
- **Warnings:** the panel and the slice report warn when neighbouring layers swing further apart than the line width (they only touch where the waves cross). They also warn when a stitch is too short for the printer to stream at the outer-wall speed.

## Zones (where the texture goes)

- **Whole part**: the texture between *From* and *To*. It fades in over the soft edge, and can go on every object or only the selected ones.
- **+ Add zone**: adds a zone to the selected object (or the first one) and selects it, so the move, rotate and scale handles appear. A zone is either a *Height band* (a start and an end height) or a shape: *Box*, *Cylinder*, *Sphere* (scale it for an oval "eye"), *Cone*, *Disc* or *Ring*.
  - A shape zone is an ordinary modifier part. It carries only the wave settings, so infill and walls are untouched.
  - Shape zones show in teal (*wave here*) or slate (*keep plain*). Height bands show as translucent slabs.
- **Each zone has these settings:**
  - *Wave here* / *Keep plain*.
  - *Same as whole part* / *Own texture*: the same texture controls.
  - *Soft edge*.
- **Soft edge:** the wave fades in and out over at least one stitch.
  - **Along the line:** it is a smoothstep of the distance along the line to the zone's edge.
  - **From layer to layer:** the zone outlines of nearby layers are blended, so the wave eases out over the top and bottom of a shape instead of stopping on one layer.
  - **Result:** the straight wall and the wave meet without a step or a kink.
- **Overlaps:** zones apply in list order. An object's height bands come first, then its shapes; later ones win where they overlap.
- **Editing elsewhere:** selecting a zone in the 3D view or the object list shows the same settings in the print settings column.

## Preview

- **Default**: the sliced preview opens in **Real colours**, with every line in its filament colour. The choice is remembered.
- **Wave area**: the part goes grey and the waved wall shows in teal. The legend gives the share of the outer wall that is waved.
- **Other views**: Line type, Speed, Flow and the rest are under **Advanced…**. The line-type list folds away under *Line types*.
- **Quick preview**: the Weave card has the same Real colours / Wave area switch for the quick preview, before slicing.

## Moving the path by hand

*Move the path by hand* (in the Weave card) lets you pick pixels of any motif or imported picture and push their toolpath out of the wall or pull it in, from −cap to +cap mm. Pick with the brush, a box, a whole patch of one colour, or all; shift adds to the pick. Every layer of a picked pixel moves together, so the stack shifts as one. The 3D view shows the moved threads at once. Moves belong to the picture's grid size: if the picture is resized they are ignored until cleared.

*Stand out* now goes up to 3 mm and *Largest move from the wall* (default 3 mm) caps the total deviation (depth, pull-in and hand moves together). High values hang the thread in the air: see [THREADS.md](THREADS.md) for the thick-thread view and the drool check that shows where it will sag or drip.

## Seam

- *Seam inside the wall*: each layer starts with a lead-in from inside the wall and ends with a tail going inside. The slicer's wipe is turned inward too, and the travel arrives at the inside start point, not on the outer surface. The start blob and end string sit on the inside.
- *Seam line*: every layer starts on this line (degrees from +X).

## Filament change

| Mode | What happens |
| --- | --- |
| Full purge | The flush from the flushing-volume matrix, as usual. |
| Small purge | A flush of the chosen volume (mm³) for each weave change. |
| Bleed (no purge) | Flush length 0 and no prime-tower band: the new colour prints straight away, and the old colour left in the nozzle bleeds into the start of the layer. *Set up print settings* also turns the prime tower off. |

The panel estimates the number of changes, the extra time (the printer's `filament_change_time` plus flush time) and the purged grams before you slice.

## Per printer

The card reads how the printer changes filament (Printer settings → Multi-material) and words its advice for it:

| Printer | Colours | At each change |
| --- | --- | --- |
| Bambu AMS (A1, P1, X1, H2D) | One per slot (4 per unit) | Cut, unload, load (`filament_change_time`, 60–95 s) and flush out through the purge chute: nothing on the plate. *Small purge* or *Bleed* cut waste and time. |
| Prusa MMU3, Creality CFS, Anycubic ACE, ERCF / BoxTurtle | One per slot (MMU3 5, others 4; set *Filament slots*) | Unload and load, then purge into the chute when the unit has one (*Purge into*), else into a prime tower beside the part: leave room on the plate. *Bleed* needs no tower. |
| Tool changers and IDEX (Prusa XL, Snapmaker U1, Klipper changers) | One per head | A head swap of a few seconds with a small prime and no purge; prime tower optional. |
| Manual (single nozzle, M600 / PAUSE) | — | Every change stops the print for a spool swap. The card turns on in *Mono relief* on these printers and offers *Switch to Mono relief*. |

- The estimate uses the printer's `filament_change_time` (60 s if unset, 8 s for a tool changer) plus the flush.
- **Marlin vs Klipper:** no difference for the weave; the change G-code comes from the printer profile (M600 on Marlin, the unit's macros on Klipper).
- **Nozzle size:** *Stand out* is a share of the line: the slice report flags steps over 60% of the line width. Bigger nozzles take deeper relief and bigger pixels (pixel width ≥ 3 line widths reads best).

## Print settings

*Set up print settings* sets the following, giving one woven skin over a solid floor:
- 1 wall, 0% infill, no top shell, 4 bottom layers;
- spiral vase off, aligned seam, no scarf seam, outer wall at 80 mm/s;
- no prime tower when bleeding.

Use a solid body (Plantex *Weave* presets, or any closed vase model).

## Calibration

*Add calibration ring* places a Ø50 × 22 mm ring. It weaves a checker as a depth ladder: 5 bands from 0.5× to 1.5× of the chosen depth, from the bottom up. Pick the band that looks best and set that depth.

## Code

- `src/plugins/motionex/weave/model.ts`: settings.
- `src/plugins/motionex/weave/core.ts`: the layer plan and per-point offset, plus `weaveLoop`, which offsets a loop and starts it at the seam.
- `src/plugins/motionex/weave/engine.ts`: per-layer filament regions, purge per change, and the move-list pass with the inward seam.
- `src/plugins/motionex/weave/image.ts`, `motifs.ts`: turning pictures into the colour grid (nearest colour, dithering, grey levels), and the built-in motifs.
- `src/plugins/motionex/weave/plan.ts`, `preview.ts`: the estimate, print settings and quick preview.
- `src/plugins/motionex/weave/wave.ts`: the wave texture. It covers presets → layer effect, the stitch count kept round the loop, zone soft edges along the line and between layers, smooth ribs and edges, and the tip cap.
- `src/plugins/motionex/weave/zones.ts`: wave zones collected from modifier parts and height ranges (`WAVE_KEYS` in `profiles/settings.ts`), sliced once per layer plane.
- `src/plugins/motionex/ui/WeavePanel.tsx`: the panel. `WaveControls.tsx`: the texture controls, the strip and the zone editor. `PathTool.tsx`: pick-and-move tool. `DroolCheck.tsx`: the reach / sag / drip card.
- `src/viewport/toolpaths.ts`, `src/ui/PreviewOverlays.tsx`: the *Wave area* view, from `SliceOutput.moveWave` (wave strength per move).
- Tests: `tests/motionex/weave.test.ts`, `tests/motionex/wave.test.ts`.
