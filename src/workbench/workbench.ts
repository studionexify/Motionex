// Motionex workbench: motion library (left) · working screen with the G-code preview (centre) ·
// settings (right). Plain DOM so the same module runs inside the desktop app and as a standalone page.
import { PRESETS } from '../plugins/motionex/presets';
import type { MotionBrush } from '../plugins/motionex/model';
import { DEFAULT_SETTINGS, generate, motionSamples, type GenResult, type GenSettings } from './generator';
import { Preview, type ColorBy } from './preview';

const KEY = 'motionex.workbench.v1';
type Field = { k: keyof GenSettings; label: string; type: 'num' | 'bool' | 'select' | 'text'; min?: number; max?: number; step?: number; unit?: string; opts?: [string, string][]; show?: (s: GenSettings) => boolean };
const SECTIONS: { title: string; fields: Field[] }[] = [
  { title: 'Shape', fields: [
    { k: 'shape', label: 'Shape', type: 'select', opts: [['cylinder', 'Cylinder'], ['polygon', 'Polygon'], ['twisted', 'Twisted polygon'], ['cone', 'Cone'], ['vase', 'Vase']] },
    { k: 'diameter', label: 'Diameter', type: 'num', min: 5, max: 250, step: 1, unit: 'mm' },
    { k: 'topDiameter', label: 'Top diameter', type: 'num', min: 5, max: 250, step: 1, unit: 'mm', show: (s) => s.shape === 'cone' || s.shape === 'vase' },
    { k: 'bulge', label: 'Belly', type: 'num', min: -30, max: 60, step: 1, unit: 'mm', show: (s) => s.shape === 'vase' },
    { k: 'sides', label: 'Sides', type: 'num', min: 3, max: 24, step: 1, show: (s) => s.shape === 'polygon' || s.shape === 'twisted' },
    { k: 'twistDeg', label: 'Twist', type: 'num', min: -720, max: 720, step: 5, unit: '°', show: (s) => s.shape === 'twisted' },
    { k: 'height', label: 'Height', type: 'num', min: 1, max: 300, step: 1, unit: 'mm' },
  ] },
  { title: 'Motion', fields: [
    { k: 'motionOn', label: 'Apply motion', type: 'bool' },
    { k: 'amplitudeScale', label: 'Size', type: 'num', min: 0, max: 4, step: 0.05, unit: '×' },
    { k: 'periodScale', label: 'Spacing', type: 'num', min: 0.2, max: 5, step: 0.05, unit: '×' },
    { k: 'phaseDeg', label: 'Phase', type: 'num', min: 0, max: 360, step: 5, unit: '°' },
    { k: 'layerEffects', label: 'Layer stacking', type: 'bool' },
    { k: 'zStart', label: 'Start height', type: 'num', min: 0, max: 300, step: 0.2, unit: 'mm' },
    { k: 'fadeMm', label: 'Fade in', type: 'num', min: 0, max: 20, step: 0.5, unit: 'mm' },
  ] },
  { title: 'Print', fields: [
    { k: 'layerHeight', label: 'Layer height', type: 'num', min: 0.05, max: 0.6, step: 0.02, unit: 'mm' },
    { k: 'firstLayerHeight', label: 'First layer', type: 'num', min: 0.1, max: 0.6, step: 0.02, unit: 'mm' },
    { k: 'lineWidth', label: 'Line width', type: 'num', min: 0.2, max: 1.2, step: 0.01, unit: 'mm' },
    { k: 'baseLayers', label: 'Bottom layers', type: 'num', min: 0, max: 10, step: 1 },
    { k: 'innerWalls', label: 'Inner walls', type: 'num', min: 0, max: 5, step: 1 },
    { k: 'spiral', label: 'Spiral vase', type: 'bool' },
    { k: 'speed', label: 'Wall speed', type: 'num', min: 5, max: 300, step: 5, unit: 'mm/s' },
    { k: 'firstLayerSpeed', label: 'First layer speed', type: 'num', min: 5, max: 100, step: 5, unit: 'mm/s' },
    { k: 'travelSpeed', label: 'Travel speed', type: 'num', min: 20, max: 500, step: 10, unit: 'mm/s' },
  ] },
  { title: 'Machine', fields: [
    { k: 'bedX', label: 'Bed X', type: 'num', min: 50, max: 1000, step: 1, unit: 'mm' },
    { k: 'bedY', label: 'Bed Y', type: 'num', min: 50, max: 1000, step: 1, unit: 'mm' },
    { k: 'filamentDia', label: 'Filament', type: 'num', min: 1.5, max: 3, step: 0.05, unit: 'mm' },
    { k: 'nozzleTemp', label: 'Nozzle temp', type: 'num', min: 150, max: 320, step: 5, unit: '°C' },
    { k: 'bedTemp', label: 'Bed temp', type: 'num', min: 0, max: 120, step: 5, unit: '°C' },
    { k: 'fan', label: 'Fan', type: 'num', min: 0, max: 100, step: 5, unit: '%' },
    { k: 'retract', label: 'Retraction', type: 'num', min: 0, max: 8, step: 0.1, unit: 'mm' },
    { k: 'startGcode', label: 'Start G-code', type: 'text' },
    { k: 'endGcode', label: 'End G-code', type: 'text' },
  ] },
];

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  el.append(...kids);
  return el;
}

function load(): { s: GenSettings; brush: string } {
  try { const j = JSON.parse(localStorage.getItem(KEY) ?? 'null'); if (j) return { s: { ...DEFAULT_SETTINGS, ...j.s }, brush: j.brush ?? PRESETS[0].id }; } catch { /* no storage */ }
  return { s: { ...DEFAULT_SETTINGS }, brush: PRESETS[0].id };
}
function save(s: GenSettings, brush: string) { try { localStorage.setItem(KEY, JSON.stringify({ s, brush })); } catch { /* no storage */ } }

const fmtTime = (s: number) => { const m = Math.round(s / 60); return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`; };

export interface WorkbenchOptions { /** false where file downloads are blocked (sandboxed web page): the main button copies instead. */ download?: boolean }

export function mountWorkbench(root: HTMLElement, opts: WorkbenchOptions = {}): () => void {
  const canDownload = opts.download !== false;
  const st = load();
  let s = st.s, brushId = st.brush, result: GenResult | null = null;
  const brushOf = (): MotionBrush | null => PRESETS.find((b) => b.id === brushId) ?? null;
  root.classList.add('wb');
  root.innerHTML = '';

  // ── left: library
  const search = h('input', { type: 'search', placeholder: 'Search motions…', class: 'wb-search', 'aria-label': 'Search motions' });
  const list = h('div', { class: 'wb-list' });
  const left = h('aside', { class: 'wb-left' }, h('div', { class: 'wb-head' }, h('h2', {}, 'Motions library'), h('span', { class: 'wb-count' }, `${PRESETS.length}`)), search, list);
  const cats = [...new Set(PRESETS.map((b) => b.category ?? 'Other'))];
  const renderList = () => {
    const q = search.value.trim().toLowerCase();
    list.innerHTML = '';
    for (const c of cats) {
      const items = PRESETS.filter((b) => (b.category ?? 'Other') === c && (!q || b.name.toLowerCase().includes(q) || (b.description ?? '').toLowerCase().includes(q)));
      if (!items.length) continue;
      list.append(h('div', { class: 'wb-cat' }, c));
      for (const b of items) {
        const thumb = h('canvas', { class: 'wb-thumb', width: '96', height: '40' });
        drawThumb(thumb, b);
        const btn = h('button', { class: `wb-item${b.id === brushId ? ' on' : ''}`, title: b.description ?? '' }, thumb, h('span', { class: 'wb-iname' }, h('b', {}, b.name), h('small', {}, b.description ?? '')));
        btn.onclick = () => { brushId = b.id; if (!s.motionOn) s = { ...s, motionOn: true }; renderList(); renderSettings(); regen(); };
        list.append(btn);
      }
    }
    if (!list.children.length) list.append(h('p', { class: 'wb-empty' }, 'No motions match.'));
  };
  search.oninput = renderList;

  // ── centre: working screen
  const canvas = h('canvas', { class: 'wb-canvas', 'aria-label': 'G-code preview' });
  const colorSel = h('select', { 'aria-label': 'Colour by' }, ...(['feature', 'speed', 'height', 'flow'] as ColorBy[]).map((v) => h('option', { value: v }, `Colour: ${v}`)));
  const travelChk = h('input', { type: 'checkbox' });
  const views = (['iso', 'top', 'front'] as const).map((v) => { const b = h('button', { class: 'wb-chip' }, v === 'iso' ? '3D' : v[0].toUpperCase() + v.slice(1)); b.onclick = () => preview.view(v); return b; });
  const layer = h('input', { type: 'range', min: '0', max: '0', value: '0', class: 'wb-layer', 'aria-label': 'Layer' });
  const layerLbl = h('span', { class: 'wb-layer-lbl' }, '');
  const stats = h('div', { class: 'wb-stats' });
  const warn = h('div', { class: 'wb-warn' });
  const legend = h('div', { class: 'wb-legend' });
  const center = h('main', { class: 'wb-center' },
    canvas,
    h('div', { class: 'wb-toolbar' }, ...views, colorSel, h('label', { class: 'wb-chip' }, travelChk, ' Travel')),
    h('div', { class: 'wb-motionname' }),
    legend, warn,
    h('div', { class: 'wb-bottom' }, h('div', { class: 'wb-slider' }, layer, layerLbl), stats));
  const preview = new Preview(canvas);
  colorSel.onchange = () => { preview.colorBy = colorSel.value as ColorBy; renderLegend(); preview.draw(); };
  travelChk.onchange = () => { preview.showTravel = travelChk.checked; preview.draw(); };
  layer.oninput = () => { preview.maxLayer = +layer.value; layerLbl.textContent = `Layer ${+layer.value + 1} / ${result?.layers ?? 0}`; preview.draw(); };
  const renderLegend = () => {
    legend.innerHTML = '';
    const items: [string, string][] = preview.colorBy === 'feature' ? [['#ff8a3d', 'Motion wall'], ['#dcd078', 'Plain wall'], ['#5ac8a0', 'Base / prime']] : [['linear-gradient(90deg,#3c6ee6,#28bebe,#f0d250,#fa7832)', `Low → high ${preview.colorBy}`]];
    for (const [c, t] of items) legend.append(h('span', {}, h('i', { style: `background:${c}` }), t));
  };

  // ── right: settings
  const form = h('div', { class: 'wb-form' });
  const genBtn = h('button', { class: 'wb-primary' }, canDownload ? 'Download G-code' : 'Copy G-code');
  const copyBtn = h('button', { class: 'wb-secondary' }, 'Copy');
  const resetBtn = h('button', { class: 'wb-secondary' }, 'Reset');
  const code = h('pre', { class: 'wb-code' });
  const codeBox = h('details', { class: 'wb-codebox' }, h('summary', {}, 'G-code output'), code);
  const right = h('aside', { class: 'wb-right' }, h('div', { class: 'wb-head' }, h('h2', {}, 'Settings')), form, codeBox, h('div', { class: 'wb-actions' }, genBtn, ...(canDownload ? [copyBtn] : []), resetBtn));
  const renderSettings = () => {
    form.innerHTML = '';
    for (const sec of SECTIONS) {
      const box = h('details', { class: 'wb-sec', open: '' }, h('summary', {}, sec.title));
      if (sec.title === 'Motion') { const b = brushOf(); box.append(h('div', { class: 'wb-picked' }, b ? `${b.name} · ${(b.amplitude * s.amplitudeScale).toFixed(2)} mm · every ${(b.period_mm * s.periodScale).toFixed(1)} mm` : 'Pick a motion on the left')); }
      for (const f of sec.fields) {
        if (f.show && !f.show(s)) continue;
        const id = `wb-${f.k}`;
        let input: HTMLElement;
        if (f.type === 'bool') {
          const i = h('input', { type: 'checkbox', id }); i.checked = !!s[f.k]; i.onchange = () => upd(f.k, i.checked, true); input = i;
        } else if (f.type === 'select') {
          const i = h('select', { id }, ...f.opts!.map(([v, l]) => h('option', { value: v }, l))); i.value = String(s[f.k]); i.onchange = () => upd(f.k, i.value, true); input = i;
        } else if (f.type === 'text') {
          const i = h('textarea', { id, rows: '4', spellcheck: 'false' }); i.value = String(s[f.k]); i.oninput = () => upd(f.k, i.value); input = i;
        } else {
          const r = h('input', { type: 'range', min: String(f.min), max: String(f.max), step: String(f.step), 'aria-label': f.label });
          const n = h('input', { type: 'number', id, min: String(f.min), max: String(f.max), step: String(f.step) });
          r.value = n.value = String(s[f.k]);
          r.oninput = () => { n.value = r.value; upd(f.k, +r.value); };
          n.onchange = () => { const v = Math.min(f.max!, Math.max(f.min!, +n.value || 0)); n.value = r.value = String(v); upd(f.k, v); };
          input = h('div', { class: 'wb-num' }, r, n, h('span', { class: 'wb-unit' }, f.unit ?? ''));
        }
        box.append(h('div', { class: `wb-row${f.type === 'text' ? ' wb-row-text' : ''}` }, h('label', { for: id }, f.label), input));
      }
      form.append(box);
    }
  };
  const upd = (k: keyof GenSettings, v: unknown, rerender = false) => {
    s = { ...s, [k]: v } as GenSettings;
    if (rerender) renderSettings();
    else if (k === 'amplitudeScale' || k === 'periodScale') { const p = form.querySelector('.wb-picked'); const b = brushOf(); if (p && b) p.textContent = `${b.name} · ${(b.amplitude * s.amplitudeScale).toFixed(2)} mm · every ${(b.period_mm * s.periodScale).toFixed(1)} mm`; }
    regen();
  };

  let timer = 0;
  const regen = () => { clearTimeout(timer); timer = window.setTimeout(run, 60); };
  const run = () => {
    save(s, brushId);
    const b = brushOf();
    const t0 = performance.now();
    result = generate(s, b);
    const ms = performance.now() - t0;
    const keepTop = +layer.value >= +layer.max;
    layer.max = String(result.layers - 1);
    if (keepTop || +layer.value > result.layers - 1) layer.value = layer.max;
    preview.maxLayer = +layer.value;
    layerLbl.textContent = `Layer ${+layer.value + 1} / ${result.layers}`;
    preview.set(result, [s.bedX, s.bedY]);
    const r = result.stats;
    stats.innerHTML = '';
    for (const [k, v] of [['Time', fmtTime(r.seconds)], ['Filament', `${(r.filamentMm / 1000).toFixed(2)} m · ${r.grams.toFixed(1)} g`], ['Layers', String(result.layers)], ['Lines', r.lines.toLocaleString()], ['Max offset', `${r.maxOffset.toFixed(2)} mm`], ['Built in', `${ms.toFixed(0)} ms`]]) stats.append(h('span', {}, h('small', {}, k), h('b', {}, v)));
    warn.textContent = result.warnings.join(' ');
    warn.hidden = !result.warnings.length;
    (center.querySelector('.wb-motionname') as HTMLElement).textContent = s.motionOn && b ? b.name : 'No motion';
    if (codeBox.open) code.textContent = result.gcode.length > 200000 ? result.gcode.slice(0, 200000) + '\n… (truncated in view, download for full file)' : result.gcode;
  };
  codeBox.ontoggle = () => { if (codeBox.open && result) run(); };
  genBtn.onclick = () => {
    if (!result) return;
    if (!canDownload) { void copyCode(genBtn, 'Copy G-code'); return; }
    const b = brushOf();
    const name = `motionex-${s.shape}-${(s.motionOn && b ? b.name : 'plain').toLowerCase().replace(/[^a-z0-9]+/g, '-')}.gcode`;
    const url = URL.createObjectURL(new Blob([result.gcode], { type: 'text/plain' }));
    const a = h('a', { href: url, download: name }); document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };
  const copyCode = async (btn: HTMLButtonElement, label: string) => {
    if (!result) return;
    try { await navigator.clipboard.writeText(result.gcode); btn.textContent = 'Copied'; }
    catch { codeBox.open = true; run(); const r = document.createRange(); r.selectNodeContents(code); const sel = getSelection(); sel?.removeAllRanges(); sel?.addRange(r); btn.textContent = 'Selected: press Ctrl+C'; }
    setTimeout(() => (btn.textContent = label), 2000);
  };
  copyBtn.onclick = () => void copyCode(copyBtn, 'Copy');
  resetBtn.onclick = () => { s = { ...DEFAULT_SETTINGS }; renderSettings(); regen(); };

  root.append(left, center, right);
  renderList(); renderSettings(); renderLegend(); run();
  requestAnimationFrame(() => list.querySelector('.wb-item.on')?.scrollIntoView({ block: 'center' }));
  return () => { preview.dispose(); clearTimeout(timer); root.innerHTML = ''; root.classList.remove('wb'); };
}

function drawThumb(c: HTMLCanvasElement, b: MotionBrush) {
  const g = c.getContext('2d'); if (!g) return;
  const pts = motionSamples(b, 120);
  g.clearRect(0, 0, c.width, c.height);
  g.strokeStyle = '#ff8a3d'; g.lineWidth = 2; g.lineJoin = 'round'; g.beginPath();
  pts.forEach(([u, v], i) => { const x = 4 + (u / 2) * (c.width - 8), y = c.height / 2 - v * (c.height / 2 - 5); if (i) g.lineTo(x, y); else g.moveTo(x, y); });
  g.stroke();
}
