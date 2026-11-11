// Numeric transform window for Move / Rotate / Scale: objects, and parts (positive, negative, modifier, enforcer, blocker).
import { useEffect, useState } from 'react';
import * as THREE from 'three';
import { transformVertices } from '../engine/mesh';
import { printerById } from '../profiles/printers';
import { dropToBed, objectMatrix, objectPlate, partWorldMatrix, plateOrigin, useStore, worldBounds, type SceneObject, type ScenePart, type Vec3 } from '../state/store';
import { PART_LABELS, setPartWall } from '../state/ops';
import { Icon } from './icons';
import './transform.css';

type Axis = 0 | 1 | 2;
type Box = { min: number[]; max: number[] };

function NumField({ value, onSet }: { value: number; onSet: (v: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  useEffect(() => setDraft(null), [value]);
  return (
    <input className="input" style={{ textAlign: 'right' }} value={draft ?? (Math.abs(value) < 5e-3 ? 0 : value).toFixed(2)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => { if (draft !== null) { const v = parseFloat(draft); if (isFinite(v)) onSet(v); setDraft(null); } }}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
  );
}

/** World-space bounds of a part. */
function partBounds(o: SceneObject, p: ScenePart): Box {
  const v = transformVertices(p.mesh.vertices, partWorldMatrix(o, p).elements);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < v.length; i += 3) for (let k = 0; k < 3; k++) { if (v[i + k] < min[k]) min[k] = v[i + k]; if (v[i + k] > max[k]) max[k] = v[i + k]; }
  return { min, max };
}

// ---- align / distribute icons (bars + a reference line), 20px
const ALIGN_PATHS: Record<string, string> = {
  xl: 'M4 3v14M7 6h9M7 11h5', xc: 'M10 3v14M5 6h10M7 11h6', xr: 'M16 3v14M4 6h9M8 11h5', dx: 'M4 4v12M16 4v12M8 7h4v6H8z',
  yb: 'M3 16h14M6 4v9M11 8v5', ym: 'M3 10h14M6 5v10M11 7v6', yt: 'M3 4h14M6 7v9M11 7v5', dy: 'M4 4h12M4 16h12M7 8h6v4H7z',
  zb: 'M3 16h14M5 4h4v9H5zM11 8h4v5h-4z', zc: 'M3 10h14M5 4h4v12H5zM11 6h4v8h-4z', zt: 'M3 4h14M5 7h4v9H5zM11 7h4v5h-4z', dz: 'M4 4h12M4 16h12M7 7h6v6H7z',
};
const AlignIcon = ({ k }: { k: string }) => (
  <svg width={20} height={20} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={ALIGN_PATHS[k]} /></svg>
);
const ALIGN_GROUPS: { axis: Axis; items: [string, string, 'min' | 'mid' | 'max' | 'dist'][] }[] = [
  { axis: 0, items: [['xl', 'Align left', 'min'], ['xc', 'Align centre (X)', 'mid'], ['xr', 'Align right', 'max'], ['dx', 'Distribute along X', 'dist']] },
  { axis: 1, items: [['yb', 'Align front', 'min'], ['ym', 'Align middle (Y)', 'mid'], ['yt', 'Align back', 'max'], ['dy', 'Distribute along Y', 'dist']] },
  { axis: 2, items: [['zb', 'Align bottom', 'min'], ['zc', 'Align centre (Z)', 'mid'], ['zt', 'Align top', 'max'], ['dz', 'Distribute along Z', 'dist']] },
];

/** Move the objects so their boxes line up with `ref` (or spread evenly between the outermost two). */
function alignObjects(ids: string[], axis: Axis, how: 'min' | 'mid' | 'max' | 'dist', ref: Box | null) {
  const s = useStore.getState();
  const objs = s.objects.filter((o) => ids.includes(o.id));
  const bs = new Map(objs.map((o) => [o.id, worldBounds(o) as Box]));
  const delta = new Map<string, number>();
  if (how === 'dist') {
    if (objs.length < 3) return;
    const sorted = [...objs].sort((a, b) => (bs.get(a.id)!.min[axis] + bs.get(a.id)!.max[axis]) - (bs.get(b.id)!.min[axis] + bs.get(b.id)!.max[axis]));
    const first = bs.get(sorted[0].id)!, last = bs.get(sorted[sorted.length - 1].id)!;
    const total = last.max[axis] - first.min[axis];
    const sizes = sorted.reduce((a, o) => a + bs.get(o.id)!.max[axis] - bs.get(o.id)!.min[axis], 0);
    const gap = (total - sizes) / (sorted.length - 1);
    let at = first.min[axis];
    for (const o of sorted) { const b = bs.get(o.id)!; delta.set(o.id, at - b.min[axis]); at += b.max[axis] - b.min[axis] + gap; }
  } else {
    const all = [...bs.values()];
    const r = ref ?? { min: [0, 1, 2].map((k) => Math.min(...all.map((b) => b.min[k]))), max: [0, 1, 2].map((k) => Math.max(...all.map((b) => b.max[k]))) };
    for (const o of objs) {
      const b = bs.get(o.id)!;
      const target = how === 'min' ? r.min[axis] : how === 'max' ? r.max[axis] - (b.max[axis] - b.min[axis]) : (r.min[axis] + r.max[axis]) / 2 - (b.max[axis] - b.min[axis]) / 2;
      delta.set(o.id, target - b.min[axis]);
    }
  }
  s.checkpoint();
  useStore.setState((st) => ({ objects: st.objects.map((o) => { const d = delta.get(o.id); if (!d) return o; const p = [...o.position] as Vec3; p[axis] += d; return { ...o, position: p }; }) }));
  s.markDirty();
}

function AlignSection({ ids }: { ids: string[] }) {
  const [mode, setMode] = useState<'selected' | 'bed'>('selected');
  const s = useStore();
  const n = ids.length;
  const bed = () => {
    const p = printerById(s.printerId);
    const o = s.objects.find((x) => x.id === ids[0]);
    const [ox, oy] = plateOrigin(o ? objectPlate(o, s.printerId, s.plates.length) : s.activePlate, s.printerId);
    return { min: [ox, oy, 0], max: [ox + p.bed.x, oy + p.bed.y, p.bed.z] } as Box;
  };
  return (
    <>
      <div className="tp-sep" />
      <div className="tp-head">
        <select className="tp-select" value={mode} onChange={(e) => setMode(e.target.value as 'selected' | 'bed')} aria-label="Align reference">
          <option value="selected">Align selected</option>
          <option value="bed">Align to bed</option>
        </select>
      </div>
      <div className="tp-label">Align / Distribute</div>
      <div className="tp-align">
        {ALIGN_GROUPS.map((g, gi) => (
          <span key={g.axis} style={{ display: 'contents' }}>
            {gi > 0 && <span className="gap" />}
            {g.items.map(([icon, label, how]) => (
              <button key={icon} title={label} aria-label={label} disabled={how === 'dist' ? n < 3 : mode === 'selected' ? n < 2 : n < 1}
                onClick={() => alignObjects(ids, g.axis, how, mode === 'bed' ? bed() : null)}><AlignIcon k={icon} /></button>
            ))}
          </span>
        ))}
      </div>
    </>
  );
}

/** Numeric transform panel for the active tool: the selected objects or the selected part. */
export function TransformPanel() {
  const { tool, objects, selected, updateObjects, selectedPart, uniformScale: uniform, set } = useStore();
  const setUniform = (v: boolean) => set({ uniformScale: v });
  const [space, setSpace] = useState<'world' | 'object'>('world');
  const o = objects.find((x) => x.id === selected[0]);
  if (!o || !['move', 'rotate', 'scale'].includes(tool)) return null;
  const part = selectedPart ? o.parts?.find((p) => p.id === selectedPart) : undefined;
  if (selectedPart && !part) return null;

  const field = (axis: number, value: number, onSet: (v: number) => void, unit: string) => (
    <div className="xyz" key={axis}>
      <span className={`ax ${'xyz'[axis]}`}>{'XYZ'[axis]}</span>
      <NumField value={value} onSet={onSet} />
      <span className="unit">{unit}</span>
    </div>
  );
  const spaceSelect = (
    <select className="tp-select" value={space} onChange={(e) => setSpace(e.target.value as 'world' | 'object')} aria-label="Coordinate space">
      <option value="world">World coordinates</option>
      <option value="object">{part ? 'Object coordinates' : 'Object origin'}</option>
    </select>
  );
  // a scale or size of 0 (or less) flattens the model and breaks the next uniform scale: refuse it with a hint
  const positive = (onSet: (v: number) => void) => (v: number) => {
    if (v > 0) { onSet(v); return; }
    useStore.getState().set({ toast: { kind: 'warn', text: 'The size must be greater than 0. Use Mirror (right-click the object) to flip it.' } });
  };
  // a negative scale is a mirror (3MF imports carry them) and stays allowed; only 0 is refused
  const nonZero = (onSet: (v: number) => void) => (v: number) => {
    if (v !== 0) { onSet(v); return; }
    useStore.getState().set({ toast: { kind: 'warn', text: 'A scale of 0 % would flatten the model. Use a small value instead.' } });
  };
  const scaleOf = (v: Vec3, k: number, val: number, f: number): Vec3 => {
    if (uniform) return v.map((x) => (x / (v[k] || 1)) * f) as Vec3;
    const t = [...v] as Vec3; t[k] = f; return t;
  };

  // ---------- a part
  if (part) {
    const setPart = (fn: (p: ScenePart) => ScenePart) => updateObjects((x) => ({ ...x, parts: (x.parts ?? []).map((p) => (p.id === part.id ? fn(p) : p)) }), [o.id]);
    const pb = partBounds(o, part);
    const size = [0, 1, 2].map((k) => pb.max[k] - pb.min[k]);
    const centre = [0, 1, 2].map((k) => (pb.min[k] + pb.max[k]) / 2);
    const tag = <span className="tp-part-tag">{part.prim?.wall ? (part.type === 'negative' ? 'Wall cutter' : 'Wall shell') : PART_LABELS[part.type]}</span>;
    const wallRow = part.prim?.wall ? (() => {
      const w = part.prim.wall, wo = part.prim.wallOut ?? 0, wi = w - wo;
      const place = wo <= 1e-9 ? 'inside' : wi <= 1e-9 ? 'outside' : Math.abs(wo - wi) < 1e-9 ? 'centre' : 'custom';
      const setPlace = (v: string) => setPartWall(o.id, part.id, w, v === 'inside' ? 0 : v === 'outside' ? w : v === 'centre' ? w / 2 : wo || w / 3);
      return (
        <div style={{ marginTop: 8 }}>
          <div className="xyz"><span className="ax">Wall</span><NumField value={w} onSet={positive((v) => setPartWall(o.id, part.id, v))} /><span className="unit">mm</span></div>
          <select className="tp-select" value={place} aria-label="Wall position" onChange={(e) => setPlace(e.target.value)}>
            <option value="inside">Inside the shape's surface</option>
            <option value="centre">Centred on the surface</option>
            <option value="outside">Outside the surface</option>
            <option value="custom">Uneven (set inside and outside)</option>
          </select>
          {place === 'custom' && <>
            <div className="xyz"><span className="ax">In</span><NumField value={wi} onSet={(v) => { if (v >= 0 && v + wo > 0) setPartWall(o.id, part.id, v + wo, wo); }} /><span className="unit">mm</span></div>
            <div className="xyz"><span className="ax">Out</span><NumField value={wo} onSet={(v) => { if (v >= 0 && v + wi > 0) setPartWall(o.id, part.id, v + wi, v); }} /><span className="unit">mm</span></div>
          </>}
          <p className="muted" style={{ fontSize: 11, margin: '2px 0 0' }}>Wall thickness, true at any scale: {wi.toFixed(2)} mm inside and {wo.toFixed(2)} mm outside the shape's surface.{part.type === 'negative' ? ' The cut removes only this skin along the shape, splitting the object; use “Cut along wall cutters and separate” to get the pieces.' : ''}</p>
        </div>
      );
    })() : null;
    return (
      <div className="float panel">
        {tool === 'move' && <>
          <div className="tp-head"><h4 style={{ margin: 0 }}>Move</h4>{tag}</div>
          <div className="tp-head">{spaceSelect}</div>
          {[0, 1, 2].map((k) => field(k, space === 'world' ? centre[k] : part.position[k], (v) => setPart((p) => {
            if (space === 'object') { const q = [...p.position] as Vec3; q[k] = v; return { ...p, position: q }; }
            const inv = objectMatrix(o).invert();
            const a = new THREE.Vector3(...centre).applyMatrix4(inv), b = new THREE.Vector3(...centre).setComponent(k, v).applyMatrix4(inv);
            return { ...p, position: [p.position[0] + b.x - a.x, p.position[1] + b.y - a.y, p.position[2] + b.z - a.z] };
          }), 'mm'))}
        </>}
        {tool === 'rotate' && <>
          <div className="tp-head"><h4 style={{ margin: 0 }}>Rotate · degrees</h4>{tag}</div>
          {[0, 1, 2].map((k) => field(k, part.rotation[k], (v) => setPart((p) => { const r = [...p.rotation] as Vec3; r[k] = v; return { ...p, rotation: r }; }), '°'))}
          <button className="btn-secondary btn-small" onClick={() => setPart((p) => ({ ...p, rotation: [0, 0, 0] }))}>Reset rotation</button>
        </>}
        {tool === 'scale' && <>
          <div className="tp-head" style={{ justifyContent: 'space-between' }}><h4 style={{ margin: 0 }}>Scale</h4>{tag}
            <label className="row" style={{ fontWeight: 400, gap: 6, marginTop: 0 }}><Icon name="lock" size={14} />Uniform
              <button className={`toggle ${uniform ? 'on' : ''}`} onClick={() => setUniform(!uniform)} aria-label="Uniform scale" /></label>
          </div>
          {[0, 1, 2].map((k) => field(k, part.scale[k] * 100, nonZero((v) => setPart((p) => ({ ...p, scale: scaleOf(p.scale, k, v, v / 100) }))), '%'))}
          <h4 style={{ marginTop: 10 }}>Size</h4>
          {[0, 1, 2].map((k) => field(k, size[k], positive((v) => setPart((p) => {
            const f = v / Math.max(1e-9, size[k]);
            return { ...p, scale: (uniform ? p.scale.map((x) => x * f) : p.scale.map((x, i) => (i === k ? x * f : x))) as Vec3 };
          })), 'mm'))}
          <button className="btn-secondary btn-small" onClick={() => setPart((p) => ({ ...p, scale: [1 / o.scale[0], 1 / o.scale[1], 1 / o.scale[2]] }))}>Reset</button>
        </>}
        {wallRow}
      </div>
    );
  }

  // ---------- objects
  const ids = selected.filter((id) => objects.some((x) => x.id === id));
  const sel = objects.filter((x) => ids.includes(x.id));
  const boxes = sel.map((x) => worldBounds(x));
  const b = { min: [0, 1, 2].map((k) => Math.min(...boxes.map((x) => x.min[k]))), max: [0, 1, 2].map((k) => Math.max(...boxes.map((x) => x.max[k]))) };
  const commit = (fn: (o: SceneObject) => SceneObject, drop = true) => updateObjects((x) => (drop ? dropToBed(fn(x)) : fn(x)), [o.id]);
  const shift = (k: number, delta: number) => updateObjects((x) => { const p = [...x.position] as Vec3; p[k] += delta; return { ...x, position: p }; }, ids);
  return (
    <div className="float panel">
      {tool === 'move' && <>
        <h4>Move</h4>
        <div className="tp-head">{spaceSelect}</div>
        {[0, 1, 2].map((k) => {
          const cur = space === 'object' ? o.position[k] : k === 2 ? b.min[2] : (b.min[k] + b.max[k]) / 2;
          return field(k, cur, (v) => shift(k, v - cur), 'mm');
        })}
        <button className="btn-secondary btn-small" disabled={Math.abs(b.min[2]) < 1e-4} onClick={() => updateObjects((x) => dropToBed(x), ids)}>Drop to bed</button>
        <AlignSection ids={ids} />
      </>}
      {tool === 'rotate' && <>
        <h4>Rotate · degrees</h4>
        {[0, 1, 2].map((k) => field(k, o.rotation[k], (v) => commit((x) => { const r = [...x.rotation] as Vec3; r[k] = v; return { ...x, rotation: r }; }), '°'))}
        <button className="btn-secondary btn-small" onClick={() => commit((x) => ({ ...x, rotation: [0, 0, 0] }))}>Reset rotation</button>
      </>}
      {tool === 'scale' && <>
        <h4 className="row" style={{ justifyContent: 'space-between' }}>Scale
          <label className="row" style={{ fontWeight: 400, gap: 6, marginTop: 0 }}><Icon name="lock" size={14} />Uniform
            <button className={`toggle ${uniform ? 'on' : ''}`} onClick={() => setUniform(!uniform)} aria-label="Uniform scale" /></label>
        </h4>
        {[0, 1, 2].map((k) => field(k, o.scale[k] * 100, nonZero((v) => commit((x) => ({ ...x, scale: scaleOf(x.scale, k, v, v / 100) }))), '%'))}
        <h4 style={{ marginTop: 10 }}>Size</h4>
        {[0, 1, 2].map((k) => {
          const so = worldBounds(o); const sk = so.max[k] - so.min[k];
          return field(k, sk, positive((v) => commit((x) => {
            const f = v / Math.max(1e-9, sk);
            return { ...x, scale: (uniform ? x.scale.map((s) => s * f) : x.scale.map((s, i) => (i === k ? s * f : s))) as Vec3 };
          })), 'mm');
        })}
        <div className="row">
          <button className="btn-secondary btn-small" onClick={() => commit((x) => ({ ...x, scale: x.scale.map((s) => s * 25.4) as Vec3 }))}>From inches</button>
          <button className="btn-secondary btn-small" onClick={() => commit((x) => ({ ...x, scale: [1, 1, 1] }))}>Reset</button>
        </div>
      </>}
    </div>
  );
}
