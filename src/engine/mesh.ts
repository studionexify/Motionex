// Mesh utilities shared by the UI (import, transforms) and the engine (slicing).

export interface IndexedMesh {
  vertices: Float32Array;
  indices: Uint32Array;
  /** Source face id per triangle (an OBJ quad or polygon, a CAD face). Triangles sharing an id came from one face. */
  faceGroups?: Uint32Array;
  /** 'cad': the groups are B-rep faces of a STEP / IGES import, so a group boundary is a true model edge even where it is smooth-ish. */
  groupKind?: 'cad';
}

/** Weld a triangle soup (flat xyz per corner) into an indexed mesh. `groups` (one id per soup triangle) is carried to `faceGroups`. */
export function weld(soup: Float32Array, tolerance = 1e-5, groups?: ArrayLike<number>): IndexedMesh {
  const inv = 1 / tolerance;
  const map = new Map<string, number>();
  const verts: number[] = [];
  const triCount = Math.floor(soup.length / 9);
  const idx = new Uint32Array(triCount * 3);
  const grp = groups ? new Uint32Array(triCount) : undefined;
  let kept = 0;
  for (let t = 0; t < triCount; t++) {
    const tri: number[] = [];
    for (let c = 0; c < 3; c++) {
      const o = t * 9 + c * 3;
      const x = soup[o], y = soup[o + 1], z = soup[o + 2];
      const key = `${Math.round(x * inv)},${Math.round(y * inv)},${Math.round(z * inv)}`;
      let i = map.get(key);
      if (i === undefined) { i = verts.length / 3; verts.push(x, y, z); map.set(key, i); }
      tri.push(i);
    }
    // drop degenerate (collapsed) triangles
    if (tri[0] === tri[1] || tri[1] === tri[2] || tri[0] === tri[2]) continue;
    idx[kept * 3] = tri[0]; idx[kept * 3 + 1] = tri[1]; idx[kept * 3 + 2] = tri[2];
    if (grp) grp[kept] = groups![t];
    kept++;
  }
  const out: IndexedMesh = { vertices: new Float32Array(verts), indices: idx.slice(0, kept * 3) };
  if (grp) out.faceGroups = grp.slice(0, kept);
  return out;
}

export function meshBounds(v: Float32Array) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < v.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const a = v[i + k];
      if (a < min[k]) min[k] = a;
      if (a > max[k]) max[k] = a;
    }
  }
  return { min, max };
}

/** Apply a column-major 4x4 matrix to positions. */
export function transformVertices(v: Float32Array, m: ArrayLike<number>): Float32Array {
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i += 3) {
    const x = v[i], y = v[i + 1], z = v[i + 2];
    out[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
    out[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    out[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  }
  return out;
}

/** Signed volume (mm³) of a closed mesh. */
export function meshVolume(m: IndexedMesh): number {
  const v = m.vertices, ix = m.indices;
  let vol = 0;
  for (let t = 0; t < ix.length; t += 3) {
    const a = ix[t] * 3, b = ix[t + 1] * 3, c = ix[t + 2] * 3;
    vol += (v[a] * (v[b + 1] * v[c + 2] - v[b + 2] * v[c + 1])
      - v[a + 1] * (v[b] * v[c + 2] - v[b + 2] * v[c])
      + v[a + 2] * (v[b] * v[c + 1] - v[b + 1] * v[c])) / 6;
  }
  return vol;
}

/** Count edges not shared by exactly two triangles (0 for a watertight mesh). */
export function openEdgeCount(m: IndexedMesh): number {
  const counts = new Map<number, number>();
  const n = m.vertices.length / 3;
  const ix = m.indices;
  for (let t = 0; t < ix.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = ix[t + e], b = ix[t + ((e + 1) % 3)];
      const key = a < b ? a * n + b : b * n + a;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  let open = 0;
  counts.forEach((c) => { if (c !== 2) open++; });
  return open;
}

/**
 * Repair T-junctions (a vertex lying on another triangle's edge), as produced by CSG.
 * Triangles whose boundary edge passes through such a vertex are split there, which makes the
 * mesh watertight again so slicing can chain contours by shared edges.
 */
export function repairTJunctions(m: IndexedMesh, tol = 2e-5): IndexedMesh {
  const v = m.vertices;
  let tris = Array.from(m.indices);
  for (let iter = 0; iter < 8; iter++) {
    const dir = new Map<string, number>(); // "a_b" -> triangle index
    for (let t = 0; t < tris.length; t += 3) for (let k = 0; k < 3; k++) dir.set(`${tris[t + k]}_${tris[t + ((k + 1) % 3)]}`, t);
    const boundary: [number, number, number][] = []; // a, b, tri
    for (const [key, t] of dir) {
      const [a, b] = key.split('_').map(Number);
      if (!dir.has(`${b}_${a}`)) boundary.push([a, b, t]);
    }
    if (!boundary.length) break;
    // candidate vertices: endpoints of boundary edges, hashed on a grid
    const cand = new Set<number>();
    for (const [a, b] of boundary) { cand.add(a); cand.add(b); }
    const cell = 1;
    const grid = new Map<string, number[]>();
    for (const i of cand) {
      const k = `${Math.floor(v[i * 3] / cell)},${Math.floor(v[i * 3 + 1] / cell)},${Math.floor(v[i * 3 + 2] / cell)}`;
      (grid.get(k) ?? grid.set(k, []).get(k)!).push(i);
    }
    const splits = new Map<number, Map<string, number[]>>(); // tri -> edge -> vertices along it
    for (const [a, b, t] of boundary) {
      const ax = v[a * 3], ay = v[a * 3 + 1], az = v[a * 3 + 2];
      const dx = v[b * 3] - ax, dy = v[b * 3 + 1] - ay, dz = v[b * 3 + 2] - az;
      const L2 = dx * dx + dy * dy + dz * dz;
      if (L2 < tol * tol) continue;
      const on: { i: number; s: number }[] = [];
      const x0 = Math.floor(Math.min(ax, ax + dx) / cell), x1 = Math.floor(Math.max(ax, ax + dx) / cell);
      const y0 = Math.floor(Math.min(ay, ay + dy) / cell), y1 = Math.floor(Math.max(ay, ay + dy) / cell);
      const z0 = Math.floor(Math.min(az, az + dz) / cell), z1 = Math.floor(Math.max(az, az + dz) / cell);
      if ((x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1) > 4000) continue;
      for (let gx = x0; gx <= x1; gx++) for (let gy = y0; gy <= y1; gy++) for (let gz = z0; gz <= z1; gz++) {
        for (const i of grid.get(`${gx},${gy},${gz}`) ?? []) {
          if (i === a || i === b) continue;
          const px = v[i * 3] - ax, py = v[i * 3 + 1] - ay, pz = v[i * 3 + 2] - az;
          const s = (px * dx + py * dy + pz * dz) / L2;
          if (s <= 1e-6 || s >= 1 - 1e-6) continue;
          const ex = px - s * dx, ey = py - s * dy, ez = pz - s * dz;
          if (ex * ex + ey * ey + ez * ez < tol * tol) on.push({ i, s });
        }
      }
      if (!on.length) continue;
      on.sort((p, q) => p.s - q.s);
      (splits.get(t) ?? splits.set(t, new Map()).get(t)!).set(`${a}_${b}`, on.map((o) => o.i));
    }
    if (!splits.size) break;
    const out: number[] = [];
    for (let t = 0; t < tris.length; t += 3) {
      const sp = splits.get(t);
      if (!sp) { out.push(tris[t], tris[t + 1], tris[t + 2]); continue; }
      // polygon of the triangle with the extra points inserted, then fan from a corner opposite a split edge
      const poly: number[] = [];
      for (let k = 0; k < 3; k++) {
        const a = tris[t + k], b = tris[t + ((k + 1) % 3)];
        poly.push(a, ...(sp.get(`${a}_${b}`) ?? []));
      }
      // fan from the corner vertex with the most splits on its opposite edge
      let start = 0;
      for (let k = 0; k < 3; k++) {
        const a = tris[t + ((k + 1) % 3)], b = tris[t + ((k + 2) % 3)];
        if (sp.has(`${a}_${b}`)) { start = poly.indexOf(tris[t + k]); break; }
      }
      const n = poly.length;
      for (let k = 1; k < n - 1; k++) out.push(poly[start], poly[(start + k) % n], poly[(start + k + 1) % n]);
    }
    tris = out;
  }
  return { vertices: v, indices: new Uint32Array(tris) };
}
