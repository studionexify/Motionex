// Side view of the profile: drag points to shape the body, double-click the outline to add a point,
// right-click a point to remove it. The open texture layer's band and reference planes are drawn too.
import { useRef } from 'react';
import { profileFn } from '../shape';
import { pt, changed } from './state';

const W = 280, HPX = 230, PAD = 12;

/** `fill`: grow to the box it sits in (the Studio's editor) instead of the dock's fixed height. */
export function ProfileEditor({ fill = false }: { fill?: boolean } = {}) {
  const ref = useRef<SVGSVGElement>(null);
  const drag = useRef<number | null>(null);
  const s = pt.spec;
  const H = s.height;
  const rMax = Math.max(20, ...s.profile.map((p) => p.r)) * 1.15;
  const k = Math.min((W - 2 * PAD) / (2 * rMax), (HPX - 2 * PAD) / H);
  const cx = W / 2, base = HPX - PAD;
  const X = (r: number) => cx + r * k, Y = (z: number) => base - z * H * k;
  const prof = profileFn(s.profile, s.smooth);
  const n = 80;
  const right = Array.from({ length: n + 1 }, (_, i) => [X(prof(i / n)), Y(i / n)] as const);
  const outline = `M${cx},${base} ` + right.map(([x, y]) => `L${x},${y}`).join(' ') + ` L${cx},${Y(1)} ` + [...right].reverse().map(([x, y]) => `L${2 * cx - x},${y}`).join(' ') + ' Z';
  const layer = s.textures.find((t) => t.id === pt.openLayer);

  const toModel = (e: React.PointerEvent | React.MouseEvent) => {
    const svg = ref.current!;
    const q = new DOMPoint(e.clientX, e.clientY).matrixTransform(svg.getScreenCTM()!.inverse());
    const x = q.x, y = q.y;
    return { r: Math.max(3, Math.abs(x - cx) / k), z: Math.min(1, Math.max(0, (base - y) / (H * k))) };
  };
  const sorted = () => s.profile.sort((a, b) => a.z - b.z);

  return (
    <svg ref={ref} viewBox={`0 0 ${W} ${HPX}`} style={{ width: '100%', ...(fill ? { flex: 1, minHeight: 0, height: '100%' } : { maxHeight: 240 }), background: 'var(--surface-primary)', border: '1px solid var(--border)', borderRadius: 8, touchAction: 'none', cursor: 'crosshair' }}
      onPointerMove={(e) => {
        if (drag.current === null) return;
        const m = toModel(e), p = s.profile[drag.current];
        const first = drag.current === 0, last = drag.current === s.profile.length - 1;
        p.r = +m.r.toFixed(1);
        if (!first && !last) p.z = +Math.min(s.profile[drag.current + 1].z - 0.01, Math.max(s.profile[drag.current - 1].z + 0.01, m.z)).toFixed(3);
        changed();
      }}
      onPointerUp={() => { drag.current = null; }}
      onDoubleClick={(e) => { const m = toModel(e); s.profile.push({ z: +m.z.toFixed(3), r: +prof(m.z).toFixed(1) }); sorted(); changed(); }}>
      <line x1={cx} x2={cx} y1={PAD} y2={base} stroke="var(--border)" strokeDasharray="3 3" />
      <path d={outline} fill="var(--accent-tint)" stroke="var(--accent)" strokeWidth={1.5} />
      {layer && (
        <g>
          <rect x={PAD} width={W - 2 * PAD} y={Y(layer.z1)} height={Math.max(0, Y(layer.z0) - Y(layer.z1))} fill="var(--accent)" opacity={0.08} />
          {layer.planes.map((p, i) => {
            const z = layer.z0 + p.z * (layer.z1 - layer.z0);
            return <g key={i}><line x1={PAD} x2={W - PAD} y1={Y(z)} y2={Y(z)} stroke="var(--warning)" strokeDasharray="4 3" /><text x={PAD + 2} y={Y(z) - 2} fontSize={9} fill="var(--warning)">P{i + 1} {p.shift}°</text></g>;
          })}
        </g>
      )}
      {s.profile.map((p, i) => (
        <circle key={i} cx={X(p.r)} cy={Y(p.z)} r={5} fill="var(--surface-primary)" stroke="var(--accent)" strokeWidth={2} style={{ cursor: 'grab' }}
          onPointerDown={(e) => { (e.target as Element).setPointerCapture(e.pointerId); drag.current = i; e.stopPropagation(); }}
          onContextMenu={(e) => { e.preventDefault(); if (s.profile.length > 2 && i > 0 && i < s.profile.length - 1) { s.profile.splice(i, 1); changed(); } }}>
          <title>{`z ${(p.z * H).toFixed(1)} mm · r ${p.r} mm`}</title>
        </circle>
      ))}
      <text x={W - PAD} y={base - 2} fontSize={9} textAnchor="end" fill="var(--text-muted)">⌀ {(Math.max(...s.profile.map((p) => p.r)) * 2).toFixed(0)} × {H} mm</text>
    </svg>
  );
}
