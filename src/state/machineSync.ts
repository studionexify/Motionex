// Machine changes under plugin designs. When the project's printer or nozzle changes while a plugin design is
// open, each design says what it would adapt (walls kept at the same number of lines, parts that no longer fit
// the bed) and the user chooses: adapt the designs, or keep them as designed. Either way every Studio rebuilds
// for the new machine, so what it shows is what the plate slices.
import { create } from 'zustand';
import { printerById } from '../profiles/printers';
import { effectiveNozzle } from '../profiles/resolve';
import { useStore } from './store';

export interface MachineInfo { printerId: string; name: string; nozzle: number; lineWidth: number; bed: { x: number; y: number; z: number } }
export interface MachineAdapt { changes: string[]; warnings: string[]; apply?: () => void }
export interface MachineLink {
  id: string;
  /** Name of the open design, or null when the plugin has none. */
  label: () => string | null;
  adapt: (from: MachineInfo, to: MachineInfo) => MachineAdapt;
  /** Rebuild for the current machine. */
  refresh?: () => void;
}

const links = new Map<string, MachineLink>();
export function registerMachineLink(l: MachineLink) { links.set(l.id, l); }

export const lineWidthFor = (nozzle: number) => Math.round(nozzle * 1.05 * 100) / 100;
export function machineInfo(s = useStore.getState()): MachineInfo {
  const p = printerById(s.printerId), nozzle = effectiveNozzle(s.printerId, s.machineOverrides);
  return { printerId: p.id, name: `${p.vendor} ${p.model}`, nozzle, lineWidth: lineWidthFor(nozzle), bed: p.bed };
}

const mm = (v: number) => `${+v.toFixed(2)} mm`;
/** A wall kept at the same number of lines on the new nozzle (at least `min` lines). */
export function keepLines(wall: number, from: MachineInfo, to: MachineInfo, min = 2): number {
  const n = Math.max(min, Math.round(wall / from.lineWidth));
  return Math.round(n * to.lineWidth * 100) / 100;
}
/** Adapt a named wall: pushes a change line and returns the setter, or nothing when it stays. */
export function adaptWall(label: string, wall: number, from: MachineInfo, to: MachineInfo, changes: string[], min = 2): number | null {
  const w = keepLines(wall, from, to, min);
  if (Math.abs(w - wall) < 0.01) return null;
  changes.push(`${label} ${mm(wall)} → ${mm(w)} (${Math.max(min, Math.round(wall / from.lineWidth))} lines of ${to.lineWidth})`);
  return w;
}
export function bedWarning(name: string, size: [number, number, number], to: MachineInfo): string | null {
  const [x, y, z] = size, b = to.bed;
  const fits = (z <= b.z) && ((x <= b.x && y <= b.y) || (x <= b.y && y <= b.x));
  return fits ? null : `${name} (${x.toFixed(0)}×${y.toFixed(0)}×${z.toFixed(0)} mm) is larger than the ${to.name} bed (${b.x}×${b.y}×${b.z} mm).`;
}

interface Item { label: string; changes: string[]; warnings: string[]; apply?: () => void }
interface Prompt { from: MachineInfo; to: MachineInfo; items: Item[] }
export const useMachinePrompt = create<{ prompt: Prompt | null }>(() => ({ prompt: null }));

const refreshAll = () => { for (const l of links.values()) if (l.label()) l.refresh?.(); };

/** The machine changed from `from` to `to`: ask when an open design would change, else just rebuild. */
export function machineChanged(from: MachineInfo, to: MachineInfo) {
  const items: Item[] = [];
  for (const l of links.values()) {
    const label = l.label();
    if (!label) continue;
    const a = l.adapt(from, to);
    if (a.changes.length || a.warnings.length) items.push({ label, ...a });
  }
  if (!items.length) { refreshAll(); return; }
  useMachinePrompt.setState({ prompt: { from, to, items } });
}

export function answerMachine(adapt: boolean) {
  const p = useMachinePrompt.getState().prompt;
  useMachinePrompt.setState({ prompt: null });
  if (adapt && p) for (const i of p.items) i.apply?.();
  refreshAll();
}

let started = false;
export function startMachineSync() {
  if (started) return;
  started = true;
  let last = machineInfo();
  useStore.subscribe((s) => {
    const now = machineInfo(s);
    if (now.printerId === last.printerId && now.nozzle === last.nozzle) return;
    const from = last;
    last = now;
    machineChanged(from, now);
  });
}
