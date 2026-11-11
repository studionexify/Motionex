// Undo / redo buttons and keys for a Studio, over a plugin's design history.
import { IconButton } from './Studio';
import { useUndoKeys, type DesignHistory } from './history';

export function UndoRedo({ history }: { history: DesignHistory }) {
  history.use();
  useUndoKeys(history.undo, history.redo);
  return (
    <span style={{ display: 'inline-flex', gap: 2 }}>
      <IconButton icon="undo" title="Undo (Ctrl+Z)" disabled={!history.canUndo()} onClick={history.undo} />
      <IconButton icon="redo" title="Redo (Ctrl+Y)" disabled={!history.canRedo()} onClick={history.redo} />
    </span>
  );
}
