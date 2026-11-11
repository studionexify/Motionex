// The whole Flenex build as one plain function (base model → cuts → joints → colours). It runs inside a Web Worker
// in the app and directly in tests. Inputs and outputs are plain data and typed arrays so they cross the worker boundary.
import type { IndexedMesh } from '../../engine/mesh';
import { repairTJunctions, weld } from '../../engine/mesh';
import { bounds, dropDegenerate, free, initKernel, meshOf, solid, type V3 } from './csg';
import { autoCuts, buildCreature, chainCuts, type Chain, type Mark, type Station } from './creature';
import { buildFlexi, modelBvh, type Cut, type CutReport } from './flexi';
import { cutsFromGroup, type CutGroup } from './groups';
import type { CreatureDesign } from './design';
import { machineFor } from './fit';
import { applyPaint, type PaintOp } from './paint';
import { fitToBed, rotateQuarters, type BedFit } from './place';

export interface BuildRequest {
  source: 'creature' | 'import';
  design: CreatureDesign;
  /** Imported model (id of the copy the worker holds), turned and scaled here. */
  importId: number;
  importRot: [number, number, number];
  importScale: number;
  cutsMode: 'auto' | 'manual';
  manualCuts: Cut[];
  groups: CutGroup[];
  printerId: string;
  /** The fitted nozzle (project setting); the printer's default when missing. */
  nozzle?: number;
  clearance: number;
  gap: number;
  paintOps: PaintOp[];
}

export interface BuildResult {
  base: IndexedMesh;
  mesh: IndexedMesh;
  triPiece: Int32Array;
  pieceCount: number;
  reports: CutReport[];
  warnings: string[];
  closed: boolean;
  paint: Uint8Array;
  /** Centre line of the body (head → tail) for gradients. */
  spine?: V3[];
  marks: Mark[];
  cuts: Cut[];
  fit: BedFit;
  ms: number;
}

export interface BuildCache { imports: Map<number, IndexedMesh>; baseKey: string; base?: { mesh: IndexedMesh; stations: Station[]; marks: Mark[]; chains: Chain[]; warnings: string[] } }
export const newCache = (): BuildCache => ({ imports: new Map(), baseKey: '' });

const soupOf = (m: IndexedMesh) => { const o = new Float32Array(m.indices.length * 3); for (let i = 0; i < m.indices.length; i++) for (let k = 0; k < 3; k++) o[i * 3 + k] = m.vertices[m.indices[i] * 3 + k]; return o; };

/** Import → upright solid: turn, scale, rest on z = 0, centred; made a closed solid (healed when the file is not). */
function importBase(src: IndexedMesh, rot: [number, number, number], scale: number): IndexedMesh {
  let m = rotateQuarters(src, rot);
  m = { vertices: m.vertices.map((v) => v * scale), indices: m.indices };
  const b = bounds(m), v = m.vertices.slice();
  for (let i = 0; i < v.length; i += 3) { v[i] -= (b.min[0] + b.max[0]) / 2; v[i + 1] -= (b.min[1] + b.max[1]) / 2; v[i + 2] -= b.min[2]; }
  m = { vertices: v, indices: m.indices };
  try { const s = solid(m); const r = meshOf(s); free(s); return r; } catch { /* heal and retry */ }
  const healed = dropDegenerate(repairTJunctions(weld(soupOf(m), 1e-4)));
  const s = solid(healed); const r = meshOf(s); free(s);
  return r;
}

export async function runBuild(req: BuildRequest, cache: BuildCache, progress?: (msg: string) => void): Promise<BuildResult> {
  const t0 = performance.now();
  await initKernel();
  const mac = machineFor(req.printerId, { clearance: req.clearance || undefined, gap: req.gap || undefined, nozzle: req.nozzle });
  let base: IndexedMesh, stations: Station[] = [], marks: Mark[] = [], chains: Chain[] = [], warnings: string[] = [];
  progress?.(req.source === 'creature' ? 'Shaping the body…' : 'Preparing the model…');
  if (req.source === 'creature') {
    const key = JSON.stringify([req.design.body, req.design.addons]);
    if (key !== cache.baseKey || !cache.base) {
      const r = buildCreature(req.design);
      cache.base = { mesh: r.mesh, stations: r.stations, marks: r.marks, chains: r.chains, warnings: r.warnings };
      cache.baseKey = key;
    }
    ({ mesh: base, stations, marks, chains, warnings } = cache.base);
  } else {
    const src = cache.imports.get(req.importId);
    if (!src) throw new Error('Import a model first.');
    const key = `import:${req.importId}:${req.importRot.join(',')}:${req.importScale}`;
    if (key !== cache.baseKey || !cache.base) {
      cache.base = { mesh: importBase(src, req.importRot, req.importScale), stations: [], marks: [], chains: [], warnings: [] };
      cache.baseKey = key;
    }
    base = cache.base.mesh;
  }
  progress?.('Placing the cuts…');
  let cuts: Cut[];
  const fit = mac.fit;
  if (req.source === 'creature' && req.cutsMode === 'auto') {
    const minInr = Math.max(2 * fit.minPin, 8.5 * fit.clearance) + fit.clearance + fit.wall + 0.2;
    cuts = [...autoCuts(req.design, stations, minInr), ...chainCuts(req.design, chains, 100, minInr)];
  } else {
    const bvh = req.groups.length ? modelBvh(base) : undefined;
    cuts = [...req.manualCuts, ...req.groups.flatMap((g) => cutsFromGroup(g, bvh))];
  }
  progress?.(`Cutting ${cuts.length} joint${cuts.length === 1 ? '' : 's'}…`);
  const flexi = buildFlexi(base, cuts, fit);
  progress?.('Colouring…');
  const spine = stations.length ? stations.map((s) => [s.P.x, s.P.y, s.top * 0.5] as V3) : undefined;
  const paint = applyPaint(req.paintOps, { mesh: flexi.mesh, triPiece: flexi.triPiece, spine, marks });
  return {
    base, mesh: flexi.mesh, triPiece: flexi.triPiece, pieceCount: flexi.pieces.length, reports: flexi.reports, warnings: [...warnings, ...flexi.warnings], closed: flexi.closed,
    paint, spine, marks, cuts, fit: fitToBed(flexi.mesh, mac.bed), ms: performance.now() - t0,
  };
}
