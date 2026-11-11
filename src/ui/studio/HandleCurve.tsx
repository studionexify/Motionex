// A profile drawn from evenly spaced handles you drag up and down (thickness along a body, radius up a part).
// Used by Studio editors; the curve through the handles is a Catmull-Rom spline, like the builders use.
import { useEffect, useRef, useState } from 'react';

const cr = (h: number[], t: number) => {
  const n = h.length - 1, x = Math.min(1, Math.max(0, t)) * n, i = Math.min(n - 1, Math.floor(x)), u = x - i;
  const p0 = h[Math.max(0, i - 1)], p1 = h[i], p2 = h[i + 1], p3 = h[Math.min(n, i + 2)];
  return 0.5 * (2 * p1 + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u * u + (-p0 + 3 * p1 - 3 * p2 + p3) * u * u * u);
};

export function HandleCurve({ values, min, max, onChange, onCommit, color = '#2563EB', mirror = false, startLabel, endLabel, valueLabel, hint }: {
  values: number[]; min: number; max: number;
  /** Live while dragging. */
  onChange: (i: number, v: number) => void;
  /** Once the drag ends. */
  onCommit?: () => void;
  color?: string;
  /** Draw the shape mirrored about the centre line (a body seen from above). */
  mirror?: boolean;
  startLabel: string; endLabel: string;
  valueLabel: (v: number, i: number) => string;
  hint?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [sz, setSz] = useState({ w: 800, h: 220 });
  const [drag, setDrag] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => { const el = box.current!; const ro = new ResizeObserver(() => setSz({ w: el.clientWidth, h: el.clientHeight })); ro.observe(el); return () => ro.disconnect(); }, []);
  const padX = 44, top = 24, bottom = 22;
  const W = sz.w - padX * 2, H = sz.h - top - bottom;
  const cy = mirror ? top + H / 2 : top + H;
  const span = mirror ? H / 2 - 4 : H - 4;
  const X = (t: number) => padX + t * W;
  const Y = (v: number) => cy - (v / max) * span;
  const n = 96;
  const pts = Array.from({ length: n + 1 }, (_, i) => [X(i / n), Y(Math.max(min, cr(values, i / n)))] as const);
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('');
  const area = mirror
    ? line + pts.slice().reverse().map(([x, y]) => `L${x.toFixed(1)},${(2 * cy - y).toFixed(1)}`).join('') + 'Z'
    : `${line}L${X(1)},${cy}L${X(0)},${cy}Z`;
  const move = (e: React.PointerEvent<SVGSVGElement>) => {
    if (drag === null) return;
    const r = e.currentTarget.getBoundingClientRect();
    const v = Math.max(min, Math.min(max, ((cy - (e.clientY - r.top)) / span) * max));
    onChange(drag, +v.toFixed(3));
  };
  const end = () => { if (drag !== null) { setDrag(null); onCommit?.(); } };
  return (
    <div ref={box} style={{ position: 'absolute', inset: 0 }}>
      <svg width={sz.w} height={sz.h} style={{ display: 'block', touchAction: 'none' }} onPointerMove={move} onPointerUp={end} onPointerCancel={end}>
        <line x1={X(0) - 8} x2={X(1) + 8} y1={cy} y2={cy} stroke="var(--ns-line)" strokeDasharray="3 3" />
        <path d={area} fill={color} fillOpacity={0.14} />
        <path d={line} fill="none" stroke={color} strokeWidth={2.2} />
        {mirror && <path d={pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${(2 * cy - y).toFixed(1)}`).join('')} fill="none" stroke={color} strokeOpacity={0.35} strokeWidth={1.4} />}
        {values.map((v, i) => {
          const x = X(i / (values.length - 1)), y = Y(v), on = drag === i || hover === i;
          return (
            <g key={i}>
              <line x1={x} x2={x} y1={cy} y2={y} stroke={color} strokeOpacity={on ? 0.55 : 0.18} strokeDasharray="2 3" />
              <rect x={x - 6} y={y - 6} width={12} height={12} rx={3} fill="var(--ns-panel)" stroke={color} strokeWidth={on ? 2.6 : 1.8} style={{ cursor: 'ns-resize' }}
                onPointerDown={(e) => { (e.currentTarget.ownerSVGElement as SVGSVGElement).setPointerCapture(e.pointerId); setDrag(i); }}
                onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)}>
                <title>{valueLabel(v, i)}</title>
              </rect>
              {on && <text x={x + 9} y={y - 8} fontSize={10.5} fill={color} fontFamily="var(--ns-font-mono)">{valueLabel(v, i)}</text>}
            </g>
          );
        })}
        <text x={X(0)} y={sz.h - 6} fontSize={10} fill="var(--ns-text-3)" fontFamily="var(--ns-font-mono)">← {startLabel}</text>
        <text x={X(1)} y={sz.h - 6} fontSize={10} fill="var(--ns-text-3)" textAnchor="end" fontFamily="var(--ns-font-mono)">{endLabel} →</text>
        {hint && <text x={12} y={14} fontSize={10.5} fill="var(--ns-text-3)">{hint}</text>}
      </svg>
    </div>
  );
}
