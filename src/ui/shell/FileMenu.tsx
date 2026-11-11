// Floating top-left cluster: File menu, Import, Undo, Redo (moved from the old TopBar).
import { useEffect, useState } from 'react';
import { exportGcode, importDialog, newProject, sliceAllPlates, sliceAndPreview } from '../../state/actions';
import { exportPlateFile } from '../../state/printjob';
import { openProjectDialog, saveProject } from '../../state/project';
import { useStore } from '../../state/store';
import { Icon } from '../icons';
import { openPrintDialog } from '../PrintModal';

/** True when the active plate has a slice that matches the current scene and settings. */
export const useSliced = () => useStore((s) => s.slice.status === 'done' && !!s.slice.result && !s.slice.dirty && s.slice.plate === s.activePlate);

/** Closes a popover on any outside pointer-down. */
export function useOutsideClose(open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return;
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [open, close]);
}

export function FileMenu() {
  const [open, setOpen] = useState(false);
  const sliced = useSliced();
  const objects = useStore((s) => s.objects);
  const hasProgram = useStore((s) => !!s.plates[s.activePlate]?.program);
  const plateCount = useStore((s) => s.plates.length);
  useOutsideClose(open, () => setOpen(false));
  const item = (label: string, kbd: string, fn: () => void, disabled = false) => (
    <button className="menu-item" disabled={disabled} onPointerDown={(e) => e.stopPropagation()} onClick={() => { setOpen(false); fn(); }}>
      <span>{label}</span><kbd>{kbd}</kbd>
    </button>
  );
  return (
    <div className="menu">
      <button className={`sh-ib ${open ? 'on' : ''}`} onPointerDown={(e) => e.stopPropagation()} onClick={() => setOpen(!open)} aria-haspopup="menu">
        File<Icon name="chevronDown" size={12} />
      </button>
      {open && (
        <div className="menu-pop" role="menu">
          {item('New project', 'Ctrl+N', newProject)}
          {item('Import STL / OBJ / 3MF / AMF / STEP…', 'Ctrl+I', importDialog)}
          {item('Slice plate', 'Ctrl+R', sliceAndPreview, !objects.length && !hasProgram)}
          {item('Slice all plates', '', () => void sliceAllPlates(), !objects.length || plateCount < 2)}
          {item('Export G-code…', 'Ctrl+G', exportGcode, !sliced)}
          {item('Export plate sliced file (.gcode.3mf)…', '', () => void exportPlateFile('3mf'), !sliced)}
          {item('Print plate…', 'Ctrl+P', () => void openPrintDialog(), !sliced)}
          <div className="sep" style={{ width: '100%', height: 1, margin: '4px 0' }} />
          {item('Open project (.3mf)…', 'Ctrl+O', () => void openProjectDialog())}
          {item('Save project…', 'Ctrl+S', () => void saveProject(), !objects.length)}
        </div>
      )}
    </div>
  );
}

export function TopLeft() {
  const { undo, redo, undoStack, redoStack } = useStore();
  return (
    <div className="float sh-float sh-tl">
      <button className="sh-ib" title="Import model (Ctrl+I)" onClick={importDialog}><Icon name="download" size={16} /><span className="ib-label">Import</span></button>
      <span className="sh-div" />
      <button className="sh-ib" title="Undo (Ctrl+Z)" aria-label="Undo" disabled={!undoStack.length} onClick={undo}><Icon name="undo" size={16} /></button>
      <button className="sh-ib" title="Redo (Ctrl+Y)" aria-label="Redo" disabled={!redoStack.length} onClick={redo}><Icon name="redo" size={16} /></button>
    </div>
  );
}
