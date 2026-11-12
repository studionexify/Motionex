// Slicer camera, written to behave like Bambu Studio / PrusaSlicer:
//  · left drag   — turntable: drag sideways spins round the vertical axis, drag up/down tilts; fixed
//                  0.8° per pixel, the piece follows the mouse, never rolls; from straight above to below.
//  · middle drag — pan (the point under the mouse stays under the mouse)
//  · right drag  — pan
//  · wheel       — zoom towards the mouse in fixed steps
//  · double-click middle / Home on the cube — back to the standard view
// Plus a view cube (bottom right) that turns with the camera; click a face to look from that side.
import * as THREE from 'three';

const DEG = Math.PI / 180;
const PER_PX = 0.8 * DEG;              // rotation per pixel dragged
const ZOOM_STEP = 1.25;                // per wheel notch
const EL_MAX = 89.9 * DEG;

export class SlicerCamera {
  target = new THREE.Vector3();
  dist = 400; az = -60 * DEG; el = 25 * DEG;
  /** In selection-tool mode the left button belongs to the tool: right drag rotates, middle pans. */
  toolMode = false;
  onChange: () => void = () => {};
  private drag: { mode: 'rotate' | 'pan'; x: number; y: number } | null = null;
  private anim = 0;
  constructor(private camera: THREE.PerspectiveCamera, private el0: HTMLElement) {
    camera.up.set(0, 0, 1);
    el0.addEventListener('pointerdown', this.down);
    window.addEventListener('pointermove', this.move);
    window.addEventListener('pointerup', this.up);
    el0.addEventListener('wheel', this.wheel, { passive: false });
    el0.addEventListener('contextmenu', (e) => e.preventDefault());
    el0.addEventListener('auxclick', (e) => { if (e.button === 1) e.preventDefault(); });
    this.apply();
  }
  dispose() {
    this.el0.removeEventListener('pointerdown', this.down);
    window.removeEventListener('pointermove', this.move);
    window.removeEventListener('pointerup', this.up);
    this.el0.removeEventListener('wheel', this.wheel);
  }
  /** Place the camera from target / distance / azimuth / elevation. Up is always world Z: no roll. */
  apply() {
    const c = Math.cos(this.el);
    this.camera.position.set(this.target.x + this.dist * c * Math.cos(this.az), this.target.y + this.dist * c * Math.sin(this.az), this.target.z + this.dist * Math.sin(this.el));
    this.camera.up.set(0, 0, 1);
    this.camera.lookAt(this.target);
    this.camera.updateMatrixWorld();
    this.onChange();
  }
  set(target: THREE.Vector3, dist: number, azDeg: number, elDeg: number) { this.target.copy(target); this.dist = dist; this.az = azDeg * DEG; this.el = elDeg * DEG; this.apply(); }
  /** Smoothly turn to a view (degrees). */
  look(azDeg: number, elDeg: number, ms = 260) {
    cancelAnimationFrame(this.anim);
    const a0 = this.az, e0 = this.el;
    let a1 = azDeg * DEG; const e1 = Math.max(-EL_MAX, Math.min(EL_MAX, elDeg * DEG));
    a1 = a0 + Math.atan2(Math.sin(a1 - a0), Math.cos(a1 - a0));        // shortest way round
    const t0 = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / ms), k = t * t * (3 - 2 * t);
      this.az = a0 + (a1 - a0) * k; this.el = e0 + (e1 - e0) * k; this.apply();
      if (t < 1) this.anim = requestAnimationFrame(step);
    };
    this.anim = requestAnimationFrame(step);
  }

  private down = (e: PointerEvent) => {
    let mode: 'rotate' | 'pan' | null = null;
    if (e.button === 0) mode = this.toolMode ? null : 'rotate';
    else if (e.button === 1) mode = 'pan';
    else if (e.button === 2) mode = this.toolMode ? 'rotate' : 'pan';
    if (!mode) return;
    e.preventDefault();
    cancelAnimationFrame(this.anim);
    this.drag = { mode, x: e.clientX, y: e.clientY };
  };
  private move = (e: PointerEvent) => {
    const d = this.drag; if (!d) return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y; d.x = e.clientX; d.y = e.clientY;
    if (d.mode === 'rotate') {
      this.az -= dx * PER_PX;                                            // piece follows the mouse sideways
      this.el = Math.max(-EL_MAX, Math.min(EL_MAX, this.el + dy * PER_PX)); // drag down: see more of the top
    } else {
      const h = this.el0.clientHeight || 1;
      const perPx = (2 * this.dist * Math.tan((this.camera.fov * DEG) / 2)) / h;
      const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
      const upv = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);
      this.target.addScaledVector(right, -dx * perPx).addScaledVector(upv, dy * perPx);
    }
    this.apply();
  };
  private up = () => { this.drag = null; };
  private wheel = (e: WheelEvent) => {
    e.preventDefault();
    const notches = Math.max(-4, Math.min(4, e.deltaY / (e.deltaMode === 1 ? 3 : 100)));
    const f = Math.pow(ZOOM_STEP, notches);                               // >1 zoom out
    const nd = Math.max(2, Math.min(8000, this.dist * f));
    // zoom towards the mouse: move the target along with the point under the cursor
    const r = this.el0.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    const ray = new THREE.Raycaster(); ray.setFromCamera(ndc, this.camera);
    const toTarget = this.target.clone().sub(this.camera.position);
    const depth = toTarget.dot(ray.ray.direction) || this.dist;
    const p = this.camera.position.clone().addScaledVector(ray.ray.direction, depth);   // point under the cursor at target depth
    this.target.lerp(p, 1 - nd / this.dist);
    this.dist = nd;
    this.apply();
  };
}

/** View cube: CSS 3-D, follows the camera, click a face to look from that side. */
export function viewCube(host: HTMLElement, cam: THREE.PerspectiveCamera, look: (azDeg: number, elDeg: number) => void, home: () => void) {
  const S = 56, half = S / 2;
  const wrap = document.createElement('div'); wrap.className = 'mxs-cube';
  const stage = document.createElement('div'); stage.className = 'mxs-cube-stage';
  wrap.append(stage);
  const faces: { label: string; n: THREE.Vector3; u: THREE.Vector3; v: THREE.Vector3; az: number; el: number }[] = [
    { label: 'Top', n: new THREE.Vector3(0, 0, 1), u: new THREE.Vector3(1, 0, 0), v: new THREE.Vector3(0, -1, 0), az: -90, el: 90 },
    { label: 'Bottom', n: new THREE.Vector3(0, 0, -1), u: new THREE.Vector3(1, 0, 0), v: new THREE.Vector3(0, 1, 0), az: -90, el: -90 },
    { label: 'Front', n: new THREE.Vector3(0, -1, 0), u: new THREE.Vector3(1, 0, 0), v: new THREE.Vector3(0, 0, -1), az: -90, el: 0 },
    { label: 'Back', n: new THREE.Vector3(0, 1, 0), u: new THREE.Vector3(-1, 0, 0), v: new THREE.Vector3(0, 0, -1), az: 90, el: 0 },
    { label: 'Right', n: new THREE.Vector3(1, 0, 0), u: new THREE.Vector3(0, 1, 0), v: new THREE.Vector3(0, 0, -1), az: 0, el: 0 },
    { label: 'Left', n: new THREE.Vector3(-1, 0, 0), u: new THREE.Vector3(0, -1, 0), v: new THREE.Vector3(0, 0, -1), az: 180, el: 0 },
  ];
  const els = faces.map((f) => {
    const d = document.createElement('button'); d.className = 'mxs-cube-face'; d.textContent = f.label; d.title = `${f.label} view`;
    d.style.width = d.style.height = `${S}px`; d.style.left = d.style.top = `${-half}px`;
    d.onclick = () => look(f.az, f.el);
    stage.append(d);
    return d;
  });
  const homeB = document.createElement('button'); homeB.className = 'mxs-cube-home'; homeB.title = 'Standard view'; homeB.setAttribute('aria-label', 'Standard view');
  homeB.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11 12 4l9 7M5 10v10h14V10"/></svg>';
  homeB.onclick = home;
  wrap.append(homeB);
  host.append(wrap);
  const R = new THREE.Matrix4(), Sflip = new THREE.Matrix4().makeScale(1, -1, 1), F = new THREE.Matrix4(), M = new THREE.Matrix4();
  const update = () => {
    R.extractRotation(cam.matrixWorldInverse);
    faces.forEach((f, i) => {
      F.makeBasis(f.u, f.v, f.n).setPosition(f.n.x * half, f.n.y * half, f.n.z * half);
      M.multiplyMatrices(Sflip, R).multiply(F);
      els[i].style.transform = `matrix3d(${M.elements.map((x) => x.toFixed(6)).join(',')})`;
    });
  };
  return { update, el: wrap };
}
