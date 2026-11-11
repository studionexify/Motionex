// STEP / IGES / BREP import for the slicer: tessellated by OpenCascade in a worker (see renex/cad), welded into an indexed
// mesh. Each triangle keeps the id of the CAD face it came from, so the Edges tool finds the model's true edges.
import { weld } from '../engine/mesh';
import { tessellateCad } from '../renex/cad/importModel';
import { centreMesh, type LoadedModel } from './load';
import { openEdgeCount } from '../engine/mesh';

export async function loadCadFile(name: string, data: ArrayBuffer): Promise<LoadedModel[]> {
  const base = name.replace(/\.[^.]+$/, '');
  const raws = (await tessellateCad(name, data)).filter((m) => m.indices.length);
  if (!raws.length) throw new Error(`${name} contains no geometry.`);
  return raws.map((m, i) => {
    const soup = new Float32Array(m.indices.length * 3);
    for (let k = 0; k < m.indices.length; k++) {
      const v = m.indices[k] * 3;
      soup[k * 3] = m.positions[v]; soup[k * 3 + 1] = m.positions[v + 1]; soup[k * 3 + 2] = m.positions[v + 2];
    }
    // one face id per triangle: the soup's triangles are in the same order as `indices`
    const mesh = weld(soup, 1e-5, m.faces);
    if (mesh.faceGroups) mesh.groupKind = 'cad';
    const offset = centreMesh(mesh);
    const n = raws.length > 1 ? `${base} – ${m.name || i + 1}` : base;
    return { name: n, mesh, openEdges: openEdgeCount(mesh), offset };
  });
}
