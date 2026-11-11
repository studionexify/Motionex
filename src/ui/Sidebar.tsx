import { useUi } from '../state/ui';
import { useMemo, useState, type ReactNode } from 'react';
import { FILAMENTS, filamentById } from '../profiles/filaments';
import { touchAdd } from './TouchMods';
import { arcSupportNote, PRINTERS, printerById } from '../profiles/printers';
import { autoFlushMatrix } from '../profiles/flush';
import { baseProcess, bedTemps, effectiveNozzle, NOZZLES } from '../profiles/resolve';
import { filamentConfig } from '../profiles/filamentParams';
import { HEIGHT_RANGE_KEYS, MODIFIER_KEYS, OBJECT_KEYS, PARAM_BY_KEY, PROCESS_PARAMS, PROCESS_PRESETS, PROCESS_TABS, type Config, type ProcessTab } from '../profiles/settings';
import { activeUserPreset, currentPresetValue, isActiveUserPresetModified, selectPresetValue } from '../state/userPresets';
import { USER_PREFIX } from '../profiles/userPresets';
import { amsUnavailableReason, syncAmsFromPrinter } from '../state/amsSync';
import { useDevices } from '../state/devices';
import { activeKey, relink, useHolders } from '../state/holders';
import { HolderBadge } from './FilamentHolders';
import { generatorOf, stepLabel, stepsOf } from '../state/steps';
import { editStep } from '../plugins/stepEdit';
import { isOutOfBounds, objectPlate, slotColor, useStore } from '../state/store';
import { updateHeightRange, updatePart } from '../state/ops';
import { isWaveZone } from '../plugins/motionex/weave/zones';
import { WeaveZoneSettings } from '../plugins/motionex/ui/WeavePanel';
import { renameObject } from '../state/objectOps';
import { Icon } from './icons';
import { FilamentModal, Modal, PrinterModal } from './Modals';
import { ParamRow } from './ParamRow';
import { collapseAllObjects, expandAllObjects, toggleObjectRow, useTree } from '../state/tree';
import { autoChanges, changerLabel, changerOf } from '../profiles/changer';
import { mixesAfterSlotRemoved } from '../profiles/mixing';
import { ColorMixingSection, shiftFilamentRefs } from './ColorMixing';

/** Collapsed state of the sidebar sections, kept between sessions. */
const COLLAPSE_KEY = 'nexspiro.sidebar.collapsed.v1';
const readCollapsed = (): Record<string, boolean> => { try { return JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? '{}'); } catch { return {}; } };
export function useCollapsed(id: string): [boolean, () => void] {
  const [c, setC] = useState(() => !!readCollapsed()[id]);
  return [c, () => { const v = !c; setC(v); try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify({ ...readCollapsed(), [id]: v })); } catch { /* storage unavailable */ } }];
}

/** Section title: icon, name and a chevron; clicking it collapses the section. */
export function CardTitle({ icon, label, closed, onToggle }: { icon: string; label: string; closed: boolean; onToggle: () => void }) {
  return (
    <button className="card-title card-toggle" aria-expanded={!closed} title={closed ? `Expand ${label}` : `Collapse ${label}`} onClick={onToggle}>
      <Icon name="chevronDown" size={14} className={`card-chev ${closed ? 'closed' : ''}`} />
      <Icon name={icon} size={17} />{label}
    </button>
  );
}
export const Body = ({ closed, children }: { closed: boolean; children: ReactNode }) => (closed ? null : <>{children}</>);

const TAB_ICONS: Record<ProcessTab, string> = { Quality: 'quality', Strength: 'strength', Speed: 'speed', Support: 'support', Others: 'others' };

export function PrinterCard() {
  const { printerId, plate, machineOverrides, set, markDirty, setMachine, myPrinters } = useStore();
  const [edit, setEdit] = useState(false);
  const [pick, setPick] = useState(false);
  const savedDevices = useDevices((d) => d.devices);
  // Only the user's printers are listed: their chosen list, else the printers they have connected, plus the current one.
  const mine = new Set(myPrinters.length ? myPrinters : savedDevices.map((d) => d.printerId));
  mine.add(printerId);
  const listed = PRINTERS.filter((p) => mine.has(p.id));
  const [closed, toggle] = useCollapsed('printer');
  const printer = printerById(printerId);
  const nozzle = effectiveNozzle(printerId, machineOverrides);
  const vendors = [...new Set(PRINTERS.map((p) => p.vendor))];
  const plateLabel = printer.plates.find((p) => p.type === plate)?.label ?? plate;
  return (
    <section className="card">
      <div className="card-head">
        <CardTitle icon="printer" label="Printer" closed={closed} onToggle={toggle} />
        <span className="spacer" />
        <span className="badge" title="Build volume">{printer.bed.x}×{printer.bed.y}×{printer.bed.z} mm</span>
        <button className="icon-btn" title="Edit printer settings" aria-label="Edit printer settings" onClick={() => setEdit(true)}><Icon name="edit" size={16} /></button>
      </div>
      <Body closed={closed}>
        {/* compact: printer on one row, build plate and nozzle on the next */}
        <div className="row compact-row">
          <Icon name="printer" size={15} style={{ color: 'var(--text-muted)' }} />
          <select className="grow-select" value={printerId} aria-label="Printer" title={`${printer.vendor} ${printer.model}`} onChange={(e) => {
            const p = printerById(e.target.value);
            set({ printerId: p.id, plate: p.plates.some((x) => x.type === plate) ? plate : p.plates[0].type, machineOverrides: {} });
            markDirty();
          }}>
            {vendors.filter((v) => listed.some((p) => p.vendor === v)).map((v) => (
              <optgroup key={v} label={v}>
                {listed.filter((p) => p.vendor === v).map((p) => <option key={p.id} value={p.id}>{p.vendor === 'Generic' ? p.model : `${p.vendor} ${p.model}`}</option>)}
              </optgroup>
            ))}
          </select>
          <button className="icon-btn" title="Add or remove printers" aria-label="Add or remove printers" onClick={() => setPick(true)}><Icon name="add" size={16} /></button>
        </div>
        <div className="row compact-row">
          <Icon name="plate" size={15} style={{ color: 'var(--text-muted)' }} />
          <select className="grow-select" value={plate} aria-label="Build plate" title={plateLabel} onChange={(e) => { set({ plate: e.target.value as any }); markDirty(); }}>
            {printer.plates.map((p) => <option key={p.type} value={p.type}>{p.label}</option>)}
          </select>
          <Icon name="nozzle" size={15} style={{ color: 'var(--text-muted)' }} />
          <select className="nozzle-select" aria-label="Nozzle diameter" title="Nozzle diameter" value={nozzle}
            onChange={(e) => { const n = Number(e.target.value); setMachine('nozzle_diameter', n === printer.nozzle ? undefined : n); markDirty(); }}>
            {NOZZLES.map((n) => <option key={n} value={n}>{n} mm{n === printer.nozzle ? ' ·' : ''}</option>)}
          </select>
        </div>
        {arcSupportNote(printer) && <p className="muted" style={{ fontSize: 11, margin: '4px 0 0' }}><Icon name="info" size={11} /> {arcSupportNote(printer)}</p>}
      </Body>
      {edit && <PrinterModal onClose={() => setEdit(false)} />}
      {pick && <MyPrintersModal initial={[...mine]} onClose={() => setPick(false)} />}
    </section>
  );
}

function MyPrintersModal({ initial, onClose }: { initial: string[]; onClose: () => void }) {
  const [sel, setSel] = useState(new Set(initial));
  const vendors = [...new Set(PRINTERS.map((p) => p.vendor))];
  const toggle = (id: string) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const save = () => {
    const ids = PRINTERS.filter((p) => sel.has(p.id)).map((p) => p.id);
    if (!ids.length) return;
    const st = useStore.getState();
    st.set({ myPrinters: ids });
    if (!ids.includes(st.printerId)) {
      const p = printerById(ids[0]);
      st.set({ printerId: p.id, plate: p.plates[0].type, machineOverrides: {} });
      st.markDirty();
    }
    onClose();
  };
  return (
    <Modal title="My printers" onClose={onClose} footer={<><span className="spacer" />
      <button className="btn-secondary btn-small" onClick={onClose}>Cancel</button>
      <button className="btn-primary btn-small" disabled={!sel.size} onClick={save}>Save</button></>}>
      <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>Tick the printers you own. Only these appear in the printer list.</p>
      <div style={{ maxHeight: 420, overflow: 'auto' }}>
        {vendors.map((v) => (
          <div key={v} style={{ marginBottom: 8 }}>
            <b style={{ fontSize: 12 }}>{v}</b>
            {PRINTERS.filter((p) => p.vendor === v).map((p) => (
              <label key={p.id} className="row" style={{ gap: 6, padding: '2px 0', fontSize: 13 }}>
                <input type="checkbox" checked={sel.has(p.id)} onChange={() => toggle(p.id)} />{p.model}
              </label>
            ))}
          </div>
        ))}
      </div>
    </Modal>
  );
}

/** System presets, then the user's saved presets ("user:<id>" values). `modified` marks the active entry. */
export function PresetOptions({ modified, model }: { modified: boolean; model?: boolean }) {
  const s = useStore();
  const up = activeUserPreset(s);
  const upMod = isActiveUserPresetModified(s);
  const mark = (on: boolean, name: string, suffix = '') => `${on && model ? '* ' : ''}${name}${suffix}${on ? ' (modified)' : ''}`;
  const at = model ? ` @${printerById(s.printerId).model}` : '';
  return <>
    <optgroup label="System presets">
      {PROCESS_PRESETS.map((p) => <option key={p.id} value={p.id}>{mark(!up && modified && p.id === s.presetId, p.name, at)}</option>)}
    </optgroup>
    {s.userPresets.length > 0 && (
      <optgroup label="My presets">
        {s.userPresets.map((p) => <option key={p.id} value={USER_PREFIX + p.id}>{mark(up?.id === p.id && upMod, p.name)}</option>)}
      </optgroup>
    )}
  </>;
}

/** "Sync AMS" link: copies the connected printer's AMS trays into the filament slots; disabled with the reason otherwise. */
export function SyncAmsLink() {
  const reason = useDevices((d) => amsUnavailableReason(d));
  return (
    <a role="button" tabIndex={reason ? -1 : 0} className={`sync-ams ${reason ? 'disabled' : ''}`} aria-disabled={!!reason}
      title={reason ?? 'Set the filament slots from the trays loaded in the connected printer\'s AMS'}
      onClick={() => { if (!reason) syncAmsFromPrinter(); }} onKeyDown={(e) => { if (!reason && e.key === 'Enter') syncAmsFromPrinter(); }}>Sync AMS</a>
  );
}

export function FilamentCard() {
  const { filaments, plate, printerId, set, markDirty } = useStore();
  const linked = useHolders((h) => h.linked);
  const holders = useHolders((h) => h.lists[activeKey()]);
  useDevices((d) => d.selected); // the active machine follows the selected device
  const [edit, setEdit] = useState<number | null>(null);
  const [flush, setFlush] = useState(false);
  const [closed, toggle] = useCollapsed('filament');
  const ams = autoChanges(printerById(printerId).machine);
  const update = (k: number, patch: Partial<{ presetId: string; color: string }>) => {
    set({ filaments: filaments.map((f, i) => (i === k ? { ...f, ...patch } : f)) });
    markDirty();
  };
  const remove = (k: number) => {
    const st = useStore.getState();
    // objects / paint referencing removed slots fall back to slot 1
    st.updateObjects((o) => ({
      ...o,
      filament: o.filament === k ? 0 : o.filament !== undefined && o.filament > k ? o.filament - 1 : o.filament,
      paint: o.paint?.color ? { ...o.paint, color: o.paint.color.map((c) => (c === k + 1 ? 0 : c > k + 1 ? c - 1 : c)) } : o.paint,
    }), st.objects.map((o) => o.id));
    set({ filaments: filaments.filter((_, i) => i !== k), mixes: mixesAfterSlotRemoved(st.mixes, k), flushMatrix: null });
  };
  return (
    <section className="card">
      <div className="card-head">
        <CardTitle icon="filamentB" label="Filament" closed={closed} onToggle={toggle} />
        <span className="spacer" />
        <span className="badge" title={ams ? `Automatic filament changes (${changerLabel(printerById(printerId).machine)})` : 'Manual filament changes (M600 pause)'}>{ams ? changerLabel(printerById(printerId).machine) : <Icon name="edit" size={12} />}</span>
        {!linked && <a role="button" tabIndex={0} className="sync-ams" title="The project's filaments differ from what is loaded in the machine" onClick={relink} onKeyDown={(e) => { if (e.key === 'Enter') relink(); }}>Use machine filaments</a>}
        <SyncAmsLink />
        {filaments.length > 1 && <button className="icon-btn" title="Flushing volumes" aria-label="Flushing volumes" onClick={() => setFlush(true)}><Icon name="flush" /></button>}
        <button className="icon-btn" title="Add filament" aria-label="Add filament" disabled={filaments.length >= 16}
          onClick={() => {
            const palette = ['#FF5C8D', '#85A3B2', '#E9D8C8', '#732553', '#142030', '#FFC107', '#1E88E5'];
            // a new holder goes before the planned (not loaded) slots
            const at = filaments.findIndex((f) => f.planned), k = at < 0 ? filaments.length : at;
            if (at >= 0 || useStore.getState().mixes.length) shiftFilamentRefs(null, k, 1);
            const loaded = filaments.filter((f) => !f.planned);
            const add = { presetId: (loaded[loaded.length - 1] ?? filaments[0]).presetId, color: palette[(k - 1 + palette.length) % palette.length] };
            set({ filaments: [...filaments.slice(0, k), add, ...filaments.slice(k)], flushMatrix: null });
          }}>
          <Icon name="add" />
        </button>
      </div>
      <Body closed={closed}><div className="slots">
        {filaments.map((f, k) => {
          const fil = filamentById(f.presetId);
          const bed = bedTemps(filamentConfig(fil), plate)[1];
          return (
            <div className="row slot" key={k}>
              <label title="Filament colour" className="swatch-btn" style={{ background: f.color }}>
                <span>{k + 1}</span>
                <input type="color" value={f.color} onChange={(e) => update(k, { color: e.target.value })} />
              </label>
              <select className="select" value={f.presetId} aria-label={`Filament ${k + 1}`} onChange={(e) => update(k, { presetId: e.target.value })}>
                {FILAMENTS.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </select>
              <span className="badge mat" title={f.overrides ? 'Filament type · settings changed on this slot' : 'Filament type'}>{String(f.overrides?.filament_type ?? fil.type)}{f.overrides ? '*' : ''}</span>
              {f.planned
                ? <button className="badge planned" title="A design uses this filament but it is not loaded in the machine. Click once it is loaded." onClick={() => set({ filaments: filaments.map((x, i) => (i === k ? { ...x, planned: undefined } : x)) })}>Load before printing</button>
                : linked && <HolderBadge h={holders?.[filaments.slice(0, k).filter((x) => !x.planned).length]} />}
              {!bed && <span title="Not recommended on this build plate" style={{ color: 'var(--warning)', display: 'flex' }}><Icon name="warn" size={14} /></span>}
              <button className="icon-btn" title="Filament details" onClick={() => setEdit(k)}><Icon name="edit" size={16} /></button>
              {filaments.length > 1 && <button className="icon-btn" title="Remove filament" onClick={() => remove(k)}><Icon name="close" size={14} /></button>}
            </div>
          );
        })}
      {(changerOf(printerById(printerId).machine) === 'toolchanger' || useStore.getState().mixes.length > 0) && <ColorMixingSection />}
      </div></Body>
      {edit !== null && <FilamentModal slot={edit} onClose={() => setEdit(null)} />}
      {flush && <FlushModal onClose={() => setFlush(false)} />}
    </section>
  );
}

/**
 * Process settings model shared by the classic ProcessCard and the Inspector's inline settings:
 * the resolved global config, the selection-scoped object/part/range target and value accessors.
 * `objMode` true edits the selection's own overrides; false edits the plate (global) overrides.
 */
export function useProcessModel(objMode: boolean) {
  const s = useStore();
  const base = useMemo(() => baseProcess({ printerId: s.printerId, presetId: s.presetId, machineOverrides: s.machineOverrides }), [s.printerId, s.presetId, s.machineOverrides]);
  const global: Config = { ...base, ...s.overrides };
  const modifiedCount = Object.keys(s.overrides).length;
  const selObjs = s.objects.filter((o) => s.selected.includes(o.id));
  const part = s.selectedPart ? selObjs[0]?.parts?.find((p) => p.id === s.selectedPart) : undefined;
  const range = !part && s.selectedRange && selObjs.length === 1 ? selObjs[0].heightRanges?.find((r) => r.id === s.selectedRange) : undefined;
  // Objects mode edits only what can differ per object (or per modifier / height range); everything else stays global
  const allowed = objMode ? new Set(part ? (part.type === 'modifier' ? MODIFIER_KEYS : []) : range ? HEIGHT_RANGE_KEYS : OBJECT_KEYS) : null;
  const visible = PROCESS_PARAMS.filter((p) => (s.showAdvanced || !p.advanced || allowed) && (!allowed || allowed.has(p.key)));

  // per-object values: the object's override, else the global value
  const ov = (k: string): { value: Config[string]; modified: boolean } => {
    if (part) return { value: part.overrides[k] ?? global[k], modified: k in part.overrides };
    if (range) { const own = selObjs[0].overrides ?? {}; return { value: range.overrides[k] ?? own[k] ?? global[k], modified: k in range.overrides }; }
    const own = selObjs.find((o) => o.overrides && k in o.overrides);
    return { value: own ? own.overrides![k] : global[k], modified: !!own };
  };
  const setObj = (k: string, v: Config[string] | undefined) => {
    if (part) {
      updatePart(selObjs[0].id, part.id, (p) => { const o = { ...p.overrides }; if (v === undefined) delete o[k]; else o[k] = v; return { ...p, overrides: o }; });
      return;
    }
    if (range) {
      const o = { ...range.overrides };
      if (v === undefined) delete o[k]; else o[k] = v;
      updateHeightRange(selObjs[0].id, range.id, { overrides: o });
      return;
    }
    s.updateObjects((o) => {
      const o2 = { ...(o.overrides ?? {}) };
      if (v === undefined || v === global[k]) delete o2[k]; else o2[k] = v;
      return { ...o, overrides: Object.keys(o2).length ? o2 : undefined };
    }, selObjs.map((o) => o.id));
  };
  const changed = (k: string) => (objMode ? (part ? k in part.overrides : range ? k in range.overrides : selObjs.some((o) => o.overrides && k in o.overrides)) : k in s.overrides);
  const objOverrideCount = part ? Object.keys(part.overrides).length : range ? Object.keys(range.overrides).length : new Set(selObjs.flatMap((o) => Object.keys(o.overrides ?? {}))).size;
  const target = part ? part.name : range ? `${selObjs[0].name} · ${range.z0}–${range.z1} mm` : selObjs.length === 1 ? selObjs[0].name : `${selObjs.length} objects`;
  const resetObj = () => part ? updatePart(selObjs[0].id, part.id, (p) => ({ ...p, overrides: {} })) : range ? updateHeightRange(selObjs[0].id, range.id, { overrides: {} }) : s.updateObjects((o) => ({ ...o, overrides: undefined }), selObjs.map((o) => o.id));
  /** Props for a ParamRow editing `key` in the current scope (global or selection). */
  const rowProps = (key: string) => {
    const def = PARAM_BY_KEY[key];
    if (!objMode) return { def, value: global[key], baseValue: base[key], cfg: global, modified: key in s.overrides,
      onCommit: (x: Config[string]) => s.setOverride(key, x === base[key] ? undefined : x), onReset: () => s.setOverride(key, undefined) };
    const v = ov(key);
    return { def, value: v.value, baseValue: global[key], cfg: { ...global, [key]: v.value }, modified: v.modified,
      onCommit: (x: Config[string]) => setObj(key, x), onReset: () => setObj(key, undefined), resetLabel: 'Use the global value' };
  };
  return { s, base, global, modifiedCount, selObjs, part, range, allowed, visible, ov, setObj, changed, objOverrideCount, target, resetObj, rowProps };
}

export function ProcessCard() {
  const s = useStore();
  const objMode = s.processMode === 'objects';
  const { base, global, modifiedCount, selObjs, part, range, visible, ov, setObj, changed, objOverrideCount, target, resetObj } = useProcessModel(objMode);
  const q = s.search.trim().toLowerCase();
  const tabs = PROCESS_TABS.filter((t) => visible.some((p) => p.tab === t));
  const tab = tabs.includes(s.processTab) ? s.processTab : tabs[0];
  const list = q
    ? visible.filter((p) => `${p.label} ${p.group} ${p.key} ${p.tab}`.toLowerCase().includes(q))
    : visible.filter((p) => p.tab === tab);
  const groups = [...new Set(list.map((p) => (q ? `${p.tab} › ${p.group}` : p.group)))];
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const [searchOpen, setSearchOpen] = useState(false);
  const [cardClosed, toggleCard] = useCollapsed('process');
  const tabCount = (t: string) => visible.filter((p) => p.tab === t && changed(p.key)).length;

  return (
    <section className="card process">
      <div className="card-head">
        <CardTitle icon="layers" label="Process" closed={cardClosed} onToggle={toggleCard} />
        <span className="spacer" />
        <div className="seg icon-seg" role="tablist">
          <button className={!objMode ? 'on' : ''} aria-label="Global settings" onClick={() => s.set({ processMode: 'global' })} title="Global: settings for the whole plate"><Icon name="plate" size={15} /></button>
          <button className={objMode ? 'on' : ''} aria-label="Object settings" onClick={() => s.set({ processMode: 'objects' })} title="Objects: settings for the selected objects only"><Icon name="cube" size={15} /></button>
        </div>
        <button className={`icon-btn ${searchOpen ? 'active' : ''}`} title="Search settings (Ctrl+F)" onClick={() => { setSearchOpen(!searchOpen); s.set({ search: '' }); }}><Icon name="search" /></button>
      </div>
      <Body closed={cardClosed}>
      {!objMode && (
        <div className="row">
          <select className="select" value={currentPresetValue(s)} aria-label="Process preset" onChange={(e) => selectPresetValue(e.target.value)}>
            <PresetOptions modified={modifiedCount > 0} model />
          </select>
          <button className="icon-btn" title="Reset all modified values" disabled={!modifiedCount} onClick={() => { s.set({ overrides: {} }); s.markDirty(); }}><Icon name="reset" /></button>
        </div>
      )}
      {objMode && selObjs.length > 0 && (
        <div className="obj-target">
          <Icon name={part ? 'cube' : 'cube'} size={14} />
          <span className="name">{target}</span>
          <span className="muted">{objOverrideCount ? `${objOverrideCount} own setting${objOverrideCount > 1 ? 's' : ''}` : 'uses global'}</span>
          <button className="icon-btn" title="Reset to the global settings" disabled={!objOverrideCount}
            onClick={resetObj}>
            <Icon name="reset" size={15} />
          </button>
        </div>
      )}
      <div className="row">
        {searchOpen
          ? <input id="param-search" className="input" style={{ flex: 1 }} autoFocus placeholder="Search parameters…" value={s.search} onChange={(e) => s.set({ search: e.target.value })} />
          : <span style={{ color: 'var(--text-muted)', flex: 1 }}>{objMode ? (part ? 'Modifier settings' : range ? 'Height range settings' : 'Per-object settings') : modifiedCount ? `${modifiedCount} modified value${modifiedCount > 1 ? 's' : ''}` : 'System preset values'}</span>}
        {!objMode && <><span style={{ color: 'var(--text-muted)' }}>Advanced</span>
          <button className={`toggle ${s.showAdvanced ? 'on' : ''}`} aria-label="Show advanced" onClick={() => s.set({ showAdvanced: !s.showAdvanced })} /></>}
      </div>
      {objMode && !selObjs.length ? (
        <div className="empty-hint">Select an object in the object list or the 3D view to give it its own settings. Settings changed here apply to the selected objects only.</div>
      ) : objMode && (part ? part.type === 'modifier' && isWaveZone(part.overrides) : range && isWaveZone(range.overrides)) ? (
        <WeaveZoneSettings objectId={selObjs[0].id} partId={part?.id} rangeId={range?.id} />
      ) : objMode && part && part.type !== 'modifier' ? (
        <div className="empty-hint">{PART_HELP[part.type]} It has no settings of its own; move, rotate or scale it with the toolbar.</div>
      ) : <>
        {!q && (
          <div className="ptabs">
            {tabs.map((t) => (
              <button key={t} className={`ptab ${tab === t ? 'active' : ''}`} title={t} aria-label={t} onClick={() => s.set({ processTab: t })}>
                <Icon name={TAB_ICONS[t as ProcessTab]} size={17} />{tab === t && t}
                {tabCount(t) > 0 && <span className="tab-count" title={`${tabCount(t)} changed value${tabCount(t) > 1 ? 's' : ''}`}>{tabCount(t)}</span>}
              </button>
            ))}
          </div>
        )}
        <div className="params">
          {groups.map((g) => (
            <div key={g}>
              <div className={`group-title ${closed[g] ? 'closed' : ''}`} onClick={() => setClosed({ ...closed, [g]: !closed[g] })}>
                <Icon name="chevronDown" size={14} /><Icon name={TAB_ICONS[(q ? g.split(' › ')[0] : tab) as ProcessTab] ?? 'layers'} size={14} className="group-ico" />{g}
              </div>
              {!closed[g] && list.filter((p) => (q ? `${p.tab} › ${p.group}` : p.group) === g).map((p) => {
                if (!objMode) return <ParamRow key={p.key} def={p} value={global[p.key]} baseValue={base[p.key]} cfg={global} modified={p.key in s.overrides}
                  onCommit={(x) => s.setOverride(p.key, x === base[p.key] ? undefined : x)} onReset={() => s.setOverride(p.key, undefined)} />;
                const v = ov(p.key);
                return <ParamRow key={p.key} def={p} value={v.value} baseValue={global[p.key]} cfg={{ ...global, [p.key]: v.value }} modified={v.modified}
                  onCommit={(x) => setObj(p.key, x)} onReset={() => setObj(p.key, undefined)} resetLabel="Use the global value" />;
              })}
            </div>
          ))}
          {!list.length && <div style={{ color: 'var(--text-muted)', padding: 16, textAlign: 'center' }}>No matching parameters.</div>}
        </div>
      </>}
      </Body>
    </section>
  );
}

/** Object list: plates, their objects and parts. Click selects (Ctrl toggles), right click opens the object menu. */
export function ObjectsCard() {
  const s = useStore();
  const plates = s.plates.length;
  const menuAt = (e: React.MouseEvent, kind: 'object' | 'part', id: string, partId?: string) => {
    e.preventDefault();
    const st = useStore.getState();
    const plate = objectPlate(st.objects.find((o) => o.id === id)!, st.printerId, plates);
    if (kind === 'part') st.set({ selected: [id], selectedPart: partId!, contextMenu: { x: e.clientX, y: e.clientY, kind, plate, id, partId } });
    else st.set({ selected: st.selected.includes(id) ? st.selected : [id], selectedPart: null, contextMenu: { x: e.clientX, y: e.clientY, kind, plate, id } });
  };
  const [closed, toggle] = useCollapsed('objects');
  const rowsClosed = useTree((t) => t.collapsed);
  const pick = (e: React.MouseEvent, id: string, pi: number) => {
    const toggle = e.ctrlKey || e.metaKey || touchAdd();
    s.set({ selected: toggle ? (s.selected.includes(id) ? s.selected.filter((x) => x !== id) : [...s.selected, id]) : [id], selectedPart: null, selectedRange: null, activePlate: pi });
  };
  return (
    <section className="card objects-card">
      <div className="card-head">
        <CardTitle icon="cube" label="Objects" closed={closed} onToggle={toggle} />
        <span className="spacer" />
        <button className="icon-btn" title="Expand all" aria-label="Expand all" onClick={expandAllObjects}><Icon name="expandAll" size={14} /></button>
        <button className="icon-btn" title="Collapse all" aria-label="Collapse all" onClick={collapseAllObjects}><Icon name="collapseAll" size={14} /></button>
        <span className="badge">{s.objects.length}</span>
      </div>
      {!closed && <div className="objlist" role="tree">
        {s.plates.map((pl, pi) => {
          const objs = s.objects.filter((o) => objectPlate(o, s.printerId, plates) === pi);
          return (
            <div key={pl.id} role="group">
              {plates > 1 && <div className={`plate-row ${pi === s.activePlate ? 'active' : ''}`} onClick={() => s.set({ activePlate: pi })}>{pl.name}{pl.locked ? ' 🔒' : ''} · {objs.length}</div>}
              {objs.map((o) => {
                const own = Object.keys(o.overrides ?? {}).length;
                const hasKids = own > 0 || !!o.heightRanges?.length || !!o.parts?.length;
                const shut = !!rowsClosed[o.id];
                return (
                  <div key={o.id}>
                    <div role="treeitem" aria-selected={s.selected.includes(o.id) && !s.selectedPart}
                      className={`objrow ${s.selected.includes(o.id) && !s.selectedPart ? 'sel' : ''} ${o.printable === false ? 'off' : ''}`}
                      onClick={(e) => pick(e, o.id, pi)} onContextMenu={(e) => menuAt(e, 'object', o.id)}
                      onDoubleClick={() => renameObject(o.id)}>
                      {hasKids
                        ? <button className="obj-eye" title={shut ? 'Expand' : 'Collapse'} aria-label={shut ? 'Expand' : 'Collapse'} aria-expanded={!shut} onClick={(e) => { e.stopPropagation(); toggleObjectRow(o.id); }}><Icon name="chevronDown" size={13} style={{ transform: shut ? 'rotate(-90deg)' : undefined }} /></button>
                        : <span style={{ width: 22, flex: 'none' }} />}
                      <button className={`obj-eye ${o.hidden ? 'off' : ''}`} title={o.hidden ? 'Show in the 3D view' : 'Hide in the 3D view'} aria-label={o.hidden ? 'Show' : 'Hide'}
                        onClick={(e) => { e.stopPropagation(); s.updateObjects((x) => ({ ...x, hidden: !x.hidden || undefined }), [o.id]); }}>
                        <Icon name={o.hidden ? 'eyeOff' : 'eye'} size={13} />
                      </button>
                      <span className="name" title={o.name}>{o.name}</span>
                      {stepsOf(o).map((st, i) => (
                        <button key={st.plugin + i} className={`badge step ${generatorOf(o) === st ? 'gen' : ''}`} title={`${i === 0 && generatorOf(o) ? 'Made with' : 'Then'} ${stepLabel(st.plugin)} — click to edit in its Studio`}
                          onClick={(e) => { e.stopPropagation(); editStep(o, st); }}>{stepLabel(st.plugin).slice(0, 2)}</button>
                      ))}
                      {paintBadges(o).map(([k, t]) => <span key={k} className="badge paint" title={t}>{k}</span>)}
                      {o.layerHeights && <span className="badge" title="Variable layer height">VLH</span>}
                      {o.openEdges > 0 && <span className="warn" title={`${o.openEdges} open edges — mesh is not watertight`}><Icon name="warn" size={14} /></span>}
                      {isOutOfBounds(o, s.printerId, plates) && <span className="warn" title="Outside the printable area" style={{ color: 'var(--error)' }}><Icon name="warn" size={14} /></span>}
                      <button className={`obj-edit ${own ? 'has' : ''}`} title={own ? `${own} own setting${own > 1 ? 's' : ''} — edit` : 'Edit this object\'s settings'}
                        onClick={(e) => { e.stopPropagation(); s.set({ selected: [o.id], selectedPart: null, processMode: 'objects' }); useUi.getState().set({ inspectorCtx: 'object' }); }}>
                        <Icon name="gear" size={13} />
                      </button>
                      <select className="fil-pick" value={o.filament ?? 0} title="Filament" onClick={(e) => e.stopPropagation()}
                        style={{ background: slotColor(s, o.filament ?? 0) }}
                        onChange={(e) => s.updateObjects((x) => ({ ...x, filament: +e.target.value }), [o.id])}>
                        {s.filaments.map((_, k) => <option key={k} value={k}>{k + 1}</option>)}
                        {s.mixes.map((m, k) => <option key={`m${k}`} value={s.filaments.length + k}>{s.filaments.length + k + 1} · mix</option>)}
                      </select>
                    </div>
                    {!shut && own > 0 && (
                      <div className="objrow sub" onClick={() => s.set({ selected: [o.id], selectedPart: null, processMode: 'objects' })}>
                        <Icon name="gear" size={12} /><span className="name">{Object.keys(o.overrides!).map((k) => PARAM_BY_KEY[k]?.label ?? k).join(', ')}</span>
                      </div>
                    )}
                    {!shut && (o.heightRanges ?? []).map((r) => (
                      <div key={r.id} className={`objrow part ${s.selectedRange === r.id && !s.selectedPart ? 'sel' : ''}`}
                        onClick={() => s.set({ selected: [o.id], selectedPart: null, selectedRange: r.id, processMode: 'objects', activePlate: pi })}>
                        <Icon name="layers" size={12} />
                        <span className="name">Layers</span>
                        <RangeInput value={r.z0} onCommit={(v) => updateHeightRange(o.id, r.id, { z0: Math.min(v, r.z1 - 0.01) })} />–
                        <RangeInput value={r.z1} onCommit={(v) => updateHeightRange(o.id, r.id, { z1: Math.max(v, r.z0 + 0.01) })} />mm
                        {Object.keys(r.overrides).length > 0 && <Icon name="gear" size={12} />}
                        <button className="icon-btn" title="Delete height range" onClick={(e) => { e.stopPropagation(); updateHeightRange(o.id, r.id, null); }}><Icon name="close" size={12} /></button>
                      </div>
                    ))}
                    {!shut && (o.parts ?? []).map((p) => (
                      <div key={p.id} className={`objrow part ${s.selectedPart === p.id ? 'sel' : ''}`}
                        onClick={() => s.set({ selected: [o.id], selectedPart: p.id, activePlate: pi })} onContextMenu={(e) => menuAt(e, 'part', o.id, p.id)}>
                        <span className="part-dot" style={{ background: p.type === 'modifier' && isWaveZone(p.overrides) ? (p.overrides.wave_mode === 'plain' ? '#94A3B8' : '#14B8A6') : PART_DOT[p.type] }} />
                        <span className="name">{p.name}</span>
                        {Object.keys(p.overrides).length > 0 && <Icon name="gear" size={12} />}
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          );
        })}
        {!s.objects.length && <div className="empty-hint" style={{ margin: 0 }}>No objects. Right-click the plate to add a shape, or drop a model file here.</div>}
      </div>}
    </section>
  );
}

function paintBadges(o: { paint?: { support?: ArrayLike<number>; seam?: ArrayLike<number>; color?: ArrayLike<number> }; brimEars?: unknown[] }): [string, string][] {
  const any = (a?: ArrayLike<number>) => !!a && Array.prototype.some.call(a, (v: number) => v !== 0);
  const out: [string, string][] = [];
  if (any(o.paint?.support)) out.push(['S', 'Support painted']);
  if (any(o.paint?.seam)) out.push(['Z', 'Seam painted']);
  if (any(o.paint?.color)) out.push(['C', 'Colour painted']);
  if (o.brimEars?.length) out.push(['B', 'Brim ears']);
  return out;
}

function RangeInput({ value, onCommit }: { value: number; onCommit: (v: number) => void }) {
  const [d, setD] = useState<string | null>(null);
  return <input className="input range-z mono" value={d ?? String(value)} onClick={(e) => e.stopPropagation()} onChange={(e) => setD(e.target.value)}
    onBlur={() => { if (d !== null) { const v = parseFloat(d); if (isFinite(v) && v >= 0) onCommit(+v.toFixed(2)); setD(null); } }}
    onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />;
}

const PART_DOT: Record<string, string> = { part: '#10B981',  negative: '#FF3B30', modifier: '#FFC107', support_enforcer: '#1E88E5', support_blocker: '#E53935' };
export const PART_HELP: Record<string, string> = {
  part: 'An extra solid volume printed as part of the object.',
  negative: 'Material inside this volume is removed (holes, cut-outs).',
  modifier: 'Changes infill settings inside this volume.',
  support_enforcer: 'Support is generated under any overhang inside this volume.',
  support_blocker: 'No support is generated inside this volume.',
};

export function FlushModal({ onClose }: { onClose: () => void }) {
  const { filaments, flushMatrix, flushMultiplier, set, markDirty } = useStore();
  const colors = filaments.map((f) => f.color);
  const auto = autoFlushMatrix(colors);
  const val = (i: number, j: number) => flushMatrix?.[i]?.[j] ?? auto[i][j];
  const setVal = (i: number, j: number, v: number) => {
    const m = colors.map((_, a) => colors.map((__, b) => val(a, b)));
    m[i][j] = v;
    set({ flushMatrix: m }); markDirty();
  };
  return (
    <Modal title="Flushing volumes (mm³)" onClose={onClose} footer={<>
      <button className="btn-secondary btn-small" onClick={() => { set({ flushMatrix: null }); markDirty(); }}>Auto-calculate</button>
      <span className="spacer" />
      <span className="muted" style={{ fontSize: 12 }}>Multiplier</span>
      <input className="input mono" style={{ width: 60 }} type="number" step="0.1" min="0" value={flushMultiplier} onChange={(e) => { set({ flushMultiplier: Math.max(0, Number(e.target.value) || 0) }); markDirty(); }} />
      <button className="btn-primary btn-small" onClick={onClose}>Done</button>
    </>}>
      <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>Purge needed when changing from the filament in a row to the filament in a column. Dark → light needs the most. {flushMatrix ? 'Edited values are used.' : 'Values are calculated from the colours.'}</p>
      <div style={{ overflowX: 'auto' }}>
        <table className="flush-table">
          <thead><tr><th>From \ To</th>{filaments.map((f, j) => <th key={j}><span className="swatch" style={{ background: f.color, display: 'inline-block' }} /> {j + 1}</th>)}</tr></thead>
          <tbody>
            {filaments.map((f, i) => (
              <tr key={i}>
                <th><span className="swatch" style={{ background: f.color, display: 'inline-block' }} /> {i + 1}</th>
                {filaments.map((_, j) => <td key={j}>{i === j ? <span className="muted">—</span> : (
                  <input className="input mono" style={{ width: 64 }} value={val(i, j)} onChange={(e) => setVal(i, j, Math.max(0, Number(e.target.value.replace(/[^\d]/g, '')) || 0))} />
                )}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}
