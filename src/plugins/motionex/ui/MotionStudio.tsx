// Motion tab: change the motion of one placement and watch it on the model as you go. The model view
// keeps drawing the quick motion preview; this panel holds the shape, depth and spacing, how layers lead
// or lag each other, layer stacking and the advanced curves, with close-ups of a short piece of wall.
// Edits go into the placement's own copy of the motion; the library is left alone unless you save to it.
import { askOk } from '../../../ui/askOk';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { evalCurve } from '../curve';
import { useStore } from '../../../state/store';
import { currentConfig } from '../../../state/slicing';
import { SURFACE_COLORS } from '../../../state/motionPaint';
import { profilesFromConfig } from '../engine';
import { composePath, layerPhase } from '../modifier';
import { VIEW_COLORS, type PreviewView } from '../preview';
import type { PrintProfiles } from '../core/profiles';
import type { Toolpath, ToolpathPoint } from '../core/types';
import { CURVE_INFO, pt, type CurveKey, type EventType, type Interpolation, type LayerEffect, type LayerMode, type WaveShape, type MotionApplication, type MotionBrush, type MotionEvent } from '../model';
import { CurveEditor } from './curveEditor';
import { activate, activeApp, addApplication, brushOf, changed, lastPreview, motionexPreview, mx, surfaceOf, toFaces, useMx, Wave } from './MotionexPanel';
import { motionCounts } from '../../../state/motionPaint';
import { Icon, IconButton, LiveBadge, Num, Row, Seg, SideCard, Stat, StudioWindow, Tabs, ToolGroup, VSep } from '../../../ui/studio/Studio';
import { LinePreview3D, type LinePreviewControls } from '../../../ui/studio/LinePreview3D';
import { openMotionStudio } from './studioWindow';

/** The motion being edited: the placement's own copy, or a copy of the library motion with its size slider baked in. */
function draftOf(a: MotionApplication): MotionBrush | undefined {
  if (a.brush) return a.brush;
  const b = mx.library.get(a.brush_id);
  if (!b) return undefined;
  const c = structuredClone(b), k = a.scale ?? 1;
  if (k !== 1) { c.amplitude *= k; c.period_mm *= k; c.z_amplitude = (c.z_amplitude ?? 0) * k; }
  return c;
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;

// ----- wave shapes for the side-to-side curve
const SINE_H = 0.25 / 3, SINE_D = SINE_H * 2 * Math.PI;
const SHAPES: { id: string; label: string; make: () => MotionBrush['curves']['lateral_offset'] }[] = [
  { id: 'sine', label: 'Wave', make: () => ({ interpolation: 'bezier', points: [pt(0, 0, [-SINE_H, -SINE_D], [SINE_H, SINE_D]), pt(0.25, 1, [-SINE_H, 0], [SINE_H, 0]), pt(0.5, 0, [-SINE_H, SINE_D], [SINE_H, -SINE_D]), pt(0.75, -1, [-SINE_H, 0], [SINE_H, 0]), pt(1, 0, [-SINE_H, -SINE_D], [SINE_H, SINE_D])] }) },
  { id: 'zigzag', label: 'Zigzag', make: () => ({ interpolation: 'linear', points: [pt(0, 0), pt(0.25, 1), pt(0.75, -1), pt(1, 0)] }) },
  { id: 'square', label: 'Square', make: () => ({ interpolation: 'linear', points: [pt(0, 1), pt(0.48, 1), pt(0.52, -1), pt(0.98, -1), pt(1, 1)] }) },
  { id: 'scallop', label: 'Scallops', make: () => ({ interpolation: 'bezier', points: [pt(0, 0, [0, 0], [1 / 6, Math.PI / 6]), pt(0.5, 1, [-1 / 6, 0], [1 / 6, 0]), pt(1, 0, [-1 / 6, Math.PI / 6], [0, 0])] }) },
  { id: 'saw', label: 'Saw', make: () => ({ interpolation: 'linear', points: [pt(0, -1), pt(0.9, 1), pt(1, -1)] }) },
  { id: 'pulse', label: 'Bumps', make: () => ({ interpolation: 'bezier', points: [pt(0, 0), pt(0.35, 0, [0, 0], [0.06, 0]), pt(0.5, 1, [-0.06, 0], [0.06, 0]), pt(0.65, 0, [-0.06, 0], [0, 0]), pt(1, 0)] }) },
];

// ----- layer stacking presets
const STACKS: { id: string; label: string; hint: string; make: (b: MotionBrush) => LayerEffect | null }[] = [
  { id: 'aligned', label: 'Lined up', hint: 'Every layer sits exactly on the one below.', make: () => null },
  { id: 'twist', label: 'Twist', hint: 'Each layer leads the one below a little, so the ridges climb round the part.', make: () => ({ shift_deg: 6, mode: 'steady', every: 1, band_on: 0, band_off: 0 }) },
  { id: 'bricks', label: 'Bricks', hint: 'Every few layers the motion moves half a step, like brickwork.', make: () => ({ shift_deg: 180, mode: 'alternate', every: 4, band_on: 0, band_off: 0 }) },
  { id: 'zigzag', label: 'Zigzag', hint: 'Layers lead for a while, then lag back.', make: () => ({ shift_deg: 6, mode: 'back_and_forth', every: 15, band_on: 0, band_off: 0 }) },
  { id: 'wavy', label: 'Wavy', hint: 'Layers swing smoothly between leading and lagging: ridges snake up the wall.', make: () => ({ shift_deg: 30, lag_deg: 30, mode: 'wave', wave_shape: 'sine', every: 24, band_on: 0, band_off: 0 }) },
  { id: 'diamond', label: 'Diamonds', hint: 'Slants both ways at once for a diamond grid.', make: () => ({ shift_deg: 6, mode: 'back_and_forth', every: 15, band_on: 0, band_off: 0, cross: true }) },
  { id: 'bands', label: 'Bands', hint: 'Motion for some layers, then plain wall.', make: (b) => ({ shift_deg: 0, mode: 'steady', every: 1, ...b.layers, band_on: 10, band_off: 6 }) },
];
const MODES: [LayerMode, string, string][] = [
  ['steady', 'Keep going', 'Each step leads (or lags) further: a twist.'],
  ['alternate', 'Swap', 'Moves over and back every step.'],
  ['back_and_forth', 'There and back', 'Leads for a number of steps, then comes back.'],
  ['shift_hold', 'With pauses', 'Like there and back, but holds at each end.'],
  ['wave', 'Wave', 'Swings between leading and lagging in a smooth (or chosen) wave.'],
];
const WAVE_SHAPES: [WaveShape, string, string][] = [
  ['sine', 'Smooth', 'A smooth sine swing: soft S-shaped ridges.'],
  ['rounded', 'Rounded', 'Holds near full lead and full lag, with smooth turns.'],
  ['triangle', 'Zigzag', 'Straight runs with sharp turns.'],
  ['square', 'Jump', 'Jumps between lead and lag: offset blocks.'],
  ['ramp', 'Ramp', 'Creeps forward, then snaps back: saw-tooth ridges.'],
];

const ADV_KEYS: CurveKey[] = ['along_offset', 'z_offset', 'extrusion_mult', 'speed_mult'];
const CURVE_HINT: Record<CurveKey, string> = {
  lateral_offset: 'Side to side, in and out of the wall.',
  along_offset: 'Forwards and back along the wall: makes loops and curls. The model shows the motion itself.',
  z_offset: 'Up and down within the layer. The model is coloured by height: orange lifted, blue lowered.',
  extrusion_mult: 'How much plastic each spot gets. The model is coloured by plastic and the close-up line gets thicker and thinner.',
  speed_mult: 'How fast each spot prints. The model is coloured by speed.',
};

export function MotionStudio({ layout = 'dock' }: { layout?: 'dock' | 'three' } = {}) {
  useMx();
  const set = useStore((s) => s.set);
  const printerId = useStore((s) => s.printerId);
  const overrides = useStore((s) => s.overrides);
  const apps = mx.applications;
  const a = activeApp();
  const draft = useMemo(() => (a ? draftOf(a) : undefined), [a, a?.brush, a?.brush_id, a?.scale]); // eslint-disable-line react-hooks/exhaustive-deps
  const profiles = useMemo(() => profilesFromConfig(currentConfig(), printerId), [printerId, overrides]); // eslint-disable-line react-hooks/exhaustive-deps
  const [layer, setLayer] = useState(10);
  // the Studio always has a motion to show: a Wave on the whole plate, so it is on the model straight away
  useEffect(() => { if (layout === 'three' && !mx.applications.length) { const n = addApplication('preset-sine'); n.target = { ...n.target, type: 'body' }; changed(); } }, [layout, apps.length]);

  if (!a || !draft) {
    if (layout === 'three') return null;
    return (
      <aside className="studio">
        <div className="studio-empty">
          <b>No motion yet</b>
          <p className="mx-muted">Start with a Wave and change it here. Choose where it goes on the model from the Motionex bar.</p>
          <button className="btn-primary btn-small" onClick={() => { addApplication('preset-sine'); changed(); }}>Add a Wave</button>
        </div>
      </aside>
    );
  }

  /** Make an edit: the placement takes its own copy on the first one. */
  const edit = (fn: (b: MotionBrush) => void) => {
    remember(a);
    if (!a.brush) { a.brush = draft; a.scale = 1; }
    fn(draft);
    settle(a);
    changed();
  };
  const base = mx.library.get(a.brush_id);
  const libGroups = new Map<string, MotionBrush[]>();
  for (const b of mx.library.all()) { const g = mx.library.isPreset(b.id) ? b.category ?? 'Other' : 'My motions'; libGroups.set(g, [...(libGroups.get(g) ?? []), b]); }
  const saveToLibrary = () => {
    const name = prompt('Name for the new motion', `${draft.name} (mine)`)?.trim();
    if (!name) return;
    const saved = mx.library.save({ ...structuredClone(draft), id: `user-${Date.now().toString(36)}`, name, version: 1, tags: ['custom'], category: undefined });
    hist.delete(a);
    a.brush_id = saved.id; a.brush = undefined; a.scale = 1;
    changed();
    useStore.getState().set({ toast: { kind: 'info', text: `Saved “${name}” under My motions.` } });
  };

  if (layout === 'three') return <StudioShell a={a} draft={draft} edit={edit} profiles={profiles} layer={layer} setLayer={setLayer} saveToLibrary={saveToLibrary} />;

  return (
    <aside className="studio" aria-label="Motion editor">
      <div className="studio-head">
        {apps.length > 1 && (
          <div className="studio-places">
            {apps.map((x, i) => (
              <button key={i} className={`studio-place ${x === a ? 'on' : ''}`} onClick={() => activate(i)} title={brushOf(x)?.name}>
                <i className="mx-dot" style={{ background: SURFACE_COLORS[surfaceOf(x) - 1] }} />{brushOf(x)?.name ?? x.brush_id}
              </button>
            ))}
          </div>
        )}
        <div className="row" style={{ gap: 8, margin: 0, alignItems: 'center' }}>
          <i className="mx-dot" style={{ background: SURFACE_COLORS[surfaceOf(a) - 1] }} />
          <select className="select" style={{ flex: 1 }} value={a.brush_id} aria-label="Motion"
            onChange={(e) => { if (a.brush && !askOk('Switching motion drops your changes to this one. Switch anyway?')) return; a.brush_id = e.target.value; a.brush = undefined; changed(); }}>
            {[...libGroups].map(([g, bs]) => <optgroup key={g} label={g}>{bs.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</optgroup>)}
          </select>
        </div>
        <div className="row" style={{ gap: 6, margin: 0, alignItems: 'center' }}>
          <span className="mx-muted" style={{ flex: 1, margin: 0 }}>{a.brush ? `Changed for this placement · library “${base?.name ?? a.brush_id}” is unchanged` : 'As in the library · any change applies to this placement only'}</span>
          <button className="btn-secondary btn-small" disabled={!a.brush} onClick={() => { if (askOk('Go back to the library motion?')) { a.brush = undefined; changed(); } }}>Reset</button>
          <button className="btn-secondary btn-small" onClick={saveToLibrary} title="Keep these changes as a new motion in My motions">Save to library</button>
        </div>
      </div>

      <ViewPicker />

      <CloseUps b={draft} profiles={profiles} layer={layer} setLayer={setLayer} />

      <section className="mx-card">
        <div className="mx-card-title">Wave shape</div>
        <div className="studio-shapes">
          {SHAPES.map((sh) => {
            const demo = { ...draft, curves: { ...draft.curves, lateral_offset: sh.make() }, layers: null, noise: null, z_amplitude: 0, repeat_mode: 'tile' as const };
            return (
              <button key={sh.id} className="mx-lib-card" title={sh.label} onClick={() => edit((b) => { b.curves.lateral_offset = sh.make(); })}>
                <Wave b={demo} small /><span>{sh.label}</span>
              </button>
            );
          })}
        </div>
        <CurveBox b={draft} k="lateral_offset" onEdit={edit} />
      </section>

      <section className="mx-card">
        <div className="mx-card-title">Depth and spacing</div>
        <Slider label="Depth (in and out)" unit="mm" min={0} max={Math.max(3, draft.amplitude * 1.5)} step={0.05} value={draft.amplitude} onChange={(v) => edit((b) => { b.amplitude = v; })} />
        <Slider label="Spacing (one repeat)" unit="mm" min={0.4} max={Math.max(30, draft.period_mm * 1.5)} step={0.1} value={draft.period_mm} onChange={(v) => edit((b) => { b.period_mm = v; })} />
        <Slider label="Start shift along the wall" unit="mm" min={0} max={draft.period_mm} step={0.05} value={r3((draft.phase_deg / 360) * draft.period_mm)}
          onChange={(v) => edit((b) => { b.phase_deg = r3((v / b.period_mm) * 360) % 360; })} />
        <label className="row" style={{ gap: 8, margin: 0 }}>
          <span style={{ flex: 1, fontSize: 12 }}>Fit a whole number of repeats round each loop<div className="mx-muted" style={{ margin: 0 }}>Stretches the spacing a little so there is no seam where a loop closes.</div></span>
          <button className={`toggle ${draft.repeat_mode === 'stretch' ? 'on' : ''}`} aria-label="Fit evenly" onClick={() => edit((b) => { b.repeat_mode = b.repeat_mode === 'stretch' ? 'tile' : 'stretch'; })} />
        </label>
      </section>

      <LeadLag b={draft} layerHeight={profiles.process.layerHeight || 0.2} onEdit={edit} />

      <section className="mx-card">
        <div className="mx-card-title">Layer stacking</div>
        <div className="studio-shapes">
          {STACKS.map((st) => (
            <button key={st.id} className={`mx-tool ${stackId(draft) === st.id ? 'on' : ''}`} title={st.hint} onClick={() => edit((b) => { b.layers = st.make(b); })}>{st.label}</button>
          ))}
        </div>
        <p className="mx-muted" style={{ margin: 0 }}>{STACKS.find((s) => s.id === stackId(draft))?.hint ?? 'Your own stacking.'}</p>
        {draft.layers && (
          <>
            <div className="mx-label">How the lead changes from step to step</div>
            <div className="seg mx-seg">
              {MODES.map(([m, l, hint]) => <button key={m} title={hint} className={draft.layers!.mode === m ? 'on' : ''} onClick={() => edit((b) => { b.layers = { ...b.layers!, mode: m }; })}>{l}</button>)}
            </div>
            {draft.layers.mode !== 'alternate' && (
              <label className="row" style={{ gap: 8, margin: 0 }}>
                <span style={{ flex: 1, fontSize: 12 }}>Slant both ways (diamonds and cells)</span>
                <button className={`toggle ${draft.layers.cross ? 'on' : ''}`} aria-label="Slant both ways" onClick={() => edit((b) => { b.layers = { ...b.layers!, cross: !b.layers!.cross }; })} />
              </label>
            )}
          </>
        )}
        <div className="mx-two">
          <label className="mx-field">Motion on for (layers)
            <input className="input" type="number" min={0} step={1} value={draft.layers?.band_on ?? 0} title="0 = on all the time"
              onChange={(e) => edit((b) => { b.layers = { shift_deg: 0, mode: 'steady', every: 1, band_off: 0, ...b.layers, band_on: Math.max(0, Math.round(+e.target.value)) }; })} />
          </label>
          <label className="mx-field">then plain for (layers)
            <input className="input" type="number" min={0} step={1} value={draft.layers?.band_off ?? 0} disabled={!draft.layers?.band_on}
              onChange={(e) => edit((b) => { b.layers = { ...b.layers!, band_off: Math.max(0, Math.round(+e.target.value)) }; })} />
          </label>
        </div>
      </section>

      <Advanced b={draft} onEdit={edit} profiles={profiles} />
    </aside>
  );
}

function stackId(b: MotionBrush): string | null {
  const e = b.layers;
  if (!e || (!e.shift_deg && !e.band_on)) return 'aligned';
  if (e.band_on > 0) return 'bands';
  if (e.cross) return 'diamond';
  if (e.mode === 'steady') return 'twist';
  if (e.mode === 'alternate') return 'bricks';
  if (e.mode === 'wave') return 'wavy';
  if (e.mode === 'back_and_forth') return 'zigzag';
  return null;
}

function Slider({ label, unit, min, max, step, value, onChange, dot }: { label: string; unit: string; min: number; max: number; step: number; value: number; onChange: (v: number) => void; dot?: string }) {
  const wheel = (e: React.WheelEvent<HTMLInputElement>) => { if (document.activeElement !== e.currentTarget) return; e.preventDefault(); onChange(Math.max(min, r3(value + (e.deltaY < 0 ? step : -step) * (e.shiftKey ? 10 : 1)))); };
  return (
    <div className="studio-slider">
      <span className="studio-slider-label">{dot && <i className="ms-axdot" style={{ ['--ax' as string]: dot }} />}{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(+e.target.value)} aria-label={label} />
      <input className="input studio-num" type="number" min={min} step={step} value={r3(value)} onWheel={wheel} onChange={(e) => { const v = +e.target.value; if (Number.isFinite(v)) onChange(Math.max(min, v)); }} aria-label={`${label} (${unit})`} title="Type, drag the slider, or focus and scroll (Shift = ×10)" />
      <span className="studio-unit">{unit}</span>
    </div>
  );
}

/** How far each layer's motion sits ahead of (lead) or behind (lag) the layer below, in mm along the wall. */
function LeadLag({ b, layerHeight, onEdit }: { b: MotionBrush; layerHeight: number; onEdit: (fn: (b: MotionBrush) => void) => void }) {
  const e = b.layers;
  const mm = r3((((e?.shift_deg ?? 0) / 360) * b.period_mm));
  const every = e?.every ?? 1;
  const setShift = (v: number) => onEdit((x) => { x.layers = { mode: 'steady', every: 1, band_on: 0, band_off: 0, ...x.layers, shift_deg: r3((v / x.period_mm) * 360) }; });
  const angle = Math.atan2(Math.abs(mm), layerHeight * every) * 180 / Math.PI;
  return (
    <section className="mx-card">
      <div className="mx-card-title">Lead and lag between layers</div>
      <p className="mx-muted" style={{ margin: 0 }}>Moves each layer's motion along the wall compared with the layer below. 0 lines the layers up exactly. Plus leads, minus lags.</p>
      <Slider label="Each step leads by" unit="mm" min={-b.period_mm / 2} max={b.period_mm / 2} step={0.01} value={mm} onChange={setShift} />
      <div className="studio-slider">
        <span className="studio-slider-label">{e?.mode === 'wave' ? 'One full swing every' : 'One step every'}</span>
        <input type="range" min={1} max={40} step={1} value={every} onChange={(ev) => onEdit((x) => { x.layers = { shift_deg: 0, mode: 'steady', band_on: 0, band_off: 0, ...x.layers, every: +ev.target.value }; })} aria-label="Layers per step" />
        <input className="input studio-num" type="number" min={1} step={1} value={every} onChange={(ev) => onEdit((x) => { x.layers = { shift_deg: 0, mode: 'steady', band_on: 0, band_off: 0, ...x.layers, every: Math.max(1, Math.round(+ev.target.value)) }; })} aria-label="Layers per step (number)" />
        <span className="studio-unit">layers</span>
      </div>
      <div className="row" style={{ gap: 6, margin: 0, flexWrap: 'wrap' }}>
        <button className="btn-secondary btn-small" onClick={() => setShift(0)}>Line up (0)</button>
        <button className="btn-secondary btn-small" onClick={() => setShift(b.period_mm / 2)}>Half a repeat</button>
        <button className="btn-secondary btn-small" title="Lag by one line width, so each ridge sits a line behind the one below" onClick={() => setShift(-0.4)}>Lag 0.4 mm</button>
        <button className="btn-secondary btn-small" onClick={() => setShift(-mm)} disabled={!mm}>Flip lead ↔ lag</button>
      </div>
      {(e?.mode === 'alternate' || e?.mode === 'wave') && (
        <>
          <Slider label={e.mode === 'wave' ? 'Lags by (at the other end of the swing)' : 'The other layers lag by'} unit="mm" min={0} max={b.period_mm / 2} step={0.01}
            value={r3((((e.lag_deg ?? (e.mode === 'wave' ? e.shift_deg : 0)) / 360) * b.period_mm))}
            onChange={(v) => onEdit((x) => { x.layers = { ...x.layers!, lag_deg: r3((v / x.period_mm) * 360) }; })} />
          <p className="mx-muted" style={{ margin: 0 }}>{e.mode === 'wave' ? 'Lead and lag can differ: an uneven swing leans the snaking ridges one way.' : 'Alternate layers lead and lag by these amounts: 0 lag swaps between lined up and leading.'}</p>
        </>
      )}
      {e?.mode === 'wave' && (
        <>
          <div className="mx-label">Wave type</div>
          <div className="seg mx-seg">
            {WAVE_SHAPES.map(([k, l, hint]) => <button key={k} title={hint} className={(e.wave_shape ?? 'sine') === k ? 'on' : ''} onClick={() => onEdit((x) => { x.layers = { ...x.layers!, wave_shape: k }; })}>{l}</button>)}
          </div>
          <SwingGraph e={e} />
        </>
      )}
      <p className="mx-muted" style={{ margin: 0 }}>
        {e?.mode === 'wave' ? `One full swing every ${Math.max(2, every)} layers (${(Math.max(2, every) * layerHeight).toFixed(1)} mm of height). ` : ''}
        {mm === 0 ? 'Layers are lined up.' : `${mm > 0 ? 'Leads' : 'Lags'} ${Math.abs(mm).toFixed(2)} mm every ${every} layer${every > 1 ? 's' : ''}: ridges lean about ${angle.toFixed(0)}° from upright.`}
        {angle > 60 ? ' That is a steep lean; ridges may not stack well.' : ''}
      </p>
    </section>
  );
}

/** Lead (up) and lag (down) of each layer over two swings, so the chosen wave type and amounts are visible. */
function SwingGraph({ e }: { e: LayerEffect }) {
  const n = Math.max(2, e.every) * 2, lead = Math.max(1e-9, e.shift_deg), lag = e.lag_deg ?? e.shift_deg, m = Math.max(lead, lag, 1e-9);
  const pts = Array.from({ length: n + 1 }, (_, i) => {
    const d = layerPhase({ layers: { ...e, band_on: 0 } } as MotionBrush, i) ?? 0;
    return `${(i / n) * 100},${15 - (d / m) * 13}`;
  }).join(' ');
  return (
    <svg className="mx-wave" viewBox="0 0 100 30" preserveAspectRatio="none" aria-label="Lead and lag by layer">
      <line x1="0" y1="15" x2="100" y2="15" stroke="currentColor" strokeOpacity="0.25" strokeWidth="0.5" vectorEffect="non-scaling-stroke" />
      <polyline points={pts} fill="none" stroke="var(--accent, #2b7cff)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}

/** One curve with its graph editor and a choice of smooth, straight or stepped. */
function CurveBox({ b, k, onEdit }: { b: MotionBrush; k: CurveKey; onEdit: (fn: (b: MotionBrush) => void) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const info = CURVE_INFO[k];
  const editRef = useRef(onEdit);
  editRef.current = onEdit;
  useEffect(() => {
    if (!host.current) return;
    const ed = new CurveEditor(b.curves[k], { min: info.min, max: info.max, disabled: false, onChange: () => editRef.current(() => {}), onSelect: () => {} });
    ed.canvas.style.height = '170px';
    ed.canvas.style.width = '100%';
    host.current.replaceChildren(ed.canvas);
    requestAnimationFrame(() => ed.draw());
  }, [b, b.curves[k], k]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="studio-curve">
      <div className="row" style={{ gap: 6, margin: 0, alignItems: 'center' }}>
        <span className="mx-muted" style={{ flex: 1, margin: 0 }}>{info.label} · {info.unit} · drag the dots, double-click to add one, Delete removes</span>
        <select className="select" style={{ width: 'auto' }} value={b.curves[k].interpolation} aria-label="Curve type"
          onChange={(e) => onEdit((x) => { x.curves[k] = { ...x.curves[k], interpolation: e.target.value as Interpolation }; })}>
          <option value="bezier">Smooth</option><option value="linear">Straight</option><option value="step">Steps</option>
        </select>
      </div>
      <div ref={host} className="studio-curve-host" />
    </div>
  );
}

/** The model preview shows what each advanced curve changes. */
const VIEW_FOR: Record<CurveKey, PreviewView> = { lateral_offset: 'motion', along_offset: 'motion', z_offset: 'height', extrusion_mult: 'plastic', speed_mult: 'speed' };

function Advanced({ b, onEdit, profiles, three = false }: { b: MotionBrush; onEdit: (fn: (b: MotionBrush) => void) => void; profiles: PrintProfiles; three?: boolean }) {
  const keys = three ? ADV_KEYS.filter((x) => x !== 'z_offset') : ADV_KEYS;
  const [k, setKey] = useState<CurveKey>(three ? 'along_offset' : 'z_offset');
  const Wrap = three ? 'section' : 'details';
  const setK = (x: CurveKey) => { setKey(x); setView(VIEW_FOR[x]); };
  const n = b.noise;
  const zFlat = !(b.z_amplitude && b.z_amplitude > 0);
  // a Z curve does nothing at zero height: editing it gives it a height so the change shows
  const curveEdit = k === 'z_offset' ? (fn: (x: MotionBrush) => void) => onEdit((x) => { fn(x); if (!(x.z_amplitude && x.z_amplitude > 0)) x.z_amplitude = Math.min(0.3, profiles.process.layerHeight * 1.5 || 0.3); }) : onEdit;
  // plastic limits and plastic events show in the plastic view
  const plasticEdit = (fn: (x: MotionBrush) => void) => { setView('plastic'); onEdit(fn); };
  const newEvent = (t: EventType): MotionEvent => t === 'dwell' ? { at: { mode: 'percent', value: 50 }, type: t, params: { ms: 300, blob_mm3: 0 } }
    : t === 'flow_change' ? { at: { mode: 'percent', value: 50 }, type: t, params: { mult: 1.3 } }
    : { at: { mode: 'percent', value: 50 }, type: t, params: { length: 0, travel_mm: 1 } };
  return (
    <Wrap className={three ? 'mx-card' : 'mx-card mx-more'} onToggle={three ? undefined : (e: React.SyntheticEvent) => { if ((e.currentTarget as HTMLDetailsElement).open) setView(VIEW_FOR[k]); }}>
      {three ? <div className="mx-card-title">Ramps and flow</div> : <summary className="mx-card-title">Advanced</summary>}
      <div className="seg mx-seg">
        {keys.map((x) => <button key={x} className={k === x ? 'on' : ''} onClick={() => setK(x)}>{CURVE_INFO[x].label}</button>)}
      </div>
      {k === 'z_offset' && <Slider label="Up-and-down height" unit="mm" min={0} max={3} step={0.05} value={b.z_amplitude ?? 0} onChange={(v) => onEdit((x) => { x.z_amplitude = v; })} />}
      {k === 'z_offset' && zFlat && <p className="mx-muted" style={{ margin: 0 }}>Up-and-down height is 0, so this curve has no effect yet. Changing the curve gives it a small height so you can see it.</p>}
      <p className="mx-muted" style={{ margin: 0 }}>{CURVE_HINT[k]}</p>
      <CurveBox b={b} k={k} onEdit={curveEdit} />
      <div className="mx-two">
        <label className="mx-field">Least plastic (×)<input className="input" type="number" step={0.05} value={b.limits.min_flow_mult} onChange={(e) => plasticEdit((x) => { x.limits = { ...x.limits, min_flow_mult: +e.target.value }; })} /></label>
        <label className="mx-field">Most plastic (×)<input className="input" type="number" step={0.05} value={b.limits.max_flow_mult} onChange={(e) => plasticEdit((x) => { x.limits = { ...x.limits, max_flow_mult: +e.target.value }; })} /></label>
      </div>
      <label className="row" style={{ gap: 8, margin: 0 }}>
        <span style={{ flex: 1, fontSize: 12 }}>Random roughness</span>
        <button className={`toggle ${n?.enabled ? 'on' : ''}`} aria-label="Random roughness"
          onClick={() => onEdit((x) => { x.noise = x.noise ? { ...x.noise, enabled: !x.noise.enabled } : { enabled: true, type: 'value', seed: 1337, scale: 1, octaves: 3, persistence: 0.5 }; })} />
      </label>
      {n?.enabled && (
        <>
          <Slider label="Roughness size" unit="×" min={0.05} max={4} step={0.05} value={n.scale} onChange={(v) => onEdit((x) => { x.noise = { ...x.noise!, scale: v }; })} />
          <Slider label="Bumpiness" unit="" min={0.1} max={0.9} step={0.05} value={n.persistence} onChange={(v) => onEdit((x) => { x.noise = { ...x.noise!, persistence: v }; })} />
          <Slider label="Motion number" unit="" min={1} max={9999} step={1} value={n.seed} onChange={(v) => onEdit((x) => { x.noise = { ...x.noise!, seed: Math.round(v) }; })} />
        </>
      )}
      <div className="mx-label">{three ? 'Plastic changes and lift-offs' : 'Pauses, blobs and lift-offs'}</div>
      {b.events.map((e, i) => (three && e.type === 'dwell') ? null : (
        <div key={i} className="studio-event">
          <b>{{ dwell: 'Pause', flow_change: 'Plastic change', retract: 'Lift-off' }[e.type]}</b>
          <label className="mx-field">At %<input className="input" type="number" min={0} max={100} step={5} value={e.at.mode === 'percent' ? e.at.value : 0} onChange={(ev) => onEdit((x) => { x.events[i] = { ...x.events[i], at: { mode: 'percent', value: Math.min(100, Math.max(0, +ev.target.value)) } }; })} /></label>
          {e.type === 'dwell' && <>
            <label className="mx-field">ms<input className="input" type="number" min={0} step={50} value={e.params.ms ?? 0} onChange={(ev) => onEdit((x) => { x.events[i].params = { ...x.events[i].params, ms: Math.max(0, +ev.target.value) }; })} /></label>
            <label className="mx-field">Blob mm³<input className="input" type="number" min={0} step={0.5} value={e.params.blob_mm3 ?? 0} onChange={(ev) => onEdit((x) => { x.events[i].params = { ...x.events[i].params, blob_mm3: Math.max(0, +ev.target.value) }; })} /></label>
          </>}
          {e.type === 'flow_change' && <label className="mx-field">Plastic ×<input className="input" type="number" min={0} step={0.1} value={e.params.mult ?? 1} onChange={(ev) => plasticEdit((x) => { x.events[i].params = { ...x.events[i].params, mult: Math.max(0, +ev.target.value) }; })} /></label>}
          {e.type === 'retract' && <label className="mx-field">Jump mm<input className="input" type="number" min={0} step={0.5} value={e.params.travel_mm ?? 0} onChange={(ev) => onEdit((x) => { x.events[i].params = { ...x.events[i].params, travel_mm: Math.max(0, +ev.target.value) }; })} /></label>}
          <button className="icon-btn" title="Remove" onClick={() => onEdit((x) => { x.events.splice(i, 1); })}>✕</button>
        </div>
      ))}
      <div className="row" style={{ gap: 6, margin: 0 }}>
        {([['dwell', '+ Pause'], ['flow_change', '+ Plastic change'], ['retract', '+ Lift-off']] as [EventType, string][]).filter(([t]) => !three || t !== 'dwell').map(([t, l]) => (
          <button key={t} className="btn-secondary btn-small" onClick={() => { if (t === 'flow_change') setView('plastic'); onEdit((x) => { x.events = [...x.events, newEvent(t)]; }); }}>{l}</button>
        ))}
      </div>
    </Wrap>
  );
}

/** Switch what the model preview and the close-ups are coloured by. */
const VIEWS: [PreviewView, string, string][] = [
  ['motion', 'Motion', 'Each motion in its own colour; fainter where it fades out.'],
  ['height', 'Up / down', 'How far each spot is lifted (orange) or lowered (blue).'],
  ['plastic', 'Plastic', 'More plastic in orange, less in blue (after the plastic limits).'],
  ['speed', 'Speed', 'Faster in orange, slower in blue.'],
];
export function setView(v: PreviewView) {
  if (mx.previewView === v) return;
  mx.previewView = v;
  changed();
}
const css = (c: readonly number[]) => `rgb(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)})`;

function ViewPicker() {
  useMx();
  const [, bump] = useState(0);
  useEffect(() => { const on = () => bump((n) => n + 1); window.addEventListener('nx-preview-built', on); return () => window.removeEventListener('nx-preview-built', on); }, []);
  const v = mx.previewView;
  const lp = lastPreview && lastPreview.view === v ? lastPreview : null;
  const unit = v === 'height' ? ' mm' : '×';
  const fmt = (x: number) => (v === 'height' ? x.toFixed(2) : x.toFixed(2));
  return (
    <section className="mx-card">
      <div className="mx-card-title">Show on the model</div>
      <div className="seg mx-seg">
        {VIEWS.map(([id, label, hint]) => <button key={id} className={v === id ? 'on' : ''} title={hint} onClick={() => setView(id)}>{label}</button>)}
      </div>
      <div className="studio-legend">
        {v === 'motion'
          ? <span>{VIEWS[0][2]}</span>
          : <><i className="lg" style={{ background: css(VIEW_COLORS.low) }} />{lp ? `${fmt(lp.range[0])}${unit}` : 'low'}
            <i className="lg" style={{ background: css(VIEW_COLORS.mid) }} />{v === 'height' ? '0 mm' : '1×'}
            <i className="lg" style={{ background: css(VIEW_COLORS.high) }} />{lp ? `${fmt(lp.range[1])}${unit}` : 'high'}</>}
        <span className="spacer" />
        <i className="lg" style={{ background: css(VIEW_COLORS.pause) }} />pause / blob
        <i className="lg" style={{ background: css(VIEW_COLORS.lift) }} />lift-off
        <i className="lg" style={{ background: css(VIEW_COLORS.jump) }} />jump
      </div>
    </section>
  );
}

/** A straight piece of wall run through the same code the slicer uses, for the close-ups. */
function closeUpPath(b: MotionBrush, p: PrintProfiles, layer: number, L: number, step: number): ToolpathPoint[] {
  const pts: ToolpathPoint[] = [{ x: 0, y: 0, z: 1, f: 50, flow: 1, e: 0 }, { x: L, y: 0, z: 1, f: 50, flow: 1, e: 0 }];
  const tp: Toolpath = { feature: 'outer_wall', closed: false, points: pts };
  // tile at the brush's own repeat, as on a long wall
  const brush: MotionBrush = b.repeat_mode === 'stretch' ? { ...b, repeat_mode: 'tile' } : b;
  // the wall runs along +x, so its outward side is −y: flip so "sticks out" is up in the drawing
  return composePath(tp, [{ brush, weight: () => 1, blend: 'add' }], p, { resampleStep: step, loopSpeedShare: 1 }, () => {}, layer)
    .points.map((q) => ({ ...q, y: -q.y }));
}
const valueOf = (q: ToolpathPoint, v: PreviewView) => (v === 'height' ? q.zOff ?? 0 : v === 'plastic' ? q.flow : v === 'speed' ? q.f / 50 : q.y);
const rampCss = (t: number) => {
  const u = Math.max(-1, Math.min(1, t)), m = VIEW_COLORS.mid, e = u < 0 ? VIEW_COLORS.low : VIEW_COLORS.high, a = Math.abs(u);
  return [0, 1, 2].map((i) => m[i] + (e[i] - m[i]) * a);
};

/** Close-ups of a short piece of wall: from above with the layers below and above, and from the side. */
function CloseUps({ b, profiles, layer, setLayer }: { b: MotionBrush; profiles: PrintProfiles; layer: number; setLayer: (n: number) => void }) {
  useMx();
  const top = useRef<HTMLCanvasElement>(null);
  const side = useRef<HTMLCanvasElement>(null);
  const theme = useStore((s) => s.theme);
  const view = mx.previewView;
  const lineWidth = profiles.process.lineWidth, layerHeight = profiles.process.layerHeight || 0.2;
  useEffect(() => {
    const draw = () => {
      if (top.current) drawTop(top.current, b, profiles, layer, theme === 'dark', view);
      if (side.current) drawSide(side.current, b, profiles, layer, theme === 'dark', view);
    };
    draw();
    const ro = new ResizeObserver(draw);
    if (top.current) ro.observe(top.current);
    return () => ro.disconnect();
  });
  const off = layerPhase(b, layer) === null;
  const sideLegend = view === 'height' ? ['lifted', 'lowered'] : view === 'plastic' ? ['more plastic', 'less plastic'] : view === 'speed' ? ['faster', 'slower'] : ['sticks out', 'pressed in'];
  return (
    <section className="mx-card studio-closeups">
      <div className="mx-card-title">Close-up<span className="spacer" />
        <span className="mx-muted" style={{ margin: 0, fontWeight: 400 }}>layer</span>
        <input className="input studio-num" type="number" min={1} step={1} value={layer} onChange={(e) => setLayer(Math.max(1, Math.round(+e.target.value)))} aria-label="Close-up layer" />
      </div>
      <canvas ref={top} className="studio-canvas" style={{ height: 150 }} />
      <div className="studio-legend"><i className="lg cur" />layer {layer}{off ? ' (plain)' : ''} · line thickness = plastic<i className="lg below" />layer below<i className="lg above" />layer above<span className="spacer" />seen from above</div>
      <canvas ref={side} className="studio-canvas" style={{ height: 110 }} />
      <div className="ms-scrub"><input type="range" min={1} max={300} step={1} value={layer} onChange={(e) => setLayer(+e.target.value)} aria-label="Layer" /><span className="mono">Layer {layer}</span></div>
      <div className="studio-legend"><i className="lg out" />{sideLegend[0]}<i className="lg in" />{sideLegend[1]}<span className="spacer" />{(layerHeight * 36).toFixed(1)} mm of wall seen from the side · {lineWidth.toFixed(2)} mm line</div>
    </section>
  );
}

const SPAN = (b: MotionBrush) => Math.max(10, Math.min(60, b.period_mm * 3));

function drawTop(cv: HTMLCanvasElement, b: MotionBrush, p: PrintProfiles, layer: number, dark: boolean, view: PreviewView) {
  const dpr = devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
  if (!W || !H) return;
  cv.width = W * dpr; cv.height = H * dpr;
  const g = cv.getContext('2d')!; g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
  const lineWidth = p.process.lineWidth;
  const L = SPAN(b), A = Math.max(0.3, b.amplitude * 1.25 + lineWidth);
  const sx = (W - 24) / L, sy = Math.min(sx * 2, (H - 26) / (2 * A));
  const X = (x: number) => 12 + x * sx, Y = (y: number) => H / 2 - 4 - y * sy;
  g.strokeStyle = dark ? '#4a5260' : '#cfd5dd'; g.lineWidth = 1; g.setLineDash([4, 4]);
  g.beginPath(); g.moveTo(X(0), Y(0)); g.lineTo(X(L), Y(0)); g.stroke(); g.setLineDash([]);
  const step = Math.max(0.05, L / 400);
  const plain = (n: number, style: string, width: number, dash: number[] = []) => {
    if (n < 0) return;
    const pts = closeUpPath(b, p, n, L, step);
    g.strokeStyle = style; g.lineWidth = width; g.setLineDash(dash); g.lineCap = 'round'; g.lineJoin = 'round';
    g.beginPath();
    pts.forEach((q, i) => { if (i === 0 || q.travel) g.moveTo(X(q.x), Y(q.y)); else g.lineTo(X(q.x), Y(q.y)); });
    g.stroke(); g.setLineDash([]);
  };
  plain(layer - 1, dark ? 'rgba(170,180,195,.55)' : 'rgba(110,120,135,.45)', Math.max(1.5, lineWidth * sx * 0.9));
  // this layer: thickness follows the plastic, colour follows the chosen view, events marked
  const pts = closeUpPath(b, p, layer, L, step);
  const vals = pts.map((q) => valueOf(q, view));
  const centre = view === 'height' || view === 'motion' ? 0 : 1;
  const span = Math.max(0.05, ...vals.map((v) => Math.abs(v - centre)));
  g.lineCap = 'round';
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], q = pts[i];
    if (q.travel) {
      g.strokeStyle = css(VIEW_COLORS.jump); g.lineWidth = 1.5; g.setLineDash([3, 3]);
      g.beginPath(); g.moveTo(X(a.x), Y(a.y)); g.lineTo(X(q.x), Y(q.y)); g.stroke(); g.setLineDash([]);
      continue;
    }
    g.strokeStyle = view === 'motion' ? 'rgba(255,122,69,.85)' : css(rampCss((vals[i] - centre) / span));
    g.lineWidth = Math.max(1, lineWidth * sx * Math.max(0.1, q.flow));
    g.beginPath(); g.moveTo(X(a.x), Y(a.y)); g.lineTo(X(q.x), Y(q.y)); g.stroke();
  }
  for (const q of pts) {
    if (!q.post) continue;
    const c = q.post.retract_mm ? VIEW_COLORS.lift : VIEW_COLORS.pause;
    if (q.post.retract_mm || q.post.dwell_ms || q.post.blob_mm) {
      g.fillStyle = css(c); g.beginPath(); g.arc(X(q.x), Y(q.y), q.post.blob_mm ? 6 : 4, 0, Math.PI * 2); g.fill();
    }
  }
  plain(layer + 1, dark ? '#69c0ff' : '#1f6fd1', 1.5, [5, 4]);
  g.fillStyle = dark ? '#9aa3b0' : '#6b7380'; g.font = '11px Inter, system-ui, sans-serif';
  const bar = Math.min(10, Math.max(1, Math.round(L / 4)));
  g.fillText(`${bar} mm`, X(L - bar), H - 4);
  g.strokeStyle = g.fillStyle; g.lineWidth = 1; g.beginPath(); g.moveTo(X(L - bar), H - 14); g.lineTo(X(L), H - 14); g.stroke();
}

function drawSide(cv: HTMLCanvasElement, b: MotionBrush, p: PrintProfiles, layer: number, dark: boolean, view: PreviewView) {
  const W = Math.max(1, Math.floor(cv.clientWidth)), H = Math.max(1, Math.floor(cv.clientHeight));
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d')!, img = g.createImageData(W, H), L = SPAN(b), rows = 36;
  const first = Math.max(0, layer - rows / 2);
  const bg = dark ? [42, 46, 54] : [246, 245, 242];
  const step = Math.max(0.05, L / W);
  // one row per layer: the value of the chosen view along the wall, from the slicer's own code
  const data = Array.from({ length: rows }, (_, r) => {
    const n = first + rows - 1 - r;
    const pts = closeUpPath(b, p, n, L, step);
    const col = new Float64Array(W).fill(NaN);
    for (const q of pts) { const x = Math.min(W - 1, Math.max(0, Math.round((q.x / L) * (W - 1)))); if (!q.travel) col[x] = valueOf(q, view); }
    return { n, col };
  });
  const centre = view === 'plastic' || view === 'speed' ? 1 : 0;
  let span = view === 'motion' ? Math.max(0.05, b.amplitude * 1.2) : 0.05;
  if (view !== 'motion') for (const { col } of data) for (const v of col) if (Number.isFinite(v)) span = Math.max(span, Math.abs(v - centre));
  for (let r = 0; r < rows; r++) {
    const { n, col } = data[r], y0 = Math.floor((r * H) / rows), y1 = Math.floor(((r + 1) * H) / rows);
    let last = centre;
    for (let x = 0; x < W; x++) {
      const v = Number.isFinite(col[x]) ? (last = col[x]) : last;
      const t = Math.max(-1, Math.min(1, (v - centre) / span));
      const c = t >= 0 ? [bg[0] + (255 - bg[0]) * t, bg[1] + (122 - bg[1]) * t, bg[2] + (69 - bg[2]) * t] : [bg[0] + (54 - bg[0]) * -t, bg[1] + (130 - bg[1]) * -t, bg[2] + (230 - bg[2]) * -t];
      const edge = n === layer;
      for (let y = y0; y < y1; y++) {
        const i = (y * W + x) * 4;
        const line = edge && (y === y0 || y === y1 - 1);
        img.data[i] = line ? 20 : c[0]; img.data[i + 1] = line ? 20 : c[1]; img.data[i + 2] = line ? 20 : c[2]; img.data[i + 3] = 255;
      }
    }
  }
  g.putImageData(img, 0, 0);
}

// ===================================================================================================
// Three-pane Motion Studio: library rail · dual-plane stage with a repeat timeline · inspector.
// Axis colours: cyan = offset in/out of the wall, magenta = Z lift, amber = stops and blobs.
// ===================================================================================================
export const AX = { lat: '#13b5c8', z: '#d63fb5', stop: '#f2a516' } as const;

// ----- undo / redo per placement (snapshots of its own motion copy; quick drags count as one step)
type Hist = { past: string[]; future: string[]; cur: string; t: number };
const hist = new WeakMap<MotionApplication, Hist>();
const snapOf = (a: MotionApplication) => JSON.stringify(a.brush ?? null);
function histOf(a: MotionApplication): Hist {
  let x = hist.get(a);
  if (!x) { x = { past: [], future: [], cur: snapOf(a), t: 0 }; hist.set(a, x); }
  return x;
}
function remember(a: MotionApplication) {
  const x = histOf(a), now = Date.now();
  if (now - x.t > 500) { x.past.push(x.cur); if (x.past.length > 100) x.past.shift(); x.future = []; }
  x.t = now;
}
function settle(a: MotionApplication) { histOf(a).cur = snapOf(a); }
function restore(a: MotionApplication, s: string) { a.brush = s === 'null' ? undefined : JSON.parse(s); const x = histOf(a); x.cur = s; x.t = 0; changed(); }
export function undoMotion() { const a = activeApp(); if (!a) return; const x = histOf(a); const s = x.past.pop(); if (s === undefined) return; x.future.push(snapOf(a)); restore(a, s); }
export function redoMotion() { const a = activeApp(); if (!a) return; const x = histOf(a); const s = x.future.pop(); if (s === undefined) return; x.past.push(snapOf(a)); restore(a, s); }

// ----- studio view state: snapping, the timeline cursor, the selected stop
const SNAP_KEY = 'nexspiro.motionex.snap';
const ui = { snap: (() => { try { return localStorage.getItem(SNAP_KEY) !== '0'; } catch { return true; } })(), cursor: 0.25, stop: -1 };
let uiVer = 0;
const uiL = new Set<() => void>();
function setStudio(p: Partial<typeof ui>) {
  Object.assign(ui, p); uiVer++;
  if ('snap' in p) { try { localStorage.setItem(SNAP_KEY, ui.snap ? '1' : '0'); } catch { /* storage off */ } }
  uiL.forEach((l) => l());
}
function useStudio() { useSyncExternalStore((l) => { uiL.add(l); return () => { uiL.delete(l); }; }, () => uiVer); return ui; }

type Edit = (fn: (b: MotionBrush) => void) => void;

/** Mini picture of a curve for the shape tiles. */
function CurveTile({ curve, on, label, onPick }: { curve: MotionBrush['curves']['lateral_offset']; on: boolean; label: string; onPick: () => void }) {
  const d = useMemo(() => Array.from({ length: 49 }, (_, i) => { const t = (i / 48) * 2; return `${i ? 'L' : 'M'}${(2 + (i / 48) * 36).toFixed(1)},${(11 - evalCurve(curve, t % 1) * 8).toFixed(1)}`; }).join(''), [curve]);
  return <button className={`st-tile ${on ? 'on' : ''}`} onClick={onPick} title={label}><svg width="40" height="22" aria-hidden><path d={d} fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" /></svg>{label}</button>;
}
const sameCurve = (a: MotionBrush['curves']['lateral_offset'], b: MotionBrush['curves']['lateral_offset']) => a.interpolation === b.interpolation && a.points.length === b.points.length && a.points.every((p, i) => Math.abs(p.t - b.points[i].t) < 1e-6 && Math.abs(p.v - b.points[i].v) < 1e-6);
const SHAPE_CURVES = SHAPES.map((s) => ({ ...s, curve: s.make() }));

type Stage = 'model' | 'closeup';
type Plane = 'offset' | 'lift';

/** Motion Studio on the shared Studio shell: settings cards, the motion live on the model, the wave editor below. */
function StudioShell({ a, draft, edit, profiles, layer, setLayer, saveToLibrary }: { a: MotionApplication; draft: MotionBrush; edit: Edit; profiles: PrintProfiles; layer: number; setLayer: (n: number) => void; saveToLibrary: () => void }) {
  histOf(a); // start the history before the first in-place curve drag
  useStudio();
  const apps = mx.applications;
  const base = mx.library.get(a.brush_id);
  const lh = profiles.process.layerHeight || 0.2;
  const [stage, setStage] = useState<Stage>('model');
  const [plane, setPlane] = useState<Plane>('offset');
  const [lib, setLib] = useState(false);
  const [spin, setSpin] = useState(false);
  const [built, setBuilt] = useState<{ ms: number; n: number } | null>(null);
  const ctl = useRef<LinePreviewControls | null>(null);
  const x = histOf(a);
  const pick = (id: string) => { if (id === a.brush_id) return; if (a.brush && !askOk('Switching motion drops your changes to this one. Switch anyway?')) return; a.brush_id = id; a.brush = undefined; hist.delete(a); changed(); };
  const zEdit: Edit = (fn) => edit((b) => { fn(b); if (!(b.z_amplitude && b.z_amplitude > 0)) b.z_amplitude = Math.min(0.3, lh * 1.5); });
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.stopImmediatePropagation(); (e.shiftKey ? redoMotion : undoMotion)(); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); e.stopImmediatePropagation(); redoMotion(); }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, []);
  const lead = r3((((draft.layers?.shift_deg ?? 0) / 360) * draft.period_mm));
  const drool = lastPreview?.drool;
  const onPlate = a.target.type === 'body';
  const stack = stackId(draft);

  const side = (
    <>
      <SideCard title="Motion" id="mx-motion">
        {apps.length > 1 && (
          <Row label="Editing">
            <select className="st-sel" style={{ flex: 1, minWidth: 0 }} value={apps.indexOf(a)} aria-label="Placement" onChange={(e) => activate(+e.target.value)}>
              {apps.map((p, i) => <option key={i} value={i}>{i + 1}. {brushOf(p)?.name ?? p.brush_id}</option>)}
            </select>
          </Row>
        )}
        <Row label="Motion">
          <button className="st-btn" style={{ flex: 1, minWidth: 0, justifyContent: 'flex-start' }} onClick={() => setLib(true)} title="Pick a motion from the library">
            <i className="mx-dot" style={{ background: SURFACE_COLORS[surfaceOf(a) - 1] }} /><span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{base?.name ?? a.brush_id}</span>
          </button>
        </Row>
        <Row label="Applies to"><Seg label="Applies to" value={onPlate ? 'plate' : 'faces'} options={[['plate', 'Whole plate', 'Every object on the plate'], ['faces', 'Picked faces', 'Faces you pick on the model (Click, Paint, Lasso… in the Motionex bar)']]} onChange={(v) => { if (v === 'plate') a.target = { ...a.target, type: 'body' }; else toFaces(a); changed(); }} /></Row>
        {!onPlate && <div className="st-hint">{motionCounts(useStore.getState().objects, surfaceOf(a)).tris ? 'On the faces you picked.' : 'No faces picked yet: press Done and pick them with Click, Paint or Lasso in the Motionex bar.'}</div>}
        <div className="st-btns">
          <button className="st-btn" disabled={!a.brush} onClick={() => { if (askOk('Go back to the library motion?')) { remember(a); a.brush = undefined; settle(a); changed(); } }}>Reset</button>
          <button className="st-btn" onClick={() => setLib(true)}>Library</button>
        </div>
        <div className={`st-status ${a.brush ? '' : 'ok'}`}><b>●</b> {a.brush ? 'Edited · on this placement only' : 'As in the library'}</div>
      </SideCard>
      <SideCard title="Shape" id="mx-shape">
        <div className="st-tiles" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
          {SHAPE_CURVES.map((s) => <CurveTile key={s.id} label={s.label} curve={s.curve} on={sameCurve(draft.curves.lateral_offset, s.curve)} onPick={() => edit((b) => { b.curves.lateral_offset = s.make(); })} />)}
        </div>
      </SideCard>
      <SideCard title="Size" id="mx-size">
        <Row label="Depth" title="How far the line swings in and out of the wall"><Num label="Depth (mm)" value={r3(draft.amplitude)} step={0.05} digits={2} min={0} max={10} modified={!!base && Math.abs(base.amplitude - draft.amplitude) > 1e-6} onChange={(v) => edit((b) => { b.amplitude = v; })} /><span className="st-unit">mm in / out</span></Row>
        <Row label="Lift" title="How far the line rises and drops within the layer"><Num label="Lift (mm)" value={r3(draft.z_amplitude ?? 0)} step={0.05} digits={2} min={0} max={3} modified={!!base && Math.abs((base.z_amplitude ?? 0) - (draft.z_amplitude ?? 0)) > 1e-6} onChange={(v) => edit((b) => { b.z_amplitude = v; })} /><span className="st-unit">mm up / down</span></Row>
        <Row label="Spacing" title="Length of one repeat along the wall"><Num label="Repeat spacing (mm)" value={r3(draft.period_mm)} step={0.1} digits={2} min={0.4} max={200} modified={!!base && Math.abs(base.period_mm - draft.period_mm) > 1e-6} onChange={(v) => edit((b) => { b.period_mm = v; })} /><span className="st-unit">mm a repeat</span></Row>
        <Row label="Speed" title="Print speed of the motion, times normal"><Num label="Speed (×)" value={speedOf(draft)} step={0.05} digits={2} min={0.2} max={2} onChange={(v) => edit((b) => scaleSpeed(b, v))} /><span className="st-unit">× normal</span></Row>
        <Row label="Fit" title="Whole repeats round each loop: no seam where a loop closes"><Seg label="Fit" value={draft.repeat_mode === 'stretch' ? 'stretch' : 'tile'} options={[['tile', 'Exact spacing'], ['stretch', 'Whole repeats']]} onChange={(v) => edit((b) => { b.repeat_mode = v; })} /></Row>
      </SideCard>
      <SideCard title="Layers" id="mx-layers">
        <div className="st-tiles" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
          {STACKS.map((s) => <button key={s.id} className={`st-tile ${stack === s.id ? 'on' : ''}`} title={s.hint} onClick={() => edit((b) => { b.layers = s.make(b); })} style={{ padding: '6px 2px' }}>{s.label}</button>)}
        </div>
        <Row label="Each layer" title="How far each layer's motion sits ahead of the layer below"><Num label="Lead per layer (mm)" value={lead} step={0.05} digits={2} min={-draft.period_mm / 2} max={draft.period_mm / 2} onChange={(v) => edit((b) => { b.layers = { mode: 'steady', every: 1, band_on: 0, band_off: 0, ...b.layers, shift_deg: r3((v / b.period_mm) * 360) }; })} /><span className="st-unit">mm {lead >= 0 ? 'lead' : 'lag'}</span></Row>
        <div className="st-hint">{STACKS.find((s) => s.id === stack)?.hint ?? 'Your own stacking (see Advanced).'}</div>
      </SideCard>
      <SideCard title="Stops & ooze" id="mx-stops" defaultOpen={false} right={draft.events.some((e) => e.type === 'dwell') ? <span className="st-badge">{draft.events.filter((e) => e.type === 'dwell').length}</span> : undefined}>
        <StopsCard b={draft} onEdit={edit} />
      </SideCard>
      <SideCard title="Advanced" id="mx-adv" defaultOpen={false}>
        <LeadLag b={draft} layerHeight={lh} onEdit={edit} />
        <section className="mx-card">
          <div className="mx-card-title">Phase</div>
          <Slider label="Start shift" unit="mm" min={0} max={draft.period_mm} step={0.05} value={r3((draft.phase_deg / 360) * draft.period_mm)} onChange={(v) => edit((b) => { b.phase_deg = r3((v / b.period_mm) * 360) % 360; })} />
        </section>
        <Advanced b={draft} onEdit={edit} profiles={profiles} three />
      </SideCard>
      <SideCard title="Print check" id="mx-check" defaultOpen={false} right={<span className={`st-badge ${drool && drool.level !== 'ok' ? 'warn' : ''}`}>{!drool ? '—' : drool.level === 'ok' ? 'All good' : 'Look at this'}</span>}>
        <div className="st-hint">{drool ? `Worst unsupported reach ${drool.worstMm.toFixed(2)} mm (safe up to ${drool.safeMm.toFixed(2)} mm)${drool.sagging ? ` · ${drool.sagging} sagging` : ''}${drool.dripping ? ` · ${drool.dripping} dripping` : ''}.` : 'Shows once the motion is on the model.'}</div>
      </SideCard>
    </>
  );

  const rail = (
    <>
      <small>Shape</small>
      {SHAPE_CURVES.slice(0, 4).map((s) => <button key={s.id} className={`st-ib ${sameCurve(draft.curves.lateral_offset, s.curve) ? 'on' : ''}`} title={s.label} aria-label={s.label} onClick={() => edit((b) => { b.curves.lateral_offset = s.make(); })}><Icon name="smooth" /></button>)}
      <small>Undo</small>
      <IconButton icon="undo" title="Undo (Ctrl+Z)" disabled={!x.past.length} onClick={undoMotion} />
    </>
  );

  const stageEl = (
    <>
      <Tabs value={stage} options={[['model', 'Model'], ['closeup', 'Close-up']]} onChange={setStage} />
      {stage === 'model'
        ? <LinePreview3D build={motionexPreview} controls={ctl} onBuilt={(ms, n) => setBuilt({ ms, n })} />
        : <div style={{ position: 'absolute', inset: '52px 14px 14px', overflowY: 'auto', display: 'flex', flexDirection: 'column' }}><CloseUps b={draft} profiles={profiles} layer={layer} setLayer={setLayer} /></div>}
      {stage === 'model' && (
        <>
          <div className="st-stats">
            <Stat label="Depth × spacing" value={`${draft.amplitude.toFixed(2)} × ${draft.period_mm.toFixed(1)} mm`} />
            <Stat label="Layer lead" value={lead ? `${lead > 0 ? '+' : ''}${lead.toFixed(2)} mm` : 'lined up'} />
            <Stat label="Drool check" value={!drool ? '—' : drool.level === 'ok' ? 'OK' : drool.level} tone={!drool ? undefined : drool.level === 'ok' ? 'ok' : 'warn'} />
          </div>
          <LiveBadge text={built ? `Live · walls redrawn in ${Math.round(built.ms)} ms as you edit` : 'Live'} />
          <div className="st-toolbar br">
            <span className="st-ttl">Preview</span>
            <ToolGroup label="Zoom"><IconButton icon="fit" title="Fit the plate" onClick={() => ctl.current?.fit()} /></ToolGroup>
            <ToolGroup label="Rotate">
              <IconButton icon="undo" title="Turn left 45°" onClick={() => ctl.current?.rotate(-45)} />
              <IconButton icon="redo" title="Turn right 45°" onClick={() => ctl.current?.rotate(45)} />
              <IconButton icon="rot" title="Spin slowly" on={spin} onClick={() => { ctl.current?.setSpin(!spin); setSpin(!spin); }} />
            </ToolGroup>
            <ToolGroup label="Colour by"><Seg label="Colour by" value={mx.previewView} options={VIEWS.map(([v, l, h]) => [v, l, h])} onChange={setView} /></ToolGroup>
          </div>
        </>
      )}
    </>
  );

  const editor = (
    <>
      <div className="st-editor-head">
        <span className="st-ttl">Wave</span>
        <ToolGroup label="Edit">
          <IconButton icon="undo" title="Undo (Ctrl+Z)" disabled={!x.past.length} onClick={undoMotion} />
          <IconButton icon="redo" title="Redo (Ctrl+Y)" disabled={!x.future.length} onClick={redoMotion} />
          <button className={`st-ib ${ui.snap ? 'on' : ''}`} style={{ width: 'auto', padding: '0 7px', fontSize: 11 }} aria-pressed={ui.snap} title="Snap points and stops to 24 steps per repeat" onClick={() => setStudio({ snap: !ui.snap })}># Snap</button>
        </ToolGroup>
        <VSep />
        <ToolGroup label="Curve"><Seg label="Curve" value={plane} options={[['offset', 'In / out', 'Top view: offset from the wall'], ['lift', 'Up / down', 'Side view: Z lift within the layer']]} onChange={setPlane} /></ToolGroup>
        <VSep />
        <ToolGroup label="Next layer"><Seg label="Next layer" value={(['aligned', 'twist', 'bricks', 'wavy'] as const).find((s) => s === stack) ?? 'aligned'} options={[['aligned', 'Same'], ['twist', 'Lead'], ['bricks', 'Bricks'], ['wavy', 'Wavy']]} onChange={(v) => edit((b) => { b.layers = STACKS.find((s) => s.id === v)!.make(b); })} /></ToolGroup>
        <span style={{ flex: 1 }} />
        <button className="st-btn" onClick={saveToLibrary} title="Keep this motion in My motions">Save to library</button>
      </div>
      <div className="st-editor-body" style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 8 }}>
        {plane === 'offset' && <PlaneEditor b={draft} k="lateral_offset" color={AX.lat} title="Top view · offset from the wall" sub={`±${draft.amplitude.toFixed(2)} mm · drag dots, double-click adds, Delete removes`} onEdit={edit} />}
        {plane === 'lift' && <PlaneEditor b={draft} k="z_offset" color={AX.z} title="Side view · Z lift" sub={(draft.z_amplitude ?? 0) > 0 ? `±${(draft.z_amplitude ?? 0).toFixed(2)} mm` : 'flat · drag a dot to lift'} onEdit={zEdit} />}
        <Timeline b={draft} onEdit={edit} />
      </div>
    </>
  );

  return (
    <StudioWindow name="Motionex" letter="M" gradient="linear-gradient(135deg,#2563EB,#7C3AED)" onClose={() => openMotionStudio(false)}
      version="Motion" side={side} rail={rail} stage={stageEl} editor={editor} editorHeight={320}
      links={[{ label: 'Shortcuts', onClick: () => useStore.getState().set({ toast: { kind: 'info', text: 'Drag curve dots · double-click adds · Delete removes · Ctrl+Z / Ctrl+Y · Esc closes' } }) }]}
      overlay={lib ? (
        <div className="st-lib" role="dialog" aria-label="Motion library" style={{ maxHeight: 'calc(100% - 20px)', height: 'min(560px, calc(100% - 20px))' }}>
          <div className="st-lib-head"><b style={{ fontSize: 13 }}>Motion library</b><span className="st-hint" style={{ margin: 0 }}>click a motion to use it here</span><span style={{ flex: 1 }} /><IconButton icon="close" title="Close" onClick={() => setLib(false)} /></div>
          <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 10 }} className="ms-pane"><LibraryRail current={a.brush_id} onPick={(id) => { pick(id); setLib(false); }} onSave={saveToLibrary} /></div>
        </div>
      ) : null} />
  );
}

const speedOf = (b: MotionBrush) => { const P = b.curves.speed_mult.points; return r3(P.reduce((s, p) => s + p.v, 0) / Math.max(1, P.length)); };
function scaleSpeed(b: MotionBrush, v: number) {
  const k = v / Math.max(0.01, speedOf(b));
  b.curves.speed_mult = { ...b.curves.speed_mult, points: b.curves.speed_mult.points.map((p) => ({ ...p, v: r3(p.v * k), in_handle: [p.in_handle[0], p.in_handle[1] * k], out_handle: [p.out_handle[0], p.out_handle[1] * k] })) };
}

function Stacking({ b, onEdit }: { b: MotionBrush; onEdit: Edit }) {
  return (
    <section className="mx-card">
      <div className="mx-card-title">Layer stacking</div>
      <div className="studio-shapes">
        {STACKS.map((st) => <button key={st.id} className={`mx-tool ${stackId(b) === st.id ? 'on' : ''}`} title={st.hint} onClick={() => onEdit((x) => { x.layers = st.make(x); })}>{st.label}</button>)}
      </div>
      <p className="mx-muted" style={{ margin: 0 }}>{STACKS.find((s) => s.id === stackId(b))?.hint ?? 'Your own stacking.'}</p>
      {b.layers && (
        <>
          <div className="mx-label">Step to step</div>
          <div className="seg mx-seg">
            {MODES.map(([m, l, hint]) => <button key={m} title={hint} className={b.layers!.mode === m ? 'on' : ''} onClick={() => onEdit((x) => { x.layers = { ...x.layers!, mode: m }; })}>{l}</button>)}
          </div>
          {b.layers.mode !== 'alternate' && (
            <label className="row" style={{ gap: 8, margin: 0 }}>
              <span style={{ flex: 1, fontSize: 12 }}>Slant both ways (diamonds)</span>
              <button className={`toggle ${b.layers.cross ? 'on' : ''}`} aria-label="Slant both ways" onClick={() => onEdit((x) => { x.layers = { ...x.layers!, cross: !x.layers!.cross }; })} />
            </label>
          )}
        </>
      )}
      <div className="mx-two">
        <label className="mx-field">Motion on for (layers)
          <input className="input" type="number" min={0} step={1} value={b.layers?.band_on ?? 0} title="0 = on all the time"
            onChange={(e) => onEdit((x) => { x.layers = { shift_deg: 0, mode: 'steady', every: 1, band_off: 0, ...x.layers, band_on: Math.max(0, Math.round(+e.target.value)) }; })} />
        </label>
        <label className="mx-field">then plain for
          <input className="input" type="number" min={0} step={1} value={b.layers?.band_off ?? 0} disabled={!b.layers?.band_on}
            onChange={(e) => onEdit((x) => { x.layers = { ...x.layers!, band_off: Math.max(0, Math.round(+e.target.value)) }; })} />
        </label>
      </div>
    </section>
  );
}

// ----- library rail: search, favourites, collapsed categories with traced thumbnails
const FAV_KEY = 'nexspiro.motionex.favourites';
function loadFavs(): Set<string> { try { return new Set(JSON.parse(localStorage.getItem(FAV_KEY) || '[]')); } catch { return new Set(); } }
const FAV_GROUP = '★ Favourites', MINE = 'My motions';

function LibraryRail({ current, onPick, onSave }: { current: string; onPick: (id: string) => void; onSave: () => void }) {
  useMx();
  const [q, setQ] = useState('');
  const [favs, setFavs] = useState(loadFavs);
  const toggleFav = (id: string) => {
    const n = new Set(favs); if (n.has(id)) n.delete(id); else n.add(id);
    setFavs(n); try { localStorage.setItem(FAV_KEY, JSON.stringify([...n])); } catch { /* storage off */ }
  };
  const all = mx.library.all();
  const groups = new Map<string, MotionBrush[]>();
  const put = (g: string, b: MotionBrush) => groups.set(g, [...(groups.get(g) ?? []), b]);
  const needle = q.trim().toLowerCase();
  for (const b of all) if (favs.has(b.id) && !needle) put(FAV_GROUP, b);
  for (const b of all) {
    if (needle && !`${b.name} ${b.description ?? ''} ${b.category ?? ''} ${(b.tags ?? []).join(' ')}`.toLowerCase().includes(needle)) continue;
    put(mx.library.isPreset(b.id) ? b.category ?? 'Other' : MINE, b);
  }
  const ordered = [...groups].sort(([x], [y]) => (x === FAV_GROUP ? -2 : x === MINE ? -1 : 0) - (y === FAV_GROUP ? -2 : y === MINE ? -1 : 0));
  const curGroup = (() => { const b = mx.library.get(current); return b ? (mx.library.isPreset(b.id) ? b.category ?? 'Other' : MINE) : ''; })();
  return (
    <div className="ms-rail">
      <input className="input ms-search" type="search" placeholder="Search motions, tags…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search motions" />
      <div className="ms-cats" role="listbox" aria-label="Motions">
        {ordered.map(([g, bs]) => (
          <details key={g + (needle ? '?' : '')} className="ms-cat" open={!!needle || g === curGroup || g === FAV_GROUP}>
            <summary><span>{g}</span><span className="ms-count">{bs.length}</span></summary>
            <div className="ms-cards">
              {bs.map((b) => {
                const preset = mx.library.isPreset(b.id);
                return (
                  <div key={b.id} className={`ms-card ${b.id === current ? 'on' : ''}`} role="option" aria-selected={b.id === current}>
                    <button className="ms-card-main" title={b.description ?? b.name} onClick={() => onPick(b.id)}>
                      <Wave b={b} /><span>{b.name}</span>
                    </button>
                    <button className={`ms-fav ${favs.has(b.id) ? 'on' : ''}`} aria-label={favs.has(b.id) ? 'Remove from favourites' : 'Add to favourites'} title="Favourite" onClick={() => toggleFav(b.id)}>{favs.has(b.id) ? '★' : '☆'}</button>
                    {!preset && <button className="ms-del" aria-label={`Delete ${b.name}`} title="Delete from My motions" onClick={() => { if (askOk(`Delete “${b.name}” from My motions?`)) { mx.library.remove(b.id); changed(); } }}>✕</button>}
                  </div>
                );
              })}
            </div>
          </details>
        ))}
        {!ordered.length && <p className="mx-muted">No motion matches “{q}”.</p>}
      </div>
      <button className="btn-primary btn-small ms-save" onClick={onSave} title="Saved motions stay in My motions next time NexSpiro opens">+ Save current as preset</button>
    </div>
  );
}

// ----- one plane of the dual view: a curve editor with the shared cursor and the stops drawn on it
function PlaneEditor({ b, k, color, title, sub, onEdit }: { b: MotionBrush; k: CurveKey; color: string; title: string; sub: string; onEdit: Edit }) {
  useStudio();
  const host = useRef<HTMLDivElement>(null);
  const ed = useRef<CurveEditor | null>(null);
  const editRef = useRef(onEdit); editRef.current = onEdit;
  const bRef = useRef(b); bRef.current = b;
  const info = CURVE_INFO[k];
  useEffect(() => {
    if (!host.current) return;
    const e = new CurveEditor(b.curves[k], {
      min: info.min, max: info.max, disabled: false, color, snap: () => ui.snap,
      onChange: () => editRef.current(() => {}), onSelect: () => {},
      overlay: (g, X, Y, _w, h) => drawPlaneOverlay(g, X, Y, h, bRef.current, k),
    });
    e.canvas.style.width = '100%'; e.canvas.style.height = '100%';
    host.current.replaceChildren(e.canvas); ed.current = e;
    requestAnimationFrame(() => e.draw());
  }, [b, b.curves[k], k]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { ed.current?.draw(); });
  return (
    <section className="ms-plane" style={{ ['--ax' as string]: color }}>
      <div className="ms-plane-h">
        <i className="ms-axdot" /><b>{title}</b><span className="mx-muted">{sub}</span><span className="spacer" />
        <select className="select ms-interp" value={b.curves[k].interpolation} aria-label="Curve type" onChange={(e) => onEdit((x) => { x.curves[k] = { ...x.curves[k], interpolation: e.target.value as Interpolation }; })}>
          <option value="bezier">Smooth</option><option value="linear">Straight</option><option value="step">Steps</option>
        </select>
      </div>
      <div ref={host} className="ms-plane-host" />
    </section>
  );
}

const stopRadius = (e: MotionEvent) => Math.min(18, 4 + Math.sqrt(Math.max(0, e.params.ms ?? 0) / 100) * 2 + Math.max(0, e.params.blob_mm3 ?? 0) * 3);
const stopT = (e: MotionEvent, b: MotionBrush) => Math.min(1, Math.max(0, e.at.mode === 'percent' ? e.at.value / 100 : e.at.value / Math.max(0.01, b.period_mm)));

function drawPlaneOverlay(g: CanvasRenderingContext2D, X: (t: number) => number, Y: (v: number) => number, h: number, b: MotionBrush, k: CurveKey) {
  const x = X(ui.cursor);
  g.save();
  g.strokeStyle = 'rgba(138,147,160,.9)'; g.lineWidth = 1; g.setLineDash([3, 3]);
  g.beginPath(); g.moveTo(x, 10); g.lineTo(x, h - 22); g.stroke(); g.setLineDash([]);
  g.fillStyle = 'rgba(138,147,160,.95)'; g.beginPath(); g.moveTo(x - 4, 6); g.lineTo(x + 4, 6); g.lineTo(x, 12); g.fill();
  b.events.forEach((e, i) => {
    if (e.type !== 'dwell') return;
    const t = stopT(e, b), px = X(t), py = Y(evalCurve(b.curves[k], t)), r = stopRadius(e);
    g.fillStyle = 'rgba(242,165,22,.28)'; g.beginPath(); g.arc(px, py, r, 0, Math.PI * 2); g.fill();
    g.strokeStyle = AX.stop; g.lineWidth = i === ui.stop ? 2.5 : 1.5; g.stroke();
    g.fillStyle = AX.stop; g.beginPath(); g.arc(px, py, 2.5, 0, Math.PI * 2); g.fill();
  });
  g.restore();
}

// ----- one repeat as a timeline: scrub the toolhead, drop and drag stops
function Timeline({ b, onEdit }: { b: MotionBrush; onEdit: Edit }) {
  useStudio();
  const track = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    if (!playing) return;
    let raf = 0, last = performance.now();
    const tick = (now: number) => { setStudio({ cursor: (ui.cursor + (now - last) / 2400) % 1 }); last = now; raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);
  const tAt = (clientX: number) => {
    const r = track.current!.getBoundingClientRect();
    let t = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    if (ui.snap) t = Math.round(t * 24) / 24;
    return t;
  };
  const dragCursor = (e: React.PointerEvent) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    setPlaying(false);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setStudio({ cursor: tAt(e.clientX) });
  };
  const dragStop = (i: number) => (e: React.PointerEvent) => {
    e.stopPropagation();
    setStudio({ stop: i });
    const el = e.currentTarget as HTMLElement; el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => { const t = tAt(ev.clientX); onEdit((x) => { x.events[i] = { ...x.events[i], at: { mode: 'percent', value: r3(t * 100) } }; }); };
    const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); };
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', up);
  };
  const t = ui.cursor;
  const lat = evalCurve(b.curves.lateral_offset, t) * b.amplitude, z = evalCurve(b.curves.z_offset, t) * (b.z_amplitude ?? 0);
  const addStop = () => { const n = b.events.length; onEdit((x) => { x.events = [...x.events, { at: { mode: 'percent', value: r3(ui.cursor * 100) }, type: 'dwell', params: { ms: 300, blob_mm3: 0.5 } }]; }); setStudio({ stop: n }); };
  return (
    <section className="ms-timeline" aria-label="One repeat">
      <button className="icon-btn" aria-label={playing ? 'Pause' : 'Play'} title={playing ? 'Pause' : 'Play the toolhead through one repeat'} onClick={() => setPlaying(!playing)}>{playing ? '❚❚' : '▶'}</button>
      <div ref={track} className="ms-track" onPointerDown={dragCursor} onPointerMove={(e) => { if (e.buttons && !playing) setStudio({ cursor: tAt(e.clientX) }); }} role="slider" aria-label="Toolhead position" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(t * 100)} tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); setStudio({ cursor: Math.min(1, Math.max(0, t + (e.key === 'ArrowLeft' ? -1 : 1) / 24)) }); } }}>
        {[0, 25, 50, 75, 100].map((p) => <span key={p} className="ms-tick" style={{ left: `${p}%` }}>{p}%</span>)}
        <span className="ms-head" style={{ left: `${t * 100}%` }} />
        {b.events.map((e, i) => e.type === 'dwell' && (
          <button key={i} className={`ms-pin ${i === ui.stop ? 'on' : ''}`} style={{ left: `${stopT(e, b) * 100}%`, width: stopRadius(e) * 1.4, height: stopRadius(e) * 1.4 }}
            aria-label={`Stop at ${Math.round(stopT(e, b) * 100)}%`} title="Drag to move this stop" onPointerDown={dragStop(i)} />
        ))}
      </div>
      <div className="ms-readout mono">
        <span>{Math.round(t * 100)}% · {(t * b.period_mm).toFixed(2)} mm</span>
        <span style={{ color: AX.lat }}>{lat >= 0 ? '+' : ''}{lat.toFixed(2)}</span>
        <span style={{ color: AX.z }}>{z >= 0 ? '+' : ''}{z.toFixed(2)}</span>
      </div>
      <button className="btn-secondary btn-small ms-addstop" onClick={addStop} title="Drop a stop (pause and blob) where the toolhead is">+ Stop here</button>
    </section>
  );
}

// ----- Stop & ooze: pause and blob at points of each repeat
function StopsCard({ b, onEdit }: { b: MotionBrush; onEdit: Edit }) {
  useStudio();
  const stops = b.events.map((e, i) => ({ e, i })).filter((x) => x.e.type === 'dwell');
  return (
    <section className="mx-card ms-stops">
      <div className="mx-card-title"><i className="ms-axdot" style={{ ['--ax' as string]: AX.stop }} />Stops &amp; ooze<span className="spacer" />
        <button className="btn-secondary btn-small" onClick={() => { const n = b.events.length; onEdit((x) => { x.events = [...x.events, { at: { mode: 'percent', value: r3(ui.cursor * 100) }, type: 'dwell', params: { ms: 300, blob_mm3: 0.5 } }]; }); setStudio({ stop: n }); }}>+ Stop</button>
      </div>
      {!stops.length && <p className="mx-muted" style={{ margin: 0 }}>A stop pauses the nozzle and pushes out a little plastic: droplets, bumps or knit-like blobs. Drop one at the timeline cursor.</p>}
      {stops.map(({ e, i }, n) => (
        <div key={i} className={`ms-stop ${i === ui.stop ? 'on' : ''}`} onClick={() => setStudio({ stop: i, cursor: stopT(e, b) })}>
          <div className="ms-stop-h"><i className="ms-blob" style={{ width: stopRadius(e) * 1.2, height: stopRadius(e) * 1.2 }} /><b>Stop {n + 1}</b><span className="spacer" />
            <button className="icon-btn" aria-label={`Remove stop ${n + 1}`} onClick={(ev) => { ev.stopPropagation(); onEdit((x) => { x.events.splice(i, 1); }); setStudio({ stop: -1 }); }}>✕</button>
          </div>
          <Slider label="At" unit="%" min={0} max={100} step={ui.snap ? 100 / 24 : 1} value={r3(stopT(e, b) * 100)} onChange={(v) => onEdit((x) => { x.events[i] = { ...x.events[i], at: { mode: 'percent', value: Math.min(100, Math.max(0, v)) } }; })} />
          <Slider label="Pause" unit="ms" min={0} max={3000} step={50} value={e.params.ms ?? 0} onChange={(v) => onEdit((x) => { x.events[i].params = { ...x.events[i].params, ms: Math.max(0, Math.round(v)) }; })} />
          <Slider label="Ooze" unit="mm³" min={0} max={5} step={0.1} value={e.params.blob_mm3 ?? 0} onChange={(v) => onEdit((x) => { x.events[i].params = { ...x.events[i].params, blob_mm3: Math.max(0, v) }; })} />
        </div>
      ))}
    </section>
  );
}
