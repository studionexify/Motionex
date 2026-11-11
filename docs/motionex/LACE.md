# Motionex lace walls

Cuts openwork holes into the walls with the toolpath itself: where the lace is open, the nozzle stops extruding, retracts, travels across and starts again on the far side. A single- or double-wall vase becomes a lattice, gothic tracery or your own picture in negative. Works on any FDM printer; no support.

## Printability rule

Every hole is checked layer by layer, from the bottom up:
- Plastic may only be laid over plastic within the overhang reach of the layer below (layer height × tan(*Steepest hole top*)), or across a gap below that is no longer than *Longest flat bridge*.
- Where the pattern wants a flat roof over a wide hole, the hole is drawn on upwards, closing in a point at the overhang angle. The report says how much of the wall this opened.
- Strands shorter than *Shortest strand* are left out (they would print as blobs); holes narrower than *Narrowest hole* are filled (ooze would close them anyway).

The test suite checks the G-code itself: every printed outer wall point of the lace sits on plastic within the reach, or bridges a short anchored gap.

## Patterns

| Pattern | Shape |
| --- | --- |
| Diamond lattice | Diamonds on a centred lattice: unbroken diagonal strands (trellis). |
| Gothic arches | Pointed arch windows, round bottoms. |
| Teardrops | Round holes with pointed tops. |
| Honeycomb | Upright hexagons, points up. |
| Almonds | Vesica (lens) holes, pointed top and bottom. |
| Slots | Tall narrow pointed slots in brick rows. |
| Waves | Wavy slots. |
| Voronoi | Organic cells; tops drawn into points by the rule. *New Voronoi cells* reseeds. |
| Picture | Dark pixels open (or light, with *Light = open*). |

- *Cell width / height* set the grid (cells keep their count round the part, so they widen on bellies).
- *Strand* is the lace left between holes; *Hole size* scales holes in their cells.
- *Grade* grows or shrinks the holes up the band; *Twist* turns the pattern round the part over the band.

## Walls and band

- *Every wall*: holes go right through. *Outer wall only*: the inner wall stays whole behind the holes (a watertight relief lace).
- The band starts at *From* (a solid floor and foot below) and stops a *Solid rim* below the top.

## Print settings

*Set up print settings*: 2 walls (1 for outer-only), 0% infill, no top shell, 4 bottom layers, spiral vase off, aligned seam, no Z hop, no wipe. Use a closed vase body (Plantex shapes) or any solid model.

## Retractions

Each hole is a retraction per wall per layer. The report counts them; above ~120 per layer, use bigger cells or turn *Retract across holes* off for tiny holes.

## Per printer

The card checks the lace against the printer and nozzle before you slice:

- **Strand vs line width:** the strand is shown in line widths of the current nozzle. Under 2 line widths (0.84 mm on a 0.4 nozzle, 1.26 mm on 0.6, 2.1 mm on 1.0) a strand is a single thread and snaps; the card flags it. Small nozzles (0.2–0.25) allow fine lace with 0.5 mm strands and small holes; big nozzles want bigger cells and strands.
- **Retractions per layer:** estimated as cells round the part (circumference ÷ cell width) × walls with holes, before slicing. The report gives the real count after slicing.
- **Bowden extruders** (retraction length 2 mm or more, e.g. Ender-3, Neptune 3, Kobra 2): each hole is a long, slow retraction and the filament can grind after a few thousand. The card suggests a cell width that keeps it to about 60 crossings per layer, and a one-click *Retraction off* (PLA hardly strings over short gaps). Direct drive (Bambu, Prusa MK4S, Klipper CoreXY) is fine up to ~120 per layer.
- **Marlin vs Klipper:** no difference for lace; travel speed and retraction come from the printer profile.
- **Filament units and tool changers:** lace is one filament; it works the same on every printer.
