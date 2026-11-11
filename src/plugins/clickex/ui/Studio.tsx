// Clickex Studio: a full-window editor over NexSpiro, laid out like MakerWorld's clicker generator.
// Left: icon rail and the settings of the selected tab. Centre: the live 3D view (assembled, exploded, or as
// it prints) with the real switch. Right: where the design comes from, and the ways out.
import { useEffect } from 'react';
import { Live3D } from '../../../ui/Live3D';
import { PRINTERS, printerById } from '../../../profiles/printers';
import { useStore } from '../../../state/store';
import type { DesignMode } from '../model';
import { Ico, Note } from './controls';
import { PanelById, tabsFor } from './Panels';
import { IconButton, LiveBadge, Row, Seg, SideCard, Stat, StudioWindow, ToolGroup } from '../../../ui/studio/Studio';
import { SourcePanel } from './Sources';
import { Viewer } from './Viewer';
import { changed, compute, cx, download3mf, openStudio, resetDesign, saveDesign, say, setTab, transferToPlate, undoHistory, useCx, type View } from './state';
import { UndoRedo } from '../../../ui/studio/UndoRedo';

export function ClickexStudioHost() {
  useCx();
  const installed = useStore((s) => s.plugins.includes('clickex'));
  if (!installed || !cx.studioOpen || typeof document === 'undefined') return null;
  return <Studio />;
}

const VIEWS: [View, string][] = [['assembled', 'Assembled'], ['exploded', 'Exploded'], ['print', 'Print layout']];
const MODES: [DesignMode, string][] = [['color', 'Color'], ['raise', 'Raise'], ['engrave', 'Engrave']];

function PlateSelect() {
  const s = useStore();
  const p = printerById(s.printerId);
  return (
    <label className="cx-plate" title="Build plate of the printer you are designing for">
      <Ico name="printer" size={15} />
      <select value={s.printerId} onChange={(e) => { const np = PRINTERS.find((x) => x.id === e.target.value)!; s.set({ printerId: np.id, plate: np.plates.some((x) => x.type === s.plate) ? s.plate : np.plates[0].type, machineOverrides: {} }); }}>
        {PRINTERS.map((x) => <option key={x.id} value={x.id}>{x.vendor} {x.model}</option>)}
      </select>
      <span>{p.bed.x} × {p.bed.y} mm</span>
    </label>
  );
}

function Overlay() {
  useCx();
  const c = compute();
  const r = c.built?.report;
  const source = cx.spec.source;
  const waiting = c.waiting || (!c.built && !(source === 'model' && !c.model));
  const hint = source === 'model' && !c.model ? 'Pick a sample or drop a 3D model in the Artwork panel below.' : source === 'image' && !cx.spec.image ? 'Upload an image in the Artwork panel below, or pick a sample.' : c.waiting ? 'Reading the design…' : '';
  return (
    <>
      {(hint || waiting) && <div className="st-live" style={{ top: '46%', left: '50%', transform: 'translateX(-50%)', bottom: 'auto' }}>{hint || 'Building…'}</div>}
      {r && r.size[0] > 0 && (
        <div className="st-stats" style={{ top: 52 }}>
          <Stat label="Size" value={`${r.size[0]} × ${r.size[1]} × ${r.size[2]} mm`} />
          <Stat label="Button" value={`${r.buttonGrams} g`} />
          <Stat label="MX switch" value={r.fits ? 'Fits' : 'Does not fit'} tone={r.fits ? 'ok' : 'warn'} />
        </div>
      )}
      <LiveBadge busy={waiting} text={r ? `Live · rebuilt in ${c.ms.toFixed(0)} ms` : 'Live'} />
      <div className="st-toolbar br">
        <span className="st-ttl">Preview</span>
        <ToolGroup label="Show"><Seg label="Show" value={cx.view} options={VIEWS} onChange={(v) => { cx.view = v; changed(false); }} /></ToolGroup>
        <ToolGroup label="Look">
          <span className="st-seg" role="group" aria-label="Look">
            <button className={cx.showSwitch ? 'on' : ''} aria-pressed={cx.showSwitch} onClick={() => { cx.showSwitch = !cx.showSwitch; changed(false); }}>Switch</button>
            <button className={cx.cutOpen ? 'on' : ''} aria-pressed={cx.cutOpen} onClick={() => { cx.cutOpen = !cx.cutOpen; changed(false); }}>Cut open</button>
          </span>
        </ToolGroup>
        {source !== 'model' && <ToolGroup label="Finish"><Seg label="Finish" value={cx.spec.colors.mode} options={MODES} onChange={(v) => { cx.spec.colors.mode = v; changed(); }} /></ToolGroup>}
        {cx.view === 'assembled' && <ToolGroup label="Press"><input type="range" min={0} max={1} step={0.01} value={cx.press} style={{ width: 90 }} onChange={(e) => { cx.press = parseFloat(e.target.value); changed(false); }} aria-label="Press the button" /></ToolGroup>}
      </div>
    </>
  );
}

function Studio() {
  useCx();
  const c = compute();
  const notes = c.built?.report.warnings ?? [];
  useEffect(() => { if (cx.toast) useStore.getState().set({ toast: { kind: 'info', text: cx.toast } }); }, [cx.toast]);
  const send = () => { const r = transferToPlate(); if (r) { say(`${r.count} part${r.count > 1 ? 's' : ''} placed on ${r.plate}.`); setTimeout(() => openStudio(false), 900); } };
  const tabs = tabsFor(cx.spec.source);
  const side = (
    <div className="cx-shell" style={{ display: 'contents' }}>
      <SideCard title="Design" id="cx-design">
        <Row label="Name"><input className="st-text" value={cx.spec.name} aria-label="Design name" onChange={(e) => { cx.spec.name = e.target.value; changed(false); }} /></Row>
        <div className="st-btns">
          <button className="st-btn" onClick={saveDesign} title="Save this design to your library">Save</button>
          <UndoRedo history={undoHistory} />
          <IconButton icon="rot" title="Reset the settings of this design" onClick={resetDesign} />
        </div>
      </SideCard>
      {tabs.map((t, i) => <SideCard key={`${cx.spec.source}-${t.id}`} title={t.label} id={`cx-${t.id}`} defaultOpen={i < 2}><div className="cx-panel" style={{ padding: 0, border: 0, background: 'none' }}><PanelById id={t.id} /></div></SideCard>)}
      {notes.length > 0 && <SideCard title="Notes" right={<span className="st-badge warn">{notes.length}</span>} defaultOpen={false}>{notes.map((w, i) => <div key={i} className="st-hint">{w}</div>)}</SideCard>}
    </div>
  );
  return (
    <StudioWindow name="Clickex" letter="C" gradient="linear-gradient(135deg,#0EA5E9,#2563EB)" onClose={() => openStudio(false)} sideWidth={320}
      version={cx.spec.name}
      side={side}
      rail={<><small>Tabs</small>{tabs.map((t) => <button key={t.id} className="st-ib" title={t.label} aria-label={t.label} onClick={() => setTab(t.id)}><Ico name={t.icon} size={16} /></button>)}</>}
      stage={<div className="cx-shell" style={{ position: 'absolute', inset: 0 }}><Live3D><Viewer /><Overlay /></Live3D></div>}
      editor={<>
        <div className="st-editor-head"><span className="st-ttl">Artwork</span><span className="st-hint" style={{ margin: 0, alignSelf: 'center' }}>Where the design comes from: an image, an SVG, an icon, text, name keys or a 3D model</span></div>
        <div className="st-editor-body cx-shell" style={{ overflow: 'auto', padding: '10px 14px' }}><SourcePanel /></div>
      </>}
      editorHeight={300}
      actions={<>
        <PlateSelect />
        <button className="st-btn" onClick={() => download3mf().catch((e) => say(`Download failed: ${(e as Error).message}`))}>Download 3MF</button>
        <button className="st-btn" onClick={send}>Send to plate</button>
      </>} />
  );
}

export { Note };
