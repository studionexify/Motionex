// Inspector (right column of the redesigned workspace): progressive disclosure of every setting.
// Plate view → printer, filament / AMS, inline process settings, objects tree.
// Object view → pinned params, effects stack, Physics Core (advanced), inline per-object settings.
// Replaces the old left Sidebar; it reuses the Sidebar's cards and process model so behaviour is identical.
import { askOk } from '../askOk';
import { useEffect, useRef, useState } from 'react';
import { PARAM_BY_KEY, PROCESS_PRESETS, PROCESS_TABS, type ProcessTab } from '../../profiles/settings';
import { useStore } from '../../state/store';
import { useAdvanced } from '../../state/advanced';
import { setTool } from '../../state/advanced';
import { applyIntentPreset, INTENT_PRESETS, openEffect, setEffectEnabled, useActiveIntentPreset, useObjectEffects, useUi } from '../../state/ui';
import { ParamRow } from '../ParamRow';
import { Icon } from '../icons';
import { Modal } from '../Modals';
import { FilamentCard, PART_HELP, PresetOptions, PrinterCard, useProcessModel } from '../Sidebar';
import { isWaveZone } from '../../plugins/motionex/weave/zones';
import { WeaveZoneSettings } from '../../plugins/motionex/ui/WeavePanel';
import { activeUserPreset, applyUserPreset, currentPresetValue, deleteUserPreset, isActiveUserPresetModified, renameUserPreset, saveUserPreset, selectPresetValue, updateUserPreset } from '../../state/userPresets';
import { AdvancedPanel } from '../advanced/AdvancedPanel';
import { useTools, type ResolvedTool } from '../advanced/hooks';
import { HINTS } from './hints';
import { PLUGINS } from '../../plugins/registry';
import { studioOf } from '../../plugins/studios';
import { BigPicker, foldPickers, type PickTarget } from './BigPick';
import './inspector.css';

export function Inspector() {
  const ctx = useUi((u) => u.inspectorCtx);
  const s = useStore();
  void ctx; void s;
  return (
    <div className="panel insp" aria-label="Inspector">
      <Crumb objView={false} />
      <div className="iscroll">
        <PlateView />
      </div>
    </div>
  );
}

/* ---------- breadcrumb ---------- */

function Crumb({ objView }: { objView: boolean }) {
  const s = useStore();
  const setUi = useUi((u) => u.set);
  const plateName = s.plates[s.activePlate]?.name ?? `Plate ${s.activePlate + 1}`;
  const obj = useProcessModel(true);
  const n = objView ? obj.objOverrideCount : Object.keys(s.overrides).length;
  if (!objView) {
    return (
      <div className="crumb">
        <b>{plateName}</b>
        <span className="tag">{s.objects.length ? `${s.objects.length} object${s.objects.length > 1 ? 's' : ''}` : 'empty'}</span>
        {n > 0 && <span className="tag warn" title="Settings changed from the preset for the whole plate">{n} changed</span>}
      </div>
    );
  }
  return (
    <div className="crumb">
      <button title="Back to the whole-plate settings" onClick={() => setUi({ inspectorCtx: 'plate' })}><Icon name="chevron" size={12} style={{ transform: 'rotate(180deg)' }} />{plateName}</button>
      <span className="crumb-sep">/</span>
      <b title={obj.target}>{obj.target}</b>
      {n > 0
        ? <span className="tag warn" title="Settings this selection uses instead of the plate's">{n} override{n > 1 ? 's' : ''}</span>
        : <span className="tag" title="This selection uses the plate's settings">uses plate</span>}
    </div>
  );
}

/* ---------- presets ---------- */

function PresetSection() {
  const active = useActiveIntentPreset();
  const s = useStore();
  const up = activeUserPreset(s);
  const upMod = isActiveUserPresetModified(s);
  const nChanged = Object.keys(s.overrides).length;
  // like Bambu Studio / Orca: a changed preset turns orange, says "(modified)" and gets a restore arrow
  const modified = up ? upMod : nChanged > 0;
  const restore = () => { if (up) applyUserPreset(up.id); else { s.set({ overrides: {} }); s.markDirty(); } };
  const [saveOpen, setSaveOpen] = useState(false);
  return (
    <section>
      {/* one dropdown instead of a wall of chips: built-in presets, then the user's own */}
      <div className="preset-row">
        <span className="h-inline">Preset</span>
        <select className={`preset-select ${modified ? 'modified' : ''}`} aria-label="Preset" value={up ? `u:${up.id}` : active ? `i:${active}` : ''}
          title={modified ? 'Modified: settings differ from the preset' : undefined}
          onChange={(e) => {
            const [k, id] = [e.target.value.slice(0, 1), e.target.value.slice(2)];
            if (k === 'i') { applyIntentPreset(id); s.set({ userPresetId: null }); } else if (k === 'u') applyUserPreset(id);
          }}>
          {!up && !active && <option value="">Custom</option>}
          <optgroup label="Presets">
            {INTENT_PRESETS.map((p) => <option key={p.id} value={`i:${p.id}`}>{p.engine === 'advanced' ? '⚛ ' : ''}{p.label}{!up && active === p.id && modified ? ' (modified)' : ''}</option>)}
          </optgroup>
          {s.userPresets.length > 0 && (
            <optgroup label="My presets">
              {s.userPresets.map((p) => <option key={p.id} value={`u:${p.id}`}>{p.name}{up?.id === p.id && upMod ? ' (modified)' : ''}</option>)}
            </optgroup>
          )}
        </select>
        {modified
          ? <button className="preset-reset" aria-label="Restore the preset values" title={up ? `Restore "${up.name}": discard the changes made since it was applied` : `Restore the preset: discard ${nChanged} changed setting${nChanged === 1 ? '' : 's'}`} onClick={restore}><Icon name="reset" size={14} /></button>
          : <span className="preset-lock" title="All settings use the preset values"><Icon name="lock" size={12} /></span>}
        {up && upMod && <button className="sh-ib" title={`Overwrite "${up.name}" with the current settings`} onClick={() => updateUserPreset(up.id)}>Update</button>}
        <button className="sh-ib" title="Save the current settings as your own preset, or manage presets" onClick={() => setSaveOpen(true)}>Save as…</button>
      </div>
      {saveOpen && <PresetModal onClose={() => setSaveOpen(false)} />}
    </section>
  );
}

/** Save the current settings as a user preset; choose the system preset; rename / overwrite / delete user presets. */
function PresetModal({ onClose }: { onClose: () => void }) {
  const s = useStore();
  const n = Object.keys(s.overrides).length;
  const [name, setName] = useState('');
  const [names, setNames] = useState<Record<string, string>>({});
  const save = () => { if (saveUserPreset(name)) setName(''); };
  return (
    <Modal title="Process presets" onClose={onClose} footer={<>
      <button className="btn-secondary btn-small" disabled={!n} onClick={() => { s.set({ overrides: {} }); s.markDirty(); }}>Discard {n || ''} change{n === 1 ? '' : 's'}</button>
      <span className="spacer" />
      <button className="btn-primary btn-small" onClick={onClose}>Done</button>
    </>}>
      <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>Save the current process settings ({PROCESS_PRESETS.find((p) => p.id === s.presetId)?.name ?? s.presetId}{n ? ` + ${n} change${n === 1 ? '' : 's'}` : ''}) as your own preset. Presets are kept on this computer and saved with the project.</p>
      <div className="row" style={{ display: 'flex', gap: 6 }}>
        <input className="input" style={{ flex: 1 }} placeholder="Preset name" aria-label="New preset name" value={name} autoFocus
          onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} />
        <button className="btn-primary btn-small" disabled={!name.trim()} onClick={save}>Save</button>
      </div>
      <div className="muted-s" style={{ margin: '12px 0 4px' }}>Base preset</div>
      <select className="select" value={currentPresetValue(s)} aria-label="Process preset" onChange={(e) => selectPresetValue(e.target.value)}>
        <PresetOptions modified={n > 0} model />
      </select>
      {s.userPresets.length > 0 && <>
        <div className="muted-s" style={{ margin: '12px 0 0' }}>My presets</div>
        <div className="up-list">
          {s.userPresets.map((p) => {
            const v = names[p.id] ?? p.name;
            const commit = () => { if (v.trim() && v !== p.name) renameUserPreset(p.id, v); setNames(({ [p.id]: _, ...r }) => r); };
            return (
              <div key={p.id} className="r">
                <input className="input" value={v} aria-label={`Rename ${p.name}`} onChange={(e) => setNames({ ...names, [p.id]: e.target.value })}
                  onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} />
                <button className="btn-secondary btn-small" title="Use this preset" onClick={() => applyUserPreset(p.id)}>Apply</button>
                <button className="btn-secondary btn-small" title="Overwrite with the current settings" onClick={() => updateUserPreset(p.id)}>Update</button>
                <button className="icon-btn" title="Delete preset" aria-label={`Delete ${p.name}`} onClick={() => { if (askOk(`Delete preset "${p.name}"?`)) deleteUserPreset(p.id); }}><Icon name="close" size={14} /></button>
              </div>
            );
          })}
        </div>
      </>}
    </Modal>
  );
}

/* ---------- plate view ---------- */

function PlateView() {
  const advanced = useAdvanced((a) => a.engineMode === 'advanced');
  const objMode = useUi((u) => u.inspectorCtx) === 'object';
  const setUi = useUi((u) => u.set);
  return <>
    <div className="insp-cards"><PrinterCard /><FilamentCard /></div>
    {advanced && <PhysicsCore />}
    <InlineSettings objMode={objMode} preset={!objMode && <PresetSection />} title={
      <span className="proc-mode">Process
        <span className="seg proc-seg" role="tablist" aria-label="Process settings for">
          <button role="tab" aria-selected={!objMode} className={!objMode ? 'on' : ''} title="Settings for the whole plate" onClick={() => setUi({ inspectorCtx: 'plate' })}>Global</button>
          <button role="tab" aria-selected={objMode} className={objMode ? 'on' : ''} title="Settings for the selected object only; the object keeps them when you switch back to Global" onClick={() => setUi({ inspectorCtx: 'object' })}>Objects</button>
        </span>
      </span>} />
  </>;
}

/* ---------- object view ---------- */

function ObjectView() {
  const advanced = useAdvanced((a) => a.engineMode === 'advanced');
  return <>
    <PresetSection />
    <Pinned />
    <Effects />
    {advanced && <PhysicsCore />}
    <InlineSettings objMode title="Process · this object" />
  </>;
}

function Pinned() {
  const { pinnedParams, togglePinParam } = useUi();
  const obj = useProcessModel(true);
  const glob = useProcessModel(false);
  const keys = pinnedParams.filter((k) => PARAM_BY_KEY[k]);
  return (
    <section>
      <div className="h">Pinned</div>
      {!keys.length && <div className="muted-s">Nothing pinned yet.</div>}
      {keys.map((k) => {
        // per-object when the setting can differ per object; otherwise it edits the plate value
        const perObj = obj.allowed?.has(k) && !obj.part;
        const props = perObj ? obj.rowProps(k) : glob.rowProps(k);
        return <ParamRow key={k} {...props} hint={perObj ? HINTS[k] : `${HINTS[k] ? HINTS[k] + ' ' : ''}Applies to the whole plate.`}
          pin={{ on: true, toggle: () => togglePinParam(k) }} />;
      })}
    </section>
  );
}

function Effects() {
  const s = useStore();
  const id = s.selected[0] ?? null;
  const fx = useObjectEffects(id);
  const openDock = () => s.set({ dock: { ...useStore.getState().dock, open: true } });
  return (
    <section>
      <div className="h">Effects on this object <a role="button" tabIndex={0} onClick={openDock}><Icon name="add" size={12} />Add</a></div>
      <div className="fx">
        {fx.map((f) => (
          <div key={f.id} className={`fx-i ${f.enabled ? '' : 'muted'}`} role="button" tabIndex={0} title="Edit this effect in its plugin panel"
            onClick={() => id && openEffect(id, f.id)} onKeyDown={(e) => e.key === 'Enter' && id && openEffect(id, f.id)}>
            <span className="ic">{f.badge}</span>
            <span className="t"><div>{f.label}</div><div>{f.detail}</div></span>
            {f.status !== 'ok' && <span className={`dot ${f.status}`} title={f.status === 'error' ? 'Problem — open the effect to see details' : 'Check this effect'} />}
            <button className="eye" aria-label={f.enabled ? `Turn off ${f.label}` : `Turn on ${f.label}`} title={f.enabled ? 'Turn off (keeps its settings)' : 'Turn on'}
              onClick={(e) => { e.stopPropagation(); if (id) setEffectEnabled(id, f.id, !f.enabled); }}>
              <Icon name={f.enabled ? 'eye' : 'eyeOff'} size={15} />
            </button>
          </div>
        ))}
        <button className="fx-add" onClick={openDock}><Icon name="add" size={14} />Add effect: wave, weave, pattern, texture…</button>
      </div>
    </section>
  );
}

/* ---------- Physics Core (advanced engine) ---------- */

function PhysicsCore() {
  const tools = useTools();
  const a = useAdvanced();
  const [full, setFull] = useState(false);
  const toggle = (t: ResolvedTool) => setTool(t.def.id, t.enabled
    ? { enabled: false, parts: t.active.map((r) => r.def.id) }
    : { enabled: true, parts: a.tools[t.def.id]?.parts });
  const on = tools.filter((t) => t.enabled).length;
  return (
    <section>
      <div className="h">Physics Core tools <span className="muted-s">{on} of {tools.length} on</span>
        <a role="button" tabIndex={0} onClick={() => setFull(!full)} aria-expanded={full}>{full ? 'Less' : 'Intent, zones & all tools'}<Icon name="chevronDown" size={12} style={{ transform: full ? 'rotate(180deg)' : undefined }} /></a>
      </div>
      {!full && (
        <div className="pc">
          {tools.map((t) => (
            <div key={t.def.id} className="r" title={t.def.does}>
              <span className="t">{t.def.name}<code>{t.def.id}</code></span>
              <button className={`toggle ${t.enabled ? 'on' : ''}`} aria-label={`${t.enabled ? 'Turn off' : 'Turn on'} ${t.def.name}`} onClick={() => toggle(t)} />
            </div>
          ))}
        </div>
      )}
      {full && <div className="insp-adv"><AdvancedPanel /></div>}
    </section>
  );
}

/* ---------- inline process settings ---------- */

const TAB_ICON: Record<ProcessTab, string> = { Quality: 'quality', Strength: 'strength', Speed: 'speed', Support: 'support', Others: 'others' };
const TAB_HINT: Record<ProcessTab, string> = {
  Quality: 'Layer height, seams and surface finish',
  Strength: 'Walls, top/bottom shells and infill',
  Speed: 'How fast each part of the print moves',
  Support: 'Supports and rafts under overhangs',
  Others: 'Brim, prime tower, special modes and G-code',
};

function InlineSettings({ objMode, title, preset }: { objMode: boolean; title: React.ReactNode; preset?: React.ReactNode }) {
  const s = useStore();
  const m = useProcessModel(objMode);
  const { pinnedParams, togglePinParam } = useUi();
  const [changedOnly, setChangedOnly] = useState(false);
  const q = s.search.trim().toLowerCase();
  const pool = changedOnly ? m.visible.filter((p) => m.changed(p.key)) : m.visible;
  const tabs = PROCESS_TABS.filter((t) => m.visible.some((p) => p.tab === t));
  const tab = tabs.includes(s.processTab) ? s.processTab : tabs[0];
  // plugins turned on in File → Plugins sit after the process tabs; s.dock.tab / open say which one is shown
  const plugins = PLUGINS.filter((p) => s.plugins.includes(p.id));
  const plugin = s.dock.open ? plugins.find((p) => p.id === s.dock.tab) : undefined;
  const showTab = (t: ProcessTab) => s.set({ processTab: t, dock: { ...s.dock, open: false } });
  const flat = !plugin && (!!q || changedOnly);
  const list = q
    ? pool.filter((p) => `${p.label} ${p.group} ${p.key} ${p.tab} ${HINTS[p.key] ?? ''}`.toLowerCase().includes(q))
    : changedOnly ? pool : pool.filter((p) => p.tab === tab);
  const gname = (p: { tab: string; group: string }) => (flat ? `${p.tab} › ${p.group}` : p.group);
  const groups = [...new Set(list.map(gname))];
  const tabCount = (t: string) => m.visible.filter((p) => p.tab === t && m.changed(p.key)).length;
  const noSel = objMode && !m.selObjs.length;
  const solidPart = objMode && m.part && m.part.type !== 'modifier';

  return (
    <section className="insp-settings">
      <div className="h">{title}
        {!objMode && m.modifiedCount > 0 && (
          <button className="icon-btn" title={`${m.modifiedCount} changed from the preset: reset all`} onClick={() => { s.set({ overrides: {} }); s.markDirty(); }}><Icon name="reset" size={13} /></button>
        )}
        {(
          <label className="insp-adv-toggle" title="Show expert and developer settings too">Expert
            <button className={`toggle ${s.showAdvanced ? 'on' : ''}`} aria-label="Show expert settings" onClick={() => s.set({ showAdvanced: !s.showAdvanced })} />
          </label>
        )}
        <a role="button" tabIndex={0} aria-pressed={changedOnly} className={changedOnly ? 'on' : ''} title="Show only the settings you changed"
          onClick={() => setChangedOnly(!changedOnly)}><Icon name="others" size={12} />Changed</a>
      </div>
      {preset}
      {objMode && m.selObjs.length > 0 && (
        <div className="obj-target">
          <Icon name="cube" size={14} />
          <span className="name">{m.target}</span>
          <span className="muted">{m.objOverrideCount ? `${m.objOverrideCount} own setting${m.objOverrideCount > 1 ? 's' : ''}` : 'uses the plate settings'}</span>
          <button className="icon-btn" title="Reset to the plate settings" disabled={!m.objOverrideCount} onClick={m.resetObj}><Icon name="reset" size={15} /></button>
        </div>
      )}
      {noSel ? (
        <div className="proc-nosel">Select an object on the plate or in Objects to give it its own settings. Objects keep their own settings when you switch back to Global.</div>
      ) : objMode && (m.part ? m.part.type === 'modifier' && isWaveZone(m.part.overrides) : m.range && isWaveZone(m.range.overrides)) ? (
        <WeaveZoneSettings objectId={m.selObjs[0].id} partId={m.part?.id} rangeId={m.range?.id} />
      ) : solidPart ? (
        <div className="empty-hint">{PART_HELP[m.part!.type]} It has no settings of its own; move, rotate or scale it with the toolbar.</div>
      ) : <>
        {!flat && (
          <div className="stabs" role="tablist">
            {tabs.map((t) => (
              <button key={t} role="tab" aria-selected={!plugin && tab === t} className={!plugin && tab === t ? 'on' : ''} title={TAB_HINT[t]} onClick={() => showTab(t)}>
                {t}{tabCount(t) > 0 && <span className="c" title={`${tabCount(t)} changed`}>{tabCount(t)}</span>}
              </button>
            ))}
            {plugins.map((p) => (
              <button key={p.id} role="tab" aria-selected={plugin?.id === p.id} className={`ptab ${plugin?.id === p.id ? 'on' : ''}`} title={p.name}
                onClick={() => s.set({ dock: { ...s.dock, open: true, tab: p.id } })}>{p.name}</button>
            ))}
          </div>
        )}
        {plugin ? <PluginTab id={plugin.id} /> : <>
        <div className="ssearch">
          <Icon name="search" size={14} />
          <input id="param-search" placeholder={`Search ${m.visible.length} settings (Ctrl+F)`} value={s.search} aria-label="Search settings"
            onChange={(e) => s.set({ search: e.target.value })} onKeyDown={(e) => e.key === 'Escape' && s.set({ search: '' })} />
          {s.search && <button className="icon-btn" aria-label="Clear search" onClick={() => s.set({ search: '' })}><Icon name="close" size={12} /></button>}
        </div>
        <div className="params">
          {groups.map((g) => (
            <div key={g}>
              <div className="grp"><Icon name={TAB_ICON[(flat ? g.split(' › ')[0] : tab) as ProcessTab] ?? 'layers'} size={15} />{g}</div>
              {list.filter((p) => gname(p) === g).map((p) => (
                <ParamRow key={p.key} {...m.rowProps(p.key)} hint={HINTS[p.key]}
                  pin={{ on: pinnedParams.includes(p.key), toggle: () => togglePinParam(p.key) }} />
              ))}
            </div>
          ))}
          {!list.length && <div className="muted-s" style={{ padding: 16, textAlign: 'center' }}>{changedOnly && !q ? 'Nothing changed — everything uses the preset.' : 'No matching settings.'}</div>}
        </div>
        </>}
      </>}
    </section>
  );
}

/**
 * A plugin's settings, shown as a tab beside Quality / Strength / … and laid out like them: one row per setting
 * (name left, control right) under small group headings. Its "More settings" folds follow the Expert switch.
 */
function PluginTab({ id }: { id: string }) {
  const p = PLUGINS.find((x) => x.id === id)!;
  // Plantex, Lumonex, Clickex and Flenex show their own Studio button; Motionex and Patternex get one here
  const studio = studioOf(id);
  const Panel = p.Panel;
  const expert = useStore((s) => s.showAdvanced);
  const box = useRef<HTMLDivElement>(null);
  const [pick, setPick] = useState<PickTarget | null>(null);
  // Expert on: every advanced fold shown open; off: hidden
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const apply = () => el.querySelectorAll<HTMLDetailsElement>('details.px-more, details.mx-more').forEach((d) => { if (expert && !d.open) d.open = true; });
    apply();
    const mo = new MutationObserver(apply);
    mo.observe(el, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, [expert, id]);
  // long dropdowns, picture libraries and chip rows open a centred picker window
  useEffect(() => { const el = box.current; return el ? foldPickers(el, setPick) : undefined; }, [id]);
  return (
    <div className={`insp-plugin ${expert ? 'expert' : ''}`} ref={box}>
      {studio && (id === 'motionex' || id === 'patternex') && <button className="btn-secondary btn-small insp-studio" onClick={studio.open}>Open {studio.label} ↗</button>}
      <div className="dock-body"><Panel /></div>
      {pick && <BigPicker target={pick} onClose={() => setPick(null)} />}
    </div>
  );
}

