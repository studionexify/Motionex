// Studio 3D view. Built for zero-lag editing: plain Lambert shading, the mesh is updated in place,
// a coarse mesh is drawn while dragging, rendering is on demand only.
// After slicing it shows the print as it will come out: every bead drawn at its real width and height
// (flat ribbons, or round tubes for close-up), with blobs, thin spots and sag from physics.ts.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { makeInner, makeSurface, meshGrid, type Design } from './design';
import type { GenResult } from './generator';
import { DEFECT, type PrintSim } from './physics';

export type ColorBy = 'feature' | 'width' | 'speed' | 'flow' | 'sag' | 'defects' | 'height' | 'rules';
export type PathStyle = 'lines' | 'ribbons' | 'tubes';
export interface Hit { z: number; a: number; r: number }

const TAU = Math.PI * 2;

// Instanced bead: local x along the move (0..1), y across (±0.5 width), z up (-1..0 height, nozzle at top).
const VERT = /* glsl */ `
attribute vec3 iA; attribute vec3 iB; attribute vec2 iWH; attribute vec3 iCol;
attribute vec2 nrm;
uniform float minIdx;
varying vec3 vCol; varying float vShade;
void main() {
  if (float(gl_InstanceID) < minIdx) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec3 dir = iB - iA;
  float L = length(dir);
  vec3 t = L > 1e-6 ? dir / L : vec3(1.0, 0.0, 0.0);
  vec3 side = cross(t, vec3(0.0, 0.0, 1.0));
  side = length(side) > 1e-4 ? normalize(side) : vec3(1.0, 0.0, 0.0);
  vec3 up = normalize(cross(side, t));
  vec3 p = iA + dir * position.x + side * (position.y * iWH.x) + up * ((position.z) * iWH.y);
  vec3 n = normalize(side * nrm.x + up * nrm.y);
  vec3 vn = normalize(normalMatrix * n);
  vShade = 0.42 + 0.58 * abs(dot(vn, normalize(vec3(0.35, 0.55, 0.75))));
  vCol = iCol;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;
const FRAG = /* glsl */ `
varying vec3 vCol; varying float vShade;
void main() { gl_FragColor = vec4(vCol * vShade, 1.0); }`;

function ribbonGeo() {
  // cross section: a vertical blade (sees the wall from the side) + a horizontal blade (seen from above)
  const g = new THREE.InstancedBufferGeometry();
  const P: number[] = [], N: number[] = [], I: number[] = [];
  const quad = (pts: number[][], n: [number, number]) => { const o = P.length / 3; for (const p of pts) { P.push(...p); N.push(...n); } I.push(o, o + 1, o + 2, o, o + 2, o + 3); };
  quad([[0, 0, 0], [1, 0, 0], [1, 0, -1], [0, 0, -1]], [1, 0]);
  quad([[0, -0.5, -0.5], [1, -0.5, -0.5], [1, 0.5, -0.5], [0, 0.5, -0.5]], [0, 1]);
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.setAttribute('nrm', new THREE.Float32BufferAttribute(N, 2)); g.setIndex(I);
  return g;
}
function tubeGeo(sides = 8) {
  const g = new THREE.InstancedBufferGeometry();
  const P: number[] = [], N: number[] = [], I: number[] = [];
  for (let e = 0; e < 2; e++) for (let k = 0; k < sides; k++) { const t = (k / sides) * TAU, c = Math.cos(t), s = Math.sin(t); P.push(e, 0.5 * c, -0.5 + 0.5 * s); N.push(c, s); }
  for (let k = 0; k < sides; k++) { const a = k, b = (k + 1) % sides; I.push(a, sides + a, sides + b, a, sides + b, b); }
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.setAttribute('nrm', new THREE.Float32BufferAttribute(N, 2)); g.setIndex(I);
  return g;
}

export class StudioView {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(35, 1, 1, 5000);
  private controls: OrbitControls;
  private mesh: THREE.Mesh | null = null;
  private meshRows = 0; private meshCols = 0; private meshOpen = false;
  private lines: THREE.LineSegments | null = null;
  private beads: THREE.Mesh | null = null;
  private beadIndex: Int32Array = new Int32Array(0);        // instance -> seg
  private beadLayerStart: Int32Array = new Int32Array(0);   // layer -> first instance
  private grid: THREE.Group = new THREE.Group();
  private result: GenResult | null = null;
  private sim: PrintSim | null = null;
  private design: Design | null = null;
  private surf: ((z: number, th: number) => number) | null = null;
  private bed: [number, number] = [256, 256];
  private height = 100;
  private pending = 0;
  private ro: ResizeObserver;
  private highlight: ((z: number, a: number, r: number) => [number, number, number] | null) | null = null;
  private ruledMask: Uint8Array | null = null;
  showModel = true; showToolpath = false; maxLayer = Infinity; colorBy: ColorBy = 'feature'; style: PathStyle = 'ribbons'; tubeWindow = 40; flip = false;
  pathColors = { wall: '#d9d2bb', motion: '#ff4d0a', base: '#46b98e', inner: '#a9b0bb', top: '#4fa3d9' };
  /** Line kinds drawn and pickable (NexSpiro "Show lines"). */
  visible = { outer: true, inner: true, base: true, top: true };
  /** Rule colours by rule index, for the 'rules' colour mode. */
  ruleColors: string[] = [];
  private kindVisible(k: string) { return k === 'wall' || k === 'motion' ? this.visible.outer : k === 'inner' ? this.visible.inner : k === 'base' ? this.visible.base : k === 'top' ? this.visible.top : true; }

  constructor(private host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(1.5, window.devicePixelRatio || 1));
    host.append(this.renderer.domElement);
    this.renderer.domElement.className = 'mxs-gl';
    // Slicer camera (as in Bambu Studio): turntable round the vertical axis, never rolls or tilts sideways;
    // you can still look from straight above to straight below. Left drag orbits, middle or right drag pans,
    // the wheel zooms towards the cursor.
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = false;
    this.controls.minPolarAngle = 0; this.controls.maxPolarAngle = Math.PI;
    this.controls.zoomToCursor = true; this.controls.screenSpacePanning = true;
    this.controls.rotateSpeed = 0.9; this.controls.zoomSpeed = 1.2;
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };
    this.controls.addEventListener('change', () => this.draw());
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x9a9ea6, 2.1));
    const key = new THREE.DirectionalLight(0xffffff, 1.4); key.position.set(300, -500, 400); this.scene.add(key);
    this.scene.add(this.grid);
    this.camera.up.set(0, 0, 1);
    this.ro = new ResizeObserver(() => this.resize()); this.ro.observe(host);
    this.resize();
  }
  dispose() { this.ro.disconnect(); this.controls.dispose(); this.renderer.dispose(); this.renderer.domElement.remove(); }
  get canvas() { return this.renderer.domElement; }

  private resize() {
    const w = this.host.clientWidth, h = this.host.clientHeight; if (!w || !h) return;
    this.renderer.setSize(w, h, false); this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); this.draw();
  }
  draw() { cancelAnimationFrame(this.pending); this.pending = requestAnimationFrame(() => this.renderer.render(this.scene, this.camera)); }

  /** Selection tools take the left mouse button; right drag still orbits, wheel zooms. */
  setToolMode(on: boolean) {
    this.controls.mouseButtons = on
      ? { LEFT: null as unknown as THREE.MOUSE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE }
      : { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };
  }

  setTheme(dark: boolean) { this.buildGrid(dark); this.draw(); }
  private gridDark = false; private gridSize = 0;
  private buildGrid(dark = this.gridDark) {
    this.gridDark = dark;
    this.grid.clear();
    const size = Math.max(200, Math.ceil(this.gridSize / 100) * 100 + 200);
    const g1 = new THREE.GridHelper(size, size / 10, dark ? 0x2b3038 : 0xd3d8e0, dark ? 0x22262d : 0xe4e7ec);
    g1.rotation.x = Math.PI / 2; this.grid.add(g1);
  }

  // ───────── model mesh
  private baseColor = new THREE.Color('#ece6dc');
  /** Rebuild the piece mesh. quick = coarse mesh for live dragging. */
  setDesign(d: Design, color = '#ece6dc', quick = false) {
    this.design = d;
    const surf = makeSurface(d), inner = makeInner(d); this.surf = surf;
    const { rows, cols } = meshGrid(d, 380_000, quick);
    const G = (rows + 1) * (cols + 1), nV = G * 2 + 1;
    let geo = this.mesh?.geometry as THREE.BufferGeometry | undefined;
    const reuse = !!geo && this.meshRows === rows && this.meshCols === cols && this.meshOpen === d.openBottom;
    const pos = reuse ? (geo!.getAttribute('position').array as Float32Array) : new Float32Array(nV * 3);
    const cosT = new Float32Array(cols + 1), sinT = new Float32Array(cols + 1);
    for (let j = 0; j <= cols; j++) { const th = (j / cols) * TAU; cosT[j] = Math.cos(th); sinT[j] = Math.sin(th); }
    let k = 0;
    for (const f of [surf, inner]) for (let i = 0; i <= rows; i++) {
      const z = (i / rows) * d.height;
      for (let j = 0; j <= cols; j++) { const r = f(z, (j / cols) * TAU); pos[k++] = r * cosT[j]; pos[k++] = r * sinT[j]; pos[k++] = z; }
    }
    pos[k++] = 0; pos[k++] = 0; pos[k++] = 0;
    if (!reuse) {
      const idx = new Uint32Array(rows * cols * 12 + cols * 6 + cols * 6);
      let q = 0;
      for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) {
        const a = i * (cols + 1) + j, b = a + 1, c = a + cols + 1, e = c + 1;
        idx[q++] = a; idx[q++] = b; idx[q++] = e; idx[q++] = a; idx[q++] = e; idx[q++] = c;
        idx[q++] = G + a; idx[q++] = G + e; idx[q++] = G + b; idx[q++] = G + a; idx[q++] = G + c; idx[q++] = G + e;
      }
      const top = rows * (cols + 1);
      for (let j = 0; j < cols; j++) { const o = top + j; idx[q++] = o; idx[q++] = o + 1; idx[q++] = G + o + 1; idx[q++] = o; idx[q++] = G + o + 1; idx[q++] = G + o; }
      if (d.openBottom) for (let j = 0; j < cols; j++) { idx[q++] = j; idx[q++] = G + j + 1; idx[q++] = j + 1; idx[q++] = j; idx[q++] = G + j; idx[q++] = G + j + 1; }
      else { const centre = 2 * G; for (let j = 0; j < cols; j++) { idx[q++] = centre; idx[q++] = j + 1; idx[q++] = j; idx[q++] = centre; idx[q++] = j; idx[q++] = j + 1; } }
      geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(nV * 3).fill(1), 3));
      geo.setIndex(new THREE.BufferAttribute(idx.subarray(0, q), 1));
      if (this.mesh) { this.mesh.geometry.dispose(); this.mesh.geometry = geo; }
      this.meshRows = rows; this.meshCols = cols; this.meshOpen = d.openBottom;
    } else geo!.getAttribute('position').needsUpdate = true;
    geo!.computeVertexNormals();
    geo!.computeBoundingSphere();
    this.baseColor.set(color);
    if (!this.mesh) {
      this.mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: true, side: THREE.DoubleSide }));
      this.scene.add(this.mesh);
    }
    this.mesh.visible = this.showModel;
    this.paintMesh();
    const firstFrame = this.gridSize === 0;
    this.height = d.height; this.gridSize = d.maxDiameter; this.buildGrid();
    if (firstFrame) this.fit();
    this.draw();
  }
  /** Colour the mesh: base colour, mixed with rule colours where a rule applies. */
  setHighlight(fn: ((z: number, a: number, r: number) => [number, number, number] | null) | null) { this.highlight = fn; this.paintMesh(); this.draw(); }
  private paintMesh() {
    if (!this.mesh || !this.design) return;
    const geo = this.mesh.geometry as THREE.BufferGeometry;
    const col = geo.getAttribute('color') as THREE.BufferAttribute, c = col.array as Float32Array;
    const pos = geo.getAttribute('position').array as Float32Array;
    const rows = this.meshRows, cols = this.meshCols, H = this.design.height, base = this.baseColor;
    const fn = this.highlight;
    const G = (rows + 1) * (cols + 1);
    for (let gi = 0; gi < 2; gi++) for (let i = 0; i <= rows; i++) {
      const z = (i / rows) * H;
      for (let j = 0; j <= cols; j++) {
        const v = gi * G + i * (cols + 1) + j, o = v * 3;
        let r = base.r, g = base.g, b = base.b;
        if (fn) { const hc = fn(z, j / cols, Math.hypot(pos[o], pos[o + 1])); if (hc) { r = hc[0]; g = hc[1]; b = hc[2]; } }
        c[o] = r; c[o + 1] = g; c[o + 2] = b;
      }
    }
    const last = 2 * G * 3; c[last] = base.r; c[last + 1] = base.g; c[last + 2] = base.b;
    col.needsUpdate = true;
  }

  fit() {
    const h = this.height, r = this.gridSize / 2;
    const dist = Math.max(h, r * 2) * 2.1;
    this.controls.target.set(0, 0, h * 0.45);
    this.camera.position.set(dist * 0.75, -dist * 0.95, h * 0.45 + dist * 0.42);
    this.camera.up.set(0, 0, 1); this.camera.lookAt(this.controls.target);
    this.controls.update(); this.draw();
  }

  // ───────── picking (analytic ray march against the surface of revolution: fast, no BVH)
  private ray(clientX: number, clientY: number) {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    const rc = new THREE.Raycaster(); rc.setFromCamera(ndc, this.camera); return rc.ray;
  }
  pick(clientX: number, clientY: number): Hit | null {
    if (!this.surf || !this.design) return null;
    const ray = this.ray(clientX, clientY), H = this.design.height, surf = this.surf;
    const o = ray.origin, d = ray.direction;
    const R = this.design.maxDiameter * 0.75 + 20;
    // bounding cylinder interval
    const A = d.x * d.x + d.y * d.y, B = 2 * (o.x * d.x + o.y * d.y), C = o.x * o.x + o.y * o.y - R * R;
    const disc = B * B - 4 * A * C; if (A < 1e-9 || disc < 0) return null;
    const t0 = Math.max(0, (-B - Math.sqrt(disc)) / (2 * A)), t1 = (-B + Math.sqrt(disc)) / (2 * A);
    const f = (t: number) => { const x = o.x + d.x * t, y = o.y + d.y * t, z = o.z + d.z * t; if (z < 0 || z > H) return 1; return Math.hypot(x, y) - surf(z, Math.atan2(y, x)); };
    const steps = 500, dt = (t1 - t0) / steps;
    let prevT = t0, prevF = f(t0);
    for (let i = 1; i <= steps; i++) {
      const t = t0 + i * dt, v = f(t);
      if (prevF > 0 && v <= 0) {
        let lo = prevT, hi = t;
        for (let k = 0; k < 24; k++) { const m = (lo + hi) / 2; if (f(m) > 0) lo = m; else hi = m; }
        const x = o.x + d.x * hi, y = o.y + d.y * hi, z = o.z + d.z * hi;
        return { z, a: ((Math.atan2(y, x) / TAU) + 1) % 1, r: Math.hypot(x, y) };
      }
      prevT = t; prevF = v;
    }
    return null;
  }
  /** Front-facing mesh vertices whose screen position passes `inside` → selected cells per mesh row. */
  selectScreen(inside: (sx: number, sy: number) => boolean) {
    if (!this.mesh || !this.design) return [];
    const geo = this.mesh.geometry as THREE.BufferGeometry;
    const pos = geo.getAttribute('position').array as Float32Array, nrm = geo.getAttribute('normal').array as Float32Array;
    const rect = this.canvas.getBoundingClientRect();
    const v = new THREE.Vector3(), cam = this.camera.position;
    const m = new THREE.Matrix4().multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    const rows = this.meshRows, cols = this.meshCols, H = this.design.height, dz = H / rows / 2;
    const out: { z: number; dz: number; cells: boolean[] }[] = [];
    for (let i = 0; i <= rows; i++) {
      const cells = new Array<boolean>(cols).fill(false); let any = false;
      for (let j = 0; j < cols; j++) {
        const o = (i * (cols + 1) + j) * 3;
        const px = pos[o], py = pos[o + 1], pz = pos[o + 2];
        // front-facing: outward normal points to the camera
        if (nrm[o] * (cam.x - px) + nrm[o + 1] * (cam.y - py) + nrm[o + 2] * (cam.z - pz) <= 0) continue;
        v.set(px, py, pz).applyMatrix4(m);
        if (v.z > 1) continue;
        const sx = rect.left + (v.x * 0.5 + 0.5) * rect.width, sy = rect.top + (-v.y * 0.5 + 0.5) * rect.height;
        if (inside(sx, sy)) { cells[j] = true; any = true; }
      }
      if (any) out.push({ z: (i / rows) * H, dz, cells });
    }
    return out;
  }

  // ───────── toolpath / print preview
  setToolpath(res: GenResult | null, bed: [number, number], sim: PrintSim | null = null) {
    this.result = res; this.sim = sim; this.bed = bed;
    this.ruledMask = null;
    this.rebuildPath();
  }
  setStyle(style: PathStyle) { this.style = style; this.rebuildPath(); }
  recolour() { this.rebuildPath(); }
  private clearPath() {
    if (this.lines) { this.lines.geometry.dispose(); (this.lines.material as THREE.Material).dispose(); this.scene.remove(this.lines); this.lines = null; }
    if (this.beads) { this.beads.geometry.dispose(); (this.beads.material as THREE.Material).dispose(); this.scene.remove(this.beads); this.beads = null; }
  }
  private segColor(i: number, c: THREE.Color, ranges: { sp: number; z: number }) {
    const r = this.result!, s = r.segs[i], sim = this.sim;
    switch (this.colorBy) {
      case 'feature': c.set(this.pathColors[s.kind === 'travel' ? 'inner' : s.kind]); return;
      case 'rules': if (s.rule >= 0 && this.ruleColors[s.rule]) c.set(this.ruleColors[s.rule]); else if (s.kind === 'motion') c.set(this.pathColors.motion); else { c.set(this.pathColors[s.kind === 'travel' ? 'inner' : s.kind]); c.lerp(new THREE.Color('#d4d7dc'), 0.7); } return;
      case 'speed': ramp((sim ? sim.speed[i] : s.speed) / ranges.sp, c); return;
      case 'height': ramp(s.z / ranges.z, c); return;
      case 'width': case 'flow': {
        const q = sim ? sim.ratio[i] : s.flow;
        if (this.colorBy === 'width' && sim) { const w = sim.width[i] / (s.w || 0.5); div(w, c); } else div(q, c);
        return;
      }
      case 'sag': { const d = sim ? sim.droop[i] / Math.max(0.05, s.h) : 0; d <= 0.02 ? c.set('#c9ccd2') : ramp(Math.min(1, 0.25 + d), c); return; }
      case 'defects': {
        const f = sim ? sim.defects[i] : 0;
        c.set(f & DEFECT.starve ? '#7a3cff' : f & DEFECT.blob ? '#e5383b' : f & DEFECT.thin ? '#2f80ed' : f & DEFECT.sag ? '#f2a31b' : '#cfd3d9');
        return;
      }
    }
  }
  private rebuildPath() {
    this.clearPath();
    const res = this.result;
    if (!res) { this.draw(); return; }
    const cx = this.bed[0] / 2, cy = this.bed[1] / 2, sim = this.sim;
    let maxSp = 1, maxZ = 1;
    for (let i = 0; i < res.segs.length; i++) { const s = res.segs[i]; if (s.kind !== 'travel') { maxSp = Math.max(maxSp, sim ? sim.speed[i] : s.speed); maxZ = Math.max(maxZ, s.z); } }
    const ranges = { sp: maxSp, z: maxZ };
    const c = new THREE.Color();
    // Note: the toolpath is in print space; flip it back so it lines up with the model
    const H = this.height, fz = (z: number) => (this.flip ? H - z : z);
    if (this.style === 'lines' || !sim) {
      const n = res.segs.length, pos = new Float32Array(n * 6), col = new Float32Array(n * 6);
      res.segs.forEach((s, i) => {
        if (s.kind === 'travel' || !this.kindVisible(s.kind)) pos.set([s.x - cx, s.y - cy, fz(s.z), s.x - cx, s.y - cy, fz(s.z)], i * 6);
        else { const dr = sim ? sim.droop[i] : 0; pos.set([s.x0 - cx, s.y0 - cy, fz(s.z0 - dr), s.x - cx, s.y - cy, fz(s.z - dr)], i * 6); }
        this.segColor(i, c, ranges);
        col.set([c.r, c.g, c.b, c.r, c.g, c.b], i * 6);
      });
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      this.lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true }));
      this.lines.visible = this.showToolpath;
      this.scene.add(this.lines);
    } else {
      // instanced beads, extrusions only
      let m = 0; for (const s of res.segs) if (s.kind !== 'travel') m++;
      const A = new Float32Array(m * 3), B = new Float32Array(m * 3), WH = new Float32Array(m * 2), COL = new Float32Array(m * 3);
      const index = new Int32Array(m), lstart = new Int32Array(res.layers + 1);
      let k = 0, layer = 0;
      for (let i = 0; i < res.segs.length; i++) {
        while (layer < res.layers && res.layerStart[layer] <= i) lstart[layer++] = k;
        const s = res.segs[i]; if (s.kind === 'travel') continue;
        if (!this.kindVisible(s.kind)) { WH[k * 2] = 0; WH[k * 2 + 1] = 0; index[k++] = i; continue; }
        const dr = sim.droop[i];
        A.set([s.x0 - cx, s.y0 - cy, fz(s.z0 - dr)], k * 3); B.set([s.x - cx, s.y - cy, fz(s.z - dr)], k * 3);
        WH[k * 2] = sim.width[i]; WH[k * 2 + 1] = sim.height[i] * (this.flip ? -1 : 1);
        this.segColor(i, c, ranges); COL.set([c.r, c.g, c.b], k * 3);
        index[k++] = i;
      }
      while (layer <= res.layers) lstart[layer++] = k;
      this.beadIndex = index; this.beadLayerStart = lstart;
      const geo = this.style === 'tubes' ? tubeGeo() : ribbonGeo();
      geo.setAttribute('iA', new THREE.InstancedBufferAttribute(A, 3)); geo.setAttribute('iB', new THREE.InstancedBufferAttribute(B, 3));
      geo.setAttribute('iWH', new THREE.InstancedBufferAttribute(WH, 2)); geo.setAttribute('iCol', new THREE.InstancedBufferAttribute(COL, 3));
      geo.instanceCount = m;
      const mat = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, uniforms: { minIdx: { value: 0 } }, side: THREE.DoubleSide });
      this.beads = new THREE.Mesh(geo, mat);
      this.beads.frustumCulled = false;
      this.beads.visible = this.showToolpath;
      this.scene.add(this.beads);
    }
    this.applyLayer();
  }
  applyLayer() {
    const r = this.result;
    if (!r) { this.draw(); return; }
    const top = Math.min(this.maxLayer, r.layers - 1);
    if (this.lines) { const end = top >= r.layers - 1 ? r.segs.length : r.layerStart[top + 1]; this.lines.geometry.setDrawRange(0, end * 2); }
    if (this.beads) {
      const geo = this.beads.geometry as THREE.InstancedBufferGeometry;
      geo.instanceCount = this.beadLayerStart[top + 1] ?? this.beadIndex.length;
      const lo = this.style === 'tubes' ? Math.max(0, top - this.tubeWindow + 1) : 0;
      (this.beads.material as THREE.ShaderMaterial).uniforms.minIdx.value = this.beadLayerStart[lo] ?? 0;
    }
    this.draw();
  }
  setKindsVisible(v: Partial<StudioView['visible']>) { Object.assign(this.visible, v); this.rebuildPath(); }

  /** Visible extrusion segments within the layer cut, projected to the screen. */
  private projected(): { i: number; sx: number; sy: number; depth: number }[] {
    const r = this.result; if (!r || !this.showToolpath) return [];
    const rect = this.canvas.getBoundingClientRect();
    const m = new THREE.Matrix4().multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    const v = new THREE.Vector3(), cx = this.bed[0] / 2, cy = this.bed[1] / 2, H = this.height;
    const top = Math.min(this.maxLayer, r.layers - 1), end = top >= r.layers - 1 ? r.segs.length : r.layerStart[top + 1];
    const out: { i: number; sx: number; sy: number; depth: number }[] = [];
    for (let i = 0; i < end; i++) {
      const s = r.segs[i]; if (s.kind === 'travel' || !this.kindVisible(s.kind)) continue;
      const z = (s.z + s.z0) / 2;
      v.set((s.x + s.x0) / 2 - cx, (s.y + s.y0) / 2 - cy, this.flip ? H - z : z).applyMatrix4(m);
      if (v.z > 1 || v.z < -1) continue;
      out.push({ i, sx: rect.left + (v.x * 0.5 + 0.5) * rect.width, sy: rect.top + (-v.y * 0.5 + 0.5) * rect.height, depth: v.z });
    }
    return out;
  }
  /** Nearest printed line under the pointer (front-most among close ones). */
  pickSeg(clientX: number, clientY: number, radius = 9): number {
    const pts = this.projected(); let best = -1, bd = Infinity;
    for (const p of pts) { const d = Math.hypot(p.sx - clientX, p.sy - clientY); if (d > radius) continue; const score = p.depth * 1000 + d * 0.02; if (score < bd) { bd = score; best = p.i; } }
    return best;
  }
  /** Printed lines whose middle is inside a screen region (front and back: like NexSpiro, hidden kinds are skipped). */
  selectSegs(inside: (sx: number, sy: number) => boolean): number[] { return this.projected().filter((p) => inside(p.sx, p.sy)).map((p) => p.i); }
  get toolpath() { return this.result; }
  get pathOn() { return !!this.result && this.showToolpath; }

  setVisibility(model: boolean, toolpath: boolean) {
    this.showModel = model; this.showToolpath = toolpath;
    if (this.mesh) { this.mesh.visible = model; const mt = this.mesh.material as THREE.MeshLambertMaterial; mt.transparent = model && toolpath; mt.opacity = model && toolpath ? 0.22 : 1; mt.depthWrite = !(model && toolpath); mt.needsUpdate = true; }
    if (this.lines) this.lines.visible = toolpath;
    if (this.beads) this.beads.visible = toolpath;
    this.draw();
  }
  snapshot(): string { this.renderer.render(this.scene, this.camera); return this.renderer.domElement.toDataURL('image/png'); }
}

function ramp(t: number, c: THREE.Color) {
  t = Math.min(1, Math.max(0, t));
  const stops = [[60, 110, 230], [40, 190, 190], [240, 210, 80], [250, 120, 50]];
  const x = t * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(x)), f = x - i;
  c.setRGB(...(stops[i].map((v, j) => (v + (stops[i + 1][j] - v) * f) / 255) as [number, number, number]));
}
/** Diverging: blue (less material) · grey (as planned) · red (more). */
function div(q: number, c: THREE.Color) {
  const t = Math.max(-1, Math.min(1, (q - 1) / 0.4));
  const g = [0.8, 0.81, 0.84];
  const to = t < 0 ? [0.18, 0.5, 0.93] : [0.9, 0.22, 0.23];
  const k = Math.abs(t);
  c.setRGB(g[0] + (to[0] - g[0]) * k, g[1] + (to[1] - g[1]) * k, g[2] + (to[2] - g[2]) * k);
}
