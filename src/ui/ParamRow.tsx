import { useEffect, useRef, useState } from 'react';

/** Settings-row tooltips: the first one waits 2 s; once one has shown, moving to other labels opens them instantly
 *  until the pointer has been off every label for a short grace period. */
const TIP_DELAY = 2000, TIP_GRACE = 800;
let tipWarm = false;
let coolTimer: ReturnType<typeof setTimeout> | undefined;
import type { Config, ParamDef } from '../profiles/settings';
import { Icon } from './icons';

/**
 * One settings row: a lock when the value is the system (preset) value, an orange revert
 * arrow when it was changed, then the control. `nullable` rows (filament setting overrides) get a checkbox:
 * unchecked means "use the printer's value".
 */
export function ParamRow({ def, value, baseValue, cfg, modified, onCommit, onReset, resetLabel, nullable, pin, hint }: {
  def: ParamDef; value: Config[string] | undefined; baseValue: Config[string] | undefined; cfg: Config; modified: boolean;
  onCommit: (v: Config[string]) => void; onReset: () => void; resetLabel?: string;
  /** Value inherited when the override is off (shown greyed). */
  nullable?: { inherited: Config[string] | undefined };
  /** Optional pin star (Inspector): pinned rows show at the top of the object view. */
  pin?: { on: boolean; toggle: () => void };
  /** Plain-language one-liner shown first in the tooltip. */
  hint?: string;
}) {
  const off = !!nullable && value === undefined;
  const shown = off ? nullable!.inherited : value;
  const disabled = off || (def.disabledWhen?.(cfg) ?? false);
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(openTimer.current), []);
  const enter = (el: HTMLElement) => {
    const r = el.getBoundingClientRect(), at = { x: r.right + 8, y: r.top };
    clearTimeout(coolTimer); clearTimeout(openTimer.current);
    if (tipWarm) { setTip(at); return; }
    openTimer.current = setTimeout(() => { tipWarm = true; setTip(at); }, TIP_DELAY);
  };
  const leave = () => {
    clearTimeout(openTimer.current); setTip(null);
    clearTimeout(coolTimer); coolTimer = setTimeout(() => { tipWarm = false; }, TIP_GRACE);
  };

  let control;
  if (def.type === 'bool') {
    control = <div className="pinput"><button className={`toggle ${shown ? 'on' : ''}`} disabled={disabled} aria-label={def.label} onClick={() => onCommit(!shown)} /></div>;
  } else if (def.type === 'enum') {
    control = (
      <div className="pinput">
        <select className="select" disabled={disabled} value={String(shown)} aria-label={def.label} onChange={(e) => onCommit(e.target.value)}>
          {def.options!.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>
    );
  } else if (def.type === 'text') {
    control = <TextArea value={String(shown ?? '')} def={def} disabled={disabled} onCommit={onCommit} />;
  } else {
    control = (
      <div className="pinput">
        <ValueInput value={shown} def={def} disabled={disabled} onCommit={onCommit} />
        {def.unit && <span className="unit">{def.type === 'floatOrPercent' && String(shown).endsWith('%') ? '%' : def.unit}</span>}
      </div>
    );
  }
  const marker = modified
    ? <button className="reset" title={resetLabel ? `${resetLabel} (${String(baseValue)})` : `Revert to the system value (${String(baseValue)})`} aria-label="Revert" onClick={onReset}><Icon name="reset" size={14} /></button>
    : <span className="lock" title="System value"><Icon name="lock" size={12} /></span>;
  return (
    <div className={`prow ${pin ? 'has-pin' : ''} ${modified ? 'modified' : ''} ${disabled ? 'disabled' : ''} ${def.type === 'text' ? 'wide' : ''}`}>
      <span className="plabel"
        onMouseEnter={(e) => enter(e.currentTarget)}
        onMouseLeave={leave}
        onPointerUp={(e) => { if (e.pointerType === 'mouse') return; const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setTip((t) => (t ? null : { x: Math.min(r.left, window.innerWidth - 280), y: r.bottom + 4 })); }}>
        {nullable && (
          <input type="checkbox" className="ovr-check" checked={!off} aria-label={`Override ${def.label}`}
            onChange={(e) => (e.target.checked ? onCommit(nullable.inherited ?? def.def) : onReset())} onClick={(e) => e.stopPropagation()} />
        )}
        {def.label}
      </span>
      {marker}
      {control}
      {pin && (
        <button className={`pinb ${pin.on ? 'on' : ''}`} aria-pressed={pin.on} aria-label={pin.on ? `Unpin ${def.label}` : `Pin ${def.label}`}
          title={pin.on ? 'Pinned to the top of the inspector — click to unpin' : 'Pin to the top of the inspector'} onClick={pin.toggle}>{pin.on ? '★' : '☆'}</button>
      )}
      {tip && (
        <div className="tooltip" style={{ left: Math.min(tip.x, window.innerWidth - 350), top: Math.min(tip.y, window.innerHeight - 160) }}>
          <b>{def.label}</b>{hint && <div className="hint">{hint}</div>}{def.tip}
          <div className="key">Default: {String(baseValue ?? def.def)}{def.unit ? ` ${def.unit}` : ''} · Internal key: <span className="mono">{def.key}</span></div>
        </div>
      )}
    </div>
  );
}

/** Parse what the user typed for a numeric, percent-or-value or string setting; null = reject. */
export function parseParam(def: ParamDef, text: string): Config[string] | null {
  const t = text.trim();
  if (def.type === 'string') return t;
  if (def.type === 'floatOrPercent' && t.endsWith('%')) {
    const v = parseFloat(t);
    return isFinite(v) && v >= 0 ? `${+v.toFixed(4)}%` : null;
  }
  let v = parseFloat(t);
  if (!isFinite(v)) return null;
  if (def.min !== undefined) v = Math.max(def.min, v);
  if (def.max !== undefined) v = Math.min(def.max, v);
  if (def.type === 'int' || def.type === 'percent') v = Math.round(v);
  return +v.toFixed(4);
}

function ValueInput({ value, def, disabled, onCommit }: { value: Config[string] | undefined; def: ParamDef; disabled: boolean; onCommit: (v: Config[string]) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const apply = () => {
    if (draft === null) return;
    const v = parseParam(def, draft);
    setDraft(null);
    if (v !== null && v !== value) onCommit(v);
  };
  return (
    <input className="input" disabled={disabled} aria-label={def.label} value={draft ?? String(value ?? '')}
      title={def.type === 'floatOrPercent' ? `A value in ${def.unit ?? 'mm'} or a percentage${def.percentOf ? ` of ${def.percentOf.replace(/_/g, ' ')}` : ''}` : undefined}
      onChange={(e) => setDraft(e.target.value)} onBlur={apply}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setDraft(null); }} />
  );
}

function TextArea({ value, def, disabled, onCommit }: { value: string; def: ParamDef; disabled: boolean; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <textarea className="ptext mono" spellCheck={false} disabled={disabled} aria-label={def.label} value={draft ?? value}
      onChange={(e) => setDraft(e.target.value)} onBlur={() => { if (draft !== null && draft !== value) onCommit(draft); setDraft(null); }} />
  );
}

/**
 * A settings dialog body: page tabs on top (with a count of changed values), collapsible groups, rows.
 * Used by the filament and printer settings dialogs.
 */
export function ParamPages({ params, pages, value, base, modified, onCommit, onReset, nullable, search }: {
  params: ParamDef[]; pages: readonly string[];
  value: (k: string) => Config[string] | undefined; base: (k: string) => Config[string] | undefined;
  modified: (k: string) => boolean; onCommit: (k: string, v: Config[string]) => void; onReset: (k: string) => void;
  nullable?: (k: string) => { inherited: Config[string] | undefined } | undefined;
  search?: string;
}) {
  const [page, setPage] = useState(pages[0]);
  const q = (search ?? '').trim().toLowerCase();
  const cfg: Config = {};
  for (const p of params) { const v = value(p.key) ?? nullable?.(p.key)?.inherited; if (v !== undefined) cfg[p.key] = v; }
  const list = q ? params.filter((p) => `${p.label} ${p.group} ${p.key}`.toLowerCase().includes(q)) : params.filter((p) => p.tab === page);
  const groups = [...new Set(list.map((p) => p.group))];
  return (
    <>
      {!q && (
        <div className="ptabs">
          {pages.map((pg) => {
            const n = params.filter((p) => p.tab === pg && modified(p.key)).length;
            return (
              <button key={pg} className={`ptab ${page === pg ? 'active' : ''}`} onClick={() => setPage(pg)}>
                {pg}{n > 0 && <span className="tab-count" title={`${n} changed value${n > 1 ? 's' : ''}`}>{n}</span>}
              </button>
            );
          })}
        </div>
      )}
      <div className="params">
        {groups.map((g) => (
          <div key={g}>
            <div className="group-title">{g}</div>
            {list.filter((p) => p.group === g).map((p) => (
              <ParamRow key={p.key} def={p} value={value(p.key)} baseValue={base(p.key)} cfg={cfg} modified={modified(p.key)}
                onCommit={(v) => onCommit(p.key, v)} onReset={() => onReset(p.key)} nullable={nullable?.(p.key)} />
            ))}
          </div>
        ))}
        {!list.length && <div className="muted" style={{ padding: 16, textAlign: 'center' }}>No matching settings.</div>}
      </div>
    </>
  );
}
