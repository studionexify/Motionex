// 3D view of the sliced print for the Select window: every printed line as a thin line, orbit / pan / zoom like
// the build plate, a cutaway that hides everything above a height, and picking of single lines on the CPU
// (nearest line to the mouse ray, front-most first).
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { MOVE_STRIDE } from '../../../engine/gcode';
import { FEATURE_ORDER, type FeatureType, type SliceOutput } from '../../../engine/types';
import { FEATURE_COLORS } from '../../../viewport/toolpaths';

export interface Segs {
  /** Per segment: start xyz, end xyz. */
  pos: Float32Array;
  /** Per segment: move index, layer index. */
  move: Uint32Array;
  layer: Uint32Array;
  feature: Uint8Array;
  tool: Uint8Array;
  count: number;
}

const TRAVEL = FEATURE_ORDER.indexOf('travel');
const SKIP = new Set(['travel', 'skirt', 'brim', 'prime_tower'].map((f) => FEATURE_ORDER.indexOf(f as FeatureType)));

/** Printed segments of a slice (travels, skirt, brim and the prime tower left out). */
export function segmentsOf(r: SliceOutput): Segs {
  const n = r.moves.length / MOVE_STRIDE;
  const layerOf = new Uint32Array(n);
  r.layers.forEach((L, li) => { for (let k = L.moveStart; k < L.moveEnd; k++) layerOf[k] = li; });
  let count = 0;
  for (let k = 1; k < n; k++) if (!SKIP.has(r.moveFeatures[k])) count++;
  const pos = new Float32Array(count * 6), move = new Uint32Array(count), layer = new Uint32Array(count), feature = new Uint8Array(count), tool = new Uint8Array(count);
  let s = 0;
  for (let k = 1; k < n; k++) {
    const f = r.moveFeatures[k];
    if (SKIP.has(f)) continue;
    const a = (k - 1) * MOVE_STRIDE, b = k * MOVE_STRIDE;
    pos[s * 6] = r.moves[a]; pos[s * 6 + 1] = r.moves[a + 1]; pos[s * 6 + 2] = r.moves[b + 2];
    pos[s * 6 + 3] = r.moves[b]; pos[s * 6 + 4] = r.moves[b + 1]; pos[s * 6 + 5] = r.moves[b + 2];
    move[s] = k; layer[s] = layerOf[k]; feature[s] = f; tool[s] = r.moves[b + 7];
    s++;
  }
  return { pos, move, layer, feature, tool, count };
}

/** The whole printed line a segment belongs to: neighbouring moves of the same feature with no travel between. */
export function runOf(r: SliceOutput, move: number): { from: number; to: number } {
  const f = r.moveFeatures[move];
  const L = r.layers.find((l) => move >= l.moveStart && move < l.moveEnd);
  const lo = L?.moveStart ?? 0, hi = (L?.moveEnd ?? r.moveFeatures.length) - 1;
  let from = move, to = move;
  while (from - 1 >= lo && r.moveFeatures[from - 1] === f) from--;
  while (to + 1 <= hi && r.moveFeatures[to + 1] === f) to++;
  return { from, to };
}

export const featureName = (f: number) => FEATURE_ORDER[f] as FeatureType;
export const isTravel = (f: number) => f === TRAVEL;

export class SelectView {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly persp = new THREE.PerspectiveCamera(40, 1, 0.1, 5000);
  readonly ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 5000);
  camera: THREE.PerspectiveCamera | THREE.OrthographicCamera = this.persp;
  /** Called after each frame with the camera's world-to-view matrix (for the view cube). */
  readonly cameraListeners = new Set<(m: ArrayLike<number>) => void>();
  /** Called when the view switches between orthographic and perspective. */
  onProjection: ((ortho: boolean) => void) | null = null;
  /** Per segment: 1 = drawn and pickable. Null = all. */
  private shown: Uint8Array | null = null;
  private dots: THREE.Points | null = null;
  /** Per segment: 1 = drawn over by the draft (still pickable, not drawn). */
  private covered: Uint8Array | null = null;
  private draft: THREE.LineSegments | null = null;
  readonly controls: OrbitControls;
  private lines: THREE.LineSegments | null = null;
  private colors: Float32Array | null = null;
  private cut = new THREE.Plane(new THREE.Vector3(0, 0, -1), 1e4);
  private brush = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), new THREE.MeshBasicMaterial({ color: 0xff3d7f, transparent: true, opacity: 0.25, depthWrite: false }));
  segs: Segs | null = null;
  private raf = 0;
  private ro: ResizeObserver;

  constructor(private host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.localClippingEnabled = true;
    host.appendChild(this.renderer.domElement);
    this.persp.up.set(0, 0, 1);
    this.ortho.up.set(0, 0, 1);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.zoomToCursor = true;
    this.brush.visible = false;
    this.scene.add(this.brush);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.resize();
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
      if (this.cameraListeners.size) { this.camera.updateMatrixWorld(); for (const l of this.cameraListeners) l(this.camera.matrixWorldInverse.elements); }
    };
    loop();
  }

  setBackground(css: string) { this.scene.background = new THREE.Color(css); }

  private resize() {
    const w = this.host.clientWidth || 1, h = this.host.clientHeight || 1;
    this.renderer.setSize(w, h);
    this.persp.aspect = w / h;
    this.persp.updateProjectionMatrix();
    this.fitOrthoFrustum();
  }

  /** The orthographic frustum keeps its height (zoom 1) and follows the canvas shape. */
  private fitOrthoFrustum(halfH = this.ortho.top) {
    const a = (this.host.clientWidth || 1) / (this.host.clientHeight || 1);
    Object.assign(this.ortho, { top: halfH, bottom: -halfH, left: -halfH * a, right: halfH * a });
    this.ortho.updateProjectionMatrix();
  }

  get isOrtho() { return this.camera === this.ortho; }

  /** Switch between an orthographic view (true sizes, no vanishing) and a perspective one; the framing stays the same. */
  setOrtho(on: boolean) {
    if (on === this.isOrtho) return;
    const t = this.controls.target, from = this.camera, to = on ? this.ortho : this.persp;
    const dir = from.position.clone().sub(t).normalize(), half = Math.tan(THREE.MathUtils.degToRad(this.persp.fov) / 2);
    if (on) {
      const d = this.persp.position.distanceTo(t);
      this.ortho.zoom = 1;
      this.fitOrthoFrustum(d * half);
      this.ortho.position.copy(t).addScaledVector(dir, d);
    } else {
      const d = this.ortho.top / this.ortho.zoom / half;
      this.persp.position.copy(t).addScaledVector(dir, d);
    }
    to.near = from.near; to.far = from.far;
    to.updateProjectionMatrix();
    this.camera = to;
    this.controls.object = to;
    this.controls.update();
    this.onProjection?.(on);
  }

  /** Turn the view about the target: azimuth round the up axis, then tilt (radians), as when dragging the view cube. */
  orbit(dAz: number, dPolar: number) {
    const c = this.camera, t = this.controls.target, off = c.position.clone().sub(t);
    off.applyAxisAngle(new THREE.Vector3(0, 0, 1), dAz);
    const right = new THREE.Vector3().crossVectors(off, new THREE.Vector3(0, 0, 1)).normalize();
    const tilted = off.clone().applyAxisAngle(right, dPolar);
    const polar = Math.acos(THREE.MathUtils.clamp(tilted.z / tilted.length(), -1, 1));
    if (polar > 0.01 && polar < Math.PI - 0.01) off.copy(tilted);
    c.position.copy(t).add(off);
    c.lookAt(t);
  }

  /** Left button picks (true) or orbits (false); the right button orbits and the middle one pans while picking. */
  setPickMode(pick: boolean) {
    this.controls.mouseButtons = pick
      ? { LEFT: -1 as unknown as THREE.MOUSE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE }
      : { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
  }

  setData(segs: Segs, keepCamera: boolean) {
    this.segs = segs;
    if (this.lines) { this.scene.remove(this.lines); this.lines.geometry.dispose(); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(segs.pos, 3));
    this.colors = new Float32Array(segs.count * 6);
    g.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
    const m = new THREE.LineBasicMaterial({ vertexColors: true, clippingPlanes: [this.cut] });
    this.lines = new THREE.LineSegments(g, m);
    this.shown = null;
    this.covered = null;
    this.scene.add(this.lines);
    g.computeBoundingBox();
    if (!keepCamera && g.boundingBox) this.frame(g.boundingBox);
  }

  frame(b: THREE.Box3 = this.lines?.geometry.boundingBox ?? new THREE.Box3()) {
    const c = b.getCenter(new THREE.Vector3()), size = b.getSize(new THREE.Vector3());
    const r = Math.max(size.x, size.y, size.z, 5);
    this.controls.target.copy(c);
    for (const cam of [this.persp, this.ortho]) { cam.position.set(c.x, c.y - r * 2.2, c.z + r * 0.35); cam.near = r / 200; cam.far = r * 50; }
    this.ortho.zoom = 1;
    this.fitOrthoFrustum(r * 2.2 * Math.tan(THREE.MathUtils.degToRad(this.persp.fov) / 2));
    this.persp.updateProjectionMatrix();
  }

  /** Views from a side. `square`: straight on (for the orthographic face views); otherwise a little from above. */
  look(side: 'front' | 'right' | 'back' | 'left' | 'top' | 'bottom', square = this.isOrtho) {
    const t = this.controls.target, d = this.camera.position.distanceTo(t), z = square ? 0 : 0.15;
    const v = { front: [0, -1, z], right: [1, 0, z], back: [0, 1, z], left: [-1, 0, z], top: [0, -0.001, 1], bottom: [0, -0.001, -1] }[side];
    const l = Math.hypot(v[0], v[1], v[2]);
    this.camera.position.set(t.x + (v[0] / l) * d, t.y + (v[1] / l) * d, t.z + (v[2] / l) * d);
    this.camera.lookAt(t);
  }

  /** Pauses (blobs) as dots: x, y, z, seconds; a longer pause makes a bigger dot. */
  setPauses(p: Float32Array | undefined, rgb: [number, number, number]) {
    if (this.dots) { this.scene.remove(this.dots); this.dots.geometry.dispose(); (this.dots.material as THREE.Material).dispose(); this.dots = null; }
    if (!p?.length) return;
    const n = p.length / 4, pos = new Float32Array(n * 3);
    for (let k = 0; k < n; k++) { pos[k * 3] = p[k * 4]; pos[k * 3 + 1] = p[k * 4 + 1]; pos[k * 3 + 2] = p[k * 4 + 2]; }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const m = new THREE.PointsMaterial({ color: new THREE.Color(...rgb), size: 7, sizeAttenuation: false, clippingPlanes: [this.cut] });
    this.dots = new THREE.Points(g, m);
    this.scene.add(this.dots);
  }

  /** Draw (and pick) only the segments with mask 1; null shows every segment. */
  setShown(mask: Uint8Array | null) {
    this.shown = mask;
    this.reindex();
  }

  /** Lines a draft is drawn over: not drawn, still picked (they are where the slice has them). */
  setCovered(mask: Uint8Array | null) {
    this.covered = mask;
    this.reindex();
  }

  private reindex() {
    const g = this.lines?.geometry, mask = this.shown, cov = this.covered;
    if (!g || !this.segs) return;
    if (!mask && !cov) { g.setIndex(null); return; }
    const n = this.segs.count, on = (s: number) => (!mask || mask[s]) && (!cov || !cov[s]);
    let k = 0;
    for (let s = 0; s < n; s++) if (on(s)) k++;
    const idx = new Uint32Array(k * 2);
    let j = 0;
    for (let s = 0; s < n; s++) if (on(s)) { idx[j++] = s * 2; idx[j++] = s * 2 + 1; }
    g.setIndex(new THREE.BufferAttribute(idx, 1));
  }

  /** The draft: moved lines (segments, xyz xyz) drawn in one colour over the slice. */
  setDraft(pos: Float32Array | null, rgb: [number, number, number]) {
    if (this.draft) { this.scene.remove(this.draft); this.draft.geometry.dispose(); (this.draft.material as THREE.Material).dispose(); this.draft = null; }
    if (!pos?.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.draft = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: new THREE.Color(...rgb), clippingPlanes: [this.cut] }));
    this.scene.add(this.draft);
  }

  /** Writes per-segment colours (rgb per segment, both ends the same). */
  paint(fill: (seg: number, out: Float32Array, at: number) => void) {
    if (!this.segs || !this.colors || !this.lines) return;
    const c = this.colors;
    for (let s = 0; s < this.segs.count; s++) { fill(s, c, s * 6); c[s * 6 + 3] = c[s * 6]; c[s * 6 + 4] = c[s * 6 + 1]; c[s * 6 + 5] = c[s * 6 + 2]; }
    (this.lines.geometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
  }

  /** Hide every line above z. */
  setCut(z: number) { this.cut.constant = z + 1e-3; }

  showBrush(at: THREE.Vector3 | null, r = 1) {
    this.brush.visible = !!at;
    if (at) { this.brush.position.copy(at); this.brush.scale.setScalar(r); }
  }

  /** The front-most line under the mouse: segment index and the point on it, or null. */
  pick(clientX: number, clientY: number, cutZ: number): { seg: number; point: THREE.Vector3 } | null {
    const segs = this.segs;
    if (!segs) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const o = ray.ray.origin, d = ray.ray.direction;
    // world size of one pixel: grows with distance in perspective, fixed in orthographic
    const ortho = this.isOrtho, pxOrtho = (this.ortho.top - this.ortho.bottom) / this.ortho.zoom / rect.height;
    const pxWorld = (2 * Math.tan(THREE.MathUtils.degToRad(this.persp.fov) / 2)) / rect.height;
    const shown = this.shown;
    const P = segs.pos;
    let best = -1, bestT = Infinity, bx = 0, by = 0, bz = 0;
    for (let s = 0; s < segs.count; s++) {
      const i = s * 6;
      const az = P[i + 2];
      if (az > cutZ + 1e-3 || (shown && !shown[s])) continue;
      const ax = P[i], ay = P[i + 1], ex = P[i + 3] - ax, ey = P[i + 4] - ay, ez = P[i + 5] - az;
      // closest points between the ray and the segment
      const wx = o.x - ax, wy = o.y - ay, wz = o.z - az;
      const b = d.x * ex + d.y * ey + d.z * ez, c = ex * ex + ey * ey + ez * ez;
      const dd = d.x * wx + d.y * wy + d.z * wz, e = ex * wx + ey * wy + ez * wz;
      const den = c - b * b;
      let u = den > 1e-12 ? (e - b * dd) / den : 0;
      u = u < 0 ? 0 : u > 1 ? 1 : u;
      const qx = ax + ex * u, qy = ay + ey * u, qz = az + ez * u;
      const t = (qx - o.x) * d.x + (qy - o.y) * d.y + (qz - o.z) * d.z;
      if (t <= 0 || t > bestT + 0.3) continue;
      const rx = o.x + d.x * t - qx, ry = o.y + d.y * t - qy, rz = o.z + d.z * t - qz;
      const dist2 = rx * rx + ry * ry + rz * rz;
      const tol = Math.max(0.2, 5 * (ortho ? pxOrtho : pxWorld * t));
      if (dist2 > tol * tol) continue;
      // front-most wins; lines at nearly the same depth go to the one nearest the ray
      if (t < bestT - 0.3 || dist2 < 0.01) { best = s; bestT = t; bx = qx; by = qy; bz = qz; }
    }
    return best < 0 ? null : { seg: best, point: new THREE.Vector3(bx, by, bz) };
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.controls.dispose();
    if (this.lines) this.lines.geometry.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

const tmp = new THREE.Color();
/** Feature colour as rgb 0..1. */
export const FEATURE_RGB: [number, number, number][] = FEATURE_ORDER.map((f) => { tmp.set(FEATURE_COLORS[f]); return [tmp.r, tmp.g, tmp.b]; });
export function hexRgb(hex: string): [number, number, number] { tmp.set(hex); return [tmp.r, tmp.g, tmp.b]; }
