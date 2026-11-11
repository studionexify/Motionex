// Renex render engine: assembles a physically lit scene from a studio's design and a render setup, then
// path traces it progressively on the GPU (three-gpu-pathtracer: unbiased Monte Carlo path tracing with
// multiple importance sampling, GGX microfacets, transmission with absorption, sheen, clearcoat, thin-lens
// depth of field). Runs in Electron and in the browser (WebGL2).
import * as THREE from 'three';
import { DenoiseMaterial, PhysicalCamera, WebGLPathTracer } from 'three-gpu-pathtracer';
import { buildBulb, buildCord, buildFeltPads, buildHolder, buildPuck, buildSoil, buildWater, WORLD_PER_MM } from './components';
import { plantById, buildPlant } from './plants';
import { preparePrinted, type PrintSettings } from './printSurface';
import { QUALITY, type RenderSetup } from './profiles';
import { buildBackdrop, buildEnvironment, surfaceTextureCached, ENVIRONMENTS, environmentLights, exposureFor, frameCamera, SHOTS } from './scenes';
import type { RenexSceneSource, SourcePart } from './source';
import { tagImage, type DisclosureInfo } from './metadata';

export interface RenderProgress { samples: number; target: number; elapsed: number; eta: number; done: boolean; stage: string }

const TONE: Record<RenderSetup['toneMap'], THREE.ToneMapping> = { agx: THREE.AgXToneMapping, aces: THREE.ACESFilmicToneMapping, neutral: THREE.NeutralToneMapping };

/** Part transform (print frame → product, Z up mm) for the chosen layout. */
export function partMatrix(p: SourcePart, i: number, setup: RenderSetup, flat: THREE.Matrix4[]): THREE.Matrix4 {
  const look = setup.parts[p.key] ?? {};
  const m = setup.layout === 'parts' ? flat[i].clone() : p.assembled.clone();
  if (setup.layout === 'exploded' && p.exploded) m.premultiply(new THREE.Matrix4().makeTranslation(p.exploded.x, p.exploded.y, p.exploded.z));
  if (setup.layout === 'custom' || setup.layout === 'parts') {
    const [x, y, z] = look.offset ?? [0, 0, 0];
    if (look.spin) m.premultiply(new THREE.Matrix4().makeRotationZ((look.spin * Math.PI) / 180));
    m.premultiply(new THREE.Matrix4().makeTranslation(x, y, z));
  }
  return m;
}

/** Flat-lay: every part in print orientation, side by side on the table (like it came off the plate). */
export function flatLayout(parts: SourcePart[], gap = 20): THREE.Matrix4[] {
  const boxes = parts.map((p) => { const b = new THREE.Box3(); const v = new THREE.Vector3(); for (let i = 0; i < p.printSoup.length; i += 3) b.expandByPoint(v.set(p.printSoup[i], p.printSoup[i + 1], p.printSoup[i + 2])); return b; });
  const total = boxes.reduce((s, b) => s + (b.max.x - b.min.x) + gap, -gap);
  const rowW = Math.max(200, Math.sqrt(total * Math.max(...boxes.map((b) => b.max.y - b.min.y), 50)) * 1.6);
  const out: THREE.Matrix4[] = [];
  let x = 0, y = 0, row = 0;
  boxes.forEach((b) => {
    const w = b.max.x - b.min.x, h = b.max.y - b.min.y;
    if (x > 0 && x + w > rowW) { x = 0; y += row + gap; row = 0; }
    out.push(new THREE.Matrix4().makeTranslation(x - b.min.x, y - b.min.y, 0));
    x += w + gap; row = Math.max(row, h);
  });
  // centre the layout
  const all = new THREE.Box3();
  boxes.forEach((b, i) => all.union(b.clone().applyMatrix4(out[i])));
  const c = all.getCenter(new THREE.Vector3());
  return out.map((m) => m.premultiply(new THREE.Matrix4().makeTranslation(-c.x, -c.y, 0)));
}

/**
 * The path tracer merges every mesh into one buffer by raw copy, so each attribute must have the same item
 * size everywhere: it fills a missing `color` with RGBA, so RGB vertex colours are widened to RGBA here.
 */
export function normalizeForTracer(scene: THREE.Object3D) {
  scene.traverse((o) => {
    const g = (o as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
    const c = g?.getAttribute('color') as THREE.BufferAttribute | undefined;
    if (!g || !c || c.itemSize === 4) return;
    const a = new Float32Array(c.count * 4);
    for (let i = 0; i < c.count; i++) { a[i * 4] = c.getX(i); a[i * 4 + 1] = c.getY(i); a[i * 4 + 2] = c.getZ(i); a[i * 4 + 3] = 1; }
    g.setAttribute('color', new THREE.BufferAttribute(a, 4));
  });
}

export interface BuiltScene { scene: THREE.Scene; camera: PhysicalCamera; productBox: THREE.Box3; triangles: number; notes: string[] }

/** Build the full scene (Y-up world in decimetres; product content authored Z-up in mm under `root`). */
export function buildScene(src: RenexSceneSource, setup: RenderSetup, aspect: number): BuiltScene {
  const scene = new THREE.Scene();
  const root = new THREE.Group();
  root.rotation.x = -Math.PI / 2;
  root.scale.setScalar(WORLD_PER_MM);
  scene.add(root);
  const notes: string[] = [];
  const product = new THREE.Group();
  product.name = 'Product';
  const print: PrintSettings = { ...src.print, supports: setup.supports, texturedBed: setup.texturedBed, seam: setup.seam === 'from-settings' ? src.print.seam : setup.seam };
  const flat = flatLayout(src.parts);
  let triangles = 0;
  src.parts.forEach((p, i) => {
    const look = setup.parts[p.key] ?? {};
    if (look.hidden) return;
    const r = preparePrinted({ name: p.name, soup: p.printSoup, toScene: partMatrix(p, i, setup, flat), hex: look.hex ?? p.hex, finish: look.finish ?? p.finish, paint: p.paint, paintHex: p.paintHex }, print, setup.layerLines);
    triangles += r.triangles;
    for (const m of r.meshes) { m.userData.printed = true; m.userData.frame = true; product.add(m); }
  });
  const assembledView = setup.layout === 'assembled' || setup.layout === 'custom';
  // planter: soil, plants, water
  if (src.planter && assembledView) {
    const pl = src.planter;
    if (pl.kind === 'planter') product.add(buildSoil({ radius: pl.soilRadius, z: pl.soilZ, dressing: setup.dressing, moisture: setup.moisture }));
    const picks = setup.plants.filter((x) => plantById(x.id));
    picks.forEach((pick, k) => {
      const def = plantById(pick.id)!;
      // auto-size: a plant fills the pot opening like a nursery-potted plant (user scale on top)
      const fit = Math.min(2.5, Math.max(0.25, (pl.soilRadius * 2 * 1.15) / def.spread));
      const scale = fit * pick.scale;
      const plant = buildPlant(def, { seed: pick.seed, scale, rimRadius: pl.rimRadius / scale, rimAboveSoil: (pl.rimZ - pl.soilZ) / scale });
      if (picks.length > 1) { const a = (k / picks.length) * Math.PI * 2; plant.position.set(Math.cos(a) * pl.soilRadius * 0.45, Math.sin(a) * pl.soilRadius * 0.45, 0); }
      plant.position.z = pl.kind === 'planter' ? pl.soilZ + 1.5 : pl.rimZ - 20;
      plant.userData.frame = true;
      product.add(plant);
    });
    if (setup.saucerWater && pl.saucer) product.add(buildWater(pl.saucer.radius, pl.saucer.z, Math.min(pl.saucer.depth * 0.6, 4)));
  }
  // lamp hardware
  const lamp = src.lamp;
  const lit = lamp ? setup.lit : false;
  if (lamp && assembledView) {
    if (lamp.bulb) { const b = buildBulb({ profile: lamp.bulb.profile, watts: lamp.watts, lit, kelvin: setup.kelvin, glass: setup.glass, base: lamp.bulb.base }); b.applyMatrix4(lamp.bulb.frame); b.userData.frame = true; product.add(b); }
    if (lamp.puck) { const b = buildPuck(lamp.puck.diameter, lamp.watts, lit, setup.kelvin); b.applyMatrix4(lamp.puck.frame); b.userData.frame = true; product.add(b); }
    if (lamp.holder) { const h = buildHolder({ ...lamp.holder, finish: setup.holderFinish }); h.applyMatrix4(lamp.holder.frame); product.add(h); }
    if (lamp.cord.length > 1) product.add(buildCord({ path: lamp.cord, diameter: lamp.cordDiameter, fabric: setup.cordFabric, colour: setup.cordColour, plug: lamp.cordEnd === 'plug' ? setup.plug : 'none', switchAt: lamp.cordEnd === 'plug' ? 0.72 : undefined }));
    if (lamp.foot && setup.feltPads) { const f = buildFeltPads(lamp.foot.radius, 4, 18); f.position.copy(lamp.foot.centre); product.add(f); }
    if (lit && !lamp.bulb && !lamp.puck) notes.push('This lamp type has no light source in the design, so it renders unlit.');
  }
  // stand the product on the floor (hanging lamps hang 450 mm above it). The floor is set by the printed
  // parts (felt pads sit in their recess); loose hardware on the table (plug, switch) rests on it.
  product.updateMatrixWorld(true);
  const printedBox = new THREE.Box3();
  for (const c of product.children) if (c.userData.printed || c.name === 'Felt pads') printedBox.union(new THREE.Box3().setFromObject(c));
  const box = printedBox.isEmpty() ? new THREE.Box3().setFromObject(product) : printedBox;
  const hanging = lamp && (lamp.cordEnd === 'ceiling');
  // wall lamps are screwed to a wall: the backplate sits on it, the floor is well below
  const wallMounted = !!lamp && lamp.cordEnd === 'wall' && assembledView;
  const floorZ = hanging ? box.min.z - 450 : wallMounted ? box.min.z - 750 : box.min.z;
  if (!hanging) product.traverse((o) => {
    if (o.name !== 'Plug' && o.name !== 'Inline switch') return;
    const b = new THREE.Box3().setFromObject(o);
    if (b.min.z < floorZ) o.position.z += floorZ - b.min.z;
  });
  product.position.z = -floorZ;
  root.add(product);
  const radius = Math.max(box.max.x - box.min.x, box.max.y - box.min.y) / 2;
  const heightMm = box.max.z - floorZ;
  const transparent = setup.transparent;
  const backdrop = buildBackdrop({ id: transparent ? 'shadow-catcher' : setup.backdrop, colour: setup.backdropColour, radius, height: heightMm });
  backdrop.position.set((box.min.x + box.max.x) / 2, (box.min.y + box.max.y) / 2, 0);
  root.add(backdrop);
  if (wallMounted) {
    // plaster wall flush with the backplate (the plate's back face is the product's +Y side)
    const t = surfaceTextureCached('plaster');
    const W = Math.max(1200, radius * 10), H = heightMm + 900;
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(W, H), new THREE.MeshPhysicalMaterial({ map: t.map, roughnessMap: t.rough, normalMap: t.normal, roughness: 1, color: setup.backdropColour }));
    wall.rotation.x = Math.PI / 2;
    wall.position.set((box.min.x + box.max.x) / 2, box.max.y + 0.2, H / 2 - 200);
    wall.name = 'Mounting wall';
    root.add(wall);
  }
  if (hanging && lamp && lamp.cord.length) {
    // ceiling above: a plaster plane the cord disappears into
    const ceil = new THREE.Mesh(new THREE.PlaneGeometry(radius * 12, radius * 12), new THREE.MeshPhysicalMaterial({ color: '#f2efe9', roughness: 0.9, side: THREE.DoubleSide }));
    ceil.position.set(0, 0, box.max.z - floorZ + 2);
    root.add(ceil);
  }
  scene.updateMatrixWorld(true);
  normalizeForTracer(scene);
  // environment (lighting + background)
  const env = buildEnvironment(setup.env, (setup.envRotation * Math.PI) / 180);
  scene.environment = env;
  scene.background = transparent ? null : env;
  const productWorld = new THREE.Box3();
  for (const c of product.children) if (c.userData.frame) productWorld.union(new THREE.Box3().setFromObject(c));
  if (productWorld.isEmpty()) productWorld.setFromObject(product);
  const centre = productWorld.getCenter(new THREE.Vector3());
  for (const l of environmentLights(setup.env, centre, productWorld.getSize(new THREE.Vector3()).length(), (setup.envRotation * Math.PI) / 180)) scene.add(l);
  // camera
  const camera = new PhysicalCamera(35, aspect, 0.01, 1000);
  const shot = SHOTS.find((s) => s.id === setup.shot);
  const frameBox = productWorld;
  const target = frameCamera(camera, frameBox, { az: setup.az, el: setup.el, focal: setup.focal, fNumber: setup.fNumber, fill: shot?.fill ?? 0.72, dolly: setup.dolly, focusZ: setup.focusZ, blades: setup.blades }, aspect, WORLD_PER_MM);
  // autofocus: focus on the first product surface along the line of sight (not the box centre inside it)
  const ray = new THREE.Raycaster(camera.position, target.clone().sub(camera.position).normalize());
  const hit = ray.intersectObject(product, true).find((h) => !(h.object as THREE.Mesh).material || !((h.object as THREE.Mesh).material as THREE.MeshPhysicalMaterial).transmission);
  if (hit) camera.focusDistance = hit.distance;
  return { scene, camera, productBox: productWorld, triangles, notes };
}

export class RenexRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly canvas: HTMLCanvasElement;
  private tracer: WebGLPathTracer;
  private denoise = new DenoiseMaterial({ sigma: 3.5, threshold: 0.03, kSigma: 1.0 });
  private built: BuiltScene | null = null;
  private raf = 0;
  private start = 0;
  private target = 0;
  private stopped = true;
  private contextLost = false;
  private onLostHandlers: ((reason: string) => void)[] = [];
  private useDenoise = true;
  private meter: { comp: number } | null = null;
  onProgress: (p: RenderProgress) => void = () => {};

  constructor(canvas?: HTMLCanvasElement) {
    this.canvas = canvas ?? document.createElement('canvas');
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: false, preserveDrawingBuffer: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.tracer = new WebGLPathTracer(this.renderer);
    this.tracer.multipleImportanceSampling = true;
    this.tracer.minSamples = 1;
    this.tracer.renderDelay = 0;
    this.tracer.fadeDuration = 0;
    this.tracer.tiles.set(2, 2);
    // the browser resets WebGL when a GPU command runs too long or VRAM runs out: report it instead of
    // leaving an empty canvas
    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.contextLost = true;
      this.stop();
      const why = 'The graphics driver reset the GPU during path tracing (too much work per pass or out of video memory).';
      for (const h of this.onLostHandlers.splice(0)) h(why);
      this.onProgress({ samples: 0, target: 0, elapsed: 0, eta: 0, done: false, stage: 'GPU reset' });
    }, false);
    this.tracer.renderToCanvasCallback = (target, renderer, quad) => {
      const prev = quad.material;
      if (this.useDenoise && this.tracer.samples > 8) { this.denoise.map = target.texture; quad.material = this.denoise; }
      const ac = renderer.autoClear; renderer.autoClear = false;
      quad.render(renderer);
      renderer.autoClear = ac;
      quad.material = prev;
    };
  }

  static supported(): boolean {
    try { const c = document.createElement('canvas'); const gl = c.getContext('webgl2'); return !!gl && !!gl.getExtension('EXT_color_buffer_float'); } catch { return false; }
  }

  /** Build the scene and start progressive rendering at the setup's output resolution. */
  async render(src: RenexSceneSource, setup: RenderSetup): Promise<BuiltScene> {
    this.stop();
    this.onProgress({ samples: 0, target: 0, elapsed: 0, eta: 0, done: false, stage: 'Building scene…' });
    await new Promise((r) => setTimeout(r, 10));
    const q = QUALITY[setup.quality];
    if (this.contextLost || this.renderer.getContext().isContextLost()) throw new Error('The GPU context was lost; close and reopen Renex to path trace again.');
    const caps = this.renderer.capabilities, gl = this.renderer.getContext();
    const maxDim = Math.min(caps.maxTextureSize, gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number, 8192);
    const fit = Math.min(1, maxDim / Math.max(setup.width, setup.height));
    const w = Math.max(64, Math.round(setup.width * fit)), h = Math.max(64, Math.round(setup.height * fit));
    // one tile ≤ 256k pixels per draw: keeps every GPU submission short (driver watchdogs fire at ~2 s)
    const tiles = Math.max(2, Math.ceil(Math.sqrt((w * h) / (512 * 512))));
    this.tracer.tiles.set(tiles, tiles);
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(w, h, false);
    this.renderer.toneMapping = TONE[setup.toneMap];
    const ev = (ENVIRONMENTS.find((e) => e.id === setup.env)?.ev ?? 9) - setup.evComp;
    this.renderer.toneMappingExposure = exposureFor(ev);
    this.meter = setup.autoExposure ? { comp: setup.evComp } : null;
    this.disposeScene();
    const built = buildScene(src, setup, w / h);
    this.built = built;
    this.tracer.bounces = q.bounces;
    this.tracer.transmissiveBounces = q.transmissiveBounces;
    this.tracer.filterGlossyFactor = q.filterGlossy;
    this.tracer.renderScale = setup.quality === 'fast' ? 0.5 : 1;
    this.tracer.textureSize.set(setup.quality === 'slow' ? 2048 : 1024, setup.quality === 'slow' ? 2048 : 1024);
    this.tracer.synchronizeRenderSize = true;
    this.useDenoise = setup.denoise;
    this.onProgress({ samples: 0, target: q.samples, elapsed: 0, eta: 0, done: false, stage: 'Building BVH…' });
    await new Promise((r) => setTimeout(r, 10));
    // synchronous BVH build: no worker bundling needed, so it behaves the same in Electron (file://) and the web
    this.tracer.setScene(built.scene, built.camera);
    this.target = q.samples;
    this.start = performance.now();
    this.stopped = false;
    const loop = () => {
      if (this.stopped) return;
      this.tracer.renderSample();
      const s = Math.floor(this.tracer.samples), el = (performance.now() - this.start) / 1000;
      if (this.meter && (s === 4 || s === 32)) this.autoExpose();
      const done = s >= this.target;
      this.onProgress({ samples: s, target: this.target, elapsed: el, eta: s > 0 ? (el / s) * Math.max(0, this.target - s) : 0, done, stage: done ? 'Done' : 'Path tracing' });
      if (done) { this.stopped = true; return; }
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
    return built;
  }

  /**
   * Metered exposure, like a camera's centre-weighted meter: log-average luminance of the product's
   * screen area (bright bulbs and dark corners don't dominate), mapped to 18 % grey, plus compensation.
   */
  private autoExpose() {
    const b = this.built, t = this.tracer.target;
    if (!b || !this.meter || !t) return;
    const w = t.width, h = t.height;
    const px = new Float32Array(w * h * 4);
    try { this.renderer.readRenderTargetPixels(t, 0, 0, w, h, px); } catch { return; }
    const corners = [0, 1].flatMap((x) => [0, 1].flatMap((y) => [0, 1].map((z) => new THREE.Vector3(x ? b.productBox.max.x : b.productBox.min.x, y ? b.productBox.max.y : b.productBox.min.y, z ? b.productBox.max.z : b.productBox.min.z).project(b.camera))));
    const x0 = Math.max(0, Math.floor(((Math.min(...corners.map((c) => c.x)) + 1) / 2) * w)), x1 = Math.min(w, Math.ceil(((Math.max(...corners.map((c) => c.x)) + 1) / 2) * w));
    const y0 = Math.max(0, Math.floor(((Math.min(...corners.map((c) => c.y)) + 1) / 2) * h)), y1 = Math.min(h, Math.ceil(((Math.max(...corners.map((c) => c.y)) + 1) / 2) * h));
    // highlights of the whole frame: the brightest 1 % lands on the tone curve's shoulder, not past it
    const all: number[] = [];
    const gstep = Math.max(1, Math.floor(Math.sqrt((w * h) / 20000)));
    for (let y = 0; y < h; y += gstep) for (let x = 0; x < w; x += gstep) {
      const i = (y * w + x) * 4, a = px[i + 3] || 1;
      const L = (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) / a;
      if (Number.isFinite(L)) all.push(L);
    }
    all.sort((p, q) => p - q);
    const p99 = all.length ? all[Math.floor(all.length * 0.99)] : 0;
    let sum = 0, n = 0;
    const step = Math.max(1, Math.floor(Math.sqrt(((x1 - x0) * (y1 - y0)) / 20000)));
    for (let y = y0; y < y1; y += step) for (let x = x0; x < x1; x += step) {
      const i = (y * w + x) * 4, a = px[i + 3] || 1;
      const L = (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) / a;
      if (!Number.isFinite(L)) continue;
      sum += Math.log(Math.max(1e-4, L)); n++;
    }
    if (!n) return;
    const avg = Math.exp(sum / n);
    const key = 0.18 / Math.max(1e-4, avg), cap = p99 > 0 ? 2 / p99 : Infinity;
    this.renderer.toneMappingExposure = Math.min(key, cap) * Math.pow(2, this.meter.comp);
  }

  /** Render and resolve once the quality preset's samples are reached (used by batch export). */
  get lost() { return this.contextLost; }

  renderToCompletion(src: RenexSceneSource, setup: RenderSetup, onProgress?: (p: RenderProgress) => void): Promise<BuiltScene> {
    return new Promise((resolve, reject) => {
      this.onLostHandlers.push((why) => reject(new Error(why)));
      let built: BuiltScene | null = null, done = false;
      this.onProgress = (p) => { onProgress?.(p); if (p.done && !done) { done = true; if (built) resolve(built); } };
      this.render(src, setup).then((b) => { built = b; if (done) resolve(b); }, reject);
    });
  }

  stop() { this.stopped = true; cancelAnimationFrame(this.raf); }
  get running() { return !this.stopped; }

  /** Continue sampling past the preset (refine). */
  more(extra: number) { if (!this.built) return; this.target += extra; if (this.stopped) { this.stopped = false; const loop = () => { if (this.stopped) return; this.tracer.renderSample(); const s = Math.floor(this.tracer.samples); const el = (performance.now() - this.start) / 1000; const done = s >= this.target; this.onProgress({ samples: s, target: this.target, elapsed: el, eta: s ? (el / s) * Math.max(0, this.target - s) : 0, done, stage: done ? 'Done' : 'Path tracing' }); if (done) { this.stopped = true; return; } this.raf = requestAnimationFrame(loop); }; this.raf = requestAnimationFrame(loop); } }

  /** Encode the current path-traced image (with optional watermark) with the render disclosure in its metadata. */
  exportImage(setup: RenderSetup, info: DisclosureInfo) { return encodeCanvas(this.canvas, setup, info); }

  private disposeScene() {
    if (!this.built) return;
    this.built.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      const mats = (Array.isArray(m.material) ? m.material : m.material ? [m.material] : []) as THREE.Material[];
      for (const mat of mats) {
        for (const v of Object.values(mat)) if (v && (v as THREE.Texture).isTexture) (v as THREE.Texture).dispose();
        mat.dispose();
      }
    });
    (this.built.scene.environment as THREE.Texture | null)?.dispose();
    this.built = null;
  }

  /** Free every GPU resource and the WebGL context itself (browsers cap live contexts at ~16). */
  dispose() { this.stop(); this.disposeScene(); this.tracer.dispose(); this.denoise.dispose(); this.renderer.dispose(); this.renderer.forceContextLoss(); }
}

/** Encode any canvas (path-traced or live view) as PNG/JPEG, optional watermark, disclosure metadata. */
export async function encodeCanvas(src: HTMLCanvasElement, setup: RenderSetup, info: DisclosureInfo): Promise<{ blob: Blob; bytes: Uint8Array; name: string }> {
  const out = document.createElement('canvas');
  out.width = src.width; out.height = src.height;
  const ctx = out.getContext('2d')!;
  if (setup.format === 'jpeg') { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, out.width, out.height); }
  ctx.drawImage(src, 0, 0);
  if (setup.watermark.enabled && setup.watermark.text.trim()) drawWatermark(ctx, out.width, out.height, setup.watermark);
  const type = setup.format === 'jpeg' ? 'image/jpeg' : 'image/png';
  const raw = await new Promise<Blob>((res, rej) => out.toBlob((b) => (b ? res(b) : rej(new Error('Could not encode the image'))), type, setup.jpegQuality));
  const bytes = tagImage(new Uint8Array(await raw.arrayBuffer()), info);
  const safe = (info.title || 'render').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').toLowerCase();
  return { blob: new Blob([bytes], { type }), bytes, name: `${safe}-renex.${setup.format === 'jpeg' ? 'jpg' : 'png'}` };
}

export function drawWatermark(ctx: CanvasRenderingContext2D, w: number, h: number, wm: RenderSetup['watermark']) {
  const size = Math.round(Math.min(w, h) * 0.022 * wm.size);
  ctx.save();
  ctx.globalAlpha = wm.opacity;
  ctx.font = `500 ${size}px Inter, system-ui, sans-serif`;
  ctx.fillStyle = '#ffffff';
  ctx.shadowColor = 'rgba(0,0,0,0.45)'; ctx.shadowBlur = size * 0.4;
  const m = size * 1.2;
  ctx.textAlign = wm.corner.endsWith('r') ? 'right' : 'left';
  ctx.textBaseline = wm.corner.startsWith('b') ? 'bottom' : 'top';
  ctx.fillText(wm.text, wm.corner.endsWith('r') ? w - m : m, wm.corner.startsWith('b') ? h - m : m);
  ctx.restore();
}
