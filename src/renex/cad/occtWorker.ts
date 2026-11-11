// Background CAD tessellation: STEP / IGES / BREP → triangle meshes with OpenCascade (WASM), off the
// main thread so a large assembly never freezes the UI.
import occtimportjs from 'occt-import-js';
import wasmUrl from 'occt-import-js/dist/occt-import-js.wasm?url';

interface Req { id: number; kind: 'step' | 'iges' | 'brep'; data: ArrayBuffer; deflection: number }
interface OcctMesh { brep_faces?: { first: number; last: number }[]; name?: string; color?: [number, number, number]; attributes: { position: { array: number[] } }; index: { array: number[] } }
interface OcctResult { success: boolean; meshes: OcctMesh[] }
interface Occt { ReadStepFile(b: Uint8Array, p: object | null): OcctResult; ReadIgesFile(b: Uint8Array, p: object | null): OcctResult; ReadBrepFile(b: Uint8Array, p: object | null): OcctResult }

let occt: Promise<Occt> | null = null;
const load = () => (occt ??= (occtimportjs as unknown as (o: object) => Promise<Occt>)({ locateFile: () => wasmUrl }));

self.onmessage = async (e: MessageEvent<Req>) => {
  const { id, kind, data, deflection } = e.data;
  try {
    const o = await load();
    const bytes = new Uint8Array(data);
    // relative deflection: finer for small parts, bounded so huge assemblies stay renderable
    const params = { linearUnit: 'millimeter', linearDeflectionType: 'bounding_box_ratio', linearDeflection: deflection, angularDeflection: 0.1 };
    const r = kind === 'step' ? o.ReadStepFile(bytes, params) : kind === 'iges' ? o.ReadIgesFile(bytes, params) : o.ReadBrepFile(bytes, params);
    if (!r.success) throw new Error('The CAD file could not be read (unsupported or damaged).');
    const meshes = r.meshes.map((m) => {
      const indices = new Uint32Array(m.index.array);
      // B-rep face id per triangle, so edges between CAD faces are known exactly
      const faces = new Uint32Array(indices.length / 3);
      (m.brep_faces ?? []).forEach((f, k) => faces.fill(k, f.first, f.last + 1));
      return { name: m.name ?? 'Part', color: m.color, positions: new Float32Array(m.attributes.position.array), indices, faces };
    });
    (self as unknown as Worker).postMessage({ id, ok: true, meshes }, meshes.flatMap((m) => [m.positions.buffer, m.indices.buffer, m.faces.buffer]));
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, ok: false, error: (err as Error).message ?? String(err) });
  }
};
