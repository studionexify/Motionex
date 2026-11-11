// Last line of error reporting: a tool handler that throws (a button's click, an async action whose promise nobody
// awaits) used to fail silently — nothing on screen, only a console line. Every such error now shows as a toast.
import { useStore } from './store';

/** Browser noise that is not an app failure. */
const IGNORED = [/ResizeObserver loop/i, /^Script error\.?$/i, /\bsuperseded\b/i];

const messageOf = (e: unknown): string => {
  if (e instanceof Error) return e.message || e.name;
  if (typeof e === 'string') return e;
  try { return JSON.stringify(e); } catch { return String(e); }
};

let last = { text: '', at: 0 };

/** Show an unexpected error to the user (deduplicated: the same message within 2 s is shown once). */
export function reportError(e: unknown, context = 'Something went wrong') {
  if ((e as { name?: string } | null)?.name === 'AbortError') return; // a cancelled request is not a failure
  const msg = messageOf(e);
  if (!msg || IGNORED.some((r) => r.test(msg))) return;
  const text = `${context}: ${msg}`;
  const now = Date.now();
  if (text === last.text && now - last.at < 2000) return;
  last = { text, at: now };
  console.error(e);
  useStore.getState().set({ toast: { kind: 'error', text } });
}

/** A chunk of the app that could not be loaded: the web version was updated while this page was open. */
export const STALE_PAGE = 'NexSpiro was updated while this page was open, so this tool could not be loaded. Save your project (Ctrl+S), then reload the page.';

let installed = false;
export function installErrorReporting() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('error', (ev) => reportError(ev.error ?? ev.message));
  window.addEventListener('unhandledrejection', (ev) => reportError(ev.reason));
  // Vite fires this when a lazily loaded chunk (project files, fonts, CAD import…) is gone after a redeploy
  window.addEventListener('vite:preloadError', (ev) => {
    ev.preventDefault();
    useStore.getState().set({ toast: { kind: 'error', text: STALE_PAGE } });
  });
}
