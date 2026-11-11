# NexSpiro Advanced engine (Physics Core)

The header's centre toggle switches the slicing engine:

- **BASIC (Classic Engine)** — the classic heuristic slicer, unchanged. `tests/advanced/basic-golden.test.ts` pins its G-code byte for byte.
- **ADVANCED (NexSpiro Physics Core)** — every part is analysed, split into zones, and compiled with the subset of the 35 technologies that the selected **intent**, the **tools** switched on and the **machine** call for.

## Tools

The sidebar does not list the 35 technologies one by one. They are grouped into **15 tools** by what they
do to the print (`src/engine/advanced/tools.ts`): technologies that do the same job sit behind one toggle.
Each tool says what happens when it is on, and lists its technologies as ticks (an exclusive tool runs
exactly one, as a mode). Switching a tool overrides the intent for its technologies; with no switch, the
intent decides as before. The distance field (#2) and the topology router (#32) change no toolpath and
are always on.

| Tool | Technologies (plain name — compendium #) |
| --- | --- |
| Smooth curved surfaces | Sloped-wall smoothing #8, Rounded-side shingling #26, Curved top skins #4, Curved-surface ironing #25 |
| Curved layers | Dome-following layers #24, Overhang-reducing layers #14 |
| Hide seams | Spiral seam entry #22, Scarf seam joint #23 |
| Continuous spiral printing | Helical layers #21, Spiral infill #3 |
| Even inner walls | Smooth wall offsets #15 |
| Gloss control | Even sheen #27, Painted matte / gloss #17 |
| Strength infill | Stress-line infill #1, Stress-line smoothing #33, Isotropic core infill #28, Organic rib infill #9 |
| Layer bonding | Hot layer welds #5, Z-wave interlock #7, Braided inner walls #19 |
| Stiffness targeting | Stiffness-matched cells #35 |
| Warp compensation | Shrinkage pre-distortion #16 |
| Multi-material interlock | Material finger joint #13 |
| Vibration-damping infill | Band-gap lattice #34, Auxetic cell infill #12 |
| Motion compensation | Corner flow control #6, Sharp-corner overshoot #10, Anti-ringing timing #31 |
| Foaming filament control | Foam temperature control #18 |
| Special print mode (one at a time) | Wire truss #11, Casting shell #20, Heat-morph sheet #29, Caustic lens / lampshade #30 |

The compendium names used below (e.g. "Harmonic scalar field dome slicing") are kept as each technology's
`technique` and shown in its tooltip and in the node graph.

## Pipeline

```
meshes ─▶ fields ─▶ router ─▶ layer plan ─▶ regions ─▶ walls ─▶ infill ─▶ toolpath passes ─▶ plugins ─▶ rheology & motion ─▶ G-code
          (SDF,      (zones,    (curved-layer  (ports,    (PDE     (stress,   (helix, seams,       (Motionex,   (gloss, thermal,
          curvature, Reeb       warp field)    dovetails)  offsets) lattices)  weaving, ironing…)   Patternex)   foam, kinematics)
          thickness) graph)
```

| Stage | Where | Hook |
| --- | --- | --- |
| Fields & zones | `analysis.ts`, `sdf.ts`, `meshfields.ts`, `sections.ts` | `analyzePart()` |
| Layer plan | curved layers are a Z warp `z = z′ + dz(x, y, z′)`; meshes are warped, sliced flat, and every move is un-warped | `TechModule.warp` |
| Regions | cross-section edits before walls | `TechModule.reshape` |
| Walls / infill | replace the classic generator for one island or sparse region | `TechModule.walls`, `TechModule.infill` |
| Toolpath passes | edit the ordered move list (`LayerOps`) before plugins | `TechModule.post` |
| Rheology & motion | speeds, flow, fan and temperature on the final move list | `TechModule.finalize` |

Modules are listed in pipeline order in `src/engine/advanced/modules/index.ts`. A technology runs only when it is enabled (intent default or user override) **and** the machine model allows it.

## Machine capability model

`machine.ts` derives, for every printer profile: kinematics, axis count, firmware features (input shaping, pressure advance, arcs), Z limits, hotend flow, chamber, material changer, frame resonance, and the **head clearance** — the steepest slope a non-planar move can follow before the heater block or fan duct reaches printed plastic:

`θ_max = min over head volumes of atan((lift − margin) / reach)`, with `reach` the farthest point of the volume's footprint from the nozzle (the worst slope direction). Stock A1/P1/X1 heads give ≈ 11°, a Revo/Stealthburner ≈ 15–20°, a 5-axis machine is not limited by it.

Every technology has a `mould()` rule returning *ok*, *adapted* (runs in a reduced or machine-specific form, with the reason) or *unavailable* (with the reason). Users can edit the capability model (tip length, resonance, flow, chamber, kinematics up to 5-axis) for modified or future machines.

## Zones

| Zone | Found by |
| --- | --- |
| Domes / shallow slopes | up-facing triangles, slope 1–35°, mean curvature |
| Curved walls | slope 35–80° |
| Overhangs | down-facing beyond the support angle |
| High-stress necks | cross-section area minima (< 60 % of both neighbours) |
| Bosses / holes | round holes (circularity > 0.85, r 0.8–12 mm) on ≥ 3 planes |
| Helical zones | steady single-island Z bands (area change < 5 %) |
| Cores | voxels deeper than the shell plus two lines |
| Thin walls / interfaces | wall thickness along the inward normal; paint-colour boundaries |

## Verification

- `tests/advanced/phase1.test.ts`: SDF against analytic distances, curvature (Gauss–Bonnet), thickness, topology (genus), zone detection, slicing in every intent on A1/P1/X1, Klipper and Marlin machines.
- `tests/advanced/basic-golden.test.ts`: Basic-mode G-code hashes.

## Phase 2 — field, PDE & geometric solvers

| Piece | File | Method |
| --- | --- | --- |
| Linear solvers | `solvers.ts` | Jacobi-PCG (3D Laplace with Dirichlet/Neumann cells), multigrid-preconditioned CG for 2D (screened) Poisson, sparse Jacobi-PCG for thin bands |
| Harmonic dome field (#24) | `harmonic.ts` | ∇²φ = 0, φ = 0 on bed cells, φ = 1 on cells under dome/shallow triangles, zero flux elsewhere. Per column, warped height z′ = H·φ(z) is inverted to a displacement d(x, y, z′); a per-column conformity λ keeps every layer under 75 % of the clearance slope, then a global scale enforces slope ≤ 80 % of θ_max and layer ratio within [min, max] |
| Curved layers | `warp.ts` | Meshes are warped z → z′ (bisection on the monotone map), sliced flat, and every move is mapped back with adaptive splitting where the layer bends more than 0.01 mm from the chord; extrusion × ∂z/∂z′. The first 0.45 mm stays flat and the warp fades in over 1.2 mm |
| SGD slicing (#14) | `sgd.ts` | Tensor-product cubic B-spline d(x, y, z′); L = w₁ overhang (angle to the tilted layer under the support threshold) + w₂ clearance (slope over the limit) + w₃ anisotropy (layer ∥ up-facing skin) + w₄ thickness error; exact gradients, Adam, mini-batches. Refines the dome warp when both are on |
| Heat-method walls (#15) | `offsets.ts` | Raster the island; Eikonal distance by fast sweeping (exact distances at the boundary); in a band up to the deepest wall: (I − tΔ)u = 0, X = −∇u/|∇u|, Δφ = ∇·X, anchored to the Eikonal distance on the band's inner edge; marching-squares isolines, cubic B-spline smoothing (C²). Outer wall stays an exact offset; repeated outlines reuse their solution |
| Conformal skins (#4) | `surface.ts` | Top-skin points move to the CAD surface height within ±½ layer (ray cast up), flow for the new bead height |
| Clearance checker (Task 2.3) | `clearance.ts` | Height maps of finished layers and of the current layer (3 mm lag); a non-planar point must keep the nozzle cone, heater block, fan duct and carriage above printed plastic and its tip ≥ 0.03 mm above the finished layer under it. Lifts up to ½ layer, otherwise reports |

Verification: `tests/advanced/phase2.test.ts` — PCG, Laplace linear solution, multigrid Poisson against the analytic square value, heat and Eikonal distance against the exact disk distance, isoline areas, dome-warp limits and inverse map, un-warp flow scaling, SGD loss decrease on a T, clearance lift/report, curved-layer slices with zero unresolved collisions.

## Phase 3 — continuous helices, seam elimination & surface compilers

| Technology | File | What the toolpath does |
| --- | --- | --- |
| #21 Thick-vase helix | `modules/thickVase.ts` | In helical bands (steady single-island stretches), each layer is rebuilt in a canonical loop order (outer walls by size, inner walls, infill) so every point sits at the same fraction of the turn each layer; z = layer surface − h·(1 − s/S), relative to the move's own z (curved layers stay curved); hops inside the part lose their retraction; infill becomes a connected spiral |
| #3 Eulerian spiral | `eulerian.ts` | Concentric rings joined level by level into unbroken spirals (each ring stops one spacing short and steps in); the innermost ring widens (0.75–2.5 × nozzle) instead of gap fill |
| #22 Tangential entry | `modules/seams.ts` | One-turn Archimedean spiral just inside the walls, an approach that merges into the wall at ≤ 3° (smoothstep inset over 1.5·D/tan α), the loop, and a mirrored lead-out; skipped when the spiral would leave the part (SDF check) |
| #23 Scarf splice | `modules/seams.ts` | Wedge start half a layer low with E(s) = 3(s/L)² − 2(s/L)³, the loop, then the complementary wedge at full height at 60 % speed with the part fan off for 150 ms |
| #8 Sub-voxel anti-aliasing | `modules/surfacePasses.ts` | Outer beads under shallow slopes are lowered onto the CAD surface inside their layer band (never raised: the flat of the tip spans the neighbour) |
| #26 Perimeter feathering | `modules/surfacePasses.ts` | On rounded sides leaning in (30–80°), the outer bead drops by up to ½ layer and shifts outward along the surface normal (shingled) |
| #25 Conformal ironing | `modules/surfacePasses.ts` | Up-facing surfaces within the head's slope limit, seen from above, are burnished by concentric isoline passes at the CAD height (1.5 % flow); points the head cannot reach are skipped |
| #7 Z-weave & Z-pins | `modules/weave.ts` | Inner walls and infill follow an egg-crate offset A·h·sin kx·sin ky with alternating sign per layer; flow follows the real bead height against an offset map of what is below; speed capped by the Z axis (v ≤ v_z/(A·h·k·√2), v ≤ √(a_z/(2A·h·k²))). Pins: voids of r = 1.2 mm through N layers in deep cores, filled by a vertical extrusion; the dive depth comes from the nozzle cone and tip length |
| #19 Knot braiding | `modules/weave.ts` | Walls 1 and 2 become two strands M ∓ n·(s/2)·cos ωs that swap sides at each crossing; the strand printed second lifts over the crossing (per-point Z offsets); strands swap slots every layer so over and under alternate |

The slicer gained two generic hooks for this phase: per-point Z offsets on wall loops (`zs`, kept through seam rotation) and a walls post-edit hook.

Verification: `tests/advanced/phase3.test.ts`. A fully combined Seamless Aesthetic compile on A1/P1/X1, Klipper and Marlin machines leaves at most 0.1 % of non-planar points reported (worst < 0.25 mm), all of them listed in the warnings.

## Phase 4 — field solvers, metamaterials & lattices

New slicer hooks: a **zone router** for sparse infill (each technology claims the part of a region it is made for and passes on the rest; whatever is left gets the regular pattern), a **material-region hook** (dovetails), the layer plan for **reshape** (cross-section edits know their z), per-point **wall widths** (kept through seam rotation), and a `noClear` flag for free-space draws whose clearance holds by construction.

| Piece | File | Method |
| --- | --- | --- |
| Voxel FEA | `fea.ts` | 8-node trilinear hexahedra (2×2×2 Gauss), matrix-free Jacobi-PCG, eigenstrain loads, element stresses, cyclic-Jacobi principal stresses, nodal averaging + trilinear sampling. Cantilever tip deflection within 2 % of beam theory |
| Load case | `stress.ts` | Painted fixture (1) / load (2) faces, sampled at half-element spacing onto surface nodes; otherwise bed contact + all but one bolt hole fixed, load at the farthest bolt hole (or the top face); direction and force from the Load card |
| #1 Stress-aligned paths | `modules/fea.ts`, `streamlines.ts` | Where von Mises exceeds the chosen percentile, in-plane principal directions (σ₁ tension or σ₃ compression, or both alternating) as ψ = w·e^{2iθ}; evenly spaced RK4 streamlines (Jobard–Lefer) with sign alignment of the line field. Also the inspector's `stress` field |
| #33 Spinor fields | `stress.ts`, `streamlines.ts` | Principal frames → unit quaternions; averaging blind to ±q and to axis flips (q·{1, i, j, k}) via the dominant eigenvector of Σ w q qᵀ; directions back through the Hopf map q e q̄. Per layer, ±½ defects (winding of arg ψ) are moved to the nearest point outside the material by ψ ← ψ·((w − b)/(w − p))^s |
| #28 Quasicrystal | `modules/quasicrystal.ts` | Six five-fold axes of ℤ⁶ → ℝ³; plane families (de Bruijn multigrid dual of the cut-and-project) spaced as Fibonacci chains x_n = n + ⌊n/τ + α⌋/τ; families tilted beyond the limit dropped; orientation search (240 up-vectors): most families, then in-plane isotropy. Five-fold up → 5 families at 26.6°, isotropic. Claims the core zone |
| #9 Gray–Scott | `modules/turing.ts` | Anisotropic D = D₀(I + β d⊗d) along stress (or the outline tangent), halved round bolt holes; 2000 burn-in steps, 50 per layer (Z continuation); ribs are v = 0.2 contours; cell size from the infill density |
| #35 Homogenization | `homogenize.ts`, `modules/cells.ts` | Periodic voxel cell, six unit macro-strain cases, C^H_ij = (1/|Y|) Σ (χ⁰ − χ)ᵀK(χ⁰ − χ). Solid cell recovers C exactly. Gyroid density from a power-law fit through two homogenized cells; negative ν by bisection on the homogenized re-entrant cell (target −0.5 → 69°, ν = −0.51) |
| #12 Metamaterial | `modules/cells.ts` | Re-entrant honeycomb rows (shared column positions, golden-ratio dithered strut lengths: aperiodic, connected); strut width graded by compliance (low stress or depth → thinner) |
| #34 Band gap | `bloch.ts`, `modules/bandGap.ts` | Honeycomb frame + disc resonator per cell on three spiral ligaments; f_r = √(3Ew³/(m_r L³))/2π placed at target/(1 + m_r/m_f)^{1/4}; Bloch dynamical matrix (Hermitian Jacobi via the real embedding), band edges over the BZ, Chern number by Fukui–Hatsugai (0 for this passive lattice), valley Chern with A/B pads (≈ −0.39 at 10 % contrast, → ±½ as the gap closes). 800 Hz → 5 mm cells, gap 620–1032 Hz |
| #18 Foam control | `modules/foam.ts` | X(T) = 1 + (X_max − 1)·smoothstep((T − 205)/45); hubs cool, cores hot; M104 issued τ·ln(ΔT/2) s ahead; runs shorter than τ/2 keep the setting; first-order observer predicts nozzle T and every extrusion is divided by X(T). Adds the Generic LW-PLA preset |
| #16 Inverse warp | `modules/inverseWarp.ts` | Inherent strain ε* = −s(1, 1, 0.3) per filament (PLA 0.3 % … PP 1.5 %, ×0.6 in a heated chamber); four height bands activated in turn on the bed, then the bed reaction released on a 3-2-1 support; toolpath x′ = x − g·u(x); 0.6 mm kerfs every 20 mm across sections ≥ 2.5 mm deep; warns of curl the layer plane cannot pre-bend |
| #11 Spatial lattice | `modules/lattice.ts` | Opt-in: above 3 base layers, octahedral truss (posts with dwell, diagonals, struts at each level), cell height ≤ tip length − 0.4 mm, pitch ≥ tip length, full fan |
| #13 Dovetail | `modules/dovetail.ts` | Checkerboard fingers (pitch/2) in a band of `depth` on both sides of each material boundary, phase flipped per layer; area conserving. Needs AMS / tool changer |
| #20 Co-molding | `modules/coMolding.ts` | Opt-in: cavity = depth > shell (closes in 3D), perforated tube columns, a sprue tube to the cavity bottom, a vent at its highest point |
| #29 Metric morph | `modules/metricMorph.ts` | g = I + ∇f⊗∇f of the top height field; bead angle α solving ρ(α) = 1/√(1 + \|∇f\|²) with λ⊥ = λ^{-1/2}; flat sheet = footprint outline + evenly spaced director streamlines, fast beads |
| #30 Monge–Ampère | `modules/mongeAmpere.ts` | Log-domain Sinkhorn with ε-scaling (separable log-sum-exp), barycentric map, ∇h = (T − x)/((n − 1)·throw), Poisson-integrated; lens mode carves the top, lampshade mode sets outer-wall widths by Beer–Lambert |

Verification: `tests/advanced/fea.test.ts`, `homogenize.test.ts`, `bloch.test.ts`, `phase4.test.ts` (cantilever streamlines align with bending tension, Fibonacci gaps, rib continuity between layers, band gap holds the target, auxetic ν, foam schedule, ABS warp compensation and kerfs, truss, dovetail area/phase, co-mold material saving, flat sheet, lens and lampshade). Structural Armor on a 60×30×12 mm part slices in about 8 s (Basic: 0.06 s).

## Phase 5 — rheology, kinematics & the topological router

| Technology | File | Method |
| --- | --- | --- |
| Motion planner | `planner.ts` | Trapezoidal look-ahead with junction deviation v_j² = a·δ·sin(θ/2)/(1 − sin(θ/2)), δ = scv²(√2 − 1)/a; backward (stoppable) and forward (reachable) passes, per-move entry/cruise/exit speeds and times |
| #6 Kinematic extrusion | `modules/motion.ts` | Corners where the planner slows are reported; without firmware PA, software pressure advance ΔE = K·Δv·E/len on each speed change; with PA: planning only |
| #31 Symplectic shaper | `modules/motion.ts` | Frame as a damped oscillator (resonance from the machine model) integrated with Störmer–Verlet; accelerations retimed so each ramp lasts a whole number of periods (residual ringing ≈ 0). With firmware input shaping only ramps still ringing over 4× the tolerance are retimed (no double shaping) |
| #10 Corner overshoot | `modules/motion.ts` | At outer-wall corners sharper than the threshold the nozzle swings d = g·w/2·(1 − sin(φ/2)) past the corner at 60 % flow and returns dry; halved with firmware PA |
| #27 Iso-gloss | `modules/rheology.ts` | Outer wall at one speed on every layer (exempt from the cooling slowdown); short layers take their time from the other features, the rest from the fan: fan′ = fan·(t_min/t)^γ. Reports τ_w |
| #17 Gloss modulation | `modules/rheology.ts` | Painted matte/gloss faces (values 3/4) set the outer-wall speed: τ_w = K((3n+1)/4n · 4Q/πR³)ⁿ (PLA K = 4500 Pa·sⁿ, n = 0.35), high shear for matte, low for gloss |
| #5 Hot-on-hot | `modules/rheology.ts` | Lumped bead cooling ρch·dT/dt = −h(T − T_amb), h = 15 + 85·fan W/m²K, over the planned layer time; the fan is cut (up to the limit) until the layer below is still above Tg + margin when the next one lands; layers that cannot reach it are reported |
| #32 Morse–Smale router | `modules/morse.ts` | Reeb graph from the cross-section islands (overlap links), births/deaths/merges/splits, elder-rule persistence and simplification below the threshold; branches routed to planar, helix, curved layers, support or reorientation (5-axis); the inspector's `branch` field |

Verification: `tests/advanced/phase5.test.ts` — junction speed at a right angle, period-timed ramps cut ringing by > 70 %, no double shaping on X1-class firmware, software PA on Marlin, overshoot corners, power-law shear scaling, one outer-wall speed across layers, matte vs gloss shear, fan cuts for the layer bond, the branches of an arch, a mid-air branch routed to support, and every intent compiled on Bambu X1C/A1/H2D, Voron (Klipper), Prusa MK4S and Ender-3 V2 (Marlin) with every technology present and < 1 % unresolved clearance points.
