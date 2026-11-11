# Snapmaker Orca + Bambu Studio parity audit

Sources: Snapmaker Orca U1 quick-start guide (wiki.snapmaker.com/en/snapmaker_orca/qsg) and the Bambu Studio wiki
index, print-settings and toolbar pages (wiki.bambulab.com/en/bambu-studio). Audit date: 2026-11-06.

Status: ✅ in NexSpiro · 🆕 added in this change · ⚠️ partial or not present · ⛔ out of scope (vendor cloud)

## Import, project, slicing
| Documented feature | Source | NexSpiro |
| --- | --- | --- |
| Import .3mf / .stl / .obj | both | ✅ `src/io/load.ts` |
| Import .step / .stp | both | ✅ `src/io/cad.ts` (also IGES, BREP) |
| Import .amf | Snapmaker Orca | 🆕 `src/io/amf.ts` (plain + zipped, units, materials → colour paint) |
| Drag-and-drop, File › Import, toolbar import | Snapmaker Orca | ✅ |
| Slice plate | both | ✅ |
| Slice all (every plate) | Snapmaker Orca | 🆕 Slice menu › *Slice all plates* (`sliceAllPlates` in `src/state/actions.ts`) |
| Export G-code, Upload, Upload and Print | both | ✅ Print dialog + Export |
| Printer / filament / process presets, custom presets | both | ✅ |

## Top toolbar & right-click tools (Bambu Studio)
| Tool | NexSpiro |
| --- | --- |
| Plates management, auto-arrange, auto-orient | ✅ |
| Split to objects / parts | ✅ |
| Variable layer height | ✅ |
| Move / rotate / scale, lay on face | ✅ |
| Cut tool (with connectors) | ✅ `src/state/cutConnectors.ts` |
| Mesh boolean | ✅ |
| Support painting, seam painting, colour painting | ✅ |
| Text shape / SVG emboss | ✅ `src/state/tools.ts`, `ToolPanels.tsx` |
| Measurement tool | ✅ `src/state/measure.ts` |
| Assembly tool / assembly view | ✅ |
| Brim ears | ✅ |
| Fix model, simplify model | ✅ `src/engine/repair.ts`, mesh tools |
| Negative part, modifier | ✅ |
| Stacking models / anti-warp discs | ✅ |

## Painting modes (Snapmaker Orca)
Circle, Sphere, Triangle, Height range, Fill, Gap fill — ✅ `src/engine/brush.ts`.

## Process settings (Bambu Studio print-settings index)
Layer height, line width, seam, arc move, XY hole/contour and elephant-foot compensation, ironing, wall generator
(Arachne), bridge quality, strength, slow down for overhangs, supports, brim, prime tower, spiral vase, timelapse,
print by object, fuzzy skin, per-object settings, auto cooling — ✅ (`src/profiles/settings.ts`).

| Remaining gap | Source | Note |
| --- | --- | --- |
| Filament printing sequence per layer (plate settings: first-layer, other-layer and layer-range filament order) | Bambu Studio | ✅ Plate settings › Filament sequence; saved in Bambu's 3MF plate keys |

## Device (Snapmaker Orca U1 / Bambu)
| Feature | NexSpiro |
| --- | --- |
| LAN bind by IP, discovery of nearby devices | ✅ |
| Camera view, pause / stop, progress | ✅ |
| Home, jog XYZ, extrude / retract, nozzle and bed temperature, LED, fans, print speed | ✅ `DevicePage.tsx` |
| Attach / detach toolheads (U1) | ✅ toolchanger support |
| Filament sync and mapping to loaded filaments (closest colour, same type) | ✅ `src/profiles/amsSync.ts` |
| Cloud binding (PIN, app QR code), vendor account login | ⛔ requires the vendors' cloud services and accounts |

## Detailed audits
- [Options vs OrcaSlicer / Bambu Studio / Snapmaker Orca](parity/options.md): every preset key compared; 65 added and implemented, 172 still missing (listed).
- [Machine G-code per printer](parity/machine-gcode.md): 53 printers use their makers' G-code and machine values verbatim.
- [Prepare tool UX](parity/ux-prepare.md) and [other flows UX](parity/ux-flows.md): each action tested in the running app.
