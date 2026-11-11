// Plate setting: filament printing sequence for different layers (Bambu Studio's "Other layers filament sequence").
// Auto keeps the loaded filament first on each layer; Custom prints the layer's filaments in the order given here.
import { useState } from 'react';
import type { FilamentSequence, LayerSeqRange } from '../engine/toolmap';

export interface SeqDraft { firstCustom: boolean; first: number[]; otherCustom: boolean; other: number[]; ranges: LayerSeqRange[] }

const full = (order: number[] | undefined, n: number) => {
  const o = (order ?? []).filter((f) => f >= 0 && f < n);
  return [...o, ...Array.from({ length: n }, (_, k) => k).filter((k) => !o.includes(k))];
};

export function draftOf(seq: FilamentSequence | undefined, n: number): SeqDraft {
  return {
    firstCustom: !!seq?.first?.length, first: full(seq?.first, n),
    otherCustom: !!(seq?.other?.length || seq?.ranges?.length), other: full(seq?.other, n),
    ranges: (seq?.ranges ?? []).map((r) => ({ ...r, order: full(r.order, n) })),
  };
}

export function sequenceOf(d: SeqDraft): FilamentSequence | undefined {
  const out: FilamentSequence = {};
  if (d.firstCustom) out.first = d.first;
  if (d.otherCustom) { out.other = d.other; if (d.ranges.length) out.ranges = d.ranges.map((r) => ({ from: Math.max(1, r.from), to: r.to > 0 ? Math.max(r.to, r.from) : 0, order: r.order })); }
  return out.first || out.other ? out : undefined;
}

/** Filament chips in print order: drag one onto another, or use the arrows. */
function OrderChips({ order, colors, onChange }: { order: number[]; colors: string[]; onChange: (o: number[]) => void }) {
  const [drag, setDrag] = useState<number | null>(null);
  const move = (from: number, to: number) => {
    if (to < 0 || to >= order.length || from === to) return;
    const o = order.slice(); const [f] = o.splice(from, 1); o.splice(to, 0, f); onChange(o);
  };
  return (
    <div className="row" style={{ flexWrap: 'wrap', gap: 4, margin: 0 }} role="list">
      {order.map((f, k) => (
        <span key={f} role="listitem" draggable onDragStart={() => setDrag(k)} onDragOver={(e) => e.preventDefault()}
          onDrop={() => { if (drag !== null) move(drag, k); setDrag(null); }}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 2, padding: '1px 3px', border: '1px solid var(--border)', borderRadius: 6, cursor: 'grab', opacity: drag === k ? 0.5 : 1 }}>
          <button className="btn-ghost btn-small" style={{ padding: '0 2px' }} disabled={k === 0} onClick={() => move(k, k - 1)} aria-label={`Move filament ${f + 1} earlier`}>‹</button>
          <span className="swatch" style={{ background: colors[f] ?? '#808080', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 20, height: 18, fontSize: 11, fontWeight: 700, color: '#fff', textShadow: '0 0 2px #000' }}>{f + 1}</span>
          <button className="btn-ghost btn-small" style={{ padding: '0 2px' }} disabled={k === order.length - 1} onClick={() => move(k, k + 1)} aria-label={`Move filament ${f + 1} later`}>›</button>
        </span>
      ))}
    </div>
  );
}

export function FilamentSequenceEditor({ draft, colors, onChange }: { draft: SeqDraft; colors: string[]; onChange: (d: SeqDraft) => void }) {
  const set = (p: Partial<SeqDraft>) => onChange({ ...draft, ...p });
  const setRange = (k: number, p: Partial<LayerSeqRange>) => set({ ranges: draft.ranges.map((r, i) => (i === k ? { ...r, ...p } : r)) });
  const num = (v: string) => Math.max(0, Math.round(+v) || 0);
  return (
    <>
      <span>First layer sequence</span>
      <select className="select" value={draft.firstCustom ? 'custom' : 'auto'} onChange={(e) => set({ firstCustom: e.target.value === 'custom' })} aria-label="First layer filament sequence">
        <option value="auto">Auto</option><option value="custom">Customize</option>
      </select>
      {draft.firstCustom && <><span /><OrderChips order={draft.first} colors={colors} onChange={(first) => set({ first })} /></>}
      <span>Other layers sequence</span>
      <select className="select" value={draft.otherCustom ? 'custom' : 'auto'} onChange={(e) => set({ otherCustom: e.target.value === 'custom' })} aria-label="Other layers filament sequence">
        <option value="auto">Auto</option><option value="custom">Customize</option>
      </select>
      {draft.otherCustom && <>
        <span className="muted" style={{ fontSize: 12 }}>Layer 2 – end</span>
        <OrderChips order={draft.other} colors={colors} onChange={(other) => set({ other })} />
        {draft.ranges.map((r, k) => (
          <div key={k} style={{ display: 'contents' }}>
            <span className="row" style={{ margin: 0, gap: 2, fontSize: 12 }}>
              <input className="input" style={{ width: 44 }} type="number" min={1} value={r.from} onChange={(e) => setRange(k, { from: num(e.target.value) })} aria-label="From layer" />–
              <input className="input" style={{ width: 44 }} type="number" min={0} value={r.to || ''} placeholder="end" onChange={(e) => setRange(k, { to: num(e.target.value) })} aria-label="To layer" />
            </span>
            <span className="row" style={{ margin: 0, gap: 4 }}>
              <OrderChips order={r.order} colors={colors} onChange={(order) => setRange(k, { order })} />
              <button className="btn-ghost btn-small" onClick={() => set({ ranges: draft.ranges.filter((_, i) => i !== k) })} aria-label="Remove layer range">✕</button>
            </span>
          </div>
        ))}
        <span />
        <button className="btn-secondary btn-small" style={{ justifySelf: 'start' }} onClick={() => set({ ranges: [...draft.ranges, { from: 2, to: 0, order: draft.other.slice() }] })}>+ Layer range</button>
      </>}
    </>
  );
}
