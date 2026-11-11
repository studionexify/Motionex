// Right column: the inspector (printer, filament, preset, process tabs and the tabs of the plugins turned on in the
// Plugins menu). Its left edge has a grip: drag it to widen or narrow the column; double-click resets it.
import { useEffect, useState } from 'react';
import { Inspector } from '../inspector/Inspector';

const LS = 'nexspiro.rightWidth';
const MIN = 300, DEF = 340;
const read = () => { try { const v = Number(localStorage.getItem(LS)); return v >= MIN ? v : DEF; } catch { return DEF; } };
let width = read();
const subs = new Set<(w: number) => void>();
const setWidth = (w: number) => { width = w; subs.forEach((f) => f(w)); try { localStorage.setItem(LS, String(Math.round(w))); } catch { /* storage off */ } };

/** Below this window width the dock stops taking grid space and slides over the canvas instead (tablet / phone). */
export const DOCK_BP = 1024;
let open = true;
const openSubs = new Set<(o: boolean) => void>();
export const setDockOpen = (o: boolean) => { open = o; openSubs.forEach((f) => f(o)); };
export function useDockOpen() {
  const [o, set] = useState(open);
  useEffect(() => { openSubs.add(set); return () => { openSubs.delete(set); }; }, []);
  return o;
}
/** True when the window is at or below the tablet breakpoint. */
export function useNarrow(bp = DOCK_BP) {
  const q = `(max-width: ${bp}px)`;
  const [n, set] = useState(() => typeof matchMedia !== 'undefined' && matchMedia(q).matches);
  useEffect(() => { const m = matchMedia(q); const f = () => set(m.matches); m.addEventListener('change', f); f(); return () => m.removeEventListener('change', f); }, [q]);
  return n;
}

/** Current right-column width in px (the app grid uses it). */
export function useRightWidth() {
  const [w, set] = useState(width);
  useEffect(() => { subs.add(set); return () => { subs.delete(set); }; }, []);
  return w;
}

export function RightColumn() {
  const start = (e: React.PointerEvent) => {
    e.preventDefault();
    const zoom = Number(getComputedStyle(document.documentElement).getPropertyValue('--ui-zoom')) || 1;
    const x0 = e.clientX, w0 = width;
    const max = () => Math.max(MIN, window.innerWidth / zoom * 0.6);
    const move = (ev: PointerEvent) => setWidth(Math.min(max(), Math.max(MIN, w0 + (x0 - ev.clientX) / zoom)));
    const up = () => { document.body.classList.remove('sh-resizing'); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    document.body.classList.add('sh-resizing');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const o = useDockOpen();
  const w = useRightWidth();
  const narrow = useNarrow();
  const phone = useNarrow(767);
  const sw = narrow ? Math.min(w, window.innerWidth - 24) : w;
  useEffect(() => { setDockOpen(!narrow); }, [narrow]);
  return (
    <>
    <button style={{ ['--dock-w' as string]: `${sw}px` }} className={`sh-dock-toggle${o ? ' on' : ''}`} onClick={() => setDockOpen(!o)}
      title={o ? 'Hide settings' : 'Show settings'} aria-label={o ? 'Hide settings' : 'Show settings'} aria-expanded={o}>
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden><path d={o ? 'M6 3l5 5-5 5' : 'M10 3L5 8l5 5'} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
    </button>
    {narrow && o && <div className="sh-dock-scrim" onClick={() => setDockOpen(false)} />}
    <aside className={`sh-right${narrow ? ' sh-right-sheet' : ''}${o ? '' : ' sh-right-closed'}`} aria-label="Inspector"
      style={narrow && !phone ? { width: sw } : undefined}>
      <div className="sh-grip" role="separator" aria-orientation="vertical" aria-label="Resize the settings column"
        title="Drag to resize · double-click to reset" onPointerDown={start} onDoubleClick={() => setWidth(DEF)}><span /></div>
      <div className="sh-inspector"><Inspector /></div>
    </aside>
    </>
  );
}
