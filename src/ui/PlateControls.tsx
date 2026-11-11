// Plate list and the plate settings dialog (the per-plate icons are drawn on the bed, see viewport/plate.ts).
import { useEffect, useRef, useState } from 'react';
import { renderThumbnail } from '../viewport/thumbnail';
import { create } from 'zustand';
import { printerById, type PlateType } from '../profiles/printers';
import { objectPlate, useStore } from '../state/store';
import { updatePlate } from '../state/ops';
import { plateObjects } from '../state/slicing';
import { Icon } from './icons';
import { Modal } from './Modals';
import { FilamentSequenceEditor, draftOf, sequenceOf } from './FilamentSequenceEditor';

const usePlateDialog = create<{ index: number | null }>(() => ({ index: null }));
export const openPlateSettings = (index: number) => usePlateDialog.setState({ index });

const thumbCache = new Map<string, string>();
/** Small picture of the objects on a plate, redrawn (debounced) when they change. */
function usePlateThumb(plate: number): string | null {
  const objs = useStore((s) => s.objects);
  const printerId = useStore((s) => s.printerId);
  const count = useStore((s) => s.plates.length);
  const list = objs.filter((o) => objectPlate(o, printerId, count) === plate && !o.hidden);
  const key = list.map((o) => `${o.id}:${o.position.join(',')}:${o.rotation.join(',')}:${o.scale.join(',')}:${o.filament ?? 0}:${o.mesh.indices.length}`).join('|');
  const [url, setUrl] = useState<string | null>(() => thumbCache.get(key) ?? null);
  const latest = useRef(list);
  latest.current = list;
  useEffect(() => {
    if (!key) { setUrl(null); return; }
    const hit = thumbCache.get(key);
    if (hit) { setUrl(hit); return; }
    let dead = false;
    const t = setTimeout(async () => {
      const png = await renderThumbnail(latest.current, 160);
      if (dead || !png) return;
      const u = URL.createObjectURL(new Blob([png as BlobPart], { type: 'image/png' }));
      if (thumbCache.size > 40) thumbCache.delete(thumbCache.keys().next().value!);
      thumbCache.set(key, u);
      setUrl(u);
    }, 400);
    return () => { dead = true; clearTimeout(t); };
  }, [key]);
  return url;
}

function PlateTile({ i }: { i: number }) {
  const s = useStore();
  const p = s.plates[i];
  const n = plateObjects(i).length;
  const url = usePlateThumb(i);
  const sliced = s.slice.status === 'done' && s.slice.plate === i && !s.slice.dirty;
  return (
    <button className={`plate-tile ${i === s.activePlate ? 'active' : ''} ${sliced ? 'sliced' : ''}`} title={`${p.name} · ${n} object${n === 1 ? '' : 's'}${p.locked ? ' · locked' : ''}${sliced ? ' · sliced' : ''}`}
      onClick={() => s.set({ activePlate: i })} onDoubleClick={() => openPlateSettings(i)}>
      {url && <img className="plate-tile-img" src={url} alt="" draggable={false} />}
      <span className="plate-tile-num">{String(i + 1).padStart(2, '0')}</span>
      <span className="plate-tile-count">{n}{p.locked && <Icon name="lock" size={10} />}</span>
    </button>
  );
}

/** Plate list down the right edge of the 3D view when the project has more than one plate (plate thumbnails). */
export function PlateList() {
  const count = useStore((s) => s.plates.length);
  if (count < 2) return null;
  return (
    <div className="float plate-list" aria-label="Plates">
      {Array.from({ length: count }, (_, i) => <PlateTile key={i} i={i} />)}
    </div>
  );
}

export function PlateSettingsHost() {
  const index = usePlateDialog((s) => s.index);
  const plate = useStore((s) => (index === null ? undefined : s.plates[index]));
  if (index === null || !plate) return null;
  return <PlateSettings key={plate.id} index={index} onClose={() => usePlateDialog.setState({ index: null })} />;
}

const tri = (v: boolean | undefined) => (v === undefined ? 'global' : v ? 'on' : 'off');

function PlateSettings({ index, onClose }: { index: number; onClose: () => void }) {
  const s = useStore();
  const p = s.plates[index];
  const printer = printerById(s.printerId);
  const globalBed = printer.plates.find((x) => x.type === s.plate)?.label ?? s.plate;
  const [name, setName] = useState(p.name);
  const [bed, setBed] = useState<PlateType | 'global'>(p.bedType ?? 'global');
  const [vase, setVase] = useState(tri(p.spiralVase));
  const [locked, setLocked] = useState(!!p.locked);
  const [seq, setSeq] = useState<string>(p.printSequence ?? 'global');
  const [fseq, setFseq] = useState(() => draftOf(p.filamentSequence, s.filaments.length));
  const ok = () => {
    updatePlate(index, {
      name: name.trim() || p.name, locked,
      bedType: bed === 'global' ? undefined : bed,
      spiralVase: vase === 'global' ? undefined : vase === 'on',
      printSequence: seq === 'global' ? undefined : (seq as 'by_layer' | 'by_object'),
      filamentSequence: s.filaments.length > 1 ? sequenceOf(fseq) : p.filamentSequence,
    });
    onClose();
  };
  return (
    <Modal title={`Plate settings — ${p.name}`} onClose={onClose}
      footer={<><button className="btn-secondary btn-small" onClick={onClose}>Cancel</button><button className="btn-primary btn-small" onClick={ok}>OK</button></>}>
      <div className="form-grid plate-form">
        <span>Plate name</span>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && ok()} autoFocus />
        <span>Bed type</span>
        <select className="select" value={bed} onChange={(e) => setBed(e.target.value as PlateType | 'global')}>
          <option value="global">Same as global ({globalBed})</option>
          {printer.plates.map((x) => <option key={x.type} value={x.type}>{x.label}</option>)}
        </select>
        <span>Spiral vase</span>
        <select className="select" value={vase} onChange={(e) => setVase(e.target.value)}>
          <option value="global">Same as global ({s.overrides.spiral_mode === true ? 'Enable' : 'Disable'})</option>
          <option value="on">Enable</option>
          <option value="off">Disable</option>
        </select>
        <span>Print sequence</span>
        <select className="select" value={seq} onChange={(e) => setSeq(e.target.value)}>
          <option value="global">Same as global ({s.overrides.print_sequence === 'by_object' ? 'By object' : 'By layer'})</option>
          <option value="by_layer">By layer</option>
          <option value="by_object">By object</option>
        </select>
        {s.filaments.length > 1 && <FilamentSequenceEditor draft={fseq} colors={s.filaments.map((f) => f.color)} onChange={setFseq} />}
        <span>Locked</span>
        <label className="row" style={{ margin: 0 }}><button className={`toggle ${locked ? 'on' : ''}`} onClick={() => setLocked(!locked)} aria-label="Lock plate" />
          <span className="muted" style={{ fontSize: 12 }}>Arrange and auto orient skip a locked plate</span></label>
      </div>
      <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>The bed type sets this plate's bed temperatures when it is sliced. {plateObjects(index).length} object(s) on this plate.</p>
    </Modal>
  );
}
