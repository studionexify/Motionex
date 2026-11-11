import { BRUSHES, BRUSH_LABELS, type BrushType } from '../engine/brush';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { autoOrient, importDialog } from '../state/actions';
import { splitObject } from '../state/objectOps';
import { repairObjects } from '../state/meshTools';
import { choiceColors, objectPlate, slotColor, useStore, worldBounds, type Tool } from '../state/store';
import { mixLabel } from '../profiles/mixing';
import { addPlate, arrangeAll, arrangeSelected, currentProfile, orientPlate, signedVolume, objectHeight, profileBounds, vlhAdaptive, vlhRange, vlhReset, vlhSmooth } from '../state/ops';
import { viewApi } from '../viewport/Viewport';
import { Icon } from './icons';
import { useDrool } from '../plugins/droolState';

/** The Prepare toolbar: object commands, then the gizmos and tools (large Bambu-style icons). */
export function Toolbar() {
  const { tool, set, selected, objects, showOverhangs, selectedPart, activePlate, plates, duplicateSelected, removeSelected } = useStore();
  const has = selected.length > 0 || !!selectedPart;
  const one = selected.length === 1 && !selectedPart;
  const T = (t: Tool, icon: string, label: string, key: string, disabled = false) => (
    <button className={`icon-btn ${tool === t ? 'active' : ''}`} title={`${label} (${key})`} aria-label={label} aria-pressed={tool === t} disabled={disabled}
      onClick={() => set({ tool: tool === t ? 'select' : t })}><Icon name={icon} /></button>
  );
  const locked = !!plates[activePlate]?.locked;
  const [arrOpen, setArrOpen] = useState(false);
  return (
    <div className="float toolbar" role="toolbar" aria-label="Prepare tools">
      <div className="tb-group">
        <button className="icon-btn tb-main" title="Add model (Ctrl+I)" aria-label="Add model" onClick={importDialog}><Icon name="addCube" /></button>
        <button className="icon-btn tb-main" title="Add plate" aria-label="Add plate" onClick={addPlate}><Icon name="addPlateB" /></button>
        <button className="icon-btn" title={has ? 'Auto orient selected (O)' : 'Auto orient all objects on the plate (O)'} aria-label="Auto orient"
          disabled={!objects.length || (!has && locked)} onClick={() => (has ? autoOrient() : orientPlate())}><Icon name="autoOrient" /></button>
        <span style={{ position: 'relative', display: 'inline-flex' }}>
          <button className="icon-btn" title="Arrange all objects (A) · Shift+A: arrange selected · right click: arrange settings" aria-label="Arrange" disabled={!objects.length}
            onClick={(e) => (e.shiftKey ? arrangeSelected() : arrangeAll())} onContextMenu={(e) => { e.preventDefault(); setArrOpen(!arrOpen); }}><Icon name="arrangeB" /></button>
          {arrOpen && <ArrangeSettings onClose={() => setArrOpen(false)} />}
        </span>
        <button className="icon-btn" title="Split to objects" aria-label="Split to objects" disabled={!one} onClick={() => splitObject(selected[0])}><Icon name="splitB" /></button>
        {T('vlh', 'vlhB', 'Variable layer height', 'H', !objects.length)}
      </div>
      <span className="sep" />
      <div className="tb-group">
        {T('move', 'moveB', 'Move', 'M')}
        {T('rotate', 'rotateB', 'Rotate', 'R')}
        {T('scale', 'scaleB', 'Scale', 'S')}
        {T('face', 'faceB', 'Lay on face', 'F')}
        {T('cut', 'cutB', 'Cut', 'C')}
        {T('boolean', 'booleanB', 'Mesh boolean', 'B')}
      </div>
      <span className="sep" />
      <div className="tb-group">
        {T('paint_support', 'supportPaint', 'Support painting', 'L')}
        {T('paint_seam', 'seamPaint', 'Seam painting', 'P')}
        {T('paint_color', 'colorPaint', 'Colour painting', 'N')}
        {T('text', 'textB', 'Text shape', 'T')}
        {T('measure', 'measureB', 'Measure', 'U')}
        {T('brim_ears', 'earsB', 'Brim ears', 'E')}
        {T('edges', 'edgesB', 'Edges: chamfer, fillet, smooth', 'G', !objects.length)}
      </div>
      <span className="sep" />
      <div className="tb-group">
        <button className="icon-btn" title="Duplicate (Ctrl+D)" aria-label="Duplicate" disabled={!selected.length} onClick={duplicateSelected}><Icon name="duplicate" /></button>
        <button className="icon-btn" title="Delete (Del)" aria-label="Delete" disabled={!selected.length} onClick={removeSelected}><Icon name="deleteB" /></button>
        {objects.some((o) => selected.includes(o.id) && o.openEdges > 0) && (
          <button className="icon-btn" style={{ color: 'var(--ns-warn, var(--warning))' }} title="Fix model: this model has open edges — close holes and repair the mesh" aria-label="Fix model" onClick={() => repairObjects(selected)}><Icon name="warn" /></button>
        )}
      </div>
      <span className="sep" />
      <button className={`icon-btn ${showOverhangs ? 'active' : ''}`} title="Highlight overhangs" aria-label="Highlight overhangs" aria-pressed={showOverhangs} onClick={() => set({ showOverhangs: !showOverhangs })}><Icon name="overhangB" /></button>
    </div>
  );
}

/** Shown while the motion preview is drawn on the model, with the drool check when threads reach too far out. */
export function LiveChip() {
  const { liveToolpaths, objects, threadView } = useStore();
  const [info, setInfo] = useState('');
  const drool = useDrool();
  useEffect(() => {
    const on = () => setInfo(`${Math.round((window as any).__nxPreviewMs ?? 0)} ms`);
    window.addEventListener('nx-preview-built', on);
    return () => window.removeEventListener('nx-preview-built', on);
  }, []);
  if (!liveToolpaths || !objects.length) return null;
  const warn = threadView && drool && drool.level !== 'ok';
  return (
    <div className={`float live-chip ${warn ? 'warn' : ''}`} role="status">
      <i />Toolpath view ({threadView ? 'thick thread' : 'lines'}){info ? ` · ${info}` : ''} · slice for exact G-code
      {warn && drool && (
        <b title={`Threads reach up to ${drool.worstMm.toFixed(2)} mm from the layer below. Up to ${drool.safeMm.toFixed(2)} mm is held up; from ${drool.dripMm.toFixed(2)} mm hot plastic runs off.`}>
          {drool.level === 'drip' ? ` · drooling: ${drool.drips} drip${drool.drips === 1 ? '' : 's'}, reach ${drool.worstMm.toFixed(2)} mm` : ` · sagging, reach ${drool.worstMm.toFixed(2)} mm`}
        </b>
      )}
    </div>
  );
}

export type CubeFace = 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right';
// Each face in world space (Z up, front = -Y): screen-right, screen-down and outward normal.
const FACES: [CubeFace, string, number[], number[], number[]][] = [
  ['top', 'Top', [1, 0, 0], [0, -1, 0], [0, 0, 1]],
  ['bottom', 'Bottom', [1, 0, 0], [0, 1, 0], [0, 0, -1]],
  ['front', 'Front', [1, 0, 0], [0, 0, -1], [0, -1, 0]],
  ['back', 'Back', [-1, 0, 0], [0, 0, -1], [0, 1, 0]],
  ['right', 'Right', [0, 1, 0], [0, 0, -1], [1, 0, 0]],
  ['left', 'Left', [0, -1, 0], [0, 0, -1], [-1, 0, 0]],
];
const CUBE = 62;

/** What a view cube drives: the main plate view by default, or another 3D view (the Select window). */
export interface CubeApi {
  /** Calls back with the camera's world-to-view matrix (column-major) after each frame; returns the unsubscribe. */
  listen(l: (m: ArrayLike<number>) => void): () => void;
  setView(face: CubeFace): void;
  orbit(dAzimuth: number, dPolar: number): void;
  fit(): void;
}
const plateCube: CubeApi = {
  listen: (l) => { viewApi.cameraListeners.add(l); viewApi.current?.emitCamera(); return () => { viewApi.cameraListeners.delete(l); }; },
  setView: (f) => viewApi.current?.setView(f),
  orbit: (a, b) => viewApi.current?.orbit(a, b),
  fit: () => viewApi.current?.fit(),
};

/** View cube: turns with the camera, click a face to look at it, drag to orbit. */
export function ViewCube({ api = plateCube, className = '', children }: { api?: CubeApi; className?: string; children?: ReactNode } = {}) {
  const cube = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  useEffect(() => {
    const on = (e: ArrayLike<number>) => {
      // camera rotation, with y flipped into CSS's y-down screen space
      if (cube.current) cube.current.style.transform = `matrix3d(${[e[0], -e[1], e[2], 0, e[4], -e[5], e[6], 0, e[8], -e[9], e[10], 0, 0, 0, 0, 1].join(',')})`;
    };
    return api.listen(on);
  }, [api]);
  const h = CUBE / 2;
  return (
    <div className={`float viewcube ${className}`} aria-label="View cube">
      <div className="cube-stage" title="Click a face to view from that side · drag to rotate"
        onPointerDown={(e) => { drag.current = { x: e.clientX, y: e.clientY, moved: false }; e.currentTarget.setPointerCapture(e.pointerId); }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          const dx = e.clientX - d.x, dy = e.clientY - d.y;
          if (!d.moved && Math.hypot(dx, dy) < 3) return;
          d.moved = true; d.x = e.clientX; d.y = e.clientY;
          api.orbit(-dx * 0.012, -dy * 0.012);
        }}
        onPointerUp={(e) => {
          const d = drag.current;
          drag.current = null;
          if (d && !d.moved) {
            const face = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.dataset.face as CubeFace | undefined;
            if (face) api.setView(face);
          }
        }}>
        <div className="cube" ref={cube}>
          {FACES.map(([id, label, r, d, n]) => (
            <div key={id} data-face={id} className={`cube-face ${id}`}
              style={{ width: CUBE, height: CUBE, marginLeft: -h, marginTop: -h, transform: `matrix3d(${[...r, 0, ...d, 0, ...n, 0, n[0] * h, n[1] * h, n[2] * h, 1].join(',')})` }}>
              {label}
            </div>
          ))}
        </div>
      </div>
      <button className="icon-btn cube-fit" title="Zoom to fit the plate (Z) · 0: default view" aria-label="Zoom to fit" onClick={() => api.fit()}><Icon name="fit" size={16} /></button>
      {children}
    </div>
  );
}

/** Object info box (bottom right) for the selected object: name, size, volume, triangles, mesh errors. */
export function ObjectInfo() {
  const { objects, selected, selectedPart } = useStore();
  const [closedFor, setClosedFor] = useState<string | null>(null);
  const [mini, setMini] = useState(() => typeof matchMedia !== 'undefined' && matchMedia('(max-width: 767px)').matches);
  const o = selected.length === 1 && !selectedPart ? objects.find((x) => x.id === selected[0]) : undefined;
  const volume = useMemo(() => (o ? Math.abs(signedVolume(o.mesh) * o.scale[0] * o.scale[1] * o.scale[2]) : 0), [o?.mesh, o?.scale]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!o || closedFor === o.id) return null;
  const b = worldBounds(o);
  const size = [0, 1, 2].map((k) => (b.max[k] - b.min[k]).toFixed(2));
  return (
    <div className={`float object-info ${mini ? 'mini' : ''}`} role="status" aria-label="Object info">
      <div className="oi-head">
        <span className="oi-title">{mini ? o.name : 'Object info'}</span>
        <button className="oi-btn" title={mini ? 'Expand' : 'Minimize'} onClick={() => setMini(!mini)}><Icon name={mini ? 'chevronDown' : 'minus'} size={13} /></button>
        <button className="oi-btn" title="Close" onClick={() => setClosedFor(o.id)}><Icon name="close" size={13} /></button>
      </div>
      {!mini && <div className="oi-body">
        <span>Object name:</span><b>{o.name}</b>
        <span>Size:</span><b>{size[0]} x {size[1]} x {size[2]} mm</b>
        <span>Volume:</span><b>{volume.toFixed(2)} mm³</b>
        <span>Triangles:</span><b>{(o.mesh.indices.length / 3).toLocaleString()}</b>
        {o.openEdges > 0 && <><span>Errors:</span><b className="oi-warn">{o.openEdges} open edges <button className="btn-secondary btn-small" style={{ marginLeft: 6 }} title="Repair the mesh: close holes, remove bad triangles, fix flipped faces" onClick={() => repairObjects([o.id])}>Fix model</button></b></>}
        {o.printable === false && <><span>Printable:</span><b>No</b></>}
      </div>}
    </div>
  );
}

export { TransformPanel } from './TransformPanel';

function NumField({ value, onSet }: { value: number; onSet: (v: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  useEffect(() => setDraft(null), [value]);
  return (
    <input className="input" style={{ textAlign: 'right' }} value={draft ?? value.toFixed(2)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => { if (draft !== null) { const v = parseFloat(draft); if (isFinite(v)) onSet(v); setDraft(null); } }}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
  );
}

/** Painting panel: brush size, modes and colour palette. */
const BRUSH_TIPS: Record<BrushType, string> = {
  circle: 'Paints the surface facing you inside the circle',
  sphere: 'Paints every triangle inside the sphere, including hidden ones',
  triangle: 'Paints the triangle under the cursor',
  height_range: 'Paints a horizontal band of the model (pen size = band height)',
  fill: 'Click: fills the surface up to edges sharper than the smart fill angle',
  gap_fill: 'Click: fills small unpainted gaps between painted areas',
};

export function PaintPanel() {
  const s = useStore();
  if (!['paint_support', 'paint_seam', 'paint_color'].includes(s.tool)) return null;
  const sel = s.objects.find((o) => o.id === s.selected[0]);
  const layer = s.tool === 'paint_support' ? 'support' : s.tool === 'paint_seam' ? 'seam' : 'color';
  const brush = BRUSHES[layer].includes(s.brushType) ? s.brushType : 'circle';
  const title = { paint_support: 'Support painting', paint_seam: 'Seam painting', paint_color: 'Colour painting' }[s.tool as 'paint_support'];
  const clear = () => {
    const ids = sel ? [sel.id] : s.objects.map((o) => o.id);
    s.updateObjects((o) => ({ ...o, paint: { ...(o.paint ?? {}), [layer]: undefined } }), ids);
  };
  return (
    <div className="float panel">
      <h4>{title}</h4>
      {BRUSHES[layer].length > 3 ? (
        <select className="select" style={{ width: '100%', marginBottom: 6 }} aria-label="Brush" title={BRUSH_TIPS[brush]} value={brush} onChange={(e) => s.set({ brushType: e.target.value as typeof brush })}>
          {BRUSHES[layer].map((b) => <option key={b} value={b}>{BRUSH_LABELS[b]}</option>)}
        </select>
      ) : (
        <div className="seg brush-seg" role="radiogroup" aria-label="Brush">
          {BRUSHES[layer].map((b) => <button key={b} className={brush === b ? 'on' : ''} onClick={() => s.set({ brushType: b })} title={BRUSH_TIPS[b]}>{BRUSH_LABELS[b]}</button>)}
        </div>
      )}
      {(brush === 'circle' || brush === 'sphere' || brush === 'height_range') && <>
        <div className="row"><span style={{ flex: 1 }}>{brush === 'height_range' ? 'Height range' : 'Pen size'}</span><span className="mono">{s.brushSize.toFixed(1)} mm</span></div>
        <input type="range" min={0.4} max={20} step={0.2} value={s.brushSize} onChange={(e) => s.set({ brushSize: +e.target.value })} style={{ width: '100%', accentColor: 'var(--accent)' }} />
      </>}
      {brush === 'fill' && <>
        <div className="row"><span style={{ flex: 1 }}>Smart fill angle</span><span className="mono">{s.smartFillAngle}°</span></div>
        <input type="range" min={0} max={90} step={1} value={s.smartFillAngle} onChange={(e) => s.set({ smartFillAngle: +e.target.value })} style={{ width: '100%', accentColor: 'var(--accent)' }} />
      </>}
      {brush === 'gap_fill' && <>
        <div className="row"><span style={{ flex: 1 }}>Gap area</span><span className="mono">{s.gapArea.toFixed(1)} mm²</span></div>
        <input type="range" min={0.1} max={20} step={0.1} value={s.gapArea} onChange={(e) => s.set({ gapArea: +e.target.value })} style={{ width: '100%', accentColor: 'var(--accent)' }} />
      </>}
      {s.tool === 'paint_support' && <>
        <div className="row"><span style={{ flex: 1 }}>Highlight overhangs below</span><span className="mono">{s.paintOverhangAngle}°</span></div>
        <input type="range" min={0} max={90} step={1} value={s.paintOverhangAngle} onChange={(e) => s.set({ paintOverhangAngle: +e.target.value })} style={{ width: '100%', accentColor: 'var(--accent)' }} />
      </>}
      {s.tool === 'paint_support' && (
        <label className="row"><span style={{ flex: 1 }}>On overhangs only</span><button className={`toggle ${s.overhangOnly ? 'on' : ''}`} onClick={() => s.set({ overhangOnly: !s.overhangOnly })} aria-label="On overhangs only" /></label>
      )}
      {s.tool === 'paint_color' && (
        <div className="palette">
          {choiceColors(s).map((c, k) => (
            <button key={k} className={`pal ${s.paintColor === k + 1 ? 'on' : ''}`} style={{ background: c }} onClick={() => s.set({ paintColor: k + 1 })} title={k < s.filaments.length ? `Filament ${k + 1}` : `Filament ${k + 1} · mix ${mixLabel(s.mixes[k - s.filaments.length])}`}>{k + 1}</button>
          ))}
          {s.filaments.length < 2 && <div style={{ color: 'var(--text-muted)' }}>Add a second filament in the Filament panel to paint colours.</div>}
        </div>
      )}
      <div className="hint-list">
        {s.tool === 'paint_color'
          ? <><span><kbd>Left drag</kbd> on model: paint</span><span><kbd>Alt + drag</kbd> reset to object filament</span></>
          : <><span><kbd>Left drag</kbd> on model: {s.tool === 'paint_support' ? 'enforce support' : 'enforce seam'}</span><span><kbd>Alt + drag</kbd> block</span></>}
        <span><kbd>Shift + drag</kbd> erase</span><span><kbd>Left drag</kbd> off model: rotate · <kbd>Middle</kbd>/<kbd>Right drag</kbd> pan · <kbd>Wheel</kbd> zoom</span>
      </div>
      <button className="btn-secondary btn-small" onClick={clear}>{sel ? 'Clear on selected object' : 'Clear on all objects'}</button>
    </div>
  );
}

/** Variable layer height panel with profile chart. */
export function VlhPanel() {
  const s = useStore();
  const [quality, setQuality] = useState(0.5);
  const [radius, setRadius] = useState(5);
  const [keepMin, setKeepMin] = useState(false);
  const [range, setRange] = useState({ z0: 2, z1: 6, h: 0.1 });
  const canvas = useRef<HTMLCanvasElement>(null);
  const o = s.objects.find((x) => x.id === s.selected[0]);
  const vlhShared = o ? s.objects.filter((x) => x.layerHeights?.length && objectPlate(x, s.printerId, s.plates.length) === objectPlate(o, s.printerId, s.plates.length)).length : 0;
  const prof = useMemo(() => (o ? currentProfile(o) : []), [o, s.printerId, s.presetId, s.overrides]);
  useEffect(() => {
    const c = canvas.current;
    if (!c || !prof.length) return;
    const g = c.getContext('2d')!;
    const W = c.width, H = c.height;
    g.clearRect(0, 0, W, H);
    const pb = profileBounds();
    const total = prof.reduce((a, b) => a + b, 0);
    let z = 0;
    for (const h of prof) {
      const y0 = H - (z / total) * H, y1 = H - ((z + h) / total) * H;
      const t = (h - pb.minHeight) / Math.max(1e-6, pb.maxHeight - pb.minHeight);
      g.fillStyle = t < 0.5 ? `rgb(${Math.round(93 + 300 * t)}, 190, 122)` : `rgb(255, ${Math.round(255 - (t - 0.5) * 300)}, ${Math.round(141 - (t - 0.5) * 200)})`;
      g.fillRect(0, y1, (h / pb.maxHeight) * W, Math.max(1, y0 - y1));
      z += h;
    }
  }, [prof]);
  if (s.tool !== 'vlh') return null;
  if (!o) return <div className="float panel"><h4>Variable layer height</h4><div style={{ color: 'var(--text-muted)' }}>Select an object to edit its layer heights.</div></div>;
  const pb = profileBounds();
  const height = objectHeight(o);
  return (
    <div className="float panel vlh">
      <h4>Variable layer height · {o.name}</h4>
      <div className="vlh-body">
        <canvas ref={canvas} width={60} height={220} className="vlh-chart" title="Layer height along Z (green = thin, red = thick)" />
        <div style={{ flex: 1 }}>
          <div className="row"><span style={{ flex: 1 }}>Quality ↔ Speed</span><span className="mono">{quality.toFixed(2)}</span></div>
          <input type="range" min={0} max={1} step={0.05} value={quality} onChange={(e) => setQuality(+e.target.value)} style={{ width: '100%', accentColor: 'var(--accent)' }} />
          <button className="btn-secondary btn-small" style={{ width: '100%' }} onClick={() => vlhAdaptive(o.id, quality)}>Adaptive</button>
          <div className="row"><span style={{ flex: 1 }}>Smooth radius</span><span className="mono">{radius}</span></div>
          <input type="range" min={1} max={10} step={1} value={radius} onChange={(e) => setRadius(+e.target.value)} style={{ width: '100%', accentColor: 'var(--accent)' }} />
          <label className="row"><span style={{ flex: 1 }}>Keep min</span><button className={`toggle ${keepMin ? 'on' : ''}`} onClick={() => setKeepMin(!keepMin)} aria-label="Keep min" /></label>
          <button className="btn-secondary btn-small" style={{ width: '100%' }} onClick={() => vlhSmooth(o.id, radius, keepMin)}>Smooth</button>
        </div>
      </div>
      <h4 style={{ marginTop: 10 }}>Height range</h4>
      <div className="xyz" style={{ gridTemplateColumns: '40px 1fr 26px' }}><span>From</span><NumField value={range.z0} onSet={(v) => setRange({ ...range, z0: v })} /><span className="unit">mm</span></div>
      <div className="xyz" style={{ gridTemplateColumns: '40px 1fr 26px' }}><span>To</span><NumField value={range.z1} onSet={(v) => setRange({ ...range, z1: v })} /><span className="unit">mm</span></div>
      <div className="xyz" style={{ gridTemplateColumns: '40px 1fr 26px' }}><span>Layer</span><NumField value={range.h} onSet={(v) => setRange({ ...range, h: Math.min(pb.maxHeight, Math.max(pb.minHeight, v)) })} /><span className="unit">mm</span></div>
      <div className="row">
        <button className="btn-secondary btn-small" onClick={() => vlhRange(o.id, Math.max(0, range.z0), Math.min(height, range.z1), range.h)}>Apply range</button>
        <button className="btn-secondary btn-small" disabled={!o.layerHeights} onClick={() => vlhReset(o.id)}>Reset</button>
      </div>
      <div style={{ color: 'var(--text-muted)', marginTop: 6 }}>{prof.length} layers · {pb.minHeight}–{pb.maxHeight} mm allowed{o.layerHeights ? '' : ' · uniform'}</div>
      {vlhShared > 1 && <div className="badge warn" role="status" style={{ marginTop: 6, whiteSpace: 'normal' }} title="All objects on one plate share the same layers">
        {vlhShared} objects on this plate have variable layer heights. Layers are shared by the whole plate, so the first object's profile is used for all of them.</div>}
    </div>
  );
}

export { slotColor };

/** Arrange settings popup (right click on the arrange button). */
function ArrangeSettings({ onClose }: { onClose: () => void }) {
  const { arrangeSettings: a, set } = useStore();
  const up = (p: Partial<typeof a>) => set({ arrangeSettings: { ...a, ...p } });
  // like any popover: Esc, a click elsewhere or switching tool closes it (it used to stay over the tool panels).
  // Listeners are bound once (onClose read through a ref): re-binding on every render dropped the event that caused it.
  const close = useRef(onClose); close.current = onClose;
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') close.current(); };
    const down = () => close.current();
    const unsub = useStore.subscribe((st, prev) => { if (st.tool !== prev.tool) close.current(); });
    window.addEventListener('keydown', key, true); window.addEventListener('pointerdown', down);
    return () => { window.removeEventListener('keydown', key, true); window.removeEventListener('pointerdown', down); unsub(); };
  }, []);
  return (
    <div className="menu-pop arrange-pop" style={{ top: 40, left: 0, padding: 12, width: 240 }} onPointerDown={(e) => e.stopPropagation()}>
      <div className="row"><b style={{ flex: 1 }}>Arrange settings</b><button className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="close" size={14} /></button></div>
      <div className="row"><span style={{ flex: 1 }}>Spacing</span><span className="mono">{a.spacing.toFixed(1)} mm</span></div>
      <input type="range" min={0} max={30} step={0.5} value={a.spacing} onChange={(e) => up({ spacing: +e.target.value })} style={{ width: '100%', accentColor: 'var(--accent)' }} />
      <label className="row"><input type="checkbox" checked={a.rotate} onChange={(e) => up({ rotate: e.target.checked })} />Auto rotate for arrangement</label>
      <div className="row"><span style={{ flex: 1 }}>Align</span>
        <div className="seg">{([['center', 'Centre'], ['x', 'X axis'], ['y', 'Y axis']] as const).map(([v, l]) => <button key={v} className={a.align === v ? 'on' : ''} onClick={() => up({ align: v })}>{l}</button>)}</div>
      </div>
      <div className="row" style={{ marginTop: 6 }}>
        <button className="btn-secondary btn-small" onClick={() => up({ spacing: 6, rotate: false, align: 'center' })}>Reset</button>
        <span className="spacer" />
        <button className="btn-primary btn-small" onClick={() => { arrangeAll(); onClose(); }}>Arrange</button>
      </div>
    </div>
  );
}

/** Brim ears tool panel. */
export function BrimEarsPanel() {
  const s = useStore();
  if (s.tool !== 'brim_ears') return null;
  const o = s.objects.find((x) => x.id === s.selected[0]);
  const n = s.objects.reduce((a, x) => a + (x.brimEars?.length ?? 0), 0);
  const painted = s.overrides.brim_type === 'brim_ears';
  return (
    <div className="float panel" style={{ width: 270 }}>
      <h4>Brim ears</h4>
      <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>Click a model near the bed to add an ear; click an ear to remove it. Ears use the brim width ({Number(s.overrides.brim_width ?? 5)} mm).</p>
      <div className="row" style={{ fontSize: 12 }}>{n} ear{n === 1 ? '' : 's'} placed{!painted && n > 0 && <span className="badge" style={{ marginLeft: 6 }}>brim type is not Painted</span>}</div>
      <div className="row" style={{ marginTop: 8 }}>
        {!painted && <button className="btn-secondary btn-small" onClick={() => { s.setOverride('brim_type', 'brim_ears'); s.markDirty(); }}>Use painted brim</button>}
        <span className="spacer" />
        <button className="btn-secondary btn-small" disabled={!n} onClick={() => { s.updateObjects((x) => ({ ...x, brimEars: undefined }), o ? [o.id] : s.objects.map((x) => x.id)); s.markDirty(); }}>{o ? 'Clear on selected' : 'Clear all'}</button>
      </div>
    </div>
  );
}
