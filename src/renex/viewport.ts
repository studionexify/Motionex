// Renex real-time viewport: the live, interactive view (Cadmio-style). It rasterises the same scene the
// path tracer renders, using
//  • image-based lighting from a prefiltered, mip-mapped environment (PMREM) for instant
//    metal/roughness reflections,
//  • a shadow-mapped key light matched to the environment's main light (softbox / sun / bulb),
//  • ground-truth ambient occlusion (GTAO) in screen space,
//  • on-demand rendering: a frame is drawn only when the camera, scene or settings change.
// It recovers from GPU context loss and never blocks on BVH builds.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js';
import { buildScene, type BuiltScene } from './engine';
import { ENVIRONMENTS, SHOTS, exposureFor, frameCamera } from './scenes';
import { WORLD_PER_MM } from './components';
import type { RenderSetup } from './profiles';
import type { RenexSceneSource } from './source';

const TONE: Record<RenderSetup['toneMap'], THREE.ToneMapping> = { agx: THREE.AgXToneMapping, aces: THREE.ACESFilmicToneMapping, neutral: THREE.NeutralToneMapping };

export interface ViewportEvents {
  /** The user orbited / zoomed: new camera angles to store in the setup (so the final render matches). */
  onCamera?: (c: { az: number; el: number; dolly: number }) => void;
  onStatus?: (s: string) => void;
  onLost?: (lost: boolean) => void;
}

export class RenexViewport {
  readonly canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer;
  private composer: EffectComposer;
  private renderPass: RenderPass;
  private gtao: GTAOPass;
  private controls: OrbitControls;
  private built: BuiltScene | null = null;
  private envRT: THREE.WebGLRenderTarget | null = null;
  private pmrem: THREE.PMREMGenerator;
  private queued = false;
  private lost = false;
  private ro: ResizeObserver;
  private lastArgs: { src: RenexSceneSource; setup: RenderSetup } | null = null;
  private base = { dist: 1, target: new THREE.Vector3() };
  private exposure = 1;
  private suppressCamera = false;

  constructor(private host: HTMLElement, private ev: ViewportEvents = {}) {
    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText = 'width:100%;height:100%;display:block;touch-action:none';
    host.appendChild(this.canvas);
    this.renderer = this.makeRenderer();
    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    this.composer = new EffectComposer(this.renderer);
    this.renderPass = new RenderPass(new THREE.Scene(), new THREE.PerspectiveCamera());
    this.gtao = new GTAOPass(new THREE.Scene(), new THREE.PerspectiveCamera(), 1, 1);
    this.composer.addPass(this.renderPass);
    this.composer.addPass(this.gtao);
    this.composer.addPass(new OutputPass());
    this.controls = new OrbitControls(new THREE.PerspectiveCamera(), this.canvas);
    this.controls.enableDamping = false;
    this.controls.addEventListener('change', () => { this.request(); this.reportCamera(); });
    this.canvas.addEventListener('webglcontextlost', this.onLost, false);
    this.canvas.addEventListener('webglcontextrestored', this.onRestored, false);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    RectAreaLightUniformsLib.init();
  }

  private makeRenderer() {
    const r = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
    r.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    return r;
  }

  private onLost = (e: Event) => { e.preventDefault(); this.lost = true; this.ev.onLost?.(true); this.ev.onStatus?.('Graphics reset by the browser — restoring…'); };
  private onRestored = () => {
    this.lost = false;
    this.ev.onLost?.(false);
    // every GPU object is gone: rebuild the renderer-side state from the last scene
    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    this.envRT = null;
    if (this.lastArgs) this.setScene(this.lastArgs.src, this.lastArgs.setup, false);
  };

  /** Build (or rebuild) the scene. `reframe` re-applies the setup's camera; otherwise the user's orbit is kept. */
  setScene(src: RenexSceneSource, setup: RenderSetup, reframe = true): BuiltScene | null {
    this.lastArgs = { src, setup };
    if (this.lost) return null;
    const t0 = performance.now();
    const w = Math.max(1, this.host.clientWidth), h = Math.max(1, this.host.clientHeight);
    const prevCam = this.built?.camera;
    this.disposeScene();
    let built: BuiltScene;
    try { built = buildScene(src, setup, setup.width / setup.height); } catch (e) { this.ev.onStatus?.(`Scene failed: ${(e as Error).message}`); return null; }
    this.built = built;
    const scene = built.scene;
    // prefiltered environment for IBL; the background stays the sharp equirect
    const equi = scene.environment as THREE.Texture | null;
    if (equi) {
      this.envRT = this.pmrem.fromEquirectangular(equi);
      scene.environment = this.envRT.texture;
    }
    this.prepareForRaster(scene);
    const cam = built.camera;
    if (!reframe && prevCam) { cam.position.copy(prevCam.position); cam.quaternion.copy(prevCam.quaternion); }
    cam.aspect = w / h;
    cam.updateProjectionMatrix();
    this.controls.object = cam;
    const target = new THREE.Vector3();
    cam.getWorldDirection(target).multiplyScalar(cam.focusDistance ?? 1).add(cam.position);
    if (reframe || !prevCam) this.controls.target.copy(target);
    this.base = { dist: cam.position.distanceTo(this.controls.target) / Math.max(0.05, setup.dolly), target: this.controls.target.clone() };
    this.controls.minDistance = this.base.dist * 0.05; this.controls.maxDistance = this.base.dist * 8;
    this.controls.update();
    this.renderPass.scene = scene; this.renderPass.camera = cam;
    this.gtao.scene = scene; this.gtao.camera = cam;
    (this.gtao as unknown as { updateGtaoMaterial?: (p: object) => void }).updateGtaoMaterial?.({ radius: this.base.dist * 0.04, distanceFallOff: 1, thickness: 1 });
    this.renderer.toneMapping = TONE[setup.toneMap];
    this.exposure = exposureFor((ENVIRONMENTS.find((e) => e.id === setup.env)?.ev ?? 9) - setup.evComp);
    this.renderer.toneMappingExposure = this.exposure;
    this.resize();
    if (setup.autoExposure) this.meter(setup.evComp);
    this.request();
    this.ev.onStatus?.(`Live view · ${built.triangles.toLocaleString()} printed triangles · built in ${Math.round(performance.now() - t0)} ms`);
    return built;
  }

  /**
   * Raster stand-ins for what the path tracer does physically: shadow-casting key light (the brightest
   * analytic light, or the bulb), contact shadows on the floor, and transmission kept cheap.
   */
  private prepareForRaster(scene: THREE.Scene) {
    const box = this.built!.productBox, size = box.getSize(new THREE.Vector3()).length();
    let key: THREE.Light | null = null, best = -1;
    scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.castShadow = true; m.receiveShadow = true;
        // the path tracer's "does not block light" flag means: no shadow in raster either
        const mats = (Array.isArray(m.material) ? m.material : [m.material]) as (THREE.Material & { castShadow?: boolean })[];
        if (mats.some((x) => x.castShadow === false)) m.castShadow = false;
      }
      const l = o as THREE.Light;
      if ((l as THREE.DirectionalLight).isDirectionalLight || (l as THREE.PointLight).isPointLight) {
        const score = (l as THREE.PointLight).isPointLight ? 1e9 : l.intensity;
        if (score > best) { best = score; key = l; }
      }
    });
    // RectAreaLights (softboxes) cannot cast raster shadows: add a weak directional shadow caster at the
    // brightest softbox so the product still sits on its contact shadow
    if (!key) {
      let area: THREE.RectAreaLight | null = null, power = 0;
      scene.traverse((o) => { const a = o as THREE.RectAreaLight; if (a.isRectAreaLight && a.intensity * a.width * a.height > power) { area = a; power = a.intensity * a.width * a.height; } });
      if (area) {
        const a = area as THREE.RectAreaLight;
        const caster = new THREE.DirectionalLight(a.color, power * 0.0004);
        caster.position.copy(a.position);
        caster.target.position.copy(box.getCenter(new THREE.Vector3()));
        scene.add(caster, caster.target);
        key = caster;
      }
    }
    if (key) {
      const k = key as THREE.DirectionalLight | THREE.PointLight;
      k.castShadow = true;
      k.shadow.mapSize.set(2048, 2048);
      k.shadow.bias = -0.0004; k.shadow.normalBias = size * 0.002;
      if ((k as THREE.DirectionalLight).isDirectionalLight) {
        const cam = (k as THREE.DirectionalLight).shadow.camera;
        const r = size * 1.5;
        cam.left = -r; cam.right = r; cam.top = r; cam.bottom = -r; cam.near = 0.01; cam.far = size * 400; cam.updateProjectionMatrix();
        (k as THREE.DirectionalLight).shadow.radius = 6;
      } else { (k as THREE.PointLight).shadow.camera.near = 0.01; (k as THREE.PointLight).shadow.camera.far = size * 20; (k as THREE.PointLight).shadow.radius = 4; }
    }
  }

  /** Metered exposure from a small off-screen render (one readback per scene build, not per frame). */
  private meter(comp: number) {
    const b = this.built;
    if (!b) return;
    const rt = new THREE.WebGLRenderTarget(96, 96, { type: THREE.HalfFloatType });
    const tm = this.renderer.toneMapping;
    try {
      this.renderer.toneMapping = THREE.NoToneMapping;
      this.renderer.setRenderTarget(rt);
      this.renderer.render(b.scene, b.camera);
      const px = new Uint16Array(96 * 96 * 4);
      this.renderer.readRenderTargetPixels(rt, 0, 0, 96, 96, px);
      const lum: number[] = [];
      for (let i = 0; i < px.length; i += 4) {
        const L = 0.2126 * THREE.DataUtils.fromHalfFloat(px[i]) + 0.7152 * THREE.DataUtils.fromHalfFloat(px[i + 1]) + 0.0722 * THREE.DataUtils.fromHalfFloat(px[i + 2]);
        if (Number.isFinite(L) && L > 0) lum.push(L);
      }
      if (lum.length) {
        lum.sort((a, c) => a - c);
        let s = 0; for (const L of lum) s += Math.log(L);
        const avg = Math.exp(s / lum.length), p99 = lum[Math.floor(lum.length * 0.99)];
        this.exposure = Math.min(0.18 / avg, 2 / p99) * Math.pow(2, comp);
        this.renderer.toneMappingExposure = this.exposure;
      }
    } catch { /* keep the environment's EV */ } finally {
      this.renderer.setRenderTarget(null);
      this.renderer.toneMapping = tm;
      rt.dispose();
    }
  }

  get currentExposure() { return this.exposure; }

  /** Move the camera to the setup's shot (slider / preset changes) without rebuilding the scene. */
  applyCamera(setup: RenderSetup) {
    const b = this.built;
    if (!b) return;
    const shot = SHOTS.find((x) => x.id === setup.shot);
    this.suppressCamera = true;
    const target = frameCamera(b.camera, b.productBox, { az: setup.az, el: setup.el, focal: setup.focal, fNumber: setup.fNumber, fill: shot?.fill ?? 0.72, dolly: setup.dolly, focusZ: setup.focusZ, blades: setup.blades }, setup.width / setup.height, WORLD_PER_MM);
    const w = Math.max(1, this.host.clientWidth), h = Math.max(1, this.host.clientHeight);
    b.camera.aspect = w / h; b.camera.updateProjectionMatrix();
    this.controls.target.copy(target);
    this.controls.update();
    this.suppressCamera = false;
    this.request();
  }

  private reportCamera() {
    if (this.suppressCamera || !this.built) return;
    const cam = this.built.camera, t = this.controls.target;
    const d = cam.position.clone().sub(t);
    const dist = d.length();
    const el = Math.asin(Math.max(-1, Math.min(1, d.y / dist))) * 180 / Math.PI;
    const az = Math.atan2(d.x, d.z) * 180 / Math.PI;
    this.ev.onCamera?.({ az: Math.round(az), el: Math.round(el), dolly: +(dist / this.base.dist).toFixed(3) });
  }

  /** Draw one frame on the next animation frame (coalesces bursts of changes). */
  request() {
    if (this.queued || this.lost) return;
    this.queued = true;
    requestAnimationFrame(() => { this.queued = false; this.draw(); });
  }

  private draw() {
    if (!this.built || this.lost) return;
    try { this.composer.render(); } catch (e) { this.ev.onStatus?.(`Viewport error: ${(e as Error).message}`); }
  }

  private resize() {
    const w = Math.max(1, this.host.clientWidth), h = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.gtao.setSize(w, h);
    if (this.built) { this.built.camera.aspect = w / h; this.built.camera.updateProjectionMatrix(); }
    this.request();
  }

  /** Real-time export: the live view re-rendered at the output resolution (instant, no path tracing). */
  async snapshot(width: number, height: number): Promise<HTMLCanvasElement> {
    if (!this.built || this.lost) throw new Error('The live view is not ready.');
    const cam = this.built.camera;
    const prevAspect = cam.aspect;
    const max = this.renderer.capabilities.maxTextureSize;
    const s = Math.min(1, max / Math.max(width, height));
    const w = Math.round(width * s), h = Math.round(height * s);
    const pr = this.renderer.getPixelRatio();
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h); this.gtao.setSize(w, h);
    cam.aspect = w / h; cam.updateProjectionMatrix();
    this.composer.render();
    const out = document.createElement('canvas');
    out.width = w; out.height = h;
    out.getContext('2d')!.drawImage(this.canvas, 0, 0, w, h);
    this.renderer.setPixelRatio(pr);
    cam.aspect = prevAspect; cam.updateProjectionMatrix();
    this.resize();
    return out;
  }

  private disposeScene() {
    if (!this.built) return;
    this.built.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      for (const mat of (Array.isArray(m.material) ? m.material : m.material ? [m.material] : []) as THREE.Material[]) mat.dispose();
      const l = o as THREE.DirectionalLight;
      if (l.isLight && l.shadow?.map) l.shadow.map.dispose();
    });
    this.envRT?.dispose(); this.envRT = null;
    this.built = null;
  }

  dispose() {
    this.ro.disconnect();
    this.controls.dispose();
    this.disposeScene();
    this.pmrem.dispose();
    this.composer.dispose();
    this.canvas.removeEventListener('webglcontextlost', this.onLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onRestored);
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.canvas.remove();
  }
}
