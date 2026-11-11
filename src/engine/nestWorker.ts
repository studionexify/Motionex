// Web Worker entry: packs Fill Bed copies off the UI thread.
import { nest, type NestRequest } from './nest';

self.onmessage = (ev: MessageEvent<{ id: number; req: NestRequest }>) => {
  const { id, req } = ev.data;
  try {
    const out = nest(req, (placed) => (self as any).postMessage({ id, type: 'progress', placed }));
    (self as any).postMessage({ id, type: 'done', out });
  } catch (e: any) {
    (self as any).postMessage({ id, type: 'error', message: e?.message ?? String(e) });
  }
};
