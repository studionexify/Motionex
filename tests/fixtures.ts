// Procedural test meshes (triangle soups).
export function box(x0: number, y0: number, z0: number, sx: number, sy: number, sz: number): Float32Array {
  const x1 = x0 + sx, y1 = y0 + sy, z1 = z0 + sz;
  const v = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  return new Float32Array(f.flatMap((t) => t.flatMap((i) => v[i])));
}

/** A "T" shape: a pillar with a wide overhanging slab on top (needs support / bridges). */
export function tee(cx: number, cy: number): Float32Array {
  const a = box(cx - 5, cy - 5, 0, 10, 10, 10);
  const b = box(cx - 20, cy - 5, 10, 40, 10, 4);
  const out = new Float32Array(a.length + b.length);
  out.set(a); out.set(b, a.length);
  return out;
}

export function cylinder(cx: number, cy: number, r: number, h: number, seg = 64): Float32Array {
  const out: number[] = [];
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
    const p0 = [cx + r * Math.cos(a0), cy + r * Math.sin(a0)], p1 = [cx + r * Math.cos(a1), cy + r * Math.sin(a1)];
    out.push(cx, cy, 0, p1[0], p1[1], 0, p0[0], p0[1], 0);
    out.push(cx, cy, h, p0[0], p0[1], h, p1[0], p1[1], h);
    out.push(p0[0], p0[1], 0, p1[0], p1[1], 0, p1[0], p1[1], h);
    out.push(p0[0], p0[1], 0, p1[0], p1[1], h, p0[0], p0[1], h);
  }
  return new Float32Array(out);
}

/** Truncated cone (frustum) from radius r0 at z=0 to r1 at z=h. */
export function cone(cx: number, cy: number, r0: number, r1: number, h: number, seg = 64): Float32Array {
  const out: number[] = [];
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
    const b0 = [cx + r0 * Math.cos(a0), cy + r0 * Math.sin(a0)], b1 = [cx + r0 * Math.cos(a1), cy + r0 * Math.sin(a1)];
    const t0 = [cx + r1 * Math.cos(a0), cy + r1 * Math.sin(a0)], t1 = [cx + r1 * Math.cos(a1), cy + r1 * Math.sin(a1)];
    out.push(cx, cy, 0, b1[0], b1[1], 0, b0[0], b0[1], 0);
    out.push(cx, cy, h, t0[0], t0[1], h, t1[0], t1[1], h);
    out.push(b0[0], b0[1], 0, b1[0], b1[1], 0, t1[0], t1[1], h);
    out.push(b0[0], b0[1], 0, t1[0], t1[1], h, t0[0], t0[1], h);
  }
  return new Float32Array(out);
}

/** Purge of each filament change in Bambu Studio's change G-code: the E pushed inside its FLUSH_START / FLUSH_END
 *  blocks between M620 S<n>A and M621 S<n>A (0 for a change that flushes nothing). */
export function bambuFlushes(g: string): number[] {
  return [...g.matchAll(/^M620 S\d+A\b[\s\S]*?^M621 S\d+A/gm)].map((m) =>
    [...m[0].matchAll(/; FLUSH_START\n([\s\S]*?); FLUSH_END/g)].reduce((a, b) => a + [...b[1].matchAll(/^G1 E(-?[\d.]+)/gm)].reduce((x, e) => x + Number(e[1]), 0), 0));
}
