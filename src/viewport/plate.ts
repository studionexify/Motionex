// Build plates: the real plate outline (back tab, front lip, rounded corners),
// the bed type's colour and print, the 10 mm grid, the plate number and pencil, and the icon column
// beside each plate (remove, auto orient, arrange, lock, settings) lying in the plate plane.
import * as THREE from 'three';
import type { PlateType, PrinterProfile } from '../profiles/printers';
import { ICON_PATHS } from '../ui/icons';

export type PlateAction = 'remove' | 'add' | 'orient' | 'arrange' | 'lock' | 'settings' | 'number' | 'name';
export const ACCENT_GREEN = '#10B981';

interface BedLook { color: string; print: string; strip: string; textured: boolean; ink: string; grid: string }
/** Plate surface colour and the print on it, per bed type: soft light sheets on the light theme, deep greys on dark. */
function bedLook(type: PlateType, isBbl: boolean, label: string, dark: boolean): BedLook {
  const ink = dark ? 'rgba(228,228,231,0.55)' : 'rgba(82,82,91,0.5)';
  const grid = dark ? '#52525B' : '#A1A1AA';
  const sheet = (light: string, deep: string, print: string, strip: string, textured: boolean): BedLook => ({ color: dark ? deep : light, print, strip, textured, ink, grid });
  if (isBbl) {
    switch (type) {
      case 'cool_plate': return sheet('#ECECEE', '#232327', 'Cool Plate', 'PLA', false);
      case 'supertack_plate': return sheet('#ECECEE', '#232327', 'Cool Plate SuperTack', 'PLA/PETG/TPU', false);
      case 'textured_cool_plate': return sheet('#E6E9EE', '#24272C', 'Textured Cool Plate', 'PLA/PETG', true);
      case 'engineering_plate': return sheet('#DEDEE2', '#2A2A30', 'Engineering Plate', 'ABS/ASA/PC/PA', false);
      case 'high_temp_plate': return sheet('#E8E4DC', '#2C2A26', 'Smooth PEI Plate', 'PLA/ABS/PETG', false);
      default: return sheet('#E4E4E7', '#26262B', 'Textured PEI Plate', 'PLA/ABS/PETG', true);
    }
  }
  return type === 'high_temp_plate'
    ? { ...sheet('#E6DCC6', '#3A3224', label, '', false), grid: dark ? '#6B5B3A' : '#A8946A' }
    : sheet('#E4E4E7', '#232327', label, '', true);
}

type V2 = [number, number];
/** Path through the polygon with rounded corners (radius per corner); works on a canvas or a THREE.Shape. */
function roundedPath(p: { moveTo(x: number, y: number): void; lineTo(x: number, y: number): void; quadraticCurveTo(cx: number, cy: number, x: number, y: number): void }, pts: V2[], radii: number[]) {
  const n = pts.length;
  const cut = (a: V2, b: V2, r: number): V2 => { const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy); const t = Math.min(r, l / 2) / l; return [a[0] + dx * t, a[1] + dy * t]; };
  for (let i = 0; i < n; i++) {
    const v = pts[i], prev = pts[(i + n - 1) % n], next = pts[(i + 1) % n];
    const a = cut(v, prev, radii[i]), b = cut(v, next, radii[i]);
    if (i === 0) p.moveTo(a[0], a[1]); else p.lineTo(a[0], a[1]);
    p.quadraticCurveTo(v[0], v[1], b[0], b[1]);
  }
}

type PlateFamily = 'corner-tabs' | 'snapmaker' | 'center-tab' | 'plain';
function plateFamily(id: string): PlateFamily {
  if (id.startsWith('snapmaker')) return 'snapmaker';
  if (id.startsWith('creality') || id.startsWith('elegoo')) return 'corner-tabs';
  if (/^(qidi|sovol|artillery|voron)/.test(id)) return 'center-tab';
  return 'plain';
}

/** Plate outline in plate coordinates (printable area is 0..X, 0..Y). */
function outline(X: number, Y: number, isBbl: boolean, id = ''): { pts: V2[]; radii: number[] } {
  const M = isBbl ? 2 : 3;
  const fam = plateFamily(id);
  if (fam === 'corner-tabs') {
    // magnetic PEI sheet a little larger than the print area, with a pull tab at each front corner (Creality, Elegoo)
    const m = 6, L = -m, R = X + m, B = -m, T = Y + m, tw = Math.min(26, X * 0.12), th = 9;
    return {
      pts: [[L, B - th], [L + tw, B - th], [L + tw + 6, B], [R - tw - 6, B], [R - tw, B - th], [R, B - th], [R, T], [L, T]],
      radii: [4, 3, 3, 3, 3, 4, 6, 6],
    };
  }
  if (fam === 'snapmaker') {
    // Snapmaker U1 PEI sheet: square corners, a wide label lip centred on the front edge,
    // and the back edge split into four tabs by three V notches
    const m = 5, L = -m, R = X + m, B = -m, T = Y + m, W = R - L;
    const lx0 = L + W * 0.226, lx1 = L + W * 0.774, lip = W * 0.04, nw = W * 0.032, nd = W * 0.016;
    const back: V2[] = [];
    for (const f of [0.75, 0.5, 0.25]) { const cx = L + W * f; back.push([cx + nw / 2, T], [cx, T - nd], [cx - nw / 2, T]); }
    return {
      pts: [[L, B], [lx0 - 3, B], [lx0, B - lip], [lx1, B - lip], [lx1 + 3, B], [R, B], [R, T], ...back, [L, T]],
      radii: [2, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2],
    };
  }
  if (fam === 'center-tab') {
    // PEI sheet with one pull tab centred on the front edge (Qidi, Sovol, Artillery, Voron)
    const m = 4, L = -m, R = X + m, B = -m, T = Y + m, cx = X / 2, tw = Math.min(50, X * 0.18), th = 8;
    return {
      pts: [[L, B], [cx - tw / 2 - 5, B], [cx - tw / 2, B - th], [cx + tw / 2, B - th], [cx + tw / 2 + 5, B], [R, B], [R, T], [L, T]],
      radii: [5, 3, 3, 3, 3, 5, 5, 5],
    };
  }
  const L = -M, R = X + M, B = -M, T = Y + M;
  if (!isBbl) return { pts: [[L, B], [R, B], [R, T], [L, T]], radii: [5, 5, 5, 5] };
  const lipX = X * 0.3, lip = 9;
  const cx = X / 2, tw = X * 0.36, tab = 8;
  return {
    pts: [[L, B], [lipX - 6, B], [lipX, B - lip], [R, B - lip], [R, T], [cx + tw / 2, T], [cx + tw / 2 - 5, T + tab], [cx - tw / 2 + 5, T + tab], [cx - tw / 2, T], [L, T]],
    radii: [6, 3, 3, 6, 6, 3, 3, 3, 3, 6],
  };
}

function surfaceTexture(p: PrinterProfile, X: number, Y: number, isBbl: boolean, look: BedLook, box: { x0: number; y0: number; x1: number; y1: number }) {
  const W = box.x1 - box.x0, H = box.y1 - box.y0;
  const k = Math.min(6, 2048 / Math.max(W, H));
  const c = document.createElement('canvas');
  c.width = Math.ceil(W * k); c.height = Math.ceil(H * k);
  const g = c.getContext('2d', { willReadFrequently: true })!;
  // draw in millimetres, y up
  const mm = () => g.setTransform(k, 0, 0, -k, -box.x0 * k, box.y1 * k);
  mm();
  const o = outline(X, Y, isBbl, p.id);
  g.beginPath(); roundedPath(g, o.pts, o.radii); g.closePath();
  g.fillStyle = look.color; g.fill();
  if (look.textured) {
    // fine speckle of a textured PEI sheet, as one pixel pass
    const img = g.getImageData(0, 0, c.width, c.height), d = img.data;
    let seed = 7;
    for (let i = 0; i < d.length; i += 4) {
      if (!d[i + 3]) continue;
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const n = (((seed >> 16) & 31) - 16) / 2;
      d[i] += n; d[i + 1] += n; d[i + 2] += n;
    }
    g.putImageData(img, 0, 0);
  }
  // excluded areas (e.g. the lidar calibration spot) as light grey pads
  for (const area of p.excludedAreas ?? []) {
    g.beginPath(); roundedPath(g, area as V2[], area.map(() => 2)); g.closePath();
    g.fillStyle = look.grid; g.globalAlpha = 0.35; g.fill(); g.globalAlpha = 1;
  }
  const text = (s: string, x: number, y: number, size: number, color: string, rot = 0, font = 'italic 700', align: CanvasTextAlign = 'left') => {
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.translate((x - box.x0) * k, (box.y1 - y) * k);
    g.rotate(rot);
    g.font = `${font} ${size * k}px "Segoe UI", "Arial Narrow", system-ui, sans-serif`;
    g.fillStyle = color; g.textBaseline = 'middle'; g.textAlign = align;
    g.fillText(s, 0, 0);
    g.restore();
  };
  // printer's own plate print in the centre, faint: vendor wordmark over the model name
  {
    const big = Math.min(X, Y) / 9;
    g.save(); g.globalAlpha = 0.5;
    text(plateFamily(p.id) === 'snapmaker' ? p.vendor.toLowerCase() : p.vendor.toUpperCase(), X / 2, Y / 2 + big * 0.35, big, look.ink, 0, '800', 'center');
    text(p.model, X / 2, Y / 2 - big * 0.75, big * 0.45, look.ink, 0, '600', 'center');
    g.restore();
  }
  // bed type printed along the left edge, reading from the back towards the front
  if (plateFamily(p.id) === 'snapmaker') {
    // white slots on the four back tabs, and the label lip: warning triangle, PEI Coated PLATE, material box
    const W = X + 10, L = -5, T = Y + 5;
    g.strokeStyle = 'rgba(255,255,255,0.85)'; g.lineWidth = 1.2; g.lineCap = 'round';
    for (let i = 0; i < 4; i++) { const x0 = L + W * (i * 0.25 + 0.05), x1 = L + W * (i * 0.25 + 0.2); g.beginPath(); g.moveTo(x0, T - 2.2); g.lineTo(x1, T - 2.2); g.stroke(); }
    const ly = -5 - W * 0.02, ls = Math.min(4, X / 70);
    text('⚠  PEI Coated PLATE', X * 0.3, ly, ls, 'rgba(255,255,255,0.9)', 0, '700');
    text('PLA/ABS/PETG/TPU', X * 0.7, ly, ls * 0.8, 'rgba(255,255,255,0.9)', 0, '500', 'right');
    g.strokeStyle = 'rgba(255,255,255,0.8)'; g.lineWidth = 0.4;
    g.strokeRect(X * 0.7 - ls * 9, ly - ls * 0.7, ls * 9.4, ls * 1.4);
  }
  if (look.print && plateFamily(p.id) !== 'snapmaker') text(look.print, 6.5, Y - 8, Math.min(9, X / 26), look.ink, Math.PI / 2);
  if (isBbl) {
    // front lip: material strip with HOT SURFACE warning, and the lip markings
    const sx0 = X * 0.36, sx1 = X * 0.86, sy0 = -2 - 7.6, sy1 = -2 - 1.6;
    g.beginPath(); roundedPath(g, [[sx0, sy0], [sx1, sy0], [sx1, sy1], [sx0, sy1]], [1, 1, 1, 1]); g.closePath();
    g.fillStyle = '#D5D7D7'; g.fill();
    g.fillStyle = '#404343';
    g.fillRect(sx0 + 1.2, sy0 + 1, 3.8, 4); g.fillRect(sx0 + 5.8, sy0 + 1, 3.8, 4);
    text(look.strip, sx0 + 12, (sy0 + sy1) / 2, 3.6, '#5E6262', 0, '400');
    text('HOT SURFACE', sx1 - 2, (sy0 + sy1) / 2, 2.4, '#5E6262', 0, '600', 'right');
    g.strokeStyle = '#5E6262'; g.lineWidth = 0.35;
    const wx = sx1 - 19, wy = (sy0 + sy1) / 2;
    g.beginPath(); g.moveTo(wx - 2.2, wy - 1.8); g.lineTo(wx + 2.2, wy - 1.8); g.lineTo(wx, wy + 2); g.closePath(); g.stroke();
    // small white marks at the right end of the lip
    g.fillStyle = '#E8EAEA';
    g.beginPath(); g.moveTo(X * 0.9, -2 - 7); g.lineTo(X * 0.95, -2 - 7); g.lineTo(X * 0.935, -2 - 2); g.lineTo(X * 0.9, -2 - 2); g.closePath(); g.fill();
    g.beginPath(); g.moveTo(X * 0.955, -2 - 7); g.lineTo(X + 0.5, -2 - 7); g.lineTo(X + 0.5, -2 - 2); g.lineTo(X * 0.94, -2 - 2); g.closePath(); g.fill();
    // handle slot on the back tab
    g.strokeStyle = '#E8EAEA'; g.lineWidth = 1.3; g.lineCap = 'round';
    g.beginPath(); g.moveTo(X / 2 - X * 0.12, Y + 2 + 4.5); g.lineTo(X / 2 + X * 0.12, Y + 2 + 4.5); g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.repeat.set(1 / W, 1 / H);
  tex.offset.set(-box.x0 / W, -box.y0 / H);
  return tex;
}

/** Flat textured quad lying on the bed plane, centred at (x, y). */
function flatQuad(tex: THREE.Texture, w: number, h: number, x: number, y: number, z = 0.05) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
  m.position.set(x, y, z);
  m.renderOrder = 3;
  return m;
}

function canvasTex(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d')!);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** Icon tile: light rounded square with a dark outline icon. state: normal, hover, on (toggled) or off (disabled). */
export function iconTexture(icon: string, state: 'normal' | 'hover' | 'on' | 'off', dark: boolean) {
  return canvasTex(128, 128, (g) => {
    const bg = state === 'hover' ? (dark ? '#3F3F46' : '#F4F4F5') : state === 'on' ? (dark ? '#F4F4F5' : '#18181B') : dark ? '#202024' : '#FFFFFF';
    const fg = state === 'on' ? (dark ? '#18181B' : '#FFFFFF') : state === 'off' ? (dark ? '#52525B' : '#D4D4D8') : state === 'hover' ? (dark ? '#F4F4F5' : '#18181B') : dark ? '#A1A1AA' : '#52525B';
    g.globalAlpha = state === 'off' ? 0.6 : 1;
    g.beginPath(); g.roundRect(6, 6, 116, 116, 16);
    g.fillStyle = bg; g.fill();
    g.lineWidth = 4; g.strokeStyle = state === 'on' ? (dark ? '#F4F4F5' : '#18181B') : dark ? '#2C2C31' : '#E4E4E7'; g.stroke();
    g.translate(22, 22); g.scale(3.5, 3.5);
    g.strokeStyle = fg; g.lineWidth = 1.7; g.lineCap = 'round'; g.lineJoin = 'round';
    g.stroke(new Path2D(ICON_PATHS[icon] ?? ICON_PATHS.info));
  });
}

export interface PlateIcon { mesh: THREE.Mesh; action: PlateAction; plate: number; tip: string; icon: string; enabled: boolean; on: boolean }

export interface PlateBuild { group: THREE.Group; icons: PlateIcon[] }

export function buildPlate(p: PrinterProfile, plateType: PlateType, bedLabel: string, index: number, opts: { plates: number; locked: boolean; name: string; dark: boolean; active: boolean }): PlateBuild {
  const g = new THREE.Group();
  const { x: X, y: Y } = p.bed;
  const isBbl = p.flavor === 'bbl';
  const base = bedLook(plateType, isBbl, bedLabel, opts.dark);
  // textured PEI sheets: golden bronze like the real plates; the Ender-3 V3 KE ships a black PEI sheet
  const pei = base.textured && (isBbl ? base.print === 'Textured PEI Plate' : true);
  const look: BedLook = !pei ? base
    : p.id === 'creality-ender3v3ke'
      ? { ...base, color: opts.dark ? '#1C1C1F' : '#2A2A2E', ink: 'rgba(255,255,255,0.5)', grid: '#5A5A60' }
      : { ...base, color: opts.dark ? '#4A3E33' : '#9A8472', ink: 'rgba(255,255,255,0.6)', grid: opts.dark ? '#7A6A5A' : '#6B5B4C' };
  const o = outline(X, Y, isBbl, p.id);
  const xs = o.pts.map((q) => q[0]), ys = o.pts.map((q) => q[1]);
  const box = { x0: Math.min(...xs) - 1, y0: Math.min(...ys) - 1, x1: Math.max(...xs) + 1, y1: Math.max(...ys) + 1 };

  // the plate slab: textured top, darker sides; hidden from below so only the grid shows
  const shape = new THREE.Shape();
  roundedPath(shape, o.pts, o.radii);
  const slabGeo = new THREE.ExtrudeGeometry(shape, { depth: 1.2, bevelEnabled: false, curveSegments: 6 });
  slabGeo.translate(0, 0, -1.2);
  const top = new THREE.MeshBasicMaterial({ map: surfaceTexture(p, X, Y, isBbl, look, box) });
  const side = new THREE.MeshBasicMaterial({ color: new THREE.Color(look.color).multiplyScalar(opts.dark ? 0.75 : 0.88) });
  const slab = new THREE.Mesh(slabGeo, [top, side]);
  slab.userData.plateIndex = index;
  slab.userData.surface = true;
  g.add(slab);

  // 10 mm grid and the printable-area border
  const minor: number[] = [], major: number[] = [];
  for (let x = 0; x <= X + 1e-6; x += 10) (x % 50 === 0 ? major : minor).push(x, 0, 0.02, x, Y, 0.02);
  for (let y = 0; y <= Y + 1e-6; y += 10) (y % 50 === 0 ? major : minor).push(0, y, 0.02, X, y, 0.02);
  const lines = (pts: number[], color: string, opacity: number) => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    return new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color, transparent: true, opacity }));
  };
  const lineColor = look.grid;
  g.add(lines(minor, lineColor, 0.42));
  g.add(lines(major, lineColor, 0.75));
  g.add(lines([0, 0, 0.02, X, 0, 0.02, X, 0, 0.02, X, Y, 0.02, X, Y, 0.02, 0, Y, 0.02, 0, Y, 0.02, 0, 0, 0.02], opts.active && opts.plates > 1 ? ACCENT_GREEN : lineColor, opts.active && opts.plates > 1 ? 1 : 0.8));
  // the printable volume, faintly
  const vol = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(X, Y, p.bed.z)), new THREE.LineBasicMaterial({ color: look.grid, transparent: true, opacity: opts.active ? 0.22 : 0.08 }));
  vol.position.set(X / 2, Y / 2, p.bed.z / 2);
  g.add(vol);
  // axes at the origin
  const axis = (to: [number, number, number], color: string) => new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0.04), new THREE.Vector3(...to)]), new THREE.LineBasicMaterial({ color }));
  g.add(axis([20, 0, 0.04], '#E53935'), axis([0, 20, 0.04], '#43A047'), axis([0, 0, 20], '#1E88E5'));

  // icon column beside the back-right corner
  const S = Math.max(14, Math.min(24, Math.max(X, Y) * 0.075));
  const icons: PlateIcon[] = [];
  const defs: [PlateAction, string, string, boolean, boolean][] = [
    ['remove', 'close', 'Remove plate', opts.plates > 1, false],
    ['add', 'add', 'Add a new plate', true, false],
    ['orient', 'orient', 'Auto orient objects on this plate', !opts.locked, false],
    ['arrange', 'arrange', 'Arrange objects on this plate', !opts.locked, false],
    ['lock', opts.locked ? 'lock' : 'unlock', opts.locked ? 'Unlock plate' : 'Lock plate', true, opts.locked],
    ['settings', 'gear', 'Plate settings', true, false],
  ];
  const right = Math.max(...xs);
  defs.forEach(([action, icon, tip, enabled, on], i) => {
    const mesh = flatQuad(iconTexture(icon, !enabled ? 'off' : on ? 'on' : 'normal', opts.dark), S, S, right + 4 + S / 2, Y + 2 - S / 2 - i * (S + 3));
    const pi: PlateIcon = { mesh, action, plate: index, tip, icon, enabled, on };
    mesh.userData.plateIcon = pi;
    icons.push(pi);
    g.add(mesh);
  });

  // build volume under the settings icon, so the usable X × Y × Z is always in view
  const dimTex = canvasTex(512, 160, (c) => {
    c.textBaseline = 'middle'; c.textAlign = 'left';
    c.fillStyle = opts.dark ? '#9AA4B2' : '#6B7280';
    c.font = '600 46px "Segoe UI", system-ui, sans-serif';
    c.fillText("Build volume (X×Y×Z)", 4, 40, 504);
    c.fillStyle = opts.dark ? '#E5E7EB' : '#1F2937';
    c.font = '700 58px ui-monospace, "Cascadia Mono", Menlo, monospace';
    c.fillText(`${p.bed.x}×${p.bed.y}×${p.bed.z} mm`, 4, 112, 504);
  });
  const dw = S * 3.4, dh = dw * 160 / 512;
  // turned to run along the icon column, centred on it, continuing below the settings icon
  const dim = flatQuad(dimTex, dw, dh, right + 4 + S / 2, Y + 2 - defs.length * (S + 3) - dw / 2 + 1);
  dim.rotation.z = Math.PI / 2;
  dim.userData.tip = `Build volume: X ${p.bed.x} × Y ${p.bed.y} × Z ${p.bed.z} mm`;
  g.add(dim);

  // plate number at the front-right, pencil (and custom name) at the back-left
  const numTex = canvasTex(256, 128, (c) => {
    c.font = 'italic 800 96px "Segoe UI", system-ui, sans-serif';
    c.fillStyle = ACCENT_GREEN; c.textBaseline = 'middle'; c.textAlign = 'center';
    c.fillText(String(index + 1).padStart(2, '0'), 128, 68);
  });
  const num = flatQuad(numTex, S * 1.4, S * 0.7, right + 4 + S * 0.7, Math.min(...ys) + S * 0.2);
  const numIcon: PlateIcon = { mesh: num, action: 'number', plate: index, tip: `${opts.name} — click to select its objects`, icon: '', enabled: true, on: false };
  num.userData.plateIcon = numIcon;
  icons.push(numIcon);
  g.add(num);
  const custom = opts.name !== `Plate ${index + 1}`;
  const nameTex = canvasTex(custom ? 1024 : 128, 128, (c) => {
    c.save(); c.translate(8, 12); c.scale(4.2, 4.2);
    c.strokeStyle = ACCENT_GREEN; c.lineWidth = 2; c.lineCap = 'round'; c.lineJoin = 'round';
    c.stroke(new Path2D(ICON_PATHS.edit)); c.restore();
    if (custom) { c.font = '600 72px "Segoe UI", system-ui, sans-serif'; c.fillStyle = ACCENT_GREEN; c.textBaseline = 'middle'; c.fillText(opts.name, 128, 66); }
  });
  const nameW = S * 0.7 * (custom ? 8 : 1);
  const name = flatQuad(nameTex, nameW, S * 0.7, Math.min(...xs) + nameW / 2 - 2, Math.max(...ys) + S * 0.55);
  const nameIcon: PlateIcon = { mesh: name, action: 'name', plate: index, tip: 'Edit plate name', icon: '', enabled: true, on: false };
  name.userData.plateIcon = nameIcon;
  icons.push(nameIcon);
  g.add(name);
  return { group: g, icons };
}
