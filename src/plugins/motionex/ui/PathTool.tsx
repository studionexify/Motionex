// Path tools: pick cells of a grid and move their toolpath by hand, out of the wall or in. Two grids use it:
// the woven picture (any motif or imported image; every layer of a pixel moves together) and the unrolled wall
// map of Path sculpt, which works on top of any pattern (motions, lace, Patternex regions, velocity paint, weave).
// The 3D view shows the moved threads at once, and the drool check says when a move reaches too far out to print.
import { useEffect, useMemo, useRef, useState } from 'react';
import { touchAdd } from '../../../ui/TouchMods';
import { changed, mx, useMx } from './MotionexPanel';
import { weaveColours } from './WeavePanel';
import type { SculptSettings } from '../sculpt/model';
import { brush, pickChanged, pickedOf, usePickVersion } from '../sculpt/selection';
import { useStore } from '../../../state/store';

type Mode = 'brush' | 'box' | 'same' | 'all';
const MODES: [Mode, string, string][] = [
  ['brush', 'Brush', 'Paint over pixels to select them'],
  ['box', 'Box', 'Drag a rectangle'],
  ['same', 'Same colour', 'Click a pixel to select its whole patch of one colour'],
  ['all', 'All', 'Select every pixel'],
];

/** Cells of the same colour joined to (x, y), wrapping round the left and right edges. */
function patch(w: number, h: number, colourOf: (i: number) => string, x: number, y: number): number[] {
  const v = colourOf(y * w + x), seen = new Set<number>([y * w + x]), stack = [y * w + x];
  while (stack.length) {
    const i = stack.pop()!, cx = i % w, cy = (i - cx) / w;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = (cx + dx + w) % w, ny = cy + dy;
      if (ny < 0 || ny >= h) continue;
      const j = ny * w + nx;
      if (!seen.has(j) && colourOf(j) === v) { seen.add(j); stack.push(j); }
    }
  }
  return [...seen];
}

export interface MoverGrid {
  /** Tool id (keeps its own picked cells). */
  id: string;
  w: number; h: number;
  /** Colour shown for a cell (rgb 0..255). */
  colour: (i: number) => [number, number, number];
  /** The moves by cell number, mm (+ = out). */
  moves: Record<number, number>;
  /** Edit the moves, then tell the world. */
  edit: (f: (d: Record<number, number>) => void) => void;
  /** Largest move allowed (mm). */
  cap: number;
  title: string;
  intro: string;
  /** Height of a cell relative to its width, for the drawing. */
  cellAspect: number;
  /** Extra line under the controls. */
  footer?: React.ReactNode;
}

export function PixelMover({ id, w: W, h: H, colour, moves: d, edit, cap, title, intro, cellAspect, footer }: MoverGrid) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [mode, setMode] = useState<Mode>('brush');
  const [radius, setRadiusState] = useState(brush.radius);
  const setRadius = (r: number) => { brush.radius = r; setRadiusState(r); };
  usePickVersion();
  const [move, setMove] = useState(0.5);
  const [, bump] = useState(0);
  const drag = useRef<{ x0: number; y0: number; base: Set<number> } | null>(null);
  const S = pickedOf(id, W, H);
  const changedPick = () => { bump((n) => n + 1); if (id === 'sculpt') pickChanged(); };
  const moved = Object.keys(d).length;
  const peak = useMemo(() => Object.values(d).reduce((m, v) => Math.max(m, Math.abs(v)), 0), [d, moved]); // eslint-disable-line react-hooks/exhaustive-deps
  const key = (i: number) => colour(i).join();
  const draw = () => {
    const c = ref.current;
    if (!c) return;
    const k = Math.max(1, Math.min(8, Math.floor(480 / W)));
    c.width = W * k; c.height = H * k;
    const g = c.getContext('2d')!;
    for (let i = 0; i < W * H; i++) {
      const p = colour(i), x = (i % W) * k, y = Math.floor(i / W) * k;
      g.fillStyle = `rgb(${p[0]},${p[1]},${p[2]})`; g.fillRect(x, y, k, k);
      const m = d[i];
      if (m) { g.fillStyle = m > 0 ? `rgba(255,120,30,${Math.min(0.85, 0.25 + Math.abs(m) / cap)})` : `rgba(40,120,255,${Math.min(0.85, 0.25 + Math.abs(m) / cap)})`; g.fillRect(x, y, k, k); }
    }
    g.strokeStyle = '#fff'; g.lineWidth = Math.max(1, k / 4); g.setLineDash([Math.max(2, k / 2), Math.max(2, k / 2)]);
    for (const i of S) { const x = (i % W) * k, y = Math.floor(i / W) * k; g.strokeRect(x + 0.5, y + 0.5, k - 1, k - 1); }
  };
  useEffect(draw); // eslint-disable-line react-hooks/exhaustive-deps

  const cell = (e: React.PointerEvent): [number, number] => {
    const r = ref.current!.getBoundingClientRect();
    return [Math.max(0, Math.min(W - 1, Math.floor(((e.clientX - r.left) / r.width) * W))), Math.max(0, Math.min(H - 1, Math.floor(((e.clientY - r.top) / r.height) * H)))];
  };
  const paint = (cx: number, cy: number) => {
    for (let y = cy - radius + 1; y < cy + radius; y++) for (let x = cx - radius + 1; x < cx + radius; x++) {
      if (x < 0 || y < 0 || x >= W || y >= H || (x - cx) ** 2 + (y - cy) ** 2 >= radius * radius + 0.5) continue;
      S.add(y * W + x);
    }
  };
  const onDown = (e: React.PointerEvent) => {
    ref.current!.setPointerCapture(e.pointerId);
    const [x, y] = cell(e);
    if (!e.shiftKey && !touchAdd()) S.clear();
    if (mode === 'brush') paint(x, y);
    else if (mode === 'box') drag.current = { x0: x, y0: y, base: new Set(S) };
    else if (mode === 'same') for (const i of patch(W, H, key, x, y)) S.add(i);
    changedPick();
  };
  const onMove = (e: React.PointerEvent) => {
    if (e.buttons !== 1) return;
    const [x, y] = cell(e);
    if (mode === 'brush') paint(x, y);
    else if (mode === 'box' && drag.current) {
      const b = drag.current;
      S.clear(); b.base.forEach((i) => S.add(i));
      for (let yy = Math.min(b.y0, y); yy <= Math.max(b.y0, y); yy++) for (let xx = Math.min(b.x0, x); xx <= Math.max(b.x0, x); xx++) S.add(yy * W + xx);
    }
    changedPick();
  };
  const onUp = () => { drag.current = null; };
  /** Set the picked cells to `value` mm (0 removes the move). */
  const apply = (value: number) => edit((m) => { for (const i of S) { if (Math.abs(value) < 1e-6) delete m[i]; else m[i] = value; } });
  const selectAll = () => { for (let i = 0; i < W * H; i++) S.add(i); changedPick(); };

  return (
    <details className="mx-more" open={moved > 0 || S.size > 0}>
      <summary className="mx-label" style={{ cursor: 'pointer' }}>{title}{moved ? ` · ${moved} cell${moved === 1 ? '' : 's'} moved` : ''}</summary>
      <div className="mx-muted" style={{ margin: 0, display: 'block' }}>{intro}</div>
      <div className="seg mx-seg">
        {MODES.map(([m, l, t]) => <button key={m} className={mode === m ? 'on' : ''} title={t} onClick={() => { setMode(m); if (m === 'all') selectAll(); }}>{l}</button>)}
      </div>
      {mode === 'brush' && (
        <label className="mx-field">Brush size: {radius} cell{radius === 1 ? '' : 's'}
          <input type="range" min={1} max={6} step={1} value={radius} onChange={(e) => setRadius(+e.target.value)} />
        </label>
      )}
      <div style={{ background: 'var(--panel-2, #222)', borderRadius: 6, padding: 4 }}>
        <canvas ref={ref} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
          style={{ width: '100%', imageRendering: 'pixelated', aspectRatio: `${W} / ${Math.max(1, H * cellAspect)}`, display: 'block', cursor: 'crosshair', touchAction: 'none' }}
          aria-label={`${title}: pick cells to move`} title="Shift adds to the selection. Orange = moved out, blue = moved in." />
      </div>
      <div className="mx-muted" style={{ margin: 0, display: 'block' }}>{S.size ? `${S.size} cell${S.size === 1 ? '' : 's'} picked` : 'Nothing picked yet'} · orange = out, blue = in</div>
      <label className="mx-field">Move picked: {move > 0 ? '+' : ''}{move.toFixed(2)} mm {move > 0 ? 'out' : move < 0 ? 'in' : ''}
        <input type="range" min={-cap} max={cap} step={0.05} value={move} onChange={(e) => { const v = +e.target.value; setMove(v); if (S.size) apply(v); }} />
      </label>
      <div className="row" style={{ gap: 6, margin: 0, flexWrap: 'wrap' }}>
        <button className="btn-primary btn-small" disabled={!S.size} onClick={() => apply(move)}>Move picked</button>
        <button className="btn-secondary btn-small" disabled={!S.size} onClick={() => apply(0)} title="Put the picked cells back on the wall">Reset picked</button>
        <button className="btn-secondary btn-small" disabled={!S.size} onClick={() => { S.clear(); changedPick(); }}>Pick none</button>
        <button className="btn-secondary btn-small" disabled={!moved} onClick={() => edit((m) => { for (const k of Object.keys(m)) delete m[+k]; })}>Clear all moves</button>
      </div>
      {moved > 0 && <div className="mx-check"><span className={peak >= cap ? 'bad' : 'ok'}>↔</span>Largest hand move {peak.toFixed(2)} mm (limit {cap.toFixed(1)} mm)</div>}
      {footer}
    </details>
  );
}

/** Weave: pixels of the woven picture. */
export function PathTool() {
  useMx();
  const w = mx.weave;
  const colours = weaveColours(w);
  const stale = !!w.nudge && (w.nudge.w !== w.image.w || w.nudge.h !== w.image.h);
  const moves = !stale && w.nudge ? w.nudge.d : {};
  return (
    <PixelMover id="weave" w={w.image.w} h={w.image.h} colour={(i) => colours[w.image.px[i]] ?? [128, 128, 128]} moves={moves}
      cap={w.max_deviation_mm > 0 ? w.max_deviation_mm : 6} cellAspect={0.45} title="Move the path by hand"
      intro="Pick pixels of the picture, then push their toolpath out of the wall or pull it in. Every layer of those pixels moves together. Works on any motif or picture you load."
      edit={(f) => { if (!w.nudge || stale) w.nudge = { w: w.image.w, h: w.image.h, d: {} }; f(w.nudge.d); changed(); }}
      footer={stale ? <div className="mx-muted bad" style={{ margin: 0, display: 'block' }}>The picture changed size, so the earlier moves no longer fit and are ignored. <button className="btn-secondary btn-small" onClick={() => { delete w.nudge; changed(); }}>Clear them</button></div> : undefined} />
  );
}

/** Path sculpt: the unrolled wall, on top of any pattern. */
export function SculptCard() {
  useMx();
  const s = mx.sculpt;
  const under = useMemo(() => underlay(), [mx.weave.image, mx.weave.enabled, mx.weave.tiles_around, mx.lace.enabled, mx.lace.pattern]); // eslint-disable-line react-hooks/exhaustive-deps
  const cols = (i: number): [number, number, number] => {
    const x = i % s.w, y = Math.floor(i / s.w);
    const v = under ? under(x / s.w, y / s.h) : ((x >> 3) + (y >> 3)) % 2 ? 72 : 60;
    return typeof v === 'number' ? [v, v, v] : v;
  };
  return (
    <section className="mx-card">
      <div className="mx-card-title">Path sculpt<span className="spacer" />
        <button className={`toggle ${s.enabled ? 'on' : ''}`} aria-label={s.enabled ? 'Turn off' : 'Turn on'} onClick={() => { s.enabled = !s.enabled; changed(); }} />
      </div>
      {!s.enabled && <div className="mx-muted" style={{ margin: 0, display: 'block' }}>Move the outer wall by hand, anywhere, on top of any pattern: motions, weave, lace, Patternex regions or velocity paint. You pick cells on the unrolled wall and push them out or pull them in.</div>}
      {s.enabled && (
        <>
          <PickOnModel />
          <PixelMover id="sculpt" w={s.w} h={s.h} colour={cols} moves={s.d} cap={s.max_mm > 0 ? s.max_mm : 6} cellAspect={0.5} title="Unrolled wall"
            intro="The wall cut open and laid flat: left to right is once round the part from +X, top is the top of the band. Pick cells and move them. Moves blend smoothly between cells and apply under every other pattern."
            edit={(f) => { f(s.d); changed(); }} />
          <label className="mx-field">Largest move: {s.max_mm.toFixed(1)} mm
            <input type="range" min={0.2} max={6} step={0.1} value={s.max_mm} onChange={(e) => { s.max_mm = +e.target.value; changed(); }} />
          </label>
          <div className="mx-two">
            <label className="mx-field">Band from (mm)<input className="input" type="number" min={0} step={0.5} value={s.z_start} onChange={(e) => { s.z_start = Math.max(0, +e.target.value); changed(); }} /></label>
            <label className="mx-field">to (mm)<input className="input" type="number" min={0} step={0.5} value={s.z_end >= 1e4 ? '' : s.z_end} placeholder="top" onChange={(e) => { s.z_end = e.target.value === '' ? 1e4 : +e.target.value; changed(); }} /></label>
          </div>
          <div className="mx-two">
            <label className="mx-field">Columns<input className="input" type="number" min={8} max={180} value={s.w} onChange={(e) => resize(s, Math.max(8, Math.min(180, Math.round(+e.target.value) || s.w)), s.h)} /></label>
            <label className="mx-field">Rows<input className="input" type="number" min={4} max={120} value={s.h} onChange={(e) => resize(s, s.w, Math.max(4, Math.min(120, Math.round(+e.target.value) || s.h)))} /></label>
          </div>
        </>
      )}
    </section>
  );
}

/** New grid size: the moves are resampled so the shape stays. */
function resize(s: SculptSettings, w: number, h: number) {
  const d: Record<number, number> = {};
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = s.d[Math.min(s.h - 1, Math.floor((y / h) * s.h)) * s.w + Math.min(s.w - 1, Math.floor((x / w) * s.w))];
    if (v) d[y * w + x] = v;
  }
  s.w = w; s.h = h; s.d = d; changed();
}

/** What is printed there, to see the moves against: the weave picture when it is on, else the lace cells. */
function underlay(): ((u: number, t: number) => number | [number, number, number]) | null {
  const w = mx.weave;
  if (w.enabled) {
    const colours = weaveColours(w);
    return (u, t) => { const x = Math.floor(((u * Math.max(1, w.tiles_around)) % 1) * w.image.w), y = Math.min(w.image.h - 1, Math.floor(t * w.image.h)); return colours[w.image.px[y * w.image.w + x]] ?? 70; };
  }
  return null;
}

/** Switch on picking directly on the 3D model. */
function PickOnModel() {
  const tool = useStore((st) => st.tool);
  const on = tool === 'sculpt_pick';
  return (
    <div className="row" style={{ gap: 8, margin: 0, alignItems: 'center', flexWrap: 'wrap' }}>
      <button className={`btn-small ${on ? 'btn-primary' : 'btn-secondary'}`} aria-pressed={on} title="Drag over the model to pick the part of the wall to move. Shift unpicks. Esc leaves the tool."
        onClick={() => useStore.getState().set({ tool: on ? 'select' : 'sculpt_pick', workspace: 'prepare', liveToolpaths: true })}>
        {on ? 'Picking on the model… (Esc to stop)' : 'Pick on the model'}
      </button>
      <span className="mx-muted" style={{ display: 'block', margin: 0 }}>Drag over the model. Shift unpicks. Uses the brush size below.</span>
    </div>
  );
}
