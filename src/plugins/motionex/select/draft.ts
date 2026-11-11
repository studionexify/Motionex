// Draft of the Select window's motions, made on the spot from the geometry already on screen: the last slice's
// lines (sliced without the rule motions) get the rule motions applied right here, with the same motion code the
// slicer runs, so a slider moves the lines at once. Only the layers a motion reaches are worked on. The exact
// path (and its G-code) is made by a real slice when the window closes.
import type { LayerOps, Op } from '../../../engine/gcode';
import { MOVE_STRIDE } from '../../../engine/gcode';
import { FEATURE_ORDER, type FeatureType, type SliceOutput } from '../../../engine/types';
import type { Config } from '../../../profiles/settings';
import { applyMotion, DEFAULT_OPTIONS, type ModifierOptions } from '../modifier';
import { RegionRegistry } from '../core/regions';
import { emptyCheck } from '../core/types';
import { opsToLayers, profilesFromConfig } from '../engine';
import type { MotionBrush } from '../model';
import { ruleActive, type SelectRule } from './model';
import { ruleMotions, type RuleSession } from './engine';
import { piecesAt } from './geometry';

export interface Draft {
  /** Moved lines as segments: start xyz, end xyz. */
  pos: Float32Array;
  /** Slice moves whose lines were replaced (hide them). */
  replaced: Set<number>;
  /** Pauses: x, y, z, seconds. */
  pauses: Float32Array;
  /** Layers worked on, and how long it took (ms). */
  layers: number;
  ms: number;
  /** Rules whose motion was made smaller so it stays clear of the next wall. */
  limited: { id: string; name: string; mm: number }[];
}

export interface DraftInput {
  result: SliceOutput;
  rules: SelectRule[];
  now: Record<string, [number, number]>;
  /** Object boxes (plate mm), standing in for the outlines of rules limited to one object. */
  boxes: { id: string; min: [number, number, number]; max: [number, number, number] }[];
  brushOf: (id: string) => MotionBrush | undefined;
  cfg: Config;
  printerId: string;
  options?: ModifierOptions;
}

const SKIP = new Set<FeatureType>(['skirt', 'brim', 'prime_tower']);

export function makeDraft(d: DraftInput): Draft | null {
  const t0 = performance.now();
  const rules = d.rules.filter((r) => ruleActive(r) && r.apply.motion);
  const R = d.result;
  if (!rules.length || !R.layers.length) return null;
  // the layers some motion reaches (with its soft edge)
  const touched = new Set<number>();
  R.layers.forEach((L, li) => { if (rules.some((r) => piecesAt(r, L.z, L.height, d.now).length)) touched.add(li); });
  if (!touched.size) return null;
  // the slice's moves of those layers, back as moves (plastic is not needed for the shape, only that it prints)
  const firstOf: number[] = [];
  const layerOps: LayerOps[] = R.layers.map((L, li) => {
    const ops: Op[] = [];
    firstOf[li] = L.moveStart;
    if (!touched.has(li)) return { z: L.z, h: L.height, ops } as LayerOps;
    for (let k = L.moveStart; k < L.moveEnd; k++) {
      const b = k * MOVE_STRIDE, f = FEATURE_ORDER[R.moveFeatures[k]];
      const travel = f === 'travel' || SKIP.has(f);
      ops.push({ k: 'move', x: R.moves[b], y: R.moves[b + 1], z: R.moves[b + 2], e: travel ? 0 : 1, f: (R.moves[b + 5] || 30) * 60, feature: travel ? 'travel' : f, w: R.moves[b + 3] || 0.42, h: R.moves[b + 4] || L.height, travel });
    }
    return { z: L.z, h: L.height, ops, layer: li } as LayerOps;
  });
  const boxOf = new Map(d.boxes.map((b) => [b.id, b]));
  const session: RuleSession = {
    now: d.now,
    outline(_l, obj) {
      const b = boxOf.get(obj);
      if (!b) return null;
      const S = 1e4, p = (x: number, y: number) => ({ X: Math.round(x * S), Y: Math.round(y * S) });
      return [[p(b.min[0] - 1, b.min[1] - 1), p(b.max[0] + 1, b.min[1] - 1), p(b.max[0] + 1, b.max[1] + 1), p(b.min[0] - 1, b.max[1] + 1)]];
    },
  };
  const picked = ruleMotions(rules, layerOps, session, d.brushOf);
  if (!picked.apps.length) return null;
  const regions = new RegionRegistry();
  for (const r of picked.regions) regions.set(r);
  const { layers, runs } = opsToLayers(layerOps);
  const res = applyMotion(layers, picked.apps, d.brushOf, profilesFromConfig(d.cfg, d.printerId), d.options ?? DEFAULT_OPTIONS, emptyCheck(), regions);
  // map changed paths back to their runs (same order per layer), then to the slice moves they replace
  const perLayer = new Map<number, number>();
  const pos: number[] = [], pauses: number[] = [];
  const replaced = new Set<number>();
  for (const run of runs) {
    const k = perLayer.get(run.layer) ?? 0;
    perLayer.set(run.layer, k + 1);
    const path = res.layers[run.layer].paths[k];
    if (!path || path.modifiedBy !== 'motionex') continue;
    for (let j = run.start; j < run.end; j++) replaced.add(firstOf[run.layer] + j);
    const P = path.points;
    for (let j = 1; j < P.length; j++) {
      const a = P[j - 1], b = P[j];
      if (!b.travel) pos.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }
    for (const q of P) if (q.post?.dwell_ms) pauses.push(q.x, q.y, q.z, q.post.dwell_ms / 1000);
  }
  return { pos: new Float32Array(pos), replaced, pauses: new Float32Array(pauses), layers: touched.size, limited: picked.limited, ms: performance.now() - t0 };
}
