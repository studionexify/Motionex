# Machine G-code and machine values: parity with OrcaSlicer / Bambu Studio / Snapmaker Orca

Every NexSpiro printer with a maker's profile now carries that profile's machine G-code verbatim and its machine values. Profiles were resolved with their full `inherits` chain (down to the vendor's `fdm_*_common` bases) and Bambu's `include` template files.

Generated files: `src/profiles/vendor/<printer id>.json` (templates, machine values, bed, excluded areas, the inheritance chain, source repo and commit) and `src/profiles/vendor/index.ts`, applied in `src/profiles/printers.ts` (the loop after `VENDOR`). The generator is `gen.py` in the agent scratchpad (not in the repo); it reads `resources/profiles/<Vendor>/machine/*.json` of each slicer. The A1, P1S, U1 and Neptune 4 Max files from the earlier commit are kept as they were: the A1, P1S and Neptune 4 Max templates match the reference byte for byte.

References: OrcaSlicer `10c9df35782e641a9fd9500a63bdc65946fcc4af`, Bambu Studio `355d71eee5a9ebc794693fe57e63674806019770`.

## Template engine (src/engine/placeholder.ts, src/engine/templateVars.ts)

Added so every shipped template renders (tests/machine-gcode.test.ts slices on every printer and checks that no `{…}`, `[var]`, NaN or undefined is left):

- `[name[expr]]` legacy element syntax (Bambu: `S[flush_temperatures[next_extruder]]`, Anycubic: `[first_layer_temperature[initial_tool]]`). Before this, A1 and A1 mini change G-code printed `M109 S[flush_temperatures1]`.
- Regex match `=~ /…/` and `!~` (Prusa: `filament_notes[0]=~/.*HT_MBL10.*/`), whole-string match like boost::regex_match.
- Functions `interpolate_table(x, (x0,y0), …)` (Prusa MK4S / CORE One acceleration tables), `ceil`, `floor`, `size`.
- Per-extruder / per-filament options are vectors, as in the slicers (the list is generated from the three PrintConfig.cpp files into `src/engine/slicerOptionKinds.ts`). So `{retraction_length[initial_no_support_extruder]}` and `{enable_pressure_advance[initial_extruder]}` now work, and each filament's own setting is used where it has one. Vectors are sized to the largest of filaments, heads (`toolhead_count`) and unit slots (`filament_slots`), so the Prusa XL 5T and MMU3 templates, which walk 5 tools, index safely.
- New variables: `is_extruder_used` (the real list, from the toolpath), `num_extruders`, `extruded_volume[_total]` / `extruded_weight[_total]` (running totals at each layer, used by the Prusa MK4S `M201` table), `max_print_z`, `initial_no_support_filament_id`, `first_non_support_filaments`, `first_filaments`, `zhop`, `e_retracted`, `e_restart_extra`, `e_position`, `print_settings_id`, `filament_settings_id`, `printer_settings_id`, `filament_notes`, `initial_filament_type`, `num_printing_extruders`, `num_objects`, `num_instances`, `temperature_vitrification` / `min_vitrification_temperature` (Orca's default of 100 °C when the filament has none), `required_nozzle_HRC`, `long_retraction_when_cut` / `retraction_distance_when_cut` and the `_when_ec` pair, `filament_cooling_before_tower`, `filament_multitool_ramming[_volume|_flow]`, and the PrusaSlicer aliases `retract_length`, `retract_speed`, `deretract_speed`, `retract_lift`, `retract_before_travel`.
- Filament change: `new_filament_e_feedrate` / `old_filament_e_feedrate`, `current_filament_id` / `next_filament_id`, and the H2D change variables (`first_flush_volume`, `second_flush_volume`, `wipe_tower_*_pos_*`, `new_extruder_retracted_length`, `nozzle_volume_types`, …) with single-nozzle values.
- H2D: `filament_map` (every filament on the left nozzle, Bambu's default of 1), `initial_no_support_hotend`, `nozzle_diameter_at_nozzle_id`, nozzle and hotend ids of 0, timelapse variables (`timelapse_inline_photo`, `has_timelapse_safe_pos`, … all false), `is_all_bbl_filament`, `has_tpu_in_first_layer`. The profile vectors the templates read (`hotend_cooling_rate`, `hotend_heating_rate`, `cooling_filter_enabled`) are shipped as `vendor_template_vars` (JSON) in the machine config, and are used only for names NexSpiro does not set itself.

## Filament changes on units (Creality CFS, Anycubic ACE Pro)

- When the maker's change G-code does not select the next tool, NexSpiro now writes `T<n>` after it, as OrcaSlicer does (GCode.cpp `custom_gcode_changes_tool`). This applies only to printers with a filament unit or a tool changer. Creality's K1 / K2 / Hi change G-code relies on it.
- Purge: a unit running the maker's change G-code (with no `flush_length` in it) follows the profile's `purge_in_prime_tower`. The K1C and K1 Max CFS-C profiles have it on, so they now flush on the prime tower (`purge_target` tower; NexSpiro's own macro had flushed into a chute). The K2 Plus, Hi and Kobra S1 profiles have it off: the firmware's change command purges into the chute, and NexSpiro writes no flush of its own (`purge_target` chute).
- OrcaSlicer's date placeholders (`year`, `month`, `day`, `hour`, `minute`, `second`, `timestamp`) are set. Creality's K2 start G-code prints them in its header.

## Printers

"Blocks" lists the G-code templates now taken verbatim from the profile. "new" means NexSpiro had none for that block; "replaced" means NexSpiro's own version was replaced. "Values" lists the machine values that changed from NexSpiro's previous ones (old → new). Every profile also brings the machine limits NexSpiro has no setting for, kept under the slicers' names (`machine_max_speed_*`, `machine_max_acceleration_*`, `machine_max_jerk_*`, `thumbnails`, `thumbnails_format`, `support_air_filtration`, `support_chamber_temp_control`, `nozzle_volume`, `machine_load_filament_time`, …). Those are template variables and appear in the config block.

### Bambu Lab A1 (`bbl-a1`)

- Reference: Bambu Studio, `resources/profiles/BBL/machine/Bambu Lab A1 0.4 nozzle.json (+ its "template …" include files)`; chain: Bambu Lab A1 0.4 nozzle → fdm_bbl_3dp_001_common → fdm_machine_common
- Blocks: machine_start_gcode (already verbatim), machine_end_gcode (already verbatim), layer_change_gcode (already verbatim), change_filament_gcode (already verbatim), machine_pause_gcode (already verbatim), time_lapse_gcode (already verbatim)
- Values: unchanged

### Bambu Lab A1 mini (`bbl-a1mini`)

- Reference: Bambu Studio, `resources/profiles/BBL/machine/Bambu Lab A1 mini 0.4 nozzle.json (+ its "template …" include files)`; chain: Bambu Lab A1 mini 0.4 nozzle → fdm_bbl_3dp_001_common → fdm_machine_common
- Blocks: machine_start_gcode (replaced), machine_end_gcode (replaced), layer_change_gcode (new), change_filament_gcode (replaced), machine_pause_gcode (replaced), time_lapse_gcode (replaced)
- Values: retract_lift_below – → 179; retract_before_wipe – → 0; max_speed_z 20 → 30; max_acceleration 10000 → 20000; extruder_clearance_max_radius 76 → 73; extruder_clearance_height_to_lid 250 → 180; default_wipe_tower_pos – → 0.0x1.0

### Bambu Lab P1S (`bbl-p1s`)

- Reference: Bambu Studio, `resources/profiles/BBL/machine/Bambu Lab P1S 0.4 nozzle.json (+ its "template …" include files)`; chain: Bambu Lab P1S 0.4 nozzle → fdm_bbl_3dp_001_common → fdm_machine_common
- Blocks: machine_start_gcode (already verbatim), machine_end_gcode (already verbatim), layer_change_gcode (already verbatim), change_filament_gcode (already verbatim), machine_pause_gcode (already verbatim), time_lapse_gcode (already verbatim)
- Values: unchanged

### Bambu Lab P1P (`bbl-p1p`)

- Reference: Bambu Studio, `resources/profiles/BBL/machine/Bambu Lab P1P 0.4 nozzle.json (+ its "template …" include files)`; chain: Bambu Lab P1P 0.4 nozzle → fdm_bbl_3dp_001_common → fdm_machine_common
- Blocks: machine_start_gcode (replaced), machine_end_gcode (replaced), layer_change_gcode (new), change_filament_gcode (replaced), machine_pause_gcode (replaced), time_lapse_gcode (replaced)
- Values: bed z 256 → 250; retract_lift_below – → 249; retract_before_wipe – → 0; extruder_clearance_height_to_rod 36 → 34; default_wipe_tower_pos – → 0.644x0.977

### Bambu Lab X1 Carbon (`bbl-x1c`)

- Reference: Bambu Studio, `resources/profiles/BBL/machine/Bambu Lab X1 Carbon 0.4 nozzle.json (+ its "template …" include files)`; chain: Bambu Lab X1 Carbon 0.4 nozzle → fdm_bbl_3dp_001_common → fdm_machine_common
- Blocks: machine_start_gcode (replaced), machine_end_gcode (replaced), layer_change_gcode (new), change_filament_gcode (replaced), machine_pause_gcode (replaced), time_lapse_gcode (replaced)
- Values: bed z 256 → 250; retract_lift_below – → 249; retract_before_wipe – → 0; extruder_clearance_height_to_rod 36 → 34; default_wipe_tower_pos – → 0.644x0.977

### Bambu Lab X1E (`bbl-x1e`)

- Reference: Bambu Studio, `resources/profiles/BBL/machine/Bambu Lab X1E 0.4 nozzle.json (+ its "template …" include files)`; chain: Bambu Lab X1E 0.4 nozzle → fdm_bbl_3dp_001_common → fdm_machine_common
- Blocks: machine_start_gcode (replaced), machine_end_gcode (replaced), layer_change_gcode (new), change_filament_gcode (replaced), machine_pause_gcode (replaced), time_lapse_gcode (replaced)
- Values: bed z 256 → 250; retract_lift_below – → 249; retract_before_wipe – → 0; extruder_clearance_height_to_rod 36 → 34; default_wipe_tower_pos – → 0.644x0.977

### Bambu Lab H2D (`bbl-h2d`)

- Reference: Bambu Studio, `resources/profiles/BBL/machine/Bambu Lab H2D 0.4 nozzle.json (+ its "template …" include files)`; chain: Bambu Lab H2D 0.4 nozzle → fdm_bbl_3dp_002_common → fdm_machine_common
- Blocks: machine_start_gcode (replaced), machine_end_gcode (replaced), layer_change_gcode (new), change_filament_gcode (replaced), machine_pause_gcode (replaced), time_lapse_gcode (replaced), wrapping_detection_gcode (new)
- Values: retract_lift_below – → 319; retract_before_wipe – → 0; max_speed_xy 500 → 1000; max_speed_z 20 → 30; extruder_clearance_max_radius 68 → 96; extruder_clearance_height_to_rod 36 → 47.4; extruder_clearance_height_to_lid 90 → 201; default_wipe_tower_pos – → 0.644x0.977

### Creality Ender-3 V3 KE (`creality-ender3v3ke`)

- Reference: OrcaSlicer (Creality profile), `resources/profiles/Creality/machine/Creality Ender-3 V3 KE 0.4 nozzle.json`; chain: Creality Ender-3 V3 KE 0.4 nozzle → fdm_creality_common → fdm_machine_common
- Blocks: machine_start_gcode (replaced), machine_end_gcode (replaced), before_layer_change_gcode (new), change_filament_gcode (replaced), machine_pause_gcode (replaced)
- Values: bed z 240 → 245; retraction_length 0.8 → 0.5; retraction_speed 40 → 30; deretraction_speed 40 → 0; z_hop_types – → normal; retraction_minimum_travel 1 → 2; wipe – → true; wipe_distance – → 2; retract_before_wipe – → 100; retract_when_changing_layer – → true; retract_length_toolchange – → 1; max_speed_z 20 → 30; extruder_clearance_max_radius – → 90; extruder_clearance_height_to_rod – → 47; extruder_clearance_height_to_lid – → 34; auxiliary_fan – → false

### Creality K1 (`creality-k1`)

- Reference: OrcaSlicer (Creality profile), `resources/profiles/Creality/machine/Creality K1 (0.4 nozzle).json`; chain: Creality K1 (0.4 nozzle) → fdm_creality_common → fdm_machine_common
- Blocks: machine_start_gcode (replaced), machine_end_gcode (replaced), before_layer_change_gcode (new), layer_change_gcode (new), change_filament_gcode (replaced), machine_pause_gcode (replaced)
- Values: z_hop 0.2 → 0.4; z_hop_types – → auto; retract_lift_below – → 249; wipe – → true; wipe_distance – → 2; retract_before_wipe – → 70; retract_when_changing_layer – → true; retract_length_toolchange – → 0; max_speed_xy 500 → 800; extruder_clearance_max_radius – → 65; extruder_clearance_height_to_rod – → 45; extruder_clearance_height_to_lid – → 101; auxiliary_fan – → true

### Creality K1C (`creality-k1c`)

- Reference: OrcaSlicer (Creality profile), `resources/profiles/Creality/machine/Creality K1C 0.4 nozzle.json`; chain: Creality K1C 0.4 nozzle → fdm_creality_common → fdm_machine_common
- Blocks: machine_start_gcode (replaced), machine_end_gcode (replaced), before_layer_change_gcode (new), layer_change_gcode (new), change_filament_gcode (replaced), machine_pause_gcode (replaced)
- Values: z_hop 0.2 → 0.4; z_hop_types – → auto; retract_lift_below – → 249; wipe – → true; wipe_distance – → 2; retract_before_wipe – → 70; retract_when_changing_layer – → true; retract_length_toolchange – → 0; max_speed_xy 500 → 600; max_speed_z 20 → 10; extruder_clearance_max_radius – → 65; extruder_clearance_height_to_rod – → 45; extruder_clearance_height_to_lid – → 101; auxiliary_fan – → true

### Creality K1 Max (`creality-k1max`)

- Reference: OrcaSlicer (Creality profile), `resources/profiles/Creality/machine/Creality K1 Max (0.4 nozzle).json`; chain: Creality K1 Max (0.4 nozzle) → fdm_creality_common → fdm_machine_common
- Blocks: machine_start_gcode (replaced), machine_end_gcode (replaced), before_layer_change_gcode (new), layer_change_gcode (new), change_filament_gcode (replaced), machine_pause_gcode (replaced)
- Values: z_hop 0.2 → 0.4; z_hop_types – → auto; retract_lift_below – → 299; wipe – → true; wipe_distance – → 2; retract_before_wipe – → 70; retract_when_changing_layer – → true; retract_length_toolchange – → 0; max_speed_xy 500 → 800; extruder_clearance_max_radius – → 65; extruder_clearance_height_to_rod – → 45; extruder_clearance_height_to_lid – → 101; auxiliary_fan – → true

### Creality K2 Plus (`creality-k2plus`)

- Reference: OrcaSlicer (Creality profile), `resources/profiles/Creality/machine/Creality K2 Plus 0.4 nozzle.json`; chain: Creality K2 Plus 0.4 nozzle → fdm_creality_common → fdm_machine_common
- Blocks: machine_start_gcode (replaced), machine_end_gcode (replaced), before_layer_change_gcode (new), change_filament_gcode (replaced), machine_pause_gcode (replaced)
- Values: z_hop 0.2 → 0.4; z_hop_types – → normal; retract_lift_below – → 349; wipe – → true; wipe_distance – → 2; retract_before_wipe – → 70; retract_when_changing_layer – → true; retract_length_toolchange – → 2; max_speed_xy 500 → 800; max_speed_z 20 → 30; max_acceleration 20000 → 30000; extruder_clearance_max_radius – → 64; extruder_clearance_height_to_rod – → 24; extruder_clearance_height_to_lid – → 118; auxiliary_fan – → true

### Creality Ender-3 V3 (`creality-ender3v3`)

- Reference: OrcaSlicer (Creality profile), `resources/profiles/Creality/machine/Creality Ender-3 V3 0.4 nozzle.json`; chain: Creality Ender-3 V3 0.4 nozzle → fdm_creality_common → fdm_machine_common
- Blocks: machine_start_gcode (replaced), machine_end_gcode (replaced), before_layer_change_gcode (new), change_filament_gcode (replaced), machine_pause_gcode (replaced)
- Values: retraction_length 0.8 → 0.6; z_hop_types – → auto; wipe – → true; wipe_distance – → 2; retract_before_wipe – → 70; retract_when_changing_layer – → true; retract_length_toolchange – → 1; max_speed_xy 500 → 600; max_speed_z 20 → 500; max_acceleration 20000 → 5000; extruder_clearance_max_radius – → 70; extruder_clearance_height_to_rod – → 14; extruder_clearance_height_to_lid – → 250; auxiliary_fan – → true

### Creality Ender-3 V3 SE (`creality-ender3v3se`)

- Reference: OrcaSlicer (Creality profile), `resources/profiles/Creality/machine/Creality Ender-3 V3 SE 0.4 nozzle.json`; chain: Creality Ender-3 V3 SE 0.4 nozzle → fdm_creality_common → fdm_machine_common
- Blocks: machine_start_gcode (replaced), machine_end_gcode (replaced), before_layer_change_gcode (new), change_filament_gcode (replaced), machine_pause_gcode (replaced)
- Values: retraction_length 1 → 1.2; deretraction_speed 40 → 30; z_hop 0.2 → 0.4; z_hop_types – → spiral; retraction_minimum_travel 1 → 2; wipe – → true; retract_before_wipe – → 70; retract_when_changing_layer – → true; retract_length_toolchange – → 1; max_speed_xy 500 → 250; max_speed_z 20 → 5; max_acceleration 3000 → 2500; extruder_clearance_max_radius – → 90; extruder_clearance_height_to_rod – → 47; extruder_clearance_height_to_lid – → 34; auxiliary_fan – → false

### Creality Ender-3 S1 (`creality-ender3s1`)

- Reference: OrcaSlicer (Creality profile), `resources/profiles/Creality/machine/Creality Ender-3 S1 0.4 nozzle.json`; chain: Creality Ender-3 S1 0.4 nozzle → fdm_creality_common → fdm_machine_common
- Blocks: machine_start_gcode (replaced), machine_end_gcode (replaced), before_layer_change_gcode (new), change_filament_gcode (replaced), machine_pause_gcode (replaced)
- Values: retraction_speed 40 → 60; z_hop 0.2 → 0.4; z_hop_types – → normal; retraction_minimum_travel 1 → 2; wipe – → true; retract_before_wipe – → 70; retract_when_changing_layer – → true; retract_length_toolchange – → 1; max_speed_z 20 → 10; max_acceleration 1000 → 500; extruder_clearance_max_radius – → 47; extruder_clearance_height_to_rod – → 34; extruder_clearance_height_to_lid – → 34; auxiliary_fan – → false

### Creality Ender-3 V2 (`creality-ender3v2`)

- Reference: OrcaSlicer (Creality profile), `resources/profiles/Creality/machine/Creality Ender-3 V2 0.4 nozzle.json`; chain: Creality Ender-3 V2 0.4 nozzle → fdm_creality_common → fdm_machine_common
- Blocks: machine_start_gcode (replaced), machine_end_gcode (replaced), before_layer_change_gcode (new), machine_pause_gcode (replaced)
- Still NexSpiro's own (the profile leaves it empty): change_filament_gcode
- Values: retraction_length 1 → 5; retraction_speed 40 → 60; z_hop 0.2 → 0.4; z_hop_types – → normal; retraction_minimum_travel 1 → 2; wipe – → true; retract_before_wipe – → 70; retract_when_changing_layer – → true; retract_length_toolchange – → 2; max_speed_z 20 → 10; max_acceleration 1000 → 500; extruder_clearance_max_radius – → 47; extruder_clearance_height_to_rod – → 34; extruder_clearance_height_to_lid – → 34; auxiliary_fan – → false

### Creality CR-10 SE (`creality-cr10se`)

- Reference: OrcaSlicer (Creality profile), `resources/profiles/Creality/machine/Creality CR-10 SE 0.4 nozzle.json`; chain: Creality CR-10 SE 0.4 nozzle → fdm_creality_common → fdm_machine_common
- Blocks: machine_start_gcode (replaced), machine_end_gcode (replaced), before_layer_change_gcode (new), change_filament_gcode (replaced), machine_pause_gcode (replaced)
- Values: retraction_speed 40 → 30; z_hop 0.2 → 0.4; z_hop_types – → normal; retraction_minimum_travel 1 → 2; wipe – → true; retract_before_wipe – → 70; retract_when_changing_layer – → true; retract_length_toolchange – → 2; max_speed_xy 500 → 600; max_speed_z 20 → 30; max_acceleration 8000 → 5000; extruder_clearance_max_radius – → 65; extruder_clearance_height_to_rod – → 36; extruder_clearance_height_to_lid – → 140; auxiliary_fan – → false

### Creality K2 Plus Combo (CFS) (`creality-k2plus-cfs`)

- Reference: OrcaSlicer (Creality profile), `resources/profiles/Creality/machine/Creality K2 Plus 0.4 nozzle.json`; chain: Creality K2 Plus 0.4 nozzle → fdm_creality_common → fdm_machine_common
- Blocks: machine_start_gcode (replaced), machine_end_gcode (replaced), before_layer_change_gcode (new), change_filament_gcode (replaced), machine_pause_gcode (replaced)
- Values: z_hop 0.2 → 0.4; z_hop_types – → normal; retract_lift_below – → 349; wipe – → true; wipe_distance – → 2; retract_before_wipe – → 70; retract_when_changing_layer – → true; retract_length_toolchange – → 2; max_speed_xy 500 → 800; max_speed_z 20 → 30; max_acceleration 20000 → 30000; extruder_clearance_max_radius – → 64; extruder_clearance_height_to_rod – → 24; extruder_clearance_height_to_lid – → 118; auxiliary_fan – → true

### Creality K1C + CFS (`creality-k1c-cfs`)

- Reference: OrcaSlicer (Creality profile), `resources/profiles/Creality/machine/Creality K1C_CFS-C 0.4 nozzle.json`; chain: Creality K1C_CFS-C 0.4 nozzle → fdm_creality_common → fdm_machine_common
- Blocks: machine_start_gcode (replaced), machine_end_gcode (replaced), before_layer_change_gcode (new), layer_change_gcode (new), change_filament_gcode (replaced), machine_pause_gcode (replaced)
- Values: z_hop 0.2 → 0.4; z_hop_types – → auto; retract_lift_below – → 249; wipe – → true; wipe_distance – → 2; retract_before_wipe – → 70; retract_when_changing_layer – → true; retract_length_toolchange – → 0; max_speed_xy 500 → 600; max_speed_z 20 → 10; extruder_clearance_max_radius – → 65; extruder_clearance_height_to_rod – → 45; extruder_clearance_height_to_lid – → 101; auxiliary_fan – → true; purge_target chute → tower

### Creality K1 Max + CFS (`creality-k1max-cfs`)

- Reference: OrcaSlicer (Creality profile), `resources/profiles/Creality/machine/Creality K1 Max_CFS-C 0.4 nozzle.json`; chain: Creality K1 Max_CFS-C 0.4 nozzle → fdm_creality_common → fdm_machine_common
- Blocks: machine_start_gcode (replaced), machine_end_gcode (replaced), before_layer_change_gcode (new), layer_change_gcode (new), change_filament_gcode (replaced), machine_pause_gcode (replaced)
- Values: z_hop 0.2 → 0.4; z_hop_types – → auto; retract_lift_below – → 299; wipe – → true; wipe_distance – → 2; retract_before_wipe – → 70; retract_when_changing_layer – → true; retract_length_toolchange – → 0; max_speed_xy 500 → 800; extruder_clearance_max_radius – → 65; extruder_clearance_height_to_rod – → 45; extruder_clearance_height_to_lid – → 101; auxiliary_fan – → true; purge_target chute → tower

### Creality Hi Combo (CFS) (`creality-hi-cfs`)

- Reference: OrcaSlicer (Creality profile), `resources/profiles/Creality/machine/Creality Hi 0.4 nozzle.json`; chain: Creality Hi 0.4 nozzle → fdm_creality_common → fdm_machine_common
- Blocks: machine_start_gcode (replaced), machine_end_gcode (replaced), before_layer_change_gcode (new), layer_change_gcode (new), change_filament_gcode (replaced), machine_pause_gcode (replaced), time_lapse_gcode (new)
- Values: z_hop 0.2 → 0.4; z_hop_types – → auto; retract_lift_below – → 299; retraction_minimum_travel 1 → 0.5; wipe – → true; wipe_distance – → 2; retract_before_wipe – → 70; retract_when_changing_layer – → true; retract_length_toolchange – → 0; max_speed_xy 500 → 300; extruder_clearance_max_radius – → 55; extruder_clearance_height_to_rod – → 27; extruder_clearance_height_to_lid – → 20; auxiliary_fan – → false

### Elegoo Neptune 4 (`elegoo-neptune4`)

- Reference: OrcaSlicer (Elegoo profile), `resources/profiles/Elegoo/machine/EN4SERIES/Elegoo Neptune 4 0.4 nozzle.json`; chain: Elegoo Neptune 4 0.4 nozzle → fdm_elegoo_3dp_001_common → fdm_machine_common
- Blocks: machine_start_gcode (replaced), machine_end_gcode (replaced), before_layer_change_gcode (new), layer_change_gcode (new), change_filament_gcode (replaced), machine_pause_gcode (replaced)
- Values: bed x 225 → 230; bed y 225 → 230; retraction_speed 40 → 60; deretraction_speed 40 → 30; z_hop 0.2 → 0.4; z_hop_types – → auto; retract_lift_below – → 264; retraction_minimum_travel 1 → 0.8; wipe – → true; wipe_distance – → 1.2; retract_before_wipe – → 0; retract_when_changing_layer – → true; retract_length_toolchange – → 2; max_acceleration 5000 → 10000; extruder_clearance_max_radius – → 68; extruder_clearance_height_to_rod – → 34; extruder_clearance_height_to_lid – → 34; auxiliary_fan – → false

### Elegoo Neptune 4 Pro (`elegoo-neptune4pro`)

- Reference: OrcaSlicer (Elegoo profile), `resources/profiles/Elegoo/machine/EN4SERIES/Elegoo Neptune 4 Pro 0.4 nozzle.json`; chain: Elegoo Neptune 4 Pro 0.4 nozzle → Elegoo Neptune 4 0.4 nozzle → fdm_elegoo_3dp_001_common → fdm_machine_common
- Blocks: machine_start_gcode (replaced), machine_end_gcode (replaced), before_layer_change_gcode (new), layer_change_gcode (new), change_filament_gcode (replaced), machine_pause_gcode (replaced)
- Values: bed x 225 → 230; bed y 225 → 230; retraction_speed 40 → 60; deretraction_speed 40 → 30; z_hop 0.2 → 0.4; z_hop_types – → auto; retract_lift_below – → 264; retraction_minimum_travel 1 → 0.8; wipe – → true; wipe_distance – → 1.2; retract_before_wipe – → 0; retract_when_changing_layer – → true; retract_length_toolchange – → 2; max_acceleration 5000 → 10000; extruder_clearance_max_radius – → 68; extruder_clearance_height_to_rod – → 34; extruder_clearance_height_to_lid – → 34; auxiliary_fan – → false

### Elegoo Neptune 4 Plus (`elegoo-neptune4plus`)

- Reference: OrcaSlicer (Elegoo profile), `resources/profiles/Elegoo/machine/EN4SERIES/Elegoo Neptune 4 Plus 0.4 nozzle.json`; chain: Elegoo Neptune 4 Plus 0.4 nozzle → Elegoo Neptune 4 0.4 nozzle → fdm_elegoo_3dp_001_common → fdm_machine_common
- Blocks: machine_start_gcode (replaced), machine_end_gcode (replaced), before_layer_change_gcode (new), layer_change_gcode (new), change_filament_gcode (replaced), machine_pause_gcode (replaced)
- Values: bed x 320 → 325; bed y 320 → 325; retraction_speed 40 → 60; deretraction_speed 40 → 30; z_hop 0.2 → 0.4; z_hop_types – → auto; retract_lift_below – → 384; retraction_minimum_travel 1 → 0.8; wipe – → true; wipe_distance – → 1.2; retract_before_wipe – → 0; retract_when_changing_layer – → true; retract_length_toolchange – → 2; max_acceleration 5000 → 8000; extruder_clearance_max_radius – → 68; extruder_clearance_height_to_rod – → 34; extruder_clearance_height_to_lid – → 34; auxiliary_fan – → false

### Elegoo Neptune 4 Max (`elegoo-neptune4max`)

- Reference: OrcaSlicer (Elegoo profile), `resources/profiles/Elegoo/machine/EN4SERIES/Elegoo Neptune 4 Max 0.4 nozzle.json`; chain: Elegoo Neptune 4 Max 0.4 nozzle → Elegoo Neptune 4 0.4 nozzle → fdm_elegoo_3dp_001_common → fdm_machine_common
- Blocks: machine_start_gcode (already verbatim), machine_end_gcode (already verbatim), before_layer_change_gcode (already verbatim), layer_change_gcode (already verbatim), change_filament_gcode (already verbatim), machine_pause_gcode (already verbatim)
- Values: unchanged

### Elegoo Neptune 3 Pro (`elegoo-neptune3pro`)

- Reference: OrcaSlicer (Elegoo profile), `resources/profiles/Elegoo/machine/EN3SERIES/Elegoo Neptune 3 Pro 0.4 nozzle.json`; chain: Elegoo Neptune 3 Pro 0.4 nozzle → fdm_elegoo_common → fdm_machine_common
- Blocks: machine_start_gcode (replaced), machine_end_gcode (replaced), before_layer_change_gcode (new), layer_change_gcode (new), change_filament_gcode (replaced), machine_pause_gcode (replaced)
- Values: bed x 225 → 230; bed y 225 → 230; retraction_length 1 → 1.5; retraction_speed 40 → 30; deretraction_speed 40 → 30; z_hop 0.2 → 0.4; z_hop_types – → auto; retract_lift_below – → 279; wipe – → true; wipe_distance – → 1.2; retract_before_wipe – → 85; retract_when_changing_layer – → true; retract_length_toolchange – → 2; max_speed_xy 500 → 300; max_speed_z 20 → 10; max_acceleration 1500 → 1000; extruder_clearance_max_radius – → 68; extruder_clearance_height_to_rod – → 34; extruder_clearance_height_to_lid – → 34; auxiliary_fan – → false

### Elegoo Centauri Carbon (`elegoo-centauri`)

- Reference: OrcaSlicer (Elegoo profile), `resources/profiles/Elegoo/machine/ECC/Elegoo Centauri Carbon 0.4 nozzle.json`; chain: Elegoo Centauri Carbon 0.4 nozzle → fdm_elegoo_3dp_001_common → fdm_machine_common
- Blocks: machine_start_gcode (replaced), machine_end_gcode (replaced), before_layer_change_gcode (new), layer_change_gcode (new), change_filament_gcode (replaced), machine_pause_gcode (replaced)
- Values: excluded area [] → [[[246, 0], [256, 0], [256, 20], [246, 20]]]; retraction_speed 40 → 30; deretraction_speed 40 → 30; z_hop 0.2 → 0.4; z_hop_types – → auto; retract_lift_below – → 255; retraction_minimum_travel 1 → 0.8; wipe – → true; wipe_distance – → 1.2; retract_before_wipe – → 0; retract_when_changing_layer – → true; retract_length_toolchange – → 0; extruder_clearance_max_radius – → 68; extruder_clearance_height_to_rod – → 36; extruder_clearance_height_to_lid – → 90; auxiliary_fan – → true

### Prusa MK4S (`prusa-mk4s`)

- Reference: OrcaSlicer (Prusa profile), `resources/profiles/Prusa/machine/Prusa MK4S 0.4 nozzle.json`; chain: Prusa MK4S 0.4 nozzle → fdm_machine_common_mk4s → fdm_machine_common_nextruder → fdm_machine_common
- Blocks: machine_start_gcode (replaced), machine_end_gcode (replaced), before_layer_change_gcode (new), layer_change_gcode (new), machine_pause_gcode (replaced)
- Still NexSpiro's own (the profile leaves it empty): change_filament_gcode
- Values: retraction_length 1 → 0.7; retraction_speed 40 → 35; deretraction_speed 40 → 25; z_hop_types – → slope; retract_lift_below – → 219; retraction_minimum_travel 1 → 1.5; wipe – → false; retract_before_wipe – → 80; retract_when_changing_layer – → false; retract_length_toolchange – → 0; max_speed_xy 500 → 300; max_speed_z 20 → 40; extruder_clearance_max_radius – → 45; extruder_clearance_height_to_rod – → 14; extruder_clearance_height_to_lid – → 220

### Prusa MK3S+ (`prusa-mk3s`)

- Reference: OrcaSlicer (Prusa profile), `resources/profiles/Prusa/machine/Prusa MK3S 0.4 nozzle.json`; chain: Prusa MK3S 0.4 nozzle → fdm_machine_common
- Blocks: machine_start_gcode (replaced), machine_end_gcode (replaced), before_layer_change_gcode (new), layer_change_gcode (new), machine_pause_gcode (replaced)
- Still NexSpiro's own (the profile leaves it empty): change_filament_gcode
- Values: retraction_length 1 → 0.8; retraction_speed 40 → 30; deretraction_speed 40 → 30; z_hop 0.2 → 0.4; wipe – → true; retract_before_wipe – → 70; retract_when_changing_layer – → true; retract_length_toolchange – → 2; max_speed_xy 500 → 200; max_speed_z 20 → 12; max_acceleration 1250 → 2000; extruder_clearance_max_radius – → 65; extruder_clearance_height_to_rod – → 36; extruder_clearance_height_to_lid – → 140; auxiliary_fan – → false

### Prusa MINI+ (`prusa-mini`)

- Reference: OrcaSlicer (Prusa profile), `resources/profiles/Prusa/machine/Prusa MINI 0.4 nozzle.json`; chain: Prusa MINI 0.4 nozzle → fdm_machine_common
- Blocks: machine_start_gcode (replaced), machine_end_gcode (replaced), before_layer_change_gcode (new), layer_change_gcode (new), machine_pause_gcode (replaced)
- Still NexSpiro's own (the profile leaves it empty): change_filament_gcode
- Values: retraction_length 1 → 3.2; retraction_speed 40 → 70; deretraction_speed 40 → 30; z_hop 0.2 → 0.4; retraction_minimum_travel 1 → 1.5; wipe – → true; retract_before_wipe – → 70; retract_when_changing_layer – → true; retract_length_toolchange – → 2; max_speed_xy 500 → 180; max_speed_z 20 → 12; max_acceleration 2500 → 1250; extruder_clearance_max_radius – → 65; extruder_clearance_height_to_rod – → 36; extruder_clearance_height_to_lid – → 140; auxiliary_fan – → false

### Prusa CORE One (`prusa-coreone`)

- Reference: OrcaSlicer (Prusa profile), `resources/profiles/Prusa/machine/Prusa CORE One 0.4 nozzle.json`; chain: Prusa CORE One 0.4 nozzle → Prusa CORE One HF 0.4 nozzle → fdm_machine_common_nextruder → fdm_machine_common
- Blocks: machine_start_gcode (replaced), machine_end_gcode (replaced), before_layer_change_gcode (new), layer_change_gcode (new), change_filament_gcode (replaced), machine_pause_gcode (replaced)
- Values: retraction_length 1 → 0.7; retraction_speed 40 → 45; deretraction_speed 40 → 25; z_hop_types – → slope; retract_lift_below – → 269; retraction_minimum_travel 1 → 1.5; wipe – → false; retract_before_wipe – → 80; retract_when_changing_layer – → true; retract_length_toolchange – → 0; max_speed_xy 500 → 350; max_speed_z 20 → 12; max_acceleration 8000 → 7000; extruder_clearance_max_radius – → 75; extruder_clearance_height_to_rod – → 33; extruder_clearance_height_to_lid – → 50

### Prusa XL (single tool) (`prusa-xl`)

- Reference: OrcaSlicer (Prusa profile), `resources/profiles/Prusa/machine/Prusa XL 0.4 nozzle.json`; chain: Prusa XL 0.4 nozzle → fdm_machine_common_xl → fdm_machine_common
- Blocks: machine_start_gcode (replaced), machine_end_gcode (replaced), before_layer_change_gcode (new), layer_change_gcode (new), change_filament_gcode (replaced), machine_pause_gcode (replaced)
- Values: retraction_length 1 → 0.8; retraction_speed 40 → 35; deretraction_speed 40 → 25; z_hop 0.2 → 0.4; z_hop_types – → auto; retract_lift_below – → 1.5; retraction_minimum_travel 1 → 1.5; wipe – → true; retract_before_wipe – → 80; retract_when_changing_layer – → true; retract_length_toolchange – → 2; max_speed_xy 500 → 400; max_speed_z 20 → 12; max_acceleration 5000 → 4000; extruder_clearance_max_radius – → 67; extruder_clearance_height_to_rod – → 21; extruder_clearance_height_to_lid – → 21; auxiliary_fan – → false

### Prusa XL (5 toolheads) (`prusa-xl-5t`)

- Reference: OrcaSlicer (Prusa profile), `resources/profiles/Prusa/machine/Prusa XL 5T 0.4 nozzle.json`; chain: Prusa XL 5T 0.4 nozzle → fdm_machine_common_xl_5t → fdm_machine_common_xl → fdm_machine_common
- Blocks: machine_start_gcode (replaced), machine_end_gcode (replaced), before_layer_change_gcode (new), layer_change_gcode (new), change_filament_gcode (replaced), machine_pause_gcode (replaced)
- Values: retraction_length 1 → 0.8; retraction_speed 40 → 35; deretraction_speed 40 → 25; z_hop 0.2 → 0.4; z_hop_types – → auto; retract_lift_below – → 1.5; retraction_minimum_travel 1 → 1.5; wipe – → true; retract_before_wipe – → 80; retract_when_changing_layer – → true; retract_length_toolchange – → 2; max_speed_xy 500 → 400; max_speed_z 20 → 12; max_acceleration 5000 → 4000; extruder_clearance_max_radius – → 67; extruder_clearance_height_to_rod – → 21; extruder_clearance_height_to_lid – → 21; auxiliary_fan – → false

### Prusa MK4S + MMU3 (`prusa-mk4s-mmu3`)

- Reference: OrcaSlicer (Prusa profile), `resources/profiles/Prusa/machine/Prusa MK4 MMU3 0.4 nozzle.json`; chain: Prusa MK4 MMU3 0.4 nozzle → fdm_machine_common_mk4_mmu3 → Prusa MK4 0.4 nozzle → fdm_machine_common_nextruder → fdm_machine_common
- Blocks: machine_start_gcode (replaced), machine_end_gcode (replaced), before_layer_change_gcode (new), layer_change_gcode (new), machine_pause_gcode (replaced)
- Still NexSpiro's own (the profile leaves it empty): change_filament_gcode
- Values: retraction_length 1 → 0.7; retraction_speed 40 → 35; deretraction_speed 40 → 25; z_hop_types – → normal; retract_lift_below – → 219; retraction_minimum_travel 1 → 1.5; wipe – → false; retract_before_wipe – → 80; retract_when_changing_layer – → true; retract_length_toolchange – → 0; max_speed_xy 500 → 300; max_speed_z 20 → 40; extruder_clearance_max_radius – → 45; extruder_clearance_height_to_rod – → 13; extruder_clearance_height_to_lid – → 140; auxiliary_fan – → false

### Prusa CORE One + MMU3 (`prusa-coreone-mmu3`)

- Reference: OrcaSlicer (Prusa profile), `resources/profiles/Prusa/machine/Prusa CORE One MMU3 0.4 nozzle.json`; chain: Prusa CORE One MMU3 0.4 nozzle → Prusa CORE One 0.4 nozzle → Prusa CORE One HF 0.4 nozzle → fdm_machine_common_nextruder → fdm_machine_common
- Blocks: machine_start_gcode (replaced), machine_end_gcode (replaced), before_layer_change_gcode (new), layer_change_gcode (new), machine_pause_gcode (replaced)
- Still NexSpiro's own (the profile leaves it empty): change_filament_gcode
- Values: retraction_length 1 → 0.7; retraction_speed 40 → 45; deretraction_speed 40 → 25; z_hop_types – → slope; retract_lift_below – → 269; retraction_minimum_travel 1 → 1.5; wipe – → false; retract_before_wipe – → 80; retract_when_changing_layer – → true; retract_length_toolchange – → 0; max_speed_xy 500 → 350; max_speed_z 20 → 12; max_acceleration 8000 → 7000; extruder_clearance_max_radius – → 75; extruder_clearance_height_to_rod – → 33; extruder_clearance_height_to_lid – → 50

### Anycubic Kobra 2 Neo (`anycubic-kobra2neo`)

- Reference: OrcaSlicer (Anycubic profile), `resources/profiles/Anycubic/machine/Anycubic Kobra 2 Neo 0.4 nozzle.json`; chain: Anycubic Kobra 2 Neo 0.4 nozzle → fdm_machine_common
- Blocks: machine_start_gcode (replaced), machine_end_gcode (replaced), before_layer_change_gcode (new), layer_change_gcode (new), machine_pause_gcode (replaced)
- Still NexSpiro's own (the profile leaves it empty): change_filament_gcode
- Values: retraction_length 1 → 2.5; retraction_speed 40 → 100; deretraction_speed 40 → 0; z_hop 0.2 → 0; z_hop_types – → auto; retract_lift_below – → 258; wipe – → true; wipe_distance – → 1; retract_before_wipe – → 70; retract_when_changing_layer – → true; retract_length_toolchange – → 0; max_speed_xy 500 → 300; max_speed_z 20 → 8; max_acceleration 2500 → 2000; extruder_clearance_max_radius – → 20; extruder_clearance_height_to_rod – → 20; extruder_clearance_height_to_lid – → 20; auxiliary_fan – → false

### Anycubic Kobra 2 Max (`anycubic-kobra2max`)

- Reference: OrcaSlicer (Anycubic profile), `resources/profiles/Anycubic/machine/Anycubic Kobra 2 Max 0.4 nozzle.json`; chain: Anycubic Kobra 2 Max 0.4 nozzle → fdm_machine_common
- Blocks: machine_start_gcode (replaced), machine_end_gcode (replaced), layer_change_gcode (new), machine_pause_gcode (replaced)
- Still NexSpiro's own (the profile leaves it empty): change_filament_gcode
- Values: flavor marlin → klipper; retraction_length 1 → 1.5; retraction_speed 40 → 30; deretraction_speed 40 → 30; z_hop 0.2 → 0; z_hop_types – → auto; retract_lift_below – → 255; wipe – → true; wipe_distance – → 1; retract_before_wipe – → 0; retract_when_changing_layer – → true; retract_length_toolchange – → 2; max_speed_z 20 → 16; max_acceleration 3000 → 10000; extruder_clearance_max_radius – → 73; extruder_clearance_height_to_rod – → 25; extruder_clearance_height_to_lid – → 256; auxiliary_fan – → false

### Anycubic Kobra 3 (`anycubic-kobra3`)

- Reference: OrcaSlicer (Anycubic profile), `resources/profiles/Anycubic/machine/Anycubic Kobra 3 0.4 nozzle.json`; chain: Anycubic Kobra 3 0.4 nozzle → fdm_machine_common
- Blocks: machine_start_gcode (replaced), machine_end_gcode (replaced), before_layer_change_gcode (new), layer_change_gcode (new), machine_pause_gcode (replaced)
- Still NexSpiro's own (the profile leaves it empty): change_filament_gcode
- Values: bed x 250 → 255; bed y 250 → 255; excluded area [] → [[[0, 0], [255, 0], [255, 255], [0, 255]], [[2, 2], [2, 253], [253, 253], [253, 2]]]; flavor marlin → klipper; retraction_speed 40 → 60; deretraction_speed 40 → 60; z_hop 0.2 → 0.4; z_hop_types – → auto; retract_lift_below – → 259.6; wipe – → true; wipe_distance – → 2; retract_before_wipe – → 0; retract_when_changing_layer – → true; retract_length_toolchange – → 0; max_speed_xy 500 → 600; max_speed_z 20 → 10; max_acceleration 10000 → 15000; extruder_clearance_max_radius – → 130; extruder_clearance_height_to_rod – → 30; extruder_clearance_height_to_lid – → 200; auxiliary_fan – → false

### Anycubic Kobra 3 Combo (ACE Pro) (`anycubic-kobra3-ace`)

- Reference: OrcaSlicer (Anycubic profile), `resources/profiles/Anycubic/machine/Anycubic Kobra 3 0.4 nozzle.json`; chain: Anycubic Kobra 3 0.4 nozzle → fdm_machine_common
- Blocks: machine_start_gcode (replaced), machine_end_gcode (replaced), before_layer_change_gcode (new), layer_change_gcode (new), machine_pause_gcode (replaced)
- Still NexSpiro's own (the profile leaves it empty): change_filament_gcode
- Values: bed x 250 → 255; bed y 250 → 255; excluded area [] → [[[0, 0], [255, 0], [255, 255], [0, 255]], [[2, 2], [2, 253], [253, 253], [253, 2]]]; flavor marlin → klipper; retraction_speed 40 → 60; deretraction_speed 40 → 60; z_hop 0.2 → 0.4; z_hop_types – → auto; retract_lift_below – → 259.6; wipe – → true; wipe_distance – → 2; retract_before_wipe – → 0; retract_when_changing_layer – → true; retract_length_toolchange – → 0; max_speed_xy 500 → 600; max_speed_z 20 → 10; max_acceleration 10000 → 15000; extruder_clearance_max_radius – → 130; extruder_clearance_height_to_rod – → 30; extruder_clearance_height_to_lid – → 200; auxiliary_fan – → false

### Anycubic Kobra S1 Combo (ACE Pro) (`anycubic-kobras1-ace`)

- Reference: OrcaSlicer (Anycubic profile), `resources/profiles/Anycubic/machine/Anycubic Kobra S1 0.4 nozzle.json`; chain: Anycubic Kobra S1 0.4 nozzle → fdm_machine_common
- Blocks: machine_start_gcode (replaced), machine_end_gcode (replaced), before_layer_change_gcode (new), layer_change_gcode (new), change_filament_gcode (replaced), machine_pause_gcode (replaced)
- Values: flavor marlin → klipper; retraction_length 1 → 0.8; deretraction_speed 40 → 0; z_hop 0.2 → 0.4; z_hop_types – → slope; retract_lift_below – → 249; wipe – → true; wipe_distance – → 1; retract_before_wipe – → 0; retract_when_changing_layer – → true; retract_length_toolchange – → 0; max_speed_xy 500 → 600; max_speed_z 20 → 15; max_acceleration 20000 → 10000; extruder_clearance_max_radius – → 60; extruder_clearance_height_to_rod – → 48; extruder_clearance_height_to_lid – → 240; auxiliary_fan – → true

### Voron 2.4 350 (`voron-24-350`)

- Reference: OrcaSlicer (Voron profile), `resources/profiles/Voron/machine/Voron 2.4 350 0.4 nozzle.json`; chain: Voron 2.4 350 0.4 nozzle → fdm_klipper_common → fdm_machine_common
- Blocks: machine_start_gcode (replaced), machine_end_gcode (replaced), before_layer_change_gcode (new), layer_change_gcode (new), machine_pause_gcode (replaced)
- Still NexSpiro's own (the profile leaves it empty): change_filament_gcode
- Values: bed z 340 → 325; retraction_speed 40 → 30; deretraction_speed 40 → 30; z_hop 0.2 → 0.4; z_hop_types – → slope; wipe – → true; retract_before_wipe – → 70; retract_when_changing_layer – → true; retract_length_toolchange – → 2; max_speed_z 20 → 12; max_acceleration 10000 → 20000; extruder_clearance_max_radius – → 65; extruder_clearance_height_to_rod – → 36; extruder_clearance_height_to_lid – → 140; auxiliary_fan – → false

### Voron Trident 300 (`voron-trident-300`)

- Reference: OrcaSlicer (Voron profile), `resources/profiles/Voron/machine/Voron Trident 300 0.4 nozzle.json`; chain: Voron Trident 300 0.4 nozzle → fdm_klipper_common → fdm_machine_common
- Blocks: machine_start_gcode (replaced), machine_end_gcode (replaced), before_layer_change_gcode (new), layer_change_gcode (new), machine_pause_gcode (replaced)
- Still NexSpiro's own (the profile leaves it empty): change_filament_gcode
- Values: retraction_speed 40 → 30; deretraction_speed 40 → 30; z_hop 0.2 → 0.4; z_hop_types – → slope; wipe – → true; retract_before_wipe – → 70; retract_when_changing_layer – → true; retract_length_toolchange – → 2; max_speed_z 20 → 12; max_acceleration 10000 → 20000; extruder_clearance_max_radius – → 65; extruder_clearance_height_to_rod – → 36; extruder_clearance_height_to_lid – → 140; auxiliary_fan – → false

### Voron 0.2 (`voron-02`)

- Reference: OrcaSlicer (Voron profile), `resources/profiles/Voron/machine/Voron 0.1 0.4 nozzle.json`; chain: Voron 0.1 0.4 nozzle → fdm_klipper_common → fdm_machine_common
- Blocks: machine_start_gcode (replaced), machine_end_gcode (replaced), before_layer_change_gcode (new), layer_change_gcode (new), machine_pause_gcode (replaced)
- Still NexSpiro's own (the profile leaves it empty): change_filament_gcode
- Values: retraction_speed 40 → 30; deretraction_speed 40 → 30; z_hop 0.2 → 0.4; z_hop_types – → slope; wipe – → true; retract_before_wipe – → 70; retract_when_changing_layer – → true; retract_length_toolchange – → 2; max_speed_z 20 → 12; max_acceleration 10000 → 20000; extruder_clearance_max_radius – → 65; extruder_clearance_height_to_rod – → 36; extruder_clearance_height_to_lid – → 140; auxiliary_fan – → false

### Qidi Q1 Pro (`qidi-q1pro`)

- Reference: OrcaSlicer (Qidi profile), `resources/profiles/Qidi/machine/Qidi Q1 Pro 0.4 nozzle.json`; chain: Qidi Q1 Pro 0.4 nozzle → fdm_qidi_x3_common → fdm_machine_common
- Blocks: machine_start_gcode (replaced), machine_end_gcode (replaced), before_layer_change_gcode (new), layer_change_gcode (new), machine_pause_gcode (replaced), time_lapse_gcode (new)
- Still NexSpiro's own (the profile leaves it empty): change_filament_gcode
- Values: excluded area [] → [[[25, 245], [25, 240], [115, 240], [115, 245], [208, 245], [208, 240], [245, 240], [245, 245], [208, 245]]]; retraction_speed 40 → 30; deretraction_speed 40 → 0; z_hop 0.2 → 0.4; z_hop_types – → auto; wipe – → true; wipe_distance – → 2; retract_before_wipe – → 0; retract_when_changing_layer – → true; retract_length_toolchange – → 2; max_speed_xy 500 → 600; max_speed_z 20 → 10; extruder_clearance_max_radius – → 70; extruder_clearance_height_to_rod – → 40; extruder_clearance_height_to_lid – → 120; auxiliary_fan – → true

### Qidi X-Plus 3 (`qidi-xplus3`)

- Reference: OrcaSlicer (Qidi profile), `resources/profiles/Qidi/machine/Qidi X-Plus 3 0.4 nozzle.json`; chain: Qidi X-Plus 3 0.4 nozzle → fdm_qidi_x3_common → fdm_machine_common
- Blocks: machine_start_gcode (replaced), machine_end_gcode (replaced), before_layer_change_gcode (new), machine_pause_gcode (replaced), time_lapse_gcode (new)
- Still NexSpiro's own (the profile leaves it empty): change_filament_gcode
- Values: retraction_length 0.8 → 1; retraction_speed 40 → 30; deretraction_speed 40 → 0; z_hop 0.2 → 0.4; z_hop_types – → auto; wipe – → true; wipe_distance – → 2; retract_before_wipe – → 0; retract_when_changing_layer – → true; retract_length_toolchange – → 2; max_speed_xy 500 → 600; max_speed_z 20 → 10; extruder_clearance_max_radius – → 65; extruder_clearance_height_to_rod – → 36; extruder_clearance_height_to_lid – → 140; auxiliary_fan – → true

### Qidi X-Max 3 (`qidi-xmax3`)

- Reference: OrcaSlicer (Qidi profile), `resources/profiles/Qidi/machine/Qidi X-Max 3 0.4 nozzle.json`; chain: Qidi X-Max 3 0.4 nozzle → fdm_qidi_x3_common → fdm_machine_common
- Blocks: machine_start_gcode (replaced), machine_end_gcode (replaced), before_layer_change_gcode (new), machine_pause_gcode (replaced), time_lapse_gcode (new)
- Still NexSpiro's own (the profile leaves it empty): change_filament_gcode
- Values: retraction_length 0.8 → 1; retraction_speed 40 → 30; deretraction_speed 40 → 0; z_hop 0.2 → 0.4; z_hop_types – → auto; wipe – → true; wipe_distance – → 2; retract_before_wipe – → 0; retract_when_changing_layer – → true; retract_length_toolchange – → 2; max_speed_xy 500 → 600; max_speed_z 20 → 10; extruder_clearance_max_radius – → 70; extruder_clearance_height_to_rod – → 30; extruder_clearance_height_to_lid – → 118; auxiliary_fan – → true

### Sovol SV08 (`sovol-sv08`)

- Reference: OrcaSlicer (Sovol profile), `resources/profiles/Sovol/machine/Sovol SV08 0.4 nozzle.json`; chain: Sovol SV08 0.4 nozzle → fdm_machine_common
- Blocks: machine_start_gcode (replaced), machine_end_gcode (replaced), before_layer_change_gcode (new), machine_pause_gcode (replaced)
- Still NexSpiro's own (the profile leaves it empty): change_filament_gcode
- Values: retraction_length 0.8 → 0.5; retraction_speed 40 → 30; deretraction_speed 40 → 30; z_hop 0.2 → 0.4; z_hop_types – → normal; retract_lift_below – → 343; wipe – → true; wipe_distance – → 2; retract_before_wipe – → 0; retract_when_changing_layer – → true; retract_length_toolchange – → 2; max_speed_xy 500 → 700; extruder_clearance_max_radius – → 65; extruder_clearance_height_to_rod – → 36; extruder_clearance_height_to_lid – → 140

### Sovol SV07 (`sovol-sv07`)

- Reference: OrcaSlicer (Sovol profile), `resources/profiles/Sovol/machine/Sovol SV07 0.4 nozzle.json`; chain: Sovol SV07 0.4 nozzle → fdm_machine_common
- Blocks: machine_start_gcode (replaced), machine_end_gcode (replaced), before_layer_change_gcode (new), machine_pause_gcode (replaced)
- Still NexSpiro's own (the profile leaves it empty): change_filament_gcode
- Values: flavor klipper → marlin; retraction_speed 40 → 50; deretraction_speed 40 → 50; z_hop 0.2 → 0.4; z_hop_types – → normal; retract_lift_below – → 348; retraction_minimum_travel 1 → 2; wipe – → true; retract_before_wipe – → 70; retract_when_changing_layer – → true; retract_length_toolchange – → 1; max_acceleration 8000 → 12000; extruder_clearance_max_radius – → 65; extruder_clearance_height_to_rod – → 36; extruder_clearance_height_to_lid – → 140

### Sovol SV06 (`sovol-sv06`)

- Reference: OrcaSlicer (Sovol profile), `resources/profiles/Sovol/machine/Sovol SV06 0.4 nozzle.json`; chain: Sovol SV06 0.4 nozzle → fdm_machine_common
- Blocks: machine_start_gcode (replaced), machine_end_gcode (replaced), before_layer_change_gcode (new), layer_change_gcode (new), change_filament_gcode (replaced), machine_pause_gcode (replaced)
- Values: retraction_length 1 → 0.5; retraction_speed 40 → 30; deretraction_speed 40 → 30; z_hop 0.2 → 0; z_hop_types – → normal; retract_lift_below – → 0; wipe – → true; retract_before_wipe – → 0; retract_when_changing_layer – → true; retract_length_toolchange – → 4; max_speed_xy 500 → 80; max_speed_z 20 → 10; max_acceleration 1500 → 500; extruder_clearance_max_radius – → 65; extruder_clearance_height_to_rod – → 36; extruder_clearance_height_to_lid – → 140; auxiliary_fan – → false

### Artillery Sidewinder X4 Plus (`artillery-x4plus`)

- Reference: OrcaSlicer (Artillery profile), `resources/profiles/Artillery/machine/Artillery Sidewinder X4 Plus 0.4 nozzle.json`; chain: Artillery Sidewinder X4 Plus 0.4 nozzle → fdm_machine_common
- Blocks: machine_start_gcode (replaced), machine_end_gcode (replaced), layer_change_gcode (new), machine_pause_gcode (replaced)
- Still NexSpiro's own (the profile leaves it empty): change_filament_gcode
- Values: bed y 300 → 310; retraction_length 0.8 → 1.3; retraction_speed 40 → 30; deretraction_speed 40 → 0; z_hop 0.2 → 0.4; z_hop_types – → normal; retract_lift_below – → 0; retraction_minimum_travel 1 → 2; wipe – → false; wipe_distance – → 1; retract_before_wipe – → 0; retract_when_changing_layer – → true; retract_length_toolchange – → 10; max_speed_z 20 → 12; max_acceleration 7000 → 6000; extruder_clearance_max_radius – → 65; extruder_clearance_height_to_rod – → 36; extruder_clearance_height_to_lid – → 140; auxiliary_fan – → false

## Printers without a matching maker profile

- `snapmaker-u1`: Keeps the earlier verbatim Snapmaker Orca templates (Snapmaker profiles submodule, commit 1e201f6). The snorca clone used here has no Snapmaker machine directory, so it could not be checked again.
- `prusa-mk3s-mmu3`: No MK3S + MMU3 machine profile in OrcaSlicer. Keeps NexSpiro's MMU3 G-code (built on the MK3S+ start).
- `prusa-mk4s-mmu3`: Matched to OrcaSlicer's **Prusa MK4 MMU3 0.4 nozzle**, because there is no MK4S MMU3 profile. Its start G-code has the MK4 printer-model check, so check it on the printer. The change G-code stays NexSpiro's: Orca drives the MMU3 with plain T commands and the profile has none.
- `creality-k2plus-cfs`: Uses the K2 Plus profile, which covers the CFS. The change G-code comes from that profile.
- `creality-hi-cfs`: Uses OrcaSlicer's Creality Hi profile.
- `anycubic-kobra3-ace / anycubic-kobras1-ace`: Use the Kobra 3 / Kobra S1 profiles. The Kobra 3 profile has no change G-code, so NexSpiro's ACE Pro change G-code stays.
- `generic-marlin, generic-klipper, generic-klipper-mmu, generic-toolchanger, generic-idex`: Generic starting points with no maker. They keep NexSpiro's G-code. OrcaSlicer's Custom profiles ("MyMarlin", "MyKlipper", "MyToolChanger") are examples, not machine data.

## Still missing / limits

- Not imported: the profiles' `min_layer_height` / `max_layer_height` (e.g. 0.1–0.25 mm on the MK4 MMU3, 0.1 mm minimum on the Voron 0.1 and Ender-3 V3). They belong with the makers' own process presets and would put NexSpiro's 0.08 mm and 0.28 mm presets outside the printer's range. They need a decision on presets first.
- Machine values with no NexSpiro setting (jerk, per-axis limits, thumbnails, air filtration, chamber control, nozzle volume, load and unload times) are stored and passed to the templates, but they do not drive the engine. That needs option keys in machineParams.ts, which another agent owns. Suggested keys: `machine_max_jerk_x/y/z/e`, `machine_max_acceleration_travel`, `machine_max_acceleration_retracting`, `machine_max_speed_e`, `thumbnails`, `thumbnails_format`, `support_air_filtration`, `support_chamber_temp_control`, `emit_machine_limits_to_gcode`.
- H2D: NexSpiro prints with one nozzle (the left one, `filament_map` 1), so Bambu's dual-nozzle switching branches in the templates never run. `wrapping_detection_gcode` is shipped, but NexSpiro has no wrapping-detection hook, so it is never written to the G-code.
- `printing_by_object_gcode` and `machine_pause_gcode` are inserted without template expansion (slicer.ts). None of the shipped vendor values contains a placeholder, so the output is still exact.
- All matched profiles have their printable area origin at 0,0 (NexSpiro has no bed origin setting).
- Golden tests (tests/advanced/basic-golden.test.ts): the Voron 2.4, Prusa MK4S and Ender-3 V2 hashes change because those printers now run the makers' G-code, which is intended. The P1S hash changes too, but because of other in-progress work (toolpath and config-block changes), not this one: the P1S start and end G-code is byte-identical. None of the hashes is re-pinned here, because the new values would mix both changes.
- tests/advanced/phase3.test.ts "removes the retractions between loops" now counts retractions spread over a wipe as well (`G1 X… E-`). The X1 Carbon now has Bambu's `retract_before_wipe` 0 %, so it writes almost no bare `G1 E-` lines.

## Tests

- New: `tests/machine-gcode.test.ts`. For every generated profile it checks that templates, bed, flavour and key machine values equal the profile. For every printer it slices and checks that no template syntax, NaN or undefined is left, and that the maker's first start command and last end command appear in the output.
- Updated, because the X1 Carbon, A1 mini and K1 / K2 / Hi CFS now run their makers' G-code instead of NexSpiro's macros. The checks are the same, read from the makers' G-code: the purge comes from Bambu's `FLUSH_START`/`FLUSH_END` blocks (helper `bambuFlushes` in tests/fixtures.ts), the X1 Carbon timelapse line has no leading space, and the end of a change is Bambu's `M621 S<n>A`. Files: tests/multimaterial.test.ts, tests/settings-wiring.test.ts, tests/patternex/engine.test.ts, tests/motionex/weave.test.ts, tests/phase2.test.ts.
- tests/motionex/all-printers.test.ts:
  - The scan stops at the end-G-code marker (Elegoo's end G-code writes M204) and reads absolute E (Anycubic's Kobra 2 Max profile uses M82).
  - The Ender-3 V2 acceleration expectation is now 500 mm/s², from OrcaSlicer's profile.
  - The Bowden lace case pins `retraction_minimum_travel` 1 (Prusa MINI's own threshold is 1.5 mm).
- tests/advanced/phase3.test.ts: see above.
- Not caused by this change, so left alone: tests/stress/settings-edges.test.ts (`initial_layer_travel_speed`, `z_offset` on the A1, which is unchanged here) and tests/ux-prepare.test.ts.
