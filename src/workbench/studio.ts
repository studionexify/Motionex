// Motionex Studio: design a revolved piece, add motions layer by layer, then slice and send to a printer.
// Plain DOM + three.js so the same module runs in the desktop app and as a standalone web page.
// Layout: top bar (printer first on the right) · step bar Design / Motion / Slice · left rail + strip ·
// 3D view in the centre · Properties on the right. Slicing only runs when asked.
import { PRESETS } from '../plugins/motionex/presets';
import type { LayerEffect, LayerMode, MotionBrush, WaveShape } from '../plugins/motionex/model';
import { effectPhase } from '../plugins/motionex/modifier';
import { defaultDesign, estimate, makeSurface, FAMILIES, OUTLINES, profileR, RELIEFS, SECTIONS, surprise, type Design, type Family, type ProfilePoint } from './design';
import { DEFAULT_SLICE, motionSamples, newZone, PRINTERS, slice, type GenResult, type MotionZone, type SliceSettings } from './generator';
import { StudioView, type ColorBy, type PathStyle } from './viewport';
import { newRule, prepareRules, ruleWeight, rowsToRects, type Rule } from './rules';
import { physicsFor, simulate, type Physics, type PrintSim } from './physics';
import { stlFromDesign } from './stl';

// ───────── host (printer connections; only the desktop app provides one)
export interface PrinterLink { id: string; name: string; state: string; progress?: number; detail?: string; bed?: [number, number, number] }
export interface StudioHost {
  printers(): PrinterLink[];
  subscribe(cb: () => void): () => void;
  send(id: string, fileName: string, gcode: string, start: boolean, onProgress?: (f: number) => void): Promise<void>;
  control(id: string, action: 'pause' | 'resume' | 'cancel' | 'connect'): Promise<void>;
  manage(): void;
}
export interface StudioOptions { host?: StudioHost; download?: boolean }

// ───────── state
interface Saved { id: string; name: string; design: Design; zones: MotionZone[]; rules?: Rule[]; at: number }
type Tool = 'orbit' | 'line' | 'segment' | 'brush' | 'box' | 'lasso' | 'band';
interface State {
  step: 'design' | 'motion' | 'slice';
  designTab: 'shape' | 'relief' | 'look';
  design: Design; zones: MotionZone[]; activeZone: string | null; slice: SliceSettings;
  motionTab: 'body' | 'layers'; rules: Rule[]; activeRule: string | null; tool: Tool; brushR: number; erase: boolean;
  physics: Physics; pathStyle: PathStyle; colorBy: ColorBy; libOpen: Record<string, boolean>;
  printer: { kind: 'profile' | 'device'; id: string } | null;
  color: string; theme: 'light' | 'dark' | null;
  rail: 'studio' | 'library' | 'printers' | 'help';
}
const KEY = 'motionex.studio.v2', LIB = 'motionex.library.v1';
const ls = { get<T>(k: string, d: T): T { try { const v = localStorage.getItem(k); return v ? { ...d as object, ...JSON.parse(v) } as T : d; } catch { return d; } }, set(k: string, v: unknown) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage blocked */ } } };
const lsArr = <T,>(k: string): T[] => { try { return JSON.parse(localStorage.getItem(k) ?? '[]'); } catch { return []; } };

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string | boolean> = {}, ...kids: (Node | string | null | false)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) { if (v === false) continue; if (k === 'class') el.className = String(v); else el.setAttribute(k, v === true ? '' : v); }
  for (const c of kids) if (c !== null && c !== false) el.append(c);
  return el;
}
const ICON: Record<string, string> = {
  undo: 'M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3', redo: 'm15 14 5-5-5-5M20 9H10a6 6 0 0 0 0 12h3', save: 'M5 3h11l3 3v15H5zM8 3v5h7M8 21v-7h8v7',
  spark: 'M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6', moon: 'M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z',
  export: 'M12 3v12M7 8l5-5 5 5M5 14v6h14v-6', printer: 'M6 9V3h12v6M6 18H4v-7h16v7h-2M7 14h10v7H7z', studio: 'M12 2 3 7v10l9 5 9-5V7zM3 7l9 5 9-5M12 12v10',
  library: 'M4 4h5v16H4zM10 4h5v16h-5zM16 5l4 1-3 14-4-1', help: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17.5v.01',
  fit: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5', design: 'M7 21c0-6 3-8 3-12s-2-5-2-6h8c0 1-2 2-2 6s3 6 3 12z', motion: 'M2 12c2-6 4-6 6 0s4 6 6 0 4-6 6 0 2 3 2 3',
  slice: 'M4 7h16M4 12h16M4 17h16', plus: 'M12 5v14M5 12h14', minus: 'M5 12h14', reset: 'M4 12a8 8 0 1 0 2.3-5.7L4 8.6M4 4v4.6h4.6', trash: 'M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z', send: 'M3 11 21 3l-8 18-2-8z', pause: 'M8 5v14M16 5v14', play: 'M7 4v16l13-8z', stop: 'M6 6h12v12H6z', check: 'm5 12 5 5 9-10',
  vase: 'M8 3h8M9 3c0 3-4 5-4 10a7 7 0 0 0 14 0c0-5-4-7-4-10', pendant: 'M12 2v5M5 17a7 7 0 0 1 14 0zM10 20h4', shade: 'M7 4h10l3 11H4zM12 15v5M8 20h8', bowl: 'M3 10h18a9 7 0 0 1-18 0zM8 21h8',
};
const icon = (n: string, s = 15) => { const w = document.createElement('span'); w.className = 'mxs-ic'; w.innerHTML = `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="${ICON[n]}"/></svg>`; return w; };
const fmtTime = (s: number) => { const m = Math.round(s / 60); return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}` : `${m} min`; };

const STACKS: { id: string; label: string; make: () => LayerEffect | null }[] = [
  { id: 'aligned', label: 'Lined up', make: () => null },
  { id: 'twist', label: 'Twist', make: () => ({ shift_deg: 6, mode: 'steady', every: 1, band_on: 0, band_off: 0 }) },
  { id: 'bricks', label: 'Bricks', make: () => ({ shift_deg: 180, mode: 'alternate', every: 4, band_on: 0, band_off: 0 }) },
  { id: 'zigzag', label: 'Zigzag', make: () => ({ shift_deg: 6, mode: 'back_and_forth', every: 15, band_on: 0, band_off: 0 }) },
  { id: 'wavy', label: 'Wavy', make: () => ({ shift_deg: 30, lag_deg: 30, mode: 'wave', wave_shape: 'sine', every: 24, band_on: 0, band_off: 0 }) },
  { id: 'diamond', label: 'Diamonds', make: () => ({ shift_deg: 6, mode: 'back_and_forth', every: 15, band_on: 0, band_off: 0, cross: true }) },
  { id: 'bands', label: 'Bands', make: () => ({ shift_deg: 0, mode: 'steady', every: 1, band_on: 10, band_off: 6 }) },
];
const MODES: [LayerMode, string][] = [['steady', 'Keep going'], ['alternate', 'Swap'], ['back_and_forth', 'There and back'], ['shift_hold', 'With pauses'], ['wave', 'Wave']];
const WAVES: [WaveShape, string][] = [['sine', 'Smooth'], ['rounded', 'Rounded'], ['triangle', 'Zigzag'], ['square', 'Jump'], ['ramp', 'Ramp']];

export function mountStudio(root: HTMLElement, opts: StudioOptions = {}): () => void {
  const host = opts.host, canDownload = opts.download !== false;
  const saved = ls.get<Partial<State>>(KEY, {});
  const S: State = {
    step: 'design', designTab: 'shape', design: saved.design ?? defaultDesign('vase'), zones: saved.zones ?? [], activeZone: null,
    slice: { ...DEFAULT_SLICE, ...saved.slice }, printer: saved.printer ?? null, color: saved.color ?? '#ece6dc', theme: saved.theme ?? null, rail: 'studio',
    motionTab: saved.motionTab ?? 'body', rules: saved.rules ?? [], activeRule: null, tool: 'orbit', brushR: 6, erase: false,
    physics: { ...physicsFor(saved.slice?.printer ?? DEFAULT_SLICE.printer), ...saved.physics }, pathStyle: saved.pathStyle ?? 'ribbons', colorBy: saved.colorBy ?? 'feature', libOpen: saved.libOpen ?? {},
  };
  S.activeRule = S.rules[0]?.id ?? null;
  S.activeZone = S.zones[0]?.id ?? null;
  let result: GenResult | null = null, sim: PrintSim | null = null, stale = true, showModel = true, showToolpath = false;
  const brushOf = (id: string): MotionBrush | undefined => PRESETS.find((b) => b.id === id);
  const persist = () => ls.set(KEY, { design: S.design, zones: S.zones, rules: S.rules, slice: S.slice, printer: S.printer, color: S.color, theme: S.theme, motionTab: S.motionTab, physics: S.physics, pathStyle: S.pathStyle, colorBy: S.colorBy, libOpen: S.libOpen });

  // undo / redo over design + zones
  const past: string[] = [], future: string[] = []; let lastSnap = JSON.stringify([S.design, S.zones, S.rules]), snapTimer = 0;
  const snapshot = () => { clearTimeout(snapTimer); snapTimer = window.setTimeout(() => { const now = JSON.stringify([S.design, S.zones, S.rules]); if (now !== lastSnap) { past.push(lastSnap); if (past.length > 80) past.shift(); future.length = 0; lastSnap = now; updateTop(); } }, 350); };
  const restore = (snap: string) => { const [d, z, r] = JSON.parse(snap); S.design = d; S.zones = z; S.rules = r ?? []; lastSnap = snap; changed(true); renderAll(); };
  const undo = () => { if (!past.length) return; future.push(JSON.stringify([S.design, S.zones, S.rules])); restore(past.pop()!); };
  const redo = () => { if (!future.length) return; past.push(JSON.stringify([S.design, S.zones, S.rules])); restore(future.pop()!); };

  root.classList.add('mxs'); root.innerHTML = '';
  if (S.theme) root.dataset.theme = S.theme;

  // ───────── top bar
  const nameIn = h('input', { class: 'mxs-name', id: 'mxs-name', 'aria-label': 'Piece name', spellcheck: 'false' }) as HTMLInputElement;
  const undoB = h('button', { class: 'mxs-ib', title: 'Undo (Ctrl+Z)', 'aria-label': 'Undo' }, icon('undo')); undoB.onclick = undo;
  const redoB = h('button', { class: 'mxs-ib', title: 'Redo (Ctrl+Shift+Z)', 'aria-label': 'Redo' }, icon('redo')); redoB.onclick = redo;
  const saveB = h('button', { class: 'mxs-btn' }, icon('save'), 'Save');
  const surpriseB = h('button', { class: 'mxs-btn mxs-accent' }, icon('spark'), 'Surprise me');
  const themeB = h('button', { class: 'mxs-ib', title: 'Light / dark', 'aria-label': 'Toggle theme' }, icon('moon'));
  const exportB = h('button', { class: 'mxs-btn mxs-accent' }, icon('export'), 'Export STL');
  const printerSel = h('select', { class: 'mxs-printer', id: 'mxs-printer', 'aria-label': 'Printer' }) as HTMLSelectElement;
  const printerBox = h('label', { class: 'mxs-printer-box', for: 'mxs-printer' }, icon('printer'), printerSel);
  const steps = h('div', { class: 'mxs-steps', role: 'tablist' });
  const top = h('header', { class: 'mxs-top' },
    h('div', { class: 'mxs-brand' }, h('b', {}, 'Motionex'), h('small', {}, 'Studio')),
    h('div', { class: 'mxs-tgroup' }, undoB, redoB, nameIn, saveB),
    steps,
    h('div', { class: 'mxs-tgroup mxs-right' }, printerBox, surpriseB, exportB, themeB));

  // ───────── rail + strip + centre + right
  const rail = h('nav', { class: 'mxs-rail' });
  const strip = h('aside', { class: 'mxs-strip' });
  const stage = h('main', { class: 'mxs-stage' });
  const glHost = h('div', { class: 'mxs-glhost' });
  const right = h('aside', { class: 'mxs-panel' });
  const page = h('section', { class: 'mxs-page' });
  const body = h('div', { class: 'mxs-body' }, rail, strip, stage, right, page);
  root.append(top, body);

  const view = new StudioView(glHost);
  const estCard = h('div', { class: 'mxs-est' });
  const viewBar = h('div', { class: 'mxs-viewbar' });
  const layerBar = h('div', { class: 'mxs-layerbar' });
  const staleTag = h('div', { class: 'mxs-stale' });
  const fitB = h('button', { class: 'mxs-ib mxs-fit', title: 'Fit view', 'aria-label': 'Fit view' }, icon('fit')); fitB.onclick = () => view.fit();
  const gate = h('div', { class: 'mxs-gate' });
  stage.append(glHost, h('div', { class: 'mxs-crumb' }), fitB, staleTag, estCard, h('div', { class: 'mxs-bottom' }, layerBar, viewBar), gate);

  // ───────── printers
  const printerList = () => {
    const devs = host?.printers() ?? [];
    return { devs, profiles: PRINTERS };
  };
  const bedOfPrinter = (): [number, number, number] => {
    if (!S.printer) return [256, 256, 256];
    if (S.printer.kind === 'profile') return PRINTERS.find((p) => p.id === S.printer!.id)?.bed ?? [256, 256, 256];
    return host?.printers().find((p) => p.id === S.printer!.id)?.bed ?? [256, 256, 256];
  };
  const choosePrinter = (v: string) => {
    if (!v) return;
    const [kind, id] = v.split(':') as ['profile' | 'device', string];
    S.printer = { kind, id };
    const bed = bedOfPrinter();
    S.slice = { ...S.slice, bedX: bed[0], bedY: bed[1], printer: kind === 'profile' ? id : S.slice.printer };
    S.physics = physicsFor(S.slice.printer);
    changed(false); renderAll();
  };
  printerSel.onchange = () => { if (printerSel.value === '__manage') { printerSel.value = S.printer ? `${S.printer.kind}:${S.printer.id}` : ''; host?.manage(); return; } choosePrinter(printerSel.value); };
  const renderPrinterSel = () => {
    const { devs, profiles } = printerList();
    printerSel.innerHTML = '';
    printerSel.append(h('option', { value: '', disabled: true }, 'Select printer…'));
    if (devs.length) printerSel.append(h('optgroup', { label: 'Connected printers' }, ...devs.map((d) => h('option', { value: `device:${d.id}` }, `${d.name} · ${d.state}`))));
    printerSel.append(h('optgroup', { label: 'Printer profiles' }, ...profiles.map((p) => h('option', { value: `profile:${p.id}` }, `${p.name} (${p.bed[0]}×${p.bed[1]})`))));
    if (host) printerSel.append(h('option', { value: '__manage' }, 'Connect a printer…'));
    printerSel.value = S.printer ? `${S.printer.kind}:${S.printer.id}` : '';
    printerBox.classList.toggle('mxs-need', !S.printer);
  };
  const renderGate = () => {
    gate.hidden = !!S.printer;
    root.classList.toggle('mxs-locked', !S.printer);
    if (S.printer) return;
    const { devs, profiles } = printerList();
    gate.innerHTML = '';
    const pickBtn = (v: string, name: string, meta: string) => { const b = h('button', { class: 'mxs-gpick' }, h('b', {}, name), h('small', {}, meta)); b.onclick = () => choosePrinter(v); return b; };
    gate.append(h('div', { class: 'mxs-gcard' },
      h('h2', {}, 'Select your printer to start'),
      h('p', {}, 'Motionex sizes the bed, the build height and the G-code for it. You can change it any time from the top right.'),
      devs.length ? h('div', { class: 'mxs-glabel' }, 'Connected printers') : null,
      devs.length ? h('div', { class: 'mxs-ggrid' }, ...devs.map((d) => pickBtn(`device:${d.id}`, d.name, d.state))) : null,
      h('div', { class: 'mxs-glabel' }, 'Printer profiles'),
      h('div', { class: 'mxs-ggrid' }, ...profiles.map((p) => pickBtn(`profile:${p.id}`, p.name, `${p.bed[0]} × ${p.bed[1]} × ${p.bed[2]} mm`))),
      host ? (() => { const b = h('button', { class: 'mxs-btn' }, icon('printer'), 'Connect a printer (LAN, Klipper, OctoPrint, USB)…'); b.onclick = () => host.manage(); return b; })() : h('p', { class: 'mxs-muted' }, 'Connecting and sending to printers works in the Motionex desktop app.')));
  };
  const offHost = host?.subscribe(() => { renderPrinterSel(); renderGate(); if (S.step === 'slice') renderPanel(); if (S.rail === 'printers') renderPage(); }) ?? (() => {});

  // ───────── change handling
  let meshTimer = 0, fullTimer = 0, meshRaf = 0;
  /** Coarse mesh on the next frame, full mesh once edits pause: no lag while dragging sliders. */
  function liveMesh() {
    cancelAnimationFrame(meshRaf); clearTimeout(fullTimer);
    meshRaf = requestAnimationFrame(() => view.setDesign(S.design, S.color, true));
    fullTimer = window.setTimeout(() => view.setDesign(S.design, S.color), 220);
  }
  function changed(designChanged: boolean) {
    persist(); snapshot();
    if (designChanged) liveMesh();
    if (result) { stale = true; }
    renderEstimate(); renderViewBar(); updateTop();
  }

  const doSlice = () => {
    staleTag.textContent = 'Slicing…'; staleTag.hidden = false;
    setTimeout(() => {
      result = slice(S.design, S.slice, S.zones, brushOf, S.rules);
      sim = simulate(result, S.slice, S.physics);
      stale = false; showToolpath = true;
      view.maxLayer = Infinity; view.flip = S.slice.flip; view.style = S.pathStyle; view.colorBy = S.colorBy;
      view.setToolpath(result, [S.slice.bedX, S.slice.bedY], sim);
      view.setVisibility(showModel = false, true);
      renderAll();
    }, 20);
  };

  // ───────── top bar behaviour
  saveB.onclick = () => {
    const lib = lsArr<Saved>(LIB);
    const id = (S.design as Design & { _id?: string })._id ?? Math.random().toString(36).slice(2, 10);
    (S.design as Design & { _id?: string })._id = id;
    const entry: Saved = { id, name: S.design.name, design: structuredClone(S.design), zones: structuredClone(S.zones), rules: structuredClone(S.rules), at: Date.now() };
    ls.set(LIB, [entry, ...lib.filter((x) => x.id !== id)].slice(0, 60));
    flash(saveB, 'Saved');
  };
  surpriseB.onclick = () => { const name = S.design.name; S.design = surprise(S.design.family); S.design.name = name; changed(true); renderAll(); };
  themeB.onclick = () => { const dark = !(root.dataset.theme === 'dark' || (!root.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches)); S.theme = dark ? 'dark' : 'light'; root.dataset.theme = S.theme; persist(); view.setTheme(dark); };
  exportB.onclick = () => {
    const stl = stlFromDesign(S.design);
    if (!canDownload) { flash(exportB, 'Downloads are blocked here'); return; }
    download(`${slug(S.design.name)}.stl`, new Blob([stl], { type: 'model/stl' }));
  };
  nameIn.oninput = () => { S.design.name = nameIn.value || 'Untitled piece'; persist(); };
  const onKey = (e: KeyboardEvent) => {
    const tag = (e.target as HTMLElement).tagName; if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
  };
  window.addEventListener('keydown', onKey);

  function updateTop() {
    undoB.disabled = !past.length; redoB.disabled = !future.length;
    if (document.activeElement !== nameIn) nameIn.value = S.design.name;
    steps.innerHTML = '';
    for (const [id, label, ic] of [['design', 'Design', 'design'], ['motion', 'Motion', 'motion'], ['slice', 'Slice', 'slice']] as const) {
      const b = h('button', { role: 'tab', class: `mxs-step${S.step === id ? ' on' : ''}`, 'aria-selected': String(S.step === id) }, icon(ic, 16), h('span', {}, label));
      if (id === 'slice' && result && stale) b.append(h('i', { class: 'mxs-dot', title: 'Changed since last slice' }));
      b.onclick = () => { S.step = id; S.rail = 'studio'; renderAll(); };
      steps.append(b);
    }
    surpriseB.hidden = S.step !== 'design';
  }

  // ───────── rail
  function renderRail() {
    rail.innerHTML = '';
    const item = (id: State['rail'], ic: string, label: string) => { const b = h('button', { class: `mxs-rail-i${S.rail === id ? ' on' : ''}` }, icon(ic, 17), h('span', {}, label)); b.onclick = () => { S.rail = id; renderAll(); }; return b; };
    rail.append(item('studio', 'studio', 'Studio'), item('library', 'library', 'Library'), item('printers', 'printer', 'Printers'), h('div', { class: 'mxs-grow' }), item('help', 'help', 'Help'));
  }

  // ───────── left strip: families (design) / motion library (motion) / layers summary (slice)
  let libQuery = '';
  function renderStrip() {
    strip.innerHTML = '';
    strip.className = `mxs-strip mxs-strip-${S.step}`;
    if (S.step === 'design') {
      for (const f of FAMILIES) {
        const b = h('button', { class: `mxs-fam${S.design.family === f.id ? ' on' : ''}`, title: f.hint }, icon(f.id, 20), h('span', {}, f.name));
        b.onclick = () => { if (S.design.family === f.id) return; const name = S.design.name; S.design = defaultDesign(f.id as Family); S.design.name = name; changed(true); renderAll(); };
        strip.append(b);
      }
      return;
    }
    if (S.step === 'motion') {
      const zone = S.zones.find((z) => z.id === S.activeZone) ?? null;
      const rule = S.rules.find((r) => r.id === S.activeRule) ?? null;
      const target = S.motionTab === 'body' ? rule : zone;
      const curId = S.motionTab === 'body' ? rule?.brushId : zone?.brushId;
      const search = h('input', { type: 'search', class: 'mxs-search', placeholder: 'Search motions…', 'aria-label': 'Search motions', value: libQuery }) as HTMLInputElement;
      const list = h('div', { class: 'mxs-lib' });
      const pick = (b: MotionBrush) => {
        if (S.motionTab === 'body') {
          let r = S.rules.find((x) => x.id === S.activeRule);
          if (!r) { r = newRule(S.rules.length + 1); S.rules.push(r); S.activeRule = r.id; }
          r.brushId = b.id;
        } else {
          const z = S.zones.find((x) => x.id === S.activeZone);
          if (z) z.brushId = b.id; else { const nz = newZone(b.id); S.zones.push(nz); S.activeZone = nz.id; }
        }
        changed(false); renderStrip(); renderPanel(); paintRules();
      };
      const fill = () => {
        list.innerHTML = '';
        const q = libQuery.toLowerCase();
        const cats = [...new Set(PRESETS.map((b) => b.category ?? 'Other'))];
        for (const c of cats) {
          const items = PRESETS.filter((b) => (b.category ?? 'Other') === c && (!q || b.name.toLowerCase().includes(q) || (b.description ?? '').toLowerCase().includes(q) || c.toLowerCase().includes(q)));
          if (!items.length) continue;
          const hasCur = items.some((b) => b.id === curId);
          const open = !!q || (S.libOpen[c] ?? hasCur);
          const det = h('details', { class: 'mxs-libg' }) as HTMLDetailsElement; det.open = open;
          const sumTh = h('canvas', { class: 'mxs-gthumb', width: '48', height: '20' }) as HTMLCanvasElement; drawThumb(sumTh, items[0]);
          det.append(h('summary', {}, sumTh, h('b', {}, c), h('small', {}, String(items.length))));
          det.ontoggle = () => { if (!q) { S.libOpen[c] = det.open; persist(); } if (det.open && !det.dataset.filled) fillGroup(); };
          const fillGroup = () => {
            det.dataset.filled = '1';
            for (const b of items) {
              const th = h('canvas', { class: 'mxs-thumb', width: '120', height: '44' }) as HTMLCanvasElement; drawThumb(th, b);
              const btn = h('button', { class: `mxs-mot${curId === b.id ? ' on' : ''}`, title: b.description ?? '' }, th, h('span', {}, h('b', {}, b.name), h('small', {}, b.description ?? '')));
              btn.onclick = () => pick(b);
              det.append(btn);
            }
          };
          if (open) fillGroup();
          list.append(det);
        }
      };
      search.oninput = () => { libQuery = search.value; fill(); };
      const allB = h('button', { class: 'mxs-linkb' }, 'Collapse all'); allB.onclick = () => { for (const c of new Set(PRESETS.map((b) => b.category ?? 'Other'))) S.libOpen[c] = false; persist(); fill(); };
      strip.append(h('div', { class: 'mxs-strip-head' }, h('b', {}, 'Motions library'), h('small', {}, `${PRESETS.length}`), h('span', { class: 'mxs-grow' }), allB),
        h('p', { class: 'mxs-hint' }, S.motionTab === 'body' ? (target ? `Click a motion to use it in “${(target as Rule).name}”.` : 'Click a motion to start a new selection rule.') : zone ? `Click a motion to use it in zone “${zoneLabel(zone)}”.` : 'Click a motion to add it to the whole piece.'), search, list);
      fill();
      requestAnimationFrame(() => list.querySelector('.mxs-mot.on')?.scrollIntoView({ block: 'center' }));
      return;
    }
    // slice: layer map of zones
    strip.append(h('div', { class: 'mxs-strip-head' }, h('b', {}, 'Layer map')));
    const map = h('div', { class: 'mxs-lmap' });
    const H = S.design.height;
    const order = [...S.zones].reverse();
    for (const z of order) {
      const b = brushOf(z.brushId);
      map.append(h('div', { class: `mxs-lband${z.enabled ? '' : ' off'}`, style: `bottom:${z.from * 100}%;height:${Math.max(1.5, (z.to - z.from) * 100)}%`, title: `${b?.name ?? '?'} ${(z.from * H).toFixed(0)}–${(z.to * H).toFixed(0)} mm` }, h('span', {}, b?.name ?? '?')));
    }
    strip.append(map, h('p', { class: 'mxs-hint' }, S.zones.length ? 'Zones from the Motion step, bottom to top.' : 'No motion zones: plain wall.'));
  }
  const zoneLabel = (z: MotionZone) => `${Math.round(z.from * S.design.height)}–${Math.round(z.to * S.design.height)} mm`;

  // ───────── right panel
  function renderPanel() {
    right.innerHTML = '';
    right.append(h('div', { class: 'mxs-ptitle' }, 'Properties'));
    if (S.step === 'design') designPanel();
    else if (S.step === 'motion') motionPanel();
    else slicePanel();
  }

  // controls
  const row = (label: string, control: HTMLElement, hint?: string) => h('div', { class: 'mxs-row' }, h('label', {}, label), control, hint ? h('small', { class: 'mxs-rhint' }, hint) : null);
  let uid = 0;
  const num = (get: () => number, set: (v: number) => void, min: number, max: number, step: number, unit = '', after?: () => void) => {
    const id = `mxs-n${uid++}`;
    const r = h('input', { type: 'range', min: String(min), max: String(max), step: String(step), 'aria-label': unit || 'value' }) as HTMLInputElement;
    const n = h('input', { type: 'number', id, min: String(min), max: String(max), step: String(step) }) as HTMLInputElement;
    r.value = n.value = String(get());
    r.oninput = () => { n.value = r.value; set(+r.value); after?.(); };
    n.onchange = () => { const v = Math.min(max, Math.max(min, +n.value || 0)); n.value = r.value = String(v); set(v); after?.(); };
    return h('div', { class: 'mxs-num' }, r, n, h('span', { class: 'mxs-unit' }, unit));
  };
  const toggle = (get: () => boolean, set: (v: boolean) => void, after?: () => void) => { const i = h('input', { type: 'checkbox', class: 'mxs-switch' }) as HTMLInputElement; i.checked = get(); i.onchange = () => { set(i.checked); after?.(); }; return i; };
  const select = <T extends string>(opts: [T, string][], get: () => T, set: (v: T) => void, after?: () => void) => { const s = h('select', {}, ...opts.map(([v, l]) => h('option', { value: v }, l))) as HTMLSelectElement; s.value = get(); s.onchange = () => { set(s.value as T); after?.(); }; return s; };
  const group = (title: string, ...kids: (HTMLElement | null)[]) => h('section', { class: 'mxs-group' }, h('h3', {}, title), ...kids);
  const seg = <T extends string>(opts: [T, string][], get: () => T, set: (v: T) => void) => {
    const w = h('div', { class: 'mxs-seg' });
    for (const [v, l] of opts) { const b = h('button', { class: get() === v ? 'on' : '' }, l); b.onclick = () => { set(v); }; w.append(b); }
    return w;
  };
  const D = () => S.design;
  const dChange = () => changed(true);

  function designPanel() {
    right.append(seg([['shape', 'Shape'], ['relief', 'Relief'], ['look', 'Appearance']], () => S.designTab, (v) => { S.designTab = v; renderPanel(); }));
    if (S.designTab === 'shape') {
      const editor = profileEditor();
      right.append(group('Piece profile', editor.el,
        h('div', { class: 'mxs-btnrow' },
          btn('Curve', () => { D().smoothing = 0.8; dChange(); editor.draw(); }, D().smoothing > 0.4),
          btn('Straight', () => { D().smoothing = 0; dChange(); editor.draw(); }, D().smoothing <= 0.4),
          h('span', { class: 'mxs-grow' }),
          ibtn('plus', 'Add point', () => { editor.addPoint(); }), ibtn('minus', 'Remove point', () => editor.removePoint()),
          ibtn('reset', 'Reset to outline', () => { const o = OUTLINES.find((x) => x.id === D().outline); if (o) { D().profile = structuredClone(o.pts); dChange(); editor.draw(); } })),
        h('p', { class: 'mxs-hint' }, 'Drag the points. Double-click the line to add one.')));
      // outline gallery
      const gal = h('div', { class: 'mxs-gallery' });
      for (const o of OUTLINES.filter((x) => x.families.includes(D().family))) {
        const c = h('canvas', { width: '72', height: '56' }) as HTMLCanvasElement; drawOutline(c, o.pts);
        const b = h('button', { class: `mxs-gi${D().outline === o.id ? ' on' : ''}` }, c, h('span', {}, o.name));
        b.onclick = () => { D().outline = o.id; D().profile = structuredClone(o.pts); if (o.h) D().height = o.h; if (o.d) D().maxDiameter = o.d; if (o.section) D().section = o.section; dChange(); renderPanel(); };
        gal.append(b);
      }
      right.append(group('Outline · seen from the side', gal));
      const secs = h('div', { class: 'mxs-chips' });
      for (const s of SECTIONS) { const b = h('button', { class: `mxs-chip${D().section === s.id ? ' on' : ''}` }, sectionIcon(s.id), h('span', {}, s.name)); b.onclick = () => { D().section = s.id; if (s.id === 'fluted' && D().sides < 12) D().sides = 24; dChange(); renderPanel(); }; secs.append(b); }
      right.append(group('Outline · seen from above', secs,
        D().section !== 'round' ? row('Sides / lobes', num(() => D().sides, (v) => (D().sides = v), 3, 60, 1, '', dChange)) : null,
        D().section !== 'round' && D().section !== 'faceted' ? row('Depth', num(() => D().depth, (v) => (D().depth = v), 0.05, 0.5, 0.01, '', dChange)) : null));
      right.append(group('Size & shape',
        row('Height', num(() => D().height, (v) => (D().height = v), 30, 300, 1, 'mm', dChange)),
        row('Max Ø', num(() => D().maxDiameter, (v) => (D().maxDiameter = v), 30, 260, 1, 'mm', dChange)),
        row('Narrow at top', num(() => D().narrowTop, (v) => (D().narrowTop = v), -0.6, 0.6, 0.01, '', dChange), Math.abs(D().narrowTop) > 0.45 ? 'Strong taper: check the overhang.' : undefined),
        row('Twist', num(() => D().twist, (v) => (D().twist = v), 0, 360, 5, '°', dChange)),
        row('Twist shape', select([['linear', 'Even'], ['s', 'S-curve'], ['wave', 'Back and forth']], () => D().twistShape, (v) => (D().twistShape = v), dChange)),
        row('Wall', num(() => D().wall, (v) => (D().wall = v), 0.8, 6, 0.1, 'mm', dChange)),
        row('Open bottom', toggle(() => D().openBottom, (v) => (D().openBottom = v), dChange))));
    } else if (S.designTab === 'relief') {
      const groups = [...new Set(RELIEFS.map((r) => r.group))];
      const chips = h('div', { class: 'mxs-chips mxs-chips-3' });
      for (const g of groups) for (const r of RELIEFS.filter((x) => x.group === g)) {
        const b = h('button', { class: `mxs-chip${D().relief.kind === r.id ? ' on' : ''}` }, reliefIcon(r.id), h('span', {}, r.name));
        b.onclick = () => { D().relief = { ...D().relief, kind: r.id, count: r.count, depth: r.depth }; dChange(); renderPanel(); };
        chips.append(b);
      }
      const rl = D().relief;
      right.append(group('Relief / surface', chips,
        rl.kind !== 'smooth' ? row('Count', num(() => rl.count, (v) => (rl.count = v), 2, 200, 1, '', dChange)) : null,
        rl.kind !== 'smooth' ? row('Depth', num(() => rl.depth, (v) => (rl.depth = v), 0, 8, 0.1, 'mm', dChange), rl.depth > D().wall * 1.5 ? `Deeper than ${(D().wall * 1.5).toFixed(1)} mm thins the wall.` : undefined) : null,
        rl.kind !== 'smooth' ? h('div', { class: 'mxs-sub' }, h('b', {}, 'Range (where it applies)'),
          row('Start', num(() => rl.start * 100, (v) => (rl.start = v / 100), 0, 100, 1, '%', dChange)),
          row('End', num(() => rl.end * 100, (v) => (rl.end = v / 100), 0, 100, 1, '%', dChange)),
          row('Transition', num(() => rl.transition * 100, (v) => (rl.transition = v / 100), 0, 30, 1, '%', dChange))) : null,
        h('p', { class: 'mxs-hint' }, 'Mesh reliefs are part of the shape. For nozzle-path effects, add motions in the Motion step.')));
    } else {
      const c = h('input', { type: 'color', value: S.color, 'aria-label': 'Colour' }) as HTMLInputElement;
      c.oninput = () => { S.color = c.value; persist(); view.setDesign(S.design, S.color); };
      const sw = h('div', { class: 'mxs-swatches' });
      for (const col of ['#ece6dc', '#f7f7f4', '#d8b48a', '#c96f4a', '#8aa58f', '#6b7fa8', '#2e3138', '#e7c9cf']) { const b = h('button', { class: 'mxs-sw', style: `background:${col}`, 'aria-label': col }); b.onclick = () => { S.color = col; c.value = col; persist(); view.setDesign(S.design, S.color); }; sw.append(b); }
      right.append(group('Render', row('Colour', c), sw));
    }
  }
  const btn = (label: string, fn: () => void, on = false) => { const b = h('button', { class: `mxs-btn mxs-sm${on ? ' on' : ''}` }, label); b.onclick = fn; return b; };
  const ibtn = (ic: string, label: string, fn: () => void) => { const b = h('button', { class: 'mxs-ib', title: label, 'aria-label': label }, icon(ic, 14)); b.onclick = fn; return b; };

  function motionPanel() {
    right.append(seg([['body', 'Body (select & apply)'], ['layers', 'Layer zones']], () => S.motionTab, (v) => { S.motionTab = v; renderAll(); }));
    if (S.motionTab === 'body') { bodyPanel(); return; }
    const H = S.design.height;
    const list = h('div', { class: 'mxs-zones' });
    S.zones.forEach((z, i) => {
      const b = brushOf(z.brushId);
      const th = h('canvas', { class: 'mxs-thumb', width: '96', height: '32' }) as HTMLCanvasElement; if (b) drawThumb(th, b);
      const en = toggle(() => z.enabled, (v) => (z.enabled = v), () => changed(false));
      en.onclick = (e) => e.stopPropagation();
      const item = h('div', { class: `mxs-zone${S.activeZone === z.id ? ' on' : ''}`, role: 'button', tabindex: '0' }, en, th,
        h('span', {}, h('b', {}, b?.name ?? 'Missing motion'), h('small', {}, `${(z.from * H).toFixed(0)}–${(z.to * H).toFixed(0)} mm · ×${z.size}`)),
        ibtn('trash', 'Delete zone', () => { S.zones.splice(i, 1); if (S.activeZone === z.id) S.activeZone = S.zones[0]?.id ?? null; changed(false); renderAll(); }));
      item.onclick = () => { S.activeZone = z.id; renderStrip(); renderPanel(); };
      list.append(item);
    });
    const add = h('button', { class: 'mxs-btn mxs-sm' }, icon('plus', 13), 'Add zone');
    add.onclick = () => {
      const last = S.zones[S.zones.length - 1];
      const from = last ? Math.min(0.95, last.to) : 0;
      if (last && last.to > 0.5 && from >= 0.95) last.to = 0.5;
      const z = newZone(last?.brushId ?? PRESETS[0].id, last ? Math.min(last.to, 0.5) : 0, 1);
      if (last && last.to > z.from) last.to = z.from;
      S.zones.push(z); S.activeZone = z.id; changed(false); renderAll();
    };
    right.append(group('Motion zones (layer by layer)', S.zones.length ? list : h('p', { class: 'mxs-hint' }, 'No motion yet. Pick one from the library on the left, or add a zone.'), h('div', { class: 'mxs-btnrow' }, add),
      h('p', { class: 'mxs-hint' }, 'Each zone is a band of layers with its own motion. Where zones overlap, the upper one in this list wins.')));
    const z = S.zones.find((x) => x.id === S.activeZone);
    if (!z) return;
    const b = brushOf(z.brushId);
    const zc = () => { changed(false); const sm = right.querySelector('.mxs-zone.on small'); if (sm) sm.textContent = `${(z.from * H).toFixed(0)}–${(z.to * H).toFixed(0)} mm · ×${z.size}`; renderStrip(); };
    right.append(group(`Zone · ${b?.name ?? ''}`,
      b ? h('p', { class: 'mxs-picked' }, `${(b.amplitude * z.size).toFixed(2)} mm deep · every ${(b.period_mm * z.spacing).toFixed(1)} mm`) : null,
      row('From', num(() => +(z.from * H).toFixed(1), (v) => (z.from = Math.min(v / H, z.to)), 0, H, 0.2, 'mm', zc)),
      row('To', num(() => +(z.to * H).toFixed(1), (v) => (z.to = Math.max(v / H, z.from)), 0, H, 0.2, 'mm', zc)),
      row('Size', num(() => z.size, (v) => (z.size = v), 0, 4, 0.05, '×', zc)),
      row('Spacing', num(() => z.spacing, (v) => (z.spacing = v), 0.2, 5, 0.05, '×', zc)),
      row('Phase', num(() => z.phase, (v) => (z.phase = v), 0, 360, 5, '°', zc)),
      row('Fade in/out', num(() => z.fade, (v) => (z.fade = v), 0, 20, 0.5, 'mm', zc))));
    // layer stacking
    const eff = z.useBrushLayers ? b?.layers ?? null : z.layers;
    const presets = h('div', { class: 'mxs-chips mxs-chips-4' });
    for (const p of STACKS) {
      const on = !z.useBrushLayers && JSON.stringify(z.layers) === JSON.stringify(p.make());
      const pb = h('button', { class: `mxs-chip${on ? ' on' : ''}` }, h('span', {}, p.label));
      pb.onclick = () => { z.useBrushLayers = false; z.layers = p.make(); changed(false); renderPanel(); };
      presets.append(pb);
    }
    const lg = group('Layer stacking',
      row("Use motion's own", toggle(() => z.useBrushLayers, (v) => { z.useBrushLayers = v; if (!v && !z.layers) z.layers = b?.layers ? structuredClone(b.layers) : null; }, () => { changed(false); renderPanel(); })),
      presets, layerGraph(eff, H, S.slice.layerHeight));
    if (!z.useBrushLayers && z.layers) {
      const L = z.layers;
      const lc = () => { changed(false); const g = right.querySelector('.mxs-lgraph') as HTMLCanvasElement | null; if (g) drawLayerGraph(g, L, H, S.slice.layerHeight); };
      addKids(lg, 
        row('Mode', select(MODES, () => L.mode, (v) => (L.mode = v), () => { changed(false); renderPanel(); })),
        row('Shift per step', num(() => L.shift_deg, (v) => (L.shift_deg = v), -180, 180, 1, '°', lc)),
        L.mode === 'wave' || L.mode === 'alternate' ? row('Lag', num(() => L.lag_deg ?? 0, (v) => (L.lag_deg = v), 0, 180, 1, '°', lc)) : null,
        L.mode === 'wave' ? row('Wave shape', select(WAVES, () => L.wave_shape ?? 'sine', (v) => (L.wave_shape = v), lc)) : null,
        row(L.mode === 'wave' ? 'Layers per swing' : 'Layers per step', num(() => L.every, (v) => (L.every = v), 1, 200, 1, '', lc)),
        row('Motion on', num(() => L.band_on, (v) => (L.band_on = v), 0, 200, 1, 'layers', lc)),
        row('Then plain', num(() => L.band_off, (v) => (L.band_off = v), 0, 200, 1, 'layers', lc)),
        row('Cross both ways', toggle(() => !!L.cross, (v) => (L.cross = v), lc)));
    }
    right.append(lg);
  }

  // ───────── body rules (NexSpiro select & apply)
  const lhNow = () => S.slice.layerHeight;
  const activeRule = () => S.rules.find((r) => r.id === S.activeRule) ?? null;
  const ensureRule = () => { let r = activeRule(); if (!r) { r = newRule(S.rules.length + 1); S.rules.push(r); S.activeRule = r.id; renderPanel(); } return r; };
  function paintRules() {
    if (S.step !== 'motion' || S.motionTab !== 'body' || !S.rules.some((r) => r.enabled && r.rects.length)) { view.setHighlight(null); return; }
    const base = hexRgb(S.color);
    const cols = new Map(S.rules.map((r) => [r.id, hexRgb(r.color)]));
    let lastZ = NaN, prep: ReturnType<typeof prepareRules> = [];
    view.setHighlight((z, a, r) => {
      if (z !== lastZ) { lastZ = z; prep = prepareRules(S.rules, z, lhNow()); }
      if (!prep.length) return null;
      let out: [number, number, number] | null = null;
      for (const p of prep) {
        const w = ruleWeight(p, z, a, r); if (w <= 0) continue;
        const c = cols.get(p.rule.id)!, k = w * (p.rule.id === S.activeRule ? 0.9 : 0.55), b: [number, number, number] = out ?? base;
        out = [b[0] + (c[0] - b[0]) * k, b[1] + (c[1] - b[1]) * k, b[2] + (c[2] - b[2]) * k];
      }
      return out;
    });
  }
  let paintRaf = 0;
  const paintSoon = () => { cancelAnimationFrame(paintRaf); paintRaf = requestAnimationFrame(paintRules); };

  // tools in the 3D view
  const toolBar = h('div', { class: 'mxs-tools' });
  const marquee = h('div', { class: 'mxs-marquee' }); marquee.hidden = true;
  const lassoSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); lassoSvg.setAttribute('class', 'mxs-lasso');
  const lassoPath = document.createElementNS('http://www.w3.org/2000/svg', 'polyline'); lassoSvg.append(lassoPath);
  stage.append(toolBar, marquee, lassoSvg);
  const TOOLS: [Tool, string, string][] = [
    ['orbit', 'Orbit', 'Turn the view (left drag). In the other tools, right drag turns.'],
    ['line', 'Line', 'Click a printed line to select the whole line. Alt+click selects just that segment.'],
    ['segment', 'Segment', 'Click to select a short segment of one line.'],
    ['brush', 'Brush', 'Paint over the surface.'],
    ['box', 'Box', 'Drag a box: selects the visible surface inside it.'],
    ['lasso', 'Lasso', 'Draw round an area: selects the visible surface inside it.'],
    ['band', 'Band', 'Drag up or down the piece: selects every line in that height band.'],
  ];
  function renderTools() {
    const show = S.rail === 'studio' && S.step === 'motion' && S.motionTab === 'body';
    toolBar.hidden = !show;
    view.setToolMode(show && S.tool !== 'orbit');
    view.canvas.style.cursor = show && S.tool !== 'orbit' ? 'crosshair' : '';
    if (!show) return;
    toolBar.innerHTML = '';
    for (const [id, label, tip] of TOOLS) { const b = h('button', { class: `mxs-tool${S.tool === id ? ' on' : ''}`, title: tip }, label); b.onclick = () => { S.tool = id; renderTools(); }; toolBar.append(b); }
    const er = h('button', { class: `mxs-tool${S.erase ? ' on mxs-erase' : ''}`, title: 'Take away from the selection (or hold Ctrl)' }, 'Erase'); er.onclick = () => { S.erase = !S.erase; renderTools(); };
    toolBar.append(h('span', { class: 'mxs-tsep' }), er);
    if (S.tool === 'brush' || S.tool === 'segment') {
      const r = h('input', { type: 'range', min: '1', max: '40', step: '0.5', value: String(S.brushR), 'aria-label': 'Brush size', title: 'Brush size (mm)' }) as HTMLInputElement;
      const lbl = h('span', { class: 'mxs-tlbl' }, `${S.brushR} mm`);
      r.oninput = () => { S.brushR = +r.value; lbl.textContent = `${S.brushR} mm`; };
      toolBar.append(h('span', { class: 'mxs-tsep' }), r, lbl);
    }
    const rule = activeRule();
    toolBar.append(h('span', { class: 'mxs-tsep' }), h('span', { class: 'mxs-tlbl' }, rule ? h('i', { class: 'mxs-rdot', style: `background:${rule.color}` }) : '', rule ? rule.name : 'New selection'));
  }
  const ring = (z: number, neg: boolean) => ({ z0: z - lhNow() / 2, z1: z + lhNow() / 2, a0: 0, a1: 1, ...(neg ? { neg } : {}) });
  const dab = (hit: { z: number; a: number; r: number }, R: number, neg: boolean) => { const da = R / (Math.PI * 2 * Math.max(1, hit.r)); return { z0: hit.z - R, z1: hit.z + R, a0: hit.a - da, a1: hit.a + da, ...(neg ? { neg } : {}) }; };
  let drag: { tool: Tool; x: number; y: number; neg: boolean; pts: [number, number][]; z0?: number; band?: number; last?: [number, number] } | null = null;
  const cv = view.canvas;
  cv.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || toolBar.hidden || S.tool === 'orbit') return;
    const neg = S.erase || e.ctrlKey || e.metaKey;
    const hit = view.pick(e.clientX, e.clientY);
    const rule = ensureRule();
    const tool = S.tool === 'line' && e.altKey ? 'segment' : S.tool;
    if (tool === 'line') { if (hit) { rule.rects.push(ring(hit.z, neg)); commitSel(); } return; }
    if (tool === 'segment') { if (hit) { const d = dab(hit, Math.max(1.5, S.brushR / 2), neg); d.z0 = hit.z - lhNow() / 2; d.z1 = hit.z + lhNow() / 2; rule.rects.push(d); commitSel(); } return; }
    cv.setPointerCapture(e.pointerId);
    drag = { tool, x: e.clientX, y: e.clientY, neg, pts: [[e.clientX, e.clientY]] };
    if (tool === 'brush' && hit) { rule.rects.push(dab(hit, S.brushR, neg)); drag.last = [e.clientX, e.clientY]; paintSoon(); }
    if (tool === 'band' && hit) { drag.z0 = hit.z; rule.rects.push({ z0: hit.z - lhNow() / 2, z1: hit.z + lhNow() / 2, a0: 0, a1: 1, ...(neg ? { neg } : {}) }); drag.band = rule.rects.length - 1; paintSoon(); }
  });
  cv.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const rule = activeRule(); if (!rule) return;
    if (drag.tool === 'brush') {
      if (drag.last && Math.hypot(e.clientX - drag.last[0], e.clientY - drag.last[1]) < 5) return;
      const hit = view.pick(e.clientX, e.clientY); if (!hit) return;
      rule.rects.push(dab(hit, S.brushR, drag.neg)); drag.last = [e.clientX, e.clientY]; paintSoon();
    } else if (drag.tool === 'band' && drag.band != null && drag.z0 != null) {
      const hit = view.pick(e.clientX, e.clientY); if (!hit) return;
      const r = rule.rects[drag.band]; r.z0 = Math.min(drag.z0, hit.z) - lhNow() / 2; r.z1 = Math.max(drag.z0, hit.z) + lhNow() / 2; paintSoon();
    } else if (drag.tool === 'box') {
      const sr = stage.getBoundingClientRect();
      marquee.hidden = false;
      Object.assign(marquee.style, { left: `${Math.min(drag.x, e.clientX) - sr.left}px`, top: `${Math.min(drag.y, e.clientY) - sr.top}px`, width: `${Math.abs(e.clientX - drag.x)}px`, height: `${Math.abs(e.clientY - drag.y)}px` });
      marquee.classList.toggle('neg', drag.neg);
    } else if (drag.tool === 'lasso') {
      drag.pts.push([e.clientX, e.clientY]);
      const sr = stage.getBoundingClientRect();
      lassoPath.setAttribute('points', drag.pts.map(([x, y]) => `${x - sr.left},${y - sr.top}`).join(' '));
      lassoSvg.classList.add('on'); lassoSvg.classList.toggle('neg', drag.neg);
    }
  });
  cv.addEventListener('pointerup', (e) => {
    if (!drag) return;
    const d = drag; drag = null;
    const rule = activeRule();
    if (rule && d.tool === 'box') {
      marquee.hidden = true;
      const x0 = Math.min(d.x, e.clientX), x1 = Math.max(d.x, e.clientX), y0 = Math.min(d.y, e.clientY), y1 = Math.max(d.y, e.clientY);
      if (x1 - x0 > 3 && y1 - y0 > 3) rule.rects.push(...rowsToRects(view.selectScreen((x, y) => x >= x0 && x <= x1 && y >= y0 && y <= y1), d.neg));
    } else if (rule && d.tool === 'lasso') {
      lassoSvg.classList.remove('on'); lassoPath.setAttribute('points', '');
      if (d.pts.length > 4) rule.rects.push(...rowsToRects(view.selectScreen((x, y) => inPoly(x, y, d.pts)), d.neg));
    }
    commitSel();
  });
  function commitSel() { changed(false); paintRules(); renderPanel(); }

  function bodyPanel() {
    const list = h('div', { class: 'mxs-zones' });
    S.rules.forEach((r, i) => {
      const en = toggle(() => r.enabled, (v) => (r.enabled = v), () => { changed(false); paintRules(); });
      en.onclick = (e) => e.stopPropagation();
      const b = r.brushId ? brushOf(r.brushId) : null;
      const what = [b?.name, r.speed != null ? `speed ${r.speed}%` : '', r.flow != null ? `flow ${r.flow}%` : '', r.temp != null ? `${r.temp}°C` : ''].filter(Boolean).join(' · ') || 'nothing to change yet';
      const up = h('button', { class: 'mxs-linkb', disabled: i === 0 }, 'Up'); up.onclick = (e) => { e.stopPropagation(); [S.rules[i - 1], S.rules[i]] = [S.rules[i], S.rules[i - 1]]; changed(false); renderPanel(); paintRules(); };
      const dn = h('button', { class: 'mxs-linkb', disabled: i === S.rules.length - 1 }, 'Down'); dn.onclick = (e) => { e.stopPropagation(); [S.rules[i + 1], S.rules[i]] = [S.rules[i], S.rules[i + 1]]; changed(false); renderPanel(); paintRules(); };
      const del = h('button', { class: 'mxs-linkb' }, 'Delete'); del.onclick = (e) => { e.stopPropagation(); S.rules.splice(i, 1); if (S.activeRule === r.id) S.activeRule = S.rules[0]?.id ?? null; changed(false); renderAll(); paintRules(); };
      const item = h('div', { class: `mxs-zone mxs-rule${S.activeRule === r.id ? ' on' : ''}`, role: 'button', tabindex: '0', style: `--rc:${r.color}` }, en,
        h('span', {}, h('b', {}, r.name), h('small', {}, `${r.rects.filter((q) => !q.neg).length ? `${countSel(r)} · ` : 'no selection · '}${what}`), h('span', { class: 'mxs-rbtns' }, up, dn, del)));
      item.onclick = () => { S.activeRule = r.id; renderStrip(); renderPanel(); paintRules(); renderTools(); };
      list.append(item);
    });
    const add = h('button', { class: 'mxs-btn mxs-sm' }, icon('plus', 13), 'New rule');
    add.onclick = () => { const r = newRule(S.rules.length + 1); S.rules.push(r); S.activeRule = r.id; if (S.tool === 'orbit') S.tool = 'line'; changed(false); renderAll(); };
    right.append(group('Rules', S.rules.length ? list : h('p', { class: 'mxs-hint' }, 'Select parts of the piece with the tools above the view, then choose what changes there. Rules lower in the list win where two set the same thing.'), h('div', { class: 'mxs-btnrow' }, add)));
    const r = activeRule(); if (!r) return;
    const rc = () => { changed(false); const sm = right.querySelector('.mxs-rule.on small'); if (sm) sm.textContent = 'edited'; };
    const rp = () => { rc(); paintSoon(); };
    const name = h('input', { type: 'text', value: r.name, 'aria-label': 'Rule name' }) as HTMLInputElement; name.oninput = () => { r.name = name.value; rc(); };
    const color = h('input', { type: 'color', value: r.color, 'aria-label': 'Selection colour' }) as HTMLInputElement; color.oninput = () => { r.color = color.value; persist(); paintSoon(); };
    const clear = h('button', { class: 'mxs-btn mxs-sm' }, 'Clear'); clear.onclick = () => { r.rects = []; changed(false); paintRules(); renderPanel(); };
    const lineBox = (k: 'outer' | 'inner' | 'base', label: string) => h('label', { class: 'mxs-check' }, toggle(() => r.lines[k], (v) => (r.lines[k] = v), rp), label);
    right.append(group('Selected rule',
      row('Name', h('div', { class: 'mxs-inl' }, name, color)),
      row('Selection', h('div', { class: 'mxs-inl' }, h('span', { class: 'mxs-muted' }, r.rects.length ? countSel(r) : 'nothing selected'), clear)),
      h('div', { class: 'mxs-sub' }, h('b', {}, 'Reach up and down'),
        row('Layers above', num(() => r.reachUp, (v) => (r.reachUp = v), 0, 400, 1, 'layers', rp)),
        row('Layers below', num(() => r.reachDown, (v) => (r.reachDown = v), 0, 400, 1, 'layers', rp))),
      h('div', { class: 'mxs-sub' }, h('b', {}, 'Lines to change'), h('div', { class: 'mxs-checks' }, lineBox('outer', 'Outer wall'), lineBox('inner', 'Inner walls'), lineBox('base', 'Bottom layers')),
        row('Wall shape', seg([['all', 'All'], ['curved', 'Curved parts'], ['straight', 'Straight parts']], () => r.wallShape, (v) => { r.wallShape = v; rc(); renderPanel(); })))));
    const opt = (label: string, get: () => number | null, set: (v: number | null) => void, def: number, min: number, max: number, step: number, unit: string) => {
      const on = get() != null;
      const ck = toggle(() => on, (v) => { set(v ? def : null); rc(); renderPanel(); });
      return h('div', { class: `mxs-row mxs-optrow${on ? '' : ' off'}` }, h('label', {}, ck, label), on ? num(() => get() ?? def, (v) => set(v), min, max, step, unit, rc) : h('span', { class: 'mxs-muted' }, 'keep as sliced'));
    };
    const brushSel = select<string>([['', 'None'], ...PRESETS.map((b) => [b.id, `${b.category ?? ''} · ${b.name}`] as [string, string])], () => r.brushId ?? '', (v) => (r.brushId = v || null), () => { rc(); renderStrip(); renderPanel(); });
    const b = r.brushId ? brushOf(r.brushId) : null;
    const ch = group('Change there',
      row('Motion', brushSel),
      b ? row('Size', num(() => r.size, (v) => (r.size = v), 0, 4, 0.05, '×', rc)) : null,
      b ? row('Spacing', num(() => r.spacing, (v) => (r.spacing = v), 0.2, 5, 0.05, '×', rc)) : null,
      b ? row('Phase', num(() => r.phase, (v) => (r.phase = v), 0, 360, 5, '°', rc)) : null,
      b ? row('Stacking', select<string>([['own', "Motion's own"], ...STACKS.map((p) => [p.id, p.label] as [string, string])], () => (r.useBrushLayers ? 'own' : STACKS.find((p) => JSON.stringify(p.make()) === JSON.stringify(r.layers))?.id ?? 'aligned'), (v) => { if (v === 'own') r.useBrushLayers = true; else { r.useBrushLayers = false; r.layers = STACKS.find((p) => p.id === v)!.make(); } }, rc)) : null,
      opt('Speed', () => r.speed, (v) => (r.speed = v), 60, 5, 300, 1, '%'),
      opt('Flow', () => r.flow, (v) => (r.flow = v), 110, 20, 300, 1, '%'),
      opt('Temperature', () => r.temp, (v) => (r.temp = v), S.slice.nozzleTemp, 150, 320, 1, '°C'),
      row('Soft edge', num(() => r.soft, (v) => (r.soft = v), 0, 30, 0.5, 'mm', rp)),
      h('p', { class: 'mxs-hint' }, 'Temperature changes apply per layer (the hotend cannot change within a line). Rules lower in the list win where two set the same.'));
    right.append(ch);
  }
  const countSel = (r: Rule) => { const pos = r.rects.filter((q) => !q.neg), neg = r.rects.length - pos.length; return `${pos.length} patch${pos.length === 1 ? '' : 'es'}${neg ? ` · ${neg} erased` : ''}`; };

  const simBox = h('div', { class: 'mxs-simbox' });
  function renderSimStats() {
    simBox.innerHTML = '';
    if (!sim || !result) return;
    const st = sim.stats, n = result.segs.length || 1;
    const pct = (k: number) => (k / n * 100 < 0.1 && k ? '<0.1' : (k / n * 100).toFixed(1));
    const item = (cls: string, label: string, k: number, mode: ColorBy) => { const b = h('button', { class: `mxs-defect ${cls}`, title: `Show ${label.toLowerCase()} in the view` }, h('i', {}), h('span', {}, label), h('b', {}, k ? `${pct(k)}%` : 'none')); b.onclick = () => { S.colorBy = mode; view.colorBy = mode; view.recolour(); persist(); renderViewBar(); }; return b; };
    simBox.append(h('div', { class: 'mxs-simh' }, h('b', {}, 'As it will print'), h('small', {}, `real time ${fmtTime(st.seconds)} · width ${(st.minRatio * 100).toFixed(0)}–${(st.maxRatio * 100).toFixed(0)}% · sag up to ${st.maxDroop.toFixed(2)} mm`)),
      item('blob', 'Blobs / extra', st.blobs, 'defects'), item('thin', 'Thin lines', st.thin, 'defects'), item('starve', 'Hotend can’t keep up', st.starve, 'defects'), item('sag', 'Sagging lines', st.sag, 'sag'));
  }
  function slicePanel() {
    const s = S.slice, sc = () => changed(false);
    const pname = S.printer ? (S.printer.kind === 'device' ? host?.printers().find((p) => p.id === S.printer!.id)?.name : PRINTERS.find((p) => p.id === S.printer!.id)?.name) ?? '—' : '—';
    const bed = bedOfPrinter();
    const sliceB = h('button', { class: 'mxs-btn mxs-accent mxs-wide' }, icon('slice'), result && !stale ? 'Slice again' : 'Slice');
    sliceB.onclick = doSlice;
    right.append(group('Printer', h('p', { class: 'mxs-picked' }, `${pname} · bed ${bed[0]} × ${bed[1]} × ${bed[2]} mm`),
      row('Spiral vase', toggle(() => s.spiral, (v) => (s.spiral = v), sc), 'One continuous wall, no seam.'),
      row('Print upside down', toggle(() => s.flip, (v) => (s.flip = v), sc), S.design.family === 'pendant' ? 'Pendants print best flipped.' : undefined)));
    right.append(group('Thickness & layer',
      row('Layer height', num(() => s.layerHeight, (v) => (s.layerHeight = v), 0.08, 1.2, 0.02, 'mm', sc)),
      row('First layer', num(() => s.firstLayerHeight, (v) => (s.firstLayerHeight = v), 0.1, 1.2, 0.02, 'mm', sc)),
      row('Line width', num(() => s.lineWidth, (v) => (s.lineWidth = v), 0.3, 2.8, 0.01, 'mm', sc)),
      row('Bottom layers', num(() => s.baseLayers, (v) => (s.baseLayers = v), 0, 12, 1, '', sc)),
      row('Extra walls', num(() => s.innerWalls, (v) => (s.innerWalls = v), 0, 5, 1, '', sc), s.spiral && s.innerWalls ? 'Spiral vase prints one line above the base.' : undefined)));
    right.append(group('Speed & temperature',
      row('Wall speed', num(() => s.speed, (v) => (s.speed = v), 5, 300, 5, 'mm/s', sc)),
      row('First layer', num(() => s.firstLayerSpeed, (v) => (s.firstLayerSpeed = v), 5, 100, 5, 'mm/s', sc)),
      row('Max volumetric', num(() => s.maxVolumetric, (v) => (s.maxVolumetric = v), 2, 40, 0.5, 'mm³/s', sc)),
      row('Flow ratio', num(() => s.flowRatio, (v) => (s.flowRatio = v), 0.8, 1.2, 0.01, '', sc)),
      row('Hotend', num(() => s.nozzleTemp, (v) => (s.nozzleTemp = v), 150, 320, 5, '°C', sc)),
      row('Bed', num(() => s.bedTemp, (v) => (s.bedTemp = v), 0, 120, 5, '°C', sc)),
      row('Fan', num(() => s.fan, (v) => (s.fan = v), 0, 100, 5, '%', sc)),
      row('Retraction', num(() => s.retract, (v) => (s.retract = v), 0, 8, 0.1, 'mm', sc))));
    const sg = h('textarea', { rows: '4', spellcheck: 'false', 'aria-label': 'Start G-code' }) as HTMLTextAreaElement; sg.value = s.startGcode; sg.oninput = () => { s.startGcode = sg.value; sc(); };
    const eg = h('textarea', { rows: '4', spellcheck: 'false', 'aria-label': 'End G-code' }) as HTMLTextAreaElement; eg.value = s.endGcode; eg.oninput = () => { s.endGcode = eg.value; sc(); };
    const adv = h('details', { class: 'mxs-group mxs-adv' }, h('summary', {}, 'Start / end G-code'), h('label', {}, 'Start'), sg, h('label', {}, 'End'), eg);
    right.append(adv);
    const P = S.physics, pc = () => { persist(); if (result) { sim = simulate(result, S.slice, S.physics); view.setToolpath(result, [S.slice.bedX, S.slice.bedY], sim); renderSimStats(); } };
    const phys = h('details', { class: 'mxs-group mxs-adv' }, h('summary', {}, 'Print physics (preview)'),
      h('p', { class: 'mxs-hint' }, 'Used to show the print as it will come out: blobs where the nozzle slows, thin lines where it rushes or the hotend runs out of melt, sag on overhangs, seams. Set from your printer; tune after a test print.'),
      row('Acceleration', num(() => P.accel, (v) => (P.accel = v), 500, 30000, 100, 'mm/s²', pc)),
      row('Corner speed', num(() => P.scv, (v) => (P.scv = v), 1, 20, 0.5, 'mm/s', pc), 'Square corner velocity / junction speed.'),
      row('Pressure lag', num(() => P.lag * 1000, (v) => (P.lag = v / 1000), 0, 120, 1, 'ms', pc), '0 = perfect pressure advance.'),
      row('Hotend melt', num(() => P.hotendFlow, (v) => (P.hotendFlow = v), 2, 60, 0.5, 'mm³/s', pc)),
      row('Sag', num(() => P.sag, (v) => (P.sag = v), 0, 3, 0.05, '×', pc), 'Higher for hot or slow-cooling filament.'),
      row('Ooze at restarts', num(() => P.ooze, (v) => (P.ooze = v), 0, 2, 0.05, 'mm³', pc)),
      (() => { const b = h('button', { class: 'mxs-btn mxs-sm' }, 'Reset to printer'); b.onclick = () => { S.physics = physicsFor(S.slice.printer); pc(); renderPanel(); }; return b; })());
    right.append(phys);
    // output
    const outG = group('Output', sliceB);
    if (result) {
      const r = result.stats;
      outG.append(h('div', { class: 'mxs-metrics' }, ...([['Layers', String(result.layers)], ['Time', fmtTime(r.seconds)], ['Filament', `${(r.filamentMm / 1000).toFixed(1)} m · ${r.grams.toFixed(0)} g`], ['Motion', `${r.maxOffset.toFixed(2)} mm`]] as [string, string][]).map(([k, v]) => h('span', {}, h('small', {}, k), h('b', {}, v)))));
      outG.append(simBox);
      renderSimStats();
      if (result.warnings.length) outG.append(h('div', { class: 'mxs-warn' }, ...result.warnings.map((w) => h('div', {}, w))));
      if (stale) outG.append(h('p', { class: 'mxs-hint mxs-amber' }, 'You changed the piece since this slice. Slice again before printing.'));
      const dl = h('button', { class: 'mxs-btn mxs-wide' }, icon('export'), canDownload ? 'Download G-code' : 'Copy G-code');
      dl.onclick = () => { if (!result) return; if (canDownload) download(`${slug(S.design.name)}.gcode`, new Blob([result.gcode], { type: 'text/plain' })); else copy(dl, result.gcode); };
      outG.append(dl);
      // send to printer
      if (S.printer?.kind === 'device' && host) {
        const p = host.printers().find((x) => x.id === S.printer!.id);
        const prog = h('div', { class: 'mxs-prog' });
        const send = (start: boolean) => async () => {
          if (!result) return;
          try { prog.textContent = 'Uploading…'; await host.send(S.printer!.id, `${slug(S.design.name)}.gcode`, result.gcode, start, (f) => (prog.textContent = `Uploading ${Math.round(f * 100)}%`)); prog.textContent = start ? 'Print started.' : 'Uploaded.'; }
          catch (e) { prog.textContent = `Could not send: ${String((e as Error)?.message ?? e)}`; }
        };
        const sp = h('button', { class: 'mxs-btn mxs-accent mxs-wide', disabled: stale || !p || p.state === 'printing' }, icon('send'), 'Send & print'); sp.onclick = send(true);
        const up = h('button', { class: 'mxs-btn mxs-wide', disabled: !p }, 'Upload only'); up.onclick = send(false);
        outG.append(h('div', { class: 'mxs-sendbox' }, h('b', {}, p ? `${p.name} · ${p.state}${p.progress != null && p.state === 'printing' ? ` ${Math.round(p.progress * 100)}%` : ''}` : 'Printer not found'), sp, up, prog));
      } else if (host) {
        const c = h('button', { class: 'mxs-btn mxs-wide' }, icon('printer'), 'Connect a printer to send'); c.onclick = () => host.manage();
        outG.append(c);
      }
    } else outG.append(h('p', { class: 'mxs-hint' }, 'Nothing is sliced yet. Shape the piece and add motions first; slicing runs only when you press Slice.'));
    right.append(outG);
  }

  // ───────── pages (library / printers / help) replace the stage
  function renderPage() {
    page.innerHTML = '';
    if (S.rail === 'library') {
      const lib = lsArr<Saved>(LIB);
      const grid = h('div', { class: 'mxs-cards' });
      for (const f of FAMILIES) { const b = h('button', { class: 'mxs-card mxs-new' }, icon(f.id, 26), h('b', {}, `New ${f.name.toLowerCase()}`)); b.onclick = () => { S.design = defaultDesign(f.id); S.zones = []; S.rules = []; S.rail = 'studio'; S.step = 'design'; result = null; view.setToolpath(null, [0, 0]); changed(true); renderAll(); }; grid.append(b); }
      for (const p of lib) {
        const c = h('canvas', { width: '120', height: '90' }) as HTMLCanvasElement; drawOutline(c, p.design.profile);
        const open = h('button', { class: 'mxs-btn mxs-sm' }, 'Open'); open.onclick = () => { S.design = structuredClone(p.design); S.zones = structuredClone(p.zones); S.rules = structuredClone(p.rules ?? []); S.activeRule = S.rules[0]?.id ?? null; S.activeZone = S.zones[0]?.id ?? null; S.rail = 'studio'; result = null; view.setToolpath(null, [0, 0]); changed(true); renderAll(); };
        const del = h('button', { class: 'mxs-btn mxs-sm' }, 'Delete'); del.onclick = () => { ls.set(LIB, lsArr<Saved>(LIB).filter((x) => x.id !== p.id)); renderPage(); };
        grid.append(h('div', { class: 'mxs-card' }, c, h('b', {}, p.name), h('small', {}, `${p.design.family} · ${new Date(p.at).toLocaleDateString()}`), h('div', { class: 'mxs-btnrow' }, open, del)));
      }
      page.append(h('h2', {}, 'Library'), h('p', { class: 'mxs-hint' }, 'Pieces are saved in this browser.'), grid);
    } else if (S.rail === 'printers') {
      page.append(h('h2', {}, 'Printers'));
      if (!host) { page.append(h('p', { class: 'mxs-hint' }, 'Connecting, sending and controlling printers works in the Motionex desktop app (Bambu Lab LAN, Klipper/Moonraker, OctoPrint/PrusaLink and USB).')); return; }
      const ps = host.printers();
      const grid = h('div', { class: 'mxs-cards' });
      for (const p of ps) {
        const ctl = (a: 'pause' | 'resume' | 'cancel' | 'connect', ic: string, label: string) => { const b = h('button', { class: 'mxs-btn mxs-sm' }, icon(ic, 13), label); b.onclick = () => void host.control(p.id, a).catch(() => {}); return b; };
        grid.append(h('div', { class: `mxs-card mxs-pcard${S.printer?.id === p.id ? ' on' : ''}` }, icon('printer', 22), h('b', {}, p.name),
          h('small', {}, `${p.state}${p.progress != null && p.state === 'printing' ? ` · ${Math.round(p.progress * 100)}%` : ''}${p.detail ? ` · ${p.detail}` : ''}`),
          h('div', { class: 'mxs-btnrow' },
            p.state === 'offline' ? ctl('connect', 'play', 'Connect') : null,
            p.state === 'printing' ? ctl('pause', 'pause', 'Pause') : null,
            p.state === 'paused' ? ctl('resume', 'play', 'Resume') : null,
            p.state === 'printing' || p.state === 'paused' ? ctl('cancel', 'stop', 'Stop') : null,
            (() => { const b = h('button', { class: 'mxs-btn mxs-sm' }, 'Use'); b.onclick = () => { choosePrinter(`device:${p.id}`); }; return b; })())));
      }
      const m = h('button', { class: 'mxs-btn' }, icon('plus', 13), 'Add or manage printers…'); m.onclick = () => host.manage();
      page.append(ps.length ? grid : h('p', { class: 'mxs-hint' }, 'No printers yet.'), m);
    } else if (S.rail === 'help') {
      const qa: [string, string][] = [
        ['How does Motionex work?', 'Pick your printer, shape a piece in Design, add motions to bands of layers in Motion, then press Slice. The G-code is written only when you slice.'],
        ['What is a motion zone?', 'A band of layers (from / to height) with one motion from the library, its size, spacing, phase and how layers stack. Zones let a piece change motion as it grows.'],
        ['What does layer stacking do?', 'It shifts each layer’s motion against the one below: Twist climbs round the piece, Bricks offsets every few layers, Wavy snakes, Diamonds crosses both ways, Bands switches the motion on and off.'],
        ['Model or toolpath?', 'The buttons under the view show the model, the sliced toolpath, or both. The toolpath stays until you slice again; a dot on Slice means it is out of date.'],
        ['Mouse', 'Left drag orbits, right drag pans, wheel zooms. Ctrl+Z / Ctrl+Shift+Z undo and redo.'],
        ['Sending to a printer', 'In the desktop app, connect a printer under Printers (Bambu LAN, Klipper, OctoPrint, USB), choose it at the top right, slice, then Send & print.'],
      ];
      page.append(h('h2', {}, 'Help'), ...qa.map(([q, a]) => h('details', { class: 'mxs-qa' }, h('summary', {}, q), h('p', {}, a))));
    }
  }

  // ───────── estimate + view bar + layer bar
  function renderEstimate() {
    const e = estimate(S.design, S.slice.lineWidth, S.slice.layerHeight, S.slice.speed);
    estCard.innerHTML = '';
    const ok = !e.warnings.length;
    const H = S.design.height, bed = bedOfPrinter();
    const fits = e.maxDiameter <= Math.min(bed[0], bed[1]) - 4 && H <= bed[2];
    addKids(estCard, h('div', { class: 'mxs-est-h' }, h('i', { class: ok && fits ? 'ok' : 'warn' }), result && !stale ? 'Estimate · sliced' : 'Estimate · design'),
      ...([['Height', `${H.toFixed(0)} mm`], ['Max Ø', `${e.maxDiameter.toFixed(0)} mm`], ['Time', fmtTime(result && !stale ? result.stats.seconds : e.seconds)], ['Filament', result && !stale ? `${(result.stats.filamentMm / 1000).toFixed(1)} m · ${result.stats.grams.toFixed(0)} g` : `${e.meters.toFixed(1)} m · ${e.grams.toFixed(0)} g`]] as [string, string][]).map(([k, v]) => h('div', { class: 'mxs-est-r' }, h('span', {}, k), h('b', {}, v))),
      !fits ? h('div', { class: 'mxs-est-w' }, `Does not fit the ${bed[0]}×${bed[1]}×${bed[2]} mm printer.`) : null,
      ...e.warnings.map((w) => h('div', { class: 'mxs-est-w' }, w)));
  }
  function renderViewBar() {
    viewBar.innerHTML = '';
    const tog = (label: string, on: boolean, fn: () => void, disabled = false) => { const b = h('button', { class: `mxs-vt${on ? ' on' : ''}`, disabled }, icon('eye', 13), label); b.onclick = fn; return b; };
    viewBar.append(
      tog('Model', showModel, () => { showModel = !showModel; if (!showModel && !showToolpath) showToolpath = !!result; view.setVisibility(showModel, showToolpath); renderViewBar(); }),
      tog('Toolpath', showToolpath, () => { showToolpath = !showToolpath; if (!showModel && !showToolpath) showModel = true; view.setVisibility(showModel, showToolpath); renderViewBar(); renderLayerBar(); }, !result));
    if (result && showToolpath) {
      const st = seg<PathStyle>([['lines', 'Lines'], ['ribbons', 'Beads'], ['tubes', 'Tubes']], () => S.pathStyle, (v) => { S.pathStyle = v; persist(); view.setStyle(v); renderViewBar(); });
      st.classList.add('mxs-vseg'); st.title = 'Lines: fastest · Beads: real width and height of every line · Tubes: round beads for close-up (last 40 layers)';
      const cb = select<ColorBy>([['feature', 'Colour: line kind'], ['width', 'Colour: real width'], ['flow', 'Colour: material vs plan'], ['speed', 'Colour: real speed'], ['sag', 'Colour: sag'], ['defects', 'Colour: defects'], ['rules', 'Colour: rules'], ['height', 'Colour: height']], () => S.colorBy, (v) => { S.colorBy = v; view.colorBy = v; persist(); view.recolour(); renderViewBar(); });
      cb.className = 'mxs-vsel';
      viewBar.append(st, cb);
      const legend: Partial<Record<ColorBy, [string, string][]>> = {
        width: [['#2f80ed', 'thinner'], ['#cdd0d6', 'as planned'], ['#e5383b', 'wider']], flow: [['#2f80ed', 'less'], ['#cdd0d6', 'as planned'], ['#e5383b', 'more']],
        defects: [['#e5383b', 'blob'], ['#2f80ed', 'thin'], ['#7a3cff', 'hotend limit'], ['#f2a31b', 'sag']], sag: [['#cdd0d6', 'supported'], ['#f2a31b', 'droops']],
      };
      const lg = legend[S.colorBy];
      if (lg) viewBar.append(h('span', { class: 'mxs-legend' }, ...lg.map(([c, t]) => h('span', {}, h('i', { style: `background:${c}` }), t))));
      if (S.colorBy === 'feature') {
        const pk = (k: keyof typeof view.pathColors, label: string) => { const i = h('input', { type: 'color', value: view.pathColors[k], title: `${label} colour`, 'aria-label': `${label} colour` }) as HTMLInputElement; i.onchange = () => { view.pathColors[k] = i.value; view.recolour(); }; return h('label', { class: 'mxs-pk' }, i, label); };
        viewBar.append(h('span', { class: 'mxs-legend' }, pk('wall', 'Wall'), pk('motion', 'Motion'), pk('inner', 'Inner'), pk('base', 'Base')));
      }
    }
    if (showModel) {
      const sw = h('span', { class: 'mxs-vsw', title: 'Model colour' });
      for (const col of ['#ece6dc', '#f7f7f4', '#d8b48a', '#c96f4a', '#8aa58f', '#6b7fa8', '#2e3138']) { const b = h('button', { class: `mxs-sw${S.color === col ? ' on' : ''}`, style: `background:${col}`, 'aria-label': `Model colour ${col}` }); b.onclick = () => { S.color = col; persist(); view.setDesign(S.design, S.color); paintRules(); renderViewBar(); }; sw.append(b); }
      const cu = h('input', { type: 'color', value: S.color, 'aria-label': 'Custom model colour' }) as HTMLInputElement; cu.oninput = () => { S.color = cu.value; persist(); view.setDesign(S.design, S.color); paintRules(); };
      sw.append(cu); viewBar.append(sw);
    }
    staleTag.hidden = !(result && stale);
    staleTag.textContent = 'Toolpath is out of date: slice again';
    renderLayerBar();
  }
  function renderLayerBar() {
    layerBar.innerHTML = '';
    layerBar.hidden = !(result && showToolpath);
    if (!result || !showToolpath) return;
    const r = result;
    const sl = h('input', { type: 'range', min: '0', max: String(r.layers - 1), value: String(Math.min(view.maxLayer, r.layers - 1)), 'aria-label': 'Layer' }) as HTMLInputElement;
    const lbl = h('span', { class: 'mxs-lbl' });
    const upd = () => { const i = +sl.value; lbl.textContent = `layer ${i + 1}/${r.layers} · z ${r.layerZ[i].toFixed(2)}`; view.maxLayer = i; view.applyLayer(); };
    sl.oninput = upd; upd();
    layerBar.append(sl, lbl);
  }

  function renderAll() {
    updateTop(); renderRail(); renderStrip(); renderPrinterSel(); renderGate();
    const onStudio = S.rail === 'studio';
    stage.hidden = !onStudio; right.hidden = !onStudio; strip.hidden = !onStudio; page.hidden = onStudio;
    body.classList.toggle('mxs-paged', !onStudio);
    renderTools(); paintRules();
    if (onStudio) { renderPanel(); renderEstimate(); renderViewBar(); (stage.querySelector('.mxs-crumb') as HTMLElement).textContent = `Motionex · ${S.step === 'design' ? 'Design' : S.step === 'motion' ? 'Motion' : 'Slice'} · ${FAMILIES.find((f) => f.id === S.design.family)?.name}`; }
    else renderPage();
  }

  // ───────── profile editor (2D canvas)
  function profileEditor() {
    const W = 296, Hh = 230;
    const c = h('canvas', { class: 'mxs-prof', width: String(W * 2), height: String(Hh * 2), style: `width:100%;aspect-ratio:${W}/${Hh}` }) as HTMLCanvasElement;
    const rIn = h('input', { type: 'number', step: '0.5', 'aria-label': 'Point radius' }) as HTMLInputElement;
    const zIn = h('input', { type: 'number', step: '0.5', 'aria-label': 'Point height' }) as HTMLInputElement;
    const el = h('div', { class: 'mxs-profwrap' }, c, h('div', { class: 'mxs-pnums' }, h('label', {}, 'Ø'), rIn, h('label', {}, 'height'), zIn, h('span', { class: 'mxs-unit' }, 'mm')));
    let sel = 0, drag = false;
    const pad = 22, maxR = () => D().maxDiameter / 2;
    const box = () => { const s = Math.min((W - 2 * pad) / (maxR() * 1.15), (Hh - 2 * pad) / D().height); return { s, ox: W / 2 - 6, oy: Hh - pad }; };
    const toPx = (p: ProfilePoint) => { const { s, ox, oy } = box(); return [ox + p.r * maxR() * s, oy - p.t * D().height * s]; };
    const fromPx = (x: number, y: number): ProfilePoint => { const { s, ox, oy } = box(); return { r: Math.max(0.02, Math.min(1.15, (x - ox) / s / maxR())), t: Math.max(0, Math.min(1, (oy - y) / s / D().height)) }; };
    const css = (n: string) => getComputedStyle(root).getPropertyValue(n).trim();
    const draw = () => {
      const g = c.getContext('2d')!; g.setTransform(2, 0, 0, 2, 0, 0); g.clearRect(0, 0, W, Hh);
      const { s, ox, oy } = box();
      g.fillStyle = css('--mxs-soft'); g.fillRect(0, 0, W, Hh);
      g.strokeStyle = css('--mxs-line'); g.lineWidth = 1; g.font = '10px system-ui'; g.fillStyle = css('--mxs-muted');
      for (let z = 0; z <= D().height; z += 50) { const y = oy - z * s; g.beginPath(); g.moveTo(16, y); g.lineTo(W - 6, y); g.stroke(); g.fillText(String(z), 2, y + 3); }
      g.setLineDash([3, 3]); g.beginPath(); g.moveTo(ox, 6); g.lineTo(ox, Hh - 6); g.stroke(); g.setLineDash([]);
      g.fillText('axis', ox - 9, 12);
      // mirrored ghost + fill
      g.beginPath();
      for (let i = 0; i <= 100; i++) { const t = i / 100, r = profileR(D(), t) * (1 - D().narrowTop * t) * maxR(); const x = ox + r * s, y = oy - t * D().height * s; if (i) g.lineTo(x, y); else g.moveTo(x, y); }
      g.lineTo(ox, oy - D().height * s); g.lineTo(ox, oy); g.closePath(); g.fillStyle = css('--mxs-accent-soft'); g.fill();
      g.beginPath();
      for (let i = 0; i <= 100; i++) { const t = i / 100, r = profileR(D(), t) * (1 - D().narrowTop * t) * maxR(); const x = ox - r * s, y = oy - t * D().height * s; if (i) g.lineTo(x, y); else g.moveTo(x, y); }
      g.strokeStyle = css('--mxs-line'); g.stroke();
      g.beginPath();
      for (let i = 0; i <= 100; i++) { const t = i / 100, r = profileR(D(), t) * (1 - D().narrowTop * t) * maxR(); const x = ox + r * s, y = oy - t * D().height * s; if (i) g.lineTo(x, y); else g.moveTo(x, y); }
      g.strokeStyle = css('--mxs-accent'); g.lineWidth = 2; g.stroke();
      D().profile.forEach((p, i) => { const [x, y] = toPx(p); g.beginPath(); g.arc(x, y, i === sel ? 5.5 : 4.5, 0, Math.PI * 2); g.fillStyle = i === sel ? css('--mxs-accent') : css('--mxs-panel'); g.fill(); g.strokeStyle = css('--mxs-accent'); g.lineWidth = 2; g.stroke(); });
      const p = D().profile[sel];
      if (p) { const [x, y] = toPx(p); g.fillStyle = css('--mxs-text'); g.font = '600 10px system-ui'; g.fillText(`Ø ${(p.r * maxR() * 2).toFixed(1)} mm`, Math.min(W - 70, x + 8), y - 8); rIn.value = (p.r * maxR() * 2).toFixed(1); zIn.value = (p.t * D().height).toFixed(1); }
    };
    const pos = (e: PointerEvent) => { const r = c.getBoundingClientRect(); return [((e.clientX - r.left) / r.width) * W, ((e.clientY - r.top) / r.height) * Hh]; };
    c.onpointerdown = (e) => {
      const [x, y] = pos(e); let best = -1, bd = 12;
      D().profile.forEach((p, i) => { const [px, py] = toPx(p); const d = Math.hypot(px - x, py - y); if (d < bd) { bd = d; best = i; } });
      if (best >= 0) { sel = best; drag = true; c.setPointerCapture(e.pointerId); draw(); }
    };
    c.onpointermove = (e) => { if (!drag) return; const [x, y] = pos(e); const np = fromPx(x, y); const pts = D().profile; const p = pts[sel]; const sorted = [...pts].sort((a, b) => a.t - b.t); const isEnd = p === sorted[0] || p === sorted[sorted.length - 1]; p.r = np.r; if (!isEnd || pts.length < 2) p.t = np.t; draw(); liveMesh(); clearTimeout(meshTimer); meshTimer = window.setTimeout(renderEstimate, 60); };
    c.onpointerup = () => { if (drag) { drag = false; changed(true); } };
    c.ondblclick = (e) => { const [x, y] = pos(e as unknown as PointerEvent); const np = fromPx(x, y); D().profile.push(np); D().profile.sort((a, b) => a.t - b.t); sel = D().profile.indexOf(np); dChange(); draw(); };
    rIn.onchange = () => { const p = D().profile[sel]; if (p) { p.r = Math.max(0.02, +rIn.value / 2 / maxR()); dChange(); draw(); } };
    zIn.onchange = () => { const p = D().profile[sel]; if (p) { p.t = Math.max(0, Math.min(1, +zIn.value / D().height)); D().profile.sort((a, b) => a.t - b.t); sel = D().profile.indexOf(p); dChange(); draw(); } };
    const addPoint = () => { const pts = [...D().profile].sort((a, b) => a.t - b.t); let gi = 0, gap = 0; for (let i = 0; i < pts.length - 1; i++) if (pts[i + 1].t - pts[i].t > gap) { gap = pts[i + 1].t - pts[i].t; gi = i; } const t = (pts[gi].t + pts[gi + 1].t) / 2; const np = { r: profileR(D(), t), t }; D().profile.push(np); D().profile.sort((a, b) => a.t - b.t); sel = D().profile.indexOf(np); dChange(); draw(); };
    const removePoint = () => { if (D().profile.length <= 2) return; D().profile.splice(sel, 1); sel = Math.max(0, sel - 1); dChange(); draw(); };
    requestAnimationFrame(draw);
    return { el, draw, addPoint, removePoint };
  }

  // ───────── boot
  view.setTheme(root.dataset.theme === 'dark' || (!root.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches));
  view.setDesign(S.design, S.color);
  renderAll();
  return () => { offHost(); window.removeEventListener('keydown', onKey); view.dispose(); root.innerHTML = ''; root.classList.remove('mxs'); };
}

// ───────── helpers
function hexRgb(hex: string): [number, number, number] { const n = parseInt(hex.slice(1), 16); return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; }
function inPoly(x: number, y: number, pts: [number, number][]) { let inside = false; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) { const [xi, yi] = pts[i], [xj, yj] = pts[j]; if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside; } return inside; }
function addKids(el: HTMLElement, ...kids: (Node | string | null | false)[]) { for (const k of kids) if (k !== null && k !== false) el.append(k); }
function slug(s: string) { return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'motionex'; }
function download(name: string, blob: Blob) { const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000); }
function flash(b: HTMLButtonElement, text: string) { const old = [...b.childNodes]; b.textContent = text; setTimeout(() => { b.textContent = ''; b.append(...old); }, 1400); }
async function copy(b: HTMLButtonElement, text: string) { try { await navigator.clipboard.writeText(text); flash(b, 'Copied'); } catch { flash(b, 'Copy blocked here'); } }

function drawThumb(c: HTMLCanvasElement, b: MotionBrush) {
  const g = c.getContext('2d'); if (!g) return;
  const pts = motionSamples(b, 120);
  g.strokeStyle = '#ef6c2a'; g.lineWidth = 2; g.lineJoin = 'round'; g.beginPath();
  pts.forEach(([u, v], i) => { const x = 4 + (u / 2) * (c.width - 8), y = c.height / 2 - v * (c.height / 2 - 5); if (i) g.lineTo(x, y); else g.moveTo(x, y); });
  g.stroke();
}
function drawOutline(c: HTMLCanvasElement, pts: ProfilePoint[]) {
  const g = c.getContext('2d'); if (!g) return;
  const d = { ...defaultDesign('vase'), profile: pts, smoothing: 0.8 } as Design;
  const W = c.width, H = c.height, m = 6, s = Math.min((W - 2 * m) / 2.2, H - 2 * m);
  g.clearRect(0, 0, W, H); g.beginPath();
  for (let i = 0; i <= 40; i++) { const t = i / 40, r = profileR(d, t); const x = W / 2 + r * s, y = H - m - t * (H - 2 * m); if (i) g.lineTo(x, y); else g.moveTo(x, y); }
  for (let i = 40; i >= 0; i--) { const t = i / 40, r = profileR(d, t); g.lineTo(W / 2 - r * s, H - m - t * (H - 2 * m)); }
  g.closePath(); g.fillStyle = 'rgba(239,108,42,0.14)'; g.fill(); g.strokeStyle = '#ef6c2a'; g.lineWidth = 1.5; g.stroke();
}
function sectionIcon(id: string) {
  const d = { ...defaultDesign('vase'), section: id, sides: id === 'fluted' ? 16 : 6, depth: 0.25 } as Design;
  const c = document.createElement('canvas'); c.width = 40; c.height = 40; const g = c.getContext('2d')!;
  // reuse the real surface at mid height for an exact icon
  {
    const f = makeSurface({ ...d, profile: [{ r: 1, t: 0 }, { r: 1, t: 1 }], maxDiameter: 32, relief: { ...d.relief, kind: 'smooth' } });
    g.beginPath(); for (let i = 0; i <= 120; i++) { const th = (i / 120) * Math.PI * 2, r = f(50, th); const x = 20 + r * Math.cos(th), y = 20 + r * Math.sin(th); if (i) g.lineTo(x, y); else g.moveTo(x, y); }
    g.strokeStyle = '#8a8f99'; g.lineWidth = 1.6; g.stroke();
  }
  return c;
}
function reliefIcon(id: string) {
  const c = document.createElement('canvas'); c.width = 40; c.height = 28; const g = c.getContext('2d')!;
  g.strokeStyle = '#8a8f99'; g.lineWidth = 1.4;
  const line = (f: (x: number) => number, y0: number) => { g.beginPath(); for (let x = 2; x <= 38; x++) { const y = y0 + f(x); if (x === 2) g.moveTo(x, y); else g.lineTo(x, y); } g.stroke(); };
  switch (id) {
    case 'smooth': g.beginPath(); g.arc(20, 14, 9, 0, Math.PI * 2); g.stroke(); break;
    case 'ribbed': case 'grooves': case 'fins': for (let x = 6; x <= 34; x += id === 'fins' ? 9 : 5) { g.beginPath(); g.moveTo(x, 4); g.lineTo(x, 24); g.stroke(); } break;
    case 'rings': for (let y = 6; y <= 22; y += 5) { g.beginPath(); g.moveTo(4, y); g.lineTo(36, y); g.stroke(); } break;
    case 'wavy': case 'guilloche': case 'vwaves': for (let y = 7; y <= 21; y += 7) line((x) => 2.5 * Math.sin(x / 3 + (id === 'guilloche' ? y : 0)), y); break;
    case 'bubbles': case 'bumps': for (let x = 8; x <= 32; x += 8) for (let y = 8; y <= 20; y += 8) { g.beginPath(); g.arc(x + (y % 16 ? 4 : 0), y, 3, 0, Math.PI * 2); g.stroke(); } break;
    case 'pyramid': case 'diamond': for (let x = 6; x <= 30; x += 8) { g.beginPath(); g.moveTo(x, 20); g.lineTo(x + 4, 8); g.lineTo(x + 8, 20); g.stroke(); } break;
    default: for (let i = 0; i < 26; i++) { g.beginPath(); g.arc(4 + ((i * 37) % 32), 4 + ((i * 53) % 20), 1, 0, Math.PI * 2); g.stroke(); }
  }
  return c;
}
function layerGraph(eff: LayerEffect | null, H: number, lh: number) {
  const c = document.createElement('canvas'); c.className = 'mxs-lgraph'; c.width = 560; c.height = 120;
  drawLayerGraph(c, eff, H, lh); return c;
}
function drawLayerGraph(c: HTMLCanvasElement, eff: LayerEffect | null, H: number, lh: number) {
  {
    const g = c.getContext('2d')!; const W = c.width, Hh = c.height;
    g.clearRect(0, 0, W, Hh);
    const n = Math.min(400, Math.max(10, Math.round(H / lh)));
    // each layer: a short wave shifted by its phase; off layers drawn grey
    for (let i = 0; i < n; i++) {
      const ph = effectPhase(eff, i), y = Hh - 4 - (i / n) * (Hh - 8);
      g.beginPath();
      for (let x = 0; x <= W; x += 4) { const v = ph === null ? 0 : Math.sin(((x / W) * 4 + ph / 360) * Math.PI * 2); const yy = y - v * 1.6; if (x) g.lineTo(x, yy); else g.moveTo(x, yy); }
      g.strokeStyle = ph === null ? 'rgba(140,145,155,0.35)' : `hsla(${20 + (i / n) * 20},85%,55%,0.7)`; g.lineWidth = 1; g.stroke();
    }
  }
}
