// Web Worker entry: runs the slicer off the UI thread.
import { slice } from './slicer';
import type { MeshInput, SliceOptions } from './types';
import type { Config } from '../profiles/settings';

self.onmessage = (ev: MessageEvent<{ id: number; meshes: MeshInput[]; cfg: Config; opts?: SliceOptions }>) => {
  const { id, meshes, cfg, opts } = ev.data;
  let stage = '';
  try {
    const out = slice(meshes, cfg, (st, pct) => { stage = st; (self as any).postMessage({ id, type: 'progress', stage: st, pct }); }, opts);
    (self as any).postMessage({ id, type: 'done', out }, [out.moves.buffer, out.moveFeatures.buffer, ...(out.moveAux ? [out.moveAux.buffer] : []), ...(out.moveLines ? [out.moveLines.buffer] : []), ...(out.moveWave ? [out.moveWave.buffer] : []), ...(out.pauses ? [out.pauses.buffer] : [])]);
  } catch (e: any) {
    // the stage tells a bug report where the pipeline stopped; the stack goes to the worker console
    console.error(e);
    const msg = e?.message ?? String(e);
    (self as any).postMessage({ id, type: 'error', message: stage && !msg.includes(stage) ? `${msg} (while ${stage.toLowerCase()})` : msg });
  }
};
