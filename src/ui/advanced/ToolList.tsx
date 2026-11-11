// The Advanced tools: one toggle per job (smooth curved surfaces, hide seams, strength infill…), what
// the tool does when it is on, the technologies it runs as ticks underneath (one mode for an exclusive
// tool), the machine verdict and last-slice status, and each technology's settings for power users.
import type { ParamSpec, ResolvedTech } from '../../engine/advanced/techs';
import { TOOL_GROUPS, TOOL_OF_TECH, TOOLS } from '../../engine/advanced/tools';
import type { ParamValue, TechId, TechReport } from '../../engine/advanced/types';
import { resetAllTools, resetTech, resetTool, setTech, setTool, useAdvanced } from '../../state/advanced';
import { useStore } from '../../state/store';
import { Icon } from '../icons';
import { useTools, type ResolvedTool } from './hooks';

const STATUS_LABEL: Record<string, string> = { applied: 'Applied', adapted: 'Adapted', idle: 'Idle', disabled: 'Off', unavailable: 'N/A' };

/** Last slice's report for this technology, when the slice is current. */
export function useLastReport(): Map<TechId, TechReport> | null {
  const sl = useStore((s) => s.slice);
  if (sl.status !== 'done' || !sl.result?.advanced || sl.dirty) return null;
  return new Map(sl.result.advanced.techs.map((t) => [t.id, t]));
}

/** Tool name and technology name, for reports ("Hide seams › Scarf seam joint"). */
export function techLabel(r: { name: string; id: TechId }) {
  const tool = TOOL_OF_TECH[r.id];
  return tool && tool.techs.length > 1 ? `${tool.name} › ${r.name}` : tool?.name ?? r.name;
}

/** A part's chip inside its tool: how the last slice went, else whether this machine adapts or rules it out. */
function PartChip({ r, rep }: { r: ResolvedTech; rep?: TechReport }) {
  const cls = rep?.status ?? (r.verdict.status === 'ok' ? null : r.verdict.status);
  if (!cls) return null;
  return <span className={`tech-chip ${cls}`} title={rep?.reason ?? r.verdict.reason ?? ''}>{STATUS_LABEL[cls]}</span>;
}

/** A tool's chip: Off, Auto (intent default) / On, N/A when none of its parts can run here, or how the last slice went. */
function ToolChip({ t, last }: { t: ResolvedTool; last: Map<TechId, TechReport> | null }) {
  let cls = 'off', label = 'Off';
  const reasons = t.active.map((r) => last?.get(r.def.id)?.reason ?? r.verdict.reason).filter(Boolean);
  const reps = t.active.map((r) => last?.get(r.def.id)).filter((r): r is TechReport => !!r);
  if (t.enabled && reps.length) {
    const ran = reps.filter((r) => r.status === 'applied' || r.status === 'adapted');
    if (ran.length) { cls = ran.some((r) => r.status === 'adapted') ? 'adapted' : 'applied'; label = STATUS_LABEL[cls]; }
    else if (reps.every((r) => r.status === 'unavailable')) { cls = 'unavailable'; label = 'N/A'; }
    else { cls = 'idle'; label = 'Idle'; }
  } else if (t.enabled) {
    const usable = t.active.filter((r) => r.verdict.status !== 'unavailable');
    if (!usable.length) { cls = 'unavailable'; label = 'N/A'; }
    else { cls = usable.length < t.active.length || usable.some((r) => r.verdict.status === 'adapted') ? 'adapted' : 'on'; label = t.forced ? 'On' : 'Auto'; }
  }
  return <span className={`tech-chip ${cls}`} title={reasons.join('\n')}>{label}</span>;
}

export function ParamEditor({ id, specs, values }: { id: TechId; specs: ParamSpec[]; values: Record<string, ParamValue> }) {
  const own = useAdvanced((a) => a.techs[id]?.params ?? {});
  if (!specs.length) return <div className="muted" style={{ fontSize: 11.5 }}>No settings: driven entirely by the part's fields.</div>;
  return (
    <div className="tech-params">
      {specs.map((p) => {
        const v = values[p.key];
        const modified = p.key in own && own[p.key] !== p.def;
        return (
          <label key={p.key} className={`tech-param ${modified ? 'modified' : ''}`} title={p.tip ?? ''}>
            <span className="tp-label">{p.label}</span>
            {p.type === 'bool' ? (
              <button type="button" className={`toggle ${v ? 'on' : ''}`} aria-label={p.label} onClick={() => setTech(id, { param: [p.key, !v] })} />
            ) : p.type === 'enum' ? (
              <select className="select" value={String(v)} onChange={(e) => setTech(id, { param: [p.key, e.target.value] })}>
                {p.options!.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            ) : (
              <span className="tp-num">
                <input className="input" type="number" value={Number(v)} min={p.min} max={p.max} step={p.step}
                  onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n)) setTech(id, { param: [p.key, p.min !== undefined && p.max !== undefined ? Math.max(p.min, Math.min(p.max, n)) : n] }); }} />
                {p.unit && <span className="muted">{p.unit}</span>}
              </span>
            )}
          </label>
        );
      })}
    </div>
  );
}

function Verdict({ r, rep }: { r: ResolvedTech; rep?: TechReport }) {
  const reason = rep?.status === 'idle' ? rep.reason : r.verdict.reason;
  if (!reason) return null;
  const warn = r.verdict.status === 'unavailable' || rep?.status === 'idle';
  return <div className={`tech-verdict ${warn ? 'unavailable' : r.verdict.status}`}><Icon name={warn ? 'warn' : 'info'} size={13} />{reason}</div>;
}

function Stats({ rep }: { rep?: TechReport }) {
  if (!rep?.stats || !Object.keys(rep.stats).length) return null;
  return (
    <div className="tech-stats">
      {Object.entries(rep.stats).map(([k, v]) => <span key={k}><b>{k.replace(/_/g, ' ')}</b> {typeof v === 'number' ? +v.toFixed(3) : v}</span>)}
      {rep.ms !== undefined && <span><b>time</b> {Math.round(rep.ms)} ms</span>}
    </div>
  );
}

/** A technology's settings, folded away (they are for power users). */
function Settings({ r }: { r: ResolvedTech }) {
  const own = useAdvanced((a) => a.techs[r.def.id]?.params);
  const specs = r.def.params.filter((p) => !p.unwired);
  if (!specs.length) return null;
  const modified = specs.some((p) => own && p.key in own && own[p.key] !== p.def);
  return (
    <details className="tool-settings">
      <summary className={modified ? 'modified' : ''}>Settings ({specs.length}){modified ? ' · changed' : ''}</summary>
      <ParamEditor id={r.def.id} specs={specs} values={r.params} />
    </details>
  );
}

/** One technology in the node graph's detail pane. */
export function TechDetail({ r, rep }: { r: ResolvedTech; rep?: TechReport }) {
  const a = useAdvanced();
  const def = r.def;
  const tool = TOOL_OF_TECH[def.id];
  const overridden = !!a.techs[def.id] || (!!tool && !!a.tools[tool.id]);
  return (
    <div className="tech-detail">
      <div className="tech-summary">{def.summary}</div>
      <div className="muted" style={{ fontSize: 11 }}>{tool ? `Part of the ${tool.name} tool` : 'Part analysis: always on, changes no toolpath'} · {def.technique}</div>
      <div className="tech-math-full mono">{def.math}</div>
      <Verdict r={r} rep={rep} />
      <Stats rep={rep} />
      <ParamEditor id={def.id} specs={def.params.filter((p) => !p.unwired)} values={r.params} />
      {overridden && <button className="btn-secondary btn-small" style={{ marginTop: 6 }} onClick={() => (tool ? resetTool(tool.id) : resetTech(def.id))}><Icon name="reset" size={13} />Back to intent default</button>}
    </div>
  );
}

function ToolDetail({ t, last }: { t: ResolvedTool; last: Map<TechId, TechReport> | null }) {
  const def = t.def;
  const single = def.techs.length === 1;
  const overridden = useAdvanced((a) => !!a.tools[def.id] || def.techs.some((id) => !!a.techs[id]));
  const pick = (id: TechId) => {
    const cur = t.active.map((r) => r.def.id);
    const next = def.exclusive ? [id] : cur.includes(id) ? cur.filter((x) => x !== id) : def.techs.filter((x) => x === id || cur.includes(x));
    // unticking the last part switches the tool off and remembers that part for the next switch-on
    setTool(def.id, { enabled: next.length > 0, parts: next.length ? next : cur });
  };
  return (
    <div className="tech-detail">
      <div className="tech-summary"><b>When on:</b> {def.does}</div>
      {single ? (
        <>
          <div className="tool-part-does">{t.parts[0].def.summary}</div>
          <Verdict r={t.parts[0]} rep={last?.get(def.techs[0])} />
          <Stats rep={last?.get(def.techs[0])} />
          <Settings r={t.parts[0]} />
        </>
      ) : (
        <div className="tool-parts" role={def.exclusive ? 'radiogroup' : 'group'} aria-label={def.exclusive ? `${def.name}: mode` : `${def.name}: what it does`}>
          <div className="tool-parts-title">{def.exclusive ? 'Mode' : 'What it does (untick to leave a part out)'}</div>
          {t.parts.map((r) => {
            const rep = last?.get(r.def.id);
            return (
              <div key={r.def.id} className={`tool-part ${r.enabled ? 'on' : ''}`}>
                <label className="tool-part-head" title={`${r.def.technique} — ${r.def.math}`}>
                  <input type={def.exclusive ? 'radio' : 'checkbox'} name={`tool-${def.id}`} checked={r.enabled} onChange={() => pick(r.def.id)} />
                  <span className="tool-part-name">{r.def.name}</span>
                  {r.enabled && <PartChip r={r} rep={rep} />}
                </label>
                <div className="tool-part-does">{r.def.summary}</div>
                {r.enabled && <><Verdict r={r} rep={rep} /><Stats rep={rep} /><Settings r={r} /></>}
              </div>
            );
          })}
        </div>
      )}
      {overridden && <button className="btn-secondary btn-small" style={{ alignSelf: 'flex-start' }} onClick={() => resetTool(def.id)}><Icon name="reset" size={13} />Back to intent default</button>}
    </div>
  );
}

export function ToolList() {
  const tools = useTools();
  const a = useAdvanced();
  const last = useLastReport();
  const onCount = tools.filter((t) => t.enabled).length;
  const anyOverride = Object.keys(a.tools).length > 0 || Object.keys(a.techs).length > 0;
  const toggle = (t: ResolvedTool) => setTool(t.def.id, t.enabled
    ? { enabled: false, parts: t.active.map((r) => r.def.id) }
    : { enabled: true, parts: a.tools[t.def.id]?.parts });
  return (
    <section className="adv-section">
      <div className="adv-section-head">
        <span className="adv-h"><Icon name="atom" size={14} />Tools</span>
        <span className="badge">{onCount} of {TOOLS.length} on</span>
        <span className="spacer" />
        {anyOverride && <button className="icon-btn" title="Every tool back to the intent defaults" onClick={resetAllTools}><Icon name="reset" size={15} /></button>}
        <button className="icon-btn" title="Engine node graph: fields → technologies → stages" onClick={() => a.set({ graphOpen: true })}><Icon name="graph" size={16} /></button>
      </div>
      {TOOL_GROUPS.map((g) => (
        <div key={g.id} className="tech-part">
          <div className="tech-part-title">{g.title}</div>
          {tools.filter((t) => t.def.group === g.id).map((t) => {
            const open = a.expanded === t.def.id;
            return (
              <div key={t.def.id} className={`tech-row-wrap ${open ? 'open' : ''}`}>
                <div className="tech-row" title={t.def.does} onClick={() => a.set({ expanded: open ? null : t.def.id })}>
                  <span className="tool-text">
                    <span className="tech-name">{t.def.name}</span>
                    {t.enabled && t.def.techs.length > 1 && <span className="tool-sub">{t.active.map((r) => r.def.name).join(' · ')}</span>}
                  </span>
                  <ToolChip t={t} last={last} />
                  <button className={`toggle ${t.enabled ? 'on' : ''}`} aria-label={`${t.enabled ? 'Turn off' : 'Turn on'} ${t.def.name}`}
                    onClick={(e) => { e.stopPropagation(); toggle(t); }} />
                </div>
                {open && <ToolDetail t={t} last={last} />}
              </div>
            );
          })}
        </div>
      ))}
    </section>
  );
}
