# Hanex calibration on a real printer

The preset values (`src/plugins/hanex/core/profile.ts`) are starting points. Print these tests on your printer and filament, then write the winning values back into the profile.

## 1. Generate the G-code

```bash
npm run hanex:prints            # writes out/hanex/HNX-0x-*.gcode + .report.json
```

Optional settings, given as environment variables:

| Variable | Example | Effect |
| --- | --- | --- |
| `HANEX_PRINTER` | `'{"bedX":256,"bedY":256,"nozzleTemp":220,"bedTemp":65}'` | Printer overrides. Fields are in `CalibPrinter`; `startGcode`/`endGcode` replace the generic Marlin/Klipper ones. |
| `HANEX_PROFILE` | `hanex-petg` | Base preset: `hanex-pla`, `hanex-petg` or `hanex-abs`. |

**Before you print:**

- Check the start G-code. The generic one homes, heats and draws a prime line at X = 5.
- On an A1/P1/X1/H2 printer, or any printer that needs its own start sequence, pass `startGcode`.
- Each file's header lists the specimens from left to right and how to judge them.

## 2. Print order and what each print sets

Print in this order: each ladder uses the values chosen in the earlier ones (pass them via `HANEX_PROFILE` or by editing the preset).

| # | Print | Specimens (left → right) | Look at | Sets |
| --- | --- | --- | --- | --- |
| 1 | HNX-01 Overlap | 40 / 50 / 60 / 70 % | Gaps or loose strands between arcs (too low); ridges and blobs (too high) | `overlap` |
| 2 | HNX-02 Wave speed | 1.5 / 3 / 5 / 8 mm/s | Arcs pulled into chords, droop growing toward the tip | `waveSpeed` |
| 3 | HNX-03 Flow | ×0.85 / 1.0 / 1.15 / 1.3 | Translucent sheet (low); ploughing and sag (high) | `flowRatio` |
| 4 | HNX-04 Cooling | fan 100 / 160 / 210 / 255 | Sag (low); cracking or curling, especially ABS/ASA (high) | `fan` |
| 5 | HNX-06 Seeding | point / edge | Droop at the tip and along the free sides | `seedMode` |
| 6 | HNX-05 Reference | 50 × 30 mm overhang, Ø10 hole | Round, open hole; no gap behind it; underside flat within 0.3 mm | validation |
| 7 | HNX-07 Face angle | 90 / 92.5 / 95 / 97.5° | First angle that fails: this is what your toolhead allows | report |
| 8 | HNX-08 Reach | 12 × 40 mm tab | Droop at 10 / 20 / 30 / 40 mm with a straight edge | report |

Each specimen is a 20 × 12 × 6 mm pillar with a 1.2 mm tab whose waved first layer sits at z = 6.1 mm.

**How to judge:**

- Judge the underside of each tab with the print turned over, under raking light.
- When two specimens look equally good:
  - choose the faster one in HNX-02;
  - choose the lower value in HNX-01, HNX-03 and HNX-04.

## 3. Write the results back

```ts
import { applyCalibration, preset } from './src/plugins/hanex';
const mine = applyCalibration(preset('hanex-pla'), { overlap: 0.5, waveSpeed: 3, flowRatio: 1.0, fan: 255, seedMode: 'point' });
```

- `applyCalibration` refuses physically invalid combinations, for example an overlap so low that the previous arc leaves the nozzle land.
- To change the shipped defaults, edit the matching preset in `profile.ts`.
- Send me (or paste into the issue):
  - the winners;
  - photos of HNX-05, HNX-07 and HNX-08;
  - the droop numbers.

  I will then tune the presets and the defaults that no ladder covers (`rNominal`, `flowFloor`, `leadIn`, `startRadius`).

## 4. Toolhead

`ToolheadGeometry.tipFlatDiameter` is the outer diameter of the flat land at the nozzle tip. Measure it with calipers or a loupe. Typical values:

| Nozzle | Flat land |
| --- | --- |
| E3D V6 0.4 | ≈ 1.0 mm |
| A1/P1/X1 hardened 0.4 | ≈ 0.9 mm |
| Revo 0.4 | ≈ 1.1 mm |

This value sets the minimum overlap (`minOverlapForTip`).
