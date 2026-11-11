// Tooltips: any element with a title shows it after the pointer has rested on it for a second. The title is
// moved to data-tip so the native one never appears. Inside the plugin bar or the print settings the tip opens
// outside the left edge of those panels, over the 3D view, so it never covers the controls.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

interface Tip { text: string; r: DOMRect; /** Left edge of the side panels the element sits in, when it sits in one. */ edge: number | null; /** Right edge of the tool strip, for its buttons. */ bar: number | null }

/** Delay before a tooltip opens (ms). */
const DELAY = 1000;

/** Left edge of the leftmost side panel (plugin bar, else print settings) when `el` is inside either. */
function panelEdge(el: HTMLElement): number | null {
  if (!el.closest('.sh-pdock, .sh-right')) return null;
  const panel = document.querySelector('.sh-pdock') ?? document.querySelector('.sh-right');
  return panel ? panel.getBoundingClientRect().left : null;
}

/** Right edge of the Prepare tool strip when `el` is one of its buttons: those tips open at once, just outside it. */
function barEdge(el: HTMLElement): number | null {
  const bar = el.closest('.sh-stage .toolbar');
  return bar ? bar.getBoundingClientRect().right : null;
}

export function InstantTooltips() {
  const [tip, setTip] = useState<Tip | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let cur: HTMLElement | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const show = (el: HTMLElement | null) => {
      cur = el;
      if (timer) { clearTimeout(timer); timer = null; }
      setTip(null);
      if (!el) return;
      const t = el.getAttribute('title');
      if (t) { el.dataset.tip = t; el.removeAttribute('title'); }
      const text = el.dataset.tip;
      if (!text) return;
      const bar = barEdge(el);
      const open = () => { timer = null; if (el.isConnected) setTip({ text, r: el.getBoundingClientRect(), edge: panelEdge(el), bar }); };
      if (bar !== null) open(); else timer = setTimeout(open, DELAY);
    };
    const over = (e: PointerEvent) => {
      const el = (e.target as Element | null)?.closest?.('[title],[data-tip]') as HTMLElement | null;
      if (el !== cur) show(el);
    };
    const out = (e: PointerEvent) => { if (!e.relatedTarget) show(null); };
    const hide = () => show(null);
    document.addEventListener('pointerover', over, true);
    document.addEventListener('pointerout', out, true);
    document.addEventListener('pointerdown', hide, true);
    document.addEventListener('wheel', hide, { capture: true, passive: true });
    window.addEventListener('blur', hide);
    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener('pointerover', over, true);
      document.removeEventListener('pointerout', out, true);
      document.removeEventListener('pointerdown', hide, true);
      document.removeEventListener('wheel', hide, true);
      window.removeEventListener('blur', hide);
    };
  }, []);
  // below the element, centred; above it when there is no room; kept inside the window
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || !tip) return;
    const w = el.offsetWidth, h = el.offsetHeight, { r, edge, bar } = tip;
    let x: number, y: number;
    if (bar !== null) {
      // tool strip: right beside it, level with the button, never over the strip
      x = bar + 8;
      y = Math.max(4, Math.min(r.top + r.height / 2 - h / 2, innerHeight - h - 4));
    } else if (edge !== null && edge - w - 10 >= 4) {
      // outside the panel's left edge, level with the element
      x = edge - w - 10;
      y = Math.max(4, Math.min(r.top + r.height / 2 - h / 2, innerHeight - h - 4));
    } else {
      x = Math.max(6, Math.min(r.left + r.width / 2 - w / 2, innerWidth - w - 6));
      y = r.bottom + 6 + h > innerHeight - 4 ? r.top - h - 6 : r.bottom + 6;
    }
    el.style.left = `${x}px`;
    el.style.top = `${Math.max(4, y)}px`;
    el.style.visibility = 'visible';
  }, [tip]);
  if (!tip) return null;
  return <div ref={box} className="instant-tip" role="tooltip" style={{ visibility: 'hidden' }}>{tip.text}</div>;
}
