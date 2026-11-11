// Test shapes for the Advanced engine (triangle soups, welded on use).
import { weld } from '../../src/engine/mesh';
import { box, cylinder } from '../fixtures';

export const indexed = (soup: Float32Array, name = 'part') => { const m = weld(soup); return { id: name, name, vertices: m.vertices, indices: m.indices }; };

/** UV sphere centred at (cx, cy, cz). */
export function sphere(cx: number, cy: number, cz: number, r: number, seg = 32, rings = 16): Float32Array {
  const out: number[] = [];
  const p = (i: number, j: number) => {
    const th = (j / rings) * Math.PI, ph = (i / seg) * Math.PI * 2;
    return [cx + r * Math.sin(th) * Math.cos(ph), cy + r * Math.sin(th) * Math.sin(ph), cz + r * Math.cos(th)];
  };
  for (let j = 0; j < rings; j++) for (let i = 0; i < seg; i++) {
    const a = p(i, j), b = p(i + 1, j), c = p(i + 1, j + 1), d = p(i, j + 1);
    if (j > 0) out.push(...a, ...d, ...b);
    if (j < rings - 1) out.push(...b, ...d, ...c);
  }
  return new Float32Array(out);
}

/** Cylinder of radius r and height h0 capped by a spherical dome rising `rise` mm (a "silo"). */
export function dome(cx: number, cy: number, r: number, h0: number, rise: number, seg = 48, rings = 10): Float32Array {
  const out: number[] = [];
  const R = (r * r + rise * rise) / (2 * rise); // sphere radius through the rim and the apex
  const zc = h0 + rise - R;
  const top = (i: number, j: number) => {
    const rr = r * (1 - j / rings);
    const ph = (i / seg) * Math.PI * 2;
    const z = zc + Math.sqrt(Math.max(0, R * R - rr * rr));
    return [cx + rr * Math.cos(ph), cy + rr * Math.sin(ph), z];
  };
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
    const p0 = [cx + r * Math.cos(a0), cy + r * Math.sin(a0)], p1 = [cx + r * Math.cos(a1), cy + r * Math.sin(a1)];
    out.push(cx, cy, 0, p1[0], p1[1], 0, p0[0], p0[1], 0);
    out.push(p0[0], p0[1], 0, p1[0], p1[1], 0, p1[0], p1[1], h0);
    out.push(p0[0], p0[1], 0, p1[0], p1[1], h0, p0[0], p0[1], h0);
    for (let j = 0; j < rings; j++) {
      const a = top(i, j), b = top(i + 1, j), c = top(i + 1, j + 1), d = top(i, j + 1);
      out.push(...a, ...b, ...c);
      if (j < rings - 1) out.push(...a, ...c, ...d);
    }
  }
  return new Float32Array(out);
}

/** Open-top tube (vase-like shell) built as a solid ring: outer radius r, wall t, height h. */
export function tube(cx: number, cy: number, r: number, t: number, h: number, seg = 64): Float32Array {
  const out: number[] = [];
  const ri = r - t;
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
    const o0 = [cx + r * Math.cos(a0), cy + r * Math.sin(a0)], o1 = [cx + r * Math.cos(a1), cy + r * Math.sin(a1)];
    const i0 = [cx + ri * Math.cos(a0), cy + ri * Math.sin(a0)], i1 = [cx + ri * Math.cos(a1), cy + ri * Math.sin(a1)];
    // outer wall (normal out)
    out.push(o0[0], o0[1], 0, o1[0], o1[1], 0, o1[0], o1[1], h, o0[0], o0[1], 0, o1[0], o1[1], h, o0[0], o0[1], h);
    // inner wall (normal in)
    out.push(i0[0], i0[1], 0, i1[0], i1[1], h, i1[0], i1[1], 0, i0[0], i0[1], 0, i0[0], i0[1], h, i1[0], i1[1], h);
    // bottom ring (down) and top ring (up)
    out.push(o0[0], o0[1], 0, i0[0], i0[1], 0, i1[0], i1[1], 0, o0[0], o0[1], 0, i1[0], i1[1], 0, o1[0], o1[1], 0);
    out.push(o0[0], o0[1], h, o1[0], o1[1], h, i1[0], i1[1], h, o0[0], o0[1], h, i1[0], i1[1], h, i0[0], i0[1], h);
  }
  return new Float32Array(out);
}

/** A plate with a round through-hole (a boss/bolt hole) and a thin neck joining two blocks. */
export function bracket(cx: number, cy: number): Float32Array {
  const parts = [box(cx - 20, cy - 10, 0, 40, 20, 6), box(cx - 4, cy - 4, 6, 8, 8, 10), box(cx - 15, cy - 10, 16, 30, 20, 6)];
  const n = parts.reduce((s, p) => s + p.length, 0);
  const out = new Float32Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export { box, cylinder };
