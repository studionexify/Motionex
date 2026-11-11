// Quad / polygon face groups survive a project save and load, so subdivision still sees the quads.
import { beforeAll, describe, expect, it } from 'vitest';
import { DOMParser } from '@xmldom/xmldom';

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
  const mem = new Map<string, string>();
  (globalThis as any).localStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => mem.set(k, v), removeItem: (k: string) => mem.delete(k) };
});

describe('project file face groups', () => {
  it('keeps faceGroups, and loads older projects without them', async () => {
    const { useStore } = await import('../src/state/store');
    const { buildProject, loadProject } = await import('../src/state/project');
    const vertices = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
    const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);
    const base = { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], openEdges: 0 };
    useStore.getState().set({
      objects: [
        { id: 'q', name: 'quad', ...base, mesh: { vertices, indices, faceGroups: new Uint32Array([7, 7]) } },
        { id: 'p', name: 'plain', ...base, mesh: { vertices, indices } },
      ] as any,
    });
    const bytes = await buildProject();
    useStore.getState().set({ objects: [] });
    await loadProject(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    const [q, p] = useStore.getState().objects;
    expect(Array.from(q.mesh.faceGroups!)).toEqual([7, 7]);
    expect(p.mesh.faceGroups).toBeUndefined();
  });
});
