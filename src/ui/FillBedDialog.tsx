// "Fill bed with copies" dialog: gaps in 8 directions, rotation step, mirroring and precision.
import { useState } from 'react';
import { create } from 'zustand';
import { cancelFillBed, DEFAULT_FILL, fillBed, footprintMargin, type FillBedOptions } from '../state/fillBed';
import { currentConfig } from '../state/slicing';
import { objectPlate, useStore } from '../state/store';
import { Modal } from './Modals';

const useFillDialog = create<{ id: string | null; last: FillBedOptions }>(() => ({ id: null, last: DEFAULT_FILL }));
export const openFillBed = (id: string) => useFillDialog.setState({ id });

const DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
// compass layout: [row][col] -> direction index (-1 = centre)
const COMPASS = [[7, 0, 1], [6, -1, 2], [5, 4, 3]];
const ROTATIONS: [number, string][] = [[0, 'No rotation'], [180, '180°'], [90, '90°'], [45, '45°'], [15, '15°'], [5, '5° (slow)']];
const PRECISION: [number, string][] = [[0.5, 'Fast (0.5 mm)'], [0.25, 'Fine (0.25 mm)'], [0.1, 'Finest (0.1 mm, slow)']];

const num = (v: string, min = 0) => { const n = parseFloat(v); return isFinite(n) ? Math.max(min, n) : min; };

export function FillBedHost() {
  const id = useFillDialog((s) => s.id);
  const obj = useStore((s) => s.objects.find((o) => o.id === id));
  if (!id || !obj) return null;
  return <FillBedDialog key={id} id={id} onClose={() => useFillDialog.setState({ id: null })} />;
}

function FillBedDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const s = useStore();
  const o = s.objects.find((x) => x.id === id)!;
  const [opt, setOpt] = useState<FillBedOptions>(useFillDialog.getState().last);
  const [perDir, setPerDir] = useState(new Set(opt.gaps).size > 1);
  const [busy, setBusy] = useState<number | null>(null);
  const margin = footprintMargin(o, currentConfig(objectPlate(o, s.printerId, s.plates.length)));
  const set = (patch: Partial<FillBedOptions>) => setOpt({ ...opt, ...patch });
  const setGap = (k: number, v: number) => set({ gaps: opt.gaps.map((g, i) => (i === k ? v : g)) });

  const run = async () => {
    useFillDialog.setState({ last: opt });
    setBusy(0);
    const n = await fillBed(id, opt, setBusy);
    setBusy(null);
    if (n) onClose();
  };
  const close = () => { if (busy !== null) cancelFillBed(); onClose(); };

  return (
    <Modal title={`Fill bed with copies — ${o.name}`} onClose={close}
      footer={<><button className="btn-secondary btn-small" onClick={close}>Cancel</button>
        <button className="btn-primary btn-small" disabled={busy !== null} onClick={run}>{busy !== null ? `Packing… ${busy} placed` : 'Fill bed'}</button></>}>
      <div className="form-grid plate-form">
        <span>Minimum gap</span>
        <div className="row" style={{ margin: 0 }}>
          {!perDir && <><input className="input mono" style={{ width: 70 }} type="number" min={0} step={0.5} value={opt.gaps[0]} onChange={(e) => set({ gaps: Array(8).fill(num(e.target.value)) })} /><span className="muted">mm, all directions</span></>}
          <button className="btn-secondary btn-small" onClick={() => { if (perDir) set({ gaps: Array(8).fill(opt.gaps[0]) }); setPerDir(!perDir); }}>{perDir ? 'Same in all directions' : 'Per direction…'}</button>
        </div>
        {perDir && <>
          <span />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 76px)', gap: 4 }} aria-label="Gap per direction">
            {COMPASS.flat().map((k, i) => k < 0
              ? <span key={i} className="muted" style={{ textAlign: 'center', alignSelf: 'center', fontSize: 11 }}>mm</span>
              : <label key={i} className="row" style={{ margin: 0, gap: 4 }}><span className="mono" style={{ width: 22, fontSize: 11 }}>{DIRS[k]}</span>
                <input className="input mono" style={{ width: 48 }} type="number" min={0} step={0.5} value={opt.gaps[k]} onChange={(e) => setGap(k, num(e.target.value))} /></label>)}
          </div>
        </>}
        <span>Bed edge margin</span>
        <div className="row" style={{ margin: 0 }}><input className="input mono" style={{ width: 70 }} type="number" min={0} step={0.5} value={opt.edge} onChange={(e) => set({ edge: num(e.target.value) })} /><span className="muted">mm</span></div>
        <span>Rotate copies</span>
        <select className="select" value={opt.rotationStep} onChange={(e) => set({ rotationStep: +e.target.value })}>
          {ROTATIONS.map(([v, l]) => <option key={v} value={v}>{v ? `Every ${l}` : l}</option>)}
        </select>
        <span>Mirror copies</span>
        <select className="select" value={opt.mirror} onChange={(e) => set({ mirror: e.target.value as typeof opt.mirror })}>
          {(['off', 'x', 'y', 'auto'] as const).map((m) => <option key={m} value={m}>{m === 'off' ? 'Off' : m === 'auto' ? 'Auto' : `Along ${m.toUpperCase()}`}</option>)}
        </select>
        <span>Precision</span>
        <select className="select" value={opt.precision} onChange={(e) => set({ precision: +e.target.value })}>
          {PRECISION.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <span>Max copies</span>
        <div className="row" style={{ margin: 0 }}><input className="input mono" style={{ width: 70 }} type="number" min={0} step={1} value={opt.max || ''} placeholder="All" onChange={(e) => set({ max: Math.round(num(e.target.value)) })} /><span className="muted">on the plate, original included</span></div>
      </div>
      <div className="muted" style={{ fontSize: 12, marginTop: 10, lineHeight: 1.5 }}>
        <p style={{ margin: '0 0 6px' }}>Copies are packed by their top-down outline, so they can sit inside holes and open shapes (a C inside a turned C). Copies never touch: the gap is kept on every side{perDir ? ', and opposite directions use the larger of the two values, since neighbours share the gap' : ''}.</p>
        {opt.mirror !== 'off' && <p style={{ margin: '0 0 6px' }}>Mirrored copies are left/right versions of the part. They are only used where they pack tighter. The original is never mirrored.</p>}
        <p style={{ margin: 0 }}>
          {margin.brim > 0 ? `The brim takes ${margin.brim.toFixed(1)} mm around each copy. ` : ''}
          {margin.support > 0 ? `Tree supports may lean ${margin.support.toFixed(1)} mm out from each copy. ` : ''}
          Each copy's brim and supports stay inside the space it reserves, so they never cross another copy. Other objects on the plate stay where they are.
        </p>
      </div>
    </Modal>
  );
}
