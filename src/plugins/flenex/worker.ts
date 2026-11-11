// Flenex build worker: holds the boolean kernel and the imported model, so cutting a flexi never blocks the interface.
import { newCache, runBuild, type BuildRequest } from './build';

const cache = newCache();
let current = 0;

export type ToWorker = { type: 'import'; id: number; vertices: Float32Array; indices: Uint32Array } | { type: 'build'; token: number; req: BuildRequest };
export type FromWorker = { type: 'progress'; token: number; msg: string } | { type: 'result'; token: number; res: Awaited<ReturnType<typeof runBuild>> } | { type: 'error'; token: number; message: string };

self.onmessage = async (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  if (m.type === 'import') { cache.imports.set(m.id, { vertices: m.vertices, indices: m.indices }); return; }
  current = m.token;
  try {
    const res = await runBuild(m.req, cache, (msg) => (self as unknown as Worker).postMessage({ type: 'progress', token: m.token, msg } satisfies FromWorker));
    // the cache keeps its own base model: send a copy, transfer the rest
    res.base = { vertices: res.base.vertices.slice(), indices: res.base.indices.slice() };
    const transfer = [res.base.vertices.buffer, res.base.indices.buffer, res.mesh.vertices.buffer, res.mesh.indices.buffer, res.triPiece.buffer, res.paint.buffer] as ArrayBuffer[];
    (self as unknown as Worker).postMessage({ type: 'result', token: m.token, res } satisfies FromWorker, transfer);
  } catch (err) {
    (self as unknown as Worker).postMessage({ type: 'error', token: current, message: (err as Error).message } satisfies FromWorker);
  }
};
