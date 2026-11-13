// Builds the full-quality mesh (and STL) off the main thread.
import { buildMesh, meshToStl } from './meshbuild';
self.onmessage = (e: MessageEvent<{ id: number; kind: 'view' | 'stl'; quality?: 'quick' | 'view'; key?: string; design: any }>) => {
  const { id, kind, design, quality = 'view', key = '' } = e.data;
  try {
    if (kind === 'stl') { const b = meshToStl(buildMesh(design, 'export')); (self as any).postMessage({ id, ok: true, stl: b }, [b]); return; }
    const m = buildMesh(design, quality);
    (self as any).postMessage({ id, ok: true, mesh: m, q: quality, key }, [m.position.buffer, m.normal.buffer, m.src.buffer, m.outer.pos.buffer]);
  } catch (err) { (self as any).postMessage({ id, ok: false, error: String((err as Error)?.message ?? err) }); }
};
