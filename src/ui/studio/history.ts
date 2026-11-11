// Undo / redo for a plugin design, by snapshots. Call `touch()` after every edit (the plugin's own
// `changed()` does it); a step is recorded once edits pause, and never while a pointer is held down, so a
// whole drag or brush stroke is one step. Edits that leave the design unchanged (UI-only state) record
// nothing, because snapshots are compared.
import { useEffect, useSyncExternalStore } from 'react';

export interface DesignHistory {
  /** After an edit: record a step once edits pause. */
  touch: () => void;
  /** Record a pending step now. */
  flush: () => void;
  undo: () => void;
  redo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;
  /** Forget all steps and start again from the current design (after loading a project). */
  reset: () => void;
  /** Re-renders when the undo/redo availability changes. */
  use: () => number;
}

// pointers held down anywhere: steps wait until they are all released
let held = 0;
const onRelease = new Set<() => void>();
if (typeof window !== 'undefined') {
  window.addEventListener('pointerdown', () => { held++; }, true);
  const up = () => { held = Math.max(0, held - 1); if (!held) onRelease.forEach((f) => f()); };
  window.addEventListener('pointerup', up, true);
  window.addEventListener('pointercancel', up, true);
  window.addEventListener('blur', () => { if (held) { held = 0; onRelease.forEach((f) => f()); } });
}

export function createHistory<T>(get: () => T, set: (snapshot: T) => void, { limit = 100, quietMs = 400 } = {}): DesignHistory {
  let undo: string[] = [], redo: string[] = [];
  // the design before the first edit (the plugin's state is loaded by the time its history is made)
  let base = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending = false, restoring = false, version = 0;
  const listeners = new Set<() => void>();
  const bump = () => { version++; listeners.forEach((l) => l()); };
  const snap = () => JSON.stringify(get());

  const flush = () => {
    clearTimeout(timer); timer = undefined;
    if (!pending) return;
    pending = false;
    const now = snap();
    if (now === base) return;
    undo.push(base);
    if (undo.length > limit) undo.shift();
    redo = [];
    base = now;
    bump();
  };
  const arm = () => { clearTimeout(timer); timer = setTimeout(() => { if (held) return; flush(); }, quietMs); };
  onRelease.add(() => { if (pending) arm(); });
  base = snap();

  const restore = (s: string) => {
    base = s;
    restoring = true;
    try { set(JSON.parse(s) as T); } finally { restoring = false; }
    pending = false; clearTimeout(timer);
    bump();
  };

  return {
    touch: () => { if (restoring) return; pending = true; arm(); },
    flush,
    undo: () => { flush(); const s = undo.pop(); if (s === undefined) return; redo.push(base); restore(s); },
    redo: () => { flush(); const s = redo.pop(); if (s === undefined) return; undo.push(base); restore(s); },
    canUndo: () => undo.length > 0 || (pending && snap() !== base),
    canRedo: () => redo.length > 0,
    reset: () => { clearTimeout(timer); pending = false; undo = []; redo = []; base = snap(); bump(); },
    use: () => useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, () => version),
  };
}

const inField = (t: EventTarget | null) => t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);

/** Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y for a Studio while it is mounted. Runs before the app's own scene undo
 *  (capture phase) and stops it, so the plate is not undone at the same time. Text fields keep their own undo. */
export function useUndoKeys(undo: () => void, redo: () => void, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    const k = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || inField(e.target)) return;
      const key = e.key.toLowerCase();
      if (key !== 'z' && key !== 'y') return;
      e.preventDefault(); e.stopImmediatePropagation();
      if (key === 'y' || e.shiftKey) redo(); else undo();
    };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [undo, redo, enabled]);
}
