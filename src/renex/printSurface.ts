// Renex print surface: turns a part's mesh into what actually comes off an FDM printer. Layer lines,
// seam, top-skin infill lines, bed-side finish, elephant's foot and supports (attached or removed with
// their scars) are all derived from the real print settings — layer height, first layer, line width and
// seam position — and the part's print orientation, so the render shows exactly what will print.
import * as THREE from 'three';
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { FINISHES, printedMaterials, type FinishKind, type SurfaceMaps } from './materials';

export type SupportMode = 'off' | 'attached' | 'removed';
export type SeamMode = 'aligned' | 'back' | 'nearest' | 'random';

export interface PrintSettings {
  layerHeight: number;
  firstLayerHeight: number;
  lineWidth: number;
  seam: SeamMode;
  supports: SupportMode;
  /** Overhang angle (° from horizontal) below which support is generated. */
  supportAngle: number;
  /** Textured PEI (rough bed side) or smooth plate (glossy bed side). */
  texturedBed: boolean;
}

export const defaultPrintSettings = (): PrintSettings => ({ layerHeight: 0.2, firstLayerHeight: 0.2, lineWidth: 0.42, seam: 'aligned', supports: 'off', supportAngle: 30, texturedBed: true });

/** A printed part: geometry in its print orientation (bed at z = 0) and where it sits in the scene. */
export interface PrintedPartInput {
  name: string;
  /** Triangle soup, 9 floats per triangle, print frame (mm). */
  soup: ArrayLike<number>;
  /** Print frame → scene (Z up, mm). */
  toScene: THREE.Matrix4;
  hex: string;
  finish: FinishKind;
  secondHex?: string;
  /** Per-triangle filament colours (multi-material paint): index into `paintHex`, 0 = part colour. */
  paint?: Uint8Array;
  paintHex?: string[];
}

const TILE_LAYERS = 64;
const PX_PER_LAYER = 8;
const WALL_W = 2048;

/** Deterministic small hash noise. */
function hash(n: number) { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); }
function smoothNoise(x: number, seed: number) {
  const i = Math.floor(x), t = x - i, u = t * t * (3 - 2 * t);
  return hash(i + seed * 101) * (1 - u) + hash(i + 1 + seed * 101) * u;
}

/** Height field → tangent-space normal map. `dx`, `dy` are the pixel sizes in mm. */
export function heightToNormal(h: Float32Array, w: number, hh: number, dx: number, dy: number, wrapX = true): Uint8Array {
  const out = new Uint8Array(w * hh * 4);
  for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) {
    const xl = wrapX ? (x - 1 + w) % w : Math.max(0, x - 1), xr = wrapX ? (x + 1) % w : Math.min(w - 1, x + 1);
    const yd = (y - 1 + hh) % hh, yu = (y + 1) % hh;
    const sx = (h[y * w + xr] - h[y * w + xl]) / (2 * dx);
    const sy = (h[yu * w + x] - h[yd * w + x]) / (2 * dy);
    const n = new THREE.Vector3(-sx, -sy, 1).normalize();
    const i = (y * w + x) * 4;
    out[i] = (n.x * 0.5 + 0.5) * 255; out[i + 1] = (n.y * 0.5 + 0.5) * 255; out[i + 2] = (n.z * 0.5 + 0.5) * 255; out[i + 3] = 255;
  }
  return out;
}

function dataTex(data: Uint8Array, w: number, h: number, srgb = false) {
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

/**
 * Side-wall texture covering one full turn around the part (u) and TILE_LAYERS layers (v). Each layer is a
 * rounded bead (stadium cross-section of a squashed extrusion), with slow width wobble along the perimeter
 * and the seam: a row of zits/gaps at one angle (aligned/back/nearest) or scattered (random).
 */
export function wallMaps(s: PrintSettings, perimeterMm: number, seamU: number, contrast: number) {
  const w = WALL_W, h = TILE_LAYERS * PX_PER_LAYER;
  const height = new Float32Array(w * h), rough = new Uint8Array(w * h * 4);
  const lh = s.layerHeight, r = lh / 2;
  const dx = perimeterMm / w, dy = lh / PX_PER_LAYER;
  for (let L = 0; L < TILE_LAYERS; L++) {
    const seed = L * 7.13;
    const seamAt = s.seam === 'random' ? hash(seed) : seamU + (s.seam === 'nearest' ? (hash(seed) - 0.5) * 0.01 : 0);
    for (let py = 0; py < PX_PER_LAYER; py++) {
      const t = (py + 0.5) / PX_PER_LAYER;
      const bead = Math.sqrt(Math.max(0, 1 - (2 * t - 1) ** 2)); // 0 at the groove, 1 at the bead crest
      for (let x = 0; x < w; x++) {
        const u = x / w;
        // extrusion width wobble (~±10 µm) with a few-mm period, different per layer
        const wob = (smoothNoise(u * perimeterMm / 6, seed) - 0.5) * 0.004;
        // each layer squishes a little differently (flow / temperature drift): bead depth and gloss vary per layer
        const k = 0.7 + 0.6 * hash(seed + 0.37);
        let z = r * bead * 0.5 * k + wob * bead;
        let ru = 0.45 + (1 - bead) * 0.3 + (hash(seed + 0.91) - 0.5) * 0.12;
        // seam: a small blob where the loop starts and a dip where it ends
        let du = Math.abs(u - seamAt); du = Math.min(du, 1 - du);
        const sw = 0.6 / perimeterMm; // ≈ 0.6 mm wide
        if (du < sw * 2) { const k = 1 - du / (sw * 2); z += Math.sin(k * Math.PI) * lh * 0.18 * (u < seamAt ? 1 : -0.6); ru += 0.15 * k; }
        height[(L * PX_PER_LAYER + py) * w + x] = z * contrast;
        const i = ((L * PX_PER_LAYER + py) * w + x) * 4;
        const v = Math.max(0, Math.min(255, ru * 255));
        rough[i] = v; rough[i + 1] = v; rough[i + 2] = v; rough[i + 3] = 255;
      }
    }
  }
  return { normal: dataTex(heightToNormal(height, w, h, dx, dy), w, h), rough: dataTex(rough, w, h) };
}

/** Top skin: parallel extrusion lines at 45°, one line width apart, nearly flat (ironing-like crest). */
export function topMaps(s: PrintSettings, tileMm = 20) {
  const n = 512, height = new Float32Array(n * n), rough = new Uint8Array(n * n * 4);
  const lines = Math.max(1, Math.round(tileMm / s.lineWidth));
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const t = ((x / n) * lines) % 1;
    const bead = Math.sqrt(Math.max(0, 1 - (2 * t - 1) ** 2));
    const k = Math.floor((x / n) * lines);
    height[y * n + x] = bead * s.layerHeight * 0.12 + (smoothNoise((y / n) * tileMm / 2, k) - 0.5) * 0.006;
    const v = (0.45 + (1 - bead) * 0.3) * 255, i = (y * n + x) * 4;
    rough[i] = rough[i + 1] = rough[i + 2] = v; rough[i + 3] = 255;
  }
  const d = tileMm / n;
  return { normal: dataTex(heightToNormal(height, n, n, d, d), n, n), rough: dataTex(rough, n, n) };
}

/** Bed side: textured PEI (fine grain) or smooth plate (mirror-like with faint first-layer lines). */
export function bottomMap(s: PrintSettings, tileMm = 20) {
  const n = 256, height = new Float32Array(n * n);
  const lines = Math.round(tileMm / s.lineWidth);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const grain = s.texturedBed ? (hash(x * 13.1 + y * 71.7) - 0.5) * 0.02 + (smoothNoise(x / 6 + y / 9, 3) - 0.5) * 0.02 : 0;
    const t = ((x + y) / n * lines) % 1;
    height[y * n + x] = grain + (s.texturedBed ? 0 : Math.sqrt(Math.max(0, 1 - (2 * t - 1) ** 2)) * 0.004);
  }
  return dataTex(heightToNormal(height, n, n, tileMm / n, tileMm / n), n, n);
}

/** Particle fills (stone grit, wood fibre, marble veins, glitter, carbon) as an albedo multiplier. */
export function fillMap(kind: (typeof FINISHES)[FinishKind]['fill']) {
  if (kind === 'none') return undefined;
  const n = 512, data = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    let v = 1, g = 1, b = 1;
    const r = hash(x * 12.9898 + y * 78.233);
    if (kind === 'grit') { if (r > 0.93) v = 0.35 + r * 0.3; else if (r < 0.05) v = 1.2; }
    if (kind === 'carbon') { v = 0.88 + (smoothNoise(x / 1.5 + y * 3.1, 2) - 0.5) * 0.2; }
    if (kind === 'wood') { const s = Math.sin((y / n) * 80 + smoothNoise(x / 30, 1) * 6) * 0.5 + 0.5; v = 0.82 + s * 0.22; g = v * 0.97; b = v * 0.92; }
    if (kind === 'marble') { const s = Math.abs(Math.sin((x + y) / 40 + smoothNoise(x / 50 + y / 70, 5) * 8)); v = s > 0.97 ? 0.45 : 1; g = v; b = v; }
    if (kind === 'glitter' || kind === 'metal') { if (r > (kind === 'glitter' ? 0.985 : 0.95)) v = 1.6; }
    const i = (y * n + x) * 4;
    // 1.0 maps to 200 so bright specks (glitter, flakes) can exceed the base colour; the material colour is scaled up to match
    data[i] = Math.min(255, v * 200); data[i + 1] = Math.min(255, g * 200); data[i + 2] = Math.min(255, b * 200); data[i + 3] = 255;
  }
  return dataTex(data, n, n, false);
}

const mapCache = new Map<string, unknown>();
/**
 * Memoised map generation (LRU-bounded). Disposing a cached texture only frees its GPU copy; three.js
 * re-uploads it on next use, so scenes may dispose freely.
 */
function cached<T>(key: string, make: () => T): T {
  if (mapCache.has(key)) { const v = mapCache.get(key) as T; mapCache.delete(key); mapCache.set(key, v); return v; }
  const v = make();
  mapCache.set(key, v);
  if (mapCache.size > 48) mapCache.delete(mapCache.keys().next().value as string);
  return v;
}

/** Groups: 0 walls · 1 top skin · 2 bed side · 3 support scars. */
export const GROUP = { wall: 0, top: 1, bottom: 2, scar: 3 } as const;

export interface PreparedPart { meshes: THREE.Mesh[]; triangles: number }

/**
 * Prepare one printed part for the path tracer. Geometry stays in the print frame while UVs are assigned
 * (layer lines must follow the printer's Z), then the whole mesh is moved into the scene.
 */
export function preparePrinted(p: PrintedPartInput, s: PrintSettings, lineStrength = 1): PreparedPart {
  const pos = new Float32Array(p.soup);
  const tris = pos.length / 9;
  if (!tris) return { meshes: [], triangles: 0 };
  // centroid + mean radius in XY for the wall mapping
  let cx = 0, cy = 0, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < pos.length; i += 3) { cx += pos[i]; cy += pos[i + 1]; minZ = Math.min(minZ, pos[i + 2]); maxZ = Math.max(maxZ, pos[i + 2]); }
  cx /= pos.length / 3; cy /= pos.length / 3;
  for (let i = 2; i < pos.length; i += 3) pos[i] -= minZ;
  maxZ -= minZ;
  let rSum = 0;
  for (let i = 0; i < pos.length; i += 3) rSum += Math.hypot(pos[i] - cx, pos[i + 1] - cy);
  const meanR = Math.max(1, rSum / (pos.length / 3));
  // elephant's foot: the squished first layer bulges ~0.1–0.15 mm outward
  const foot = s.firstLayerHeight * 0.6;
  for (let i = 0; i < pos.length; i += 3) {
    if (pos[i + 2] > s.firstLayerHeight) continue;
    const dx = pos[i] - cx, dy = pos[i + 1] - cy, d = Math.hypot(dx, dy);
    if (d < 1e-6) continue;
    const k = foot * (1 - pos[i + 2] / s.firstLayerHeight);
    pos[i] += (dx / d) * k * 0.25; pos[i + 1] += (dy / d) * k * 0.25;
  }

  let geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo = toCreasedNormals(geo, (35 * Math.PI) / 180);
  const P = geo.getAttribute('position') as THREE.BufferAttribute;
  const uv = new Float32Array(P.count * 2);
  const groupOf = new Uint8Array(tris);
  const overhang = Math.sin((s.supportAngle * Math.PI) / 180);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
  const tileV = s.layerHeight * TILE_LAYERS;
  const q = Math.SQRT1_2;
  const supportPoints: [number, number, number][] = [];
  for (let t = 0; t < tris; t++) {
    a.fromBufferAttribute(P, t * 3); b.fromBufferAttribute(P, t * 3 + 1); c.fromBufferAttribute(P, t * 3 + 2);
    n.subVectors(c, b).cross(new THREE.Vector3().subVectors(a, b)).normalize();
    const zMax = Math.max(a.z, b.z, c.z);
    let g: number = GROUP.wall;
    if (n.z > 0.72) g = GROUP.top;
    else if (n.z < -0.72 && zMax <= s.firstLayerHeight + 0.01) g = GROUP.bottom;
    else if (n.z < -overhang - 0.25 && Math.min(a.z, b.z, c.z) > s.firstLayerHeight * 2) {
      if (s.supports !== 'off') {
        if (s.supports === 'removed') g = GROUP.scar;
        // sample the face on a 3 mm grid for support columns
        const area = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).length() / 2;
        const k = Math.max(1, Math.round(area / 9));
        for (let j = 0; j < k; j++) {
          let u1 = hash(t * 3.1 + j), u2 = hash(t * 5.7 + j * 1.3);
          if (u1 + u2 > 1) { u1 = 1 - u1; u2 = 1 - u2; }
          supportPoints.push([a.x + (b.x - a.x) * u1 + (c.x - a.x) * u2, a.y + (b.y - a.y) * u1 + (c.y - a.y) * u2, a.z + (b.z - a.z) * u1 + (c.z - a.z) * u2]);
        }
      }
    }
    groupOf[t] = g;
    // per-triangle UVs (vertices are not shared across groups after creasing)
    const vs = [a, b, c];
    if (g === GROUP.wall || g === GROUP.scar) {
      const us = vs.map((v) => (Math.atan2(v.y - cy, v.x - cx) / (2 * Math.PI) + 1) % 1);
      const hi = Math.max(...us), lo = Math.min(...us);
      if (hi - lo > 0.5) for (let k = 0; k < 3; k++) if (us[k] < 0.5) us[k] += 1;
      for (let k = 0; k < 3; k++) { uv[(t * 3 + k) * 2] = us[k]; uv[(t * 3 + k) * 2 + 1] = vs[k].z / tileV; }
    } else {
      for (let k = 0; k < 3; k++) { const v = vs[k]; uv[(t * 3 + k) * 2] = (v.x * q + v.y * q) / 20; uv[(t * 3 + k) * 2 + 1] = (-v.x * q + v.y * q) / 20; }
    }
  }
  // reorder triangles by group so each group is one draw range
  const order = Array.from({ length: tris }, (_, t) => t).sort((x, y) => groupOf[x] - groupOf[y]);
  const N = geo.getAttribute('normal') as THREE.BufferAttribute;
  const pos2 = new Float32Array(tris * 9), nor2 = new Float32Array(tris * 9), uv2 = new Float32Array(tris * 6), col = p.paint ? new Float32Array(tris * 9) : null;
  const paintCols = (p.paintHex ?? []).map((h) => new THREE.Color(h));
  const baseCol = new THREE.Color(1, 1, 1);
  order.forEach((t, k) => {
    pos2.set((P.array as Float32Array).subarray(t * 9, t * 9 + 9), k * 9);
    nor2.set((N.array as Float32Array).subarray(t * 9, t * 9 + 9), k * 9);
    uv2.set(uv.subarray(t * 6, t * 6 + 6), k * 6);
    if (col) {
      const pi = p.paint![t];
      // vertex colour multiplies the material colour, so paint = paint / base
      const target = pi > 0 && paintCols[pi - 1] ? paintCols[pi - 1] : null;
      const base = new THREE.Color(p.hex);
      const c3 = target ? new THREE.Color(target.r / Math.max(0.02, base.r), target.g / Math.max(0.02, base.g), target.b / Math.max(0.02, base.b)) : baseCol;
      for (let v = 0; v < 3; v++) col.set([c3.r, c3.g, c3.b], k * 9 + v * 3);
    }
  });
  geo.dispose();
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos2, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor2, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv2, 2));
  if (col) out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  let start = 0;
  for (let g = 0; g <= 3; g++) {
    let cnt = 0;
    while (start + cnt < tris && groupOf[order[start + cnt]] === g) cnt++;
    if (cnt) out.addGroup(start * 3, cnt * 3, g);
    start += cnt;
  }

  const perimeter = 2 * Math.PI * meanR;
  const seamU = s.seam === 'back' ? 0.25 : 0.27; // back of the part (+Y), aligned seams tuck just off it
  const spec = FINISHES[p.finish];
  // procedural maps cost 50–300 ms of main-thread time each: share them between parts and renders
  const per = Math.max(20, Math.round(perimeter / 20) * 20);
  const key = `${s.layerHeight}|${s.lineWidth}|${s.seam}|${s.texturedBed}`;
  const wm = cached(`wall|${key}|${per}|${seamU}`, () => wallMaps(s, per, seamU, 1));
  const tm = cached(`top|${key}`, () => topMaps(s));
  const maps: SurfaceMaps = { wall: wm.normal, wallRough: wm.rough, top: tm.normal, topRough: tm.rough, bottom: cached(`bottom|${key}`, () => bottomMap(s)), fill: spec.fill === 'none' ? undefined : cached(`fill|${spec.fill}`, () => fillMap(spec.fill)) };
  const [wall, top, bottom] = printedMaterials(p.hex, p.finish, maps, { lineStrength, secondHex: p.secondHex });
  const scar = wall.clone();
  scar.roughness = Math.min(1, wall.roughness + 0.35);
  scar.normalScale = new THREE.Vector2(lineStrength * 2.2, lineStrength * 2.2);
  const mats = [wall, top, bottom, scar];
  if (col) for (const m of mats) m.vertexColors = true;
  const mesh = new THREE.Mesh(out, mats);
  mesh.name = p.name;
  mesh.applyMatrix4(new THREE.Matrix4().makeTranslation(0, 0, minZ).premultiply(p.toScene));
  const meshes: THREE.Mesh[] = [mesh];
  if (s.supports === 'attached' && supportPoints.length) {
    const sup = supportColumns(supportPoints, pos, s);
    if (sup) {
      const m = new THREE.Mesh(sup, new THREE.MeshPhysicalMaterial({ color: p.hex, roughness: Math.min(1, spec.roughness + 0.2), ior: spec.ior }));
      m.name = `${p.name} supports`;
      m.applyMatrix4(new THREE.Matrix4().makeTranslation(0, 0, minZ).premultiply(p.toScene));
      meshes.push(m);
    }
  }
  return { meshes, triangles: tris };
}

/**
 * Grid support under overhang samples: square 0.8 mm columns from the bed (or the part surface below) up to
 * a Z gap of one layer under the overhang, with a wider interface pad on top — like a slicer's grid support.
 */
function supportColumns(pts: [number, number, number][], soup: Float32Array, s: PrintSettings): THREE.BufferGeometry | null {
  // snap to a 2.5 mm grid, keep the highest overhang per cell
  const cell = 2.5, cells = new Map<string, [number, number, number]>();
  for (const p of pts) {
    const k = `${Math.round(p[0] / cell)},${Math.round(p[1] / cell)}`;
    const cur = cells.get(k);
    if (!cur || p[2] < cur[2]) cells.set(k, [Math.round(p[0] / cell) * cell, Math.round(p[1] / cell) * cell, p[2]]);
  }
  // highest upward-facing surface below each cell (bucketed triangles)
  const ups: number[] = [];
  for (let t = 0; t < soup.length / 9; t++) {
    const o = t * 9;
    const nz = (soup[o + 3] - soup[o]) * (soup[o + 7] - soup[o + 1]) - (soup[o + 4] - soup[o + 1]) * (soup[o + 6] - soup[o]);
    if (nz > 0) ups.push(t);
  }
  const floorAt = (x: number, y: number, below: number) => {
    let best = 0;
    for (const t of ups) {
      const o = t * 9;
      const x1 = soup[o], y1 = soup[o + 1], x2 = soup[o + 3], y2 = soup[o + 4], x3 = soup[o + 6], y3 = soup[o + 7];
      const d = (y2 - y3) * (x1 - x3) + (x3 - x2) * (y1 - y3);
      if (Math.abs(d) < 1e-9) continue;
      const l1 = ((y2 - y3) * (x - x3) + (x3 - x2) * (y - y3)) / d, l2 = ((y3 - y1) * (x - x3) + (x1 - x3) * (y - y3)) / d, l3 = 1 - l1 - l2;
      if (l1 < 0 || l2 < 0 || l3 < 0) continue;
      const z = l1 * soup[o + 2] + l2 * soup[o + 5] + l3 * soup[o + 8];
      if (z < below - 0.5 && z > best) best = z;
    }
    return best;
  };
  const geos: THREE.BufferGeometry[] = [];
  const gap = s.layerHeight;
  for (const [x, y, z] of cells.values()) {
    const z0 = floorAt(x, y, z) + (ups.length ? gap : 0), z1 = z - gap;
    if (z1 - z0 < 0.6) continue;
    const col = new THREE.BoxGeometry(0.8, 0.8, z1 - z0 - 0.6); col.translate(x, y, z0 + (z1 - z0 - 0.6) / 2);
    const pad = new THREE.BoxGeometry(cell * 0.92, cell * 0.92, 0.6); pad.translate(x, y, z1 - 0.3);
    geos.push(col.toNonIndexed(), pad.toNonIndexed()); col.dispose(); pad.dispose();
  }
  if (!geos.length) return null;
  let total = 0; for (const g of geos) total += g.getAttribute('position').count;
  const P = new Float32Array(total * 3), N = new Float32Array(total * 3);
  let o = 0;
  for (const g of geos) { P.set(g.getAttribute('position').array as Float32Array, o * 3); N.set(g.getAttribute('normal').array as Float32Array, o * 3); o += g.getAttribute('position').count; g.dispose(); }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(P, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(N, 3));
  return out;
}
