// Turn a picture, SVG, DXF drawing or a line of text into a relief height map (dark = raised).
import { bytesToMap, type HeightMap } from './reliefs';

const MAX = 384;

function canvasToMap(c: HTMLCanvasElement, soften: number): HeightMap {
  const out = document.createElement('canvas'); out.width = c.width; out.height = c.height;
  const g = out.getContext('2d')!;
  g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
  if (soften > 0) g.filter = `blur(${soften}px)`;
  g.drawImage(c, 0, 0);
  const px = g.getImageData(0, 0, c.width, c.height).data, n = c.width * c.height, b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = 255 - Math.round(0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2]);
  return bytesToMap(c.width, c.height, b);
}
function fit(w: number, h: number) { const s = Math.min(1, MAX / Math.max(w, h)); return [Math.max(8, Math.round(w * s)), Math.max(8, Math.round(h * s))]; }

async function imageToCanvas(blob: Blob): Promise<HTMLCanvasElement> {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image(); img.decoding = 'async'; img.src = url;
    await img.decode();
    let w = img.naturalWidth || 512, h = img.naturalHeight || 512;
    if (blob.type.includes('svg') && (!img.naturalWidth || img.naturalWidth < 64)) { w = 512; h = 512; }
    const [W, H] = fit(w * (w < 128 ? 4 : 1), h * (h < 128 ? 4 : 1));
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d')!; g.fillStyle = '#fff'; g.fillRect(0, 0, W, H); g.drawImage(img, 0, 0, W, H);
    return c;
  } finally { URL.revokeObjectURL(url); }
}

/** Minimal DXF reader: LINE, LWPOLYLINE, POLYLINE/VERTEX, CIRCLE, ARC, ELLIPSE (as circle), SPLINE (control polygon), POINT. */
export function parseDxf(text: string): number[][][] {
  const lines = text.split(/\r?\n/);
  const pairs: [number, string][] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) pairs.push([parseInt(lines[i].trim(), 10), lines[i + 1].trim()]);
  const paths: number[][][] = [];
  let i = 0;
  const ents = () => { while (i < pairs.length && !(pairs[i][0] === 2 && pairs[i][1] === 'ENTITIES')) i++; };
  ents();
  let poly: number[][] | null = null;
  while (i < pairs.length) {
    const [code, val] = pairs[i];
    if (code === 0) {
      const type = val; i++;
      const e: Record<number, number[]> = {};
      while (i < pairs.length && pairs[i][0] !== 0) { const [c, v] = pairs[i]; (e[c] ??= []).push(parseFloat(v)); i++; }
      const g = (c: number, k = 0) => e[c]?.[k] ?? 0;
      if (type === 'LINE') paths.push([[g(10), g(20)], [g(11), g(21)]]);
      else if (type === 'LWPOLYLINE' || type === 'SPLINE') { const xs = e[10] ?? [], ys = e[20] ?? []; const p = xs.map((x, k) => [x, ys[k] ?? 0]); if ((g(70) & 1) && p.length) p.push(p[0]); if (p.length > 1) paths.push(p); }
      else if (type === 'POLYLINE') { poly = []; }
      else if (type === 'VERTEX' && poly) poly.push([g(10), g(20)]);
      else if (type === 'SEQEND' && poly) { if (poly.length > 1) paths.push(poly); poly = null; }
      else if (type === 'CIRCLE' || type === 'ARC' || type === 'ELLIPSE') {
        const cx = g(10), cy = g(20);
        const r = type === 'ELLIPSE' ? Math.hypot(g(11), g(21)) : g(40);
        let a0 = 0, a1 = 360; if (type === 'ARC') { a0 = g(50); a1 = g(51); if (a1 < a0) a1 += 360; }
        const p: number[][] = []; for (let k = 0; k <= 64; k++) { const a = ((a0 + (a1 - a0) * (k / 64)) * Math.PI) / 180; p.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
        paths.push(p);
      } else if (type === 'POINT') paths.push([[g(10), g(20)], [g(10) + 0.01, g(20)]]);
      else if (type === 'ENDSEC') break;
      continue;
    }
    i++;
  }
  return paths;
}

function pathsToCanvas(paths: number[][][], lineFrac: number, fill: boolean): HTMLCanvasElement {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of paths) for (const [x, y] of p) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  if (!isFinite(x0)) throw new Error('No drawable lines found in the DXF.');
  const w = Math.max(1e-6, x1 - x0), h = Math.max(1e-6, y1 - y0);
  const [W, H] = fit(w >= h ? MAX : (MAX * w) / h, h > w ? MAX : (MAX * h) / w);
  const pad = 6, s = Math.min((W - 2 * pad) / w, (H - 2 * pad) / h);
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d')!; g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
  g.strokeStyle = '#000'; g.fillStyle = '#000'; g.lineWidth = Math.max(1.5, Math.min(W, H) * lineFrac); g.lineCap = 'round'; g.lineJoin = 'round';
  g.beginPath();
  for (const p of paths) p.forEach(([x, y], k) => { const X = pad + (x - x0) * s, Y = H - pad - (y - y0) * s; if (k) g.lineTo(X, Y); else g.moveTo(X, Y); });
  if (fill) g.fill('evenodd');
  g.stroke();
  return c;
}

export interface ImportOpts { soften: number; lineWidth: number; fillClosed: boolean }

export async function fileToMap(file: File, o: ImportOpts): Promise<HeightMap> {
  const name = file.name.toLowerCase();
  if (name.endsWith('.dxf')) return canvasToMap(pathsToCanvas(parseDxf(await file.text()), o.lineWidth, o.fillClosed), o.soften);
  if (name.endsWith('.svg') || file.type.includes('svg')) {
    const txt = await file.text();
    return canvasToMap(await imageToCanvas(new Blob([txt], { type: 'image/svg+xml' })), o.soften);
  }
  return canvasToMap(await imageToCanvas(file), o.soften);
}

export function textToMap(text: string, font: string, o: ImportOpts): HeightMap {
  const c = document.createElement('canvas'); const g0 = c.getContext('2d')!;
  const size = 120; g0.font = `${size}px ${font}`;
  const w = Math.ceil(g0.measureText(text || ' ').width) + 40;
  const [W, H] = fit(w, size * 1.4);
  c.width = W; c.height = H;
  const g = c.getContext('2d')!; g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
  g.fillStyle = '#000'; g.font = `${(size * W) / w}px ${font}`; g.textBaseline = 'middle'; g.textAlign = 'center';
  g.fillText(text, W / 2, H / 2);
  return canvasToMap(c, o.soften);
}
