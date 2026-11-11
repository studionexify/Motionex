// Studio 3D view: the designed piece as a lit mesh, and (after slicing) the toolpath as coloured lines.
// Renders on demand only (no idle loop).
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { makeSurface, type Design } from './design';
import type { GenResult } from './generator';

export type ColorBy = 'feature' | 'speed' | 'height' | 'flow';

export class StudioView {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(35, 1, 1, 5000);
  private controls: OrbitControls;
  private mesh: THREE.Mesh | null = null;
  private lines: THREE.LineSegments | null = null;
  private grid: THREE.Group = new THREE.Group();
  private result: GenResult | null = null;
  private height = 100;
  private pending = 0;
  private ro: ResizeObserver;
  showModel = true; showToolpath = false; maxLayer = Infinity; colorBy: ColorBy = 'feature'; showTravel = false;

  constructor(private host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    host.append(this.renderer.domElement);
    this.renderer.domElement.className = 'mxs-gl';
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = false;
    this.controls.addEventListener('change', () => this.draw());
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0xb4b8bf, 1.9));
    const key = new THREE.DirectionalLight(0xffffff, 1.8); key.position.set(300, 500, 400); this.scene.add(key);
    const rim = new THREE.DirectionalLight(0xffffff, 0.6); rim.position.set(-400, 200, -300); this.scene.add(rim);
    this.scene.add(this.grid);
    this.camera.up.set(0, 0, 1);
    this.ro = new ResizeObserver(() => this.resize()); this.ro.observe(host);
    this.resize();
  }
  dispose() { this.ro.disconnect(); this.controls.dispose(); this.renderer.dispose(); this.renderer.domElement.remove(); }

  private resize() {
    const w = this.host.clientWidth, h = this.host.clientHeight; if (!w || !h) return;
    this.renderer.setSize(w, h, false); this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); this.draw();
  }
  draw() { cancelAnimationFrame(this.pending); this.pending = requestAnimationFrame(() => this.renderer.render(this.scene, this.camera)); }

  setTheme(dark: boolean) { this.buildGrid(dark); this.draw(); }
  private gridDark = false; private gridSize = 0;
  private buildGrid(dark = this.gridDark) {
    this.gridDark = dark;
    this.grid.clear();
    const size = Math.max(200, Math.ceil(this.gridSize / 100) * 100 + 200);
    const g1 = new THREE.GridHelper(size, size / 10, dark ? 0x2b3038 : 0xd3d8e0, dark ? 0x22262d : 0xe4e7ec);
    g1.rotation.x = Math.PI / 2; this.grid.add(g1);
  }

  /** Rebuild the piece mesh from the design. */
  setDesign(d: Design, color = '#ece6dc') {
    const surf = makeSurface(d);
    const rows = Math.min(320, Math.max(60, Math.round(d.height / 0.8)));
    const reliefCols = d.relief.kind === 'smooth' ? 0 : d.relief.count * 8;
    const secCols = d.section === 'round' ? 0 : d.sides * 16;
    const cols = Math.min(720, Math.max(160, reliefCols, secCols));
    const pos = new Float32Array((rows + 1) * (cols + 1) * 3 + (cols + 2) * 3);
    let k = 0;
    for (let i = 0; i <= rows; i++) {
      const z = (i / rows) * d.height;
      for (let j = 0; j <= cols; j++) { const th = (j / cols) * Math.PI * 2, r = surf(z, th); pos[k++] = r * Math.cos(th); pos[k++] = r * Math.sin(th); pos[k++] = z; }
    }
    const idx: number[] = [];
    for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) {
      const a = i * (cols + 1) + j, b = a + 1, c = a + cols + 1, e = c + 1;
      idx.push(a, b, e, a, e, c);
    }
    if (!d.openBottom) {
      const centre = (rows + 1) * (cols + 1); pos[k++] = 0; pos[k++] = 0; pos[k++] = 0;
      for (let j = 0; j < cols; j++) idx.push(centre, j, j + 1);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geo.setIndex(idx); geo.computeVertexNormals();
    if (this.mesh) { this.mesh.geometry.dispose(); (this.mesh.material as THREE.Material).dispose(); this.scene.remove(this.mesh); }
    this.mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color, roughness: 0.62, metalness: 0, side: THREE.DoubleSide }));
    this.mesh.visible = this.showModel;
    this.scene.add(this.mesh);
    const firstFrame = this.gridSize === 0;
    this.height = d.height; this.gridSize = d.maxDiameter; this.buildGrid();
    if (firstFrame) this.fit();
    this.draw();
  }

  fit() {
    const h = this.height, r = this.gridSize / 2;
    const dist = Math.max(h, r * 2) * 2.1;
    this.controls.target.set(0, 0, h * 0.45);
    this.camera.position.set(dist * 0.75, -dist * 0.95, h * 0.45 + dist * 0.42);
    this.controls.update(); this.draw();
  }

  /** Show a slice result (centred on the bed origin). Pass null to clear. */
  setToolpath(res: GenResult | null, bed: [number, number]) {
    this.result = res;
    if (this.lines) { this.lines.geometry.dispose(); (this.lines.material as THREE.Material).dispose(); this.scene.remove(this.lines); this.lines = null; }
    if (!res) { this.draw(); return; }
    const n = res.segs.length, pos = new Float32Array(n * 6), col = new Float32Array(n * 6);
    const cx = bed[0] / 2, cy = bed[1] / 2;
    let maxSp = 1, minFl = 1, maxFl = 1, maxZ = 1;
    for (const s of res.segs) if (s.kind !== 'travel') { maxSp = Math.max(maxSp, s.speed); minFl = Math.min(minFl, s.flow); maxFl = Math.max(maxFl, s.flow); maxZ = Math.max(maxZ, s.z); }
    const c = new THREE.Color();
    res.segs.forEach((s, i) => {
      if (s.kind === 'travel' && !this.showTravel) pos.set([s.x - cx, s.y - cy, s.z, s.x - cx, s.y - cy, s.z], i * 6);
      else pos.set([s.x0 - cx, s.y0 - cy, s.z0, s.x - cx, s.y - cy, s.z], i * 6);
      if (s.kind === 'travel') c.set(0x6f8fe8);
      else if (this.colorBy === 'feature') c.set(s.kind === 'motion' ? 0xff7a2f : s.kind === 'base' ? 0x46b98e : 0xd8c46c);
      else { const t = this.colorBy === 'speed' ? s.speed / maxSp : this.colorBy === 'height' ? s.z / maxZ : (s.flow - minFl) / ((maxFl - minFl) || 1); ramp(Math.min(1, Math.max(0, t)), c); }
      col.set([c.r, c.g, c.b, c.r, c.g, c.b], i * 6);
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true }));
    this.lines.visible = this.showToolpath;
    this.scene.add(this.lines);
    this.applyLayer();
  }
  /** Travel moves are hidden by drawing only non-travel segments in range (cheap: recolour handled at build). */
  applyLayer() {
    if (!this.lines || !this.result) { this.draw(); return; }
    const r = this.result, top = Math.min(this.maxLayer, r.layers - 1);
    const end = top >= r.layers - 1 ? r.segs.length : r.layerStart[top + 1];
    this.lines.geometry.setDrawRange(0, end * 2);
    this.draw();
  }
  setVisibility(model: boolean, toolpath: boolean) {
    this.showModel = model; this.showToolpath = toolpath;
    if (this.mesh) { this.mesh.visible = model; (this.mesh.material as THREE.MeshStandardMaterial).transparent = model && toolpath; (this.mesh.material as THREE.MeshStandardMaterial).opacity = model && toolpath ? 0.25 : 1; }
    if (this.lines) this.lines.visible = toolpath;
    this.draw();
  }
  recolour(bed: [number, number]) { if (this.result) { const r = this.result; this.setToolpath(r, bed); } }
  snapshot(): string { this.renderer.render(this.scene, this.camera); return this.renderer.domElement.toDataURL('image/png'); }
}

function ramp(t: number, c: THREE.Color) {
  const stops = [[60, 110, 230], [40, 190, 190], [240, 210, 80], [250, 120, 50]];
  const x = t * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(x)), f = x - i;
  c.setRGB(...(stops[i].map((v, j) => (v + (stops[i + 1][j] - v) * f) / 255) as [number, number, number]));
}
