// Floating panel for the Advanced paint brush: FEA fixtures and load faces, matte and gloss areas.
import { useAdvanced } from '../../state/advanced';
import { useStore } from '../../state/store';

const VALUES = [
  { v: 1, label: 'Fixture', color: '#26A69A', tip: 'Held in place in the FEA load case' },
  { v: 2, label: 'Load face', color: '#FF7043', tip: 'Where the load acts (direction and force in the Load case card)' },
  { v: 3, label: 'Matte', color: '#5B6770', tip: 'Outer wall printed for a matte finish (gloss modulation)' },
  { v: 4, label: 'Gloss', color: '#FFFFFF', tip: 'Outer wall printed for a glossy finish (gloss modulation)' },
] as const;

export function AdvPaintPanel() {
  const s = useStore();
  const a = useAdvanced();
  if (s.tool !== 'paint_adv') return null;
  const sel = s.objects.find((o) => o.id === s.selected[0]);
  const clear = () => s.updateObjects((o) => ({ ...o, paint: { ...(o.paint ?? {}), adv: undefined } }), sel ? [sel.id] : s.objects.map((o) => o.id));
  return (
    <div className="float panel">
      <h4>Advanced paint</h4>
      <div className="palette">
        {VALUES.map((x) => (
          <button key={x.v} className={`btn-secondary btn-small ${a.paintValue === x.v ? 'on' : ''}`} title={x.tip} onClick={() => a.set({ paintValue: x.v })}>
            <span className="zone-dot" style={{ background: x.color }} />{x.label}
          </button>
        ))}
      </div>
      <div className="row"><span style={{ flex: 1 }}>Pen size</span><span className="mono">{s.brushSize.toFixed(1)} mm</span></div>
      <input type="range" min={0.4} max={20} step={0.2} value={s.brushSize} onChange={(e) => s.set({ brushSize: +e.target.value })} style={{ width: '100%', accentColor: 'var(--accent)' }} />
      <div className="hint-list">
        <span><kbd>Left drag</kbd> on model: paint</span><span><kbd>Shift + drag</kbd> or <kbd>Alt + drag</kbd> erase</span>
        <span><kbd>Left drag</kbd> off model: rotate · <kbd>Middle</kbd>/<kbd>Right drag</kbd> pan · <kbd>Wheel</kbd> zoom</span>
      </div>
      <div className="row">
        <button className="btn-secondary btn-small" onClick={clear}>{sel ? 'Clear on selected object' : 'Clear on all objects'}</button>
        <span className="spacer" />
        <button className="btn-primary btn-small" onClick={() => s.set({ tool: 'select' })}>Done</button>
      </div>
    </div>
  );
}
