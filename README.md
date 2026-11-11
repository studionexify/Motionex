<p align="center">
  <img src="public/logo-dark.svg" width="96" alt="NexSpiro logo" />
</p>

<h1 align="center">Motionex</h1>
<p align="center">Standalone motion G-code generator, built on the NexSpiro slicer. A 3D-printing slicer for Bambu Lab, Creality, Elegoo and more — runs locally as a desktop app, or in any browser.</p>

---

## Motionex workbench

Motionex opens on the **workbench**:

| Area | What it does |
| --- | --- |
| **Left — Motions library** | Every built-in motion (waves, teeth, loops, knits, spirographs…), grouped and searchable, with a shape thumbnail. Click one to apply it. |
| **Centre — working screen** | Live toolpath preview of the generated G-code: orbit (drag), pan (right/Shift-drag), zoom (wheel/pinch), 3D/Top/Front views, colour by feature/speed/height/flow, travel moves, layer slider, time/filament/layers stats. |
| **Right — Settings** | Shape (cylinder, polygon, twisted polygon, cone, vase), motion size/spacing/phase/layer stacking/start/fade, print (layers, line width, bottom layers, inner walls, spiral vase, speeds) and machine (bed, temps, fan, retraction, start/end G-code). Download or copy the G-code. |

The generator (`src/workbench/generator.ts`) writes G-code directly from the parameters — no model or slicing step — using the same motion curves as the Motionex plugin. The full NexSpiro slicer (Prepare / Preview / Device) is still available from the mode tabs and the View menu.

## Features

### Phase 1 — core slicer
| Area | Features |
| --- | --- |
| **Import** | STL (binary + ASCII), OBJ, 3MF (multi-object, components & transforms). Drag-and-drop or File → Import. |
| **Prepare** | Build plate sized to the printer (10/50 mm grid, origin axes, excluded zones), move / rotate / scale gizmos with numeric panels, lay on face, auto-orient, auto-arrange, duplicate, delete, undo/redo, overhang highlight, out-of-bounds warning. Right-click menus on the plate, objects and parts (add model or shape, paste, arrange, clone, fill bed, mirror, split, filament, printable, add parts and modifiers, export STL). |
| **Printers** | Bambu Lab A1, A1 mini, P1S, P1P, X1 Carbon, X1E · Creality Ender-3 V3 KE · Elegoo Neptune 4 Max. Editable retraction and start/end/layer G-code. |
| **Filaments** | PLA, PLA Matte, PETG, ABS, ASA, TPU with per-plate bed temperatures, cooling and max volumetric speed. |
| **Process** | 0.08–0.28 mm presets; Quality / Strength / Speed / Support / Others tabs; modified values in amber with one-click reset; search (Ctrl+F); hover tooltips with internal keys. |
| **Slicing engine** | Mesh slicing with topological loop chaining, XY hole/contour + elephant-foot compensation, classic perimeters, top/bottom/solid/sparse/bridge classification, infill patterns (grid, gyroid, rectilinear, aligned, triangles, concentric), monotonic top skins, ironing, overhang-wall detection, skirt & brim, spiral vase, fuzzy skin, seam placement, cooling slowdown, volumetric-speed limiting, retraction + Z-hop, object labelling (Klipper `EXCLUDE_OBJECT`, `M486`). |
| **Preview** | GPU-instanced toolpaths; colour by line type, filament, speed, layer height, line width, flow or layer time; per-feature visibility; layer and move sliders; time / filament / cost summary. |

### Phase 2 — advanced preparation
| Area | Features |
| --- | --- |
| **Multi-material** | Up to 16 filament slots, filament per object, colour painting (brush, palette, keys 1–9), automatic filament changes with the AMS sequence (`M620`/`T`/`M621` + flush) or `M600` pauses on manual printers, prime tower sized from the prime volume, per-filament weight & cost, change-time estimate. |
| **Painting** | Support enforcer/blocker painting (with "on overhangs only"), seam enforcer/blocker painting, colour painting. Left drag = enforce/paint, right drag = block/reset, Shift = erase, middle drag = orbit. |
| **Supports** | Normal and tree supports, auto or manual (painted areas / enforcer volumes only), support filament choice, blockers. |
| **Parts** | Negative volumes (cut-outs), infill modifiers, support enforcer and blocker volumes — box, cylinder or sphere, positioned with the same gizmos. |
| **Per-object settings** | Objects tab with the plate/object/part tree; override walls, shells, infill, seam, ironing and fuzzy skin per object. |
| **Variable layer height** | Adaptive profile from surface slope (quality ↔ speed), Gaussian smoothing, fixed-height ranges, profile chart. |
| **Multi-plate** | Add / delete / switch plates, move objects between plates, slice the active plate. |
| **Layer actions** | Pause, filament change or custom G-code at any layer from the Preview slider. |

### Phase 3 — devices, project & calibration
| Area | Features |
| --- | --- |
| **Devices** | LAN access code for A1/P1/X1/H2 (MQTT/TLS status & control, FTPS upload, A1/P1 camera, AMS & HMS), Klipper/Moonraker, OctoPrint/PrusaLink, USB serial (Marlin host with checksums & resend). Saved printers (access codes encrypted on desktop), live temps, job control, jog, console, file manager. LAN access-code connections need the desktop app. |
| **Print** | *Print plate* dialog: slice → `.gcode.3mf` (A1/P1/X1/H2, with thumbnail, MD5, slice info, AMS mapping) or G-code with embedded thumbnails → upload → start. |
| **Project** | Save/open `.3mf` projects (whole scene, settings, paint, parts, plates) readable by other slicers; title, designer, licence, notes, photos, bill of materials. |
| **Calibration** | Temperature tower, pressure advance, flow (coarse/fine), max volumetric speed, retraction — results saved per filament slot and used when slicing. |
| **Engine** | Arachne-style variable-width walls, G2/G3 arc fitting, per-layer setting changes. |

### Phase 4 — catalogue & tools
| Area | Features |
| --- | --- |
| **Printers** | 44 profiles: all current Bambu Lab (incl. H2D single-nozzle), Creality K1/K2/Ender-3 V3 family, Elegoo Neptune 3/4 & Centauri, Prusa MK3S+/MK4S/MINI+/CORE One/XL, Anycubic Kobra, Voron, Qidi, Sovol, Artillery, generic Marlin/Klipper. |
| **Tools** | Cut (tilted plane, capped), Mesh boolean (union/difference/intersection), Text (object/emboss/engrave), Measure, Flushing-volume matrix. |
| **Motionex plugin** | Wall patterns from a library, placed by click, paint, lasso, box, height band, whole object or whole plate. Instant pattern preview on the model in Prepare (patterned walls only, no slicing). Pattern tab: change a placed pattern's wave shape, depth, spacing, layer lead/lag, stacking and advanced curves with live close-ups and the model redrawn as you edit; changes stay on that placement unless saved to the library. Patterns fade into plain walls and cross-fade into each other, close at the seam, line up layer to layer, and inner walls follow the outer wall so the skin stays fused. |

### Plugins
| Plugin | Features |
| --- | --- |
| **Motionex** | Waves, loops, dots and textures on walls, with a print-head collision check. **Weave mode**: a picture or motif woven into the wall like a jacquard vase — one filament per layer (AMS swaps every layer, 2–4 colours) with each line stepping out where the picture shows its colour, or one-filament relief; seam tucked inside the wall, full / small / no purge (bleed), cost estimate, calibration ring and Plantex weave vase shapes. See `docs/motionex/WEAVE.md`. **Velocity paint**: a picture printed into the outer wall as speed (sheen), one filament, any printer; wrap round or projected from one side, 2–8 grey levels, melt-limit and speed-ramp checks, speed ladder ring (`docs/motionex/PAINT.md`). **Lace walls**: openwork holes cut by the toolpath (lattice, gothic arches, teardrops, honeycomb, almonds, slots, waves, Voronoi or a picture), every hole made printable without support by an overhang/bridge rule (`docs/motionex/LACE.md`). Tool changers (Prusa XL, Snapmaker U1, Klipper changers, IDEX) swap heads with standby and preheat instead of purging (`docs/TOOLCHANGERS.md`). The cards read the printer: colour limit and purge advice per changer (AMS chute, MMU3/CFS/ACE, tool changer, Mono relief for manual), recommended paint acceleration and pixel size from the machine's limit (Marlin steps ≥ 1 mm), lace strand vs nozzle line width and bowden retraction hints. |
| **Patternex** | SVG or built-in patterns (stripes, checker, dots, hex) projected onto the model (planar or wrapped), a filament per colour region — AMS tool changes or manual swaps — with full / reduced / no purge, a movable change point for deliberate colour bleed, and a pre-export report. See `docs/patternex/`. |
| **Bulnex** | Bulk production (tuned for the Bambu Lab A1): one G-code with N cycles — print, cool the bed to a release temperature, sweep the row off the front edge at a % of the part height with reduced motor current and user-set passes, re-heat, repeat; homing, levelling and purge run once. Row auto-arrange with rotation and parts-per-row suggestion, height / contact-area / push-line checks (warn and proceed), and a camera monitor whose on-device model learns the print and the empty plate, sending phone alerts via ntfy. |
| **Lumonex** | Parametric lamp designer. Seven lamp types (table, wall, hanging, floor, floor-to-ceiling tension, battery lantern, pipe / handlebar mount). Every lamp is a stack of parts, each designed on its own: 23 silhouettes with 7 editable handles, 8 cross-sections, X/Y/Z scale, twist, lean, up to 4 pattern layers from 26 patterns (flutes, pleats, origami, rhombo, scales, voronoi, fins, ribbons…), wall / vase mode. Parts taller than the selected printer are cut into pieces automatically and joined with any of 20 joints (thread, bayonet, cam lock, snap ring / fingers, crush ribs, taper, hex, square, spline, key, dovetail keys, ball detent, collet, magnets, through-bolt, cross pin, heat-set insert, press, glue). Holders E27/E26/E14/E12/B22/B15/GU10/MR16/G9/LED puck/strip, galleries and holder seats, 22 preview-only bulbs, cable routing, switch / USB-C cut-outs, battery trays, canopies, backplates with keyholes, split clamps for any pipe Ø, hooks and clips. Ballast chambers with fill plug, felt recesses, hinged / GoPro-style clamps with a real tilt knuckle. Everything is designed in **Lumonex Studio**, a 98% window with a live 3D view (assembled and lit, exploded, or the print plates) next to the editor and the printer-fit / LED thermal report. **Transfer to plate** takes the lamp apart: each piece in its print orientation, one or more plates per filament (material + colour), with a filament slot each. The 72 Lumonex 2026 catalogue designs are presets (multi-tier bases rebuilt from the photos), plus Motionex / Patternex on the placed shades. |
| **Clickex** | Fidget clickers from any design around an MX-style keyboard switch. Sources: image, SVG, 1,891 icons, text, name keys (row, column, grid, WASD, arrows, custom) and 3D models (split in two, button on top, on a stand). Live 3D view with the real switch, cut-open and press test, auto switch placement and fit report, colour inlay / raise / engrave, keychain loop, fit-test print, Send to plate and Download 3MF. See `docs/clickex/`. |
| **Flenex** | Print-in-place flexi animals and characters. **Design** a creature from 46 presets (snakes, dragons, sea animals, reptiles, bugs, fantasy, plain bars) with a curved spine, 9 thickness handles, 8 cross-sections, 11 surface reliefs and 24 add-on kinds (eyes, horns, legs, wings, fins, sails, spikes, tentacles…), or **import** an STL / OBJ / 3MF and place cuts where you click. Every cut is a real print-in-place joint (ball & socket, hinge, universal, swivel, chain link) or an assembly cut (dowel, snap pin, dovetail, plain), placed square to the body, with a count per body part and clearance taken from the selected printer's nozzle, checked against its bed. Paint in the Studio (brush, fill, piece, one-click schemes), see it on the machine's bed, then export a coloured 3MF or send it to the plate with filament slots. See `docs/flenex/`. |

> Not covered yet: H2D dual-nozzle, Creality CFS / Anycubic ACE multi-colour, X1/H2 camera (RTSPS — open the shown URL in VLC). Profiles beyond the original four printers use generic start G-code — check the first print.

> Painting resolution follows the model's triangles; very coarse meshes paint in large facets.

## Advanced engine (NexSpiro Physics Core)

The **BASIC | ADVANCED** switch at the top centre swaps the classic process controls for the NexSpiro
Physics Core. In Advanced mode you pick an **Intent Card** (Structural Armor, Seamless Aesthetic,
Optical / Caustic Lamp, Acoustic Damping, 4D Flat-Morph); the engine analyses each part (signed
distance field, curvature, thickness, sections, topology), shows its zones in the **Zone Inspector**
(domes, necks, bosses, helical bands, cores, stress, Morse–Smale branches) and routes every zone to the
technologies made for it.

The intent turns on a set of **tools**, each named for what it does and switched with one toggle:
Smooth curved surfaces, Curved layers, Hide seams, Continuous spiral printing, Even inner walls, Gloss
control, Strength infill, Layer bonding, Stiffness targeting, Warp compensation, Multi-material
interlock, Vibration-damping infill, Motion compensation, Foaming filament control and Special print
mode (wire truss, casting shell, heat-morph sheet or caustic lens). Each tool says what happens when it
is on and lists the technologies it runs as ticks you can leave out. Power users open each technology's
settings, or the node graph.

The 15 tools run 35 technologies, all implemented in TypeScript inside the slicing worker and moulded to the
selected machine (kinematics, firmware input shaping and pressure advance, toolhead clearance cone,
Z limits, chamber, resonance, multi-material hardware): each reports *applied*, *adapted* (with the
reason) or *unavailable*. Basic mode output is unchanged byte for byte. See
[docs/advanced/ENGINE.md](docs/advanced/ENGINE.md) for the methods and their verification.

## Download & run

- **Desktop installers** — open the repository's **Actions → Desktop installers** workflow and click *Run workflow*, then download the `NexSpiro-Windows` / `NexSpiro-macOS` / `NexSpiro-Linux` artifact. Pushing a tag such as `v0.1.0` also publishes the installers on the **Releases** page.
  - macOS builds are unsigned: right-click the app → *Open* the first time.
- **Web version** — enable *Settings → Pages → Source: GitHub Actions*; every push to the default branch publishes the app to GitHub Pages so it can be opened from any browser.

## Develop

Requires Node.js 20+.

```bash
npm install
npm run dev            # web app at http://localhost:5173
npm run electron:dev   # desktop app with hot reload
npm test               # engine tests (slices every printer profile)
npm run build          # production web build → dist/
npm run electron:build # installers for the current OS → release/
```

## Project layout

```
src/
  engine/      slicing pipeline (pure TypeScript, runs in a Web Worker)
    slice.ts     mesh ∩ Z-planes → closed loops
    slicer.ts    perimeters, region classification, infill, ordering
    support.ts   overhang detection, normal & tree supports
    paint.ts     painted triangles → per-layer regions
    layers.ts    variable layer height profiles
    fill.ts      infill pattern generators
    gcode.ts     timing, cooling, G-code emission
  io/          STL / OBJ / 3MF readers
  profiles/    printers, filaments, process parameter schema & resolution
  state/       app store, scene operations, slicing bridge
  viewport/    Three.js scene and toolpath renderer
  ui/          React components
  connect/     printer connection interfaces (Phase 3)
electron/      desktop shell (app:// protocol, native file dialogs)
```

### Adding a printer

Append an entry to `PRINTERS` in `src/profiles/printers.ts` (bed size, plates, G-code flavour, start/end G-code, speed defaults). Everything else — the selector, plate, slicing and tests — picks it up automatically.

> Always check the first print on a new printer profile. The start G-code is a clean, standard sequence (home → heat → level → purge line). Review it in **Printer → Edit → Machine G-code** before printing.
