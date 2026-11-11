// Velocity painting card in the Motionex panel: a picture printed into the outer wall as speed (sheen),
// one filament, no changes. Picture, speeds, placement, a speed ladder ring and the last slice's checks.
import { useMemo, useRef, useState } from 'react';
import { useStore } from '../../../state/store';
import { currentConfig } from '../../../state/slicing';
import type { Config } from '../../../profiles/settings';
import { centreOnBed } from '../../../state/ops';
import { objectFromWorld } from '../../../state/tools';
import { weld } from '../../../engine/mesh';
import { changed, mx, useMx } from './MotionexPanel';
import { loadPicture, partSize, solidCylinder } from './WeavePanel';
import type { MotionexReport } from '../engine';
import { defaultPaint, PAINT_LEVELS_MAX, paintLevels, speedLadder, speedOfLevel, type PaintSettings } from '../paint/model';
import { meanPaintSpeed, paintPrintSettings, rampMm, recommendedPaintAccel, recommendedPixelMm } from '../paint/plan';
import { greyLevels, gridFor, resampleRGB, type Dither } from '../weave/image';
import { MOTIFS, motifImage } from '../weave/motifs';

let source: { rgba: Uint8ClampedArray; w: number; h: number; name: string } | null = null;

/** Pixel size for this machine at its recommended acceleration, rounded up to 0.5 mm (bigger on slow, low-accel machines). */
function recPixel(cfg: Config, p: PaintSettings): number {
  return Math.min(20, Math.max(1, Math.ceil(recommendedPixelMm(cfg, { ...p, accel: recommendedPaintAccel(cfg) }) * 2) / 2));
}

/** Redraw the picture at its grid size from its source, as grey levels (0 = light). */
function rebuild(p: PaintSettings) {
  const pic = p.picture ?? { kind: 'motif', motif: 'checker' };
  const n = Math.max(2, Math.min(PAINT_LEVELS_MAX, pic.levels ?? 2));
  if (pic.kind === 'image' && source) {
    const rgb = resampleRGB(source.rgba, source.w, source.h, p.image.w, p.image.h);
    p.image = { w: p.image.w, h: p.image.h, px: greyLevels(rgb, p.image.w, p.image.h, n, pic.dither ?? 'none', pic.invert), name: source.name };
  } else if (pic.kind === 'motif') p.image = motifImage(pic.motif ?? 'checker', p.image.w, p.image.h, n);
}

/** Grid that fills the part: pixel_mm wide pixels round (or across) it and square rows up it. */
function fit(p: PaintSettings) {
  const { around, top } = partSize(p);
  if (!around) return;
  const band = Math.max(1, Math.min(p.z_end, top) - p.z_start);
  const width = p.projection === 'front' ? around / Math.PI : around;
  const aspect = p.picture?.kind === 'image' && source ? source.h / source.w : 0;
  const px = p.picture?.pixel_mm ?? 3;
  const g = gridFor(width, band, px, px, aspect, p.projection === 'wrap' ? p.tiles_around : 1);
  p.image = { ...p.image, w: g.w, h: g.h };
  rebuild(p);
}

function addLadderRing() {
  const s = useStore.getState();
  const o = centreOnBed(objectFromWorld('Speed ladder ring', weld(solidCylinder(25, 30))), s.printerId);
  s.addObjects([o]);
  const p = mx.paint;
  p.enabled = true; p.calibration = true; p.objects = [o.id]; p.z_start = 1.2; p.z_end = 1e4; p.projection = 'wrap'; p.tiles_around = 1;
  p.picture = { ...(p.picture ?? { kind: 'motif' }), levels: 6 };
  changed();
}

const upd = (f: () => void) => { f(); changed(); };
const greyCss = (k: number, n: number) => { const v = Math.round(235 - (k / Math.max(1, n - 1)) * 200); return `rgb(${v},${v},${v})`; };

export function PaintCard() {
  useMx();
  const p = mx.paint;
  const { objects, selected } = useStore();
  void objects;
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const levels = paintLevels(p);
  const regen = (f: () => void) => upd(() => { f(); rebuild(p); });
  const onFile = async (f: File | undefined) => {
    if (!f) return;
    setBusy(true);
    try { source = await loadPicture(f); p.picture = { ...(p.picture ?? {}), kind: 'image' }; p.calibration = false; fit(p); changed(); } finally { setBusy(false); }
  };
  if (!p.enabled) {
    return (
      <section className="mx-card">
        <div className="mx-card-title">Velocity paint<span className="spacer" />
          <button className="toggle" aria-label="Turn on" title="Turn on" onClick={() => upd(() => { p.enabled = true; fit(p); })} />
        </div>
        <p className="mx-muted" style={{ margin: 0 }}>Print a picture into the outer wall with one filament and no changes: each pixel sets the wall's speed, which changes its sheen. Strongest on silk and glossy filaments. Works on any printer.</p>
      </section>
    );
  }
  const cfg = currentConfig();
  const lw = Number(cfg.outer_wall_line_width) || Number(cfg.line_width) || 0.42, lh = Number(cfg.layer_height) || 0.2;
  const mvs = Number(cfg.filament_max_volumetric_speed) || 15;
  const flowCap = mvs / (lw * lh);
  const maxAccel = Number(cfg.max_acceleration) || 0;
  const accel = Math.min(p.accel || Number(cfg.outer_wall_acceleration) || Number(cfg.default_acceleration) || 5000, maxAccel || 1e9);
  const ramp = rampMm(p.speed_light, Math.min(p.speed_dark, flowCap), accel);
  const px = p.picture?.pixel_mm ?? 3;
  const flavor = String(cfg.gcode_flavor), marlin = flavor === 'marlin';
  const nozzle = Number(cfg.nozzle_diameter) || 0.4;
  const rA = recommendedPaintAccel(cfg), rPx = recPixel(cfg, p);
  const isRec = p.accel === rA && Math.abs(px - rPx) < 1e-6;
  return (
    <section className="mx-card">
      <div className="mx-card-title">Velocity paint<span className="spacer" />
        <button className="toggle on" aria-label="Velocity paint on" title="Turn velocity paint off" onClick={() => upd(() => { p.enabled = false; })} />
      </div>
      <div className="mx-label">Picture</div>
      <div className="row" style={{ gap: 6, margin: 0, flexWrap: 'wrap' }}>
        <button className="btn-secondary btn-small" disabled={busy} onClick={() => fileRef.current?.click()}>{busy ? 'Reading…' : 'Import picture…'}</button>
        <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml,image/bmp" style={{ display: 'none' }} onChange={(e) => { void onFile(e.target.files?.[0]); e.target.value = ''; }} />
        <select className="select" value={p.calibration ? '' : p.picture?.kind === 'motif' ? p.picture.motif : ''} onChange={(e) => e.target.value && regen(() => { p.calibration = false; p.picture = { ...(p.picture ?? {}), kind: 'motif', motif: e.target.value }; })}>
          <option value="">{p.calibration ? 'Speed ladder' : p.picture?.kind === 'image' ? `Picture: ${p.image.name ?? 'imported'}` : 'Motif…'}</option>
          {MOTIFS.map((m) => <option key={m.id} value={m.id} title={m.description}>{m.name}</option>)}
        </select>
      </div>
      <GreyView p={p} />
      <div className="mx-two">
        <label className="mx-field">Grey levels
          <select className="select" value={p.picture?.levels ?? 2} onChange={(e) => regen(() => { p.picture = { ...(p.picture ?? { kind: 'motif' }), levels: +e.target.value }; })}>
            {[2, 3, 4, 5, 6, 8].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <label className="mx-field">Pixel size (mm)<input className="input" type="number" min={1} max={20} step={0.5} value={px} onChange={(e) => upd(() => { p.picture = { ...(p.picture ?? { kind: 'motif' }), pixel_mm: Math.max(1, +e.target.value || 3) }; fit(p); })} /></label>
      </div>
      {p.picture?.kind === 'image' && (
        <div className="mx-two">
          <label className="mx-field">Dithering
            <select className="select" value={p.picture.dither ?? 'none'} onChange={(e) => regen(() => { p.picture = { ...p.picture!, dither: e.target.value as Dither }; })}>
              <option value="none">None (flat areas)</option><option value="floyd">Diffusion (photos)</option><option value="ordered">Pattern</option>
            </select>
          </label>
          <label className="row" style={{ gap: 8, margin: 0, fontSize: 12, alignSelf: 'end' }}>
            <input type="checkbox" checked={!!p.picture.invert} onChange={(e) => regen(() => { p.picture = { ...p.picture!, invert: e.target.checked }; })} /> Swap dark and light
          </label>
        </div>
      )}

      <div className="mx-label">Speeds</div>
      <div className="mx-two">
        <label className="mx-field">Light pixels (mm/s)<input className="input" type="number" min={5} max={600} value={p.speed_light} onChange={(e) => upd(() => { p.speed_light = Math.max(5, +e.target.value || 40); })} /></label>
        <label className="mx-field">Dark pixels (mm/s)<input className="input" type="number" min={5} max={600} value={p.speed_dark} onChange={(e) => upd(() => { p.speed_dark = Math.max(5, +e.target.value || 140); })} /></label>
      </div>
      <div className="row" style={{ gap: 3, margin: 0, flexWrap: 'wrap' }}>
        {Array.from({ length: levels }, (_, k) => {
          const v = speedOfLevel(p, k, levels);
          return <span key={k} className="badge" style={{ background: greyCss(k, levels), color: k > levels / 2 ? '#fff' : '#111' }} title={`Level ${k + 1}`}>{Math.round(Math.min(v, flowCap))}</span>;
        })}
      </div>
      <div className="mx-check"><span className={Math.max(p.speed_light, p.speed_dark) > flowCap ? 'bad' : 'ok'}>◔</span>Melt limit {flowCap.toFixed(0)} mm/s: {mvs} mm³/s ÷ ({lw.toFixed(2)} mm line × {lh.toFixed(2)} mm layer, {nozzle} mm nozzle)</div>
      {Math.max(p.speed_light, p.speed_dark) > flowCap && <p className="mx-muted bad" style={{ margin: 0 }}>Above {flowCap.toFixed(0)} mm/s this filament can't melt fast enough for a {lw.toFixed(2)} × {lh.toFixed(2)} mm line: those levels print at {flowCap.toFixed(0)}.{nozzle >= 0.6 ? ' A wide nozzle moves a lot of plastic per mm: keep the dark speed low or use a high-flow hot end.' : ''}</p>}
      <p className={`mx-muted${ramp > 0.6 * px ? ' bad' : ''}`} style={{ margin: 0 }}>The head needs {ramp.toFixed(1)} mm to change speed at {Math.round(accel)} mm/s² — {ramp > 0.6 * px ? 'more than a pixel: use bigger pixels, closer speeds or more acceleration' : `well inside a ${px} mm pixel`}. Average wall speed {meanPaintSpeed(p).toFixed(0)} mm/s.</p>
      <div className="mx-card" style={{ padding: 8, gap: 4 }}>
        <div className="mx-check"><span className="ok">⚙</span>This printer: {maxAccel ? `max ${Math.round(maxAccel)} mm/s²` : 'no acceleration limit set'} · {flavor === 'bbl' ? 'Bambu firmware' : marlin ? 'Marlin' : flavor === 'klipper' ? 'Klipper' : flavor}</div>
        <div className="row" style={{ gap: 6, margin: 0, flexWrap: 'wrap', alignItems: 'center' }}>
          <button className="btn-secondary btn-small" disabled={isRec} title="Painting acceleration from the printer's limit (at most 10 000 mm/s²) and a pixel size the speed change fits in" onClick={() => upd(() => { p.accel = rA; p.picture = { ...(p.picture ?? { kind: 'motif' }), pixel_mm: rPx }; fit(p); })}>Use recommended</button>
          <span className="mx-muted" style={{ margin: 0 }}>{rA} mm/s² · {rPx} mm pixels{rPx >= 4 ? ' (low acceleration: bigger pixels keep the picture sharp)' : ''}</span>
        </div>
        {marlin && <p className="mx-muted" style={{ margin: 0 }}>Marlin: speed steps are kept at least ~1 mm long so its planner doesn't stall on short moves (stutter and blobs). Fine detail needs bigger pixels than on Klipper.</p>}
      </div>

      <details className="mx-more">
        <summary className="mx-label" style={{ cursor: 'pointer' }}>Placement</summary>
        <div className="seg mx-seg">
          <button className={p.projection === 'wrap' ? 'on' : ''} title="The picture goes round the part" onClick={() => upd(() => { p.projection = 'wrap'; fit(p); })}>Wrap round</button>
          <button className={p.projection === 'front' ? 'on' : ''} title="The picture is projected onto one side, like a slide projector" onClick={() => upd(() => { p.projection = 'front'; fit(p); })}>One side</button>
        </div>
        {p.projection === 'front' ? (
          <label className="mx-field">Seen from: {Math.round(p.front_deg)}° {p.front_deg === -90 ? '(front)' : ''}
            <input type="range" min={-180} max={180} step={5} value={p.front_deg} onChange={(e) => upd(() => { p.front_deg = +e.target.value; })} />
          </label>
        ) : (
          <div className="mx-two">
            <label className="mx-field">Times round<input className="input" type="number" min={1} max={24} value={p.tiles_around} onChange={(e) => upd(() => { p.tiles_around = Math.max(1, Math.round(+e.target.value || 1)); fit(p); })} /></label>
            <label className="mx-field">Twist (px/row)<input className="input" type="number" min={-4} max={4} step={0.25} value={p.shift_px_per_row} onChange={(e) => upd(() => { p.shift_px_per_row = +e.target.value || 0; })} /></label>
          </div>
        )}
        <div className="seg mx-seg">
          <button className={p.fit_height === 'stretch' ? 'on' : ''} onClick={() => upd(() => { p.fit_height = 'stretch'; })}>Fit to band</button>
          <button className={p.fit_height === 'tile' ? 'on' : ''} onClick={() => upd(() => { p.fit_height = 'tile'; })}>Repeat up</button>
        </div>
        <div className="mx-two">
          <label className="mx-field">From (mm)<input className="input" type="number" min={0} step={0.2} value={p.z_start} onChange={(e) => upd(() => { p.z_start = Math.max(0, +e.target.value); })} /></label>
          <label className="mx-field">To (mm)<input className="input" type="number" min={0} step={0.2} value={p.z_end >= 1e4 ? '' : p.z_end} placeholder="top" onChange={(e) => upd(() => { p.z_end = e.target.value === '' ? 1e4 : +e.target.value; })} /></label>
        </div>
        <div className="mx-two">
          <label className="mx-field">Painting accel (mm/s²)<input className="input" type="number" min={0} max={50000} step={500} value={p.accel || ''} placeholder="print's own" onChange={(e) => upd(() => { p.accel = Math.max(0, +e.target.value || 0); })} /></label>
          <label className="mx-field">Finest step (mm)<input className="input" type="number" min={0.1} max={5} step={0.1} value={p.resolution_mm} onChange={(e) => upd(() => { p.resolution_mm = Math.max(0.1, +e.target.value || 0.6); })} /></label>
        </div>
        {marlin && p.resolution_mm < 1 && <p className="mx-muted" style={{ margin: 0 }}>On Marlin steps shorter than ~1 mm are merged so the planner keeps up.</p>}
        <label className="row" style={{ gap: 8, margin: 0, fontSize: 12 }}>
          <input type="checkbox" checked={p.follow_curve} onChange={(e) => upd(() => { p.follow_curve = e.target.checked; })} /> Measure rows along the curve
        </label>
        <div className="mx-label">Goes on</div>
        <div className="seg mx-seg">
          <button className={!p.objects?.length ? 'on' : ''} onClick={() => upd(() => { p.objects = []; })}>Every object</button>
          <button className={p.objects?.length ? 'on' : ''} disabled={!selected.length} onClick={() => upd(() => { p.objects = [...selected]; })}>Selected ({p.objects?.length || selected.length})</button>
        </div>
      </details>

      <div className="row" style={{ gap: 6, margin: 0, flexWrap: 'wrap' }}>
        <button className="btn-secondary btn-small" title="Aligned seam at the back, pressure equalizer off" onClick={() => { const s = useStore.getState(); for (const [k, v] of Object.entries(paintPrintSettings(p))) s.setOverride(k, v); }}>Set up print settings</button>
        <button className="btn-secondary btn-small" title="A Ø50 × 30 mm ring with vertical stripes of every speed level, to see which speeds show on your filament" onClick={addLadderRing}>Add speed ladder ring</button>
      </div>
      {p.calibration && (
        <label className="row" style={{ gap: 8, margin: 0, fontSize: 12 }}>
          <input type="checkbox" checked onChange={() => upd(() => { p.calibration = false; })} /> Speed ladder on ({levels} stripes, {Math.round(p.speed_light)}–{Math.round(p.speed_dark)} mm/s, twice round)
        </label>
      )}
      <PaintReport />
      <button className="btn-secondary btn-small" style={{ alignSelf: 'flex-start' }} onClick={() => upd(() => { const keep = { objects: p.objects }; mx.paint = { ...defaultPaint(), enabled: true, ...keep }; fit(mx.paint); })}>Reset velocity paint</button>
    </section>
  );
}

/** The picture in grey levels, as it goes round the part (left = +X side). */
function GreyView({ p }: { p: PaintSettings }) {
  const levels = paintLevels(p);
  const img = p.calibration ? speedLadder(levels) : p.image;
  const url = useMemo(() => {
    if (typeof document === 'undefined') return '';
    const c = document.createElement('canvas');
    c.width = img.w; c.height = img.h;
    const g = c.getContext('2d')!;
    const d = g.createImageData(img.w, img.h);
    img.px.forEach((v, i) => { const t = Math.round(235 - (v / Math.max(1, levels - 1)) * 200); d.data.set([t, t, t, 255], i * 4); });
    g.putImageData(d, 0, 0);
    return c.toDataURL();
  }, [img, levels]);
  return (
    <div style={{ background: 'var(--panel-2, #222)', borderRadius: 6, padding: 4 }}>
      <img src={url} alt="" style={{ width: '100%', height: 150, objectFit: 'contain', imageRendering: 'pixelated', display: 'block' }} title={`${img.w} × ${img.h} pixels, ${levels} levels`} />
    </div>
  );
}

function PaintReport() {
  const result = useStore((s) => s.slice.result);
  const dirty = useStore((s) => s.slice.dirty);
  const rep = (result?.pluginReports?.motionex as MotionexReport | undefined)?.paint;
  if (!rep) return null;
  const rows: [boolean, string][] = [
    [rep.paintedLayers > 0, rep.paintedLayers ? `${rep.paintedLayers} painted layers · ${rep.moves} speed steps` : 'Nothing painted: check the band heights'],
    [rep.speeds[rep.speeds.length - 1] <= rep.flowLimit + 1e-6, `Speeds ${rep.speeds.map((v) => Math.round(v)).join(' / ')} mm/s (filament limit ${Math.round(rep.flowLimit)})`],
    [rep.rampMm <= 0.6 * rep.pixelMm, `Speed change takes ${rep.rampMm.toFixed(1)} mm, a pixel is ${rep.pixelMm.toFixed(1)} mm`],
  ];
  return (
    <div>
      <div className="mx-label">Last slice{dirty ? ' (out of date)' : ''}</div>
      {rows.map(([ok, t], k) => <div key={k} className="mx-check"><span className={ok ? 'ok' : 'bad'}>{ok ? '✓' : '!'}</span>{t}</div>)}
    </div>
  );
}
