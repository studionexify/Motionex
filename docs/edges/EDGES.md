# Edges tool: chamfer, fillet, smooth body

Open it from the toolbar (cube icon) or press **G**. Works on one object at a time in Prepare.

## Picking edges
- Click an edge: the whole crease run it belongs to is picked (a rim, a straight run).
- **Shift+click** adds a run, or removes it when it is already picked. **Alt+click** picks a single tessellation edge.
- **Select all creases** picks every edge bending more than the **Crease** angle.
- **Show edges** draws creases (dark), open edges (red), the outline of painted colour regions (a dark shade of that
  filament) and, for quad models, the outline of the quads. **Smooth shading** only changes how the model is lit.

## Chamfer / fillet
- Size is the distance along each adjoining face, measured from the edge. **Round** is the number of segments of a fillet.
- Convex edges lose material, concave edges gain it.
- The size is reduced when it would not fit inside the neighbouring triangles; the toast tells you the size used.
  Edges next to tiny sliver triangles (less than a quarter of the size wide) are skipped instead of shrinking every
  other edge, and the toast counts them. **Remesh** can clean such areas first.
- Open and non-manifold edges are skipped.
- Undo restores the mesh and the picked edges.

## Smooth body
- **Subdivide**: models imported from OBJ with quad faces are subdivided with Catmull-Clark. Other models use Loop.
  Edges steeper than the crease angle stay sharp. Up to 3 levels, capped at 2 million triangles.
- **Relax surface**: Taubin smoothing (keeps volume); vertices on creases and open borders stay put.
  **Painted area only** limits it to triangles that carry colour, support or seam paint.
- **Refine** splits edges longer than **Max edge** so triangles are even. The shape does not change.
- **Remesh** also collapses short edges, flips edges toward valence 6 and relaxes along the surface, giving triangles
  of about **Max edge**. Creases, open borders and CAD face boundaries are kept. Curved areas may drift slightly.

All edits are one undo step, keep per-triangle paint, and keep the object on the bed if it was on it.

## Notes
- STL and 3MF have no quad information, so subdividing them uses Loop. OBJ face groups are kept in project files.
- STEP, IGES and BREP files can be added like any model (OpenCascade tessellates them). Each triangle keeps its CAD face,
  so the boundary between two CAD faces is always an edge (even where the faces meet smoothly), and picking creases on
  a CAD model picks those edges rather than the tessellation inside curved faces. Chamfer and fillet still act on the
  tessellation, not the exact surfaces, so a fillet on a curved CAD edge is an approximation. Assemblies become one
  object per body.

## Smooth outlines (print setting)
Quality > Precision > **Smooth outlines** (advanced) averages each sliced outline over the given length, which
removes the facets of a coarse mesh from the printed walls without changing the model. 0 is off. Points where the
outline turns by more than **Keep corners sharper than** stay exact. Convex curves shrink by about
radius² / (6 x curve radius), so keep it well below the smallest curve. It applies to the standard slicer, not the
Advanced engine.

## Code
`src/engine/topology.ts` (edge data), `src/engine/meshedit.ts` (edits), `src/state/meshTools.ts` (actions),
`src/viewport/edgeOverlay.ts` (lines), `tests/meshedit.test.ts`.
