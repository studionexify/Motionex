// Toolpath preview on a 2D canvas: orbit (drag), pan (right/shift drag), zoom (wheel / pinch),
// layer range and colour modes. No WebGL needed, so it runs everywhere.
import type { GenResult, Seg } from './generator';

export type ColorBy = 'feature' | 'speed' | 'height' | 'flow';

export class Preview {
  yaw = -0.7; pitch = 0.55; zoom = 1; panX = 0; panY = 0;
  maxLayer = Infinity; showTravel = false; colorBy: ColorBy = 'feature';
  private res: GenResult | null = null;
  private bed: [number, number] = [256, 256];
  private raf = 0;
  private ro: ResizeObserver;
  constructor(private canvas: HTMLCanvasElement) {
    let drag: { x: number; y: number; pan: boolean } | null = null;
    const pts = new Map<number, [number, number]>(); let pinch = 0;
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId); pts.set(e.pointerId, [e.clientX, e.clientY]);
      drag = { x: e.clientX, y: e.clientY, pan: e.button === 2 || e.shiftKey || e.button === 1 };
      if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch = Math.hypot(a[0] - b[0], a[1] - b[1]); }
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!drag) return;
      pts.set(e.pointerId, [e.clientX, e.clientY]);
      if (pts.size === 2) {
        const [a, b] = [...pts.values()]; const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
        if (pinch) this.zoom = Math.min(20, Math.max(0.2, this.zoom * (d / pinch))); pinch = d; this.draw(); return;
      }
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag.x = e.clientX; drag.y = e.clientY;
      if (drag.pan) { this.panX += dx; this.panY += dy; } else { this.yaw += dx * 0.01; this.pitch = Math.min(1.55, Math.max(-0.2, this.pitch + dy * 0.01)); }
      this.draw();
    });
    const up = (e: PointerEvent) => { pts.delete(e.pointerId); if (!pts.size) drag = null; pinch = 0; };
    canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('wheel', (e) => { e.preventDefault(); this.zoom = Math.min(20, Math.max(0.2, this.zoom * Math.exp(-e.deltaY * 0.0015))); this.draw(); }, { passive: false });
    this.ro = new ResizeObserver(() => this.draw()); this.ro.observe(canvas);
  }
  dispose() { this.ro.disconnect(); cancelAnimationFrame(this.raf); }
  set(res: GenResult, bed: [number, number]) { this.res = res; this.bed = bed; this.draw(); }
  view(v: 'iso' | 'top' | 'front') {
    if (v === 'iso') { this.yaw = -0.7; this.pitch = 0.55; }
    if (v === 'top') { this.yaw = 0; this.pitch = 1.55; }
    if (v === 'front') { this.yaw = 0; this.pitch = 0; }
    this.zoom = 1; this.panX = this.panY = 0; this.draw();
  }
  draw() { cancelAnimationFrame(this.raf); this.raf = requestAnimationFrame(() => this.render()); }

  private render() {
    const c = this.canvas, dpr = window.devicePixelRatio || 1;
    const W = c.clientWidth, H = c.clientHeight;
    if (!W || !H) return;
    if (c.width !== Math.round(W * dpr)) c.width = Math.round(W * dpr);
    if (c.height !== Math.round(H * dpr)) c.height = Math.round(H * dpr);
    const g = c.getContext('2d')!; g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(c);
    g.fillStyle = css.getPropertyValue('--wb-stage').trim() || '#14171c'; g.fillRect(0, 0, W, H);
    const res = this.res; if (!res) return;
    // fit the part (not the bed) in view
    let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = 0;
    const startI = res.layerStart[0] ?? 0;
    for (let i = startI; i < res.segs.length; i++) { const s = res.segs[i]; if (s.kind === 'travel') continue; mnx = Math.min(mnx, s.x); mxx = Math.max(mxx, s.x); mny = Math.min(mny, s.y); mxy = Math.max(mxy, s.y); mxz = Math.max(mxz, s.z); }
    if (!isFinite(mnx)) return;
    const ccx = (mnx + mxx) / 2, ccy = (mny + mxy) / 2, ccz = mxz / 2;
    const size = Math.max(mxx - mnx, mxy - mny, mxz, 10);
    const scale = (Math.min(W, H) / size) * 0.62 * this.zoom;
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw), cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const P = (x: number, y: number, z: number): [number, number, number] => {
      x -= ccx; y -= ccy; z -= ccz;
      const rx = x * cy - y * sy, ry = x * sy + y * cy;
      const depth = ry * cp + z * sp;
      return [W / 2 + this.panX + rx * scale, H / 2 + this.panY - (z * cp - ry * sp) * scale, depth];
    };
    // bed grid around the part
    g.strokeStyle = css.getPropertyValue('--wb-grid').trim() || 'rgba(255,255,255,0.07)'; g.lineWidth = 1;
    const gs = 10, gx0 = Math.floor((mnx - 20) / gs) * gs, gx1 = Math.ceil((mxx + 20) / gs) * gs, gy0 = Math.floor((mny - 20) / gs) * gs, gy1 = Math.ceil((mxy + 20) / gs) * gs;
    g.beginPath();
    for (let gx = Math.max(0, gx0); gx <= Math.min(this.bed[0], gx1); gx += gs) { const a = P(gx, Math.max(0, gy0), 0), b = P(gx, Math.min(this.bed[1], gy1), 0); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); }
    for (let gy = Math.max(0, gy0); gy <= Math.min(this.bed[1], gy1); gy += gs) { const a = P(Math.max(0, gx0), gy, 0), b = P(Math.min(this.bed[0], gx1), gy, 0); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); }
    g.stroke();

    const last = this.maxLayer >= res.layers - 1 ? res.segs.length : res.layerStart[this.maxLayer + 1] ?? res.segs.length;
    const top = Math.min(this.maxLayer, res.layers - 1);
    const lineW = Math.max(0.6, Math.min(4, scale * 0.42));
    g.lineCap = 'round';
    // batch by colour bucket for speed, back-to-front by layer is implicit (layers are drawn in order)
    let maxSp = 1, maxFl = 1, minFl = 1;
    for (let i = 0; i < last; i++) { const s = res.segs[i]; if (s.kind !== 'travel') { maxSp = Math.max(maxSp, s.speed); maxFl = Math.max(maxFl, s.flow); minFl = Math.min(minFl, s.flow); } }
    const colour = (s: Seg, isTop: boolean): string => {
      const dim = isTop ? 1 : 0.82;
      if (s.kind === 'travel') return 'rgba(120,160,255,0.35)';
      if (this.colorBy === 'feature') return s.kind === 'motion' ? shade(255, 138, 61, dim) : s.kind === 'base' ? shade(90, 200, 160, dim) : shade(220, 208, 120, dim);
      const t = this.colorBy === 'speed' ? s.speed / maxSp : this.colorBy === 'height' ? s.z / (mxz || 1) : (s.flow - minFl) / ((maxFl - minFl) || 1);
      return ramp(Math.min(1, Math.max(0, t)), dim);
    };
    let curCol = '', curW = 0; g.beginPath();
    const topStart = res.layerStart[top] ?? 0;
    for (let i = 0; i < last; i++) {
      const s = res.segs[i];
      if (s.kind === 'travel' && !this.showTravel) continue;
      const col = colour(s, i >= topStart), w = s.kind === 'travel' ? 1 : lineW;
      if (col !== curCol || w !== curW) { g.stroke(); g.beginPath(); g.strokeStyle = col; g.lineWidth = w; curCol = col; curW = w; }
      const a = P(s.x0, s.y0, s.z0), b = P(s.x, s.y, s.z);
      g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]);
    }
    g.stroke();
  }
}

function shade(r: number, g: number, b: number, k: number) { return `rgb(${Math.round(r * k)},${Math.round(g * k)},${Math.round(b * k)})`; }
function ramp(t: number, k: number) {
  // blue → teal → yellow → orange
  const stops = [[60, 110, 230], [40, 190, 190], [240, 210, 80], [250, 120, 50]];
  const x = t * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(x)), f = x - i;
  const c = stops[i].map((v, j) => v + (stops[i + 1][j] - v) * f);
  return shade(c[0], c[1], c[2], k);
}
