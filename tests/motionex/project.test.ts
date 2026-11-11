// Project files keep picked surfaces and Motionex patterns.
import { describe, expect, it, beforeAll } from 'vitest';
import { DOMParser } from '@xmldom/xmldom';

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
  const mem = new Map<string, string>();
  (globalThis as any).localStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => mem.set(k, v), removeItem: (k: string) => mem.delete(k) };
});

describe('project file', () => {
  it('saves and restores picked surfaces and patterns', async () => {
    const { useStore } = await import('../../src/state/store');
    const { buildProject, loadProject } = await import('../../src/state/project');
    const { mx, changed } = await import('../../src/plugins/motionex/ui/MotionexPanel');
    const { defaultApplication } = await import('../../src/plugins/motionex/index');

    const motion = new Uint8Array([0, 2, 2, 0]);
    useStore.getState().set({
      plugins: ['motionex'],
      objects: [{ id: 'a', name: 'cube', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], openEdges: 0,
        mesh: { vertices: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]), indices: new Uint32Array([0, 1, 2, 0, 1, 3, 0, 2, 3, 1, 2, 3]) },
        paint: { motion } } as any],
    });
    const brush = mx.library.all()[0];
    mx.applications = [{ ...defaultApplication(brush.id), target: { type: 'faces', walls: 'outer', faces: ['2'] } }];
    changed();
    const bytes = await buildProject();

    mx.applications = [];
    useStore.getState().set({ objects: [], plugins: [] });
    await loadProject(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);

    const s = useStore.getState();
    expect(Array.from(s.objects[0].paint!.motion!)).toEqual([0, 2, 2, 0]);
    expect(s.plugins).toContain('motionex');
    expect(mx.applications).toHaveLength(1);
    expect(mx.applications[0].target).toEqual({ type: 'faces', walls: 'outer', faces: ['2'] });
    expect(mx.applications[0].brush_id).toBe(brush.id);
  }, 30000); // loads the whole store and panels (cold transform takes several seconds)
});
