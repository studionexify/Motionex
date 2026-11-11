import { Fragment, useState } from 'react';
import { PRINTERS, printerById, printerName } from '../profiles/printers';
import { filamentById } from '../profiles/filaments';
import { openFiles } from '../platform';
import { applyTuning, CALIBRATIONS, startCalibration, useCalibration, type CalibId } from '../state/calibration';
import { openProjectDialog, saveProject } from '../state/project';
import { FILAMENTS } from '../profiles/filaments';
import { addSample, importDialog, SAMPLES } from '../state/actions';
import { effectiveNozzle } from '../profiles/resolve';
import { useStore } from '../state/store';
import { Icon } from './icons';

export function HomePage() {
  const { set, objects } = useStore();
  return (
    <div className="page">
      <div className="hero">
        <h1>Welcome to NexSpiro</h1>
        <p className="lead" style={{ maxWidth: 560 }}>Prepare, slice and send 3D prints for Bambu Lab, Creality, Elegoo and more — locally on your computer.</p>
        <div className="row">
          <button className="btn-primary" onClick={importDialog}><Icon name="add" />Import model</button>
          {objects.length > 0 && <button className="btn-secondary" style={{ background: 'rgba(20,32,48,.5)', color: '#F6EEE6' }} onClick={() => set({ workspace: 'prepare' })}>Continue on plate ({objects.length})</button>}
        </div>
        <img src="./logo-dark.svg" alt="" />
      </div>
      <h2>Start from a sample</h2>
      <div className="grid-cards">
        {SAMPLES.map((s) => (
          <div key={s.id} className="tile click" onClick={() => addSample(s.id)} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && addSample(s.id)}>
            <Icon name="cube" size={22} style={{ color: 'var(--accent)' }} />
            <h3>{s.name}</h3><p>{s.description}</p>
          </div>
        ))}
      </div>
      <h2>Supported printers ({PRINTERS.length})</h2>
      {[...new Set(PRINTERS.map((p) => p.vendor))].map((v) => (
        <div key={v} style={{ marginBottom: 14 }}>
          <div className="menu-label" style={{ padding: '0 0 6px' }}>{v}</div>
          <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
            {PRINTERS.filter((p) => p.vendor === v).map((p) => (
              <button key={p.id} className="btn-secondary btn-small" title={`${p.bed.x}×${p.bed.y}×${p.bed.z} mm · ${p.flavor === 'klipper' ? 'Klipper' : p.flavor === 'bbl' ? 'Marlin (A1/P1/X1/H2 dialect)' : 'Marlin'}${p.note ? ` — ${p.note}` : ''}`}
                onClick={() => set({ printerId: p.id, plate: p.plates[0].type, workspace: 'prepare' })}>{p.model}</button>
            ))}
          </div>
        </div>
      ))}
      <h2>Keyboard shortcuts</h2>
      <div className="tile" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 6 }}>
        {[['Ctrl+I', 'Add model'], ['Ctrl+R', 'Slice plate'], ['Ctrl+G', 'Export G-code'], ['Ctrl+Z / Ctrl+Y', 'Undo / Redo'], ['M / R / S / F', 'Move / Rotate / Scale / Lay on face'],
          ['A', 'Arrange'], ['O', 'Auto orient'], ['Del', 'Delete'], ['Ctrl+D', 'Duplicate'], ['Ctrl+A', 'Select all'], ['Ctrl+Tab', 'Next tab page'], ['Shift+?', 'All shortcuts'], ['↑ / ↓', 'Layer slider (Preview)'], ['Ctrl+P', 'Print plate'], ['Ctrl+S / Ctrl+O', 'Save / open project'], ['C / T / U / B', 'Cut / Text / Measure / Boolean']].map(([k, v]) => (
          <div key={k} className="row" style={{ margin: 0 }}><span className="badge mono">{k}</span><span>{v}</span></div>
        ))}
      </div>
    </div>
  );
}

export function ProjectPage() {
  const { objects, printerId, filaments, presetId, machineOverrides, plates, project, slice, set } = useStore();
  const p = PRINTERS.find((x) => x.id === printerId)!;
  const upd = (k: keyof typeof project, v: string) => set({ project: { ...project, [k]: v } });
  const stats = slice.result?.stats;
  const addPhotos = async () => {
    const files = await openFiles([{ name: 'Images', extensions: ['png', 'jpg', 'jpeg'] }]);
    const photos = [...project.photos];
    for (const f of files) {
      let bin = '';
      const b = new Uint8Array(f.data);
      for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode(...b.subarray(i, i + 0x8000));
      photos.push({ name: f.name, dataUrl: `data:image/${/png$/i.test(f.name) ? 'png' : 'jpeg'};base64,${btoa(bin)}` });
    }
    set({ project: { ...project, photos } });
  };
  return (
    <div className="page">
      <div className="row" style={{ marginBottom: 6 }}>
        <h1 style={{ margin: 0 }}>Project</h1><span className="spacer" />
        <button className="btn-secondary btn-small" onClick={openProjectDialog}><Icon name="open" size={14} />Open…</button>
        <button className="btn-primary btn-small" disabled={!objects.length} onClick={saveProject}><Icon name="save" size={14} />Save project</button>
      </div>
      <p className="lead">Details saved inside the project .3mf — title, designer, description, print notes and photos. The 3MF stays readable by other slicers.</p>
      <div className="project-grid">
        <div className="tile">
          <div className="form-grid" style={{ gridTemplateColumns: '110px 1fr' }}>
            <span>Title</span><input className="input" value={project.title} placeholder={objects[0]?.name ?? 'Untitled'} onChange={(e) => upd('title', e.target.value)} />
            <span>Designer</span><input className="input" value={project.author} onChange={(e) => upd('author', e.target.value)} />
            <span>License</span>
            <select className="select" value={project.license} onChange={(e) => upd('license', e.target.value)}>
              {['', 'CC BY', 'CC BY-SA', 'CC BY-NC', 'CC BY-NC-SA', 'CC0', 'All rights reserved'].map((l) => <option key={l} value={l}>{l || '—'}</option>)}
            </select>
          </div>
          <h3>Description</h3>
          <textarea className="input textarea" rows={4} value={project.description} onChange={(e) => upd('description', e.target.value)} />
          <h3>Print notes</h3>
          <textarea className="input textarea" rows={5} placeholder="Supports, orientation, post-processing, assembly…" value={project.notes} onChange={(e) => upd('notes', e.target.value)} />
        </div>
        <div className="tile">
          <h3 style={{ marginTop: 0 }}>Bill of materials</h3>
          <div className="summary" style={{ marginTop: 0, border: 0, paddingTop: 0 }}>
            <span className="k">Printer</span><span className="v">{printerName(p, effectiveNozzle(printerId, machineOverrides))}</span>
            <span className="k">Process</span><span className="v">{presetId} mm</span>
            <span className="k">Plates</span><span className="v">{plates.length}</span>
            <span className="k">Objects</span><span className="v">{objects.length}</span>
            {stats && <><span className="k">Plate {slice.plate + 1} time</span><span className="v">{Math.floor(stats.timeSeconds / 3600)}h {Math.round((stats.timeSeconds % 3600) / 60)}m</span></>}
            {stats?.repeat && <><span className="k">Plate {slice.plate + 1} whole job ({stats.repeat.cycles}×)</span><span className="v">{Math.floor(stats.repeat.totalSeconds / 3600)}h {Math.round((stats.repeat.totalSeconds % 3600) / 60)}m</span></>}
          </div>
          <h3>Filaments</h3>
          {filaments.map((f, i) => {
            const fp = FILAMENTS.find((x) => x.id === f.presetId);
            const used = stats?.perFilament[i];
            return (
              <div key={i} className="row" style={{ marginBottom: 4 }}>
                <span className="swatch" style={{ background: f.color }} /><span>{i + 1}: {fp?.name}</span><span className="spacer" />
                {used && used.mm > 0 && <span className="badge">{used.grams.toFixed(1)} g · {used.cost.toFixed(2)}</span>}
              </div>
            );
          })}
          {!stats && <p className="muted" style={{ fontSize: 12 }}>Slice a plate to see filament use.</p>}
          <h3>Objects</h3>
          {objects.map((o) => <div key={o.id} className="row" style={{ marginBottom: 2 }}><Icon name="cube" size={14} />{o.name}<span className="spacer" /><span className="badge">{(o.mesh.indices.length / 3).toLocaleString()} triangles</span></div>)}
        </div>
        <div className="tile" style={{ gridColumn: '1 / -1' }}>
          <div className="row"><h3 style={{ margin: 0 }}>Photos</h3><span className="spacer" /><button className="btn-secondary btn-small" onClick={addPhotos}><Icon name="add" size={14} />Add photos</button></div>
          {!project.photos.length && <p className="muted">Add photos of the printed result; they are saved in the project file.</p>}
          <div className="photo-grid">
            {project.photos.map((ph, i) => (
              <figure key={i}>
                <img src={ph.dataUrl} alt={ph.name} />
                <figcaption className="row"><span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{ph.name}</span>
                  <button className="icon-btn" title="Remove" onClick={() => set({ project: { ...project, photos: project.photos.filter((_, k) => k !== i) } })}><Icon name="trash" size={14} /></button></figcaption>
              </figure>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export function CalibrationPage() {
  const { printerId, filaments, machineOverrides } = useStore();
  const printer = printerById(printerId);
  const fil = filamentById(filaments[0].presetId);
  const [open, setOpen] = useState<CalibId | null>(null);
  const [vals, setVals] = useState<Record<string, { start: number; end: number; step: number }>>({});
  const { last, choice } = useCalibration();
  const setChoice = (c: number) => useCalibration.setState({ choice: c });
  const tuning = filaments[0].tuning ?? {};
  return (
    <div className="page">
      <h1>Calibration</h1>
      <p className="lead">Each test builds its model and per-height settings for <b>{printerName(printer, effectiveNozzle(printerId, machineOverrides))}</b> with <b>{fil.name}</b> (slot 1). Print it, then save the best value to the filament.</p>
      {Object.keys(tuning).length > 0 && (
        <div className="tile" style={{ marginBottom: 14 }}>
          <div className="row"><b style={{ color: 'var(--text-strong)' }}>Calibrated values for slot 1</b><span className="spacer" />
            <button className="btn-secondary btn-small" onClick={() => { const fs = filaments.map((f, i) => (i === 0 ? { ...f, tuning: undefined } : f)); useStore.getState().set({ filaments: fs }); useStore.getState().markDirty(); }}>Reset</button></div>
          <div className="row" style={{ flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
            {tuning.nozzleTemp !== undefined && <span className="pill">Nozzle {tuning.nozzleTemp} °C</span>}
            {tuning.pressureAdvance !== undefined && <span className="pill">Pressure advance {tuning.pressureAdvance}</span>}
            {tuning.flowRatio !== undefined && <span className="pill">Flow ratio {tuning.flowRatio}</span>}
            {tuning.maxVolumetricSpeed !== undefined && <span className="pill">Max flow {tuning.maxVolumetricSpeed} mm³/s</span>}
            {tuning.retractionLength !== undefined && <span className="pill">Retraction {tuning.retractionLength} mm</span>}
          </div>
        </div>
      )}
      {last && (
        <div className="tile" style={{ marginBottom: 14, borderColor: 'var(--accent)' }}>
          <b style={{ color: 'var(--text-strong)' }}>{CALIBRATIONS.find((c) => c.id === last.id)!.title} — save the result</b>
          <p className="muted" style={{ fontSize: 12 }}>{last.result.howTo}</p>
          <div className="row">
            <select className="select" value={choice} onChange={(e) => setChoice(Number(e.target.value))}>
              {last.result.choices.map((c, i) => <option key={i} value={i}>{c.label}</option>)}
            </select>
            <button className="btn-primary btn-small" onClick={() => { applyTuning(0, last.result.choices[choice].tuning); useStore.getState().set({ toast: { kind: 'info', text: `Saved to filament slot 1: ${last.result.choices[choice].label}` } }); }}>Save to filament</button>
          </div>
        </div>
      )}
      <div className="grid-cards">
        {CALIBRATIONS.map((c) => {
          const def = c.params(fil, printer.flavor);
          const v = vals[c.id] ?? { start: def.start, end: def.end, step: def.step };
          const setV = (k: 'start' | 'end' | 'step', x: string) => setVals({ ...vals, [c.id]: { ...v, [k]: Number(x) } });
          return (
            <div key={c.id} className="tile">
              <Icon name="calib" style={{ color: 'var(--accent)' }} />
              <h3>{c.title}</h3><p>{c.description}</p>
              {open === c.id ? (
                <>
                  <div className="form-grid" style={{ gridTemplateColumns: '1fr 90px 40px', marginTop: 10 }}>
                    {(['start', 'end', 'step'] as const).map((k) => (
                      <Fragment key={k}><span style={{ textTransform: 'capitalize' }}>{k}</span>
                        <input className="input mono" type="number" step="any" value={v[k]} onChange={(e) => setV(k, e.target.value)} /><span className="unit">{def.unit}</span></Fragment>
                    ))}
                  </div>
                  <div className="row" style={{ marginTop: 10 }}>
                    <button className="btn-secondary btn-small" onClick={() => setOpen(null)}>Cancel</button>
                    <button className="btn-primary btn-small" disabled={!(v.step > 0) || v.start === v.end && c.id !== 'temp'} onClick={() => {
                      if (startCalibration(c.id, v)) setOpen(null);
                    }}>Create test plate</button>
                  </div>
                </>
              ) : <button className="btn-secondary btn-small" style={{ marginTop: 10 }} onClick={() => setOpen(c.id)}>Set up…</button>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
