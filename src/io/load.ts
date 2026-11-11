// Model import: dispatches by extension, welds, centres, and returns scene objects.
import { weld, meshBounds, openEdgeCount, type IndexedMesh } from '../engine/mesh';
import { parseSTL } from './stl';
import { parseOBJPolys } from './obj';
import { ImportCancelled, parse3MF, type Progress } from './threemf';
import { parseAMF } from './amf';
export { ImportCancelled };

export interface LoadedModel {
  name: string; mesh: IndexedMesh; openEdges: number; offset: [number, number, number];
  /** Per-triangle colour paint (1-based slot, 0 = the object's filament), from a coloured 3MF. */
  color?: Uint8Array;
  /** 0-based filament slot of the object. */
  filament?: number;
  /** Filament colours stored in the file, slot order. */
  filamentColors?: string[];
  /** Plate in the file (0-based) and where the object sat on that plate (mesh centre xy, min z), plate-local mm. */
  plate?: number;
  local?: [number, number, number];
  /** File-level facts shared by every model of one file. */
  file?: { printerModel?: string; bed?: [number, number]; plateCount: number; plateSequences?: import('../engine/toolmap').FilamentSequence[] };
}

/** Where plate i of a Bambu / Orca project starts in the file's coordinates: plates sit in a grid of
 *  ceil(sqrt(n)) columns, one bed plus a fifth apart, rows going towards -Y. */
export function bambuPlateOrigin(i: number, n: number, bed: [number, number]): [number, number] {
  const cols = Math.max(1, Math.ceil(Math.sqrt(n) - 1e-9));
  return [(i % cols) * bed[0] * 1.2, -Math.floor(i / cols) * bed[1] * 1.2];
}

export const SUPPORTED_EXT = ['.stl', '.obj', '.3mf', '.amf'];

/** Centre a mesh on XY origin with min Z = 0; returns the original placement offset. */
export function centreMesh(m: IndexedMesh): [number, number, number] {
  const b = meshBounds(m.vertices);
  const cx = (b.min[0] + b.max[0]) / 2, cy = (b.min[1] + b.max[1]) / 2, cz = b.min[2];
  for (let i = 0; i < m.vertices.length; i += 3) { m.vertices[i] -= cx; m.vertices[i + 1] -= cy; m.vertices[i + 2] -= cz; }
  return [cx, cy, cz];
}

export async function loadModelFile(name: string, data: ArrayBuffer, progress?: Progress, cancelled?: () => boolean): Promise<LoadedModel[]> {
  const lower = name.toLowerCase();
  const base = name.replace(/\.[^.]+$/, '');
  const soups: { name: string; soup: Float32Array; groups?: Uint32Array; color?: Uint8Array; filament?: number; plate?: number }[] = [];
  let filamentColors: string[] | undefined;
  let file: LoadedModel['file'];
  const step: Progress = async (f, st) => { if (cancelled?.()) throw new ImportCancelled(); await progress?.(f * 0.7, st); };
  if (lower.endsWith('.stl')) soups.push({ name: base, soup: parseSTL(data) });
  else if (lower.endsWith('.obj')) soups.push({ name: base, ...parseOBJPolys(new TextDecoder().decode(data)) });
  else if (lower.endsWith('.3mf')) {
    const r = await parse3MF(data, step);
    if (r.filamentColors.length) filamentColors = r.filamentColors;
    file = { printerModel: r.printerModel, bed: r.bed, plateCount: r.plateCount, ...(r.plateSequences ? { plateSequences: r.plateSequences as import('../engine/toolmap').FilamentSequence[] } : {}) };
    soups.push(...r.objects.map((o, _i, a) => ({ name: a.length > 1 ? o.name : base, soup: o.soup, color: o.color, filament: o.filament, plate: o.plate })));
  }
  else if (lower.endsWith('.amf')) {
    const objs = await parseAMF(data);
    soups.push(...objs.map((o) => ({ name: objs.length > 1 ? o.name : base, soup: o.soup, color: o.color })));
  }
  else throw new Error(`Unsupported file type: ${name}. Supported: ${SUPPORTED_EXT.join(', ')}`);
  const out: LoadedModel[] = [];
  for (const [k, { name: n, soup, groups, color, filament, plate }] of soups.entries()) {
    if (cancelled?.()) throw new ImportCancelled();
    await progress?.(0.7 + 0.28 * (k / soups.length), `Preparing ${n}`);
    // colour rides through the weld as face groups (degenerate triangles are dropped there)
    const mesh = weld(soup, 1e-5, color ?? groups);
    if (!mesh.indices.length) throw new Error(`${n} contains no triangles.`);
    let paint: Uint8Array | undefined;
    if (color) { paint = Uint8Array.from(mesh.faceGroups ?? []); delete mesh.faceGroups; }
    const offset = centreMesh(mesh);
    let local: [number, number, number] | undefined;
    if (file && file.bed) {
      const pi = plate ?? 0;
      const [ox, oy] = bambuPlateOrigin(pi, file.plateCount, file.bed);
      local = [offset[0] - ox, offset[1] - oy, offset[2]];
      // files that store plate-local positions: keep them as they are
      const inside = (x: number, y: number) => x > -file!.bed![0] * 0.1 && x < file!.bed![0] * 1.1 && y > -file!.bed![1] * 0.1 && y < file!.bed![1] * 1.1;
      if (!inside(local[0], local[1]) && inside(offset[0], offset[1])) local = offset;
    }
    out.push({ name: n, mesh, openEdges: openEdgeCount(mesh), offset, color: paint, filament, filamentColors, plate, local, file });
  }
  return out;
}
