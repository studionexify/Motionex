// Plugin Studio shell, shared by every generative plugin: settings in stacked cards on the left, a big live
// preview with a floating toolbar, and the plugin's editor underneath. Rules (docs/design/studio-mockups):
// no Apply button, two numbers on one line, tiny labels above tool groups, numbered filament slots everywhere,
// hover previews / click commits in libraries, collapsible side, state always visible.
import { createContext, useContext, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '../../state/store';
import { filamentById } from '../../profiles/filaments';
import { LIBRARY_COLOURS, MATERIALS, type LibraryColour } from './colours';
import { activeKey, machineName, slotForFilament, useHolders } from '../../state/holders';
import './studio.css';

/* ---------- icons */
const P = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
const ICONS: Record<string, ReactNode> = {
  fit: <path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4" />,
  undo: <><path d="M5 4L2 7l3 3" /><path d="M2 7h8a4 4 0 010 8H7" /></>,
  redo: <><path d="M11 4l3 3-3 3" /><path d="M14 7H6a4 4 0 000 8h3" /></>,
  pen: <path d="M3 13l1-4 7-7 3 3-7 7-4 1z" />,
  fill: <><path d="M3 8l5-5 5 5-5 5z" /><path d="M13.5 11c0 1 1 2 1 3a1 1 0 01-2 0c0-1 1-2 1-3z" fill="currentColor" /></>,
  pick: <><path d="M10 2l4 4-1.5 1.5-4-4z" /><path d="M8.5 3.5L3 9v4h4l5.5-5.5" /></>,
  line: <path d="M3 13L13 3" />,
  rect: <rect x="3" y="4" width="10" height="8" rx="1" />,
  mirrorX: <><path d="M8 2v12" strokeDasharray="2 2" /><path d="M6 4L2 12h4zM10 4l4 8h-4z" /></>,
  mirrorY: <><path d="M2 8h12" strokeDasharray="2 2" /><path d="M4 6L12 2v4zM4 10l8 4v-4z" /></>,
  clear: <><path d="M3 4h10M6 4V2.5h4V4M4.5 4l.7 9.5h5.6l.7-9.5" /></>,
  rot: <><path d="M13 8a5 5 0 11-1.5-3.5" /><path d="M12 2v3h-3" /></>,
  collapse: <path d="M10 3L5 8l5 5" />,
  expand: <path d="M6 3l5 5-5 5" />,
  close: <path d="M4 4l8 8M12 4l-8 8" />,
  node: <><path d="M2 12C5 2 11 14 14 4" /><rect x="6.5" y="6.5" width="3" height="3" fill="currentColor" /></>,
  smooth: <path d="M2 10c2-6 4-6 6 0s4 6 6 0" />,
  edit: <path d="M3 13l1-4 7-7 3 3-7 7-4 1z" />,
  plus: <path d="M8 3v10M3 8h10" />,
  search: <><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5L14 14" /></>,
};
export function Icon({ name, size = 14 }: { name: keyof typeof ICONS | string; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 16 16" {...P} aria-hidden>{ICONS[name]}</svg>;
}

/* ---------- window */
export interface StudioProps {
  name: string;
  letter: string;
  gradient: string;
  onClose: () => void;
  /** Cards for the left column. */
  side: ReactNode;
  /** What the collapsed rail keeps (swatches, the active tool). */
  rail?: ReactNode;
  stage: ReactNode;
  editor?: ReactNode;
  editorHeight?: number;
  /** Extra links under the name (Guide, Shortcuts…). */
  links?: { label: string; onClick: () => void }[];
  version?: string;
  /** Overlays above the main column (library, dialogs). */
  overlay?: ReactNode;
  /** Buttons beside Done (Render, Transfer to plate…). */
  actions?: ReactNode;
  /** Width of the settings column (px). */
  sideWidth?: number;
}

/**
 * True inside a Studio's settings column. Plugins whose panels are built from their own card component render
 * those cards as Studio side cards when this is set, so one editor serves both the dock and the Studio.
 */
export const InStudio = createContext(false);
export const useInStudio = () => useContext(InStudio);

const COLLAPSE_KEY = 'nexspiro.studio.collapsed';

export function StudioWindow(p: StudioProps) {
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem(COLLAPSE_KEY) === '1'; } catch { return false; } });
  const [editorH, setEditorH] = useState(p.editorHeight ?? 300);
  const toggle = () => setCollapsed((c) => { try { localStorage.setItem(COLLAPSE_KEY, c ? '0' : '1'); } catch { /* storage off */ } return !c; });
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && !(e.target instanceof HTMLInputElement)) p.onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [p.onClose]); // eslint-disable-line react-hooks/exhaustive-deps
  const drag = (e: React.PointerEvent) => {
    const y0 = e.clientY, h0 = editorH;
    const move = (ev: PointerEvent) => setEditorH(Math.max(160, Math.min(window.innerHeight * 0.65, h0 - (ev.clientY - y0))));
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div className="st-back" role="dialog" aria-label={`${p.name} Studio`}>
      <div className={`st ${collapsed ? 'collapsed' : ''}`} style={{ '--st-editor-h': `${editorH}px`, ...(p.sideWidth && !collapsed ? { gridTemplateColumns: `${p.sideWidth}px minmax(0, 1fr)` } : {}) } as CSSProperties}>
        {collapsed ? (
          <aside className="st-rail" aria-label="Settings (collapsed)">
            <div className="st-logo" style={{ background: p.gradient }}>{p.letter}</div>
            <IconButton icon="expand" title="Show settings" onClick={toggle} />
            {p.rail}
          </aside>
        ) : (
          <aside className="st-side" aria-label="Settings">
            <div className="st-brand">
              <div className="st-brand-row">
                <div className="st-logo" style={{ background: p.gradient }}>{p.letter}</div>
                <div className="st-bname">{p.name}<small>STUDIO</small></div>
                <IconButton icon="collapse" title="Collapse settings (more room for the preview)" onClick={toggle} />
              </div>
              <div className="st-meta">{p.version && <span className="mono">{p.version}</span>}{p.links?.map((l) => <button key={l.label} onClick={l.onClick}>{l.label}</button>)}</div>
            </div>
            <InStudio.Provider value={true}>{p.side}</InStudio.Provider>
          </aside>
        )}
        <div className="st-main">
          <section className="st-stage" aria-label="Preview">
            <div className="st-stage-bg" />
            {p.stage}
            <div className="st-close">{p.actions}<button className="st-btn primary" onClick={p.onClose} title="Back to the model (Esc)">Done</button></div>
          </section>
          {p.editor && (
            <section className="st-editor" aria-label="Editor">
              {p.editor}
              <div className="st-grip" style={{ position: 'absolute', left: '50%', top: 0, transform: 'translateX(-50%)', height: 8, width: 60, cursor: 'ns-resize' }} onPointerDown={drag} title="Drag to resize" />
            </section>
          )}
          {p.overlay}
        </div>
      </div>
    </div>, document.body);
}

/* ---------- side cards */
export function SideCard({ title, right, children, defaultOpen = true, id }: { title: string; right?: ReactNode; children?: ReactNode; defaultOpen?: boolean; id?: string }) {
  const key = id ? `nexspiro.studio.card.${id}` : null;
  const [open, setOpen] = useState(() => { if (!key) return defaultOpen; try { const v = localStorage.getItem(key); return v === null ? defaultOpen : v === '1'; } catch { return defaultOpen; } });
  const toggle = () => setOpen((o) => { if (key) try { localStorage.setItem(key, o ? '0' : '1'); } catch { /* storage off */ } return !o; });
  return (
    <section className={`st-card ${open && children ? '' : 'closed'}`}>
      <header onClick={toggle} role="button" aria-expanded={open}>{title}{right && <span onClick={(e) => e.stopPropagation()} style={{ marginLeft: 'auto' }}>{right}</span>}{children && <span className="st-chev" style={right ? { marginLeft: 6 } : undefined}>▲</span>}</header>
      {open && children}
    </section>
  );
}

export function Row({ label, children, title }: { label?: string; children: ReactNode; title?: string }) {
  return <div className="st-row" title={title}>{label !== undefined && <span className="st-lab">{label}</span>}{children}</div>;
}

/**
 * Number field that updates live: every valid keystroke and arrow step calls onChange (no Apply).
 * `modified` tints it amber (changed from the preset).
 */
export function Num({ value, onChange, min = -Infinity, max = Infinity, step = 1, digits, label, modified, width }: {
  value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number; digits?: number; label: string; modified?: boolean; width?: number;
}) {
  const fmt = (v: number) => (digits === undefined ? String(v) : v.toFixed(digits));
  const [text, setText] = useState(fmt(value));
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setText(fmt(value)); }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  const commit = (v: number) => { const c = Math.max(min, Math.min(max, v)); if (Number.isFinite(c) && c !== value) onChange(c); return c; };
  return (
    <input className={`st-num ${modified ? 'mod' : ''}`} style={width ? { width } : undefined} aria-label={label} title={label} inputMode="decimal" value={text}
      onFocus={(e) => { focused.current = true; e.target.select(); }}
      onBlur={() => { focused.current = false; setText(fmt(value)); }}
      onChange={(e) => { setText(e.target.value); const v = parseFloat(e.target.value); if (Number.isFinite(v) && v >= min && v <= max) onChange(v); }}
      onKeyDown={(e) => {
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault();
          const d = (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1);
          const c = commit(+(value + d).toFixed(6)); setText(fmt(c));
        } else if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
      onWheel={(e) => { if (document.activeElement !== e.currentTarget) return; const c = commit(+(value + (e.deltaY < 0 ? step : -step)).toFixed(6)); setText(fmt(c)); }} />
  );
}

export function Stepper({ value, onChange, min, max, label }: { value: number; onChange: (v: number) => void; min: number; max: number; label: string }) {
  return (
    <span className="st-step" aria-label={label}>
      <button disabled={value <= min} aria-label={`Fewer ${label}`} onClick={() => onChange(value - 1)}>−</button>
      <span className="st-num" style={{ width: 30, display: 'grid', placeItems: 'center' }}>{value}</span>
      <button disabled={value >= max} aria-label={`More ${label}`} onClick={() => onChange(value + 1)}>+</button>
    </span>
  );
}

export function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: [T, string, string?][]; onChange: (v: T) => void; label: string }) {
  return (
    <span className="st-seg" role="group" aria-label={label}>
      {options.map(([v, l, t]) => <button key={v} className={v === value ? 'on' : ''} aria-pressed={v === value} title={t} onClick={() => onChange(v)}>{l}</button>)}
    </span>
  );
}

/* ---------- toolbar pieces */
export function ToolGroup({ label, children }: { label: string; children: ReactNode }) {
  return <div className="st-grp"><small>{label}</small><div>{children}</div></div>;
}
export const VSep = () => <span className="st-vsep" />;
export function IconButton({ icon, title, on, disabled, onClick }: { icon: string; title: string; on?: boolean; disabled?: boolean; onClick: () => void }) {
  return <button className={`st-ib ${on ? 'on' : ''}`} title={title} aria-label={title} aria-pressed={on} disabled={disabled} onClick={onClick}><Icon name={icon} /></button>;
}
export function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: 'ok' | 'warn' }) {
  return <div className={`st-stat ${tone ?? ''}`}><small>{label}</small><b>{value}</b></div>;
}
export function LiveBadge({ busy, text }: { busy?: boolean; text: string }) {
  return <div className="st-live" aria-live="polite"><span className={`st-dot ${busy ? 'busy' : ''}`} />{busy ? 'Updating…' : text}</div>;
}
export function Tabs<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return <div className="st-tabs" role="tablist">{options.map(([v, l]) => <button key={v} role="tab" aria-selected={v === value} className={v === value ? 'on' : ''} onClick={() => onChange(v)}>{l}</button>)}</div>;
}

/* ---------- filaments */
const textOn = (hex: string) => { const n = parseInt(hex.slice(1), 16); const l = 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255); return l > 150 ? '#3f3f46' : '#fff'; };
export const colourName = (hex: string) => LIBRARY_COLOURS.find((c) => c.hex.toLowerCase() === hex.toLowerCase())?.name;

/** A numbered colour chip; slot -1 = the object's base colour (no change). */
export function SlotChip({ slot, color }: { slot: number; color?: string }) {
  if (slot < 0) return <span className="st-chip base" title="Base colour (no change)">∅</span>;
  return <span className="st-chip" style={{ background: color, color: textOn(color ?? '#888888') }}>{slot + 1}</span>;
}

/**
 * The printer's filament slots, numbered like the AMS: pick one (paint colour), change a slot's colour in the
 * library, add or remove slots. Edits the real slots (the main window's Filament card shows the same).
 */
export function FilamentSlots({ active, onPick, onLibrary, min = 1, note }: { active?: number; onPick?: (slot: number) => void; onLibrary: (slot: number) => void; min?: number; note?: ReactNode }) {
  const filaments = useStore((s) => s.filaments);
  const trayOf = useTrayLabel();
  const setCount = (n: number) => {
    const s = useStore.getState();
    if (n > s.filaments.length) {
      const last = s.filaments[s.filaments.length - 1];
      const used = new Set(s.filaments.map((f) => f.color.toLowerCase()));
      const next = LIBRARY_COLOURS.find((c) => !used.has(c.hex.toLowerCase()))?.hex ?? '#888888';
      s.set({ filaments: [...s.filaments, { presetId: last?.presetId ?? 'generic-pla', color: next }], flushMatrix: null });
    } else if (n < s.filaments.length && n >= min) {
      const k = s.filaments.length - 1;
      s.updateObjects((o) => ({ ...o, filament: o.filament === k ? 0 : o.filament }), s.objects.filter((o) => o.filament === k).map((o) => o.id));
      s.set({ filaments: s.filaments.slice(0, n), flushMatrix: null });
    }
    s.markDirty();
  };
  return (
    <>
      <Row label="Count"><Stepper value={filaments.length} min={min} max={16} label="filaments" onChange={setCount} /><span style={{ flex: 1 }} />{note}</Row>
      {filaments.map((f, k) => (
        <div className="st-fil" key={k}>
          <span className="st-idx">{k + 1}</span>
          <button className={`st-sw ${active === k ? 'on' : ''}`} style={{ background: f.color }} title={onPick ? `Paint with filament ${k + 1}` : `Filament ${k + 1}`} aria-label={`Filament ${k + 1}`} onClick={() => (onPick ? onPick(k) : onLibrary(k))} />
          <div className="st-ftxt"><small>{filamentById(f.presetId).name}{trayOf(k) ? ` · ${trayOf(k)}` : ''}</small><b>{colourName(f.color) ?? f.color.toUpperCase()}</b></div>
          {f.planned && <span className="st-badge warn" title="Not loaded in the machine yet">Load first</span>}
          <IconButton icon="edit" title={`Change filament ${k + 1} (library)`} onClick={() => onLibrary(k)} />
        </div>
      ))}
    </>
  );
}

/** Tray / head label of a project slot ("A2"), from the machine's holders. */
export function useTrayLabel() {
  const filaments = useStore((s) => s.filaments);
  const holders = useHolders((h) => h.lists[activeKey()]);
  return (k: number) => { if (filaments[k]?.planned) return ''; const j = filaments.slice(0, k).filter((f) => !f.planned).length; return holders?.[j]?.tray ?? ''; };
}

/**
 * Filament picker for plugin colours: the filaments loaded in the machine first (numbered slots with their tray),
 * then planned ones, then the library of filaments that are not loaded — picking one of those adds a planned slot
 * ("load before printing"). Returns the slot.
 */
export function FilamentPicker({ value, onPick, onClose, title = 'Filament' }: { value?: number; onPick: (slot: number) => void; onClose: () => void; title?: string }) {
  const filaments = useStore((s) => s.filaments);
  const trayOf = useTrayLabel();
  const [lib, setLib] = useState(false);
  const [mat, setMat] = useState('all');
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: PointerEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('pointerdown', down, true); window.addEventListener('keydown', key, true);
    return () => { window.removeEventListener('pointerdown', down, true); window.removeEventListener('keydown', key, true); };
  }, [onClose]);
  const loaded = filaments.map((f, i) => ({ f, i })).filter((x) => !x.f.planned), planned = filaments.map((f, i) => ({ f, i })).filter((x) => x.f.planned);
  const row = ({ f, i }: { f: typeof filaments[number]; i: number }) => (
    <button key={i} className={`st-fpick-row ${value === i ? 'on' : ''}`} onClick={() => { onPick(i); onClose(); }}>
      <span className="st-chip" style={{ background: f.color, color: textOn(f.color) }}>{i + 1}</span>
      <span className="st-ftxt"><small>{filamentById(f.presetId).name}{trayOf(i) ? ` · ${trayOf(i)}` : ''}</small><b>{colourName(f.color) ?? f.color.toUpperCase()}</b></span>
      {f.planned && <span className="st-badge warn">Load first</span>}
    </button>
  );
  const list = LIBRARY_COLOURS.filter((c) => mat === 'all' || c.material === mat);
  return (
    <div ref={ref} className="st-fpick" role="dialog" aria-label={title}>
      <div className="st-fpick-head"><b>{title}</b><span className="st-hint" style={{ margin: 0 }}>loaded in {machineName()}</span></div>
      <div className="st-fpick-list">{loaded.map(row)}</div>
      {planned.length > 0 && <><small className="st-fpick-sub">Not loaded yet</small><div className="st-fpick-list">{planned.map(row)}</div></>}
      {!lib
        ? <button className="st-btn" style={{ margin: '6px 10px 10px' }} onClick={() => setLib(true)}>Use a filament that is not loaded…</button>
        : <>
          <div className="st-fpick-sub" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>Not loaded<span style={{ flex: 1 }} />
            <select className="st-sel" value={mat} onChange={(e) => setMat(e.target.value)} aria-label="Material"><option value="all">Any material</option>{MATERIALS.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select>
          </div>
          <div className="st-fpick-lib">
            {list.map((c) => <button key={c.material + c.name} title={`${c.name} · ${MATERIALS.find((m) => m.id === c.material)?.name}`} style={{ background: c.hex }} onClick={() => { onPick(slotForFilament(c.hex, MATERIALS.find((m) => m.id === c.material)?.presetId)); onClose(); }} />)}
            <label className="st-fpick-custom" title="Any other colour"><input type="color" defaultValue="#888888" onChange={(e) => { onPick(slotForFilament(e.target.value)); onClose(); }} />+</label>
          </div>
          <p className="st-hint" style={{ margin: '0 10px 10px' }}>Adds a slot marked “load before printing”.</p>
        </>}
    </div>
  );
}

/** A filament control for a plugin colour: shows the slot (number, material, colour, tray) or a warning when the
 *  colour is not loaded; opens the FilamentPicker. `hex` for colour-bound designs, `slot` for slot-bound ones. */
export function FilamentButton({ label, hex, slot, onPick }: { label: string; hex?: string; slot?: number; onPick: (slot: number, f: { presetId: string; color: string }) => void }) {
  const filaments = useStore((s) => s.filaments);
  const trayOf = useTrayLabel();
  const [open, setOpen] = useState(false);
  const k = slot ?? (hex ? filaments.findIndex((f) => f.color.toLowerCase() === hex.toLowerCase()) : -1);
  const f = k >= 0 ? filaments[k] : undefined;
  const colour = f?.color ?? hex ?? '#888888';
  return (
    <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
      <button className="st-ffield" onClick={() => setOpen(!open)} aria-label={`${label}: ${f ? `filament ${k + 1}` : 'not loaded'}`} title={f ? undefined : 'This colour is not in the filament list: pick a loaded filament'}>
        <span className="st-chip" style={{ background: colour, color: textOn(colour) }}>{f ? k + 1 : '!'}</span>
        <span className="st-ftxt"><small>{f ? `${filamentById(f.presetId).name}${trayOf(k) ? ` · ${trayOf(k)}` : ''}` : 'Not loaded'}</small><b>{colourName(colour) ?? colour.toUpperCase()}</b></span>
        {(!f || f.planned) && <span className="st-badge warn">{f ? 'Load first' : 'Pick'}</span>}
      </button>
      {open && <FilamentPicker title={label} value={k >= 0 ? k : undefined} onClose={() => setOpen(false)} onPick={(j) => { const x = useStore.getState().filaments[j]; if (x) onPick(j, x); }} />}
    </div>
  );
}

/** FilamentButton in a labelled Studio row. */
export function FilamentField({ label, help, ...p }: { label: string; hex?: string; slot?: number; onPick: (slot: number, f: { presetId: string; color: string }) => void; help?: string }) {
  return <Row label={label} title={help}><FilamentButton label={label} {...p} /></Row>;
}

/** Set one slot's colour (and material). */
export function setSlotColour(slot: number, c: { hex: string; presetId?: string }) {
  const s = useStore.getState();
  if (!s.filaments[slot]) return;
  s.set({ filaments: s.filaments.map((f, i) => (i === slot ? { ...f, color: c.hex, presetId: c.presetId ?? f.presetId } : f)), flushMatrix: null });
  s.markDirty();
}

/**
 * Filament library over the preview: search, material and colour-family filters. Hover a spool to preview it
 * (onHover), click to put it in the slot.
 */
export function FilamentLibrary({ slot, onHover, onClose }: { slot: number; onHover?: (hex: string | null) => void; onClose: () => void }) {
  const current = useStore((s) => s.filaments[slot]);
  const [q, setQ] = useState('');
  const [mat, setMat] = useState<string>('all');
  const [fam, setFam] = useState<string>('all');
  const families = [...new Set(LIBRARY_COLOURS.map((c) => c.family))];
  const list = LIBRARY_COLOURS.filter((c) => (mat === 'all' || c.material === mat) && (fam === 'all' || c.family === fam) && (!q || c.name.toLowerCase().includes(q.toLowerCase())));
  useEffect(() => () => onHover?.(null), []); // eslint-disable-line react-hooks/exhaustive-deps
  const pick = (c: LibraryColour) => { setSlotColour(slot, { hex: c.hex, presetId: MATERIALS.find((m) => m.id === c.material)?.presetId }); onHover?.(null); onClose(); };
  return (
    <div className="st-lib" role="dialog" aria-label="Filament library" onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}>
      <div className="st-lib-head"><b style={{ fontSize: 13 }}>Filament library</b><span className="st-hint" style={{ margin: 0 }}>slot {slot + 1} · now {colourName(current?.color ?? '') ?? current?.color}</span><span style={{ flex: 1 }} /><IconButton icon="close" title="Close" onClick={onClose} /></div>
      <div className="st-lib-tools">
        <input className="st-text" autoFocus placeholder="Search colours" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search colours" />
        <select className="st-sel" value={mat} onChange={(e) => setMat(e.target.value)} aria-label="Material"><option value="all">Any material</option>{MATERIALS.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select>
        <button className="st-btn" onClick={() => { setQ(''); setMat('all'); setFam('all'); }}>Clear</button>
      </div>
      <div className="st-lib-tools"><div className="st-chips">{['all', ...families].map((f) => <button key={f} className={`st-chipbtn ${fam === f ? 'on' : ''}`} onClick={() => setFam(f)}>{f === 'all' ? 'All colours' : f}</button>)}</div><span style={{ flex: 1 }} /><span className="st-hint" style={{ margin: 0 }}>Hover to preview on the model · click to use in slot {slot + 1}</span></div>
      <div className="st-lib-grid" onMouseLeave={() => onHover?.(null)}>
        {list.map((c) => (
          <button key={c.material + c.name} className={`st-spool ${current?.color.toLowerCase() === c.hex.toLowerCase() ? 'on' : ''}`} onMouseEnter={() => onHover?.(c.hex)} onFocus={() => onHover?.(c.hex)} onClick={() => pick(c)}>
            <i style={{ background: c.hex }} />{c.name}<small>{MATERIALS.find((m) => m.id === c.material)?.name}</small>
          </button>
        ))}
        {!list.length && <span className="st-hint">No colour matches.</span>}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 16px 12px' }}>
        <span className="st-hint" style={{ margin: 0 }}>Any other colour:</span>
        <input type="color" value={current?.color ?? '#888888'} aria-label="Custom colour" onInput={(e) => onHover?.((e.target as HTMLInputElement).value)} onChange={(e) => setSlotColour(slot, { hex: e.target.value })} />
      </div>
    </div>
  );
}

/** Paint picker: numbered slots, the base colour as the eraser, add a filament inline. */
export function PaintPicker({ value, onChange, allowBase = true, onAdd }: { value: number; onChange: (slot: number) => void; allowBase?: boolean; onAdd?: () => void }) {
  const filaments = useStore((s) => s.filaments);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('mousedown', off);
    return () => window.removeEventListener('mousedown', off);
  }, [open]);
  const name = (k: number) => (k < 0 ? 'Base colour (no change)' : colourName(filaments[k]?.color ?? '') ?? `Filament ${k + 1}`);
  return (
    <div className="st-paint" ref={ref}>
      <button onClick={() => setOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={open} title="Paint colour (keys 0–9)"><SlotChip slot={value} color={filaments[value]?.color} />{name(value)}<span style={{ marginLeft: 'auto', color: 'var(--ns-text-3)' }}>▾</span></button>
      {open && (
        <div className="st-pop" role="listbox">
          {filaments.map((f, k) => <button key={k} className={k === value ? 'on' : ''} role="option" aria-selected={k === value} onClick={() => { onChange(k); setOpen(false); }}><SlotChip slot={k} color={f.color} />{name(k)}</button>)}
          {allowBase && <button className={value < 0 ? 'on' : ''} role="option" aria-selected={value < 0} onClick={() => { onChange(-1); setOpen(false); }}><SlotChip slot={-1} />Base colour (eraser)</button>}
          {onAdd && <><hr /><button className="add" onClick={() => { onAdd(); setOpen(false); }}>＋ Add filament…</button></>}
        </div>
      )}
    </div>
  );
}
