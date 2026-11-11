// On touch screens there is no Shift / Ctrl / Alt. These sticky switches stand in for them:
// "Add" = Shift/Ctrl (add to the selection, extend a pick), "Erase" = Alt (erase while painting).
// They only show on devices without a hover-capable pointer (CSS: .touch-mods is hidden under (hover: hover)).
import { useSyncExternalStore } from 'react';

const state = { add: false, erase: false };
let snap = { ...state };
const subs = new Set<() => void>();
const set = (k: keyof typeof state) => { state[k] = !state[k]; snap = { ...state }; subs.forEach((f) => f()); };
export const touchAdd = () => state.add;
export const touchErase = () => state.erase;
const use = () => useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => snap);

export function TouchMods({ erase = false }: { erase?: boolean }) {
  const s = use();
  return (
    <div className="touch-mods" role="group" aria-label="Touch modifiers">
      <button className={s.add ? 'on' : ''} aria-pressed={s.add} onClick={() => set('add')} title="Stands in for Shift / Ctrl: add to the selection">＋ Add</button>
      {erase && <button className={s.erase ? 'on' : ''} aria-pressed={s.erase} onClick={() => set('erase')} title="Stands in for Alt: erase while painting">Erase</button>}
    </div>
  );
}
