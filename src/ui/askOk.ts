// confirm() that still works where the page can't show dialogs. In a sandboxed frame without modals (the
// web app's preview) confirm() returns false at once without asking, so every "Are you sure?" would block
// the action for good. A real dialog takes the person at least a moment to answer, so an instant "no" is
// read as "no dialog could be shown" and the action goes ahead.
export function askOk(message: string): boolean {
  if (typeof window === 'undefined' || typeof window.confirm !== 'function') return true;
  const t0 = performance.now();
  let ok = false;
  try { ok = window.confirm(message); } catch { return true; }
  return ok || performance.now() - t0 < 40;
}
