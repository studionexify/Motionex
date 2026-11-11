// Floating top-right cluster: Ctrl+K search trigger and plate selector.
import { useState } from 'react';
import { useStore } from '../../state/store';
import { addPlate } from '../../state/ops';
import { useUi } from '../../state/ui';
import { Icon } from '../icons';
import { openPlateSettings } from '../PlateControls';
import { useOutsideClose } from './FileMenu';

export function PlateSelect() {
  const plates = useStore((s) => s.plates);
  const active = useStore((s) => s.activePlate);
  const set = useStore((s) => s.set);
  const [open, setOpen] = useState(false);
  useOutsideClose(open, () => setOpen(false));
  const stop = (e: React.PointerEvent) => e.stopPropagation();
  return (
    <div className="menu">
      <button className={`sh-ib ${open ? 'on' : ''}`} onPointerDown={stop} onClick={() => setOpen(!open)} aria-haspopup="menu" title="Active plate">
        {plates[active]?.name ?? `Plate ${active + 1}`}<Icon name="chevronDown" size={12} />
      </button>
      {open && (
        <div className="menu-pop" role="menu" style={{ right: 0, left: 'auto' }}>
          {plates.map((p, i) => (
            <button key={p.id} className={`menu-item ${i === active ? 'active' : ''}`} onPointerDown={stop} onClick={() => { setOpen(false); set({ activePlate: i }); }}>
              <span>{p.name}</span><kbd>{i === active ? '●' : ''}</kbd>
            </button>
          ))}
          <div className="sep" style={{ width: '100%', height: 1, margin: '4px 0' }} />
          <button className="menu-item" onPointerDown={stop} onClick={() => { setOpen(false); addPlate(); }}><span>Add plate</span><kbd /></button>
          <button className="menu-item" onPointerDown={stop} onClick={() => { setOpen(false); openPlateSettings(active); }}><span>Plate settings…</span><kbd /></button>
        </div>
      )}
    </div>
  );
}

export function TopRight({ plates = true }: { plates?: boolean }) {
  const setUi = useUi((s) => s.set);
  return (
    <div className="float sh-float sh-tr">
      <button className="sh-ib sh-cmdk" title="Search settings, tools and actions (Ctrl+K)" onClick={() => setUi({ paletteOpen: true })}>
        <Icon name="search" size={16} /><span>Search</span><kbd>Ctrl K</kbd>
      </button>
      {plates && <PlateSelect />}
    </div>
  );
}
