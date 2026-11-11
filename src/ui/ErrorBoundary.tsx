// A render error in any panel used to unmount the whole app (blank page). The scene lives in the store, outside
// React, so the fallback can save the project or simply render again without losing the plate.
// If the same error keeps coming back (Try again just re-renders the same state), the fallback offers a way out:
// reset the saved view settings and reload, which never touches the user's own presets.
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { reportError } from '../state/errors';

/** Saved settings that shape what is drawn at start-up. User presets and printer holders are kept. */
const RESETTABLE = ['nexspiro.prefs.v1', 'nexspiro.advanced.v1', 'nexspiro.ui.v1'];

export function resetViewSettings() {
  try { for (const k of RESETTABLE) localStorage.removeItem(k); } catch { /* storage off */ }
}

interface State { error: Error | null; stack: string; tries: number }

export class ErrorBoundary extends Component<{ children: ReactNode; area?: string }, State> {
  state: State = { error: null, stack: '', tries: 0 };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo) {
    const stack = `${error.stack ?? error.message}\n\nComponent:${info.componentStack ?? ''}`;
    this.setState({ stack });
    console.error(`[${this.props.area ?? 'App'}]`, stack);
    reportError(error, `${this.props.area ?? 'The app'} stopped drawing`);
  }
  render() {
    const { error, stack, tries } = this.state;
    if (!error) return this.props.children;
    const stuck = tries >= 1;
    return (
      <div className="page" role="alert" style={{ padding: 24, overflow: 'auto', maxHeight: '100%', pointerEvents: 'auto', position: 'relative', zIndex: 5, background: 'var(--bg, #fff)' }}>
        <h2>{this.props.area ?? 'NexSpiro'} ran into a problem</h2>
        <p className="mono" style={{ whiteSpace: 'pre-wrap' }}>{error.message}</p>
        <p>Your plate is still in memory. Save it first if you want to be safe, then try again.</p>
        {stuck && <p><b>It failed again.</b> Save your project, then use <i>Reset view settings</i>: it clears the saved printer, panel and preview settings that are redrawn at start-up (your own presets are kept) and reloads.</p>}
        <div className="row">
          <button className="btn-primary" onClick={() => this.setState({ error: null, stack: '', tries: tries + 1 })}>Try again</button>
          <button className="btn-secondary" onClick={() => { void import('../state/project').then((m) => m.saveProject()).catch((e) => reportError(e, 'Save failed')); }}>Save project</button>
          <button className="btn-secondary" onClick={() => { resetViewSettings(); location.reload(); }}>Reset view settings</button>
          <button className="btn-secondary" onClick={() => location.reload()}>Reload page</button>
        </div>
        {stack && (
          <details style={{ marginTop: 12 }}>
            <summary>Technical details (copy these when reporting the problem)</summary>
            <pre className="mono" style={{ whiteSpace: 'pre-wrap', fontSize: 11, userSelect: 'text' }}>{stack}</pre>
            <button className="btn-secondary btn-small" onClick={() => { void navigator.clipboard?.writeText(stack); }}>Copy details</button>
          </details>
        )}
      </div>
    );
  }
}
