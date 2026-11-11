// Patternex Studio: paint a colourwork chart and see it on the object as you paint. Left: Pattern, Object, Grid,
// Size and Filaments cards. Top: the object with the chart wrapped round it (or on its front), live. Bottom:
// the chart editor. Once the chart is on the model every edit is applied there too (no Apply button).
import { useEffect, useRef, useState } from 'react';
import { useStore } from '../../../state/store';
import { plateObjects } from '../../../state/slicing';
import { printerById } from '../../../profiles/printers';
import { autoChanges, changerLabel } from '../../../profiles/changer';
import { filamentById } from '../../../profiles/filaments';
import { FilamentLibrary, FilamentSlots, IconButton, LiveBadge, Num, PaintPicker, Row, Seg, SideCard, SlotChip, Stat, StudioWindow, Tabs, ToolGroup, VSep } from '../../../ui/studio/Studio';
import { BASE, CHART_LIMITS, CHART_PRESETS, cellAt, chartPreset, chartSize, estimateChanges, mirrorChart, normalizeChart, resizeChart, usedSlots, type ChartSpec } from '../chart';
import { DEFAULT_TRANSITION_VOLUME } from '../engine';
import { ChartCanvas } from './ChartCanvas';
import { ChartPreview, type PreviewControls } from './ChartPreview';
import { cs, deleteSavedChart, openPatternexStudio, patchSpec, placeChart, redoChart, removeChart, saveChart, savedCharts, setHover, setPaint, setSpec, setTarget, setTool, setZoom, targetObject, undoChart, useChartStudio, valueColour, wrapGeometry } from './chartStudio';
import { usePatternex } from './PatternexPanel';

export function PatternexStudioHost() {
  useChartStudio();
  const installed = useStore((s) => s.plugins.includes('patternex'));
  if (!installed || !cs.open) return null;
  return <PatternexStudio />;
}

type View = 'model' | 'flat';

function PatternexStudio() {
  useChartStudio();
  usePatternex();
  const { filaments, objects, printerId, overrides, activePlate } = useStore();
  const [view, setView] = useState<View>('model');
  const [lib, setLib] = useState<number | null>(null);
  const [spin, setSpin] = useState(false);
  const ctl = useRef<PreviewControls | null>(null);
  const spec = cs.spec;
  const object = targetObject();
  const baseSlot = object?.filament ?? 0;
  const base = filaments[baseSlot]?.color ?? '#cccccc';
  const colour = (v: number) => valueColour(v, filaments, base);
  const machine = printerById(printerId).machine;
  const ams = autoChanges(machine);
  const geo = object ? wrapGeometry(object) : null;
  const size = geo ? chartSize(spec, geo.circumference) : null;
  const lh = Number(overrides.layer_height) || 0.2;
  const changes = estimateChanges(spec, lh, baseSlot);
  const density = filamentById(filaments[0]?.presetId ?? 'generic-pla').density;
  const purgeG = (changes * DEFAULT_TRANSITION_VOLUME * density) / 1000;
  const overTop = geo && size ? geo.zMin + spec.startZ + size.height - geo.zMax : 0;
  const missing = usedSlots(spec).filter((k) => k >= filaments.length);
  const placed = !!cs.placementId;

  // keyboard: 1–9 slots, 0 eraser, B/G/I tools, Ctrl+Z / Ctrl+Y
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.stopImmediatePropagation(); if (e.shiftKey) redoChart(); else undoChart(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); e.stopImmediatePropagation(); redoChart(); return; }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (/^[1-9]$/.test(e.key)) { const s = Number(e.key) - 1; if (s < useStore.getState().filaments.length) setPaint(s); }
      else if (e.key === '0') setPaint(BASE);
      else if (e.key.toLowerCase() === 'b') setTool('pen');
      else if (e.key.toLowerCase() === 'g') setTool('fill');
      else if (e.key.toLowerCase() === 'i') setTool('pick');
    };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, []);

  const plateObjs = plateObjects(activePlate).filter((o) => o.printable !== false);

  const side = (
    <>
      <SideCard title="Pattern" id="px-pattern">
        <Row label="Name"><input className="st-text" value={spec.name} aria-label="Pattern name" onChange={(e) => setSpec({ ...spec, name: e.target.value }, { history: false })} /></Row>
        <div className="st-tiles" style={{ gridTemplateColumns: 'repeat(5, 1fr)' }}>
          {CHART_PRESETS.map((p) => <PresetTile key={p.id} name={p.name} spec={p.make()} colour={colour} onPick={() => setSpec(normalizeChart({ ...p.make(), startZ: spec.startZ }))} />)}
        </div>
        <SavedMenu />
        <div className={`st-status ${placed ? 'ok' : ''}`}><b>●</b> {placed ? 'On the model · every change is applied live' : object ? 'Not on the model yet' : 'Add an object to the plate first'}</div>
        <div className="st-btns">
          {placed ? <button className="st-btn" onClick={removeChart}>Remove from model</button>
            : <button className="st-btn primary" disabled={!object} onClick={placeChart} title="Put this chart on the object; after that, edits apply as you make them">Place on model</button>}
        </div>
      </SideCard>
      <SideCard title="Object" id="px-object">
        <Row label="On">
          <select className="st-sel" style={{ flex: 1, minWidth: 0 }} value={object?.id ?? ''} aria-label="Object" onChange={(e) => setTarget(e.target.value)}>
            {!plateObjs.length && <option value="">No objects</option>}
            {plateObjs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        </Row>
        {geo && <div className="st-hint">{(geo.R * 2).toFixed(1)} mm across · {(geo.zMax - geo.zMin).toFixed(1)} mm tall · base colour <SlotChip slot={baseSlot} color={base} /></div>}
      </SideCard>
      <SideCard title="Grid" id="px-grid">
        <Row title="Cells across one repeat × how many repeats round the object">
          <Num label="Cells across" value={spec.cols} min={CHART_LIMITS.cols[0]} max={CHART_LIMITS.cols[1]} onChange={(v) => setSpec(resizeChart(spec, v, spec.rows))} /><span className="st-unit">cells</span><span className="st-x">×</span>
          <Num label="Repeats across" value={spec.repX} min={1} max={CHART_LIMITS.rep[1]} onChange={(v) => patchSpec({ repX: v })} /><span className="st-unit">{spec.projection === 'wrap' ? 'around' : 'across'}</span>
        </Row>
        <Row title="Rows up one repeat × how many repeats upwards">
          <Num label="Rows" value={spec.rows} min={CHART_LIMITS.rows[0]} max={CHART_LIMITS.rows[1]} onChange={(v) => setSpec(resizeChart(spec, spec.cols, v))} /><span className="st-unit">rows</span><span className="st-x">×</span>
          <Num label="Repeats up" value={spec.repY} min={1} max={CHART_LIMITS.rep[1]} onChange={(v) => patchSpec({ repY: v })} /><span className="st-unit">up</span>
        </Row>
        <Row label="Project"><Seg label="Projection" value={spec.projection} options={[['wrap', 'Wrap around', 'Round the whole object'], ['front', 'Front', 'Flat on the front only']]} onChange={(v) => patchSpec({ projection: v })} /></Row>
      </SideCard>
      <SideCard title="Size" id="px-size">
        <Row label="Row height" title="Height of one row; a whole number of layers prints cleanest"><Num label="Row height (mm)" value={spec.cellH} step={lh} digits={2} min={CHART_LIMITS.cellH[0]} max={CHART_LIMITS.cellH[1]} onChange={(v) => patchSpec({ cellH: v })} /><span className="st-unit">mm</span></Row>
        {spec.projection === 'front' && <Row label="Cell width"><Num label="Cell width (mm)" value={spec.cellW} step={0.2} digits={2} min={CHART_LIMITS.cellW[0]} max={CHART_LIMITS.cellW[1]} onChange={(v) => patchSpec({ cellW: v })} /><span className="st-unit">mm</span></Row>}
        <Row label="Starts at" title="Bottom of the chart above the object's base"><Num label="Start height (mm)" value={spec.startZ} step={0.5} digits={1} min={0} max={CHART_LIMITS.startZ[1]} onChange={(v) => patchSpec({ startZ: v })} /><span className="st-unit">mm up</span></Row>
        {size && <div className="st-hint">Cell {size.cellW.toFixed(2)} × {spec.cellH.toFixed(2)} mm · {Math.max(1, Math.round(spec.cellH / lh))} layers a row at {lh} mm · chart {size.width.toFixed(0)} × {size.height.toFixed(1)} mm{Math.abs(spec.cellH / lh - Math.round(spec.cellH / lh)) > 0.05 ? ' · not a whole number of layers' : ''}</div>}
      </SideCard>
      <SideCard title="Filaments" id="px-fil">
        <FilamentSlots active={cs.paint} onPick={setPaint} onLibrary={setLib} note={<span className={`st-badge ${ams ? '' : 'warn'}`} title={ams ? 'Automatic filament changes' : 'Manual swaps: the printer pauses at each change'}>{ams ? `${changerLabel(machine)} ✓` : 'Manual swaps'}</span>} />
        {missing.length > 0 && <div className="st-hint" style={{ color: 'var(--ns-warn)' }}>The chart uses filament {missing.map((k) => k + 1).join(', ')}, which is not loaded: add slots or repaint.</div>}
      </SideCard>
      <SideCard title="Print check" id="px-check" defaultOpen={false} right={<span className={`st-badge ${overTop > 0.01 || missing.length ? 'warn' : ''}`}>{overTop > 0.01 || missing.length ? 'Look at this' : 'All good'}</span>}>
        <div className="st-hint">{overTop > 0.01 ? `The chart runs ${overTop.toFixed(1)} mm past the top of the object; that part is not printed.` : 'The chart fits on the object.'}</div>
        <div className="st-hint">Estimates before slicing; slice for the exact colour changes, purge and time.</div>
      </SideCard>
    </>
  );

  const rail = (
    <>
      <small>Paint</small>
      {filaments.map((f, k) => <button key={k} className={`st-sw ${cs.paint === k ? 'on' : ''}`} style={{ background: f.color }} title={`Paint with filament ${k + 1}`} aria-label={`Paint with filament ${k + 1}`} onClick={() => setPaint(k)} />)}
      <button className={`st-sw ${cs.paint === BASE ? 'on' : ''}`} style={{ background: base, opacity: 0.6 }} title="Eraser (base colour)" aria-label="Eraser" onClick={() => setPaint(BASE)} />
      <small>Tool</small>
      <IconButton icon={cs.tool === 'fill' ? 'fill' : cs.tool === 'pick' ? 'pick' : 'pen'} title="Current tool" on onClick={() => setTool(cs.tool === 'pen' ? 'fill' : 'pen')} />
    </>
  );

  const stage = (
    <>
      <Tabs value={view} options={[['model', 'Model'], ['flat', 'Flat']]} onChange={setView} />
      {view === 'model' ? (
        object ? <ChartPreview object={object} spec={spec} colour={colour} base={base} controls={ctl} /> : <div className="st-live" style={{ top: '45%', left: '50%', transform: 'translateX(-50%)', bottom: 'auto' }}>Add an object to the plate to see the chart on it.</div>
      ) : <FlatView spec={spec} colour={colour} width={size?.width ?? spec.cellW * spec.cols * spec.repX} />}
      <div className="st-stats">
        <Stat label="Colour changes (est.)" value={changes.toLocaleString()} tone={changes > 2000 ? 'warn' : undefined} />
        <Stat label={`Purge (est., ${ams ? 'full' : 'manual'})`} value={`${purgeG.toFixed(0)} g`} />
        {size && <Stat label="Chart size" value={`${size.width.toFixed(0)} × ${size.height.toFixed(1)} mm`} tone={overTop > 0.01 ? 'warn' : undefined} />}
      </div>
      <LiveBadge text={placed ? 'Live · painted cells appear on the model as you paint' : 'Preview · place it on the model when it looks right'} />
      {view === 'model' && object && (
        <div className="st-toolbar br">
          <span className="st-ttl">Preview</span>
          <ToolGroup label="Zoom"><IconButton icon="fit" title="Fit the object" onClick={() => ctl.current?.fit()} /></ToolGroup>
          <ToolGroup label="Rotate">
            <IconButton icon="undo" title="Turn left 45°" onClick={() => ctl.current?.rotate(-45)} />
            <IconButton icon="redo" title="Turn right 45°" onClick={() => ctl.current?.rotate(45)} />
            <IconButton icon="rot" title="Spin slowly" on={spin} onClick={() => { ctl.current?.setSpin(!spin); setSpin(!spin); }} />
          </ToolGroup>
        </div>
      )}
    </>
  );

  const editor = (
    <>
      <div className="st-editor-head">
        <span className="st-ttl">Chart</span>
        <ToolGroup label="Zoom">
          <button className="st-ib" title="Smaller cells" aria-label="Smaller cells" onClick={() => setZoom((cs.zoom || 14) - 2)}>−</button>
          <span className="st-num" style={{ width: 46, display: 'grid', placeItems: 'center' }}>{cs.zoom ? `${Math.round((cs.zoom / 14) * 100)}%` : 'Fit'}</span>
          <IconButton icon="plus" title="Bigger cells" onClick={() => setZoom((cs.zoom || 14) + 2)} />
          <IconButton icon="fit" title="Fit the chart" on={!cs.zoom} onClick={() => setZoom(0)} />
        </ToolGroup>
        <VSep />
        <ToolGroup label="Edit">
          <IconButton icon="undo" title="Undo (Ctrl+Z)" disabled={!cs.undo.length} onClick={undoChart} />
          <IconButton icon="redo" title="Redo (Ctrl+Y)" disabled={!cs.redo.length} onClick={redoChart} />
          <IconButton icon="mirrorX" title="Mirror left–right" onClick={() => setSpec(mirrorChart(spec, 'x'))} />
          <IconButton icon="mirrorY" title="Flip upside down" onClick={() => setSpec(mirrorChart(spec, 'y'))} />
          <IconButton icon="clear" title="Clear the chart" onClick={() => setSpec({ ...spec, cells: spec.cells.map(() => BASE) })} />
        </ToolGroup>
        <VSep />
        <ToolGroup label="Paint">
          <IconButton icon="pen" title="Pen (B) · right-drag erases" on={cs.tool === 'pen'} onClick={() => setTool('pen')} />
          <IconButton icon="fill" title="Fill (G)" on={cs.tool === 'fill'} onClick={() => setTool('fill')} />
          <IconButton icon="pick" title="Pick a colour from the chart (I)" on={cs.tool === 'pick'} onClick={() => setTool('pick')} />
          <PaintPicker value={cs.paint} onChange={setPaint} onAdd={() => { const s = useStore.getState(); if (s.filaments.length < 16) { s.set({ filaments: [...s.filaments, { presetId: s.filaments[s.filaments.length - 1].presetId, color: '#1F6F78' }], flushMatrix: null }); setPaint(s.filaments.length); setLib(s.filaments.length); } }} />
        </ToolGroup>
        <span style={{ flex: 1 }} />
        <button className="st-btn" onClick={() => { saveChart(spec); useStore.getState().set({ toast: { kind: 'info', text: `Saved “${spec.name}” to your charts.` } }); }}>Save to my charts</button>
      </div>
      <div className="st-editor-body"><ChartCanvas spec={spec} colour={colour} tool={cs.tool} paint={cs.paint} zoom={cs.zoom} /></div>
    </>
  );

  return (
    <StudioWindow name="Patternex" letter="P" gradient="linear-gradient(135deg,#8E1B2C,#F59E0B)" onClose={() => openPatternexStudio(false)}
      version="Charts" side={side} rail={rail} stage={stage} editor={editor} editorHeight={300}
      links={[{ label: 'Shortcuts', onClick: () => useStore.getState().set({ toast: { kind: 'info', text: '1–9 paint colour · 0 eraser · B pen · G fill · I pick · right-drag erases · Ctrl+Z / Ctrl+Y · Esc closes' } }) }]}
      overlay={lib !== null && lib < filaments.length ? <FilamentLibrary slot={lib} onHover={(hex) => setHover(hex ? { slot: lib, hex } : null)} onClose={() => setLib(null)} /> : null} />
  );
}

/** Small picture of a chart tile, used for presets. */
function PresetTile({ name, spec, colour, onPick }: { name: string; spec: ChartSpec; colour: (v: number) => string; onPick: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current!, W = 40, H = 22, dpr = 2;
    c.width = W * dpr; c.height = H * dpr; c.style.width = `${W}px`; c.style.height = `${H}px`;
    const g = c.getContext('2d')!;
    g.scale(dpr, dpr);
    const z = Math.max(1, Math.min(W / Math.min(spec.cols * 3, 40), H / spec.rows));
    for (let y = 0; y * z < H; y++) for (let x = 0; x * z < W; x++) {
      g.fillStyle = colour(cellAt(spec, x % spec.cols, (spec.rows - 1 - (y % spec.rows))));
      g.fillRect(x * z, y * z, z + 0.3, z + 0.3);
    }
  });
  return <button className="st-tile" onClick={onPick} title={`Start from: ${name}`}><canvas ref={ref} />{name}</button>;
}

function SavedMenu() {
  const [list, setList] = useState(savedCharts);
  useEffect(() => { const t = setInterval(() => setList(savedCharts()), 1500); return () => clearInterval(t); }, []);
  if (!list.length) return null;
  return (
    <Row label="My charts">
      <select className="st-sel" style={{ flex: 1, minWidth: 0 }} value="" aria-label="Open a saved chart" onChange={(e) => { const s = list.find((x) => x.name === e.target.value); if (s) setSpec(normalizeChart(s)); }}>
        <option value="">Open…</option>
        {list.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
      </select>
      <IconButton icon="clear" title="Delete the open chart from My charts" onClick={() => { deleteSavedChart(cs.spec.name); setList(savedCharts()); }} />
    </Row>
  );
}

/** The whole chart unrolled flat at its real proportions. */
function FlatView({ spec, colour, width }: { spec: ChartSpec; colour: (v: number) => string; width: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [sz, setSz] = useState({ w: 800, h: 400 });
  useEffect(() => { const el = box.current!; const ro = new ResizeObserver(() => setSz({ w: el.clientWidth, h: el.clientHeight })); ro.observe(el); return () => ro.disconnect(); }, []);
  useEffect(() => {
    const c = ref.current!, dpr = Math.min(2, window.devicePixelRatio || 1);
    const cols = spec.cols * spec.repX, rows = spec.rows * spec.repY;
    const height = spec.cellH * rows, cw = width / cols;
    const s = Math.min((sz.w - 80) / width, (sz.h - 140) / height);
    const W = width * s, H = height * s;
    c.width = sz.w * dpr; c.height = sz.h * dpr; c.style.width = `${sz.w}px`; c.style.height = `${sz.h}px`;
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, sz.w, sz.h);
    const x0 = (sz.w - W) / 2, y0 = (sz.h - H) / 2 + 20;
    for (let R = 0; R < rows; R++) for (let C = 0; C < cols; C++) {
      g.fillStyle = colour(cellAt(spec, C % spec.cols, R % spec.rows));
      g.fillRect(x0 + C * cw * s, y0 + H - (R + 1) * spec.cellH * s, cw * s + 0.4, spec.cellH * s + 0.4);
    }
    g.strokeStyle = 'rgba(0,0,0,.25)'; g.strokeRect(x0, y0, W, H);
    g.fillStyle = getComputedStyle(c).getPropertyValue('--ns-text-3') || '#888';
    g.font = '11px sans-serif'; g.textAlign = 'center';
    g.fillText(`${width.toFixed(0)} mm ${spec.projection === 'wrap' ? 'round the object (seam at the back, centre faces the front)' : 'across the front'}`, sz.w / 2, y0 + H + 18);
  });
  return <div ref={box} style={{ position: 'absolute', inset: 0 }}><canvas ref={ref} className="st-canvas" /></div>;
}

export { openPatternexStudio };
