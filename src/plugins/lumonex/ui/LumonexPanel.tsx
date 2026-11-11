// Lumonex panel in Nexspiro's right dock: lamp type and presets, the part stack (every section is
// designed on its own: silhouette handles, cross-section, scale, twist, up to four pattern layers,
// wall, joint, piece count), fitting and bulb preview, wire routing, lamp-type hardware, the printer
// fit and thermal report, and placing the lamp on the plate (assembled preview or print layout).
import { useMemo, useState, type ReactNode } from 'react';
import { SideCard, useInStudio } from '../../../ui/studio/Studio';
import { useStore } from '../../../state/store';
import { printerById } from '../../../profiles/printers';
import { BATTERIES, BOLTS, BULBS, CABLES, HOLDERS, MAGNETS, PIPES, SWITCHES, holderById, materialForPreset, swatch, type MaterialKind } from '../catalog';
import { FilamentButton } from '../../../ui/studio/Studio';
import { JOINTS, defaultJoint, type JointKind } from '../joinery';
import { LAMP_KINDS, WIRE_ROUTES, defaultDesign, section, type LampDesign, type Section, type SectionRole } from '../model';
import { PATTERNS, SECTIONS, SILHOUETTES, handleAt, pattern, type Envelope, type PatternKind, type ShapeSpec } from '../shape';
import { CATALOGUE, PRESETS, catalogueDesign, type Size } from '../presets';
import { piecesFor } from '../build';
import { applyMotionToObjects } from '../../motionex/ui/MotionexPanel';
import { editObjectArtwork } from '../../patternex/ui/PatternexPanel';
import { bedOf, changed, clearPlaced, deleteSaved, lx, openStudio, placeAssembled, placedShadeIds, previewBuild, saveDesign, savedDesigns, setDesign, transferToPlate, useLx } from './state';

// ---------------------------------------------------------------- small controls
function Slider({ label, value, min, max, step = 1, unit, onChange }: { label: string; value: number; min: number; max: number; step?: number; unit?: string; onChange: (v: number) => void }) {
  return (
    <label className="mx-field">
      <span style={{ display: 'flex', justifyContent: 'space-between' }}><span>{label}</span><span>{+value.toFixed(3)}{unit ? ` ${unit}` : ''}</span></span>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
        <input className="input" style={{ width: 64 }} type="number" min={min} max={max} step={step} value={+value.toFixed(3)} onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n)) onChange(n); }} />
      </div>
    </label>
  );
}

function Select<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <label className="mx-field">{label}
      <select className="select" value={value} onChange={(e) => onChange(e.target.value as T)}>
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </label>
  );
}

function Toggle({ label, on, onChange }: { label: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="row" style={{ gap: 8, margin: 0, justifyContent: 'space-between', fontSize: 12 }}>
      <span>{label}</span>
      <button className={`toggle ${on ? 'on' : ''}`} aria-label={label} onClick={() => onChange(!on)} />
    </label>
  );
}

function Card({ title, children, open = true }: { title: string; children: ReactNode; open?: boolean }) {
  // inside a Studio the same content becomes a collapsible side card
  if (useInStudio()) return <SideCard title={title} defaultOpen={open} id={`lx-${title.split(' ·')[0].toLowerCase().replace(/[^a-z]+/g, '-')}`}><div className="st-card-body">{children}</div></SideCard>;
  return (
    <details className="mx-card" open={open}>
      <summary className="mx-card-title" style={{ cursor: 'pointer' }}>{title}</summary>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>{children}</div>
    </details>
  );
}

const d = () => lx.design;
const edit = (f: (x: LampDesign) => void) => { f(lx.design); changed(); };

// ---------------------------------------------------------------- silhouette preview (side view)
export function Profile({ design, selected }: { design: LampDesign; selected: string }) {
  const bed = bedOf();
  const rows = useMemo(() => {
    // assembled z per section, same rules as the builder (approximate for hung shades)
    let cursor = 0;
    const z0 = new Map<string, number>();
    for (const s of design.sections.filter((x) => x.attach === 'stack')) { z0.set(s.id, cursor + s.zOffset); cursor += s.zOffset + s.shape.height; }
    const top = cursor;
    const holder = holderById(design.fitting.holder);
    const ring = design.kind === 'pendant' ? 0 : design.kind === 'wall' ? design.wall.plateH * 0.35 : top;
    for (const s of design.sections.filter((x) => x.attach === 'hung')) z0.set(s.id, ring - s.gallery * s.shape.height + s.zOffset);
    const bulb = BULBS.find((b) => b.id === design.bulb) ?? BULBS[0];
    const bz = holder.mount === 'pad' || holder.mount === 'strip' ? ring : ring + holder.above - (bulb.profile[1]?.[1] ?? 0);
    return { z0, bulb, bz, ring };
  }, [design]);
  const all = design.sections.flatMap((s) => [rows.z0.get(s.id)!, rows.z0.get(s.id)! + s.shape.height]);
  const zmin = Math.min(0, ...all, rows.bz), zmax = Math.max(...all, rows.bz + 60);
  const wmax = Math.max(60, ...design.sections.map((s) => (s.shape.diameter / 2) * Math.max(...s.shape.handles) * Math.max(s.shape.scaleX, s.shape.scaleY) + Math.max(0, ...s.shape.patterns.map((p) => p.depth))));
  const W = 260, Hh = 300, pad = 10;
  const k = Math.min((W / 2 - pad) / wmax, (Hh - 2 * pad) / (zmax - zmin || 1));
  const X = (r: number) => W / 2 + r * k, Y = (z: number) => Hh - pad - (z - zmin) * k;
  return (
    <svg viewBox={`0 0 ${W} ${Hh}`} style={{ width: '100%', background: 'var(--surface-primary)', borderRadius: 8, border: '1px solid var(--border)' }}>
      {Array.from({ length: Math.ceil((zmax - zmin) / bed.z) + 1 }, (_, i) => zmin + i * bed.z).map((z) => (
        <line key={z} x1={0} x2={W} y1={Y(z)} y2={Y(z)} stroke="var(--text-muted)" strokeDasharray="3 4" strokeWidth={0.6} opacity={0.5} />
      ))}
      {design.sections.map((s) => {
        const z0 = rows.z0.get(s.id)!, sh = s.shape, n = 40;
        const pts = Array.from({ length: n + 1 }, (_, i) => { const t = i / n; return [(sh.diameter / 2) * handleAt(sh.handles, t) * sh.scaleX, z0 + t * sh.height]; });
        const path = [...pts.map(([r, z]) => `${X(r)},${Y(z)}`), ...pts.reverse().map(([r, z]) => `${X(-r)},${Y(z)}`)].join(' ');
        const pieces = piecesFor(s, bed, design.margin);
        return (
          <g key={s.id} onClick={() => { lx.selected = s.id; changed(false); }} style={{ cursor: 'pointer' }}>
            <polygon points={path} fill={swatch(s.material, s.color).hex} fillOpacity={s.material === 'PETG Translucent' ? 0.55 : 0.85} stroke={s.id === selected ? 'var(--accent)' : 'var(--border)'} strokeWidth={s.id === selected ? 2 : 1} />
            {Array.from({ length: pieces - 1 }, (_, i) => <line key={i} x1={X(-sh.diameter / 2)} x2={X(sh.diameter / 2)} y1={Y(z0 + ((i + 1) / pieces) * sh.height)} y2={Y(z0 + ((i + 1) / pieces) * sh.height)} stroke="#e53" strokeWidth={1.2} />)}
            {s.attach === 'hung' && <line x1={X(-sh.diameter / 2)} x2={X(sh.diameter / 2)} y1={Y(z0 + s.gallery * sh.height)} y2={Y(z0 + s.gallery * sh.height)} stroke="#333" strokeWidth={2} opacity={0.6} />}
          </g>
        );
      })}
      {design.showBulb && <polygon points={[...rows.bulb.profile.map(([r, z]) => `${X(r)},${Y(rows.bz + z)}`), ...[...rows.bulb.profile].reverse().map(([r, z]) => `${X(-r)},${Y(rows.bz + z)}`)].join(' ')} fill="#fff3c4" stroke="#d9a400" strokeWidth={1} opacity={0.9} />}
    </svg>
  );
}

// ---------------------------------------------------------------- section editor
function ShapeEditor({ s }: { s: Section }) {
  const sh = s.shape;
  const set = (f: (x: ShapeSpec) => void) => { f(sh); changed(); };
  return (
    <>
      <Select label="Silhouette" value={sh.silhouette} options={[...SILHOUETTES.map((x) => [x.id, x.name] as [string, string]), ['custom', 'Custom (edited)']]}
        onChange={(v) => set((x) => { const p = SILHOUETTES.find((q) => q.id === v); if (p) { x.silhouette = v; x.handles = p.handles.slice(); } })} />
      <div className="mx-label">Shape handles (bottom → top)</div>
      {sh.handles.map((h, i) => <Slider key={i} label={`Handle ${i + 1}`} value={h} min={0.05} max={1.5} step={0.01} onChange={(v) => set((x) => { x.handles[i] = v; x.silhouette = 'custom'; })} />)}
      <div className="mx-two">
        <Slider label="Height" unit="mm" value={sh.height} min={10} max={2600} onChange={(v) => set((x) => { x.height = v; })} />
        <Slider label="Diameter" unit="mm" value={sh.diameter} min={10} max={600} onChange={(v) => set((x) => { x.diameter = v; })} />
        <Slider label="Scale X" value={sh.scaleX} min={0.3} max={2} step={0.01} onChange={(v) => set((x) => { x.scaleX = v; })} />
        <Slider label="Scale Y" value={sh.scaleY} min={0.3} max={2} step={0.01} onChange={(v) => set((x) => { x.scaleY = v; })} />
      </div>
      <Select label="Cross-section" value={sh.section} options={SECTIONS} onChange={(v) => set((x) => { x.section = v; })} />
      {sh.section !== 'circle' && (
        <div className="mx-two">
          {(sh.section === 'polygon' || sh.section === 'star' || sh.section === 'petal' || sh.section === 'gear') && <Slider label="Sides / points" value={sh.sides} min={3} max={48} onChange={(v) => set((x) => { x.sides = v; })} />}
          <Slider label="Rounding" value={sh.rounding} min={0} max={1} step={0.01} onChange={(v) => set((x) => { x.rounding = v; })} />
          <Slider label="Depth / flatness" value={sh.sectionDepth} min={0} max={0.9} step={0.01} onChange={(v) => set((x) => { x.sectionDepth = v; })} />
        </div>
      )}
      <div className="mx-two">
        <Slider label="Twist" unit="°" value={sh.twist} min={-360} max={360} onChange={(v) => set((x) => { x.twist = v; })} />
        <Slider label="Lean X" unit="mm" value={sh.leanX} min={-100} max={100} onChange={(v) => set((x) => { x.leanX = v; })} />
        <Slider label="Lean Y" unit="mm" value={sh.leanY} min={-100} max={100} onChange={(v) => set((x) => { x.leanY = v; })} />
        <Slider label="Wall" unit="mm" value={sh.wall} min={0.4} max={20} step={0.1} onChange={(v) => set((x) => { x.wall = v; })} />
        <Slider label="Floor" unit="mm" value={sh.floor} min={0} max={10} step={0.2} onChange={(v) => set((x) => { x.floor = v; })} />
        <Slider label="Roof" unit="mm" value={sh.roof} min={0} max={10} step={0.2} onChange={(v) => set((x) => { x.roof = v; })} />
      </div>
      <Toggle label="Inner wall follows pattern (thin glowing ribs)" on={sh.innerFollows} onChange={(v) => set((x) => { x.innerFollows = v; })} />
      <Toggle label="Spiral vase (solid body, prints in vase mode)" on={sh.vase} onChange={(v) => set((x) => { x.vase = v; })} />
    </>
  );
}

function PatternEditor({ s }: { s: Section }) {
  const sh = s.shape;
  const set = (f: () => void) => { f(); changed(); };
  return (
    <>
      {sh.patterns.map((p, i) => (
        <div key={i} className={`mx-app ${p.enabled ? '' : 'off'}`}>
          <div className="mx-app-top">
            <select className="select" value={p.type} onChange={(e) => set(() => { p.type = e.target.value as PatternKind; })}>
              {PATTERNS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            <button className={`toggle ${p.enabled ? 'on' : ''}`} aria-label="Layer on" onClick={() => set(() => { p.enabled = !p.enabled; })} />
            <button className="btn-secondary btn-small" onClick={() => set(() => { sh.patterns.splice(i, 1); })}>✕</button>
          </div>
          <div className="mx-two">
            <Slider label="Around" value={p.count} min={1} max={200} onChange={(v) => set(() => { p.count = v; })} />
            <Slider label="Up" value={p.rows} min={0.5} max={60} step={0.5} onChange={(v) => set(() => { p.rows = v; })} />
            <Slider label="Depth" unit="mm" value={p.depth} min={-15} max={30} step={0.1} onChange={(v) => set(() => { p.depth = v; })} />
            <Slider label="Twist" unit="turns" value={p.twist} min={-3} max={3} step={0.05} onChange={(v) => set(() => { p.twist = v; })} />
            <Slider label="Sharpness" value={p.sharpness} min={0.2} max={6} step={0.1} onChange={(v) => set(() => { p.sharpness = v; })} />
            <Slider label="Seed" value={p.seed} min={1} max={99} onChange={(v) => set(() => { p.seed = v; })} />
            <Slider label="Band from" value={p.from} min={0} max={1} step={0.01} onChange={(v) => set(() => { p.from = v; })} />
            <Slider label="Band to" value={p.to} min={0} max={1} step={0.01} onChange={(v) => set(() => { p.to = v; })} />
          </div>
          <Select label="Envelope" value={p.envelope} options={[['flat', 'Flat'], ['fade-up', 'Fade in upward'], ['fade-down', 'Fade out upward'], ['middle', 'Strong in the middle'], ['ends', 'Strong at the ends']] as [Envelope, string][]} onChange={(v) => set(() => { p.envelope = v; })} />
        </div>
      ))}
      {sh.patterns.length < 4 && <button className="btn-secondary btn-small mx-add" onClick={() => set(() => { sh.patterns.push(pattern('flutes')); })}>+ Pattern layer</button>}
    </>
  );
}

const PLA_FINISHES: MaterialKind[] = ['PLA+', 'PLA Stone', 'PLA Wood', 'PLA Silk'];

/** The part's filament: one of the machine's loaded filaments (or one marked to load before printing). */
function MaterialPicker({ s }: { s: Section }) {
  const hex = swatch(s.material, s.color).hex;
  return (
    <>
      <div className="mx-label">Filament</div>
      <FilamentButton label={`${s.name} filament`} hex={hex} onPick={(_, f) => { s.material = materialForPreset(f.presetId, s.material); s.color = f.color; changed(); }} />
      {PLA_FINISHES.includes(s.material) && (
        <Select label="PLA finish" value={s.material} options={PLA_FINISHES.map((m) => [m, m] as [MaterialKind, string])} onChange={(v) => { s.material = v; changed(); }} />
      )}
    </>
  );
}

function JointEditor({ s, stacked }: { s: Section; stacked: boolean }) {
  const j = s.joint;
  const set = (f: () => void) => { f(); changed(); };
  const info = JOINTS.find((x) => x.id === j.kind);
  return (
    <>
      <div className="mx-label">{stacked ? 'Joint to the part below, and between pieces' : 'Joint between pieces'}</div>
      <Select label="Joint" value={j.kind} options={JOINTS.map((x) => [x.id, `${x.name} · ${x.lock}`] as [JointKind, string])} onChange={(v) => set(() => { s.joint = defaultJoint({ ...j, kind: v }); })} />
      {info && <p className="mx-muted">{info.note}</p>}
      <div className="mx-two">
        <Slider label="Engagement" unit="mm" value={j.length} min={4} max={40} step={0.5} onChange={(v) => set(() => { j.length = v; })} />
        <Slider label="Clearance" unit="mm" value={j.clearance} min={0} max={0.8} step={0.05} onChange={(v) => set(() => { j.clearance = v; })} />
        {(j.kind === 'thread' || j.kind === 'bayonet' || j.kind === 'cam') && <Slider label={j.kind === 'thread' ? 'Pitch' : 'Pin size'} unit="mm" value={j.pitch} min={1.2} max={6} step={0.1} onChange={(v) => set(() => { j.pitch = v; })} />}
        {['bayonet', 'cam', 'snap-fingers', 'detent', 'magnet', 'spline', 'collet', 'crush-ribs'].includes(j.kind) && <Slider label="Count" value={j.count} min={1} max={8} onChange={(v) => set(() => { j.count = v; })} />}
      </div>
      {['bolt', 'pin', 'insert'].includes(j.kind) && <Select label="Bolt" value={j.bolt} options={Object.keys(BOLTS).map((b) => [b, b] as [keyof typeof BOLTS, string])} onChange={(v) => set(() => { j.bolt = v; })} />}
      {j.kind === 'magnet' && <Select label="Magnet" value={String(j.magnet)} options={MAGNETS.map((m, i) => [String(i), `${m.name} mm`] as [string, string])} onChange={(v) => set(() => { j.magnet = Number(v); })} />}
    </>
  );
}

function SectionCard({ s, index }: { s: Section; index: number }) {
  const bed = bedOf();
  const auto = piecesFor({ ...s, pieces: 0 }, bed, d().margin);
  return (
    <Card title={`Part · ${s.name}`}>
      <div className="mx-two">
        <label className="mx-field">Name<input className="input" value={s.name} onChange={(e) => { s.name = e.target.value; changed(false); }} /></label>
        <Select label="Role" value={s.role} options={(['shade', 'base', 'stem', 'pole', 'body', 'cap', 'deco'] as SectionRole[]).map((r) => [r, r] as [SectionRole, string])} onChange={(v) => { s.role = v; changed(); }} />
      </div>
      <Select label="Attach" value={s.attach} options={[['stack', 'Stacked on the part below (joint)'], ['hung', 'Hung on the lamp holder (gallery)']]} onChange={(v) => { s.attach = v; changed(); }} />
      {s.attach === 'hung' && (
        <div className="mx-two">
          <Slider label="Gallery height" value={s.gallery} min={0} max={1} step={0.01} onChange={(v) => { s.gallery = v; changed(); }} />
          <Slider label="Gallery spokes (0 = ring)" value={s.spokes} min={0} max={8} onChange={(v) => { s.spokes = v; changed(); }} />
        </div>
      )}
      <Slider label="Z offset" unit="mm" value={s.zOffset} min={-300} max={300} onChange={(v) => { s.zOffset = v; changed(); }} />
      <MaterialPicker s={s} />
      <div className="mx-label">Shape</div>
      <ShapeEditor s={s} />
      <div className="mx-label">Patterns</div>
      <PatternEditor s={s} />
      <div className="mx-label">Printing</div>
      <Slider label={`Pieces (0 = auto: ${auto} for ${bed.z} mm height)`} value={s.pieces} min={0} max={20} onChange={(v) => { s.pieces = v; changed(); }} />
      <JointEditor s={s} stacked={index > 0 && s.attach === 'stack'} />
      <Toggle label="Reference only (don't print)" on={!!s.skip} onChange={(v) => { s.skip = v; changed(); }} />
    </Card>
  );
}

// ---------------------------------------------------------------- editor + report columns (Studio) and the dock launcher
export function useReport() {
  const printerId = useStore((s) => s.printerId);
  const design = d();
  return useMemo(() => { try { return previewBuild().report; } catch (e) { return { parts: [], warnings: [`Build failed: ${(e as Error).message}`], notes: [], hardware: [], bulbGap: null, minGap: 0, height: 0, pieces: 0 }; } },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(design), printerId]);
}

/** The design editor. `stack` false leaves out the part stack card (the Studio shows the stack in its editor). */
export function EditorColumn({ stack = true }: { stack?: boolean } = {}) {
  useLx();
  const [size, setSize] = useState<Size>('M');
  const [msg, setMsg] = useState('');
  const design = d();
  const sel = design.sections.find((s) => s.id === lx.selected) ?? design.sections[0];
  const groups = [...new Set(PRESETS.map((p) => p.group))];
  const saved = savedDesigns();
  const moveSection = (i: number, dir: -1 | 1) => edit((x) => { const j = i + dir; if (j < 0 || j >= x.sections.length) return; [x.sections[i], x.sections[j]] = [x.sections[j], x.sections[i]]; });
  const printer = printerById(useStore((s) => s.printerId));
  const holder = holderById(design.fitting.holder);
  return (
    <>
      <Card title="Lamp type">
        <div className="mx-chips">
          {LAMP_KINDS.map((k) => <label key={k.id} title={k.blurb} className={`mx-chip ${design.kind === k.id ? 'on' : ''}`} onClick={() => setDesign(defaultDesign(k.id))}>{k.name}</label>)}
        </div>
        <p className="mx-muted">{LAMP_KINDS.find((k) => k.id === design.kind)?.blurb}</p>
        <label className="mx-field">Preset
          <select className="select" value="" onChange={(e) => { const p = PRESETS.find((x) => x.id === e.target.value); if (!p) return; const c = CATALOGUE.find((x) => x.code === p.id); setDesign(c ? catalogueDesign(c, size) : p.make()); }}>
            <option value="">Choose a preset…</option>
            {groups.map((g) => <optgroup key={g} label={g}>{PRESETS.filter((p) => p.group === g).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</optgroup>)}
          </select>
        </label>
        <div className="seg mx-seg">{(['S', 'M', 'L', 'XL'] as Size[]).map((x) => <button key={x} className={size === x ? 'on' : ''} onClick={() => { setSize(x); const c = CATALOGUE.find((q) => q.code === design.code); if (c) setDesign(catalogueDesign(c, x)); }}>{x}</button>)}</div>
        <label className="mx-field">Design name<input className="input" value={design.name} onChange={(e) => { design.name = e.target.value; changed(false); }} /></label>
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          <button className="btn-secondary btn-small" onClick={() => { saveDesign(); setMsg(`Saved “${design.name}”.`); }}>Save design</button>
          <button className="btn-secondary btn-small" onClick={() => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(design, null, 2)], { type: 'application/json' })); a.download = `${design.name || 'lumonex'}.lumonex.json`; a.click(); }}>Export</button>
          <label className="btn-secondary btn-small" style={{ cursor: 'pointer' }}>Import<input type="file" accept=".json" style={{ display: 'none' }} onChange={async (e) => { const f = e.target.files?.[0]; if (!f) return; try { const x = JSON.parse(await f.text()); if (x.version === 1) setDesign({ ...defaultDesign(x.kind), ...x }); } catch { setMsg('Not a Lumonex design file.'); } }} /></label>
        </div>
        {msg && <p className="mx-muted">{msg}</p>}
        {saved.length > 0 && (
          <div className="mx-chips">
            {saved.map((x) => <label key={x.name} className="mx-chip" onClick={() => setDesign(structuredClone(x))}>{x.name}<span onClick={(e) => { e.stopPropagation(); deleteSaved(x.name); }}> ✕</span></label>)}
          </div>
        )}
      </Card>

      {stack && <Card title={`Part stack · ${design.sections.length} parts`}>
        <Profile design={design} selected={sel?.id ?? ''} />
        <p className="mx-muted">Dashed lines: printer height ({printer.bed.z} mm). Red lines: where a part is cut into pieces. Click a part here or in the 3D view to edit it.</p>
        {design.sections.map((s, i) => (
          <div key={s.id} className="mx-app-top" style={{ gap: 4 }}>
            <button className={`btn-small ${s.id === sel?.id ? 'btn-primary' : 'btn-secondary'}`} style={{ flex: 1, textAlign: 'left' }} onClick={() => { lx.selected = s.id; changed(false); }}>
              <i style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 5, background: swatch(s.material, s.color).hex, marginRight: 6 }} />{s.name} · {s.role} · {s.shape.height.toFixed(0)} mm{s.attach === 'hung' ? ' · hung' : ''}
            </button>
            <button className="btn-secondary btn-small" title="Move up the stack" onClick={() => moveSection(i, 1)}>↑</button>
            <button className="btn-secondary btn-small" title="Move down the stack" onClick={() => moveSection(i, -1)}>↓</button>
            <button className="btn-secondary btn-small" title="Duplicate" onClick={() => edit((x) => { const c = structuredClone(s); c.id = section({ role: s.role }).id; c.name = `${s.name} copy`; x.sections.splice(i + 1, 0, c); })}>⧉</button>
            <button className="btn-secondary btn-small" title="Remove" disabled={design.sections.length < 2} onClick={() => edit((x) => { x.sections.splice(i, 1); })}>✕</button>
          </div>
        ))}
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          {(['body', 'shade', 'stem', 'pole', 'base', 'cap', 'deco'] as SectionRole[]).map((r) => (
            <button key={r} className="btn-secondary btn-small" onClick={() => edit((x) => { const top = x.sections.filter((q) => q.attach === 'stack').pop(); const n = section({ role: r, name: `${r[0].toUpperCase()}${r.slice(1)} ${x.sections.length + 1}`, attach: r === 'shade' ? 'hung' : 'stack' }); if (top) { n.shape.diameter = top.shape.diameter; n.shape.height = Math.min(200, top.shape.height); } x.sections.push(n); lx.selected = n.id; })}>+ {r}</button>
          ))}
        </div>
      </Card>}

      {sel && <SectionCard key={sel.id} s={sel} index={design.sections.indexOf(sel)} />}

      <Card title="Fitting & bulb" open={false}>
        <Select label="Lamp holder" value={design.fitting.holder} options={HOLDERS.map((h) => [h.id, h.name] as [string, string])} onChange={(v) => edit((x) => { x.fitting.holder = v; const h = holderById(v); if (!h.bulbs.includes(x.bulb)) x.bulb = h.bulbs[0]; })} />
        {holder.note && <p className="mx-muted">{holder.note}</p>}
        <Select label="Bulb (preview only, never printed)" value={design.bulb} options={BULBS.map((b) => [b.id, `${holder.bulbs.includes(b.id) ? '' : '⚠ '}${b.name}`] as [string, string])} onChange={(v) => edit((x) => { x.bulb = v; })} />
        <div className="mx-two">
          <Slider label="LED power" unit="W" value={design.watts} min={0.5} max={15} step={0.5} onChange={(v) => edit((x) => { x.watts = v; })} />
          <Slider label="Holder clearance" unit="mm" value={design.fitting.clearance} min={0} max={1} step={0.05} onChange={(v) => edit((x) => { x.fitting.clearance = v; })} />
        </div>
        <Toggle label="Show bulb and holder" on={design.showBulb} onChange={(v) => edit((x) => { x.showBulb = v; })} />
      </Card>

      <Card title="Wire routing & switch" open={false}>
        <Select label="Cable" value={design.wiring.cable} options={CABLES.map((c) => [c.id, c.name] as [string, string])} onChange={(v) => edit((x) => { x.wiring.cable = v; })} />
        <Select label="Route" value={design.wiring.route} options={WIRE_ROUTES.map((r) => [r.id, r.name] as [typeof r.id, string])} onChange={(v) => edit((x) => { x.wiring.route = v; })} />
        <div className="mx-two">
          <Slider label="Exit direction" unit="°" value={design.wiring.exitAngle} min={0} max={359} onChange={(v) => edit((x) => { x.wiring.exitAngle = v; })} />
          <Slider label="Exit height" unit="mm" value={design.wiring.exitHeight} min={2} max={300} onChange={(v) => edit((x) => { x.wiring.exitHeight = v; })} />
        </div>
        <Toggle label="Grommet / strain relief" on={design.wiring.grommet} onChange={(v) => edit((x) => { x.wiring.grommet = v; })} />
        <Select label="Switch" value={design.wiring.switchId} options={SWITCHES.map((s) => [s.id, s.name] as [string, string])} onChange={(v) => edit((x) => { x.wiring.switchId = v; })} />
        <div className="mx-two">
          <Slider label="Switch direction" unit="°" value={design.wiring.switchAngle} min={0} max={359} onChange={(v) => edit((x) => { x.wiring.switchAngle = v; })} />
          <Slider label="Switch height" unit="mm" value={design.wiring.switchHeight} min={4} max={300} onChange={(v) => edit((x) => { x.wiring.switchHeight = v; })} />
        </div>
        {design.kind === 'pendant' && <Slider label="Cord drop" unit="mm" value={design.wiring.drop} min={100} max={3000} step={10} onChange={(v) => edit((x) => { x.wiring.drop = v; })} />}
      </Card>

      <KindCard design={design} />

      <Card title="Hooks, hangers & extras" open={false}>
        <Toggle label="Ceiling hook" on={design.accessories.ceilingHook} onChange={(v) => edit((x) => { x.accessories.ceilingHook = v; })} />
        <Toggle label="Wall hook (cord swag)" on={design.accessories.wallHook} onChange={(v) => edit((x) => { x.accessories.wallHook = v; })} />
        <Toggle label="S-hook" on={design.accessories.sHook} onChange={(v) => edit((x) => { x.accessories.sHook = v; })} />
        <Toggle label="Reducer ring (E27 gallery → E14)" on={design.accessories.reducer} onChange={(v) => edit((x) => { x.accessories.reducer = v; })} />
        <Slider label="Cable clips" value={design.accessories.cableClips} min={0} max={12} onChange={(v) => edit((x) => { x.accessories.cableClips = v; })} />
      </Card>
    </>
  );
}

export function ReportColumn({ onTransfer }: { onTransfer?: () => void }) {
  useLx();
  const printer = printerById(useStore((s) => s.printerId));
  const design = d();
  const report = useReport();
  return (
    <>
      <Card title={`Printer fit · ${printer.vendor} ${printer.model}`}>
        <p className="mx-muted">Bed {printer.bed.x} × {printer.bed.y} × {printer.bed.z} mm — pick another printer in the left sidebar and the lamp re-splits to fit it.</p>
        <div className="mx-two">
          <Slider label="Bed margin" unit="mm" value={design.margin} min={0} max={20} onChange={(v) => edit((x) => { x.margin = v; })} />
          <Select label="Mesh quality" value={design.quality} options={[['draft', 'Draft'], ['normal', 'Normal'], ['fine', 'Fine']]} onChange={(v) => edit((x) => { x.quality = v; })} />
        </div>
        <p className="mx-muted">Lamp height {report.height.toFixed(0)} mm · {report.pieces} printed pieces{report.bulbGap !== null ? ` · bulb gap ${report.bulbGap.toFixed(0)} mm (min ${report.minGap})` : ''}</p>
        {report.parts.map((p) => (
          <div key={p.key} className="mx-check">
            <span className={p.fits ? 'ok' : 'bad'}>{p.fits ? '✓' : '!'}</span>
            <span style={{ width: 'auto', height: 'auto', background: 'none', fontWeight: 400, display: 'inline' }}>{p.name} — {p.size.map((v) => v.toFixed(0)).join(' × ')} mm{p.fits ? '' : ` (too big in ${p.axis.join(', ')})`}</span>
          </div>
        ))}
        {report.warnings.map((w, i) => <p key={i} className="mx-muted px-warn">⚠ {w}</p>)}
      </Card>
      {onTransfer && (
        <Card title="Plate">
          <button className="btn-primary" onClick={onTransfer}>Transfer to plate</button>
          <p className="mx-muted">Takes the lamp apart: each piece goes on the bed in its print orientation, with its own plate(s) and filament slot for every material and colour.</p>
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            <button className="btn-secondary btn-small" onClick={() => placeAssembled()}>Assembled preview on plate</button>
            {lx.placed.length > 0 && <button className="btn-secondary btn-small" onClick={() => clearPlaced()}>Remove placed parts</button>}
          </div>
          <PluginLinks />
        </Card>
      )}
      <Card title="Hardware & notes" open={false}>
        {report.hardware.map((h, i) => <p key={i} className="mx-muted">• {h}</p>)}
        {report.notes.map((n, i) => <p key={`n${i}`} className="mx-muted">{n}</p>)}
      </Card>
    </>
  );
}

/** Dock panel: opens the Studio, and transfers without opening it. */
export function LumonexPanel() {
  useLx();
  const design = d();
  const report = useReport();
  const [msg, setMsg] = useState('');
  return (
    <div className="mx-panel">
      <div className="mx-head">
        <span className="mx-badge">L</span>
        <div style={{ flex: 1 }}><div className="mx-title">Lumonex</div><div className="mx-sub">Parametric lamps: shades, bases, holders, joints, mounts</div></div>
      </div>
      <section className="mx-card">
        <div className="mx-card-title">{design.name}</div>
        <p className="mx-muted">{LAMP_KINDS.find((k) => k.id === design.kind)?.name} · {design.sections.length} parts · {report.pieces} pieces · {report.height.toFixed(0)} mm tall</p>
        <Profile design={design} selected={lx.selected} />
        <button className="btn-primary" onClick={() => openStudio()}>Open Lumonex Studio</button>
        <button className="btn-secondary" onClick={() => { const r = transferToPlate(); setMsg(`${r.objects} pieces on ${r.plates.length} plate(s).`); }}>Transfer to plate</button>
        {report.warnings.length > 0 && <p className="mx-muted px-warn">⚠ {report.warnings.length} warning(s) — open the Studio to review.</p>}
        {msg && <p className="mx-muted">{msg}</p>}
      </section>
    </div>
  );
}

function PluginLinks() {
  const plugins = useStore((s) => s.plugins);
  if (!lx.placed.length) return null;
  const ids = placedShadeIds();
  return (
    <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
      {plugins.includes('motionex') && <button className="btn-secondary btn-small" disabled={!ids.length} onClick={() => applyMotionToObjects(ids)}>Motionex on shades</button>}
      {plugins.includes('patternex') && ids.slice(0, 3).map((id, i) => <button key={id} className="btn-secondary btn-small" onClick={() => editObjectArtwork(id)}>Patternex artwork {ids.length > 1 ? i + 1 : ''}</button>)}
      {!plugins.includes('motionex') && !plugins.includes('patternex') && <p className="mx-muted">Install Motionex or Patternex to add wall motion or artwork to the placed shades.</p>}
    </div>
  );
}

function KindCard({ design }: { design: LampDesign }) {
  switch (design.kind) {
    case 'table': case 'floor': return (
      <Card title="Base" open={false}>
        <Toggle label="Ballast chamber (sand / steel shot, fill plug)" on={design.base.ballast} onChange={(v) => edit((x) => { x.base.ballast = v; const b = x.sections.find((q) => q.role === 'base'); if (v && b && b.shape.floor < 3) b.shape.floor = 3; })} />
        <Slider label="Felt recess under the floor" unit="mm" value={design.base.feltRecess} min={0} max={3} step={0.1} onChange={(v) => edit((x) => { x.base.feltRecess = v; })} />
        <p className="mx-muted">The ballast chamber and felt recess need a floor on the base part (Floor &gt; 0).</p>
        <div className="mx-two">
          <Slider label="Tripod legs (0 = off)" value={design.base.legs} min={0} max={5} onChange={(v) => edit((x) => { x.base.legs = v; })} />
          <Slider label="Leg splay" unit="°" value={design.base.legSplay} min={0} max={40} onChange={(v) => edit((x) => { x.base.legSplay = v; })} />
        </div>
        {design.kind === 'floor' && <p className="mx-muted">Pole height is the pole part's height; it is split automatically to the printer and joined with the pole's joint.</p>}
      </Card>
    );
    case 'wall': return (
      <Card title="Wall plate & arm" open={false}>
        <div className="mx-two">
          <Slider label="Plate width" unit="mm" value={design.wall.plateW} min={40} max={300} onChange={(v) => edit((x) => { x.wall.plateW = v; })} />
          <Slider label="Plate height" unit="mm" value={design.wall.plateH} min={40} max={400} onChange={(v) => edit((x) => { x.wall.plateH = v; })} />
          <Slider label="Plate thickness" unit="mm" value={design.wall.plateT} min={3} max={20} step={0.5} onChange={(v) => edit((x) => { x.wall.plateT = v; })} />
          <Slider label="Corner radius" unit="mm" value={design.wall.plateRadius} min={0} max={100} onChange={(v) => edit((x) => { x.wall.plateRadius = v; })} />
          <Slider label="Arm length" unit="mm" value={design.wall.armLength} min={10} max={400} onChange={(v) => edit((x) => { x.wall.armLength = v; })} />
          <Slider label="Arm angle" unit="°" value={design.wall.armAngle} min={-45} max={60} onChange={(v) => edit((x) => { x.wall.armAngle = v; })} />
          <Slider label="Arm diameter" unit="mm" value={design.wall.armDiameter} min={12} max={60} onChange={(v) => edit((x) => { x.wall.armDiameter = v; })} />
          <Slider label="Keyholes" value={design.wall.keyholes} min={1} max={4} onChange={(v) => edit((x) => { x.wall.keyholes = v; })} />
        </div>
        <Select label="Wall screws" value={design.wall.screw} options={[['M3', 'M3 / 3.5 mm'], ['M4', 'M4 / 4 mm'], ['M5', 'M5 / 5 mm']]} onChange={(v) => edit((x) => { x.wall.screw = v; })} />
      </Card>
    );
    case 'pendant': return (
      <Card title="Canopy & suspension" open={false}>
        <div className="mx-two">
          <Slider label="Canopy diameter" unit="mm" value={design.canopy.diameter} min={50} max={250} onChange={(v) => edit((x) => { x.canopy.diameter = v; })} />
          <Slider label="Canopy height" unit="mm" value={design.canopy.height} min={15} max={80} onChange={(v) => edit((x) => { x.canopy.height = v; })} />
          <Slider label="Cluster (cords)" value={design.canopy.cluster} min={1} max={7} onChange={(v) => edit((x) => { x.canopy.cluster = v; })} />
        </div>
        <Toggle label="Ceiling hook" on={design.canopy.hook} onChange={(v) => edit((x) => { x.canopy.hook = v; })} />
      </Card>
    );
    case 'ceiling': return (
      <Card title="Tension pole" open={false}>
        <div className="mx-two">
          <Slider label="Ceiling height" unit="mm" value={design.pole.ceiling} min={1800} max={4000} step={10} onChange={(v) => edit((x) => { x.pole.ceiling = v; const p = x.sections.find((s) => s.role === 'pole'); const foot = x.sections.find((s) => s.role === 'base'); if (p) p.shape.height = Math.max(300, v - (foot?.shape.height ?? 0) - 27 - x.pole.jackTravel * 0.5 - 14); })} />
          <Slider label="Jack travel" unit="mm" value={design.pole.jackTravel} min={15} max={80} onChange={(v) => edit((x) => { x.pole.jackTravel = v; })} />
          <Slider label="Arms" value={design.pole.arms} min={1} max={4} onChange={(v) => edit((x) => { x.pole.arms = v; })} />
          <Slider label="Arm length" unit="mm" value={design.pole.armLength} min={40} max={400} onChange={(v) => edit((x) => { x.pole.armLength = v; })} />
        </div>
        <p className="mx-muted">Changing the ceiling height resizes the pole part to fit.</p>
      </Card>
    );
    case 'lantern': return (
      <Card title="Battery & handle" open={false}>
        <Select label="Battery" value={design.lantern.battery} options={BATTERIES.map((b) => [b.id, b.name] as [string, string])} onChange={(v) => edit((x) => { x.lantern.battery = v; })} />
        <Toggle label="USB-C charge port cut-out" on={design.lantern.usb} onChange={(v) => edit((x) => { x.lantern.usb = v; })} />
        <Select label="Handle" value={design.lantern.handle} options={[['bail', 'Bail (arched)'], ['loop', 'Top loop'], ['rope', 'Rope hole'], ['none', 'None']]} onChange={(v) => edit((x) => { x.lantern.handle = v; })} />
        <Slider label="Handle size" unit="mm" value={design.lantern.handleSize} min={30} max={200} onChange={(v) => edit((x) => { x.lantern.handleSize = v; })} />
      </Card>
    );
    case 'mount': return (
      <Card title="Pipe / handlebar clamp" open={false}>
        <Select label="Pipe size" value={String(design.mount.pipe)} options={[...PIPES.map((p) => [String(p.d), p.name] as [string, string]), ...(PIPES.some((p) => p.d === design.mount.pipe) ? [] : [[String(design.mount.pipe), `Custom ${design.mount.pipe}`] as [string, string]])]} onChange={(v) => edit((x) => { x.mount.pipe = Number(v); })} />
        <div className="mx-two">
          <Slider label="Pipe Ø (custom)" unit="mm" value={design.mount.pipe} min={8} max={80} step={0.1} onChange={(v) => edit((x) => { x.mount.pipe = v; })} />
          <Slider label="Rubber shim" unit="mm" value={design.mount.shim} min={0} max={3} step={0.1} onChange={(v) => edit((x) => { x.mount.shim = v; })} />
          <Slider label="Clamp width" unit="mm" value={design.mount.clampWidth} min={10} max={50} onChange={(v) => edit((x) => { x.mount.clampWidth = v; })} />
          <Slider label="Clamp wall" unit="mm" value={design.mount.clampWall} min={3} max={12} step={0.5} onChange={(v) => edit((x) => { x.mount.clampWall = v; })} />
          <Slider label="Arm length" unit="mm" value={design.mount.armLength} min={10} max={150} onChange={(v) => edit((x) => { x.mount.armLength = v; })} />
          <Slider label="Tilt" unit="°" value={design.mount.tilt} min={-60} max={60} onChange={(v) => edit((x) => { x.mount.tilt = v; })} />
        </div>
        <Select label="Clamp style" value={design.mount.style} options={[['two-bolt', 'Two-bolt split clamp'], ['hinge', 'Hinged, one bolt'], ['strap', 'Saddle + zip ties / velcro'], ['gopro', 'Split clamp + GoPro-style knuckle']]} onChange={(v) => edit((x) => { x.mount.style = v; })} />
        <Select label="Bolts" value={design.mount.bolt} options={[['M3', 'M3'], ['M4', 'M4'], ['M5', 'M5']]} onChange={(v) => edit((x) => { x.mount.bolt = v; })} />
        <Toggle label="Battery inside the lamp head" on={design.mount.headBattery} onChange={(v) => edit((x) => { x.mount.headBattery = v; })} />
        {design.mount.headBattery && <Select label="Battery" value={design.lantern.battery} options={BATTERIES.map((b) => [b.id, b.name] as [string, string])} onChange={(v) => edit((x) => { x.lantern.battery = v; })} />}
      </Card>
    );
    default: return null;
  }
}
