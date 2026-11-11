// Floating pill under the engine toggle for the current selection (Prepare only).
import { autoOrient } from '../../state/actions';
import { repairObjects } from '../../state/meshTools';
import { useStore, type Tool } from '../../state/store';
import { useClearanceStatus } from '../../state/ui';
import { Icon } from '../icons';

const DOT: Record<string, string> = { collision: 'var(--ns-err, var(--error))', warn: 'var(--ns-warn, var(--warning))', ok: 'var(--ns-ok, var(--success))', none: 'var(--text-muted)' };

export function ObjectPill() {
  const { selected, objects, tool, set, duplicateSelected, removeSelected } = useStore();
  const clearance = useClearanceStatus();
  if (!selected.length) return null;
  const name = selected.length === 1 ? objects.find((o) => o.id === selected[0])?.name ?? 'Object' : `${selected.length} objects`;
  const T = (t: Tool, label: string, key: string) => (
    <button className={`sh-ib ${tool === t ? 'on' : ''}`} aria-pressed={tool === t} title={`${label} (${key})`} onClick={() => set({ tool: tool === t ? 'select' : t })}>
      {label}<kbd>{key}</kbd>
    </button>
  );
  return (
    <div className="float sh-float sh-pill" role="toolbar" aria-label="Selected object">
      <span className="sh-pill-name" title={clearance.message || name}><span className="sh-dot" style={{ background: DOT[clearance.state] }} />{name}</span>
      <span className="sh-div" />
      {T('move', 'Move', 'M')}
      {T('rotate', 'Rotate', 'R')}
      {T('scale', 'Scale', 'S')}
      {T('face', 'Lay flat', 'F')}
      {objects.some((o) => selected.includes(o.id) && o.openEdges > 0) && <button className="sh-ib" style={{ color: 'var(--ns-warn, var(--warning))' }} title="This model has open edges — close holes and repair the mesh" onClick={() => repairObjects(selected)}>Fix model</button>}
      <button className="sh-ib" title="Auto orient (O)" onClick={() => autoOrient()}>Auto-orient<kbd>O</kbd></button>
      <span className="sh-div" />
      <button className="sh-ib" title="Duplicate (Ctrl+D)" aria-label="Duplicate" onClick={duplicateSelected}><Icon name="copy" size={16} /></button>
      <button className="sh-ib" title="Delete (Del)" aria-label="Delete" onClick={removeSelected}><Icon name="trash" size={16} /></button>
    </div>
  );
}
