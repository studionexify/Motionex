// Picking surfaces for plugins: grow a selection from one clicked triangle across smooth or flat
// neighbours, stopping at sharp edges. Works on welded (indexed) meshes.
import type { IndexedMesh } from './mesh';

export function triNormals(m: IndexedMesh): Float32Array {
  const v = m.vertices, ix = m.indices, n = new Float32Array(ix.length);
  for (let t = 0; t < ix.length / 3; t++) {
    const a = ix[t * 3] * 3, b = ix[t * 3 + 1] * 3, c = ix[t * 3 + 2] * 3;
    const ux = v[b] - v[a], uy = v[b + 1] - v[a + 1], uz = v[b + 2] - v[a + 2];
    const wx = v[c] - v[a], wy = v[c + 1] - v[a + 1], wz = v[c + 2] - v[a + 2];
    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    const l = Math.hypot(nx, ny, nz) || 1;
    n[t * 3] = nx / l; n[t * 3 + 1] = ny / l; n[t * 3 + 2] = nz / l;
  }
  return n;
}

/** Triangles sharing each edge, as a list of neighbour triangles per triangle. */
export function triAdjacency(m: IndexedMesh): Uint32Array[] {
  const ix = m.indices, T = ix.length / 3;
  const edges = new Map<string, number[]>();
  for (let t = 0; t < T; t++) for (let e = 0; e < 3; e++) {
    const a = ix[t * 3 + e], b = ix[t * 3 + ((e + 1) % 3)];
    const k = a < b ? `${a}_${b}` : `${b}_${a}`;
    const l = edges.get(k); if (l) l.push(t); else edges.set(k, [t]);
  }
  const adj: number[][] = Array.from({ length: T }, () => []);
  for (const ts of edges.values()) for (const a of ts) for (const b of ts) if (a !== b) adj[a].push(b);
  return adj.map((l) => Uint32Array.from(l));
}

/**
 * Grow from a triangle to every connected triangle reachable without crossing an edge sharper
 * than maxAngleDeg. Flat faces stop at their borders; smoothly curved faces (cylinder sides,
 * vase walls) are taken whole because each step between neighbours is small.
 */
export function growFaces(m: IndexedMesh, seed: number, maxAngleDeg = 15, adj = triAdjacency(m), normals = triNormals(m)): Uint32Array {
  const cos = Math.cos((maxAngleDeg * Math.PI) / 180);
  const seen = new Uint8Array(m.indices.length / 3);
  const out: number[] = [seed];
  seen[seed] = 1;
  for (let k = 0; k < out.length; k++) {
    const t = out[k];
    for (const u of adj[t]) {
      if (seen[u]) continue;
      const d = normals[t * 3] * normals[u * 3] + normals[t * 3 + 1] * normals[u * 3 + 1] + normals[t * 3 + 2] * normals[u * 3 + 2];
      if (d < cos) continue;
      seen[u] = 1;
      out.push(u);
    }
  }
  return Uint32Array.from(out.sort((a, b) => a - b));
}
