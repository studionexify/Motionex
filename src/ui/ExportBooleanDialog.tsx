// Asks how to export objects whose positive / negative parts overlap the body. Mounts itself on demand, so no App wiring is needed.
import { createRoot } from 'react-dom/client';
import { useState } from 'react';

export type ExportMode = 'boolean' | 'raw';

function Dialog({ busy, onPick }: { busy?: boolean; onPick: (m: ExportMode | null) => void }) {
  const [wait] = useState(busy);
  return (
    <div role="dialog" aria-modal="true" aria-label="Export STL" onPointerDown={(e) => e.stopPropagation()}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 10000, display: 'grid', placeItems: 'center' }}>
      <div className="modal" style={{ background: 'var(--panel, #2b2f33)', color: 'var(--text, #eee)', borderRadius: 10, padding: 20, width: 420, boxShadow: '0 12px 40px rgba(0,0,0,.4)' }}>
        <h3 style={{ margin: '0 0 8px' }}>Export STL</h3>
        <p style={{ margin: '0 0 14px', fontSize: 13, lineHeight: 1.5 }}>
          This model has positive or negative parts that overlap the body. Apply the boolean first so the STL is one clean solid?
        </p>
        <div style={{ display: 'grid', gap: 8 }}>
          <button className="btn-primary" disabled={wait} onClick={() => onPick('boolean')}>Apply boolean and export (merge positive parts, cut negative parts)</button>
          <button className="btn-secondary" onClick={() => onPick('raw')}>Export without boolean (body and positive parts as separate shells)</button>
          <button className="btn-secondary" onClick={() => onPick(null)}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

export function askExportMode(): Promise<ExportMode | null> {
  return new Promise((resolve) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const done = (m: ExportMode | null) => { root.unmount(); host.remove(); resolve(m); };
    root.render(<Dialog onPick={done} />);
  });
}
