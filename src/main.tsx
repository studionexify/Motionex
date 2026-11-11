import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
// UI fonts are bundled so the desktop app looks the same offline
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import './styles.css';
import './ui/density.css';
import { installErrorReporting } from './state/errors';

// Orbit controls release pointer capture on every pointer-up; when the capture was already lost (the pointer
// went down on a panel or tool that took it, a window closed mid-drag) the browser throws NotFoundError and the
// app showed "Something went wrong". Releasing a capture that is gone is harmless, so it is ignored.
{
  const release = Element.prototype.releasePointerCapture;
  Element.prototype.releasePointerCapture = function (id: number) {
    if (this.hasPointerCapture && !this.hasPointerCapture(id)) return;
    try { release.call(this, id); } catch { /* capture already gone */ }
  };
}
// Touch: a long press opens the context menu (iOS Safari never fires contextmenu; Android does, so a native one
// arriving right after ours is dropped).
{
  let timer = 0, x = 0, y = 0, fired = 0;
  const clear = () => { clearTimeout(timer); timer = 0; };
  window.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return;
    x = e.clientX; y = e.clientY; clear();
    const t = e.target as Element;
    timer = window.setTimeout(() => {
      fired = performance.now();
      t.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2 }));
    }, 550);
  }, true);
  window.addEventListener('pointermove', (e) => { if (timer && Math.hypot(e.clientX - x, e.clientY - y) > 10) clear(); }, true);
  window.addEventListener('pointerup', clear, true);
  window.addEventListener('pointercancel', clear, true);
  window.addEventListener('contextmenu', (e) => { if (e.isTrusted && performance.now() - fired < 900) { e.preventDefault(); e.stopImmediatePropagation(); } }, true);
}
import { preloadWorkers } from './workers';
import { ErrorBoundary } from './ui/ErrorBoundary';

installErrorReporting();
createRoot(document.getElementById('root')!).render(<StrictMode><ErrorBoundary><App /></ErrorBoundary></StrictMode>);
// keep this version's worker scripts in memory so a redeploy of the web app cannot break this tab
preloadWorkers();

// expose the store for end-to-end tests and debugging from the devtools console
import { useStore } from './state/store';
(window as any).__nxStore = useStore;
