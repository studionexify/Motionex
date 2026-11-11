// Web Worker for the Zone Inspector: analyses the objects on the plate without slicing them.
import { analyzePart, toObjectAnalysis, type AnalysisParams } from './analysis';
import { MODULES } from './modules';
import type { ObjectAnalysis } from './types';

interface Req {
  id: number;
  objects: { id: string; name: string; vertices: Float32Array; indices: Uint32Array; color?: Uint8Array; advPaint?: Uint8Array }[];
  params: AnalysisParams;
}

self.onmessage = (ev: MessageEvent<Req>) => {
  const { id, objects, params } = ev.data;
  try {
    const results: ObjectAnalysis[] = objects.map((o) => {
      const a = analyzePart({ vertices: o.vertices, indices: o.indices }, { ...params, color: o.color, advPaint: o.advPaint });
      // field solvers add their inspector fields (harmonic potential, stress, branches)
      for (const m of MODULES) m.inspect?.(a);
      return toObjectAnalysis(o.id, o.name, a);
    });
    const transfer: Transferable[] = [];
    for (const r of results) {
      transfer.push(r.voxels.buffer);
      for (const f of Object.values(r.fields)) if (f && !transfer.includes(f.buffer)) transfer.push(f.buffer);
    }
    (self as any).postMessage({ id, type: 'done', results }, transfer);
  } catch (e: any) {
    (self as any).postMessage({ id, type: 'error', message: e?.message ?? String(e) });
  }
};
