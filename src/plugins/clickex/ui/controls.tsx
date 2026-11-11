// Small form controls for the Clickex Studio, in the same shape as MakerWorld's editor: a label with a ?
// hint, a value box, a slider; switches; segmented buttons; colour chips.
import { useState, type ReactNode } from 'react';
import { COLOR_PALETTE } from '../catalog';
import { ICONS } from './icons';

export function Ico({ name, size = 18 }: { name: string; size?: number }) {
  const nodes = ICONS[name] ?? [];
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {nodes.map(([tag, attrs], i) => { const T = tag as 'path'; return <T key={i} {...(attrs as object)} />; })}
    </svg>
  );
}

export const Help = ({ text }: { text?: string }) => (text ? <span className="cx-help" title={text}>?</span> : null);

export function Row({ label, help, right, children }: { label: string; help?: string; right?: ReactNode; children?: ReactNode }) {
  return (
    <div className="cx-row">
      <div className="cx-row-head"><span className="cx-label">{label}<Help text={help} /></span>{right}</div>
      {children}
    </div>
  );
}

const clampNum = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

export function Slider({ label, value, set, min, max, step = 1, unit = '', help, disabled, tag, digits }: {
  label: string; value: number; set: (v: number) => void; min: number; max: number; step?: number; unit?: string; help?: string; disabled?: boolean; tag?: string; digits?: number;
}) {
  const d = digits ?? (step < 0.1 ? 2 : step < 1 ? 1 : 0);
  return (
    <div className={`cx-row ${disabled ? 'off' : ''}`}>
      <div className="cx-row-head">
        <span className="cx-label">{label}<Help text={help} /></span>
        <span className="cx-num">
          <input type="number" value={+value.toFixed(d)} min={min} max={max} step={step} disabled={disabled}
            onChange={(e) => { const n = parseFloat(e.target.value); if (isFinite(n)) set(clampNum(n, min, max)); }} />
          {unit && <i>{unit}</i>}
        </span>
      </div>
      <input className="cx-range" type="range" min={min} max={max} step={step} value={value} disabled={disabled} data-tag={tag}
        onChange={(e) => set(parseFloat(e.target.value))} />
    </div>
  );
}

export function Toggle({ label, value, set, help, disabled }: { label: string; value: boolean; set: (v: boolean) => void; help?: string; disabled?: boolean }) {
  return (
    <div className={`cx-row cx-toggle ${disabled ? 'off' : ''}`}>
      <span className="cx-label">{label}<Help text={help} /></span>
      <button className={`cx-switch ${value ? 'on' : ''}`} role="switch" aria-checked={value} disabled={disabled} onClick={() => set(!value)}><i /></button>
    </div>
  );
}

export function Seg<T extends string>({ value, options, set, disabled }: { value: T; options: [T, string][]; set: (v: T) => void; disabled?: boolean }) {
  return (
    <div className="cx-seg">
      {options.map(([v, l]) => <button key={v} className={value === v ? 'on' : ''} disabled={disabled} onClick={() => set(v)}>{l}</button>)}
    </div>
  );
}

export function ColorField({ label, value, set, help, extra }: { label: string; value: string; set: (v: string) => void; help?: string; extra?: string[] }) {
  const [open, setOpen] = useState(false);
  const chips = [...new Set([...(extra ?? []), ...COLOR_PALETTE])];
  return (
    <div className="cx-row">
      <div className="cx-row-head">
        <span className="cx-label">{label}<Help text={help} /></span>
        <button className="cx-swatch" style={{ background: value }} onClick={() => setOpen(!open)} title={value} aria-label={`${label} ${value}`} />
      </div>
      {open && (
        <div className="cx-chips">
          {chips.map((c) => <button key={c} className={`cx-chip ${c.toLowerCase() === value.toLowerCase() ? 'on' : ''}`} style={{ background: c }} onClick={() => set(c)} aria-label={c} />)}
          <label className="cx-chip pick" title="Pick any colour"><input type="color" value={value.length === 7 ? value : '#ffffff'} onChange={(e) => set(e.target.value)} />＋</label>
        </div>
      )}
    </div>
  );
}

export function Cards<T extends string>({ value, options, set }: { value: T; options: { id: T; title: string; text: string; icon?: ReactNode }[]; set: (v: T) => void }) {
  return (
    <div className="cx-cards">
      {options.map((o) => (
        <button key={o.id} className={`cx-card ${value === o.id ? 'on' : ''}`} onClick={() => set(o.id)}>
          {o.icon && <span className="cx-card-ico">{o.icon}</span>}
          <span><b>{o.title}</b><small>{o.text}</small></span>
        </button>
      ))}
    </div>
  );
}

export const Note = ({ kind = 'info', children }: { kind?: 'info' | 'warn' | 'ok'; children: ReactNode }) => <div className={`cx-note ${kind}`}>{children}</div>;
