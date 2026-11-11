// Hanex panel in Nexspiro's right dock: material preset, the wave settings, the print head (shared
// with Motionex, saved per printer) and the face-angle limit it gives, test specimens, and the report.
import { useState, useSyncExternalStore } from 'react';
import { useStore, newId } from '../../../state/store';
import { centreOnBed } from '../../../state/ops';
import { centreMesh } from '../../../io/load';
import { openEdgeCount, weld } from '../../../engine/mesh';
import { printerById } from '../../../profiles/printers';
import { mx, changed as mxChanged } from '../../motionex/ui/MotionexPanel';
import {
  PRESETS, preset, maxWaveFaceAngle, minOverlapForTip, validateProfile, waveStep, faceBand, type HanexProfile, type SeedMode,
} from '../core/profile';
import { angleSpecimen, prismsToSoup, tabSpecimen } from '../core/calibration';
import { printProfile, type HanexConfig, type HanexReport } from '../engine';

const KEY = 'nexspiro.hanex.state.v1';
const storage = typeof localStorage !== 'undefined' ? localStorage : null;

export interface HanexUiState {
  enabled: boolean;
  presetId: string;
  /** Edits on top of the preset. */
  edits: Partial<HanexProfile>;
  /** User cap on the face angle (°), or null for what the print head allows. */
  maxFaceAngleDeg: number | null;
  minArea: number;
}

function load(): HanexUiState {
  const d: HanexUiState = { enabled: true, presetId: 'hanex-pla', edits: {}, maxFaceAngleDeg: null, minArea: 4 };
  try { return { ...d, ...JSON.parse(storage?.getItem(KEY) ?? '{}') }; } catch { return d; }
}
export const hx: HanexUiState = load();

let version = 0;
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => { listeners.add(l); return () => listeners.delete(l); };
const useHx = () => useSyncExternalStore(subscribe, () => version);
function changed(): void {
  try { storage?.setItem(KEY, JSON.stringify(hx)); } catch { /* storage unavailable */ }
  version++;
  listeners.forEach((l) => l());
  useStore.getState().markDirty();
}

export const hanexProfile = (): HanexProfile => ({ ...preset(hx.presetId), ...structuredClone(hx.edits) });
const tipOf = (printerId: string) => mx.toolheads.get(printerId).nozzle.tip_diameter;

/** Slicer config, or undefined when Hanex is switched off. */
export function hanexConfig(printerId: string): HanexConfig | undefined {
  if (!hx.enabled) return undefined;
  return { profile: hanexProfile(), tipDiameter: tipOf(printerId), maxFaceAngleDeg: hx.maxFaceAngleDeg ?? undefined, minArea: hx.minArea };
}

const SEEDS: [SeedMode, string][] = [['point', 'Point (arcs)'], ['edge', 'Edge (straight)'], ['auto', 'Auto']];

function Num({ label, k, min, max, step, scale = 1, unit }: { label: string; k: keyof HanexProfile; min: number; max: number; step: number; scale?: number; unit?: string }) {
  const p = hanexProfile();
  const v = Number(p[k]) * scale;
  const isEdited = k in hx.edits;
  return (
    <label className="mx-field">{label}{unit ? ` (${unit})` : ''}{isEdited ? ' •' : ''}
      <input className="input" type="number" min={min} max={max} step={step} value={+v.toFixed(4)}
        onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n)) { (hx.edits as Record<string, unknown>)[k] = Math.min(max, Math.max(min, n)) / scale; changed(); } }} />
    </label>
  );
}

function addSpecimen(kind: 'tab' | 'angle', angle = 95) {
  const s = useStore.getState();
  const h = Number(s.overrides.layer_height) || 0.2;
  const soup = prismsToSoup(kind === 'tab' ? tabSpecimen() : angleSpecimen(angle, h));
  const mesh = weld(soup);
  centreMesh(mesh);
  let o = { id: newId(), name: kind === 'tab' ? 'Hanex test · flat tab' : `Hanex test · ${angle}° face`, mesh, position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number], openEdges: openEdgeCount(mesh) };
  o = centreOnBed(o, s.printerId);
  s.addObjects([o]);
}

export function HanexPanel() {
  useHx();
  const { printerId, overrides } = useStore();
  const [angle, setAngle] = useState(95);
  const printer = printerById(printerId);
  const layerH = Number(overrides.layer_height) || 0.2;
  const head = mx.toolheads.get(printerId);
  const cfg = { nozzle_diameter: printer.nozzle } as Record<string, unknown>;
  const p = printProfile({ profile: hanexProfile(), tipDiameter: head.nozzle.tip_diameter, minArea: hx.minArea }, cfg);
  const errors = validateProfile(p);
  const headLimit = maxWaveFaceAngle(layerH, p);
  const limit = hx.maxFaceAngleDeg ?? headLimit;
  const setTip = (v: number) => { const t = mx.toolheads.get(printerId); t.nozzle.tip_diameter = v; mx.toolheads.save(t); mxChanged(); changed(); };
  return (
    <div className="mx-panel">
      <div className="mx-head">
        <span className="mx-badge">H</span>
        <div style={{ flex: 1 }}><div className="mx-title">Hanex</div><div className="mx-sub">Flat and rising overhangs in mid-air, no supports</div></div>
        <button className={`toggle ${hx.enabled ? 'on' : ''}`} aria-label="Hanex on" onClick={() => { hx.enabled = !hx.enabled; changed(); }} />
      </div>

      <section className="mx-card">
        <div className="mx-card-title">Material</div>
        <select className="select mx-select" aria-label="Material" value={hx.presetId} onChange={(e) => { hx.presetId = e.target.value; changed(); }}>
          {PRESETS.map((q) => <option key={q.id} value={q.id}>{q.material}</option>)}
        </select>
        <div className="mx-two">
          <Num label="Overlap" k="overlap" min={0} max={95} step={5} scale={100} unit="%" />
          <Num label="Wave speed" k="waveSpeed" min={0.5} max={30} step={0.5} unit="mm/s" />
        </div>
        <div className="mx-two">
          <Num label="Flow" k="flowRatio" min={0.5} max={1.6} step={0.05} unit="×" />
          <Num label="Fan" k="fan" min={0} max={255} step={5} unit="0–255" />
        </div>
        <div className="mx-label">Wave start</div>
        <select className="select mx-select" aria-label="Wave start" value={p.seedMode} onChange={(e) => { hx.edits.seedMode = e.target.value as typeof p.seedMode; changed(); }}>
          {SEEDS.map(([m, l]) => <option key={m} value={m}>{l}</option>)}
        </select>
        <details className="px-more">
          <summary>More settings</summary>
          <div className="mx-two">
            <Num label="Anchor lead-in" k="leadIn" min={0} max={5} step={0.25} unit="mm" />
            <Num label="Start radius" k="startRadius" min={0} max={5} step={0.25} unit="mm" />
          </div>
          <div className="mx-two">
            <Num label="Rim speed" k="rimSpeed" min={0.5} max={30} step={0.5} unit="mm/s" />
            <Num label="Line width / nozzle" k="lineWidth" min={0.8} max={2} step={0.05} scale={1 / 0.4} unit="×" />
          </div>
          <div className="mx-two">
            <Num label="Tight-turn flow floor" k="flowFloor" min={0.2} max={1} step={0.05} unit="×" />
            <Num label="Tight-turn radius" k="rNominal" min={0.1} max={5} step={0.1} unit="mm" />
          </div>
          <label className="row" style={{ gap: 8, margin: 0 }}>
            <span style={{ flex: 1, fontSize: 12 }}>Rim along free edges</span>
            <button className={`toggle ${p.rim ? 'on' : ''}`} aria-label="Rim" onClick={() => { hx.edits.rim = !p.rim; changed(); }} />
          </label>
          <label className="mx-field">Skip overhangs smaller than (mm²)
            <input className="input" type="number" min={0} step={1} value={hx.minArea} onChange={(e) => { hx.minArea = Math.max(0, Number(e.target.value) || 0); changed(); }} />
          </label>
          {Object.keys(hx.edits).length > 0 && <button className="btn-secondary btn-small" onClick={() => { hx.edits = {}; changed(); }}>Reset to {preset(hx.presetId).name}</button>}
        </details>
        <p className="mx-muted">Wave spacing {waveStep(p).toFixed(3)} mm · bead {p.lineWidth.toFixed(2)} mm</p>
        {errors.map((e, i) => <p key={i} className="mx-muted px-warn">⚠ {e}</p>)}
      </section>

      <section className="mx-card">
        <div className="mx-card-title">Print head · {printer.vendor} {printer.model}</div>
        <p className="mx-muted">{head.name} · nozzle {printer.nozzle} mm. Shared with Motionex and saved for this printer.</p>
        <label className="mx-field">Flat land at the nozzle tip (mm)
          <input className="input" type="number" min={printer.nozzle} max={3} step={0.05} value={head.nozzle.tip_diameter} onChange={(e) => { const v = Number(e.target.value); if (v > 0) setTip(v); }} />
        </label>
        <p className="mx-muted">
          Minimum overlap for this tip: {Math.round(minOverlapForTip(p) * 100)}% · ledges up to {Math.max(2 * p.lineWidth, p.toolhead.tipFlatDiameter).toFixed(2)} mm are left to normal printing.
        </p>
        <div className="mx-label">Rising undersides</div>
        <p className="mx-muted">This head waves undersides from 90° (flat) up to <b>{headLimit.toFixed(1)}°</b> at {layerH} mm layers (each layer adds {Number.isFinite(faceBand(limit, layerH)) ? faceBand(limit, layerH).toFixed(2) : '∞'} mm at the limit).</p>
        <label className="mx-field">Limit: {limit.toFixed(1)}°{hx.maxFaceAngleDeg === null ? ' (from print head)' : ''}
          <input type="range" min={90} max={Math.max(headLimit, 90.5)} step={0.5} value={limit} onChange={(e) => { const v = Number(e.target.value); hx.maxFaceAngleDeg = Math.abs(v - headLimit) < 0.25 ? null : v; changed(); }} />
        </label>
      </section>

      <section className="mx-card">
        <div className="mx-card-title">Test prints</div>
        <p className="mx-muted">Add a specimen to the plate, slice and print it. The full calibration ladders are in docs/hanex/CALIBRATION.md.</p>
        <div className="mx-chips">
          <button className="btn-secondary btn-small" onClick={() => addSpecimen('tab')}>Flat tab (90°)</button>
          <select className="select" value={angle} onChange={(e) => setAngle(Number(e.target.value))} style={{ width: 80 }}>{[92.5, 95, 97.5, 100].map((a) => <option key={a} value={a}>{a}°</option>)}</select>
          <button className="btn-secondary btn-small" onClick={() => addSpecimen('angle', angle)}>Rising face</button>
        </div>
      </section>

      <Report />
    </div>
  );
}

function Report() {
  const result = useStore((s) => s.slice.result);
  const dirty = useStore((s) => s.slice.dirty);
  const set = useStore((s) => s.set);
  const rep = result?.pluginReports?.hanex as HanexReport | undefined;
  if (!rep) return null;
  return (
    <section className="mx-card">
      <div className="mx-card-title">After slicing{dirty ? ' (out of date)' : ''}</div>
      {rep.layers.length === 0
        ? <p className="mx-muted">No overhang on this plate needs waves.</p>
        : <p className="mx-muted">{rep.layers.length} wave layer(s) · {rep.arcs} arcs · {Math.round(rep.area)} mm² in mid-air · +{Math.round(rep.timeS / 60)} min</p>}
      {rep.warnings.map((w, i) => <p key={i} className="mx-muted px-warn">⚠ {w}</p>)}
      {rep.pastLimit.length > 0 && <p className="mx-muted">Past-limit layers: {rep.pastLimit.slice(0, 12).map((l) => <button key={l.layer} className="btn-secondary btn-small" style={{ margin: 2 }} onClick={() => set({ workspace: 'preview', layerRange: [0, l.layer] })}>{l.layer + 1}</button>)}{rep.pastLimit.length > 12 ? ' …' : ''}</p>}
      {rep.layers.length > 0 && (
        <table className="px-table">
          <thead><tr><th>Layer</th><th>Z (mm)</th><th>Regions</th><th>Arcs</th></tr></thead>
          <tbody>{rep.layers.slice(0, 50).map((l) => <tr key={l.layer} onClick={() => set({ workspace: 'preview', layerRange: [0, l.layer] })}><td>{l.layer + 1}</td><td>{l.z.toFixed(2)}</td><td>{l.regions}</td><td>{l.arcs}</td></tr>)}</tbody>
        </table>
      )}
    </section>
  );
}
