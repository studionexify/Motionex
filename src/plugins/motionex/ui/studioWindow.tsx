// Motion Studio as a full-window editor over NexSpiro (the shared Studio shell), opened from the Motionex
// settings bar like the other plugins' Studios. Closing it returns to the model.
import { useSyncExternalStore } from 'react';
import { useStore } from '../../../state/store';
import { MotionStudio } from './MotionStudio';

let isOpen = false;
const listeners = new Set<() => void>();
export function openMotionStudio(open = true) { isOpen = open; listeners.forEach((l) => l()); }
const useOpen = () => useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => isOpen);

export function MotionStudioHost() {
  const open = useOpen();
  const installed = useStore((s) => s.plugins.includes('motionex'));
  if (!open || !installed || typeof document === 'undefined') return null;
  return <MotionStudio layout="three" />;
}
