// Overhang detection for any sliced model: compares a layer with the one below and returns, per
// connected unsupported component, the overhang polygon and the solid anchor it can clamp onto.
// Works on Clipper integer paths (engine units) so it plugs straight into the slicer's layer data.
import { difference, intersection, offset, toExPolygons, exToPaths, areaTotal, opening, union } from '../../../engine/clipper';
import type { Paths } from '../../../engine/types';
import { triggerWidth, type HanexProfile } from './profile';

export interface OverhangComponent {
  /** Unsupported area of this layer (outer contour + holes; holes are obstacles). */
  overhang: Paths;
  /** Supported part of this layer near the overhang: the solid the arcs clamp onto. */
  anchor: Paths;
  /** mm² */
  area: number;
}

export interface DetectResult {
  components: OverhangComponent[];
  /** Unsupported pieces with nothing solid next to them (floating islands): Hanex cannot start a wave there. */
  floating: Paths;
  /**
   * Overhang at least one bead wide but narrower than the trigger width: a rising underside steeper than
   * the print head's face-angle limit. Left to normal printing, where whole beads hang in the air.
   */
  pastLimit: Paths;
}

/**
 * current: cross-section of layer Z. below: cross-section of layer Z−1 (union of everything that will
 * actually be printed there, including a previous Hanex sheet).
 */
export function detectOverhangs(current: Paths, below: Paths, p: HanexProfile): DetectResult {
  const w = p.lineWidth;
  const raw = difference(current, below);
  if (!raw.length) return { components: [], floating: [], pastLimit: [] };
  // what a normal bead can still reach from the edge below is not Hanex's job
  const beyondReach = difference(current, offset(below, p.supportReach));
  const wide = opening(beyondReach, triggerWidth(p) / 2);
  // a whole bead hangs in the air once the unsupported band is a bead wide
  const beadWide = opening(raw, w / 2);
  const pastLimit = beadWide.length ? (wide.length ? difference(beadWide, offset(wide, w)) : beadWide) : [];
  if (!wide.length) return { components: [], floating: [], pastLimit };
  const supported = intersection(current, below);
  const components: OverhangComponent[] = [];
  const floating: Paths = [];
  for (const ex of toExPolygons(raw)) {
    const piece = exToPaths(ex);
    if (!intersection(piece, wide).length) continue;
    const reach = offset(piece, p.leadIn + Math.max(p.startRadius, 0) + 2 * w);
    const anchor = intersection(supported, reach);
    // the anchor has to touch the overhang, not just be nearby across a gap
    const touching = intersection(offset(piece, 0.05), anchor);
    if (!touching.length || areaTotal(touching) < 1e-4) { floating.push(...piece); continue; }
    components.push({ overhang: piece, anchor: union(anchor), area: areaTotal(piece) });
  }
  return { components, floating, pastLimit };
}
