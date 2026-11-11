// Floating panels for the Cut, Mesh Boolean, Text and Measure tools.
import { edgeLength, measure } from '../state/measure';
import { onSvgOffered, takeSvg } from '../state/svgHandoff';
import { embossVolume, objectFromWorld, svgMesh, textMesh, type EmbossKind } from '../state/tools';
import { DEFAULT_GROOVE, type ConnectorSettings, type ConnectorShape, type ConnectorStyle, type ConnectorType, type GrooveSettings } from '../state/cutConnectors';
import { useEffect, useState } from 'react';
import { dropToBed, useStore, worldBounds } from '../state/store';
import { addText, applyPartsBoolean, booleanSelected, hasShapeParts, cutObject, FONTS, type TextOptions } from '../state/tools';
import { Icon } from './icons';
import { bevelSelectedEdges, exactifyObject, refineObject, remeshObject, selectCreaseEdges, smoothObject, subdivideObject } from '../state/meshTools';
import { hasPolygonFaces } from '../engine/meshedit';

function Slider({ label, value, min, max, step, unit, onChange }: { label: string; value: number; min: number; max: number; step: number; unit: string; onChange: (v: number) => void }) {
  // typed text is a draft until Enter/blur, so "-", "0." and an emptied field can be typed (it used to snap back on each key)
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => { if (draft !== null) { const v = parseFloat(draft); if (isFinite(v)) onChange(Math.min(max, Math.max(min, v))); setDraft(null); } };
  return (
    <div className="row" style={{ marginBottom: 6 }}>
      <span style={{ width: 62 }}>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} style={{ flex: 1, minWidth: 0 }} />
      <input className="input mono" style={{ width: 58, textAlign: 'right' }} value={draft ?? +value.toFixed(2)} onChange={(e) => setDraft(e.target.value)} onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); else if (e.key === 'Escape') { setDraft(null); (e.target as HTMLInputElement).blur(); } }} />
      <span className="unit">{unit}</span>
    </div>
  );
}

function Seg({ label, value, options, onChange }: { label: string; value: string; options: [string, string][]; onChange: (v: string) => void }) {
  return (
    <div className="row" style={{ marginBottom: 4 }}>
      <span className="muted" style={{ width: 92, fontSize: 12 }}>{label}</span>
      {/* up to 3 short options stay buttons; longer lists become a dropdown */}
      {options.length <= 3 && options.every(([, l]) => l.length <= 10)
        ? <div className="seg">{options.map(([v, l]) => <button key={v} className={value === v ? 'on' : ''} onClick={() => onChange(v)}>{l}</button>)}</div>
        : <select className="select" style={{ flex: 1 }} aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>{options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>}
    </div>
  );
}

export function CutPanel() {
  const { tool, objects, selected, cutPlane, cutConnectors, cutConnector: cc, cutConnectorMode, cutMode, cutGroove: gv, cutSwap, set } = useStore();
  const setG = (p: Partial<GrooveSettings>) => set({ cutGroove: { ...gv, ...p } });
  const o = objects.find((x) => x.id === selected[0]);
  const setC = (p: Partial<ConnectorSettings>) => set({ cutConnector: { ...cc, ...p } });
  const [keepAbove, setAbove] = useState(true);
  const [keepBelow, setBelow] = useState(true);
  const [flip, setFlip] = useState(true);
  const b = o ? worldBounds(o) : null;
  useEffect(() => {
    if (tool === 'cut' && b) set({ cutPlane: { ...cutPlane, height: +((b.min[2] + b.max[2]) / 2).toFixed(2) } });
  }, [tool, o?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (tool !== 'cut') return null;
  return (
    <div className="float panel" style={{ width: 290 }}>
      <h4>Cut</h4>
      {!o || !b ? <p className="muted">Select an object to cut.</p> : <>
        <Slider label="Height" value={cutPlane.height} min={b.min[2]} max={b.max[2]} step={0.1} unit="mm" onChange={(v) => set({ cutPlane: { ...cutPlane, height: v } })} />
        <Slider label="Tilt X" value={cutPlane.tiltX} min={-90} max={90} step={1} unit="°" onChange={(v) => set({ cutPlane: { ...cutPlane, tiltX: v } })} />
        <Slider label="Tilt Y" value={cutPlane.tiltY} min={-90} max={90} step={1} unit="°" onChange={(v) => set({ cutPlane: { ...cutPlane, tiltY: v } })} />
        <Seg label="Cut mode" value={cutMode} options={[['planar', 'Planar'], ['dovetail', 'Dovetail']]} onChange={(v) => {
          // the default dovetail is sized from the object
          const size = Math.min(b.max[0] - b.min[0], b.max[1] - b.min[1]);
          set(v === 'dovetail' && gv === DEFAULT_GROOVE ? { cutMode: 'dovetail', cutGroove: { ...gv, depth: +Math.max(1, size * 0.08).toFixed(1), width: +(4 * Math.max(1, size * 0.08)).toFixed(1) }, cutConnectorMode: false } : { cutMode: v as 'planar' | 'dovetail' });
        }} />
        {cutMode === 'dovetail' && <>
          <Slider label="Depth" value={gv.depth} min={0.5} max={30} step={0.1} unit="mm" onChange={(v) => setG({ depth: v })} />
          <Slider label="Width" value={gv.width} min={1} max={100} step={0.5} unit="mm" onChange={(v) => setG({ width: v })} />
          <Slider label="Flap angle" value={gv.flapsAngle} min={30} max={90} step={1} unit="°" onChange={(v) => setG({ flapsAngle: v })} />
          <Slider label="Groove angle" value={gv.angle} min={-180} max={180} step={1} unit="°" onChange={(v) => setG({ angle: v })} />
          <Slider label="Depth tolerance" value={gv.depthTol} min={0} max={2} step={0.05} unit="mm" onChange={(v) => setG({ depthTol: v })} />
          <Slider label="Width tolerance" value={gv.widthTol} min={0} max={2} step={0.05} unit="mm" onChange={(v) => setG({ widthTol: v })} />
        </>}
        {cutMode === 'planar' && <>
        <div className="group-title" style={{ marginTop: 6 }}>Connectors</div>
        <div className="row">
          <button className={`btn-small ${cutConnectorMode ? 'btn-primary' : 'btn-secondary'}`} onClick={() => set({ cutConnectorMode: !cutConnectorMode })}
            title="Click the cut plane to add a connector; click a connector to remove it">{cutConnectorMode ? 'Done placing' : 'Add connectors'}</button>
          <span className="muted" style={{ fontSize: 12 }}>{cutConnectors.length} placed</span>
          <span className="spacer" />
          {cutConnectors.length > 0 && <button className="btn-secondary btn-small" onClick={() => set({ cutConnectors: [] })}>Remove all</button>}
        </div>
        {(cutConnectorMode || cutConnectors.length > 0) && <>
          <Seg label="Type" value={cc.type} options={[['plug', 'Plug'], ['dowel', 'Dowel'], ['snap', 'Snap']]} onChange={(v) => setC({ type: v as ConnectorType })} />
          {cc.type !== 'dowel' && <Seg label="Style" value={cc.style} options={[['prism', 'Prism'], ['frustum', 'Frustum']]} onChange={(v) => setC({ style: v as ConnectorStyle })} />}
          <Seg label="Shape" value={cc.shape} options={[['triangle', '▲'], ['square', '■'], ['hexagon', '⬢'], ['circle', '●']]} onChange={(v) => setC({ shape: v as ConnectorShape })} />
          <Slider label="Depth" value={cc.depth} min={1} max={30} step={0.5} unit="mm" onChange={(v) => setC({ depth: v })} />
          <Slider label="Size" value={cc.size} min={1} max={30} step={0.5} unit="mm" onChange={(v) => setC({ size: v })} />
          <Slider label="Depth tolerance" value={cc.tolDepth} min={0} max={20} step={1} unit="%" onChange={(v) => setC({ tolDepth: v })} />
          <Slider label="Size tolerance" value={cc.tolSize} min={0} max={20} step={1} unit="%" onChange={(v) => setC({ tolSize: v })} />
          {cc.type === 'snap' && <>
            <Slider label="Bulge" value={cc.bulge * 100} min={5} max={40} step={1} unit="%" onChange={(v) => setC({ bulge: v / 100 })} />
            <Slider label="Space" value={cc.space * 100} min={10} max={60} step={1} unit="%" onChange={(v) => setC({ space: v / 100 })} />
          </>}
        </>}
        </>}
        <p className="muted" style={{ fontSize: 12, margin: '8px 0 4px' }}>Drag the plane to move it. Right-click a piece to move it to the other side{cutSwap.length ? ` (${cutSwap.length} moved)` : ''}.</p>
        <label className="row"><input type="checkbox" checked={keepAbove} onChange={(e) => setAbove(e.target.checked)} />Keep upper part</label>
        <label className="row" style={{ marginLeft: 20 }}><input type="checkbox" checked={flip} disabled={!keepAbove} onChange={(e) => setFlip(e.target.checked)} />Place on cut face</label>
        <label className="row"><input type="checkbox" checked={keepBelow} onChange={(e) => setBelow(e.target.checked)} />Keep lower part</label>
        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn-secondary btn-small" onClick={() => set({ cutPlane: { height: +((b.min[2] + b.max[2]) / 2).toFixed(2), tiltX: 0, tiltY: 0 }, cutSwap: [] })}>Reset</button>
          <button className="btn-primary btn-small" disabled={!keepAbove && !keepBelow} onClick={() => cutObject(o.id, { ...cutPlane, keepAbove, keepBelow, flipAbove: flip, swap: cutSwap, ...(cutMode === 'dovetail' ? { groove: gv } : { connectors: cutConnectors, connector: cc }) })}><Icon name="cut" size={14} />Perform cut</button>
        </div>
      </>}
    </div>
  );
}

export function BooleanPanel() {
  const { tool, objects, selected } = useStore();
  if (tool !== 'boolean') return null;
  const sel = selected.map((id) => objects.find((o) => o.id === id)).filter(Boolean);
  return (
    <div className="float panel" style={{ width: 290 }}>
      <h4>Mesh boolean</h4>
      <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>Click objects in the viewport to add them (click again to remove). The first one picked is the base: <b>Difference</b> subtracts the others from it.</p>
      {sel.map((o, i) => <div key={o!.id} className="row" style={{ marginBottom: 2 }}><span className="badge">{i === 0 ? 'Base' : `+${i}`}</span>{o!.name}</div>)}
      {sel.length > 0 && <button className="btn-secondary btn-small" onClick={() => useStore.getState().set({ selected: [], selectedPart: null })}>Clear picks</button>}
      <div className="row" style={{ marginTop: 10, flexWrap: 'wrap' }}>
        {([['union', 'Union'], ['difference', 'Difference'], ['intersection', 'Intersection']] as const).map(([op, label]) => (
          <button key={op} className="btn-secondary btn-small" disabled={sel.length < 2} onClick={() => booleanSelected(op)}>{label}</button>
        ))}
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn-secondary btn-small" disabled={!sel.some((o) => o && hasShapeParts(o))} title="Merge positive parts into the object and cut out negative parts" onClick={() => applyPartsBoolean()}>Apply parts (positive / negative)</button>
      </div>
      <p className="muted" style={{ fontSize: 11, marginBottom: 0 }}>Objects with parts are combined with their parts applied. Overlapping shells are merged automatically.</p>
    </div>
  );
}

type TextMode = 'object' | EmbossKind | 'emboss' | 'engrave';
const TEXT_MODES: [TextMode, string][] = [['part', 'Part'], ['negative', 'Negative part'], ['modifier', 'Modifier'], ['object', 'New object'], ['emboss', 'Bake raised'], ['engrave', 'Bake cut']];

export function TextPanel() {
  const { tool, selected, surfacePick } = useStore();
  const [src, setSrc] = useState<'text' | 'svg'>('text');
  const [o, setO] = useState<Omit<TextOptions, 'mode'> & { mode: TextMode }>({ text: 'NexSpiro', font: 'helvetiker_bold', size: 10, depth: 2, mode: 'part' });
  const [svg, setSvg] = useState<{ name: string; text: string } | null>(null);
  const [useSurface, setUseSurface] = useState(true);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const pick = () => { const p = takeSvg(); if (p) { setSvg(p); setSrc('svg'); } };
    pick();
    return onSvgOffered(pick);
  }, []);
  if (tool !== 'text') return null;
  const volume = o.mode === 'part' || o.mode === 'negative' || o.mode === 'modifier';
  const ready = src === 'text' ? !!o.text.trim() : !!svg;
  const run = async () => {
    const st = useStore.getState();
    try {
      if (volume) {
        if (!surfacePick) return;
        const shape = src === 'text' ? await textMesh(o.text, o.font, o.size, o.depth) : await svgMesh(svg!.text, o.size, o.depth);
        embossVolume(shape, o.mode as EmbossKind, surfacePick, o.depth, src === 'text' ? `Text "${o.text}"` : `SVG ${svg!.name}`, useSurface);
        st.set({ surfacePick: null });
      } else if (src === 'text') await addText(o as TextOptions);
      else {
        const { centreOnBed } = await import('../state/ops');
        st.addObjects([centreOnBed(objectFromWorld(`SVG ${svg!.name}`, await svgMesh(svg!.text, o.size, o.depth)), st.printerId)]);
      }
    } catch (e: any) { st.set({ toast: { kind: 'error', text: `${src === 'text' ? 'Text' : 'SVG'} failed: ${e?.message ?? e}` } }); }
  };
  return (
    <div className="float panel" style={{ width: 300 }}>
      <h4>{src === 'text' ? 'Text' : 'SVG'}</h4>
      <div className="seg" style={{ marginBottom: 8 }}>
        <button className={src === 'text' ? 'on' : ''} onClick={() => setSrc('text')}>Text</button>
        <button className={src === 'svg' ? 'on' : ''} onClick={() => setSrc('svg')}>SVG</button>
      </div>
      {src === 'text' ? <>
        <input className="input" style={{ width: '100%', marginBottom: 8 }} value={o.text} onChange={(e) => setO({ ...o, text: e.target.value })} placeholder="Text" />
        <div className="row" style={{ marginBottom: 6 }}>
          <span style={{ width: 62 }}>Font</span>
          <select className="select" value={o.font} onChange={(e) => setO({ ...o, font: e.target.value })}>
            {Object.entries(FONTS).map(([k, f]) => <option key={k} value={k}>{f.label}</option>)}
          </select>
        </div>
      </> : (
        <label className="row" style={{ marginBottom: 8 }}>
          <span className="btn-secondary btn-small">Choose SVG…</span>
          <span className="muted" style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis' }}>{svg?.name ?? 'No file'}</span>
          <input type="file" accept=".svg,image/svg+xml" hidden onChange={async (e) => { const f = e.target.files?.[0]; if (f) setSvg({ name: f.name, text: await f.text() }); }} />
        </label>
      )}
      <Slider label={src === 'text' ? 'Height' : 'Width'} value={o.size} min={2} max={src === 'text' ? 80 : 200} step={0.5} unit="mm" onChange={(v) => setO({ ...o, size: v })} />
      <Slider label="Depth" value={o.depth} min={0.2} max={20} step={0.1} unit="mm" onChange={(v) => setO({ ...o, depth: v })} />
      <select className="select" style={{ width: '100%', margin: '4px 0 8px' }} aria-label="Text mode" value={o.mode} onChange={(e) => setO({ ...o, mode: e.target.value as typeof o.mode })}>
        {TEXT_MODES.filter(([m]) => src === 'text' || (m !== 'emboss' && m !== 'engrave')).map(([m, label]) => (
          <option key={m} value={m} disabled={m !== 'object' && !selected.length}>{label}</option>
        ))}
      </select>
      {volume && <>
        <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>{surfacePick ? 'Placed on the picked surface point (green).' : 'Click the model where the shape should go.'} A {o.mode === 'negative' ? 'negative part is cut out of' : o.mode === 'modifier' ? 'modifier changes settings inside' : 'part is added to'} the object.</p>
        <label className="row" style={{ marginBottom: 8 }}><input type="checkbox" checked={useSurface} onChange={(e) => setUseSurface(e.target.checked)} />Use surface (bend onto curved faces)</label>
      </>}
      {(o.mode === 'emboss' || o.mode === 'engrave') && <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>{o.mode === 'emboss' ? 'Raised' : 'Cut'} into the top face of the selected object and merged into its mesh.</p>}
      <button className="btn-primary btn-small" disabled={busy || !ready || (volume && !surfacePick)} onClick={async () => { setBusy(true); try { await run(); } finally { setBusy(false); } }}>
        <Icon name="text" size={14} />{busy ? 'Working…' : volume ? `Add ${o.mode === 'part' ? 'part' : o.mode === 'negative' ? 'negative part' : 'modifier'}` : 'Add'}
      </button>
    </div>
  );
}

const FEATURE_LABEL = { point: 'Point', edge: 'Edge', plane: 'Plane', circle: 'Circle' } as const;

export function MeasurePanel() {
  const { tool, measureFeatures: fs, measureMode, objects, set } = useStore();
  const [target, setTarget] = useState('');
  if (tool !== 'measure') return null;
  const r = fs.length === 2 ? measure(fs[0], fs[1]) : null;
  const len = fs.length === 1 ? edgeLength(fs[0]) : null;
  const current = r?.distance ?? len;
  const scaleTo = () => {
    const want = parseFloat(target);
    if (!current || !(want > 0)) return;
    const k = want / current;
    const ids = [...new Set(fs.map((f) => f.objId))].filter((id) => objects.some((o) => o.id === id));
    const st = useStore.getState();
    st.checkpoint();
    st.updateObjects((o) => dropToBed({ ...o, scale: [o.scale[0] * k, o.scale[1] * k, o.scale[2] * k] }), ids);
    st.markDirty();
    set({ measureFeatures: [] });
  };
  return (
    <div className="float panel" style={{ width: 270 }}>
      <h4>Measure</h4>
      <select className="select" style={{ width: '100%', marginBottom: 8 }} aria-label="Measure mode" value={measureMode} onChange={(e) => set({ measureMode: e.target.value as typeof measureMode, measureFeatures: [] })}>
        {(['auto', 'point', 'edge', 'face', 'circle'] as const).map((m) => <option key={m} value={m}>{m === 'auto' ? 'Auto' : FEATURE_LABEL[m === 'face' ? 'plane' : m]}</option>)}
      </select>
      <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>Click two features. Auto picks a circle near a round hole or boss edge, an edge near a sharp crease, a plane on flat surfaces, otherwise a point. Circles are measured from their centre.</p>
      {fs.map((f, i) => <div key={i} className="row" style={{ fontSize: 12 }}><span className="badge">{i + 1}</span>{FEATURE_LABEL[f.kind]}{f.kind === 'edge' && <span className="muted mono">{edgeLength(f)!.toFixed(2)} mm</span>}{f.kind === 'circle' && <span className="muted mono">⌀ {(f.r * 2).toFixed(2)} mm</span>}</div>)}
      {r && (
        <div className="summary">
          {r.distance !== null && <><span className="k">Distance</span><span className="v">{r.distance.toFixed(3)} mm</span></>}
          {r.angle !== null && <><span className="k">Angle</span><span className="v">{r.angle.toFixed(2)}°</span></>}
          {r.delta && <>
            <span className="k">ΔX</span><span className="v">{r.delta[0].toFixed(3)} mm</span>
            <span className="k">ΔY</span><span className="v">{r.delta[1].toFixed(3)} mm</span>
            <span className="k">ΔZ</span><span className="v">{r.delta[2].toFixed(3)} mm</span>
          </>}
        </div>
      )}
      {current ? (
        <div className="row" style={{ marginTop: 8 }} title="Scale the object(s) uniformly so this measurement becomes the value entered">
          <span style={{ fontSize: 12 }}>Scale to</span>
          <input className="input mono" style={{ width: 80 }} placeholder={current.toFixed(2)} value={target} onChange={(e) => setTarget(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && scaleTo()} />mm
          <button className="btn-primary btn-small" disabled={!(parseFloat(target) > 0)} onClick={scaleTo}>Apply</button>
        </div>
      ) : null}
      {fs.length > 0 && <button className="btn-secondary btn-small" style={{ marginTop: 8 }} onClick={() => set({ measureFeatures: [] })}>Clear</button>}
    </div>
  );
}

/** Edges tool: pick edges, chamfer / fillet them, and smooth the body. */
export function EdgesPanel() {
  const s = useStore();
  const [size, setSize] = useState(2);
  const [segments, setSegments] = useState(6);
  const [levels, setLevels] = useState(1);
  const [exactLevel, setExactLevel] = useState(0); // 0 = auto by mesh size
  const [relax, setRelax] = useState(8);
  const [paintedOnly, setPaintedOnly] = useState(false);
  const [refineLen, setRefineLen] = useState(2);
  const [msg, setMsg] = useState('');
  if (s.tool !== 'edges') return null;
  const o = s.objects.find((x) => x.id === (s.edgeSel?.objectId ?? s.selected[0]));
  const n = s.edgeSel?.edges.length ?? 0;
  const quads = !!o && hasPolygonFaces(o.mesh);
  return (
    <div className="float panel" style={{ width: 310, maxHeight: 'calc(100% - 260px)', overflowY: 'auto' }}>
      <h4>Edges</h4>
      <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>Click an edge to pick its whole run. <kbd>Shift</kbd> adds or removes, <kbd>Alt</kbd> picks a single segment.</p>
      <div className="row" style={{ marginBottom: 4 }}>
        <label className="row" style={{ gap: 4 }}><input type="checkbox" checked={s.shadeSmooth} onChange={(e) => s.set({ shadeSmooth: e.target.checked })} />Smooth shading</label>
        <span className="spacer" />
        <label className="row" style={{ gap: 4 }} title="Draw creases, open edges and the outline of painted colours"><input type="checkbox" checked={s.showEdges} onChange={(e) => s.set({ showEdges: e.target.checked })} />Show edges</label>
      </div>
      <Slider label="Crease" value={s.edgeAngle} min={5} max={90} step={1} unit="°" onChange={(v) => s.set({ edgeAngle: v })} />
      <div className="row" style={{ marginBottom: 8 }}>
        <button className="btn-secondary btn-small" disabled={!o} onClick={() => o && selectCreaseEdges(o.id)}>Select all creases</button>
        <button className="btn-secondary btn-small" disabled={!n} onClick={() => s.set({ edgeSel: null })}>Clear</button>
        <span className="spacer" />
        <span className="muted" style={{ fontSize: 12 }}>{n} edge{n === 1 ? '' : 's'} picked</span>
      </div>
      <h4 style={{ marginTop: 6 }}>Chamfer / fillet</h4>
      <Slider label="Size" value={size} min={0.1} max={20} step={0.1} unit="mm" onChange={setSize} />
      <Slider label="Round" value={segments} min={2} max={16} step={1} unit="seg" onChange={setSegments} />
      <div className="row" style={{ marginBottom: 8 }}>
        <button className="btn-secondary btn-small" disabled={!n} onClick={() => setMsg(bevelSelectedEdges(size, 1) ?? '')}>Chamfer</button>
        <button className="btn-secondary btn-small" disabled={!n} onClick={() => setMsg(bevelSelectedEdges(size, segments) ?? '')}>Fillet</button>
      </div>
      <h4 style={{ marginTop: 6 }}>Smooth surface (exact)</h4>
      <p className="muted" style={{ fontSize: 12, margin: '0 0 6px' }}>For faceted STL files. Flat faces, cylinders and spheres are recognised and rebuilt on their exact mathematical surface; other curved areas are smoothed. Edges steeper than the crease angle stay sharp. Prints smooth too.</p>
      <div className="row" style={{ marginBottom: 6 }}>
        <select className="select" style={{ width: 'auto' }} value={exactLevel} aria-label="Smooth surface detail" title="Each level splits every triangle in four: finer is truer to the curve but makes a bigger file"
          onChange={(e) => setExactLevel(+e.target.value)}>
          {[[0, 'Auto'], [1, 'Light'], [2, 'Balanced'], [3, 'Fine']].map(([k, l]) => {
            const t = o ? o.mesh.indices.length / 3 : 0, lv = k || (t < 60_000 ? 2 : 1);
            return <option key={k} value={k}>{l} · {o ? `≈${fmtTris(t * 4 ** (lv as number))} triangles` : `×${4 ** (lv as number)}`}</option>;
          })}
        </select>
        <button className="btn-primary btn-small" disabled={!o} onClick={() => o && exactifyObject(o.id, s.edgeAngle, exactLevel || undefined)}>Smooth surface</button>
      </div>
      <h4 style={{ marginTop: 6 }}>Smooth body</h4>
      <p className="muted" style={{ fontSize: 12, margin: '0 0 6px' }}>{quads ? 'This model has quad faces: they are subdivided into a smooth outer body (Catmull-Clark).' : 'Subdivides the triangles into a finer, rounder surface (Loop). Edges steeper than the crease angle stay sharp.'}</p>
      <Slider label="Levels" value={levels} min={1} max={3} step={1} unit="×" onChange={setLevels} />
      <Slider label="Relax" value={relax} min={1} max={50} step={1} unit="pass" onChange={setRelax} />
      <div className="row" style={{ marginBottom: 6 }}>
        <button className="btn-secondary btn-small" disabled={!o} onClick={() => o && subdivideObject(o.id, { levels, creaseDeg: s.edgeAngle })}>Subdivide</button>
        <button className="btn-secondary btn-small" disabled={!o} onClick={() => o && smoothObject(o.id, { iterations: relax, creaseDeg: s.edgeAngle, paintedOnly })}>Relax surface</button>
        <label className="row" style={{ gap: 4, fontSize: 12 }} title="Only move vertices of triangles that carry colour, support or seam paint"><input type="checkbox" checked={paintedOnly} onChange={(e) => setPaintedOnly(e.target.checked)} />Painted area only</label>
      </div>
      <h4 style={{ marginTop: 6 }}>Even triangles</h4>
      <p className="muted" style={{ fontSize: 12, margin: '0 0 6px' }}>Refine splits long edges (the shape does not change). Remesh also merges short edges and evens the triangles, which helps before bevelling or smoothing; creases and borders are kept.</p>
      <Slider label="Max edge" value={refineLen} min={0.2} max={20} step={0.1} unit="mm" onChange={setRefineLen} />
      <div className="row">
        <button className="btn-secondary btn-small" disabled={!o} onClick={() => o && refineObject(o.id, refineLen)}>Refine</button>
        <button className="btn-secondary btn-small" disabled={!o} onClick={() => o && remeshObject(o.id, refineLen, s.edgeAngle)}>Remesh</button>
      </div>
      {msg && <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>{msg}</p>}
    </div>
  );
}

const fmtTris = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} M` : n >= 1e3 ? `${Math.round(n / 1e3)} k` : String(n));
