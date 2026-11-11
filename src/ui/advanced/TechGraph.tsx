// Engine node graph for power users: the fields each active technology reads, the pipeline stage it
// runs in, and the path to G-code. Click a technology to edit its parameters.
import { useMemo, useState } from 'react';
import type { Stage } from '../../engine/advanced/techs';
import type { TechId } from '../../engine/advanced/types';
import { Modal } from '../Modals';
import { useResolved } from './hooks';
import { TechDetail, useLastReport } from './ToolList';

const FIELD_NAMES: Record<string, string> = {
  sdf: 'Signed distance f', stress: 'Stress tensor σ', regions: 'Layer regions', heightmap: 'Surface height map', layer_times: 'Layer times',
  moves: 'Move list', bosses: 'Bosses', compliance: 'Compliance field', materials: 'Material regions', overhang: 'Overhang field',
  displacement: 'Thermal displacement u', gloss_paint: 'Gloss paint', zones: 'Zone map', walls: 'Walls', helical_bands: 'Helical bands',
  harmonic: 'Harmonic φ', core: 'Core volume', metric: 'Metric gᵢⱼ', caustic_image: 'Target image', sections: 'Cross-sections',
};
const STAGES: { id: Stage; name: string }[] = [
  { id: 'fields', name: 'Field solvers' }, { id: 'route', name: 'Router' }, { id: 'layers', name: 'Layer plan' }, { id: 'regions', name: 'Regions' },
  { id: 'walls', name: 'Walls' }, { id: 'infill', name: 'Infill' }, { id: 'post', name: 'Toolpath passes' }, { id: 'rheology', name: 'Rheology' }, { id: 'motion', name: 'Motion' },
];

export function TechGraph({ onClose }: { onClose: () => void }) {
  const resolved = useResolved();
  const last = useLastReport();
  const active = resolved.filter((r) => r.enabled && r.verdict.status !== 'unavailable');
  const [sel, setSel] = useState<TechId | null>(active[0]?.def.id ?? null);
  const g = useMemo(() => {
    const order = STAGES.map((s) => s.id);
    const techs = active.slice().sort((a, b) => order.indexOf(a.def.stage) - order.indexOf(b.def.stage) || a.def.n - b.def.n);
    const fields = [...new Set(techs.flatMap((t) => t.def.reads))];
    const stages = STAGES.filter((s) => techs.some((t) => t.def.stage === s.id));
    const ROW = 24, top = 18;
    const height = Math.max(fields.length, techs.length, stages.length + 1) * ROW + top * 2;
    const col = (n: number) => (height - n * ROW) / 2;
    const fy = new Map(fields.map((f, i) => [f, col(fields.length) + i * ROW + ROW / 2]));
    const ty = new Map(techs.map((t, i) => [t.def.id, col(techs.length) + i * ROW + ROW / 2]));
    const sy = new Map(stages.map((s, i) => [s.id, col(stages.length) + i * ROW + ROW / 2]));
    return { techs, fields, stages, fy, ty, sy, height };
  }, [active]);
  const X = { f: 8, fw: 150, t: 230, tw: 230, s: 540, sw: 120, g: 700 };
  const curve = (x0: number, y0: number, x1: number, y1: number) => `M${x0},${y0} C${(x0 + x1) / 2},${y0} ${(x0 + x1) / 2},${y1} ${x1},${y1}`;
  const selected = resolved.find((r) => r.def.id === sel);
  return (
    <Modal title="Engine graph — part data → active tool parts → stages → G-code" onClose={onClose}>
      {!g.techs.length ? <div className="empty-hint">No technology is active for this intent and machine.</div> : (
        <svg className="tech-graph" viewBox={`0 0 760 ${g.height}`} width="100%" role="img" aria-label="Engine node graph">
          {g.techs.map((t) => t.def.reads.map((f) => (
            <path key={`${f}-${t.def.id}`} d={curve(X.f + X.fw, g.fy.get(f)!, X.t, g.ty.get(t.def.id)!)} className={`edge ${sel === t.def.id ? 'hot' : ''}`} />
          )))}
          {g.techs.map((t) => <path key={`s-${t.def.id}`} d={curve(X.t + X.tw, g.ty.get(t.def.id)!, X.s, g.sy.get(t.def.stage)!)} className={`edge ${sel === t.def.id ? 'hot' : ''}`} />)}
          {g.stages.map((s) => <path key={`g-${s.id}`} d={curve(X.s + X.sw, g.sy.get(s.id)!, X.g, g.height / 2)} className="edge" />)}
          {g.fields.map((f) => (
            <g key={f} transform={`translate(${X.f},${g.fy.get(f)! - 9})`}><rect width={X.fw} height={18} rx={9} className="node field" /><text x={10} y={13}>{FIELD_NAMES[f] ?? f}</text></g>
          ))}
          {g.techs.map((t) => {
            const rep = last?.get(t.def.id);
            return (
              <g key={t.def.id} transform={`translate(${X.t},${g.ty.get(t.def.id)! - 9})`} className="clickable" onClick={() => setSel(t.def.id)}>
                <rect width={X.tw} height={18} rx={4} className={`node tech ${sel === t.def.id ? 'sel' : ''} ${rep?.status ?? t.verdict.status}`} />
                <text x={8} y={13}>{String(t.def.n).padStart(2, '0')} {t.def.name.length > 34 ? t.def.name.slice(0, 33) + '…' : t.def.name}</text>
              </g>
            );
          })}
          {g.stages.map((s) => (
            <g key={s.id} transform={`translate(${X.s},${g.sy.get(s.id)! - 9})`}><rect width={X.sw} height={18} rx={4} className="node stage" /><text x={8} y={13}>{s.name}</text></g>
          ))}
          <g transform={`translate(${X.g},${g.height / 2 - 11})`}><rect width={52} height={22} rx={11} className="node gcode" /><text x={9} y={15}>G-code</text></g>
        </svg>
      )}
      {selected && (
        <div className="graph-detail">
          <div className="adv-h">{String(selected.def.n).padStart(2, '0')} · {selected.def.name}</div>
          <TechDetail r={selected} rep={last?.get(selected.def.id)} />
        </div>
      )}
    </Modal>
  );
}
