// Advanced-mode sidebar (progressive disclosure): Intent Cards, the Zone Inspector, the inputs each
// intent needs, the machine capability card, the tool list and the last engine report.
import { useMemo, useState } from 'react';
import { INTENTS, intentParts, TECH_BY_ID } from '../../engine/advanced/techs';
import { TOOL_OF_TECH, TOOLS } from '../../engine/advanced/tools';
import { FIELD_IDS, ZONE_KINDS, type FieldId, type IntentId } from '../../engine/advanced/types';
import { useAdvanced } from '../../state/advanced';
import { useStore } from '../../state/store';
import { Icon } from '../icons';
import { FIELD_LABELS, FIELD_UNITS, legendGradient, ZONE_COLORS, ZONE_LABELS } from './colors';
import { useCaps } from './hooks';
import { techLabel, ToolList } from './ToolList';
import { TechGraph } from './TechGraph';

const INTENT_ICON: Record<IntentId, string> = { structural: 'shield', aesthetic: 'sparkle', optical: 'lamp', acoustic: 'wave', morph4d: 'morph' };

export function AdvancedPanel() {
  const a = useAdvanced();
  return (
    <section className="card process adv-panel">
      <div className="card-head">
        <span className="card-title"><Icon name="atom" />Physics Core</span>
        <span className="spacer" />
        <select className="select adv-res" value={a.resolution} aria-label="Field resolution" title="Voxel resolution of the part fields (analysis and slicing)"
          onChange={(e) => a.set({ resolution: e.target.value as 'draft' | 'normal' | 'fine' })}>
          <option value="draft">Draft</option><option value="normal">Normal</option><option value="fine">Fine</option>
        </select>
      </div>
      <div className="adv-scroll">
        <IntentCards />
        <ZoneInspector />
        <IntentInputs />
        <MachineCard />
        <ToolList />
        <EngineReport />
      </div>
      {a.graphOpen && <TechGraph onClose={() => a.set({ graphOpen: false })} />}
    </section>
  );
}

function IntentCards() {
  const { intent, set } = useAdvanced();
  const cur = INTENTS.find((i) => i.id === intent)!;
  return (
    <section className="adv-section">
      <div className="adv-section-head"><span className="adv-h">Intent</span></div>
      <div className="intent-grid" role="radiogroup" aria-label="Print intent">
        {INTENTS.map((it) => (
          <button key={it.id} role="radio" aria-checked={intent === it.id} className={`intent-card ${intent === it.id ? 'on' : ''}`} onClick={() => set({ intent: it.id })} title={it.blurb}>
            <Icon name={INTENT_ICON[it.id]} size={17} />
            <span className="intent-name">{it.name}</span>
          </button>
        ))}
      </div>
      <div className="intent-blurb">{cur.blurb}</div>
      <div className="intent-blurb muted"><b>Turns on:</b> {TOOLS.filter((t) => intentParts(t, intent).length).map((t) => t.name).join(', ')}. Switch any tool below.</div>
    </section>
  );
}

function ZoneInspector() {
  const a = useAdvanced();
  const s = useStore();
  const objs = s.objects.filter((o) => a.analysis[o.id]);
  const sel = objs.find((o) => s.selected.includes(o.id)) ?? objs[0];
  const an = sel ? a.analysis[sel.id] : undefined;
  const available = useMemo(() => new Set(Object.values(a.analysis).flatMap((x) => Object.keys(x.fields))), [a.analysis]);
  // zone shares over all analysed objects
  const shares = useMemo(() => {
    const area = new Map<string, number>();
    let total = 0;
    for (const x of Object.values(a.analysis)) for (const z of x.zones) { area.set(z.kind, (area.get(z.kind) ?? 0) + z.areaMm2); total += z.areaMm2; }
    return { area, total };
  }, [a.analysis]);
  const vol = useMemo(() => {
    const m = new Map<string, number>();
    for (const x of Object.values(a.analysis)) for (const z of x.zones) if (z.volumeMm3) m.set(z.kind, (m.get(z.kind) ?? 0) + z.volumeMm3);
    return m;
  }, [a.analysis]);
  const range = an?.ranges[a.field];
  return (
    <section className="adv-section">
      <div className="adv-section-head">
        <span className="adv-h"><Icon name="heat" size={14} />Zone Inspector</span>
        {a.analysing && <span className="badge pulse">Analysing…</span>}
        <span className="spacer" />
        <label className="adv-mini" title="Colour the models by the selected field"><span>Heatmap</span>
          <button className={`toggle ${a.heatmap ? 'on' : ''}`} aria-label="Heatmap" onClick={() => a.set({ heatmap: !a.heatmap })} /></label>
        <label className="adv-mini" title="Show the interior volume zones as points"><span>Interior</span>
          <button className={`toggle ${a.showVoxels ? 'on' : ''}`} aria-label="Interior zones" onClick={() => a.set({ showVoxels: !a.showVoxels })} /></label>
      </div>
      {a.analysisError && <div className="tech-verdict unavailable"><Icon name="warn" size={13} />Analysis failed: {a.analysisError}</div>}
      {!objs.length && !a.analysing && <div className="empty-hint">Add a model: the router analyses it here (domes, necks, helical bands, cores) before slicing.</div>}
      {objs.length > 0 && (
        <>
          <div className="field-chips">
            {FIELD_IDS.map((f) => (
              <button key={f} className={`mx-chip ${a.field === f ? 'on' : ''}`} disabled={!available.has(f)} onClick={() => a.set({ field: f as FieldId, heatmap: true })}>{FIELD_LABELS[f]}</button>
            ))}
          </div>
          {a.field === 'zones' ? (
            <div className="zone-legend">
              {ZONE_KINDS.filter((k) => shares.area.get(k) || vol.get(k)).map((k) => (
                <div key={k} className="zone-item">
                  <span className="zone-dot" style={{ background: ZONE_COLORS[k] }} />
                  <span>{ZONE_LABELS[k]}</span>
                  <span className="spacer" />
                  <span className="muted">{shares.area.get(k) ? `${((100 * (shares.area.get(k) ?? 0)) / Math.max(shares.total, 1e-9)).toFixed(0)}% area` : ''}{vol.get(k) ? ` ${(vol.get(k)! / 1000).toFixed(1)} cm³` : ''}</span>
                </div>
              ))}
            </div>
          ) : range && (
            <div className="field-legend">
              <div className="field-bar" style={{ background: legendGradient(a.field) }} />
              <div className="row" style={{ marginTop: 2 }}>
                <span className="muted">{range[0].toFixed(a.field === 'curvature' ? 3 : 1)}</span><span className="spacer" />
                <span className="muted">{FIELD_UNITS[a.field] ?? ''}</span><span className="spacer" />
                <span className="muted">{range[1].toFixed(a.field === 'curvature' ? 3 : 1)}</span>
              </div>
            </div>
          )}
          {an && (
            <div className="adv-facts">
              <span title="Object shown in the facts"><b>{sel!.name}</b></span>
              <span title="Solid volume from the signed distance field">{(an.volumeMm3 / 1000).toFixed(2)} cm³</span>
              <span title="Betti numbers: connected pieces and tunnels (handles)">β₀ {an.betti[0]} · β₁ {an.betti[1]}</span>
              <span title="Topological branches (Reeb graph arcs)">{an.branches} branch{an.branches === 1 ? '' : 'es'}</span>
            </div>
          )}
        </>
      )}
    </section>
  );
}

/** What each intent needs from the user: load case, paint, target image… */
function IntentInputs() {
  const a = useAdvanced();
  const s = useStore();
  const paint = (v: 1 | 2 | 3 | 4) => { a.set({ paintValue: v }); s.set({ tool: 'paint_adv', workspace: 'prepare' }); };
  const painting = s.tool === 'paint_adv';
  if (a.intent === 'structural') {
    const dirs: { label: string; dir: [number, number, number] }[] = [
      { label: 'Down (−Z)', dir: [0, 0, -1] }, { label: 'Up (+Z)', dir: [0, 0, 1] }, { label: '+X', dir: [1, 0, 0] }, { label: '−X', dir: [-1, 0, 0] }, { label: '+Y', dir: [0, 1, 0] }, { label: '−Y', dir: [0, -1, 0] },
    ];
    const cur = dirs.findIndex((d) => d.dir.every((v, i) => v === a.load.dir[i]));
    return (
      <section className="adv-section">
        <div className="adv-section-head"><span className="adv-h"><Icon name="shield" size={14} />Load case</span><span className="spacer" /><span className="badge">auto + paint</span></div>
        <div className="row">
          <span className="muted">Direction</span>
          <select className="select" value={cur} onChange={(e) => a.set({ load: { ...a.load, dir: dirs[+e.target.value].dir } })}>
            {dirs.map((d, i) => <option key={i} value={i}>{d.label}</option>)}
          </select>
          <input className="input" type="number" style={{ width: 72 }} value={a.load.newtons} min={1} step={1} onChange={(e) => a.set({ load: { ...a.load, newtons: Math.max(1, Number(e.target.value) || 1) } })} />
          <span className="muted">N</span>
        </div>
        <div className="muted adv-note">Without paint, the bed contact and bolt holes are fixtures and the load acts on the top surfaces. Paint faces for an exact case:</div>
        <div className="row">
          <button className={`btn-secondary btn-small ${painting && a.paintValue === 1 ? 'on' : ''}`} onClick={() => paint(1)}><span className="zone-dot" style={{ background: '#26A69A' }} />Fixture</button>
          <button className={`btn-secondary btn-small ${painting && a.paintValue === 2 ? 'on' : ''}`} onClick={() => paint(2)}><span className="zone-dot" style={{ background: '#FF7043' }} />Load face</button>
        </div>
      </section>
    );
  }
  if (a.intent === 'optical') return <OpticalInputs onPaint={paint} painting={painting} />;
  if (a.intent === 'morph4d') {
    return (
      <section className="adv-section">
        <div className="adv-section-head"><span className="adv-h"><Icon name="morph" size={14} />4D target</span></div>
        <div className="muted adv-note">The model on the plate is the shape to reach. NexSpiro prints a flat sheet under it whose bead directions encode the shape's metric; warm it above Tg (hot water ~70 °C for PLA) to let it buckle into the shape.</div>
      </section>
    );
  }
  if (a.intent === 'acoustic') {
    return (
      <section className="adv-section">
        <div className="adv-section-head"><span className="adv-h"><Icon name="wave" size={14} />Vibration target</span></div>
        <div className="muted adv-note">Set the frequency to block in Vibration-damping infill › Band-gap lattice; the cell grading and foam follow the zones.</div>
      </section>
    );
  }
  return null;
}

function OpticalInputs({ onPaint, painting }: { onPaint: (v: 3 | 4) => void; painting: boolean }) {
  const a = useAdvanced();
  const [err, setErr] = useState<string | null>(null);
  const load = async (f: File) => {
    try {
      const bmp = await createImageBitmap(f);
      const N = 64;
      const c = document.createElement('canvas');
      c.width = N; c.height = N;
      const g = c.getContext('2d')!;
      g.drawImage(bmp, 0, 0, N, N);
      const d = g.getImageData(0, 0, N, N).data;
      const pixels: number[] = [];
      for (let i = 0; i < N * N; i++) pixels.push((0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2]) / 255);
      a.set({ caustic: { width: N, height: N, pixels, throwMm: a.caustic?.throwMm ?? 200, mode: a.caustic?.mode ?? 'lens' } });
      setErr(null);
    } catch { setErr('Could not read that image.'); }
  };
  return (
    <section className="adv-section">
      <div className="adv-section-head"><span className="adv-h"><Icon name="lamp" size={14} />Caustic target</span></div>
      <div className="row">
        <label className="btn-secondary btn-small" style={{ display: 'inline-flex', alignItems: 'center', cursor: 'pointer' }}>
          {a.caustic ? 'Replace image…' : 'Load image…'}
          <input type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files?.[0]; if (f) void load(f); }} />
        </label>
        {a.caustic && <CausticThumb pixels={a.caustic.pixels} n={a.caustic.width} />}
        {a.caustic && <button className="icon-btn" title="Remove image" onClick={() => a.set({ caustic: null })}><Icon name="close" size={14} /></button>}
      </div>
      {err && <div className="tech-verdict unavailable">{err}</div>}
      {a.caustic && (
        <div className="row">
          <select className="select" value={a.caustic.mode} onChange={(e) => a.set({ caustic: { ...a.caustic!, mode: e.target.value as 'lens' | 'lampshade' } })}>
            <option value="lens">Lens (top surface heights)</option>
            <option value="lampshade">Lampshade (wall bead widths)</option>
          </select>
          <input className="input" type="number" style={{ width: 70 }} value={a.caustic.throwMm} min={20} step={10} title="Distance from the lens to the wall or screen"
            onChange={(e) => a.set({ caustic: { ...a.caustic!, throwMm: Math.max(20, Number(e.target.value) || 200) } })} />
          <span className="muted">mm throw</span>
        </div>
      )}
      <div className="muted adv-note">Gloss control › Painted matte / gloss: paint matte or glossy areas of the outer wall.</div>
      <div className="row">
        <button className={`btn-secondary btn-small ${painting && useAdvanced.getState().paintValue === 3 ? 'on' : ''}`} onClick={() => onPaint(3)}><span className="zone-dot" style={{ background: '#8A99A6' }} />Matte</button>
        <button className={`btn-secondary btn-small ${painting && useAdvanced.getState().paintValue === 4 ? 'on' : ''}`} onClick={() => onPaint(4)}><span className="zone-dot" style={{ background: '#FFFFFF' }} />Gloss</button>
      </div>
    </section>
  );
}

function CausticThumb({ pixels, n }: { pixels: number[]; n: number }) {
  const url = useMemo(() => {
    const c = document.createElement('canvas');
    c.width = n; c.height = n;
    const g = c.getContext('2d')!;
    const img = g.createImageData(n, n);
    pixels.forEach((v, i) => { const b = Math.round(v * 255); img.data.set([b, b, b, 255], i * 4); });
    g.putImageData(img, 0, 0);
    return c.toDataURL();
  }, [pixels, n]);
  return <img src={url} alt="Caustic target" width={28} height={28} style={{ borderRadius: 4, imageRendering: 'pixelated', border: '1px solid var(--border)' }} />;
}

function MachineCard() {
  const { caps } = useCaps();
  const a = useAdvanced();
  const [open, setOpen] = useState(false);
  const m = a.machine;
  const setM = (patch: Partial<typeof m>) => a.set({ machine: { ...m, ...patch } });
  const flag = (on: boolean, label: string) => <span className={`tech-chip ${on ? 'on' : 'off'}`}>{label}</span>;
  return (
    <section className="adv-section">
      <div className="adv-section-head">
        <span className="adv-h"><Icon name="printer" size={14} />Machine capabilities</span>
        <span className="spacer" />
        <button className={`icon-btn ${open ? 'active' : ''}`} title="Edit the capability model (for modified or future machines)" onClick={() => setOpen(!open)}><Icon name="edit" size={15} /></button>
      </div>
      <div className="adv-facts">
        <span><b>{caps.name}</b></span>
        <span>{caps.kinematics} · {caps.axes}-axis · {caps.firmware}</span>
        <span>slope ≤ {caps.maxSlopeDeg.toFixed(0)}° · flow ≤ {caps.maxFlow} mm³/s</span>
        <span>Z {caps.maxSpeedZ} mm/s · {caps.maxAccelZ} mm/s²</span>
      </div>
      <div className="row" style={{ flexWrap: 'wrap', gap: 4 }}>
        {flag(caps.inputShaper, 'Input shaper')}{flag(caps.pressureAdvance, 'Pressure advance')}{flag(caps.heatedChamber, caps.heatedChamber ? `Chamber ${caps.chamberTemp}°C` : 'Heated chamber')}
        {flag(caps.multiMaterial !== 'manual', caps.multiMaterial === 'ams' ? 'AMS' : 'Auto material')}{flag(caps.continuousFiber, 'Fiber')}
      </div>
      {open && (
        <div className="tech-params" style={{ marginTop: 6 }}>
          <label className="tech-param"><span className="tp-label">Kinematics</span>
            <select className="select" value={m.kinematics ?? ''} onChange={(e) => setM({ kinematics: (e.target.value || undefined) as any, axes: e.target.value.startsWith('five') ? 5 : undefined })}>
              <option value="">Printer default ({caps.kinematics})</option>
              <option value="corexy">CoreXY</option><option value="cartesian">Cartesian</option><option value="bedslinger">Bed slinger</option><option value="delta">Delta</option>
              <option value="five_axis_ac">5-axis (A/C table)</option><option value="five_axis_bc">5-axis (B/C head)</option>
            </select></label>
          <NumField label="Nozzle tip length" unit="mm" value={m.tipLength ?? caps.toolhead.nozzle.tip_len} step={0.1} onChange={(v) => setM({ tipLength: v })} />
          <NumField label="Resonance X" unit="Hz" value={m.resonanceX ?? caps.resonance.x} step={1} onChange={(v) => setM({ resonanceX: v })} />
          <NumField label="Resonance Y" unit="Hz" value={m.resonanceY ?? caps.resonance.y} step={1} onChange={(v) => setM({ resonanceY: v })} />
          <NumField label="Max flow" unit="mm³/s" value={m.maxFlow ?? caps.maxFlow} step={1} onChange={(v) => setM({ maxFlow: v })} />
          <NumField label="Max Z accel" unit="mm/s²" value={m.maxAccelZ ?? caps.maxAccelZ} step={10} onChange={(v) => setM({ maxAccelZ: v })} />
          <BoolField label="Input shaper in firmware" value={m.inputShaper ?? caps.inputShaper} onChange={(v) => setM({ inputShaper: v })} />
          <BoolField label="Pressure advance in firmware" value={m.pressureAdvance ?? caps.pressureAdvance} onChange={(v) => setM({ pressureAdvance: v })} />
          <BoolField label="Heated chamber" value={m.heatedChamber ?? caps.heatedChamber} onChange={(v) => setM({ heatedChamber: v })} />
          <BoolField label="Continuous-fiber head" value={m.continuousFiber ?? caps.continuousFiber} onChange={(v) => setM({ continuousFiber: v })} />
          <button className="btn-secondary btn-small" disabled={!Object.keys(m).length} onClick={() => a.set({ machine: {} })}><Icon name="reset" size={13} />Printer defaults</button>
        </div>
      )}
      <ul className="adv-notes">{caps.notes.map((n) => <li key={n}>{n}</li>)}</ul>
    </section>
  );
}

function NumField({ label, unit, value, step, onChange }: { label: string; unit: string; value: number; step: number; onChange: (v: number) => void }) {
  return (
    <label className="tech-param"><span className="tp-label">{label}</span>
      <span className="tp-num"><input className="input" type="number" value={value} step={step} onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n) && n > 0) onChange(n); }} /><span className="muted">{unit}</span></span>
    </label>
  );
}
function BoolField({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return <label className="tech-param"><span className="tp-label">{label}</span><button type="button" className={`toggle ${value ? 'on' : ''}`} aria-label={label} onClick={() => onChange(!value)} /></label>;
}

function EngineReport() {
  const sl = useStore((s) => s.slice);
  const rep = sl.status === 'done' ? sl.result?.advanced : undefined;
  if (!rep) return null;
  const applied = rep.techs.filter((t) => t.status === 'applied' || t.status === 'adapted');
  const ranTools = new Set(applied.map((t) => TOOL_OF_TECH[t.id]?.id).filter(Boolean));
  return (
    <section className="adv-section">
      <div className="adv-section-head">
        <span className="adv-h"><Icon name="info" size={14} />Last compile</span>
        {sl.dirty && <span className="badge" title="Settings or scene changed since this slice">outdated</span>}
        <span className="spacer" /><span className="muted">{rep.ms} ms</span>
      </div>
      <div className="adv-facts"><span>{ranTools.size} tool{ranTools.size === 1 ? '' : 's'} ran</span><span>{new Set(rep.techs.filter((t) => t.status === 'unavailable').map((t) => TOOL_OF_TECH[t.id]?.id).filter(Boolean)).size} tool(s) not available on this machine</span>
        {rep.clearance && <span title="Non-planar moves checked against the nozzle cone, heater block and fan duct">clearance: {rep.clearance.checked} checked, {rep.clearance.raised} lifted, {rep.clearance.unresolved} unresolved</span>}</div>
      <ul className="adv-notes">
        {applied.map((t) => <li key={t.id}><b>{techLabel(TECH_BY_ID[t.id])}</b>{t.stats && Object.keys(t.stats).length ? ` — ${Object.entries(t.stats).slice(0, 3).map(([k, v]) => `${k.replace(/_/g, ' ')} ${typeof v === 'number' ? +v.toFixed(2) : v}`).join(', ')}` : ''}</li>)}
        {rep.warnings.map((w) => <li key={w} className="warn-line">{w}</li>)}
      </ul>
    </section>
  );
}
