// Center-top global engine toggle: BASIC (classic heuristic engine) | ADVANCED (NexSpiro physics core).
import { useAdvanced } from '../../state/advanced';
import { useStore } from '../../state/store';
import { Icon } from '../icons';

export function ModeToggle({ compact = false }: { compact?: boolean }) {
  const { engineMode, set } = useAdvanced();
  const adv = engineMode === 'advanced';
  const pick = (m: 'basic' | 'advanced') => {
    if (m === engineMode) return;
    set({ engineMode: m });
    // painting with the Advanced brush makes no sense once Basic is back
    if (m === 'basic' && useStore.getState().tool === 'paint_adv') useStore.getState().set({ tool: 'select' });
  };
  if (compact) {
    return (
      <div className="sh-seg" role="radiogroup" aria-label="Slicing engine">
        <button role="radio" aria-checked={!adv} className={`sh-ib ${!adv ? 'on' : ''}`} onClick={() => pick('basic')} title="Basic: classic engine" aria-label="Basic engine"><Icon name="layers" size={16} /></button>
        <button role="radio" aria-checked={adv} className={`sh-ib ${adv ? 'on' : ''}`} onClick={() => pick('advanced')} title="Advanced: NexSpiro physics core" aria-label="Advanced engine"><Icon name="atom" size={16} /></button>
      </div>
    );
  }
  return (
    <div className={`mode-toggle ${adv ? 'is-adv' : ''}`} role="radiogroup" aria-label="Slicing engine">
      <span className="mode-thumb" aria-hidden="true" />
      <button role="radio" aria-checked={!adv} className={!adv ? 'on' : ''} onClick={() => pick('basic')}
        title="Basic: classic heuristic slicing with the process settings">
        <span className="mode-name">BASIC</span><span className="mode-sub">Classic Engine</span>
      </button>
      <button role="radio" aria-checked={adv} className={adv ? 'on' : ''} onClick={() => pick('advanced')}
        title="Advanced: NexSpiro analyses each part and compiles it with 15 tools (35 field, PDE and topology technologies)">
        <Icon name="atom" size={15} />
        <span className="mode-name">ADVANCED</span><span className="mode-sub">NexSpiro Physics Core</span>
      </button>
    </div>
  );
}
