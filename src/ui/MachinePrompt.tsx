// Asked when the printer or nozzle changes while plugin designs are open.
import { answerMachine, useMachinePrompt } from '../state/machineSync';
import { Icon } from './icons';
import { Modal } from './Modals';

export function MachinePromptHost() {
  const p = useMachinePrompt((s) => s.prompt);
  if (!p) return null;
  const canAdapt = p.items.some((i) => i.apply && i.changes.length);
  return (
    <Modal title="Machine changed" onClose={() => answerMachine(false)} footer={<>
      <button className="btn-secondary" onClick={() => answerMachine(false)} title="Keep every size as designed; the Studios rebuild for the new machine">Keep as designed</button>
      <span className="spacer" />
      {canAdapt && <button className="btn-primary" onClick={() => answerMachine(true)} title="Apply the changes listed">Adapt designs</button>}
    </>}>
      <p style={{ marginTop: 0 }}>{p.from.name} · {p.from.nozzle} mm <Icon name="chevronRight" size={12} /> <b>{p.to.name} · {p.to.nozzle} mm</b></p>
      {p.items.map((i) => (
        <div key={i.label} style={{ marginBottom: 10 }}>
          <b>{i.label}</b>
          {i.changes.map((c) => <div key={c} className="row" style={{ gap: 6, fontSize: 12 }}>{i.apply ? '•' : <span className="badge" title="Happens either way">auto</span>} {c}</div>)}
          {i.warnings.map((w) => <div key={w} className="row" style={{ gap: 6, fontSize: 12, color: 'var(--warning)' }}><Icon name="warn" size={12} /> {w}</div>)}
        </div>
      ))}
    </Modal>
  );
}
