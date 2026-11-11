// The latest drool check from the quick toolpath view, shared with the panels that show it.
import { useSyncExternalStore } from 'react';
import { emptyDrool, type DroolReport } from './threads';

let current: DroolReport | null = null;
const listeners = new Set<() => void>();

/** Store the check for the view that was just built (several plugins' reports are added up). */
export function setDrool(list: DroolReport[]): void {
  if (!list.length) current = null;
  else {
    const r = emptyDrool(list[0].safeMm / 0.5);
    for (const x of list) {
      r.worstMm = Math.max(r.worstMm, x.worstMm); r.beads += x.beads; r.sagging += x.sagging; r.dripping += x.dripping;
      r.drips += x.drips; r.strings += x.strings; r.thinned = r.thinned || x.thinned;
    }
    r.level = r.dripping ? 'drip' : r.sagging ? 'sag' : 'ok';
    current = r;
  }
  listeners.forEach((l) => l());
}

export const getDrool = () => current;
export function useDrool(): DroolReport | null {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, getDrool);
}
