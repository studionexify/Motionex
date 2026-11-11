// Bulnex panel: cycle and push settings, row arrangement with a suggestion, the pre-flight checks from
// the last slice, and the camera monitor that sends phone alerts.
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useStore } from '../../../state/store';
import { plateObjects } from '../../../state/slicing';
import { initDevices, useDevices } from '../../../state/devices';
import { printerById } from '../../../profiles/printers';
import { filamentById } from '../../../profiles/filaments';
import { CALIBRATION_BLOCKS, CALIBRATION_MARGIN, DEFAULT_BULNEX, materialOf, pushZFor, type BulnexConfig, type BulnexReport } from '../model';
import { arrangeRow, suggestRow } from '../arrange';
import { addCalibrationPlate } from '../calibration';
import { DEFAULT_NOTIFY, GRID_H, GRID_W, learnEmptyNow, monitorState, monitorSubscribe, notify, startMonitor, stopMonitor, type NotifySettings } from '../monitor';
import { DEFAULT_VISION } from '../vision';

const KEY = 'nexspiro.bulnex.v1';
interface CalibResult { t: number; filament: string; releaseTemp: number; current: number; passes: number; released: string; limit: number }
interface Saved { calib: CalibResult[]; cfg: BulnexConfig; notify: NotifySettings; gap: number; rotate: boolean; referenceCycles: number; sensitivity: number; deviceId: string }
const load = (): Saved => {
  const d: Saved = { calib: [], cfg: { ...DEFAULT_BULNEX }, notify: { ...DEFAULT_NOTIFY }, gap: 3, rotate: true, referenceCycles: 1, sensitivity: 5, deviceId: '' };
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (s) return { ...d, ...s, cfg: { ...d.cfg, ...s.cfg }, notify: { ...d.notify, ...s.notify } };
  } catch { /* fresh start */ }
  return d;
};
let saved = load();
let version = 0;
const listeners = new Set<() => void>();
const update = (patch: Partial<Saved>, dirty = false) => {
  saved = { ...saved, ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(saved)); } catch { /* storage unavailable */ }
  version++;
  listeners.forEach((l) => l());
  if (dirty) useStore.getState().markDirty();
};
const useSaved = () => { useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, () => version); return saved; };

/** Config for the slicing worker. */
export const bulnexConfig = (): BulnexConfig => ({ ...saved.cfg });

const fmtH = (s: number) => { const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60); return h ? `${h} h ${m} min` : `${m} min`; };
const num = (v: string, d: number, min = 0, max = Infinity) => { const n = parseFloat(v); return isFinite(n) ? Math.min(max, Math.max(min, n)) : d; };

function Field({ label, value, onChange, step = 1, min = 0, max, unit, hint }: { label: string; value: number; onChange: (v: number) => void; step?: number; min?: number; max?: number; unit?: string; hint?: string }) {
  return (
    <label className="mx-field" title={hint}>{label}{unit ? ` (${unit})` : ''}
      <input className="input" type="number" step={step} min={min} max={max} value={value} onChange={(e) => onChange(num(e.target.value, value, min, max))} />
    </label>
  );
}

export function BulnexPanel() {
  const s = useSaved();
  const st = useStore();
  const c = s.cfg;
  const set = (patch: Partial<BulnexConfig>) => update({ cfg: { ...c, ...patch } }, true);
  const printer = printerById(st.printerId);
  const isA1 = st.printerId === 'bbl-a1';
  const objs = plateObjects(st.activePlate).filter((o) => o.printable !== false);
  const tpl = objs.find((o) => st.selected.includes(o.id)) ?? objs[0];
  const sug = tpl ? suggestRow(tpl, s.gap, s.rotate) : null;
  const rep = st.slice.result?.pluginReports?.bulnex as BulnexReport | undefined;
  const mat = materialOf(filamentById(st.filaments[0]?.presetId ?? 'generic-pla').type);
  const rp = st.slice.result?.stats.repeat;

  return (
    <div className="mx-panel">
      <div className="mx-head">
        <span className="mx-badge">B</span>
        <div><div className="mx-title">Bulnex</div><div className="mx-sub">Print, push off, repeat — bulk production on one plate</div></div>
      </div>
      {!isA1 && <p className="mx-muted px-warn">Bulnex is tuned for the Bambu Lab A1 (bed slinger, front drop). On the {printer.vendor} {printer.model} the push moves and motor currents may not suit the machine.</p>}

      {!c.calibration && <section className="mx-card">
        <div className="mx-card-title">Row</div>
        {!tpl ? <p className="mx-muted">Add a part to the plate.</p> : <>
          <p className="mx-muted">Parts line up along Y at the plate centre; the head sweeps them off the front edge. Template: <b>{tpl.name}</b>.</p>
          <label className="mx-field"><span><input type="checkbox" checked={s.rotate} onChange={(e) => update({ rotate: e.target.checked })} /> Rotate the part so it is shallow along the push</span></label>
          <Field label="Gap between parts" unit="mm" step={0.5} value={s.gap} onChange={(v) => update({ gap: v })} />
          {sug && <p className="mx-muted">Suggestion: {s.rotate && sug.deg ? `turn ${sug.deg}°, ` : ''}{sug.depth.toFixed(1)} mm deep → <b>{sug.capacity} part{sug.capacity === 1 ? '' : 's'} per row</b>.</p>}
          <div className="row" style={{ gap: 6 }}>
            <button className="btn-primary btn-small" disabled={!sug?.capacity} onClick={() => arrangeRow(tpl.id, 'max', s.gap, s.rotate)}>Fill row ({sug?.capacity ?? 0})</button>
            <button className="btn-secondary btn-small" onClick={() => arrangeRow(tpl.id, 1, s.gap, s.rotate)}>Single part</button>
          </div>
        </>}
      </section>}

      <Calibration s={s} filament={filamentById(st.filaments[0]?.presetId ?? 'generic-pla').name} />

      <section className="mx-card">
        <div className="mx-card-title">Cycles</div>
        <Field label="Number of prints" value={c.cycles} min={1} max={10000} onChange={(v) => set({ cycles: Math.round(v) })} hint="The file prints, ejects and re-prints this many times. Homing, levelling and the purge line run once." />
        <Field label="Release bed temperature" unit="°C" value={c.releaseBedTemp} min={15} max={60} onChange={(v) => set({ releaseBedTemp: v })} hint={`Parts release from PEI as the bed cools. ${mat ? `${mat.family}: ${mat.releaseTemp} °C or lower.` : ''}`} />
        <Field label="Cool-down wait" unit="min" step={0.5} value={c.coolWaitMin} min={0} max={120} onChange={(v) => set({ coolWaitMin: v })} />
        <Field label="Nozzle standby" unit="°C, 0 = off" value={c.nozzleStandbyTemp} min={0} max={250} onChange={(v) => set({ nozzleStandbyTemp: v })} />
        <label className="mx-field"><span><input type="checkbox" checked={c.fanDuringCool} onChange={(e) => set({ fanDuringCool: e.target.checked })} /> Part fan at full speed while cooling</span></label>
      </section>

      <section className="mx-card">
        <div className="mx-card-title">Push</div>
        <label className="mx-field">Push height: {Math.round(c.pushHeightPct * 100)} % of the part height{tpl ? ` (${pushZFor(rep?.parts[0]?.height ?? 20, c.pushHeightPct).toFixed(1)} mm)` : ''}
          <input type="range" min={0.1} max={0.8} step={0.05} value={c.pushHeightPct} onChange={(e) => set({ pushHeightPct: Number(e.target.value) })} />
        </label>
        <Field label="Push passes" value={c.passes} min={1} max={10} onChange={(v) => set({ passes: Math.round(v) })} hint="Full sweeps from behind the row. Extra passes free parts that only moved." />
        <Field label="Push speed" unit="mm/s" value={c.pushSpeed} min={2} max={150} onChange={(v) => set({ pushSpeed: v })} />
        <label className="mx-field">Motor current during the push: {Math.round(c.currentFraction * 100)} %
          <input type="range" min={0.2} max={1} step={0.05} value={c.currentFraction} onChange={(e) => set({ currentFraction: Number(e.target.value) })} />
        </label>
        <Field label="Minimum part height" unit="mm" step={0.5} value={c.minHeight} min={2} max={100} onChange={(v) => set({ minHeight: v })} />
        <Field label="Max contact area per part" unit={`mm², 0 = ${mat ? `${mat.family} ${mat.maxArea}` : 'material default'}`} step={50} value={c.maxContactArea} min={0} onChange={(v) => set({ maxContactArea: v })} />
      </section>

      <section className="mx-card">
        <div className="mx-card-title">Checks</div>
        {!rep ? <p className="mx-muted">Slice to check the parts. Problems are warnings — the file is still written.</p> : <>
          {rep.checks.map((k, i) => <p key={i} className={`mx-muted${k.level === 'warn' ? ' px-warn' : ''}`}>{k.level === 'warn' ? '⚠ ' : '✓ '}{k.text}</p>)}
          {rep.row && !c.calibration && <p className="mx-muted">Push line X {rep.row.x.toFixed(1)} mm, from Y {rep.row.startY.toFixed(1)} mm to the front edge at Z {rep.row.z.toFixed(1)} mm.</p>}
          {rp && !c.calibration && <div className="mx-muted">
            <p><b>This file prints {rp.cycles}× ({rp.cycles * rp.partsPerCycle} part{rp.cycles * rp.partsPerCycle === 1 ? '' : 's'}).</b> The preview shows one print.</p>
            <p>One print ≈ {fmtH(rp.perCycleSeconds)} · cool-down {fmtH(rp.coolSeconds)} · push {fmtH(rp.pushSeconds)} · re-heat {fmtH(rp.reheatSeconds)} (not after the last print).</p>
            <p>Whole job ≈ <b>{fmtH(rp.totalSeconds)}</b> · filament ≈ {(rp.totalMm / 1000).toFixed(1)} m / {rp.totalGrams.toFixed(0)} g · cost {rp.totalCost.toFixed(2)}.</p>
          </div>}
        </>}
      </section>

      <Monitor s={s} />
    </div>
  );
}

function Calibration({ s, filament }: { s: Saved; filament: string }) {
  const c = s.cfg;
  const [released, setReleased] = useState('');
  const on = !!c.calibration;
  const set = (patch: Partial<BulnexConfig>) => update({ cfg: { ...c, ...patch } }, true);
  const apply = () => {
    const b = CALIBRATION_BLOCKS.find((x) => x.label === released);
    const limit = b ? Math.round((b.side * b.side * CALIBRATION_MARGIN) / 50) * 50 : 0;
    const r: CalibResult = { t: Date.now(), filament, releaseTemp: c.releaseBedTemp, current: c.currentFraction, passes: c.passes, released: released || 'none', limit };
    update({ calib: [r, ...s.calib].slice(0, 20), cfg: { ...c, calibration: false, maxContactArea: limit || c.maxContactArea } }, true);
    setReleased('');
  };
  return (
    <section className="mx-card">
      <div className="mx-card-title">Calibration · release ladder</div>
      <p className="mx-muted">Five 15 mm blocks (400 → 3600 mm²) on textured PEI. After printing, the bed cools to the release temperature and each block is pushed on its own, smallest first, with the push settings below. The printer pauses after each push: note whether the block fell off, then resume.</p>
      {!on ? (
        <button className="btn-primary btn-small" onClick={() => { addCalibrationPlate(); set({ calibration: true }); }}>Create calibration plate</button>
      ) : <>
        <p className="mx-muted px-warn">Calibration mode is on: the next slice writes the ladder test, not production cycles. Slice and print this plate.</p>
        <label className="mx-field">Largest block that fell off cleanly
          <select className="select" value={released} onChange={(e) => setReleased(e.target.value)}>
            <option value="">None released</option>
            {CALIBRATION_BLOCKS.map((b) => <option key={b.label} value={b.label}>{b.label} — {b.side}×{b.side} mm ({b.side * b.side} mm²)</option>)}
          </select>
        </label>
        <p className="mx-muted">{released ? `Max contact area becomes ${Math.round((CALIBRATION_BLOCKS.find((b) => b.label === released)!.side ** 2 * CALIBRATION_MARGIN) / 50) * 50} mm² (70 % of block ${released}).` : 'If none released: lower the release temperature or add cool-down time, then test again.'} A block that moved but stuck counts as not released — try 2 passes before raising the current.</p>
        <div className="row" style={{ gap: 6 }}>
          <button className="btn-primary btn-small" onClick={apply}>Save result</button>
          <button className="btn-secondary btn-small" onClick={() => set({ calibration: false })}>Cancel calibration</button>
        </div>
      </>}
      {s.calib.length > 0 && <table style={{ width: '100%', fontSize: 11, marginTop: 6 }}>
        <thead><tr><th align="left">Filament</th><th>Bed</th><th>Current</th><th>Passes</th><th>Released</th><th>Limit</th></tr></thead>
        <tbody>{s.calib.map((r) => <tr key={r.t}><td>{r.filament}</td><td align="center">{r.releaseTemp}°</td><td align="center">{Math.round(r.current * 100)}%</td><td align="center">{r.passes}</td><td align="center">{r.released}</td><td align="center">{r.limit ? `${r.limit} mm²` : '—'}</td></tr>)}</tbody>
      </table>}
    </section>
  );
}

function Heat({ heat, cluster, frame }: { heat: Float32Array | null; cluster: number[]; frame: string | null }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current; if (!cv) return;
    const g = cv.getContext('2d')!;
    g.clearRect(0, 0, cv.width, cv.height);
    if (!heat) return;
    const cw = cv.width / GRID_W, ch = cv.height / GRID_H, on = new Set(cluster);
    for (let i = 0; i < heat.length; i++) {
      const a = Math.min(0.6, heat[i] / 12);
      g.fillStyle = on.has(i) ? 'rgba(229,72,77,0.55)' : `rgba(242,179,61,${a})`;
      g.fillRect((i % GRID_W) * cw, Math.floor(i / GRID_W) * ch, cw, ch);
    }
  }, [heat, cluster]);
  return (
    <div style={{ position: 'relative', width: '100%', aspectRatio: '16 / 9', background: 'var(--panel-2, #111)', borderRadius: 6, overflow: 'hidden' }}>
      {frame && <img src={frame} alt="Printer camera" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />}
      <canvas ref={ref} width={320} height={180} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />
    </div>
  );
}

function Monitor({ s }: { s: Saved }) {
  const m = useSyncExternalStore(monitorSubscribe, monitorState);
  const { devices, status } = useDevices();
  useEffect(() => { void initDevices(); }, []);
  const cams = devices.filter((d) => d.config.kind === 'bbl_lan');
  const dev = cams.find((d) => d.id === s.deviceId) ?? cams[0];
  const online = dev && status[dev.id] && status[dev.id].state !== 'offline';
  const n = s.notify;
  const setN = (p: Partial<NotifySettings>) => update({ notify: { ...n, ...p } });
  const [testing, setTesting] = useState(false);

  const start = () => dev && startMonitor({
    ...n, deviceId: dev.id, releaseBedTemp: s.cfg.releaseBedTemp, cycles: s.cfg.cycles, referenceCycles: s.referenceCycles,
    vision: { ...DEFAULT_VISION, threshold: 11 - s.sensitivity },
  });

  return (
    <section className="mx-card">
      <div className="mx-card-title">Camera monitor<span className="spacer" />
        {m.running ? <button className="btn-secondary btn-small" onClick={stopMonitor}>Stop</button>
          : <button className="btn-primary btn-small" disabled={!online} title={online ? '' : 'Connect the printer in the Device tab'} onClick={() => void start()}>Start</button>}
      </div>
      <p className="mx-muted">An on-device model learns what this print looks like and alerts your phone on spaghetti, a detached part or a plate that is not clear after a push. It only alerts — you decide whether to stop.</p>
      {!cams.length ? <p className="mx-muted px-warn">Add your A1 in the Device tab (LAN connection, desktop app) to use the camera.</p> : (
        <label className="mx-field">Printer
          <select className="select" value={dev?.id ?? ''} disabled={m.running} onChange={(e) => update({ deviceId: e.target.value })}>
            {cams.map((d) => <option key={d.id} value={d.id}>{d.name}{status[d.id]?.state && status[d.id].state !== 'offline' ? '' : ' (offline)'}</option>)}
          </select>
        </label>
      )}
      <label className="mx-field">Phone (ntfy topic)
        <input className="input" placeholder="e.g. bulnex-7f3k2 — subscribe to it in the ntfy app" value={n.ntfyTopic} onChange={(e) => setN({ ntfyTopic: e.target.value.replace(/[^A-Za-z0-9_-]/g, '') })} />
      </label>
      <label className="mx-field">ntfy server<input className="input" value={n.ntfyServer} onChange={(e) => setN({ ntfyServer: e.target.value })} /></label>
      <label className="mx-field"><span><input type="checkbox" checked={n.attachImage} onChange={(e) => setN({ attachImage: e.target.checked })} /> Attach the camera frame</span></label>
      <label className="mx-field"><span><input type="checkbox" checked={n.desktop} onChange={(e) => setN({ desktop: e.target.checked })} /> Desktop notifications too</span></label>
      <button className="btn-secondary btn-small" disabled={testing || !n.ntfyTopic} onClick={async () => { setTesting(true); await notify({ ...n, attachImage: false }, 'Bulnex test', 'Phone notifications work.', `test${Date.now()}`); setTesting(false); }}>Send test notification</button>
      <Field label="Reference cycles" value={s.referenceCycles} min={1} max={5} onChange={(v) => update({ referenceCycles: Math.round(v) })} hint="Cycles the model learns from before it judges. Watch these once." />
      <label className="mx-field">Sensitivity: {s.sensitivity}
        <input type="range" min={1} max={9} step={1} value={s.sensitivity} disabled={m.running} onChange={(e) => update({ sensitivity: Number(e.target.value) })} />
      </label>
      {m.running && <>
        <p className="mx-muted">Phase: <b>{m.phase}</b> · cycle {m.cycle}/{s.cfg.cycles} · empty-plate frames learned: {m.emptyTrained}</p>
        <Heat heat={m.heat} cluster={m.cluster} frame={m.frame} />
        <button className="btn-secondary btn-small" style={{ marginTop: 6 }} title="Use when the plate is empty right now" onClick={() => learnEmptyNow()}>Plate is empty now — learn it</button>
      </>}
      {m.log.length > 0 && <div style={{ maxHeight: 160, overflow: 'auto', marginTop: 6 }}>
        {m.log.map((l, i) => <p key={i} className={`mx-muted${l.kind === 'alert' ? ' px-warn' : ''}`} style={{ margin: '2px 0' }}>{new Date(l.t).toLocaleTimeString()} — {l.text}</p>)}
      </div>}
    </section>
  );
}
