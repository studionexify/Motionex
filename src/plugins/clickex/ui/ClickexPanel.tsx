// Clickex dock panel: open the Studio, see the current design at a glance, send it to the plate, reopen saved designs.
import { Ico, Note } from './controls';
import { compute, cx, deleteSaved, download3mf, openSaved, openStudio, saveDesign, savedDesigns, say, transferFitTest, transferToPlate, useCx } from './state';

export function ClickexPanel() {
  useCx();
  const c = compute();
  const r = c.built?.report;
  const saved = savedDesigns();
  return (
    <div className="mx-panel">
      <section className="mx-card">
        <p className="muted" style={{ margin: '0 0 8px', fontSize: 12 }}>Turn an image, SVG, icon, text, name blocks or a 3D model into a clicker built around a mechanical keyboard switch. Everything prints without glue.</p>
        <button className="btn-primary" style={{ width: '100%' }} onClick={() => openStudio(true)}>Open Clickex Studio</button>
      </section>
      <section className="mx-card">
        <div className="mx-card-title">{cx.spec.name}</div>
        {r && r.size[0] ? (
          <>
            <div className="muted" style={{ fontSize: 12 }}>{r.size[0]} × {r.size[1]} × {r.size[2]} mm · button {r.buttonGrams} g · base {r.baseGrams} g</div>
            <Note kind={r.fits ? 'ok' : 'warn'}>{r.fits ? '✓ fits an MX switch' : '✕ switch does not fit'}{r.warnings.length ? ` · ${r.warnings.length} note${r.warnings.length > 1 ? 's' : ''}` : ''}</Note>
          </>
        ) : <div className="muted" style={{ fontSize: 12 }}>Open the Studio to pick a design.</div>}
        <div className="cx-btns">
          <button className="btn-secondary btn-small" onClick={() => { const p = transferToPlate(); if (p) say(`${p.count} parts placed on ${p.plate}.`); }}>Send to plate</button>
          <button className="btn-secondary btn-small" onClick={() => download3mf()}>Download 3MF</button>
          <button className="btn-secondary btn-small" onClick={saveDesign}>Save</button>
        </div>
        <button className="btn-secondary btn-small" style={{ marginTop: 6 }} title="A small plain clicker to test how the switch and button fit" onClick={() => { const p = transferFitTest(); if (p) say(`Fit test placed on ${p.plate}.`); }}>Send a fit test to the plate</button>
      </section>
      {saved.length > 0 && (
        <section className="mx-card">
          <div className="mx-card-title">Saved designs ({saved.length})</div>
          {saved.map((d) => (
            <div key={d.name} className="cx-saved">
              <button className="btn-secondary btn-small" style={{ flex: 1, textAlign: 'left' }} onClick={() => { openSaved(d); openStudio(true); }}>{d.name}</button>
              <button className="btn-secondary btn-small" onClick={() => deleteSaved(d.name)} aria-label={`Delete ${d.name}`}>Delete</button>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
