# Thick-thread toolpath view and drool check

The *Toolpath view* in Prepare draws the walls the plugins change without slicing. By default it now draws **real threads**: every move is a bead at the printer's outer-wall line width and the layer height, so layers touch with no gap, in-and-out moves show as real bulges, and plastic amount (extrusion multiplier) makes the thread fatter or thinner. Turn **Thick thread** off (bottom-left of the 3D view) for single lines.

## Drool check (worked out ahead of slicing)

For every bead the view measures how far it sits from the nearest thread of the layer below (divided by the layers a thinned preview skips), as a share of the line width:

| Reach | What the view shows |
| --- | --- |
| up to 0.5 × line width | held up, nothing special |
| 0.5 – 1.0 ×  | the thread starts to sag (up to a third of a layer) |
| 1.0 – 1.6 × | clear droop, thinner thread |
| past 1.6 × | the thread slumps by a layer or more and **hot drips** hang below it (teardrops, tinted hot orange) |

Long travels (> 2.5 mm) between prints leave a thin sagging **string** in the preview; add a pull-back (retract) to the motion to avoid it. The Motionex panel shows a *Drool check* card (furthest reach, sagging threads, drips, strings) and the status chip under the 3D view turns orange when threads drool. The thresholds follow the slicer's own weave rule (steps over 60% of the line width warn).

## Code

- `src/plugins/threads.ts`: `ThreadBuilder` (beads, reach check, drips, strings), merge and lines-to-beads helpers.
- `src/viewport/threads.ts`: `ThreadMesh`, one instanced mesh of beads plus the merged drip mesh.
- `src/plugins/motionex/preview.ts`, `weave/preview.ts` (`buildWeaveThreads`): the plugins that feed it. Other previews are turned into plain beads.
- `src/plugins/droolState.ts`: the latest check, for the panel and the chip.
- Tests: `tests/motionex/threads.test.ts`.

## Plugin settings bar

A click on a plugin on the left rail opens its settings bar beside the print settings: it never jumps to another tab. Plugins with a big editor (Motionex *Motion Studio*, Lumonex, Clickex, Flenex) have an *Open Studio* button in the bar. While a bar is open, *Hide print settings* folds the print settings column into a slim strip.
