// A cut-type picker that shows what every cut looks like (a real cutaway of the joint) instead of a plain list.
import { useEffect, useRef, useState } from 'react';
import { JOINTS, type JointKind } from '../joints';
import { useJointThumbs } from './thumbs';

export function JointPicker({ value, onChange, label = 'Cut type' }: { value: JointKind; onChange: (k: JointKind) => void; label?: string }) {
  const [open, setOpen] = useState(false);
  const thumbs = useJointThumbs();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);
  const cur = JOINTS.find((j) => j.id === value)!;
  const cell = (j: (typeof JOINTS)[number]) => (
    <button key={j.id} className={`fx-jp-cell ${j.id === value ? 'on' : ''}`} title={j.blurb} onClick={() => { onChange(j.id); setOpen(false); }}>
      {thumbs.get(j.id) ? <img src={thumbs.get(j.id)} alt="" /> : <span className="fx-jp-ph" />}
      <b>{j.name}</b>
      <small>{j.blurb}</small>
    </button>
  );
  return (
    <div className="mx-field fx-jp" ref={box}>
      <span>{label}</span>
      <button className="fx-jp-cur" onClick={() => setOpen(!open)} aria-haspopup="listbox" aria-expanded={open}>
        {thumbs.get(value) ? <img src={thumbs.get(value)} alt="" /> : <span className="fx-jp-ph sm" />}
        <span><b>{cur.name}</b><small>{cur.group === 'moving' ? 'moving joint' : 'assembly cut'}</small></span>
        <i>▾</i>
      </button>
      {open && (
        <div className="fx-jp-pop" role="listbox">
          <div className="fx-jp-head">Moving joints</div>
          <div className="fx-jp-grid">{JOINTS.filter((j) => j.group === 'moving').map(cell)}</div>
          <div className="fx-jp-head">Assembly and separation cuts</div>
          <div className="fx-jp-grid">{JOINTS.filter((j) => j.group === 'assembly').map(cell)}</div>
        </div>
      )}
    </div>
  );
}
