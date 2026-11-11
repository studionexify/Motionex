// Colour mixing (Snapmaker Orca style): mixed filaments built from the physical ones by alternating layers.
// Shown for tool changers (Snapmaker U1), where a change is a head swap with no purge.
import { useMemo, useState } from 'react';
import { useStore } from '../state/store';
import { MAX_CYCLE, MAX_RATIO, gradientSlots, matchMixes, mixColor, mixCss, mixLabel, mixProblems, mixSequence, shiftIndex, type MixedFilament } from '../profiles/mixing';
import { Modal } from './Modals';
import { Icon } from './icons';

const newMixId = () => `mix-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Shift every object / paint reference at or after `from` by `delta`; references to `gone` go to filament 1. */
export function shiftFilamentRefs(gone: number | null, from: number, delta: number) {
  const st = useStore.getState();
  st.updateObjects((o) => ({
    ...o,
    filament: shiftIndex(o.filament, gone, from, delta),
    paint: o.paint?.color ? { ...o.paint, color: o.paint.color.map((c: number) => (c === 0 ? 0 : (shiftIndex(c - 1, gone, from, delta) ?? 0) + 1)) } : o.paint,
  }), st.objects.map((o) => o.id));
}

function LayerStrip({ mix, colors, layers = 12 }: { mix: MixedFilament; colors: string[]; layers?: number }) {
  const seq = mixSequence(mix);
  const slots = mix.kind === 'gradient' ? gradientSlots(mix, Array.from({ length: layers }, (_, i) => i / Math.max(1, layers - 1))) : Array.from({ length: layers }, (_, i) => seq[i % seq.length]);
  const h = layers > 20 ? 2 : 6;
  return (
    <div className="mix-strip" title="Layers from the bottom up" style={{ display: 'flex', flexDirection: 'column-reverse', width: 56, border: '1px solid var(--border)', borderRadius: 4, overflow: 'hidden' }}>
      {slots.map((k, i) => <div key={i} style={{ height: h, background: colors[k] ?? '#888' }} />)}
    </div>
  );
}

function FilPick({ value, colors, onChange, label }: { value: number; colors: string[]; onChange: (k: number) => void; label: string }) {
  return (
    <div className="palette" role="radiogroup" aria-label={label}>
      {colors.map((c, k) => <button key={k} role="radio" aria-checked={value === k} className={`pal ${value === k ? 'on' : ''}`} style={{ background: c, border: '1px solid var(--text-muted)' }} onClick={() => onChange(k)} title={`Filament ${k + 1}`}>{k + 1}</button>)}
    </div>
  );
}

function Stepper({ value, onChange, label }: { value: number; onChange: (v: number) => void; label: string }) {
  return (
    <span className="row" style={{ gap: 4 }}>
      <button className="icon-btn" aria-label={`Less ${label}`} disabled={value <= 1} onClick={() => onChange(value - 1)}>−</button>
      <span className="mono" style={{ minWidth: 16, textAlign: 'center' }} aria-label={label}>{value}</span>
      <button className="icon-btn" aria-label={`More ${label}`} disabled={value >= MAX_RATIO} onClick={() => onChange(value + 1)}>+</button>
    </span>
  );
}

type Tab = 'ratio' | 'cycle' | 'gradient' | 'match';

export function MixModal({ initial, onSave, onClose }: { initial?: MixedFilament; onSave: (m: MixedFilament) => void; onClose: () => void }) {
  const colors = useStore((s) => s.filaments.map((f) => f.color));
  const two = Math.min(1, colors.length - 1);
  const [tab, setTab] = useState<Tab>(initial?.kind ?? 'ratio');
  const [a, setA] = useState(initial && initial.kind !== 'cycle' ? initial.a : 0);
  const [b, setB] = useState(initial && initial.kind !== 'cycle' ? initial.b : two);
  const [ra, setRa] = useState(initial?.kind === 'ratio' ? initial.ra : 1);
  const [rb, setRb] = useState(initial?.kind === 'ratio' ? initial.rb : 1);
  const [seq, setSeq] = useState<number[]>(initial?.kind === 'cycle' ? initial.seq : [0, two]);
  const [start, setStart] = useState(initial?.kind === 'gradient' ? initial.start : 0);
  const [end, setEnd] = useState(initial?.kind === 'gradient' ? initial.end : 100);
  const [target, setTarget] = useState('#E07040');
  const matches = useMemo(() => (tab === 'match' ? matchMixes(target, colors) : []), [tab, target, colors.join()]);
  const [pick, setPick] = useState(0);
  const id = initial?.id ?? newMixId();
  const name = initial?.name;
  const mix: MixedFilament = tab === 'ratio' ? { id, name, kind: 'ratio', a, b, ra, rb }
    : tab === 'cycle' ? { id, name, kind: 'cycle', seq }
    : tab === 'gradient' ? { id, name, kind: 'gradient', a, b, start, end }
    : { ...(matches[pick]?.mix ?? { kind: 'ratio', a: 0, b: two, ra: 1, rb: 1 }), id, name } as MixedFilament;
  const problems = tab === 'match' && !matches.length ? ['No match found.'] : mixProblems(mix, colors.length);
  const color = mixColor(mix, colors);
  return (
    <Modal title={initial ? 'Edit mix' : 'Add mix'} onClose={onClose} footer={<>
      <span className="spacer" />
      <button className="btn-secondary btn-small" onClick={onClose}>Cancel</button>
      <button className="btn-primary btn-small" disabled={problems.length > 0} onClick={() => { onSave(mix); onClose(); }}>{initial ? 'Save' : 'Add'}</button>
    </>}>
      <div className="seg" role="tablist" style={{ marginBottom: 12 }}>
        {(['ratio', 'cycle', 'gradient', 'match'] as Tab[]).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{t[0].toUpperCase() + t.slice(1)}</button>
        ))}
      </div>
      <div className="row" style={{ alignItems: 'flex-start', gap: 16 }}>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {tab === 'ratio' && <>
            <p className="muted" style={{ fontSize: 12, margin: 0 }}>Two filaments alternate layer by layer. The ratio sets how many layers of each are printed in turn.</p>
            <div><div className="muted" style={{ fontSize: 12 }}>Filament A</div><FilPick label="Filament A" value={a} colors={colors} onChange={setA} /></div>
            <div><div className="muted" style={{ fontSize: 12 }}>Filament B</div><FilPick label="Filament B" value={b} colors={colors} onChange={setB} /></div>
            <div className="row" style={{ gap: 8 }}>
              <span className="muted" style={{ fontSize: 12 }}>Ratio A : B</span>
              <Stepper label="A layers" value={ra} onChange={setRa} /><span>:</span><Stepper label="B layers" value={rb} onChange={setRb} />
              <span className="muted mono" style={{ fontSize: 12 }}>{Math.round((100 * ra) / (ra + rb))}% / {Math.round((100 * rb) / (ra + rb))}%</span>
            </div>
          </>}
          {tab === 'cycle' && <>
            <p className="muted" style={{ fontSize: 12, margin: 0 }}>A sequence of filaments repeated from the first layer up, one filament per layer. Click filaments to add them in order.</p>
            <FilPick label="Add filament to the cycle" value={-1} colors={colors} onChange={(k) => setSeq((q) => (q.length < MAX_CYCLE ? [...q, k] : q))} />
            <div className="row" style={{ flexWrap: 'wrap', gap: 4 }} aria-label="Cycle">
              {seq.map((k, i) => (
                <span key={i} className="badge" style={{ background: colors[k], color: '#fff', textShadow: '0 0 2px #000' }}>
                  {k + 1}<button className="icon-btn" style={{ width: 16, height: 16 }} aria-label={`Remove step ${i + 1}`} onClick={() => setSeq((q) => q.filter((_, j) => j !== i))}><Icon name="close" size={10} /></button>
                </span>
              ))}
              {seq.length > 0 && <button className="btn-secondary btn-small" onClick={() => setSeq([])}>Clear</button>}
            </div>
          </>}
          {tab === 'gradient' && <>
            <p className="muted" style={{ fontSize: 12, margin: 0 }}>Filament A at the bottom of the object fades into filament B at the top. Between the start and end heights more and more layers use B.</p>
            <div><div className="muted" style={{ fontSize: 12 }}>Bottom colour (A)</div><FilPick label="Filament A" value={a} colors={colors} onChange={setA} /></div>
            <div><div className="muted" style={{ fontSize: 12 }}>Top colour (B)</div><FilPick label="Filament B" value={b} colors={colors} onChange={setB} /></div>
            <label className="row" style={{ gap: 8 }}><span className="muted" style={{ fontSize: 12, width: 110 }}>Fade starts at</span>
              <input type="range" min={0} max={100} value={start} aria-label="Fade start" onChange={(e) => { const v = +e.target.value; setStart(v); if (v > end) setEnd(v); }} style={{ flex: 1, accentColor: 'var(--accent)' }} /><span className="mono" style={{ width: 40 }}>{start}%</span></label>
            <label className="row" style={{ gap: 8 }}><span className="muted" style={{ fontSize: 12, width: 110 }}>Fade ends at</span>
              <input type="range" min={0} max={100} value={end} aria-label="Fade end" onChange={(e) => { const v = +e.target.value; setEnd(v); if (v < start) setStart(v); }} style={{ flex: 1, accentColor: 'var(--accent)' }} /><span className="mono" style={{ width: 40 }}>{end}%</span></label>
            <span className="muted" style={{ fontSize: 11 }}>Heights are % of each object's own height, so the fade fits any size.</span>
          </>}
          {tab === 'match' && <>
            <p className="muted" style={{ fontSize: 12, margin: 0 }}>Pick the colour you want. NexSpiro finds the mixes of your loaded filaments that look closest.</p>
            <label className="row" style={{ gap: 8 }}><span className="muted" style={{ fontSize: 12 }}>Target colour</span>
              <input type="color" value={target} aria-label="Target colour" onChange={(e) => { setTarget(e.target.value); setPick(0); }} />
              <input className="input mono" style={{ width: 90 }} value={target} onChange={(e) => { if (/^#[0-9a-f]{6}$/i.test(e.target.value)) { setTarget(e.target.value); setPick(0); } }} /></label>
            <div role="listbox" aria-label="Closest mixes" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {matches.map((m, k) => (
                <button key={k} role="option" aria-selected={pick === k} className={`row match ${pick === k ? 'on' : ''}`} onClick={() => setPick(k)}
                  style={{ gap: 8, padding: 4, border: `1px solid ${pick === k ? 'var(--accent)' : 'var(--border)'}`, borderRadius: 6, background: 'transparent', cursor: 'pointer', color: 'inherit' }}>
                  <span style={{ width: 22, height: 22, borderRadius: 4, background: target, boxShadow: 'inset 0 0 0 1px var(--border)' }} title="Target" />
                  <span style={{ width: 22, height: 22, borderRadius: 4, background: m.color, boxShadow: 'inset 0 0 0 1px var(--border)' }} title="Mix" />
                  <span className="mono" style={{ flex: 1, textAlign: 'left', fontSize: 12 }}>{mixLabel(m.mix)}</span>
                  <span className="muted" style={{ fontSize: 11 }}>{matchWord(m.dE)} · ΔE {m.dE.toFixed(1)}</span>
                </button>
              ))}
            </div>
            {matches[0] && matches[0].dE > 8 && <span style={{ color: 'var(--warning)', fontSize: 12 }}>Your loaded filaments can't get close to this colour. Load a filament nearer to it (for example white or black to lighten or darken).</span>}
          </>}
          {problems.length > 0 && tab !== 'match' && <div style={{ color: 'var(--warning)', fontSize: 12 }}>{problems.join(' ')}</div>}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
          <div style={{ width: 56, height: 56, borderRadius: 8, background: mixCss(mix, colors), border: '1px solid var(--border)' }} title="Expected colour" />
          <span className="mono muted" style={{ fontSize: 11 }}>{mix.kind === 'gradient' ? 'gradient' : color}</span>
          <LayerStrip mix={mix} colors={colors} layers={mix.kind === 'gradient' ? 40 : 12} />
        </div>
      </div>
      <p className="muted" style={{ fontSize: 11, marginBottom: 0 }}>The colour shown is an estimate. Thin layers (0.08–0.12 mm) blend best; check the side of a test print in daylight.</p>
    </Modal>
  );
}

const matchWord = (dE: number) => (dE < 3 ? 'Very close' : dE < 6 ? 'Close' : dE < 12 ? 'Near' : 'Far');

/** Mixed filament list under the physical filament slots. */
export function ColorMixingSection() {
  const { filaments, mixes, set, markDirty } = useStore();
  const [edit, setEdit] = useState<number | 'new' | null>(null);
  const colors = filaments.map((f) => f.color);
  const P = filaments.length;
  const save = (m: MixedFilament) => {
    const next = edit === 'new' || edit === null ? [...mixes, m] : mixes.map((x, i) => (i === edit ? m : x));
    set({ mixes: next }); markDirty();
  };
  const remove = (k: number) => {
    shiftFilamentRefs(P + k, P + k + 1, -1);
    set({ mixes: mixes.filter((_, i) => i !== k) }); markDirty();
  };
  return (
    <div className="mixes" style={{ marginTop: 8 }}>
      <div className="row">
        <span style={{ fontWeight: 600, fontSize: 12 }}>Color mixing</span>
        <span className="spacer" />
        <button className="btn-secondary btn-small" disabled={P < 2} title={P < 2 ? 'Add a second filament first' : 'Make a new colour from the loaded filaments'} onClick={() => setEdit('new')}><Icon name="add" size={12} /> Add mix</button>
      </div>
      {mixes.length === 0 && <div className="muted" style={{ fontSize: 12 }}>New colours from the loaded filaments by alternating layers. Mixed filaments are numbered after the slots ({P + 1}, {P + 2} …) and can be set on objects or painted.</div>}
      {mixes.map((m, k) => {
        const problems = mixProblems(m, P);
        return (
          <div className="row slot" key={m.id}>
            <span className="swatch-btn" style={{ background: mixCss(m, colors) }} title="Expected colour"><span>{P + k + 1}</span></span>
            <span style={{ flex: 1, fontSize: 12 }}>{m.kind[0].toUpperCase() + m.kind.slice(1)} · <span className="mono">{mixLabel(m)}</span></span>
            {problems.length > 0 && <span title={problems.join(' ')} style={{ color: 'var(--warning)', display: 'flex' }}><Icon name="warn" size={14} /></span>}
            <button className="icon-btn" title="Edit mix" onClick={() => setEdit(k)}><Icon name="edit" size={16} /></button>
            <button className="icon-btn" title="Remove mix" onClick={() => remove(k)}><Icon name="close" size={14} /></button>
          </div>
        );
      })}
      {edit !== null && <MixModal initial={edit === 'new' ? undefined : mixes[edit]} onSave={save} onClose={() => setEdit(null)} />}
    </div>
  );
}
