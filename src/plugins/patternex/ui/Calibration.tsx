// Bleed calibration wizard: print a test bar with no-purge changes, measure the mixed-colour length
// on the outer wall after a change, and store the calibrated transition volume for that filament.
import { useState } from 'react';
import { useStore } from '../../../state/store';
import { addShape } from '../../../state/objectOps';
import { parseSvg } from '../svg';
import { applyToObject } from '../library/apply';
import { calibratedVolume } from '../tools/layout';
import { addPattern } from './state';
import { px, changed } from './PatternexPanel';

/** Five 3 mm bands, 3 mm apart: ten no-purge changes on the front wall. */
const BANDS = parseSvg('<svg viewBox="0 0 36 27" width="36mm" height="27mm">' + [0, 6, 12, 18, 24].map((y) => `<rect y="${y}" width="36" height="3" fill="#2f2f33"/>`).join('') + '</svg>', { id: 'px-bleed-test', name: 'Bleed test bands' }).pattern;

export function Calibration() {
  const { filaments, overrides } = useStore();
  const [open, setOpen] = useState(false);
  const [slot, setSlot] = useState(Math.min(1, filaments.length - 1));
  const [bleed, setBleed] = useState('');
  const lineW = Number(overrides.outer_wall_line_width) || Number(overrides.line_width) || 0.42;
  const layerH = Number(overrides.layer_height) || 0.2;
  if (!open) return <button className="btn-secondary btn-small" onClick={() => setOpen(true)}>Calibrate bleed…</button>;
  const v = calibratedVolume(Number(bleed), lineW, layerH);
  return (
    <div className="px-wizard">
      <div className="mx-label">Bleed calibration</div>
      <ol className="px-steps">
        <li>
          Filament to calibrate
          <select className="select" value={slot} onChange={(e) => setSlot(Number(e.target.value))}>{filaments.map((f, k) => (k ? <option key={k} value={k}>Slot {k + 1} · {f.color}</option> : null))}</select>
          <button className="btn-secondary btn-small" onClick={() => {
            addShape('box');
            const s = useStore.getState();
            const id = s.selected[0];
            // 40 × 8 × 30 mm bar: room for 3 mm bands on the front wall
            s.updateObjects((o) => ({ ...o, name: `Bleed test · slot ${slot + 1}`, scale: [2, 0.4, 1.5] }), [id], false);
            const o = useStore.getState().objects.find((x) => x.id === id)!;
            addPattern(px, BANDS);
            applyToObject(px, o, { kind: 'side', side: 'front' }, () => BANDS, (pid) => [{
              region_ref: { placement_id: pid, color_group: '#2f2f33' }, material: { mode: 'slot', slot_index: slot },
              purge: { mode: 'none', change_point_shift_mm: 0 }, motion: null,
            }]);
            changed();
          }}>Add test bar</button>
        </li>
        <li>Slice and print it. Each band starts with no purge, so the old colour bleeds into the new one.</li>
        <li>
          On the outer wall, measure how far along the line the colour stays mixed after a band starts (mm, average of a few):
          <input className="input" type="number" min={0} step={1} value={bleed} placeholder="e.g. 90" onChange={(e) => setBleed(e.target.value)} />
        </li>
      </ol>
      {Number(bleed) > 0 && <p className="mx-muted">{Number(bleed).toFixed(1)} mm × {lineW.toFixed(2)} mm line × {layerH.toFixed(2)} mm layer = <b>{v.toFixed(1)} mm³</b></p>}
      <div className="mx-chips">
        <button className="btn-primary btn-small" disabled={!(Number(bleed) > 0)} onClick={() => { px.transitionVolume[slot] = +v.toFixed(1); changed(); setOpen(false); setBleed(''); }}>Save for slot {slot + 1}</button>
        <button className="btn-secondary btn-small" onClick={() => setOpen(false)}>Close</button>
      </div>
    </div>
  );
}
