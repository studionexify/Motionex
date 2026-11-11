import { useEffect, useRef, useState, type ReactNode } from 'react';
import { FILAMENT_PAGES, FILAMENT_PARAMS, NULLABLE_FILAMENT_KEYS, filamentConfig } from '../profiles/filamentParams';
import { MACHINE_PAGES, MACHINE_PARAMS } from '../profiles/machineParams';
import { effectiveNozzle, machineConfig } from '../profiles/resolve';
import type { Config } from '../profiles/settings';
import { ParamPages } from './ParamRow';
import { filamentById } from '../profiles/filaments';
import { printerById } from '../profiles/printers';
import { useStore } from '../state/store';
import { Icon } from './icons';

export function Modal({ title, onClose, children, footer }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  const bg = useRef<HTMLDivElement>(null);
  const close = useRef(onClose); close.current = onClose;
  // Esc closes the dialog (the topmost one only, when dialogs are stacked)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const all = document.querySelectorAll('.modal-bg');
      if (all[all.length - 1] !== bg.current) return;
      e.preventDefault(); e.stopPropagation(); close.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  return (
    <div ref={bg} className="modal-bg" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-label={title}>
        <header>{title}<span className="spacer" /><button className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="close" /></button></header>
        <div className="body">{children}</div>
        <footer>{footer ?? <button className="btn-secondary btn-small" onClick={onClose}>Close</button>}</footer>
      </div>
    </div>
  );
}

export function PrinterModal({ onClose }: { onClose: () => void }) {
  const { printerId, machineOverrides, setMachine, markDirty } = useStore();
  const p = printerById(printerId);
  const base = machineConfig(printerId);
  const [q, setQ] = useState('');
  const n = Object.keys(machineOverrides).length;
  return (
    <Modal title={`Printer settings — ${n ? '* ' : ''}${p.vendor} ${p.model}`} onClose={onClose} footer={<>
      <button className="btn-secondary btn-small" disabled={!n} onClick={() => { for (const k of Object.keys(machineOverrides)) setMachine(k, undefined); markDirty(); }}>Revert all</button>
      <span className="spacer" />
      <button className="btn-primary btn-small" onClick={onClose}>Done</button>
    </>}>
      <div className="row" style={{ marginBottom: 8, gap: 8, flexWrap: 'wrap' }}>
        <span className="badge">{p.bed.x} × {p.bed.y} × {p.bed.z} mm</span>
        <span className="badge">Nozzle {effectiveNozzle(printerId, machineOverrides)} mm</span>
        <span className="badge">{p.flavor === 'bbl' ? 'Marlin (A1/P1/X1/H2 dialect)' : p.flavor === 'klipper' ? 'Klipper' : 'Marlin'}</span>
        <span className="spacer" />
        <input className="input" style={{ width: 180 }} placeholder="Search settings…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <ParamPages params={MACHINE_PARAMS} pages={MACHINE_PAGES} search={q}
        value={(k) => (k in machineOverrides ? machineOverrides[k] : base[k])} base={(k) => base[k]} modified={(k) => k in machineOverrides}
        onCommit={(k, v) => { setMachine(k, v === base[k] ? undefined : v); markDirty(); }} onReset={(k) => { setMachine(k, undefined); markDirty(); }} />
      <p className="muted" style={{ fontSize: 11 }}>G-code placeholders such as <span className="mono">[nozzle_temperature_initial_layer]</span>, <span className="mono">[layer_num]</span> and <span className="mono">[layer_z]</span> are expanded when slicing.</p>
    </Modal>
  );
}

/** Filament settings of one slot (filament settings pages). Changes are kept on the slot. */
export function FilamentModal({ slot, onClose }: { slot: number; onClose: () => void }) {
  const { filaments, printerId, machineOverrides, set, markDirty } = useStore();
  const st = filaments[slot] ?? filaments[0];
  const f = filamentById(st.presetId);
  const base = filamentConfig(f);
  const ov = st.overrides ?? {};
  const machine = machineConfig(printerId, machineOverrides);
  const [q, setQ] = useState('');
  const n = Object.keys(ov).length;
  const write = (o: Config) => { set({ filaments: filaments.map((x, i) => (i === slot ? { ...x, overrides: Object.keys(o).length ? o : undefined } : x)) }); markDirty(); };
  const commit = (k: string, v: Config[string]) => { const o = { ...ov }; if (v === base[k] && !NULLABLE_FILAMENT_KEYS.has(k)) delete o[k]; else o[k] = v; write(o); };
  const reset = (k: string) => { const o = { ...ov }; delete o[k]; write(o); };
  return (
    <Modal title={`Filament ${slot + 1} — ${n ? '* ' : ''}${f.name}${n ? ' (modified)' : ''}`} onClose={onClose} footer={<>
      <button className="btn-secondary btn-small" disabled={!n} onClick={() => write({})}>Revert all</button>
      <span className="spacer" />
      <button className="btn-primary btn-small" onClick={onClose}>Done</button>
    </>}>
      <div className="row" style={{ marginBottom: 8, gap: 8 }}>
        <span className="swatch" style={{ background: st.color, display: 'inline-block' }} />
        <span className="badge">{String(ov.filament_type ?? base.filament_type)}</span>
        <span className="spacer" />
        <input className="input" style={{ width: 180 }} placeholder="Search settings…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <ParamPages params={FILAMENT_PARAMS} pages={FILAMENT_PAGES} search={q}
        value={(k) => (k in ov ? ov[k] : base[k])} base={(k) => base[k] ?? machine[k.replace(/^filament_/, '')]} modified={(k) => k in ov}
        onCommit={commit} onReset={reset}
        nullable={(k) => (NULLABLE_FILAMENT_KEYS.has(k) ? { inherited: machine[k.replace(/^filament_/, '')] } : undefined)} />
    </Modal>
  );
}
