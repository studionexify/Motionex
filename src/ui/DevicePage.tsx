// Device workspace: saved printers, live status, camera, job control, telemetry, AMS, HMS and files.
import { useEffect, useMemo, useRef, useState } from 'react';
import { CONNECTION_INFO, type ConnectionKind, type PrinterStatus, type RemoteFile, type SavedDevice } from '../connect/types';
import { discoverPrinters, onSerialPortRequest, type FoundPrinter } from '../connect/client';
import { PRINTERS, printerById, printerName } from '../profiles/printers';
import { effectiveNozzle } from '../profiles/resolve';
import { connectDevice, disconnectDevice, initDevices, removeDevice, run, saveDevice, uploadAndPrint, useDevices } from '../state/devices';
import { newId, useStore } from '../state/store';
import { isDesktop } from '../platform';
import { Icon } from './icons';
import { Modal } from './Modals';
import { HoldersTile } from './FilamentHolders';

const STATE_LABEL: Record<PrinterStatus['state'], string> = {
  offline: 'Offline', connecting: 'Connecting', idle: 'Idle', printing: 'Printing', paused: 'Paused', finished: 'Finished', error: 'Error',
};
const STATE_COLOR: Record<PrinterStatus['state'], string> = {
  offline: 'var(--text-muted)', connecting: '#F2B33D', idle: '#5DBE7A', printing: 'var(--accent)', paused: '#F2B33D', finished: '#5DBE7A', error: '#E5484D',
};

export const fmtDuration = (s?: number) => {
  if (s == null || !isFinite(s)) return '—';
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
};
const toast = (kind: 'info' | 'warn' | 'error', text: string) => useStore.getState().set({ toast: { kind, text } });
const tryRun = async (fn: () => Promise<unknown>, ok?: string) => {
  try { await fn(); if (ok) toast('info', ok); } catch (e: any) { toast('error', e?.message ?? String(e)); }
};

export function StatusDot({ s }: { s?: PrinterStatus }) {
  const st = s?.state ?? 'offline';
  return <span title={STATE_LABEL[st]} style={{ width: 9, height: 9, borderRadius: 5, background: STATE_COLOR[st], flex: 'none', display: 'inline-block' }} />;
}

export function DevicePage() {
  const { devices, status, selected, loaded, set } = useDevices();
  const [edit, setEdit] = useState<SavedDevice | null>(null);
  const [ports, setPorts] = useState<{ list: { portId: string; displayName?: string; portName?: string }[]; pick: (id: string) => void } | null>(null);
  useEffect(() => { void initDevices(); }, []);
  useEffect(() => onSerialPortRequest((list, pick) => setPorts({ list, pick })), []);
  const dev = devices.find((d) => d.id === selected) ?? null;
  const [found, setFound] = useState<FoundPrinter[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const scan = async () => {
    setScanning(true);
    try { setFound(await discoverPrinters()); } finally { setScanning(false); }
  };
  const known = (f: FoundPrinter) => devices.some((d) => d.config.host === f.host || (f.serial && d.config.serial === f.serial));
  const addFound = (f: FoundPrinter) => {
    const p = PRINTERS.find((x) => f.model && x.printerModelId === f.model) ?? printerById(useStore.getState().printerId);
    setEdit({ id: newId(), name: f.name || p.model, printerId: p.id, config: { kind: f.kind, host: f.host, serial: f.serial, hostname: f.hostname } });
  };

  const newDevice = () => {
    const p = printerById(useStore.getState().printerId);
    setEdit({ id: newId(), name: p.model, printerId: p.id, config: { kind: p.connections[0] ?? 'moonraker' } });
  };

  return (
    <div className="device-layout">
      <aside className="device-list">
        <div className="row" style={{ marginBottom: 10 }}>
          <b style={{ color: 'var(--text-strong)', fontSize: 14 }}>Printers</b><span className="spacer" />
          {isDesktop() && <button className="btn-small" disabled={scanning} onClick={() => void scan()} title="Find printers on this Wi-Fi network">{scanning ? 'Scanning…' : 'Find on Wi-Fi'}</button>}
          <button className="btn-primary btn-small" onClick={newDevice}><Icon name="add" size={14} />Add</button>
        </div>
        {found && (
          <div style={{ marginBottom: 10, fontSize: 12 }}>
            {!found.filter((f) => !known(f)).length && <p className="muted">No new printers found. Make sure they are on and on the same Wi-Fi; Bambu printers need LAN mode or their access code.</p>}
            {found.filter((f) => !known(f)).map((f) => (
              <div key={f.serial ?? f.host} className="row" style={{ gap: 6, padding: '4px 0' }}>
                <div style={{ minWidth: 0, flex: 1 }}><div style={{ color: 'var(--text-strong)' }}>{f.name ?? f.host}</div><div className="muted" style={{ fontSize: 11 }}>{f.host}{f.serial ? ` · ${f.serial}` : ''}</div></div>
                <button className="btn-small" onClick={() => addFound(f)}>Set up</button>
              </div>
            ))}
          </div>
        )}
        {loaded && !devices.length && <p className="muted" style={{ fontSize: 12 }}>No printers yet. Add one to send prints over your network or USB.</p>}
        {devices.map((d) => (
          <div key={d.id} className={`objrow${d.id === selected ? ' sel' : ''}`} style={{ margin: '0 -12px', borderRadius: 0 }} onClick={() => set({ selected: d.id })}>
            <StatusDot s={status[d.id]} />
            <div style={{ minWidth: 0 }}>
              <div style={{ color: 'var(--text-strong)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.name}</div>
              <div className="muted" style={{ fontSize: 11 }}>{printerById(d.printerId).vendor} {printerById(d.printerId).model} · {CONNECTION_INFO[d.config.kind].label}</div>
            </div>
          </div>
        ))}
      </aside>
      <div className="page" style={{ padding: '24px 28px' }}>
        {dev ? <DeviceDashboard key={dev.id} dev={dev} onEdit={() => setEdit(dev)} /> : (
          <div className="empty-state">
            <Icon name="device" size={40} style={{ color: 'var(--accent)' }} />
            <h2>Connect a printer</h2>
            <p className="lead">NexSpiro talks to printers directly on your local network or over USB — no cloud account needed.</p>
            <button className="btn-primary" onClick={newDevice}><Icon name="add" />Add printer</button>
            <div className="grid-cards" style={{ marginTop: 24, textAlign: 'left' }}>
              {Object.entries(CONNECTION_INFO).map(([k, c]) => <div key={k} className="tile"><h3>{c.label}</h3><p>{c.description}</p></div>)}
            </div>
          </div>
        )}
      </div>
      {edit && <DeviceModal dev={edit} onClose={() => setEdit(null)} isNew={!devices.some((d) => d.id === edit.id)} />}
      {ports && (
        <Modal title="Choose USB port" onClose={() => { ports.pick(''); setPorts(null); }}>
          {!ports.list.length && <p>No serial devices found. Plug the printer in with a USB data cable and try again.</p>}
          {ports.list.map((p) => (
            <div key={p.portId} className="objrow" onClick={() => { ports.pick(p.portId); setPorts(null); }}>
              <Icon name="device" size={14} />{p.displayName || p.portName || p.portId}<span className="spacer" /><span className="badge">{p.portName}</span>
            </div>
          ))}
        </Modal>
      )}
    </div>
  );
}

function DeviceModal({ dev, isNew, onClose }: { dev: SavedDevice; isNew: boolean; onClose: () => void }) {
  const [d, setD] = useState<SavedDevice>(dev);
  const [testing, setTesting] = useState(false);
  const p = printerById(d.printerId);
  const kinds = useMemo(() => {
    const all = Object.keys(CONNECTION_INFO) as ConnectionKind[];
    if (p.connections.includes('bbl_lan')) return ['bbl_lan'] as ConnectionKind[]; // Bambu printers only speak their LAN protocol
    return [...p.connections, ...all.filter((k) => !p.connections.includes(k) && k !== 'bbl_lan')];
  }, [p]);
  const cfg = d.config;
  const setCfg = (c: Partial<SavedDevice['config']>) => setD({ ...d, config: { ...d.config, ...c } });
  const vendors = [...new Set(PRINTERS.map((x) => x.vendor))];
  const desktopOnly = CONNECTION_INFO[cfg.kind].desktopOnly && !isDesktop();
  const valid = cfg.kind === 'serial' || (!!cfg.host && (cfg.kind !== 'bbl_lan' || (!!cfg.serial && !!cfg.accessCode)));

  const save = async () => {
    const out: SavedDevice = { ...d, config: { ...d.config, ...(cfg.kind === 'bbl_lan' ? { cameraMode: p.cameraMode ?? 'jpeg' } : {}) } as SavedDevice['config'] };
    await saveDevice(out);
    onClose();
    return out;
  };
  return (
    <Modal title={isNew ? 'Add printer' : `Edit ${dev.name}`} onClose={onClose} footer={<>
      {!isNew && <button className="btn-secondary btn-small" onClick={async () => { if (confirm(`Remove ${dev.name}?`)) { await removeDevice(dev.id); onClose(); } }}><Icon name="trash" size={14} />Remove</button>}
      <span className="spacer" />
      <button className="btn-secondary btn-small" onClick={onClose}>Cancel</button>
      <button className="btn-secondary btn-small" disabled={!valid || testing || desktopOnly} onClick={async () => {
        setTesting(true);
        const saved = await save();
        try { await connectDevice(saved.id); toast('info', `${saved.name} connected.`); } catch (e: any) { toast('error', `Could not connect: ${e?.message ?? e}`); }
        setTesting(false);
      }}><Icon name="wifi" size={14} />Save & connect</button>
      <button className="btn-primary btn-small" disabled={!valid} onClick={save}>Save</button>
    </>}>
      <div className="form-grid" style={{ gridTemplateColumns: '150px 1fr' }}>
        <span>Name</span><input className="input" value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} />
        <span>Printer model</span>
        <select className="select" value={d.printerId} onChange={(e) => {
          const np = printerById(e.target.value);
          setD({ ...d, printerId: np.id, name: d.name === p.model ? np.model : d.name, config: { ...d.config, kind: np.connections.includes(d.config.kind) ? d.config.kind : np.connections[0] ?? 'moonraker' } });
        }}>
          {vendors.map((v) => <optgroup key={v} label={v}>{PRINTERS.filter((x) => x.vendor === v).map((x) => <option key={x.id} value={x.id}>{printerName(x)}</option>)}</optgroup>)}
        </select>
        {p.connections.length !== 1 && <>
          <span>Connection</span>
          <select className="select" value={cfg.kind} onChange={(e) => setCfg({ kind: e.target.value as ConnectionKind })}>
            {kinds.map((k) => <option key={k} value={k}>{CONNECTION_INFO[k].label}{p.connections.includes(k) ? '' : ' (generic)'}</option>)}
          </select>
        </>}
        {cfg.kind !== 'serial' && <><span>IP address / host</span><input className="input mono" placeholder="192.168.1.50" value={cfg.host ?? ''} onChange={(e) => setCfg({ host: e.target.value.trim() })} /></>}
        {cfg.kind === 'bbl_lan' && <>
          <span>Serial number</span><input className="input mono" placeholder="01P00A..." value={cfg.serial ?? ''} onChange={(e) => setCfg({ serial: e.target.value.trim().toUpperCase() })} />
          <span>Access code</span><input className="input mono" type="password" placeholder="8 characters" value={cfg.accessCode ?? ''} onChange={(e) => setCfg({ accessCode: e.target.value.trim() })} />
        </>}
        {cfg.kind === 'octoprint' && <>
          <span>API key</span><input className="input mono" type="password" value={cfg.apiKey ?? ''} onChange={(e) => setCfg({ apiKey: e.target.value.trim() })} />
        </>}
      </div>
      <details style={{ marginTop: 10 }}>
        <summary className="muted" style={{ fontSize: 12, cursor: 'pointer' }}>Advanced (only if your printer needs it)</summary>
      <div className="form-grid" style={{ gridTemplateColumns: '150px 1fr', marginTop: 8 }}>
        {cfg.kind === 'moonraker' && <>
          <span>Port</span><input className="input mono" placeholder={cfg.kind === 'moonraker' ? '7125' : '80'} value={cfg.port ?? ''} onChange={(e) => setCfg({ port: e.target.value ? Number(e.target.value) : undefined })} />
          <span>API key (optional)</span><input className="input mono" type="password" value={cfg.apiKey ?? ''} onChange={(e) => setCfg({ apiKey: e.target.value.trim() })} />
        </>}
        {cfg.kind === 'octoprint' && <><span>Port</span><input className="input mono" placeholder="80" value={cfg.port ?? ''} onChange={(e) => setCfg({ port: e.target.value ? Number(e.target.value) : undefined })} /></>}
        {cfg.kind === 'serial' && <>
          <span>Baud rate</span>
          <select className="select" value={cfg.baudRate ?? 115200} onChange={(e) => setCfg({ baudRate: Number(e.target.value) })}>
            {[250000, 230400, 115200, 57600].map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
        </>}
        {cfg.kind === 'bbl_lan' && <span className="muted" style={{ gridColumn: '1 / -1', fontSize: 12 }}>Nothing else needed.</span>}
      </div>
      </details>
      <p className="muted" style={{ fontSize: 12, marginTop: 12 }}>{CONNECTION_INFO[cfg.kind].description}</p>
      {cfg.kind === 'bbl_lan' && <p className="muted" style={{ fontSize: 12 }}>On the printer screen: <b>Settings → Network</b> (A1/P1) or <b>Settings → General</b> (X1) shows the IP and the access code; the serial number is under <b>Settings → Device</b>. Insert a microSD card — the printer stores LAN jobs on it.</p>}
      {desktopOnly && <p style={{ color: '#E5484D', fontSize: 12 }}>This connection needs the NexSpiro desktop app.</p>}
      {p.note && <p className="muted" style={{ fontSize: 12 }}><Icon name="info" size={12} /> {p.note}</p>}
    </Modal>
  );
}

function DeviceDashboard({ dev, onEdit }: { dev: SavedDevice; onEdit: () => void }) {
  const st = useDevices((s) => s.status[dev.id]) ?? { state: 'offline' as const };
  const busy = useDevices((s) => s.busy[dev.id]);
  const up = useDevices((s) => s.upload[dev.id]);
  const p = printerById(dev.printerId);
  // the nozzle chosen in the project applies to the printer the project is sliced for
  const projPrinter = useStore((s) => s.printerId), projMachine = useStore((s) => s.machineOverrides);
  const nozzle = dev.printerId === projPrinter ? effectiveNozzle(projPrinter, projMachine) : p.nozzle;
  const online = st.state !== 'offline' && st.state !== 'connecting';
  const active = st.state === 'printing' || st.state === 'paused';

  return (
    <>
      <div className="row" style={{ marginBottom: 16, gap: 10 }}>
        <Icon name="printer" size={26} style={{ color: 'var(--accent)' }} />
        <div>
          <h1 style={{ margin: 0 }}>{dev.name}</h1>
          <div className="muted" style={{ fontSize: 12 }}>{printerName(p, nozzle)} · {CONNECTION_INFO[dev.config.kind].label}{dev.config.host ? ` · ${dev.config.host}` : ''}{st.firmware ? ` · firmware ${st.firmware}` : ''}</div>
        </div>
        <span className="pill" style={{ background: 'var(--surface-tertiary)', color: STATE_COLOR[st.state] }}><StatusDot s={st} />{busy ?? STATE_LABEL[st.state]}</span>
        <span className="spacer" />
        <button className="btn-secondary btn-small" onClick={onEdit}><Icon name="edit" size={14} />Edit</button>
        {online
          ? <button className="btn-secondary btn-small" onClick={() => tryRun(() => disconnectDevice(dev.id))}>Disconnect</button>
          : <button className="btn-primary btn-small" disabled={!!busy} onClick={() => tryRun(() => connectDevice(dev.id))}><Icon name="wifi" size={14} />Connect</button>}
      </div>
      {st.message && <div className="tile" style={{ marginBottom: 12, borderColor: st.state === 'error' || st.state === 'offline' ? '#E5484D' : 'var(--border)' }}><Icon name="warn" size={14} /> {st.message}</div>}
      {up != null && <div className="tile" style={{ marginBottom: 12 }}>Uploading… {Math.round(up * 100)}%<div className="bar"><div style={{ width: `${up * 100}%` }} /></div></div>}

      <div className="device-grid">
        <div className="tile camera-tile"><Camera dev={dev} online={online} /></div>
        <div className="tile">
          <h3 style={{ marginTop: 0 }}>Print job</h3>
          {active || st.state === 'finished' ? (
            <>
              <div className="row"><b style={{ color: 'var(--text-strong)', overflow: 'hidden', textOverflow: 'ellipsis' }}>{st.fileName ?? 'Print'}</b><span className="spacer" /><b>{Math.round((st.progress ?? 0) * 100)}%</b></div>
              <div className="bar" style={{ marginBottom: 10 }}><div style={{ width: `${(st.progress ?? 0) * 100}%` }} /></div>
              <div className="summary" style={{ border: 0, marginTop: 0, paddingTop: 0 }}>
                <span className="k">Layer</span><span className="v">{st.layer != null ? `${st.layer}${st.totalLayers ? ` / ${st.totalLayers}` : ''}` : '—'}</span>
                <span className="k">Remaining</span><span className="v">{fmtDuration(st.remainingSeconds)}</span>
              </div>
              {active && <div className="row" style={{ marginTop: 10 }}>
                {st.state === 'paused'
                  ? <button className="btn-primary btn-small" onClick={() => tryRun(() => run(dev.id, 'Resuming…', (h) => h.resume()))}>Resume</button>
                  : <button className="btn-secondary btn-small" onClick={() => tryRun(() => run(dev.id, 'Pausing…', (h) => h.pause()))}>Pause</button>}
                <button className="btn-secondary btn-small" style={{ color: '#E5484D' }} onClick={() => { if (confirm('Stop the print? This cannot be resumed.')) void tryRun(() => run(dev.id, 'Stopping…', (h) => h.cancel())); }}>Stop</button>
              </div>}
            </>
          ) : <p className="muted">{online ? 'Ready. Slice a plate and press Print, or start a file below.' : 'Connect to see the printer status.'}</p>}
          <SpeedLight dev={dev} st={st} online={online} />
        </div>
        <Controls dev={dev} st={st} online={online} printing={active} />
        {st.ams?.length ? <Ams st={st} /> : null}
        <HoldersTile deviceKey={dev.id} />
        {st.hms?.length ? (
          <div className="tile">
            <h3 style={{ marginTop: 0 }}>Health (HMS)</h3>
            {st.hms.map((h) => (
              <div key={h.code} className="row" style={{ marginBottom: 4 }}>
                <Icon name="warn" size={14} style={{ color: h.severity === 'error' ? '#E5484D' : '#F2B33D' }} />
                <span className="mono" title="HMS error code (see the printer manufacturer's HMS documentation)">{h.code}</span>
              </div>
            ))}
          </div>
        ) : null}
        <Files dev={dev} online={online} printing={active} />
      </div>
    </>
  );
}

function SpeedLight({ dev, st, online }: { dev: SavedDevice; st: PrinterStatus; online: boolean }) {
  const isBbl = dev.config.kind === 'bbl_lan';
  return (
    <div className="row" style={{ marginTop: 14, flexWrap: 'wrap' }}>
      <span className="muted">Speed</span>
      {isBbl ? (
        <select className="select" style={{ maxWidth: 140, flex: 'none' }} disabled={!online} aria-label="Speed"
          value={({ 50: 1, 100: 2, 124: 3, 166: 4 } as Record<number, number>)[st.speedPercent ?? 100] ?? 2}
          onChange={(e) => { const lvl = Number(e.target.value); tryRun(() => run(dev.id, 'Speed…', (h) => h.setSpeed(lvl))); }}>
          {([[1, 'Silent'], [2, 'Standard'], [3, 'Sport'], [4, 'Ludicrous']] as const).map(([lvl, label]) => <option key={lvl} value={lvl}>{label}</option>)}
        </select>
      ) : (
        <select className="select" style={{ maxWidth: 100, flex: 'none' }} disabled={!online} value={st.speedPercent ?? 100} onChange={(e) => tryRun(() => run(dev.id, 'Speed…', (h) => h.setSpeed(Number(e.target.value))))}>
          {[50, 75, 100, 125, 150].map((v) => <option key={v} value={v}>{v}%</option>)}
          {st.speedPercent && ![50, 75, 100, 125, 150].includes(st.speedPercent) && <option value={st.speedPercent}>{st.speedPercent}%</option>}
        </select>
      )}
      <span className="spacer" />
      <button className="btn-secondary btn-small" disabled={!online} onClick={() => tryRun(() => run(dev.id, 'Light…', (h) => h.setLight(!st.light)))}><Icon name="sun" size={14} />Light {st.light ? 'off' : 'on'}</button>
    </div>
  );
}

function Camera({ dev, online }: { dev: SavedDevice; online: boolean }) {
  const [src, setSrc] = useState<string | null>(null);
  const [rtsp, setRtsp] = useState<string | null>(null);
  const [on, setOn] = useState(false);
  const [snap, setSnap] = useState<string | null>(null); // JPEG snapshot URL polled when there is no MJPEG stream
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!snap) return;
    const t = setInterval(() => setTick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, [snap]);
  const toSnapshot = (u: string) => u.replace(/action=stream/, 'action=snapshot').replace(/\/stream(\b|$)/, '/snapshot');
  useEffect(() => { if (!on || !online) setSnap(null); }, [on, online]);
  useEffect(() => {
    if (!on || !online) { setSrc(null); return; }
    let stop: (() => void) | null = null, dead = false;
    (async () => {
      try {
        const h = (await import('../state/devices')).handleOf(dev.id);
        stop = await h.camera((u) => { if (!dead) setSrc(u); });
        if (!stop) {
          const u = await h.cameraUrl();
          if (u?.startsWith('rtsp')) setRtsp(u); else if (!dead && u) { if (/snapshot/i.test(u)) setSnap(u); else setSrc(u); }
        }
      } catch (e: any) { toast('warn', `Camera: ${e?.message ?? e}`); }
    })();
    return () => { dead = true; stop?.(); };
  }, [on, online, dev.id]);
  return (
    <>
      <div className="row" style={{ marginBottom: 8 }}><h3 style={{ margin: 0 }}>Camera</h3><span className="spacer" />
        <button className="btn-secondary btn-small" disabled={!online} onClick={() => setOn(!on)}><Icon name="eye" size={14} />{on ? 'Stop' : 'Start'}</button></div>
      <div className="camera-view">
        {snap ? <img src={`${snap}${snap.includes('?') ? '&' : '?'}t=${tick}`} alt="Printer camera" />
          : src ? <img src={src} alt="Printer camera" onError={() => { if (!src.startsWith('blob:')) { setSnap(toSnapshot(src)); setSrc(null); } }} /> : rtsp ? (
          <p className="muted" style={{ padding: 16, fontSize: 12 }}>This printer streams RTSPS video. Open it in VLC: <span className="mono" style={{ userSelect: 'all', wordBreak: 'break-all' }}>{rtsp}</span></p>
        ) : <span className="muted">{online ? (on ? 'Waiting for the first frame…' : 'Camera off') : 'Offline'}</span>}
      </div>
    </>
  );
}

function FanRow({ label, pct, online, onSet }: { label: string; pct?: number; online: boolean; onSet: (v: number) => void }) {
  const [v, setV] = useState(pct ?? 0);
  return (
    <div className="row" style={{ marginBottom: 6 }}>
      <span style={{ width: 64 }}>{label}</span>
      <input type="range" min={0} max={100} step={10} disabled={!online} value={v} onChange={(e) => setV(+e.target.value)} onMouseUp={() => onSet(v)} onKeyUp={() => onSet(v)} style={{ flex: 1 }} aria-label={label} />
      <span className="badge">{pct ?? v}%</span>
    </div>
  );
}

/** Temperature history of a device : last 10 minutes of nozzle, bed and chamber. */
const HISTORY = new Map<string, { t: number; n?: number; nt?: number; b?: number; bt?: number; c?: number }[]>();
function TempChart({ id, st }: { id: string; st: PrinterStatus }) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (st.state === 'offline' || st.state === 'connecting') return;
    const h = HISTORY.get(id) ?? [];
    const now = Date.now();
    if (!h.length || now - h[h.length - 1].t > 900) {
      h.push({ t: now, n: st.nozzleTemp, nt: st.nozzleTarget, b: st.bedTemp, bt: st.bedTarget, c: st.chamberTemp });
      while (h.length && now - h[0].t > 600_000) h.shift();
      HISTORY.set(id, h);
      tick((x) => x + 1);
    }
  }, [id, st]);
  const h = HISTORY.get(id) ?? [];
  if (h.length < 2) return null;
  const W = 300, H = 90, t0 = h[0].t, t1 = h[h.length - 1].t;
  const top = Math.max(60, ...h.flatMap((p) => [p.n ?? 0, p.nt ?? 0, p.b ?? 0])) * 1.05;
  const X = (t: number) => ((t - t0) / Math.max(1, t1 - t0)) * W, Y = (v: number) => H - (v / top) * H;
  const path = (k: 'n' | 'b' | 'c' | 'nt' | 'bt') => h.filter((p) => p[k] != null).map((p, i) => `${i ? 'L' : 'M'}${X(p.t).toFixed(1)},${Y(p[k]!).toFixed(1)}`).join('');
  return (
    <div className="temp-chart" aria-label="Temperature history">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" width="100%" height={H}>
        {[0.25, 0.5, 0.75].map((f) => <line key={f} x1={0} x2={W} y1={H * f} y2={H * f} className="grid" />)}
        <path d={path('nt')} className="target nozzle" /><path d={path('bt')} className="target bed" />
        <path d={path('n')} className="nozzle" /><path d={path('b')} className="bed" /><path d={path('c')} className="chamber" />
      </svg>
      <div className="row muted" style={{ fontSize: 11, gap: 10 }}>
        <span><i className="key nozzle" />Nozzle</span><span><i className="key bed" />Bed</span>{h.some((p) => p.c != null) && <span><i className="key chamber" />Chamber</span>}
        <span className="spacer" />{Math.round((t1 - t0) / 60000)} min · max {Math.round(top / 1.05)}°
      </div>
    </div>
  );
}

function TempRow({ label, cur, target, online, onSet, max }: { label: string; cur?: number; target?: number; online: boolean; onSet: (v: number) => void; max: number }) {
  const [v, setV] = useState('');
  return (
    <div className="row" style={{ marginBottom: 6 }}>
      <span style={{ width: 64 }}>{label}</span>
      <b className="mono" style={{ width: 92, color: 'var(--text-strong)' }}>{cur != null ? `${cur.toFixed(0)}°` : '—'}{target ? ` / ${target.toFixed(0)}°` : ''}</b>
      <input className="input mono" style={{ width: 64 }} placeholder="°C" value={v} disabled={!online} onChange={(e) => setV(e.target.value.replace(/[^\d]/g, ''))}
        onKeyDown={(e) => { if (e.key === 'Enter' && v) { onSet(Math.min(max, Number(v))); setV(''); } }} />
      <button className="btn-secondary btn-small" disabled={!online || !v} onClick={() => { onSet(Math.min(max, Number(v))); setV(''); }}>Set</button>
      <button className="btn-secondary btn-small" disabled={!online} onClick={() => onSet(0)} title="Turn off">Off</button>
    </div>
  );
}

function Controls({ dev, st, online, printing }: { dev: SavedDevice; st: PrinterStatus; online: boolean; printing: boolean }) {
  const [step, setStep] = useState(10);
  const [line, setLine] = useState('');
  const [log, setLog] = useState<string[]>([]);
  const g = (code: string) => tryRun(() => run(dev.id, 'Sending…', (h) => h.sendGcode(code)));
  const isBbl = dev.config.kind === 'bbl_lan';
  const jog = (axis: string, d: number) => g(`G91\nG1 ${axis}${d} F${axis === 'Z' ? 600 : 6000}\nG90`);
  const send = async () => {
    if (!line.trim()) return;
    setLog((l) => [...l.slice(-30), `> ${line}`]);
    await g(line);
    setLine('');
  };
  return (
    <div className="tile">
      <h3 style={{ marginTop: 0 }}>Controls</h3>
      {st.heads && st.heads.length > 1
        ? st.heads.map((h, k) => <TempRow key={k} label={`T${k}${st.activeHead === k ? ' ●' : ''}`} cur={h.temp} target={h.target} online={online} max={320} onSet={(v) => g(`M104 T${k} S${v}`)} />)
        : <TempRow label="Nozzle" cur={st.nozzleTemp} target={st.nozzleTarget} online={online} max={320} onSet={(v) => g(`M104 S${v}`)} />}
      <TempRow label="Bed" cur={st.bedTemp} target={st.bedTarget} online={online} max={120} onSet={(v) => g(`M140 S${v}`)} />
      {st.chamberTemp != null && <div className="row" style={{ marginBottom: 6 }}><span style={{ width: 64 }}>Chamber</span><b className="mono">{st.chamberTemp.toFixed(0)}°</b></div>}
      <FanRow label="Part fan" pct={st.fanPercent} online={online} onSet={(v) => g(`M106 S${Math.round((v / 100) * 255)}`)} />
      {isBbl && <>
        <FanRow label="Aux fan" online={online} onSet={(v) => g(`M106 P2 S${Math.round((v / 100) * 255)}`)} />
        <FanRow label="Chamber" online={online} onSet={(v) => g(`M106 P3 S${Math.round((v / 100) * 255)}`)} />
      </>}
      <TempChart id={dev.id} st={st} />
      <div className="jog">
        <div className="jog-xy">
          <span /><button disabled={!online || printing} onClick={() => jog('Y', step)}>Y+</button><span />
          <button disabled={!online || printing} onClick={() => jog('X', -step)}>X−</button>
          <button disabled={!online || printing} onClick={() => g('G28')} title="Home all axes"><Icon name="home" size={14} /></button>
          <button disabled={!online || printing} onClick={() => jog('X', step)}>X+</button>
          <span /><button disabled={!online || printing} onClick={() => jog('Y', -step)}>Y−</button><span />
        </div>
        <div className="jog-z">
          <button disabled={!online || printing} onClick={() => jog('Z', step / 10 >= 1 ? step / 10 : 1)}>Z+</button>
          <button disabled={!online || printing} onClick={() => jog('Z', -(step / 10 >= 1 ? step / 10 : 1))}>Z−</button>
        </div>
        <div className="jog-z">
          <button disabled={!online || printing} onClick={() => g('G91\nG1 E10 F300\nG90')} title="Extrude 10 mm">E+</button>
          <button disabled={!online || printing} onClick={() => g('G91\nG1 E-10 F1200\nG90')} title="Retract 10 mm">E−</button>
        </div>
        <div className="seg" style={{ alignSelf: 'start' }}>
          {[1, 10, 50].map((s) => <button key={s} className={step === s ? 'on' : ''} onClick={() => setStep(s)}>{s}</button>)}
        </div>
      </div>
      <div className="console">{log.map((l, i) => <div key={i}>{l}</div>)}</div>
      <div className="row" style={{ marginTop: 6 }}>
        <input className="input mono" style={{ flex: 1 }} placeholder="Send G-code, e.g. M115" value={line} disabled={!online} onChange={(e) => setLine(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void send(); }} />
        <button className="btn-secondary btn-small" disabled={!online || !line.trim()} onClick={send}>Send</button>
      </div>
    </div>
  );
}

function Ams({ st }: { st: PrinterStatus }) {
  return (
    <div className="tile">
      <h3 style={{ marginTop: 0 }}>AMS</h3>
      {st.ams!.map((u) => (
        <div key={u.id} style={{ marginBottom: 10 }}>
          <div className="row muted" style={{ fontSize: 11, marginBottom: 6 }}>AMS {Number(u.id) + 1}<span className="spacer" />{u.humidity != null && `Humidity level ${u.humidity}`}{u.temp != null && ` · ${u.temp}°C`}</div>
          <div className="ams-row">
            {u.trays.map((t) => (
              <div key={t.id} className={`ams-tray${t.active ? ' on' : ''}`} title={t.type || 'Empty'}>
                <div className="ams-color" style={{ background: t.color || 'transparent' }}>{!t.type && <span className="muted">—</span>}</div>
                <b>{t.type || 'Empty'}</b>
                <span className="muted">{t.remain != null ? `${t.remain}%` : ''}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function Files({ dev, online, printing }: { dev: SavedDevice; online: boolean; printing: boolean }) {
  const [files, setFiles] = useState<RemoteFile[] | null>(null);
  const [loading, setLoading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const refresh = async () => {
    setLoading(true);
    try { setFiles(await run(dev.id, 'Listing files…', (h) => h.listFiles())); }
    catch (e: any) { toast('error', e?.message ?? String(e)); }
    setLoading(false);
  };
  useEffect(() => { if (online) void refresh(); else setFiles(null); }, [online]); // eslint-disable-line react-hooks/exhaustive-deps
  const uploadLocal = async (f: { name: string; data: ArrayBuffer }) => {
    await tryRun(() => uploadAndPrint(dev.id, f.name, f.data, false), `${f.name} uploaded.`);
    void refresh();
  };
  return (
    <div className="tile" style={{ gridColumn: '1 / -1' }}>
      <div className="row" style={{ marginBottom: 8 }}>
        <h3 style={{ margin: 0 }}>Files on printer</h3><span className="spacer" />
        <input ref={fileInput} type="file" accept=".gcode,.3mf,.gco,.g" hidden onChange={async (e) => {
          const f = e.target.files?.[0];
          if (f) await uploadLocal({ name: f.name, data: await f.arrayBuffer() });
          e.target.value = '';
        }} />
        <button className="btn-secondary btn-small" disabled={!online} onClick={() => fileInput.current?.click()}><Icon name="add" size={14} />Upload file</button>
        <button className="btn-secondary btn-small" disabled={!online || loading} onClick={refresh}><Icon name="reset" size={14} />Refresh</button>
      </div>
      {!online ? <p className="muted">Connect to browse files.</p> : !files ? <p className="muted">Loading…</p> : !files.length ? <p className="muted">No printable files on the printer.</p> : (
        <div className="file-list">
          {files.map((f) => (
            <div key={f.name} className="row file-row">
              <Icon name="file" size={14} />
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
              <span className="muted" style={{ fontSize: 11 }}>{f.size != null ? `${(f.size / 1048576).toFixed(1)} MB` : ''}{f.modified ? ` · ${new Date(f.modified).toLocaleString()}` : ''}</span>
              <button className="btn-secondary btn-small" disabled={printing} onClick={() => tryRun(() => run(dev.id, 'Starting print…', (h) => h.startPrint(f.name, { plate: 1 })), `Printing ${f.name}`)}><Icon name="print" size={14} />Print</button>
              <button className="icon-btn" title="Delete" onClick={async () => { if (confirm(`Delete ${f.name} from the printer?`)) { await tryRun(() => run(dev.id, 'Deleting…', (h) => h.deleteFile(f.name))); void refresh(); } }}><Icon name="trash" size={14} /></button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

