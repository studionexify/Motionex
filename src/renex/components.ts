// Renex real-world components: everything that is not printed but is in the product photo. Lamp
// hardware (LED bulbs with glowing filaments inside real glass, lamp holders, braided fabric cord, plug,
// inline switch, felt pads) and planter fill (potting soil with perlite, top dressings, water in the
// saucer). Physical units: Z up, millimetres; lights are in candela / nits (see engine.ts for exposure).
import * as THREE from 'three';
import { latheZ, merge, rng, range, tube } from './geo';

// ---------------------------------------------------------------------------------------------------
// Light

/**
 * World units: the path tracer clamps light distance below 0.1 world units, so the scene is built in
 * decimetres (1 unit = 100 mm) — lamp shades a few cm from a bulb are then lit correctly. Point-light
 * intensity is in candela per m², so convert: I_world = I_cd · (units per metre)².
 */
export const WORLD_PER_MM = 0.01;
export const CANDELA_TO_WORLD = (WORLD_PER_MM * 1000) ** 2;

/** Tell the path tracer a surface does not block shadow rays (light passes through, e.g. thin glass). */
export function noShadow<M extends THREE.Material>(m: M): M { (m as unknown as { castShadow: boolean }).castShadow = false; return m; }

/** Black-body colour of a colour temperature (K) in linear RGB, normalised to max channel 1. */
export function kelvinToRGB(k: number): THREE.Color {
  const t = k / 100;
  let r: number, g: number, b: number;
  if (t <= 66) { r = 255; g = 99.4708025861 * Math.log(t) - 161.1195681661; b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307; }
  else { r = 329.698727446 * Math.pow(t - 60, -0.1332047592); g = 288.1221695283 * Math.pow(t - 60, -0.0755148492); b = 255; }
  const c = new THREE.Color().setRGB(Math.min(255, Math.max(0, r)) / 255, Math.min(255, Math.max(0, g)) / 255, Math.min(255, Math.max(0, b)) / 255, THREE.SRGBColorSpace);
  const m = Math.max(c.r, c.g, c.b);
  return c.multiplyScalar(1 / m);
}

export interface BulbOptions {
  /** [radius, z] envelope profile from the cap bottom (mm). */
  profile: [number, number][];
  watts: number;
  lit: boolean;
  /** Colour temperature (K). */
  kelvin: number;
  /** Clear glass with visible LED filaments, or opal (frosted) diffuser. */
  glass: 'clear' | 'opal' | 'amber';
  /** Screw base (E27/E26/E14/E12), bayonet (B22/B15) or none (puck / strip). */
  base: 'screw' | 'bayonet' | 'none';
  /** Luminous efficacy (lm/W); LED filament ≈ 100–150. */
  efficacy?: number;
}

/** Luminous flux (lm) of an LED bulb. */
export const lumens = (watts: number, efficacy = 110) => watts * efficacy;

/**
 * A real bulb: metal screw cap with thread, glass envelope (index 1.52, clear or opal), LED filaments on a
 * glass stem, and a point light at the filament centre carrying the bulb's full output in candela
 * (isotropic: I = Φ / 4π). The glass does not block shadow rays, so the light reaches through it.
 */
export function buildBulb(o: BulbOptions): THREE.Group {
  const g = new THREE.Group();
  g.name = 'Bulb';
  const prof = o.profile.filter(([, z]) => Number.isFinite(z));
  const capTop = o.base === 'none' ? 0 : Math.min(26, (prof[prof.length - 1]?.[1] ?? 60) * 0.25);
  const capR = prof.find(([, z]) => z >= capTop)?.[0] ?? 13;
  const height = prof[prof.length - 1]?.[1] ?? 100;
  // glass envelope above the cap (a closed shell: lathe to the pole)
  const glassProf = prof.filter(([, z]) => z >= capTop * 0.9);
  if (glassProf.length >= 2) {
    const shell = latheZ([[capR * 0.92, capTop * 0.9], ...glassProf, [0.001, height]], 64);
    const glass = new THREE.MeshPhysicalMaterial({
      color: o.glass === 'amber' ? '#ffb45a' : '#ffffff', roughness: o.glass === 'opal' ? 0.55 : 0.02, transmission: 1, thickness: 0.6, ior: 1.52,
      attenuationColor: o.glass === 'amber' ? new THREE.Color('#e08a2a') : new THREE.Color('#ffffff'), attenuationDistance: o.glass === 'amber' ? 2 : 1000,
      side: THREE.DoubleSide, transparent: false,
    });
    if (o.glass === 'opal') { glass.transmission = 0.92; glass.color = new THREE.Color('#f7f5f0'); }
    // light from inside passes straight through for shadow rays; refraction is still traced for camera paths
    const m = new THREE.Mesh(shell, noShadow(glass));
    m.name = 'Bulb glass';
    g.add(m);
  }
  if (o.base !== 'none') {
    // threaded aluminium cap + black glass insulator + solder contact
    const turns = 6, rows: [number, number][] = [];
    for (let i = 0; i <= turns * 8; i++) { const z = (i / (turns * 8)) * capTop * 0.85; rows.push([capR * (o.base === 'screw' ? 0.94 + 0.06 * Math.abs(Math.sin((i / 8) * Math.PI)) : 1), z + capTop * 0.15]); }
    const cap = new THREE.Mesh(latheZ(rows, 48), new THREE.MeshPhysicalMaterial({ color: '#c9c9c4', metalness: 1, roughness: 0.32 }));
    cap.name = 'Bulb cap';
    const ins = new THREE.Mesh(latheZ([[capR * 0.6, 0], [capR * 0.7, capTop * 0.15]], 32), new THREE.MeshPhysicalMaterial({ color: '#0d0d0d', roughness: 0.2, clearcoat: 1 }));
    const tip = new THREE.Mesh(latheZ([[0.001, -1.2], [capR * 0.25, -0.8], [capR * 0.3, 0]], 20), new THREE.MeshPhysicalMaterial({ color: '#b8b6ae', metalness: 1, roughness: 0.25 }));
    g.add(cap, ins, tip);
    if (o.base === 'bayonet') for (const s of [-1, 1]) { const pin = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 4, 10), cap.material); pin.rotation.z = Math.PI / 2; pin.position.set(s * (capR + 1.5), 0, capTop * 0.5); g.add(pin); }
  }
  // LED filaments: 4 strips on a glass stem, from just above the cap to the bulb centre
  const centreZ = capTop + (height - capTop) * 0.55;
  const k = kelvinToRGB(o.kelvin);
  const flux = lumens(o.watts, o.efficacy);
  const filaments: THREE.BufferGeometry[] = [];
  const stem = new THREE.Mesh(latheZ([[3, capTop], [2.2, capTop + 6], [1, centreZ - 6], [1.4, centreZ - 4]], 16), noShadow(new THREE.MeshPhysicalMaterial({ color: '#ffffff', transmission: 1, roughness: 0.05, ior: 1.5, thickness: 1 })));
  g.add(stem);
  const spread = Math.min(capR * 0.9, (height - capTop) * 0.22);
  if (o.glass !== 'opal') {
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      const lo = new THREE.Vector3(Math.cos(a) * spread * 0.3, Math.sin(a) * spread * 0.3, centreZ - (height - capTop) * 0.22);
      const hi = new THREE.Vector3(Math.cos(a) * spread, Math.sin(a) * spread, centreZ + (height - capTop) * 0.18);
      filaments.push(tube([lo, lo.clone().lerp(hi, 0.5).add(new THREE.Vector3(Math.cos(a), Math.sin(a), 0).multiplyScalar(1.5)), hi], 0.75, 6, 10));
      // support wires
      filaments.push(tube([new THREE.Vector3(0, 0, centreZ - 4), lo], 0.15, 3, 3), tube([new THREE.Vector3(0, 0, centreZ + (height - capTop) * 0.2), hi], 0.15, 3, 3));
    }
  }
  if (filaments.length) {
    // filament phosphor: yellow when off; at full power its luminance is ~1e5 nits (area ≈ 4 × 30 mm × 1.5 mm)
    const area = 4 * (height - capTop) * 0.4 * 1.5e-6 * Math.PI; // m²
    const nits = o.lit ? flux / (Math.PI * Math.max(area, 1e-5)) : 0;
    const mat = new THREE.MeshPhysicalMaterial({ color: '#e8b04a', roughness: 0.6, emissive: k, emissiveIntensity: nits });
    const fm = new THREE.Mesh(merge(filaments), noShadow(mat));
    fm.name = 'LED filaments';
    g.add(fm);
  }
  if (o.lit) {
    const light = new THREE.PointLight(k, (flux / (4 * Math.PI)) * CANDELA_TO_WORLD, 0, 2);
    light.position.set(0, 0, centreZ);
    light.name = 'Bulb light';
    g.add(light);
    const shell = g.getObjectByName('Bulb glass') as THREE.Mesh | undefined;
    if (o.glass === 'opal' && shell) {
      // opal envelope glows evenly: luminance = Φ / (π · A_envelope), A ≈ 4πR²
      const R = Math.max(...prof.map(([r]) => r)) / 1000;
      const m = shell.material as THREE.MeshPhysicalMaterial;
      m.emissive = k; m.emissiveIntensity = (flux / (Math.PI * 4 * Math.PI * R * R)) * 0.9;
    }
  }
  return g;
}

/** LED puck / strip for battery lamps: aluminium body, opal diffuser, Lambertian down/up emitter. */
export function buildPuck(diameter: number, watts: number, lit: boolean, kelvin: number): THREE.Group {
  const g = new THREE.Group();
  const body = new THREE.Mesh(latheZ([[diameter / 2, 0], [diameter / 2, 8], [diameter / 2 - 2, 10]], 48), new THREE.MeshPhysicalMaterial({ color: '#d8d8d8', metalness: 1, roughness: 0.35 }));
  const flux = lumens(watts, 90);
  const k = kelvinToRGB(kelvin);
  const area = Math.PI * (diameter / 2000) ** 2;
  const lens = new THREE.Mesh(new THREE.CircleGeometry(diameter / 2 - 2, 48), new THREE.MeshPhysicalMaterial({ color: '#f2f2f2', roughness: 0.5, emissive: k, emissiveIntensity: lit ? flux / (Math.PI * area) : 0 }));
  lens.position.z = 10.05;
  g.add(body, lens);
  if (lit) { const l = new THREE.PointLight(k, (flux / (4 * Math.PI)) * CANDELA_TO_WORLD, 0, 2); l.position.z = 14; g.add(l); }
  return g;
}

export interface HolderOptions { body: number; length: number; above: number; kind: 'screw' | 'bayonet' | 'pad'; finish: 'bakelite' | 'ceramic' | 'brass' }

/** Lamp holder: ribbed body, threaded skirt and the shade ring clamping the gallery. */
export function buildHolder(o: HolderOptions): THREE.Group {
  const g = new THREE.Group();
  const mat = o.finish === 'brass' ? new THREE.MeshPhysicalMaterial({ color: '#c9a45a', metalness: 1, roughness: 0.28 })
    : o.finish === 'ceramic' ? new THREE.MeshPhysicalMaterial({ color: '#f2efe8', roughness: 0.25, clearcoat: 0.8 })
      : new THREE.MeshPhysicalMaterial({ color: '#141414', roughness: 0.35, clearcoat: 0.4 });
  const r = o.body / 2, rows: [number, number][] = [[3.5, -o.length - 6], [3.5, -o.length], [r * 0.7, -o.length], [r * 0.8, -o.length + 3]];
  for (let i = 0; i <= 10; i++) rows.push([r * (i % 2 ? 0.96 : 1), -o.length + 6 + (i / 10) * (o.length - 10)]);
  rows.push([r, -2], [r * 0.95, 0], [r * 0.92, o.above]);
  const body = new THREE.Mesh(latheZ(rows, 48), mat);
  body.name = 'Lamp holder';
  // shade ring on the thread, just above the gallery
  const ring = new THREE.Mesh(new THREE.TorusGeometry(r + 2.5, 2.2, 10, 48), mat);
  ring.position.z = 2;
  g.add(body, ring);
  return g;
}

export interface CordOptions { path: THREE.Vector3[]; diameter: number; fabric: 'braided' | 'pvc' | 'twisted'; colour: string; plug?: 'eu' | 'uk' | 'us' | 'in' | 'none'; switchAt?: number }

/** Fabric-braided (or PVC) mains cord along a path, with an inline switch and plug at the end. */
export function buildCord(o: CordOptions): THREE.Group {
  const g = new THREE.Group();
  if (o.path.length < 2) return g;
  const geo = tube(o.path, o.diameter / 2, 10, Math.max(40, o.path.length * 20));
  const mat = new THREE.MeshPhysicalMaterial({ color: o.colour, roughness: o.fabric === 'pvc' ? 0.35 : 0.85, sheen: o.fabric === 'pvc' ? 0 : 0.8, sheenRoughness: 0.5, sheenColor: new THREE.Color(o.colour).lerp(new THREE.Color('#ffffff'), 0.4) });
  if (o.fabric !== 'pvc') mat.normalMap = braidTexture(), mat.normalScale = new THREE.Vector2(1.2, 1.2);
  // repeat the braid every 2 mm of cord
  const len = new THREE.CatmullRomCurve3(o.path).getLength();
  if (mat.normalMap) mat.normalMap.repeat.set(len / 2, 1);
  const cord = new THREE.Mesh(geo, mat);
  cord.name = 'Cord';
  g.add(cord);
  const curve = new THREE.CatmullRomCurve3(o.path);
  const plastic = new THREE.MeshPhysicalMaterial({ color: o.colour.toLowerCase() === '#f2f2f2' ? '#f4f4f2' : '#1a1a1a', roughness: 0.3, clearcoat: 0.5 });
  if (o.switchAt !== undefined) {
    const at = curve.getPointAt(o.switchAt), dir = curve.getTangentAt(o.switchAt);
    const sw = new THREE.Mesh(new THREE.CapsuleGeometry(9, 40, 6, 16), plastic);
    sw.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    sw.position.copy(at);
    sw.name = 'Inline switch';
    const rocker = new THREE.Mesh(new THREE.BoxGeometry(8, 14, 4), new THREE.MeshPhysicalMaterial({ color: '#2a2a2a', roughness: 0.4 }));
    rocker.position.set(0, 0, 9); sw.add(rocker);
    g.add(sw);
  }
  if (o.plug && o.plug !== 'none') {
    const end = curve.getPointAt(1), dir = curve.getTangentAt(1);
    const plug = new THREE.Group();
    const bodyG = o.plug === 'uk' ? new THREE.BoxGeometry(50, 22, 40) : new THREE.CylinderGeometry(17, 19, 40, 32);
    const body = new THREE.Mesh(bodyG, plastic);
    body.position.y = 20;
    plug.add(body);
    const pinMat = new THREE.MeshPhysicalMaterial({ color: '#d8c38a', metalness: 1, roughness: 0.25 });
    const pins: [number, number, number, number][] = o.plug === 'eu' ? [[-9.5, 0, 2, 19], [9.5, 0, 2, 19]] : o.plug === 'us' ? [[-6.4, 0, 1, 16], [6.4, 0, 1, 16]] : o.plug === 'in' ? [[-9.5, -4, 2.5, 18], [9.5, -4, 2.5, 18], [0, 8, 3.5, 22]] : [[-11, -6, 3, 17], [11, -6, 3, 17], [0, 10, 3, 22]];
    for (const [x, z, rr, l] of pins) { const p = new THREE.Mesh(o.plug === 'us' || o.plug === 'uk' ? new THREE.BoxGeometry(rr * 2, l, 6) : new THREE.CylinderGeometry(rr, rr, l, 16), pinMat); p.position.set(x, 40 + l / 2, z); plug.add(p); }
    plug.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    plug.position.copy(end);
    plug.name = 'Plug';
    g.add(plug);
  }
  return g;
}

let braid: THREE.DataTexture | null = null;
/** Herringbone braid of a textile cord (tangent space normal map). */
function braidTexture(): THREE.DataTexture {
  if (braid) return braid;
  const n = 64, d = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const a = Math.sin(((x + y) / n) * Math.PI * 4), b = Math.sin(((x - y) / n) * Math.PI * 4);
    const h = (y / n) % 0.5 < 0.25 ? a : b;
    const i = (y * n + x) * 4;
    d[i] = 128 + h * 60; d[i + 1] = 128 + h * 30; d[i + 2] = 230; d[i + 3] = 255;
  }
  braid = new THREE.DataTexture(d, n, n);
  braid.wrapS = braid.wrapT = THREE.RepeatWrapping;
  braid.needsUpdate = true;
  return braid;
}

/** Self-adhesive felt pads under a base (sheen-heavy textile). */
export function buildFeltPads(radius: number, count: number, padD: number, colour = '#2b2b2b'): THREE.Group {
  const g = new THREE.Group();
  const mat = new THREE.MeshPhysicalMaterial({ color: colour, roughness: 1, sheen: 1, sheenRoughness: 0.9, sheenColor: new THREE.Color(colour).lerp(new THREE.Color('#ffffff'), 0.3) });
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    const m = new THREE.Mesh(new THREE.CylinderGeometry(padD / 2, padD / 2, 2, 24), mat);
    m.rotation.x = Math.PI / 2; m.position.set(Math.cos(a) * radius, Math.sin(a) * radius, -1);
    g.add(m);
  }
  g.name = 'Felt pads';
  return g;
}

// ---------------------------------------------------------------------------------------------------
// Planter fill

export type TopDressing = 'soil' | 'bark' | 'pebbles' | 'perlite' | 'moss' | 'sand' | 'lava' | 'leca';

export const TOP_DRESSINGS: { id: TopDressing; name: string }[] = [
  { id: 'soil', name: 'Potting soil (with perlite)' }, { id: 'bark', name: 'Orchid bark' }, { id: 'pebbles', name: 'River pebbles' },
  { id: 'perlite', name: 'Perlite-rich mix' }, { id: 'moss', name: 'Sphagnum moss' }, { id: 'sand', name: 'Cactus grit / sand' },
  { id: 'lava', name: 'Lava rock' }, { id: 'leca', name: 'LECA clay balls' },
];

export interface SoilOptions {
  /** Inner radius of the pot at the soil line (mm) and the profile below it, as radius at depth. */
  radius: number;
  z: number;
  dressing: TopDressing;
  /** 0 dry … 1 freshly watered (darker, glossier). */
  moisture: number;
  seed?: number;
}

/** Soil surface (slightly mounded, crumbly) plus top-dressing particles, sized to the pot opening. */
export function buildSoil(o: SoilOptions): THREE.Group {
  const g = new THREE.Group();
  g.name = 'Soil';
  const r = rng(o.seed ?? 7);
  const R = Math.max(5, o.radius - 0.6);
  const wet = Math.max(0, Math.min(1, o.moisture));
  const soilCol = new THREE.Color('#4a3527').lerp(new THREE.Color('#251a13'), wet);
  // crumbly disc: radial grid with fractal bumps
  const rings = 24, seg = 96, pos: number[] = [], idx: number[] = [];
  pos.push(0, 0, o.z + 2);
  for (let i = 1; i <= rings; i++) for (let j = 0; j < seg; j++) {
    const t = i / rings, a = (j / seg) * Math.PI * 2;
    const bump = (Math.sin(a * 13 + t * 31) * Math.sin(a * 7 - t * 17) * 0.6 + Math.sin(a * 41 + t * 73) * 0.3) * 0.9;
    pos.push(Math.cos(a) * R * t, Math.sin(a) * R * t, o.z + 2 * (1 - t * t) + bump + (i === rings ? 1.2 : 0));
  }
  for (let j = 0; j < seg; j++) idx.push(0, 1 + j, 1 + (j + 1) % seg);
  for (let i = 0; i < rings - 1; i++) for (let j = 0; j < seg; j++) { const a = 1 + i * seg + j, b = 1 + i * seg + (j + 1) % seg; idx.push(a, a + seg, b, b, a + seg, b + seg); }
  const disc = new THREE.BufferGeometry(); disc.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); disc.setIndex(idx); disc.computeVertexNormals();
  g.add(new THREE.Mesh(disc, new THREE.MeshPhysicalMaterial({ color: soilCol, roughness: 1 - wet * 0.45, clearcoat: wet * 0.3, clearcoatRoughness: 0.5 })));
  const scatter = (count: number, size: [number, number], colours: string[], shape: 'round' | 'chip' | 'pebble' | 'fibre', mat: Partial<THREE.MeshPhysicalMaterialParameters>) => {
    const geos: THREE.BufferGeometry[] = [];
    for (let k = 0; k < count; k++) {
      const a = range(r, 0, Math.PI * 2), d = Math.sqrt(r()) * (R - size[1]);
      const s = range(r, size[0], size[1]);
      let p: THREE.BufferGeometry;
      if (shape === 'chip') { p = new THREE.BoxGeometry(s * 1.6, s, s * 0.35); p.rotateZ(range(r, 0, Math.PI)); p.rotateX(range(r, -0.3, 0.3)); }
      else if (shape === 'pebble') { p = new THREE.SphereGeometry(s, 10, 8); p.scale(1, range(r, 0.65, 0.95), range(r, 0.4, 0.6)); p.rotateZ(range(r, 0, Math.PI)); }
      else if (shape === 'fibre') { p = tube([new THREE.Vector3(0, 0, 0), new THREE.Vector3(range(r, -s, s), range(r, -s, s), range(r, 0, s * 0.3)), new THREE.Vector3(range(r, -2 * s, 2 * s), range(r, -2 * s, 2 * s), 0)], 0.5, 3, 6); }
      else { p = new THREE.IcosahedronGeometry(s, 0); p.rotateX(range(r, 0, 3)); p.rotateY(range(r, 0, 3)); }
      p.translate(Math.cos(a) * d, Math.sin(a) * d, o.z + 2.2 * (1 - (d / R) ** 2) + s * 0.25);
      const c = new THREE.Color(colours[Math.floor(r() * colours.length)]).offsetHSL(0, 0, range(r, -0.04, 0.04));
      const n = p.index ? p.index.count : p.getAttribute('position').count;
      const pp = p.index ? p.toNonIndexed() : p;
      const ca = new Float32Array(pp.getAttribute('position').count * 3);
      for (let v = 0; v < ca.length / 3; v++) ca.set([c.r, c.g, c.b], v * 3);
      pp.setAttribute('color', new THREE.BufferAttribute(ca, 3));
      void n;
      geos.push(pp);
      if (pp !== p) p.dispose();
    }
    const m = new THREE.Mesh(merge(geos, true), new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.8, ...mat }));
    g.add(m);
  };
  const area = Math.PI * R * R;
  // perlite always present in potting soil (white volcanic glass, very rough)
  if (o.dressing === 'soil' || o.dressing === 'perlite') scatter(Math.min(1500, area / (o.dressing === 'perlite' ? 12 : 45)), [0.8, 2.2], ['#efefea', '#e5e4dc'], 'round', { roughness: 0.95 });
  if (o.dressing === 'soil') scatter(Math.min(800, area / 60), [0.6, 1.8], ['#3a2a1e', '#5b4330', '#2a1d14'], 'chip', { roughness: 1 });
  if (o.dressing === 'bark') scatter(Math.min(500, area / 50), [3, 7], ['#7a4a2a', '#8b5a33', '#5e3a22'], 'chip', { roughness: 0.9 });
  if (o.dressing === 'pebbles') scatter(Math.min(700, area / 35), [2.5, 5.5], ['#c9c2b6', '#8f8a82', '#e2ddd2', '#6e6a64', '#b5a78e'], 'pebble', { roughness: 0.35 - wet * 0.2, clearcoat: wet * 0.8 });
  if (o.dressing === 'sand') scatter(Math.min(2500, area / 6), [0.5, 1.3], ['#cdb48a', '#b89d72', '#e2d0aa'], 'round', { roughness: 0.9 });
  if (o.dressing === 'lava') scatter(Math.min(600, area / 40), [2.5, 5], ['#5a2620', '#3a1a17', '#6e3022'], 'round', { roughness: 1 });
  if (o.dressing === 'leca') scatter(Math.min(600, area / 40), [3, 5.5], ['#a0532e', '#b4643a', '#8a4526'], 'pebble', { roughness: 0.85 });
  if (o.dressing === 'moss') scatter(Math.min(900, area / 15), [2, 4], ['#9fb06a', '#b5bf80', '#7f9050'], 'fibre', { roughness: 1, sheen: 1, sheenColor: new THREE.Color('#d8e0a0') });
  return g;
}

/** Water standing in a saucer (index 1.333, clear) and a damp ring around the pot foot. */
export function buildWater(radius: number, z: number, depth: number): THREE.Mesh {
  const geo = latheZ([[0.001, z], [radius, z], [radius, z + depth], [0.001, z + depth]], 64);
  const m = new THREE.Mesh(geo, new THREE.MeshPhysicalMaterial({ color: '#ffffff', transmission: 1, roughness: 0.01, ior: 1.333, thickness: depth, attenuationColor: new THREE.Color('#d8e8e0'), attenuationDistance: 80 }));
  m.name = 'Water';
  return m;
}
