// Print-head shape and the collision check for up-and-down (non-planar) moves.
// The head is a cone around the nozzle tip plus simple boxes and cylinders (heater block, fan duct,
// carriage). Already-printed plastic is tracked in a height map; a nozzle point collides when any
// part of the head would sit lower than the plastic underneath it.
import type { Layer, PrintCheck, SliceWarning } from "./types";

export interface HeadVolume {
  name: string;
  shape: "box" | "cylinder";
  /** box: [width X, depth Y, height Z]; cylinder: [radius, height, 0]. mm. */
  dims: [number, number, number];
  /** Offset of the volume's bottom centre from the nozzle tip, mm. Z is how far above the tip it starts. */
  offset: [number, number, number];
}

export interface ToolheadProfile {
  device_id: string;
  name: string;
  nozzle: { tip_len: number; cone_angle_deg: number; tip_diameter: number };
  volumes: HeadVolume[];
  /** Extra gap kept between the head and the print, mm. */
  margin: number;
}

export type CollisionMode = "clamp" | "skip" | "fail";

/** Reasonable starting shapes; users edit and save their own per printer. */
export const DEFAULT_TOOLHEADS: Record<string, ToolheadProfile> = {
  "x1c-hotend": {
    device_id: "x1c-hotend", name: "Bambu Lab X1C hotend",
    nozzle: { tip_len: 2.2, cone_angle_deg: 40, tip_diameter: 1.0 },
    volumes: [
      { name: "Heater block", shape: "box", dims: [14, 16, 10], offset: [0, 0, 2.2] },
      { name: "Part fan duct", shape: "box", dims: [40, 12, 6], offset: [0, -14, 6] },
      { name: "Carriage", shape: "box", dims: [60, 60, 30], offset: [0, 0, 18] },
    ],
    margin: 0.2,
  },
  "voron-24-350": {
    device_id: "voron-24-350", name: "Voron Stealthburner + Revo",
    nozzle: { tip_len: 3.5, cone_angle_deg: 45, tip_diameter: 1.2 },
    volumes: [
      { name: "Heater core", shape: "cylinder", dims: [7, 10, 0], offset: [0, 0, 3.5] },
      { name: "Part fan ducts", shape: "box", dims: [46, 20, 8], offset: [0, 0, 7] },
      { name: "Carriage", shape: "box", dims: [55, 55, 40], offset: [0, 0, 16] },
    ],
    margin: 0.2,
  },
  "prusa-mk3s": {
    device_id: "prusa-mk3s", name: "Prusa MK3S E3D V6",
    nozzle: { tip_len: 3.0, cone_angle_deg: 30, tip_diameter: 1.0 },
    volumes: [
      { name: "Heater block", shape: "box", dims: [16, 23, 11.5], offset: [-4, 0, 3] },
      { name: "Fan shroud", shape: "box", dims: [44, 36, 10], offset: [0, 6, 12] },
      { name: "Extruder body", shape: "box", dims: [60, 60, 50], offset: [0, 10, 24] },
    ],
    margin: 0.2,
  },
};

/** Nexspiro printer ids → the closest starting shape. Measure your own head for tight motions. */
const SHAPE_FOR: Record<string, string> = {
  "bbl-a1": "x1c-hotend", "bbl-a1mini": "x1c-hotend", "bbl-p1s": "x1c-hotend", "bbl-p1p": "x1c-hotend",
  "bbl-x1c": "x1c-hotend", "bbl-x1e": "x1c-hotend", "bbl-h2d": "x1c-hotend",
  "creality-ender3v3ke": "voron-24-350", "elegoo-neptune4max": "voron-24-350", "elegoo-centauri": "x1c-hotend",
};

export function defaultToolhead(deviceId: string): ToolheadProfile {
  const base = DEFAULT_TOOLHEADS[deviceId] ?? DEFAULT_TOOLHEADS[SHAPE_FOR[deviceId] ?? "x1c-hotend"];
  const known = deviceId in DEFAULT_TOOLHEADS || deviceId in SHAPE_FOR;
  return structuredClone({ ...base, device_id: deviceId, name: known ? base.name : "Generic hotend" });
}

/** Highest printed plastic per square cell, plus a coarse map for quick "nothing nearby" answers. */
export class HeightMap {
  readonly cell: number; readonly nx: number; readonly ny: number;
  private h: Float32Array; private coarse: Float32Array; private cnx: number; private cny: number;
  private static readonly K = 8; // fine cells per coarse cell
  constructor(width: number, depth: number, cell = 0.5) {
    this.cell = cell; this.nx = Math.ceil(width / cell) + 1; this.ny = Math.ceil(depth / cell) + 1;
    this.h = new Float32Array(this.nx * this.ny);
    this.cnx = Math.ceil(this.nx / HeightMap.K); this.cny = Math.ceil(this.ny / HeightMap.K);
    this.coarse = new Float32Array(this.cnx * this.cny);
  }
  stamp(x: number, y: number, z: number): void {
    const i = Math.round(x / this.cell), j = Math.round(y / this.cell);
    if (i < 0 || j < 0 || i >= this.nx || j >= this.ny) return;
    const k = j * this.nx + i;
    if (z > this.h[k]) {
      this.h[k] = z;
      const c = Math.floor(j / HeightMap.K) * this.cnx + Math.floor(i / HeightMap.K);
      if (z > this.coarse[c]) this.coarse[c] = z;
    }
  }
  /** Max height in an axis-aligned rectangle. */
  maxIn(x0: number, y0: number, x1: number, y1: number): number {
    const K = HeightMap.K;
    const i0 = Math.max(0, Math.floor(x0 / this.cell)), j0 = Math.max(0, Math.floor(y0 / this.cell));
    const i1 = Math.min(this.nx - 1, Math.ceil(x1 / this.cell)), j1 = Math.min(this.ny - 1, Math.ceil(y1 / this.cell));
    let m = 0;
    for (let cj = Math.floor(j0 / K); cj <= Math.floor(j1 / K); cj++) for (let ci = Math.floor(i0 / K); ci <= Math.floor(i1 / K); ci++) m = Math.max(m, this.coarse[cj * this.cnx + ci] ?? 0);
    if (m === 0) return 0;
    m = 0;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) m = Math.max(m, this.h[j * this.nx + i]);
    return m;
  }
  /** Lowest nozzle-tip height that keeps the cone clear of printed cells around (x, y). */
  coneFloor(x: number, y: number, rTip: number, tipLen: number, tanA: number): number {
    const R = rTip + tipLen * tanA;
    if (this.maxIn(x - R, y - R, x + R, y + R) === 0) return 0;
    const i0 = Math.max(0, Math.floor((x - R) / this.cell)), i1 = Math.min(this.nx - 1, Math.ceil((x + R) / this.cell));
    const j0 = Math.max(0, Math.floor((y - R) / this.cell)), j1 = Math.min(this.ny - 1, Math.ceil((y + R) / this.cell));
    let floor = 0;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const hh = this.h[j * this.nx + i]; if (hh <= 0) continue;
      const d = Math.hypot(i * this.cell - x, j * this.cell - y);
      // Directly under the tip (within half a map cell of its edge) is the bead being printed onto.
      if (d > R || d < rTip + this.cell / 2) continue;
      floor = Math.max(floor, hh - (d - rTip - this.cell / 2) / tanA);
    }
    return floor;
  }
}

/**
 * Walk the print in order, keeping a height map of what is already printed, and test every point
 * that moves up or down. Plastic from the current path counts once the nozzle is 3 mm past it.
 */
export function checkCollisions(layers: Layer[], head: ToolheadProfile, bed: { x: number; y: number }, mode: CollisionMode, check: PrintCheck, warn: (w: SliceWarning) => void): void {
  const map = new HeightMap(bed.x, bed.y);
  const tanA = Math.tan((head.nozzle.cone_angle_deg * Math.PI) / 180), rTip = head.nozzle.tip_diameter / 2;
  const LAG = 3;
  let found = 0;
  for (const layer of layers) for (const path of layer.paths) {
    const pts = path.points;
    let stampedTo = 0, s = 0;
    const along: number[] = [0];
    for (let i = 1; i < pts.length; i++) along.push(along[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i]; s = along[i];
      while (stampedTo < i && along[stampedTo] < s - LAG) { const q = pts[stampedTo++]; if (!q.travel) map.stamp(q.x, q.y, q.z); }
      const nominal = layer.z;
      if (Math.abs(p.z - nominal) < 1e-6) continue; // flat moves are safe by construction
      let floor = p.z < head.margin ? head.margin : 0; // bed
      // The nozzle cone is compared directly with the plastic (it normally rides one layer above it);
      // the safety gap is kept for the bigger parts of the head.
      floor = Math.max(floor, map.coneFloor(p.x, p.y, rTip, head.nozzle.tip_len, tanA));
      for (const v of head.volumes) {
        const cx = p.x + v.offset[0], cy = p.y + v.offset[1];
        const hx = v.shape === "box" ? v.dims[0] / 2 : v.dims[0], hy = v.shape === "box" ? v.dims[1] / 2 : v.dims[0];
        const top = map.maxIn(cx - hx, cy - hy, cx + hx, cy + hy);
        if (top > 0) floor = Math.max(floor, top - v.offset[2] + head.margin);
      }
      if (p.z >= floor - 1e-6) continue;
      found++;
      if (check.collisions.length < 200) check.collisions.push({ x: round(p.x), y: round(p.y), z: round(p.z), layer: layer.index });
      p.flag = "collision";
      if (mode === "clamp") { p.z = round(Math.min(Math.max(floor, p.z), Math.max(nominal, floor))); p.zOff = round(p.z - nominal); }
      else if (mode === "skip") { p.z = nominal; p.zOff = 0; }
    }
    for (; stampedTo < pts.length; stampedTo++) { const q = pts[stampedTo]; if (!q.travel) map.stamp(q.x, q.y, q.z); }
  }
  check.collisionCount += found;
  if (!found) return;
  if (mode === "fail") {
    check.blocking = true;
    warn({ code: "collision_fail", message: `The print head would hit the print in ${found} spots. Export is stopped until you fix it (see the check report).` });
  } else {
    warn({ code: "collision_fixed", message: mode === "clamp" ? `Lowered the up-and-down movement in ${found} spots so the print head stays clear` : `Skipped the up-and-down movement in ${found} spots where the print head would hit` });
  }
}

const round = (v: number) => Math.round(v * 1e4) / 1e4;

/** Hold every move's up/down speed to the printer's limit (run after anything that changes Z). Returns moves slowed. */
export function limitZSpeed(layers: Layer[], maxZ: number): number {
  let n = 0;
  for (const l of layers) for (const p of l.paths) for (let i = 1; i < p.points.length; i++) {
    const a = p.points[i - 1], q = p.points[i];
    const len = Math.hypot(q.x - a.x, q.y - a.y, q.z - a.z), dz = Math.abs(q.z - a.z);
    if (dz > 1e-9 && len > 0 && (q.f * dz) / len > maxZ) { q.f = (maxZ * len) / dz; n++; }
  }
  return n;
}
