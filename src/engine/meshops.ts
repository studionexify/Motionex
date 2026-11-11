// Mesh operations for the Prepare tools: planar cut with capped faces.
import { ShapeUtils, Vector2 } from 'three';
import { weld, type IndexedMesh } from './mesh';

export interface CutResult { below: IndexedMesh | null; above: IndexedMesh | null; capLoops: number; openLoops: number }

/**
 * Cut a mesh (vertices already in the cut frame) by the plane z = 0. Triangles crossing the plane
 * are split exactly; the cross-section is triangulated (outer contours with holes) to close both halves.
 */
export function cutAtZ0(m: IndexedMesh): CutResult {
  const V = m.vertices, I = m.indices;
  const nv = V.length / 3;
  const z = new Float64Array(nv);
  for (let i = 0; i < nv; i++) { const d = V[i * 3 + 2]; z[i] = Math.abs(d) < 1e-6 ? 1e-6 : d; } // nothing exactly on the plane
  const below: number[] = [], above: number[] = [];
  const P = (i: number) => [V[i * 3], V[i * 3 + 1], V[i * 3 + 2]];
  const edgePt = new Map<string, [number, number, number]>();
  const cross = (a: number, b: number): [number, number, number] => {
    const lo = Math.min(a, b), hi = Math.max(a, b), key = `${lo}_${hi}`;
    let p = edgePt.get(key);
    if (!p) {
      const t = z[lo] / (z[lo] - z[hi]);
      p = [V[lo * 3] + (V[hi * 3] - V[lo * 3]) * t, V[lo * 3 + 1] + (V[hi * 3 + 1] - V[lo * 3 + 1]) * t, 0];
      edgePt.set(key, p);
    }
    return p;
  };
  const segs: [[number, number], [number, number]][] = [];
  for (let t = 0; t < I.length; t += 3) {
    const tri = [I[t], I[t + 1], I[t + 2]];
    const s = tri.map((i) => z[i] > 0);
    const nAbove = s.filter(Boolean).length;
    if (nAbove === 0) { for (const i of tri) below.push(...P(i)); continue; }
    if (nAbove === 3) { for (const i of tri) above.push(...P(i)); continue; }
    // rotate so the lone vertex is first
    const lone = nAbove === 1 ? s.indexOf(true) : s.indexOf(false);
    const a = tri[lone], b = tri[(lone + 1) % 3], c = tri[(lone + 2) % 3];
    const pab = cross(a, b), pca = cross(c, a);
    const loneSide = z[a] > 0 ? above : below, other = z[a] > 0 ? below : above;
    loneSide.push(...P(a), ...pab, ...pca);
    other.push(...pab, ...P(b), ...P(c), ...pab, ...P(c), ...pca);
    segs.push([[pab[0], pab[1]], [pca[0], pca[1]]]);
  }
  // chain cross-section segments into loops
  const key = (p: [number, number]) => `${Math.round(p[0] * 1e5)},${Math.round(p[1] * 1e5)}`;
  const adj = new Map<string, { p: [number, number]; n: string[] }>();
  for (const [p, q] of segs) {
    const kp = key(p), kq = key(q);
    if (kp === kq) continue;
    if (!adj.has(kp)) adj.set(kp, { p, n: [] });
    if (!adj.has(kq)) adj.set(kq, { p: q, n: [] });
    adj.get(kp)!.n.push(kq); adj.get(kq)!.n.push(kp);
  }
  const used = new Set<string>();
  const loops: [number, number][][] = [];
  let openLoops = 0;
  for (const [k0] of adj) {
    if (used.has(k0)) continue;
    const loop: [number, number][] = [];
    let prev = '', cur = k0, closed = false;
    for (let guard = 0; guard < adj.size + 2; guard++) {
      used.add(cur);
      const node = adj.get(cur)!;
      loop.push(node.p);
      const next = node.n.find((x) => x !== prev && (!used.has(x) || (x === k0 && loop.length > 2)));
      if (!next) break;
      if (next === k0) { closed = true; break; }
      prev = cur; cur = next;
    }
    if (closed && loop.length >= 3) loops.push(loop); else openLoops++;
  }
  // nesting: even depth = outer contour, odd = hole
  const area = (l: [number, number][]) => { let a = 0; for (let i = 0; i < l.length; i++) { const p = l[i], q = l[(i + 1) % l.length]; a += p[0] * q[1] - q[0] * p[1]; } return a / 2; };
  const inside = (pt: [number, number], l: [number, number][]) => {
    let c = false;
    for (let i = 0, j = l.length - 1; i < l.length; j = i++) {
      const a = l[i], b = l[j];
      if ((a[1] > pt[1]) !== (b[1] > pt[1]) && pt[0] < ((b[0] - a[0]) * (pt[1] - a[1])) / (b[1] - a[1]) + a[0]) c = !c;
    }
    return c;
  };
  const depth = loops.map((l, i) => loops.reduce((d, o, j) => d + (j !== i && inside(l[0], o) ? 1 : 0), 0));
  for (let i = 0; i < loops.length; i++) {
    if (depth[i] % 2) continue;
    const outer = area(loops[i]) < 0 ? loops[i].slice().reverse() : loops[i];
    const holes = loops.filter((h, j) => depth[j] === depth[i] + 1 && inside(h[0], loops[i])).map((h) => (area(h) > 0 ? h.slice().reverse() : h));
    const contour = outer.map((p) => new Vector2(p[0], p[1]));
    const hs = holes.map((h) => h.map((p) => new Vector2(p[0], p[1])));
    const pts = [...contour, ...hs.flat()];
    for (const [a, b, c] of ShapeUtils.triangulateShape(contour, hs)) {
      const A = pts[a], B = pts[b], C = pts[c];
      const ccw = (B.x - A.x) * (C.y - A.y) - (B.y - A.y) * (C.x - A.x) > 0;
      const [p, q] = ccw ? [B, C] : [C, B];
      below.push(A.x, A.y, 0, p.x, p.y, 0, q.x, q.y, 0); // cap faces +z on the lower part
      above.push(A.x, A.y, 0, q.x, q.y, 0, p.x, p.y, 0); // and −z on the upper part
    }
  }
  return {
    below: below.length ? weld(new Float32Array(below)) : null,
    above: above.length ? weld(new Float32Array(above)) : null,
    capLoops: loops.length, openLoops,
  };
}
