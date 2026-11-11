// Left column of Flenex Studio: Design (shape, add-ons), Cuts (joints and where they go), Paint, Print.
import { useRef, useState } from 'react';
import * as THREE from 'three';
import { useStore, PRINTERS_VENDORS } from './storeBridge';
import { loadModelFile } from '../../../io/load';
import { ADDONS, RELIEFS, SECTION_KINDS, SPINES, addOn, type AddOn, type AddOnKind, type CreatureDesign } from '../design';
import { JOINTS, defaultJoint, type JointKind, type PinShape } from '../joints';
import { JointPicker } from './JointPicker';
import { FilamentPicker } from '../../../ui/studio/Studio';
import { autoBodyPath, centrelineAt, longestRay, mainAxisPath } from '../place';
import { pathLength, type CutGroup } from '../groups';
import { FAMILIES, PRESETS, PROFILES } from '../presets';
import { SCHEMES, type PaintOp } from '../paint';
import { ORIENTATIONS, type CutOrientation } from '../place';
import { cutFrame, newCut, type Cut } from '../flexi';
import { Card, Select, Slider, Toggle } from './controls';
import { Seg, useInStudio } from '../../../ui/studio/Studio';
import {
  addColour, addCut, addPart, addPaint, autoCutsAgain, baseBvh, built, changed, currentMachine, editAnyCut, editPart, export3mf, freezeCuts, fx, hasImport, importModel, loadPreset, nextCutId, removeAnyCut, removePart, respacePart, schedule,
  sendToPlate, setPaint, setPalette, setPrinter, setTraceStart, traceStart, useFx, coloursUsed, notify,
} from './state';

const d = () => fx.design;
const edit = (f: (x: CreatureDesign) => void) => { f(fx.design); changed(); };

// ---------------------------------------------------------------- design
function Presets() {
  const [fam, setFam] = useState<string>('All');
  const list = PRESETS.filter((p) => fam === 'All' || p.family === fam);
  return (
    <Card title={`Designs (${PRESETS.length})`}>
      <div className="fx-chips">
        {['All', ...FAMILIES].map((f) => <button key={f} className={`btn-small ${fam === f ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setFam(f)}>{f}</button>)}
      </div>
      <div className="fx-presets">
        {list.map((p) => (
          <button key={p.id} className={`fx-preset ${fx.source === 'creature' && fx.presetId === p.id ? 'on' : ''}`} onClick={() => loadPreset(p.id)} title={p.family}>
            <span>{p.name}</span><small>{p.family}</small>
          </button>
        ))}
      </div>
    </Card>
  );
}

function AddOnEditor({ a }: { a: AddOn }) {
  const info = ADDONS.find((x) => x.id === a.kind)!;
  const set = (f: (x: AddOn) => void) => edit(() => f(a));
  const has = (k: string) => (info.fields as string[]).includes(k);
  const lenLabel = a.kind === 'wings' || a.kind === 'fins' ? 'Span' : 'Length';
  return (
    <details className="fx-addon" open={false}>
      <summary><b>{info.name}</b> <small>at {Math.round(a.t * 100)}%</small>
        <button className="btn-small btn-secondary" style={{ float: 'right' }} onClick={(e) => { e.preventDefault(); edit((x) => { x.addons = x.addons.filter((q) => q !== a); }); }}>Remove</button>
      </summary>
      <div className="fx-addon-body">
        <div className="mx-sub">{info.blurb}</div>
        {has('t') && <Slider label="Position (head → tail)" value={a.t} min={0} max={1} step={0.005} onChange={(v) => set((x) => { x.t = v; })} />}
        {has('size') && <Slider label="Size" value={a.size} min={0.2} max={3} step={0.05} onChange={(v) => set((x) => { x.size = v; })} />}
        {has('length') && <Slider label={lenLabel} value={a.length} min={0.3} max={4} step={0.05} onChange={(v) => set((x) => { x.length = v; })} />}
        {has('width') && <Slider label="Width" value={a.width} min={0.3} max={3} step={0.05} onChange={(v) => set((x) => { x.width = v; })} />}
        {has('count') && <Slider label="Count" value={a.count} min={1} max={24} onChange={(v) => set((x) => { x.count = Math.round(v); })} />}
        {has('spread') && <Slider label={a.kind === 'arms' || a.kind === 'frill' ? 'Fan angle' : 'Spread'} value={a.spread} min={0} max={a.kind === 'arms' ? 360 : 1} step={a.kind === 'arms' ? 5 : 0.01} onChange={(v) => set((x) => { x.spread = v; })} />}
        {has('tilt') && <Slider label="Tilt" unit="°" value={a.tilt} min={-180} max={180} onChange={(v) => set((x) => { x.tilt = v; })} />}
        {has('curl') && <Slider label="Curl" value={a.curl} min={0} max={1.5} step={0.02} onChange={(v) => set((x) => { x.curl = v; })} />}
        {has('side') && <Select label="Where" value={a.side} options={[['top', 'On the back'], ['sides', 'On the sides'], ['belly', 'Underneath']]} onChange={(v) => set((x) => { x.side = v; })} />}
      </div>
    </details>
  );
}

function CreatureDesigner() {
  const b = d().body;
  const set = (f: (x: CreatureDesign['body']) => void) => edit((x) => f(x.body));
  const [add, setAdd] = useState<AddOnKind>('eyes');
  return (
    <>
      <Presets />
      <Card title="Name">
        <input className="input" value={d().name} onChange={(e) => { d().name = e.target.value; notify(); }} />
      </Card>
      <Card title="Body">
        <div className="mx-two">
          <Slider label="Length" unit="mm" value={b.length} min={40} max={500} onChange={(v) => set((x) => { x.length = v; })} />
          <Slider label="Thickness" unit="mm" value={b.thickness} min={4} max={40} step={0.5} onChange={(v) => set((x) => { x.thickness = v; })} />
          <Slider label="Height / width" value={b.heightRatio} min={0.4} max={1.6} step={0.01} onChange={(v) => set((x) => { x.heightRatio = v; })} />
          <Slider label="End rounding" value={b.endRound} min={0.15} max={1.5} step={0.05} onChange={(v) => set((x) => { x.endRound = v; })} />
        </div>
        <Select label="Spine shape" value={b.spine.kind} options={SPINES.map((s) => [s.id, s.name])} onChange={(v) => set((x) => { x.spine.kind = v; })} />
        <div className="mx-two">
          <Slider label="Bend" unit="°" value={b.spine.bend} min={0} max={120} onChange={(v) => set((x) => { x.spine.bend = v; })} />
          <Slider label="Waves / turns" value={b.spine.waves} min={0.5} max={5} step={0.1} onChange={(v) => set((x) => { x.spine.waves = v; })} />
          <Slider label="Phase" value={b.spine.phase} min={-3.14} max={3.14} step={0.05} onChange={(v) => set((x) => { x.spine.phase = v; })} />
        </div>
        <Select label="Silhouette preset" value={'custom'} options={[['custom', 'Pick to reset the profile…'], ...Object.entries(PROFILES).map(([k, p]) => [k, p.name] as [string, string])]}
          onChange={(v) => { if (PROFILES[v]) set((x) => { x.profile = PROFILES[v].handles.slice(); }); }} />
        <div className="mx-label">Thickness profile (head → tail)</div>
        {b.profile.map((h, i) => <Slider key={i} label={`Handle ${i + 1}`} value={h} min={0.1} max={1.8} step={0.01} onChange={(v) => set((x) => { x.profile[i] = v; })} />)}
      </Card>
      <Card title="Cross-section" open={false}>
        <Select label="Shape" value={b.section.kind} options={SECTION_KINDS.map((s) => [s.id, s.name])} onChange={(v) => set((x) => { x.section.kind = v; })} />
        <div className="mx-two">
          <Slider label="Roundness" value={b.section.power} min={1} max={6} step={0.1} onChange={(v) => set((x) => { x.section.power = v; })} />
          <Slider label="Flat belly" value={b.section.flat} min={0} max={0.9} step={0.01} hint="Share of the underside flattened so the print sits on the bed" onChange={(v) => set((x) => { x.section.flat = v; })} />
          {b.section.kind === 'star' && <Slider label="Points" value={b.section.sides} min={3} max={12} onChange={(v) => set((x) => { x.section.sides = Math.round(v); })} />}
        </div>
      </Card>
      <Card title="Surface relief" open={false}>
        <Select label="Pattern" value={b.relief.kind} options={RELIEFS.map((s) => [s.id, s.name])} onChange={(v) => set((x) => { x.relief.kind = v; })} />
        <div className="mx-two">
          <Slider label="Depth" value={b.relief.depth} min={0} max={0.5} step={0.01} onChange={(v) => set((x) => { x.relief.depth = v; })} />
          <Slider label="Period" unit="mm" value={b.relief.period} min={2} max={30} step={0.5} onChange={(v) => set((x) => { x.relief.period = v; })} />
          <Slider label="From" value={b.relief.from} min={0} max={1} step={0.01} onChange={(v) => set((x) => { x.relief.from = v; })} />
          <Slider label="To" value={b.relief.to} min={0} max={1} step={0.01} onChange={(v) => set((x) => { x.relief.to = v; })} />
        </div>
      </Card>
      <Card title={`Add-ons (${d().addons.length})`}>
        {d().addons.map((a) => <AddOnEditor key={a.id} a={a} />)}
        <div className="row" style={{ gap: 6 }}>
          <select className="select" value={add} onChange={(e) => setAdd(e.target.value as AddOnKind)} style={{ flex: 1 }}>
            {ADDONS.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          <button className="btn-small btn-primary" onClick={() => edit((x) => { x.addons = [...x.addons, addOn(add)]; })}>Add</button>
        </div>
        <div className="mx-sub">Parts stuck on the body (legs, wings, fins, eyes) stay on one piece; the automatic cuts go around them. Spikes, sails, plates and manes are cut along with the body.</div>
      </Card>
    </>
  );
}

// ---------------------------------------------------------------- import
function ImportDesigner() {
  const rot = (axis: 0 | 1 | 2, q: number) => { fx.importRot = fx.importRot.map((v, i) => (i === axis ? (v + q + 4) % 4 : v)) as [number, number, number]; changed(); };
  return (
    <>
      <Card title="Imported model">
        <div className="mx-sub"><b>{fx.importName}</b></div>
        <div className="mx-label">Turn the model (it rests on the bed after turning)</div>
        <div className="fx-chips">
          {(['X', 'Y', 'Z'] as const).map((a, i) => (
            <span key={a} className="fx-pair"><button className="btn-small btn-secondary" onClick={() => rot(i as 0, -1)}>{a} −90°</button><button className="btn-small btn-secondary" onClick={() => rot(i as 0, 1)}>{a} +90°</button></span>
          ))}
        </div>
        <Slider label="Scale" unit="%" value={Math.round(fx.importScale * 100)} min={10} max={400} onChange={(v) => { fx.importScale = v / 100; changed(); }} />
        <div className="mx-sub">Cuts are placed in the <b>Cuts</b> tab. Cutting changes the model, so turn and scale it first.</div>
      </Card>
    </>
  );
}

export function SourceBar() {
  const input = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState('');
  const onFile = async (f: File | undefined) => {
    if (!f) return;
    try {
      const models = await loadModelFile(f.name, await f.arrayBuffer());
      if (!models.length) throw new Error('No mesh found in the file.');
      await importModel(models[0].name || f.name, models[0].mesh);
      setMsg(models.length > 1 ? `Imported the first of ${models.length} objects.` : '');
    } catch (e) { setMsg((e as Error).message); }
  };
  return (
    <div className="fx-source">
      <div className="fx-chips">
        <button className={`btn-small ${fx.source === 'creature' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => { if (fx.source !== 'creature') loadPreset(fx.presetId); }}>Design a creature</button>
        <button className={`btn-small ${fx.source === 'import' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => input.current?.click()}>{hasImport() ? 'Import another model…' : 'Import a model…'}</button>
        <input ref={input} type="file" accept=".stl,.obj,.3mf" style={{ display: 'none' }} onChange={(e) => { void onFile(e.target.files?.[0]); e.target.value = ''; }} />
      </div>
      {msg && <div className="mx-sub" style={{ color: 'var(--warn, #d98)' }}>{msg}</div>}
    </div>
  );
}

// ---------------------------------------------------------------- cuts
const MOVING = new Set<JointKind>(['ball', 'hinge', 'swivel', 'universal', 'chain']);

function JointEditor({ j, onChange }: { j: Cut['joint']; onChange: (f: (x: Cut['joint']) => void) => void }) {
  const k = j.kind;
  return (
    <>
      <JointPicker value={k} onChange={(v) => onChange((x) => { const d = defaultJoint(v); x.kind = v; x.rom = d.rom; x.neck = d.neck; })} />
      {k !== 'plain' && (
        <div className="mx-two">
          {MOVING.has(k) && <Slider label="Range of motion" unit="°" value={j.rom} min={5} max={50} onChange={(v) => onChange((x) => { x.rom = v; })} />}
          <Slider label="Joint size" value={j.scale} min={0.5} max={1.4} step={0.02} hint="1 = automatic from the thickness at the cut" onChange={(v) => onChange((x) => { x.scale = v; })} />
          {(k === 'ball' || k === 'swivel') && <Slider label="Neck" value={j.neck} min={0.25} max={0.8} step={0.01} onChange={(v) => onChange((x) => { x.neck = v; })} />}
          {(k === 'dowel' || k === 'snap' || k === 'dovetail') && <Slider label="Depth" value={j.reach} min={0.5} max={2.5} step={0.05} onChange={(v) => onChange((x) => { x.reach = v; })} />}
          <Slider label="Clearance (0 = machine)" unit="mm" value={j.clearance} min={0} max={0.6} step={0.01} onChange={(v) => onChange((x) => { x.clearance = v; })} />
        </div>
      )}
      {(k === 'hinge' || k === 'universal') && <Select label="Pin shape" value={j.pin} options={[['round', 'Round'], ['hex', 'Hexagon'], ['teardrop', 'Teardrop (prints sideways)']]} onChange={(v) => onChange((x) => { x.pin = v as PinShape; })} />}
      {k === 'dowel' && <Select label="Pin shape" value={j.pin === 'hex' ? 'hex' : 'round'} options={[['round', 'Round'], ['hex', 'Hexagon']]} onChange={(v) => onChange((x) => { x.pin = v as PinShape; })} />}
    </>
  );
}

/** Change a cut with a plain function, wherever it lives (free cut, or one of a part's cuts). */
const patchCut = (c: Cut, f: (x: Cut) => void) => editAnyCut(c, (e) => {
  const x: Cut = structuredClone(c); f(x);
  e.origin = x.origin; e.normal = x.normal; e.roll = x.roll; e.radius = x.radius; e.enabled = x.enabled; e.name = x.name; e.joint = x.joint;
});

function CutEditor({ c }: { c: Cut }) {
  const nudge = (mm: number) => patchCut(c, (x) => { const n = new THREE.Vector3(...x.normal).normalize(); x.origin = [x.origin[0] + n.x * mm, x.origin[1] + n.y * mm, x.origin[2] + n.z * mm]; });
  const tilt = (axis: 'a' | 'u', deg: number) => patchCut(c, (x) => {
    const M = cutFrame(x.origin, x.normal, x.roll);
    const u = new THREE.Vector3(), a = new THREE.Vector3(), n = new THREE.Vector3(); M.extractBasis(u, a, n);
    const v = n.clone().applyAxisAngle(axis === 'a' ? a : u, (deg * Math.PI) / 180).normalize();
    x.normal = [v.x, v.y, v.z];
  });
  const square = () => {
    const bvh = baseBvh(); if (!bvh || !built) return;
    const r = centrelineAt(bvh, c.origin, longestRay(bvh, c.origin), 4);
    const keep = c.normal; const flip = r.normal[0] * keep[0] + r.normal[1] * keep[1] + r.normal[2] * keep[2] < 0;
    patchCut(c, (x) => { x.origin = r.origin; x.normal = flip ? [-r.normal[0], -r.normal[1], -r.normal[2]] : r.normal; });
  };
  return (
    <div className="fx-cutedit">
      <input className="input" value={c.name} onChange={(e) => patchCut(c, (x) => { x.name = e.target.value; })} />
      <JointEditor j={c.joint} onChange={(f) => patchCut(c, (x) => f(x.joint))} />
      <div className="mx-label">Position</div>
      <div className="fx-chips">{[-5, -1, -0.2, 0.2, 1, 5].map((m) => <button key={m} className="btn-small btn-secondary" onClick={() => nudge(m)}>{m > 0 ? '+' : ''}{m} mm</button>)}</div>
      <div className="fx-chips">
        <button className="btn-small btn-secondary" title="Drag it along the body with the mouse" onClick={() => { fx.tool = 'move'; notify(); }}>Drag on the model</button>
        <button className="btn-small btn-secondary" title="Turn the plane square to the body again" onClick={square}>Square to the body</button>
        <button className="btn-small btn-secondary" title="Swap which side is piece A and piece B" onClick={() => patchCut(c, (x) => { x.normal = [-x.normal[0], -x.normal[1], -x.normal[2]]; })}>Flip direction</button>
      </div>
      <div className="mx-label">Tilt the plane</div>
      <div className="fx-chips">{[-10, -2, 2, 10].map((m) => <button key={`a${m}`} className="btn-small btn-secondary" onClick={() => tilt('a', m)}>↺ {m > 0 ? '+' : ''}{m}°</button>)}{[-10, -2, 2, 10].map((m) => <button key={`u${m}`} className="btn-small btn-secondary" onClick={() => tilt('u', m)}>↻ {m > 0 ? '+' : ''}{m}°</button>)}</div>
      {(c.joint.kind === 'hinge' || c.joint.kind === 'universal' || c.joint.kind === 'dovetail') && <Slider label="Direction around the body" unit="°" value={c.roll} min={-90} max={180} onChange={(v) => patchCut(c, (x) => { x.roll = v; })} />}
      <Slider label="Cut disc radius (0 = automatic)" unit="mm" value={c.radius} min={0} max={80} step={0.5} onChange={(v) => patchCut(c, (x) => { x.radius = v; })} />
      <div className="fx-chips">
        <button className="btn-small btn-secondary" onClick={() => patchCut(c, (x) => { x.enabled = !x.enabled; })}>{c.enabled ? 'Disable' : 'Enable'}</button>
        <button className="btn-small btn-secondary" onClick={() => { const n = newCut(nextCutId(), [...c.origin] as Cut['origin'], [...c.normal] as Cut['normal'], structuredClone(c.joint), c.roll); n.name = `${c.name} copy`; addCut(n); }}>Duplicate</button>
        <button className="btn-small btn-secondary" onClick={() => removeAnyCut(c)}>Delete cut</button>
      </div>
    </div>
  );
}

function Stepper({ value, min = 0, max = 60, onChange }: { value: number; min?: number; max?: number; onChange: (v: number) => void }) {
  return (
    <span className="fx-count">
      <button className="btn-small btn-secondary" onClick={() => onChange(Math.max(min, value - 1))}>−</button>
      <b>{value}</b>
      <button className="btn-small btn-secondary" onClick={() => onChange(Math.min(max, value + 1))}>+</button>
    </span>
  );
}

function PartCard({ g, cuts }: { g: CutGroup; cuts: Cut[] }) {
  const mine = cuts.filter((c) => c.group === g.id);
  const set = (f: (x: CutGroup) => void) => editPart(g.id, f);
  const edited = Object.keys(g.edits).length;
  return (
    <div className={`fx-part ${fx.selectedGroup === g.id ? 'on' : ''}`} onClick={() => { fx.selectedGroup = g.id; notify(); }}>
      <div className="row" style={{ gap: 6, justifyContent: 'space-between' }}>
        <input className="input" style={{ flex: 1 }} value={g.name} onChange={(e) => set((x) => { x.name = e.target.value; })} />
        <button className="btn-small btn-secondary" onClick={() => removePart(g.id)}>Remove</button>
      </div>
      <div className="row" style={{ gap: 8, justifyContent: 'space-between', marginTop: 6 }}>
        <span className="mx-sub">Cuts on this part</span>
        <Stepper value={g.count} min={0} max={60} onChange={(v) => set((x) => { x.count = v; })} />
      </div>
      <Slider label="Where the cuts start" value={g.from} min={0} max={0.95} step={0.005} onChange={(v) => set((x) => { x.from = Math.min(v, x.to - 0.02); })} />
      <Slider label="Where they end" value={g.to} min={0.05} max={1} step={0.005} onChange={(v) => set((x) => { x.to = Math.max(v, x.from + 0.02); })} />
      <Select label="Spacing" value={g.spacing} options={[['even', 'Even'], ['thickness', 'Follow the thickness']]} onChange={(v) => set((x) => { x.spacing = v; })} />
      <JointPicker label="Cut type for this part" value={g.joint.kind} onChange={(k) => set((x) => { x.joint = { ...defaultJoint(k), clearance: x.joint.clearance }; })} />
      {(g.joint.kind === 'hinge') && <Toggle label="Alternate hinge direction" on={g.alternate} onChange={(v) => set((x) => { x.alternate = v; })} />}
      <div className="mx-sub">{mine.length} cut{mine.length === 1 ? '' : 's'}{edited ? ` · ${edited} edited by hand` : ''}. Cuts you edit keep their changes when the count changes.</div>
      <div className="fx-chips" style={{ marginTop: 4 }}>
        <button className="btn-small btn-secondary" disabled={!edited} onClick={() => respacePart(g.id)}>Re-space all</button>
      </div>
    </div>
  );
}

function CutsTab() {
  const seg = d().segments;
  const setSeg = (f: (s: typeof seg) => void) => edit((x) => f(x.segments));
  const auto = fx.source === 'creature' && fx.cutsMode === 'auto';
  const reports = built?.flexi.reports ?? [];
  const cuts = built?.cuts ?? (auto ? [] : fx.manualCuts);
  const sel = cuts.find((c) => c.id === fx.selectedCut);
  const bodyCuts = cuts.filter((c) => !/Arm \d/.test(c.name)).length;
  const hasArms = d().addons.some((a) => a.kind === 'arms');
  const along = (axis: 0 | 1 | 2, n: number) => {
    if (!built) return;
    const m = built.base.vertices; const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < m.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], m[i + k]); hi[k] = Math.max(hi[k], m[i + k]); }
    const out: Cut[] = []; let id = +nextCutId();
    for (let i = 0; i < n; i++) {
      const t = 0.12 + (0.76 * (i + 0.5)) / n;
      const o: [number, number, number] = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2]; o[axis] = lo[axis] + (hi[axis] - lo[axis]) * t;
      const nrm: [number, number, number] = [0, 0, 0]; nrm[axis] = 1;
      const c = newCut(String(id++), o, nrm, { ...defaultJoint(fx.placeKind) }); c.name = `Cut ${c.id}`;
      out.push(c);
    }
    fx.manualCuts = [...fx.manualCuts, ...out]; fx.cutsMode = 'manual'; schedule();
  };
  const wholeBody = () => { const bvh = baseBvh(); if (!built || !bvh) return; const path = autoBodyPath(bvh, built.base); addPart(path.length > 3 ? path : mainAxisPath(built.base), 'Body', Math.max(4, Math.round(pathLength(path) / 16))); };
  return (
    <>
      {fx.source === 'creature' && (
        <Card title={auto ? 'Automatic cuts' : 'Cuts (edited by hand)'}>
          {auto ? (
            <>
              <div className="row" style={{ gap: 8, justifyContent: 'space-between' }}>
                <span className="mx-sub">Cuts on the body</span>
                <Stepper value={bodyCuts} min={1} max={40} onChange={(v) => setSeg((s) => { s.mode = 'even'; s.count = v; })} />
              </div>
              <Select label="Spacing" value={seg.mode} options={[['scaled', 'Follow the thickness (best look)'], ['even', 'Even, fixed count'], ['length', 'Fixed segment length']]} onChange={(v) => setSeg((s) => { s.mode = v; if (v === 'even') s.count = Math.max(1, bodyCuts); })} />
              {seg.mode === 'length' && <Slider label="Segment length" unit="mm" value={seg.length} min={5} max={60} step={0.5} onChange={(v) => setSeg((s) => { s.length = v; })} />}
              {seg.mode === 'scaled' && <Slider label="Segment length ÷ thickness" value={seg.ratio} min={1.4} max={5} step={0.05} hint="Smaller gives more, shorter segments" onChange={(v) => setSeg((s) => { s.ratio = v; })} />}
              <div className="mx-two">
                <Slider label="Start (head → tail)" value={seg.from} min={0} max={0.95} step={0.005} onChange={(v) => setSeg((s) => { s.from = Math.min(v, s.to - 0.02); })} />
                <Slider label="End" value={seg.to} min={0.05} max={1} step={0.005} onChange={(v) => setSeg((s) => { s.to = Math.max(v, s.from + 0.02); })} />
              </div>
              {hasArms && (
                <div className="row" style={{ gap: 8, justifyContent: 'space-between' }}>
                  <span className="mx-sub">Cuts on each arm (0 = automatic)</span>
                  <Stepper value={seg.armCuts} min={0} max={20} onChange={(v) => setSeg((s) => { s.armCuts = v; })} />
                </div>
              )}
              <JointEditor j={seg.joint} onChange={(f) => setSeg((s) => f(s.joint))} />
              {seg.joint.kind === 'hinge' && <Toggle label="Alternate hinge direction" on={seg.alternate} onChange={(v) => setSeg((s) => { s.alternate = v; })} />}
              <button className="btn-secondary" onClick={freezeCuts}>Edit the cuts by hand…</button>
            </>
          ) : (
            <button className="btn-secondary" onClick={autoCutsAgain}>Back to automatic cuts</button>
          )}
        </Card>
      )}
      {(fx.source === 'import' || !auto) && (
        <Card title="Add cuts">
          <JointPicker label="Cut type to add" value={fx.placeKind} onChange={(k) => { fx.placeKind = k; notify(); }} />
          <Select label="Cut direction" value={fx.orientation} options={ORIENTATIONS.map((o) => [o.id, o.name])} onChange={(v) => { fx.orientation = v as CutOrientation; notify(); }} />
          <div className="mx-sub">{fx.orientation === 'centreline' ? 'The plane turns to stay square to the body as you move, even on a wavy snake.' : fx.orientation === 'local' ? 'Uses the direction of the surface right around the cursor.' : 'Fixed direction.'}</div>
          <div className="fx-chips">
            <button className={`btn-small ${fx.tool === 'place' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => { fx.tool = fx.tool === 'place' ? 'orbit' : 'place'; notify(); }}>{fx.tool === 'place' ? 'Placing: press, slide, release' : 'Place a cut on the model'}</button>
            <button className={`btn-small ${fx.tool === 'move' ? 'btn-primary' : 'btn-secondary'}`} disabled={!fx.selectedCut} onClick={() => { fx.tool = fx.tool === 'move' ? 'orbit' : 'move'; notify(); }}>Move the selected cut</button>
          </div>
        </Card>
      )}
      {(fx.source === 'import' || !auto) && (
        <Card title={`Parts (${fx.groups.length}): a number of cuts per body part`}>
          <div className="mx-sub">Define a part (the body, a tail, a leg, a tentacle), choose how many cuts it gets, and they are spaced along it square to the body. Add, remove or edit single cuts afterwards.</div>
          <div className="fx-chips">
            <button className={`btn-small ${fx.tool === 'trace' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => { fx.tool = fx.tool === 'trace' ? 'orbit' : 'trace'; setTraceStart(null); }}>{fx.tool === 'trace' ? (traceStart ? 'Click the other end…' : 'Click one end…') : 'Add a part (click both ends)'}</button>
            <button className="btn-small btn-secondary" disabled={!built} onClick={wholeBody}>Whole model as one part</button>
          </div>
          {fx.groups.map((g) => <PartCard key={g.id} g={g} cuts={cuts} />)}
          <div className="mx-label">Or add evenly spaced straight cuts</div>
          <div className="fx-chips">{(['X', 'Y', 'Z'] as const).map((a, i) => [4, 8].map((n) => <button key={a + n} className="btn-small btn-secondary" onClick={() => along(i as 0, n)}>{n} across {a}</button>))}</div>
        </Card>
      )}
      <Card title={`Cuts (${cuts.length})`}>
        {!cuts.length && <div className="mx-sub">{fx.source === 'import' ? 'No cuts yet. Add a part, or place a cut on the model.' : 'This design has no cuts: widen the start / end range or lower the segment ratio.'}</div>}
        <div className="fx-cutlist">
          {cuts.map((c) => {
            const r = reports.find((x) => x.id === c.id);
            return (
              <button key={c.id} className={`fx-cut ${fx.selectedCut === c.id ? 'on' : ''} ${r && !r.ok ? 'bad' : r?.warnings.length ? 'warn' : ''}`} onClick={() => { fx.selectedCut = c.id; notify(); }}>
                <span>{c.name}</span><small>{JOINTS.find((j) => j.id === c.joint.kind)?.name ?? c.joint.kind}{c.enabled ? '' : ' · off'}{r?.info?.fellBack ? ' → ball (too thin)' : ''}{r ? (r.ok ? (r.warnings.length ? ' · ⚠' : ' · ✓') : ' · ✕') : ''}</small>
              </button>
            );
          })}
        </div>
        {sel && !auto && <CutEditor c={sel} />}
        {sel && auto && <div className="mx-sub">Automatic cuts follow the settings above. Choose “Edit the cuts by hand” to move, change or delete single cuts.</div>}
      </Card>
    </>
  );
}

// ---------------------------------------------------------------- paint
function PaintTab() {
  const [pick, setPick] = useState<number | null>(null);
  const filaments = useStore((s) => s.filaments);
  const mac = currentMachine();
  const used = coloursUsed();
  const tools: [typeof fx.tool, string, string][] = [['orbit', 'Orbit', 'Just look around'], ['brush', 'Brush', 'Paint with a round brush'], ['bucket', 'Fill area', 'Fill a smooth surface region'], ['piece', 'Fill piece', 'Colour a whole segment']];
  return (
    <>
      <Card title="Colours">
        <div className="fx-palette" style={{ position: 'relative' }}>
          {fx.palette.map((c, i) => {
            const k = filaments.findIndex((f) => f.color.toLowerCase() === c.toLowerCase());
            return (
              <button key={i} className={`fx-sw ${fx.slot === i + 1 ? 'on' : ''} ${k < 0 || filaments[k].planned ? 'unloaded' : ''}`} style={{ background: c }}
                title={`Colour ${i + 1}: ${k >= 0 ? `filament ${k + 1}${filaments[k].planned ? ' (load before printing)' : ''}` : 'not loaded'} — click to paint with, double-click to choose the filament`}
                onClick={() => { fx.slot = i + 1; notify(); }} onDoubleClick={() => setPick(i)} onContextMenu={(e) => { e.preventDefault(); setPick(i); }}>
                <span>{k >= 0 ? k + 1 : '!'}</span>
              </button>
            );
          })}
          {fx.palette.length < 16 && <button className="fx-sw add" title="Add a colour from the loaded filaments" onClick={() => setPick(-1)}>+</button>}
          {pick !== null && <FilamentPicker title={pick < 0 ? 'Add a colour' : `Colour ${pick + 1}`} onClose={() => setPick(null)} onPick={(j) => { const hex = useStore.getState().filaments[j]?.color; if (!hex) return; if (pick < 0) addColour(hex); else setPalette(pick, hex); }} />}
        </div>
        <div className="mx-sub">{mac.multiColour === 'ams' ? `${mac.printer.model}: up to 16 colours with the AMS.` : `${mac.printer.model} has no AMS: every colour change is a pause for a manual swap.`} This design uses {used.length} colour{used.length === 1 ? '' : 's'}.</div>
      </Card>
      <Card title="Paint tools">
        <div className="fx-chips">{tools.map(([t, n, h]) => <button key={t} title={h} className={`btn-small ${fx.tool === t ? 'btn-primary' : 'btn-secondary'}`} onClick={() => { fx.tool = t; notify(); }}>{n}</button>)}</div>
        {fx.tool === 'brush' && <Slider label="Brush size" unit="mm" value={fx.brush} min={1} max={40} step={0.5} onChange={(v) => { fx.brush = v; notify(); }} />}
        {fx.tool === 'bucket' && <Slider label="Edge angle that stops the fill" unit="°" value={fx.bucketAngle} min={5} max={90} onChange={(v) => { fx.bucketAngle = v; notify(); }} />}
        <div className="fx-chips">
          <button className="btn-small btn-secondary" onClick={() => addPaint({ kind: 'fill', slot: fx.slot })}>Fill everything</button>
          <button className="btn-small btn-secondary" onClick={() => setPaint([{ kind: 'fill', slot: 1 }])}>Clear paint</button>
        </div>
        <div className="mx-sub">Painting follows the model: change the design and the colours stay where they were.</div>
      </Card>
      <Card title="Colour schemes (one click)">
        <div className="fx-presets">
          {SCHEMES.map((s) => <button key={s.id} className="fx-preset" onClick={() => setPaint(s.ops(fx.palette.length) as PaintOp[])}><span>{s.name}</span></button>)}
        </div>
      </Card>
    </>
  );
}

// ---------------------------------------------------------------- print
export function PrinterPicker() {
  const { vendors, byVendor } = PRINTERS_VENDORS();
  const id = useStore((s) => s.printerId);
  return (
    <select className="select" value={id} aria-label="Printer" onChange={(e) => setPrinter(e.target.value)}>
      {vendors.map((v) => <optgroup key={v} label={v}>{byVendor(v).map((p) => <option key={p.id} value={p.id}>{p.vendor} {p.model} · {p.nozzle} mm</option>)}</optgroup>)}
    </select>
  );
}

function PrintTab({ onToast }: { onToast: (t: string) => void }) {
  const mac = currentMachine();
  const f = built?.fit;
  const fitNow = () => {
    if (!f) return;
    if (fx.source === 'import') fx.importScale = +(fx.importScale * f.scale * 0.995).toFixed(3);
    else { fx.design.body.length = +(fx.design.body.length * f.scale * 0.995).toFixed(1); fx.design.body.thickness = +(fx.design.body.thickness * f.scale * 0.995).toFixed(2); }
    changed();
  };
  return (
    <>
      <Card title="Machine">
        <PrinterPicker />
        <div className="mx-sub">{mac.printer.vendor} {mac.printer.model} · nozzle {mac.nozzle} mm · bed {mac.bed.x} × {mac.bed.y} × {mac.bed.z} mm · {mac.multiColour === 'ams' ? 'AMS multi-colour' : 'manual colour swaps'}</div>
        <div className="mx-sub">Joint clearance follows the nozzle: <b>{mac.fit.clearance.toFixed(2)} mm</b> around moving parts, <b>{mac.fit.gap.toFixed(2)} mm</b> between pieces.</div>
        <div className="mx-two">
          <Slider label="Clearance (0 = from nozzle)" unit="mm" value={fx.clearance} min={0} max={0.6} step={0.01} hint="Tight printers: lower. Gaps fuse: raise." onChange={(v) => { fx.clearance = v; changed(); }} />
          <Slider label="Face gap (0 = automatic)" unit="mm" value={fx.gap} min={0} max={1.5} step={0.05} onChange={(v) => { fx.gap = v; changed(); }} />
        </div>
      </Card>
      <Card title="Fit on the bed">
        {f ? (
          <>
            <div className="mx-sub">Model {f.size.map((x) => x.toFixed(0)).join(' × ')} mm on a {mac.bed.x} × {mac.bed.y} × {mac.bed.z} mm bed.</div>
            <div className={`fx-fit ${f.fits ? 'ok' : 'bad'}`}>{f.fits ? (f.angle ? `Fits when turned ${f.angle}° on the bed.` : 'Fits the bed.') : `Too big for this bed: scale to ${(f.scale * 100).toFixed(0)}% (turned ${f.angle}°).`}</div>
            {!f.fits && <button className="btn-secondary" onClick={fitNow}>Scale to fit this printer</button>}
          </>
        ) : <div className="mx-sub">Building…</div>}
      </Card>
      <Card title="Output">
        <button className="btn-primary" disabled={!built} onClick={async () => { const p = await export3mf(); onToast(p ? `Saved ${p}` : 'Export cancelled'); }}>Export coloured 3MF</button>
        <button className="btn-secondary" disabled={!built} onClick={() => { const r = sendToPlate(); if (r) onToast(`Placed on the plate with ${r.colours} colour${r.colours === 1 ? '' : 's'}.`); }}>Send to the plate</button>
        <div className="mx-sub">The 3MF carries a colour for every triangle (Bambu Studio, OrcaSlicer and PrusaSlicer open it coloured). The joints are real geometry: print it as it is, then bend each joint once to free it.</div>
      </Card>
    </>
  );
}

function pickTab(t: typeof fx.tab) {
  fx.tab = t;
  if (t === 'paint' && fx.tool === 'place') fx.tool = 'orbit';
  if (t === 'cuts' && (fx.tool === 'brush' || fx.tool === 'bucket' || fx.tool === 'piece')) fx.tool = 'orbit';
  notify();
}

export function EditorColumn({ onToast }: { onToast: (t: string) => void }) {
  useFx();
  const studio = useInStudio();
  return (
    <>
      {studio ? <section className="st-card"><SourceBar /><div style={{ marginTop: 8 }}><Seg label="Step" value={fx.tab} options={[['design', 'Design'], ['cuts', 'Cuts'], ['paint', 'Paint'], ['print', 'Print']]} onChange={(t) => pickTab(t)} /></div></section> : <SourceBar />}
      {!studio && <div className="fx-tabs">
        {(['design', 'cuts', 'paint', 'print'] as const).map((t) => (
          <button key={t} className={`fx-tab ${fx.tab === t ? 'on' : ''}`} onClick={() => { fx.tab = t; if (t === 'paint' && fx.tool === 'place') fx.tool = 'orbit'; if (t === 'cuts' && (fx.tool === 'brush' || fx.tool === 'bucket' || fx.tool === 'piece')) fx.tool = 'orbit'; notify(); }}>
            {t === 'design' ? 'Design' : t === 'cuts' ? 'Cuts' : t === 'paint' ? 'Paint' : 'Print'}
          </button>
        ))}
      </div>}
      {fx.tab === 'design' && (fx.source === 'creature' ? <CreatureDesigner /> : <ImportDesigner />)}
      {fx.tab === 'cuts' && <CutsTab />}
      {fx.tab === 'paint' && <PaintTab />}
      {fx.tab === 'print' && <PrintTab onToast={onToast} />}
    </>
  );
}
