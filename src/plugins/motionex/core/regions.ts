// Shared region model (spec §8). Patternex publishes regions; Motionex (and future plugins) clip to them.
// Contract: { region_id, layer_range, polygon_mask_per_layer, attributes }. Polygons are CCW lists of [x, y] in plate mm.
// Until Patternex exists, Nexspiro offers simple regions drawn by the user: a height band or a box.

export type Polygon = [number, number][];

export interface PatternexRegion {
  region_id: string;
  name: string;
  /** Inclusive layer index range. */
  layer_range: [number, number];
  /** Masks for a given layer. Function form so large plates need not precompute every layer. */
  polygon_mask_per_layer: (layer: number) => Polygon[];
  /** Effects stack order: mask → material (Patternex) → motion (Motionex). */
  attributes: Record<string, unknown>;
}

/** User-made region definitions (serialisable). */
export type RegionDef =
  | { id: string; name: string; kind: "band"; z_from: number; z_to: number }
  | { id: string; name: string; kind: "box"; x: number; y: number; w: number; d: number; z_from: number; z_to: number };

export function regionFromDef(def: RegionDef, layerHeight: number, firstLayer: number, bed: { x: number; y: number }): PatternexRegion {
  const li = (z: number) => Math.max(0, Math.round((z - firstLayer) / layerHeight));
  const poly: Polygon = def.kind === "band"
    ? [[0, 0], [bed.x, 0], [bed.x, bed.y], [0, bed.y]]
    : [[def.x - def.w / 2, def.y - def.d / 2], [def.x + def.w / 2, def.y - def.d / 2], [def.x + def.w / 2, def.y + def.d / 2], [def.x - def.w / 2, def.y + def.d / 2]];
  return { region_id: def.id, name: def.name, layer_range: [li(def.z_from), li(def.z_to)], polygon_mask_per_layer: () => [poly], attributes: { source: "nexspiro", kind: def.kind } };
}

/** Registry shared by all plugins through the plugin host. */
export class RegionRegistry {
  private regions = new Map<string, PatternexRegion>();
  set(r: PatternexRegion): void { this.regions.set(r.region_id, r); }
  clear(): void { this.regions.clear(); }
  get(id: string): PatternexRegion | undefined { return this.regions.get(id); }
  all(): PatternexRegion[] { return [...this.regions.values()]; }
}

export function pointInPolygon(x: number, y: number, poly: Polygon): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Distance from a point to the nearest polygon edge. */
export function distanceToEdges(x: number, y: number, poly: Polygon): number {
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, ay] = poly[j], [bx, by] = poly[i];
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2));
    best = Math.min(best, Math.hypot(x - (ax + t * dx), y - (ay + t * dy)));
  }
  return best;
}

/** 0..1 weight for a point against a region on a layer: 1 inside, 0 outside, smooth across blend mm at the edge. */
export function regionWeight(r: PatternexRegion, layer: number, x: number, y: number, blend: number): number {
  if (layer < r.layer_range[0] || layer > r.layer_range[1]) return 0;
  let best = 0;
  for (const poly of r.polygon_mask_per_layer(layer)) {
    const inside = pointInPolygon(x, y, poly);
    if (blend <= 0) { if (inside) return 1; continue; }
    const d = distanceToEdges(x, y, poly) * (inside ? 1 : -1);
    const t = Math.max(0, Math.min(1, 0.5 + d / blend));
    best = Math.max(best, t * t * (3 - 2 * t));
  }
  return best;
}
