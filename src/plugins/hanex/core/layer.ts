// Layer-level entry point: any model's cross-sections in, wave toolpaths out.
import type { Paths } from '../../../engine/types';
import { detectOverhangs } from './detect';
import { planComponent, type RegionPlan } from './plan';
import type { HanexProfile } from './profile';
import type { Vec2 } from './geom';

export interface LayerPlan { plans: RegionPlan[]; floating: Paths; pastLimit: Paths; warnings: string[] }

/**
 * current / below: cross-sections of layer Z and Z−1 (Clipper paths). Components are planned in order
 * of nearest start, each continuing from where the previous one ended.
 */
export function planLayer(current: Paths, below: Paths, p: HanexProfile, start?: Vec2): LayerPlan {
  const { components, floating, pastLimit } = detectOverhangs(current, below, p);
  const plans: RegionPlan[] = [];
  let at = start;
  for (const c of components) {
    const plan = planComponent(c, p, { start: at });
    plans.push(plan);
    const last = plan.moves[plan.moves.length - 1];
    if (last) at = [last.x, last.y];
  }
  const warnings = plans.flatMap((pl) => pl.warnings);
  if (floating.length) warnings.push(`${floating.length} unsupported island(s) with no anchor on this layer`);
  return { plans, floating, pastLimit, warnings };
}
