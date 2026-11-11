// Two views of a rule's motion, each with its own controls:
//  - Top view: the line as the nozzle draws it, seen from above (how far it moves in and out, how long a repeat is);
//  - Side view: the wall unrolled flat, one strip per layer (how the pattern stacks from layer to layer), plus an
//    optional up-and-down movement along the line.
// Edits are the rule's own tuning; the motion in the library stays as it is.
import { useEffect, useRef, useState } from 'react';
import { currentConfig } from '../../../state/slicing';
import { brushAt, effectPhase, placedBrush } from '../modifier';
import type { LayerEffect, MotionBrush } from '../model';
import { tunedBrush, type RuleMotion } from '../select/model';
import { mx } from './MotionexPanel';

type Pattern = 'own' | 'same' | 'flip' | 'steady' | 'back';
const PATTERNS: [Pattern, string, string][] = [
  ['own', "Motion's own", 'Use the layer pattern the motion was designed with'],
  ['same', 'Same every layer', 'Every layer has the same pattern: straight ribs'],
  ['flip', 'Flip', 'Every few layers the pattern jumps by the shift and back: knit, bricks'],
  ['steady', 'Twist', 'Each step slides the pattern on by the shift: diagonal lines'],
  ['back', 'Zigzag', 'Slides on by the shift, then back again: zigzag bands'],
];

const patternOf = (m: RuleMotion): Pattern => (m.layers === undefined ? 'own' : m.layers === null ? 'same' : m.layers.mode === 'alternate' ? 'flip' : m.layers.mode === 'steady' ? 'steady' : 'back');
const effect = (p: Pattern, shift: number, every: number): LayerEffect | null | undefined =>
  p === 'own' ? undefined : p === 'same' ? null : { mode: p === 'flip' ? 'alternate' : p === 'steady' ? 'steady' : 'back_and_forth', shift_deg: shift, every, band_on: 0, band_off: 0 };

const css = (v: string, d: string) => (typeof document === 'undefined' ? d : getComputedStyle(document.body).getPropertyValue(v).trim() || d);

export function MotionTabs({ m, onChange }: { m: RuleMotion; onChange(): void }) {
  const [tab, setTab] = useState<'top' | 'side'>('top');
  const base = mx.library.get(m.brush_id);
  if (!base) return null;
  const tuned = tunedBrush(m, base);
  const b = placedBrush({ scale: m.scale } as never, tuned);
  const set = (f: () => void) => { f(); onChange(); };
  const lh = Number(currentConfig().layer_height) || 0.2;
  const pat = patternOf(m), le = m.layers ?? base.layers ?? null;
  const shift = le?.shift_deg ?? 180, every = Math.max(1, le?.every ?? 1);
  return (
    <div className="sxw-tabs">
      <div className="sxw-tabbar" role="tablist">
        <button role="tab" aria-selected={tab === 'top'} className={tab === 'top' ? 'on' : ''} onClick={() => setTab('top')}>Top view</button>
        <button role="tab" aria-selected={tab === 'side'} className={tab === 'side' ? 'on' : ''} onClick={() => setTab('side')}>Side view</button>
      </div>
      {tab === 'top' ? <>
        <TopCanvas b={b} />
        <Slider label="Wave height" tip="How far the line moves in and out of the wall, before Motion size" value={tuned.amplitude} min={0} max={3} step={0.01} unit="mm" own={m.amp === undefined} onChange={(v) => set(() => { m.amp = v; })} onReset={() => set(() => { m.amp = undefined; })} />
        <Slider label="Wave length" tip="Length of one repeat along the wall, before Motion size" value={tuned.period_mm} min={0.2} max={40} step={0.1} unit="mm" own={m.period === undefined} onChange={(v) => set(() => { m.period = v; })} onReset={() => set(() => { m.period = undefined; })} />
      </> : <>
        <SideCanvas b={b} lh={lh} />
        <div className="sxw-row" title="How the pattern changes from one layer to the next">
          <span className="sxw-lbl">Layers</span>
          <select className="select" value={pat} onChange={(e) => set(() => { m.layers = effect(e.target.value as Pattern, shift, every); })}>
            {PATTERNS.map(([k, label, tip]) => <option key={k} value={k} title={tip}>{label}</option>)}
          </select>
        </div>
        {(pat === 'flip' || pat === 'steady' || pat === 'back') && <>
          <Slider label="Shift" tip="How far the pattern moves at each step, in degrees of one repeat (180 = half a repeat)" value={shift} min={0} max={360} step={5} unit="°" onChange={(v) => set(() => { m.layers = effect(pat, v, every); })} />
          <Slider label="Every" tip="Layers per step" value={every} min={1} max={10} step={1} unit="layers" onChange={(v) => set(() => { m.layers = effect(pat, shift, Math.round(v)); })} />
        </>}
        <div className="sxw-row" title="The nozzle also moves up and down along the line (non-planar). Keep it under the layer height: more can hit the print or leave gaps">
          <label className="sxw-check"><input type="checkbox" checked={(tuned.z_amplitude ?? 0) > 0} onChange={(e) => set(() => { m.z = e.target.checked ? +(lh * 0.4).toFixed(2) : 0; })} />Move up and down</label>
        </div>
        {(tuned.z_amplitude ?? 0) > 0 && <>
          <Slider label="Up and down" tip="Height of the up-and-down movement, before Motion size" value={tuned.z_amplitude ?? 0} min={0.01} max={+(lh * 0.8).toFixed(2)} step={0.01} unit="mm" onChange={(v) => set(() => { m.z = v; })} />
          <p className="sxw-muted">Non-planar: the print-head collision check runs when you press Done. More than about half the layer height ({(lh / 2).toFixed(2)} mm) can leave gaps between layers.</p>
        </>}
      </>}
    </div>
  );
}

function Slider({ label, tip, value, min, max, step, unit, own, onChange, onReset }: { label: string; tip: string; value: number; min: number; max: number; step: number; unit: string; own?: boolean; onChange(v: number): void; onReset?(): void }) {
  return (
    <div className="sxw-row" title={tip}>
      <span className="sxw-lbl">{label}</span>
      <input type="range" min={min} max={max} step={step} value={Math.min(max, Math.max(min, value))} onChange={(e) => onChange(+e.target.value)} />
      <input className="input sxw-num" type="number" min={min} max={max} step={step} value={+value.toFixed(3)} onChange={(e) => { const v = parseFloat(e.target.value); if (Number.isFinite(v)) onChange(Math.min(max, Math.max(min, v))); }} />
      <span className="sxw-unit">{unit}</span>
      {onReset && !own && <button className="btn-secondary btn-small" onClick={onReset} title="Back to the motion's own value">Reset</button>}
    </div>
  );
}

function useCanvas(draw: (g: CanvasRenderingContext2D, w: number, h: number) => void, deps: unknown[]) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    const g = c?.getContext('2d');
    if (!c || !g) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1), w = c.clientWidth || 280, h = c.clientHeight || 110;
    c.width = w * dpr; c.height = h * dpr;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    draw(g, w, h);
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  return ref;
}

/** From above: the plain wall (dashed), the line width band and the moved line, in true proportions (or taller, said so). */
function TopCanvas({ b }: { b: MotionBrush }) {
  const key = JSON.stringify([b.amplitude, b.period_mm, b.curves.lateral_offset, b.curves.along_offset, b.round_mm, b.phase_deg]);
  const ref = useCanvas((g, w, h) => {
    const reps = 3, L = b.period_mm * reps, ppm = (w - 16) / L;
    const n = 400, lat: number[] = [], al: number[] = [];
    let peak = 0;
    for (let k = 0; k <= n; k++) { const q = brushAt({ ...b, layers: null }, (k / n) * L, L, 0, b.period_mm); lat.push(q?.lat ?? 0); al.push(q?.along ?? 0); peak = Math.max(peak, Math.abs(q?.lat ?? 0)); }
    const room = h / 2 - 14, tall = peak * ppm > room ? room / (peak * ppm) : peak * ppm < 8 && peak > 0 ? 8 / (peak * ppm) : 1;
    const y0 = h / 2, lw = 0.42 * ppm * tall;
    g.fillStyle = css('--surface-secondary', '#2a2d34');
    g.fillRect(8, y0 - lw / 2, w - 16, lw);
    g.strokeStyle = css('--text-secondary', '#888'); g.setLineDash([4, 4]); g.lineWidth = 1;
    g.beginPath(); g.moveTo(8, y0); g.lineTo(w - 8, y0); g.stroke(); g.setLineDash([]);
    g.strokeStyle = '#ff3d7f'; g.lineWidth = 2; g.beginPath();
    for (let k = 0; k <= n; k++) { const x = 8 + ((k / n) * L + al[k]) * ppm, y = y0 - lat[k] * ppm * tall; if (k) g.lineTo(x, y); else g.moveTo(x, y); }
    g.stroke();
    g.fillStyle = css('--text-secondary', '#888'); g.font = '10px sans-serif';
    g.fillText('outside ↑', 10, 11); g.fillText('inside ↓', 10, h - 4);
    g.textAlign = 'right';
    g.fillText(`${L.toFixed(1)} mm shown${Math.abs(tall - 1) > 0.05 ? ` · drawn ×${tall.toFixed(1)} ${tall > 1 ? 'taller' : 'flatter'}` : ''}`, w - 10, h - 4);
  }, [key]);
  return <canvas ref={ref} className="sxw-canvas2d" aria-label="Motion seen from above" />;
}

/** The wall unrolled: one strip per layer, bottom up; out = pink, in = dark; the strips move with the up-and-down motion. */
function SideCanvas({ b, lh }: { b: MotionBrush; lh: number }) {
  const key = JSON.stringify([b.amplitude, b.period_mm, b.curves, b.layers, b.z_amplitude, b.phase_deg, lh]);
  const ref = useCanvas((g, w, h) => {
    const rows = 10, reps = 3, L = b.period_mm * reps, cols = 180;
    const rowH = (h - 22) / rows, zScale = rowH / lh;
    const peak = Math.max(1e-6, b.amplitude);
    const pink = [255, 61, 127], dark = [40, 44, 52], mid = [120, 124, 132];
    for (let r = 0; r < rows; r++) {
      if (effectPhase(b.layers, r) === null) continue;
      for (let c = 0; c < cols; c++) {
        const s = ((c + 0.5) / cols) * L, q = brushAt(b, s, L, r, b.period_mm);
        const v = Math.max(-1, Math.min(1, (q?.lat ?? 0) / peak));
        const col = v >= 0 ? mid.map((m, i) => m + (pink[i] - m) * v) : mid.map((m, i) => m + (dark[i] - m) * -v);
        const x = 8 + (c / cols) * (w - 16), y = h - 8 - (r + 1) * rowH - (q?.z ?? 0) * zScale;
        g.fillStyle = `rgb(${col.map(Math.round).join(',')})`;
        g.fillRect(x, y + 1, (w - 16) / cols + 0.6, rowH - 2);
      }
    }
    g.fillStyle = css('--text-secondary', '#888'); g.font = '10px sans-serif';
    g.fillText(`${rows} layers ↑`, 10, 10);
    g.textAlign = 'right'; g.fillText('pink = out, dark = in', w - 10, 10);
  }, [key]);
  return <canvas ref={ref} className="sxw-canvas2d sxw-side" aria-label="Wall unrolled, one strip per layer" />;
}
