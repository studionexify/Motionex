// SVG → Patternex pattern (spec §3.1). Self-contained (no DOMParser) so it runs in node tests and workers.
// Supports: svg/g/path/rect/circle/ellipse/polygon/polyline/line, nested transforms, fill & fill-rule
// (attribute, style or inherited), viewBox/width/height units. Curves become polylines at `tolerance_mm`.
// Output is in mm with Y up (SVG Y is flipped).
import { boundsOf, type FillRule, type Pattern, type PatternShape, type Ring } from './model';

export interface SvgOptions {
  id?: string;
  name?: string;
  /** Max chord deviation for curves, mm. */
  tolerance_mm?: number;
  /** Close open paths instead of skipping them. */
  autoClose?: boolean;
}

export interface SvgResult { pattern: Pattern; warnings: string[] }

type M = [number, number, number, number, number, number]; // a b c d e f
const I: M = [1, 0, 0, 1, 0, 0];
const mul = (p: M, q: M): M => [
  p[0] * q[0] + p[2] * q[1], p[1] * q[0] + p[3] * q[1],
  p[0] * q[2] + p[2] * q[3], p[1] * q[2] + p[3] * q[3],
  p[0] * q[4] + p[2] * q[5] + p[4], p[1] * q[4] + p[3] * q[5] + p[5],
];
const apply = (m: M, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
/** Uniform-ish scale of a matrix, used to convert the mm tolerance into local units. */
const scaleOf = (m: M) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;

const NUM = /[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g;
const nums = (s: string | undefined) => (s ?? '').match(NUM)?.map(Number) ?? [];

export function parseTransform(s: string | undefined): M {
  let m: M = I;
  if (!s) return m;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  for (let r; (r = re.exec(s));) {
    const v = nums(r[2]);
    let t: M = I;
    switch (r[1]) {
      case 'matrix': if (v.length === 6) t = v as M; break;
      case 'translate': t = [1, 0, 0, 1, v[0] ?? 0, v[1] ?? 0]; break;
      case 'scale': t = [v[0] ?? 1, 0, 0, v[1] ?? v[0] ?? 1, 0, 0]; break;
      case 'rotate': {
        const a = ((v[0] ?? 0) * Math.PI) / 180, c = Math.cos(a), sn = Math.sin(a);
        t = [c, sn, -sn, c, 0, 0];
        if (v.length >= 3) t = mul(mul([1, 0, 0, 1, v[1], v[2]], t), [1, 0, 0, 1, -v[1], -v[2]]);
        break;
      }
      case 'skewX': t = [1, 0, Math.tan(((v[0] ?? 0) * Math.PI) / 180), 1, 0, 0]; break;
      case 'skewY': t = [1, Math.tan(((v[0] ?? 0) * Math.PI) / 180), 0, 1, 0, 0]; break;
    }
    m = mul(m, t);
  }
  return m;
}

// ---------- minimal XML tokenizer
interface Tag { name: string; attrs: Record<string, string>; close: boolean; self: boolean }
function* tags(src: string): Generator<Tag> {
  const s = src.replace(/<!--[\s\S]*?-->/g, '').replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '').replace(/<[?!][\s\S]*?>/g, '');
  const re = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>/g;
  for (let r; (r = re.exec(s));) {
    const attrs: Record<string, string> = {};
    const ar = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
    for (let a; (a = ar.exec(r[3]));) attrs[a[1]] = a[2] ?? a[3] ?? a[4] ?? '';
    yield { name: r[2].replace(/^.*:/, ''), attrs, close: r[1] === '/', self: r[4] === '/' };
  }
}

// ---------- colours
const NAMED: Record<string, string> = {
  black: '#000000', white: '#ffffff', red: '#ff0000', lime: '#00ff00', green: '#008000', blue: '#0000ff', yellow: '#ffff00',
  cyan: '#00ffff', aqua: '#00ffff', magenta: '#ff00ff', fuchsia: '#ff00ff', gray: '#808080', grey: '#808080', silver: '#c0c0c0',
  maroon: '#800000', olive: '#808000', navy: '#000080', purple: '#800080', teal: '#008080', orange: '#ffa500',
};
const hex2 = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
/** '#rrggbb', 'none', or null when unset/unsupported (gradients/patterns fall back to black). */
export function normColor(c: string | undefined): string | null {
  if (c === undefined) return null;
  const s = c.trim().toLowerCase();
  if (!s || s === 'inherit') return null;
  if (s === 'none' || s === 'transparent') return 'none';
  if (s in NAMED) return NAMED[s];
  let m = /^#([0-9a-f]{3})$/.exec(s);
  if (m) return '#' + [...m[1]].map((ch) => ch + ch).join('');
  m = /^#([0-9a-f]{6})/.exec(s);
  if (m) return '#' + m[1];
  m = /^rgba?\(([^)]*)\)$/.exec(s);
  if (m) {
    const v = m[1].split(/[\s,/]+/).filter(Boolean).map((t) => (t.endsWith('%') ? (parseFloat(t) * 255) / 100 : parseFloat(t)));
    return '#' + v.slice(0, 3).map(hex2).join('');
  }
  if (s.startsWith('url(')) return '#000000';
  return null;
}

// ---------- units
const UNIT_MM: Record<string, number> = { mm: 1, cm: 10, in: 25.4, pt: 25.4 / 72, pc: 25.4 / 6, px: 25.4 / 96, '': 25.4 / 96 };
const lenMm = (s: string | undefined): number | null => {
  const m = /^\s*([-+]?[\d.]+(?:e[-+]?\d+)?)\s*([a-z]*)\s*$/i.exec(s ?? '');
  return m && m[2].toLowerCase() in UNIT_MM ? parseFloat(m[1]) * UNIT_MM[m[2].toLowerCase()] : null;
};

// ---------- path data → subpaths in local units
interface Sub { pts: [number, number][]; closed: boolean }

function curveSteps(chord: number, tolLocal: number): number {
  // a cubic/quadratic over chord-ish length L deviates ~ L²/(8n²·R); a cheap bound that tracks size
  return Math.max(2, Math.min(256, Math.ceil(Math.sqrt(chord / Math.max(tolLocal, 1e-6)) * 0.75)));
}

export function pathSubpaths(d: string, tolLocal: number): Sub[] {
  const toks = d.match(/[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) ?? [];
  const subs: Sub[] = [];
  let cur: Sub | null = null;
  let x = 0, y = 0, sx = 0, sy = 0, lcx = 0, lcy = 0, lqx = 0, lqy = 0, prev = '';
  let i = 0, cmd = '';
  const isCmd = (t: string) => /^[A-Za-z]$/.test(t);
  const n = () => Number(toks[i++]);
  // arc flags may be packed ("011"): split single digits when needed
  const flag = () => { const t = toks[i]; if (t.length > 1 && /^[01]/.test(t)) { toks[i] = t.slice(1); return Number(t[0]); } i++; return Number(t); };
  const line = (nx: number, ny: number) => { if (!cur) { cur = { pts: [[x, y]], closed: false }; subs.push(cur); } cur.pts.push([nx, ny]); x = nx; y = ny; };
  const cubic = (x1: number, y1: number, x2: number, y2: number, ex: number, ey: number) => {
    const L = Math.hypot(x1 - x, y1 - y) + Math.hypot(x2 - x1, y2 - y1) + Math.hypot(ex - x2, ey - y2);
    const k = curveSteps(L, tolLocal), x0 = x, y0 = y;
    for (let s = 1; s <= k; s++) {
      const t = s / k, u = 1 - t;
      line(u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * ex, u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * ey);
    }
    lcx = x2; lcy = y2;
  };
  const quad = (qx: number, qy: number, ex: number, ey: number) => {
    const L = Math.hypot(qx - x, qy - y) + Math.hypot(ex - qx, ey - qy);
    const k = curveSteps(L, tolLocal), x0 = x, y0 = y;
    for (let s = 1; s <= k; s++) { const t = s / k, u = 1 - t; line(u * u * x0 + 2 * u * t * qx + t * t * ex, u * u * y0 + 2 * u * t * qy + t * t * ey); }
    lqx = qx; lqy = qy;
  };
  const arc = (rx: number, ry: number, rot: number, large: number, sweep: number, ex: number, ey: number) => {
    // SVG 1.1 F.6.5 endpoint → centre parameterisation
    if (rx === 0 || ry === 0 || (ex === x && ey === y)) { line(ex, ey); return; }
    rx = Math.abs(rx); ry = Math.abs(ry);
    const ph = (rot * Math.PI) / 180, cph = Math.cos(ph), sph = Math.sin(ph);
    const dx = (x - ex) / 2, dy = (y - ey) / 2;
    const x1 = cph * dx + sph * dy, y1 = -sph * dx + cph * dy;
    const lam = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
    if (lam > 1) { rx *= Math.sqrt(lam); ry *= Math.sqrt(lam); }
    const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
    const co = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num / (rx * rx * y1 * y1 + ry * ry * x1 * x1)));
    const cx1 = (co * rx * y1) / ry, cy1 = (-co * ry * x1) / rx;
    const cx = cph * cx1 - sph * cy1 + (x + ex) / 2, cy = sph * cx1 + cph * cy1 + (y + ey) / 2;
    const ang = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    const t1 = ang(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
    let dt = ang((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
    if (!sweep && dt > 0) dt -= 2 * Math.PI; else if (sweep && dt < 0) dt += 2 * Math.PI;
    const r = Math.max(rx, ry);
    const step = 2 * Math.acos(Math.max(-1, Math.min(1, 1 - tolLocal / r)));
    const k = Math.max(2, Math.min(512, Math.ceil(Math.abs(dt) / Math.max(step, 1e-3))));
    for (let s = 1; s <= k; s++) {
      if (s === k) { line(ex, ey); break; }
      const t = t1 + (dt * s) / k, px = rx * Math.cos(t), py = ry * Math.sin(t);
      line(cph * px - sph * py + cx, sph * px + cph * py + cy);
    }
  };
  while (i < toks.length) {
    if (isCmd(toks[i])) cmd = toks[i++];
    else if (!cmd) { i++; continue; }
    const rel = cmd === cmd.toLowerCase(), C = cmd.toUpperCase();
    const ox = rel ? x : 0, oy = rel ? y : 0;
    const rem = () => i < toks.length && !isCmd(toks[i]);
    switch (C) {
      case 'M': {
        if (!rem()) break;
        x = ox + n(); y = oy + n(); sx = x; sy = y;
        cur = { pts: [[x, y]], closed: false }; subs.push(cur);
        cmd = rel ? 'l' : 'L'; // following pairs are implicit linetos
        break;
      }
      case 'L': if (rem()) line(ox + n(), oy + n()); break;
      case 'H': if (rem()) line(ox + n(), y); break;
      case 'V': if (rem()) line(x, oy + n()); break;
      case 'C': if (rem()) { const a = ox + n(), b = oy + n(), c = ox + n(), d2 = oy + n(), e = ox + n(), f = oy + n(); cubic(a, b, c, d2, e, f); } break;
      case 'S': if (rem()) {
        const [rx1, ry1] = /[CS]/i.test(prev) ? [2 * x - lcx, 2 * y - lcy] : [x, y];
        const c = ox + n(), d2 = oy + n(), e = ox + n(), f = oy + n(); cubic(rx1, ry1, c, d2, e, f);
      } break;
      case 'Q': if (rem()) { const a = ox + n(), b = oy + n(), e = ox + n(), f = oy + n(); quad(a, b, e, f); } break;
      case 'T': if (rem()) {
        const [qx, qy] = /[QT]/i.test(prev) ? [2 * x - lqx, 2 * y - lqy] : [x, y];
        quad(qx, qy, ox + n(), oy + n());
      } break;
      case 'A': if (rem()) { const rx = n(), ry = n(), rot = n(), la = flag(), sw = flag(); arc(rx, ry, rot, la, sw, ox + n(), oy + n()); } break;
      case 'Z':
        if (cur) cur.closed = true;
        x = sx; y = sy; cur = null;
        break;
      default: i++;
    }
    prev = C;
    if (C === 'Z') cmd = '';
  }
  return subs;
}

// ---------- geometry checks
const segX = (a: [number, number], b: [number, number], c: [number, number], d: [number, number]) => {
  const o = (p: [number, number], q: [number, number], r: [number, number]) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = o(c, d, a), d2 = o(c, d, b), d3 = o(a, b, c), d4 = o(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
};
/** True when non-adjacent edges of the ring properly cross. Grid-bucketed so big rings stay fast. */
export function selfIntersects(r: Ring): boolean {
  const n = r.length;
  if (n < 4) return false;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of r) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  const g = Math.max(1, Math.ceil(Math.sqrt(n))), cw = (x1 - x0) / g || 1, ch = (y1 - y0) / g || 1;
  const cells = new Map<number, number[]>();
  const cl = (v: number, lo: number, s: number) => Math.min(g - 1, Math.max(0, Math.floor((v - lo) / s)));
  for (let e = 0; e < n; e++) {
    const a = r[e], b = r[(e + 1) % n];
    const ia = cl(Math.min(a[0], b[0]), x0, cw), ib = cl(Math.max(a[0], b[0]), x0, cw);
    const ja = cl(Math.min(a[1], b[1]), y0, ch), jb = cl(Math.max(a[1], b[1]), y0, ch);
    for (let ci = ia; ci <= ib; ci++) for (let cj = ja; cj <= jb; cj++) {
      const k = ci * g + cj, l = cells.get(k);
      if (l) {
        for (const f of l) {
          if (Math.abs(f - e) <= 1 || (f === 0 && e === n - 1)) continue;
          if (segX(a, b, r[f], r[(f + 1) % n])) return true;
        }
        l.push(e);
      } else cells.set(k, [e]);
    }
  }
  return false;
}

/** Drop consecutive duplicates and the repeated closing point. */
function cleanRing(pts: [number, number][], eps: number): Ring {
  const out: Ring = [];
  for (const p of pts) { const q = out[out.length - 1]; if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > eps) out.push(p); }
  while (out.length > 1 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) <= eps) out.pop();
  return out;
}

// ---------- main
interface Style { fill: string; rule: FillRule; m: M; display: boolean }

const styleAttrs = (a: Record<string, string>): Record<string, string> => {
  const out = { ...a };
  for (const decl of (a.style ?? '').split(';')) {
    const k = decl.indexOf(':');
    if (k > 0) out[decl.slice(0, k).trim()] = decl.slice(k + 1).trim();
  }
  return out;
};

export function parseSvg(src: string, o: SvgOptions = {}): SvgResult {
  const tol = o.tolerance_mm ?? 0.05;
  const warnings: string[] = [];
  const shapes: PatternShape[] = [];
  let open = 0, crossing = 0, unsupported = 0;
  const stack: Style[] = [];
  let skipDepth = 0; // inside <defs>, <clipPath>, <mask>, <symbol>, <style>…
  const SKIP = new Set(['defs', 'clipPath', 'mask', 'symbol', 'style', 'title', 'desc', 'metadata', 'pattern', 'linearGradient', 'radialGradient', 'marker', 'text']);

  for (const t of tags(src)) {
    if (t.close) {
      if (skipDepth) { if (SKIP.has(t.name)) skipDepth--; continue; }
      if (t.name === 'svg' || t.name === 'g' || t.name === 'a') stack.pop();
      continue;
    }
    if (skipDepth || SKIP.has(t.name)) { if (!t.self && SKIP.has(t.name)) skipDepth++; if (t.name === 'text') unsupported++; continue; }

    const a = styleAttrs(t.attrs);
    const parent: Style = stack[stack.length - 1] ?? { fill: '#000000', rule: 'nonzero', m: I, display: true };
    let m = parent.m;
    if (t.name === 'svg' && !stack.length) {
      // root: viewBox → mm, Y flipped
      const vb = nums(a.viewBox);
      const wmm = lenMm(a.width), hmm = lenMm(a.height);
      let sx = 25.4 / 96, sy = 25.4 / 96, tx = 0, ty = 0;
      if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) {
        sx = (wmm ?? vb[2] * (25.4 / 96)) / vb[2];
        sy = (hmm ?? vb[3] * (25.4 / 96)) / vb[3];
        if (wmm === null && hmm !== null) sx = sy; else if (hmm === null && wmm !== null) sy = sx;
        tx = -vb[0]; ty = -vb[1];
      }
      m = mul([sx, 0, 0, -sy, 0, 0], [1, 0, 0, 1, tx, ty]);
    }
    m = mul(m, parseTransform(a.transform));
    if (t.name !== 'svg' && t.name !== 'g' && t.name !== 'a') {
      const fillRaw = normColor(a.fill);
      const fill = fillRaw ?? parent.fill;
      const rule: FillRule = a['fill-rule'] === 'evenodd' ? 'evenodd' : a['fill-rule'] === 'nonzero' ? 'nonzero' : parent.rule;
      if (!parent.display || a.display === 'none' || a.visibility === 'hidden' || fill === 'none') continue;
      const tolLocal = tol / scaleOf(m);
      const N = (k: string) => parseFloat(a[k] ?? '0') || 0;
      let subs: Sub[] = [];
      const circle = (cx: number, cy: number, rx: number, ry: number) =>
        rx > 0 && ry > 0 ? pathSubpaths(`M${cx + rx},${cy}A${rx},${ry} 0 1 1 ${cx - rx},${cy}A${rx},${ry} 0 1 1 ${cx + rx},${cy}Z`, tolLocal) : [];
      switch (t.name) {
        case 'path': subs = pathSubpaths(a.d ?? '', tolLocal); break;
        case 'rect': {
          const x = N('x'), y = N('y'), w = N('width'), h = N('height');
          if (w <= 0 || h <= 0) break;
          let rx = a.rx !== undefined ? N('rx') : N('ry'), ry = a.ry !== undefined ? N('ry') : rx;
          rx = Math.min(rx, w / 2); ry = Math.min(ry, h / 2);
          subs = rx > 0 && ry > 0
            ? pathSubpaths(`M${x + rx},${y}H${x + w - rx}A${rx},${ry} 0 0 1 ${x + w},${y + ry}V${y + h - ry}A${rx},${ry} 0 0 1 ${x + w - rx},${y + h}H${x + rx}A${rx},${ry} 0 0 1 ${x},${y + h - ry}V${y + ry}A${rx},${ry} 0 0 1 ${x + rx},${y}Z`, tolLocal)
            : [{ pts: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]], closed: true }];
          break;
        }
        case 'circle': subs = circle(N('cx'), N('cy'), N('r'), N('r')); break;
        case 'ellipse': subs = circle(N('cx'), N('cy'), N('rx'), N('ry')); break;
        case 'polygon': case 'polyline': {
          const v = nums(a.points), pts: [number, number][] = [];
          for (let k = 0; k + 1 < v.length; k += 2) pts.push([v[k], v[k + 1]]);
          if (pts.length) subs = [{ pts, closed: t.name === 'polygon' }];
          break;
        }
        case 'line': subs = [{ pts: [[N('x1'), N('y1')], [N('x2'), N('y2')]], closed: false }]; break;
        case 'use': case 'image': unsupported++; break;
      }
      const rings: Ring[] = [];
      for (const s of subs) {
        // a path is "closed" by Z, or when its last point lands on its first
        const ring = cleanRing(s.pts.map(([x, y]) => apply(m, x, y)), tol * 0.01);
        const first = s.pts[0], last = s.pts[s.pts.length - 1];
        const touches = Math.hypot(apply(m, ...first)[0] - apply(m, ...last)[0], apply(m, ...first)[1] - apply(m, ...last)[1]) <= tol;
        if (ring.length < 3) continue;
        if (!s.closed && !touches) { open++; if (!o.autoClose) continue; }
        if (selfIntersects(ring)) crossing++;
        rings.push(ring);
      }
      if (rings.length) shapes.push({ polygon_rings: rings, fill_color: fill, fill_rule: rule });
      continue;
    }
    if (t.self) continue;
    const fill = normColor(a.fill) ?? parent.fill;
    const rule: FillRule = a['fill-rule'] === 'evenodd' ? 'evenodd' : a['fill-rule'] === 'nonzero' ? 'nonzero' : parent.rule;
    stack.push({ fill, rule, m, display: parent.display && a.display !== 'none' });
  }

  if (open) warnings.push(o.autoClose ? `${open} open path(s) were closed automatically.` : `${open} open path(s) were skipped — enable auto-close to keep them.`);
  if (crossing) warnings.push(`${crossing} ring(s) cross themselves; they are filled by the shape's fill rule and may print unexpectedly.`);
  if (unsupported) warnings.push(`${unsupported} element(s) (text, <use>, images) are not supported — convert them to paths first.`);
  if (!shapes.length) warnings.push('No filled shapes were found in the SVG.');
  const id = o.id ?? `svg:${hashStr(src)}`;
  return { pattern: { id, name: o.name ?? 'SVG pattern', source: 'svg', shapes, tolerance_mm: tol, bounds: boundsOf(shapes) }, warnings };
}

/** Deterministic short hash (FNV-1a) for pattern ids. */
export function hashStr(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}
