// Flenex painting. Colours are stored as a short list of operations (fill, piece, stroke, bucket, gradient...)
// that is replayed on the current mesh, so the paint follows the design when it is edited and rebuilt.
// The result is one palette slot (1-based) per triangle.
import type { IndexedMesh } from '../../engine/mesh';
import { fillTriangles } from '../../engine/brush';
import type { V3 } from './csg';
import type { Mark } from './creature';

export type PaintOp =
  | { kind: 'fill'; slot: number }
  | { kind: 'piece'; at: V3; slot: number }
  | { kind: 'stroke'; pts: V3[]; r: number; slot: number }
  | { kind: 'bucket'; at: V3; angle: number; slot: number }
  | { kind: 'gradient'; slots: number[]; /** along the spine (arc 0 → 1), or the world axis x / y / z when no spine is given */ axis: 'spine' | 'x' | 'y' | 'z'; steps: boolean }
  | { kind: 'alternate'; slots: number[] }
  | { kind: 'zones'; back: number; sides: number; /** share of the back that counts as "top" (normal pointing up) */ threshold: number }
  | { kind: 'features'; slots: Record<string, number> };

export interface PaintContext {
  mesh: IndexedMesh;
  triPiece: Int32Array;
  /** Centre line of the body (head → tail) for gradients, if the design has one. */
  spine?: V3[];
  marks?: Mark[];
}

const centroids = (m: IndexedMesh) => {
  const T = m.indices.length / 3, c = new Float32Array(T * 3), v = m.vertices, ix = m.indices;
  for (let t = 0; t < T; t++) for (let k = 0; k < 3; k++) c[t * 3 + k] = (v[ix[t * 3] * 3 + k] + v[ix[t * 3 + 1] * 3 + k] + v[ix[t * 3 + 2] * 3 + k]) / 3;
  return c;
};

export function triNormal(m: IndexedMesh, t: number): V3 {
  const v = m.vertices, i = m.indices, a = i[t * 3] * 3, b = i[t * 3 + 1] * 3, c = i[t * 3 + 2] * 3;
  const ux = v[b] - v[a], uy = v[b + 1] - v[a + 1], uz = v[b + 2] - v[a + 2], wx = v[c] - v[a], wy = v[c + 1] - v[a + 1], wz = v[c + 2] - v[a + 2];
  const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx, l = Math.hypot(nx, ny, nz) || 1;
  return [nx / l, ny / l, nz / l];
}

/** Triangle nearest to a point (by centroid). */
export function nearestTri(cent: Float32Array, p: V3): number {
  let best = 0, bd = Infinity;
  for (let t = 0; t < cent.length / 3; t++) {
    const d = (cent[t * 3] - p[0]) ** 2 + (cent[t * 3 + 1] - p[1]) ** 2 + (cent[t * 3 + 2] - p[2]) ** 2;
    if (d < bd) { bd = d; best = t; }
  }
  return best;
}

/** Fraction along the spine (0 head → 1 tail) of each point, by nearest spine vertex. */
function spineParam(spine: V3[], p: V3): number {
  let best = 0, bd = Infinity;
  for (let i = 0; i < spine.length; i++) { const d = (spine[i][0] - p[0]) ** 2 + (spine[i][1] - p[1]) ** 2 + (spine[i][2] - p[2]) ** 2; if (d < bd) { bd = d; best = i; } }
  return best / Math.max(1, spine.length - 1);
}

export function applyPaint(ops: PaintOp[], ctx: PaintContext, base = 1): Uint8Array {
  const { mesh, triPiece } = ctx, T = mesh.indices.length / 3;
  const out = new Uint8Array(T).fill(base);
  const cent = centroids(mesh);
  const nPieces = triPiece.length ? Math.max(...triPiece) + 1 : 0;
  // pieces: triangles per piece and piece centre
  const perPiece: number[][] = Array.from({ length: nPieces }, () => []);
  for (let t = 0; t < T; t++) perPiece[triPiece[t]].push(t);
  const pieceCentre = perPiece.map((ts) => { const c: V3 = [0, 0, 0]; for (const t of ts) for (let k = 0; k < 3; k++) c[k] += cent[t * 3 + k] / ts.length; return c; });
  const orderOfPiece = () => {
    const key = pieceCentre.map((c, i) => ({ i, k: ctx.spine ? spineParam(ctx.spine, c) : c[0] }));
    key.sort((a, b) => a.k - b.k);
    const rank = new Int32Array(nPieces);
    key.forEach((x, r) => { rank[x.i] = r; });
    return { rank, count: nPieces };
  };
  const slotAt = (slots: number[], u: number, steps: boolean) => {
    if (slots.length === 1) return slots[0];
    const x = Math.min(0.9999, Math.max(0, u)) * (slots.length - (steps ? 0 : 1));
    return slots[Math.min(slots.length - 1, Math.floor(x + (steps ? 0 : 0.5)))];
  };
  for (const op of ops) {
    switch (op.kind) {
      case 'fill': out.fill(op.slot); break;
      case 'piece': { const t = nearestTri(cent, op.at); for (const k of perPiece[triPiece[t]]) out[k] = op.slot; break; }
      case 'stroke': {
        const r2 = op.r * op.r;
        for (let t = 0; t < T; t++) {
          const x = cent[t * 3], y = cent[t * 3 + 1], z = cent[t * 3 + 2];
          for (const p of op.pts) if ((x - p[0]) ** 2 + (y - p[1]) ** 2 + (z - p[2]) ** 2 <= r2) { out[t] = op.slot; break; }
        }
        break;
      }
      case 'bucket': { const seed = nearestTri(cent, op.at); for (const t of fillTriangles(mesh, seed, op.angle)) out[t] = op.slot; break; }
      case 'gradient': {
        const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < cent.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], cent[i + k]); hi[k] = Math.max(hi[k], cent[i + k]); }
        for (let p = 0; p < nPieces; p++) for (const t of perPiece[p]) {
          const c: V3 = [cent[t * 3], cent[t * 3 + 1], cent[t * 3 + 2]];
          // whole pieces share a colour when stepping through a spine gradient; plain axis gradients follow the triangle
          const q = op.axis === 'spine' && ctx.spine ? pieceCentre[p] : c;
          const u = op.axis === 'spine' && ctx.spine ? spineParam(ctx.spine, q) : (q[op.axis === 'x' ? 0 : op.axis === 'y' ? 1 : 2] - lo[op.axis === 'x' ? 0 : op.axis === 'y' ? 1 : 2]) / Math.max(1e-6, hi[op.axis === 'x' ? 0 : op.axis === 'y' ? 1 : 2] - lo[op.axis === 'x' ? 0 : op.axis === 'y' ? 1 : 2]);
          out[t] = slotAt(op.slots, u, op.steps);
        }
        break;
      }
      case 'alternate': {
        const { rank } = orderOfPiece();
        for (let t = 0; t < T; t++) out[t] = op.slots[rank[triPiece[t]] % op.slots.length];
        break;
      }
      case 'zones': {
        for (let t = 0; t < T; t++) out[t] = triNormal(mesh, t)[2] > op.threshold ? op.back : op.sides;
        break;
      }
      case 'features': {
        for (const mk of ctx.marks ?? []) {
          const slot = op.slots[mk.kind]; if (!slot) continue;
          const r2 = (mk.r * 1.25) ** 2;
          for (let t = 0; t < T; t++) if ((cent[t * 3] - mk.at[0]) ** 2 + (cent[t * 3 + 1] - mk.at[1]) ** 2 + (cent[t * 3 + 2] - mk.at[2]) ** 2 <= r2) out[t] = slot;
        }
        break;
      }
    }
  }
  return out;
}

export const PALETTE_DEFAULT = ['#46c28f', '#f5f1e6', '#1c1f26', '#e8574d', '#f2b84b', '#4c8bf5', '#9b6ad6', '#e58bb4'];

/** Quick schemes for the Paint tab: operations that give a whole colour layout in one click. */
export const SCHEMES: { id: string; name: string; ops: (n: number) => PaintOp[] }[] = [
  { id: 'single', name: 'One colour', ops: () => [{ kind: 'fill', slot: 1 }] },
  { id: 'two-tone', name: 'Back + sides', ops: () => [{ kind: 'zones', back: 1, sides: 2, threshold: 0.45 }] },
  { id: 'two-tone-eyes', name: 'Back + sides + eyes', ops: () => [{ kind: 'zones', back: 1, sides: 2, threshold: 0.45 }, { kind: 'features', slots: { eye: 3, horn: 3, beak: 4, foot: 1, wing: 4 } }] },
  { id: 'alternate2', name: 'Alternate pieces (2)', ops: () => [{ kind: 'alternate', slots: [1, 2] }] },
  { id: 'alternate3', name: 'Alternate pieces (3)', ops: () => [{ kind: 'alternate', slots: [1, 2, 3] }] },
  { id: 'rainbow', name: 'Rainbow along the body', ops: (n) => [{ kind: 'gradient', slots: Array.from({ length: Math.max(2, Math.min(n, 8)) }, (_, i) => i + 1), axis: 'spine', steps: false }] },
  { id: 'fade', name: 'Fade head → tail', ops: () => [{ kind: 'gradient', slots: [1, 2], axis: 'spine', steps: true }] },
  { id: 'stripes', name: 'Stripes every 2nd piece + eyes', ops: () => [{ kind: 'alternate', slots: [1, 1, 2] }, { kind: 'features', slots: { eye: 3, horn: 3, beak: 4 } }] },
];
