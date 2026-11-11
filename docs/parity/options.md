# Option parity: NexSpiro vs OrcaSlicer, Bambu Studio, Snapmaker Orca

Generated from the reference `PrintConfig.cpp` (option definitions), `Preset.cpp` (print / filament / printer preset key lists) and `Tab.cpp` (pages) of OrcaSlicer (`o`), Bambu Studio (`b`) and Snapmaker Orca (`s`), compared with `src/profiles/settings.ts`, `filamentParams.ts` and `machineParams.ts`. The extraction scripts live outside the repo; this file is their output plus the hand-made classification.

Reference keys considered (print + filament + printer presets, union of the three): 932. NexSpiro definitions after this change: 410 (print 269, filament 68, printer 73).

Every NexSpiro definition is read by the engine (enforced by `tests/settings-wiring.test.ts`), so an option is only added together with its behaviour; options that could not be implemented are listed under *Still missing* instead of being added as dummies.

## Added and implemented (217)

Defaults follow the references. Where an option exists only in OrcaSlicer / Snapmaker Orca and its reference default would change the G-code of every existing Bambu-style profile, the default is the neutral value that keeps the current output (marked *neutral*).

| key | type | tab / group | default | reference default | behaviour | test |
|---|---|---|---|---|---|---|
| `staggered_inner_seams` | print | Quality / Seam | `False` | o=false / s=false | inner wall seams shifted back by depth x line width | tests/parity-options.test.ts |
| `wipe_on_loops` | print | Quality / Seam | `False` | o=false / s=false | dry inward step after each outer wall loop | tests/parity-options.test.ts |
| `wipe_before_external_loop` | print | Quality / Seam | `False` | o=false / s=false | prime inside the part before an outer wall (outer/inner and inner/outer/inner orders) | tests/parity-options.test.ts |
| `role_based_wipe_speed` | print | Quality / Seam | `False` *neutral* | o=true / s=true | wipe at the last line type speed | tests/parity-options.test.ts |
| `elefant_foot_compensation_layers` | print | Quality / Precision | `1` | o=1 / s=1 | EFC tapered linearly over N layers | tests/parity-options.test.ts |
| `bottom_solid_infill_flow_ratio` | print | Quality / Advanced | `1` | o=1 / s=1 | bottom surface flow multiplier | tests/parity-options.test.ts |
| `set_other_flow_ratios` | print | Quality / Advanced | `False` | o=false | enables per-role flow ratios | tests/parity-options.test.ts |
| `outer_wall_flow_ratio` | print | Quality / Advanced | `1` | o=1 | per-role flow | tests/parity-options.test.ts |
| `inner_wall_flow_ratio` | print | Quality / Advanced | `1` | o=1 | per-role flow | tests/parity-options.test.ts |
| `overhang_flow_ratio` | print | Quality / Advanced | `1` | o=1 | per-role flow (per segment) | tests/parity-options.test.ts |
| `sparse_infill_flow_ratio` | print | Quality / Advanced | `1` | o=1 | per-role flow | tests/parity-options.test.ts |
| `internal_solid_infill_flow_ratio` | print | Quality / Advanced | `1` | o=1 | per-role flow | tests/parity-options.test.ts |
| `gap_fill_flow_ratio` | print | Quality / Advanced | `1` | o=1 | per-role flow | tests/parity-options.test.ts |
| `support_flow_ratio` | print | Quality / Advanced | `1` | o=1 | per-role flow | tests/parity-options.test.ts |
| `support_interface_flow_ratio` | print | Quality / Advanced | `1` | o=1 | per-role flow | tests/parity-options.test.ts |
| `wall_direction` | print | Quality / Advanced | `ccw` | o=WallDirection::CounterClockwise / s=WallDirection::Auto | contour / hole loop orientation enforced | tests/parity-options.test.ts |
| `bridge_density` | print | Strength / Advanced | `100` | o=100 / s=100 | external bridge line spacing | tests/parity-options.test.ts |
| `gap_fill_target` | print | Strength / Sparse infill | `everywhere` *neutral* | o=nowhere / s=nowhere | gap fill everywhere / top-bottom layers / nowhere | tests/parity-options.test.ts |
| `extra_solid_infills` | print | Strength / Sparse infill | `` |  | N, N#K and list rules make sparse layers solid | tests/parity-options.test.ts |
| `initial_layer_travel_speed` | print | Speed / Initial layer speed | `100%` | o=FloatOrPercent(100, true) / s=FloatOrPercent{100., true | first layer travel feed rate | tests/parity-options.test.ts |
| `slow_down_layers` | print | Speed / Initial layer speed | `0` | o=0 / s=0 | linear speed ramp after the first layer | tests/parity-options.test.ts |
| `skirt_speed` | print | Speed / Other layers speed | `0` *neutral* | o=50.0 / s=50.0 | skirt feed rate | tests/parity-options.test.ts |
| `travel_speed_z` | print | Speed / Travel speed | `0` | o=0. / b=0. / s=0. | Z hop / by-object rise feed rate | tests/parity-options.test.ts |
| `internal_solid_infill_acceleration` | print | Speed / Acceleration | `100%` | o=FloatOrPercent(100, true) / s=FloatOrPercent{100., true | M204 per role | tests/parity-options.test.ts |
| `bridge_acceleration` | print | Speed / Acceleration | `0` *neutral* | o=FloatOrPercent(50,true) / s=FloatOrPercent{50., true | M204 per role (% of outer wall accel) | tests/parity-options.test.ts |
| `initial_layer_travel_jerk` | print | Speed / Jerk(XY) | `100%` | o=FloatOrPercent(100, true) | first layer travel jerk | tests/parity-options.test.ts |
| `skirt_type` | print | Others / Bed adhesion | `combined` | o=stCombined / s=stCombined | combined / per-object skirt | tests/parity-options.test.ts |
| `skirt_start_angle` | print | Others / Bed adhesion | `-135` | o=-135 / s=-135 | skirt loop start angle | tests/parity-options.test.ts |
| `min_skirt_length` | print | Others / Bed adhesion | `0` | o=0.0 / s=0.0 | extra skirt loops until the filament length is reached | tests/parity-options.test.ts |
| `draft_shield` | print | Others / Bed adhesion | `disabled` | o=dsDisabled / b=dsDisabled / s=dsDisabled | skirt up to the tallest object | tests/parity-options.test.ts |
| `single_loop_draft_shield` | print | Others / Bed adhesion | `False` | o=false / s=false | one loop above layer 1 | tests/parity-options.test.ts |
| `brim_flow_ratio` | print | Others / Bed adhesion | `1` | o=1 | brim flow multiplier | tests/parity-options.test.ts |
| `gcode_comments` | print | Others / G-code output | `False` | o=0 / s=0 | comments on retract / travel / lift lines | tests/parity-options.test.ts |
| `activate_chamber_temp_control` | filament | Filament / Print temperature | `True` *neutral* | o=false / s=false | gates M141/M191 (chamber_temperatures is now also read per filament) | tests/parity-options.test.ts |
| `idle_temperature` | filament | Filament / Print temperature | `0` | o=0 / s=0 | standby temperature of parked heads (tool changers, ooze prevention) | tests/parity-options.test.ts |
| `filament_shrink` | filament | Filament / Basic information | `100` | o=100 / b=100 / s=100 | XY scale 100/shrink about each object centre | tests/parity-options.test.ts |
| `filament_shrinkage_compensation_z` | filament | Filament / Basic information | `100` | o=100 / s=100 | Z scale 100/shrink | tests/parity-options.test.ts |
| `initial_layer_fan_speed` | filament | Cooling / Part cooling fan | `-1` | o=-1 | exact layer-0 fan | tests/parity-options.test.ts |
| `support_material_interface_fan_speed` | filament | Cooling / Part cooling fan | `-1` | o=-1 / s=-1 | exact fan on support interfaces | tests/parity-options.test.ts |
| `z_offset` | printer | Basic information / Advanced | `0` | o=0 / s=0 | added to every written Z | tests/parity-options.test.ts |
| `use_firmware_retraction` | printer | Basic information / Advanced | `False` | o=false / b=false / s=false | G10 / G11 (dry wipe) | tests/parity-options.test.ts |
| `disable_m73` | printer | Basic information / Advanced | `False` | o=false / s=false | no M73 lines | tests/parity-options.test.ts |
| `fan_kickstart` | printer | Basic information / Cooling fan | `0` | o=0 / s=0 | M106 S255 + G4 before a low fan speed | tests/parity-options.test.ts |
| `change_extrusion_role_gcode` | printer | Machine G-code / Change extrusion role G-code | `` |  | inserted after every ;TYPE change with [extrusion_role]/[last_extrusion_role] | tests/parity-options.test.ts |
| `emit_machine_limits_to_gcode` | printer | Motion ability / Machine limits | `True` | o=true / s=true | M201/M203/M204/M205 for Marlin flavours | tests/parity-options.test.ts |
| `retract_lift_enforce` | printer | Extruder / Retraction | `all` | o=RetractLiftEnforceType ::rletAllSurfaces / s=RetractLiftEnforceType ::rletAllSurfaces | Z hop only over top / bottom surfaces | tests/parity-options.test.ts |
| `travel_slope` | printer | Extruder / Retraction | `3` | o=3 / s=3 | slope hop climb angle | tests/parity-options.test.ts |
| `retract_after_wipe` | printer | Extruder / Retraction | `0` | o=0 | fast retraction after the wipe | tests/parity-options.test.ts |
| `machine_max_speed_x` | printer | Motion ability / Machine limits | `0` *neutral* |  | written by emit_machine_limits_to_gcode | tests/parity-options.test.ts |
| `machine_max_acceleration_x` | printer | Motion ability / Machine limits | `0` *neutral* |  | written by emit_machine_limits_to_gcode | tests/parity-options.test.ts |
| `machine_max_jerk_x` | printer | Motion ability / Machine limits | `0` *neutral* |  | written by emit_machine_limits_to_gcode | tests/parity-options.test.ts |
| `machine_max_speed_y` | printer | Motion ability / Machine limits | `0` *neutral* |  | written by emit_machine_limits_to_gcode | tests/parity-options.test.ts |
| `machine_max_acceleration_y` | printer | Motion ability / Machine limits | `0` *neutral* |  | written by emit_machine_limits_to_gcode | tests/parity-options.test.ts |
| `machine_max_jerk_y` | printer | Motion ability / Machine limits | `0` *neutral* |  | written by emit_machine_limits_to_gcode | tests/parity-options.test.ts |
| `machine_max_speed_z` | printer | Motion ability / Machine limits | `0` *neutral* |  | written by emit_machine_limits_to_gcode | tests/parity-options.test.ts |
| `machine_max_acceleration_z` | printer | Motion ability / Machine limits | `0` *neutral* |  | written by emit_machine_limits_to_gcode | tests/parity-options.test.ts |
| `machine_max_jerk_z` | printer | Motion ability / Machine limits | `0` *neutral* |  | written by emit_machine_limits_to_gcode | tests/parity-options.test.ts |
| `machine_max_speed_e` | printer | Motion ability / Machine limits | `0` *neutral* |  | written by emit_machine_limits_to_gcode | tests/parity-options.test.ts |
| `machine_max_acceleration_e` | printer | Motion ability / Machine limits | `0` *neutral* |  | written by emit_machine_limits_to_gcode | tests/parity-options.test.ts |
| `machine_max_jerk_e` | printer | Motion ability / Machine limits | `0` *neutral* |  | written by emit_machine_limits_to_gcode | tests/parity-options.test.ts |
| `machine_max_acceleration_extruding` | printer | Motion ability / Machine limits | `0` *neutral* | o=1500., 1250. / b=1500., 1250. / s=1500., 1250. | written by emit_machine_limits_to_gcode and caps print acceleration | tests/parity-options.test.ts |
| `machine_max_acceleration_retracting` | printer | Motion ability / Machine limits | `0` *neutral* | o=1500., 1250. / b=1500., 1250. / s=1500., 1250. | written by emit_machine_limits_to_gcode | tests/parity-options.test.ts |
| `machine_max_acceleration_travel` | printer | Motion ability / Machine limits | `0` *neutral* | o=0., 0. / b=1500., 1250. / s=0., 0. | written by emit_machine_limits_to_gcode | tests/parity-options.test.ts |
| `machine_min_extruding_rate` | printer | Motion ability / Machine limits | `0` *neutral* | o=0., 0. / b=0., 0. / s=0., 0. | written by emit_machine_limits_to_gcode | tests/parity-options.test.ts |
| `machine_min_travel_rate` | printer | Motion ability / Machine limits | `0` *neutral* | o=0., 0. / b=0., 0. / s=0., 0. | written by emit_machine_limits_to_gcode | tests/parity-options.test.ts |
| `tree_support_angle_slow` | print | Support / Tree Support | `25` | o=25 / s=25 | Tree Organic: branches merge at this angle (avoidance keeps the branch angle) | tests/parity-support.test.ts |
| `tree_support_auto_brim` | print | Support / Tree Support | `False` *neutral* | o=true / s=true | non-organic tree feet grow by max(2, min(r + d_top / r * 0.5, 12)) - r on layer 1 | tests/parity-support.test.ts |
| `tree_support_branch_angle_organic` | print | Support / Tree Support | `40` | o=40. / s=40. | Tree Organic maximum branch angle (replaces tree_support_branch_angle) | tests/parity-support.test.ts |
| `tree_support_branch_diameter_organic` | print | Support / Tree Support | `2` | o=2. / s=2. | Tree Organic maximum branch diameter (replaces tree_support_branch_diameter) | tests/parity-support.test.ts |
| `tree_support_branch_distance_organic` | print | Support / Tree Support | `1` | o=1. / s=1. | Tree Organic tip row distance (replaces tree_support_branch_distance) | tests/parity-support.test.ts |
| `tree_support_brim_width` | print | Support / Tree Support | `0` *neutral* | o=3 / s=3 | fixed brim around non-organic tree feet on layer 1 | tests/parity-support.test.ts |
| `tree_support_top_rate` | print | Support / Tree Support | `30` | o=30 / s=30 | Tree Organic tip spacing along a row = line width * 100 / rate + max(tip diameter - line width, 0) | tests/parity-support.test.ts |
| `support_interface_loop_pattern` | print | Support / Advanced | `False` | o=false / b=false / s=false | loop around the top contact layer, interface pattern inside | tests/parity-support.test.ts |
| `small_support_perimeter_speed` | print | Speed / Other layers speed | `50%` | o=FloatOrPercent(50, true) | speed of short support paths (% of support / interface speed; 0 = 50%) | tests/parity-support.test.ts |
| `small_support_perimeter_threshold` | print | Speed / Other layers speed | `0` | o=0 | support paths up to 2*pi*threshold long are small | tests/parity-support.test.ts |
| `enforce_support_layers` | print | Support / Support | `0` | o=0 / b=0 / s=0 | first N layers: every overhang supported, angle ignored, even with support off | tests/parity-support.test.ts |
| `raft_expansion` | print | Support / Raft | `1.5` | o=1.5 / b=1.5 / s=1.5 | raft layers grown by this (was a fixed 1.5 mm) | tests/parity-support.test.ts |
| `brim_ears_detection_length` | print | Others / Bed adhesion | `0` *neutral* | o=1 / s=1 | Douglas-Peucker decimation before auto ear corner detection | tests/parity-support.test.ts |
| `brim_ears_max_angle` | print | Others / Bed adhesion | `125` | o=125 / s=125 | auto ears on convex corners sharper than this (was a fixed 125) | tests/parity-support.test.ts |
| `brim_ears_outer_only` | print | Others / Bed adhesion | `False` | o=false | false: auto ears also on hole corners; true: no ears in holes or on enclosed parts | tests/parity-support.test.ts |
| `brim_use_efc_outline` | print | Others / Bed adhesion | `True` *neutral* | o=false | brim follows the EFC outline (true, previous behaviour) or the uncompensated one | tests/parity-support.test.ts |
| `combine_brims` | print | Others / Bed adhesion | `False` | o=false | brims of all objects merged into one area and filled once (not per-object skirt / by object) | tests/parity-support.test.ts |
| `wipe_tower_bridging` | print | Others / Prime tower | `10` | o=10 / s=10 | sparse tower line spacing capped at the bridging distance | tests/parity-mmu.test.ts |
| `wipe_tower_cone_angle` | print | Others / Prime tower | `30` | o=30 | stabilization cone radius tan(a/2)·(top−z) | tests/parity-mmu.test.ts |
| `wipe_tower_extra_flow` | print | Others / Prime tower | `100` | o=100 | purge line flow, spaced to match | tests/parity-mmu.test.ts |
| `wipe_tower_extra_spacing` | print | Others / Prime tower | `100` | o=100 | purge line spacing / tower depth | tests/parity-mmu.test.ts |
| `wipe_tower_filament` | print | Others / Prime tower | `0` | o=0 | tower walls printed with that filament when it is on the layer | tests/parity-mmu.test.ts |
| `wipe_tower_max_purge_speed` | print | Others / Prime tower | `90` | o=90 | speed cap of purge bands | tests/parity-mmu.test.ts |
| `wipe_tower_no_sparse_layers` | print | Others / Prime tower | `False` | o=false / b=false | no tower on layers without a change; nozzle goes down to the tower top | tests/parity-mmu.test.ts |
| `wipe_tower_rotation_angle` | print | Others / Prime tower | `0` | o=0 | tower body, bands and MMU moves rotated about the centre | tests/parity-mmu.test.ts |
| `wipe_tower_sparse_layers_combination` | print | Others / Prime tower | `False` | o=false | sparse tower layers merged up to the max layer height | tests/parity-mmu.test.ts |
| `wipe_tower_wall_type` | print | Others / Prime tower | `rib` | o=wtwRib | rectangle / cone / rib (rib = prime_tower_rib_wall) | tests/parity-mmu.test.ts |
| `prime_tower_enable_framework` | print | Others / Prime tower | `True` *neutral* | o=false / b=false | on: full depth every layer (previous behaviour); off: depth of the bands still needed above | tests/parity-mmu.test.ts |
| `tool_change_on_wipe_tower` | printer | Basic information / Multi-material | `False` | o=false | tool changers travel over the tower before the change | tests/parity-mmu.test.ts |
| `wait_for_temp_on_wipe_tower` | printer | Basic information / Multi-material | `False` | o=false | M109 over the tower when the new filament has another temperature | tests/parity-mmu.test.ts |
| `filament_minimal_purge_on_wipe_tower` | filament | Advanced / Multimaterial | `15` | o=15 / b=15 / s=15 | floor of the tower band volume | tests/parity-mmu.test.ts |
| `wiping_volumes_extruders` | print | Others / Prime tower | ```` *neutral* | o=70,70,… | purge p→n = unload[p] + load[n] when no flushing matrix | tests/parity-mmu.test.ts |
| `single_extruder_multi_material_priming` | print | Others / Prime tower | `False` | o=false | prime line of each used filament at the front edge on layer 1 | tests/parity-mmu.test.ts |
| `enable_filament_ramming` | printer | Basic information / Single extruder multi-material | `False` *neutral* | o=true | MMU unload/load sequence on the tower (tower-purging filament units); vendor values flow through | tests/parity-mmu.test.ts |
| `filament_ramming_parameters` | filament | Advanced / Toolchange parameters (SEMM) | `o default` | o=120 100 6.6 … | ramming line width / step / mm³/s per 0.25 s | tests/parity-mmu.test.ts |
| `filament_multitool_ramming` | filament | Advanced / Toolchange parameters (multi-tool) | `False` | o=false | tool changer ramming on the tower before parking | tests/parity-mmu.test.ts |
| `filament_multitool_ramming_flow` | filament | Advanced / Toolchange parameters (multi-tool) | `10` | o=10 | ramming flow | tests/parity-mmu.test.ts |
| `filament_multitool_ramming_volume` | filament | Advanced / Toolchange parameters (multi-tool) | `10` | o=10 | ramming volume | tests/parity-mmu.test.ts |
| `filament_cooling_moves` | filament | Advanced / Toolchange parameters (SEMM) | `4` | o=4 | cooling moves in the cooling tube | tests/parity-mmu.test.ts |
| `filament_cooling_initial_speed` | filament | Advanced / Toolchange parameters (SEMM) | `2.2` | o=2.2 | first cooling move speed | tests/parity-mmu.test.ts |
| `filament_cooling_final_speed` | filament | Advanced / Toolchange parameters (SEMM) | `3.4` | o=3.4 | last cooling move speed | tests/parity-mmu.test.ts |
| `cooling_tube_length` | printer | Basic information / Single extruder multi-material | `5` | o=5 | cooling move travel | tests/parity-mmu.test.ts |
| `cooling_tube_retraction` | printer | Basic information / Single extruder multi-material | `91.5` | o=91.5 | unload pull to the cooling tube | tests/parity-mmu.test.ts |
| `parking_pos_retraction` | printer | Basic information / Single extruder multi-material | `92` | o=92 | park move / load distance | tests/parity-mmu.test.ts |
| `extra_loading_move` | printer | Basic information / Single extruder multi-material | `-2` | o=-2 | added to the load distance | tests/parity-mmu.test.ts |
| `filament_loading_speed` | filament | Advanced / Toolchange parameters (SEMM) | `28` | o=28 | fast load phase | tests/parity-mmu.test.ts |
| `filament_loading_speed_start` | filament | Advanced / Toolchange parameters (SEMM) | `3` | o=3 | first load phase | tests/parity-mmu.test.ts |
| `filament_unloading_speed` | filament | Advanced / Toolchange parameters (SEMM) | `90` | o=90 | unload pull | tests/parity-mmu.test.ts |
| `filament_unloading_speed_start` | filament | Advanced / Toolchange parameters (SEMM) | `100` | o=100 | first 15 mm after ramming | tests/parity-mmu.test.ts |
| `filament_stamping_distance` | filament | Advanced / Toolchange parameters (SEMM) | `0` | o=0 | stamping between cooling moves | tests/parity-mmu.test.ts |
| `filament_stamping_loading_speed` | filament | Advanced / Toolchange parameters (SEMM) | `0` | o=0 | stamping speed | tests/parity-mmu.test.ts |
| `filament_toolchange_delay` | filament | Advanced / Toolchange parameters (SEMM) | `0` | o=0 | G4 before parking | tests/parity-mmu.test.ts |
| `high_current_on_filament_swap` | printer | Basic information / Single extruder multi-material | `False` | o=false | M907 E750 / E550 around the swap | tests/parity-mmu.test.ts |
| `deretract_speed_extruder_change` | printer | Extruder / Retraction | `0` | o=0 | first deretraction speed after a change | tests/parity-mmu.test.ts |
| `preheat_steps` | print | Others / Prime tower | `1` | o=1 | parked head preheat repeated over the preheat time | tests/parity-mmu.test.ts |
| `activate_air_filtration` | filament | Cooling / Exhaust fan | `False` | o=false | M106 P3 exhaust fan | tests/parity-mmu.test.ts |
| `activate_air_filtration_during_print` | filament | Cooling / Exhaust fan | `True` | o=true | exhaust fan at the print start | tests/parity-mmu.test.ts |
| `activate_air_filtration_on_completion` | filament | Cooling / Exhaust fan | `True` | o=true | exhaust fan before the end G-code | tests/parity-mmu.test.ts |
| `during_print_exhaust_fan_speed` | filament | Cooling / Exhaust fan | `60` | o=60 | speed (max over filaments) | tests/parity-mmu.test.ts |
| `complete_print_exhaust_fan_speed` | filament | Cooling / Exhaust fan | `80` | o=80 | speed (max over filaments) | tests/parity-mmu.test.ts |
| `chamber_minimal_temperature` | filament | Filament / Print temperature | `0` | o=0 | template variable only (no M141/M191) | tests/parity-mmu.test.ts |
| `adaptive_pressure_advance` | filament | Filament / Basic information | `False` | o=false | PCHIP PA model per line type | tests/parity-mmu.test.ts |
| `adaptive_pressure_advance_bridges` | filament | Filament / Basic information | `0` | o=0 | static PA on bridges | tests/parity-mmu.test.ts |
| `adaptive_pressure_advance_model` | filament | Filament / Basic information | `0,0,0\n0,0,0` | o=same | pa,flow,accel measurements | tests/parity-mmu.test.ts |
| `adaptive_pressure_advance_overhangs` | filament | Filament / Basic information | `False` | o=false | PA re-evaluated on flow changes inside a feature | tests/parity-mmu.test.ts |
| `default_junction_deviation` | print | Speed / Jerk(XY) | `0` | o=0 | M205 J (Marlin), capped at the machine maximum | tests/parity-mmu.test.ts |
| `machine_max_junction_deviation` | printer | Motion ability / Machine limits | `0` *neutral* | o=0.01 | M205 J in machine limits; cap | tests/parity-mmu.test.ts |
| `part_cooling_fan_min_pwm` | printer | Basic information / Cooling fan | `0` | o=0 | non-zero fan raised to at least this | tests/parity-mmu.test.ts |
| `farthest_point_timelapse` | printer | Basic information / Advanced | `False` | o=false / b=false | traditional snapshot at the farthest point of the last layer | tests/parity-mmu.test.ts |
| `filament_change_extrusion_role_gcode` | filament | Advanced / Change extrusion role G-code | ```` | o=`` | after the printer role G-code | tests/parity-mmu.test.ts |
| `process_change_extrusion_role_gcode` | print | Others / G-code output | ```` | o=`` | after the filament role G-code | tests/parity-mmu.test.ts |
| `calib_flowrate_topinfill_special_order` | print | Others / G-code output | `False` | o=false | top Archimedean chords keep order, spiral inside-out last | tests/parity-mmu.test.ts |
| `supertack_plate_temp` | filament | Filament / Print temperature | `35` | o=35 / b=35 | new plate type Cool Plate SuperTack (Bambu printers) | tests/parity-mmu.test.ts |
| `supertack_plate_temp_initial_layer` | filament | Filament / Print temperature | `35` | o=35 / b=35 | new plate type | tests/parity-mmu.test.ts |
| `textured_cool_plate_temp` | filament | Filament / Print temperature | `40` | o=40 | new plate type Textured Cool Plate (Bambu printers) | tests/parity-mmu.test.ts |
| `textured_cool_plate_temp_initial_layer` | filament | Filament / Print temperature | `40` | o=40 | new plate type | tests/parity-mmu.test.ts |
| `adaptive_infill_gradient` | print | Strength / Sparse infill | `linear` | o=Linear | density curve of adaptive gyroid | tests/parity-infill.test.ts |
| `adaptive_infill_interior_density` | print | Strength / Sparse infill | `5` | o=5 | gyroid density at the centre | tests/parity-infill.test.ts |
| `adaptive_infill_mode` | print | Strength / Sparse infill | `disabled` | o=Disabled | gyroid graded in distance shells (normal Z/Y/X: in-plane / one axis; other modes add Z distance; all modes are stepped shells, no warp/blend) | tests/parity-infill.test.ts |
| `align_infill_direction_to_model` | print | Strength / Advanced | `False` | o=false | infill / solid / bridge / ironing / top-bottom angles + object Z rotation | tests/parity-infill.test.ts |
| `bottom_layer_direction` | print | Strength / Top/bottom shells | `-1` | o=-1 | fixed bottom surface angle | tests/parity-infill.test.ts |
| `top_layer_direction` | print | Strength / Top/bottom shells | `-1` | o=-1 | fixed top surface (and ironing) angle | tests/parity-infill.test.ts |
| `bottom_surface_fill_order` | print | Strength / Top/bottom shells | `default` | o=Default | centre-based bottom patterns outward / inward, order kept | tests/parity-infill.test.ts |
| `top_surface_fill_order` | print | Strength / Top/bottom shells | `default` | o=Default | centre-based top patterns outward / inward, order kept | tests/parity-infill.test.ts |
| `center_of_surface_pattern` | print | Strength / Top/bottom shells | `each_surface` | o=Each_Surface | spiral centre per surface / island / object | tests/parity-infill.test.ts |
| `gyroid_optimized` | print | Strength / Sparse infill | `False` | o=false | gyroid Z frequency x omega (Orca formula) | tests/parity-infill.test.ts |
| `infill_combination_max_layer_height` | print | Strength / Advanced | `100%` | o=100% | combined block height | tests/parity-infill.test.ts |
| `infill_complete_top` | print | Strength / Sparse infill | `False` | o=false | 3D honeycomb cell tops on the turning layer | tests/parity-infill.test.ts |
| `infill_lock_depth` | print | Strength / Sparse infill | `1` | o=1 | new Locked Zag pattern: skeleton reaches into the 2 mm skin (skin depth / densities fixed at Orca defaults; skin_infill_* not added) | tests/parity-infill.test.ts |
| `infill_overhang_angle` | print | Strength / Sparse infill | `60` | o=60 | new Lateral Honeycomb pattern | tests/parity-infill.test.ts |
| `infill_shift_step` | print | Strength / Sparse infill | `0.4` | o=0.4 | new Cross Zag / Locked Zag patterns (Zig Zag added too) | tests/parity-infill.test.ts |
| `lateral_lattice_angle_1` | print | Strength / Sparse infill | `-45` | o=-45 | new Lateral Lattice pattern | tests/parity-infill.test.ts |
| `lateral_lattice_angle_2` | print | Strength / Sparse infill | `45` | o=45 | new Lateral Lattice pattern | tests/parity-infill.test.ts |
| `sparse_infill_lattice_angle_1` | print | Strength / Sparse infill | `-45` | b=-45 | new 2D Lattice pattern | tests/parity-infill.test.ts |
| `sparse_infill_lattice_angle_2` | print | Strength / Sparse infill | `45` | b=45 | new 2D Lattice pattern | tests/parity-infill.test.ts |
| `solid_infill_rotate_template` | print | Strength / Advanced | `` | o="" | per-layer solid angle (list, +a, a%, #K) | tests/parity-infill.test.ts |
| `sparse_infill_rotate_template` | print | Strength / Advanced | `` | o="" | per-layer sparse angle (list, +a, a%, #K; Orca metalanguage subset) | tests/parity-infill.test.ts |
| `sparse_infill_smooth_factor` | print | Strength / Sparse infill | `0` | o=0 | rounded sparse corners | tests/parity-infill.test.ts |
| `separated_infills` | print | Strength / Advanced | `False` | o=false | pattern anchored on each object centre | tests/parity-infill.test.ts |
| `symmetric_infill_y_axis` | print | Strength / Sparse infill | `False` | o=false | Zig Zag family mirrored about the object centre | tests/parity-infill.test.ts |
| `top_surface_expansion` | print | Strength / Top/bottom shells | `0` | o=0 | top surfaces grown before classification | tests/parity-infill.test.ts |
| `top_surface_expansion_direction` | print | Strength / Top/bottom shells | `inward_and_outward` | o=InwardAndOutward | closing / outer edge / both | tests/parity-infill.test.ts |
| `top_surface_expansion_margin` | print | Strength / Top/bottom shells | `0` | o=0 | kept off untouched walls | tests/parity-infill.test.ts |
| `min_width_top_surface` | print | Quality / Advanced | `0` *neutral* | o=300% | one-wall-top threshold (max with top_area_threshold) | tests/parity-infill.test.ts |
| `top_bottom_infill_wall_overlap` | print | Strength / Top/bottom shells | `-1` *neutral* | o=25% | top/bottom overlap into inner wall; -1 = infill_wall_overlap | tests/parity-infill.test.ts |
| `lightning_overhang_angle` | print | Strength / Sparse infill | `45` | o=45 | wall supporting radius trims seeds | tests/parity-infill.test.ts |
| `lightning_prune_angle` | print | Strength / Sparse infill | `45` | o=45 | tip prune distance | tests/parity-infill.test.ts |
| `lightning_straightening_angle` | print | Strength / Sparse infill | `45` | o=45 | branch node straightening | tests/parity-infill.test.ts |
| `ironing_angle` | print | Quality / Ironing | `0` | o=0 | offset added to ironing / top direction | tests/parity-infill.test.ts |
| `ironing_angle_fixed` | print | Quality / Ironing | `False` | o=false | absolute ironing angle | tests/parity-infill.test.ts |
| `ironing_expansion` | print | Quality / Ironing | `0` | o=0 | ironed area grown / shrunk | tests/parity-infill.test.ts |
| `filament_ironing_flow` | filament | Setting overrides / Ironing | `-1` | o=nil | per-filament ironing flow (-1 = process) | tests/parity-infill.test.ts |
| `filament_ironing_inset` | filament | Setting overrides / Ironing | `-1` | o=nil | per-filament ironing inset | tests/parity-infill.test.ts |
| `filament_ironing_spacing` | filament | Setting overrides / Ironing | `-1` | o=nil | per-filament ironing spacing | tests/parity-infill.test.ts |
| `filament_ironing_speed` | filament | Setting overrides / Ironing | `-1` | o=nil | per-filament ironing speed | tests/parity-infill.test.ts |
| `internal_bridge_angle` | print | Strength / Advanced | `0` | o=0 | internal bridge direction (0 = auto) | tests/parity-infill.test.ts |
| `internal_bridge_density` | print | Strength / Advanced | `100` | o=100 | internal bridge spacing | tests/parity-infill.test.ts |
| `internal_bridge_fan_speed` | filament | Cooling / Part cooling fan | `-1` | o=-1 | exact fan on internal bridges | tests/parity-infill.test.ts |
| `internal_bridge_flow` | print | Quality / Advanced | `1` | o=1 | internal bridge flow | tests/parity-infill.test.ts |
| `internal_bridge_speed` | print | Speed / Other layers speed | `150%` | o=150% | internal bridge speed (new `internal bridge` line type) | tests/parity-infill.test.ts |
| `thick_internal_bridges` | print | Quality / Advanced | `True` | o=true | nozzle-thick internal bridges | tests/parity-infill.test.ts |
| `dont_filter_internal_bridges` | print | Quality / Advanced | `disabled` | o=ibfDisabled | internal bridges: Filter keeps Bambu floating-shell handling while detect_floating_vertical_shell is on; limited / nofilter (or detection off) make internal bridges | tests/parity-infill.test.ts |
| `enable_extra_bridge_layer` | print | Quality / Advanced | `disabled` | o=eblDisabled | second bridge layer over external / internal bridges | tests/parity-infill.test.ts |
| `bridge_line_width` | print | Quality / Line width | `0` *neutral* | o=100% | external bridge width | tests/parity-infill.test.ts |
| `relative_bridge_angle` | print | Strength / Advanced | `False` | o=false | bridge angles added to the auto angle | tests/parity-infill.test.ts |
| `small_area_infill_flow_compensation` | print | Quality / Advanced | `False` | o=false | PCHIP flow model on short solid lines | tests/parity-infill.test.ts |
| `small_area_infill_flow_compensation_model` | print | Quality / Advanced | `Orca` | o=model | length,factor pairs | tests/parity-infill.test.ts |
| `elefant_foot_layers_density` | print | Quality / Precision | `100` | o=100 | internal solid density on EFC layers | tests/parity-infill.test.ts |
| `top_color_penetration_layers` | print | Strength / Top/bottom shells | `0` | o=0 | painted top face reach downward | tests/parity-infill.test.ts |
| `bottom_color_penetration_layers` | print | Strength / Top/bottom shells | `0` | o=0 | painted bottom face reach upward | tests/parity-infill.test.ts |
| `hole_to_polyhole` | print | Quality / Precision | `False` | o=false / s=false | almost circular holes spanning layers become regular polygons | tests/parity-walls.test.ts |
| `hole_to_polyhole_max_edges` | print | Quality / Precision | `50` | o=50 | polyhole edge limit | tests/parity-walls.test.ts |
| `hole_to_polyhole_threshold` | print | Quality / Precision | `0.01` | o=0.01 / s=0.01 | circle detection margin (mm or % of radius) | tests/parity-walls.test.ts |
| `hole_to_polyhole_twisted` | print | Quality / Precision | `True` | o=true / s=true | 5 rotated polyholes cycled by layer | tests/parity-walls.test.ts |
| `make_overhang_printable` | print | Quality / Advanced | `False` | o=false / s=false | conical overhangs: layers grow by the layer above shrunk by tan(angle)·h | tests/parity-walls.test.ts |
| `make_overhang_printable_angle` | print | Quality / Advanced | `55` | o=55 / s=55 | cone angle | tests/parity-walls.test.ts |
| `make_overhang_printable_hole_size` | print | Quality / Advanced | `0` | o=0 / s=0 | covered base holes below this area stay open | tests/parity-walls.test.ts |
| `overhang_reverse` | print | Quality / Advanced | `False` | o=false / s=false | overhanging islands' walls reversed on even layers | tests/parity-walls.test.ts |
| `overhang_reverse_internal_only` | print | Quality / Advanced | `False` | o=false / s=false | only inner walls reversed | tests/parity-walls.test.ts |
| `overhang_reverse_threshold` | print | Quality / Advanced | `50%` | o=50% / s=50% | overhang needed for reversal | tests/parity-walls.test.ts |
| `extra_perimeters_on_overhangs` | print | Quality / Advanced | `False` | o=false / s=false | unsupported infill area filled with anchored overhang wall loops | tests/parity-walls.test.ts |
| `unsupported_wall_last` | print | Quality / Advanced | `False` | o=false | loops fully in mid air printed after the other walls, innermost first | tests/parity-walls.test.ts |
| `slowdown_for_curled_perimeters` | print | Speed / Other layers speed | `False` | o=false / s=true | walls over last layer's overhang walls capped at the 75% overhang speed | tests/parity-walls.test.ts |
| `scarf_joint_flow_ratio` | print | Quality / Seam | `1` | o=1 / s=1 | flow multiplier on scarf ramp + overlap | tests/parity-walls.test.ts |
| `scarf_joint_speed` | print | Quality / Seam | `100%` | o=100% / s=100% | speed cap on scarf ramp + overlap | tests/parity-walls.test.ts |
| `scarf_overhang_threshold` | print | Quality / Seam | `40` | o=40 / s=40 | no scarf when this share of the loop is unsupported | tests/parity-walls.test.ts |
| `fuzzy_skin_ripples_per_layer` | print | Others / Special mode | `15` | o=15 | ripple noise (new `ripple` noise type) cycles per loop | tests/parity-walls.test.ts |
| `fuzzy_skin_ripple_offset` | print | Others / Special mode | `50` | o=50 | ripple phase shift per layer period | tests/parity-walls.test.ts |
| `fuzzy_skin_layers_between_ripple_offset` | print | Others / Special mode | `1` | o=1 | layers per ripple phase | tests/parity-walls.test.ts |
| `wall_maximum_resolution` | print | Quality / Wall generator | `0` *neutral* | o=0.5 | Arachne wall point reduction (Cura meshfix) | tests/parity-walls.test.ts |
| `wall_maximum_deviation` | print | Quality / Wall generator | `0.025` | o=0.025 | deviation limit of the reduction | tests/parity-walls.test.ts |
| `min_length_factor` | print | Quality / Wall generator | `0.5` | o=0.5 / s=0.5 | Arachne open thin walls shorter than factor·width dropped | tests/parity-walls.test.ts |
| `initial_layer_min_bead_width` | print | Quality / Wall generator | `85` | o=85 / s=85 | Arachne min bead on the first layer | tests/parity-walls.test.ts |
| `wipe_inward` | print | Quality / Seam | `False` | o=false | wipe after the outer wall shifted toward the inner walls | tests/parity-walls.test.ts |
| `wipe_inward_distance` | print | Quality / Seam | `50%` | o=50% | shift, capped at the wall width (half with outer-first orders) | tests/parity-walls.test.ts |
| `interlocking_beam` | print | Others / Advanced | `False` | o=false / b=false / s=false | boundary band between filament regions split into alternating beams | tests/parity-walls.test.ts |
| `interlocking_beam_width` | print | Others / Advanced | `0.8` | o=0.8 | beam width | tests/parity-walls.test.ts |
| `interlocking_orientation` | print | Others / Advanced | `22.5` | o=22.5 | beam direction | tests/parity-walls.test.ts |
| `interlocking_beam_layer_count` | print | Others / Advanced | `2` | o=2 | layers per beam direction | tests/parity-walls.test.ts |
| `interlocking_depth` | print | Others / Advanced | `2` | o=2 | cells each side of the boundary | tests/parity-walls.test.ts |
| `interlocking_boundary_avoidance` | print | Others / Advanced | `2` | o=2 | cells kept off the outside | tests/parity-walls.test.ts |
| `print_order` | print | Others / Special mode | `as_obj_list` *neutral* | o=default / s=default | default = nearest object next; as_obj_list = list order | tests/parity-walls.test.ts |
| `spiral_starting_flow_ratio` | print | Others / Special mode | `1` *neutral* | o=0 / s=0 | first spiral loop flow ramps from this ratio (1 = no ramp, the old output) | tests/parity-walls.test.ts |
| `spiral_finishing_flow_ratio` | print | Others / Special mode | `1` *neutral* | o=0 / s=0 | below 1: extra flat top loop with falling flow | tests/parity-walls.test.ts |
| `high_precision_gcode` | print | Others / G-code output | `False` | o=false | 4 decimals XYZIJ, 6 for E | tests/parity-walls.test.ts |
| `max_volumetric_extrusion_rate_slope_segment_length` | print | Speed / Jerk(XY) | `3` | o=3 / s=3 | extrusions split for the pressure equalizer | tests/parity-walls.test.ts |
| `extrusion_rate_smoothing_external_perimeter_only` | print | Speed / Jerk(XY) | `False` | o=false / s=false | equalizer only on outer walls / overhangs / bridges | tests/parity-walls.test.ts |
| `fan_speedup_time` | printer | Basic information / Cooling fan | `0` | o=0 / s=0 | fan rises start N s of printing early | tests/parity-walls.test.ts |
| `fan_speedup_overhangs` | printer | Basic information / Cooling fan | `True` | o=true / s=true | only overhang / bridge fan rises moved | tests/parity-walls.test.ts |
| `seam_position` = `aligned_back` | print | Quality / Seam | – | o / s | aligned seams starting at the back | tests/parity-walls.test.ts |
| `fuzzy_skin` = `hole` | print | Others / Special mode | – | o | fuzzy skin on hole outer walls only | tests/parity-walls.test.ts |

## Fixed

- `chamber_temperatures` (filament): was defined but the engine read only `chamber_temperature`; the engine now reads the filament value per slot and writes M141 / M191 when `activate_chamber_temp_control` is on (default on, keeping the Bambu-style behaviour; Orca's default is off).
- Z hop: `travel_slope` replaces the hard-coded slope ramp (hop x 3); `travel_speed_z` replaces the hard-coded use of the Z speed limit; first layer travel speed was a hard-coded 250 mm/s cap and is now `initial_layer_travel_speed` (a percentage keeps the old cap).
- Machine limits were only used for the time estimate; Marlin printers now get them in the G-code (`emit_machine_limits_to_gcode`).

### Default / range / enum differences left as they are

These keys exist in NexSpiro with a different default or enum spelling. The reference defaults are the C++ fallback values that every vendor profile overrides; NexSpiro's defaults are the tuned values of its own process presets (and are overridden per printer the same way), so they were not changed. Enum *value spellings* differ by design (NexSpiro stores snake_case keys and maps the vendor spellings on import, e.g. `Normal Lift` -> `normal`, `normal(auto)` -> `normal_auto`, `inner wall/outer wall` -> `inner_outer`). Real enum gaps are listed under *Still missing*.

| key | preset | difference |
|---|---|---|
| `bridge_speed` | print | def nex=50 ref: orca=25 / bambu=25 / snorca=25. |
| `brim_object_gap` | print | def nex=0.1 ref: orca=0. / bambu=0. / snorca=0. |
| `brim_type` | print | def nex=auto_brim ref: orca=btAutoBrim / bambu=btAutoBrim / snorca=btAutoBrim |
| `brim_width` | print | def nex=5 ref: orca=0. / bambu=0. / snorca=0. |
| `default_acceleration` | print | def nex=10000 ref: orca=500.0 / bambu=500.0 / snorca=500.0 |
| `default_wipe_tower_pos` | printer | def nex= ref: bambu=Vec2d(0.644, 0.977) |
| `deretraction_speed` | printer | def nex=30 ref: orca=0. / bambu=0. / snorca=0. |
| `elefant_foot_compensation` | print | def nex=0.15 ref: orca=0. / bambu=0. / snorca=0. |
| `enable_arc_fitting` | print | def nex=True ref: orca=ArcFittingMode::Disabled / bambu=0 / snorca=0 |
| `enable_prime_tower` | print | def nex=True ref: orca=false / bambu=false / snorca=false |
| `eng_plate_temp` | filament | def nex=55 ref: orca=45 / bambu=45 / snorca=45 |
| `eng_plate_temp_initial_layer` | filament | def nex=55 ref: orca=45 / bambu=45 / snorca=45 |
| `ensure_vertical_shell_thickness` | print | def nex=enabled ref: orca=EnsureVerticalShellThickness::evstAll / bambu=EnsureVerticalThicknessLevel::evtEnabled / snorca=EnsureVerticalShellThickness::evstAll; enum missing ensure_all,ensure_critical_only,ensure_moderate,none; enum extra disabled,enabled,partial |
| `extruder_clearance_height_to_lid` | printer | def nex=250 ref: orca=120 / bambu=120 / snorca=120 |
| `extruder_clearance_height_to_rod` | printer | def nex=25 ref: orca=40 / bambu=40 / snorca=40 |
| `extruder_clearance_max_radius` | printer | def nex=65 ref: bambu=68 |
| `fan_cooling_layer_time` | filament | def nex=100 ref: orca=60.0f / bambu=60 / snorca=60.0f |
| `fan_min_speed` | filament | def nex=100 ref: orca=20 / bambu=20 / snorca=20 |
| `filament_cost` | filament | def nex=20 ref: orca=0. / bambu=0. / snorca=0. |
| `filament_density` | filament | def nex=1.24 ref: orca=0. / bambu=0. / snorca=0. |
| `filament_flow_ratio` | filament | def nex=0.98 ref: orca=1. / bambu=1. / snorca=1. |
| `filament_max_volumetric_speed` | filament | def nex=21 ref: orca=2. / bambu=2. / snorca=2. |
| `filament_scarf_gap` | filament | def nex=0 ref: bambu=FloatOrPercent(0, 0) |
| `filament_scarf_height` | filament | def nex=10% ref: bambu=FloatOrPercent(10, true) |
| `filament_scarf_seam_type` | filament | def nex=none ref: bambu=0 |
| `filament_vendor` | filament | def nex=Generic ref: orca=L("(Undefined)") / bambu=L("(Undefined)") / snorca=L("(Undefined)") |
| `filename_format` | print | def nex=[input_filename_base]_[layer_height]mm_[filament_type]_[print_time].gcode ref: orca={input_filename_base}_{filament_type[initial_tool]}_{print_time}.gcode / bambu=[input_filename_base].gcode / snorca={input_filename_base}_{filament_type[initial_tool]}_{print_time}.gcode |
| `fuzzy_skin` | print | def nex=none ref: orca=FuzzySkinType::Disabled_fuzzy / bambu=FuzzySkinType::None / snorca=FuzzySkinType::None (hole added) |
| `fuzzy_skin_mode` | print | def nex=displacement ref: orca=FuzzySkinMode::Displacement / bambu=FuzzySkinMode::Displacement / snorca=FuzzySkinMode::Displacement |
| `fuzzy_skin_noise_type` | print | def nex=classic ref: orca=NoiseType::Classic / bambu=NoiseType::Classic / snorca=NoiseType::Classic (ripple added) |
| `gap_infill_speed` | print | def nex=250 ref: orca=30 / bambu=30 / snorca=30. |
| `hot_plate_temp` | filament | def nex=55 ref: orca=45 / bambu=45 / snorca=45 |
| `hot_plate_temp_initial_layer` | filament | def nex=55 ref: orca=45 / bambu=45 / snorca=45 |
| `initial_layer_acceleration` | print | def nex=500 ref: orca=300 / bambu=300 / snorca=300. |
| `initial_layer_infill_speed` | print | def nex=105 ref: orca=60.0 / bambu=60.0 / snorca=60. |
| `initial_layer_line_width` | print | def nex=0.5 ref: orca=0., false / bambu=0.4 / snorca=0., false |
| `initial_layer_speed` | print | def nex=50 ref: orca=30 / bambu=30 / snorca=30. |
| `initial_layer_travel_acceleration` | print | def nex=6000 ref: orca=FloatOrPercent(100, true) / bambu=500.0 |
| `inner_wall_line_width` | print | def nex=0.45 ref: orca=0., false / bambu=0.4 / snorca=0., false |
| `inner_wall_speed` | print | def nex=300 ref: orca=60 / bambu=60 / snorca=60. |
| `internal_solid_infill_line_width` | print | def nex=0.42 ref: orca=0., false / bambu=0.4 / snorca=0., false |
| `internal_solid_infill_pattern` | print | def nex=rectilinear ref: orca=monotonic / bambu=zig-zag / snorca=monotonicline |
| `internal_solid_infill_speed` | print | def nex=250 ref: orca=100 / bambu=100 / snorca=100. |
| `ironing_pattern` | print | enum extra archimedeanchords |
| `ironing_spacing` | print | def nex=0.15 ref: orca=0.1 / bambu=0.1 / snorca=0.1 |
| `ironing_speed` | print | def nex=30 ref: orca=20 / bambu=20 / snorca=20. |
| `ironing_type` | print | def nex=no_ironing ref: orca=IroningType::NoIroning / bambu=IroningType::NoIroning / snorca=IroningType::NoIroning; enum missing no ironing; enum extra no_ironing |
| `line_width` | print | def nex=0.42 ref: orca=0, false / bambu=0.4 / snorca=0, false |
| `machine_end_gcode` | printer | def nex= ref: orca=M104 S0 ; turn off temperature\nG28 X0  ; home X axis\nM84     ; disable motors\n / bambu=M104 S0 ; turn off temperature\nG28 X0  ; home X axis\nM84     ; disable motors\n / snorca=M104 S0 ; turn off temperature\nG28 X0  ; home X axis\nM84     ; disable motors\n |
| `machine_pause_gcode` | printer | def nex=M601 ref: orca=None / bambu= / snorca=None |
| `machine_start_gcode` | printer | def nex= ref: orca=G28 ; home all axes\nG1 Z5 F5000 ; lift nozzle\n / bambu=G28 ; home all axes\nG1 Z5 F5000 ; lift nozzle\n / snorca=G28 ; home all axes\nG1 Z5 F5000 ; lift nozzle\n |
| `max_layer_height` | printer | def nex=0.28 ref: orca=0. / bambu=0. / snorca=0. |
| `min_layer_height` | printer | def nex=0.08 ref: orca=0.07 / bambu=0.07 / snorca=0.07 |
| `nozzle_temperature` | filament | def nex=220 ref: orca=200 / bambu=200 / snorca=200 |
| `nozzle_temperature_initial_layer` | filament | def nex=220 ref: orca=200 / bambu=200 / snorca=200 |
| `ooze_prevention` | print | def nex=True ref: orca=false / bambu=false / snorca=false |
| `outer_wall_acceleration` | print | def nex=5000 ref: orca=500 / bambu=500 / snorca=500. |
| `outer_wall_line_width` | print | def nex=0.42 ref: orca=0., false / bambu=0 / snorca=0., false |
| `outer_wall_speed` | print | def nex=200 ref: orca=60 / bambu=60 / snorca=60. |
| `overhang_2_4_speed` | print | def nex=50 ref: orca=FloatOrPercent(0, false) / bambu=0 / snorca=FloatOrPercent{0., false |
| `overhang_3_4_speed` | print | def nex=30 ref: orca=FloatOrPercent(0, false) / bambu=0 / snorca=FloatOrPercent{0., false |
| `overhang_4_4_speed` | print | def nex=10 ref: orca=FloatOrPercent(0, false) / bambu=0 / snorca=FloatOrPercent{0., false |
| `overhang_fan_threshold` | filament | def nex=25% ref: orca=(int)Overhang_threshold_bridge / bambu=(int)Overhang_threshold_bridge / snorca=(int)Overhang_threshold_bridge |
| `print_sequence` | print | def nex=by_layer ref: orca=PrintSequence::ByLayer / bambu=PrintSequence::ByLayer / snorca=PrintSequence::ByLayer; enum missing by layer,by object; enum extra by_layer,by_object |
| `reduce_fan_stop_start_freq` | filament | def nex=True ref: orca=false / bambu=false / snorca=false |
| `reduce_infill_retraction_mode` | print | def nex=auto ref: bambu=rirAuto; enum missing Auto,Disabled,Enabled; enum extra auto,disabled,enabled |
| `resolution` | print | def nex=0.012 ref: orca=0.01 / bambu=0.01 / snorca=0.01 |
| `retract_length_toolchange` | printer | def nex=2 ref: orca=10. / bambu=10. / snorca=10. |
| `retraction_minimum_travel` | printer | def nex=1 ref: orca=2. / bambu=2. / snorca=2. |
| `seam_position` | print | aligned_back added |
| `seam_slope_type` | print | def nex=none ref: orca=SeamScarfType::None / bambu=SeamScarfType::None / snorca=SeamScarfType::None |
| `skirt_loops` | print | def nex=0 ref: orca=1 / bambu=1 / snorca=1 |
| `slicing_mode` | print | def nex=regular ref: orca=SlicingMode::Regular / bambu=SlicingMode::Regular / snorca=SlicingMode::Regular |
| `slow_down_layer_time` | filament | def nex=4 ref: orca=5.0f / bambu=5 / snorca=5.0f |
| `slow_down_min_speed` | filament | def nex=20 ref: orca=10. / bambu=10. / snorca=10. |
| `small_perimeter_speed` | print | def nex=50% ref: orca=FloatOrPercent(50, true) / bambu=FloatOrPercent(50, true) / snorca=FloatOrPercent{50., true |
| `sparse_infill_acceleration` | print | def nex=100% ref: orca=FloatOrPercent(100, true) / bambu=FloatOrPercent(100, true) / snorca=FloatOrPercent{100., true |
| `sparse_infill_density` | print | def nex=15 ref: orca=20 / bambu=20 / snorca=20 |
| `sparse_infill_line_width` | print | def nex=0.45 ref: orca=0., false / bambu=0.4 / snorca=0., false |
| `sparse_infill_pattern` | print | def nex=grid ref: orca=crosshatch / bambu=cubic / snorca=crosshatch; enum missing alignedrectilinear,crosszag,lateral-honeycomb,lateral-lattice,lockedzag,quartercubic,tpmsd,tpmsfk,zigzag; enum extra aligned_rectilinear |
| `sparse_infill_speed` | print | def nex=270 ref: orca=100 / bambu=100 / snorca=100. |
| `standby_temperature_delta` | print | def nex=-40 ref: orca=-5 / bambu=-5 / snorca=-5 |
| `support_interface_pattern` | print | enum missing spiralinset |
| `support_interface_top_layers` | print | def nex=2 ref: orca=3 / bambu=3 / snorca=3 |
| `support_line_width` | print | def nex=0.42 ref: orca=0., false / bambu=0.4 / snorca=0., false |
| `support_speed` | print | def nex=150 ref: orca=80 / bambu=80 / snorca=80. |
| `support_style` | print | enum missing organic; enum extra tree_organic |
| `support_type` | print | def nex=normal_auto ref: orca=normal(auto) / bambu=normal(auto) / snorca=normal(auto); enum missing normal(auto),normal(manual),tree(auto),tree(manual); enum extra normal_auto,normal_manual,tree_auto,tree_manual |
| `textured_plate_temp` | filament | def nex=55 ref: orca=45 / bambu=45 / snorca=45 |
| `textured_plate_temp_initial_layer` | filament | def nex=55 ref: orca=45 / bambu=45 / snorca=45 |
| `timelapse_type` | print | def nex=traditional ref: orca=tlTraditional / bambu=tlTraditional / snorca=tlTraditional |
| `top_one_wall_type` | print | def nex=all_top ref: bambu=TopOneWallType::Alltop; enum missing all top,not apply; enum extra all_top,not_apply |
| `top_shell_layers` | print | def nex=5 ref: orca=4 / bambu=4 / snorca=4 |
| `top_shell_thickness` | print | def nex=1 ref: orca=0.6 / bambu=0.6 / snorca=0.6 |
| `top_surface_acceleration` | print | def nex=2000 ref: orca=500 / bambu=500 / snorca=500. |
| `top_surface_line_width` | print | def nex=0.42 ref: orca=0., false / bambu=0.4 / snorca=0., false |
| `top_surface_pattern` | print | def nex=monotonic ref: orca=monotonicline / bambu=zig-zag / snorca=monotonicline; enum missing alignedrectilinear,spiralinset; enum extra aligned_rectilinear |
| `top_surface_speed` | print | def nex=200 ref: orca=100 / bambu=100 / snorca=100. |
| `travel_speed` | print | def nex=500 ref: orca=120 / bambu=120 / snorca=120. |
| `tree_support_branch_diameter` | print | def nex=6 ref: orca=5. / bambu=5. / snorca=5. |
| `tree_support_branch_distance` | print | def nex=4 ref: orca=5. / bambu=5. / snorca=5. |
| `tree_support_tip_diameter` | print | def nex=1.6 ref: orca=0.8 / bambu=0.8 / snorca=0.8 |
| `vertical_shell_speed` | print | def nex=80% ref: bambu=FloatOrPercent(80, true) |
| `wall_generator` | print | def nex=classic ref: orca=PerimeterGeneratorType::Arachne / bambu=PerimeterGeneratorType::Arachne / snorca=PerimeterGeneratorType::Arachne |
| `wall_sequence` | print | def nex=inner_outer ref: orca=WallSequence::InnerOuter / bambu=WallSequence::InnerOuter / snorca=WallSequence::InnerOuter; enum missing inner wall/outer wall,inner-outer-inner wall,outer wall/inner wall; enum extra inner_outer,inner_outer_inner,outer_inner |
| `z_hop_types` | printer | def nex=normal ref: orca=ZHopType::zhtSlope / bambu=ZHopType::zhtSpiral / snorca=ZHopType::zhtSlope; enum missing Auto Lift,Normal Lift,Slope Lift,Spiral Lift; enum extra auto,normal,slope,spiral |

## Covered under another NexSpiro key (24)

| reference key | preset | NexSpiro key |
|---|---|---|
| `chamber_temperature` | filament | `chamber_temperatures` |
| `dont_slow_down_outer_wall` | filament | `no_slow_down_for_cooling_on_outwalls` |
| `first_layer_flow_ratio` | print | `initial_layer_flow_ratio` |
| `infill_anchor` | print | `sparse_infill_anchor` |
| `infill_anchor_max` | print | `sparse_infill_anchor_max` |
| `machine_load_filament_time` | printer | `filament_change_time` |
| `machine_tool_change_time` | printer | `filament_change_time` |
| `machine_unload_filament_time` | printer | `filament_change_time` |
| `manual_filament_change` | printer | `changer_type` |
| `max_volumetric_extrusion_rate_slope` | print | `max_volumetric_extrusion_rate_slope_positive / _negative` |
| `only_one_wall_top` | print | `top_one_wall_type` |
| `preheat_time` | print | `tool_preheat_time` |
| `print_in_clockwise` | printer | `wall_direction` |
| `purge_in_prime_tower` | printer | `purge_target` |
| `reduce_infill_retraction` | print | `reduce_infill_retraction_mode` |
| `retraction_distances_when_cut` | printer | `retract_length_toolchange` |
| `role_base_wipe_speed` | print | `role_based_wipe_speed` |
| `single_extruder_multi_material` | printer | `changer_type` |
| `skirt_per_object` | print | `skirt_type` |
| `support_ironing` | print | `enable_support_ironing` |
| `wipe_tower_extra_rib_length` | print | `prime_tower_extra_rib_length` |
| `wipe_tower_fillet_wall` | print | `prime_tower_fillet_wall` |
| `wipe_tower_rib_width` | print | `prime_tower_rib_width` |
| `wipe_tower_wall_gap` | print | `prime_tower_infill_gap` |

## Still missing (3)

User-facing options not implemented in this pass (no definition added, so nothing in the UI pretends to work). Engine-level notes where relevant.

| key | preset | in | label | note |
|---|---|---|---|---|
| `exclude_object_tolerance` | print | o | Outline tolerance | not done: NexSpiro writes the bounding rectangle (4 points) to EXCLUDE_OBJECT_DEFINE, so there is no outline to thin; writing the real outline would change existing Klipper G-code |
| `extra_brim_width` | print | o | Extra brim width | belt printers only in OrcaSlicer (no effect unless belt_printer); NexSpiro has no belt printer mode |
| `leading_brim_length` | print | o | Leading brim length | belt printers only in OrcaSlicer (no effect unless belt_printer); NexSpiro has no belt printer mode |

## Skipped (327)

### Vendor cloud, internal or GUI-only metadata

`bbl_use_printhost`, `bed_custom_model`, `bed_custom_texture`, `bottom_surface_filament_id`, `compatible_printers`, `compatible_printers_condition`, `compatible_prints`, `compatible_prints_condition`, `default_bed_type`, `default_filament_profile`, `default_print_profile`, `extruder_type`, `extruder_variant_list`, `filament_extruder_variant`, `filament_idle_travel_cooling_enabled`, `gcode_label_objects`, `host_type`, `inherits`, `inner_wall_filament_id`, `internal_solid_filament_id`, `master_extruder_id`, `notes`, `nozzle_volume_type`, `outer_wall_filament_id`, `pellet_flow_coefficient`, `pellet_modded_printer`, `print_extruder_id`, `print_extruder_variant`, `print_host`, `print_host_webui`, `printer_extruder_id`, `printer_extruder_variant`, `printer_model`, `printer_structure`, `printer_variant`, `printhost_apikey`, `printhost_authorization_type`, `printhost_cafile`, `printhost_password`, `printhost_port`, `printhost_ssl_ignore_revoke`, `printhost_user`, `scan_first_layer`, `sparse_infill_filament_id`, `support_air_filtration`, `support_chamber_temp_control`, `support_multi_bed_types`, `thumbnail_size`, `thumbnails`, `thumbnails_format`, `top_surface_filament_id`, `upward_compatible_machine`, `wrapping_detection_gcode`, `wrapping_detection_layers`, `wrapping_exclude_area`

Reason: preset bookkeeping (compatible_*, inherits, *_settings_id, versions, printer model / variant ids), print-host / cloud upload, thumbnails, per-feature filament ids (NexSpiro keeps feature filaments in its own keys) and GUI bed models.

### Printer profile fields owned by `src/profiles/printers.ts`

`adaptive_bed_mesh_margin`, `bed_exclude_area`, `bed_mesh_max`, `bed_mesh_min`, `bed_mesh_probe_distance`, `bed_temperature_formula`, `best_object_pos`, `cooling_filter_enabled`, `default_filament_colour`, `extruder_clearance_dist_to_rod`, `extruder_clearance_radius`, `extruder_colour`, `extruder_offset`, `file_start_gcode`, `gcode_flavor`, `gcode_skip_config_block`, `head_wrap_detect_zone`, `nozzle_diameter`, `nozzle_height`, `nozzle_hrc`, `nozzle_type`, `nozzle_volume`, `preferred_orientation`, `printable_area`, `printable_height`, `printer_agent`, `printer_technology`, `silent_mode`, `support_cooling_filter`, `support_fast_purge_mode`, `support_object_skip_flush`, `template_custom_gcode`, `time_cost`, `use_3mf`

Reason: these are part of each printer profile (bed shape, flavour, nozzle, bed mesh, start G-code helpers) rather than editable options in NexSpiro's printer pages, and that file is maintained separately.

### Hardware- or fork-specific

`ams_filament_load_time_ams` (b), `ams_filament_load_time_ams_lite` (b), `ams_filament_load_time_n3f_s` (b), `ams_filament_unload_time_ams` (b), `ams_filament_unload_time_ams_lite` (b), `ams_filament_unload_time_n3f_s` (b), `ams_nozzle_idx` (b), `apply_scarf_seam_on_circles` (b), `aux_fan_independent_control` (b), `aux_fan_standard_side` (b), `avoid_crossing_wall_includes_support` (b), `bed_exclude_volume_mode` (o), `bed_exclude_volumes` (o), `bed_heat_soak_area` (b), `belt_frame_tilt_angle` (o), `belt_frame_tilt_decouple` (o), `belt_printer` (o), `belt_printer_infinite_y` (o), `belt_purge_tower_object` (o), `belt_purge_tower_width` (o), `belt_slice_rotation` (o), `belt_slice_rotation_angle` (o), `belt_support_floor_offset` (o), `build_plate_tilt_x` (o), `build_plate_tilt_y` (o), `circle_compensation_manual_offset` (b), `circle_compensation_speed` (b), `close_optional_fan_first_x_layers` (b), `conformal_hub_radius` (b), `conformal_infill` (b), `conformal_link_flip_layers` (b), `conformal_link_keep_layers` (b), `conformal_pole` (b), `conformal_ray_count` (b), `conformal_stagger` (b), `cooling_perimeter_transition_distance` (bs), `cooling_slowdown_logic` (bs), `counter_coef_1` (b), `counter_coef_2` (b), `counter_coef_3` (b), `counter_limit_max` (b), `counter_limit_min` (b), `counterbore_hole_bridging` (obs), `default_ams_type` (b), `default_nozzle_volume_type` (ob), `delta_temperature` (s), `diameter_limit` (b), `dithering_local_z_infill` (s), `dithering_local_z_mode` (s), `dithering_local_z_whole_objects` (s), `embedding_wall_into_infill` (b), `enable_belt_purge_tower` (o), `enable_change_pressure_when_wiping` (s), `enable_circle_compensation` (b), `enable_long_retraction_when_cut` (obs), `enable_mixed_color_sublayer` (ob), `enable_order_independent_overlap_carving` (b), `enable_power_loss_recovery` (o), `enable_pre_heating` (ob), `enable_tower_interface_cooldown_during_tower` (os), `enable_tower_interface_features` (obs), `enable_wrapping_detection` (ob), `external_infill_margin` (s), `extruder_bed_exclude_volumes` (o), `extruder_max_nozzle_count` (ob), `extruder_printable_area` (ob), `extruder_printable_height` (ob), `fan_direction` (ob), `filament_adaptive_volumetric_speed` (ob), `filament_adhesiveness_category` (obs), `filament_change_length` (ob), `filament_change_length_nc` (ob), `filament_cooling_before_tower` (ob), `filament_dev_ams_drying_ams_limitations` (ob), `filament_dev_ams_drying_heat_distortion_temperature` (ob), `filament_dev_ams_drying_temperature` (ob), `filament_dev_ams_drying_time` (ob), `filament_dev_chamber_drying_bed_temperature` (ob), `filament_dev_chamber_drying_time` (ob), `filament_dev_drying_cooling_temperature` (ob), `filament_dev_drying_softening_temperature` (ob), `filament_extruder_compatibility` (ob), `filament_flow_support` (s), `filament_flush_temp` (ob), `filament_flush_temp_fast` (ob), `filament_flush_volumetric_speed` (ob), `filament_is_high_temperature` (s), `filament_metal_stickiness` (b), `filament_pre_cooling_temperature` (ob), `filament_pre_cooling_temperature_nc` (ob), `filament_pre_heating_enabled` (b), `filament_preheat_temperature_delta` (ob), `filament_prime_tower_speed_factor_curve` (b), `filament_prime_volume_nc` (ob), `filament_printable` (ob), `filament_ramming_travel_time` (ob), `filament_ramming_travel_time_nc` (ob), `filament_ramming_volumetric_speed` (ob), `filament_ramming_volumetric_speed_nc` (ob), `filament_retract_length_nc` (ob), `filament_tower_interface_pre_extrusion_dist` (obs), `filament_tower_interface_pre_extrusion_length` (obs), `filament_tower_interface_print_temp` (obs), `filament_tower_interface_purge_volume` (ob), `filament_tower_ironing_area` (obs), `filament_velocity_adaptation_factor` (b), `fill_multiline` (obs), `fins_extrude_safe_temp` (b), `first_layer_travel_acceleration` (s), `first_layer_travel_jerk` (s), `first_x_layer_optional_fan_speed` (b), `flashforge_serial_number` (o), `grab_length` (ob), `graphic_effect_plate_temp` (s), `graphic_effect_plate_temp_initial_layer` (s), `group_algo_with_time` (ob), `handle_hotend_as_extruder` (b), `hole_coef_1` (b), `hole_coef_2` (b), `hole_coef_3` (b), `hole_limit_max` (b), `hole_limit_min` (b), `hotend_cooling_rate` (ob), `hotend_cooling_rate_on_rack` (b), `hotend_heating_rate` (ob), `imex_carriage_margin` (o), `imex_firmware_managed_zones` (o), `imex_gantry_count` (o), `imex_head_filament_map` (o), `imex_mode_active_tools` (o), `imex_mode_gcodes` (o), `imex_mode_names` (o), `imex_nozzle_clearance_x` (o), `imex_nozzle_clearance_y` (o), `imex_parallel_mode` (o), `imex_tool_layout` (o), `imex_tools_per_gantry` (o), `imex_viz_theme` (o), `impact_strength_z` (b), `infill_rotate_step` (b), `input_shaping_damp_x` (o), `input_shaping_damp_y` (o), `input_shaping_emit` (o), `input_shaping_freq_x` (o), `input_shaping_freq_y` (o), `input_shaping_type` (o), `internal_bridge_support_thickness` (b), `is_imex` (o), `local_z_wipe_tower_purge_lines` (s), `locked_skeleton_infill_pattern` (b), `locked_skin_infill_pattern` (b), `long_retractions_when_cut` (obs), `long_retractions_when_ec` (ob), `machine_bed_mass_Y` (ob), `machine_hotend_change_time` (ob), `machine_max_force_Y` (ob), `machine_max_printed_mass` (ob), `machine_prepare_compensation_time` (ob), `machine_switch_extruder_time` (b), `max_resonance_avoidance_speed` (os), `min_resonance_avoidance_speed` (os), `min_temperature_when_ec` (b), `modifier_ignore_infill` (b), `nozzle_flush_dataset` (ob), `optional_cooling_fan_speed` (b), `optional_fan_full_speed_layer` (b), `overhang_threshold_participating_cooling` (bs), `override_process_overhang_speed` (b), `parallel_printheads_bed_exclude_areas` (o), `parallel_printheads_count` (o), `periodic_modifier` (b), `periodic_modifier_apply_layers` (b), `periodic_modifier_skip_layers` (b), `physical_extruder_map` (ob), `plugins` (o), `pre_start_fan_time` (b), `prime_tower_acceleration` (b), `prime_tower_brim_chamfer` (s), `prime_tower_brim_chamfer_max_width` (s), `prime_tower_feedrate_factor` (b), `prime_tower_flat_ironing` (ob), `prime_tower_ironing_speed` (b), `prime_tower_lift_height` (b), `prime_tower_lift_speed` (b), `prime_tower_line_ironing` (b), `prime_tower_line_width` (b), `prime_tower_ramming_line_width` (b), `prime_tower_side_scrape` (b), `prime_tower_side_scrape_along_length` (b), `prime_tower_side_scrape_face` (b), `prime_tower_side_scrape_height` (b), `prime_tower_side_scrape_length` (b), `prime_tower_side_scrape_point_spacing` (b), `prime_tower_side_scrape_speed` (b), `prime_tower_side_scrape_wall_gap` (b), `prime_tower_skip_points` (ob), `prime_tower_tail_slowdown_volume` (b), `prime_tower_tail_speed_factor` (b), `prime_tower_wipe_distance` (b), `prime_tower_wipe_speed` (b), `printer_flow_support` (s), `printer_nozzle_diameter_mode` (b), `process_flow_support` (s), `ramming_line_width_ratio` (s), `ramming_pressure_advance_value` (s), `required_nozzle_HRC` (obs), `resonance_avoidance` (os), `retraction_distances_when_ec` (ob), `skeleton_infill_density` (obs), `skeleton_infill_line_width` (obs), `skin_infill_density` (obs), `skin_infill_depth` (obs), `skin_infill_line_width` (obs), `slicing_pipeline_plugin` (o), `smooth_coefficient` (b), `smooth_speed_discontinuity_area` (b), `support_interface_min_area` (s), `support_parallel_printheads` (o), `support_threshold_overlap` (os), `support_transition_flow_ratio` (s), `support_transition_perimeter` (s), `support_transition_speed` (s), `sync_auxiliary_fan_to_second_fan` (b), `temperature_vitrification` (obs), `tool_change_temprature_wait` (s), `toolchange_cyclic_first_layer` (o), `toolchange_cyclic_order` (o), `toolchange_ordering` (o), `tree_support_adaptive_layer_height` (s), `tree_support_transition_layers` (s), `volumetric_speed_coefficients` (ob), `wipe_tower_type` (o), `z_direction_outwall_speed_continuous` (b), `z_hop_when_prime` (s), `zaa_dont_alternate_fill_direction` (o), `zaa_enabled` (o), `zaa_min_z` (o), `zaa_minimize_perimeter_height` (o)

Reason: specific to hardware NexSpiro does not drive (belt printers, IMEX / parallel heads, Bambu H2D nozzle racks and AMS drying, Snapmaker U1 tower interface and filament pre-heat, Flashforge serials, input shaping macros), or experimental fork features (ZAA, dithering, conformal infill, locked skin / skeleton infill, plugins).


## NexSpiro options not in any reference (47)

`outline_smoothing`, `outline_smoothing_corner`, `max_volumetric_extrusion_rate_slope_positive`, `max_volumetric_extrusion_rate_slope_negative`, `prime_tower_x`, `prime_tower_y`, `flush_volume`, `mmu_paint_depth`, `mix_subdivide`, `mix_subdivide_full_domain`, `mix_subdivide_infill`, `filament_retraction_length`, `filament_z_hop`, `filament_z_hop_types`, `filament_retraction_speed`, `filament_deretraction_speed`, `filament_retract_restart_extra`, `filament_retraction_minimum_travel`, `filament_retract_when_changing_layer`, `filament_wipe`, `filament_wipe_distance`, `filament_retract_before_wipe`, `changer_type`, `filament_change_time`, `purge_target`, `filament_slots`, `toolhead_count`, `tool_prime_volume`, `tool_preheat_time`, `preheat_delta_temperature`, `tool_off_after_last_use`, `tool_map`, `max_speed_xy`, `max_speed_z`, `max_acceleration`, `machine_max_speed_x`, `machine_max_speed_y`, `machine_max_speed_z`, `machine_max_speed_e`, `machine_max_acceleration_x`, `machine_max_acceleration_y`, `machine_max_acceleration_z`, `machine_max_acceleration_e`, `machine_max_jerk_x`, `machine_max_jerk_y`, `machine_max_jerk_z`, `machine_max_jerk_e`


## Defined but not read by engine code under src/engine (15)

All of these are read elsewhere (`src/profiles/resolve.ts` maps the `filament_*` retraction overrides and plate temperatures, `src/profiles/changer.ts` reads `purge_target`) or are metadata written into the config block (`process_notes`, `filename_format`); `tests/settings-wiring.test.ts` checks every key is referenced.

`mmu_paint_depth`, `filename_format`, `process_notes`, `filament_retraction_length`, `filament_z_hop`, `filament_z_hop_types`, `filament_retraction_speed`, `filament_deretraction_speed`, `filament_retract_restart_extra`, `filament_retraction_minimum_travel`, `filament_retract_when_changing_layer`, `filament_wipe`, `filament_wipe_distance`, `filament_retract_before_wipe`, `purge_target`
