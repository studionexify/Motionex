// Import feedback: a "Loading file…" window with a progress bar and Cancel while a model or project is read,
// and the "this file is for another printer" question (Switch now / Keep current / Cancel), like Bambu Studio.
import { useState } from 'react';
import { create } from 'zustand';

const KEY = 'nexspiro.printerSwitchChoice';
const saved = (): Choice | null => { try { const v = localStorage.getItem(KEY); return v === 'switch' || v === 'keep' ? v : null; } catch { return null; } };
/** The remembered answer to the different-printer question, or null when it asks. */
export const printerSwitchChoice = saved;
/** Forget the remembered answer (asks again on the next import). */
export function resetPrinterSwitchChoice() { try { localStorage.removeItem(KEY); } catch { /* storage off */ } }

type Choice = 'switch' | 'keep' | 'cancel';
interface ImportUi {
  loading: { name: string; progress: number; stage: string } | null;
  cancelled: boolean;
  ask: { file: string; fileModel: string; current: string; resolve: (c: Choice) => void } | null;
}
export const useImportUi = create<ImportUi>(() => ({ loading: null, cancelled: false, ask: null }));

/** Starts the loading window for a file. */
export function importStart(name: string) { useImportUi.setState({ loading: { name, progress: 0, stage: 'Opening' }, cancelled: false }); }
/** Updates the bar and lets the browser paint it. */
export async function importProgress(progress: number, stage: string) {
  const l = useImportUi.getState().loading;
  if (l) useImportUi.setState({ loading: { ...l, progress, stage } });
  await new Promise((r) => setTimeout(r, 0));
}
export function importDone() { useImportUi.setState({ loading: null }); }
export const importCancelled = () => useImportUi.getState().cancelled;

/** Asks whether to switch to the printer the file was made for. */
export function askPrinterSwitch(file: string, fileModel: string, current: string): Promise<Choice> {
  const remembered = saved();
  if (remembered) return Promise.resolve(remembered);
  return new Promise((resolve) => useImportUi.setState({ ask: { file, fileModel, current, resolve: (c) => { useImportUi.setState({ ask: null }); resolve(c); } } }));
}

export function ImportDialogHost() {
  const { loading, ask, cancelled } = useImportUi();
  const [dontAsk, setDontAsk] = useState(false);
  const pick = (c: Choice) => {
    if (dontAsk && c !== 'cancel') { try { localStorage.setItem(KEY, c); } catch { /* storage off */ } }
    setDontAsk(false);
    ask!.resolve(c);
  };
  if (ask) return (
    <div className="imp-back" role="dialog" aria-modal="true" aria-label="Printer of the file">
      <div className="imp-win">
        <div className="imp-head">Different printer<button className="imp-x" aria-label="Cancel" onClick={() => ask.resolve('cancel')}>×</button></div>
        <div className="imp-body">
          <p><b>{ask.file}</b> was made for the <b>{ask.fileModel}</b>. The plate is set up for the <b>{ask.current}</b>.</p>
          <p className="imp-muted">Switch to keep the file's plates and positions exactly as they were made. Keep current keeps your printer; objects still go where the file puts them when the beds are the same size.</p>
        </div>
        <div className="imp-foot">
          <label className="imp-dont"><input type="checkbox" checked={dontAsk} onChange={(e) => setDontAsk(e.target.checked)} />Don't show again</label>
          <button className="btn-secondary" onClick={() => pick('cancel')}>Cancel</button>
          <button className="btn-secondary" onClick={() => pick('keep')}>Keep {ask.current}</button>
          <button className="btn-primary" onClick={() => pick('switch')} autoFocus>Switch to {ask.fileModel}</button>
        </div>
      </div>
    </div>
  );
  if (!loading) return null;
  return (
    <div className="imp-back" role="dialog" aria-modal="true" aria-label="Loading">
      <div className="imp-win">
        <div className="imp-head">Loading…</div>
        <div className="imp-body">
          <p>Loading file: <b>{loading.name}</b></p>
          <div className="imp-bar"><i style={{ width: `${Math.round(Math.max(0.03, loading.progress) * 100)}%` }} /></div>
          <p className="imp-muted">{cancelled ? 'Cancelling…' : loading.stage}</p>
        </div>
        <div className="imp-foot"><button className="btn-secondary" disabled={cancelled} onClick={() => useImportUi.setState({ cancelled: true })}>Cancel</button></div>
      </div>
    </div>
  );
}
