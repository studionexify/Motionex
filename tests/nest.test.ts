import { describe, expect, it } from 'vitest';
import { nest, type Mirror, type NestPlacement, type NestRequest } from '../src/engine/nest';

type Tri = number[]; // x0,y0,x1,y1,x2,y2

const rect = (x0: number, y0: number, x1: number, y1: number): Tri[] => [[x0, y0, x1, y0, x1, y1], [x0, y0, x1, y1, x0, y1]];
const flat = (t: Tri[]) => Float32Array.from(t.flat());
/** A C opening to the right, 30 x 30 with 6 mm arms, centred on the origin. */
const C = [...rect(-15, -15, -9, 15), ...rect(-15, 9, 15, 15), ...rect(-15, -15, 15, -9)];

const req = (tris: Tri[], over: Partial<NestRequest> = {}): NestRequest => ({
  tris: flat(tris), bed: { x: 100, y: 100 }, res: 0.25, margin: 0, gaps: Array(8).fill(2), edge: 0,
  rotations: [0], mirrors: ['none'], obstacles: [], excluded: [], ...over,
});

/** The shape as placed on the bed. */
function placed(tris: Tri[], p: NestPlacement): Tri[] {
  const a = (p.rotation * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  const mx = p.mirror === 'x' ? -1 : 1, my = p.mirror === 'y' ? -1 : 1;
  return tris.map((t) => {
    const o: number[] = [];
    for (let i = 0; i < 6; i += 2) { const x = t[i] * mx, y = t[i + 1] * my; o.push(c * x - s * y + p.x, s * x + c * y + p.y); }
    return o;
  });
}

const segDist = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number) => {
  const pt = (px: number, py: number, x0: number, y0: number, x1: number, y1: number) => {
    const vx = x1 - x0, vy = y1 - y0, l = vx * vx + vy * vy;
    const t = l ? Math.max(0, Math.min(1, ((px - x0) * vx + (py - y0) * vy) / l)) : 0;
    return Math.hypot(px - x0 - t * vx, py - y0 - t * vy);
  };
  const o = (px: number, py: number, qx: number, qy: number, rx: number, ry: number) => Math.sign((qx - px) * (ry - py) - (qy - py) * (rx - px));
  if (o(ax, ay, bx, by, cx, cy) * o(ax, ay, bx, by, dx, dy) < 0 && o(cx, cy, dx, dy, ax, ay) * o(cx, cy, dx, dy, bx, by) < 0) return 0;
  return Math.min(pt(ax, ay, cx, cy, dx, dy), pt(bx, by, cx, cy, dx, dy), pt(cx, cy, ax, ay, bx, by), pt(dx, dy, ax, ay, bx, by));
};
const inTri = (x: number, y: number, t: Tri) => {
  const d = (i: number, j: number) => (t[j] - t[i]) * (y - t[i + 1]) - (t[j + 1] - t[i + 1]) * (x - t[i]);
  const a = d(0, 2), b = d(2, 4), c = d(4, 0);
  return (a >= 0 && b >= 0 && c >= 0) || (a <= 0 && b <= 0 && c <= 0);
};
/** Smallest distance between two triangle sets (0 when they overlap). */
function distance(A: Tri[], B: Tri[]): number {
  let best = Infinity;
  for (const a of A) for (const b of B) {
    if (inTri(a[0], a[1], b) || inTri(b[0], b[1], a)) return 0;
    for (let i = 0; i < 6; i += 2) for (let j = 0; j < 6; j += 2) {
      const i2 = (i + 2) % 6, j2 = (j + 2) % 6;
      best = Math.min(best, segDist(a[i], a[i + 1], a[i2], a[i2 + 1], b[j], b[j + 1], b[j2], b[j2 + 1]));
    }
  }
  return best;
}
function minGap(tris: Tri[], out: NestPlacement[]) {
  const shapes = out.map((p) => placed(tris, p));
  let g = Infinity;
  for (let i = 0; i < shapes.length; i++) for (let j = i + 1; j < shapes.length; j++) g = Math.min(g, distance(shapes[i], shapes[j]));
  return g;
}
function onBed(tris: Tri[], out: NestPlacement[], bed: { x: number; y: number }) {
  return out.every((p) => placed(tris, p).every((t) => [0, 2, 4].every((i) => t[i] >= -1e-6 && t[i] <= bed.x + 1e-6 && t[i + 1] >= -1e-6 && t[i + 1] <= bed.y + 1e-6)));
}

describe('fill bed nesting', () => {
  it('fills a plate with squares, keeping the gap and staying on the bed', () => {
    const sq = rect(-10, -10, 10, 10);
    const out = nest(req(sq));
    expect(out.length).toBe(16);
    expect(minGap(sq, out)).toBeGreaterThanOrEqual(2);
    expect(onBed(sq, out, { x: 100, y: 100 })).toBe(true);
  });

  it('never lets copies touch, even with a zero gap', () => {
    const sq = rect(-10, -10, 10, 10);
    const out = nest(req(sq, { gaps: Array(8).fill(0) }));
    expect(out.length).toBe(16);
    expect(minGap(sq, out)).toBeGreaterThan(0);
  });

  it('turns a C round so a second one hooks into its opening', () => {
    const bed = { x: 60, y: 40 };
    expect(nest(req(C, { bed })).length).toBe(1);
    const out = nest(req(C, { bed, rotations: [0, 180] }));
    expect(out.length).toBe(2);
    expect(out[1].rotation).toBe(180);
    expect(minGap(C, out)).toBeGreaterThanOrEqual(2);
    expect(onBed(C, out, bed)).toBe(true);
  });

  it('keeps per-direction gaps (opposite directions share the larger one)', () => {
    const sq = rect(-10, -10, 10, 10);
    // 8 mm to the east (so also to the west), 1 mm north/south
    const out = nest(req(sq, { gaps: [1, 1, 8, 1, 1, 1, 1, 1] }));
    // squares side by side (overlapping rows) are 8 mm apart; stacked ones (overlapping columns) at least 1 mm
    let sideBySide = 0;
    for (const p of out) for (const q of out) {
      if (p === q) continue;
      const dx = Math.abs(p.x - q.x) - 20, dy = Math.abs(p.y - q.y) - 20;
      if (dy < 0) { sideBySide++; expect(dx).toBeGreaterThanOrEqual(8); }
      if (dx < 0) expect(dy).toBeGreaterThanOrEqual(1);
    }
    expect(sideBySide).toBeGreaterThan(0);
    expect(out.length).toBeGreaterThanOrEqual(11);
  });

  it('grows each copy by its brim and supports before keeping the gap', () => {
    const sq = rect(-10, -10, 10, 10);
    const out = nest(req(sq, { margin: 5, gaps: Array(8).fill(1) }));
    expect(minGap(sq, out)).toBeGreaterThanOrEqual(11);
  });

  it('works around obstacles and excluded areas', () => {
    const sq = rect(-10, -10, 10, 10);
    const obstacle = flat(rect(40, 40, 60, 60));
    const out = nest(req(sq, { obstacles: [{ tris: obstacle, margin: 0 }], excluded: [[[0, 0], [30, 0], [30, 30], [0, 30]]] }));
    expect(out.length).toBeGreaterThan(5);
    for (const p of out) {
      expect(distance(placed(sq, p), rect(40, 40, 60, 60))).toBeGreaterThanOrEqual(2);
      expect(distance(placed(sq, p), rect(0, 0, 30, 30))).toBeGreaterThan(0);
    }
  });

  it('only mirrors copies, never the first one, and mirrored copies do not collide', () => {
    // an L shape
    const L = [...rect(-10, -10, -4, 10), ...rect(-10, -10, 10, -4)];
    const mirrors: Mirror[] = ['none', 'x', 'y'];
    const out = nest(req(L, { mirrors, rotations: [0, 90, 180, 270] }));
    expect(out[0].mirror).toBe('none');
    expect(minGap(L, out)).toBeGreaterThanOrEqual(2);
    expect(onBed(L, out, { x: 100, y: 100 })).toBe(true);
  });

  it('stops at the requested number of copies', () => {
    expect(nest(req(rect(-5, -5, 5, 5), { max: 3 })).length).toBe(3);
  });
});
