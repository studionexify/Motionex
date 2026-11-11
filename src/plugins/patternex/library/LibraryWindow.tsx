// Patternex library window (98% of the screen): browse thousands of generated patterns by type,
// edit any of them with sliders, preview it on the chosen face / side / whole body, then apply.
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '../../../state/store';
import { printerById } from '../../../profiles/printers';
import { CATEGORIES, familyById, type Category } from './families';
import { buildPattern, GROUP_KEYS, GROUP_NAMES, libraryCounts, patternSvg, searchLibrary, specOf, type GenSpec, type LibraryEntry } from './catalog';
import { applyToObject, inkActions, SIDES, targetObject, targetSize, type Side, type Target } from './apply';
import { px, changed } from '../ui/PatternexPanel';
import { addPattern, patternInkKey } from '../ui/state';
import { autoChanges } from '../../../profiles/changer';

const PAGE = 120;
const svgUrl = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

// thumbnails are built lazily, a few per frame, and cached by entry key
const thumbCache = new Map<string, string>();
const queue: { key: string; run: () => void }[] = [];
let pumping = false;
function pump() {
  if (pumping) return;
  pumping = true;
  const step = () => {
    const t0 = performance.now();
    while (queue.length && performance.now() - t0 < 12) queue.shift()!.run();
    if (queue.length) requestAnimationFrame(step); else pumping = false;
  };
  requestAnimationFrame(step);
}

function Thumb({ e, on, onPick }: { e: LibraryEntry; on: boolean; onPick: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [src, setSrc] = useState(thumbCache.get(e.key) ?? '');
  useEffect(() => {
    if (src) return;
    const el = ref.current!;
    let job: { key: string; run: () => void } | null = null;
    const io = new IntersectionObserver(([hit]) => {
      if (!hit.isIntersecting || job) return;
      job = { key: e.key, run: () => {
        const pat = buildPattern(specOf(e));
        const url = svgUrl(patternSvg(pat, 40, 40, undefined, 8000));
        thumbCache.set(e.key, url);
        setSrc(url);
      } };
      queue.push(job); pump();
    }, { rootMargin: '300px' });
    io.observe(el);
    return () => { io.disconnect(); if (job) { const i = queue.indexOf(job); if (i >= 0) queue.splice(i, 1); } };
  }, [e.key, src]);
  return (
    <button ref={ref} className={`pxl-thumb ${on ? 'on' : ''}`} onClick={onPick} title={e.name}>
      {src ? <img src={src} alt="" draggable={false} /> : <span className="pxl-ph" />}
      <span className="pxl-name">{px.savedInks[e.key] ? <span className="px-tag pxl-inked">inked</span> : null}{e.name}</span>
    </button>
  );
}

interface InkGuard { dirty(): boolean; save(): void; name: string }

export function LibraryWindow({ onClose: close }: { onClose: () => void }) {
  // unsaved inks: ask to save before leaving the design (switching, closing or applying)
  const guard = useRef<InkGuard | null>(null);
  const [ask, setAsk] = useState<{ then: () => void } | null>(null);
  const request = (then: () => void) => { if (guard.current?.dirty()) setAsk({ then }); else then(); };
  const onClose = () => request(close);
  const [cat, setCat] = useState<Category | 'All'>('All');
  const [q, setQ] = useState('');
  const [groups, setGroups] = useState<number>(0); // 0 = any number of colour groups
  const [limit, setLimit] = useState(PAGE);
  const [entry, setEntry] = useState<LibraryEntry | null>(null);
  const counts = useMemo(() => libraryCounts(), []);
  const list = useMemo(() => searchLibrary(q, cat).filter((e) => !groups || familyById(e.family)!.colors === groups), [q, cat, groups]);
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => setLimit(PAGE), [q, cat, groups]);
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver(([h]) => { if (h.isIntersecting) setLimit((l) => Math.min(list.length, l + PAGE)); }, { rootMargin: '600px' });
    io.observe(el);
    return () => io.disconnect();
  }, [list]);
  useEffect(() => {
    const k = (ev: KeyboardEvent) => { if (ev.key === 'Escape') { if (ask) setAsk(null); else onClose(); } };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  });
  useEffect(() => { if (!entry && list.length) setEntry(list[0]); }, [list, entry]);

  return createPortal(
    <div className="pxl-bg" onMouseDown={(ev) => { if (ev.target === ev.currentTarget) onClose(); }}>
      <div className="pxl-win" role="dialog" aria-label="Pattern library">
        <header className="pxl-head">
          <span className="mx-badge">P</span>
          <div className="pxl-title">Pattern library<span className="mx-muted"> · {counts.All.toLocaleString()} patterns in {CATEGORIES.length} types</span></div>
          <input className="input pxl-search" placeholder="Search: hex, maze, waves, fine, coarse…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
          <button className="icon-btn" aria-label="Close" title="Close (Esc)" onClick={onClose}>✕</button>
        </header>
        <div className="pxl-body">
          <nav className="pxl-cats">
            {(['All', ...CATEGORIES] as const).map((c) => (
              <button key={c} className={`pxl-cat ${cat === c ? 'on' : ''}`} onClick={() => setCat(c)}>{c}<span>{counts[c].toLocaleString()}</span></button>
            ))}
            <div className="mx-label" style={{ marginTop: 12 }}>Colour groups</div>
            {[0, 1, 2, 3].map((n) => (
              <button key={n} className={`pxl-cat ${groups === n ? 'on' : ''}`} onClick={() => setGroups(n)}>{n === 0 ? 'Any' : n === 1 ? '1 ink on base' : `${n} colours`}</button>
            ))}
            <p className="mx-muted" style={{ marginTop: 12 }}>Patterns come uninked. Pick a design, then choose the ink (filament) for each region.</p>
          </nav>
          <section className="pxl-grid-wrap">
            <div className="mx-muted">{list.length.toLocaleString()} result(s)</div>
            <div className="pxl-grid">
              {list.slice(0, limit).map((e) => <Thumb key={e.key} e={e} on={entry?.key === e.key} onPick={() => { if (e.key !== entry?.key) request(() => setEntry(e)); }} />)}
            </div>
            {limit < list.length && <div ref={sentinel} className="pxl-more">Loading more…</div>}
          </section>
          {entry && <Editor key={entry.key} entry={entry} onDone={close} guard={guard} request={request} />}
        </div>
        {ask && (
          <div className="pxl-ask-bg">
            <div className="pxl-ask" role="alertdialog" aria-label="Save inks">
              <b>Save inks for “{guard.current?.name}”?</b>
              <p className="mx-muted">Saved inks come back every time you open this design. If you don't save, the inks you picked are removed.</p>
              <div className="pxl-ask-btns">
                <button className="btn-secondary" onClick={() => setAsk(null)}>Keep editing</button>
                <button className="btn-secondary" onClick={() => { const t = ask.then; setAsk(null); t(); }}>Don't save</button>
                <button className="btn-primary" onClick={() => { guard.current?.save(); const t = ask.then; setAsk(null); t(); }}>Save inks</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

function Editor({ entry, onDone, guard, request }: { entry: LibraryEntry; onDone: () => void; guard: { current: InkGuard | null }; request: (then: () => void) => void }) {
  const onClose = () => request(onDone);
  const fam = familyById(entry.family)!;
  const [spec, setSpec] = useState<GenSpec>(() => specOf(entry));
  const [target, setTarget] = useState<Target>({ kind: 'side', side: 'top' });
  const [fitTarget, setFitTarget] = useState(true);
  const obj = targetObject();
  const filaments = useStore((s) => s.filaments);
  const ams = useStore((s) => autoChanges(printerById(s.printerId).machine));
  /** Ink per group key colour: filament slot index, or -1 = base / not inked. Nothing is inked to start with. */
  const saved = px.savedInks[entry.key];
  const [inks, setInks] = useState<Record<string, number>>(() => ({ ...(saved ?? {}) }));
  const norm = (m: Record<string, number> | undefined) => JSON.stringify(Object.entries(m ?? {}).filter(([, v]) => v >= 0).sort());
  const dirty = norm(inks) !== norm(saved);
  const saveInks = () => {
    if (Object.values(inks).some((v) => v >= 0)) px.savedInks[entry.key] = { ...inks }; else delete px.savedInks[entry.key];
    // the same inks also apply when this pattern is placed again from the panel
    if (px.savedInks[entry.key]) px.savedInks[patternInkKey(pat.id)] = { ...inks }; else delete px.savedInks[patternInkKey(pat.id)];
    changed(false);
  };
  guard.current = { dirty: () => dirty, save: saveInks, name: entry.name };
  const tsize = targetSize(obj, target);
  // the preview uses the size the pattern will have on the target
  const shown: GenSpec = fitTarget && tsize ? { ...spec, width: +tsize.width.toFixed(2), height: +tsize.height.toFixed(2) } : spec;
  const pat = useMemo(() => buildPattern(shown, `${entry.name}`), [JSON.stringify(shown)]);
  const keys = GROUP_KEYS.filter((k) => pat.shapes.some((s) => s.fill_color === k));
  const inkColors = Object.fromEntries(keys.map((k) => [k, (inks[k] ?? -1) >= 0 ? filaments[inks[k]]?.color ?? k : k]));
  const baseColor = filaments[0]?.color;
  const inkedCount = keys.filter((k) => (inks[k] ?? -1) >= 0).length;
  const svg = useMemo(() => svgUrl(patternSvg(pat, shown.width, shown.height, inkedCount && baseColor ? baseColor : undefined, 60_000, inkColors)), [pat, JSON.stringify(inkColors), baseColor, inkedCount]);
  const groups = keys.length;
  const set = (k: string, v: number) => setSpec((s) => ({ ...s, params: { ...s.params, [k]: v } }));
  const apply = () => request(() => doApply());
  const doApply = () => {
    const make = (w: number, h: number) => buildPattern({ ...spec, width: fitTarget ? w : spec.width, height: fitTarget ? h : spec.height }, entry.name);
    if (target.kind === 'face' || !obj) {
      const p = addPattern(px, buildPattern(spec, entry.name));
      px.armed = p.id;
      px.armedInks = { ...inks };
      useStore.getState().set({ tool: 'place_pattern', workspace: 'prepare' });
      changed(false);
    } else {
      applyToObject(px, obj, target, make, (id, p) => inkActions(id, p, inks, ams));
      useStore.getState().set({ workspace: 'prepare' });
      changed(true);
    }
    onDone();
  };
  return (
    <aside className="pxl-editor">
      <div className="pxl-preview">
        <img src={svg} alt="Pattern preview" />
        <Cube svg={svg} target={target} />
      </div>
      <div className="pxl-ed-title"><b>{entry.name}</b><span className="mx-muted"> · {fam.category} · {groups} colour group(s) · {shown.width.toFixed(1)} × {shown.height.toFixed(1)} mm</span></div>
      <div className="pxl-ed-scroll">
        <div className="mx-label">Apply to {obj ? <span className="mx-muted">({obj.name})</span> : <span className="px-warn"> (add a model first)</span>}</div>
        <div className="mx-chips">
          <button className={`btn-secondary btn-small ${target.kind === 'face' ? 'on' : ''}`} onClick={() => setTarget({ kind: 'face' })}>Picked face</button>
          {SIDES.map((s) => <button key={s} className={`btn-secondary btn-small ${target.kind === 'side' && target.side === s ? 'on' : ''}`} onClick={() => setTarget({ kind: 'side', side: s as Side })}>{s}</button>)}
          <button className={`btn-secondary btn-small ${target.kind === 'sides' ? 'on' : ''}`} onClick={() => setTarget({ kind: 'sides' })}>All 4 sides</button>
          <button className={`btn-secondary btn-small ${target.kind === 'wrap' ? 'on' : ''}`} onClick={() => setTarget({ kind: 'wrap' })}>Whole body (wrap)</button>
        </div>
        {target.kind === 'face' && <p className="mx-muted">After Apply, click a face on the model; drag to move it.</p>}
        <label className="mx-field px-check"><input type="checkbox" checked={fitTarget} disabled={target.kind === 'face'} onChange={(e) => setFitTarget(e.target.checked)} />Fit the pattern to the target (keeps cell size, covers the whole area)</label>
        {(!fitTarget || target.kind === 'face') && (
          <div className="mx-two">
            <Slider label="Width (mm)" min={5} max={250} step={1} value={spec.width} onChange={(v) => setSpec((s) => ({ ...s, width: v }))} />
            <Slider label="Height (mm)" min={5} max={250} step={1} value={spec.height} onChange={(v) => setSpec((s) => ({ ...s, height: v }))} />
          </div>
        )}
        <div className="mx-label">Shape</div>
        {fam.params.map((d) => <Slider key={d.key} label={d.label} min={d.min} max={d.max} step={d.step} value={spec.params[d.key] ?? d.def} onChange={(v) => set(d.key, v)} />)}
        {fam.seeded && (
          <div className="px-row"><Slider label="Seed" min={1} max={9999} step={1} value={spec.seed} onChange={(v) => setSpec((s) => ({ ...s, seed: v }))} />
            <button className="btn-secondary btn-small" title="Random seed" onClick={() => setSpec((s) => ({ ...s, seed: 1 + Math.floor(Math.random() * 9999) }))}>🎲</button></div>
        )}
        <div className="mx-label">Inks {inkedCount ? <span className="mx-muted">· {inkedCount} of {keys.length} region(s) inked</span> : <span className="mx-muted">· not inked yet</span>}</div>
        {keys.map((k) => {
          const g = GROUP_KEYS.indexOf(k), cur = inks[k] ?? -1;
          return (
            <div key={k} className="pxl-ink">
              <span className="px-swatch" style={{ background: k }} /><b>{GROUP_NAMES[g]}</b>
              <div className="pxl-ink-opts">
                <button className={`pxl-ink-btn ${cur < 0 ? 'on' : ''}`} title="Base material (no change)" onClick={() => setInks((m) => ({ ...m, [k]: -1 }))}>Base</button>
                {filaments.map((f, i) => (
                  <button key={i} className={`pxl-ink-btn ${cur === i ? 'on' : ''}`} title={`Slot ${i + 1}`} onClick={() => setInks((m) => ({ ...m, [k]: i }))}>
                    <i style={{ background: f.color }} />{i + 1}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
        {filaments.length < 2 && <p className="mx-muted px-warn">Only one filament slot is set up — add slots in the Filament panel to ink regions in other colours.</p>}
        {inkedCount > 0 && inkedCount === keys.length && keys.every((k) => inks[k] === inks[keys[0]]) && <p className="mx-muted">All regions use the same ink, so the pattern prints as one solid colour.</p>}
        <div className="mx-chips"><button className="btn-secondary btn-small" onClick={() => setSpec(specOf(entry))}>Reset shape</button><button className="btn-secondary btn-small" onClick={() => setInks({})}>Clear inks</button>
          <button className="btn-primary btn-small" disabled={!dirty} onClick={saveInks}>{saved && !dirty ? 'Inks saved' : 'Save inks'}</button>
          {saved && <button className="btn-secondary btn-small" onClick={() => { delete px.savedInks[entry.key]; setInks({}); changed(false); }}>Remove saved inks</button>}
        </div>
        {dirty && <p className="mx-muted px-warn">Inks not saved — you'll be asked to save them before leaving this design.</p>}
      </div>
      <footer className="pxl-ed-foot">
        <button className="btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn-primary" disabled={!obj && target.kind !== 'face'} onClick={apply} title={inkedCount ? '' : 'No region is inked yet: the pattern is placed, and you can ink it later in the Patternex panel'}>Apply{inkedCount ? '' : ' (uninked)'}{target.kind === 'face' ? ' — then click a face' : ''}</button>
      </footer>
    </aside>
  );
}

function Slider({ label, min, max, step, value, onChange }: { label: string; min: number; max: number; step: number; value: number; onChange: (v: number) => void }) {
  return (
    <label className="mx-field pxl-slider">
      <span className="px-row"><span style={{ flex: 1 }}>{label}</span>
        <input className="input pxl-num" type="number" min={min} max={max} step={step} value={+value.toFixed(3)} onChange={(e) => { const v = Number(e.target.value); if (Number.isFinite(v)) onChange(Math.max(min, Math.min(max, v))); }} />
      </span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}

/** A turning cube that shows where the pattern goes: one face, four sides, or wrapped round. */
function Cube({ svg, target }: { svg: string; target: Target }) {
  const faces: [string, string][] = [['top', 'rotateX(90deg)'], ['bottom', 'rotateX(-90deg)'], ['front', 'rotateY(0deg)'], ['back', 'rotateY(180deg)'], ['right', 'rotateY(90deg)'], ['left', 'rotateY(-90deg)']];
  const on = (f: string) => target.kind === 'wrap' || (target.kind === 'sides' && f !== 'top' && f !== 'bottom') || (target.kind === 'side' && target.side === f) || (target.kind === 'face' && f === 'top');
  return (
    <div className="pxl-cube-wrap" title="Where it goes">
      <div className="pxl-cube">
        {faces.map(([f, t]) => <div key={f} className={`pxl-face ${on(f) ? 'on' : ''}`} style={{ transform: `${t} translateZ(45px)`, backgroundImage: on(f) ? `url("${svg}")` : undefined }}>{!on(f) && f}</div>)}
      </div>
    </div>
  );
}
