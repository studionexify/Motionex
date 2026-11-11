// Chart editor for the Patternex Studio: a numbered grid you paint cell by cell. The first repeat is drawn solid
// and the following repeats faded, so you see the tiling while painting one tile. Painting a faded repeat edits
// the same cell of the tile. Left drag paints, right drag erases (base colour), fill and pick tools.
import { useEffect, useRef, useState } from 'react';
import { BASE, cellAt, fillCells, paintCells, type ChartSpec } from '../chart';
import { cs, notifyChart, setPaint, setSpec, syncToModel, type ChartTool } from './chartStudio';

const GUTTER_L = 30, GUTTER_T = 18;

export function ChartCanvas({ spec, colour, tool, paint, zoom }: { spec: ChartSpec; colour: (v: number) => string; tool: ChartTool; paint: number; zoom: number }) {
  const wrap = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const [box, setBox] = useState({ w: 800, h: 240 });
  const [hover, setHover] = useState<[number, number] | null>(null);
  const stroke = useRef<{ value: number; last: [number, number] | null } | null>(null);

  useEffect(() => {
    const el = wrap.current!;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // zoom 0 = fit one repeat in the editor's height
  const fit = Math.max(6, Math.min(26, Math.floor((box.h - GUTTER_T - 26) / spec.rows), Math.floor((box.w - GUTTER_L - 20) / spec.cols)));
  const z = zoom > 0 ? zoom : fit;
  const tileW = spec.cols * z, tileH = spec.rows * z;
  // how many repeats fit (at least the whole tile, at most the chart's repeats)
  const repsX = Math.max(1, Math.min(spec.repX, Math.ceil((box.w - GUTTER_L - 12) / tileW) || 1));
  const repsY = Math.max(1, Math.min(spec.repY, Math.ceil((box.h - GUTTER_T - 12) / tileH) || 1));
  const W = Math.max(box.w, GUTTER_L + tileW * repsX + 16), H = Math.max(box.h, GUTTER_T + tileH * repsY + 22);
  // the chart is bottom-anchored: row 0 sits on the bottom edge of the drawn area
  const top = Math.max(GUTTER_T, H - 22 - tileH * repsY);
  const left = Math.max(GUTTER_L, Math.min(GUTTER_L + 24, (W - tileW * repsX) / 2));

  useEffect(() => {
    const c = cv.current!;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = W * dpr; c.height = H * dpr;
    c.style.width = `${W}px`; c.style.height = `${H}px`;
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const css = getComputedStyle(c);
    const ink = css.getPropertyValue('--ns-text-3').trim() || '#A1A1AA';
    const ink2 = css.getPropertyValue('--ns-text-2').trim() || '#52525B';
    const line = css.getPropertyValue('--ns-line').trim() || '#E4E4E7';
    const strong = css.getPropertyValue('--ns-text').trim() || '#18181B';
    const font = css.getPropertyValue('--ns-font-mono').trim() || 'monospace';
    const totalRows = spec.rows * repsY, totalCols = spec.cols * repsX;
    for (let R = 0; R < totalRows; R++) {
      for (let C = 0; C < totalCols; C++) {
        const c0 = C % spec.cols, r0 = R % spec.rows, v = cellAt(spec, c0, r0);
        const x = left + C * z, y = top + (totalRows - 1 - R) * z;
        const primary = C < spec.cols && R < spec.rows;
        g.globalAlpha = primary ? 1 : 0.38;
        g.fillStyle = colour(v);
        g.fillRect(x + 0.5, y + 0.5, z - 1, z - 1);
        if (v === BASE) { g.strokeStyle = line; g.lineWidth = 1; g.strokeRect(x + 0.5, y + 0.5, z - 1, z - 1); }
        if (primary && z >= 12) {
          g.globalAlpha = 1;
          g.fillStyle = v === BASE ? line : textOn(colour(v));
          g.font = `${Math.min(10, z * 0.55)}px ${font}`;
          g.textAlign = 'center'; g.textBaseline = 'middle';
          g.fillText(v === BASE ? '·' : String(v + 1), x + z / 2, y + z / 2 + 0.5);
        }
      }
    }
    g.globalAlpha = 1;
    // numbers: columns on top (1 = left), rows on the left (1 = bottom), like a knitting chart
    g.font = `${Math.min(9.5, Math.max(7, z * 0.6))}px ${font}`;
    g.textBaseline = 'alphabetic';
    const every = z < 10 ? 5 : z < 14 ? 2 : 1;
    for (let C = 0; C < totalCols; C++) {
      const n = (C % spec.cols) + 1;
      if (n % every && n !== 1) continue;
      g.fillStyle = C < spec.cols ? ink2 : ink; g.textAlign = 'center';
      g.fillText(String(n), left + C * z + z / 2, top - 5);
    }
    for (let R = 0; R < totalRows; R++) {
      const n = (R % spec.rows) + 1;
      if (n % every && n !== 1) continue;
      g.fillStyle = R < spec.rows ? ink2 : ink; g.textAlign = 'right';
      g.fillText(String(n), left - 6, top + (totalRows - 1 - R) * z + z / 2 + 3);
    }
    // the tile you edit
    g.strokeStyle = strong; g.lineWidth = 1.5;
    g.strokeRect(left - 0.25, top + (totalRows - spec.rows) * z - 0.25, tileW + 0.5, tileH + 0.5);
    if (hover) {
      const [C, R] = hover;
      g.strokeStyle = '#2563EB'; g.lineWidth = 2;
      g.strokeRect(left + C * z - 0.5, top + (totalRows - 1 - R) * z - 0.5, z + 1, z + 1);
    }
    const more = spec.repX > repsX || spec.repY > repsY;
    g.fillStyle = ink; g.textAlign = 'left'; g.font = `10px ${css.getPropertyValue('--ns-font-ui').trim() || 'sans-serif'}`;
    g.fillText(`${spec.cols} × ${spec.rows} cells · repeats ×${spec.repX} ${spec.projection === 'wrap' ? 'around' : 'across'}${spec.repY > 1 ? `, ×${spec.repY} up` : ''}${more ? ' (faded; more off-screen)' : ' (faded)'}`, left, top + tileH * repsY + 15);
  });

  const cellOf = (e: React.PointerEvent): [number, number] | null => {
    const r = cv.current!.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const totalRows = spec.rows * repsY;
    const C = Math.floor((x - left) / z), R = totalRows - 1 - Math.floor((y - top) / z);
    if (C < 0 || R < 0 || C >= spec.cols * repsX || R >= totalRows) return null;
    return [C, R];
  };
  const tileCell = ([C, R]: [number, number]): [number, number] => [C % spec.cols, R % spec.rows];
  const line = (a: [number, number], b: [number, number]): [number, number][] => {
    const out: [number, number][] = [], n = Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]), 1);
    for (let i = 0; i <= n; i++) out.push([Math.round(a[0] + ((b[0] - a[0]) * i) / n), Math.round(a[1] + ((b[1] - a[1]) * i) / n)]);
    return out;
  };

  const down = (e: React.PointerEvent) => {
    const at = cellOf(e);
    if (!at) return;
    e.preventDefault();
    const [c, r] = tileCell(at);
    const erase = e.button === 2;
    if (tool === 'pick') { setPaint(cellAt(spec, c, r)); return; }
    if (tool === 'fill') { setSpec(fillCells(spec, c, r, erase ? BASE : paint)); return; }
    (e.target as Element).setPointerCapture(e.pointerId);
    const value = erase ? BASE : paint;
    stroke.current = { value, last: at };
    const next = paintCells(spec, [[c, r]], value);
    // one editor undo step per stroke; the model is written when the stroke ends
    if (next !== spec) setSpec(next, { sync: false });
    else { cs.undo.push(spec); cs.redo = []; notifyChart(); }
  };
  const move = (e: React.PointerEvent) => {
    const at = cellOf(e);
    setHover(at);
    const s = stroke.current;
    if (!s || !at) return;
    const pts = (s.last ? line(s.last, at) : [at]).map(tileCell);
    s.last = at;
    const next = paintCells(cs.spec, pts, s.value);
    if (next !== cs.spec) setSpec(next, { history: false, sync: false });
  };
  const up = () => { if (stroke.current) { stroke.current = null; syncToModel(); } };

  return (
    <div ref={wrap} style={{ position: 'absolute', inset: 0, overflow: 'auto' }}>
      <canvas ref={cv} style={{ display: 'block', cursor: tool === 'fill' ? 'cell' : tool === 'pick' ? 'copy' : 'crosshair', touchAction: 'none' }}
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onPointerLeave={() => setHover(null)}
        onContextMenu={(e) => e.preventDefault()} aria-label="Chart: click or drag to paint cells" role="img" />
    </div>
  );
}

function textOn(hex: string) {
  const n = parseInt(hex.slice(1, 7), 16);
  const l = 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
  return l > 150 ? 'rgba(40,40,45,.55)' : 'rgba(255,255,255,.85)';
}
