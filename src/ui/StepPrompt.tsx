// Asked when an edited design is sent back to the plate and its objects had other plugins applied on top.
import { stepLabel, useStepPrompt } from '../state/steps';
import { Modal } from './Modals';

export function StepPromptHost() {
  const p = useStepPrompt((s) => s.prompt);
  if (!p) return null;
  return (
    <Modal title={`${stepLabel(p.plugin)} design changed`} onClose={() => p.resolve('drop')} footer={<>
      <button className="btn-secondary" onClick={() => p.resolve('cancel')} title="Put the objects back as they were">Cancel</button>
      <span className="spacer" />
      <button className="btn-secondary" onClick={() => p.resolve('drop')} title="Keep only the new design">Drop later steps</button>
      <button className="btn-primary" onClick={() => p.resolve('reapply')} title="Apply the later steps again on the new shape">Re-apply later steps</button>
    </>}>
      <p style={{ marginTop: 0 }}>These objects had more done to them after {stepLabel(p.plugin)} made them:</p>
      {p.objects.map((o) => <div key={o.name} className="row" style={{ gap: 6, marginBottom: 4 }}><b>{o.name}</b><span className="muted">then {o.steps.join(', then ')}</span></div>)}
      <p className="muted" style={{ fontSize: 12 }}>Re-apply keeps the artwork, painted motion areas and modifier volumes on the new shape.</p>
    </Modal>
  );
}
