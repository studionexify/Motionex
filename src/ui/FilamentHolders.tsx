// Filament holders UI: the machine's loaded-filament list (Device tab), the source badge used on the Filament
// card, and the prompt shown when the machine's filaments change under objects or designs that use them.
import { FILAMENTS, filamentById } from '../profiles/filaments';
import { addHolder, answerPrompt, editHolder, removeHolder, takeReported, useHolders, type Holder } from '../state/holders';
import { Icon } from './icons';
import { Modal } from './Modals';

const SOURCE: Record<Holder['source'], { label: string; title: string }> = {
  rfid: { label: 'RFID', title: 'Read by the printer from the spool\'s RFID tag' },
  printer: { label: 'Printer', title: 'As set on the printer (no RFID tag)' },
  user: { label: 'You', title: 'Set by you — the printer has no RFID reading for this spool' },
};

export function HolderBadge({ h }: { h?: Holder }) {
  if (!h) return null;
  const s = SOURCE[h.source];
  return <span className={`badge holder-src ${h.source}`} title={`${h.tray ? `${h.tray} · ` : ''}${s.title}`}>{h.tray ? `${h.tray} · ` : ''}{s.label}</span>;
}

/** Device tab: what is loaded in this machine. Editing it edits the project's filament slots when this machine
 *  is the project's printer. */
export function HoldersTile({ deviceKey, title = 'Filament holders' }: { deviceKey: string; title?: string }) {
  const list = useHolders((s) => s.lists[deviceKey]) ?? [];
  return (
    <div className="tile holders-tile">
      <div className="row" style={{ marginBottom: 6 }}>
        <h3 style={{ margin: 0 }}>{title}</h3><span className="spacer" />
        <button className="icon-btn" title="Add a holder" aria-label="Add a holder" disabled={list.length >= 16} onClick={() => addHolder(deviceKey)}><Icon name="add" size={16} /></button>
      </div>
      <p className="muted" style={{ fontSize: 11, margin: '0 0 8px' }}>What is loaded in this machine. Spools with RFID fill in by themselves; set the others here. The project's Filament list follows this list.</p>
      {!list.length && <p className="muted" style={{ fontSize: 12 }}>No holders yet — add what is loaded.</p>}
      {list.map((h, i) => {
        const locked = h.source === 'rfid';
        return (
          <div key={i} className="row holder-row" style={{ marginBottom: 4, gap: 6 }}>
            <label className="swatch-btn" title={locked ? 'Colour read from the RFID tag' : 'Colour'} style={{ background: h.color }}>
              <span>{i + 1}</span>
              <input type="color" disabled={locked} value={h.color} onChange={(e) => editHolder(deviceKey, i, { color: e.target.value.toUpperCase() })} />
            </label>
            <select className="select" disabled={locked} value={h.presetId} aria-label={`Holder ${i + 1} filament`} onChange={(e) => editHolder(deviceKey, i, { presetId: e.target.value })}>
              {FILAMENTS.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
            <HolderBadge h={h} />
            {h.reported && (
              <button className="btn-secondary btn-small" title={`The printer reads ${h.reported.type} ${h.reported.color} here`} onClick={() => takeReported(deviceKey, i)}>
                <span className="dot" style={{ background: h.reported.color }} /> Use printer's
              </button>
            )}
            {list.length > 1 && !h.tray && <button className="icon-btn" title="Remove holder" onClick={() => removeHolder(deviceKey, i)}><Icon name="close" size={14} /></button>}
          </div>
        );
      })}
    </div>
  );
}

const describe = (f?: { presetId: string; color: string }) => (f ? `${filamentById(f.presetId).name} ${f.color.toUpperCase()}` : 'nothing');

/** Asked when the machine's filaments change under objects or plugin designs that use them. */
export function HolderPromptHost() {
  const p = useHolders((s) => s.prompt);
  if (!p) return null;
  return (
    <Modal title={`Filaments changed on ${p.machine}`} onClose={() => answerPrompt('later')} footer={<>
      <button className="btn-secondary" onClick={() => answerPrompt('later')}>Not now</button>
      <span className="spacer" />
      <button className="btn-secondary" onClick={() => answerPrompt('keep')} title="Each part keeps its filament: it moves to the holder that has it, or is listed as 'load before printing'">Keep my colours</button>
      <button className="btn-primary" onClick={() => answerPrompt('follow')} title="Each slot takes the filament now in its holder; parts and designs recolour">Use machine filaments</button>
    </>}>
      <div className="holder-prompt">
        {p.changes.map((c) => (
          <div key={c.slot} className="row" style={{ gap: 6, marginBottom: 4 }}>
            <b style={{ width: 52 }}>Slot {c.slot + 1}</b>
            <span className="dot" style={{ background: c.from?.color ?? 'transparent' }} />{describe(c.from)}
            <Icon name="chevronRight" size={12} />
            <span className="dot" style={{ background: c.to?.color ?? 'transparent' }} />{describe(c.to)}
          </div>
        ))}
        <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>Used by: {p.affected.join(', ')}</p>
      </div>
    </Modal>
  );
}
