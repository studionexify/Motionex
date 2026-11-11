// Reference scenario from the Hanex spec: a rectangular solid anchor with a 50 × 30 mm overhang
// protruding from one side, with one circular hole in the overhang.
import { difference, union } from '../../../engine/clipper';
import type { Paths } from '../../../engine/types';
import { toPath, type Vec2 } from './geom';
import { circleRing, rectRing } from './shapes';

export interface Scenario {
  /** Layer Z−1: the anchor block. */
  below: Paths;
  /** Layer Z: anchor block ∪ overhang, minus the hole. */
  current: Paths;
  hole: { c: Vec2; r: number };
  overhangRect: [number, number, number, number];
}

export function referenceScenario(o: { x?: number; y?: number; holeR?: number } = {}): Scenario {
  const x = o.x ?? 0, y = o.y ?? 0, r = o.holeR ?? 5;
  const anchor = toPath(rectRing(x, y, x + 60, y + 20));
  const overhangRect: [number, number, number, number] = [x + 5, y + 20, x + 55, y + 50];
  const c: Vec2 = [x + 30, y + 35];
  const current = difference(union([anchor, toPath(rectRing(...overhangRect))]), [toPath(circleRing(c, r))]);
  return { below: [anchor], current, hole: { c, r }, overhangRect };
}
