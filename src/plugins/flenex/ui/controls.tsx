// Small form controls used by the Flenex panels (same look as the other plugins).
import type { ReactNode } from 'react';
import { SideCard, useInStudio } from '../../../ui/studio/Studio';

export function Slider({ label, value, min, max, step = 1, unit, onChange, hint }: { label: string; value: number; min: number; max: number; step?: number; unit?: string; onChange: (v: number) => void; hint?: string }) {
  return (
    <label className="mx-field" title={hint}>
      <span style={{ display: 'flex', justifyContent: 'space-between' }}><span>{label}</span><span>{+value.toFixed(3)}{unit ? ` ${unit}` : ''}</span></span>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
        <input className="input" style={{ width: 64 }} type="number" min={min} max={max} step={step} value={+value.toFixed(3)} onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n)) onChange(n); }} />
      </div>
    </label>
  );
}

export function Select<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <label className="mx-field">{label}
      <select className="select" value={value} onChange={(e) => onChange(e.target.value as T)}>
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </label>
  );
}

export function Toggle({ label, on, onChange }: { label: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="row" style={{ gap: 8, margin: 0, justifyContent: 'space-between', fontSize: 12 }}>
      <span>{label}</span>
      <button className={`toggle ${on ? 'on' : ''}`} aria-label={label} onClick={() => onChange(!on)} />
    </label>
  );
}

export function Card({ title, children, open = true }: { title: string; children: ReactNode; open?: boolean }) {
  // inside the Studio the same content is a collapsible side card
  if (useInStudio()) return <SideCard title={title} defaultOpen={open} id={`fx-${title.split(' (')[0].toLowerCase().replace(/[^a-z]+/g, '-')}`}><div className="st-card-body">{children}</div></SideCard>;
  return (
    <details className="mx-card" open={open}>
      <summary className="mx-card-title" style={{ cursor: 'pointer' }}>{title}</summary>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>{children}</div>
    </details>
  );
}
