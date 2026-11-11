// Small geometry toolkit for Renex props (plants, hardware): lathe, tubes along curves, merging, and a
// deterministic random generator so a scene re-renders identically.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export type Rng = () => number;

/** Mulberry32: tiny, fast, deterministic. */
export function rng(seed: number): Rng {
  let a = (seed >>> 0) || 1;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const range = (r: Rng, a: number, b: number) => a + (b - a) * r();

/** Merge non-indexed copies of the geometries (attributes reduced to position/normal/uv/color). */
export function merge(list: THREE.BufferGeometry[], colors = false): THREE.BufferGeometry {
  const prepared = list.filter(Boolean).map((g) => {
    const x = g.index ? g.toNonIndexed() : g.clone();
    for (const k of Object.keys(x.attributes)) if (!['position', 'normal', 'uv', ...(colors ? ['color'] : [])].includes(k)) x.deleteAttribute(k);
    if (!x.getAttribute('normal')) x.computeVertexNormals();
    if (!x.getAttribute('uv')) x.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(x.getAttribute('position').count * 2), 2));
    if (colors && !x.getAttribute('color')) { const c = new Float32Array(x.getAttribute('position').count * 3).fill(1); x.setAttribute('color', new THREE.BufferAttribute(c, 3)); }
    x.clearGroups();
    return x;
  });
  if (!prepared.length) return new THREE.BufferGeometry();
  const out = mergeGeometries(prepared, false) ?? new THREE.BufferGeometry();
  for (const g of prepared) g.dispose();
  for (const g of list) g?.dispose();
  return out;
}

/** Lathe around Z from [radius, z] points. */
export function latheZ(profile: [number, number][], segments = 48): THREE.BufferGeometry {
  const g = new THREE.LatheGeometry(profile.map(([r, z]) => new THREE.Vector2(Math.max(0.001, r), z)), segments);
  g.rotateX(Math.PI / 2); // Lathe is about Y → stand it on Z
  return g;
}

/** Tube along points (Z-up world). */
export function tube(points: THREE.Vector3[], radius: number | ((t: number) => number), radial = 8, seg?: number): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3(points);
  const n = seg ?? Math.max(8, points.length * 6);
  if (typeof radius === 'number') return new THREE.TubeGeometry(curve, n, radius, radial, false);
  // tapered tube: build rings manually
  const frames = curve.computeFrenetFrames(n, false);
  const pos: number[] = [], idx: number[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, p = curve.getPointAt(t), r = radius(t);
    for (let j = 0; j <= radial; j++) {
      const a = (j / radial) * Math.PI * 2;
      const nx = frames.normals[i].clone().multiplyScalar(Math.cos(a)).add(frames.binormals[i].clone().multiplyScalar(Math.sin(a)));
      pos.push(p.x + nx.x * r, p.y + nx.y * r, p.z + nx.z * r);
    }
  }
  for (let i = 0; i < n; i++) for (let j = 0; j < radial; j++) {
    const a = i * (radial + 1) + j, b = a + radial + 1;
    idx.push(a, b, a + 1, b, b + 1, a + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Paint a whole geometry with one vertex colour. */
export function tint(g: THREE.BufferGeometry, hex: string | THREE.Color): THREE.BufferGeometry {
  const c = hex instanceof THREE.Color ? hex : new THREE.Color(hex);
  const n = g.getAttribute('position').count, a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) a.set([c.r, c.g, c.b], i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return g;
}

/** Orient a geometry built along +Z so it points along `dir`, then move it to `at`. */
export function place(g: THREE.BufferGeometry, at: THREE.Vector3, dir?: THREE.Vector3, spin = 0): THREE.BufferGeometry {
  if (spin) g.rotateZ(spin);
  if (dir) g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir.clone().normalize()));
  g.translate(at.x, at.y, at.z);
  return g;
}
