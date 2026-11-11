// Lumonex Studio editor: the selected part's silhouette with handles you drag (out = wider, along = where the
// bulge sits), and the part stack as a strip of chips (select, reorder, duplicate, remove, add). Every drag
// goes straight to the design, so the 3D view follows while you drag.
import { useEffect, useRef, useState } from 'react';
import { swatch } from '../catalog';
import { section, type Section, type SectionRole } from '../model';
import { SILHOUETTES, handleAt } from '../shape';
import { piecesFor } from '../build';
import { bedOf, changed, lx, useLx } from './state';
import { IconButton, Seg, ToolGroup, VSep } from '../../../ui/studio/Studio';

const ROLES: SectionRole[] = ['body', 'shade', 'stem', 'pole', 'base', 'cap', 'deco'];

export function StackEditorHead() {
  useLx();
  const design = lx.design;
  const sel = design.sections.find((s) => s.id === lx.selected) ?? design.sections[0];
  const i = design.sections.indexOf(sel);
  const edit = (f: () => void) => { f(); changed(); };
  return (
    <div className="st-editor-head">
      <span className="st-ttl">Silhouette</span>
      <ToolGroup label="Part">
        <select className="st-sel" value={sel.id} aria-label="Part" onChange={(e) => { lx.selected = e.target.value; changed(false); }}>
          {design.sections.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </ToolGroup>
      <ToolGroup label="Shape">
        <select className="st-sel" value={sel.shape.silhouette} aria-label="Silhouette" onChange={(e) => { const p = SILHOUETTES.find((q) => q.id === e.target.value); if (p) edit(() => { sel.shape.silhouette = p.id; sel.shape.handles = p.handles.slice(); }); }}>
          {SILHOUETTES.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          {sel.shape.silhouette === 'custom' && <option value="custom">Custom (edited)</option>}
        </select>
      </ToolGroup>
      <VSep />
      <ToolGroup label="Stack">
        <button className="st-ib" title="Move up the stack" aria-label="Move up the stack" disabled={i >= design.sections.length - 1} onClick={() => edit(() => { const x = design.sections; [x[i], x[i + 1]] = [x[i + 1], x[i]]; })}>↑</button>
        <button className="st-ib" title="Move down the stack" aria-label="Move down the stack" disabled={i <= 0} onClick={() => edit(() => { const x = design.sections; [x[i], x[i - 1]] = [x[i - 1], x[i]]; })}>↓</button>
        <IconButton icon="plus" title="Duplicate this part" onClick={() => edit(() => { const c = structuredClone(sel); c.id = section({ role: sel.role }).id; c.name = `${sel.name} copy`; design.sections.splice(i + 1, 0, c); lx.selected = c.id; })} />
        <IconButton icon="clear" title="Remove this part" disabled={design.sections.length < 2} onClick={() => edit(() => { design.sections.splice(i, 1); lx.selected = design.sections[Math.max(0, i - 1)].id; })} />
      </ToolGroup>
      <VSep />
      <ToolGroup label="Add part">
        <select className="st-sel" value="" aria-label="Add a part" onChange={(e) => {
          const r = e.target.value as SectionRole;
          if (!r) return;
          edit(() => {
            const top = design.sections.filter((q) => q.attach === 'stack').pop();
            const n = section({ role: r, name: `${r[0].toUpperCase()}${r.slice(1)} ${design.sections.length + 1}`, attach: r === 'shade' ? 'hung' : 'stack' });
            if (top) { n.shape.diameter = top.shape.diameter; n.shape.height = Math.min(200, top.shape.height); }
            design.sections.push(n); lx.selected = n.id;
          });
        }}>
          <option value="">+ part…</option>
          {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
      </ToolGroup>
      <span style={{ flex: 1 }} />
      <ToolGroup label="Handles"><Seg label="Handle count" value={String(sel.shape.handles.length) as '5' | '7' | '9'} options={[['5', '5'], ['7', '7'], ['9', '9']]} onChange={(v) => edit(() => { const n = Number(v), h = sel.shape.handles; sel.shape.handles = Array.from({ length: n }, (_, k) => +handleAt(h, k / (n - 1)).toFixed(3)); sel.shape.silhouette = 'custom'; })} /></ToolGroup>
    </div>
  );
}

export function StackEditorBody() {
  useLx();
  const design = lx.design;
  const sel = design.sections.find((s) => s.id === lx.selected) ?? design.sections[0];
  return (
    <div style={{ position: 'absolute', inset: 0, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 260px', gap: 0 }}>
      <Silhouette s={sel} />
      <PartStrip selected={sel.id} />
    </div>
  );
}

/** Side view of one part: drag a handle sideways to make that height wider or narrower. */
function Silhouette({ s }: { s: Section }) {
  const box = useRef<HTMLDivElement>(null);
  const [sz, setSz] = useState({ w: 800, h: 220 });
  const [drag, setDrag] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => { const el = box.current!; const ro = new ResizeObserver(() => setSz({ w: el.clientWidth, h: el.clientHeight })); ro.observe(el); return () => ro.disconnect(); }, []);
  const sh = s.shape, H = sh.height, R = (sh.diameter / 2) * sh.scaleX;
  const maxH = Math.max(...sh.handles, 1) * 1.15;
  // lay the part on its side: height runs left → right, radius up from the centre line
  // half profile: the centre line along the bottom, radius upwards (twice the room of a mirrored outline)
  const pad = 40, W = sz.w - pad * 2, Hh = sz.h - 60;
  const k = Math.min(W / H, Hh / (R * maxH));
  const x0 = (sz.w - H * k) / 2, cy = 26 + Hh;
  const X = (z: number) => x0 + z * k, Y = (r: number) => cy - r * k;
  const n = 64;
  const pts = Array.from({ length: n + 1 }, (_, i) => { const t = i / n; return [t * H, R * handleAt(sh.handles, t)]; });
  const top = pts.map(([z, r], i) => `${i ? 'L' : 'M'}${X(z).toFixed(1)},${Y(r).toFixed(1)}`).join('');
  const fill = `${top}L${X(H).toFixed(1)},${cy}L${X(0).toFixed(1)},${cy}Z`;
  const hex = swatch(s.material, s.color).hex;
  const bed = bedOf();
  const pieces = piecesFor(s, bed, design().margin);
  const move = (e: React.PointerEvent) => {
    if (drag === null) return;
    const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
    const y = e.clientY - r.top;
    const v = Math.max(0.05, Math.min(1.5, (cy - y) / k / Math.max(1e-6, R)));
    s.shape.handles[drag] = +v.toFixed(3);
    s.shape.silhouette = 'custom';
    changed();
  };
  return (
    <div ref={box} style={{ position: 'relative', minWidth: 0, borderRight: '1px solid var(--ns-line)' }}>
      <svg width={sz.w} height={sz.h} style={{ display: 'block', touchAction: 'none' }} onPointerMove={move} onPointerUp={() => setDrag(null)} onPointerLeave={() => setDrag(null)}>
        {/* bed height marks: where the part is cut into pieces */}
        {Array.from({ length: pieces - 1 }, (_, i) => { const z = ((i + 1) / pieces) * H; return <line key={i} x1={X(z)} x2={X(z)} y1={20} y2={cy} stroke="#e53" strokeDasharray="4 4" strokeWidth={1.2} />; })}
        <line x1={X(0) - 10} x2={X(H) + 10} y1={cy} y2={cy} stroke="var(--ns-line)" strokeDasharray="3 3" />
        <path d={fill} fill={hex} fillOpacity={0.22} stroke="none" />
        <path d={top} fill="none" stroke={hex} strokeWidth={2.4} />
        {sh.handles.map((h, i) => {
          const z = (i / (sh.handles.length - 1)) * H, x = X(z), y = Y(R * h);
          const on = drag === i || hover === i;
          return (
            <g key={i}>
              <line x1={x} x2={x} y1={cy} y2={y} stroke="#2563EB" strokeOpacity={on ? 0.6 : 0.2} strokeDasharray="2 3" />
              <rect x={x - 6} y={y - 6} width={12} height={12} rx={3} fill="var(--ns-panel)" stroke="#2563EB" strokeWidth={on ? 2.6 : 1.8} style={{ cursor: 'ns-resize' }}
                onPointerDown={(e) => { (e.currentTarget.ownerSVGElement as SVGSVGElement).setPointerCapture(e.pointerId); setDrag(i); }}
                onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)}>
                <title>{`Handle ${i + 1}: ${(R * h * 2).toFixed(0)} mm across at ${z.toFixed(0)} mm`}</title>
              </rect>
              {on && <text x={x + 9} y={y - 8} fontSize={10.5} fill="#2563EB" fontFamily="var(--ns-font-mono)">Ø {(R * h * 2).toFixed(0)} mm</text>}
            </g>
          );
        })}
        <text x={X(0)} y={cy + 14} fontSize={10} fill="var(--ns-text-3)" fontFamily="var(--ns-font-mono)">← bottom</text>
        <text x={X(H)} y={cy + 14} fontSize={10} fill="var(--ns-text-3)" textAnchor="end" fontFamily="var(--ns-font-mono)">top · {H.toFixed(0)} mm →</text>
        <text x={12} y={14} fontSize={10.5} fill="var(--ns-text-3)">Drag a handle up or down to widen or narrow the part there{pieces > 1 ? ` · red: cut into ${pieces} pieces for the ${bed.z} mm bed` : ''}</text>
      </svg>
    </div>
  );
}

const design = () => lx.design;

function PartStrip({ selected }: { selected: string }) {
  const d = design();
  // top of the lamp first, like the real stack
  const list = d.sections.slice().reverse();
  return (
    <div style={{ overflowY: 'auto', padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 4 }} aria-label="Part stack">
      <div style={{ fontSize: 10.5, color: 'var(--ns-text-3)' }}>Part stack · top first · click to edit</div>
      {list.map((s) => (
        <button key={s.id} className="st-btn" style={{ justifyContent: 'flex-start', borderColor: s.id === selected ? 'var(--ns-active)' : undefined, boxShadow: s.id === selected ? '0 0 0 1px var(--ns-active)' : undefined }}
          onClick={() => { lx.selected = s.id; changed(false); }}>
          <i style={{ width: 10, height: 10, borderRadius: 5, background: swatch(s.material, s.color).hex, flex: 'none' }} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.name}</span>
          <span style={{ marginLeft: 'auto', color: 'var(--ns-text-3)', fontFamily: 'var(--ns-font-mono)', fontSize: 10.5 }}>{s.shape.height.toFixed(0)} mm{s.attach === 'hung' ? ' · hung' : ''}</span>
        </button>
      ))}
    </div>
  );
}
