// Renex scenes: lighting environments in real photometric units (sky / room luminance in nits, sun in
// lux, softboxes as area lights in nits), photographic exposure (EV100), backdrops built at real scale,
// and camera presets with real focal lengths and apertures.
import * as THREE from 'three';
import { kelvinToRGB } from './components';
import { rng, range } from './geo';

// ---------------------------------------------------------------------------------------------------
// Environments

export type EnvId = 'studio-softbox' | 'studio-highkey' | 'studio-dark' | 'daylight-window' | 'overcast' | 'golden-hour' | 'noon-sun' | 'evening-interior' | 'night';

export interface EnvPreset {
  id: EnvId;
  name: string;
  /** Suggested exposure (EV100) for a correctly exposed product. */
  ev: number;
  /** Lamp scenes: ambient is low enough that the bulb is the key light. */
  forLamps?: boolean;
}

export const ENVIRONMENTS: EnvPreset[] = [
  { id: 'studio-softbox', name: 'Studio · two softboxes', ev: 9.5 },
  { id: 'studio-highkey', name: 'Studio · high-key white', ev: 10 },
  { id: 'studio-dark', name: 'Studio · low-key dark', ev: 8 },
  { id: 'daylight-window', name: 'Window daylight', ev: 9 },
  { id: 'overcast', name: 'Outdoor overcast', ev: 12 },
  { id: 'golden-hour', name: 'Golden hour sun', ev: 11 },
  { id: 'noon-sun', name: 'Noon sun', ev: 14.5 },
  { id: 'evening-interior', name: 'Evening interior (lamp-lit)', ev: 6.5, forLamps: true },
  { id: 'night', name: 'Night (lamp only)', ev: 3.5, forLamps: true },
];

/** Exposure multiplier for EV100 (saturation-based, as in Lagarde & de Rousiers 2014). */
export const exposureFor = (ev100: number) => 1 / (1.2 * Math.pow(2, ev100));

/**
 * Equirectangular environment (Y up, linear radiance in nits). Studio maps hold the seamless dark/white
 * room; softboxes and the sun are separate analytic lights so they are sampled directly (low noise).
 */
export function buildEnvironment(id: EnvId, rotation = 0, w = 1024, h = 512): THREE.DataTexture {
  const data = new Float32Array(w * h * 4);
  const r = rng(11);
  const warm = kelvinToRGB(3000), sky = kelvinToRGB(9000), noon = kelvinToRGB(6500), gold = kelvinToRGB(3500);
  for (let y = 0; y < h; y++) {
    const v = 1 - (y + 0.5) / h; // 1 = top
    const el = (v - 0.5) * Math.PI; // elevation
    for (let x = 0; x < w; x++) {
      const az = ((x + 0.5) / w) * Math.PI * 2 + rotation;
      let L = new THREE.Color(0, 0, 0);
      const up = Math.sin(el);
      switch (id) {
        case 'studio-softbox': L.setScalar(12 + 30 * Math.max(0, up)); break;
        case 'studio-highkey': L.setScalar(420 + 260 * Math.max(0, up)); break;
        case 'studio-dark': L.setScalar(2 + 4 * Math.max(0, up)); break;
        case 'daylight-window': {
          // a room: warm walls ~60 nits, one bright window ~4000 nits (sky), floor bounce
          L.setRGB(70, 62, 55).multiplyScalar(0.6 + 0.4 * Math.max(0, up));
          const wa = ((az % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
          if (Math.abs(wa - Math.PI * 0.3) < 0.55 && el > -0.05 && el < 0.75) {
            const frame = Math.abs(wa - Math.PI * 0.3) < 0.02 || Math.abs(el - 0.35) < 0.015;
            L = frame ? new THREE.Color(40, 38, 36) : sky.clone().multiplyScalar(3500 + 1500 * up);
          }
          break;
        }
        case 'overcast': L = up >= 0 ? noon.clone().multiplyScalar(2500 + 2500 * up) : new THREE.Color(380, 360, 330); break;
        case 'golden-hour': L = up >= 0 ? new THREE.Color().lerpColors(gold.clone().multiplyScalar(2200), sky.clone().multiplyScalar(900), Math.pow(up, 0.5)) : new THREE.Color(220, 180, 140); break;
        case 'noon-sun': L = up >= 0 ? sky.clone().multiplyScalar(4000 + 4000 * (1 - up)) : new THREE.Color(2500, 2400, 2200); break;
        // a living room in the evening with other lamps on: ~20–40 nits of warm bounce light
        case 'evening-interior': L = warm.clone().multiplyScalar(18 + 14 * Math.max(0, up)); break;
        case 'night': L.setRGB(0.05, 0.07, 0.12).multiplyScalar(1 + Math.max(0, up)); break;
      }
      // faint texture so reflections are not perfectly uniform (real rooms never are)
      const n = 1 + (r() - 0.5) * 0.02;
      const i = (y * w + x) * 4;
      data[i] = L.r * n; data[i + 1] = L.g * n; data[i + 2] = L.b * n; data[i + 3] = 1;
    }
  }
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.FloatType);
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.wrapS = THREE.RepeatWrapping; t.wrapT = THREE.ClampToEdgeWrapping;
  t.magFilter = t.minFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

/**
 * Analytic lights for an environment, in world units (Y up, world = decimetres). Softboxes: RectAreaLight
 * with luminance in nits. Sun: DirectionalLight with illuminance in lux.
 */
export function environmentLights(id: EnvId, target: THREE.Vector3, size: number, rotation = 0): THREE.Light[] {
  const out: THREE.Light[] = [];
  const box = (nits: number, w: number, h: number, az: number, el: number, dist: number, k = 5600) => {
    const l = new THREE.RectAreaLight(kelvinToRGB(k), nits, w, h);
    const a = az + rotation;
    l.position.set(target.x + Math.sin(a) * Math.cos(el) * dist, target.y + Math.sin(el) * dist, target.z + Math.cos(a) * Math.cos(el) * dist);
    l.lookAt(target);
    out.push(l);
  };
  const sun = (lux: number, az: number, el: number, k: number) => {
    const l = new THREE.DirectionalLight(kelvinToRGB(k), lux);
    const a = az + rotation;
    l.position.set(target.x + Math.sin(a) * Math.cos(el) * 100, target.y + Math.sin(el) * 100, target.z + Math.cos(a) * Math.cos(el) * 100);
    l.target.position.copy(target);
    out.push(l);
  };
  const d = Math.max(size * 3, 15); // ≥ 1.5 m from the product
  const W = Math.max(size * 1.6, 9); // ≥ 0.9 m softbox
  if (id === 'studio-softbox') { box(4500, W * 1.2, W * 0.8, -0.8, 0.55, d); box(1500, W * 0.7, W * 1.4, 1.1, 0.25, d); box(2500, W * 1.4, W * 0.3, 2.9, 0.9, d * 0.9); }
  if (id === 'studio-highkey') { box(3500, W * 1.6, W * 1.6, 0, 1.25, d); box(2000, W, W, -1, 0.35, d); }
  if (id === 'studio-dark') { box(3000, W * 0.4, W * 1.5, -1.9, 0.3, d); box(1500, W * 0.4, W * 1.5, 1.9, 0.3, d); }
  if (id === 'golden-hour') sun(25000, 0.9, 0.12, 3400);
  if (id === 'noon-sun') sun(100000, 0.6, 1.15, 5600);
  return out;
}

// ---------------------------------------------------------------------------------------------------
// Backdrops (Z up, mm, centred on the product footprint)

export type BackdropId = 'sweep' | 'oak-table' | 'walnut-table' | 'concrete' | 'marble' | 'linen' | 'terrazzo' | 'shelf' | 'windowsill' | 'living-room' | 'shadow-catcher' | 'none';

export const BACKDROPS: { id: BackdropId; name: string }[] = [
  { id: 'sweep', name: 'Seamless paper sweep' }, { id: 'oak-table', name: 'Oak tabletop' }, { id: 'walnut-table', name: 'Walnut tabletop' },
  { id: 'concrete', name: 'Polished concrete' }, { id: 'marble', name: 'Carrara marble' }, { id: 'linen', name: 'Linen cloth' },
  { id: 'terrazzo', name: 'Terrazzo' }, { id: 'shelf', name: 'Shelf against plaster wall' }, { id: 'windowsill', name: 'Windowsill' },
  { id: 'living-room', name: 'Living room floor + wall' }, { id: 'shadow-catcher', name: 'Transparent (shadow only)' }, { id: 'none', name: 'Environment only' },
];

function noise2(x: number, y: number, seed: number) {
  const h = (a: number, b: number) => { const s = Math.sin(a * 127.1 + b * 311.7 + seed * 74.7) * 43758.5453; return s - Math.floor(s); };
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  return h(xi, yi) * (1 - u) * (1 - v) + h(xi + 1, yi) * u * (1 - v) + h(xi, yi + 1) * (1 - u) * v + h(xi + 1, yi + 1) * u * v;
}
function fbm(x: number, y: number, seed: number, oct = 5) { let s = 0, a = 0.5, f = 1; for (let i = 0; i < oct; i++) { s += a * noise2(x * f, y * f, seed + i); a *= 0.5; f *= 2; } return s; }

/** Albedo + roughness textures for a surface type, generated procedurally (no assets, deterministic). */
export function surfaceTexture(kind: 'oak' | 'walnut' | 'concrete' | 'marble' | 'linen' | 'terrazzo' | 'plaster' | 'paper', n = 512): { map: THREE.DataTexture; rough: THREE.DataTexture; normal: THREE.DataTexture } {
  const col = new Uint8Array(n * n * 4), rough = new Uint8Array(n * n * 4), hgt = new Float32Array(n * n);
  const r = rng(kind.length * 17);
  const chips = kind === 'terrazzo' ? Array.from({ length: 900 }, () => ({ x: r() * n, y: r() * n, s: range(r, 3, 14), c: ['#c8b8a8', '#7a6a5a', '#e8e0d4', '#a85a3a', '#5a6a6a'][Math.floor(r() * 5)] })) : [];
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const u = x / n, v = y / n;
    let c = new THREE.Color(1, 1, 1), ro = 0.5, h = 0;
    if (kind === 'oak' || kind === 'walnut') {
      const plank = Math.floor(v * 6), pv = (v * 6) % 1;
      const ring = Math.sin((u * 3 + fbm(u * 4, plank * 3.3, 2) * 2.2 + plank * 0.37) * 60) * 0.5 + 0.5;
      const fine = fbm(u * 200, v * 8, 4) * 0.5;
      const base = kind === 'oak' ? new THREE.Color('#b08a5a') : new THREE.Color('#5a3d2b');
      const dark = kind === 'oak' ? new THREE.Color('#8a6438') : new THREE.Color('#3a2619');
      c = base.clone().lerp(dark, ring * 0.55 + fine * 0.3);
      if (pv < 0.006 || pv > 0.994) c.multiplyScalar(0.55);
      ro = 0.45 + fine * 0.25; h = ring * 0.03 + (pv < 0.006 || pv > 0.994 ? -0.3 : 0);
    } else if (kind === 'concrete') {
      const f = fbm(u * 12, v * 12, 3);
      c = new THREE.Color('#8f8c87').multiplyScalar(0.8 + f * 0.4);
      if (fbm(u * 90, v * 90, 9) > 0.78) c.multiplyScalar(0.7);
      ro = 0.35 + f * 0.3; h = f * 0.05;
    } else if (kind === 'marble') {
      const vein = Math.abs(Math.sin((u * 2 + v * 3 + fbm(u * 3, v * 3, 5) * 4) * Math.PI));
      c = new THREE.Color('#f2f0ec').lerp(new THREE.Color('#8a8c90'), Math.pow(1 - vein, 18) * 0.8 + fbm(u * 8, v * 8, 1) * 0.08);
      ro = 0.12; h = 0;
    } else if (kind === 'linen') {
      const wx = Math.sin(x * 1.3) * 0.5 + 0.5, wy = Math.sin(y * 1.3) * 0.5 + 0.5;
      c = new THREE.Color('#d9d2c4').multiplyScalar(0.9 + (wx * wy) * 0.12 + (fbm(u * 40, v * 3, 2) - 0.5) * 0.08);
      ro = 0.95; h = wx * wy * 0.1;
    } else if (kind === 'terrazzo') {
      c = new THREE.Color('#ebe6de').multiplyScalar(0.95 + fbm(u * 20, v * 20, 7) * 0.08); ro = 0.25;
    } else if (kind === 'plaster') {
      const f = fbm(u * 6, v * 6, 8);
      c = new THREE.Color('#e6dfd3').multiplyScalar(0.92 + f * 0.12); ro = 0.85; h = fbm(u * 60, v * 60, 3) * 0.06;
    } else if (kind === 'paper') {
      c = new THREE.Color(1, 1, 1).multiplyScalar(0.97 + (fbm(u * 300, v * 300, 1) - 0.5) * 0.02); ro = 0.9; h = fbm(u * 400, v * 400, 2) * 0.01;
    }
    const i = (y * n + x) * 4;
    c.convertLinearToSRGB();
    col[i] = Math.min(255, c.r * 255); col[i + 1] = Math.min(255, c.g * 255); col[i + 2] = Math.min(255, c.b * 255); col[i + 3] = 255;
    rough[i] = rough[i + 1] = rough[i + 2] = Math.min(255, ro * 255); rough[i + 3] = 255;
    hgt[y * n + x] = h;
  }
  for (const ch of chips) {
    const cc = new THREE.Color(ch.c);
    for (let dy = -ch.s; dy <= ch.s; dy++) for (let dx = -ch.s; dx <= ch.s; dx++) {
      if (dx * dx * 1.4 + dy * dy > ch.s * ch.s) continue;
      const x = Math.floor(ch.x + dx + n) % n, y = Math.floor(ch.y + dy + n) % n, i = (y * n + x) * 4;
      col[i] = cc.r * 255; col[i + 1] = cc.g * 255; col[i + 2] = cc.b * 255;
    }
  }
  const nrm = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const sx = hgt[y * n + (x + 1) % n] - hgt[y * n + (x - 1 + n) % n], sy = hgt[((y + 1) % n) * n + x] - hgt[((y - 1 + n) % n) * n + x];
    const v = new THREE.Vector3(-sx * 4, -sy * 4, 1).normalize(), i = (y * n + x) * 4;
    nrm[i] = (v.x * 0.5 + 0.5) * 255; nrm[i + 1] = (v.y * 0.5 + 0.5) * 255; nrm[i + 2] = (v.z * 0.5 + 0.5) * 255; nrm[i + 3] = 255;
  }
  const mk = (d: Uint8Array, srgb: boolean) => { const t = new THREE.DataTexture(d, n, n); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; t.needsUpdate = true; return t; };
  return { map: mk(col, true), rough: mk(rough, false), normal: mk(nrm, false) };
}

const texCache = new Map<string, ReturnType<typeof surfaceTexture>>();
export const surfaceTextureCached = (k: Parameters<typeof surfaceTexture>[0]) => tex(k);
const tex = (k: Parameters<typeof surfaceTexture>[0]) => { let t = texCache.get(k); if (!t) { t = surfaceTexture(k); texCache.set(k, t); } return t; };

function texturedMat(kind: Parameters<typeof surfaceTexture>[0], tileMm: number, sizeMm: number, extra: Partial<THREE.MeshPhysicalMaterialParameters> = {}) {
  const t = tex(kind);
  const rep = sizeMm / tileMm;
  const clone = (x: THREE.Texture) => { const c = x.clone(); c.repeat.set(rep, rep); c.needsUpdate = true; return c; };
  return new THREE.MeshPhysicalMaterial({ map: clone(t.map), roughnessMap: clone(t.rough), normalMap: clone(t.normal), roughness: 1, ...extra });
}

export interface BackdropOptions { id: BackdropId; colour: string; /** Product footprint radius and height (mm). */ radius: number; height: number }

/** Build the set the product stands in (Z up, mm, floor at z = 0). */
export function buildBackdrop(o: BackdropOptions): THREE.Group {
  const g = new THREE.Group();
  g.name = 'Backdrop';
  const R = Math.max(150, o.radius * 4, o.height * 1.6);
  const slab = (mat: THREE.Material, size = R * 2, thick = 30) => { const m = new THREE.Mesh(new THREE.BoxGeometry(size, size, thick), mat); m.position.z = -thick / 2; g.add(m); return m; };
  const wall = (mat: THREE.Material, dist = R * 0.8, hgt = R * 1.6) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(R * 3, hgt), mat); m.rotation.x = Math.PI / 2; m.position.set(0, dist, hgt / 2); g.add(m); return m; };
  switch (o.id) {
    case 'sweep': {
      // floor that curves up into the wall (cove radius ∝ set size), one continuous paper surface
      const cove = R * 0.5, depth = R * 0.9, top = R * 2;
      const pts: THREE.Vector2[] = [new THREE.Vector2(-R * 1.4, 0), new THREE.Vector2(depth - cove, 0)];
      for (let i = 1; i <= 16; i++) { const a = (i / 16) * (Math.PI / 2); pts.push(new THREE.Vector2(depth - cove + Math.sin(a) * cove, cove - Math.cos(a) * cove)); }
      pts.push(new THREE.Vector2(depth, top));
      const shape = new THREE.BufferGeometry();
      const W = R * 4, pos: number[] = [], idx: number[] = [];
      pts.forEach((p) => { pos.push(-W / 2, p.x, p.y, W / 2, p.x, p.y); });
      for (let i = 0; i < pts.length - 1; i++) { const a = i * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
      shape.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); shape.setIndex(idx); shape.computeVertexNormals();
      g.add(new THREE.Mesh(shape, new THREE.MeshPhysicalMaterial({ color: o.colour, roughness: 0.92, side: THREE.DoubleSide })));
      break;
    }
    case 'oak-table': slab(texturedMat('oak', 900, R * 2, { clearcoat: 0.25, clearcoatRoughness: 0.35 })); wall(new THREE.MeshPhysicalMaterial({ color: o.colour, roughness: 0.9 })); break;
    case 'walnut-table': slab(texturedMat('walnut', 900, R * 2, { clearcoat: 0.35, clearcoatRoughness: 0.3 })); wall(new THREE.MeshPhysicalMaterial({ color: o.colour, roughness: 0.9 })); break;
    case 'concrete': slab(texturedMat('concrete', 1200, R * 2, { clearcoat: 0.15 })); wall(texturedMat('plaster', 1500, R * 3)); break;
    case 'marble': slab(texturedMat('marble', 1000, R * 2, { clearcoat: 0.6, clearcoatRoughness: 0.08 })); wall(new THREE.MeshPhysicalMaterial({ color: o.colour, roughness: 0.9 })); break;
    case 'linen': slab(texturedMat('linen', 40, R * 2, { sheen: 0.8, sheenRoughness: 0.6, sheenColor: new THREE.Color('#ffffff') }), R * 2, 4); wall(new THREE.MeshPhysicalMaterial({ color: o.colour, roughness: 0.9 })); break;
    case 'terrazzo': slab(texturedMat('terrazzo', 600, R * 2, { clearcoat: 0.4, clearcoatRoughness: 0.15 })); wall(new THREE.MeshPhysicalMaterial({ color: o.colour, roughness: 0.9 })); break;
    case 'shelf': {
      const shelf = new THREE.Mesh(new THREE.BoxGeometry(R * 2.4, R * 0.9, 28), texturedMat('oak', 900, R * 2.4, { clearcoat: 0.2 }));
      shelf.position.set(0, R * 0.2, -14); g.add(shelf);
      wall(texturedMat('plaster', 1500, R * 3), R * 0.65, R * 2);
      // a couple of books for scale
      const r = rng(5);
      for (let k = 0; k < 6; k++) { const b = new THREE.Mesh(new THREE.BoxGeometry(range(r, 20, 34), range(r, 140, 180), range(r, 190, 240)), new THREE.MeshPhysicalMaterial({ color: ['#6b2e2e', '#2e4a6b', '#d8cdb8', '#3a3a3a', '#7a6a3a', '#2e5a4a'][k], roughness: 0.7 })); b.position.set(R * 0.85 + k * 32, R * 0.35, 105); g.add(b); }
      break;
    }
    case 'windowsill': {
      slab(new THREE.MeshPhysicalMaterial({ color: '#f1efe9', roughness: 0.35, clearcoat: 0.3 }), R * 2.2, 40);
      const frame = new THREE.MeshPhysicalMaterial({ color: '#f4f4f2', roughness: 0.4 });
      for (const x of [-R, 0, R]) { const m = new THREE.Mesh(new THREE.BoxGeometry(40, 60, R * 2), frame); m.position.set(x, R * 0.75, R); g.add(m); }
      const glass = new THREE.Mesh(new THREE.PlaneGeometry(R * 2, R * 2), new THREE.MeshPhysicalMaterial({ color: '#ffffff', transmission: 1, roughness: 0, ior: 1.52, thickness: 4 }));
      glass.rotation.x = Math.PI / 2; glass.position.set(0, R * 0.75, R); g.add(glass);
      break;
    }
    case 'living-room': {
      const floor = slab(texturedMat('oak', 1200, R * 3, { clearcoat: 0.3, clearcoatRoughness: 0.3 }), R * 3, 20);
      void floor;
      wall(texturedMat('plaster', 2000, R * 3), R * 0.9, R * 2.5);
      const skirt = new THREE.Mesh(new THREE.BoxGeometry(R * 3, 18, 90), new THREE.MeshPhysicalMaterial({ color: '#f4f2ee', roughness: 0.4 }));
      skirt.position.set(0, R * 0.9 - 9, 45); g.add(skirt);
      const rug = new THREE.Mesh(new THREE.BoxGeometry(R * 1.6, R * 1.1, 8), texturedMat('linen', 30, R * 1.6, { color: '#c9bba4', sheen: 1, sheenRoughness: 0.8 }));
      rug.position.set(0, -R * 0.1, 4); g.add(rug);
      break;
    }
    case 'shadow-catcher': {
      const m = new THREE.MeshPhysicalMaterial({ color: '#ffffff', roughness: 1 });
      (m as unknown as { matte: boolean }).matte = true;
      slab(m, R * 4, 2);
      break;
    }
    case 'none': break;
  }
  return g;
}

// ---------------------------------------------------------------------------------------------------
// Cameras

export type ShotId = 'hero' | 'front' | 'side' | 'low-hero' | 'top-down' | 'detail' | 'overhead-3q';

export const SHOTS: { id: ShotId; name: string; az: number; el: number; focal: number; fNumber: number; fill: number }[] = [
  { id: 'hero', name: 'Hero ¾ view', az: 35, el: 18, focal: 85, fNumber: 8, fill: 0.72 },
  { id: 'front', name: 'Front, eye level', az: 0, el: 4, focal: 85, fNumber: 8, fill: 0.7 },
  { id: 'side', name: 'Side profile', az: 90, el: 4, focal: 85, fNumber: 8, fill: 0.7 },
  { id: 'low-hero', name: 'Low hero angle', az: 25, el: -4, focal: 50, fNumber: 5.6, fill: 0.78 },
  { id: 'overhead-3q', name: 'High ¾ overhead', az: 40, el: 45, focal: 70, fNumber: 8, fill: 0.7 },
  { id: 'top-down', name: 'Flat-lay top-down', az: 0, el: 89, focal: 50, fNumber: 8, fill: 0.75 },
  { id: 'detail', name: 'Macro detail (layer lines)', az: 30, el: 10, focal: 100, fNumber: 5.6, fill: 9 },
];

export interface CameraSetup { az: number; el: number; focal: number; fNumber: number; fill: number; /** Extra distance multiplier (dolly). */ dolly: number; /** Focus point offset as fraction of height (0 = centre). */ focusZ: number; blades: number }

/**
 * Place a physical camera (Y-up world, decimetres) to frame a box: distance from the focal length so the
 * object fills `fill` of the frame height. Aperture in world units = focal / N (mm → world).
 */
export function frameCamera(cam: THREE.PerspectiveCamera & { fStop?: number; focusDistance?: number; apertureBlades?: number }, box: THREE.Box3, s: CameraSetup, aspect: number, worldPerMm: number) {
  const sensorH = 24; // full frame, mm
  cam.filmGauge = 36;
  cam.setFocalLength(s.focal);
  cam.aspect = aspect;
  const size = box.getSize(new THREE.Vector3());
  const centre = box.getCenter(new THREE.Vector3());
  const target = centre.clone();
  target.y = box.min.y + size.y * (0.5 + s.focusZ * 0.5);
  const objH = Math.max(size.y, Math.max(size.x, size.z) / Math.max(aspect, 0.5) * 0.95);
  const vfov = 2 * Math.atan(sensorH / 2 / s.focal);
  const dist = (objH / s.fill / 2) / Math.tan(vfov / 2) * s.dolly + Math.max(size.x, size.z) / 2;
  const az = (s.az * Math.PI) / 180, el = (s.el * Math.PI) / 180;
  cam.position.set(target.x + Math.sin(az) * Math.cos(el) * dist, target.y + Math.sin(el) * dist, target.z + Math.cos(az) * Math.cos(el) * dist);
  cam.up.set(0, 1, 0);
  if (s.el > 85) cam.up.set(0, 0, -1);
  cam.lookAt(target);
  cam.near = Math.max(0.01, dist * 0.02); cam.far = dist * 50;
  cam.updateProjectionMatrix();
  // physical camera: aperture diameter = f / N, converted from mm to world units
  if ('fStop' in cam) {
    const apertureWorld = (s.focal / s.fNumber) * worldPerMm;
    cam.fStop = cam.getFocalLength() / Math.max(1e-6, apertureWorld);
    cam.focusDistance = cam.position.distanceTo(target);
    cam.apertureBlades = s.blades;
  }
  return target;
}
