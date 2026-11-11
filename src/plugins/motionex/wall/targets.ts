// Which objects a wall-art mode goes on: a per-layer mask (plate mm, Clipper paths) of the chosen
// objects, or null for every object. Built from the slicer's own cross-sections in prepare().
import type { Paths } from '../../../engine/types';
import { offset } from '../../../engine/clipper';
import type { PrepareContext } from '../../api';

export interface ObjectMask {
  targets(o: number): boolean;
  /** Area of the chosen objects at a layer (null = every object). */
  maskAt(layer: number): Paths | null;
}

export function objectMask(objects: string[] | undefined, ctx: PrepareContext): ObjectMask {
  const ids = new Set(objects ?? []);
  const targets = (o: number) => !ids.size || ids.has(ctx.meshes[o]?.id);
  const cache = new Map<number, Paths | null>();
  return {
    targets,
    maskAt(layer) {
      if (!ids.size) return null;
      let m = cache.get(layer);
      if (m === undefined) {
        const all: Paths = [];
        for (let o = 0; o < ctx.meshes.length; o++) if (targets(o)) all.push(...ctx.sliceAt(o, layer));
        m = offset(all, 0.8);
        cache.set(layer, m);
      }
      return m;
    },
  };
}
