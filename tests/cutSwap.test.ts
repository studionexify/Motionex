import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { weld } from '../src/engine/mesh';
import { cutObject, cutPreview } from '../src/state/tools';
import { objectFromWorld } from '../src/state/tools';
import { useStore, worldBounds } from '../src/state/store';
import { DEFAULT_CONNECTOR, DEFAULT_GROOVE } from '../src/state/cutConnectors';

// a U shape: two pillars on a base, so a cut through the pillars makes two upper pieces
const box = (x: number, y: number, z: number, w: number, d: number, h: number) => {
  const g = new THREE.BoxGeometry(w, d, h).toNonIndexed();
  g.translate(x, y, z);
  return Array.from(g.getAttribute('position').array as Float32Array);
};
const mesh = weld(new Float32Array([...box(0, 0, 2.5, 30, 10, 5), ...box(-10, 0, 15, 6, 6, 20), ...box(10, 0, 15, 6, 6, 20)]));

describe('cut preview and piece swapping', () => {
  it('lists the pieces on each side and moves a swapped piece to the other part', () => {
    const o = objectFromWorld('U', mesh);
    const h = worldBounds(o).min[2] + 15;
    const pv = cutPreview(o, { height: h, tiltX: 0, tiltY: 0 })!;
    expect(pv.above.length).toBe(2); // the two pillar tops
    expect(pv.below.length).toBe(3); // base and the two pillar stubs (separate shells in this soup)
    useStore.setState({ objects: [o], selected: [o.id] });
    cutObject(o.id, { height: h, tiltX: 0, tiltY: 0, keepAbove: true, keepBelow: true, flipAbove: false, swap: ['a0'] });
    const parts = useStore.getState().objects;
    expect(parts.length).toBe(2);
    const lower = parts.find((p) => p.name.endsWith('(lower)'))!, upper = parts.find((p) => p.name.endsWith('(upper)'))!;
    // the swapped pillar top stays whole with the lower part; the upper part is one pillar top only
    expect(worldBounds(lower).max[2] - worldBounds(lower).min[2]).toBeCloseTo(25, 1);
    expect(worldBounds(upper).max[0] - worldBounds(upper).min[0]).toBeCloseTo(6, 1);
  });

  it.each([
    ['dovetail', { groove: { ...DEFAULT_GROOVE, depth: 1.5, width: 4 } }],
    ['connectors', { connectors: [{ x: 10, y: 0 }], connector: { ...DEFAULT_CONNECTOR, size: 3, depth: 3 } }],
  ])('keeps a swapped piece whole with %s', (_, extra) => {
    const o = objectFromWorld('U', mesh);
    const h = worldBounds(o).min[2] + 15;
    useStore.setState({ objects: [o], selected: [o.id], toast: null });
    cutObject(o.id, { height: h, tiltX: 0, tiltY: 0, keepAbove: true, keepBelow: true, flipAbove: false, swap: ['a0'], ...extra });
    expect(useStore.getState().toast?.text ?? '').not.toMatch(/failed/);
    const lower = useStore.getState().objects.find((p) => p.name.endsWith('(lower)'))!;
    expect(worldBounds(lower).max[2] - worldBounds(lower).min[2]).toBeCloseTo(25, 1);
  });
});
