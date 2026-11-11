// Plantex panel: pick a starting design, shape the body (profile, section, twist), add texture layers
// from the Plantex texture library or linked Patternex artwork (emboss / deboss / cut through, with
// reference planes), set drainage and saucer, then put it on the plate.
import { useMemo, useState } from 'react';
import { patternSvg, buildPattern, searchLibrary, specOf } from '../../patternex/library/catalog';
import { textureLayer, uid, type PlantexSpec, type RefPlane, type SectionKind, type TextureKind, type TextureLayer, type TextureMode } from '../model';
import { PRESETS, TEXTURE_LIBRARY, type PresetCategory } from '../presets';
import { KINDS } from '../textures';
import { patternEntry } from '../patternLink';
import { ProfileEditor } from './ProfileEditor';
import { WallMap } from './WallMap';
import { changed, deleteDesign, loadSpec, openStudio, pt, saveDesign, transferToPlate, undoHistory, usePt } from './state';
import { StudioViewer } from './StudioViewer';
import { RenexStudio } from '../../../renex/ui/RenexStudio';
import { plantexRenexSource } from '../renexSource';
import { useStore } from '../../../state/store';
import { FilamentButton } from '../../../ui/studio/Studio';
import { FILAMENTS } from '../../../profiles/filaments';
import { designThumb, designOutline, textureThumb } from './thumbs';
import { Live3D } from '../../../ui/Live3D';
import { UndoRedo } from '../../../ui/studio/UndoRedo';
import { Num as StNum, Seg as StSeg, SideCard, Stat, StudioWindow, ToolGroup, useInStudio } from '../../../ui/studio/Studio';
import { printerById } from '../../../profiles/printers';

/** A card: a collapsible side card in the Studio, a plain card in the dock. */
function PCard({ title, children }: { title: string; children: React.ReactNode }) {
  if (useInStudio()) return <SideCard title={title} id={`pt-${title.split(' (')[0].toLowerCase().replace(/[^a-z]+/g, '-')}`}><div className="st-card-body">{children}</div></SideCard>;
  return <section className="mx-card"><div className="mx-card-title">{title}</div>{children}</section>;
}

const svgUrl = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
const num = (v: string, d: number, min = -Infinity, max = Infinity) => { const n = parseFloat(v); return isFinite(n) ? Math.min(max, Math.max(min, n)) : d; };

function Num({ label, value, set, min = 0, max = 1000, step = 1, unit, hint }: { label: string; value: number; set: (v: number) => void; min?: number; max?: number; step?: number; unit?: string; hint?: string }) {
  return (
    <label className="mx-field" title={hint}>{label}{unit ? ` (${unit})` : ''}
      <input className="input" type="number" min={min} max={max} step={step} value={+value.toFixed(3)} onChange={(e) => { set(num(e.target.value, value, min, max)); changed(); }} />
    </label>
  );
}

function Slider({ label, value, set, min, max, step, unit }: { label: string; value: number; set: (v: number) => void; min: number; max: number; step: number; unit?: string }) {
  return (
    <label className="mx-field">{label}: {+value.toFixed(3)}{unit ?? ''}
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => { set(parseFloat(e.target.value)); changed(); }} />
    </label>
  );
}

function Check({ label, value, set }: { label: string; value: boolean; set: (v: boolean) => void }) {
  return <label className="mx-field px-check"><input type="checkbox" checked={value} onChange={(e) => { set(e.target.checked); changed(); }} />{label}</label>;
}

function Seg<T extends string>({ value, options, set }: { value: T; options: [T, string][]; set: (v: T) => void }) {
  // up to 3 short options stay buttons; longer lists become a dropdown
  if (options.length > 3 || options.some(([, l]) => l.length > 10)) {
    return <select className="select mx-select" value={value} onChange={(e) => { set(e.target.value as T); changed(); }}>{options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>;
  }
  return <div className="seg mx-seg">{options.map(([v, l]) => <button key={v} className={value === v ? 'on' : ''} onClick={() => { set(v); changed(); }}>{l}</button>)}</div>;
}

const SECTIONS: [SectionKind, string][] = [['circle', 'Circle / oval'], ['polygon', 'Polygon'], ['star', 'Star'], ['petal', 'Petal'], ['wave', 'Wave'], ['gear', 'Gear'], ['superellipse', 'Rounded square']];
const MODES: [TextureMode, string][] = [['emboss', 'Emboss'], ['deboss', 'Deboss'], ['cut', 'Cut through']];
const CATS: (PresetCategory | 'All' | 'Mine')[] = ['All', 'Planter', 'Bowl', 'Vase', 'Tall', 'Weave', 'Mine'];

function DesignLibrary() {
  const [cat, setCat] = useState<(typeof CATS)[number]>('All');
  const [q, setQ] = useState('');
  const items = cat === 'Mine'
    ? pt.designs.map((d) => ({ id: d.id, name: d.name, spec: d.spec as Partial<PlantexSpec>, mine: true }))
    : PRESETS.filter((p) => cat === 'All' || p.category === cat).map((p) => ({ id: p.id, name: p.spec.name ?? p.id, spec: p.spec, mine: false }));
  const list = items.filter((i) => i.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <PCard title={`Designs (${PRESETS.length} starting designs${pt.designs.length ? `, ${pt.designs.length} saved` : ''})`}>
      <div className="mx-chips">{CATS.map((c) => <button key={c} className={`mx-chip ${cat === c ? 'on' : ''}`} onClick={() => setCat(c)}>{c === 'Mine' ? 'My designs' : c}</button>)}</div>
      <input className="input" placeholder="Search designs" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="mx-lib-grid" style={{ maxHeight: 300, overflowY: 'auto' }}>
        {list.map((d) => (
          <button key={d.id} className={`mx-lib-card ${pt.spec.name === d.name ? 'on' : ''}`} onClick={() => loadSpec(d.spec)} title={d.name}>
            <img src={designOutline(d.spec, d.id + (d.mine ? JSON.stringify(d.spec).length : ''), 84, useStore.getState().theme === 'dark')} alt="" style={{ width: '100%', aspectRatio: '1', borderRadius: 6 }} />
            <span>{d.name}</span>
            {d.mine && <span className="muted" onClick={(e) => { e.stopPropagation(); deleteDesign(d.id); }} title="Delete">✕ delete</span>}
          </button>
        ))}
        {!list.length && <div className="muted">Nothing here yet{cat === 'Mine' ? ' — save a design below.' : '.'}</div>}
      </div>
    </PCard>
  );
}

function BodyCard() {
  const s = pt.spec;
  const inStudio = useInStudio(); // the Studio shows the profile editor underneath the preview
  const scaleAll = (k: number) => { s.profile.forEach((p) => { p.r = +(p.r * k).toFixed(1); }); changed(); };
  return (
    <PCard title={`Body`}>
      <label className="mx-field">Name<input className="input" value={s.name} onChange={(e) => { s.name = e.target.value; changed(false); }} /></label>
      <Seg value={s.kind} options={[['planter', 'Planter'], ['vase', 'Vase']]} set={(v) => { s.kind = v; }} />
      <Check label="Spiral vase mode (single wall, turns on Spiral vase in the process)" value={s.vaseMode} set={(v) => { s.vaseMode = v; }} />
      {!inStudio && <ProfileEditor />}
      {!inStudio && <div className="muted" style={{ fontSize: 11 }}>Drag points · double-click to add · right-click to remove</div>}
      <div className="mx-two">
        <Num label="Height" unit="mm" value={s.height} set={(v) => { s.height = v; }} min={10} max={400} />
        <Check label="Smooth curve" value={s.smooth} set={(v) => { s.smooth = v; }} />
      </div>
      <div className="mx-two">
        <button className="btn-secondary btn-small" onClick={() => scaleAll(0.9)}>Narrower −10%</button>
        <button className="btn-secondary btn-small" onClick={() => scaleAll(1.1)}>Wider +10%</button>
      </div>
      <details className="px-more"><summary>Profile points</summary>
        {s.profile.map((p, i) => (
          <div className="mx-two" key={i}>
            <Num label={`P${i + 1} height`} unit="%" value={p.z * 100} set={(v) => { p.z = v / 100; s.profile.sort((a, b) => a.z - b.z); }} min={0} max={100} step={0.5} />
            <Num label="Radius" unit="mm" value={p.r} set={(v) => { p.r = v; }} min={3} max={250} step={0.5} />
          </div>
        ))}
      </details>
    </PCard>
  );
}

function SectionCard() {
  const s = pt.spec, c = s.section;
  return (
    <PCard title={`Cross-section & twist`}>
      <select className="input" value={c.kind} onChange={(e) => { c.kind = e.target.value as SectionKind; changed(); }}>{SECTIONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
      <div className="mx-two">
        {c.kind !== 'circle' && c.kind !== 'superellipse' && <Num label="Sides / lobes" value={c.n} set={(v) => { c.n = Math.round(v); }} min={2} max={120} />}
        {['star', 'petal', 'wave', 'gear'].includes(c.kind) && <Num label="Lobe depth" unit="%" value={c.depth * 100} set={(v) => { c.depth = v / 100; }} min={0} max={60} step={0.5} />}
        {['polygon', 'gear'].includes(c.kind) && <Num label="Rounding" unit="%" value={c.round * 100} set={(v) => { c.round = v / 100; }} min={0} max={100} />}
        {c.kind === 'superellipse' && <Num label="Squareness" value={c.exponent} set={(v) => { c.exponent = v; }} min={1} max={20} step={0.5} />}
        <Num label="Oval (width / depth)" value={c.aspect} set={(v) => { c.aspect = v; }} min={0.3} max={3} step={0.05} />
      </div>
      <Check label="Morph to another section at the rim" value={!!c.morphTo} set={(v) => { c.morphTo = v ? { kind: 'circle', n: c.n, depth: c.depth, round: c.round, exponent: c.exponent, aspect: 1 } : undefined; }} />
      {c.morphTo && (
        <div className="mx-two">
          <select className="input" value={c.morphTo.kind} onChange={(e) => { c.morphTo!.kind = e.target.value as SectionKind; changed(); }}>{SECTIONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
          <Num label="Rim sides / lobes" value={c.morphTo.n} set={(v) => { c.morphTo!.n = Math.round(v); }} min={2} max={120} />
          <Num label="Rim lobe depth" unit="%" value={c.morphTo.depth * 100} set={(v) => { c.morphTo!.depth = v / 100; }} min={0} max={60} />
          <Num label="Rim oval" value={c.morphTo.aspect} set={(v) => { c.morphTo!.aspect = v; }} min={0.3} max={3} step={0.05} />
        </div>
      )}
      <div className="mx-two">
        <Num label="Twist" unit="°" value={s.twist} set={(v) => { s.twist = v; }} min={-720} max={720} step={5} />
        <label className="mx-field">Twist curve
          <select className="input" value={s.twistEase} onChange={(e) => { s.twistEase = e.target.value as PlantexSpec['twistEase']; changed(); }}>
            <option value="linear">Even</option><option value="ease">Ease in / out</option><option value="wave">There and back</option>
          </select>
        </label>
      </div>
    </PCard>
  );
}

function PlanterCard() {
  const s = pt.spec, d = s.drain, sa = s.saucer, f = s.feet, w = s.selfWater;
  if (s.vaseMode) return <PCard title="Walls"><div className="muted">Spiral vase mode: the slicer prints one outer wall and a solid bottom (set wall width with the outer wall line width). Turn vase mode off for a walled planter with drain holes and cut-throughs.</div></PCard>;
  return (
    <PCard title={`Walls, drainage & saucer`}>
      <div className="mx-two">
        <Num label="Wall" unit="mm" value={s.wall} set={(v) => { s.wall = v; }} min={0.8} max={20} step={0.2} />
        <Num label="Floor" unit="mm" value={s.floor} set={(v) => { s.floor = v; }} min={0.8} max={30} step={0.2} />
        <Num label="Solid band above floor" unit="mm" value={s.solidBase} set={(v) => { s.solidBase = v; }} min={0} max={100} hint="No cut-throughs here" />
        <Num label="Solid band under rim" unit="mm" value={s.solidRim} set={(v) => { s.solidRim = v; }} min={0} max={100} hint="No cut-throughs here" />
      </div>
      <Slider label="Hole edge rounding (fillet)" value={s.fillet} set={(v) => { s.fillet = v; }} min={0} max={Math.max(0.4, s.wall / 2)} step={0.05} unit=" mm" />
      <Slider label="Rim rounding" value={s.rimRound} set={(v) => { s.rimRound = v; }} min={0} max={Math.max(0.4, s.wall / 2)} step={0.05} unit=" mm" />
      <div className="muted" style={{ fontSize: 11 }}>Rounds every cut-through and drain-hole edge on both faces (up to half the wall: a full round). Live preview updates as you drag.</div>
      <Check label="Drain holes" value={d.enabled} set={(v) => { d.enabled = v; }} />
      {d.enabled && (
        <div className="mx-two">
          <Num label="Centre hole ⌀" unit="mm" value={d.center} set={(v) => { d.center = v; }} min={0} max={80} />
          <Num label="Ring holes" value={d.count} set={(v) => { d.count = Math.round(v); }} min={0} max={24} />
          <Num label="Ring hole ⌀" unit="mm" value={d.diameter} set={(v) => { d.diameter = v; }} min={1} max={40} />
          <Num label="Ring position" unit="%" value={d.ring * 100} set={(v) => { d.ring = v / 100; }} min={10} max={90} />
        </div>
      )}
      <Check label="Feet" value={f.enabled} set={(v) => { f.enabled = v; }} />
      {f.enabled && (
        <div className="mx-two">
          <Num label="Feet (0 = ring)" value={f.count} set={(v) => { f.count = Math.round(v); }} min={0} max={12} />
          <Num label="Height" unit="mm" value={f.height} set={(v) => { f.height = v; }} min={0.5} max={40} step={0.5} />
          <Num label="Size" unit="mm" value={f.size} set={(v) => { f.size = v; }} min={2} max={80} />
          <Num label="Position" unit="% of radius" value={f.ring * 100} set={(v) => { f.ring = v / 100; }} min={10} max={95} />
        </div>
      )}
      <Check label="Self-watering (insert pot over a reservoir)" value={w.enabled} set={(v) => { w.enabled = v; }} />
      {w.enabled && (
        <>
          <div className="mx-two">
            <Num label="Reservoir depth" unit="mm" value={w.reservoir} set={(v) => { w.reservoir = v; }} min={5} max={150} />
            <Num label="Insert gap" unit="mm" value={w.gap} set={(v) => { w.gap = v; }} min={0.3} max={10} step={0.1} />
            <Num label="Insert wall" unit="mm" value={w.wall} set={(v) => { w.wall = v; }} min={0.8} max={6} step={0.1} />
            <Num label="Wick hole ⌀" unit="mm" value={w.wick} set={(v) => { w.wick = v; }} min={0} max={60} />
            <Num label="Floor slots" value={w.slots} set={(v) => { w.slots = Math.round(v); }} min={0} max={24} />
            <Num label="Overflow hole ⌀" unit="mm" value={w.overflow} set={(v) => { w.overflow = v; }} min={0} max={20} step={0.5} hint="In the planter wall at the top of the reservoir" />
          </div>
          <div className="muted" style={{ fontSize: 11 }}>The insert is placed beside the pot. It stands on three legs, has a wick hole and slots, and follows the inner wall.</div>
        </>
      )}
      <Check label="Matching saucer (placed beside the pot)" value={sa.enabled} set={(v) => { sa.enabled = v; }} />
      {sa.enabled && (
        <div className="mx-two">
          <Num label="Gap to pot" unit="mm" value={sa.gap} set={(v) => { sa.gap = v; }} min={0} max={30} step={0.5} />
          <Num label="Rim height" unit="mm" value={sa.height} set={(v) => { sa.height = v; }} min={4} max={60} />
          <Num label="Wall" unit="mm" value={sa.wall} set={(v) => { sa.wall = v; }} min={0.8} max={10} step={0.2} />
          <Num label="Floor" unit="mm" value={sa.floor} set={(v) => { sa.floor = v; }} min={0.8} max={10} step={0.2} />
          <Num label="Rim flare" unit="mm" value={sa.flare} set={(v) => { sa.flare = v; }} min={-10} max={30} step={0.5} />
          <Num label="Drain ribs" value={sa.ribs} set={(v) => { sa.ribs = Math.round(v); }} min={0} max={24} hint="Ribs that lift the pot so water can run off" />
        </div>
      )}
    </PCard>
  );
}

function PlanesEditor({ L }: { L: TextureLayer }) {
  const [n, setN] = useState(4);
  const [amp, setAmp] = useState(10);
  const gen = (blend: 'linear' | 'smooth') => {
    L.planes = Array.from({ length: n + 1 }, (_, k): RefPlane => ({ z: +(k / n).toFixed(4), shift: k % 2 ? amp : 0, scale: 1, depth: 1 }));
    L.planeBlend = blend;
    changed();
  };
  return (
    <details className="px-more" open={L.planes.length > 0}>
      <summary>Reference planes ({L.planes.length})</summary>
      <div className="muted" style={{ fontSize: 11 }}>Planes at heights inside the texture band. Between planes the pattern is turned (shift), thickened (scale) and deepened (depth): linear = zig-zag, smooth = wave.</div>
      <div className="mx-two">
        <Num label="Plane count" value={n} set={(v) => setN(Math.max(1, Math.round(v)))} min={1} max={40} />
        <Num label="Shift" unit="°" value={amp} set={setAmp} min={-180} max={180} step={0.5} />
        <button className="btn-secondary btn-small" onClick={() => gen('linear')}>Make zig-zag</button>
        <button className="btn-secondary btn-small" onClick={() => gen('smooth')}>Make wave</button>
      </div>
      <Seg value={L.planeBlend} options={[['linear', 'Linear blend'], ['smooth', 'Smooth blend']]} set={(v) => { L.planeBlend = v; }} />
      {L.planes.map((p, i) => (
        <div key={i} className="mx-app">
          <div className="mx-app-top" style={{ display: 'flex', justifyContent: 'space-between' }}><b>Plane {i + 1}</b><button className="btn-small btn-secondary" onClick={() => { L.planes.splice(i, 1); changed(); }}>Remove</button></div>
          <div className="mx-two">
            <Num label="Height in band" unit="%" value={p.z * 100} set={(v) => { p.z = v / 100; }} min={0} max={100} step={0.5} />
            <Num label="Shift" unit="°" value={p.shift} set={(v) => { p.shift = v; }} min={-360} max={360} step={0.5} />
            <Num label="Scale" value={p.scale} set={(v) => { p.scale = v; }} min={0} max={4} step={0.05} />
            <Num label="Depth" value={p.depth} set={(v) => { p.depth = v; }} min={0} max={3} step={0.05} />
          </div>
        </div>
      ))}
      <button className="btn-secondary btn-small" onClick={() => { const last = L.planes[L.planes.length - 1]; L.planes.push({ z: last ? Math.min(1, last.z + 0.25) : 0, shift: 0, scale: 1, depth: 1 }); L.planes.sort((a, b) => a.z - b.z); changed(); }}>+ Add plane</button>
    </details>
  );
}

function LayerEditor({ L }: { L: TextureLayer }) {
  const entry = L.kind === 'pattern' && L.patternKey ? patternEntry(L.patternKey) : undefined;
  return (
    <div className="mx-two" style={{ gridTemplateColumns: '1fr' }}>
      <label className="mx-field">Name<input className="input" value={L.name} onChange={(e) => { L.name = e.target.value; changed(false); }} /></label>
      <label className="mx-field">Pattern
        <select className="input" value={L.kind} onChange={(e) => { L.kind = e.target.value as TextureKind; changed(); }}>
          {(Object.keys(KINDS) as TextureKind[]).filter((k) => k !== 'pattern' || L.kind === 'pattern').map((k) => <option key={k} value={k}>{KINDS[k].label}</option>)}
        </select>
      </label>
      {entry && <div className="muted" style={{ fontSize: 11 }}>Linked Patternex artwork: {entry.name}</div>}
      <Seg value={L.mode} options={MODES} set={(v) => { L.mode = v; }} />
      <WallMap L={L} />
      {L.mode !== 'cut' && <><div className="mx-label">Filament</div><FilamentSelect value={L.filament} set={(v) => { L.filament = v; }} allowBody /></>}
      {L.mode === 'cut' && pt.spec.vaseMode && <div className="px-warn" style={{ fontSize: 11 }}>Vase mode: cut-through prints as deboss.</div>}
      <div className="mx-two">
        {L.mode !== 'cut' ? <Num label="Depth" unit="mm" value={L.depth} set={(v) => { L.depth = v; }} min={0} max={30} step={0.1} /> : <Slider label="Hole size" value={1 - L.cutLevel} set={(v) => { L.cutLevel = 1 - v; }} min={0.02} max={0.98} step={0.01} />}
        <Num label="Repeats around" value={L.countU} set={(v) => { L.countU = Math.max(1, Math.round(v)); }} min={1} max={400} />
        <Num label="Repeats up" value={L.countV} set={(v) => { L.countV = v; }} min={0.05} max={200} step={0.25} />
        <Num label="Slant / spiral" unit="°" value={L.rotate} set={(v) => { L.rotate = v; }} min={-80} max={80} step={1} />
        <Num label="Turn" unit="°" value={L.offsetU} set={(v) => { L.offsetU = v; }} min={-360} max={360} step={0.5} />
        <Num label="Move up" unit="repeat" value={L.offsetV} set={(v) => { L.offsetV = v; }} min={-10} max={10} step={0.05} />
        <Num label="Band from" unit="%" value={L.z0 * 100} set={(v) => { L.z0 = Math.min(v / 100, L.z1); }} min={0} max={100} step={0.5} />
        <Num label="Band to" unit="%" value={L.z1 * 100} set={(v) => { L.z1 = Math.max(v / 100, L.z0); }} min={0} max={100} step={0.5} />
        <Num label="Edge fade" unit="mm" value={L.fade} set={(v) => { L.fade = v; }} min={0} max={100} step={0.5} />
        <Num label="Seed" value={L.seed} set={(v) => { L.seed = Math.round(v); }} min={1} max={9999} />
      </div>
      <Slider label="Shape" value={L.shape} set={(v) => { L.shape = v; }} min={0} max={1} step={0.01} />
      <Slider label="Sharpness" value={L.sharp} set={(v) => { L.sharp = v; }} min={0} max={1} step={0.01} />
      <Check label="Invert (swap raised and recessed)" value={L.invert} set={(v) => { L.invert = v; }} />
      <div className="mx-two">
        <Num label="Wave amplitude" unit="°" value={L.waveAmp} set={(v) => { L.waveAmp = v; }} min={0} max={180} step={0.5} />
        <Num label="Wave period" unit="mm" value={L.wavePeriod} set={(v) => { L.wavePeriod = v; }} min={2} max={500} />
      </div>
      <PlanesEditor L={L} />
    </div>
  );
}

function PatternexPicker({ onPick }: { onPick: (key: string, name: string) => void }) {
  const [q, setQ] = useState('');
  const list = useMemo(() => searchLibrary(q, 'All').slice(0, 30), [q]);
  return (
    <div className="mx-lib">
      <input className="input" placeholder="Search Patternex library (linked, not copied)" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="mx-lib-grid" style={{ maxHeight: 240, overflowY: 'auto' }}>
        {list.map((e) => (
          <button key={e.key} className="mx-lib-card" title={e.name} onClick={() => onPick(e.key, e.name)}>
            <img alt="" style={{ width: '100%' }} src={svgUrl(patternSvg(buildPattern(specOf(e)), 40, 40, undefined, 4000))} />
            <span>{e.name}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function TexturesCard() {
  const s = pt.spec;
  const [adding, setAdding] = useState<'' | 'library' | 'patternex'>('');
  const [group, setGroup] = useState('All');
  const groups = ['All', ...new Set(TEXTURE_LIBRARY.map((t) => t.group))];
  const add = (l: Partial<TextureLayer>) => { const L = textureLayer({ ...structuredClone(l), id: uid() }); s.textures.push(L); pt.openLayer = L.id; setAdding(''); changed(); };
  const move = (i: number, d: number) => { const j = i + d; if (j < 0 || j >= s.textures.length) return; [s.textures[i], s.textures[j]] = [s.textures[j], s.textures[i]]; changed(false); };
  return (
    <PCard title={`Wall textures (${s.textures.length})`}>
      {s.textures.map((L, i) => (
        <div key={L.id} className={`mx-app ${L.enabled ? '' : 'off'}`}>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <img src={textureThumb(L)} alt="" width={28} height={28} style={{ borderRadius: 4 }} />
            <button className="btn-small btn-secondary" style={{ flex: 1, textAlign: 'left' }} onClick={() => { pt.openLayer = pt.openLayer === L.id ? null : L.id; changed(false); }}>
              {L.name} · {L.mode}{L.planes.length ? ` · ${L.planes.length} planes` : ''}
            </button>
            <button className={`toggle ${L.enabled ? 'on' : ''}`} aria-label="Layer on" onClick={() => { L.enabled = !L.enabled; changed(); }} />
          </div>
          <div style={{ display: 'flex', gap: 4 }}>
            <button className="btn-small btn-secondary" onClick={() => move(i, -1)}>↑</button>
            <button className="btn-small btn-secondary" onClick={() => move(i, 1)}>↓</button>
            <button className="btn-small btn-secondary" onClick={() => { const c = { ...structuredClone(L), id: uid(), name: `${L.name} copy` }; s.textures.splice(i + 1, 0, c); changed(); }}>Duplicate</button>
            <button className="btn-small btn-secondary" onClick={() => { s.textures.splice(i, 1); changed(); }}>Delete</button>
          </div>
          {pt.openLayer === L.id && <LayerEditor L={L} />}
        </div>
      ))}
      <div className="mx-two">
        <button className={`btn-secondary btn-small ${adding === 'library' ? 'on' : ''}`} onClick={() => setAdding(adding === 'library' ? '' : 'library')}>+ Texture library ({TEXTURE_LIBRARY.length})</button>
        <button className={`btn-secondary btn-small ${adding === 'patternex' ? 'on' : ''}`} onClick={() => setAdding(adding === 'patternex' ? '' : 'patternex')}>+ Patternex artwork</button>
      </div>
      {adding === 'library' && (
        <div className="mx-lib">
          <div className="mx-chips">{groups.map((g) => <button key={g} className={`mx-chip ${group === g ? 'on' : ''}`} onClick={() => setGroup(g)}>{g}</button>)}</div>
          <div className="mx-lib-grid" style={{ maxHeight: 260, overflowY: 'auto' }}>
            {TEXTURE_LIBRARY.filter((t) => group === 'All' || t.group === group).map((t) => (
              <button key={t.id} className="mx-lib-card" onClick={() => add(t.layer)} title={t.name}>
                <img src={textureThumb(t.layer)} alt="" style={{ width: '100%', borderRadius: 4 }} />
                <span>{t.name}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      {adding === 'patternex' && <PatternexPicker onPick={(key, name) => add({ kind: 'pattern', patternKey: key, name, countU: 8, countV: 3, depth: 1.2, sharp: 0.8 })} />}
    </PCard>
  );
}

/** A part's filament: one of the machine's loaded filaments (the picker can also add one to load before printing). */
function FilamentSelect({ value, set, allowBody }: { value: number; set: (v: number) => void; allowBody?: boolean }) {
  return (
    <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
      {allowBody && <button className={`mx-chip ${value < 0 ? 'on' : ''}`} onClick={() => { set(-1); changed(); }}>Same as body</button>}
      <FilamentButton label="Filament" slot={value < 0 ? undefined : value} hex={value < 0 ? useStore.getState().filaments[pt.spec.filaments.body]?.color : undefined} onPick={(k) => { set(k); changed(); }} />
    </div>
  );
}

/** Filament slots used by the design: colour and material editable right here. */
function SlotEditor() {
  const st = useStore();
  const s = pt.spec;
  const used = new Set([s.filaments.body, ...(s.saucer.enabled ? [s.filaments.saucer] : []), ...(s.selfWater.enabled ? [s.filaments.insert] : []), ...s.textures.filter((t) => t.enabled && t.filament >= 0).map((t) => t.filament)]);
  const edit = (k: number, patch: Partial<(typeof st.filaments)[number]>) => { st.set({ filaments: st.filaments.map((f, i) => (i === k ? { ...f, ...patch } : f)) }); st.markDirty(); changed(false); };
  return (
    <>
      <div className="mx-label">Filament slots</div>
      {st.filaments.map((f, k) => (
        <div key={k} style={{ display: 'flex', gap: 6, alignItems: 'center', opacity: used.has(k) ? 1 : 0.6 }}>
          <b style={{ width: 18 }}>{k + 1}</b>
          <input type="color" value={f.color} onChange={(e) => edit(k, { color: e.target.value })} aria-label={`Filament ${k + 1} colour`} style={{ width: 34, height: 26, padding: 0, border: 'none', background: 'none' }} />
          <select className="input" style={{ flex: 1 }} value={f.presetId} onChange={(e) => edit(k, { presetId: e.target.value })} aria-label={`Filament ${k + 1} material`}>
            {FILAMENTS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <span className="muted" style={{ fontSize: 11, width: 34 }}>{used.has(k) ? 'used' : ''}</span>
        </div>
      ))}
      <div className="muted" style={{ fontSize: 11 }}>These are the machine's filaments: changing one here changes what the machine holds.</div>
    </>
  );
}

function FilamentsCard() {
  const s = pt.spec, f = s.filaments;
  const planter = s.kind === 'planter' && !s.vaseMode;
  const coloured = s.textures.filter((t) => t.enabled && t.filament >= 0 && t.filament !== f.body);
  return (
    <PCard title={`Filaments & parts`}>
      <SlotEditor />
      <div className="mx-label">Body</div>
      <FilamentSelect value={f.body} set={(v) => { f.body = Math.max(0, v); }} />
      {planter && s.saucer.enabled && <><div className="mx-label">Saucer</div><FilamentSelect value={f.saucer} set={(v) => { f.saucer = Math.max(0, v); }} /></>}
      {planter && s.selfWater.enabled && <><div className="mx-label">Insert</div><FilamentSelect value={f.insert} set={(v) => { f.insert = Math.max(0, v); }} /></>}
      <div className="muted" style={{ fontSize: 11 }}>
        Texture layers can print in their own filament (open a layer → Filament); depth 0 gives a colour-only zone.
        {coloured.length ? ` ${coloured.length} colour layer(s) on the body.` : ''} On transfer the parts are split and each filament set (colour and material) gets its own plate, auto-arranged.
      </div>
    </PCard>
  );
}

function QualityCard() {
  const s = pt.spec;
  const [saveName, setSaveName] = useState('');
  return (
    <PCard title={`Mesh quality & files`}>
      <div className="mx-two">
        <Num label="Segments around" value={s.around} set={(v) => { s.around = Math.round(v); }} min={48} max={1440} step={4} hint="More = finer texture detail, bigger mesh" />
        <Num label="Row height" unit="mm" value={s.step} set={(v) => { s.step = v; }} min={0.2} max={5} step={0.1} hint="Vertical mesh step" />
      </div>
      <Check label="Full-quality preview (slower; transfer always uses full quality)" value={pt.fullPreview} set={(v) => { pt.fullPreview = v; }} />
      <div className="mx-label">Save to My designs</div>
      <div style={{ display: 'flex', gap: 6 }}>
        <input className="input" style={{ flex: 1 }} placeholder={s.name} value={saveName} onChange={(e) => setSaveName(e.target.value)} />
        <button className="btn-secondary btn-small" onClick={() => { saveDesign(saveName || s.name); setSaveName(''); }}>Save</button>
      </div>
      <div className="mx-two">
        <button className="btn-secondary btn-small" onClick={() => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(s, null, 1)], { type: 'application/json' })); a.download = `${s.name}.plantex.json`; a.click(); }}>Export design</button>
        <label className="btn-secondary btn-small" style={{ textAlign: 'center', cursor: 'pointer' }}>Import design
          <input type="file" accept=".json" style={{ display: 'none' }} onChange={async (e) => { const f = e.target.files?.[0]; if (f) { try { loadSpec(JSON.parse(await f.text())); } catch { pt.warnings = ['Not a Plantex design file.']; changed(false); } } }} />
        </label>
      </div>
    </PCard>
  );
}

/** Plantex Studio on the shared Studio shell: settings cards, live 3D preview, the profile and wall map underneath. */
export function PlantexStudio() {
  usePt();
  const [busy, setBusy] = useState(false);
  const [renex, setRenex] = useState(false);
  const close = () => { if (!renex) openStudio(false); };
  const s = pt.spec;
  const transfer = (asNew: boolean) => {
    setBusy(true);
    setTimeout(() => { try { transferToPlate(asNew); if (!pt.warnings.length) openStudio(false); } finally { setBusy(false); } }, 20);
  };
  const maxR = Math.max(...s.profile.map((p) => p.r));
  const layer = s.textures.find((t) => t.id === pt.openLayer) ?? s.textures.find((t) => t.enabled) ?? s.textures[0];
  const scaleAll = (k: number) => { s.profile.forEach((p) => { p.r = +(p.r * k).toFixed(1); }); changed(); };
  const bed = printerById(useStore((st) => st.printerId)).bed;
  const tooBig = maxR * 2 > Math.min(bed.x, bed.y) || s.height > bed.z;
  const stage = (
    <>
      <Live3D flat={<img alt="Outline of the current design" src={designOutline(s, `big:${JSON.stringify(s)}`, 320, useStore.getState().theme === 'dark')} />}><StudioViewer /></Live3D>
      <div className="st-stats" style={{ top: 52 }}>
        <Stat label="Size" value={`⌀ ${(maxR * 2).toFixed(0)} × ${s.height} mm`} tone={tooBig ? 'warn' : undefined} />
        <Stat label="Texture layers" value={`${s.textures.filter((t) => t.enabled).length} on`} />
        <Stat label="Printer fit" value={tooBig ? 'Too big' : 'Fits'} tone={tooBig ? 'warn' : 'ok'} />
      </div>
    </>
  );
  const editor = (
    <>
      <div className="st-editor-head">
        <span className="st-ttl">Profile</span>
        <ToolGroup label="Type"><StSeg label="Type" value={s.kind} options={[['planter', 'Planter'], ['vase', 'Vase']]} onChange={(v) => { s.kind = v; changed(); }} /></ToolGroup>
        <ToolGroup label="Size">
          <button className="st-btn" style={{ height: 24 }} onClick={() => scaleAll(0.9)} title="Narrower by 10%">−10%</button>
          <button className="st-btn" style={{ height: 24 }} onClick={() => scaleAll(1.1)} title="Wider by 10%">+10%</button>
          <StNum label="Height (mm)" value={s.height} min={10} max={400} onChange={(v) => { s.height = v; changed(); }} /><span className="st-unit">mm tall</span>
        </ToolGroup>
        <ToolGroup label="Curve"><StSeg label="Curve" value={s.smooth ? 'smooth' : 'straight'} options={[['smooth', 'Smooth'], ['straight', 'Straight']]} onChange={(v) => { s.smooth = v === 'smooth'; changed(); }} /></ToolGroup>
        <span style={{ flex: 1 }} />
        {s.textures.length > 0 && (
          <ToolGroup label="Wall map">
            <select className="st-sel" value={layer?.id ?? ''} aria-label="Texture layer" onChange={(e) => { pt.openLayer = e.target.value; changed(false); }}>
              {s.textures.map((t, i) => <option key={t.id} value={t.id}>{i + 1}. {t.name || t.kind}{t.enabled ? '' : ' (off)'}</option>)}
            </select>
          </ToolGroup>
        )}
      </div>
      <div className="st-editor-body" style={{ display: 'grid', gridTemplateColumns: s.textures.length ? 'minmax(0, 0.9fr) minmax(0, 1.4fr)' : '1fr', gap: 10, padding: 10 }}>
        <div style={{ minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <ProfileEditor fill />
          <div className="st-hint" style={{ margin: 0 }}>Drag points to shape the body · double-click the outline to add one · right-click a point to remove it</div>
        </div>
        {layer && <div style={{ minWidth: 0, minHeight: 0, overflow: 'auto' }}><WallMap L={layer} /><div className="st-hint">Wall map of “{layer.name || layer.kind}”: drag the artwork or its band edges.</div></div>}
      </div>
    </>
  );
  return (
    <>
      <StudioWindow name="Plantex" letter="Pt" gradient="linear-gradient(135deg,#65A30D,#047857)" onClose={close} version={s.name} sideWidth={320}
        side={<div className="mx-panel" style={{ display: 'contents' }}>
          {pt.warnings.length > 0 && <SideCard title="Look at this" right={<span className="st-badge warn">{pt.warnings.length}</span>}>{pt.warnings.map((w, i) => <div key={i} className="st-hint" style={{ color: 'var(--ns-warn)' }}>{w}</div>)}</SideCard>}
          <BodyCard /><SectionCard /><TexturesCard /><PlanterCard /><FilamentsCard /><DesignLibrary /><QualityCard />
        </div>}
        rail={<><small>Type</small><span className="st-hint" style={{ margin: 0 }}>{s.kind}</span></>}
        stage={stage} editor={editor} editorHeight={290}
        actions={<>
          <UndoRedo history={undoHistory} />
          <button className="st-btn" title="Photorealistic render of the printed design (Renex)" onClick={() => setRenex(true)}>Render</button>
          {pt.placed.length > 0 && <button className="st-btn" disabled={busy} onClick={() => transfer(true)}>Transfer as new copy</button>}
          <button className="st-btn" disabled={busy} onClick={() => transfer(false)}>{busy ? 'Building parts…' : pt.placed.length ? 'Transfer (replace)' : 'Transfer to plate'}</button>
        </>} />
      {renex && <RenexStudio source="plantex" build={plantexRenexSource} onClose={() => setRenex(false)} />}
    </>
  );
}

/** Dock tab: the main settings at a glance, the studio button, Transfer, and what the last transfer placed. */
export function PlantexPanel() {
  usePt();
  const s = pt.spec;
  const [busy, setBusy] = useState(false);
  const planter = s.kind === 'planter' && !s.vaseMode;
  const maxR = Math.max(...s.profile.map((p) => p.r));
  const transfer = () => { setBusy(true); setTimeout(() => { try { transferToPlate(false); } finally { setBusy(false); } }, 20); };
  return (
    <div className="mx-panel">
      <div className="mx-head">
        <span className="mx-badge">Pt</span>
        <div style={{ flex: 1 }}><div className="mx-title">Plantex</div><div className="mx-sub">Parametric vases and planters</div></div>
      </div>
      <section className="mx-card">
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <img src={designThumb(s, `cur:${JSON.stringify(s)}`, 84)} alt="" style={{ width: 84, borderRadius: 8 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <input className="input" value={s.name} onChange={(e) => { s.name = e.target.value; changed(false); }} aria-label="Design name" style={{ width: '100%' }} />
            <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>⌀ {(maxR * 2).toFixed(0)} × {s.height} mm · {s.textures.filter((t) => t.enabled).length} texture layer(s)</div>
          </div>
        </div>
        <button className="btn-primary" onClick={() => openStudio()}>Open Plantex studio</button>
      </section>
      <section className="mx-card">
        <div className="mx-card-title">Quick settings</div>
        <Seg value={s.kind} options={[['planter', 'Planter'], ['vase', 'Vase']]} set={(v) => { s.kind = v; }} />
        <Check label="Spiral vase mode" value={s.vaseMode} set={(v) => { s.vaseMode = v; }} />
        <div className="mx-two">
          <Num label="Height" unit="mm" value={s.height} set={(v) => { s.height = v; }} min={10} max={400} />
          <Num label="Max diameter" unit="mm" value={+(maxR * 2).toFixed(1)} set={(v) => { const k = v / 2 / maxR; s.profile.forEach((p) => { p.r = +(p.r * k).toFixed(2); }); }} min={10} max={500} hint="Scales the whole profile" />
          {!s.vaseMode && <Num label="Wall" unit="mm" value={s.wall} set={(v) => { s.wall = v; }} min={0.8} max={20} step={0.2} />}
          <Num label="Twist" unit="°" value={s.twist} set={(v) => { s.twist = v; }} min={-720} max={720} step={5} />
        </div>
        {planter && <Slider label="Hole edge rounding" value={s.fillet} set={(v) => { s.fillet = v; }} min={0} max={Math.max(0.4, s.wall / 2)} step={0.05} unit=" mm" />}
        {planter && (
          <div className="mx-two">
            <Check label="Drain holes" value={s.drain.enabled} set={(v) => { s.drain.enabled = v; }} />
            <Check label="Saucer" value={s.saucer.enabled} set={(v) => { s.saucer.enabled = v; }} />
            <Check label="Feet" value={s.feet.enabled} set={(v) => { s.feet.enabled = v; }} />
            <Check label="Self-watering" value={s.selfWater.enabled} set={(v) => { s.selfWater.enabled = v; }} />
          </div>
        )}
        <div className="mx-label">Body filament</div>
        <FilamentSelect value={s.filaments.body} set={(v) => { s.filaments.body = Math.max(0, v); }} />
      </section>
      <section className="mx-card">
        <button className="btn-primary" disabled={busy} onClick={transfer}>{busy ? 'Building parts…' : pt.placed.length ? 'Transfer to plate (replace)' : 'Transfer to plate'}</button>
        <div className="muted" style={{ fontSize: 11 }}>Splits the design into parts; each colour / material set goes to its own plate, auto-arranged.</div>
        {pt.lastTransfer && pt.lastTransfer.split('\n').map((l, i) => <div key={i} style={{ fontSize: 12 }}>{l}</div>)}
        {pt.warnings.map((w, i) => <div key={i} className="px-warn" style={{ fontSize: 11 }}>{w}</div>)}
      </section>
      {pt.studioOpen && <PlantexStudio />}
    </div>
  );
}
