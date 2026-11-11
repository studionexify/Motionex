// "Print plate" dialog: pick a saved printer, map filaments to AMS trays (A1/P1/X1/H2 printers), upload and start.
import { useEffect, useMemo, useState } from 'react';
import { create } from 'zustand';
import { CONNECTION_INFO, type AmsTray } from '../connect/types';
import { filamentById } from '../profiles/filaments';
import { printerById } from '../profiles/printers';
import { changerOf, toolheadCount } from '../profiles/changer';
import { toolMapProblems, parseToolMap } from '../engine/toolmap';
import { currentConfig } from '../state/slicing';
import { connectDevice, initDevices, reportDeviceError, uploadAndPrint, useDevices } from '../state/devices';
import { buildPrintJob } from '../state/printjob';
import { useStore } from '../state/store';
import { fmtDuration, StatusDot } from './DevicePage';
import { Icon } from './icons';
import { Modal } from './Modals';

const hexDist = (a: string, b: string) => {
  const p = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) || 0);
  const x = p(a), y = p(b);
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
};

/** Default AMS mapping: same material type first, then the closest colour. */
export function autoMap(slots: { type: string; color: string }[], trays: AmsTray[]): number[] {
  const taken = new Set<string>();
  return slots.map((s) => {
    let best: AmsTray | null = null, bd = Infinity;
    for (const t of trays) {
      if (!t.type || taken.has(t.id)) continue;
      const d = (t.type.toUpperCase() === s.type.toUpperCase() ? 0 : 1000) + hexDist(t.color || '#000000', s.color);
      if (d < bd) { bd = d; best = t; }
    }
    if (!best) return -1;
    taken.add(best.id);
    return Number(best.id);
  });
}

export function PrintModal({ onClose }: { onClose: () => void }) {
  const s = useStore();
  const { devices, status, selected } = useDevices();
  const result = s.slice.result;
  const profile = printerById(s.printerId);
  const compatible = devices.filter((d) => printerById(d.printerId).flavor === profile.flavor);
  const [devId, setDevId] = useState<string | null>(null);
  const dev = devices.find((d) => d.id === devId) ?? null;
  const st = dev ? status[dev.id] : undefined;
  const isBbl = dev?.config.kind === 'bbl_lan';
  const [opts, setOpts] = useState({ bedLevelling: true, flowCalibration: false, timelapse: false, useAms: true });
  const [mapping, setMapping] = useState<number[] | null>(null);
  const [sending, setSending] = useState(false);
  const used = useMemo(() => (result?.stats.perFilament ?? []).map((f, k) => (f.mm > 0 ? k : -1)).filter((k) => k >= 0), [result]);
  const trays = (st?.ams ?? []).flatMap((u) => u.trays);
  // tool changer (Snapmaker U1, XL, Klipper changers): map each filament to the head it is loaded on
  const machineCfg = useMemo(() => currentConfig(s.slice.plate), [s.slice.plate, s.printerId]); // eslint-disable-line react-hooks/exhaustive-deps
  const isChanger = changerOf(machineCfg) === 'toolchanger';
  const heads = isChanger ? Math.max(toolheadCount(machineCfg), st?.heads?.length ?? 0) : 0;
  const [toolMap, setToolMap] = useState<number[]>(() => parseToolMap(machineCfg.tool_map));
  const mapProblems = isChanger ? toolMapProblems(toolMap, used, heads) : [];

  useEffect(() => { void initDevices(); }, []);
  useEffect(() => {
    if (devId) return;
    const pick = compatible.find((d) => d.id === selected) ?? compatible[0] ?? devices[0];
    if (pick) setDevId(pick.id);
  }, [devices.length]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (dev && (!st || st.state === 'offline')) connectDevice(dev.id).catch((e) => reportDeviceError(`Could not connect to ${dev.name}`, e));
  }, [dev?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!trays.length) { setMapping(null); return; }
    if (mapping) return;
    const slots = s.filaments.map((f) => ({ type: filamentById(f.presetId).type, color: f.color }));
    setMapping(autoMap(slots, trays));
  }, [trays.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const send = async (start: boolean) => {
    if (!dev) return;
    setSending(true);
    try {
      const job = await buildPrintJob(isBbl ? '3mf' : 'gcode', isChanger ? { toolMap: s.filaments.map((_, k) => toolMap[k] ?? k) } : {});
      if (!job) return;
      const amsMapping = isBbl && opts.useAms && mapping ? s.filaments.map((_, k) => mapping[k] ?? -1) : undefined;
      await uploadAndPrint(dev.id, job.name, job.data, start, { plate: 1, ...opts, useAms: opts.useAms && !!trays.length, amsMapping });
      s.set({ toast: { kind: 'info', text: start ? `Print started on ${dev.name}.` : `${job.name} sent to ${dev.name}.` } });
      onClose();
    } catch (e: any) {
      s.set({ toast: { kind: 'error', text: `Could not send to ${dev.name}: ${e?.message ?? e}` } });
    } finally { setSending(false); }
  };
  const busy = st?.state === 'printing' || st?.state === 'paused';

  return (
    <Modal title="Print plate" onClose={onClose} footer={<>
      <button className="btn-secondary btn-small" onClick={() => { s.set({ workspace: 'device' }); onClose(); }}><Icon name="device" size={14} />Devices</button>
      <span className="spacer" />
      <button className="btn-secondary btn-small" disabled={!dev || sending} onClick={() => send(false)}>Send only</button>
      <button className="btn-primary btn-small" disabled={!dev || sending || busy || mapProblems.length > 0} onClick={() => send(true)}><Icon name="print" size={14} />{sending ? 'Sending…' : 'Print'}</button>
    </>}>
      {!devices.length ? (
        <div className="empty-state" style={{ margin: 10 }}>
          <p>No printers added yet.</p>
          <button className="btn-primary btn-small" onClick={() => { s.set({ workspace: 'device' }); onClose(); }}><Icon name="add" size={14} />Add a printer</button>
        </div>
      ) : (
        <>
          <div className="form-grid" style={{ gridTemplateColumns: '120px 1fr' }}>
            <span>Printer</span>
            <select className="select" value={devId ?? ''} onChange={(e) => { setDevId(e.target.value); setMapping(null); }}>
              {devices.map((d) => <option key={d.id} value={d.id}>{d.name} — {CONNECTION_INFO[d.config.kind].label}</option>)}
            </select>
            <span>Status</span><span className="row"><StatusDot s={st} />{st?.state ?? 'offline'}{st?.message ? ` — ${st.message}` : ''}</span>
            {result && !result.stats.repeat && <><span>Estimate</span><span>{fmtDuration(result.stats.timeSeconds)} · {result.stats.filamentGrams.toFixed(1)} g</span></>}
            {result?.stats.repeat && <><span>Prints</span><span>{result.stats.repeat.cycles}× ({result.stats.repeat.cycles * result.stats.repeat.partsPerCycle} parts)</span>
              <span>One print</span><span>{fmtDuration(result.stats.timeSeconds)} · {result.stats.filamentGrams.toFixed(1)} g</span>
              <span>Whole job</span><span>{fmtDuration(result.stats.repeat.totalSeconds)} · {result.stats.repeat.totalGrams.toFixed(1)} g</span></>}
          </div>
          {dev && printerById(dev.printerId).flavor !== profile.flavor && (
            <p style={{ color: '#E5484D', fontSize: 12 }}><Icon name="warn" size={12} /> This plate is sliced for {profile.vendor} {profile.model}; {dev.name} is a {printerById(dev.printerId).model}. Re-slice for the right printer first.</p>
          )}
          {busy && <p style={{ color: '#F2B33D', fontSize: 12 }}>The printer is busy. You can still send the file and start it later.</p>}
          {isChanger && (
            <>
              <h3 style={{ fontSize: 13, marginBottom: 6 }}>Toolhead mapping</h3>
              <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>Each filament prints with its own head: no purge, a few seconds per swap. Pick the head each colour is loaded on.</p>
              {used.map((k) => {
                const f = s.filaments[k];
                const h = toolMap[k] ?? k;
                const live = st?.heads?.[h];
                return (
                  <div key={k} className="row" style={{ marginBottom: 6 }}>
                    <span className="swatch" style={{ background: f.color }} /><span style={{ width: 150 }}>{k + 1}: {filamentById(f.presetId).name}</span>
                    <Icon name="chevron" size={12} style={{ transform: 'rotate(-90deg)' }} />
                    <select className="select" value={h} onChange={(e) => { const m = s.filaments.map((_, j) => toolMap[j] ?? j); m[k] = Number(e.target.value); setToolMap(m); }}>
                      {Array.from({ length: heads }, (_, t) => <option key={t} value={t}>Head T{t}{st?.heads?.[t]?.temp != null ? ` — ${Math.round(st.heads[t].temp!)}°` : ''}</option>)}
                    </select>
                    {live?.temp != null && <span className="muted" style={{ fontSize: 12 }}>{Math.round(live.temp)}° now</span>}
                  </div>
                );
              })}
              {mapProblems.map((p) => <p key={p} style={{ color: '#E5484D', fontSize: 12, margin: '2px 0' }}><Icon name="warn" size={12} /> {p}</p>)}
            </>
          )}
          {isBbl && (
            <>
              <h3 style={{ fontSize: 13, marginBottom: 6 }}>Options</h3>
              <div className="row" style={{ flexWrap: 'wrap', gap: 14 }}>
                {([['bedLevelling', 'Bed levelling'], ['flowCalibration', 'Flow calibration'], ['timelapse', 'Timelapse'], ['useAms', 'Use AMS']] as const).map(([k, label]) => (
                  <label key={k} className="row" style={{ gap: 6 }}><input type="checkbox" checked={opts[k]} onChange={(e) => setOpts({ ...opts, [k]: e.target.checked })} />{label}</label>
                ))}
              </div>
              {opts.useAms && (
                <>
                  <h3 style={{ fontSize: 13, marginBottom: 6 }}>Filament mapping</h3>
                  {!trays.length && <p className="muted" style={{ fontSize: 12 }}>{st && st.state !== 'offline' ? 'No AMS detected — the external spool will be used.' : 'Connecting to read the AMS…'}</p>}
                  {trays.length > 0 && used.map((k) => {
                    const f = s.filaments[k];
                    return (
                      <div key={k} className="row" style={{ marginBottom: 6 }}>
                        <span className="swatch" style={{ background: f.color }} /><span style={{ width: 150 }}>{k + 1}: {filamentById(f.presetId).name}</span>
                        <Icon name="chevron" size={12} style={{ transform: 'rotate(-90deg)' }} />
                        <select className="select" value={mapping?.[k] ?? -1} onChange={(e) => { const m = [...(mapping ?? [])]; m[k] = Number(e.target.value); setMapping(m); }}>
                          <option value={-1}>External spool</option>
                          {trays.map((t) => <option key={t.id} value={Number(t.id)} disabled={!t.type}>AMS {Math.floor(Number(t.id) / 4) + 1} slot {(Number(t.id) % 4) + 1} — {t.type || 'empty'}</option>)}
                        </select>
                        {mapping?.[k] != null && mapping[k] >= 0 && <span className="swatch" style={{ background: trays.find((t) => Number(t.id) === mapping[k])?.color }} />}
                      </div>
                    );
                  })}
                </>
              )}
            </>
          )}
        </>
      )}
    </Modal>
  );
}

const usePrintDialog = create<{ open: boolean }>(() => ({ open: false }));
/** Slice if needed, then open the print dialog. */
export async function openPrintDialog() {
  const { ensureSliced } = await import('../state/printjob');
  if (await ensureSliced()) usePrintDialog.setState({ open: true });
}
export function PrintDialogHost() {
  const open = usePrintDialog((s) => s.open);
  return open ? <PrintModal onClose={() => usePrintDialog.setState({ open: false })} /> : null;
}
