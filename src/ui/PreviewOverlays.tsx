import { useEffect, useMemo, useRef, useState } from 'react';
import { FEATURE_LABELS, FEATURE_ORDER, type FeatureType } from '../engine/types';
import { sliceAndPreview } from '../state/actions';
import { exportPlateFile } from '../state/printjob';
import { cancelSlice } from '../state/slicing';
import { openPrintDialog } from './PrintModal';
import { printerById } from '../profiles/printers';
import { useStore, type ColorScheme } from '../state/store';
import { FEATURE_COLORS, RAMP_CSS, WAVE_ACCENT, WAVE_PLAIN } from '../viewport/toolpaths';
import { Icon } from './icons';

export const fmtTime = (s: number) => {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.round(s % 60);
  return h ? `${h}h ${m}m` : m ? `${m}m ${sec}s` : `${sec}s`;
};

/** Views behind "Advanced": the two everyday views (Real colours, Wave area) have their own buttons. */
const SCHEMES: { id: ColorScheme; label: string }[] = [
  { id: 'feature', label: 'Line type' },
  { id: 'speed', label: 'Speed' },
  { id: 'height', label: 'Layer height' },
  { id: 'width', label: 'Line width' },
  { id: 'flow', label: 'Volumetric flow rate' },
  { id: 'fan', label: 'Fan speed' },
  { id: 'temperature', label: 'Temperature' },
  { id: 'layer_time', label: 'Layer time' },
  { id: 'layer_time_log', label: 'Layer time (log)' },
];

export function Legend() {
  const { slice, colorScheme, hiddenFeatures, showTravel, set, filaments } = useStore();
  const [range, setRange] = useState<{ min: number; max: number; unit: string; log?: boolean } | null>(null);
  useEffect(() => {
    const f = () => setRange((window as any).__nxLegend ?? null);
    window.addEventListener('nx-legend', f);
    f();
    return () => window.removeEventListener('nx-legend', f);
  }, []);
  const r = slice.result;
  // share of the outer wall the wave texture changed
  const waved = useMemo(() => {
    if (!r?.moveWave) return 0;
    const outerIdx = [FEATURE_ORDER.indexOf('outer_wall'), FEATURE_ORDER.indexOf('overhang_wall')];
    let all = 0, on = 0;
    for (let i = 0; i < r.moveFeatures.length; i++) if (outerIdx.includes(r.moveFeatures[i])) { all++; if (r.moveWave[i] > 0) on++; }
    return all ? on / all : 0;
  }, [r]);
  if (!r) return null;
  const st = r.stats;
  const feats = FEATURE_ORDER.filter((f) => f !== 'travel' && st.byFeature[f]);
  const toggle = (f: FeatureType) => set({ hiddenFeatures: hiddenFeatures.includes(f) ? hiddenFeatures.filter((x) => x !== f) : [...hiddenFeatures, f] });
  const advanced = colorScheme !== 'filament' && colorScheme !== 'wave';
  const lineTypes = (
    <div style={{ marginTop: 8 }}>
      <div className="lrow" style={{ color: 'var(--text-muted)', fontSize: 11 }}><span /><span /><span>Line type</span><span className="num">Time</span><span className="num">%</span><span className="num">Used</span></div>
      {feats.map((f) => {
        const off = hiddenFeatures.includes(f);
        const b = st.byFeature[f]!;
        return (
          <div key={f} className={`lrow ${off ? 'off' : ''}`}>
            <button className="eye" onClick={() => toggle(f)} aria-label={`Toggle ${FEATURE_LABELS[f]}`}><Icon name={off ? 'eyeOff' : 'eye'} size={15} /></button>
            <span className="swatch" style={{ background: FEATURE_COLORS[f] }} />
            <span>{FEATURE_LABELS[f]}</span>
            <span className="num">{fmtTime(b.time)}</span>
            <span className="num">{((b.time / st.timeSeconds) * 100).toFixed(1)}%</span>
            <span className="num" title={`${(b.filamentMm / 1000).toFixed(2)} m`}>{b.grams !== undefined ? `${b.grams.toFixed(1)} g` : `${(b.filamentMm / 1000).toFixed(2)} m`}</span>
          </div>
        );
      })}
      <div className={`lrow ${showTravel ? '' : 'off'}`}>
        <button className="eye" onClick={() => set({ showTravel: !showTravel })} aria-label="Toggle travel"><Icon name={showTravel ? 'eye' : 'eyeOff'} size={15} /></button>
        <span className="swatch" style={{ background: FEATURE_COLORS.travel }} />
        <span>Travel</span>
        <span className="num">{fmtTime(st.byFeature.travel?.time ?? 0)}</span>
        <span className="num">{(((st.byFeature.travel?.time ?? 0) / st.timeSeconds) * 100).toFixed(1)}%</span>
        <span />
      </div>
    </div>
  );
  return (
    <div className="float legend">
      <div className="row" style={{ marginBottom: 8, gap: 6 }}>
        <div className="seg legend-views" role="group" aria-label="Preview colours">
          <button className={colorScheme === 'filament' ? 'on' : ''} title="Every line in its filament colour: what the print will look like" onClick={() => set({ colorScheme: 'filament' })}>Real colours</button>
          <button className={colorScheme === 'wave' ? 'on' : ''} title="The part in grey and the wave texture in colour, so you can see where the wave goes" onClick={() => set({ colorScheme: 'wave' })}>Wave area</button>
        </div>
        <span className="spacer" />
        <select className="select" aria-label="Advanced views" style={{ flex: 'none', width: 92 }} value={advanced ? colorScheme : ''} title="More views: line types, speed, line width, flow, fan, temperature, layer time" onChange={(e) => e.target.value && set({ colorScheme: e.target.value as ColorScheme })}>
          <option value="">Advanced…</option>
          {SCHEMES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
      </div>
      {advanced && colorScheme !== 'feature' && range && (
        <>
          <div className="ramp" style={{ background: RAMP_CSS }} />
          <div className="row" style={{ justifyContent: 'space-between', color: 'var(--text-muted)' }}>
            <span>{range.min.toFixed(range.max < 10 ? 2 : 0)} {range.unit}</span>
            <span>{(range.log ? Math.sqrt(range.min * range.max) : (range.min + range.max) / 2).toFixed(range.max < 10 ? 2 : 0)}</span>
            <span>{range.max.toFixed(range.max < 10 ? 2 : 0)} {range.unit}</span>
          </div>
        </>
      )}
      {colorScheme === 'filament' && (
        <div>
          {st.perFilament.map((f, k) => (f.mm > 0.01 || st.perFilament.length === 1) && (
            <div key={k} className="lrow" style={{ gridTemplateColumns: 'auto 1fr auto' }}>
              <span className="swatch" style={{ background: filaments[k]?.color ?? '#888' }} />
              <span>Filament {k + 1}</span>
              <span className="num">{f.grams.toFixed(1)} g</span>
            </div>
          ))}
        </div>
      )}
      {colorScheme === 'wave' && (
        <div>
          <div className="lrow" style={{ gridTemplateColumns: 'auto 1fr' }}><span className="swatch" style={{ background: WAVE_ACCENT }} /><span>Wave texture{r.moveWave ? ` · ${Math.round(waved * 100)}% of the outer wall` : ''}</span></div>
          <div className="lrow" style={{ gridTemplateColumns: 'auto 1fr' }}><span className="swatch" style={{ background: WAVE_PLAIN }} /><span>Plain</span></div>
          {!r.moveWave && <p className="mx-muted" style={{ margin: '4px 0 0' }}>No wave in this slice. Turn on a texture in Motionex → Weave.</p>}
        </div>
      )}
      {colorScheme === 'feature' ? lineTypes : <details className="legend-details"><summary>Line types</summary>{lineTypes}</details>}
      {/* time, filament and layers also show under the inspector, so the full breakdown starts folded */}
      <details className="legend-details">
        <summary>Details</summary>
        {st.perFilament.length > 1 && (
          <div className="summary">
            {st.perFilament.map((f, k) => f.mm > 0.01 && (
              <span key={k} style={{ display: 'contents' }}>
                <span className="k row" style={{ margin: 0 }}><span className="swatch" style={{ background: filaments[k]?.color ?? '#888' }} />Filament {k + 1}</span>
                <span className="v">{(f.mm / 1000).toFixed(2)} m · {f.grams.toFixed(2)} g</span>
              </span>
            ))}
            <span className="k">Filament changes</span><span className="v">{st.toolChanges}</span>
            {st.towerGrams > 0 && <><span className="k">Prime tower</span><span className="v">{st.towerGrams.toFixed(2)} g</span></>}
            {(st.flushGrams ?? 0) > 0 && <><span className="k">Flushed</span><span className="v">{st.flushGrams!.toFixed(2)} g</span></>}
          </div>
        )}
        <div className="summary">
          <span className="k">{st.repeat ? 'One print' : 'Estimated time'}</span><span className="v">{fmtTime(st.timeSeconds)}</span>
          {st.repeat && <>
            <span className="k">Printed</span><span className="v">{st.repeat.cycles}× · {st.repeat.cycles * st.repeat.partsPerCycle} parts (preview shows one print)</span>
            <span className="k">Cool, push, re-heat</span><span className="v">{fmtTime(st.repeat.coolSeconds + st.repeat.pushSeconds)} + {fmtTime(st.repeat.reheatSeconds)} per cycle</span>
            <span className="k">Whole job</span><span className="v">{fmtTime(st.repeat.totalSeconds)}</span>
            <span className="k">Job filament</span><span className="v">{(st.repeat.totalMm / 1000).toFixed(2)} m · {st.repeat.totalGrams.toFixed(1)} g</span>
          </>}
          <span className="k">Filament</span><span className="v">{(st.filamentMm / 1000).toFixed(2)} m · {st.filamentGrams.toFixed(2)} g</span>
          <span className="k">Layers</span><span className="v">{st.layerCount}</span>
        </div>
      </details>
      {slice.dirty && (
        <div className="row" style={{ marginTop: 10, color: 'var(--warning)' }}>
          <Icon name="warn" size={14} /><span style={{ flex: 1 }}>Settings changed since this slice.</span>
          <button className="btn-secondary btn-small" onClick={sliceAndPreview}>Re-slice</button>
        </div>
      )}
      <div className="row" style={{ marginTop: 10 }}>
        <button className="btn-secondary" style={{ flex: 1, minWidth: 0 }} onClick={() => exportPlateFile(printerById(useStore.getState().printerId).flavor === 'bbl' ? '3mf' : 'gcode')} title="A1/P1/X1/H2 printers: .gcode.3mf with thumbnail; others: G-code with thumbnails"><Icon name="download" />Export</button>
        <button className="btn-primary" style={{ flex: 1, minWidth: 0 }} onClick={openPrintDialog}><Icon name="print" />Print plate</button>
      </div>
    </div>
  );
}

/** Dual-handle vertical layer slider. */
export function LayerSlider() {
  const { slice, layerRange, set } = useStore();
  const track = useRef<HTMLDivElement>(null);
  const layers = slice.result?.layers ?? [];
  const n = layers.length;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!n || (e.target as HTMLElement).tagName === 'INPUT') return;
      const st = useStore.getState();
      if (st.workspace !== 'preview') return;
      const [lo, hi] = st.layerRange;
      const one = st.oneLayer;
      if (e.key === 'ArrowUp') { const h = Math.min(n - 1, hi + 1); set({ layerRange: [one ? h : lo, h], moveCursor: -1 }); e.preventDefault(); }
      if (e.key === 'ArrowDown') { const h = Math.max(one ? 0 : lo, hi - 1); set({ layerRange: [one ? h : lo, h], moveCursor: -1 }); e.preventDefault(); }
      if ((e.key === 'l' || e.key === 'L') && !e.ctrlKey && !e.metaKey) {
        // L shows only the current top layer; again restores the range
        set(one ? { oneLayer: false, layerRange: [st.savedLow ?? 0, hi] } : { oneLayer: true, savedLow: lo, layerRange: [hi, hi] });
        e.preventDefault();
      }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        const r = st.slice.result;
        if (!r) return;
        const L = r.layers[hi], count = L.moveEnd - L.moveStart;
        const cur = st.moveCursor < 0 ? count - 1 : st.moveCursor;
        const nx = Math.max(0, Math.min(count - 1, cur + (e.key === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 10 : 1)));
        set({ moveCursor: nx >= count - 1 ? -1 : nx });
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [n, set]);
  if (!n) return null;
  const [lo, hi] = layerRange;
  const pos = (i: number) => `${100 - (i / Math.max(1, n - 1)) * 100}%`;
  const plates = useStore.getState().plates;
  const plateIdx = slice.plate;
  const actions = plates[plateIdx]?.layerActions ?? [];
  const layerOf = (z: number) => Math.max(0, layers.findIndex((L) => L.z >= z - 1e-6));
  const drag = (which: 0 | 1) => (e: React.PointerEvent) => {
    e.preventDefault();
    const el = track.current!;
    const move = (ev: PointerEvent) => {
      // the button was released somewhere we never heard about (outside the window, over an iframe, alt-tab): stop dragging
      if (ev.buttons === 0) { up(); return; }
      const r = el.getBoundingClientRect();
      const t = 1 - Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height));
      const i = Math.round(t * (n - 1));
      const { layerRange: [a, b], oneLayer } = useStore.getState();
      set({ layerRange: oneLayer ? [i, i] : which === 1 ? [a, Math.max(a, i)] : [Math.min(i, b), b], moveCursor: -1 });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      window.removeEventListener('blur', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    window.addEventListener('blur', up);
    move(e.nativeEvent);
  };
  return (
    <div className="float vslider" aria-label="Layer slider">
      <div className="lbl">{hi + 1}<small>{layers[hi].z.toFixed(2)}</small></div>
      <div className="track" ref={track}>
        <div className="fill" style={{ top: pos(hi), bottom: `${100 - parseFloat(pos(lo))}%` }} />
        <div className="handle" style={{ top: pos(hi) }} onPointerDown={drag(1)} title="Top layer (↑/↓)" />
        <div className="handle" style={{ top: pos(lo), background: 'var(--surface-secondary)' }} onPointerDown={drag(0)} title="Bottom layer" />
        {actions.map((a, k) => (
          <div key={k} className={`marker ${a.type}`} style={{ top: pos(layerOf(a.z)) }} title={`${a.type === 'pause' ? 'Pause' : a.type === 'color' ? `Change to filament ${(a.filament ?? 0) + 1}` : 'Custom G-code'} at layer ${layerOf(a.z) + 1} — click to remove`}
            onClick={() => removeAction(plateIdx, k)} />
        ))}
      </div>
      <LayerActionMenu z={layers[hi].z} layer={hi} plate={plateIdx} />
      <button className={`icon-btn ${useStore.getState().oneLayer ? 'active' : ''}`} title="Show one layer only (L)" aria-label="One layer"
        onClick={() => { const st = useStore.getState(); set(st.oneLayer ? { oneLayer: false, layerRange: [st.savedLow ?? 0, hi] } : { oneLayer: true, savedLow: lo, layerRange: [hi, hi] }); }}>
        <Icon name="layers" size={15} />
      </button>
      <div className="lbl">{lo + 1}<small>{layers[lo].z.toFixed(2)}</small></div>
    </div>
  );
}

export function MoveSlider() {
  const { slice, layerRange, moveCursor, showGcode, set } = useStore();
  const r = slice.result;
  if (!r || !r.layers.length) return null;
  const L = r.layers[layerRange[1]];
  const count = L.moveEnd - L.moveStart;
  const v = moveCursor < 0 ? count - 1 : moveCursor;
  return (
    <div className="float hslider">
      <MovePlayer count={count} />
      <input type="range" min={0} max={Math.max(0, count - 1)} value={v} aria-label="Move slider"
        onChange={(e) => { const x = +e.target.value; set({ moveCursor: x >= count - 1 ? -1 : x }); }} />
      <span className="mono" style={{ minWidth: 90, textAlign: 'right', color: 'var(--text-muted)' }}>{v + 1} / {count}</span>
      <button className={`icon-btn ${showGcode ? 'active' : ''}`} title="Show G-code next to the move slider" aria-label="G-code" onClick={() => set({ showGcode: !showGcode })}><Icon name="file" size={15} /></button>
      {showGcode && r.moveLines && <GcodeLines gcode={r.gcode} line={r.moveLines[L.moveStart + v]} move={L.moveStart + v} />}
    </div>
  );
}

const PLAY_SPEEDS = [1, 2, 5, 10] as const;
/** Intra-layer toolhead playback: steps the move cursor (and so the nozzle marker) through the top layer. */
function MovePlayer({ count }: { count: number }) {
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<(typeof PLAY_SPEEDS)[number]>(1);
  useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => {
      const st = useStore.getState();
      if (st.moveCursor < 0) { setPlaying(false); return; } // the user jumped to the end
      const nx = st.moveCursor + speed;
      if (nx >= count - 1) { st.set({ moveCursor: -1 }); setPlaying(false); }
      else st.set({ moveCursor: nx });
    }, 40);
    return () => clearInterval(t);
  }, [playing, speed, count]);
  const toggle = () => {
    if (!playing && useStore.getState().moveCursor < 0) useStore.getState().set({ moveCursor: 0 }); // restart from the layer start
    setPlaying(!playing);
  };
  return (
    <>
      <button className={`icon-btn ${playing ? 'active' : ''}`} title={playing ? 'Pause' : 'Play the moves of this layer'} aria-label={playing ? 'Pause' : 'Play'} onClick={toggle}>
        <span aria-hidden style={{ fontSize: 13, lineHeight: 1 }}>{playing ? '❚❚' : '▶'}</span>
      </button>
      <button className="btn-secondary btn-small mono" title="Playback speed" aria-label="Playback speed" style={{ minWidth: 36 }}
        onClick={() => setSpeed(PLAY_SPEEDS[(PLAY_SPEEDS.indexOf(speed) + 1) % PLAY_SPEEDS.length])}>{speed}×</button>
    </>
  );
}

const lineCache = new WeakMap<object, string[]>();
/** The G-code around the current move, shown beside the horizontal slider, current line highlighted. */
function GcodeLines({ gcode, line, move }: { gcode: string; line: number; move: number }) {
  const r = useStore.getState().slice.result!;
  let lines = lineCache.get(r);
  if (!lines) { lines = gcode.split('\n'); lineCache.set(r, lines); }
  const from = Math.max(0, line - 6), to = Math.min(lines.length, line + 7);
  const aux = r.moveAux;
  return (
    <div className="gcode-view mono" aria-label="G-code">
      {lines.slice(from, to).map((t, k) => (
        <div key={from + k} className={from + k === line ? 'cur' : ''}><span className="ln">{from + k + 1}</span>{t || ' '}</div>
      ))}
      {aux && <div className="aux">Fan {Math.round(aux[move * 2])}% · {Math.round(aux[move * 2 + 1])} °C</div>}
    </div>
  );
}

export function SliceProgress() {
  const slice = useStore((s) => s.slice);
  if (slice.status !== 'slicing') return null;
  return (
    <div className="float progress" role="status">
      <div className="row"><b>Slicing plate</b><span className="spacer" /><span className="mono">{Math.round(slice.progress * 100)}%</span></div>
      <div style={{ color: 'var(--text-muted)', marginTop: 4 }}>{slice.stage}…</div>
      <div className="bar"><div style={{ width: `${slice.progress * 100}%` }} /></div>
      <div className="row" style={{ marginTop: 10, justifyContent: 'flex-end' }}>
        <button className="btn-secondary btn-small" title="Cancel slicing (Esc)" aria-label="Cancel slicing" onClick={() => cancelSlice()}><Icon name="cancel" size={15} />Cancel</button>
      </div>
    </div>
  );
}

export function PreviewEmpty() {
  const { slice, objects } = useStore();
  if (slice.result || slice.status === 'slicing') return null;
  return (
    <div className="empty">
      <div className="hint">
        <b>Nothing sliced yet</b>
        {objects.length ? <button className="btn-primary" style={{ marginTop: 8 }} onClick={sliceAndPreview}><Icon name="slice" />Slice plate</button> : 'Add a model in Prepare, then slice.'}
      </div>
    </div>
  );
}

function removeAction(plate: number, k: number) {
  const s = useStore.getState();
  s.set({ plates: s.plates.map((p, i) => (i === plate ? { ...p, layerActions: p.layerActions.filter((_, j) => j !== k) } : p)) });
  s.markDirty(true);
}

function LayerActionMenu({ z, layer, plate }: { z: number; layer: number; plate: number }) {
  const { filaments, set } = useStore();
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState('');
  const [fil, setFil] = useState(1);
  const add = (a: { type: 'pause' | 'color' | 'custom'; filament?: number; gcode?: string }) => {
    const s = useStore.getState();
    set({ plates: s.plates.map((p, i) => (i === plate ? { ...p, layerActions: [...p.layerActions, { z, ...a }] } : p)) });
    s.markDirty(true);
    setOpen(false);
  };
  return (
    <div className="menu" style={{ marginTop: 4 }}>
      <button className="icon-btn" title={`Add action at layer ${layer + 1}`} aria-label="Add layer action" onClick={() => setOpen(!open)}><Icon name="add" /></button>
      {open && (
        <div className="menu-pop" style={{ right: 40, left: 'auto', top: -120, width: 260 }}>
          <div className="menu-label">At layer {layer + 1} ({z.toFixed(2)} mm)</div>
          <button className="menu-item" onClick={() => add({ type: 'pause' })}><span>Add pause</span><kbd>M400 U1 / PAUSE</kbd></button>
          <div className="row" style={{ padding: '4px 10px' }}>
            <span style={{ flex: 1 }}>Change filament to</span>
            <select className="select" style={{ flex: 'none', width: 60 }} value={fil} onChange={(e) => setFil(+e.target.value)}>
              {filaments.map((_, k) => <option key={k} value={k}>{k + 1}</option>)}
            </select>
            <button className="btn-secondary btn-small" onClick={() => add({ type: 'color', filament: fil })}>Add</button>
          </div>
          <div style={{ padding: '4px 10px' }}>
            <textarea className="input mono" style={{ width: '100%', height: 54, padding: 6 }} placeholder="Custom G-code, e.g. M104 S215" value={custom} onChange={(e) => setCustom(e.target.value)} />
            <button className="btn-secondary btn-small" style={{ marginTop: 4 }} disabled={!custom.trim()} onClick={() => add({ type: 'custom', gcode: custom.trim() })}>Add custom G-code</button>
          </div>
        </div>
      )}
    </div>
  );
}
