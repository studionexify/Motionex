// Input checks run before slicing: what the Prepare tools can hand the slicer after an edit (a scale of 0 %, a
// part pushed under the bed, a broken import) is repaired or explained here instead of failing deep in the pipeline.
import type { MeshInput, PartInput } from './types';

/**
 * Neutralise vertices with NaN / Infinity coordinates: every triangle that uses one is collapsed onto a valid vertex
 * (zero area, so it slices to nothing) and the bad vertex takes that vertex's position. Triangle order and count are
 * kept, so per-triangle paint and face sets stay aligned. Returns the input unchanged when every vertex is finite.
 */
export function finiteMesh<T extends { vertices: Float32Array; indices: Uint32Array }>(m: T): { mesh: T; bad: number; changed: boolean } {
  const v = m.vertices;
  let anchor = -1, badVerts = 0;
  for (let i = 0; i < v.length; i += 3) {
    if (Number.isFinite(v[i]) && Number.isFinite(v[i + 1]) && Number.isFinite(v[i + 2])) { if (anchor < 0) anchor = i / 3; } else badVerts++;
  }
  if (!badVerts) return { mesh: m, bad: 0, changed: false };
  if (anchor < 0) return { mesh: { ...m, vertices: new Float32Array(0), indices: new Uint32Array(0) }, bad: m.indices.length / 3, changed: true };
  const nv = v.slice();
  const isBad = (k: number) => !(Number.isFinite(v[k * 3]) && Number.isFinite(v[k * 3 + 1]) && Number.isFinite(v[k * 3 + 2]));
  for (let k = 0; k < nv.length / 3; k++) if (isBad(k)) nv.set([v[anchor * 3], v[anchor * 3 + 1], v[anchor * 3 + 2]], k * 3);
  const ix = m.indices.slice();
  let bad = 0;
  for (let t = 0; t < ix.length; t += 3) {
    if (isBad(ix[t]) || isBad(ix[t + 1]) || isBad(ix[t + 2])) { ix[t] = ix[t + 1] = ix[t + 2] = anchor; bad++; }
  }
  return { mesh: { ...m, vertices: nv, indices: ix }, bad, changed: true };
}

/** Highest Z of a mesh (finite vertices only; -Infinity when it has none). */
export function topZ(m: { vertices: Float32Array }): number {
  let z = -Infinity;
  for (let i = 2; i < m.vertices.length; i += 3) if (m.vertices[i] > z) z = m.vertices[i];
  return z;
}

/** A variable layer height profile with only usable heights (finite, > 0); undefined when nothing usable is left. */
export function cleanProfile(p: number[] | undefined): number[] | undefined {
  if (!p?.length) return p;
  if (p.every((h) => Number.isFinite(h) && h > 0)) return p;
  const ok = p.filter((h) => Number.isFinite(h) && h > 0);
  return ok.length ? ok : undefined;
}

/**
 * Repair what can be repaired and collect warnings; throws a message naming the objects when nothing on the plate
 * has any height above the bed (instead of "the plate is empty" for a plate that visibly holds a model).
 */
export function checkInputs(meshes: MeshInput[]): { meshes: MeshInput[]; warnings: string[] } {
  const warnings: string[] = [];
  const out = meshes.map((m) => {
    let next = m;
    const body = finiteMesh(m);
    if (body.changed) {
      next = body.mesh;
      warnings.push(body.mesh.indices.length
        ? `${m.name}: ${body.bad} triangle${body.bad === 1 ? '' : 's'} with invalid coordinates (NaN / Infinity) were skipped. Reset the object's scale and rotation.`
        : `${m.name} has no valid coordinates (NaN / Infinity) and was skipped. Reset its scale and rotation, or re-import it.`);
    }
    if (m.parts?.length) {
      let partsBad = 0;
      let partsChanged = false;
      const parts = m.parts.map((p) => { const r = finiteMesh<PartInput>(p); partsBad += r.bad; partsChanged ||= r.changed; return r.mesh; });
      if (partsChanged) { next = { ...next, parts }; warnings.push(`${m.name}: parts with invalid coordinates (NaN / Infinity) were skipped in ${partsBad} triangle${partsBad === 1 ? '' : 's'}.`); }
    }
    const prof = cleanProfile(m.layerHeights);
    if (prof !== m.layerHeights) {
      next = { ...next, layerHeights: prof };
      warnings.push(`${m.name}: the variable layer height profile had zero, negative or invalid heights; ${prof ? 'they were left out' : 'the uniform layer height is used'}.`);
    }
    return next;
  });
  const withGeometry = out.filter((m) => m.indices.length);
  const lost = out.filter((m, k) => !m.indices.length && meshes[k].vertices.length);
  if (!withGeometry.length && lost.length) {
    throw new Error(`Nothing to slice: ${lost.map((m) => m.name).slice(0, 3).join(', ')} ${lost.length === 1 ? 'has' : 'have'} no valid coordinates (NaN / Infinity). Reset the scale and rotation, or re-import the model.`);
  }
  if (withGeometry.length && !withGeometry.some((m) => topZ(m) > 0)) {
    const names = withGeometry.map((m) => m.name).slice(0, 3).join(', ') + (withGeometry.length > 3 ? '…' : '');
    throw new Error(`Nothing to slice: ${names} ${withGeometry.length === 1 ? 'has' : 'have'} no height above the build plate (flat, scaled to 0 %, or below the bed). Check the scale and use Drop to bed.`);
  }
  for (const m of withGeometry) if (topZ(m) <= 0) warnings.push(`${m.name} lies flat or below the build plate and is not printed. Check its scale and use Drop to bed.`);
  return { meshes: out, warnings };
}
