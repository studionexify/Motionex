# Flenex

Flenex makes **print-in-place flexi** models: animals and characters that print in one piece and move once
they are off the bed. It is a NexSpiro plugin like Lumonex and Plantex: install it from **Plugins**, open
the **Flenex** tab in the right dock and press **Open Flenex Studio**.

## What it does

| Step | What you do |
| --- | --- |
| **Pick the machine** | Flenex uses the printer selected in NexSpiro and shows a picker in the Studio header. Joint clearance follows the nozzle (0.4 mm → 0.30 mm around moving parts, 0.48 mm between pieces; 0.2 mm and 0.6 mm nozzles get tighter / looser fits). The model is drawn on that printer's bed and checked against it (it can turn on the bed, and "Scale to fit" resizes it). Colours: AMS printers carry up to 16, others pause for manual swaps. |
| **Design** | *Designs*: 46 presets in 8 families. *Body*: length, thickness, height, spine (10 shapes), 9 thickness handles + silhouette presets, cross-section (8 shapes), flat belly, surface relief (11 patterns), end rounding. *Add-ons*: 24 kinds (eyes, horns, ears, spikes, sail, fins, tail fin, legs, wings, arms / tentacles, snout, jaw, beak, cheeks, nostrils, plates, knobs, frill, gills, mane, shell, club, tail spike, antennae), each with position, size, length, width, count, spread, tilt, curl. The same patterns make any number of new designs. |
| **Import** | Import STL / OBJ / 3MF, turn it (±90° about X, Y, Z), scale it, then **place cuts**: pick the joint type and the direction (along the limb automatically, straight into the surface, across X / Y / Z) and click the model. Or add 4 / 8 evenly spaced cuts across an axis. Each cut can be slid, tilted, given a hinge direction, a disc radius and its own joint settings. |
| **Cuts on a design** | Automatic: spacing follows the thickness (best look), a fixed count, or a fixed length; start / end along the body; one joint type for all. Parts stuck on the body (legs, wings, fins, shell, head parts) stay on one piece and the cuts go around them; spikes, sails, plates and manes are cut with the body; tentacles get their own joints. *Edit the cuts by hand* turns the automatic cuts into a list you can move, tilt or delete. |
| **Paint** | Palette of up to 16 colours. Brush, fill area, fill piece, fill everything, undo, and one-click schemes (back + sides + eyes, alternate pieces, rainbow along the body, fade head → tail, stripes). Paint is stored as operations and replayed, so it follows the model when the design changes. |
| **Print** | *Export coloured 3MF* or *Send to the plate*: the flexi is placed on the active plate as one object, painted with filament slots (new slots are added for new colours), and Prepare opens. |

## Placing cuts

* **Square to the body.** Press on the model, slide, release (the tool then goes back to orbit, so choose *Place a cut* again for the next one): the cut plane follows the cursor and turns to stay perpendicular to the body, even on a wavy snake. Two ways to find the body's direction, switchable in the *Cut direction* menu: **follow the centre line** (default: the centre of the section is found around the cursor and a step either way, and the plane is turned square to the line between them) or **local direction** (the direction of the surface right around the cursor). *Straight into the surface* and *across X / Y / Z* are still there for fixed planes.
* **Cuts per body part.** *Add a part* (click both ends of a limb, a tail, a tentacle) or *Whole model as one part* (walks the body's centre line from one end to the other, ignoring legs and wings), then set **how many cuts** the part gets with the + / − buttons. Spacing is even or follows the thickness; the start and end of the cut range can be moved. Single cuts can be moved, turned, deleted, given another cut type, duplicated or flipped; those edits are kept when the count changes, and *Re-space all* forgets them. Designs from the catalogue have the same: cuts on the body and cuts on each arm.
* **Change a cut afterwards.** Select it in the list: change its type, size, range of motion, depth, hinge direction, clearance and disc radius; slide it along the body, tilt it, square it to the body again, flip A and B, drag it on the model with *Drag on the model*, disable it or delete it.

## Cut types

The picker shows a real cutaway of each cut (built on a small rod with the same code that builds your flexi), with every piece in its own colour.

| Type | What it is | Moves? |
| --- | --- | --- |
| Ball & socket | ball on a neck in a socket | every direction |
| Hinge | tongue on a pin in a swept slot; round, hex or teardrop pin | one axis |
| Universal (double hinge) | two hinges at right angles with a floating block (three pieces) | every direction, firmer |
| Swivel | bicone head in a matching cavity | twists |
| Chain link | two interlocked rings on short posts; needs almost no length | every direction |
| Dowel pin | round or hex pin in a close-fit hole | assembly |
| Snap pin | barbed pin that clicks in | assembly |
| Dovetail slide | tongue in a groove that runs through the piece | assembly |
| Plain cut | a gap and nothing else (detachable head, wing) | separation |

## The joints

Every joint is built from real geometry around a cut plane, with the **machine clearance** between the moving
part and its cavity. A kerf slab separates the two pieces and widens with the range of motion.

* **Ball & socket**: a ball on a neck in a socket whose opening is narrower than the ball. Moves in every direction.
* **Hinge**: a tongue on a pin in a slot. The slot is the exact volume the tongue sweeps through over the range of motion, plus the clearance. Optional pin shapes: round, hexagon, teardrop (prints sideways without supports). The hinge direction can alternate along a body.
* **Swivel**: a bicone head in a matching cavity; twists around the spine with a little tilt.

Sizes come from the section at the cut (rays are shot from the joint centre to find the thinnest wall, the widest reach and
the depth either side), so thin parts get smaller joints and a thin section is reported instead of producing a broken joint.
The geometry kernel is [manifold-3d](https://github.com/elalish/manifold) (WebAssembly), so every boolean result is a watertight solid.

## Checks

The tests (`npm test -- tests/flenex`) do more than build the shapes:

* each joint is built in rods of two thicknesses, must give exactly two closed pieces, keep at least the machine clearance between them, and then **A is turned about the joint's pivot through its full range of motion** (several axes, both directions) with the intersection of the two pieces required to be empty;
* every one of the 46 presets must build a closed solid on the bed and cut into a closed flexi;
* the coloured 3MF is checked for structure and filament colours; painting, placement and bed fit have their own tests;
* a flexi is sliced with NexSpiro's engine and must give layers, walls and G-code.

## Coloured 3MF

Every triangle carries its colour three ways so the file opens coloured in other slicers: the 3MF core materials
(`basematerials` + `pid` / `p1`), the Bambu / Orca `paint_color` extruder code, and `filament_colour` in
`Metadata/project_settings.config`. The model rests on z = 0, centred on the printer's bed.

## Limits worth knowing

* The joints are verified geometrically (clearance and swept motion), **not yet by test prints**. Treat the first print on a new printer as a calibration: if joints fuse, raise the clearance in *Print → Machine*; if they rattle, lower it.
* Add-ons that are not cut with the body (legs, wings, fins) must sit on a single piece, so a design with many of them has fewer joints.
* Imported meshes must be closed solids; open meshes are healed when possible and otherwise reported.
* Painting resolution follows the model's triangles; coarse imported meshes paint in large facets.
* Building runs in a Web Worker (a few hundred ms for a design, 1–2 s with many cuts); a newer edit cancels the running build.
* The universal joint needs a thick part (a body of about Ø20 mm or more). On a thinner section, and for chain links too thin to print, the cut is built as a **ball & socket** instead; the cut list says "→ ball (too thin)" and the check panel explains why.

## Screenshots

See `screenshots/`: the design tab, painted colours, the pieces view, cuts edited by hand, machine awareness (a smaller bed, a printer without an AMS), an imported model with placed cuts, universal joints, the cut-type picker, a cut following a wavy body, a part with its own cut count, and two contact sheets of the catalogue.
