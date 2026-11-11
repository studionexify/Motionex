# Multi-material: filament units, tool changers, manual swaps

How a printer changes filament is a printer setting (*Printer settings → Basic information → Multi-material*), so any printer can be set up for it:

| Kind | Printers | A change is |
| --- | --- | --- |
| Filament unit with a purge chute | Bambu AMS / AMS lite (A1, P1, X1, H2D), Creality CFS (K2 Plus Combo, K1C / K1 Max + CFS, Hi Combo), Anycubic ACE Pro (Kobra 3 Combo, Kobra S1 Combo) | Cut, unload, load, flush into the chute (`[flush_length]`), prime tower if on. ~60–95 s. |
| Filament unit without a chute | Prusa MMU3 (MK4S, CORE One, MK3S+), Klipper units (ERCF / Tradrack with Happy Hare, BoxTurtle / AFC) | Unload, load (`T[next_extruder]`) over the prime tower, then the flush is printed on the tower. ~40–45 s plus the tower band. |
| Tool changer / IDEX | Prusa XL (5 heads), Snapmaker U1 (4), Klipper tool changers, IDEX | A head swap (`T[next_extruder]`). The new head is already loaded: no purge, only a small prime. ~5–12 s. |
| Manual | Single-nozzle printers | A pause (`M600`) for a spool swap. |

## Chute or tower

A filament unit has to get rid of the old colour somewhere (*Printer settings → Multi-material → Purge into*):

- **Purge chute:** the change G-code pushes the flush out over the chute (`[flush_length]`, from the flushing-volume matrix or *Flush volume*). The prime tower, when on, only takes the prime volume. Unset, this is the rule for Bambu printers.
- **Prime tower:** for units with nowhere else to flush (unset, every printer that is not a Bambu). `[flush_length]` is 0; the band printed on the tower after each change holds the prime volume plus the largest flush between the filaments in use, so the tower is deeper. The tower is printed even when it is off (with a warning), and the first load is flushed there too. Printing by object has no tower: the flush then falls back to `[flush_length]`, with a warning. `[wipe_tower_x]` / `[wipe_tower_y]` (the tower centre) let the change G-code do the swap over the tower.
- A change the art plugins mark as needing no flush (weave *bleed*) skips the tower band either way.
- **Filament slots:** the unit's spools (MMU3 5, CFS and ACE Pro 4 per unit, Klipper units 4–12). The slicer warns when a print uses a slot the unit doesn't have. 0 = not checked (Bambu: up to four AMS).

## Tool changer settings

- **Toolheads:** filament slot n prints with head n (T0, T1, …). The slicer warns when a print uses more slots than heads.
- **Prime after pick-up (mm³):** replaces what oozed while the head was parked (`[flush_length]`, or the prime tower).
- **Parked head temperature:** a parked head waits this far below its print temperature (`M104 T<n> S…` right after it is parked).
- **Preheat before pick-up (s):** the parked head is heated back to print temperature this long before it is picked up again, from the move-time estimate, so the swap doesn't wait.
- **Time per change:** used for the time estimate.

## What it means for wall art

- **Weave:** each colour has its own head, so a change every layer costs a head swap instead of a purge. The A1 bleed calibration ring takes 2.0 h; the same ring on a two-head U1 profile takes 0.9 h. Colours are limited by heads (up to 16) instead of AMS slots. On a unit without a chute (MMU3, ERCF) every layer's flush goes onto the prime tower, so weave the colours with *reduced* or *bleed* changes to keep the tower small.
- **Velocity paint and lace:** one filament, so they print the same on every printer.

The bundled tool-changer and filament-unit profiles use a generic `T[next_extruder]` change; check their start and change G-code against the maker's own slicer profile (PrusaSlicer, Creality Print, Anycubic Slicer Next, Snapmaker's) before the first print. The CFS and ACE Pro profiles rely on the firmware's `T` command parking the nozzle over the chute before the flush.

The Bambu H2D profile prints with one of its two nozzles, all colours from the AMS through it. Dual-nozzle printing is not supported.
