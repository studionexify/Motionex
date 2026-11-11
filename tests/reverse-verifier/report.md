# Batch reverse-verifier summary

Rows: 708, (target, profile) cells: 141, failing cells: 0, failing (target, assertion) pairs: 0

## Pass / fail grid

| Target | Default | Extreme Modulation | Boundary Edge-Cases |
|---|---|---|---|
| core/cube | PASS | PASS | PASS |
| core/cylinder | PASS | PASS | PASS |
| core/tee | PASS | PASS | PASS |
| core/vase | PASS | PASS | PASS |
| core/thick-bridge | PASS | PASS | PASS |
| core/width-mix | PASS | PASS | PASS |
| adv/fea_stress | PASS | PASS | PASS |
| adv/sdf_frep | PASS | PASS | PASS |
| adv/eulerian_spiral | PASS | PASS | PASS |
| adv/conformal_layers | PASS | PASS | PASS |
| adv/hot_on_hot | PASS | PASS | PASS |
| adv/kinematic_extrusion | PASS | PASS | PASS |
| adv/z_weave | PASS | PASS | PASS |
| adv/subvoxel_aa | PASS | PASS | PASS |
| adv/turing_infill | PASS | PASS | PASS |
| adv/corner_overshoot | PASS | PASS | PASS |
| adv/spatial_lattice | PASS | PASS | PASS |
| adv/metamaterial | PASS | PASS | PASS |
| adv/dovetail | PASS | PASS | PASS |
| adv/sgd_slicing | PASS | PASS | PASS |
| adv/eikonal_offsets | PASS | PASS | PASS |
| adv/inverse_warp | PASS | PASS | PASS |
| adv/gloss_modulation | PASS | PASS | PASS |
| adv/foam_control | PASS | PASS | PASS |
| adv/knot_braiding | PASS | PASS | PASS |
| adv/co_molding | PASS | PASS | PASS |
| adv/thick_vase | PASS | PASS | PASS |
| adv/tangent_entry | PASS | PASS | PASS |
| adv/scarf_splice | PASS | PASS | PASS |
| adv/harmonic_dome | PASS | PASS | PASS |
| adv/conformal_ironing | PASS | PASS | PASS |
| adv/perimeter_feathering | PASS | PASS | PASS |
| adv/iso_gloss | PASS | PASS | PASS |
| adv/quasicrystal | PASS | PASS | PASS |
| adv/metric_morph | PASS | PASS | PASS |
| adv/monge_ampere | PASS | PASS | PASS |
| adv/symplectic_shaper | PASS | PASS | PASS |
| adv/morse_router | PASS | PASS | PASS |
| adv/spinor_fields | PASS | PASS | PASS |
| adv/band_gap | PASS | PASS | PASS |
| adv/homogenization | PASS | PASS | PASS |
| plugin/motionex | PASS | PASS | PASS |
| plugin/hanex | PASS | PASS | PASS |
| plugin/bulnex | PASS | PASS | PASS |
| plugin/patternex | PASS | PASS | PASS |
| weave/z_weave-cylinder | PASS | PASS | PASS |
| weave/z_weave-pins-cylinder | PASS | PASS | PASS |

## Failing assertions

Type tags: VOLUME volumetric conservation, SAFETY finite/bed, RAMP non-planar angle, ENVELOPE, SIGNATURE spiro, CONTINUITY C0, WEAVE z-weave anti-phase, STATUS advanced tech not run, HARNESS declared-geometry / slice error.

| Target | Profile | Type | Assertion | Count | Worst | Feature breakdown (count, worst %) | Example (one message) |
|---|---|---|---|---|---|---|---|

`Worst` for volumetric is the locked maxRelErrPct (tolerance 2 %). Counts are exact (locked checker counts every failure; report keeps the first 5 in report.json).
