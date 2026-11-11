// Renex model import: STEP / IGES / BREP (tessellated by OpenCascade in a worker), STL / OBJ / 3MF
// (NexSpiro's own parsers). Becomes a Renex scene of printed parts, so any CAD model can be rendered as a
// 3D print.
import * as THREE from 'three';
import { loadModelFile } from '../../io/load';
import { printSettingsFromConfig } from '../config';
import { soupOf, type RenexSceneSource, type SourcePart } from '../source';

export const IMPORT_EXT = ['.step', '.stp', '.iges', '.igs', '.brep', '.stl', '.obj', '.3mf'];

export interface RawMesh { name: string; color?: [number, number, number]; positions: Float32Array; indices: Uint32Array; /** B-rep face id per triangle (CAD imports). */ faces?: Uint32Array }

let worker: Worker | null = null, seq = 0;
const pending = new Map<number, { resolve: (m: RawMesh[]) => void; reject: (e: Error) => void }>();

function cadWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./occtWorker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (e: MessageEvent<{ id: number; ok: boolean; meshes?: RawMesh[]; error?: string }>) => {
    const p = pending.get(e.data.id);
    if (!p) return;
    pending.delete(e.data.id);
    if (e.data.ok) p.resolve(e.data.meshes!); else p.reject(new Error(e.data.error));
  };
  worker.onerror = (e) => { for (const p of pending.values()) p.reject(new Error(e.message || 'CAD worker failed')); pending.clear(); worker?.terminate(); worker = null; };
  return worker;
}

/** Tessellate a B-rep CAD file off the main thread. */
export function tessellateCad(name: string, data: ArrayBuffer, deflection = 0.001): Promise<RawMesh[]> {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  const kind = ext === 'step' || ext === 'stp' ? 'step' : ext === 'iges' || ext === 'igs' ? 'iges' : 'brep';
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    cadWorker().postMessage({ id, kind, data, deflection }, [data]);
  });
}

const hex = (c?: [number, number, number]) => (c ? `#${new THREE.Color(c[0], c[1], c[2]).getHexString()}` : '#d9d4cc');

/**
 * Group meshes into at most `maxParts` printed parts (by colour, then by size), keeping their relative
 * placement: an assembly of hundreds of bodies becomes a handful of draw-call-friendly parts.
 */
export function partsFromMeshes(meshes: RawMesh[], maxParts = 12): SourcePart[] {
  const groups = new Map<string, RawMesh[]>();
  for (const m of meshes) { const k = hex(m.color); (groups.get(k) ?? groups.set(k, []).get(k)!).push(m); }
  let list = [...groups.entries()].map(([k, ms]) => ({ k, ms, tris: ms.reduce((s, m) => s + m.indices.length / 3, 0) })).sort((a, b) => b.tris - a.tris);
  if (list.length > maxParts) { const rest = list.slice(maxParts - 1); list = [...list.slice(0, maxParts - 1), { k: rest[0].k, ms: rest.flatMap((r) => r.ms), tris: 0 }]; }
  // global bounds: the model stands on the table, centred
  const box = new THREE.Box3(), v = new THREE.Vector3();
  for (const m of meshes) for (let i = 0; i < m.positions.length; i += 3) box.expandByPoint(v.set(m.positions[i], m.positions[i + 1], m.positions[i + 2]));
  const cx = (box.min.x + box.max.x) / 2, cy = (box.min.y + box.max.y) / 2, z0 = box.min.z;
  return list.map(({ k, ms }, i) => {
    const soups = ms.map((m) => soupOf(m.positions, m.indices));
    const total = soups.reduce((s, x) => s + x.length, 0);
    const soup = new Float32Array(total);
    let o = 0; for (const x of soups) { soup.set(x, o); o += x.length; }
    let minZ = Infinity;
    for (let j = 0; j < soup.length; j += 3) { soup[j] -= cx; soup[j + 1] -= cy; soup[j + 2] -= z0; minZ = Math.min(minZ, soup[j + 2]); }
    for (let j = 2; j < soup.length; j += 3) soup[j] -= minZ;
    return {
      key: `import-${i}`, name: ms.length === 1 ? ms[0].name : `${ms[0].name} (+${ms.length - 1})`, printSoup: soup,
      assembled: new THREE.Matrix4().makeTranslation(0, 0, minZ), exploded: new THREE.Vector3(0, 0, i * 30),
      hex: k, finish: 'PLA' as const, colourName: k, materialName: 'PLA',
    };
  });
}

/** Read a model file into a Renex scene. */
export async function importModel(file: File): Promise<RenexSceneSource> {
  const name = file.name, ext = `.${name.toLowerCase().split('.').pop()}`;
  if (!IMPORT_EXT.includes(ext)) throw new Error(`Unsupported file type ${ext}. Use ${IMPORT_EXT.join(', ')}.`);
  const data = await file.arrayBuffer();
  let meshes: RawMesh[];
  if (['.step', '.stp', '.iges', '.igs', '.brep'].includes(ext)) meshes = await tessellateCad(name, data);
  else {
    const models = await loadModelFile(name, data);
    meshes = models.map((m) => {
      const pos = new Float32Array(m.mesh.vertices);
      for (let i = 0; i < pos.length; i += 3) { pos[i] += m.offset[0]; pos[i + 1] += m.offset[1]; pos[i + 2] += m.offset[2]; }
      return { name: m.name, positions: pos, indices: new Uint32Array(m.mesh.indices) };
    });
  }
  if (!meshes.length || meshes.every((m) => !m.indices.length)) throw new Error('The file contains no geometry.');
  const parts = partsFromMeshes(meshes);
  const tris = parts.reduce((s, p) => s + p.printSoup.length / 9, 0);
  return { source: 'plantex', title: name.replace(/\.[^.]+$/, ''), parts, print: printSettingsFromConfig(), warnings: tris > 3e6 ? [`${(tris / 1e6).toFixed(1)} M triangles: the live view stays smooth, path tracing will need more memory.`] : [] };
}
